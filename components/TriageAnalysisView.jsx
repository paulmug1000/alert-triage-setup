import React from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTasks } from "../contexts/TaskContext";

export default function TriageAnalysisView({
  styles, setScreen, getFlagName, setActiveNav, handleNavTasks
}) {
  const { openCreateTaskModal } = useTasks();
  const {
    selectedClient, clientAlerts, currentClientAlertIndex, setCurrentClientAlertIndex,
    acceptError, setAcceptError, clientsWithFlags, fromCache, setFromCache,
    selectAlert, setClientAlerts, claudeAnalysis, setClaudeAnalysis,
    previousIgnoreReason, setPreviousIgnoreReason, acceptOption, isAccepting,
    isAnalyzing, setIsAnalyzing, existingTaskBanner, setExistingTaskBanner,
    showIgnoreModal, setShowIgnoreModal, ignoreReason, setIgnoreReason,
    isIgnoring, ignoreAlert, sessionId, processedAlerts, setProcessedAlerts,
    allNoActionResolved, resolvedNoActionFlags, handlePostClear
  } = useTriage();

  const { allClientsMap, automationCommanderSheetId } = useAppGlobals();
  const alert = clientAlerts[currentClientAlertIndex];
  const progress = currentClientAlertIndex + 1;

  const otherDuplicateAlerts = (alert && (alert.type === "invoice" || alert.flagType === "invoiceDashboardDiscr") && alert.summary?.invoiceNo)
    ? clientAlerts.filter(a => {
        const thisId = alert.fingerprintHash || `${alert.sheetName}-${alert.rowNumber}`;
        const otherId = a.fingerprintHash || `${a.sheetName}-${a.rowNumber}`;
        if (thisId === otherId) return false;
        const otherInvNo = String(a.summary?.invoiceNo || a.data?.accounting?.[5] || "").trim();
        return otherInvNo && otherInvNo.toLowerCase() === String(alert.summary.invoiceNo).trim().toLowerCase();
      })
    : [];

  const isDuplicateInvoice = Boolean(
    alert?.isDuplicateInvoice ||
    String(alert?.data?.flags?.[4] || "").trim() === "1" ||
    (alert?.spreadsheetItems && alert.spreadsheetItems.length > 1) ||
    otherDuplicateAlerts.length > 0
  );
  const spreadsheetItems = alert?.spreadsheetItems || [];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Alerts</h1>
        <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
      </div>

      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <button className="triage-btn" onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
            ← Back to Alerts
          </button>
          {(() => {
            let info = (clientsWithFlags || []).find(c => c.clientName === selectedClient.clientName);
            
            if (!info?.clientSheetId && !info?.masterSheetId) {
              info = allClientsMap[selectedClient.clientName] || selectedClient;
            }

            if (!info?.clientSheetId && !info?.masterSheetId) return null;
            return (
              <button className="triage-btn" onClick={() => {
                if (info.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${info.clientSheetId}/edit`, "_blank");
                if (info.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${info.masterSheetId}/edit`, "_blank");
              }} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
                📊 Open Sheets
              </button>
            );
          })()}
        </div>
        <div style={styles.alertHeader}>
          <h2 style={styles.alertTitle}>
            {alert.clientName || alert.type || "Financial Alert"}
            {fromCache && (
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={styles.cacheBadge}>⚡ Cached</span>
                <button className="triage-btn" onClick={async () => {
                  try {
                    const bustRes = await fetch("/api/triage", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "bust_cache",
                        fingerprintHash: alert.fingerprintHash || undefined,
                        rowNumber: alert.rowNumber,
                        sheetName: alert.sheetName,
                        automationCommanderSheetId,
                      }),
                    });
                    const bustData = await bustRes.json();
                    if (!bustData.success) {
                      console.error("Cache bust failed:", bustData.error);
                      return;
                    }
                    setFromCache(false);

                    // CRITICAL FIX: Delete the old options from local React memory so selectAlert is forced to fetch fresh data
                    const freshAlert = { ...clientAlerts[currentClientAlertIndex] };
                    delete freshAlert.options;
                    
                    setClientAlerts(prev => {
                      const newAlerts = [...prev];
                      newAlerts[currentClientAlertIndex] = freshAlert;
                      return newAlerts;
                    });

                    // Small delay to ensure Sheets write has committed before re-fetching
                    await new Promise(r => setTimeout(r, 1000));
                    await selectAlert(freshAlert);
                  } catch(e) { console.error("Cache bust failed:", e); }
                }} style={{ fontSize: "11px", padding: "2px 8px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", color: "#555" }}>
                  ↻ Refresh
                </button>
              </span>
            )}
          </h2>
          <span style={styles.alertCounter}>{progress}/{clientAlerts.length}</span>
        </div>

        {(alert.flagType || alert.alertType || alert.type) && (() => {
          const key = alert.flagType || alert.alertType || alert.type;
          const fullName = getFlagName(key);
          return (
            <div style={{ ...styles.alertMetadata, fontSize: "15px", fontWeight: "600", padding: "14px", marginBottom: "16px", color: "#1d4ed8", backgroundColor: "#eff6ff", borderLeft: "4px solid #3b82f6" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{fullName}</span>
                {(alert.firstSeen || alert.lastSeen) && (
                  <span style={{ fontSize: "11px", color: "#3b82f6", fontWeight: "500", opacity: 0.8 }}>
                    {alert.firstSeen ? `First seen: ${alert.firstSeen.split("T")[0]}` : ""}
                    {alert.firstSeen && alert.lastSeen ? " · " : ""}
                    {alert.lastSeen ? `Last seen: ${alert.lastSeen.split("T")[0]}` : ""}
                  </span>
                )}
              </div>
            </div>
          );
        })()}

        {alert.type === "locked" && alert.summary?.lockedMessage && (
          <div style={{ ...styles.alertSummary, marginBottom: "20px", backgroundColor: "#fff3e0", borderLeft: "4px solid #f59e0b" }}>
            <h3 style={{ fontSize: "13px", fontWeight: "700", marginBottom: "8px", color: "#92400e", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🔒 Automation In Progress
            </h3>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#78350f" }}>
              {alert.summary.lockedMessage}
            </div>
          </div>
        )}

        {isDuplicateInvoice && (
          <div style={{
            backgroundColor: "#fffbeb", border: "1.5px solid #f59e0b",
            borderRadius: "6px", padding: "14px 16px", marginBottom: "16px",
            color: "#92400e"
          }}>
            <div style={{ fontWeight: "700", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>⚠️ Duplicate Invoice in Spreadsheet Notice</span>
              <span style={{ background: "#d97706", color: "white", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700" }}>
                {spreadsheetItems.length > 0 ? `${spreadsheetItems.length} SPREADSHEET ITEMS` : "DUPLICATE INVOICE NO"}
              </span>
              {alert.summary?.invoiceNo && <span style={{ fontSize: "13px", color: "#78350f" }}>Invoice #{alert.summary.invoiceNo}</span>}
            </div>
            <div style={{ fontSize: "13px", marginTop: "6px", lineHeight: "1.5" }}>
              {spreadsheetItems.length > 0 ? (
                <>This invoice number appears in <strong>{spreadsheetItems.length} distinct items/jobs in the spreadsheet</strong>, but only <strong>once in accounting</strong> (InvComp Row {alert.rowNumber}).</>
              ) : otherDuplicateAlerts.length > 0 ? (
                <>Invoice <strong>#{alert.summary?.invoiceNo}</strong> also appears in <strong>{otherDuplicateAlerts.length}</strong> other entry/entries in this triage batch (InvComp Row{otherDuplicateAlerts.length > 1 ? "s" : ""}: {otherDuplicateAlerts.map(a => a.rowNumber).join(", ")}).</>
              ) : (
                <>This invoice number is flagged as having multiple entries in the spreadsheet (InvComp Column W, Row {alert.rowNumber}).</>
              )}
            </div>

            {/* Spreadsheet Line Items Table */}
            {spreadsheetItems.length > 0 && (
              <div style={{ marginTop: "12px", background: "white", border: "1px solid #fcd34d", borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ background: "#fef3c7", padding: "6px 10px", fontWeight: "700", fontSize: "12px", color: "#92400e", borderBottom: "1px solid #fde68a" }}>
                  📊 Spreadsheet Breakdown ({spreadsheetItems.length} items for Invoice #{alert.summary?.invoiceNo})
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ background: "#fffdf5", borderBottom: "1px solid #fde68a", fontSize: "11px", color: "#78350f" }}>
                        <th style={{ padding: "6px 8px" }}>Spreadsheet Job / Item</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Excl VAT</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>VAT</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Gross</th>
                        <th style={{ padding: "6px 8px" }}>Sent</th>
                        <th style={{ padding: "6px 8px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spreadsheetItems.map((item, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #fef3c7" }}>
                          <td style={{ padding: "6px 8px", fontWeight: "600", color: "#111827" }}>
                            {item.job || "(No job name)"}
                            {item.client && <div style={{ fontSize: "10px", color: "#6b7280", fontWeight: "normal" }}>{item.client}</div>}
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>£{item.netAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>£{item.vatAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: "600" }}>£{item.grossAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", color: "#4b5563" }}>{item.sentDate || "—"}</td>
                          <td style={{ padding: "6px 8px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "3px", background: "#f3f4f6", color: "#374151" }}>
                              {item.status || "—"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: "#fff7ed", fontWeight: "700", borderTop: "1.5px solid #fed7aa", color: "#9a3412" }}>
                        <td style={{ padding: "6px 8px" }}>Spreadsheet Total ({spreadsheetItems.length} items):</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.netAmount, 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.vatAmount, 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.grossAmount, 0).toFixed(2)}
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                      <tr style={{ background: "#eff6ff", fontWeight: "700", borderTop: "1px solid #bfdbfe", color: "#1e40af" }}>
                        <td style={{ padding: "6px 8px" }}>Accounting Total (Row {alert.rowNumber}):</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[3] || "0").replace(/,/g, "")) || alert.summary?.amount || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[4] || "0").replace(/,/g, "")) || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[2] || "0").replace(/,/g, "")) || 0).toFixed(2)}
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            <div style={{ fontSize: "12px", marginTop: "8px", color: "#b45309" }}>
              Review all spreadsheet entries against accounting before resolving this discrepancy.
            </div>
          </div>
        )}

        {alert.summary && alert.type !== "locked" && (
          <div style={{ ...styles.alertSummary, marginBottom: "20px",
            backgroundColor: alert.type === "expense" ? "#f0fdf4" : "#eff6ff",
            borderLeft: `4px solid ${alert.type === "expense" ? "#16a34a" : "#2563eb"}` }}>
            <h3 style={{ fontSize: "17px", fontWeight: "700", marginBottom: "8px", color: alert.type === "expense" ? "#166534" : "#1e40af" }}>
              ⚠ {alert.type === "expense" ? (() => {
                  const expFlags = alert.data?.flags || [];
                  const isMissing = String(expFlags[0]||"").trim() === "1";
                  if (isMissing) return "Missing cost — in accounting system, not in Confirmed or Outgoings tab";
                  const expFlagNames = [null,"Duplicate App ID","Description mismatch","Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
                  const active = expFlags.map((v,i) => String(v||"").trim()==="1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                  return active.length > 0 ? `Field mismatch: ${active.join(", ")}` : "Expense Discrepancy";
                })()
                : (() => {
                    const flags = alert.data?.flags || [];
                    const isMissing = String(flags[0]||"").trim() === "1";
                    if (isMissing) return "Missing invoice — in accounting system, not in Confirmed tab";
                    const invFlagNames2 = [null,"Client mismatch","Amount mismatch","Sent date mismatch","Duplicate invoice in sheet","Pay date mismatch","Status mismatch"];
                    const active = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames2[i] ? invFlagNames2[i] : null).filter(Boolean);
                    return active.length > 0 ? `Field mismatch: ${active.join(", ")}` : "Invoice Discrepancy";
                  })()
              }
            </h3>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#333" }}>
              {alert.type === "expense" ? (
                // Expense display
                <>
                  {alert.summary.reference && <div><strong>Reference:</strong> {alert.summary.reference}</div>}
                  {alert.summary.description && <div><strong>Description:</strong> {alert.summary.description}</div>}
                  <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{(() => {
                    const vat = parseFloat(String(alert.summary.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
                    return vat > 0 ? " +VAT" : " (no VAT)";
                  })()}</div>
                  {alert.summary.date && <div><strong>Date:</strong> {alert.summary.date}</div>}
                  {alert.summary.accountName && <div><strong>Account Name:</strong> {alert.summary.accountName}</div>}
                  {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                  {alert.summary.transactionId && <div><strong>Transaction ID:</strong> {alert.summary.transactionId}</div>}
                </>
              ) : (
                // Invoice display
                <>
                  <div><strong>Invoice:</strong> {alert.summary.invoiceNo}</div>
                  <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{alert.summary.vatIncluded && alert.summary.vatIncluded > 0 ? " +VAT" : " (no VAT)"}</div>
                  <div><strong>Client:</strong> {alert.summary.client}</div>
                  {alert.summary.job && <div><strong>Description:</strong> {alert.summary.job}</div>}
                  {alert.summary.sentDate && <div><strong>Sent:</strong> {alert.summary.sentDate}</div>}
                  {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                </>
              )}
            </div>
            {/* Field-by-field comparison lines for mismatched fields only */}
            {(() => {
              const flags = alert.data?.flags || [];
              const isMissing = String(flags[0]||"").trim() === "1";
              if (isMissing) return null;
              const acc = alert.data?.accounting || [];
              const conf = alert.data?.confirmed || [];
              let mismatchLines = [];
              if (alert.type === "expense") {
                const expFlagNames = ["Missing cost","Duplicate app ID","Description mismatch","Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
                const activeFlags = flags.map((v,i) => String(v||"").trim()==="1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                const FIELD_DEFS = [
                  { name: "Description mismatch", line: `Description in accounting: ${acc[1] || "(blank)"}. Description in Confirmed tab: ${conf[3] || "(blank)"}.` },
                  { name: "Amount mismatch",       line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[4] ? `£${conf[4]}` : "£0"}.` },
                  { name: "VAT mismatch",          line: `VAT in accounting: ${acc[8] ? `£${acc[8]}` : "£0"}. VAT in Confirmed tab: ${conf[6] || "(blank)"}.` },
                  { name: "Rec date mismatch",     line: `Received date in accounting: ${acc[0] || "(blank)"}. Received date in Confirmed tab: ${conf[7] || "(blank)"}.` },
                  { name: "Pay date mismatch",     line: `Pay date in accounting: ${acc[7] || "(blank)"}. Pay date in Confirmed tab: ${conf[8] || "(blank)"}.` },
                  { name: "Status mismatch",       line: `Status in accounting: ${acc[5] || "(blank)"}. Status in Confirmed tab: ${conf[9] || "(blank)"}.` },
                ];
                mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
              } else {
                const invFlagNames = ["Missing invoice","Client mismatch","Amount mismatch","Sent date mismatch","Duplicate invoice in sheet","Pay date mismatch","Status mismatch"];
                const activeFlags = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);
                const FIELD_DEFS = [
                  { name: "Client mismatch",    line: `Client in accounting: ${acc[0] || "(blank)"}. Client in Confirmed tab: ${conf[1] || "(blank)"}.` },
                  { name: "Amount mismatch",    line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[2] ? `£${conf[2]}` : "£0"}.` },
                  { name: "Sent date mismatch", line: `Sent date in accounting: ${acc[6] || "(blank)"}. Sent date in Confirmed tab: ${conf[3] || "(blank)"}.` },
                  { name: "Duplicate invoice in sheet", line: `Duplicate invoice number: Invoice #${alert.summary?.invoiceNo || acc[5] || conf[0]} appears in multiple rows in the spreadsheet (${spreadsheetItems.length > 0 ? spreadsheetItems.length : 2} entries).` },
                  { name: "Pay date mismatch",  line: `Pay date in accounting: ${acc[8] || "(blank)"}. Pay date in Confirmed tab: ${conf[4] || "(blank)"}.` },
                  { name: "Status mismatch",    line: `Status in accounting: ${acc[9] || "(blank)"}. Status in Confirmed tab: ${conf[5] || "(blank)"}.` },
                ];
                mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
              }
              if (mismatchLines.length === 0) return null;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#333", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  {mismatchLines.map(f => <div key={f.name}>{f.line}</div>)}
                </div>
              );
            })()}
          </div>
        )}

        {acceptError && (
          <div style={{ ...styles.errorBanner, marginBottom: "16px" }}>
            {acceptError}
            {acceptError.includes("go back to the alert list") && (
              <div style={{ marginTop: "10px" }}>
                <button className="triage-btn"
                  onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }}
                  style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
                  ← Back to Alert List
                </button>
              </div>
            )}
          </div>
        )}

        {claudeAnalysis && (
          <div>
            {previousIgnoreReason && (
              <div style={{ marginBottom: "12px", padding: "10px 14px", backgroundColor: "#fff8e1", borderLeft: "4px solid #f59e0b", borderRadius: "4px", fontSize: "13px", color: "#78350f" }}>
                <div><strong>⚠ Previously ignored:</strong> {previousIgnoreReason.ignoreReason}</div>
                {previousIgnoreReason.changeReason && (
                  <div style={{ marginTop: "6px", color: "#92400e", fontStyle: "italic" }}>
                    <strong>Resurfaced because:</strong> {previousIgnoreReason.changeReason}
                  </div>
                )}
              </div>
            )}
            {/* Discrepancy summary — what this alert actually is, and the specific field(s) at issue */}
            {(() => {
              const ft = alert?.flagType || alert?.alertType || alert?.type || "";
              const isCRM = ft.startsWith("crm");
              if (!isCRM) return null;
              const isPipeline = ft.includes("Pipe");
              const isMismatch = alert.subType === "field_mismatch";
              const tabLabel = isPipeline ? "Pipeline" : "Confirmed";
              const isDash = ft.includes("Dash");
              const sd = alert.data?.sheetData || [];
              const cd = alert.data?.crmData || [];
              // App discr sheetData (EF:ER):    [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
              // Dash discr sheetData (AO:AW):    [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
              // crmData (both):                  [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
              const client = (isDash ? sd[1] : sd[0]) || cd[0] || "";
              const job    = (isDash ? sd[2] : sd[1]) || cd[1] || "";
              const code   = (isDash ? sd[0] : sd[2]) || cd[2] || "";

              // Per-field CRM vs sheet values, in the same order/index as MISMATCH_FIELD_NAMES
              // server-side: Client name, Job name, Revenue, Direct costs, Start date, End date, % Likelihood
              const sdField = (dashIdx, appIdx) => isDash ? sd[dashIdx] : sd[appIdx];
              const FIELD_DEFS = [
                { name: "Client name",  crm: cd[0], sheet: sdField(1, 0), fmt: v => v || "(blank)" },
                { name: "Job name",     crm: cd[1], sheet: sdField(2, 1), fmt: v => v || "(blank)" },
                { name: "Revenue",      crm: cd[3], sheet: sd[3], fmt: v => v ? `£${v}` : "£0" },
                { name: "Direct costs", crm: cd[4], sheet: sd[4], fmt: v => v ? `£${v}` : "£0" },
                { name: "Start date",   crm: cd[5], sheet: sd[5], fmt: v => v || "(blank)" },
                { name: "End date",     crm: cd[6], sheet: sd[6], fmt: v => v || "(blank)" },
                { name: "% Likelihood", crm: cd[7], sheet: sd[7], fmt: v => v ? `${(parseFloat(v) * 100).toFixed(0)}%` : "0%" },
              ];
              const mismatchedFieldNames = alert.mismatchFields || [];
              const mismatchedFields = FIELD_DEFS.filter(f => mismatchedFieldNames.includes(f.name));

              const subHeader = isMismatch
                ? `Field mismatch: ${mismatchedFieldNames.join(", ")}`
                : isDash
                  ? `Missing job — in CRM, not in ${tabLabel} tab`
                  : `Missing job — in ${tabLabel} tab, not in CRM`;

              return (
                <div style={{ marginBottom: "16px", padding: "14px 16px", backgroundColor: "#f5f3ff", borderLeft: "4px solid #7c3aed", borderRadius: "4px" }}>
                  <div style={{ fontSize: "17px", fontWeight: "700", color: "#5b21b6", marginBottom: "8px" }}>
                    ⚠ {subHeader}
                  </div>
                  <div style={{ fontSize: "14px", fontWeight: "600", color: "#1a1a1a", marginBottom: isMismatch ? "10px" : "0" }}>
                    {client}{job ? ` — ${job}` : ""}{code ? ` (${code})` : ""}
                  </div>
                  {isMismatch && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#333" }}>
                      {mismatchedFields.map(f => (
                        <div key={f.name}>
                          {f.name} in CRM: <strong>{f.fmt(f.crm)}</strong>. {f.name} in {tabLabel.toLowerCase()} tab: <strong>{f.fmt(f.sheet)}</strong>.
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            <h3 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "12px", color: "#1a1a1a" }}>
              Potential Actions
            </h3>
            {(() => {
              try {
                const options = JSON.parse(claudeAnalysis);
                if (Array.isArray(options)) {
                  return options.map((option, idx) => (
                    <div key={idx} style={{ ...styles.optionCard, marginBottom: "16px" }}>
                      <div style={styles.optionTitle}>
                        Option {idx + 1}: {option.title}
                      </div>
                      {/* Spreadsheet-style job row(s) display */}
                      {Array.isArray(option.jobRowsData) && option.jobRowsData.length > 0 && (
                        <div style={{ marginBottom: "10px", overflowX: "auto", border: "1px solid #e0e0e0", borderRadius: "6px" }}>
                          <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px" }}>
                            <thead>
                              <tr style={{ background: "#f3f4f6" }}>
                                {["Row","Client","Job name","Code","Revenue","Direct costs","Type","VAT","Start","End",
                                  ...(option.jobRowsData[0].likelihood !== null ? ["% Likely"] : []),
                                  ...(option.jobRowsData[0].copiedToConf !== null ? ["Copied?"] : [])
                                ].map(h => (
                                  <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {option.jobRowsData.map(jr => (
                                <tr key={jr.rowNum} style={{ borderBottom: "1px solid #eee" }}>
                                  <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.client}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.jobName}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.projectCode}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.revenue}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.directCosts}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.projectRetainer}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.vat}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.startDate}</td>
                                  <td style={{ padding: "5px 8px" }}>{jr.endDate}</td>
                                  {jr.likelihood !== null && <td style={{ padding: "5px 8px" }}>{jr.likelihood}</td>}
                                  {jr.copiedToConf !== null && <td style={{ padding: "5px 8px" }}>{jr.copiedToConf}</td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {/* Invoice slots — only render if any slot has data or is the target */}
                          {option.jobRowsData.some(jr => jr.invoiceSlots?.some(s => s.amount || s.ref || s.highlighted)) && (
                            <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px", borderTop: "2px solid #ddd" }}>
                              <thead>
                                <tr style={{ background: "#f3f4f6" }}>
                                  {["Row","Slot","Amount","Reference","Sent","Days","Status"].map(h => (
                                    <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {option.jobRowsData.flatMap(jr => jr.invoiceSlots.map(s => (
                                  <tr key={`${jr.rowNum}-inv${s.slotNum}`} style={{
                                    borderBottom: "1px solid #eee",
                                    background: s.highlighted ? "#fff3cd" : "transparent",
                                    fontWeight: s.highlighted ? "700" : "400",
                                  }}>
                                    <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.slotNum}{s.highlighted ? " ← this option" : ""}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.amount}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.ref}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.sentDate}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.daysToPay}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.status}</td>
                                  </tr>
                                )))}
                              </tbody>
                            </table>
                          )}
                          {/* Expense slots — only render if any slot has data or is the target */}
                          {option.jobRowsData.some(jr => jr.expenseSlots?.some(s => s.amount || s.description || s.highlighted)) && (
                            <table style={{ borderCollapse: "collapse", fontSize: "11px", width: "100%", minWidth: "700px", borderTop: "2px solid #ddd" }}>
                              <thead>
                                <tr style={{ background: "#f3f4f6" }}>
                                  {["Row","Slot","Description","Amount","VAT","Date","Days","Status","Txn ID"].map(h => (
                                    <th key={h} style={{ padding: "5px 8px", textAlign: "left", borderBottom: "1px solid #ddd", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {option.jobRowsData.flatMap(jr => jr.expenseSlots.map(s => (
                                  <tr key={`${jr.rowNum}-exp${s.slotNum}`} style={{
                                    borderBottom: "1px solid #eee",
                                    background: s.highlighted ? "#fff3cd" : "transparent",
                                    fontWeight: s.highlighted ? "700" : "400",
                                  }}>
                                    <td style={{ padding: "5px 8px", color: "#888" }}>{jr.rowNum}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.slotNum}{s.highlighted ? " ← this option" : ""}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.description}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.amount}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.vat}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.date}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.daysToPay}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.status}</td>
                                    <td style={{ padding: "5px 8px" }}>{s.transactionId}</td>
                                  </tr>
                                )))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                      {/* Info matchType: explanation + job details, Mark as resolved button */}
                      {option.matchType === "info" && (
                        <>
                          {option.explanation && (
                            <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#fff8e1", borderLeft: "3px solid #f59e0b", fontSize: "13px", lineHeight: "1.5" }}>
                              {option.explanation}
                            </div>
                          )}
                          {option.jobDetails && (
                            <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                              <strong style={{ color: "#1d4ed8", fontSize: "12px" }}>Job Details:</strong>
                              <div style={{ marginTop: "6px", fontSize: "12px", color: "#333" }}>
                                {option.jobDetails.clientName && <div><strong>Client:</strong> {option.jobDetails.clientName}</div>}
                                {option.jobDetails.jobName && <div><strong>Job:</strong> {option.jobDetails.jobName}</div>}
                                {option.jobDetails.projectCode && <div><strong>Code:</strong> {option.jobDetails.projectCode}</div>}
                                {option.jobDetails.revenue && <div><strong>Revenue:</strong> {option.jobDetails.revenue}</div>}
                                {option.jobDetails.vatSetting && <div><strong>VAT:</strong> {option.jobDetails.vatSetting}</div>}
                                {option.jobDetails.startDate && <div><strong>Dates:</strong> {option.jobDetails.startDate} → {option.jobDetails.endDate || "?"}</div>}
                                {option.jobDetails.slot1 && !option.jobDetails.slot1.startsWith("(empty)") && <div><strong>Inv 1:</strong> {option.jobDetails.slot1}</div>}
                                {option.jobDetails.slot2 && !option.jobDetails.slot2.startsWith("(empty)") && <div><strong>Inv 2:</strong> {option.jobDetails.slot2}</div>}
                                {option.jobDetails.slot3 && !option.jobDetails.slot3.startsWith("(empty)") && <div><strong>Inv 3:</strong> {option.jobDetails.slot3}</div>}
                              </div>
                            </div>
                          )}
                          {option.recommendedActions && option.recommendedActions.length > 0 && (
                            <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                              <strong>Actions:</strong>
                              {option.recommendedActions.map((action, i) => (
                                <div key={i} style={{ marginTop: "4px", fontSize: "13px" }}>
                                  {i === 0 ? <strong style={{ color: "#059669" }}>✓ {action}</strong> : `• ${action}`}
                                </div>
                              ))}
                            </div>
                          )}
                          <button className="triage-btn triage-btn-primary"
                            onClick={() => {
                              const alert2 = clientAlerts[currentClientAlertIndex];
                              const alertId = `${alert2.sheetName}-${alert2.rowNumber}`;
                              setProcessedAlerts(new Set([...processedAlerts, alertId]));
                              if (sessionId) {
                                fetch("/api/triage", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
                                }).catch(() => {});
                              }
                              const updatedAlerts = clientAlerts.filter((_, i) => i !== currentClientAlertIndex);
                              setClientAlerts(updatedAlerts);
                              if (updatedAlerts.length === 0) {
                                if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                                else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                              } else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                            }}
                            style={{ ...styles.decisionButton, ...styles.approveButton, marginTop: "12px", width: "100%" }}
                          >
                            ✓ Mark as Resolved
                          </button>
                        </>
                      )}
                      {/* Standard (non-info) rendering: CRM details, match analysis, accept button */}
                      {option.matchType !== "info" && (<>
                      {/* Explanation and revenue impact for invoice amount mismatch options */}
                      {option.explanation && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#fff8e1", borderLeft: "3px solid #f59e0b", fontSize: "13px", lineHeight: "1.5" }}>
                          {option.explanation}
                        </div>
                      )}
                      {option.slotBreakdown && option.slotBreakdown.lines && option.slotBreakdown.lines.length > 0 && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6", fontSize: "12px" }}>
                          <strong style={{ color: "#1d4ed8", display: "block", marginBottom: "6px" }}>Invoice slots on this job:</strong>
                          {option.slotBreakdown.lines.map((line, i) => (
                            <div key={i} style={{ fontFamily: "monospace", color: line.includes("← this invoice") ? "#0f766e" : (line.includes("PLACE-INV") || line.includes("MANUAL-INV")) ? "#9333ea" : "#333", marginBottom: "2px", fontWeight: line.includes("← this invoice") ? "600" : "400" }}>
                              {line}
                            </div>
                          ))}
                          <div style={{ marginTop: "8px", paddingTop: "6px", borderTop: "1px solid #bfdbfe", color: "#1e40af", fontWeight: "600" }}>
                            New real total invoiced (excl. placeholders): {option.slotBreakdown.correctedTotal} / Revenue: {option.slotBreakdown.currentRevenue} ({option.slotBreakdown.revenueRatio})
                          </div>
                        </div>
                      )}
                      {option.revenueImpact && (
                        <div style={{ ...styles.optionDetail, marginTop: "6px", padding: "10px", backgroundColor: "#fef2f2", borderLeft: "3px solid #ef4444", fontSize: "13px", fontWeight: "500" }}>
                          ⚠ Revenue impact: {option.revenueImpact}
                        </div>
                      )}
                      {/* VAT mismatch — show job context and exact cell that will be updated */}
                      {option.discrepancyType === "inv_vat_mismatch" && option.matchType === "existing_job" && option.jobDetails && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "10px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                          <strong style={{ color: "#1d4ed8", fontSize: "12px" }}>Job Details (Confirmed tab, row {option.jobRow}):</strong>
                          <div style={{ marginTop: "6px", fontSize: "12px", color: "#333" }}>
                            {option.jobDetails.clientName && <div><strong>Client:</strong> {option.jobDetails.clientName}</div>}
                            {option.jobDetails.jobName && <div><strong>Job:</strong> {option.jobDetails.jobName}</div>}
                            {option.jobDetails.projectCode && <div><strong>Code:</strong> {option.jobDetails.projectCode}</div>}
                            {option.jobDetails.revenue && <div><strong>Revenue:</strong> {option.jobDetails.revenue}</div>}
                            {option.jobDetails.vatSetting && <div><strong>Current VAT setting:</strong> {option.jobDetails.vatSetting}</div>}
                            {option.jobDetails.startDate && <div><strong>Dates:</strong> {option.jobDetails.startDate} → {option.jobDetails.endDate || "?"}</div>}
                            {option.jobDetails.slot1 && !option.jobDetails.slot1.startsWith("(empty)") && <div><strong>Inv 1:</strong> {option.jobDetails.slot1}</div>}
                            {option.jobDetails.slot2 && !option.jobDetails.slot2.startsWith("(empty)") && <div><strong>Inv 2:</strong> {option.jobDetails.slot2}</div>}
                            {option.jobDetails.slot3 && !option.jobDetails.slot3.startsWith("(empty)") && <div><strong>Inv 3:</strong> {option.jobDetails.slot3}</div>}
                          </div>
                        </div>
                      )}
                      {option.vatUpdate && (
                        <div style={{ marginTop: "12px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "6px", padding: "10px 14px" }}>
                          <strong style={{ color: "#15803d" }}>If accepted, the following will be updated:</strong>
                          <div style={{ fontFamily: "monospace", fontSize: "12px", marginTop: "4px" }}>
                            {option.vatUpdate.cells
                              ? option.vatUpdate.cells.map(cell => (
                                  <div key={cell}>Cell {cell}: &quot;{option.vatUpdate.currentValue}&quot; → &quot;{option.vatUpdate.newValue}&quot;</div>
                                ))
                              : <div>Cell {option.vatUpdate.cell}: &quot;{option.vatUpdate.currentValue}&quot; → &quot;{option.vatUpdate.newValue}&quot;</div>
                            }
                          </div>
                        </div>
                      )}
                      {/* CRM match analysis - ONLY show for CRM/invoices, not expenses, not VAT mismatches (those use explanation) */}
                      {option.matchAnalysis && typeof option.matchAnalysis === 'object' && !option.allocationBreakdown && option.discrepancyType !== "inv_vat_mismatch" && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                          <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                          {option.matchAnalysis.matchConfidence && (
                            <div style={{ marginTop: "6px", fontSize: "13px" }}>
                              <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                            </div>
                          )}
                          {option.matchAnalysis.clientNameMatch && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Client Name:</strong> {option.matchAnalysis.clientNameMatch}
                            </div>
                          )}
                          {option.matchAnalysis.jobNameMatch && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Job Name:</strong> {option.matchAnalysis.jobNameMatch}
                            </div>
                          )}
                          {option.matchAnalysis.revenueMatch && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Revenue:</strong> {option.matchAnalysis.revenueMatch}
                            </div>
                          )}
                          {option.matchAnalysis.dateRangeMatch && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Dates:</strong> {option.matchAnalysis.dateRangeMatch}
                            </div>
                          )}
                          {option.matchAnalysis.projectCodeMatch && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Project Code:</strong> {option.matchAnalysis.projectCodeMatch}
                            </div>
                          )}
                          {option.matchAnalysis.reasonForChoice && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                              <strong>Why:</strong> {option.matchAnalysis.reasonForChoice}
                            </div>
                          )}
                          {option.matchAnalysis.discrepancies && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                              <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                            </div>
                          )}
                          {option.matchAnalysis.whyItDidntAutoMatch && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#666" }}>
                              <strong>Why no auto-match:</strong> {option.matchAnalysis.whyItDidntAutoMatch}
                            </div>
                          )}
                        </div>
                      )}
                      {/* NEW FORMAT: Display allocation breakdown for expenses */}
                      {option.allocationBreakdown && typeof option.allocationBreakdown === 'object' && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#f0f9ff", borderLeft: "3px solid #3b82f6" }}>
                          <strong style={{ color: "#1e40af" }}>Direct Cost Allocation:</strong>
                          {option.allocationBreakdown.jobDirectCostBudget && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                              <strong>Total Budget:</strong> {option.allocationBreakdown.jobDirectCostBudget}
                            </div>
                          )}
                          {option.allocationBreakdown.allocatedExpenses && Array.isArray(option.allocationBreakdown.allocatedExpenses) && option.allocationBreakdown.allocatedExpenses.length > 0 && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#333" }}>
                              <strong>Allocated Expenses:</strong>
                              <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                {option.allocationBreakdown.allocatedExpenses.map((exp, i) => (
                                  <li key={i} style={{ color: "#444", marginBottom: "2px" }}>{exp}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {option.allocationBreakdown.totalAllocated && (
                            <div style={{ marginTop: "4px", fontSize: "13px", color: "#555" }}>
                              <strong>Total Allocated:</strong> {option.allocationBreakdown.totalAllocated}
                            </div>
                          )}
                          {option.allocationBreakdown.placeholderExpenses && Array.isArray(option.allocationBreakdown.placeholderExpenses) && option.allocationBreakdown.placeholderExpenses.length > 0 && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#b45309" }}>
                              <strong>Pending Placeholders:</strong>
                              <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "12px" }}>
                                {option.allocationBreakdown.placeholderExpenses.map((exp, i) => (
                                  <li key={i} style={{ color: "#92400e", marginBottom: "2px" }}>{exp}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {option.allocationBreakdown.remainingBudget && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#059669", fontWeight: "bold" }}>
                              Remaining Budget: {option.allocationBreakdown.remainingBudget}
                            </div>
                          )}
                          {option.allocationBreakdown.expenseCanFit && (
                            <div style={{
                              marginTop: "6px", fontSize: "13px",
                              color: String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "#059669" : "#dc2626"
                            }}>
                              {String(option.allocationBreakdown.expenseCanFit).toUpperCase().startsWith("YES") ? "✓" : "✗"} {option.allocationBreakdown.expenseCanFit}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Expense match analysis - only shown alongside allocation breakdown */}
                      {option.matchAnalysis && typeof option.matchAnalysis === 'object' && option.allocationBreakdown && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", padding: "8px", backgroundColor: "#fef3c7", borderLeft: "3px solid #f59e0b" }}>
                          <strong style={{ color: "#b45309" }}>Match Analysis:</strong>
                          {option.matchAnalysis.matchConfidence && (
                            <div style={{ marginTop: "6px", fontSize: "13px" }}>
                              <strong>Confidence:</strong> {option.matchAnalysis.matchConfidence}
                            </div>
                          )}
                          {option.matchAnalysis.vendorAnalysis && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                              <strong>Vendor:</strong> {option.matchAnalysis.vendorAnalysis}
                            </div>
                          )}
                          {option.matchAnalysis.placeholderMatch && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                              <strong>Placeholder Match:</strong> {option.matchAnalysis.placeholderMatch}
                            </div>
                          )}
                          {option.matchAnalysis.budgetFit && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#555" }}>
                              <strong>Budget Fit:</strong> {option.matchAnalysis.budgetFit}
                            </div>
                          )}
                          {option.matchAnalysis.reasonForChoice && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#555", fontStyle: "italic" }}>
                              {option.matchAnalysis.reasonForChoice}
                            </div>
                          )}
                          {option.matchAnalysis.discrepancies && (
                            <div style={{ marginTop: "6px", fontSize: "13px", color: "#d97706" }}>
                              <strong>⚠️ Concerns:</strong> {option.matchAnalysis.discrepancies}
                            </div>
                          )}
                        </div>
                      )}
                      {option.facts && typeof option.facts === 'object' && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                          <ul style={{ margin: "4px 0 0 16px", paddingLeft: "0", fontSize: "13px", color: "#555" }}>
                            {option.facts.jobType && <li><strong>Type:</strong> {option.facts.jobType}</li>}
                            {option.facts.totalRevenue && <li><strong>Total revenue:</strong> £{option.facts.totalRevenue.toLocaleString()}</li>}
                            {option.facts.startDate && <li><strong>Start date:</strong> {option.facts.startDate}</li>}
                            {option.facts.endDate && <li><strong>End date:</strong> {option.facts.endDate}</li>}
                            {option.facts.existingInvoices && (
                              <li>
                                <strong>Existing invoices:</strong>
                                <div style={{ marginTop: "4px", fontFamily: "monospace", fontSize: "11px", color: "#333", lineHeight: "1.6" }}>
                                  {option.facts.existingInvoices.split(/\.\s+(?=Row )/).map((line, i) => (
                                    <div key={i} style={{ paddingLeft: "4px", borderLeft: "2px solid #e0e0e0", marginBottom: "2px" }}>{line.trim()}</div>
                                  ))}
                                </div>
                              </li>
                            )}
                            {option.facts.remainingToInvoice && <li><strong>Left to invoice:</strong> £{option.facts.remainingToInvoice.toLocaleString()}</li>}
                            {option.facts.invoiceMatchStatus && <li><strong>{option.facts.invoiceMatchStatus}</strong></li>}
                          </ul>
                        </div>
                      )}
                      {option.facts && option.facts.discrepancies && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #ddd" }}>
                          <strong style={{ color: "#d97706" }}>⚠️ {option.facts.discrepancies}</strong>
                        </div>
                      )}
                      {option.businessLogic && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                          <strong>Why this works:</strong>
                          <div style={{ marginTop: "4px", color: "#555", fontStyle: "italic" }}>{option.businessLogic}</div>
                        </div>
                      )}
                      {option.recommendedActions && Array.isArray(option.recommendedActions) && option.recommendedActions.length > 0 && option.discrepancyType !== "inv_vat_mismatch" && (
                        <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                          <strong>Actions:</strong>
                          {option.recommendedActions.map((action, i) => (
                            <div key={i} style={{ fontSize: "13px", color: "#555", marginTop: i === 0 ? "8px" : "6px", paddingTop: i === 0 ? "8px" : "0", borderTop: i === 0 ? "1px solid #ddd" : "none" }}>
                              {i === 0 ? <strong style={{ color: "#059669" }}>✓ {action}</strong> : `• ${action}`}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Fallback for old format fields */}
                      {option.jobStatus && (
                        <div style={styles.optionDetail}>
                          <strong>Status:</strong> {option.jobStatus}
                        </div>
                      )}
                      {option.existingInvoices && option.existingInvoices.length > 0 && (
                        <div style={styles.optionDetail}>
                          <strong>Existing invoices:</strong>
                          {option.existingInvoices.map((inv, i) => (
                            <div key={i} style={{ marginLeft: "16px", fontSize: "13px" }}>
                              {inv.date} - {inv.amount} ({inv.ref})
                            </div>
                          ))}
                        </div>
                      )}
                      {option.remainingToInvoice && (
                        <div style={styles.optionDetail}>
                          <strong>Remaining to invoice:</strong> {option.remainingToInvoice}
                        </div>
                      )}
                      {option.summary && !option.businessLogic && (
                        <div style={styles.optionSummary}>{option.summary}</div>
                      )}
                      <button className="triage-btn triage-btn-primary"
                        onClick={() => acceptOption(option)}
                        disabled={isAccepting}
                        style={{
                          ...styles.decisionButton,
                          ...styles.approveButton,
                          marginTop: "12px",
                          width: "100%",
                          opacity: isAccepting ? 0.5 : 1,
                        }}
                      >
                        {isAccepting ? <><Spinner color="white" />Writing to sheet...</> : `✓ Accept Option ${idx + 1}`}
                      </button>
                      </>)}
                    </div>
                  ));
                }
              } catch (e) {
                // Show as plain text if not JSON
                return (
                  <div style={styles.claudeAnalysis}>
                    {claudeAnalysis.split('\n').map((line, idx) => (
                      <div key={idx}>{line || <br />}</div>
                    ))}
                  </div>
                );
              }
            })()}
          </div>
        )}

        {isAnalyzing && (
          <div style={{ ...styles.claudeAnalysis, textAlign: "center", color: "#666" }}>
            Generating options for this alert...
          </div>
        )}

        <div style={{ marginTop: "16px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <button className="triage-btn"
            onClick={() => {
              const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
              setClientAlerts(updatedAlerts);
              setCurrentClientAlertIndex(0);
              if (updatedAlerts.length === 0) {
                if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                else setScreen("alertSelection");
              } else { setScreen("alertSelection"); }
            }}
            style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#d97706" }}
          >
            ⏭ Skip Alert
          </button>
          <button className="triage-btn"
            onClick={() => setShowIgnoreModal(true)}
            style={{ ...styles.buttonSecondary, color: "#c62828", borderColor: "#ef9a9a" }}
          >
            🚫 Ignore Forever
          </button>
          <button className="triage-btn"
            onClick={() => openCreateTaskModal(clientAlerts[currentClientAlertIndex], false)}
            style={{ ...styles.buttonSecondary, color: "#7c3aed", borderColor: "#c4b5fd" }}
          >
            📋 Create Task
          </button>
          {(selectedClient?.clientSheetId || selectedClient?.masterSheetId) && (
            <button className="triage-btn"
              onClick={() => {
                const clientUrl = selectedClient.clientSheetId
                  ? `https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`
                  : null;
                const masterUrl = selectedClient.masterSheetId
                  ? `https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`
                  : null;
                if (clientUrl) window.open(clientUrl, "_blank");
                if (masterUrl) window.open(masterUrl, "_blank");
              }}
              style={{ ...styles.buttonSecondary, color: "#1d4ed8", borderColor: "#93c5fd" }}
            >
              📊 Open Sheets
            </button>
          )}
          {/* Use AI button — shown for alert types that previously used Claude */}
          {claudeAnalysis && (() => {
            const alert = clientAlerts[currentClientAlertIndex];
            const ft = alert?.flagType || alert?.alertType || alert?.type || "";
            const aiTypes = new Set(["invoiceDashboardDiscr","expenseDashboardDiscr",
              "crmPipeDashDiscr","crmConfDashDiscr","crmPipeAppDiscr","crmConfAppDiscr"]);
            if (!aiTypes.has(ft)) return null;
            return (
              <button className="triage-btn" disabled={isAnalyzing}
                onClick={async () => {
                  setIsAnalyzing(true);
                  setClaudeAnalysis("");
                  try {
                    const res = await fetch("/api/triage", {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "analyze_alert_ai", alert, automationCommanderSheetId }),
                    });
                    const d = await res.json();
                    if (d.success) {
                      const pir = d.previousIgnoreReason;
                      setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
                      setClaudeAnalysis(JSON.stringify(d.options || [], null, 2));
                    } else {
                      setClaudeAnalysis("Error: " + (d.error || "Unknown error"));
                    }
                  } catch(e) { setClaudeAnalysis("Error: " + e.message); }
                  finally { setIsAnalyzing(false); }
                }}
                style={{ ...styles.buttonSecondary, color: "#059669", borderColor: "#6ee7b7",
                  opacity: isAnalyzing ? 0.6 : 1 }}>
                🤖 Use AI
              </button>
            );
          })()}
        </div>

        {/* Existing task banner */}
        {existingTaskBanner && (
          <div style={{ marginTop: "12px", padding: "12px 16px", background: "#f3e8ff", border: "1px solid #c4b5fd", borderRadius: "6px" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#7c3aed", marginBottom: "6px" }}>
              📋 This alert has an existing task{existingTaskBanner.dataChanged ? " — underlying data has changed since the task was created" : ""}
            </div>
            <div style={{ fontSize: "12px", color: "#555", marginBottom: "8px" }}>
              Created: {existingTaskBanner.taskCreatedAt ? new Date(existingTaskBanner.taskCreatedAt).toLocaleDateString("en-GB") : "unknown"}
              {existingTaskBanner.taskNote ? ` · Note: "${existingTaskBanner.taskNote}"` : ""}
              {existingTaskBanner.isSnoozed ? ` · Snoozed until ${new Date(existingTaskBanner.snoozedUntil).toLocaleString("en-GB")}` : ""}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button className="triage-btn" onClick={() => { handleNavTasks(); setActiveNav("tasks"); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                View Task
              </button>
              {existingTaskBanner.dataChanged && (
                <>
                  <button className="triage-btn"
                    onClick={async () => {
                      const alert = clientAlerts[currentClientAlertIndex];
                      await fetch("/api/triage", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "update_task",
                          fingerprintHash: existingTaskBanner.fingerprintHash,
                          newCachedOptionsJSON: claudeAnalysis,
                          newAlertData: JSON.stringify(alert),
                          unsnooze: false,
                          automationCommanderSheetId,
                        }),
                      });
                      setExistingTaskBanner(prev => ({ ...prev, dataChanged: false }));
                    }}
                    style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}>
                    Update Task
                  </button>
                  {existingTaskBanner.isSnoozed && (
                    <button className="triage-btn"
                      onClick={async () => {
                        const alert = clientAlerts[currentClientAlertIndex];
                        await fetch("/api/triage", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: "update_task",
                            fingerprintHash: existingTaskBanner.fingerprintHash,
                            newCachedOptionsJSON: claudeAnalysis,
                            newAlertData: JSON.stringify(alert),
                            unsnooze: true,
                            automationCommanderSheetId,
                          }),
                        });
                        setExistingTaskBanner(prev => ({ ...prev, dataChanged: false, isSnoozed: false }));
                      }}
                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                      Update &amp; Unsnooze
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Ignore reason modal */}
        {showIgnoreModal && (
          <div style={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowIgnoreModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Permanently Ignore Alert</h3>
              <p style={styles.modalSubtitle}>
                This alert will be hidden from all future triage runs unless its underlying data changes.
                Optionally add a reason for your records.
              </p>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Reason for ignoring (optional)..."
                style={styles.modalTextarea}
                autoFocus
              />
              <div style={styles.modalButtons}>
                <button className="triage-btn"
                  onClick={() => { setShowIgnoreModal(false); setIgnoreReason(""); }}
                  style={styles.buttonSecondary}
                >
                  Cancel
                </button>
                <button className="triage-btn"
                  onClick={ignoreAlert}
                  disabled={isIgnoring}
                  style={{ ...styles.ignoreButton, opacity: isIgnoring ? 0.5 : 1 }}
                >
                  {isIgnoring ? <><Spinner />Ignoring...</> : "🚫 Confirm Ignore"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}