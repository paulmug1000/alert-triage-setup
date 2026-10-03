import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <link rel="apple-touch-icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Kumbh+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body style={{ margin: 0, padding: 0, background: "#ffffff" }}>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
