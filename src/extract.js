import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import { gridToCsv, toCsv } from "./csv.js";
import { readZipEntries } from "./zip.js";

// Second stage: takes the scored discovery index produced by scraper.js and
// pulls the actual content out of each article page.

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const INDEX_FILE = path.join(DATA_DIR, "articles.json");
const TABLES_DIR = path.join(DATA_DIR, "tables");
const DATASET_FILES_DIR = path.join(DATA_DIR, "dataset-files");
const FIGURE_IMAGES_DIR = path.join(DATA_DIR, "figure-images");
const RECORDS_JSON_FILE = path.join(DATA_DIR, "records.json");
const RECORDS_CSV_FILE = path.join(DATA_DIR, "records.csv");
const EXTRACT_LIMIT = Number(process.env.EXTRACT_LIMIT || 40);
const EXTRACT_MIN_SCORE = Number(process.env.EXTRACT_MIN_SCORE || 60);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS || 3500);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 45000);
const MIN_TABLE_ROWS = Number(process.env.MIN_TABLE_ROWS || 2);
const MIN_TABLE_COLS = Number(process.env.MIN_TABLE_COLS || 2);
const DOWNLOAD_DATASET_FILES = process.env.DOWNLOAD_DATASET_FILES !== "0";
const DATASET_FILE_LIMIT = Number(process.env.DATASET_FILE_LIMIT || 3);
const DATASET_MAX_BYTES = Number(process.env.DATASET_MAX_BYTES || 25 * 1024 * 1024);
const DATASET_FETCH_TIMEOUT_MS = Number(process.env.DATASET_FETCH_TIMEOUT_MS || 30000);
const DOWNLOAD_FIGURE_IMAGES = process.env.DOWNLOAD_FIGURE_IMAGES !== "0";
const FIGURE_BUNDLE_MAX_BYTES = Number(process.env.FIGURE_BUNDLE_MAX_BYTES || 50 * 1024 * 1024);
const MAILTO = process.env.CROSSREF_MAILTO || process.env.OPENALEX_MAILTO || "";
const EUROPEPMC_REST = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

// Both serve bot-challenge pages to headless Chrome; visiting them only burns
// time. Everything else is attempted.
const BLOCKED_HOSTS = ["sciencedirect.com", "ieeexplore.ieee.org"];

// Hosts that actually hold the numbers behind an article's figures.
const DATA_REPOSITORY_HOSTS = [
  "figshare.com",
  "zenodo.org",
  "doi.org/10.5281/zenodo",
  "doi.org/10.6084/m9.figshare",
  "data.mendeley.com",
  "doi.org/10.17632", // Mendeley Data DOI prefix
  "doi.org/10.7910/dvn", // Dataverse DOI prefix
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

const DATA_FILE_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".txt",
  ".json",
  ".geojson",
  ".xlsx",
  ".xls",
  ".zip",
  ".parquet",
  ".sav",
  ".dta",
  ".rds",
  ".rdata",
  ".nc",
  ".h5",
  ".hdf5",
  ".xml",
]);

const DOWNLOAD_LINK_TEXT = /\b(download|data|dataset|csv|excel|spreadsheet|supplementary|source data)\b/i;

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
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

function evidenceId(articleId, type, index) {
  return `${articleId}-${type}-${index}`;
}

function createArticleRecord(row, index) {
  return {
    id: slugify(row, index),
    recordType: "article",
    doi: row.doi,
    title: row.title,
    source: row.source,
    score: row.score,
    kind: row.kind ?? "",
    journal: row.journal ?? "",
    published: row.published ?? "",
    url: row.url,
    geography: row.geography ?? "",
    commodity: row.commodity ?? "",
    measure: row.measure ?? "",
    keyword: row.keyword ?? "",
    searchUrl: row.searchUrl ?? "",
    extraction: {
      attempted: false,
      loaded: false,
      mode: "",
      finalUrl: "",
      candidateUrls: [],
      errors: [],
      tables: [],
      figures: [],
      datasetLinks: [],
    },
    // The statistics stage can attach API/manual/PDF-derived values here without
    // creating another disconnected place to look.
    statistics: [],
  };
}

