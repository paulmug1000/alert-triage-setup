import React, { useState, useEffect, useRef } from "react";

export default function DeepDivePopover({
  isOpen,
  targetRect,
  title,
  period,
  total,
  items = [],
  sections = null,
  onClose,
}) {
  const popoverRef = useRef(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [openAccordions, setOpenAccordions] = useState({});

  // Initialize all accordion sections to collapsed by default matching original app (WebApp.html line 16304)
  useEffect(() => {
    setOpenAccordions({});
  }, [sections]);

  const toggleAccordion = (key) => {
    setOpenAccordions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Calculate smart position relative to window
  useEffect(() => {
    if (!isOpen || !targetRect) return;

    const popoverWidth = 380;
    const popoverHeight = 360;
    const padding = 12;

    const scrollY = window.scrollY || window.pageYOffset;
    const scrollX = window.scrollX || window.pageXOffset;

    let left = targetRect.left + (targetRect.width / 2) - (popoverWidth / 2) + scrollX;
    let top = targetRect.bottom + 8 + scrollY;

    // Viewport bounds check
    const maxLeft = window.innerWidth - popoverWidth - padding;
    if (left < padding) left = padding;
    if (left > maxLeft) left = maxLeft;

    // Check if overflows viewport bottom -> place above cell
    if (targetRect.bottom + popoverHeight > window.innerHeight) {
      const topAbove = targetRect.top - popoverHeight - 8 + scrollY;
      if (topAbove > scrollY + padding) {
        top = topAbove;
      }
    }

    setPosition({ top, left });
  }, [isOpen, targetRect]);

  // Click outside and escape key dismiss
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };

    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    const timer = setTimeout(() => {
      document.addEventListener("click", handleClickOutside);
    }, 50);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleClickOutside);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "") return "£0";
    if (typeof val === "number") {
      return (
        (val < 0 ? "-" : "") +
        "£" +
        Math.abs(Math.round(val)).toLocaleString("en-GB")
      );
    }
    const cleanStr = String(val).replace(/[£,]/g, "").trim();
    const num = parseFloat(cleanStr);
    if (isNaN(num)) return String(val);
    return (
      (num < 0 ? "-" : "") +
      "£" +
      Math.abs(Math.round(num)).toLocaleString("en-GB")
    );
  };

  const hasSections = Array.isArray(sections) && sections.length > 0;

  const filteredItems = items.filter((item) => {
    if (!searchTerm.trim()) return true;
    const q = searchTerm.toLowerCase().trim();
    return (
      (item.name && item.name.toLowerCase().includes(q)) ||
      (item.client && item.client.toLowerCase().includes(q)) ||
      (item.detail && item.detail.toLowerCase().includes(q))
    );
  });

  return (
    <div className="deep-dive-backdrop" onClick={onClose}>
      <div
        ref={popoverRef}
        className="deep-dive-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: `${position.top}px`,
          left: `${position.left}px`,
          width: "380px",
          maxHeight: "80vh",
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "8px",
          boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.08)",
          zIndex: 9999,
          fontFamily: "'Kumbh Sans', sans-serif",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "popoverIn 0.15s ease-out forwards",
        }}
      >
        <style>{`
          @keyframes popoverIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes sheetSlideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
          @media (max-width: 768px) {
            .deep-dive-backdrop {
              position: fixed !important;
              top: 0 !important;
              left: 0 !important;
              right: 0 !important;
              bottom: 0 !important;
              background: rgba(0, 0, 0, 0.45) !important;
              backdrop-filter: blur(2px) !important;
              z-index: 10000 !important;
              display: flex !important;
              align-items: flex-end !important;
              justify-content: center !important;
            }
            .deep-dive-box {
              position: relative !important;
              top: auto !important;
              left: auto !important;
              width: 100% !important;
              max-width: 500px !important;
              max-height: 85vh !important;
              border-radius: 16px 16px 0 0 !important;
              border-bottom: none !important;
              box-shadow: 0 -8px 25px rgba(0, 0, 0, 0.2) !important;
              animation: sheetSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
            }
            .deep-dive-pull-handle {
              display: block !important;
            }
          }
          @media (min-width: 769px) {
            .deep-dive-pull-handle {
              display: none !important;
            }
          }
        `}</style>

        {/* Mobile Pull Handle */}
        <div
          className="deep-dive-pull-handle"
          style={{
            width: "36px",
            height: "4px",
            borderRadius: "2px",
            background: "#cbd5e1",
            margin: "8px auto 2px auto",
          }}
        />

        {/* Header: Clean White Layout Matching Original WebApp */}
        <div
          style={{
            background: "#ffffff",
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#0047AB", letterSpacing: "-0.2px" }}>
            {title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {total !== undefined && (
              <div style={{ fontSize: "16px", fontWeight: 700, color: "#0047AB" }}>
                {formatGBP(total)}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: "none",
                color: "#64748b",
                fontSize: "18px",
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: "4px",
                lineHeight: 1
              }}
            >
              ✕
            </button>
          </div>
        </div>

      {/* Content Area */}
      <div
        style={{
          maxHeight: "70vh",
          overflowY: "auto",
          padding: hasSections ? "12px" : "6px 0",
        }}
      >
        {/* Render Sections (Staff Costs etc. with Expandable Cards) */}
        {hasSections ? (
          <div>
            {sections.map((sec, sIdx) => {
              const secKey = sec.key || sIdx;
              const isAccordion = Boolean(sec.isAccordion);
              const isExpanded = Boolean(openAccordions[secKey]);
              const isAdjustment = Boolean(sec.isAdjustment);

              if (isAdjustment) {
                return (
                  <div
                    key={secKey}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "6px 14px",
                      color: "#64748b",
                      fontStyle: "italic",
                      fontSize: "12px",
                      borderTop: "1px dashed #e5e7eb",
                      marginTop: "6px",
                    }}
                  >
                    <span>{sec.title}</span>
                    <span style={{ fontWeight: 600, color: "#0047AB" }}>{formatGBP(sec.amount)}</span>
                  </div>
                );
              }

              if (isAccordion) {
                return (
                  <div
                    key={secKey}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      background: "#ffffff",
                      marginBottom: "8px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      onClick={() => toggleAccordion(secKey)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 14px",
                        background: "#f8fafc",
                        cursor: "pointer",
                        fontWeight: 600,
                        color: "#0047AB",
                        fontSize: "14px",
                        userSelect: "none",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span
                          style={{
                            fontSize: "10px",
                            transition: "transform 0.15s",
                            transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                            display: "inline-block",
                          }}
                        >
                          ▼
                        </span>
                        <span>{sec.title}</span>
                      </div>
                      <span>{formatGBP(sec.amount)}</span>
                    </div>

                    {isExpanded && (
                      <div style={{ borderTop: "1px solid #e5e7eb" }}>
                        {(!sec.items || sec.items.length === 0) ? (
                          <div style={{ padding: "10px 14px", color: "#94a3b8", fontSize: "12px" }}>
                            None in this period
                          </div>
                        ) : (
                          sec.items.map((item, iIdx) => (
                            <div
                              key={iIdx}
                              style={{
                                padding: "10px 14px",
                                borderBottom: iIdx === sec.items.length - 1 ? "none" : "1px solid #f1f5f9",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                fontSize: "13px",
                              }}
                            >
                              <div style={{ color: "#111827", fontWeight: 500, paddingRight: "10px" }}>
                                {item.name}{item.role ? ` – ${item.role}` : ""}
                              </div>
                              <div style={{ fontWeight: 600, color: "#0047AB", whiteSpace: "nowrap" }}>
                                {formatGBP(item.amount)}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              if (sec.isAdjustment) {
                return (
                  <div
                    key={secKey}
                    style={{
                      border: "1px dashed #cbd5e1",
                      borderRadius: "6px",
                      background: "#f8fafc",
                      marginBottom: "8px",
                      padding: "8px 14px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: "13px",
                    }}
                  >
                    <span style={{ color: "#64748b", fontStyle: "italic", fontSize: "12px" }}>{sec.title}</span>
                    <span style={{ fontWeight: 700, color: "#0047AB" }}>{formatGBP(sec.amount)}</span>
                  </div>
                );
              }

              // Flat Section (e.g. Dividends as salary, Making up CoS, Profit share)
              return (
                <div
                  key={secKey}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: "6px",
                    background: "#f8fafc",
                    marginBottom: "8px",
                    padding: "10px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontWeight: 600,
                    color: "#0047AB",
                    fontSize: "14px",
                    userSelect: "none",
                  }}
                >
                  <span>{sec.title}</span>
                  <span>{formatGBP(sec.amount)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          /* Render Regular List (Revenue, Expenses, Cash receipts, Net Payroll/HMRC/Pension) */
          <div>
            {filteredItems.length === 0 ? (
              <div style={{ padding: "2rem 1rem", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                No individual items recorded for this period
              </div>
            ) : (
              filteredItems.map((item, idx) => {
                const isAdjustment =
                  item.name === "Manual adjustment" ||
                  item.name === "Rounding adjustment" ||
                  item.name === "Scenario adjustment" ||
                  item.name === "Manual scenario adjustment";

                if (isAdjustment) {
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: "8px 16px",
                        borderTop: "1px dashed #cbd5e1",
                        background: "#f8fafc",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: "12px",
                      }}
                    >
                      <div style={{ color: "#64748b", fontStyle: "italic", fontSize: "11.5px" }}>
                        {item.name}
                      </div>
                      <div style={{ fontWeight: 700, color: "#0047AB", fontSize: "13px" }}>
                        {formatGBP(item.amount)}
                      </div>
                    </div>
                  );
                }

                const hasCashMeta = Boolean(item.payDateStr || item.desc || item.status);

                return (
                  <div
                    key={idx}
                    style={{
                      padding: "8px 16px",
                      borderBottom: idx === filteredItems.length - 1 ? "none" : "1px solid #f1f5f9",
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "10px",
                      fontSize: "12px",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: "#111827", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        {item.client ? (
                          <span>
                            <span style={{ fontWeight: 600, color: "#0f172a" }}>{item.client}</span>
                            <span style={{ color: "#64748b" }}> – {item.name}</span>
                          </span>
                        ) : (
                          <span>{item.name}</span>
                        )}
                        {/* Note: All pill labels/badges removed per user instruction */}
                      </div>

                      {hasCashMeta ? (
                        <div style={{ color: "#64748b", fontSize: "11px", marginTop: "2px" }}>
                          {item.isPipeline ? (
                            <span>Expected: {item.payDateStr}</span>
                          ) : (
                            <span>
                              {item.desc && <em style={{ fontStyle: "normal", color: "#475569" }}>{item.desc}</em>}
                              {item.desc ? " | " : ""}
                              Expected: {item.payDateStr}
                              {item.status ? ` | ${item.status}` : ""}
                            </span>
                          )}
                        </div>
                      ) : item.detail ? (
                        <div style={{ color: "#64748b", fontSize: "11px", marginTop: "2px" }}>
                          {item.detail}
                        </div>
                      ) : null}
                    </div>

                    <div
                      style={{
                        fontWeight: 700,
                        color: "#0047AB",
                        whiteSpace: "nowrap",
                        textAlign: "right",
                        fontSize: "13px",
                      }}
                    >
                      {formatGBP(item.amount)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  </div>
  );
}
