import { useState } from "react";

export function useIgnoredAlerts(automationCommanderSheetId, setAcceptError) {
  const [ignoredAlerts, setIgnoredAlerts] = useState([]);
  const [isLoadingIgnored, setIsLoadingIgnored] = useState(false);
  const [isUnignoring, setIsUnignoring] = useState(null);

  const loadIgnoredAlerts = async () => {
    try {
      setIsLoadingIgnored(true);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_ignored_alerts",
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to load ignored alerts: ${data.error || "Unknown error"}`);
        return;
      }

      setIgnoredAlerts(data.ignoredAlerts || []);
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsLoadingIgnored(false);
    }
  };

  const unignoreAlert = async (fingerprintHash) => {
    try {
      setIsUnignoring(fingerprintHash);
      setAcceptError("");

      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unignore_alert",
          fingerprintHash,
          automationCommanderSheetId,
        }),
      });

      const data = await response.json();
      if (!data.success) {
        setAcceptError(`Failed to un-ignore alert: ${data.error || "Unknown error"}`);
        return;
      }

      // Remove from local list
      setIgnoredAlerts(prev => prev.filter(a => a.fingerprintHash !== fingerprintHash));
    } catch (err) {
      setAcceptError(`Error: ${err.message}`);
    } finally {
      setIsUnignoring(null);
    }
  };

  return {
    ignoredAlerts,
    isLoadingIgnored,
    isUnignoring,
    loadIgnoredAlerts,
    unignoreAlert
  };
}