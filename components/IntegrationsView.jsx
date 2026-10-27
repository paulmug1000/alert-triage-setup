import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import Spinner from "./Spinner";
import Skeleton, { PmaIntegrationsSkeleton } from "./Skeleton";
import GoogleSheetLinkModal from "./integrations/GoogleSheetLinkModal";
import ExcelLinkModal from "./integrations/ExcelLinkModal";

// ============================================================================
// CONFIGURATION & METADATA FOR CRM INTEGRATIONS
// ============================================================================
const CRM_TOOLS_CONFIG = {
  googlesheet: {
    name: "Google Sheet",
    subtitle: "Google Drive & Sheets Ingestion",
    color: "#0f9d58",
    bgColor: "rgba(15, 157, 88, 0.12)",
    icon: "GS",
    description: "Read-only access via Google OAuth 2.0 or Master Sheet bridge. Ingests pipeline, jobs, and deal values safely into DataFromCRM.",
    accountLabel: "Spreadsheet",
    getAccountValue: (m) => m?.spreadsheetName || m?.spreadsheetTitle || m?.accountName,
    idLabel: "Spreadsheet ID",
    getIdValue: (m) => m?.spreadsheetId
  },
  excel: {
    name: "Microsoft Excel",
    subtitle: "OneDrive & SharePoint Workbook",
    color: "#0f6cbd",
    bgColor: "rgba(15, 108, 189, 0.12)",
    icon: "XL",
    description: "Read-only access via Microsoft 365 OAuth 2.0. Ingests workbook tables and ranges safely into DataFromCRM.",
    accountLabel: "Workbook / File",
    getAccountValue: (m) => m?.fileName || m?.workbookName || m?.accountName,
    idLabel: "File ID / Path",
    getIdValue: (m) => m?.fileId || m?.filePath
  },
  clickup: {
    name: "ClickUp",
    subtitle: "Workspaces, Lists & Task Pipeline",
    color: "#7b68ee",
    bgColor: "rgba(123, 104, 238, 0.12)",
    icon: "CU",
    description: "Connects ClickUp workspaces via OAuth 2.0. Synchronizes tasks, custom fields, and pipelines into DataFromCRM.",
    accountLabel: "Workspace / Team",
    getAccountValue: (m) => m?.teamName || m?.companyName,
    idLabel: "Team ID",
    getIdValue: (m) => m?.teamId
  },
  capsule: {
    name: "Capsule CRM",
    subtitle: "Contacts, Parties & Opportunities",
    color: "#1a4c6e",
    bgColor: "rgba(26, 76, 110, 0.12)",
    icon: "C",
    description: "Connects Capsule CRM via OAuth 2.0. Ingests opportunities, milestones, and expected values into DataFromCRM.",
    accountLabel: "Site Name",
    getAccountValue: (m) => m?.siteName || m?.tenantName,
    idLabel: "Site URL",
    getIdValue: (m) => m?.siteUrl
  },
  close: {
    name: "Close CRM",
    subtitle: "Deals, Leads & Sales Pipelines",
    color: "#2563eb",
    bgColor: "rgba(37, 99, 235, 0.12)",
    icon: "CL",
    description: "Connects Close CRM via OAuth 2.0 or API key. Pulls active opportunities, deal stages, and values into DataFromCRM.",
    accountLabel: "Organization",
    getAccountValue: (m) => m?.organizationName || m?.tenantName,
    idLabel: "Org ID",
    getIdValue: (m) => m?.organizationId
  },
  hubspot: {
    name: "HubSpot CRM",
    subtitle: "Deals, Pipelines & CRM Data",
    color: "#ff7a59",
    bgColor: "rgba(255, 122, 89, 0.12)",
    icon: "H",
    description: "Connects HubSpot CRM via OAuth 2.0. Ingests deal amounts, pipelines, and stages into DataFromCRM.",
    accountLabel: "Portal / Account",
    getAccountValue: (m) => m?.accountName || m?.tenantName,
    idLabel: "Portal ID",
    getIdValue: (m) => m?.portalId
  },
  monday: {
    name: "Monday.com",
    subtitle: "Work Management & Boards Sync",
    color: "#6161ff",
    bgColor: "rgba(97, 97, 255, 0.12)",
    icon: "M",
    description: "Connects Monday.com accounts via OAuth 2.0. Ingests board data and CRM pipelines directly into DataFromCRM.",
    accountLabel: "Account / Workspace",
    getAccountValue: (m) => m?.accountName || m?.tenantName,
    idLabel: "Account ID",
    getIdValue: (m) => m?.accountId
  },
  pipedrive: {
    name: "Pipedrive CRM",
    subtitle: "Deals, Pipelines & Opportunities",
    color: "#00c261",
    bgColor: "rgba(0, 194, 97, 0.12)",
    icon: "P",
    description: "Connects Pipedrive CRM via OAuth 2.0. Synchronizes deal values, custom fields, and pipelines into DataFromCRM.",
    accountLabel: "Company",
    getAccountValue: (m) => m?.companyName || m?.tenantName,
    idLabel: "Company ID",
    getIdValue: (m) => m?.companyId
  }
};

// ============================================================================
// HELPER FUNCTIONS: RESOLVE CONFIGURED TOOLS (KEYINFO + FALLBACK)
// ============================================================================
export function getAccountingToolType(toolStr, clientIntegrations) {
  const s = String(toolStr || "").toLowerCase().trim();
  if (s.includes("xero")) return "xero";
  if (s.includes("quickbooks") || s.includes("qb")) return "quickbooks";
  if (!s || s === "none") {
    if (clientIntegrations?.xero?.connected) return "xero";
    if (clientIntegrations?.quickbooks?.connected) return "quickbooks";
    return "none";
  }
  return "none";
}

export function getCrmToolType(toolStr, clientIntegrations) {
  const s = String(toolStr || "").toLowerCase().trim();
  if (s.includes("clickup")) return "clickup";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("close")) return "close";
  if (s.includes("hubspot")) return "hubspot";
  if (s.includes("monday")) return "monday";
  if (s.includes("pipedrive")) return "pipedrive";
  if (s.includes("sheet") || s.includes("google")) return "googlesheet";
  if (s.includes("excel")) return "excel";
  if (!s || s === "none") {
    for (const k of ["googlesheet", "excel", "clickup", "capsule", "close", "hubspot", "monday", "pipedrive"]) {
      if (clientIntegrations?.[k]?.connected) return k;
    }
    return "none";
  }
  return "none";
}

export function calculateIntegrationsAttentionCount(clientsData = [], sharedXero = null, managedClientName = null) {
  if (!Array.isArray(clientsData) || clientsData.length === 0) return 0;
  let list = clientsData;
  if (managedClientName) {
    const target = String(managedClientName).toLowerCase().trim();
    list = list.filter((c) => String(c.clientName || "").toLowerCase().trim() === target);
  }

  let attentionCount = 0;
  for (const c of list) {
    const accTool = getAccountingToolType(c.accountingTool, c.integrations);
    const crmTool = getCrmToolType(c.crmTool, c.integrations);

    const accInt = c.integrations?.[accTool];
    if (accInt?.reconnectRequired) attentionCount++;

    const crmInt = c.integrations?.[crmTool];
    if (crmInt?.reconnectRequired) attentionCount++;
  }

  if (!managedClientName) {
    if (sharedXero?.reconnectRequired) attentionCount++;
  } else {
    const managed = list[0];
    if (managed && managed.integrations?.xero?.isSharedGrant && sharedXero?.reconnectRequired) {
      if (!managed.integrations?.xero?.reconnectRequired) {
        attentionCount++;
      }
    }
  }

  return attentionCount;
}

