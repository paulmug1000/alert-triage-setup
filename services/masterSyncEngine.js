import { randomUUID } from "crypto";
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
import { refreshGoogleSheetTokens } from "./googleSheetService.js";
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

    if (ctx.clientSheetId) {
      const safeOutgNotesGrid = outgNotesGrid.slice(0, 111).map((row) =>
        Array.from({ length: 48 }, (_, c) => {
          const v = String(row?.[c] || "");
          return /^[\s'’]*[=+\-@]/.test(v) ? "'" + v.replace(/^[\s'’]+/, "") : v;
        })
      );
      await sheets.spreadsheets.values
        .update({
          spreadsheetId: ctx.clientSheetId,
          range: `OutgNotes!A1:AV${safeOutgNotesGrid.length}`,
          valueInputOption: "RAW",
          requestBody: { values: safeOutgNotesGrid },
          _bypassSupabaseVirtualSheet: true,
        })
        .catch(() => {});
    }
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

  // Update DataChgAlert summary flags in Supabase master_sheet_grids so flag sweeps & status checks see live counts
  try {
    const { data: dcaRow } = await supabase
      .from("master_sheet_grids")
      .select("values_grid, formulas_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "DataChgAlert")
      .maybeSingle();
    if (dcaRow && Array.isArray(dcaRow.values_grid)) {
      const grid = dcaRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : []));
      while (grid.length < 10) grid.push([]);
      // Ensure B4:I4 GAS locks are clear
      if (!grid[3]) grid[3] = [];
      for (let c = 1; c <= 8; c++) grid[3][c] = "";
      await supabase.from("master_sheet_grids").upsert(
        {
          client_id: ctx.clientId,
          client_name: ctx.clientName,
          sheet_role: "master",
          tab_name: "DataChgAlert",
          values_grid: grid,
          formulas_grid: grid,
          row_count: grid.length,
          col_count: Math.max(60, ...grid.map((r) => r.length)),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_name,sheet_role,tab_name" }
      );
    }
  } catch (dcaErr) {
    console.warn(`[masterSyncEngine] DataChgAlert update warning for ${ctx.clientName}:`, dcaErr.message);
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

function isAutoExpensePlaceholderId_(id) {
  const s = String(id || "").trim();
  return /^place-exp/i.test(s) || /^placeholder/i.test(s) || /^auto-/i.test(s);
}

function parseCellDate_(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "number") {
    if (val > 25000 && val < 90000) {
      return new Date(Math.round((val - 25569) * 86400000));
    }
    return null;
  }
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 25000 && n < 90000) {
      return new Date(Math.round((n - 25569) * 86400000));
    }
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number);
    return new Date(y, m - 1, 1);
  }
  const mYMatch = s.match(/^([A-Za-z]{3,9})[\s-]+(\d{2,4})$/);
  if (mYMatch) {
    const mNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mIdx = mNames.indexOf(mYMatch[1].slice(0, 3).toLowerCase());
    if (mIdx !== -1) {
      let yr = parseInt(mYMatch[2], 10);
      if (yr < 100) yr += 2000;
      return new Date(yr, mIdx, 1);
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatSheetDateStr_(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${dateObj.getDate()}-${months[dateObj.getMonth()]}-${String(dateObj.getFullYear()).slice(-2)}`;
}

async function appendVirtualAutoLog_(ctx, stage, message, details = "") {
  try {
    const supabase = getSupabaseAdmin();
    const { data: logRow } = await supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "AutoLog")
      .maybeSingle();
    const grid = Array.isArray(logRow?.values_grid) ? logRow.values_grid.map((r) => [...r]) : [["Timestamp", "Stage", "Message", "Details"]];
    if (grid.length === 0) grid.push(["Timestamp", "Stage", "Message", "Details"]);
    const header = grid[0];
    const body = grid.slice(1);
    body.unshift([new Date().toISOString(), stage, message, details]);
    const trimmed = [header, ...body.slice(0, 199)];
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "AutoLog",
        values_grid: trimmed,
        formulas_grid: trimmed,
        row_count: trimmed.length,
        col_count: 4,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  } catch (_) {}
}

/**
 * 1A. Process Part-Paid Invoices & Resolved Part-Paid Balances on Confirmed
 */
export async function processPartPaidInvoicesNative(sheets, ctx) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientSheetId) return { splitCount: 0, resolvedCount: 0 };

  const [{ data: invRows }, confResp] = await Promise.all([
    supabase
      .from("accounting_invoices")
      .select("*")
      .eq("client_id", ctx.clientId)
      .gt("amount_paid", 0.005),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Confirmed!A1:BJ2000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const invoices = invRows || [];
  if (invoices.length === 0) return { splitCount: 0, resolvedCount: 0 };

  const confGrid = confResp.data.values || [];
  const slotDefs = [
    { num: 1, amtIdx: 41, noIdx: 42, dateIdx: 43, daysIdx: 44, statIdx: 45, amtCol: "AP", noCol: "AQ", dateCol: "AR", daysCol: "AS", statCol: "AT" },
    { num: 2, amtIdx: 48, noIdx: 49, dateIdx: 50, daysIdx: 51, statIdx: 52, amtCol: "AW", noCol: "AX", dateCol: "AY", daysCol: "AZ", statCol: "BA" },
    { num: 3, amtIdx: 55, noIdx: 56, dateIdx: 57, daysIdx: 58, statIdx: 59, amtCol: "BD", noCol: "BE", dateCol: "BF", daysCol: "BG", statCol: "BH" },
  ];

  const batchData = [];
  let splitCount = 0;
  let resolvedCount = 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minExpectedPayDate =
    today.getDate() >= 28
      ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
      : new Date(today.getFullYear(), today.getMonth(), 28);

  for (const inv of invoices) {
    const invNo = String(inv.invoice_number || "").trim();
    if (!invNo) continue;
    const invNoUpper = invNo.toUpperCase();
    const amountPaid = Number(inv.amount_paid || 0);
    const amountDue = Number(inv.amount_due || 0);
    const grossTotal = Number(inv.total || amountPaid + amountDue);
    const netTotal = Number(inv.sub_total || grossTotal);
    const netRatio = grossTotal > 0.005 ? netTotal / grossTotal : 1;
    const netPaid = Math.round(amountPaid * netRatio * 100) / 100;
    const netDue = Math.round(amountDue * netRatio * 100) / 100;

    // Pass 1: Active part-paid invoice (both paid > 0 and due > 0)
    if (amountPaid > 0.005 && amountDue > 0.005) {
      let matchedRowIdx = -1;
      let matchedSlot = null;
      let alreadyHasBalanceSlot = false;

      for (let r = 5; r < confGrid.length; r++) {
        const row = confGrid[r] || [];
        for (const s of slotDefs) {
          const cellNo = String(row[s.noIdx] || "").trim().toUpperCase();
          const cellStat = String(row[s.statIdx] || "").trim().toLowerCase();
          if (cellNo === invNoUpper) {
            if (cellStat === "part-paid (balance)") {
              alreadyHasBalanceSlot = true;
            } else if (!matchedSlot) {
              matchedRowIdx = r;
              matchedSlot = s;
            }
          }
        }
      }

      if (alreadyHasBalanceSlot || matchedRowIdx === -1 || !matchedSlot) continue;

      const row = confGrid[matchedRowIdx] || [];
      const rowNum = matchedRowIdx + 1;
      const emptySlot = slotDefs.find((s) => {
        if (s.num === matchedSlot.num) return false;
        const a = parseNumeric_(row[s.amtIdx]);
        const n = String(row[s.noIdx] || "").trim();
        return Math.abs(a) < 0.005 && !n;
      });
      if (!emptySlot) continue;

      const origSendDate = parseCellDate_(row[matchedSlot.dateIdx]) || parseCellDate_(inv.issue_date) || today;
      const paidDate = parseCellDate_(inv.fully_paid_date) || origSendDate;
      const origDays = parseInt(row[matchedSlot.daysIdx], 10);
      const baseDays = !isNaN(origDays) && origDays >= 0 ? origDays : 30;
      const minDaysForExpected = Math.max(0, Math.ceil((minExpectedPayDate.getTime() - origSendDate.getTime()) / 86400000));
      const balanceDays = Math.max(baseDays, minDaysForExpected);

      // Update original slot to Paid (netPaid)
      batchData.push({
        range: `Confirmed!${matchedSlot.amtCol}${rowNum}:${matchedSlot.statCol}${rowNum}`,
        values: [[netPaid, invNo, formatSheetDateStr_(paidDate), 0, "Paid"]],
      });
      // Populate empty slot with Part-paid (balance)
      batchData.push({
        range: `Confirmed!${emptySlot.amtCol}${rowNum}:${emptySlot.statCol}${rowNum}`,
        values: [[netDue, invNo, formatSheetDateStr_(origSendDate), balanceDays, "Part-paid (balance)"]],
      });
      splitCount++;
    } else if (amountPaid > 0.005 && amountDue <= 0.005) {
      // Pass 2: Now fully paid -> check if a Part-paid (balance) slot exists and resolve it to Paid
      for (let r = 5; r < confGrid.length; r++) {
        const row = confGrid[r] || [];
        const rowNum = r + 1;
        for (const s of slotDefs) {
          const cellNo = String(row[s.noIdx] || "").trim().toUpperCase();
          const cellStat = String(row[s.statIdx] || "").trim().toLowerCase();
          if (cellNo === invNoUpper && cellStat === "part-paid (balance)") {
            const paidDate = parseCellDate_(inv.fully_paid_date) || today;
            const sendDate = parseCellDate_(row[s.dateIdx]) || paidDate;
            const daysToPay = Math.max(0, Math.round((paidDate.getTime() - sendDate.getTime()) / 86400000));
            batchData.push({
              range: `Confirmed!${s.daysCol}${rowNum}:${s.statCol}${rowNum}`,
              values: [[daysToPay, "Paid"]],
            });
            resolvedCount++;
          }
        }
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  return { splitCount, resolvedCount };
}

/**
 * 1B. Auto-write matched invoice statuses & paid dates onto Confirmed (PushInvDetailsToConfirmed equivalent)
 */
export async function pushMatchedInvoicesToConfirmedNative(sheets, ctx) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientSheetId) return { updatedCount: 0 };

  const [{ data: invRows }, confResp] = await Promise.all([
    supabase.from("accounting_invoices").select("*").eq("client_id", ctx.clientId),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Confirmed!A1:BJ2000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const invoices = invRows || [];
  if (invoices.length === 0) return { updatedCount: 0 };

  const byInvNo = new Map();
  for (const inv of invoices) {
    const key = String(inv.invoice_number || "").trim().toUpperCase();
    if (key) byInvNo.set(key, inv);
  }

  const confGrid = confResp.data.values || [];
  const slotDefs = [
    { num: 1, amtIdx: 41, noIdx: 42, dateIdx: 43, daysIdx: 44, statIdx: 45, daysCol: "AS", statCol: "AT" },
    { num: 2, amtIdx: 48, noIdx: 49, dateIdx: 50, daysIdx: 51, statIdx: 52, daysCol: "AZ", statCol: "BA" },
    { num: 3, amtIdx: 55, noIdx: 56, dateIdx: 57, daysIdx: 58, statIdx: 59, daysCol: "BG", statCol: "BH" },
  ];

  const batchData = [];
  let updatedCount = 0;

  for (let r = 5; r < confGrid.length; r++) {
    const row = confGrid[r] || [];
    const rowNum = r + 1;
    for (const s of slotDefs) {
      const cellNo = String(row[s.noIdx] || "").trim().toUpperCase();
      if (!cellNo || cellNo.startsWith("PLACEHOLDER")) continue;
      const matchedInv = byInvNo.get(cellNo);
      if (!matchedInv) continue;

      const curStatus = String(row[s.statIdx] || "").trim();
      if (curStatus.toLowerCase() === "part-paid (balance)") continue;

      // Do not auto-mark Paid if invoice still has an unpaid balance (part-paid)
      const isPartPaid = Number(matchedInv.amount_paid || 0) > 0.005 && Number(matchedInv.amount_due || 0) > 0.005;
      if (isPartPaid) continue;

      const targetStatus = normalizeStatus_(matchedInv.status);
      if (targetStatus === "Paid" && curStatus.toLowerCase() !== "paid") {
        const sendDate = parseCellDate_(row[s.dateIdx]) || parseCellDate_(matchedInv.issue_date);
        const paidDate = parseCellDate_(matchedInv.fully_paid_date);
        let newDays = row[s.daysIdx];
        if (sendDate && paidDate) {
          newDays = Math.max(0, Math.round((paidDate.getTime() - sendDate.getTime()) / 86400000));
        }
        batchData.push({
          range: `Confirmed!${s.daysCol}${rowNum}:${s.statCol}${rowNum}`,
          values: [[newDays ?? 0, "Paid"]],
        });
        updatedCount++;
      } else if (targetStatus === "Sent" && !curStatus) {
        batchData.push({
          range: `Confirmed!${s.statCol}${rowNum}`,
          values: [["Sent"]],
        });
        updatedCount++;
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  return { updatedCount };
}

/**
 * 1C. Advance Stale Unsent Invoice Dates on Confirmed (updateStaleUnsentInvoices equivalent)
 * Unsent invoices (status === "") whose projected pay date (sendDate + daysToPay) falls in the current month
 * have their SEND date moved to the 28th of the current month (or 1st of next month if today >= 28).
 */
export async function updateStaleUnsentInvoicesNative(sheets, ctx) {
  if (!ctx?.clientSheetId) return { updatedCount: 0 };

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: ctx.clientSheetId,
    range: "Confirmed!AP6:BH2000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) return { updatedCount: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const currentMonthStart = new Date(currentYear, currentMonth, 1);
  const currentMonthEnd = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);
  const targetSendDate =
    today.getDate() >= 28
      ? new Date(currentYear, currentMonth + 1, 1)
      : new Date(currentYear, currentMonth, 28);
  const targetDateStr = formatSheetDateStr_(targetSendDate);

  const slots = [
    { amtIdx: 0, dateIdx: 2, daysIdx: 3, statIdx: 4, dateCol: "AR" },
    { amtIdx: 7, dateIdx: 9, daysIdx: 10, statIdx: 11, dateCol: "AY" },
    { amtIdx: 14, dateIdx: 16, daysIdx: 17, statIdx: 18, dateCol: "BF" },
  ];

  const batchData = [];
  let updatedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const rowNum = i + 6;
    for (const s of slots) {
      const amt = parseNumeric_(r[s.amtIdx]);
      if (amt <= 0) continue;
      const status = String(r[s.statIdx] || "").trim();
      if (status !== "") continue;

      const sendDate = parseCellDate_(r[s.dateIdx]);
      if (!sendDate || sendDate >= targetSendDate) continue;

      const daysNum = parseFloat(r[s.daysIdx]);
      const daysToPay = !isNaN(daysNum) ? daysNum : 0;
      const projectedPayDate = new Date(sendDate.getFullYear(), sendDate.getMonth(), sendDate.getDate() + daysToPay);

      if (projectedPayDate >= currentMonthStart && projectedPayDate <= currentMonthEnd) {
        batchData.push({
          range: `Confirmed!${s.dateCol}${rowNum}`,
          values: [[targetDateStr]],
        });
        updatedCount++;
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  return { updatedCount };
}

/**
 * 1D. Extend Overdue Invoices' Days to Pay on Confirmed (updateOverdueInvoicesInConfirmed equivalent)
 * If DataChgAlert!B47 === "Yes", unpaid invoices whose expected payment date is before currentMonthStart
 * have their daysToPay extended so expected payment lands on the 5th of the current month.
 */
export async function updateOverdueInvoicesInConfirmedNative(sheets, ctx) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientSheetId) return { updatedCount: 0, enabled: false };

  const { data: dcaRow } = await supabase
    .from("master_sheet_grids")
    .select("values_grid")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .eq("tab_name", "DataChgAlert")
    .maybeSingle();

  const b47Val = String(dcaRow?.values_grid?.[46]?.[1] || "").trim().toLowerCase();
  if (b47Val !== "yes") {
    return { updatedCount: 0, enabled: false };
  }

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: ctx.clientSheetId,
    range: "Confirmed!AP6:BH2000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) return { updatedCount: 0, enabled: true };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fifthOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 5);

  const slots = [
    { dateIdx: 2, daysIdx: 3, statIdx: 4, daysCol: "AS" },
    { dateIdx: 9, daysIdx: 10, statIdx: 11, daysCol: "AZ" },
    { dateIdx: 16, daysIdx: 17, statIdx: 18, daysCol: "BG" },
  ];

  const batchData = [];
  let updatedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const rowNum = i + 6;
    for (const s of slots) {
      const status = String(r[s.statIdx] || "").trim().toLowerCase();
      if (status !== "" && status !== "sent" && status !== "draft" && status !== "part-paid (balance)") continue;

      const sendDate = parseCellDate_(r[s.dateIdx]);
      if (!sendDate) continue;

      const daysNum = parseFloat(r[s.daysIdx]);
      const currentDays = !isNaN(daysNum) ? daysNum : 0;
      const expectedPayDate = new Date(sendDate.getTime() + currentDays * 86400000);
      expectedPayDate.setHours(0, 0, 0, 0);

      if (expectedPayDate < currentMonthStart) {
        const newDays = Math.ceil((fifthOfCurrentMonth.getTime() - sendDate.getTime()) / 86400000);
        if (newDays !== currentDays) {
          batchData.push({
            range: `Confirmed!${s.daysCol}${rowNum}`,
            values: [[newDays]],
          });
          updatedCount++;
        }
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  return { updatedCount, enabled: true };
}

/**
 * 2A. Auto-update matched Direct Cost bills on Confirmed (PushExpDetails equivalent for matched App IDs)
 */
export async function pushMatchedDirectCostsNative(sheets, ctx) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !ctx?.clientSheetId) return { updatedCount: 0 };

  const [{ data: costRows }, confResp] = await Promise.all([
    supabase.from("accounting_direct_costs").select("*").eq("client_id", ctx.clientId),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Confirmed!A1:CR2000",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const costs = costRows || [];
  if (costs.length === 0) return { updatedCount: 0 };

  const byAppId = new Map();
  for (const c of costs) {
    const id = String(c.app_id || "").trim();
    if (id) byAppId.set(id, c);
  }

  const confGrid = confResp.data.values || [];
  const dcSlots = [
    { num: 1, dateIdx: 78, daysIdx: 79, statIdx: 80, idIdx: 81, daysCol: "CB", statCol: "CC" },
    { num: 2, dateIdx: 85, daysIdx: 86, statIdx: 87, idIdx: 88, daysCol: "CI", statCol: "CJ" },
    { num: 3, dateIdx: 92, daysIdx: 93, statIdx: 94, idIdx: 95, daysCol: "CP", statCol: "CQ" },
  ];

  const batchData = [];
  let updatedCount = 0;

  for (let r = 5; r < confGrid.length; r++) {
    const row = confGrid[r] || [];
    const rowNum = r + 1;
    for (const s of dcSlots) {
      const appId = String(row[s.idIdx] || "").trim();
      if (!appId || isAutoExpensePlaceholderId_(appId)) continue;
      const matched = byAppId.get(appId);
      if (!matched) continue;

      const curStatus = String(row[s.statIdx] || "").trim();
      const isPartPaid = Number(matched.amount_paid || 0) > 0.005 && Number(matched.amount_due || 0) > 0.005;
      if (isPartPaid) continue;

      const targetStatus = normalizeStatus_(matched.status);
      if (targetStatus === "Paid" && curStatus.toLowerCase() !== "paid") {
        const recDate = parseCellDate_(row[s.dateIdx]) || parseCellDate_(matched.bill_date);
        const paidDate = parseCellDate_(matched.paid_date);
        let newDays = row[s.daysIdx];
        if (recDate && paidDate) {
          newDays = Math.max(0, Math.round((paidDate.getTime() - recDate.getTime()) / 86400000));
        }
        batchData.push({
          range: `Confirmed!${s.daysCol}${rowNum}:${s.statCol}${rowNum}`,
          values: [[newDays ?? 0, "Paid"]],
        });
        updatedCount++;
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  return { updatedCount };
}

/**
 * 2B. Refresh Chart of Accounts natively from Xero/QuickBooks into Supabase KeyInfo (Col AW) + Client Sheet KeyInfo
 */
export async function refreshNativeChartOfAccounts(sheets, clientName) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const session = await resolveActiveAccountingSession_(ctx);
  if (!session) throw new Error(`No active accounting connection found for "${clientName}".`);

  const accounts = await withAccountingAccessToken_(ctx, session, async (accessToken, rec) => {
    if (session.tool === "xero") {
      const resp = await fetch("https://api.xero.com/api.xro/2.0/Accounts", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": rec.tenantId,
          Accept: "application/json",
        },
      });
      if (!resp.ok) throw new Error(`Xero Accounts API (${resp.status}): ${await resp.text()}`);
      const data = await resp.json();
      const expClasses = new Set(["EXPENSE", "DIRECTCOSTS", "OVERHEADS"]);
      const expTypes = new Set(["EXPENSE", "DIRECTCOSTS", "OVERHEADS", "DEPRECIATN"]);
      return (data?.Accounts || [])
        .filter((a) => a.Status === "ACTIVE" && (expClasses.has(a.Class) || expTypes.has(a.Type)))
        .map((a) => String(a.Name || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    } else {
      const q = "select * from Account where Active = true maxresults 1000";
      const url = `https://quickbooks.api.intuit.com/v3/company/${rec.realmId}/query?query=${encodeURIComponent(q)}&minorversion=73`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      if (!resp.ok) throw new Error(`QuickBooks Account API (${resp.status}): ${await resp.text()}`);
      const data = await resp.json();
      const expTypes = new Set(["Expense", "Cost of Goods Sold", "Other Expense"]);
      return (data?.QueryResponse?.Account || [])
        .filter((a) => expTypes.has(a.AccountType))
        .map((a) => String(a.FullyQualifiedName || a.Name || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    }
  });

  const uniqueAccounts = Array.from(new Set(accounts));

  // Update KeyInfo grid in Supabase master_sheet_grids (Col AW = index 48)
  const { data: kiRow } = await supabase
    .from("master_sheet_grids")
    .select("values_grid, formulas_grid")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .eq("tab_name", "KeyInfo")
    .maybeSingle();

  const grid = Array.isArray(kiRow?.values_grid) ? kiRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : [])) : [[]];
  const maxRows = Math.max(grid.length, uniqueAccounts.length + 5);
  while (grid.length < maxRows) grid.push([]);
  if (!grid[0][48]) grid[0][48] = "Chart of Accounts (Expenses)";
  for (let r = 1; r < grid.length; r++) {
    grid[r][48] = r - 1 < uniqueAccounts.length ? uniqueAccounts[r - 1] : "";
  }

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "KeyInfo",
      values_grid: grid,
      formulas_grid: grid,
      row_count: grid.length,
      col_count: Math.max(60, ...grid.map((r) => r.length)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  // Also mirror to Client Sheet KeyInfo!AW2:AW500 if sheets client is available
  if (sheets && ctx.clientSheetId) {
    try {
      const colValues = Array.from({ length: Math.max(uniqueAccounts.length, 200) }, (_, idx) => [uniqueAccounts[idx] || ""]);
      await sheets.spreadsheets.values.update({
        spreadsheetId: ctx.clientSheetId,
        range: `KeyInfo!AW2:AW${colValues.length + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: colValues },
      });
    } catch (_) {}
  }

  invalidateMasterEngineCache(ctx.clientName);
  return { success: true, categories: uniqueAccounts };
}

/**
 * 2C. Pull 12-Month Profit & Loss from Xero/QuickBooks into Supabase (PLFromApp, accounting_pl_lines, PLComp, KeyInfo!BE)
 */
export async function pullLivePLToSupabaseNative(sheets, clientName) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx) throw new Error(`Client "${clientName}" not found.`);

  const session = await resolveActiveAccountingSession_(ctx);
  if (!session) throw new Error(`No active accounting connection found for "${clientName}".`);

  // Build 12 completed trailing calendar months
  const today = new Date();
  const months = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let i = 12; i >= 1; i--) {
    const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const end = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    months.push({
      startDate: toIso(start),
      endDate: toIso(end),
      monthKey: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: `${monthNames[start.getMonth()]} ${start.getFullYear()}`,
    });
  }

  const allCategories = new Map();
  const categoryOrder = [];
  const ensureCat = (name, isHeader = false) => {
    const clean = String(name || "").trim();
    if (!clean) return null;
    if (!allCategories.has(clean)) {
      allCategories.set(clean, { isHeader, values: {} });
      categoryOrder.push(clean);
    }
    return allCategories.get(clean);
  };

  await withAccountingAccessToken_(ctx, session, async (accessToken, rec) => {
    if (session.tool === "xero") {
      // Fetch in 3 batches of 4 months to respect Xero's 5-concurrent-request limit
      for (let b = 0; b < months.length; b += 4) {
        const batch = months.slice(b, b + 4);
        await Promise.all(
          batch.map(async (m) => {
            const url = `https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${m.startDate}&toDate=${m.endDate}&standardLayout=false`;
            const resp = await fetch(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Xero-tenant-id": rec.tenantId,
                Accept: "application/json",
              },
            });
            if (!resp.ok) throw new Error(`Xero P&L API (${resp.status}): ${await resp.text()}`);
            const data = await resp.json();
            const reportRows = data?.Reports?.[0]?.Rows || [];
            for (const section of reportRows) {
              if (section.RowType === "Section") {
                if (section.Title) ensureCat(section.Title, true);
                if (Array.isArray(section.Rows)) {
                  for (const row of section.Rows) {
                    if (row.RowType === "Row" && row.Cells?.[0]?.Value) {
                      const cat = ensureCat(row.Cells[0].Value, false);
                      if (cat) cat.values[m.label] = parseNumeric_(row.Cells[1]?.Value);
                    } else if (row.RowType === "SummaryRow" && row.Cells?.[0]?.Value) {
                      const cat = ensureCat(row.Cells[0].Value, true);
                      if (cat) cat.values[m.label] = parseNumeric_(row.Cells[1]?.Value);
                    }
                  }
                }
              } else if (section.RowType === "Row" && section.Cells?.[0]?.Value) {
                const cat = ensureCat(section.Cells[0].Value, true);
                if (cat) cat.values[m.label] = parseNumeric_(section.Cells[1]?.Value);
              }
            }
          })
        );
      }
    } else {
      // QuickBooks ProfitAndLoss per month
      for (let b = 0; b < months.length; b += 4) {
        const batch = months.slice(b, b + 4);
        await Promise.all(
          batch.map(async (m) => {
            const url = `https://quickbooks.api.intuit.com/v3/company/${rec.realmId}/reports/ProfitAndLoss?start_date=${m.startDate}&end_date=${m.endDate}&minorversion=73`;
            const resp = await fetch(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
              },
            });
            if (!resp.ok) throw new Error(`QuickBooks P&L API (${resp.status}): ${await resp.text()}`);
            const data = await resp.json();
            const walkRows = (rows) => {
              if (!Array.isArray(rows)) return;
              for (const row of rows) {
                if (row.type === "Section") {
                  if (row.Header?.ColData?.[0]?.value) {
                    const hdr = ensureCat(row.Header.ColData[0].value, true);
                    if (hdr && row.Header.ColData[1]?.value !== undefined && row.Header.ColData[1]?.value !== "") {
                      hdr.values[m.label] = parseNumeric_(row.Header.ColData[1].value);
                    }
                  }
                  if (row.Rows?.Row) walkRows(row.Rows.Row);
                  if (row.Summary?.ColData?.[0]?.value) {
                    const sum = ensureCat(row.Summary.ColData[0].value, true);
                    if (sum) sum.values[m.label] = parseNumeric_(row.Summary.ColData[1]?.value);
                  }
                } else if (row.type === "Data" && row.ColData?.[0]?.value) {
                  const cat = ensureCat(row.ColData[0].value, false);
                  if (cat) cat.values[m.label] = parseNumeric_(row.ColData[1]?.value);
                }
              }
            };
            walkRows(data?.Rows?.Row || []);
          })
        );
      }
    }
  });

  // Build PLFromApp 2D grid
  const headerRow = ["Description", ...months.map((m) => m.label)];
  const plGrid = [headerRow];
  const plLineRecords = [];
  const nonHeaderCategories = [];

  for (const catName of categoryOrder) {
    const info = allCategories.get(catName);
    const row = [catName];
    for (const m of months) {
      const val = info.values[m.label];
      if (info.isHeader && val === undefined) {
        row.push("");
      } else {
        const num = val || 0;
        row.push(num);
        if (!info.isHeader && Math.abs(num) > 0.001) {
          plLineRecords.push({
            client_id: ctx.clientId,
            client_name: ctx.clientName,
            account_name: catName,
            section_name: "P&L",
            month_key: m.monthKey,
            amount: num,
            synced_at: new Date().toISOString(),
          });
        }
      }
    }
    plGrid.push(row);
    if (!info.isHeader) nonHeaderCategories.push(catName);
  }

  // Upsert PLFromApp into master_sheet_grids
  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "PLFromApp",
      values_grid: plGrid,
      formulas_grid: plGrid,
      row_count: plGrid.length,
      col_count: headerRow.length,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  if (plLineRecords.length > 0) {
    try {
      await supabase
        .from("accounting_pl_lines")
        .upsert(plLineRecords, { onConflict: "client_id,account_name,month_key" });
    } catch (_) {}
  }

  // Update KeyInfo!BE (index 56) & PLComp in master_sheet_grids
  const [{ data: kiRow }, { data: plCompRow }, { data: unrecRows }] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "KeyInfo")
      .maybeSingle(),
    supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "PLComp")
      .maybeSingle(),
    supabase
      .from("bank_recon_items")
      .select("*")
      .eq("client_id", ctx.clientId)
      .eq("item_type", "unreconciled_pl_add"),
  ]);

  if (kiRow && Array.isArray(kiRow.values_grid)) {
    const kiGrid = kiRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : []));
    while (kiGrid.length < nonHeaderCategories.length + 5) kiGrid.push([]);
    for (let r = 1; r < kiGrid.length; r++) {
      kiGrid[r][56] = r - 1 < nonHeaderCategories.length ? nonHeaderCategories[r - 1] : "";
    }
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "KeyInfo",
        values_grid: kiGrid,
        formulas_grid: kiGrid,
        row_count: kiGrid.length,
        col_count: Math.max(60, ...kiGrid.map((r) => r.length)),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
  }

  // Update PLComp grid for the latest 6 completed months (months[6..11])
  const last6Months = months.slice(6);
  const plCompGrid = Array.isArray(plCompRow?.values_grid)
    ? plCompRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : []))
    : [];
  while (plCompGrid.length < 200) plCompGrid.push([]);
  if (!plCompGrid[0]) plCompGrid[0] = [];
  plCompGrid[0][2] = new Date().toISOString(); // C1 last pull timestamp

  for (let mIdx = 0; mIdx < 6; mIdx++) {
    const lbl = last6Months[mIdx]?.label || "";
    plCompGrid[0][5 + mIdx] = lbl;  // F1:K1
    plCompGrid[0][19 + mIdx] = lbl; // T1:Y1
  }

  // Build map of unreconciled PL adds by category (lower) and month label
  const unrecByCatMonth = new Map();
  for (const item of unrecRows || []) {
    const cat = String(item.category || "").trim().toLowerCase();
    const tabName = String(item.tab_name || "").trim();
    if (!cat || !tabName) continue;
    // Match tabName ("Jan 26" or "Jan 2026") to month label ("Jan 2026")
    const d = parseCellDate_(tabName);
    const mLabel = d ? `${monthNames[d.getMonth()]} ${d.getFullYear()}` : tabName;
    const key = `${cat}||${mLabel}`;
    unrecByCatMonth.set(key, (unrecByCatMonth.get(key) || 0) + Number(item.net_amount || 0));
  }

  // Update values for every category already present in PLComp col E (index 4) or col S (index 18)
  const updatePlCompSection = (startRow0, endRow0) => {
    const colTotalsStd = [0, 0, 0, 0, 0, 0];
    const colTotalsAdd = [0, 0, 0, 0, 0, 0];
    for (let r = startRow0; r <= endRow0 && r < plCompGrid.length; r++) {
      const row = plCompGrid[r] || [];
      const catName = String(row[4] || row[18] || "").trim();
      if (!catName) continue;
      if (/^total\s/i.test(catName)) {
        for (let mIdx = 0; mIdx < 6; mIdx++) {
          row[5 + mIdx] = Math.round(colTotalsStd[mIdx] * 100) / 100;
          row[19 + mIdx] = Math.round(colTotalsAdd[mIdx] * 100) / 100;
        }
        break;
      }
      row[4] = catName;
      row[18] = catName;
      const plCat = allCategories.get(catName);
      for (let mIdx = 0; mIdx < 6; mIdx++) {
        const mLabel = last6Months[mIdx]?.label || "";
        const stdVal = plCat ? Number(plCat.values[mLabel] || 0) : 0;
        const unrecVal = unrecByCatMonth.get(`${catName.toLowerCase()}||${mLabel}`) || 0;
        const addVal = Math.round((stdVal + unrecVal) * 100) / 100;
        row[5 + mIdx] = stdVal;
        row[19 + mIdx] = addVal;
        colTotalsStd[mIdx] += stdVal;
        colTotalsAdd[mIdx] += addVal;
      }
      plCompGrid[r] = row;
    }
  };

  updatePlCompSection(29, 49);  // CoS (rows 30-50)
  updatePlCompSection(51, 61);  // Non-Op Income (rows 52-62)
  updatePlCompSection(64, 74);  // Non-Op Expenses (rows 65-75)
  updatePlCompSection(88, 195); // Overheads (rows 89+)

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "PLComp",
      values_grid: plCompGrid,
      formulas_grid: plCompGrid,
      row_count: plCompGrid.length,
      col_count: 26,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  invalidateMasterEngineCache(ctx.clientName);
  return {
    success: true,
    categories: nonHeaderCategories,
    months: months.map((m) => m.label),
  };
}

