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

function getRevFormula(r) {
  return `=IF(OR(A${r}="", B${r}=""), "-",
  IF(AND(LEN(AL${r})=0, N(AG${r})=0), "-",
    IF(AJ${r}<>"Project", "NA",
      AG${r} - (N(AP${r}) + N(AW${r}) + N(BD${r})) - (SUMIFS(AP:AP, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(AW:AW, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(BD:BD, A:A, A${r}, B:B, B${r}, AL:AL, ""))
    )
  )
)`;
}

function getDcFormula(r) {
  return `=IF(OR(A${r}="", B${r}=""), "-",
  IF(AND(LEN(AL${r})=0, N(AH${r})=0), "-",
    IF(AJ${r}<>"Project", "NA",
      AH${r} - (N(BY${r}) + N(CF${r}) + N(CM${r})) - (SUMIFS(BY:BY, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(CF:CF, A:A, A${r}, B:B, B${r}, AL:AL, "") + SUMIFS(CM:CM, A:A, A${r}, B:B, B${r}, AL:AL, ""))
    )
  )
)`;
}

async function deployClient(client) {
  const t0 = Date.now();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: client.id });
  const confSheet = meta.data.sheets.find(s => s.properties.title === "Confirmed");
  const pipeSheet = meta.data.sheets.find(s => s.properties.title === "Pipeline");

  if (!confSheet || !pipeSheet) {
    throw new Error(`Missing Confirmed or Pipeline tab in ${client.name}`);
  }

  const confRows = confSheet.properties.gridProperties.rowCount;
  const pipeRows = pipeSheet.properties.gridProperties.rowCount;

  const confBwValues = [];
  const confDcValues = [];
  for (let r = 2; r <= confRows; r++) {
    confBwValues.push([getRevFormula(r)]);
    confDcValues.push([getDcFormula(r)]);
  }

  const pipeBwValues = [];
  const pipeDcValues = [];
  for (let r = 2; r <= pipeRows; r++) {
    pipeBwValues.push([getRevFormula(r)]);
    pipeDcValues.push([getDcFormula(r)]);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: client.id,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `Confirmed!BW2:BW${confRows}`, values: confBwValues },
        { range: `Confirmed!DC2:DC${confRows}`, values: confDcValues },
        { range: `Pipeline!BW2:BW${pipeRows}`, values: pipeBwValues },
        { range: `Pipeline!DC2:DC${pipeRows}`, values: pipeDcValues },
      ]
    }
  });

  const elapsed = Date.now() - t0;
  console.log(`[UPDATED] ${client.name.padEnd(30)} Confirmed: 2..${confRows}, Pipeline: 2..${pipeRows} (${elapsed} ms)`);
}

async function run() {
  console.log(`Starting deployment of updated formulas across ${CLIENTS.length} client sheets + template...`);
  const globalStart = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < CLIENTS.length; i++) {
    const client = CLIENTS[i];
    try {
      console.log(`Processing (${i + 1}/${CLIENTS.length}): ${client.name}...`);
      await deployClient(client);
      successCount++;
    } catch (err) {
      console.error(`[FAILED]  ${client.name}: ${err.message}`);
      failCount++;
    }
  }

  const totalTime = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log(`\nDeployment complete in ${totalTime}s! Success: ${successCount}, Failed: ${failCount}`);
}

run().catch(console.error);
