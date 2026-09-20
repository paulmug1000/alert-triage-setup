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

  useEffect(() => {
    if (!agentRunId || agentRunStatus !== "running") return;
    const interval = setInterval(async () => {
      if (Date.now() - agentRunStartedAt > 15 * 60 * 1000) {
        setAgentRunStatus("error");
        setAgentRunMsg("No completion reported after 15 minutes — check that client's Apps Script Executions panel directly.");
        return;
      }
      try {
        const r = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_agent_run_progress", clientName: agentRunClient, runId: agentRunId }) });
        const d = await r.json();
        if (d.success) {
          setAgentProgressEntries(d.entries || []);
          if (d.done) {
            setAgentRunStatus("success");
            setAgentRunMsg("✓ Run complete.");
          }
        }
      } catch (e) { /* transient poll failure */ }
    }, 3000);
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