import { COMPARISON_SHEET_SPECS } from "./masterComparisonSheetSpec";
import { CLIENT_SHEET_SPECS } from "./clientSheetSpecs";
import { getReconTabSpec } from "./reconSheetSpecs";

export const COMPARISON_TAB_CACHE = new Map();
const COMPARISON_INFLIGHT = new Map();
export const COMPARISON_CACHE_TTL_MS = 60000;
export const COMPARISON_STALE_REFRESH_MS = 15000;

export const VIRTUAL_TAB_CACHE = new Map();
const VIRTUAL_INFLIGHT = new Map();
export const VIRTUAL_CACHE_TTL_MS = 60000;

export const CLIENT_KEYINFO_CACHE = new Map();
export const KEYINFO_CACHE_TTL_MS = 300000;

export const RECON_DATA_CACHE = new Map();
export const RECON_DATA_TTL_MS = 300000;

function normalizeComparisonGridPayload(data) {
  return {
    rowCount: data.rowCount || 0,
    colCount: data.colCount || 0,
    valuesGrid: Array.isArray(data.valuesGrid) ? data.valuesGrid : [],
    rawValuesGrid: Array.isArray(data.rawValuesGrid) ? data.rawValuesGrid : [],
    notesGrid:
      data.notesGrid && typeof data.notesGrid === "object" && !Array.isArray(data.notesGrid)
        ? data.notesGrid
        : {},
    staleAgainstClientEdits: Boolean(data.staleAgainstClientEdits),
    updatedAt: data.updatedAt || null,
  };
}

function normalizeVirtualGridPayload(data) {
  return {
    rowCount: data.rowCount || 0,
    colCount: data.colCount || 0,
    valuesGrid: Array.isArray(data.valuesGrid) ? data.valuesGrid : [],
    formulasGrid: Array.isArray(data.formulasGrid) ? data.formulasGrid : [],
    rawValuesGrid: Array.isArray(data.rawValuesGrid) ? data.rawValuesGrid : [],
    notesGrid:
      data.notesGrid && typeof data.notesGrid === "object" && !Array.isArray(data.notesGrid)
        ? data.notesGrid
        : {},
    updatedAt: data.updatedAt || null,
  };
}

export function invalidateComparisonModalCache(clientName = "") {
  const clean = String(clientName || "").trim().toLowerCase();
  if (!clean) {
    COMPARISON_TAB_CACHE.clear();
    return;
  }
  const prefix = `${clean}::`;
  for (const key of COMPARISON_TAB_CACHE.keys()) {
    if (key.startsWith(prefix)) {
      COMPARISON_TAB_CACHE.delete(key);
    }
  }
}

