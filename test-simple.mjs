import https from 'https';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.log('ERROR: ANTHROPIC_API_KEY not set');
  process.exit(1);
}

console.log('Testing API key...');
console.log('Key starts with:', apiKey.substring(0, 20) + '...');

const data = JSON.stringify({
  model: "claude-sonnet-4-6",
  max_tokens: 100,
  messages: [
    { role: "user", content: "Say hello" }
  ]
});

const options = {
  hostname: 'api.anthropic.com',
  path: '/v1/messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  }
};

const req = https.request(options, (res) => {
  let body = '';
  
  res.on('data', (chunk) => {
    body += chunk;
  });
  
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
});

req.write(data);
req.end();