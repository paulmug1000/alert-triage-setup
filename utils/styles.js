export const GLOBAL_STYLES = `
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

export const styles = {
  container: { maxWidth: "900px", margin: "0 auto", padding: "20px", fontFamily: "system-ui, -apple-system, sans-serif" },
  header: { marginBottom: "30px", textAlign: "center" },
  title: { fontSize: "28px", fontWeight: "700", color: "#1a1a1a", margin: "0 0 8px 0" },
  subtitle: { fontSize: "14px", color: "#666", margin: "0" },
  card: { background: "#fff", border: "1px solid #e0e0e0", borderRadius: "8px", padding: "24px", marginBottom: "20px" },
  button: { background: "#0066cc", color: "white", border: "none", padding: "12px 24px", borderRadius: "6px", fontSize: "16px", fontWeight: "600", cursor: "pointer", transition: "background 0.2s" },
  buttonSecondary: { background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "10px 16px", borderRadius: "6px", fontSize: "14px", fontWeight: "500", cursor: "pointer" },
  optionButton: { background: "transparent", border: "none", cursor: "pointer", padding: "0", textAlign: "left" },
  errorBanner: { background: "#fee", color: "#c00", padding: "12px 16px", borderRadius: "6px", marginBottom: "16px", fontSize: "14px", border: "1px solid #fcc" },
  successBanner: { background: "#efe", color: "#060", padding: "12px 16px", borderRadius: "6px", marginBottom: "16px", fontSize: "14px", border: "1px solid #cfc" },
  loadingText: { color: "#666", fontSize: "14px", margin: "16px 0 0 0" },
  noActionSection: { background: "#f9f9f9", border: "1px solid #ddd", borderRadius: "8px", padding: "20px", marginTop: "20px" },
  noActionItem: { background: "white", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "16px", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  noActionLabel: { flex: 1 },
  noActionTitle: { fontWeight: "600", color: "#1a1a1a", marginBottom: "4px" },
  noActionDesc: { fontSize: "13px", color: "#666" },
  checkmark: { width: "24px", height: "24px", borderRadius: "4px", border: "2px solid #0066cc", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: "12px", fontSize: "14px", fontWeight: "bold" },
  checkmarkChecked: { background: "#0066cc", color: "white" },
  statsBox: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px" },
  stat: { background: "#f9f9f9", padding: "16px", borderRadius: "6px", textAlign: "center" },
  statNumber: { fontSize: "24px", fontWeight: "700", color: "#0066cc", margin: "0 0 4px 0" },
  statLabel: { fontSize: "13px", color: "#666", margin: "0" },
  buttonGroup: { display: "flex", gap: "12px", marginTop: "16px" },
  alertCard: { background: "#f9f9f9", border: "1px solid #ddd", borderRadius: "8px", padding: "24px", marginBottom: "20px" },
  alertHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid #e0e0e0" },
  alertTitle: { fontSize: "18px", fontWeight: "600", color: "#1a1a1a", margin: "0" },
  alertCounter: { fontSize: "14px", color: "#666", fontWeight: "500" },
  alertMetadata: { fontSize: "13px", color: "#666", marginBottom: "16px", padding: "12px", background: "white", borderRadius: "6px", borderLeft: "3px solid #0066cc" },
  alertSummary: { background: "#fff9e6", padding: "14px", borderRadius: "6px", borderLeft: "4px solid #ff9800", marginBottom: "20px" },
  claudeAnalysis: { background: "white", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "16px", marginBottom: "20px", lineHeight: "1.6", color: "#333", fontSize: "14px" },
  decisionButtons: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginTop: "20px" },
  optionCard: { background: "#f5f5f5", border: "1px solid #ddd", borderRadius: "6px", padding: "12px" },
  optionTitle: { fontSize: "14px", fontWeight: "600", color: "#0066cc", marginBottom: "8px" },
  optionDetail: { fontSize: "13px", color: "#333", marginBottom: "6px", lineHeight: "1.4" },
  optionSummary: { fontSize: "13px", color: "#666", marginTop: "8px", fontStyle: "italic" },
  decisionButton: { padding: "12px 16px", borderRadius: "6px", border: "none", fontSize: "14px", fontWeight: "600", cursor: "pointer", transition: "all 0.2s" },
  approveButton: { background: "#4caf50", color: "white" },
  rejectButton: { background: "#f44336", color: "white" },
  investigateButton: { background: "#2196f3", color: "white" },
  cacheBadge: { display: "inline-flex", alignItems: "center", gap: "4px", background: "#e8f5e9", color: "#2e7d32", border: "1px solid #a5d6a7", borderRadius: "4px", padding: "3px 8px", fontSize: "12px", fontWeight: "600", marginLeft: "8px" },
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modalCard: { background: "white", borderRadius: "8px", padding: "24px", width: "440px", maxWidth: "90vw", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" },
  modalTitle: { fontSize: "16px", fontWeight: "700", color: "#1a1a1a", margin: "0 0 8px 0" },
  modalSubtitle: { fontSize: "13px", color: "#666", margin: "0 0 16px 0", lineHeight: "1.5" },
  modalTextarea: { width: "100%", border: "1px solid #ddd", borderRadius: "6px", padding: "10px", fontSize: "16px", fontFamily: "inherit", resize: "vertical", minHeight: "80px", boxSizing: "border-box" },
  modalButtons: { display: "flex", gap: "10px", marginTop: "16px", justifyContent: "flex-end" },
  ignoreButton: { background: "#ef6c00", color: "white", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer" },
  ignoredAlertCard: { background: "#fff8f2", border: "1px solid #ffe0b2", borderRadius: "6px", padding: "14px 16px", marginBottom: "10px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" },
  ignoredAlertMeta: { fontSize: "12px", color: "#999", marginTop: "4px" },
  unignoreButton: { background: "#1976d2", color: "white", border: "none", borderRadius: "6px", padding: "6px 14px", fontWeight: "600", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  linkButton: { background: "none", border: "none", color: "#0066cc", fontSize: "13px", cursor: "pointer", padding: "0", textDecoration: "underline" },
  flagToggleRow: { display: "flex", alignItems: "center", gap: "12px", padding: "12px 14px", borderRadius: "6px", border: "1px solid #e0e0e0", marginBottom: "8px", cursor: "pointer", background: "#fafafa", userSelect: "none" },
  flagToggleRowActive: { background: "#e8f5e9", borderColor: "#a5d6a7" },
  flagToggleLabel: { flex: 1, fontSize: "14px", fontWeight: "600", color: "#1a1a1a" },
  flagToggleSub: { fontSize: "12px", color: "#888", fontWeight: "400", marginTop: "2px" },
  flagCheckbox: { width: "18px", height: "18px", accentColor: "#4caf50", cursor: "pointer", flexShrink: 0 },
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