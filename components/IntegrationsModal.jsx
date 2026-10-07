import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";

export default function IntegrationsModal({
  isOpen,
  onClose,
  clientKey,
  clientName,
  masterSheetId,
  clientSheetId
}) {
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [statusData, setStatusData] = useState(null);
  const [feedback, setFeedback] = useState(null);

  // Check URL query parameters for connection callbacks on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const integration = urlParams.get("integration");
      const status = urlParams.get("status");
      const tenant = urlParams.get("tenant");
      const errorMsg = urlParams.get("message") || urlParams.get("error");

      if (integration === "xero") {
        if (status === "success") {
          setFeedback({
            type: "success",
            message: `Successfully connected to Xero${tenant ? ` (${tenant})` : ""}!`
          });
        } else if (status === "error" || status === "denied") {
          setFeedback({
            type: "error",
            message: errorMsg ? `Connection failed: ${errorMsg}` : "Xero connection was cancelled or denied."
          });
        }
        // Clean URL parameters cleanly without page reload
        urlParams.delete("integration");
        urlParams.delete("status");
        urlParams.delete("tenant");
        urlParams.delete("message");
        urlParams.delete("error");
        const newSearch = urlParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, "", newUrl);
      }
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!clientKey && !masterSheetId && !clientName) return;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (clientKey) q.set("clientKey", clientKey);
      if (clientName) q.set("clientName", clientName);
      if (masterSheetId) q.set("masterSheetId", masterSheetId);

      const res = await fetch(`/api/integrations/status?${q.toString()}`);
      const data = await res.json();
      if (data.success) {
        setStatusData(data.integrations || {});
      }
    } catch (err) {
      console.error("Failed to load integrations status:", err);
    } finally {
      setLoading(false);
    }
  }, [clientKey, clientName, masterSheetId]);

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
    }
  }, [isOpen, fetchStatus]);

  const handleConnectXero = () => {
    const params = new URLSearchParams({
      clientKey: clientKey || clientName,
      clientName: clientName || clientKey,
      masterSheetId: masterSheetId || "",
      clientSheetId: clientSheetId || "",
      redirectBack: window.location.pathname
    });
    window.location.href = `/api/integrations/xero/connect?${params.toString()}`;
  };

  const handleDisconnectXero = async () => {
    if (!confirm("Are you sure you want to disconnect Xero? Any automated invoice syncs will stop until reconnected.")) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/xero/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: clientKey || clientName,
          masterSheetId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "info", message: "Xero integration disconnected." });
        await fetchStatus();
      } else {
        setFeedback({ type: "error", message: data.error || "Failed to disconnect." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setDisconnecting(false);
    }
  };

  if (!isOpen) return null;

  const xero = statusData?.xero || {};
  const isXeroConnected = Boolean(xero.connected);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-xl w-full p-6 animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span>🔌</span> Third-Party Integrations
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Authorise external financial and CRM tools for {clientName || "this workspace"}.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2 rounded-lg text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div
            className={`mt-4 p-3.5 rounded-xl text-xs flex items-center justify-between ${
              feedback.type === "success"
                ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
                : feedback.type === "error"
                ? "bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-200 dark:border-rose-800"
                : "bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800"
            }`}
          >
            <div className="flex items-center gap-2">
              <span>{feedback.type === "success" ? "✓" : feedback.type === "error" ? "⚠️" : "ℹ️"}</span>
              <span>{feedback.message}</span>
            </div>
            <button onClick={() => setFeedback(null)} className="text-slate-400 hover:text-slate-600 font-bold ml-2">
              ✕
            </button>
          </div>
        )}

        {/* Content Body */}
        <div className="mt-5 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3">
              <Spinner size="md" />
              <span className="text-xs text-slate-500">Checking integration statuses...</span>
            </div>
          ) : (
            <>
              {/* Xero Card */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#00b4d8]/10 text-[#00b4d8] flex items-center justify-center font-bold text-xl flex-shrink-0">
                    X
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm text-slate-900 dark:text-white">Xero Accounting</h3>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          isXeroConnected
                            ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                            : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                        }`}
                      >
                        {isXeroConnected ? "Connected" : "Not Connected"}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Synchronise sales invoices, tracking categories, and monthly journals.
                    </p>
                    {isXeroConnected && xero.tenantName && (
                      <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
                        Linked to Organisation: <span className="font-semibold underline">{xero.tenantName}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end flex-shrink-0">
                  {isXeroConnected ? (
                    <button
                      onClick={handleDisconnectXero}
                      disabled={disconnecting}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200 dark:border-rose-900 transition-colors"
                    >
                      {disconnecting ? "Disconnecting..." : "Disconnect"}
                    </button>
                  ) : (
                    <button
                      onClick={handleConnectXero}
                      className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-[#023f98] hover:bg-[#005ee9] shadow-sm transition-all"
                    >
                      Connect Xero
                    </button>
                  )}
                </div>
              </div>

              {/* QuickBooks Online (Placeholder) */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20 flex items-center justify-between opacity-75">
                <div className="flex items-start gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#2ca01c]/10 text-[#2ca01c] flex items-center justify-center font-bold text-xl flex-shrink-0">
                    Q
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm text-slate-900 dark:text-white">QuickBooks Online</h3>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500">
                        Available Soon
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Connect QuickBooks company to synchronise invoices and expenses.
                    </p>
                  </div>
                </div>
              </div>

              {/* ClickUp (Placeholder) */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-800/20 flex items-center justify-between opacity-75">
                <div className="flex items-start gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#7b68ee]/10 text-[#7b68ee] flex items-center justify-center font-bold text-xl flex-shrink-0">
                    C
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm text-slate-900 dark:text-white">ClickUp</h3>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500">
                        Available Soon
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Connect ClickUp workspace to synchronise pipeline opportunities.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">
            🔒 Protected by Pulse AES-256-GCM Central Vault
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
