/**
 * Cloudflare Worker – CORS proxy for Companies House API
 *
 * Deploy:
 *   1. cd companies-house-proxy && npx wrangler deploy
 *      (or paste into Cloudflare Dashboard → Workers → Quick edit)
 *   2. Set the API key as a secret (keeps it out of source code):
 *      npx wrangler secret put CH_API_KEY
 *      (enter: adb28fbf-d4ef-4a13-8202-48a8bd141a33)
 *   3. Copy the worker URL and set CH_PROXY in companies-house.html
 *
 * The worker forwards any path+query to the Companies House API,
 * injects the Authorization header, and adds CORS headers.
 */

const UPSTREAM     = "https://api.company-information.service.gov.uk";
const ALLOWED_ORIGINS = [
  "https://sheffielddivided.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

export default {
  async fetch(request, env) {
    const origin     = request.headers.get("Origin") ?? "";
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    const url        = new URL(request.url);
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    const apiKey = env.CH_API_KEY ?? "";
    const auth   = "Basic " + btoa(apiKey + ":");

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        headers: { Authorization: auth, Accept: "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(corsOrigin) },
      });
    }

    const body = await upstreamRes.arrayBuffer();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json",
        ...corsHeaders(corsOrigin),
      },
    });
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age":       "86400",
  };
}
