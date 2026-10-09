/**
 * Henter valutakurser, renter og inflasjonsdata til nb.html og skriver
 * tre JSON-filer i data/nb/. Siden leser disse i stedet for å kalle
 * API-ene direkte fra nettleseren.
 *
 * Krever Node 18+ (innebygd fetch). FRED_API_KEY må settes som miljøvariabel
 * (GitHub-secret) for Fed Funds og US CPI.
 */

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "data", "nb");
const FRED_KEY = process.env.FRED_API_KEY || "";

const CURRENCIES = ["USD","EUR","GBP","SEK","DKK","CHF","AUD","BRL","CAD","CZK","JPY","PLN","KRW","TRY"];
const TBIL = ["3M","6M","12M"];
const GBON = ["3Y","5Y","7Y","10Y"];
const US_TENOR_KEYS = { "3M":"BC_3MONTH","6M":"BC_6MONTH","12M":"BC_1YEAR","3Y":"BC_3YEAR","5Y":"BC_5YEAR","7Y":"BC_7YEAR","10Y":"BC_10YEAR" };

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "convert-nb-data/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(FRED_KEY || "\0", "***")}`);
  return res.json();
}

// SDMX-JSON (Norges Bank / ECB) -> { name, series: [[date, value], ...] }
function parseSdmx(json) {
  const root = json.data || json;
  const ds = root.dataSets[0];
  const sk = Object.keys(ds.series)[0];
  const obs = ds.series[sk].observations;
  const times = root.structure.dimensions.observation[0].values;
  const series = Object.keys(obs)
    .map((k) => [times[parseInt(k)].id, obs[k][0] === null ? null : parseFloat(obs[k][0])])
    .filter((o) => o[1] !== null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const seriesDims = root.structure.dimensions.series || [];
  const name = seriesDims[1] && seriesDims[1].values[0] ? seriesDims[1].values[0].name : null;
  return { name, series };
}

async function fred(seriesId, extra) {
  if (!FRED_KEY) throw new Error("FRED_API_KEY mangler");
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json${extra || ""}`;
  const json = await getJson(url);
  return (json.observations || [])
    .filter((o) => o.value !== ".")
    .map((o) => [o.date, parseFloat(o.value)]);
}

// SSB json-stat2 -> { labels, series: { <ContentsCode>: [..] } }  (samme form som parseStat2 i nb.html tidligere)
function parseStat2(data, dim1Key, dim2Key) {
  const tidCat = data.dimension[dim1Key].category;
  const tidKeys = Object.keys(tidCat.index).sort((a, b) => tidCat.index[a] - tidCat.index[b]);
  const contIdx = data.dimension[dim2Key].category.index;
  const stride = data.size.slice(1).reduce((a, b) => a * b, 1);
  const series = {};
  Object.keys(contIdx).forEach((k) => { series[k] = []; });
  tidKeys.forEach((_, i) => {
    Object.keys(contIdx).forEach((k) => series[k].push(data.value[i * stride + contIdx[k]]));
  });
  return { labels: tidKeys, series };
}

function write(name, obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const body = { updated: new Date().toISOString(), ...obj };
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(body));
  console.log(`Skrev data/nb/${name}`);
}

// Hvis en kilde feiler beholdes forrige verdi fra eksisterende fil (om den finnes).
function previous(name) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), "utf8")); } catch (e) { return {}; }
}

async function settle(label, fn, fallback) {
  try { return await fn(); }
  catch (e) { console.error(`FEIL ${label}: ${e.message}`); failures++; return fallback; }
}

let failures = 0;

async function buildExchange() {
  const prev = previous("exchange.json");
  const start = yearsAgo(6);
  const currencies = {};
  await Promise.all(CURRENCIES.map(async (cur) => {
    currencies[cur] = await settle(`EXR ${cur}`, async () => {
      const json = await getJson(`https://data.norges-bank.no/api/data/EXR/B.${cur}.NOK.SP?format=sdmx-json&startPeriod=${start}&locale=en`);
      return parseSdmx(json);
    }, (prev.currencies || {})[cur] || null);
  }));
  write("exchange.json", { currencies });
}

