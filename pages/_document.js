import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <link rel="apple-touch-icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0047AB" />
        <meta name="description" content="Pulse - the agency finance dashboard" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Pulse" />
        <meta property="og:title" content="Pulse" />
        <meta property="og:description" content="The agency finance dashboard" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Pulse" />
        <meta name="twitter:description" content="The agency finance dashboard" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Kumbh+Sans:wght@300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `html, body, *, *::before, *::after { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }`,
          }}
        />
      </Head>
      <body style={{ margin: 0, padding: 0, background: "#ffffff", WebkitTextSizeAdjust: "100%", textSizeAdjust: "100%" }}>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
