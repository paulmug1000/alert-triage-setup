import React, { useCallback } from "react";
import FormattedVirtualSheetModal from "./FormattedVirtualSheetModal";
import {
  CLIENT_SHEET_TABS,
  CLIENT_SHEET_SPECS,
  getClientCellPresentation,
  formatCellForClientSheet,
} from "../utils/clientSheetSpecs";
import {
  CLIENT_KEYINFO_CACHE,
  KEYINFO_CACHE_TTL_MS,
  getClientMaxRowsForTab,
  invalidateClientSheetModalCache,
  prefetchClientSheetTab,
} from "../utils/sheetModalCache";
export { invalidateClientSheetModalCache, prefetchClientSheetTab };

async function fetchClientKeyInfoLists(clientName, tabName) {
  if (tabName !== "Confirmed" && tabName !== "Pipeline") return {};
  const clean = String(clientName || "").trim().toLowerCase();
  if (!clean) return {};
  const cached = CLIENT_KEYINFO_CACHE.get(clean);
  if (cached && Date.now() - cached.cachedAt < KEYINFO_CACHE_TTL_MS) {
    return cached.lists;
  }
  try {
    const res = await fetch("/api/pma/master-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_tab_grid",
        clientName,
        sheetRole: "client",
        tabName: "KeyInfo",
        maxRows: 80,
        maxCols: 10,
        includeFormulas: false,
        includeRawValues: false,
        includeNotes: false,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.valuesGrid)) return {};
    const grid = data.valuesGrid;
    const prodLines = [];
    for (let r = 22; r <= 36; r++) {
      const v = String(grid[r]?.[2] ?? "").trim();
      if (v && !prodLines.includes(v)) prodLines.push(v);
    }
    const leadSources = [];
    for (let r = 31; r <= 74; r++) {
      const v = String(grid[r]?.[6] ?? "").trim();
      if (v && !leadSources.includes(v)) leadSources.push(v);
    }
    const lists = {
      "=KeyInfo!$C$23:$C$37": prodLines,
      "=KeyInfo!$G$32:$G$75": leadSources,
    };
    CLIENT_KEYINFO_CACHE.set(clean, { lists, cachedAt: Date.now() });
    return lists;
  } catch (_) {
    return {};
  }
}

function getClientLastActiveRowIdx(tabName, valuesGrid, spec) {
  if (!Array.isArray(valuesGrid) || valuesGrid.length === 0) return 20;
  const minRows =
    tabName === "Cash"
      ? 75
      : tabName === "NBtoFind"
        ? 24
        : tabName === "Budget"
          ? 319
          : tabName === "Outgoings"
            ? 305
            : tabName === "Salaries"
              ? 359
              : 25;
  const frozenRows = spec?.frozenRows || 1;
  for (let r = valuesGrid.length - 1; r >= frozenRows; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== false) {
        const s = String(v).trim();
        if (s !== "" && s.toUpperCase() !== "FALSE") {
          return Math.max(minRows, Math.min(valuesGrid.length - 1, r + 5));
        }
      }
    }
  }
  return Math.min(valuesGrid.length - 1, minRows);
}

export default function ClientSheetModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  initialTab = "Confirmed",
  onAfterMutate,
}) {
  const getSpec = useCallback(
    (tabName) => CLIENT_SHEET_SPECS[tabName] || CLIENT_SHEET_SPECS.Confirmed,
    []
  );

  return (
    <FormattedVirtualSheetModal
      isOpen={isOpen}
      onClose={onClose}
      clientName={clientName}
      sheetRole="client"
      tabs={CLIENT_SHEET_TABS}
      initialTab={initialTab}
      badgeLabel="Supabase client sheet"
      subtitle="Formatted client sheet view with source template styling, conditional formatting, formulas, and interactive editing"
      getSpec={getSpec}
      getCellPresentation={getClientCellPresentation}
      formatCell={formatCellForClientSheet}
      getMaxRows={getClientMaxRowsForTab}
      getLastActiveRowIdx={getClientLastActiveRowIdx}
      getDynamicLists={fetchClientKeyInfoLists}
      defaultRowRenderLimit={370}
      onAfterMutate={onAfterMutate}
    />
  );
}