export default function IntegrationsView({
  allOutgoingsClients = [],
  user,
  isAdmin: propIsAdmin,
  managedClient,
  onClearManagedClient,
  onStatusRefresh
}) {
  const isAdmin = propIsAdmin !== undefined
    ? Boolean(propIsAdmin)
    : Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
  const [clientsData, setClientsData] = useState([]);
  const [sharedXero, setSharedXero] = useState(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);

  // Search & jump navigation
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedClient, setHighlightedClient] = useState(null);

  // Per-client / per-tool action states
  const [actionLoadingMap, setActionLoadingMap] = useState({});
  const [brokerTestingMap, setBrokerTestingMap] = useState({});
  const [brokerResultsMap, setBrokerResultsMap] = useState({});
  const [sourceTestingMap, setSourceTestingMap] = useState({});
  const [sourceResultsMap, setSourceResultsMap] = useState({});
  const [selectedTenantsMap, setSelectedTenantsMap] = useState({});
  const [switchingTenantMap, setSwitchingTenantMap] = useState({});
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [googleSheetModalClient, setGoogleSheetModalClient] = useState(null);
  const [excelModalClient, setExcelModalClient] = useState(null);

  const highlightedRef = useRef(null);
  const onStatusRefreshRef = useRef(onStatusRefresh);
  useEffect(() => {
    onStatusRefreshRef.current = onStatusRefresh;
  }, [onStatusRefresh]);

  // Fetch all clients integration statuses in AutoUpdates order
  const fetchAllStatus = useCallback(async (isSilent = false, forceRefresh = false) => {
    if (!isSilent) setLoading(true);
    try {
      const url = `/api/integrations/status?all=true${forceRefresh ? "&refresh=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setClientsData(data.allClients || []);
        setSharedXero(data.sharedXero || null);
        onStatusRefreshRef.current?.({ allClients: data.allClients || [], sharedXero: data.sharedXero || null });

        // Pre-fill selected tenants for clients that have active Xero tenant
        const initialTenants = {};
        for (const c of (data.allClients || [])) {
          if (c.integrations?.xero?.tenantId) {
            initialTenants[c.clientName] = c.integrations.xero.tenantId;
          }
        }
        setSelectedTenantsMap((prev) => ({ ...initialTenants, ...prev }));
        return data.allClients || [];
      }
      return [];
    } catch (err) {
      console.error("Failed to load multi-client integrations status:", err);
      return [];
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllStatus();
  }, [fetchAllStatus]);

  // Read URL query parameters on return from OAuth redirects
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const integration = urlParams.get("integration");
      const status = urlParams.get("status");
      const clientParam = urlParams.get("client");
      const errorMsg = urlParams.get("message") || urlParams.get("error");
      const tenant = urlParams.get("tenant") || urlParams.get("company") || urlParams.get("workspace") || urlParams.get("site") || urlParams.get("org") || urlParams.get("portal") || urlParams.get("account");

      if (integration) {
        const toolTitle = integration.charAt(0).toUpperCase() + integration.slice(1);
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected ${toolTitle} for ${clientParam || "client"}${tenant ? ` (${tenant})` : ""}!`
          });

          // Automatically re-open the configuration modal for spreadsheet integrations
          if (integration === "googlesheet" || integration === "excel") {
            fetchAllStatus(true, true).then((clientsList) => {
              const target = String(clientParam || "").toLowerCase().trim();
              const matched = (clientsList || []).find((c) => String(c.clientName || "").toLowerCase().trim() === target);
              if (matched) {
                if (integration === "googlesheet") {
                  setGoogleSheetModalClient(matched);
                } else if (integration === "excel") {
                  setExcelModalClient(matched);
                }
              }
            });
          }
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `${toolTitle} connection failed: ${errorMsg}` : `${toolTitle} connection was cancelled or denied.`
          });
        }

        // Clean query parameters from URL
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("tenant");
        urlParams.delete("company");
        urlParams.delete("workspace");
        urlParams.delete("site");
        urlParams.delete("org");
        urlParams.delete("portal");
        urlParams.delete("account");
        urlParams.delete("message");
        urlParams.delete("error");
        urlParams.delete("client");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);

        // Scroll to the targeted client after brief delay
        if (clientParam) {
          setTimeout(() => {
            const el = document.getElementById(`client-section-${encodeURIComponent(clientParam)}`);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              setHighlightedClient(clientParam);
              setTimeout(() => setHighlightedClient(null), 3000);
            }
          }, 400);
        }
      }
    }
  }, []);

  // Jump to specific client
  const handleJumpToClient = (clientName) => {
    if (!clientName) return;
    const el = document.getElementById(`client-section-${encodeURIComponent(clientName)}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightedClient(clientName);
      setTimeout(() => setHighlightedClient(null), 3000);
    }
  };

  // --------------------------------------------------------------------------
  // CENTRAL ADVISOR XERO ACCOUNT ACTIONS
  // --------------------------------------------------------------------------
  const handleConnectAdvisorXero = () => {
    const params = new URLSearchParams({
      clientKey: "advisor",
      clientName: "Advisor Account",
      mode: "advisor",
      redirectBack: "/pma?nav=integrations"
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  // --------------------------------------------------------------------------
  // XERO ACTIONS
  // --------------------------------------------------------------------------
  const handleConnectXero = (client, mode = "advisor") => {
    const params = new URLSearchParams({
      clientKey: client.clientName,
      clientName: client.clientName,
      masterSheetId: client.masterSheetId || "",
      clientSheetId: client.clientSheetId || "",
      mode,
      redirectBack: `/pma?nav=integrations&client=${encodeURIComponent(client.clientName)}`
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  const handleDisconnectXero = async (client) => {
    const xeroData = client.integrations?.xero || {};
    const isShared = Boolean(xeroData.isSharedGrant);
    const confirmMsg = isShared
      ? `Are you sure you want to unlink ${client.clientName} from the Central Advisor Account? This will NOT affect your central advisor account or other connected clients.`
      : `Are you sure you want to disconnect Xero for ${client.clientName}? Tokens will be revoked with Xero and purged from the Vault.`;
    if (!confirm(confirmMsg)) return;

    const key = `${client.clientName}_xero_disconnect`;
    setActionLoadingMap((m) => ({ ...m, [key]: true }));
    try {
      const res = await fetch("/api/integrations/xero/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: client.clientName,
          masterSheetId: client.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: "info",
          message: isShared
            ? `${client.clientName} unlinked from Central Advisor Account.`
            : `Xero disconnected and revoked for ${client.clientName}.`
        });
        await fetchAllStatus(true);
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setActionLoadingMap((m) => ({ ...m, [key]: false }));
    }
  };

  const handleSwitchTenant = async (client, targetTenantId) => {
    const tid = targetTenantId || selectedTenantsMap[client.clientName];
    if (!tid) return;

    const xeroData = client.integrations?.xero || {};
    const allTenants = [...(xeroData.availableTenants || []), ...(sharedXero?.availableTenants || [])];
    const target = allTenants.find((t) => t.tenantId === tid);
    const targetName = target ? target.tenantName : tid;

    setSwitchingTenantMap((m) => ({ ...m, [client.clientName]: true }));
    try {
      const res = await fetch("/api/integrations/set-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: client.clientName,
          masterSheetId: client.masterSheetId,
          tool: "xero",
          tenantId: tid,
          tenantName: targetName
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: `Active organisation for ${client.clientName} linked to "${targetName}".` });
        await fetchAllStatus(true);
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to switch organisation." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSwitchingTenantMap((m) => ({ ...m, [client.clientName]: false }));
    }
  };

  // --------------------------------------------------------------------------
  // QUICKBOOKS ACTIONS
  // --------------------------------------------------------------------------
  const handleConnectQB = (client) => {
    const params = new URLSearchParams({
      clientKey: client.clientName,
      clientName: client.clientName,
      masterSheetId: client.masterSheetId || "",
      clientSheetId: client.clientSheetId || "",
      redirectBack: `/pma?nav=integrations&client=${encodeURIComponent(client.clientName)}`
    });
    window.location.href = `/api/integrations/quickbooks/connect?${params.toString()}`;
  };

  const handleDisconnectQB = async (client) => {
    if (!confirm(`Are you sure you want to disconnect QuickBooks for ${client.clientName}? Tokens will be revoked with Intuit and purged from the Vault.`)) {
      return;
    }
    const key = `${client.clientName}_quickbooks_disconnect`;
    setActionLoadingMap((m) => ({ ...m, [key]: true }));
    try {
      const res = await fetch("/api/integrations/quickbooks/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: client.clientName,
          masterSheetId: client.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `QuickBooks disconnected and revoked for ${client.clientName}.` });
        await fetchAllStatus(true);
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setActionLoadingMap((m) => ({ ...m, [key]: false }));
    }
  };

  // --------------------------------------------------------------------------
  // CRM TOOLS ACTIONS
  // --------------------------------------------------------------------------
  const handleConnectCrm = (client, toolKey) => {
    if (toolKey === "googlesheet") {
      setGoogleSheetModalClient(client);
      return;
    }
    if (toolKey === "excel") {
      setExcelModalClient(client);
      return;
    }
    const params = new URLSearchParams({
      clientKey: client.clientName,
      clientName: client.clientName,
      masterSheetId: client.masterSheetId || "",
      clientSheetId: client.clientSheetId || "",
      redirectBack: `/pma?nav=integrations&client=${encodeURIComponent(client.clientName)}`
    });
    window.location.href = `/api/integrations/${toolKey}/connect?${params.toString()}`;
  };

  const handleConfigureCrm = (client, toolKey) => {
    if (toolKey === "googlesheet") {
      setGoogleSheetModalClient(client);
      return;
    }
    if (toolKey === "excel") {
      setExcelModalClient(client);
      return;
    }
  };

  const handleDisconnectCrm = async (client, toolKey) => {
    const cfg = CRM_TOOLS_CONFIG[toolKey] || { name: toolKey };
    if (!confirm(`Are you sure you want to disconnect ${cfg.name} for ${client.clientName}? Tokens will be purged from the Vault.`)) {
      return;
    }
    const key = `${client.clientName}_${toolKey}_disconnect`;
    setActionLoadingMap((m) => ({ ...m, [key]: true }));
    try {
      const res = await fetch(`/api/integrations/${toolKey}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: client.clientName,
          masterSheetId: client.masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: `${cfg.name} disconnected for ${client.clientName}.` });
        await fetchAllStatus(true);
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setActionLoadingMap((m) => ({ ...m, [key]: false }));
    }
  };

  // --------------------------------------------------------------------------
  // TEST TOKEN BROKER (FOR ANY TOOL)
  // --------------------------------------------------------------------------
  const handleTestToken = async (client, toolKey) => {
    const testKey = `${client.clientName}_${toolKey}`;
    setBrokerTestingMap((m) => ({ ...m, [testKey]: true }));
    setBrokerResultsMap((m) => ({ ...m, [testKey]: null }));
    try {
      const q = new URLSearchParams({
        tool: toolKey,
        clientKey: client.clientName,
        verify: "true"
      });
      if (client.masterSheetId) {
        q.set("spreadsheetId", client.masterSheetId);
      }
      const res = await fetch(`/api/integrations/token?${q.toString()}`);
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error(`Server returned HTTP ${res.status} (${res.statusText || "Error"}): ${rawText.slice(0, 120)}`);
      }
      setBrokerResultsMap((m) => ({ ...m, [testKey]: data }));
      // Automatically refresh statuses so the card badge (and attention count) update in real time
      await fetchAllStatus(true, true);
    } catch (err) {
      setBrokerResultsMap((m) => ({ ...m, [testKey]: { success: false, error: err.message } }));
    } finally {
      setBrokerTestingMap((m) => ({ ...m, [testKey]: false }));
    }
  };

  // --------------------------------------------------------------------------
  // SPREADSHEET SOURCE TEST ACTIONS (Google Sheet / Excel)
  // --------------------------------------------------------------------------
  const handleTestSource = async (client, category, toolName) => {
    const testKey = `${client.clientName}_${category}`;
    setSourceTestingMap((m) => ({ ...m, [testKey]: true }));
    setSourceResultsMap((m) => ({ ...m, [testKey]: null }));
    try {
      const q = new URLSearchParams({
        clientKey: client.clientName,
        masterSheetId: client.masterSheetId || "",
        tool: toolName || "",
        category: String(category).toLowerCase()
      });
      const res = await fetch(`/api/integrations/test-source?${q.toString()}`);
      const data = await res.json();
      setSourceResultsMap((m) => ({ ...m, [testKey]: data }));
    } catch (err) {
      setSourceResultsMap((m) => ({ ...m, [testKey]: { success: false, error: err.message } }));
    } finally {
      setSourceTestingMap((m) => ({ ...m, [testKey]: false }));
    }
  };

  // --------------------------------------------------------------------------
  // LIVE VERIFICATION ACROSS ALL ACTIVE INTEGRATIONS
  // --------------------------------------------------------------------------
  const handleVerifyAllActive = async () => {
    if (verifyingAll) return;
    setVerifyingAll(true);
    setFeedback({ type: "info", message: "Running live API verification probes across all active integration tokens..." });

    try {
      const tasks = [];
      for (const client of clientsData) {
        // Accounting Tool
        const accTool = String(client.accountingTool || "").toLowerCase();
        if ((accTool === "xero" || accTool === "quickbooks" || accTool === "qb") && client.integrations?.[accTool === "qb" ? "quickbooks" : accTool]?.connected) {
          tasks.push({ client, toolKey: accTool === "qb" ? "quickbooks" : accTool, toolName: accTool === "qb" ? "QuickBooks" : (accTool.charAt(0).toUpperCase() + accTool.slice(1)) });
        }
        // CRM Tool
        const crmTool = getCrmToolType(client.crmTool, client.integrations);
        if (CRM_TOOLS_CONFIG[crmTool] && client.integrations?.[crmTool]?.connected) {
          tasks.push({ client, toolKey: crmTool, toolName: CRM_TOOLS_CONFIG[crmTool]?.name || crmTool.toUpperCase() });
        }
      }

      if (tasks.length === 0) {
        setFeedback({ type: "info", message: "No active integrations configured to verify." });
        setVerifyingAll(false);
        return;
      }

      let passed = 0;
      let failed = [];

      await Promise.all(
        tasks.map(async ({ client, toolKey, toolName }) => {
          const testKey = `${client.clientName}_${toolKey}`;
          setBrokerTestingMap((m) => ({ ...m, [testKey]: true }));
          try {
            const q = new URLSearchParams({
              tool: toolKey,
              clientKey: client.clientName,
              verify: "true"
            });
            if (client.masterSheetId) q.set("spreadsheetId", client.masterSheetId);
            const res = await fetch(`/api/integrations/token?${q.toString()}`);
            const data = await res.json();
            setBrokerResultsMap((m) => ({ ...m, [testKey]: data }));
            if (data.verified || (res.ok && data.success)) {
              passed++;
            } else {
              failed.push(`${client.clientName} (${toolName})`);
            }
          } catch (err) {
            setBrokerResultsMap((m) => ({ ...m, [testKey]: { success: false, error: err.message } }));
            failed.push(`${client.clientName} (${toolName})`);
          } finally {
            setBrokerTestingMap((m) => ({ ...m, [testKey]: false }));
          }
        })
      );

      // Re-fetch all statuses so cards update in real time
      await fetchAllStatus(true, true);

      if (failed.length === 0) {
        setFeedback({
          type: "success",
          message: `✓ Successfully verified all ${passed} active integration tokens against provider APIs!`
        });
      } else {
        setFeedback({
          type: "error",
          message: `⚠️ Live verification complete: ${passed} healthy, ${failed.length} failed (${failed.join(", ")}). Re-authorization required.`
        });
      }
    } catch (err) {
      setFeedback({ type: "error", message: `Verification error: ${err.message}` });
    } finally {
      setVerifyingAll(false);
    }
  };

  // --------------------------------------------------------------------------
  // FILTERING & METRICS
  // --------------------------------------------------------------------------
  const filteredClients = useMemo(() => {
    let list = clientsData;
    if (managedClient?.clientName) {
      list = list.filter((c) => c.clientName?.toLowerCase() === managedClient.clientName.toLowerCase());
    }
    if (!searchTerm.trim()) return list;
    const term = searchTerm.toLowerCase().trim();
    return list.filter((c) => {
      const matchName = c.clientName?.toLowerCase().includes(term);
      const matchAcc = c.accountingTool?.toLowerCase().includes(term);
      const matchCrm = c.crmTool?.toLowerCase().includes(term);
      const matchSheet = c.masterSheetId?.toLowerCase().includes(term);
      return matchName || matchAcc || matchCrm || matchSheet;
    });
  }, [clientsData, searchTerm, managedClient]);

  const metrics = useMemo(() => {
    const total = clientsData.length;
    let accountingConnected = 0;
    let crmConnected = 0;

    for (const c of clientsData) {
      const accTool = getAccountingToolType(c.accountingTool, c.integrations);
      const crmTool = getCrmToolType(c.crmTool, c.integrations);

      const accInt = c.integrations?.[accTool];
      if (accInt?.connected) accountingConnected++;

      const crmInt = c.integrations?.[crmTool];
      if (crmInt?.connected) crmConnected++;
    }

    const attentionCount = calculateIntegrationsAttentionCount(clientsData, sharedXero, managedClient?.clientName);

    return { total, accountingConnected, crmConnected, attentionCount };
  }, [clientsData, sharedXero, managedClient]);

  if (loading) {
    return <PmaIntegrationsSkeleton />;
  }

  return (
    <div style={{ padding: "20px 24px", maxWidth: "1380px", margin: "0 auto" }}>
      {/* ── TOP HEADER ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <h1 style={{ fontSize: "23px", fontWeight: "700", color: "#0f172a", margin: 0, display: "flex", alignItems: "center", gap: "10px" }}>
            <span>Third-party integrations</span>
          </h1>
        </div>

        {/* Global Action & Refresh */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            onClick={handleVerifyAllActive}
            title="Live-verify all active client tokens directly with provider APIs"
            disabled={loading || verifyingAll}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #93c5fd",
              background: "#eff6ff",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
              color: "#1d4ed8",
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
            }}
          >
            <span>{verifyingAll ? "⏳" : "⚡"}</span>
            <span>{verifyingAll ? "Verifying All..." : "Verify All Active"}</span>
          </button>
          <button
            onClick={() => fetchAllStatus(false, true)}
            title="Refresh all client integrations (force live sync from Google Sheets)"
            disabled={loading || verifyingAll}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
              color: "#334155",
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)"
            }}
          >
            <span>{loading ? "⏳" : "🔄"}</span>
            <span>{loading ? "Refreshing..." : "Refresh All"}</span>
          </button>
        </div>
      </div>

      {/* ── METRICS SUMMARY PILLS ───────────────────────────────────────────── */}
      {!loading && !managedClient && (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: "12px" }}>
            <span style={{ color: "#64748b", fontWeight: "600" }}>Total clients:</span>
            <span style={{ fontWeight: "700", color: "#0f172a" }}>{metrics.total}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: "12px" }}>
            <span style={{ color: "#166534", fontWeight: "600" }}>Accounting active:</span>
            <span style={{ fontWeight: "700", color: "#15803d" }}>{metrics.accountingConnected} / {metrics.total}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px" }}>
            <span style={{ color: "#1e40af", fontWeight: "600" }}>CRM active:</span>
            <span style={{ fontWeight: "700", color: "#1d4ed8" }}>{metrics.crmConnected} / {metrics.total}</span>
          </div>
          {metrics.attentionCount > 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", background: "#fef2f2", border: "1px solid #fecaca", fontSize: "12px" }}>
              <span style={{ color: "#991b1b", fontWeight: "700" }}>⚠️ Attention required:</span>
              <span style={{ fontWeight: "700", color: "#dc2626" }}>{metrics.attentionCount}</span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 14px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: "12px", color: "#475569" }}>
              <span>✓ All Active Tokens Healthy</span>
            </div>
          )}
        </div>
      )}

      {/* ── FEEDBACK NOTIFICATION BANNER ────────────────────────────────────── */}
      {feedback && (
        <div
          style={{
            padding: "12px 18px",
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
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "16px" }}>{feedback.type === "success" ? "✓" : feedback.type === "error" ? "⚠️" : "ℹ️"}</span>
            <span style={{ fontWeight: "600" }}>{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: "700", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── CENTRAL ADVISOR XERO ACCOUNT BANNER ─────────────────────────────── */}
      {isAdmin && !managedClient && (
        <div
          style={{
            background: sharedXero?.connected ? "linear-gradient(135deg, #f0fdf4 0%, #ffffff 100%)" : "linear-gradient(135deg, #f8fafc 0%, #ffffff 100%)",
            borderRadius: "14px",
            border: `1px solid ${sharedXero?.connected ? "#bbf7d0" : "#e2e8f0"}`,
            padding: "16px 20px",
            marginBottom: "22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "14px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px", maxWidth: "880px" }}>
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
      )}

      {/* ── SEARCH & JUMP NAVIGATION BAR ─────────────────────────────────────── */}
      {!managedClient && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "12px 18px",
            border: "1px solid #e2e8f0",
            marginBottom: "24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: "260px" }}>
            <span style={{ fontSize: "15px" }}>🔍</span>
            <input
              type="text"
              placeholder="Search clients by name, accounting tool, CRM, or sheet ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: "100%",
                padding: "7px 12px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                outline: "none"
              }}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm("")}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "12px",
                  color: "#64748b",
                  cursor: "pointer",
                  padding: "4px 8px"
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <label htmlFor="jump-to-client" style={{ fontSize: "12.5px", fontWeight: "600", color: "#475569", whiteSpace: "nowrap" }}>
              Jump to Client:
            </label>
            <select
              id="jump-to-client"
              defaultValue=""
              onChange={(e) => {
                handleJumpToClient(e.target.value);
                e.target.value = "";
              }}
              style={{
                padding: "7px 12px",
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
              <option value="" disabled>Select client ({clientsData.length})...</option>
              {clientsData.map((c) => (
                <option key={c.clientName} value={c.clientName}>
                  {c.clientName} {c.isSetupMode ? "🛠️" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* ── CLIENTS STREAM (ORDERED DOWN THE PAGE) ───────────────────────────── */}
      {filteredClients.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", background: "#f8fafc", borderRadius: "12px", border: "1px dashed #cbd5e1", color: "#64748b" }}>
          <span style={{ fontSize: "24px", display: "block", marginBottom: "8px" }}>🔍</span>
          <p style={{ margin: 0, fontWeight: "600" }}>No clients matched &quot;{searchTerm}&quot;.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          {filteredClients.map((client) => {
            const accToolType = getAccountingToolType(client.accountingTool, client.integrations);
            const crmToolType = getCrmToolType(client.crmTool, client.integrations);
            const isHighlighted = highlightedClient === client.clientName;

            return (
              <div
                key={client.clientName}
                id={`client-section-${encodeURIComponent(client.clientName)}`}
                style={{
                  background: "#ffffff",
                  borderRadius: "16px",
                  border: isHighlighted ? "2px solid #0284c7" : "1px solid #e2e8f0",
                  boxShadow: isHighlighted ? "0 0 0 4px rgba(2, 132, 199, 0.15), 0 2px 6px rgba(0,0,0,0.06)" : "0 1px 3px rgba(0,0,0,0.04)",
                  padding: "22px 24px",
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "stretch",
                  gap: "24px",
                  transition: "all 0.3s ease",
                  flexWrap: "wrap"
                }}
              >
                {/* ── LEFT COLUMN: CLIENT IDENTITY & SETUP CONTROLS (~25% width) ── */}
                <div
                  style={{
                    width: "24%",
                    minWidth: "220px",
                    maxWidth: "280px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    paddingRight: "16px",
                    borderRight: "1px solid #f1f5f9"
                  }}
                >
                  <div>
                    <h2
                      style={{
                        margin: "0 0 10px 0",
                        fontSize: "20px",
                        fontWeight: "800",
                        color: "#0f172a",
                        lineHeight: "1.25",
                        wordBreak: "break-word"
                      }}
                    >
                      {client.clientName}
                    </h2>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
                      {client.isSetupMode ? (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "700",
                            padding: "3px 9px",
                            borderRadius: "12px",
                            background: "#fef3c7",
                            color: "#b45309",
                            border: "1px solid #fde68a"
                          }}
                        >
                          🛠️ Setup Mode
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "600",
                            padding: "3px 9px",
                            borderRadius: "12px",
                            background: "#f1f5f9",
                            color: "#475569"
                          }}
                        >
                          Active Client
                        </span>
                      )}

                      {client.masterSheetId && (
                        <span
                          title={`Master Sheet ID: ${client.masterSheetId}`}
                          style={{
                            fontSize: "10.5px",
                            fontFamily: "monospace",
                            color: "#64748b",
                            background: "#f8fafc",
                            padding: "2px 7px",
                            borderRadius: "4px",
                            border: "1px solid #e2e8f0"
                          }}
                        >
                          {client.masterSheetId.slice(0, 5)}...{client.masterSheetId.slice(-4)}
                        </span>
                      )}
                    </div>
                  </div>

                  {isAdmin && (
                    <div style={{ marginTop: "16px" }}>
                      <Link
                        href={`/pma?nav=settings&client=${encodeURIComponent(client.clientName)}&section=main&subsection=integration-tools`}
                        title="Configure integration tools in client settings"
                        style={{
                          fontSize: "12px",
                          fontWeight: "600",
                          color: "#0369a1",
                          textDecoration: "none",
                          padding: "6px 12px",
                          borderRadius: "7px",
                          background: "#f0f9ff",
                          border: "1px solid #bae6fd",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px"
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        <span>Settings</span>
                      </Link>
                    </div>
                  )}
                </div>

                {/* ── RIGHT AREA: ACCOUNTING & CRM TOOL BOXES (~75% width) ── */}
                <div
                  style={{
                    flex: 1,
                    minWidth: "320px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                    gap: "20px"
                  }}
                >
                  {/* ── COLUMN 1: ACCOUNTING TOOL BOX ─────────────────────────── */}
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", fontWeight: "700", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>📊</span>
                      <span>Accounting Tool</span>
                      <span style={{ color: "#94a3b8" }}>({client.accountingTool || "None"})</span>
                    </div>

                    {accToolType === "xero" ? (
                      <XeroCard
                        client={client}
                        sharedXero={sharedXero}
                        selectedTenantId={selectedTenantsMap[client.clientName]}
                        onSelectTenant={(tid) => setSelectedTenantsMap((m) => ({ ...m, [client.clientName]: tid }))}
                        onSwitchTenant={(tid) => handleSwitchTenant(client, tid)}
                        switchingTenant={Boolean(switchingTenantMap[client.clientName])}
                        onConnect={(mode) => handleConnectXero(client, mode)}
                        onDisconnect={() => handleDisconnectXero(client)}
                        actionLoading={Boolean(actionLoadingMap[`${client.clientName}_xero_disconnect`])}
                        onTestToken={() => handleTestToken(client, "xero")}
                        brokerTesting={Boolean(brokerTestingMap[`${client.clientName}_xero`])}
                        brokerTestResult={brokerResultsMap[`${client.clientName}_xero`]}
                      />
                    ) : accToolType === "quickbooks" ? (
                      <QuickBooksCard
                        client={client}
                        onConnect={() => handleConnectQB(client)}
                        onDisconnect={() => handleDisconnectQB(client)}
                        actionLoading={Boolean(actionLoadingMap[`${client.clientName}_quickbooks_disconnect`])}
                        onTestToken={() => handleTestToken(client, "quickbooks")}
                        brokerTesting={Boolean(brokerTestingMap[`${client.clientName}_quickbooks`])}
                        brokerTestResult={brokerResultsMap[`${client.clientName}_quickbooks`]}
                      />
                    ) : (
                      <EmptyToolCard
                        category="Accounting"
                        configuredName={client.accountingTool}
                        client={client}
                        isAdmin={isAdmin}
                        automationHealth={client.automationHealth}
                        onTestSource={handleTestSource}
                        sourceTesting={Boolean(sourceTestingMap[`${client.clientName}_Accounting`])}
                        sourceTestResult={sourceResultsMap[`${client.clientName}_Accounting`]}
                      />
                    )}
                  </div>

                  {/* ── COLUMN 2: CRM TOOL BOX ─────────────────────────────────── */}
                  <div>
                    <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", fontWeight: "700", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>👥</span>
                      <span>CRM Tool</span>
                      <span style={{ color: "#94a3b8" }}>
                        ({String(client.crmTool || "").toLowerCase().includes("sheet")
                          ? "Google Sheet"
                          : String(client.crmTool || "").toLowerCase().includes("excel")
                            ? "Excel"
                            : client.crmTool || "None"})
                      </span>
                    </div>

                    {CRM_TOOLS_CONFIG[crmToolType] ? (
                      <CrmCard
                        client={client}
                        toolKey={crmToolType}
                        config={CRM_TOOLS_CONFIG[crmToolType]}
                        onConnect={() => handleConnectCrm(client, crmToolType)}
                        onConfigure={() => handleConfigureCrm(client, crmToolType)}
                        onDisconnect={() => handleDisconnectCrm(client, crmToolType)}
                        actionLoading={Boolean(actionLoadingMap[`${client.clientName}_${crmToolType}_disconnect`])}
                        onTestToken={() => handleTestToken(client, crmToolType)}
                        brokerTesting={Boolean(brokerTestingMap[`${client.clientName}_${crmToolType}`])}
                        brokerTestResult={brokerResultsMap[`${client.clientName}_${crmToolType}`]}
                      />
                    ) : (
                      <EmptyToolCard
                        category="CRM"
                        configuredName={client.crmTool}
                        client={client}
                        isAdmin={isAdmin}
                        automationHealth={client.automationHealth}
                        onTestSource={handleTestSource}
                        sourceTesting={Boolean(sourceTestingMap[`${client.clientName}_CRM`])}
                        sourceTestResult={sourceResultsMap[`${client.clientName}_CRM`]}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── FOOTER ARCHITECTURE NOTE ────────────────────────────────────────── */}
      {isAdmin && (
        <div style={{ marginTop: "32px", background: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0", padding: "16px 20px" }}>
          <h4 style={{ margin: "0 0 6px 0", fontSize: "13.5px", fontWeight: "700", color: "#0f172a" }}>
            💡 Vault & Broker Architecture
          </h4>
          <p style={{ margin: 0, fontSize: "12px", color: "#475569", lineHeight: "1.6" }}>
            All credentials are encrypted with AES-256-GCM in Redis. Google Apps Script queries <code style={{ background: "#e2e8f0", padding: "2px 5px", borderRadius: "4px" }}>/api/integrations/token</code> during automated sync cycles using client-specific tokens. When any connection is authorised, automated notifications are immediately sent to all Admins and assigned Client Managers.
          </p>
        </div>
      )}

      {/* ── GOOGLE SHEET LINK MODAL ────────────────────────────────────── */}
      {googleSheetModalClient && (
        <GoogleSheetLinkModal
          isOpen={Boolean(googleSheetModalClient)}
          onClose={() => setGoogleSheetModalClient(null)}
          client={googleSheetModalClient}
          clientName={googleSheetModalClient.clientName}
          masterSheetId={googleSheetModalClient.masterSheetId}
          clientSheetId={googleSheetModalClient.clientSheetId}
          currentConfig={googleSheetModalClient.integrations?.googlesheet}
          onSuccess={async () => {
            await fetchAllStatus(true, true);
            setFeedback({
              type: "success",
              message: `Successfully linked Google Sheet CRM for ${googleSheetModalClient.clientName}.`
            });
          }}
        />
      )}

      {/* ── MICROSOFT EXCEL LINK MODAL ─────────────────────────────────── */}
      {excelModalClient && (
        <ExcelLinkModal
          isOpen={Boolean(excelModalClient)}
          onClose={() => setExcelModalClient(null)}
          client={excelModalClient}
          clientName={excelModalClient.clientName}
          masterSheetId={excelModalClient.masterSheetId}
          clientSheetId={excelModalClient.clientSheetId}
          currentConfig={excelModalClient.integrations?.excel}
          onSuccess={async () => {
            await fetchAllStatus(true, true);
            setFeedback({
              type: "success",
              message: `Successfully linked Microsoft Excel CRM for ${excelModalClient.clientName}.`
            });
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// SUB-COMPONENT: XERO CARD
// ============================================================================
function XeroCard({
  client,
  sharedXero,
  selectedTenantId,
  onSelectTenant,
  onSwitchTenant,
  switchingTenant,
  onConnect,
  onDisconnect,
  actionLoading,
  onTestToken,
  brokerTesting,
  brokerTestResult
}) {
  const xero = client.integrations?.xero || {};
  const isConnected = Boolean(xero.connected);
  const isHealthy = isConnected && !xero.reconnectRequired;
  const cardBg = isHealthy ? "#f0fdf4" : "#fef2f2";
  const cardBorder = isHealthy ? "1px solid #bbf7d0" : "1px solid #fecaca";

  return (
    <div
      style={{
        background: cardBg,
        borderRadius: "14px",
        border: cardBorder,
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        boxSizing: "border-box"
      }}
    >
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: "rgba(0, 180, 216, 0.12)", color: "#00b4d8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: "700" }}>
              X
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>Xero Accounting</h3>
              <span style={{ fontSize: "11.5px", color: "#64748b" }}>Financials, Invoices, P&L Sync</span>
            </div>
          </div>
          <span
            style={{
              fontSize: "11px",
              fontWeight: "700",
              padding: "2px 9px",
              borderRadius: "20px",
              background: xero.reconnectRequired ? "#fee2e2" : isConnected ? "#dcfce7" : "#f1f5f9",
              color: xero.reconnectRequired ? "#dc2626" : isConnected ? "#15803d" : "#64748b"
            }}
          >
            {xero.reconnectRequired
              ? "Re-auth Needed"
              : isConnected
                ? (xero.isSharedGrant ? "Connected (Advisor)" : "Connected")
                : sharedXero?.connected
                  ? "Not in Advisor Grant"
                  : "Not Connected"}
          </span>
        </div>

        <p style={{ fontSize: "12.5px", color: "#475569", lineHeight: "1.4", margin: "0 0 14px 0" }}>
          Connects via OAuth 2.0 PKCE. Automated rolling refresh with AES-256-GCM encryption in Vault.
        </p>

        {/* Not in Central Grant Helper Banner */}
        {!isConnected && sharedXero?.connected && (
          <div style={{ background: "#f0f9ff", borderRadius: "10px", padding: "10px 12px", border: "1px solid #bae6fd", marginBottom: "14px", fontSize: "12px" }}>
            <div style={{ fontWeight: "700", color: "#0369a1", marginBottom: "4px", display: "flex", alignItems: "center", gap: "5px" }}>
              <span>ℹ️</span> Central Advisor Account Active
            </div>
            <p style={{ margin: "0 0 6px 0", color: "#0c4a6e", lineHeight: "1.3" }}>
              To link <strong>{client.clientName}</strong>, click below to authorise this organisation in Xero.
            </p>
            {sharedXero?.availableTenants && sharedXero.availableTenants.length > 0 && (
              <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px dashed #bae6fd" }}>
                <span style={{ fontSize: "11px", fontWeight: "600", color: "#0369a1", display: "block", marginBottom: "4px" }}>
                  Already authorised in Xero? Link organisation:
                </span>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) onSwitchTenant(e.target.value);
                  }}
                  style={{
                    width: "100%",
                    padding: "5px 8px",
                    borderRadius: "6px",
                    border: "1px solid #7dd3fc",
                    fontSize: "11.5px",
                    background: "#fff",
                    color: "#0f172a"
                  }}
                >
                  <option value="" disabled>Select from {sharedXero.availableTenants.length} authorised org(s)...</option>
                  {sharedXero.availableTenants.map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Connected Details */}
        {(isConnected || xero.reconnectRequired) && (
          <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "10px 12px", border: "1px solid #e2e8f0", marginBottom: "14px", fontSize: "11.5px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Connection Mode:</span>
              <span style={{ fontWeight: "600", color: xero.isSharedGrant ? "#0284c7" : "#0f172a" }}>
                {xero.isSharedGrant ? "Central Advisor Account" : "Dedicated Client Account"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Organisation:</span>
              <span style={{ fontWeight: "600", color: "#0f172a" }}>{xero.tenantName || "N/A"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Tenant ID:</span>
              <span style={{ fontFamily: "monospace", color: "#334155" }}>
                {xero.tenantId ? `${xero.tenantId.slice(0, 8)}...${xero.tenantId.slice(-4)}` : "N/A"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Token Status:</span>
              <span style={{ fontWeight: "600", color: xero.reconnectRequired ? "#dc2626" : "#15803d" }}>
                {xero.reconnectRequired ? "Re-authorisation Required" : "Connected (Auto-refreshes)"}
              </span>
            </div>
            {xero.lastRefreshedAt && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                <span style={{ color: "#334155" }}>{new Date(xero.lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}

            {/* Tenant Switcher */}
            {xero.availableTenants && xero.availableTenants.length > 1 && (
              <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px dashed #cbd5e1" }}>
                <label style={{ display: "block", fontSize: "11px", color: "#475569", fontWeight: "700", marginBottom: "4px" }}>
                  Switch Organisation ({xero.availableTenants.length} available):
                </label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <select
                    value={selectedTenantId || xero.tenantId}
                    onChange={(e) => onSelectTenant(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "5px 7px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "11.5px",
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
                    onClick={() => onSwitchTenant()}
                    disabled={switchingTenant || selectedTenantId === xero.tenantId}
                    style={{
                      padding: "5px 10px",
                      borderRadius: "6px",
                      border: "none",
                      background: selectedTenantId === xero.tenantId ? "#94a3b8" : "#2563eb",
                      color: "#fff",
                      fontSize: "11.5px",
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
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
          {isConnected && !xero.reconnectRequired ? (
            <>
              <button
                onClick={onDisconnect}
                disabled={actionLoading}
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #fecaca",
                  background: "#fff",
                  color: "#dc2626",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                {actionLoading ? "Processing..." : (xero.isSharedGrant ? "Unlink Organisation" : "Disconnect & Revoke")}
              </button>
              <button
                onClick={onTestToken}
                disabled={brokerTesting}
                title="Test Token Broker retrieval for this client"
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: "#f1f5f9",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                }}
              >
                {brokerTesting ? "Testing..." : "⚡ Test Broker"}
              </button>
            </>
          ) : xero.reconnectRequired ? (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "6px" }}>
              <button
                onClick={() => onConnect("dedicated")}
                style={{
                  width: "100%",
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
                }}
              >
                Re-connect Xero for {client.clientName}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={onDisconnect}
                  disabled={actionLoading}
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#dc2626",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {actionLoading ? "Processing..." : "Disconnect"}
                </button>
                <button
                  onClick={onTestToken}
                  disabled={brokerTesting}
                  title="Retry token refresh with current credentials"
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: "#f1f5f9",
                    color: "#475569",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {brokerTesting ? "Testing..." : "⚡ Test Broker / Retry"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "6px" }}>
              <button
                onClick={() => onConnect("dedicated")}
                style={{
                  width: "100%",
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: "none",
                  background: xero.reconnectRequired ? "#dc2626" : "#0284c7",
                  color: "#ffffff",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
                }}
              >
                {xero.reconnectRequired
                  ? `Re-connect Xero for ${client.clientName}`
                  : `Connect Dedicated Xero for ${client.clientName}`}
              </button>
            </div>
          )}
        </div>

        {/* Live Token Broker Response */}
        {brokerTestResult && (
          <div
            style={{
              marginTop: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              fontSize: "10.5px",
              fontFamily: "monospace",
              background: brokerTestResult.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${brokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
              color: brokerTestResult.success ? "#166534" : "#991b1b",
              maxHeight: "130px",
              overflowY: "auto"
            }}
          >
            <div style={{ fontWeight: "700", marginBottom: "3px" }}>
              {brokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
            </div>
            <div>{JSON.stringify(brokerTestResult, null, 2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENT: QUICKBOOKS CARD
// ============================================================================
function QuickBooksCard({
  client,
  onConnect,
  onDisconnect,
  actionLoading,
  onTestToken,
  brokerTesting,
  brokerTestResult
}) {
  const qb = client.integrations?.quickbooks || {};
  const isConnected = Boolean(qb.connected);
  const isHealthy = isConnected && !qb.reconnectRequired;
  const cardBg = isHealthy ? "#f0fdf4" : "#fef2f2";
  const cardBorder = isHealthy ? "1px solid #bbf7d0" : "1px solid #fecaca";

  return (
    <div
      style={{
        background: cardBg,
        borderRadius: "14px",
        border: cardBorder,
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        boxSizing: "border-box"
      }}
    >
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: "rgba(44, 160, 28, 0.12)", color: "#2ca01c", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: "700" }}>
              Q
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>QuickBooks Online</h3>
              <span style={{ fontSize: "11.5px", color: "#64748b" }}>Invoices, Outgoings & Expenses</span>
            </div>
          </div>
          <span
            style={{
              fontSize: "11px",
              fontWeight: "700",
              padding: "2px 9px",
              borderRadius: "20px",
              background: qb.reconnectRequired ? "#fee2e2" : isConnected ? "#dcfce7" : "#f1f5f9",
              color: qb.reconnectRequired ? "#dc2626" : isConnected ? "#15803d" : "#64748b"
            }}
          >
            {qb.reconnectRequired ? "Re-auth Needed" : isConnected ? "Connected" : "Not Connected"}
          </span>
        </div>

        <p style={{ fontSize: "12.5px", color: "#475569", lineHeight: "1.4", margin: "0 0 14px 0" }}>
          Connects via Intuit OAuth 2.0 PKCE. Tokens are stored encrypted (AES-256-GCM) in the Vault.
        </p>

        {/* Connected Details */}
        {(isConnected || qb.reconnectRequired) && (
          <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "10px 12px", border: "1px solid #e2e8f0", marginBottom: "14px", fontSize: "11.5px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Company Name:</span>
              <span style={{ fontWeight: "600", color: "#0f172a" }}>{qb.companyName || qb.tenantName || "N/A"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Realm ID:</span>
              <span style={{ fontFamily: "monospace", color: "#334155" }}>{qb.realmId || qb.tenantId || "N/A"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Token Status:</span>
              <span style={{ fontWeight: "600", color: qb.reconnectRequired ? "#dc2626" : "#15803d" }}>
                {qb.reconnectRequired ? "Re-authorisation Required" : "Connected (Auto-refreshes)"}
              </span>
            </div>
            {qb.lastRefreshedAt && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Last Refreshed:</span>
                <span style={{ color: "#334155" }}>{new Date(qb.lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
          {isConnected && !qb.reconnectRequired ? (
            <>
              <button
                onClick={onDisconnect}
                disabled={actionLoading}
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #fecaca",
                  background: "#fff",
                  color: "#dc2626",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                {actionLoading ? "Disconnecting..." : "Disconnect & Revoke"}
              </button>
              <button
                onClick={onTestToken}
                disabled={brokerTesting}
                title="Test Token Broker retrieval for this client"
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: "#f1f5f9",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                }}
              >
                {brokerTesting ? "Testing..." : "⚡ Test Broker"}
              </button>
            </>
          ) : qb.reconnectRequired ? (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "6px" }}>
              <button
                onClick={onConnect}
                style={{
                  width: "100%",
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
                }}
              >
                Re-connect QuickBooks for {client.clientName}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={onDisconnect}
                  disabled={actionLoading}
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#dc2626",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {actionLoading ? "Disconnecting..." : "Disconnect"}
                </button>
                <button
                  onClick={onTestToken}
                  disabled={brokerTesting}
                  title="Retry token refresh with current credentials"
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: "#f1f5f9",
                    color: "#475569",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {brokerTesting ? "Testing..." : "⚡ Test Broker / Retry"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onConnect}
              style={{
                width: "100%",
                padding: "9px 14px",
                borderRadius: "7px",
                border: "none",
                background: qb.reconnectRequired ? "#dc2626" : "#2ca01c",
                color: "#ffffff",
                fontSize: "12.5px",
                fontWeight: "600",
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
              }}
            >
              {qb.reconnectRequired ? `Re-connect QuickBooks for ${client.clientName}` : `Connect QuickBooks for ${client.clientName}`}
            </button>
          )}
        </div>

        {/* Live Token Broker Response */}
        {brokerTestResult && (
          <div
            style={{
              marginTop: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              fontSize: "10.5px",
              fontFamily: "monospace",
              background: brokerTestResult.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${brokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
              color: brokerTestResult.success ? "#166534" : "#991b1b",
              maxHeight: "130px",
              overflowY: "auto"
            }}
          >
            <div style={{ fontWeight: "700", marginBottom: "3px" }}>
              {brokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
            </div>
            <div>{JSON.stringify(brokerTestResult, null, 2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENT: CRM TOOL CARD (CLICKUP, CAPSULE, CLOSE, HUBSPOT, MONDAY, PIPEDRIVE)
// ============================================================================
function CrmCard({
  client,
  toolKey,
  config,
  onConnect,
  onConfigure,
  onDisconnect,
  actionLoading,
  onTestToken,
  brokerTesting,
  brokerTestResult
}) {
  const toolData = client.integrations?.[toolKey] || {};
  const isConnected = Boolean(toolData.connected);
  const metadata = toolData.metadata || {};

  const accountValue = config.getAccountValue ? config.getAccountValue(metadata) || toolData.accountName || toolData.tenantName : null;
  const idValue = config.getIdValue ? config.getIdValue(metadata) : null;
  const authorizedBy = metadata?.userName || metadata?.userEmail;

  const isHealthy = isConnected && !toolData.reconnectRequired;
  const cardBg = isHealthy ? "#f0fdf4" : "#fef2f2";
  const cardBorder = isHealthy ? "1px solid #bbf7d0" : "1px solid #fecaca";

  return (
    <div
      style={{
        background: cardBg,
        borderRadius: "14px",
        border: cardBorder,
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        boxSizing: "border-box"
      }}
    >
      <div>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: config.bgColor, color: config.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: "700" }}>
              {config.icon}
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>{config.name}</h3>
              <span style={{ fontSize: "11.5px", color: "#64748b" }}>{config.subtitle}</span>
            </div>
          </div>
          <span
            style={{
              fontSize: "11px",
              fontWeight: "700",
              padding: "2px 9px",
              borderRadius: "20px",
              background: toolData.reconnectRequired ? "#fee2e2" : isConnected ? "#dcfce7" : "#f1f5f9",
              color: toolData.reconnectRequired ? "#dc2626" : isConnected ? "#15803d" : "#64748b"
            }}
          >
            {toolData.reconnectRequired ? "Re-auth needed" : isConnected ? "Connected" : "Not connected"}
          </span>
        </div>

        <p style={{ fontSize: "12.5px", color: "#475569", lineHeight: "1.4", margin: "0 0 14px 0" }}>
          {config.description}
        </p>

        {/* Connected Details */}
        {(isConnected || toolData.reconnectRequired) && (
          <div style={{ background: "#f8fafc", borderRadius: "10px", padding: "10px 12px", border: "1px solid #e2e8f0", marginBottom: "14px", fontSize: "11.5px" }}>
            {accountValue && (
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                <span style={{ color: "#64748b" }}>{config.accountLabel}:</span>
                <span style={{ fontWeight: "600", color: "#0f172a" }}>{accountValue}</span>
              </div>
            )}
            {idValue && (
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                <span style={{ color: "#64748b" }}>{config.idLabel}:</span>
                <span style={{ fontFamily: "monospace", color: "#334155" }}>{idValue}</span>
              </div>
            )}
            {authorizedBy && (
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                <span style={{ color: "#64748b" }}>Authorised by:</span>
                <span style={{ color: "#334155" }}>{authorizedBy}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
              <span style={{ color: "#64748b" }}>Token status:</span>
              <span style={{ fontWeight: "600", color: toolData.reconnectRequired ? "#dc2626" : "#15803d" }}>
                {toolData.reconnectRequired ? "Re-authorisation required" : "Connected (Auto-refreshes)"}
              </span>
            </div>
            {toolData.lastRefreshedAt && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Last refreshed:</span>
                <span style={{ color: "#334155" }}>{new Date(toolData.lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
          {isConnected && !toolData.reconnectRequired ? (
            <>
              {(toolKey === "googlesheet" || toolKey === "excel") && onConfigure && (
                <button
                  onClick={onConfigure}
                  style={{
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#0f172a",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  Configure
                </button>
              )}
              <button
                onClick={onDisconnect}
                disabled={actionLoading}
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #fecaca",
                  background: "#fff",
                  color: "#dc2626",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                {actionLoading ? "Disconnecting..." : "Disconnect"}
              </button>
              <button
                onClick={onTestToken}
                disabled={brokerTesting}
                title="Test Token Broker retrieval for this client"
                style={{
                  flex: 1,
                  padding: "7px 12px",
                  borderRadius: "7px",
                  border: "1px solid #cbd5e1",
                  background: "#f1f5f9",
                  color: "#475569",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                }}
              >
                {brokerTesting ? "Testing..." : "⚡ Test Broker"}
              </button>
            </>
          ) : toolData.reconnectRequired ? (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "6px" }}>
              <button
                onClick={onConnect}
                style={{
                  width: "100%",
                  padding: "9px 14px",
                  borderRadius: "7px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontSize: "12.5px",
                  fontWeight: "600",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
                }}
              >
                Re-connect {config.name} for {client.clientName}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={onDisconnect}
                  disabled={actionLoading}
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#dc2626",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {actionLoading ? "Disconnecting..." : "Disconnect"}
                </button>
                <button
                  onClick={onTestToken}
                  disabled={brokerTesting}
                  title="Retry token refresh with current credentials"
                  style={{
                    flex: 1,
                    padding: "7px 12px",
                    borderRadius: "7px",
                    border: "1px solid #cbd5e1",
                    background: "#f1f5f9",
                    color: "#475569",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer"
                  }}
                >
                  {brokerTesting ? "Testing..." : "⚡ Test Broker / Retry"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onConnect}
              style={{
                width: "100%",
                padding: "9px 14px",
                borderRadius: "7px",
                border: "none",
                background: toolData.reconnectRequired ? "#dc2626" : config.color,
                color: "#ffffff",
                fontSize: "12.5px",
                fontWeight: "600",
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)"
              }}
            >
              {toolData.reconnectRequired
                ? `Re-connect ${config.name} for ${client.clientName}`
                : `Connect ${config.name} for ${client.clientName}`}
            </button>
          )}
        </div>

        {/* Live Token Broker Response */}
        {brokerTestResult && (
          <div
            style={{
              marginTop: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              fontSize: "10.5px",
              fontFamily: "monospace",
              background: brokerTestResult.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${brokerTestResult.success ? "#bbf7d0" : "#fecaca"}`,
              color: brokerTestResult.success ? "#166534" : "#991b1b",
              maxHeight: "130px",
              overflowY: "auto"
            }}
          >
            <div style={{ fontWeight: "700", marginBottom: "3px" }}>
              {brokerTestResult.success ? "✓ Token Broker Response (200 OK):" : "✕ Token Broker Error:"}
            </div>
            <div>{JSON.stringify(brokerTestResult, null, 2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENT: EMPTY / UNCONFIGURED TOOL PLACEHOLDER
// ============================================================================
function EmptyToolCard({
  category,
  configuredName,
  client,
  isAdmin,
  automationHealth,
  onTestSource,
  sourceTesting,
  sourceTestResult
}) {
  const displayVal = configuredName || "None";
  const norm = String(configuredName || "").trim().toLowerCase();
  const isOAuthTool = ["clickup", "close", "capsule", "hubspot", "monday", "pipedrive", "xero", "quickbooks"].some((t) => norm.includes(t));
  const isSpreadsheetSource = norm && norm !== "none" && !isOAuthTool;

  if (isSpreadsheetSource) {
    const isGoogle = norm.includes("sheet");
    const isExcel = norm.includes("excel");
    const toolTitle = isGoogle ? "Google Sheet" : isExcel ? "Excel" : (configuredName || "Spreadsheet");
    const iconText = isGoogle ? "GS" : isExcel ? "XL" : "SP";

    const health = category === "CRM" ? automationHealth?.crm : automationHealth?.accounting;
    const status = health?.status || "inactive";

    // Dynamic color coding based on automation run success / failure
    let cardBg = "#f8fafc";
    let cardBorder = "1px dashed #cbd5e1";
    let badgeBg = "#f1f5f9";
    let badgeColor = "#475569";
    let badgeLabel = "Not scheduled";
    let iconBg = "#e2e8f0";
    let iconColor = "#475569";

    if (status === "healthy") {
      cardBg = "#f0fdf4";
      cardBorder = "1px solid #86efac";
      badgeBg = "#dcfce7";
      badgeColor = "#15803d";
      badgeLabel = "Healthy";
      iconBg = "#dcfce7";
      iconColor = "#16a34a";
    } else if (status === "running") {
      cardBg = "#f0f9ff";
      cardBorder = "1px solid #93c5fd";
      badgeBg = "#e0f2fe";
      badgeColor = "#0369a1";
      badgeLabel = "Running sequence";
      iconBg = "#e0f2fe";
      iconColor = "#0284c7";
    } else if (status === "error") {
      cardBg = "#fef2f2";
      cardBorder = "1px solid #fca5a5";
      badgeBg = "#fee2e2";
      badgeColor = "#b91c1c";
      badgeLabel = "Attention required";
      iconBg = "#fee2e2";
      iconColor = "#dc2626";
    } else if (status === "pending") {
      cardBg = "#fffbeb";
      cardBorder = "1px solid #fde68a";
      badgeBg = "#fef3c7";
      badgeColor = "#b45309";
      badgeLabel = "Pending run";
      iconBg = "#fef3c7";
      iconColor = "#d97706";
    }

    return (
      <div
        style={{
          background: cardBg,
          borderRadius: "14px",
          border: cardBorder,
          padding: "18px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          minHeight: "260px",
          boxSizing: "border-box",
          boxShadow: status === "healthy" ? "0 1px 3px rgba(34, 197, 94, 0.08)" : status === "error" ? "0 1px 3px rgba(239, 68, 68, 0.08)" : "none",
          transition: "all 0.2s ease"
        }}
      >
        <div>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: iconBg,
                  color: iconColor,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                  fontWeight: "700"
                }}
              >
                {iconText}
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "15px", fontWeight: "700", color: "#1e293b" }}>
                  {toolTitle}
                </h3>
                <span style={{ fontSize: "11.5px", color: "#64748b" }}>
                  Spreadsheet source (direct ingestion)
                </span>
              </div>
            </div>
            <span
              style={{
                fontSize: "11px",
                fontWeight: "600",
                padding: "3px 9px",
                borderRadius: "20px",
                background: badgeBg,
                color: badgeColor,
                display: "inline-flex",
                alignItems: "center",
                gap: "5px"
              }}
            >
              {status === "healthy" && (
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#16a34a" }} />
              )}
              {status === "running" && (
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#0284c7" }} />
              )}
              {status === "error" && (
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#dc2626" }} />
              )}
              {badgeLabel}
            </span>
          </div>

          {/* Status descriptive summary */}
          <p style={{ fontSize: "12.5px", color: "#475569", lineHeight: "1.45", margin: "0 0 14px 0" }}>
            {status === "healthy"
              ? `Automated ${category.toLowerCase()} sequences are running successfully on cadence and ingesting data.`
              : status === "running"
                ? `An automated ${category.toLowerCase()} sequence is currently executing on the client Master Sheet.`
                : status === "error"
                  ? `Automated sequence requires attention: ${health?.summary || health?.signalFeedback || "Latest run failed"}`
                  : `This client uses ${toolTitle} as their ${category.toLowerCase()} data source without an active automation schedule.`}
          </p>

          {/* Compact sequence metrics grid */}
          <div
            style={{
              background: "rgba(255, 255, 255, 0.75)",
              borderRadius: "8px",
              padding: "10px 12px",
              border: "1px solid rgba(0, 0, 0, 0.06)",
              marginBottom: "14px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              fontSize: "11.5px"
            }}
          >
            <div>
              <span style={{ color: "#64748b", display: "block", fontSize: "10.5px", fontWeight: "600" }}>
                Cadence
              </span>
              <span style={{ color: "#1e293b", fontWeight: "600" }}>
                {health?.frequency && health.frequency !== "None" && health.frequency !== "-"
                  ? `Every ${health.frequency}`
                  : "Manual / none"}
              </span>
            </div>
            <div>
              <span style={{ color: "#64748b", display: "block", fontSize: "10.5px", fontWeight: "600" }}>
                Last run
              </span>
              <span style={{ color: "#1e293b", fontWeight: "500" }}>
                {health?.lastRunEndTime || health?.lastCommandTime || "None recorded"}
              </span>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ color: "#64748b", display: "block", fontSize: "10.5px", fontWeight: "600" }}>
                Sequence summary
              </span>
              <span style={{ color: status === "error" ? "#dc2626" : "#334155", fontWeight: "500" }}>
                {health?.summary || health?.signalFeedback || "No feedback recorded"}
              </span>
            </div>
          </div>

          {/* Live Test Source Result Banner */}
          {sourceTestResult && (
            <div
              style={{
                borderRadius: "8px",
                padding: "8px 12px",
                marginBottom: "14px",
                fontSize: "11.5px",
                background: sourceTestResult.success ? "#ecfdf5" : "#fef2f2",
                border: `1px solid ${sourceTestResult.success ? "#a7f3d0" : "#fecaca"}`,
                color: sourceTestResult.success ? "#065f46" : "#991b1b"
              }}
            >
              <div style={{ fontWeight: "600", marginBottom: "2px" }}>
                {sourceTestResult.success ? "✓ Source connected and verified" : "✕ Source verification failed"}
              </div>
              <div style={{ wordBreak: "break-word" }}>
                {sourceTestResult.message || sourceTestResult.error}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons: Test source & Settings */}
        {isAdmin && client && (
          <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={sourceTesting}
              onClick={() => onTestSource?.(client, category, toolTitle)}
              style={{
                flex: 1,
                minWidth: "120px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "6px",
                padding: "8px 10px",
                borderRadius: "7px",
                background: "#ffffff",
                color: "#1e293b",
                border: "1px solid #cbd5e1",
                fontSize: "12px",
                fontWeight: "600",
                cursor: sourceTesting ? "wait" : "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)"
              }}
            >
              {sourceTesting ? (
                <span>Testing source...</span>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  <span>Test source</span>
                </>
              )}
            </button>

            <Link
              href={`/pma?nav=settings&client=${encodeURIComponent(client.clientName)}&section=main&subsection=integration-tools`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "5px",
                padding: "8px 12px",
                borderRadius: "7px",
                background: "#ffffff",
                color: "#0369a1",
                border: "1px solid #bae6fd",
                fontSize: "12px",
                fontWeight: "600",
                textDecoration: "none",
                cursor: "pointer"
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#f8fafc",
        borderRadius: "14px",
        border: "1px dashed #cbd5e1",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "calc(100% - 24px)",
        boxSizing: "border-box"
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: "#e2e8f0", color: "#64748b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: "700" }}>
              —
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "14.5px", fontWeight: "700", color: "#334155" }}>
                No {category} Tool Configured
              </h3>
              <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
                KeyInfo is set to &quot;{displayVal}&quot;
              </span>
            </div>
          </div>
          <span
            style={{
              fontSize: "11px",
              fontWeight: "600",
              padding: "2px 8px",
              borderRadius: "20px",
              background: "#e2e8f0",
              color: "#64748b"
            }}
          >
            None
          </span>
        </div>

        <p style={{ fontSize: "12px", color: "#64748b", lineHeight: "1.45", margin: "0 0 14px 0" }}>
          This client does not currently have an automated {category.toLowerCase()} connection configured in their spreadsheet settings.
        </p>
      </div>

      {isAdmin && client && (
        <div>
          <Link
            href={`/pma?nav=settings&client=${encodeURIComponent(client.clientName)}&section=main&subsection=integration-tools`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 12px",
              borderRadius: "7px",
              background: "#ffffff",
              color: "#334155",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
              fontWeight: "600",
              textDecoration: "none",
              cursor: "pointer"
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Configure in settings</span>
          </Link>
        </div>
      )}
    </div>
  );
}
