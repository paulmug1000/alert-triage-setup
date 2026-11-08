import { getSupabaseAdmin } from "./supabaseClient.js";
import {
  resolveSupabaseSheetContext,
  invalidateMasterEngineCache,
  colIdx0ToLetter,
} from "./masterEngineService.js";
import {
  getIntegrationTokens,
  updateRefreshedTokens,
  updateSharedXeroGrantTokens,
} from "./vaultService.js";
import { refreshXeroTokens, parseXeroDate } from "./xeroService.js";
import { refreshQBTokens } from "./quickbooksService.js";
import { logPmaActivity } from "./pmaLogger.js";

function parseNumeric_(val) {
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (val == null || val === "") return 0;
  const s = String(val).trim();
  const isParen = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()£$€,\s]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isParen ? -Math.abs(num) : num;
}

function normalizeStatus_(rawStatus) {
  const s = String(rawStatus || "").trim().toUpperCase();
  if (s === "PAID") return "Paid";
  if (s === "AUTHORISED" || s === "SUBMITTED" || s === "SENT" || s === "OPEN" || s === "UNPAID") return "Sent";
  if (s === "DRAFT") return "Draft";
  return rawStatus ? String(rawStatus).trim() : "Sent";
}

async function resolveActiveAccountingSession_(ctx) {
  for (const tool of ["xero", "quickbooks"]) {
    const rec = await getIntegrationTokens({
      clientKey: ctx.clientName,
      masterSheetId: ctx.masterSheetId,
      tool,
    });
    if (rec && rec.tokens?.accessToken) {
      return { tool, record: rec };
    }
  }
  return null;
}

async function withAccountingAccessToken_(ctx, session, fn) {
  const { tool, record } = session;
  let accessToken = record.tokens?.accessToken;
  const isShared = Boolean(record.isSharedGrant);

  const refreshFn = async () => {
    const refreshToken = record.tokens?.refreshToken;
    if (!refreshToken) throw new Error(`No refresh token available for ${tool}.`);
    if (tool === "xero") {
      const refreshed = await refreshXeroTokens(refreshToken);
      accessToken = refreshed.accessToken;
      record.tokens = refreshed;
      if (isShared) await updateSharedXeroGrantTokens(refreshed);
      else await updateRefreshedTokens({ clientKey: ctx.clientName, masterSheetId: ctx.masterSheetId, tool: "xero", tokens: refreshed });
      return accessToken;
    } else {
      const refreshed = await refreshQBTokens(refreshToken);
      accessToken = refreshed.accessToken;
      record.tokens = refreshed;
      await updateRefreshedTokens({ clientKey: ctx.clientName, masterSheetId: ctx.masterSheetId, tool: "quickbooks", tokens: refreshed });
      return accessToken;
    }
  };

  const nowMs = Date.now();
  let expiresAtMs = record.expiresAt || 0;
  if (!expiresAtMs && record.tokens?.expiresAt) {
    expiresAtMs = record.tokens.expiresAt < 10000000000 ? record.tokens.expiresAt * 1000 : record.tokens.expiresAt;
  }
  if ((!expiresAtMs || expiresAtMs - nowMs < 300000) && record.tokens?.refreshToken) {
    try {
      await refreshFn();
    } catch (e) {
      console.warn(`[masterSyncEngine] Proactive ${tool} token refresh warning:`, e.message);
    }
  }

  try {
    return await fn(accessToken, record);
  } catch (err) {
    const msg = String(err.message || "");
    if ((msg.includes("401") || msg.includes("TokenExpired") || msg.includes("Unauthorized")) && record.tokens?.refreshToken) {
      const newTok = await refreshFn();
      return await fn(newTok, record);
    }
    throw err;
  }
}

/**
 * Fetches live ACCREC sales invoices from Xero or QuickBooks into public.accounting_invoices
 */
