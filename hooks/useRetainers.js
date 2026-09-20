import { useState } from "react";

export function useRetainers() {
  const [retainersClient, setRetainersClient] = useState(null);
  const [retainersJobs, setRetainersJobs] = useState(null);
  const [retainersJobsLoading, setRetainersJobsLoading] = useState(false);
  const [isTidying, setIsTidying] = useState(false);
  const [showTidyConfirm, setShowTidyConfirm] = useState(false);
  const [tidyResult, setTidyResult] = useState(null);
  const [retainersEditJob, setRetainersEditJob] = useState(null);
  const [expandedRetainerJobs, setExpandedRetainerJobs] = useState(() => new Set());
  const [showCreateRetainerModal, setShowCreateRetainerModal] = useState(false);
  const [retainerAlertResolution, setRetainerAlertResolution] = useState(null);
  const [retainerSplitInvoice, setRetainerSplitInvoice] = useState(null);

  const loadRetainersJobs = async (client) => {
    if (!client?.clientSheetId) return;
    try {
      setRetainersJobsLoading(true);
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_retainer_jobs", clientSheetId: client.clientSheetId }),
      });
      const data = await res.json();
      if (data.success) setRetainersJobs(data.jobs);
    } catch(e) { 
      console.error("loadRetainersJobs error:", e); 
    } finally { 
      setRetainersJobsLoading(false); 
    }
  };

  const handleTidyRetainers = async () => {
    setShowTidyConfirm(false);
    setIsTidying(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tidy_up_retainers", clientSheetId: retainersClient.clientSheetId, masterSheetId: retainersClient.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setTidyResult({ success: true, moves: data.moves });
        loadRetainersJobs(retainersClient);
      } else {
        setTidyResult({ success: false, error: data.error });
      }
    } catch(e) {
      setTidyResult({ success: false, error: e.message });
    } finally {
      setIsTidying(false);
    }
  };

  return {
    retainersClient, setRetainersClient,
    retainersJobs, setRetainersJobs,
    retainersJobsLoading, setRetainersJobsLoading,
    isTidying, setIsTidying,
    showTidyConfirm, setShowTidyConfirm,
    tidyResult, setTidyResult,
    retainersEditJob, setRetainersEditJob,
    expandedRetainerJobs, setExpandedRetainerJobs,
    showCreateRetainerModal, setShowCreateRetainerModal,
    retainerAlertResolution, setRetainerAlertResolution,
    retainerSplitInvoice, setRetainerSplitInvoice,
    loadRetainersJobs, handleTidyRetainers
  };
}