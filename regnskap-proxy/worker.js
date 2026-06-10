/**
 * Cloudflare Worker – CORS-proxy for Brønnøysundregistrenes regnskapsregister
 *
 * Deploy:
 *   1. npx wrangler deploy   (eller lim inn i Cloudflare Dashboard → Workers → Quick edit)
 *   2. Kopier worker-URL-en (f.eks. https://regnskap-proxy.DITT-NAVN.workers.dev)
 *   3. Lim den inn som REGNSKAP_PROXY_BASE i brreg.html
 *
 * Tillatte origins settes i ALLOWED_ORIGINS nedenfor.
 */

const UPSTREAM = "https://data.brreg.no/regnskapsregisteret/regnskap";

const ALLOWED_ORIGINS = [
  "https://sheffielddivided.github.io",
  "http://localhost",         // lokal utvikling
  "http://127.0.0.1",
];

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    const url = new URL(request.url);

    // Forvent sti på formen /{orgnr}  (query-parametre videresendes)
    const orgnr = url.pathname.replace(/^\/+/, "").replace(/\/.*/, "");
    if (!/^\d{9}$/.test(orgnr)) {
      return new Response(JSON.stringify({ error: "Ugyldig organisasjonsnummer" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(corsOrigin) },
      });
    }

    const upstreamUrl = `${UPSTREAM}/${orgnr}${url.search}`;

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        headers: { accept: "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Oppstrøms feil", detail: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(corsOrigin) },
      });
    }

    const body = await upstreamRes.arrayBuffer();
    const headers = new Headers({
      "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json",
      ...corsHeaders(corsOrigin),
    });

    return new Response(body, { status: upstreamRes.status, headers });
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}
