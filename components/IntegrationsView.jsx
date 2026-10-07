import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function IntegrationsView({
  allOutgoingsClients = [],
  user
}) {
  const [selectedClientName, setSelectedClientName] = useState("");
  const [clientStatus, setClientStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [brokerTestResult, setBrokerTestResult] = useState(null);
  const [brokerTesting, setBrokerTesting] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [switchingTenant, setSwitchingTenant] = useState(false);
  const [qbActionLoading, setQbActionLoading] = useState(false);
  const [qbBrokerTestResult, setQbBrokerTestResult] = useState(null);
  const [qbBrokerTesting, setQbBrokerTesting] = useState(false);

  const [mondayActionLoading, setMondayActionLoading] = useState(false);
  const [mondayBrokerTestResult, setMondayBrokerTestResult] = useState(null);
  const [mondayBrokerTesting, setMondayBrokerTesting] = useState(false);

  const [pipedriveActionLoading, setPipedriveActionLoading] = useState(false);
  const [pipedriveBrokerTestResult, setPipedriveBrokerTestResult] = useState(null);
  const [pipedriveBrokerTesting, setPipedriveBrokerTesting] = useState(false);

  // Initialize selected client to first client in list if available
  useEffect(() => {
    if (allOutgoingsClients.length > 0 && !selectedClientName) {
      // Prefer APPTEST or first client
      const testClient = allOutgoingsClients.find(c => c.clientName?.toUpperCase().includes("TEST")) || allOutgoingsClients[0];
      setSelectedClientName(testClient.clientName);
    }
  }, [allOutgoingsClients, selectedClientName]);

  // Read URL query parameters on return from OAuth
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const integration = urlParams.get("integration");
      const status = urlParams.get("status");
      const tenant = urlParams.get("tenant");
      const company = urlParams.get("company");
      const account = urlParams.get("account");
      const errorMsg = urlParams.get("message") || urlParams.get("error");
      const clientParam = urlParams.get("client");

      if (clientParam) {
        setSelectedClientName(clientParam);
      }

      if (integration === "xero") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Xero for ${clientParam || "client"}${tenant ? ` (${tenant})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Xero connection failed: ${errorMsg}` : "Xero connection was cancelled or denied."
          });
        }
        // Clean URL params cleanly
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("tenant");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "quickbooks") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected QuickBooks for ${clientParam || "client"}${company ? ` (${company})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `QuickBooks connection failed: ${errorMsg}` : "QuickBooks connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("company");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "monday") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Monday.com for ${clientParam || "client"}${account ? ` (${account})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Monday.com connection failed: ${errorMsg}` : "Monday.com connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("account");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "pipedrive") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Pipedrive for ${clientParam || "client"}${company ? ` (${company})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Pipedrive connection failed: ${errorMsg}` : "Pipedrive connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("company");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      }
    }
  }, []);

  const selectedClient = allOutgoingsClients.find(c => c.clientName === selectedClientName) || null;

  // Fetch integration statuses for the selected client
  const fetchStatus = useCallback(async () => {
    if (!selectedClientName && !selectedClient?.masterSheetId) return;
    setStatusLoading(true);
    setBrokerTestResult(null);
    setQbBrokerTestResult(null);
    setMondayBrokerTestResult(null);
    setPipedriveBrokerTestResult(null);
    try {
      const q = new URLSearchParams();
      if (selectedClientName) q.set("clientKey", selectedClientName);
      if (selectedClient?.masterSheetId) q.set("masterSheetId", selectedClient.masterSheetId);

      const res = await fetch(`/api/integrations/status?${q.toString()}`);
      const data = await res.json();
      if (data.success) {
        setClientStatus(data.integrations || {});
      } else {
        setClientStatus({});
      }
    } catch (err) {
      console.error("Failed to load integrations status:", err);
      setClientStatus({});
    } finally {
      setStatusLoading(false);
    }
  }, [selectedClientName, selectedClient]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Initiate OAuth flow
  const handleConnectXero = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  // Disconnect & revoke
  const handleDisconnectXero = async () => {
    if (!confirm(`Are you sure you want to disconnect Xero for ${selectedClientName}? Tokens will be revoked with Xero and purged from the Vault.`)) {
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch("/api/integrations/xero/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Xero disconnected and revoked for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setActionLoading(false);
    }
  };

  // Test live token broker
  const handleTestTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setBrokerTesting(true);
    setBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=xero&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setBrokerTestResult(data);
    } catch (err) {
      setBrokerTestResult({ success: false, error: err.message });
    } finally {
      setBrokerTesting(false);
    }
  };

  // Initiate QuickBooks OAuth flow
  const handleConnectQB = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/quickbooks/connect?${params.toString()}`;
  };

  // Disconnect & revoke QuickBooks
  const handleDisconnectQB = async () => {
    if (!confirm(`Are you sure you want to disconnect QuickBooks for ${selectedClientName}? Tokens will be revoked with Intuit and purged from the Vault.`)) {
      return;
    }
    setQbActionLoading(true);
    try {
      const res = await fetch("/api/integrations/quickbooks/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `QuickBooks disconnected and revoked for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setQbActionLoading(false);
    }
  };

  // Test live QuickBooks token broker
  const handleTestQBTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setQbBrokerTesting(true);
    setQbBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=quickbooks&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setQbBrokerTestResult(data);
    } catch (err) {
      setQbBrokerTestResult({ success: false, error: err.message });
    } finally {
      setQbBrokerTesting(false);
    }
  };

  // Initiate Monday.com OAuth flow
  const handleConnectMonday = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/monday/connect?${params.toString()}`;
  };

  // Disconnect & revoke Monday.com
  const handleDisconnectMonday = async () => {
    if (!confirm(`Are you sure you want to disconnect Monday.com for ${selectedClientName}? Tokens will be purged from the Vault.`)) {
      return;
    }
    setMondayActionLoading(true);
    try {
      const res = await fetch("/api/integrations/monday/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Monday.com disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setMondayActionLoading(false);
    }
  };

  // Test live Monday.com token broker
  const handleTestMondayTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setMondayBrokerTesting(true);
    setMondayBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=monday&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setMondayBrokerTestResult(data);
    } catch (err) {
      setMondayBrokerTestResult({ success: false, error: err.message });
    } finally {
      setMondayBrokerTesting(false);
    }
  };

  // Initiate Pipedrive OAuth flow
  const handleConnectPipedrive = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/pipedrive/connect?${params.toString()}`;
  };

  // Disconnect & revoke Pipedrive
  const handleDisconnectPipedrive = async () => {
    if (!confirm(`Are you sure you want to disconnect Pipedrive for ${selectedClientName}? Tokens will be revoked with Pipedrive and purged from the Vault.`)) {
      return;
    }
    setPipedriveActionLoading(true);
    try {
      const res = await fetch("/api/integrations/pipedrive/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Pipedrive disconnected and revoked for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setPipedriveActionLoading(false);
    }
  };

  // Test live Pipedrive token broker
  const handleTestPipedriveTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setPipedriveBrokerTesting(true);
    setPipedriveBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=pipedrive&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setPipedriveBrokerTestResult(data);
    } catch (err) {
      setPipedriveBrokerTestResult({ success: false, error: err.message });
    } finally {
      setPipedriveBrokerTesting(false);
    }
  };

  const xero = clientStatus?.xero || {};
  const isXeroConnected = Boolean(xero.connected);
  const qb = clientStatus?.quickbooks || {};
  const isQBConnected = Boolean(qb.connected);
  const monday = clientStatus?.monday || {};
  const isMondayConnected = Boolean(monday.connected);
  const pipedrive = clientStatus?.pipedrive || {};
  const isPipedriveConnected = Boolean(pipedrive.connected);

  // Sync selectedTenantId when clientStatus updates
  useEffect(() => {
    if (xero?.tenantId) {
      setSelectedTenantId(xero.tenantId);
    }
  }, [xero?.tenantId]);

  // Handle switching active Xero tenant/organisation
  const handleSwitchTenant = async () => {
    if (!selectedTenantId || !selectedClient) return;
    const target = (xero.availableTenants || []).find(t => t.tenantId === selectedTenantId);
    const targetName = target ? target.tenantName : selectedTenantId;
    setSwitchingTenant(true);
    try {
      const res = await fetch("/api/integrations/set-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          tool: "xero",
          tenantId: selectedTenantId,
          tenantName: targetName
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: `Active organisation switched to "${targetName}".` });
        fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to switch organisation." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSwitchingTenant(false);
    }
  };

  return (
    <div style={{ padding: "20px 24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Top Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: "700", color: "#0f172a", margin: "0 0 4px 0", display: "flex", alignItems: "center", gap: "8px" }}>
            <span>🔌</span> Third-Party Integrations Hub
          </h1>
          <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
            Central OAuth Vault & Token Broker Management. Test connections and authorise external accounting & CRM platforms.
          </p>
        </div>

        {/* Client Selector Dropdown */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label htmlFor="pma-client-select" style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
            Target Client:
          </label>
          <select
            id="pma-client-select"
            value={selectedClientName}
            onChange={(e) => setSelectedClientName(e.target.value)}
            style={{
              padding: "7px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              fontSize: "13px",
              fontWeight: "600",
              color: "#0f172a",
              background: "#ffffff",
              cursor: "pointer",
              minWidth: "220px",
              outline: "none"
            }}
          >
            {allOutgoingsClients.map((c) => (
              <option key={c.clientName} value={c.clientName}>
                {c.clientName} {c.clientName?.toUpperCase().includes("TEST") ? "🧪" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={fetchStatus}
            title="Refresh status"
            disabled={statusLoading}
            style={{
              padding: "7px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              fontSize: "13px",
              cursor: "pointer",
              color: "#475569"
            }}
          >
            {statusLoading ? "⏳" : "🔄"}
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "10px",
            fontSize: "13px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: feedback.type === "success" ? "#ecfdf5" : feedback.type === "error" ? "#fef2f2" : "#eff6ff",
            color: feedback.type === "success" ? "#065f46" : feedback.type === "error" ? "#991b1b" : "#1e40af",
            border: `1px solid ${feedback.type === "success" ? "#a7f3d0" : feedback.type === "error" ? "#fecaca" : "#bfdbfe"}`
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>{feedback.type === "success" ? "✓" : feedback.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span style={{ fontWeight: "500" }}>{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "700" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Selected Client Workspace Info Card */}
      {selectedClient && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "14px 18px",
            border: "1px solid #e2e8f0",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Client Name
              </span>
              <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
                {selectedClient.clientName}
              </span>
            </div>
            <div style={{ height: "24px", width: "1px", background: "#e2e8f0" }} />
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Master Sheet ID
              </span>
              <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#334155" }}>
                {selectedClient.masterSheetId || "Not mapped"}
              </span>
            </div>
            <div style={{ height: "24px", width: "1px", background: "#e2e8f0" }} />
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Client Sheet ID
              </span>
              <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#334155" }}>
                {selectedClient.clientSheetId || "Not mapped"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Main Integration Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px", marginBottom: "28px" }}>
        {/* 1. XERO CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(0, 180, 216, 0.12)", color: "#00b4d8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  X
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Xero Accounting</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Financials, Invoices, P&L Sync</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isXeroConnected ? "#dcfce7" : "#f1f5f9",
                  color: isXeroConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isXeroConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects this client&apos;s Xero account via OAuth 2.0 with PKCE. Tokens are stored encrypted (AES-256-GCM) in the Redis Vault.
            </p>

            {/* Connection Details if Connected */}
            {isXeroConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Organisation:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{xero.tenantName || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Tenant ID:</span>
                  <span style={{ fontFamily: "monospace", color: "#334155" }}>{xero.tenantId || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: xero.isExpired ? "#b91c1c" : "#15803d" }}>
                    {xero.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {xero.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(xero.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}

                {/* Multi-organisation switcher if user manages multiple Xero orgs */}
                {xero.availableTenants && xero.availableTenants.length > 1 && (
                  <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px dashed #cbd5e1" }}>
                    <label style={{ display: "block", fontSize: "11px", color: "#475569", fontWeight: "700", marginBottom: "5px" }}>
                      Linked Organisation ({xero.availableTenants.length} available):
                    </label>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <select
                        value={selectedTenantId || xero.tenantId}
                        onChange={(e) => setSelectedTenantId(e.target.value)}
                        style={{
                          flex: 1,
                          padding: "6px 8px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          fontSize: "12px",
                          background: "#fff",
                          color: "#0f172a"
                        }}
                      >
                        {xero.availableTenants.map((t) => (
                          <option key={t.tenantId} value={t.tenantId}>
                            {t.tenantName}{t.tenantId === xero.tenantId ? " (Active)" : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handleSwitchTenant}
                        disabled={switchingTenant || selectedTenantId === xero.tenantId}
                        style={{
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "none",
                          background: selectedTenantId === xero.tenantId ? "#94a3b8" : "#2563eb",
                          color: "#fff",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: selectedTenantId === xero.tenantId ? "default" : "pointer"
                        }}
                      >
                        {switchingTenant ? "Saving..." : "Switch"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isXeroConnected ? (
                <>
                  <button
                    onClick={handleDisconnectXero}
                    disabled={actionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {actionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestTokenBroker}
                    disabled={brokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {brokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectXero}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Xero for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {brokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: brokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${brokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: brokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {brokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(brokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 2. QUICKBOOKS ONLINE CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(44, 160, 28, 0.12)", color: "#2ca01c", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  Q
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>QuickBooks Online</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Invoices, Outgoings & Expenses</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isQBConnected ? "#dcfce7" : "#f1f5f9",
                  color: isQBConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isQBConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects this client&apos;s QuickBooks account via OAuth 2.0 with PKCE. Tokens are stored encrypted (AES-256-GCM) in the Redis Vault.
            </p>

            {/* Connection Details if Connected */}
            {isQBConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Company Name:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{qb.companyName || qb.tenantName || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Realm ID:</span>
                  <span style={{ fontFamily: "monospace", color: "#334155" }}>{qb.realmId || qb.tenantId || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: qb.isExpired ? "#b91c1c" : "#15803d" }}>
                    {qb.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {qb.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(qb.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isQBConnected ? (
                <>
                  <button
                    onClick={handleDisconnectQB}
                    disabled={qbActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {qbActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestQBTokenBroker}
                    disabled={qbBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {qbBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectQB}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#2ca01c",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect QuickBooks for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {qbBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: qbBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${qbBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: qbBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {qbBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(qbBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 3. MONDAY.COM CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(97, 97, 255, 0.12)", color: "#6161ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  M
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Monday.com</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Work Management & Boards Sync</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isMondayConnected ? "#dcfce7" : "#f1f5f9",
                  color: isMondayConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isMondayConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Monday.com accounts via OAuth 2.0. Ingests board data and CRM pipelines directly into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isMondayConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Account / Workspace:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{monday.metadata?.accountName || monday.accountName || monday.tenantName || "N/A"}</span>
                </div>
                {monday.metadata?.accountId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Account ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{monday.metadata.accountId}</span>
                  </div>
                )}
                {monday.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{monday.metadata.userName}{monday.metadata.userEmail ? ` (${monday.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: monday.isExpired ? "#b91c1c" : "#15803d" }}>
                    {monday.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {monday.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(monday.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isMondayConnected ? (
                <>
                  <button
                    onClick={handleDisconnectMonday}
                    disabled={mondayActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {mondayActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestMondayTokenBroker}
                    disabled={mondayBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {mondayBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectMonday}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#6161ff",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Monday.com for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {mondayBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: mondayBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${mondayBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: mondayBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {mondayBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(mondayBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 4. PIPEDRIVE CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(0, 194, 97, 0.12)", color: "#00c261", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  P
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Pipedrive CRM</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Deals, Pipelines & Opportunities</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isPipedriveConnected ? "#dcfce7" : "#f1f5f9",
                  color: isPipedriveConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isPipedriveConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Pipedrive CRM via OAuth 2.0. Synchronizes deal values, custom fields, and pipelines into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isPipedriveConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Company:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{pipedrive.metadata?.companyName || pipedrive.companyName || pipedrive.tenantName || "N/A"}</span>
                </div>
                {pipedrive.metadata?.companyId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Company ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{pipedrive.metadata.companyId}</span>
                  </div>
                )}
                {pipedrive.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{pipedrive.metadata.userName}{pipedrive.metadata.userEmail ? ` (${pipedrive.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: pipedrive.isExpired ? "#b91c1c" : "#15803d" }}>
                    {pipedrive.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {pipedrive.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(pipedrive.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isPipedriveConnected ? (
                <>
                  <button
                    onClick={handleDisconnectPipedrive}
                    disabled={pipedriveActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {pipedriveActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestPipedriveTokenBroker}
                    disabled={pipedriveBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {pipedriveBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectPipedrive}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#00c261",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Pipedrive for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {pipedriveBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: pipedriveBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${pipedriveBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: pipedriveBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {pipedriveBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(pipedriveBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 5. CLICKUP CARD (Placeholder) */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            opacity: 0.75,
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(123, 104, 238, 0.12)", color: "#7b68ee", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  C
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>ClickUp</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>CRM & Pipeline Sync</span>
                </div>
              </div>
              <span style={{ fontSize: "11px", fontWeight: "700", padding: "3px 10px", borderRadius: "20px", background: "#f1f5f9", color: "#64748b" }}>
                Phase 2
              </span>
            </div>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: 0 }}>
              Connect ClickUp workspaces to pull sales pipeline and job opportunities directly into the Master Sheet.
            </p>
          </div>
        </div>
      </div>

      {/* Migration / Info Note */}
      <div style={{ background: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "16px 20px" }}>
        <h4 style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
          💡 Migration & Security Architecture
        </h4>
        <p style={{ margin: 0, fontSize: "12.5px", color: "#475569", lineHeight: "1.6" }}>
          This hub completely replaces legacy Google Apps Script Web App links and library tokens. When a client authorizes via this page, tokens are encrypted with AES-256-GCM and stored in Redis. The Master Google Sheet queries <code style={{ background: "#e2e8f0", padding: "2px 5px", borderRadius: "4px" }}>/api/integrations/token</code> during automated runs, ensuring that permanent credentials never leave Pulse.
        </p>
      </div>
    </div>
  );
}
