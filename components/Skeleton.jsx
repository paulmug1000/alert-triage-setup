import React from "react";

/**
 * Embedded Global Styles for CPU-compatible gradient shimmer and breathing animation.
 * Works seamlessly on any system, even with hardware acceleration disabled.
 */
export function SkeletonGlobalStyles() {
  return (
    <style jsx global>{`
      @keyframes pulse-calm-breathe {
        0%, 100% {
          opacity: 1;
        }
        50% {
          opacity: 0.35;
        }
      }
      .pulse-skeleton {
        position: relative;
        background-color: #e2e8f0 !important;
        animation: pulse-calm-breathe 1.8s ease-in-out infinite !important;
      }
      .pulse-skeleton.pulse-skeleton-blue {
        background-color: #dbeafe !important;
      }
      .pulse-skeleton.pulse-skeleton-dark {
        background-color: rgba(255, 255, 255, 0.35) !important;
      }
      @keyframes pulseContentFadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .portal-main-content-wrapper > *:not([data-pulse-skeleton="true"]),
      .pma-main-content-wrapper > *:not([data-pulse-skeleton="true"]) {
        animation: pulseContentFadeIn 0.22s ease-out;
      }
    `}</style>
  );
}

/**
 * Base primitive Skeleton component with neutral grey CPU-accelerated shimmer animation.
 */
export default function Skeleton({
  width = "100%",
  height = "16px",
  borderRadius = "4px",
  circle = false,
  style = {},
  className = "",
}) {
  const inlineStyles = {
    width: circle ? height : width,
    height,
    borderRadius: circle ? "50%" : borderRadius,
    display: "inline-block",
    flexShrink: 0,
    ...style,
  };

  return (
    <>
      <SkeletonGlobalStyles />
      <div className={`pulse-skeleton ${className}`} style={inlineStyles} />
    </>
  );
}

/**
 * Multi-line skeleton text with shorter last line.
 */
export function SkeletonText({
  lines = 3,
  height = 13,
  gap = 8,
  lastLineWidth = "65%",
  style = {},
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: `${gap}px`, width: "100%", ...style }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 && lines > 1 ? lastLineWidth : "100%"}
          height={`${height}px`}
          borderRadius="3px"
        />
      ))}
    </div>
  );
}

/**
 * Clean card shell with subtle grey border and soft shadow.
 */
export function SkeletonCard({ height, padding = "20px", style = {}, children }) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding,
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
        height: height || "auto",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Generalized Table Skeleton with header row and multiple data rows.
 */
export function SkeletonTable({
  rows = 8,
  columns = 4,
  colWidths = [],
  rowHeight = 44,
  showHeader = true,
  style = {},
}) {
  const defaultColWidth = `${100 / columns}%`;

  return (
    <div
      style={{
        width: "100%",
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
        ...style,
      }}
    >
      {showHeader && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "12px 18px",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            gap: "16px",
          }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <div key={c} style={{ width: colWidths[c] || defaultColWidth, minWidth: 0 }}>
              <Skeleton width="60%" height="13px" borderRadius="3px" />
            </div>
          ))}
        </div>
      )}

      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            height: `${rowHeight}px`,
            borderBottom: r === rows - 1 ? "none" : "1px solid #f1f5f9",
            gap: "16px",
          }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <div key={c} style={{ width: colWidths[c] || defaultColWidth, minWidth: 0 }}>
              <Skeleton
                width={c === 0 ? "75%" : c === columns - 1 ? "45%" : "60%"}
                height="13px"
                borderRadius="3px"
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Composite Skeleton for the Monthly Blueprint View (Clean Macro Cards).
 * Low-density structural silhouette with calm breathing animation and 0px layout shift.
 */
