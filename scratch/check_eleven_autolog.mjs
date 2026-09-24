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

function extractId(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function run() {
  const sheets = await getSheetsClient();
  const trackerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co',
    range: 'Clients!A5:M5'
  });
  const row = trackerRes.data.values[0];
  const clientName = row[0];
  const clientUrl = row[11];
  const masterUrl = row[12];
  const masterSsId = extractId(masterUrl);
  console.log(`Client: ${clientName}`);
  console.log(`Master Spreadsheet ID: ${masterSsId}`);

  try {
    const autoLogRes = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSsId,
      range: 'AutoLog!A1:D8'
    });
    console.log('\n--- Eleven AutoLog Sample ---');
    (autoLogRes.data.values || []).forEach((r, i) => {
      console.log(`Row ${i+1}: [${r[0]}] [${r[1]}] [${r[2]}]`);
      if (i > 0 && r[3]) {
        console.log(`   Details: ${String(r[3]).substring(0, 120).replace(/\n/g, ' ')}...`);
      }
    });
  } catch (e) {
    console.log('Error reading AutoLog:', e.message);
  }
}

run();
