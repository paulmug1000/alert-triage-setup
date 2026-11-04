import React, { useState, useEffect, useRef, useCallback } from "react";

let gapiLoadingPromise = null;

function loadGooglePickerApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("Browser environment required"));
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  if (gapiLoadingPromise) return gapiLoadingPromise;

  gapiLoadingPromise = new Promise((resolve, reject) => {
    const onGapiLoaded = () => {
      if (!window.gapi) {
        gapiLoadingPromise = null;
        reject(new Error("Failed to initialize Google API loader (gapi)."));
        return;
      }
      window.gapi.load("picker", {
        callback: () => {
          if (window.google?.picker) {
            resolve(window.google.picker);
          } else {
            gapiLoadingPromise = null;
            reject(new Error("Failed to load Google Picker library."));
          }
        },
        onerror: () => {
          gapiLoadingPromise = null;
          reject(new Error("Error loading Google Picker library."));
        }
      });
    };

    if (window.gapi) {
      onGapiLoaded();
      return;
    }

    const existingScript = document.querySelector('script[src="https://apis.google.com/js/api.js"]');
    if (existingScript) {
      existingScript.addEventListener("load", onGapiLoaded, { once: true });
      existingScript.addEventListener("error", () => {
        gapiLoadingPromise = null;
        reject(new Error("Failed to load Google API script from apis.google.com."));
      }, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.defer = true;
    script.onload = onGapiLoaded;
    script.onerror = () => {
      gapiLoadingPromise = null;
      reject(new Error("Failed to load Google API script from apis.google.com."));
    };
    document.body.appendChild(script);
  });

  return gapiLoadingPromise;
}

export default function GoogleSheetLinkModal({
  isOpen,
  onClose,
  client,
  clientName,
  masterSheetId,
  clientSheetId,
  currentConfig,
  onSuccess,
  isClientView = false,
  redirectBack = "/pma?nav=integrations",
  connectedAccount = "",
  autoOpenPicker = false
}) {
  const resolvedClientName = client?.clientName || clientName || "";
  const resolvedMasterSheetId = client?.masterSheetId || masterSheetId || "";
  const resolvedClientSheetId = client?.clientSheetId || clientSheetId || "";

  const initialUrl =
    currentConfig?.metadata?.url ||
    currentConfig?.url ||
    client?.integrations?.googlesheet?.metadata?.url ||
    "";

  const initialTitle =
    currentConfig?.metadata?.spreadsheetTitle ||
    client?.integrations?.googlesheet?.metadata?.spreadsheetTitle ||
    "";

  const [url, setUrl] = useState(initialUrl);
  const [selectedSheetTitle, setSelectedSheetTitle] = useState(initialTitle);
  const [isSheetSelected, setIsSheetSelected] = useState(Boolean(initialUrl));
  const [openingPicker, setOpeningPicker] = useState(false);

  const [selectedTab, setSelectedTab] = useState(currentConfig?.metadata?.tabName || currentConfig?.tabName || "");
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
  const [error, setError] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const isGoogle = p.get("integration") === "googlesheet" || p.get("tool") === "googlesheet";
      if (isGoogle && p.get("status") === "error") {
        return p.get("message") || p.get("error") || null;
      }
    }
    return null;
  });

  const autoOpenedRef = useRef(false);

  const isConnected = Boolean(
    connectedAccount ||
    currentConfig?.connected ||
    client?.integrations?.googlesheet?.connected ||
    client?.crmStatus?.connected ||
    currentConfig?.metadata?.userEmail ||
    client?.integrations?.googlesheet?.metadata?.userEmail
  );

  const connectedEmail =
    connectedAccount ||
    currentConfig?.metadata?.userEmail ||
    client?.integrations?.googlesheet?.metadata?.userEmail ||
    currentConfig?.tenantName ||
    client?.tenantName ||
    "Google Account";

  // Sync url/title if currentConfig updates asynchronously after modal opens
  useEffect(() => {
    const cfgUrl =
      currentConfig?.metadata?.url ||
      currentConfig?.url ||
      client?.integrations?.googlesheet?.metadata?.url ||
      "";
    const cfgTitle =
      currentConfig?.metadata?.spreadsheetTitle ||
      client?.integrations?.googlesheet?.metadata?.spreadsheetTitle ||
      "";
    if (cfgUrl && !url) {
      setUrl(cfgUrl);
      setIsSheetSelected(true);
    }
    if (cfgTitle && !selectedSheetTitle) {
      setSelectedSheetTitle(cfgTitle);
    }
  }, [currentConfig, client, url, selectedSheetTitle]);

  const handleInspect = useCallback(async (overrideTab, overrideRow, overrideUrl) => {
    const targetUrl = (overrideUrl !== undefined ? overrideUrl : url).trim();
    if (!targetUrl) {
      setError("Please select a Google Sheet from Google Drive first.");
      return;
    }
    setError(null);
    setInspecting(true);

    const tabToUse = overrideTab !== undefined ? overrideTab : selectedTab;
    const rowToUse = overrideRow !== undefined ? overrideRow : (headerRowNum || undefined);

    try {
      const res = await fetch("/api/integrations/google-sheet/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
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
      if (data.title && !selectedSheetTitle) {
        setSelectedSheetTitle(data.title);
      }
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
  }, [url, selectedTab, headerRowNum, resolvedClientName, selectedSheetTitle]);

  const handleOpenPicker = useCallback(async () => {
    setError(null);
    setOpeningPicker(true);

    try {
      const q = new URLSearchParams({
        clientKey: resolvedClientName,
        masterSheetId: resolvedMasterSheetId || ""
      });
      const [tokenRes] = await Promise.all([
        fetch(`/api/integrations/google-sheet/picker-token?${q.toString()}`),
        loadGooglePickerApi()
      ]);
      const tokenData = await tokenRes.json();

      if (!tokenData.success) {
        throw new Error(tokenData.error || "Could not initialize Google Drive file picker.");
      }

      const pickerApi = window.google?.picker;
      if (!pickerApi) {
        throw new Error("Google Picker library failed to initialize.");
      }

      const view = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS)
        .setIncludeFolders(true)
        .setMimeTypes("application/vnd.google-apps.spreadsheet");

      const builder = new pickerApi.PickerBuilder()
        .addView(view)
        .setOAuthToken(tokenData.accessToken)
        .setDeveloperKey(tokenData.developerKey)
        .setTitle("Select your CRM Google Sheet")
        .setOrigin(window.location.protocol + "//" + window.location.host)
        .setCallback((data) => {
          const action = data?.[pickerApi.Response.ACTION];
          if (action === pickerApi.Action.PICKED) {
            const doc = data?.[pickerApi.Response.DOCUMENTS]?.[0];
            if (doc) {
              const pickedId = doc[pickerApi.Document.ID];
              const pickedName = doc[pickerApi.Document.NAME] || "Selected Google Sheet";
              const pickedUrl = doc[pickerApi.Document.URL] || `https://docs.google.com/spreadsheets/d/${pickedId}/edit`;
              setUrl(pickedUrl);
              setSelectedSheetTitle(pickedName);
              setIsSheetSelected(true);
              setInspectionData(null);
              setError(null);
              if (!isClientView) {
                handleInspect("", undefined, pickedUrl);
              }
            }
          }
        });

      if (tokenData.appId) {
        builder.setAppId(tokenData.appId);
      }

      const picker = builder.build();
      picker.setVisible(true);
    } catch (err) {
      setError(err.message || "Failed to open Google Drive picker.");
    } finally {
      setOpeningPicker(false);
    }
  }, [resolvedClientName, resolvedMasterSheetId, isClientView, handleInspect]);

  // Preload Google Picker script when modal opens and user is connected
  useEffect(() => {
    if (isOpen && isConnected) {
      loadGooglePickerApi().catch(() => {});
    }
  }, [isOpen, isConnected]);

  // Auto-open picker upon returning from OAuth if no sheet has been selected yet
  useEffect(() => {
    if (isOpen && isConnected && autoOpenPicker && !isSheetSelected && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      handleOpenPicker();
    }
  }, [isOpen, isConnected, autoOpenPicker, isSheetSelected, handleOpenPicker]);

  // Automatically inspect existing linked sheet when opened in PMA view
  useEffect(() => {
    if (isOpen && isSheetSelected && isConnected && url && url.trim() && !inspectionData && !inspecting && !isClientView && !error) {
      handleInspect();
    }
  }, [isOpen, isSheetSelected, isConnected, url, inspectionData, inspecting, isClientView, error, handleInspect]);

  const handleTabChange = (e) => {
    const newTab = e.target.value;
    setSelectedTab(newTab);
    handleInspect(newTab, undefined);
  };

  const handleHeaderRowChange = (e) => {
    setHeaderRowNum(e.target.value);
  };

  const handleReinspectRow = () => {
    handleInspect(selectedTab, headerRowNum);
  };

  const handleSaveLink = async () => {
    if (!inspectionData?.spreadsheetId || !selectedTab) {
      setError("Please select a spreadsheet and choose a tab before linking.");
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
          spreadsheetTitle: selectedSheetTitle || inspectionData?.title || "",
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

  const handleClientSave = async () => {
    if (!url.trim()) {
      setError("Please select your Google Sheet from Google Drive first.");
      return;
    }
    setError(null);
    setLinking(true);

    try {
      // 1. Inspect sheet behind the scenes to verify access, get default tab, candidate header row & suggested columns
      const inspectRes = await fetch("/api/integrations/google-sheet/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          clientKey: resolvedClientName
        })
      });
      const inspectData = await inspectRes.json();
      if (!inspectData.success) {
        throw new Error(inspectData.error || "Could not access spreadsheet. Please select the spreadsheet using the Google Drive file picker.");
      }

      const defaultTab = inspectData.selectedTab || inspectData.defaultTab || inspectData.tabs?.[0]?.title || "Sheet1";
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

      // 2. Link the sheet to Master Sheet KeyInfo and Central Vault
      const linkRes = await fetch("/api/integrations/google-sheet/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: resolvedClientName,
          masterSheetId: resolvedMasterSheetId,
          url: url.trim(),
          spreadsheetTitle: selectedSheetTitle || inspectData.title || "",
          tabName: defaultTab,
          headerRowNum: candidateRow,
          keyHeaders
        })
      });
      const linkData = await linkRes.json();
      if (!linkData.success) {
        throw new Error(linkData.error || "Failed to link Google Sheet");
      }

      onSuccess?.(linkData);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLinking(false);
    }
  };

  const handleOAuthConnect = () => {
    setError(null);
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
  const displaySheetTitle = selectedSheetTitle || inspectionData?.title || "Selected Google Sheet";

  const isWaitingForInspection =
    !isClientView &&
    !inspectionData &&
    (inspecting || (isConnected && isSheetSelected && Boolean(url?.trim()) && !error));

  if (!isOpen || !resolvedClientName) return null;

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
      {/* Ensure Google Picker iframe dialog renders above modal overlay */}
      <style>{`
        .picker-dialog { z-index: 100002 !important; }
        .picker-dialog-bg { z-index: 100001 !important; }
      `}</style>

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
            {!isClientView && (
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
            )}
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>
                {isClientView ? "Connect Google Sheet" : "Connect Google Sheet CRM"}
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
          {/* Informational badge for PMA admin view only */}
          {!isClientView && (
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
              <strong>Read-only sync:</strong> Pulse only accesses the specific spreadsheet you select in Google Drive and never modifies your file.
            </div>
          )}

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

          {/* 1. Google Account Authorisation */}
          <div style={{ marginBottom: "20px" }}>
            {!isClientView ? (
              <label style={{ display: "block", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", marginBottom: "8px" }}>
                1. Google account authorisation
              </label>
            ) : (
              <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#1e293b", marginBottom: "6px" }}>
                1. Sign in with Google
              </label>
            )}
            {isConnected ? (
              <div
                style={{
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "8px",
                  padding: "12px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ color: "#166534", fontSize: "16px", fontWeight: "700" }}>✓</span>
                  <div>
                    <div style={{ fontSize: "13px", color: "#166534", fontWeight: "600" }}>
                      Connected to {connectedEmail}
                    </div>
                    <div style={{ fontSize: "12px", color: "#15803d", marginTop: "2px" }}>
                      {isSheetSelected
                        ? "Google account authorised and spreadsheet selected."
                        : "Google account authorised. Now choose your spreadsheet below."}
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
                    fontSize: "11.5px",
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
                <p style={{ margin: "0 0 12px 0", fontSize: isClientView ? "13px" : "12px", color: "#475569", lineHeight: "1.4" }}>
                  {isClientView
                    ? "Sign in with your Google account so you can choose your CRM Google Sheet from Google Drive."
                    : "Sign in with Google to select the CRM Google Sheet from Google Drive."}
                </p>
                <button
                  type="button"
                  onClick={handleOAuthConnect}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#1e293b",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                  </svg>
                  <span>Authorise with Google</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. Choose Google Sheet via Google Picker */}
          {isConnected && (
            <div style={{ marginBottom: "20px" }}>
              {!isClientView ? (
                <label style={{ display: "block", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", marginBottom: "8px" }}>
                  2. Select Google Sheet from Drive
                </label>
              ) : (
                <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#1e293b", marginBottom: "6px" }}>
                  2. Choose your CRM Google Sheet
                </label>
              )}

              {isSheetSelected && url ? (
                <div
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "12px 14px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", color: "#166534", display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>✓</span>
                        <span>Spreadsheet selected</span>
                      </div>
                      <div style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {displaySheetTitle}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleOpenPicker}
                      disabled={openingPicker}
                      style={{
                        background: "#ffffff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        padding: "6px 12px",
                        color: "#334155",
                        fontSize: "12px",
                        fontWeight: "600",
                        cursor: openingPicker ? "wait" : "pointer",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {openingPicker ? "Opening Drive..." : "Change spreadsheet"}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "14px" }}>
                  <p style={{ margin: "0 0 12px 0", fontSize: isClientView ? "13px" : "12px", color: "#475569", lineHeight: "1.4" }}>
                    {isClientView
                      ? "Choose your CRM spreadsheet from Google Drive. Pulse will only have permission to read the specific file you select."
                      : "Open the Google Drive file picker to select the CRM spreadsheet for this client."}
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenPicker}
                    disabled={openingPicker}
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f9d58",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: openingPicker ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                    }}
                  >
                    <span>{openingPicker ? "Opening Google Drive..." : "Choose Google Sheet from Drive"}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Client View: Primary Save Button once sheet is selected */}
          {isClientView && isConnected && isSheetSelected && Boolean(url?.trim()) && (
            <div style={{ marginBottom: "16px" }}>
              <button
                type="button"
                onClick={handleClientSave}
                disabled={linking || !url.trim()}
                style={{
                  width: "100%",
                  padding: "11px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#0f9d58",
                  color: "#ffffff",
                  fontSize: "13.5px",
                  fontWeight: "600",
                  cursor: linking || !url.trim() ? "not-allowed" : "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                  opacity: !url.trim() ? 0.6 : 1
                }}
              >
                {linking ? "Saving..." : "Complete connection"}
              </button>
            </div>
          )}

          {/* Loading Spreadsheet Structure (PMA View) */}
          {isWaitingForInspection && (
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "28px 16px",
                marginBottom: "18px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                textAlign: "center"
              }}
            >
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  border: "3px solid #cbd5e1",
                  borderTopColor: "#0f9d58",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite"
                }}
              />
              <div>
                <div style={{ fontSize: "13.5px", fontWeight: "600", color: "#0f172a", marginBottom: "4px" }}>
                  Reading spreadsheet structure...
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", maxWidth: "400px", lineHeight: "1.4" }}>
                  Accessing worksheets, discovering header columns, and preparing field mapping suggestions.
                </div>
              </div>
            </div>
          )}

          {/* 3. Inspection Results (Tabs + Header Row + Mapping) */}
          {!isClientView && inspectionData && (
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "16px",
                marginBottom: "18px"
              }}
            >
              <h4 style={{ margin: "0 0 12px 0", fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                3. Choose tab
              </h4>

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
                        {t.title}
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
                        color: inspecting ? "#94a3b8" : "#475569",
                        cursor: inspecting ? "wait" : "pointer",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {inspecting ? "Reading..." : "Update"}
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

                  {/* Deal value or revenue */}
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#334155", marginBottom: "3px" }}>
                      Deal value or revenue
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
        </div>
      </div>
    </div>
  );
}
