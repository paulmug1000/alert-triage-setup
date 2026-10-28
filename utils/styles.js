export const GLOBAL_STYLES = `
  html, body { margin: 0; padding: 0; scroll-behavior: auto; background: #f8fafc; color: #0f172a; }
  button, input, select, textarea { font-family: inherit; }
  @keyframes triage-spin { to { transform: rotate(360deg); } }
  .triage-btn { transition: filter 0.15s, transform 0.1s, background 0.15s, box-shadow 0.15s, border-color 0.15s, color 0.15s !important; }
  .triage-btn:hover:not(:disabled) { filter: brightness(0.95); box-shadow: 0 2px 6px rgba(15, 23, 42, 0.08); }
  .triage-btn:active:not(:disabled) { transform: scale(0.98); filter: brightness(0.9); }
  .triage-btn:disabled { cursor: not-allowed !important; opacity: 0.55 !important; }
  .triage-btn-primary:hover:not(:disabled) { background: #003b8e !important; }
  .triage-client-card { transition: background 0.12s, border-color 0.12s, box-shadow 0.12s !important; }
  .triage-client-card:hover { background: #f0f7ff !important; border-color: #0047AB !important; box-shadow: 0 2px 8px rgba(0, 71, 171, 0.12) !important; }
  .triage-client-card:active { background: #e0effe !important; transform: scale(0.998); }
  .pulse-nav-item { transition: color 0.15s, border-color 0.15s, background 0.15s !important; }
  .pulse-nav-item:hover { color: #0047AB !important; }
  .pma-page-container {
    width: 100%;
    max-width: 1440px !important;
    margin: 0 auto !important;
    padding: 24px 32px 60px;
    box-sizing: border-box;
    font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  @media (max-width: 768px) {
    .pma-page-container {
      padding: 16px 16px 48px !important;
    }
  }
`;

