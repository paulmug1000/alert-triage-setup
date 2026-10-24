import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import { BudgetSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { formatMoney as universalFormatMoney, parseMoney } from "../services/deepDiveHelper";
import { downloadCsv } from "../utils/helpers";
import CellNoteIndicator from "./CellNoteIndicator";
import CellNoteModal from "./CellNoteModal";
import EditClientSelector from "./EditClientSelector";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function colIndexToLetter(colNum) {
  let letter = "";
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

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
      if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
      return new Date(yr, mIdx, parseInt(m[1], 10));
    }
  }

  // 3. Mon-YY or Mon YYYY
  const myMatch = s.match(/^([A-Za-z]+)[-/\s](\d{2,4})$/);
  if (myMatch) {
    const mIdx = months[myMatch[1].toLowerCase().slice(0, 3)];
    if (mIdx !== undefined) {
      let yr = parseInt(myMatch[2], 10);
      if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
      return new Date(yr, mIdx, 1);
    }
  }

  // 4. DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    let yr = parseInt(slashMatch[3], 10);
    if (yr < 100) yr += yr <= 69 ? 2000 : 1900;
    return new Date(yr, parseInt(slashMatch[2], 10) - 1, parseInt(slashMatch[1], 10));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

function parseNum(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const s = String(val).trim();
  if (!s || s === "-" || s === "£-" || s === "$-" || s === "€-") return 0;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const cleaned = s.replace(/[£$€,\s()]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return isNeg ? -Math.abs(num) : num;
}

function parsePct(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return val > 1 ? val / 100 : val;
  const clean = String(val).replace(/%/g, "").trim();
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  return num > 1 ? num / 100 : num;
}

export function isBudgetCellEditable(sheetRow, colIdx) {
  const isMonthCol =
    (colIdx >= 6 && colIdx <= 17) ||
    (colIdx >= 21 && colIdx <= 32) ||
    (colIdx >= 36 && colIdx <= 47);

  // Rows 5-7: months
  if (sheetRow >= 5 && sheetRow <= 7) return isMonthCol;
  // Rows 13-15: months
  if (sheetRow >= 13 && sheetRow <= 15) return isMonthCol;
  // Employees: Rows 58-112, Cols A-E (0-4)
  if (sheetRow >= 58 && sheetRow <= 112) return colIdx >= 0 && colIdx <= 4;
  // Dividends: Row 119, Col E (4) + months
  if (sheetRow === 119) return colIdx === 4 || isMonthCol;
  // Contractors: Rows 126-140, Cols A (0) & E (4) + months
  if (sheetRow >= 126 && sheetRow <= 140) return colIdx === 0 || colIdx === 4 || isMonthCol;
  // Making up CoS: B142 (Col B = 1)
  if (sheetRow === 142) return colIdx === 1;
  // Other expenses: Rows 149-251, Cols A (0) & E (4) + months
  if (sheetRow >= 149 && sheetRow <= 251) return colIdx === 0 || colIdx === 4 || isMonthCol;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BUDGET VIEW COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function BudgetView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
}) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager");
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  // Client State (synchronous initial selection from managedClient or initialClient to eliminate flash)
  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase();
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      ) || (typeof initialClient === "object" ? initialClient : null);
    }
    return null;
  });
  const [clientSearch, setClientSearch] = useState("");

  // Data State (instant initialization from memory cache if preloaded)
  const [budgetData, setBudgetData] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    if (target?.clientSheetId) {
      const cached = getCachedClientData(target.clientSheetId, "budget");
      if (cached?.data) return cached.data;
    }
    return null;
  });
  const [keyData, setKeyData] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    if (target?.clientSheetId) {
      const cached = getCachedClientData(target.clientSheetId, "portal_key_data");
      if (cached?.data) return cached.data;
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState("");

  // Cell Note Modal State
  const [noteModalData, setNoteModalData] = useState(null); // { sheetRow, colIdx, title, subtitle, initialNote }

  // FY Navigation
  const [selectedFyIdx, setSelectedFyIdx] = useState(() => budgetData?.defaultFyIndex ?? 0);

  // Section Collapsible Toggles
  const [salariesOpen, setSalariesOpen] = useState(true);
  const [contractorsOpen, setContractorsOpen] = useState(true);
  const [expensesOpen, setExpensesOpen] = useState(true);

  // Sub-Section Searches & Show Empty Filters
  const [salariesSearch, setSalariesSearch] = useState("");
  const [showEmptySalaries, setShowEmptySalaries] = useState(false);

  const [contractorsSearch, setContractorsSearch] = useState("");
  const [showEmptyContractors, setShowEmptyContractors] = useState(false);

  const [expensesSearch, setExpensesSearch] = useState("");
  const [showEmptyExpenses, setShowEmptyExpenses] = useState(false);

  // Cell In-Place Editing
  const [editingCell, setEditingCell] = useState(null); // { sheetRow, colIdx, editValue }
  const [savingKey, setSavingKey] = useState(null); // `${sheetRow}_${colIdx}`
  const committingRef = useRef(false);

  // Making up CoS Setting Popover/Inline State
  const [isEditingCosTarget, setIsEditingCosTarget] = useState(false);
  const [cosTargetInput, setCosTargetInput] = useState("");

  // Spread Modal State: { isOpen: boolean, sheetRow: 5 | 13, label: string, annualTotal: string }
  const [spreadModal, setSpreadModal] = useState({
    isOpen: false,
    sheetRow: null,
    label: "",
    annualTotal: "",
  });
  const [savingSpread, setSavingSpread] = useState(false);

  // Currency & formatting
  const currencySymbol = keyData?.currencySymbol || "£";
  const thousandsSeparator = keyData?.thousandsSeparator || ",";

  const formatMoney = (val) => {
    return universalFormatMoney(val, 0, currencySymbol, thousandsSeparator);
  };
  const formatPctDisplay = (val) => `${Math.round((val || 0) * 100)}%`;

  // Traffic Light Conditional Thresholds matching Pulse Budget overview
  const getMarginColor = (label, numVal) => {
    const t = keyData?.thresholds || [];
    const parseT = (idx, def) => {
      const v = t[idx];
      if (v === undefined || v === null || v === "") return def;
      if (typeof v === "number") return v > 1 ? v / 100 : v;
      const n = parseFloat(String(v).replace(/%/g, "").trim());
      return isNaN(n) ? def : String(v).includes("%") || n > 1 ? n / 100 : n;
    };

    if (label.includes("Gross profit margin") || label.includes("Gross profit %")) {
      const z42 = parseT(0, 0.495);
      const z43 = parseT(1, 0.445);
      if (numVal < z43) return "#f4cccc";
      if (numVal <= z42) return "#fce5cd";
      return "#d9ead3";
    }
    if (label.includes("Overheads as %")) {
      const z47 = parseT(5, 0.309);
      const z48 = parseT(6, 0.2);
      if (numVal > z47) return "#f4cccc";
      if (numVal >= z48) return "#d9ead3";
      return "#fce5cd";
    }
    if (label.includes("Operating profit %")) {
      const z52 = parseT(10, 0.145);
      const z53 = parseT(11, 0.05);
      if (numVal < z53) return "#f4cccc";
      if (numVal <= z52) return "#fce5cd";
      return "#d9ead3";
    }
    if (label.includes("Staff costs to")) {
      const z57 = parseT(15, 0.705);
      const z58 = parseT(16, 0.66);
      const z59 = parseT(17, 0.54);
      if (numVal < z59) return "#fce5cd";
      if (numVal <= z58) return "#d9ead3";
      if (numVal <= z57) return "#fce5cd";
      return "#f4cccc";
    }
    return null;
  };

  // Synchronize client selection
  useEffect(() => {
    if (managedClient) {
      const match =
        (allOutgoingsClients || []).find(
          (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
        ) || managedClient;
      setSelectedClient(match);
      return;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string" ? initialClient.toLowerCase() : initialClient?.clientName?.toLowerCase();
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
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
      setBudgetData(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_budget_client");
      }
    }
  };

  // Fetch Budget Data & Key Data with caching
  const fetchBudgetData = useCallback(async (client, bypassCache = false) => {
    if (!client || (!client.clientSheetId && !client.masterSheetId)) return;
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : client.clientSheetId;

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, "budget") : null;
    if (cached?.data) {
      setBudgetData(cached.data);
      if (cached.data.defaultFyIndex !== undefined) {
        setSelectedFyIdx(cached.data.defaultFyIndex);
      }
      setLoading(false);
      if (!cached.isStale) return;
    } else {
      setLoading(true);
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`budget_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, "budget");
          if (fresh?.data) {
            setBudgetData(fresh.data);
            if (fresh.data.defaultFyIndex !== undefined) {
              setSelectedFyIdx(fresh.data.defaultFyIndex);
            }
            setLoading(false);
            return;
          }
        } catch {}
      }
    }
    setError(null);
    try {
      const [res, keyRes] = await Promise.all([
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_client_view_data",
            clientSheetId: client.clientSheetId,
            masterSheetId: client.masterSheetId,
            clientName: client.clientName,
            tab: "budget",
            bypassCache,
          }),
        }),
        fetch(
          `/api/portal/key-data?clientSheetId=${encodeURIComponent(client.clientSheetId || "")}&clientName=${encodeURIComponent(
            client.clientName || ""
          )}${bypassCache ? "&bypassCache=true" : ""}`
        ).catch(() => null),
      ]);

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load budget data from Master Sheet");
      }
      setBudgetData(data);
      if (data.defaultFyIndex !== undefined) {
        setSelectedFyIdx(data.defaultFyIndex);
      }
      setCachedClientData(client.clientSheetId, "budget", data);

      if (keyRes && keyRes.ok) {
        const kData = await keyRes.json();
        if (kData.success && kData.data) {
          setKeyData(kData.data);
          setCachedClientData(client.clientSheetId, "portal_key_data", kData.data);
        }
      }
    } catch (err) {
      console.error("fetchBudgetData error:", err);
      setError(err.message || "Failed to load budget data");
    } finally {
      setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_budget_client", selectedClient.clientName);
      }
      fetchBudgetData(selectedClient);
    }
  }, [selectedClient, fetchBudgetData]);

  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return allOutgoingsClients;
    const q = clientSearch.toLowerCase().trim();
    return allOutgoingsClients.filter((c) => c.clientName?.toLowerCase().includes(q));
  }, [allOutgoingsClients, clientSearch]);

  const matrix = useMemo(() => budgetData?.matrix || [], [budgetData?.matrix]);
  const fyConfigs = budgetData?.fyConfigs || [];
  const currentFy = fyConfigs[selectedFyIdx] || fyConfigs[0] || null;
  const maxFyIdx = fyConfigs.length > 0 ? fyConfigs.length - 1 : 0;
  const isIncomeMode = budgetData?.isIncomeMode || false;
  const isRevMode = !isIncomeMode;

  const fyCols = useMemo(() => {
    return currentFy?.monthCols || [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  }, [currentFy?.monthCols]);
  const totalCol = currentFy?.totalCol || 19;
  const activeFyLabel = currentFy?.label || `FY${selectedFyIdx + 1}`;

  const row0 = useMemo(() => matrix[0] || [], [matrix]);
  const monthHeaders = useMemo(() => {
    return fyCols.map((cIdx, i) => row0[cIdx]?.v || `M${i + 1}`);
  }, [fyCols, row0]);

  // Desired Making up CoS % from Cell B142 (sheetRow 142, colIdx 1 -> matrix[141][1])
  const desCosPct = useMemo(() => {
    const rawVal = matrix[141]?.[1]?.v;
    return parsePct(rawVal);
  }, [matrix]);

  // ───────────────────────────────────────────────────────────────────────────
  // INSTANT MATHEMATICAL MODEL RECALCULATION ENGINE
  // Mirrors Master Sheet formulas to ensure instant top table reflection
  // ───────────────────────────────────────────────────────────────────────────
  const computedModel = useMemo(() => {
    if (!matrix || matrix.length === 0) return null;

    // Helper to get array of 12 numeric values for a matrix row
    const getMonthVals = (rowIdx) => {
      const r = matrix[rowIdx] || [];
      return fyCols.map((cIdx) => parseNum(r[cIdx]?.v));
    };

    // 1. Revenue
    const conf = isRevMode ? getMonthVals(4) : getMonthVals(20); // Row 5 or Row 21
    const pipe = isRevMode ? getMonthVals(5) : getMonthVals(21); // Row 6 or Row 22
    const nb = isRevMode ? getMonthVals(6) : getMonthVals(22);   // Row 7 or Row 23
    const totalRev = conf.map((v, i) => v + pipe[i] + nb[i]);

    // 2. Direct Costs
    // Row 13 in Master Sheet is direct costs input
    const dirCosts = isRevMode ? getMonthVals(12) : new Array(12).fill(0);

    // 3. Salaries (Rows 58 to 112 -> matrix[57] to matrix[111])
    const salaryDel = new Array(12).fill(0);
    const salaryNonDel = new Array(12).fill(0);

    for (let rIdx = 57; rIdx <= 111; rIdx++) {
      const row = matrix[rIdx];
      if (!row) continue;
      const name = String(row[0]?.v || "").trim();
      const equivSalary = parseNum(row[1]?.v);
      const startStr = row[2]?.v;
      const endStr = row[3]?.v;
      const delPct = parsePct(row[4]?.v);
      const costPmInSheet = parseNum(row[5]?.v);

      if (!name && equivSalary === 0 && !costPmInSheet) continue;

      const startDate = parseSheetDate(startStr);
      const endDate = parseSheetDate(endStr);
      // Col F cost pm: if sheet has value, use it; otherwise estimate equivSalary / 12 * 1.15
      const costPm = costPmInSheet || (equivSalary ? Math.round((equivSalary / 12) * 1.15) : 0);

      fyCols.forEach((cIdx, mIdx) => {
        // If sheet cell has calculated value, prefer it
        const cellVal = parseNum(row[cIdx]?.v);
        let activeVal = cellVal;
        if (cellVal === 0 && costPm > 0) {
          const mDate = parseSheetDate(row0[cIdx]?.v);
          let isActive = true;
          if (startDate && mDate && mDate < startDate) isActive = false;
          if (endDate && mDate && mDate > endDate) isActive = false;
          if (isActive) activeVal = costPm;
        }

        salaryDel[mIdx] += activeVal * delPct;
        salaryNonDel[mIdx] += activeVal * (1 - delPct);
      });
    }

    // Dividends (Row 119 -> matrix[118])
    const divRow = matrix[118] || [];
    const divDelPct = parsePct(divRow[4]?.v);
    const divVals = getMonthVals(118);
    const divDel = divVals.map((v) => v * divDelPct);
    const divNonDel = divVals.map((v) => v * (1 - divDelPct));

    // 4. Contractors (Rows 126 to 140 -> matrix[125] to matrix[139])
    const contractorDel = new Array(12).fill(0);
    for (let rIdx = 125; rIdx <= 139; rIdx++) {
      const row = matrix[rIdx];
      if (!row) continue;
      const delPct = parsePct(row[4]?.v);
      const vals = getMonthVals(rIdx);
      vals.forEach((v, mIdx) => {
        contractorDel[mIdx] += v * delPct;
      });
    }

    // 5. Other Expenses (Rows 149 to 251 -> matrix[148] to matrix[250])
    const expDel = new Array(12).fill(0);
    const expNonDel = new Array(12).fill(0);
    for (let rIdx = 148; rIdx <= 250; rIdx++) {
      const row = matrix[rIdx];
      if (!row) continue;
      const delPct = parsePct(row[4]?.v);
      const vals = getMonthVals(rIdx);
      vals.forEach((v, mIdx) => {
        expDel[mIdx] += v * delPct;
        expNonDel[mIdx] += v * (1 - delPct);
      });
    }

    // 6. Making up CoS (Row 142 -> matrix[141])
    // Formula: if (TotalRev * DesCoS) - otherCoS > 0 -> difference, else 0
    const makingUpCosVals = new Array(12).fill(0);
    if (desCosPct > 0) {
      for (let m = 0; m < 12; m++) {
        const targetCos = totalRev[m] * desCosPct;
        const otherCos =
          dirCosts[m] +
          salaryDel[m] +
          divDel[m] +
          contractorDel[m] +
          expDel[m];
        makingUpCosVals[m] = Math.max(0, Math.round(targetCos - otherCos));
      }
    }

    // 7. Summary Line Rollups
    // Staff costs - delivery = salaries del + divs del + contractors del + making up CoS
    const staffDel = salaryDel.map(
      (v, i) => v + divDel[i] + contractorDel[i] + makingUpCosVals[i]
    );

    // Staff costs - non-delivery = salaries non-del + divs non-del
    const staffNonDel = salaryNonDel.map((v, i) => v + divNonDel[i]);

    // Total Costs of Sale
    const totalCoS = isRevMode
      ? staffDel.map((v, i) => v + dirCosts[i] + expDel[i])
      : staffDel.map((v, i) => v + expDel[i]);

    // Gross Profit & Margin
    const gp = totalRev.map((v, i) => v - totalCoS[i]);
    const gpMargin = gp.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));

    // Total Overheads & Ratio
    const totalOverheads = staffNonDel.map((v, i) => v + expNonDel[i]);
    const overheadsPct = totalOverheads.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));

    // Operating Profit & Margin
    const opProfit = gp.map((v, i) => v - totalOverheads[i]);
    const opProfitPct = opProfit.map((v, i) => (totalRev[i] ? v / totalRev[i] : 0));

    const staffToIncPct = totalRev.map((v, i) =>
      totalRev[i] ? (staffDel[i] + staffNonDel[i]) / totalRev[i] : 0
    );

    // Helpers to append 13th item (FY Total)
    const sumArr = (arr) => arr.reduce((acc, n) => acc + (n || 0), 0);
    const withTotal = (arr) => [...arr, sumArr(arr)];

    const confWithTot = withTotal(conf);
    const pipeWithTot = withTotal(pipe);
    const nbWithTot = withTotal(nb);
    const totalRevWithTot = withTotal(totalRev);

    const staffDelWithTot = withTotal(staffDel);
    const dirCostsWithTot = withTotal(dirCosts);
    const expDelWithTot = withTotal(expDel);
    const totalCoSWithTot = withTotal(totalCoS);

    const totRevVal = totalRevWithTot[12];
    const gpTot = totalRevWithTot[12] - totalCoSWithTot[12];
    const gpWithTot = [...gp, gpTot];
    const gpMarginWithTot = [...gpMargin, totRevVal ? gpTot / totRevVal : 0];

    const staffNonDelWithTot = withTotal(staffNonDel);
    const expNonDelWithTot = withTotal(expNonDel);
    const totalOverheadsWithTot = withTotal(totalOverheads);
    const totOverheadsVal = totalOverheadsWithTot[12];
    const overheadsPctWithTot = [...overheadsPct, totRevVal ? totOverheadsVal / totRevVal : 0];

    const opProfitTot = gpTot - totOverheadsVal;
    const opProfitWithTot = [...opProfit, opProfitTot];
    const opProfitPctWithTot = [...opProfitPct, totRevVal ? opProfitTot / totRevVal : 0];
    const staffToIncWithTot = [
      ...staffToIncPct,
      totRevVal ? (staffDelWithTot[12] + staffNonDelWithTot[12]) / totRevVal : 0,
    ];

    return {
      conf: confWithTot,
      pipe: pipeWithTot,
      nb: nbWithTot,
      totalRev: totalRevWithTot,
      staffDel: staffDelWithTot,
      dirCosts: dirCostsWithTot,
      expDel: expDelWithTot,
      totalCoS: totalCoSWithTot,
      gp: gpWithTot,
      gpMargin: gpMarginWithTot,
      staffNonDel: staffNonDelWithTot,
      expNonDel: expNonDelWithTot,
      totalOverheads: totalOverheadsWithTot,
      overheadsPct: overheadsPctWithTot,
      opProfit: opProfitWithTot,
      opProfitPct: opProfitPctWithTot,
      staffToIncPct: staffToIncWithTot,
      makingUpCosVals: withTotal(makingUpCosVals),
      salaryDelTotal: sumArr(salaryDel),
      salaryNonDelTotal: sumArr(salaryNonDel),
      expDelTotal: sumArr(expDel),
      expNonDelTotal: sumArr(expNonDel),
    };
  }, [matrix, fyCols, isRevMode, desCosPct, row0]);

  // Construct Top Table Rows
  const tableRows = useMemo(() => {
    if (!computedModel) return [];

    const rows = [];
    const addSpacer = (height = 6) => rows.push({ type: "spacer", height });
    const addSectionHeader = (label) => rows.push({ type: "section", label });

    const addDataRow = (
      label,
      dataArr,
      isCurrency,
      isBigTotal,
      isMargin,
      bg,
      color,
      isBold = false,
      isEditable = false,
      sheetRow = null
    ) => {
      let accentBar = null;
      const l = String(label || "").toLowerCase();
      if (l.includes("gross profit margin") || l.includes("gross profit %")) accentBar = "#e69138";
      else if (l.includes("overheads as %") || l.includes("overheads %")) accentBar = "#45818e";
      else if (l.includes("operating profit %")) accentBar = "#1155cc";
      else if (l.includes("staff costs to")) accentBar = "#64748b";

      rows.push({
        type: "data",
        label,
        data: dataArr,
        isCurrency,
        isBigTotal,
        isMargin,
        accentBar,
        bg: bg || "#ffffff",
        color: color || "#0047AB",
        isBold: isBigTotal || isBold,
        isEditable,
        sheetRow,
      });
    };

    addSpacer(10);
    addSectionHeader(isRevMode ? "Revenue" : "Income");
    // Confirmed Revenue (Sheet Row 5) - EDITABLE!
    addDataRow(
      isRevMode ? "Confirmed revenue" : "Confirmed income",
      computedModel.conf,
      true,
      false,
      false,
      "#ffffff",
      "#0047AB",
      false,
      true,
      5
    );
    addDataRow(
      isRevMode ? "Pipeline revenue" : "Pipeline income",
      computedModel.pipe,
      true,
      false,
      false,
      "#ffffff",
      "#0047AB"
    );
    addDataRow(
      isRevMode ? "New business to find revenue" : "New business to find income",
      computedModel.nb,
      true,
      false,
      false,
      "#ffffff",
      "#0047AB"
    );
    addSpacer(6);
    addDataRow(
      isRevMode ? "Total revenue" : "Total income",
      computedModel.totalRev,
      true,
      true,
      false,
      "#9900ff",
      "#ffffff"
    );
    addSpacer(18);

    addSectionHeader("Costs of sale");
    addDataRow("Staff costs - delivery", computedModel.staffDel, true, false, false, "#ffffff", "#0047AB");
    if (isRevMode) {
      // Direct Costs (Sheet Row 13) - EDITABLE!
      addDataRow("Direct costs", computedModel.dirCosts, true, false, false, "#ffffff", "#0047AB", false, true, 13);
    }
    addDataRow("Other expenses - delivery", computedModel.expDel, true, false, false, "#ffffff", "#0047AB");
    addSpacer(4);
    addDataRow("Total costs of sale", computedModel.totalCoS, true, false, false, "#ffffff", "#0047AB", true);
    addSpacer(10);
    addDataRow("Gross profit", computedModel.gp, true, true, false, "#e69138", "#ffffff");
    addSpacer(8);
    addDataRow("Gross profit margin %", computedModel.gpMargin, false, false, true, "#ffffff", "#0047AB");
    addSpacer(16);

    addSectionHeader("Overheads");
    addDataRow("Staff costs - non-delivery", computedModel.staffNonDel, true, false, false, "#ffffff", "#0047AB");
    addDataRow("Other expenses - non-delivery", computedModel.expNonDel, true, false, false, "#ffffff", "#0047AB");
    addSpacer(16);
    addDataRow("Total overheads", computedModel.totalOverheads, true, true, false, "#45818e", "#ffffff");
    addSpacer(10);
    addDataRow(
      isRevMode ? "Overheads as % of revenue" : "Overheads as % of income",
      computedModel.overheadsPct,
      false,
      false,
      true,
      "#ffffff",
      "#0047AB"
    );
    addSpacer(16);

    addDataRow("Operating profit", computedModel.opProfit, true, true, false, "#1155cc", "#ffffff");
    addSpacer(10);
    addDataRow("Operating profit %", computedModel.opProfitPct, false, false, true, "#ffffff", "#0047AB");

    return rows;
  }, [computedModel, isRevMode]);

  // ───────────────────────────────────────────────────────────────────────────
  // CELL UPDATE HANDLER (OPTIMISTIC + PERSIST TO GOOGLE SHEETS)
  // ───────────────────────────────────────────────────────────────────────────
  const handleUpdateCell = async (sheetRow, colIdx, newValue) => {
    if (!selectedClient) return;
    const clientKey = selectedClient.clientSheetId;
    const masterKey = selectedClient.masterSheetId;
    const colLetter = colIndexToLetter(colIdx + 1);

    let displayVal = newValue;
    if (colIdx >= 6 && newValue !== "") {
      displayVal = formatMoney(parseNum(newValue));
    } else if (sheetRow >= 58 && sheetRow <= 112 && colIdx === 1 && newValue !== "") {
      displayVal = formatMoney(parseNum(newValue));
    } else if (
      (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) &&
      newValue !== ""
    ) {
      const clean = String(newValue).replace(/%/g, "").trim();
      const num = parseFloat(clean);
      if (!isNaN(num)) {
        displayVal = `${num}%`;
      }
    }

    // Optimistically update local matrix
    setBudgetData((prev) => {
      if (!prev || !prev.matrix) return prev;
      const newMatrix = [...prev.matrix];
      const rIdx = sheetRow - 1;
      if (newMatrix[rIdx]) {
        const newRow = [...newMatrix[rIdx]];
        newRow[colIdx] = { ...(newRow[colIdx] || {}), v: displayVal };
        newMatrix[rIdx] = newRow;

        // If Direct costs row 13 was updated, also update row 30 (formula mirror)
        if (sheetRow === 13 && newMatrix[29]) {
          const row30 = [...newMatrix[29]];
          row30[colIdx] = { ...(row30[colIdx] || {}), v: displayVal };
          newMatrix[29] = row30;
        }
      }
      return { ...prev, matrix: newMatrix };
    });

    try {
      const rowDesc = budgetData?.matrix?.[sheetRow - 1]?.[0]?.v || `Row ${sheetRow}`;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_view_cell",
          clientSheetId: clientKey,
          masterSheetId: masterKey,
          tab: "budget",
          screenTab: "budget",
          sheetRow,
          colLetter,
          colIdx,
          value: newValue,
          rowDescription: rowDesc,
          clientName: selectedClient.clientName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Failed to update cell (status ${res.status})`);
      }

      if (data.updatedMatrix) {
        setBudgetData((prev) => (prev ? { ...prev, matrix: data.updatedMatrix } : prev));
      }
      setSaveSuccessMsg(`Updated Row ${sheetRow} (${colLetter})`);
      setTimeout(() => setSaveSuccessMsg(""), 3000);
    } catch (err) {
      console.error("update_view_cell error:", err);
      setError(err.message || "Failed to update cell");
      fetchBudgetData(selectedClient, true);
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // CELL NOTE HANDLERS (VIEW / EDIT / DELETE CELL NOTES)
  // ───────────────────────────────────────────────────────────────────────────
  const handleOpenNoteModal = (sheetRow, colIdx, title, subtitle = "") => {
    const currentNote = matrix[sheetRow - 1]?.[colIdx]?.note || "";
    setNoteModalData({
      sheetRow,
      colIdx,
      title: title || "Cell note",
      subtitle: subtitle || `Budget row ${sheetRow}, column ${colIndexToLetter(colIdx + 1)}`,
      initialNote: currentNote,
    });
  };

  const handleSaveCellNote = async (newNote) => {
    if (!noteModalData || !selectedClient) return;
    const { sheetRow, colIdx } = noteModalData;
    const clientKey = selectedClient.clientSpreadsheetId || selectedClient.spreadsheetId;
    const masterKey = selectedClient.masterSpreadsheetId || selectedClient.masterSheetId;

    // Optimistically update local matrix
    setBudgetData((prev) => {
      if (!prev || !prev.matrix) return prev;
      const newMatrix = [...prev.matrix];
      const rIdx = sheetRow - 1;
      if (newMatrix[rIdx]) {
        const newRow = [...newMatrix[rIdx]];
        const currentCell = newRow[colIdx] || {};
        newRow[colIdx] = { ...currentCell, note: newNote || undefined };
        newMatrix[rIdx] = newRow;
      }
      return { ...prev, matrix: newMatrix };
    });

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cell_note",
          clientSheetId: clientKey,
          masterSheetId: masterKey,
          tab: "Budget",
          sheetRow,
          colIdx,
          note: newNote,
          clientName: selectedClient.clientName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || "Failed to update cell note");
      }

      setSaveSuccessMsg(`Updated note on Row ${sheetRow}`);
      setTimeout(() => setSaveSuccessMsg(""), 3000);
    } catch (err) {
      console.error("update_cell_note error:", err);
      setError(err.message || "Failed to update cell note");
      fetchBudgetData(selectedClient, true);
      throw err;
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // SPREAD ROW HANDLER (FOR ROWS 5 & 13 ACROSS ACTIVE FY)
  // ───────────────────────────────────────────────────────────────────────────
  const handleSpreadRow = async (sheetRow, annualValStr) => {
    if (!selectedClient || !sheetRow) return;
    const cleanNum = parseNum(annualValStr);
    const monthlyVal = Math.round(cleanNum / 12);
    const startColIdx = fyCols[0];
    const endColIdx = fyCols[11];
    const startColLetter = colIndexToLetter(startColIdx + 1);
    const endColLetter = colIndexToLetter(endColIdx + 1);
    const values = Array(12).fill(monthlyVal);

    setSavingSpread(true);
    setSpreadModal((prev) => ({ ...prev, isOpen: false }));

    // Optimistically update matrix
    setBudgetData((prev) => {
      if (!prev || !prev.matrix) return prev;
      const newMatrix = [...prev.matrix];
      const rIdx = sheetRow - 1;
      if (newMatrix[rIdx]) {
        const newRow = [...newMatrix[rIdx]];
        fyCols.forEach((cIdx) => {
          newRow[cIdx] = { ...(newRow[cIdx] || {}), v: formatMoney(monthlyVal) };
        });
        newMatrix[rIdx] = newRow;

        if (sheetRow === 13 && newMatrix[29]) {
          const row30 = [...newMatrix[29]];
          fyCols.forEach((cIdx) => {
            row30[cIdx] = { ...(row30[cIdx] || {}), v: formatMoney(monthlyVal) };
          });
          newMatrix[29] = row30;
        }
      }
      return { ...prev, matrix: newMatrix };
    });

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "spread_view_row",
          clientSheetId: selectedClient.clientSheetId,
          masterSheetId: selectedClient.masterSheetId,
          sheetRow,
          startColLetter,
          endColLetter,
          values,
          rowDescription: sheetRow === 5 ? "Confirmed revenue" : "Direct costs",
          clientName: selectedClient.clientName,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error || "Failed to spread row across months");
      }

      if (data.updatedMatrix) {
        setBudgetData((prev) => (prev ? { ...prev, matrix: data.updatedMatrix } : prev));
      }
      setSaveSuccessMsg(`Spread ${formatMoney(cleanNum)} evenly across ${activeFyLabel}`);
      setTimeout(() => setSaveSuccessMsg(""), 3500);
    } catch (err) {
      console.error("spread_view_row error:", err);
      setError(err.message || "Failed to spread row");
      fetchBudgetData(selectedClient, true);
    } finally {
      setSavingSpread(false);
    }
  };

  // Helper for cell editable options
  const getEditableOpts = (sheetRow, colIdx, cellValue) => {
    const isEditable = isBudgetCellEditable(sheetRow, colIdx);
    if (!isEditable) return null;

    const isEditing = editingCell?.sheetRow === sheetRow && editingCell?.colIdx === colIdx;
    const isSaving = savingKey === `${sheetRow}_${colIdx}`;

    let initialEditVal = cellValue ?? "";
    if (colIdx === 4 || (sheetRow === 142 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/%/g, "").trim();
    } else if (colIdx >= 6 || (sheetRow >= 58 && sheetRow <= 112 && colIdx === 1)) {
      initialEditVal = String(cellValue ?? "").replace(/[£,$\s]/g, "").trim();
    }

    return {
      isEditable,
      isEditing,
      isSaving,
      editValue: isEditing ? editingCell.editValue : initialEditVal,
      onChangeEditValue: (val) =>
        setEditingCell((prev) => (prev ? { ...prev, editValue: val } : null)),
      onCommitEdit: async (overrideVal) => {
        if (committingRef.current) return;
        committingRef.current = true;
        const cur = editingCell;
        setEditingCell(null);
        setTimeout(() => {
          committingRef.current = false;
        }, 100);
        if (!cur && overrideVal === undefined) return;

        const rawVal = overrideVal !== undefined ? overrideVal : cur ? cur.editValue : "";
        setSavingKey(`${sheetRow}_${colIdx}`);
        try {
          await handleUpdateCell(sheetRow, colIdx, rawVal);
        } finally {
          setSavingKey(null);
        }
      },
      onStartEdit: () => {
        setEditingCell({ sheetRow, colIdx, editValue: initialEditVal });
      },
      onCancelEdit: () => setEditingCell(null),
    };
  };

  // ───────────────────────────────────────────────────────────────────────────
  // CSV EXPORT
  // ───────────────────────────────────────────────────────────────────────────
  const handleDownloadCSV = () => {
    const dateStr = new Date().toISOString().split("T")[0];
    const yearLabel = activeFyLabel.replace(/\s+/g, "_");
    const exportRows = [];

    exportRows.push([`Budget overview: ${activeFyLabel}`]);
    exportRows.push([]);
    exportRows.push(["Metric", ...monthHeaders, "", "Total"]);

    tableRows.forEach((r) => {
      if (r.type === "section") {
        exportRows.push([r.label]);
      } else if (r.type !== "spacer") {
        const rowVals = Array.from({ length: 12 }).map((_, mIdx) => {
          const val = r.data[mIdx];
          return r.isCurrency ? formatMoney(val) : formatPctDisplay(val);
        });
        const totalVal = r.isCurrency ? formatMoney(r.data[12]) : formatPctDisplay(r.data[12]);
        exportRows.push([r.label, ...rowVals, "", totalVal]);
      }
    });

    downloadCsv(`Pulse_Budget_Overview_${yearLabel}_${dateStr}.csv`, exportRows);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // SUB-SECTION DATA EXTRACTION & FILTERING
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Salaries & Dividends (Rows 58 to 112, plus Row 119)
  const salaryRows = useMemo(() => {
    const list = [];
    for (let r = 58; r <= 112; r++) {
      const row = matrix[r - 1];
      if (!row) continue;
      const name = String(row[0]?.v || "").trim();
      const salary = String(row[1]?.v || "").trim();
      const hasContent = Boolean(name || salary || parseNum(row[1]?.v) > 0);
      list.push({ sheetRow: r, row, hasContent, name });
    }
    return list;
  }, [matrix]);

  const filteredSalaryRows = useMemo(() => {
    return salaryRows.filter(({ hasContent, name }) => {
      if (!showEmptySalaries && !hasContent) return false;
      if (salariesSearch.trim()) {
        return name.toLowerCase().includes(salariesSearch.toLowerCase().trim());
      }
      return true;
    });
  }, [salaryRows, showEmptySalaries, salariesSearch]);

  const activeEmployeeCount = useMemo(() => {
    return salaryRows.filter((s) => s.hasContent).length;
  }, [salaryRows]);

  // 2. Contractors (Rows 126 to 140)
  const contractorRows = useMemo(() => {
    const list = [];
    for (let r = 126; r <= 140; r++) {
      const row = matrix[r - 1];
      if (!row) continue;
      const name = String(row[0]?.v || "").trim();
      const hasContent = Boolean(
        name || fyCols.some((cIdx) => parseNum(row[cIdx]?.v) > 0)
      );
      list.push({ sheetRow: r, row, hasContent, name });
    }
    return list;
  }, [matrix, fyCols]);

  const filteredContractorRows = useMemo(() => {
    return contractorRows.filter(({ hasContent, name }) => {
      if (!showEmptyContractors && !hasContent) return false;
      if (contractorsSearch.trim()) {
        return name.toLowerCase().includes(contractorsSearch.toLowerCase().trim());
      }
      return true;
    });
  }, [contractorRows, showEmptyContractors, contractorsSearch]);

  const activeContractorCount = useMemo(() => {
    return contractorRows.filter((c) => c.hasContent).length;
  }, [contractorRows]);

  // 3. Other Expenses (Rows 149 to 251)
  const expenseRows = useMemo(() => {
    const list = [];
    for (let r = 149; r <= 251; r++) {
      const row = matrix[r - 1];
      if (!row) continue;
      const name = String(row[0]?.v || "").trim();
      const hasContent = Boolean(
        name || fyCols.some((cIdx) => parseNum(row[cIdx]?.v) > 0)
      );
      list.push({ sheetRow: r, row, hasContent, name });
    }
    return list;
  }, [matrix, fyCols]);

  const filteredExpenseRows = useMemo(() => {
    return expenseRows.filter(({ hasContent, name }) => {
      if (!showEmptyExpenses && !hasContent) return false;
      if (expensesSearch.trim()) {
        return name.toLowerCase().includes(expensesSearch.toLowerCase().trim());
      }
      return true;
    });
  }, [expenseRows, showEmptyExpenses, expensesSearch]);

  const activeExpenseCount = useMemo(() => {
    return expenseRows.filter((e) => e.hasContent).length;
  }, [expenseRows]);

  const targetSheetId = selectedClient?.masterSheetId || selectedClient?.clientSheetId;

  return (
    <div
      style={{
        maxWidth: "1600px",
        margin: "0 auto",
        padding: "16px 24px 60px",
        boxSizing: "border-box",
        fontFamily: "'Kumbh Sans', sans-serif",
      }}
    >
      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* ACTION BAR / TOP HEADER CARD                                          */}
      {/* ───────────────────────────────────────────────────────────────────── */}
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
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
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
            <h1
              style={{
                margin: 0,
                fontSize: "20px",
                fontWeight: 700,
                color: "#1e293b",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>Budget</span>
              {selectedClient && budgetData && (
                <>
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#0047AB",
                      background: "rgba(0, 71, 171, 0.08)",
                      padding: "2px 8px",
                      borderRadius: "4px",
                    }}
                  >
                    {activeFyLabel}
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      background: "#eff6ff",
                      color: "#1d4ed8",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontWeight: 600,
                    }}
                  >
                    {isIncomeMode ? "Income mode" : "Revenue mode"}
                  </span>
                </>
              )}
            </h1>
            {selectedClient ? (
              <div style={{ margin: "3px 0 0", fontSize: "14px", fontWeight: 600, color: "#0047AB" }}>
                {selectedClient.clientName}
              </div>
            ) : (
              <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748b" }}>
                Select a client to view and edit budget
              </p>
            )}
          </div>
        </div>

        {selectedClient && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* FY Navigator */}
            {fyConfigs.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.max(0, prev - 1))}
                  disabled={selectedFyIdx <= 0}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx <= 0 ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx <= 0 ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Previous financial year"
                >
                  ◀
                </button>

                <select
                  value={selectedFyIdx}
                  onChange={(e) => setSelectedFyIdx(parseInt(e.target.value, 10))}
                  style={{
                    padding: "6px 10px",
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
                  {fyConfigs.map((fy, idx) => (
                    <option key={idx} value={idx}>
                      {fy.label || `FY${idx + 1}`}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.min(maxFyIdx, prev + 1))}
                  disabled={selectedFyIdx >= maxFyIdx}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx >= maxFyIdx ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx >= maxFyIdx ? "#cbd5e1" : "#1e293b",
                    fontWeight: 700,
                  }}
                  title="Next financial year"
                >
                  ▶
                </button>
              </div>
            )}

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => selectedClient && fetchBudgetData(selectedClient, true)}
              disabled={loading}
              title="Refresh budget data from master sheet"
              style={{
                padding: "6px 12px",
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

            {/* CSV Export Button */}
            <button
              type="button"
              onClick={handleDownloadCSV}
              title="Export budget overview to CSV"
              style={{
                padding: "6px 12px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              📥 Export CSV
            </button>

            {/* Admin: Open in Sheets */}
            {isAdmin && targetSheetId && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${targetSheetId}/edit#gid=0`}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid #166534",
                  background: "#15803d",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
                title="Open master sheet in Google Sheets"
              >
                <span>📊</span>
                <span>Open in sheets</span>
              </a>
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
          title="Select a client to view and edit budget:"
        />
      )}

      {/* Notifications */}
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

      {/* Main Loading Skeleton */}
      {selectedClient && loading && !budgetData && (
        <BudgetSkeleton />
      )}

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* 1. TOP FULL-YEAR BUDGET OVERVIEW TABLE                                */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      {selectedClient && budgetData && computedModel && (
        <div
          style={{
            background: "#ffffff",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            border: "1px solid #e2e8f0",
            overflow: "hidden",
            width: "100%",
            marginBottom: "32px",
          }}
        >
          {/* Table Header Bar with Instructions */}
          <div
            style={{
              padding: "10px 16px",
              background: "#f8fafc",
              borderBottom: "1px solid #e2e8f0",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#1e293b" }}>
                Full-year budget overview
              </span>
              <span style={{ fontSize: "12px", color: "#64748b" }}>
                · Showing {activeFyLabel} (months sync with all sections below)
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", color: "#475569" }}>
              <span
                style={{
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  color: "#1d4ed8",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span>✏️</span>{" "}
                {isIncomeMode
                  ? "Confirmed income is editable"
                  : "Confirmed revenue and direct costs are editable"}
              </span>
              <span>Click any highlighted cell to edit, or use ⚡ spread</span>
            </div>
          </div>

          <div style={{ overflowX: "auto", width: "100%" }}>
            <table
              style={{
                width: "100%",
                minWidth: "1040px",
                tableLayout: "fixed",
                borderCollapse: "separate",
                borderSpacing: 0,
                fontSize: "11.5px",
                fontFamily: "'Kumbh Sans', sans-serif",
              }}
            >
              <thead>
                <tr style={{ background: "#0047AB", color: "#ffffff", height: "32px" }}>
                  <th
                    style={{
                      padding: "6px 12px",
                      textAlign: "left",
                      fontWeight: 700,
                      width: "20%",
                      position: "sticky",
                      left: 0,
                      background: "#0047AB",
                      zIndex: 3,
                      fontSize: "12px",
                    }}
                  />
                  {monthHeaders.map((mLabel, idx) => (
                    <th
                      key={idx}
                      style={{
                        padding: "6px 4px",
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: "11.5px",
                        width: "6.0%",
                        background: "#0047AB",
                      }}
                    >
                      {mLabel}
                    </th>
                  ))}
                  <th
                    style={{
                      padding: "6px 12px",
                      textAlign: "right",
                      fontWeight: 800,
                      fontSize: "12px",
                      width: "8.0%",
                      background: "#0047AB",
                      borderLeft: "1px solid #cbd5e1",
                    }}
                  >
                    Total
                  </th>
                </tr>
              </thead>

              <tbody>
                {tableRows.map((r, rIdx) => {
                  if (r.type === "spacer") {
                    return (
                      <tr key={rIdx} style={{ height: `${r.height}px`, lineHeight: 0 }}>
                        <td
                          style={{
                            padding: 0,
                            background: "#ffffff",
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            border: "none",
                          }}
                        />
                        {Array.from({ length: 12 }).map((_, cIdx) => (
                          <td key={cIdx} style={{ padding: 0, background: "#ffffff", border: "none" }} />
                        ))}
                        <td
                          style={{
                            padding: 0,
                            background: "rgba(0, 71, 171, 0.04)",
                            border: "none",
                            borderLeft: "1px solid #cbd5e1",
                          }}
                        />
                      </tr>
                    );
                  }

                  if (r.type === "section") {
                    return (
                      <tr key={rIdx} style={{ height: "26px", borderBottom: "1px solid #f1f5f9" }}>
                        <td
                          style={{
                            padding: "5px 12px",
                            textAlign: "left",
                            fontWeight: 700,
                            fontSize: "11px",
                            textTransform: "uppercase",
                            letterSpacing: "0.6px",
                            color: "#0047AB",
                            position: "sticky",
                            left: 0,
                            background: "#ffffff",
                            zIndex: 2,
                            boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                          }}
                        >
                          {r.label}
                        </td>
                        {Array.from({ length: 12 }).map((_, cIdx) => (
                          <td key={cIdx} style={{ padding: 0, background: "#ffffff", border: "none" }} />
                        ))}
                        <td
                          style={{
                            padding: 0,
                            background: "rgba(0, 71, 171, 0.04)",
                            border: "none",
                            borderLeft: "1px solid #cbd5e1",
                          }}
                        />
                      </tr>
                    );
                  }

                  // Data Row
                  const isBigTotal = r.isBigTotal;
                  const rowBg = r.bg;
                  const rowColor = r.color;
                  const isBold = r.isBold;
                  const isMargin = r.isMargin;
                  const rowHeight = isBigTotal ? "32px" : isMargin ? "22px" : "26px";
                  const fontSize = isBigTotal ? "13px" : isMargin ? "11px" : "11.5px";
                  const borderBottom = isBigTotal ? "2px solid #cbd5e1" : "1px solid #f1f5f9";

                  return (
                    <tr
                      key={rIdx}
                      style={{
                        height: rowHeight,
                        background: isBigTotal ? rowBg : r.isEditable ? "#fdfefe" : "#ffffff",
                        borderBottom,
                        fontWeight: isBold ? 700 : 400,
                      }}
                    >
                      {/* Metric Label Column */}
                      <td
                        style={{
                          padding: isMargin ? "2px 12px" : "4.5px 12px",
                          paddingLeft: isMargin ? "22px" : isBigTotal ? "12px" : "16px",
                          textAlign: "left",
                          color: isBigTotal ? "#ffffff" : rowColor,
                          fontWeight: isBold ? 700 : 400,
                          fontStyle: isMargin ? "italic" : "normal",
                          fontSize,
                          position: "sticky",
                          left: 0,
                          background: isBigTotal ? rowBg : r.isEditable ? "#f8faff" : "#ffffff",
                          borderLeft: isMargin && r.accentBar ? `4px solid ${r.accentBar}` : "none",
                          zIndex: 2,
                          whiteSpace: "nowrap",
                          boxShadow: "2px 0 3px rgba(0,0,0,0.02)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span>{r.label}</span>
                          {r.isEditable && (
                            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  background: "#dbeafe",
                                  color: "#1e40af",
                                  padding: "1px 6px",
                                  borderRadius: "4px",
                                }}
                                title="This row is editable cell-by-cell or via spread"
                              >
                                Editable
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setSpreadModal({
                                    isOpen: true,
                                    sheetRow: r.sheetRow,
                                    label: r.label,
                                    annualTotal: r.data[12] ? String(r.data[12]) : "",
                                  })
                                }
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  color: "#1d4ed8",
                                  background: "#eff6ff",
                                  border: "1px solid #bfdbfe",
                                  borderRadius: "4px",
                                  padding: "2px 6px",
                                  cursor: "pointer",
                                }}
                                title="Spread an annual amount evenly across all 12 months"
                              >
                                ⚡ Spread
                              </button>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* 12 Month Values */}
                      {Array.from({ length: 12 }).map((_, mIdx) => {
                        const val = r.data[mIdx];
                        const displayVal = r.isCurrency ? formatMoney(val) : formatPctDisplay(val);
                        const cIdx = fyCols[mIdx];

                        if (isBigTotal) {
                          return (
                            <td
                              key={mIdx}
                              style={{
                                padding: "4.5px 4px",
                                textAlign: "right",
                                color: "#ffffff",
                                fontSize: "13px",
                                fontWeight: 700,
                                whiteSpace: "nowrap",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {displayVal}
                            </td>
                          );
                        }

                        if (isMargin) {
                          const threshBg = getMarginColor(r.label, val);
                          return (
                            <td
                              key={mIdx}
                              style={{
                                padding: "1px 2px",
                                background: "#ffffff",
                                textAlign: "right",
                                height: "22px",
                              }}
                            >
                              <div
                                style={{
                                  display: "inline-block",
                                  width: "100%",
                                  padding: "1.5px 3px",
                                  borderRadius: "4px",
                                  background: threshBg || "transparent",
                                  color: "#0047AB",
                                  border: threshBg ? "1.5px solid #ffffff" : "none",
                                  fontStyle: "italic",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  fontVariantNumeric: "tabular-nums",
                                  boxSizing: "border-box",
                                }}
                              >
                                {displayVal}
                              </div>
                            </td>
                          );
                        }

                        // Editable month cell for Row 5 or Row 13
                        if (r.isEditable && r.sheetRow) {
                          const opts = getEditableOpts(r.sheetRow, cIdx, val);
                          const cellNote = matrix[r.sheetRow - 1]?.[cIdx]?.note || "";
                          return (
                            <EditableBudgetCell
                              key={mIdx}
                              value={val}
                              displayValue={displayVal}
                              editableOpts={opts}
                              isHighlighted={true}
                              align="right"
                              note={cellNote}
                              onNoteClick={() =>
                                handleOpenNoteModal(
                                  r.sheetRow,
                                  cIdx,
                                  `Cell note: ${r.label}`,
                                  `${monthHeaders[mIdx] || `Month ${mIdx + 1}`} (Row ${r.sheetRow}, Col ${colIndexToLetter(cIdx + 1)})`
                                )
                              }
                            />
                          );
                        }

                        // Regular read-only cell
                        return (
                          <td
                            key={mIdx}
                            style={{
                              padding: "4px 4px",
                              textAlign: "right",
                              color: rowColor,
                              fontSize: "11.5px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {displayVal}
                          </td>
                        );
                      })}

                      {/* 13th Column: FY Total */}
                      <td
                        style={{
                          padding: "4.5px 12px",
                          textAlign: "right",
                          fontWeight: 700,
                          fontSize: isBigTotal ? "13px" : "12px",
                          color: isBigTotal ? "#ffffff" : rowColor,
                          background: isBigTotal ? rowBg : "rgba(0, 71, 171, 0.04)",
                          borderLeft: "1px solid #cbd5e1",
                          whiteSpace: "nowrap",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {r.isCurrency ? formatMoney(r.data[12]) : formatPctDisplay(r.data[12])}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* SUB-SECTIONS (MIRRORING BUDGET TAB)                                  */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      {budgetData && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* ═════════════════════════════════════════════════════════════════ */}
          {/* 2. SALARIES SUB-SECTION (Rows 58 to 112 + Dividends Row 119)     */}
          {/* ═════════════════════════════════════════════════════════════════ */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              border: "1px solid #cbd5e1",
              overflow: "hidden",
            }}
          >
            {/* Collapsible Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 18px",
                background: "#f8fafc",
                borderBottom: salariesOpen ? "1px solid #e2e8f0" : "none",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => setSalariesOpen((prev) => !prev)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "14px", color: "#64748b" }}>{salariesOpen ? "▼" : "▶"}</span>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
                  Salaries & staff costs
                </h3>
                <span
                  style={{
                    fontSize: "12px",
                    background: "#e0e7ff",
                    color: "#3730a3",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontWeight: 600,
                  }}
                >
                  {activeEmployeeCount} active
                </span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  · Master Sheet Budget rows 58–112 (cols A–E drive monthly costs) + dividends
                </span>
              </div>

              <div
                style={{ display: "flex", alignItems: "center", gap: "12px" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  placeholder="Search staff..."
                  value={salariesSearch}
                  onChange={(e) => setSalariesSearch(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    outline: "none",
                    width: "160px",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowEmptySalaries((prev) => !prev)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    background: showEmptySalaries ? "#e0e7ff" : "#ffffff",
                    color: showEmptySalaries ? "#3730a3" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showEmptySalaries ? "Hide empty rows" : "Show all empty rows"}
                </button>
              </div>
            </div>

            {/* Content Table */}
            {salariesOpen && (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "12px",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#312e81", color: "#ffffff" }}>
                      <th style={{ padding: "8px 6px", width: "42px", textAlign: "center" }}>Row</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", minWidth: "220px" }}>Name</th>
                      <th style={{ padding: "8px 8px", textAlign: "right", minWidth: "110px" }}>
                        Equiv salary
                      </th>
                      <th style={{ padding: "8px 6px", textAlign: "center", minWidth: "90px" }}>Start</th>
                      <th style={{ padding: "8px 6px", textAlign: "center", minWidth: "90px" }}>End</th>
                      <th style={{ padding: "8px 6px", textAlign: "center", width: "65px" }}>Del %</th>
                      <th style={{ padding: "8px 8px", textAlign: "right", minWidth: "95px" }}>Cost/mth</th>
                      {fyCols.map((cIdx) => (
                        <th
                          key={cIdx}
                          style={{
                            padding: "8px 6px",
                            textAlign: "right",
                            minWidth: "75px",
                            borderLeft: "1px solid #4338ca",
                          }}
                        >
                          {row0[cIdx]?.v || `M${cIdx}`}
                        </th>
                      ))}
                      <th
                        style={{
                          padding: "8px 8px",
                          textAlign: "right",
                          minWidth: "85px",
                          background: "#1e1b4b",
                          borderLeft: "1px solid #4338ca",
                        }}
                      >
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSalaryRows.map(({ sheetRow, row, hasContent }) => {
                      const name = row[0]?.v || "";
                      const equivSalary = row[1]?.v || "";
                      const startMth = row[2]?.v || "";
                      const endMth = row[3]?.v || "";
                      const delPct = row[4]?.v || "";
                      const costPm = row[5]?.v || "";

                      return (
                        <tr
                          key={sheetRow}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: hasContent ? "#ffffff" : "#fafafa",
                          }}
                        >
                          <td style={{ padding: "5px 4px", textAlign: "center", color: "#94a3b8", background: "#f8fafc" }}>
                            {sheetRow}
                          </td>

                          {/* Col A: Name */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={0}
                            value={name}
                            align="left"
                            editableOpts={getEditableOpts(sheetRow, 0, name)}
                            note={row[0]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 0, `Cell note: ${name || "Employee"} (Name)`, `Row ${sheetRow}, Col A`)
                            }
                          />

                          {/* Col B: Equiv Salary */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={1}
                            value={equivSalary}
                            align="right"
                            isCurrency={true}
                            editableOpts={getEditableOpts(sheetRow, 1, equivSalary)}
                            note={row[1]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 1, `Cell note: ${name || "Employee"} (Salary)`, `Row ${sheetRow}, Col B`)
                            }
                          />

                          {/* Col C: Start Month */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={2}
                            value={startMth}
                            align="center"
                            editableOpts={getEditableOpts(sheetRow, 2, startMth)}
                            note={row[2]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 2, `Cell note: ${name || "Employee"} (Start month)`, `Row ${sheetRow}, Col C`)
                            }
                          />

                          {/* Col D: End Month */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={3}
                            value={endMth}
                            align="center"
                            editableOpts={getEditableOpts(sheetRow, 3, endMth)}
                            note={row[3]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 3, `Cell note: ${name || "Employee"} (End month)`, `Row ${sheetRow}, Col D`)
                            }
                          />

                          {/* Col E: Del % */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={4}
                            value={delPct}
                            align="center"
                            isPercent={true}
                            editableOpts={getEditableOpts(sheetRow, 4, delPct)}
                            note={row[4]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 4, `Cell note: ${name || "Employee"} (Delivery %)`, `Row ${sheetRow}, Col E`)
                            }
                          />

                          {/* Col F: Cost pm (formula in sheet) */}
                          <td style={{ padding: "5px 8px", textAlign: "right", color: "#64748b", background: "#f8fafc" }}>
                            {costPm}
                          </td>

                          {/* Monthly Columns across FY */}
                          {fyCols.map((cIdx) => (
                            <td
                              key={cIdx}
                              style={{
                                padding: "5px 6px",
                                textAlign: "right",
                                borderLeft: "1px solid #f8fafc",
                                color: "#334155",
                              }}
                            >
                              {row[cIdx]?.v || ""}
                            </td>
                          ))}

                          {/* FY Total */}
                          <td
                            style={{
                              padding: "5px 8px",
                              textAlign: "right",
                              fontWeight: 700,
                              background: "#f8fafc",
                              borderLeft: "1px solid #e2e8f0",
                            }}
                          >
                            {row[totalCol]?.v || ""}
                          </td>
                        </tr>
                      );
                    })}

                    {/* ── Dividends Row (Row 119) ── */}
                    {matrix[118] && (
                      <tr style={{ background: "#fefce8", borderTop: "2px solid #fef08a", fontWeight: 600 }}>
                        <td style={{ padding: "6px 4px", textAlign: "center", color: "#854d0e", background: "#fef9c3" }}>
                          119
                        </td>
                        <td style={{ padding: "6px 10px", color: "#854d0e" }}>
                          <span>{matrix[118][0]?.v || "Div in lieu of salary"}</span>
                          <span
                            style={{
                              fontSize: "10px",
                              background: "#fef08a",
                              color: "#854d0e",
                              padding: "1px 6px",
                              borderRadius: "4px",
                              marginLeft: "8px",
                            }}
                          >
                            Dividends
                          </span>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: "#94a3b8" }}>—</td>
                        <td style={{ padding: "6px 6px", textAlign: "center", color: "#94a3b8" }}>—</td>
                        <td style={{ padding: "6px 6px", textAlign: "center", color: "#94a3b8" }}>—</td>

                        {/* Del % (Col E) - Editable */}
                        <EditableGridCell
                          sheetRow={119}
                          colIdx={4}
                          value={matrix[118][4]?.v || "0%"}
                          align="center"
                          isPercent={true}
                          editableOpts={getEditableOpts(119, 4, matrix[118][4]?.v || "0%")}
                          note={matrix[118][4]?.note || ""}
                          onNoteClick={() =>
                            handleOpenNoteModal(119, 4, "Cell note: Dividends (Delivery %)", "Row 119, Col E")
                          }
                        />

                        <td style={{ padding: "6px 8px", textAlign: "right", color: "#94a3b8" }}>—</td>

                        {/* Monthly Dividend Cells - Editable */}
                        {fyCols.map((cIdx, mIdx) => {
                          const cell = matrix[118][cIdx];
                          const opts = getEditableOpts(119, cIdx, cell?.v);
                          return (
                            <EditableGridCell
                              key={cIdx}
                              sheetRow={119}
                              colIdx={cIdx}
                              value={cell?.v}
                              align="right"
                              isCurrency={true}
                              editableOpts={opts}
                              note={cell?.note || ""}
                              onNoteClick={() =>
                                handleOpenNoteModal(
                                  119,
                                  cIdx,
                                  "Cell note: Dividends",
                                  `${monthHeaders[mIdx] || `Month ${mIdx + 1}`} (Row 119, Col ${colIndexToLetter(cIdx + 1)})`
                                )
                              }
                            />
                          );
                        })}

                        <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, background: "#fef9c3" }}>
                          {matrix[118][totalCol]?.v || ""}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ═════════════════════════════════════════════════════════════════ */}
          {/* 3. CONTRACTORS SUB-SECTION (Rows 126 to 140 + Making up CoS 142) */}
          {/* ═════════════════════════════════════════════════════════════════ */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              border: "1px solid #cbd5e1",
              overflow: "hidden",
            }}
          >
            {/* Collapsible Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 18px",
                background: "#f8fafc",
                borderBottom: contractorsOpen ? "1px solid #e2e8f0" : "none",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => setContractorsOpen((prev) => !prev)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "14px", color: "#64748b" }}>{contractorsOpen ? "▼" : "▶"}</span>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
                  Contractors & subcontractors
                </h3>
                <span
                  style={{
                    fontSize: "12px",
                    background: "#e0e7ff",
                    color: "#3730a3",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontWeight: 600,
                  }}
                >
                  {activeContractorCount} active
                </span>

                {/* Prominent "Making up CoS" Target Setting Control */}
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "#faf5ff",
                    border: "1px solid #e9d5ff",
                    padding: "3px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    marginLeft: "8px",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span style={{ fontWeight: 600, color: "#7e22ce" }}>Making up CoS target (B142):</span>
                  {isEditingCosTarget ? (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <input
                        type="text"
                        value={cosTargetInput}
                        autoFocus
                        onChange={(e) => setCosTargetInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setIsEditingCosTarget(false);
                            handleUpdateCell(142, 1, cosTargetInput);
                          } else if (e.key === "Escape") {
                            setIsEditingCosTarget(false);
                          }
                        }}
                        onBlur={() => {
                          setIsEditingCosTarget(false);
                          handleUpdateCell(142, 1, cosTargetInput);
                        }}
                        style={{
                          width: "55px",
                          padding: "2px 4px",
                          fontSize: "12px",
                          border: "1px solid #a855f7",
                          borderRadius: "4px",
                          textAlign: "center",
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setCosTargetInput(matrix[141]?.[1]?.v ? String(matrix[141][1].v).replace(/%/g, "") : "50");
                        setIsEditingCosTarget(true);
                      }}
                      style={{
                        background: "#f3e8ff",
                        border: "1px solid #d8b4fe",
                        color: "#6b21a8",
                        fontWeight: 700,
                        fontSize: "12px",
                        padding: "1px 8px",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                      title="Click to edit desired CoS %"
                    >
                      {matrix[141]?.[1]?.v || "50%"} ✏️
                    </button>
                  )}
                </div>
              </div>

              <div
                style={{ display: "flex", alignItems: "center", gap: "12px" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  placeholder="Search contractors..."
                  value={contractorsSearch}
                  onChange={(e) => setContractorsSearch(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    outline: "none",
                    width: "160px",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowEmptyContractors((prev) => !prev)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    background: showEmptyContractors ? "#e0e7ff" : "#ffffff",
                    color: showEmptyContractors ? "#3730a3" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showEmptyContractors ? "Hide empty rows" : "Show all empty rows"}
                </button>
              </div>
            </div>

            {/* Content Table */}
            {contractorsOpen && (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "12px",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#0e7490", color: "#ffffff" }}>
                      <th style={{ padding: "8px 6px", width: "42px", textAlign: "center" }}>Row</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", minWidth: "240px" }}>Contractor name</th>
                      <th style={{ padding: "8px 6px", textAlign: "center", width: "70px" }}>Del %</th>
                      {fyCols.map((cIdx) => (
                        <th
                          key={cIdx}
                          style={{
                            padding: "8px 6px",
                            textAlign: "right",
                            minWidth: "75px",
                            borderLeft: "1px solid #155e75",
                          }}
                        >
                          {row0[cIdx]?.v || `M${cIdx}`}
                        </th>
                      ))}
                      <th
                        style={{
                          padding: "8px 8px",
                          textAlign: "right",
                          minWidth: "85px",
                          background: "#164e63",
                          borderLeft: "1px solid #155e75",
                        }}
                      >
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredContractorRows.map(({ sheetRow, row, hasContent }) => {
                      const name = row[0]?.v || "";
                      const delPct = row[4]?.v || "";

                      return (
                        <tr
                          key={sheetRow}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: hasContent ? "#ffffff" : "#fafafa",
                          }}
                        >
                          <td style={{ padding: "5px 4px", textAlign: "center", color: "#94a3b8", background: "#f8fafc" }}>
                            {sheetRow}
                          </td>

                          {/* Contractor Name */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={0}
                            value={name}
                            align="left"
                            editableOpts={getEditableOpts(sheetRow, 0, name)}
                            note={row[0]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 0, `Cell note: ${name || "Contractor"} (Name)`, `Row ${sheetRow}, Col A`)
                            }
                          />

                          {/* Del % */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={4}
                            value={delPct}
                            align="center"
                            isPercent={true}
                            editableOpts={getEditableOpts(sheetRow, 4, delPct)}
                            note={row[4]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 4, `Cell note: ${name || "Contractor"} (Delivery %)`, `Row ${sheetRow}, Col E`)
                            }
                          />

                          {/* Monthly Columns (Editable) */}
                          {fyCols.map((cIdx, mIdx) => {
                            const cell = row[cIdx];
                            const opts = getEditableOpts(sheetRow, cIdx, cell?.v);
                            return (
                              <EditableGridCell
                                key={cIdx}
                                sheetRow={sheetRow}
                                colIdx={cIdx}
                                value={cell?.v}
                                align="right"
                                isCurrency={true}
                                editableOpts={opts}
                                note={cell?.note || ""}
                                onNoteClick={() =>
                                  handleOpenNoteModal(
                                    sheetRow,
                                    cIdx,
                                    `Cell note: ${name || "Contractor"}`,
                                    `${monthHeaders[mIdx] || `Month ${mIdx + 1}`} (Row ${sheetRow}, Col ${colIndexToLetter(cIdx + 1)})`
                                  )
                                }
                              />
                            );
                          })}

                          {/* FY Total */}
                          <td
                            style={{
                              padding: "5px 8px",
                              textAlign: "right",
                              fontWeight: 700,
                              background: "#f8fafc",
                              borderLeft: "1px solid #e2e8f0",
                            }}
                          >
                            {row[totalCol]?.v || ""}
                          </td>
                        </tr>
                      );
                    })}

                    {/* ── Making up CoS Row (Row 142) ── */}
                    {matrix[141] && (
                      <tr style={{ background: "#faf5ff", borderTop: "2px solid #e9d5ff", fontWeight: 600 }}>
                        <td style={{ padding: "6px 4px", textAlign: "center", color: "#7e22ce", background: "#f3e8ff" }}>
                          142
                        </td>
                        <td style={{ padding: "6px 10px", color: "#7e22ce" }}>
                          <span>{matrix[141][0]?.v || "Making up CoS"}</span>
                          <span
                            style={{
                              fontSize: "10px",
                              background: "#e9d5ff",
                              color: "#6b21a8",
                              padding: "1px 6px",
                              borderRadius: "4px",
                              marginLeft: "8px",
                            }}
                          >
                            Formula top-up
                          </span>
                        </td>

                        {/* Del % (100%) */}
                        <td style={{ padding: "6px 6px", textAlign: "center", color: "#6b21a8" }}>
                          {matrix[141][4]?.v || "100%"}
                        </td>

                        {/* Calculated monthly Making up CoS values */}
                        {fyCols.map((cIdx, mIdx) => (
                          <td
                            key={cIdx}
                            style={{
                              padding: "6px 6px",
                              textAlign: "right",
                              borderLeft: "1px solid #f3e8ff",
                              color: "#7e22ce",
                            }}
                          >
                            {formatMoney(computedModel?.makingUpCosVals?.[mIdx] || parseNum(matrix[141][cIdx]?.v))}
                          </td>
                        ))}

                        <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, background: "#f3e8ff" }}>
                          {formatMoney(computedModel?.makingUpCosVals?.[12] || parseNum(matrix[141][totalCol]?.v))}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ═════════════════════════════════════════════════════════════════ */}
          {/* 4. OTHER EXPENSES SUB-SECTION (Rows 149 to 251)                  */}
          {/* ═════════════════════════════════════════════════════════════════ */}
          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
              border: "1px solid #cbd5e1",
              overflow: "hidden",
            }}
          >
            {/* Collapsible Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 18px",
                background: "#f8fafc",
                borderBottom: expensesOpen ? "1px solid #e2e8f0" : "none",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => setExpensesOpen((prev) => !prev)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "14px", color: "#64748b" }}>{expensesOpen ? "▼" : "▶"}</span>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
                  Other expenses
                </h3>
                <span
                  style={{
                    fontSize: "12px",
                    background: "#e0e7ff",
                    color: "#3730a3",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    fontWeight: 600,
                  }}
                >
                  {activeExpenseCount} active
                </span>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  · Master Sheet Budget rows 149–251 (filtered to active lines by default)
                </span>
              </div>

              <div
                style={{ display: "flex", alignItems: "center", gap: "12px" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  placeholder="Search expenses..."
                  value={expensesSearch}
                  onChange={(e) => setExpensesSearch(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    fontSize: "12px",
                    outline: "none",
                    width: "160px",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowEmptyExpenses((prev) => !prev)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    background: showEmptyExpenses ? "#e0e7ff" : "#ffffff",
                    color: showEmptyExpenses ? "#3730a3" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showEmptyExpenses ? "Hide empty rows" : "Show all empty rows"}
                </button>
              </div>
            </div>

            {/* Content Table */}
            {expensesOpen && (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "12px",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#334155", color: "#ffffff" }}>
                      <th style={{ padding: "8px 6px", width: "42px", textAlign: "center" }}>Row</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", minWidth: "260px" }}>Expense category</th>
                      <th style={{ padding: "8px 6px", textAlign: "center", width: "70px" }}>Del %</th>
                      {fyCols.map((cIdx) => (
                        <th
                          key={cIdx}
                          style={{
                            padding: "8px 6px",
                            textAlign: "right",
                            minWidth: "75px",
                            borderLeft: "1px solid #475569",
                          }}
                        >
                          {row0[cIdx]?.v || `M${cIdx}`}
                        </th>
                      ))}
                      <th
                        style={{
                          padding: "8px 8px",
                          textAlign: "right",
                          minWidth: "85px",
                          background: "#1e293b",
                          borderLeft: "1px solid #475569",
                        }}
                      >
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExpenseRows.map(({ sheetRow, row, hasContent }) => {
                      const name = row[0]?.v || "";
                      const delPct = row[4]?.v || "";

                      return (
                        <tr
                          key={sheetRow}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            background: hasContent ? "#ffffff" : "#fafafa",
                          }}
                        >
                          <td style={{ padding: "5px 4px", textAlign: "center", color: "#94a3b8", background: "#f8fafc" }}>
                            {sheetRow}
                          </td>

                          {/* Expense Name */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={0}
                            value={name}
                            align="left"
                            editableOpts={getEditableOpts(sheetRow, 0, name)}
                            note={row[0]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 0, `Cell note: ${name || "Expense"} (Name)`, `Row ${sheetRow}, Col A`)
                            }
                          />

                          {/* Del % */}
                          <EditableGridCell
                            sheetRow={sheetRow}
                            colIdx={4}
                            value={delPct}
                            align="center"
                            isPercent={true}
                            editableOpts={getEditableOpts(sheetRow, 4, delPct)}
                            note={row[4]?.note || ""}
                            onNoteClick={() =>
                              handleOpenNoteModal(sheetRow, 4, `Cell note: ${name || "Expense"} (Delivery %)`, `Row ${sheetRow}, Col E`)
                            }
                          />

                          {/* Monthly Columns (Editable) */}
                          {fyCols.map((cIdx, mIdx) => {
                            const cell = row[cIdx];
                            const opts = getEditableOpts(sheetRow, cIdx, cell?.v);
                            return (
                              <EditableGridCell
                                key={cIdx}
                                sheetRow={sheetRow}
                                colIdx={cIdx}
                                value={cell?.v}
                                align="right"
                                isCurrency={true}
                                editableOpts={opts}
                                note={cell?.note || ""}
                                onNoteClick={() =>
                                  handleOpenNoteModal(
                                    sheetRow,
                                    cIdx,
                                    `Cell note: ${name || "Expense"}`,
                                    `${monthHeaders[mIdx] || `Month ${mIdx + 1}`} (Row ${sheetRow}, Col ${colIndexToLetter(cIdx + 1)})`
                                  )
                                }
                              />
                            );
                          })}

                          {/* FY Total */}
                          <td
                            style={{
                              padding: "5px 8px",
                              textAlign: "right",
                              fontWeight: 700,
                              background: "#f8fafc",
                              borderLeft: "1px solid #e2e8f0",
                            }}
                          >
                            {row[totalCol]?.v || ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* SPREAD MODAL (FOR ROWS 5 & 13)                                        */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      {spreadModal.isOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "16px",
          }}
          onClick={() => !savingSpread && setSpreadModal({ isOpen: false, sheetRow: null, label: "", annualTotal: "" })}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "10px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              width: "100%",
              maxWidth: "480px",
              overflow: "hidden",
              border: "1px solid #cbd5e1",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: "16px 20px",
                background: "#0047AB",
                color: "#ffffff",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>
                Spread {spreadModal.label?.toLowerCase()}
              </h3>
              <button
                type="button"
                onClick={() => setSpreadModal({ isOpen: false, sheetRow: null, label: "", annualTotal: "" })}
                disabled={savingSpread}
                style={{
                  background: "none",
                  border: "none",
                  color: "#ffffff",
                  fontSize: "18px",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: "20px" }}>
              <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#475569" }}>
                Enter the full-year target amount for <strong>{activeFyLabel}</strong>. This will be spread evenly across all 12 months.
              </p>

              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "#1e293b",
                  marginBottom: "6px",
                }}
              >
                Annual target ({currencySymbol})
              </label>
              <input
                type="text"
                autoFocus
                placeholder="e.g. 240,000"
                value={spreadModal.annualTotal}
                onChange={(e) =>
                  setSpreadModal((prev) => ({ ...prev, annualTotal: e.target.value }))
                }
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  fontSize: "16px",
                  fontWeight: 600,
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  outline: "none",
                  boxSizing: "border-box",
                  marginBottom: "16px",
                }}
              />

              {/* Monthly Breakdown Preview */}
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  padding: "12px",
                  marginBottom: "20px",
                }}
              >
                <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "4px" }}>
                  Calculated monthly amount:
                </div>
                <div style={{ fontSize: "18px", fontWeight: 700, color: "#0047AB" }}>
                  {formatMoney(Math.round(parseNum(spreadModal.annualTotal) / 12))}
                  <span style={{ fontSize: "12px", fontWeight: 500, color: "#64748b", marginLeft: "6px" }}>
                    / month (12 months)
                  </span>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setSpreadModal({ isOpen: false, sheetRow: null, label: "", annualTotal: "" })}
                  disabled={savingSpread}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#475569",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingSpread || !spreadModal.annualTotal}
                  onClick={() => handleSpreadRow(spreadModal.sheetRow, spreadModal.annualTotal)}
                  style={{
                    padding: "8px 18px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#0047AB",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: savingSpread ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {savingSpread ? <Spinner size={14} color="#ffffff" /> : "⚡"} Apply spread
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cell Note Modal */}
      <CellNoteModal
        isOpen={Boolean(noteModalData)}
        title={noteModalData?.title || "Cell note"}
        subtitle={noteModalData?.subtitle || ""}
        initialNote={noteModalData?.initialNote || ""}
        onSave={handleSaveCellNote}
        onClose={() => setNoteModalData(null)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP TABLE EDITABLE MONTH CELL (ROWS 5 & 13)
// ─────────────────────────────────────────────────────────────────────────────
function EditableBudgetCell({
  value,
  displayValue,
  editableOpts,
  isHighlighted = false,
  align = "right",
  note = "",
  onNoteClick,
}) {
  if (!editableOpts || !editableOpts.isEditable) {
    return (
      <td
        style={{
          position: "relative",
          padding: "4px 4px",
          textAlign: align,
          fontSize: "11.5px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {displayValue}
        <CellNoteIndicator note={note} onClick={onNoteClick} />
      </td>
    );
  }

  const { isEditing, isSaving, editValue, onChangeEditValue, onCommitEdit, onStartEdit, onCancelEdit } = editableOpts;

  if (isSaving) {
    return (
      <td style={{ position: "relative", padding: "4px 4px", textAlign: align, background: "#fef9c3" }}>
        <Spinner size={12} color="#ca8a04" />
      </td>
    );
  }

  if (isEditing) {
    return (
      <td style={{ position: "relative", padding: "2px", textAlign: align, background: "#eff6ff" }}>
        <input
          type="text"
          value={editValue}
          autoFocus
          onChange={(e) => onChangeEditValue(e.target.value)}
          onBlur={() => onCommitEdit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
            if (e.key === "Enter") onCommitEdit();
          }}
          style={{
            width: "100%",
            fontSize: "11.5px",
            padding: "2px 4px",
            border: "1px solid #3b82f6",
            borderRadius: "3px",
            textAlign: align,
            boxSizing: "border-box",
            outline: "none",
            fontWeight: 600,
          }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={onStartEdit}
      title="Click to edit cell amount"
      style={{
        position: "relative",
        padding: "3px 4px",
        textAlign: align,
        fontSize: "11.5px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        background: isHighlighted ? "#f0f7ff" : "transparent",
        border: isHighlighted ? "1px dashed #bfdbfe" : "none",
        borderRadius: "3px",
        transition: "all 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#dbeafe";
        e.currentTarget.style.borderColor = "#60a5fa";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = isHighlighted ? "#f0f7ff" : "transparent";
        e.currentTarget.style.borderColor = isHighlighted ? "#bfdbfe" : "transparent";
      }}
    >
      {displayValue}
      <CellNoteIndicator note={note} onClick={onNoteClick} showAddOnHover={Boolean(editableOpts?.isEditable)} />
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SECTIONS GRID CELL COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function EditableGridCell({
  sheetRow,
  colIdx,
  value,
  align = "left",
  isCurrency = false,
  isPercent = false,
  editableOpts,
  note = "",
  onNoteClick,
}) {
  if (!editableOpts || !editableOpts.isEditable) {
    return (
      <td
        style={{
          position: "relative",
          padding: "5px 8px",
          textAlign: align,
          fontSize: "12px",
          borderRight: "1px solid #f1f5f9",
          whiteSpace: "nowrap",
        }}
      >
        {value ?? ""}
        <CellNoteIndicator note={note} onClick={onNoteClick} />
      </td>
    );
  }

  const { isEditing, isSaving, editValue, onChangeEditValue, onCommitEdit, onStartEdit, onCancelEdit } = editableOpts;

  if (isSaving) {
    return (
      <td style={{ position: "relative", padding: "5px 8px", textAlign: align, background: "#fef9c3", borderRight: "1px solid #fde047" }}>
        <Spinner size={12} color="#ca8a04" />
      </td>
    );
  }

  if (isEditing) {
    return (
      <td style={{ position: "relative", padding: "2px", textAlign: align, background: "#eff6ff" }}>
        <input
          type="text"
          value={editValue}
          autoFocus
          onChange={(e) => onChangeEditValue(e.target.value)}
          onBlur={() => onCommitEdit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelEdit();
            if (e.key === "Enter") onCommitEdit();
          }}
          style={{
            width: "100%",
            fontSize: "12px",
            padding: "3px 5px",
            border: "1px solid #3b82f6",
            borderRadius: "3px",
            textAlign: align,
            boxSizing: "border-box",
            outline: "none",
          }}
        />
      </td>
    );
  }

  return (
    <td
      onClick={onStartEdit}
      title="Click to edit cell"
      style={{
        position: "relative",
        padding: "5px 8px",
        textAlign: align,
        fontSize: "12px",
        borderRight: "1px solid #f1f5f9",
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: value ? "transparent" : "#fafafa",
        transition: "background 0.1s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#eff6ff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = value ? "transparent" : "#fafafa";
      }}
    >
      {value ?? ""}
      <CellNoteIndicator note={note} onClick={onNoteClick} showAddOnHover={Boolean(editableOpts?.isEditable)} />
    </td>
  );
}
