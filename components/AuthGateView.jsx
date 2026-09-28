import React, { useState, useEffect, useRef } from "react";
import Spinner from "./Spinner";

export default function AuthGateView({
  authStep,
  emailInput,
  setEmailInput,
  codeInput,
  setCodeInput,
  authError,
  setAuthError,
  authLoading,
  statusMessage,
  cooldown,
  sendVerificationCode,
  verifyCode,
  resetToEmailStep
}) {
  const codeInputRef = useRef(null);

  // Auto-focus code input when switching to code step
  useEffect(() => {
    if (authStep === "code" && codeInputRef.current) {
      codeInputRef.current.focus();
    }
  }, [authStep]);

  // Handle email submit
  const handleEmailSubmit = (e) => {
    e.preventDefault();
    if (!authLoading) {
      sendVerificationCode();
    }
  };

  // Handle code submit
  const handleCodeSubmit = (e) => {
    e.preventDefault();
    if (!authLoading && codeInput.trim().length === 6) {
      verifyCode();
    }
  };

  // Auto-submit when 6 digits are typed
  const handleCodeChange = (e) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCodeInput(val);
    if (setAuthError) setAuthError("");
    if (val.length === 6 && !authLoading) {
      verifyCode(val);
    }
  };

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
        maxWidth: "420px",
        background: "rgba(30, 41, 59, 0.85)",
        backdropFilter: "blur(16px)",
        borderRadius: "20px",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        padding: "40px 32px",
        color: "#f8fafc",
        position: "relative",
        overflow: "hidden"
      }}>
        {/* Subtle accent glow at the top */}
        <div style={{
          position: "absolute",
          top: 0,
          left: "20%",
          right: "20%",
          height: "2px",
          background: "linear-gradient(90deg, transparent, #38bdf8, transparent)",
          boxShadow: "0 0 15px #38bdf8"
        }} />

        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            width: "56px",
            height: "56px",
            background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
            borderRadius: "16px",
            margin: "0 auto 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 10px 20px -5px rgba(2, 132, 199, 0.5)",
            border: "1px solid rgba(255, 255, 255, 0.2)"
          }}>
            <span style={{ fontSize: "28px", fontWeight: "800", color: "#ffffff", letterSpacing: "-1px" }}>P</span>
          </div>
          <h1 style={{ margin: "0 0 6px", fontSize: "22px", fontWeight: "700", color: "#ffffff", letterSpacing: "-0.3px" }}>
            Pulse Management App
          </h1>
          <p style={{ margin: 0, fontSize: "14px", color: "#94a3b8" }}>
            Secure Portal
          </p>
        </div>

        {/* Status / Error Pill */}
        {authError && (
          <div style={{
            background: "rgba(239, 68, 68, 0.15)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "10px",
            padding: "12px 14px",
            marginBottom: "20px",
            fontSize: "13px",
            color: "#fca5a5",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: "1.4"
          }}>
            <span style={{ fontSize: "16px" }}>⚠️</span>
            <span>{authError}</span>
          </div>
        )}

        {statusMessage && !authError && (
          <div style={{
            background: "rgba(14, 165, 233, 0.12)",
            border: "1px solid rgba(14, 165, 233, 0.3)",
            borderRadius: "10px",
            padding: "12px 14px",
            marginBottom: "20px",
            fontSize: "13px",
            color: "#7dd3fc",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            lineHeight: "1.4"
          }}>
            <span style={{ fontSize: "16px" }}>ℹ️</span>
            <span>{statusMessage}</span>
          </div>
        )}

        {/* STEP 1: Enter Email */}
        {authStep === "email" ? (
          <form onSubmit={handleEmailSubmit}>
            <div style={{ marginBottom: "24px" }}>
              <label htmlFor="auth-email-input" style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "13px",
                fontWeight: "500",
                color: "#cbd5e1"
              }}>
                Work Email Address
              </label>
              <div style={{ position: "relative" }}>
                <input
                  id="auth-email-input"
                  type="email"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    if (setAuthError) setAuthError("");
                  }}
                  placeholder="name@company.com"
                  autoFocus
                  required
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "14px 16px",
                    background: "rgba(15, 23, 42, 0.6)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    borderRadius: "12px",
                    color: "#ffffff",
                    fontSize: "15px",
                    outline: "none",
                    transition: "all 0.2s ease"
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "#38bdf8";
                    e.target.style.boxShadow = "0 0 0 3px rgba(56, 189, 248, 0.2)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "rgba(255, 255, 255, 0.15)";
                    e.target.style.boxShadow = "none";
                  }}
                />
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748b" }}>
                We will email you a 6-digit one-time verification code.
              </p>
            </div>

            <button
              id="send-code-btn"
              type="submit"
              disabled={authLoading || !emailInput.trim()}
              style={{
                width: "100%",
                padding: "14px",
                background: authLoading || !emailInput.trim()
                  ? "rgba(2, 132, 199, 0.4)"
                  : "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
                border: "none",
                borderRadius: "12px",
                color: "#ffffff",
                fontSize: "15px",
                fontWeight: "600",
                cursor: authLoading || !emailInput.trim() ? "not-allowed" : "pointer",
                boxShadow: "0 4px 12px rgba(2, 132, 199, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                transition: "all 0.15s ease"
              }}
              onMouseEnter={(e) => {
                if (!authLoading && emailInput.trim()) e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              {authLoading ? (
                <>
                  <Spinner size={16} color="#ffffff" />
                  <span>Sending code...</span>
                </>
              ) : (
                <>
                  <span>Send Verification Code</span>
                  <span style={{ fontSize: "18px" }}>&rarr;</span>
                </>
              )}
            </button>
          </form>
        ) : (
          /* STEP 2: Enter 6-digit Code */
          <form onSubmit={handleCodeSubmit}>
            <div style={{ marginBottom: "20px" }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px"
              }}>
                <label htmlFor="auth-code-input" style={{
                  fontSize: "13px",
                  fontWeight: "500",
                  color: "#cbd5e1"
                }}>
                  6-Digit Verification Code
                </label>
                <button
                  type="button"
                  onClick={resetToEmailStep}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#38bdf8",
                    fontSize: "12px",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline"
                  }}
                >
                  Change email
                </button>
              </div>

              <div style={{
                background: "rgba(15, 23, 42, 0.4)",
                padding: "8px 12px",
                borderRadius: "8px",
                marginBottom: "16px",
                fontSize: "12px",
                color: "#94a3b8",
                display: "flex",
                justifyContent: "space-between"
              }}>
                <span>Sent to: <strong style={{ color: "#f8fafc" }}>{emailInput}</strong></span>
              </div>

              <input
                id="auth-code-input"
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={codeInput}
                onChange={handleCodeChange}
                placeholder="&bull; &bull; &bull; &bull; &bull; &bull;"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "16px 20px",
                  background: "rgba(15, 23, 42, 0.8)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "12px",
                  color: "#ffffff",
                  fontSize: "28px",
                  fontWeight: "700",
                  textAlign: "center",
                  letterSpacing: "12px",
                  outline: "none",
                  transition: "all 0.2s ease"
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = "#38bdf8";
                  e.target.style.boxShadow = "0 0 0 3px rgba(56, 189, 248, 0.2)";
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = "rgba(255, 255, 255, 0.2)";
                  e.target.style.boxShadow = "none";
                }}
              />
            </div>

            <button
              id="verify-code-btn"
              type="submit"
              disabled={authLoading || codeInput.trim().length !== 6}
              style={{
                width: "100%",
                padding: "14px",
                background: authLoading || codeInput.trim().length !== 6
                  ? "rgba(2, 132, 199, 0.4)"
                  : "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
                border: "none",
                borderRadius: "12px",
                color: "#ffffff",
                fontSize: "15px",
                fontWeight: "600",
                cursor: authLoading || codeInput.trim().length !== 6 ? "not-allowed" : "pointer",
                boxShadow: "0 4px 12px rgba(2, 132, 199, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                transition: "all 0.15s ease",
                marginBottom: "16px"
              }}
            >
              {authLoading ? (
                <>
                  <Spinner size={16} color="#ffffff" />
                  <span>Verifying...</span>
                </>
              ) : (
                <span>Verify & Sign In</span>
              )}
            </button>

            {/* Resend Code Link */}
            <div style={{ textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
              {cooldown > 0 ? (
                <span>Resend code in <strong style={{ color: "#cbd5e1" }}>{cooldown}s</strong></span>
              ) : (
                <button
                  type="button"
                  onClick={() => sendVerificationCode()}
                  disabled={authLoading}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#38bdf8",
                    fontSize: "13px",
                    fontWeight: "500",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline"
                  }}
                >
                  Resend verification code
                </button>
              )}
            </div>
          </form>
        )}

        {/* Footer */}
        <div style={{
          marginTop: "32px",
          paddingTop: "20px",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          textAlign: "center",
          fontSize: "11px",
          color: "#64748b",
          lineHeight: "1.5"
        }}>
          Pulse Management App<br />
          &copy; {new Date().getFullYear()} Thrive Organisational Consulting Ltd
        </div>
      </div>
    </div>
  );
}