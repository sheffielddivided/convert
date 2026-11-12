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
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "data", "nb");
const FRED_KEY = process.env.FRED_API_KEY || "";

const CURRENCIES = ["USD","EUR","GBP","SEK","DKK","CHF","AUD","BRL","CAD","CZK","JPY","PLN","KRW","TRY"];
const TBIL = ["3M","6M","12M"];
const GBON = ["3Y","5Y","7Y","10Y"];
const US_TENOR_KEYS = { "3M":"BC_3MONTH","6M":"BC_6MONTH","12M":"BC_1YEAR","3Y":"BC_3YEAR","5Y":"BC_5YEAR","7Y":"BC_7YEAR","10Y":"BC_10YEAR","20Y":"BC_20YEAR","30Y":"BC_30YEAR" };
const EU_TENORS = ["1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];
const UK_TENORS = ["6M","1Y","2Y","3Y","5Y","7Y","10Y","15Y","20Y","30Y"];
// Riksbank SWEA: gruppe 6 = statsskuldväxlar, gruppe 7 = statsobligationer
const SE_SERIES = { SETB1MBENCHC:"1M", SETB3MBENCH:"3M", SETB6MBENCH:"6M", SEGVB2YC:"2Y", SEGVB5YC:"5Y", SEGVB7YC:"7Y", SEGVB10YC:"10Y" };

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

// Forsøker på nytt (med økende ventetid) ved forbigående feil: nettverk, 429 og 5xx.
async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));
    try {
      const res = await fetch(url, { headers: { "User-Agent": "convert-nb-data/1.0" } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url.replace(FRED_KEY || "\0", "***")}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function getText(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.text();
}

async function getBuffer(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(FRED_KEY || "\0", "***")}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error(`forventet JSON, fikk ${type || "ukjent type"} (vedlikeholdsside?) fra ${new URL(url).host}`);
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

// Eurostat JSON-stat (én serie over tid) -> [[YYYY-MM, value], ...]
function parseJsonStat(json) {
  const idx = json.dimension.time.category.index;
  return Object.keys(idx)
    .filter((t) => json.value[idx[t]] != null)
    .sort()
    .map((t) => [t, json.value[idx[t]]]);
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

// Minimal zip-leser (sentralkatalog + deflate) slik at vi slipper avhengigheter for BoE sine xlsx-filer.
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("ugyldig zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ugyldig zip-katalog");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

// Siste rad i BoE sin "4. spot curve"-fane -> { date, rates: { "1Y": .., ... } }
function parseBoeSpotCurve(zipBuf) {
  const outer = unzip(zipBuf);
  const xName = Object.keys(outer).find((n) => /nominal daily/i.test(n));
  if (!xName) throw new Error("fant ikke GLC Nominal i zip");
  const x = unzip(outer[xName]());
  const wb = x["xl/workbook.xml"]().toString("utf8");
  const rels = x["xl/_rels/workbook.xml.rels"]().toString("utf8");
  const sheet = wb.match(/<sheet [^>]*name="4\. spot curve"[^>]*>/);
  const rid = sheet && sheet[0].match(/r:id="([^"]+)"/)[1];
  const target = rid && (rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`)) || [])[1];
  if (!target) throw new Error("fant ikke spot curve-fanen");
  const xml = x["xl/" + target.replace(/^\/?xl\//, "")]().toString("utf8");
  const colToNum = (c) => c.split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const rows = (xml.match(/<row [^>]*>[\s\S]*?<\/row>/g) || []).map((r) => {
    const cells = {};
    for (const m of r.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f[^>]*\/>|<f[^>]*>[\s\S]*?<\/f>)?(?:<v>([^<]*)<\/v>)?<\/c>)/g)) {
      if (m[3] !== undefined && !/t="(s|e|str)"/.test(m[2])) cells[colToNum(m[1])] = parseFloat(m[3]);
    }
    return cells;
  });
  // Rad med løpetider: kolonne 1 tom, kolonne 2 = 0.5, 3 = 1, ...
  const header = rows.find((c) => c[2] === 0.5 && c[3] === 1);
  if (!header) throw new Error("fant ikke løpetidsraden");
  const dataRows = rows.filter((c) => c !== header && c[1] > 30000 && Object.keys(c).length > 10);
  const last = dataRows[dataRows.length - 1];
  if (!last) throw new Error("ingen kurvedata denne måneden ennå");
  const date = new Date(Date.UTC(1899, 11, 30) + last[1] * 86400000).toISOString().slice(0, 10);
  const rates = {};
  for (const t of UK_TENORS) {
    const years = t.endsWith("M") ? parseInt(t, 10) / 12 : parseInt(t, 10);
    const col = Object.keys(header).find((k) => header[k] === years);
    const v = col ? last[col] : undefined;
    rates[t] = Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  }
  return { date, rates };
}

// BoE IADB CSV (DATE,KODE) -> [[YYYY-MM-DD, value], ...]
function parseIadbCsv(csv) {
  const mon = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  const out = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const m = line.match(/^(\d{2}) (\w{3}) (\d{4}),([-\d.]+)/);
    if (m && mon[m[2]]) out.push([`${m[3]}-${mon[m[2]]}-${m[1]}`, parseFloat(m[4])]);
  }
  if (!out.length) throw new Error("ingen rader fra BoE (blokkert?)");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Daglig serie -> kun endringspunkter + siste observasjon (som ECB-serien), for å holde JSON-filen liten.
function changePoints(series) {
  const out = series.filter((o, i) => i === 0 || o[1] !== series[i - 1][1]);
  const last = series[series.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
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

  // Euro-kurver (spot, Svensson): ECB sin AAA-kurve for euroområdet og Bundesbank sin kurve for tyske statspapirer.
  const euYields = await settle("Euro yield curves", async () => {
    const ecbRates = {}, deRates = {};
    let ecbDate = null, deDate = null;
    await Promise.all(EU_TENORS.map(async (t) => {
      const ecbCsv = await getText(`https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_${t}?lastNObservations=1&format=csvdata`);
      const [head, row] = ecbCsv.trim().split(/\r?\n/);
      const cols = head.split(",");
      const cells = (row || "").split(",");
      const v = parseFloat(cells[cols.indexOf("OBS_VALUE")]);
      const d = cells[cols.indexOf("TIME_PERIOD")];
      if (!Number.isFinite(v)) throw new Error(`ECB ${t}: ingen verdi`);
      ecbRates[t] = v;
      if (d && (!ecbDate || d > ecbDate)) ecbDate = d;

      const n = String(parseInt(t, 10)).padStart(2, "0");
      const deCsv = await getText(`https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R${n}XX.R.A.A._Z._Z.A?lastNObservations=1&format=csv`);
      const last = deCsv.trim().split(/\r?\n/).filter((l) => /^\d{4}-\d{2}-\d{2};/.test(l)).pop();
      if (!last) throw new Error(`Bundesbank ${t}: ingen verdi`);
      const [dd, dv] = last.split(";");
      const dn = parseFloat(dv.replace(",", "."));
      if (!Number.isFinite(dn)) throw new Error(`Bundesbank ${t}: ugyldig verdi`);
      deRates[t] = dn;
      if (!deDate || dd > deDate) deDate = dd;
    }));
    return { ecb: { date: ecbDate, rates: ecbRates }, de: { date: deDate, rates: deRates } };
  }, prev.euYields || null);

  const boeDate = (() => { const d = new Date(far); return `${String(d.getUTCDate()).padStart(2, "0")}/${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}/${d.getUTCFullYear()}`; })();
  const boe = await settle("BoE Bank Rate", async () =>
    changePoints(parseIadbCsv(await getText(`https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${boeDate}&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`))),
    prev.boe || []);

  const riksbank = await settle("Riksbank styrränta", async () => {
    const json = await getJson(`https://api.riksbank.se/swea/v1/Observations/SECBREPOEFF/${far}`);
    const s = json.filter((o) => o.value != null).map((o) => [o.date, o.value]);
    if (!s.length) throw new Error("ingen observasjoner");
    return changePoints(s);
  }, prev.riksbank || []);

  const ukYields = await settle("UK gilt curve", async () =>
    parseBoeSpotCurve(await getBuffer("https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip")),
    prev.ukYields || null);

  const seYields = await settle("SE government curve", async () => {
    const rates = {};
    let date = null;
    for (const g of [6, 7]) {
      for (const o of await getJson(`https://api.riksbank.se/swea/v1/Observations/Latest/ByGroup/${g}`)) {
        const t = SE_SERIES[o.seriesId];
        if (!t || o.value == null) continue;
        rates[t] = o.value;
        if (!date || o.date > date) date = o.date;
      }
    }
    if (Object.keys(rates).length < 4) throw new Error("for få løpetider");
    return { date, rates };
  }, prev.seYields || null);

  write("interest.json", { policy, fed, ecb, boe, riksbank, nbYields, usYields, euYields, ukYields, seYields });
}

async function buildInflation() {
  const prev = previous("inflation.json");
  const CPI_URL = "https://data.ssb.no/api/pxwebapi/v2/tables/14700/data?lang=en&outputFormat=json-stat2&valuecodes[Tid]=*&codelist[VareTjenesteGrp]=vs_CoiCop2018Kpi01&valuecodes[ContentsCode]=KpiIndMnd,Tolvmanedersendring&heading=ContentsCode&stub=Tid";
  const PPI_URL = "https://data.ssb.no/api/pxwebapi/v2/tables/12462/data?lang=en&outputFormat=json-stat2&valuecodes[ContentsCode]=Indeksnivo,Tolvmanedersendring&valuecodes[Tid]=*&valuecodes[NaringUtenriks]=SNN0&codelist[NaringUtenriks]=vs_NaringPPI1&heading=NaringUtenriks,ContentsCode&stub=Tid";
  // ECB la ned ICP-datasettet i feb 2026 (siste punkt 2025-12); Eurostat prc_hicp_minr (ECOICOP v2) er etterfølgeren.
  const EU_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?format=JSON&lang=en&geo=EA&coicop18=TOTAL&unit=RCH_A";

  const SE_URL = EU_URL.replace("geo=EA", "geo=SE");
  const UK_URL = "https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23/data";
  const MONTHS = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };

  const [cpi, ppi, usCpi, euHicp, ukCpi, seHicp] = await Promise.all([
    settle("SSB KPI", async () => parseStat2(await getJson(CPI_URL), "Tid", "ContentsCode"), prev.cpi || null),
    settle("SSB PPI", async () => parseStat2(await getJson(PPI_URL), "Tid", "ContentsCode"), prev.ppi || null),
    settle("US CPI", () => fred("CPIAUCSL", "&units=pc1"), prev.usCpi || []),
    settle("EU HICP", async () => parseJsonStat(await getJson(EU_URL)), prev.euHicp || []),
    // ONS D7G7 = CPI 12-månedersendring (UK sin HICP)
    settle("UK CPI", async () => {
      const json = await getJson(UK_URL);
      const s = (json.months || [])
        .map((o) => { const m = String(o.date).match(/^(\d{4}) ([A-Z]{3})$/); return m && MONTHS[m[2]] ? [`${m[1]}-${MONTHS[m[2]]}`, parseFloat(o.value)] : null; })
        .filter((o) => o && Number.isFinite(o[1]))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (!s.length) throw new Error("ingen månedsdata");
      return s;
    }, prev.ukCpi || []),
    settle("SE HICP", async () => parseJsonStat(await getJson(SE_URL)), prev.seHicp || [])
  ]);
  write("inflation.json", { cpi, ppi, usCpi, euHicp, ukCpi, seHicp });
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
