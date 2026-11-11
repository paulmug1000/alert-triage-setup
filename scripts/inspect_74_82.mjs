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
  const sheetId = "11qTHv61xNN1UzqfStQuyS9-buGptz3xbdvn6YbH6M0A";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Confirmed!A74:BD82",
    valueRenderOption: "UNFORMATTED_VALUE"
  });

  const rows = res.data.values || [];
  rows.forEach((r, i) => {
    console.log(`Row ${74 + i}: cl="${r[0]}" jb="${r[1]}" rev=${r[32]} sdate=${r[37]} ap=${r[41]}`);
  });
}

run().catch(console.error);
