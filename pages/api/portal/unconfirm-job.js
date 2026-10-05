import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { verifyUserAuthorizedForSheet } from "../../../services/userPermissions.js";
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

  const { clientSheetId, clientName, confirmedRow } = req.body || {};

  const cRow = parseInt(confirmedRow, 10);
  if (!clientSheetId || isNaN(cRow) || cRow < 2) {
    return res.status(400).json({ success: false, error: "Valid clientSheetId and confirmedRow (>= 2) are required" });
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
    const confirmedSheetObj = sheetMetaList.find(
      (s) => s.properties?.title === "Confirmed" || s.properties?.title === "ConfCalcs"
    );
    const pipelineSheetObj = sheetMetaList.find(
      (s) => s.properties?.title === "Pipeline" || s.properties?.title === "PipeCalcs"
    );

    if (!confirmedSheetObj || !pipelineSheetObj) {
      throw new Error("Could not find Confirmed or Pipeline sheets in the spreadsheet");
    }

    const confirmedSheetName = confirmedSheetObj.properties.title;
    const confirmedSheetId = confirmedSheetObj.properties.sheetId;
    const pipelineSheetName = pipelineSheetObj.properties.title;
    const pipelineSheetId = pipelineSheetObj.properties.sheetId;

    // 2. Read parent row from Confirmed
    const parentResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${confirmedSheetName}!A${cRow}:CZ${cRow}`,
        valueRenderOption: "FORMULA",
      })
    );
    const parentData = parentResp.data?.values?.[0] || [];
    const parentClient = (parentData[0] || "").trim();
    const parentJobName = (parentData[1] || "").trim();
    const parentProjectCode = (parentData[2] || "").trim();
    const parentRevenue = parentData[32]; // Col 33

    if (!parentClient && !parentJobName) {
      throw new Error(`Confirmed row ${cRow} does not contain client or job name`);
    }

    // 3. Find child rows in Confirmed (batch read up to 10 rows below)
    const confirmedChildRows = [];
    const confirmedChildRowsData = [];
    const potentialChildrenResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${confirmedSheetName}!A${cRow + 1}:CZ${cRow + 10}`,
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
        confirmedChildRows.push(cRow + 1 + i);
        confirmedChildRowsData.push(r);
      } else {
        break;
      }
    }

    // 4. Look for existing Pipeline row
    const pipelineDataResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${pipelineSheetName}!A:AG`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );
    const allPipelineRows = pipelineDataResp.data?.values || [];

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
    if (isExistingJob) {
      try {
        const existingLikelihoodResp = await withRetry(() =>
          sheets.spreadsheets.values.get({
            spreadsheetId: clientSheetId,
            range: `${pipelineSheetName}!AN${pipelineRow}`,
            valueRenderOption: "FORMATTED_VALUE",
          })
        );
        const currLikelihood = String(existingLikelihoodResp.data?.values?.[0]?.[0] || "");
        if (!currLikelihood.includes("100") && currLikelihood !== "1" && currLikelihood !== "") {
          targetLikelihood = currLikelihood;
        }
      } catch (e) {
        console.warn("⚠️ Failed reading existing pipeline likelihood:", e.message);
      }
    }

    // Parent row A:AM (cols 1-39, index 0-38)
    const parentA_AM = parentData.slice(0, 39);
    while (parentA_AM.length < 39) parentA_AM.push("");
    if (!isExistingJob) {
      const todayStr = new Date().toISOString().split("T")[0];
      parentA_AM[3] = todayStr;
    }

    pipelineBatchData.push({
      range: `${pipelineSheetName}!A${pipelineRow}:AM${pipelineRow}`,
      values: [parentA_AM],
    });

    pipelineBatchData.push({
      range: `${pipelineSheetName}!AN${pipelineRow}`,
      values: [[targetLikelihood]],
    });

    // Parent row AP:BH (cols 42-60, index 41-59)
    const parentAP_BH = parentData.slice(41, 60);
    while (parentAP_BH.length < 19) parentAP_BH.push("");
    pipelineBatchData.push({
      range: `${pipelineSheetName}!AP${pipelineRow}:BH${pipelineRow}`,
      values: [parentAP_BH],
    });

    // Parent row BX:CR (cols 76-96, index 75-95)
    const parentBX_CR = parentData.slice(75, 96);
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

      const childA_AM = childData.slice(0, 39);
      while (childA_AM.length < 39) childA_AM.push("");
      childA_AM[0] = parentClient;
      childA_AM[1] = parentJobName;
      childA_AM[3] = "";
      childA_AM[32] = ""; // Blank revenue
      childA_AM[33] = ""; // Blank direct costs

      pipelineBatchData.push({
        range: `${pipelineSheetName}!A${targetChildRow}:AM${targetChildRow}`,
        values: [childA_AM],
      });

      pipelineBatchData.push({
        range: `${pipelineSheetName}!AN${targetChildRow}`,
        values: [[""]],
      });

      const childAP_BH = childData.slice(41, 60);
      while (childAP_BH.length < 19) childAP_BH.push("");
      pipelineBatchData.push({
        range: `${pipelineSheetName}!AP${targetChildRow}:BH${targetChildRow}`,
        values: [childAP_BH],
      });

      const childBX_CR = childData.slice(75, 96);
      while (childBX_CR.length < 21) childBX_CR.push("");
      pipelineBatchData.push({
        range: `${pipelineSheetName}!BX${targetChildRow}:CR${targetChildRow}`,
        values: [childBX_CR],
      });

      pipelineChildRows.push(targetChildRow);
    }

    await withRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: clientSheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: pipelineBatchData,
        },
      })
    );

    // Group child rows in Pipeline sheet
    if (pipelineChildRows.length > 0) {
      try {
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
          const deleteReqs = overlappingGroups.map((g) => ({
            deleteDimensionGroup: {
              range: {
                sheetId: pipelineSheetId,
                dimension: "ROWS",
                startIndex: g.range.startIndex,
                endIndex: g.range.endIndex,
              },
            },
          }));

          const addReq = {
            addDimensionGroup: {
              range: {
                sheetId: pipelineSheetId,
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
        console.warn("⚠️ Grouping child rows in Pipeline warning (non-fatal):", groupErr.message);
      }
    }

    // 7. Clear data from Confirmed sheet
    // Safe ranges: A:AM (1-39), AP:BH (42-60), BX:CR (76-96)
    const clearRowRanges = [cRow, ...confirmedChildRows];
    for (const r of clearRowRanges) {
      await withRetry(() =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: clientSheetId,
          requestBody: {
            ranges: [
              `${confirmedSheetName}!A${r}:AM${r}`,
              `${confirmedSheetName}!AP${r}:BH${r}`,
              `${confirmedSheetName}!BX${r}:CR${r}`,
            ],
          },
        })
      );
    }

    // If Confirmed had a dimension group for the child rows, remove it
    if (confirmedChildRows.length > 0) {
      try {
        const childStartIndex = confirmedChildRows[0] - 1;
        const childEndIndex = confirmedChildRows[confirmedChildRows.length - 1];
        const existingConfGroups = confirmedSheetObj.rowGroups || [];
        const groupToDelete = existingConfGroups.find(
          (g) => g.range?.startIndex <= childStartIndex && g.range?.endIndex >= childEndIndex
        );
        if (groupToDelete) {
          await withRetry(() =>
            sheets.spreadsheets.batchUpdate({
              spreadsheetId: clientSheetId,
              requestBody: {
                requests: [
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
                ],
              },
            })
          );
        }
      } catch (delGroupErr) {
        console.warn("⚠️ Delete dimension group in Confirmed warning (non-fatal):", delGroupErr.message);
      }
    }

    // 8. Invalidate In-Memory and Redis caches
    memoryCache.del(`pulse:portal:*:${clientSheetId}*`);
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Redis invalidation warning:", cacheErr.message);
    }

    // 9. Log Activity
    try {
      await logPulseActivity(sheets, {
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
      });
    } catch (logErr) {
      console.warn("⚠️ Failed to log unconfirm-job activity:", logErr.message);
    }

    return res.status(200).json({
      success: true,
      pipelineRow,
      childRows: pipelineChildRows,
      message: `Successfully moved job to Pipeline row ${pipelineRow}`,
    });
  } catch (err) {
    console.error("❌ /api/portal/unconfirm-job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