/**
 * 2D. Push Outgoings from Supabase PLComp to Client Sheet Outgoings tab
 * (Port of pushOutgoingsToClientSheet & pushOutgoingsWithPLAddsToClientSheet)
 */
export async function pushOutgoingsToClientSheetNative(
  sheets,
  clientName,
  { includeUnreconciled = false, selectedMonths = null } = {}
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientSheetId) throw new Error(`Client sheet not found for "${clientName}".`);

  const { data: plCompRow } = await supabase
    .from("master_sheet_grids")
    .select("values_grid")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .eq("tab_name", "PLComp")
    .maybeSingle();

  const plGrid = plCompRow?.values_grid || [];
  if (plGrid.length < 89) {
    throw new Error("P&L comparison data is not yet initialized for this client.");
  }

  const baseCol = includeUnreconciled ? 19 : 5; // T=19..Y=24 vs F=5..K=10
  const catCol = includeUnreconciled ? 18 : 4;  // S=18 vs E=4
  const headerRow = plGrid[0] || [];
  const checkRow = plGrid[86] || []; // Row 87 (0-indexed 86)

  const activeMonthIndices = [];
  for (let i = 0; i < 6; i++) {
    const colIdx = baseCol + i;
    const isChecked = checkRow[colIdx] === true || String(checkRow[colIdx] || "").toUpperCase() === "TRUE";
    if (isChecked || (Array.isArray(selectedMonths) && selectedMonths.length > 0)) {
      const d = parseCellDate_(headerRow[colIdx]);
      if (d) {
        const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (isChecked || (Array.isArray(selectedMonths) && selectedMonths.includes(mKey))) {
          activeMonthIndices.push({ offset: i, colIdx, date: d, monthKey: mKey });
        }
      }
    }
  }

  if (activeMonthIndices.length === 0) {
    return { success: true, monthsPushed: 0, message: "No months selected to push." };
  }

  // Read Client Sheet Outgoings (values & formulas)
  const [valResp, formResp] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Outgoings!A1:AZ260",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Outgoings!A1:AZ260",
      valueRenderOption: "FORMULA",
    }),
  ]);

  const outVals = valResp.data.values || [];
  const outForms = formResp.data.values || [];
  const outHeader = outVals[0] || [];

  // Map activeMonthIndices to Outgoings column indices (index >= 6)
  const mappedMonths = [];
  for (const m of activeMonthIndices) {
    let targetCol0 = -1;
    for (let c = 6; c < outHeader.length; c++) {
      const hd = parseCellDate_(outHeader[c]);
      if (hd && hd.getFullYear() === m.date.getFullYear() && hd.getMonth() === m.date.getMonth()) {
        targetCol0 = c;
        break;
      }
    }
    if (targetCol0 !== -1) {
      mappedMonths.push({ ...m, outCol0: targetCol0, outColLetter: colIdx0ToLetter(targetCol0) });
    }
  }

  if (mappedMonths.length === 0) {
    throw new Error("None of the selected P&L months match the date headers on the Outgoings tab.");
  }

  // Locate sections on Outgoings
  let otherExpStart0 = -1;
  let otherExpEnd0 = -1;
  let depRow0 = -1;
  let nonOpIncStart0 = -1;
  let nonOpIncEnd0 = -1;
  let nonOpExpStart0 = -1;
  let nonOpExpEnd0 = -1;

  for (let r = 0; r < outVals.length; r++) {
    const label = String(outVals[r]?.[0] || "").trim().toLowerCase();
    if (label === "other expenses") otherExpStart0 = r + 1;
    else if (label.startsWith("total other expenses") && otherExpEnd0 === -1) otherExpEnd0 = r - 1;
    else if (label === "depreciation expense") depRow0 = r;
    else if (label === "non-operating income") nonOpIncStart0 = r + 1;
    else if (label === "total non-operating income") nonOpIncEnd0 = r - 1;
    else if (label === "non-operating expenses") nonOpExpStart0 = r + 1;
    else if (label === "total non-operating expenses") nonOpExpEnd0 = r - 1;
  }

  // Extract PLComp sections
  const extractSection = (start0, maxEnd0, stopLabelRegex) => {
    const items = [];
    for (let r = start0; r <= Math.min(maxEnd0, plGrid.length - 1); r++) {
      const row = plGrid[r] || [];
      const name = String(row[catCol] || row[4] || "").trim();
      if (!name) continue;
      if (stopLabelRegex && stopLabelRegex.test(name)) break;
      const monthVals = {};
      for (const m of mappedMonths) {
        monthVals[m.outCol0] = parseNumeric_(row[m.colIdx]);
      }
      items.push({ name, monthVals });
    }
    return items;
  };

  const cosItems = extractSection(29, 48, /^total\s/i);
  const nonOpIncItems = extractSection(51, 60, /^total\s/i);
  const nonOpExpItems = extractSection(64, 73, /^total\s/i);
  const overheadItems = extractSection(88, 195, /^total overheads/i);

  let depMonthVals = null;
  for (let r = 70; r < Math.min(90, plGrid.length); r++) {
    const name = String(plGrid[r]?.[catCol] || plGrid[r]?.[4] || "").trim().toLowerCase();
    if (name === "depreciation total") {
      depMonthVals = {};
      for (const m of mappedMonths) {
        depMonthVals[m.outCol0] = parseNumeric_(plGrid[r]?.[m.colIdx]);
      }
      break;
    }
  }

  const batchData = [];

  const applyItemsToSection = (itemsWithDefaults, start0, end0) => {
    if (start0 === -1 || end0 === -1 || end0 < start0) return;
    const existingRowByCat = new Map();
    const emptyRows0 = [];
    for (let r = start0; r <= end0; r++) {
      const cName = String(outVals[r]?.[0] || "").trim();
      if (cName) existingRowByCat.set(cName.toLowerCase(), r);
      else emptyRows0.push(r);
    }

    const touchedRows0 = new Set();

    for (const item of itemsWithDefaults) {
      let targetRow0 = existingRowByCat.get(item.name.toLowerCase());
      if (targetRow0 === undefined) {
        const hasNonZero = Object.values(item.monthVals).some((v) => Math.abs(v) > 0.005);
        if (!hasNonZero || emptyRows0.length === 0) continue;
        targetRow0 = emptyRows0.shift();
        existingRowByCat.set(item.name.toLowerCase(), targetRow0);
        const rowNum = targetRow0 + 1;
        batchData.push({
          range: `Outgoings!A${rowNum}:F${rowNum}`,
          values: [[item.name, ...item.defaults]],
        });
      }
      touchedRows0.add(targetRow0);
      const rowNum = targetRow0 + 1;
      for (const m of mappedMonths) {
        const curFormula = String(outForms[targetRow0]?.[m.outCol0] || "");
        if (curFormula.startsWith("=")) continue;
        batchData.push({
          range: `Outgoings!${m.outColLetter}${rowNum}`,
          values: [[item.monthVals[m.outCol0] ?? 0]],
        });
      }
    }

    // Zero out existing categories in this section that were not in PLComp for the pushed months
    for (const [, r0] of existingRowByCat.entries()) {
      if (touchedRows0.has(r0)) continue;
      const rowNum = r0 + 1;
      for (const m of mappedMonths) {
        const curFormula = String(outForms[r0]?.[m.outCol0] || "");
        if (curFormula.startsWith("=")) continue;
        batchData.push({
          range: `Outgoings!${m.outColLetter}${rowNum}`,
          values: [[0]],
        });
      }
    }
  };

  const combinedMainItems = [
    ...overheadItems.map((it) => ({ ...it, defaults: ["Yes", "Curr", "Curr", "0%", "100%"] })),
    ...cosItems.map((it) => ({ ...it, defaults: ["No", "Curr", "Curr", "0%", "100%"] })),
  ];
  applyItemsToSection(combinedMainItems, otherExpStart0, otherExpEnd0);
  applyItemsToSection(
    nonOpIncItems.map((it) => ({ ...it, defaults: ["No", "Zero", "Zero", "0%", "100%"] })),
    nonOpIncStart0,
    nonOpIncEnd0
  );
  applyItemsToSection(
    nonOpExpItems.map((it) => ({ ...it, defaults: ["No", "Zero", "Zero", "0%", "100%"] })),
    nonOpExpStart0,
    nonOpExpEnd0
  );

  if (depRow0 !== -1 && depMonthVals) {
    const rowNum = depRow0 + 1;
    for (const m of mappedMonths) {
      const curFormula = String(outForms[depRow0]?.[m.outCol0] || "");
      if (!curFormula.startsWith("=")) {
        batchData.push({
          range: `Outgoings!${m.outColLetter}${rowNum}`,
          values: [[depMonthVals[m.outCol0] ?? 0]],
        });
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: batchData },
    });
  }

  // Uncheck F87:K87 and T87:Y87 in Supabase PLComp
  if (plGrid[86]) {
    for (let i = 0; i < 6; i++) {
      plGrid[86][5 + i] = false;
      plGrid[86][19 + i] = false;
    }
    await supabase.from("master_sheet_grids").upsert(
      {
        client_id: ctx.clientId,
        client_name: ctx.clientName,
        sheet_role: "master",
        tab_name: "PLComp",
        values_grid: plGrid,
        formulas_grid: plGrid,
        row_count: plGrid.length,
        col_count: 26,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_name,sheet_role,tab_name" }
    );
    invalidateMasterEngineCache(ctx.clientName);
  }

  return {
    success: true,
    monthsPushed: mappedMonths.length,
    months: mappedMonths.map((m) => m.monthKey),
  };
}

