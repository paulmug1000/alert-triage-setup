import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, isReadOnlySession } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { memoryCache, invalidatePmaClientCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  isJobCostingStyle,
  buildJobRowClearAndRestorePlan,
  assertTrustedOrigin,
  sanitizeSpreadsheetTerms,
  parseVariableRetainerTag,
  resolveEditableJobSheetMeta,
  rowHasJobSlotData,
  isContiguousJobChildRow,
} from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes } from "../../../services/masterEngineService.js";
import { resolveAuthoritativeJobAnchor } from "../../../services/relationalJobsService.js";

function normalizeNameKey(val) {
  return String(val ?? "").trim().toLowerCase();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }
  if (!assertTrustedOrigin(req, res)) return;

  const sessionUser = await resolveLiveSessionUser(req, res);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const rl = await checkRateLimit("portal-delete-job", sessionUser.email || getTrustedClientIp(req), 30, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const {
    clientSheetId,
    clientName,
    tabName,
    rowNumber,
    jobUuid,
    jobName,
    endClientName,
    isVariableRetainerSeries,
    seriesName,
  } = req.body || {};

  const parsedRow = parseInt(rowNumber, 10);
  const requestedTab = String(tabName || "").trim().toLowerCase();
  if (!clientSheetId || (requestedTab !== "confirmed" && requestedTab !== "pipeline")) {
    return res.status(400).json({ success: false, error: "Valid clientSheetId and job status are required" });
  }
  if (!jobUuid && (isNaN(parsedRow) || parsedRow < 2)) {
    return res.status(400).json({ success: false, error: "Valid job identifier is required" });
  }

  let sheets = null;
  let verifiedClientName = "";
  try {
    sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    verifiedClientName = auth.clientName;
    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets(properties.sheetId,properties.title,rowGroups)",
      })
    );
    const sheetMetaList = metaResp.data?.sheets || [];
    const targetSheetObj = resolveEditableJobSheetMeta(sheetMetaList, requestedTab);

    if (!targetSheetObj) {
      throw new Error(`Could not find ${requestedTab === "confirmed" ? "Confirmed" : "Pipeline"} tab in spreadsheet`);
    }

    const sheetName = targetSheetObj.properties.title;
    const sheetId = targetSheetObj.properties.sheetId;
    const expectedTabCanonical = requestedTab === "confirmed" ? "Confirmed" : "Pipeline";

    // Branch A: Variable Retainer Series (clears all monthly series rows & children if no actuals exist)
    if (Boolean(isVariableRetainerSeries) && requestedTab === "confirmed") {
      const resp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A1:CR5000`,
          valueRenderOption: "UNFORMATTED_VALUE",
        })
      );
      const allRows = resp.data?.values || [];
      const anchorRowNum = !isNaN(parsedRow) && parsedRow >= 2 ? parsedRow : 2;
      const anchorRow = allRows[anchorRowNum - 1] || [];
      const anchorMeta = parseVariableRetainerTag(anchorRow[30]);
      const targetSeriesLower = normalizeNameKey(anchorMeta?.seriesName || seriesName || jobName);
      const targetClientLower = normalizeNameKey(anchorRow[0] || endClientName);

      if (!targetSeriesLower) {
        return res.status(400).json({ success: false, error: "Could not identify variable retainer series to delete." });
      }

      const allSeriesRowsToClear = [];
      let ri = 1;
      while (ri < allRows.length) {
        const r = allRows[ri] || [];
        const rc = String(r[0] || "").trim();
        const rj = String(r[1] || "").trim();
        const rMeta = parseVariableRetainerTag(r[30]);
        if (
          normalizeNameKey(rc) === targetClientLower &&
          rMeta &&
          normalizeNameKey(rMeta.seriesName) === targetSeriesLower
        ) {
          allSeriesRowsToClear.push(ri + 1);
          let cj = ri + 1;
          while (cj < allRows.length) {
            const nx = allRows[cj] || [];
            const nxClient = String(nx[0] || "").trim();
            const nxJob = String(nx[1] || "").trim();
            const isNamedChild =
              nxClient !== "" &&
              normalizeNameKey(nxClient) === normalizeNameKey(rc) &&
              normalizeNameKey(nxJob) === normalizeNameKey(rj);
            const isUnnamedChild =
              nxClient === "" &&
              nxJob === "" &&
              rowHasJobSlotData(nx, true);
            if (
              (isNamedChild || isUnnamedChild) &&
              !String(nx[32] || "").trim() &&
              !String(nx[37] || "").trim() &&
              !String(nx[35] || "").trim()
            ) {
              allSeriesRowsToClear.push(cj + 1);
              cj++;
            } else {
              break;
            }
          }
          ri = cj;
        } else {
          ri++;
        }
      }

      if (allSeriesRowsToClear.length === 0) {
        return res.status(404).json({ success: false, error: "Variable retainer job not found." });
      }

      for (const rNum of allSeriesRowsToClear) {
        const rData = allRows[rNum - 1] || [];
        const invSlots = [
          { ref: rData[42], status: rData[45] },
          { ref: rData[49], status: rData[52] },
          { ref: rData[56], status: rData[59] },
        ];
        for (const s of invSlots) {
          const ref = String(s.ref || "").trim();
          const st = String(s.status || "").trim().toLowerCase();
          if ((ref && !isPlaceholderInvoice(ref, st)) || st.includes("sent") || st.includes("paid")) {
            return res.status(400).json({
              success: false,
              error: "Cannot delete this variable retainer because it has actual invoices or expenses assigned to it.",
            });
          }
        }
        const expSlots = [
          { desc: rData[75], status: rData[80], id: rData[81] },
          { desc: rData[82], status: rData[87], id: rData[88] },
          { desc: rData[89], status: rData[94], id: rData[95] },
        ];
        for (const s of expSlots) {
          const id = String(s.id || "").trim();
          const desc = String(s.desc || "").trim();
          const st = String(s.status || "").trim().toLowerCase();
          if ((id && !isPlaceholderExpense(id, desc, st)) || st === "paid" || st === "received") {
            return res.status(400).json({
              success: false,
              error: "Cannot delete this variable retainer because it has actual invoices or expenses assigned to it.",
            });
          }
        }
      }

      const cleanupRequests = [];
      const rowSet = new Set(allSeriesRowsToClear);
      for (const g of targetSheetObj.rowGroups || []) {
        const startRow = (g.range?.startIndex ?? -1) + 1;
        const endRow = g.range?.endIndex ?? -1;
        let overlaps = false;
        for (let rNum = startRow; rNum <= endRow; rNum++) {
          if (rowSet.has(rNum)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps && g.range) {
          cleanupRequests.push(
            {
              deleteDimensionGroup: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: g.range.startIndex,
                  endIndex: g.range.endIndex,
                },
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: g.range.startIndex,
                  endIndex: g.range.endIndex,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            }
          );
        }
      }
      for (const rNum of allSeriesRowsToClear) {
        cleanupRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rNum - 1,
              endIndex: rNum,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }
      if (cleanupRequests.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: clientSheetId,
            requestBody: { requests: cleanupRequests },
            _skipFormulaRecompute: true,
          })
        ).catch(() => { });
      }

      const isJobCosting = isJobCostingStyle({ headers: allRows[0] || [] });
      const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
        sheetName,
        rowNums: allSeriesRowsToClear,
        isJobCosting,
        includeCopiedCol: false,
      });

      if (clearRanges.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchClear({
            spreadsheetId: clientSheetId,
            _skipFormulaRecompute: restoreData.length > 0,
            _deferBackgroundRecompute: restoreData.length === 0,
            requestBody: { ranges: clearRanges },
          })
        );
      }
      if (restoreData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientSheetId,
            _deferBackgroundRecompute: true,
            requestBody: { valueInputOption: "USER_ENTERED", data: restoreData },
          })
        );
      }

      const delCacheKey = `deleted_job_rows:${clientSheetId}:${expectedTabCanonical.toLowerCase()}`;
      const prevDel = memoryCache.get(delCacheKey) || [];
      const newSigs = allSeriesRowsToClear.map((r) => `${Number(r)}:${targetClientLower}:${normalizeNameKey(seriesName || jobName)}`);
      memoryCache.set(delCacheKey, Array.from(new Set([...prevDel, ...newSigs])), 15);

      await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });
      await invalidatePmaClientCache(clientSheetId, null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]).catch(() => { });

      logPulseActivity(sheets, {
        clientName: verifiedClientName || clientName || anchorRow[0] || "Client",
        category: "JOB",
        action: "JOB_DELETED",
        summary: `Deleted variable retainer "${anchorMeta?.seriesName || seriesName || jobName || "Job"}" (${allSeriesRowsToClear.length} row(s))`,
        details: {
          jobName: anchorMeta?.seriesName || seriesName || jobName || "",
          endClientName: anchorRow[0] || endClientName || "",
          tabName: sheetName,
          clearedRows: allSeriesRowsToClear,
        },
        user: sessionUser.name || sessionUser.email,
      }).catch(() => { });

      return res.status(200).json({
        success: true,
        deletedRowNumber: allSeriesRowsToClear[0],
        clearedRowsCount: allSeriesRowsToClear.length,
        unassignedInvoices: [],
      });
    }

    // Branch B: Standard Job (Project or Fixed Retainer, Confirmed or Pipeline)
    const relationalAnchor = await resolveAuthoritativeJobAnchor({
      spreadsheetId: clientSheetId,
      clientName: verifiedClientName,
      jobUuid,
      expectedTabName: expectedTabCanonical,
      fallbackRowNum: !isNaN(parsedRow) && parsedRow >= 2 ? parsedRow : null,
    });
    const parentRow = relationalAnchor?.rowNum;
    if (!parentRow || isNaN(parentRow) || parentRow < 2) {
      return res.status(400).json({ success: false, error: "Could not locate the job to delete." });
    }

    const anchorRowSet = new Set(
      Array.isArray(relationalAnchor?.rowNums)
        ? relationalAnchor.rowNums.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 2)
        : []
    );
    const fetchEndRow = Math.max(
      parentRow + 60,
      ...(anchorRowSet.size > 0 ? Array.from(anchorRowSet) : [parentRow])
    );

    const [headerResp, windowResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A1:M1`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A${parentRow}:CR${fetchEndRow}`,
          valueRenderOption: "FORMULA",
        })
      ),
    ]);

    const headers = headerResp.data?.values?.[0] || [];
    const isJobCosting = isJobCostingStyle({ headers });
    const windowRows = windowResp.data?.values || [];
    const parentData = windowRows[0] || [];
    const actualClient = String(parentData[0] ?? "").trim();
    const actualJobName = String(parentData[1] ?? "").trim();

    if (!actualClient && !actualJobName) {
      return res.status(404).json({ success: false, error: "Job not found or already deleted." });
    }

    if (jobName && actualJobName && normalizeNameKey(jobName) !== normalizeNameKey(actualJobName)) {
      return res.status(409).json({
        success: false,
        error: "Job data has changed since it was opened. Please refresh and try again.",
      });
    }
    if (endClientName && actualClient && normalizeNameKey(endClientName) !== normalizeNameKey(actualClient)) {
      return res.status(409).json({
        success: false,
        error: "Job data has changed since it was opened. Please refresh and try again.",
      });
    }

    const rowsToClear = [parentRow];
    const nextRows = windowRows.slice(1);
    const isConfirmedTab = expectedTabCanonical === "Confirmed";
    for (let i = 0; i < nextRows.length; i++) {
      const r = nextRows[i] || [];
      const candidateRowNum = parentRow + 1 + i;
      if (
        isContiguousJobChildRow({
          row: r,
          candidateRowNum,
          parentClient: actualClient,
          parentJobName: actualJobName,
          isConfirmedTab,
          isJobCosting,
          anchorRowSet,
        })
      ) {
        rowsToClear.push(candidateRowNum);
      } else {
        break;
      }
    }

    // Collect real invoices present on the cleared rows for response metadata
    const unassignedInvoices = [];
    for (let idx = 0; idx < rowsToClear.length; idx++) {
      const rowVals = windowRows[idx] || [];
      const rNum = rowsToClear[idx];
      for (let s = 1; s <= 3; s++) {
        const base = s === 1 ? 41 : s === 2 ? 48 : 55;
        const a = rowVals[base];
        const ref = String(rowVals[base + 1] || "").trim();
        const sent = rowVals[base + 2];
        const st = String(rowVals[base + 4] || "").trim();
        if (ref && !isPlaceholderInvoice(ref, st)) {
          unassignedInvoices.push({
            invoiceNo: ref,
            amount: parseFloat(String(a ?? "").replace(/[£$€,\s]/g, "")) || 0,
            sentDate: sent || "",
            status: st || "",
            slotNum: s,
            rowNum: rNum,
          });
        }
      }
    }

    // 1. Clean up dimension groups and unhide rows FIRST while sheet is idle
    const cleanupRequests = [];
    if (rowsToClear.length > 1 && targetSheetObj.rowGroups) {
      const childStartIndex = rowsToClear[1] - 1;
      const childEndIndex = rowsToClear[rowsToClear.length - 1];
      const matchingGroup = (targetSheetObj.rowGroups || []).find(
        (g) => g.range?.startIndex <= childStartIndex && g.range?.endIndex >= childEndIndex
      );
      if (matchingGroup) {
        cleanupRequests.push(
          {
            deleteDimensionGroup: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: matchingGroup.range.startIndex,
                endIndex: matchingGroup.range.endIndex,
              },
            },
          },
          {
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: matchingGroup.range.startIndex,
                endIndex: matchingGroup.range.endIndex,
              },
              properties: { hiddenByUser: false },
              fields: "hiddenByUser",
            },
          }
        );
      }
    }
    for (const rNum of rowsToClear) {
      cleanupRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rNum - 1,
            endIndex: rNum,
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      });
    }
    if (cleanupRequests.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: clientSheetId,
          requestBody: { requests: cleanupRequests },
          _skipFormulaRecompute: true,
        })
      ).catch(() => { });
    }

    // 2. Clear cells while preserving formulas
    const { clearRanges, restoreData } = buildJobRowClearAndRestorePlan({
      sheetName,
      rowNums: rowsToClear,
      isJobCosting,
      includeCopiedCol: true,
    });

    if (clearRanges.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: clientSheetId,
          _skipFormulaRecompute: restoreData.length > 0,
          _deferBackgroundRecompute: restoreData.length === 0,
          requestBody: { ranges: clearRanges },
        })
      );
    }
    if (restoreData.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: clientSheetId,
          _deferBackgroundRecompute: true,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: restoreData,
          },
        })
      );
    }

    const delCacheKey = `deleted_job_rows:${clientSheetId}:${expectedTabCanonical.toLowerCase()}`;
    const prevDel = memoryCache.get(delCacheKey) || [];
    const newSigs = rowsToClear.map((r) => `${Number(r)}:${normalizeNameKey(actualClient)}:${normalizeNameKey(actualJobName)}`);
    memoryCache.set(delCacheKey, Array.from(new Set([...prevDel, ...newSigs])), 15);

    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });
    await invalidatePmaClientCache(clientSheetId, null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]).catch(() => { });

    logPulseActivity(sheets, {
      clientName: verifiedClientName || clientName || actualClient || "Client",
      category: "JOB",
      action: "JOB_DELETED",
      summary: `Deleted job "${actualClient ? `${actualClient} - ` : ""}${actualJobName || "Job"}" from ${expectedTabCanonical} (${rowsToClear.length} row(s))`,
      details: {
        jobName: actualJobName,
        endClientName: actualClient,
        tabName: sheetName,
        clearedRows: rowsToClear,
      },
      user: sessionUser.name || sessionUser.email,
    }).catch(() => { });

    return res.status(200).json({
      success: true,
      deletedRowNumber: parentRow,
      clearedRowsCount: rowsToClear.length,
      unassignedInvoices,
    });
  } catch (err) {
    console.error("❌ /api/portal/delete-job error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed."),
    });
  } finally {
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });
  }
}
