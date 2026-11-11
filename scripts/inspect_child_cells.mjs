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
    range: "Confirmed!A1:DD85",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values || [];
  const headers = rows[0] || [];

  [29, 30, 31, 42, 44, 46, 51, 78, 80, 83, 84].forEach(r => {
    const row = rows[r-1] || [];
    console.log(`\n--- Child Row ${r} ---`);
    row.forEach((val, c) => {
      if (val !== undefined && val !== "" && c !== 74 && c !== 106) {
        let col = "";
        let temp = c;
        while (temp >= 0) {
          col = String.fromCharCode((temp % 26) + 65) + col;
          temp = Math.floor(temp / 26) - 1;
        }
        console.log(`  ${col} (${c}) [${headers[c]}]: ${val}`);
      }
    });
  });
}

run().catch(console.error);
