import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import Skeleton, { PmaSetupOverviewSkeleton, PmaSetupDetailSkeleton } from "./Skeleton";
import EditableSheetEditor from "./EditableSheetEditor";
import OnboardClientModal from "./OnboardClientModal";
import OnboardingChecklistView from "./OnboardingChecklistView";
import EditSetupProcessView from "./EditSetupProcessView";

export default function SetupView({
  allOutgoingsClients = [],
  initialClientName = "",
  onSelectClient,
  onGoToBudget,
  user,
  isAdmin,
  managedClient,
  onClearManagedClient
}) {
  const isUserAdmin = Boolean(
    !user?.isReadOnly && (isAdmin || user?.isAdmin || user?.role === "Admin")
  );

  const [activeSheetEditor, setActiveSheetEditor] = useState(null); // 'budget' | 'contractors' | 'outgoings' | null
  const [isOnboardModalOpen, setIsOnboardModalOpen] = useState(false);
  const [showChecklistHistory, setShowChecklistHistory] = useState(false);

  const [isEditingProcess, setIsEditingProcess] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return p.get("action") === "edit-process" || p.get("mode") === "edit-process";
    }
    return false;
  });

  const handleOpenEditProcess = () => {
    setIsEditingProcess(true);
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.set("nav", "setup");
      p.set("action", "edit-process");
      window.history.replaceState(null, "", `/pma?${p.toString()}`);
    }
  };

  const handleCloseEditProcess = () => {
    setIsEditingProcess(false);
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.delete("action");
      p.delete("mode");
      p.set("nav", "setup");
      window.history.replaceState(null, "", `/pma?${p.toString()}`);
    }
    if (!selectedClientName && !managedClient) {
      loadOverview();
    } else if (selectedClient) {
      loadConfig(selectedClient);
    }
  };

  // Determine initial selected client
  const [selectedClientName, setSelectedClientName] = useState(() => {
    if (managedClient?.clientName) return managedClient.clientName;
    if (initialClientName) return initialClientName;
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const urlClient = p.get("client");
      if (urlClient) return urlClient;
    }
    return "";
  });

  useEffect(() => {
    if (managedClient?.clientName) {
      setSelectedClientName(managedClient.clientName);
    } else {
      setSelectedClientName(initialClientName || "");
    }
  }, [managedClient, initialClientName]);

  // Overview screen state
  const [overviewClients, setOverviewClients] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewSearch, setOverviewSearch] = useState("");
  const [overviewFilter, setOverviewFilter] = useState("all"); // 'all' | 'setup' | 'live'

  // Single client form state
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingLifecycle, setSavingLifecycle] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [config, setConfig] = useState(null);

  const [setupMode, setSetupMode] = useState(false);
  const [requestConnections, setRequestConnections] = useState(false);
  const [accountingTool, setAccountingTool] = useState("None");
  const [crmTool, setCrmTool] = useState("None");
  const [crmDrives, setCrmDrives] = useState("NA");

  // Load Overview data when on the main list
  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const res = await fetch("/api/setup/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allOutgoingsClients })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.clients)) {
        setOverviewClients(data.clients);
      }
    } catch (err) {
      console.error("Error loading setup overview:", err);
    } finally {
      setOverviewLoading(false);
    }
  }, [allOutgoingsClients]);

  useEffect(() => {
    if (!selectedClientName && !managedClient) {
      loadOverview();
    }
  }, [selectedClientName, managedClient, loadOverview]);

  const selectedClient = useMemo(() => {
    return (
      allOutgoingsClients.find(
        (c) => c.clientName.toLowerCase() === (selectedClientName || "").toLowerCase()
      ) || (selectedClientName ? { clientName: selectedClientName, masterSheetId: config?.masterSheetId || "" } : null)
    );
  }, [allOutgoingsClients, selectedClientName, config?.masterSheetId]);

  // Load client setup config
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

  // Navigate to single client setup
  const handleSelectClient = (name) => {
    setSelectedClientName(name);
    if (onSelectClient) onSelectClient(name);
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      if (name) {
        p.set("client", name);
      } else {
        p.delete("client");
      }
      p.set("nav", "setup");
      window.history.replaceState(null, "", `/pma?${p.toString()}`);
    }
  };

  // Return to all clients overview
  const handleBackToOverview = () => {
    handleSelectClient("");
    loadOverview();
  };

  // Dedicated handlers to toggle and immediately persist setup mode lifecycle
  const handleToggleSetupMode = async (newVal) => {
    if (!selectedClient) return;
    const prevVal = setupMode;
    setSetupMode(newVal);
    setSavingLifecycle(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId || config?.masterSheetId || "",
          setupMode: newVal,
          requestConnections,
          accountingTool: config?.accountingTool || accountingTool,
          crmTool: config?.crmTool || crmTool,
          crmDrives: config?.crmDrives || crmDrives
        })
      });

      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
        setSetupMode(Boolean(data.config.setupMode));
        setRequestConnections(Boolean(data.config.requestConnections));
        setFeedback({
          type: "success",
          message: newVal
            ? "Setup mode enabled and saved. Client users will see the setup onboarding holding screen."
            : "Setup mode deactivated and saved. Live dashboards are now active."
        });
      } else {
        throw new Error(data.error || "Failed to update setup mode.");
      }
    } catch (err) {
      console.error("handleToggleSetupMode error:", err);
      setSetupMode(prevVal);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSavingLifecycle(false);
    }
  };

  const handleToggleRequestConnections = async (newVal) => {
    if (!selectedClient) return;
    const prevVal = requestConnections;
    setRequestConnections(newVal);
    setSavingLifecycle(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId || config?.masterSheetId || "",
          setupMode,
          requestConnections: newVal,
          accountingTool: config?.accountingTool || accountingTool,
          crmTool: config?.crmTool || crmTool,
          crmDrives: config?.crmDrives || crmDrives
        })
      });

      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
        setRequestConnections(Boolean(data.config.requestConnections));
        setFeedback({
          type: "success",
          message: newVal
            ? "Request tool connections enabled and saved. Client users in setup mode will be prompted to connect platforms."
            : "Request tool connections disabled and saved. Client users will see standard holding message."
        });
      } else {
        throw new Error(data.error || "Failed to update request connections setting.");
      }
    } catch (err) {
      console.error("handleToggleRequestConnections error:", err);
      setRequestConnections(prevVal);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSavingLifecycle(false);
    }
  };

  // Handle Save for live client settings
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
          masterSheetId: selectedClient.masterSheetId || config?.masterSheetId || "",
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
          message: isUserAdmin ? "Setup configuration saved and synced to Master Sheet KeyInfo successfully." : "Setup configuration saved successfully."
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

  // Called when a new client is provisioned in the modal
  const handleClientProvisioned = (newClientData) => {
    setIsOnboardModalOpen(false);
    handleSelectClient(newClientData.clientName);
  };

  const isAccountingOAuth = ["xero", "quickbooks"].includes(accountingTool.toLowerCase());
  const isCrmOAuth = ["clickup", "close", "capsule", "hubspot", "monday", "pipedrive"].includes(crmTool.toLowerCase());

  // ============================================================================
  // VIEW 0: EDIT SETUP PROCESS SCREEN (ADMIN ONLY)
  // ============================================================================
  if (isEditingProcess) {
    return (
      <EditSetupProcessView
        onBack={handleCloseEditProcess}
        user={user}
        isAdmin={isUserAdmin}
      />
    );
  }

  // ============================================================================
  // VIEW 1: OVERVIEW SCREEN (NO CLIENT SELECTED & NOT MANAGED CLIENT)
  // ============================================================================
  if (!selectedClientName && !managedClient) {
    const totalClientsCount = overviewClients.length;
    const setupClientsCount = overviewClients.filter((c) => c.setupMode).length;
    const liveClientsCount = totalClientsCount - setupClientsCount;

    const filteredClients = overviewClients.filter((c) => {
      const matchesSearch = c.clientName.toLowerCase().includes(overviewSearch.toLowerCase().trim());
      if (!matchesSearch) return false;
      if (overviewFilter === "setup") return c.setupMode;
      if (overviewFilter === "live") return !c.setupMode;
      return true;
    });

    return (
      <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
        {/* Top Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "20px",
            flexWrap: "wrap",
            gap: "12px",
            background: "#ffffff",
            padding: "16px 20px",
            borderRadius: "10px",
            border: "1px solid #e2e8f0",
            boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
          }}
        >
          <div>
            <h1 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "10px" }}>
              <span>Setup</span>
            </h1>
            <p style={{ margin: 0, color: "#64748B", fontSize: "13px" }}>
              Manage client setup and onboarding
            </p>
          </div>

          {isUserAdmin && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                type="button"
                onClick={handleOpenEditProcess}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#0F172A",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
                  transition: "all 0.15s ease"
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span>Edit setup process</span>
              </button>
              <button
                type="button"
                onClick={() => setIsOnboardModalOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                  boxShadow: "0 2px 4px rgba(2, 63, 152, 0.2)"
                }}
              >
                <span>➕</span>
                <span>Onboard new client</span>
              </button>
            </div>
          )}
        </div>

        {/* Stats Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px", marginBottom: "24px" }}>
          <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "16px 20px" }}>
            <span style={{ fontSize: "12px", fontWeight: "600", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Total clients
            </span>
            <div style={{ fontSize: "24px", fontWeight: "800", color: "#0F172A", marginTop: "4px" }}>
              {totalClientsCount}
            </div>
          </div>
          <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #FDE68A", padding: "16px 20px", background: "#FFFBEB" }}>
            <span style={{ fontSize: "12px", fontWeight: "600", color: "#B45309", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              In setup mode / onboarding
            </span>
            <div style={{ fontSize: "24px", fontWeight: "800", color: "#B45309", marginTop: "4px" }}>
              {setupClientsCount}
            </div>
          </div>
          <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #BBF7D0", padding: "16px 20px", background: "#F0FDF4" }}>
            <span style={{ fontSize: "12px", fontWeight: "600", color: "#166534", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Live dashboards active
            </span>
            <div style={{ fontSize: "24px", fontWeight: "800", color: "#166534", marginTop: "4px" }}>
              {liveClientsCount}
            </div>
          </div>
        </div>

        {/* Search & Filters */}
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: "12px 12px 0 0",
            border: "1px solid #E2E8F0",
            borderBottom: "none",
            padding: "16px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px"
          }}
        >
          {/* Filter Pills */}
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              onClick={() => setOverviewFilter("all")}
              style={{
                padding: "6px 14px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
                border: overviewFilter === "all" ? "1px solid #023f98" : "1px solid #E2E8F0",
                background: overviewFilter === "all" ? "#023f98" : "#FFFFFF",
                color: overviewFilter === "all" ? "#FFFFFF" : "#475569"
              }}
            >
              All clients ({totalClientsCount})
            </button>
            <button
              type="button"
              onClick={() => setOverviewFilter("setup")}
              style={{
                padding: "6px 14px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
                border: overviewFilter === "setup" ? "1px solid #B45309" : "1px solid #E2E8F0",
                background: overviewFilter === "setup" ? "#FEF3C7" : "#FFFFFF",
                color: overviewFilter === "setup" ? "#B45309" : "#475569"
              }}
            >
              In setup mode ({setupClientsCount})
            </button>
            <button
              type="button"
              onClick={() => setOverviewFilter("live")}
              style={{
                padding: "6px 14px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: "600",
                cursor: "pointer",
                border: overviewFilter === "live" ? "1px solid #166534" : "1px solid #E2E8F0",
                background: overviewFilter === "live" ? "#DCFCE7" : "#FFFFFF",
                color: overviewFilter === "live" ? "#166534" : "#475569"
              }}
            >
              Live ({liveClientsCount})
            </button>
          </div>

          {/* Search Box */}
          <div style={{ minWidth: "260px" }}>
            <input
              type="text"
              placeholder="Search clients..."
              value={overviewSearch}
              onChange={(e) => setOverviewSearch(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #CBD5E1",
                fontSize: "13px",
                boxSizing: "border-box"
              }}
            />
          </div>
        </div>

        {/* Clients Table */}
        <div style={{ background: "#FFFFFF", borderRadius: "0 0 12px 12px", border: "1px solid #E2E8F0", overflowX: "auto" }}>
          {overviewLoading && overviewClients.length === 0 ? (
            <PmaSetupOverviewSkeleton />
          ) : filteredClients.length === 0 ? (
            <div style={{ textAlign: "center", padding: "50px 20px", color: "#64748B", fontSize: "14px" }}>
              No clients found matching the search criteria.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                  <th style={{ padding: "12px 20px", fontWeight: "700", color: "#475569" }}>Client</th>
                  <th style={{ padding: "12px 16px", fontWeight: "700", color: "#475569" }}>Status</th>
                  <th style={{ padding: "12px 16px", fontWeight: "700", color: "#475569" }}>Accounting</th>
                  <th style={{ padding: "12px 16px", fontWeight: "700", color: "#475569" }}>CRM</th>
                  <th style={{ padding: "12px 16px", fontWeight: "700", color: "#475569" }}>Onboarding progress</th>
                  <th style={{ padding: "12px 20px", fontWeight: "700", color: "#475569", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredClients.map((client) => {
                  return (
                    <tr
                      key={client.clientName}
                      style={{ borderBottom: "1px solid #F1F5F9", cursor: "pointer" }}
                      onClick={() => handleSelectClient(client.clientName)}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#F8FAFC"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={{ padding: "14px 20px", fontWeight: "700", color: "#0F172A" }}>
                        {client.clientName}
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "700",
                            padding: "3px 8px",
                            borderRadius: "12px",
                            background: client.setupMode ? "#FEF3C7" : "#DCFCE7",
                            color: client.setupMode ? "#B45309" : "#15803D"
                          }}
                        >
                          {client.setupMode ? "● SETUP MODE" : "✓ LIVE"}
                        </span>
                      </td>
                      <td style={{ padding: "14px 16px", color: "#475569" }}>
                        {client.accountingTool || "None"}
                      </td>
                      <td style={{ padding: "14px 16px", color: "#475569" }}>
                        {client.crmTool || "None"}
                      </td>
                      <td style={{ padding: "14px 16px", minWidth: "160px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "#E2E8F0", overflow: "hidden" }}>
                            <div
                              style={{
                                width: `${client.progressPercent || (client.setupMode ? 15 : 100)}%`,
                                height: "100%",
                                background: client.setupMode ? "#023f98" : "#10B981"
                              }}
                            />
                          </div>
                          <span style={{ fontSize: "12px", fontWeight: "700", color: "#334155" }}>
                            {client.progressPercent || (client.setupMode ? 15 : 100)}%
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "14px 20px", textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectClient(client.clientName);
                          }}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "6px",
                            border: "1px solid #CBD5E1",
                            background: "#FFFFFF",
                            color: "#023f98",
                            fontWeight: "700",
                            fontSize: "12px",
                            cursor: "pointer"
                          }}
                        >
                          Manage setup →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Provision Modal */}
        {isUserAdmin && (
          <OnboardClientModal
            isOpen={isOnboardModalOpen}
            onClose={() => setIsOnboardModalOpen(false)}
            onClientCreated={handleClientProvisioned}
          />
        )}
      </div>
    );
  }

  // ============================================================================
  // VIEW 2: SINGLE CLIENT SETUP VIEW
  // ============================================================================
  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
      {/* Top Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
          flexWrap: "wrap",
          gap: "12px",
          background: "#ffffff",
          padding: "16px 20px",
          borderRadius: "10px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
        }}
      >
        <div>
          {!managedClient && (allOutgoingsClients || []).length > 1 && (
            <button
              type="button"
              onClick={handleBackToOverview}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "transparent",
                border: "none",
                color: "#0047AB",
                fontWeight: "700",
                fontSize: "13px",
                cursor: "pointer",
                padding: 0,
                marginBottom: "6px"
              }}
            >
              <span>← All clients overview</span>
            </button>
          )}

          <h1 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "10px" }}>
            <span>{selectedClient ? selectedClient.clientName : selectedClientName}</span>
            <span
              style={{
                fontSize: "12px",
                fontWeight: "700",
                padding: "3px 10px",
                borderRadius: "12px",
                background: setupMode ? "#FEF3C7" : "#DCFCE7",
                color: setupMode ? "#B45309" : "#15803D"
              }}
            >
              {setupMode ? "● SETUP MODE" : "✓ LIVE"}
            </span>
          </h1>
          <p style={{ margin: 0, color: "#64748B", fontSize: "13px" }}>
            {setupMode
              ? "Follow the phased checklist below to onboard this client and connect tools."
              : (isUserAdmin ? "Control client setup mode, configure tool integrations, and edit budget/outgoings spreadsheets." : "Control client setup mode, configure tool integrations, and edit client budgets.")}
          </p>
        </div>

        {/* Client Chooser & Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {!managedClient && (allOutgoingsClients || []).length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label htmlFor="client-selector" style={{ fontSize: "13px", fontWeight: "600", color: "#475569" }}>Client:</label>
              <select
                id="client-selector"
                value={selectedClient ? selectedClient.clientName : selectedClientName}
                onChange={(e) => handleSelectClient(e.target.value)}
                style={{
                  padding: "8px 14px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  fontSize: "14px",
                  fontWeight: "600",
                  color: "#1E293B",
                  minWidth: "200px",
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
          )}

          {isUserAdmin && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                type="button"
                onClick={handleOpenEditProcess}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#0F172A",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                  transition: "all 0.15s ease"
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span>Edit setup process</span>
              </button>
              <button
                type="button"
                onClick={() => setIsOnboardModalOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                <span>➕</span>
                <span>New client</span>
              </button>
            </div>
          )}
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
        <PmaSetupDetailSkeleton />
      ) : (
        <>
          {/* ── PERMANENT SETUP MODE LIFECYCLE CARD ──────────────────────────── */}
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              border: "1px solid #E2E8F0",
              padding: "20px",
              marginBottom: "20px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
                flexWrap: "wrap",
                gap: "12px"
              }}
            >
              <div>
                <h2
                  style={{
                    margin: "0 0 4px 0",
                    fontSize: "16px",
                    fontWeight: "700",
                    color: "#0F172A"
                  }}
                >
                  Setup mode lifecycle
                </h2>
                <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                  When active, client users logging into Pulse are held on the onboarding holding screen instead of live dashboards.
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {savingLifecycle && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "12px",
                      color: "#023f98",
                      fontWeight: "600"
                    }}
                  >
                    <Spinner size={14} color="#023f98" />
                    <span>Saving...</span>
                  </span>
                )}
                <div
                  style={{
                    padding: "6px 14px",
                    borderRadius: "20px",
                    fontSize: "12px",
                    fontWeight: "700",
                    letterSpacing: "0.3px",
                    background: setupMode ? "#FEF3C7" : "#DCFCE7",
                    color: setupMode ? "#B45309" : "#15803D",
                    border: `1px solid ${setupMode ? "#FCD34D" : "#86EFAC"}`
                  }}
                >
                  {setupMode ? "Setup mode active" : "● Live dashboards active"}
                </div>
                <a
                  href={`/pulse?client=${encodeURIComponent(selectedClient?.clientName || selectedClientName)}&preview=setup`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "6px 12px",
                    borderRadius: "8px",
                    background: "#F1F5F9",
                    color: "#334155",
                    fontSize: "12px",
                    fontWeight: "600",
                    textDecoration: "none",
                    border: "1px solid #CBD5E1",
                    transition: "background 0.15s ease"
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>Preview client setup screen</span>
                </a>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: "16px"
              }}
            >
              {/* Setup Mode Toggle */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "10px",
                  border: `1px solid ${setupMode ? "#FDE68A" : "#E2E8F0"}`,
                  background: setupMode ? "#FFFBEB" : "#F8FAFC"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "6px"
                  }}
                >
                  <label
                    htmlFor="setup-mode-toggle"
                    style={{
                      fontWeight: "700",
                      fontSize: "14px",
                      color: "#1E293B",
                      cursor: savingLifecycle ? "not-allowed" : "pointer"
                    }}
                  >
                    Enable setup mode
                  </label>
                  <input
                    id="setup-mode-toggle"
                    type="checkbox"
                    checked={setupMode}
                    disabled={savingLifecycle}
                    onChange={(e) => handleToggleSetupMode(e.target.checked)}
                    style={{ width: "18px", height: "18px", cursor: savingLifecycle ? "not-allowed" : "pointer" }}
                  />
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748B", lineHeight: "1.4" }}>
                  Check to hold client users on the setup screen. Uncheck to activate live dashboards.
                </p>
              </div>

              {/* Request Connections Toggle */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "10px",
                  border: `1px solid ${requestConnections ? "#BFDBFE" : "#E2E8F0"}`,
                  background: requestConnections ? "#EFF6FF" : "#F8FAFC"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "6px"
                  }}
                >
                  <label
                    htmlFor="request-conn-toggle"
                    style={{
                      fontWeight: "700",
                      fontSize: "14px",
                      color: "#1E293B",
                      cursor: savingLifecycle ? "not-allowed" : "pointer"
                    }}
                  >
                    Request tool connections
                  </label>
                  <input
                    id="request-conn-toggle"
                    type="checkbox"
                    checked={requestConnections}
                    disabled={savingLifecycle}
                    onChange={(e) => handleToggleRequestConnections(e.target.checked)}
                    style={{ width: "18px", height: "18px", cursor: savingLifecycle ? "not-allowed" : "pointer" }}
                  />
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748B", lineHeight: "1.4" }}>
                  Prompt client users in Setup Mode to authorize third-party tools via Central Pulse Vault.
                </p>
              </div>
            </div>
          </div>

          {setupMode ? (
            /* ====================================================================
               CLIENT IS IN SETUP MODE: DISPLAY 5-PHASE ONBOARDING CHECKLIST
            ==================================================================== */
            <OnboardingChecklistView
              clientName={selectedClient?.clientName || selectedClientName}
              masterSheetId={selectedClient?.masterSheetId || config?.masterSheetId}
              clientSheetId={selectedClient?.clientSheetId || config?.clientSheetId}
              user={user}
              onOpenSheetEditor={(editor) => setActiveSheetEditor(editor)}
              onGoToBudget={onGoToBudget}
              onSetupModeToggled={(newMode) => {
                setSetupMode(newMode);
                if (selectedClient) loadConfig(selectedClient);
              }}
            />
          ) : (
            /* ====================================================================
               CLIENT IS LIVE: DISPLAY STANDARD SETUP CONFIGURATION CARDS
            ==================================================================== */
            <form onSubmit={handleSave}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "20px" }}>

                {/* 1. TOOL SELECTION CARD */}
                <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ marginBottom: "16px" }}>
                    <h2 style={{ margin: "0 0 4px 0", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                      1. Integrated tools{isUserAdmin ? " (Master sheet KeyInfo sync)" : ""}
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
                            {config?.accountingStatus?.connected ? "● Connected" : "○ Needs connection"}
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
                            {config?.crmStatus?.connected ? "● Connected" : "○ Needs connection"}
                          </span>
                        ) : (
                          <span style={{ fontSize: "11px", color: "#64748B" }}>
                            {["google sheet", "excel"].includes(crmTool.toLowerCase()) ? "File source" : ""}
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
                        <option value="Google Sheet">Google Sheet</option>
                        <option value="Excel">Excel</option>
                      </select>
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
                    </div>
                  </div>
                </div>

                {/* 2. CONNECTION READINESS SUMMARY */}
                <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <h2 style={{ margin: "0 0 10px 0", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                    2. Connection status summary
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
                              {t.connected ? "✓ Connected & active" : "○ Waiting for connection"}
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

                {/* 3. BUDGET DATA EDITOR */}
                <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ marginBottom: "14px" }}>
                    <h2 style={{ margin: "0 0 4px 0", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                      3. Budget editor
                    </h2>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Edit the client financial budget model (also available under the Edit menu).
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (onGoToBudget) onGoToBudget(selectedClient?.clientName);
                        else if (typeof window !== "undefined") window.location.href = `/pma?nav=budget&client=${encodeURIComponent(selectedClient?.clientName || "")}`;
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "9px 16px",
                        borderRadius: "8px",
                        background: "#023f98",
                        color: "#FFFFFF",
                        fontSize: "13px",
                        fontWeight: "600",
                        border: "none",
                        cursor: "pointer",
                        boxShadow: "0 1px 2px rgba(2, 63, 152, 0.2)"
                      }}
                    >
                      <span>📊</span>
                      <span>Open budget editor</span>
                    </button>
                  </div>
                </div>

                {/* 4. COLLAPSIBLE ONBOARDING HISTORY */}
                <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "16px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <button
                    type="button"
                    onClick={() => setShowChecklistHistory(!showChecklistHistory)}
                    style={{
                      width: "100%",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: 0
                    }}
                  >
                    <div>
                      <h3 style={{ margin: "0 0 2px", fontSize: "14px", fontWeight: "700", color: "#0F172A", textAlign: "left" }}>
                        📋 Onboarding checklist history & setup tasks
                      </h3>
                      <p style={{ margin: 0, fontSize: "12px", color: "#64748B", textAlign: "left" }}>
                        {isUserAdmin ? "View completed onboarding items, recorded Script IDs, and Master KeyInfo settings." : "View completed onboarding items and financial setup settings."}
                      </p>
                    </div>
                    <span style={{ fontSize: "13px", fontWeight: "600", color: "#023f98" }}>
                      {showChecklistHistory ? "Hide checklist ▲" : "View checklist ▼"}
                    </span>
                  </button>

                  {showChecklistHistory && (
                    <div style={{ marginTop: "18px", borderTop: "1px solid #E2E8F0", paddingTop: "18px" }}>
                      <OnboardingChecklistView
                        clientName={selectedClient?.clientName || selectedClientName}
                        masterSheetId={selectedClient?.masterSheetId || config?.masterSheetId}
                        clientSheetId={selectedClient?.clientSheetId || config?.clientSheetId}
                        user={user}
                        onOpenSheetEditor={(editor) => setActiveSheetEditor(editor)}
                        onGoToBudget={onGoToBudget}
                        onSetupModeToggled={(newMode) => {
                          setSetupMode(newMode);
                          if (selectedClient) loadConfig(selectedClient);
                        }}
                      />
                    </div>
                  )}
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
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
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
                      Discard changes
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
                      <span>{saving ? "Saving..." : "Save setup configuration"}</span>
                    </button>
                  </div>
                </div>

              </div>
            </form>
          )}
        </>
      )}

      {/* Embedded Table Editor Modal */}
      {activeSheetEditor && selectedClient && (
        <EditableSheetEditor
          client={selectedClient}
          initialTab={activeSheetEditor}
          onClose={() => setActiveSheetEditor(null)}
          isAdmin={user?.isAdmin || user?.role === "Admin"}
        />
      )}

      {/* Provision Modal */}
      {isUserAdmin && (
        <OnboardClientModal
          isOpen={isOnboardModalOpen}
          onClose={() => setIsOnboardModalOpen(false)}
          onClientCreated={handleClientProvisioned}
        />
      )}
    </div>
  );
}
