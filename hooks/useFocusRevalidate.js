import { useEffect, useRef, useCallback } from "react";

/**
 * Silently revalidates screen data when the user returns to the browser tab/window
 * after more than `staleAfterMs` (default 30s), provided no active edits, modals,
 * or in-flight saves/fetches are occurring.
 */
export function useFocusRevalidate({
  enabled = true,
  staleAfterMs = 30000,
  canRevalidate,
  onRevalidate,
  resetKey,
}) {
  const canRevalidateRef = useRef(canRevalidate);
  canRevalidateRef.current = canRevalidate;

  const onRevalidateRef = useRef(onRevalidate);
  onRevalidateRef.current = onRevalidate;

  const lastRevalidatedAtRef = useRef(Date.now());

  useEffect(() => {
    lastRevalidatedAtRef.current = Date.now();
  }, [resetKey]);

  const markFresh = useCallback(() => {
    lastRevalidatedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;

    const handleFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (now - lastRevalidatedAtRef.current < staleAfterMs) {
        return;
      }
      if (canRevalidateRef.current && !canRevalidateRef.current()) {
        return;
      }
      lastRevalidatedAtRef.current = now;
      onRevalidateRef.current?.();
    };

    window.addEventListener("focus", handleFocusOrVisible);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleFocusOrVisible);
    }

    return () => {
      window.removeEventListener("focus", handleFocusOrVisible);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleFocusOrVisible);
      }
    };
  }, [enabled, staleAfterMs]);

  return { markFresh };
}