async function pullLiveAccountingInvoicesToSupabase_(ctx, session) {
  const supabase = getSupabaseAdmin();
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 18);
  const startIso = cutoffDate.toISOString().split("T")[0];
  const [sY, sM, sD] = startIso.split("-").map(Number);

  const invoiceRows = await withAccountingAccessToken_(ctx, session, async (accessToken, rec) => {
    if (session.tool === "xero") {
      const tenantId = rec.tenantId;
      const where = `Type=="ACCREC" AND Status!="DELETED" AND Status!="VOIDED" AND Date>=DateTime(${sY},${sM},${sD})`;
      const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(where)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        throw new Error(`Xero Invoices API (${resp.status}): ${await resp.text()}`);
      }
      const data = await resp.json();
      return (data?.Invoices || []).map((inv) => {
        const issueDate = parseXeroDate(inv.Date, inv.DateString);
        const dueDate = parseXeroDate(inv.DueDate, inv.DueDateString);
        const paidDate = parseXeroDate(inv.FullyPaidOnDate, inv.FullyPaidOnDateString);
        const desc = (inv.LineItems || []).map((li) => li.Description).filter(Boolean).join("; ") || inv.Reference || "";
        const accCode = inv.LineItems?.[0]?.AccountCode || "";
        const taxType = inv.LineItems?.[0]?.TaxType || "";
        const subTotal = parseNumeric_(inv.SubTotal);
        const taxTotal = parseNumeric_(inv.TotalTax);
        const total = parseNumeric_(inv.Total);
        const amountDue = parseNumeric_(inv.AmountDue);
        const amountPaid = parseNumeric_(inv.AmountPaid);
        const status = normalizeStatus_(inv.Status);
        const contactName = inv.Contact?.Name || "";
        const invNo = inv.InvoiceNumber || inv.Reference || "";
        const curr = inv.CurrencyCode || "GBP";
        const extId = inv.InvoiceID || invNo;
        const rawRow = [
          issueDate,
          invNo,
          contactName,
          desc,
          accCode,
          taxType,
          "",
          subTotal,
          taxTotal,
          total,
          status,
          "ACCREC",
          extId,
          paidDate,
          curr,
          amountDue,
          amountPaid,
        ];
        return {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          external_id: extId,
          invoice_number: invNo,
          contact_name: contactName,
          description: desc,
          account_code: accCode,
          tax_type: taxType,
          issue_date: issueDate,
          due_date: dueDate,
          fully_paid_date: paidDate,
          status,
          invoice_type: "ACCREC",
          sub_total: subTotal,
          tax_total: taxTotal,
          total,
          amount_due: amountDue,
          amount_paid: amountPaid,
          currency_code: curr,
          currency_rate: parseNumeric_(inv.CurrencyRate) || 1,
          line_items: inv.LineItems || [],
          raw_row: rawRow,
          synced_at: new Date().toISOString(),
        };
      });
    } else {
      const realmId = rec.realmId;
      const q = `select * from Invoice where TxnDate >= '${startIso}' maxresults 1000`;
      const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=73`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        throw new Error(`QuickBooks Invoice API (${resp.status}): ${await resp.text()}`);
      }
      const data = await resp.json();
      return (data?.QueryResponse?.Invoice || []).map((inv) => {
        const issueDate = inv.TxnDate || "";
        const dueDate = inv.DueDate || "";
        const total = parseNumeric_(inv.TotalAmt);
        const balance = parseNumeric_(inv.Balance);
        const amountPaid = Math.max(0, total - balance);
        const taxTotal = parseNumeric_(inv.TxnTaxDetail?.TotalTax);
        const subTotal = Math.max(0, total - taxTotal);
        const status = balance <= 0.005 && total > 0 ? "Paid" : "Sent";
        const paidDate = status === "Paid" ? (inv.MetaData?.LastUpdatedTime || "").slice(0, 10) : "";
        const contactName = inv.CustomerRef?.name || "";
        const invNo = inv.DocNumber || String(inv.Id || "");
        const desc =
          (inv.Line || [])
            .map((l) => l.Description)
            .filter(Boolean)
            .join("; ") ||
          inv.PrivateNote ||
          "";
        const curr = inv.CurrencyRef?.value || "GBP";
        const extId = String(inv.Id || invNo);
        const rawRow = [
          issueDate,
          invNo,
          contactName,
          desc,
          "",
          "",
          "",
          subTotal,
          taxTotal,
          total,
          status,
          "ACCREC",
          extId,
          paidDate,
          curr,
          balance,
          amountPaid,
        ];
        return {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          external_id: extId,
          invoice_number: invNo,
          contact_name: contactName,
          description: desc,
          issue_date: issueDate,
          due_date: dueDate,
          fully_paid_date: paidDate,
          status,
          invoice_type: "ACCREC",
          sub_total: subTotal,
          tax_total: taxTotal,
          total,
          amount_due: balance,
          amount_paid: amountPaid,
          currency_code: curr,
          currency_rate: 1,
          line_items: inv.Line || [],
          raw_row: rawRow,
          synced_at: new Date().toISOString(),
        };
      });
    }
  });

  if (invoiceRows.length > 0) {
    await supabase.from("accounting_invoices").delete().eq("client_name", ctx.clientName);
    for (let i = 0; i < invoiceRows.length; i += 200) {
      await supabase.from("accounting_invoices").insert(invoiceRows.slice(i, i + 200));
    }
    const headerRow = [
      "Date",
      "Invoice Number",
      "Contact",
      "Description",
      "Account Code",
      "Tax Type",
      "Tracking",
      "Net",
      "VAT",
      "Gross",
      "Status",
      "Type",
      "Invoice ID",
      "Paid Date",
      "Currency",
      "Amount Due",
      "Amount Paid",
    ];
    const grid = [headerRow, ...invoiceRows.map((r) => r.raw_row)];
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "InvFromApp",
        values_grid: grid,
        formulas_grid: grid,
        row_count: grid.length,
        col_count: headerRow.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  return invoiceRows.length;
}

/**
 * Fetches live ACCPAY bills / direct costs from Xero or QuickBooks into public.accounting_direct_costs
 */
async function pullLiveAccountingDirectCostsToSupabase_(ctx, session) {
  const supabase = getSupabaseAdmin();
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 14);
  const startIso = cutoffDate.toISOString().split("T")[0];
  const [sY, sM, sD] = startIso.split("-").map(Number);

  const { data: ki } = await supabase
    .from("tenant_key_info")
    .select("contractor_categories, passthrough_categories")
    .eq("client_id", ctx.clientId)
    .maybeSingle();

  const contractorSet = new Set((ki?.contractor_categories || []).map((c) => String(c || "").trim().toLowerCase()));
  const passthroughSet = new Set((ki?.passthrough_categories || []).map((c) => String(c || "").trim().toLowerCase()));

  const costRows = await withAccountingAccessToken_(ctx, session, async (accessToken, rec) => {
    if (session.tool === "xero") {
      const tenantId = rec.tenantId;
      // Fetch Accounts map first so we can resolve AccountCode -> AccountName
      const accResp = await fetch("https://api.xero.com/api.xro/2.0/Accounts", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      });
      const accMap = new Map();
      if (accResp.ok) {
        const accData = await accResp.json();
        (accData?.Accounts || []).forEach((a) => {
          if (a.Code) accMap.set(String(a.Code).trim(), String(a.Name || "").trim());
        });
      }

      const where = `Type=="ACCPAY" AND Status!="DELETED" AND Status!="VOIDED" AND Date>=DateTime(${sY},${sM},${sD})`;
      const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(where)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        throw new Error(`Xero Bills API (${resp.status}): ${await resp.text()}`);
      }
      const data = await resp.json();
      const out = [];
      for (const bill of data?.Invoices || []) {
        const txnDate = parseXeroDate(bill.Date, bill.DateString);
        const dueDate = parseXeroDate(bill.DueDate, bill.DueDateString);
        const paidDate = parseXeroDate(bill.FullyPaidOnDate, bill.FullyPaidOnDateString);
        const supplier = bill.Contact?.Name || "";
        const ref = bill.InvoiceNumber || bill.Reference || "";
        const status = normalizeStatus_(bill.Status);
        const curr = bill.CurrencyCode || "GBP";
        const currRate = parseNumeric_(bill.CurrencyRate) || 1;
        const extId = bill.InvoiceID || ref;
        const firstAccCode = String(bill.LineItems?.[0]?.AccountCode || "").trim();
        const accName = accMap.get(firstAccCode) || firstAccCode;
        const accLower = accName.toLowerCase();
        const isContractor = contractorSet.has(accLower);
        const isPass = passthroughSet.has(accLower);
        if (contractorSet.size + passthroughSet.size > 0 && !isContractor && !isPass) {
          continue;
        }
        const net = parseNumeric_(bill.SubTotal);
        const vat = parseNumeric_(bill.TotalTax);
        const gross = parseNumeric_(bill.Total);
        const amtDue = parseNumeric_(bill.AmountDue);
        const amtPaid = parseNumeric_(bill.AmountPaid);
        const rawRow = [
          txnDate,
          supplier,
          net,
          vat,
          gross,
          ref,
          accName,
          status,
          extId,
          paidDate,
          curr,
          currRate,
          amtDue,
          amtPaid,
          dueDate,
        ];
        out.push({
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          external_id: extId,
          cost_type: isPass ? "pass_through" : "contractor",
          supplier_name: supplier,
          description: supplier,
          account_code: firstAccCode,
          account_name: accName,
          txn_date: txnDate,
          due_date: dueDate,
          paid_date: paidDate,
          net_amount: net,
          vat_amount: vat,
          gross_amount: gross,
          amount_due: amtDue,
          amount_paid: amtPaid,
          status,
          reference: ref,
          currency_code: curr,
          currency_rate: currRate,
          raw_row: rawRow,
          synced_at: new Date().toISOString(),
        });
      }
      return out;
    } else {
      const realmId = rec.realmId;
      const q = `select * from Bill where TxnDate >= '${startIso}' maxresults 1000`;
      const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=73`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        throw new Error(`QuickBooks Bill API (${resp.status}): ${await resp.text()}`);
      }
      const data = await resp.json();
      const out = [];
      for (const bill of data?.QueryResponse?.Bill || []) {
        const txnDate = bill.TxnDate || "";
        const dueDate = bill.DueDate || "";
        const gross = parseNumeric_(bill.TotalAmt);
        const balance = parseNumeric_(bill.Balance);
        const amtPaid = Math.max(0, gross - balance);
        const vat = parseNumeric_(bill.TxnTaxDetail?.TotalTax);
        const net = Math.max(0, gross - vat);
        const status = balance <= 0.005 && gross > 0 ? "Paid" : "Sent";
        const paidDate = status === "Paid" ? (bill.MetaData?.LastUpdatedTime || "").slice(0, 10) : "";
        const supplier = bill.VendorRef?.name || "";
        const ref = bill.DocNumber || String(bill.Id || "");
        const accName = bill.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || "";
        const accLower = accName.toLowerCase();
        const isContractor = contractorSet.has(accLower);
        const isPass = passthroughSet.has(accLower);
        if (contractorSet.size + passthroughSet.size > 0 && !isContractor && !isPass) {
          continue;
        }
        const curr = bill.CurrencyRef?.value || "GBP";
        const extId = String(bill.Id || ref);
        const rawRow = [
          txnDate,
          supplier,
          net,
          vat,
          gross,
          ref,
          accName,
          status,
          extId,
          paidDate,
          curr,
          1,
          balance,
          amtPaid,
          dueDate,
        ];
        out.push({
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          external_id: extId,
          cost_type: isPass ? "pass_through" : "contractor",
          supplier_name: supplier,
          description: supplier,
          account_name: accName,
          txn_date: txnDate,
          due_date: dueDate,
          paid_date: paidDate,
          net_amount: net,
          vat_amount: vat,
          gross_amount: gross,
          amount_due: balance,
          amount_paid: amtPaid,
          status,
          reference: ref,
          currency_code: curr,
          currency_rate: 1,
          raw_row: rawRow,
          synced_at: new Date().toISOString(),
        });
      }
      return out;
    }
  });

  if (costRows.length > 0) {
    await supabase.from("accounting_direct_costs").delete().eq("client_name", ctx.clientName);
    for (let i = 0; i < costRows.length; i += 200) {
      await supabase.from("accounting_direct_costs").insert(costRows.slice(i, i + 200));
    }
    const headerRow = [
      "Date",
      "Description",
      "Net",
      "VAT",
      "Gross",
      "Reference",
      "Account Name",
      "Status",
      "Transaction ID",
      "Date Paid",
      "Currency Code",
      "Currency Rate",
      "Amount Due",
      "Amount Paid",
      "Due Date",
    ];
    const grid = [headerRow, ...costRows.map((r) => r.raw_row)];
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "JnlsFromApp",
        values_grid: grid,
        formulas_grid: grid,
        row_count: grid.length,
        col_count: headerRow.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  return costRows.length;
}

