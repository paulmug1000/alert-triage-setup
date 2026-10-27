// ============================================================================
// HELPER FUNCTIONS: RESOLVE CONFIGURED TOOLS & CALCULATE ATTENTION BADGES
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
