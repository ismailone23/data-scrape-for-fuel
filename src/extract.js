import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { gridToCsv, toCsv } from "./csv.js";

// Second stage: takes the scored discovery index produced by scraper.js and
// pulls the actual content out of each article page.

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const INDEX_FILE = path.join(DATA_DIR, "articles.json");
const TABLES_DIR = path.join(DATA_DIR, "tables");
const EXTRACT_LIMIT = Number(process.env.EXTRACT_LIMIT || 40);
const EXTRACT_MIN_SCORE = Number(process.env.EXTRACT_MIN_SCORE || 60);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 3500);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 45000);
const MIN_TABLE_ROWS = Number(process.env.MIN_TABLE_ROWS || 2);
const MIN_TABLE_COLS = Number(process.env.MIN_TABLE_COLS || 2);
const MAILTO = process.env.CROSSREF_MAILTO || process.env.OPENALEX_MAILTO || "";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

// Both serve bot-challenge pages to headless Chrome; visiting them only burns
// time. Everything else is attempted.
const BLOCKED_HOSTS = ["sciencedirect.com", "ieeexplore.ieee.org"];

// Hosts that actually hold the numbers behind an article's figures.
const DATA_REPOSITORY_HOSTS = [
  "figshare.com",
  "zenodo.org",
  "data.mendeley.com",
  "doi.org/10.17632", // Mendeley Data DOI prefix
  "datadryad.org",
  "osf.io",
  "dataverse",
  "github.com",
  "gitlab.com",
  "kaggle.com",
  "pangaea.de",
  "icpsr.umich.edu",
  "worldbank.org",
];

const SYSTEM_BROWSER_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  for (const browserPath of SYSTEM_BROWSER_PATHS) {
    if (await fileExists(browserPath)) return browserPath;
  }

  return null;
}

// Filenames are derived from the DOI so a re-run overwrites rather than
// duplicates, and so a table file can be traced back to its article.
function slugify(row, index) {
  const base = row.doi || row.title || `row-${index}`;

  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `row-${index}`
  );
}

function isBlockedHost(url) {
  return BLOCKED_HOSTS.some(host => url.includes(host));
}

// Sources whose records reliably carry extractable tables or attached files.
const DATA_SOURCE_NAMES = [
  "Crossref Data Journals",
  "Zenodo",
  "DataCite",
  "IEEE DataPort",
  "Scientific Data",
];

function dataYieldRank(row) {
  let rank = 0;

  if (DATA_SOURCE_NAMES.includes(row.source)) rank += 2;
  if (String(row.kind).toLowerCase() === "dataset") rank += 2;
  if (/\bdata(set)?\b/i.test(row.title)) rank += 1;

  return rank;
}

// Publishers wrap tables in wildly different markup, so the caption is looked
// for in the places that actually occur, nearest first.
function findTableCaption($, table) {
  const inner = normalizeWhitespace($(table).find("caption").first().text());
  if (inner) return inner;

  const container = $(table).closest("figure, .table-wrap, .table-wrapper, [class*='table']");
  const containerCaption = normalizeWhitespace(
    container.find("figcaption, .caption, .table-caption, .title").first().text(),
  );
  if (containerCaption) return containerCaption;

  const previous = normalizeWhitespace($(table).prevAll("p, div, h3, h4, span").first().text());

  return previous.slice(0, 300);
}

function extractTableGrid($, table) {
  const grid = [];

  $(table)
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr)
        .find("th, td")
        .map((__, cell) => normalizeWhitespace($(cell).text()))
        .get();

      if (cells.length > 0) grid.push(cells);
    });

  return grid;
}

function extractFigures($, pageUrl) {
  const figures = [];

  $("figure").each((_, figure) => {
    const caption = normalizeWhitespace($(figure).find("figcaption").first().text());
    const rawSrc =
      $(figure).find("img").first().attr("src") ||
      $(figure).find("img").first().attr("data-src") ||
      "";

    if (!caption && !rawSrc) return;

    let imageUrl = "";

    try {
      imageUrl = rawSrc ? new URL(rawSrc, pageUrl).href : "";
    } catch {
      imageUrl = "";
    }

    figures.push({ caption, imageUrl });
  });

  return figures;
}

