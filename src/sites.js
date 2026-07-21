export const sites = [
  {
    name: "Crossref Data in Brief",
    type: "crossref",
    journal: "Data in Brief",
    issn: "2352-3409",
  },
  {
    name: "Data in Brief",
    baseUrl: "https://www.sciencedirect.com",
    buildSearchUrl: query =>
      `https://www.sciencedirect.com/search?qs=${encodeURIComponent(query)}&pub=Data%20in%20Brief`,
    preferredLinkPatterns: ["/science/article/pii/"],
    selectors: [
      "a.result-list-title-link",
      "a.anchor.result-list-title-link",
      "a[href*='/science/article/pii/']",
    ],
  },
  {
    name: "Crossref Scientific Data",
    type: "crossref",
    journal: "Scientific Data",
    issn: "2052-4463",
  },
  {
    name: "Scientific Data",
    baseUrl: "https://www.nature.com",
    buildSearchUrl: query =>
      `https://www.nature.com/search?q=${encodeURIComponent(query)}&journal=sdata&order=relevance`,
    preferredLinkPatterns: ["/articles/"],
    selectors: [
      "article h3 a",
      "a[data-track-action='view article']",
      "a[href*='/articles/']",
    ],
  },
  {
    name: "Crossref IEEE Access",
    type: "crossref",
    journal: "IEEE Access",
    issn: "2169-3536",
  },
  {
    name: "IEEE Xplore",
    baseUrl: "https://ieeexplore.ieee.org",
    buildSearchUrl: query =>
      `https://ieeexplore.ieee.org/search/searchresult.jsp?newsearch=true&queryText=${encodeURIComponent(query)}`,
    preferredLinkPatterns: ["/document/"],
    selectors: [
      "a[href*='/document/']",
      ".List-results-items a[href*='/document/']",
      ".result-item-align a[href*='/document/']",
    ],
  },
  {
    name: "IEEE DataPort",
    baseUrl: "https://ieee-dataport.org",
    buildSearchUrl: query =>
      `https://ieee-dataport.org/search?query=${encodeURIComponent(query)}`,
    preferredLinkPatterns: ["/documents/", "/open-access/", "/competitions/"],
    selectors: [
      "a[href*='/documents/']",
      "a[href*='/open-access/']",
      "a[href*='/competitions/']",
      ".search-result a",
    ],
  },
];
