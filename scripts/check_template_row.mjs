import { getSheetsClient } from '../services/sheetsClient.js';

async function main() {
  const sheets = await getSheetsClient();
  const trackerSheetId = '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: trackerSheetId,
    range: 'Clients!A3:N3'
  });
  console.log("Template Row 3:", res.data.values);
}

main().catch(console.error);
