/**
 * Scraper: Euronext primary insiders
 *
 * Henter tabellen fra live.euronext.com og lagrer resultatet som
 * data/primary-insiders.json i repoet.
 *
 * Legg til flere ISIN-er i TARGETS-arrayen for å skrape flere selskaper.
 */

const puppeteer = require("puppeteer");
const fs        = require("fs");
const path      = require("path");

const TARGETS = [
  {
    isin:    "NO0010345853",
    mic:     "XOSL",
    ticker:  "AKERBP",
    name:    "Aker BP ASA",
  },
  // Legg til flere her, f.eks.:
  // { isin: "NO0010081235", mic: "XOSL", ticker: "EQNR", name: "Equinor ASA" },
];

const OUT_FILE = path.join(__dirname, "..", "data", "primary-insiders.json");

async function scrapeInsiders(browser, { isin, mic, ticker, name }) {
  const url = `https://live.euronext.com/en/product/equities/${isin}-${mic}/primary-insiders`;
  console.log(`Scraping ${ticker} (${isin}): ${url}`);

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    // Vent på at tabellen dukker opp (maks 30 sek)
    await page.waitForSelector("table", { timeout: 30_000 });

    const insiders = await page.evaluate(() => {
      // Finn tabellen som inneholder insiderdata.
      // Euronext bruker ulike class-navn avhengig av versjon — vi leter etter
      // tabellen med flest kolonner som inneholder navn/posisjon.
      const tables = Array.from(document.querySelectorAll("table"));
      if (!tables.length) return [];

      // Velg tabellen med flest rader
      const table = tables.reduce((best, t) =>
        t.querySelectorAll("tbody tr").length > best.querySelectorAll("tbody tr").length ? t : best
      );

      const headers = Array.from(table.querySelectorAll("thead th, thead td"))
        .map(th => th.innerText.trim());

      const rows = Array.from(table.querySelectorAll("tbody tr"));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll("td"))
          .map(td => td.innerText.trim());
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = cells[i] ?? ""; });
        return obj;
      }).filter(r => Object.values(r).some(v => v !== ""));
    });

    console.log(`  → ${insiders.length} rader funnet`);
    return { isin, ticker, name, insiders };
  } finally {
    await page.close();
  }
}

(async () => {
  // Sørg for at output-mappen finnes
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const results = [];
  for (const target of TARGETS) {
    try {
      const data = await scrapeInsiders(browser, target);
      results.push(data);
    } catch (err) {
      console.error(`Feil ved scraping av ${target.ticker}:`, err.message);
      results.push({ ...target, insiders: [], error: err.message });
    }
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    companies: results,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`Lagret → ${OUT_FILE}`);
})();
