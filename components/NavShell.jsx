import React, { useState, useEffect } from "react";
import Link from "next/link";

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
    gap: 8px;
    box-sizing: border-box;
  }
  .pma-topbar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex-shrink: 1;
  }
  .pma-topbar-logo {
    width: 24px;
    height: 24px;
    background: #0066cc;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
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
  .pma-topbar-user-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 255, 255, 0.08);
    padding: 4px 10px;
    border-radius: 20px;
  }
  .pma-topbar-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #0066cc;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .pma-topbar-name {
    font-size: 13px;
    font-weight: 500;
    color: #e2e8f0;
    white-space: nowrap;
  }
  .pma-topbar-role {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
    white-space: nowrap;
    line-height: 1.3;
  }
  .pma-topbar-signout {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #cbd5e1;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  /* Mobile Portrait and Small Screens */
  @media (max-width: 600px) {
    .pma-topbar {
      padding: 8px 10px;
      gap: 6px;
    }
    .pma-topbar-brand {
      gap: 6px;
    }
    .pma-topbar-logo {
      width: 20px;
      height: 20px;
      font-size: 12px;
      border-radius: 5px;
    }
    .pma-topbar-title {
      font-size: 13.5px;
      letter-spacing: -0.1px;
      white-space: nowrap;
    }
    .pma-topbar-user-area {
      gap: 6px;
    }
    .pma-topbar-user-pill {
      padding: 2px 6px;
      gap: 4px;
      border-radius: 12px;
    }
    .pma-topbar-avatar {
      width: 17px;
      height: 17px;
      font-size: 9.5px;
    }
    .pma-topbar-name {
      font-size: 10.5px;
      max-width: 65px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pma-topbar-role {
      font-size: 8.5px;
      padding: 1px 4px;
      border-radius: 6px;
      line-height: 1.1;
      letter-spacing: 0.2px;
    }
    .pma-topbar-signout {
      padding: 2px 6px;
      font-size: 10.5px;
      border-radius: 4px;
    }
  }

  /* Extra small screens (e.g. 320px - 360px) */
  @media (max-width: 360px) {
    .pma-topbar {
      padding: 6px 8px;
    }
    .pma-topbar-title {
      font-size: 12px;
    }
    .pma-topbar-name {
      max-width: 45px;
      font-size: 9.5px;
    }
    .pma-topbar-role {
      font-size: 8px;
      padding: 0.5px 3.5px;
    }
    .pma-topbar-signout {
      padding: 2px 5px;
      font-size: 9.5px;
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
  onOutgoings, onInvoices, onRetainers, onJobs, onViews, onTools, onSettings,
  homeAlertCount, taskCount, user, onLogout, children
}) {
  const [showMore, setShowMore] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 840);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showMore) return;
    const close = (e) => {
      if (!e.target.closest(".nav-more-dropdown") && !e.target.closest(".nav-more-btn")) {
        setShowMore(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showMore]);

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
    { key: "settings", label: "⚙ Settings", handler: onSettings },
  ];

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLES }} />
      <div className="pma-topbar">
        <div className="pma-topbar-brand">
          <div className="pma-topbar-logo">P</div>
          <span className="pma-topbar-title">Pulse Management Area</span>
        </div>
        {user && (
          <div className="pma-topbar-user-area">
            <div className="pma-topbar-user-pill">
              <div className="pma-topbar-avatar">
                {(user.name || user.email || "U")[0].toUpperCase()}
              </div>
              <span className="pma-topbar-name" title={user.name || user.email}>{user.name || user.email}</span>
              <span
                className="pma-topbar-role"
                style={{
                  background: user.isAdmin ? "rgba(56, 189, 248, 0.2)" : "rgba(245, 158, 11, 0.2)",
                  color: user.isAdmin ? "#7dd3fc" : "#fcd34d",
                }}
              >
                {user.isAdmin ? "Admin" : (Array.isArray(user.assignedClients) ? `${user.assignedClients.length} clients` : "User")}
              </span>
            </div>
            <Link href="/pulse" style={{ textDecoration: "none" }}>
              <button
                className="pma-topbar-signout"
                style={{
                  background: "#0047AB",
                  borderColor: "#0047AB",
                  color: "#ffffff",
                  fontWeight: 600
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "#003b8e"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "#0047AB"; }}
                title="Open Client Portal View"
              >
                Client Portal →
              </button>
            </Link>
            {onLogout && (
              <button
                className="pma-topbar-signout"
                onClick={onLogout}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(239, 68, 68, 0.2)"; e.currentTarget.style.borderColor = "#ef4444"; e.currentTarget.style.color = "#fca5a5"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"; e.currentTarget.style.color = "#cbd5e1"; }}
                title="Sign out of Pulse"
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{
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