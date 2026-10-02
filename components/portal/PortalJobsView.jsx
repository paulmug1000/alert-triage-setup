import React, { useState, useMemo } from "react";
import Spinner from "../Spinner";

export default function PortalJobsView({
  clientName,
  clientSheetId,
  data,
  isLoading,
  error,
  onRefresh,
}) {
  const [filterType, setFilterType] = useState("all"); // 'all' | 'confirmed' | 'pipeline' | 'project' | 'retainer'
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("startDateDesc"); // 'startDateDesc' | 'revDesc' | 'revAsc' | 'clientAsc'
  const [currentPage, setCurrentPage] = useState(1);
  const [editingJob, setEditingJob] = useState(null); // null or job object
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const pageSize = 25;

  const jobsData = data?.jobs;

  const productLineOptions = useMemo(() => {
    const fromApi = data?.formOptions?.productLines || [];
    if (fromApi.length > 0) return fromApi;
    const set = new Set();
    (jobsData?.all || []).forEach((j) => { if (j.productLine) set.add(j.productLine); });
    return Array.from(set);
  }, [data?.formOptions?.productLines, jobsData?.all]);

  const leadSourceOptions = useMemo(() => {
    const fromApi = data?.formOptions?.leadSources || [];
    if (fromApi.length > 0) return fromApi;
    const set = new Set();
    (jobsData?.all || []).forEach((j) => { if (j.leadSource) set.add(j.leadSource); });
    return Array.from(set);
  }, [data?.formOptions?.leadSources, jobsData?.all]);

  const filteredJobs = useMemo(() => {
    if (!jobsData?.all) return [];
    let list = [...jobsData.all];

    // Filter by type
    if (filterType === "confirmed") {
      list = list.filter((j) => j.type === "Confirmed");
    } else if (filterType === "pipeline") {
      list = list.filter((j) => j.type === "Pipeline");
    } else if (filterType === "project") {
      list = list.filter((j) => String(j.projectRetainer || "").toLowerCase().includes("project"));
    } else if (filterType === "retainer") {
      list = list.filter((j) => String(j.projectRetainer || "").toLowerCase().includes("retainer"));
    }

    // Filter by search
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim();
      list = list.filter(
        (j) =>
          (j.client || "").toLowerCase().includes(q) ||
          (j.jobName || "").toLowerCase().includes(q) ||
          (j.productLine && j.productLine.toLowerCase().includes(q))
      );
    }

    // Sort
    list.sort((a, b) => {
      if (sortBy === "revDesc") return (b.revNum || 0) - (a.revNum || 0);
      if (sortBy === "revAsc") return (a.revNum || 0) - (b.revNum || 0);
      if (sortBy === "clientAsc") return (a.client || "").localeCompare(b.client || "");
      const dateA = a.startDate ? new Date(a.startDate).getTime() : 0;
      const dateB = b.startDate ? new Date(b.startDate).getTime() : 0;
      return dateB - dateA;
    });

    return list;
  }, [jobsData, filterType, searchTerm, sortBy]);

  const totalPages = Math.ceil(filteredJobs.length / pageSize) || 1;
  const paginatedJobs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredJobs.slice(start, start + pageSize);
  }, [filteredJobs, currentPage, pageSize]);

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "") return "£0";
    if (typeof val === "number") {
      return (val < 0 ? "-" : "") + "£" + Math.abs(Math.round(val)).toLocaleString("en-GB");
    }
    const n = parseFloat(String(val).replace(/[£,]/g, ""));
    return isNaN(n) ? String(val) : (n < 0 ? "-" : "") + "£" + Math.abs(Math.round(n)).toLocaleString("en-GB");
  };

  const handleOpenAddJob = () => {
    setSaveError(null);
    setEditingJob({
      id: "new",
      rowNumber: null,
      type: "Pipeline",
      client: "",
      jobName: "",
      projectRetainer: "Project",
      likelihood: "50%",
      revenue: "£0",
      directCosts: "£0",
      startDate: new Date().toISOString().split("T")[0],
      endDate: "",
      productLine: "",
      leadSource: "",
      vat: "Yes",
      projectCode: "",
      dateConfirmed: "",
      invoices: [{ num: 1, amount: "", ref: "", sendDate: "", days: "30", status: "Draft" }],
      directExpenses: [{ num: 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "Received" }],
    });
  };

  const handleOpenEditJob = (job, e) => {
    if (e) e.stopPropagation();
    setSaveError(null);
    setEditingJob({
      ...job,
      invoices: Array.isArray(job.invoices) && job.invoices.length > 0
        ? job.invoices.map((inv, i) => ({ ...inv, num: i + 1 }))
        : [{ num: 1, amount: "", ref: "", sendDate: "", days: "30", status: "Draft" }],
      directExpenses: Array.isArray(job.directExpenses) && job.directExpenses.length > 0
        ? job.directExpenses.map((exp, i) => ({ ...exp, num: i + 1 }))
        : [{ num: 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "Received" }],
    });
  };

  const addInvoice = () => {
    setEditingJob((prev) => ({
      ...prev,
      invoices: [
        ...(prev.invoices || []),
        { num: (prev.invoices?.length || 0) + 1, amount: "", ref: "", sendDate: "", days: "30", status: "Draft" },
      ],
    }));
  };

  const removeInvoice = (idx) => {
    setEditingJob((prev) => ({
      ...prev,
      invoices: prev.invoices.filter((_, i) => i !== idx),
    }));
  };

  const updateInvoice = (idx, field, val) => {
    setEditingJob((prev) => {
      const invs = [...(prev.invoices || [])];
      invs[idx] = { ...invs[idx], [field]: val };
      return { ...prev, invoices: invs };
    });
  };

  const addExpense = () => {
    setEditingJob((prev) => ({
      ...prev,
      directExpenses: [
        ...(prev.directExpenses || []),
        { num: (prev.directExpenses?.length || 0) + 1, desc: "", amount: "", vat: "Yes", recDate: "", days: "30", status: "Received" },
      ],
    }));
  };

  const removeExpense = (idx) => {
    setEditingJob((prev) => ({
      ...prev,
      directExpenses: prev.directExpenses.filter((_, i) => i !== idx),
    }));
  };

  const updateExpense = (idx, field, val) => {
    setEditingJob((prev) => {
      const exps = [...(prev.directExpenses || [])];
      exps[idx] = { ...exps[idx], [field]: val };
      return { ...prev, directExpenses: exps };
    });
  };

  const handleSaveJob = async (e) => {
    e.preventDefault();
    if (!editingJob.client?.trim() || !editingJob.jobName?.trim()) {
      setSaveError("Client name and Job name are required.");
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const res = await fetch("/api/portal/save-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSheetId,
          clientName,
          job: editingJob,
        }),
      });

      const resData = await res.json();
      if (!resData.success) {
        throw new Error(resData.error || "Failed to save job");
      }

      setEditingJob(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Save job error:", err);
      setSaveError(err.message || "An error occurred while saving.");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !jobsData) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 0" }}>
        <Spinner size={36} color="#0047AB" />
        <p style={{ marginTop: "1rem", color: "#64748b", fontWeight: 500 }}>
          Loading Jobs for {clientName}...
        </p>
      </div>
    );
  }

  if (error && !jobsData) {
    return (
      <div
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          padding: "1.5rem",
          color: "#991b1b",
          margin: "1rem 0",
        }}
      >
        <h4 style={{ margin: "0 0 6px 0", fontWeight: 700 }}>Unable to load jobs data</h4>
        <p style={{ margin: "0 0 12px 0", fontSize: "14px" }}>{error}</p>
        <button
          onClick={onRefresh}
          style={{
            padding: "6px 14px",
            background: "#dc2626",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%", fontFamily: "'Kumbh Sans', sans-serif" }}>
      {/* Action Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          padding: "0.25rem 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", fontWeight: 700, color: "#0047AB" }}>
            Jobs
          </h2>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "10px",
              fontSize: "11px",
              fontWeight: 700,
              background: "rgba(0, 71, 171, 0.08)",
              color: "#0047AB",
            }}
          >
            {filteredJobs.length} active
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleOpenAddJob}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "#0047AB",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              padding: "6px 14px",
              fontSize: "12.5px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <span>+</span>
            <span>Add Job</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh data"
            style={{
              background: "transparent",
              border: "none",
              cursor: isLoading ? "wait" : "pointer",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            {isLoading ? (
              <Spinner size={18} color="#0047AB" />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          background: "#ffffff",
          padding: "0.75rem 1rem",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
        }}
      >
        {/* Type Filter Buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {[
            { id: "all", label: `All (${jobsData?.all?.length || 0})` },
            { id: "confirmed", label: `Confirmed (${jobsData?.confirmedCount || 0})` },
            { id: "pipeline", label: `Pipeline (${jobsData?.pipelineCount || 0})` },
            { id: "project", label: "Projects" },
            { id: "retainer", label: "Retainers" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setFilterType(tab.id);
                setCurrentPage(1);
              }}
              style={{
                padding: "3px 10px",
                borderRadius: "14px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                border: filterType === tab.id ? "1px solid #0047AB" : "1px solid #e2e8f0",
                background: filterType === tab.id ? "#0047AB" : "#f8fafc",
                color: filterType === tab.id ? "#ffffff" : "#475569",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Sort */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="text"
            placeholder="Search jobs or clients..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              width: "180px",
            }}
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              background: "#ffffff",
              color: "#334155",
              cursor: "pointer",
            }}
          >
            <option value="startDateDesc">Start Date (Latest)</option>
            <option value="revDesc">Revenue (High to Low)</option>
            <option value="revAsc">Revenue (Low to High)</option>
            <option value="clientAsc">Client (A-Z)</option>
          </select>
        </div>
      </div>

      {/* Main Jobs Table (Fitting desktop width) */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          width: "100%",
        }}
      >
        <div style={{ overflowX: "auto", width: "100%" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: "12px",
              tableLayout: "fixed",
            }}
          >
            <thead>
              <tr style={{ background: "#0047AB", color: "#ffffff" }}>
                <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, width: "10%" }}>
                  Status
                </th>
                <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, width: "32%" }}>
                  Client & Job Name
                </th>
                <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, width: "10%" }}>
                  Type
                </th>
                <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, width: "12%" }}>
                  Revenue
                </th>
                <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, width: "12%" }}>
                  Direct Costs
                </th>
                <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, width: "9%" }}>
                  Likelihood
                </th>
                <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, width: "9%" }}>
                  Timeline
                </th>
                <th style={{ padding: "8px 10px", textAlign: "center", fontWeight: 700, width: "6%" }}>
                  Action
                </th>
              </tr>
            </thead>

            <tbody>
              {paginatedJobs.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
                    No jobs match your search/filter criteria.
                  </td>
                </tr>
              ) : (
                paginatedJobs.map((job, idx) => {
                  const isConfirmed = job.type === "Confirmed";

                  return (
                    <tr
                      key={job.id || idx}
                      onClick={(e) => handleOpenEditJob(job, e)}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        cursor: "pointer",
                        background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "rgba(0, 71, 171, 0.04)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = idx % 2 === 0 ? "#ffffff" : "#fbfcfe";
                      }}
                    >
                      {/* Status */}
                      <td style={{ padding: "8px 10px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "10px",
                            fontWeight: 700,
                            background: isConfirmed ? "#dcfce7" : "#e0f2fe",
                            color: isConfirmed ? "#166534" : "#0369a1",
                          }}
                        >
                          {job.type}
                        </span>
                      </td>

                      {/* Client & Job Name */}
                      <td style={{ padding: "8px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>{job.client}</div>
                        <div style={{ color: "#64748b", fontSize: "11px" }}>
                          {job.jobName}
                          {job.productLine ? ` • ${job.productLine}` : ""}
                        </div>
                      </td>

                      {/* Project / Retainer */}
                      <td style={{ padding: "8px 10px", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "1px 6px",
                            borderRadius: "4px",
                            fontSize: "10.5px",
                            fontWeight: 600,
                            background: "#f1f5f9",
                            color: "#475569",
                          }}
                        >
                          {job.projectRetainer || "Project"}
                        </span>
                      </td>

                      {/* Revenue */}
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#0047AB" }}>
                        {formatGBP(job.revenue)}
                      </td>

                      {/* Direct Costs */}
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "#64748b" }}>
                        {formatGBP(job.directCosts)}
                      </td>

                      {/* Likelihood */}
                      <td style={{ padding: "8px 10px", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "1px 6px",
                            borderRadius: "10px",
                            fontSize: "10.5px",
                            fontWeight: 700,
                            background: isConfirmed ? "#f0fdf4" : "#fef3c7",
                            color: isConfirmed ? "#166534" : "#b45309",
                          }}
                        >
                          {job.likelihood || (isConfirmed ? "100%" : "50%")}
                        </span>
                      </td>

                      {/* Timeline */}
                      <td style={{ padding: "8px 10px", textAlign: "center", color: "#64748b", fontSize: "11px" }}>
                        {job.startDate || "—"}
                      </td>

                      {/* Edit Button */}
                      <td style={{ padding: "8px 10px", textAlign: "center" }}>
                        <button
                          type="button"
                          onClick={(e) => handleOpenEditJob(job, e)}
                          title="Edit job"
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: "4px",
                            color: "#0047AB",
                            borderRadius: "4px",
                          }}
                        >
                          ✏️
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {totalPages > 1 && (
          <div
            style={{
              padding: "0.5rem 1rem",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "12px",
            }}
          >
            <span style={{ color: "#64748b" }}>
              Page {currentPage} of {totalPages} ({filteredJobs.length} jobs)
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={pageBtnStyle}
              >
                ◀ Prev
              </button>
              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                style={pageBtnStyle}
              >
                Next ▶
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Job Edit / Add Modal */}
      {editingJob && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1rem",
          }}
          onClick={() => !isSaving && setEditingJob(null)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              maxWidth: "860px",
              width: "100%",
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "1.75rem",
              fontFamily: "'Kumbh Sans', sans-serif",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid #e2e8f0",
                paddingBottom: "0.75rem",
                marginBottom: "1rem",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#0047AB" }}>
                {editingJob.rowNumber ? "Edit Job" : "Add New Job"}
              </h3>
              <button
                type="button"
                onClick={() => setEditingJob(null)}
                disabled={isSaving}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "18px",
                  cursor: "pointer",
                  color: "#64748b",
                }}
              >
                ✕
              </button>
            </div>

            {saveError && (
              <div
                style={{
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "6px",
                  padding: "0.6rem 0.85rem",
                  color: "#991b1b",
                  fontSize: "12px",
                  marginBottom: "1rem",
                }}
              >
                {saveError}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSaveJob} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {/* Row 1: Client Name (25%) | Job Name (75%) */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 3fr", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Client Name *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.client || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, client: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Job Name *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.jobName || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, jobName: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 2: Type | Status | % Likelihood | Project Code */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Type *</label>
                  <select
                    value={editingJob.projectRetainer || "Project"}
                    onChange={(e) => setEditingJob({ ...editingJob, projectRetainer: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="Project">Project</option>
                    <option value="Retainer">Retainer</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>Status *</label>
                  <select
                    value={editingJob.type || "Confirmed"}
                    onChange={(e) => setEditingJob({ ...editingJob, type: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="Confirmed">Confirmed</option>
                    <option value="Pipeline">Pipeline</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>% Likelihood</label>
                  <input
                    type="text"
                    value={editingJob.likelihood || (editingJob.type === "Confirmed" ? "100%" : "50%")}
                    disabled={editingJob.type === "Confirmed"}
                    onChange={(e) => setEditingJob({ ...editingJob, likelihood: e.target.value })}
                    style={{
                      ...formInputStyle,
                      opacity: editingJob.type === "Confirmed" ? 0.6 : 1,
                    }}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Project Code</label>
                  <input
                    type="text"
                    value={editingJob.projectCode || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, projectCode: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 3: Revenue | Direct Costs | VAT | Date Confirmed */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 2fr", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Revenue (excl. VAT) *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.revenue || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, revenue: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Direct Costs (excl. VAT) *</label>
                  <input
                    type="text"
                    required
                    value={editingJob.directCosts || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, directCosts: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>VAT? *</label>
                  <select
                    value={editingJob.vat || "Yes"}
                    onChange={(e) => setEditingJob({ ...editingJob, vat: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>
                    {editingJob.type === "Pipeline" ? "Date Added" : "Date Confirmed"}
                  </label>
                  <input
                    type="date"
                    value={editingJob.dateConfirmed || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, dateConfirmed: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
              </div>

              {/* Row 4: Start Date | End Date | Product Line | Lead Source */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
                <div>
                  <label style={formLabelStyle}>Start Date *</label>
                  <input
                    type="date"
                    required
                    value={editingJob.startDate || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, startDate: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>End Date *</label>
                  <input
                    type="date"
                    required
                    value={editingJob.endDate || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, endDate: e.target.value })}
                    style={formInputStyle}
                  />
                </div>
                <div>
                  <label style={formLabelStyle}>Product Line</label>
                  <select
                    value={editingJob.productLine || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, productLine: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="">Select...</option>
                    {productLineOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={formLabelStyle}>Lead Source</label>
                  <select
                    value={editingJob.leadSource || ""}
                    onChange={(e) => setEditingJob({ ...editingJob, leadSource: e.target.value })}
                    style={formInputStyle}
                  >
                    <option value="">Select...</option>
                    {leadSourceOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Invoices Section */}
              <div
                style={{
                  marginTop: "0.5rem",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.6rem",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB" }}>
                    Invoices
                  </h4>
                  <button
                    type="button"
                    onClick={addInvoice}
                    style={{
                      background: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      color: "#166534",
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "3px 10px",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    + Add Invoice
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(editingJob.invoices || []).map((inv, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1.2fr 1fr 1.2fr 0.7fr 1fr 28px",
                        gap: "6px",
                        alignItems: "center",
                        background: "#f8fafc",
                        padding: "6px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>
                          Amount ({idx + 1})
                        </label>
                        <input
                          type="text"
                          placeholder="Amount"
                          value={inv.amount || ""}
                          onChange={(e) => updateInvoice(idx, "amount", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Ref</label>
                        <input
                          type="text"
                          placeholder="Ref"
                          value={inv.ref || ""}
                          onChange={(e) => updateInvoice(idx, "ref", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Send Date</label>
                        <input
                          type="date"
                          value={inv.sendDate || ""}
                          onChange={(e) => updateInvoice(idx, "sendDate", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                        <input
                          type="number"
                          placeholder="30"
                          value={inv.days || ""}
                          onChange={(e) => updateInvoice(idx, "days", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                        <select
                          value={inv.status || "Draft"}
                          onChange={(e) => updateInvoice(idx, "status", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="Draft">Draft</option>
                          <option value="Invoiced">Invoiced</option>
                          <option value="Paid">Paid</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      </div>
                      <div style={{ paddingTop: "14px", textAlign: "center" }}>
                        <button
                          type="button"
                          onClick={() => removeInvoice(idx)}
                          title="Delete invoice"
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#ef4444",
                            cursor: "pointer",
                            fontSize: "14px",
                            padding: "2px",
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Direct Expenses Section */}
              <div
                style={{
                  marginTop: "0.25rem",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.6rem",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#0047AB" }}>
                    Direct Expenses
                  </h4>
                  <button
                    type="button"
                    onClick={addExpense}
                    style={{
                      background: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      color: "#166534",
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "3px 10px",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    + Add Direct Expense
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {(editingJob.directExpenses || []).map((exp, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1.2fr 1fr 0.7fr 1.2fr 0.6fr 1fr 28px",
                        gap: "6px",
                        alignItems: "center",
                        background: "#f8fafc",
                        padding: "6px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>
                          Description ({idx + 1})
                        </label>
                        <input
                          type="text"
                          placeholder="Description"
                          value={exp.desc || ""}
                          onChange={(e) => updateExpense(idx, "desc", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Amount</label>
                        <input
                          type="text"
                          placeholder="Amount"
                          value={exp.amount || ""}
                          onChange={(e) => updateExpense(idx, "amount", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>VAT?</label>
                        <select
                          value={exp.vat || "Yes"}
                          onChange={(e) => updateExpense(idx, "vat", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Receive Date</label>
                        <input
                          type="date"
                          value={exp.recDate || ""}
                          onChange={(e) => updateExpense(idx, "recDate", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Days</label>
                        <input
                          type="number"
                          placeholder="30"
                          value={exp.days || ""}
                          onChange={(e) => updateExpense(idx, "days", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: "9.5px", fontWeight: 700, color: "#64748b" }}>Status</label>
                        <select
                          value={exp.status || "Received"}
                          onChange={(e) => updateExpense(idx, "status", e.target.value)}
                          style={{ ...formInputStyle, padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="Received">Received</option>
                          <option value="Paid">Paid</option>
                          <option value="Overdue">Overdue</option>
                        </select>
                      </div>
                      <div style={{ paddingTop: "14px", textAlign: "center" }}>
                        <button
                          type="button"
                          onClick={() => removeExpense(idx)}
                          title="Delete expense"
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#ef4444",
                            cursor: "pointer",
                            fontSize: "14px",
                            padding: "2px",
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "10px",
                  borderTop: "1px solid #e2e8f0",
                  paddingTop: "1rem",
                  marginTop: "0.5rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => setEditingJob(null)}
                  disabled={isSaving}
                  style={{
                    background: "#f1f5f9",
                    border: "1px solid #cbd5e1",
                    color: "#475569",
                    padding: "6px 14px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isSaving}
                  style={{
                    background: "#0047AB",
                    border: "none",
                    color: "#ffffff",
                    padding: "6px 18px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: isSaving ? "wait" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {isSaving ? <Spinner size={14} color="#ffffff" /> : null}
                  <span>{isSaving ? "Saving..." : "Save Job"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const formLabelStyle = {
  display: "block",
  fontSize: "11px",
  fontWeight: 700,
  color: "#475569",
  textTransform: "uppercase",
  marginBottom: "4px",
};

const formInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  fontSize: "12.5px",
  color: "#0f172a",
  background: "#ffffff",
};

const pageBtnStyle = {
  padding: "3px 8px",
  borderRadius: "4px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  fontSize: "11px",
  fontWeight: 600,
  color: "#0047AB",
  cursor: "pointer",
};