function extractionStatus(article) {
  if (article.extraction.loaded) return "loaded";
  if (article.extraction.attempted) return "failed";

  return "not_attempted";
}

function baseFlatRecord(article) {
  return {
    recordId: article.id,
    parentRecordId: "",
    recordType: "article",
    evidenceType: "article",
    doi: article.doi,
    title: article.title,
    source: article.source,
    score: article.score,
    kind: article.kind,
    commodity: article.commodity,
    measure: article.measure,
    file: "",
    url: article.url,
    resolvedUrl: "",
    articleUrl: article.extraction.finalUrl,
    caption: "",
    rows: "",
    columns: "",
    text: "",
    status: extractionStatus(article),
  };
}

function flattenRecords(articleRecords) {
  const rows = [];

  for (const article of articleRecords) {
    rows.push(baseFlatRecord(article));

    for (const table of article.extraction.tables) {
      rows.push({
        ...baseFlatRecord(article),
        recordId: table.id,
        parentRecordId: article.id,
        recordType: "evidence",
        evidenceType: "table",
        file: table.file,
        url: "",
        articleUrl: table.articleUrl,
        caption: table.caption,
        rows: table.rows,
        columns: table.columns,
        text: `table ${table.tableNumber}`,
        status: "extracted",
      });
    }

    for (const figure of article.extraction.figures) {
      rows.push({
        ...baseFlatRecord(article),
        recordId: figure.id,
        parentRecordId: article.id,
        recordType: "evidence",
        evidenceType: "figure",
        file: figure.file ?? "",
        url: figure.imageUrl,
        articleUrl: figure.articleUrl,
        caption: figure.caption,
        text: `figure ${figure.figureNumber}`,
        status: "extracted",
      });
    }

    for (const link of article.extraction.datasetLinks) {
      rows.push({
        ...baseFlatRecord(article),
        recordId: link.id,
        parentRecordId: article.id,
        recordType: "evidence",
        evidenceType: "dataset_link",
        file: (link.files ?? []).map(file => file.file).join("; "),
        url: link.datasetUrl,
        resolvedUrl: link.resolvedUrl ?? "",
        articleUrl: link.articleUrl,
        text: link.linkText,
        status: datasetDownloadStatus(link),
      });
    }

    for (const statistic of article.statistics) {
      rows.push({
        ...baseFlatRecord(article),
        recordId: statistic.id,
        parentRecordId: article.id,
        recordType: "evidence",
        evidenceType: "statistic",
        file: statistic.file ?? "",
        url: statistic.url ?? "",
        resolvedUrl: statistic.resolvedUrl ?? "",
        caption: statistic.label ?? "",
        text: statistic.value ?? "",
        status: statistic.status ?? "extracted",
      });
    }
  }

  return rows;
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

function shouldTreatRecordUrlAsDatasetLink(row) {
  return isDataRepositoryUrl(row.url) || String(row.kind).toLowerCase().includes("dataset");
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

function collectHtmlTables($) {
  return $("table")
    .toArray()
    .map((table, domIndex) => ({
      grid: extractTableGrid($, table),
      caption: findTableCaption($, table),
      domIndex,
      source: "html_table",
    }));
}

// JATS wraps every real table in <table-wrap>, with the label ("Table 1") and
// caption as siblings of the <table> rather than inside it.
function collectJatsTables($) {
  return $("table-wrap")
    .toArray()
    .map((wrap, domIndex) => {
      const table = $(wrap).find("table").first();
      const label = normalizeWhitespace($(wrap).find("label").first().text());
      const caption = normalizeWhitespace($(wrap).find("caption").first().text());

      return {
        grid: table.length > 0 ? extractTableGrid($, table) : [],
        caption: [label, caption].filter(Boolean).join(" "),
        domIndex,
        source: "jats_table",
      };
    });
}

function collectJatsFigures($, pmcid) {
  return $("fig")
    .toArray()
    .map(fig => {
      const label = normalizeWhitespace($(fig).find("label").first().text());
      const caption = normalizeWhitespace($(fig).find("caption").first().text());
      const graphic = $(fig).find("graphic").first();
      const href = graphic.attr("xlink:href") || graphic.attr("href") || "";
      const fileName = href && !/\.[a-z0-9]+$/i.test(href) ? `${href}.jpg` : href;

      return {
        caption: [label, caption].filter(Boolean).join(" "),
        graphic: href,
        imageUrl: fileName ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/bin/${fileName}` : "",
      };
    });
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

  // JATS carries external links as <ext-link xlink:href>, not <a href>.
  $("a[href], ext-link").each((_, anchor) => {
    const rawHref =
      $(anchor).attr("href") || $(anchor).attr("xlink:href") || "";
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

function isDataRepositoryUrl(url) {
  const lowerUrl = String(url ?? "").toLowerCase();

  return DATA_REPOSITORY_HOSTS.some(host => lowerUrl.includes(host));
}

function pathExtension(value) {
  try {
    return path.extname(decodeURIComponent(new URL(value).pathname)).toLowerCase();
  } catch {
    return path.extname(String(value ?? "").split(/[?#]/)[0]).toLowerCase();
  }
}

function isDataFileUrl(url) {
  return DATA_FILE_EXTENSIONS.has(pathExtension(url));
}

function safeFileName(value, fallback = "dataset-file") {
  const cleaned = normalizeWhitespace(value)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return cleaned || fallback;
}

function fileNameFromUrl(url) {
  try {
    const name = path.basename(decodeURIComponent(new URL(url).pathname));

    return name && name !== "/" ? name : "";
  } catch {
    return "";
  }
}

function fileNameFromDisposition(disposition) {
  if (!disposition) return "";

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) return decodeURIComponent(encoded[1]);

  const quoted = disposition.match(/filename="?([^";]+)"?/i);

  return quoted?.[1] ?? "";
}

function extensionFromContentType(contentType) {
  const lowerType = String(contentType ?? "").toLowerCase();

  if (lowerType.includes("text/csv")) return ".csv";
  if (lowerType.includes("tab-separated-values")) return ".tsv";
  if (lowerType.includes("spreadsheetml")) return ".xlsx";
  if (lowerType.includes("application/vnd.ms-excel")) return ".xls";
  if (lowerType.includes("application/json")) return ".json";
  if (lowerType.includes("application/zip")) return ".zip";
  if (lowerType.includes("text/plain")) return ".txt";
  if (lowerType.includes("application/xml") || lowerType.includes("text/xml")) return ".xml";

  return "";
}

function withExtension(fileName, contentType) {
  const extension = path.extname(fileName);

  if (extension) return fileName;

  return `${fileName}${extensionFromContentType(contentType) || ".dat"}`;
}

function parseZenodoRecordId(url) {
  const recordMatch = String(url).match(/zenodo\.org\/(?:record|records)\/(\d+)/i);
  if (recordMatch) return recordMatch[1];

  const doiMatch = String(url).match(/10\.5281\/zenodo\.(\d+)/i);

  return doiMatch?.[1] ?? "";
}

function parseFigshareArticleId(url) {
  const articleMatch = String(url).match(/figshare\.com\/articles\/(?:[^/]+\/)?[^/?#]+\/(\d+)/i);
  if (articleMatch) return articleMatch[1];

  const downloadMatch = String(url).match(/figshare\.com\/ndownloader\/articles\/(\d+)/i);
  if (downloadMatch) return downloadMatch[1];

  const doiMatch = String(url).match(/10\.6084\/m9\.figshare\.(\d+)/i);

  return doiMatch?.[1] ?? "";
}

// Mendeley Data is the default deposit target for Elsevier data journals
// (Data in Brief especially). The landing page is a JS app, so link-scraping the
// HTML finds nothing; the public API lists the files directly.
function parseMendeleyDatasetRef(url) {
  const pageMatch = String(url).match(/data\.mendeley\.com\/datasets\/([a-z0-9]+)(?:\/(\d+))?/i);
  if (pageMatch) return { id: pageMatch[1], version: pageMatch[2] ?? "" };

  const doiMatch = String(url).match(/10\.17632\/([a-z0-9]+)(?:\.(\d+))?/i);
  if (doiMatch) return { id: doiMatch[1], version: doiMatch[2] ?? "" };

  return null;
}

async function mendeleyFileCandidates(ref) {
  if (!ref?.id) return [];

  let { version } = ref;

  // A bare dataset URL carries no version, and the files endpoint requires one.
  if (!version) {
    const metadata = await fetchJson(`https://data.mendeley.com/public-api/datasets/${ref.id}`);
    version = String(metadata?.doi?.id ?? "").match(/\.(\d+)$/)?.[1] ?? "1";
  }

  const files = await fetchJson(
    `https://data.mendeley.com/public-api/datasets/${ref.id}/files?folder_id=root&version=${version}`,
  );

  if (!Array.isArray(files)) return [];

  return files.flatMap(file => {
    const url = file.content_details?.download_url || "";
    if (!url) return [];

    return [
      {
        url,
        fileName: file.filename || fileNameFromUrl(url),
        size: file.size ?? "",
        source: "mendeley_api",
      },
    ];
  });
}

// Publishers increasingly register the deposited dataset as a Crossref relation
// rather than linking it in body text, and PMC copies drop the link entirely.
async function resolveCrossrefSupplements(doi) {
  if (!doi) return [];

  const data = await fetchJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}${
      MAILTO ? `?mailto=${encodeURIComponent(MAILTO)}` : ""
    }`,
  );
  const relations = data?.message?.relation ?? {};
  const links = [];

  for (const [relationType, entries] of Object.entries(relations)) {
    if (!/supplement|data/i.test(relationType)) continue;

    for (const entry of entries ?? []) {
      const id = String(entry?.id ?? "");
      if (!id) continue;

      const url = /^https?:\/\//i.test(id) ? id : `https://doi.org/${id}`;
      links.push({ url, text: `crossref ${relationType}` });
    }
  }

  return uniqueBy(links, link => link.url);
}

async function resolveLandingUrl(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(DATASET_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return response.url || url;
  } catch {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(DATASET_FETCH_TIMEOUT_MS),
      });

      if (response.body) await response.body.cancel().catch(() => {});

      return response.url || url;
    } catch {
      return url;
    }
  }
}

