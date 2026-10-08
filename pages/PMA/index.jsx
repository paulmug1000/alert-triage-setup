import Head from "next/head";
import TriageSystem from "../triage";

export default function PMAPage() {
  return (
    <>
      <Head>
        <title>PMA - Pulse Management Area</title>
      </Head>
      <TriageSystem onBack={() => {}} />
    </>
  );
}
