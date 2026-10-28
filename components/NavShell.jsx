import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { SYSTEM_VERSION, getSystemCopyright } from "../config/version";
import Spinner from "./Spinner";
import { useAppGlobals } from "../hooks/useAppGlobals";

// Global styles injected once - handles :hover/:active which React inline styles can't do
const GLOBAL_STYLES = `
  html, body { margin: 0; padding: 0; scroll-behavior: auto; font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  button, input, select, textarea { font-family: inherit; }
  @keyframes triage-spin { to { transform: rotate(360deg); } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .refresh-btn { transition: background 0.15s, transform 0.1s; }
  .refresh-btn svg { transform-origin: center; display: block; }
  .refresh-btn:hover:not(:disabled) { background: rgba(0, 71, 171, 0.08) !important; }
  .refresh-btn:active:not(:disabled) { transform: scale(0.92); }
  .refresh-btn:disabled { cursor: wait !important; opacity: 0.7; }
  .pma-edit-subbar, .pma-views-subbar {
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .pma-edit-subbar::-webkit-scrollbar, .pma-views-subbar::-webkit-scrollbar {
    display: none;
  }
  .triage-btn { transition: filter 0.15s, transform 0.1s, background 0.15s, box-shadow 0.15s !important; }
  .triage-btn:hover:not(:disabled) { filter: brightness(0.92); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
  .triage-btn:active:not(:disabled) { transform: scale(0.97); filter: brightness(0.85); }
  .triage-btn:disabled { cursor: not-allowed !important; opacity: 0.55 !important; }
  .triage-btn-primary:hover:not(:disabled) { background: #0055aa !important; }
  .triage-client-card { transition: background 0.12s, border-color 0.12s, box-shadow 0.12s !important; }
  .triage-client-card:hover { background: #f0f4ff !important; border-color: #2196f3 !important; box-shadow: 0 2px 8px rgba(33,150,243,0.15) !important; }
  .triage-client-card:active { background: #e3ecff !important; transform: scale(0.995); }
  .pulse-nav-item { transition: color 0.15s, border-color 0.15s, background 0.15s !important; }
  .pulse-nav-item:hover { color: #0047AB !important; }
  .pma-page-container {
    width: 100%;
    max-width: 100%;
    margin: 0 auto;
    padding: 20px 32px 60px;
    box-sizing: border-box;
    font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  @media (max-width: 768px) {
    .pma-page-container {
      padding: 16px 16px 48px !important;
    }
  }

  /* Top Navigation Bar */
  .pma-topbar {
    background: #A2C4C9;
    border-bottom: 1px solid #8ab0b6;
    color: #0047AB;
    padding: 10px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-sizing: border-box;
    position: relative;
    z-index: 101;
  }
  .pma-topbar-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-shrink: 0;
  }
  .pma-topbar-brand-logo {
    height: 30px;
    width: auto;
    display: block;
    flex-shrink: 0;
  }
  .pma-topbar-title {
    font-size: 20.5px;
    font-weight: 700;
    color: #0047AB;
    letter-spacing: -0.2px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: visible;
    position: relative;
    top: 1.5px;
  }
  .pma-topbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .pma-manage-btn-wrapper {
    position: relative;
  }
  .pma-pulse-btn-wrapper {
    position: relative;
  }
  .pma-topbar-profile {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    position: relative;
  }

  @media (max-width: 768px) {
    .pma-topbar {
      padding: 10px 16px;
    }
  }

  /* Mobile Portrait and Small Screens (Double-height layout) */
  @media (max-width: 600px) {
    .pma-topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      row-gap: 8px;
      column-gap: 8px;
      padding: 8px 16px;
    }
    .pma-topbar-brand {
      grid-column: 1 / 2;
      grid-row: 1 / 2;
      gap: 6px;
      align-self: center;
    }
    .pma-topbar-brand-logo {
      height: 24px;
    }
    .pma-topbar-title {
      font-size: 16.5px;
      letter-spacing: -0.2px;
      line-height: 1.3;
      white-space: nowrap;
      overflow: visible;
      text-overflow: clip;
      top: 1px;
    }
    .pma-topbar-profile {
      grid-column: 2 / 3;
      grid-row: 1 / 2;
      justify-self: end;
      align-self: center;
    }
    .pma-topbar-actions {
      grid-column: 1 / 3;
      grid-row: 2 / 3;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin-left: 0;
    }
    .pma-manage-btn-wrapper {
      flex: 1;
      min-width: 0;
    }
    .pma-manage-btn {
      width: 100% !important;
      max-width: 100% !important;
      justify-content: space-between !important;
    }
    .pma-pulse-btn-wrapper {
      flex-shrink: 0;
    }
    .pma-topbar-actions > .pma-pulse-btn-wrapper:only-child {
      flex: 1;
      width: 100%;
    }
    .pma-topbar-actions > .pma-pulse-btn-wrapper:only-child .pma-pulse-btn {
      width: 100% !important;
      justify-content: center !important;
    }
    .pma-manage-dropdown {
      left: 0 !important;
      right: auto !important;
    }
    .pma-views-content-inner {
      padding: 12px !important;
    }
    .pma-managed-banner {
      padding: 7px 16px !important;
      font-size: 12px !important;
    }
  }

  @media (max-width: 480px) {
    .pma-navbar {
      padding: 0 8px !important;
    }
    .pma-navbar .pulse-nav-item {
      padding: 11px 7px !important;
      font-size: 13px !important;
    }
  }

  /* Extra small screens (e.g. 320px - 360px) */
  @media (max-width: 360px) {
    .pma-topbar {
      padding: 6px 8px;
      row-gap: 6px;
      column-gap: 6px;
    }
    .pma-topbar-brand-logo {
      height: 22px;
    }
    .pma-topbar-title {
      font-size: 12.5px;
    }
  }
`;

