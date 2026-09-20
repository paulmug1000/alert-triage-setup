import { getSheetsClient, withRetry, extractSheetIdFromUrl } from "./sheetsClient";
import { redisClient } from "./redisClient";
import { anthropic } from "./claudeClient";
import { logClaudeUsage_ } from "./systemConfig";
import { monthStrToEomKey_, eomTargetMonthToWorkMonth_, autoCompleteLinkedEomTask_ } from "./eomTools";

const CLIENT_NAME_NOISE_WORDS_ = new Set([
  "ltd","limited","plc","inc","llc","llp","the","and","&",
  "group","co","corp","corporation","holdings","international",
  "uk","us","solutions","services","consulting","consultancy",
]);

function isDateMatchJs_(sheetHeader, aiDate) {
  if (!sheetHeader || !aiDate) return false;
  const s1 = String(sheetHeader).toLowerCase();
  const s2 = String(aiDate).toLowerCase();
  if (s1 === s2) return true;
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const m1 = months.find(m => s1.includes(m));
  const m2 = months.find(m => s2.includes(m));
  const y1 = s1.match(/\d{2,4}/);
  const y2 = s2.match(/\d{2,4}/);
  if (m1 && m2 && m1 === m2) {
    if (!y1 || !y2) return true;
    const year1 = y1[0].length === 2 ? "20" + y1[0] : y1[0];
    const year2 = y2[0].length === 2 ? "20" + y2[0] : y2[0];
    return year1 === year2;
  }
  return false;
}

