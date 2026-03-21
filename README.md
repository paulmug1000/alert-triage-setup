# Alert Triage System - Setup Interview

Conversational knowledge base builder for the Alert Triage System, powered by Claude AI.

## Quick Start

### Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Deploy to Vercel

1. Push this repo to GitHub
2. Import to Vercel
3. Add environment variables:
   - `ANTHROPIC_API_KEY`
   - `SERVICE_ACCOUNT_EMAIL`
   - `SERVICE_ACCOUNT_PROJECT_ID`
   - `SERVICE_ACCOUNT_PRIVATE_KEY_ID`
   - `SERVICE_ACCOUNT_PRIVATE_KEY`
   - `SERVICE_ACCOUNT_CLIENT_ID`

4. Deploy!

## How It Works

The interview guides you through 6 stages:

1. **System Overview** - Basic setup understanding
2. **Data Flow & Integration** - How data moves between systems
3. **Sheet Structure & Fields** - Column names and meanings
4. **Matching & Reconciliation** - How matching rules work
5. **Alert Patterns & Edge Cases** - Common scenarios
6. **Action Templates** - Resolving each alert type

Each stage may have follow-up questions for clarification. At the end, a Google Doc is created with your structured knowledge base.

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in:

```
ANTHROPIC_API_KEY=your-api-key
SERVICE_ACCOUNT_EMAIL=your-service-account-email
SERVICE_ACCOUNT_PROJECT_ID=automation-commander
SERVICE_ACCOUNT_PRIVATE_KEY_ID=your-key-id
SERVICE_ACCOUNT_PRIVATE_KEY=your-private-key
SERVICE_ACCOUNT_CLIENT_ID=your-client-id
```

## Tech Stack

- Next.js 14
- React 18
- Anthropic Claude API
- Google Docs API
- Vercel deployment

## License

Private project
