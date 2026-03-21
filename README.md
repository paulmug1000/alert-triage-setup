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

   * `ANTHROPIC\_API\_KEY`
   * `SERVICE\_ACCOUNT\_EMAIL`
   * `SERVICE\_ACCOUNT\_PROJECT\_ID`
   * `SERVICE\_ACCOUNT\_PRIVATE\_KEY\_ID`
   * `SERVICE\_ACCOUNT\_PRIVATE\_KEY`
   * `SERVICE\_ACCOUNT\_CLIENT\_ID`
4. Deploy!

## How It Works

The interview guides you through 6 stages:

1. **System Overview** - Basic setup understanding
2. **Data Flow \& Integration** - How data moves between systems
3. **Sheet Structure \& Fields** - Column names and meanings
4. **Matching \& Reconciliation** - How matching rules work
5. **Alert Patterns \& Edge Cases** - Common scenarios
6. **Action Templates** - Resolving each alert type

Each stage may have follow-up questions for clarification. At the end, a Google Doc is created with your structured knowledge base.

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in:

```
ANTHROPIC\_API\_KEY=your-api-key
SERVICE\_ACCOUNT\_EMAIL=your-service-account-email
SERVICE\_ACCOUNT\_PROJECT\_ID=automation-commander
SERVICE\_ACCOUNT\_PRIVATE\_KEY\_ID=your-key-id
SERVICE\_ACCOUNT\_PRIVATE\_KEY=your-private-key
SERVICE\_ACCOUNT\_CLIENT\_ID=your-client-id
```

## Tech Stack

* Next.js 14
* React 18
* Anthropic Claude API
* Google Docs API
* Vercel deployment

## License

Private project

