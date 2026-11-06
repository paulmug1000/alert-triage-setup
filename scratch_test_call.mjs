async function testCall() {
  const webAppUrl = 'https://script.google.com/macros/s/AKfycbxwNZvpNPF5VEL1TjMncWDUhBNYBDPhH6u3YVSkxaFy2BrSYYs0PHaCIN5GWL7EWdqw/exec';
  const secret = (process.env.AGENT_TRIGGER_SECRET || '').replace(/^["']|["']$/g, '').trim();
  console.log('Sending request to GAS Web App with secret:', secret ? secret.slice(0, 5) + '...' : 'none');
  const start = Date.now();
  try {
    const resp = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        action: 'run_revenue_comparison',
        targetMonth: '2026-10',
        clientName: 'Get Better'
      })
    });
    console.log('Response status:', resp.status, 'Time taken:', (Date.now() - start) / 1000, 's');
    const text = await resp.text();
    console.log('Response text:', text.slice(0, 300));
  } catch (err) {
    console.error('Fetch error:', err.message, 'Time:', (Date.now() - start) / 1000, 's');
  }
}
testCall();
