import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function SetupView({ allOutgoingsClients = [], user }) {
  const [selectedClientName, setSelectedClientName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [config, setConfig] = useState(null);

  // Form State
  const [setupMode, setSetupMode] = useState(false);
  const [requestConnections, setRequestConnections] = useState(false);
  const [accountingTool, setAccountingTool] = useState("None");
  const [crmTool, setCrmTool] = useState("None");
  const [crmDrives, setCrmDrives] = useState("NA");

  // Read URL query parameter on mount or pick first client
  useEffect(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const urlClient = p.get("client");
      if (urlClient && allOutgoingsClients.some(c => c.clientName.toLowerCase() === urlClient.toLowerCase())) {
        const found = allOutgoingsClients.find(c => c.clientName.toLowerCase() === urlClient.toLowerCase());
        setSelectedClientName(found.clientName);
        return;
      }
    }

    if (allOutgoingsClients.length > 0 && !selectedClientName) {
      const preferred = allOutgoingsClients.find(c => c.clientName.toUpperCase().includes("APPTEST")) || allOutgoingsClients[0];
      setSelectedClientName(preferred.clientName);
    }
  }, [allOutgoingsClients, selectedClientName]);

  const selectedClient = allOutgoingsClients.find(c => c.clientName === selectedClientName) || null;

  // Load config when selected client changes
  const loadConfig = useCallback(async (client) => {
    if (!client) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/setup/config?clientName=${encodeURIComponent(client.clientName)}&masterSheetId=${encodeURIComponent(client.masterSheetId || "")}`
      );
      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
        setSetupMode(Boolean(data.config.setupMode));
        setRequestConnections(Boolean(data.config.requestConnections));
        setAccountingTool(data.config.accountingTool || "None");
        setCrmTool(data.config.crmTool || "None");
        setCrmDrives(data.config.crmDrives || "NA");
      } else {
        throw new Error(data.error || "Failed to load setup configuration");
      }
    } catch (err) {
      console.error("loadConfig error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedClient) {
      loadConfig(selectedClient);
    }
  }, [selectedClient, loadConfig]);

  // Handle Save
  const handleSave = async (e) => {
    e?.preventDefault();
    if (!selectedClient) return;
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId || "",
          setupMode,
          requestConnections,
          accountingTool,
          crmTool,
          crmDrives
        })
      });

      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
        setFeedback({
          type: "success",
          message: "Setup configuration saved and synced to Master Sheet KeyInfo successfully."
        });
      } else {
        throw new Error(data.error || "Failed to save configuration");
      }
    } catch (err) {
      console.error("handleSave error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const isAccountingOAuth = ["xero", "quickbooks"].includes(accountingTool.toLowerCase());
  const isCrmOAuth = ["clickup", "close", "capsule", "hubspot", "monday", "pipedrive"].includes(crmTool.toLowerCase());

  return (
    <div style={{ maxWidth: "1080px", margin: "0 auto", padding: "24px 16px" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ margin: "0 0 6px 0", fontSize: "24px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "10px" }}>
            <span>Setup & client connections</span>
          </h1>
          <p style={{ margin: 0, color: "#64748B", fontSize: "14px" }}>
            Control client setup mode, configure tool integrations, and request third-party connections from client users.
          </p>
        </div>

        {/* Client Chooser */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label htmlFor="client-selector" style={{ fontSize: "13px", fontWeight: "600", color: "#475569" }}>Client:</label>
          <select
            id="client-selector"
            value={selectedClientName}
            onChange={(e) => setSelectedClientName(e.target.value)}
            style={{
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #CBD5E1",
              background: "#FFFFFF",
              fontSize: "14px",
              fontWeight: "600",
              color: "#1E293B",
              minWidth: "220px",
              cursor: "pointer"
            }}
          >
            {allOutgoingsClients.map((c) => (
              <option key={c.clientName} value={c.clientName}>
                {c.clientName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            marginBottom: "20px",
            fontSize: "14px",
            fontWeight: "500",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: feedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
            border: `1px solid ${feedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
            color: feedback.type === "success" ? "#065F46" : "#991B1B"
          }}
        >
          <span>{feedback.type === "success" ? "✓" : "⚠️"}</span>
          <span>{feedback.message}</span>
        </div>
      )}

      {loading ? (
        <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "60px 20px", textAlign: "center" }}>
          <Spinner size={28} color="#023f98" />
          <p style={{ marginTop: "12px", color: "#64748B", fontSize: "14px", fontWeight: "500" }}>Loading client setup details...</p>
        </div>
      ) : (
        <form onSubmit={handleSave}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "20px" }}>

            {/* 1. SETUP MODE STATUS CARD */}
            <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <h2 style={{ margin: "0 0 4px 0", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                    1. Setup Mode Lifecycle
                  </h2>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    When active, client users logging into Pulse are presented with a setup screen instead of live financial dashboards.
                  </p>
                </div>
                <div style={{
                  padding: "6px 14px",
                  borderRadius: "20px",
                  fontSize: "12px",
                  fontWeight: "700",
                  letterSpacing: "0.5px",
                  background: setupMode ? "#FEF3C7" : "#DCFCE7",
                  color: setupMode ? "#B45309" : "#15803D",
                  border: `1px solid ${setupMode ? "#FCD34D" : "#86EFAC"}`
                }}>
                  {setupMode ? "SETUP MODE ACTIVE" : "● LIVE DASHBOARDS ACTIVE"}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
                {/* Setup Mode Toggle */}
                <div style={{
                  padding: "16px",
                  borderRadius: "10px",
                  border: `1px solid ${setupMode ? "#FDE68A" : "#E2E8F0"}`,
                  background: setupMode ? "#FFFBEB" : "#F8FAFC"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <label htmlFor="setup-mode-toggle" style={{ fontWeight: "700", fontSize: "14px", color: "#1E293B", cursor: "pointer" }}>
                      Enable Setup Mode
                    </label>
                    <input
                      id="setup-mode-toggle"
                      type="checkbox"
                      checked={setupMode}
                      onChange={(e) => setSetupMode(e.target.checked)}
                      style={{ width: "18px", height: "18px", cursor: "pointer" }}
                    />
                  </div>
                  <p style={{ margin: 0, fontSize: "12px", color: "#64748B", lineHeight: "1.4" }}>
                    Check to hold client users on the setup screen while you configure the client. Uncheck once setup is complete to open live access.
                  </p>
                </div>

                {/* Request Connections Toggle */}
                <div style={{
                  padding: "16px",
                  borderRadius: "10px",
                  border: `1px solid ${requestConnections ? "#BFDBFE" : "#E2E8F0"}`,
                  background: requestConnections ? "#EFF6FF" : "#F8FAFC"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <label htmlFor="request-conn-toggle" style={{ fontWeight: "700", fontSize: "14px", color: "#1E293B", cursor: "pointer" }}>
                      Request Tool Connections
                    </label>
                    <input
                      id="request-conn-toggle"
                      type="checkbox"
                      checked={requestConnections}
                      onChange={(e) => setRequestConnections(e.target.checked)}
                      style={{ width: "18px", height: "18px", cursor: "pointer" }}
                    />
                  </div>
                  <p style={{ margin: 0, fontSize: "12px", color: "#64748B", lineHeight: "1.4" }}>
                    When checked, client users in Setup Mode will see action buttons prompting them to connect their accounting and CRM tools.
                  </p>
                </div>
              </div>
            </div>

            {/* 2. TOOL SELECTION CARD */}
            <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <div style={{ marginBottom: "16px" }}>
                <h2 style={{ margin: "0 0 4px 0", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                  2. Integrated Tools (Master Sheet KeyInfo Sync)
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                  Select which platforms this client uses.
                </p>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px" }}>

                {/* Accounting Tool */}
                <div style={{ padding: "16px", borderRadius: "10px", border: "1px solid #E2E8F0", background: "#F8FAFC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <label htmlFor="accounting-tool" style={{ fontWeight: "700", fontSize: "13px", color: "#1E293B" }}>
                      Accounting tool
                    </label>
                    {isAccountingOAuth && (
                      <span style={{
                        fontSize: "11px",
                        fontWeight: "700",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: config?.accountingStatus?.connected ? "#DCFCE7" : "#FEF3C7",
                        color: config?.accountingStatus?.connected ? "#15803D" : "#B45309"
                      }}>
                        {config?.accountingStatus?.connected ? "● Connected" : "○ Needs Connection"}
                      </span>
                    )}
                  </div>
                  <select
                    id="accounting-tool"
                    value={accountingTool}
                    onChange={(e) => setAccountingTool(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #CBD5E1", fontSize: "14px", background: "#FFFFFF", color: "#1E293B" }}
                  >
                    <option value="None">None</option>
                    <option value="Xero">Xero</option>
                    <option value="Quickbooks">QuickBooks Online</option>
                  </select>
                  <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "#64748B" }}>
                    {isAccountingOAuth ? "Requires OAuth handshake via Central Pulse Vault." : "No API connection required."}
                  </p>
                </div>

                {/* CRM Tool */}
                <div style={{ padding: "16px", borderRadius: "10px", border: "1px solid #E2E8F0", background: "#F8FAFC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <label htmlFor="crm-tool" style={{ fontWeight: "700", fontSize: "13px", color: "#1E293B" }}>
                      CRM tool
                    </label>
                    {isCrmOAuth ? (
                      <span style={{
                        fontSize: "11px",
                        fontWeight: "700",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: config?.crmStatus?.connected ? "#DCFCE7" : "#FEF3C7",
                        color: config?.crmStatus?.connected ? "#15803D" : "#B45309"
                      }}>
                        {config?.crmStatus?.connected ? "● Connected" : "○ Needs Connection"}
                      </span>
                    ) : (
                      <span style={{ fontSize: "11px", color: "#64748B" }}>
                        {crmTool === "None" ? "Disabled" : "Spreadsheet source"}
                      </span>
                    )}
                  </div>
                  <select
                    id="crm-tool"
                    value={crmTool}
                    onChange={(e) => setCrmTool(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #CBD5E1", fontSize: "14px", background: "#FFFFFF", color: "#1E293B" }}
                  >
                    <option value="None">None</option>
                    <option value="ClickUp">ClickUp</option>
                    <option value="Close">Close CRM</option>
                    <option value="Capsule">Capsule CRM</option>
                    <option value="HubSpot">HubSpot</option>
                    <option value="Monday">Monday.com</option>
                    <option value="Pipedrive">Pipedrive</option>
                    <option value="Google Sheet">Google Sheet (No API required)</option>
                    <option value="Excel">Excel (No API required)</option>
                  </select>
                  <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "#64748B" }}>
                    {isCrmOAuth ? "Requires OAuth handshake via Central Pulse Vault." : "Manual or sheet-based sync."}
                  </p>
                </div>

                {/* CRM Driver */}
                <div style={{ padding: "16px", borderRadius: "10px", border: "1px solid #E2E8F0", background: "#F8FAFC" }}>
                  <label htmlFor="crm-drives" style={{ display: "block", fontWeight: "700", fontSize: "13px", color: "#1E293B", marginBottom: "8px" }}>
                    CRM integration type
                  </label>
                  <select
                    id="crm-drives"
                    value={crmDrives}
                    onChange={(e) => setCrmDrives(e.target.value)}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #CBD5E1", fontSize: "14px", background: "#FFFFFF", color: "#1E293B" }}
                  >
                    <option value="NA">NA</option>
                    <option value="Pipeline">Pipeline (Just pipeline)</option>
                    <option value="PipeAndConf">PipeAndConf (Pipeline and confirmed)</option>
                  </select>
                  <p style={{ margin: "8px 0 0 0", fontSize: "11px", color: "#64748B" }}>
                    Controls whether CRM deals populate pipeline tabs only or sync into confirmed income.
                  </p>
                </div>

              </div>
            </div>

            {/* 3. CONNECTION READINESS SUMMARY */}
            <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <h2 style={{ margin: "0 0 10px 0", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                3. Connection Status Summary
              </h2>
              <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "14px 18px", border: "1px solid #E2E8F0" }}>
                {config?.requiredOAuthTools && config.requiredOAuthTools.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {config.requiredOAuthTools.map((t) => (
                      <div key={t.tool} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
                          {t.type === "accounting" ? "📘 Accounting:" : "👥 CRM:"} {t.name}
                        </span>
                        <span style={{
                          fontSize: "12px",
                          fontWeight: "700",
                          color: t.connected ? "#15803D" : "#B45309",
                          background: t.connected ? "#DCFCE7" : "#FEF3C7",
                          padding: "2px 10px",
                          borderRadius: "12px"
                        }}>
                          {t.connected ? "✓ Connected & Active" : "○ Waiting for Connection"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    No third-party API connections required based on current tool selections.
                  </p>
                )}
              </div>
            </div>

            {/* Bottom Actions */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", paddingTop: "8px" }}>
              <div style={{ display: "flex", gap: "10px" }}>
                <a
                  href={`/pulse?client=${encodeURIComponent(selectedClientName)}&preview=setup`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    background: "#F1F5F9",
                    color: "#334155",
                    fontSize: "13px",
                    fontWeight: "600",
                    textDecoration: "none",
                    border: "1px solid #CBD5E1"
                  }}
                >
                  <span>👁</span>
                  <span>Preview client setup screen</span>
                </a>
              </div>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => loadConfig(selectedClient)}
                  disabled={saving}
                  style={{
                    padding: "10px 18px",
                    borderRadius: "8px",
                    background: "#FFFFFF",
                    color: "#475569",
                    fontSize: "14px",
                    fontWeight: "600",
                    border: "1px solid #CBD5E1",
                    cursor: "pointer"
                  }}
                >
                  Discard Changes
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    padding: "10px 24px",
                    borderRadius: "8px",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontSize: "14px",
                    fontWeight: "600",
                    border: "none",
                    cursor: "pointer",
                    boxShadow: "0 2px 4px rgba(2, 63, 152, 0.25)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px"
                  }}
                >
                  {saving && <Spinner size={16} color="#FFFFFF" />}
                  <span>{saving ? "Saving..." : "Save Setup Configuration"}</span>
                </button>
              </div>
            </div>

          </div>
        </form>
      )}
    </div>
  );
}
