import Head from "next/head";
import TriageSystem from "../triage";

export default function PMAPage() {
  return (
    <>
      <Head>
        <title>PMA - Pulse Management Area</title>
        <meta name="description" content="Pulse - the agency finance dashboard" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Pulse" />
        <meta property="og:title" content="Pulse" />
        <meta property="og:description" content="The agency finance dashboard" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Pulse" />
        <meta name="twitter:description" content="The agency finance dashboard" />
      </Head>
      <TriageSystem onBack={() => { }} />
    </>
  );
}

export async function getServerSideProps() {
  return {
    props: {},
  };
}
