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
    range: "Confirmed!A1:DD1",
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const headers = res.data.values[0] || [];
  headers.forEach((h, i) => {
    let col = "";
    let temp = i;
    while (temp >= 0) {
      col = String.fromCharCode((temp % 26) + 65) + col;
      temp = Math.floor(temp / 26) - 1;
    }
    if (h) console.log(`${col} (${i}): ${h}`);
  });
}

run().catch(console.error);
