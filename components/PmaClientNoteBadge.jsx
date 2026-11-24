import React, { useState, useEffect, useCallback } from "react";
import PulseNotesDrawer from "./portal/PulseNotesDrawer";

/**
 * PmaClientNoteBadge
 * Displays client-facing Pulse notes inside PMA Edit views (distinct from internal cell notes)
 * and opens the shared PulseNotesDrawer against `/api/pma/notes`.
 */
export default function PmaClientNoteBadge({
  clientName = "",
  entityType = "",
  entityKey = "",
  parentEntityKey = "",
  entityLabel = "",
  includeChildren = false,
  label = "Client notes",
  user = null,
}) {
  const [summary, setSummary] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!clientName) return;
    try {
      const res = await fetch(`/api/pma/notes?mode=summary&clientName=${encodeURIComponent(clientName)}`);
      const data = await res.json();
      if (data?.success) {
        setSummary(data);
      }
    } catch {
      // Non-fatal
    }
  }, [clientName]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  if (!clientName) return null;

  let count = 0;
  let openCount = 0;

  if (summary) {
    if (entityKey) {
      const direct = summary.byEntityKey?.[entityKey];
      const child = includeChildren ? summary.byParentKey?.[entityKey] : null;
      count = (direct?.count || 0) + (child?.count || 0);
      openCount = (direct?.openNotifyCount || 0) + (child?.openNotifyCount || 0);
    } else if (entityType) {
      // Aggregate all notes for this client (or open count)
      count = Number(summary.totalCount || 0);
      openCount = Number(summary.openNotifyCount || 0);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDrawerOpen(true);
        }}
        title={count > 0 ? `${count} client note${count === 1 ? "" : "s"}` : "View client notes"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 10px",
          borderRadius: "6px",
          border: `1px solid ${openCount > 0 ? "#93c5fd" : count > 0 ? "#bfdbfe" : "#cbd5e1"}`,
          background: openCount > 0 ? "#eff6ff" : count > 0 ? "#f8fafc" : "#ffffff",
          color: openCount > 0 ? "#0047AB" : "#334155",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>{label}</span>
        {count > 0 && (
          <span
            style={{
              padding: "0 5px",
              minWidth: "16px",
              height: "16px",
              borderRadius: "999px",
              fontSize: "10.5px",
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: openCount > 0 ? "#dc2626" : "#0047AB",
              color: "#ffffff",
            }}
          >
            {count}
          </span>
        )}
      </button>

      <PulseNotesDrawer
        isOpen={drawerOpen}
        mode={entityKey ? "target" : "all"}
        target={
          entityKey
            ? {
                scopeType: "entity",
                entityType,
                entityKey,
                parentEntityKey: parentEntityKey || (includeChildren ? entityKey : ""),
                includeChildren,
                entityLabel: entityLabel || clientName,
                drawerTitle: "Client notes",
              }
            : null
        }
        initialEntityType={!entityKey ? entityType : ""}
        clientName={clientName}
        user={user}
        apiBase="/api/pma/notes"
        onClose={() => setDrawerOpen(false)}
        onNotesChanged={loadSummary}
      />
    </>
  );
}
