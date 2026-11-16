import React, { useState, useEffect, useRef, useTransition, useCallback, forwardRef } from "react";
import Spinner from "./Spinner";

const LAYOUT_STYLE_KEYS = new Set([
  "width",
  "minWidth",
  "maxWidth",
  "flex",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
]);

function expandPaddingStyles(inputStyle) {
  if (!inputStyle || inputStyle.padding === undefined || inputStyle.paddingRight !== undefined) {
    return inputStyle;
  }
  const parts = String(inputStyle.padding).trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p.includes("("))) {
    return inputStyle;
  }
  const [pTop, pRight, pBottom, pLeft] =
    parts.length === 1
      ? [parts[0], parts[0], parts[0], parts[0]]
      : parts.length === 2
      ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3
      ? [parts[0], parts[1], parts[2], parts[1]]
      : parts;
  const next = { ...inputStyle };
  delete next.padding;
  next.paddingTop = next.paddingTop ?? pTop;
  next.paddingRight = pRight;
  next.paddingBottom = next.paddingBottom ?? pBottom;
  next.paddingLeft = next.paddingLeft ?? pLeft;
  return next;
}
function splitLayoutAndInputStyles(style) {
  if (!style || typeof style !== "object") {
    return { layoutStyle: {}, inputStyle: {} };
  }
  const layoutStyle = {};
  const inputStyle = {};
  Object.keys(style).forEach((key) => {
    if (LAYOUT_STYLE_KEYS.has(key)) {
      layoutStyle[key] = style[key];
    } else {
      inputStyle[key] = style[key];
    }
  });
  return { layoutStyle, inputStyle };
}

/**
 * DeferredSearchInput
 *
 * Isolates keystroke state locally so typing in any search/filter bar updates
 * the input field on the current frame (0ms lag) while debouncing and wrapping
 * parent filter state updates in React's `useTransition`.
 * Displays an inline spinner whenever filtering is queued or transitioning.
 */
const DeferredSearchInput = forwardRef(function DeferredSearchInput(
  {
    value = "",
    onChange,
    onValueChange,
    onKeyDown,
    debounceMs = 150,
    bare = false,
    showClearButton = false,
    clearOnEscape = true,
    spinnerSize = 13,
    spinnerColor = "#3b82f6",
    spinnerRight = "10px",
    clearButtonTitle = "Clear search",
    wrapperStyle = {},
    wrapperClassName = "",
    style = {},
    renderRight = null,
    type = "text",
    ...rest
  },
  ref
) {
  const normalizedPropValue = value !== null && value !== undefined ? String(value) : "";
  const [localValue, setLocalValue] = useState(normalizedPropValue);
  const [isPending, startTransition] = useTransition();

  const timerRef = useRef(null);
  const committedQueueRef = useRef([]);
  const lastPropValueRef = useRef(normalizedPropValue);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearPendingTimer();
  }, [clearPendingTimer]);

  // Sync external prop changes (e.g. parent "Clear" button or client/tab switch)
  useEffect(() => {
    if (normalizedPropValue === lastPropValueRef.current) return;
    lastPropValueRef.current = normalizedPropValue;

    const queue = committedQueueRef.current;
    const matchIdx = queue.indexOf(normalizedPropValue);
    if (matchIdx !== -1) {
      committedQueueRef.current = queue.slice(matchIdx + 1);
      return;
    }

    // Genuine external update from parent
    clearPendingTimer();
    committedQueueRef.current = [];
    setLocalValue(normalizedPropValue);
  }, [normalizedPropValue, clearPendingTimer]);

  const commitValue = useCallback(
    (nextVal) => {
      committedQueueRef.current.push(nextVal);
      if (committedQueueRef.current.length > 25) {
        committedQueueRef.current = committedQueueRef.current.slice(-10);
      }
      startTransition(() => {
        if (onChange) {
          onChange({ target: { value: nextVal }, currentTarget: { value: nextVal } });
        }
        if (onValueChange) {
          onValueChange(nextVal);
        }
      });
    },
    [onChange, onValueChange]
  );

  const handleInputChange = useCallback(
    (e) => {
      const nextVal = e.target.value;
      setLocalValue(nextVal);
      clearPendingTimer();

      if (nextVal === "" || debounceMs <= 0) {
        commitValue(nextVal);
      } else {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          commitValue(nextVal);
        }, debounceMs);
      }
    },
    [clearPendingTimer, commitValue, debounceMs]
  );

  const handleClear = useCallback(
    (e) => {
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      clearPendingTimer();
      setLocalValue("");
      commitValue("");
    },
    [clearPendingTimer, commitValue]
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Escape" && clearOnEscape && localValue) {
        e.preventDefault();
        e.stopPropagation();
        clearPendingTimer();
        setLocalValue("");
        commitValue("");
      } else if (e.key === "Enter" && timerRef.current !== null) {
        clearPendingTimer();
        commitValue(localValue);
      }
      if (onKeyDown) {
        onKeyDown(e);
      }
    },
    [clearOnEscape, localValue, clearPendingTimer, commitValue, onKeyDown]
  );

  const isFiltering = Boolean(localValue !== normalizedPropValue || isPending);

  const renderAdornments = () => {
    if (typeof renderRight === "function") {
      return renderRight({
        localValue,
        committedValue: normalizedPropValue,
        isFiltering,
        clear: handleClear,
      });
    }

    const showClear = Boolean(showClearButton && localValue);
    if (!isFiltering && !showClear) return null;

    return (
      <div
        style={{
          position: "absolute",
          right: spinnerRight,
          top: "50%",
          transform: "translateY(-50%)",
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          pointerEvents: showClear ? "auto" : "none",
          zIndex: 2,
        }}
      >
        {isFiltering && (
          <Spinner
            size={spinnerSize}
            color={spinnerColor}
            style={{ marginRight: 0 }}
          />
        )}
        {showClear && (
          <button
            type="button"
            onClick={handleClear}
            title={clearButtonTitle}
            aria-label={clearButtonTitle}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: "13px",
              lineHeight: 1,
              padding: "1px 2px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ✕
          </button>
        )}
      </div>
    );
  };

  if (bare) {
    return (
      <>
        <input
          ref={ref}
          type={type}
          value={localValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          style={style}
          {...rest}
        />
        {renderAdornments()}
      </>
    );
  }

  const { layoutStyle, inputStyle } = splitLayoutAndInputStyles(style);
  const hasExplicitPaddingRight = inputStyle.paddingRight !== undefined;
  const expandedInputStyle = expandPaddingStyles(inputStyle);
  const needsRightAdornmentSpace = Boolean(
    renderRight || isFiltering || (showClearButton && localValue)
  );
  const mergedInputStyle = {
    boxSizing: "border-box",
    ...expandedInputStyle,
    width: "100%",
    ...(needsRightAdornmentSpace && !hasExplicitPaddingRight && expandedInputStyle.padding === undefined
      ? {
          paddingRight:
            isFiltering && showClearButton && localValue ? "44px" : "28px",
        }
      : {}),
  };

  return (
    <div
      className={wrapperClassName || undefined}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        boxSizing: "border-box",
        ...layoutStyle,
        ...wrapperStyle,
      }}
    >
      <input
        ref={ref}
        type={type}
        value={localValue}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        style={mergedInputStyle}
        {...rest}
      />
      {renderAdornments()}
    </div>
  );
});

export default DeferredSearchInput;
