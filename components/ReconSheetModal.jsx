import React, { useCallback } from "react";
import FormattedVirtualSheetModal from "./FormattedVirtualSheetModal";
import {
  getReconTabSpec,
  getReconCellPresentation,
  formatCellForReconSheet,
  formatReconYYMMMonthLabel,
} from "../utils/reconSheetSpecs";
import {
  RECON_DATA_CACHE,
  RECON_DATA_TTL_MS,
  invalidateReconSheetModalCache,
  prefetchReconSheetTab,
} from "../utils/sheetModalCache";
export { invalidateReconSheetModalCache, prefetchReconSheetTab };

async function fetchReconDynamicLists(clientName, tabName, valuesGrid) {
  const categories = [];
  if (Array.isArray(valuesGrid)) {
    for (let r = 2; r <= 15; r++) {
      const v = String(valuesGrid[r]?.[20] ?? "").trim();
      if (v && !categories.includes(v)) categories.push(v);
    }
  }

  const clean = String(clientName || "").trim().toLowerCase();
  let dataLists = {};
  const cached = clean ? RECON_DATA_CACHE.get(clean) : null;
  if (cached && Date.now() - cached.cachedAt < RECON_DATA_TTL_MS) {
    dataLists = cached.lists;
  } else if (clean) {
    try {
      const res = await fetch("/api/pma/master-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "get_tab_grid",
          clientName,
          sheetRole: "recon",
          tabName: "Data",
          maxRows: 350,
          maxCols: 5,
          includeFormulas: false,
          includeRawValues: false,
          includeNotes: false,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.valuesGrid)) {
        const g = data.valuesGrid;
        const plCategories = [];
        for (let r = 0; r < Math.min(g.length, 350); r++) {
          const v = String(g[r]?.[0] ?? "").trim();
          if (v && !plCategories.includes(v)) plCategories.push(v);
        }
        const monthChoices = [];
        for (let r = 0; r < Math.min(g.length, 36); r++) {
          const v = String(g[r]?.[2] ?? "").trim();
          if (v && !monthChoices.includes(v)) monthChoices.push(v);
        }
        dataLists = {
          "=Data!$A$1:$A$350": plCategories,
          "=Data!$C$1:$C$36": monthChoices,
        };
        RECON_DATA_CACHE.set(clean, { lists: dataLists, cachedAt: Date.now() });
      }
    } catch (_) {
      dataLists = {};
    }
  }

  return {
    ...dataLists,
    ...(categories.length > 0 ? { "=Template!$U$3:$U$16": categories } : {}),
  };
}

function getReconLastActiveRowIdx(_tabName, valuesGrid) {
  if (!Array.isArray(valuesGrid) || valuesGrid.length === 0) return 99;
  for (let r = valuesGrid.length - 1; r >= 99; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== false) {
        const s = String(v).trim();
        if (s !== "" && s.toUpperCase() !== "FALSE") {
          return Math.min(valuesGrid.length - 1, r + 5);
        }
      }
    }
  }
  return Math.min(valuesGrid.length - 1, 99);
}

export default function ReconSheetModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  reconTabs = [],
  initialTab = "",
  onAfterMutate,
}) {
  const getMaxRows = useCallback(() => 500, []);
  const getTabWidthKey = useCallback(() => "Recon", []);
  const getCellPresentation = useCallback(
    ({ r, c, rawValue, displayValue, dynamicLists }) =>
      getReconCellPresentation({ r, c, rawValue, displayValue, dynamicLists }),
    []
  );

  return (
    <FormattedVirtualSheetModal
      isOpen={isOpen}
      onClose={onClose}
      clientName={clientName}
      sheetRole="recon"
      tabs={reconTabs}
      initialTab={initialTab || reconTabs[0] || ""}
      badgeLabel="Supabase recon sheet"
      subtitle="Formatted monthly bank reconciliation view with template styling, conditional formatting, formulas, and interactive editing"
      getSpec={getReconTabSpec}
      getCellPresentation={getCellPresentation}
      formatCell={formatCellForReconSheet}
      getMaxRows={getMaxRows}
      getLastActiveRowIdx={getReconLastActiveRowIdx}
      getDynamicLists={fetchReconDynamicLists}
      getTabWidthKey={getTabWidthKey}
      formatTabSublabel={formatReconYYMMMonthLabel}
      defaultRowRenderLimit={400}
      onAfterMutate={onAfterMutate}
    />
  );
}
