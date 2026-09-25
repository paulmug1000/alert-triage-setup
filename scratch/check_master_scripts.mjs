import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

const env = fs.readFileSync('.env.local', 'utf8');
for (const rawLine of env.split('\n')) {
  const line = rawLine.trim();
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    let k = line.substring(0, idx).trim();
    let v = line.substring(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

async function run() {
  const sheets = await getSheetsClient();
  const vtId = '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co';
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: vtId,
    range: 'Clients!A1:T30'
  });
  const rows = res.data.values || [];
  console.log('Total rows:', rows.length);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0] || '';
    const masterScriptId = r[18] || ''; // Col S (19th col, 0-indexed 18)
    const masterSheetUrl = r[12] || '';
    if (name || masterScriptId) {
      console.log(`Row ${i+1}: "${name}" | MasterScriptId: "${masterScriptId}" | MasterSheet: ${masterSheetUrl ? 'YES' : 'NO'}`);
    }
  }
}

run().catch(console.error);
