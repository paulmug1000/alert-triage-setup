# Deployment Guide: Alert Triage Setup Interview

## Step 1: Prepare Your GitHub Repository

1. Create a new GitHub repo called `alert-triage-setup`
2. Clone it locally:
   ```bash
   git clone https://github.com/your-username/alert-triage-setup.git
   cd alert-triage-setup
   ```

3. Copy all files from `/home/claude/alert-triage/` into your repo directory

4. Commit and push:
   ```bash
   git add .
   git commit -m "Initial setup interview app"
   git push origin main
   ```

## Step 2: Connect to Vercel

1. Go to https://vercel.com and log in
2. Click "Add New..." → "Project"
3. Import your GitHub repository
4. Choose project settings (defaults are fine)

## Step 3: Add Environment Variables

In Vercel project dashboard:

1. Go to "Settings" → "Environment Variables"
2. Add each variable:

```
ANTHROPIC_API_KEY
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

SERVICE_ACCOUNT_EMAIL
alert-triage-backend@automation-commander.iam.gserviceaccount.com

SERVICE_ACCOUNT_PROJECT_ID
automation-commander

SERVICE_ACCOUNT_PRIVATE_KEY_ID
1dcd29d532d567e7666ad621a39d5bf3733e77c0

SERVICE_ACCOUNT_PRIVATE_KEY
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDW9qOJIalaNLsB
SEuZY2IugRbNJQ+KCKqzIhh979OB2sEsIdlWje2YAxBqr+G1skmbVRkso6IaUAd5
kRY3lhgM0XUl5qtBZmj4sAIBM5OJpNy6FTBZSZjsWiIeHajVQsZhvHH5x4Qs4qiW
lJ/tAf45R0R83Edjrp+8kKMkezsjPF1yY8j9qtFz12Mb7jfXRrYd5Y4hT21/4kOj
OFbrUoEWmfLvTIoB+CWFqBmA3O0Y+KFuBB7OjYO/AdTAgJHHMYXR/yA2r2B5mAQq
7bgrUVL2zqa6skubvG7dSs4XPmfUR4uJC6UbWOAxFyqiutne1j4UbWJo+7uq2Bcj
bd2VurmRAgMBAAECggEAMQ30kMklN+gbmrXQRq8myxz7QpJIAwRqS9mmhCqz9gih
F3yb98QIqa1dVDNRyyBl6rQXPBgVWHLV2diRnNq8H0S3OpBymUiRANtNgc+uxfTg
x/go4d9JLfp9majEC/KiidAypEDy+Tk6Jq7A9hmD1bddOi8cfXNukV3iVONoQehL
9UcheMFcP6914pW+RVJ6IkbfaMdhs9GXP6j8bv+MJhWq1yVKs6r1ylx0Wbc2vqOA
TCZM2xFPOD2U8xCOE0rRw19zxVcUzuVUAUQ/CH/13Xm3IX922VY9ya+O/4BC5mZZ
5cgTUbZx7dDXp6y/sMctoUZAgz/Gjxzjs9ohAXhQ1wKBgQD0TZwIBlwnKp7XIKPC
cTYHezEanJ4cEda4FWN0myDsdw74o/th48xUPFM4liPecZGI8jRtFsqxz6B60esU
WxEgfiOCy0A1t1g0eDS+Q/g9mhRI9z7cC9dBriSroE2DCO1+C3V0fJYoyzKcRLm8
BzrMGONiN1gyFIkRq+HWFffxqwKBgQDhQWqP5pyx62wYRFH78wO5mn84qnuliqSx
nEHwDN7+sqHJugWYJvmuZUWHd3yzqPtcCPorywyvfEBwk2qVKIgTQ2Mfa/NG5neq
0ST/0EYV3BbIE4iEv5MHGV6gq6iF2YMcw//wlmCJbuaGbtdNCwnwoHe7RT3uerL5
Kfk9tVU9swKBgByRtt15YO1znn+p4XyroJXfYi6qghLmQyXj2m2YdpEwmx+YjZ00
9oAjTdggNrGctlg9esQHFk0U6r9yLPuEasxR8/Unr6qYdkgshn55lF4f1p9xyngR
KmsT4lXvuSDJunwy+tlUeHrsyE5d+xpx/f5AKtchgb7Zh+35G7/dcdFhAoGAIMeF
O1Wi3d1ViJ6Ak7qEg0DxXIyqm6d2WgZULhuhY80Y8CMq5z5cvT0thg4kTny7v2Pr
C+5rdSoOspMxQm14h90ZkpwB9gJZzbjLupJTcKDri8gT6MV8Ht9ZPuZcCsZhZxE6
sIchmz5RO6TrneGKW8LuSYlE/uxKGSo7g/hcZDMCgYAZSXJVN7ZaDC/LFlKlyMi6
3wytUaxTug1conIn9+q3/oWtPqhg/sm1uPyf5kEpsguqO84j3JLSa0r9NZO/WX6s
l+2fJjEJdGSi/+YrvbnA2khwc07WEv6F0YmIpcZI6cHKkmnpwOLpwjssvk5FrY87
gvGl7ZxuphFPOurShC4IlQ==
-----END PRIVATE KEY-----

SERVICE_ACCOUNT_CLIENT_ID
111077407642404739710
```

3. Click "Save"

## Step 4: Deploy

Click "Deploy" - Vercel will automatically build and deploy.

Your app will be live at your Vercel URL (usually something like `https://alert-triage-setup.vercel.app`)

## Troubleshooting

**Environment variables not working?**
- Make sure they're added to the right environment (Production)
- Redeploy after adding variables

**"Module not found" errors?**
- Run `npm install` locally first
- Push updated `package-lock.json` to GitHub

**API errors?**
- Check Vercel logs: Project → Deployments → View logs
- Verify service account credentials are correct

## Next Steps

Once the interview is complete and your knowledge base is saved:

1. Review the Google Doc created with your answers
2. We'll use that knowledge base to build the full alert triage UI and backend system
