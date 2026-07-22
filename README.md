# datasets-generator

Keyword-based discovery of logistics, supply-chain, depot, storage, fuel/oil/LNG,
and fertilizer dataset articles — focused on Bangladesh, with broader fallbacks.

## How it works

Each keyword line goes through three stages:

1. **Query decomposition** (`src/queries.js`) — long lines are split into short
   `geography x commodity x measure` probes. `"Bangladesh petroleum annual report
   imports sales capacity"` becomes `bangladesh petroleum capacity`,
   `bangladesh petroleum imports`, `bangladesh petroleum sales`. Extra words widen
   a fuzzy match rather than narrowing it, so short probes recall more *and*
   cleaner.
2. **Multi-source search** (`src/sources.js`) — five metadata APIs plus two
   browser-scraped sites, queried per variant.
3. **Relevance scoring** (`src/relevance.js`) — every candidate is scored 0-100
   across three facets, with a penalty list for off-domain vocabulary. Only rows
   at or above `MIN_SCORE` are kept, sorted best-first.

## Sources

| Source | Type | Notes |
| --- | --- | --- |
| OpenAlex | API | ~250M works, no journal restriction, abstracts included |
| Crossref | API | All journal articles |
| Crossref Data Journals | API | Data in Brief, Scientific Data, Data (MDPI), ESSD, IEEE Access |
| DataCite | API | Dataset DOIs (Dataverse, institutional repositories) |
| Zenodo | API | Datasets and deposited papers |
| Scientific Data (nature.com) | Browser | Puppeteer fallback when static fetch is empty |
| IEEE DataPort | Browser | Puppeteer fallback when static fetch is empty |

ScienceDirect and IEEE Xplore were removed — both serve bot-challenge pages and
returned nothing but latency.

## Scoring

`scoreCandidate()` awards points per facet, title hits counting more than
abstract hits:

| Signal | Title | Abstract |
| --- | --- | --- |
| Geography (bangladesh, dhaka, chattogram, mongla, payra, …) | +30 | +12 |
| Commodity (petroleum, diesel, LNG, LPG, urea, fertilizer, …) | +26 | +10 |
| Measure (import, demand, capacity, cost, distance, lead time, …) | +20 | +8 |
| Dataset hint ("dataset", "panel data", "time series") | +10 | — |
| Penalty (olive oil, transcriptome, engine emission, spent fuel, …) | -45 | -15 |

Two hard gates run alongside the score:

- a commodity term must be present, and
- by default it must appear **in the title**. Crop-economics papers list
  fertilizer as an input in the abstract, which is why
  `"Cost benefit analysis of cassava production in Sherpur district of Bangladesh"`
  used to pass. Set `REQUIRE_TITLE_COMMODITY=0` to relax this.

The score, plus the matched geography/commodity/measure terms, are written as CSV
columns so you can re-sort or re-filter in a spreadsheet without re-scraping.

## Install

```bash
npm install
```

## Run

```bash
CROSSREF_MAILTO=you@example.com npm start
```

Supplying a mail address puts both Crossref and OpenAlex in their polite pools,
which is faster and less likely to be throttled.

Results are written to `data/articles.json` and `data/articles.csv`, sorted by
score descending. `articles.csv` keeps the DOI/landing `url` but omits
`searchUrl`; the JSON keeps `searchUrl` for provenance.

## Options

```bash
MIN_SCORE=60 npm start                  # stricter; 45 is the default
MIN_SCORE=30 npm start                  # looser, more recall
REQUIRE_TITLE_COMMODITY=0 npm start     # allow abstract-only commodity matches
MAX_RESULTS_PER_SEARCH=100 npm start    # rows requested per source per variant
MAX_QUERY_VARIANTS=6 npm start          # more probes per keyword line
SKIP_BROWSER=1 npm start                # APIs only; much faster
SOURCE_FILTER=OpenAlex,Zenodo npm start # restrict to named sources
KEYWORD_LIMIT=5 npm start               # first N keyword lines only
QUERY="bangladesh lng import" npm start # one ad-hoc query
```

