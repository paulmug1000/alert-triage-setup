import { useEffect } from "react";

const EXPLICIT_MODAL_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  ".modal-overlay",
  ".deep-dive-backdrop",
  ".deep-dive-popover",
  ".pma-assign-overlay-backdrop"
].join(", ");

function isElementVisible(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  return true;
}

function getOpenModals() {
  if (typeof document === "undefined" || !document.body) return [];
  const found = new Set();

  // 1. Explicit modal/popover classes and ARIA attributes
  const explicitNodes = document.body.querySelectorAll(EXPLICIT_MODAL_SELECTOR);
  explicitNodes.forEach((node) => {
    if (isElementVisible(node)) {
      found.add(node);
    }
  });

  // 2. Inline fixed viewport-covering overlays (used across Pulse and PMA modals)
  const fixedCandidates = document.body.querySelectorAll(
    'div[style*="position: fixed"], div[style*="position:fixed"]'
  );
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  fixedCandidates.forEach((node) => {
    if (found.has(node) || !isElementVisible(node)) return;
    const style = window.getComputedStyle(node);
    if (style.position !== "fixed" || style.pointerEvents === "none") return;
    const zIdx = parseInt(style.zIndex, 10);
    if (!isNaN(zIdx) && zIdx < 50) return;

    const rect = node.getBoundingClientRect();
    if (
      rect.top <= 10 &&
      rect.left <= 10 &&
      rect.width >= vw * 0.75 &&
      rect.height >= vh * 0.75
    ) {
      found.add(node);
    }
  });

  return Array.from(found);
}

function canElementScrollY(el, deltaY) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const isScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay" || el.tagName === "TEXTAREA";
  if (!isScrollable) return false;
  el.style.overscrollBehavior = "contain";
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  return true;
}

function canElementScrollX(el, deltaX) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const style = window.getComputedStyle(el);
  const overflowX = style.overflowX;
  const isScrollable = overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
  if (!isScrollable) return false;
  el.style.overscrollBehavior = "contain";
  if (deltaX < 0) return el.scrollLeft > 0;
  if (deltaX > 0) return el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return true;
}

/**
 * Universal hook that locks background page scrolling whenever any modal or popover
 * is open in either Pulse Portal or PMA, while preserving smooth scrolling inside
 * the modal's own scrollable containers.
 */
export function useModalScrollLock() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let isLocked = false;
    let prevBodyOverflow = "";
    let prevHtmlOverflow = "";
    let prevBodyOverscroll = "";
    let prevHtmlOverscroll = "";

    const applyLockState = () => {
      const openModals = getOpenModals();
      const shouldLock = openModals.length > 0;

      if (shouldLock && !isLocked) {
        prevBodyOverflow = document.body.style.overflow;
        prevHtmlOverflow = document.documentElement.style.overflow;
        prevBodyOverscroll = document.body.style.overscrollBehavior;
        prevHtmlOverscroll = document.documentElement.style.overscrollBehavior;

        document.body.style.overflow = "hidden";
        document.documentElement.style.overflow = "hidden";
        document.body.style.overscrollBehavior = "none";
        document.documentElement.style.overscrollBehavior = "none";
        isLocked = true;
      } else if (!shouldLock && isLocked) {
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
        document.body.style.overscrollBehavior = prevBodyOverscroll;
        document.documentElement.style.overscrollBehavior = prevHtmlOverscroll;
        isLocked = false;
      }
    };

    const handleWheel = (e) => {
      const openModals = getOpenModals();
      if (openModals.length === 0) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) {
        e.preventDefault();
        return;
      }

      const containingModals = openModals.filter((m) => m.contains(target));
      if (containingModals.length === 0) {
        // Wheel occurred outside the open modal/popover (e.g. on the background page while a popover is open)
        e.preventDefault();
        return;
      }

      const modalRoot = containingModals[containingModals.length - 1];
      const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);

      let node = target;
      while (node && node !== document.body && node !== document.documentElement) {
        if (isHorizontal ? canElementScrollX(node, e.deltaX) : canElementScrollY(node, e.deltaY)) {
          return; // Allow normal scroll inside the modal's scrollable container
        }
        if (node === modalRoot) break;
        node = node.parentElement;
      }

      // No container inside the modal can scroll further in this direction -> block scroll-chaining to background page
      e.preventDefault();
    };

    const handleTouchMove = (e) => {
      const openModals = getOpenModals();
      if (openModals.length === 0) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) {
        e.preventDefault();
        return;
      }

      const containingModals = openModals.filter((m) => m.contains(target));
      if (containingModals.length === 0) {
        e.preventDefault();
        return;
      }

      const modalRoot = containingModals[containingModals.length - 1];
      let node = target;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const canY =
          node.scrollHeight > node.clientHeight + 1 &&
          (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay" || node.tagName === "TEXTAREA");
        const canX =
          node.scrollWidth > node.clientWidth + 1 &&
          (style.overflowX === "auto" || style.overflowX === "scroll" || style.overflowX === "overlay");
        if (canY || canX) {
          node.style.overscrollBehavior = "contain";
          return;
        }
        if (node === modalRoot) break;
        node = node.parentElement;
      }

      e.preventDefault();
    };

    applyLockState();

    const observer = new MutationObserver(() => {
      applyLockState();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"]
    });

    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });

    return () => {
      observer.disconnect();
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("touchmove", handleTouchMove);
      if (isLocked) {
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
        document.body.style.overscrollBehavior = prevBodyOverscroll;
        document.documentElement.style.overscrollBehavior = prevHtmlOverscroll;
      }
    };
  }, []);
}

