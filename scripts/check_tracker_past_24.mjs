import { getSheetsClient } from '../services/sheetsClient.js';

async function main() {
  const sheets = await getSheetsClient();
  const trackerSheetId = '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: trackerSheetId,
    range: 'Clients!A25:N100'
  });

  const rows = res.data.values || [];
  console.log(`Read ${rows.length} rows past row 24:`);
  rows.forEach((r, idx) => {
    if (r[0] || r[11]) {
      console.log(`Row ${25 + idx}: Col A=${r[0]}, Col L=${r[11]}`);
    }
  });
}

main().catch(console.error);
