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
  const masterId = '1bof1JZWoDH2KLpw54YIf7ObWZWc3hponQBt4yUo7j9o'; // Orinoco

  const res = await sheets.spreadsheets.get({
    spreadsheetId: masterId,
    ranges: ['JnlsFromApp!A1:J150'],
    includeGridData: true
  });

  const sheetData = res.data.sheets[0].data[0];
  const rows = sheetData.rowData || [];
  
  console.log(`Checking ${rows.length} rows for date formatting in cols 2, 3, 4:`);
  rows.forEach((row, rIdx) => {
    if (rIdx === 0) return;
    const vals = row.values || [];
    for (const c of [2, 3, 4]) {
      const cell = vals[c];
      const type = cell?.effectiveFormat?.numberFormat?.type;
      if (type === 'DATE' || type === 'DATE_TIME' || type === 'TIME') {
        console.log(`Row ${rIdx + 1}, Col ${c} (${cell?.effectiveFormat?.numberFormat?.pattern}): formattedValue="${cell.formattedValue}", userEntered=${JSON.stringify(cell.userEnteredValue)}`);
      }
    }
  });
}

run().catch(console.error);
