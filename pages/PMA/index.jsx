import Head from "next/head";
import TriageSystem from "../triage";
import { getSsrSessionUser, canSsrUserAccessPma, getSsrInitialPmaData } from "../../services/ssrSession";

export default function PMAPage({ initialUser = null, initialClients = [], initialIntegrations = null }) {
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
      <TriageSystem
        onBack={() => { }}
        initialUser={initialUser}
        initialClients={initialClients}
        initialIntegrations={initialIntegrations}
      />
    </>
  );
}

export async function getServerSideProps(context) {
  const sessionUser = getSsrSessionUser(context.req);
  if (sessionUser && !canSsrUserAccessPma(sessionUser)) {
    return {
      redirect: {
        destination: "/pulse",
        permanent: false,
      },
    };
  }
  const { initialClients, initialIntegrations } = await getSsrInitialPmaData(sessionUser);
  return {
    props: {
      initialUser: sessionUser || null,
      initialClients: initialClients || [],
      initialIntegrations: initialIntegrations || null,
    },
  };
}
