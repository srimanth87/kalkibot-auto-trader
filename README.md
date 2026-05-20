# Kalki Auto-Trader

Standalone auto-trader project for Kalki alerts and paper-trading bracket orders. This folder is intentionally separate from the older Kalki analysis pages and from the existing Telegram forwarder.

The clean deployment has two pieces:

- `frontend/`: Cloudflare Pages dashboard at a clean `pages.dev` URL.
- `src/index.js`: Cloudflare Worker API for clients, encrypted credentials, Telegram, and broker orders.

The hosted app is multi-client: you post alerts in one Telegram channel with a dedicated auto-trader Telegram bot, and each client connects their own paper broker account in the dashboard.

## Rules

- Trade Grade A or B only.
- Use `$1000` per trade by default.
- Shares are `floor(1000 / entry price)`.
- Submit a buy limit order at entry by default, or a buy market order when the client selects Market in settings.
- Keep bracket orders open with GTC by default; users can choose Day Only in settings.
- Attach a bracket/OTOCO order with sell limit at T1 and stop loss at the stop price.
- Dashboard users connect their own paper broker account from the settings modal.
- Each client can turn auto-trading on/off, pause for the day, and set daily trade/dollar limits.

## Supported Brokers

### Alpaca Paper

- Broker: `Alpaca Paper`
- Endpoint: `https://paper-api.alpaca.markets`
- Key field: Alpaca API key id
- Secret field: Alpaca secret key

### Tradier Paper

- Broker: `Tradier Paper`
- Endpoint: `https://sandbox.tradier.com`
- Key field: Tradier account id
- Secret field: Tradier access token

## Setup

```bash
cd /Users/srimanth/Documents/codex/kalki-bot/kalki-alpaca-autotrader
npm install
cp .dev.vars.example .dev.vars
```

Put your real values in `.dev.vars`. Do not commit `.dev.vars`.

Required Cloudflare secret for encrypting client broker credentials:

```bash
wrangler secret put ENCRYPTION_KEY
```

Use a long random value. Do not lose it after clients connect, because existing encrypted broker credentials depend on it.

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

## Pages Dashboard

Deploy the dashboard separately from the Worker API:

```bash
npm run pages:deploy
```

Set this Cloudflare Pages variable:

```text
AUTOTRADER_API_ORIGIN=https://<auto-trader-worker>.workers.dev
```

The dashboard calls `/api/...`; the Pages Function in `frontend/functions/api/[[path]].js` forwards those calls to the Worker API.

## Telegram Bot

Use a separate Telegram bot for auto-trading. Do not reuse the bot that powers the existing Telegram forwarder.

Register the auto-trader bot webhook:

```bash
curl "https://api.telegram.org/bot<NEW_AUTO_TRADER_BOT_TOKEN>/setWebhook?url=https://<auto-trader-worker>.workers.dev/telegram/kalki2026"
```

## Endpoints

- `GET /`: fallback Worker-hosted dashboard.
- `GET /health` and `GET /api/health`: config and status summary.
- `POST /test` and `POST /api/test`: parse and preview an alert without placing an order.
- `POST /api/client/register`: create a client profile with encrypted paper broker credentials.
- `POST /api/client/settings`: update client pause/risk controls.
- `POST /api/client/manual-trade`: manually place a paper trade for the authenticated client.
- `POST /api/client/test-broker`: test the authenticated client's configured broker connection.
- `POST /control`: pause/resume with `{ "enabled": false }`.
- `POST /telegram/<SECRET_PATH>`: Telegram webhook that fans alerts out to enabled clients.

## Broker Notes

The default Alpaca endpoint is paper trading: `https://paper-api.alpaca.markets`.
Alpaca GTC orders are good until canceled, but Alpaca automatically cancels aged GTC orders after 90 days.

The default Tradier endpoint is sandbox paper trading: `https://sandbox.tradier.com`.
Tradier OTOCO orders require the entry leg to be a limit, stop, or stop-limit order, so the dashboard keeps Market entry disabled for Tradier.

For the hosted dashboard, each user enters their own broker endpoint and credentials. The browser keeps only the generated client id/token; broker credentials are encrypted in Cloudflare KV so Telegram alerts can place trades even when the user's browser is closed.
