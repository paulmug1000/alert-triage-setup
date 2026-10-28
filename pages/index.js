import { useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/pma");
  }, [router]);

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
    </>
  );
}

import { getSsrSessionUser, canSsrUserAccessPma } from "../services/ssrSession";

export async function getServerSideProps(context) {
  const user = getSsrSessionUser(context.req);
  if (user && !canSsrUserAccessPma(user)) {
    return {
      redirect: {
        destination: "/pulse",
        permanent: false,
      },
    };
  }

  return {
    redirect: {
      destination: "/pma",
      permanent: false,
    },
  };
}