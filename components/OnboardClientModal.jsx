import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import { toSafeExternalHref, buildConnectionEmailContent } from "../utils/helpers";

export default function OnboardClientModal({ isOpen, onClose, onClientCreated, onGoToChecklist }) {
  const [clientName, setClientName] = useState("");
  const [clientMode, setClientMode] = useState(""); // '' | 'supabase' | 'sheet'
  const [masterMode, setMasterMode] = useState(""); // '' | 'supabase' | 'sheet'
  const [accountingTool, setAccountingTool] = useState("None");
  const [crmTool, setCrmTool] = useState("None");
  const [crmDrives, setCrmDrives] = useState("NA");

  const needsDriveFolder = clientMode === "sheet" || masterMode === "sheet";
  const bothSelected = Boolean(clientMode && masterMode);

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

  // Post-provisioning steps: 'form' | 'client_user' | 'email_preview'
  const [modalStep, setModalStep] = useState("form");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [sendEmailChoice, setSendEmailChoice] = useState(""); // '' | 'yes' | 'no'
  const [savingClientUser, setSavingClientUser] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);

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
    if (isOpen && needsDriveFolder && folderMode === "existing") {
      loadDriveFolders(currentParentId);
    }
  }, [isOpen, needsDriveFolder, folderMode, currentParentId, loadDriveFolders]);

  useEffect(() => {
    if (!isOpen) {
      setClientName("");
      setClientMode("");
      setMasterMode("");
      setAccountingTool("None");
      setCrmTool("None");
      setCrmDrives("NA");
      setFolderMode("create");
      setSelectedFolder(null);
      setManualFolderInput("");
      setError(null);
      setCreatedData(null);
      setCurrentStep("");
      setModalStep("form");
      setContactName("");
      setContactEmail("");
      setSendEmailChoice("");
      setSavingClientUser(false);
      setEmailSubject("");
      setEmailBody("");
      setSendingEmail(false);
    }
  }, [isOpen]);

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

  const finishOnboardingToChecklist = (dataToUse) => {
    if (onGoToChecklist) {
      onGoToChecklist(dataToUse || createdData);
    } else {
      onClose();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!clientName.trim()) {
      setError("Please enter a client name.");
      return;
    }

    if (!clientMode || !masterMode) {
      setError("Please choose where both the client sheet and master sheet should be provisioned.");
      return;
    }

    const effectiveExistingFolder =
      needsDriveFolder && folderMode === "existing"
        ? (manualFolderInput.trim() || selectedFolder?.id || "")
        : "";

    if (needsDriveFolder && folderMode === "existing" && !effectiveExistingFolder) {
      setError("Please select an existing client folder from the picker or paste a folder URL/ID.");
      return;
    }

    setLoading(true);
    setError(null);
    if (!needsDriveFolder) {
      setCurrentStep("Seeding virtual client and master workbooks in Supabase...");
    } else if (folderMode === "existing") {
      setCurrentStep("Provisioning required sheets in existing Google Drive folder...");
    } else {
      setCurrentStep("Creating client folder in Google Drive and provisioning required sheets...");
    }

    try {
      const res = await fetch("/api/setup/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: clientName.trim(),
          clientMode,
          masterMode,
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
      setModalStep("client_user");
      setSendEmailChoice("");
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

  const handleSaveClientUser = async (e) => {
    e.preventDefault();
    if (!contactName.trim()) {
      setError("Please enter the client's name.");
      return;
    }
    const cleanEmail = contactEmail.toLowerCase().trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setError("Please enter a valid client email address.");
      return;
    }
    if (!sendEmailChoice) {
      setError("Please choose whether to send the client an email asking them to connect their tools.");
      return;
    }

    setSavingClientUser(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/client-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_client_user",
          clientName: createdData.clientName,
          contactName: contactName.trim(),
          contactEmail: cleanEmail,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to add client user.");
      }

      if (sendEmailChoice === "yes") {
        const draft = buildConnectionEmailContent({
          contactName: contactName.trim(),
          accountingTool: createdData.accountingTool || accountingTool,
          crmTool: createdData.crmTool || crmTool,
        });
        setEmailSubject(draft.subject);
        setEmailBody(draft.body);
        setModalStep("email_preview");
      } else {
        finishOnboardingToChecklist(createdData);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingClientUser(false);
    }
  };

  const handleSendConnectionEmail = async (e) => {
    e.preventDefault();
    if (!emailSubject.trim()) {
      setError("Please enter an email subject.");
      return;
    }
    if (!emailBody.trim()) {
      setError("Please enter an email message.");
      return;
    }

    setSendingEmail(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/client-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_connection_email",
          clientName: createdData.clientName,
          toEmail: contactEmail.toLowerCase().trim(),
          subject: emailSubject.trim(),
          body: emailBody.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to send email.");
      }
      finishOnboardingToChecklist(createdData);
    } catch (err) {
      setError(err.message);
    } finally {
      setSendingEmail(false);
    }
  };

  const createdSheetUrls = createdData
    ? [createdData.clientUrl, createdData.masterUrl, createdData.reconUrl].filter(Boolean)
    : [];

  const handleOpenSheets = () => {
    createdSheetUrls.forEach((url, idx) => {
      const safeUrl = toSafeExternalHref(url);
      if (!safeUrl || safeUrl === "#") return;
      if (idx === 0) {
        window.open(safeUrl, "_blank", "noopener,noreferrer");
      } else {
        setTimeout(() => window.open(safeUrl, "_blank", "noopener,noreferrer"), idx * 300);
      }
    });
  };

  const isBusy = loading || savingClientUser || sendingEmail;

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
          maxWidth: modalStep === "email_preview" ? "640px" : "580px",
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
              {modalStep === "email_preview"
                ? "Email preview"
                : createdData
                  ? "Client system created"
                  : "Onboard new client"}
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748B" }}>
              {modalStep === "email_preview"
                ? "Review the email asking the client to connect their tools."
                : createdData
                  ? "Add the primary client user and choose whether to send a connection invitation."
                  : "Choose client name, where sheets should be provisioned, and initial tool connections."}
            </p>
          </div>
          {!isBusy && (
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
                {currentStep || "Provisioning workbooks and registering client..."}
              </p>
              <p style={{ marginTop: "12px", fontSize: "11px", color: "#94A3B8" }}>
                This usually takes about 10–15 seconds. Please do not close this window.
              </p>
            </div>
          ) : modalStep === "email_preview" && createdData ? (
            <form onSubmit={handleSendConnectionEmail}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  background: "#F8FAFC",
                  border: "1px solid #E2E8F0",
                  fontSize: "12.5px",
                  color: "#334155",
                  marginBottom: "14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div>
                  <span style={{ fontWeight: "700", color: "#64748B" }}>From:</span>{" "}
                  <span>pulse@pulsedashboard.co.uk</span>
                </div>
                <div>
                  <span style={{ fontWeight: "700", color: "#64748B" }}>To:</span>{" "}
                  <span>{contactEmail.trim()}</span>
                </div>
              </div>

              <div style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  Subject
                </label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  disabled={sendingEmail}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    fontSize: "13px",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                  Message
                </label>
                <textarea
                  rows={14}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  disabled={sendingEmail}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    fontSize: "13px",
                    lineHeight: "1.5",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                    resize: "vertical",
                  }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  disabled={sendingEmail}
                  onClick={() => finishOnboardingToChecklist(createdData)}
                  style={{
                    padding: "9px 18px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    color: "#475569",
                    fontWeight: "600",
                    fontSize: "13px",
                    cursor: sendingEmail ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingEmail}
                  style={{
                    padding: "9px 20px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "13px",
                    cursor: sendingEmail ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  {sendingEmail && <Spinner size={13} color="#FFFFFF" />}
                  <span>{sendingEmail ? "Sending..." : "Send"}</span>
                </button>
              </div>
            </form>
          ) : modalStep === "client_user" && createdData ? (
            <form onSubmit={handleSaveClientUser}>
              <div
                style={{
                  padding: "14px 16px",
                  borderRadius: "10px",
                  background: "#ECFDF5",
                  border: "1px solid #A7F3D0",
                  marginBottom: "16px"
                }}
              >
                <p style={{ margin: "0 0 6px", fontWeight: "700", color: "#065F46", fontSize: "14px" }}>
                  ✓ {createdData.clientName} is ready
                </p>
                <p style={{ margin: 0, color: "#047857", fontSize: "12px", lineHeight: "1.5" }}>
                  Client sheet provisioned in{" "}
                  <b>{createdData.clientMode === "supabase" ? "Supabase" : "Google Sheets"}</b>
                  {" · "}
                  Master sheet provisioned in{" "}
                  <b>{createdData.masterMode === "supabase" ? "Supabase" : "Google Sheets"}</b>.
                  {createdData.requestConnections
                    ? " Setup mode and Request tool connections have been enabled automatically."
                    : " The client is now in setup mode."}
                </p>
              </div>

              {(createdData.folderUrl || createdSheetUrls.length > 0) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center", marginBottom: "18px", padding: "10px 12px", borderRadius: "8px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                  {createdData.folderUrl && (
                    <a
                      href={toSafeExternalHref(createdData.folderUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "12.5px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                    >
                      Open Google Drive folder ↗
                    </a>
                  )}
                  {createdData.clientUrl && (
                    <a
                      href={toSafeExternalHref(createdData.clientUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "12.5px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                    >
                      Open client sheet ↗
                    </a>
                  )}
                  {createdData.masterUrl && (
                    <a
                      href={toSafeExternalHref(createdData.masterUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "12.5px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                    >
                      Open master sheet ↗
                    </a>
                  )}
                  {createdData.reconUrl && (
                    <a
                      href={toSafeExternalHref(createdData.reconUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "12.5px", color: "#0284C7", fontWeight: "600", textDecoration: "none" }}
                    >
                      Open recon sheet ↗
                    </a>
                  )}
                  {createdSheetUrls.length > 1 && (
                    <button
                      type="button"
                      onClick={handleOpenSheets}
                      style={{
                        marginLeft: "auto",
                        padding: "4px 10px",
                        borderRadius: "6px",
                        border: "1px solid #CBD5E1",
                        background: "#FFFFFF",
                        color: "#1E293B",
                        fontWeight: "600",
                        fontSize: "11.5px",
                        cursor: "pointer"
                      }}
                    >
                      Open all {createdSheetUrls.length} sheets
                    </button>
                  )}
                </div>
              )}

              <div style={{ padding: "16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", marginBottom: "18px" }}>
                <div style={{ fontSize: "13.5px", fontWeight: "700", color: "#0F172A", marginBottom: "4px" }}>
                  Add client user
                </div>
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
                  Enter the client contact’s details to add them to Users as a <b>Client user</b> for {createdData.clientName}.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                      Client’s name <span style={{ color: "#DC2626" }}>*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Jane Smith"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      disabled={savingClientUser}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        border: "1px solid #CBD5E1",
                        fontSize: "13px",
                        background: "#FFFFFF",
                        boxSizing: "border-box"
                      }}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                      Email address <span style={{ color: "#DC2626" }}>*</span>
                    </label>
                    <input
                      type="email"
                      placeholder="e.g. jane@acme.com"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      disabled={savingClientUser}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        border: "1px solid #CBD5E1",
                        fontSize: "13px",
                        background: "#FFFFFF",
                        boxSizing: "border-box"
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Would you like to send the client an email asking them to connect their tools? <span style={{ color: "#DC2626" }}>*</span>
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <button
                      type="button"
                      disabled={savingClientUser}
                      onClick={() => setSendEmailChoice("yes")}
                      style={{
                        padding: "9px 12px",
                        borderRadius: "8px",
                        border: sendEmailChoice === "yes" ? "2px solid #023f98" : "1px solid #CBD5E1",
                        background: sendEmailChoice === "yes" ? "#EFF6FF" : "#FFFFFF",
                        color: sendEmailChoice === "yes" ? "#023f98" : "#475569",
                        fontSize: "12.5px",
                        fontWeight: "700",
                        cursor: "pointer"
                      }}
                    >
                      Yes, preview email
                    </button>
                    <button
                      type="button"
                      disabled={savingClientUser}
                      onClick={() => setSendEmailChoice("no")}
                      style={{
                        padding: "9px 12px",
                        borderRadius: "8px",
                        border: sendEmailChoice === "no" ? "2px solid #023f98" : "1px solid #CBD5E1",
                        background: sendEmailChoice === "no" ? "#EFF6FF" : "#FFFFFF",
                        color: sendEmailChoice === "no" ? "#023f98" : "#475569",
                        fontSize: "12.5px",
                        fontWeight: "700",
                        cursor: "pointer"
                      }}
                    >
                      No, skip email
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="submit"
                  disabled={savingClientUser}
                  style={{
                    flex: 1,
                    padding: "10px 18px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "13px",
                    cursor: savingClientUser ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px"
                  }}
                >
                  {savingClientUser && <Spinner size={13} color="#FFFFFF" />}
                  <span>
                    {savingClientUser
                      ? "Saving client user..."
                      : sendEmailChoice === "yes"
                        ? "Add user & preview email →"
                        : "Add user & go to setup process →"}
                  </span>
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* 1. Client Name */}
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

              {/* 2. Provisioning Locations: Client & Master */}
              <div style={{ marginBottom: "16px", padding: "14px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "4px" }}>
                  Where should the sheets be provisioned? <span style={{ color: "#DC2626" }}>*</span>
                </div>
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
                  Choose Supabase or Google Sheets for each layer. You can change this later in the DB screen if Google Sheets exist.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  {/* Client sheet location */}
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                      Client sheet
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                      <button
                        type="button"
                        onClick={() => setClientMode("supabase")}
                        style={{
                          padding: "8px 10px",
                          borderRadius: "7px",
                          border: clientMode === "supabase" ? "2px solid #166534" : "1px solid #CBD5E1",
                          background: clientMode === "supabase" ? "#ECFDF5" : "#FFFFFF",
                          color: clientMode === "supabase" ? "#166534" : "#475569",
                          fontSize: "12px",
                          fontWeight: "700",
                          cursor: "pointer"
                        }}
                      >
                        Supabase
                      </button>
                      <button
                        type="button"
                        onClick={() => setClientMode("sheet")}
                        style={{
                          padding: "8px 10px",
                          borderRadius: "7px",
                          border: clientMode === "sheet" ? "2px solid #023f98" : "1px solid #CBD5E1",
                          background: clientMode === "sheet" ? "#EFF6FF" : "#FFFFFF",
                          color: clientMode === "sheet" ? "#023f98" : "#475569",
                          fontSize: "12px",
                          fontWeight: "700",
                          cursor: "pointer"
                        }}
                      >
                        Google Sheets
                      </button>
                    </div>
                  </div>

                  {/* Master sheet location */}
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                      Master sheet
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                      <button
                        type="button"
                        onClick={() => setMasterMode("supabase")}
                        style={{
                          padding: "8px 10px",
                          borderRadius: "7px",
                          border: masterMode === "supabase" ? "2px solid #166534" : "1px solid #CBD5E1",
                          background: masterMode === "supabase" ? "#ECFDF5" : "#FFFFFF",
                          color: masterMode === "supabase" ? "#166534" : "#475569",
                          fontSize: "12px",
                          fontWeight: "700",
                          cursor: "pointer"
                        }}
                      >
                        Supabase
                      </button>
                      <button
                        type="button"
                        onClick={() => setMasterMode("sheet")}
                        style={{
                          padding: "8px 10px",
                          borderRadius: "7px",
                          border: masterMode === "sheet" ? "2px solid #023f98" : "1px solid #CBD5E1",
                          background: masterMode === "sheet" ? "#EFF6FF" : "#FFFFFF",
                          color: masterMode === "sheet" ? "#023f98" : "#475569",
                          fontSize: "12px",
                          fontWeight: "700",
                          cursor: "pointer"
                        }}
                      >
                        Google Sheets
                      </button>
                    </div>
                  </div>
                </div>

                {bothSelected && !needsDriveFolder && (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      background: "#ECFDF5",
                      border: "1px solid #A7F3D0",
                      fontSize: "12px",
                      color: "#065F46"
                    }}
                  >
                    Both Client and Master engines will be provisioned directly in Supabase. No Google Drive folder or Google Sheets will be created.
                  </div>
                )}
              </div>

              {/* 3. Client Google Drive Folder Option (ONLY shown when at least one sheet is Google Sheets) */}
              {needsDriveFolder && (
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                    Client Google Drive folder <span style={{ color: "#DC2626" }}>*</span>
                  </label>
                  <p style={{ margin: "0 0 8px", fontSize: "11.5px", color: "#64748B" }}>
                    {clientMode === "sheet" && masterMode === "sheet"
                      ? "Client, Master, Recon, and Backup spreadsheets will be created in this folder."
                      : clientMode === "sheet"
                        ? "Only the Client dashboard spreadsheet will be created in this folder (Master & Recon will be provisioned in Supabase)."
                        : "Master, Recon, and Backup spreadsheets will be created in this folder (Client portal will be provisioned in Supabase)."}
                  </p>
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
                        <DeferredSearchInput
                          type="text"
                          placeholder="Filter folders..."
                          value={folderSearch}
                          onChange={(e) => setFolderSearch(e.target.value)}
                          showClearButton
                          spinnerSize={11}
                          spinnerRight="6px"
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
              )}

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
