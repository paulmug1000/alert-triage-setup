import React, { useState } from "react";
import Spinner from "./Spinner";

export default function OnboardClientModal({ isOpen, onClose, onClientCreated }) {
  const [clientName, setClientName] = useState("");
  const [accountingTool, setAccountingTool] = useState("None");
  const [crmTool, setCrmTool] = useState("None");
  const [crmDrives, setCrmDrives] = useState("NA");
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const [error, setError] = useState(null);
  const [createdData, setCreatedData] = useState(null);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!clientName.trim()) {
      setError("Please enter a client name.");
      return;
    }

    setLoading(true);
    setError(null);
    setCurrentStep("Creating client folder in Google Drive...");

    try {
      const res = await fetch("/api/setup/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: clientName.trim(),
          accountingTool,
          crmTool,
          crmDrives
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
          maxWidth: "540px",
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
              {createdData ? "Client System Created!" : "➕ Onboard New Client"}
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748B" }}>
              {createdData
                ? "Google Drive folder and templates provisioned successfully."
                : "Creates Google Drive folder, duplicates templates, and registers in control sheets."}
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
        <div style={{ padding: "24px" }}>
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
              ⚠️ {error}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: "center", padding: "30px 10px" }}>
              <Spinner size={36} color="#023f98" />
              <p style={{ marginTop: "16px", fontWeight: "700", fontSize: "15px", color: "#0F172A" }}>
                Provisioning Client System...
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
                  ✓ {createdData.clientName} is ready!
                </p>
                <p style={{ margin: 0, color: "#047857", fontSize: "12px", lineHeight: "1.5" }}>
                  All 4 spreadsheets have been created inside the Drive folder and cross-linked. The client is now in Setup Mode.
                </p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "24px" }}>
                <a
                  href={createdData.folderUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  📁 Open Google Drive Folder ↗
                </a>
                <a
                  href={createdData.clientUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  📊 Open Client Dashboard Sheet ↗
                </a>
                <a
                  href={createdData.masterUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  ⚙️ Open Master Data Engine Sheet ↗
                </a>
                <a
                  href={createdData.reconUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                >
                  🔍 Open Recon Sheet ↗
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
                  Open All 3 Sheets
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
                  Go to Onboarding Checklist →
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  Client Name <span style={{ color: "#DC2626" }}>*</span>
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

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Accounting Tool
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
                    CRM Tool
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
                  CRM Integration Type
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

              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  marginBottom: "24px",
                  fontSize: "12px",
                  color: "#64748B"
                }}
              >
                <b>Automated destination:</b> Folder will be created inside the primary <code>Clients</code> Google Drive folder.
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
                  Provision Client System
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
