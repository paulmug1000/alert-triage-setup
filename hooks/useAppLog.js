import { useState } from "react";

export function useAppLog(automationCommanderSheetId) {
  const [appLogData, setAppLogData] = useState([]);
  const [appLogLoading, setAppLogLoading] = useState(false);
  const [appLogLoadedAt, setAppLogLoadedAt] = useState(0);

  const loadAppLog = async () => {
    try {
      setAppLogLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_app_log", automationCommanderSheetId }),
      });
      const data = await res.json();
      if (data.success) {
        setAppLogData(data.rows || []);
        setAppLogLoadedAt(Date.now());
      }
    } catch (err) {
      console.error("Failed to load App Log:", err);
    } finally {
      setAppLogLoading(false);
    }
  };

  return {
    appLogData, setAppLogData,
    appLogLoading, setAppLogLoading,
    appLogLoadedAt, setAppLogLoadedAt,
    loadAppLog
  };
}