function columnIndexToLetter_(colNum1Indexed) {
  let s = "";
  let n = colNum1Indexed;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normClientWords_(s) {
  return String(s || "").toLowerCase()
    .replace(/['\-.,()]/g, " ").replace(/\s+/g, " ").trim().split(" ")
    .filter(w => w.length > 1 && !CLIENT_NAME_NOISE_WORDS_.has(w));
}

function normalizeForMatch_(s) {
  return String(s || "").toLowerCase()
    .replace(/\b(ltd|limited|llp|plc|inc|group)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function findClientByNameMatch_(candidateText, allClients) {
  const candidateWords = normClientWords_(candidateText);
  if (candidateWords.length === 0) return { matched: null, candidates: [] };
  const candidateJoined = candidateWords.join(" ");
  const matches = [];
  for (const client of allClients) {
    const clientWords = normClientWords_(client.clientName);
    if (clientWords.length === 0) continue;
    const clientJoined = clientWords.join(" ");
    if (candidateJoined.includes(clientJoined) || clientJoined.includes(candidateJoined)) {
      matches.push(client.clientName);
      continue;
    }
    const overlapCount = candidateWords.filter(w => clientWords.includes(w)).length;
    if (overlapCount >= 2 || (overlapCount === 1 && candidateWords[0] === clientWords[0] && candidateWords[0].length >= 4)) {
      matches.push(client.clientName);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length === 1) return { matched: unique[0], candidates: unique };
  return { matched: null, candidates: unique };
}

async function scoreClientsByEmployeeOverlap_(sheets, allClients, extractedEmployeeNames, sheetIdField = "clientSheetId", range = "Salaries!A4:A53") {
  const normalizedExtracted = extractedEmployeeNames.map(n => normalizeForMatch_(n)).filter(Boolean);
  if (normalizedExtracted.length === 0) return { matched: null, scores: [] };
  const scores = [];
  for (const client of allClients) {
    const sheetId = client[sheetIdField];
    if (!sheetId) continue;
    try {
      const resp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range }));
      const sheetNames = (resp.data.values || []).map(r => normalizeForMatch_(r[0])).filter(Boolean);
      if (sheetNames.length > 0) {
        let overlap = 0;
        for (const en of normalizedExtracted) {
          if (sheetNames.some(sn => sn === en)) overlap++;
        }
        if (overlap > 0) scores.push({ clientName: client.clientName, overlap });
      }
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  scores.sort((a, b) => b.overlap - a.overlap);
  if (scores.length === 0) return { matched: null, scores: [] };
  const top = scores[0];
  const second = scores[1];
  const minAbsolute = Math.min(2, normalizedExtracted.length);
  const clearsMinimum = top.overlap >= minAbsolute && top.overlap >= normalizedExtracted.length * 0.4;
  const beatsRunnerUp = !second || top.overlap > second.overlap * 1.5 || (top.overlap - (second?.overlap || 0)) >= 2;
  const confident = clearsMinimum && beatsRunnerUp;
  return { matched: confident ? top.clientName : null, scores: scores.slice(0, 5) };
}

function parseCsvSimple_(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function buildVerticalCsvText_(csvText) {
  let cleanData = "";
  try {
    const rows = parseCsvSimple_(csvText);
    if (rows.length > 1) {
      let headerIndex = 0;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const populatedCols = rows[i].filter(c => c && c.trim() !== "");
        if (populatedCols.length > 2) { headerIndex = i; break; }
      }
      const headers = rows[headerIndex].map(h => (h || "").trim());
      for (let i = headerIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        let rowText = "---\n";
        for (let j = 0; j < headers.length; j++) {
          let val = row[j] ? row[j].trim() : "";
          if (val === "" || val === "NaN") val = "0";
          rowText += `${headers[j]}: ${val}\n`;
        }
        cleanData += rowText;
      }
    }
  } catch (e) {}
  return cleanData;
}

async function writePayrollDataToSheet_(sheets, clientSheetId, extractedData, targetMonthStr, allEmployeeNames) {
  const headerResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: clientSheetId, range: "Salaries!1:1" }));
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  let startColIdx0 = -1;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] && isDateMatchJs_(headers[i], targetMonthStr)) { startColIdx0 = i; break; }
  }
  if (startColIdx0 === -1) return { writeSuccess: false, error: `Could not find column for '${targetMonthStr}' in the Salaries header row.` };
  const startColLetter = columnIndexToLetter_(startColIdx0 + 1);
  const endColLetter = columnIndexToLetter_(startColIdx0 + 7);

  const sheetNames = allEmployeeNames;
  const namesFoundInDoc = extractedData.employees.filter(e => e.mappedName !== "NEW_STARTER").map(e => e.mappedName);
  const missingFromDoc = sheetNames.filter(n => n && !namesFoundInDoc.includes(n));
  const newStarters = extractedData.employees.filter(e => e.mappedName === "NEW_STARTER").map(e => e.originalName);
  const unmatched = [];

  const writeData = [];
  const writtenTotals = { grossPay: 0, eeNic: 0, erNic: 0, studLoan: 0, eePension: 0, erPension: 0, paye: 0 };
  let updateCount = 0;

  for (const emp of extractedData.employees) {
    if (emp.mappedName === "NEW_STARTER") continue;
    const rowIdx = sheetNames.indexOf(emp.mappedName);
    if (rowIdx === -1) { unmatched.push(emp.originalName); continue; }
    const sheetRow = rowIdx + 4;
    const vals = [emp.grossPay||0, emp.eeNic||0, emp.erNic||0, emp.studLoan||0, emp.eePension||0, emp.erPension||0, emp.paye||0];
    writeData.push({ range: `Salaries!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`, values: [vals] });
    writtenTotals.grossPay += vals[0]; writtenTotals.eeNic += vals[1]; writtenTotals.erNic += vals[2];
    writtenTotals.studLoan += vals[3]; writtenTotals.eePension += vals[4]; writtenTotals.erPension += vals[5]; writtenTotals.paye += vals[6];
    updateCount++;
  }

  if (writeData.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({ spreadsheetId: clientSheetId, requestBody: { data: writeData, valueInputOption: "RAW" } }));
  }

  const docTotals = extractedData.totals || {};
  const totalsSource = extractedData.totalsSource === "document" ? "document" : "calculated";
  const TOLERANCE = 1.00;
  const categories = ["grossPay","eeNic","erNic","studLoan","eePension","erPension","paye"];
  const totalsCheck = categories.map(cat => {
    const docVal = parseFloat(docTotals[cat]) || 0;
    const writtenVal = Math.round(writtenTotals[cat] * 100) / 100;
    const diff = Math.round(Math.abs(docVal - writtenVal) * 100) / 100;
    return { category: cat, documentTotal: docVal, writtenTotal: writtenVal, diff, reconciled: diff <= TOLERANCE };
  });

  return { writeSuccess: true, updateCount, targetMonthStr, startCol: startColLetter, missingFromDoc, newStarters, unmatched, totalsSource, totalsCheck };
}

