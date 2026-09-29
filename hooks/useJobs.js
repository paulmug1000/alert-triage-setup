import { useState } from "react";

export function useJobs() {
  const [jobsClient, setJobsClient] = useState(null);
  const [jobsTab, setJobsTab] = useState("Confirmed");
  const [jobsSortBy, setJobsSortBy] = useState("startDateDesc");
  const [jobsData, setJobsData] = useState(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsExpanded, setJobsExpanded] = useState(() => new Set());
  const [jobsEditSplit, setJobsEditSplit] = useState(null);
  const [productLines, setProductLines] = useState([]);
  const [leadSources, setLeadSources] = useState([]);
  const [existingClients, setExistingClients] = useState([]);

  const loadJobsData = async (client, tabName) => {
    if (!client?.clientSheetId) return;
    try {
      setJobsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_all_client_jobs", clientSheetId: client.clientSheetId, tabName }),
      });
      const data = await res.json();
      if (data.success) {
        setJobsData(data.jobs);
        if (data.productLines) setProductLines(data.productLines);
        if (data.leadSources) setLeadSources(data.leadSources);
        if (data.existingClients) setExistingClients(data.existingClients);
      }
    } catch (e) {
      console.error("loadJobsData error:", e);
    } finally {
      setJobsLoading(false);
    }
  };

  return {
    jobsClient, setJobsClient,
    jobsTab, setJobsTab,
    jobsSortBy, setJobsSortBy,
    jobsData, setJobsData,
    jobsLoading,
    jobsExpanded, setJobsExpanded,
    jobsEditSplit, setJobsEditSplit,
    productLines, setProductLines,
    leadSources, setLeadSources,
    existingClients, setExistingClients,
    loadJobsData
  };
}