import { useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

export default function AlertsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/pma/alerts");
  }, [router]);

  return (
    <>
      <Head>
        <title>Alerts - Pulse Management Area</title>
      </Head>
    </>
  );
}

export async function getServerSideProps() {
  return {
    redirect: {
      destination: "/pma/alerts",
      permanent: false,
    },
  };
}
