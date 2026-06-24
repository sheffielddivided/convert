const ALLOWED_ORIGINS = [
  "https://sheffielddivided.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

const TARGET_BASE = "https://bdapi.012.se/api";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const isAllowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ":"));

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    const apiKey = env.BD_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "BD_API_KEY secret not set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "Authorization": apiKey,
        "Accept": "application/json",
      },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