Quick smoke test:

```bash
KEYWORD_LIMIT=3 SKIP_BROWSER=1 npm start
```

## Tuning relevance

The four lexicons in `src/relevance.js` are the main tuning surface:

- `GEOGRAPHY_TERMS`, `COMMODITY_TERMS`, `MEASURE_TERMS` — add domain vocabulary here
- `PENALTY_TERMS` — whole-word off-domain terms
- `PENALTY_STEMS` — word-initial stems (`transcriptom` covers transcriptome and
  transcriptomic)

Bare `"oil"` and `"fuel"` are deliberately **not** commodity terms: they matched
olive oil, palm oil and spent nuclear fuel. Use compound forms
(`"crude oil"`, `"fuel demand"`) instead. Penalty terms are matched on whole words
for the same reason — as substrings, `"rat"` fired inside `"strategy"`.

If a run returns too little, lower `MIN_SCORE` and inspect the `score`,
`commodity` and `measure` columns to see which facet is missing, then extend the
matching lexicon.

## Browser setup

Auto-detected paths:

```text
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
/usr/bin/chromium
/usr/bin/chromium-browser
```

Otherwise install Puppeteer's browser or point at a system one:

```bash
npx puppeteer browsers install chrome
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm start
```

## Keywords

Edit `keywords.txt`. Lines starting with `#` are comments. Long lines are fine —
they get decomposed automatically — but short lines cost fewer requests.

## Stage 2: extracting tables, figures and dataset links

`npm start` builds the discovery index. `npm run extract` then walks that index
and pulls content out of the article pages.

```bash
CROSSREF_MAILTO=you@example.com npm run extract
```

Outputs:

| File | Contents |
| --- | --- |
| `data/records.json` | canonical grouped extraction output: one article record with tables, figures, dataset links, errors, and a `statistics` slot |
| `data/records.csv` | flat evidence index for spreadsheets: article, table, figure, dataset link, and future statistic rows share one schema |
| `data/tables/<doi-slug>-t<N>.csv` | one CSV per extracted table |
| `data/dataset-files/*` | public files downloaded from DOI/repository links when discoverable |
| `data/figure-images/<doi-slug>-fig<N>-<name>.jpg` | figure rasters, when the article has a PMC copy |
| `data/tables.csv` | compatibility table index: doi, caption, rows, columns, source file |
| `data/figures.csv` | compatibility export of figure captions, local image file, and image URL |
| `data/datasets.csv` | dataset DOI/repository links plus resolved URL, download status, and local files |

Use `data/records.json` as the primary handoff between stages. It keeps the
article metadata, extraction provenance, table files, figure references, dataset
links, failed candidate URLs, and future statistics in one place instead of
forcing later scripts to join separate outputs.

### How a page is reached

The DOI itself is usually the *worst* target — for Elsevier it lands on a bot
wall. Each record is tried in this order, first copy with content wins:

1. **Europe PMC JATS XML**, resolved DOI → PMC id → `/{pmcid}/fullTextXML`. This
   is the best path by a wide margin: tables arrive as `<table-wrap>` with the
   label and caption attached, figures as `<fig>`, and there is no bot wall.
   Records reaching this way are marked `mode: "europepmc_xml"`.
2. **OpenAlex `best_oa_location`**, the open-access copy when one exists.
3. **The original URL**, via Puppeteer.

Static fetch is attempted first for 2 and 3, and Puppeteer only takes over when
the static HTML has no tables — Nature ships a script-rendered stub, MDPI does
not.

> **Why not scrape PMC's website?** It used to be the primary target, and the
> code still lists it as a candidate URL. But `pmc.ncbi.nlm.nih.gov` now
> intermittently answers headless clients with a `Checking your browser -
> reCAPTCHA` interstitial. That page parses fine and contains zero tables, so the
> failure is **silent** — an article that genuinely has five tables is recorded
> as having none. Europe PMC serves the same open-access text with no challenge,
> which is why the XML path runs first.

