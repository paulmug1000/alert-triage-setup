/**
 * ============================================================================
 * RECON TAB SERVICE (services/reconTabService.js)
 * ============================================================================
 * 
 * Manages the lifecycle of monthly reconciliation tabs (e.g., '2610') in client
 * Recon Google Sheets.
 * 
 * Features:
 * - Checks if a target month tab exists in the client's Recon Sheet.
 * - Copies the 'Template' tab, moves it to position 0 (far left), and names it YYMM.
 * - Formats cell A1 as "mmm yy" (e.g., "Oct 26").
 * - Scheduled on or after the 20th of each month (e.g. on 20th Oct creates 2610
 *   for the upcoming Nov cashflow recon cycle).
 * - Fully idempotent (skips if tab already exists).
 */

import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient.js";
import { logPmaActivity } from "./pmaLogger.js";

/**
 * Returns month formatting strings for a given date.
 * E.g., for October 2026:
 * targetCode: "2610"
 * targetLabel: "Oct 26"
 * rawDateStr: "2026-10-01"
 */
export function getReconMonthInfo(dateInput = new Date(), explicitTabName = null) {
  if (explicitTabName && /^\d{4}$/.test(explicitTabName)) {
    const yy = explicitTabName.slice(0, 2);
    const mm = explicitTabName.slice(2, 4);
    const year = 2000 + parseInt(yy, 10);
    const month = parseInt(mm, 10); // 1-12
    const monthNamesShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const targetLabel = `${monthNamesShort[month - 1] || "Mon"} ${yy}`;
    const rawDate = new Date(Date.UTC(year, month - 1, 1));
    return {
      year,
      month,
      targetCode: explicitTabName,
      targetLabel,
      rawDate,
      firstDayIso: `${year}-${mm}-01`
    };
  }

  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const year = isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  const month = isNaN(d.getTime()) ? new Date().getMonth() : d.getMonth(); // 0-indexed (0 = Jan, 9 = Oct)

  const yy = String(year).slice(-2);
  const mm = String(month + 1).padStart(2, "0");
  const targetCode = `${yy}${mm}`;

  const monthNamesShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const targetLabel = `${monthNamesShort[month]} ${yy}`;
  const rawDate = new Date(Date.UTC(year, month, 1));

  return {
    year,
    month: month + 1,
    targetCode,
    targetLabel,
    rawDate,
    firstDayIso: `${year}-${mm}-01`
  };
}

/**
 * Ensures that a target month tab (e.g., '2610') exists in the client's Recon Sheet.
 * If not present, duplicates the 'Template' tab, renames it, moves it to index 0,
 * and sets cell A1 to the month date.
 */
