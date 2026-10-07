import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function IntegrationsView({
  allOutgoingsClients = [],
  user
}) {
  const [selectedClientName, setSelectedClientName] = useState("");
  const [clientStatus, setClientStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [brokerTestResult, setBrokerTestResult] = useState(null);
  const [brokerTesting, setBrokerTesting] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [switchingTenant, setSwitchingTenant] = useState(false);
  const [qbActionLoading, setQbActionLoading] = useState(false);
  const [qbBrokerTestResult, setQbBrokerTestResult] = useState(null);
  const [qbBrokerTesting, setQbBrokerTesting] = useState(false);

  const [mondayActionLoading, setMondayActionLoading] = useState(false);
  const [mondayBrokerTestResult, setMondayBrokerTestResult] = useState(null);
  const [mondayBrokerTesting, setMondayBrokerTesting] = useState(false);

  const [pipedriveActionLoading, setPipedriveActionLoading] = useState(false);
  const [pipedriveBrokerTestResult, setPipedriveBrokerTestResult] = useState(null);
  const [pipedriveBrokerTesting, setPipedriveBrokerTesting] = useState(false);

  const [clickupActionLoading, setClickupActionLoading] = useState(false);
  const [clickupBrokerTestResult, setClickupBrokerTestResult] = useState(null);
  const [clickupBrokerTesting, setClickupBrokerTesting] = useState(false);

  const [capsuleActionLoading, setCapsuleActionLoading] = useState(false);
  const [capsuleBrokerTestResult, setCapsuleBrokerTestResult] = useState(null);
  const [capsuleBrokerTesting, setCapsuleBrokerTesting] = useState(false);

  const [closeActionLoading, setCloseActionLoading] = useState(false);
  const [closeBrokerTestResult, setCloseBrokerTestResult] = useState(null);
  const [closeBrokerTesting, setCloseBrokerTesting] = useState(false);

  const [hubspotActionLoading, setHubspotActionLoading] = useState(false);
  const [hubspotBrokerTestResult, setHubspotBrokerTestResult] = useState(null);
  const [hubspotBrokerTesting, setHubspotBrokerTesting] = useState(false);

  const [sharedXero, setSharedXero] = useState(null);

  // Initialize selected client to first client in list if available
  useEffect(() => {
    if (allOutgoingsClients.length > 0 && !selectedClientName) {
      // Prefer APPTEST or first client
      const testClient = allOutgoingsClients.find(c => c.clientName?.toUpperCase().includes("TEST")) || allOutgoingsClients[0];
      setSelectedClientName(testClient.clientName);
    }
  }, [allOutgoingsClients, selectedClientName]);

  // Read URL query parameters on return from OAuth
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const integration = urlParams.get("integration");
      const status = urlParams.get("status");
      const tenant = urlParams.get("tenant");
      const company = urlParams.get("company");
      const account = urlParams.get("account");
      const workspace = urlParams.get("workspace");
      const site = urlParams.get("site");
      const org = urlParams.get("org");
      const portal = urlParams.get("portal");
      const errorMsg = urlParams.get("message") || urlParams.get("error");
      const clientParam = urlParams.get("client");

      if (clientParam) {
        setSelectedClientName(clientParam);
      }

      if (integration === "xero") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Xero for ${clientParam || "client"}${tenant ? ` (${tenant})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Xero connection failed: ${errorMsg}` : "Xero connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("tenant");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "quickbooks") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected QuickBooks for ${clientParam || "client"}${company ? ` (${company})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `QuickBooks connection failed: ${errorMsg}` : "QuickBooks connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("company");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "monday") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Monday.com for ${clientParam || "client"}${account ? ` (${account})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Monday.com connection failed: ${errorMsg}` : "Monday.com connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("account");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "pipedrive") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Pipedrive for ${clientParam || "client"}${company ? ` (${company})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Pipedrive connection failed: ${errorMsg}` : "Pipedrive connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("company");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "clickup") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected ClickUp for ${clientParam || "client"}${workspace ? ` (${workspace})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `ClickUp connection failed: ${errorMsg}` : "ClickUp connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("workspace");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "capsule") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Capsule CRM for ${clientParam || "client"}${site ? ` (${site})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Capsule connection failed: ${errorMsg}` : "Capsule connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("site");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "close") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected Close CRM for ${clientParam || "client"}${org ? ` (${org})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Close connection failed: ${errorMsg}` : "Close connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("org");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      } else if (integration === "hubspot") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected HubSpot for ${clientParam || "client"}${portal ? ` (${portal})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `HubSpot connection failed: ${errorMsg}` : "HubSpot connection was cancelled or denied."
          });
        }
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("portal");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      }
    }
  }, []);

  const selectedClient = allOutgoingsClients.find(c => c.clientName === selectedClientName) || null;

  // Fetch integration statuses for the selected client
  const fetchStatus = useCallback(async () => {
    if (!selectedClientName && !selectedClient?.masterSheetId) return;
    setStatusLoading(true);
    setBrokerTestResult(null);
    setQbBrokerTestResult(null);
    setMondayBrokerTestResult(null);
    setPipedriveBrokerTestResult(null);
    setClickupBrokerTestResult(null);
    setCapsuleBrokerTestResult(null);
    setCloseBrokerTestResult(null);
    setHubspotBrokerTestResult(null);
    try {
      const q = new URLSearchParams();
      if (selectedClientName) q.set("clientKey", selectedClientName);
      if (selectedClient?.masterSheetId) q.set("masterSheetId", selectedClient.masterSheetId);

      const res = await fetch(`/api/integrations/status?${q.toString()}`);
      const data = await res.json();
      if (data.success) {
        setClientStatus(data.integrations || {});
        setSharedXero(data.sharedXero || null);
      } else {
        setClientStatus({});
        setSharedXero(null);
      }
    } catch (err) {
      console.error("Failed to load integrations status:", err);
      setClientStatus({});
      setSharedXero(null);
    } finally {
      setStatusLoading(false);
    }
  }, [selectedClientName, selectedClient]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Connect Central Advisor Xero Account
  const handleConnectAdvisorXero = () => {
    const params = new URLSearchParams({
      clientKey: "advisor",
      clientName: "Advisor Account",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName || "")}`
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  // Initiate OAuth flow
  // Initiate OAuth flow (advisor or dedicated)
  const handleConnectXero = (mode = "advisor") => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      mode,
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  // Disconnect & revoke / Unlink
  const handleDisconnectXero = async () => {
    const isShared = Boolean(xero.isSharedGrant);
    const confirmMsg = isShared
      ? `Are you sure you want to unlink ${selectedClientName} from the Central Advisor Account? This will NOT affect your central advisor account or other connected clients.`
      : `Are you sure you want to disconnect Xero for ${selectedClientName}? Tokens will be revoked with Xero and purged from the Vault.`;
    if (!confirm(confirmMsg)) {
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch("/api/integrations/xero/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: "info",
          message: isShared
            ? `${selectedClientName} unlinked from Central Advisor Account.`
            : `Xero disconnected and revoked for ${selectedClientName}.`
        });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setActionLoading(false);
    }
  };

  // Test live token broker
  const handleTestTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setBrokerTesting(true);
    setBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=xero&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setBrokerTestResult(data);
    } catch (err) {
      setBrokerTestResult({ success: false, error: err.message });
    } finally {
      setBrokerTesting(false);
    }
  };

  // Initiate QuickBooks OAuth flow
  const handleConnectQB = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/quickbooks/connect?${params.toString()}`;
  };

  // Disconnect & revoke QuickBooks
  const handleDisconnectQB = async () => {
    if (!confirm(`Are you sure you want to disconnect QuickBooks for ${selectedClientName}? Tokens will be revoked with Intuit and purged from the Vault.`)) {
      return;
    }
    setQbActionLoading(true);
    try {
      const res = await fetch("/api/integrations/quickbooks/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `QuickBooks disconnected and revoked for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setQbActionLoading(false);
    }
  };

  // Test live QuickBooks token broker
  const handleTestQBTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setQbBrokerTesting(true);
    setQbBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=quickbooks&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setQbBrokerTestResult(data);
    } catch (err) {
      setQbBrokerTestResult({ success: false, error: err.message });
    } finally {
      setQbBrokerTesting(false);
    }
  };

  // Initiate Monday.com OAuth flow
  const handleConnectMonday = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/monday/connect?${params.toString()}`;
  };

  // Disconnect & revoke Monday.com
  const handleDisconnectMonday = async () => {
    if (!confirm(`Are you sure you want to disconnect Monday.com for ${selectedClientName}? Tokens will be purged from the Vault.`)) {
      return;
    }
    setMondayActionLoading(true);
    try {
      const res = await fetch("/api/integrations/monday/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Monday.com disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setMondayActionLoading(false);
    }
  };

  // Test live Monday.com token broker
  const handleTestMondayTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setMondayBrokerTesting(true);
    setMondayBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=monday&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setMondayBrokerTestResult(data);
    } catch (err) {
      setMondayBrokerTestResult({ success: false, error: err.message });
    } finally {
      setMondayBrokerTesting(false);
    }
  };

  // Initiate Pipedrive OAuth flow
  const handleConnectPipedrive = () => {
    if (!selectedClientName) {
      alert("Please select a client first.");
      return;
    }
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/pipedrive/connect?${params.toString()}`;
  };

  // Disconnect & revoke Pipedrive
  const handleDisconnectPipedrive = async () => {
    if (!confirm(`Are you sure you want to disconnect Pipedrive for ${selectedClientName}? Tokens will be revoked with Pipedrive and purged from the Vault.`)) {
      return;
    }
    setPipedriveActionLoading(true);
    try {
      const res = await fetch("/api/integrations/pipedrive/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClientName,
          masterSheetId: selectedClient?.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Pipedrive disconnected and revoked for ${selectedClientName}.` });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setPipedriveActionLoading(false);
    }
  };

  // Test live Pipedrive token broker
  const handleTestPipedriveTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) {
      alert("No Master Sheet ID found for this client.");
      return;
    }
    setPipedriveBrokerTesting(true);
    setPipedriveBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=pipedrive&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setPipedriveBrokerTestResult(data);
    } catch (err) {
      setPipedriveBrokerTestResult({ success: false, error: err.message });
    } finally {
      setPipedriveBrokerTesting(false);
    }
  };

  // ClickUp
  const handleConnectClickUp = () => {
    if (!selectedClientName) return alert("Please select a client first.");
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/clickup/connect?${params.toString()}`;
  };

  const handleDisconnectClickUp = async () => {
    if (!confirm(`Are you sure you want to disconnect ClickUp for ${selectedClientName}? Tokens will be purged from the Vault.`)) return;
    setClickupActionLoading(true);
    try {
      const res = await fetch("/api/integrations/clickup/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: selectedClientName, masterSheetId: selectedClient?.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `ClickUp disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
    } catch (err) { setFeedback({ type: "error", message: err.message }); }
    finally { setClickupActionLoading(false); }
  };

  const handleTestClickUpTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) return alert("No Master Sheet ID found for this client.");
    setClickupBrokerTesting(true);
    setClickupBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=clickup&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setClickupBrokerTestResult(data);
    } catch (err) { setClickupBrokerTestResult({ success: false, error: err.message }); }
    finally { setClickupBrokerTesting(false); }
  };

  // Capsule CRM
  const handleConnectCapsule = () => {
    if (!selectedClientName) return alert("Please select a client first.");
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/capsule/connect?${params.toString()}`;
  };

  const handleDisconnectCapsule = async () => {
    if (!confirm(`Are you sure you want to disconnect Capsule CRM for ${selectedClientName}? Tokens will be purged from the Vault.`)) return;
    setCapsuleActionLoading(true);
    try {
      const res = await fetch("/api/integrations/capsule/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: selectedClientName, masterSheetId: selectedClient?.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Capsule CRM disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
    } catch (err) { setFeedback({ type: "error", message: err.message }); }
    finally { setCapsuleActionLoading(false); }
  };

  const handleTestCapsuleTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) return alert("No Master Sheet ID found for this client.");
    setCapsuleBrokerTesting(true);
    setCapsuleBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=capsule&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setCapsuleBrokerTestResult(data);
    } catch (err) { setCapsuleBrokerTestResult({ success: false, error: err.message }); }
    finally { setCapsuleBrokerTesting(false); }
  };

  // Close CRM
  const handleConnectClose = () => {
    if (!selectedClientName) return alert("Please select a client first.");
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/close/connect?${params.toString()}`;
  };

  const handleDisconnectClose = async () => {
    if (!confirm(`Are you sure you want to disconnect Close CRM for ${selectedClientName}? Tokens will be purged from the Vault.`)) return;
    setCloseActionLoading(true);
    try {
      const res = await fetch("/api/integrations/close/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: selectedClientName, masterSheetId: selectedClient?.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `Close CRM disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
    } catch (err) { setFeedback({ type: "error", message: err.message }); }
    finally { setCloseActionLoading(false); }
  };

  const handleTestCloseTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) return alert("No Master Sheet ID found for this client.");
    setCloseBrokerTesting(true);
    setCloseBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=close&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setCloseBrokerTestResult(data);
    } catch (err) { setCloseBrokerTestResult({ success: false, error: err.message }); }
    finally { setCloseBrokerTesting(false); }
  };

  // HubSpot CRM
  const handleConnectHubSpot = () => {
    if (!selectedClientName) return alert("Please select a client first.");
    const params = new URLSearchParams({
      clientKey: selectedClientName,
      clientName: selectedClientName,
      masterSheetId: selectedClient?.masterSheetId || "",
      clientSheetId: selectedClient?.clientSheetId || "",
      redirectBack: `/PMA?nav=integrations&client=${encodeURIComponent(selectedClientName)}`
    });
    window.location.href = `/api/integrations/hubspot/connect?${params.toString()}`;
  };

  const handleDisconnectHubSpot = async () => {
    if (!confirm(`Are you sure you want to disconnect HubSpot for ${selectedClientName}? Tokens will be purged from the Vault.`)) return;
    setHubspotActionLoading(true);
    try {
      const res = await fetch("/api/integrations/hubspot/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: selectedClientName, masterSheetId: selectedClient?.masterSheetId })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `HubSpot disconnected for ${selectedClientName}.` });
        await fetchStatus();
      } else setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
    } catch (err) { setFeedback({ type: "error", message: err.message }); }
    finally { setHubspotActionLoading(false); }
  };

  const handleTestHubSpotTokenBroker = async () => {
    if (!selectedClient?.masterSheetId) return alert("No Master Sheet ID found for this client.");
    setHubspotBrokerTesting(true);
    setHubspotBrokerTestResult(null);
    try {
      const res = await fetch(`/api/integrations/token?tool=hubspot&spreadsheetId=${encodeURIComponent(selectedClient.masterSheetId)}`);
      const data = await res.json();
      setHubspotBrokerTestResult(data);
    } catch (err) { setHubspotBrokerTestResult({ success: false, error: err.message }); }
    finally { setHubspotBrokerTesting(false); }
  };

  const xero = clientStatus?.xero || {};
  const isXeroConnected = Boolean(xero.connected);
  const qb = clientStatus?.quickbooks || {};
  const isQBConnected = Boolean(qb.connected);
  const monday = clientStatus?.monday || {};
  const isMondayConnected = Boolean(monday.connected);
  const pipedrive = clientStatus?.pipedrive || {};
  const isPipedriveConnected = Boolean(pipedrive.connected);
  const clickup = clientStatus?.clickup || {};
  const isClickUpConnected = Boolean(clickup.connected);
  const capsule = clientStatus?.capsule || {};
  const isCapsuleConnected = Boolean(capsule.connected);
  const close = clientStatus?.close || {};
  const isCloseConnected = Boolean(close.connected);
  const hubspot = clientStatus?.hubspot || {};
  const isHubSpotConnected = Boolean(hubspot.connected);

  // Sync selectedTenantId when clientStatus updates
  useEffect(() => {
    if (xero?.tenantId) {
      setSelectedTenantId(xero.tenantId);
    }
  }, [xero?.tenantId]);

  // Handle switching active Xero tenant/organisation or linking existing tenant
  const handleSwitchTenant = async (targetIdOverride) => {
    const tid = targetIdOverride || selectedTenantId;
    if (!tid || !selectedClient) return;
    const allTenants = [...(xero.availableTenants || []), ...(sharedXero?.availableTenants || [])];
    const target = allTenants.find(t => t.tenantId === tid);
    const targetName = target ? target.tenantName : tid;
    setSwitchingTenant(true);
    try {
      const res = await fetch("/api/integrations/set-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          tool: "xero",
          tenantId: tid,
          tenantName: targetName
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: `Active organisation linked to "${targetName}".` });
        fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to switch organisation." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSwitchingTenant(false);
    }
  };

  return (
    <div style={{ padding: "20px 24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Top Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: "700", color: "#0f172a", margin: "0 0 4px 0", display: "flex", alignItems: "center", gap: "8px" }}>
            Third-party integrations
          </h1>
          <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
            Central OAuth vault & token broker management. Test connections and authorise external accounting & CRM platforms.
          </p>
        </div>

        {/* Client Selector Dropdown */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label htmlFor="pma-client-select" style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
            Target Client:
          </label>
          <select
            id="pma-client-select"
            value={selectedClientName}
            onChange={(e) => setSelectedClientName(e.target.value)}
            style={{
              padding: "7px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              fontSize: "13px",
              fontWeight: "600",
              color: "#0f172a",
              background: "#ffffff",
              cursor: "pointer",
              minWidth: "220px",
              outline: "none"
            }}
          >
            {allOutgoingsClients.map((c) => (
              <option key={c.clientName} value={c.clientName}>
                {c.clientName} {c.clientName?.toUpperCase().includes("TEST") ? "🧪" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={fetchStatus}
            title="Refresh status"
            disabled={statusLoading}
            style={{
              padding: "7px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              fontSize: "13px",
              cursor: "pointer",
              color: "#475569"
            }}
          >
            {statusLoading ? "⏳" : "🔄"}
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "10px",
            fontSize: "13px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: feedback.type === "success" ? "#ecfdf5" : feedback.type === "error" ? "#fef2f2" : "#eff6ff",
            color: feedback.type === "success" ? "#065f46" : feedback.type === "error" ? "#991b1b" : "#1e40af",
            border: `1px solid ${feedback.type === "success" ? "#a7f3d0" : feedback.type === "error" ? "#fecaca" : "#bfdbfe"}`
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>{feedback.type === "success" ? "✓" : feedback.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span style={{ fontWeight: "500" }}>{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "700" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Selected Client Workspace Info Card */}
      {selectedClient && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "14px 18px",
            border: "1px solid #e2e8f0",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Client Name
              </span>
              <span style={{ fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
                {selectedClient.clientName}
              </span>
            </div>
            <div style={{ height: "24px", width: "1px", background: "#e2e8f0" }} />
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Master Sheet ID
              </span>
              <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#334155" }}>
                {selectedClient.masterSheetId || "Not mapped"}
              </span>
            </div>
            <div style={{ height: "24px", width: "1px", background: "#e2e8f0" }} />
            <div>
              <span style={{ fontSize: "11px", textTransform: "uppercase", color: "#64748b", fontWeight: "700", display: "block" }}>
                Client Sheet ID
              </span>
              <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#334155" }}>
                {selectedClient.clientSheetId || "Not mapped"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Central Advisor Xero Banner */}
      <div
        style={{
          background: sharedXero?.connected ? "linear-gradient(135deg, #f0fdf4 0%, #ffffff 100%)" : "linear-gradient(135deg, #f8fafc 0%, #ffffff 100%)",
          borderRadius: "14px",
          border: `1px solid ${sharedXero?.connected ? "#bbf7d0" : "#e2e8f0"}`,
          padding: "16px 20px",
          marginBottom: "24px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "14px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px", maxWidth: "800px" }}>
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              background: "rgba(0, 180, 216, 0.12)",
              color: "#00b4d8",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "22px",
              fontWeight: "800",
              flexShrink: 0
            }}
          >
            X
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "4px" }}>
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>
                Central Advisor Xero Account
              </h2>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "2px 9px",
                  borderRadius: "20px",
                  background: sharedXero?.reconnectRequired ? "#fee2e2" : sharedXero?.connected ? "#dcfce7" : "#f1f5f9",
                  color: sharedXero?.reconnectRequired ? "#dc2626" : sharedXero?.connected ? "#15803d" : "#64748b"
                }}
              >
                {sharedXero?.reconnectRequired ? "Re-auth Required" : sharedXero?.connected ? "Active & Auto-refreshing" : "Not Connected"}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "12px", color: "#64748b", lineHeight: "1.4" }}>
              Your advisor account powers multiple client organisations in Pulse through a single consolidated OAuth grant, ensuring tokens refresh smoothly without cross-client session conflicts.
            </p>
            <p style={{ margin: "4px 0 0 0", fontSize: "11px", color: "#0284c7" }}>
              💡 <strong>Note:</strong> Xero authorizes one organisation at a time from their consent dropdown. As you add each client organisation, Pulse accumulates them under this central account without replacing previous ones.
            </p>
            {sharedXero?.connected && sharedXero?.availableTenants && sharedXero.availableTenants.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "600", color: "#475569" }}>
                  Linked Organisations ({sharedXero.availableTenants.length}):
                </span>
                {sharedXero.availableTenants.map((t) => (
                  <span
                    key={t.tenantId}
                    style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "6px",
                      background: "#e0f2fe",
                      color: "#0369a1",
                      fontWeight: "500"
                    }}
                  >
                    {t.tenantName}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <button
            onClick={handleConnectAdvisorXero}
            disabled={actionLoading}
            style={{
              padding: "9px 16px",
              borderRadius: "8px",
              border: "none",
              background: "#00b4d8",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0, 180, 216, 0.2)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              whiteSpace: "nowrap"
            }}
          >
            <span>🔗</span>
            <span>{sharedXero?.connected ? "Re-authorise Advisor Xero" : "Connect Advisor Xero"}</span>
          </button>
        </div>
      </div>

      {/* Main Integration Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "20px", marginBottom: "28px" }}>
        {/* 1. XERO CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(0, 180, 216, 0.12)", color: "#00b4d8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  X
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Xero Accounting</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Financials, Invoices, P&L Sync</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: xero.reconnectRequired ? "#fee2e2" : isXeroConnected ? "#dcfce7" : "#f1f5f9",
                  color: xero.reconnectRequired ? "#dc2626" : isXeroConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading
                  ? "Checking..."
                  : xero.reconnectRequired
                    ? "Re-auth Needed"
                    : isXeroConnected
                      ? (xero.isSharedGrant ? "Connected (Advisor)" : "Connected")
                      : sharedXero?.connected
                        ? "Not in Advisor Grant"
                        : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects this client&apos;s Xero account via OAuth 2.0 with PKCE. Tokens are stored encrypted (AES-256-GCM) in the Redis Vault.
            </p>

            {/* If Client Not Yet in Central Advisor Grant */}
            {!isXeroConnected && sharedXero?.connected && (
              <div style={{ background: "#f0f9ff", borderRadius: "10px", padding: "12px 14px", border: "1px solid #bae6fd", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ fontWeight: "700", color: "#0369a1", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>ℹ️</span> Central Advisor Account Active
                </div>
                <p style={{ margin: "0 0 8px 0", color: "#0c4a6e", lineHeight: "1.4" }}>
                  To link <strong>{selectedClientName}</strong>, click below to authorize this organisation in Xero. It will be added into your Central Advisor grant alongside existing organisations.
                </p>
                {sharedXero?.availableTenants && sharedXero.availableTenants.length > 0 && (
                  <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px dashed #bae6fd" }}>
                    <span style={{ fontSize: "11px", fontWeight: "600", color: "#0369a1", display: "block", marginBottom: "4px" }}>
                      Already authorized in Xero? Link organisation:
                    </span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) handleSwitchTenant(e.target.value);
                        }}
                        style={{
                          flex: 1,
                          padding: "5px 8px",
                          borderRadius: "6px",
                          border: "1px solid #7dd3fc",
                          fontSize: "12px",
                          background: "#fff",
                          color: "#0f172a"
                        }}
                      >
                        <option value="" disabled>Select from {sharedXero.availableTenants.length} authorized org(s)...</option>
                        {sharedXero.availableTenants.map((t) => (
                          <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Connection Details if Connected */}
            {isXeroConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Connection Mode:</span>
                  <span style={{ fontWeight: "600", color: xero.isSharedGrant ? "#0284c7" : "#0f172a" }}>
                    {xero.isSharedGrant ? "Central Advisor Account" : "Dedicated Client Account"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Organisation:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{xero.tenantName || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Tenant ID:</span>
                  <span style={{ fontFamily: "monospace", color: "#334155" }}>{xero.tenantId || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: xero.reconnectRequired ? "#dc2626" : "#15803d" }}>
                    {xero.reconnectRequired ? "Re-authorization Required" : "Connected (Auto-refreshes)"}
                  </span>
                </div>
                {xero.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(xero.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}

                {/* Multi-organisation switcher if user manages multiple Xero orgs */}
                {xero.availableTenants && xero.availableTenants.length > 1 && (
                  <div style={{ marginTop: "12px", paddingTop: "10px", borderTop: "1px dashed #cbd5e1" }}>
                    <label style={{ display: "block", fontSize: "11px", color: "#475569", fontWeight: "700", marginBottom: "5px" }}>
                      Linked Organisation ({xero.availableTenants.length} available):
                    </label>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <select
                        value={selectedTenantId || xero.tenantId}
                        onChange={(e) => setSelectedTenantId(e.target.value)}
                        style={{
                          flex: 1,
                          padding: "6px 8px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          fontSize: "12px",
                          background: "#fff",
                          color: "#0f172a"
                        }}
                      >
                        {xero.availableTenants.map((t) => (
                          <option key={t.tenantId} value={t.tenantId}>
                            {t.tenantName}{t.tenantId === xero.tenantId ? " (Active)" : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleSwitchTenant()}
                        disabled={switchingTenant || selectedTenantId === xero.tenantId}
                        style={{
                          padding: "6px 12px",
                          borderRadius: "6px",
                          border: "none",
                          background: selectedTenantId === xero.tenantId ? "#94a3b8" : "#2563eb",
                          color: "#fff",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: selectedTenantId === xero.tenantId ? "default" : "pointer"
                        }}
                      >
                        {switchingTenant ? "Saving..." : "Switch"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isXeroConnected && !xero.reconnectRequired ? (
                <>
                  <button
                    onClick={handleDisconnectXero}
                    disabled={actionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {actionLoading ? "Processing..." : (xero.isSharedGrant ? "Unlink Organisation" : "Disconnect & Revoke")}
                  </button>
                  <button
                    onClick={handleTestTokenBroker}
                    disabled={brokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {brokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <button
                    onClick={() => handleConnectXero("advisor")}
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      borderRadius: "8px",
                      border: "none",
                      background: xero.reconnectRequired ? "#dc2626" : sharedXero?.connected ? "#0284c7" : "#023f98",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                    }}
                  >
                    {xero.reconnectRequired
                      ? `Re-connect Xero for ${selectedClientName || "Client"}`
                      : sharedXero?.connected
                        ? `🔗 Add ${selectedClientName || "Client"} to Central Advisor Account`
                        : `Connect Xero for ${selectedClientName || "Client"}`}
                  </button>

                  {sharedXero?.connected && !xero.reconnectRequired && (
                    <button
                      onClick={() => handleConnectXero("dedicated")}
                      type="button"
                      style={{
                        background: "none",
                        border: "none",
                        padding: "4px 8px",
                        fontSize: "11px",
                        color: "#64748b",
                        cursor: "pointer",
                        textDecoration: "underline",
                        textAlign: "center"
                      }}
                    >
                      Or connect using client&apos;s own dedicated Xero account
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {brokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: brokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${brokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: brokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {brokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(brokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 2. QUICKBOOKS ONLINE CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(44, 160, 28, 0.12)", color: "#2ca01c", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  Q
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>QuickBooks Online</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Invoices, Outgoings & Expenses</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: qb.reconnectRequired ? "#fee2e2" : isQBConnected ? "#dcfce7" : "#f1f5f9",
                  color: qb.reconnectRequired ? "#dc2626" : isQBConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : qb.reconnectRequired ? "Re-auth Needed" : isQBConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects this client&apos;s QuickBooks account via OAuth 2.0 with PKCE. Tokens are stored encrypted (AES-256-GCM) in the Redis Vault.
            </p>

            {/* Connection Details if Connected */}
            {isQBConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Company Name:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{qb.companyName || qb.tenantName || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Realm ID:</span>
                  <span style={{ fontFamily: "monospace", color: "#334155" }}>{qb.realmId || qb.tenantId || "N/A"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: qb.reconnectRequired ? "#dc2626" : "#15803d" }}>
                    {qb.reconnectRequired ? "Re-authorization Required" : "Connected (Auto-refreshes)"}
                  </span>
                </div>
                {qb.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(qb.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isQBConnected && !qb.reconnectRequired ? (
                <>
                  <button
                    onClick={handleDisconnectQB}
                    disabled={qbActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {qbActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestQBTokenBroker}
                    disabled={qbBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {qbBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectQB}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: qb.reconnectRequired ? "#dc2626" : "#2ca01c",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  {qb.reconnectRequired ? `Re-connect QuickBooks for ${selectedClientName || "Client"}` : `Connect QuickBooks for ${selectedClientName || "Client"}`}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {qbBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: qbBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${qbBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: qbBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {qbBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(qbBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 3. MONDAY.COM CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(97, 97, 255, 0.12)", color: "#6161ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  M
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Monday.com</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Work Management & Boards Sync</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isMondayConnected ? "#dcfce7" : "#f1f5f9",
                  color: isMondayConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isMondayConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Monday.com accounts via OAuth 2.0. Ingests board data and CRM pipelines directly into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isMondayConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Account / Workspace:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{monday.metadata?.accountName || monday.accountName || monday.tenantName || "N/A"}</span>
                </div>
                {monday.metadata?.accountId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Account ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{monday.metadata.accountId}</span>
                  </div>
                )}
                {monday.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{monday.metadata.userName}{monday.metadata.userEmail ? ` (${monday.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: monday.isExpired ? "#b91c1c" : "#15803d" }}>
                    {monday.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {monday.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(monday.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isMondayConnected ? (
                <>
                  <button
                    onClick={handleDisconnectMonday}
                    disabled={mondayActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {mondayActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestMondayTokenBroker}
                    disabled={mondayBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {mondayBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectMonday}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#6161ff",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Monday.com for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {mondayBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: mondayBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${mondayBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: mondayBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {mondayBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(mondayBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 4. PIPEDRIVE CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(0, 194, 97, 0.12)", color: "#00c261", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  P
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Pipedrive CRM</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Deals, Pipelines & Opportunities</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isPipedriveConnected ? "#dcfce7" : "#f1f5f9",
                  color: isPipedriveConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isPipedriveConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Pipedrive CRM via OAuth 2.0. Synchronizes deal values, custom fields, and pipelines into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isPipedriveConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Company:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{pipedrive.metadata?.companyName || pipedrive.companyName || pipedrive.tenantName || "N/A"}</span>
                </div>
                {pipedrive.metadata?.companyId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Company ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{pipedrive.metadata.companyId}</span>
                  </div>
                )}
                {pipedrive.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{pipedrive.metadata.userName}{pipedrive.metadata.userEmail ? ` (${pipedrive.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: pipedrive.isExpired ? "#b91c1c" : "#15803d" }}>
                    {pipedrive.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {pipedrive.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(pipedrive.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isPipedriveConnected ? (
                <>
                  <button
                    onClick={handleDisconnectPipedrive}
                    disabled={pipedriveActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {pipedriveActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestPipedriveTokenBroker}
                    disabled={pipedriveBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {pipedriveBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectPipedrive}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#00c261",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Pipedrive for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {pipedriveBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: pipedriveBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${pipedriveBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: pipedriveBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {pipedriveBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(pipedriveBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 5. CLICKUP CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(123, 104, 238, 0.12)", color: "#7b68ee", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  C
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>ClickUp</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Workspaces, Lists & Task Pipeline</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isClickUpConnected ? "#dcfce7" : "#f1f5f9",
                  color: isClickUpConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isClickUpConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects ClickUp workspaces via OAuth 2.0 or personal token. Synchronizes tasks, custom fields, and pipelines into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isClickUpConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Workspace / Team:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{clickup.metadata?.teamName || clickup.teamName || clickup.companyName || "N/A"}</span>
                </div>
                {clickup.metadata?.teamId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Team ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{clickup.metadata.teamId}</span>
                  </div>
                )}
                {clickup.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{clickup.metadata.userName}{clickup.metadata.userEmail ? ` (${clickup.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: "#15803d" }}>Active</span>
                </div>
                {clickup.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(clickup.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isClickUpConnected ? (
                <>
                  <button
                    onClick={handleDisconnectClickUp}
                    disabled={clickupActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {clickupActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestClickUpTokenBroker}
                    disabled={clickupBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {clickupBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectClickUp}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#7b68ee",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect ClickUp for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {clickupBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: clickupBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${clickupBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: clickupBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {clickupBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(clickupBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 6. CAPSULE CRM CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(26, 76, 110, 0.12)", color: "#1a4c6e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  C
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Capsule CRM</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Contacts, Parties & Opportunities</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isCapsuleConnected ? "#dcfce7" : "#f1f5f9",
                  color: isCapsuleConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isCapsuleConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Capsule CRM via OAuth 2.0. Ingests opportunities, milestones, and expected values into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isCapsuleConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Site Name:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{capsule.metadata?.siteName || capsule.siteName || capsule.tenantName || "N/A"}</span>
                </div>
                {capsule.metadata?.siteUrl && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Site URL:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{capsule.metadata.siteUrl}</span>
                  </div>
                )}
                {capsule.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{capsule.metadata.userName}{capsule.metadata.userEmail ? ` (${capsule.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: capsule.isExpired ? "#b91c1c" : "#15803d" }}>
                    {capsule.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {capsule.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(capsule.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isCapsuleConnected ? (
                <>
                  <button
                    onClick={handleDisconnectCapsule}
                    disabled={capsuleActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {capsuleActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestCapsuleTokenBroker}
                    disabled={capsuleBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {capsuleBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectCapsule}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#1a4c6e",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Capsule CRM for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {capsuleBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: capsuleBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${capsuleBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: capsuleBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {capsuleBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(capsuleBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 7. CLOSE CRM CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(37, 99, 235, 0.12)", color: "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  C
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>Close CRM</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Deals, Leads & Sales Pipelines</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isCloseConnected ? "#dcfce7" : "#f1f5f9",
                  color: isCloseConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isCloseConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects Close CRM via OAuth 2.0 or API key. Pulls active opportunities, deal stages, and values into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isCloseConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Organization:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{close.metadata?.organizationName || close.organizationName || close.tenantName || "N/A"}</span>
                </div>
                {close.metadata?.organizationId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Org ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{close.metadata.organizationId}</span>
                  </div>
                )}
                {close.metadata?.userName && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{close.metadata.userName}{close.metadata.userEmail ? ` (${close.metadata.userEmail})` : ""}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: close.isExpired ? "#b91c1c" : "#15803d" }}>
                    {close.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {close.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(close.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isCloseConnected ? (
                <>
                  <button
                    onClick={handleDisconnectClose}
                    disabled={closeActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {closeActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestCloseTokenBroker}
                    disabled={closeBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {closeBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectClose}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#2563eb",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect Close CRM for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {closeBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: closeBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${closeBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: closeBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {closeBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(closeBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>

        {/* 8. HUBSPOT CRM CARD */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "16px",
            border: "1px solid #e2e8f0",
            padding: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between"
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{ width: "42px", height: "42px", borderRadius: "10px", background: "rgba(255, 122, 89, 0.12)", color: "#ff7a59", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", fontWeight: "700" }}>
                  H
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0f172a" }}>HubSpot CRM</h3>
                  <span style={{ fontSize: "12px", color: "#64748b" }}>Deals, Pipelines & CRM Data</span>
                </div>
              </div>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "700",
                  padding: "3px 10px",
                  borderRadius: "20px",
                  background: isHubSpotConnected ? "#dcfce7" : "#f1f5f9",
                  color: isHubSpotConnected ? "#15803d" : "#64748b"
                }}
              >
                {statusLoading ? "Checking..." : isHubSpotConnected ? "Connected" : "Not Connected"}
              </span>
            </div>

            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5", margin: "0 0 16px 0" }}>
              Connects HubSpot CRM via OAuth 2.0 or Private App token. Ingests deal amounts, pipelines, and stages into DataFromCRM.
            </p>

            {/* Connection Details if Connected */}
            {isHubSpotConnected && (
              <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "12px 14px", border: "1px solid #e2e8f0", marginBottom: "16px", fontSize: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Portal / Account:</span>
                  <span style={{ fontWeight: "600", color: "#0f172a" }}>{hubspot.metadata?.accountName || hubspot.accountName || hubspot.tenantName || "N/A"}</span>
                </div>
                {hubspot.metadata?.portalId && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Portal ID:</span>
                    <span style={{ fontFamily: "monospace", color: "#334155" }}>{hubspot.metadata.portalId}</span>
                  </div>
                )}
                {hubspot.metadata?.userEmail && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                    <span style={{ color: "#64748b" }}>Authorized By:</span>
                    <span style={{ color: "#334155" }}>{hubspot.metadata.userEmail}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                  <span style={{ color: "#64748b" }}>Token Status:</span>
                  <span style={{ fontWeight: "600", color: hubspot.isExpired ? "#b91c1c" : "#15803d" }}>
                    {hubspot.isExpired ? "Expired (Auto-refreshes on query)" : "Active"}
                  </span>
                </div>
                {hubspot.lastRefreshedAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                    <span style={{ color: "#334155" }}>{new Date(hubspot.lastRefreshedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
              {isHubSpotConnected ? (
                <>
                  <button
                    onClick={handleDisconnectHubSpot}
                    disabled={hubspotActionLoading}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {hubspotActionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
                  </button>
                  <button
                    onClick={handleTestHubSpotTokenBroker}
                    disabled={hubspotBrokerTesting}
                    style={{
                      flex: 1,
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: "none",
                      background: "#0f172a",
                      color: "#fff",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    {hubspotBrokerTesting ? "Testing..." : "⚡ Test Token Broker"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnectHubSpot}
                  style={{
                    width: "100%",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#ff7a59",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)"
                  }}
                >
                  Connect HubSpot for {selectedClientName || "Client"}
                </button>
              )}
            </div>

            {/* Token Broker Live Test Output */}
            {hubspotBrokerTestResult && (
              <div
                style={{
                  marginTop: "14px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  background: hubspotBrokerTestResult.success ? "#f0fdf4" : "#fef2f2",
                  border: `1px solid ${hubspotBrokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
                  color: hubspotBrokerTestResult.success ? "#166534" : "#991b1b"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "4px" }}>
                  {hubspotBrokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
                </div>
                <div>{JSON.stringify(hubspotBrokerTestResult, null, 2)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Migration / Info Note */}
      <div style={{ background: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "16px 20px" }}>
        <h4 style={{ margin: "0 0 6px 0", fontSize: "14px", fontWeight: "700", color: "#0f172a" }}>
          💡 Migration & Security Architecture
        </h4>
        <p style={{ margin: 0, fontSize: "12.5px", color: "#475569", lineHeight: "1.6" }}>
          This hub completely replaces legacy Google Apps Script Web App links and library tokens. When a client authorizes via this page, tokens are encrypted with AES-256-GCM and stored in Redis. The Master Google Sheet queries <code style={{ background: "#e2e8f0", padding: "2px 5px", borderRadius: "4px" }}>/api/integrations/token</code> during automated runs, ensuring that permanent credentials never leave Pulse.
        </p>
      </div>
    </div>
  );
}
