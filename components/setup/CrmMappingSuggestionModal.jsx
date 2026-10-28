import React, { useState, useEffect } from "react";
import Spinner from "../Spinner";

export default function CrmMappingSuggestionModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onApplied,
  isAdmin = false
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [detectedCrmTool, setDetectedCrmTool] = useState("");
  const [totalRecordsAnalysed, setTotalRecordsAnalysed] = useState(0);
  const [availableHeaders, setAvailableHeaders] = useState([]);
  const [uniqueStatusOptions, setUniqueStatusOptions] = useState([]);
  const [fieldMappings, setFieldMappings] = useState([]);

  // Confirmed Job Definitions
  const [confirmedLikelihood, setConfirmedLikelihood] = useState("100%");
  const [confirmedStatus, setConfirmedStatus] = useState("");
  const [confirmedOperator, setConfirmedOperator] = useState("Or");
  const [pipelineExcludedStatuses, setPipelineExcludedStatuses] = useState("");

  useEffect(() => {
    if (!isOpen || !clientName) return;

    let isMounted = true;
    setLoading(true);
    setFeedback(null);

    fetch(`/api/setup/suggest-crm-mappings?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`)
      .then(res => res.json())
      .then(result => {
        if (!isMounted) return;
        if (result.success) {
          setDetectedCrmTool(result.detectedCrmTool || "Custom / Google Sheets");
          setTotalRecordsAnalysed(result.totalRecordsAnalysed || 0);
          setAvailableHeaders(result.availableHeaders || []);
          setUniqueStatusOptions(result.uniqueStatusOptions || []);
          setFieldMappings(result.fieldMappings || []);

          if (result.jobDefinitions) {
            setConfirmedLikelihood(result.jobDefinitions.confirmedLikelihood || "100%");
            setConfirmedStatus(result.jobDefinitions.confirmedStatus || "");
            setConfirmedOperator(result.jobDefinitions.confirmedOperator || "Or");
            setPipelineExcludedStatuses(result.jobDefinitions.pipelineExcludedStatuses || "");
          }
        } else {
          setFeedback({ type: "error", message: result.error || "Failed to load CRM suggestions." });
        }
      })
      .catch(err => {
        if (!isMounted) return;
        setFeedback({ type: "error", message: err.message });
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, clientName, masterSheetId]);

  if (!isOpen) return null;

  const handleFieldChange = (fieldKey, crmField) => {
    setFieldMappings(prev =>
      prev.map(f => (f.key === fieldKey ? { ...f, crmField } : f))
    );
  };

  const handleFormatRuleChange = (fieldKey, formatRule) => {
    setFieldMappings(prev =>
      prev.map(f => (f.key === fieldKey ? { ...f, formatRule } : f))
    );
  };

  const handleApply = async () => {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/suggest-crm-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          fieldMappings,
          jobDefinitions: {
            confirmedLikelihood,
            confirmedStatus,
            confirmedOperator,
            pipelineExcludedStatuses
          }
        })
      });

      const resData = await res.json();
      if (resData.success) {
        if (onApplied) onApplied({ fieldMappings, jobDefinitions: { confirmedLikelihood, confirmedStatus, confirmedOperator, pipelineExcludedStatuses } });
        onClose();
      } else {
        throw new Error(resData.error || "Failed to apply CRM mappings.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "960px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          overflow: "hidden"
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#F8FAFC"
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
              Auto-suggest CRM field mappings and rules
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748B" }}>
              Inspecting {totalRecordsAnalysed} records {isAdmin ? "from DataFromCRM " : ""}to map 13 Pulse fields and transformation rules
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              cursor: saving ? "not-allowed" : "pointer",
              color: "#94A3B8",
              padding: "4px"
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: "50px 0", textAlign: "center" }}>
              <Spinner size={32} color="#023f98" />
              <p style={{ marginTop: "12px", fontSize: "13px", color: "#64748B" }}>
                Reading CRM records and analyzing field heuristics...
              </p>
            </div>
          ) : (
            <div>
              {/* Feedback Alert */}
              {feedback && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "6px",
                    marginBottom: "16px",
                    fontSize: "12px",
                    background: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
                    border: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
                    color: feedback.type === "error" ? "#991B1B" : "#065F46"
                  }}
                >
                  {feedback.message}
                </div>
              )}

              {/* Source callout */}
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  marginBottom: "18px",
                  fontSize: "12px",
                  background: "#F1F5F9",
                  border: "1px solid #E2E8F0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px"
                }}
              >
                <div>
                  <span style={{ fontWeight: "700", color: "#0F172A" }}>
                    Detected CRM tool: {detectedCrmTool}
                  </span>
                  <div style={{ color: "#64748B", marginTop: "2px" }}>
                    Analysed {totalRecordsAnalysed} deals across {availableHeaders.length} available columns{isAdmin ? " in DataFromCRM" : ""}.
                  </div>
                </div>
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#0284C7", background: "#E0F2FE", padding: "4px 8px", borderRadius: "6px" }}>
                  100+ sample inspection active
                </div>
              </div>

              {/* 13 Pulse Fields Table */}
              <div style={{ marginBottom: "20px" }}>
                <h4 style={{ margin: "0 0 10px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                  13 Pulse fields mapping{isAdmin ? " (CRMList!AB2:AN2 & A2:M2)" : ""}
                </h4>
                <div style={{ border: "1px solid #E2E8F0", borderRadius: "8px", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", textAlign: "left" }}>
                        <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "160px" }}>Pulse field</th>
                        <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569" }}>Mapped CRM column</th>
                        <th style={{ padding: "8px 12px", fontWeight: "600", color: "#475569", width: "200px" }}>Transformation rule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fieldMappings.map((field) => (
                        <tr key={field.key} style={{ borderBottom: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "8px 12px", fontWeight: "600", color: "#1E293B" }}>
                            {field.label}
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <select
                              value={field.crmField || ""}
                              onChange={(e) => handleFieldChange(field.key, e.target.value)}
                              style={{
                                width: "100%",
                                padding: "6px 10px",
                                borderRadius: "6px",
                                border: "1px solid #CBD5E1",
                                fontSize: "12px",
                                background: field.crmField ? "#FFFFFF" : "#FFFBEB"
                              }}
                            >
                              <option value="">(None / unmapped)</option>
                              {availableHeaders.map((header) => (
                                <option key={header} value={header}>
                                  {header}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            {field.formatOptions && field.formatOptions.length > 0 ? (
                              <select
                                value={field.formatRule || field.formatOptions[0]}
                                onChange={(e) => handleFormatRuleChange(field.key, e.target.value)}
                                style={{
                                  width: "100%",
                                  padding: "6px 10px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  fontSize: "12px"
                                }}
                              >
                                {field.formatOptions.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span style={{ color: "#94A3B8", fontSize: "11px" }}>Standard</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Confirmed Job Definitions */}
              <div style={{ background: "#F8FAFC", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "16px" }}>
                <h4 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>
                  Confirmed job definition{isAdmin ? " (CRMList!DD2:DH2)" : ""} & pipeline exclusions{isAdmin ? " (EE2)" : ""}
                </h4>
                <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#64748B" }}>
                  Defines when a CRM opportunity is considered confirmed vs pipeline, and which dead/lost statuses to exclude.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                      Confirmed likelihood{isAdmin ? " (DD2)" : ""}
                    </label>
                    <input
                      type="text"
                      value={confirmedLikelihood}
                      onChange={(e) => setConfirmedLikelihood(e.target.value)}
                      placeholder="e.g. 100%"
                      style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                      Confirmed status{isAdmin ? " (DF2)" : ""}
                    </label>
                    {uniqueStatusOptions.length > 0 ? (
                      <select
                        value={confirmedStatus}
                        onChange={(e) => setConfirmedStatus(e.target.value)}
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      >
                        <option value="">(Select won status)</option>
                        {uniqueStatusOptions.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={confirmedStatus}
                        onChange={(e) => setConfirmedStatus(e.target.value)}
                        placeholder="e.g. Closed Won"
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                    )}
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                      Operator{isAdmin ? " (DH2)" : ""}
                    </label>
                    <select
                      value={confirmedOperator}
                      onChange={(e) => setConfirmedOperator(e.target.value)}
                      style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                    >
                      <option value="Or">Or</option>
                      <option value="And">And</option>
                    </select>
                  </div>

                  <div style={{ gridColumn: "1 / -1" }}>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                      Pipeline excluded statuses ({isAdmin ? "EE2, " : ""}comma-separated)
                    </label>
                    <input
                      type="text"
                      value={pipelineExcludedStatuses}
                      onChange={(e) => setPipelineExcludedStatuses(e.target.value)}
                      placeholder="e.g. Lost, Closed Lost, Archived"
                      style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "flex-end",
            gap: "12px",
            background: "#F8FAFC"
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid #CBD5E1",
              background: "#FFFFFF",
              color: "#475569",
              fontSize: "13px",
              fontWeight: "600",
              cursor: saving ? "not-allowed" : "pointer"
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={loading || saving}
            style={{
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              background: "#023f98",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: "700",
              cursor: loading || saving ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            {saving && <Spinner size={14} color="#FFFFFF" />}
            <span>{saving ? "Applying mappings..." : (isAdmin ? "Apply CRM mappings to master sheet" : "Apply CRM mappings")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
