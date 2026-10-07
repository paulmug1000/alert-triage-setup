const clientId = '5B2E2A0D37A14722B07E5323DC95125D';
const secretFromSheet = 'GqpknKdHlwV2oGqzE5oNM7vhhc_BhbJySytMmX6bu9H2qFL3';
const secretFromEnv = '9nGPXkREXukcshKMb--wX0A3IrWhVlyEkLmLcE9dkNZLGN5S';

async function testBothSecrets() {
  // Test Sheet Secret
  const auth1 = Buffer.from(`${clientId}:${secretFromSheet}`).toString('base64');
  const res1 = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth1}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'dummy' }).toString()
  });
  console.log('Sheet Secret Response:', res1.status, await res1.text());

  // Test Env Secret
  const auth2 = Buffer.from(`${clientId}:${secretFromEnv}`).toString('base64');
  const res2 = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth2}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'dummy' }).toString()
  });
  console.log('Env Secret Response:', res2.status, await res2.text());
}

testBothSecrets().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
