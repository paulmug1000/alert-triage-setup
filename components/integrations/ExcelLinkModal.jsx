import React, { useState } from "react";

export default function ExcelLinkModal({
  isOpen,
  onClose,
  client,
  clientName,
  masterSheetId,
  clientSheetId,
  currentConfig,
  onSuccess,
  isClientView = false,
  redirectBack = "/pma?nav=integrations"
}) {
  const resolvedClientName = client?.clientName || clientName || "";
  const resolvedMasterSheetId = client?.masterSheetId || masterSheetId || "";
  const resolvedClientSheetId = client?.clientSheetId || clientSheetId || "";

  const [excelUrl, setExcelUrl] = useState(currentConfig?.metadata?.url || currentConfig?.url || "");
  const [driveId, setDriveId] = useState(currentConfig?.metadata?.driveId || currentConfig?.driveId || "");
  const [fileId, setFileId] = useState(currentConfig?.metadata?.fileId || currentConfig?.fileId || "");
  const [sheetName, setSheetName] = useState(currentConfig?.metadata?.sheetName || currentConfig?.sheetName || "");
  const [rangeAddress, setRangeAddress] = useState(currentConfig?.metadata?.rangeAddress || currentConfig?.rangeAddress || "");
  const [headerRowNum, setHeaderRowNum] = useState(
    currentConfig?.metadata?.headerRowNum ? String(currentConfig.metadata.headerRowNum) : ""
  );
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

  const isConnected = Boolean(
    currentConfig?.connected ||
    client?.integrations?.excel?.connected ||
    client?.crmStatus?.connected ||
    currentConfig?.metadata?.userEmail ||
    client?.integrations?.excel?.metadata?.userEmail
  );
  const connectedEmail =
    currentConfig?.metadata?.userEmail ||
    client?.integrations?.excel?.metadata?.userEmail ||
    currentConfig?.tenantName ||
    client?.tenantName ||
    "Microsoft 365 Account";

  const handleInspect = async (overrideSheet, overrideRow) => {
    if (!driveId.trim() && !fileId.trim() && !excelUrl.trim()) {
      setError("Please enter Excel URL or Drive ID and File ID.");
      return;
    }
    setError(null);
    setInspecting(true);

    const sheetToUse = overrideSheet !== undefined ? overrideSheet : sheetName;
    const rowToUse = overrideRow !== undefined ? overrideRow : (headerRowNum || undefined);

    try {
      const res = await fetch("/api/integrations/excel/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: excelUrl.trim() || undefined,
          driveId: driveId.trim() || undefined,
          fileId: fileId.trim() || undefined,
          sheetName: sheetToUse.trim(),
          headerRowNum: rowToUse || undefined,
          clientKey: resolvedClientName
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to inspect Excel workbook");
      }
      setInspectionData(data);
      if (data.driveId) setDriveId(data.driveId);
      if (data.fileId) setFileId(data.fileId);
      const chosenSheet = sheetToUse.trim() || data.defaultWorksheet || "Sheet1";
      setSheetName(chosenSheet);
      setHeaderRowNum(String(data.candidateHeaderRow || 1));

      if (data.rangeAddress) {
        setRangeAddress(data.rangeAddress);
      }

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

  const handleClientSave = async () => {
    if (!excelUrl.trim() && (!driveId.trim() || !fileId.trim())) {
      setError("Please enter your Excel workbook web link or OneDrive link.");
      return;
    }
    setError(null);
    setLinking(true);

    try {
      // 1. Inspect workbook behind the scenes to verify access, default worksheet, candidate header row & suggested columns
      const inspectRes = await fetch("/api/integrations/excel/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: excelUrl.trim() || undefined,
          driveId: driveId.trim() || undefined,
          fileId: fileId.trim() || undefined,
          clientKey: resolvedClientName
        })
      });
      const inspectData = await inspectRes.json();
      if (!inspectData.success) {
        throw new Error(inspectData.error || "Could not access Excel workbook. Please verify the link and authorization.");
      }

      const defaultSheet = inspectData.defaultWorksheet || inspectData.worksheets?.[0]?.name || "Sheet1";
      const candidateRow = inspectData.candidateHeaderRow || 1;
      const suggested = inspectData.suggestedMapping || {};
      const keyHeaders = [
        suggested.clientCol || "Client",
        suggested.jobCol || "Job",
        suggested.revCol || "None",
        suggested.startCol || "None",
        suggested.endCol || "None",
        suggested.likeCol || "None"
      ].join(", ");

      // 2. Link Excel workbook to Master Sheet KeyInfo and Central Vault
      const linkRes = await fetch("/api/integrations/excel/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: resolvedClientName,
          masterSheetId: resolvedMasterSheetId,
          url: excelUrl.trim() || undefined,
          driveId: inspectData.driveId || driveId.trim(),
          fileId: inspectData.fileId || fileId.trim(),
          sheetName: defaultSheet,
          rangeAddress: inspectData.rangeAddress || "usedRange",
          headerRowNum: String(candidateRow),
          keyHeaders
        })
      });
      const linkData = await linkRes.json();
      if (!linkData.success) {
        throw new Error(linkData.error || "Failed to link Excel workbook");
      }

      onSuccess?.(linkData);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLinking(false);
    }
  };

  const handleSheetChange = (e) => {
    const newSheet = e.target.value;
    setSheetName(newSheet);
    handleInspect(newSheet, undefined);
  };

  const handleHeaderRowChange = (e) => {
    setHeaderRowNum(e.target.value);
  };

  const handleReinspectRow = () => {
    handleInspect(sheetName, headerRowNum);
  };

  const handleSaveLink = async () => {
    if (!driveId.trim() || !fileId.trim() || !sheetName.trim()) {
      setError("Please fill in Drive ID, File ID, and worksheet name.");
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
      const res = await fetch("/api/integrations/excel/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: resolvedClientName,
          masterSheetId: resolvedMasterSheetId,
          url: excelUrl.trim() || undefined,
          driveId: driveId.trim(),
          fileId: fileId.trim(),
          sheetName: sheetName.trim(),
          rangeAddress: rangeAddress.trim() || "",
          headerRowNum: parseInt(headerRowNum, 10) || 1,
          keyHeaders
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to link Excel workbook");
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
    window.location.href = `/api/integrations/excel/connect?${q.toString()}`;
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
                background: "rgba(15, 108, 189, 0.12)",
                color: "#0f6cbd",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: "700",
                fontSize: "15px"
              }}
            >
              XL
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                {isClientView ? "Connect Microsoft Excel" : "Connect Microsoft Excel CRM"}
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
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
              borderRadius: "8px",
              padding: "12px 14px",
              marginBottom: "18px",
              fontSize: "12.5px",
              color: "#0369a1",
              lineHeight: "1.5"
            }}
          >
            <strong>Cloud workbook sync:</strong> Pulse connects to Microsoft Excel files on SharePoint or OneDrive via Microsoft Graph API. Reconciles deal records via the Master Sheet bridge.
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

          {/* 1. Microsoft 365 Account Authorization */}
          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", marginBottom: "8px" }}>
              1. Microsoft 365 account authorization
            </label>
            {isConnected ? (
              <div
                style={{
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: "8px",
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "#1d4ed8", fontSize: "14px", fontWeight: "700" }}>✓</span>
                  <div>
                    <div style={{ fontSize: "12px", color: "#1d4ed8", fontWeight: "600" }}>
                      Connected to {connectedEmail}
                    </div>
                    <div style={{ fontSize: "11px", color: "#2563eb" }}>
                      {isClientView ? "Ready to link your Excel workbook below." : "Authenticated via Microsoft Graph. Ready to inspect workbook below."}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleOAuthConnect}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2563eb",
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
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "14px" }}>
                <p style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#475569", lineHeight: "1.4" }}>
                  Authorize Pulse to read your Microsoft Excel workbook via Microsoft Graph API.
                </p>
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
                    gap: "8px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 23 23">
                    <path fill="#f35325" d="M1 1h10v10H1z" />
                    <path fill="#81bc06" d="M12 1h10v10H12z" />
                    <path fill="#05a6f0" d="M1 12h10v10H1z" />
                    <path fill="#ffba08" d="M12 12h10v10H12z" />
                  </svg>
                  <span>Sign in with Microsoft 365 to authorize</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. Workbook Drive & File ID */}
          {isConnected && (
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", marginBottom: "8px" }}>
                {isClientView ? "2. Excel workbook link" : "2. Workbook Drive ID & File ID mapping"}
              </label>

              {isClientView ? (
                <div>
                  <p style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#475569", lineHeight: "1.4" }}>
                    Paste the OneDrive or SharePoint web link to your Excel workbook. Pulse will connect securely to read your deal pipeline.
                  </p>
                  <input
                    type="text"
                    value={excelUrl}
                    onChange={(e) => setExcelUrl(e.target.value)}
                    placeholder="https://...sharepoint.com/:x:/... or OneDrive link"
                    style={{ width: "100%", padding: "9px 12px", borderRadius: "7px", border: "1px solid #cbd5e1", fontSize: "13px", boxSizing: "border-box", marginBottom: "12px" }}
                  />
                  <button
                    type="button"
                    onClick={handleClientSave}
                    disabled={linking}
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      borderRadius: "7px",
                      border: "none",
                      background: "#0f6cbd",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: linking ? "wait" : "pointer",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                    }}
                  >
                    {linking ? "Saving..." : "Save Excel workbook"}
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ marginBottom: "10px" }}>
                    <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "3px" }}>
                      Workbook link or SharePoint URL (optional)
                    </label>
                    <input
                      type="text"
                      value={excelUrl}
                      onChange={(e) => setExcelUrl(e.target.value)}
                      placeholder="https://...sharepoint.com/:x:/... or OneDrive link"
                      style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12px", boxSizing: "border-box" }}
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "12px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "3px" }}>
                        Drive ID
                      </label>
                      <input
                        type="text"
                        value={driveId}
                        onChange={(e) => setDriveId(e.target.value)}
                        placeholder="b!..."
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "3px" }}>
                        File ID
                      </label>
                      <input
                        type="text"
                        value={fileId}
                        onChange={(e) => setFileId(e.target.value)}
                        placeholder="01..."
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() => handleInspect()}
                      disabled={inspecting}
                      style={{
                        padding: "8px 16px",
                        borderRadius: "6px",
                        border: "none",
                        background: "#0f6cbd",
                        color: "#ffffff",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: inspecting ? "wait" : "pointer"
                      }}
                    >
                      {inspecting ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Worksheet Selection and Column Mapping */}
          {!isClientView && inspectionData && (
            <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "16px", border: "1px solid #e2e8f0", marginBottom: "18px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px", marginBottom: "14px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#475569", marginBottom: "4px" }}>
                    Worksheet name
                  </label>
                  {inspectionData?.worksheets ? (
                    <select
                      value={sheetName}
                      onChange={handleSheetChange}
                      style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px", background: "#fff" }}
                    >
                      {inspectionData.worksheets.map((w) => (
                        <option key={w.name} value={w.name}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={sheetName}
                      onChange={(e) => setSheetName(e.target.value)}
                      placeholder="e.g. Pipeline or Sheet1"
                      style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px", boxSizing: "border-box" }}
                    />
                  )}
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
                      style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px", boxSizing: "border-box" }}
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

                  {/* Start date */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Start date
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

                  {/* End date */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      End date
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

                  {/* Stage or probability */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Stage or probability
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

          {/* Action Button - Admin / Manager Only */}
          {!isClientView && inspectionData && (
            <button
              type="button"
              onClick={handleSaveLink}
              disabled={linking}
              style={{
                width: "100%",
                padding: "11px",
                borderRadius: "8px",
                border: "none",
                background: "#0f6cbd",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: "700",
                cursor: linking ? "wait" : "pointer"
              }}
            >
              {linking ? "Linking CRM source..." : `Link "${sheetName || "Workbook"}" as CRM source`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