export async function fetchComparisonTabPayload(clientName, tabName) {
  const targetSpec = COMPARISON_SHEET_SPECS[tabName] || COMPARISON_SHEET_SPECS.InvComp;
  const key = `${String(clientName || "").trim().toLowerCase()}::${tabName}`;
  if (COMPARISON_INFLIGHT.has(key)) {
    return COMPARISON_INFLIGHT.get(key);
  }
  const promise = (async () => {
    const res = await fetch("/api/pma/master-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_tab_grid",
        clientName,
        sheetRole: "master",
        tabName,
        maxRows: 1000,
        maxCols: targetSpec.totalCols,
        includeFormulas: false,
        includeRawValues: true,
        includeNotes: true,
        trimTrailingEmptyRows: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Failed to load ${tabName}.`);
    }
    const payload = normalizeComparisonGridPayload(data);
    COMPARISON_TAB_CACHE.set(key, { payload, cachedAt: Date.now() });
    return payload;
  })().finally(() => {
    COMPARISON_INFLIGHT.delete(key);
  });
  COMPARISON_INFLIGHT.set(key, promise);
  return promise;
}

export async function prefetchComparisonTab(clientName, tabName) {
  if (!clientName || !tabName) return null;
  const key = `${String(clientName).trim().toLowerCase()}::${tabName}`;
  const cached = COMPARISON_TAB_CACHE.get(key);
  if (cached && Date.now() - cached.cachedAt < COMPARISON_CACHE_TTL_MS) {
    return cached.payload;
  }
  try {
    return await fetchComparisonTabPayload(clientName, tabName);
  } catch (_) {
    return null;
  }
}

export function makeVirtualCacheKey(sheetRole, clientName, tabName) {
  return `${sheetRole}::${String(clientName || "").trim().toLowerCase()}::${tabName}`;
}

export function invalidateVirtualModalCache(sheetRole = "", clientName = "") {
  const cleanClient = String(clientName || "").trim().toLowerCase();
  if (!sheetRole && !cleanClient) {
    VIRTUAL_TAB_CACHE.clear();
    return;
  }
  const prefix = sheetRole
    ? cleanClient
      ? `${sheetRole}::${cleanClient}::`
      : `${sheetRole}::`
    : "";
  for (const key of VIRTUAL_TAB_CACHE.keys()) {
    if (prefix) {
      if (key.startsWith(prefix)) VIRTUAL_TAB_CACHE.delete(key);
    } else if (cleanClient && key.includes(`::${cleanClient}::`)) {
      VIRTUAL_TAB_CACHE.delete(key);
    }
  }
}

export async function fetchVirtualTabPayload({
  sheetRole,
  clientName,
  tabName,
  maxRows,
  maxCols,
}) {
  const key = makeVirtualCacheKey(sheetRole, clientName, tabName);
  if (VIRTUAL_INFLIGHT.has(key)) {
    return VIRTUAL_INFLIGHT.get(key);
  }
  const promise = (async () => {
    const res = await fetch("/api/pma/master-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_tab_grid",
        clientName,
        sheetRole,
        tabName,
        maxRows,
        maxCols,
        includeFormulas: true,
        includeRawValues: true,
        includeNotes: true,
        trimTrailingEmptyRows: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Failed to load ${tabName}.`);
    }
    const payload = normalizeVirtualGridPayload(data);
    VIRTUAL_TAB_CACHE.set(key, { payload, cachedAt: Date.now() });
    return payload;
  })().finally(() => {
    VIRTUAL_INFLIGHT.delete(key);
  });
  VIRTUAL_INFLIGHT.set(key, promise);
  return promise;
}

export async function prefetchVirtualTab({
  sheetRole,
  clientName,
  tabName,
  maxRows,
  maxCols,
}) {
  if (!clientName || !tabName) return null;
  const key = makeVirtualCacheKey(sheetRole, clientName, tabName);
  const cached = VIRTUAL_TAB_CACHE.get(key);
  if (cached && Date.now() - cached.cachedAt < VIRTUAL_CACHE_TTL_MS) {
    return cached.payload;
  }
  try {
    return await fetchVirtualTabPayload({ sheetRole, clientName, tabName, maxRows, maxCols });
  } catch (_) {
    return null;
  }
}

function getClientLastMaxRows_(tabName) {
  if (tabName === "Confirmed") return 5002;
  if (tabName === "Pipeline") return 1000;
  return 1200;
}

export function invalidateClientSheetModalCache(clientName = "") {
  invalidateVirtualModalCache("client", clientName);
  const clean = String(clientName || "").trim().toLowerCase();
  if (!clean) {
    CLIENT_KEYINFO_CACHE.clear();
  } else {
    CLIENT_KEYINFO_CACHE.delete(clean);
  }
}

export async function prefetchClientSheetTab(clientName, tabName) {
  const spec = CLIENT_SHEET_SPECS[tabName] || CLIENT_SHEET_SPECS.Confirmed;
  return prefetchVirtualTab({
    sheetRole: "client",
    clientName,
    tabName,
    maxRows: getClientLastMaxRows_(tabName),
    maxCols: spec?.totalCols || 200,
  });
}

export function invalidateReconSheetModalCache(clientName = "") {
  invalidateVirtualModalCache("recon", clientName);
  const clean = String(clientName || "").trim().toLowerCase();
  if (!clean) {
    RECON_DATA_CACHE.clear();
  } else {
    RECON_DATA_CACHE.delete(clean);
  }
}

export async function prefetchReconSheetTab(clientName, tabName) {
  if (!tabName) return null;
  const spec = getReconTabSpec(tabName);
  return prefetchVirtualTab({
    sheetRole: "recon",
    clientName,
    tabName,
    maxRows: 500,
    maxCols: spec.totalCols || 119,
  });
}
