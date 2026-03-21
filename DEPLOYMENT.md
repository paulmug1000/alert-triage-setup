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
3. Click "Save"

## Step 4: Deploy

Click "Deploy" - Vercel will automatically build and deploy.

Your app will be live at your Vercel URL (usually something like `https://alert-triage-setup.vercel.app`)

## Troubleshooting

**Environment variables not working?**

* Make sure they're added to the right environment (Production)
* Redeploy after adding variables

**"Module not found" errors?**

* Run `npm install` locally first
* Push updated `package-lock.json` to GitHub

**API errors?**

* Check Vercel logs: Project → Deployments → View logs
* Verify service account credentials are correct

## Next Steps

Once the interview is complete and your knowledge base is saved:

1. Review the Google Doc created with your answers
2. We'll use that knowledge base to build the full alert triage UI and backend system