export function MonthViewSkeleton() {
  return (
    <div
      data-pulse-skeleton="true"
      className="home-view-container"
      style={{
        width: "100%",
        margin: "0 auto",
        padding: "0.5rem 0 3rem 0",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      {/* Top Action Bar matching MonthView.jsx */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "0 4px",
          minHeight: "38px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "#64748b",
            fontSize: "13px",
            fontWeight: 500,
            fontFamily: "'Kumbh Sans', sans-serif",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "14px",
              height: "14px",
              border: "2px solid #cbd5e1",
              borderTopColor: "#0047AB",
              borderRadius: "50%",
              animation: "pulse-spin 0.8s linear infinite",
            }}
          />
          <span>Loading...</span>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            disabled
            style={{
              background: "transparent",
              border: "none",
              padding: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0047AB",
              borderRadius: "50%",
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: "pulse-spin 1s linear infinite" }}
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button
            type="button"
            disabled
            style={{
              background: "transparent",
              border: "none",
              padding: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
              borderRadius: "50%",
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Structural Macro Cards Workspace Grid */}
      <div
        className="home-workspace-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "410px 1fr",
          columnGap: "72px",
          rowGap: "24px",
          alignItems: "stretch",
          width: "100%",
          maxWidth: "1440px",
          margin: 0,
        }}
      >
        {/* Left Column: Macro Summary + Macro Table Sections */}
        <div
          className="home-col-left"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            width: "410px",
            maxWidth: "410px",
          }}
        >
          {/* Executive Summary Box (exact 271px tall) */}
          <div
            className="home-executive-summary-box"
            style={{
              width: "410px",
              maxWidth: "410px",
              height: "271px",
              minHeight: "271px",
              boxSizing: "border-box",
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderLeft: "4px solid #cbd5e1",
              borderRadius: "8px",
              padding: "22px 24px",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04)",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <Skeleton width="140px" height="13px" borderRadius="3px" />
            <Skeleton width="190px" height="38px" borderRadius="6px" style={{ margin: "4px 0" }} />
            <Skeleton width="92%" height="16px" borderRadius="3px" />
            <Skeleton width="85%" height="16px" borderRadius="3px" />
            <Skeleton width="68%" height="16px" borderRadius="3px" />
          </div>

          {/* Macro Table Container (Clean structural silhouette) */}
          <div
            style={{
              width: "410px",
              maxWidth: "410px",
              background: "#ffffff",
              borderRadius: "8px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Header Month Bar */}
            <div style={{ height: "31px", background: "#f1f5f9", borderBottom: "1px solid #e2e8f0", padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Skeleton width="90px" height="14px" />
              <Skeleton width="65px" height="14px" />
            </div>

            {/* Status Row */}
            <div style={{ height: "24px", background: "#ffffff", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 16px" }}>
              <Skeleton width="55px" height="11px" />
            </div>

            {/* Macro Section 1: Revenue Block */}
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Skeleton width="85px" height="12px" />
                <Skeleton width="60px" height="12px" />
              </div>
              <Skeleton width="100%" height="42px" borderRadius="5px" />
              <Skeleton width="100%" height="28px" borderRadius="4px" />
            </div>

            {/* Macro Section 2: Direct Costs Block */}
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Skeleton width="110px" height="12px" />
                <Skeleton width="55px" height="12px" />
              </div>
              <Skeleton width="100%" height="42px" borderRadius="5px" />
              <Skeleton width="100%" height="26px" borderRadius="4px" />
            </div>

            {/* Macro Section 3: Gross Profit Block */}
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "10px" }}>
              <Skeleton width="100%" height="32px" borderRadius="4px" />
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <Skeleton width="110px" height="12px" />
                <Skeleton width="45px" height="12px" />
              </div>
            </div>

            {/* Macro Section 4: Operating Profit Block */}
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Skeleton width="95px" height="12px" />
                <Skeleton width="60px" height="12px" />
              </div>
              <Skeleton width="100%" height="42px" borderRadius="5px" />
              <Skeleton width="100%" height="32px" borderRadius="4px" />
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <Skeleton width="120px" height="12px" />
                <Skeleton width="45px" height="12px" />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Macro At a Glance + Macro Chart */}
        <div
          className="home-col-right"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            width: "100%",
            minWidth: 0,
            minHeight: 0,
            height: "100%",
          }}
        >
          {/* Macro At a Glance Card */}
          <div
            className="home-glance-card"
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              padding: "20px 24px",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              height: "460px",
              minHeight: "460px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Skeleton width="130px" height="13px" style={{ marginBottom: "20px" }} />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "20px",
                flex: 1,
              }}
            >
              {[
                { titleW: "75px", valW: "125px" },
                { titleW: "95px", valW: "115px" },
                { titleW: "115px", valW: "105px" },
              ].map((col, idx) => (
                <div
                  key={idx}
                  style={{
                    background: "#f8fafc",
                    borderRadius: "6px",
                    border: "1px solid #f1f5f9",
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    height: "360px",
                    boxSizing: "border-box",
                  }}
                >
                  <Skeleton width={col.titleW} height="13px" />
                  <Skeleton width={col.valW} height="28px" borderRadius="4px" />
                  <Skeleton width="60%" height="11px" />
                  <Skeleton width="100%" height="220px" borderRadius="5px" style={{ marginTop: "auto" }} />
                </div>
              ))}
            </div>
          </div>

          {/* Macro Chart Card */}
          <div
            className="home-chart-card"
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              padding: "20px 24px",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
              flex: "1 1 0%",
              minHeight: "340px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <Skeleton width="160px" height="14px" />
              <div style={{ display: "flex", gap: "12px" }}>
                <Skeleton width="80px" height="12px" />
                <Skeleton width="80px" height="12px" />
              </div>
            </div>
            <Skeleton width="100%" height="260px" borderRadius="6px" style={{ flex: 1 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for the Cashflow Forecast View.
 */
export function CashflowSkeleton() {
  return (
    <div data-pulse-skeleton="true" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
      {/* Top Action Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "0 4px" }}>
        <Skeleton width="180px" height="24px" />
        <div style={{ display: "flex", gap: "8px" }}>
          <Skeleton width="34px" height="34px" circle={true} />
          <Skeleton width="34px" height="34px" circle={true} />
        </div>
      </div>

      {/* Top 3 Summary KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        {[1, 2, 3].map((card) => (
          <SkeletonCard key={card} padding="18px 20px">
            <Skeleton width="45%" height="12px" style={{ marginBottom: "10px" }} />
            <Skeleton width="70%" height="26px" style={{ marginBottom: "8px" }} />
            <Skeleton width="55%" height="12px" />
          </SkeletonCard>
        ))}
      </div>

      {/* Large Cashflow Multi-Week Table */}
      <SkeletonCard padding="0" style={{ overflow: "hidden" }}>
        {/* Table Column Headers */}
        <div style={{ display: "flex", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "12px 18px", gap: "12px" }}>
          <div style={{ width: "200px", flexShrink: 0 }}>
            <Skeleton width="90px" height="14px" />
          </div>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} style={{ flex: 1, minWidth: "75px" }}>
              <Skeleton width="75%" height="12px" />
            </div>
          ))}
        </div>

        {/* Cashflow Line Rows */}
        {Array.from({ length: 12 }).map((_, r) => {
          const isHeader = r === 0 || r === 4 || r === 8;
          const isTotal = r === 3 || r === 7 || r === 11;
          return (
            <div
              key={r}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "10px 18px",
                borderBottom: r === 11 ? "none" : "1px solid #f1f5f9",
                background: isTotal ? "#f8fafc" : isHeader ? "#ffffff" : "#ffffff",
                gap: "12px",
              }}
            >
              <div style={{ width: "200px", flexShrink: 0, paddingLeft: isHeader || isTotal ? "0" : "14px" }}>
                <Skeleton width={isHeader || isTotal ? "75%" : "60%"} height={isTotal ? "14px" : "12px"} />
              </div>
              {Array.from({ length: 12 }).map((_, c) => (
                <div key={c} style={{ flex: 1, minWidth: "75px" }}>
                  <Skeleton width="65%" height={isTotal ? "14px" : "12px"} />
                </div>
              ))}
            </div>
          );
        })}
      </SkeletonCard>
    </div>
  );
}

/**
 * Composite Skeleton for Budget Variance / Budget View.
 */
export function BudgetSkeleton() {
  return (
    <div data-pulse-skeleton="true" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
      {/* Top Action Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "0 4px" }}>
        <Skeleton width="160px" height="24px" />
        <div style={{ display: "flex", gap: "8px" }}>
          <Skeleton width="34px" height="34px" circle={true} />
          <Skeleton width="34px" height="34px" circle={true} />
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        {[1, 2, 3, 4].map((i) => (
          <SkeletonCard key={i} padding="16px 20px">
            <Skeleton width="50%" height="12px" style={{ marginBottom: "8px" }} />
            <Skeleton width="75%" height="24px" style={{ marginBottom: "6px" }} />
            <Skeleton width="40%" height="11px" />
          </SkeletonCard>
        ))}
      </div>

      {/* Budget Table */}
      <SkeletonTable rows={12} columns={6} colWidths={["28%", "14%", "14%", "14%", "15%", "15%"]} />
    </div>
  );
}

