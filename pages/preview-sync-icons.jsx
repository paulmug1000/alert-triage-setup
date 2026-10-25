import React, { useState } from "react";
import Head from "next/head";

// ============================================================================
// SVG ICON DEFINITIONS
// ============================================================================

function SyncLoopIcon({ size = 12, color = "currentColor", strokeWidth = 2.2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloudSyncIcon({ size = 13, color = "currentColor", strokeWidth = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M8 15h4v4" />
      <path d="m12 15-3-3" />
    </svg>
  );
}

function LinkIcon({ size = 12, color = "currentColor", strokeWidth = 2.2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function ExchangeArrowsIcon({ size = 12, color = "currentColor", strokeWidth = 2.2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <polyline points="17 4 21 8 17 12" />
      <path d="M21 8H9a4 4 0 0 0-4 4v1" />
      <polyline points="7 20 3 16 7 12" />
      <path d="M3 16h12a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}

const OPTIONS = [
  {
    id: "loop",
    title: "Option 1: Classic Sync Loop",
    subtitle: "Universal two-arrow circular refresh loop",
    badgeLabel: "Recommended",
    Icon: SyncLoopIcon,
    description: "The most widely understood symbol for live data synchronization. Clean, unambiguous, and visually balanced.",
  },
  {
    id: "cloud",
    title: "Option 2: Cloud Sync",
    subtitle: "Cloud outline with internal sync arrow",
    badgeLabel: "SaaS Native",
    Icon: CloudSyncIcon,
    description: "Explicitly signals that the data originates from an external upstream cloud tool (ClickUp, HubSpot, Pipedrive).",
  },
  {
    id: "link",
    title: "Option 3: Integration Link",
    subtitle: "Two interlocking chain links",
    badgeLabel: "Subtle",
    Icon: LinkIcon,
    description: "Represents an external record link or mapping without implying continuous movement or animation.",
  },
  {
    id: "exchange",
    title: "Option 4: Data Exchange",
    subtitle: "Opposing horizontal directional arrows",
    badgeLabel: "Compact",
    Icon: ExchangeArrowsIcon,
    description: "Technical, geometric representation of bi-directional data flow between CRM and Pulse.",
  },
];

export default function PreviewSyncIconsPage() {
  const [activePlacement, setActivePlacement] = useState("both"); // 'both' | 'inside' | 'beside'
  const [hoveredOption, setHoveredOption] = useState(null);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#f8fafc", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", color: "#0f172a", padding: "2rem 1.5rem" }}>
      <Head>
        <title>Sync Icon Options Preview - Pulse</title>
      </Head>

      <div style={{ maxWidth: "1180px", margin: "0 auto" }}>
        {/* Header */}
        <header style={{ marginBottom: "2rem", borderBottom: "1px solid #e2e8f0", paddingBottom: "1.5rem" }}>
          <div style={{ display: "inline-block", background: "#e0f2fe", color: "#0369a1", fontSize: "11.5px", fontWeight: 700, padding: "3px 10px", borderRadius: "20px", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.5rem" }}>
            Design Comparison
          </div>
          <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#0f172a", margin: "0 0 0.5rem 0" }}>
            CRM Sync Icon Options
          </h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: "14.5px", maxWidth: "720px", lineHeight: 1.5 }}>
            Visual preview of the four proposed icon concepts to represent CRM-synced jobs across both the Pulse Portal and PMA jobs lists. Hover over any pill or badge to test tooltips.
          </p>

          {/* Filter Bar */}
          <div style={{ marginTop: "1.25rem", display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "#475569" }}>Placement view:</span>
            <button
              type="button"
              onClick={() => setActivePlacement("both")}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12.5px",
                fontWeight: 600,
                border: "1px solid",
                borderColor: activePlacement === "both" ? "#0047AB" : "#cbd5e1",
                background: activePlacement === "both" ? "#0047AB" : "#ffffff",
                color: activePlacement === "both" ? "#ffffff" : "#475569",
                cursor: "pointer",
              }}
            >
              Side-by-side comparison
            </button>
            <button
              type="button"
              onClick={() => setActivePlacement("inside")}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12.5px",
                fontWeight: 600,
                border: "1px solid",
                borderColor: activePlacement === "inside" ? "#0047AB" : "#cbd5e1",
                background: activePlacement === "inside" ? "#0047AB" : "#ffffff",
                color: activePlacement === "inside" ? "#ffffff" : "#475569",
                cursor: "pointer",
              }}
            >
              Inside pill only
            </button>
            <button
              type="button"
              onClick={() => setActivePlacement("beside")}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "12.5px",
                fontWeight: 600,
                border: "1px solid",
                borderColor: activePlacement === "beside" ? "#0047AB" : "#cbd5e1",
                background: activePlacement === "beside" ? "#0047AB" : "#ffffff",
                color: activePlacement === "beside" ? "#ffffff" : "#475569",
                cursor: "pointer",
              }}
            >
              Beside pill only
            </button>
          </div>
        </header>

        {/* 4 Cards Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(265px, 1fr))", gap: "1.25rem", marginBottom: "2.5rem" }}>
          {OPTIONS.map((opt) => {
            const Icon = opt.Icon;
            return (
              <div
                key={opt.id}
                style={{
                  background: "#ffffff",
                  borderRadius: "10px",
                  border: "1px solid #e2e8f0",
                  padding: "1.25rem",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.03)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                    <div style={{ width: "36px", height: "36px", borderRadius: "8px", background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Icon size={18} />
                    </div>
                    <span style={{ fontSize: "11px", fontWeight: 700, background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "10px" }}>
                      {opt.badgeLabel}
                    </span>
                  </div>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", margin: "0 0 4px 0" }}>
                    {opt.title}
                  </h3>
                  <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "0.75rem" }}>
                    {opt.subtitle}
                  </div>
                  <p style={{ fontSize: "12.5px", color: "#334155", margin: 0, lineHeight: 1.45 }}>
                    {opt.description}
                  </p>
                </div>

                {/* Micro previews */}
                <div style={{ marginTop: "1rem", paddingTop: "0.85rem", borderTop: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>Quick preview</div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    {/* Inside pill */}
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      <span
                        title="Synced with ClickUp"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          padding: "2px 8px",
                          borderRadius: "10px",
                          fontSize: "11.5px",
                          fontWeight: 700,
                          background: "#e0f2fe",
                          color: "#0369a1",
                          cursor: "pointer",
                        }}
                      >
                        <span>Pipeline</span>
                        <Icon size={11} color="#0284c7" />
                      </span>
                    </div>

                    {/* Beside pill */}
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "10px",
                          fontSize: "11.5px",
                          fontWeight: 700,
                          background: "#e0f2fe",
                          color: "#0369a1",
                        }}
                      >
                        Pipeline
                      </span>
                      <span
                        title="Synced with ClickUp"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "20px",
                          height: "20px",
                          borderRadius: "50%",
                          background: "#f1f5f9",
                          color: "#475569",
                          border: "1px solid #cbd5e1",
                          cursor: "pointer",
                        }}
                      >
                        <Icon size={11} />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Real Table Context: Pulse Portal Style */}
        <section style={{ marginBottom: "2.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Live Table View - Pulse Portal Style
            </h2>
            <span style={{ fontSize: "12px", color: "#64748b" }}>Shows how each option sits in the actual 8-column client jobs table</span>
          </div>

          <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", overflow: "hidden", boxShadow: "0 2px 4px rgba(0,0,0,0.03)" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: "13.5px" }}>
              <thead style={{ background: "#0047AB", color: "#ffffff" }}>
                <tr>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, width: "16%" }}>Status</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, width: "32%" }}>Client & Job Name</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", fontWeight: 700, width: "10%" }}>Type</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", fontWeight: 700, width: "14%" }}>Revenue</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", fontWeight: 700, width: "14%" }}>Start Date</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", fontWeight: 700, width: "14%" }}>Likelihood</th>
                </tr>
              </thead>
              <tbody>
                {OPTIONS.map((opt, idx) => {
                  const Icon = opt.Icon;
                  return (
                    <tr
                      key={opt.id}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                    >
                      {/* Status Column with Icon */}
                      <td style={{ padding: "12px 14px", verticalAlign: "middle" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          {/* Inside pill */}
                          {(activePlacement === "both" || activePlacement === "inside") && (
                            <span
                              title="Synced with ClickUp"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                                padding: "2.5px 9px",
                                borderRadius: "12px",
                                fontSize: "11.5px",
                                fontWeight: 700,
                                background: "#e0f2fe",
                                color: "#0369a1",
                                border: "1px solid #bae6fd",
                                cursor: "pointer",
                              }}
                            >
                              <span>Pipeline</span>
                              <Icon size={11} color="#0284c7" />
                            </span>
                          )}

                          {/* Beside pill */}
                          {(activePlacement === "both" || activePlacement === "beside") && (
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                              <span
                                style={{
                                  padding: "2.5px 9px",
                                  borderRadius: "12px",
                                  fontSize: "11.5px",
                                  fontWeight: 700,
                                  background: "#e0f2fe",
                                  color: "#0369a1",
                                  border: "1px solid #bae6fd",
                                }}
                              >
                                Pipeline
                              </span>
                              <span
                                title="Synced with ClickUp"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: "20px",
                                  height: "20px",
                                  borderRadius: "50%",
                                  background: "#f1f5f9",
                                  color: "#475569",
                                  border: "1px solid #cbd5e1",
                                  cursor: "pointer",
                                }}
                              >
                                <Icon size={11} />
                              </span>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Job details */}
                      <td style={{ padding: "12px 14px", verticalAlign: "middle" }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>Acme Global Brands</div>
                        <div style={{ color: "#64748b", fontSize: "12.5px" }}>Q1 Growth Strategy - {opt.title}</div>
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "center", verticalAlign: "middle" }}>
                        <span style={{ padding: "2px 7px", borderRadius: "4px", fontSize: "12px", fontWeight: 600, background: "#f1f5f9", color: "#475569" }}>
                          Project
                        </span>
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "right", fontWeight: 700, color: "#0047AB", verticalAlign: "middle" }}>
                        £25,000
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "center", color: "#64748b", fontSize: "12.5px", verticalAlign: "middle" }}>
                        01-Nov-26
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "center", verticalAlign: "middle" }}>
                        <span style={{ padding: "2px 8px", borderRadius: "10px", fontSize: "12px", fontWeight: 700, background: "#fef3c7", color: "#b45309" }}>
                          50%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Real Table Context: PMA Style */}
        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
              Live Table View - PMA Modern Jobs Style
            </h2>
            <span style={{ fontSize: "12px", color: "#64748b" }}>Shows how each option sits in PMA expandable rows</span>
          </div>

          <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", overflow: "hidden", boxShadow: "0 2px 4px rgba(0,0,0,0.03)" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: "13px" }}>
              <thead style={{ background: "#f8fafc", color: "#475569", borderBottom: "1px solid #e2e8f0" }}>
                <tr>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, width: "18%" }}>Status</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, width: "32%" }}>Client / Job</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, width: "16%" }}>Type</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", fontWeight: 700, width: "18%" }}>Revenue</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", fontWeight: 700, width: "16%" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {OPTIONS.map((opt, idx) => {
                  const Icon = opt.Icon;
                  return (
                    <tr
                      key={opt.id}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: idx % 2 === 0 ? "#ffffff" : "#fbfcfe",
                      }}
                    >
                      {/* Status Column */}
                      <td style={{ padding: "12px 14px", verticalAlign: "middle" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span
                            title="Synced with ClickUp"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              padding: "2px 8px",
                              borderRadius: "12px",
                              fontSize: "11px",
                              fontWeight: "600",
                              background: "#e0f2fe",
                              color: "#0369a1",
                              border: "1px solid #bae6fd",
                              cursor: "pointer",
                            }}
                          >
                            <span>Pipeline</span>
                            <Icon size={11} color="#0284c7" />
                          </span>

                          <span
                            title="Synced with ClickUp"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: "2px 6px",
                              borderRadius: "10px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: "#f1f5f9",
                              color: "#475569",
                              border: "1px solid #cbd5e1",
                              cursor: "pointer",
                              gap: "4px",
                            }}
                          >
                            <Icon size={10} />
                            <span>ClickUp</span>
                          </span>
                        </div>
                      </td>

                      <td style={{ padding: "12px 14px", verticalAlign: "middle" }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>Starlight Enterprise</div>
                        <div style={{ color: "#64748b", fontSize: "12px" }}>Annual Contract Review</div>
                      </td>

                      <td style={{ padding: "12px 14px", verticalAlign: "middle" }}>
                        <span style={{ fontSize: "12px", color: "#334155" }}>Project</span>
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "right", fontWeight: 700, color: "#0f172a", verticalAlign: "middle" }}>
                        £18,500.00
                      </td>

                      <td style={{ padding: "12px 14px", textAlign: "center", verticalAlign: "middle" }}>
                        <span style={{ fontSize: "11px", color: "#64748b", background: "#f1f5f9", padding: "3px 8px", borderRadius: "4px", cursor: "pointer" }}>
                          Expand ▾
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Footer info */}
        <footer style={{ marginTop: "2.5rem", padding: "1.25rem", background: "#f1f5f9", borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "13px", color: "#475569", lineHeight: 1.5 }}>
          <strong>How to test:</strong> Hover over any of the badges or icons above to observe the interactive tooltip (<em>&ldquo;Synced with ClickUp&rdquo;</em>). Tell me which option (1, 2, 3, or 4) and which placement (inside the pill vs beside the pill) you prefer, and I will apply it across the app.
        </footer>
      </div>
    </div>
  );
}
