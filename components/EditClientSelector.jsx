import React, { useState, useMemo } from "react";
import Spinner from "./Spinner";

/**
 * EditClientSelector
 * Standardized client selector box for all PMA "Edit" menu screens.
 * Displays clients in alphabetical order in clickable boxes with search filtering.
 */
export default function EditClientSelector({
  clients = [],
  onSelectClient,
  loading = false,
  title = "Select a client:",
  renderExtra = null,
  renderHeaderExtra = null,
  searchPlaceholder = "Search clients...",
  emptyMessage = "No clients loaded yet - go to Home and refresh first.",
}) {
  const [search, setSearch] = useState("");

  const sortedClients = useMemo(() => {
    return [...clients].sort((a, b) =>
      (a.clientName || "").localeCompare(b.clientName || "")
    );
  }, [clients]);

  const filteredClients = useMemo(() => {
    if (!search.trim()) return sortedClients;
    const q = search.toLowerCase().trim();
    return sortedClients.filter((c) =>
      (c.clientName || "").toLowerCase().includes(q)
    );
  }, [sortedClients, search]);

  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "24px",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
      }}
    >
      {loading ? (
        <div style={{ textAlign: "center", color: "#64748b", padding: "36px 20px" }}>
          <Spinner size={24} color="#0047AB" />
          <div style={{ marginTop: "10px", fontSize: "13px" }}>Loading...</div>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
              marginBottom: "16px",
            }}
          >
            <p style={{ margin: 0, fontSize: "14px", fontWeight: 600, color: "#334155" }}>
              {title}
            </p>
            {renderHeaderExtra && <div>{renderHeaderExtra}</div>}
          </div>

          {/* Search bar */}
          {sortedClients.length > 5 && (
            <div style={{ marginBottom: "14px", position: "relative" }}>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                style={{
                  width: "100%",
                  padding: "9px 36px 9px 12px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                  background: "#f8fafc",
                  color: "#1e293b",
                }}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    color: "#94a3b8",
                    cursor: "pointer",
                    fontSize: "14px",
                    padding: 0,
                    lineHeight: 1,
                  }}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {/* Client List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {filteredClients.map((c) => {
              const extra = renderExtra ? renderExtra(c) : null;
              return (
                <button
                  key={c.clientName || c.name}
                  type="button"
                  onClick={() => onSelectClient(c)}
                  style={{
                    textAlign: "left",
                    padding: "12px 18px",
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "#1e293b",
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    transition: "all 0.15s ease",
                    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.02)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f8fafc";
                    e.currentTarget.style.borderColor = "#94a3b8";
                    e.currentTarget.style.transform = "translateX(2px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "#ffffff";
                    e.currentTarget.style.borderColor = "#e2e8f0";
                    e.currentTarget.style.transform = "none";
                  }}
                >
                  <span>{c.clientName || c.name}</span>
                  {extra ? (
                    <div>{extra}</div>
                  ) : (
                    <span style={{ color: "#94a3b8", fontSize: "16px", lineHeight: 1 }}>
                      →
                    </span>
                  )}
                </button>
              );
            })}

            {filteredClients.length === 0 && sortedClients.length > 0 && (
              <p style={{ color: "#64748b", fontSize: "13px", padding: "12px 0", margin: 0 }}>
                No clients match &ldquo;{search}&rdquo;.
              </p>
            )}

            {sortedClients.length === 0 && (
              <p style={{ color: "#94a3b8", fontSize: "13px", margin: 0, padding: "12px 0" }}>
                {emptyMessage}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
