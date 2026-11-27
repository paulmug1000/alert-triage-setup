import React, { useMemo, useState, useEffect } from "react";
import SplitMonthCard from "./SplitMonthCard";
import {
  parseSplitString,
  formatSplitString,
  extractSplitMonths,
  generateMonthSpan,
  parseMonthLabel,
} from "../services/splitHelper";

const MONTH_OPTIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function getYearOptions(centerYear) {
  const base = centerYear || new Date().getFullYear();
  const years = [];
  for (let y = base - 2; y <= base + 4; y++) years.push(y);
  return years;
}

function addMonths(label, offset) {
  const p = parseMonthLabel(label) || parseMonthLabel(new Date());
  const d = new Date(p.year, p.monthIdx + offset, 1);
  return `${MONTH_OPTIONS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

function MonthYearPicker({ value, onChange, disabled, compact }) {
  const parsed = parseMonthLabel(value) || parseMonthLabel(new Date());
  const years = getYearOptions(parsed.year);
  const selectStyle = {
    padding: compact ? "4px 6px" : "5px 8px",
    fontSize: "12px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    background: disabled ? "#f8fafc" : "#ffffff",
    color: "#0f172a",
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <select
        value={MONTH_OPTIONS[parsed.monthIdx]}
        disabled={disabled}
        onChange={(e) => onChange(`${e.target.value}-${String(parsed.year).slice(-2)}`)}
        style={selectStyle}
        aria-label="Select month"
      >
        {MONTH_OPTIONS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <select
        value={parsed.year}
        disabled={disabled}
        onChange={(e) => onChange(`${MONTH_OPTIONS[parsed.monthIdx]}-${String(e.target.value).slice(-2)}`)}
        style={selectStyle}
        aria-label="Select year"
      >
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * Three-state recharged expense cost timing control for confirmed invoices:
 * - Same as invoice month ("")
 * - Single month ("Feb-27")
 * - Split across months ("[Split],Feb-27:1500,Mar-27:1500")
 */
export default function InvoiceCostMonthControl({
  value = "",
  onChange,
  totalAmount = 0,
  invoiceSentDate = "",
  jobStartDate = "",
  currencySymbol = "£",
  disabled = false,
  compact = false,
}) {
  const trimmedVal = String(value || "").trim();
  const isSplitVal = trimmedVal.toLowerCase().startsWith("[split]");
  const mode = !trimmedVal ? "same" : isSplitVal ? "split" : "single";

  const defaultBaseMonth = useMemo(() => {
    return (
      parseMonthLabel(invoiceSentDate)?.label ||
      parseMonthLabel(jobStartDate)?.label ||
      parseMonthLabel(new Date()).label
    );
  }, [invoiceSentDate, jobStartDate]);

  const parsedSplitEntries = useMemo(() => (isSplitVal ? extractSplitMonths(trimmedVal) : []), [isSplitVal, trimmedVal]);

  const [spanStart, setSpanStart] = useState(() =>
    parsedSplitEntries[0]?.month || defaultBaseMonth
  );
  const [spanEnd, setSpanEnd] = useState(() =>
    parsedSplitEntries[parsedSplitEntries.length - 1]?.month || addMonths(defaultBaseMonth, 1)
  );
  const [lockedMap, setLockedMap] = useState(() => {
    if (!isSplitVal) return {};
    const mLabels = parsedSplitEntries.map((e) => e.month);
    return parseSplitString(trimmedVal, mLabels, Number(totalAmount) || 0);
  });

  useEffect(() => {
    if (isSplitVal && parsedSplitEntries.length > 0) {
      const mLabels = parsedSplitEntries.map((e) => e.month);
      setSpanStart(mLabels[0]);
      setSpanEnd(mLabels[mLabels.length - 1]);
      setLockedMap(parseSplitString(trimmedVal, mLabels, Number(totalAmount) || 0));
    } else if (!trimmedVal) {
      setLockedMap({});
    }
  }, [trimmedVal, isSplitVal, parsedSplitEntries, totalAmount]);

  const splitMonths = useMemo(() => {
    if (mode !== "split") return [];
    const span = generateMonthSpan(spanStart, spanEnd);
    return span.length > 0 ? span : generateMonthSpan(defaultBaseMonth, 2);
  }, [mode, spanStart, spanEnd, defaultBaseMonth]);

  const numericTotal = Math.max(0, Number(totalAmount) || 0);

  const commitSplitState = (nextMonths, nextLocked) => {
    if (!nextMonths || nextMonths.length === 0) return;
    const validKeys = new Set(nextMonths.map((m) => m.toLowerCase()));
    const validLocked = {};
    let lockedSum = 0;
    let lockedCount = 0;
    for (const [k, v] of Object.entries(nextLocked || {})) {
      if (validKeys.has(k) && v !== undefined && v !== null && !isNaN(v)) {
        validLocked[k] = v;
        lockedSum += v;
        lockedCount++;
      }
    }
    const unlockedCount = Math.max(0, nextMonths.length - lockedCount);
    const remaining = Math.max(0, numericTotal - lockedSum);
    const evenSplit = unlockedCount > 0 ? remaining / unlockedCount : 0;
    onChange(formatSplitString(nextMonths, validLocked, evenSplit, { omitAutoTag: true }));
  };

  const handleModeChange = (nextMode) => {
    if (disabled) return;
    if (nextMode === "same") {
      setLockedMap({});
      onChange("");
    } else if (nextMode === "single") {
      setLockedMap({});
      const currentSingle = !isSplitVal && trimmedVal ? parseMonthLabel(trimmedVal)?.label : null;
      onChange(currentSingle || defaultBaseMonth);
    } else if (nextMode === "split") {
      const s = defaultBaseMonth;
      const e = addMonths(s, 1);
      setSpanStart(s);
      setSpanEnd(e);
      setLockedMap({});
      const initMonths = generateMonthSpan(s, e);
      const evenSplit = initMonths.length > 0 ? numericTotal / initMonths.length : 0;
      onChange(formatSplitString(initMonths, {}, evenSplit, { omitAutoTag: true }));
    }
  };

  const handleCardCommit = (mKey, valOrNull) => {
    const nextLocked = { ...lockedMap };
    if (valOrNull === null) {
      delete nextLocked[mKey];
    } else {
      nextLocked[mKey] = Math.max(0, Math.round(valOrNull * 100) / 100);
    }
    setLockedMap(nextLocked);
    commitSplitState(splitMonths, nextLocked);
  };

  const splitSummary = useMemo(() => {
    if (mode !== "split" || splitMonths.length === 0) return null;
    const validKeys = new Set(splitMonths.map((m) => m.toLowerCase()));
    const validLocked = {};
    let lockedSum = 0;
    let lockedCount = 0;
    for (const [k, v] of Object.entries(lockedMap)) {
      if (validKeys.has(k) && v !== undefined && v !== null && !isNaN(v)) {
        validLocked[k] = v;
        lockedSum += v;
        lockedCount++;
      }
    }
    const unlockedCount = Math.max(0, splitMonths.length - lockedCount);
    const remaining = numericTotal - lockedSum;
    const evenSplit = unlockedCount > 0 ? Math.max(0, remaining) / unlockedCount : 0;
    const allocatedTotal = splitMonths.reduce((sum, m) => {
      const k = m.toLowerCase();
      return sum + (validLocked[k] !== undefined ? validLocked[k] : evenSplit);
    }, 0);
    const mismatch = Math.abs(allocatedTotal - numericTotal) > 0.02 || lockedSum > numericTotal + 0.02;
    return { validLocked, evenSplit, allocatedTotal, mismatch };
  }, [mode, splitMonths, lockedMap, numericTotal]);

  const inputStyle = {
    padding: compact ? "4px 8px" : "5px 8px",
    fontSize: "12px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    background: disabled ? "#f8fafc" : "#ffffff",
    color: "#0f172a",
    maxWidth: "100%",
    minWidth: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <select
          value={mode}
          disabled={disabled}
          onChange={(e) => handleModeChange(e.target.value)}
          style={inputStyle}
          aria-label="Cost month mode"
        >
          <option value="same">Same as invoice month ({defaultBaseMonth})</option>
          <option value="single">Single month</option>
          <option value="split">Split across months</option>
        </select>

        {mode === "single" && (
          <MonthYearPicker
            value={trimmedVal || defaultBaseMonth}
            disabled={disabled}
            compact={compact}
            onChange={(nextLabel) => onChange(nextLabel)}
          />
        )}
      </div>

      {mode === "split" && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontSize: "12px", color: "#475569" }}>
              <span>From</span>
              <MonthYearPicker
                value={spanStart}
                disabled={disabled}
                compact
                onChange={(nextStart) => {
                  const s = parseMonthLabel(nextStart);
                  const e = parseMonthLabel(spanEnd);
                  const safeEnd = s && e && (e.year * 12 + e.monthIdx) < (s.year * 12 + s.monthIdx) ? nextStart : spanEnd;
                  setSpanStart(nextStart);
                  if (safeEnd !== spanEnd) setSpanEnd(safeEnd);
                  const nextMonths = generateMonthSpan(nextStart, safeEnd);
                  commitSplitState(nextMonths, lockedMap);
                }}
              />
              <span>to</span>
              <MonthYearPicker
                value={spanEnd}
                disabled={disabled}
                compact
                onChange={(nextEnd) => {
                  const s = parseMonthLabel(spanStart);
                  const e = parseMonthLabel(nextEnd);
                  const safeEnd = s && e && (e.year * 12 + e.monthIdx) < (s.year * 12 + s.monthIdx) ? spanStart : nextEnd;
                  setSpanEnd(safeEnd);
                  const nextMonths = generateMonthSpan(spanStart, safeEnd);
                  commitSplitState(nextMonths, lockedMap);
                }}
              />
            </div>

            <div
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: splitSummary?.mismatch ? "#dc2626" : "#0369a1",
              }}
            >
              Allocated: {currencySymbol}
              {(splitSummary?.allocatedTotal || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              {" / "}
              {currencySymbol}
              {numericTotal.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(120px, 100%), 1fr))",
              gap: "8px",
            }}
          >
            {splitMonths.map((m) => {
              const mKey = m.toLowerCase();
              const isLocked = splitSummary?.validLocked[mKey] !== undefined;
              const rawVal = isLocked ? splitSummary.validLocked[mKey] : (splitSummary?.evenSplit || 0);
              const displayVal = Number.isInteger(rawVal) ? String(rawVal) : rawVal.toFixed(2);
              return (
                <SplitMonthCard
                  key={mKey}
                  month={m}
                  mKey={mKey}
                  isLocked={isLocked}
                  displayVal={displayVal}
                  currencySymbol={currencySymbol}
                  onCommit={handleCardCommit}
                />
              );
            })}
          </div>

          {splitSummary?.mismatch && (
            <div style={{ fontSize: "11px", color: "#dc2626", fontWeight: 500 }}>
              Locked month amounts do not equal {currencySymbol}
              {numericTotal.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Unlock a month or adjust amounts to match.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