export const styles = {
  container: { width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "24px 32px 60px", boxSizing: "border-box", fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  header: { marginBottom: "20px", textAlign: "left", background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" },
  title: { fontSize: "20px", fontWeight: "700", color: "#0f172a", margin: "0 0 4px 0" },
  subtitle: { fontSize: "13px", color: "#64748b", margin: "0" },
  card: { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "24px", marginBottom: "20px", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" },
  button: { background: "#0047AB", color: "white", border: "none", padding: "10px 20px", borderRadius: "8px", fontSize: "14px", fontWeight: "600", cursor: "pointer", transition: "background 0.2s" },
  buttonSecondary: { background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1", padding: "8px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: "pointer", boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)" },
  optionButton: { background: "transparent", border: "none", cursor: "pointer", padding: "0", textAlign: "left" },
  errorBanner: { background: "#fef2f2", color: "#b91c1c", padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", fontSize: "13px", border: "1px solid #fecaca" },
  successBanner: { background: "#f0fdf4", color: "#15803d", padding: "12px 16px", borderRadius: "8px", marginBottom: "16px", fontSize: "13px", border: "1px solid #bbf7d0" },
  loadingText: { color: "#64748b", fontSize: "14px", margin: "16px 0 0 0" },
  noActionSection: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "20px", marginTop: "20px" },
  noActionItem: { background: "white", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  noActionLabel: { flex: 1 },
  noActionTitle: { fontWeight: "600", color: "#0f172a", marginBottom: "4px" },
  noActionDesc: { fontSize: "13px", color: "#64748b" },
  checkmark: { width: "24px", height: "24px", borderRadius: "6px", border: "2px solid #0047AB", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: "12px", fontSize: "14px", fontWeight: "bold" },
  checkmarkChecked: { background: "#0047AB", color: "white" },
  statsBox: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px" },
  stat: { background: "#f8fafc", padding: "16px", borderRadius: "8px", textAlign: "center", border: "1px solid #e2e8f0" },
  statNumber: { fontSize: "24px", fontWeight: "700", color: "#0047AB", margin: "0 0 4px 0" },
  statLabel: { fontSize: "13px", color: "#64748b", margin: "0" },
  buttonGroup: { display: "flex", gap: "12px", marginTop: "16px" },
  alertCard: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "24px", marginBottom: "20px" },
  alertHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid #e2e8f0" },
  alertTitle: { fontSize: "18px", fontWeight: "600", color: "#0f172a", margin: "0" },
  alertCounter: { fontSize: "14px", color: "#64748b", fontWeight: "500" },
  alertMetadata: { fontSize: "13px", color: "#475569", marginBottom: "16px", padding: "12px", background: "white", borderRadius: "6px", borderLeft: "3px solid #0047AB" },
  alertSummary: { background: "#fffbeb", padding: "14px", borderRadius: "6px", borderLeft: "4px solid #f59e0b", marginBottom: "20px" },
  claudeAnalysis: { background: "white", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px", marginBottom: "20px", lineHeight: "1.6", color: "#334155", fontSize: "14px" },
  decisionButtons: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginTop: "20px" },
  optionCard: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px" },
  optionTitle: { fontSize: "14px", fontWeight: "600", color: "#0047AB", marginBottom: "8px" },
  optionDetail: { fontSize: "13px", color: "#334155", marginBottom: "6px", lineHeight: "1.4" },
  optionSummary: { fontSize: "13px", color: "#64748b", marginTop: "8px", fontStyle: "italic" },
  decisionButton: { padding: "12px 16px", borderRadius: "6px", border: "none", fontSize: "14px", fontWeight: "600", cursor: "pointer", transition: "all 0.2s" },
  approveButton: { background: "#16a34a", color: "white" },
  rejectButton: { background: "#dc2626", color: "white" },
  investigateButton: { background: "#0047AB", color: "white" },
  cacheBadge: { display: "inline-flex", alignItems: "center", gap: "4px", background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0", borderRadius: "4px", padding: "3px 8px", fontSize: "12px", fontWeight: "600", marginLeft: "8px" },
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(15, 23, 42, 0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modalCard: { background: "white", borderRadius: "10px", padding: "24px", width: "440px", maxWidth: "90vw", boxShadow: "0 10px 32px rgba(15, 23, 42, 0.18)", border: "1px solid #e2e8f0" },
  modalTitle: { fontSize: "16px", fontWeight: "700", color: "#0f172a", margin: "0 0 8px 0" },
  modalSubtitle: { fontSize: "13px", color: "#64748b", margin: "0 0 16px 0", lineHeight: "1.5" },
  modalTextarea: { width: "100%", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "10px", fontSize: "15px", fontFamily: "inherit", resize: "vertical", minHeight: "80px", boxSizing: "border-box" },
  modalButtons: { display: "flex", gap: "10px", marginTop: "16px", justifyContent: "flex-end" },
  ignoreButton: { background: "#ea580c", color: "white", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer" },
  ignoredAlertCard: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "8px", padding: "14px 16px", marginBottom: "10px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" },
  ignoredAlertMeta: { fontSize: "12px", color: "#64748b", marginTop: "4px" },
  unignoreButton: { background: "#0047AB", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontWeight: "600", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  linkButton: { background: "none", border: "none", color: "#0047AB", fontSize: "13px", cursor: "pointer", padding: "0", textDecoration: "underline" },
  flagToggleRow: { display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", borderRadius: "8px", border: "1px solid #e2e8f0", marginBottom: "8px", cursor: "pointer", background: "#f8fafc", userSelect: "none" },
  flagToggleRowActive: { background: "#f0fdf4", borderColor: "#bbf7d0" },
  flagToggleLabel: { flex: 1, fontSize: "14px", fontWeight: "600", color: "#0f172a" },
  flagToggleSub: { fontSize: "12px", color: "#64748b", fontWeight: "400", marginTop: "2px" },
  flagCheckbox: { width: "18px", height: "18px", accentColor: "#16a34a", cursor: "pointer", flexShrink: 0 },
};

export function injectGlobalStyles() {
  if (typeof document !== "undefined") {
    const id = "triage-global-styles";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = GLOBAL_STYLES;
      document.head.appendChild(el);
    }
  }
}