async function buildInterest() {
  const prev = previous("interest.json");
  const far = yearsAgo(21);

  const policy = await settle("NB styringsrente", async () =>
    parseSdmx(await getJson(`https://data.norges-bank.no/api/data/IR/B.KPRA.SD.?format=sdmx-json&startPeriod=${far}&locale=en`)).series,
    prev.policy || []);

  const fed = await settle("Fed funds", () => fred("FEDFUNDS", `&observation_start=${far}`), prev.fed || []);

  const ecb = await settle("ECB deposit rate", async () =>
    parseSdmx(await getJson(`https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=jsondata&startPeriod=${far}`)).series,
    prev.ecb || []);

  const nbYields = {};
  await Promise.all(TBIL.concat(GBON).map(async (t) => {
    const type = TBIL.includes(t) ? "TBIL" : "GBON";
    nbYields[t] = await settle(`NB rente ${t}`, async () => {
      const s = parseSdmx(await getJson(`https://data.norges-bank.no/api/data/GOVT_GENERIC_RATES/B.${t}.${type}.?format=sdmx-json&lastNObservations=1&locale=en`)).series;
      return s.length ? s[s.length - 1][1] : null;
    }, (prev.nbYields || {})[t] ?? null);
  }));

  const usYields = await settle("US Treasury", async () => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${new Date().getFullYear()}`;
    const res = await fetch(url, { headers: { "User-Agent": "convert-nb-data/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const entries = xml.split(/<entry[\s>]/).slice(1);
    const last = entries[entries.length - 1];
    if (!last) throw new Error("ingen entries");
    const rates = {};
    for (const t of Object.keys(US_TENOR_KEYS)) {
      const m = last.match(new RegExp(`<d:${US_TENOR_KEYS[t]}[^>]*>([^<]*)<`));
      const v = m ? parseFloat(m[1]) : NaN;
      rates[t] = Number.isFinite(v) ? v : null;
    }
    const dm = last.match(/<d:NEW_DATE[^>]*>([^<T]*)/);
    return { date: dm ? dm[1] : null, rates };
  }, prev.usYields || null);

  write("interest.json", { policy, fed, ecb, nbYields, usYields });
}

async function buildInflation() {
  const prev = previous("inflation.json");
  const CPI_URL = "https://data.ssb.no/api/pxwebapi/v2/tables/14700/data?lang=en&outputFormat=json-stat2&valuecodes[Tid]=*&codelist[VareTjenesteGrp]=vs_CoiCop2018Kpi01&valuecodes[ContentsCode]=KpiIndMnd,Tolvmanedersendring&heading=ContentsCode&stub=Tid";
  const PPI_URL = "https://data.ssb.no/api/pxwebapi/v2/tables/12462/data?lang=en&outputFormat=json-stat2&valuecodes[ContentsCode]=Indeksnivo,Tolvmanedersendring&valuecodes[Tid]=*&valuecodes[NaringUtenriks]=SNN0&codelist[NaringUtenriks]=vs_NaringPPI1&heading=NaringUtenriks,ContentsCode&stub=Tid";
  const EU_URL = "https://data-api.ecb.europa.eu/service/data/ICP/M.U2.N.000000.4.ANR?format=jsondata";

  const [cpi, ppi, usCpi, euHicp] = await Promise.all([
    settle("SSB KPI", async () => parseStat2(await getJson(CPI_URL), "Tid", "ContentsCode"), prev.cpi || null),
    settle("SSB PPI", async () => parseStat2(await getJson(PPI_URL), "Tid", "ContentsCode"), prev.ppi || null),
    settle("US CPI", () => fred("CPIAUCSL", "&units=pc1"), prev.usCpi || []),
    settle("EU HICP", async () => parseSdmx(await getJson(EU_URL)).series, prev.euHicp || [])
  ]);
  write("inflation.json", { cpi, ppi, usCpi, euHicp });
}

(async () => {
  await buildExchange();
  await buildInterest();
  await buildInflation();
  if (failures) {
    console.error(`${failures} kilde(r) feilet – forrige data er beholdt for disse.`);
    process.exitCode = 1; // gjør at workflowen blir rød, men filene committes likevel
  }
})();
