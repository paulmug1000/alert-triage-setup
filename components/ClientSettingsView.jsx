import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";

const SECTIONS = [
  { id: "main", label: "Main", icon: "🏢", adminOnly: true },
  { id: "customisation", label: "Customisation", icon: "🎨" },
  { id: "accounting", label: "Accounting", icon: "📊" },
  { id: "crm", label: "CRM", icon: "👥" },
  { id: "jobs", label: "Jobs", icon: "📁" },
  { id: "automation", label: "Automations", icon: "⚡", adminOnly: true },
  { id: "pulse", label: "Pulse portal", icon: "📱" }
];

// Exact options matching Google Sheets data validation
const VAT_QUARTERS_OPTIONS = [
  "Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec",
  "Feb-Apr, May-Jul, Aug-Oct, Nov-Jan",
  "Mar-May, Jun-Aug, Sep-Nov, Dec-Feb"
];

const VAT_PAYMENT_SCHEME_OPTIONS = [
  "Accrual",
  "Cash"
];

const PRIMARY_CURRENCY_OPTIONS = [
  "GBP",
  "EUR",
  "USD"
];

const TAX_PAYMENT_METHOD_OPTIONS = [
  "Standard",
  "Transfers"
];

const CURRENCY_SYMBOL_OPTIONS = ["£", "$", "€"];
const THOUSANDS_SEPARATOR_OPTIONS = [",", "."];
const INVOICE_METHOD_OPTIONS = ["Whole", "Lines"];
const REVENUE_FOCUS_OPTIONS = ["Revenue", "Income"];
const PAYE_CYCLE_OPTIONS = ["Monthly", "Quarterly"];
const YES_NO_OPTIONS = ["Yes", "No"];

const PROFIT_SHARE_ACCRUE_OPTIONS = ["None", "Monthly"];
const PROFIT_SHARE_PAYMENT_OPTIONS = [
  "None",
  "YearlyM12",
  "YearlyM13",
  "YearlyM14",
  "YearlyM15",
  "YearlyM16"
];

const ACCOUNTING_TOOL_OPTIONS = ["None", "Xero", "Quickbooks"];

const CRM_TOOL_OPTIONS = [
  "None",
  "ClickUp",
  "Close",
  "Capsule",
  "Pipedrive",
  "Monday",
  "Google Sheet",
  "HubSpot",
  "Excel"
];

const CRM_DRIVES_OPTIONS = ["NA", "Pipeline", "PipeAndConf"];

const PROJECT_DATE_ADJUST_OPTIONS = [
  "Raw dates",
  "5-day adjust",
  "10-day adjust",
  "15-day adjust"
];

const RETAINER_DATES_OPTIONS = [
  "Raw date",
  "10-day min",
  "15-day min",
  "20-day min"
];

const RETAINER_DUR_OPTIONS = [
  "Raw date rounding",
  "Any day down bias",
  "25-day down bias",
  "20-day down bias",
  "10-day up bias",
  "5-day up bias",
  "Any day up bias"
];

const MOVE_CRM_DATES_OPTIONS = [
  "No",
  "Yes - to curr month",
  "Yes - to next month",
  "Yes - to m+2",
  "Yes - curr if before 20th"
];

const CRM_START_DATE_RULES = ["1", "2", "3", "4", "5", "6"];

const FREQUENCY_OPTIONS = [
  "30 mins",
  "1 hr",
  "2 hrs",
  "4 hrs",
  "8 hrs",
  "12 hrs",
  "24 hrs",
  "Week",
  "2 weeks",
  "4 weeks",
  "Month on 1st",
  "Month on 5th",
  "Month on 10th"
];

const MONTHS_COMPARE_OPTIONS = ["1", "3", "6", "7", "12", "13"];

const INVOICE_HANDLING_METHOD_OPTIONS = [
  "None",
  "Look for slot",
  "Create new job",
  "Look then create"
];

const EXPENSE_HANDLING_METHOD_OPTIONS = [
  "None",
  "Look for slot",
  "Look then create"
];

const DEFAULT_INVOICING_DETAILS_OPTIONS = [
  "None",
  "100 at end",
  "50-50",
  "50-25-25",
  "25-25-50",
  "25-75",
  "33-33-33",
  "Even-Split"
];

const DISCREPANCY_GAS_OPTIONS = ["Include", "Exclude", "Ignore"];
const DISCREPANCY_PMA_OPTIONS = ["Include", "Ignore"];

