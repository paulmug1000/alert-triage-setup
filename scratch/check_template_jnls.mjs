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
  const templateId = '1Kt0dRbMCd0jgTxBU5uwVMlVN75CIc7YtVJQHnYMR61w';
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: templateId,
      ranges: ['JnlsFromApp!A1:J20'],
      includeGridData: true
    });
    console.log('Master Template JnlsFromApp exists.');
    const rows = res.data.sheets[0].data[0].rowData || [];
    rows.slice(0, 5).forEach((r, rIdx) => {
      const vals = r.values || [];
      console.log(`Row ${rIdx+1}:`, vals.map(c => c.effectiveFormat?.numberFormat?.type));
    });
  } catch (e) {
    console.log('Master Template check failed:', e.message);
  }
}

run().catch(console.error);
