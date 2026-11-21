import React, { useEffect, useMemo, useState } from "react";
import Spinner from "../Spinner";

function formatMoney(val, currency = "GBP") {
  const num = Number(val) || 0;
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  return `${symbol}${num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getDefaultProjectDateRangeIso(sendDateIso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(sendDateIso || ""));
  if (!match) return { startDateIso: "", endDateIso: "" };
  const yr = Number(match[1]);
  const mon = Number(match[2]); // 1-12
  const lastDay = new Date(yr, mon, 0).getDate();
  const mm = String(mon).padStart(2, "0");
  return {
    startDateIso: `${yr}-${mm}-01`,
    endDateIso: `${yr}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

export default function InitialInvoiceSetupModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onCompleted,
}) {
  const [step, setStep] = useState("import"); // "import" | "retainers" | "remaining" | "done"
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [analysisData, setAnalysisData] = useState(null);
  const [retainers, setRetainers] = useState([]);
  const [selectedRetainerIds, setSelectedRetainerIds] = useState(() => new Set());
  const [assignedRetainerRefs, setAssignedRetainerRefs] = useState(() => new Set());
  const [retainersSummary, setRetainersSummary] = useState(null);
  const [includeAllInvoiceDetail, setIncludeAllInvoiceDetail] = useState(false);
  const [manualTitleIds, setManualTitleIds] = useState(() => new Set());

  const [selectedRemainingIds, setSelectedRemainingIds] = useState(() => new Set());
  const [jobNameOverrides, setJobNameOverrides] = useState({});
  const [startDateOverrides, setStartDateOverrides] = useState({});
  const [endDateOverrides, setEndDateOverrides] = useState({});
  const [finalSummary, setFinalSummary] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep("import");
    setLoading(false);
    setSubmitting(false);
    setFeedback(null);
    setAnalysisData(null);
    setRetainers([]);
    setSelectedRetainerIds(new Set());
    setAssignedRetainerRefs(new Set());
    setRetainersSummary(null);
    setIncludeAllInvoiceDetail(false);
    setManualTitleIds(new Set());
    setSelectedRemainingIds(new Set());
    setJobNameOverrides({});
    setStartDateOverrides({});
    setEndDateOverrides({});
    setFinalSummary(null);
  }, [isOpen, clientName, masterSheetId]);

  const handleImportAndAnalyse = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/initial-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "import_and_analyse",
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to import invoices." });
        return;
      }
      setAnalysisData(json);
      const suggested = json.suggestedRetainers || [];
      setRetainers(suggested);
      setSelectedRetainerIds(new Set(suggested.map((r) => r.id)));
      setStep("retainers");
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to import invoices." });
    } finally {
      setLoading(false);
    }
  };

  // Remaining invoices dated >= cutoff3m that were NOT created under a retainer in Step 2
  const remainingInvoices = useMemo(() => {
    if (!analysisData) return [];
    const cutoffIso = analysisData.cutoff3mIso || "";
    return (analysisData.invoices || []).filter((inv) => {
      if (!inv || inv.alreadyOnConfirmed) return false;
      if (Number(inv.subTotal) <= 0.005) return false;
      if (assignedRetainerRefs.has(String(inv.invoiceNoKey || inv.invoiceNo || "").toLowerCase())) return false;
      return inv.sendDateIso >= cutoffIso;
    });
  }, [analysisData, assignedRetainerRefs]);

  const moveToRemainingStep = (newlyAssignedSet) => {
    const cutoffIso = analysisData?.cutoff3mIso || "";
    const nextRemaining = (analysisData?.invoices || []).filter((inv) => {
      if (!inv || inv.alreadyOnConfirmed) return false;
      if (Number(inv.subTotal) <= 0.005) return false;
      if (newlyAssignedSet.has(String(inv.invoiceNoKey || inv.invoiceNo || "").toLowerCase())) return false;
      return inv.sendDateIso >= cutoffIso;
    });
    setSelectedRemainingIds(new Set(nextRemaining.map((i) => i.id)));
    setStep("remaining");
  };

  const handleConfirmRetainers = async () => {
    const selectedList = retainers.filter((r) => selectedRetainerIds.has(r.id));
    if (selectedList.length === 0) {
      setRetainersSummary({ createdCount: 0, assignedInvoiceCount: 0 });
      moveToRemainingStep(new Set());
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/initial-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "create_retainers",
          retainers: selectedList,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to create retainer jobs." });
        return;
      }

      // Exclude all matched invoices of selected retainers from Step 3 (remaining)
      const assignedKeys = new Set(assignedRetainerRefs);
      for (const r of selectedList) {
        for (const inv of r.matchedInvoices || []) {
          assignedKeys.add(String(inv.invoiceNoKey || inv.invoiceNo || "").toLowerCase());
        }
      }
      setAssignedRetainerRefs(assignedKeys);
      setRetainersSummary({
        createdCount: json.createdCount || 0,
        assignedInvoiceCount: json.assignedInvoiceCount || 0,
      });
      moveToRemainingStep(assignedKeys);
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to create retainer jobs." });
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRemaining = async () => {
    const selectedList = remainingInvoices
      .filter((inv) => selectedRemainingIds.has(inv.id))
      .map((inv) => {
        const defaults = getDefaultProjectDateRangeIso(inv.sendDateIso);
        return {
          ...inv,
          jobName: String(jobNameOverrides[inv.id] ?? inv.description ?? `Invoice ${inv.invoiceNo}`).trim(),
          startDateIso: startDateOverrides[inv.id] ?? defaults.startDateIso,
          endDateIso: endDateOverrides[inv.id] ?? defaults.endDateIso,
        };
      });

    if (selectedList.length === 0) {
      setFinalSummary({
        retainersCreated: retainersSummary?.createdCount || 0,
        retainerInvoicesAssigned: retainersSummary?.assignedInvoiceCount || 0,
        projectsCreated: 0,
      });
      setStep("done");
      if (onCompleted) onCompleted();
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/initial-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          action: "create_remaining_jobs",
          invoices: selectedList,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setFeedback({ type: "error", message: json.error || "Failed to create project jobs." });
        return;
      }
      setFinalSummary({
        retainersCreated: retainersSummary?.createdCount || 0,
        retainerInvoicesAssigned: retainersSummary?.assignedInvoiceCount || 0,
        projectsCreated: json.createdCount || 0,
      });
      setStep("done");
      if (onCompleted) onCompleted();
    } catch (err) {
      setFeedback({ type: "error", message: err.message || "Failed to create project jobs." });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleRetainer = (id) => {
    setSelectedRetainerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRemaining = (id) => {
    setSelectedRemainingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateRetainerField = (id, key, value, { isManual = true } = {}) => {
    setRetainers((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
    if (key === "jobName") {
      setManualTitleIds((prev) => {
        const next = new Set(prev);
        if (isManual) next.add(id);
        else next.delete(id);
        return next;
      });
    }
  };

  const handleToggleAllInvoiceDetail = (checked) => {
    setIncludeAllInvoiceDetail(checked);
    setRetainers((prev) =>
      prev.map((r) => {
        if (manualTitleIds.has(r.id)) return r;
        if (checked) {
          return { ...r, jobName: r.detailedJobName || r.baseJobName };
        }
        return {
          ...r,
          jobName: r.hasMultipleForClient && r.detailedJobName ? r.detailedJobName : r.baseJobName,
        };
      })
    );
  };

  if (!isOpen) return null;

  const currency = analysisData?.currency || "GBP";
  const allRemainingChecked = remainingInvoices.length > 0 && remainingInvoices.every((i) => selectedRemainingIds.has(i.id));

  const stepLabels = [
    { key: "import", label: "1. Import invoices" },
    { key: "retainers", label: "2. Retainer jobs" },
    { key: "remaining", label: "3. Remaining invoices" },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px",
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "96vw",
          maxWidth: "1480px",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0F172A" }}>
              Initial invoice setup
            </h2>
            <p style={{ margin: "3px 0 0 0", fontSize: "12px", color: "#64748B" }}>
              {clientName}
              {analysisData?.startDateFormatted
                ? ` · Start date: ${analysisData.startDateFormatted} · Recent window from ${analysisData.cutoff3mFormatted}`
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              lineHeight: 1,
              color: "#64748B",
              cursor: "pointer",
              padding: "4px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Stepper */}
        <div
          style={{
            padding: "10px 24px",
            borderBottom: "1px solid #E2E8F0",
            backgroundColor: "#FFFFFF",
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          {stepLabels.map((s) => {
            const isCurrent = step === s.key;
            const isCompleted =
              (s.key === "import" && step !== "import") ||
              (s.key === "retainers" && (step === "remaining" || step === "done")) ||
              (s.key === "remaining" && step === "done");
            return (
              <div
                key={s.key}
                style={{
                  padding: "4px 12px",
                  borderRadius: "999px",
                  fontSize: "12px",
                  fontWeight: 600,
                  backgroundColor: isCurrent ? "#EFF6FF" : isCompleted ? "#ECFDF5" : "#F1F5F9",
                  color: isCurrent ? "#1D4ED8" : isCompleted ? "#047857" : "#64748B",
                  border: `1px solid ${isCurrent ? "#BFDBFE" : isCompleted ? "#A7F3D0" : "#E2E8F0"}`,
                }}
              >
                {s.label}
              </div>
            );
          })}
        </div>

        {/* Feedback banner */}
        {feedback && (
          <div
            style={{
              padding: "10px 24px",
              fontSize: "13px",
              fontWeight: 500,
              backgroundColor: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
              color: feedback.type === "error" ? "#B91C1C" : "#047857",
              borderBottom: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
            }}
          >
            {feedback.message}
          </div>
        )}

        {/* Body */}
        <div
          style={{
            padding: "18px 22px",
            overflowY: "auto",
            flex: "1 1 auto",
            minHeight: 0,
            maxHeight: "calc(92vh - 150px)",
          }}
        >
          {step === "import" && (
            <div
              style={{
                textAlign: "center",
                padding: "44px 20px",
                border: "1px dashed #CBD5E1",
                borderRadius: "12px",
                backgroundColor: "#F8FAFC",
              }}
            >
              {loading ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                  <Spinner size="md" />
                  <div style={{ fontSize: "14px", fontWeight: 600, color: "#1E293B" }}>
                    Importing invoices and scanning for recurring retainers...
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748B" }}>
                    Analysing 12 months of invoices leading up to the system start date.
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: "16px", fontWeight: 700, color: "#0F172A", marginBottom: "8px" }}>
                    Import historical invoices and detect retainers
                  </div>
                  <p style={{ fontSize: "13px", color: "#64748B", maxWidth: "560px", margin: "0 auto 20px auto", lineHeight: 1.5 }}>
                    This process imports sales invoices for the year leading up to the system start date, identifies recurring
                    retainers for confirmation, and then lists all remaining invoices from three months before the start date to
                    create project jobs.
                  </p>
                  <button
                    type="button"
                    onClick={handleImportAndAnalyse}
                    style={{
                      padding: "10px 20px",
                      borderRadius: "8px",
                      border: "none",
                      backgroundColor: "#2563EB",
                      color: "#FFFFFF",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Import invoices
                  </button>
                </>
              )}
            </div>
          )}

          {step === "retainers" && analysisData && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  marginBottom: "14px",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  backgroundColor: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  fontSize: "12px",
                  color: "#334155",
                }}
              >
                <div>
                  Imported <strong>{analysisData.totalImportedCount}</strong> invoice(s) from{" "}
                  <strong>{analysisData.accountingTool}</strong> ({analysisData.cutoff12mFormatted} onwards).
                  {analysisData.alreadyOnConfirmedCount > 0 && (
                    <span style={{ color: "#64748B" }}>
                      {" "}
                      ({analysisData.alreadyOnConfirmedCount} already recorded and skipped.)
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                  {retainers.some((r) => r.detailedJobName && r.detailedJobName !== r.baseJobName) && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer", fontWeight: 600, color: "#1E293B" }}>
                      <input
                        type="checkbox"
                        checked={includeAllInvoiceDetail}
                        onChange={(e) => handleToggleAllInvoiceDetail(e.target.checked)}
                      />
                      <span>Include invoice detail in all titles</span>
                    </label>
                  )}
                  <div>
                    <strong>{selectedRetainerIds.size}</strong> of {retainers.length} suggested retainer(s) selected
                  </div>
                </div>
              </div>

              {analysisData.existingRetainers?.length > 0 && (
                <div
                  style={{
                    marginBottom: "14px",
                    padding: "12px 16px",
                    borderRadius: "10px",
                    backgroundColor: "#ECFDF5",
                    border: "1px solid #A7F3D0",
                    color: "#065F46",
                    fontSize: "12.5px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "13px" }}>
                        {retainers.length === 0
                          ? "Retainer jobs are already set up"
                          : `${analysisData.existingRetainers.length} retainer job(s) already created`}
                      </div>
                      <div style={{ marginTop: "3px", color: "#047857" }}>
                        Found <strong>{analysisData.existingRetainers.length}</strong> retainer job(s) already on the jobs board
                        {analysisData.existingRetainerInvoicesCount > 0
                          ? ` (${analysisData.existingRetainerInvoicesCount} imported invoice(s) already assigned)`
                          : ""}
                        .{" "}
                        {retainers.length === 0
                          ? "No additional recurring retainers were found — you can move on to Step 3 to review any remaining recent invoices."
                          : `${retainers.length} additional recurring retainer suggestion(s) are shown below.`}
                      </div>
                    </div>
                    {retainers.length === 0 && (
                      <button
                        type="button"
                        onClick={() => moveToRemainingStep(new Set())}
                        style={{
                          padding: "7px 14px",
                          borderRadius: "7px",
                          border: "none",
                          backgroundColor: "#047857",
                          color: "#FFFFFF",
                          fontWeight: 600,
                          fontSize: "12px",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Move to Step 3: Remaining invoices →
                      </button>
                    )}
                  </div>
                  <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {analysisData.existingRetainers.map((er, idx) => (
                      <span
                        key={`${er.client}-${er.jobName}-${idx}`}
                        style={{
                          fontSize: "11px",
                          backgroundColor: "#FFFFFF",
                          border: "1px solid #A7F3D0",
                          borderRadius: "6px",
                          padding: "3px 8px",
                          color: "#065F46",
                        }}
                      >
                        <strong>{er.client}</strong> · {er.jobName} ({formatMoney(er.monthlyFee, currency)}/mo
                        {er.assignedInvoiceRefs?.length > 0 ? ` · ${er.assignedInvoiceRefs.length} invoice(s)` : ""})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {retainers.length === 0 ? (
                <div
                  style={{
                    padding: "28px 20px",
                    textAlign: "center",
                    borderRadius: "10px",
                    border: "1px solid #E2E8F0",
                    backgroundColor: "#F8FAFC",
                    color: "#475569",
                    fontSize: "13px",
                  }}
                >
                  {analysisData.existingRetainers?.length > 0
                    ? "All detected retainers are already set up. Continue to the next step to review remaining recent invoices."
                    : "No recurring retainer patterns were detected automatically. Continue to the next step to review remaining recent invoices."}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {retainers.map((ret) => {
                    const checked = selectedRetainerIds.has(ret.id);
                    return (
                      <div
                        key={ret.id}
                        style={{
                          border: `1px solid ${checked ? "#93C5FD" : "#E2E8F0"}`,
                          borderRadius: "10px",
                          padding: "14px 16px",
                          backgroundColor: checked ? "#F8FAFF" : "#FFFFFF",
                          opacity: checked ? 1 : 0.72,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer", flex: 1 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRetainer(ret.id)}
                              style={{ marginTop: "3px" }}
                            />
                            <div>
                              <div style={{ fontSize: "14px", fontWeight: 700, color: "#0F172A" }}>
                                {ret.client}
                                <span
                                  style={{
                                    marginLeft: "8px",
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    padding: "2px 8px",
                                    borderRadius: "999px",
                                    backgroundColor: "#E0F2FE",
                                    color: "#0369A1",
                                  }}
                                >
                                  {ret.frequencyLabel}
                                </span>
                              </div>
                              <div style={{ fontSize: "12px", color: "#475569", marginTop: "4px" }}>
                                Invoice amount: <strong>{formatMoney(ret.perInvoiceAmount, currency)}</strong> (excl. VAT)
                                {ret.periodMonths > 1 && ` · Monthly equivalent: ${formatMoney(ret.monthlyFee, currency)}/mo`}
                                {ret.rateStartMonthLabel && ` · Rate started: ${ret.rateStartMonthLabel}`}
                                {` · Job start date: ${ret.startDateFormatted} · End date: No end date`}
                              </div>
                            </div>
                          </label>

                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span style={{ fontSize: "11px", color: "#64748B", fontWeight: 600 }}>Job name:</span>
                            <input
                              type="text"
                              value={ret.jobName}
                              disabled={!checked}
                              placeholder="Enter job name"
                              onChange={(e) => updateRetainerField(ret.id, "jobName", e.target.value, { isManual: true })}
                              style={{
                                padding: "5px 8px",
                                fontSize: "12px",
                                borderRadius: "6px",
                                border: "1px solid #CBD5E1",
                                minWidth: "240px",
                                fontWeight: 600,
                              }}
                            />
                          </div>
                        </div>

                        {(ret.sampleReference || ret.sampleDescription) && (
                          <div style={{ marginTop: "8px", paddingLeft: "24px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontSize: "11px" }}>
                            <span style={{ color: "#64748B", fontWeight: 600 }}>Invoice detail:</span>
                            {ret.sampleReference && (
                              <span style={{ color: "#475569", backgroundColor: "#F1F5F9", padding: "2px 7px", borderRadius: "4px" }}>
                                Ref: {ret.sampleReference}
                              </span>
                            )}
                            {ret.sampleDescription && (
                              <span style={{ color: "#475569", backgroundColor: "#F1F5F9", padding: "2px 7px", borderRadius: "4px" }}>
                                Description: {ret.sampleDescription}
                              </span>
                            )}
                            {checked && (
                              <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", marginLeft: "4px" }}>
                                {ret.jobName !== ret.baseJobName && (
                                  <button
                                    type="button"
                                    onClick={() => updateRetainerField(ret.id, "jobName", ret.baseJobName, { isManual: false })}
                                    style={{
                                      padding: "2px 7px",
                                      fontSize: "10.5px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #CBD5E1",
                                      backgroundColor: "#FFFFFF",
                                      color: "#334155",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Default: {ret.baseJobName}
                                  </button>
                                )}
                                {ret.refJobName && ret.jobName !== ret.refJobName && (
                                  <button
                                    type="button"
                                    onClick={() => updateRetainerField(ret.id, "jobName", ret.refJobName, { isManual: false })}
                                    style={{
                                      padding: "2px 7px",
                                      fontSize: "10.5px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #93C5FD",
                                      backgroundColor: "#EFF6FF",
                                      color: "#1D4ED8",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Use ref: {ret.refJobName}
                                  </button>
                                )}
                                {ret.descJobName && ret.descJobName !== ret.refJobName && ret.jobName !== ret.descJobName && (
                                  <button
                                    type="button"
                                    onClick={() => updateRetainerField(ret.id, "jobName", ret.descJobName, { isManual: false })}
                                    style={{
                                      padding: "2px 7px",
                                      fontSize: "10.5px",
                                      fontWeight: 600,
                                      borderRadius: "4px",
                                      border: "1px solid #93C5FD",
                                      backgroundColor: "#EFF6FF",
                                      color: "#1D4ED8",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Use description: {ret.descJobName}
                                  </button>
                                )}
                              </span>
                            )}
                          </div>
                        )}

                        <div style={{ marginTop: "8px", paddingLeft: "24px", fontSize: "11px", color: "#64748B" }}>
                          Matched {ret.matchedCount} historical invoice(s):{" "}
                          {ret.matchedInvoices.map((inv) => `${inv.invoiceNo} (${inv.sendDateFormatted})`).join(", ")}.{" "}
                          <strong>{ret.relevantInvoices.length}</strong> invoice(s) from {analysisData.cutoff3mFormatted} onwards will be assigned to child items.
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {step === "remaining" && analysisData && (
            <div>
              {retainersSummary && retainersSummary.createdCount > 0 && (
                <div
                  style={{
                    marginBottom: "12px",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    backgroundColor: "#ECFDF5",
                    border: "1px solid #A7F3D0",
                    color: "#065F46",
                    fontSize: "12px",
                    fontWeight: 500,
                  }}
                >
                  Created <strong>{retainersSummary.createdCount}</strong> retainer job(s) with{" "}
                  <strong>{retainersSummary.assignedInvoiceCount}</strong> assigned invoice(s).
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "10px",
                  fontSize: "12px",
                  color: "#334155",
                }}
              >
                <div>
                  Showing remaining unrecorded invoices dated on or after <strong>{analysisData.cutoff3mFormatted}</strong> (
                  <strong>{remainingInvoices.length}</strong> to review). A project job will be created for each selected invoice.
                  {(analysisData.recentAlreadyRecordedRetainerCount > 0 || analysisData.recentAlreadyRecordedProjectCount > 0) && (
                    <span style={{ color: "#64748B" }}>
                      {" "}
                      (Skipped{" "}
                      {analysisData.recentAlreadyRecordedRetainerCount + analysisData.recentAlreadyRecordedProjectCount}{" "}
                      recent invoice(s) already set up:{" "}
                      {analysisData.recentAlreadyRecordedRetainerCount} on retainers,{" "}
                      {analysisData.recentAlreadyRecordedProjectCount} on project jobs.)
                    </span>
                  )}
                </div>
                <div>
                  <strong>{selectedRemainingIds.size}</strong> selected
                </div>
              </div>

              {remainingInvoices.length === 0 ? (
                <div
                  style={{
                    padding: "32px 20px",
                    textAlign: "center",
                    borderRadius: "10px",
                    border: "1px solid #E2E8F0",
                    backgroundColor: "#F8FAFC",
                    color: "#475569",
                    fontSize: "13px",
                  }}
                >
                  {analysisData.recentAlreadyRecordedRetainerCount + analysisData.recentAlreadyRecordedProjectCount > 0
                    ? `All recent invoices from ${analysisData.cutoff3mFormatted} onwards have already been converted to jobs (${analysisData.recentAlreadyRecordedRetainerCount} retainer invoice(s), ${analysisData.recentAlreadyRecordedProjectCount} project invoice(s)). Click Finish setup to complete this step.`
                    : `No remaining invoices found from ${analysisData.cutoff3mFormatted} onwards. Click Finish setup to complete this step.`}
                </div>
              ) : (
                <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: "10px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ backgroundColor: "#F1F5F9", borderBottom: "1px solid #CBD5E1" }}>
                        <th style={{ padding: "8px 10px", textAlign: "center", width: "36px" }}>
                          <input
                            type="checkbox"
                            checked={allRemainingChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRemainingIds(new Set(remainingInvoices.map((i) => i.id)));
                              } else {
                                setSelectedRemainingIds(new Set());
                              }
                            }}
                            aria-label="Select all remaining invoices"
                          />
                        </th>
                        <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, color: "#334155", width: "165px", maxWidth: "175px" }}>Client</th>
                        <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, color: "#334155", minWidth: "280px" }}>Job name</th>
                        <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 700, color: "#334155", width: "136px", whiteSpace: "nowrap" }}>Start date</th>
                        <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 700, color: "#334155", width: "136px", whiteSpace: "nowrap" }}>End date</th>
                        <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 700, color: "#334155", whiteSpace: "nowrap" }}>Invoice ref</th>
                        <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 700, color: "#334155", whiteSpace: "nowrap" }}>Send date</th>
                        <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#334155", whiteSpace: "nowrap" }}>Amount (excl. VAT)</th>
                        <th style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700, color: "#334155", width: "76px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {remainingInvoices.map((inv) => {
                        const checked = selectedRemainingIds.has(inv.id);
                        const defaults = getDefaultProjectDateRangeIso(inv.sendDateIso);
                        const jobVal = jobNameOverrides[inv.id] ?? inv.description ?? `Invoice ${inv.invoiceNo}`;
                        const startVal = startDateOverrides[inv.id] ?? defaults.startDateIso;
                        const endVal = endDateOverrides[inv.id] ?? defaults.endDateIso;
                        return (
                          <tr
                            key={inv.id}
                            style={{
                              borderBottom: "1px solid #F1F5F9",
                              backgroundColor: checked ? "#FFFFFF" : "#F8FAFC",
                              opacity: checked ? 1 : 0.65,
                            }}
                          >
                            <td style={{ padding: "7px 10px", textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRemaining(inv.id)}
                                aria-label={`Select invoice ${inv.invoiceNo}`}
                              />
                            </td>
                            <td style={{ padding: "7px 10px", fontWeight: 600, color: "#0F172A", width: "165px", maxWidth: "175px", wordBreak: "break-word" }}>{inv.client}</td>
                            <td style={{ padding: "7px 10px" }}>
                              <input
                                type="text"
                                value={jobVal}
                                disabled={!checked}
                                onChange={(e) =>
                                  setJobNameOverrides((prev) => ({ ...prev, [inv.id]: e.target.value }))
                                }
                                style={{
                                  width: "100%",
                                  minWidth: "260px",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                }}
                              />
                            </td>
                            <td style={{ padding: "7px 8px" }}>
                              <input
                                type="date"
                                value={startVal}
                                disabled={!checked}
                                onChange={(e) =>
                                  setStartDateOverrides((prev) => ({ ...prev, [inv.id]: e.target.value }))
                                }
                                aria-label={`Job start date for invoice ${inv.invoiceNo}`}
                                style={{
                                  width: "130px",
                                  padding: "4px 6px",
                                  fontSize: "11.5px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  backgroundColor: checked ? "#FFFFFF" : "#F1F5F9",
                                }}
                              />
                            </td>
                            <td style={{ padding: "7px 8px" }}>
                              <input
                                type="date"
                                value={endVal}
                                disabled={!checked}
                                onChange={(e) =>
                                  setEndDateOverrides((prev) => ({ ...prev, [inv.id]: e.target.value }))
                                }
                                aria-label={`Job end date for invoice ${inv.invoiceNo}`}
                                style={{
                                  width: "130px",
                                  padding: "4px 6px",
                                  fontSize: "11.5px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  backgroundColor: checked ? "#FFFFFF" : "#F1F5F9",
                                }}
                              />
                            </td>
                            <td style={{ padding: "7px 8px", color: "#475569", whiteSpace: "nowrap" }}>{inv.invoiceNo}</td>
                            <td style={{ padding: "7px 8px", color: "#475569", whiteSpace: "nowrap" }}>
                              {inv.sendDateFormatted}
                            </td>
                            <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600, color: "#0F172A", whiteSpace: "nowrap" }}>
                              {formatMoney(inv.subTotal, currency)}
                            </td>
                            <td style={{ padding: "7px 8px", textAlign: "center" }}>
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  padding: "2px 8px",
                                  borderRadius: "999px",
                                  backgroundColor: inv.status === "Paid" ? "#DCFCE7" : "#FEF3C7",
                                  color: inv.status === "Paid" ? "#15803D" : "#B45309",
                                }}
                              >
                                {inv.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {step === "done" && finalSummary && (
            <div
              style={{
                textAlign: "center",
                padding: "40px 20px",
                borderRadius: "12px",
                backgroundColor: "#ECFDF5",
                border: "1px solid #A7F3D0",
              }}
            >
              <div style={{ fontSize: "17px", fontWeight: 700, color: "#065F46", marginBottom: "8px" }}>
                Initial invoice setup complete
              </div>
              <p style={{ fontSize: "13px", color: "#047857", margin: "0 auto", maxWidth: "520px", lineHeight: 1.6 }}>
                Created <strong>{finalSummary.retainersCreated}</strong> retainer job(s) with{" "}
                <strong>{finalSummary.retainerInvoicesAssigned}</strong> invoice(s) assigned, and{" "}
                <strong>{finalSummary.projectsCreated}</strong> project job(s) from remaining recent invoices.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid #E2E8F0",
            backgroundColor: "#F8FAFC",
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: "8px",
              border: "1px solid #CBD5E1",
              backgroundColor: "#FFFFFF",
              color: "#334155",
              fontWeight: 600,
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>

          {step === "retainers" && (
            <button
              type="button"
              onClick={handleConfirmRetainers}
              disabled={submitting}
              style={{
                padding: "8px 18px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#2563EB",
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: "13px",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting
                ? "Creating retainers..."
                : selectedRetainerIds.size > 0
                  ? `Confirm ${selectedRetainerIds.size} retainer(s) & continue`
                  : retainers.length === 0
                    ? "Continue to Step 3"
                    : "Skip retainers & continue"}
            </button>
          )}

          {step === "remaining" && (
            <button
              type="button"
              onClick={handleConfirmRemaining}
              disabled={submitting}
              style={{
                padding: "8px 18px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#2563EB",
                color: "#FFFFFF",
                fontWeight: 600,
                fontSize: "13px",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting
                ? "Creating jobs..."
                : selectedRemainingIds.size > 0
                  ? `Create ${selectedRemainingIds.size} project job(s) & finish`
                  : "Finish setup"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
