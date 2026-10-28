import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { SYSTEM_VERSION, getSystemCopyright } from "../../config/version";

export default function PortalShell({
  clientName,
  clients = [],
  onSelectClient,
  activeView,
  onSelectView,
  user,
  onLogout,
  hasBudget = true,
  hasCash = true,
  setupStatus = null,
  onPreviewSetup = null,
  children
}) {
  const [openDropdown, setOpenDropdown] = useState(null); // 'perf' | 'cash' | 'keyData' | 'analysis' | 'user' | 'client' | null
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navigatingToPma, setNavigatingToPma] = useState(false);

  const isSeniorRestricted = Boolean(
    user?.isSenior ||
    user?.role === "Senior (Restricted)" ||
    String(user?.role || "").toLowerCase().includes("senior")
  );

  // Close dropdowns when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(e) {
      if (!e.target.closest(".portal-nav-dropdown")) {
        setOpenDropdown(null);
      }
    }
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setOpenDropdown(null);
        setMobileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const toggleDropdown = (name) => {
    setOpenDropdown(prev => (prev === name ? null : name));
  };

  const handleNavClick = (viewKey) => {
    onSelectView(viewKey);
    setOpenDropdown(null);
    setMobileMenuOpen(false);
  };

  const getPortalViewHref = (viewKey) => {
    const clientPart = clientName ? `client=${encodeURIComponent(clientName)}&` : "";
    if (viewKey === "month") {
      return clientName ? `/pulse?client=${encodeURIComponent(clientName)}` : "/pulse";
    }
    return `/pulse?${clientPart}view=${encodeURIComponent(viewKey)}`;
  };

  const handleLinkClick = (e, viewKey) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      handleNavClick(viewKey);
    }
  };

  const isViewInGroup = (views) => views.includes(activeView);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#ffffff",
        fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#1e293b",
        display: "flex",
        flexDirection: "column"
      }}
    >
      {/* Setup Mode Alert Banner for Internal Staff (Admin/ClientManager) */}
      {setupStatus?.setupMode && (
        <div
          style={{
            background: "#FFFBEB",
            borderBottom: "1px solid #FCD34D",
            color: "#92400E",
            padding: "8px 24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "13px",
            zIndex: 1001,
            flexWrap: "wrap",
            gap: "8px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: "600" }}>
            <span style={{ fontSize: "16px" }}>🛠️</span>
            <span>This client is currently in setup mode (financial data within Pulse is NOT visible to the client)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {onPreviewSetup && (
              <button
                type="button"
                onClick={onPreviewSetup}
                style={{
                  background: "#FEF3C7",
                  border: "1px solid #F59E0B",
                  color: "#92400E",
                  padding: "4px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                👁 Preview client setup screen
              </button>
            )}
            <Link
              href={`/triage?nav=setup&client=${encodeURIComponent(clientName || "")}`}
              style={{
                background: "#023f98",
                border: "none",
                color: "#FFFFFF",
                padding: "4px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-block"
              }}
            >
              Manage in PMA Setup →
            </Link>
          </div>
        </div>
      )}

      {/* Top Header Bar */}
      <header
        style={{
          background: "#0047AB",
          position: "sticky",
          top: 0,
          zIndex: 1000,
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.2)"
        }}
      >
        <div
          className="portal-header-bar-inner"
          style={{
            width: "100%",
            maxWidth: "1440px",
            margin: "0 auto",
            padding: "0.75rem 2rem",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem"
          }}
        >
          {/* Left Brand & Client Name (Stacked: Logo on top, Client Name underneath with reserved fixed height and equal flex basis to prevent layout jump) */}
          <div style={{ flex: "1 1 0%", display: "flex", flexDirection: "column", gap: "2px", alignItems: "flex-start", minWidth: 0 }}>
            <a
              href={getPortalViewHref("month")}
              onClick={(e) => handleLinkClick(e, "month")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                textDecoration: "none"
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/pulselogo-transparent.png"
                alt="Pulse"
                className="portal-brand-logo"
                style={{
                  height: "45px",
                  width: "auto",
                  display: "block"
                }}
              />
            </a>

            <div style={{ height: "20px", minHeight: "20px", display: "flex", alignItems: "center" }}>
              {clientName ? (
                <div
                  className="portal-nav-dropdown"
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    height: "20px",
                    animation: "portalFadeIn 0.22s ease-out"
                  }}
                >
                  <button
                    type="button"
                    disabled={clients.length <= 1}
                    onClick={() => {
                      if (clients.length > 1) toggleDropdown("client");
                    }}
                    style={{
                      background: openDropdown === "client" && clients.length > 1 ? "rgba(255, 255, 255, 0.1)" : "transparent",
                      border: clients.length > 1 ? "1px solid rgba(255, 255, 255, 0.28)" : "1px solid transparent",
                      borderRadius: "4px",
                      padding: clients.length > 1 ? "0 5px" : "0 2px",
                      height: "20px",
                      boxSizing: "border-box",
                      color: "#ffffff",
                      fontSize: "0.85rem",
                      fontWeight: 400,
                      letterSpacing: "0.2px",
                      lineHeight: "1.1",
                      cursor: clients.length > 1 ? "pointer" : "default",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: clients.length > 1 ? "4px" : "0px",
                      fontFamily: "inherit",
                      transition: "background 0.18s ease, border-color 0.22s ease, padding 0.22s ease, gap 0.22s ease"
                    }}
                    onMouseEnter={(e) => {
                      if (clients.length > 1) {
                        e.currentTarget.style.background = "rgba(255, 255, 255, 0.12)";
                        e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.45)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (clients.length > 1 && openDropdown !== "client") {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.28)";
                      }
                    }}
                    title={clients.length > 1 ? "Switch client" : undefined}
                  >
                    <span
                      className="portal-client-title"
                      style={{
                        color: "#ffffff",
                        fontSize: "0.85rem",
                        fontWeight: 400,
                        letterSpacing: "0.2px",
                        lineHeight: "1.1"
                      }}
                    >
                      {clientName}
                    </span>
                    <span
                      style={{
                        fontSize: "9px",
                        opacity: clients.length > 1 ? 0.75 : 0,
                        maxWidth: clients.length > 1 ? "12px" : "0px",
                        overflow: "hidden",
                        lineHeight: 1,
                        userSelect: "none",
                        transition: "opacity 0.22s ease, max-width 0.22s ease"
                      }}
                    >
                      ▾
                    </span>
                  </button>

                  {openDropdown === "client" && clients.length > 1 && (
                    <div
                      style={{
                        ...dropdownMenuStyle,
                        left: 0,
                        right: "auto",
                        top: "calc(100% + 4px)",
                        maxHeight: "360px",
                        overflowY: "auto",
                        minWidth: "200px",
                        zIndex: 1100
                      }}
                    >
                      <div
                        style={{
                          padding: "0.5rem 0.85rem",
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#64748b",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          borderBottom: "1px solid #e2e8f0"
                        }}
                      >
                        Switch Client
                      </div>
                      {clients.map((c) => (
                        <a
                          key={c.clientName}
                          href={`/pulse?client=${encodeURIComponent(c.clientName)}&view=${encodeURIComponent(activeView || "month")}`}
                          onClick={(e) => {
                            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
                              e.preventDefault();
                              onSelectClient(c);
                              setOpenDropdown(null);
                            }
                          }}
                          style={{
                            ...dropdownItemStyle(c.clientName === clientName),
                            textDecoration: "none",
                            display: "block",
                            boxSizing: "border-box"
                          }}
                        >
                          {c.clientName}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* Desktop Navigation Tabs */}
          <nav
            className="portal-desktop-nav"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem"
            }}
          >
            {/* 1. Home / Month */}
            <a
              href={getPortalViewHref("month")}
              onClick={(e) => handleLinkClick(e, "month")}
              style={{
                padding: "0.5rem 0.95rem",
                borderRadius: "6px",
                border: "none",
                cursor: "pointer",
                fontSize: "15px",
                fontWeight: activeView === "month" ? 700 : 500,
                background: activeView === "month" ? "#ffffff" : "transparent",
                color: activeView === "month" ? "#0047AB" : "#ffffff",
                transition: "all 0.15s ease",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center"
              }}
            >
              Home
            </a>

            {/* 2. Performance Dropdown */}
            <div className="portal-nav-dropdown" style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => toggleDropdown("perf")}
                style={{
                  padding: "0.5rem 0.95rem",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: isViewInGroup(["dashboard", "ytd", "perfBreakdown"]) ? 700 : 500,
                  background: isViewInGroup(["dashboard", "ytd", "perfBreakdown"]) ? "#ffffff" : "transparent",
                  color: isViewInGroup(["dashboard", "ytd", "perfBreakdown"]) ? "#0047AB" : "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "all 0.15s ease"
                }}
              >
                <span>Performance</span>
                <span style={{ fontSize: "11px", opacity: 0.8 }}>▾</span>
              </button>

              {openDropdown === "perf" && (
                <div style={dropdownMenuStyle}>
                  <a
                    href={getPortalViewHref("dashboard")}
                    onClick={(e) => handleLinkClick(e, "dashboard")}
                    style={dropdownItemStyle(activeView === "dashboard")}
                  >
                    Financial year
                  </a>
                  <a
                    href={getPortalViewHref("ytd")}
                    onClick={(e) => handleLinkClick(e, "ytd")}
                    style={dropdownItemStyle(activeView === "ytd")}
                  >
                    Year-to-date
                  </a>
                  <a
                    href={getPortalViewHref("perfBreakdown")}
                    onClick={(e) => handleLinkClick(e, "perfBreakdown")}
                    style={dropdownItemStyle(activeView === "perfBreakdown")}
                  >
                    Breakdowns
                  </a>
                </div>
              )}
            </div>

            {/* 3. Cash Dropdown (present by default; smoothly fades and collapses if client does not have Cash enabled) */}
            <div
              className="portal-nav-dropdown"
              style={{
                position: "relative",
                maxWidth: hasCash ? "100px" : "0px",
                opacity: hasCash ? 1 : 0,
                marginRight: hasCash ? "0px" : "-0.4rem",
                transform: hasCash ? "scale(1)" : "scale(0.95)",
                overflow: openDropdown === "cash" && hasCash ? "visible" : "hidden",
                pointerEvents: hasCash ? "auto" : "none",
                transition: "max-width 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.18s ease, margin-right 0.22s cubic-bezier(0.4, 0, 0.2, 1), transform 0.18s ease"
              }}
              aria-hidden={!hasCash}
            >
              <button
                type="button"
                tabIndex={hasCash ? 0 : -1}
                onClick={() => {
                  if (hasCash) toggleDropdown("cash");
                }}
                style={{
                  padding: "0.5rem 0.95rem",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: isViewInGroup(["cash", "cashBreakdown"]) ? 700 : 500,
                  background: isViewInGroup(["cash", "cashBreakdown"]) ? "#ffffff" : "transparent",
                  color: isViewInGroup(["cash", "cashBreakdown"]) ? "#0047AB" : "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s ease"
                }}
              >
                <span>Cash</span>
                <span style={{ fontSize: "11px", opacity: 0.8 }}>▾</span>
              </button>

              {openDropdown === "cash" && hasCash && (
                <div style={dropdownMenuStyle}>
                  <a
                    href={getPortalViewHref("cash")}
                    onClick={(e) => handleLinkClick(e, "cash")}
                    style={dropdownItemStyle(activeView === "cash")}
                  >
                    Cashflow forecast
                  </a>
                  <a
                    href={getPortalViewHref("cashBreakdown")}
                    onClick={(e) => handleLinkClick(e, "cashBreakdown")}
                    style={dropdownItemStyle(activeView === "cashBreakdown")}
                  >
                    Breakdowns
                  </a>
                </div>
              )}
            </div>

            {/* 4. Key Data Dropdown */}
            <div className="portal-nav-dropdown" style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => toggleDropdown("keyData")}
                style={{
                  padding: "0.5rem 0.95rem",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: isViewInGroup(["jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind"]) ? 700 : 500,
                  background: isViewInGroup(["jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind"]) ? "#ffffff" : "transparent",
                  color: isViewInGroup(["jobs", "contractors", "expenses", "salaries", "dividends", "nbtofind"]) ? "#0047AB" : "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "all 0.15s ease"
                }}
              >
                <span>Key data</span>
                <span style={{ fontSize: "11px", opacity: 0.8 }}>▾</span>
              </button>

              {openDropdown === "keyData" && (
                <div style={dropdownMenuStyle}>
                  <a
                    href={getPortalViewHref("jobs")}
                    onClick={(e) => handleLinkClick(e, "jobs")}
                    style={dropdownItemStyle(activeView === "jobs")}
                  >
                    Jobs
                  </a>
                  <a
                    href={getPortalViewHref("contractors")}
                    onClick={(e) => handleLinkClick(e, "contractors")}
                    style={dropdownItemStyle(activeView === "contractors")}
                  >
                    Contractors
                  </a>
                  <a
                    href={getPortalViewHref("expenses")}
                    onClick={(e) => handleLinkClick(e, "expenses")}
                    style={dropdownItemStyle(activeView === "expenses")}
                  >
                    Expenses
                  </a>
                  {!isSeniorRestricted && (
                    <>
                      <a
                        href={getPortalViewHref("salaries")}
                        onClick={(e) => handleLinkClick(e, "salaries")}
                        style={dropdownItemStyle(activeView === "salaries")}
                      >
                        Salaries
                      </a>
                      <a
                        href={getPortalViewHref("dividends")}
                        onClick={(e) => handleLinkClick(e, "dividends")}
                        style={dropdownItemStyle(activeView === "dividends")}
                      >
                        Dividends
                      </a>
                    </>
                  )}
                  <a
                    href={getPortalViewHref("nbtofind")}
                    onClick={(e) => handleLinkClick(e, "nbtofind")}
                    style={dropdownItemStyle(activeView === "nbtofind")}
                  >
                    New business to find
                  </a>
                </div>
              )}
            </div>

            {/* 5. Analysis Dropdown */}
            <div className="portal-nav-dropdown" style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => toggleDropdown("analysis")}
                style={{
                  padding: "0.5rem 0.95rem",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "15px",
                  fontWeight: isViewInGroup(["scenarios", "viewBudget", "budgetVariance"]) ? 700 : 500,
                  background: isViewInGroup(["scenarios", "viewBudget", "budgetVariance"]) ? "#ffffff" : "transparent",
                  color: isViewInGroup(["scenarios", "viewBudget", "budgetVariance"]) ? "#0047AB" : "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "all 0.15s ease"
                }}
              >
                <span>Analysis</span>
                <span style={{ fontSize: "11px", opacity: 0.8 }}>▾</span>
              </button>

              {openDropdown === "analysis" && (
                <div style={dropdownMenuStyle}>
                  <a
                    href={getPortalViewHref("scenarios")}
                    onClick={(e) => handleLinkClick(e, "scenarios")}
                    style={dropdownItemStyle(activeView === "scenarios")}
                  >
                    Scenarios
                  </a>
                  {hasBudget && (
                    <>
                      <div style={{ borderBottom: "1px solid #e2e8f0", margin: "4px 0" }} />
                      <div
                        style={{
                          padding: "0.4rem 1rem",
                          fontSize: "0.8rem",
                          color: "#64748b",
                          fontStyle: "italic",
                          pointerEvents: "none"
                        }}
                      >
                        Budget
                      </div>
                      <a
                        href={getPortalViewHref("viewBudget")}
                        onClick={(e) => handleLinkClick(e, "viewBudget")}
                        style={dropdownItemStyle(activeView === "viewBudget")}
                      >
                        View budget
                      </a>
                      <a
                        href={getPortalViewHref("budgetVariance")}
                        onClick={(e) => handleLinkClick(e, "budgetVariance")}
                        style={dropdownItemStyle(activeView === "budgetVariance")}
                      >
                        Budget variance analysis
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          </nav>

          {/* Right Header Utilities: User Account & Mobile Toggle */}
          <div style={{ flex: "1 1 0%", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem" }}>

            {/* Read-Only Badge if logged in with OTP */}
            {user?.isReadOnly && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 10px",
                  borderRadius: "20px",
                  fontSize: "12px",
                  fontWeight: 600,
                  background: "rgba(255, 255, 255, 0.16)",
                  color: "#ffffff",
                  border: "1px solid rgba(255, 255, 255, 0.3)",
                  letterSpacing: "0.2px",
                  userSelect: "none"
                }}
                title="Logged in with one-time password (read-only mode)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Read-only</span>
              </div>
            )}

            {/* User Profile / Menu */}
            <div className="portal-nav-dropdown" style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => toggleDropdown("user")}
                style={{
                  background: "rgba(255, 255, 255, 0.15)",
                  border: "1px solid rgba(255, 255, 255, 0.25)",
                  color: "#ffffff",
                  width: "36px",
                  height: "36px",
                  borderRadius: "50%",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: "14px",
                  transition: "background 0.15s"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.25)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255, 255, 255, 0.15)"; }}
                title={user?.email || "Account"}
              >
                {(user?.name || user?.email || "U")[0].toUpperCase()}
              </button>

              {/* Exclamation badge if any configured connection needs renewing */}
              {setupStatus?.hasDisconnectedTools && (
                <span
                  style={{
                    position: "absolute",
                    top: "-2px",
                    right: "-2px",
                    width: "15px",
                    height: "15px",
                    borderRadius: "50%",
                    background: "#ef4444",
                    color: "#ffffff",
                    fontSize: "10.5px",
                    fontWeight: 800,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "2px solid #0047AB",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                    lineHeight: 1,
                    pointerEvents: "none"
                  }}
                  title="One or more tool connections need renewing"
                >
                  !
                </span>
              )}

              {openDropdown === "user" && (
                <div
                  style={{
                    ...dropdownMenuStyle,
                    right: 0,
                    left: "auto",
                    minWidth: "240px",
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
                    {user?.isReadOnly && (
                      <div
                        style={{
                          fontSize: "11px",
                          color: "#b45309",
                          background: "#fef3c7",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          display: "inline-block",
                          marginTop: "5px",
                          fontWeight: 600
                        }}
                      >
                        Read-only (OTP login)
                      </div>
                    )}
                  </div>

                  {/* Connected Tools Status Section */}
                  {setupStatus?.configuredTools && setupStatus.configuredTools.length > 0 && (
                    <div style={{ padding: "0.6rem 1rem", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
                      <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
                        Tool connections
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {setupStatus.configuredTools.map((t) => (
                          <div key={t.tool} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                              <span
                                style={{
                                  width: "8px",
                                  height: "8px",
                                  borderRadius: "50%",
                                  background: t.connected && !t.needsReconnect ? "#10b981" : "#ef4444",
                                  boxShadow: t.connected && !t.needsReconnect ? "0 0 0 2px rgba(16, 185, 129, 0.2)" : "0 0 0 2px rgba(239, 68, 68, 0.2)",
                                  display: "inline-block",
                                  flexShrink: 0
                                }}
                              />
                              <span style={{ fontSize: "13px", fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {t.name}
                              </span>
                              {t.connected && !t.needsReconnect && (
                                <span style={{ fontSize: "11px", color: "#10b981", fontWeight: 500 }}>
                                  (Connected)
                                </span>
                              )}
                            </div>

                            {(!t.connected || t.needsReconnect) && (
                              <button
                                type="button"
                                onClick={() => {
                                  const connectUrl = `/api/integrations/${encodeURIComponent(t.tool)}/connect?clientName=${encodeURIComponent(clientName)}&redirectBack=${encodeURIComponent("/pulse")}`;
                                  window.location.href = connectUrl;
                                }}
                                style={{
                                  background: t.needsReconnect ? "#fee2e2" : "#eff6ff",
                                  color: t.needsReconnect ? "#b91c1c" : "#1d4ed8",
                                  border: t.needsReconnect ? "1px solid #fca5a5" : "1px solid #bfdbfe",
                                  borderRadius: "4px",
                                  padding: "2px 8px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  cursor: "pointer",
                                  whiteSpace: "nowrap",
                                  transition: "all 0.15s ease"
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = t.needsReconnect ? "#ef4444" : "#2563eb";
                                  e.currentTarget.style.color = "#ffffff";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = t.needsReconnect ? "#fee2e2" : "#eff6ff";
                                  e.currentTarget.style.color = t.needsReconnect ? "#b91c1c" : "#1d4ed8";
                                }}
                                title={t.needsReconnect ? `Re-connect ${t.name}` : `Connect ${t.name}`}
                              >
                                {t.needsReconnect ? "Re-connect" : "Connect"}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* If user is Admin or ClientManager, offer direct link back to Management Area (PMA) */}
                  {(user?.isAdmin || user?.role === "ClientManager") && (
                    <Link
                      href="/pma"
                      onClick={() => setNavigatingToPma(true)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "0.65rem 1rem",
                        color: "#0047AB",
                        background: navigatingToPma ? "rgba(0, 71, 171, 0.08)" : "transparent",
                        textDecoration: "none",
                        fontSize: "14px",
                        fontWeight: 600,
                        borderBottom: "1px solid #e2e8f0",
                        pointerEvents: navigatingToPma ? "none" : "auto",
                        transition: "background 0.15s ease"
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0, 71, 171, 0.08)"; }}
                      onMouseLeave={(e) => {
                        if (!navigatingToPma) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {navigatingToPma ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#0047AB"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          style={{ animation: "portalSpin 0.7s linear infinite", flexShrink: 0 }}
                        >
                          <path d="M12 2a10 10 0 0 1 10 10" />
                        </svg>
                      ) : (
                        <span>←</span>
                      )}
                      <span>Pulse Management Area</span>
                    </Link>
                  )}

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

                  <button
                    type="button"
                    onClick={onLogout}
                    style={{
                      ...dropdownItemStyle(false),
                      color: "#ef4444",
                      fontWeight: 600,
                      borderTop: "1px solid #e2e8f0"
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "#fee2e2"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>

            {/* Mobile Hamburger Menu Button */}
            <button
              type="button"
              className="portal-mobile-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              style={{
                background: "none",
                border: "none",
                color: "#ffffff",
                fontSize: "24px",
                cursor: "pointer",
                padding: "4px"
              }}
            >
              ☰
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Navigation Overlay */}
      {mobileMenuOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.45)",
            backdropFilter: "blur(2px)",
            zIndex: 10001,
            display: "flex",
            justifyContent: "flex-end"
          }}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            style={{
              width: "82%",
              maxWidth: "320px",
              height: "100%",
              background: "#0047AB",
              padding: "1.5rem 1.25rem",
              color: "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: "1.1rem",
              overflowY: "auto",
              boxShadow: "-4px 0 25px rgba(0, 0, 0, 0.3)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255, 255, 255, 0.15)", paddingBottom: "0.75rem" }}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>Menu</span>
                {clientName && (
                  <span style={{ fontSize: "0.8rem", color: "rgba(255, 255, 255, 0.75)" }}>{clientName}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#ffffff",
                  fontSize: "24px",
                  cursor: "pointer",
                  padding: "4px"
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>

              <a
                href={getPortalViewHref("month")}
                onClick={(e) => handleLinkClick(e, "month")}
                style={mobileNavItemStyle(activeView === "month")}
              >
                Home
              </a>

              <div style={mobileSectionHeaderStyle}>Performance</div>
              <a href={getPortalViewHref("dashboard")} onClick={(e) => handleLinkClick(e, "dashboard")} style={mobileSubItemStyle(activeView === "dashboard")}>
                Financial year
              </a>
              <a href={getPortalViewHref("ytd")} onClick={(e) => handleLinkClick(e, "ytd")} style={mobileSubItemStyle(activeView === "ytd")}>
                Year-to-date
              </a>
              <a href={getPortalViewHref("perfBreakdown")} onClick={(e) => handleLinkClick(e, "perfBreakdown")} style={mobileSubItemStyle(activeView === "perfBreakdown")}>
                Breakdowns
              </a>

              {hasCash && (
                <>
                  <div style={mobileSectionHeaderStyle}>Cash</div>
                  <a href={getPortalViewHref("cash")} onClick={(e) => handleLinkClick(e, "cash")} style={mobileSubItemStyle(activeView === "cash")}>
                    Cashflow forecast
                  </a>
                  <a href={getPortalViewHref("cashBreakdown")} onClick={(e) => handleLinkClick(e, "cashBreakdown")} style={mobileSubItemStyle(activeView === "cashBreakdown")}>
                    Breakdowns
                  </a>
                </>
              )}

              <div style={mobileSectionHeaderStyle}>Key data</div>
              <a href={getPortalViewHref("jobs")} onClick={(e) => handleLinkClick(e, "jobs")} style={mobileSubItemStyle(activeView === "jobs")}>
                Jobs
              </a>
              <a href={getPortalViewHref("contractors")} onClick={(e) => handleLinkClick(e, "contractors")} style={mobileSubItemStyle(activeView === "contractors")}>
                Contractors
              </a>
              <a href={getPortalViewHref("expenses")} onClick={(e) => handleLinkClick(e, "expenses")} style={mobileSubItemStyle(activeView === "expenses")}>
                Expenses
              </a>
              {!isSeniorRestricted && (
                <>
                  <a href={getPortalViewHref("salaries")} onClick={(e) => handleLinkClick(e, "salaries")} style={mobileSubItemStyle(activeView === "salaries")}>
                    Salaries
                  </a>
                  <a href={getPortalViewHref("dividends")} onClick={(e) => handleLinkClick(e, "dividends")} style={mobileSubItemStyle(activeView === "dividends")}>
                    Dividends
                  </a>
                </>
              )}
              <a href={getPortalViewHref("nbtofind")} onClick={(e) => handleLinkClick(e, "nbtofind")} style={mobileSubItemStyle(activeView === "nbtofind")}>
                New business to find
              </a>

              <div style={mobileSectionHeaderStyle}>Analysis</div>
              <a href={getPortalViewHref("scenarios")} onClick={(e) => handleLinkClick(e, "scenarios")} style={mobileSubItemStyle(activeView === "scenarios")}>
                Scenarios
              </a>
              {hasBudget && (
                <>
                  <a href={getPortalViewHref("viewBudget")} onClick={(e) => handleLinkClick(e, "viewBudget")} style={mobileSubItemStyle(activeView === "viewBudget")}>
                    View budget
                  </a>
                  <a href={getPortalViewHref("budgetVariance")} onClick={(e) => handleLinkClick(e, "budgetVariance")} style={mobileSubItemStyle(activeView === "budgetVariance")}>
                    Budget variance
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main style={{ flex: 1, width: "100%", padding: 0 }}>
        <div className="portal-main-content-wrapper" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "1.5rem 2rem", boxSizing: "border-box" }}>
          {children}
        </div>
      </main>

      {/* Responsive Styles Injection */}
      <style jsx global>{`
        @keyframes portalFadeIn {
          from {
            opacity: 0;
            transform: translateY(-1px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes portalContentFadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .portal-main-content-wrapper > *:not([data-pulse-skeleton="true"]) {
          animation: portalContentFadeIn 0.22s ease-out;
        }
        @keyframes portalSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        @media (max-width: 900px) {
          .portal-desktop-nav {
            display: none !important;
          }
          .portal-mobile-toggle {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
          }
        }
        @media (min-width: 901px) {
          .portal-mobile-toggle {
            display: none !important;
          }
        }
        @media (max-width: 768px) {
          .portal-header-bar-inner {
            padding: 0.5rem 0.85rem !important;
            gap: 0.5rem !important;
          }
          .portal-brand-logo {
            height: 40px !important;
          }
          .portal-client-title {
            max-width: 200px !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            font-size: 0.8rem !important;
          }
          .portal-main-content-wrapper {
            padding: 0.75rem 0.5rem !important;
          }
        }
        @media (orientation: landscape) and (max-height: 520px), (orientation: landscape) and (max-width: 1024px) {
          .portal-header-bar-inner {
            padding-left: max(2.5rem, calc(env(safe-area-inset-left, 0px) + 1.25rem)) !important;
            padding-right: max(2.5rem, calc(env(safe-area-inset-right, 0px) + 1.25rem)) !important;
          }
          .portal-main-content-wrapper {
            padding-left: max(2.5rem, calc(env(safe-area-inset-left, 0px) + 1.25rem)) !important;
            padding-right: max(2.5rem, calc(env(safe-area-inset-right, 0px) + 1.25rem)) !important;
          }
        }
      `}</style>
    </div>
  );
}

const dropdownMenuStyle = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15)",
  display: "flex",
  flexDirection: "column",
  minWidth: "190px",
  zIndex: 1100,
  overflow: "hidden"
};

const dropdownItemStyle = (isActive) => ({
  textAlign: "left",
  padding: "0.65rem 1rem",
  border: "none",
  background: isActive ? "#0047AB" : "transparent",
  color: isActive ? "#ffffff" : "#0047AB",
  fontSize: "14px",
  fontWeight: isActive ? 700 : 500,
  cursor: "pointer",
  transition: "background 0.15s ease",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  textDecoration: "none",
  display: "block",
  boxSizing: "border-box"
});

const mobileNavItemStyle = (isActive) => ({
  background: isActive ? "#ffffff" : "rgba(255, 255, 255, 0.12)",
  color: isActive ? "#0047AB" : "#ffffff",
  border: "none",
  padding: "0.75rem 1rem",
  borderRadius: "6px",
  fontSize: "16px",
  fontWeight: 700,
  textAlign: "left",
  cursor: "pointer",
  textDecoration: "none",
  display: "block",
  boxSizing: "border-box"
});

const mobileSectionHeaderStyle = {
  fontSize: "12px",
  fontWeight: 700,
  color: "rgba(255, 255, 255, 0.6)",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginTop: "8px"
};

const mobileSubItemStyle = (isActive) => ({
  background: isActive ? "#ffffff" : "transparent",
  color: isActive ? "#0047AB" : "#ffffff",
  border: "none",
  padding: "0.6rem 1rem",
  borderRadius: "6px",
  fontSize: "15px",
  fontWeight: isActive ? 700 : 500,
  textAlign: "left",
  cursor: "pointer",
  textDecoration: "none",
  display: "block",
  boxSizing: "border-box"
});
