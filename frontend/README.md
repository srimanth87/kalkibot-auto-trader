# Kalki Auto-Trader Pages Dashboard

This folder is the Cloudflare Pages frontend. It serves the dashboard at a clean `pages.dev` URL and proxies browser API calls through `/api/*`.

## Flow

```text
Client browser -> https://kalki-alpaca-autotrader.pages.dev
Client browser -> /api/client/me
Pages Function -> AUTOTRADER_API_ORIGIN/api/client/me
Worker API -> Alpaca paper / Cloudflare KV
```

Telegram should still point directly to the Worker API, not Pages:

```text
https://<auto-trader-worker>.workers.dev/telegram/<SECRET_PATH>
```

## Required Pages Variable

Set this in Cloudflare Pages:

```text
AUTOTRADER_API_ORIGIN=https://<auto-trader-worker>.workers.dev
```

## Local Commands

From the repo root:

```sh
npm run pages:dev
npm run pages:deploy
```
