import { useState } from "react";

export function useOverview(automationCommanderSheetId) {
  const [overviewData, setOverviewData] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const loadOverview = async () => {
    try {
      setOverviewLoading(true);
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_overview", automationCommanderSheetId }),
      });
      const data = await response.json();
      if (data.success) setOverviewData(data.clients || []);
    } catch (err) {
      console.error("Failed to load overview:", err);
    } finally {
      setOverviewLoading(false);
    }
  };

  return {
    overviewData, setOverviewData,
    overviewLoading, setOverviewLoading,
    loadOverview
  };
}