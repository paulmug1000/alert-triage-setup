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
    ranges: ['JnlsFromApp!A1:J60'],
    includeGridData: true
  });

  const sheetData = res.data.sheets[0].data[0];
  const rows = sheetData.rowData || [];
  
  console.log(`Total rows fetched: ${rows.length}`);
  // Check headers
  const headerRow = rows[0]?.values?.map(c => c.formattedValue || c.userEnteredValue?.stringValue || '') || [];
  console.log('Headers:', headerRow);

  const targetIds = [
    '4eff7590-ff7a-4c15-a874-fc386df6f3cd',
    'dd7d64b7-d45e-4a74-be14-b3a9f51531fa',
    '5620e75f-d75c-45ba-9ac6-7ef8206a72e7',
    'b67b199c-460b-4b78-b469-11265213d6ce',
    '79bb58b9-c341-440e-ab43-1a5b4f2a55d5'
  ];

  rows.forEach((row, rIdx) => {
    const vals = row.values || [];
    const idVal = vals[8]?.formattedValue || vals[8]?.userEnteredValue?.stringValue || '';
    if (targetIds.some(tid => idVal.includes(tid))) {
      console.log(`\nRow ${rIdx + 1} (ID: ${idVal}):`);
      vals.forEach((cell, cIdx) => {
        const header = headerRow[cIdx] || `Col ${cIdx}`;
        console.log(`  Col ${cIdx} (${header}): formattedValue="${cell.formattedValue}", numFormat=${JSON.stringify(cell.effectiveFormat?.numberFormat)}, userEntered=${JSON.stringify(cell.userEnteredValue)}`);
      });
    }
  });

  // Also check general column formats on rows 2-10
  console.log('\n--- Checking column formats across first 10 rows: ---');
  for (let c = 0; c < 10; c++) {
    const formats = new Set();
    for (let r = 1; r < Math.min(rows.length, 15); r++) {
      const cell = rows[r]?.values?.[c];
      formats.add(cell?.effectiveFormat?.numberFormat?.type + ' (' + cell?.effectiveFormat?.numberFormat?.pattern + ')');
    }
    console.log(`Col ${c} (${headerRow[c]}):`, Array.from(formats));
  }
}

run().catch(console.error);
