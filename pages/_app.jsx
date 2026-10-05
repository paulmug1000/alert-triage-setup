import React, { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Spinner from "../components/Spinner";

export default function App({ Component, pageProps }) {
  const router = useRouter();
  const [isRouteChanging, setIsRouteChanging] = useState(false);

  // Unified route transition loading state between Pulse and PMA
  useEffect(() => {
    const handleStart = (url) => {
      const cleanTarget = String(url || "").split("?")[0];
      const cleanCurrent = String(router.asPath || "").split("?")[0];
      if (cleanTarget !== cleanCurrent) {
        setIsRouteChanging(true);
      }
    };
    const handleComplete = () => setIsRouteChanging(false);
    const handleError = () => setIsRouteChanging(false);

    router.events.on("routeChangeStart", handleStart);
    router.events.on("routeChangeComplete", handleComplete);
    router.events.on("routeChangeError", handleError);

    return () => {
      router.events.off("routeChangeStart", handleStart);
      router.events.off("routeChangeComplete", handleComplete);
      router.events.off("routeChangeError", handleError);
    };
  }, [router]);

  // Universal button feedback across Pulse and PMA:
  // Adds physical press animation and in-button spinner on click indicating the action is happening
  useEffect(() => {
    const handleButtonClick = (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;

      // Never apply universal user feedback (spinner or animation) to the menu bar in either PMA or Pulse
      const isMenuBar = Boolean(
        btn.closest("header") ||
        btn.closest("nav") ||
        btn.closest(".pma-topbar") ||
        btn.closest(".pma-navbar") ||
        btn.closest(".portal-header-bar-inner") ||
        btn.closest(".portal-nav-dropdown") ||
        btn.closest(".nav-more-dropdown") ||
        btn.closest(".pma-pulse-dropdown") ||
        btn.closest(".pma-profile-dropdown") ||
        btn.closest(".portal-mobile-menu") ||
        btn.classList.contains("pulse-nav-item") ||
        btn.classList.contains("nav-more-btn") ||
        btn.classList.contains("pma-pulse-btn") ||
        btn.classList.contains("pma-profile-btn") ||
        btn.classList.contains("no-click-spinner")
      );
      if (isMenuBar) return;

      btn.classList.add("pulse-btn-clicked");

      // Check if button already contains a spinner or loading icon
      const hasSpinner = btn.querySelector(".pulse-click-spinner, svg[class*='spin'], svg[style*='spin']");
      if (!hasSpinner && !btn.classList.contains("no-click-spinner")) {
        const isIconOnly = btn.textContent.trim().length === 0;
        const spinner = document.createElement("span");
        spinner.className = "pulse-click-spinner";

        if (isIconOnly) {
          spinner.setAttribute(
            "style",
            "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.35);border-radius:inherit;pointer-events:none;z-index:2;"
          );
          spinner.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="animation:pulse-spin 0.6s linear infinite;flex-shrink:0"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
        } else {
          spinner.setAttribute(
            "style",
            "display:inline-flex;align-items:center;vertical-align:middle;margin-left:6px;pointer-events:none;flex-shrink:0;"
          );
          spinner.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="animation:pulse-spin 0.6s linear infinite;flex-shrink:0"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
        }

        if (isIconOnly && window.getComputedStyle(btn).position === "static") {
          btn.style.position = "relative";
        }

        btn.appendChild(spinner);

        setTimeout(() => {
          spinner.remove();
          btn.classList.remove("pulse-btn-clicked");
        }, 650);
      } else {
        setTimeout(() => {
          btn.classList.remove("pulse-btn-clicked");
        }, 300);
      }
    };

    document.addEventListener("click", handleButtonClick, true);
    return () => document.removeEventListener("click", handleButtonClick, true);
  }, []);

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
      </Head>
      <style jsx global>{`
        *, *::before, *::after {
          box-sizing: border-box;
        }
        html {
          overflow-y: scroll;
          scrollbar-gutter: stable;
        }
        html, body {
          margin: 0;
          padding: 0;
          background-color: #ffffff;
          font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          overflow-x: hidden;
        }
        button {
          transition: transform 0.1s ease, filter 0.15s ease;
        }
        button:active:not(:disabled) {
          transform: scale(0.97);
          filter: brightness(0.92);
        }
        .pulse-btn-clicked {
          filter: brightness(0.95);
        }
        header button,
        nav button,
        .pma-topbar button,
        .pma-navbar button,
        .pulse-nav-item,
        .portal-header-bar-inner button,
        .portal-nav-dropdown button,
        .nav-more-dropdown button,
        .pma-pulse-dropdown button,
        .pma-profile-dropdown button,
        .portal-mobile-menu button {
          transform: none !important;
          filter: none !important;
        }
        .portal-scroll-x {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: thin;
        }
        @keyframes triage-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes pulse-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
      `}</style>
      {isRouteChanging && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(255, 255, 255, 0.96)",
            zIndex: 99999,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
          }}
        >
          <Spinner size={36} color="#0047AB" />
          <span style={{ color: "#0047AB", fontWeight: 600, fontSize: "15px", letterSpacing: "0.2px" }}>
            Please wait - loading
          </span>
        </div>
      )}
      <Component {...pageProps} />
    </>
  );
}