export async function ensureReconTabExists({
  reconSheetId,
  reconSheetUrl,
  targetDateInput = new Date(),
  tabName = null,
  targetTabName = null,
  clientName = "Client",
  accountingPlatform = null
}) {
  const cleanId = reconSheetId || extractSheetIdFromUrl(reconSheetUrl);
  if (!cleanId) {
    throw new Error(`Missing reconSheetId for ${clientName}`);
  }

  const sheets = await getSheetsClient();
  const explicitTab = tabName || targetTabName;
  const monthInfo = getReconMonthInfo(targetDateInput, explicitTab);
  const { targetCode, rawDate } = monthInfo;

  // 1. Fetch spreadsheet metadata to check existing tabs
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cleanId,
    fields: "properties.title,sheets(properties(sheetId,title,index))"
  }));

  const allSheets = meta.data.sheets || [];
  const existingTarget = allSheets.find(s => s.properties.title === targetCode);

  if (existingTarget) {
    return {
      success: true,
      alreadyExists: true,
      created: false,
      tabName: targetCode,
      sheetId: existingTarget.properties.sheetId,
      clientName
    };
  }

  // 2. Find 'Template' tab
  const templateTab = allSheets.find(s => s.properties.title === "Template");
  if (!templateTab) {
    throw new Error(`Template tab 'Template' not found in Recon Sheet (${cleanId}) for ${clientName}`);
  }

  // 3. Duplicate 'Template' tab
  let newSheetId = null;
  try {
    const copyRes = await withRetry(() => sheets.spreadsheets.sheets.copyTo({
      spreadsheetId: cleanId,
      sheetId: templateTab.properties.sheetId,
      requestBody: {
        destinationSpreadsheetId: cleanId
      }
    }));
    newSheetId = copyRes.data.sheetId;
  } catch (copyErr) {
    console.warn(`[reconTabService] copyTo encountered transient error for ${targetCode}, checking if tab was created asynchronously:`, copyErr.message);
    // Poll up to 3 times with 4s delay to see if tab was created in background
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise(r => setTimeout(r, 4000));
      const verifyMeta = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: cleanId,
        fields: "sheets(properties(sheetId,title))"
      })).catch(() => null);
      const vSheets = verifyMeta?.data?.sheets || [];
      const foundTarget = vSheets.find(s => s.properties.title === targetCode);
      if (foundTarget) {
        return {
          success: true,
          created: true,
          tabName: targetCode,
          sheetId: foundTarget.properties.sheetId,
          clientName
        };
      }
      const foundCopy = vSheets.find(s => s.properties.title.toLowerCase().includes("copy of template"));
      if (foundCopy) {
        newSheetId = foundCopy.properties.sheetId;
        break;
      }
    }
    if (!newSheetId) {
      throw copyErr;
    }
  }

  // 4. Rename to targetCode, move to index 0 (far left)
  try {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: cleanId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: newSheetId,
                title: targetCode,
                index: 0
              },
              fields: "title,index"
            }
          }
        ]
      }
    }));
  } catch (renameErr) {
    console.warn(`[reconTabService] Rename batchUpdate error, verifying if title updated:`, renameErr.message);
    await new Promise(r => setTimeout(r, 3000));
    const verifyMeta = await withRetry(() => sheets.spreadsheets.get({
      spreadsheetId: cleanId,
      fields: "sheets(properties(sheetId,title))"
    })).catch(() => null);
    const foundTarget = (verifyMeta?.data?.sheets || []).find(s => s.properties.title === targetCode);
    if (!foundTarget) {
      throw renameErr;
    }
  }

  // 5. Set cell A1 to the target month date formatted as "mmm yy"
  const serialDateDays = Math.floor((rawDate.getTime() - new Date(Date.UTC(1899, 11, 30)).getTime()) / 86400000);

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cleanId,
    requestBody: {
      requests: [
        {
          updateCells: {
            range: {
              sheetId: newSheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 1
            },
            rows: [
              {
                values: [
                  {
                    userEnteredValue: {
                      numberValue: serialDateDays
                    },
                    userEnteredFormat: {
                      numberFormat: {
                        type: "DATE",
                        pattern: "mmm yy"
                      }
                    }
                  }
                ]
              }
            ],
            fields: "userEnteredValue,userEnteredFormat.numberFormat"
          }
        }
      ]
    }
  }));

  if (accountingPlatform) {
    const cleanPlatform = accountingPlatform.toLowerCase().includes("quick") ? "Quickbooks" : "Xero";
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: cleanId,
      range: `'${targetCode}'!DA1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[cleanPlatform]] }
    })).catch(e => console.warn("Failed to set DA1 on new tab:", e.message));
  }

  console.log(`✓ Provisioned new Recon tab '${targetCode}' for ${clientName} (Sheet: ${cleanId})`);

  return {
    success: true,
    alreadyExists: false,
    created: true,
    tabName: targetCode,
    sheetId: newSheetId,
    clientName
  };
}

/**
 * Auto-provisions the current month's recon tab for ALL active clients that have a Recon Sheet configured.
 * Intended to run on or after the 20th of each calendar month.
 */
export async function autoProvisionAllReconTabs({
  automationCommanderSheetId = "12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M",
  targetDateInput = new Date()
} = {}) {
  const sheets = await getSheetsClient();
  const monthInfo = getReconMonthInfo(targetDateInput);

  // Read clients from AutoUpdates sheet
  const resp = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: automationCommanderSheetId,
    range: "AutoUpdates!A3:J50"
  }));

  const rows = resp.data.values || [];
  const results = [];

  for (const row of rows) {
    const clientName = String(row[0] || "").trim();
    const reconSheetUrl = String(row[9] || "").trim();

    if (!clientName || !reconSheetUrl) continue;

    const reconSheetId = extractSheetIdFromUrl(reconSheetUrl);
    if (!reconSheetId) continue;

    try {
      const res = await ensureReconTabExists({
        reconSheetId,
        reconSheetUrl,
        targetDateInput,
        clientName
      });
      results.push(res);

      if (res.created) {
        await logPmaActivity({
          clientName,
          action: "auto_create_recon_tab",
          details: `Provisioned monthly recon tab '${monthInfo.targetCode}' in Recon Sheet`,
          status: "success",
          source: "cron"
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`❌ Failed to provision recon tab for ${clientName}:`, err.message);
      results.push({
        clientName,
        tabName: monthInfo.targetCode,
        created: false,
        alreadyExists: false,
        error: err.message
      });
    }
  }

  return {
    success: true,
    targetCode: monthInfo.targetCode,
    targetLabel: monthInfo.targetLabel,
    totalClients: results.length,
    createdCount: results.filter(r => r.created).length,
    alreadyExistsCount: results.filter(r => r.alreadyExists).length,
    errorCount: results.filter(r => r.error).length,
    results
  };
}
