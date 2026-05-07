# Kalki Alpaca Auto-Trader

Standalone Cloudflare Worker project for Kalki alerts and Alpaca bracket orders. This folder is intentionally separate from the older Kalki analysis pages.

## Rules

- Trade Grade A or B only.
- Use `$1000` per trade by default.
- Shares are `floor(1000 / entry price)`.
- Submit a buy limit order at entry.
- Attach a bracket with sell limit at T1 and stop loss at the stop price.
- Uses your Alpaca endpoint, key ID, and secret key through environment variables.

## Setup

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalki-alpaca-autotrader
npm install
cp .dev.vars.example .dev.vars
```

Put your real values in `.dev.vars`. Do not commit `.dev.vars`.

Cloudflare secrets:

```bash
wrangler secret put ALPACA_KEY_ID
wrangler secret put ALPACA_SECRET_KEY
```

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
npm run deploy
```

Register Telegram:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://kalki-alpaca-autotrader.srimanthgada87.workers.dev/telegram/kalki2026"
```

## Endpoints

- `GET /`: dashboard.
- `GET /health`: config and status summary.
- `POST /test`: parse and preview an alert without placing an order.
- `POST /control`: pause/resume with `{ "enabled": false }`.
- `POST /telegram/<SECRET_PATH>`: Telegram webhook that places Alpaca orders.

## Alpaca Notes

The default endpoint is paper trading: `https://paper-api.alpaca.markets`.
