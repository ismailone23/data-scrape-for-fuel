// Metadata APIs replace the previous ISSN-locked Crossref pair. Each source
// returns loosely-normalized candidates; scoring and dedupe happen upstream.

const DATA_JOURNAL_ISSNS = [
  "2352-3409", // Data in Brief
  "2052-4463", // Scientific Data
  "2306-5729", // Data (MDPI)
  "1866-3516", // Earth System Science Data
  "2169-3536", // IEEE Access
];

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }

    if (code.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }

    return HTML_ENTITIES[code.toLowerCase()] ?? match;
  });
}

// Titles from Crossref and OpenAlex carry markup, sometimes double-escaped
// ("&lt;i&gt;"), so entities are decoded before tags are stripped.
function stripHtml(value) {
  return normalizeWhitespace(decodeEntities(decodeEntities(value)).replace(/<[^>]*>/g, " "));
}

function doiUrl(doi) {
  return doi ? `https://doi.org/${String(doi).replace(/^https?:\/\/doi\.org\//, "")}` : "";
}

// OpenAlex ships abstracts as a token -> positions map rather than plain text.
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return "";

  const tokens = [];

  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) {
      tokens[position] = word;
    }
  }

  return normalizeWhitespace(tokens.join(" "));
}

function crossrefDate(item) {
  const parts =
    item.published?.["date-parts"]?.[0] ??
    item["published-print"]?.["date-parts"]?.[0] ??
    item["published-online"]?.["date-parts"]?.[0];

  return parts ? parts.filter(Boolean).join("-") : "";
}

export const apiSources = [
  {
    name: "OpenAlex",
    async search(keyword, { rows, mailto, fetchJson }) {
      const params = new URLSearchParams({
        search: keyword,
        per_page: String(Math.min(rows, 200)),
      });

      if (mailto) params.set("mailto", mailto);

      const searchUrl = `https://api.openalex.org/works?${params}`;
      const data = await fetchJson(searchUrl);

      return (data?.results ?? []).map(item => ({
        title: stripHtml(item.title || item.display_name),
        abstract: reconstructAbstract(item.abstract_inverted_index),
        journal: item.primary_location?.source?.display_name ?? "",
        doi: (item.doi ?? "").replace(/^https?:\/\/doi\.org\//, ""),
        published: item.publication_date || String(item.publication_year ?? ""),
        url: item.doi || item.primary_location?.landing_page_url || item.id || "",
        kind: item.type ?? "",
        searchUrl,
      }));
    },
  },
  {
    name: "Crossref Data Journals",
    async search(keyword, { rows, mailto, fetchJson }) {
      // Repeated same-field filters are OR-ed by Crossref, so every data journal
      // fits in one request. Fanning out per ISSN was 5x the load for the same
      // result set and was a large part of what got the run rate-limited.
      const params = new URLSearchParams({
        "query.bibliographic": keyword,
        filter: `${DATA_JOURNAL_ISSNS.map(issn => `issn:${issn}`).join(",")},type:journal-article`,
        select: "title,container-title,DOI,URL,abstract,published,score",
        rows: String(Math.min(rows, 100)),
      });

      if (mailto) params.set("mailto", mailto);

      const searchUrl = `https://api.crossref.org/works?${params}`;
      const data = await fetchJson(searchUrl);

      return (data?.message?.items ?? []).map(item => ({
        title: stripHtml(item.title?.[0]),
        abstract: stripHtml(item.abstract),
        journal: item["container-title"]?.[0] ?? "",
        doi: item.DOI ?? "",
        published: crossrefDate(item),
        url: item.URL || doiUrl(item.DOI),
        kind: "journal-article",
        searchUrl,
      }));
    },
  },
  {
    name: "Crossref",
    async search(keyword, { rows, mailto, fetchJson }) {
      const params = new URLSearchParams({
        "query.bibliographic": keyword,
        filter: "type:journal-article",
        select: "title,container-title,DOI,URL,abstract,published,score",
        rows: String(Math.min(rows, 100)),
      });

      if (mailto) params.set("mailto", mailto);

      const searchUrl = `https://api.crossref.org/works?${params}`;
      const data = await fetchJson(searchUrl);

      return (data?.message?.items ?? []).map(item => ({
        title: stripHtml(item.title?.[0]),
        abstract: stripHtml(item.abstract),
        journal: item["container-title"]?.[0] ?? "",
        doi: item.DOI ?? "",
        published: crossrefDate(item),
        url: item.URL || doiUrl(item.DOI),
        kind: "journal-article",
        searchUrl,
      }));
    },
  },
  {
    name: "DataCite",
    async search(keyword, { rows, fetchJson }) {
      const params = new URLSearchParams({
        query: keyword,
        "resource-type-id": "dataset",
        "page[size]": String(Math.min(rows, 100)),
      });

      const searchUrl = `https://api.datacite.org/dois?${params}`;
      const data = await fetchJson(searchUrl);

      return (data?.data ?? []).map(item => {
        const attributes = item.attributes ?? {};

        return {
          title: stripHtml(attributes.titles?.[0]?.title),
          abstract: stripHtml(
            attributes.descriptions?.find(d => d.descriptionType === "Abstract")?.description ??
              attributes.descriptions?.[0]?.description,
          ),
          journal: attributes.publisher?.name ?? attributes.publisher ?? "",
          doi: attributes.doi ?? "",
          published: String(attributes.publicationYear ?? ""),
          url: attributes.url || doiUrl(attributes.doi),
          kind: "dataset",
          searchUrl,
        };
      });
    },
  },
  {
    name: "Zenodo",
    async search(keyword, { rows, fetchJson }) {
      const params = new URLSearchParams({
        q: keyword,
        size: String(Math.min(rows, 100)),
      });

      const searchUrl = `https://zenodo.org/api/records?${params}`;
      const data = await fetchJson(searchUrl);

      return (data?.hits?.hits ?? []).map(item => {
        const metadata = item.metadata ?? {};

        return {
          title: stripHtml(metadata.title),
          abstract: stripHtml(metadata.description),
          journal: metadata.journal?.title ?? metadata.publisher ?? "Zenodo",
          doi: item.doi ?? metadata.doi ?? "",
          published: metadata.publication_date ?? "",
          url: doiUrl(item.doi ?? metadata.doi) || item.links?.self_html || "",
          kind: metadata.resource_type?.type ?? "",
          searchUrl,
        };
      });
    },
  },
];

// ScienceDirect and IEEE Xplore were removed: both return bot-challenge pages,
// so they only added latency. These two still respond.
export const browserSources = [
  {
    name: "Scientific Data",
    buildSearchUrl: query =>
      `https://www.nature.com/search?q=${encodeURIComponent(query)}&journal=sdata&order=relevance`,
    preferredLinkPatterns: ["/articles/"],
    selectors: ["article h3 a", "a[data-track-action='view article']", "a[href*='/articles/']"],
  },
  {
    name: "IEEE DataPort",
    buildSearchUrl: query => `https://ieee-dataport.org/search?query=${encodeURIComponent(query)}`,
    preferredLinkPatterns: ["/documents/", "/open-access/", "/competitions/"],
    selectors: [
      "a[href*='/documents/']",
      "a[href*='/open-access/']",
      "a[href*='/competitions/']",
      ".search-result a",
    ],
  },
];
