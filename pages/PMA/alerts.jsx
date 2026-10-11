import Head from "next/head";
import TriageSystem from "../triage";

export default function PMAAlertsPage() {
  return (
    <>
      <Head>
        <title>Alerts - Pulse Management Area</title>
      </Head>
      <TriageSystem initialNav="alerts" onBack={() => {}} />
    </>
  );
}
