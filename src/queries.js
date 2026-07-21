import {
  COMMODITY_TERMS,
  GEOGRAPHY_TERMS,
  MEASURE_TERMS,
  matchedTerms,
} from "./relevance.js";

// Every extra word in a query widens a fuzzy OR-match instead of narrowing it,
// so an 8-word line like "Bangladesh petroleum annual report imports sales
// capacity" is decomposed into short geography x commodity x measure probes.

// Country- and region-level terms; anything else in GEOGRAPHY_TERMS is a city or
// port and therefore a sharper probe.
const BROAD_GEOGRAPHY_TERMS = [
  "bangladesh",
  "bangladeshi",
  "south asia",
  "south asian",
  "bay of bengal",
];

function longestFirst(terms) {
  return [...terms].sort((a, b) => b.length - a.length);
}

// Keeps "crude oil" and drops the "oil"-only variants it subsumes.
function dropSubsumedTerms(terms) {
  const ordered = longestFirst(terms);

  return ordered.filter(
    (term, index) => !ordered.slice(0, index).some(longer => longer.includes(term)),
  );
}

export function buildQueryVariants(keyword, maxVariants) {
  const geography = dropSubsumedTerms(matchedTerms(keyword, GEOGRAPHY_TERMS));
  const commodity = dropSubsumedTerms(matchedTerms(keyword, COMMODITY_TERMS));
  const measure = dropSubsumedTerms(matchedTerms(keyword, MEASURE_TERMS));

  if (commodity.length === 0 && measure.length === 0) {
    return [keyword];
  }

  // "Mongla fuel depot ... Bangladesh" must probe on Mongla: the country name is
  // the least informative term in a line that already names a port.
  const specificGeography = geography.filter(term => !BROAD_GEOGRAPHY_TERMS.includes(term));
  const rankedGeography = [...specificGeography, ...geography];
  const geographyParts = rankedGeography.length > 0 ? rankedGeography.slice(0, 1) : [""];
  const commodityParts = commodity.length > 0 ? commodity.slice(0, 2) : [""];
  const measureParts = measure.length > 0 ? measure.slice(0, 3) : [""];

  const variants = new Set();

  for (const geographyPart of geographyParts) {
    for (const commodityPart of commodityParts) {
      for (const measurePart of measureParts) {
        // Facets overlap ("fuel logistics" is a commodity term and "logistics"
        // a measure term), so drop words the variant already contains.
        const words = [];

        for (const word of [geographyPart, commodityPart, measurePart].filter(Boolean).join(" ").split(" ")) {
          if (word && !words.includes(word)) words.push(word);
        }

        const variant = words.join(" ").trim();

        if (variant && variant !== keyword.toLowerCase()) {
          variants.add(variant);
        }
      }
    }
  }

  // The original line stays first: it is the user's intent, and some sources
  // rank long phrase matches well even when the short probes miss.
  return [keyword, ...[...variants].slice(0, Math.max(0, maxVariants - 1))];
}
