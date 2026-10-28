import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "./Spinner";
import { eomWorkMonthToTargetMonth } from "../utils/helpers";

/**
 * Shifts a YYYY-MM month key by delta months (+1 or -1)
 */
function shiftMonthKey(monthKey, delta) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    const d = new Date();
    d.setMonth(d.getMonth() + delta);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Formats a YYYY-MM string to "Month YYYY" (e.g. "September 2026")
 */
function formatMonthKey(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return "";
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default function ReportingTab({
  automationCommanderSheetId = "",
  eomMonthKey = "",
  isAdmin = false,
  styles = {}
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState(null); // { type: 'success' | 'error' | 'info', text: string }

  // Clients & configuration
  const [clients, setClients] = useState([]);
  const [systemWebAppUrl, setSystemWebAppUrl] = useState("");
  const [chartRefs, setChartRefs] = useState([]);

  // Checkbox selections for batch actions
  const [selectedClients, setSelectedClients] = useState(new Set());

  // Filter state: show configured decks only by default
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(true);

  // Abort controller ref for in-flight batch reporting tasks
  const abortControllerRef = useRef(null);

  // Action states
  const [actionInProgress, setActionInProgress] = useState(null); // 'GENERATE' | 'UPDATE' | 'EMAIL' | null
  const [clientStatuses, setClientStatuses] = useState({}); // { [clientName]: { status, message, subDetail, percent, reportUrl } }
  const [runProgress, setRunProgress] = useState(null);
  const activeStageRefsRef = useRef({ stageIdx: 0, refs: [], stageStartMs: 0, basePercent: 0, maxPercent: 0, clientName: "" });

  // Modals state
  const [emailModalClient, setEmailModalClient] = useState(null);
  const [emailForm, setEmailForm] = useState({ to: "", subj: "", body: "" });
  const [emailSaving, setEmailSaving] = useState(false);

  const [showLogModal, setShowLogModal] = useState(false);
  const [showChartRefsModal, setShowChartRefsModal] = useState(false);
  const [editingRef, setEditingRef] = useState(null); // { code, range, label, originalCode, isNew }
  const [refSaving, setRefSaving] = useState(false);
  const [refDeletingCode, setRefDeletingCode] = useState(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsUrlInput, setSettingsUrlInput] = useState("");
  const [settingsTesting, setSettingsTesting] = useState(false);
  const [settingsTestResult, setSettingsTestResult] = useState(null);

  // Default report covered month is 1 month prior to the EoM work cycle (e.g. 2026-10 cycle reports on 2026-09)
  const defaultReportMonthKey = useMemo(() => {
    return eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey;
  }, [eomMonthKey]);

  const [selectedReportMonthKey, setSelectedReportMonthKey] = useState(defaultReportMonthKey);
  const prevEomMonthRef = useRef(eomMonthKey);

  // When parent EoM cycle changes, synchronize the default report month
  useEffect(() => {
    if (prevEomMonthRef.current !== eomMonthKey) {
      prevEomMonthRef.current = eomMonthKey;
      setSelectedReportMonthKey(eomWorkMonthToTargetMonth(eomMonthKey) || eomMonthKey);
    }
  }, [eomMonthKey]);

  const reportMonthLabel = useMemo(() => {
    return formatMonthKey(selectedReportMonthKey);
  }, [selectedReportMonthKey]);

  const cycleMonthLabel = useMemo(() => {
    return formatMonthKey(eomMonthKey);
  }, [eomMonthKey]);

  const isOverridden = selectedReportMonthKey !== defaultReportMonthKey;

  // Filter clients by configured deck status
  const configuredCount = useMemo(() => {
    return (clients || []).filter(c => c.hasDeckConfigured || c.folderUrl).length;
  }, [clients]);

  const visibleClients = useMemo(() => {
    if (!showConfiguredOnly) return clients || [];
    return (clients || []).filter(c => c.hasDeckConfigured || c.folderUrl);
  }, [clients, showConfiguredOnly]);

  // Load reporting data
  const loadReportingData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_get_reporting_data",
          automationCommanderSheetId,
          eomMonthKey,
          reportMonthKey: selectedReportMonthKey
        })
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load reporting data");
      }
      setClients(data.clients || []);
      setSystemWebAppUrl(data.systemWebAppUrl || "");
      setSettingsUrlInput(data.systemWebAppUrl || "");
      setChartRefs(data.chartRefs || []);

      // Default: do not check any clients
      setSelectedClients(new Set());
    } catch (err) {
      console.error("Error loading reporting data:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId, eomMonthKey, selectedReportMonthKey]);

  useEffect(() => {
    loadReportingData();
  }, [loadReportingData]);

  // Toggle single client selection
  const toggleClientSelection = (clientName) => {
    setSelectedClients(prev => {
      const next = new Set(prev);
      if (next.has(clientName)) {
        next.delete(clientName);
      } else {
        next.add(clientName);
      }
      return next;
    });
  };

  // Toggle select all (operates on visible clients)
  const toggleSelectAll = () => {
    const visibleNames = visibleClients.map(c => c.clientName);
    const allVisibleSelected = visibleNames.length > 0 && visibleNames.every(name => selectedClients.has(name));
    if (allVisibleSelected) {
      setSelectedClients(prev => {
        const next = new Set(prev);
        visibleNames.forEach(name => next.delete(name));
        return next;
      });
    } else {
      setSelectedClients(prev => {
        const next = new Set(prev);
        visibleNames.forEach(name => next.add(name));
        return next;
      });
    }
  };

  // Stop / cancel running batch action
  const handleCancelAction = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setActionInProgress(null);
    setStatusMsg({ type: "warning", text: "Task was stopped by user." });
    setRunProgress(prev => prev ? {
      ...prev,
      isRunning: false,
      subStepLabel: "Task stopped by user.",
      stages: prev.stages.map(s => s.status === "running" ? { ...s, status: "cancelled" } : s),
      logs: [...(prev.logs || []), { time: new Date().toLocaleTimeString("en-GB"), text: "Task stopped by user.", type: "warning" }]
    } : null);
    setClientStatuses(prev => {
      const updated = { ...prev };
      Object.keys(updated).forEach(name => {
        if (updated[name]?.status === "running" || updated[name]?.status === "queued") {
          updated[name] = { status: "cancelled", message: "Stopped by user", subDetail: "" };
        }
      });
      return updated;
    });
  };

  // Live timer & sub-step progress interpolator while an action is running
  useEffect(() => {
    if (!actionInProgress) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const stageMeta = activeStageRefsRef.current;

      setRunProgress(prev => {
        if (!prev || !prev.isRunning) return prev;
        const elapsedSec = Math.max(0, Math.floor((now - prev.startedAt) / 1000));
        let nextPercent = prev.overallPercent;
        let nextSubStep = prev.subStepLabel;

        if (stageMeta && (stageMeta.stageIdx === 1 || stageMeta.stageIdx === 2) && stageMeta.refs?.length > 0) {
          const stageElapsedSec = Math.max(0, (now - stageMeta.stageStartMs) / 1000);
          // Estimate ~34s per slides batch pass
          const ratio = Math.min(0.94, stageElapsedSec / 34);
          nextPercent = Math.round(stageMeta.basePercent + (stageMeta.maxPercent - stageMeta.basePercent) * ratio);

          if (stageMeta.stageIdx === 1 && stageElapsedSec < 5) {
            nextSubStep = prev.mode === "GENERATE"
              ? `Creating ${reportMonthLabel} presentation from template & refreshing linked Google Sheets charts...`
              : `Opening ${reportMonthLabel} presentation in Google Slides & refreshing linked charts...`;
          } else {
            const effectiveRefElapsed = stageMeta.stageIdx === 1 ? Math.max(0, stageElapsedSec - 5) : stageElapsedSec;
            const refIdx = Math.min(
              stageMeta.refs.length - 1,
              Math.floor((effectiveRefElapsed / 26) * stageMeta.refs.length)
            );
            const activeRef = stageMeta.refs[refIdx];
            if (activeRef) {
              const dimText = activeRef.rowCount && activeRef.colCount ? ` (${activeRef.rowCount}×${activeRef.colCount})` : "";
              nextSubStep = `Updating slide table ${refIdx + 1} of ${stageMeta.refs.length} in batch: ${activeRef.code} — ${activeRef.label || activeRef.range}${dimText}`;
            }
          }
        }

        if (stageMeta?.clientName) {
          setClientStatuses(cs => {
            const curr = cs[stageMeta.clientName];
            if (!curr || curr.status !== "running") return cs;
            return {
              ...cs,
              [stageMeta.clientName]: {
                ...curr,
                percent: nextPercent,
                subDetail: nextSubStep,
                elapsedSec
              }
            };
          });
        }

        return {
          ...prev,
          elapsedSec,
          overallPercent: nextPercent,
          subStepLabel: nextSubStep
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [actionInProgress, reportMonthLabel]);

  // Run Batch Reporting Action (GENERATE | UPDATE | EMAIL) with detailed step-by-step progress
  const handleRunBatchAction = async (mode) => {
    if (!selectedClients || selectedClients.size === 0) {
      setStatusMsg({ type: "error", text: "Please select at least one client to process." });
      return;
    }

    const targetClients = clients.filter(c => selectedClients.has(c.clientName));
    if (mode !== "EMAIL" && targetClients.some(c => !c.folderUrl)) {
      const missing = targetClients.filter(c => !c.folderUrl).map(c => c.clientName);
      if (!window.confirm(`Warning: The following client(s) do not have a Management Reports folder configured:\n- ${missing.join("\n- ")}\n\nDo you want to continue for the remaining clients?`)) {
        return;
      }
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setActionInProgress(mode);
    setStatusMsg(null);

    const runStartedAt = Date.now();
    const nowTime = () => new Date().toLocaleTimeString("en-GB");

    const buildInitialStages = (forMode) => {
      if (forMode === "EMAIL") {
        return [
          { id: "draft", title: "Drafting Gmail message", detail: "Creating email draft with client template and signature", status: "pending" },
          { id: "finalize", title: "Finalising & logging", detail: "Updating EoM checklist task and activity log", status: "pending" }
        ];
      }
      return [
        {
          id: "prepare",
          title: "Step 1: Master sheet preparation",
          detail: `Setting MgmtRep!B1 to ${reportMonthLabel} and verifying populated table ranges`,
          status: "pending"
        },
        {
          id: "batch1",
          title: forMode === "GENERATE"
            ? "Step 2: Create presentation, refresh charts & sync core tables"
            : "Step 2: Refresh linked charts & sync core performance tables",
          detail: "Refreshing linked Google Sheets charts and updating snapshot, performance & overhead tables",
          status: "pending"
        },
        {
          id: "batch2",
          title: "Step 3: Sync financial forecasts, cashflow & pipeline tables",
          detail: "Updating YTD, FY forecast, targets, cashflow, bookings, pipeline & utilisation tables",
          status: "pending"
        },
        {
          id: "finalize",
          title: "Step 4: Finalising & logging",
          detail: "Recording presentation link in ReportsLog and completing EoM checklist task",
          status: "pending"
        }
      ];
    };

    // Set initial client statuses
    const initialStatuses = { ...clientStatuses };
    targetClients.forEach((c, idx) => {
      initialStatuses[c.clientName] = {
        status: idx === 0 ? "running" : "queued",
        message: idx === 0 ? "Starting..." : "Queued",
        subDetail: idx === 0 ? "Preparing master sheet..." : `Waiting (${idx + 1} of ${targetClients.length})`,
        percent: idx === 0 ? 5 : 0,
        elapsedSec: 0
      };
    });
    setClientStatuses(initialStatuses);

    setRunProgress({
      isRunning: true,
      mode,
      totalClients: targetClients.length,
      currentClientIdx: 0,
      currentClientName: targetClients[0].clientName,
      overallPercent: 5,
      subStepLabel: `Initialising ${mode === "GENERATE" ? "report generation" : (mode === "UPDATE" ? "deck update" : "email drafting")} for ${targetClients[0].clientName}...`,
      startedAt: runStartedAt,
      elapsedSec: 0,
      stages: buildInitialStages(mode),
      logs: [
        {
          time: nowTime(),
          text: `Started ${mode === "GENERATE" ? "Generate new reports" : (mode === "UPDATE" ? "Update existing decks" : "Draft emails")} for ${targetClients.length} client(s) (Report covers: ${reportMonthLabel}).`,
          type: "info"
        }
      ]
    });

    const appendLog = (text, type = "info") => {
      setRunProgress(prev => prev ? {
        ...prev,
        logs: [...(prev.logs || []), { time: nowTime(), text, type }]
      } : prev);
    };

    let successCount = 0;
    let failCount = 0;

    try {
      for (let cIdx = 0; cIdx < targetClients.length; cIdx++) {
        if (controller.signal.aborted) break;
        const client = targetClients[cIdx];
        const clientStartMs = Date.now();
        const stages = buildInitialStages(mode);

        // Helper to update stage status
        const updateStage = (stageIdx, status, detailOverride, overallPct, subStep) => {
          setRunProgress(prev => {
            if (!prev) return prev;
            const nextStages = prev.stages.map((s, idx) => {
              if (idx < stageIdx && s.status !== "done") return { ...s, status: "done" };
              if (idx === stageIdx) return { ...s, status, detail: detailOverride || s.detail };
              return s;
            });
            return {
              ...prev,
              currentClientIdx: cIdx,
              currentClientName: client.clientName,
              overallPercent: overallPct !== undefined ? overallPct : prev.overallPercent,
              subStepLabel: subStep || prev.subStepLabel,
              stages: nextStages
            };
          });
        };

        setRunProgress(prev => prev ? {
          ...prev,
          currentClientIdx: cIdx,
          currentClientName: client.clientName,
          stages
        } : prev);

        try {
          if (mode === "EMAIL") {
            activeStageRefsRef.current = { stageIdx: 0, refs: [], stageStartMs: Date.now(), basePercent: 20, maxPercent: 80, clientName: client.clientName };
            updateStage(0, "running", `Drafting email to ${client.emailTo || "recipient"}...`, 35, `${client.clientName}: Creating Gmail draft...`);
            setClientStatuses(prev => ({
              ...prev,
              [client.clientName]: {
                status: "running",
                message: "Step 1/2: Drafting email",
                subDetail: `Creating draft to ${client.emailTo || "recipient"}...`,
                percent: 35
              }
            }));
            appendLog(`${client.clientName}: Creating Gmail draft (${client.emailSubj || "End of month queries"})...`);

            const resp = await fetch("/api/triage", {
              method: "POST",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "eom_run_reporting_action",
                mode: "EMAIL",
                clients: [client],
                eomMonthKey,
                reportMonthKey: selectedReportMonthKey,
                webAppUrlOverride: systemWebAppUrl,
                automationCommanderSheetId
              })
            });
            const data = await resp.json();
            if (!data.success) throw new Error(data.error || "Failed to draft email");
            const cRes = data.results?.[0];
            if (cRes && !cRes.success) throw new Error(cRes.error || "Failed to draft email");

            updateStage(0, "done", "Gmail draft created", 100, `${client.clientName}: Email draft created.`);
            updateStage(1, "done", "EoM checklist updated", 100, `${client.clientName}: Completed.`);

            const clientDur = Math.max(1, Math.round((Date.now() - clientStartMs) / 1000));
            setClientStatuses(prev => ({
              ...prev,
              [client.clientName]: {
                status: "success",
                message: `Draft created (${clientDur}s)`,
                subDetail: `Recipient: ${client.emailTo}`,
                percent: 100
              }
            }));
            appendLog(`${client.clientName}: Gmail draft created successfully (${clientDur}s).`, "success");
            successCount++;
            continue;
          }

          // ── STAGE 1: PREPARE_MASTER ────────────────────────────────────────────
          activeStageRefsRef.current = { stageIdx: 0, refs: [], stageStartMs: Date.now(), basePercent: 5, maxPercent: 15, clientName: client.clientName };
          updateStage(
            0,
            "running",
            `Setting MgmtRep!B1 to ${reportMonthLabel} & scanning active table ranges...`,
            10,
            `${client.clientName}: Updating Master Sheet MgmtRep!B1 to ${reportMonthLabel}...`
          );
          setClientStatuses(prev => ({
            ...prev,
            [client.clientName]: {
              status: "running",
              message: "Step 1/4: Master sheet",
              subDetail: `Setting MgmtRep!B1 to ${reportMonthLabel}...`,
              percent: 10
            }
          }));
          appendLog(`${client.clientName}: Setting Master Sheet MgmtRep!B1 to ${reportMonthLabel} and verifying table ranges...`);

          const prepResp = await fetch("/api/triage", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "eom_run_reporting_action",
              step: "PREPARE_MASTER",
              mode,
              clients: [client],
              eomMonthKey,
              reportMonthKey: selectedReportMonthKey,
              webAppUrlOverride: systemWebAppUrl,
              automationCommanderSheetId
            })
          });
          const prepData = await prepResp.json();
          if (!prepData.success) throw new Error(prepData.error || "Master sheet preparation failed");

          const activeRefs = Array.isArray(prepData.activeChartRefs) && prepData.activeChartRefs.length > 0
            ? prepData.activeChartRefs
            : (chartRefs.length > 0 ? chartRefs : []);

          updateStage(
            0,
            "done",
            `MgmtRep!B1 set to ${prepData.targetDateFormatted} (${activeRefs.length} populated table ranges ready)`,
            15,
            `${client.clientName}: Master sheet updated (${activeRefs.length} active table ranges).`
          );
          appendLog(`${client.clientName}: Master sheet updated (${prepData.targetDateFormatted}). Found ${activeRefs.length} populated table ranges.`);

          // Split activeRefs into 2 balanced batches so each GAS Web App pass completes in ~28-35s
          const midIdx = Math.ceil(activeRefs.length / 2);
          const batch1Refs = activeRefs.slice(0, midIdx);
          const batch2Refs = activeRefs.slice(midIdx);

          const batch1Map = {};
          batch1Refs.forEach(r => { batch1Map[r.code] = r.range; });
          const batch2Map = {};
          batch2Refs.forEach(r => { batch2Map[r.code] = r.range; });

          // ── STAGE 2: SLIDES_BATCH 1 (Charts + Core Performance Tables) ─────────
          activeStageRefsRef.current = {
            stageIdx: 1,
            refs: batch1Refs,
            stageStartMs: Date.now(),
            basePercent: 16,
            maxPercent: 54,
            clientName: client.clientName
          };
          const batch1CodesPreview = batch1Refs.map(r => r.code).join(", ");
          updateStage(
            1,
            "running",
            `Refreshing linked Google Sheets charts & syncing ${batch1Refs.length} tables (${batch1CodesPreview})`,
            18,
            mode === "GENERATE"
              ? `${client.clientName}: Creating ${reportMonthLabel} presentation from template & refreshing charts...`
              : `${client.clientName}: Opening ${reportMonthLabel} presentation & refreshing linked charts...`
          );
          setClientStatuses(prev => ({
            ...prev,
            [client.clientName]: {
              status: "running",
              message: "Step 2/4: Charts & core tables",
              subDetail: `Refreshing charts & syncing ${batch1Refs.length} core tables...`,
              percent: 18
            }
          }));
          appendLog(`${client.clientName}: ${mode === "GENERATE" ? "Creating new deck from template, refreshing" : "Refreshing"} linked charts & syncing ${batch1Refs.length} core tables (${batch1Refs.map(r => r.code).slice(0, 5).join(", ")}${batch1Refs.length > 5 ? "..." : ""})...`);

          const batch1StartMs = Date.now();
          const batch1Resp = await fetch("/api/triage", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "eom_run_reporting_action",
              step: "SLIDES_BATCH",
              batchIndex: 0,
              chartMapOverride: batch1Map,
              mode,
              clients: [client],
              eomMonthKey,
              reportMonthKey: selectedReportMonthKey,
              webAppUrlOverride: systemWebAppUrl,
              automationCommanderSheetId
            })
          });
          const batch1Data = await batch1Resp.json();
          if (!batch1Data.success) throw new Error(batch1Data.error || "Failed during slides batch 1");
          const batch1ClientRes = batch1Data.results?.[0];
          if (!batch1ClientRes || !batch1ClientRes.success) {
            throw new Error(batch1ClientRes?.error || "Failed during slides batch 1");
          }

          const batch1Sec = Math.max(1, Math.round((Date.now() - batch1StartMs) / 1000));
          const updatedInBatch1 = Array.isArray(batch1ClientRes.tablesUpdated) && batch1ClientRes.tablesUpdated.length > 0
            ? batch1ClientRes.tablesUpdated.map(t => `${t.code} (slide ${t.slideNumber})`).join(", ")
            : `${batch1Refs.length} core table ranges checked`;

          updateStage(
            1,
            "done",
            `Charts refreshed & core tables synced in ${batch1Sec}s (${updatedInBatch1})`,
            55,
            `${client.clientName}: Core tables synced (${batch1Sec}s).`
          );
          appendLog(`${client.clientName}: Linked charts refreshed & core tables synced in ${batch1Sec}s (${batch1ClientRes.reportName || "deck"}).`);

          let finalClientRes = batch1ClientRes;

          // ── STAGE 3: SLIDES_BATCH 2 (Forecasts, Cashflow, Bookings, Pipeline & Util) ──
          if (batch2Refs.length > 0) {
            activeStageRefsRef.current = {
              stageIdx: 2,
              refs: batch2Refs,
              stageStartMs: Date.now(),
              basePercent: 56,
              maxPercent: 90,
              clientName: client.clientName
            };
            const batch2CodesPreview = batch2Refs.map(r => r.code).join(", ");
            updateStage(
              2,
              "running",
              `Syncing ${batch2Refs.length} forecast, cashflow & pipeline tables (${batch2CodesPreview})`,
              58,
              `${client.clientName}: Syncing ${batch2Refs[0]?.code || "forecast"} table...`
            );
            setClientStatuses(prev => ({
              ...prev,
              [client.clientName]: {
                status: "running",
                message: "Step 3/4: Forecast & cashflow tables",
                subDetail: `Syncing ${batch2Refs.length} remaining tables...`,
                percent: 58,
                reportUrl: batch1ClientRes.reportUrl || null
              }
            }));
            appendLog(`${client.clientName}: Syncing ${batch2Refs.length} forecast, cashflow, pipeline & utilisation tables (${batch2Refs.map(r => r.code).slice(0, 5).join(", ")}${batch2Refs.length > 5 ? "..." : ""})...`);

            const batch2StartMs = Date.now();
            const batch2Resp = await fetch("/api/triage", {
              method: "POST",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "eom_run_reporting_action",
                step: "SLIDES_BATCH",
                batchIndex: 1,
                chartMapOverride: batch2Map,
                mode,
                clients: [client],
                eomMonthKey,
                reportMonthKey: selectedReportMonthKey,
                webAppUrlOverride: systemWebAppUrl,
                automationCommanderSheetId
              })
            });
            const batch2Data = await batch2Resp.json();
            if (!batch2Data.success) throw new Error(batch2Data.error || "Failed during slides batch 2");
            const batch2ClientRes = batch2Data.results?.[0];
            if (!batch2ClientRes || !batch2ClientRes.success) {
              throw new Error(batch2ClientRes?.error || "Failed during slides batch 2");
            }

            finalClientRes = batch2ClientRes;
            const batch2Sec = Math.max(1, Math.round((Date.now() - batch2StartMs) / 1000));
            const updatedInBatch2 = Array.isArray(batch2ClientRes.tablesUpdated) && batch2ClientRes.tablesUpdated.length > 0
              ? batch2ClientRes.tablesUpdated.map(t => `${t.code} (slide ${t.slideNumber})`).join(", ")
              : `${batch2Refs.length} forecast/cashflow table ranges checked`;

            updateStage(
              2,
              "done",
              `Forecast, cashflow & utilisation tables synced in ${batch2Sec}s (${updatedInBatch2})`,
              92,
              `${client.clientName}: All slide tables synced (${batch2Sec}s).`
            );
            appendLog(`${client.clientName}: Forecast, cashflow & utilisation tables synced in ${batch2Sec}s.`);
          } else {
            updateStage(2, "done", "No additional table batch needed", 92);
          }

          // ── STAGE 4: FINALIZE (ReportsLog & EoM Checklist) ─────────────────────
          activeStageRefsRef.current = { stageIdx: 3, refs: [], stageStartMs: Date.now(), basePercent: 92, maxPercent: 99, clientName: client.clientName };
          updateStage(
            3,
            "running",
            "Recording presentation link in ReportsLog & updating EoM checklist task...",
            95,
            `${client.clientName}: Saving deck link to ReportsLog & updating EoM checklist...`
          );
          setClientStatuses(prev => ({
            ...prev,
            [client.clientName]: {
              status: "running",
              message: "Step 4/4: Finalising & logging",
              subDetail: "Updating ReportsLog & EoM checklist...",
              percent: 95,
              reportUrl: finalClientRes.reportUrl || null
            }
          }));

          await fetch("/api/triage", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "eom_run_reporting_action",
              step: "FINALIZE",
              mode,
              clients: [client],
              clientResults: [finalClientRes],
              eomMonthKey,
              reportMonthKey: selectedReportMonthKey,
              automationCommanderSheetId
            })
          });

          const totalClientSec = Math.max(1, Math.round((Date.now() - clientStartMs) / 1000));
          updateStage(
            3,
            "done",
            `Logged to ReportsLog & completed EoM task (total time: ${totalClientSec}s)`,
            100,
            `${client.clientName}: ${mode === "GENERATE" ? "Report generated" : "Deck updated"} successfully (${totalClientSec}s).`
          );

          setClientStatuses(prev => ({
            ...prev,
            [client.clientName]: {
              status: "success",
              message: mode === "GENERATE" ? `Report generated (${totalClientSec}s)` : `Deck updated (${totalClientSec}s)`,
              subDetail: finalClientRes.reportName || reportMonthLabel,
              percent: 100,
              reportUrl: finalClientRes.reportUrl || null
            }
          }));

          appendLog(`${client.clientName}: ${mode === "GENERATE" ? "Report generated" : "Deck updated"} successfully in ${totalClientSec}s (${finalClientRes.reportName || "presentation"}).`, "success");
          successCount++;
        } catch (clientErr) {
          if (clientErr.name === "AbortError" || controller.signal.aborted) {
            throw clientErr;
          }
          console.error(`Error processing ${client.clientName}:`, clientErr);
          failCount++;
          setRunProgress(prev => prev ? {
            ...prev,
            stages: prev.stages.map(s => s.status === "running" ? { ...s, status: "error", detail: clientErr.message } : s),
            subStepLabel: `${client.clientName}: Error — ${clientErr.message}`
          } : prev);
          setClientStatuses(prev => ({
            ...prev,
            [client.clientName]: {
              status: "error",
              message: "Error",
              subDetail: clientErr.message,
              percent: 0
            }
          }));
          appendLog(`${client.clientName}: Error — ${clientErr.message}`, "error");
        }
      }

      if (!controller.signal.aborted) {
        const totalSec = Math.max(1, Math.round((Date.now() - runStartedAt) / 1000));
        setRunProgress(prev => prev ? {
          ...prev,
          isRunning: false,
          overallPercent: 100,
          elapsedSec: totalSec,
          subStepLabel: failCount === 0
            ? `Completed ${successCount} client(s) in ${totalSec}s.`
            : `Completed with ${successCount} succeeded and ${failCount} failed (${totalSec}s).`
        } : null);

        if (failCount === 0) {
          setStatusMsg({
            type: "success",
            text: mode === "GENERATE"
              ? `Successfully generated ${successCount} report(s) in ${totalSec}s.`
              : (mode === "UPDATE"
                ? `Successfully updated ${successCount} deck(s) in ${totalSec}s.`
                : `Successfully drafted ${successCount} email(s) in Gmail.`)
          });
        } else {
          setStatusMsg({
            type: "error",
            text: `Finished with ${successCount} succeeded and ${failCount} failed. Check the progress log below for details.`
          });
        }

        // Reload fresh state to pull new report URLs and logs
        loadReportingData();
      }
    } catch (err) {
      if (err.name === "AbortError" || controller.signal.aborted) {
        console.log("Reporting action cancelled by user.");
        return;
      }
      console.error("Batch reporting action error:", err);
      setStatusMsg({ type: "error", text: err.message });
      setRunProgress(prev => prev ? { ...prev, isRunning: false, subStepLabel: `Error: ${err.message}` } : null);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      activeStageRefsRef.current = { stageIdx: 0, refs: [], stageStartMs: 0, basePercent: 0, maxPercent: 0, clientName: "" };
      setActionInProgress(null);
    }
  };

  // Open Email Template Modal
  const openEmailModal = (client) => {
    setEmailModalClient(client);
    setEmailForm({
      to: client.emailTo || "",
      subj: client.emailSubj || "End of month queries",
      body: client.emailBody || ""
    });
  };

  // Save Email Template
  const handleSaveEmailTemplate = async () => {
    if (!emailModalClient) return;
    setEmailSaving(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_reporting_config",
          clientName: emailModalClient.clientName,
          emailTo: emailForm.to,
          emailSubj: emailForm.subj,
          emailBody: emailForm.body,
          automationCommanderSheetId
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to save template");

      // Update local client object
      setClients(prev => prev.map(c => c.clientName === emailModalClient.clientName ? {
        ...c,
        emailTo: emailForm.to,
        emailSubj: emailForm.subj,
        emailBody: emailForm.body
      } : c));

      setEmailModalClient(null);
      setStatusMsg({ type: "success", text: `Email template for ${emailModalClient.clientName} saved.` });
    } catch (err) {
      alert(`Error saving email template: ${err.message}`);
    } finally {
      setEmailSaving(false);
    }
  };

  // Test Web App Connection (proxied via backend to avoid browser CORS restrictions)
  const handleTestWebAppConnection = async () => {
    const cleanUrl = settingsUrlInput.trim();
    if (!cleanUrl) {
      alert("Please enter a Web App URL first.");
      return;
    }
    setSettingsTesting(true);
    setSettingsTestResult(null);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_test_reporting_webapp",
          webAppUrl: cleanUrl
        })
      });
      let data = null;
      try {
        data = await resp.json();
      } catch (parseErr) {
        setSettingsTestResult({
          success: false,
          message: `Server returned HTTP ${resp.status}. Please verify the Next.js server is running.`
        });
        return;
      }
      if (data && data.success) {
        setSettingsTestResult({ success: true, message: data.message || "Connection successful!" });
      } else {
        setSettingsTestResult({ success: false, message: data?.error || "Server returned error." });
      }
    } catch (err) {
      setSettingsTestResult({ success: false, message: `Connection failed: ${err.message}` });
    } finally {
      setSettingsTesting(false);
    }
  };

  // Save Web App URL
  const handleSaveSettings = async () => {
    const cleanUrl = settingsUrlInput.trim();
    try {
      await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_reporting_config",
          clientName: "__SYSTEM__",
          webAppUrl: cleanUrl,
          automationCommanderSheetId
        })
      });
      setSystemWebAppUrl(cleanUrl);
      setShowSettingsModal(false);
      setStatusMsg({ type: "success", text: "Reporting Web App URL updated." });
    } catch (err) {
      alert(`Error saving settings: ${err.message}`);
    }
  };

  // Save (Create or Update) Chart Reference
  const handleSaveChartRef = async () => {
    if (!editingRef || !editingRef.code.trim() || !editingRef.range.trim()) {
      alert("Both speaker notes code and cell range are required.");
      return;
    }
    setRefSaving(true);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_save_chart_ref",
          code: editingRef.code.trim(),
          range: editingRef.range.trim(),
          label: editingRef.label?.trim() || "",
          originalCode: editingRef.originalCode || null
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to save chart reference");

      const savedRef = data.chartRef;
      setChartRefs(prev => {
        const lookup = editingRef.originalCode || savedRef.code;
        const exists = prev.some(r => r.code === lookup);
        if (exists) {
          return prev.map(r => r.code === lookup ? savedRef : r);
        }
        return [...prev, savedRef];
      });

      setEditingRef(null);
      setStatusMsg({ type: "success", text: data.message || `Reference ${savedRef.code} saved.` });
    } catch (err) {
      alert(`Error saving chart reference: ${err.message}`);
    } finally {
      setRefSaving(false);
    }
  };

  // Delete Chart Reference
  const handleDeleteChartRef = async (code) => {
    if (!window.confirm(`Are you sure you want to delete reference ${code}?`)) {
      return;
    }
    setRefDeletingCode(code);
    try {
      const resp = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_delete_chart_ref",
          code
        })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || "Failed to delete chart reference");

      setChartRefs(prev => prev.filter(r => r.code !== code));
      if (editingRef?.originalCode === code || editingRef?.code === code) {
        setEditingRef(null);
      }
      setStatusMsg({ type: "success", text: data.message || `Reference ${code} deleted.` });
    } catch (err) {
      alert(`Error deleting chart reference: ${err.message}`);
    } finally {
      setRefDeletingCode(null);
    }
  };

  if (!isAdmin) {
    return (
      <div style={{ padding: "40px 20px", textAlign: "center", color: "#64748b" }}>
        <p style={{ fontSize: "16px", fontWeight: "600", color: "#0f172a" }}>Admin access required</p>
        <p style={{ fontSize: "13px" }}>The reporting control section is restricted to administrators.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 0 40px" }}>
      {/* ── HEADER CARD ────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "20px 24px",
        marginBottom: "20px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "4px" }}>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                Reporting
              </h1>

              {/* Month selector pill */}
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                background: "#f8fafc",
                padding: "2px 6px",
                borderRadius: "8px",
                border: "1px solid #e2e8f0"
              }}>
                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(prev => shiftMonthKey(prev, -1))}
                  title="Previous report month"
                  aria-label="Previous report month"
                  style={{
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    width: "24px",
                    height: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: "#475569",
                    padding: 0
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#e2e8f0"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "0 6px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap" }}>
                    Report covers: {reportMonthLabel}
                  </span>
                  {cycleMonthLabel && (
                    <span style={{ fontSize: "11px", fontWeight: 500, color: "#64748b", whiteSpace: "nowrap" }}>
                      ({cycleMonthLabel} EoM cycle)
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(prev => shiftMonthKey(prev, 1))}
                  title="Next report month"
                  aria-label="Next report month"
                  style={{
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    width: "24px",
                    height: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: "#475569",
                    padding: 0
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#e2e8f0"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </button>
              </div>

              {isOverridden && (
                <button
                  type="button"
                  onClick={() => setSelectedReportMonthKey(defaultReportMonthKey)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#2563eb",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: "2px 4px"
                  }}
                >
                  Reset to cycle default ({formatMonthKey(defaultReportMonthKey)})
                </button>
              )}
            </div>
            <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>
              Managing monthly reporting presentation decks plus month-end email drafting.
            </p>
          </div>

          {/* Quick auxiliary controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <button
              onClick={() => setShowLogModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
            >
              Reports log
            </button>
            <button
              onClick={() => setShowChartRefsModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
            >
              Chart references
            </button>
            <button
              onClick={() => setShowSettingsModal(true)}
              style={{
                padding: "7px 12px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#334155",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer"
              }}
              title="Configure Web App deployment URL"
            >
              Settings
            </button>
          </div>
        </div>

        {/* Action Toolbar */}
        <div style={{
          marginTop: "18px",
          paddingTop: "16px",
          borderTop: "1px solid #f1f5f9",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px"
        }}>
          {/* Main Action Buttons (strictly Sentence Case) */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("GENERATE")}
              style={{
                padding: "8px 16px",
                background: actionInProgress === "GENERATE" ? "#93c5fd" : "#0066cc",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
              }}
            >
              {actionInProgress === "GENERATE" && <Spinner size="14px" color="#ffffff" />}
              <span>Create report(s)</span>
            </button>

            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("UPDATE")}
              style={{
                padding: "8px 16px",
                background: "#ffffff",
                color: "#0369a1",
                border: "1px solid #0284c7",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              {actionInProgress === "UPDATE" && <Spinner size="14px" color="#0369a1" />}
              <span>Update report(s)</span>
            </button>

            <button
              disabled={actionInProgress !== null || selectedClients.size === 0}
              onClick={() => handleRunBatchAction("EMAIL")}
              style={{
                padding: "8px 16px",
                background: "#ffffff",
                color: "#334155",
                border: "1px solid #94a3b8",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: actionInProgress !== null || selectedClients.size === 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              {actionInProgress === "EMAIL" && <Spinner size="14px" color="#334155" />}
              <span>Draft emails</span>
            </button>

            {actionInProgress && (
              <button
                type="button"
                onClick={handleCancelAction}
                style={{
                  padding: "8px 16px",
                  background: "#dc2626",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                </svg>
                <span>Stop task</span>
              </button>
            )}
          </div>

          {/* Filter & selection controls */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <label style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              color: "#475569",
              cursor: "pointer",
              userSelect: "none"
            }}>
              <input
                type="checkbox"
                checked={showConfiguredOnly}
                onChange={(e) => setShowConfiguredOnly(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>Show configured decks only ({configuredCount})</span>
            </label>

            <span style={{ fontSize: "12px", color: "#64748b" }}>
              {selectedClients.size} of {visibleClients.length} selected
            </span>
            <button
              onClick={toggleSelectAll}
              style={{
                padding: "6px 10px",
                background: "none",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "12px",
                color: "#334155",
                cursor: "pointer"
              }}
            >
              {visibleClients.length > 0 && visibleClients.every(c => selectedClients.has(c.clientName)) ? "Deselect all" : "Select all"}
            </button>
          </div>
        </div>
      </div>

      {/* ── NOTIFICATION STATUS BANNER ─────────────────────────────────────────── */}
      {statusMsg && (
        <div style={{
          marginBottom: "16px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "13px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: statusMsg.type === "error" ? "#fef2f2" : (statusMsg.type === "warning" ? "#fffbeb" : "#f0fdf4"),
          border: `1px solid ${statusMsg.type === "error" ? "#fecaca" : (statusMsg.type === "warning" ? "#fde68a" : "#bbf7d0")}`,
          color: statusMsg.type === "error" ? "#991b1b" : (statusMsg.type === "warning" ? "#92400e" : "#166534")
        }}>
          <div>{statusMsg.text}</div>
          <button
            onClick={() => setStatusMsg(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "bold" }}
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: "16px",
          padding: "10px 16px",
          borderRadius: "8px",
          fontSize: "13px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          color: "#991b1b"
        }}>
          {error}
        </div>
      )}

      {/* ── DETAILED EXECUTION PROGRESS PANEL ──────────────────────────────────── */}
      {runProgress && (
        <div style={{
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "10px",
          padding: "18px 20px",
          marginBottom: "18px",
          boxShadow: "0 2px 6px rgba(15, 23, 42, 0.06)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              {runProgress.isRunning && <Spinner size="16px" color="#0284c7" />}
              <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                {runProgress.mode === "GENERATE"
                  ? "Generating new management reports"
                  : (runProgress.mode === "UPDATE" ? "Updating existing decks" : "Drafting end of month emails")}
              </span>
              <span style={{
                fontSize: "11px",
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: "999px",
                background: "#f1f5f9",
                color: "#334155"
              }}>
                Client {runProgress.currentClientIdx + 1} of {runProgress.totalClients}: {runProgress.currentClientName}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#475569", fontFamily: "monospace" }}>
                Elapsed: {Math.floor((runProgress.elapsedSec || 0) / 60)}:{String((runProgress.elapsedSec || 0) % 60).padStart(2, "0")}
              </span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#0284c7" }}>
                {runProgress.overallPercent || 0}%
              </span>
              {!runProgress.isRunning && (
                <button
                  type="button"
                  onClick={() => setRunProgress(null)}
                  style={{
                    background: "none",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "11px",
                    color: "#64748b",
                    cursor: "pointer"
                  }}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>

          {/* Progress Bar */}
          <div style={{
            width: "100%",
            height: "8px",
            background: "#f1f5f9",
            borderRadius: "999px",
            overflow: "hidden",
            marginBottom: "10px"
          }}>
            <div style={{
              width: `${Math.min(100, Math.max(0, runProgress.overallPercent || 0))}%`,
              height: "100%",
              background: runProgress.isRunning ? "linear-gradient(90deg, #0284c7, #2563eb)" : "#16a34a",
              transition: "width 0.4s ease"
            }} />
          </div>

          {/* Live Sub-step Ticker */}
          <div style={{
            fontSize: "12px",
            color: "#0369a1",
            fontWeight: 600,
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: "6px",
            padding: "7px 12px",
            marginBottom: "14px",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }}>
            <span style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: runProgress.isRunning ? "#0284c7" : "#16a34a", flexShrink: 0 }} />
            <span>{runProgress.subStepLabel}</span>
          </div>

          {/* Step-by-step Stages Grid */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "10px",
            marginBottom: "12px"
          }}>
            {(runProgress.stages || []).map((st, idx) => {
              const isDone = st.status === "done";
              const isRunning = st.status === "running";
              const isErr = st.status === "error";
              return (
                <div
                  key={st.id || idx}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: `1px solid ${isRunning ? "#38bdf8" : (isDone ? "#bbf7d0" : (isErr ? "#fecaca" : "#e2e8f0"))}`,
                    background: isRunning ? "#f0f9ff" : (isDone ? "#f0fdf4" : (isErr ? "#fef2f2" : "#f8fafc"))
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                    {isRunning ? (
                      <Spinner size="12px" color="#0284c7" />
                    ) : isDone ? (
                      <span style={{ color: "#16a34a", fontWeight: 700, fontSize: "13px" }}>✓</span>
                    ) : isErr ? (
                      <span style={{ color: "#dc2626", fontWeight: 700, fontSize: "13px" }}>✕</span>
                    ) : (
                      <span style={{ color: "#94a3b8", fontSize: "12px" }}>○</span>
                    )}
                    <span style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: isRunning ? "#0369a1" : (isDone ? "#15803d" : (isErr ? "#b91c1c" : "#475569"))
                    }}>
                      {st.title}
                    </span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", lineHeight: 1.35 }}>
                    {st.detail}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Compact Live Activity Feed */}
          {runProgress.logs && runProgress.logs.length > 0 && (
            <div style={{
              maxHeight: "110px",
              overflowY: "auto",
              background: "#0f172a",
              color: "#e2e8f0",
              borderRadius: "6px",
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: "11px",
              lineHeight: 1.5
            }}>
              {runProgress.logs.map((logItem, lIdx) => (
                <div
                  key={lIdx}
                  style={{
                    color: logItem.type === "error" ? "#fca5a5" : (logItem.type === "success" ? "#86efac" : (logItem.type === "warning" ? "#fde047" : "#cbd5e1"))
                  }}
                >
                  <span style={{ color: "#64748b", marginRight: "8px" }}>[{logItem.time}]</span>
                  <span>{logItem.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CLIENT TABLE ───────────────────────────────────────────────────────── */}
      <div style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
      }}>
        {loading ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
            <Spinner size="24px" />
            <div style={{ marginTop: "10px", fontSize: "13px" }}>Loading reporting clients and configurations...</div>
          </div>
        ) : visibleClients.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
            {showConfiguredOnly
              ? "No clients with configured decks found. Uncheck 'Show configured decks only' to view all clients."
              : "No clients found."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569", fontWeight: 600 }}>
                  <th style={{ padding: "12px 16px", width: "40px" }}>
                    <input
                      type="checkbox"
                      checked={visibleClients.length > 0 && visibleClients.every(c => selectedClients.has(c.clientName))}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th style={{ padding: "12px 16px" }}>Client</th>
                  <th style={{ padding: "12px 16px" }}>Deck status</th>
                  <th style={{ padding: "12px 16px" }}>Latest report</th>
                  <th style={{ padding: "12px 16px" }}>Quick links</th>
                  <th style={{ padding: "12px 16px" }}>Email template</th>
                  <th style={{ padding: "12px 16px" }}>Execution status</th>
                </tr>
              </thead>
              <tbody>
                {visibleClients.map(client => {
                  const isChecked = selectedClients.has(client.clientName);
                  const statusInfo = clientStatuses[client.clientName];
                  const latestReport = client.latestReport;

                  return (
                    <tr
                      key={client.clientName}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        backgroundColor: isChecked ? "#f0fdf4" : "transparent",
                        transition: "background-color 0.15s ease"
                      }}
                    >
                      {/* Checkbox */}
                      <td style={{ padding: "12px 16px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleClientSelection(client.clientName)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>

                      {/* Client Name */}
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: 600, color: "#0f172a" }}>
                          {client.clientName}
                        </div>
                      </td>

                      {/* Deck Setup Badge */}
                      <td style={{ padding: "12px 16px" }}>
                        {client.hasDeckConfigured ? (
                          <span style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            background: "#e0f2fe",
                            color: "#0369a1"
                          }}>
                            Deck configured
                          </span>
                        ) : (
                          <span style={{
                            fontSize: "11px",
                            fontWeight: 500,
                            padding: "3px 8px",
                            borderRadius: "4px",
                            background: "#f1f5f9",
                            color: "#64748b"
                          }}>
                            No deck folder
                          </span>
                        )}
                      </td>

                      {/* Latest Report */}
                      <td style={{ padding: "12px 16px" }}>
                        {statusInfo?.reportUrl || latestReport?.reportUrl ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                            <a
                              href={statusInfo?.reportUrl || latestReport?.reportUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "3px 8px",
                                background: "#f0fdf4",
                                color: "#15803d",
                                border: "1px solid #bbf7d0",
                                borderRadius: "4px",
                                fontSize: "12px",
                                fontWeight: 600,
                                textDecoration: "none",
                                width: "fit-content"
                              }}
                            >
                              <span>Open deck</span>
                              <span style={{ fontSize: "10px" }}>↗</span>
                            </a>
                            {latestReport?.month && (
                              <span style={{
                                fontSize: "11px",
                                color: latestReport.month === selectedReportMonthKey ? "#16a34a" : "#64748b",
                                fontWeight: latestReport.month === selectedReportMonthKey ? 600 : 400
                              }}>
                                {latestReport.month === selectedReportMonthKey
                                  ? `${formatMonthKey(latestReport.month)}`
                                  : `Last run: ${formatMonthKey(latestReport.month)}`}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "#94a3b8", fontSize: "12px" }}>None yet</span>
                        )}
                      </td>

                      {/* Quick Links */}
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                          {client.masterSheetUrl && (
                            <a
                              href={client.masterSheetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#0284c7", textDecoration: "none" }}
                            >
                              Master
                            </a>
                          )}
                          {client.folderUrl && (
                            <a
                              href={client.folderUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "#0284c7", textDecoration: "none" }}
                            >
                              Folder
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Email Template Preview / Edit Trigger */}
                      <td style={{ padding: "12px 16px" }}>
                        <button
                          onClick={() => openEmailModal(client)}
                          style={{
                            background: "none",
                            border: "1px solid #e2e8f0",
                            borderRadius: "4px",
                            padding: "4px 8px",
                            fontSize: "12px",
                            color: client.emailTo ? "#0f172a" : "#94a3b8",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px"
                          }}
                        >
                          <span>{client.emailTo ? "Edit email" : "Configure"}</span>
                        </button>
                      </td>

                      {/* Execution Status */}
                      <td style={{ padding: "12px 16px", minWidth: "220px" }}>
                        {statusInfo ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <div style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              fontSize: "12px",
                              fontWeight: 600,
                              padding: "3px 8px",
                              borderRadius: "4px",
                              width: "fit-content",
                              background: statusInfo.status === "success" ? "#f0fdf4" : (statusInfo.status === "error" ? "#fef2f2" : (statusInfo.status === "cancelled" ? "#fffbeb" : "#f1f5f9")),
                              color: statusInfo.status === "success" ? "#15803d" : (statusInfo.status === "error" ? "#b91c1c" : (statusInfo.status === "cancelled" ? "#b45309" : "#0284c7"))
                            }}>
                              {statusInfo.status === "running" && <Spinner size="12px" />}
                              <span>{statusInfo.message}</span>
                              {statusInfo.status === "running" && typeof statusInfo.percent === "number" && (
                                <span style={{ marginLeft: "4px", fontWeight: 700 }}>({statusInfo.percent}%)</span>
                              )}
                            </div>
                            {statusInfo.status === "running" && typeof statusInfo.percent === "number" && (
                              <div style={{ width: "100%", maxWidth: "220px", height: "4px", background: "#e2e8f0", borderRadius: "999px", overflow: "hidden" }}>
                                <div style={{ width: `${Math.min(100, Math.max(0, statusInfo.percent))}%`, height: "100%", background: "#0284c7", transition: "width 0.4s ease" }} />
                              </div>
                            )}
                            {statusInfo.subDetail && (
                              <div style={{ fontSize: "11px", color: statusInfo.status === "error" ? "#b91c1c" : "#64748b", maxWidth: "260px", lineHeight: 1.3 }}>
                                {statusInfo.subDetail}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "#94a3b8", fontSize: "12px" }}>Ready</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── EMAIL TEMPLATE MODAL ──────────────────────────────────────────────── */}
      {emailModalClient && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "560px",
            padding: "24px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)"
          }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
              Email template: {emailModalClient.clientName}
            </h2>

            <div style={{ marginBottom: "12px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Send to (comma-separated email addresses):
              </label>
              <input
                type="text"
                value={emailForm.to}
                onChange={(e) => setEmailForm({ ...emailForm, to: e.target.value })}
                placeholder="name@example.com"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            <div style={{ marginBottom: "12px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Subject line:
              </label>
              <input
                type="text"
                value={emailForm.subj}
                onChange={(e) => setEmailForm({ ...emailForm, subj: e.target.value })}
                placeholder="End of month queries"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Email body:
              </label>
              <textarea
                rows={7}
                value={emailForm.body}
                onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })}
                placeholder="Hi..."
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  resize: "vertical"
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                onClick={() => setEmailModalClient(null)}
                style={{
                  padding: "8px 16px",
                  background: "none",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13px",
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                disabled={emailSaving}
                onClick={handleSaveEmailTemplate}
                style={{
                  padding: "8px 16px",
                  background: "#0066cc",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: emailSaving ? "default" : "pointer"
                }}
              >
                {emailSaving ? "Saving..." : "Save template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── REPORTS LOG MODAL ─────────────────────────────────────────────────── */}
      {showLogModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "760px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            overflow: "hidden"
          }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                Historical reports log
              </h2>
              <button
                onClick={() => setShowLogModal(false)}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                    <th style={{ padding: "10px 12px" }}>Client</th>
                    <th style={{ padding: "10px 12px" }}>Month</th>
                    <th style={{ padding: "10px 12px" }}>Report presentation</th>
                    <th style={{ padding: "10px 12px" }}>Logged date</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.flatMap(c => (c.reportHistory || []).map(h => ({ clientName: c.clientName, ...h }))).length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "24px", textAlign: "center", color: "#94a3b8" }}>
                        No generated reports recorded in log yet.
                      </td>
                    </tr>
                  ) : (
                    clients.flatMap(c => (c.reportHistory || []).map(h => ({ clientName: c.clientName, ...h }))).map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "10px 12px", fontWeight: 600 }}>{item.clientName}</td>
                        <td style={{ padding: "10px 12px" }}>{item.month}</td>
                        <td style={{ padding: "10px 12px" }}>
                          <a href={item.reportUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#0066cc", textDecoration: "none" }}>
                            {item.reportName || "Open presentation"} ↗
                          </a>
                        </td>
                        <td style={{ padding: "10px 12px", color: "#64748b", fontSize: "12px" }}>
                          {item.createdAt ? new Date(item.createdAt).toLocaleDateString("en-GB") : "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "14px 24px", borderTop: "1px solid #e2e8f0", textAlign: "right" }}>
              <button
                onClick={() => setShowLogModal(false)}
                style={{ padding: "7px 16px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CHART REFERENCES MODAL ────────────────────────────────────────────── */}
      {showChartRefsModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "680px",
            maxHeight: "85vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            overflow: "hidden"
          }}>
            <div style={{ padding: "18px 24px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ margin: "0 0 2px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
                  Chart &amp; table references
                </h2>
                <p style={{ margin: 0, fontSize: "12px", color: "#64748b" }}>
                  Mapped slide speaker notes codes to Master Sheet cell ranges (tab: MgmtRep). Stored in Reporting Control sheet.
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {!editingRef && (
                  <button
                    type="button"
                    onClick={() => setEditingRef({ code: "", range: "", label: "", isNew: true })}
                    style={{
                      padding: "6px 12px",
                      background: "#0066cc",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px"
                    }}
                  >
                    + Add reference
                  </button>
                )}
                <button
                  onClick={() => { setShowChartRefsModal(false); setEditingRef(null); }}
                  style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
              {editingRef && (
                <div style={{
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "8px",
                  padding: "16px",
                  marginBottom: "16px"
                }}>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
                    {editingRef.isNew ? "Add new chart reference" : `Edit reference: ${editingRef.originalCode || editingRef.code}`}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                        Speaker notes code:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. [MonthSnapshot]"
                        value={editingRef.code}
                        onChange={(e) => setEditingRef({ ...editingRef, code: e.target.value })}
                        style={{ width: "100%", padding: "7px 10px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "6px", fontFamily: "monospace", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                        MgmtRep cell range:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. C31:J47"
                        value={editingRef.range}
                        onChange={(e) => setEditingRef({ ...editingRef, range: e.target.value })}
                        style={{ width: "100%", padding: "7px 10px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "6px", fontFamily: "monospace", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                        Description:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Month snapshot table"
                        value={editingRef.label}
                        onChange={(e) => setEditingRef({ ...editingRef, label: e.target.value })}
                        style={{ width: "100%", padding: "7px 10px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "6px", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() => setEditingRef(null)}
                      style={{ padding: "6px 12px", background: "none", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "12px", cursor: "pointer" }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={refSaving}
                      onClick={handleSaveChartRef}
                      style={{
                        padding: "6px 14px",
                        background: "#0066cc",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: refSaving ? "default" : "pointer"
                      }}
                    >
                      {refSaving ? "Saving..." : "Save reference"}
                    </button>
                  </div>
                </div>
              )}

              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                    <th style={{ padding: "8px 12px" }}>Speaker notes code</th>
                    <th style={{ padding: "8px 12px" }}>MgmtRep cell range</th>
                    <th style={{ padding: "8px 12px" }}>Description</th>
                    <th style={{ padding: "8px 12px", width: "110px", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {chartRefs.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: "24px", textAlign: "center", color: "#94a3b8" }}>
                        No chart references found. Click &quot;+ Add reference&quot; to create one.
                      </td>
                    </tr>
                  ) : (
                    chartRefs.map((ref, idx) => (
                      <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "8px 12px", fontWeight: 600, color: "#0066cc", fontFamily: "monospace" }}>{ref.code}</td>
                        <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{ref.range}</td>
                        <td style={{ padding: "8px 12px", color: "#64748b" }}>{ref.label || "-"}</td>
                        <td style={{ padding: "8px 12px", textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end" }}>
                            <button
                              type="button"
                              onClick={() => setEditingRef({ code: ref.code, range: ref.range, label: ref.label || "", originalCode: ref.code, isNew: false })}
                              style={{
                                padding: "3px 8px",
                                background: "none",
                                border: "1px solid #cbd5e1",
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "#0369a1",
                                cursor: "pointer"
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={refDeletingCode === ref.code}
                              onClick={() => handleDeleteChartRef(ref.code)}
                              style={{
                                padding: "3px 8px",
                                background: "none",
                                border: "1px solid #fecaca",
                                borderRadius: "4px",
                                fontSize: "11px",
                                color: "#b91c1c",
                                cursor: refDeletingCode === ref.code ? "default" : "pointer"
                              }}
                            >
                              {refDeletingCode === ref.code ? "..." : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "14px 24px", borderTop: "1px solid #e2e8f0", textAlign: "right" }}>
              <button
                onClick={() => setShowChartRefsModal(false)}
                style={{ padding: "7px 16px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SETTINGS MODAL ────────────────────────────────────────────────────── */}
      {showSettingsModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: "20px"
        }}>
          <div style={{
            background: "#ffffff",
            borderRadius: "10px",
            width: "100%",
            maxWidth: "540px",
            padding: "24px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)"
          }}>
            <h2 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>
              Reporting integration settings
            </h2>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#64748b" }}>
              Deployed Google Apps Script Web App URL for generating slides and drafting emails.
            </p>

            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                Web App URL:
              </label>
              <input
                type="text"
                value={settingsUrlInput}
                onChange={(e) => setSettingsUrlInput(e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: "13px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  boxSizing: "border-box"
                }}
              />
            </div>

            {settingsTestResult && (
              <div style={{
                marginBottom: "16px",
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor: settingsTestResult.success ? "#f0fdf4" : "#fef2f2",
                color: settingsTestResult.success ? "#166534" : "#991b1b",
                border: `1px solid ${settingsTestResult.success ? "#bbf7d0" : "#fecaca"}`
              }}>
                {settingsTestResult.message}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button
                disabled={settingsTesting}
                onClick={handleTestWebAppConnection}
                style={{
                  padding: "7px 12px",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "12px",
                  cursor: settingsTesting ? "default" : "pointer"
                }}
              >
                {settingsTesting ? "Testing..." : "Test connection"}
              </button>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  style={{
                    padding: "8px 16px",
                    background: "none",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveSettings}
                  style={{
                    padding: "8px 16px",
                    background: "#0066cc",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Save settings
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
