import { google } from "googleapis";
import fs from "fs";
import path from "path";

const envPath = path.resolve("pulse-management-system", ".env.local");
const envContent = fs.readFileSync(envPath, "utf8");
let clientEmail = "";
let privateKey = "";
for (const line of envContent.split("\n")) {
  if (line.startsWith("SERVICE_ACCOUNT_EMAIL=")) {
    clientEmail = line.substring("SERVICE_ACCOUNT_EMAIL=".length).trim().replace(/^"|"$/g, "");
  }
  if (line.startsWith("SERVICE_ACCOUNT_PRIVATE_KEY=")) {
    privateKey = line.substring("SERVICE_ACCOUNT_PRIVATE_KEY=".length).trim().replace(/^"|"$/g, "");
  }
}
privateKey = privateKey.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: clientEmail, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const CLIENTS = [
  { name: "Template", id: "1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno" },
  { name: "Eleven", id: "14UO5eBNuV-F7pSiPokcIMT3y63EkppeHQgiTU7eqM1Y" },
  { name: "Orinoco Communications", id: "1xnyKlqtxwpV0Tlu0ptO6HpHw3p8gkjYw7Vz3J4F2wkM" },
  { name: "Rascal Ventures", id: "1NWn9pJXDwLnAsUpc4Fz0ChVYKJ6uOYRI13wQMQpv2mo" },
  { name: "Beyond the Blueprint", id: "1MNsDQzTSuVylNCL2MUTqLjmQfd1NtkLhWsmrebyyqhE" },
  { name: "Get Better", id: "1JkdTBWTlHd3emMskey14YMVJMz6u9Rl7J-dc83-CSbU" },
  { name: "Thrive Recruitment Marketing", id: "1JFHuxcCn_YdZecTuBXzrEZ4lUMbCEhmmMCjKudJG_o0" },
  { name: "Advance Online", id: "1q0ZZrQ99YIcV0V9KTh6faA1YirBvbO3Nlil81QMzJ8I" },
  { name: "Incredibble", id: "11qTHv61xNN1UzqfStQuyS9-buGptz3xbdvn6YbH6M0A" },
  { name: "ANRPR", id: "1bqfLyBEJFBGzy3yRvZsXFLqSLPWHdM7CsWNjSlvJeuo" },
  { name: "The Anteroom", id: "1WDq2TuL0s9aC3fdTBYUskeWv6_sGzdkQFhFCRP1YnWc" },
  { name: "Ayefour Design", id: "1ccMr94GLlX_9xbGVxVCU0_ZLAUHhEGeE_0DI_pjKCXs" },
  { name: "APPTEST", id: "1LZYoHrogDV828bVHFOWTjejuWspKdihbUMAqSihqArA" },
  { name: "GeoBrand", id: "10tbpY09ccojLTICSLJHF9VGfLYe_RXrC7EVTcVrYW5k" },
  { name: "Hancock & Rowe", id: "14XyLeCuVzJR5P8n1aGs4ytZiTaKZR5BZj2s_NIstx7U" },
  { name: "Base Three", id: "1EFgbXitcYsWy87fhG2F21b721KFa3JGtP420YfKT4j4" }
];

async function inspect() {
  console.log(`Inspecting ${CLIENTS.length} client sheets...`);

  for (const client of CLIENTS) {
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: client.id });
      const titles = meta.data.sheets.map(s => s.properties.title);
      const confSheet = meta.data.sheets.find(s => s.properties.title === "Confirmed");
      const pipeSheet = meta.data.sheets.find(s => s.properties.title === "Pipeline");

      const confRows = confSheet ? confSheet.properties.gridProperties.rowCount : 0;
      const pipeRows = pipeSheet ? pipeSheet.properties.gridProperties.rowCount : 0;

      // Check header BW1 and DC1 on Confirmed
      let confBw1 = "", pipeBw1 = "";
      if (confSheet) {
        const hRes = await sheets.spreadsheets.values.get({
          spreadsheetId: client.id,
          range: "Confirmed!BW1:DC1"
        });
        confBw1 = hRes.data.values?.[0]?.[0] || ""; // BW is index 0 of BW:DC
      }
      if (pipeSheet) {
        const hRes = await sheets.spreadsheets.values.get({
          spreadsheetId: client.id,
          range: "Pipeline!BW1:DC1"
        });
        pipeBw1 = hRes.data.values?.[0]?.[0] || "";
      }

      console.log(`[OK] ${client.name.padEnd(30)} Confirmed: ${confRows} rows (BW1: "${confBw1}"), Pipeline: ${pipeRows} rows (BW1: "${pipeBw1}")`);
    } catch (err) {
      console.error(`[FAIL] ${client.name.padEnd(30)} Error: ${err.message}`);
    }
  }
}

inspect();
