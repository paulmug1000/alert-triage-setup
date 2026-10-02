import Head from "next/head";
import TriageSystem from "../triage";

export default function PMAPage() {
  return (
    <>
      <Head>
        <title>Pulse Management Area (PMA)</title>
      </Head>
      <TriageSystem onBack={() => {}} />
    </>
  );
}