/**
 * Composite Skeleton for Performance Views (FY, YTD, Scenarios).
 */
export function PerformanceSkeleton({ isYtd = false }) {
  return (
    <div data-pulse-skeleton="true" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
      {/* Top Action Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "0 4px" }}>
        <Skeleton width="200px" height="24px" />
        <div style={{ display: "flex", gap: "8px" }}>
          <Skeleton width="34px" height="34px" circle={true} />
          <Skeleton width="34px" height="34px" circle={true} />
        </div>
      </div>

      {/* 4 Summary Stat Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        {[1, 2, 3, 4].map((i) => (
          <SkeletonCard key={i} padding="18px 20px">
            <Skeleton width="55%" height="12px" style={{ marginBottom: "8px" }} />
            <Skeleton width="80%" height="26px" style={{ marginBottom: "6px" }} />
            <Skeleton width="45%" height="12px" />
          </SkeletonCard>
        ))}
      </div>

      {/* Trajectory Chart Card */}
      <SkeletonCard padding="20px 24px" style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
          <Skeleton width="180px" height="14px" />
          <Skeleton width="140px" height="14px" />
        </div>
        <Skeleton width="100%" height="260px" borderRadius="6px" />
      </SkeletonCard>

      {/* Category Breakdown Table */}
      <SkeletonTable rows={6} columns={5} colWidths={["35%", "15%", "15%", "15%", "20%"]} />
    </div>
  );
}

/**
 * Composite Skeleton for Performance & Cashflow Breakdown Views.
 */
export function BreakdownViewSkeleton({ isCashflow = false }) {
  return (
    <div data-pulse-skeleton="true" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px", padding: "0 4px" }}>
        <Skeleton width="220px" height="24px" />
        <div style={{ display: "flex", gap: "8px" }}>
          <Skeleton width="140px" height="34px" borderRadius="6px" />
          <Skeleton width="34px" height="34px" circle={true} />
        </div>
      </div>

      <SkeletonTable rows={10} columns={5} colWidths={["36%", "16%", "16%", "16%", "16%"]} />
    </div>
  );
}

/**
 * Composite Skeleton for Portal Data Tables (Jobs, Contractors, Expenses, Salaries, NB to find).
 */
export function PortalTableSkeleton({ title = "Loading...", columns = 6 }) {
  return (
    <div data-pulse-skeleton="true" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
      {/* Title & Filter Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "0 4px" }}>
        <Skeleton width="180px" height="24px" />
        <div style={{ display: "flex", gap: "8px" }}>
          <Skeleton width="120px" height="34px" borderRadius="6px" />
          <Skeleton width="34px" height="34px" circle={true} />
        </div>
      </div>

      <SkeletonTable rows={8} columns={columns} />
    </div>
  );
}

/**
 * Compact Skeleton for DeepDivePopover line items.
 */
export function DeepDiveSkeleton({ rows = 4 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px 16px" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 0",
            borderBottom: i === rows - 1 ? "none" : "1px solid #f1f5f9",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "65%" }}>
            <Skeleton width="80%" height="13px" borderRadius="3px" />
            <Skeleton width="50%" height="10px" borderRadius="3px" />
          </div>
          <Skeleton width="70px" height="15px" borderRadius="3px" />
        </div>
      ))}
    </div>
  );
}

/**
 * Composite Skeleton for the PMA Home Dashboard (HomeView.jsx).
 * Matches HomeView layout:
 * - Title "Home"
 * - 2 Top KPI cards (Alerts needing processing, Active tasks)
 * - Setup status card with 3 pending card silhouettes
 * - Client summary card with search bar, table header, and 6 client rows
 */
