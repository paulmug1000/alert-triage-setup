import { withRetry } from "./sheetsClient";

export const PROACTIVE_CHECK_LOG_TAB = "ProactiveCheckLog";
export const FLAG_SWEEP_LOG_TAB = "FlagSweepLog";
export const PRECOMPUTE_LOG_TAB = "PrecomputeLog";
export const BUILD_OPTIONS_LOG_TAB = "BuildOptionsLog";

export async function ensureProactiveCheckLogTab(sheets, automationCommanderSheetId) {
  return;
}

export async function logProactiveCheckRun(sheets, automationCommanderSheetId, { clientsChecked, newAlerts, updatedAlerts, dismissedAlerts }) {
  try {
    await ensureProactiveCheckLogTab(sheets, automationCommanderSheetId);
    const nowISO = new Date().toISOString();
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:E`,
      valueInputOption: "RAW",
      requestBody: { values: [[nowISO, clientsChecked || 0, newAlerts || 0, updatedAlerts || 0, dismissedAlerts || 0]] },
    }));
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:A`,
    }));
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 31) {
      const deleteCount = rowCount - 31;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === PROACTIVE_CHECK_LOG_TAB);
      if (sheetMeta) {
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        }));
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log proactive check run: ${err.message}`);
  }
}

export async function readProactiveCheckLog(sheets, automationCommanderSheetId, limit = 10) {
  try {
    await ensureProactiveCheckLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PROACTIVE_CHECK_LOG_TAB}!A:E`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => ({
      runAt: row[0] || "",
      clientsChecked: parseInt(row[1]) || 0,
      newAlerts: parseInt(row[2]) || 0,
      updatedAlerts: parseInt(row[3]) || 0,
      dismissedAlerts: parseInt(row[4]) || 0,
    })).reverse().slice(0, limit);
  } catch (err) {
    console.log(`⚠️ Could not read ${PROACTIVE_CHECK_LOG_TAB}: ${err.message}`);
    return [];
  }
}

export async function ensureFlagSweepLogTab(sheets, automationCommanderSheetId) {
  return;
}

export async function logFlagSweepRun(sheets, automationCommanderSheetId, { clientsChecked, flagsRaised, errors, alertsDelayed, alertsWoken, elapsedSeconds, raisedDetail, isContinuation, categoriesRun }) {
  try {
    await ensureFlagSweepLogTab(sheets, automationCommanderSheetId);

    if (isContinuation) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
      });
      const rows = resp.data.values || [];
      if (rows.length > 1) {
        const lastRowIdx = rows.length;
        const lastRow = rows[rows.length - 1];

        const prevChecked = parseInt(lastRow[1], 10) || 0;
        const prevRaised = parseInt(lastRow[2], 10) || 0;
        const prevErrors = parseInt(lastRow[3], 10) || 0;
        const prevElapsed = parseInt(lastRow[4], 10) || 0;
        let prevDetail = [];
        try { prevDetail = JSON.parse(lastRow[5] || "[]"); } catch (e) {}
        
        const prevDelayed = parseInt(lastRow[7], 10) || 0;
        const prevWoken = parseInt(lastRow[8], 10) || 0;

        await withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: automationCommanderSheetId,
          range: `${FLAG_SWEEP_LOG_TAB}!B${lastRowIdx}:I${lastRowIdx}`,
          valueInputOption: "RAW",
          requestBody: { values: [[
            prevChecked + (clientsChecked || 0),
            prevRaised + (flagsRaised || 0),
            prevErrors + (errors || 0),
            prevElapsed + (elapsedSeconds || 0),
            JSON.stringify(prevDetail.concat(raisedDetail || [])),
            categoriesRun || lastRow[6] || "",
            prevDelayed + (alertsDelayed || 0),
            prevWoken + (alertsWoken || 0)
          ]] },
        }));
        return;
      }
    }

    const nowISO = new Date().toISOString();
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, clientsChecked || 0, flagsRaised || 0, errors || 0, elapsedSeconds || 0,
        JSON.stringify(raisedDetail || []), categoriesRun || "", alertsDelayed || 0, alertsWoken || 0
      ]] },
    }));
    
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:A`,
    });
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === FLAG_SWEEP_LOG_TAB);
      if (sheetMeta) {
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        }));
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log flag sweep run: ${err.message}`);
  }
}

export async function readFlagSweepLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensureFlagSweepLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${FLAG_SWEEP_LOG_TAB}!A:I`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      let raisedDetail = [];
      try { raisedDetail = JSON.parse(row[5] || "[]"); } catch (e) {}
      return {
        runAt: row[0] || "",
        clientsChecked: parseInt(row[1]) || 0,
        flagsRaised: parseInt(row[2]) || 0,
        errors: parseInt(row[3]) || 0,
        elapsedSeconds: parseInt(row[4]) || 0,
        raisedDetail,
        categoriesRun: row[6] || "",
        alertsDelayed: parseInt(row[7]) || 0,
        alertsWoken: parseInt(row[8]) || 0,
      };
    }).reverse().slice(0, limit);
  } catch (err) {
    console.log(`⚠️ Could not read ${FLAG_SWEEP_LOG_TAB}: ${err.message}`);
    return [];
  }
}

export async function ensurePrecomputeLogTab(sheets, automationCommanderSheetId) {
  return;
}

export async function logPrecomputeRun(sheets, automationCommanderSheetId, { clientsWithFlags, totalAlerts, noActionCount, analysisCount, proactiveCount, clientDetail }) {
  try {
    await ensurePrecomputeLogTab(sheets, automationCommanderSheetId);
    const nowISO = new Date().toISOString();
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:G`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, clientsWithFlags || 0, totalAlerts || 0, noActionCount || 0, analysisCount || 0, proactiveCount || 0,
        JSON.stringify(clientDetail || []),
      ]] },
    }));
    
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:A`,
    }));
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === PRECOMPUTE_LOG_TAB);
      if (sheetMeta) {
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        }));
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log precompute run: ${err.message}`);
  }
}

