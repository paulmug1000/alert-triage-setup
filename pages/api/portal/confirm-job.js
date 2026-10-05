import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";
import { memoryCache } from "../../../services/cacheService.js";
import { logPulseActivity } from "../../../services/pulseLogger.js";

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

  if (sessionUser.isReadOnly) {
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

  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  try {
    const sheets = await getSheetsClient();

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

    // 2. Read parent row from Pipeline
    const parentResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${pipelineSheetName}!A${pRow}:DH${pRow}`,
        valueRenderOption: "FORMULA",
      })
    );
    const parentData = parentResp.data?.values?.[0] || [];
    const parentClient = (parentData[0] || "").trim();
    const parentJobName = (parentData[1] || "").trim();

    if (!parentClient && !parentJobName) {
      throw new Error(`Pipeline row ${pRow} does not contain client or job name`);
    }

    // 3. Find child rows in Pipeline (batch read up to 10 rows below)
    const childRows = [];
    const childRowsData = [];
    const potentialChildrenResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${pipelineSheetName}!A${pRow + 1}:DH${pRow + 10}`,
        valueRenderOption: "FORMULA",
      })
    );
    const nextRows = potentialChildrenResp.data?.values || [];

    for (let i = 0; i < nextRows.length; i++) {
      const r = nextRows[i];
      const rClient = (r[0] || "").trim();
      const rJobName = (r[1] || "").trim();
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
    const confDataResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${confirmedSheetName}!A:BH`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    const allConfRows = confDataResp.data?.values || [];
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

    // In Confirmed, use second blank row after all jobs (original app Step 5)
    const targetParentRow = lastJobRow + 2;

    // 5. Copy safe column ranges from Pipeline to Confirmed
    // Safe ranges: A:AM (1-39), AP:BH (42-60), BX:CR (76-96)
    // Formula columns (BI:BW revenue and CS:DC direct costs) are NEVER written to!
    const confirmedBatchData = [];

    // Parent row A:AM (cols 1-39, index 0-38)
    const parentA_AM = parentData.slice(0, 39);
    while (parentA_AM.length < 39) parentA_AM.push("");
    // Set Date Confirmed (Column 4, index 3) to today's date formatted YYYY-MM-DD
    const todayStr = new Date().toISOString().split("T")[0];
    parentA_AM[3] = todayStr;

    confirmedBatchData.push({
      range: `${confirmedSheetName}!A${targetParentRow}:AM${targetParentRow}`,
      values: [parentA_AM],
    });

    // Col 40 (% likel., Col AN) is blank in Confirmed
    confirmedBatchData.push({
      range: `${confirmedSheetName}!AN${targetParentRow}`,
      values: [[""]],
    });

    // Parent row AP:BH (cols 42-60, index 41-59)
    const parentAP_BH = parentData.slice(41, 60);
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

      const childA_AM = childData.slice(0, 39);
      while (childA_AM.length < 39) childA_AM.push("");
      // Child row inheritance
      childA_AM[0] = parentClient;
      childA_AM[1] = parentJobName;
      childA_AM[3] = "";
      childA_AM[32] = ""; // Blank revenue
      childA_AM[33] = ""; // Blank direct costs

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

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: confirmedBatchData,
        },
      })
    );

    // 7. Group child rows in Confirmed sheet under targetParentRow
    if (confirmedChildRows.length > 0) {
      try {
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
          const deleteReqs = overlappingGroups.map((g) => ({
            deleteDimensionGroup: {
              range: {
                sheetId: confirmedSheetId,
                dimension: "ROWS",
                startIndex: g.range.startIndex,
                endIndex: g.range.endIndex,
              },
            },
          }));

          const addReq = {
            addDimensionGroup: {
              range: {
                sheetId: confirmedSheetId,
                dimension: "ROWS",
                startIndex: childStartIndex,
                endIndex: childEndIndex,
              },
            },
          };

          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: clientSheetId,
              requestBody: {
                requests: [...deleteReqs, addReq],
              },
            })
          );
        }
      } catch (groupErr) {
        console.warn("⚠️ Grouping child rows in Confirmed warning (non-fatal):", groupErr.message);
      }
    }

    // 8. Update Pipeline row: set % likelihood to 100% and Copied to Conf? to "Yes"
    let likelihoodCol = "AN";
    let copiedStatusCol = "DD";
    try {
      const pHeaderResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${pipelineSheetName}!1:2`,
          valueRenderOption: "FORMATTED_VALUE",
        })
      );
      const rows = pHeaderResp.data?.values || [];
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

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `${pipelineSheetName}!${likelihoodCol}${pRow}`,
              values: [["100%"]],
            },
            {
              range: `${pipelineSheetName}!${copiedStatusCol}${pRow}`,
              values: [["Yes"]],
            },
          ],
        },
      })
    );

    // 9. Invalidate In-Memory and Redis caches
    memoryCache.del(`pulse:portal:*:${clientSheetId}*`);
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Redis invalidation warning:", cacheErr.message);
    }

    // 10. Log Activity
    try {
      await logPulseActivity(sheets, {
        clientName: clientName || parentClient || "Client",
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
      });
    } catch (logErr) {
      console.warn("⚠️ Failed to log confirm-job activity:", logErr.message);
    }

    return res.status(200).json({
      success: true,
      confirmedRow: targetParentRow,
      childRows: confirmedChildRows,
      message: `Successfully confirmed job to row ${targetParentRow}`,
    });
  } catch (err) {
    console.error("❌ /api/portal/confirm-job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
