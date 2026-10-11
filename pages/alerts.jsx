import Head from "next/head";
import TriageSystem from "./triage";

export default function AlertsPage() {
  return (
    <>
      <Head>
        <title>Alerts - Pulse Management Area</title>
      </Head>
      <TriageSystem initialNav="alerts" onBack={() => {}} />
    </>
  );
}
