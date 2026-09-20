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
    <>
      <div style={{ padding: "20px 20px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <h2 style={{ fontSize: "22px", fontWeight: "700", color: "#1a1a1a", margin: "0 0 4px 0" }}>App Log</h2>
            {lastRefresh && <div style={{ fontSize: "12px", color: "#888" }}>Last refreshed {lastRefresh}</div>}
          </div>
          <button className="triage-btn" onClick={loadAppLog} disabled={appLogLoading}
            style={{ background: "#f0f0f0", color: "#1a1a1a", border: "1px solid #ddd", padding: "8px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}>
            {appLogLoading ? <><Spinner size={12} />Refreshing...</> : "↻ Refresh"}
          </button>
        </div>
      </div>

      {appLogLoading && appLogData.length === 0 ? (
        <div style={{ padding: "40px", textAlign: "center", color: "#666" }}>
          <Spinner size={24} color="#0066cc" /><div style={{ marginTop: "12px" }}>Loading App Log...</div>
        </div>
      ) : appLogData.length === 0 ? (
        <div style={{ padding: "40px", textAlign: "center", color: "#888", fontSize: "14px" }}>
          No data available. Click Refresh to load.
        </div>
      ) : (
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: "40px" }}>
          <style>{`
            .applog-table { border-collapse: collapse; font-size: 12px; }
            .applog-table th, .applog-table td {
              border: 1px solid #e0e0e0;
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
              background: #f3f4f6;
              font-weight: 600;
              color: #555;
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
              background: #f9f9f9;
              border-right: 2px solid #d0d0d0;
              min-width: 140px;
              font-weight: 600;
            }
            .applog-table th:first-child {
              z-index: 3;
              background: #f3f4f6;
            }
            .applog-table tr:nth-child(even) td { background: #fafafa; }
            .applog-table tr:nth-child(even) td:first-child { background: #f5f5f5; }
            .applog-table tr:hover td { background: #eef3ff; }
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
    </>
  );
}