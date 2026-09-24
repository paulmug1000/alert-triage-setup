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
  const vtRes = await sheets.spreadsheets.values.get({
    spreadsheetId: vtId,
    range: 'Clients!A1:N30'
  });
  
  const allMasters = new Map();

  for (let i = 1; i < (vtRes.data.values || []).length; i++) {
    const row = vtRes.data.values[i];
    const name = row[0];
    const masterUrl = row[12]; // Column M
    if (name && masterUrl) {
      const match = masterUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        allMasters.set(name, match[1]);
        console.log(`[VersionTracker] ${name}: ${match[1]}`);
      }
    }
  }

  // Also check AutoUpdates
  const acId = '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M';
  const acRes = await sheets.spreadsheets.values.get({
    spreadsheetId: acId,
    range: 'AutoUpdates!A3:N20'
  });
  for (const row of acRes.data.values || []) {
    const name = row[0];
    const masterUrl = row[12];
    if (name && masterUrl) {
      const match = masterUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && !allMasters.has(name)) {
        allMasters.set(name, match[1]);
        console.log(`[AutoUpdates] ${name}: ${match[1]}`);
      }
    }
  }

  console.log(`\nTotal unique masters found: ${allMasters.size}`);
  return allMasters;
}

run().catch(console.error);