async function fetchHtmlPage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(DATASET_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!/\b(html|xhtml|xml)\b/i.test(contentType)) {
      if (response.body) await response.body.cancel().catch(() => {});

      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 5 * 1024 * 1024) {
      if (response.body) await response.body.cancel().catch(() => {});

      return null;
    }

    return { html: await response.text(), finalUrl: response.url };
  } catch {
    return null;
  }
}

async function zenodoFileCandidates(recordId) {
  if (!recordId) return [];

  const data = await fetchJson(`https://zenodo.org/api/records/${recordId}`);

  return (data?.files ?? []).flatMap(file => {
    const url = file.links?.self || file.links?.download || file.links?.content || "";
    if (!url) return [];

    return [
      {
        url,
        fileName: file.key || file.filename || fileNameFromUrl(url),
        size: file.size ?? "",
        source: "zenodo_api",
      },
    ];
  });
}

async function figshareFileCandidates(articleId) {
  if (!articleId) return [];

  const data = await fetchJson(`https://api.figshare.com/v2/articles/${articleId}`);

  return (data?.files ?? []).flatMap(file => {
    const url = file.download_url || "";
    if (!url) return [];

    return [
      {
        url,
        fileName: file.name || fileNameFromUrl(url),
        size: file.size ?? "",
        source: "figshare_api",
      },
    ];
  });
}