/**
 * 2E. Sync Expense Transaction Breakdown (Row 300 JSON) & Actual VAT (Rows 304-305) to Client Sheet Outgoings
 */
export async function syncExpenseBreakdownToClientSheetNative(sheets, clientName) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientSheetId) throw new Error(`Client sheet not found for "${clientName}".`);

  const [outResp, { data: reconMonths }, { data: reconItems }, { data: directCosts }] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Outgoings!A1:AZ305",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    supabase.from("bank_recon_months").select("*").eq("client_id", ctx.clientId),
    supabase.from("bank_recon_items").select("*").eq("client_id", ctx.clientId),
    supabase.from("accounting_direct_costs").select("*").eq("client_id", ctx.clientId),
  ]);

  const outGrid = outResp.data.values || [];
  const headerRow = outGrid[0] || [];
  if (headerRow.length < 7) return { success: true, updatedMonths: 0 };

  const monthColByKey = new Map();
  for (let c = 6; c < headerRow.length; c++) {
    const d = parseCellDate_(headerRow[c]);
    if (d) {
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthColByKey.set(mKey, { col0: c, colLetter: colIdx0ToLetter(c), date: d });
    }
  }

  // Group transactions by monthKey
  const txByMonth = new Map();
  const cashVatByMonth = new Map();
  const accrualVatByMonth = new Map();

  for (const dc of directCosts || []) {
    const billDate = parseCellDate_(dc.bill_date);
    if (billDate) {
      const mKey = `${billDate.getFullYear()}-${String(billDate.getMonth() + 1).padStart(2, "0")}`;
      const net = Number(dc.net_amount || 0);
      const vat = Number(dc.tax_amount || 0);
      accrualVatByMonth.set(mKey, (accrualVatByMonth.get(mKey) || 0) + vat);
      if (!txByMonth.has(mKey)) txByMonth.set(mKey, []);
      txByMonth.get(mKey).push({
        d: formatSheetDateStr_(billDate),
        c: String(dc.account_code || "Direct Costs"),
        s: String(dc.contact_name || ""),
        r: String(dc.description || dc.invoice_number || "").slice(0, 80),
        n: Math.round(net * 100) / 100,
        v: Math.round(vat * 100) / 100,
        g: Math.round((net + vat) * 100) / 100,
        p: normalizeStatus_(dc.status) === "Paid" ? 1 : 0,
      });
    }
    const paidDate = parseCellDate_(dc.paid_date);
    if (paidDate && normalizeStatus_(dc.status) === "Paid") {
      const pKey = `${paidDate.getFullYear()}-${String(paidDate.getMonth() + 1).padStart(2, "0")}`;
      cashVatByMonth.set(pKey, (cashVatByMonth.get(pKey) || 0) + Number(dc.tax_amount || 0));
    }
  }

  // Include unreconciled_pl_add items from bank_recon_items for finalized months
  const readyMonthsSet = new Set();
  for (const rm of reconMonths || []) {
    if (rm.is_month_ready) {
      const d = parseCellDate_(rm.tab_name);
      if (d) readyMonthsSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
  }

  for (const item of reconItems || []) {
    if (item.item_type !== "unreconciled_pl_add") continue;
    const d = parseCellDate_(item.tx_date) || parseCellDate_(item.tab_name);
    if (!d) continue;
    const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (readyMonthsSet.size > 0 && !readyMonthsSet.has(mKey)) continue;
    const net = Number(item.net_amount || 0);
    const gross = Number(item.gross_amount || net);
    const vat = Math.round((gross - net) * 100) / 100;
    if (!txByMonth.has(mKey)) txByMonth.set(mKey, []);
    txByMonth.get(mKey).push({
      d: formatSheetDateStr_(d),
      c: String(item.category || "Unreconciled"),
      s: String(item.contact_name || ""),
      r: String(item.reference || "").slice(0, 80),
      n: Math.round(net * 100) / 100,
      v: vat,
      g: Math.round(gross * 100) / 100,
      p: 1,
      u: true,
    });
  }

  const batchData = [
    { range: "Outgoings!A300", values: [["Transactions Breakdown (JSON)"]] },
    { range: "Outgoings!A304", values: [["Actual VAT on expenses (Cash basis)"]] },
    { range: "Outgoings!A305", values: [["Actual VAT on expenses (Accrual basis)"]] },
  ];

  let updatedMonths = 0;
  for (const [mKey, colInfo] of monthColByKey.entries()) {
    const txList = txByMonth.get(mKey);
    if (txList && txList.length > 0) {
      batchData.push({
        range: `Outgoings!${colInfo.colLetter}300`,
        values: [[JSON.stringify(txList)]],
      });
      updatedMonths++;
    }
    if (cashVatByMonth.has(mKey)) {
      batchData.push({
        range: `Outgoings!${colInfo.colLetter}304`,
        values: [[Math.round(cashVatByMonth.get(mKey) * 100) / 100]],
      });
    }
    if (accrualVatByMonth.has(mKey)) {
      batchData.push({
        range: `Outgoings!${colInfo.colLetter}305`,
        values: [[Math.round(accrualVatByMonth.get(mKey) * 100) / 100]],
      });
    }
  }

  if (batchData.length > 3) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ctx.clientSheetId,
      requestBody: { valueInputOption: "RAW", data: batchData },
    });
  }

  return { success: true, updatedMonths };
}

