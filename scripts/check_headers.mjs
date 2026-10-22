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
  credentials: {
    client_email: clientEmail,
    private_key: privateKey,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function run() {
  const templateId = "1KE0CRs8a92WMzyxy6rMZtr6d9D7cGMpUB3YLV89xjno";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: templateId,
    range: "Pipeline!1:5",
    valueRenderOption: "FORMATTED_VALUE"
  });
  const rows = res.data.values || [];
  rows.forEach((r, rIdx) => {
    console.log(`Pipeline Row ${rIdx + 1} has ${r.filter(x => x).length} non-empty cells`);
    if (rIdx === 0 || rIdx === 4) {
      r.forEach((h, idx) => {
        if (!h) return;
        let col = "";
        let temp = idx;
        while (temp >= 0) {
          col = String.fromCharCode((temp % 26) + 65) + col;
          temp = Math.floor(temp / 26) - 1;
        }
        console.log(`  ${col} (${idx}): "${h}"`);
      });
    }
  });
}
run().catch(console.error);