async function writeTimeDataToSheet_(sheets, masterSheetId, extractedData, targetMonthStr, allEmployeeNames) {
  const headerResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: masterSheetId, range: "TimeComp!4:4" }));
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  let startColIdx0 = -1;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] && isDateMatchJs_(headers[i], targetMonthStr)) { startColIdx0 = i; break; }
  }
  if (startColIdx0 === -1) return { writeSuccess: false, error: `Could not find column for '${targetMonthStr}' in TimeComp header.` };
  const startColLetter = columnIndexToLetter_(startColIdx0 + 1);
  const endColLetter = columnIndexToLetter_(startColIdx0 + 2);

  const sheetNames = allEmployeeNames;
  const namesFoundInDoc = extractedData.employees.filter(e => e.mappedName !== "NEW_STARTER").map(e => e.mappedName);
  const missingFromDoc = sheetNames.filter(n => n && !namesFoundInDoc.includes(n));
  const newStarters = extractedData.employees.filter(e => e.mappedName === "NEW_STARTER").map(e => e.originalName);
  const unmatched = [];

  const writeData = [];
  let updateCount = 0;

  for (const emp of extractedData.employees) {
    if (emp.mappedName === "NEW_STARTER") continue;
    const rowIdx = sheetNames.indexOf(emp.mappedName);
    if (rowIdx === -1) { unmatched.push(emp.originalName); continue; }
    const sheetRow = rowIdx + 12;
    const vals = [emp.billableHrs || 0, emp.totalHrs || 0];
    writeData.push({ range: `TimeComp!${startColLetter}${sheetRow}:${endColLetter}${sheetRow}`, values: [vals] });
    updateCount++;
  }

  if (writeData.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({ spreadsheetId: masterSheetId, requestBody: { data: writeData, valueInputOption: "USER_ENTERED" } }));
  }
  return { writeSuccess: true, updateCount, targetMonthStr, startCol: startColLetter, missingFromDoc, newStarters, unmatched };
}

