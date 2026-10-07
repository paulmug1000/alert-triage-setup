import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { SYSTEM_VERSION, getSystemCopyright } from "../config/version";
import Spinner from "./Spinner";

// Global styles injected once - handles :hover/:active which React inline styles can't do
const GLOBAL_STYLES = `
  html, body { margin: 0; padding: 0; scroll-behavior: auto; }
  @keyframes triage-spin { to { transform: rotate(360deg); } }
  .triage-btn { transition: filter 0.15s, transform 0.1s, background 0.15s, box-shadow 0.15s !important; }
  .triage-btn:hover:not(:disabled) { filter: brightness(0.92); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
  .triage-btn:active:not(:disabled) { transform: scale(0.97); filter: brightness(0.85); }
  .triage-btn:disabled { cursor: not-allowed !important; opacity: 0.55 !important; }
  .triage-btn-primary:hover:not(:disabled) { background: #0055aa !important; }
  .triage-client-card { transition: background 0.12s, border-color 0.12s, box-shadow 0.12s !important; }
  .triage-client-card:hover { background: #f0f4ff !important; border-color: #2196f3 !important; box-shadow: 0 2px 8px rgba(33,150,243,0.15) !important; }
  .triage-client-card:active { background: #e3ecff !important; transform: scale(0.995); }
  .pulse-nav-item { transition: color 0.15s, border-color 0.15s !important; }
  .pulse-nav-item:hover { color: #0066cc !important; }

  /* Top Navigation Bar */
  .pma-topbar {
    background: #1a1a2e;
    color: #fff;
    padding: 10px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-sizing: border-box;
  }
  .pma-topbar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex-shrink: 1;
  }
  .pma-topbar-brand-logo {
    height: 32px;
    width: auto;
    display: block;
    flex-shrink: 0;
  }
  .pma-topbar-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pma-topbar-user-area {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }

  /* Mobile Portrait and Small Screens */
  @media (max-width: 600px) {
    .pma-topbar {
      padding: 8px 12px;
      gap: 8px;
    }
    .pma-topbar-brand {
      gap: 8px;
    }
    .pma-topbar-brand-logo {
      height: 26px;
    }
    .pma-topbar-title {
      font-size: 13.5px;
      letter-spacing: -0.1px;
    }
    .pma-topbar-user-area {
      gap: 8px;
    }
  }

  /* Extra small screens (e.g. 320px - 360px) */
  @media (max-width: 360px) {
    .pma-topbar {
      padding: 6px 8px;
    }
    .pma-topbar-brand-logo {
      height: 22px;
    }
    .pma-topbar-title {
      font-size: 12px;
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
  activeNav, onHome, onOverview, onTasks, onActivity, onAppLog,
  onOutgoings, onInvoices, onRetainers, onJobs, onViews, onTools, onIntegrations, onSetup, onSettings,
  homeAlertCount, taskCount, user, onLogout, clients = [], children
}) {
  const router = useRouter();
  const [showMore, setShowMore] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [pulseDropdownOpen, setPulseDropdownOpen] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const [portalClients, setPortalClients] = useState(clients || []);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientSearch, setClientSearch] = useState("");

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
    if (!user) return;
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
    if (!showMore && !pulseDropdownOpen && !profileDropdownOpen) return;
    const close = (e) => {
      if (showMore && !e.target.closest(".nav-more-dropdown") && !e.target.closest(".nav-more-btn")) {
        setShowMore(false);
      }
      if (pulseDropdownOpen && !e.target.closest(".pma-pulse-dropdown") && !e.target.closest(".pma-pulse-btn")) {
        setPulseDropdownOpen(false);
      }
      if (profileDropdownOpen && !e.target.closest(".pma-profile-dropdown") && !e.target.closest(".pma-profile-btn")) {
        setProfileDropdownOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === "Escape") {
        setShowMore(false);
        setPulseDropdownOpen(false);
        setProfileDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showMore, pulseDropdownOpen, profileDropdownOpen]);

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

  const Badge = ({ count }) => count > 0 ? (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "#e53e3e", color: "#fff", borderRadius: "10px",
      fontSize: "10px", fontWeight: "700", minWidth: "17px", height: "17px",
      padding: "0 5px", marginLeft: "5px", lineHeight: "1", verticalAlign: "middle",
    }}>{count > 99 ? "99+" : count}</span>
  ) : null;

  const isTabActive = (name) => activeNav === name || (name === "activity" && activeNav === "appLog");

  const navBtnStyle = (name) => ({
    background: "none", border: "none", cursor: "pointer",
    padding: isMobile ? "12px 10px" : "12px 13px",
    fontSize: "14px", fontWeight: isTabActive(name) ? "600" : "400",
    color: isTabActive(name) ? "#0066cc" : "#444",
    borderBottom: isTabActive(name) ? "2px solid #0066cc" : "2px solid transparent",
    borderRadius: "0", display: "flex", alignItems: "center", whiteSpace: "nowrap",
  });

  // Strict requested menu order:
  // Home, Jobs, Contractors, Invoices, Retainers, Tasks, Activity, Views, EoM, Settings
  const allNavItems = [
    { key: "home", label: "Home", handler: onHome, badge: homeAlertCount },
    { key: "jobs", label: "Jobs", handler: onJobs },
    { key: "outgoings", label: "Contractors", handler: onOutgoings },
    { key: "invoices", label: "Invoices", handler: onInvoices },
    { key: "retainers", label: "Retainers", handler: onRetainers },
    { key: "tasks", label: "Tasks", handler: onTasks, badge: taskCount },
    { key: "activity", label: "Activity", handler: onActivity || onAppLog },
    { key: "views", label: "Views", handler: onViews },
    { key: "tools", label: "EoM", handler: onTools },
    { key: "integrations", label: "Integrations", handler: onIntegrations },
    { key: "setup", label: "Setup", handler: onSetup },
    { key: "settings", label: "⚙ Settings", handler: onSettings },
  ];

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLES }} />
      <div className="pma-topbar">
        <div className="pma-topbar-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pulselogo-transparent.png"
            alt="Pulse"
            className="pma-topbar-brand-logo"
            style={{
              height: "32px",
              width: "auto",
              display: "block",
              flexShrink: 0
            }}
          />
          <span className="pma-topbar-title">Management Area</span>
        </div>
        {user && (
          <div className="pma-topbar-user-area" style={{ position: "relative" }}>
            {/* Pulse Button with Client Chooser Dropdown */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="pma-pulse-btn triage-btn"
                onClick={() => {
                  setPulseDropdownOpen((v) => !v);
                  setProfileDropdownOpen(false);
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
                title="Select client to visit in Pulse"
              >
                <span>Pulse</span>
                <span style={{ fontSize: "10px", opacity: 0.85, lineHeight: 1 }}>{pulseDropdownOpen ? "▲" : "▼"}</span>
              </button>

              {pulseDropdownOpen && (
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
                        <button
                          key={c.clientName}
                          type="button"
                          onClick={() => handleSelectPulseClient(c)}
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
                            transition: "background 0.12s, color 0.12s"
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
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Profile Menu Button */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="pma-profile-btn triage-btn"
                onClick={() => {
                  setProfileDropdownOpen((v) => !v);
                  setPulseDropdownOpen(false);
                }}
                style={{
                  background: "rgba(255, 255, 255, 0.15)",
                  border: "1px solid rgba(255, 255, 255, 0.25)",
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
                  transition: "background 0.15s"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.25)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.15)"; }}
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
          </div>
        )}
      </div>
      <div className="pma-navbar" style={{
        background: "#fff",
        borderBottom: "1px solid #e0e0e0",
        padding: "0 8px",
        display: "flex",
        alignItems: "stretch",
        position: "relative",
        overflowX: isMobile ? "visible" : "auto",
        scrollbarWidth: "none"
      }}>
        {!isMobile && allNavItems.map(({ key, label, handler, badge }) => (
          <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>
            {label}
            {badge !== undefined && <Badge count={badge} />}
          </button>
        ))}

        {isMobile && (
          <>
            <button className="triage-btn pulse-nav-item" onClick={onHome} style={navBtnStyle("home")}>
              Home<Badge count={homeAlertCount} />
            </button>
            {activeNav !== "home" && (
              (() => {
                const current = allNavItems.find(n => isTabActive(n.key));
                if (!current) return null;
                return (
                  <button className="triage-btn pulse-nav-item" onClick={current.handler} style={navBtnStyle(current.key)}>
                    {current.label}
                    {current.badge !== undefined && <Badge count={current.badge} />}
                  </button>
                );
              })()
            )}
            <button className="nav-more-btn triage-btn"
              onClick={(e) => { e.stopPropagation(); setShowMore(v => !v); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "12px 14px", fontSize: "16px", color: "#666", borderBottom: "2px solid transparent", marginLeft: "auto" }}>
              {showMore ? "✕" : "••• Menu"}
            </button>
            {showMore && (
              <div className="nav-more-dropdown"
                style={{ position: "absolute", top: "100%", right: "0", background: "#fff", border: "1px solid #ddd", borderRadius: "0 0 8px 8px", boxShadow: "0 6px 20px rgba(0,0,0,0.15)", zIndex: 200, minWidth: "180px" }}>
                {allNavItems.map(({ key, label, handler, badge }) => (
                  <button key={key} className="triage-btn"
                    onClick={() => { handler(); setShowMore(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", width: "100%", justifyContent: "flex-start", borderBottom: "1px solid #f0f0f0", padding: "12px 16px", fontSize: "14px", fontWeight: isTabActive(key) ? "600" : "400", color: isTabActive(key) ? "#0066cc" : "#444", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>{label}</span>
                    {badge !== undefined && <Badge count={badge} />}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}