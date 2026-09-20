import React, { useState, useEffect } from "react";

// Global styles injected once — handles :hover/:active which React inline styles can't do
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
`;

if (typeof document !== "undefined") {
  const id = "triage-global-styles";
  if (!document.getElementById(id)) {
    const el = document.createElement("style");
    el.id = id;
    el.textContent = GLOBAL_STYLES;
    document.head.appendChild(el);
  }
}

// Persistent top bar — rendered around every screen
export default function NavShell({ activeNav, onHome, onOverview, onTasks, onAppLog, onOutgoings, onInvoices, onRetainers, onJobs, onTools, onSettings, homeAlertCount, taskCount, children }) {
  const [showMore, setShowMore] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 600);
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

  const navBtnStyle = (name) => ({
    background: "none", border: "none", cursor: "pointer",
    padding: isMobile ? "12px 12px" : "12px 14px",
    fontSize: "14px", fontWeight: activeNav === name ? "600" : "400",
    color: activeNav === name ? "#0066cc" : "#444",
    borderBottom: activeNav === name ? "2px solid #0066cc" : "2px solid transparent",
    borderRadius: "0", display: "flex", alignItems: "center", whiteSpace: "nowrap",
  });

  const secondaryNavs = [
    { key: "jobs", label: "Jobs", handler: onJobs },
    { key: "invoices", label: "Invoices", handler: onInvoices },
    { key: "retainers", label: "Retainers", handler: onRetainers },
    { key: "appLog", label: "App Log", handler: onAppLog },
    { key: "tools", label: "EoM", handler: onTools },
    { key: "settings", label: "⚙ Settings", handler: onSettings },
  ];

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", minHeight: "100vh", background: "#f5f5f5" }}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_STYLES }} />
      <div style={{ background: "#1a1a2e", color: "#fff", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "15px", fontWeight: "700", letterSpacing: "0.3px" }}>Pulse Management System</span>
      </div>
      <div style={{ background: "#fff", borderBottom: "1px solid #e0e0e0", padding: "0 8px", display: "flex", alignItems: "stretch", position: "relative" }}>
        <button className="triage-btn pulse-nav-item" onClick={onHome} style={navBtnStyle("home")}>Home<Badge count={homeAlertCount} /></button>
        <button className="triage-btn pulse-nav-item" onClick={onOutgoings} style={navBtnStyle("outgoings")}>Vendors</button>
        {!isMobile && secondaryNavs.slice(0, 2).map(({ key, label, handler }) => (
          <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>{label}</button>
        ))}
        <button className="triage-btn pulse-nav-item" onClick={onTasks} style={navBtnStyle("tasks")}>Tasks<Badge count={taskCount} /></button>
        {!isMobile && secondaryNavs.slice(2).map(({ key, label, handler }) => (
          <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>{label}</button>
        ))}
        {isMobile && (
          <>
            {secondaryNavs.filter(n => n.key === activeNav).map(({ key, label, handler }) => (
              <button key={key} className="triage-btn pulse-nav-item" onClick={handler} style={navBtnStyle(key)}>{label}</button>
            ))}
            <button className="nav-more-btn triage-btn"
              onClick={(e) => { e.stopPropagation(); setShowMore(v => !v); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "12px 14px", fontSize: "16px", color: "#666", borderBottom: "2px solid transparent", marginLeft: "auto" }}>
              {showMore ? "✕" : "•••"}
            </button>
            {showMore && (
              <div className="nav-more-dropdown"
                style={{ position: "absolute", top: "100%", right: "0", background: "#fff", border: "1px solid #ddd", borderRadius: "0 0 8px 8px", boxShadow: "0 6px 20px rgba(0,0,0,0.15)", zIndex: 200, minWidth: "150px" }}>
                {secondaryNavs.map(({ key, label, handler }) => (
                  <button key={key} className="triage-btn"
                    onClick={() => { handler(); setShowMore(false); }}
                    style={{ background: "none", border: "none", cursor: "pointer", width: "100%", justifyContent: "flex-start", borderBottom: "1px solid #f0f0f0", padding: "14px 18px", fontSize: "14px", fontWeight: activeNav === key ? "600" : "400", color: activeNav === key ? "#0066cc" : "#444", display: "flex", alignItems: "center" }}>
                    {label}
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