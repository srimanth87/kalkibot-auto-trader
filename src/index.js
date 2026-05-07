const DEFAULT_ALPACA_BASE_URL = "https://api.alpaca.markets";
const DEFAULT_POSITION_SIZE = 1000;
const DEFAULT_MIN_GRADE = "B";
const GRADE_RANK = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

let memoryEnabled = true;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        return htmlResponse(renderDashboard());
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return corsJson({
          ok: true,
          service: "kalki-alpaca-autotrader",
          enabled: await isTradingEnabled(env),
          alpaca_base_url: getAlpacaBaseUrl(env),
          min_grade: getMinGrade(env),
          position_size: getPositionSize(env),
          webhook_path: `/telegram/${getSecretPath(env)}`,
        });
      }

      if (request.method === "POST" && url.pathname === "/test") {
        const { text } = await readAlertPayload(request);
        const alert = parseKalkiAlert(text);
        if (!alert) {
          return corsJson({ ok: false, skipped: "not a Kalki alert or missing grade/entry/stop/T1" }, 400);
        }

        return corsJson({ ok: true, preview: true, alert, decision: buildTradeDecision(env, alert) });
      }

      if (request.method === "POST" && url.pathname === "/alpaca/account") {
        const body = await request.json().catch(() => ({}));
        const account = await getAlpacaAccount({
          endpoint: body.endpoint || getAlpacaBaseUrl(env),
          key: body.key || env.ALPACA_KEY_ID,
          secret: body.secret || env.ALPACA_SECRET_KEY,
        });
        return corsJson({ ok: true, account });
      }

      if (request.method === "POST" && url.pathname === "/control") {
        const body = await request.json().catch(() => ({}));
        if (typeof body.enabled !== "boolean") {
          return corsJson({ ok: false, error: "enabled boolean is required" }, 400);
        }

        await setTradingEnabled(env, body.enabled);
        return corsJson({ ok: true, enabled: await isTradingEnabled(env) });
      }

      if (request.method === "POST" && url.pathname === `/telegram/${getSecretPath(env)}`) {
        return handleTelegramWebhook(request, env);
      }

      return corsJson({ ok: false, error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Autotrader error", message);
      return corsJson({ ok: false, error: message }, 500);
    }
  },
};

async function handleTelegramWebhook(request, env) {
  const { text } = await readAlertPayload(request);
  if (!text) return corsJson({ ok: true, skipped: "no message text" });

  const alert = parseKalkiAlert(text);
  if (!alert) return corsJson({ ok: true, skipped: "not a Kalki alert" });

  const decision = buildTradeDecision(env, alert);
  if (!(await isTradingEnabled(env))) {
    await sendTelegram(env, `Auto-trader paused. Skipped ${alert.ticker}.`);
    return corsJson({ ok: true, skipped: "auto-trader paused", alert, decision });
  }

  if (!decision.tradeable) {
    await sendTelegram(env, `Skipped ${alert.ticker}: ${decision.reason}.`);
    return corsJson({ ok: true, skipped: decision.reason, alert, decision });
  }

  const alpacaOrder = await placeAlpacaBracketOrder(env, alert, decision.shares);
  await sendTelegram(env, formatConfirmation(alert, decision.shares, alpacaOrder));

  return corsJson({ ok: true, alert, decision, alpaca_order: alpacaOrder });
}

async function readAlertPayload(request) {
  const body = await request.json().catch(() => ({}));
  return {
    text:
      body?.text ||
      body?.message?.text ||
      body?.channel_post?.text ||
      body?.edited_message?.text ||
      body?.edited_channel_post?.text ||
      "",
  };
}

