import { useState, useEffect, useCallback } from "react";

export function useSettings(automationCommanderSheetId) {
  const [settingsData, setSettingsData] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsEditHourly, setSettingsEditHourly] = useState(10);
  const [settingsEditDaily, setSettingsEditDaily] = useState(30);
  const [settingsEditAnomaly, setSettingsEditAnomaly] = useState(15);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveMsg, setSettingsSaveMsg] = useState("");
  
  const [agentRunClient, setAgentRunClient] = useState("");
  const [agentRunTypes, setAgentRunTypes] = useState({ invoice: false, crm: false, expense: false });
  const [agentRunStatus, setAgentRunStatus] = useState("idle");
  const [agentRunMsg, setAgentRunMsg] = useState("");
  const [agentRunId, setAgentRunId] = useState(null);
  const [agentProgressEntries, setAgentProgressEntries] = useState([]);
  const [agentRunStartedAt, setAgentRunStartedAt] = useState(0);

  const [sweepSchedule, setSweepSchedule] = useState(null);
  const [sweepScheduleLoading, setSweepScheduleLoading] = useState(false);
  const [sweepScheduleLoaded, setSweepScheduleLoaded] = useState(false);
  const [sweepFrequencySaving, setSweepFrequencySaving] = useState("");

  const [flagSweepLog, setFlagSweepLog] = useState(null);
  const [flagSweepLogLoading, setFlagSweepLogLoading] = useState(false);
  const [flagSweepLogLoaded, setFlagSweepLogLoaded] = useState(false);
  const [flagSweepLogExpanded, setFlagSweepLogExpanded] = useState(new Set());

  const [precomputeLog, setPrecomputeLog] = useState(null);
  const [precomputeLogLoading, setPrecomputeLogLoading] = useState(false);
  const [precomputeLogLoaded, setPrecomputeLogLoaded] = useState(false);
  const [precomputeLogExpanded, setPrecomputeLogExpanded] = useState(new Set());

  const [buildOptionsLog, setBuildOptionsLog] = useState(null);
  const [buildOptionsLogLoading, setBuildOptionsLogLoading] = useState(false);
  const [buildOptionsLogLoaded, setBuildOptionsLogLoaded] = useState(false);
  const [buildOptionsLogExpanded, setBuildOptionsLogExpanded] = useState(new Set());

  // Automatically re-attach to an ongoing or recently completed run on mount / client change
  useEffect(() => {
    let isCancelled = false;
    const checkActiveRun = async () => {
      try {
        let stored = null;
        if (typeof window !== "undefined") {
          try {
            const raw = localStorage.getItem("pulse_active_agent_run");
            if (raw) stored = JSON.parse(raw);
          } catch {}
        }

        const targetClient = agentRunClient || stored?.clientName || undefined;
        const r = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_active_agent_run", clientName: targetClient })
        });
        const d = await r.json();
        if (isCancelled) return;

        const active = d?.activeRun || stored;
        if (active && active.runId) {
          // Check if within 15 minutes window
          if (Date.now() - (active.startedAt || 0) < 15 * 60 * 1000) {
            if (active.clientName && !agentRunClient) {
              setAgentRunClient(active.clientName);
            }
            if (active.types && Array.isArray(active.types)) {
              setAgentRunTypes({
                invoice: active.types.includes("invoice"),
                crm: active.types.includes("crm"),
                expense: active.types.includes("expense"),
              });
            }
            setAgentRunId(active.runId);
            setAgentRunStartedAt(active.startedAt || Date.now());

            if (active.status === "completed" || active.done) {
              setAgentRunStatus("success");
              setAgentRunMsg("✓ Run complete.");
              if (typeof window !== "undefined") localStorage.removeItem("pulse_active_agent_run");
            } else if (active.status === "error") {
              setAgentRunStatus("error");
              setAgentRunMsg(active.error || "Automation run encountered an error.");
              if (typeof window !== "undefined") localStorage.removeItem("pulse_active_agent_run");
            } else {
              setAgentRunStatus("running");
              setAgentRunMsg("Automation sequence running in background...");
            }

            // Fetch progress entries right away
            try {
              const prResp = await fetch("/api/triage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "get_agent_run_progress", clientName: active.clientName, runId: active.runId })
              });
              const prData = await prResp.json();
              if (prData.success && prData.entries && !isCancelled) {
                setAgentProgressEntries(prData.entries);
              }
            } catch (prErr) { /* ignore */ }
          }
        }
      } catch (e) {
        console.warn("Could not check active agent run:", e);
      }
    };

    checkActiveRun();
    return () => { isCancelled = true; };
  }, [agentRunClient]);

  // Live progress polling loop
  useEffect(() => {
    if (!agentRunId || agentRunStatus !== "running") return;
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("pulse_active_agent_run", JSON.stringify({
          runId: agentRunId,
          clientName: agentRunClient,
          startedAt: agentRunStartedAt,
          status: "running"
        }));
      } catch {}
    }

    const interval = setInterval(async () => {
      if (Date.now() - agentRunStartedAt > 15 * 60 * 1000) {
        setAgentRunStatus("error");
        setAgentRunMsg("No completion reported after 15 minutes - check that client's Apps Script Executions panel directly.");
        if (typeof window !== "undefined") localStorage.removeItem("pulse_active_agent_run");
        return;
      }
      try {
        const r = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_agent_run_progress", clientName: agentRunClient, runId: agentRunId })
        });
        const d = await r.json();
        if (d.success) {
          setAgentProgressEntries(d.entries || []);
          if (d.done) {
            setAgentRunStatus("success");
            setAgentRunMsg("✓ Run complete.");
            if (typeof window !== "undefined") localStorage.removeItem("pulse_active_agent_run");
          }
        }
      } catch (e) { /* transient poll failure */ }
    }, 2000);

    return () => clearInterval(interval);
  }, [agentRunId, agentRunStatus, agentRunClient, agentRunStartedAt]);

  const loadSweepSchedule = useCallback(async () => {
    try {
      setSweepScheduleLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_sweep_schedule", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) setSweepSchedule(data.schedule || {});
    } catch(e) { console.error("loadSweepSchedule error:", e); }
    finally { setSweepScheduleLoading(false); setSweepScheduleLoaded(true); }
  }, [automationCommanderSheetId]);

  const saveSweepFrequency = useCallback(async (category, newFrequencyMinutes) => {
    setSweepSchedule(prev => {
        if (!prev) return prev;
        return { ...prev, [category]: { ...prev[category], frequencyMinutes: newFrequencyMinutes } };
    });
    setSweepFrequencySaving(category);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_sweep_frequency", automationCommanderSheetId, category, frequencyMinutes: newFrequencyMinutes }),
      });
      const data = await res.json();
      if (!data.success) {
        console.error("save_sweep_frequency failed:", data.error);
        loadSweepSchedule(); // Revert on failure
      }
    } catch (e) {
      console.error("saveSweepFrequency error:", e);
      loadSweepSchedule();
    } finally {
      setSweepFrequencySaving("");
    }
  }, [automationCommanderSheetId, loadSweepSchedule]);

  const loadFlagSweepLog = useCallback(async () => {
    try {
      setFlagSweepLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_flag_sweep_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) setFlagSweepLog(data.runs || []);
    } catch(e) { console.error("loadFlagSweepLog error:", e); }
    finally { setFlagSweepLogLoading(false); setFlagSweepLogLoaded(true); }
  }, [automationCommanderSheetId]);

  const toggleFlagSweepLogDetail = useCallback((i) => {
    setFlagSweepLogExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const loadPrecomputeLog = useCallback(async () => {
    try {
      setPrecomputeLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_precompute_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) setPrecomputeLog(data.runs || []);
    } catch(e) { console.error("loadPrecomputeLog error:", e); }
    finally { setPrecomputeLogLoading(false); setPrecomputeLogLoaded(true); }
  }, [automationCommanderSheetId]);

  const loadBuildOptionsLog = useCallback(async () => {
    try {
      setBuildOptionsLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_build_options_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) setBuildOptionsLog(data.runs || []);
    } catch(e) { console.error("loadBuildOptionsLog error:", e); }
    finally { setBuildOptionsLogLoading(false); setBuildOptionsLogLoaded(true); }
  }, [automationCommanderSheetId]);

  const togglePrecomputeLogDetail = useCallback((i) => {
    setPrecomputeLogExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const toggleBuildOptionsLogDetail = useCallback((i) => {
    setBuildOptionsLogExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  return {
    settingsData, setSettingsData, settingsLoading, setSettingsLoading,
    settingsEditHourly, setSettingsEditHourly, settingsEditDaily, setSettingsEditDaily,
    settingsEditAnomaly, setSettingsEditAnomaly, settingsSaving, setSettingsSaving,
    settingsSaveMsg, setSettingsSaveMsg, agentRunClient, setAgentRunClient,
    agentRunTypes, setAgentRunTypes, agentRunStatus, setAgentRunStatus,
    agentRunMsg, setAgentRunMsg, agentRunId, setAgentRunId,
    agentProgressEntries, setAgentProgressEntries, agentRunStartedAt, setAgentRunStartedAt,
    sweepSchedule, setSweepSchedule, sweepScheduleLoading, setSweepScheduleLoading,
    sweepScheduleLoaded, setSweepScheduleLoaded, sweepFrequencySaving, setSweepFrequencySaving,
    flagSweepLog, setFlagSweepLog, flagSweepLogLoading, setFlagSweepLogLoading,
    flagSweepLogLoaded, setFlagSweepLogLoaded, flagSweepLogExpanded, setFlagSweepLogExpanded,
    precomputeLog, setPrecomputeLog, precomputeLogLoading, setPrecomputeLogLoading,
    precomputeLogLoaded, setPrecomputeLogLoaded, precomputeLogExpanded, setPrecomputeLogExpanded,
    buildOptionsLog, setBuildOptionsLog, buildOptionsLogLoading, setBuildOptionsLogLoading,
    buildOptionsLogLoaded, setBuildOptionsLogLoaded, buildOptionsLogExpanded, setBuildOptionsLogExpanded,
    loadSweepSchedule, saveSweepFrequency, loadFlagSweepLog, toggleFlagSweepLogDetail,
    loadPrecomputeLog, loadBuildOptionsLog, togglePrecomputeLogDetail, toggleBuildOptionsLogDetail
  };
}