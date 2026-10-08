import Head from "next/head";
import TriageSystem from "./triage";

export default function Index() {
  return (
    <>
      <Head>
        <title>PMA - Pulse Management Area</title>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Pulse Management Area" />
      </Head>
      <TriageSystem onBack={() => { }} />
    </>
  );
}