/**
 * 3A. Pull Live CRM Deals into Supabase (DataFromCRM & CRMGoogleBridge)
 * Supports Google Sheet CRM via OAuth token in Vault (or Service Account fallback).
 */
export async function pullLiveCrmDealsToSupabaseNative(sheets, ctx) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { dealsPulled: 0 };

  const { data: kiRow } = await supabase
    .from("master_sheet_grids")
    .select("values_grid")
    .eq("client_name", ctx.clientName)
    .eq("sheet_role", "master")
    .eq("tab_name", "KeyInfo")
    .maybeSingle();

  const kiGrid = kiRow?.values_grid || [];
  const crmTool = String(kiGrid[7]?.[16] || kiGrid[7]?.[1] || "None").trim(); // Q8 or B8
  if (!crmTool || crmTool.toLowerCase() === "none") {
    return { dealsPulled: 0, crmTool: "None" };
  }

  // Support Google Sheet external CRM source (KeyInfo!X11:X14)
  if (crmTool.toLowerCase() === "google sheet") {
    const sourceUrl = String(kiGrid[10]?.[23] || kiGrid[13]?.[23] || "").trim(); // X11 (or legacy X14)
    const sourceTab = String(kiGrid[11]?.[23] || kiGrid[14]?.[23] || "Sheet1").trim(); // X12
    const matchColsStr = String(kiGrid[12]?.[23] || "").trim(); // X13
    const headerRowNum = parseInt(kiGrid[13]?.[23], 10) || 1; // X14
    const mMatch = sourceUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sourceSheetId = mMatch ? mMatch[1] : sourceUrl;

    if (sourceSheetId && sourceTab) {
      let extRows = null;

      // 1. Try Pulse Vault OAuth token for 'googlesheet' first
      const gsRec = await getIntegrationTokens({
        clientKey: ctx.clientName,
        masterSheetId: ctx.masterSheetId,
        tool: "googlesheet",
      });

      if (gsRec && (gsRec.tokens?.accessToken || gsRec.tokens?.refreshToken)) {
        let accessToken = gsRec.tokens?.accessToken;
        const fetchWithToken = async (tok) => {
          const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
            sourceSheetId
          )}/values/${encodeURIComponent(sourceTab)}?valueRenderOption=FORMATTED_VALUE`;
          return fetch(apiUrl, {
            headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" },
          });
        };

        let resp = accessToken ? await fetchWithToken(accessToken) : null;
        if ((!resp || resp.status === 401 || resp.status === 403) && gsRec.tokens?.refreshToken) {
          const refreshed = await refreshGoogleSheetTokens(gsRec.tokens.refreshToken);
          accessToken = refreshed.accessToken;
          const updatedTokens = {
            ...gsRec.tokens,
            accessToken: refreshed.accessToken,
            expiresAt: Date.now() + (refreshed.expiresIn || 3600) * 1000,
          };
          await updateRefreshedTokens({
            clientKey: ctx.clientName,
            masterSheetId: ctx.masterSheetId,
            tool: "googlesheet",
            tokens: updatedTokens,
          });
          resp = await fetchWithToken(accessToken);
        }

        if (resp && resp.ok) {
          const json = await resp.json();
          extRows = json.values || [];
        }
      }

      // 2. Fallback to Google Cloud Service Account if shared directly
      if (!extRows && sheets) {
        const extResp = await sheets.spreadsheets.values.get({
          spreadsheetId: sourceSheetId,
          range: `${sourceTab}!A1:AZ2000`,
          valueRenderOption: "FORMATTED_VALUE",
        });
        extRows = extResp.data.values || [];
      }

      if (Array.isArray(extRows) && extRows.length >= headerRowNum) {
        const headerIdx = Math.max(0, headerRowNum - 1);
        const rawHeaders = [...(extRows[headerIdx] || [])].map((h) => String(h || "").trim());
        const dataRows = extRows
          .slice(headerIdx + 1)
          .filter((r) => Array.isArray(r) && r.some((c) => String(c || "").trim() !== ""));

        // Load existing DataFromCRM to preserve persistent Project code / System ID UUIDs across syncs
        const { data: oldDfcRow } = await supabase
          .from("master_sheet_grids")
          .select("values_grid")
          .eq("client_name", ctx.clientName)
          .eq("sheet_role", "master")
          .eq("tab_name", "DataFromCRM")
          .maybeSingle();

        const oldDfcGrid = oldDfcRow?.values_grid || [];
        const oldHeaders = (oldDfcGrid[0] || []).map((h) => String(h || "").trim());
        const normHead = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

        let uuidColIdx = rawHeaders.findIndex(
          (h) => normHead(h) === "projectcode" || normHead(h) === "systemiddonotedit"
        );
        const oldUuidColIdx = oldHeaders.findIndex(
          (h) => normHead(h) === "projectcode" || normHead(h) === "systemiddonotedit"
        );

        let idxClient = rawHeaders.findIndex((h) => /^(?:client|lead|org|company|customer)/i.test(normHead(h)));
        let idxJob = rawHeaders.findIndex((h, i) => i !== idxClient && /^(?:job|deal|opportunity|task|title|name|nature)/i.test(normHead(h)));
        let idxRev = rawHeaders.findIndex((h) => /^(?:value|amount|revenue|total|deal|fee)/i.test(normHead(h)));
        let idxStart = rawHeaders.findIndex((h) => /^(?:start|month|target|live|date)/i.test(normHead(h)));

        if (matchColsStr) {
          const parts = matchColsStr.split(",").map((s) => normHead(s));
          if (parts[0]) {
            const f = rawHeaders.findIndex((h) => normHead(h) === parts[0]);
            if (f !== -1) idxClient = f;
          }
          if (parts[1]) {
            const f = rawHeaders.findIndex((h) => normHead(h) === parts[1]);
            if (f !== -1) idxJob = f;
          }
          if (parts[2]) {
            const f = rawHeaders.findIndex((h) => normHead(h) === parts[2]);
            if (f !== -1) idxRev = f;
          }
        }
        if (idxClient === -1) idxClient = 0;
        if (idxJob === -1) idxJob = Math.min(1, rawHeaders.length - 1);

        if (uuidColIdx === -1) {
          uuidColIdx = rawHeaders.length;
          rawHeaders.push("System ID (Do Not Edit)");
        }

        // Build lookup of existing UUIDs by (clientLower + jobLower) from oldDfcGrid
        const existingUuidsByKey = new Map();
        if (oldUuidColIdx !== -1 && oldDfcGrid.length > 1) {
          const oldClientIdx = oldHeaders.findIndex((h) => /^(?:client|lead|org|company|customer)/i.test(normHead(h)));
          const oldJobIdx = oldHeaders.findIndex((h, i) => i !== oldClientIdx && /^(?:job|deal|opportunity|task|title|name|nature)/i.test(normHead(h)));
          for (let r = 1; r < oldDfcGrid.length; r++) {
            const oRow = oldDfcGrid[r] || [];
            const u = String(oRow[oldUuidColIdx] || "").trim();
            if (!u) continue;
            const c = String(oRow[oldClientIdx !== -1 ? oldClientIdx : 0] || "").trim().toLowerCase();
            const j = String(oRow[oldJobIdx !== -1 ? oldJobIdx : 1] || "").trim().toLowerCase();
            if (c || j) existingUuidsByKey.set(`${c}|||${j}`, u);
          }
        }

        const crmGrid = [rawHeaders];
        for (const r of dataRows) {
          const row = [...r];
          while (row.length <= uuidColIdx) row.push("");
          if (!String(row[uuidColIdx] || "").trim()) {
            const c = String(row[idxClient] || "").trim().toLowerCase();
            const j = String(row[idxJob] || "").trim().toLowerCase();
            const preserved = existingUuidsByKey.get(`${c}|||${j}`);
            row[uuidColIdx] = preserved || randomUUID();
          }
          crmGrid.push(row);
        }

        await Promise.all([
          supabase.from("master_sheet_grids").upsert(
            {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: "DataFromCRM",
              values_grid: crmGrid,
              formulas_grid: crmGrid,
              row_count: crmGrid.length,
              col_count: rawHeaders.length,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_name,sheet_role,tab_name" }
          ),
          supabase.from("master_sheet_grids").upsert(
            {
              client_id: ctx.clientId,
              client_name: ctx.clientName,
              sheet_role: "master",
              tab_name: "CRMGoogleBridge",
              values_grid: crmGrid,
              formulas_grid: crmGrid,
              row_count: crmGrid.length,
              col_count: rawHeaders.length,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "client_name,sheet_role,tab_name" }
          ),
        ]);

        invalidateMasterEngineCache(ctx.clientName);
        return { dealsPulled: crmGrid.length - 1, crmTool };
      }
    }
  }

  return { dealsPulled: 0, crmTool };
}

/**
 * 3B. Recompute CRMComp in Supabase master_sheet_grids for the requested mode ("Pipeline" or "Confirmed")
 * Compares DataFromCRM deals against the Client Sheet's Pipeline or Confirmed tab and populates:
 * - CRMComp!B2 (mode)
 * - CRMComp!X6:BF1000 (CRM deals vs Sheet jobs + 8 discrepancy flags)
 * - CRMComp!DM6:DU1000 (Sheet jobs list for mode)
 * - CRMComp!EF6:FL1000 (Sheet jobs vs CRM deals + 8 reverse discrepancy flags)
 */
export async function recomputeCrmComparisonInSupabase(sheets, clientName, requestedMode = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !sheets) return { success: false };

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientSheetId) return { success: false };

  const [{ data: dfcRow }, { data: crmCompRow }, clientTabsResp] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "DataFromCRM")
      .maybeSingle(),
    supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "CRMComp")
      .maybeSingle(),
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: ctx.clientSheetId,
      ranges: ["Pipeline!A1:DD500", "Confirmed!A1:AN1000"],
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const dfcGrid = dfcRow?.values_grid || [];
  const crmCompGrid = Array.isArray(crmCompRow?.values_grid)
    ? crmCompRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : []))
    : [];
  while (crmCompGrid.length < 300) crmCompGrid.push([]);
  if (!crmCompGrid[1]) crmCompGrid[1] = [];

  const mode = requestedMode || String(crmCompGrid[1]?.[1] || "Pipeline").trim() || "Pipeline";
  crmCompGrid[1][1] = mode; // CRMComp!B2
  crmCompGrid[1][4] = true; // CRMComp!E2 = TRUE

  const cutoffDate = parseCellDate_(crmCompGrid[1]?.[2]); // CRMComp!C2

  // Parse DataFromCRM rows (row 0 = headers)
  const dfcHeaders = (dfcGrid[0] || []).map((h) => String(h || "").trim().toLowerCase());
  const findDfcCol = (regex, fallbackIdx) => {
    const idx = dfcHeaders.findIndex((h) => regex.test(h));
    return idx !== -1 ? idx : fallbackIdx;
  };
  const cIdxClient = findDfcCol(/^(?:client|company|customer|account)/i, 0);
  const cIdxJob = findDfcCol(/^(?:job|deal|opportunity|project\s*name|title)/i, 1);
  const cIdxCode = findDfcCol(/^(?:project\s*code|system\s*id|code|uuid|id)/i, 2);
  const cIdxRev = findDfcCol(/^(?:revenue|value|amount|fee)/i, 3);
  const cIdxDc = findDfcCol(/^(?:direct\s*costs|cost)/i, 4);
  const cIdxStart = findDfcCol(/^(?:start\s*date|start)/i, 5);
  const cIdxEnd = findDfcCol(/^(?:end\s*date|end|close)/i, 6);
  const cIdxLike = findDfcCol(/^(?:likelihood|prob|%)/i, 7);
  const cIdxStatus = findDfcCol(/^(?:status|stage)/i, 8);
  const cIdxType = findDfcCol(/^(?:project\s*\/\s*retainer|type)/i, 9);
  const cIdxLead = findDfcCol(/^(?:lead\s*source|source)/i, 10);
  const cIdxAdded = findDfcCol(/^(?:date\s*added|created)/i, 11);
  const cIdxProd = findDfcCol(/^(?:product\s*line|product)/i, 12);

  const crmDeals = [];
  const crmByCode = new Map();
  const crmByName = new Map();

  for (let r = 1; r < dfcGrid.length; r++) {
    const row = dfcGrid[r] || [];
    const client = String(row[cIdxClient] || "").trim();
    const job = String(row[cIdxJob] || "").trim();
    if (!client && !job) continue;
    const code = String(row[cIdxCode] || "").trim();
    const rev = String(row[cIdxRev] || "0").trim();
    const dc = String(row[cIdxDc] || "0.00").trim();
    const startDate = String(row[cIdxStart] || "").trim();
    const endDate = String(row[cIdxEnd] || "").trim();
    const likely = String(row[cIdxLike] || "").trim();
    const status = String(row[cIdxStatus] || "").trim();
    const projType = String(row[cIdxType] || "Project").trim();
    const leadSrc = String(row[cIdxLead] || "").trim();
    const dateAdded = String(row[cIdxAdded] || "").trim();
    const prodLine = String(row[cIdxProd] || "").trim();

    const deal = {
      client,
      job,
      code,
      rev,
      revNum: parseNumeric_(rev),
      dc,
      dcNum: parseNumeric_(dc),
      startDate,
      startObj: parseCellDate_(startDate),
      endDate,
      endObj: parseCellDate_(endDate),
      likely,
      likelyNum: parseNumeric_(String(likely).replace("%", "")),
      status,
      projType,
      leadSrc,
      dateAdded,
      prodLine,
    };

    crmDeals.push(deal);
    if (code) crmByCode.set(code.toLowerCase(), deal);
    crmByName.set(`${client.toLowerCase()}|||${job.toLowerCase()}`, deal);
  }

  // Parse Client Sheet jobs from Pipeline (mode === "Pipeline") or Confirmed (mode === "Confirmed")
  const rawSheetRows =
    mode === "Confirmed"
      ? clientTabsResp.data.valueRanges?.[1]?.values || []
      : clientTabsResp.data.valueRanges?.[0]?.values || [];

  const sheetJobs = [];
  const sheetByCode = new Map();
  const sheetByName = new Map();

  for (let r = 1; r < rawSheetRows.length; r++) {
    const row = rawSheetRows[r] || [];
    const client = String(row[0] || "").trim();
    const job = String(row[1] || "").trim();
    if (!client && !job) continue;
    const code = String(row[2] || "").trim();
    const dateAdded = String(row[3] || "").trim();
    const leadSrc = String(row[4] || "").trim();
    const rev = String(row[32] || "0").trim(); // AG
    const dc = String(row[33] || "0").trim();  // AH
    const vat = String(row[34] || "Yes").trim(); // AI
    const projType = String(row[35] || "Project").trim(); // AJ
    const prodLine = String(row[36] || "").trim(); // AK
    const startDate = String(row[37] || "").trim(); // AL
    const endDate = String(row[38] || "").trim();   // AM
    const likely = mode === "Confirmed" ? "100%" : String(row[39] || "").trim(); // AN
    const copiedToConf = mode === "Confirmed" ? "Yes" : String(row[107] || "").trim(); // DD

    const sj = {
      client,
      job,
      code,
      dateAdded,
      leadSrc,
      rev,
      revNum: parseNumeric_(rev),
      dc,
      dcNum: parseNumeric_(dc),
      vat,
      projType,
      prodLine,
      startDate,
      startObj: parseCellDate_(startDate),
      endDate,
      endObj: parseCellDate_(endDate),
      likely,
      likelyNum: parseNumeric_(String(likely).replace("%", "")),
      copiedToConf,
    };
    sheetJobs.push(sj);
    if (code) sheetByCode.set(code.toLowerCase(), sj);
    sheetByName.set(`${client.toLowerCase()}|||${job.toLowerCase()}`, sj);
  }

  // Filter CRM deals for X6:BF (startDate >= cutoffDate if cutoffDate exists)
  const filteredCrmDeals = crmDeals.filter((d) => {
    if (cutoffDate && d.startObj && d.startObj < cutoffDate) return false;
    if (mode === "Confirmed") {
      return d.likelyNum >= 100 || /won|confirmed|closed\s*won/i.test(d.status);
    }
    return d.likelyNum > 0;
  });

  // Filter Sheet jobs for EF6:FL (startDate >= cutoffDate if cutoffDate exists)
  const filteredSheetJobs = sheetJobs.filter((sj) => {
    if (cutoffDate && sj.startObj && sj.startObj < cutoffDate) return false;
    return true;
  });

  const sameDate = (d1, d2, s1, s2) => {
    if (d1 && d2) {
      return (
        d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate()
      );
    }
    return String(s1 || "").trim().toLowerCase() === String(s2 || "").trim().toLowerCase();
  };

  const maxRows = Math.max(crmDeals.length, filteredCrmDeals.length, sheetJobs.length, filteredSheetJobs.length, 100);
  while (crmCompGrid.length < maxRows + 6) crmCompGrid.push([]);

  let dashDiscrCount = 0;
  let appDiscrCount = 0;

  for (let i = 0; i < crmCompGrid.length - 5; i++) {
    const rIdx = 5 + i; // Row 6+ (0-indexed 5+)
    const row = crmCompGrid[rIdx] || [];
    while (row.length < 170) row.push("");

    // 1. Cols A..M (0..12): All CRM deals
    const rawDeal = crmDeals[i];
    if (rawDeal) {
      const vals = [
        rawDeal.client,
        rawDeal.job,
        rawDeal.code,
        rawDeal.rev,
        rawDeal.dc,
        rawDeal.startDate,
        rawDeal.endDate,
        rawDeal.likely,
        rawDeal.status,
        rawDeal.projType,
        rawDeal.leadSrc,
        rawDeal.dateAdded,
        rawDeal.prodLine,
      ];
      for (let c = 0; c < 13; c++) row[c] = vals[c];
    } else {
      for (let c = 0; c < 13; c++) row[c] = "";
    }

    // 2. Cols X..BF (23..57): Filtered CRM deals vs Sheet jobs
    const fDeal = filteredCrmDeals[i];
    if (fDeal) {
      const vals = [
        fDeal.client,
        fDeal.job,
        fDeal.code,
        fDeal.rev,
        fDeal.dc,
        fDeal.startDate,
        fDeal.endDate,
        fDeal.likely,
        fDeal.status,
        fDeal.projType,
        fDeal.leadSrc,
        fDeal.dateAdded,
        fDeal.prodLine,
      ];
      for (let c = 0; c < 13; c++) row[23 + c] = vals[c];

      const matchedSj =
        (fDeal.code ? sheetByCode.get(fDeal.code.toLowerCase()) : null) ||
        sheetByName.get(`${fDeal.client.toLowerCase()}|||${fDeal.job.toLowerCase()}`) ||
        null;

      if (matchedSj) {
        row[40] = matchedSj.code || fDeal.code;
        row[41] = matchedSj.client;
        row[42] = matchedSj.job;
        row[43] = matchedSj.rev;
        row[44] = matchedSj.dc;
        row[45] = matchedSj.startDate;
        row[46] = matchedSj.endDate;
        row[47] = matchedSj.likely;
        row[48] = matchedSj.projType;
        row[49] = matchedSj.vat;

        row[50] = ""; // missing_job
        row[51] = matchedSj.client.toLowerCase() !== fDeal.client.toLowerCase() ? "1" : "";
        row[52] = matchedSj.job.toLowerCase() !== fDeal.job.toLowerCase() ? "1" : "";
        row[53] = Math.abs(matchedSj.revNum - fDeal.revNum) > 0.5 ? "1" : "";
        row[54] = Math.abs(matchedSj.dcNum - fDeal.dcNum) > 0.5 ? "1" : "";
        row[55] = !sameDate(matchedSj.startObj, fDeal.startObj, matchedSj.startDate, fDeal.startDate) ? "1" : "";
        row[56] = !sameDate(matchedSj.endObj, fDeal.endObj, matchedSj.endDate, fDeal.endDate) ? "1" : "";
        row[57] = mode !== "Confirmed" && Math.abs(matchedSj.likelyNum - fDeal.likelyNum) > 0.5 ? "1" : "";
      } else {
        for (let c = 40; c <= 49; c++) row[c] = "";
        row[50] = "1"; // missing_job
        for (let c = 51; c <= 57; c++) row[c] = "";
      }
      if ([50, 51, 52, 53, 54, 55, 56, 57].some((c) => row[c] === "1")) {
        dashDiscrCount++;
      }
    } else {
      for (let c = 23; c <= 57; c++) row[c] = "";
    }

    // 3. Cols DM..DY (116..128): All Sheet jobs for mode
    const sjAll = sheetJobs[i];
    if (sjAll) {
      row[116] = sjAll.client;
      row[117] = sjAll.job;
      row[118] = sjAll.code;
      row[119] = sjAll.rev;
      row[120] = sjAll.dc;
      row[121] = sjAll.startDate;
      row[122] = sjAll.endDate;
      row[123] = sjAll.likely;
      row[124] = sjAll.copiedToConf;
      row[125] = sjAll.dateAdded;
      row[126] = sjAll.leadSrc;
      row[127] = sjAll.projType;
      row[128] = sjAll.vat;
    } else {
      for (let c = 116; c <= 128; c++) row[c] = "";
    }

    // 4. Cols EF..FL (135..167): Filtered Sheet jobs vs CRM deals
    const fSj = filteredSheetJobs[i];
    if (fSj) {
      row[135] = fSj.client;
      row[136] = fSj.job;
      row[137] = fSj.code;
      row[138] = fSj.rev;
      row[139] = fSj.dc;
      row[140] = fSj.startDate;
      row[141] = fSj.endDate;
      row[142] = fSj.likely;
      row[143] = fSj.copiedToConf;
      row[144] = fSj.dateAdded;
      row[145] = fSj.leadSrc;
      row[146] = fSj.prodLine;
      row[147] = fSj.vat;

      const matchedDeal =
        (fSj.code ? crmByCode.get(fSj.code.toLowerCase()) : null) ||
        crmByName.get(`${fSj.client.toLowerCase()}|||${fSj.job.toLowerCase()}`) ||
        null;

      if (matchedDeal) {
        row[150] = matchedDeal.code || fSj.code;
        row[151] = matchedDeal.client;
        row[152] = matchedDeal.job;
        row[153] = matchedDeal.rev;
        row[154] = matchedDeal.dc;
        row[155] = matchedDeal.startDate;
        row[156] = matchedDeal.endDate;
        row[157] = matchedDeal.likely;
        row[158] = matchedDeal.status;
        row[159] = matchedDeal.projType;

        row[160] = ""; // missing in CRM
        row[161] = fSj.client.toLowerCase() !== matchedDeal.client.toLowerCase() ? "1" : "";
        row[162] = fSj.job.toLowerCase() !== matchedDeal.job.toLowerCase() ? "1" : "";
        row[163] = Math.abs(fSj.revNum - matchedDeal.revNum) > 0.5 ? "1" : "";
        row[164] = Math.abs(fSj.dcNum - matchedDeal.dcNum) > 0.5 ? "1" : "";
        row[165] = !sameDate(fSj.startObj, matchedDeal.startObj, fSj.startDate, matchedDeal.startDate) ? "1" : "";
        row[166] = !sameDate(fSj.endObj, matchedDeal.endObj, fSj.endDate, matchedDeal.endDate) ? "1" : "";
        row[167] = mode !== "Confirmed" && Math.abs(fSj.likelyNum - matchedDeal.likelyNum) > 0.5 ? "1" : "";
      } else {
        for (let c = 150; c <= 159; c++) row[c] = "";
        row[160] = "1"; // missing in CRM
        for (let c = 161; c <= 167; c++) row[c] = "";
      }
      if ([160, 161, 162, 163, 164, 165, 166, 167].some((c) => row[c] === "1")) {
        appDiscrCount++;
      }
    } else {
      for (let c = 135; c <= 167; c++) row[c] = "";
    }

    crmCompGrid[rIdx] = row;
  }

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "CRMComp",
      values_grid: crmCompGrid,
      formulas_grid: crmCompGrid,
      row_count: crmCompGrid.length,
      col_count: Math.max(170, ...crmCompGrid.map((r) => r.length)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  invalidateMasterEngineCache(ctx.clientName);
  return {
    success: true,
    mode,
    crmDealsCount: crmDeals.length,
    sheetJobsCount: sheetJobs.length,
    dashDiscrCount,
    appDiscrCount,
  };
}

/**
 * 4A. Native EoM Revenue Comparison (runRevenueComparison equivalent)
 * Reads Monthly tab directly from Client Sheet and fetches month revenue from Xero/QuickBooks into RevFromApp & RevComp in Supabase.
 */
export async function runNativeRevenueComparison(sheets, clientName, customTargetMonth = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase is not configured.");

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientSheetId) throw new Error(`Client "${clientName}" not found.`);

  let targetDate = null;
  if (customTargetMonth && /^\d{4}-\d{2}$/.test(String(customTargetMonth).trim())) {
    const [y, m] = String(customTargetMonth).trim().split("-").map(Number);
    targetDate = new Date(y, m - 1, 1);
  } else {
    const now = new Date();
    targetDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  }

  const year = targetDate.getFullYear();
  const month0 = targetDate.getMonth();
  const month1 = month0 + 1;
  const lastDay = new Date(year, month1, 0).getDate();
  const startIso = `${year}-${String(month1).padStart(2, "0")}-01`;
  const endIso = `${year}-${String(month1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const targetMonthKey = `${year}-${String(month1).padStart(2, "0")}`;
  const targetMonthLabel = targetDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  // 1. Read Dashboard revenue directly from Client Sheet's Monthly tab
  const monthlyResp = await sheets.spreadsheets.values.get({
    spreadsheetId: ctx.clientSheetId,
    range: "Monthly!A1:H2850",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const mRows = monthlyResp.data.values || [];
  let blockFound = false;
  let emptyStreak = 0;
  const dashboardData = [];

  for (let i = 0; i < mRows.length; i++) {
    const row = mRows[i] || [];
    const cellA = row[0];
    if (!blockFound) {
      const d = parseCellDate_(cellA);
      if (d && d.getFullYear() === year && d.getMonth() === month0) {
        blockFound = true;
      }
    } else {
      const client = String(cellA || "").trim();
      const job = String(row[1] || "").trim();
      const code = String(row[2] || "").trim();
      const rev = parseNumeric_(row[7]);
      if (!client && !job) {
        emptyStreak++;
        if (emptyStreak >= 3) break;
      } else {
        emptyStreak = 0;
        if (client.toLowerCase().includes("total") || job.toLowerCase().includes("total")) continue;
        if (Math.abs(rev) > 0.005) {
          dashboardData.push([client, job, code, rev]);
        }
      }
    }
  }

  // 2. Fetch Accounting Revenue for target month from Xero / QuickBooks
  const session = await resolveActiveAccountingSession_(ctx);
  let appData = [];

  if (session) {
    appData = await withAccountingAccessToken_(ctx, session, async (accessToken, rec) => {
      const results = [];
      if (session.tool === "xero") {
        const whereInv = `Type=="ACCREC" AND Status!="DELETED" AND Status!="VOIDED" AND Status!="DRAFT" AND Date>=DateTime(${year},${month1},1) AND Date<=DateTime(${year},${month1},${lastDay})`;
        const [invResp, btResp, accResp] = await Promise.all([
          fetch(`https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(whereInv)}`, {
            headers: { Authorization: `Bearer ${accessToken}`, "Xero-tenant-id": rec.tenantId, Accept: "application/json" },
          }),
          fetch(
            `https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(
              `Type=="RECEIVE" AND Status!="DELETED" AND Date>=DateTime(${year},${month1},1) AND Date<=DateTime(${year},${month1},${lastDay})`
            )}`,
            { headers: { Authorization: `Bearer ${accessToken}`, "Xero-tenant-id": rec.tenantId, Accept: "application/json" } }
          ),
          fetch("https://api.xero.com/api.xro/2.0/Accounts", {
            headers: { Authorization: `Bearer ${accessToken}`, "Xero-tenant-id": rec.tenantId, Accept: "application/json" },
          }),
        ]);

        const revenueCodes = new Set();
        if (accResp.ok) {
          const accJson = await accResp.json();
          for (const a of accJson?.Accounts || []) {
            if (a.Class === "REVENUE" || a.Type === "REVENUE" || a.Type === "SALES") {
              if (a.Code) revenueCodes.add(String(a.Code));
            }
          }
        }

        if (invResp.ok) {
          const invJson = await invResp.json();
          for (const inv of invJson?.Invoices || []) {
            const dStr = parseXeroDate(inv.Date, inv.DateString);
            const rate = parseNumeric_(inv.CurrencyRate) || 1;
            const lines = inv.LineItems || [];
            const desc = lines.map((l) => l.Description).filter(Boolean).join("; ") || inv.Reference || "";
            let revNet = 0;
            if (revenueCodes.size > 0 && lines.length > 0) {
              for (const l of lines) {
                if (!l.AccountCode || revenueCodes.has(String(l.AccountCode))) {
                  revNet += parseNumeric_(l.LineAmount);
                }
              }
            } else {
              revNet = parseNumeric_(inv.SubTotal);
            }
            const gbpNet = Math.round((revNet / rate) * 100) / 100;
            if (Math.abs(gbpNet) > 0.005) {
              results.push([
                dStr,
                inv.InvoiceNumber || inv.Reference || "",
                inv.Contact?.Name || "",
                desc,
                gbpNet,
                inv.CurrencyCode || "GBP",
                inv.Status || "",
                lines[0]?.ItemCode || "",
              ]);
            }
          }
        }

        if (btResp.ok && revenueCodes.size > 0) {
          const btJson = await btResp.json();
          for (const bt of btJson?.BankTransactions || []) {
            const rate = parseNumeric_(bt.CurrencyRate) || 1;
            const dStr = parseXeroDate(bt.Date, bt.DateString);
            for (const l of bt.LineItems || []) {
              if (l.AccountCode && revenueCodes.has(String(l.AccountCode))) {
                const gbpNet = Math.round((parseNumeric_(l.LineAmount) / rate) * 100) / 100;
                if (Math.abs(gbpNet) > 0.005) {
                  results.push([
                    dStr,
                    bt.Reference || "Bank Rec",
                    bt.Contact?.Name || "",
                    l.Description || "Direct Bank Receipt",
                    gbpNet,
                    bt.CurrencyCode || "GBP",
                    bt.Status || "",
                    l.ItemCode || "",
                  ]);
                }
              }
            }
          }
        }
      } else {
        // QuickBooks
        const queries = [
          `select * from Invoice where TxnDate >= '${startIso}' and TxnDate <= '${endIso}' maxresults 1000`,
          `select * from SalesReceipt where TxnDate >= '${startIso}' and TxnDate <= '${endIso}' maxresults 1000`,
          `select * from CreditMemo where TxnDate >= '${startIso}' and TxnDate <= '${endIso}' maxresults 1000`,
        ];
        const responses = await Promise.all(
          queries.map((q) =>
            fetch(`https://quickbooks.api.intuit.com/v3/company/${rec.realmId}/query?query=${encodeURIComponent(q)}&minorversion=73`, {
              headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            })
          )
        );
        const [invJson, srJson, cmJson] = await Promise.all(responses.map((r) => (r.ok ? r.json() : {})));

        const processQbTxns = (txns, sign, fallbackType) => {
          for (const tx of txns || []) {
            const rate = parseNumeric_(tx.ExchangeRate) || 1;
            const lines = (tx.Line || []).filter((l) => l.DetailType === "SalesItemLineDetail");
            const net = lines.reduce((s, l) => s + parseNumeric_(l.Amount), 0);
            const gbpNet = Math.round(net * rate * sign * 100) / 100;
            if (Math.abs(gbpNet) > 0.005) {
              results.push([
                tx.TxnDate || startIso,
                tx.DocNumber || fallbackType,
                tx.CustomerRef?.name || "",
                lines.map((l) => l.Description).filter(Boolean).join("; ") || tx.PrivateNote || "",
                gbpNet,
                tx.CurrencyRef?.value || "GBP",
                "Posted",
                "",
              ]);
            }
          }
        };
        processQbTxns(invJson?.QueryResponse?.Invoice, 1, "Invoice");
        processQbTxns(srJson?.QueryResponse?.SalesReceipt, 1, "Sales Receipt");
        processQbTxns(cmJson?.QueryResponse?.CreditMemo, -1, "Credit Memo");
      }
      return results;
    });
  }

  const revFromAppGrid = [
    ["Date", "Invoice Number", "Contact Name", "Description", "Net Amount", "Currency", "Status", "Item Code"],
    ...appData,
  ];

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "RevFromApp",
      values_grid: revFromAppGrid,
      formulas_grid: revFromAppGrid,
      row_count: revFromAppGrid.length,
      col_count: 8,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  const dashboardTotal = Math.round(dashboardData.reduce((s, r) => s + Number(r[3] || 0), 0) * 100) / 100;
  const accountingTotal = Math.round(appData.reduce((s, r) => s + Number(r[4] || 0), 0) * 100) / 100;
  const variance = Math.round((dashboardTotal - accountingTotal) * 100) / 100;

  invalidateMasterEngineCache(ctx.clientName);

  return {
    success: true,
    targetMonth: targetMonthKey,
    targetMonthLabel,
    dashboardTotal,
    accountingTotal,
    variance,
  };
}

/**
 * 4B. Dynamically populate MgmtRep!B1 and MgmtRep!A371:AG493 in Supabase master_sheet_grids
 * from Client Sheet Outgoings & Budget so EoM Overhead Expenses Management works without Master Sheet formulas.
 */
export async function syncVirtualMgmtRepGridNative(sheets, clientName, reportMonthKey = null, isoDateToWrite = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !sheets) return false;

  const ctx = await resolveSupabaseSheetContext({ clientName });
  if (!ctx?.clientSheetId) return false;

  const [{ data: mgmtRow }, outResp, budResp] = await Promise.all([
    supabase
      .from("master_sheet_grids")
      .select("values_grid")
      .eq("client_name", ctx.clientName)
      .eq("sheet_role", "master")
      .eq("tab_name", "MgmtRep")
      .maybeSingle(),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Outgoings!A1:AZ250",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: ctx.clientSheetId,
      range: "Budget!A1:AZ250",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const mgmtGrid = Array.isArray(mgmtRow?.values_grid)
    ? mgmtRow.values_grid.map((r) => (Array.isArray(r) ? [...r] : []))
    : [];
  while (mgmtGrid.length < 495) mgmtGrid.push([]);

  if (!mgmtGrid[0]) mgmtGrid[0] = [];
  if (isoDateToWrite) {
    mgmtGrid[0][1] = isoDateToWrite; // MgmtRep!B1
  }

  const targetDate = parseCellDate_(isoDateToWrite || reportMonthKey || mgmtGrid[0]?.[1]);
  if (!targetDate) return false;
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth();

  const outGrid = outResp.data.values || [];
  const budGrid = budResp.data.values || [];
  const outHeader = outGrid[0] || [];
  const budHeader = budGrid[0] || [];

  let outMonthCol0 = -1;
  for (let c = 6; c < outHeader.length; c++) {
    const d = parseCellDate_(outHeader[c]);
    if (d && d.getFullYear() === targetYear && d.getMonth() === targetMonth) {
      outMonthCol0 = c;
      break;
    }
  }

  let budMonthCol0 = -1;
  for (let c = 6; c < budHeader.length; c++) {
    const d = parseCellDate_(budHeader[c]);
    if (d && d.getFullYear() === targetYear && d.getMonth() === targetMonth) {
      budMonthCol0 = c;
      break;
    }
  }

  const budgetByCatLower = new Map();
  for (let r = 120; r < budGrid.length; r++) {
    const cat = String(budGrid[r]?.[0] || "").trim();
    if (!cat) continue;
    const rawVal = budMonthCol0 !== -1 ? budGrid[r]?.[budMonthCol0] : "";
    if (rawVal !== "" && rawVal !== undefined && rawVal !== null) {
      budgetByCatLower.set(cat.toLowerCase(), parseNumeric_(rawVal));
    }
  }

  // Row 371 (0-indexed 370) headers
  if (!mgmtGrid[370]) mgmtGrid[370] = [];
  mgmtGrid[370][0] = "";
  mgmtGrid[370][1] = "Actual";
  mgmtGrid[370][2] = "Budget";
  mgmtGrid[370][3] = "Variance";
  mgmtGrid[370][4] = "%";

  const checkedRightRows = [];

  // Rows 372..493 (0-indexed 371..492) map to Outgoings rows 126..247 (0-indexed 125..246)
  for (let i = 0; i < 122; i++) {
    const mgmtRow0 = 371 + i;
    const outRow0 = 125 + i;
    if (!mgmtGrid[mgmtRow0]) mgmtGrid[mgmtRow0] = [];
    const outRow = outGrid[outRow0] || [];
    const cat = String(outRow[0] || "").trim();
    const isTotal = /^total other expenses/i.test(cat);

    mgmtGrid[mgmtRow0][0] = cat;
    if (!cat) {
      mgmtGrid[mgmtRow0][1] = "";
      mgmtGrid[mgmtRow0][2] = "";
      mgmtGrid[mgmtRow0][3] = "";
      mgmtGrid[mgmtRow0][4] = "";
      mgmtGrid[mgmtRow0][5] = false;
      continue;
    }

    const actualNum = outMonthCol0 !== -1 ? parseNumeric_(outRow[outMonthCol0]) : 0;
    const hasBudget = budgetByCatLower.has(cat.toLowerCase());
    const budgetNum = hasBudget ? budgetByCatLower.get(cat.toLowerCase()) : null;
    const varNum = (budgetNum ?? 0) - actualNum;

    let pctStr = "";
    if (!hasBudget) pctStr = "#DIV/0!";
    else if (Math.abs(actualNum) < 0.005 && Math.abs(budgetNum) < 0.005) pctStr = "0%";
    else if (Math.abs(budgetNum) < 0.005) pctStr = "!!!";
    else pctStr = `${Math.round((varNum / budgetNum) * 100)}%`;

    const existingChecked = mgmtGrid[mgmtRow0][5];
    const isChecked = isTotal
      ? false
      : existingChecked === true || String(existingChecked || "").toUpperCase() === "TRUE";

    mgmtGrid[mgmtRow0][1] = actualNum;
    mgmtGrid[mgmtRow0][2] = hasBudget ? budgetNum : "";
    mgmtGrid[mgmtRow0][3] = varNum;
    mgmtGrid[mgmtRow0][4] = pctStr;
    mgmtGrid[mgmtRow0][5] = isChecked;

    if (isChecked && !isTotal) {
      checkedRightRows.push({ cat, actualNum, budgetVal: hasBudget ? budgetNum : "", varNum, pctStr });
    }
  }

  // Populate right-hand table AB372:AG493 (0-indexed cols 27..32)
  for (let i = 0; i < 122; i++) {
    const mgmtRow0 = 371 + i;
    const right = checkedRightRows[i];
    mgmtGrid[mgmtRow0][27] = right ? right.cat : "";
    mgmtGrid[mgmtRow0][28] = right ? right.actualNum : "";
    mgmtGrid[mgmtRow0][29] = right ? right.budgetVal : "";
    mgmtGrid[mgmtRow0][30] = "";
    mgmtGrid[mgmtRow0][31] = right ? right.varNum : "";
    mgmtGrid[mgmtRow0][32] = right ? right.pctStr : "";
  }

  await supabase.from("master_sheet_grids").upsert(
    {
      client_id: ctx.clientId,
      client_name: ctx.clientName,
      sheet_role: "master",
      tab_name: "MgmtRep",
      values_grid: mgmtGrid,
      formulas_grid: mgmtGrid,
      row_count: mgmtGrid.length,
      col_count: Math.max(35, ...mgmtGrid.map((r) => r.length)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_name,sheet_role,tab_name" }
  );

  invalidateMasterEngineCache(ctx.clientName);
  return true;
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
    crmDealsPulled: 0,
    invoiceWriteBacks: null,
    expenseWriteBacks: null,
    comparisons: null,
  };

  if (syncType === "invoice" || syncType === "all") {
    if (session) {
      results.invoicesPulled = await pullLiveAccountingInvoicesToSupabase_(ctx, session);
    }
    if (sheets && ctx.clientSheetId) {
      const partPaidRes = await processPartPaidInvoicesNative(sheets, ctx).catch((e) => ({ error: e.message }));
      const pushInvRes = await pushMatchedInvoicesToConfirmedNative(sheets, ctx).catch((e) => ({ error: e.message }));
      const staleRes = await updateStaleUnsentInvoicesNative(sheets, ctx).catch((e) => ({ error: e.message }));
      const overdueRes = await updateOverdueInvoicesInConfirmedNative(sheets, ctx).catch((e) => ({ error: e.message }));
      results.invoiceWriteBacks = { partPaidRes, pushInvRes, staleRes, overdueRes };
    }
    await supabase
      .from("sync_schedules")
      .update({
        last_inv_run: new Date().toISOString(),
        inv_status: `Synced (${results.invoicesPulled} invoices)`,
      })
      .eq("client_name", ctx.clientName);
    await appendVirtualAutoLog_(
      ctx,
      "INVOICE_SYNC",
      `Completed native invoice sync (${results.invoicesPulled} invoices pulled)`,
      JSON.stringify(results.invoiceWriteBacks || {})
    );
  }

  if (syncType === "expense" || syncType === "all") {
    if (session) {
      results.directCostsPulled = await pullLiveAccountingDirectCostsToSupabase_(ctx, session);
    }
    if (sheets && ctx.clientSheetId) {
      const pushDcRes = await pushMatchedDirectCostsNative(sheets, ctx).catch((e) => ({ error: e.message }));
      const breakdownRes = await syncExpenseBreakdownToClientSheetNative(sheets, ctx.clientName).catch((e) => ({ error: e.message }));
      results.expenseWriteBacks = { pushDcRes, breakdownRes };
    }
    await supabase
      .from("sync_schedules")
      .update({
        last_exp_run: new Date().toISOString(),
        exp_status: `Synced (${results.directCostsPulled} bills)`,
      })
      .eq("client_name", ctx.clientName);
    await appendVirtualAutoLog_(
      ctx,
      "EXPENSE_SYNC",
      `Completed native expense sync (${results.directCostsPulled} bills pulled)`,
      JSON.stringify(results.expenseWriteBacks || {})
    );
  }

  if (syncType === "crm" || syncType === "all") {
    const crmRes = await pullLiveCrmDealsToSupabaseNative(sheets, ctx).catch((e) => ({ dealsPulled: 0, error: e.message }));
    results.crmDealsPulled = crmRes.dealsPulled || 0;
    if (sheets) {
      results.crmComparison = await recomputeCrmComparisonInSupabase(sheets, ctx.clientName).catch((e) => ({ error: e.message }));
    }
    await supabase
      .from("sync_schedules")
      .update({
        last_crm_run: new Date().toISOString(),
        crm_status: `Synced (${results.crmDealsPulled} deals)`,
      })
      .eq("client_name", ctx.clientName);
    await appendVirtualAutoLog_(ctx, "CRM_SYNC", `Completed native CRM sync (${results.crmDealsPulled} deals)`);
  }

  // Always recompute InvComp & DirComp comparisons against Client Sheet
  if (sheets) {
    results.comparisons = await recomputeClientComparisonsInSupabase(sheets, ctx.clientName);
  }

  await logPmaActivity(sheets, {
    clientName: ctx.clientName,
    category: "SYNC",
    action: `Native Supabase sync (${syncType})`,
    summary: `Completed native Supabase ${syncType} sync for ${ctx.clientName} (${results.invoicesPulled} invoices, ${results.directCostsPulled} direct costs)`,
    details: results,
    user: userEmail,
  }).catch(() => {});

  return results;
}


