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
score descending.

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
| `data/tables/<doi-slug>-t<N>.csv` | one CSV per extracted HTML table |
| `data/tables.csv` | table index — doi, caption, rows, columns, source file |
| `data/figures.csv` | figure captions and image URLs |
| `data/datasets.csv` | links to Mendeley Data, figshare, Zenodo, Dryad, OSF, … |

### How a page is reached

The DOI itself is usually the *worst* target — for Elsevier it lands on a bot
wall. Each record is tried in this order, first copy with tables wins:

1. **PubMed Central**, resolved DOI → PMC id via Europe PMC. PMC serves complete
   static HTML with real `<table>` markup and does not challenge headless
   clients, so this path needs no browser at all.
2. **OpenAlex `best_oa_location`**, the open-access copy when one exists.
3. **The original URL**, via Puppeteer.

Static fetch is attempted first at every step and Puppeteer only takes over when
the static HTML has no tables — Nature ships a script-rendered stub, MDPI and PMC
do not.

### Yield is publisher-bound, not code-bound

Extraction only works on open full text. Paywalled journals return nothing no
matter how well they score, so `extract.js` orders its targets by likely yield
(data-journal and dataset records first) rather than by score alone. Expect data
papers to produce tables and economics papers to produce nothing.

`data/datasets.csv` is often the more valuable output: a Data in Brief article
typically links a Mendeley Data or figshare deposit holding the real numeric
files, which is a better source than any table scraped from the article body.

### Options

```bash
EXTRACT_LIMIT=100 npm run extract        # articles to visit (default 40)
EXTRACT_MIN_SCORE=70 npm run extract     # only high-confidence rows (default 60)
MIN_TABLE_ROWS=3 npm run extract         # drop small layout tables (default 2)
MIN_TABLE_COLS=3 npm run extract         # default 2
PAGE_WAIT_MS=6000 npm run extract        # slower sites
```

## Notes

This project reads public metadata APIs and public search-result pages. Do not use
it to bypass login, CAPTCHA, rate limits, paywalls, or access restrictions.
Figures are captured as captions plus image URLs — the numbers behind a plotted
graph are not recoverable from a raster image, which is why `data/datasets.csv`
matters.
