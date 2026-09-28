import { useState, useEffect, useCallback, useRef } from "react";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState(null);

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
          setUser(triageData.user);
          setIsAuthenticated(true);
          setAuthChecking(false);
          return;
        }
      }

      // 3. Fallback check for localStorage legacy token
      const legacyToken = localStorage.getItem("pulse_access_token");
      if (legacyToken) {
        setIsAuthenticated(true);
        setUser({ email: "admin@pulse", name: "Administrator", role: "Admin", assignedClients: "*", isAdmin: true });
      }
    } catch (e) {
      console.warn("Session check error:", e);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

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
      localStorage.removeItem("pma_token");
      localStorage.removeItem("pma_user");
      localStorage.removeItem("pulse_access_token");
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