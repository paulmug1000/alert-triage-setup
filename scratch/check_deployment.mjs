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
    range: 'Clients!A19:AD19'
  });
  const row = res.data.values[0] || [];
  console.log('Client:', row[0]);
  console.log('App GAS URL (Col O):', row[14]);
  console.log('Deployment ID (Col AC):', row[28]);

  // Also check Template row (Row 3)
  const res3 = await sheets.spreadsheets.values.get({
    spreadsheetId: '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co',
    range: 'Clients!A3:AD3'
  });
  const row3 = res3.data.values[0] || [];
  console.log('\nTemplate:');
  console.log('App GAS URL (Col O):', row3[14]);
  console.log('Deployment ID (Col AC):', row3[28]);
}

run();
