// Standalone test for checkAutoLogErrors_ and checkAutoLogInfiniteLoops_

function cleanVal(v) {
  if (!v) return "";
  let s = String(v).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function normalizeFieldName(rawField) {
  const f = rawField.toLowerCase().trim();
  if (f.includes("day") || f.includes("extend")) return "invoice_days_to_pay";
  if (f.includes("paid date") || f.includes("fully paid")) return "invoice_paid_date";
  if (f.includes("client") || f.includes("customer")) return "client_name";
  if (f.includes("copied status") || f.includes("copied to conf")) return "copied_status";
  if (f.includes("revenue") || f.includes("amount")) return "amount";
  if (f.includes("status")) return "status";
  if (f.includes("date moved") || f.includes("sent date") || f.includes("invoice date")) return "invoice_date";
  return f.replace(/[^a-z0-9_]/g, "_");
}

function extractEntityFromLine(line) {
  const invMatch = line.match(/(?:Inv\s*(?:#|no\.?|oice)?\s*([A-Za-z0-9\-_]+))/i);
  const invNo = invMatch ? invMatch[1].replace(/^#/, "").trim() : "";

  const rowMatch = line.match(/Row\s*(\d+)/i);
  const rowNo = rowMatch ? rowMatch[1].trim() : "";

  let jobName = "";
  let endClientName = "";
  const clientJobMatch = line.match(/(?:Row\s*\d+,\s*|\(\s*)([^|\n]+)\s*\|\s*([^,\n\-:\)]+)/);
  if (clientJobMatch) {
    endClientName = clientJobMatch[1].trim();
    jobName = clientJobMatch[2].trim();
  }

  const slotMatch = line.match(/Slot\s*(\d+)/i);
  const slotNo = slotMatch ? slotMatch[1].trim() : "";

  return { invNo, rowNo, endClientName, jobName, slotNo };
}

function parseLineTransitions(line) {
  if (!line || !line.includes("->")) return [];
  const results = [];
  
  const p1 = /(?:[-–•,\n:]|^)\s*([A-Za-z\s]+?)\s*:\s*('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/g;
  let m;
  while ((m = p1.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanVal(m[2]);
    const toVal = cleanVal(m[3]);
    if (rawField.length <= 35 && fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  const p2 = /(?:[-–•,:\n]|^)\s*(Extended days|Date moved)\s+('?[^':\r\n]+?'?)\s*->\s*('?[^':\r\n;]+?'?)(?:[\r\n,;]|$)/gi;
  while ((m = p2.exec(line)) !== null) {
    const rawField = m[1].trim();
    const fromVal = cleanVal(m[2]);
    const toVal = cleanVal(m[3]);
    if (fromVal && toVal && fromVal.toLowerCase() !== toVal.toLowerCase()) {
      results.push({ rawField, fromVal, toVal });
    }
  }

  return results;
}

export function checkAutoLogErrors_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    if (!data.length) return alerts;

    const errorRegex = /error:\s*([^\n\r]+)/i;
    const errorsBySignature = new Map();

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const summary = String(row[2] || "").trim();
      const details = String(row[3] || "").trim();

      const combinedText = `${summary}\n${details}`;
      const match = combinedText.match(errorRegex);
      if (!match) continue;

      const rawErrorText = match[1].trim();
      if (!rawErrorText) continue;

      const cleanSignature = rawErrorText
        .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*/g, "")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .slice(0, 80);

      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      if (!errorsBySignature.has(cleanSignature)) {
        errorsBySignature.set(cleanSignature, {
          latestTs: tsStr,
          count: 1,
          category,
          summary,
          errorText: rawErrorText,
          detailsSnippet: details.slice(0, 300),
        });
      } else {
        const item = errorsBySignature.get(cleanSignature);
        item.count += 1;
        // Keep the latest timestamp from the newer row (r === 0 is newest)
      }
    }

    for (const [signature, info] of errorsBySignature.entries()) {
      const countNote = info.count > 1 ? ` (occurred ${info.count} times in last 100 logs)` : "";
      alerts.push({
        alertType: "autolog_error",
        alertKey: `autolog_error|${clientName}|${signature}`,
        heading: `Automation error${info.category ? ` in ${info.category}` : ""}`,
        detail: `Error in AutoLog: "${info.errorText}"${countNote}. Latest: ${info.latestTs || "recently"}.`,
        clientName,
        timestamp: info.latestTs,
        category: info.category,
        summary: info.summary,
        errorSnippet: info.errorText,
        occurrenceCount: String(info.count),
        detailsSnippet: info.detailsSnippet,
      });
    }
  } catch (e) {
    console.error(`Error in checkAutoLogErrors_ for ${clientName}:`, e.message);
  }
  return alerts;
}

export function checkAutoLogInfiniteLoops_(clientName, masterSheetId, sharedData) {
  const alerts = [];
  try {
    const rawData = sharedData?.autoLogData || [];
    const data = rawData.slice(0, 100);
    if (!data.length) return alerts;

    const detectedConflicts = new Map();

    const chronologicalRows = [...data].reverse();

    for (let r = 0; r < chronologicalRows.length; r++) {
      const row = chronologicalRows[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const details = String(row[3] || "");
      const lines = details.split(/\r?\n/);
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      const entryTransitions = [];

      let currentContext = { invNo: "", rowNo: "", endClientName: "", jobName: "", slotNo: "" };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const lineEntity = extractEntityFromLine(line);
        if (lineEntity.invNo) currentContext.invNo = lineEntity.invNo;
        if (lineEntity.rowNo) currentContext.rowNo = lineEntity.rowNo;
        if (lineEntity.endClientName) currentContext.endClientName = lineEntity.endClientName;
        if (lineEntity.jobName) currentContext.jobName = lineEntity.jobName;
        if (lineEntity.slotNo) currentContext.slotNo = lineEntity.slotNo;

        const transitions = parseLineTransitions(line);
        if (!transitions.length) continue;

        for (const t of transitions) {
          const invNo = lineEntity.invNo || currentContext.invNo;
          const rowNo = lineEntity.rowNo || currentContext.rowNo;
          const endClientName = lineEntity.endClientName || currentContext.endClientName;
          const jobName = lineEntity.jobName || currentContext.jobName;

          // Entity key prefers Row (since sheet rows are exact locations) or Invoice or Job
          const entityKey = rowNo ? `row_${rowNo}`
            : (invNo ? `inv_${invNo}`
            : (jobName ? `job_${jobName.toLowerCase()}` : "unknown"));

          const displayEntity = invNo
            ? `Invoice #${invNo}${rowNo ? ` (Row ${rowNo})` : ""}`
            : (rowNo
            ? `Row ${rowNo}${jobName ? ` (${jobName})` : ""}`
            : (jobName || "Job"));

          const normalizedField = normalizeFieldName(t.rawField);

          entryTransitions.push({
            entityKey,
            displayEntity,
            endClientName: endClientName || "",
            jobName: jobName || "",
            rowNo: rowNo || "",
            invNo: invNo || "",
            rawField: t.rawField,
            normalizedField,
            fromVal: t.fromVal,
            toVal: t.toVal,
            line,
            category,
            tsStr,
          });
        }
      }

      // Check for Intra-Run conflict within this single entry
      for (let i = 0; i < entryTransitions.length; i++) {
        for (let j = i + 1; j < entryTransitions.length; j++) {
          const t1 = entryTransitions[i];
          const t2 = entryTransitions[j];
          if (t1.entityKey === t2.entityKey && t1.normalizedField === t2.normalizedField && t1.entityKey !== "unknown") {
            const isInverted = t1.fromVal.toLowerCase() === t2.toVal.toLowerCase() && t1.toVal.toLowerCase() === t2.fromVal.toLowerCase();
            if (isInverted) {
              const conflictKey = `${t1.entityKey}|${t1.normalizedField}`;
              if (!detectedConflicts.has(conflictKey)) {
                let suggestion = "";
                if (t1.normalizedField === "invoice_days_to_pay" || t1.normalizedField === "invoice_paid_date") {
                  suggestion = "Likely caused by invoice having a pay date recorded without a 'Paid' status, causing payment terms to fight with the overdue date extender.";
                } else if (t1.normalizedField === "client_name") {
                  suggestion = "Likely caused by a naming mismatch between accounting software (Xero) and CRM.";
                } else if (t1.normalizedField === "copied_status") {
                  suggestion = "Likely caused by Pipeline source data reverting copied status.";
                }

                detectedConflicts.set(conflictKey, {
                  conflictType: "intra_run",
                  entityKey: t1.entityKey,
                  displayEntity: t1.displayEntity,
                  endClientName: t1.endClientName || t2.endClientName,
                  jobName: t1.jobName || t2.jobName,
                  confirmedRow: t1.rowNo || t2.rowNo,
                  invoiceNo: t1.invNo || t2.invNo,
                  fieldName: t1.rawField,
                  normalizedField: t1.normalizedField,
                  transition1: `${t1.rawField}: ${t1.fromVal} -> ${t1.toVal}`,
                  transition2: `${t2.rawField}: ${t2.fromVal} -> ${t2.toVal}`,
                  timestamp: tsStr,
                  suggestion,
                });
              }
            }
          }
        }
      }
    }

    // Now check for Inter-Run flip-flops across chronological entries
    const transitionHistory = new Map();
    for (let r = 0; r < chronologicalRows.length; r++) {
      const row = chronologicalRows[r];
      const timestamp = row[0];
      const category = String(row[1] || "").trim();
      const details = String(row[3] || "");
      const lines = details.split(/\r?\n/);
      const tsStr = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp || "");

      let currentContext = { invNo: "", rowNo: "", endClientName: "", jobName: "", slotNo: "" };
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const lineEntity = extractEntityFromLine(line);
        if (lineEntity.invNo) currentContext.invNo = lineEntity.invNo;
        if (lineEntity.rowNo) currentContext.rowNo = lineEntity.rowNo;
        if (lineEntity.endClientName) currentContext.endClientName = lineEntity.endClientName;
        if (lineEntity.jobName) currentContext.jobName = lineEntity.jobName;
        if (lineEntity.slotNo) currentContext.slotNo = lineEntity.slotNo;

        const transitions = parseLineTransitions(line);
        for (const t of transitions) {
          const invNo = lineEntity.invNo || currentContext.invNo;
          const rowNo = lineEntity.rowNo || currentContext.rowNo;
          const endClientName = lineEntity.endClientName || currentContext.endClientName;
          const jobName = lineEntity.jobName || currentContext.jobName;

          const entityKey = rowNo ? `row_${rowNo}`
            : (invNo ? `inv_${invNo}`
            : (jobName ? `job_${jobName.toLowerCase()}` : "unknown"));

          if (entityKey === "unknown") continue;

          const displayEntity = invNo
            ? `Invoice #${invNo}${rowNo ? ` (Row ${rowNo})` : ""}`
            : (rowNo
            ? `Row ${rowNo}${jobName ? ` (${jobName})` : ""}`
            : (jobName || "Job"));

          const normalizedField = normalizeFieldName(t.rawField);
          const key = `${entityKey}|${normalizedField}`;

          if (!transitionHistory.has(key)) transitionHistory.set(key, []);
          transitionHistory.get(key).push({
            runIndex: r,
            tsStr,
            category,
            line,
            rawField: t.rawField,
            fromVal: t.fromVal,
            toVal: t.toVal,
            displayEntity,
            endClientName: endClientName || "",
            jobName: jobName || "",
            rowNo: rowNo || "",
            invNo: invNo || "",
          });
        }
      }
    }

    for (const [key, history] of transitionHistory.entries()) {
      if (detectedConflicts.has(key)) continue;
      if (history.length < 2) continue;

      for (let i = 0; i < history.length - 1; i++) {
        const t1 = history[i];
        const t2 = history[i + 1];
        if (t1.fromVal.toLowerCase() === t2.toVal.toLowerCase() && t1.toVal.toLowerCase() === t2.fromVal.toLowerCase()) {
          const [entityKey, normalizedField] = key.split("|");
          let suggestion = "";
          if (normalizedField === "client_name") {
            suggestion = "Likely caused by a naming mismatch between accounting software (Xero) and CRM.";
          } else if (normalizedField === "invoice_days_to_pay" || normalizedField === "invoice_paid_date") {
            suggestion = "Likely caused by an unpaid invoice repeatedly fighting with automated payment term extensions.";
          } else if (normalizedField === "copied_status") {
            suggestion = "Likely caused by Pipeline source data reverting copied status.";
          }

          detectedConflicts.set(key, {
            conflictType: "inter_run",
            entityKey,
            displayEntity: t2.displayEntity,
            endClientName: t2.endClientName || t1.endClientName,
            jobName: t2.jobName || t1.jobName,
            confirmedRow: t2.rowNo || t1.rowNo,
            invoiceNo: t2.invNo || t1.invNo,
            fieldName: t2.rawField,
            normalizedField,
            transition1: `At ${t1.tsStr}: ${t1.rawField} '${t1.fromVal}' -> '${t1.toVal}'`,
            transition2: `At ${t2.tsStr}: ${t2.rawField} '${t2.fromVal}' -> '${t2.toVal}'`,
            timestamp: t2.tsStr,
            suggestion,
          });
          break;
        }
      }
    }

    for (const [conflictKey, conf] of detectedConflicts.entries()) {
      const typeLabel = conf.conflictType === "intra_run" ? "Intra-run conflict" : "Multi-run flip-flop";
      const hint = conf.suggestion ? ` Possible cause: ${conf.suggestion}` : "";
      alerts.push({
        alertType: "infinite_loop",
        alertKey: `infinite_loop|${clientName}|${conflictKey}`,
        heading: `Automation conflict: ${conf.displayEntity}`,
        detail: `The automation is fighting itself on ${conf.displayEntity} (${conf.fieldName}). ${conf.transition1} was reversed by ${conf.transition2}.${hint}`,
        clientName,
        timestamp: conf.timestamp,
        jobName: conf.jobName,
        endClientName: conf.endClientName,
        confirmedRow: conf.confirmedRow,
        invoiceNo: conf.invoiceNo,
        fieldName: conf.fieldName,
        conflictType: conf.conflictType,
        transition1: conf.transition1,
        transition2: conf.transition2,
        suggestion: conf.suggestion,
      });
    }
  } catch (e) {
    console.error(`Error in checkAutoLogInfiniteLoops_ for ${clientName}:`, e.message);
  }
  return alerts;
}

// Run test
const sampleData = {
  autoLogData: [
    [
      "2026-09-22T14:32:00.000Z",
      "Scheduled Sweep",
      "Accounting & CRM Sync",
      `[Accounting Download]
• Updated Invoices (1):
  - Inv #INV-1544 (Alive Publishing Group Inc | Alive-004) - Fully Paid Date: '28-Aug-26' -> 'Blank'

Matched/Updated 1 Invoices from Xero:
[Confirmed] Updated Invoice 1544: Row 286, Alive Publishing Group Inc | Development, Ecommerce, Web Deisgn, Slot 1 - Days to Pay: 15 -> 7

Updated 1 Overdue Invoices:
[Confirmed] Overdue Update - Row 286, Alive Publishing Group Inc | Development, Ecommerce, Web Deisgn, Slot 1: Extended days 7 -> 15`
    ],
    [
      "2026-09-22T13:30:00.000Z",
      "CRM Sync",
      "Failed to sync pipeline",
      `Starting sync for client...
Error: Script timeout in fetchPipelineData() at line 412
Aborted after 3 retries.`
    ],
    [
      "2026-09-22T12:30:00.000Z",
      "CRM Sync",
      "Failed to sync pipeline",
      `Starting sync for client...
Error: Script timeout in fetchPipelineData() at line 412
Aborted after 3 retries.`
    ],
    [
      "2026-09-22T11:00:00.000Z",
      "Xero Sync",
      "Contact update",
      `[Confirmed] Updated Invoice 1200: Row 105, Alive Publishing Group Inc | Brand Identity - Client: 'Alive Publishing Group Inc' -> 'Alive Publishing'`
    ],
    [
      "2026-09-22T10:00:00.000Z",
      "CRM Sync",
      "Pipeline copy",
      `[Confirmed] Updated Invoice 1200: Row 105, Alive Publishing | Brand Identity - Client: 'Alive Publishing' -> 'Alive Publishing Group Inc'`
    ]
  ]
};

console.log("--- RUNNING ERROR CHECK ---");
const errorAlerts = checkAutoLogErrors_("ClientA", "master123", sampleData);
console.log("Error alerts count:", errorAlerts.length);
console.log(JSON.stringify(errorAlerts, null, 2));

console.log("\n--- RUNNING INFINITE LOOP CHECK ---");
const loopAlerts = checkAutoLogInfiniteLoops_("ClientA", "master123", sampleData);
console.log("Loop alerts count:", loopAlerts.length);
console.log(JSON.stringify(loopAlerts, null, 2));

