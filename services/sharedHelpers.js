import { withRetry } from "./sheetsClient";

export async function getToleranceValues(sheets, masterSheetId) {
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: masterSheetId,
      ranges: ["DataChgAlert!F39", "DataChgAlert!J111", "DataChgAlert!B52"],
    });
    const ranges = response.data.valueRanges || [];
    return {
      invoiceMonthsTolerance: ranges[0]?.values?.[0]?.[0] || 2,
      expenseMonthsTolerance: ranges[1]?.values?.[0]?.[0] || 1,
      defaultDaysToPay:       ranges[2]?.values?.[0]?.[0] || 30,
    };
  } catch (err) {
    console.log("⚠️ Using default tolerance values");
    return {
      invoiceMonthsTolerance: 2,
      expenseMonthsTolerance: 1,
      defaultDaysToPay: 30,
    };
  }
}

export async function getCRMMatchingMode(sheets, masterSheetId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: "CRMComp!B2:B2",
    });
    const mode = response.data.values?.[0]?.[0];
    return mode === "Confirmed" ? "Confirmed" : "Pipeline";
  } catch (err) {
    console.log("⚠️ Defaulting CRM mode to Confirmed");
    return "Confirmed";
  }
}

export async function setMasterSwitch(sheets, spreadsheetId, sheetName, value) {
  if (value === true) {
    try {
      const currentResp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!E2`,
      });
      const currentVal = currentResp.data.values?.[0]?.[0];
      const alreadyOn = (currentVal === true || String(currentVal).toUpperCase() === "TRUE");
      if (alreadyOn) {
        console.log(`  ✅ ${sheetName} switch already ON — skipping write and delay`);
        return;
      }
    } catch(e) {
      console.log(`  ⚠ Could not check ${sheetName} switch state: ${e.message} — proceeding with write`);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!E2`,
      valueInputOption: "RAW",
      requestBody: { values: [[true]] },
    });
    await new Promise(r => setTimeout(r, 1000));
    return;
  }
  console.log(`  ⏭ ${sheetName} switch left ON (permanent mode — not turning off)`);
}

export async function setCRMMode(sheets, spreadsheetId, mode) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "CRMComp!B2",
    valueInputOption: "RAW",
    requestBody: {
      values: [[mode]],
    },
  });
  await new Promise(r => setTimeout(r, 1000));
}

export const GAS_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

export async function checkAllGASLocks(sheets, masterSheetId, cachedData = null) {
  const result = { invoice: { locked: false }, expense: { locked: false }, crm: { locked: false } };
  if (!masterSheetId) return result;
  try {
    let row = [];
    if (cachedData) {
      row = cachedData[0] || [];
    } else {
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId: masterSheetId,
        range: "DataChgAlert!B4:I4",
      }));
      row = (resp.data.values || [[]])[0] || [];
    }
    const check = async (fIdx, tIdx, name, fCell, tCell) => {
      const flag = String(row[fIdx] || "").trim().toUpperCase();
      const tsRaw = row[tIdx];
      if (flag !== "YES") return { locked: false };
      if (tsRaw) {
        const tsDate = new Date(tsRaw);
        if (!isNaN(tsDate) && (Date.now() - tsDate.getTime()) > GAS_LOCK_STALE_MS) {
          console.log(`  ⚠️ GAS lock for ${name} is stale — clearing`);
          try {
            await withRetry(() => sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: masterSheetId,
              requestBody: {
                data: [
                  { range: `DataChgAlert!${fCell}`, values: [["NO"]] },
                  { range: `DataChgAlert!${tCell}`, values: [[""]] },
                ],
                valueInputOption: "RAW"
              }
            }));
          } catch (e) {}
          return { locked: false };
        }
      }
      return { locked: true, message: `The ${name} automation sequence is currently running for this client.` };
    };
    result.invoice = await check(0, 1, "invoice", "B4", "C4");
    result.expense = await check(4, 5, "expense", "F4", "G4");
    result.crm = await check(6, 7, "crm", "H4", "I4");
  } catch (e) {
    console.log(`  ⚠️ Could not read GAS locks: ${e.message} — proceeding anyway`);
  }
  return result;
}

