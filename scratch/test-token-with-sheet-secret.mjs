import fs from 'fs';

if (fs.existsSync('.env.local')) {
  fs.readFileSync('.env.local', 'utf8').split('\n').forEach(line => {
    const match = line.trim().match(/^([^=]+)=(.*)$/);
    if (match && !match[1].startsWith('#')) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  });
}

const { getIntegrationTokens } = await import('../services/vaultService.js');
const clientId = '5B2E2A0D37A14722B07E5323DC95125D';
const secretFromSheet = 'GqpknKdHlwV2oGqzE5oNM7vhhc_BhbJySytMmX6bu9H2qFL3';

async function testWithSheetSecret() {
  const clients = ['eleven', 'rascal_ventures', 'orinoco_communications', 'beyond_the_blueprint', 'get_better'];
  for (const c of clients) {
    const rec = await getIntegrationTokens({ clientKey: c, tool: 'xero' });
    const refreshToken = rec?.tokens?.refreshToken;
    if (!refreshToken) {
      console.log(`${c}: No refresh token`);
      continue;
    }

    const basicAuth = Buffer.from(`${clientId}:${secretFromSheet}`).toString('base64');
    const res = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }).toString()
    });

    const text = await res.text();
    console.log(`${c}: status=${res.status}`, text);
  }
}

testWithSheetSecret().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
