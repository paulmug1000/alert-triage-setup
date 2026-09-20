import { useState, useEffect } from "react";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinVerifying, setPinVerifying] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("pulse_access_token");
    if (token) setIsAuthenticated(true);
    setAuthChecking(false);
  }, []);

  const verifyPin = async (code) => {
    setPinVerifying(true);
    setPinError("");
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_pin", pin: code })
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem("pulse_access_token", data.token);
        setIsAuthenticated(true);
      } else {
        setPinError("Incorrect PIN");
        setPinInput("");
      }
    } catch (e) {
      setPinError("Connection error");
      setPinInput("");
    } finally {
      setPinVerifying(false);
    }
  };

  const handlePinInput = (digit) => {
    if (pinInput.length < 4 && !pinVerifying) {
      const newPin = pinInput + digit;
      setPinInput(newPin);
      if (newPin.length === 4) {
        verifyPin(newPin);
      }
    }
  };

  return {
    isAuthenticated,
    authChecking,
    pinInput,
    pinError,
    pinVerifying,
    handlePinInput,
    setPinInput
  };
}