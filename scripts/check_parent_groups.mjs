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
    range: "Confirmed!A1:DD100",
    valueRenderOption: "UNFORMATTED_VALUE"
  });

  const rows = res.data.values || [];
  // Group rows by client + job
  const groups = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cl = rows[r][0];
    const jb = rows[r][1];
    if (!cl && !jb) continue;
    const key = `${cl} ||| ${jb}`;
    if (!groups.has(key)) groups.set(key, []);
    const sdate = rows[r][37];
    const rev = rows[r][32];
    const isParent = (sdate !== undefined && sdate !== "") || (Number(rev) > 0);
    groups.get(key).push({ row: r + 1, isParent, rev, sdate });
  }

  groups.forEach((items, key) => {
    const parents = items.filter(x => x.isParent);
    const children = items.filter(x => !x.isParent);
    if (parents.length > 1) {
      console.log(`Key with multiple PARENTS: [${key}]`);
      console.log(`  Parents (${parents.length}):`, parents.map(p => `Row ${p.row} (rev=${p.rev}, sdate=${p.sdate})`).join(", "));
      console.log(`  Children (${children.length}):`, children.map(c => `Row ${c.row}`).join(", "));
    }
  });
}

run().catch(console.error);
