import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import CellNoteIndicator from "./CellNoteIndicator";
import EditClientSelector from "./EditClientSelector";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";

export const parseSheetDate = (dStr) => {
  if (!dStr) return null;
  if (dStr instanceof Date) return isNaN(dStr.getTime()) ? null : dStr;
  const s = String(dStr).trim();
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  // 0. Serial number (Google Sheets date integer)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    return new Date((serial - 25569) * 86400 * 1000);
  }

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mIdx = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(yr, mIdx, day);
  }

  // 2. DD-Mon-YY or DD-Mon-YYYY or D Mon YYYY or DD/Mon/YYYY
  const m = s.match(/^(\d{1,2})[-/\s]([A-Za-z]+)[-/\s](\d{2,4})$/);
  if (m) {
    const mIdx = months[m[2].toLowerCase().slice(0, 3)];
    if (mIdx !== undefined) {
      let yr = parseInt(m[3], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      return new Date(yr, mIdx, parseInt(m[1], 10));
    }
  }

  // 3. Mon-YY or Mon YYYY
  const myMatch = s.match(/^([A-Za-z]+)[-/\s](\d{2,4})$/);
  if (myMatch) {
    const mIdx = months[myMatch[1].toLowerCase().slice(0, 3)];
    if (mIdx !== undefined) {
      let yr = parseInt(myMatch[2], 10);
      if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
      return new Date(yr, mIdx, 1);
    }
  }

  // 4. DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += (yr <= 69 ? 2000 : 1900);
    return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const formatCurrency = (val) => {
  if (val === null || val === undefined || val === "") return "£0.00";
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return "£0.00";
  if (s.startsWith("£") || s.startsWith("$") || s.startsWith("€")) return s;
  const num = parseFloat(s.replace(/[£$€,\s]/g, ""));
  if (isNaN(num)) return s;
  return "£" + num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const parseNum = (val) => {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-") return 0;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const cleaned = s.replace(/[£$€,\s()]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isNeg ? -Math.abs(num) : num;
};

const hasMonthAmounts = (ea) => {
  if (!ea.name || !ea.name.trim()) return false;
  return (
    parseNum(ea.salary) !== 0 ||
    parseNum(ea.eeNic) !== 0 ||
    parseNum(ea.erNic) !== 0 ||
    parseNum(ea.studentLoan) !== 0 ||
    parseNum(ea.eePension) !== 0 ||
    parseNum(ea.erPension) !== 0 ||
    parseNum(ea.paye) !== 0
  );
};

export default function SalariesView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  // Client Selection State (synchronous initial selection from managedClient or initialClient to eliminate flash)
  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
    }
    if (initialClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === (typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase())
      ) || (typeof initialClient === "object" ? initialClient : null);
    }
    return null;
  });
  const [clientSearch, setClientSearch] = useState("");

  // Salaries & Dividends Data (instant initialization from memory cache if preloaded)
  const [salariesData, setSalariesData] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    if (target?.clientSheetId) {
      const cached = getCachedClientData(target.clientSheetId, "salaries");
      if (cached?.data) return cached.data;
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // Month & FY View Controls
  const [selectedMonthIdx, setSelectedMonthIdx] = useState(() => salariesData?.defaultMonthIndex ?? 0);
  const [selectedFyIdx, setSelectedFyIdx] = useState(() => salariesData?.dividends?.defaultFyIndex ?? 0);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeTab, setEmployeeTab] = useState("all"); // "all" | "current" | "former"
  const [hoveredRowIndex, setHoveredRowIndex] = useState(null);

  // Modals / Edit States
  const [editingEmployee, setEditingEmployee] = useState(null); // { sheetRow, employeeData }
  const [editingDividendMonth, setEditingDividendMonth] = useState(null); // { sheetRow, colLetter, label, value }
  const [editingDividendPct, setEditingDividendPct] = useState(false);
  const [dividendPctInput, setDividendPctInput] = useState(() => salariesData?.dividends?.fyConfigs?.[salariesData?.dividends?.defaultFyIndex ?? 0]?.row118?.deliveryPct || "0%");

  // Resolve active client from managedClient or initialClient
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient(match);
      return;
    }
    if (initialClient) {
      const clientNameStr = typeof initialClient === "string" ? initialClient : initialClient?.clientName;
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === clientNameStr?.toLowerCase()
      );
      if (match) {
        setSelectedClient(match);
        return;
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const handleBackToClients = () => {
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setSalariesData(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_salaries_client");
      }
    }
  };

  // Fetch Salaries Data with in-memory caching
  const fetchSalaries = useCallback(async (client, bypassCache = false) => {
    if (!client || !client.masterSheetId || !client.clientSheetId) return;
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : client.clientSheetId;

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, "salaries") : null;
    if (cached?.data) {
      setSalariesData(cached.data);
      setSelectedMonthIdx(cached.data.defaultMonthIndex ?? 0);
      setSelectedFyIdx(cached.data.dividends?.defaultFyIndex ?? 0);
      setDividendPctInput(cached.data.dividends?.fyConfigs?.[cached.data.dividends?.defaultFyIndex ?? 0]?.row118?.deliveryPct || "0%");
      setLoading(false);
      if (!cached.isStale) return;
    } else {
      setLoading(true);
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`salaries_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, "salaries");
          if (fresh?.data) {
            setSalariesData(fresh.data);
            setSelectedMonthIdx(fresh.data.defaultMonthIndex ?? 0);
            setSelectedFyIdx(fresh.data.dividends?.defaultFyIndex ?? 0);
            setDividendPctInput(fresh.data.dividends?.fyConfigs?.[fresh.data.dividends?.defaultFyIndex ?? 0]?.row118?.deliveryPct || "0%");
            setLoading(false);
            return;
          }
        } catch {}
      }
    }

    setError(null);
    try {
      const res = await fetch(
        `/api/pma/salaries?clientName=${encodeURIComponent(client.clientName)}&masterSheetId=${encodeURIComponent(
          client.masterSheetId
        )}&clientSheetId=${encodeURIComponent(client.clientSheetId)}${bypassCache ? "&bypassCache=true" : ""}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load salaries data");
      }
      setSalariesData(data);
      setSelectedMonthIdx(data.defaultMonthIndex ?? 0);
      setSelectedFyIdx(data.dividends?.defaultFyIndex ?? 0);
      setDividendPctInput(data.dividends?.fyConfigs?.[data.dividends?.defaultFyIndex ?? 0]?.row118?.deliveryPct || "0%");
      setCachedClientData(client.clientSheetId, "salaries", data);
    } catch (err) {
      console.error("Failed to fetch salaries:", err);
      setError(err.message || "Failed to load salaries data");
    } finally {
      setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_salaries_client", selectedClient.clientName);
      }
      fetchSalaries(selectedClient);
    }
  }, [selectedClient, fetchSalaries]);

  // Flash success message helper
  const showSuccess = (msg) => {
    setSaveSuccessMsg(msg);
    setTimeout(() => setSaveSuccessMsg(""), 4000);
  };

  // ── SAVE EMPLOYEE HANDLER ──────────────────────────────────────────────────
  const handleSaveEmployee = async (updatedEmp) => {
    if (!selectedClient || !updatedEmp || !updatedEmp.sheetRow) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/salaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_employee",
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: updatedEmp.sheetRow,
          employeeData: {
            name: updatedEmp.name,
            role: updatedEmp.role,
            fteSalary: updatedEmp.fteSalary,
            fte: updatedEmp.fte,
            startDate: updatedEmp.startDate,
            endDate: updatedEmp.endDate,
            deliveryPct: updatedEmp.deliveryPct,
            studentLoan: updatedEmp.studentLoan,
            pension: updatedEmp.pension,
            notes: updatedEmp.notes,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save employee");
      }
      setEditingEmployee(null);
      showSuccess(`Saved employee "${updatedEmp.name || "Row " + updatedEmp.sheetRow}" successfully.`);
      await fetchSalaries(selectedClient, true);
    } catch (err) {
      console.error("Save employee error:", err);
      setError(err.message || "Error saving employee");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE DIVIDEND PERCENTAGE HANDLER ───────────────────────────────────────
  const handleSaveDividendPct = async () => {
    if (!selectedClient) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/salaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_dividends",
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: 118,
          deliveryPct: dividendPctInput,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save delivery %");
      }
      setEditingDividendPct(false);
      showSuccess("Updated Dividends Delivery % successfully.");
      await fetchSalaries(selectedClient, true);
    } catch (err) {
      console.error("Save dividend pct error:", err);
      setError(err.message || "Error saving delivery %");
    } finally {
      setSaving(false);
    }
  };

  // ── SAVE DIVIDEND MONTHLY AMOUNT HANDLER ───────────────────────────────────
  const handleSaveDividendAmount = async (colLetter, newVal) => {
    if (!selectedClient || !colLetter) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pma/salaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_dividends",
          clientName: selectedClient.clientName,
          masterSheetId: selectedClient.masterSheetId,
          clientSheetId: selectedClient.clientSheetId,
          sheetRow: editingDividendMonth?.sheetRow || 118,
          monthlyAmounts: {
            [colLetter]: newVal,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save dividend amount");
      }
      setEditingDividendMonth(null);
      showSuccess("Updated dividend amount successfully.");
      await fetchSalaries(selectedClient, true);
    } catch (err) {
      console.error("Save dividend amount error:", err);
      setError(err.message || "Error saving dividend amount");
    } finally {
      setSaving(false);
    }
  };

  // Quick Action: Add Employee to next available row
  const handleAddEmployee = () => {
    if (!salariesData?.employees) return;
    const firstEmpty = salariesData.employees.find((e) => !e.isPopulated) || salariesData.employees[0];
    setEditingEmployee({
      sheetRow: firstEmpty.sheetRow,
      name: "",
      role: "",
      fteSalary: "£0.00",
      fte: "1.00",
      startDate: "",
      endDate: "",
      deliveryPct: "100%",
      studentLoan: "No",
      pension: "Yes",
      isNew: true,
    });
  };

  // Filtered client list
  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return allOutgoingsClients;
    const q = clientSearch.toLowerCase().trim();
    return allOutgoingsClients.filter((c) => c.clientName?.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  // Derived current month and FY
  const currentMonth = salariesData?.months?.[selectedMonthIdx] || null;
  const currentFy = salariesData?.dividends?.fyConfigs?.[selectedFyIdx] || null;

  // Determine whether an employee is a former employee (end date before today)
  const isFormerEmployee = useCallback((emp) => {
    if (!emp.endDate || !emp.endDate.trim()) return false;
    const parsed = parseSheetDate(emp.endDate);
    if (!parsed) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return parsed < today;
  }, []);

  // Filtered employees for left table (only populated rows!)
  const { currentEmployees, formerEmployees, allPopulatedEmployees } = useMemo(() => {
    const list = (salariesData?.employees || []).filter(
      (e) => e.isPopulated && e.name && e.name.trim() !== ""
    );
    const current = [];
    const former = [];
    const q = employeeSearch.toLowerCase().trim();

    list.forEach((e) => {
      const matchesSearch =
        !q ||
        e.name.toLowerCase().includes(q) ||
        e.role.toLowerCase().includes(q) ||
        String(e.sheetRow).includes(q);

      if (matchesSearch) {
        if (isFormerEmployee(e)) {
          former.push(e);
        } else {
          current.push(e);
        }
      }
    });

    return {
      currentEmployees: current,
      formerEmployees: former,
      allPopulatedEmployees: [...current, ...former],
    };
  }, [salariesData?.employees, employeeSearch, isFormerEmployee]);

  // Filtered month amounts for right table (only populated rows WITH non-zero amounts!)
  const activeMonthAmounts = useMemo(() => {
    if (!currentMonth?.employeeAmounts) return [];
    const q = employeeSearch.toLowerCase().trim();
    return currentMonth.employeeAmounts.filter((ea) => {
      // 1. Only show rows that actually have data in them (populated employee)
      if (!ea.name || !ea.name.trim()) return false;
      // 2. Only show employees in the right-hand table that have actual amounts against them (either actual or forecast)
      if (!hasMonthAmounts(ea)) return false;
      // 3. Search filter
      if (q && !ea.name.toLowerCase().includes(q) && !String(ea.sheetRow).includes(q)) {
        return false;
      }
      return true;
    });
  }, [currentMonth?.employeeAmounts, employeeSearch]);

  // Helper to render an employee row
  const renderEmployeeRow = (emp, isFormer = false) => {
    const isHovered = hoveredRowIndex === emp.index;
    return (
      <tr
        key={emp.sheetRow}
        onMouseEnter={() => setHoveredRowIndex(emp.index)}
        onMouseLeave={() => setHoveredRowIndex(null)}
        style={{
          background: isHovered
            ? "#f0f7ff"
            : emp.index % 2 === 0
              ? "#ffffff"
              : "#fafafa",
          borderBottom: "1px solid #f1f5f9",
          transition: "background 0.1s",
        }}
      >
        <td style={{ padding: "6px 10px", color: "#94a3b8", fontWeight: 600 }}>{emp.sheetRow}</td>
        <td style={{ position: "relative", padding: "6px 10px", fontWeight: 600, color: isFormer ? "#475569" : "#1e293b", whiteSpace: "nowrap" }}>
          <CellNoteIndicator note={emp.notes?.name} />
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span>{emp.name}</span>
            {isFormer && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  background: "#f1f5f9",
                  color: "#64748b",
                  padding: "1px 5px",
                  borderRadius: "4px",
                  border: "1px solid #e2e8f0",
                }}
              >
                Former
              </span>
            )}
          </div>
        </td>
        <td style={{ position: "relative", padding: "6px 10px", color: "#475569", whiteSpace: "nowrap" }}>
          <CellNoteIndicator note={emp.notes?.role} />
          {emp.role || "-"}
        </td>
        <td style={{ position: "relative", padding: "6px 10px", textAlign: "right", color: "#0f172a", fontWeight: 600 }}>
          <CellNoteIndicator note={emp.notes?.fteSalary} />
          {emp.fteSalary ? formatCurrency(emp.fteSalary) : "-"}
        </td>
        <td style={{ position: "relative", padding: "6px 8px", textAlign: "center", color: "#475569" }}>
          <CellNoteIndicator note={emp.notes?.fte} />
          {emp.fte || "-"}
        </td>
        <td style={{ position: "relative", padding: "6px 8px", color: "#64748b", whiteSpace: "nowrap" }}>
          <CellNoteIndicator note={emp.notes?.startDate} />
          {emp.startDate || "-"}
        </td>
        <td style={{ position: "relative", padding: "6px 8px", color: isFormer ? "#b91c1c" : "#64748b", fontWeight: isFormer ? 600 : 400, whiteSpace: "nowrap" }}>
          <CellNoteIndicator note={emp.notes?.endDate} />
          {emp.endDate || "-"}
        </td>
        <td style={{ position: "relative", padding: "6px 8px", textAlign: "center" }}>
          <CellNoteIndicator note={emp.notes?.deliveryPct} />
          <span
            style={{
              display: "inline-block",
              padding: "1px 6px",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 600,
              background: emp.deliveryPct === "100%" ? "#dcfce7" : emp.deliveryPct === "0%" ? "#f1f5f9" : "#e0f2fe",
              color: emp.deliveryPct === "100%" ? "#166534" : emp.deliveryPct === "0%" ? "#475569" : "#0369a1",
            }}
          >
            {emp.deliveryPct || "0%"}
          </span>
        </td>
        <td style={{ position: "relative", padding: "6px 8px", textAlign: "center", color: "#64748b" }}>
          <CellNoteIndicator note={emp.notes?.studentLoan} />
          {emp.studentLoan === "Yes" ? <span style={{ color: "#d97706", fontWeight: 700 }}>Y</span> : "N"}
        </td>
        <td style={{ position: "relative", padding: "6px 8px", textAlign: "center", color: "#64748b" }}>
          <CellNoteIndicator note={emp.notes?.pension} />
          {emp.pension === "Yes" ? <span style={{ color: "#166534", fontWeight: 700 }}>Y</span> : "N"}
        </td>
        {isAdmin && (
          <td style={{ padding: "6px 8px", textAlign: "center" }}>
            <button
              type="button"
              onClick={() => setEditingEmployee({ ...emp })}
              style={{
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: "4px",
                padding: "2px 6px",
                fontSize: "11px",
                cursor: "pointer",
                color: "#0047AB",
                fontWeight: 600,
              }}
              title="Edit employee metadata"
            >
              ✎
            </button>
          </td>
        )}
      </tr>
    );
  };

  return (
    <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "16px 24px 60px" }}>
      {/* ── TOP HEADER / TOOLBAR ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
          marginBottom: "20px",
          background: "#ffffff",
          padding: "16px 20px",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {selectedClient && (
            <button
              type="button"
              onClick={handleBackToClients}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: "pointer",
                padding: "6px 12px",
                fontSize: "16px",
                color: "#475569",
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s ease",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#f1f5f9";
                e.currentTarget.style.borderColor = "#94a3b8";
                e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#cbd5e1";
                e.currentTarget.style.color = "#475569";
              }}
              title="Back to client list"
            >
              ←
            </button>
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "8px" }}>
              <span>Salaries</span>
              {selectedClient && salariesData && (
                <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>
                  {currentEmployees.length} Current · {formerEmployees.length} Former
                </span>
              )}
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to view and manage salaries
              </p>
            )}
          </div>
        </div>

        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => selectedClient && fetchSalaries(selectedClient, true)}
              disabled={loading || saving}
              style={{
                padding: "7px 14px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: loading ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {loading ? <Spinner size={14} color="#0066cc" /> : "↻"} Refresh
            </button>

            {isAdmin && (
              <button
                type="button"
                onClick={handleAddEmployee}
                disabled={loading || saving || !salariesData}
                style={{
                  padding: "7px 14px",
                  background: "#0047AB",
                  border: "1px solid #0047AB",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#ffffff",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                }}
              >
                <span>+ Add employee</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── CLIENT SELECTOR SCREEN (WHEN NO CLIENT SELECTED) ── */}
      {!selectedClient && !managedClient && !initialClient && (
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => setSelectedClient(c)}
          loading={loading}
          title="Select a client to view and manage salaries:"
        />
      )}

      {/* Notifications / Alerts */}
      {selectedClient && error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {selectedClient && saveSuccessMsg && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#15803d",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            marginBottom: "16px",
          }}
        >
          ✓ {saveSuccessMsg}
        </div>
      )}

      {selectedClient && loading && !salariesData && (
        <div style={{ textAlign: "center", padding: "80px 20px" }}>
          <Spinner size={32} color="#0047AB" />
          <div style={{ marginTop: "14px", color: "#64748b", fontSize: "14px" }}>
            Loading salaries and employee data from Master Sheet...
          </div>
        </div>
      )}

      {selectedClient && salariesData && (
        <>
          {/* =========================================================================
              MAIN SECTION: SIDE-BY-SIDE SPLIT LAYOUT (Max 50% screen width on left)
             ========================================================================= */}
          <div
            style={{
              display: "flex",
              gap: "20px",
              alignItems: "stretch",
              flexWrap: "wrap",
              marginBottom: "28px",
            }}
          >
            {/* ── LEFT PANEL: EMPLOYEE INFORMATION (MAX 50% WIDTH) ── */}
            <div
              style={{
                flex: "1 1 540px",
                maxWidth: "50%",
                minWidth: "320px",
                background: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Panel Header */}
              <div
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b" }}>
                    Employee information
                  </span>
                  {/* Category Filter Tabs */}
                  <div style={{ display: "inline-flex", background: "#e2e8f0", padding: "2px", borderRadius: "6px", gap: "2px" }}>
                    <button
                      type="button"
                      onClick={() => setEmployeeTab("all")}
                      style={{
                        padding: "3px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: employeeTab === "all" ? 700 : 500,
                        border: "none",
                        cursor: "pointer",
                        background: employeeTab === "all" ? "#ffffff" : "transparent",
                        color: employeeTab === "all" ? "#0047AB" : "#475569",
                        boxShadow: employeeTab === "all" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                      }}
                    >
                      All ({allPopulatedEmployees.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setEmployeeTab("current")}
                      style={{
                        padding: "3px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: employeeTab === "current" ? 700 : 500,
                        border: "none",
                        cursor: "pointer",
                        background: employeeTab === "current" ? "#ffffff" : "transparent",
                        color: employeeTab === "current" ? "#166534" : "#475569",
                        boxShadow: employeeTab === "current" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                      }}
                    >
                      Current ({currentEmployees.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setEmployeeTab("former")}
                      style={{
                        padding: "3px 8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontWeight: employeeTab === "former" ? 700 : 500,
                        border: "none",
                        cursor: "pointer",
                        background: employeeTab === "former" ? "#ffffff" : "transparent",
                        color: employeeTab === "former" ? "#b91c1c" : "#475569",
                        boxShadow: employeeTab === "former" ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                      }}
                    >
                      Former ({formerEmployees.length})
                    </button>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="text"
                    placeholder="Search employee..."
                    value={employeeSearch}
                    onChange={(e) => setEmployeeSearch(e.target.value)}
                    style={{
                      padding: "4px 8px",
                      fontSize: "12px",
                      borderRadius: "4px",
                      border: "1px solid #cbd5e1",
                      outline: "none",
                      width: "140px",
                    }}
                  />
                  {employeeSearch && (
                    <button
                      onClick={() => setEmployeeSearch("")}
                      style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "11px" }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Employees Table Container */}
              <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "680px", flex: 1 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", position: "sticky", top: 0, zIndex: 10, borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: "8px 10px", fontWeight: 700, color: "#475569", width: "35px" }}>#</th>
                      <th style={{ padding: "8px 10px", fontWeight: 700, color: "#475569" }}>Name</th>
                      <th style={{ padding: "8px 10px", fontWeight: 700, color: "#475569" }}>Role</th>
                      <th style={{ padding: "8px 10px", fontWeight: 700, color: "#475569", textAlign: "right" }}>FTE Salary</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569", textAlign: "center" }}>FTE</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Start</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>End</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569", textAlign: "center" }}>Del %</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569", textAlign: "center" }}>Loan</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569", textAlign: "center" }}>Pens</th>
                      {isAdmin && (
                        <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569", textAlign: "center", width: "45px" }}>
                          Edit
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Mode 1: Tab === 'all' -> Render Current, then Former */}
                    {employeeTab === "all" && (
                      <>
                        {/* Current Employees Header */}
                        <tr style={{ background: "#f0fdf4", borderBottom: "2px solid #bbf7d0" }}>
                          <td
                            colSpan={isAdmin ? 11 : 10}
                            style={{
                              padding: "8px 12px",
                              fontSize: "12px",
                              fontWeight: 700,
                              color: "#166534",
                              letterSpacing: "0.3px",
                              background: "#f0fdf4",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#16a34a" }} />
                              <span>Current Employees ({currentEmployees.length})</span>
                            </div>
                          </td>
                        </tr>
                        {currentEmployees.length === 0 ? (
                          <tr>
                            <td colSpan={isAdmin ? 11 : 10} style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                              No current employees found
                            </td>
                          </tr>
                        ) : (
                          currentEmployees.map((emp) => renderEmployeeRow(emp, false))
                        )}

                        {/* Spacer / divider between current and former employees */}
                        <tr style={{ height: "16px", background: "#ffffff" }}>
                          <td colSpan={isAdmin ? 11 : 10} style={{ height: "16px", border: "none", background: "#ffffff", padding: 0 }} />
                        </tr>

                        {/* Former Employees Header */}
                        <tr style={{ background: "#f1f5f9", borderTop: "1px solid #cbd5e1", borderBottom: "2px solid #cbd5e1" }}>
                          <td
                            colSpan={isAdmin ? 11 : 10}
                            style={{
                              padding: "8px 12px",
                              fontSize: "12px",
                              fontWeight: 700,
                              color: "#475569",
                              letterSpacing: "0.3px",
                              background: "#f1f5f9",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#94a3b8" }} />
                              <span>Former employees ({formerEmployees.length})</span>
                            </div>
                          </td>
                        </tr>
                        {formerEmployees.length === 0 ? (
                          <tr>
                            <td colSpan={isAdmin ? 11 : 10} style={{ padding: "16px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                              No former employees
                            </td>
                          </tr>
                        ) : (
                          formerEmployees.map((emp) => renderEmployeeRow(emp, true))
                        )}
                      </>
                    )}

                    {/* Mode 2: Tab === 'current' */}
                    {employeeTab === "current" && (
                      <>
                        {currentEmployees.length === 0 ? (
                          <tr>
                            <td colSpan={isAdmin ? 11 : 10} style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                              No current employees found
                            </td>
                          </tr>
                        ) : (
                          currentEmployees.map((emp) => renderEmployeeRow(emp, false))
                        )}
                      </>
                    )}

                    {/* Mode 3: Tab === 'former' */}
                    {employeeTab === "former" && (
                      <>
                        {formerEmployees.length === 0 ? (
                          <tr>
                            <td colSpan={isAdmin ? 11 : 10} style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontStyle: "italic" }}>
                              No former employees found
                            </td>
                          </tr>
                        ) : (
                          formerEmployees.map((emp) => renderEmployeeRow(emp, true))
                        )}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── RIGHT PANEL: MONTHLY AMOUNTS (7 COLUMNS) + TOTALS & SUMMARY ── */}
            <div
              style={{
                flex: "1 1 540px",
                minWidth: "320px",
                background: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Panel Header with Month Navigation */}
              <div
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b" }}>Monthly actuals</span>
                  {currentMonth && (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontSize: "11px",
                        fontWeight: 700,
                        background: currentMonth.isActualMonth ? "#dcfce7" : "#eff6ff",
                        color: currentMonth.isActualMonth ? "#166534" : "#1d4ed8",
                        border: currentMonth.isActualMonth ? "1px solid #bbf7d0" : "1px solid #bfdbfe",
                      }}
                    >
                      {currentMonth.isActualMonth ? "Actuals" : "Forecast"}
                    </span>
                  )}
                  <span style={{ fontSize: "12px", color: "#64748b" }}>
                    ({activeMonthAmounts.length} with amounts)
                  </span>
                </div>

                {/* Month Selector & Arrow Buttons */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={() => setSelectedMonthIdx((prev) => Math.max(0, prev - 1))}
                    disabled={selectedMonthIdx <= 0}
                    style={{
                      background: "#fff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "4px",
                      padding: "4px 8px",
                      cursor: selectedMonthIdx <= 0 ? "not-allowed" : "pointer",
                      fontSize: "12px",
                      color: selectedMonthIdx <= 0 ? "#cbd5e1" : "#1e293b",
                      fontWeight: 700,
                    }}
                    title="Previous Month"
                  >
                    ◀
                  </button>

                  <select
                    value={selectedMonthIdx}
                    onChange={(e) => setSelectedMonthIdx(parseInt(e.target.value, 10))}
                    style={{
                      padding: "5px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0047AB",
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    {salariesData.months.map((m, idx) => (
                      <option key={m.label + idx} value={idx}>
                        {m.label} ({m.isActualMonth ? "Actuals" : "Forecast"})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => setSelectedMonthIdx((prev) => Math.min(salariesData.months.length - 1, prev + 1))}
                    disabled={selectedMonthIdx >= salariesData.months.length - 1}
                    style={{
                      background: "#fff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "4px",
                      padding: "4px 8px",
                      cursor: selectedMonthIdx >= salariesData.months.length - 1 ? "not-allowed" : "pointer",
                      fontSize: "12px",
                      color: selectedMonthIdx >= salariesData.months.length - 1 ? "#cbd5e1" : "#1e293b",
                      fontWeight: 700,
                    }}
                    title="Next Month"
                  >
                    ▶
                  </button>
                </div>
              </div>

              {/* Amounts Table Container */}
              <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "420px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "right" }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", position: "sticky", top: 0, zIndex: 10, borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 700, color: "#475569" }}>Employee</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Salary</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Ee NICs</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Er NICs</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Stud. Loan</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Ee Pens.</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>Er Pens.</th>
                      <th style={{ padding: "8px 8px", fontWeight: 700, color: "#475569" }}>PAYE</th>
                      <th style={{ padding: "8px 8px", textAlign: "center", fontWeight: 700, color: "#475569" }}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMonthAmounts.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ textAlign: "center", padding: "28px", color: "#64748b", fontStyle: "italic" }}>
                          No employees with recorded amounts for {currentMonth?.label || "this month"}
                        </td>
                      </tr>
                    ) : (
                      activeMonthAmounts.map((ea) => {
                        const isHovered = hoveredRowIndex === ea.employeeIndex;
                        return (
                          <tr
                            key={ea.sheetRow}
                            onMouseEnter={() => setHoveredRowIndex(ea.employeeIndex)}
                            onMouseLeave={() => setHoveredRowIndex(null)}
                            style={{
                              background: isHovered
                                ? "#f0f7ff"
                                : ea.employeeIndex % 2 === 0
                                  ? "#ffffff"
                                  : "#fafafa",
                              borderBottom: "1px solid #f1f5f9",
                              transition: "background 0.1s",
                            }}
                          >
                            <td style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "#1e293b", whiteSpace: "nowrap" }}>
                              {ea.name}
                            </td>
                            <td style={{ padding: "6px 8px", color: "#0f172a", fontWeight: 600 }}>{ea.salary || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.eeNic || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.erNic || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.studentLoan || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.eePension || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.erPension || "-"}</td>
                            <td style={{ padding: "6px 8px", color: "#475569" }}>{ea.paye || "-"}</td>
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "1px 6px",
                                  borderRadius: "10px",
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  background: ea.isActual ? "#dcfce7" : "#eff6ff",
                                  color: ea.isActual ? "#166534" : "#2563eb",
                                }}
                              >
                                {ea.isActual ? "Actual" : "Forecast"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {/* Totals Rows (Row 55, Row 57, Row 58) */}
                  <tfoot style={{ background: "#f8fafc", borderTop: "2px solid #cbd5e1" }}>
                    {/* Row 55: Totals */}
                    <tr style={{ fontWeight: 700, color: "#0f172a" }}>
                      <td style={{ padding: "8px 10px", textAlign: "left" }}>Total (all)</td>
                      {currentMonth?.colTotals?.all.map((val, idx) => (
                        <td key={"tot_all_" + idx} style={{ padding: "8px 8px" }}>
                          {val}
                        </td>
                      ))}
                      <td></td>
                    </tr>
                    {/* Row 57: Totals (delivery) */}
                    <tr style={{ color: "#166534", fontWeight: 600 }}>
                      <td style={{ padding: "6px 10px", textAlign: "left" }}>Total (delivery)</td>
                      {currentMonth?.colTotals?.delivery.map((val, idx) => (
                        <td key={"tot_del_" + idx} style={{ padding: "6px 8px" }}>
                          {val}
                        </td>
                      ))}
                      <td></td>
                    </tr>
                    {/* Row 58: Totals (non-delivery) */}
                    <tr style={{ color: "#475569", fontWeight: 600 }}>
                      <td style={{ padding: "6px 10px", textAlign: "left" }}>Total (non-delivery)</td>
                      {currentMonth?.colTotals?.nonDelivery.map((val, idx) => (
                        <td key={"tot_nondel_" + idx} style={{ padding: "6px 8px" }}>
                          {val}
                        </td>
                      ))}
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* ── SUMMARY SECTION (ROWS 60 TO 77) ── */}
              {currentMonth?.summary && (
                <div style={{ padding: "14px 16px", borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>
                    Monthly Financial & Bank Outflow Summary ({currentMonth.label})
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: "10px",
                    }}
                  >
                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Total Cost (before Employment Allowance)</div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{currentMonth.summary.totalCostBeforeEA}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Employment Allowance b/f</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#334155" }}>{currentMonth.summary.employmentAllowanceBf}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Employment Allowance Usage</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#166534" }}>{currentMonth.summary.employmentAllowanceUsage}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Adjusted Er NICs for month</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#334155" }}>{currentMonth.summary.adjustedErNic}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Delivery staff cost (post-EA)</div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#166534" }}>{currentMonth.summary.totalDeliveryStaffCostPostEA}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Non-delivery staff cost (post-EA)</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#475569" }}>{currentMonth.summary.totalNonDeliveryStaffCostPostEA}</div>
                    </div>

                    <div style={{ background: "#eff6ff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #bfdbfe" }}>
                      <div style={{ fontSize: "11px", color: "#1e40af" }}>Total due to HMRC for month</div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#1d4ed8" }}>{currentMonth.summary.totalDueHmrc}</div>
                    </div>

                    <div style={{ background: "#fdf4ff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #f0abfc" }}>
                      <div style={{ fontSize: "11px", color: "#86198f" }}>Bank outflow: Payroll</div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#a21caf" }}>{currentMonth.summary.totalLeavingBankPayroll}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Bank outflow: HMRC (prev period)</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#334155" }}>{currentMonth.summary.totalLeavingBankHmrc}</div>
                    </div>

                    <div style={{ background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontSize: "11px", color: "#64748b" }}>Bank outflow: pension</div>
                      <div style={{ fontSize: "14px", fontWeight: 600, color: "#334155" }}>{currentMonth.summary.totalLeavingBankPension}</div>
                    </div>

                    <div style={{ background: "#f0fdf4", padding: "8px 12px", borderRadius: "6px", border: "1px solid #bbf7d0", gridColumn: "span 2" }}>
                      <div style={{ fontSize: "11px", color: "#166534", fontWeight: 600 }}>Total leaving bank account this month</div>
                      <div style={{ fontSize: "16px", fontWeight: 800, color: "#15803d" }}>{currentMonth.summary.totalLeavingBankMonth}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* =========================================================================
              BOTTOM SECTION: DIVIDENDS IN LIEU OF SALARY (CLIENT SHEET OUTGOINGS TAB)
             ========================================================================= */}
          {currentFy && (
            <div
              style={{
                background: "#ffffff",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                overflow: "hidden",
                marginTop: "16px",
              }}
            >
              {/* Header with FY Navigation and Delivery % Input */}
              <div
                style={{
                  padding: "12px 18px",
                  background: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "14px",
                }}
              >
                <div>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "#1e293b" }}>
                    Dividends in lieu of salary
                  </span>
                  <span style={{ fontSize: "12px", color: "#64748b", marginLeft: "8px" }}>
                    (Outgoings Tab · Client Sheet · Rows 118:121)
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
                  {/* Delivery % Box */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      background: "#eff6ff",
                      border: "1px solid #bfdbfe",
                      padding: "4px 10px",
                      borderRadius: "6px",
                    }}
                  >
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#1e40af" }}>Delivery %:</span>
                    {isAdmin ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <input
                          type="text"
                          value={dividendPctInput}
                          onChange={(e) => setDividendPctInput(e.target.value)}
                          onBlur={handleSaveDividendPct}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveDividendPct();
                          }}
                          style={{
                            width: "55px",
                            padding: "3px 6px",
                            fontSize: "13px",
                            fontWeight: 700,
                            borderRadius: "4px",
                            border: "1px solid #93c5fd",
                            textAlign: "center",
                            background: "#ffffff",
                            outline: "none",
                          }}
                        />
                        <button
                          type="button"
                          onClick={handleSaveDividendPct}
                          disabled={saving}
                          style={{
                            padding: "3px 8px",
                            fontSize: "11px",
                            fontWeight: 600,
                            background: "#0047AB",
                            color: "#fff",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <span style={{ fontWeight: 700, color: "#1d4ed8" }}>{currentFy.row118.deliveryPct}</span>
                    )}
                  </div>

                  {/* FY Selector Controls */}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <button
                      type="button"
                      onClick={() => setSelectedFyIdx((prev) => Math.max(0, prev - 1))}
                      disabled={selectedFyIdx <= 0}
                      style={{
                        background: "#fff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        padding: "4px 8px",
                        cursor: selectedFyIdx <= 0 ? "not-allowed" : "pointer",
                        fontSize: "12px",
                        color: selectedFyIdx <= 0 ? "#cbd5e1" : "#1e293b",
                        fontWeight: 700,
                      }}
                      title="Previous Financial Year"
                    >
                      ◀
                    </button>

                    <select
                      value={selectedFyIdx}
                      onChange={(e) => {
                        const idx = parseInt(e.target.value, 10);
                        setSelectedFyIdx(idx);
                        const nextFy = salariesData.dividends.fyConfigs[idx];
                        if (nextFy) setDividendPctInput(nextFy.row118.deliveryPct);
                      }}
                      style={{
                        padding: "5px 10px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: "#fff",
                        fontSize: "13px",
                        fontWeight: 700,
                        color: "#0047AB",
                        cursor: "pointer",
                        outline: "none",
                      }}
                    >
                      {salariesData.dividends.fyConfigs.map((fy, idx) => (
                        <option key={fy.label + idx} value={idx}>
                          {fy.label}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() =>
                        setSelectedFyIdx((prev) => Math.min(salariesData.dividends.fyConfigs.length - 1, prev + 1))
                      }
                      disabled={selectedFyIdx >= salariesData.dividends.fyConfigs.length - 1}
                      style={{
                        background: "#fff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "4px",
                        padding: "4px 8px",
                        cursor:
                          selectedFyIdx >= salariesData.dividends.fyConfigs.length - 1 ? "not-allowed" : "pointer",
                        fontSize: "12px",
                        color: selectedFyIdx >= salariesData.dividends.fyConfigs.length - 1 ? "#cbd5e1" : "#1e293b",
                        fontWeight: 700,
                      }}
                      title="Next Financial Year"
                    >
                      ▶
                    </button>
                  </div>
                </div>
              </div>

              {/* Full Financial Year Table */}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "right" }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                      <th style={{ padding: "9px 12px", textAlign: "left", fontWeight: 700, color: "#475569", minWidth: "220px" }}>
                        Description
                      </th>
                      {currentFy.monthCols.map((m) => (
                        <th key={m.colLetter} style={{ padding: "9px 10px", fontWeight: 700, color: "#475569", minWidth: "75px" }}>
                          {m.label}
                        </th>
                      ))}
                      <th style={{ padding: "9px 12px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff", minWidth: "90px" }}>
                        {currentFy.label} Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Row 118: Primary Dividends Row */}
                    <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", fontSize: "13px" }}>
                      <td style={{ padding: "9px 12px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                        {currentFy.row118.description}
                      </td>
                      {currentFy.row118.months.map((m) => (
                        <td
                          key={m.colLetter}
                          onClick={() => {
                            if (isAdmin) {
                              setEditingDividendMonth({
                                sheetRow: 118,
                                colLetter: m.colLetter,
                                label: m.label,
                                value: m.value,
                              });
                            }
                          }}
                          style={{
                            padding: "9px 10px",
                            color: "#0f172a",
                            fontWeight: 600,
                            cursor: isAdmin ? "pointer" : "default",
                            background: isAdmin ? "transparent" : undefined,
                            transition: "background 0.1s",
                          }}
                          title={isAdmin ? `Click to edit ${m.label} amount` : undefined}
                          onMouseEnter={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "#eff6ff";
                          }}
                          onMouseLeave={(e) => {
                            if (isAdmin) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {m.value}
                        </td>
                      ))}
                      <td style={{ padding: "9px 12px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff" }}>
                        {currentFy.row118.total}
                      </td>
                    </tr>

                    {/* Row 119: Second Dividends Row (if present) */}
                    {currentFy.row119.hasData && (
                      <tr style={{ background: "#ffffff", borderBottom: "1px solid #e2e8f0", fontSize: "13px" }}>
                        <td style={{ padding: "9px 12px", textAlign: "left", fontWeight: 600, color: "#1e293b" }}>
                          {currentFy.row119.description || "Dividends slot 2"}
                        </td>
                        {currentFy.row119.months.map((m) => (
                          <td
                            key={m.colLetter}
                            onClick={() => {
                              if (isAdmin) {
                                setEditingDividendMonth({
                                  sheetRow: 119,
                                  colLetter: m.colLetter,
                                  label: m.label,
                                  value: m.value,
                                });
                              }
                            }}
                            style={{
                              padding: "9px 10px",
                              color: "#0f172a",
                              fontWeight: 600,
                              cursor: isAdmin ? "pointer" : "default",
                            }}
                            title={isAdmin ? `Click to edit ${m.label} amount` : undefined}
                          >
                            {m.value}
                          </td>
                        ))}
                        <td style={{ padding: "9px 12px", fontWeight: 800, color: "#0047AB", background: "#f0f7ff" }}>
                          {currentFy.row119.total}
                        </td>
                      </tr>
                    )}

                    {/* Blank spacer row separating main dividend rows from totals */}
                    <tr style={{ height: "24px", background: "#ffffff" }}>
                      <td
                        colSpan={currentFy.monthCols.length + 2}
                        style={{ height: "24px", border: "none", background: "#ffffff", padding: 0 }}
                      />
                    </tr>

                    {/* Row 120: Total div in lieu of salary - delivery */}
                    <tr
                      style={{
                        background: "#f8fafc",
                        borderTop: "1px solid #e2e8f0",
                        borderBottom: "1px solid #e2e8f0",
                        color: "#475569",
                        fontSize: "11px",
                        fontWeight: 600,
                      }}
                    >
                      <td style={{ padding: "6px 12px", textAlign: "left", background: "#f8fafc" }}>
                        {currentFy.totalsDelivery.label}
                      </td>
                      {currentFy.totalsDelivery.months.map((m, idx) => (
                        <td key={"del_div_" + idx} style={{ padding: "6px 10px", background: "#f8fafc" }}>
                          {m.value}
                        </td>
                      ))}
                      <td style={{ padding: "6px 12px", fontWeight: 700, background: "#f8fafc", color: "#334155" }}>
                        {currentFy.totalsDelivery.total}
                      </td>
                    </tr>

                    {/* Row 121: Total div in lieu of salary - non-delivery */}
                    <tr
                      style={{
                        background: "#f8fafc",
                        borderBottom: "1px solid #e2e8f0",
                        color: "#475569",
                        fontSize: "11px",
                        fontWeight: 600,
                      }}
                    >
                      <td style={{ padding: "6px 12px", textAlign: "left", background: "#f8fafc" }}>
                        {currentFy.totalsNonDelivery.label}
                      </td>
                      {currentFy.totalsNonDelivery.months.map((m, idx) => (
                        <td key={"nondel_div_" + idx} style={{ padding: "6px 10px", background: "#f8fafc" }}>
                          {m.value}
                        </td>
                      ))}
                      <td style={{ padding: "6px 12px", fontWeight: 700, background: "#f8fafc", color: "#334155" }}>
                        {currentFy.totalsNonDelivery.total}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── MODAL: EDIT EMPLOYEE INFORMATION ── */}
      {editingEmployee && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "20px",
          }}
          onClick={() => !saving && setEditingEmployee(null)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "10px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              width: "100%",
              maxWidth: "540px",
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "24px",
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#1e293b" }}>
                {editingEmployee.isNew ? "Add Employee" : `Edit Employee (Row ${editingEmployee.sheetRow})`}
              </h3>
              <button
                type="button"
                onClick={() => setEditingEmployee(null)}
                style={{ background: "none", border: "none", fontSize: "18px", color: "#64748b", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveEmployee(editingEmployee);
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={editingEmployee.name || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, name: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="e.g. John Doe"
                  />
                </div>

                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Role / Title
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.role || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, role: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="e.g. Senior Designer"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    FTE Salary
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.fteSalary || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, fteSalary: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="e.g. £50,000"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    FTE
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.fte || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, fte: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="e.g. 1.00"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Start Date
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.startDate || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, startDate: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="DD-Mon-YYYY"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    End Date
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.endDate || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, endDate: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="DD-Mon-YYYY (optional)"
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px" }}>
                    Delivery %
                  </label>
                  <input
                    type="text"
                    value={editingEmployee.deliveryPct || ""}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, deliveryPct: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                    placeholder="e.g. 100% or 0%"
                  />
                </div>

                <div style={{ display: "flex", gap: "14px", alignItems: "center", paddingTop: "14px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={editingEmployee.studentLoan === "Yes"}
                      onChange={(e) => setEditingEmployee({ ...editingEmployee, studentLoan: e.target.checked ? "Yes" : "No" })}
                    />
                    Student Loan?
                  </label>

                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={editingEmployee.pension === "Yes"}
                      onChange={(e) => setEditingEmployee({ ...editingEmployee, pension: e.target.checked ? "Yes" : "No" })}
                    />
                    Pension?
                  </label>
                </div>
              </div>

              {/* ── Expandable Cell Notes Section ── */}
              <div style={{ marginTop: "14px", borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155" }}>
                    Cell notes (Google Sheet notes)
                  </span>
                  <span style={{ fontSize: "11px", color: "#64748b" }}>
                    Optional note per field
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      Name note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for name..."
                      value={editingEmployee.notes?.name || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), name: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      Role note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for role..."
                      value={editingEmployee.notes?.role || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), role: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      FTE salary note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for salary..."
                      value={editingEmployee.notes?.fteSalary || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), fteSalary: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      FTE note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for FTE..."
                      value={editingEmployee.notes?.fte || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), fte: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      Start date note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for start date..."
                      value={editingEmployee.notes?.startDate || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), startDate: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      End date note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for end date..."
                      value={editingEmployee.notes?.endDate || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), endDate: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      Delivery % note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for delivery %..."
                      value={editingEmployee.notes?.deliveryPct || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), deliveryPct: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "#64748b", marginBottom: "3px" }}>
                      Student loan note
                    </label>
                    <input
                      type="text"
                      placeholder="Add note for student loan..."
                      value={editingEmployee.notes?.studentLoan || ""}
                      onChange={(e) =>
                        setEditingEmployee({
                          ...editingEmployee,
                          notes: { ...(editingEmployee.notes || {}), studentLoan: e.target.value },
                        })
                      }
                      style={{
                        width: "100%",
                        padding: "5px 8px",
                        borderRadius: "4px",
                        border: "1px solid #cbd5e1",
                        fontSize: "12px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "18px" }}>
                <button
                  type="button"
                  onClick={() => setEditingEmployee(null)}
                  disabled={saving}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    color: "#475569",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    padding: "8px 18px",
                    borderRadius: "6px",
                    border: "1px solid #0047AB",
                    background: "#0047AB",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {saving && <Spinner size={14} color="#ffffff" />}
                  Save Employee
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: EDIT DIVIDEND MONTHLY AMOUNT ── */}
      {editingDividendMonth && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => !saving && setEditingDividendMonth(null)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              padding: "20px",
              width: "320px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 style={{ margin: "0 0 12px", fontSize: "15px", color: "#1e293b" }}>
              Edit Dividend ({editingDividendMonth.label})
            </h4>
            <div style={{ marginBottom: "14px" }}>
              <label style={{ display: "block", fontSize: "12px", color: "#64748b", marginBottom: "4px" }}>
                Amount
              </label>
              <input
                type="text"
                autoFocus
                defaultValue={editingDividendMonth.value}
                id="editDividendInput"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSaveDividendAmount(editingDividendMonth.colLetter, e.target.value);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "7px 10px",
                  fontSize: "14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => setEditingDividendMonth(null)}
                style={{
                  padding: "6px 12px",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  const val = document.getElementById("editDividendInput")?.value;
                  handleSaveDividendAmount(editingDividendMonth.colLetter, val);
                }}
                style={{
                  padding: "6px 14px",
                  borderRadius: "4px",
                  border: "none",
                  background: "#0047AB",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