async function genericHtmlFileCandidates(url) {
  const page = await fetchHtmlPage(url);
  if (!page?.html) return [];

  const $ = cheerio.load(page.html);
  const candidates = [];

  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href") || "";
    const text = normalizeWhitespace($(anchor).text());

    let absoluteUrl = "";

    try {
      absoluteUrl = new URL(href, page.finalUrl).href;
    } catch {
      return;
    }

    if (!isDataFileUrl(absoluteUrl) && !DOWNLOAD_LINK_TEXT.test(text)) return;

    candidates.push({
      url: absoluteUrl,
      fileName: fileNameFromUrl(absoluteUrl) || safeFileName(text, "dataset-file"),
      size: "",
      source: "html_link",
    });
  });

  return uniqueBy(candidates, candidate => candidate.url).slice(0, DATASET_FILE_LIMIT * 3);
}

// The same deposit reaches us in several spellings — a Crossref relation gives
// the DOI, the article body gives the landing page. Collapse them so a dataset
// is not downloaded once per spelling.
function datasetIdentity(url) {
  const mendeley = parseMendeleyDatasetRef(url);
  if (mendeley) return `mendeley:${mendeley.id}`;

  const zenodo = parseZenodoRecordId(url);
  if (zenodo) return `zenodo:${zenodo}`;

  const figshare = parseFigshareArticleId(url);
  if (figshare) return `figshare:${figshare}`;

  return String(url).replace(/\/+$/, "").toLowerCase();
}