function parseKalkiAlert(text) {
  if (!text || typeof text !== "string") return null;

  const tickerMatch =
    text.match(/(?:^|\n)\s*(?:[^\w\s]|\u26a1)?\s*([A-Z]{1,6})(?:\s|$)/) ||
    text.match(/\bTicker:\s*([A-Z]{1,6})\b/i);
  const gradeMatch = text.match(/Grade:\s*([ABC][+-]?)/i);
  const entryMatch = text.match(/Entry:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const stopMatch = text.match(/Stop:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
  const t1Match = text.match(/T1:\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  if (!tickerMatch || !gradeMatch || !entryMatch || !stopMatch || !t1Match) return null;

  const alert = {
    ticker: tickerMatch[1].toUpperCase(),
    grade: normalizeGrade(gradeMatch[1]),
    entryPrice: Number(entryMatch[1]),
    stopPrice: Number(stopMatch[1]),
    t1: Number(t1Match[1]),
    raw: text,
  };

  if (
    !Number.isFinite(alert.entryPrice) ||
    !Number.isFinite(alert.stopPrice) ||
    !Number.isFinite(alert.t1) ||
    alert.entryPrice <= 0 ||
    alert.stopPrice <= 0 ||
    alert.t1 <= 0
  ) {
    return null;
  }

  return alert;
}

function buildTradeDecision(env, alert) {
  const positionSize = getPositionSize(env);
  const shares = Math.floor(positionSize / alert.entryPrice);

  if (!isTradeableGrade(alert.grade, getMinGrade(env))) {
    return { tradeable: false, reason: `grade ${alert.grade} below threshold`, shares, position_size: positionSize };
  }

  if (shares < 1) {
    return { tradeable: false, reason: "position size too small", shares, position_size: positionSize };
  }

  if (alert.stopPrice >= alert.entryPrice) {
    return { tradeable: false, reason: "stop must be below entry", shares, position_size: positionSize };
  }

  if (alert.t1 <= alert.entryPrice) {
    return { tradeable: false, reason: "T1 must be above entry", shares, position_size: positionSize };
  }

  return { tradeable: true, reason: "accepted", shares, position_size: positionSize };
}

async function placeAlpacaBracketOrder(env, alert, shares) {
  requireEnv(env, ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY"]);

  const response = await fetch(`${getAlpacaBaseUrl(env)}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      symbol: alert.ticker,
      qty: String(shares),
      side: "buy",
      type: "limit",
      limit_price: toMoney(alert.entryPrice),
      time_in_force: "day",
      order_class: "bracket",
      take_profit: {
        limit_price: toMoney(alert.t1),
      },
      stop_loss: {
        stop_price: toMoney(alert.stopPrice),
      },
      client_order_id: buildClientOrderId(alert.ticker),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Alpaca order failed with HTTP ${response.status}`);
  }

  return data;
}

async function getAlpacaAccount({ endpoint, key, secret }) {
  if (!endpoint || !key || !secret) {
    throw new Error("Alpaca endpoint, key, and secret are required");
  }

  const response = await fetch(`${String(endpoint).replace(/\/+$/, "")}/v2/account`, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Alpaca account request failed with HTTP ${response.status}`);
  }

  return {
    id: data.id,
    status: data.status,
    currency: data.currency,
    buying_power: data.buying_power,
    portfolio_value: data.portfolio_value,
    trading_blocked: data.trading_blocked,
    account_blocked: data.account_blocked,
  };
}

function isTradeableGrade(grade, minGrade) {
  const gradeIndex = GRADE_RANK.indexOf(normalizeGrade(grade));
  const thresholdIndex = maxGradeIndexForThreshold(minGrade);
  return gradeIndex >= 0 && gradeIndex <= thresholdIndex;
}

function maxGradeIndexForThreshold(minGrade) {
  const letter = String(minGrade || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
  if (letter === "A") return GRADE_RANK.indexOf("A-");
  if (letter === "C") return GRADE_RANK.indexOf("C-");
  return GRADE_RANK.indexOf("B-");
}

async function isTradingEnabled(env) {
  if (env.AUTOTRADER_STATE) {
    const value = await env.AUTOTRADER_STATE.get("enabled");
    return value == null ? true : value === "true";
  }

  return memoryEnabled;
}

async function setTradingEnabled(env, enabled) {
  if (env.AUTOTRADER_STATE) {
    await env.AUTOTRADER_STATE.put("enabled", String(enabled));
    return;
  }

  memoryEnabled = enabled;
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

function formatConfirmation(alert, shares, order) {
  return [
    "AUTO-TRADE SUBMITTED",
    `${alert.ticker} Grade ${alert.grade}`,
    `Buy ${shares} @ $${toMoney(alert.entryPrice)}`,
    `T1 $${toMoney(alert.t1)} | Stop $${toMoney(alert.stopPrice)}`,
    `Alpaca order ${order.id || order.client_order_id || "submitted"}`,
  ].join("\n");
}

function getAlpacaBaseUrl(env) {
  return String(env.ALPACA_BASE_URL || DEFAULT_ALPACA_BASE_URL).replace(/\/+$/, "");
}

function getPositionSize(env) {
  const value = Number(env.POSITION_SIZE || DEFAULT_POSITION_SIZE);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POSITION_SIZE;
}

function getMinGrade(env) {
  return String(env.MIN_GRADE || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
}

function getSecretPath(env) {
  return String(env.SECRET_PATH || "kalki2026").replace(/^\/+/, "");
}

function normalizeGrade(grade) {
  return String(grade || "").trim().toUpperCase();
}

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !String(env[key] || "").trim());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function toMoney(value) {
  return Number(value).toFixed(2);
}

function buildClientOrderId(symbol) {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `kalki-${symbol.toLowerCase()}-${Date.now()}-${random}`.slice(0, 48);
}

function corsJson(data, status = 200) {
  return corsResponse(JSON.stringify(data, null, 2), status, {
    "content-type": "application/json; charset=utf-8",
  });
}

function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kalki Alpaca Auto-Trader</title>
  <style>
    :root{color-scheme:dark;--bg:#07090d;--panel:#111722;--panel2:#151e2c;--line:#263244;--text:#edf4ff;--muted:#8896aa;--green:#39d98a;--red:#ff5b7c;--blue:#58a6ff;--amber:#ffcc66}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 Inter,ui-sans-serif,system-ui,Arial,sans-serif}
    main{max-width:1120px;margin:0 auto;padding:24px}
    header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:20px}
    h1{font-size:24px;margin:0} .sub{color:var(--muted);font-size:13px;margin-top:4px}
    .badge{border:1px solid var(--line);background:var(--panel2);border-radius:999px;padding:7px 10px;color:var(--amber);font-size:12px}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
    .span2{grid-column:span 2}.span3{grid-column:span 3}
    label{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
    input,textarea{width:100%;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:6px;padding:10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
    textarea{min-height:150px;resize:vertical}.row{display:flex;gap:10px;flex-wrap:wrap}
    button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:6px;padding:10px 12px;font-weight:700;cursor:pointer}
    button.primary{background:var(--blue);border-color:var(--blue);color:#06101f}
    button.danger{color:var(--red)}button.good{color:var(--green)}
    .stat{font:24px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:3px}
    pre{white-space:pre-wrap;margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d7ea}
    @media(max-width:780px){.grid{grid-template-columns:1fr}.span2,.span3{grid-column:auto}header{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Kalki Alpaca Auto-Trader</h1>
      <div class="sub">Grade A/B only · $1000 sizing · buy limit entry · Alpaca bracket order to T1 and stop</div>
    </div>
    <div class="badge" id="mode">Checking worker...</div>
  </header>

  <section class="grid">
    <div class="panel"><label>Status</label><div class="stat" id="status">--</div></div>
    <div class="panel"><label>Position Size</label><div class="stat" id="size">--</div></div>
    <div class="panel"><label>Min Grade</label><div class="stat" id="grade">--</div></div>

    <div class="panel span3">
      <label>Manual Alert Preview</label>
      <textarea id="alert">⚡ OKLO
📊 Grade: B | Score: 6/8
📈 Entry: $75.27
🛑 Stop: $70
🎯 T1: $77</textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" onclick="previewAlert()">Preview Only</button>
        <button class="danger" onclick="setEnabled(false)">Pause Bot</button>
        <button class="good" onclick="setEnabled(true)">Resume Bot</button>
        <button onclick="health()">Refresh</button>
      </div>
    </div>

    <div class="panel span3">
      <label>Output</label>
      <pre id="out">Ready.</pre>
    </div>
  </section>
</main>
<script>
async function health(){
  const r=await fetch('/health'); const data=await r.json();
  document.getElementById('status').textContent=data.enabled?'ACTIVE':'PAUSED';
  document.getElementById('size').textContent='$'+data.position_size;
  document.getElementById('grade').textContent=data.min_grade;
  document.getElementById('mode').textContent=data.alpaca_base_url.includes('paper-api')?'Alpaca Paper Endpoint':'Alpaca Live Endpoint';
  document.getElementById('out').textContent=JSON.stringify(data,null,2);
}
async function previewAlert(){
  const r=await fetch('/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('alert').value})});
  document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);
}
async function setEnabled(enabled){
  const r=await fetch('/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})});
  document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);
  await health();
}
health().catch(e=>document.getElementById('out').textContent=e.message);
</script>
</body>
</html>`;
}
