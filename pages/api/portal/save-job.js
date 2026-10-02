import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient, withRetry } from "../../../services/sheetsClient.js";
import { matchesClientName } from "../../../services/userPermissions.js";
import { redisClient } from "../../../services/redisClient.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Unauthorized: Active session required" });
  }

  const { clientSheetId, clientName, job } = req.body || {};

  if (!clientSheetId || !job) {
    return res.status(400).json({ success: false, error: "clientSheetId and job object are required" });
  }

  // Authorization check
  if (!sessionUser.isAdmin && clientName) {
    const assignedList = Array.isArray(sessionUser.assignedClients) ? sessionUser.assignedClients : [];
    const isAuthorized = assignedList.some((assigned) => matchesClientName(assigned, clientName));
    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: Not authorized for this client" });
    }
  }

  try {
    const sheets = await getSheetsClient();

    // Determine target sheet name
    const isConfirmed = String(job.type || "").toLowerCase() === "confirmed";
    const metaResp = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId: clientSheetId,
        fields: "sheets.properties.title",
      })
    );
    const existingTitles = new Set(
      (metaResp.data?.sheets || []).map((s) => s.properties?.title)
    );

    let sheetName = "";
    if (isConfirmed) {
      sheetName = existingTitles.has("Confirmed") ? "Confirmed" : existingTitles.has("ConfCalcs") ? "ConfCalcs" : "Confirmed";
    } else {
      sheetName = existingTitles.has("Pipeline") ? "Pipeline" : existingTitles.has("PipeCalcs") ? "PipeCalcs" : "Pipeline";
    }

    // Read header row to map columns
    const headerResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!1:1`,
        valueRenderOption: "FORMATTED_VALUE",
      })
    );

    const headers = (headerResp.data?.values?.[0] || []).map((h) =>
      String(h || "").toLowerCase().trim()
    );

    const findColIdx = (patterns) => {
      return headers.findIndex((h) => patterns.some((p) => h.includes(p)));
    };

    const clientCol = findColIdx(["client"]);
    const jobNameCol = findColIdx(["job name", "job"]);
    const projRetCol = findColIdx(["project / retainer", "proj / ret"]);
    const revCol = findColIdx(["total revenue", "revenue", "income"]);
    const dirCostCol = findColIdx(["direct cost", "costs of sale"]);
    const likelihoodCol = findColIdx(["likelihood", "% likel"]);
    const startCol = findColIdx(["start date"]);
    const endCol = findColIdx(["end date"]);
    const prodLineCol = findColIdx(["product line", "prod. line"]);
    const leadSrcCol = findColIdx(["lead source", "lead src"]);
    const vatCol = findColIdx(["vat"]);
    const projCodeCol = findColIdx(["project code"]);
    const dateConfCol = findColIdx(["date conf", "date added"]);

    // Invoice columns 1-3
    const invCols = [1, 2, 3].map((n) => ({
      amount: findColIdx([`project invoice ${n}`, `inv ${n} amount`]),
      ref: findColIdx([`inv ${n} ref`]),
      status: findColIdx([`inv ${n} status`]),
      sendDate: findColIdx([`inv ${n} send date`, `inv ${n} date`]),
      days: findColIdx([`inv ${n} days`]),
    }));

    // Direct invoice (expenses) columns 1-3
    const dirCols = [1, 2, 3].map((n) => ({
      amount: findColIdx([`direct inv ${n} amt`, `direct inv ${n} amount`]),
      desc: findColIdx([`direct inv ${n} desc`]),
      vat: findColIdx([`dir inv. ${n} vat`, `dir inv ${n} vat`, `direct inv ${n} vat`]),
      recDate: findColIdx([`dir inv. ${n} rec date`, `direct inv ${n} rec date`]),
      days: findColIdx([`dir inv ${n} days`]),
      status: findColIdx([`dir inv ${n} status`]),
    }));

    // Determine target row
    let targetRow = parseInt(job.rowNumber, 10);
    if (isNaN(targetRow) || targetRow < 2) {
      // Find last row by reading Column A
      const colAResp = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: clientSheetId,
          range: `${sheetName}!A:A`,
        })
      );
      const colARows = colAResp.data?.values || [];
      targetRow = colARows.length + 1;
    }

    // Read existing row across all columns to preserve formulas/untouched columns
    const rowResp = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!A${targetRow}:CZ${targetRow}`,
        valueRenderOption: "FORMULA",
      })
    );

    const existingRow = rowResp.data?.values?.[0] || [];
    const maxCols = Math.max(headers.length, existingRow.length, 60);
    const updatedRow = new Array(maxCols).fill("");

    // Populate existing values/formulas
    for (let c = 0; c < maxCols; c++) {
      if (existingRow[c] !== undefined) {
        updatedRow[c] = existingRow[c];
      }
    }

    // Apply job edits
    if (clientCol !== -1 && job.client !== undefined) updatedRow[clientCol] = job.client;
    if (jobNameCol !== -1 && job.jobName !== undefined) updatedRow[jobNameCol] = job.jobName;
    if (projRetCol !== -1 && job.projectRetainer !== undefined) updatedRow[projRetCol] = job.projectRetainer;
    if (revCol !== -1 && job.revenue !== undefined) {
      const num = parseFloat(String(job.revenue).replace(/[£,]/g, ""));
      updatedRow[revCol] = isNaN(num) ? job.revenue : num;
    }
    if (dirCostCol !== -1 && job.directCosts !== undefined) {
      const num = parseFloat(String(job.directCosts).replace(/[£,]/g, ""));
      updatedRow[dirCostCol] = isNaN(num) ? job.directCosts : num;
    }
    if (likelihoodCol !== -1 && job.likelihood !== undefined) {
      updatedRow[likelihoodCol] = job.likelihood;
    }
    if (startCol !== -1 && job.startDate !== undefined) updatedRow[startCol] = job.startDate;
    if (endCol !== -1 && job.endDate !== undefined) updatedRow[endCol] = job.endDate;
    if (prodLineCol !== -1 && job.productLine !== undefined) updatedRow[prodLineCol] = job.productLine;
    if (leadSrcCol !== -1 && job.leadSource !== undefined) updatedRow[leadSrcCol] = job.leadSource;
    if (vatCol !== -1 && job.vat !== undefined) updatedRow[vatCol] = job.vat;
    if (projCodeCol !== -1 && job.projectCode !== undefined) updatedRow[projCodeCol] = job.projectCode;
    if (dateConfCol !== -1 && job.dateConfirmed !== undefined) updatedRow[dateConfCol] = job.dateConfirmed;

    // Apply invoices (1-3)
    if (Array.isArray(job.invoices)) {
      job.invoices.slice(0, 3).forEach((inv, i) => {
        const colMap = invCols[i];
        if (colMap) {
          if (colMap.amount !== -1 && inv.amount !== undefined) {
            const num = parseFloat(String(inv.amount).replace(/[£,]/g, ""));
            updatedRow[colMap.amount] = isNaN(num) ? inv.amount : num;
          }
          if (colMap.ref !== -1 && inv.ref !== undefined) updatedRow[colMap.ref] = inv.ref;
          if (colMap.status !== -1 && inv.status !== undefined) updatedRow[colMap.status] = inv.status;
          if (colMap.sendDate !== -1 && inv.sendDate !== undefined) updatedRow[colMap.sendDate] = inv.sendDate;
          if (colMap.days !== -1 && inv.days !== undefined) {
            const d = parseInt(inv.days, 10);
            updatedRow[colMap.days] = isNaN(d) ? inv.days : d;
          }
        }
      });
    }

    // Apply direct expenses (1-3)
    if (Array.isArray(job.directExpenses)) {
      job.directExpenses.slice(0, 3).forEach((exp, i) => {
        const colMap = dirCols[i];
        if (colMap) {
          if (colMap.amount !== -1 && exp.amount !== undefined) {
            const num = parseFloat(String(exp.amount).replace(/[£,]/g, ""));
            updatedRow[colMap.amount] = isNaN(num) ? exp.amount : num;
          }
          if (colMap.desc !== -1 && exp.desc !== undefined) updatedRow[colMap.desc] = exp.desc;
          if (colMap.vat !== -1 && exp.vat !== undefined) updatedRow[colMap.vat] = exp.vat;
          if (colMap.recDate !== -1 && exp.recDate !== undefined) updatedRow[colMap.recDate] = exp.recDate;
          if (colMap.days !== -1 && exp.days !== undefined) {
            const d = parseInt(exp.days, 10);
            updatedRow[colMap.days] = isNaN(d) ? exp.days : d;
          }
          if (colMap.status !== -1 && exp.status !== undefined) updatedRow[colMap.status] = exp.status;
        }
      });
    }

    // Helper to convert 0-indexed column number to letters (e.g. 0 -> A, 27 -> AB)
    const colToLetter = (colIndex) => {
      let temp, letter = '';
      let c = colIndex + 1;
      while (c > 0) {
        temp = (c - 1) % 26;
        letter = String.fromCharCode(65 + temp) + letter;
        c = (c - temp - 1) / 26;
      }
      return letter;
    };

    const endColLetter = colToLetter(updatedRow.length - 1);

    // Write back to sheet
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: clientSheetId,
        range: `${sheetName}!A${targetRow}:${endColLetter}${targetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [updatedRow],
        },
      })
    );

    // Invalidate Redis caches for this client
    try {
      const keys = await redisClient.keys(`pulse:portal:*:${clientSheetId}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (cacheErr) {
      console.warn("⚠️ Redis invalidation warning:", cacheErr.message);
    }

    return res.status(200).json({
      success: true,
      rowNumber: targetRow,
      sheetName,
    });
  } catch (err) {
    console.error("❌ /api/portal/save-job error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