async function resolveDatasetFileCandidates(datasetUrl) {
  const resolvedUrl = isDataFileUrl(datasetUrl) ? datasetUrl : await resolveLandingUrl(datasetUrl);
  const urlsToInspect = uniqueBy([datasetUrl, resolvedUrl].filter(Boolean), url => url);
  const candidates = [];

  for (const url of urlsToInspect) {
    if (isDataFileUrl(url)) {
      candidates.push({
        url,
        fileName: fileNameFromUrl(url),
        size: "",
        source: "direct_url",
      });
    }

    candidates.push(...(await zenodoFileCandidates(parseZenodoRecordId(url))));
    candidates.push(...(await figshareFileCandidates(parseFigshareArticleId(url))));
    candidates.push(...(await mendeleyFileCandidates(parseMendeleyDatasetRef(url))));
  }

  if (candidates.length === 0 && /^https?:\/\//i.test(resolvedUrl)) {
    candidates.push(...(await genericHtmlFileCandidates(resolvedUrl)));
  }

  return {
    resolvedUrl,
    candidates: uniqueBy(candidates, candidate => candidate.url).slice(0, DATASET_FILE_LIMIT),
  };
}

async function downloadDatasetCandidate(candidate, datasetRecord, fileIndex) {
  const response = await fetch(candidate.url, {
    headers: {
      Accept:
        "text/csv,text/tab-separated-values,application/json,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain,*/*",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(DATASET_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});

    throw new Error(`HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > DATASET_MAX_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {});

    throw new Error(`file is ${contentLength} bytes, over DATASET_MAX_BYTES=${DATASET_MAX_BYTES}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const dispositionName = fileNameFromDisposition(response.headers.get("content-disposition"));
  const rawFileName =
    dispositionName || candidate.fileName || fileNameFromUrl(response.url) || `dataset-file-${fileIndex}`;
  const safeName = withExtension(safeFileName(rawFileName, `dataset-file-${fileIndex}`), contentType);
  const extension = path.extname(safeName).toLowerCase();

  if (contentType.toLowerCase().includes("text/html") && !DATA_FILE_EXTENSIONS.has(extension)) {
    if (response.body) await response.body.cancel().catch(() => {});

    throw new Error("resolved to HTML, not a data file");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > DATASET_MAX_BYTES) {
    throw new Error(`file is ${buffer.byteLength} bytes, over DATASET_MAX_BYTES=${DATASET_MAX_BYTES}`);
  }

  const fileName = `${safeFileName(datasetRecord.id)}-f${fileIndex}-${safeName}`;
  const absoluteFile = path.join(DATASET_FILES_DIR, fileName);
  const relativeFile = path.join("data", "dataset-files", fileName);

  await fs.writeFile(absoluteFile, buffer);

  return {
    file: relativeFile,
    fileName: safeName,
    sourceUrl: response.url || candidate.url,
    bytes: buffer.byteLength,
    contentType,
    source: candidate.source,
  };
}

async function downloadDatasetFiles(datasetRecord) {
  datasetRecord.resolvedUrl = datasetRecord.datasetUrl;
  datasetRecord.files = [];
  datasetRecord.errors = [];
  datasetRecord.downloadStatus = DOWNLOAD_DATASET_FILES ? "not_attempted" : "disabled";

  if (!DOWNLOAD_DATASET_FILES) return;

  try {
    const { resolvedUrl, candidates } = await resolveDatasetFileCandidates(datasetRecord.datasetUrl);
    datasetRecord.resolvedUrl = resolvedUrl;

    if (candidates.length === 0) {
      datasetRecord.downloadStatus = "no_public_file_found";
      return;
    }

    for (const [candidateIndex, candidate] of candidates.entries()) {
      try {
        const file = await downloadDatasetCandidate(candidate, datasetRecord, candidateIndex + 1);
        datasetRecord.files.push(file);
      } catch (error) {
        datasetRecord.errors.push({ url: candidate.url, message: error.message });
      }
    }

    datasetRecord.downloadStatus = datasetRecord.files.length > 0 ? "downloaded" : "failed";
  } catch (error) {
    datasetRecord.downloadStatus = "failed";
    datasetRecord.errors.push({ url: datasetRecord.datasetUrl, message: error.message });
  }
}

function datasetDownloadStatus(link) {
  if (link.downloadStatus) return link.downloadStatus;
  if (link.files?.length > 0) return "downloaded";
  if (link.errors?.length > 0) return "failed";

  return "linked";
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
async function resolvePmcId(doi) {
  if (!doi) return "";

  const query = encodeURIComponent(`DOI:"${doi}"`);
  const data = await fetchJson(
    `${EUROPEPMC_REST}/search?query=${query}&format=json&resultType=core`,
  );

  return data?.resultList?.result?.[0]?.pmcid ?? "";
}

function pmcArticleUrl(pmcid) {
  return pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : "";
}

// PMC's /bin/ image URLs sit behind the same reCAPTCHA as its article pages.
// Europe PMC serves every figure raster for an article as one zip instead.
async function fetchFigureImageBundle(pmcid) {
  if (!pmcid || !DOWNLOAD_FIGURE_IMAGES) return null;

  try {
    const response = await fetch(`${EUROPEPMC_REST}/${pmcid}/supplementaryFiles`, {
      headers: { Accept: "application/zip", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DATASET_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});

      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > FIGURE_BUNDLE_MAX_BYTES) return null;

    return readZipEntries(buffer);
  } catch {
    return null;
  }
}

// A figure's <graphic> names the image without an extension ("gr1"), while the
// bundle carries several renditions of it. Raster beats the vector-ish GIF
// thumbnails Elsevier ships alongside.
function pickFigureImage(bundle, graphic) {
  if (!bundle || !graphic) return null;

  const base = graphic.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const matches = [...bundle.keys()].filter(
    name => path.basename(name).replace(/\.[a-z0-9]+$/i, "").toLowerCase() === base,
  );

  if (matches.length === 0) return null;

  const preference = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif"];
  const rank = name => {
    const position = preference.indexOf(path.extname(name).toLowerCase());

    return position < 0 ? preference.length : position;
  };
  const best = matches.sort((a, b) => rank(a) - rank(b))[0];

  return { name: path.basename(best), data: bundle.get(best) };
}

// PMC's own site now intermittently answers headless clients with a reCAPTCHA
// interstitial, which reads as an article with zero tables. Europe PMC serves
// the same open-access text as JATS XML with no bot wall, so it is tried first.
async function fetchJatsFullText(pmcid) {
  if (!pmcid) return null;

  try {
    const response = await fetch(`${EUROPEPMC_REST}/${pmcid}/fullTextXML`, {
      headers: { Accept: "application/xml", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) return null;

    const xml = await response.text();

    return xml.includes("<article") ? xml : null;
  } catch {
    return null;
  }
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
async function resolveCandidateUrls(row, pmcid) {
  const candidates = [pmcArticleUrl(pmcid), await resolveOaUrl(row.doi), row.url];

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
  const articleRecords = targets.map((row, index) => createArticleRecord(row, index));

  console.log(
    `${index.length} indexed, ${targets.length} targeted (score >= ${EXTRACT_MIN_SCORE}, limit ${EXTRACT_LIMIT}).`,
  );

  await fs.mkdir(TABLES_DIR, { recursive: true });
  await fs.mkdir(DATASET_FILES_DIR, { recursive: true });
  await fs.mkdir(FIGURE_IMAGES_DIR, { recursive: true });

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
  let downloadedDatasetFiles = 0;
  let downloadedFigureImages = 0;

  try {
    for (const [position, row] of targets.entries()) {
      const label = `[${position + 1}/${targets.length}] ${row.title.slice(0, 60)}`;
      const articleRecord = articleRecords[position];
      const slug = articleRecord.id;

      const pmcid = await resolvePmcId(row.doi);
      const candidates = await resolveCandidateUrls(row, pmcid);
      articleRecord.extraction.attempted = true;
      articleRecord.extraction.candidateUrls = candidates;

      let html = "";
      let finalUrl = "";
      let mode = "";
      let isJats = false;

      const jats = await fetchJatsFullText(pmcid);

      if (jats) {
        const $jats = cheerio.load(jats, { xmlMode: true });

        // A JATS record with neither tables nor figures is usually an
        // abstract-only stub; the rendered page may still have the real thing.
        if ($jats("table-wrap").length > 0 || $jats("fig").length > 0) {
          html = jats;
          isJats = true;
          mode = "europepmc_xml";
          finalUrl = `https://europepmc.org/article/PMC/${pmcid}`;
        }
      }

      for (const candidate of html ? [] : candidates) {
        let loaded;

        try {
          loaded = await loadArticle(browser, candidate);
        } catch (error) {
          articleRecord.extraction.errors.push({ url: candidate, message: error.message });
          console.log(`${label}\n    ${candidate.slice(0, 60)} failed: ${error.message}`);
          continue;
        }

        // A DOI can redirect onto a publisher that blocks headless Chrome even
        // though the candidate host looked fine.
        if (isBlockedHost(loaded.finalUrl)) {
          articleRecord.extraction.errors.push({
            url: candidate,
            message: `redirected to blocked host: ${loaded.finalUrl}`,
          });
          continue;
        }

        ({ html, finalUrl, mode } = loaded);

        // Stop at the first copy that actually has tables; otherwise keep this
        // one as a fallback and try the next candidate.
        if (cheerio.load(html)("table").length > 0) break;
      }

      if (!html) {
        pagesFailed += 1;
        articleRecord.extraction.errors.push({
          url: "",
          message: `no reachable copy (${candidates.length} candidate(s))`,
        });
        console.log(`${label}\n    no reachable copy (${candidates.length} candidate(s))`);
        continue;
      }

      pagesLoaded += 1;
      articleRecord.extraction.loaded = true;
      articleRecord.extraction.mode = mode;
      articleRecord.extraction.finalUrl = finalUrl;

      const $ = cheerio.load(html, isJats ? { xmlMode: true } : undefined);
      let savedTables = 0;

      const tables = isJats ? collectJatsTables($) : collectHtmlTables($);

      for (const table of tables) {
        const { grid } = table;
        const columnCount = Math.max(0, ...grid.map(cells => cells.length));

        // Layout tables and single-value boxes are not data.
        if (grid.length < MIN_TABLE_ROWS || columnCount < MIN_TABLE_COLS) continue;

        savedTables += 1;

        const fileName = `${slug}-t${savedTables}.csv`;
        const file = path.join("data", "tables", fileName);
        await fs.writeFile(path.join(TABLES_DIR, fileName), gridToCsv(grid));

        const tableRecord = {
          id: evidenceId(slug, "table", savedTables),
          file,
          tableNumber: savedTables,
          caption: table.caption,
          rows: grid.length,
          columns: columnCount,
          articleUrl: finalUrl,
          domIndex: table.domIndex,
          source: table.source,
        };

        articleRecord.extraction.tables.push(tableRecord);

        tableIndexRows.push({
          file,
          doi: row.doi,
          title: row.title,
          source: row.source,
          score: row.score,
          tableNumber: savedTables,
          caption: tableRecord.caption,
          rows: grid.length,
          columns: columnCount,
          articleUrl: finalUrl,
          domIndex: table.domIndex,
        });
      }

      const figures = isJats ? collectJatsFigures($, pmcid) : extractFigures($, finalUrl);
      const figureBundle = isJats && figures.length > 0 ? await fetchFigureImageBundle(pmcid) : null;
      let savedFigureImages = 0;

      for (const [figureIndex, figure] of figures.entries()) {
        const figureNumber = figureIndex + 1;
        const image = pickFigureImage(figureBundle, figure.graphic);
        let file = "";

        if (image?.data) {
          const imageFileName = `${slug}-fig${figureNumber}-${safeFileName(image.name, "figure")}`;
          file = path.join("data", "figure-images", imageFileName);
          await fs.writeFile(path.join(FIGURE_IMAGES_DIR, imageFileName), image.data);
          savedFigureImages += 1;
        }

        const figureRecord = {
          id: evidenceId(slug, "figure", figureNumber),
          figureNumber,
          caption: figure.caption,
          file,
          imageUrl: figure.imageUrl,
          articleUrl: finalUrl,
        };

        articleRecord.extraction.figures.push(figureRecord);

        figureRows.push({
          doi: row.doi,
          title: row.title,
          figureNumber,
          caption: figure.caption,
          file,
          imageUrl: figure.imageUrl,
          articleUrl: finalUrl,
        });
      }

      downloadedFigureImages += savedFigureImages;

      const dataLinks = uniqueBy(
        [...(await resolveCrossrefSupplements(row.doi)), ...extractDataLinks($, finalUrl)],
        link => datasetIdentity(link.url),
      );
      if (
        shouldTreatRecordUrlAsDatasetLink(row) &&
        !dataLinks.some(link => datasetIdentity(link.url) === datasetIdentity(row.url))
      ) {
        dataLinks.unshift({ url: row.url, text: "record URL" });
      }

      for (const [linkIndex, link] of dataLinks.entries()) {
        const datasetRecord = {
          id: evidenceId(slug, "dataset", linkIndex + 1),
          linkText: link.text,
          datasetUrl: link.url,
          resolvedUrl: link.url,
          downloadStatus: "linked",
          files: [],
          errors: [],
          articleUrl: finalUrl,
        };

        await downloadDatasetFiles(datasetRecord);
        downloadedDatasetFiles += datasetRecord.files.length;

        articleRecord.extraction.datasetLinks.push(datasetRecord);

        datasetRows.push({
          doi: row.doi,
          title: row.title,
          linkText: link.text,
          datasetUrl: link.url,
          resolvedUrl: datasetRecord.resolvedUrl,
          downloadedFiles: datasetRecord.files.map(file => file.file).join("; "),
          downloadStatus: datasetRecord.downloadStatus,
          downloadError: datasetRecord.errors.map(error => error.message).join("; "),
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
    toCsv(
      ["doi", "title", "figureNumber", "caption", "file", "imageUrl", "articleUrl"],
      figureRows,
    ),
  );

  await fs.writeFile(
    path.join(DATA_DIR, "datasets.csv"),
    toCsv(
      [
        "doi",
        "title",
        "linkText",
        "datasetUrl",
        "resolvedUrl",
        "downloadedFiles",
        "downloadStatus",
        "downloadError",
        "articleUrl",
      ],
      datasetRows,
    ),
  );

  await fs.writeFile(RECORDS_JSON_FILE, JSON.stringify(articleRecords, null, 2));

  await fs.writeFile(
    RECORDS_CSV_FILE,
    toCsv(
      [
        "recordId",
        "parentRecordId",
        "recordType",
        "evidenceType",
        "doi",
        "title",
        "source",
        "score",
        "kind",
        "commodity",
        "measure",
        "file",
        "url",
        "resolvedUrl",
        "articleUrl",
        "caption",
        "rows",
        "columns",
        "text",
        "status",
      ],
      flattenRecords(articleRecords),
    ),
  );

  console.log(
    [
      "",
      `Pages loaded ${pagesLoaded}, failed ${pagesFailed}.`,
      `Tables:   ${tableIndexRows.length} -> data/tables/*.csv (index: data/tables.csv)`,
      `Figures:  ${figureRows.length} captions, ${downloadedFigureImages} images -> data/figures.csv and data/figure-images/*`,
      `Datasets: ${datasetRows.length} links, ${downloadedDatasetFiles} files -> data/datasets.csv and data/dataset-files/*`,
      `Records:  ${articleRecords.length} -> data/records.json and data/records.csv`,
    ].join("\n"),
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