if (typeof document !== "undefined") {
  const id = "triage-global-styles";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = GLOBAL_STYLES;
}

// Persistent top bar - rendered around every screen
export default function NavShell({
  activeNav, activeViewTab = "fyPerformance", onSelectViewTab,
  onHome, onAlerts, onOverview, onTasks, onActivity, onAppLog,
  onOutgoings, onInvoices, onRetainers, onJobs, onSalaries, onExpenses, onNBToFind, onBudget, onCash, onViews, onTools, onIntegrations, onSetup, onSettings,
  homeAlertCount, taskCount, integrationsCount, user, onLogout, clients = [],
  managedClient, onSelectManagedClient, onClearManagedClient,
  isSingleClientUser: propIsSingleClientUser, singleClient: propSingleClient,
  children
}) {
  const router = useRouter();
  const { preloadClientData } = useAppGlobals();
  const isAdmin = !user?.isReadOnly && !!(user?.isAdmin || user?.role === "Admin");
  const [showMore, setShowMore] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [manageDropdownOpen, setManageDropdownOpen] = useState(false);
  const [pulseDropdownOpen, setPulseDropdownOpen] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [editDropdownOpen, setEditDropdownOpen] = useState(false);
  const [viewsDropdownOpen, setViewsDropdownOpen] = useState(false);
  const [mobileExpandedGroup, setMobileExpandedGroup] = useState(null);
  const [portalClients, setPortalClients] = useState(() => (clients && clients.length > 0 ? clients : []));
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [manageClientSearch, setManageClientSearch] = useState("");

  const isSingleClientUser = Boolean(
    propIsSingleClientUser ?? (
      !isAdmin && (
        portalClients.length === 1 ||
        (Array.isArray(user?.assignedClients) && user.assignedClients.length === 1)
      )
    )
  );
  const singleClient = propSingleClient || (portalClients.length === 1 ? portalClients[0] : (managedClient || null));

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 840);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Fetch authorized portal clients if not already provided
  useEffect(() => {
    if (clients && clients.length > 0) {
      setPortalClients(clients);
      return;
    }
    try {
      const stored = localStorage.getItem("pulse_cached_all_clients");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) setPortalClients(parsed);
      }
    } catch { }
    if (!user || onSelectManagedClient) return;
    setClientsLoading(true);
    fetch("/api/portal/clients")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && Array.isArray(d.clients)) {
          setPortalClients(d.clients);
        }
      })
      .catch((e) => console.error("NavShell: failed to fetch clients", e))
      .finally(() => setClientsLoading(false));
  }, [clients, user]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!showMore && !manageDropdownOpen && !pulseDropdownOpen && !profileDropdownOpen && !editDropdownOpen && !viewsDropdownOpen) return;
    const close = (e) => {
      if (showMore && !e.target.closest(".nav-more-dropdown") && !e.target.closest(".nav-more-btn")) {
        setShowMore(false);
      }
      if (manageDropdownOpen && !e.target.closest(".pma-manage-dropdown") && !e.target.closest(".pma-manage-btn")) {
        setManageDropdownOpen(false);
      }
      if (pulseDropdownOpen && !e.target.closest(".pma-pulse-dropdown") && !e.target.closest(".pma-pulse-btn")) {
        setPulseDropdownOpen(false);
      }
      if (profileDropdownOpen && !e.target.closest(".pma-profile-dropdown") && !e.target.closest(".pma-profile-btn")) {
        setProfileDropdownOpen(false);
      }
      if (editDropdownOpen && !e.target.closest(".pma-edit-dropdown") && !e.target.closest(".pma-nav-dropdown-btn-edit")) {
        setEditDropdownOpen(false);
      }
      if (viewsDropdownOpen && !e.target.closest(".pma-views-dropdown") && !e.target.closest(".pma-nav-dropdown-btn-views")) {
        setViewsDropdownOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === "Escape") {
        setShowMore(false);
        setManageDropdownOpen(false);
        setPulseDropdownOpen(false);
        setProfileDropdownOpen(false);
        setEditDropdownOpen(false);
        setViewsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showMore, manageDropdownOpen, pulseDropdownOpen, profileDropdownOpen, editDropdownOpen, viewsDropdownOpen]);

  const handleSelectPulseClient = (client) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pulse_portal_client", client.clientName);
      localStorage.setItem("pulse_portal_active_client_obj", JSON.stringify(client));
    }
    setPulseDropdownOpen(false);
    router.push(`/pulse?client=${encodeURIComponent(client.clientName)}`);
  };

  const filteredClients = portalClients.filter((c) =>
    c.clientName?.toLowerCase().includes(clientSearch.toLowerCase().trim())
  );

  const filteredManageClients = portalClients.filter((c) =>
    c.clientName?.toLowerCase().includes(manageClientSearch.toLowerCase().trim())
  );

  const Badge = ({ count }) => count > 0 ? (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "#e53e3e", color: "#fff", borderRadius: "10px",
      fontSize: "10px", fontWeight: "700", minWidth: "17px", height: "17px",
      padding: "0 5px", marginLeft: "5px", lineHeight: "1", verticalAlign: "middle",
    }}>{count > 99 ? "99+" : count}</span>
  ) : null;

  const isTabActive = (name) => activeNav === name || (name === "activity" && activeNav === "appLog");
  const isChildActive = (sub) => {
    if (sub.tabId) {
      return activeNav === "views" && activeViewTab === sub.tabId;
    }
    return isTabActive(sub.key);
  };

  const getNavHref = (key) => {
    const clientQuery = managedClient?.clientName ? `&client=${encodeURIComponent(managedClient.clientName)}` : "";
    if (key === "home") {
      return managedClient?.clientName ? `/pma?client=${encodeURIComponent(managedClient.clientName)}` : "/pma";
    }
    if (key === "alerts") {
      return managedClient?.clientName ? `/pma/alerts?client=${encodeURIComponent(managedClient.clientName)}` : "/pma/alerts";
    }
    return `/pma?nav=${encodeURIComponent(key)}${clientQuery}`;
  };
  const getChildHref = (sub) => getNavHref(sub.navKey || sub.key);

  const handleNavClick = (e, handler) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      handler?.();
    }
  };

  const navBtnStyle = (name) => ({
    background: "none", border: "none", cursor: "pointer",
    padding: isMobile ? "12px 10px" : "12px 14px",
    fontSize: "14px", fontWeight: isTabActive(name) ? "600" : "500",
    fontFamily: "inherit", lineHeight: "1.5",
    color: isTabActive(name) ? "#0047AB" : "#475569",
    borderBottom: isTabActive(name) ? "2px solid #0047AB" : "2px solid transparent",
    borderRadius: "0", display: "flex", alignItems: "center", whiteSpace: "nowrap",
    textDecoration: "none", boxSizing: "border-box", margin: 0,
  });

  // Strict requested menu order with Edit and Views dropdowns:
  // Home, Alerts, Tasks, Edit (...), Views (...), EoM, Integrations, Setup, Activity, Settings
  const handleSelectViewOption = (tabId) => {
    if (onSelectViewTab) {
      onSelectViewTab(tabId);
    } else {
      onViews?.(tabId);
    }
  };

  const allNavItems = [
    { key: "home", label: "Home", handler: onHome },
    { key: "alerts", label: "Alerts", handler: onAlerts, badge: homeAlertCount },
    { key: "tasks", label: "Tasks", handler: onTasks, badge: taskCount },
    {
      key: "edit",
      label: "Edit",
      isDropdown: true,
      children: [
        { key: "jobs", label: "Jobs", handler: onJobs },
        { key: "outgoings", label: "Contractors", handler: onOutgoings },
        { key: "invoices", label: "Invoices", handler: onInvoices },
        { key: "retainers", label: "Retainers", handler: onRetainers },
        { key: "salaries", label: "Salaries", handler: onSalaries },
        { key: "expenses", label: "Expenses", handler: onExpenses },
        { key: "nbtofind", label: "New business to find", handler: onNBToFind },
        { key: "budget", label: "Budget", handler: onBudget },
        { key: "cash", label: "Cash", handler: onCash },
      ],
    },
    {
      key: "views",
      label: "Views",
      isDropdown: true,
      children: [
        { key: "view_fyPerformance", tabId: "fyPerformance", navKey: "views", label: "FY performance", handler: () => handleSelectViewOption("fyPerformance") },
        { key: "view_cashflow", tabId: "cashflow", navKey: "views", label: "Cashflow forecast", handler: () => handleSelectViewOption("cashflow") },
        { key: "view_contractors", tabId: "contractors", navKey: "views", label: "Contractors", handler: () => handleSelectViewOption("contractors") },
        { key: "view_expenses", tabId: "expenses", navKey: "views", label: "Expenses", handler: () => handleSelectViewOption("expenses") },
        { key: "view_salaries", tabId: "salaries", navKey: "views", label: "Salaries", handler: () => handleSelectViewOption("salaries") },
        { key: "view_dividends", tabId: "dividends", navKey: "views", label: "Dividends", handler: () => handleSelectViewOption("dividends") },
        { key: "view_nbToFind", tabId: "nbToFind", navKey: "views", label: "New business to find", handler: () => handleSelectViewOption("nbToFind") },
        { key: "view_budgetOverview", tabId: "budgetOverview", navKey: "views", label: "Budget overview", handler: () => handleSelectViewOption("budgetOverview") },
      ],
    },
    { key: "tools", label: "EoM", handler: onTools },
    { key: "integrations", label: "Integrations", handler: onIntegrations, badge: integrationsCount },
    { key: "setup", label: "Setup", handler: onSetup },
    { key: "activity", label: "Activity", handler: onActivity || onAppLog },
    { key: "settings", label: "Settings", handler: onSettings },
  ];

  const editGroupItem = allNavItems.find((n) => n.key === "edit");
  const isEditSubActive = Boolean(editGroupItem?.children?.some((c) => isChildActive(c)));
  const viewsGroupItem = allNavItems.find((n) => n.key === "views");
  const isViewsSubActive = activeNav === "views";

  return (
    <div style={{ fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", minHeight: "100vh", background: "#f8fafc" }}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLES }} />
      <div className="pma-topbar">
        <a
          href={getNavHref("home")}
          onClick={(e) => handleNavClick(e, onHome)}
          className="pma-topbar-brand"
          style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pulselogo-pma.png"
            alt="Pulse"
            className="pma-topbar-brand-logo"
          />
          <span className="pma-topbar-title">Management Area</span>
        </a>
        {user && (
          <>
            <div className="pma-topbar-actions">
              {/* Manage Client Dropdown (only shown when user has access to more than one client) */}
              {!isSingleClientUser && (
                <div className="pma-manage-btn-wrapper">
                  <button
                    type="button"
                    className="pma-manage-btn triage-btn"
                    onClick={() => {
                      setManageDropdownOpen((v) => !v);
                      setPulseDropdownOpen(false);
                      setProfileDropdownOpen(false);
                      setEditDropdownOpen(false);
                      setViewsDropdownOpen(false);
                    }}
                    style={{
                      background: managedClient ? "#ffffff" : "rgba(255, 255, 255, 0.72)",
                      border: managedClient ? "1.5px solid #0047AB" : "1px solid rgba(0, 71, 171, 0.28)",
                      borderRadius: "6px",
                      color: "#0047AB",
                      fontSize: "13px",
                      fontWeight: 600,
                      padding: "5px 12px",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      transition: "all 0.15s ease",
                      boxShadow: "0 1px 2px rgba(0, 71, 171, 0.12)",
                      maxWidth: isMobile ? "100%" : "220px"
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = managedClient ? "#f0f7ff" : "rgba(255, 255, 255, 0.92)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = managedClient ? "#ffffff" : "rgba(255, 255, 255, 0.72)"; }}
                    title={managedClient ? `Managing: ${managedClient.clientName} across PMA (Click to switch or clear)` : "Select client to manage across PMA"}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      Manage:{managedClient ? ` ${managedClient.clientName}` : ""}
                    </span>
                    <span style={{ fontSize: "10px", opacity: 0.85, lineHeight: 1 }}>{manageDropdownOpen ? "▲" : "▼"}</span>
                  </button>

                  {manageDropdownOpen && (
                    <div
                      className="pma-manage-dropdown"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        right: 0,
                        background: "#ffffff",
                        borderRadius: "8px",
                        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.15)",
                        border: "1px solid #cbd5e1",
                        zIndex: 1000,
                        minWidth: "220px",
                        maxWidth: "280px",
                        overflow: "hidden"
                      }}
                    >
                      <div
                        style={{
                          padding: "0.55rem 0.85rem",
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#64748b",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          borderBottom: "1px solid #e2e8f0",
                          background: "#f8fafc",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center"
                        }}
                      >
                        <span>Manage Client</span>
                        {managedClient && (
                          <span style={{ fontSize: "10px", color: "#0047AB", textTransform: "none", fontWeight: 600 }}>Active</span>
                        )}
                      </div>

                      {managedClient && (
                        <button
                          type="button"
                          onClick={() => {
                            setManageDropdownOpen(false);
                            onClearManagedClient?.();
                          }}
                          style={{
                            width: "100%",
                            padding: "8px 14px",
                            textAlign: "left",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#dc2626",
                            background: "#fef2f2",
                            border: "none",
                            borderBottom: "1px solid #fee2e2",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "6px"
                          }}
                        >
                          <span>✕</span>
                          <span>Cancel & return to all clients</span>
                        </button>
                      )}

                      {portalClients.length > 5 && (
                        <div style={{ padding: "6px 8px", borderBottom: "1px solid #e2e8f0", background: "#ffffff" }}>
                          <input
                            type="text"
                            placeholder="Search client to manage..."
                            value={manageClientSearch}
                            onChange={(e) => setManageClientSearch(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: "100%",
                              padding: "5px 8px",
                              fontSize: "12px",
                              borderRadius: "4px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              boxSizing: "border-box",
                              fontFamily: "inherit"
                            }}
                            autoFocus
                          />
                        </div>
                      )}

                      <div style={{ maxHeight: "280px", overflowY: "auto" }}>
                        {clientsLoading ? (
                          <div style={{ padding: "14px", fontSize: "13px", color: "#64748b", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                            <Spinner size={14} color="#0047AB" /> Loading clients...
                          </div>
                        ) : filteredManageClients.length === 0 ? (
                          <div style={{ padding: "14px", fontSize: "13px", color: "#94a3b8", textAlign: "center" }}>
                            No clients found
                          </div>
                        ) : (
                          filteredManageClients.map((c) => {
                            const isSelected = managedClient?.clientName === c.clientName;
                            const clientHref = `/pma?client=${encodeURIComponent(c.clientName)}${activeNav && activeNav !== "home" ? `&nav=${encodeURIComponent(activeNav)}` : ""}`;
                            return (
                              <a
                                key={c.clientName}
                                href={clientHref}
                                onClick={(e) => {
                                  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                                    e.preventDefault();
                                    setManageDropdownOpen(false);
                                    onSelectManagedClient?.(c);
                                  }
                                }}
                                style={{
                                  width: "100%",
                                  padding: "8px 14px",
                                  textAlign: "left",
                                  fontSize: "13px",
                                  fontWeight: isSelected ? 700 : 500,
                                  color: isSelected ? "#0047AB" : "#1e293b",
                                  background: isSelected ? "#eff6ff" : "transparent",
                                  border: "none",
                                  borderBottom: "1px solid #f1f5f9",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  transition: "background 0.12s, color 0.12s",
                                  textDecoration: "none",
                                  boxSizing: "border-box"
                                }}
                                onMouseEnter={(e) => {
                                  preloadClientData?.(c);
                                  if (!isSelected) {
                                    e.currentTarget.style.background = "#f0f7ff";
                                    e.currentTarget.style.color = "#0047AB";
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isSelected) {
                                    e.currentTarget.style.background = "transparent";
                                    e.currentTarget.style.color = "#1e293b";
                                  }
                                }}
                              >
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.clientName}</span>
                                {isSelected && <span style={{ color: "#0047AB", fontSize: "12px" }}>✓</span>}
                              </a>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Pulse Button: direct navigation for single client users, dropdown chooser for multi-client users */}
              <div className="pma-pulse-btn-wrapper">
                <button
                  type="button"
                  className="pma-pulse-btn triage-btn"
                  onClick={() => {
                    if (isSingleClientUser && (singleClient || managedClient)) {
                      handleSelectPulseClient(singleClient || managedClient);
                    } else {
                      setPulseDropdownOpen((v) => !v);
                      setProfileDropdownOpen(false);
                      setManageDropdownOpen(false);
                      setEditDropdownOpen(false);
                      setViewsDropdownOpen(false);
                    }
                  }}
                  style={{
                    background: "#0047AB",
                    border: "1px solid #0047AB",
                    borderRadius: "6px",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 600,
                    padding: "5px 12px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    transition: "all 0.15s ease",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#003b8e"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#0047AB"; }}
                  title={isSingleClientUser ? `Open Pulse for ${(singleClient || managedClient)?.clientName || "client"}` : "Select client to visit in Pulse"}
                >
                  <span>Pulse</span>
                  {!isSingleClientUser && (
                    <span style={{ fontSize: "10px", opacity: 0.85, lineHeight: 1 }}>{pulseDropdownOpen ? "▲" : "▼"}</span>
                  )}
                </button>

                {!isSingleClientUser && pulseDropdownOpen && (
                  <div
                    className="pma-pulse-dropdown"
                    style={{
                      position: "absolute",
                      top: "calc(100% + 8px)",
                      right: 0,
                      background: "#ffffff",
                      borderRadius: "8px",
                      boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.15)",
                      border: "1px solid #cbd5e1",
                      zIndex: 1000,
                      minWidth: "220px",
                      maxWidth: "280px",
                      overflow: "hidden"
                    }}
                  >
                    <div
                      style={{
                        padding: "0.55rem 0.85rem",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "#64748b",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        borderBottom: "1px solid #e2e8f0",
                        background: "#f8fafc"
                      }}
                    >
                      Select Client
                    </div>

                    {portalClients.length > 5 && (
                      <div style={{ padding: "6px 8px", borderBottom: "1px solid #e2e8f0", background: "#ffffff" }}>
                        <input
                          type="text"
                          placeholder="Search client..."
                          value={clientSearch}
                          onChange={(e) => setClientSearch(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: "100%",
                            padding: "5px 8px",
                            fontSize: "12px",
                            borderRadius: "4px",
                            border: "1px solid #cbd5e1",
                            outline: "none",
                            boxSizing: "border-box",
                            fontFamily: "inherit"
                          }}
                          autoFocus
                        />
                      </div>
                    )}

                    <div style={{ maxHeight: "280px", overflowY: "auto" }}>
                      {clientsLoading ? (
                        <div style={{ padding: "14px", fontSize: "13px", color: "#64748b", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                          <Spinner size={14} color="#0047AB" /> Loading clients...
                        </div>
                      ) : filteredClients.length === 0 ? (
                        <div style={{ padding: "14px", fontSize: "13px", color: "#94a3b8", textAlign: "center" }}>
                          No clients found
                        </div>
                      ) : (
                        filteredClients.map((c) => (
                          <a
                            key={c.clientName}
                            href={`/pulse?client=${encodeURIComponent(c.clientName)}`}
                            onClick={(e) => {
                              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                                e.preventDefault();
                                handleSelectPulseClient(c);
                              }
                            }}
                            style={{
                              width: "100%",
                              padding: "8px 14px",
                              textAlign: "left",
                              fontSize: "13px",
                              fontWeight: 500,
                              color: "#1e293b",
                              background: "transparent",
                              border: "none",
                              borderBottom: "1px solid #f1f5f9",
                              cursor: "pointer",
                              display: "block",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              transition: "background 0.12s, color 0.12s",
                              textDecoration: "none",
                              boxSizing: "border-box"
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "#f0f7ff";
                              e.currentTarget.style.color = "#0047AB";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.color = "#1e293b";
                            }}
                          >
                            {c.clientName}
                          </a>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

            </div>

            {/* Profile Menu Button */}
            <div className="pma-topbar-profile">
              <button
                type="button"
                className="pma-profile-btn triage-btn"
                onClick={() => {
                  setProfileDropdownOpen((v) => !v);
                  setPulseDropdownOpen(false);
                  setManageDropdownOpen(false);
                  setEditDropdownOpen(false);
                  setViewsDropdownOpen(false);
                }}
                style={{
                  background: "#0047AB",
                  border: "2px solid rgba(255, 255, 255, 0.8)",
                  color: "#ffffff",
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: "13px",
                  transition: "background 0.15s",
                  boxShadow: "0 1px 3px rgba(0, 71, 171, 0.25)"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#003b8e"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#0047AB"; }}
                title={user?.email || "Account"}
              >
                {(user?.name || user?.email || "U")[0].toUpperCase()}
              </button>

              {profileDropdownOpen && (
                <div
                  className="pma-profile-dropdown"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    background: "#ffffff",
                    borderRadius: "8px",
                    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.15)",
                    border: "1px solid #cbd5e1",
                    zIndex: 1000,
                    minWidth: "220px",
                    padding: "0.5rem 0"
                  }}
                >
                  <div style={{ padding: "0.5rem 1rem", borderBottom: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b" }}>
                      {user?.name || "User"}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {user?.email}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: "0.5rem 1rem",
                      fontSize: "11px",
                      color: "#94a3b8",
                      lineHeight: "1.4"
                    }}
                  >
                    <div>Pulse v{SYSTEM_VERSION}</div>
                    <div style={{ marginTop: "2px" }}>{getSystemCopyright()}</div>
                  </div>

                  {onLogout && (
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDropdownOpen(false);
                        onLogout();
                      }}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        padding: "0.65rem 1rem",
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#ef4444",
                        background: "transparent",
                        border: "none",
                        borderTop: "1px solid #e2e8f0",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background 0.15s"
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#fee2e2"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      Sign out
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="pma-navbar" style={{
        background: "#ffffff",
        borderBottom: "1px solid #e2e8f0",
        padding: isMobile ? "0 12px" : "0 18px",
        display: "flex",
        alignItems: "stretch",
        position: "relative",
        zIndex: 100,
        overflow: "visible",
      }}>
        {!isMobile && allNavItems.map((item) => {
          if (item.isDropdown) {
            const isSubActive = item.children.some((c) => isChildActive(c));
            const isOpen = item.key === "edit" ? editDropdownOpen : viewsDropdownOpen;
            const toggleOpen = () => {
              if (item.key === "edit") {
                setEditDropdownOpen((v) => !v);
                setViewsDropdownOpen(false);
              } else {
                setViewsDropdownOpen((v) => !v);
                setEditDropdownOpen(false);
              }
              setManageDropdownOpen(false);
              setPulseDropdownOpen(false);
              setProfileDropdownOpen(false);
            };
            const closeOpen = () => {
              if (item.key === "edit") setEditDropdownOpen(false);
              else setViewsDropdownOpen(false);
            };
            return (
              <div key={item.key} style={{ position: "relative", display: "flex", alignItems: "stretch" }}>
                <a
                  href={getChildHref(item.children[0] || { key: "jobs" })}
                  className={`triage-btn pulse-nav-item pma-nav-dropdown-btn pma-nav-dropdown-btn-${item.key}`}
                  onClick={(e) => {
                    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleOpen();
                    }
                  }}
                  style={{
                    ...navBtnStyle(item.key),
                    color: (isSubActive || isOpen) ? "#0047AB" : "#475569",
                    fontWeight: (isSubActive || isOpen) ? "600" : "500",
                    borderBottom: isSubActive ? "2px solid #0047AB" : "2px solid transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{ fontSize: "10px", opacity: 0.8, lineHeight: 1 }}>{isOpen ? "▲" : "▼"}</span>
                </a>
                {isOpen && (
                  <div
                    className={`pma-${item.key}-dropdown`}
                    style={{
                      position: "absolute",
                      top: "calc(100% + 1px)",
                      left: 0,
                      background: "#ffffff",
                      borderRadius: "0 0 8px 8px",
                      boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.15)",
                      border: "1px solid #cbd5e1",
                      borderTop: "none",
                      zIndex: 1000,
                      minWidth: "185px",
                      overflow: "hidden",
                    }}
                  >
                    {item.children.map((sub) => {
                      const active = isChildActive(sub);
                      return (
                        <a
                          key={sub.key}
                          href={getChildHref(sub)}
                          onClick={(e) => {
                            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                              e.preventDefault();
                              closeOpen();
                              sub.handler?.();
                            }
                          }}
                          style={{
                            width: "100%",
                            padding: "9px 14px",
                            textAlign: "left",
                            fontSize: "13px",
                            fontWeight: active ? 700 : 500,
                            color: active ? "#0047AB" : "#334155",
                            background: active ? "#eff6ff" : "transparent",
                            border: "none",
                            borderBottom: "1px solid #f1f5f9",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            transition: "background 0.12s",
                            textDecoration: "none",
                            boxSizing: "border-box"
                          }}
                          onMouseEnter={(e) => {
                            if (!active) e.currentTarget.style.background = "#f8fafc";
                          }}
                          onMouseLeave={(e) => {
                            if (!active) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <span>{sub.label}</span>
                          {active && <span style={{ color: "#0047AB", fontSize: "12px" }}>✓</span>}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          return (
            <a
              key={item.key}
              href={getNavHref(item.key)}
              className="triage-btn pulse-nav-item"
              onClick={(e) => handleNavClick(e, item.handler)}
              style={navBtnStyle(item.key)}
            >
              {item.label}
              {item.badge !== undefined && <Badge count={item.badge} />}
            </a>
          );
        })}

        {isMobile && (
          <>
            <a href={getNavHref("home")} className="triage-btn pulse-nav-item" onClick={(e) => handleNavClick(e, onHome)} style={navBtnStyle("home")}>
              Home
            </a>
            <a href={getNavHref("alerts")} className="triage-btn pulse-nav-item" onClick={(e) => handleNavClick(e, onAlerts)} style={navBtnStyle("alerts")}>
              Alerts
              {homeAlertCount !== undefined && <Badge count={homeAlertCount} />}
            </a>
            <a href={getNavHref("tasks")} className="triage-btn pulse-nav-item" onClick={(e) => handleNavClick(e, onTasks)} style={navBtnStyle("tasks")}>
              Tasks
              {taskCount !== undefined && <Badge count={taskCount} />}
            </a>
            {activeNav !== "home" && activeNav !== "alerts" && activeNav !== "tasks" && (
              (() => {
                let current = allNavItems.find((n) => !n.isDropdown && isTabActive(n.key));
                if (!current) {
                  for (const group of allNavItems.filter((n) => n.isDropdown)) {
                    const match = group.children?.find((c) => isChildActive(c));
                    if (match) {
                      current = match;
                      break;
                    }
                  }
                }
                if (!current) return null;
                return (
                  <a
                    href={getChildHref(current)}
                    className="triage-btn pulse-nav-item"
                    onClick={(e) => handleNavClick(e, current.handler)}
                    style={{
                      ...navBtnStyle(current.navKey || current.key),
                      color: "#0047AB",
                      fontWeight: "600",
                      borderBottom: "2px solid #0047AB",
                      minWidth: 0,
                      maxWidth: "130px",
                      overflow: "hidden",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {current.label}
                    </span>
                    {current.badge !== undefined && <Badge count={current.badge} />}
                  </a>
                );
              })()
            )}
            <button
              className="nav-more-btn triage-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowMore((v) => {
                  const next = !v;
                  if (next) {
                    if (isEditSubActive) setMobileExpandedGroup("edit");
                    else if (isViewsSubActive) setMobileExpandedGroup("views");
                  }
                  return next;
                });
              }}
              aria-label="Open menu"
              title="Menu"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "10px 12px",
                fontSize: "18px",
                color: showMore ? "#0047AB" : "#475569",
                borderBottom: "2px solid transparent",
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: "1",
                flexShrink: 0,
              }}
            >
              {showMore ? "✕" : "☰"}
            </button>
            {showMore && (
              <div className="nav-more-dropdown"
                style={{ position: "absolute", top: "100%", right: "0", background: "#fff", border: "1px solid #cbd5e1", borderRadius: "0 0 8px 8px", boxShadow: "0 6px 20px rgba(0,0,0,0.15)", zIndex: 200, minWidth: "210px", maxHeight: "80vh", overflowY: "auto" }}>
                {allNavItems.map((item) => {
                  if (item.isDropdown) {
                    const groupActive = item.children.some((c) => isChildActive(c));
                    const isExpanded = mobileExpandedGroup === item.key;
                    return (
                      <div key={item.key} style={{ borderBottom: "1px solid #f0f0f0" }}>
                        <button
                          type="button"
                          className="triage-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMobileExpandedGroup((prev) => (prev === item.key ? null : item.key));
                          }}
                          style={{
                            background: groupActive ? "#f8fafc" : "none",
                            border: "none",
                            cursor: "pointer",
                            width: "100%",
                            padding: "12px 16px",
                            fontSize: "14px",
                            fontWeight: groupActive ? "600" : "500",
                            color: groupActive ? "#0047AB" : "#475569",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            boxSizing: "border-box",
                          }}
                        >
                          <span>{item.label}</span>
                          <span style={{ fontSize: "10px", opacity: 0.8 }}>{isExpanded ? "▲" : "▼"}</span>
                        </button>
                        {isExpanded && (
                          <div style={{ background: "#f8fafc", borderTop: "1px solid #f1f5f9" }}>
                            {item.children.map((sub) => {
                              const active = isChildActive(sub);
                              return (
                                <a
                                  key={sub.key}
                                  href={getChildHref(sub)}
                                  className="triage-btn"
                                  onClick={(e) => {
                                    handleNavClick(e, () => {
                                      sub.handler?.();
                                      setShowMore(false);
                                    });
                                  }}
                                  style={{
                                    background: active ? "#eff6ff" : "none",
                                    border: "none",
                                    cursor: "pointer",
                                    width: "100%",
                                    textAlign: "left",
                                    padding: "10px 16px 10px 26px",
                                    fontSize: "13px",
                                    fontWeight: active ? "600" : "400",
                                    color: active ? "#0047AB" : "#475569",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    textDecoration: "none",
                                    boxSizing: "border-box"
                                  }}
                                >
                                  <span>{sub.label}</span>
                                  {active && <span style={{ color: "#0047AB" }}>✓</span>}
                                </a>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <a key={item.key} href={getNavHref(item.key)} className="triage-btn"
                      onClick={(e) => {
                        handleNavClick(e, () => {
                          item.handler();
                          setShowMore(false);
                        });
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", width: "100%", justifyContent: "space-between", borderBottom: "1px solid #f0f0f0", padding: "12px 16px", fontSize: "14px", fontWeight: isTabActive(item.key) ? "600" : "400", color: isTabActive(item.key) ? "#0047AB" : "#475569", display: "flex", alignItems: "center", textDecoration: "none", boxSizing: "border-box" }}>
                      <span>{item.label}</span>
                      {item.badge !== undefined && <Badge count={item.badge} />}
                    </a>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Persistent Edit Sub-Navigation Bar when viewing any Edit screen */}
      {isEditSubActive && editGroupItem && (
        <div
          className="pma-edit-subbar"
          style={{
            background: "#f1f5f9",
            borderBottom: "1px solid #e2e8f0",
            padding: isMobile ? "7px 16px" : "7px 32px",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            overflowX: "auto",
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "11.5px",
              fontWeight: 600,
              color: "#64748b",
              marginRight: "4px",
              whiteSpace: "nowrap",
            }}
          >
            Edit:
          </span>
          {editGroupItem.children.map((sub) => {
            const active = isChildActive(sub);
            return (
              <a
                key={sub.key}
                href={getChildHref(sub)}
                onClick={(e) => handleNavClick(e, sub.handler)}
                style={{
                  padding: "4px 11px",
                  borderRadius: "6px",
                  fontSize: "12.5px",
                  fontWeight: active ? 600 : 500,
                  color: active ? "#ffffff" : "#475569",
                  background: active ? "#0047AB" : "transparent",
                  boxShadow: active ? "0 1px 2px rgba(0, 71, 171, 0.2)" : "none",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "#ffffff";
                    e.currentTarget.style.color = "#0047AB";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "#475569";
                  }
                }}
              >
                {sub.label}
              </a>
            );
          })}
        </div>
      )}

      {/* Persistent Views Sub-Navigation Bar when viewing any Views screen */}
      {isViewsSubActive && viewsGroupItem && (
        <div
          className="pma-views-subbar"
          style={{
            background: "#f1f5f9",
            borderBottom: "1px solid #e2e8f0",
            padding: isMobile ? "7px 16px" : "7px 32px",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            overflowX: "auto",
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "11.5px",
              fontWeight: 600,
              color: "#64748b",
              marginRight: "4px",
              whiteSpace: "nowrap",
            }}
          >
            Views:
          </span>
          {viewsGroupItem.children.map((sub) => {
            const active = isChildActive(sub);
            return (
              <a
                key={sub.key}
                href={getChildHref(sub)}
                onClick={(e) => handleNavClick(e, sub.handler)}
                style={{
                  padding: "4px 11px",
                  borderRadius: "6px",
                  fontSize: "12.5px",
                  fontWeight: active ? 600 : 500,
                  color: active ? "#ffffff" : "#475569",
                  background: active ? "#0047AB" : "transparent",
                  boxShadow: active ? "0 1px 2px rgba(0, 71, 171, 0.2)" : "none",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "#ffffff";
                    e.currentTarget.style.color = "#0047AB";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "#475569";
                  }
                }}
              >
                {sub.label}
              </a>
            );
          })}
        </div>
      )}

      {managedClient && !isSingleClientUser && (
        <div
          className="pma-managed-banner"
          style={{
            background: "#0047AB",
            color: "#ffffff",
            padding: "7px 32px",
            fontSize: "13px",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "4px",
            boxShadow: "0 1px 3px rgba(0, 71, 171, 0.15)",
            borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
            letterSpacing: "0.2px",
            textAlign: "center"
          }}
        >
          <span>PMA managing <strong>{managedClient.clientName}</strong> - click{" "}</span>
          <button
            type="button"
            onClick={onClearManagedClient}
            style={{
              background: "none",
              border: "none",
              color: "#ffffff",
              textDecoration: "underline",
              fontWeight: 700,
              cursor: "pointer",
              padding: "0 2px",
              fontFamily: "inherit",
              fontSize: "inherit",
              lineHeight: 1
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#dbeafe"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#ffffff"; }}
            title="Cancel manage mode and return to all clients"
          >
            here
          </button>
          <span>{" "}to cancel</span>
        </div>
      )}
      <div className="pma-main-content-wrapper" style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>{children}</div>
    </div>
  );
}