### How dataset files are found

The numbers behind a paper usually are not in the paper. Three routes are tried,
and the results are collapsed by dataset identity so one deposit is not
downloaded once per spelling:

1. **Crossref relations** — `relation.is-supplemented-by` on the article DOI.
   Publishers increasingly register the deposit here and never link it in the
   body text, and PMC copies drop such links entirely. For example
   `10.1016/j.dib.2024.110491` exposes `data.mendeley.com/datasets/63pxv64h75/4`
   this way and no other.
2. **Links in the article text** — any `<a href>` or JATS `<ext-link>` pointing
   at a known repository host.
3. **The record's own URL**, when the row is itself a dataset.

Each resulting link is resolved to actual files through a repository API where
one exists — Zenodo, Figshare, and Mendeley Data — falling back to scraping
download links out of the landing page. The API path matters: Mendeley Data
renders as a JavaScript app, so link-scraping its page finds nothing at all.

### Figure images

When an article has a PMC copy, every figure raster is pulled from Europe PMC's
`supplementaryFiles` zip and written to `data/figure-images/`. PMC's own
`/bin/gr1.jpg` URLs sit behind the same reCAPTCHA as its article pages, so they
are recorded in the `imageUrl` column for reference but are not fetched.

The zip is read by `src/zip.js`, a small central-directory reader built on
`node:zlib` rather than an archive dependency. Sizes are taken from the central
directory because streamed zips leave the local header's sizes zeroed.

Articles reached over the HTML path keep captions and remote image URLs only —
no image download is attempted for them.

### Yield is publisher-bound, not code-bound

Extraction only works on open full text. Paywalled journals return nothing no
matter how well they score, so `extract.js` orders its targets by likely yield
(data-journal and dataset records first) rather than by score alone. Expect data
papers to produce tables and economics papers to produce nothing.

`data/dataset-files/` is often the more valuable output: a Data in Brief article
typically deposits a Mendeley Data or figshare record holding the real numeric
files, which is a better source than any table scraped from the article body.

A representative run over 39 targets produced 29 pages loaded, 10 unreachable,
21 tables, 19 figure captions (6 with images), and 12 downloaded data files.
Only 2 of the 39 had a PMC copy — that is the ceiling on figure images, not a
bug.

### Options

```bash
EXTRACT_LIMIT=100 npm run extract        # articles to visit (default 40)
EXTRACT_MIN_SCORE=70 npm run extract     # only high-confidence rows (default 60)
MIN_TABLE_ROWS=3 npm run extract         # drop small layout tables (default 2)
MIN_TABLE_COLS=3 npm run extract         # default 2
PAGE_WAIT_MS=6000 npm run extract        # slower sites
DOWNLOAD_DATASET_FILES=0 npm run extract # keep URLs only
DATASET_FILE_LIMIT=5 npm run extract     # files per DOI/repository link (default 3)
DATASET_MAX_BYTES=50000000 npm run extract # max bytes per downloaded file
DOWNLOAD_FIGURE_IMAGES=0 npm run extract # captions only, skip the image bundles
FIGURE_BUNDLE_MAX_BYTES=100000000 npm run extract # per-article zip cap (default 50MB)
```

`DATASET_FILE_LIMIT` defaults to 3 and silently truncates larger deposits — a
four-file Mendeley record loses one file. Raise it when you care about
completeness:

```bash
DATASET_FILE_LIMIT=10 npm run extract
```

## Using the extracted data

### Start from `records.csv`

Every artifact — article, table, figure, dataset file — is one row sharing one
schema, so a spreadsheet filter is enough to answer most questions. The columns
that matter:

