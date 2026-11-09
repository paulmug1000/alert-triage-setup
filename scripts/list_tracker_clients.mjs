import { getSheetsClient } from '../services/sheetsClient.js';

async function main() {
  const sheets = await getSheetsClient();
  const trackerSheetId = '1tx4rRD55-W53-B9Z_kMAJjXMf0nrIE9CCczYXFR84co';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: trackerSheetId,
    range: 'Clients!A1:N60'
  });

  const rows = res.data.values || [];
  console.log(`Read ${rows.length} rows from Clients sheet.`);
  console.log("Headers (Row 4):", rows[3]);

  // List all clients from Row 5 onwards
  const clients = [];
  for (let i = 4; i < rows.length; i++) {
    const row = rows[i];
    const clientName = row[0]; // Col A
    const status = row[1];     // Col B
    const clientUrl = row[11]; // Col L (index 11)
    if (clientName && clientUrl) {
      clients.push({
        row: i + 1,
        name: clientName,
        status: status,
        clientUrl: clientUrl
      });
    }
  }

  console.log(`Found ${clients.length} clients with Client URL:`);
  clients.forEach(c => console.log(`- [Row ${c.row}] ${c.name} (${c.status}): ${c.clientUrl}`));
}

main().catch(console.error);
