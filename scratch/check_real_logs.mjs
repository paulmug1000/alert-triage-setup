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
  const acId = '12B2zv_2GVqFvjCECIPTF-CMzSwTAD3dZU-R5INy0X9M';

  const acRes = await sheets.spreadsheets.values.get({
    spreadsheetId: acId,
    range: 'AutoUpdates!A3:N20'
  });
  
  const extractId = (url) => {
    const m = String(url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : url;
  };

  for (const r of acRes.data.values || []) {
    const name = r[0];
    const mUrl = r[12];
    const cUrl = r[11];
    if (!name || !mUrl) continue;
    const mId = extractId(mUrl);
    const cId = extractId(cUrl);

    let autoCount = 0;
    let autoNonRoutine = 0;
    let appCount = 0;
    try {
      const autoRes = await sheets.spreadsheets.values.get({
        spreadsheetId: mId,
        range: 'AutoLog!A2:D200',
        valueRenderOption: 'FORMATTED_VALUE'
      });
      const rows = autoRes.data.values || [];
      autoCount = rows.length;
      autoNonRoutine = rows.filter(row => row[2] && !row[2].toLowerCase().includes('no change')).length;
    } catch (e) {
      autoCount = 'ERR: ' + e.message;
    }

    try {
      const appRes = await sheets.spreadsheets.values.get({
        spreadsheetId: cId,
        range: 'AppLog!A2:B200',
        valueRenderOption: 'FORMATTED_VALUE'
      });
      appCount = (appRes.data.values || []).length;
    } catch (e) {
      appCount = 'ERR: ' + e.message;
    }

    console.log(`${name}: AutoLog total=${autoCount}, non-routine=${autoNonRoutine} | AppLog rows=${appCount}`);
  }
}

run();
