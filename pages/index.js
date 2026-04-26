import Head from "next/head";
import MainMenu from "./menu";

export default function Index() {
  return (
    <>
      <Head>
        <title>Pulse Triage System</title>
        <link rel="icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <link rel="apple-touch-icon" href="https://pulsedashboard.co.uk/wp-content/uploads/2026/03/pulsefavicon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Pulse Triage" />
      </Head>
      <MainMenu />
    </>
  );
}