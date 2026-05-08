const DEFAULT_API_ORIGIN = "https://kalki-alpaca-autotrader.srimanthgada87.workers.dev";

export async function onRequest(context) {
  const apiOrigin = String(context.env.AUTOTRADER_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/+$/, "");
  const rawPath = Array.isArray(context.params.path)
    ? context.params.path.join("/")
    : String(context.params.path || "");
  const incomingUrl = new URL(context.request.url);
  const targetUrl = new URL(`/api/${rawPath}${incomingUrl.search}`, apiOrigin);

  const headers = new Headers(context.request.headers);
  headers.delete("host");

  return fetch(targetUrl, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
  });
}
