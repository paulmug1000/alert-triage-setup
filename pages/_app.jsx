import React, { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Spinner from "../components/Spinner";
import { AppGlobalsProvider } from "../hooks/useAppGlobals";

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
        html, body, button, input, select, textarea {
          font-family: 'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        html, body {
          margin: 0;
          padding: 0;
          background-color: #ffffff;
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
        .portal-mobile-menu button,
        .client-views-tabs button,
        .client-views-tab,
        .edit-client-card-btn,
        .triage-client-card,
        .refresh-btn {
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
        @keyframes pulse-calm-breathe {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.35;
          }
        }
        .pulse-skeleton {
          position: relative;
          background-color: #e2e8f0 !important;
          animation: pulse-calm-breathe 1.8s ease-in-out infinite !important;
        }
        .pulse-skeleton.pulse-skeleton-blue {
          background-color: #dbeafe !important;
        }
        .pulse-skeleton.pulse-skeleton-dark {
          background-color: rgba(255, 255, 255, 0.35) !important;
        }
      `}</style>
      <AppGlobalsProvider>
        <Component {...pageProps} />
      </AppGlobalsProvider>
    </>
  );
}
