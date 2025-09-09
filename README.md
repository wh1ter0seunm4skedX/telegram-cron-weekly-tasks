# Telegram No-Emoji Daily Report (Vercel)

A minimal Vercel Serverless Function that runs daily, polls Telegram updates, filters messages without emoji from the last 24 hours, and sends you a concise report.

It uses Telegram Bot API polling only (no external storage) and drains all pending updates each run.

## What you get
- Daily cron at 08:00 UTC calling `/api/cron`
- Polls `getUpdates` (no webhook required)
- Filters messages with no emoji (text/caption)
- Sends a compact summary to your `ADMIN_CHAT_ID`

## Setup (concise)
1. Create a Telegram bot with BotFather → get `TELEGRAM_BOT_TOKEN`.
2. Ensure your bot is NOT using webhooks: call `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=` in a browser (blank url disables webhooks).
3. Add the bot to the chats/channels you want to monitor. For groups, disable privacy mode in BotFather if you need all messages.
4. (Option A) Find your own Telegram user/chat id by messaging `@userinfobot`.
   (Option B) Deploy this project and open `/api/whoami` to list recent chat IDs.
5. On Vercel, create a project from this repo and add Environment Variables:
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_CHAT_ID` (number)
6. Deploy. The cron is defined in `vercel.json` to run daily at 08:00 UTC; you can also test by hitting `https://<your-deployment>/api/cron`.

## Files
- `vercel.json`: schedules the daily cron and sets Node 18 runtime.
- `api/cron.js`: polls Telegram, filters no-emoji messages, and sends the summary.
- `api/whoami.js`: helper to list recent chat IDs (for discovering `ADMIN_CHAT_ID`).

## Notes
- If the bot had a webhook configured, polling won’t yield updates until you clear it (step 2).
- Filtering uses a practical emoji regex covering common ranges; not 100% perfect but effective.
- Telegram message length limit is handled by chunking.
- Time window is last 24h from execution time.
- Without storage, you cannot fetch historic messages from before the bot joined; this drains only currently pending updates kept by Telegram.

## Vercel Setup (step-by-step)
- New Project: Import this repo into Vercel.
- Environment Variables (Project → Settings → Environment Variables):
  - `TELEGRAM_BOT_TOKEN` → value from BotFather
  - `ADMIN_CHAT_ID` → your Telegram ID (number)
- Deploy: Vercel picks up `vercel.json`; cron runs daily at 08:00 UTC.
- Test endpoints:
  - `https://<your-deployment>/api/whoami` to discover chat IDs
  - `https://<your-deployment>/api/cron` to trigger a manual run

## Local Testing (without Vercel CLI)
- Prereqs: Node 18+
- Env: create `.env` with:
  - `TELEGRAM_BOT_TOKEN=<your token>`
  - `ADMIN_CHAT_ID=<your numeric id>`
- Clear webhook (for polling): open `https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=`
- Start: `node dev.js`
- Visit locally:
  - `http://localhost:3000/api/whoami`
  - `http://localhost:3000/api/cron`

Tip: If `vercel dev` is unstable on Windows, use this local runner or WSL2.

## Customize
- Change the schedule in `vercel.json` → `crons[0].schedule` (CRON, UTC).
- Tweak the snippet length or emoji detection in `api/cron.js`.
