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
  const isoValue = React.useMemo(() => toInputDateFormat(value), [value]);
  const isoMin = React.useMemo(() => (min ? toInputDateFormat(min) : undefined), [min]);
  const isoMax = React.useMemo(() => (max ? toInputDateFormat(max) : undefined), [max]);

  const handleChange = (e) => {
    const rawVal = e.target.value;
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

  return (
    <input
      type="date"
      id={id}
      name={name}
      disabled={disabled}
      required={required}
      title={title}
      placeholder={placeholder}
      min={isoMin}
      max={isoMax}
      value={isoValue}
      onChange={handleChange}
      onBlur={onBlur}
      onFocus={onFocus}
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
