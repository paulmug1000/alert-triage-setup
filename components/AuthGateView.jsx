    import React from "react";
import Spinner from "./Spinner";

export default function AuthGateView({
  pinInput,
  pinVerifying,
  pinError,
  handlePinInput,
  setPinInput
}) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f5f5f5", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ padding: "32px", width: "280px", textAlign: "center" }}>
        <div style={{ width: "60px", height: "60px", background: "#1a1a2e", borderRadius: "16px", margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: "24px", fontWeight: "700" }}>P</div>
        <h2 style={{ margin: "0 0 8px", fontSize: "22px", fontWeight: "700", color: "#1a1a1a" }}>Pulse Triage</h2>
        <p style={{ margin: "0 0 32px", fontSize: "15px", color: "#666" }}>Enter PIN to access</p>
        
        <div style={{ display: "flex", justifyContent: "center", gap: "16px", marginBottom: "40px" }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{ width: "14px", height: "14px", borderRadius: "50%", background: i < pinInput.length ? "#0066cc" : "transparent", border: i < pinInput.length ? "1px solid #0066cc" : "1px solid #ccc", transition: "all 0.15s" }} />
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "24px" }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
            <button key={num} onClick={() => handlePinInput(String(num))} disabled={pinVerifying}
              style={{ height: "70px", width: "70px", margin: "0 auto", fontSize: "28px", fontWeight: "500", background: "#fff", border: "1px solid #e0e0e0", borderRadius: "50%", color: "#1a1a1a", cursor: "pointer", transition: "background 0.1s", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}
              onMouseDown={e => e.currentTarget.style.background = "#f0f0f0"} onMouseUp={e => e.currentTarget.style.background = "#fff"} onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
              {num}
            </button>
          ))}
          <div />
          <button onClick={() => handlePinInput("0")} disabled={pinVerifying}
            style={{ height: "70px", width: "70px", margin: "0 auto", fontSize: "28px", fontWeight: "500", background: "#fff", border: "1px solid #e0e0e0", borderRadius: "50%", color: "#1a1a1a", cursor: "pointer", transition: "background 0.1s", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}
            onMouseDown={e => e.currentTarget.style.background = "#f0f0f0"} onMouseUp={e => e.currentTarget.style.background = "#fff"} onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
            0
          </button>
          <button onClick={() => setPinInput(prev => prev.slice(0, -1))} disabled={pinVerifying || pinInput.length === 0}
            style={{ height: "70px", width: "70px", margin: "0 auto", fontSize: "24px", background: "none", border: "none", color: "#666", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            ⌫
          </button>
        </div>

        <div style={{ height: "24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {pinVerifying ? (
            <div style={{ fontSize: "14px", color: "#666", display: "flex", alignItems: "center" }}><Spinner size={14} color="#666" /> Verifying...</div>
          ) : (
            <div style={{ fontSize: "14px", color: "#dc2626", fontWeight: "500" }}>{pinError}</div>
          )}
        </div>
      </div>
    </div>
  );
}