import React, { useCallback } from "react";
import FormattedVirtualSheetModal from "./FormattedVirtualSheetModal";
import {
  TIME_COMP_SPEC,
  getTimeCompCellPresentation,
  formatCellForTimeComp,
} from "../utils/timeCompSheetSpec";
import {
  invalidateTimeCompModalCache,
  prefetchTimeCompTab,
} from "../utils/sheetModalCache";
export { invalidateTimeCompModalCache, prefetchTimeCompTab };

function getTimeCompLastActiveRowIdx(_tabName, valuesGrid, spec) {
  if (!Array.isArray(valuesGrid) || valuesGrid.length === 0) return 66;
  const frozenRows = spec?.frozenRows || 8;
  for (let r = valuesGrid.length - 1; r >= frozenRows; r--) {
    const row = valuesGrid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined && v !== false) {
        const s = String(v).trim();
        if (s !== "" && s.toUpperCase() !== "FALSE") {
          return Math.max(Math.min(valuesGrid.length - 1, 66), Math.min(valuesGrid.length - 1, r + 5));
        }
      }
    }
  }
  return Math.min(valuesGrid.length - 1, 66);
}

export default function TimeCompSheetModal({
  isOpen,
  onClose,
  clientName = "APPTEST",
  onAfterMutate,
}) {
  const getSpec = useCallback(() => TIME_COMP_SPEC, []);
  const getMaxRows = useCallback(() => 220, []);

  return (
    <FormattedVirtualSheetModal
      isOpen={isOpen}
      onClose={onClose}
      clientName={clientName}
      sheetRole="master"
      tabs={["TimeComp"]}
      initialTab="TimeComp"
      badgeLabel="Supabase master sheet"
      subtitle="Formatted TimeComp view with employee utilisation metrics, On/off toggle, and interactive editing"
      getSpec={getSpec}
      getCellPresentation={getTimeCompCellPresentation}
      formatCell={formatCellForTimeComp}
      getMaxRows={getMaxRows}
      getLastActiveRowIdx={getTimeCompLastActiveRowIdx}
      defaultRowRenderLimit={220}
      onAfterMutate={onAfterMutate}
    />
  );
}
