import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet, sanitizeFormulaInput, isReadOnlySession } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache, invalidatePmaClientCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";
import {
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  getCrmDisplayName,
  isPlaceholderInvoice,
  NO_END_DATE_SHEET_VALUE,
  isNoEndDateSentinel,
  isJobCostingStyle,
  rewriteRowFormulasToTargetRow
} from "../../../utils/helpers.js";
import { buildRetainerChildRowsWritePlan } from "../../../services/retainers.js";
import { getToleranceValues } from "../../../services/sharedHelpers.js";
import { resolveMasterSheetIdForClient_ } from "../../../services/workspaces.js";

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

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  if (isReadOnlySession(sessionUser)) {
    return res.status(403).json({
      success: false,
      error: "Pulse is read-only when logged in with a one-time password.",
    });
  }

  const { clientSheetId, clientName, pipelineRow } = req.body || {};

  const pRow = parseInt(pipelineRow, 10);
  if (!clientSheetId || isNaN(pRow) || pRow < 2) {
    return res.status(400).json({ success: false, error: "Valid clientSheetId and pipelineRow (>= 2) are required" });
  }

  try {
    const sheets = await getSheetsClient();

    // Universal Fail-Closed Authorization Guard: binds sheetId to tenant identity
    const auth = await verifyUserAuthorizedForSheet(sessionUser, clientSheetId, clientName, sheets);
    if (!auth.authorized) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error });
    }
    const verifiedClientName = auth.clientName;

    // 1. Get sheet metadata
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets(properties,rowGroups)",
      })
    );
    const sheetMetaList = metaResp.data?.sheets || [];
    const pipelineSheetObj = sheetMetaList.find(
      (s) => s.properties?.title === "Pipeline" || s.properties?.title === "PipeCalcs"
    );
    const confirmedSheetObj = sheetMetaList.find(
      (s) => s.properties?.title === "Confirmed" || s.properties?.title === "ConfCalcs"
    );

    if (!pipelineSheetObj || !confirmedSheetObj) {
      throw new Error("Could not find Pipeline or Confirmed sheets in the spreadsheet");
    }

    const pipelineSheetName = pipelineSheetObj.properties.title;
    const confirmedSheetName = confirmedSheetObj.properties.title;
    const confirmedSheetId = confirmedSheetObj.properties.sheetId;

    // 2. Read parent + potential child rows from Pipeline, Pipeline headers, and Confirmed rows in parallel
    const [pipelineWindowResp, confDataResp, pHeaderResp] = await Promise.all([
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${pipelineSheetName}!A${pRow}:DH${pRow + 10}`,
          valueRenderOption: "FORMULA",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${confirmedSheetName}!A:BH`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      ),
      withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${pipelineSheetName}!1:2`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      ).catch(() => null),
    ]);
    const pipelineWindowRows = pipelineWindowResp.data?.values || [];
    const parentData = pipelineWindowRows[0] || [];
    const parentClient = String(parentData[0] ?? "").trim();
    const parentJobName = String(parentData[1] ?? "").trim();

    if (!parentClient && !parentJobName) {
      throw new Error(`Pipeline row ${pRow} does not contain client or job name`);
    }

    // Guard: Prevent manual promotion of CRM-originated pipeline deals
    const parentProjectCode = String(parentData[2] ?? "").trim();
    if (parentProjectCode) {
      let crmTool = "None";
      let crmDrives = "NA";
      try {
        const kiResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: "KeyInfo!Q8:Q9",
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const kiRows = kiResp.data?.values || [];
        if (kiRows[0]?.[0]) crmTool = String(kiRows[0][0]).trim();
        if (kiRows[1]?.[0]) crmDrives = String(kiRows[1][0]).trim();
      } catch (kiErr) {
        if (redisClient?.isOpen && verifiedClientName) {
          try {
            const normKey = String(verifiedClientName).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
            const rawCfg = await redisClient.get(`pulse:setup:${normKey}`);
            if (rawCfg) {
              const parsed = JSON.parse(rawCfg);
              if (parsed.crmTool) crmTool = parsed.crmTool;
              if (parsed.crmDrives) crmDrives = parsed.crmDrives;
            }
          } catch (e) { }
        }
      }

      if (hasActiveCrmIntegration(crmTool) && isCrmDrivenTab("pipeline", crmDrives)) {
        return res.status(400).json({
          success: false,
          error: `Cannot manually promote a CRM pipeline deal. Please update the deal status directly in ${getCrmDisplayName(crmTool)}.`,
        });
      }
    }

    // 3. Find child rows in Pipeline (from already-loaded window)
    const childRows = [];
    const childRowsData = [];
    const nextRows = pipelineWindowRows.slice(1);

    for (let i = 0; i < nextRows.length; i++) {
      const r = nextRows[i] || [];
      const rClient = String(r[0] ?? "").trim();
      const rJobName = String(r[1] ?? "").trim();
      if (
        rClient.toLowerCase() === parentClient.toLowerCase() &&
        rJobName.toLowerCase() === parentJobName.toLowerCase()
      ) {
        childRows.push(pRow + 1 + i);
        childRowsData.push(r);
      } else {
        break;
      }
    }

    const totalRowsNeeded = 1 + childRows.length;

    // 4. Find last job row in Confirmed sheet
    const allConfRows = confDataResp.data?.values || [];
    const isJobCosting = isJobCostingStyle({ headers: allConfRows[0] });
    let lastJobRow = 1;
    for (let r = allConfRows.length - 1; r >= 0; r--) {
      const rowData = allConfRows[r] || [];
      const hasDataA = rowData.slice(0, 39).some((v) => v !== undefined && String(v).trim() !== "");
      const hasDataB = rowData.slice(41, 60).some((v) => v !== undefined && String(v).trim() !== "");
      if (hasDataA || hasDataB) {
        lastJobRow = Math.max(lastJobRow, r + 1);
        break;
      }
    }

    const isRetainer = String(parentData[35] || "").trim().toLowerCase().includes("retainer");
    const shouldProvisionRetainer = isRetainer && childRowsData.length === 0;

    // Place new retainer parent row at lastJobRow + 1; keep existing placement for standard jobs
    const targetParentRow = shouldProvisionRetainer ? lastJobRow + 1 : lastJobRow + 2;

    // 5. Copy safe column ranges from Pipeline to Confirmed
    // Safe ranges: A:AM (1-39), AP:BH (42-60), BX:CR (76-96)
    // Formula columns (BI:BW revenue and CS:DC direct costs) are NEVER written to!
    const confirmedBatchData = [];

    // Parent row A:AM (cols 1-39, index 0-38)
    let parentA_AM = parentData.slice(0, 39);
    while (parentA_AM.length < 39) parentA_AM.push("");
    parentA_AM = rewriteRowFormulasToTargetRow(
      parentA_AM,
      pRow,
      targetParentRow,
      confirmedSheetName,
      isJobCosting,
      true
    ).slice(0, 39);
    // Set Date Confirmed (Column 4, index 3) to today's date formatted d-MMM-yy (e.g. 7-Aug-26)
    const now = new Date();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const todayStr = `${now.getDate()}-${months[now.getMonth()]}-${String(now.getFullYear()).slice(-2)}`;
    parentA_AM[3] = todayStr;
    if (isRetainer) {
      if (isJobCosting && String(parentA_AM[38] || "").startsWith("=")) {
        if (!String(parentA_AM[6] || "").trim() || isNoEndDateSentinel(parentA_AM[6])) {
          parentA_AM[6] = NO_END_DATE_SHEET_VALUE;
        }
      } else if (!String(parentA_AM[38] || "").trim() || isNoEndDateSentinel(parentA_AM[38])) {
        parentA_AM[38] = NO_END_DATE_SHEET_VALUE;
      }
    }

    confirmedBatchData.push({
      range: `${confirmedSheetName}!A${targetParentRow}:AM${targetParentRow}`,
      values: [parentA_AM],
    });

    // Col 40 (% likel., Col AN) is blank in Confirmed
    confirmedBatchData.push({
      range: `${confirmedSheetName}!AN${targetParentRow}`,
      values: [[""]],
    });

    // Extract any real invoices from Pipeline parent row if promoting a Retainer
    const initialRetainerInvoices = [];
    if (shouldProvisionRetainer) {
      const slotBases = [41, 48, 55];
      for (const base of slotBases) {
        const amt = parentData[base];
        const ref = String(parentData[base + 1] || "").trim();
        const sent = parentData[base + 2];
        const days = parentData[base + 3];
        const st = String(parentData[base + 4] || "").trim();
        const desc = parentData[base + 5];
        if (ref && !isPlaceholderInvoice(ref, st)) {
          initialRetainerInvoices.push({ amount: amt, ref, sendDate: sent, days, status: st, desc });
        }
      }
    }

    // Parent row AP:BH (cols 42-60, index 41-59)
    // For Retainers whose child rows are provisioned in background, keep parent AP:BH empty
    const parentAP_BH = shouldProvisionRetainer ? new Array(19).fill("") : parentData.slice(41, 60);
    while (parentAP_BH.length < 19) parentAP_BH.push("");
    confirmedBatchData.push({
      range: `${confirmedSheetName}!AP${targetParentRow}:BH${targetParentRow}`,
      values: [parentAP_BH],
    });

    // Parent row BX:CR (cols 76-96, index 75-95)
    const parentBX_CR = parentData.slice(75, 96);
    while (parentBX_CR.length < 21) parentBX_CR.push("");
    confirmedBatchData.push({
      range: `${confirmedSheetName}!BX${targetParentRow}:CR${targetParentRow}`,
      values: [parentBX_CR],
    });

    // 6. Copy child rows to Confirmed in safe ranges
    const confirmedChildRows = [];
    for (let i = 0; i < childRowsData.length; i++) {
      const targetChildRow = targetParentRow + 1 + i;
      const childData = childRowsData[i];

      let childA_AM = childData.slice(0, 39);
      while (childA_AM.length < 39) childA_AM.push("");
      // Child row inheritance
      childA_AM[0] = parentClient;
      childA_AM[1] = parentJobName;
      childA_AM[3] = "";
      if (isJobCosting) {
        for (const c of [5, 6, 7, 8, 9, 11, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 28, 29, 31]) {
          childA_AM[c] = "";
        }
        childA_AM = rewriteRowFormulasToTargetRow(
          childA_AM,
          pRow + 1 + i,
          targetChildRow,
          confirmedSheetName,
          isJobCosting,
          false
        ).slice(0, 39);
      } else {
        childA_AM[32] = ""; // Blank revenue
        childA_AM[33] = ""; // Blank direct costs
      }

      confirmedBatchData.push({
        range: `${confirmedSheetName}!A${targetChildRow}:AM${targetChildRow}`,
        values: [childA_AM],
      });

      confirmedBatchData.push({
        range: `${confirmedSheetName}!AN${targetChildRow}`,
        values: [[""]],
      });

      const childAP_BH = childData.slice(41, 60);
      while (childAP_BH.length < 19) childAP_BH.push("");
      confirmedBatchData.push({
        range: `${confirmedSheetName}!AP${targetChildRow}:BH${targetChildRow}`,
        values: [childAP_BH],
      });

      const childBX_CR = childData.slice(75, 96);
      while (childBX_CR.length < 21) childBX_CR.push("");
      confirmedBatchData.push({
        range: `${confirmedSheetName}!BX${targetChildRow}:CR${targetChildRow}`,
        values: [childBX_CR],
      });

      confirmedChildRows.push(targetChildRow);
    }

    if (shouldProvisionRetainer) {
      let tolerance = null;
      try {
        const resolvedMasterId = await resolveMasterSheetIdForClient_(
          sheets,
          clientSheetId,
          verifiedClientName || clientName || ""
        );
        tolerance = await getToleranceValues(sheets, resolvedMasterId || clientSheetId);
      } catch (_) {}

      const retainerPlan = buildRetainerChildRowsWritePlan({
        parentRowNum: targetParentRow,
        client: parentClient,
        jobName: parentJobName,
        monthlyRevenue: isJobCosting && String(parentData[32] || "").startsWith("=") ? parentData[8] : parentData[32],
        vat: parentData[34] || "No",
        startDate: isJobCosting && String(parentData[37] || "").startsWith("=") ? parentData[5] : parentData[37],
        endDate: (isJobCosting && String(parentA_AM[38] || "").startsWith("=") ? parentA_AM[6] : parentA_AM[38]) || NO_END_DATE_SHEET_VALUE,
        b51TargetDay: tolerance?.retainerInvoiceDay || 28,
        defaultDaysToPay: tolerance?.defaultDaysToPay || 30,
        initialInvoices: initialRetainerInvoices,
        confirmedTabTitle: confirmedSheetName,
      });
      if (retainerPlan.writeData.length > 0) {
        confirmedBatchData.push(...retainerPlan.writeData);
        confirmedChildRows.push(...retainerPlan.childRowNums);
      }
    }

    // 7. Format Date Confirmed cell (Column D) and group child rows in Confirmed BEFORE values.batchUpdate
    // so structural spreadsheets.batchUpdate executes while the sheet is idle (<1s) rather than waiting
    // behind Google Sheets' 2-3 minute formula recalculation lock triggered by values.batchUpdate.
    try {
      const preWriteStructReqs = [
        {
          updateDimensionProperties: {
            range: {
              sheetId: confirmedSheetId,
              dimension: "ROWS",
              startIndex: targetParentRow - 1,
              endIndex: targetParentRow,
            },
            properties: { hiddenByUser: false },
            fields: "hiddenByUser",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: confirmedSheetId,
              startRowIndex: targetParentRow - 1,
              endRowIndex: targetParentRow,
              startColumnIndex: 3,
              endColumnIndex: 4,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: {
                  type: "DATE",
                  pattern: "d-mmm-yy",
                },
                textFormat: {
                  italic: true,
                },
              },
            },
            fields: "userEnteredFormat.numberFormat,userEnteredFormat.textFormat.italic",
          },
        },
      ];

      if (confirmedChildRows.length > 0) {
        const childStartIndex = confirmedChildRows[0] - 1; // 0-based inclusive
        const childEndIndex = confirmedChildRows[confirmedChildRows.length - 1]; // 0-based exclusive
        const existingConfGroups = confirmedSheetObj.rowGroups || [];
        const overlappingGroups = existingConfGroups.filter(
          (g) => g.range && g.range.startIndex < childEndIndex && g.range.endIndex > childStartIndex
        );
        const exactMatch = overlappingGroups.find(
          (g) => g.range.startIndex === childStartIndex && g.range.endIndex === childEndIndex
        );

        if (!exactMatch) {
          for (const g of overlappingGroups) {
            preWriteStructReqs.push({
              deleteDimensionGroup: {
                range: {
                  sheetId: confirmedSheetId,
                  dimension: "ROWS",
                  startIndex: g.range.startIndex,
                  endIndex: g.range.endIndex,
                },
              },
            });
          }
          preWriteStructReqs.push({
            addDimensionGroup: {
              range: {
                sheetId: confirmedSheetId,
                dimension: "ROWS",
                startIndex: childStartIndex,
                endIndex: childEndIndex,
              },
            },
          });
          if (isRetainer) {
            preWriteStructReqs.push(
              {
                updateDimensionGroup: {
                  dimensionGroup: {
                    range: {
                      sheetId: confirmedSheetId,
                      dimension: "ROWS",
                      startIndex: childStartIndex,
                      endIndex: childEndIndex,
                    },
                    depth: 1,
                    collapsed: true,
                  },
                  fields: "collapsed",
                },
              },
              {
                updateDimensionProperties: {
                  range: {
                    sheetId: confirmedSheetId,
                    dimension: "ROWS",
                    startIndex: childStartIndex,
                    endIndex: childEndIndex,
                  },
                  properties: { hiddenByUser: true },
                  fields: "hiddenByUser",
                },
              }
            );
          } else {
            preWriteStructReqs.push({
              updateDimensionProperties: {
                range: {
                  sheetId: confirmedSheetId,
                  dimension: "ROWS",
                  startIndex: childStartIndex,
                  endIndex: childEndIndex,
                },
                properties: { hiddenByUser: false },
                fields: "hiddenByUser",
              },
            });
          }
        }
      }

      await sheets.spreadsheets.batchUpdate(
        {
          spreadsheetId: clientSheetId,
          requestBody: { requests: preWriteStructReqs },
        },
        { timeout: 10000, retry: false }
      );
    } catch (structErr) {
      console.warn("⚠️ Pre-write formatting/grouping in Confirmed warning (non-fatal):", structErr.message);
    }

    // 8. Update Pipeline row: set % likelihood to 100% and Copied to Conf? to "Yes" in the same batchUpdate
    let likelihoodCol = "AN";
    let copiedStatusCol = "DD";
    try {
      const rows = pHeaderResp?.data?.values || [];
      const headerRow = rows[1] && rows[1].length > 10 ? rows[1] : (rows[0] || []);
      const lIdx = headerRow.findIndex((h) => {
        const s = String(h || "").trim().toLowerCase();
        return s === "% likel." || s === "% likelihood" || s === "% likely" || s === "likelihood";
      });
      if (lIdx !== -1) {
        likelihoodCol = colToLetter(lIdx);
      }
      const cIdx = headerRow.findIndex((h) => {
        const s = String(h || "").trim().toLowerCase();
        return s.includes("copied") || s.includes("conf?");
      });
      if (cIdx !== -1) {
        copiedStatusCol = colToLetter(cIdx);
      }
    } catch (e) {
      console.warn("⚠️ Failed to detect pipeline header columns, falling back to AN & DD:", e.message);
    }

    confirmedBatchData.push(
      {
        range: `${pipelineSheetName}!${likelihoodCol}${pRow}`,
        values: [["100%"]],
      },
      {
        range: `${pipelineSheetName}!${copiedStatusCol}${pRow}`,
        values: [["Yes"]],
      }
    );

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: confirmedBatchData,
        },
      })
    );

    // 9. Invalidate In-Memory and Redis caches across both Portal and PMA
    try {
      await invalidatePmaClientCache(clientSheetId, null, ["jobs", "invoices", "outgoings", "retainers", "cash", "views"]);
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation warning:", cacheErr.message);
    }

    // 10. Log Activity (non-blocking)
    logPulseActivity(sheets, {
      clientName: verifiedClientName || clientName || parentClient || "Client",
      category: "JOB",
      action: "JOB_CONFIRMED",
      summary: `Confirmed job: "${parentJobName || "Job"}" (Pipeline row ${pRow} → Confirmed row ${targetParentRow})`,
      details: {
        jobName: parentJobName,
        client: parentClient,
        pipelineRow: pRow,
        confirmedRow: targetParentRow,
        childRowsCount: childRows.length
      },
      user: sessionUser.name || sessionUser.email
    }).catch((logErr) => console.warn("⚠️ Failed to log confirm-job activity:", logErr.message));

    return res.status(200).json({
      success: true,
      confirmedRow: targetParentRow,
      childRows: confirmedChildRows,
      backgroundProvisioning: false,
      message: `Successfully confirmed job to row ${targetParentRow}`,
    });
  } catch (err) {
    console.error("❌ /api/portal/confirm-job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
