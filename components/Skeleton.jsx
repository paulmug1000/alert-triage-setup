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
              background: "#f0f5fc",
              border: "1px solid #d0e1f9",
              borderLeft: "4px solid #0047AB",
              borderRadius: "8px",
              padding: "22px 24px",
              boxShadow: "0 1px 4px rgba(0, 71, 171, 0.06)",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <Skeleton className="pulse-skeleton-blue" width="140px" height="13px" borderRadius="3px" />
            <Skeleton className="pulse-skeleton-blue" width="190px" height="38px" borderRadius="6px" style={{ margin: "4px 0" }} />
            <Skeleton className="pulse-skeleton-blue" width="92%" height="16px" borderRadius="3px" />
            <Skeleton className="pulse-skeleton-blue" width="85%" height="16px" borderRadius="3px" />
            <Skeleton className="pulse-skeleton-blue" width="68%" height="16px" borderRadius="3px" />
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
            <div style={{ height: "31px", background: "#0047AB", padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Skeleton className="pulse-skeleton-dark" width="90px" height="14px" />
              <Skeleton className="pulse-skeleton-dark" width="65px" height="14px" />
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
              <Skeleton width="100%" height="28px" borderRadius="4px" style={{ background: "rgba(153, 0, 255, 0.12)" }} />
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
              <Skeleton width="100%" height="32px" borderRadius="4px" style={{ background: "rgba(255, 153, 0, 0.15)" }} />
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
              <Skeleton width="100%" height="32px" borderRadius="4px" style={{ background: "rgba(0, 71, 171, 0.12)" }} />
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
    <div style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
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
    <div style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
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
    <div style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
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
    <div style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
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
    <div style={{ width: "100%", maxWidth: "1440px", margin: "0 auto", padding: "0 12px 3rem" }}>
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
