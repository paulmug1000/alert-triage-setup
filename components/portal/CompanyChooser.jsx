import React, { useState } from "react";
import Spinner from "../Spinner";

export default function CompanyChooser({
  clients = [],
  onSelectClient,
  user,
  onLogout,
  onCancel = null
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectingClientName, setSelectingClientName] = useState(null);

  const filteredClients = clients.filter(c =>
    (c.clientName || "").toLowerCase().includes(searchTerm.toLowerCase().trim())
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: "2rem 1.5rem",
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "760px",
          background: "#ffffff",
          borderRadius: "16px",
          boxShadow: "0 10px 40px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column"
        }}
      >
        {/* Top Header Card */}
        <div
          className="chooser-header"
          style={{
            background: "#0047AB",
            padding: "2.5rem 2rem 2rem 2rem",
            textAlign: "center",
            color: "#ffffff"
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pulselogo.png"
            alt="Pulse"
            style={{
              display: "block",
              margin: "0 auto 1.25rem auto",
              maxHeight: "65px",
              maxWidth: "220px",
              width: "auto",
              height: "auto"
            }}
            onError={(e) => {
              e.currentTarget.style.display = "none";
              const fb = document.getElementById("pulse-chooser-logo-fallback");
              if (fb) fb.style.display = "inline-block";
            }}
          />
          <div
            id="pulse-chooser-logo-fallback"
            style={{
              display: "none",
              fontSize: "28px",
              fontWeight: "800",
              color: "#ffffff",
              letterSpacing: "1px",
              marginBottom: "0.75rem"
            }}
          >
            PULSE
          </div>

          <h1
            style={{
              margin: "0 0 0.5rem 0",
              fontSize: "1.75rem",
              fontWeight: 700,
              letterSpacing: "-0.3px",
              color: "#ffffff"
            }}
          >
            Select Company
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "0.95rem",
              color: "rgba(255, 255, 255, 0.9)",
              maxWidth: "480px",
              marginLeft: "auto",
              marginRight: "auto"
            }}
          >
            Please choose which company dashboard you would like to view
          </p>
        </div>

        {/* Content Area */}
        <div className="chooser-content" style={{ padding: "2rem" }}>
          {/* Optional search filter if more than 4 clients */}
          {clients.length > 4 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <input
                type="text"
                placeholder="Search company..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.75rem 1rem",
                  fontSize: "14px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  outline: "none",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                  transition: "border-color 0.15s"
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "#0047AB"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "#cbd5e1"; }}
              />
            </div>
          )}

          {clients.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "2.5rem 1.5rem",
                color: "#64748b"
              }}
            >
              <div style={{ fontSize: "36px", marginBottom: "0.75rem" }}>🏢</div>
              <h3 style={{ margin: "0 0 0.5rem 0", color: "#1e293b", fontSize: "1.1rem" }}>
                No Companies Assigned
              </h3>
              <p style={{ margin: 0, fontSize: "0.9rem", color: "#64748b" }}>
                There are currently no companies assigned to your account. Please contact{" "}
                <a href="mailto:hello@pulsedashboard.co.uk" style={{ color: "#0047AB", textDecoration: "underline" }}>
                  hello@pulsedashboard.co.uk
                </a>{" "}
                with any questions.
              </p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: clients.length === 1 ? "1fr" : "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "1rem"
              }}
            >
              {filteredClients.map((client) => {
                const initials = (client.clientName || "C")
                  .split(" ")
                  .map((w) => w[0])
                  .filter(Boolean)
                  .slice(0, 2)
                  .join("")
                  .toUpperCase();

                return (
                  <button
                    key={client.clientName}
                    type="button"
                    onClick={() => {
                      setSelectingClientName(client.clientName);
                      onSelectClient(client);
                    }}
                    style={{
                      background: "#ffffff",
                      border: selectingClientName === client.clientName ? "1.5px solid #0047AB" : "1.5px solid #e2e8f0",
                      borderRadius: "12px",
                      padding: "1.25rem 1.25rem",
                      cursor: "pointer",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "1rem",
                      transition: "all 0.15s ease",
                      boxShadow: "0 2px 6px rgba(0, 0, 0, 0.04)"
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#0047AB";
                      e.currentTarget.style.boxShadow = "0 8px 24px rgba(0, 71, 171, 0.12)";
                      e.currentTarget.style.transform = "translateY(-2px)";
                      const arrow = e.currentTarget.querySelector(".client-arrow");
                      if (arrow) arrow.style.transform = "translateX(3px)";
                    }}
                    onMouseLeave={(e) => {
                      if (selectingClientName !== client.clientName) {
                        e.currentTarget.style.borderColor = "#e2e8f0";
                      }
                      e.currentTarget.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.04)";
                      e.currentTarget.style.transform = "translateY(0)";
                      const arrow = e.currentTarget.querySelector(".client-arrow");
                      if (arrow) arrow.style.transform = "translateX(0)";
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "1rem", minWidth: 0 }}>
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          borderRadius: "10px",
                          background: "rgba(0, 71, 171, 0.1)",
                          color: "#0047AB",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 700,
                          fontSize: "16px",
                          flexShrink: 0
                        }}
                      >
                        {initials}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "1.05rem",
                            fontWeight: 700,
                            color: "#0f172a",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis"
                          }}
                        >
                          {client.clientName}
                        </div>
                        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                          Pulse Dashboard
                        </div>
                      </div>
                    </div>

                    <div
                      className="client-arrow"
                      style={{
                        color: "#0047AB",
                        fontSize: "18px",
                        fontWeight: 700,
                        transition: "transform 0.15s ease",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center"
                      }}
                    >
                      {selectingClientName === client.clientName ? (
                        <Spinner size={18} color="#0047AB" />
                      ) : (
                        "→"
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {filteredClients.length === 0 && clients.length > 0 && (
            <div style={{ textAlign: "center", padding: "2rem", color: "#64748b" }}>
              No companies matching &quot;{searchTerm}&quot;
            </div>
          )}
        </div>

        {/* Bottom User Info & Sign Out Footer */}
        <div
          style={{
            background: "#f8fafc",
            borderTop: "1px solid #e2e8f0",
            padding: "1rem 2rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "1rem"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
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
                fontWeight: 700,
                fontSize: "13px"
              }}
            >
              {(user?.name || user?.email || "U")[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#1e293b" }}>
                {user?.name || user?.email}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                style={{
                  background: "transparent",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  padding: "0.45rem 0.9rem",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#475569",
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#f1f5f9"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Back to Dashboard
              </button>
            )}

            <button
              type="button"
              onClick={onLogout}
              style={{
                background: "transparent",
                border: "none",
                padding: "0.45rem 0.75rem",
                fontSize: "13px",
                fontWeight: 600,
                color: "#dc2626",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px"
              }}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 600px) {
          .chooser-header {
            padding: 1.5rem 1rem !important;
          }
          .chooser-content {
            padding: 1.25rem 1rem !important;
          }
        }
      `}</style>
    </div>
  );
}
