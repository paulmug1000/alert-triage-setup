import fs from 'fs';

if (fs.existsSync('.env.local')) {
  fs.readFileSync('.env.local', 'utf8').split('\n').forEach(line => {
    const match = line.trim().match(/^([^=]+)=(.*)$/);
    if (match && !match[1].startsWith('#')) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  });
}

const { getSheetsClient } = await import('../services/sheetsClient.js');

async function checkSheets() {
  const sheets = await getSheetsClient();

  // Eleven master sheet ID from earlier inspection or redis
  const { redisClient } = await import('../services/redisClient.js');
  const keys = await redisClient.keys('pulse:vault:client:*:xero');
  
  for (const k of keys) {
    const raw = await redisClient.get(k);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    console.log(`\nClient: ${rec.clientKey}, MasterSheet: ${rec.masterSheetId}`);
    if (rec.masterSheetId) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: rec.masterSheetId,
          range: 'KeyInfo!S2:X3'
        });
        console.log('KeyInfo!S2:X3 values:', res.data.values);
      } catch (err) {
        console.log('Error reading sheet:', err.message);
      }
    }
  }
}

checkSheets().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