| Column | Meaning |
| --- | --- |
| `recordType` | `article` for the paper itself, `evidence` for anything pulled out of it |
| `evidenceType` | `article`, `table`, `figure`, `dataset_link`, `statistic` |
| `parentRecordId` | the article a piece of evidence came from; empty on article rows |
| `file` | local path to the CSV / image / downloaded data file |
| `status` | `loaded`/`failed` on articles, `extracted` on tables and figures, download state on dataset links |
| `caption` | table or figure caption, including its label (`Table 1`, `Fig. 2`) |
| `rows`, `columns` | table dimensions, useful for spotting layout tables |

Filter `evidenceType = table` and sort by `rows` descending to find substantial
tables; filter `evidenceType = dataset_link` and `status = downloaded` to find
articles whose raw numbers you actually have on disk.

For scripting, `records.json` is the same information grouped per article and
keeps the extraction provenance (`mode`, `finalUrl`, `candidateUrls`, `errors`):

```js
import fs from "node:fs/promises";

const records = JSON.parse(await fs.readFile("data/records.json", "utf8"));

// Articles whose deposited data files were downloaded
const withData = records.filter(article =>
  article.extraction.datasetLinks.some(link => link.files.length > 0),
);

for (const article of withData) {
  console.log(article.title);
  for (const link of article.extraction.datasetLinks) {
    for (const file of link.files) console.log("  ", file.file);
  }
}
```

### The three kinds of output, ranked

1. **`data/dataset-files/*` — the real thing.** Author-deposited numbers, usually
   `.xlsx` or `.csv`, at full precision and full length. Use these when they
   exist. They are not parsed for you; open them or read them with a spreadsheet
   library. Provenance for any file is its `dataset_link` row: `url` is the
   deposit, `resolvedUrl` where it resolved, `parentRecordId` the citing article.
2. **`data/tables/*.csv` — good but abridged.** Faithful to the article, but
   articles round and summarise. Row 1 is the header as printed; multi-level
   headers flatten into one row and merged cells repeat, so eyeball a table
   before trusting a machine parse of it. Units usually live in the caption, not
   the columns.
3. **`data/figure-images/*` — reference only.** A raster of a plot. The numbers
   behind the curve are not recoverable from it; if you need them, look for the
   same article's dataset files.

### Joining outputs back together

`recordId` on an article equals `parentRecordId` on all of its evidence, and both
are the DOI slug — `10.1016/j.dib.2024.110491` becomes
`10-1016-j-dib-2024-110491`. Filenames embed the same slug, so a stray file in
`data/tables/` can always be traced back to its article. Re-runs overwrite rather
than accumulate.

### Known gaps to check before trusting a number

- **Thin tables.** `MIN_TABLE_ROWS`/`MIN_TABLE_COLS` default to 2, so a 2x2
  layout box can survive as a "table". Sort by `rows` ascending and glance at the
  short ones.
- **The same deposit under two articles.** Dataset identity is deduplicated
  *within* an article, not across them. When your index contains both a paper and
  the dataset it deposited, the files download twice under two different slugs.
- **`no_public_file_found` is the common case.** In the representative run: 4
  links downloaded, 9 found no public file, 2 failed. Repositories that require a
  login or an agreement are simply not retrievable this way.
- **Missing is not absent.** `status = failed` and `mode: ""` mean nobody could
  reach an open copy — 10 of 39 in the sample run, mostly ScienceDirect and IEEE
  DOIs, which redirect to hosts on the block list. Those articles may well have
  tables; this tool just cannot see them.

## Notes

This project reads public metadata APIs, public full-text APIs, and public
search-result pages. Do not use it to bypass login, CAPTCHA, rate limits,
paywalls, or access restrictions. Hosts that challenge headless clients are
listed in `BLOCKED_HOSTS` and skipped rather than worked around; the reCAPTCHA
that pushed full-text retrieval to Europe PMC is routed *around* by using a
different public API, never solved.

Figures are captured as captions plus a raster image where one is openly
available. The numbers behind a plotted curve are not recoverable from a raster,
which is why the deposited files in `data/dataset-files/` matter more than the
figures do.
