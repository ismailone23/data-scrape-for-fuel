import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { sites } from "./sites.js";

const ROOT_DIR = process.cwd();
const KEYWORDS_FILE = path.join(ROOT_DIR, "keywords.txt");
const OUTPUT_DIR = path.join(ROOT_DIR, "data");
const MAX_RESULTS_PER_SEARCH = Number(process.env.MAX_RESULTS_PER_SEARCH || 20);
const WAIT_BETWEEN_SEARCHES_MS = Number(process.env.WAIT_BETWEEN_SEARCHES_MS || 3500);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const KEYWORD_LIMIT = Number(process.env.KEYWORD_LIMIT || 0);
const SITE_FILTER = process.env.SITE_FILTER || "";
const SINGLE_QUERY = process.env.QUERY || "";
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || "";
const STRICT_CROSSREF_RELEVANCE = process.env.STRICT_CROSSREF_RELEVANCE !== "0";
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
const FUEL_TERMS = [
  "crude oil",
  "petroleum",
  "petroleum products",
  "refined oil",
  "diesel",
  "hsd",
  "high speed diesel",
  "petrol",
  "motor spirit",
  "gasoline",
  "octane",
  "hobc",
  "kerosene",
  "sko",
  "jet a-1",
  "jet fuel",
  "furnace oil",
  "fuel oil",
  "hsfo",
  "ldo",
  "light diesel oil",
  "naphtha",
  "bitumen",
  "condensate",
  "natural gas",
  "pipeline gas",
  "liquefied natural gas",
  "lng",
  "regasified lng",
  "rlng",
  "liquefied petroleum gas",
  "lpg",
  "autogas",
  "compressed natural gas",
  "cng",
  "fuel",
  "oil",
];
const FERTILIZER_TERMS = ["fertilizer", "fertiliser", "urea", "dap", "tsp", "mop"];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readKeywords() {
  if (SINGLE_QUERY) {
    return [SINGLE_QUERY];
  }

  const raw = await fs.readFile(KEYWORDS_FILE, "utf8");

  const keywords = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  if (KEYWORD_LIMIT > 0) {
    return keywords.slice(0, KEYWORD_LIMIT);
  }

  return keywords;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function toCsv(rows) {
  const columns = ["source", "keyword", "title", "journal", "doi", "published", "url", "searchUrl"];
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(columns.map(column => csvEscape(row[column])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function dedupeItems(items) {
  return items.filter(
    (item, index, allItems) =>
      item.title &&
      item.url &&
      allItems.findIndex(other => other.url === item.url || other.title === item.title) === index,
  );
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
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  for (const browserPath of SYSTEM_BROWSER_PATHS) {
    if (await fileExists(browserPath)) return browserPath;
  }

  return null;
}

function getEnabledSites() {
  const selectedSites = SITE_FILTER
    .split(",")
    .map(site => site.trim().toLowerCase())
    .filter(Boolean);

  if (selectedSites.length === 0) return sites;

  return sites.filter(site =>
    selectedSites.some(selectedSite => site.name.toLowerCase().includes(selectedSite)),
  );
}

function isProbablyArticleLink(item, site) {
  if (!item.title || item.title.length < 20 || !item.url) return false;
  if (item.title.toLowerCase().includes("sign in")) return false;
  if (item.title.toLowerCase().includes("subscribe")) return false;

  if (!site.preferredLinkPatterns) return true;

  return site.preferredLinkPatterns.some(pattern => item.url.includes(pattern));
}

function isBlockedText(text) {
  const lowerText = text.toLowerCase();

  return BLOCK_TEXT_MARKERS.some(marker => lowerText.includes(marker));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesAnyTerm(text, terms) {
  return terms.some(term => {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i");
    return pattern.test(text);
  });
}

function getCommodityIntentTerms(keyword) {
  const lowerKeyword = keyword.toLowerCase();
  const intentTerms = [];

  if (includesAnyTerm(lowerKeyword, FUEL_TERMS)) {
    intentTerms.push(...FUEL_TERMS);
  }

  if (includesAnyTerm(lowerKeyword, FERTILIZER_TERMS)) {
    intentTerms.push(...FERTILIZER_TERMS);
  }

  return [...new Set(intentTerms)];
}

function isRelevantCrossrefCandidate(item, keyword) {
  if (!STRICT_CROSSREF_RELEVANCE) return true;

  const commodityIntentTerms = getCommodityIntentTerms(keyword);

  if (commodityIntentTerms.length === 0) return true;

  return includesAnyTerm(item.title, commodityIntentTerms);
}

async function detectChallenge(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");

  return isBlockedText(bodyText);
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

    if (!response.ok) return "";

    return response.text();
  } catch {
    return "";
  }
}

function extractResultsFromHtml(html, site, searchUrl) {
  if (!html) return [];

  const $ = cheerio.load(html);
  const bodyText = $("body").text();

  if (isBlockedText(bodyText)) {
    console.warn(`Skipped ${site.name}: block or access page detected.`);
    return [];
  }

  const anchors = site.selectors.flatMap(selector => $(selector).toArray());
  const fallbackAnchors = $("a[href]")
    .toArray()
    .filter(anchor => {
      const href = $(anchor).attr("href") || "";
      return site.preferredLinkPatterns.some(pattern => href.includes(pattern));
    });

  const items = [...anchors, ...fallbackAnchors].map(anchor => {
    const href = $(anchor).attr("href") || "";
    const title =
      $(anchor).text() || $(anchor).attr("aria-label") || $(anchor).attr("title") || "";

    try {
      return {
        title: normalizeWhitespace(title),
        url: new URL(href, searchUrl).href,
      };
    } catch {
      return { title: "", url: "" };
    }
  });

  return dedupeItems(items).slice(0, MAX_RESULTS_PER_SEARCH);
}

async function extractResults(page, site) {
  return page.evaluate(
    ({ selectors, preferredLinkPatterns, maxResults }) => {
      const makeAbsolute = href => {
        try {
          return new URL(href, window.location.origin).href;
        } catch {
          return "";
        }
      };

      const anchors = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      const fallbackAnchors = [...document.querySelectorAll("a[href]")].filter(anchor =>
        preferredLinkPatterns.some(pattern => anchor.href.includes(pattern)),
      );

      return [...anchors, ...fallbackAnchors]
        .map(anchor => ({
          title: anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "",
          url: makeAbsolute(anchor.getAttribute("href") || anchor.href),
        }))
        .map(item => ({
          title: item.title.replace(/\s+/g, " ").trim(),
          url: item.url,
        }))
        .filter((item, index, items) =>
          item.title &&
          item.url &&
          items.findIndex(other => other.url === item.url || other.title === item.title) === index,
        )
        .slice(0, maxResults);
    },
    {
      selectors: site.selectors,
      preferredLinkPatterns: site.preferredLinkPatterns,
      maxResults: MAX_RESULTS_PER_SEARCH,
    },
  );
}

function formatResults(items, site, keyword, searchUrl) {
  return items
    .map(item => ({
      source: site.name,
      keyword,
      title: normalizeWhitespace(item.title),
      url: item.url,
      searchUrl,
    }))
    .filter(item => isProbablyArticleLink(item, site));
}

async function searchCrossref(site, keyword) {
  const params = new URLSearchParams({
    "query.bibliographic": keyword,
    filter: `issn:${site.issn},type:journal-article`,
    rows: String(Math.min(MAX_RESULTS_PER_SEARCH * 10, 100)),
  });

  if (CROSSREF_MAILTO) {
    params.set("mailto", CROSSREF_MAILTO);
  }

  const searchUrl = `https://api.crossref.org/works?${params.toString()}`;

  try {
    const response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": CROSSREF_MAILTO
          ? `datasets-generator/1.0 (mailto:${CROSSREF_MAILTO})`
          : USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const items = data.message?.items ?? [];

    return items
      .map(item => ({
        source: site.name,
        keyword,
        title: normalizeWhitespace(item.title?.[0] ?? ""),
        journal: item["container-title"]?.[0] ?? site.journal,
        doi: item.DOI ?? "",
        published:
          item.published?.["date-time"] ??
          item.published?.["date-parts"]?.[0]?.filter(Boolean).join("-") ??
          "",
        url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ""),
        searchUrl,
      }))
      .filter(item => item.title && item.url && isRelevantCrossrefCandidate(item, keyword))
      .slice(0, MAX_RESULTS_PER_SEARCH);
  } catch {
    return [];
  }
}

async function createPage(browser) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(USER_AGENT);

  return page;
}

async function searchSite(browser, site, keyword) {
  if (site.type === "crossref") {
    return searchCrossref(site, keyword);
  }

  const searchUrl = site.buildSearchUrl(keyword);
  const html = await fetchSearchHtml(searchUrl);
  const htmlItems = formatResults(extractResultsFromHtml(html, site, searchUrl), site, keyword, searchUrl);

  if (htmlItems.length > 0) {
    return htmlItems;
  }

  const page = await createPage(browser);

  try {
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await sleep(3000);

    if (await detectChallenge(page)) {
      console.warn(`Skipped ${site.name}: bot challenge or access block detected.`);
      return [];
    }

    const items = await extractResults(page, site);

    return formatResults(items, site, keyword, searchUrl);
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const keywords = await readKeywords();
  const enabledSites = getEnabledSites();
  const browserExecutablePath = await getBrowserExecutablePath();
  const launchOptions = {
    headless: "new",
  };

  if (browserExecutablePath) {
    launchOptions.executablePath = browserExecutablePath;
  }

  const browser = await puppeteer.launch({
    ...launchOptions,
  });

  const results = [];
  const seen = new Set();

  try {
    for (const site of enabledSites) {
      for (const keyword of keywords) {
        console.log(`Searching ${site.name}: ${keyword}`);

        try {
          const items = await searchSite(browser, site, keyword);
          console.log(`Found ${items.length} result(s).`);

          for (const item of items) {
            const key = `${item.source}:${item.url}`;
            if (seen.has(key)) continue;

            seen.add(key);
            results.push(item);
          }
        } catch (error) {
          console.warn(`Failed ${site.name} / ${keyword}: ${error.message}`);
        }

        await sleep(WAIT_BETWEEN_SEARCHES_MS);
      }
    }
  } finally {
    await browser.close();
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, "articles.json"), JSON.stringify(results, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, "articles.csv"), toCsv(results));

  console.log(`Saved ${results.length} unique results to data/articles.json and data/articles.csv`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