export async function handleUploadPayrollChunk(req, res) {
  const { uploadId, chunkData, isFirstChunk } = req.body;
  if (!uploadId || chunkData === undefined) return res.status(400).json({ success: false, error: "Missing uploadId or chunkData" });
  try {
    const key = `payroll_upload:${uploadId}`;
    if (isFirstChunk) {
      await redisClient.set(key, chunkData, { EX: 3600 }); 
    } else {
      await redisClient.append(key, chunkData);
      await redisClient.expire(key, 3600); 
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleIdentifyPayrollClient(req, res, sheets) {
  const { uploadId, fileName, automationCommanderSheetId: idAcId } = req.body;
  if (!uploadId || !idAcId) return res.status(400).json({ success: false, error: "Missing uploadId or acId" });
  let fileData;
  try {
    const raw = await redisClient.get(`payroll_upload:${uploadId}`);
    if (!raw) throw new Error("Upload not found or expired");
    fileData = JSON.parse(raw);
    if (!fileData || !fileData.data || !fileData.type) throw new Error("Payload malformed");
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  try {
    const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: idAcId, range: "AutoUpdates!A2:N500" });
    const allClients = (clientResp.data.values || []).map(r => ({
      clientName: String(r[0] || "").trim(), clientSheetId: extractSheetIdFromUrl(r[11]) || String(r[11]).trim()
    })).filter(c => c.clientName && c.clientSheetId && c.clientName.toLowerCase() !== "client");

    if (fileName) {
      const fnMatch = findClientByNameMatch_(fileName, allClients);
      if (fnMatch.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: fnMatch.matched, method: "filename" });
    }

    const promptText = `Look at this document. Extract:
1. Any employer/company name that appears on it (the business the payroll is FOR), if visible. If not visible, use "".
2. Every employee/person name visible on the document, exactly as written.
Return ONLY valid JSON, no other text: { "employerName": "", "employeeNames": ["..."] }`;

    let idContent;
    if (fileData.type === "text") {
      idContent = promptText + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
    } else if (fileData.type === "image_array") {
      idContent = fileData.data.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
      idContent.push({ type: "text", text: promptText });
    } else {
      idContent = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } }, { type: "text", text: promptText }];
    }
    const idMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: idContent }] });
    await logClaudeUsage_(sheets, idAcId, "", "payroll_identify", idMsg.usage?.input_tokens || 0, idMsg.usage?.output_tokens || 0, "payroll_tool").catch(() => {});

    const idRaw = idMsg.content[0].type === "text" ? idMsg.content[0].text : "";
    const idClean = idRaw.replace(new RegExp("```json", "g"), "").replace(new RegExp("```", "g"), "").trim();
    let idData;
    try { idData = JSON.parse(idClean.slice(idClean.indexOf("{"), idClean.lastIndexOf("}") + 1)); } catch (e) { idData = { employerName: "", employeeNames: [] }; }

    if (idData.employerName) {
      const empMatch = findClientByNameMatch_(idData.employerName, allClients);
      if (empMatch.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: empMatch.matched, method: "document_name" });
    }
    const employeeNames = Array.isArray(idData.employeeNames) ? idData.employeeNames : [];
    if (employeeNames.length > 0) {
      const overlapResult = await scoreClientsByEmployeeOverlap_(sheets, allClients, employeeNames);
      if (overlapResult.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: overlapResult.matched, method: "employee_overlap", scores: overlapResult.scores });
      return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName, employeeNames, candidateScores: overlapResult.scores });
    }
    return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName || "", employeeNames: [], candidateScores: [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleIdentifyTimeClient(req, res, sheets) {
  const { uploadId, fileName, automationCommanderSheetId: idAcId } = req.body;
  if (!uploadId || !idAcId) return res.status(400).json({ success: false, error: "Missing uploadId or acId" });
  let fileData;
  try {
    const raw = await redisClient.get(`payroll_upload:${uploadId}`);
    if (!raw) throw new Error("Upload not found or expired");
    fileData = JSON.parse(raw);
    if (!fileData || !fileData.data || !fileData.type) throw new Error("Payload malformed");
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  try {
    const clientResp = await sheets.spreadsheets.values.get({ spreadsheetId: idAcId, range: "AutoUpdates!A2:N500" });
    const allClients = (clientResp.data.values || []).map(r => ({
      clientName: String(r[0] || "").trim(), masterSheetId: extractSheetIdFromUrl(r[12]) || String(r[12]).trim()
    })).filter(c => c.clientName && c.masterSheetId && c.clientName.toLowerCase() !== "client");

    if (fileName) {
      const fnMatch = findClientByNameMatch_(fileName, allClients);
      if (fnMatch.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: fnMatch.matched, method: "filename" });
    }

    const promptText = `Look at this document. Extract:
1. Any employer/company name that appears on it (the business the time report is FOR), if visible. If not visible, use "".
2. Every employee/person name visible on the document, exactly as written.
Return ONLY valid JSON, no other text: { "employerName": "", "employeeNames": ["..."] }`;

    let idContent;
    if (fileData.type === "text") {
      idContent = promptText + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
    } else if (fileData.type === "image_array") {
      idContent = fileData.data.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
      idContent.push({ type: "text", text: promptText });
    } else {
      idContent = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } }, { type: "text", text: promptText }];
    }
    const idMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: idContent }] });
    await logClaudeUsage_(sheets, idAcId, "", "time_identify", idMsg.usage?.input_tokens || 0, idMsg.usage?.output_tokens || 0, "time_tool").catch(() => {});

    const idRaw = idMsg.content[0].type === "text" ? idMsg.content[0].text : "";
    const idClean = idRaw.replace(new RegExp("```json", "g"), "").replace(new RegExp("```", "g"), "").trim();
    let idData;
    try { idData = JSON.parse(idClean.slice(idClean.indexOf("{"), idClean.lastIndexOf("}") + 1)); } catch (e) { idData = { employerName: "", employeeNames: [] }; }

    if (idData.employerName) {
      const empMatch = findClientByNameMatch_(idData.employerName, allClients);
      if (empMatch.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: empMatch.matched, method: "document_name" });
    }
    const employeeNames = Array.isArray(idData.employeeNames) ? idData.employeeNames : [];
    if (employeeNames.length > 0) {
      const overlapResult = await scoreClientsByEmployeeOverlap_(sheets, allClients, employeeNames, "masterSheetId", "TimeComp!A12:A62");
      if (overlapResult.matched) return res.status(200).json({ success: true, status: "MATCHED", clientName: overlapResult.matched, method: "employee_overlap", scores: overlapResult.scores });
      return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName, employeeNames, candidateScores: overlapResult.scores });
    }
    return res.status(200).json({ success: true, status: "AMBIGUOUS", employerName: idData.employerName || "", employeeNames: [], candidateScores: [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleProcessPayrollDocument(req, res, sheets) {
  const { clientSheetId: payrollClientSheetId, clientName: payrollClientName, uploadId, confirmedMonth, automationCommanderSheetId } = req.body;
  if (!payrollClientSheetId || !uploadId) return res.status(400).json({ success: false, error: "Missing required fields" });
  let fileData;
  try {
    const raw = await redisClient.get(`payroll_upload:${uploadId}`);
    if (!raw) throw new Error("Upload not found or expired");
    fileData = JSON.parse(raw);
    if (!fileData || !fileData.data || !fileData.type) throw new Error("Payload malformed");
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  try {
    const empResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: payrollClientSheetId, range: "Salaries!A4:A53" }));
    const allEmployeeNames = (empResp.data.values || []).map(r => String(r[0] || "").trim());
    const validEmployeeNames = allEmployeeNames.filter(Boolean);
    const namesString = JSON.stringify(validEmployeeNames);
    const currentDateContext = new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    const filenameContext = fileData.fileName ? `\nDocument Filename: "${fileData.fileName}"` : "";

    const promptText = `You are a payroll data extraction assistant. Analyze this payroll document.${filenameContext}
TASK 1: Identify the Period. Look for month/year. Output format: "MMM YYYY" (e.g. "Jan 2026").
- CRITICAL DATE HANDLING: The current real-world date context is ${currentDateContext}. Output the most recent instance of the month relative to this date.
TASK 2: Extract Employee Data visible ON THE DOCUMENT.
- Extract each person exactly ONCE.
- Match each name to the closest name in this list: ${namesString}. If NO MATCH, set mappedName to "NEW_STARTER".
- Do NOT perform math. Extract exact numbers.
TASK 3: Totals. Extract from summary row ("document") or sum yourself ("calculated").
Return ONLY valid JSON: { "period": "MMM YYYY", "employees": [...], "totalsSource": "", "totals": {...} }`;

    let content;
    if (fileData.type === "text") {
      content = promptText + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
    } else if (fileData.type === "image_array") {
      content = fileData.data.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
      content.push({ type: "text", text: promptText });
    } else {
      content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } }, { type: "text", text: promptText }];
    }

    const aiMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, messages: [{ role: "user", content }] });
    await logClaudeUsage_(sheets, automationCommanderSheetId, payrollClientName || "", "payroll_extract", aiMsg.usage?.input_tokens || 0, aiMsg.usage?.output_tokens || 0, "payroll_tool").catch(() => {});

    const rawText = aiMsg.content[0].type === "text" ? aiMsg.content[0].text : "";
    const cleanText = rawText.replace(new RegExp("```json", "g"), "").replace(new RegExp("```", "g"), "").trim();
    let extractedData;
    try { extractedData = JSON.parse(cleanText.slice(cleanText.indexOf("{"), cleanText.lastIndexOf("}") + 1)); } catch (e) {
      return res.status(500).json({ success: false, error: "AI generated malformed JSON" });
    }

    const targetMonthStr = confirmedMonth || extractedData.period;
    if (!targetMonthStr || String(targetMonthStr).toLowerCase() === "unknown" || String(targetMonthStr).toLowerCase() === "null") {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return res.status(200).json({ success: true, status: "CONFIRM_PERIOD", extractedData, fallback: `${months[d.getMonth()]} ${d.getFullYear()}` });
    }

    const writeResult = await writePayrollDataToSheet_(sheets, payrollClientSheetId, extractedData, targetMonthStr, allEmployeeNames);
    await redisClient.del(`payroll_upload:${uploadId}`).catch(() => {});

    if (writeResult.writeSuccess && automationCommanderSheetId) {
      const payrollWorkMonthKey = eomTargetMonthToWorkMonth_(monthStrToEomKey_(targetMonthStr));
      await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, payrollClientName, "salaries", payrollWorkMonthKey);
    }
    return res.status(200).json({ success: true, status: "COMPLETE", extractedData, ...writeResult });
  } catch (err) {
    await redisClient.del(`payroll_upload:${uploadId}`).catch(() => {});
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleProcessTimeDocument(req, res, sheets) {
  const { masterSheetId: timeMasterSheetId, clientName: timeClientName, uploadId, confirmedMonth, automationCommanderSheetId } = req.body;
  if (!timeMasterSheetId || !uploadId) return res.status(400).json({ success: false, error: "Missing required fields" });
  let fileData;
  try {
    const raw = await redisClient.get(`payroll_upload:${uploadId}`);
    if (!raw) throw new Error("Upload not found or expired");
    fileData = JSON.parse(raw);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  try {
    const empResp = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: timeMasterSheetId, range: "TimeComp!A12:A62" }));
    const allEmployeeNames = (empResp.data.values || []).map(r => String(r[0] || "").trim());
    const validEmployeeNames = allEmployeeNames.filter(Boolean);
    const namesString = JSON.stringify(validEmployeeNames);
    const currentDateContext = new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    const filenameContext = fileData.fileName ? `\nDocument Filename: "${fileData.fileName}"` : "";

    const promptText = `You are a time-tracking data extraction assistant. Analyze this document.${filenameContext}
TASK 1: Identify the Period (Month/Year). Output format: "MMM YYYY". Context date is ${currentDateContext}.
TASK 2: Extract Employee Data visible ON THE DOCUMENT. Match names to this list: ${namesString}.
TASK 3: Extract Hours. Map concepts to 'billableHrs' and 'totalHrs'.
Return ONLY valid JSON: { "period": "MMM YYYY", "employees": [{ "originalName": "", "mappedName": "", "billableHrs": 0, "totalHrs": 0 }] }`;

    let content;
    if (fileData.type === "text") {
      content = promptText + "\n\nDOCUMENT DATA:\n" + buildVerticalCsvText_(fileData.data);
    } else if (fileData.type === "image_array") {
      content = fileData.data.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }));
      content.push({ type: "text", text: promptText });
    } else {
      content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fileData.data } }, { type: "text", text: promptText }];
    }

    const aiMsg = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, messages: [{ role: "user", content }] });
    await logClaudeUsage_(sheets, automationCommanderSheetId, timeClientName || "", "time_extract", aiMsg.usage?.input_tokens || 0, aiMsg.usage?.output_tokens || 0, "time_tool").catch(() => {});

    const rawText = aiMsg.content[0].type === "text" ? aiMsg.content[0].text : "";
    const cleanText = rawText.replace(new RegExp("```json", "g"), "").replace(new RegExp("```", "g"), "").trim();
    let extractedData;
    try { extractedData = JSON.parse(cleanText.slice(cleanText.indexOf("{"), cleanText.lastIndexOf("}") + 1)); } catch (e) {
      return res.status(500).json({ success: false, error: "AI generated malformed JSON" });
    }

    const targetMonthStr = confirmedMonth || extractedData.period;
    if (!targetMonthStr || String(targetMonthStr).toLowerCase() === "unknown" || String(targetMonthStr).toLowerCase() === "null") {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return res.status(200).json({ success: true, status: "CONFIRM_PERIOD", extractedData, fallback: `${months[d.getMonth()]} ${d.getFullYear()}` });
    }

    const writeResult = await writeTimeDataToSheet_(sheets, timeMasterSheetId, extractedData, targetMonthStr, allEmployeeNames);
    await redisClient.del(`payroll_upload:${uploadId}`).catch(() => {});

    if (writeResult.writeSuccess && automationCommanderSheetId) {
      const timeWorkMonthKey = eomTargetMonthToWorkMonth_(monthStrToEomKey_(targetMonthStr));
      await autoCompleteLinkedEomTask_(sheets, automationCommanderSheetId, timeClientName, "time_import", timeWorkMonthKey);
    }
    return res.status(200).json({ success: true, status: "COMPLETE", extractedData, ...writeResult });
  } catch (err) {
    await redisClient.del(`payroll_upload:${uploadId}`).catch(() => {});
    return res.status(500).json({ success: false, error: err.message });
  }
}