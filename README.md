# datasets-generator

Keyword-based Puppeteer scraper for discovering logistics, supply-chain, depot, warehouse, fuel/oil/LNG, fertilizer import, demand, cost, quantity/volume, storage capacity, distance, and lead-time dataset articles.

## Sources

- Data in Brief / ScienceDirect
- Scientific Data / Nature
- IEEE Xplore
- IEEE DataPort
- Crossref metadata fallback for Data in Brief, Scientific Data, and IEEE Access

## Install

```bash
npm install
```

## Run

```bash
npm start
```

The scraper auto-detects these system browser paths if Chrome/Chromium is installed:

```text
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
/usr/bin/chromium
/usr/bin/chromium-browser
```

If Puppeteer cannot find Chrome, install Puppeteer's browser or point it to a system browser manually:

```bash
npx puppeteer browsers install chrome
```

Or:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm start
```

For Google Chrome installed from the `.deb` package, this is usually:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome npm start
```

Results are saved to:

```text
data/articles.json
data/articles.csv
```

## Keywords

Edit `keywords.txt` to add or remove searches.

The keyword list is focused on these variables:

```text
demand
cost
quantity/volume
depot storage capacity
distance
lead time
fuel/oil/LNG logistics
fertilizer import data
```

Current examples:

```text
supply chain dataset
logistics dataset
demand cost depot lead time
storage capacity depot demand
fuel demand depot storage capacity
oil import demand quantity cost
LNG supply chain demand cost distance
fertilizer import demand quantity cost
fertilizer supply chain demand lead time
```

## Options

Use environment variables to control scraping:

```bash
MAX_RESULTS_PER_SEARCH=10 npm start
WAIT_BETWEEN_SEARCHES_MS=5000 npm start
NAVIGATION_TIMEOUT_MS=90000 npm start
FETCH_TIMEOUT_MS=30000 npm start
CROSSREF_MAILTO=your_email@example.com npm start
STRICT_CROSSREF_RELEVANCE=0 npm start
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm start
KEYWORD_LIMIT=3 npm start
SITE_FILTER="Scientific Data" npm start
QUERY="supply chain dataset" npm start
```

For a quick test run:

```bash
KEYWORD_LIMIT=1 MAX_RESULTS_PER_SEARCH=3 SITE_FILTER="Scientific Data" npm start
```

For a one-off query test:

```bash
QUERY="supply chain dataset" MAX_RESULTS_PER_SEARCH=5 SITE_FILTER="Scientific Data" npm start
```

## Notes

This project only discovers public search-result metadata and article links. Do not use it to bypass login, CAPTCHA, rate limits, paywalls, or access restrictions. For larger or more reliable collection, use the IEEE, Elsevier, Crossref, OpenAlex, or Semantic Scholar APIs.
