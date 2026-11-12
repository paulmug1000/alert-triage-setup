import { google } from "googleapis";
import fs from "fs";

const envContent = fs.readFileSync(".env.local", "utf8");
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

async function run() {
  const elevenClientId = "14UO5eBNuV-F7pSiPokcIMT3y63EkppeHQgiTU7eqM1Y";

  const pipeRes = await sheets.spreadsheets.values.get({
    spreadsheetId: elevenClientId,
    range: "Pipeline!A245:AY258",
    valueRenderOption: "FORMATTED_VALUE"
  });
  (pipeRes.data.values || []).forEach((r, idx) => {
    console.log(`Pipeline Row ${245 + idx}: Client="${r[0]}", Job="${r[1]}", Code="${r[2]}", Start="${r[37]}", End="${r[38]}", Rev="${r[32]}"`);
  });
}

run().catch(console.error);
