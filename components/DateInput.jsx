import React from "react";
import {
  toInputDateFormat,
  toSheetDateFormat,
  isValidCalendarIsoDate,
  MIN_INPUT_DATE,
  MAX_INPUT_DATE,
} from "../utils/helpers";

/**
 * Universal DateInput component for Pulse and the PMA.
 * Renders a calendar picker (<input type="date">) capped to 4-digit years (1900–2099)
 * so ONLY valid calendar dates can be entered or committed.
 * Supports `outputFormat="sheet"` (default, "d-Mmm-yy") or `outputFormat="iso"` ("YYYY-MM-DD").
 */
export default function DateInput({
  value = "",
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  onInvalidDate,
  outputFormat = "sheet",
  style = {},
  className = "",
  placeholder = "",
  disabled = false,
  readOnly = false,
  min,
  max,
  id,
  name,
  required = false,
  title,
  ...rest
}) {
  const inputRef = React.useRef(null);
  const isFocusedRef = React.useRef(false);
  const isoValue = React.useMemo(() => toInputDateFormat(value), [value]);

  const effectiveMin = React.useMemo(() => {
    const parsed = min ? toInputDateFormat(min) : "";
    return parsed && isValidCalendarIsoDate(parsed) ? parsed : MIN_INPUT_DATE;
  }, [min]);

  const effectiveMax = React.useMemo(() => {
    const parsed = max ? toInputDateFormat(max) : "";
    return parsed && isValidCalendarIsoDate(parsed) ? parsed : MAX_INPUT_DATE;
  }, [max]);

  React.useEffect(() => {
    if (inputRef.current && !isFocusedRef.current) {
      inputRef.current.value = isoValue;
    }
  }, [isoValue]);

  const formatForOutput = (rawIso) => {
    if (!rawIso) return "";
    return outputFormat === "iso" ? rawIso : toSheetDateFormat(rawIso);
  };

  const emitFormatted = (e, rawVal) => {
    const formatted = formatForOutput(rawVal);

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
    if (rawVal === "") {
      if (e.target.validity?.badInput) {
        return;
      }
      emitFormatted(e, "");
      return;
    }
    if (!isValidCalendarIsoDate(rawVal)) {
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
    const el = inputRef.current;
    const rawVal = el ? el.value : e.target.value;
    const isBadInput = Boolean(el?.validity?.badInput);

    if (isBadInput || (rawVal && !isValidCalendarIsoDate(rawVal))) {
      if (el) el.value = isoValue;
      if (onInvalidDate) onInvalidDate(rawVal);
      if (onBlur) onBlur(e);
      return;
    }

    const currentFormatted = formatForOutput(isoValue);
    const nextFormatted = formatForOutput(rawVal);
    if (nextFormatted !== currentFormatted) {
      emitFormatted(e, rawVal);
    }
    if (el) {
      el.value = rawVal || "";
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
      readOnly={readOnly}
      required={required}
      title={title}
      placeholder={placeholder}
      min={effectiveMin}
      max={effectiveMax}
      defaultValue={isoValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyDown={onKeyDown}
      className={className}
      {...rest}
      style={{
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
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
