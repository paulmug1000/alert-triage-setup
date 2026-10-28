import Head from "next/head";
import TriageSystem from "../triage";
import { getSsrSessionUser, canSsrUserAccessPma, getSsrInitialPmaData } from "../../services/ssrSession";

export default function PMAAlertsPage({ initialUser = null, initialClients = [], initialIntegrations = null }) {
  return (
    <>
      <Head>
        <title>Alerts - Pulse Management Area</title>
      </Head>
      <TriageSystem
        initialNav="alerts"
        onBack={() => {}}
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
