import React, { useState, useMemo } from "react";
import Spinner from "./Spinner";

export default function JobsNewJobModal({
  jobsClient,
  initialTab = "Confirmed",
  productLines = [],
  leadSources = [],
  existingClients = [],
  onClose,
  onSuccess
}) {
  // Format today's date as YYYY-MM-DD for native HTML date inputs
  const todayISO = useMemo(() => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }, []);

  const [client, setClient] = useState("");
  const [jobName, setJobName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [projectRetainer, setProjectRetainer] = useState("Project");
  const [status, setStatus] = useState(initialTab === "Pipeline" ? "Pipeline" : "Confirmed");
  const [likelihood, setLikelihood] = useState(initialTab === "Pipeline" ? "50" : "100");
  const [revenue, setRevenue] = useState("");
  const [directCosts, setDirectCosts] = useState("0");
  const [vat, setVat] = useState("Yes");
  const [dateConfirmed, setDateConfirmed] = useState(todayISO);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [productLine, setProductLine] = useState("");
  const [leadSource, setLeadSource] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleStatusChange = (newStatus) => {
    setStatus(newStatus);
    if (newStatus === "Confirmed") {
      setLikelihood("100");
    } else {
      if (likelihood === "100" || !likelihood) {
        setLikelihood("50");
      }
    }
  };

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setError("");

    if (!client.trim()) {
      setError("Please enter a Client Name.");
      return;
    }
    if (!jobName.trim()) {
      setError("Please enter a Job Name.");
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setError("End Date cannot be before Start Date.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_new_job",
          clientSheetId: jobsClient?.clientSheetId,
          clientName: jobsClient?.clientName || jobsClient?.name || "",
          tabName: status,
          jobData: {
            client: client.trim(),
            jobName: jobName.trim(),
            projectCode: projectCode.trim(),
            projectRetainer,
            status,
            likelihood: status === "Pipeline" ? likelihood : "",
            revenue: revenue === "" ? 0 : parseFloat(revenue) || 0,
            directCosts: directCosts === "" ? 0 : parseFloat(directCosts) || 0,
            vat,
            dateConfirmed,
            dateAdded: dateConfirmed,
            startDate,
            endDate,
            productLine,
            leadSource
          }
        })
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to create job.");
        setSaving(false);
        return;
      }

      onSuccess(data.targetTab || status);
    } catch (err) {
      console.error("Error creating new job:", err);
      setError(err.message || "Network error while creating job.");
      setSaving(false);
    }
  };

  const inputStyle = {
    width: "100%",
    padding: "8px 11px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    fontSize: "13px",
    color: "#1e293b",
    backgroundColor: "#ffffff",
    boxSizing: "border-box",
    transition: "border-color 0.15s ease, box-shadow 0.15s ease",
    outline: "none"
  };

  const labelStyle = {
    display: "block",
    fontSize: "11px",
    fontWeight: "600",
    color: "#475569",
    marginBottom: "4px",
    textTransform: "uppercase",
    letterSpacing: "0.4px"
  };

  const sectionStyle = {
    background: "#f8fafc",
    padding: "14px",
    borderRadius: "8px",
    border: "1px solid #e2e8f0"
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(3px)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "14px",
          width: "min(94vw, 680px)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.05)",
          overflow: "hidden"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#ffffff"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "24px",
                  height: "24px",
                  borderRadius: "6px",
                  background: "#e0f2fe",
                  color: "#0284c7",
                  fontSize: "15px",
                  fontWeight: "700"
                }}
              >
                +
              </span>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a" }}>
                Add New Job
              </h2>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
              {jobsClient?.clientName ? `${jobsClient.clientName} · ` : ""}<strong style={{ color: status === "Confirmed" ? "#0369a1" : "#b45309" }}>{status}</strong>
            </div>
          </div>
          <button
            onClick={() => { if (!saving) onClose(); }}
            disabled={saving}
            style={{
              background: "none",
              border: "none",
              fontSize: "22px",
              cursor: saving ? "not-allowed" : "pointer",
              color: "#94a3b8",
              padding: "4px 8px",
              borderRadius: "4px",
              lineHeight: 1
            }}
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto" }}>
          <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: "16px" }}>
            {error && (
              <div
                style={{
                  backgroundColor: "#fef2f2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px"
                }}
              >
                <span style={{ fontWeight: "700" }}>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Row 1: Client Name (35%) & Job Name (65%) */}
            <div style={sectionStyle}>
              <div style={{ display: "grid", gridTemplateColumns: "35% 65%", gap: "12px" }}>
                <div>
                  <label style={labelStyle}>
                    Client Name <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="text"
                    list="new-job-client-suggestions"
                    style={inputStyle}
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                    placeholder="e.g. Acme Corp"
                    autoFocus
                    required
                  />
                  <datalist id="new-job-client-suggestions">
                    {(existingClients || []).map((cName) => (
                      <option key={cName} value={cName} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label style={labelStyle}>
                    Job Name <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <input
                    type="text"
                    style={inputStyle}
                    value={jobName}
                    onChange={(e) => setJobName(e.target.value)}
                    placeholder="e.g. Brand Identity Overhaul"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Row 2: Type | Status | % likelihood | Project Code */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              <div>
                <label style={labelStyle}>
                  Type <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={inputStyle}
                  value={projectRetainer}
                  onChange={(e) => setProjectRetainer(e.target.value)}
                >
                  <option value="Project">Project</option>
                  <option value="Retainer">Retainer</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  Status <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={{
                    ...inputStyle,
                    fontWeight: "600",
                    color: status === "Confirmed" ? "#0369a1" : "#b45309"
                  }}
                  value={status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                >
                  <option value="Confirmed">Confirmed</option>
                  <option value="Pipeline">Pipeline</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>% Likelihood</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  style={{
                    ...inputStyle,
                    backgroundColor: status === "Confirmed" ? "#f1f5f9" : "#ffffff",
                    cursor: status === "Confirmed" ? "not-allowed" : "text",
                    opacity: status === "Confirmed" ? 0.75 : 1
                  }}
                  value={status === "Confirmed" ? 100 : likelihood}
                  disabled={status === "Confirmed"}
                  onChange={(e) => setLikelihood(e.target.value)}
                  placeholder="e.g. 50"
                />
              </div>

              <div>
                <label style={labelStyle}>Project Code</label>
                <input
                  type="text"
                  style={inputStyle}
                  value={projectCode}
                  onChange={(e) => setProjectCode(e.target.value)}
                  placeholder="e.g. PRJ-102"
                />
              </div>
            </div>

            {/* Row 3: Revenue | Direct Costs | VAT? | Date Confirmed / Added */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 2fr", gap: "12px" }}>
              <div>
                <label style={labelStyle}>
                  Revenue (excl. VAT) <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={revenue}
                  onChange={(e) => setRevenue(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </div>

              <div>
                <label style={labelStyle}>Direct Costs (excl. VAT)</label>
                <input
                  type="number"
                  step="0.01"
                  style={inputStyle}
                  value={directCosts}
                  onChange={(e) => setDirectCosts(e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <div>
                <label style={labelStyle}>
                  VAT? <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <select
                  style={inputStyle}
                  value={vat}
                  onChange={(e) => setVat(e.target.value)}
                >
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  {status === "Confirmed" ? "Date Confirmed" : "Date Added"}
                </label>
                <input
                  type="date"
                  style={inputStyle}
                  value={dateConfirmed}
                  onChange={(e) => setDateConfirmed(e.target.value)}
                />
              </div>
            </div>

            {/* Row 4: Start Date | End Date | Product Line | Lead Source */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Start Date</label>
                <input
                  type="date"
                  style={inputStyle}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div>
                <label style={labelStyle}>End Date</label>
                <input
                  type="date"
                  style={inputStyle}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>

              <div>
                <label style={labelStyle}>Product Line</label>
                <select
                  style={inputStyle}
                  value={productLine}
                  onChange={(e) => setProductLine(e.target.value)}
                >
                  <option value="">Select...</option>
                  {(productLines || []).map((pl) => (
                    <option key={pl} value={pl}>
                      {pl}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}>Lead Source</label>
                <select
                  style={inputStyle}
                  value={leadSource}
                  onChange={(e) => setLeadSource(e.target.value)}
                >
                  <option value="">Select...</option>
                  {(leadSources || []).map((ls) => (
                    <option key={ls} value={ls}>
                      {ls}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Information Banner */}
            <div
              style={{
                fontSize: "11px",
                color: "#64748b",
                backgroundColor: "#f8fafc",
                border: "1px dashed #cbd5e1",
                padding: "8px 12px",
                borderRadius: "6px",
                display: "flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              <span>ℹ️</span>
              <span>
                Invoices, direct expenses, and other details can be added after saving.
              </span>
            </div>
          </div>

          {/* Modal Footer */}
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid #e2e8f0",
              backgroundColor: "#f8fafc",
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: "10px"
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: "500",
                color: "#475569",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: saving ? "not-allowed" : "pointer"
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "8px 22px",
                fontSize: "13px",
                fontWeight: "600",
                color: "#ffffff",
                backgroundColor: saving ? "#60a5fa" : "#0066cc",
                border: "none",
                borderRadius: "6px",
                cursor: saving ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "0 1px 2px rgba(0, 102, 204, 0.2)"
              }}
            >
              {saving ? (
                <>
                  <Spinner size={14} color="#ffffff" />
                  <span>Adding Job...</span>
                </>
              ) : (
                <span>Save Job</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