export function PmaHomeSkeleton() {
  return (
    <div data-pulse-skeleton="true" className="pma-page-container" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "24px 32px 60px", boxSizing: "border-box", fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      {/* Page header */}
      <div style={{ background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)", marginBottom: "20px" }}>
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: "700", color: "#0F172A" }}>
          Home
        </h1>
      </div>

      {/* Top summary cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px", marginBottom: "28px" }}>
        {/* Card 1: Alerts */}
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            border: "1px solid #E2E8F0",
            padding: "20px 22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minHeight: "220px",
          }}
        >
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <Skeleton width="160px" height="13px" />
              <Skeleton width="28px" height="28px" circle={true} />
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "10px" }}>
              <Skeleton width="55px" height="36px" borderRadius="6px" />
              <Skeleton width="90px" height="14px" />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "18px" }}>
              <Skeleton width="90%" height="13px" />
              <Skeleton width="65%" height="13px" />
            </div>
          </div>
          <Skeleton width="100%" height="40px" borderRadius="8px" />
        </div>

        {/* Card 2: Tasks */}
        <div
          style={{
            background: "#FFFFFF",
            borderRadius: "12px",
            border: "1px solid #E2E8F0",
            padding: "20px 22px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minHeight: "220px",
          }}
        >
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <Skeleton width="110px" height="13px" />
              <Skeleton width="28px" height="28px" circle={true} />
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "10px" }}>
              <Skeleton width="45px" height="36px" borderRadius="6px" />
              <Skeleton width="85px" height="14px" />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "18px" }}>
              <Skeleton width="75%" height="13px" />
              <Skeleton width="50%" height="13px" />
            </div>
          </div>
          <Skeleton width="100%" height="40px" borderRadius="8px" />
        </div>
      </div>

      {/* Setup section */}
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "22px", marginBottom: "28px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Skeleton width="110px" height="16px" />
              <Skeleton width="70px" height="18px" borderRadius="12px" />
            </div>
            <Skeleton width="240px" height="12px" />
          </div>
          <Skeleton width="130px" height="32px" borderRadius="6px" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
          {[1, 2, 3].map((card) => (
            <div
              key={card}
              style={{
                background: "#f8fafc",
                border: "1px solid #f1f5f9",
                borderRadius: "8px",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Skeleton width="110px" height="14px" />
                <Skeleton width="75px" height="16px" borderRadius="4px" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <Skeleton width="85%" height="12px" />
                <Skeleton width="65%" height="12px" />
              </div>
              <Skeleton width="100%" height="32px" borderRadius="6px" style={{ marginTop: "4px" }} />
            </div>
          ))}
        </div>
      </div>

      {/* Client summary section */}
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "22px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Skeleton width="120px" height="16px" />
              <Skeleton width="65px" height="18px" borderRadius="12px" />
            </div>
            <Skeleton width="260px" height="12px" />
          </div>
          <Skeleton width="220px" height="34px" borderRadius="6px" />
        </div>

        {/* Table skeleton */}
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{ display: "flex", padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
            <div style={{ flex: 2 }}><Skeleton width="60px" height="12px" /></div>
            <div style={{ flex: 1.5 }}><Skeleton width="80px" height="12px" /></div>
            <div style={{ flex: 1.5 }}><Skeleton width="75px" height="12px" /></div>
            <div style={{ flex: 2 }}><Skeleton width="85px" height="12px" /></div>
            <div style={{ flex: 1, textAlign: "right" }}><Skeleton width="50px" height="12px" style={{ marginLeft: "auto" }} /></div>
          </div>
          {Array.from({ length: 6 }).map((_, r) => (
            <div
              key={r}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 14px",
                borderBottom: r === 5 ? "none" : "1px solid #f1f5f9",
                background: "#ffffff",
              }}
            >
              <div style={{ flex: 2 }}><Skeleton width="130px" height="14px" /></div>
              <div style={{ flex: 1.5 }}><Skeleton width="65px" height="18px" borderRadius="12px" /></div>
              <div style={{ flex: 1.5 }}><Skeleton width="70px" height="20px" borderRadius="12px" /></div>
              <div style={{ flex: 2 }}><Skeleton width="120px" height="13px" /></div>
              <div style={{ flex: 1, textAlign: "right" }}><Skeleton width="60px" height="28px" borderRadius="6px" style={{ marginLeft: "auto" }} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for the PMA Alerts Client List (ClientSelectionView.jsx & /pma/alerts).
 * Matches the Alerts client list view:
 * - Header: Title "Alerts" + subtitle
 * - Card: Subhead "Alerts" + 4 client alert card silhouettes
 */
export function PmaAlertsSkeleton() {
  return (
    <div data-pulse-skeleton="true" className="pma-page-container" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "24px 32px 60px", boxSizing: "border-box", fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      {/* Header */}
      <div style={{ background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)", marginBottom: "20px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: "700", color: "#0F172A", margin: "0 0 6px 0" }}>
          Alerts
        </h1>
        <Skeleton width="280px" height="14px" />
      </div>

      {/* Main alerts card */}
      <div style={{ background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: "8px", padding: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        {/* Client alert cards silhouette */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[
            { nameW: "150px", lines: ["240px", "190px"] },
            { nameW: "180px", lines: ["280px", "210px", "160px"] },
            { nameW: "130px", lines: ["220px"] },
            { nameW: "165px", lines: ["260px", "175px"] },
          ].map((c, idx) => (
            <div
              key={idx}
              style={{
                padding: "16px 18px",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                background: "#f8fafc",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Skeleton width={c.nameW} height="16px" />
                <Skeleton width="50px" height="15px" borderRadius="10px" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "2px" }}>
                {c.lines.map((w, l) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ color: "#94a3b8", fontSize: "14px", lineHeight: "1" }}>•</span>
                    <Skeleton className="pulse-skeleton-blue" width={w} height="13px" borderRadius="3px" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Card footer bar */}
        <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end" }}>
          <Skeleton width="130px" height="32px" borderRadius="6px" />
        </div>
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for EditClientSelector.jsx.
 * Matches the client selector card across all PMA Edit views:
 * - Header title + optional header extra
 * - Search bar silhouette
 * - 6 client item buttons with name and chevron/badge
 */
export function EditClientSelectorSkeleton({ count = 6 }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <Skeleton width="180px" height="16px" />
        <Skeleton width="80px" height="14px" />
      </div>

      {/* Search bar */}
      <div style={{ marginBottom: "14px" }}>
        <Skeleton width="100%" height="38px" borderRadius="6px" />
      </div>

      {/* Client List */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "10px" }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            style={{
              padding: "12px 16px",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              background: "#ffffff",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              boxSizing: "border-box",
              minHeight: "48px",
            }}
          >
            <Skeleton width={`${120 + ((i * 37) % 110)}px`} height="15px" />
            <Skeleton width="20px" height="14px" borderRadius="4px" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for the PMA Jobs View table (JobsView.jsx).
 * Matches the loaded Jobs table:
 * - Outer card container with 1px border and 10px radius
 * - Header row matching column structure (Toggle, Status, Notes, Client, Job Name, Type, Revenue, Costs, GP, GP%, Actions)
 * - 8 realistic rows with 0 layout shift
 */
export function PmaJobsTableSkeleton({ rows = 8 }) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "10px",
        border: "1px solid #e2e8f0",
        overflowX: "auto",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left", minWidth: "1220px" }}>
        <thead>
          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
            <th style={{ padding: "10px 10px", width: "36px", textAlign: "center" }}>
              <Skeleton width="14px" height="14px" borderRadius="3px" style={{ margin: "0 auto" }} />
            </th>
            <th style={{ padding: "10px 10px", width: "95px" }}>
              <Skeleton width="50px" height="12px" />
            </th>
            <th style={{ padding: "10px 4px", width: "36px", textAlign: "center" }}>
              <Skeleton width="14px" height="14px" borderRadius="3px" style={{ margin: "0 auto" }} />
            </th>
            <th style={{ padding: "10px 10px", width: "160px" }}>
              <Skeleton width="55px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "210px" }}>
              <Skeleton width="75px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "115px" }}>
              <Skeleton width="45px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "125px" }}>
              <Skeleton width="60px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "125px" }}>
              <Skeleton width="75px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "130px" }}>
              <Skeleton width="65px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "130px" }}>
              <Skeleton width="65px" height="12px" />
            </th>
            <th style={{ padding: "10px 10px", width: "100px" }}>
              <Skeleton width="60px" height="12px" />
            </th>
            <th style={{ padding: "10px 12px", width: "110px", textAlign: "right" }}>
              <Skeleton width="50px" height="12px" style={{ marginLeft: "auto" }} />
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr
              key={r}
              style={{
                borderBottom: r === rows - 1 ? "none" : "1px solid #f1f5f9",
                background: r % 2 === 1 ? "#fafcff" : "#ffffff",
              }}
            >
              <td style={{ padding: "14px 10px", textAlign: "center" }}>
                <Skeleton width="14px" height="14px" borderRadius="3px" style={{ margin: "0 auto" }} />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="70px" height="20px" borderRadius="10px" />
              </td>
              <td style={{ padding: "14px 4px", textAlign: "center" }}>
                <Skeleton width="14px" height="14px" circle={true} style={{ margin: "0 auto" }} />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width={`${90 + ((r * 29) % 50)}px`} height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width={`${120 + ((r * 43) % 70)}px`} height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="65px" height="20px" borderRadius="6px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="75px" height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="60px" height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="75px" height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="75px" height="14px" />
              </td>
              <td style={{ padding: "14px 10px" }}>
                <Skeleton width="55px" height="14px" />
              </td>
              <td style={{ padding: "14px 12px", textAlign: "right" }}>
                <Skeleton width="45px" height="14px" style={{ marginLeft: "auto" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Composite Skeleton for InvoicesView.jsx (byJob subtab).
 */
export function PmaInvoicesTableSkeleton({ cards = 5 }) {
  return (
    <div>
      {/* Description banner silhouette */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          marginBottom: "12px",
        }}
      >
        <Skeleton width="340px" height="14px" />
        <Skeleton width="130px" height="28px" borderRadius="6px" />
      </div>

      {/* Search bar silhouette */}
      <div style={{ marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Skeleton width="280px" height="34px" borderRadius="6px" />
        <Skeleton width="90px" height="14px" />
      </div>

      {/* Job cards list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "16px 18px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
            }}
          >
            {/* Job Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Skeleton width={`${140 + ((i * 31) % 60)}px`} height="16px" />
                <Skeleton width="60px" height="18px" borderRadius="10px" />
              </div>
              <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                <Skeleton width="90px" height="14px" />
                <Skeleton width="80px" height="14px" />
                <Skeleton width="75px" height="26px" borderRadius="5px" />
              </div>
            </div>

            {/* Invoice slots row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
              {[1, 2, 3].map((slot) => (
                <div
                  key={slot}
                  style={{
                    background: "#f8fafc",
                    border: "1px dashed #cbd5e1",
                    borderRadius: "6px",
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <Skeleton width="65px" height="12px" />
                    <Skeleton width="45px" height="12px" />
                  </div>
                  <Skeleton width="110px" height="14px" />
                  <Skeleton width="80px" height="11px" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for OutgoingsView.jsx.
 */
export function PmaOutgoingsTableSkeleton({ rows = 8 }) {
  return (
    <div>
      {/* Controls Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Skeleton width="220px" height="34px" borderRadius="6px" />
          <Skeleton width="130px" height="34px" borderRadius="6px" />
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <Skeleton width="140px" height="32px" borderRadius="6px" />
          <Skeleton width="75px" height="32px" borderRadius="6px" />
        </div>
      </div>

      {/* Outgoings Contractor Matrix Table */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
          overflowX: "auto",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", padding: "12px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", gap: "8px", minWidth: "900px" }}>
          <div style={{ width: "240px", flexShrink: 0 }}><Skeleton width="90px" height="12px" /></div>
          {["Jul", "Aug", "Sept", "Oct", "Nov", "Dec", "Jan"].map((m, i) => (
            <div key={m} style={{ flex: 1, minWidth: "80px", textAlign: "center" }}>
              <Skeleton width="50px" height="12px" style={{ margin: "0 auto" }} />
            </div>
          ))}
        </div>

        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "14px 14px",
              borderBottom: r === rows - 1 ? "none" : "1px solid #f1f5f9",
              background: r % 2 === 1 ? "#fafcff" : "#ffffff",
              gap: "8px",
              minWidth: "900px",
            }}
          >
            <div style={{ width: "240px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
              <Skeleton width={`${120 + ((r * 29) % 80)}px`} height="14px" />
              <Skeleton width="85px" height="10px" />
            </div>
            {Array.from({ length: 7 }).map((_, c) => (
              <div key={c} style={{ flex: 1, minWidth: "80px", display: "flex", justifyContent: "center" }}>
                <Skeleton width="45px" height="13px" borderRadius="3px" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for SalariesView.jsx.
 */
export function PmaSalariesSkeleton() {
  return (
    <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* Left Column: Employee list */}
      <div
        style={{
          flex: "1 1 420px",
          maxWidth: "520px",
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "20px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <Skeleton width="120px" height="16px" />
          <Skeleton width="90px" height="28px" borderRadius="6px" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: "12px 14px",
                border: "1px solid #f1f5f9",
                borderRadius: "8px",
                background: "#f8fafc",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <Skeleton width={`${100 + ((i * 21) % 50)}px`} height="14px" />
                <Skeleton width="75px" height="11px" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" }}>
                <Skeleton width="65px" height="14px" />
                <Skeleton width="45px" height="10px" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Column: Monthly Summary & Allocations */}
      <div
        style={{
          flex: "1 1 500px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {/* KPI Summary Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
          {[1, 2, 3].map((card) => (
            <div
              key={card}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                padding: "14px 16px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
              }}
            >
              <Skeleton width="80px" height="11px" style={{ marginBottom: "8px" }} />
              <Skeleton width="95px" height="22px" />
            </div>
          ))}
        </div>

        {/* Monthly breakdown table */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "18px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px" }}>
            <Skeleton width="140px" height="15px" />
            <Skeleton width="70px" height="14px" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {Array.from({ length: 6 }).map((_, r) => (
              <div key={r} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: r === 5 ? "none" : "1px solid #f1f5f9" }}>
                <Skeleton width="90px" height="13px" />
                <Skeleton width="75px" height="13px" />
                <Skeleton width="65px" height="13px" />
                <Skeleton width="65px" height="13px" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for RetainersView.jsx.
 */
export function PmaRetainersTableSkeleton({ rows = 6 }) {
  return (
    <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e2e8f0", background: "#ffffff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ display: "flex", padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", gap: "10px" }}>
        <div style={{ width: "30px" }}><Skeleton width="14px" height="12px" /></div>
        <div style={{ width: "120px" }}><Skeleton width="60px" height="12px" /></div>
        <div style={{ width: "160px" }}><Skeleton width="75px" height="12px" /></div>
        <div style={{ width: "90px" }}><Skeleton width="55px" height="12px" /></div>
        <div style={{ width: "90px" }}><Skeleton width="45px" height="12px" /></div>
        <div style={{ width: "90px" }}><Skeleton width="45px" height="12px" /></div>
        <div style={{ flex: 1 }}><Skeleton width="120px" height="12px" /></div>
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: r === rows - 1 ? "none" : "1px solid #f1f5f9", gap: "10px", background: r % 2 === 1 ? "#fafcff" : "#ffffff" }}>
          <div style={{ width: "30px" }}><Skeleton width="14px" height="14px" borderRadius="3px" /></div>
          <div style={{ width: "120px" }}><Skeleton width="95px" height="13px" /></div>
          <div style={{ width: "160px" }}><Skeleton width="130px" height="13px" /></div>
          <div style={{ width: "90px" }}><Skeleton width="65px" height="13px" /></div>
          <div style={{ width: "90px" }}><Skeleton width="60px" height="13px" /></div>
          <div style={{ width: "90px" }}><Skeleton width="60px" height="13px" /></div>
          <div style={{ flex: 1, display: "flex", gap: "6px" }}>
            <Skeleton width="70px" height="22px" borderRadius="4px" />
            <Skeleton width="70px" height="22px" borderRadius="4px" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Composite Skeleton for ExpensesView.jsx.
 */
export function PmaExpensesTableSkeleton({ rows = 8 }) {
  return (
    <div>
      {/* Filter Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", gap: "10px" }}>
          <Skeleton width="110px" height="34px" borderRadius="6px" />
          <Skeleton width="130px" height="34px" borderRadius="6px" />
        </div>
        <Skeleton width="220px" height="34px" borderRadius="6px" />
      </div>

      {/* Expenses Table */}
      <div style={{ background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", overflowX: "auto", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", padding: "12px 16px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", gap: "12px" }}>
          <div style={{ flex: 1.5 }}><Skeleton width="90px" height="12px" /></div>
          <div style={{ flex: 1.5 }}><Skeleton width="80px" height="12px" /></div>
          <div style={{ flex: 2 }}><Skeleton width="110px" height="12px" /></div>
          <div style={{ flex: 1.2 }}><Skeleton width="70px" height="12px" /></div>
          <div style={{ flex: 1 }}><Skeleton width="60px" height="12px" /></div>
          <div style={{ flex: 1, textAlign: "right" }}><Skeleton width="55px" height="12px" style={{ marginLeft: "auto" }} /></div>
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: r === rows - 1 ? "none" : "1px solid #f1f5f9", background: r % 2 === 1 ? "#fafcff" : "#ffffff", gap: "12px" }}>
            <div style={{ flex: 1.5 }}><Skeleton width="110px" height="14px" /></div>
            <div style={{ flex: 1.5 }}><Skeleton width="95px" height="14px" /></div>
            <div style={{ flex: 2 }}><Skeleton width={`${140 + ((r * 19) % 70)}px`} height="14px" /></div>
            <div style={{ flex: 1.2 }}><Skeleton width="75px" height="14px" /></div>
            <div style={{ flex: 1 }}><Skeleton width="55px" height="14px" /></div>
            <div style={{ flex: 1, textAlign: "right" }}><Skeleton width="65px" height="14px" style={{ marginLeft: "auto" }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for TasksView.jsx.
 * Matches:
 * - 5 task card silhouettes each with client pill, task title, urgency badge, description, and action buttons
 */
export function PmaTasksSkeleton({ cards = 5 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          style={{
            padding: "16px 18px",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            background: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
          }}
        >
          {/* Header row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Skeleton width="90px" height="20px" borderRadius="10px" />
              <Skeleton width={`${160 + ((i * 37) % 90)}px`} height="16px" />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Skeleton width="75px" height="13px" />
              <Skeleton width="60px" height="18px" borderRadius="10px" />
            </div>
          </div>

          {/* Description */}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <Skeleton width="85%" height="13px" />
            <Skeleton width="55%" height="13px" />
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px", paddingTop: "8px", borderTop: "1px solid #f1f5f9" }}>
            <Skeleton width="110px" height="26px" borderRadius="5px" />
            <div style={{ display: "flex", gap: "8px" }}>
              <Skeleton width="70px" height="26px" borderRadius="5px" />
              <Skeleton width="85px" height="26px" borderRadius="5px" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Composite Skeleton for SetupView.jsx (Overview Table).
 */
export function PmaSetupOverviewSkeleton({ rows = 6 }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" }}>
      <thead>
        <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
          <th style={{ padding: "12px 20px" }}><Skeleton width="60px" height="12px" /></th>
          <th style={{ padding: "12px 16px" }}><Skeleton width="55px" height="12px" /></th>
          <th style={{ padding: "12px 16px" }}><Skeleton width="80px" height="12px" /></th>
          <th style={{ padding: "12px 16px" }}><Skeleton width="45px" height="12px" /></th>
          <th style={{ padding: "12px 16px" }}><Skeleton width="120px" height="12px" /></th>
          <th style={{ padding: "12px 20px", textAlign: "right" }}><Skeleton width="55px" height="12px" style={{ marginLeft: "auto" }} /></th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r} style={{ borderBottom: r === rows - 1 ? "none" : "1px solid #F1F5F9", background: r % 2 === 1 ? "#fafcff" : "#ffffff" }}>
            <td style={{ padding: "14px 20px" }}><Skeleton width={`${120 + ((r * 23) % 60)}px`} height="15px" /></td>
            <td style={{ padding: "14px 16px" }}><Skeleton width="75px" height="20px" borderRadius="10px" /></td>
            <td style={{ padding: "14px 16px" }}><Skeleton width="85px" height="20px" borderRadius="4px" /></td>
            <td style={{ padding: "14px 16px" }}><Skeleton width="70px" height="20px" borderRadius="4px" /></td>
            <td style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Skeleton width="110px" height="8px" borderRadius="4px" />
                <Skeleton width="35px" height="12px" />
              </div>
            </td>
            <td style={{ padding: "14px 20px", textAlign: "right" }}>
              <Skeleton width="60px" height="28px" borderRadius="6px" style={{ marginLeft: "auto" }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Composite Skeleton for SetupView.jsx (Client Detail / Onboarding Checklist).
 */
export function PmaSetupDetailSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header bar */}
      <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <Skeleton width="160px" height="18px" />
          <Skeleton width="240px" height="12px" />
        </div>
        <Skeleton width="140px" height="34px" borderRadius="6px" />
      </div>

      {/* 4 Checklist Phases */}
      {[1, 2, 3, 4].map((phase) => (
        <div
          key={phase}
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "20px 22px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Skeleton width="28px" height="28px" circle={true} />
              <Skeleton width={`${140 + ((phase * 29) % 70)}px`} height="16px" />
            </div>
            <Skeleton width="80px" height="20px" borderRadius="10px" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "38px" }}>
            {[1, 2].map((item) => (
              <div key={item} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#f8fafc", borderRadius: "6px" }}>
                <Skeleton width={`${180 + ((item * 41) % 100)}px`} height="13px" />
                <Skeleton width="65px" height="22px" borderRadius="4px" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Composite Skeleton for IntegrationsView.jsx.
 */
export function PmaIntegrationsSkeleton() {
  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "1440px", padding: "24px 32px 60px", margin: "0 auto", boxSizing: "border-box" }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px", background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" }}>
        <Skeleton width="240px" height="24px" />
        <Skeleton width="130px" height="36px" borderRadius="6px" />
      </div>

      {/* 4 Top Metric KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px", marginBottom: "22px" }}>
        {[1, 2, 3, 4].map((kpi) => (
          <div
            key={kpi}
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px 20px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            }}
          >
            <Skeleton width="110px" height="12px" style={{ marginBottom: "10px" }} />
            <Skeleton width="60px" height="28px" borderRadius="4px" style={{ marginBottom: "6px" }} />
            <Skeleton width="140px" height="11px" />
          </div>
        ))}
      </div>

      {/* Client Integrations Matrix Card */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "20px 22px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px", flexWrap: "wrap", gap: "12px" }}>
          <Skeleton width="260px" height="36px" borderRadius="6px" />
          <div style={{ display: "flex", gap: "8px" }}>
            <Skeleton width="80px" height="32px" borderRadius="6px" />
            <Skeleton width="80px" height="32px" borderRadius="6px" />
            <Skeleton width="80px" height="32px" borderRadius="6px" />
          </div>
        </div>

        {/* Matrix Rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from({ length: 6 }).map((_, r) => (
            <div
              key={r}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 18px",
                border: "1px solid #f1f5f9",
                borderRadius: "8px",
                background: r % 2 === 1 ? "#fafcff" : "#ffffff",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <Skeleton width={`${120 + ((r * 31) % 60)}px`} height="15px" />
                <Skeleton width="75px" height="18px" borderRadius="10px" />
              </div>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <Skeleton width="90px" height="24px" borderRadius="6px" />
                <Skeleton width="90px" height="24px" borderRadius="6px" />
                <Skeleton width="70px" height="28px" borderRadius="6px" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for ActivityView.jsx.
 */
export function PmaActivitySkeleton() {
  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "24px 32px 60px", boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ marginBottom: "20px", background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" }}>
        <Skeleton width="180px" height="24px" style={{ marginBottom: "6px" }} />
        <Skeleton width="300px" height="14px" />
      </div>

      {/* Filter Controls Row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", gap: "10px" }}>
          <Skeleton width="180px" height="34px" borderRadius="6px" />
          <Skeleton width="220px" height="34px" borderRadius="6px" />
        </div>
        <Skeleton width="110px" height="34px" borderRadius="6px" />
      </div>

      {/* Timeline Card */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ padding: "14px 18px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between" }}>
          <Skeleton width="130px" height="14px" />
          <Skeleton width="80px" height="12px" />
        </div>

        {/* 8 Activity Items */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            style={{
              padding: "14px 18px",
              borderBottom: i === 7 ? "none" : "1px solid #f1f5f9",
              display: "flex",
              alignItems: "flex-start",
              gap: "14px",
              background: i % 2 === 1 ? "#fafcff" : "#ffffff",
            }}
          >
            <Skeleton width="32px" height="32px" circle={true} style={{ flexShrink: 0, marginTop: "2px" }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <Skeleton width={`${80 + ((i * 17) % 40)}px`} height="18px" borderRadius="10px" />
                <Skeleton width={`${70 + ((i * 19) % 35)}px`} height="18px" borderRadius="4px" />
                <Skeleton width="90px" height="12px" />
              </div>
              <Skeleton width={`${75 + ((i * 7) % 20)}%`} height="14px" />
            </div>
            <Skeleton width="65px" height="12px" style={{ flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Composite Skeleton for the PMA New Business to Find View (NBToFindView.jsx).
 * Matches NBToFindView loaded layout:
 * - 3 Top configuration cards (Target settings, Direct costs % settings, Forecast summary card)
 * - Main 15-column table (Metric / Calculation Step, 12 month columns, Total FY, Average)
 */
export function PmaNBToFindSkeleton() {
  const monthLabels = ["Oct 26", "Nov 26", "Dec 26", "Jan 27", "Feb 27", "Mar 27", "Apr 27", "May 27", "Jun 27", "Jul 27", "Aug 27", "Sep 27"];
  return (
    <div style={{ marginTop: "8px" }}>
      {/* 3 Top Configuration Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "16px",
          marginBottom: "20px",
        }}
      >
        {/* Card 1: Target Settings */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "14px 18px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            minHeight: "135px",
          }}
        >
          <Skeleton width="90px" height="11px" />
          <Skeleton width="75%" height="15px" />
          <Skeleton width="90%" height="12px" />
          <div style={{ marginTop: "4px", display: "flex", gap: "8px" }}>
            <Skeleton width="55px" height="26px" borderRadius="4px" />
            <Skeleton width="55px" height="26px" borderRadius="4px" />
          </div>
        </div>

        {/* Card 2: Direct Costs Settings */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "14px 18px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            minHeight: "135px",
          }}
        >
          <Skeleton width="90px" height="11px" />
          <Skeleton width="75%" height="15px" />
          <Skeleton width="90%" height="12px" />
          <div style={{ marginTop: "4px", display: "flex", gap: "8px", alignItems: "center" }}>
            <Skeleton width="60px" height="26px" borderRadius="4px" />
            <Skeleton width="50px" height="26px" borderRadius="4px" />
            <div style={{ display: "flex", gap: "4px" }}>
              <Skeleton width="34px" height="22px" borderRadius="4px" />
              <Skeleton width="34px" height="22px" borderRadius="4px" />
              <Skeleton width="34px" height="22px" borderRadius="4px" />
            </div>
          </div>
        </div>

        {/* Card 3: Summary Highlights */}
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: "8px",
            padding: "14px 18px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minHeight: "135px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <Skeleton width="180px" height="11px" />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Skeleton width="140px" height="13px" />
              <Skeleton width="90px" height="20px" borderRadius="4px" />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Skeleton width="120px" height="12px" />
              <Skeleton width="70px" height="14px" borderRadius="4px" />
            </div>
          </div>
          <Skeleton width="150px" height="11px" />
        </div>
      </div>

      {/* Main Table Skeleton */}
      <div
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          border: "1px solid #cbd5e1",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          overflow: "hidden",
        }}
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                <th style={{ padding: "10px 14px", textAlign: "left", width: "250px" }}>
                  <Skeleton width="160px" height="14px" />
                </th>
                {monthLabels.map((lbl, i) => (
                  <th key={i} style={{ padding: "10px 10px", width: "75px", textAlign: "right" }}>
                    <Skeleton width="48px" height="13px" style={{ marginLeft: "auto" }} />
                  </th>
                ))}
                <th style={{ padding: "10px 10px", width: "85px", textAlign: "right" }}>
                  <Skeleton width="55px" height="13px" style={{ marginLeft: "auto" }} />
                </th>
                <th style={{ padding: "10px 10px", width: "80px", textAlign: "right" }}>
                  <Skeleton width="50px" height="13px" style={{ marginLeft: "auto" }} />
                </th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 9 }).map((_, rIdx) => (
                <tr
                  key={rIdx}
                  style={{
                    borderBottom: rIdx === 8 ? "none" : "1px solid #f1f5f9",
                    background: rIdx % 2 === 1 ? "#fafcff" : "#ffffff",
                  }}
                >
                  <td style={{ padding: "12px 14px" }}>
                    <Skeleton width={`${140 + ((rIdx * 19) % 70)}px`} height="13px" />
                  </td>
                  {monthLabels.map((_, cIdx) => (
                    <td key={cIdx} style={{ padding: "12px 10px", textAlign: "right" }}>
                      <Skeleton width={`${38 + (((rIdx + cIdx) * 11) % 24)}px`} height="13px" style={{ marginLeft: "auto" }} />
                    </td>
                  ))}
                  <td style={{ padding: "12px 10px", textAlign: "right" }}>
                    <Skeleton width="52px" height="13px" style={{ marginLeft: "auto" }} />
                  </td>
                  <td style={{ padding: "12px 10px", textAlign: "right" }}>
                    <Skeleton width="46px" height="13px" style={{ marginLeft: "auto" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page PMA shell + skeleton used when transitioning immediately from Pulse (/pulse) to PMA (/pma).
 */
export function PmaTransitionSkeleton({ user = null, targetNav = "home", clientName = "" }) {
  const navItems = [
    { key: "home", label: "Home" },
    { key: "alerts", label: "Alerts" },
    { key: "tasks", label: "Tasks" },
    { key: "edit", label: "Edit", isDropdown: true },
    { key: "views", label: "Views", isDropdown: true },
    { key: "tools", label: "EoM" },
    { key: "integrations", label: "Integrations" },
    { key: "setup", label: "Setup" },
    { key: "activity", label: "Activity" },
    { key: "settings", label: "Settings" },
  ];

  const userInitial = (user?.name || user?.email || "U").charAt(0).toUpperCase();

  return (
    <div
      data-pulse-skeleton="true"
      style={{
        fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        minHeight: "100vh",
        background: "#f8fafc",
      }}
    >
      {/* Top Bar (#A2C4C9) matching NavShell */}
      <div
        className="pma-topbar"
        style={{
          background: "#A2C4C9",
          borderBottom: "1px solid #8ab0b6",
          color: "#0047AB",
          padding: "10px max(32px, calc((100% - 1440px) / 2 + 32px))",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          boxSizing: "border-box",
          position: "relative",
          zIndex: 101,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexShrink: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pulselogo-pma.png"
            alt="Pulse"
            style={{ height: "30px", width: "auto", display: "block", flexShrink: 0 }}
          />
          <span
            style={{
              fontSize: "20.5px",
              fontWeight: 700,
              color: "#0047AB",
              letterSpacing: "-0.2px",
              lineHeight: 1.3,
              whiteSpace: "nowrap",
              position: "relative",
              top: "1.5px",
            }}
          >
            Management Area
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginLeft: "auto" }}>
          <div
            style={{
              background: targetNav === "setup" && clientName ? "#ffffff" : "rgba(255, 255, 255, 0.72)",
              border: targetNav === "setup" && clientName ? "1.5px solid #0047AB" : "1px solid rgba(0, 71, 171, 0.28)",
              borderRadius: "6px",
              color: "#0047AB",
              fontSize: "13px",
              fontWeight: 600,
              padding: "5px 12px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 2px rgba(0, 71, 171, 0.12)",
            }}
          >
            <span>Manage:{targetNav === "setup" && clientName ? ` ${clientName}` : ""}</span>
            <span style={{ fontSize: "10px", opacity: 0.85, lineHeight: 1 }}>▼</span>
          </div>

          <div
            style={{
              background: "#0047AB",
              border: "1px solid #0047AB",
              borderRadius: "6px",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              padding: "5px 12px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            }}
          >
            <span>Pulse</span>
            <span style={{ fontSize: "10px", opacity: 0.85, lineHeight: 1 }}>▼</span>
          </div>

          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: "#0047AB",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "14px",
              fontWeight: 700,
              border: "2px solid rgba(255, 255, 255, 0.7)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            }}
          >
            {userInitial}
          </div>
        </div>
      </div>

      {/* Secondary Navigation Bar matching NavShell */}
      <div
        className="pma-navbar"
        style={{
          background: "#ffffff",
          borderBottom: "1px solid #e2e8f0",
          padding: "0 max(18px, calc((100% - 1440px) / 2 + 18px))",
          display: "flex",
          alignItems: "stretch",
          position: "relative",
          zIndex: 100,
          overflowX: "auto",
          boxSizing: "border-box",
        }}
      >
        {navItems.map((item) => {
          const isActive = item.key === targetNav;
          return (
            <div
              key={item.key}
              className="pulse-nav-item"
              style={{
                padding: "11px 14px",
                fontSize: "13px",
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "#0047AB" : "#475569",
                borderBottom: isActive ? "2px solid #0047AB" : "2px solid transparent",
                display: "flex",
                alignItems: "center",
                gap: "5px",
                whiteSpace: "nowrap",
              }}
            >
              <span>{item.label}</span>
              {item.isDropdown && (
                <span style={{ fontSize: "10px", opacity: 0.8, lineHeight: 1 }}>▼</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Main Content Area Skeleton */}
      {targetNav === "setup" ? (
        <div
          className="pma-page-container"
          style={{
            width: "100%",
            maxWidth: "1440px",
            margin: "0 auto",
            padding: "24px 32px 60px",
            boxSizing: "border-box",
          }}
        >
          <PmaSetupDetailSkeleton />
        </div>
      ) : (
        <PmaHomeSkeleton />
      )}
    </div>
  );
}



