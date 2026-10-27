import React, { useState } from "react";

export default function GoogleSheetLinkModal({
  isOpen,
  onClose,
  client,
  clientName,
  masterSheetId,
  clientSheetId,
  currentConfig,
  onSuccess,
  redirectBack = "/pma?nav=integrations"
}) {
  const resolvedClientName = client?.clientName || clientName || "";
  const resolvedMasterSheetId = client?.masterSheetId || masterSheetId || "";
  const resolvedClientSheetId = client?.clientSheetId || clientSheetId || "";

  const [url, setUrl] = useState(currentConfig?.metadata?.url || currentConfig?.url || "");
  const [selectedTab, setSelectedTab] = useState(currentConfig?.metadata?.tabName || currentConfig?.tabName || "");
  const [headerRowNum, setHeaderRowNum] = useState(String(currentConfig?.metadata?.headerRowNum || currentConfig?.headerRowNum || "1"));
  const [clientCol, setClientCol] = useState("");
  const [jobCol, setJobCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [startDateCol, setStartDateCol] = useState("");
  const [endDateCol, setEndDateCol] = useState("");
  const [statusCol, setStatusCol] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectionData, setInspectionData] = useState(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen || !resolvedClientName) return null;

  const handleInspect = async (overrideTab, overrideRow) => {
    if (!url.trim()) {
      setError("Please enter a valid Google Sheet URL.");
      return;
    }
    setError(null);
    setInspecting(true);

    const tabToUse = overrideTab !== undefined ? overrideTab : selectedTab;
    const rowToUse = overrideRow !== undefined ? overrideRow : headerRowNum;

    try {
      const res = await fetch("/api/integrations/google-sheet/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          clientKey: resolvedClientName,
          tabName: tabToUse || undefined,
          headerRowNum: rowToUse || undefined
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to inspect Google Sheet");
      }
      setInspectionData(data);
      const chosenTab = data.selectedTab || data.defaultTab || data.tabs?.[0]?.title || "Sheet1";
      setSelectedTab(chosenTab);
      setHeaderRowNum(String(data.candidateHeaderRow || 1));

      if (data.suggestedMapping) {
        setClientCol(data.suggestedMapping.clientCol || "");
        setJobCol(data.suggestedMapping.jobCol || "");
        setValueCol(data.suggestedMapping.revCol || "");
        setStartDateCol(data.suggestedMapping.startCol || "");
        setEndDateCol(data.suggestedMapping.endCol || "");
        setStatusCol(data.suggestedMapping.likeCol || "");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setInspecting(false);
    }
  };

  const handleTabChange = (e) => {
    const newTab = e.target.value;
    setSelectedTab(newTab);
    handleInspect(newTab, headerRowNum);
  };

  const handleHeaderRowChange = (e) => {
    setHeaderRowNum(e.target.value);
  };

  const handleReinspectRow = () => {
    handleInspect(selectedTab, headerRowNum);
  };

  const handleSaveLink = async () => {
    if (!inspectionData?.spreadsheetId || !selectedTab) {
      setError("Please inspect the sheet and choose a tab before linking.");
      return;
    }
    if (!clientCol.trim() || !jobCol.trim()) {
      setError("Please select the required columns for client name and job or project name.");
      return;
    }
    setError(null);
    setLinking(true);

    const keyHeaders = [
      clientCol.trim(),
      jobCol.trim(),
      valueCol.trim() || "None",
      startDateCol.trim() || "None",
      endDateCol.trim() || "None",
      statusCol.trim() || "None"
    ].join(", ");

    try {
      const res = await fetch("/api/integrations/google-sheet/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: resolvedClientName,
          masterSheetId: resolvedMasterSheetId,
          url: url.trim(),
          tabName: selectedTab,
          headerRowNum: parseInt(headerRowNum, 10) || 1,
          keyHeaders
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to link Google Sheet");
      }
      onSuccess?.(data);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLinking(false);
    }
  };

  const handleOAuthConnect = () => {
    const q = new URLSearchParams({
      clientKey: resolvedClientName,
      clientName: resolvedClientName,
      masterSheetId: resolvedMasterSheetId || "",
      clientSheetId: resolvedClientSheetId || "",
      redirectBack
    });
    window.location.href = `/api/integrations/google-sheet/connect?${q.toString()}`;
  };

  const availableHeaders = inspectionData?.headers || [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "16px",
          width: "100%",
          maxWidth: "620px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          border: "1px solid #e2e8f0",
          overflow: "hidden"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #f1f5f9",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                background: "rgba(15, 157, 88, 0.12)",
                color: "#0f9d58",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "700",
                fontSize: "15px"
              }}
            >
              GS
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                Connect Google Sheet CRM
              </h3>
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                For {resolvedClientName}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              color: "#94a3b8",
              cursor: "pointer",
              padding: "4px 8px"
            }}
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
          {/* Informational badge */}
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "18px",
              fontSize: "12.5px",
              color: "#166534",
              lineHeight: "1.5"
            }}
          >
            <strong>Read-only sync:</strong> Pulse reads your pipeline data and maintains deal tracking in an internal Master Sheet bridge. Your original Google Sheet is never modified.
          </div>

          {error && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "8px",
                padding: "10px 14px",
                marginBottom: "16px",
                fontSize: "12px",
                color: "#991b1b"
              }}
            >
              {error}
            </div>
          )}

          {/* Option 1: Direct URL Link */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
              Google Sheet URL
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                style={{
                  flex: 1,
                  padding: "9px 12px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  fontSize: "13px",
                  boxSizing: "border-box"
                }}
              />
              <button
                type="button"
                onClick={() => handleInspect()}
                disabled={inspecting}
                style={{
                  padding: "9px 16px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#0f9d58",
                  color: "#ffffff",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: inspecting ? "wait" : "pointer"
                }}
              >
                {inspecting ? "Inspecting..." : "Inspect sheet"}
              </button>
            </div>
          </div>

          {/* Inspection Results (Tabs + Header Row + Mapping) */}
          {inspectionData && (
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "16px",
                marginBottom: "18px"
              }}
            >
              <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a", marginBottom: "12px" }}>
                ✓ {inspectionData.title}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px", marginBottom: "14px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "4px" }}>
                    Select pipeline worksheet tab
                  </label>
                  <select
                    value={selectedTab}
                    onChange={handleTabChange}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "12.5px",
                      background: "#ffffff"
                    }}
                  >
                    {(inspectionData.tabs || []).map((t) => (
                      <option key={t.title} value={t.title}>
                        {t.title} ({t.rowCount} rows)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "4px" }}>
                    Header row number
                  </label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <input
                      type="number"
                      min="1"
                      value={headerRowNum}
                      onChange={handleHeaderRowChange}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12.5px",
                        boxSizing: "border-box"
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleReinspectRow}
                      disabled={inspecting}
                      title="Re-read headers from specified row number"
                      style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: "#ffffff",
                        fontSize: "11px",
                        fontWeight: "600",
                        color: "#475569",
                        cursor: "pointer",
                        whiteSpace: "nowrap"
                      }}
                    >
                      Update
                    </button>
                  </div>
                </div>
              </div>

              {/* 6 CRM Column Mapping Selectors */}
              <div style={{ marginTop: "14px", borderTop: "1px solid #e2e8f0", paddingTop: "14px" }}>
                <span style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", display: "block", marginBottom: "8px" }}>
                  Map key CRM columns
                </span>
                <p style={{ margin: "0 0 12px 0", fontSize: "11.5px", color: "#64748b" }}>
                  Pulse maps your deal tracking to these standard fields. Only client and job name are required.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {/* Client name (Required) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Client name *
                    </label>
                    <select
                      value={clientCol}
                      onChange={(e) => setClientCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: clientCol ? "1px solid #cbd5e1" : "1px solid #f87171",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- Select column --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Job or project name (Required) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Job or project name *
                    </label>
                    <select
                      value={jobCol}
                      onChange={(e) => setJobCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: jobCol ? "1px solid #cbd5e1" : "1px solid #f87171",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- Select column --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Deal value or revenue (Optional) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Deal value or revenue (optional)
                    </label>
                    <select
                      value={valueCol}
                      onChange={(e) => setValueCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- None / not in sheet --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Start date (Optional) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Start date (optional)
                    </label>
                    <select
                      value={startDateCol}
                      onChange={(e) => setStartDateCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- None / not in sheet --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* End date (Optional) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      End date (optional)
                    </label>
                    <select
                      value={endDateCol}
                      onChange={(e) => setEndDateCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- None / not in sheet --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Stage or probability (Optional) */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Stage or probability (optional)
                    </label>
                    <select
                      value={statusCol}
                      onChange={(e) => setStatusCol(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        background: "#ffffff"
                      }}
                    >
                      <option value="">-- None / not in sheet --</option>
                      {availableHeaders.map((h, i) => (
                        <option key={i} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Action Button */}
          {inspectionData && (
            <button
              type="button"
              onClick={handleSaveLink}
              disabled={linking}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: "8px",
                border: "none",
                background: "#0f9d58",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: "700",
                cursor: linking ? "wait" : "pointer",
                marginBottom: "16px"
              }}
            >
              {linking ? "Linking CRM source..." : `Link "${selectedTab}" as CRM source`}
            </button>
          )}

          {/* Divider */}
          <div style={{ display: "flex", alignItems: "center", margin: "16px 0", color: "#94a3b8", fontSize: "11px" }}>
            <div style={{ flex: 1, height: "1px", background: "#e2e8f0" }} />
            <span style={{ padding: "0 10px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              {currentConfig?.connected ? "google account access" : "or"}
            </span>
            <div style={{ flex: 1, height: "1px", background: "#e2e8f0" }} />
          </div>

          {/* Option 2: Google OAuth Status or Sign in */}
          {currentConfig?.connected ? (
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "8px",
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: "#166534", fontSize: "14px", fontWeight: "700" }}>✓</span>
                <div>
                  <div style={{ fontSize: "12px", color: "#166534", fontWeight: "600" }}>
                    Connected to {currentConfig.metadata?.userEmail || currentConfig.metadata?.accountName || currentConfig.tenantName || "Google Account"}
                  </div>
                  <div style={{ fontSize: "11px", color: "#15803d" }}>
                    Enter your Google Sheet URL above and click Inspect sheet to map columns.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleOAuthConnect}
                style={{
                  background: "none",
                  border: "none",
                  color: "#15803d",
                  fontSize: "11px",
                  fontWeight: "600",
                  textDecoration: "underline",
                  cursor: "pointer",
                  whiteSpace: "nowrap"
                }}
              >
                Switch account
              </button>
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={handleOAuthConnect}
                style={{
                  width: "100%",
                  padding: "9px 14px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#1e293b",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px"
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                <span>Sign in with Google to grant access</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
