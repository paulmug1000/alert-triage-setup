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
  
  for (const row of acRes.data.values || []) {
    const cName = row[0];
    const mUrl = row[12];
    if (!cName || !mUrl) continue;
    const mId = mUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!mId) continue;
    try {
      const res = await sheets.spreadsheets.get({
        spreadsheetId: mId,
        ranges: ['JnlsFromApp!A1:J100'],
        includeGridData: true
      });
      const sheet = res.data.sheets[0];
      const rows = sheet?.data?.[0]?.rowData || [];
      let foundDateInAmt = false;
      rows.forEach((r, rIdx) => {
        if (rIdx === 0) return;
        const vals = r.values || [];
        for (const c of [2, 3, 4]) {
          const type = vals[c]?.effectiveFormat?.numberFormat?.type;
          if (type === 'DATE' || type === 'DATE_TIME' || type === 'TIME') {
            console.log(`[${cName}] Row ${rIdx+1} Col ${c}: type=${type}, pattern=${vals[c]?.effectiveFormat?.numberFormat?.pattern}, val=${vals[c]?.formattedValue}`);
            foundDateInAmt = true;
          }
        }
      });
      if (!foundDateInAmt) {
        console.log(`[${cName}] JnlsFromApp is clean (no date formats in amount cols)`);
      }
    } catch (e) {
      console.log(`[${cName}] Could not check: ${e.message}`);
    }
  }
}

run().catch(console.error);
