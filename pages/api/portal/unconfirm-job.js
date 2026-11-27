import { resolveLiveSessionUser, checkRateLimit, getTrustedClientIp } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput, sanitizeJobSlice, isReadOnlySession } from "../../../services/userPermissions.js";
import { assertClientPortalLive } from "../../../services/setupService.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache, invalidatePmaClientCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  isJobCostingStyle,
  isJobCostingColJLikelihoodFormula,
  buildJobRowClearAndRestorePlan,
  rewriteRowFormulasToTargetRow,
  normalizeLikelihoodInput,
  formatLikelihood,
  assertTrustedOrigin,
  sanitizeSpreadsheetTerms,
  resolveEditableJobSheetMeta,
  isContiguousJobChildRow,
} from "../../../utils/helpers.js";
import { flushImmediateAndScheduleBackgroundClientRecomputes, resolveSupabaseSheetContext } from "../../../services/masterEngineService.js";
import { resolveAuthoritativeJobAnchor, getClientRelationalJobsLookup, getRecentReconciledJobUuid } from "../../../services/relationalJobsService.js";
import { relinkNotesForJobChange } from "../../../services/pulseNotesService.js";
import { buildJobNoteKey, buildJobNoteLabel } from "../../../utils/pulseNotesKeys.js";

function colToLetter(colIndex) {
  let temp, letter = "";
  let c = colIndex + 1;
  while (c > 0) {
    temp = (c - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    c = Math.floor((c - temp - 1) / 26);
  }
  return letter;
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

  const rl = await checkRateLimit("portal-unconfirm-job", sessionUser.email || getTrustedClientIp(req), 40, 60);
  if (!rl.allowed) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait a moment and try again." });
  }

  const { clientSheetId, clientName, confirmedRow, jobUuid } = req.body || {};

  const parsedCRow = parseInt(confirmedRow, 10);
  if (!clientSheetId || (!jobUuid && (isNaN(parsedCRow) || parsedCRow < 2))) {
    return res.status(400).json({ success: false, error: "Valid clientSheetId and confirmedRow (>= 2) are required" });
  }

  let didFlushImmediate = false;
  try {
    const sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName;
    const liveGate = await assertClientPortalLive(sessionUser, verifiedClientName, res);
    if (!liveGate.allowed) return;

    const [relationalAnchor, metaResp] = await Promise.all([
      resolveAuthoritativeJobAnchor({
        spreadsheetId: clientSheetId,
        clientName: verifiedClientName,
        jobUuid,
        expectedTabName: "Confirmed",
        fallbackRowNum: !isNaN(parsedCRow) && parsedCRow >= 2 ? parsedCRow : null,
      }),
      withRetry(() =>
        sheets.spreadsheets.get({
          spreadsheetId: clientSheetId,
          fields: "sheets(properties,rowGroups)",
        })
      ),
    ]);
    const cRow = relationalAnchor?.rowNum;
    if (isNaN(cRow) || cRow < 2) {
      return res.status(400).json({ success: false, error: "Valid clientSheetId and confirmedRow (>= 2) are required" });
    }

    // 1. Get sheet metadata
    const sheetMetaList = metaResp.data?.sheets || [];
    const confirmedSheetObj = resolveEditableJobSheetMeta(sheetMetaList, "confirmed");
    const pipelineSheetObj = resolveEditableJobSheetMeta(sheetMetaList, "pipeline");

    if (!confirmedSheetObj || !pipelineSheetObj) {
      throw new Error("Could not find Confirmed or Pipeline sheets in the spreadsheet");
    }

    const confirmedSheetName = confirmedSheetObj.properties.title;
    const confirmedSheetId = confirmedSheetObj.properties.sheetId;
    const pipelineSheetName = pipelineSheetObj.properties.title;
    const pipelineSheetId = pipelineSheetObj.properties.sheetId;

    const anchorRowSet = new Set(
      Array.isArray(relationalAnchor?.rowNums)
        ? relationalAnchor.rowNums.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 2)
        : []
    );
    const fetchEndRow = Math.max(
      cRow + 60,
      ...(anchorRowSet.size > 0 ? Array.from(anchorRowSet) : [cRow])
    );

    // 2. Read parent + child rows from Confirmed and all Pipeline rows (A:AN) in parallel
    const [confWindowResp, pipelineDataResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${confirmedSheetName}!A${cRow}:CZ${fetchEndRow}`,
          valueRenderOption: "FORMULA",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${pipelineSheetName}!A:AN`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
    ]);
    const confWindowRows = confWindowResp.data?.values || [];
    const parentData = confWindowRows[0] || [];
    const parentClient = String(parentData[0] ?? "").trim();
    const parentJobName = String(parentData[1] ?? "").trim();
    const parentProjectCode = String(parentData[2] ?? "").trim();
    const parentRevenue = parentData[32]; // Col 33

    if (!parentClient && !parentJobName) {
      throw new Error(`Confirmed row ${cRow} does not contain client or job name`);
    }

    // 3. Find child rows in Confirmed (from already-loaded window)
    const allPipelineRows = pipelineDataResp.data?.values || [];
    const isJobCosting = isJobCostingStyle({ headers: allPipelineRows[0] });
    const confirmedChildRows = [];
    const confirmedChildRowsData = [];
    const nextRows = confWindowRows.slice(1);

    for (let i = 0; i < nextRows.length; i++) {
      const r = nextRows[i] || [];
      const candidateRowNum = cRow + 1 + i;
      if (
        isContiguousJobChildRow({
          row: r,
          candidateRowNum,
          parentClient,
          parentJobName,
          isConfirmedTab: true,
          isJobCosting,
          anchorRowSet,
        })
      ) {
        confirmedChildRows.push(candidateRowNum);
        confirmedChildRowsData.push(r);
      } else {
        break;
      }
    }

    // 3.5. Safety check: Cannot unconfirm if actual invoices or expenses exist on this job
    const checkRowHasActuals = (r) => {
      // Check invoice slots 1, 2, 3
      for (const base of [41, 48, 55]) {
        const ref = String(r[base + 1] || "").trim();
        const st = String(r[base + 4] || "").trim();
        if (ref && !isPlaceholderInvoice(ref, st)) {
          return { hasActuals: true, reason: `invoice ref "${ref}"` };
        }
      }
      // Check expense slots 1, 2, 3
      for (const base of [75, 82, 89]) {
        const desc = String(r[base] || "").trim();
        const amt = parseFloat(String(r[base + 1] || "0").replace(/[£$€,\s]/g, "")) || 0;
        const st = String(r[base + 5] || "").trim();
        const appId = String(r[base + 6] || "").trim();
        if ((Math.abs(amt) > 0 || desc || appId) && !isPlaceholderExpense(appId, desc, st)) {
          return { hasActuals: true, reason: `expense "${desc || appId || amt}"` };
        }
      }
      return { hasActuals: false };
    };

    const parentActuals = checkRowHasActuals(parentData);
    if (parentActuals.hasActuals) {
      return res.status(400).json({
        success: false,
        error: "Cannot unconfirm this job because it has actual invoices or expenses assigned to it. Please reassign or remove them before moving the job back to the pipeline.",
      });
    }

    for (const childRowData of confirmedChildRowsData) {
      const childActuals = checkRowHasActuals(childRowData);
      if (childActuals.hasActuals) {
        return res.status(400).json({
          success: false,
          error: "Cannot unconfirm this job because it has actual invoices or expenses assigned to it. Please reassign or remove them before moving the job back to the pipeline.",
        });
      }
    }

    // 4. Look for existing Pipeline row
    let pipelineRow = null;
    let isExistingJob = false;

    // a. Match by Project Code (Column C, index 2)
    if (parentProjectCode) {
      for (let i = 1; i < allPipelineRows.length; i++) {
        const row = allPipelineRows[i] || [];
        const code = (row[2] || "").trim();
        if (code && code.toLowerCase() === parentProjectCode.toLowerCase()) {
          pipelineRow = i + 1;
          isExistingJob = true;
          break;
        }
      }
    }

    // b. Match by Client + Job Name + Revenue (Cols A, B, AG)
    if (!pipelineRow) {
      for (let i = 1; i < allPipelineRows.length; i++) {
        const row = allPipelineRows[i] || [];
        const rClient = (row[0] || "").trim();
        const rJob = (row[1] || "").trim();
        const rRev = row[32];
        if (
          rClient.toLowerCase() === parentClient.toLowerCase() &&
          rJob.toLowerCase() === parentJobName.toLowerCase()
        ) {
          pipelineRow = i + 1;
          isExistingJob = true;
          break;
        }
      }
    }

    // c. If not found, find first blank row below all jobs in Pipeline
    if (!pipelineRow) {
      let lastJobRow = 1;
      for (let r = allPipelineRows.length - 1; r >= 0; r--) {
        const row = allPipelineRows[r] || [];
        const hasData = row.slice(0, 33).some((v) => v !== undefined && String(v).trim() !== "");
        if (hasData) {
          lastJobRow = r + 1;
          break;
        }
      }
      pipelineRow = lastJobRow + 1;
      isExistingJob = false;
    }

    // 5. Copy safe column ranges to Pipeline
    // Safe ranges: A:AM (1-39), AN (40 - likelihood), AP:BH (42-60), BX:CR (76-96)
    // Formula columns (BI:BW revenue and CS:DC direct costs) are NEVER written to!
    const pipelineBatchData = [];

    // Determine parent likelihood
    let targetLikelihood = "50%";
    if (req.body?.likelihood !== undefined && String(req.body.likelihood).trim() !== "") {
      const normalized = normalizeLikelihoodInput(req.body.likelihood);
      if (normalized) targetLikelihood = normalized;
    } else if (isExistingJob) {
      const existingRow = allPipelineRows[pipelineRow - 1] || [];
      const currLikelihood = String(existingRow[39] || "");
      if (!currLikelihood.includes("100") && currLikelihood !== "1" && currLikelihood !== "") {
        targetLikelihood = formatLikelihood(currLikelihood) || "50%";
      }
    }

    // Parent row A:AM (cols 1-39, index 0-38) — strip Col R recharged expenses (Confirmed-only)
    let parentA_AM = parentData.slice(0, 39);
    while (parentA_AM.length < 39) parentA_AM.push("");
    parentA_AM[17] = "";
    parentA_AM = rewriteRowFormulasToTargetRow(
      parentA_AM,
      cRow,
      pipelineRow,
      pipelineSheetName,
      isJobCosting,
      true
    ).slice(0, 39);
    if (!isExistingJob) {
      const todayStr = new Date().toISOString().split("T")[0];
      parentA_AM[3] = todayStr;
    }

    parentA_AM = sanitizeJobSlice(parentA_AM, { isJobCosting, isPrimaryRange: true });

    pipelineBatchData.push({
      range: `${pipelineSheetName}!A${pipelineRow}:AM${pipelineRow}`,
      values: [parentA_AM],
    });

    let writeLikelihoodCol = "AN";
    if (isJobCosting && isExistingJob) {
      try {
        const anFormulaResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: `${pipelineSheetName}!AN${pipelineRow}`,
            valueRenderOption: "FORMULA",
          })
        );
        if (isJobCostingColJLikelihoodFormula(anFormulaResp.data?.values?.[0]?.[0])) {
          writeLikelihoodCol = "J";
        }
      } catch (_) { }
    }

    pipelineBatchData.push({
      range: `${pipelineSheetName}!${writeLikelihoodCol}${pipelineRow}`,
      values: [[sanitizeFormulaInput(targetLikelihood)]],
    });

    // Parent row AP:BH (cols 42-60, index 41-59) — clear Confirmed recharged/cost-month offsets (slots 1 & 2)
    const parentAP_BH = sanitizeJobSlice(parentData.slice(41, 60));
    while (parentAP_BH.length < 19) parentAP_BH.push("");
    parentAP_BH[5] = "";
    parentAP_BH[6] = "";
    parentAP_BH[12] = "";
    parentAP_BH[13] = "";
    pipelineBatchData.push({
      range: `${pipelineSheetName}!AP${pipelineRow}:BH${pipelineRow}`,
      values: [parentAP_BH],
    });

    // Parent row BX:CR (cols 76-96, index 75-95)
    const parentBX_CR = sanitizeJobSlice(parentData.slice(75, 96));
    while (parentBX_CR.length < 21) parentBX_CR.push("");
    pipelineBatchData.push({
      range: `${pipelineSheetName}!BX${pipelineRow}:CR${pipelineRow}`,
      values: [parentBX_CR],
    });

    // Clear column DD (Col 108: Copied to Conf?)
    pipelineBatchData.push({
      range: `${pipelineSheetName}!DD${pipelineRow}`,
      values: [[""]],
    });

    // 6. Copy child rows to Pipeline in safe ranges
    const pipelineChildRows = [];
    for (let i = 0; i < confirmedChildRowsData.length; i++) {
      const targetChildRow = pipelineRow + 1 + i;
      const childData = confirmedChildRowsData[i];

      let childA_AM = childData.slice(0, 39);
      while (childA_AM.length < 39) childA_AM.push("");
      childA_AM[0] = parentClient;
      childA_AM[1] = parentJobName;
      childA_AM[3] = "";
      childA_AM[17] = "";
      if (isJobCosting) {
        for (const c of [5, 6, 7, 8, 9, 11, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 28, 29, 31]) {
          childA_AM[c] = "";
        }
        childA_AM = rewriteRowFormulasToTargetRow(
          childA_AM,
          cRow + 1 + i,
          targetChildRow,
          pipelineSheetName,
          isJobCosting,
          false
        ).slice(0, 39);
      } else {
        childA_AM[32] = ""; // Blank revenue
        childA_AM[33] = ""; // Blank direct costs
      }

      pipelineBatchData.push({
        range: `${pipelineSheetName}!A${targetChildRow}:AM${targetChildRow}`,
        values: [sanitizeJobSlice(childA_AM, { isJobCosting, isPrimaryRange: true })],
      });

      pipelineBatchData.push({
        range: `${pipelineSheetName}!AN${targetChildRow}`,
        values: [[""]],
      });

      const childAP_BH = sanitizeJobSlice(childData.slice(41, 60));
      while (childAP_BH.length < 19) childAP_BH.push("");
      childAP_BH[5] = "";
      childAP_BH[6] = "";
      childAP_BH[12] = "";
      childAP_BH[13] = "";
      pipelineBatchData.push({
        range: `${pipelineSheetName}!AP${targetChildRow}:BH${targetChildRow}`,
        values: [childAP_BH],
      });

      const childBX_CR = sanitizeJobSlice(childData.slice(75, 96));
      while (childBX_CR.length < 21) childBX_CR.push("");
      pipelineBatchData.push({
        range: `${pipelineSheetName}!BX${targetChildRow}:CR${targetChildRow}`,
        values: [childBX_CR],
      });

      pipelineChildRows.push(targetChildRow);
    }

    const clearRowRanges = [cRow, ...confirmedChildRows];

    // Group child rows in Pipeline and remove dimension group in Confirmed BEFORE cell writes/clears
    // so structural spreadsheets.batchUpdate executes while the sheet is idle (<1s).
    try {
      const structRequests = [
        {
          updateDimensionProperties: {
            range: {
              sheetId: pipelineSheetId,
              dimension: "ROWS",
              startIndex: pipelineRow - 1,
              endIndex: pipelineRow,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        },
      ];
      if (pipelineChildRows.length > 0) {
        const childStartIndex = pipelineChildRows[0] - 1;
        const childEndIndex = pipelineChildRows[pipelineChildRows.length - 1];
        const existingPipeGroups = pipelineSheetObj.rowGroups || [];
        const overlappingGroups = existingPipeGroups.filter(
          (g) => g.range && g.range.startIndex < childEndIndex && g.range.endIndex > childStartIndex
        );
        const exactMatch = overlappingGroups.find(
          (g) => g.range.startIndex === childStartIndex && g.range.endIndex === childEndIndex
        );

        if (!exactMatch) {
          for (const g of overlappingGroups) {
            structRequests.push({
              deleteDimensionGroup: {
                range: {
                  sheetId: pipelineSheetId,
                  dimension: "ROWS",
                  startIndex: g.range.startIndex,
                  endIndex: g.range.endIndex,
                },
              },
            });
          }

          structRequests.push({
            addDimensionGroup: {
              range: {
                sheetId: pipelineSheetId,
                dimension: "ROWS",
                startIndex: childStartIndex,
                endIndex: childEndIndex,
              },
            },
          });
        }
        structRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId: pipelineSheetId,
              dimension: "ROWS",
              startIndex: childStartIndex,
              endIndex: childEndIndex,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }

      if (confirmedChildRows.length > 0) {
        const childStartIndex = confirmedChildRows[0] - 1;
        const childEndIndex = confirmedChildRows[confirmedChildRows.length - 1];
        const existingConfGroups = confirmedSheetObj.rowGroups || [];
        const groupToDelete = existingConfGroups.find(
          (g) => g.range?.startIndex <= childStartIndex && g.range?.endIndex >= childEndIndex
        );
        if (groupToDelete) {
          structRequests.push(
            {
              deleteDimensionGroup: {
                range: {
                  sheetId: confirmedSheetId,
                  dimension: "ROWS",
                  startIndex: groupToDelete.range.startIndex,
                  endIndex: groupToDelete.range.endIndex,
                },
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId: confirmedSheetId,
                  dimension: "ROWS",
                  startIndex: groupToDelete.range.startIndex,
                  endIndex: groupToDelete.range.endIndex,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            }
          );
        }
      }
      for (const rNum of clearRowRanges) {
        structRequests.push({
          updateDimensionProperties: {
            range: {
              sheetId: confirmedSheetId,
              dimension: "ROWS",
              startIndex: rNum - 1,
              endIndex: rNum,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        });
      }

      if (structRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate(
          {
            spreadsheetId: clientSheetId,
            requestBody: {
              requests: structRequests,
            },
          },
          { timeout: 10000, retry: false }
        );
      }
    } catch (groupErr) {
      console.warn("⚠️ Structural grouping update warning (non-fatal):", groupErr.message);
    }

    // 7. Write Pipeline data and clear Confirmed data in a single parallel round-trip
    // Safe ranges: A:AM (1-39), AP:BH (42-60), BX:CR (76-96)
    const { clearRanges: batchClearRanges, restoreData: batchRestoreData } =
      buildJobRowClearAndRestorePlan({
        sheetName: confirmedSheetName,
        rowNums: clearRowRanges,
        isJobCosting,
        includeCopiedCol: false,
      });

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        _skipFormulaRecompute: batchClearRanges.length > 0,
        _deferBackgroundRecompute: batchClearRanges.length === 0,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: pipelineBatchData,
        },
      })
    );
    if (batchClearRanges.length > 0) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: clientSheetId,
          _skipFormulaRecompute: batchRestoreData.length > 0,
          _deferBackgroundRecompute: batchRestoreData.length === 0,
          requestBody: {
            ranges: batchClearRanges,
          },
        })
      );
      if (batchRestoreData.length > 0) {
        await withRetry(() =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: clientSheetId,
            _deferBackgroundRecompute: true,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: batchRestoreData,
            },
          })
        );
      }
    }

    // 8. Flush immediate recomputes BEFORE invalidating caches so Portal/PMA reads reflect the demoted job immediately
    await flushImmediateAndScheduleBackgroundClientRecomputes(sheets, verifiedClientName || clientName || "").catch(() => { });
    didFlushImmediate = true;

    // 9. Invalidate In-Memory and Redis caches across both Portal and PMA
    try {
      const unconfSbCtx = await resolveSupabaseSheetContext({
        clientName: verifiedClientName || clientName || "",
        spreadsheetId: clientSheetId,
      }).catch(() => null);
      await invalidatePmaClientCache(clientSheetId, unconfSbCtx?.masterSheetId || null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]);
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // 9. Log Activity (non-blocking)
    logPulseActivity(sheets, {
      clientName: verifiedClientName || clientName || parentClient || "Client",
      category: "JOB",
      action: "JOB_UNCONFIRMED",
      summary: `Unconfirmed job: "${parentJobName || "Job"}" (Confirmed row ${cRow} → Pipeline row ${pipelineRow})`,
      details: {
        jobName: parentJobName,
        client: parentClient,
        confirmedRow: cRow,
        pipelineRow,
        childRowsCount: confirmedChildRows.length
      },
      user: sessionUser.name || sessionUser.email
    }).catch((logErr) => console.warn("⚠️ Failed to log unconfirm-job activity:", logErr.message));

    const prevConfKey = buildJobNoteKey({
      client: parentClient,
      jobName: parentJobName,
      projectCode: parentProjectCode,
      rowNumber: cRow,
    });
    const nextPipeKey = buildJobNoteKey({
      client: parentClient,
      jobName: parentJobName,
      projectCode: parentProjectCode,
      rowNumber: pipelineRow,
    });
    relinkNotesForJobChange({
      clientName: verifiedClientName || clientName || parentClient || "",
      oldJobKey: prevConfKey,
      newJobKey: nextPipeKey,
      newJobLabel: buildJobNoteLabel({ client: parentClient, jobName: parentJobName }),
    }).catch(() => { });

    let pipelineJobUuid = getRecentReconciledJobUuid(
      verifiedClientName || clientName || parentClient || "",
      "Pipeline",
      pipelineRow
    );
    if (!pipelineJobUuid && relationalAnchor?.isRelational) {
      try {
        const relLookup = await getClientRelationalJobsLookup(verifiedClientName || clientName || parentClient || "");
        pipelineJobUuid = relLookup?.jobsByTabAndRow?.get(`pipeline:${pipelineRow}`)?.id || null;
      } catch (_) { }
    }

    return res.status(200).json({
      success: true,
      pipelineRow,
      ...(pipelineJobUuid ? { pipelineJobUuid } : {}),
      childRows: pipelineChildRows,
      message: "Successfully moved job to pipeline",
    });
  } catch (err) {
    console.error("❌ /api/portal/unconfirm-job error:", err);
    const status = err?.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: sessionUser?.isAdmin ? err.message : sanitizeSpreadsheetTerms(err.message || "Request failed.")
    });
  } finally {
    if (!didFlushImmediate) {
      await flushImmediateAndScheduleBackgroundClientRecomputes().catch(() => { });
    }
  }
}
