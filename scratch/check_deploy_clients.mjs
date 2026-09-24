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
    spreadsheetId: '1v1N5ymNkcUCSPfzEGJxE43ylgGN95iyZmhKgnz62OQQ',
    range: 'Clients!A1:AN35'
  });
  const rows = res.data.values || [];
  console.log('Total rows in deployment-manager Clients tab:', rows.length);
  rows.forEach((r, idx) => {
    if (idx >= 3 && (r[0] || r[17])) {
      console.log(`Row ${idx+1}: "${r[0] || ''}" | ClientScript: ${r[17] || ''} | DeployId: ${r[28] || ''} | ClientURL: ${r[11] || ''}`);
    }
  });
}

run();
