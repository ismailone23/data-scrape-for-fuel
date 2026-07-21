import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { apiSources, browserSources } from "./sources.js";
import { buildQueryVariants } from "./queries.js";
import { scoreCandidate } from "./relevance.js";

const ROOT_DIR = process.cwd();
const KEYWORDS_FILE = path.join(ROOT_DIR, "keywords.txt");
const OUTPUT_DIR = path.join(ROOT_DIR, "data");
const MAX_RESULTS_PER_SEARCH = Number(process.env.MAX_RESULTS_PER_SEARCH || 50);
const MAX_QUERY_VARIANTS = Number(process.env.MAX_QUERY_VARIANTS || 4);
const MIN_SCORE = Number(process.env.MIN_SCORE || 45);
const REQUIRE_TITLE_COMMODITY = process.env.REQUIRE_TITLE_COMMODITY !== "0";
const WAIT_BETWEEN_SEARCHES_MS = Number(process.env.WAIT_BETWEEN_SEARCHES_MS || 300);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 2000);
const KEYWORD_LIMIT = Number(process.env.KEYWORD_LIMIT || 0);
const SOURCE_FILTER = process.env.SOURCE_FILTER || "";
const SINGLE_QUERY = process.env.QUERY || "";
const MAILTO = process.env.CROSSREF_MAILTO || process.env.OPENALEX_MAILTO || "";
const SKIP_BROWSER = process.env.SKIP_BROWSER === "1";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const BLOCK_TEXT_MARKERS = [
  "captcha",
  "verify you are human",
  "access denied",
  "unusual traffic",
  "there was a problem providing the content you requested",
  "ip blocked",
];
const SYSTEM_BROWSER_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function readKeywords() {
  if (SINGLE_QUERY) return [SINGLE_QUERY];

  const raw = await fs.readFile(KEYWORDS_FILE, "utf8");
  const keywords = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  return KEYWORD_LIMIT > 0 ? keywords.slice(0, KEYWORD_LIMIT) : keywords;
}

function csvEscape(value) {
  const text = String(value ?? "");

  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_COLUMNS = [
  "score",
  "source",
  "kind",
  "title",
  "journal",
  "published",
  "doi",
  "url",
  "geography",
  "commodity",
  "measure",
  "keyword",
  "searchUrl",
];

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];

  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(column => csvEscape(row[column])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

// OpenAlex throttles hard over a long run and answers 429. Without a retry the
// source silently contributes nothing for the rest of the run, which is exactly
// what happened before this was added.
async function fetchJson(url, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": MAILTO ? `datasets-generator/2.0 (mailto:${MAILTO})` : USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_RETRIES) {
        console.warn(`  ! ${response.status} after ${MAX_RETRIES} retries: ${new URL(url).host}`);
        return null;
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * 2 ** attempt;

      await sleep(backoffMs);

      return fetchJson(url, attempt + 1);
    }

    if (!response.ok) return null;

    return await response.json();
  } catch {
    return null;
  }
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

function isSourceEnabled(name) {
  const selected = SOURCE_FILTER.split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);

  if (selected.length === 0) return true;

  return selected.some(entry => name.toLowerCase().includes(entry));
}

function isBlockedText(text) {
  const lowerText = text.toLowerCase();

  return BLOCK_TEXT_MARKERS.some(marker => lowerText.includes(marker));
}

function extractResultsFromHtml(html, source, searchUrl) {
  if (!html) return [];

  const $ = cheerio.load(html);

  if (isBlockedText($("body").text())) return [];

  const anchors = source.selectors.flatMap(selector => $(selector).toArray());
  const fallbackAnchors = $("a[href]")
    .toArray()
    .filter(anchor =>
      source.preferredLinkPatterns.some(pattern => ($(anchor).attr("href") || "").includes(pattern)),
    );

  return [...anchors, ...fallbackAnchors].flatMap(anchor => {
    const href = $(anchor).attr("href") || "";
    const title = $(anchor).text() || $(anchor).attr("aria-label") || $(anchor).attr("title") || "";

    try {
      return [{ title: normalizeWhitespace(title), url: new URL(href, searchUrl).href }];
    } catch {
      return [];
    }
  });
}

