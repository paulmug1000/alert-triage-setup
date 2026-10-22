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
  const elevenId = "14UO5eBNuV-F7pSiPokcIMT3y63EkppeHQgiTU7eqM1Y";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: elevenId,
    range: "Confirmed!A1:CR395",
    valueRenderOption: "FORMATTED_VALUE"
  });
  const headers = res.data.values[0];
  const row394 = res.data.values[393]; // 0-indexed 393 is row 394
  console.log("Eleven Confirmed Row 394:");
  headers.forEach((h, idx) => {
    let col = "";
    let temp = idx;
    while (temp >= 0) {
      col = String.fromCharCode((temp % 26) + 65) + col;
      temp = Math.floor(temp / 26) - 1;
    }
    const val = row394 ? row394[idx] : undefined;
    if (val !== undefined && val !== "") {
      console.log(`  Col ${col} (${idx}) [${h}]: "${val}"`);
    }
  });

  // Also check ANRPR if available
  const anrprId = "1bqfLyBEJFBGzy3yRvZsXFLqSLPWHdM7CsWNjSlvJeuo";
  const anrprRes = await sheets.spreadsheets.values.get({
    spreadsheetId: anrprId,
    range: "Confirmed!A1:CR500",
    valueRenderOption: "FORMATTED_VALUE"
  });
  const anrprHeaders = anrprRes.data.values[0];
  const lastRowIdx = anrprRes.data.values.length - 1;
  console.log(`\nANRPR Confirmed Last Row (Row ${lastRowIdx + 1}):`);
  const lastRow = anrprRes.data.values[lastRowIdx];
  anrprHeaders.forEach((h, idx) => {
    let col = "";
    let temp = idx;
    while (temp >= 0) {
      col = String.fromCharCode((temp % 26) + 65) + col;
      temp = Math.floor(temp / 26) - 1;
    }
    const val = lastRow ? lastRow[idx] : undefined;
    if (val !== undefined && val !== "") {
      console.log(`  Col ${col} (${idx}) [${h}]: "${val}"`);
    }
  });
}
run().catch(console.error);
