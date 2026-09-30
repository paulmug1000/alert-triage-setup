import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";

export default function AuthGateView({
  authError,
  setAuthError,
  statusMessage
}) {
  const [oauthError, setOauthError] = useState("");
  const [redirectingProvider, setRedirectingProvider] = useState(null);

  // Catch any OAuth errors passed via redirect query params (e.g. unauthorized)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("auth_error");
      const errEmail = params.get("email");
      const provider = params.get("provider");

      if (err === "unauthorized") {
        setOauthError(
          `Access Denied: The ${provider || "account"} (${errEmail || "provided"}) is not registered in the PMA user directory. Please contact your system administrator to be granted access.`
        );
      } else if (err === "access_denied" || err === "consent_required") {
        setOauthError("Sign-in cancelled or consent was not granted. Please try again.");
      } else if (err) {
        setOauthError(`Sign in failed: ${err.replace(/_/g, " ")}`);
      }
    }
  }, []);

  const activeError = oauthError || authError;

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "radial-gradient(circle at 50% 20%, #1e293b 0%, #0f172a 100%)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      padding: "20px"
    }}>
      <div style={{
        width: "100%",
        maxWidth: "440px",
        background: "rgba(30, 41, 59, 0.85)",
        backdropFilter: "blur(16px)",
        borderRadius: "24px",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        padding: "44px 36px",
        color: "#f8fafc",
        position: "relative",
        overflow: "hidden"
      }}>
        {/* Subtle accent glow at the top */}
        <div style={{
          position: "absolute",
          top: 0,
          left: "15%",
          right: "15%",
          height: "2px",
          background: "linear-gradient(90deg, transparent, #38bdf8, transparent)",
          boxShadow: "0 0 20px #38bdf8"
        }} />

        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            width: "60px",
            height: "60px",
            background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
            borderRadius: "18px",
            margin: "0 auto 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 10px 25px -5px rgba(2, 132, 199, 0.5)",
            border: "1px solid rgba(255, 255, 255, 0.2)"
          }}>
            <span style={{ fontSize: "30px", fontWeight: "800", color: "#ffffff", letterSpacing: "-1px" }}>P</span>
          </div>
          <h1 style={{ margin: "0 0 8px", fontSize: "24px", fontWeight: "700", color: "#ffffff", letterSpacing: "-0.4px" }}>
            Pulse Management App
          </h1>
          <p style={{ margin: 0, fontSize: "14px", color: "#94a3b8" }}>
            Secure Enterprise Sign-In
          </p>
        </div>

        {/* Error Alert Box */}
        {activeError && (
          <div style={{
            background: "rgba(239, 68, 68, 0.15)",
            border: "1px solid rgba(239, 68, 68, 0.35)",
            borderRadius: "12px",
            padding: "14px 16px",
            marginBottom: "24px",
            fontSize: "13px",
            color: "#fca5a5",
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            lineHeight: "1.45"
          }}>
            <span style={{ fontSize: "16px", flexShrink: 0 }}>⚠️</span>
            <div style={{ flex: 1 }}>{activeError}</div>
          </div>
        )}

        {/* Informational Message */}
        {statusMessage && !activeError && (
          <div style={{
            background: "rgba(14, 165, 233, 0.12)",
            border: "1px solid rgba(14, 165, 233, 0.3)",
            borderRadius: "12px",
            padding: "14px 16px",
            marginBottom: "24px",
            fontSize: "13px",
            color: "#7dd3fc",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            lineHeight: "1.4"
          }}>
            <span style={{ fontSize: "16px" }}>ℹ️</span>
            <span>{statusMessage}</span>
          </div>
        )}

        {/* SSO Action Buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Microsoft Sign-In Button */}
          <button
            type="button"
            onClick={() => {
              setRedirectingProvider("Microsoft");
              window.location.href = "/api/auth/oauth/microsoft";
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              width: "100%",
              padding: "13px 20px",
              background: "#ffffff",
              color: "#1e293b",
              borderRadius: "12px",
              border: "none",
              fontWeight: "600",
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
              transition: "transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
              cursor: redirectingProvider ? "wait" : "pointer",
              opacity: redirectingProvider && redirectingProvider !== "Microsoft" ? 0.6 : 1,
              pointerEvents: redirectingProvider ? "none" : "auto"
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 6px 20px rgba(0, 0, 0, 0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.25)";
            }}
          >
            {redirectingProvider === "Microsoft" ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                <Spinner size={16} color="#1e293b" />
                <span style={{ fontWeight: "600", fontSize: "14px", color: "#1e293b" }}>Connecting to Microsoft...</span>
              </div>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 21 21">
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                <span>Sign in with Microsoft</span>
              </>
            )}
          </button>

          {/* Google Sign-In Button */}
          <button
            type="button"
            onClick={() => {
              setRedirectingProvider("Google");
              window.location.href = "/api/auth/oauth/google";
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              width: "100%",
              padding: "13px 20px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "#ffffff",
              borderRadius: "12px",
              border: "1px solid rgba(255, 255, 255, 0.15)",
              fontWeight: "600",
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.15)",
              transition: "transform 0.15s ease, background 0.15s ease, border-color 0.15s ease",
              cursor: redirectingProvider ? "wait" : "pointer",
              opacity: redirectingProvider && redirectingProvider !== "Google" ? 0.6 : 1,
              pointerEvents: redirectingProvider ? "none" : "auto"
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.14)";
              e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.08)";
              e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.15)";
            }}
          >
            {redirectingProvider === "Google" ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                <Spinner size={16} color="#ffffff" />
                <span style={{ fontWeight: "600", fontSize: "14px", color: "#ffffff" }}>Connecting to Google...</span>
              </div>
            ) : (
              <>
                <svg width="19" height="19" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.65v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.14z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.36 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 9.98 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.36 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                  />
                </svg>
                <span>Sign in with Google</span>
              </>
            )}
          </button>
        </div>

        {/* Security & Organization Compliance Notice */}
        <div style={{
          marginTop: "32px",
          paddingTop: "20px",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          textAlign: "center",
          fontSize: "12px",
          color: "#64748b",
          lineHeight: "1.5"
        }}>
          <span>Authorized users only. Access is tied to permissions defined in the central user directory.</span>
        </div>
      </div>
    </div>
  );
}