import { useState, useEffect, useCallback, useRef } from "react";

export function useAuth(initialUser = null) {
  if (typeof window !== "undefined" && initialUser) {
    window.__PULSE_SESSION_USER__ = initialUser;
  }
  const hydratedUser = initialUser || (typeof window !== "undefined" ? window.__PULSE_SESSION_USER__ || null : null);

  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(hydratedUser));
  const [authChecking, setAuthChecking] = useState(!hydratedUser);
  const [user, setUser] = useState(hydratedUser);

  // OTP flow state
  const [authStep, setAuthStep] = useState("email"); // "email" | "code"
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [cooldown, setCooldown] = useState(0);

  const cooldownTimerRef = useRef(null);

  // Manage cooldown countdown
  useEffect(() => {
    if (cooldown > 0) {
      cooldownTimerRef.current = setTimeout(() => {
        setCooldown(prev => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => clearTimeout(cooldownTimerRef.current);
  }, [cooldown]);

  // Check active session on initial mount
  const checkSession = useCallback(async () => {
    try {
      // 1. Try session endpoint
      const res = await fetch("/api/auth/session");
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          if (typeof window !== "undefined") window.__PULSE_SESSION_USER__ = data.user;
          setUser(data.user);
          setIsAuthenticated(true);
          setAuthChecking(false);
          return;
        }
      }

      // 2. Fallback check with /api/triage
      const triageRes = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_session" })
      });
      if (triageRes.ok) {
        const triageData = await triageRes.json();
        if (triageData.authenticated && triageData.user) {
          if (typeof window !== "undefined") window.__PULSE_SESSION_USER__ = triageData.user;
          setUser(triageData.user);
          setIsAuthenticated(true);
          setAuthChecking(false);
          return;
        }
      }

      // If no valid session found, clear legacy tokens
      try {
        localStorage.removeItem("pulse_access_token");
      } catch {}
    } catch (e) {
      console.warn("Session check error:", e);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!hydratedUser) {
      checkSession();
    }
  }, [checkSession, hydratedUser]);

  /**
   * Send 6-digit OTP to user email
   */
  const sendVerificationCode = async (emailOverride) => {
    const targetEmail = (emailOverride || emailInput || "").trim().toLowerCase();
    if (!targetEmail) {
      setAuthError("Please enter your email address");
      return false;
    }

    setAuthLoading(true);
    setAuthError("");
    setStatusMessage("");

    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetEmail })
      });
      const data = await res.json();

      if (data.success) {
        setEmailInput(targetEmail);
        setAuthStep("code");
        setCodeInput("");
        setCooldown(60);
        setStatusMessage(data.message || `Verification code sent to ${targetEmail}`);
        if (data.devCode) {
          console.log(`🔑 DEV OTP CODE: ${data.devCode}`);
        }
        return true;
      } else {
        setAuthError(data.message || "Failed to send verification code");
        if (data.adminOtpBlocked) {
          setAuthStep("email");
          setCodeInput("");
        }
        return false;
      }
    } catch (err) {
      console.error("sendVerificationCode error:", err);
      setAuthError("Network error. Please try again.");
      return false;
    } finally {
      setAuthLoading(false);
    }
  };

  /**
   * Verify the entered 6-digit OTP code
   */
  const verifyCode = async (codeOverride) => {
    const code = (codeOverride || codeInput || "").trim();
    if (!code) {
      setAuthError("Please enter the 6-digit verification code");
      return false;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      const res = await fetch("/api/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim().toLowerCase(), code })
      });
      const data = await res.json();

      if (data.success && data.user) {
        if (typeof window !== "undefined") window.__PULSE_SESSION_USER__ = data.user;
        if (data.token) {
          try {
            localStorage.setItem("pma_token", data.token);
            localStorage.setItem("pma_user", JSON.stringify(data.user));
          } catch {}
        }
        setUser(data.user);
        setIsAuthenticated(true);
        return true;
      } else {
        setAuthError(data.message || "Invalid verification code");
        if (data.adminOtpBlocked) {
          setAuthStep("email");
        }
        setCodeInput("");
        return false;
      }
    } catch (err) {
      console.error("verifyCode error:", err);
      setAuthError("Network error verifying code. Please try again.");
      return false;
    } finally {
      setAuthLoading(false);
    }
  };

  /**
   * Log out and clear session
   */
  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    try {
      if (typeof window !== "undefined") window.__PULSE_SESSION_USER__ = null;
      localStorage.removeItem("pma_token");
      localStorage.removeItem("pma_user");
      localStorage.removeItem("pulse_access_token");
      localStorage.removeItem("pma_managed_client");
    } catch {}
    setIsAuthenticated(false);
    setUser(null);
    setAuthStep("email");
    setEmailInput("");
    setCodeInput("");
    setAuthError("");
    setStatusMessage("");
  };

  const resetToEmailStep = () => {
    setAuthStep("email");
    setCodeInput("");
    setAuthError("");
    setStatusMessage("");
  };

  return {
    isAuthenticated,
    authChecking,
    user,
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
    logout,
    resetToEmailStep,
    checkSession
  };
}