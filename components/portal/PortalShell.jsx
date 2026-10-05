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
  hasCash = false,
  children
}) {
  const [openDropdown, setOpenDropdown] = useState(null); // 'perf' | 'cash' | 'keyData' | 'analysis' | 'user' | 'client' | null
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
          {/* Left Brand & Client Name (Stacked: Logo on top, Client Name underneath) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "2px", alignItems: "flex-start", minWidth: 0 }}>
            <button
              type="button"
              onClick={() => handleNavClick("month")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center"
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
            </button>

            {clientName && (
              clients.length > 1 ? (
                <div className="portal-nav-dropdown" style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => toggleDropdown("client")}
                    style={{
                      background: openDropdown === "client" ? "rgba(255, 255, 255, 0.1)" : "transparent",
                      border: "1px solid rgba(255, 255, 255, 0.28)",
                      borderRadius: "4px",
                      padding: "1px 5px",
                      color: "#ffffff",
                      fontSize: "0.85rem",
                      fontWeight: 400,
                      letterSpacing: "0.2px",
                      lineHeight: "1.1",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      fontFamily: "inherit",
                      transition: "background 0.15s, border-color 0.15s"
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(255, 255, 255, 0.12)";
                      e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.45)";
                    }}
                    onMouseLeave={(e) => {
                      if (openDropdown !== "client") {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.28)";
                      }
                    }}
                    title="Switch client"
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
                    <span style={{ fontSize: "9px", opacity: 0.75, lineHeight: 1, userSelect: "none" }}>▾</span>
                  </button>

                  {openDropdown === "client" && (
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
                        <button
                          key={c.clientName}
                          type="button"
                          onClick={() => {
                            onSelectClient(c);
                            setOpenDropdown(null);
                          }}
                          style={dropdownItemStyle(c.clientName === clientName)}
                        >
                          {c.clientName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span
                  className="portal-client-title"
                  style={{
                    color: "#ffffff",
                    fontSize: "0.85rem",
                    fontWeight: 400,
                    letterSpacing: "0.2px",
                    lineHeight: "1.1",
                    paddingLeft: "2px"
                  }}
                >
                  {clientName}
                </span>
              )
            )}
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
            <button
              type="button"
              onClick={() => handleNavClick("month")}
              style={{
                padding: "0.5rem 0.95rem",
                borderRadius: "6px",
                border: "none",
                cursor: "pointer",
                fontSize: "15px",
                fontWeight: activeView === "month" ? 700 : 500,
                background: activeView === "month" ? "#ffffff" : "transparent",
                color: activeView === "month" ? "#0047AB" : "#ffffff",
                transition: "all 0.15s ease"
              }}
            >
              Home
            </button>

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
                  <button
                    type="button"
                    onClick={() => handleNavClick("dashboard")}
                    style={dropdownItemStyle(activeView === "dashboard")}
                  >
                    Financial year
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick("ytd")}
                    style={dropdownItemStyle(activeView === "ytd")}
                  >
                    Year-to-date
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick("perfBreakdown")}
                    style={dropdownItemStyle(activeView === "perfBreakdown")}
                  >
                    Breakdowns
                  </button>
                </div>
              )}
            </div>

            {/* 3. Cash Dropdown */}
            {hasCash && (
              <div className="portal-nav-dropdown" style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => toggleDropdown("cash")}
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
                    transition: "all 0.15s ease"
                  }}
                >
                  <span>Cash</span>
                  <span style={{ fontSize: "11px", opacity: 0.8 }}>▾</span>
                </button>

                {openDropdown === "cash" && (
                  <div style={dropdownMenuStyle}>
                    <button
                      type="button"
                      onClick={() => handleNavClick("cash")}
                      style={dropdownItemStyle(activeView === "cash")}
                    >
                      Cashflow forecast
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNavClick("cashBreakdown")}
                      style={dropdownItemStyle(activeView === "cashBreakdown")}
                    >
                      Breakdowns
                    </button>
                  </div>
                )}
              </div>
            )}

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
                  <button
                    type="button"
                    onClick={() => handleNavClick("jobs")}
                    style={dropdownItemStyle(activeView === "jobs")}
                  >
                    Jobs
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick("contractors")}
                    style={dropdownItemStyle(activeView === "contractors")}
                  >
                    Contractors
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNavClick("expenses")}
                    style={dropdownItemStyle(activeView === "expenses")}
                  >
                    Expenses
                  </button>
                  {!isSeniorRestricted && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleNavClick("salaries")}
                        style={dropdownItemStyle(activeView === "salaries")}
                      >
                        Salaries
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNavClick("dividends")}
                        style={dropdownItemStyle(activeView === "dividends")}
                      >
                        Dividends
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleNavClick("nbtofind")}
                    style={dropdownItemStyle(activeView === "nbtofind")}
                  >
                    New business to find
                  </button>
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
                  <button
                    type="button"
                    onClick={() => handleNavClick("scenarios")}
                    style={dropdownItemStyle(activeView === "scenarios")}
                  >
                    Scenarios
                  </button>
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
                      <button
                        type="button"
                        onClick={() => handleNavClick("viewBudget")}
                        style={dropdownItemStyle(activeView === "viewBudget")}
                      >
                        View budget
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNavClick("budgetVariance")}
                        style={dropdownItemStyle(activeView === "budgetVariance")}
                      >
                        Budget variance analysis
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </nav>

          {/* Right Header Utilities: User Account & Mobile Toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>

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

              {openDropdown === "user" && (
                <div
                  style={{
                    ...dropdownMenuStyle,
                    right: 0,
                    left: "auto",
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

                  {/* If user is Admin or ClientManager, offer direct link back to Management Area (PMA) */}
                  {(user?.isAdmin || user?.role === "ClientManager") && (
                    <Link
                      href="/PMA"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "0.65rem 1rem",
                        color: "#0047AB",
                        textDecoration: "none",
                        fontSize: "14px",
                        fontWeight: 600,
                        borderBottom: "1px solid #e2e8f0"
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0, 71, 171, 0.08)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span>←</span>
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

              <button
                type="button"
                onClick={() => handleNavClick("month")}
                style={mobileNavItemStyle(activeView === "month")}
              >
                Home
              </button>

              <div style={mobileSectionHeaderStyle}>Performance</div>
              <button type="button" onClick={() => handleNavClick("dashboard")} style={mobileSubItemStyle(activeView === "dashboard")}>
                Financial year
              </button>
              <button type="button" onClick={() => handleNavClick("ytd")} style={mobileSubItemStyle(activeView === "ytd")}>
                Year-to-date
              </button>
              <button type="button" onClick={() => handleNavClick("perfBreakdown")} style={mobileSubItemStyle(activeView === "perfBreakdown")}>
                Breakdowns
              </button>

              {hasCash && (
                <>
                  <div style={mobileSectionHeaderStyle}>Cash</div>
                  <button type="button" onClick={() => handleNavClick("cash")} style={mobileSubItemStyle(activeView === "cash")}>
                    Cashflow forecast
                  </button>
                  <button type="button" onClick={() => handleNavClick("cashBreakdown")} style={mobileSubItemStyle(activeView === "cashBreakdown")}>
                    Breakdowns
                  </button>
                </>
              )}

              <div style={mobileSectionHeaderStyle}>Key data</div>
              <button type="button" onClick={() => handleNavClick("jobs")} style={mobileSubItemStyle(activeView === "jobs")}>
                Jobs
              </button>
              <button type="button" onClick={() => handleNavClick("contractors")} style={mobileSubItemStyle(activeView === "contractors")}>
                Contractors
              </button>
              <button type="button" onClick={() => handleNavClick("expenses")} style={mobileSubItemStyle(activeView === "expenses")}>
                Expenses
              </button>
              {!isSeniorRestricted && (
                <>
                  <button type="button" onClick={() => handleNavClick("salaries")} style={mobileSubItemStyle(activeView === "salaries")}>
                    Salaries
                  </button>
                  <button type="button" onClick={() => handleNavClick("dividends")} style={mobileSubItemStyle(activeView === "dividends")}>
                    Dividends
                  </button>
                </>
              )}
              <button type="button" onClick={() => handleNavClick("nbtofind")} style={mobileSubItemStyle(activeView === "nbtofind")}>
                New business to find
              </button>

              <div style={mobileSectionHeaderStyle}>Analysis</div>
              <button type="button" onClick={() => handleNavClick("scenarios")} style={mobileSubItemStyle(activeView === "scenarios")}>
                Scenarios
              </button>
              {hasBudget && (
                <>
                  <button type="button" onClick={() => handleNavClick("viewBudget")} style={mobileSubItemStyle(activeView === "viewBudget")}>
                    View budget
                  </button>
                  <button type="button" onClick={() => handleNavClick("budgetVariance")} style={mobileSubItemStyle(activeView === "budgetVariance")}>
                    Budget variance
                  </button>
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
  whiteSpace: "nowrap"
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
  cursor: "pointer"
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
  cursor: "pointer"
});
