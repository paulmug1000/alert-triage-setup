import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";
import { useSettings } from "../hooks/useSettings";
import { useTriage } from "../contexts/TriageContext";

export default function SettingsView({
  automationCommanderSheetId,
  allOutgoingsClients,
  getFlagName
}) {
  const { clientsWithFlags, isLoading, refreshTriage } = useTriage();

  const [triggeringProactive, setTriggeringProactive] = useState(false);
  const [triggerProactiveMsg, setTriggerProactiveMsg] = useState("");

  const {
    settingsData, setSettingsData, settingsLoading, setSettingsLoading,
    settingsEditHourly, setSettingsEditHourly, settingsEditDaily, setSettingsEditDaily,
    settingsEditAnomaly, setSettingsEditAnomaly, settingsSaving, setSettingsSaving,
    settingsSaveMsg, setSettingsSaveMsg, agentRunClient, setAgentRunClient,
    agentRunTypes, setAgentRunTypes, agentRunStatus, setAgentRunStatus,
    agentRunMsg, setAgentRunMsg, agentRunId, setAgentRunId,
    agentProgressEntries, setAgentProgressEntries, agentRunStartedAt, setAgentRunStartedAt,
    sweepSchedule, setSweepSchedule, sweepScheduleLoading, setSweepScheduleLoading,
    sweepScheduleLoaded, setSweepScheduleLoaded, sweepFrequencySaving, setSweepFrequencySaving,
    flagSweepLog, setFlagSweepLog, flagSweepLogLoading, setFlagSweepLogLoading,
    flagSweepLogLoaded, setFlagSweepLogLoaded, flagSweepLogExpanded, setFlagSweepLogExpanded,
    precomputeLog, setPrecomputeLog, precomputeLogLoading, setPrecomputeLogLoading,
    precomputeLogLoaded, setPrecomputeLogLoaded, precomputeLogExpanded, setPrecomputeLogExpanded,
    buildOptionsLog, setBuildOptionsLog, buildOptionsLogLoading, setBuildOptionsLogLoading,
    buildOptionsLogLoaded, setBuildOptionsLogLoaded, buildOptionsLogExpanded, setBuildOptionsLogExpanded,
    loadSweepSchedule, saveSweepFrequency, loadFlagSweepLog, toggleFlagSweepLogDetail,
    loadPrecomputeLog, loadBuildOptionsLog, togglePrecomputeLogDetail, toggleBuildOptionsLogDetail
  } = useSettings(automationCommanderSheetId);

  const [diagClientName, setDiagClientName] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null);
  const [diagError, setDiagError] = useState("");

  // Initialize data on mount
  useEffect(() => {
    if (!automationCommanderSheetId) return;

    setSettingsLoading(true);
    if (!sweepScheduleLoaded) loadSweepSchedule();
    if (!flagSweepLogLoaded) loadFlagSweepLog();
    if (!buildOptionsLogLoaded) loadBuildOptionsLog();
    if (!precomputeLogLoaded) loadPrecomputeLog();
    
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_claude_settings", automationCommanderSheetId }) })
      .then(r => r.json()).then(d => {
        if (d.success) {
          setSettingsData(d);
          setSettingsEditHourly(d.config?.hourlyLimit ?? 10);
          setSettingsEditDaily(d.config?.dailyLimit ?? 30);
          setSettingsEditAnomaly(d.config?.anomalyThreshold ?? 15);
        }
      })
      .catch(e => console.error("get_claude_settings error:", e))
      .finally(() => setSettingsLoading(false));
  }, [
    automationCommanderSheetId, buildOptionsLogLoaded, flagSweepLogLoaded, 
    loadBuildOptionsLog, loadFlagSweepLog, loadPrecomputeLog, 
    loadSweepSchedule, precomputeLogLoaded, setSettingsData, 
    setSettingsEditAnomaly, setSettingsEditDaily, setSettingsEditHourly, 
    setSettingsLoading, sweepScheduleLoaded
  ]);

  const saveSettings = async () => {
    setSettingsSaving(true); setSettingsSaveMsg("");
    try {
      const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_claude_settings", automationCommanderSheetId,
          hourlyLimit: settingsEditHourly, dailyLimit: settingsEditDaily, anomalyThreshold: settingsEditAnomaly }) });
      const d = await res.json();
      if (d.success) {
        setSettingsSaveMsg("✓ Saved");
      } else { setSettingsSaveMsg("Error: " + d.error); }
    } catch(e) { setSettingsSaveMsg("Error: " + e.message); }
    finally { setSettingsSaving(false); }
  };

  const u = settingsData?.usage;
  const rows = settingsData?.recentRows || [];

  return (
    <div style={{ padding: "20px", maxWidth: "800px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: "20px", fontWeight: "700" }}>Settings</h2>

      {settingsLoading && <div style={{ color: "#999", padding: "20px" }}>Loading...</div>}

      {!settingsLoading && (
        <>
          {/* Run Client Automation */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Run Client Automation</h3>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#666" }}>
              Runs a client&apos;s invoice/CRM/expense automation sequence on demand, via that client&apos;s Web App deployment — instead of checking a box in Automation Commander and waiting for the 30-minute poll.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "14px" }}>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>Client</label>
                <select value={agentRunClient} onChange={e => { setAgentRunClient(e.target.value); setAgentRunStatus("idle"); setAgentRunMsg(""); }}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }}>
                  <option value="">Select a client...</option>
                  {(allOutgoingsClients || []).map(c => (
                    <option key={c.clientName} value={c.clientName}>
                      {c.clientName}{!c.hasWebAppUrl ? " (no Web App URL configured)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>Sequences to run</label>
                <div style={{ display: "flex", gap: "14px", paddingTop: "8px" }}>
                  {[["invoice","Invoice"],["crm","CRM"],["expense","Expense"]].map(([key,label]) => (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "13px", color: "#333", cursor: "pointer" }}>
                      <input type="checkbox" checked={!!agentRunTypes[key]}
                        onChange={e => setAgentRunTypes(prev => ({ ...prev, [key]: e.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                disabled={!agentRunClient || agentRunStatus === "running" || !Object.values(agentRunTypes).some(Boolean)}
                onClick={async () => {
                  setAgentRunStatus("running"); setAgentRunMsg(""); setAgentProgressEntries([]); setAgentRunId(null);
                  setAgentRunStartedAt(Date.now());
                  const types = Object.entries(agentRunTypes).filter(([,v]) => v).map(([k]) => k);
                  try {
                    const r = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "trigger_agent_run", automationCommanderSheetId, clientName: agentRunClient, types }) });
                    const d = await r.json();
                    if (d.success) {
                      setAgentRunMsg("Triggered — Apps Script doesn&apos;t guarantee exact timing, so this may take a few minutes to actually start. Progress will appear below once it does.");
                      setAgentRunId(d.runId || null);
                    } else {
                      setAgentRunStatus("error");
                      setAgentRunMsg(d.error || "Failed to trigger run");
                    }
                  } catch (e) {
                    setAgentRunStatus("error");
                    setAgentRunMsg(e.message);
                  }
                }}
                style={{ padding: "8px 20px", background: (!agentRunClient || agentRunStatus === "running" || !Object.values(agentRunTypes).some(Boolean)) ? "#ccc" : "#0066cc",
                  color: "#fff", border: "none", borderRadius: "6px",
                  cursor: (!agentRunClient || agentRunStatus === "running") ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {agentRunStatus === "running" ? "Running..." : "Run"}
              </button>
              {agentRunMsg && (
                <span style={{ fontSize: "13px", color: agentRunStatus === "success" ? "#166534" : agentRunStatus === "error" ? "#dc2626" : "#666" }}>{agentRunMsg}</span>
              )}
            </div>

            {agentProgressEntries.length > 0 && (
              <div style={{ marginTop: "12px", background: "#f8f9ff", border: "1px solid #e8eaf0", borderRadius: "6px", padding: "10px 12px", maxHeight: "180px", overflowY: "auto" }}>
                {agentProgressEntries.map((entry, i) => (
                  <div key={i} style={{ fontSize: "12px", color: "#333", padding: "3px 0", borderBottom: i < agentProgressEntries.length - 1 ? "1px solid #eceef5" : "none" }}>
                    <span style={{ color: "#888", fontFamily: "monospace" }}>{entry.at ? new Date(entry.at).toLocaleTimeString() : ""}</span>
                    {" — "}
                    <strong style={{ textTransform: "capitalize" }}>{entry.stage}:</strong> {entry.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Alert System */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700" }}>Alert System</h3>
            <p style={{ margin: "0 0 18px", fontSize: "12px", color: "#666" }}>
              Every alert — actionable, informational, or proactive — is detected, resolved, and cleared independently of every other. The three categories below each run on their own schedule.
            </p>

            {/* Check frequency */}
            <div style={{ marginBottom: "20px", paddingBottom: "18px", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: "#1a1a1a", marginBottom: "4px" }}>Check frequency</div>
              <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#888" }}>
                How often each category is checked for. A single 30-minute Google Apps Script trigger drives all three — each just decides independently whether it&apos;s actually due yet.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
                {[
                  { key: "actionable", label: "Actionable", hint: "Discrepancies needing review — invoice, CRM, expense" },
                  { key: "info", label: "Informational", hint: "Acknowledge-only events from AutoLog" },
                  { key: "proactive", label: "Proactive", hint: "The 14 proactive checks" },
                ].map(cat => {
                  const entry = sweepSchedule?.[cat.key];
                  return (
                    <div key={cat.key} style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: "8px", padding: "8px", minWidth: 0, wordBreak: "break-word" }}>
                      <div style={{ fontSize: "12px", fontWeight: "600", color: "#1a1a1a", marginBottom: "2px", hyphens: "auto" }}>{cat.label}</div>
                      <div style={{ fontSize: "10px", color: "#888", marginBottom: "8px", hyphens: "auto" }}>{cat.hint}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
                        <input
                          type="number"
                          min="1"
                          disabled={sweepScheduleLoading}
                          value={entry?.frequencyMinutes ?? ""}
                          onChange={(e) => setSweepSchedule(prev => ({ ...prev, [cat.key]: { ...prev?.[cat.key], frequencyMinutes: e.target.value } }))}
                          onBlur={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (val > 0) saveSweepFrequency(cat.key, val);
                          }}
                          style={{ width: "min(100%, 50px)", fontSize: "12px", padding: "4px 6px", borderRadius: "6px", border: "1px solid #ddd", opacity: sweepFrequencySaving === cat.key ? 0.5 : 1, boxSizing: "border-box" }}
                        />
                        <span style={{ fontSize: "11px", color: "#666" }}>mins</span>
                      </div>
                      {entry?.lastCheckedAt && (
                        <div style={{ fontSize: "9px", color: "#aaa", marginTop: "6px", lineHeight: "1.2" }}>
                          Last checked:<br/>{new Date(entry.lastCheckedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Alert Pipeline Activity */}
            <div style={{ marginBottom: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
                <div style={{ flex: "1 1 200px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "15px", fontWeight: "700" }}>Alert Pipeline Activity</h3>
                  <p style={{ margin: 0, fontSize: "12px", color: "#666" }}>
                    The end-to-end flow of alerts: Detection (Sweep) → AI & Logic (Build) → App Cache (Precompute).
                  </p>
                </div>
                <button className="triage-btn" onClick={() => { loadFlagSweepLog(); loadBuildOptionsLog(); loadPrecomputeLog(); }}
                  style={{ background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" }}>
                  ↻ Refresh Logs
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
                {/* Column 1: Sweep */}
                <div style={{ background: "#f8f9ff", border: "1px solid #e8eaf0", borderRadius: "8px", display: "flex", flexDirection: "column", height: "400px", minWidth: 0 }}>
                  <div style={{ padding: "8px", background: "#eef2ff", borderBottom: "1px solid #e8eaf0", borderRadius: "8px 8px 0 0", wordBreak: "break-word" }}>
                    <div style={{ fontSize: "12px", fontWeight: "700", color: "#1d4ed8", marginBottom: "2px", hyphens: "auto" }}>🔍 1. Flag Sweep</div>
                    <div style={{ fontSize: "10px", color: "#666", hyphens: "auto" }}>Searches sheets for new discrepancies</div>
                  </div>

                  <div style={{ padding: "6px", overflowY: "auto", flex: 1, minWidth: 0 }}>
                    {flagSweepLogLoading && <div style={{ fontSize: "11px", color: "#999", textAlign: "center", padding: "10px" }}>Loading...</div>}
                    {!flagSweepLogLoading && flagSweepLog && flagSweepLog.length === 0 && <div style={{ fontSize: "11px", color: "#888", textAlign: "center", padding: "10px" }}>No runs logged yet</div>}
                    {flagSweepLog?.map((run, i) => (
                      <div key={i} style={{ fontSize: "10px", color: "#555", marginBottom: "6px", padding: "6px", background: "#fff", borderRadius: "6px", border: "1px solid #e0e0e0", wordBreak: "break-word" }}>
                        <div onClick={() => run.raisedDetail?.length > 0 && toggleFlagSweepLogDetail(i)} style={{ display: "flex", flexDirection: "column", gap: "2px", cursor: run.raisedDetail?.length > 0 ? "pointer" : "default", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                          <span>{run.raisedDetail?.length > 0 ? (flagSweepLogExpanded.has(i) ? "▾ " : "▸ ") : ""}{new Date(run.runAt).toLocaleString("en-GB", { timeStyle: "short", dateStyle: "short" })}</span>
                          <span style={{ color: (run.flagsRaised > 0 || run.alertsWoken > 0) ? "#b45309" : "#166534" }}>
                            {run.flagsRaised} raised{run.alertsDelayed > 0 ? ` (${run.alertsDelayed} delayed)` : ""}{run.alertsWoken > 0 ? ` · ${run.alertsWoken} woken` : ""}
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "9px", color: "#888" }}>
                          <span>{run.clientsChecked} checked {run.categoriesRun ? `(${run.categoriesRun})` : ""}</span>
                          <span>{run.elapsedSeconds}s{run.errors > 0 ? ` · ${run.errors} err` : ""}</span>
                        </div>
                        {flagSweepLogExpanded.has(i) && run.raisedDetail?.length > 0 && (
                          <div style={{ marginTop: "4px", paddingTop: "4px", borderTop: "1px dashed #eee", display: "flex", flexDirection: "column", gap: "4px" }}>
                            {run.raisedDetail.map((d, di) => (
                              <div key={di} style={{ fontSize: "9px", color: "#555" }}>
                                <strong>{d.clientName}</strong>:<br/>{getFlagName(d.flagKey)} 
                                <span style={{ color: d.status === "delayed" ? "#d97706" : d.status === "woken" ? "#059669" : "#1d4ed8", fontWeight: "600" }}> ({d.status || "raised"})</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Column 2: Build */}
                <div style={{ background: "#fdf8ff", border: "1px solid #f3e8ff", borderRadius: "8px", display: "flex", flexDirection: "column", height: "400px", minWidth: 0 }}>
                  <div style={{ padding: "8px", background: "#f3e8ff", borderBottom: "1px solid #e8eaf0", borderRadius: "8px 8px 0 0", wordBreak: "break-word" }}>
                    <div style={{ fontSize: "12px", fontWeight: "700", color: "#7c3aed", marginBottom: "2px", hyphens: "auto" }}>⚙️ 2. Build Options</div>
                    <div style={{ fontSize: "10px", color: "#666", hyphens: "auto" }}>Generates resolutions for new alerts</div>
                  </div>
                  <div style={{ padding: "6px", overflowY: "auto", flex: 1, minWidth: 0 }}>
                    {buildOptionsLogLoading && <div style={{ fontSize: "11px", color: "#999", textAlign: "center", padding: "10px" }}>Loading...</div>}
                    {!buildOptionsLogLoading && buildOptionsLog && buildOptionsLog.length === 0 && <div style={{ fontSize: "11px", color: "#888", textAlign: "center", padding: "10px" }}>No runs logged yet</div>}
                    {buildOptionsLog?.map((run, i) => (
                      <div key={i} style={{ fontSize: "10px", color: "#555", marginBottom: "6px", padding: "6px", background: "#fff", borderRadius: "6px", border: "1px solid #e0e0e0", wordBreak: "break-word" }}>
                        <div onClick={() => run.builtDetail?.length > 0 && toggleBuildOptionsLogDetail(i)} style={{ display: "flex", flexDirection: "column", gap: "2px", cursor: run.builtDetail?.length > 0 ? "pointer" : "default", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                          <span>{run.builtDetail?.length > 0 ? (buildOptionsLogExpanded.has(i) ? "▾ " : "▸ ") : ""}{new Date(run.runAt).toLocaleString("en-GB", { timeStyle: "short", dateStyle: "short" })}</span>
                          <span style={{ color: run.built > 0 ? "#7c3aed" : "#666" }}>{run.built} built</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "9px", color: "#888" }}>
                          <span>{run.processed} processed</span>
                          <span>{run.elapsedSeconds}s{run.errors > 0 ? ` · ${run.errors} err` : ""}{run.notFound > 0 ? ` · ${run.notFound} skip` : ""}</span>
                        </div>
                        {buildOptionsLogExpanded.has(i) && run.builtDetail?.length > 0 && (
                          <div style={{ marginTop: "4px", paddingTop: "4px", borderTop: "1px dashed #eee", display: "flex", flexDirection: "column", gap: "4px" }}>
                            {run.builtDetail.map((d, di) => (
                              <div key={di} style={{ fontSize: "9px", color: "#555", display: "flex", flexDirection: "column", gap: "1px" }}>
                                <strong>{d.clientName}</strong>
                                <span>{getFlagName(d.flagKey)}{d.fromCache ? " (cached)" : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Column 3: Precompute */}
                <div style={{ background: "#f0fdf4", border: "1px solid #dcfce7", borderRadius: "8px", display: "flex", flexDirection: "column", height: "400px", minWidth: 0 }}>
                  <div style={{ padding: "8px", background: "#dcfce7", borderBottom: "1px solid #bbf7d0", borderRadius: "8px 8px 0 0", wordBreak: "break-word" }}>
                    <div style={{ fontSize: "12px", fontWeight: "700", color: "#15803d", marginBottom: "2px", hyphens: "auto" }}>📦 3. Precompute</div>
                    <div style={{ fontSize: "10px", color: "#666", hyphens: "auto" }}>Compiles final data for the app</div>
                  </div>
                  <div style={{ padding: "6px", overflowY: "auto", flex: 1, minWidth: 0 }}>
                    {precomputeLogLoading && <div style={{ fontSize: "11px", color: "#999", textAlign: "center", padding: "10px" }}>Loading...</div>}
                    {!precomputeLogLoading && precomputeLog && precomputeLog.length === 0 && <div style={{ fontSize: "11px", color: "#888", textAlign: "center", padding: "10px" }}>No runs logged yet</div>}
                    {precomputeLog?.map((run, i) => (
                      <div key={i} style={{ fontSize: "10px", color: "#555", marginBottom: "6px", padding: "6px", background: "#fff", borderRadius: "6px", border: "1px solid #e0e0e0", wordBreak: "break-word" }}>
                        <div onClick={() => run.clientDetail?.length > 0 && togglePrecomputeLogDetail(i)} style={{ display: "flex", flexDirection: "column", gap: "2px", cursor: run.clientDetail?.length > 0 ? "pointer" : "default", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                          <span>{run.clientDetail?.length > 0 ? (precomputeLogExpanded.has(i) ? "▾ " : "▸ ") : ""}{new Date(run.runAt).toLocaleString("en-GB", { timeStyle: "short", dateStyle: "short" })}</span>
                          <span style={{ color: (run.totalAlerts + run.noActionCount + (run.proactiveCount || 0)) > 0 ? "#15803d" : "#666" }}>
                            {(run.totalAlerts || 0) + (run.noActionCount || 0) + (run.proactiveCount || 0)} alerts
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "9px", color: "#888" }}>
                          <span>{run.clientsWithFlags} clients</span>
                          <span>{run.totalAlerts} a · {run.noActionCount} i · {run.proactiveCount || 0} p</span>
                        </div>
                        {precomputeLogExpanded.has(i) && run.clientDetail?.length > 0 && (
                          <div style={{ marginTop: "4px", paddingTop: "4px", borderTop: "1px dashed #eee", display: "flex", flexDirection: "column", gap: "2px" }}>
                            {run.clientDetail.map((c, ci) => (
                              <div key={ci} style={{ fontSize: "9px", color: "#555", display: "flex", flexDirection: "column", gap: "1px" }}>
                                <strong>{c.clientName}</strong>
                                <span>{c.alertCount} a, {c.noActionCount} i, {c.proactiveCount || 0} p</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Alert Types */}
            <div style={{ marginBottom: "20px", paddingTop: "18px", borderTop: "1px solid #f0f0f0" }}>
              <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Alert Types</h3>
              <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#666" }}>
                Every alert type the system can raise. Each one is detected, resolved, and cleared entirely on its own — nothing here is grouped, and resolving one alert never depends on or affects any other.
              </p>

              {[
                {
                  group: "Invoice",
                  items: [
                    { key: "invoiceDashboardDiscr", name: "Invoice dashboard discrepancy", kind: "actionable" },
                    { key: "invoiceStaleUnsentChanges", name: "Stale unsent invoice send date changed", kind: "info" },
                    { key: "retainerInvoicesCreated", name: "Retainer invoices created", kind: "info" },
                    { key: "retainerInvoicesDeleted", name: "Retainer invoices deleted", kind: "info" },
                  ],
                },
                {
                  group: "CRM",
                  items: [
                    { key: "crmPipeDashDiscr", name: "CRM pipeline dashboard discrepancy", kind: "actionable" },
                    { key: "crmPipeAppDiscr", name: "CRM pipeline app discrepancy", kind: "actionable" },
                    { key: "crmConfDashDiscr", name: "CRM confirmed dashboard discrepancy", kind: "actionable" },
                    { key: "crmConfAppDiscr", name: "CRM confirmed app discrepancy", kind: "actionable" },
                    { key: "crmCopiedConfChecked", name: "CRM copied to Confirmed — checked", kind: "info" },
                    { key: "crmCopiedConfUnchecked", name: "CRM copied to Confirmed — unchecked", kind: "info" },
                    { key: "crmCopiedConfDelete", name: "CRM copied to Confirmed — delete", kind: "info" },
                  ],
                },
                {
                  group: "Expense",
                  items: [
                    { key: "expenseDashboardDiscr", name: "Expense dashboard discrepancy", kind: "actionable" },
                    { key: "expenseAdded", name: "Expense added", kind: "info" },
                    { key: "expenseUnreconGaps", name: "Expense reconciliation gaps", kind: "info" },
                  ],
                },
              ].map((g, gi) => (
                <div key={g.group} style={{ marginTop: gi > 0 ? "14px" : 0, paddingTop: gi > 0 ? "12px" : 0, borderTop: gi > 0 ? "1px solid #f5f5f5" : "none" }}>
                  <div style={{ fontSize: "13px", fontWeight: "700", color: "#1a56db", marginBottom: "8px" }}>{g.group}</div>
                  {g.items.map((it, i) => (
                    <div key={it.key} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 0", borderTop: i > 0 ? "1px solid #f5f5f5" : "none" }}>
                      <span style={{
                        fontSize: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.02em",
                        padding: "2px 7px", borderRadius: "10px", height: "fit-content", whiteSpace: "nowrap",
                        ...(it.kind === "actionable"
                          ? { background: "#eef4ff", color: "#1d4ed8" }
                          : { background: "#f4f4f5", color: "#71717a" }),
                      }}>
                        {it.kind === "actionable" ? "Actionable" : "Informational"}
                      </span>
                      <div style={{ fontSize: "13px", color: "#1a1a1a", paddingTop: "1px", flex: 1 }}>{it.name}</div>
                    </div>
                  ))}
                </div>
              ))}

              <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #e8e8e8", fontSize: "11px", color: "#888", lineHeight: "1.6" }}>
                <strong>Actionable</strong> — generates an individual alert with options to accept or ignore, shown in the main alert list.{" "}
                <strong>Informational</strong> — an event worth knowing about; acknowledge it directly on the alert card, with no options to act on.
              </div>
            </div>

            {/* Proactive Checks */}
            <div style={{ paddingTop: "18px", borderTop: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
                <div style={{ paddingRight: "16px" }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Proactive Checks</h3>
                  <p style={{ margin: 0, fontSize: "12px", color: "#666" }}>
                    These checks run whenever the proactive category is due (see the frequency setting above), across every client, and surface as alerts on the Home screen when something needs attention.
                  </p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", flexShrink: 0 }}>
                  <button className="triage-btn" disabled={isLoading} onClick={async () => {
                    setTriggeringProactive(true); setTriggerProactiveMsg("");
                    try {
                      await refreshTriage(true);
                      setTriggerProactiveMsg("✓ Checks complete! Alerts updated.");
                    } catch(e) { setTriggerProactiveMsg("Error: " + e.message); }
                    finally { setTriggeringProactive(false); }
                  }} style={{ background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: isLoading ? "default" : "pointer", whiteSpace: "nowrap" }}>
                    {isLoading ? <><Spinner size={12}/>Running...</> : "▶ Run Checks Now"}
                  </button>
                  {triggerProactiveMsg && <span style={{ fontSize: "11px", color: triggerProactiveMsg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>{triggerProactiveMsg}</span>}
                </div>
              </div>

              {[
                { name: "Retainer invoice monitoring", detail: "Flags retainer jobs where an invoice was scheduled to be sent but no invoice reference has been recorded." },
                { name: "CRM data wipe detection", detail: "Watches for AutoLog entries warning that the CRM wiped a job's data blank." },
                { name: "Revenue / total invoiced mismatch", detail: "Compares each job's revenue against the total invoiced amount, flagging zero-revenue jobs with invoices and material mismatches." },
                { name: "Direct costs / total expenses mismatch", detail: "Compares each job's direct cost budget against total recorded expenses, across both Pipeline and Confirmed." },
                { name: "Pipeline / Confirmed overlap", detail: "Finds jobs present in both tabs where the Pipeline entry hasn't been properly closed out (likelihood not 0%, not marked copied to Confirmed)." },
                { name: "Retainer shrink blocked", detail: "Flags retainer child rows that couldn't be automatically trimmed after a contract shrank, because the row already has actuals recorded." },
                { name: "Uninvoiced new job", detail: "Flags jobs that started over a month ago but still have no real invoices recorded (only placeholders or empty slots)." },
                { name: "Uninvoiced revenue on completed jobs", detail: "Flags project jobs (not retainers) that ended more than 2 weeks ago but still have uninvoiced revenue, excluding placeholder invoices and Draft invoices that haven't been sent." },
                { name: "Unreceived expenses on completed jobs", detail: "Flags project jobs (not retainers) that ended more than 2 weeks ago but still have unreceived expenses against their direct cost budget, excluding manual estimates and unreconciled-gap placeholders." },
                { name: "Deleted invoice detection", detail: "Flags invoices with a real reference on the Confirmed tab that no longer appear in the accounting system — a likely sign the invoice was deleted or voided." },
                { name: "Job structure errors", detail: "Flags jobs whose invoice/expense slots don't match the expected layout — e.g. a multi-row retainer with an invoice on the parent row, or slots filled out of sequence." },
                { name: "Deleted expense detection", detail: "Flags expenses with a real reference that no longer appear in the accounting system — the expense equivalent of deleted invoice detection." },
                { name: "Automation error detection", detail: "Watches the last 100 AutoLog entries for any occurrences of 'Error:', highlighting the error and the text that follows." },
                { name: "Infinite loop & automation conflict detection", detail: "Detects situations where automation routines fight each other, such as within-run inverted changes (e.g. days to pay extended then shortened) or recurring multi-run flip-flops (e.g. client name differing between Xero and CRM)." },
              ].map((c, i) => (
                <div key={c.name} style={{ display: "flex", gap: "10px", padding: "8px 0", borderTop: i > 0 ? "1px solid #f0f0f0" : "none" }}>
                  <span style={{ color: "#16a34a", fontSize: "14px", lineHeight: "20px" }}>✓</span>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>{c.name}</div>
                    <div style={{ fontSize: "12px", color: "#777", marginTop: "2px" }}>{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Claude API Usage */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Claude API Usage</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "12px" }}>
              {[
                { label: "This hour", calls: u?.thisHour?.calls ?? "–", cost: u?.thisHour?.cost ?? "–" },
                { label: "Today", calls: u?.today?.calls ?? "–", cost: u?.today?.cost ?? "–" },
                { label: "This week", calls: u?.week?.calls ?? "–", cost: u?.week?.cost ?? "–" },
              ].map(({ label, calls, cost }) => (
                <div key={label} style={{ background: "#f8f9ff", borderRadius: "8px", padding: "12px 14px", border: "1px solid #e8eaf0" }}>
                  <div style={{ fontSize: "11px", color: "#888", marginBottom: "4px" }}>{label}</div>
                  <div style={{ fontSize: "20px", fontWeight: "700", color: "#1a56db" }}>{calls}</div>
                  <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>calls · ${cost}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Limits config */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Usage Limits (precompute only)</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "14px" }}>
              {[
                { label: "Hourly limit", val: settingsEditHourly, set: setSettingsEditHourly, hint: "Max Claude calls per hour during precompute" },
                { label: "Daily limit", val: settingsEditDaily, set: setSettingsEditDaily, hint: "Max Claude calls per day during precompute" },
                { label: "Anomaly threshold", val: settingsEditAnomaly, set: setSettingsEditAnomaly, hint: "If a client has ≥ this many invoice/expense alerts, skip ALL precompute Claude calls for that client" },
              ].map(({ label, val, set, hint }) => (
                <div key={label}>
                  <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>{label}</label>
                  <input type="number" value={val} min={1} max={500}
                    onChange={e => set(parseInt(e.target.value) || 1)}
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "15px", boxSizing: "border-box" }} />
                  <div style={{ fontSize: "10px", color: "#999", marginTop: "4px" }}>{hint}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button onClick={saveSettings} disabled={settingsSaving}
                style={{ padding: "8px 20px", background: settingsSaving ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: settingsSaving ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {settingsSaving ? "Saving..." : "Save changes"}
              </button>
              {settingsSaveMsg && <span style={{ fontSize: "13px", color: settingsSaveMsg.startsWith("✓") ? "#166534" : "#dc2626" }}>{settingsSaveMsg}</span>}
            </div>
            <div style={{ marginTop: "12px", fontSize: "12px", color: "#888" }}>
              Note: limits apply to automated precompute only. On-demand analysis (clicking an alert) is always unrestricted.
            </div>
          </div>

          {/* Recent call log */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <details>
              <summary style={{ fontSize: "15px", fontWeight: "700", cursor: "pointer", userSelect: "none" }}>Recent Claude API calls (last 50)</summary>
              <div style={{ marginTop: "14px" }}>
                {rows.length === 0 ? (
                  <div style={{ color: "#999", fontSize: "13px" }}>No calls recorded yet</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                          {["Time", "Source", "Client", "Alert type", "Tokens", "Cost (USD)"].map(h => (
                            <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: "600", color: "#555", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #f0f0f0", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                            <td style={{ padding: "5px 10px", whiteSpace: "nowrap", color: "#666" }}>{r.ts ? new Date(r.ts).toLocaleString("en-GB") : "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.action || "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.client || "–"}</td>
                            <td style={{ padding: "5px 10px" }}>{r.alertType || "–"}</td>
                            <td style={{ padding: "5px 10px", textAlign: "right" }}>{r.tokens ? parseInt(r.tokens).toLocaleString() : "–"}</td>
                            <td style={{ padding: "5px 10px", textAlign: "right" }}>${r.cost ? parseFloat(r.cost).toFixed(4) : "0.0000"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Triage Diagnostic */}
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: "700" }}>Triage Diagnostic</h3>
            <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#666" }}>
              Compare what the Refresh button generates against AlertMemory for a specific client. Reveals fingerprint mismatches between start_triage and the GAS precompute.
            </p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px" }}>
              <select value={diagClientName} onChange={e => { setDiagClientName(e.target.value); setDiagResult(null); setDiagError(""); }}
                style={{ flex: 1, padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px" }}>
                <option value="">Select a client...</option>
                {(clientsWithFlags || []).map(c => (
                  <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
                ))}
              </select>
              <button className="triage-btn" disabled={!diagClientName || diagLoading}
                onClick={async () => {
                  const client = (clientsWithFlags || []).find(c => c.clientName === diagClientName);
                  if (!client) return;
                  setDiagLoading(true); setDiagResult(null); setDiagError("");
                  try {
                    const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "debug_compare_triage", automationCommanderSheetId,
                        clientSheetId: client.clientSheetId, masterSheetId: client.masterSheetId, clientName: client.clientName,
                        clientFlags: client.flags || {} }) });
                    const d = await res.json();
                    if (d.success) setDiagResult(d);
                    else setDiagError(d.error || "Unknown error");
                  } catch(e) { setDiagError(e.message); }
                  finally { setDiagLoading(false); }
                }}
                style={{ padding: "8px 16px", background: diagLoading ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: diagLoading ? "default" : "pointer", whiteSpace: "nowrap" }}>
                {diagLoading ? "Running..." : "Run diagnostic"}
              </button>
            </div>

            {diagError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "12px" }}>Error: {diagError}</div>}

            {diagResult && (() => {
              const s = diagResult.summary;
              return (
                <div>
                  {/* Summary counts */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "16px" }}>
                    {[
                      { label: "Generated", val: s.generated, sub: `inv:${s.inv} dir:${s.dir} crmP:${s.crmPipe} crmC:${s.crmConf}` },
                      { label: "Would filter", val: s.wouldBeFiltered, color: "#166534" },
                      { label: "Would pass through", val: s.wouldPassThrough, color: s.wouldPassThrough > 0 ? "#dc2626" : "#166534" },
                      { label: "AM entries with no match", val: s.unmatchedAlertMemoryEntries, color: s.unmatchedAlertMemoryEntries > 0 ? "#b45309" : "#166534" },
                      { label: "Not in AM anywhere", val: s.notInAnyAlertMemory, color: s.notInAnyAlertMemory > 0 ? "#dc2626" : "#166534" },
                      { label: "Stored under diff. client", val: s.foundUnderDifferentClient, color: s.foundUnderDifferentClient > 0 ? "#7c3aed" : "#166534" },
                    ].map(({ label, val, color, sub }) => (
                      <div key={label} style={{ background: "#f8f9ff", borderRadius: "8px", padding: "10px 12px", border: "1px solid #e8eaf0" }}>
                        <div style={{ fontSize: "10px", color: "#888", marginBottom: "2px" }}>{label}</div>
                        <div style={{ fontSize: "22px", fontWeight: "700", color: color || "#1a56db" }}>{val}</div>
                        {sub && <div style={{ fontSize: "10px", color: "#999", marginTop: "2px" }}>{sub}</div>}
                      </div>
                    ))}
                  </div>

                  {/* Alerts passing through (problem alerts) */}
                  {diagResult.generatedAlerts.filter(a => !a.wouldBeFiltered).length > 0 && (
                    <div style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#dc2626", marginBottom: "6px" }}>
                        ⚠ Alerts that would PASS THROUGH (not suppressed):
                      </div>
                      {diagResult.generatedAlerts.filter(a => !a.wouldBeFiltered).map((a, i) => (
                        <div key={i} style={{ background: "#fff5f5", border: "1px solid #fecaca", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                          <div style={{ fontWeight: "600", marginBottom: "2px" }}>{a.flagType} · hash: {a.fingerprintHash} · AM: {a.amStatus}</div>
                          <div style={{ color: "#555", marginBottom: "4px" }}>{a.summary}</div>
                          <div style={{ fontFamily: "monospace", color: "#888", wordBreak: "break-all", fontSize: "10px" }}>{a.rawFingerprint}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* AlertMemory entries with no matching generated alert */}
                  {diagResult.unmatchedAlertMemoryEntries.length > 0 && (
                    <div style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", marginBottom: "6px" }}>
                        ⚠ AlertMemory entries with NO matching generated alert (old hashes):
                      </div>
                      {diagResult.unmatchedAlertMemoryEntries.map((r, i) => (
                        <div key={i} style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                          <div style={{ fontWeight: "600" }}>{r.alertType} · hash: {r.fingerprintHash} · status: {r.status}</div>
                          <div style={{ color: "#555" }}>{r.alertSummary}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Alerts found under a different client name */}
                  {diagResult.foundUnderDifferentClient?.length > 0 && (
                    <div style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#7c3aed", marginBottom: "6px" }}>
                        ⚠ Alerts found in AM under a DIFFERENT client name:
                      </div>
                      {diagResult.foundUnderDifferentClient.map((r, i) => (
                        <div key={i} style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: "6px", padding: "8px 10px", marginBottom: "6px", fontSize: "11px" }}>
                          <div style={{ fontWeight: "600" }}>{r.flagType} · hash: {r.hash} · stored as: {r.storedClientName} · status: {r.status}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* All generated alerts (collapsed detail) */}
                  <details style={{ fontSize: "11px" }}>
                    <summary style={{ cursor: "pointer", color: "#1a56db", marginBottom: "8px", userSelect: "none" }}>
                      Show all {diagResult.generatedAlerts.length} generated alerts
                    </summary>
                    {diagResult.generatedAlerts.map((a, i) => (
                      <div key={i} style={{ background: a.wouldBeFiltered ? "#f0fdf4" : "#fff5f5", border: `1px solid ${a.wouldBeFiltered ? "#bbf7d0" : "#fecaca"}`, borderRadius: "6px", padding: "8px 10px", marginBottom: "6px" }}>
                        <div style={{ fontWeight: "600", marginBottom: "2px" }}>{a.wouldBeFiltered ? "✓" : "✗"} {a.flagType} · {a.fingerprintHash} · {a.amStatus}</div>
                        <div style={{ color: "#555", marginBottom: "4px" }}>{a.summary}</div>
                        <div style={{ fontFamily: "monospace", color: "#888", wordBreak: "break-all", fontSize: "10px" }}>{a.rawFingerprint}</div>
                      </div>
                    ))}
                  </details>
                </div>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}