function extractDataLinks($, pageUrl) {
  const links = new Map();

  $("a[href]").each((_, anchor) => {
    const rawHref = $(anchor).attr("href") || "";
    const text = normalizeWhitespace($(anchor).text());

    if (!DATA_REPOSITORY_HOSTS.some(host => rawHref.includes(host))) return;

    // Site chrome matches the host list but points nowhere useful: PMC footers
    // link "NCBI on GitHub", publishers link "import into Mendeley".
    if (/mendeley\.com\/import/.test(rawHref)) return;
    if (/github\.com\/ncbi/i.test(rawHref)) return;
    if (/^(ncbi on github|github|gitlab|twitter|facebook|linkedin|follow ncbi)$/i.test(text)) return;

    try {
      const href = new URL(rawHref, pageUrl).href;
      if (!links.has(href)) links.set(href, text);
    } catch {
      /* skip unparseable href */
    }
  });

  return [...links].map(([url, text]) => ({ url, text }));
}

async function loadPage(browser, url) {
  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await sleep(PAGE_WAIT_MS);

    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });

    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// PubMed Central renders full tables and figure captions as static HTML and does
// not challenge headless clients, so it is the preferred target whenever the DOI
// has a PMC copy. OpenAlex's own ids.pmcid is usually empty; Europe PMC's search
// resolves it reliably.
async function resolvePmcUrl(doi) {
  if (!doi) return "";

  const query = encodeURIComponent(`DOI:"${doi}"`);
  const data = await fetchJson(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${query}&format=json&resultType=core`,
  );
  const pmcid = data?.resultList?.result?.[0]?.pmcid;

  return pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : "";
}

async function resolveOaUrl(doi) {
  if (!doi) return "";

  const data = await fetchJson(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}${
      MAILTO ? `?mailto=${encodeURIComponent(MAILTO)}` : ""
    }`,
  );

  return data?.best_oa_location?.landing_page_url || data?.open_access?.oa_url || "";
}

// Ordered best-first: an open full-text copy beats the publisher DOI, which for
// Elsevier just lands on a bot wall.
async function resolveCandidateUrls(row) {
  const candidates = [await resolvePmcUrl(row.doi), await resolveOaUrl(row.doi), row.url];

  return [...new Set(candidates.filter(Boolean).filter(url => !isBlockedHost(url)))];
}

async function fetchStatic(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) return null;

    return { html: await response.text(), finalUrl: response.url };
  } catch {
    return null;
  }
}

// PMC and MDPI serve complete markup to a plain request; Nature ships a stub that
// only fills in once scripts run. Static is tried first because it is far
// cheaper, and Puppeteer picks up whatever it cannot handle.
async function loadArticle(browser, url) {
  const staticResult = await fetchStatic(url);

  if (staticResult && cheerio.load(staticResult.html)("table").length > 0) {
    return { ...staticResult, mode: "static" };
  }

  const rendered = await loadPage(browser, url);

  return { ...rendered, mode: "browser" };
}