/**
 * Computes the InvComp and DirComp comparison grids in Supabase by comparing
 * public.accounting_invoices and public.accounting_direct_costs against the Client Sheet's
 * Confirmed and Outgoings tabs.
 */
export async function recomputeClientComparisonsInSupabase(sheets, clientName = "APPTEST") {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx || !ctx.clientSheetId) {
    throw new Error(`Client "${clientName}" is missing clientSheetId.`);
  }

  // 1. Read Confirmed tab (A1:CR1200) and Outgoings notes (A1:AV111) from Client Sheet
  const [confirmedResp, outgoingsMetaResp] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Confirmed!A1:CR1200",
      valueRenderOption: "FORMATTED_VALUE",
      _bypassSupabaseVirtualSheet: true,
    }),
    sheets.spreadsheets
      .get({
        spreadsheetId: ctx.clientSheetId,
        ranges: ["Outgoings!A1:AV111"],
        includeGridData: true,
        fields: "sheets.data.rowData.values(formattedValue,note)",
        _bypassSupabaseVirtualSheet: true,
      })
      .catch(() => null),
  ]);

  const confirmedRows = confirmedResp?.data?.values || [];

  // Extract all invoice slots (AP:BH -> cols 41..59) and direct cost slots (BX:CR -> cols 75..95) from Client Confirmed
  const confirmedInvoices = [];
  const confirmedDirectCosts = [];
  let lastClient = "";
  let lastJob = "";
  let lastVatFlag = "Yes";

  for (let rIdx = 2; rIdx < confirmedRows.length; rIdx++) {
    const r = confirmedRows[rIdx] || [];
    const rowNum1 = rIdx + 1;
    const cName = String(r[0] || "").trim();
    const jName = String(r[1] || "").trim();
    if (cName) lastClient = cName;
    if (jName) lastJob = jName;
    if (r[34]) lastVatFlag = String(r[34]).trim();
    const isVatJob = lastVatFlag.toLowerCase() !== "no";

    // 3 Invoice slots: S1=41(AP), S2=48(AW), S3=55(BD)
    const invBases = [
      { slot: 1, base: 41, refCol: "AQ" },
      { slot: 2, base: 48, refCol: "AX" },
      { slot: 3, base: 55, refCol: "BE" },
    ];
    for (const s of invBases) {
      const netAmt = parseNumeric_(r[s.base]);
      const invRef = String(r[s.base + 1] || "").trim();
      const sentDate = String(r[s.base + 2] || "").trim();
      const st = String(r[s.base + 4] || "").trim();
      const paidDate = String(r[s.base + 5] || "").trim();
      if (!invRef && Math.abs(netAmt) < 0.005) continue;
      if (/^placeholder/i.test(invRef) || /^auto-/i.test(invRef)) continue;
      const vatAmt = isVatJob ? Math.round(netAmt * 0.2 * 100) / 100 : 0;
      const grossAmt = Math.round((netAmt + vatAmt) * 100) / 100;
      confirmedInvoices.push({
        client: cName || lastClient,
        job: jName || lastJob,
        netAmount: netAmt,
        vatAmount: vatAmt,
        grossAmount: grossAmt,
        invoiceNo: invRef,
        sentDate,
        paidDate,
        status: st,
        invSeq: `Inv ${s.slot}`,
        cellRef: `${s.refCol}${rowNum1}`,
        rowNum: rowNum1,
      });
    }

    // 3 Direct Cost slots: S1=75(BX), S2=82(CE), S3=89(CL)
    const dcBases = [
      { slot: 1, base: 75, colLetter: "BX" },
      { slot: 2, base: 82, colLetter: "CE" },
      { slot: 3, base: 89, colLetter: "CL" },
    ];
    for (const s of dcBases) {
      const desc = String(r[s.base] || "").trim();
      const netAmt = parseNumeric_(r[s.base + 1]);
      const vatFlag = String(r[s.base + 2] || "").trim();
      const recDate = String(r[s.base + 3] || "").trim();
      const payDate = String(r[s.base + 4] || "").trim();
      const st = String(r[s.base + 5] || "").trim();
      const appId = String(r[s.base + 6] || "").trim();
      if (!desc && !appId && Math.abs(netAmt) < 0.005) continue;
      if (/^place-exp/i.test(appId) || /^placeholder/i.test(desc)) continue;
      const vatAmt = vatFlag.toLowerCase() === "yes" ? Math.round(netAmt * 0.2 * 100) / 100 : 0;
      confirmedDirectCosts.push({
        location: "Confirmed",
        client: cName || lastClient,
        job: jName || lastJob,
        description: desc,
        netAmount: netAmt,
        vatAmount: vatAmt,
        recDate,
        payDate,
        status: st,
        appId,
        cellRef: `${s.colLetter}${rowNum1}`,
      });
    }
  }

  // Also extract Outgoings cell notes ({App ID: ...}) from Outgoings!A1:AV111 and save OutgNotes grid
  const outgoingsRowData = outgoingsMetaResp?.data?.sheets?.[0]?.data?.[0]?.rowData || [];
  const outgNotesGrid = [];
  for (let rIdx = 0; rIdx < outgoingsRowData.length; rIdx++) {
    const vals = outgoingsRowData[rIdx]?.values || [];
    const contractorLabel = String(vals[0]?.formattedValue || "").trim();
    const noteRow = [];
    for (let cIdx = 0; cIdx < vals.length; cIdx++) {
      const noteText = String(vals[cIdx]?.note || "").trim();
      noteRow.push(noteText);
      if (noteText && noteText.includes("App ID:")) {
        const blocks = noteText.split(/---+/).map((b) => b.trim()).filter(Boolean);
        for (const blk of blocks) {
          const idMatch = blk.match(/App ID:\s*([^\r\n}]+)/i);
          const amtMatch = blk.match(/Amount:\s*[£$€]?([-\d,.]+)/i);
          const vatMatch = blk.match(/VAT:\s*[£$€]?([-\d,.]+)/i);
          const stMatch = blk.match(/Status:\s*([^\r\n]+)/i);
          const dateMatch = blk.match(/Date:\s*([^\r\n]+)/i);
          if (idMatch) {
            confirmedDirectCosts.push({
              location: "Outgoings",
              client: "",
              job: contractorLabel,
              description: contractorLabel,
              netAmount: amtMatch ? parseNumeric_(amtMatch[1]) : 0,
              vatAmount: vatMatch ? parseNumeric_(vatMatch[1]) : 0,
              recDate: dateMatch ? dateMatch[1].trim() : "",
              payDate: "",
              status: stMatch ? stMatch[1].trim() : "Sent",
              appId: idMatch[1].trim(),
              cellRef: `${colIdx0ToLetter(cIdx)}${rIdx + 1}`,
            });
          }
        }
      }
    }
    outgNotesGrid.push(noteRow);
  }

  if (outgNotesGrid.length > 0) {
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "OutgNotes",
        values_grid: outgNotesGrid,
        formulas_grid: outgNotesGrid,
        row_count: outgNotesGrid.length,
        col_count: 48,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  // 2. Fetch existing InvComp and DirComp grids from Supabase so we preserve rows 1..5 (headers & metadata)
  //    and check if native accounting_invoices / accounting_direct_costs rows exist
  const [{ data: dbInvoices }, { data: dbCosts }, { data: existingGrids }] = await Promise.all([
    supabase.from("accounting_invoices").select("*").eq("client_name", ctx.clientName),
    supabase.from("accounting_direct_costs").select("*").eq("client_name", ctx.clientName),
    supabase
      .from("master_sheet_grids")
      .select("tab_name, values_grid, formulas_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .in("tab_name", ["InvComp", "DirComp"]),
  ]);

  let invDiscrepancyCount = 0;
  let dirDiscrepancyCount = 0;

  const existingInvComp = (existingGrids || []).find((g) => g.tab_name === "InvComp")?.values_grid || [];
  const existingDirComp = (existingGrids || []).find((g) => g.tab_name === "DirComp")?.values_grid || [];

  // Recompute InvComp if we have accounting_invoices in Supabase
  if (Array.isArray(dbInvoices) && dbInvoices.length > 0) {
    const byInvNo = new Map();
    for (const item of confirmedInvoices) {
      if (!item.invoiceNo) continue;
      const k = item.invoiceNo.toLowerCase().replace(/^#/, "");
      if (!byInvNo.has(k)) byInvNo.set(k, []);
      byInvNo.get(k).push(item);
    }

    const topRows = existingInvComp.slice(0, 5);
    while (topRows.length < 5) topRows.push([]);
    if (topRows[4].length < 25) {
      topRows[4] = [
        "Client",
        "Job",
        "Invoice amount",
        "Total excl VAT",
        "VAT included",
        "Invoice number",
        "Inv sent date",
        "Due date",
        "Fully paid on",
        "Inv status",
        "Currency",
        "",
        "Invoice no",
        "Client",
        "Amount",
        "Sent date",
        "Paid date",
        "Status",
        "Missing invoice?",
        "Client mismatch",
        "Inv amt mismatch?",
        "Sent date mismatch?",
        "Duplicate inv no ?",
        "Fully paid on mismatch?",
        "Status mismatch?",
      ];
    }

    const maxDataRows = Math.max(dbInvoices.length, confirmedInvoices.length);
    const dataRows = [];

    for (let i = 0; i < maxDataRows; i++) {
      const row = new Array(56).fill("");
      const acc = dbInvoices[i];
      if (acc) {
        const invKey = String(acc.invoice_number || "").trim().toLowerCase().replace(/^#/, "");
        const matchedList = invKey ? byInvNo.get(invKey) || [] : [];
        const matched = matchedList[0] || null;

        row[0] = acc.contact_name || "";
        row[1] = acc.description || "";
        row[2] = String(acc.total ?? 0);
        row[3] = String(acc.sub_total ?? 0);
        row[4] = String(acc.tax_total ?? 0);
        row[5] = acc.invoice_number || "";
        row[6] = acc.issue_date || "";
        row[7] = acc.due_date || "";
        row[8] = acc.fully_paid_date || "";
        row[9] = acc.status || "Sent";
        row[10] = acc.currency_code || "GBP";

        if (!matched) {
          row[18] = "1"; // Missing invoice?
          invDiscrepancyCount++;
        } else {
          const sumNet = matchedList.reduce((s, m) => s + m.netAmount, 0);
          row[12] = matched.invoiceNo;
          row[13] = matched.client;
          row[14] = String(sumNet);
          row[15] = matched.sentDate;
          row[16] = matched.paidDate;
          row[17] = matched.status;

          const amtDiff = Math.abs(Number(acc.sub_total || 0) - sumNet);
          if (amtDiff > 1.0) row[20] = "1"; // Inv amt mismatch?
          if (matchedList.length > 1) row[22] = "1"; // Duplicate inv no ?
          if (
            String(acc.status || "").toLowerCase() !== String(matched.status || "").toLowerCase() &&
            !(acc.status === "Sent" && matched.status === "Overdue")
          ) {
            row[24] = "1"; // Status mismatch?
          }
          if ([18, 19, 20, 21, 23, 24].some((idx) => row[idx] === "1")) {
            invDiscrepancyCount++;
          }
        }
      }

      const spItem = confirmedInvoices[i];
      if (spItem) {
        row[45] = spItem.client;
        row[46] = spItem.job;
        row[47] = String(spItem.grossAmount);
        row[48] = String(spItem.netAmount);
        row[49] = String(spItem.vatAmount);
        row[50] = spItem.invoiceNo;
        row[51] = spItem.sentDate;
        row[52] = spItem.paidDate;
        row[53] = spItem.status;
        row[54] = spItem.invSeq;
        row[55] = spItem.cellRef;
      }

      dataRows.push(row);
    }

    const nextInvCompGrid = [...topRows, ...dataRows];
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "InvComp",
        values_grid: nextInvCompGrid,
        formulas_grid: nextInvCompGrid,
        row_count: nextInvCompGrid.length,
        col_count: 56,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  // Recompute DirComp if we have accounting_direct_costs in Supabase
  if (Array.isArray(dbCosts) && dbCosts.length > 0) {
    const byAppId = new Map();
    for (const item of confirmedDirectCosts) {
      if (!item.appId) continue;
      const k = item.appId.trim().toLowerCase();
      if (!byAppId.has(k)) byAppId.set(k, []);
      byAppId.get(k).push(item);
    }

    const topRows = existingDirComp.slice(0, 5);
    while (topRows.length < 5) topRows.push([]);
    if (topRows[4].length < 48) {
      const h = new Array(48).fill("");
      h[0] = "Date";
      h[1] = "Description";
      h[2] = "Net";
      h[3] = "Reference";
      h[4] = "Account Name";
      h[5] = "Status";
      h[6] = "App ID";
      h[7] = "Date Paid";
      h[8] = "VAT";
      h[9] = "Gross";
      h[40] = "Missing cost?";
      h[41] = "Duplicate app ID?";
      h[42] = "Descr mismatch?";
      h[43] = "Amount mismatch?";
      h[44] = "VAT mismatch?";
      h[45] = "Rec date mismatch?";
      h[46] = "Pay date mismatch?";
      h[47] = "Status mismatch?";
      topRows[4] = h;
    }

    const dataRows = [];
    for (let i = 0; i < dbCosts.length; i++) {
      const cost = dbCosts[i];
      const row = new Array(48).fill("");
      const appIdKey = String(cost.external_id || "").trim().toLowerCase();
      const matchedList = appIdKey ? byAppId.get(appIdKey) || [] : [];
      const matched = matchedList[0] || null;

      row[0] = cost.txn_date || "";
      row[1] = cost.description || cost.supplier_name || "";
      row[2] = String(cost.net_amount ?? 0);
      row[3] = cost.reference || "";
      row[4] = cost.account_name || "";
      row[5] = cost.status || "Sent";
      row[6] = cost.external_id || "";
      row[7] = cost.paid_date || "";
      row[8] = String(cost.vat_amount ?? 0);
      row[9] = String(cost.gross_amount ?? 0);
      row[10] = cost.due_date || "";
      row[11] = cost.supplier_name || "";

      if (!matched) {
        row[40] = "1"; // Missing cost?
        dirDiscrepancyCount++;
      } else {
        const sumNet = matchedList.reduce((s, m) => s + m.netAmount, 0);
        row[23] = matched.location;
        row[24] = matched.description;
        row[25] = String(sumNet);
        row[26] = String(matched.vatAmount);
        row[27] = matched.recDate;
        row[28] = matched.payDate;
        row[29] = matched.status;
        row[30] = matched.appId;
        row[31] = matched.cellRef;

        if (matchedList.length > 1) row[41] = "1";
        if (Math.abs(Number(cost.net_amount || 0) - sumNet) > 1.0) row[43] = "1";
        if ([40, 42, 43, 44, 45, 46, 47].some((idx) => row[idx] === "1")) {
          dirDiscrepancyCount++;
        }
      }
      dataRows.push(row);
    }

    const nextDirCompGrid = [...topRows, ...dataRows];
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "DirComp",
        values_grid: nextDirCompGrid,
        formulas_grid: nextDirCompGrid,
        row_count: nextDirCompGrid.length,
        col_count: 48,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  invalidateMasterEngineCache(ctx.clientName);

  return {
    success: true,
    clientName: ctx.clientName,
    confirmedInvoicesScanned: confirmedInvoices.length,
    confirmedDirectCostsScanned: confirmedDirectCosts.length,
    invDiscrepancyCount,
    dirDiscrepancyCount,
  };
}

/**
 * Runs a native Next.js Master Sync (invoice, expense, crm, or all) for a client in master_mode = 'supabase'
 */
export async function runNativeMasterSync({
  sheets,
  clientName = "APPTEST",
  syncType = "all",
  userEmail = "System",
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const session = await resolveActiveAccountingSession_(ctx);
  const results = {
    clientName: ctx.clientName,
    syncType,
    accountingConnected: Boolean(session),
    accountingTool: session?.tool || "none",
    invoicesPulled: 0,
    directCostsPulled: 0,
    comparisons: null,
  };

  if (session && (syncType === "invoice" || syncType === "all")) {
    results.invoicesPulled = await pullLiveAccountingInvoicesToSupabase_(ctx, session);
    await supabase
      .from("sync_schedules")
      .update({
        last_inv_run: new Date().toISOString(),
        inv_status: `Synced (${results.invoicesPulled} invoices)`,
      })
      .eq("client_name", ctx.clientName);
  }

  if (session && (syncType === "expense" || syncType === "all")) {
    results.directCostsPulled = await pullLiveAccountingDirectCostsToSupabase_(ctx, session);
    await supabase
      .from("sync_schedules")
      .update({
        last_exp_run: new Date().toISOString(),
        exp_status: `Synced (${results.directCostsPulled} bills)`,
      })
      .eq("client_name", ctx.clientName);
  }

  if (syncType === "crm" || syncType === "all") {
    await supabase
      .from("sync_schedules")
      .update({
        last_crm_run: new Date().toISOString(),
        crm_status: "Synced (Supabase engine)",
      })
      .eq("client_name", ctx.clientName);
  }

  // Always recompute InvComp & DirComp comparisons against Client Sheet
  results.comparisons = await recomputeClientComparisonsInSupabase(sheets, ctx.clientName);

  await logPmaActivity(sheets, {
    clientName: ctx.clientName,
    category: "SYNC",
    action: `Native Supabase sync (${syncType})`,
    summary: `Completed native Supabase ${syncType} sync for ${ctx.clientName} (${results.invoicesPulled} invoices, ${results.directCostsPulled} direct costs)`,
    details: results,
    user: userEmail,
  }).catch(() => { });

  return results;
}

