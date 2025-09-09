# Telegram Task Reporter (Vercel)

Daily Telegram task report via a Vercel Serverless Function. Send the bot a DM to create a task. Reply with 👍 to mark it done. Each day, you receive a concise list of open tasks.

Uses Telegram Bot API polling. For persistence across days, configure Upstash Redis (recommended).

## What You Get
- Daily cron at 08:00 UTC calling `/api/cron`
- Simple workflow (private chat with your bot):
  - Send a message → creates a task
  - Reply with `👍` → marks that task done
- Compact summary of open tasks delivered to your `ADMIN_CHAT_ID`

## Setup (Concise)
1. Create a Telegram bot with BotFather → copy `TELEGRAM_BOT_TOKEN`.
2. Disable webhooks for polling: open `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=` (blank URL).
3. Find your Telegram ID:
   - Option A: message `@userinfobot`.
   - Option B: deploy and open `/api/whoami`.
4. (Recommended) Create an Upstash Redis database and copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
5. On Vercel (Project → Settings → Environment Variables) set:
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_CHAT_ID` (your numeric ID)
   - `UPSTASH_REDIS_REST_URL` (for task storage)
   - `UPSTASH_REDIS_REST_TOKEN` (for task storage)
6. Deploy. Cron runs daily; test via `https://<your-deployment>/api/cron`.

## Files
- `vercel.json`: schedules the daily cron.
- `api/cron.js`: polls Telegram, persists tasks (Upstash), sends the summary.
- `api/whoami.js`: lists recent chat IDs to discover `ADMIN_CHAT_ID`.
- `dev.js`: local HTTP runner for `/api/*` endpoints.

## Notes
- DM the bot to create tasks; reply with `👍` to mark done.
- With Upstash configured, tasks persist across days. Without it, fallback mode reports only recent messages (no true task list).
- If a webhook was set, polling won’t deliver updates until you clear it (step 2).
- Long messages are truncated and messages are chunked to fit Telegram limits.

## Vercel Setup (Step-by-Step)
- Import this repo into Vercel.
- Configure Environment Variables as above.
- Deploy. Endpoints:
  - `https://<your-deployment>/api/whoami`
  - `https://<your-deployment>/api/cron`

## Hourly On Hobby (workaround)
Vercel Hobby only supports daily cron. To run hourly, use GitHub Actions to ping your endpoint:

- Add two GitHub repository secrets:
  - `CRON_URL` → `https://<your-deployment>/api/cron`
  - `CRON_SECRET` → any strong random string
- In Vercel, add the same `CRON_SECRET` env var.
- This repo includes `.github/workflows/hourly-cron.yml` which calls `CRON_URL?key=<secret>` hourly.

Security: `api/cron.js` checks `CRON_SECRET` and returns 401 if the key is missing or wrong.

## Local Testing (Without Vercel CLI)
- Prereqs: Node 18+
- `.env`:
  - `TELEGRAM_BOT_TOKEN=...`
  - `ADMIN_CHAT_ID=...`
  - (recommended) `UPSTASH_REDIS_REST_URL=...`
  - (recommended) `UPSTASH_REDIS_REST_TOKEN=...`
- Clear webhook for polling: `https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=`
- Run: `node dev.js`
- Test:
  - `http://localhost:3000/api/whoami`
  - `http://localhost:3000/api/cron`
