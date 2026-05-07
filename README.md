# Kalki Alpaca Auto-Trader

Standalone Cloudflare Worker project for Kalki alerts and Alpaca bracket orders. This folder is intentionally separate from the older Kalki analysis pages.

The hosted app is multi-client: you post alerts in one Telegram channel, and each client connects their own Alpaca paper account in the dashboard.

## Rules

- Trade Grade A or B only.
- Use `$1000` per trade by default.
- Shares are `floor(1000 / entry price)`.
- Submit a buy limit order at entry.
- Attach a bracket with sell limit at T1 and stop loss at the stop price.
- Dashboard users connect their own Alpaca paper account from the settings modal.
- Each client can turn auto-trading on/off, pause for the day, and set daily trade/dollar limits.

## Setup

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalki-alpaca-autotrader
npm install
cp .dev.vars.example .dev.vars
```

Put your real values in `.dev.vars`. Do not commit `.dev.vars`.

Required Cloudflare secret for encrypting client Alpaca credentials:

```bash
wrangler secret put ENCRYPTION_KEY
```

Use a long random value. Do not lose it after clients connect, because existing encrypted Alpaca credentials depend on it.

Telegram source channel/group:

```bash
wrangler secret put SOURCE_CHAT_ID
```

Use the numeric Telegram chat id for the channel/group that posts the alerts, usually starting with `-100...`. If `SOURCE_CHAT_ID` is set, alerts from any other chat are ignored.

Optional Telegram confirmation secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

Deploy:

```bash
npm run deploy -- --keep-vars
```

Use `--keep-vars` if you set `SOURCE_CHAT_ID` or other variables in the Cloudflare dashboard, so a deploy does not overwrite dashboard-managed values.

Register Telegram:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://kalki-alpaca-autotrader.srimanthgada87.workers.dev/telegram/kalki2026"
```

## Endpoints

- `GET /`: hosted client dashboard.
- `GET /health`: config and status summary.
- `POST /test`: parse and preview an alert without placing an order.
- `POST /api/client/register`: create a client profile with encrypted Alpaca paper credentials.
- `POST /api/client/settings`: update client pause/risk controls.
- `POST /api/client/manual-trade`: manually place a paper trade for the authenticated client.
- `POST /control`: pause/resume with `{ "enabled": false }`.
- `POST /telegram/<SECRET_PATH>`: Telegram webhook that fans alerts out to enabled clients.

## Alpaca Notes

The default endpoint is paper trading: `https://paper-api.alpaca.markets`.

For the hosted dashboard, each user enters their own Alpaca paper endpoint, key id, and secret. The browser keeps only the generated client id/token; Alpaca credentials are encrypted in Cloudflare KV so Telegram alerts can place trades even when the user's browser is closed.