export async function fetchJobRowsForDisplay(sheets, spreadsheetId, tabName, parentRowNum, highlightSlot, sharedData = null) {
  if (!spreadsheetId || !parentRowNum) return null;
  try {
    let rows = [];
    if (sharedData && tabName === "Confirmed" && sharedData.confirmedDataWide) {
      rows = sharedData.confirmedDataWide;
    } else if (sharedData && tabName === "Pipeline" && sharedData.pipelineData) {
      rows = sharedData.pipelineData;
    } else {
      const resp = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}!A1:CR${parentRowNum + 30}`,
        valueRenderOption: "FORMATTED_VALUE",
      }));
      rows = resp.data.values || [];
    }
    const parentRow = rows[parentRowNum - 1] || [];
    const parentClient = String(parentRow[0] || "").trim();
    const parentJob    = String(parentRow[1] || "").trim();
    if (!parentClient && !parentJob) return null;

    const allRows = [{ rowNum: parentRowNum, row: parentRow, isParent: true }];
    for (let i = parentRowNum; i < rows.length; i++) {
      const r = rows[i] || [];
      const rc = String(r[0] || "").trim();
      const rj = String(r[1] || "").trim();
      const rRevenue = String(r[32] || "").trim();
      const rBudget = parseFloat(String(r[33] || "").replace(/[£$€,\s]/g, "")) || 0;
      const rStart = String(r[37] || "").trim();
      if (rc === parentClient && rj === parentJob && !rRevenue && !rBudget && !rStart) {
        allRows.push({ rowNum: i + 1, row: r, isParent: false });
      } else {
        break;
      }
    }

    const colVal = (row, idx) => row[idx] !== undefined ? row[idx] : "";
    const buildRowData = ({ rowNum, row, isParent }) => ({
      rowNum,
      isParent,
      client:        colVal(row, 0),
      jobName:       colVal(row, 1),
      projectCode:   colVal(row, 2),
      unevenSplit:   colVal(row, 30),
      revenue:       colVal(row, 32),
      directCosts:   colVal(row, 33),
      vat:           colVal(row, 34),
      projectRetainer: colVal(row, 35),
      startDate:     colVal(row, 37),
      endDate:       colVal(row, 38),
      likelihood:    tabName === "Pipeline" ? colVal(row, 39) : null,
      copiedToConf:  tabName === "Pipeline" ? colVal(row, 107) : null,
      invoiceSlots: [
        { slotNum: 1, amount: colVal(row,41), ref: colVal(row,42), sentDate: colVal(row,43), daysToPay: colVal(row,44), status: colVal(row,45),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 1 && highlightSlot.rowNum === rowNum },
        { slotNum: 2, amount: colVal(row,48), ref: colVal(row,49), sentDate: colVal(row,50), daysToPay: colVal(row,51), status: colVal(row,52),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 2 && highlightSlot.rowNum === rowNum },
        { slotNum: 3, amount: colVal(row,55), ref: colVal(row,56), sentDate: colVal(row,57), daysToPay: colVal(row,58), status: colVal(row,59),
          highlighted: highlightSlot?.type === "invoice" && highlightSlot.slotNum === 3 && highlightSlot.rowNum === rowNum },
      ],
      expenseSlots: [
        { slotNum: 1, description: colVal(row,75), amount: colVal(row,76), vat: colVal(row,77), date: colVal(row,78), daysToPay: colVal(row,79), status: colVal(row,80), transactionId: colVal(row,81),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 1 && highlightSlot.rowNum === rowNum },
        { slotNum: 2, description: colVal(row,82), amount: colVal(row,83), vat: colVal(row,84), date: colVal(row,85), daysToPay: colVal(row,86), status: colVal(row,87), transactionId: colVal(row,88),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 2 && highlightSlot.rowNum === rowNum },
        { slotNum: 3, description: colVal(row,89), amount: colVal(row,90), vat: colVal(row,91), date: colVal(row,92), daysToPay: colVal(row,93), status: colVal(row,94), transactionId: colVal(row,95),
          highlighted: highlightSlot?.type === "expense" && highlightSlot.slotNum === 3 && highlightSlot.rowNum === rowNum },
      ],
    });

    let resultData = allRows.map(buildRowData);
    
    if (resultData.length > 8) {
      const parent = resultData[0];
      const targetIdx = resultData.findIndex(r => 
        r.invoiceSlots.some(s => s.highlighted) || r.expenseSlots.some(s => s.highlighted)
      );
      
      if (targetIdx > 0) {
        const start = Math.max(1, targetIdx - 2);
        const end = Math.min(resultData.length, targetIdx + 3);
        const subset = resultData.slice(start, end);
        const combined = [parent, ...subset];
        resultData = Array.from(new Map(combined.map(item => [item.rowNum, item])).values());
      } else {
        resultData = resultData.slice(0, 8);
      }
    }
    return resultData;
  } catch (e) {
    console.log(`  ⚠ fetchJobRowsForDisplay error: ${e.message}`);
    return null;
  }
}