const DEFAULT_ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_POSITION_SIZE = 1000;
const DEFAULT_MIN_GRADE = "B";
const GRADE_RANK = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

let memoryEnabled = true;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsResponse(null, 204);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        return htmlResponse(renderDashboard());
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const clientCount = env.AUTOTRADER_KV ? (await env.AUTOTRADER_KV.list({ prefix: "client:" })).keys.length : null;
        return corsJson({
          ok: true,
          service: "kalki-alpaca-autotrader",
          mode: "multi-client-paper",
          enabled: await isTradingEnabled(env),
          alpaca_base_url: getAlpacaBaseUrl(env),
          webhook_path: `/telegram/${getSecretPath(env)}`,
          source_chat_id: getSourceChatId(env) || null,
          client_count: clientCount,
          kv_bound: Boolean(env.AUTOTRADER_KV),
        });
      }

      if (request.method === "POST" && url.pathname === "/test") {
        const { text } = await readAlertPayload(request);
        const alert = parseKalkiAlert(text);
        if (!alert) return corsJson({ ok: false, skipped: "not a Kalki alert or missing grade/entry/stop/T1" }, 400);
        return corsJson({ ok: true, preview: true, alert, decision: buildTradeDecision({}, alert) });
      }

      if (request.method === "POST" && url.pathname === "/api/client/register") {
        return await handleRegisterClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/me") {
        return await handleGetClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/settings") {
        return await handleUpdateClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/test-alpaca") {
        return await handleClientAlpacaTest(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/manual-trade") {
        return await handleClientManualTrade(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/logs") {
        return await handleClientLogs(request, env);
      }

      if (request.method === "POST" && url.pathname === "/control") {
        const body = await request.json().catch(() => ({}));
        if (typeof body.enabled !== "boolean") return corsJson({ ok: false, error: "enabled boolean is required" }, 400);
        await setTradingEnabled(env, body.enabled);
        return corsJson({ ok: true, enabled: await isTradingEnabled(env) });
      }

      if (request.method === "POST" && url.pathname === `/telegram/${getSecretPath(env)}`) {
        return await handleTelegramWebhook(request, env);
      }

      return corsJson({ ok: false, error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Autotrader error", { message });
      return corsJson({ ok: false, error: message }, 500);
    }
  },
};

async function handleRegisterClient(request, env) {
  requireStorage(env);
  requireEncryption(env);
  const body = await request.json().catch(() => ({}));
  const endpoint = normalizeAlpacaEndpoint(body.endpoint || DEFAULT_ALPACA_BASE_URL);
  const key = String(body.key || "").trim();
  const secret = String(body.secret || "").trim();
  if (!key || !secret) return corsJson({ ok: false, error: "Alpaca paper key and secret are required" }, 400);

  const account = await getAlpacaAccount({ endpoint, key, secret });
  const token = makeToken();
  const client = {
    id: crypto.randomUUID(),
    name: String(body.name || account.id || "Client").trim().slice(0, 80),
    endpoint,
    credentials: await encryptJson(env, { key, secret }),
    tokenHash: await sha256Hex(token),
    enabled: true,
    minGrade: normalizeMinGrade(body.minGrade || DEFAULT_MIN_GRADE),
    positionSize: normalizePositiveNumber(body.positionSize, DEFAULT_POSITION_SIZE),
    maxTradesPerDay: normalizeOptionalPositiveInteger(body.maxTradesPerDay),
    maxDollarsPerDay: normalizeOptionalPositiveNumber(body.maxDollarsPerDay),
    pauseUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveClient(env, client);
  await writeClientLog(env, client.id, {
    type: "client_registered",
    status: "ok",
    message: "Client connected Alpaca paper account",
  });

  return corsJson({ ok: true, client: publicClient(client), token, account });
}

async function handleGetClient(request, env) {
  const { client } = await requireClientAuth(request, env);
  return corsJson({ ok: true, client: publicClient(client), day: await getDayStats(env, client.id) });
}

async function handleUpdateClient(request, env) {
  const { client } = await requireClientAuth(request, env);
  const body = await request.json().catch(() => ({}));

  if (typeof body.enabled === "boolean") client.enabled = body.enabled;
  if (body.name != null) client.name = String(body.name).trim().slice(0, 80) || client.name;
  if (body.minGrade != null) client.minGrade = normalizeMinGrade(body.minGrade);
  if (body.positionSize != null) client.positionSize = normalizePositiveNumber(body.positionSize, client.positionSize);
  if (Object.hasOwn(body, "maxTradesPerDay")) client.maxTradesPerDay = normalizeOptionalPositiveInteger(body.maxTradesPerDay);
  if (Object.hasOwn(body, "maxDollarsPerDay")) client.maxDollarsPerDay = normalizeOptionalPositiveNumber(body.maxDollarsPerDay);
  if (body.pauseToday === true) client.pauseUntil = endOfTodayIso();
  if (body.pauseToday === false || body.clearPause === true) client.pauseUntil = null;

  if (body.endpoint || body.key || body.secret) {
    requireEncryption(env);
    const existing = await decryptCredentials(env, client);
    const endpoint = normalizeAlpacaEndpoint(body.endpoint || client.endpoint || DEFAULT_ALPACA_BASE_URL);
    const key = String(body.key || existing.key || "").trim();
    const secret = String(body.secret || existing.secret || "").trim();
    if (!key || !secret) return corsJson({ ok: false, error: "Alpaca paper key and secret are required" }, 400);
    const account = await getAlpacaAccount({ endpoint, key, secret });
    client.endpoint = endpoint;
    client.credentials = await encryptJson(env, { key, secret });
    client.name = client.name || account.id || "Client";
  }

  client.updatedAt = new Date().toISOString();
  await saveClient(env, client);
  await writeClientLog(env, client.id, {
    type: "settings_updated",
    status: "ok",
    message: "Settings updated",
  });
  return corsJson({ ok: true, client: publicClient(client), day: await getDayStats(env, client.id) });
}

async function handleClientAlpacaTest(request, env) {
  const { client } = await requireClientAuth(request, env);
  const credentials = await decryptCredentials(env, client);
  const account = await getAlpacaAccount({ endpoint: client.endpoint, ...credentials });
  return corsJson({ ok: true, account });
}

async function handleClientManualTrade(request, env) {
  const { client } = await requireClientAuth(request, env);
  const body = await request.json().catch(() => ({}));
  const alert = parseKalkiAlert(body.text || "");
  if (!alert) return corsJson({ ok: false, error: "not a Kalki alert" }, 400);

  const result = await maybeTradeForClient(env, client, alert, { source: "manual_dashboard" });
  return corsJson({ ok: result.status === "submitted", result });
}

async function handleClientLogs(request, env) {
  const { client } = await requireClientAuth(request, env);
  const logs = await listClientLogs(env, client.id, 50);
  return corsJson({ ok: true, logs });
}

async function handleTelegramWebhook(request, env) {
  const { text, chatId } = await readAlertPayload(request);
  if (!text) return corsJson({ ok: true, skipped: "no message text" });

  const sourceChatId = getSourceChatId(env);
  if (sourceChatId && String(chatId || "") !== sourceChatId) {
    return corsJson({
      ok: true,
      skipped: "different Telegram source chat",
      received_chat_id: chatId || null,
      expected_chat_id: sourceChatId,
    });
  }

  const alert = parseKalkiAlert(text);
  if (!alert) return corsJson({ ok: true, skipped: "not a Kalki alert" });

  if (!(await isTradingEnabled(env))) {
    await sendTelegram(env, `Auto-trader globally paused. Skipped ${alert.ticker}.`);
    return corsJson({ ok: true, skipped: "auto-trader globally paused", alert });
  }

  requireStorage(env);
  const clients = await listClients(env);
  const results = [];
  for (const client of clients) {
    results.push(await maybeTradeForClient(env, client, alert, { source: "telegram", chatId }));
  }

  await writeAlertLog(env, { alert, chatId, results });
  const submitted = results.filter((result) => result.status === "submitted").length;
  await sendTelegram(env, `Processed ${alert.ticker}: ${submitted}/${results.length} client paper order(s) submitted.`);
  return corsJson({ ok: true, alert, submitted_count: submitted, client_count: results.length, results });
}

async function maybeTradeForClient(env, client, alert, context = {}) {
  const base = {
    client_id: client.id,
    client_name: client.name,
    source: context.source || "unknown",
    ticker: alert.ticker,
    created_at: new Date().toISOString(),
  };

  try {
    if (!client.enabled) return await logTradeSkip(env, client, { ...base, status: "skipped", reason: "client auto-trading off" });
    if (client.pauseUntil && Date.parse(client.pauseUntil) > Date.now()) {
      return await logTradeSkip(env, client, { ...base, status: "skipped", reason: `paused until ${client.pauseUntil}` });
    }

    const decision = buildTradeDecision(client, alert);
    if (!decision.tradeable) return await logTradeSkip(env, client, { ...base, status: "skipped", reason: decision.reason, decision });

    const dayStats = await getDayStats(env, client.id);
    const nextNotional = dayStats.notional + decision.shares * alert.entryPrice;
    if (client.maxTradesPerDay && dayStats.tradeCount >= client.maxTradesPerDay) {
      return await logTradeSkip(env, client, { ...base, status: "skipped", reason: "daily trade limit reached", decision });
    }
    if (client.maxDollarsPerDay && nextNotional > client.maxDollarsPerDay) {
      return await logTradeSkip(env, client, { ...base, status: "skipped", reason: "daily dollar limit reached", decision });
    }

    const credentials = await decryptCredentials(env, client);
    const alpacaOrder = await placeAlpacaBracketOrder(env, alert, decision.shares, {
      endpoint: client.endpoint,
      ...credentials,
    });

    await updateDayStats(env, client.id, {
      tradeCount: dayStats.tradeCount + 1,
      notional: nextNotional,
    });

    const result = {
      ...base,
      status: "submitted",
      decision,
      alert,
      alpaca_order_id: alpacaOrder.id || alpacaOrder.client_order_id || null,
      alpaca_order: alpacaOrder,
    };
    await writeClientLog(env, client.id, result);
    return result;
  } catch (error) {
    const result = {
      ...base,
      status: "error",
      reason: error instanceof Error ? error.message : "Unknown trade error",
      alert,
    };
    await writeClientLog(env, client.id, result);
    return result;
  }
}

async function logTradeSkip(env, client, result) {
  await writeClientLog(env, client.id, result);
  return result;
}

async function readAlertPayload(request) {
  const body = await request.json().catch(() => ({}));
  const post = body?.message || body?.channel_post || body?.edited_message || body?.edited_channel_post || null;
  return {
    text: body?.text || post?.text || post?.caption || "",
    chatId: post?.chat?.id != null ? String(post.chat.id) : null,
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

function buildTradeDecision(client, alert) {
  const minGrade = normalizeMinGrade(client.minGrade || DEFAULT_MIN_GRADE);
  const positionSize = normalizePositiveNumber(client.positionSize, DEFAULT_POSITION_SIZE);
  const shares = Math.floor(positionSize / alert.entryPrice);

  if (!isTradeableGrade(alert.grade, minGrade)) {
    return { tradeable: false, reason: `grade ${alert.grade} below threshold`, shares, position_size: positionSize };
  }
  if (shares < 1) return { tradeable: false, reason: "position size too small", shares, position_size: positionSize };
  if (alert.stopPrice >= alert.entryPrice) return { tradeable: false, reason: "stop must be below entry", shares, position_size: positionSize };
  if (alert.t1 <= alert.entryPrice) return { tradeable: false, reason: "T1 must be above entry", shares, position_size: positionSize };

  return { tradeable: true, reason: "accepted", shares, position_size: positionSize };
}

async function placeAlpacaBracketOrder(env, alert, shares, overrides = {}) {
  const endpoint = normalizeAlpacaEndpoint(overrides.endpoint || getAlpacaBaseUrl(env));
  const key = overrides.key || env.ALPACA_KEY_ID;
  const secret = overrides.secret || env.ALPACA_SECRET_KEY;
  if (!endpoint || !key || !secret) throw new Error("Alpaca endpoint, key, and secret are required");

  const response = await fetch(`${endpoint}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
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
      take_profit: { limit_price: toMoney(alert.t1) },
      stop_loss: { stop_price: toMoney(alert.stopPrice) },
      client_order_id: buildClientOrderId(alert.ticker),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca order failed with HTTP ${response.status}`);
  return data;
}

async function getAlpacaAccount({ endpoint, key, secret }) {
  if (!endpoint || !key || !secret) throw new Error("Alpaca endpoint, key, and secret are required");
  const response = await fetch(`${normalizeAlpacaEndpoint(endpoint)}/v2/account`, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca account request failed with HTTP ${response.status}`);
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

async function requireClientAuth(request, env) {
  requireStorage(env);
  const body = await request.clone().json().catch(() => ({}));
  const clientId = request.headers.get("x-client-id") || body.clientId;
  const token = request.headers.get("x-client-token") || body.clientToken;
  if (!clientId || !token) throw new Error("Client id and token are required");

  const client = await getClient(env, clientId);
  if (!client) throw new Error("Client not found");
  if ((await sha256Hex(token)) !== client.tokenHash) throw new Error("Invalid client token");
  return { client, body };
}

async function getClient(env, id) {
  const data = await env.AUTOTRADER_KV.get(`client:${id}`, "json");
  return data || null;
}

async function saveClient(env, client) {
  await env.AUTOTRADER_KV.put(`client:${client.id}`, JSON.stringify(client));
}

async function listClients(env) {
  const listed = await env.AUTOTRADER_KV.list({ prefix: "client:" });
  const clients = [];
  for (const key of listed.keys) {
    const client = await env.AUTOTRADER_KV.get(key.name, "json");
    if (client) clients.push(client);
  }
  return clients;
}

function publicClient(client) {
  return {
    id: client.id,
    name: client.name,
    endpoint: client.endpoint,
    enabled: client.enabled,
    minGrade: client.minGrade,
    positionSize: client.positionSize,
    maxTradesPerDay: client.maxTradesPerDay,
    maxDollarsPerDay: client.maxDollarsPerDay,
    pauseUntil: client.pauseUntil,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

async function decryptCredentials(env, client) {
  requireEncryption(env);
  return decryptJson(env, client.credentials);
}

async function writeClientLog(env, clientId, entry) {
  if (!env.AUTOTRADER_KV) return;
  const key = `log:${clientId}:${Date.now()}:${crypto.randomUUID()}`;
  await env.AUTOTRADER_KV.put(key, JSON.stringify({ ...entry, logged_at: new Date().toISOString() }));
}

async function listClientLogs(env, clientId, limit = 50) {
  const listed = await env.AUTOTRADER_KV.list({ prefix: `log:${clientId}:` });
  const keys = listed.keys.slice(-limit).reverse();
  const logs = [];
  for (const key of keys) {
    const log = await env.AUTOTRADER_KV.get(key.name, "json");
    if (log) logs.push(log);
  }
  return logs;
}

async function writeAlertLog(env, entry) {
  if (!env.AUTOTRADER_KV) return;
  await env.AUTOTRADER_KV.put(`alert:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify({ ...entry, logged_at: new Date().toISOString() }));
}

async function getDayStats(env, clientId) {
  if (!env.AUTOTRADER_KV) return { tradeCount: 0, notional: 0 };
  return (await env.AUTOTRADER_KV.get(`day:${clientId}:${todayKey()}`, "json")) || { tradeCount: 0, notional: 0 };
}

async function updateDayStats(env, clientId, stats) {
  await env.AUTOTRADER_KV.put(`day:${clientId}:${todayKey()}`, JSON.stringify(stats), { expirationTtl: 60 * 60 * 48 });
}

async function isTradingEnabled(env) {
  if (env.AUTOTRADER_KV) {
    const value = await env.AUTOTRADER_KV.get("global:enabled");
    return value == null ? true : value === "true";
  }
  return memoryEnabled;
}

async function setTradingEnabled(env, enabled) {
  if (env.AUTOTRADER_KV) {
    await env.AUTOTRADER_KV.put("global:enabled", String(enabled));
    return;
  }
  memoryEnabled = enabled;
}

async function encryptJson(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoded);
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptJson(env, packed) {
  const [ivText, ciphertextText] = String(packed || "").split(".");
  if (!ivText || !ciphertextText) throw new Error("Stored credentials are invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivText) },
    await encryptionKey(env),
    fromBase64Url(ciphertextText),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptionKey(env) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function requireStorage(env) {
  if (!env.AUTOTRADER_KV) throw new Error("AUTOTRADER_KV binding is required");
}

function requireEncryption(env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY secret is required");
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
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

function getAlpacaBaseUrl(env) {
  return normalizeAlpacaEndpoint(env.ALPACA_BASE_URL || DEFAULT_ALPACA_BASE_URL);
}

function normalizeAlpacaEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v2$/i, "");
}

function normalizeMinGrade(value) {
  const grade = String(value || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
  return ["A", "B", "C"].includes(grade) ? grade : DEFAULT_MIN_GRADE;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeOptionalPositiveNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeOptionalPositiveInteger(value) {
  const number = normalizeOptionalPositiveNumber(value);
  return number == null ? null : Math.floor(number);
}

function getSecretPath(env) {
  return String(env.SECRET_PATH || "kalki2026").replace(/^\/+/, "");
}

function getSourceChatId(env) {
  return String(env.SOURCE_CHAT_ID || env.SOURCE_CHANNEL_ID || "").trim();
}

function normalizeGrade(grade) {
  return String(grade || "").trim().toUpperCase();
}

function toMoney(value) {
  return Number(value).toFixed(2);
}

function buildClientOrderId(symbol) {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `kalki-${symbol.toLowerCase()}-${Date.now()}-${random}`.slice(0, 48);
}

function makeToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function endOfTodayIso() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return end.toISOString();
}

function corsJson(data, status = 200) {
  return corsResponse(JSON.stringify(data, null, 2), status, { "content-type": "application/json; charset=utf-8" });
}

function htmlResponse(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-client-id,x-client-token",
    },
  });
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kalki Auto-Trader</title>
  <style>
    :root{color-scheme:dark;--bg:#07090d;--panel:#101722;--panel2:#151f2d;--line:#26364b;--text:#edf4ff;--muted:#8a99ae;--green:#39d98a;--red:#ff5b7c;--blue:#58a6ff;--amber:#ffcc66}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px),var(--bg);background-size:42px 42px;color:var(--text);font:15px/1.45 Inter,ui-sans-serif,system-ui,Arial,sans-serif}
    main{max-width:1180px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}h1{font-size:25px;margin:0}.sub{color:var(--muted);font-size:13px;margin-top:4px}
    .badge{border:1px solid var(--line);background:var(--panel2);border-radius:999px;padding:7px 10px;color:var(--amber);font-size:12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}
    .panel{background:rgba(16,23,34,.94);border:1px solid var(--line);border-radius:8px;padding:16px}.span2{grid-column:span 2}.span4{grid-column:span 4}
    label{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}input,select,textarea{width:100%;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:6px;padding:10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
    textarea{min-height:132px;resize:vertical}.row{display:flex;gap:10px;flex-wrap:wrap}.stack{display:grid;gap:12px}button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:6px;padding:10px 12px;font-weight:800;cursor:pointer}button.primary{background:var(--blue);border-color:var(--blue);color:#06101f}button.danger{color:var(--red)}button.good{color:var(--green)}
    .stat{font:24px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:3px}.hint{color:var(--muted);font-size:12px;margin-top:8px}.hidden{display:none}.log{white-space:pre-wrap;margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d7ea;max-height:360px;overflow:auto}
    @media(max-width:860px){.grid{grid-template-columns:1fr}.span2,.span4{grid-column:auto}header{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>Kalki Auto-Trader</h1><div class="sub">Your alerts · each client’s Alpaca paper account · per-client pause and risk controls</div></div>
    <div class="badge" id="mode">Checking Worker...</div>
  </header>

  <section class="grid">
    <div class="panel"><label>Client</label><div class="stat" id="clientName">--</div></div>
    <div class="panel"><label>Auto-Trading</label><div class="stat" id="enabled">--</div></div>
    <div class="panel"><label>Today Trades</label><div class="stat" id="dayTrades">--</div></div>
    <div class="panel"><label>Today Notional</label><div class="stat" id="dayNotional">--</div></div>

    <div class="panel span2">
      <h3 style="margin-top:0">Connect Alpaca Paper</h3>
      <div class="stack">
        <div><label>Name</label><input id="name" placeholder="Client name"></div>
        <div><label>Endpoint</label><input id="endpoint" value="https://paper-api.alpaca.markets/v2"></div>
        <div><label>API Key ID</label><input id="key" autocomplete="off"></div>
        <div><label>API Secret Key</label><input id="secret" type="password" autocomplete="off"></div>
        <div class="row"><button class="primary" onclick="registerClient()">Save / Connect</button><button onclick="testAlpaca()">Test Alpaca</button><button class="danger" onclick="forgetClient()">Forget This Browser</button></div>
        <div class="hint">The client id and access token are stored in this browser. Alpaca keys are encrypted in Cloudflare KV for automatic Telegram trading.</div>
      </div>
    </div>

    <div class="panel span2">
      <h3 style="margin-top:0">Trade Controls</h3>
      <div class="stack">
        <div class="row"><button class="good" onclick="setEnabled(true)">Auto ON</button><button class="danger" onclick="setEnabled(false)">Auto OFF</button><button onclick="pauseToday()">Pause Today</button><button onclick="clearPause()">Clear Pause</button></div>
        <div><label>Min Grade</label><select id="minGrade"><option>A</option><option selected>B</option><option>C</option></select></div>
        <div><label>Position Size ($)</label><input id="positionSize" type="number" value="1000"></div>
        <div><label>Max Trades Per Day</label><input id="maxTradesPerDay" type="number" placeholder="blank = unlimited"></div>
        <div><label>Max Dollars Per Day</label><input id="maxDollarsPerDay" type="number" placeholder="blank = unlimited"></div>
        <button class="primary" onclick="saveSettings()">Save Controls</button>
      </div>
    </div>

    <div class="panel span2">
      <h3 style="margin-top:0">Manual Test Alert</h3>
      <textarea id="alert">⚡ OKLO
📊 Grade: B | Score: 6/8
📈 Entry: $75.27
🛑 Stop: $70
🎯 T1: $77</textarea>
      <div class="row" style="margin-top:10px"><button onclick="previewAlert()">Preview</button><button class="primary" onclick="manualTrade()">Place Paper Order</button></div>
    </div>

    <div class="panel span2">
      <h3 style="margin-top:0">Logs</h3>
      <div class="row" style="margin-bottom:10px"><button onclick="loadMe()">Refresh Status</button><button onclick="loadLogs()">Refresh Logs</button></div>
      <pre class="log" id="out">Ready.</pre>
    </div>
  </section>
</main>
<script>
const state = {
  clientId: localStorage.getItem('kalkiClientId') || '',
  clientToken: localStorage.getItem('kalkiClientToken') || '',
};
function headers(){return {'content-type':'application/json','x-client-id':state.clientId,'x-client-token':state.clientToken};}
function show(data){document.getElementById('out').textContent=typeof data==='string'?data:JSON.stringify(data,null,2);}
function formSettings(){return {
  name: document.getElementById('name').value,
  endpoint: document.getElementById('endpoint').value,
  key: document.getElementById('key').value,
  secret: document.getElementById('secret').value,
  minGrade: document.getElementById('minGrade').value,
  positionSize: document.getElementById('positionSize').value,
  maxTradesPerDay: document.getElementById('maxTradesPerDay').value,
  maxDollarsPerDay: document.getElementById('maxDollarsPerDay').value,
};}
function applyClient(data){
  const c=data.client;if(!c)return;
  document.getElementById('clientName').textContent=c.name||'Connected';
  document.getElementById('enabled').textContent=c.enabled?'ON':'OFF';
  document.getElementById('dayTrades').textContent=data.day?.tradeCount ?? '--';
  document.getElementById('dayNotional').textContent='$'+Number(data.day?.notional||0).toFixed(2);
  document.getElementById('name').value=c.name||'';
  document.getElementById('endpoint').value=c.endpoint||'https://paper-api.alpaca.markets/v2';
  document.getElementById('minGrade').value=c.minGrade||'B';
  document.getElementById('positionSize').value=c.positionSize||1000;
  document.getElementById('maxTradesPerDay').value=c.maxTradesPerDay||'';
  document.getElementById('maxDollarsPerDay').value=c.maxDollarsPerDay||'';
}
async function health(){
  const r=await fetch('/health');const data=await r.json();
  document.getElementById('mode').textContent=data.kv_bound?'Cloudflare Ready':'KV Missing';
}
async function registerClient(){
  const r=await fetch('/api/client/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(formSettings())});
  const data=await r.json();show(data);
  if(data.ok){state.clientId=data.client.id;state.clientToken=data.token;localStorage.setItem('kalkiClientId',state.clientId);localStorage.setItem('kalkiClientToken',state.clientToken);applyClient(data);}
}
async function loadMe(){
  if(!state.clientId||!state.clientToken){show('Connect Alpaca paper first.');return;}
  const r=await fetch('/api/client/me',{method:'POST',headers:headers(),body:'{}'});const data=await r.json();show(data);if(data.ok)applyClient(data);
}
async function saveSettings(extra={}){
  const body={...formSettings(),...extra};
  if(!body.key)delete body.key;if(!body.secret)delete body.secret;
  const r=await fetch('/api/client/settings',{method:'POST',headers:headers(),body:JSON.stringify(body)});const data=await r.json();show(data);if(data.ok)applyClient(data);
}
async function setEnabled(enabled){await saveSettings({enabled});}
async function pauseToday(){await saveSettings({pauseToday:true});}
async function clearPause(){await saveSettings({clearPause:true});}
async function testAlpaca(){const r=await fetch('/api/client/test-alpaca',{method:'POST',headers:headers(),body:'{}'});show(await r.json());}
async function previewAlert(){const r=await fetch('/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('alert').value})});show(await r.json());}
async function manualTrade(){if(!confirm('Place this Alpaca paper bracket order?'))return;const r=await fetch('/api/client/manual-trade',{method:'POST',headers:headers(),body:JSON.stringify({text:document.getElementById('alert').value})});const data=await r.json();show(data);await loadLogs();await loadMe();}
async function loadLogs(){const r=await fetch('/api/client/logs',{method:'POST',headers:headers(),body:'{}'});show(await r.json());}
function forgetClient(){localStorage.removeItem('kalkiClientId');localStorage.removeItem('kalkiClientToken');location.reload();}
function requireConnected(){
  if(state.clientId&&state.clientToken)return true;
  show('Connect Alpaca paper first with Save / Connect. Then Auto ON/OFF, Pause Today, Test Alpaca, and manual paper orders will work.');
  return false;
}
const originalSaveSettings=saveSettings;
saveSettings=async function(extra={}){if(!requireConnected())return;return originalSaveSettings(extra);}
const originalTestAlpaca=testAlpaca;
testAlpaca=async function(){if(!requireConnected())return;return originalTestAlpaca();}
const originalManualTrade=manualTrade;
manualTrade=async function(){if(!requireConnected())return;return originalManualTrade();}
const originalLoadLogs=loadLogs;
loadLogs=async function(){if(!requireConnected())return;return originalLoadLogs();}
health();loadMe().catch(()=>show('Connect Alpaca paper first.'));
</script>
</body>
</html>`;
}
