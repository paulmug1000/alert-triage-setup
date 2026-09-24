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
  const acId = '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M';
  const acRes = await sheets.spreadsheets.values.get({
    spreadsheetId: acId,
    range: 'AutoUpdates!A3:N12'
  });
  
  let orinocoMasterId = null;
  for (const row of acRes.data.values || []) {
    if (row[0] && row[0].includes('Orinoco')) {
      orinocoMasterId = row[12].match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
      console.log('Found Orinoco Master ID:', orinocoMasterId);
      break;
    }
  }

  if (!orinocoMasterId) {
    console.log('Orinoco Master ID not found');
    return;
  }

  // 1. Get sheets list
  const meta = await sheets.spreadsheets.get({ spreadsheetId: orinocoMasterId });
  const sheetNames = meta.data.sheets.map(s => s.properties.title);
  console.log('Sheets in Orinoco Master:', sheetNames);

  // 2. Check JnlsFromApp
  if (sheetNames.includes('JnlsFromApp')) {
    const jnls = await sheets.spreadsheets.values.get({
      spreadsheetId: orinocoMasterId,
      range: 'JnlsFromApp!A1:K10'
    });
    console.log('JnlsFromApp Headers/First rows:');
    console.log(JSON.stringify(jnls.data.values, null, 2));

    // Find the rows with the specific IDs
    const allJnls = await sheets.spreadsheets.values.get({
      spreadsheetId: orinocoMasterId,
      range: 'JnlsFromApp!A1:K150'
    });
    const targetIds = [
      '4eff7590-ff7a-4c15-a874-fc386df6f3cd',
      'dd7d64b7-d45e-4a74-be14-b3a9f51531fa',
      '5620e75f-d75c-45ba-9ac6-7ef8206a72e7',
      'b67b199c-460b-4b78-b469-11265213d6ce',
      '79bb58b9-c341-440e-ab43-1a5b4f2a55d5'
    ];
    for (const r of allJnls.data.values || []) {
      for (const tid of targetIds) {
        if (r.some(cell => String(cell).includes(tid))) {
          console.log(`Matched ID ${tid}:`, JSON.stringify(r));
        }
      }
    }
  }
}

run().catch(console.error);
