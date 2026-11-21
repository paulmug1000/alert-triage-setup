import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";
import { BudgetSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useFocusRevalidate } from "../hooks/useFocusRevalidate";
import { formatMoney as universalFormatMoney } from "../services/deepDiveHelper";
import { downloadCsv, sanitizeSpreadsheetTerms } from "../utils/helpers";
import {
  roundYear0,
  toYear0InputStrings,
  parseYear0InputsToNumbers,
  resolveYear0CurrencySymbol,
  computeYear0PnL,
  getYear0MarginColor,
} from "../utils/year0Calc";

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0)) >= 0.005) return false;
  }
  return true;
}

export default function Year0EditView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient,
  onRegisterNavGuard,
}) {
  const { user } = useAuth();
  const isSysAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
  const isReadOnly = Boolean(user?.isReadOnly);
  const { getCachedClientData, setCachedClientData } = useAppGlobals();

  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (
        (allOutgoingsClients || []).find(
          (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
        ) || managedClient
      );
    }
    if (initialClient) {
      const targetStr =
        typeof initialClient === "string"
          ? initialClient.toLowerCase()
          : initialClient?.clientName?.toLowerCase();
      return (
        (allOutgoingsClients || []).find((c) => c.clientName?.toLowerCase() === targetStr) ||
        (typeof initialClient === "object" ? initialClient : null)
      );
    }
    return null;
  });

  const getCacheId = useCallback(
    (client) => client?.masterSheetId || client?.clientSheetId || client?.clientName || "",
    []
  );

  const [year0Data, setYear0Data] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    const cacheId = getCacheId(target);
    if (cacheId) {
      const cached = getCachedClientData(cacheId, "year0");
      if (cached?.data) return cached.data;
    }
    return null;
  });

  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // Editable Year 0 state (matching Setup Year 0 stage)
  const [deliveryPct, setDeliveryPct] = useState("0");
  const [dividendInputs, setDividendInputs] = useState(() => Array(12).fill(""));
  const [applyAllDividendsVal, setApplyAllDividendsVal] = useState("");
  const [revAdjInputs, setRevAdjInputs] = useState(() => Array(12).fill(""));
  const [cosAdjInputs, setCosAdjInputs] = useState(() => Array(12).fill(""));
  const [ohAdjInputs, setOhAdjInputs] = useState(() => Array(12).fill(""));
  const [savedSnapshot, setSavedSnapshot] = useState(null);

  // Expandable nominal category breakdowns
  const [expandedSections, setExpandedSections] = useState({
    revenue: false,
    cos: false,
    overheads: false,
  });

  // Detected Dividends / Directors' Loan Account state from Xero or QuickBooks
  const [detectingDividends, setDetectingDividends] = useState(false);
  const [dividendHints, setDividendHints] = useState(null);
  const [detectDividendsError, setDetectDividendsError] = useState("");

  // Unsaved changes navigation guard modal
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingNavAction, setPendingNavAction] = useState(null);
  const [modalSaveError, setModalSaveError] = useState("");

  const activeClientKeyRef = useRef("");

  const formatApiError = useCallback(
    (msg, fallback) => {
      const raw = msg || fallback;
      return isSysAdmin ? raw : sanitizeSpreadsheetTerms(raw);
    },
    [isSysAdmin]
  );

  const hydrateFromPayload = useCallback((payload) => {
    setYear0Data(payload);
    const pct = roundYear0(payload?.dividends?.deliveryPct ?? 0);
    const divs = toYear0InputStrings(payload?.dividends?.monthly);
    const rev = toYear0InputStrings(payload?.adjustments?.revenue);
    const cos = toYear0InputStrings(payload?.adjustments?.costOfSales);
    const oh = toYear0InputStrings(payload?.adjustments?.overheads);

    setDeliveryPct(String(pct));
    setDividendInputs(divs);
    setRevAdjInputs(rev);
    setCosAdjInputs(cos);
    setOhAdjInputs(oh);
    setSavedSnapshot({
      deliveryPct: pct,
      monthlyDividends: parseYear0InputsToNumbers(divs),
      revAdj: parseYear0InputsToNumbers(rev),
      cosAdj: parseYear0InputsToNumbers(cos),
      ohAdj: parseYear0InputsToNumbers(oh),
    });
  }, []);

  // Hydrate initial state if cached data was present on mount
  useEffect(() => {
    if (year0Data && !savedSnapshot) {
      hydrateFromPayload(year0Data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronize client selection with managedClient / initialClient
  useEffect(() => {
    if (managedClient) {
      const match =
        (allOutgoingsClients || []).find(
          (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
        ) || managedClient;
      setSelectedClient((prev) => {
        if (prev?.clientName?.toLowerCase() !== match?.clientName?.toLowerCase()) {
          setYear0Data(null);
          setSavedSnapshot(null);
          setDividendHints(null);
          setDetectDividendsError("");
          setApplyAllDividendsVal("");
          setError(null);
          setLoading(true);
        }
        return match;
      });
      return;
    }
    if (initialClient) {
      const targetStr =
        typeof initialClient === "string"
          ? initialClient.toLowerCase()
          : initialClient?.clientName?.toLowerCase();
      const match =
        (allOutgoingsClients || []).find((c) => c.clientName?.toLowerCase() === targetStr) ||
        (typeof initialClient === "object" ? initialClient : null);
      if (match) {
        setSelectedClient((prev) => {
          if (prev?.clientName?.toLowerCase() !== match?.clientName?.toLowerCase()) {
            setYear0Data(null);
            setSavedSnapshot(null);
            setDividendHints(null);
            setDetectDividendsError("");
            setApplyAllDividendsVal("");
            setError(null);
            setLoading(true);
          }
          return match;
        });
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const fetchYear0Data = useCallback(
    async (client, bypassCache = false, silent = false) => {
      if (!client?.clientName) return;
      const cacheId = getCacheId(client);
      const cached = !bypassCache && !silent && cacheId ? getCachedClientData(cacheId, "year0") : null;
      if (cached?.data) {
        hydrateFromPayload(cached.data);
        setLoading(false);
        if (!cached.isStale) return;
      } else if (!silent) {
        setLoading(true);
      }

      if (!silent) setError(null);
      const reqKey = client.clientName.toLowerCase();
      activeClientKeyRef.current = reqKey;

      try {
        const params = new URLSearchParams({ clientName: client.clientName });
        if (client.masterSheetId) params.set("masterSheetId", client.masterSheetId);
        if (client.clientSheetId) params.set("clientSheetId", client.clientSheetId);

        const res = await fetch(`/api/setup/year0?${params.toString()}`);
        const json = await res.json();
        if (activeClientKeyRef.current !== reqKey) return;
        if (!res.ok || !json.success) {
          throw new Error(json.error || "Failed to load Year 0 data.");
        }
        hydrateFromPayload(json);
        if (cacheId) {
          setCachedClientData(cacheId, "year0", json);
        }
      } catch (err) {
        console.error("fetchYear0Data error:", err);
        if (!silent && activeClientKeyRef.current === reqKey) {
          setError(formatApiError(err.message, "Failed to load Year 0 data."));
        }
      } finally {
        if (!silent && activeClientKeyRef.current === reqKey) {
          setLoading(false);
        }
      }
    },
    [getCacheId, getCachedClientData, setCachedClientData, hydrateFromPayload, formatApiError]
  );

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_year0_client", selectedClient.clientName);
      }
      fetchYear0Data(selectedClient);
    }
  }, [selectedClient, fetchYear0Data]);

  // Auto-detect dividends & drawings from Xero/QuickBooks once Year 0 P&L is present
  const handleDetectDividends = useCallback(async () => {
    if (!selectedClient?.clientName) return;
    setDetectingDividends(true);
    setDetectDividendsError("");
    const reqKey = selectedClient.clientName.toLowerCase();
    try {
      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          action: "detect_dividends",
        }),
      });
      const json = await res.json();
      if (activeClientKeyRef.current !== reqKey) return;
      if (!json.success) {
        setDetectDividendsError(formatApiError(json.error, "Could not extract dividend accounts."));
      } else {
        setDividendHints({
          accountingTool: json.accountingTool,
          candidates: json.candidates || [],
        });
      }
    } catch (err) {
      if (activeClientKeyRef.current === reqKey) {
        setDetectDividendsError(formatApiError(err.message, "Could not extract dividend accounts."));
      }
    } finally {
      if (activeClientKeyRef.current === reqKey) {
        setDetectingDividends(false);
      }
    }
  }, [selectedClient, formatApiError]);

  useEffect(() => {
    if (
      !selectedClient?.clientName ||
      !year0Data?.hasYear0PL ||
      !year0Data?.accountingTool ||
      dividendHints !== null ||
      detectingDividends
    ) {
      return;
    }
    handleDetectDividends();
  }, [selectedClient?.clientName, year0Data?.hasYear0PL, year0Data?.accountingTool, dividendHints, detectingDividends, handleDetectDividends]);

  // Compute live P&L metrics across all 12 months
  const computed = useMemo(
    () =>
      computeYear0PnL({
        data: year0Data,
        deliveryPct,
        dividendInputs,
        revAdjInputs,
        cosAdjInputs,
        ohAdjInputs,
      }),
    [year0Data, deliveryPct, dividendInputs, revAdjInputs, cosAdjInputs, ohAdjInputs]
  );

  // Determine dirty state against last saved/loaded snapshot
  const isDirty = useMemo(() => {
    if (!savedSnapshot || !year0Data?.hasYear0PL) return false;
    const currentPct = Math.max(0, Math.min(100, parseFloat(String(deliveryPct || "0")) || 0));
    if (Math.abs(roundYear0(currentPct) - roundYear0(savedSnapshot.deliveryPct)) >= 0.005) return true;
    if (!arraysEqual(computed.divNums, savedSnapshot.monthlyDividends)) return true;
    if (!arraysEqual(computed.revAdjs, savedSnapshot.revAdj)) return true;
    if (!arraysEqual(computed.cosAdjs, savedSnapshot.cosAdj)) return true;
    if (!arraysEqual(computed.ohAdjs, savedSnapshot.ohAdj)) return true;
    return false;
  }, [savedSnapshot, year0Data?.hasYear0PL, deliveryPct, computed]);

  // Register navigation guard with parent PMA NavShell
  useEffect(() => {
    if (isDirty) {
      const guard = (proceedFn) => {
        setPendingNavAction(() => proceedFn);
        setModalSaveError("");
        setShowUnsavedModal(true);
      };
      onRegisterNavGuard?.(guard);
      return () => {
        onRegisterNavGuard?.(null);
      };
    }
    onRegisterNavGuard?.(null);
  }, [isDirty, onRegisterNavGuard]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
        return e.returnValue;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useFocusRevalidate({
    enabled: Boolean(selectedClient?.clientName),
    resetKey: selectedClient?.clientName || "",
    canRevalidate: () => !loading && !pulling && !saving && !isDirty && !showUnsavedModal,
    onRevalidate: () => {
      if (selectedClient) {
        fetchYear0Data(selectedClient, true, true);
      }
    },
  });

  const guardAction = (fn) => {
    if (isDirty) {
      setPendingNavAction(() => fn);
      setModalSaveError("");
      setShowUnsavedModal(true);
    } else {
      fn();
    }
  };

  const handleBackToClients = () => {
    guardAction(() => {
      if (managedClient && onClearManagedClient) {
        onClearManagedClient();
      } else {
        setSelectedClient(null);
        setYear0Data(null);
        setSavedSnapshot(null);
        setDividendHints(null);
        onSelectClient?.(null);
        if (typeof window !== "undefined") {
          sessionStorage.removeItem("pma_year0_client");
        }
      }
    });
  };

  const executePullYear0PL = async () => {
    if (!selectedClient?.clientName || isReadOnly) return;
    setPulling(true);
    setError(null);
    setSaveSuccessMsg("");
    try {
      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          action: "pull_year0_pl",
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to pull Year 0 profit & loss.");
      }
      hydrateFromPayload(json);
      const cacheId = getCacheId(selectedClient);
      if (cacheId) setCachedClientData(cacheId, "year0", json);
      setSaveSuccessMsg("Year 0 profit & loss pulled successfully.");
      setTimeout(() => setSaveSuccessMsg(""), 4000);
    } catch (err) {
      setError(formatApiError(err.message, "Failed to pull Year 0 profit & loss."));
    } finally {
      setPulling(false);
    }
  };

  const handleSave = async () => {
    if (!selectedClient?.clientName || isReadOnly) return false;
    setSaving(true);
    setError(null);
    setSaveSuccessMsg("");
    try {
      const pctNum = Math.max(0, Math.min(100, parseFloat(String(deliveryPct || "0")) || 0));
      const monthlyDividends = parseYear0InputsToNumbers(dividendInputs);
      const categoryAdjustments = {
        revenue: parseYear0InputsToNumbers(revAdjInputs),
        costOfSales: parseYear0InputsToNumbers(cosAdjInputs),
        overheads: parseYear0InputsToNumbers(ohAdjInputs),
      };

      const res = await fetch("/api/setup/year0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          action: "save_year0_adjustments",
          deliveryPct: pctNum,
          monthlyDividends,
          categoryAdjustments,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to save Year 0 changes.");
      }
      hydrateFromPayload(json);
      const cacheId = getCacheId(selectedClient);
      if (cacheId) setCachedClientData(cacheId, "year0", json);
      setSaveSuccessMsg("Year 0 changes saved.");
      setTimeout(() => setSaveSuccessMsg(""), 3500);
      return true;
    } catch (err) {
      const msg = formatApiError(err.message, "Failed to save Year 0 changes.");
      setError(msg);
      setModalSaveError(msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleApplyAllDividends = () => {
    const trimmed = String(applyAllDividendsVal || "").trim();
    const cleaned = trimmed.replace(/[£$€,\s]/g, "");
    const num = parseFloat(cleaned);
    const valStr = trimmed === "" || !Number.isFinite(num) || num === 0 ? "" : String(roundYear0(num));
    setDividendInputs(Array(12).fill(valStr));
  };

  const updateMonthArray = (setter, index, rawVal) => {
    setter((prev) => {
      const next = [...prev];
      next[index] = rawVal;
      return next;
    });
  };

  const handleModalSaveAndContinue = async () => {
    setModalSaveError("");
    const ok = await handleSave();
    if (ok) {
      setShowUnsavedModal(false);
      const action = pendingNavAction;
      setPendingNavAction(null);
      if (typeof action === "function") action();
    }
  };

  const handleModalDiscardAndContinue = () => {
    setShowUnsavedModal(false);
    setModalSaveError("");
    if (savedSnapshot) {
      setDeliveryPct(String(savedSnapshot.deliveryPct));
      setDividendInputs(toYear0InputStrings(savedSnapshot.monthlyDividends));
      setRevAdjInputs(toYear0InputStrings(savedSnapshot.revAdj));
      setCosAdjInputs(toYear0InputStrings(savedSnapshot.cosAdj));
      setOhAdjInputs(toYear0InputStrings(savedSnapshot.ohAdj));
    }
    const action = pendingNavAction;
    setPendingNavAction(null);
    if (typeof action === "function") action();
  };

  const handleModalCancel = () => {
    setShowUnsavedModal(false);
    setPendingNavAction(null);
    setModalSaveError("");
  };

  // Currency & formatting matching BudgetView
  const currencySymbol = resolveYear0CurrencySymbol(year0Data?.currencySymbol, year0Data?.currency || "GBP");
  const thousandsSeparator = year0Data?.thousandsSeparator || (currencySymbol === "€" ? "." : ",");
  const thresholds = year0Data?.thresholds || [];
  const revLabel = year0Data?.revOrInc || "Revenue";
  const isIncomeMode = revLabel.toLowerCase() === "income";

  const formatMoney = useCallback(
    (val) => universalFormatMoney(val, 0, currencySymbol, thousandsSeparator),
    [currencySymbol, thousandsSeparator]
  );
  const formatPctDisplay = (val) => `${Math.round((val || 0) * 100)}%`;

  const periodRangeLabel = useMemo(() => {
    if (year0Data?.months?.length === 12) {
      return `${year0Data.months[0].shortLabel} – ${year0Data.months[11].shortLabel}`;
    }
    return "";
  }, [year0Data?.months]);

  const handleDownloadCSV = () => {
    if (!year0Data?.hasYear0PL) return;
    const dateStr = new Date().toISOString().split("T")[0];
    const clientSlug = (selectedClient?.clientName || "Client").replace(/[^a-z0-9]+/gi, "_");
    const monthLabels = computed.months.map((m) => m.shortLabel);
    const exportRows = [
      [`Year 0 profit & loss: ${selectedClient?.clientName || ""}`],
      [],
      ["Category", ...monthLabels, "Year 0 total"],
      [revLabel],
      [`${revLabel} (imported)`, ...computed.baseRev.map(formatMoney), formatMoney(computed.totals.baseRev)],
      [`${revLabel} adjustment (+/-)`, ...computed.revAdjs.map(formatMoney), formatMoney(computed.totals.revAdj)],
      [`Total ${revLabel.toLowerCase()}`, ...computed.revenueTotal.map(formatMoney), formatMoney(computed.totals.revenue)],
      [],
    ];

    if (computed.splitDelivery) {
      exportRows.push(
        ["Costs of sale"],
        [
          "Costs of sale (imported + delivery dividends)",
          ...computed.cosBase.map(formatMoney),
          formatMoney(computed.totals.cosBase),
        ],
        ["Cost of sales adjustment (+/-)", ...computed.cosAdjs.map(formatMoney), formatMoney(computed.totals.cosAdj)],
        ["Total costs of sale", ...computed.cosTotal.map(formatMoney), formatMoney(computed.totals.cosTotal)],
        ["Gross profit", ...computed.grossProfit.map(formatMoney), formatMoney(computed.totals.grossProfit)],
        ["Gross profit margin %", ...computed.gpMargin.map(formatPctDisplay), formatPctDisplay(computed.totals.gpMargin)],
        []
      );
    }

    exportRows.push(
      ["Overheads"],
      [
        "Overheads (imported + non-delivery dividends)",
        ...computed.overheadsBase.map(formatMoney),
        formatMoney(computed.totals.ohBase),
      ],
      ["Overheads adjustment (+/-)", ...computed.ohAdjs.map(formatMoney), formatMoney(computed.totals.ohAdj)],
      ["Total overheads", ...computed.overheadsTotal.map(formatMoney), formatMoney(computed.totals.overheadsTotal)],
      [
        isIncomeMode ? "Overheads as % of income" : "Overheads as % of revenue",
        ...computed.overheadsPct.map(formatPctDisplay),
        formatPctDisplay(computed.totals.overheadsPct),
      ],
      [],
      ["Operating profit", ...computed.operatingProfit.map(formatMoney), formatMoney(computed.totals.operatingProfit)],
      [
        "Operating profit %",
        ...computed.operatingProfitPct.map(formatPctDisplay),
        formatPctDisplay(computed.totals.operatingProfitPct),
      ],
      [],
      [
        `Dividends in lieu of salary (${deliveryPct || 0}% delivery)`,
        ...computed.divNums.map(formatMoney),
        formatMoney(computed.totals.dividends),
      ]
    );

    downloadCsv(`Pulse_Year0_${clientSlug}_${dateStr}.csv`, exportRows);
  };

  const targetSheetId = year0Data?.masterSheetId || selectedClient?.masterSheetId || selectedClient?.clientSheetId;

  // Helper to render Budget-style section header row
  const renderSectionHeader = (label) => (
    <tr style={{ height: "26px", borderBottom: "1px solid #f1f5f9" }}>
      <td
        style={{
          padding: "5px 12px",
          textAlign: "left",
          fontWeight: 700,
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.6px",
          color: "#0047AB",
          position: "sticky",
          left: 0,
          background: "#ffffff",
          zIndex: 2,
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
        }}
      >
        {label}
      </td>
      {Array.from({ length: 12 }).map((_, idx) => (
        <td key={idx} style={{ padding: 0, background: "#ffffff", border: "none" }} />
      ))}
      <td
        style={{
          padding: 0,
          background: "rgba(0, 71, 171, 0.04)",
          border: "none",
          borderLeft: "1px solid #cbd5e1",
        }}
      />
    </tr>
  );

  // Helper to render Budget-style spacer row
  const renderSpacer = (height = 8) => (
    <tr style={{ height: `${height}px`, lineHeight: 0 }}>
      <td
        style={{
          padding: 0,
          background: "#ffffff",
          position: "sticky",
          left: 0,
          zIndex: 2,
          border: "none",
        }}
      />
      {Array.from({ length: 12 }).map((_, idx) => (
        <td key={idx} style={{ padding: 0, background: "#ffffff", border: "none" }} />
      ))}
      <td
        style={{
          padding: 0,
          background: "rgba(0, 71, 171, 0.04)",
          border: "none",
          borderLeft: "1px solid #cbd5e1",
        }}
      />
    </tr>
  );

  // Helper to render Budget-style Big Total bar (#9900ff, #e69138, #45818e, #1155cc)
  const renderBigTotalRow = (label, monthlyArr, totalVal, bgColor) => (
    <tr
      style={{
        height: "32px",
        background: bgColor,
        borderBottom: "2px solid #cbd5e1",
        fontWeight: 700,
      }}
    >
      <td
        style={{
          padding: "4.5px 12px",
          textAlign: "left",
          color: "#ffffff",
          fontWeight: 700,
          fontSize: "13px",
          position: "sticky",
          left: 0,
          background: bgColor,
          zIndex: 2,
          whiteSpace: "nowrap",
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
        }}
      >
        {label}
      </td>
      {monthlyArr.map((val, idx) => (
        <td
          key={idx}
          style={{
            padding: "4.5px 4px",
            textAlign: "right",
            color: "#ffffff",
            fontSize: "13px",
            fontWeight: 700,
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatMoney(val)}
        </td>
      ))}
      <td
        style={{
          padding: "4.5px 12px",
          textAlign: "right",
          fontWeight: 700,
          fontSize: "13px",
          color: "#ffffff",
          background: bgColor,
          borderLeft: "1px solid #cbd5e1",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatMoney(totalVal)}
      </td>
    </tr>
  );

  // Helper to render Budget-style Margin % row with traffic-light threshold pills
  const renderMarginRow = (label, monthlyArr, totalVal, accentBar) => (
    <tr style={{ height: "22px", background: "#ffffff", borderBottom: "1px solid #f1f5f9" }}>
      <td
        style={{
          padding: "2px 12px 2px 22px",
          textAlign: "left",
          color: "#0047AB",
          fontWeight: 700,
          fontStyle: "italic",
          fontSize: "11px",
          position: "sticky",
          left: 0,
          background: "#ffffff",
          borderLeft: `4px solid ${accentBar}`,
          zIndex: 2,
          whiteSpace: "nowrap",
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
        }}
      >
        {label}
      </td>
      {monthlyArr.map((val, idx) => {
        const threshBg = getYear0MarginColor(label, val, thresholds);
        return (
          <td
            key={idx}
            style={{
              padding: "1px 2px",
              background: "#ffffff",
              textAlign: "right",
              height: "22px",
            }}
          >
            <div
              style={{
                display: "inline-block",
                width: "100%",
                padding: "1.5px 3px",
                borderRadius: "4px",
                background: threshBg || "transparent",
                color: "#0047AB",
                border: threshBg ? "1.5px solid #ffffff" : "none",
                fontStyle: "italic",
                fontSize: "11px",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                boxSizing: "border-box",
              }}
            >
              {formatPctDisplay(val)}
            </div>
          </td>
        );
      })}
      <td
        style={{
          padding: "2px 12px",
          textAlign: "right",
          fontWeight: 700,
          fontSize: "12px",
          color: "#0047AB",
          background: "rgba(0, 71, 171, 0.04)",
          borderLeft: "1px solid #cbd5e1",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatPctDisplay(totalVal)}
      </td>
    </tr>
  );

  // Helper to render expandable imported base row + nominal breakdown lines
  const renderExpandableBaseRow = ({ label, expanded, onToggle, monthlyArr, totalVal }) => (
    <tr style={{ height: "28px", background: "#ffffff", borderBottom: "1px solid #f1f5f9" }}>
      <td
        style={{
          padding: "5px 12px 5px 16px",
          textAlign: "left",
          color: "#0047AB",
          fontWeight: 600,
          fontSize: "11.5px",
          position: "sticky",
          left: 0,
          background: "#ffffff",
          zIndex: 2,
          whiteSpace: "nowrap",
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            fontWeight: 600,
            color: "#0047AB",
            fontSize: "11.5px",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "inherit",
          }}
        >
          <span>{expanded ? "▾" : "▸"}</span>
          <span>{label}</span>
        </button>
      </td>
      {monthlyArr.map((val, idx) => (
        <td
          key={idx}
          style={{
            padding: "4.5px 4px",
            textAlign: "right",
            color: "#0047AB",
            fontSize: "11.5px",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatMoney(val)}
        </td>
      ))}
      <td
        style={{
          padding: "4.5px 12px",
          textAlign: "right",
          fontWeight: 700,
          fontSize: "12px",
          color: "#0047AB",
          background: "rgba(0, 71, 171, 0.04)",
          borderLeft: "1px solid #cbd5e1",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatMoney(totalVal)}
      </td>
    </tr>
  );

  const renderBreakdownSubRow = (key, label, monthlyArr, totalVal, highlightAmber = false) => (
    <tr
      key={key}
      style={{
        height: "24px",
        background: highlightAmber ? "#FFFBEB" : "#F8FAFC",
        borderBottom: highlightAmber ? "1px solid #FDE68A" : "1px solid #F1F5F9",
        color: highlightAmber ? "#92400E" : "#64748B",
      }}
    >
      <td
        style={{
          position: "sticky",
          left: 0,
          zIndex: 2,
          background: highlightAmber ? "#FFFBEB" : "#F8FAFC",
          padding: "4px 12px 4px 28px",
          fontSize: "11px",
          fontWeight: highlightAmber ? 600 : 400,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
        }}
        title={label}
      >
        {label}
      </td>
      {monthlyArr.map((v, idx) => (
        <td
          key={idx}
          style={{
            padding: "4px 4px",
            textAlign: "right",
            fontSize: "11px",
            fontWeight: highlightAmber ? 600 : 400,
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatMoney(v)}
        </td>
      ))}
      <td
        style={{
          padding: "4px 12px",
          textAlign: "right",
          fontSize: "11px",
          fontWeight: highlightAmber ? 700 : 600,
          background: highlightAmber ? "#FEF3C7" : "rgba(0, 71, 171, 0.04)",
          borderLeft: "1px solid #cbd5e1",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatMoney(totalVal)}
      </td>
    </tr>
  );

  // Helper to render editable input row (always-visible inputs matching Setup Year 0 stage)
  const renderEditableInputRow = ({
    label,
    subtitle,
    values,
    onChange,
    totalValue,
    rowBg = "#f8faff",
    borderColor = "#e2e8f0",
    leftExtra = null,
  }) => (
    <tr
      style={{
        background: rowBg,
        borderTop: `1px solid ${borderColor}`,
        borderBottom: `1px solid ${borderColor}`,
      }}
    >
      <td
        style={{
          position: "sticky",
          left: 0,
          zIndex: 2,
          background: rowBg,
          padding: "6px 12px 6px 16px",
          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
          verticalAlign: "middle",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
            <span style={{ fontSize: "11.5px", fontWeight: 600, color: "#0047AB" }}>{label}</span>
            <span
              style={{
                fontSize: "10px",
                fontWeight: 700,
                background: "#dbeafe",
                color: "#1e40af",
                padding: "1px 6px",
                borderRadius: "4px",
                flexShrink: 0,
              }}
            >
              Editable
            </span>
          </div>
          {subtitle && <div style={{ fontSize: "10.5px", color: "#64748b" }}>{subtitle}</div>}
          {leftExtra}
        </div>
      </td>
      {computed.months.map((m, idx) => (
        <td key={idx} style={{ padding: "4px 2px", textAlign: "right", verticalAlign: "middle" }}>
          <input
            type="text"
            inputMode="decimal"
            disabled={isReadOnly}
            value={values[idx] ?? ""}
            onChange={(e) => onChange(idx, e.target.value)}
            placeholder="0"
            aria-label={`${label} ${m.shortLabel}`}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "4px 4px",
              fontSize: "11.5px",
              textAlign: "right",
              borderRadius: "5px",
              border: "1px solid #cbd5e1",
              background: isReadOnly ? "#f1f5f9" : "#ffffff",
              color: "#0f172a",
              fontWeight: values[idx] ? 600 : 400,
              fontVariantNumeric: "tabular-nums",
              outline: "none",
            }}
          />
        </td>
      ))}
      <td
        style={{
          padding: "6px 12px",
          textAlign: "right",
          fontWeight: 700,
          fontSize: "12px",
          color: "#0047AB",
          borderLeft: "1px solid #cbd5e1",
          background: "rgba(0, 71, 171, 0.04)",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatMoney(totalValue)}
      </td>
    </tr>
  );

  return (
    <div
      className="pma-page-container"
      style={{
        ...styles.container,
        width: "100%",
        maxWidth: "100%",
        margin: "0 auto",
        padding: "20px 32px 60px",
        boxSizing: "border-box",
        fontFamily: "'Kumbh Sans', sans-serif",
      }}
    >
      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* TOP HEADER CARD (MATCHING BUDGETVIEW)                                */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
          marginBottom: "20px",
          background: "#ffffff",
          padding: "16px 20px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {selectedClient && !managedClient && (allOutgoingsClients || []).length > 1 && (
            <button
              type="button"
              onClick={handleBackToClients}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer",
                padding: "6px 12px",
                fontSize: "16px",
                color: "#475569",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#f1f5f9";
                e.currentTarget.style.borderColor = "#94a3b8";
                e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#cbd5e1";
                e.currentTarget.style.color = "#475569";
              }}
              title="Back to client list"
            >
              ←
            </button>
          )}
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "#1e293b",
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <span>Year 0</span>
              {selectedClient && year0Data && (
                <>
                  {periodRangeLabel && (
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        color: "#0047AB",
                        background: "rgba(0, 71, 171, 0.08)",
                        padding: "2px 8px",
                        borderRadius: "4px",
                      }}
                    >
                      {periodRangeLabel}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: "12px",
                      background: "#eff6ff",
                      color: "#1d4ed8",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontWeight: 600,
                    }}
                  >
                    {isIncomeMode ? "Income mode" : "Revenue mode"}
                  </span>
                  {year0Data.basis && (
                    <span
                      style={{
                        fontSize: "12px",
                        background: "#f1f5f9",
                        color: "#475569",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontWeight: 600,
                      }}
                    >
                      {year0Data.basis} basis
                    </span>
                  )}
                  {isDirty && (
                    <span
                      style={{
                        fontSize: "11.5px",
                        background: "#FEF3C7",
                        color: "#92400E",
                        border: "1px solid #FDE68A",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontWeight: 600,
                      }}
                    >
                      Unsaved changes
                    </span>
                  )}
                </>
              )}
            </h1>
            {selectedClient && (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            )}
          </div>
        </div>

        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => guardAction(() => fetchYear0Data(selectedClient, true))}
              disabled={loading || pulling}
              title="Refresh Year 0 data"
              style={{
                padding: "6px 12px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: loading || pulling ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {loading ? <Spinner size={14} color="#0066cc" /> : "↻"} Refresh
            </button>

            {year0Data?.hasYear0PL && (
              <button
                type="button"
                onClick={handleDownloadCSV}
                title="Export Year 0 profit & loss to CSV"
                style={{
                  padding: "6px 12px",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#334155",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                Export CSV
              </button>
            )}

            {!isReadOnly && (
              <button
                type="button"
                onClick={() => guardAction(executePullYear0PL)}
                disabled={pulling || loading || saving}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #93c5fd",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: pulling || loading || saving ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {pulling && <Spinner size={13} color="#1d4ed8" />}
                {pulling ? "Pulling Year 0 P&L..." : year0Data?.hasYear0PL ? "Refresh Year 0 P&L" : "Pull Year 0 P&L"}
              </button>
            )}

            {!isReadOnly && year0Data?.hasYear0PL && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading || pulling || !isDirty}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "none",
                  background: saving || !isDirty ? "#94a3b8" : "#0047AB",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: saving || loading || pulling || !isDirty ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: isDirty ? "0 1px 2px rgba(0, 71, 171, 0.25)" : "none",
                }}
              >
                {saving && <Spinner size={13} color="#ffffff" />}
                {saving ? "Saving..." : "Save changes"}
              </button>
            )}

            {isSysAdmin && targetSheetId && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${targetSheetId}/edit#gid=0`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #166534",
                  background: "#15803d",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
                title="Open master sheet in Google Sheets"
              >
                Open in sheets
              </a>
            )}
          </div>
        )}
      </div>

      {/* CLIENT SELECTOR (WHEN NO CLIENT SELECTED) */}
      {!selectedClient && !managedClient && (
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => {
            setYear0Data(null);
            setSavedSnapshot(null);
            setDividendHints(null);
            setDetectDividendsError("");
            setApplyAllDividendsVal("");
            setError(null);
            setLoading(true);
            setSelectedClient(c);
            onSelectClient?.(c);
          }}
          loading={(allOutgoingsClients || []).length === 0}
          title="Select a client to view and edit Year 0:"
        />
      )}

      {/* NOTIFICATIONS */}
      {selectedClient && error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {selectedClient && saveSuccessMsg && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#15803d",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          ✓ {saveSuccessMsg}
        </div>
      )}

      {/* LOADING SKELETON */}
      {selectedClient && (loading || (!year0Data?.hasYear0PL && pulling)) && !year0Data && !error && (
        <BudgetSkeleton />
      )}

      {/* EMPTY STATE WHEN NO YEAR 0 P&L LOADED */}
      {selectedClient && !loading && year0Data && !year0Data.hasYear0PL && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            padding: "48px 24px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            No Year 0 profit &amp; loss figures loaded yet
          </div>
          <p style={{ fontSize: "13px", color: "#64748b", maxWidth: "520px", margin: "0 auto 20px auto" }}>
            Pull the 12 months of historical profit &amp; loss leading up to {year0Data.startDate || "the system start date"} from{" "}
            {year0Data.accountingTool || "the accounting tool"}, then review and add dividends in lieu of salary or monthly adjustments.
          </p>
          {!isReadOnly && (
            <button
              type="button"
              onClick={executePullYear0PL}
              disabled={pulling}
              style={{
                padding: "9px 18px",
                borderRadius: "8px",
                border: "none",
                background: "#0047AB",
                color: "#ffffff",
                fontWeight: 600,
                fontSize: "13px",
                cursor: pulling ? "wait" : "pointer",
              }}
            >
              {pulling ? "Pulling Year 0 P&L..." : "Pull Year 0 P&L"}
            </button>
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* YEAR 0 BUDGET-STYLE TABLE + DIVIDENDS DETECTION                       */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      {selectedClient && year0Data?.hasYear0PL && (
        <>
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              border: "1px solid #e2e8f0",
              overflow: "hidden",
              width: "100%",
              marginBottom: "24px",
            }}
          >
            {/* Table Info Header Bar (matching BudgetView) */}
            <div
              style={{
                padding: "10px 16px",
                background: "#f8fafc",
                borderBottom: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b" }}>
                  Year 0 profit &amp; loss
                </span>
                {year0Data.startDate && (
                  <span style={{ fontSize: "12px", color: "#64748b" }}>
                    · System start date: {year0Data.startDate}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", color: "#475569", flexWrap: "wrap" }}>
                <span
                  style={{
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    color: "#1d4ed8",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontWeight: 600,
                  }}
                >
                  Adjustments and dividends are editable
                </span>
                <span>Edit monthly figures below, then click Save changes</span>
              </div>
            </div>

            <div style={{ overflowX: "auto", width: "100%" }}>
              <table
                style={{
                  width: "100%",
                  minWidth: "1080px",
                  tableLayout: "fixed",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  fontSize: "11.5px",
                  fontFamily: "'Kumbh Sans', sans-serif",
                }}
              >
                <thead>
                  <tr style={{ background: "#0047AB", color: "#ffffff", height: "32px" }}>
                    <th
                      style={{
                        padding: "6px 12px",
                        textAlign: "left",
                        fontWeight: 700,
                        width: "24%",
                        position: "sticky",
                        left: 0,
                        background: "#0047AB",
                        zIndex: 3,
                        fontSize: "12px",
                      }}
                    />
                    {computed.months.map((m, idx) => (
                      <th
                        key={idx}
                        style={{
                          padding: "6px 4px",
                          textAlign: "right",
                          fontWeight: 700,
                          fontSize: "11.5px",
                          width: "5.7%",
                          background: "#0047AB",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {m.shortLabel}
                      </th>
                    ))}
                    <th
                      style={{
                        padding: "6px 12px",
                        textAlign: "right",
                        fontWeight: 800,
                        fontSize: "12px",
                        width: "7.6%",
                        background: "#0047AB",
                        borderLeft: "1px solid #cbd5e1",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Total
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {renderSpacer(10)}
                  {renderSectionHeader(revLabel)}
                  {renderExpandableBaseRow({
                    label: `${revLabel} (imported)`,
                    expanded: expandedSections.revenue,
                    onToggle: () => setExpandedSections((p) => ({ ...p, revenue: !p.revenue })),
                    monthlyArr: computed.baseRev,
                    totalVal: computed.totals.baseRev,
                  })}
                  {expandedSections.revenue &&
                    (year0Data?.breakdown?.revenue || []).map((line) =>
                      renderBreakdownSubRow(`rev-${line.rowNum}`, line.label, line.monthly, line.total)
                    )}
                  {renderEditableInputRow({
                    label: `${revLabel} adjustment (+/-)`,
                    subtitle: "Optional monthly adjustment up or down",
                    values: revAdjInputs,
                    onChange: (idx, v) => updateMonthArray(setRevAdjInputs, idx, v),
                    totalValue: computed.totals.revAdj,
                  })}
                  {renderSpacer(6)}
                  {renderBigTotalRow(
                    `Total ${revLabel.toLowerCase()}`,
                    computed.revenueTotal,
                    computed.totals.revenue,
                    "#9900ff"
                  )}

                  {renderSpacer(18)}

                  {computed.splitDelivery && (
                    <>
                      {renderSectionHeader("Costs of sale")}
                      {renderExpandableBaseRow({
                        label: "Costs of sale (imported + delivery dividends)",
                        expanded: expandedSections.cos,
                        onToggle: () => setExpandedSections((p) => ({ ...p, cos: !p.cos })),
                        monthlyArr: computed.cosBase,
                        totalVal: computed.totals.cosBase,
                      })}
                      {expandedSections.cos && (
                        <>
                          {[
                            ...(year0Data?.breakdown?.cosStaff || []),
                            ...(year0Data?.breakdown?.otherCos || []),
                          ].map((line) =>
                            renderBreakdownSubRow(`cos-${line.rowNum}`, line.label, line.monthly, line.total)
                          )}
                          {computed.totals.cosDiv > 0 &&
                            renderBreakdownSubRow(
                              "cos-div",
                              `Dividends in lieu of salary (${deliveryPct || 0}% delivery share)`,
                              computed.cosDiv,
                              computed.totals.cosDiv,
                              true
                            )}
                        </>
                      )}
                      {renderEditableInputRow({
                        label: "Cost of sales adjustment (+/-)",
                        subtitle: "Optional monthly adjustment up or down",
                        values: cosAdjInputs,
                        onChange: (idx, v) => updateMonthArray(setCosAdjInputs, idx, v),
                        totalValue: computed.totals.cosAdj,
                      })}
                      {renderSpacer(4)}
                      <tr style={{ height: "28px", background: "#ffffff", borderTop: "1px solid #cbd5e1", borderBottom: "1px solid #cbd5e1" }}>
                        <td
                          style={{
                            padding: "4.5px 12px 4.5px 16px",
                            textAlign: "left",
                            color: "#0047AB",
                            fontWeight: 700,
                            fontSize: "11.5px",
                            position: "sticky",
                            left: 0,
                            background: "#ffffff",
                            zIndex: 2,
                            whiteSpace: "nowrap",
                            boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                          }}
                        >
                          Total costs of sale
                        </td>
                        {computed.cosTotal.map((val, idx) => (
                          <td
                            key={idx}
                            style={{
                              padding: "4.5px 4px",
                              textAlign: "right",
                              color: "#0047AB",
                              fontWeight: 700,
                              fontSize: "11.5px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {formatMoney(val)}
                          </td>
                        ))}
                        <td
                          style={{
                            padding: "4.5px 12px",
                            textAlign: "right",
                            fontWeight: 700,
                            fontSize: "12px",
                            color: "#0047AB",
                            background: "rgba(0, 71, 171, 0.04)",
                            borderLeft: "1px solid #cbd5e1",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatMoney(computed.totals.cosTotal)}
                        </td>
                      </tr>
                      {renderSpacer(10)}
                      {renderBigTotalRow("Gross profit", computed.grossProfit, computed.totals.grossProfit, "#e69138")}
                      {renderSpacer(8)}
                      {renderMarginRow("Gross profit margin %", computed.gpMargin, computed.totals.gpMargin, "#e69138")}
                      {renderSpacer(16)}
                    </>
                  )}

                  {renderSectionHeader("Overheads")}
                  {renderExpandableBaseRow({
                    label: "Overheads (imported + non-delivery dividends)",
                    expanded: expandedSections.overheads,
                    onToggle: () => setExpandedSections((p) => ({ ...p, overheads: !p.overheads })),
                    monthlyArr: computed.overheadsBase,
                    totalVal: computed.totals.ohBase,
                  })}
                  {expandedSections.overheads && (
                    <>
                      {[
                        ...(year0Data?.breakdown?.nonCosStaff || []),
                        ...(year0Data?.breakdown?.overheads || []),
                      ].map((line) =>
                        renderBreakdownSubRow(`oh-${line.rowNum}`, line.label, line.monthly, line.total)
                      )}
                      {computed.totals.nonCosDiv > 0 &&
                        renderBreakdownSubRow(
                          "oh-div",
                          `Dividends in lieu of salary (${roundYear0(100 - (parseFloat(deliveryPct) || 0))}% non-delivery share)`,
                          computed.nonCosDiv,
                          computed.totals.nonCosDiv,
                          true
                        )}
                    </>
                  )}
                  {renderEditableInputRow({
                    label: "Overheads adjustment (+/-)",
                    subtitle: "Optional monthly adjustment up or down",
                    values: ohAdjInputs,
                    onChange: (idx, v) => updateMonthArray(setOhAdjInputs, idx, v),
                    totalValue: computed.totals.ohAdj,
                  })}
                  {renderSpacer(16)}
                  {renderBigTotalRow(
                    "Total overheads",
                    computed.overheadsTotal,
                    computed.totals.overheadsTotal,
                    "#45818e"
                  )}
                  {renderSpacer(10)}
                  {renderMarginRow(
                    isIncomeMode ? "Overheads as % of income" : "Overheads as % of revenue",
                    computed.overheadsPct,
                    computed.totals.overheadsPct,
                    "#45818e"
                  )}

                  {renderSpacer(16)}
                  {renderBigTotalRow(
                    "Operating profit",
                    computed.operatingProfit,
                    computed.totals.operatingProfit,
                    "#1155cc"
                  )}
                  {renderSpacer(10)}
                  {renderMarginRow(
                    "Operating profit %",
                    computed.operatingProfitPct,
                    computed.totals.operatingProfitPct,
                    "#1155cc"
                  )}

                  {renderSpacer(18)}
                  {renderSectionHeader("Dividends in lieu of salary")}
                  {renderEditableInputRow({
                    label: "Dividends in lieu of salary",
                    subtitle: "Allocated between delivery and non-delivery costs",
                    values: dividendInputs,
                    onChange: (idx, v) => updateMonthArray(setDividendInputs, idx, v),
                    totalValue: computed.totals.dividends,
                    rowBg: "#FFFBEB",
                    borderColor: "#F59E0B",
                    leftExtra: (
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginTop: "2px" }}>
                        <label
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "11px",
                            fontWeight: 600,
                            color: "#92400E",
                          }}
                        >
                          <span>Delivery %</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="1"
                            disabled={isReadOnly}
                            value={deliveryPct}
                            onChange={(e) => setDeliveryPct(e.target.value)}
                            aria-label="Delivery percentage for dividends in lieu of salary"
                            style={{
                              width: "54px",
                              padding: "3px 5px",
                              fontSize: "11.5px",
                              borderRadius: "5px",
                              border: "1px solid #F59E0B",
                              background: "#FFFFFF",
                              textAlign: "right",
                              fontWeight: 600,
                            }}
                          />
                        </label>
                        {!isReadOnly && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={applyAllDividendsVal}
                              onChange={(e) => setApplyAllDividendsVal(e.target.value)}
                              placeholder="All months"
                              aria-label="Dividends amount for all months"
                              style={{
                                width: "74px",
                                padding: "3px 6px",
                                fontSize: "11px",
                                borderRadius: "5px",
                                border: "1px solid #CBD5E1",
                                background: "#FFFFFF",
                                textAlign: "right",
                              }}
                            />
                            <button
                              type="button"
                              onClick={handleApplyAllDividends}
                              style={{
                                padding: "3px 8px",
                                fontSize: "11px",
                                fontWeight: 600,
                                borderRadius: "5px",
                                border: "1px solid #D97706",
                                background: "#FEF3C7",
                                color: "#92400E",
                                cursor: "pointer",
                              }}
                            >
                              Apply to all
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer Split Summary Bar */}
            <div
              style={{
                padding: "10px 16px",
                background: "#f8fafc",
                borderTop: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px",
                fontSize: "12px",
                color: "#64748b",
              }}
            >
              <div>
                {computed.totals.dividends > 0
                  ? `Dividends split: ${formatMoney(computed.totals.cosDiv)} delivery (${deliveryPct || 0}%) · ${formatMoney(computed.totals.nonCosDiv)} non-delivery`
                  : "Enter monthly dividends in lieu of salary or category adjustments above, then click Save changes."}
              </div>
              {!isReadOnly && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || loading || pulling || !isDirty}
                  style={{
                    padding: "7px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: saving || !isDirty ? "#94a3b8" : "#0047AB",
                    color: "#ffffff",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    cursor: saving || loading || pulling || !isDirty ? "not-allowed" : "pointer",
                  }}
                >
                  {saving ? "Saving..." : "Save changes"}
                </button>
              )}
            </div>
          </div>

          {/* Accounting Tool Dividend & Drawings Reference */}
          {year0Data?.accountingTool && (
            <div
              style={{
                padding: "16px 20px",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                    Dividends &amp; director drawings detected in {year0Data.accountingTool}
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                    Extracted from equity dividend accounts and directors&apos; loan / drawings accounts over Year 0. Choose a source to populate above or enter manually.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleDetectDividends}
                  disabled={detectingDividends}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    color: "#334155",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: detectingDividends ? "wait" : "pointer",
                  }}
                >
                  {detectingDividends ? "Checking..." : `Refresh from ${year0Data.accountingTool}`}
                </button>
              </div>

              {detectDividendsError && (
                <div style={{ marginTop: "8px", fontSize: "12px", color: "#b91c1c" }}>{detectDividendsError}</div>
              )}

              {dividendHints?.candidates?.length === 0 && !detectingDividends && (
                <div style={{ marginTop: "10px", fontSize: "12.5px", color: "#64748b" }}>
                  No equity dividend or directors&apos; loan accounts found in {year0Data.accountingTool}.
                </div>
              )}

              {dividendHints?.candidates?.length > 0 && (
                <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  {dividendHints.candidates.map((cand) => {
                    const hasMovement = Math.abs(cand.annualTotal) >= 1;
                    return (
                      <div
                        key={cand.accountId}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "10px",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          background: "#f8fafc",
                          border: "1px solid #e2e8f0",
                        }}
                      >
                        <div>
                          <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <span>{cand.code ? `${cand.code} · ${cand.name}` : cand.name}</span>
                            <span
                              style={{
                                fontSize: "10.5px",
                                fontWeight: 600,
                                padding: "1px 7px",
                                borderRadius: "999px",
                                background: cand.kind === "dividend" ? "#EFF6FF" : "#FEF3C7",
                                color: cand.kind === "dividend" ? "#1D4ED8" : "#92400E",
                              }}
                            >
                              {cand.kind === "dividend" ? "Dividends account" : "Director loan / drawings"}
                            </span>
                          </div>
                          <div style={{ fontSize: "12px", color: "#475569", marginTop: "2px" }}>
                            Year 0 net movement: <strong>{formatMoney(cand.annualTotal)}</strong>
                            {hasMovement ? ` (avg ${formatMoney(cand.monthlyAverage)}/mo)` : " (no in-year movement recorded)"}
                          </div>
                        </div>

                        {hasMovement && !isReadOnly && (
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => {
                                setDividendInputs(
                                  cand.monthly.map((v) => {
                                    const clamped = roundYear0(Math.max(0, v));
                                    return clamped > 0 ? String(clamped) : "";
                                  })
                                );
                              }}
                              style={{
                                padding: "5px 10px",
                                fontSize: "11.5px",
                                fontWeight: 600,
                                borderRadius: "6px",
                                border: "1px solid #93C5FD",
                                background: "#EFF6FF",
                                color: "#1D4ED8",
                                cursor: "pointer",
                              }}
                            >
                              Use monthly figures
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const avg = roundYear0(Math.max(0, cand.monthlyAverage));
                                const str = avg > 0 ? String(avg) : "";
                                setApplyAllDividendsVal(str);
                                setDividendInputs(Array(12).fill(str));
                              }}
                              style={{
                                padding: "5px 10px",
                                fontSize: "11.5px",
                                fontWeight: 600,
                                borderRadius: "6px",
                                border: "1px solid #CBD5E1",
                                background: "#FFFFFF",
                                color: "#334155",
                                cursor: "pointer",
                              }}
                            >
                              Use monthly average
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* UNSAVED CHANGES MODAL */}
      {showUnsavedModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
            padding: "16px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "10px",
              maxWidth: "460px",
              width: "100%",
              padding: "22px 24px",
              boxShadow: "0 20px 40px rgba(15, 23, 42, 0.25)",
              border: "1px solid #e2e8f0",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>
              Unsaved Year 0 changes
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#475569", lineHeight: 1.5 }}>
              You have unsaved changes to Year 0 adjustments or dividends for {selectedClient?.clientName || "this client"}.
              Would you like to save them before continuing?
            </p>
            {modalSaveError && (
              <div
                style={{
                  marginBottom: "14px",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                  fontSize: "12.5px",
                }}
              >
                {modalSaveError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleModalCancel}
                disabled={saving}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleModalDiscardAndContinue}
                disabled={saving}
                style={{
                  padding: "7px 14px",
                  borderRadius: "6px",
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  color: "#b91c1c",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={handleModalSaveAndContinue}
                disabled={saving}
                style={{
                  padding: "7px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#0047AB",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                {saving ? "Saving..." : "Save & continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
