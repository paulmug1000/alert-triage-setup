import { google } from "googleapis";
import fs from "fs";

const envContent = fs.readFileSync(".env.local", "utf8");
let clientEmail = "", privateKey = "";
for (const line of envContent.split("\n")) {
  if (line.startsWith("SERVICE_ACCOUNT_EMAIL=")) clientEmail = line.substring("SERVICE_ACCOUNT_EMAIL=".length).trim().replace(/^"|"$/g, "");
  if (line.startsWith("SERVICE_ACCOUNT_PRIVATE_KEY=")) privateKey = line.substring("SERVICE_ACCOUNT_PRIVATE_KEY=".length).trim().replace(/^"|"$/g, "");
}
privateKey = privateKey.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: { client_email: clientEmail, private_key: privateKey },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function run() {
  const vtId = "1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co";
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: vtId,
    range: "Clients!A5:L60",
    valueRenderOption: "FORMATTED_VALUE"
  });
  const rows = res.data.values || [];
  for (const r of rows) {
    const clientName = r[0];
    const clientUrl = r[11];
    if (!clientName || !clientUrl) continue;
    const m = clientUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) continue;
    const sheetId = m[1];
    try {
      const cRes = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "Confirmed!A1:CR1000",
        valueRenderOption: "FORMATTED_VALUE"
      });
      const cRows = cRes.data.values || [];
      if (cRows.length === 0) continue;
      const headers = cRows[0];
      const daysCols = [];
      headers.forEach((h, idx) => {
        if (/inv.*days/i.test(h)) daysCols.push({ idx, header: h });
      });

      for (let ri = 1; ri < cRows.length; ri++) {
        const row = cRows[ri];
        if (!row || !row[0]) continue;
        for (const dc of daysCols) {
          const val = String(row[dc.idx] || "").trim();
          // Check if value looks like a date: contains letters like Jan, Feb, Oct, or hyphens/slashes with dates
          if (/[a-zA-Z]{3}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(val)) {
            console.log(`[DATE IN DAYS FOUND] Client: "${clientName}", Row ${ri + 1}, Col ${dc.idx} (${dc.header}): "${val}" | Job: "${row[0]} - ${row[1]}" | Ref: "${row[42] || ""}"`);
          }
        }
      }
    } catch (e) {
      console.log(`Error reading ${clientName}: ${e.message}`);
    }
  }
}
run().catch(console.error);
