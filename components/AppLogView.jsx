import React, { useEffect } from "react";
import Spinner from "./Spinner";
import { useAppLog } from "../hooks/useAppLog";

export default function AppLogView({
  automationCommanderSheetId
}) {
  const { appLogData, appLogLoading, appLogLoadedAt, loadAppLog } = useAppLog(automationCommanderSheetId);

  // Auto-refresh App Log every 15 minutes while on the App Log screen
  useEffect(() => {
    if (!appLogLoadedAt) {
      loadAppLog();
    } else if (!appLogLoading && Date.now() - appLogLoadedAt > 15 * 60 * 1000) {
      loadAppLog();
    }
    const interval = setInterval(() => {
      if (!appLogLoading) loadAppLog();
    }, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [appLogLoadedAt, appLogLoading, loadAppLog]);

  const colLabels = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V"];
  const lastRefresh = appLogLoadedAt
    ? new Date(appLogLoadedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", padding: "20px 32px 60px", margin: "0 auto", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", background: "#ffffff", padding: "16px 20px", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" }}>
        <div>
          <h2 style={{ fontSize: "20px", fontWeight: "700", color: "#0f172a", margin: "0 0 4px 0" }}>App log</h2>
          {lastRefresh && <div style={{ fontSize: "12px", color: "#64748b" }}>Last refreshed {lastRefresh}</div>}
        </div>
        <button className="triage-btn" onClick={loadAppLog} disabled={appLogLoading}
          style={{ background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1", padding: "8px 16px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: "pointer" }}>
          {appLogLoading ? <><Spinner size={12} />Refreshing...</> : "↻ Refresh"}
        </button>
      </div>

      {appLogLoading && appLogData.length === 0 ? (
        <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
          <Spinner size={24} color="#0047AB" /><div style={{ marginTop: "12px" }}>Loading app log...</div>
        </div>
      ) : appLogData.length === 0 ? (
        <div style={{ padding: "40px", textAlign: "center", color: "#64748b", fontSize: "14px" }}>
          No data available. Click Refresh to load.
        </div>
      ) : (
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: "40px", background: "#ffffff", borderRadius: "10px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)" }}>
          <style>{`
            .applog-table { border-collapse: collapse; font-size: 12px; width: 100%; }
            .applog-table th, .applog-table td {
              border: 1px solid #e2e8f0;
              padding: 6px 10px;
              text-align: left;
              vertical-align: top;
              width: 200px;
              min-width: 120px;
              max-width: 260px;
              word-break: break-word;
              white-space: normal;
            }
            .applog-table th {
              background: #f8fafc;
              font-weight: 600;
              color: #475569;
              font-size: 11px;
              text-transform: uppercase;
              letter-spacing: 0.4px;
              position: sticky;
              top: 0;
              z-index: 1;
            }
            .applog-table th:first-child,
            .applog-table td:first-child {
              position: sticky;
              left: 0;
              z-index: 2;
              background: #f8fafc;
              border-right: 2px solid #cbd5e1;
              min-width: 140px;
              font-weight: 600;
            }
            .applog-table th:first-child {
              z-index: 3;
              background: #f1f5f9;
            }
            .applog-table tr:nth-child(even) td { background: #fafcff; }
            .applog-table tr:nth-child(even) td:first-child { background: #f8fafc; }
            .applog-table tr:hover td { background: #eef4ff; }
            .applog-table tr:hover td:first-child { background: #e8efff; }
          `}</style>
          <table className="applog-table">
            <thead>
              <tr>
                {colLabels.map(label => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {appLogData.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {colLabels.map((_, colIdx) => (
                    <td key={colIdx}>
                      {String(row[colIdx] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
