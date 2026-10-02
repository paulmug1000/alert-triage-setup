import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";

export default function AuthGateView({
  authStep: propAuthStep,
  emailInput: propEmailInput,
  setEmailInput: propSetEmailInput,
  codeInput: propCodeInput,
  setCodeInput: propSetCodeInput,
  authError: propAuthError,
  setAuthError: propSetAuthError,
  authLoading: propAuthLoading,
  statusMessage: propStatusMessage,
  cooldown: propCooldown,
  sendVerificationCode: propSendVerificationCode,
  verifyCode: propVerifyCode,
  resetToEmailStep: propResetToEmailStep
}) {
  // Local fallbacks if props not supplied
  const [localEmail, setLocalEmail] = useState("");
  const [localCode, setLocalCode] = useState("");
  const [localStep, setLocalStep] = useState("email");
  const [localError, setLocalError] = useState("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localStatus, setLocalStatus] = useState("");
  const [localCooldown, setLocalCooldown] = useState(0);

  const email = propEmailInput !== undefined ? propEmailInput : localEmail;
  const setEmail = propSetEmailInput || setLocalEmail;
  const code = propCodeInput !== undefined ? propCodeInput : localCode;
  const setCode = propSetCodeInput || setLocalCode;
  const step = propAuthStep || localStep;
  const setStep = (s) => {
    if (propResetToEmailStep && s === "email") {
      propResetToEmailStep();
    } else {
      setLocalStep(s);
    }
  };
  const error = propAuthError !== undefined ? propAuthError : localError;
  const setError = propSetAuthError || setLocalError;
  const loading = propAuthLoading !== undefined ? propAuthLoading : localLoading;
  const status = propStatusMessage !== undefined ? propStatusMessage : localStatus;
  const cooldown = propCooldown !== undefined ? propCooldown : localCooldown;

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
        const accountLabel = provider ? `${provider} account` : "account";
        const emailSuffix = errEmail ? ` (${errEmail})` : "";
        setOauthError(
          `Access Denied: The ${accountLabel}${emailSuffix} is not authorised to access Pulse. Please contact hello@pulsedashboard.co.uk with any queries.`
        );
      } else if (err === "access_denied" || err === "consent_required") {
        setOauthError("Sign-in was cancelled or consent was not granted. Please try again.");
      } else if (err) {
        setOauthError(`Sign in failed: ${err.replace(/_/g, " ")}`);
      }
    }
  }, []);

  // Handle local send code fallback if no prop provided
  const handleSendCode = async (targetEmail) => {
    const mail = (targetEmail || email || "").trim().toLowerCase();
    if (!mail) {
      setError("Please enter your email address");
      return;
    }

    if (propSendVerificationCode) {
      await propSendVerificationCode(mail);
      return;
    }

    setLocalLoading(true);
    setError("");
    setLocalStatus("");
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: mail })
      });
      const data = await res.json();
      if (data.success) {
        setEmail(mail);
        setLocalStep("code");
        setCode("");
        setLocalCooldown(60);
        setLocalStatus(data.message || `Verification code sent to ${mail}`);
      } else {
        setError(data.message || "Failed to send verification code");
      }
    } catch (e) {
      setError("Network error. Please try again.");
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle local verify code fallback if no prop provided
  const handleVerifyCode = async () => {
    const c = (code || "").trim();
    if (!c) {
      setError("Please enter the 6-digit verification code");
      return;
    }

    if (propVerifyCode) {
      await propVerifyCode(c);
      return;
    }

    setLocalLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: c })
      });
      const data = await res.json();
      if (data.success) {
        window.location.reload();
      } else {
        setError(data.message || "Invalid verification code");
      }
    } catch (e) {
      setError("Network error verifying code. Please try again.");
    } finally {
      setLocalLoading(false);
    }
  };

  const handleResetToEmail = () => {
    if (propResetToEmailStep) {
      propResetToEmailStep();
    } else {
      setLocalStep("email");
      setCode("");
      setError("");
      setLocalStatus("");
    }
  };

  const activeError = oauthError || error;

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: "20px",
        boxSizing: "border-box"
      }}
    >
      {/* Pulse Card - Exactly matching WebApp.html styles */}
      <div
        className="login-box"
        style={{
          background: "#0047AB",
          borderRadius: "12px",
          maxWidth: "450px",
          width: "100%",
          padding: "3rem 2.5rem",
          boxShadow: "0 10px 40px rgba(0, 0, 0, 0.2)",
          color: "#ffffff",
          boxSizing: "border-box"
        }}
      >
        {/* Logo and Header */}
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          {/* Pulse Logo */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/pulselogo.png"
            alt="Pulse"
            style={{
              display: "block",
              margin: "0 auto 1.5rem auto",
              maxHeight: "80px",
              maxWidth: "250px",
              width: "auto",
              height: "auto"
            }}
            onError={(e) => {
              // Fallback to stylized text if logo file is loading
              e.currentTarget.style.display = "none";
              const fb = document.getElementById("pulse-logo-fallback");
              if (fb) fb.style.display = "inline-block";
            }}
          />
          <div
            id="pulse-logo-fallback"
            style={{
              display: "none",
              fontSize: "32px",
              fontWeight: "800",
              color: "#ffffff",
              letterSpacing: "1px",
              marginBottom: "1rem"
            }}
          >
            PULSE
          </div>

          <h1
            style={{
              fontSize: "1.75rem",
              fontWeight: 600,
              margin: "0 0 0.5rem 0",
              color: "#ffffff",
              letterSpacing: "-0.3px"
            }}
          >
            Welcome to Pulse
          </h1>
          <p
            style={{
              fontSize: "0.95rem",
              color: "#ffffff",
              margin: 0,
              opacity: 0.95
            }}
          >
            Enter your email to get started
          </p>
        </div>

        {/* SSO Options: Microsoft & Google */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Microsoft Sign-In Button */}
          <button
            type="button"
            onClick={() => {
              setRedirectingProvider("Microsoft");
              window.location.href = "/api/auth/oauth/microsoft";
            }}
            disabled={redirectingProvider !== null}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              width: "100%",
              padding: "0.9rem",
              background: "#ffffff",
              color: "#1f2937",
              borderRadius: "8px",
              border: "1px solid rgba(255, 255, 255, 0.9)",
              fontWeight: 600,
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.18)",
              cursor: redirectingProvider ? "wait" : "pointer",
              transition: "transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
              boxSizing: "border-box"
            }}
            onMouseEnter={(e) => {
              if (!redirectingProvider) {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = "0 6px 20px rgba(0, 0, 0, 0.25)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.18)";
            }}
          >
            {redirectingProvider === "Microsoft" ? (
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Spinner size={16} color="#1f2937" />
                <span>Connecting to Microsoft...</span>
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
            disabled={redirectingProvider !== null}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              width: "100%",
              padding: "0.9rem",
              background: "#ffffff",
              color: "#1f2937",
              borderRadius: "8px",
              border: "1px solid rgba(255, 255, 255, 0.9)",
              fontWeight: 600,
              fontSize: "15px",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.18)",
              cursor: redirectingProvider ? "wait" : "pointer",
              transition: "transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
              boxSizing: "border-box"
            }}
            onMouseEnter={(e) => {
              if (!redirectingProvider) {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = "0 6px 20px rgba(0, 0, 0, 0.25)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.18)";
            }}
          >
            {redirectingProvider === "Google" ? (
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Spinner size={16} color="#1f2937" />
                <span>Connecting to Google...</span>
              </div>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24">
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

        {/* Divider */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            margin: "1.75rem 0 1.5rem 0",
            gap: "12px"
          }}
        >
          <div style={{ flex: 1, height: "1px", background: "rgba(255, 255, 255, 0.25)" }} />
          <span
            style={{
              color: "rgba(255, 255, 255, 0.85)",
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "0.2px"
            }}
          >
            or continue with email
          </span>
          <div style={{ flex: 1, height: "1px", background: "rgba(255, 255, 255, 0.25)" }} />
        </div>

        {/* Email OTP Step 1: Email Entry */}
        {step === "email" && (
          <div>
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  color: "#ffffff",
                  fontWeight: 500,
                  marginBottom: "0.5rem",
                  fontSize: "0.9rem"
                }}
              >
                Email Address
              </label>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (activeError) {
                    setError("");
                    setOauthError("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSendCode();
                }}
                className="login-input"
                style={{
                  width: "100%",
                  padding: "0.875rem 1rem",
                  border: "2px solid rgba(255, 255, 255, 0.3)",
                  borderRadius: "8px",
                  fontSize: "16px",
                  boxSizing: "border-box",
                  background: "#ffffff",
                  color: "#0047AB",
                  fontWeight: 500,
                  outline: "none",
                  transition: "border-color 0.2s"
                }}
              />
            </div>

            <button
              type="button"
              onClick={() => handleSendCode()}
              disabled={loading}
              className="login-button"
              style={{
                width: "100%",
                background: "#ffffff",
                color: "#0047AB",
                border: "none",
                padding: "1rem",
                borderRadius: "8px",
                fontSize: "1rem",
                fontWeight: 600,
                cursor: loading ? "wait" : "pointer",
                boxShadow: "0 4px 14px rgba(0, 0, 0, 0.12)",
                transition: "background 0.2s, transform 0.15s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px"
              }}
            >
              {loading ? (
                <>
                  <Spinner size={16} color="#0047AB" />
                  <span>Sending code...</span>
                </>
              ) : (
                "Send Verification Code"
              )}
            </button>
          </div>
        )}

        {/* Email OTP Step 2: Code Verification */}
        {step === "code" && (
          <div>
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  color: "#ffffff",
                  fontWeight: 500,
                  marginBottom: "0.35rem",
                  fontSize: "0.9rem"
                }}
              >
                Verification Code
              </label>
              <p
                style={{
                  color: "rgba(255, 255, 255, 0.9)",
                  fontSize: "0.875rem",
                  margin: "0 0 1rem 0"
                }}
              >
                Enter the 6-digit code sent to{" "}
                <strong style={{ color: "#ffffff", fontWeight: 600 }}>{email}</strong>
              </p>
              <input
                type="text"
                placeholder="000000"
                maxLength={6}
                pattern="[0-9]*"
                inputMode="numeric"
                value={code}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/[^0-9]/g, "");
                  setCode(cleaned);
                  if (activeError) {
                    setError("");
                    setOauthError("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleVerifyCode();
                }}
                autoFocus
                className="login-input login-code-input"
                style={{
                  width: "100%",
                  padding: "0.875rem",
                  border: "2px solid rgba(255, 255, 255, 0.3)",
                  borderRadius: "8px",
                  fontSize: "1.5rem",
                  textAlign: "center",
                  letterSpacing: "0.5rem",
                  fontFamily: "monospace",
                  fontWeight: 700,
                  boxSizing: "border-box",
                  background: "#ffffff",
                  color: "#0047AB",
                  outline: "none"
                }}
              />
            </div>

            {/* Verify & Login Button */}
            <button
              type="button"
              onClick={() => handleVerifyCode()}
              disabled={loading}
              className="login-button"
              style={{
                width: "100%",
                background: "#ffffff",
                color: "#0047AB",
                border: "none",
                padding: "1rem",
                borderRadius: "8px",
                fontSize: "1rem",
                fontWeight: 600,
                cursor: loading ? "wait" : "pointer",
                boxShadow: "0 4px 14px rgba(0, 0, 0, 0.12)",
                transition: "background 0.2s, transform 0.15s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px"
              }}
            >
              {loading ? (
                <>
                  <Spinner size={16} color="#0047AB" />
                  <span>Verifying...</span>
                </>
              ) : (
                "Verify & Sign In"
              )}
            </button>

            {/* Use Different Email */}
            <button
              type="button"
              onClick={handleResetToEmail}
              disabled={loading}
              style={{
                width: "100%",
                background: "transparent",
                color: "#ffffff",
                border: "2px solid rgba(255, 255, 255, 0.8)",
                padding: "0.85rem",
                borderRadius: "8px",
                fontSize: "0.95rem",
                fontWeight: 600,
                cursor: "pointer",
                marginTop: "0.75rem",
                transition: "background 0.2s"
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.15)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              Use Different Email
            </button>

            {/* Resend Code Option */}
            <div style={{ textAlign: "center", marginTop: "1rem" }}>
              {cooldown > 0 ? (
                <span style={{ color: "rgba(255, 255, 255, 0.75)", fontSize: "0.85rem" }}>
                  Resend code in {cooldown}s
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSendCode(email)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ffffff",
                    fontSize: "0.85rem",
                    textDecoration: "underline",
                    cursor: "pointer",
                    padding: 0
                  }}
                >
                  Didn&apos;t receive code? Resend
                </button>
              )}
            </div>
          </div>
        )}

        {/* Error Alert Box - Matching WebApp.html .login-error */}
        {activeError && (
          <div
            className="login-error"
            style={{
              background: "#fee2e2",
              color: "#991b1b",
              border: "1px solid #f87171",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              marginTop: "1.25rem",
              fontSize: "0.875rem",
              textAlign: "center",
              lineHeight: "1.4"
            }}
          >
            {activeError}
          </div>
        )}

        {/* Status Message Box */}
        {status && !activeError && (
          <div
            style={{
              background: "rgba(255, 255, 255, 0.2)",
              color: "#ffffff",
              border: "1px solid rgba(255, 255, 255, 0.35)",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              marginTop: "1.25rem",
              fontSize: "0.875rem",
              textAlign: "center",
              lineHeight: "1.4"
            }}
          >
            {status}
          </div>
        )}

        {/* Authorised users only notice */}
        <div
          style={{
            marginTop: "1.75rem",
            paddingTop: "1.25rem",
            borderTop: "1px solid rgba(255, 255, 255, 0.2)",
            textAlign: "center",
            fontSize: "12px",
            color: "rgba(255, 255, 255, 0.7)",
            letterSpacing: "0.3px"
          }}
        >
          Authorised users only.
        </div>
      </div>
    </div>
  );
}