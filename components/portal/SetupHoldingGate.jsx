import React, { useState, useEffect } from "react";
import Head from "next/head";
import Link from "next/link";
import { SYSTEM_VERSION, getSystemCopyright } from "../../config/version";

export default function SetupHoldingGate({
  clientName,
  user,
  setupStatus,
  onLogout,
  isPreview = false,
  onExitPreview = null,
  oauthFeedback = null
}) {
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);

  // Close profile dropdown when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(e) {
      if (!e.target.closest(".portal-nav-dropdown")) {
        setProfileDropdownOpen(false);
      }
    }
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        setProfileDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const {
    requestConnections = false,
    requiredTools = [],
    unconnectedTools = [],
    connectedTools = [],
    allToolsConnected = false
  } = setupStatus || {};

  // Determine view mode
  let viewMode = "holding";
  if (requestConnections) {
    viewMode = allToolsConnected ? "completed" : "connect";
  }

  const getToolDisplayName = (tool) => {
    const map = {
      xero: "Xero",
      quickbooks: "QuickBooks Online",
      clickup: "ClickUp",
      close: "Close CRM",
      capsule: "Capsule CRM",
      hubspot: "HubSpot",
      monday: "Monday.com",
      pipedrive: "Pipedrive"
    };
    return map[String(tool).toLowerCase()] || tool;
  };

  const getToolButtonColor = (tool) => {
    const t = String(tool).toLowerCase();
    if (t === "xero") return { bg: "#00b4d8", hover: "#0096c7" };
    if (t === "quickbooks") return { bg: "#2ca01c", hover: "#238016" };
    if (t === "hubspot") return { bg: "#ff7a59", hover: "#e66040" };
    if (t === "clickup") return { bg: "#7b68ee", hover: "#6952dc" };
    if (t === "monday") return { bg: "#ff3d57", hover: "#e0263f" };
    if (t === "pipedrive") return { bg: "#26292c", hover: "#121415" };
    if (t === "close") return { bg: "#1f3b58", hover: "#13283c" };
    if (t === "capsule") return { bg: "#1e3a8a", hover: "#172554" };
    return { bg: "#0047AB", hover: "#003b8e" };
  };

  const handleConnect = (tool) => {
    const provider = String(tool).toLowerCase();
    const connectUrl = `/api/integrations/${encodeURIComponent(provider)}/connect?clientName=${encodeURIComponent(clientName)}&redirectBack=${encodeURIComponent("/pulse")}`;
    window.location.href = connectUrl;
  };

  const dropdownMenuStyle = {
    position: "absolute",
    top: "calc(100% + 8px)",
    background: "#ffffff",
    borderRadius: "8px",
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.15)",
    border: "1px solid #cbd5e1",
    zIndex: 1000,
    overflow: "hidden"
  };

  const dropdownItemStyle = {
    width: "100%",
    padding: "0.6rem 1rem",
    textAlign: "left",
    background: "none",
    border: "none",
    fontSize: "14px",
    cursor: "pointer",
    display: "block",
    color: "#334155",
    fontFamily: "inherit",
    transition: "background 0.15s"
  };

  return (
    <>
      <Head>
        <title>{clientName ? `Pulse - ${clientName}` : "Pulse"}</title>
      </Head>

      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#F8FAFC",
          fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          color: "#1E293B"
        }}
      >
        {/* Preview Banner for Staff */}
        {isPreview && (
          <div
            style={{
              background: "#1E293B",
              color: "#F8FAFC",
              padding: "10px 24px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "13px",
              boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
              zIndex: 1001
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>👁️</span>
              <span style={{ fontWeight: 600 }}>
                Setup Mode Preview — Viewing as {user?.role || "Staff"} for {clientName}
              </span>
            </div>
            {onExitPreview && (
              <button
                type="button"
                onClick={onExitPreview}
                style={{
                  background: "#334155",
                  border: "1px solid #475569",
                  color: "#FFFFFF",
                  padding: "4px 12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                Exit preview & open dashboard
              </button>
            )}
          </div>
        )}

        {/* Standard Cobalt Blue Header - Exactly Matching Pulse */}
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
              <div style={{ display: "flex", alignItems: "center" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/pulselogo-transparent.png"
                  alt="Pulse"
                  style={{
                    height: "45px",
                    width: "auto",
                    display: "block"
                  }}
                />
              </div>

              {clientName && (
                <span
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
              )}
            </div>

            {/* Right: User Profile Menu (Standard Pulse Profile Circle) */}
            <div className="portal-nav-dropdown" style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setProfileDropdownOpen((v) => !v)}
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

              {profileDropdownOpen && (
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
                      ...dropdownItemStyle,
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
          </div>
        </header>

        {/* Main Content Area */}
        <main
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "40px 20px"
          }}
        >
          <div
            style={{
              maxWidth: "560px",
              width: "100%",
              background: "#FFFFFF",
              borderRadius: "16px",
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.06), 0 8px 10px -6px rgba(0, 0, 0, 0.04)",
              border: "1px solid #E2E8F0",
              padding: "44px 36px",
              textAlign: "center"
            }}
          >
            {/* OAuth Feedback Notice if returned with error or status */}
            {oauthFeedback && (
              <div
                style={{
                  marginBottom: "24px",
                  padding: "12px 16px",
                  borderRadius: "8px",
                  fontSize: "13px",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  background: oauthFeedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
                  border: `1px solid ${oauthFeedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
                  color: oauthFeedback.type === "success" ? "#065F46" : "#991B1B"
                }}
              >
                <span>{oauthFeedback.type === "success" ? "✓" : "⚠️"}</span>
                <span>{oauthFeedback.message}</span>
              </div>
            )}

            {/* Pulse Brand Icon Badge (Using Pulse Cobalt Blue + Transparent Logo) */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#0047AB",
                borderRadius: "14px",
                padding: "12px 24px",
                margin: "0 auto 24px auto",
                boxShadow: "0 4px 14px rgba(0, 71, 171, 0.2)"
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/pulselogo-transparent.png"
                alt="Pulse"
                style={{
                  height: "36px",
                  width: "auto",
                  display: "block"
                }}
              />
            </div>

            {/* STATE 1: STANDARD HOLDING SCREEN */}
            {viewMode === "holding" && (
              <div>
                <h1
                  style={{
                    fontSize: "24px",
                    fontWeight: 700,
                    color: "#0F172A",
                    letterSpacing: "-0.3px",
                    margin: "0 0 14px 0"
                  }}
                >
                  Setting up Pulse for {clientName}
                </h1>
                <p
                  style={{
                    fontSize: "15px",
                    lineHeight: "1.6",
                    color: "#475569",
                    margin: "0 0 24px 0"
                  }}
                >
                  Pulse is currently being set up - please check back later or email{" "}
                  <a
                    href="mailto:hello@pulsedashboard.co.uk"
                    style={{
                      color: "#0047AB",
                      fontWeight: 600,
                      textDecoration: "none"
                    }}
                  >
                    hello@pulsedashboard.co.uk
                  </a>{" "}
                  with any queries.
                </p>
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: "8px",
                    background: "#F8FAFC",
                    border: "1px solid #E2E8F0",
                    fontSize: "13px",
                    color: "#64748B"
                  }}
                >
                  Our team is configuring your workspace. You will receive an update once your dashboards are live.
                </div>
              </div>
            )}

            {/* STATE 2: CONNECT TOOLS SCREEN */}
            {viewMode === "connect" && (
              <div>
                <h1
                  style={{
                    fontSize: "24px",
                    fontWeight: 700,
                    color: "#0F172A",
                    letterSpacing: "-0.3px",
                    margin: "0 0 10px 0"
                  }}
                >
                  Please connect your tools
                </h1>
                <p
                  style={{
                    fontSize: "15px",
                    lineHeight: "1.6",
                    color: "#475569",
                    margin: "0 0 28px 0"
                  }}
                >
                  To complete your Pulse setup, please authorise the connections to the tools your business uses below.
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "28px" }}>
                  {requiredTools.map((t) => {
                    const colors = getToolButtonColor(t.tool);
                    return (
                      <div
                        key={t.tool}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "16px 20px",
                          borderRadius: "10px",
                          border: t.connected ? "1px solid #A7F3D0" : "1px solid #E2E8F0",
                          background: t.connected ? "#F0FDF4" : "#FFFFFF",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
                        }}
                      >
                        <div style={{ textAlign: "left" }}>
                          <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                            {t.type === "accounting" ? "Accounting Platform" : "CRM Platform"}
                          </div>
                          <div style={{ fontSize: "17px", fontWeight: 700, color: "#0F172A", marginTop: "3px" }}>
                            {getToolDisplayName(t.tool)}
                          </div>
                        </div>

                        <div>
                          {t.connected ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "6px 14px",
                                borderRadius: "20px",
                                background: "#DCFCE7",
                                color: "#15803D",
                                fontSize: "13px",
                                fontWeight: 700,
                                border: "1px solid #86EFAC"
                              }}
                            >
                              <span>✓</span>
                              <span>Connected</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleConnect(t.tool)}
                              style={{
                                padding: "9px 18px",
                                borderRadius: "6px",
                                background: colors.bg,
                                color: "#FFFFFF",
                                fontSize: "13.5px",
                                fontWeight: 600,
                                border: "none",
                                cursor: "pointer",
                                transition: "all 0.15s ease",
                                boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = colors.hover; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = colors.bg; }}
                            >
                              Connect {getToolDisplayName(t.tool)} →
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p
                  style={{
                    fontSize: "12px",
                    lineHeight: "1.5",
                    color: "#94A3B8",
                    margin: 0
                  }}
                >
                  You will be securely redirected to approve read-only access, then returned straight back to Pulse.
                </p>
              </div>
            )}

            {/* STATE 3: ALL TOOLS CONNECTED CONFIRMATION */}
            {viewMode === "completed" && (
              <div>
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    background: "#DCFCE7",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 16px auto",
                    fontSize: "24px",
                    color: "#15803D"
                  }}
                >
                  ✓
                </div>
                <h1
                  style={{
                    fontSize: "24px",
                    fontWeight: 700,
                    color: "#0F172A",
                    letterSpacing: "-0.3px",
                    margin: "0 0 14px 0"
                  }}
                >
                  All tools connected!
                </h1>
                <p
                  style={{
                    fontSize: "15px",
                    lineHeight: "1.6",
                    color: "#475569",
                    margin: "0 0 24px 0"
                  }}
                >
                  Thank you! Your tools have been connected successfully. Pulse is currently finalizing your setup - please check back later or email{" "}
                  <a
                    href="mailto:hello@pulsedashboard.co.uk"
                    style={{
                      color: "#0047AB",
                      fontWeight: 600,
                      textDecoration: "none"
                    }}
                  >
                    hello@pulsedashboard.co.uk
                  </a>{" "}
                  with any queries.
                </p>

                <div
                  style={{
                    padding: "16px",
                    borderRadius: "10px",
                    background: "#F0FDF4",
                    border: "1px solid #BBF7D0",
                    marginBottom: "16px",
                    textAlign: "left"
                  }}
                >
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "#166534", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    Active Connections:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {connectedTools.map((t) => (
                      <div key={t.tool} style={{ fontSize: "13px", color: "#15803D", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>✓</span>
                        <span>{getToolDisplayName(t.tool)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ fontSize: "12px", color: "#64748B" }}>
                  Your account manager has been notified and will open your dashboard once data verification is complete.
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
