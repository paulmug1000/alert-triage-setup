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
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: '1LZYoHrogDV828bVHFOWTjejuWspKdihbUMAqSihqArA',
    range: 'AppData!W40'
  });
  console.log('Current value:', res.data.values[0][0]);
  
  // Test write same value back
  await sheets.spreadsheets.values.update({
    spreadsheetId: '1LZYoHrogDV828bVHFOWTjejuWspKdihbUMAqSihqArA',
    range: 'AppData!W40',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[res.data.values[0][0]]] }
  });
  console.log('Write test succeeded!');
}

run();