async function main() {
  if (!(await fileExists(INDEX_FILE))) {
    console.error(`Missing ${INDEX_FILE}. Run "npm start" first.`);
    process.exitCode = 1;
    return;
  }

  const index = JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
  const targets = index
    .filter(row => row.url && row.score >= EXTRACT_MIN_SCORE && !isBlockedHost(row.url))
    // Score ranks topical fit, not extractability. A paywalled economics paper
    // can outscore a data paper and still yield nothing, so data-journal and
    // dataset records go first.
    .sort((a, b) => dataYieldRank(b) - dataYieldRank(a) || b.score - a.score)
    .slice(0, EXTRACT_LIMIT);

  console.log(
    `${index.length} indexed, ${targets.length} targeted (score >= ${EXTRACT_MIN_SCORE}, limit ${EXTRACT_LIMIT}).`,
  );

  await fs.mkdir(TABLES_DIR, { recursive: true });

  const executablePath = await getBrowserExecutablePath();
  const browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

  const tableIndexRows = [];
  const figureRows = [];
  const datasetRows = [];
  let pagesLoaded = 0;
  let pagesFailed = 0;

  try {
    for (const [position, row] of targets.entries()) {
      const label = `[${position + 1}/${targets.length}] ${row.title.slice(0, 60)}`;

      const candidates = await resolveCandidateUrls(row);

      let html = "";
      let finalUrl = "";
      let mode = "";

      for (const candidate of candidates) {
        let loaded;

        try {
          loaded = await loadArticle(browser, candidate);
        } catch (error) {
          console.log(`${label}\n    ${candidate.slice(0, 60)} failed: ${error.message}`);
          continue;
        }

        // A DOI can redirect onto a publisher that blocks headless Chrome even
        // though the candidate host looked fine.
        if (isBlockedHost(loaded.finalUrl)) continue;

        ({ html, finalUrl, mode } = loaded);

        // Stop at the first copy that actually has tables; otherwise keep this
        // one as a fallback and try the next candidate.
        if (cheerio.load(html)("table").length > 0) break;
      }

      if (!html) {
        pagesFailed += 1;
        console.log(`${label}\n    no reachable copy (${candidates.length} candidate(s))`);
        continue;
      }

      pagesLoaded += 1;

      const $ = cheerio.load(html);
      const slug = slugify(row, position);
      let savedTables = 0;

      const tables = $("table").toArray();

      for (const [tableIndex, table] of tables.entries()) {
        const grid = extractTableGrid($, table);
        const columnCount = Math.max(0, ...grid.map(cells => cells.length));

        // Layout tables and single-value boxes are not data.
        if (grid.length < MIN_TABLE_ROWS || columnCount < MIN_TABLE_COLS) continue;

        savedTables += 1;

        const fileName = `${slug}-t${savedTables}.csv`;
        await fs.writeFile(path.join(TABLES_DIR, fileName), gridToCsv(grid));

        tableIndexRows.push({
          file: path.join("data", "tables", fileName),
          doi: row.doi,
          title: row.title,
          source: row.source,
          score: row.score,
          tableNumber: savedTables,
          caption: findTableCaption($, table),
          rows: grid.length,
          columns: columnCount,
          articleUrl: finalUrl,
          domIndex: tableIndex,
        });
      }

      const figures = extractFigures($, finalUrl);

      for (const [figureIndex, figure] of figures.entries()) {
        figureRows.push({
          doi: row.doi,
          title: row.title,
          figureNumber: figureIndex + 1,
          caption: figure.caption,
          imageUrl: figure.imageUrl,
          articleUrl: finalUrl,
        });
      }

      const dataLinks = extractDataLinks($, finalUrl);

      for (const link of dataLinks) {
        datasetRows.push({
          doi: row.doi,
          title: row.title,
          linkText: link.text,
          datasetUrl: link.url,
          articleUrl: finalUrl,
        });
      }

      console.log(
        `${label}\n    [${mode}] ${finalUrl.slice(0, 62)}\n    tables=${savedTables} figures=${figures.length} datalinks=${dataLinks.length}`,
      );
    }
  } finally {
    await browser.close();
  }

  await fs.writeFile(
    path.join(DATA_DIR, "tables.csv"),
    toCsv(
      [
        "file",
        "doi",
        "title",
        "source",
        "score",
        "tableNumber",
        "caption",
        "rows",
        "columns",
        "articleUrl",
      ],
      tableIndexRows,
    ),
  );

  await fs.writeFile(
    path.join(DATA_DIR, "figures.csv"),
    toCsv(["doi", "title", "figureNumber", "caption", "imageUrl", "articleUrl"], figureRows),
  );

  await fs.writeFile(
    path.join(DATA_DIR, "datasets.csv"),
    toCsv(["doi", "title", "linkText", "datasetUrl", "articleUrl"], datasetRows),
  );

  console.log(
    [
      "",
      `Pages loaded ${pagesLoaded}, failed ${pagesFailed}.`,
      `Tables:   ${tableIndexRows.length} -> data/tables/*.csv (index: data/tables.csv)`,
      `Figures:  ${figureRows.length} -> data/figures.csv`,
      `Datasets: ${datasetRows.length} -> data/datasets.csv`,
    ].join("\n"),
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