async function fetchSearchHtml(searchUrl) {
  try {
    const response = await fetch(searchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    return response.ok ? await response.text() : "";
  } catch {
    return "";
  }
}

async function searchBrowserSource(browser, source, query) {
  const searchUrl = source.buildSearchUrl(query);
  const html = await fetchSearchHtml(searchUrl);
  const staticItems = extractResultsFromHtml(html, source, searchUrl);

  if (staticItems.length > 0 || !browser) {
    return staticItems.map(item => ({ ...item, searchUrl }));
  }

  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(USER_AGENT);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await sleep(2500);

    const renderedHtml = await page.content();

    return extractResultsFromHtml(renderedHtml, source, searchUrl).map(item => ({
      ...item,
      searchUrl,
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

// Repositories mint a fresh DOI per version -- 10.17632/63pxv64h75, .1, .4 and
// figshare's .v1 are all the same deposit -- so the version suffix is stripped
// before comparing.
function normalizeDoi(doi) {
  return doi
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, "")
    .replace(/\.v?\d+$/, "");
}

// Title is the primary key: the same work reaches us from several sources under
// preprint, version-of-record and mirror DOIs that no DOI normalization can
// reconcile. DOI is the fallback for records with a missing or stub title.
function dedupeKey(row) {
  const normalizedTitle = row.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (normalizedTitle.length >= 15) return `title:${normalizedTitle}`;

  return row.doi ? `doi:${normalizeDoi(row.doi)}` : `title:${normalizedTitle}`;
}

async function main() {
  const keywords = await readKeywords();
  const enabledApiSources = apiSources.filter(source => isSourceEnabled(source.name));
  const enabledBrowserSources = SKIP_BROWSER
    ? []
    : browserSources.filter(source => isSourceEnabled(source.name));

  const rowsByKey = new Map();
  let examined = 0;

  function record(candidate, sourceName, keyword) {
    examined += 1;

    if (!candidate.title || !candidate.url) return;

    const relevance = scoreCandidate(candidate);

    if (relevance.score < MIN_SCORE) return;

    // A record with no commodity term is off-domain no matter how well it scores
    // on geography and measure: "Cost benefit analysis of cassava production in
    // Sherpur district of Bangladesh" clears the threshold on those two alone.
    if (relevance.commodity.length === 0) return;
    if (REQUIRE_TITLE_COMMODITY && !relevance.commodityInTitle) return;

    const row = {
      score: relevance.score,
      source: sourceName,
      kind: candidate.kind ?? "",
      title: candidate.title,
      journal: candidate.journal ?? "",
      published: candidate.published ?? "",
      doi: candidate.doi ?? "",
      url: candidate.url,
      abstract: candidate.abstract ?? "",
      geography: relevance.geography.join("; "),
      commodity: relevance.commodity.join("; "),
      measure: relevance.measure.join("; "),
      keyword,
      searchUrl: candidate.searchUrl ?? "",
    };

    const key = dedupeKey(row);
    const existing = rowsByKey.get(key);

    // Keep the highest-scoring copy so the richest metadata wins.
    if (existing && existing.score >= row.score) return;

    rowsByKey.set(key, row);
  }

  let browser = null;

  if (enabledBrowserSources.length > 0) {
    const executablePath = await getBrowserExecutablePath();

    browser = await puppeteer.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  }

  try {
    for (const keyword of keywords) {
      const variants = buildQueryVariants(keyword, MAX_QUERY_VARIANTS);
      console.log(`\n${keyword}`);
      console.log(`  variants: ${variants.join(" | ")}`);

      for (const variant of variants) {
        const apiResults = await Promise.all(
          enabledApiSources.map(async source => {
            try {
              const items = await source.search(variant, {
                rows: MAX_RESULTS_PER_SEARCH,
                mailto: MAILTO,
                fetchJson,
              });

              return { source, items: items ?? [] };
            } catch (error) {
              console.warn(`  ! ${source.name}: ${error.message}`);
              return { source, items: [] };
            }
          }),
        );

        for (const { source, items } of apiResults) {
          for (const item of items) record(item, source.name, keyword);
        }

        for (const source of enabledBrowserSources) {
          try {
            const items = await searchBrowserSource(browser, source, variant);

            for (const item of items) record(item, source.name, keyword);
          } catch (error) {
            console.warn(`  ! ${source.name}: ${error.message}`);
          }
        }

        console.log(`  "${variant}" -> ${rowsByKey.size} kept so far`);
        await sleep(WAIT_BETWEEN_SEARCHES_MS);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  const rows = [...rowsByKey.values()].sort(
    (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, "articles.json"), JSON.stringify(rows, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, "articles.csv"), toCsv(rows));

  console.log(`\nExamined ${examined} candidates, kept ${rows.length} at score >= ${MIN_SCORE}.`);

  // Counted from the final rows, so a source only gets credit for records that
  // actually survived dedupe.
  const stats = new Map();

  for (const row of rows) stats.set(row.source, (stats.get(row.source) ?? 0) + 1);

  for (const [source, count] of [...stats].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source}: ${count}`);
  }

  console.log("\nSaved data/articles.json and data/articles.csv");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
