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
    range: "Confirmed!A1:DD35",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values || [];
  [10, 11, 12, 14, 15, 17, 18, 21, 23, 28, 29, 30, 31].forEach(r => {
    const row = rows[r-1] || [];
    console.log(`Row ${r}: cl="${row[0]}" jb="${row[1]}" code="${row[2]}" dateConf="${row[3]}" sdate="${row[37]}" rev=${row[32]} ap=${row[41]} aw=${row[48]} bd=${row[55]}`);
  });
}

run().catch(console.error);
