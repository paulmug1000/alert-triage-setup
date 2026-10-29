import React from "react";
import { toInputDateFormat, toSheetDateFormat } from "../utils/helpers";

/**
 * Universal DateInput component for the PMA.
 * Renders a calendar picker (<input type="date">) so ONLY valid dates can be entered.
 * Handles dates seamlessly whether passed as "d-Mmm-yy" (e.g. "1-Jan-25", "15-Oct-26"),
 * ISO "YYYY-MM-DD", or other formats.
 * When a user selects a date, formats the value to "d-Mmm-yy" and invokes onChange.
 */
export default function DateInput({
  value = "",
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  style = {},
  className = "",
  placeholder = "",
  disabled = false,
  min,
  max,
  id,
  name,
  required = false,
  title,
}) {
  const inputRef = React.useRef(null);
  const isFocusedRef = React.useRef(false);
  const isoValue = React.useMemo(() => toInputDateFormat(value), [value]);
  const isoMin = React.useMemo(() => (min ? toInputDateFormat(min) : undefined), [min]);
  const isoMax = React.useMemo(() => (max ? toInputDateFormat(max) : undefined), [max]);

  React.useEffect(() => {
    if (inputRef.current && !isFocusedRef.current) {
      inputRef.current.value = isoValue;
    }
  }, [isoValue]);

  const emitFormatted = (e, rawVal) => {
    const formatted = rawVal ? toSheetDateFormat(rawVal) : "";

    const synthEvent = {
      ...e,
      target: {
        ...(e?.target || {}),
        name: name || e?.target?.name || "",
        value: formatted,
      },
    };

    synthEvent.toString = () => formatted;
    synthEvent.valueOf = () => formatted;

    if (onChange) {
      onChange(synthEvent, formatted);
    }
  };

  const handleChange = (e) => {
    const rawVal = e.target.value;
    // While typing a 4-digit year in Chromium (e.g. "0002-11-01", "0020-11-01", "0202-11-01"),
    // do not round-trip partial years (< 1000) through 2-digit sheet dates mid-keystroke.
    if (rawVal && /^0\d{3}-/.test(rawVal)) {
      return;
    }
    emitFormatted(e, rawVal);
  };

  const handleFocus = (e) => {
    isFocusedRef.current = true;
    if (onFocus) onFocus(e);
  };

  const handleBlur = (e) => {
    isFocusedRef.current = false;
    const rawVal = e.target.value;
    const currentFormatted = value ? toSheetDateFormat(value) : "";
    const nextFormatted = rawVal ? toSheetDateFormat(rawVal) : "";
    if (nextFormatted !== currentFormatted) {
      emitFormatted(e, rawVal);
    }
    if (inputRef.current) {
      inputRef.current.value = rawVal ? toInputDateFormat(nextFormatted) : "";
    }
    if (onBlur) onBlur(e);
  };

  return (
    <input
      ref={inputRef}
      type="date"
      id={id}
      name={name}
      disabled={disabled}
      required={required}
      title={title}
      placeholder={placeholder}
      min={isoMin}
      max={isoMax}
      defaultValue={isoValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyDown={onKeyDown}
      className={className}
      style={{
        width: "100%",
        padding: "7px 9px",
        border: "1px solid #cbd5e1",
        borderRadius: "5px",
        fontSize: "13px",
        color: "#1e293b",
        backgroundColor: disabled ? "#f8fafc" : "#ffffff",
        boxSizing: "border-box",
        fontFamily: "inherit",
        ...style,
      }}
    />
  );
}
