import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function OnboardClientModal({ isOpen, onClose, onClientCreated }) {
  const [clientName, setClientName] = useState("");
  const [accountingTool, setAccountingTool] = useState("None");
  const [crmTool, setCrmTool] = useState("None");
  const [crmDrives, setCrmDrives] = useState("NA");

  // Folder mode: 'create' | 'existing'
  const [folderMode, setFolderMode] = useState("create");
  const [selectedFolder, setSelectedFolder] = useState(null); // { id, name, webViewLink }
  const [manualFolderInput, setManualFolderInput] = useState("");

  // Folder picker navigation state
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState(null);
  const [foldersList, setFoldersList] = useState([]);
  const [folderSearch, setFolderSearch] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState([
    { id: "16qLMIFy1GyiEZ4DkKjVaFXOKGQKDW8Cj", name: "Clients" }
  ]);

  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const [error, setError] = useState(null);
  const [createdData, setCreatedData] = useState(null);

  const currentParentId = breadcrumbs[breadcrumbs.length - 1]?.id || "16qLMIFy1GyiEZ4DkKjVaFXOKGQKDW8Cj";

  const loadDriveFolders = useCallback(async (parentId) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const res = await fetch(`/api/setup/drive-folders?parentId=${encodeURIComponent(parentId || "")}`);
      const data = await res.json();
      if (data.success) {
        setFoldersList(data.folders || []);
      } else {
        throw new Error(data.error || "Failed to load Drive folders.");
      }
    } catch (err) {
      console.error("Error loading Drive folders:", err);
      setFoldersError(err.message);
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && folderMode === "existing") {
      loadDriveFolders(currentParentId);
    }
  }, [isOpen, folderMode, currentParentId, loadDriveFolders]);

  if (!isOpen) return null;

  const handleNavigateIntoFolder = (folder) => {
    setFolderSearch("");
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index) => {
    setFolderSearch("");
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleSelectFolder = (folder) => {
    setSelectedFolder(folder);
    setManualFolderInput("");
    if (!clientName.trim() && folder?.name) {
      setClientName(folder.name);
    }
  };

  const filteredFolders = foldersList.filter((f) =>
    f.name.toLowerCase().includes(folderSearch.trim().toLowerCase())
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!clientName.trim()) {
      setError("Please enter a client name.");
      return;
    }

    const effectiveExistingFolder =
      folderMode === "existing"
        ? (manualFolderInput.trim() || selectedFolder?.id || "")
        : "";

    if (folderMode === "existing" && !effectiveExistingFolder) {
      setError("Please select an existing client folder from the picker or paste a folder URL/ID.");
      return;
    }

    setLoading(true);
    setError(null);
    setCurrentStep(
      folderMode === "existing"
        ? "Provisioning templates into existing Google Drive folder..."
        : "Creating client folder in Google Drive..."
    );

    try {
      const res = await fetch("/api/setup/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: clientName.trim(),
          accountingTool,
          crmTool,
          crmDrives,
          existingFolderId: effectiveExistingFolder
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to provision client system.");
      }

      setCreatedData(data);
      if (onClientCreated) {
        onClientCreated(data);
      }
    } catch (err) {
      console.error("Provisioning error:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenSheets = () => {
    if (!createdData) return;
    if (createdData.clientUrl) window.open(createdData.clientUrl, "_blank");
    if (createdData.masterUrl) setTimeout(() => window.open(createdData.masterUrl, "_blank"), 300);
    if (createdData.reconUrl) setTimeout(() => window.open(createdData.reconUrl, "_blank"), 600);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
    >
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: "16px",
          width: "100%",
          maxWidth: "580px",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          border: "1px solid #E2E8F0",
          overflow: "hidden"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "#F8FAFC"
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
              {createdData ? "Client system created" : "Onboard new client"}
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748B" }}>
              {createdData
                ? "Google Drive folder and templates provisioned successfully."
                : "Create or select a Google Drive folder, duplicate templates, and register in control sheets."}
            </p>
          </div>
          {!loading && (
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                fontSize: "20px",
                color: "#94A3B8",
                cursor: "pointer",
                padding: "4px 8px",
                borderRadius: "6px"
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Content */}
        <div style={{ padding: "24px", overflowY: "auto" }}>
          {error && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "8px",
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#991B1B",
                fontSize: "13px",
                fontWeight: "500",
                marginBottom: "20px"
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: "center", padding: "30px 10px" }}>
              <Spinner size={36} color="#023f98" />
              <p style={{ marginTop: "16px", fontWeight: "700", fontSize: "15px", color: "#0F172A" }}>
                Provisioning client system...
              </p>
              <p style={{ marginTop: "4px", fontSize: "13px", color: "#64748B" }}>
                {currentStep || "Duplicating templates and updating KeyInfo links..."}
              </p>
              <p style={{ marginTop: "12px", fontSize: "11px", color: "#94A3B8" }}>
                This usually takes about 10–15 seconds. Please do not close this window.
              </p>
            </div>
          ) : createdData ? (
            <div>
              <div
                style={{
                  padding: "16px",
                  borderRadius: "10px",
                  background: "#ECFDF5",
                  border: "1px solid #A7F3D0",
                  marginBottom: "20px"
                }}
              >
                <p style={{ margin: "0 0 6px", fontWeight: "700", color: "#065F46", fontSize: "14px" }}>
                  ✓ {createdData.clientName} is ready
                </p>
                <p style={{ margin: 0, color: "#047857", fontSize: "12px", lineHeight: "1.5" }}>
                  All 4 spreadsheets have been created inside the Drive folder and cross-linked. The client is now in setup mode.
                </p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "24px" }}>
                <a
                  href={createdData.folderUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  Open Google Drive folder ↗
                </a>
                <a
                  href={createdData.clientUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  Open client dashboard sheet ↗
                </a>
                <a
                  href={createdData.masterUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  Open master data engine sheet ↗
                </a>
                <a
                  href={createdData.reconUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  Open recon sheet ↗
                </a>
              </div>

              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  onClick={handleOpenSheets}
                  style={{
                    flex: 1,
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#F8FAFC",
                    color: "#1E293B",
                    fontWeight: "600",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Open all 3 sheets
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    flex: 1,
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Go to onboarding checklist →
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* Client Name */}
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  Client name <span style={{ color: "#DC2626" }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Acme Agency"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    fontSize: "14px",
                    boxSizing: "border-box"
                  }}
                  autoFocus
                />
              </div>

              {/* Client Google Drive Folder Option */}
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  Client Google Drive folder
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "10px" }}>
                  <button
                    type="button"
                    onClick={() => setFolderMode("create")}
                    style={{
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: folderMode === "create" ? "2px solid #023f98" : "1px solid #CBD5E1",
                      background: folderMode === "create" ? "#EFF6FF" : "#FFFFFF",
                      color: folderMode === "create" ? "#023f98" : "#475569",
                      fontSize: "12px",
                      fontWeight: "700",
                      cursor: "pointer",
                      textAlign: "left"
                    }}
                  >
                    Create a new folder
                  </button>
                  <button
                    type="button"
                    onClick={() => setFolderMode("existing")}
                    style={{
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: folderMode === "existing" ? "2px solid #023f98" : "1px solid #CBD5E1",
                      background: folderMode === "existing" ? "#EFF6FF" : "#FFFFFF",
                      color: folderMode === "existing" ? "#023f98" : "#475569",
                      fontSize: "12px",
                      fontWeight: "700",
                      cursor: "pointer",
                      textAlign: "left"
                    }}
                  >
                    Use an existing folder
                  </button>
                </div>

                {folderMode === "create" ? (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: "8px",
                      background: "#F8FAFC",
                      border: "1px solid #E2E8F0",
                      fontSize: "12px",
                      color: "#64748B"
                    }}
                  >
                    A new folder named <b>{clientName.trim() || "<Client name>"}</b> will be created inside the primary <code>Clients</code> Google Drive folder.
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px solid #CBD5E1",
                      borderRadius: "10px",
                      background: "#F8FAFC",
                      padding: "12px"
                    }}
                  >
                    {/* Breadcrumbs & Search */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", fontSize: "12px" }}>
                        {breadcrumbs.map((crumb, idx) => (
                          <React.Fragment key={crumb.id}>
                            {idx > 0 && <span style={{ color: "#94A3B8" }}>/</span>}
                            <button
                              type="button"
                              onClick={() => handleBreadcrumbClick(idx)}
                              style={{
                                background: "transparent",
                                border: "none",
                                padding: "2px 4px",
                                borderRadius: "4px",
                                fontSize: "12px",
                                fontWeight: idx === breadcrumbs.length - 1 ? "700" : "500",
                                color: idx === breadcrumbs.length - 1 ? "#0F172A" : "#0284C7",
                                cursor: "pointer"
                              }}
                            >
                              {crumb.name}
                            </button>
                          </React.Fragment>
                        ))}
                      </div>
                      <input
                        type="text"
                        placeholder="Filter folders..."
                        value={folderSearch}
                        onChange={(e) => setFolderSearch(e.target.value)}
                        style={{
                          padding: "5px 8px",
                          borderRadius: "6px",
                          border: "1px solid #CBD5E1",
                          fontSize: "12px",
                          width: "160px"
                        }}
                      />
                    </div>

                    {/* Folder Picker List */}
                    <div
                      style={{
                        maxHeight: "170px",
                        overflowY: "auto",
                        background: "#FFFFFF",
                        border: "1px solid #E2E8F0",
                        borderRadius: "8px",
                        marginBottom: "10px"
                      }}
                    >
                      {foldersLoading ? (
                        <div style={{ padding: "20px", textAlign: "center", fontSize: "12px", color: "#64748B", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                          <Spinner size={14} color="#023f98" />
                          <span>Loading folders...</span>
                        </div>
                      ) : foldersError ? (
                        <div style={{ padding: "14px", fontSize: "12px", color: "#991B1B" }}>
                          {foldersError}
                        </div>
                      ) : filteredFolders.length === 0 ? (
                        <div style={{ padding: "18px", textAlign: "center", fontSize: "12px", color: "#94A3B8" }}>
                          No folders found in this location.
                        </div>
                      ) : (
                        filteredFolders.map((folder) => {
                          const isSelected = selectedFolder?.id === folder.id && !manualFolderInput.trim();
                          return (
                            <div
                              key={folder.id}
                              onClick={() => handleSelectFolder(folder)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "8px 12px",
                                borderBottom: "1px solid #F1F5F9",
                                background: isSelected ? "#EFF6FF" : "#FFFFFF",
                                cursor: "pointer"
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill={isSelected ? "#023f98" : "#64748B"} stroke="none">
                                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                                </svg>
                                <span
                                  style={{
                                    fontSize: "13px",
                                    fontWeight: isSelected ? "700" : "500",
                                    color: isSelected ? "#023f98" : "#1E293B",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis"
                                  }}
                                >
                                  {folder.name}
                                </span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                {isSelected && (
                                  <span style={{ fontSize: "11px", fontWeight: "700", color: "#023f98" }}>
                                    Selected
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleNavigateIntoFolder(folder);
                                  }}
                                  title="Browse inside this folder"
                                  style={{
                                    padding: "3px 7px",
                                    borderRadius: "4px",
                                    border: "1px solid #CBD5E1",
                                    background: "#F8FAFC",
                                    color: "#475569",
                                    fontSize: "11px",
                                    fontWeight: "600",
                                    cursor: "pointer"
                                  }}
                                >
                                  Browse →
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Selected Folder Summary or Manual Folder URL/ID Input */}
                    {selectedFolder && !manualFolderInput.trim() && (
                      <div style={{ marginBottom: "8px", fontSize: "12px", color: "#065F46", background: "#ECFDF5", border: "1px solid #A7F3D0", padding: "6px 10px", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>
                          Selected folder: <b>{selectedFolder.name}</b>
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedFolder(null)}
                          style={{ background: "transparent", border: "none", color: "#047857", fontSize: "11px", fontWeight: "700", cursor: "pointer" }}
                        >
                          Clear
                        </button>
                      </div>
                    )}

                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748B", marginBottom: "4px" }}>
                        Or paste an existing Google Drive folder URL / ID:
                      </label>
                      <input
                        type="text"
                        placeholder="https://drive.google.com/drive/folders/..."
                        value={manualFolderInput}
                        onChange={(e) => setManualFolderInput(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "7px 10px",
                          borderRadius: "6px",
                          border: "1px solid #CBD5E1",
                          fontSize: "12px",
                          background: "#FFFFFF",
                          boxSizing: "border-box"
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Accounting tool
                  </label>
                  <select
                    value={accountingTool}
                    onChange={(e) => setAccountingTool(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      background: "#FFFFFF",
                      boxSizing: "border-box"
                    }}
                  >
                    <option value="None">None</option>
                    <option value="Xero">Xero</option>
                    <option value="Quickbooks">QuickBooks Online</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    CRM tool
                  </label>
                  <select
                    value={crmTool}
                    onChange={(e) => setCrmTool(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      background: "#FFFFFF",
                      boxSizing: "border-box"
                    }}
                  >
                    <option value="None">None</option>
                    <option value="ClickUp">ClickUp</option>
                    <option value="Close">Close</option>
                    <option value="Capsule">Capsule</option>
                    <option value="HubSpot">HubSpot</option>
                    <option value="Monday">Monday.com</option>
                    <option value="Pipedrive">Pipedrive</option>
                    <option value="Google Sheet">Google Sheet</option>
                    <option value="Excel">Excel</option>
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  CRM integration type
                </label>
                <select
                  value={crmDrives}
                  onChange={(e) => setCrmDrives(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    fontSize: "13px",
                    background: "#FFFFFF",
                    boxSizing: "border-box"
                  }}
                >
                  <option value="NA">NA</option>
                  <option value="Pipeline">Pipeline (Just pipeline)</option>
                  <option value="PipeAndConf">PipeAndConf (Pipeline and confirmed)</option>
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: "9px 16px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    color: "#475569",
                    fontWeight: "600",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: "9px 20px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "13px",
                    cursor: "pointer"
                  }}
                >
                  Provision client system
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
