const DEFAULT_ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_TRADIER_BASE_URL = "https://sandbox.tradier.com";
const DEFAULT_POSITION_SIZE = 1000;
const DEFAULT_MIN_GRADE = "B";
const DEFAULT_ORDER_TYPE = "limit";
const DEFAULT_TIME_IN_FORCE = "gtc";
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

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
        const clientCount = env.AUTOTRADER_KV ? (await env.AUTOTRADER_KV.list({ prefix: "client:" })).keys.length : null;
        return corsJson({
          ok: true,
          service: "kalki-alpaca-autotrader",
          mode: "multi-client-paper",
          enabled: await isTradingEnabled(env),
          brokers: [
            { id: alpacaBrokerAdapter.id, label: alpacaBrokerAdapter.label, default_endpoint: DEFAULT_ALPACA_BASE_URL },
            { id: tradierBrokerAdapter.id, label: tradierBrokerAdapter.label, default_endpoint: DEFAULT_TRADIER_BASE_URL },
          ],
          alpaca_base_url: getAlpacaBaseUrl(env),
          tradier_base_url: DEFAULT_TRADIER_BASE_URL,
          webhook_path: `/telegram/${getSecretPath(env)}`,
          source_chat_id: getSourceChatId(env) || null,
          has_telegram_bot_token: Boolean(env.TELEGRAM_BOT_TOKEN),
          client_count: clientCount,
          kv_bound: Boolean(env.AUTOTRADER_KV),
        });
      }

      if (request.method === "GET" && url.pathname === "/debug/webhooks") {
        return corsJson({ ok: true, webhooks: await listWebhookLogs(env, 25) });
      }

      if (request.method === "GET" && url.pathname === "/debug/telegram") {
        return corsJson({ ok: true, telegram: await getTelegramWebhookInfo(env) });
      }

      if (request.method === "GET" && url.pathname === "/debug/clients") {
        requireStorage(env);
        const clients = await listClients(env);
        const details = [];
        for (const client of clients) {
          details.push({ ...publicClient(client), day: await getDayStats(env, client.id) });
        }
        return corsJson({ ok: true, clients: details });
      }

      if (request.method === "POST" && (url.pathname === "/test" || url.pathname === "/api/test")) {
        const { text } = await readAlertPayload(request);
        const alert = parseKalkiAlert(text);
        if (!alert) return corsJson({ ok: false, skipped: "not a Kalki alert or missing grade/entry/stop/T1" }, 400);
        return corsJson({ ok: true, preview: true, alert, decision: buildTradeDecision({}, alert) });
      }

      if (request.method === "POST" && url.pathname === "/api/client/register") {
        return await handleRegisterClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/restore") {
        return await handleRestoreClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/me") {
        return await handleGetClient(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/settings") {
        return await handleUpdateClient(request, env);
      }

      if (request.method === "POST" && (url.pathname === "/api/client/test-broker" || url.pathname === "/api/client/test-alpaca")) {
        return await handleClientBrokerTest(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/manual-trade") {
        return await handleClientManualTrade(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/logs") {
        return await handleClientLogs(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/refresh-pnl") {
        return await handleRefreshClientPnl(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/client/delete") {
        return await handleDeleteClient(request, env);
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
  const broker = normalizeBroker(body.broker);
  const adapter = getBrokerAdapter(broker);
  const endpoint = adapter.normalizeEndpoint(body.endpoint);
  const credentials = adapter.credentialsFromBody(body);

  const account = await adapter.getAccount({ endpoint, ...credentials });
  const token = makeToken();
  const accessCode = makeAccessCode();
  const duplicate = await findClientByBrokerAccount(env, broker, account.id);
  if (duplicate) {
    duplicate.name = String(body.name || duplicate.name || account.id || "Client").trim().slice(0, 80);
    duplicate.broker = broker;
    duplicate.accountId = account.id;
    duplicate.endpoint = endpoint;
    duplicate.credentials = await encryptJson(env, credentials);
    addClientSession(duplicate, await sha256Hex(token));
    duplicate.accessCodeHash = await sha256Hex(normalizeAccessCode(accessCode));
    duplicate.enabled = typeof body.enabled === "boolean" ? body.enabled : duplicate.enabled;
    duplicate.minGrade = normalizeMinGrade(body.minGrade || duplicate.minGrade || DEFAULT_MIN_GRADE);
    duplicate.orderType = normalizeBrokerOrderType(broker, body.orderType || duplicate.orderType || DEFAULT_ORDER_TYPE);
    duplicate.timeInForce = normalizeTimeInForce(body.timeInForce || duplicate.timeInForce || DEFAULT_TIME_IN_FORCE);
    duplicate.positionSize = normalizePositiveNumber(body.positionSize, duplicate.positionSize || DEFAULT_POSITION_SIZE);
    duplicate.maxTradesPerDay = normalizeOptionalPositiveInteger(body.maxTradesPerDay) ?? duplicate.maxTradesPerDay ?? null;
    duplicate.maxDollarsPerDay = normalizeOptionalPositiveNumber(body.maxDollarsPerDay) ?? duplicate.maxDollarsPerDay ?? null;
    duplicate.updatedAt = new Date().toISOString();
    await saveClient(env, duplicate);
    await writeClientLog(env, duplicate.id, {
      type: "client_reconnected",
      status: "ok",
      message: "Existing Alpaca account profile reconnected",
    });
    return corsJson({ ok: true, reused: true, client: publicClient(duplicate), token, accessCode, account });
  }

  const client = {
    id: crypto.randomUUID(),
    name: String(body.name || account.id || "Client").trim().slice(0, 80),
    broker,
    accountId: account.id,
    endpoint,
    credentials: await encryptJson(env, credentials),
    tokenHash: await sha256Hex(token),
    tokenHashes: [await sha256Hex(token)],
    accessCodeHash: await sha256Hex(normalizeAccessCode(accessCode)),
    enabled: true,
    minGrade: normalizeMinGrade(body.minGrade || DEFAULT_MIN_GRADE),
    orderType: normalizeBrokerOrderType(broker, body.orderType || DEFAULT_ORDER_TYPE),
    timeInForce: normalizeTimeInForce(body.timeInForce || DEFAULT_TIME_IN_FORCE),
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

  return corsJson({ ok: true, client: publicClient(client), token, accessCode, account });
}

async function handleRestoreClient(request, env) {
  requireStorage(env);
  const body = await request.json().catch(() => ({}));
  const accessCode = normalizeAccessCode(body.accessCode || body.code || "");
  if (!accessCode) return corsJson({ ok: false, error: "Client access code is required" }, 400);

  const client = await findClientByAccessCode(env, accessCode);
  if (!client) return corsJson({ ok: false, error: "Access code not found" }, 404);

  const token = makeToken();
  addClientSession(client, await sha256Hex(token));
  client.updatedAt = new Date().toISOString();
  await saveClient(env, client);
  await writeClientLog(env, client.id, {
    type: "client_restored",
    status: "ok",
    message: "Client access restored in a browser",
  });

  return corsJson({ ok: true, client: publicClient(client), token, day: await getDayStats(env, client.id) });
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
  if (body.orderType != null) client.orderType = normalizeOrderType(body.orderType);
  if (body.timeInForce != null) client.timeInForce = normalizeTimeInForce(body.timeInForce);
  if (body.positionSize != null) client.positionSize = normalizePositiveNumber(body.positionSize, client.positionSize);
  if (Object.hasOwn(body, "maxTradesPerDay")) client.maxTradesPerDay = normalizeOptionalPositiveInteger(body.maxTradesPerDay);
  if (Object.hasOwn(body, "maxDollarsPerDay")) client.maxDollarsPerDay = normalizeOptionalPositiveNumber(body.maxDollarsPerDay);
  if (body.pauseToday === true) client.pauseUntil = endOfTodayIso();
  if (body.pauseToday === false || body.clearPause === true) client.pauseUntil = null;

  if (body.broker || body.endpoint || body.key || body.secret) {
    requireEncryption(env);
    const broker = normalizeBroker(body.broker || client.broker);
    const adapter = getBrokerAdapter(broker);
    const existing = await decryptCredentials(env, client).catch(() => ({}));
    const endpoint = adapter.normalizeEndpoint(body.endpoint || client.endpoint);
    const credentials = adapter.credentialsFromBody(body, existing);
    const account = await adapter.getAccount({ endpoint, ...credentials });
    client.broker = broker;
    client.accountId = account.id;
    client.endpoint = endpoint;
    client.credentials = await encryptJson(env, credentials);
    client.name = client.name || account.id || "Client";
  }
  client.orderType = normalizeBrokerOrderType(client.broker, client.orderType || DEFAULT_ORDER_TYPE);

  client.updatedAt = new Date().toISOString();
  await saveClient(env, client);
  await writeClientLog(env, client.id, {
    type: "settings_updated",
    status: "ok",
    message: "Settings updated",
  });
  return corsJson({ ok: true, client: publicClient(client), day: await getDayStats(env, client.id) });
}

async function handleClientBrokerTest(request, env) {
  const { client } = await requireClientAuth(request, env);
  const credentials = await decryptCredentials(env, client);
  const broker = getBrokerAdapter(client.broker);
  const account = await broker.getAccount({ endpoint: client.endpoint, ...credentials });
  return corsJson({ ok: true, broker: broker.id, account });
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

async function handleRefreshClientPnl(request, env) {
  const { client } = await requireClientAuth(request, env);
  const result = await refreshClientPnl(env, client);
  return corsJson({ ok: true, ...result, day: await getDayStats(env, client.id) });
}

async function handleDeleteClient(request, env) {
  const { client } = await requireClientAuth(request, env);
  await deleteClient(env, client.id);
  return corsJson({ ok: true, deleted_client_id: client.id });
}

async function handleTelegramWebhook(request, env) {
  const { text, chatId, replyText } = await readAlertPayload(request);
  await writeWebhookLog(env, { chatId, textPreview: String(text || "").slice(0, 180), stage: "received" });
  if (!text) {
    await writeWebhookLog(env, { chatId, stage: "skipped", reason: "no message text" });
    return corsJson({ ok: true, skipped: "no message text" });
  }

  const sourceChatId = getSourceChatId(env);
  if (sourceChatId && String(chatId || "") !== sourceChatId) {
    await writeWebhookLog(env, {
      chatId,
      stage: "skipped",
      reason: "different Telegram source chat",
      expectedChatId: sourceChatId,
      textPreview: String(text || "").slice(0, 180),
    });
    return corsJson({
      ok: true,
      skipped: "different Telegram source chat",
      received_chat_id: chatId || null,
      expected_chat_id: sourceChatId,
    });
  }

  const command = parseTradeCommand(text, replyText);
  if (command) {
    if (!(await isTradingEnabled(env))) {
      await sendTelegram(env, `Auto-trader globally paused. Skipped ${command.ticker} ${command.action}.`);
      await writeWebhookLog(env, { chatId, stage: "skipped", reason: "auto-trader globally paused", ticker: command.ticker, command });
      return corsJson({ ok: true, skipped: "auto-trader globally paused", command });
    }

    requireStorage(env);
    const clients = await listClients(env);
    const results = [];
    for (const client of clients) {
      results.push(await executeCommandForClient(env, client, command, { source: "telegram_command", chatId }));
    }

    const completed = results.filter((result) => result.status === "submitted" || result.status === "completed").length;
    await writeWebhookLog(env, { chatId, stage: "command_processed", ticker: command.ticker, command, clientCount: results.length, completed });
    await sendTelegram(env, `Processed ${command.ticker} ${command.label}: ${completed}/${results.length} client command(s) completed.`);
    return corsJson({ ok: true, command, completed_count: completed, client_count: results.length, results });
  }

  const alert = parseKalkiAlert(text);
  if (!alert) {
    await writeWebhookLog(env, { chatId, stage: "skipped", reason: "not a Kalki alert", textPreview: String(text || "").slice(0, 180) });
    return corsJson({ ok: true, skipped: "not a Kalki alert" });
  }

  if (!(await isTradingEnabled(env))) {
    await sendTelegram(env, `Auto-trader globally paused. Skipped ${alert.ticker}.`);
    await writeWebhookLog(env, { chatId, stage: "skipped", reason: "auto-trader globally paused", ticker: alert.ticker });
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
  await writeWebhookLog(env, { chatId, stage: "processed", ticker: alert.ticker, clientCount: results.length, submitted });

  // Forward to Robinhood dashboard worker for MCP-based execution
  await forwardAlertToRobinhoodWorker(env, alert).catch((err) => {
    console.error("Robinhood worker forward failed:", err?.message || err);
  });

  await sendTelegram(env, `Processed ${alert.ticker}: ${submitted}/${results.length} client paper order(s) submitted.`);
  return corsJson({ ok: true, alert, submitted_count: submitted, client_count: results.length, results });
}

async function forwardAlertToRobinhoodWorker(env, alert) {
  const workerUrl = String(env.ROBINHOOD_WORKER_URL || "").trim();
  if (!workerUrl) return; // not configured, skip silently
  const secret = String(env.ROBINHOOD_WORKER_SECRET || "").trim();

  const payload = {
    ticker: alert.ticker,
    grade: alert.grade,
    entry_price: alert.entryPrice,
    stop_price: alert.stopPrice,
    t1: alert.t1,
    raw: alert.raw,
    source: "kalki-autotrader",
    received_at: new Date().toISOString(),
  };

  const res = await fetch(`${workerUrl}/api/alerts/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Kalki-Secret": secret } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Robinhood worker returned ${res.status}: ${text.slice(0, 200)}`);
  }
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
    const broker = getBrokerAdapter(client.broker);
    const brokerOrder = await broker.placeBracketOrder(env, alert, decision.shares, {
      endpoint: client.endpoint,
      orderType: normalizeOrderType(client.orderType || DEFAULT_ORDER_TYPE),
      timeInForce: normalizeTimeInForce(client.timeInForce || DEFAULT_TIME_IN_FORCE),
      ...credentials,
    });

    await updateDayStats(env, client.id, {
      ...dayStats,
      tradeCount: dayStats.tradeCount + 1,
      notional: nextNotional,
    });

    const result = {
      ...base,
      status: "submitted",
      decision,
      alert,
      broker: broker.id,
      broker_order_id: broker.extractOrderId(brokerOrder),
      broker_order: brokerOrder,
      alpaca_order_id: broker.id === "alpaca" ? broker.extractOrderId(brokerOrder) : null,
      alpaca_order: broker.id === "alpaca" ? brokerOrder : null,
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

async function executeCommandForClient(env, client, command, context = {}) {
  const base = {
    client_id: client.id,
    client_name: client.name,
    source: context.source || "unknown",
    ticker: command.ticker,
    command,
    created_at: new Date().toISOString(),
  };

  try {
    if (!client.enabled) return await logTradeSkip(env, client, { ...base, status: "skipped", reason: "client auto-trading off" });
    if (client.pauseUntil && Date.parse(client.pauseUntil) > Date.now()) {
      return await logTradeSkip(env, client, { ...base, status: "skipped", reason: `paused until ${client.pauseUntil}` });
    }
    if (command.action === "move_stop") {
      return await logTradeSkip(env, client, { ...base, status: "skipped", reason: "move stop command is recognized but not automated yet" });
    }

    const credentials = await decryptCredentials(env, client);
    const broker = getBrokerAdapter(client.broker);
    const brokerResult = await broker.executeCommand(env, command, {
      endpoint: client.endpoint,
      ...credentials,
    });

    const result = {
      ...base,
      status: brokerResult.status || "completed",
      broker: broker.id,
      broker_result: brokerResult,
      reason: brokerResult.reason || command.label,
    };
    await writeClientLog(env, client.id, result);
    return result;
  } catch (error) {
    const result = {
      ...base,
      status: "error",
      reason: error instanceof Error ? error.message : "Unknown command error",
    };
    await writeClientLog(env, client.id, result);
    return result;
  }
}

async function refreshClientPnl(env, client) {
  requireStorage(env);
  const brokerId = normalizeBroker(client.broker);
  if (brokerId !== "alpaca") {
    return { broker: brokerId, checked: 0, closed: 0, skipped: "Realized P/L refresh is currently implemented for Alpaca only." };
  }

  const credentials = await decryptCredentials(env, client);
  const endpoint = normalizeAlpacaEndpoint(client.endpoint || DEFAULT_ALPACA_BASE_URL);
  const headers = alpacaHeaders(credentials.key, credentials.secret);
  const logs = await listClientLogs(env, client.id, 250);
  const submittedOrders = logs.filter(
    (log) =>
      log.status === "submitted" &&
      normalizeBroker(log.broker) === "alpaca" &&
      log.broker_order_id &&
      log.alert?.ticker &&
      log.decision?.shares,
  );

  let checked = 0;
  let closed = 0;
  let open = 0;
  let errors = 0;
  const realized = [];

  for (const log of submittedOrders) {
    const markerKey = `pnl:${client.id}:${log.broker_order_id}`;
    if (await env.AUTOTRADER_KV.get(markerKey)) continue;

    checked += 1;
    try {
      const order = await getAlpacaOrder(endpoint, headers, log.broker_order_id);
      const pnl = buildAlpacaRealizedPnl(log, order);
      if (!pnl) {
        open += 1;
        continue;
      }

      const entry = {
        client_id: client.id,
        client_name: client.name,
        source: "alpaca_sync",
        type: "realized_pnl",
        status: pnl.realized_pnl >= 0 ? "profit" : "loss",
        ticker: log.alert.ticker,
        alert: log.alert,
        broker: "alpaca",
        broker_order_id: log.broker_order_id,
        parent_order_id: log.broker_order_id,
        exit_order_id: pnl.exit_order_id,
        entry_fill_price: pnl.entry_fill_price,
        exit_fill_price: pnl.exit_fill_price,
        filled_qty: pnl.filled_qty,
        exit_reason: pnl.exit_reason,
        realized_pnl: pnl.realized_pnl,
        realized_pnl_pct: pnl.realized_pnl_pct,
        message: `${pnl.exit_reason} ${pnl.realized_pnl >= 0 ? "+" : ""}$${pnl.realized_pnl.toFixed(2)} (${pnl.realized_pnl_pct.toFixed(2)}%)`,
        created_at: new Date().toISOString(),
      };
      await writeClientLog(env, client.id, entry);
      await env.AUTOTRADER_KV.put(markerKey, JSON.stringify({ logged_at: entry.created_at, realized_pnl: pnl.realized_pnl }));
      await addRealizedPnlToDayStats(env, client.id, pnl.realized_pnl);
      realized.push(entry);
      closed += 1;
    } catch (error) {
      errors += 1;
      await writeClientLog(env, client.id, {
        client_id: client.id,
        client_name: client.name,
        source: "alpaca_sync",
        type: "realized_pnl_sync",
        status: "error",
        ticker: log.alert?.ticker,
        broker: "alpaca",
        broker_order_id: log.broker_order_id,
        reason: error instanceof Error ? error.message : "P/L refresh failed",
        created_at: new Date().toISOString(),
      });
    }
  }

  return { broker: "alpaca", checked, closed, open, errors, realized };
}

async function getAlpacaOrder(endpoint, headers, orderId) {
  const response = await fetch(`${endpoint}/v2/orders/${encodeURIComponent(orderId)}?nested=true`, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca order lookup failed with HTTP ${response.status}`);
  return data;
}

function buildAlpacaRealizedPnl(log, order) {
  const entryFill = nullableNumber(order?.filled_avg_price) ?? nullableNumber(log.broker_order?.filled_avg_price) ?? nullableNumber(log.alert?.entryPrice);
  const entryQty = nullableNumber(order?.filled_qty) ?? nullableNumber(order?.qty) ?? nullableNumber(log.decision?.shares);
  if (!entryFill || !entryQty) return null;

  const legs = Array.isArray(order?.legs) ? order.legs : [];
  const filledExit = legs.find((leg) => String(leg.side || "").toLowerCase() === "sell" && String(leg.status || "").toLowerCase() === "filled" && nullableNumber(leg.filled_avg_price));
  if (!filledExit) return null;

  const exitFill = nullableNumber(filledExit.filled_avg_price);
  const exitQty = nullableNumber(filledExit.filled_qty) ?? nullableNumber(filledExit.qty) ?? entryQty;
  if (!exitFill || !exitQty) return null;

  const filledQty = Math.min(entryQty, exitQty);
  const realizedPnl = roundMoney((exitFill - entryFill) * filledQty);
  return {
    exit_order_id: filledExit.id || null,
    entry_fill_price: entryFill,
    exit_fill_price: exitFill,
    filled_qty: filledQty,
    exit_reason: alpacaExitReason(filledExit, log.alert),
    realized_pnl: realizedPnl,
    realized_pnl_pct: entryFill ? ((exitFill - entryFill) / entryFill) * 100 : 0,
  };
}

function alpacaExitReason(order, alert) {
  const type = String(order?.type || "").toLowerCase();
  const limitPrice = nullableNumber(order?.limit_price);
  const stopPrice = nullableNumber(order?.stop_price);
  if (type === "limit" || (limitPrice && alert?.t1 && Math.abs(limitPrice - alert.t1) < 0.02)) return "T1";
  if (type === "stop" || type === "stop_limit" || (stopPrice && alert?.stopPrice && Math.abs(stopPrice - alert.stopPrice) < 0.02)) return "Stop";
  return "Exit";
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
    replyText: post?.reply_to_message?.text || post?.reply_to_message?.caption || "",
    chatId: post?.chat?.id != null ? String(post.chat.id) : null,
  };
}

function parseTradeCommand(text, replyText = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const ticker = extractTickerFromText(replyText) || extractTickerFromCommand(raw);
  if (!ticker) return null;

  if (/\b(move|raise|update)\s+stop\b|\bstop\s+(to\s+)?(breakeven|break even|be)\b/i.test(raw)) {
    return { action: "move_stop", ticker, percent: null, label: "move stop", raw, replyText };
  }

  if (/\bcancel\b|\bcancel\s+orders?\b/i.test(raw)) {
    return { action: "cancel_orders", ticker, percent: null, label: "cancel orders", raw, replyText };
  }

  if (/\b(close|exit|sell\s+all|full\s+exit)\b/i.test(raw)) {
    return { action: "close", ticker, percent: 100, label: "close position", raw, replyText };
  }

  if (/\b(take\s+profits?|take\s+profit|trim|scale\s+out|sell\s+(half|partial|some))\b/i.test(raw)) {
    const percent = extractCommandPercent(raw) || 50;
    return { action: "trim", ticker, percent: clampNumber(percent, 1, 100), label: `trim ${clampNumber(percent, 1, 100)}%`, raw, replyText };
  }

  return null;
}

function extractTickerFromText(text) {
  const raw = String(text || "");
  const match = raw.match(/(?:^|\n)\s*⚡\s*\*?([A-Z][A-Z0-9.]{0,9})\*?/i)
    || raw.match(/\bTicker:\s*([A-Z]{1,10})\b/i);
  return match ? match[1].toUpperCase().replace(/[^A-Z0-9.]/g, "") : "";
}

function extractTickerFromCommand(text) {
  const raw = String(text || "").toUpperCase();
  const explicit = raw.match(/\b(?:FOR|ON|TICKER)\s+([A-Z][A-Z0-9.]{0,9})\b/)
    || raw.match(/\b(?:TRIM|CLOSE|EXIT|CANCEL)\s+([A-Z][A-Z0-9.]{0,9})\b/);
  if (explicit) return explicit[1].replace(/[^A-Z0-9.]/g, "");
  const leading = raw.match(/^([A-Z][A-Z0-9.]{0,9})\b/);
  if (leading && !["TAKE", "TRIM", "CLOSE", "EXIT", "SELL", "CANCEL", "MOVE", "STOP", "TARGET", "PROFIT", "PROFITS", "REACHED"].includes(leading[1])) {
    return leading[1].replace(/[^A-Z0-9.]/g, "");
  }
  return "";
}

function extractCommandPercent(text) {
  const raw = String(text || "");
  const pct = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Number.parseFloat(pct[1]);
  if (/\bhalf\b/i.test(raw)) return 50;
  if (/\bquarter\b/i.test(raw)) return 25;
  return null;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
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

function getBrokerAdapter(value) {
  const broker = normalizeBroker(value);
  if (broker === "tradier") return tradierBrokerAdapter;
  return alpacaBrokerAdapter;
}

const alpacaBrokerAdapter = {
  id: "alpaca",
  label: "Alpaca Paper",
  normalizeEndpoint(value) {
    return normalizeAlpacaEndpoint(value || DEFAULT_ALPACA_BASE_URL);
  },
  credentialsFromBody(body, existing = {}) {
    const key = String(body.key || existing.key || "").trim();
    const secret = String(body.secret || existing.secret || "").trim();
    if (!key || !secret) throw new Error("Alpaca key id and secret key are required");
    return { key, secret };
  },
  async getAccount({ endpoint, key, secret }) {
    return await getAlpacaAccount({ endpoint, key, secret });
  },
  async placeBracketOrder(env, alert, shares, credentials) {
    return await placeAlpacaBracketOrder(env, alert, shares, credentials);
  },
  async executeCommand(env, command, credentials) {
    return await executeAlpacaCommand(env, command, credentials);
  },
  extractOrderId(order) {
    return order?.id || order?.client_order_id || null;
  },
};

const tradierBrokerAdapter = {
  id: "tradier",
  label: "Tradier Paper",
  normalizeEndpoint(value) {
    return normalizeTradierEndpoint(value || DEFAULT_TRADIER_BASE_URL);
  },
  credentialsFromBody(body, existing = {}) {
    const accountId = String(body.key || body.accountId || existing.accountId || "").trim();
    const token = String(body.secret || body.token || existing.token || "").trim();
    if (!accountId || !token) throw new Error("Tradier account id and access token are required");
    return { accountId, token };
  },
  async getAccount({ endpoint, accountId, token }) {
    return await getTradierAccount({ endpoint, accountId, token });
  },
  async placeBracketOrder(env, alert, shares, credentials) {
    return await placeTradierBracketOrder(env, alert, shares, credentials);
  },
  async executeCommand(env, command, credentials) {
    return await executeTradierCommand(env, command, credentials);
  },
  extractOrderId(order) {
    return order?.order?.id || order?.id || null;
  },
};

async function placeAlpacaBracketOrder(env, alert, shares, overrides = {}) {
  const endpoint = normalizeAlpacaEndpoint(overrides.endpoint || getAlpacaBaseUrl(env));
  const key = overrides.key || env.ALPACA_KEY_ID;
  const secret = overrides.secret || env.ALPACA_SECRET_KEY;
  const orderType = normalizeOrderType(overrides.orderType);
  const timeInForce = normalizeTimeInForce(overrides.timeInForce);
  if (!endpoint || !key || !secret) throw new Error("Alpaca endpoint, key, and secret are required");
  const order = {
    symbol: alert.ticker,
    qty: String(shares),
    side: "buy",
    type: orderType,
    time_in_force: timeInForce,
    order_class: "bracket",
    take_profit: { limit_price: toMoney(alert.t1) },
    stop_loss: { stop_price: toMoney(alert.stopPrice) },
    client_order_id: buildClientOrderId(alert.ticker),
  };
  if (orderType === "limit") order.limit_price = toMoney(alert.entryPrice);

  const response = await fetch(`${endpoint}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(order),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca order failed with HTTP ${response.status}`);
  return data;
}

async function placeTradierBracketOrder(env, alert, shares, overrides = {}) {
  const endpoint = normalizeTradierEndpoint(overrides.endpoint || DEFAULT_TRADIER_BASE_URL);
  const accountId = overrides.accountId;
  const token = overrides.token;
  const orderType = normalizeOrderType(overrides.orderType);
  const timeInForce = normalizeTimeInForce(overrides.timeInForce);
  if (!endpoint || !accountId || !token) throw new Error("Tradier endpoint, account id, and token are required");
  if (orderType === "market") throw new Error("Tradier OTOCO entry leg does not support market orders; use Limit at Entry");

  const body = new URLSearchParams({
    class: "otoco",
    duration: timeInForce,
    "symbol[0]": alert.ticker,
    "side[0]": "buy",
    "quantity[0]": String(shares),
    "type[0]": orderType,
    "symbol[1]": alert.ticker,
    "side[1]": "sell",
    "quantity[1]": String(shares),
    "type[1]": "limit",
    "price[1]": toMoney(alert.t1),
    "symbol[2]": alert.ticker,
    "side[2]": "sell",
    "quantity[2]": String(shares),
    "type[2]": "stop",
    "stop[2]": toMoney(alert.stopPrice),
    tag: buildClientOrderId(alert.ticker),
  });
  if (orderType === "limit") body.set("price[0]", toMoney(alert.entryPrice));

  const response = await fetch(`${endpoint}/v1/accounts/${encodeURIComponent(accountId)}/orders`, {
    method: "POST",
    headers: tradierHeaders(token, true),
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.errors?.error?.[0] || data?.errors?.error || data?.error || `Tradier order failed with HTTP ${response.status}`);
  return data;
}

async function getAlpacaAccount({ endpoint, key, secret }) {
  if (!endpoint || !key || !secret) throw new Error("Alpaca endpoint, key, and secret are required");
  const response = await fetch(`${normalizeAlpacaEndpoint(endpoint)}/v2/account`, {
    method: "GET",
    headers: alpacaHeaders(key, secret),
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

async function executeAlpacaCommand(env, command, overrides = {}) {
  const endpoint = normalizeAlpacaEndpoint(overrides.endpoint || getAlpacaBaseUrl(env));
  const key = overrides.key || env.ALPACA_KEY_ID;
  const secret = overrides.secret || env.ALPACA_SECRET_KEY;
  if (!endpoint || !key || !secret) throw new Error("Alpaca endpoint, key, and secret are required");
  const headers = alpacaHeaders(key, secret, true);

  if (command.action === "cancel_orders") {
    const canceled = await cancelAlpacaOpenOrdersForSymbol(endpoint, headers, command.ticker);
    return { status: "completed", action: command.action, canceled_count: canceled.length, canceled };
  }

  const position = await getAlpacaPosition(endpoint, headers, command.ticker);
  const qty = Math.abs(Number.parseFloat(position?.qty || "0"));
  if (!Number.isFinite(qty) || qty <= 0) {
    return { status: "skipped", action: command.action, reason: `no open ${command.ticker} position` };
  }

  const side = Number.parseFloat(position.qty) >= 0 ? "sell" : "buy";
  const commandQty = command.action === "close" ? qty : Math.max(1, Math.floor(qty * (command.percent || 50) / 100));
  const finalQty = Math.min(qty, commandQty);
  const canceled = await cancelAlpacaOpenOrdersForSymbol(endpoint, headers, command.ticker);
  const response = await fetch(`${endpoint}/v2/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      symbol: command.ticker,
      qty: String(finalQty),
      side,
      type: "market",
      time_in_force: "day",
      client_order_id: buildClientOrderId(`${command.ticker}-${command.action}`),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca ${command.action} failed with HTTP ${response.status}`);
  return { status: "submitted", action: command.action, sold_qty: finalQty, canceled_count: canceled.length, canceled, order: data };
}

async function getAlpacaPosition(endpoint, headers, ticker) {
  const response = await fetch(`${endpoint}/v2/positions/${encodeURIComponent(ticker)}`, { headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(data?.message || data?.error || `Alpaca position lookup failed with HTTP ${response.status}`);
  return data;
}

async function cancelAlpacaOpenOrdersForSymbol(endpoint, headers, ticker) {
  const response = await fetch(`${endpoint}/v2/orders?status=open&symbols=${encodeURIComponent(ticker)}&limit=100`, { headers });
  const orders = await response.json().catch(() => []);
  if (!response.ok) throw new Error(orders?.message || orders?.error || `Alpaca open orders lookup failed with HTTP ${response.status}`);
  const canceled = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    if (String(order.symbol || "").toUpperCase() !== ticker) continue;
    const cancelResponse = await fetch(`${endpoint}/v2/orders/${encodeURIComponent(order.id)}`, {
      method: "DELETE",
      headers,
    });
    if (cancelResponse.ok || cancelResponse.status === 404) canceled.push(order.id);
  }
  return canceled;
}

async function getTradierAccount({ endpoint, accountId, token }) {
  if (!endpoint || !accountId || !token) throw new Error("Tradier endpoint, account id, and token are required");
  const response = await fetch(`${normalizeTradierEndpoint(endpoint)}/v1/accounts/${encodeURIComponent(accountId)}/balances`, {
    method: "GET",
    headers: tradierHeaders(token),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.errors?.error?.[0] || data?.errors?.error || data?.error || `Tradier account request failed with HTTP ${response.status}`);
  const balances = data.balances || {};
  return {
    id: accountId,
    status: "ok",
    currency: "USD",
    buying_power: balances.stock_buying_power || balances.option_buying_power || balances.total_cash || null,
    portfolio_value: balances.total_equity || null,
    raw: balances,
  };
}

async function executeTradierCommand(env, command, overrides = {}) {
  const endpoint = normalizeTradierEndpoint(overrides.endpoint || DEFAULT_TRADIER_BASE_URL);
  const accountId = overrides.accountId;
  const token = overrides.token;
  if (!endpoint || !accountId || !token) throw new Error("Tradier endpoint, account id, and token are required");

  if (command.action === "cancel_orders") {
    return { status: "skipped", action: command.action, reason: "Tradier cancel-by-symbol is not automated yet" };
  }

  const position = await getTradierPosition(endpoint, accountId, token, command.ticker);
  const qty = Math.abs(Number.parseFloat(position?.quantity || position?.qty || "0"));
  if (!Number.isFinite(qty) || qty <= 0) {
    return { status: "skipped", action: command.action, reason: `no open ${command.ticker} position` };
  }
  const commandQty = command.action === "close" ? qty : Math.max(1, Math.floor(qty * (command.percent || 50) / 100));
  const finalQty = Math.min(qty, commandQty);
  const body = new URLSearchParams({
    class: "equity",
    symbol: command.ticker,
    side: "sell",
    quantity: String(finalQty),
    type: "market",
    duration: "day",
    tag: buildClientOrderId(`${command.ticker}-${command.action}`),
  });
  const response = await fetch(`${endpoint}/v1/accounts/${encodeURIComponent(accountId)}/orders`, {
    method: "POST",
    headers: tradierHeaders(token, true),
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.errors?.error?.[0] || data?.errors?.error || data?.error || `Tradier ${command.action} failed with HTTP ${response.status}`);
  return { status: "submitted", action: command.action, sold_qty: finalQty, order: data };
}

async function getTradierPosition(endpoint, accountId, token, ticker) {
  const response = await fetch(`${endpoint}/v1/accounts/${encodeURIComponent(accountId)}/positions`, {
    headers: tradierHeaders(token),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.errors?.error?.[0] || data?.errors?.error || data?.error || `Tradier positions lookup failed with HTTP ${response.status}`);
  const positions = data?.positions?.position;
  const list = Array.isArray(positions) ? positions : positions ? [positions] : [];
  return list.find((position) => String(position.symbol || "").toUpperCase() === ticker) || null;
}

function tradierHeaders(token, form = false) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return headers;
}

async function requireClientAuth(request, env) {
  requireStorage(env);
  const body = await request.clone().json().catch(() => ({}));
  const clientId = request.headers.get("x-client-id") || body.clientId;
  const token = request.headers.get("x-client-token") || body.clientToken;
  if (!clientId || !token) throw new Error("Client id and token are required");

  const client = await getClient(env, clientId);
  if (!client) throw new Error("Client not found");
  const tokenHash = await sha256Hex(token);
  const validHashes = Array.isArray(client.tokenHashes) ? client.tokenHashes : [];
  if (client.tokenHash) validHashes.push(client.tokenHash);
  if (!validHashes.includes(tokenHash)) throw new Error("Invalid client token");
  return { client, body };
}

async function getClient(env, id) {
  const data = await env.AUTOTRADER_KV.get(`client:${id}`, "json");
  return data || null;
}

async function saveClient(env, client) {
  await env.AUTOTRADER_KV.put(`client:${client.id}`, JSON.stringify(client));
}

async function deleteClient(env, id) {
  await env.AUTOTRADER_KV.delete(`client:${id}`);
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

async function findClientByBrokerAccount(env, broker, accountId) {
  if (!accountId) return null;
  const normalizedBroker = normalizeBroker(broker);
  const clients = await listClients(env);
  for (const client of clients) {
    if (normalizeBroker(client.broker) === normalizedBroker && client.accountId === accountId) return client;
  }

  if (normalizedBroker !== "alpaca") return null;
  for (const client of clients) {
    try {
      if (normalizeBroker(client.broker) !== "alpaca") continue;
      const credentials = await decryptCredentials(env, client);
      const account = await getAlpacaAccount({ endpoint: client.endpoint, ...credentials });
      if (account.id === accountId) {
        client.accountId = account.id;
        await saveClient(env, client);
        return client;
      }
    } catch (error) {
      console.error("Duplicate client lookup failed", { client_id: client.id, message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  return null;
}

async function findClientByAccessCode(env, accessCode) {
  const accessCodeHash = await sha256Hex(normalizeAccessCode(accessCode));
  const clients = await listClients(env);
  return clients.find((client) => client.accessCodeHash === accessCodeHash) || null;
}

function addClientSession(client, tokenHash) {
  const hashes = Array.isArray(client.tokenHashes) ? client.tokenHashes : [];
  if (client.tokenHash) hashes.push(client.tokenHash);
  hashes.push(tokenHash);
  client.tokenHash = tokenHash;
  client.tokenHashes = [...new Set(hashes)].slice(-10);
}

function publicClient(client) {
  return {
    id: client.id,
    name: client.name,
    broker: normalizeBroker(client.broker),
    brokerLabel: getBrokerAdapter(client.broker).label,
    accountId: client.accountId || null,
    endpoint: client.endpoint,
    enabled: client.enabled,
    minGrade: client.minGrade,
    orderType: normalizeBrokerOrderType(client.broker, client.orderType || DEFAULT_ORDER_TYPE),
    timeInForce: normalizeTimeInForce(client.timeInForce || DEFAULT_TIME_IN_FORCE),
    positionSize: client.positionSize,
    maxTradesPerDay: client.maxTradesPerDay,
    maxDollarsPerDay: client.maxDollarsPerDay,
    pauseUntil: client.pauseUntil,
    hasAccessCode: Boolean(client.accessCodeHash),
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

async function writeWebhookLog(env, entry) {
  if (!env.AUTOTRADER_KV) return;
  await env.AUTOTRADER_KV.put(
    `webhook:${Date.now()}:${crypto.randomUUID()}`,
    JSON.stringify({ ...entry, logged_at: new Date().toISOString() }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
}

async function listWebhookLogs(env, limit = 25) {
  if (!env.AUTOTRADER_KV) return [];
  const listed = await env.AUTOTRADER_KV.list({ prefix: "webhook:" });
  const keys = listed.keys.slice(-limit).reverse();
  const logs = [];
  for (const key of keys) {
    const log = await env.AUTOTRADER_KV.get(key.name, "json");
    if (log) logs.push(log);
  }
  return logs;
}

async function getDayStats(env, clientId) {
  if (!env.AUTOTRADER_KV) return emptyDayStats();
  return { ...emptyDayStats(), ...((await env.AUTOTRADER_KV.get(`day:${clientId}:${todayKey()}`, "json")) || {}) };
}

async function updateDayStats(env, clientId, stats) {
  await env.AUTOTRADER_KV.put(`day:${clientId}:${todayKey()}`, JSON.stringify(stats), { expirationTtl: 60 * 60 * 48 });
}

async function addRealizedPnlToDayStats(env, clientId, amount) {
  const stats = await getDayStats(env, clientId);
  await updateDayStats(env, clientId, {
    ...stats,
    realizedPnl: roundMoney((Number(stats.realizedPnl) || 0) + (Number(amount) || 0)),
    closedTrades: (Number(stats.closedTrades) || 0) + 1,
  });
}

function emptyDayStats() {
  return { tradeCount: 0, notional: 0, realizedPnl: 0, closedTrades: 0 };
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

async function getTelegramWebhookInfo(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return { configured: false, error: "TELEGRAM_BOT_TOKEN is missing" };
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) return { configured: false, error: data.description || `Telegram HTTP ${response.status}` };
  const result = data.result || {};
  return {
    configured: Boolean(result.url),
    url: result.url || "",
    has_custom_certificate: Boolean(result.has_custom_certificate),
    pending_update_count: result.pending_update_count || 0,
    last_error_date: result.last_error_date || null,
    last_error_message: result.last_error_message || null,
    max_connections: result.max_connections || null,
    allowed_updates: result.allowed_updates || [],
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

function getAlpacaBaseUrl(env) {
  return normalizeAlpacaEndpoint(env.ALPACA_BASE_URL || DEFAULT_ALPACA_BASE_URL);
}

function normalizeAlpacaEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v2$/i, "");
}

function normalizeTradierEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function normalizeBroker(value) {
  return String(value || "alpaca").trim().toLowerCase() === "tradier" ? "tradier" : "alpaca";
}

function alpacaHeaders(key, secret, json = false) {
  const headers = {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    Accept: "application/json",
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeMinGrade(value) {
  const grade = String(value || DEFAULT_MIN_GRADE).trim().toUpperCase().charAt(0);
  return ["A", "B", "C"].includes(grade) ? grade : DEFAULT_MIN_GRADE;
}

function normalizeOrderType(value) {
  return String(value || DEFAULT_ORDER_TYPE).trim().toLowerCase() === "market" ? "market" : DEFAULT_ORDER_TYPE;
}

function normalizeTimeInForce(value) {
  return String(value || DEFAULT_TIME_IN_FORCE).trim().toLowerCase() === "day" ? "day" : DEFAULT_TIME_IN_FORCE;
}

function normalizeBrokerOrderType(broker, value) {
  return normalizeBroker(broker) === "tradier" ? DEFAULT_ORDER_TYPE : normalizeOrderType(value);
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

function makeAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `KALKI-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function normalizeAccessCode(value) {
  const cleaned = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("KALKI")) {
    const body = cleaned.slice(5);
    return body ? `KALKI-${body}` : "";
  }
  return `KALKI-${cleaned}`;
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
    :root{color-scheme:dark;--bg:#050a0f;--surface:#0a1520;--surface2:#0f1e2e;--border:#1a3040;--accent:#00d4ff;--accent2:#00ff88;--danger:#ff3b6b;--warn:#ffb347;--text:#c8dde8;--muted:#5f788a;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--ui:Inter,system-ui,Arial,sans-serif}
    *{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:linear-gradient(rgba(0,212,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.035) 1px,transparent 1px),var(--bg);background-size:40px 40px;color:var(--text);font:14px/1.45 var(--ui)}
    .container{max-width:1320px;margin:0 auto;padding:18px 20px 36px}header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:4px 0 16px;border-bottom:1px solid var(--border);margin-bottom:20px}
    .logo{display:flex;gap:12px;align-items:center}.logo-icon{width:38px;height:38px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#001018;font-weight:900;box-shadow:0 0 22px rgba(0,212,255,.25)}h1{font-size:22px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);line-height:1}.logo span{display:block;margin-top:5px;font:10px var(--mono);letter-spacing:4px;color:var(--muted);text-transform:uppercase}
    .header-actions{display:flex;align-items:center;gap:12px}.mode-badge{font:11px var(--mono);letter-spacing:2px;padding:5px 10px;border:1px solid var(--warn);border-radius:4px;color:var(--warn);background:rgba(255,179,71,.08);text-transform:uppercase}.icon-btn{width:38px;height:38px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--accent);cursor:pointer;font-size:17px}.bot-toggle{position:relative;display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:6px;border:1px solid var(--accent2);background:rgba(0,255,136,.05);color:var(--accent2);font:12px var(--mono);font-weight:900;letter-spacing:1px;text-transform:uppercase;cursor:pointer}.bot-toggle:disabled{opacity:.55;cursor:not-allowed}.bot-toggle.off{border-color:var(--danger);color:var(--danger);background:rgba(255,59,107,.06)}.bot-switch{width:42px;height:22px;border-radius:999px;background:rgba(0,255,136,.16);border:1px solid var(--border);position:relative}.bot-switch:after{content:'';position:absolute;top:3px;left:23px;width:14px;height:14px;border-radius:50%;background:var(--accent2);transition:left .2s,background .2s}.bot-toggle.off .bot-switch{background:rgba(255,59,107,.12)}.bot-toggle.off .bot-switch:after{left:3px;background:var(--danger)}
    .stats{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:18px}.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;position:relative;overflow:hidden}.stat-card:after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--accent);opacity:.55}.stat-card.green:after{background:var(--accent2)}.stat-card.warn:after{background:var(--warn)}.stat-label{font:10px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:7px}.stat-value{font:27px var(--mono);font-weight:800;color:var(--text);line-height:1}.stat-value.accent{color:var(--accent)}.stat-value.green{color:var(--accent2)}.stat-value.red{color:var(--danger)}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}.panel-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--surface2);border-bottom:1px solid var(--border)}.panel-title{font:12px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--accent)}.panel-body{min-height:160px;max-height:310px;overflow:auto}.empty{padding:34px 16px;text-align:center;color:var(--muted);font:12px var(--mono);letter-spacing:1px}
    .alert-item,.pos-item{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:13px 16px;border-bottom:1px solid rgba(26,48,64,.55)}.badge-grade{width:38px;height:38px;border-radius:6px;display:grid;place-items:center;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.12);color:var(--accent);font-weight:900}.ticker{font:15px var(--mono);font-weight:900;color:#fff}.meta{font:11px var(--mono);color:var(--muted);margin-top:3px}.prices{display:flex;gap:10px;flex-wrap:wrap;font:11px var(--mono);margin-top:4px}.entry{color:var(--text)}.stop{color:var(--danger)}.target{color:var(--accent2)}.pill{font:10px var(--mono);letter-spacing:1px;padding:4px 8px;border-radius:4px;border:1px solid rgba(0,255,136,.25);color:var(--accent2);background:rgba(0,255,136,.08);text-transform:uppercase}.pill.skip{border-color:rgba(255,179,71,.25);color:var(--warn);background:rgba(255,179,71,.08)}.pill.err{border-color:rgba(255,59,107,.25);color:var(--danger);background:rgba(255,59,107,.08)}
    .manual{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:18px;margin-bottom:18px}.manual-title{font:11px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}.manual-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:start}textarea,input,select{width:100%;border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:6px;padding:10px 12px;font:13px var(--mono);outline:none}textarea{min-height:92px;resize:vertical}textarea:focus,input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(0,212,255,.08)}button{border:1px solid var(--border);background:var(--surface2);color:var(--accent);border-radius:6px;padding:10px 15px;font-weight:800;cursor:pointer;white-space:nowrap}button.primary{background:linear-gradient(135deg,var(--accent),#0099cc);border-color:transparent;color:#001018}button.good{color:var(--accent2);border-color:rgba(0,255,136,.35)}button.danger{color:var(--danger);border-color:rgba(255,59,107,.35)}button.muted{color:var(--muted)}
    .log-table{width:100%;border-collapse:collapse;font:12px var(--mono)}.log-table th{position:sticky;top:0;background:var(--surface2);color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;text-align:left;padding:10px 16px}.log-table td{padding:10px 16px;border-top:1px solid rgba(26,48,64,.5)}.log-open{color:var(--accent)}.log-ok{color:var(--accent2)}.log-skip{color:var(--warn)}.log-err{color:var(--danger)}
    .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;z-index:20;padding:18px}.modal-backdrop.open{display:flex}.modal{width:min(760px,100%);max-height:92vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 24px 90px rgba(0,0,0,.55)}.modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:var(--surface2);border-bottom:1px solid var(--border)}.modal-title{font:12px var(--mono);letter-spacing:2px;color:var(--accent);text-transform:uppercase}.modal-body{padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:14px}.field.full{grid-column:1/-1}.restore-row{display:grid;grid-template-columns:1fr auto;gap:10px}.access-code{display:none;border:1px solid rgba(0,255,136,.3);background:rgba(0,255,136,.06);color:var(--accent2);border-radius:8px;padding:12px;font:16px var(--mono);font-weight:900;letter-spacing:1px}.access-code.show{display:block}.modal-actions{display:flex;gap:10px;justify-content:flex-end;padding:14px 16px;border-top:1px solid var(--border);background:rgba(15,30,46,.55)}.hint{font:11px var(--mono);line-height:1.5;color:var(--muted)}#toast{position:fixed;right:22px;bottom:22px;display:grid;gap:8px;z-index:30}.toast{background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;font:12px var(--mono);max-width:360px}.toast.err{border-left-color:var(--danger)}.toast.ok{border-left-color:var(--accent2)}.toast.warn{border-left-color:var(--warn)}
    @media(max-width:860px){.stats,.grid{grid-template-columns:1fr}.manual-row,.modal-body{grid-template-columns:1fr}.header-actions{flex-wrap:wrap;justify-content:flex-end}.stat-value{font-size:23px}}
  </style>
</head>
<body>
<main class="container">
  <header>
    <div class="logo"><div class="logo-icon">⚡</div><div><h1>Kalki Auto-Trader</h1><span>Algorithmic Execution Engine</span></div></div>
    <div class="header-actions"><div class="mode-badge" id="mode">Cloudflare</div><button class="icon-btn" onclick="openSettings()" title="Settings">⚙</button><button class="bot-toggle off" id="botToggle" onclick="toggleBot()" disabled><span class="bot-switch"></span><span id="botToggleLabel">Not Connected</span></button></div>
  </header>

  <section class="stats">
    <div class="stat-card"><div class="stat-label">Client</div><div class="stat-value" id="clientName">--</div></div>
    <div class="stat-card green"><div class="stat-label">Auto-Trading</div><div class="stat-value" id="enabled">--</div></div>
    <div class="stat-card"><div class="stat-label">Today Trades</div><div class="stat-value accent" id="dayTrades">0</div></div>
    <div class="stat-card green"><div class="stat-label">Today Notional</div><div class="stat-value green" id="dayNotional">$0.00</div></div>
    <div class="stat-card green"><div class="stat-label">Today P/L</div><div class="stat-value green" id="dayPnl">$0.00</div></div>
    <div class="stat-card warn"><div class="stat-label">Min Grade</div><div class="stat-value" id="gradeStat">B</div></div>
  </section>

  <section class="grid">
    <div class="panel span2">
      <div class="panel-header"><span class="panel-title">⚡ Alert Feed</span><span class="pill" id="feedState">Listening</span></div>
      <div class="panel-body" id="alertFeed"><div class="empty">Waiting for Telegram alerts...</div></div>
    </div>
    <div class="panel span2">
      <div class="panel-header"><span class="panel-title">📊 Recent Orders</span><span class="meta" id="orderCount">0 logs</span></div>
      <div class="panel-body" id="orders"><div class="empty">No orders yet</div></div>
    </div>
  </section>

  <section class="manual">
    <div class="manual-title">🧪 Test Alert (Paste Kalki Message)</div>
    <div class="manual-row">
      <textarea id="alert">⚡ OKLO
📊 Grade: B | Score: 6/8
📈 Entry: $75.27
🛑 Stop: $70
🎯 T1: $77</textarea>
      <button onclick="previewAlert()">Preview</button>
      <button class="primary" onclick="manualTrade()">Place Paper Order</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-header"><span class="panel-title">📋 Trade Log</span><div><button onclick="refreshPnl()">Refresh P/L</button><button onclick="loadLogs()">Refresh</button></div></div>
    <table class="log-table"><thead><tr><th>Time (ET)</th><th>Ticker</th><th>Source</th><th>Status</th><th>Detail</th></tr></thead><tbody id="tradeLog"><tr><td colspan="5" class="empty">No trades yet</td></tr></tbody></table>
  </section>
</main>

<div class="modal-backdrop" id="settingsModal" onclick="closeSettings(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-head"><div class="modal-title">Settings</div><button onclick="closeSettings()">×</button></div>
    <div class="modal-body">
      <div class="field full"><label>Client Access Code</label><div class="restore-row"><input id="accessCodeInput" placeholder="KALKI-XXXX-XXXX-XXXX" autocomplete="off"><button onclick="restoreClient()">Restore</button></div></div>
      <div class="field full access-code" id="newAccessCode"></div>
      <div><label>Broker</label><select id="broker" onchange="brokerChanged()"><option value="alpaca" selected>Alpaca Paper</option><option value="tradier">Tradier Paper</option></select></div>
      <div><label>Name</label><input id="name" placeholder="Client name"></div>
      <div><label>Endpoint Base URL</label><input id="endpoint" value="https://paper-api.alpaca.markets"></div>
      <div><label id="keyLabel">API Key ID</label><input id="key" autocomplete="off" placeholder="saved - leave blank to keep"></div>
      <div><label id="secretLabel">API Secret Key</label><input id="secret" type="password" autocomplete="off" placeholder="saved - leave blank to keep"></div>
      <div><label>Min Grade</label><select id="minGrade"><option>A</option><option selected>B</option><option>C</option></select></div>
      <div><label>Entry Order Type</label><select id="orderType"><option value="limit" selected>Limit at Entry</option><option value="market">Market</option></select></div>
      <div><label>Order Duration</label><select id="timeInForce"><option value="gtc" selected>GTC - Keep Open</option><option value="day">Day Only</option></select></div>
      <div><label>Position Size ($)</label><input id="positionSize" type="number" value="1000"></div>
      <div><label>Max Trades Per Day</label><input id="maxTradesPerDay" type="number" placeholder="blank = unlimited"></div>
      <div><label>Max Dollars Per Day</label><input id="maxDollarsPerDay" type="number" placeholder="blank = unlimited"></div>
      <div class="field full row"><button onclick="pauseToday()">Pause Today</button><button onclick="clearPause()">Clear Pause</button></div>
      <div class="field full hint">Use Client Access Code to restore this profile from another browser. After Save / Connect, save the generated code somewhere safe. Broker credentials are encrypted in Cloudflare KV and are not shown again after saving.</div>
    </div>
    <div class="modal-actions"><button class="danger" onclick="deleteProfile()">Delete Profile</button><button class="danger" onclick="forgetClient()">Forget Browser</button><button onclick="testBroker()">Test Broker</button><button onclick="saveSettings()">Save Controls</button><button class="primary" onclick="registerClient()">Save / Connect</button></div>
  </div>
</div>
<div id="toast"></div>

<script>
const state = {
  clientId: localStorage.getItem('kalkiClientId') || '',
  clientToken: localStorage.getItem('kalkiClientToken') || '',
};
function headers(){return {'content-type':'application/json','x-client-id':state.clientId,'x-client-token':state.clientToken};}
function toast(msg,type){const box=document.getElementById('toast');const el=document.createElement('div');el.className='toast '+(type||'');el.textContent=msg;box.appendChild(el);setTimeout(()=>el.remove(),4200);}
function show(data){toast(typeof data==='string'?data:(data.error||data.skipped||data.result?.reason||'Done'),data.ok===false?'err':'ok');}
function saveBrowserSession(data){
  state.clientId=data.client.id;state.clientToken=data.token;
  localStorage.setItem('kalkiClientId',state.clientId);localStorage.setItem('kalkiClientToken',state.clientToken);
}
function showAccessCode(code){
  const el=document.getElementById('newAccessCode');
  if(!code){el.className='field full access-code';el.textContent='';return;}
  el.className='field full access-code show';
  el.textContent='Save this access code: '+code;
}
function brokerDefaults(broker){
  return broker==='tradier'
    ? {endpoint:'https://sandbox.tradier.com',keyLabel:'Tradier Account ID',secretLabel:'Tradier Access Token'}
    : {endpoint:'https://paper-api.alpaca.markets',keyLabel:'API Key ID',secretLabel:'API Secret Key'};
}
function brokerChanged(){
  const broker=document.getElementById('broker').value;
  const defaults=brokerDefaults(broker);
  document.getElementById('keyLabel').textContent=defaults.keyLabel;
  document.getElementById('secretLabel').textContent=defaults.secretLabel;
  if(!document.getElementById('endpoint').value)document.getElementById('endpoint').value=defaults.endpoint;
  syncOrderTypeOptions();
}
function syncOrderTypeOptions(){
  const broker=document.getElementById('broker').value;
  const orderType=document.getElementById('orderType');
  const marketOption=orderType.querySelector('option[value="market"]');
  marketOption.disabled=broker==='tradier';
  if(broker==='tradier'&&orderType.value==='market')orderType.value='limit';
}
function formSettings(){return {
  broker: document.getElementById('broker').value,
  name: document.getElementById('name').value,
  endpoint: document.getElementById('endpoint').value,
  key: document.getElementById('key').value,
  secret: document.getElementById('secret').value,
  minGrade: document.getElementById('minGrade').value,
  orderType: document.getElementById('orderType').value,
  timeInForce: document.getElementById('timeInForce').value,
  positionSize: document.getElementById('positionSize').value,
  maxTradesPerDay: document.getElementById('maxTradesPerDay').value,
  maxDollarsPerDay: document.getElementById('maxDollarsPerDay').value,
};}
function applyClient(data){
  const c=data.client;if(!c)return;
  document.getElementById('clientName').textContent=c.name||'Connected';
  document.getElementById('enabled').textContent=c.enabled?'ON':'OFF';
  document.getElementById('enabled').className='stat-value '+(c.enabled?'green':'red');
  document.getElementById('botToggle').disabled=false;
  document.getElementById('botToggle').className='bot-toggle '+(c.enabled?'':'off');
  document.getElementById('botToggleLabel').textContent=c.enabled?'Bot Active':'Bot Paused';
  document.getElementById('dayTrades').textContent=data.day?.tradeCount ?? '--';
  document.getElementById('dayNotional').textContent='$'+Number(data.day?.notional||0).toFixed(2);
  const pnl=Number(data.day?.realizedPnl||0);document.getElementById('dayPnl').textContent=(pnl>=0?'+':'')+'$'+pnl.toFixed(2);document.getElementById('dayPnl').className='stat-value '+(pnl>=0?'green':'red');
  document.getElementById('gradeStat').textContent=c.minGrade||'B';
  document.getElementById('broker').value=c.broker||'alpaca';
  brokerChanged();
  document.getElementById('name').value=c.name||'';
  document.getElementById('endpoint').value=c.endpoint||brokerDefaults(c.broker||'alpaca').endpoint;
  document.getElementById('minGrade').value=c.minGrade||'B';
  document.getElementById('orderType').value=c.orderType||'limit';
  document.getElementById('timeInForce').value=c.timeInForce||'gtc';
  syncOrderTypeOptions();
  document.getElementById('positionSize').value=c.positionSize||1000;
  document.getElementById('maxTradesPerDay').value=c.maxTradesPerDay||'';
  document.getElementById('maxDollarsPerDay').value=c.maxDollarsPerDay||'';
}
async function health(){
  const r=await fetch('/api/health');const data=await r.json();
  document.getElementById('mode').textContent=data.kv_bound?'Broker Paper':'KV Missing';
}
async function registerClient(){
  const r=await fetch('/api/client/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(formSettings())});
  const data=await r.json();show(data);
  if(data.ok){saveBrowserSession(data);applyClient(data);showAccessCode(data.accessCode);loadLogs();toast('Connected. Save the displayed access code for other browsers.','ok');}
}
async function restoreClient(){
  const accessCode=document.getElementById('accessCodeInput').value;
  const r=await fetch('/api/client/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessCode})});
  const data=await r.json();show(data);
  if(data.ok){saveBrowserSession(data);applyClient(data);showAccessCode('');closeSettings();loadLogs();}
}
async function loadMe(){
  if(!state.clientId||!state.clientToken){document.getElementById('clientName').textContent='Setup';document.getElementById('enabled').textContent='OFF';document.getElementById('botToggle').disabled=true;document.getElementById('botToggle').className='bot-toggle off';document.getElementById('botToggleLabel').textContent='Not Connected';return;}
  const r=await fetch('/api/client/me',{method:'POST',headers:headers(),body:'{}'});const data=await r.json();show(data);if(data.ok)applyClient(data);
}
async function saveSettings(extra={}){
  const body={...formSettings(),...extra};
  if(!body.key)delete body.key;if(!body.secret)delete body.secret;
  const r=await fetch('/api/client/settings',{method:'POST',headers:headers(),body:JSON.stringify(body)});const data=await r.json();show(data);if(data.ok)applyClient(data);
}
async function setEnabled(enabled){await saveSettings({enabled});}
async function toggleBot(){if(!requireConnected())return;const isOn=!document.getElementById('botToggle').classList.contains('off');await setEnabled(!isOn);}
async function pauseToday(){await saveSettings({pauseToday:true});}
async function clearPause(){await saveSettings({clearPause:true});}
async function testBroker(){const r=await fetch('/api/client/test-broker',{method:'POST',headers:headers(),body:'{}'});show(await r.json());}
async function previewAlert(){const r=await fetch('/api/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('alert').value})});const data=await r.json();show(data);if(data.ok)addAlert(data.alert,'preview',data.decision?.reason||'Preview');}
async function manualTrade(){if(!confirm('Place this paper bracket order?'))return;const r=await fetch('/api/client/manual-trade',{method:'POST',headers:headers(),body:JSON.stringify({text:document.getElementById('alert').value})});const data=await r.json();show(data);if(data.result?.alert)addAlert(data.result.alert,data.result.status,data.result.reason||'Manual');await loadLogs();await loadMe();}
async function loadLogs(){const r=await fetch('/api/client/logs',{method:'POST',headers:headers(),body:'{}'});const data=await r.json();if(!data.ok){show(data);return;}renderLogs(data.logs||[]);}
async function refreshPnl(){const r=await fetch('/api/client/refresh-pnl',{method:'POST',headers:headers(),body:'{}'});const data=await r.json();show(data.ok?('P/L refreshed: '+(data.closed||0)+' closed, '+(data.open||0)+' open'):data);if(data.day)applyClient({client:{id:state.clientId,name:document.getElementById('clientName').textContent,enabled:!document.getElementById('botToggle').classList.contains('off'),broker:document.getElementById('broker').value,minGrade:document.getElementById('minGrade').value,endpoint:document.getElementById('endpoint').value,orderType:document.getElementById('orderType').value,timeInForce:document.getElementById('timeInForce').value,positionSize:document.getElementById('positionSize').value,maxTradesPerDay:document.getElementById('maxTradesPerDay').value,maxDollarsPerDay:document.getElementById('maxDollarsPerDay').value},day:data.day});await loadLogs();}
function forgetClient(){localStorage.removeItem('kalkiClientId');localStorage.removeItem('kalkiClientToken');location.reload();}
async function deleteProfile(){if(!requireConnected())return;if(!confirm('Delete this client profile from auto-trading?'))return;const r=await fetch('/api/client/delete',{method:'POST',headers:headers(),body:'{}'});const data=await r.json();show(data);if(data.ok)forgetClient();}
function openSettings(){document.getElementById('settingsModal').classList.add('open');}
function closeSettings(event){if(event&&event.target.id!=='settingsModal')return;document.getElementById('settingsModal').classList.remove('open');}
function addAlert(alert,status,detail){const feed=document.getElementById('alertFeed');feed.innerHTML='<div class="alert-item"><div class="badge-grade">'+(alert.grade||'?')+'</div><div><div class="ticker">'+alert.ticker+'</div><div class="prices"><span class="entry">Entry $'+Number(alert.entryPrice).toFixed(2)+'</span><span class="stop">Stop $'+Number(alert.stopPrice).toFixed(2)+'</span><span class="target">T1 $'+Number(alert.t1).toFixed(2)+'</span></div></div><div><span class="pill '+(status==='skipped'?'skip':status==='error'?'err':'')+'">'+status+'</span><div class="meta">'+(detail||'')+'</div></div></div>'+feed.innerHTML.replace('<div class="empty">Waiting for Telegram alerts...</div>','');}
function formatEtTime(value){if(!value)return '-';const date=new Date(value);if(Number.isNaN(date.getTime()))return '-';return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true,timeZoneName:'short'}).format(date);}
function logClass(l){return l.status==='profit'?'log-ok':l.status==='loss'?'log-err':l.status==='submitted'?'log-open':l.status==='skipped'?'log-skip':l.status==='error'?'log-err':'log-open';}
function logDetail(l){if(l.type==='realized_pnl')return (l.exit_reason||'Exit')+' '+(Number(l.realized_pnl)>=0?'+':'')+'$'+Number(l.realized_pnl||0).toFixed(2)+' · '+Number(l.filled_qty||0)+' sh · $'+Number(l.entry_fill_price||0).toFixed(2)+' → $'+Number(l.exit_fill_price||0).toFixed(2);return l.reason||l.message||l.broker_order_id||l.alpaca_order_id||'';}
function renderLogs(logs){document.getElementById('orderCount').textContent=logs.length+' logs';const body=document.getElementById('tradeLog');const orders=document.getElementById('orders');if(!logs.length){body.innerHTML='<tr><td colspan="5" class="empty">No trades yet</td></tr>';orders.innerHTML='<div class="empty">No orders yet</div>';return;}body.innerHTML=logs.map(l=>{const detail=logDetail(l);return '<tr><td>'+formatEtTime(l.logged_at||l.created_at)+'</td><td>'+(l.ticker||l.alert?.ticker||'-')+'</td><td>'+(l.broker||l.source||l.type||'-')+'</td><td class="'+logClass(l)+'">'+(l.status||'-')+'</td><td>'+detail+'</td></tr>';}).join('');orders.innerHTML=logs.slice(0,6).map(l=>{const detail=logDetail(l);return '<div class="pos-item"><div class="badge-grade">'+((l.alert?.grade)||'--')+'</div><div><div class="ticker">'+(l.ticker||l.alert?.ticker||l.type||'-')+'</div><div class="meta">'+detail+'</div></div><span class="pill '+(l.status==='skipped'?'skip':l.status==='error'||l.status==='loss'?'err':'')+'">'+(l.status||'log')+'</span></div>';}).join('');}
function requireConnected(){
  if(state.clientId&&state.clientToken)return true;
  show('Open settings and connect a paper broker first.','warn');openSettings();
  return false;
}
const originalSaveSettings=saveSettings;
saveSettings=async function(extra={}){if(!requireConnected())return;return originalSaveSettings(extra);}
const originalTestBroker=testBroker;
testBroker=async function(){if(!requireConnected())return;return originalTestBroker();}
const originalManualTrade=manualTrade;
manualTrade=async function(){if(!requireConnected())return;return originalManualTrade();}
const originalLoadLogs=loadLogs;
loadLogs=async function(){if(!requireConnected())return;return originalLoadLogs();}
const originalRefreshPnl=refreshPnl;
refreshPnl=async function(){if(!requireConnected())return;return originalRefreshPnl();}
brokerChanged();
health();loadMe().then(()=>{if(state.clientId)loadLogs();}).catch(()=>show('Open settings and connect a paper broker first.'));
</script>
</body>
</html>`;
}

