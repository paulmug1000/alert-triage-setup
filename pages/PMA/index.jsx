import Head from "next/head";
import TriageSystem from "../triage";

export default function PMAPage() {
  return (
    <>
      <Head>
        <title>Pulse - the agency finance dashboard</title>
        <meta name="description" content="Pulse - the agency finance dashboard" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Pulse" />
        <meta property="og:title" content="Pulse - the agency finance dashboard" />
        <meta property="og:description" content="Pulse - the agency finance dashboard" />
        <meta property="og:image" content="https://app.pulsedashboard.co.uk/pulselogo.png" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Pulse - the agency finance dashboard" />
        <meta name="twitter:description" content="Pulse - the agency finance dashboard" />
        <meta name="twitter:image" content="https://app.pulsedashboard.co.uk/pulselogo.png" />
      </Head>
      <TriageSystem onBack={() => {}} />
    </>
  );
}
