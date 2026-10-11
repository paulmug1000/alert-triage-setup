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
      </Head>
    </>
  );
}

export async function getServerSideProps() {
  return {
    redirect: {
      destination: "/pma",
      permanent: false,
    },
  };
}