export async function readPrecomputeLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensurePrecomputeLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${PRECOMPUTE_LOG_TAB}!A:G`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      let isOldFormat = false;
      try { if (row[5] && (row[5].startsWith("[") || row[5].startsWith("{"))) isOldFormat = true; } catch(e){}
      
      let clientDetail = [];
      try { clientDetail = JSON.parse(isOldFormat ? (row[5] || "[]") : (row[6] || "[]")); } catch (e) {}
      
      return {
        runAt: row[0] || "",
        clientsWithFlags: parseInt(row[1]) || 0,
        totalAlerts: parseInt(row[2]) || 0,
        noActionCount: parseInt(row[3]) || 0,
        analysisCount: parseInt(row[4]) || 0,
        proactiveCount: isOldFormat ? 0 : (parseInt(row[5]) || 0),
        clientDetail,
      };
    }).reverse().slice(0, limit);
  } catch (err) {
    console.log(`⚠️ Could not read ${PRECOMPUTE_LOG_TAB}: ${err.message}`);
    return [];
  }
}

export async function ensureBuildOptionsLogTab(sheets, automationCommanderSheetId) {
  return;
}

export async function logBuildOptionsRun(sheets, automationCommanderSheetId, { processed, built, notFound, errors, elapsedSeconds, builtDetail, isContinuation }) {
  try {
    await ensureBuildOptionsLogTab(sheets, automationCommanderSheetId);

    if (isContinuation) {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: automationCommanderSheetId,
        range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
      });
      const rows = resp.data.values || [];
      if (rows.length > 1) {
        const lastRowIdx = rows.length;
        const lastRow = rows[rows.length - 1];

        const prevProcessed = parseInt(lastRow[1], 10) || 0;
        const prevBuilt = parseInt(lastRow[2], 10) || 0;
        const prevNotFound = parseInt(lastRow[3], 10) || 0;
        const prevErrors = parseInt(lastRow[4], 10) || 0;
        const prevElapsed = parseInt(lastRow[5], 10) || 0;
        let prevDetail = [];
        try { prevDetail = JSON.parse(lastRow[6] || "[]"); } catch (e) {}

        await withRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: automationCommanderSheetId,
          range: `${BUILD_OPTIONS_LOG_TAB}!B${lastRowIdx}:G${lastRowIdx}`,
          valueInputOption: "RAW",
          requestBody: { values: [[
            Math.max(prevProcessed, processed || 0),
            prevBuilt + (built || 0),
            prevNotFound + (notFound || 0),
            prevErrors + (errors || 0),
            prevElapsed + (elapsedSeconds || 0),
            JSON.stringify(prevDetail.concat(builtDetail || []))
          ]] },
        }));
        return;
      }
    }

    const nowISO = new Date().toISOString();
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        nowISO, processed || 0, built || 0, notFound || 0, errors || 0, elapsedSeconds || 0, JSON.stringify(builtDetail || [])
      ]] },
    }));
    
    const resp = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:A`,
    }));
    const rowCount = (resp.data.values || []).length;
    if (rowCount > 201) {
      const deleteCount = rowCount - 201;
      const meta = await sheets.spreadsheets.get({ spreadsheetId: automationCommanderSheetId, fields: "sheets.properties" });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === BUILD_OPTIONS_LOG_TAB);
      if (sheetMeta) {
        await withRetry(() => sheets.spreadsheets.batchUpdate({
          spreadsheetId: automationCommanderSheetId,
          requestBody: { requests: [{
            deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: "ROWS", startIndex: 1, endIndex: 1 + deleteCount } },
          }] },
        }));
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not log build options run: ${err.message}`);
  }
}

export async function readBuildOptionsLog(sheets, automationCommanderSheetId, limit = 20) {
  try {
    await ensureBuildOptionsLogTab(sheets, automationCommanderSheetId);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: automationCommanderSheetId,
      range: `${BUILD_OPTIONS_LOG_TAB}!A:G`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return [];
    return rows.slice(1).map(row => {
      let builtDetail = [];
      try { builtDetail = JSON.parse(row[6] || "[]"); } catch (e) { }
      return {
        runAt: row[0] || "",
        processed: parseInt(row[1]) || 0,
        built: parseInt(row[2]) || 0,
        notFound: parseInt(row[3]) || 0,
        errors: parseInt(row[4]) || 0,
        elapsedSeconds: parseInt(row[5]) || 0,
        builtDetail,
      };
    }).reverse().slice(0, limit);
  } catch (err) {
    console.log(`⚠️ Could not read ${BUILD_OPTIONS_LOG_TAB}: ${err.message}`);
    return [];
  }
}