export default function ClientSettingsView({
  allClients = [],
  managedClient = null,
  initialClientName = "",
  user,
  isAdmin = false
}) {
  const effectiveIsAdmin = Boolean(isAdmin || user?.isAdmin || user?.role === "Admin");

  // Client selection
  const [selectedClientName, setSelectedClientName] = useState(() => {
    if (managedClient?.clientName) return managedClient.clientName;
    if (initialClientName) return initialClientName;
    return allClients[0]?.clientName || "";
  });

  // Active section in left sidebar
  const [activeSection, setActiveSection] = useState("main");

  // Data states
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");
  const [settings, setSettings] = useState(null);
  const [initialSettingsSnapshot, setInitialSettingsSnapshot] = useState(null);
  const [isDirty, setIsDirty] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Admin Cell Reference visibility toggle
  const [showCellRefs, setShowCellRefs] = useState(true);

  // Show/hide Excel Client Secret
  const [showClientSecret, setShowClientSecret] = useState(false);

  // Bank accounts fetch & modal state
  const [fetchingBankAccounts, setFetchingBankAccounts] = useState(false);
  const [bankAccountsError, setBankAccountsError] = useState("");
  const [bankAccountsSuccess, setBankAccountsSuccess] = useState("");
  const [showBankModal, setShowBankModal] = useState(false);
  const [potentialBankAccounts, setPotentialBankAccounts] = useState([]);
  const [resolvedAccountingTool, setResolvedAccountingTool] = useState("");
  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [tempSelectedBankAccounts, setTempSelectedBankAccounts] = useState([]);
  const [newManualAccountName, setNewManualAccountName] = useState("");

  // Resolve active client object
  const activeClientObj = useMemo(() => {
    if (managedClient?.clientName === selectedClientName) return managedClient;
    return allClients.find(c => c.clientName === selectedClientName) || null;
  }, [allClients, managedClient, selectedClientName]);

  // Keep selectedClientName synced with managedClient if present
  useEffect(() => {
    if (managedClient?.clientName) {
      setSelectedClientName(managedClient.clientName);
    }
  }, [managedClient]);

  // Fetch settings from API
  const fetchSettings = useCallback(async (bypassCache = false) => {
    if (!activeClientObj?.clientName || !activeClientObj?.masterSheetId) {
      setSettings(null);
      return;
    }

    setLoading(true);
    setErrorMsg("");
    setSaveSuccessMsg("");

    try {
      const q = new URLSearchParams({
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId,
        clientSheetId: activeClientObj.clientSheetId || "",
        bypassCache: bypassCache ? "true" : "false"
      });

      const res = await fetch(`/api/client-settings?${q.toString()}`);
      const data = await res.json();

      if (data.success && data.settings) {
        setSettings(data.settings);
        setInitialSettingsSnapshot(JSON.stringify(data.settings));
        setIsDirty(false);
        setFromCache(Boolean(data.settings.fromCache));
        setLastSyncedAt(data.settings.lastSyncedAt || new Date().toISOString());
      } else {
        setErrorMsg(data.error || "Failed to load client settings.");
      }
    } catch (err) {
      setErrorMsg("Error: " + err.message);
    } finally {
      setLoading(false);
    }
  }, [activeClientObj]);

  // Initial load on client change
  useEffect(() => {
    fetchSettings(false);
  }, [fetchSettings]);

  // Dirty check
  const updateSettingsField = useCallback((updaterFn) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = typeof updaterFn === "function" ? updaterFn(prev) : { ...prev, ...updaterFn };
      setIsDirty(JSON.stringify(next) !== initialSettingsSnapshot);
      return next;
    });
  }, [initialSettingsSnapshot]);

  // Save handler
  const handleSave = async (options = {}) => {
    if (!settings || !activeClientObj) return;

    setSaving(true);
    setErrorMsg("");
    setSaveSuccessMsg("");

    try {
      const payload = {
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId,
        clientSheetId: activeClientObj.clientSheetId || "",
        settings,
        resetKpiToParent: Boolean(options.resetKpiToParent)
      };

      const res = await fetch("/api/client-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.success) {
        setSaveSuccessMsg("✓ All settings saved successfully to sheets and cache");
        setIsDirty(false);
        setInitialSettingsSnapshot(JSON.stringify(settings));
        setLastSyncedAt(data.savedAt || new Date().toISOString());
        setTimeout(() => setSaveSuccessMsg(""), 4000);
      } else {
        setErrorMsg(data.error || "Failed to save settings.");
      }
    } catch (err) {
      setErrorMsg("Save error: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  // KPI reset to system defaults handler
  const handleResetKpi = async () => {
    if (!window.confirm("Are you sure you want to reset KPI colouring rules to system defaults? This will restore the live template formula.")) {
      return;
    }
    await handleSave({ resetKpiToParent: true });
    await fetchSettings(true);
  };

  // Cell reference badge helper (Only visible to Admins)
  const renderCellRef = (cell) => {
    if (!effectiveIsAdmin || !showCellRefs || !cell) return null;
    return (
      <div style={{ fontSize: "11px", color: "#94A3B8", marginTop: "3px", fontFamily: "monospace" }}>
        Cell: {cell}
      </div>
    );
  };

  // Switch helper
  const renderToggle = (label, checked, onChange, subtitle = null, cell = null) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div>
        <div style={{ fontSize: "13px", fontWeight: "600", color: "#1E293B" }}>{label}</div>
        {subtitle && <div style={{ fontSize: "12px", color: "#64748B", marginTop: "2px" }}>{subtitle}</div>}
        {renderCellRef(cell)}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: "44px",
          height: "24px",
          borderRadius: "12px",
          background: checked ? "#0066CC" : "#CBD5E1",
          border: "none",
          cursor: "pointer",
          position: "relative",
          transition: "background 0.2s ease",
          padding: 0
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "22px" : "2px",
            width: "20px",
            height: "20px",
            borderRadius: "10px",
            background: "#FFFFFF",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            transition: "left 0.2s ease"
          }}
        />
      </button>
    </div>
  );

  // Bank accounts helpers & handlers
  const combinedModalAccounts = useMemo(() => {
    const list = [...potentialBankAccounts];
    const seenNames = new Set(list.map(a => String(a.name || "").toLowerCase().trim()));
    (settings?.accounting?.bankAccounts || []).forEach(existingName => {
      const clean = String(existingName || "").toLowerCase().trim();
      if (clean && !seenNames.has(clean)) {
        list.push({
          id: `custom-${clean}`,
          name: existingName,
          code: "",
          currency: "",
          status: "MANUAL",
          subType: "Manual entry"
        });
        seenNames.add(clean);
      }
    });
    return list;
  }, [potentialBankAccounts, settings?.accounting?.bankAccounts]);

  const filteredModalAccounts = useMemo(() => {
    if (!bankSearchQuery.trim()) return combinedModalAccounts;
    const q = bankSearchQuery.toLowerCase().trim();
    return combinedModalAccounts.filter(acc =>
      (acc.name && acc.name.toLowerCase().includes(q)) ||
      (acc.code && acc.code.toLowerCase().includes(q)) ||
      (acc.currency && acc.currency.toLowerCase().includes(q)) ||
      (acc.subType && acc.subType.toLowerCase().includes(q))
    );
  }, [combinedModalAccounts, bankSearchQuery]);

  const handleFetchBankAccounts = async () => {
    if (!activeClientObj?.clientName) return;
    setFetchingBankAccounts(true);
    setBankAccountsError("");
    setBankAccountsSuccess("");

    try {
      const q = new URLSearchParams({
        clientName: activeClientObj.clientName,
        masterSheetId: activeClientObj.masterSheetId || "",
        tool: settings?.accounting?.toolInUse || ""
      });

      const res = await fetch(`/api/client-settings/bank-accounts?${q.toString()}`);
      const data = await res.json();

      if (data.success && Array.isArray(data.accounts)) {
        setResolvedAccountingTool(data.tool || "accounting tool");
        setPotentialBankAccounts(data.accounts);
        setTempSelectedBankAccounts([...(settings?.accounting?.bankAccounts || [])]);
        setBankSearchQuery("");
        setShowBankModal(true);
      } else {
        setBankAccountsError(data.error || "Failed to fetch bank accounts from accounting tool.");
      }
    } catch (err) {
      setBankAccountsError("Error: " + err.message);
    } finally {
      setFetchingBankAccounts(false);
    }
  };

  const handleToggleBankAccount = (name) => {
    if (!name) return;
    setTempSelectedBankAccounts(prev => {
      const exists = prev.includes(name);
      if (exists) {
        return prev.filter(n => n !== name);
      } else {
        if (prev.length >= 11) {
          alert("Maximum 11 bank accounts allowed (KeyInfo!H12:H22). Please uncheck an account before selecting another.");
          return prev;
        }
        return [...prev, name];
      }
    });
  };

  const handleApplyBankSelection = () => {
    const details = tempSelectedBankAccounts.map(name => {
      const match = potentialBankAccounts.find(p => p.name === name);
      return match || { name };
    });

    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: tempSelectedBankAccounts,
        bankAccountDetails: details
      }
    }));
    setShowBankModal(false);
    setBankAccountsSuccess(`Updated bank accounts list (${tempSelectedBankAccounts.length} selected). Remember to click "Save changes" to persist to sheets.`);
  };

  const handleAddManualBankAccount = () => {
    const trimmed = (newManualAccountName || "").trim();
    if (!trimmed) return;
    const currentList = settings?.accounting?.bankAccounts || [];
    if (currentList.length >= 11) {
      alert("Maximum 11 bank accounts allowed (KeyInfo!H12:H22).");
      return;
    }
    if (currentList.includes(trimmed)) {
      alert("This bank account is already in the list.");
      return;
    }
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: [...currentList, trimmed]
      }
    }));
    setNewManualAccountName("");
  };

  const handleRemoveBankAccount = (index) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    currentList.splice(index, 1);
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList
      }
    }));
  };

  const handleUpdateBankAccountName = (index, newName) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    currentList[index] = newName;
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList
      }
    }));
  };

  const handleMoveBankAccount = (fromIdx, toIdx) => {
    const currentList = [...(settings?.accounting?.bankAccounts || [])];
    if (toIdx < 0 || toIdx >= currentList.length) return;
    const item = currentList.splice(fromIdx, 1)[0];
    currentList.splice(toIdx, 0, item);
    updateSettingsField(prev => ({
      ...prev,
      accounting: {
        ...prev.accounting,
        bankAccounts: currentList
      }
    }));
  };

  return (
    <div style={{ marginTop: "10px" }}>
      {/* ── TOP CONTROL BAR ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "12px",
        background: "#FFFFFF",
        border: "1px solid #E2E8F0",
        borderRadius: "10px",
        padding: "12px 18px",
        marginBottom: "16px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
      }}>
        {/* Left: Client selector */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <label style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
            Client:
          </label>
          {managedClient ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", background: "#F1F5F9", padding: "4px 10px", borderRadius: "6px" }}>
                🏢 {managedClient.clientName}
              </span>
              <span style={{ fontSize: "11px", color: "#64748B", fontStyle: "italic" }}>
                (managed client mode)
              </span>
            </div>
          ) : (
            <select
              value={selectedClientName}
              onChange={(e) => setSelectedClientName(e.target.value)}
              disabled={loading || saving}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #CBD5E1",
                fontSize: "13px",
                background: "#FFFFFF",
                fontWeight: "600",
                color: "#0F172A",
                cursor: "pointer",
                minWidth: "220px"
              }}
            >
              {allClients.map(c => (
                <option key={c.clientName} value={c.clientName}>
                  {c.clientName}
                </option>
              ))}
            </select>
          )}

          {lastSyncedAt && (
            <span style={{ fontSize: "11px", color: "#64748B", marginLeft: "6px" }}>
              {fromCache ? "⚡ Loaded from cache" : "☁️ Loaded from sheets"}
              {" · "}
              {new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {effectiveIsAdmin && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#64748B", cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={showCellRefs}
                onChange={(e) => setShowCellRefs(e.target.checked)}
              />
              Show cell refs
            </label>
          )}

          {isDirty && (
            <span style={{ fontSize: "12px", color: "#B45309", background: "#FEF3F2", padding: "4px 10px", borderRadius: "12px", fontWeight: "600", display: "inline-flex", alignItems: "center", gap: "4px" }}>
              ● Unsaved changes
            </span>
          )}

          <button
            type="button"
            onClick={() => fetchSettings(true)}
            disabled={loading || saving}
            title="Bypass cache and reload fresh data directly from Google Sheets"
            style={{
              padding: "7px 12px",
              fontSize: "12px",
              fontWeight: "600",
              color: "#334155",
              background: "#F1F5F9",
              border: "1px solid #CBD5E1",
              borderRadius: "6px",
              cursor: (loading || saving) ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px"
            }}
          >
            {loading ? <Spinner size={12} color="#0066CC" /> : "↻"} Reload sheets
          </button>

          <button
            type="button"
            onClick={() => handleSave()}
            disabled={!isDirty || saving || loading}
            style={{
              padding: "7px 18px",
              fontSize: "13px",
              fontWeight: "600",
              color: "#FFFFFF",
              background: isDirty ? "#0066CC" : "#94A3B8",
              border: "none",
              borderRadius: "6px",
              cursor: (!isDirty || saving || loading) ? "default" : "pointer",
              boxShadow: isDirty ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              transition: "all 0.15s ease"
            }}
          >
            {saving ? <><Spinner size={12} color="#FFFFFF" /> Saving...</> : "Save changes"}
          </button>
        </div>
      </div>

      {/* Notifications */}
      {errorMsg && (
        <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", color: "#991B1B", padding: "10px 14px", borderRadius: "8px", fontSize: "13px", marginBottom: "16px" }}>
          {errorMsg}
        </div>
      )}
      {saveSuccessMsg && (
        <div style={{ background: "#DCFCE7", border: "1px solid #BBF7D0", color: "#166534", padding: "10px 14px", borderRadius: "8px", fontSize: "13px", fontWeight: "600", marginBottom: "16px" }}>
          {saveSuccessMsg}
        </div>
      )}

      {/* Loading state */}
      {loading && !settings && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#64748B" }}>
          <Spinner size={24} color="#0066CC" />
          <div style={{ marginTop: "12px", fontSize: "14px", fontWeight: "500" }}>
            Loading settings for {selectedClientName}...
          </div>
        </div>
      )}

      {/* ── TWO-COLUMN SETTINGS LAYOUT ──────────────────────────────────────── */}
      {settings && (
        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "20px", alignItems: "start" }}>
          {/* Left Navigation Sidebar */}
          <div style={{
            background: "#FFFFFF",
            borderRadius: "10px",
            border: "1px solid #E2E8F0",
            padding: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
          }}>
            {SECTIONS.map(s => {
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSection(s.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 12px",
                    borderRadius: "6px",
                    border: "none",
                    background: active ? "#EFF6FF" : "transparent",
                    color: active ? "#0066CC" : "#334155",
                    fontSize: "13px",
                    fontWeight: active ? 700 : 500,
                    cursor: "pointer",
                    textAlign: "left",
                    marginBottom: "2px",
                    transition: "all 0.1s ease"
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "#F8FAFC";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span>{s.icon}</span>
                    <span>{s.label}</span>
                  </span>
                  {s.adminOnly && (
                    <span style={{ fontSize: "10px", fontWeight: "700", color: "#64748B", background: "#F1F5F9", padding: "1px 5px", borderRadius: "4px" }}>
                      Admin
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Content Panel */}
          <div style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            border: "1px solid #E2E8F0",
            padding: "24px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            minHeight: "500px"
          }}>

            {/* ── 1. MAIN (ADMIN ONLY) ────────────────────────────────────── */}
            {activeSection === "main" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Main settings</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Core company financial anchors, VAT cycles, currency, employment allowances, reporting preferences, integration tools, and automation frequencies.
                  </p>
                </div>

                {/* Sub-group A: Core financial settings */}
                <div style={{ marginBottom: "24px" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Core financial settings</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Pulse start date
                      </label>
                      <input
                        type="text"
                        value={settings.main?.pulseStartDate || ""}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, pulseStartDate: e.target.value } }))}
                        placeholder="e.g. 1-Apr-2026"
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("KeyInfo!B2")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Primary currency
                      </label>
                      <select
                        value={settings.main?.primaryCurrency || "GBP"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, primaryCurrency: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PRIMARY_CURRENCY_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B17")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        VAT quarters
                      </label>
                      <select
                        value={settings.main?.vatQuarters || VAT_QUARTERS_OPTIONS[0]}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatQuarters: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {VAT_QUARTERS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B6")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        VAT payment scheme
                      </label>
                      <select
                        value={settings.main?.vatPaymentScheme || "Accrual"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatPaymentScheme: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {VAT_PAYMENT_SCHEME_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B8")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        VAT rate
                      </label>
                      <input
                        type="text"
                        value={settings.main?.vatRate || "20%"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, vatRate: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("KeyInfo!B9")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        PAYE cycle
                      </label>
                      <select
                        value={settings.main?.payeCycle || "Monthly"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, payeCycle: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PAYE_CYCLE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B12")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Eligible for employment allowance?
                      </label>
                      <select
                        value={settings.main?.employmentAllowanceEligible || "Yes"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, employmentAllowanceEligible: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {YES_NO_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B18")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Employment allowance amount
                      </label>
                      <input
                        type="text"
                        value={settings.main?.employmentAllowanceAmount || "£10,500"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, main: { ...prev.main, employmentAllowanceAmount: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("KeyInfo!B19")}
                    </div>
                  </div>
                </div>

                {/* Sub-group B: Reporting & customisation (Admin only) */}
                <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9", marginBottom: "24px" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Reporting & customisation</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Revenue or income focus
                      </label>
                      <select
                        value={settings.customisation?.revenueFocus || "Revenue"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, revenueFocus: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {REVENUE_FOCUS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B15")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Tax payment method
                      </label>
                      <select
                        value={settings.customisation?.taxPaymentMethod || "Standard"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, taxPaymentMethod: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {TAX_PAYMENT_METHOD_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!B10")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Currency symbol
                      </label>
                      <select
                        value={settings.customisation?.currencySymbol || "£"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, currencySymbol: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {CURRENCY_SYMBOL_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!D4")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Thousands separator
                      </label>
                      <select
                        value={settings.customisation?.thousandsSeparator || ","}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, thousandsSeparator: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {THOUSANDS_SEPARATOR_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt === "," ? "Comma ( , )" : "Dot ( . )"}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!D5")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Invoice method
                      </label>
                      <select
                        value={settings.customisation?.invoiceMethod || "Lines"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, invoiceMethod: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {INVOICE_METHOD_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F8")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Profit share %
                      </label>
                      <input
                        type="text"
                        value={settings.customisation?.profitSharePercent || "0%"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitSharePercent: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("KeyInfo!F11")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Profit share accrual method
                      </label>
                      <select
                        value={settings.customisation?.profitShareAccrual || "Monthly"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitShareAccrual: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PROFIT_SHARE_ACCRUE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F12")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Profit share payment
                      </label>
                      <select
                        value={settings.customisation?.profitSharePayment || "YearlyM13"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, customisation: { ...prev.customisation, profitSharePayment: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PROFIT_SHARE_PAYMENT_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F13")}
                    </div>
                  </div>
                </div>

                {/* Sub-group C: Integration tools (Admin only) */}
                <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9", marginBottom: "24px" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Integration tools</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Accounting tool in use
                      </label>
                      <select
                        value={settings.accounting?.toolInUse || "None"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, toolInUse: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {ACCOUNTING_TOOL_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!Q4")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        CRM in use
                      </label>
                      <select
                        value={settings.crm?.toolInUse || "None"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, toolInUse: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {CRM_TOOL_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!Q8")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        CRM drives
                      </label>
                      <select
                        value={settings.crm?.crmDrives || "Pipeline"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, crmDrives: e.target.value } }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {CRM_DRIVES_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!Q9")}
                    </div>
                  </div>

                  {/* Tool-specific configuration */}
                  {settings.crm?.toolInUse && settings.crm.toolInUse !== "None" && (
                    <div style={{ background: "#F8FAFC", borderRadius: "10px", padding: "16px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                        {settings.crm.toolInUse} connection settings
                      </div>

                      {/* Google Sheet CRM */}
                      {settings.crm.toolInUse === "Google Sheet" && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                          <div>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                              Google Sheet CRM URL
                            </label>
                            <input
                              type="text"
                              value={settings.crm.googleSheetUrl || ""}
                              onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetUrl: e.target.value } }))}
                              placeholder="https://docs.google.com/spreadsheets/d/..."
                              style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X14")}
                          </div>
                          <div>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                              CRM tab name
                            </label>
                            <input
                              type="text"
                              value={settings.crm.googleSheetTab || ""}
                              onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, googleSheetTab: e.target.value } }))}
                              placeholder="e.g. Leads or Pipeline"
                              style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X15")}
                          </div>
                        </div>
                      )}

                      {/* ClickUp */}
                      {settings.crm.toolInUse === "ClickUp" && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                          <div>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                              ClickUp list ID
                            </label>
                            <input
                              type="text"
                              value={settings.crm.clickUpListId || ""}
                              onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, clickUpListId: e.target.value } }))}
                              placeholder="e.g. 9012345678"
                              style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X16")}
                          </div>
                          <div>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                              ClickUp view ID
                            </label>
                            <input
                              type="text"
                              value={settings.crm.clickUpViewId || ""}
                              onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, clickUpViewId: e.target.value } }))}
                              placeholder="e.g. 9012345678-v"
                              style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X17")}
                          </div>
                        </div>
                      )}

                      {/* Monday */}
                      {settings.crm.toolInUse === "Monday" && (
                        <div>
                          <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                            Monday board ID
                          </label>
                          <input
                            type="text"
                            value={settings.crm.mondayBoardId || ""}
                            onChange={(e) => updateSettingsField(prev => ({ ...prev, crm: { ...prev.crm, mondayBoardId: e.target.value } }))}
                            placeholder="e.g. 1234567890"
                            style={{ width: "320px", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                          />
                          {renderCellRef("KeyInfo!X24")}
                        </div>
                      )}

                      {/* Excel / Azure */}
                      {settings.crm.toolInUse === "Excel" && (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                          {[
                            { key: "azureTenantId", label: "Azure tenant ID", cell: "KeyInfo!X33" },
                            { key: "azureClientId", label: "Azure client ID", cell: "KeyInfo!X34" },
                            { key: "driveId", label: "Drive ID", cell: "KeyInfo!X36" },
                            { key: "fileId", label: "File ID", cell: "KeyInfo!X37" },
                            { key: "worksheetName", label: "Worksheet name", cell: "KeyInfo!X38" },
                            { key: "range", label: "Excel range", cell: "KeyInfo!X39" },
                            { key: "columnRow", label: "Column row", cell: "KeyInfo!X40" },
                            { key: "keyHeaders", label: "Key headers", cell: "KeyInfo!X41" }
                          ].map(f => (
                            <div key={f.key}>
                              <label style={{ fontSize: "11px", fontWeight: "600", color: "#475569", display: "block", marginBottom: "3px" }}>
                                {f.label}
                              </label>
                              <input
                                type="text"
                                value={settings.crm.excel?.[f.key] || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => ({
                                    ...prev,
                                    crm: {
                                      ...prev.crm,
                                      excel: { ...prev.crm.excel, [f.key]: val }
                                    }
                                  }));
                                }}
                                style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                              />
                              {renderCellRef(f.cell)}
                            </div>
                          ))}

                          {/* Azure Client Secret */}
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                              <label style={{ fontSize: "11px", fontWeight: "600", color: "#475569" }}>Azure client secret</label>
                              <button
                                type="button"
                                onClick={() => setShowClientSecret(v => !v)}
                                style={{ background: "none", border: "none", color: "#0066CC", fontSize: "11px", cursor: "pointer", padding: 0 }}
                              >
                                {showClientSecret ? "Hide" : "Show"}
                              </button>
                            </div>
                            <input
                              type={showClientSecret ? "text" : "password"}
                              value={settings.crm.excel?.azureClientSecret || ""}
                              onChange={(e) => {
                                const val = e.target.value;
                                updateSettingsField(prev => ({
                                  ...prev,
                                  crm: {
                                    ...prev.crm,
                                    excel: { ...prev.crm.excel, azureClientSecret: val }
                                  }
                                }));
                              }}
                              style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                            />
                            {renderCellRef("KeyInfo!X35")}
                          </div>
                        </div>
                      )}

                      {/* OAuth CRMs */}
                      {["HubSpot", "Pipedrive", "Close", "Capsule"].includes(settings.crm.toolInUse) && (
                        <div style={{ fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
                          <p style={{ margin: "0 0 6px" }}>
                            🔒 <strong>{settings.crm.toolInUse}</strong> connects via secure centralized OAuth tokens stored in the Pulse Vault.
                          </p>
                          <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                            OAuth handshakes, status monitoring, and tenant credentials are automatically maintained via the central token broker.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Sub-group D: Automation frequencies (Admin only) */}
                <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Automation frequencies</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
                    {[
                      { key: "invoices", label: "Invoices frequency", cell: "DataChgAlert!Y2" },
                      { key: "crm", label: "CRM frequency", cell: "DataChgAlert!Y3" },
                      { key: "expenses", label: "Expenses frequency", cell: "DataChgAlert!Y4" }
                    ].map(f => (
                      <div key={f.key} style={{ background: "#F8FAFC", padding: "14px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                        <label style={{ fontSize: "12px", fontWeight: "600", color: "#1E293B", display: "block", marginBottom: "4px" }}>
                          {f.label}
                        </label>
                        <select
                          value={settings.automation?.frequencies?.[f.key] || FREQUENCY_OPTIONS[0]}
                          onChange={(e) => {
                            const val = e.target.value;
                            updateSettingsField(prev => ({
                              ...prev,
                              automation: {
                                ...prev.automation,
                                frequencies: { ...prev.automation.frequencies, [f.key]: val }
                              }
                            }));
                          }}
                          style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                        >
                          {FREQUENCY_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                        {renderCellRef(f.cell)}
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}

            {/* ── 2. CUSTOMISATION ────────────────────────────────────────── */}
            {activeSection === "customisation" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Customisation</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Health KPI colouring thresholds determining green, orange, and red indicators across the dashboard.
                  </p>
                </div>

                {/* KPI Colouring Rules Card */}
                <div style={{ background: "#F8FAFC", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
                    <div>
                      <h4 style={{ margin: "0 0 4px", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                        KPI colouring rules
                      </h4>
                      <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                        Thresholds determining green, orange, and red indicators across the dashboard.
                      </p>
                      {renderCellRef("KeyInfo!A120:B140")}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {settings.customisation?.kpiColouring?.isParentFormula ? (
                        <span style={{ fontSize: "11px", fontWeight: "600", color: "#166534", background: "#DCFCE7", padding: "4px 9px", borderRadius: "6px" }}>
                          ✓ Using system defaults
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleResetKpi}
                          style={{
                            padding: "5px 10px",
                            fontSize: "11px",
                            fontWeight: "600",
                            color: "#0066CC",
                            background: "#FFFFFF",
                            border: "1px solid #CBD5E1",
                            borderRadius: "6px",
                            cursor: "pointer"
                          }}
                        >
                          ↺ Reset to system defaults
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
                    {/* Gross Profit */}
                    <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Gross profit</div>
                      <div style={{ marginBottom: "6px" }}>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green is above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.grossProfit?.greenAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                grossProfit: { ...prev.customisation.kpiColouring.grossProfit, greenAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B123")}
                      </div>
                      <div>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange is above / red below:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.grossProfit?.orangeAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                grossProfit: { ...prev.customisation.kpiColouring.grossProfit, orangeAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B124")}
                      </div>
                    </div>

                    {/* Overheads */}
                    <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Overheads</div>
                      <div style={{ marginBottom: "6px" }}>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Red is above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.overheads?.redAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                overheads: { ...prev.customisation.kpiColouring.overheads, redAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B128")}
                      </div>
                      <div>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange below, green above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.overheads?.greenAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                overheads: { ...prev.customisation.kpiColouring.overheads, greenAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B129")}
                      </div>
                    </div>

                    {/* Operating Profit */}
                    <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Operating profit</div>
                      <div style={{ marginBottom: "6px" }}>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green is above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.operatingProfit?.greenAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                operatingProfit: { ...prev.customisation.kpiColouring.operatingProfit, greenAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B133")}
                      </div>
                      <div>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange above, red below:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.operatingProfit?.orangeAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                operatingProfit: { ...prev.customisation.kpiColouring.operatingProfit, orangeAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B134")}
                      </div>
                    </div>

                    {/* Staff Costs Ratio */}
                    <div style={{ background: "#FFFFFF", padding: "12px", borderRadius: "8px", border: "1px solid #E2E8F0" }}>
                      <div style={{ fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>Staff costs ratio</div>
                      <div style={{ marginBottom: "4px" }}>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Red is above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.staffCostsRatio?.redAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, redAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B138")}
                      </div>
                      <div style={{ marginBottom: "4px" }}>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Orange is above:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.staffCostsRatio?.orangeAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, orangeAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B139")}
                      </div>
                      <div>
                        <label style={{ fontSize: "11px", color: "#64748B", display: "block" }}>Green above, orange below:</label>
                        <input
                          type="text"
                          value={settings.customisation?.kpiColouring?.staffCostsRatio?.greenAbove || ""}
                          onChange={(e) => updateSettingsField(prev => ({
                            ...prev,
                            customisation: {
                              ...prev.customisation,
                              kpiColouring: {
                                ...prev.customisation.kpiColouring,
                                staffCostsRatio: { ...prev.customisation.kpiColouring.staffCostsRatio, greenAbove: e.target.value }
                              }
                            }
                          }))}
                          style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", marginTop: "2px", boxSizing: "border-box" }}
                        />
                        {renderCellRef("KeyInfo!B140")}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── 3. ACCOUNTING ───────────────────────────────────────────── */}
            {activeSection === "accounting" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Accounting categories & mappings</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Configure bank accounts, category classifications for P&L, pass-through, and staff costs.
                  </p>
                </div>

                {/* Bank Accounts Card (KeyInfo!H12:H22) */}
                <div style={{ marginBottom: "28px", background: "#FFFFFF", borderRadius: "10px", padding: "18px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h4 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                          Bank accounts
                        </h4>
                        <span style={{ fontSize: "11px", fontWeight: "700", color: (settings.accounting?.bankAccounts || []).length > 11 ? "#DC2626" : "#0066CC", background: "#EFF6FF", padding: "2px 8px", borderRadius: "10px" }}>
                          {(settings.accounting?.bankAccounts || []).length} / 11 configured
                        </span>
                      </div>
                      <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748B" }}>
                        Select and prioritize the company bank accounts included in cash flow, management reporting, and end-of-month tools. Stored in 11 rows.
                      </p>
                      {renderCellRef("KeyInfo!H12:H22")}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={handleFetchBankAccounts}
                        disabled={fetchingBankAccounts}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "7px 13px",
                          borderRadius: "6px",
                          border: "1px solid #0066CC",
                          background: "#EFF6FF",
                          color: "#0066CC",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: fetchingBankAccounts ? "not-allowed" : "pointer",
                          opacity: fetchingBankAccounts ? 0.7 : 1,
                          transition: "all 0.15s ease"
                        }}
                      >
                        {fetchingBankAccounts ? (
                          <>
                            <span style={{ display: "inline-block", width: "12px", height: "12px", border: "2px solid #0066CC", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                            <span>Fetching accounts...</span>
                          </>
                        ) : (
                          <>
                            <span>🏦</span>
                            <span>Pull from {settings.accounting?.toolInUse && settings.accounting?.toolInUse !== "None" ? settings.accounting?.toolInUse : "accounting tool"}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Feedback alerts */}
                  {bankAccountsError && (
                    <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: "#B91C1C", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>⚠️ {bankAccountsError}</span>
                      <button type="button" onClick={() => setBankAccountsError("")} style={{ background: "none", border: "none", color: "#B91C1C", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                    </div>
                  )}

                  {bankAccountsSuccess && (
                    <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: "#166534", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>✓ {bankAccountsSuccess}</span>
                      <button type="button" onClick={() => setBankAccountsSuccess("")} style={{ background: "none", border: "none", color: "#166534", cursor: "pointer", fontWeight: "bold" }}>✕</button>
                    </div>
                  )}

                  {/* Active Accounts List */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
                    {(settings.accounting?.bankAccounts || []).length === 0 ? (
                      <div style={{ padding: "20px", background: "#F8FAFC", borderRadius: "8px", border: "1px dashed #CBD5E1", textAlign: "center", color: "#64748B", fontSize: "13px" }}>
                        <p style={{ margin: "0 0 6px", fontWeight: "600", color: "#334155" }}>No bank accounts configured</p>
                        <p style={{ margin: 0, fontSize: "12px" }}>
                          Click &quot;Pull from {settings.accounting?.toolInUse && settings.accounting?.toolInUse !== "None" ? settings.accounting?.toolInUse : "accounting tool"}&quot; to fetch accounts or type an account name below.
                        </p>
                      </div>
                    ) : (
                      (settings.accounting?.bankAccounts || []).map((accountName, idx) => {
                        const cellRow = 12 + idx;
                        return (
                          <div
                            key={idx}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                              background: "#F8FAFC",
                              padding: "7px 12px",
                              borderRadius: "6px",
                              border: "1px solid #E2E8F0"
                            }}
                          >
                            <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748B", width: "52px", flexShrink: 0, fontFamily: "monospace" }}>
                              #{idx + 1} <span style={{ fontSize: "10px", color: "#94A3B8" }}>(H{cellRow})</span>
                            </span>

                            <input
                              type="text"
                              value={accountName}
                              onChange={(e) => handleUpdateBankAccountName(idx, e.target.value)}
                              placeholder="Bank account name"
                              style={{
                                flex: 1,
                                padding: "6px 10px",
                                borderRadius: "5px",
                                border: "1px solid #CBD5E1",
                                fontSize: "13px",
                                background: "#FFFFFF",
                                boxSizing: "border-box"
                              }}
                            />

                            {/* Reorder Buttons */}
                            <div style={{ display: "flex", gap: "2px", flexShrink: 0 }}>
                              <button
                                type="button"
                                onClick={() => handleMoveBankAccount(idx, idx - 1)}
                                disabled={idx === 0}
                                title="Move up"
                                style={{
                                  padding: "4px 7px",
                                  borderRadius: "4px",
                                  border: "1px solid #CBD5E1",
                                  background: idx === 0 ? "#F1F5F9" : "#FFFFFF",
                                  color: idx === 0 ? "#CBD5E1" : "#475569",
                                  cursor: idx === 0 ? "not-allowed" : "pointer",
                                  fontSize: "10px"
                                }}
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveBankAccount(idx, idx + 1)}
                                disabled={idx === (settings.accounting?.bankAccounts || []).length - 1}
                                title="Move down"
                                style={{
                                  padding: "4px 7px",
                                  borderRadius: "4px",
                                  border: "1px solid #CBD5E1",
                                  background: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "#F1F5F9" : "#FFFFFF",
                                  color: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "#CBD5E1" : "#475569",
                                  cursor: idx === (settings.accounting?.bankAccounts || []).length - 1 ? "not-allowed" : "pointer",
                                  fontSize: "10px"
                                }}
                              >
                                ▼
                              </button>
                            </div>

                            {/* Delete Button */}
                            <button
                              type="button"
                              onClick={() => handleRemoveBankAccount(idx)}
                              title="Remove account"
                              style={{
                                padding: "4px 8px",
                                borderRadius: "4px",
                                border: "1px solid #FCA5A5",
                                background: "#FEF2F2",
                                color: "#DC2626",
                                cursor: "pointer",
                                fontSize: "12px",
                                fontWeight: "600",
                                flexShrink: 0
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Manual add input row (if under 11) */}
                  {(settings.accounting?.bankAccounts || []).length < 11 && (
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        type="text"
                        value={newManualAccountName}
                        onChange={(e) => setNewManualAccountName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddManualBankAccount();
                          }
                        }}
                        placeholder="Enter bank account name to add manually..."
                        style={{
                          flex: 1,
                          padding: "7px 10px",
                          borderRadius: "6px",
                          border: "1px solid #CBD5E1",
                          fontSize: "12px",
                          boxSizing: "border-box"
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleAddManualBankAccount}
                        disabled={!newManualAccountName.trim()}
                        style={{
                          padding: "7px 12px",
                          borderRadius: "6px",
                          border: "1px solid #CBD5E1",
                          background: newManualAccountName.trim() ? "#F8FAFC" : "#F1F5F9",
                          color: newManualAccountName.trim() ? "#0F172A" : "#94A3B8",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: newManualAccountName.trim() ? "pointer" : "not-allowed",
                          flexShrink: 0
                        }}
                      >
                        + Add account
                      </button>
                    </div>
                  )}
                </div>

                {/* Manual Tracking Categories (KeyInfo!AT4:AT40) */}
                <div style={{ marginBottom: "28px", background: "#F8FAFC", borderRadius: "10px", padding: "16px", border: "1px solid #E2E8F0" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                    Manual category tracking
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Contractors (max 19)
                      </label>
                      <textarea
                        rows={6}
                        value={(settings.accounting?.contractorsManual || []).join("\n")}
                        onChange={(e) => {
                          const items = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                          updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, contractorsManual: items } }));
                        }}
                        placeholder="Enter one contractor category per line..."
                        style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      <div style={{ fontSize: "11px", color: "#64748B", marginTop: "2px" }}>
                        {(settings.accounting?.contractorsManual || []).length} / 19 categories
                      </div>
                      {renderCellRef("KeyInfo!AT4:AT22")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Other pass-through (max 17)
                      </label>
                      <textarea
                        rows={6}
                        value={(settings.accounting?.passThroughManual || []).join("\n")}
                        onChange={(e) => {
                          const items = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                          updateSettingsField(prev => ({ ...prev, accounting: { ...prev.accounting, passThroughManual: items } }));
                        }}
                        placeholder="Enter one pass-through category per line..."
                        style={{ width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      <div style={{ fontSize: "11px", color: "#64748B", marginTop: "2px" }}>
                        {(settings.accounting?.passThroughManual || []).length} / 17 categories
                      </div>
                      {renderCellRef("KeyInfo!AT24:AT40")}
                    </div>
                  </div>
                </div>

                {/* Accounting Categories Mapping (KeyInfo!BA2:BA180) */}
                <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "16px" }}>
                  <h4 style={{ margin: "0 0 14px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                    Category mapping rules
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                    {[
                      { key: "revenue", label: "Revenue", max: 16, cell: "KeyInfo!BA2:BA17" },
                      { key: "cosStaffCosts", label: "COS staff costs", max: 15, cell: "KeyInfo!BA19:BA33" },
                      { key: "nonCosStaffCosts", label: "Non-COS staff costs", max: 14, cell: "KeyInfo!BA35:BA48" },
                      { key: "corporationTax", label: "Corporation tax", max: 3, cell: "KeyInfo!BA50:BA52" },
                      { key: "depreciation", label: "Depreciation", max: 3, cell: "KeyInfo!BA54:BA56" },
                      { key: "otherCostOfSale", label: "Other costs of sale", max: 20, cell: "KeyInfo!BA59:BA78" },
                      { key: "nonOperatingIncome", label: "Non-operating income", max: 19, cell: "KeyInfo!BA81:BA99" },
                      { key: "nonOperatingExpenses", label: "Non-operating expenses", max: 26, cell: "KeyInfo!BA101:BA126" },
                      { key: "ignore", label: "Ignore / exclude", max: 53, cell: "KeyInfo!BA128:BA180" }
                    ].map(group => {
                      const list = settings.accounting?.mappings?.[group.key] || [];
                      return (
                        <div key={group.key} style={{ background: "#F8FAFC", padding: "10px 12px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                            <label style={{ fontSize: "12px", fontWeight: "600", color: "#1E293B" }}>{group.label}</label>
                            <span style={{ fontSize: "10px", color: list.length > group.max ? "#DC2626" : "#64748B", fontWeight: "600" }}>
                              {list.length} / {group.max}
                            </span>
                          </div>
                          <textarea
                            rows={3}
                            value={list.join("\n")}
                            onChange={(e) => {
                              const items = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                              updateSettingsField(prev => ({
                                ...prev,
                                accounting: {
                                  ...prev.accounting,
                                  mappings: { ...prev.accounting.mappings, [group.key]: items }
                                }
                              }));
                            }}
                            placeholder="One category per line..."
                            style={{ width: "100%", padding: "6px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", boxSizing: "border-box" }}
                          />
                          {renderCellRef(group.cell)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── 4. CRM (MERGED) ─────────────────────────────────────────── */}
            {activeSection === "crm" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
                  <div>
                    <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>CRM status mapping</h3>
                    <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                      Maps raw CRM deal/opportunity stages to probability likelihood % and start date adjust rules.
                    </p>
                    {renderCellRef("KeyInfo!L32:N75")}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      updateSettingsField(prev => ({
                        ...prev,
                        crmStatusMapping: [...(prev.crmStatusMapping || []), { status: "", likelihood: "50%", startDateRule: "1" }]
                      }));
                    }}
                    style={{
                      padding: "6px 12px",
                      background: "#0066CC",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    + Add status
                  </button>
                </div>

                {(settings.crmStatusMapping || []).length === 0 ? (
                  <div style={{ padding: "30px", textAlign: "center", background: "#F8FAFC", borderRadius: "8px", border: "1px dashed #CBD5E1", color: "#64748B", fontSize: "13px" }}>
                    No CRM statuses mapped yet. Click &quot;+ Add status&quot; to add one.
                  </div>
                ) : (
                  <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                      <thead>
                        <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                          <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569" }}>CRM status / stage name</th>
                          <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "140px" }}>Likelihood %</th>
                          <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "180px" }}>Start date rule</th>
                          <th style={{ padding: "8px 12px", width: "60px" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {settings.crmStatusMapping.map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                            <td style={{ padding: "6px 12px" }}>
                              <input
                                type="text"
                                value={item.status || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => {
                                    const next = [...prev.crmStatusMapping];
                                    next[idx] = { ...next[idx], status: val };
                                    return { ...prev, crmStatusMapping: next };
                                  });
                                }}
                                placeholder="e.g. Qualified, Presentation, Closed Won"
                                style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                              />
                            </td>
                            <td style={{ padding: "6px 12px" }}>
                              <input
                                type="text"
                                value={item.likelihood || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => {
                                    const next = [...prev.crmStatusMapping];
                                    next[idx] = { ...next[idx], likelihood: val };
                                    return { ...prev, crmStatusMapping: next };
                                  });
                                }}
                                placeholder="e.g. 50%"
                                style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                              />
                            </td>
                            <td style={{ padding: "6px 12px" }}>
                              <select
                                value={item.startDateRule || "1"}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateSettingsField(prev => {
                                    const next = [...prev.crmStatusMapping];
                                    next[idx] = { ...next[idx], startDateRule: val };
                                    return { ...prev, crmStatusMapping: next };
                                  });
                                }}
                                style={{ width: "100%", padding: "5px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                              >
                                {CRM_START_DATE_RULES.map(r => (
                                  <option key={r} value={r}>Rule {r}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: "6px 12px", textAlign: "right" }}>
                              <button
                                type="button"
                                onClick={() => {
                                  updateSettingsField(prev => ({
                                    ...prev,
                                    crmStatusMapping: prev.crmStatusMapping.filter((_, i) => i !== idx)
                                  }));
                                }}
                                style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                                title="Delete row"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── 5. JOBS (ALL DISPLAYED WITH HEADERS) ────────────────────── */}
            {activeSection === "jobs" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Jobs configuration</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Project date adjustments, product line definitions, and client lead source mappings.
                  </p>
                </div>

                {/* Sub-section 1: Date adjustments */}
                <div style={{ marginBottom: "28px" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Date adjustments</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Project start date
                      </label>
                      <select
                        value={settings.jobs?.dateAdjustment?.projectStartDate || PROJECT_DATE_ADJUST_OPTIONS[1]}
                        onChange={(e) => updateSettingsField(prev => ({
                          ...prev,
                          jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, projectStartDate: e.target.value } }
                        }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PROJECT_DATE_ADJUST_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F15")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Project end date
                      </label>
                      <select
                        value={settings.jobs?.dateAdjustment?.projectEndDate || PROJECT_DATE_ADJUST_OPTIONS[2]}
                        onChange={(e) => updateSettingsField(prev => ({
                          ...prev,
                          jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, projectEndDate: e.target.value } }
                        }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {PROJECT_DATE_ADJUST_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F16")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Retainer dates
                      </label>
                      <select
                        value={settings.jobs?.dateAdjustment?.retainerDates || RETAINER_DATES_OPTIONS[1]}
                        onChange={(e) => updateSettingsField(prev => ({
                          ...prev,
                          jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, retainerDates: e.target.value } }
                        }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {RETAINER_DATES_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F17")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Retainer duration
                      </label>
                      <select
                        value={settings.jobs?.dateAdjustment?.retainerDur || RETAINER_DUR_OPTIONS[0]}
                        onChange={(e) => updateSettingsField(prev => ({
                          ...prev,
                          jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, retainerDur: e.target.value } }
                        }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {RETAINER_DUR_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F18")}
                    </div>

                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "4px" }}>
                        Move CRM dates if in past?
                      </label>
                      <select
                        value={settings.jobs?.dateAdjustment?.moveCrmDatesIfPast || MOVE_CRM_DATES_OPTIONS[1]}
                        onChange={(e) => updateSettingsField(prev => ({
                          ...prev,
                          jobs: { ...prev.jobs, dateAdjustment: { ...prev.jobs.dateAdjustment, moveCrmDatesIfPast: e.target.value } }
                        }))}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", boxSizing: "border-box" }}
                      >
                        {MOVE_CRM_DATES_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("KeyInfo!F19")}
                    </div>
                  </div>
                </div>

                {/* Sub-section 2: Product lines */}
                <div style={{ marginBottom: "28px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Product lines</h4>
                  
                  {/* 15 Product Lines */}
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                      Product line names (up to 15)
                    </div>
                    {renderCellRef("KeyInfo!B23:B37")}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px", marginTop: "8px" }}>
                      {Array.from({ length: 15 }, (_, i) => {
                        const val = settings.jobs?.productLines?.[i] || "";
                        return (
                          <div key={i}>
                            <label style={{ fontSize: "11px", color: "#64748B", display: "block", marginBottom: "2px" }}>
                              Product line {i + 1}
                            </label>
                            <input
                              type="text"
                              value={val}
                              onChange={(e) => {
                                const next = [...(settings.jobs?.productLines || [])];
                                next[i] = e.target.value;
                                updateSettingsField(prev => ({
                                  ...prev,
                                  jobs: { ...prev.jobs, productLines: next }
                                }));
                              }}
                              placeholder={`PL${i + 1} name`}
                              style={{ width: "100%", padding: "6px 10px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Product Line Mappings */}
                  <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                          CRM product line mappings
                        </div>
                        {renderCellRef("KeyInfo!D22:E62")}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          updateSettingsField(prev => ({
                            ...prev,
                            jobs: {
                              ...prev.jobs,
                              productLineMappings: [...(prev.jobs?.productLineMappings || []), { crmProductLine: "", mappedTo: "" }]
                            }
                          }));
                        }}
                        style={{ padding: "4px 10px", background: "#0066CC", color: "#fff", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
                      >
                        + Add mapping
                      </button>
                    </div>

                    <div style={{ maxHeight: "250px", overflowY: "auto" }}>
                      {(settings.jobs?.productLineMappings || []).map((m, idx) => (
                        <div key={idx} style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                          <input
                            type="text"
                            value={m.crmProductLine || ""}
                            onChange={(e) => {
                              const next = [...settings.jobs.productLineMappings];
                              next[idx] = { ...next[idx], crmProductLine: e.target.value };
                              updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, productLineMappings: next } }));
                            }}
                            placeholder="Raw CRM product name..."
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                          />
                          <span style={{ color: "#94A3B8" }}>→</span>
                          <input
                            type="text"
                            value={m.mappedTo || ""}
                            onChange={(e) => {
                              const next = [...settings.jobs.productLineMappings];
                              next[idx] = { ...next[idx], mappedTo: e.target.value };
                              updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, productLineMappings: next } }));
                            }}
                            placeholder="Mapped product line (e.g. PL1 - Test)..."
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              updateSettingsField(prev => ({
                                ...prev,
                                jobs: {
                                  ...prev.jobs,
                                  productLineMappings: prev.jobs.productLineMappings.filter((_, i) => i !== idx)
                                }
                              }));
                            }}
                            style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Sub-section 3: Lead sources */}
                <div style={{ paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Lead sources</h4>
                  
                  {/* Client-specific lead sources */}
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                      Client-specific lead sources (max 10)
                    </div>
                    <textarea
                      rows={5}
                      value={(settings.jobs?.leadSources || []).join("\n")}
                      onChange={(e) => {
                        const items = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                        updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSources: items } }));
                      }}
                      placeholder="One lead source per line (e.g. Referral, Website, Inbound Email)..."
                      style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                    />
                    <div style={{ fontSize: "11px", color: "#64748B", marginTop: "2px" }}>
                      {(settings.jobs?.leadSources || []).length} / 10 sources
                    </div>
                    {renderCellRef("KeyInfo!G63:G72")}
                  </div>

                  {/* Lead Sources Mappings */}
                  <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                          Lead source mappings
                        </div>
                        {renderCellRef("KeyInfo!I32:J75")}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          updateSettingsField(prev => ({
                            ...prev,
                            jobs: {
                              ...prev.jobs,
                              leadSourceMappings: [...(prev.jobs?.leadSourceMappings || []), { crmSource: "", mappedTo: "" }]
                            }
                          }));
                        }}
                        style={{ padding: "4px 10px", background: "#0066CC", color: "#fff", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}
                      >
                        + Add mapping
                      </button>
                    </div>

                    <div style={{ maxHeight: "250px", overflowY: "auto" }}>
                      {(settings.jobs?.leadSourceMappings || []).map((m, idx) => (
                        <div key={idx} style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                          <input
                            type="text"
                            value={m.crmSource || ""}
                            onChange={(e) => {
                              const next = [...settings.jobs.leadSourceMappings];
                              next[idx] = { ...next[idx], crmSource: e.target.value };
                              updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSourceMappings: next } }));
                            }}
                            placeholder="Raw CRM source..."
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                          />
                          <span style={{ color: "#94A3B8" }}>→</span>
                          <input
                            type="text"
                            value={m.mappedTo || ""}
                            onChange={(e) => {
                              const next = [...settings.jobs.leadSourceMappings];
                              next[idx] = { ...next[idx], mappedTo: e.target.value };
                              updateSettingsField(prev => ({ ...prev, jobs: { ...prev.jobs, leadSourceMappings: next } }));
                            }}
                            placeholder="Mapped lead source..."
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "12px" }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              updateSettingsField(prev => ({
                                ...prev,
                                jobs: {
                                  ...prev.jobs,
                                  leadSourceMappings: prev.jobs.leadSourceMappings.filter((_, i) => i !== idx)
                                }
                              }));
                            }}
                            style={{ background: "none", border: "none", color: "#DC2626", cursor: "pointer", fontSize: "14px" }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* ── 6. AUTOMATIONS (ADMIN ONLY - ALL DISPLAYED WITH HEADERS) ── */}
            {activeSection === "automation" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Automations & tolerances</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Comparison rolling windows, tolerance thresholds, and discrepancy rules.
                  </p>
                </div>

                {/* Sub-section 1: Invoices */}
                <div style={{ marginBottom: "28px" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Invoices</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginBottom: "20px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months to compare</label>
                      <select
                        value={String(settings.automation?.invoices?.monthsToCompare || "6")}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthsToCompare: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {MONTHS_COMPARE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt} months</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B32")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months for others</label>
                      <select
                        value={String(settings.automation?.invoices?.monthsForOthers || "6")}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthsForOthers: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {MONTHS_COMPARE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt} months</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B33")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Handling method</label>
                      <select
                        value={settings.automation?.invoices?.handlingMethod || INVOICE_HANDLING_METHOD_OPTIONS[1]}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, handlingMethod: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {INVOICE_HANDLING_METHOD_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!D39")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Month tolerance</label>
                      <input
                        type="text"
                        value={settings.automation?.invoices?.monthTolerance || "0"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, monthTolerance: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("DataChgAlert!F39")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Include half/third amounts?</label>
                      <select
                        value={settings.automation?.invoices?.includeHalfThird || "Yes"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, includeHalfThird: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {YES_NO_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!H39")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default project invoicing</label>
                      <select
                        value={settings.automation?.invoices?.defaultProjectInvoiceDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2]}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultProjectInvoiceDetails: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {DEFAULT_INVOICING_DETAILS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B50")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default retainer invoice date</label>
                      <input
                        type="text"
                        value={settings.automation?.invoices?.defaultRetainerInvoiceDate || "28"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultRetainerInvoiceDate: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("DataChgAlert!B51")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default days to pay</label>
                      <input
                        type="text"
                        value={settings.automation?.invoices?.defaultDaysToPay || "30"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, defaultDaysToPay: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("DataChgAlert!B52")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Update days to pay on new month</label>
                      <select
                        value={settings.automation?.invoices?.updateDaysToPayNewMonth || "Yes"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, updateDaysToPayNewMonth: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {YES_NO_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B47")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Create invoices for retainers</label>
                      <select
                        value={settings.automation?.invoices?.createInvoiceRowsRetainers || "Yes"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, invoices: { ...prev.automation.invoices, createInvoiceRowsRetainers: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {YES_NO_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B48")}
                    </div>
                  </div>

                  {/* Discrepancy Rules for Invoices */}
                  <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                      Invoice discrepancy rules (dashboard compare)
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                      {[
                        { key: "missingInvoice", label: "Missing invoice?", cell: "DataChgAlert!B39" },
                        { key: "clientMismatch", label: "Client mismatch", cell: "DataChgAlert!B40" },
                        { key: "invAmtMismatch", label: "Inv amt mismatch?", cell: "DataChgAlert!B41" },
                        { key: "sentDateMismatch", label: "Sent date mismatch?", cell: "DataChgAlert!B42" },
                        { key: "duplicateInvNo", label: "Duplicate inv no?", cell: "DataChgAlert!B43" },
                        { key: "fullyPaidMismatch", label: "Fully paid on mismatch?", cell: "DataChgAlert!B44" },
                        { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B45" }
                      ].map(r => (
                        <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFFFF", padding: "6px 10px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
                          <div>
                            <span style={{ fontSize: "12px", color: "#334155" }}>{r.label}</span>
                            {renderCellRef(r.cell)}
                          </div>
                          <select
                            value={settings.automation?.invoices?.discrepancies?.[r.key] || "Include"}
                            onChange={(e) => {
                              const val = e.target.value;
                              updateSettingsField(prev => ({
                                ...prev,
                                automation: {
                                  ...prev.automation,
                                  invoices: {
                                    ...prev.automation.invoices,
                                    discrepancies: { ...prev.automation.invoices.discrepancies, [r.key]: val }
                                  }
                                }
                              }));
                            }}
                            style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                          >
                            {DISCREPANCY_GAS_OPTIONS.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Sub-section 2: Expenses */}
                <div style={{ marginBottom: "28px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Expenses</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px", marginBottom: "20px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months to compare</label>
                      <select
                        value={String(settings.automation?.expenses?.monthsToCompare || "6")}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthsToCompare: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {MONTHS_COMPARE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt} months</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B101")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Months for others</label>
                      <select
                        value={String(settings.automation?.expenses?.monthsForOthers || "6")}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthsForOthers: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {MONTHS_COMPARE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt} months</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B102")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default direct cost receiving</label>
                      <select
                        value={settings.automation?.expenses?.defaultDirectCostDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2]}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, defaultDirectCostDetails: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {DEFAULT_INVOICING_DETAILS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B105")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Default retainer expense date</label>
                      <input
                        type="text"
                        value={settings.automation?.expenses?.defaultRetainerExpenseDate || "28"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, defaultRetainerExpenseDate: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("DataChgAlert!B106")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Handling method</label>
                      <select
                        value={settings.automation?.expenses?.handlingMethod || EXPENSE_HANDLING_METHOD_OPTIONS[1]}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, handlingMethod: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {EXPENSE_HANDLING_METHOD_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!H111")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Month tolerance</label>
                      <input
                        type="text"
                        value={settings.automation?.expenses?.monthTolerance || "0"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, expenses: { ...prev.automation.expenses, monthTolerance: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                      {renderCellRef("DataChgAlert!J111")}
                    </div>
                  </div>

                  {/* Discrepancy Rules for Expenses */}
                  <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>
                      Expense discrepancy rules (dashboard compare)
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                      {[
                        { key: "missingCost", label: "Missing cost?", cell: "DataChgAlert!B111" },
                        { key: "duplicateAppId", label: "Duplicate app ID?", cell: "DataChgAlert!B112" },
                        { key: "descrMismatch", label: "Descr. mismatch?", cell: "DataChgAlert!B113" },
                        { key: "amountMismatch", label: "Amount mismatch?", cell: "DataChgAlert!B114" },
                        { key: "vatMismatch", label: "VAT mismatch?", cell: "DataChgAlert!B115" },
                        { key: "recDateMismatch", label: "Rec date mismatch?", cell: "DataChgAlert!B116" },
                        { key: "payDateMismatch", label: "Pay date mismatch?", cell: "DataChgAlert!B117" },
                        { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B118" }
                      ].map(r => (
                        <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFFFF", padding: "6px 10px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
                          <div>
                            <span style={{ fontSize: "12px", color: "#334155" }}>{r.label}</span>
                            {renderCellRef(r.cell)}
                          </div>
                          <select
                            value={settings.automation?.expenses?.discrepancies?.[r.key] || "Include"}
                            onChange={(e) => {
                              const val = e.target.value;
                              updateSettingsField(prev => ({
                                ...prev,
                                automation: {
                                  ...prev.automation,
                                  expenses: {
                                    ...prev.automation.expenses,
                                    discrepancies: { ...prev.automation.expenses.discrepancies, [r.key]: val }
                                  }
                                }
                              }));
                            }}
                            style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                          >
                            {DISCREPANCY_GAS_OPTIONS.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Sub-section 3: CRM Discrepancy Rules */}
                <div style={{ paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
                  <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>CRM discrepancy rules</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "18px" }}>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>CRM months to compare</label>
                      <select
                        value={String(settings.automation?.crm?.monthsToCompare || "6")}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, crm: { ...prev.automation.crm, monthsToCompare: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {MONTHS_COMPARE_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt} months</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B55")}
                    </div>
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "block", marginBottom: "3px" }}>Pipeline mode - add jobs to confirmed?</label>
                      <select
                        value={settings.automation?.crm?.pipelineAddJobsToConf || "Yes"}
                        onChange={(e) => updateSettingsField(prev => ({ ...prev, automation: { ...prev.automation, crm: { ...prev.automation.crm, pipelineAddJobsToConf: e.target.value } } }))}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        {YES_NO_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                      {renderCellRef("DataChgAlert!B82")}
                    </div>
                  </div>

                  {/* Dual Action Tables */}
                  {[
                    { key: "dashPipe", title: "Pipeline: dashboard compare", cell: "DataChgAlert!A59:C66" },
                    { key: "dashConf", title: "Confirmed: dashboard compare", cell: "DataChgAlert!D59:F66" },
                    { key: "crmPipe", title: "Pipeline: CRM app compare", cell: "DataChgAlert!A72:C79" },
                    { key: "crmConf", title: "Confirmed: CRM app compare", cell: "DataChgAlert!D72:F79" }
                  ].map(table => {
                    const rules = settings.automation?.crm?.rules?.[table.key] || [];
                    return (
                      <div key={table.key} style={{ background: "#F8FAFC", borderRadius: "8px", padding: "14px", border: "1px solid #E2E8F0", marginBottom: "14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                          <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                            {table.title}
                          </div>
                          {renderCellRef(table.cell)}
                        </div>
                        <div style={{ border: "1px solid #E2E8F0", borderRadius: "6px", overflow: "hidden", background: "#FFFFFF" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                            <thead>
                              <tr style={{ background: "#F1F5F9", borderBottom: "1px solid #E2E8F0", textAlign: "left" }}>
                                <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Discrepancy rule</th>
                                <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>GAS automation</th>
                                <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>PMA alerts</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rules.map((r, rIdx) => (
                                <tr key={rIdx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                                  <td style={{ padding: "6px 10px", color: "#334155", fontWeight: "500" }}>{r.label}</td>
                                  <td style={{ padding: "6px 10px" }}>
                                    <select
                                      value={r.gasAction || "Include"}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        updateSettingsField(prev => {
                                          const nextRules = [...(prev.automation?.crm?.rules?.[table.key] || [])];
                                          nextRules[rIdx] = { ...nextRules[rIdx], gasAction: val };
                                          return {
                                            ...prev,
                                            automation: {
                                              ...prev.automation,
                                              crm: {
                                                ...prev.automation.crm,
                                                rules: { ...prev.automation.crm.rules, [table.key]: nextRules }
                                              }
                                            }
                                          };
                                        });
                                      }}
                                      style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                                    >
                                      {DISCREPANCY_GAS_OPTIONS.map(opt => (
                                        <option key={opt} value={opt}>{opt}</option>
                                      ))}
                                    </select>
                                  </td>
                                  <td style={{ padding: "6px 10px" }}>
                                    <select
                                      value={r.pmaAction || "Include"}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        updateSettingsField(prev => {
                                          const nextRules = [...(prev.automation?.crm?.rules?.[table.key] || [])];
                                          nextRules[rIdx] = { ...nextRules[rIdx], pmaAction: val };
                                          return {
                                            ...prev,
                                            automation: {
                                              ...prev.automation,
                                              crm: {
                                                ...prev.automation.crm,
                                                rules: { ...prev.automation.crm.rules, [table.key]: nextRules }
                                              }
                                            }
                                          };
                                        });
                                      }}
                                      style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                                    >
                                      {DISCREPANCY_PMA_OPTIONS.map(opt => (
                                        <option key={opt} value={opt}>{opt}</option>
                                      ))}
                                    </select>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 7. PULSE (CLIENT SHEET APPDATA) ─────────────────────────── */}
            {activeSection === "pulse" && (
              <div>
                <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Pulse portal features</h3>
                  <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
                    Configure client-facing navigation menus, chart views, and financial ratios displayed in the Pulse portal.
                  </p>
                </div>

                <div style={{ background: "#F8FAFC", borderRadius: "10px", padding: "16px 20px", border: "1px solid #E2E8F0" }}>
                  {renderToggle(
                    "Show staff costs to revenue / income ratio?",
                    settings.pulse?.showStaffCostsRatio === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showStaffCostsRatio: v ? "Yes" : "No" } })),
                    "Controls visibility of the staff costs efficiency ratio card in the client portal.",
                    "AppData!W42"
                  )}

                  {renderToggle(
                    "Show cash menu?",
                    settings.pulse?.showCashMenu === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showCashMenu: v ? "Yes" : "No" } })),
                    "Enables access to the rolling cash forecast screen in the client navigation.",
                    "AppData!W43"
                  )}

                  {renderToggle(
                    "Show budget functionality?",
                    settings.pulse?.showBudget === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showBudget: v ? "Yes" : "No" } })),
                    "Enables the annual budget and variance reporting view.",
                    "AppData!W44"
                  )}

                  {renderToggle(
                    "Show cashflow chart?",
                    settings.pulse?.showCashflowChart === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showCashflowChart: v ? "Yes" : "No" } })),
                    "Renders the interactive cashflow chart on the Cash screen.",
                    "AppData!G59"
                  )}

                  {renderToggle(
                    "Show 'last 12 months' chart?",
                    settings.pulse?.showLast12MonthsChart === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showLast12MonthsChart: v ? "Yes" : "No" } })),
                    "Displays historical 12-month performance trajectory charts.",
                    "AppData!G71"
                  )}

                  {renderToggle(
                    "Show trendlines?",
                    settings.pulse?.showTrendlines === "Yes",
                    (v) => updateSettingsField(prev => ({ ...prev, pulse: { ...prev.pulse, showTrendlines: v ? "Yes" : "No" } })),
                    "Plots trendline regressions across monthly performance charts.",
                    "AppData!I71"
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── MODAL: PULL & SELECT BANK ACCOUNTS FROM ACCOUNTING TOOL ─────────── */}
      {showBankModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(15, 23, 42, 0.6)",
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}>
          <div style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            width: "100%",
            maxWidth: "580px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
            overflow: "hidden"
          }}>
            {/* Modal Header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                  Select bank accounts from {resolvedAccountingTool}
                </h3>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                  Check the accounts to include in Pulse (stored in KeyInfo!H12:H22). Maximum 11 accounts.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBankModal(false)}
                style={{ background: "none", border: "none", fontSize: "18px", color: "#64748B", cursor: "pointer", padding: "0 4px" }}
              >
                ✕
              </button>
            </div>

            {/* Modal Filter & Selection Toolbar */}
            <div style={{ padding: "12px 20px", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
              <input
                type="text"
                value={bankSearchQuery}
                onChange={(e) => setBankSearchQuery(e.target.value)}
                placeholder="Filter accounts by name, code, currency..."
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  borderRadius: "6px",
                  border: "1px solid #CBD5E1",
                  fontSize: "12px",
                  background: "#FFFFFF",
                  boxSizing: "border-box"
                }}
              />

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                <span style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: tempSelectedBankAccounts.length > 11 ? "#DC2626" : (tempSelectedBankAccounts.length === 11 ? "#D97706" : "#0066CC"),
                  background: tempSelectedBankAccounts.length > 11 ? "#FEF2F2" : "#EFF6FF",
                  padding: "3px 8px",
                  borderRadius: "6px"
                }}>
                  {tempSelectedBankAccounts.length} / 11 selected
                </span>
                {tempSelectedBankAccounts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTempSelectedBankAccounts([])}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#64748B",
                      fontSize: "11px",
                      cursor: "pointer",
                      textDecoration: "underline"
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Accounts Checklist Content */}
            <div style={{ padding: "12px 20px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
              {filteredModalAccounts.length === 0 ? (
                <div style={{ padding: "30px", textAlign: "center", color: "#64748B", fontSize: "13px" }}>
                  No accounts found matching &quot;{bankSearchQuery}&quot;.
                </div>
              ) : (
                filteredModalAccounts.map((acc) => {
                  const isChecked = tempSelectedBankAccounts.includes(acc.name);
                  const isMaxReached = !isChecked && tempSelectedBankAccounts.length >= 11;

                  return (
                    <div
                      key={acc.id || acc.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (!isMaxReached || isChecked) {
                          handleToggleBankAccount(acc.name);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (!isMaxReached || isChecked) {
                            handleToggleBankAccount(acc.name);
                          }
                        }
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: isChecked ? "1.5px solid #0066CC" : "1px solid #E2E8F0",
                        background: isChecked ? "#EFF6FF" : "#FFFFFF",
                        cursor: isMaxReached && !isChecked ? "not-allowed" : "pointer",
                        opacity: isMaxReached && !isChecked ? 0.6 : 1,
                        transition: "all 0.12s ease",
                        userSelect: "none"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
                        <div
                          style={{
                            width: "20px",
                            height: "20px",
                            borderRadius: "5px",
                            border: isChecked ? "2px solid #0066CC" : "2px solid #CBD5E1",
                            background: isChecked ? "#0066CC" : "#FFFFFF",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            transition: "all 0.15s ease",
                            boxShadow: isChecked ? "0 1px 2px rgba(0, 102, 204, 0.25)" : "none"
                          }}
                        >
                          {isChecked && (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="2.5 6 5 8.5 9.5 3.5" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: isChecked ? "700" : "500", color: "#0F172A" }}>
                            {acc.name}
                          </div>
                          <div style={{ fontSize: "11px", color: "#64748B", marginTop: "2px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            {acc.code && <span style={{ background: "#F1F5F9", padding: "1px 6px", borderRadius: "4px", color: "#334155" }}>Code: {acc.code}</span>}
                            {acc.accountNumber && <span>Acct: ••••{acc.accountNumber.slice(-4)}</span>}
                            {acc.currency && <span style={{ background: "#E0E7FF", color: "#3730A3", padding: "1px 5px", borderRadius: "4px", fontWeight: "600" }}>{acc.currency}</span>}
                            {acc.subType && <span>{acc.subType}</span>}
                          </div>
                        </div>
                      </div>

                      {isChecked && (
                        <span style={{ fontSize: "11px", fontWeight: "700", color: "#0066CC", background: "#DBEAFE", padding: "2px 8px", borderRadius: "10px" }}>
                          ✓ Included
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ padding: "14px 20px", borderTop: "1px solid #E2E8F0", background: "#F8FAFC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => setShowBankModal(false)}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleApplyBankSelection}
                disabled={tempSelectedBankAccounts.length > 11}
                style={{
                  padding: "7px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: tempSelectedBankAccounts.length > 11 ? "#94A3B8" : "#0066CC",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: tempSelectedBankAccounts.length > 11 ? "not-allowed" : "pointer"
                }}
              >
                Apply selection ({tempSelectedBankAccounts.length} accounts)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
