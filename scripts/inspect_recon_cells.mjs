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
  // Let's find Orinoco's recon sheet from AutoUpdates
  const acId = "12mR1zZp8L0X6B_f0v6dY4YgT9c0l5mZz_5YjF5z4lI"; // or find from AutoUpdates
  const autoResp = await sheets.spreadsheets.values.get({
    spreadsheetId: "1p4_m_vEcE4O94cWn_g7yP_w5-E6wT8P2uT4r9T1uV0I", // AutoUpdates
    range: "AutoUpdates!A2:N100"
  }).catch(() => null);

  // Or read KeyInfo of Orinoco
  // Let's find Orinoco
  const trackerResp = await sheets.spreadsheets.values.get({
    spreadsheetId: "1B0_l3Z0a_zQ5jH4P5g7yP_w5-E6wT8P2uT4r9T1uV0I",
    range: "Clients!A2:G50"
  }).catch(() => null);
  console.log("Tracker rows:", trackerResp?.data?.values?.length);
}

run();

