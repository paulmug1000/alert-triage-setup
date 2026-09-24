import fs from 'fs';
import { getSheetsClient } from '../services/sheetsClient.js';

const env = fs.readFileSync('.env.local', 'utf8');
for (const rawLine of env.split('\n')) {
  const line = rawLine.trim();
  const idx = line.indexOf('=');
  if (idx > 0 && !line.startsWith('#')) {
    const k = line.substring(0, idx).trim();
    let v = line.substring(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

async function run() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co',
    range: 'Clients!A1:T25'
  });
  (res.data.values || []).forEach((r, idx) => {
    if (r[0] || r[17] || r[18]) {
      console.log(`Row ${idx+1}: "${r[0] || ''}" | ClientScript: ${r[17] || ''} | MasterScript: ${r[18] || ''}`);
    }
  });
}

run();
