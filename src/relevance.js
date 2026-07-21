// Facet lexicons. A candidate is scored on three independent facets plus a
// penalty list, instead of the previous all-or-nothing keyword gate.

export const GEOGRAPHY_TERMS = [
  "bangladesh",
  "bangladeshi",
  "dhaka",
  "chattogram",
  "chittagong",
  "mongla",
  "payra",
  "maheshkhali",
  "khulna",
  "sylhet",
  "narayanganj",
  "bay of bengal",
  "south asia",
  "south asian",
];

// Deliberately excludes bare "oil" and "fuel" as standalone entries: they matched
// olive oil, palm oil, spent nuclear fuel and engine-test papers. Those two words
// are still reachable through the compound forms below.
export const COMMODITY_TERMS = [
  "petroleum",
  "petroleum product",
  "petroleum products",
  "crude oil",
  "refined oil",
  "fuel oil",
  "furnace oil",
  "hsfo",
  "diesel",
  "hsd",
  "high speed diesel",
  "ldo",
  "light diesel oil",
  "petrol",
  "gasoline",
  "motor spirit",
  "octane",
  "hobc",
  "kerosene",
  "sko",
  "jet a-1",
  "jet fuel",
  "aviation fuel",
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
  "fossil fuel",
  "fuel demand",
  "fuel supply",
  "fuel price",
  "fuel consumption",
  "fuel import",
  "fuel distribution",
  "fuel logistics",
  "energy demand",
  "energy supply",
  // Depot/terminal infrastructure is the physical side of the same commodity,
  // and these phrases are what the depot/storage keyword lines are made of.
  "fuel depot",
  "oil depot",
  "petroleum depot",
  "fuel terminal",
  "oil terminal",
  "petroleum terminal",
  "fuel storage",
  "oil storage",
  "petroleum storage",
  "gas storage",
  "fuel tank",
  "storage tank",
  "tank farm",
  "fuel station",
  "filling station",
  "petrol pump",
  "fertilizer",
  "fertiliser",
  "urea",
  "dap fertilizer",
  "tsp fertilizer",
  "mop fertilizer",
  "muriate of potash",
  "triple super phosphate",
  "diammonium phosphate",
];

// The variables the project actually wants: demand, cost, quantity, capacity,
// distance, lead time.
export const MEASURE_TERMS = [
  "import",
  "imports",
  "export",
  "demand",
  "consumption",
  "supply",
  "sales",
  "requirement",
  "forecast",
  "forecasting",
  "projection",
  "capacity",
  "storage",
  "storage capacity",
  "depot",
  "terminal",
  "tank farm",
  "tank capacity",
  "warehouse",
  "refinery",
  "pipeline",
  "inventory",
  "stock",
  "throughput",
  "cost",
  "price",
  "pricing",
  "tariff",
  "freight",
  "subsidy",
  "landed cost",
  "unit value",
  "expenditure",
  "quantity",
  "volume",
  "tonnage",
  "distance",
  "route",
  "routing",
  "road network",
  "shipping",
  "lead time",
  "transit time",
  "delivery time",
  "dwell time",
  "turnaround time",
  "clearance time",
  "logistics",
  "supply chain",
  "distribution",
  "transport",
  "transportation",
  "facility location",
  "allocation",
  "optimization",
];

// Terms that indicate the record is a lab/bench/biology paper that merely shares
// vocabulary with the target domain. These produced the bulk of the old noise.
// Matched on whole words: substring matching made "rat" fire inside "strategy".
export const PENALTY_TERMS = [
  "olive oil",
  "palm oil",
  "palm fruit",
  "neem",
  "castor",
  "flaxseed",
  "sunflower",
  "essential oil",
  "seed oil",
  "fish oil",
  "lemon peel",
  "papaya",
  "coconut oil",
  "vegetable oil",
  "cooking oil",
  "gene expression",
  "nanoparticle",
  "nanoparticles",
  "nanofluid",
  "biodiesel blend",
  "biodiesel fuel",
  "methyl ester",
  "combustion chamber",
  "engine emission",
  "exhaust emission",
  "cetane",
  "injector",
  "spent fuel",
  "nuclear",
  "reactor",
  "radioactive",
  "molten salt",
  "bioremediation",
  "contaminated soil",
  "wastewater",
  "microorganism",
  "bacteria",
  "leaf image",
  "leaf disease",
  "patient",
  "patients",
  "clinical",
  "in vitro",
  "in vivo",
  "rats",
  "mice",
  "cell line",
  "concrete",
  "fuel cell",
  "solar cell",
  "photovoltaic",
];

// Word-initial stems, so "transcriptom" covers both "transcriptome" and
// "transcriptomic" without matching mid-word.
export const PENALTY_STEMS = [
  "transcriptom",
  "proteom",
  "genom",
  "rheolog",
  "chromatograph",
  "spectroscop",
];

export const DATASET_HINT_TERMS = [
  "dataset",
  "data set",
  "data on",
  "data for",
  "database",
  "survey data",
  "panel data",
  "time series",
];

const WEIGHTS = {
  titleGeography: 30,
  abstractGeography: 12,
  titleCommodity: 26,
  abstractCommodity: 10,
  titleMeasure: 20,
  abstractMeasure: 8,
  datasetHint: 10,
  titlePenalty: -45,
  abstractPenalty: -15,
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match so "lng" does not fire inside "long" and "dap" not inside
// "adapt". Multi-word terms match across a single run of whitespace.
function termPattern(term) {
  const body = escapeRegex(term).replace(/\\?\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i");
}

const patternCache = new Map();

function getPattern(term) {
  let pattern = patternCache.get(term);

  if (!pattern) {
    pattern = termPattern(term);
    patternCache.set(term, pattern);
  }

  return pattern;
}

export function matchedTerms(text, terms) {
  if (!text) return [];

  return terms.filter(term => getPattern(term).test(text));
}

export function includesAnyTerm(text, terms) {
  return matchedTerms(text, terms).length > 0;
}

function stemPattern(stem) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(stem)}[a-z]*`, "i");
}

function matchedPenalties(text) {
  if (!text) return [];

  return [
    ...matchedTerms(text, PENALTY_TERMS),
    ...PENALTY_STEMS.filter(stem => stemPattern(stem).test(text)),
  ];
}

/**
 * Score a candidate 0-100 across geography / commodity / measure facets.
 * Returns the score plus the facet hits, so a low-scoring row can be explained
 * without re-running the match.
 */
export function scoreCandidate({ title = "", abstract = "" }) {
  const titleGeography = matchedTerms(title, GEOGRAPHY_TERMS);
  const titleCommodity = matchedTerms(title, COMMODITY_TERMS);
  const titleMeasure = matchedTerms(title, MEASURE_TERMS);
  const titlePenalty = matchedPenalties(title);

  const abstractGeography = matchedTerms(abstract, GEOGRAPHY_TERMS);
  const abstractCommodity = matchedTerms(abstract, COMMODITY_TERMS);
  const abstractMeasure = matchedTerms(abstract, MEASURE_TERMS);
  const abstractPenalty = matchedPenalties(abstract);

  const hasDatasetHint = includesAnyTerm(title, DATASET_HINT_TERMS);

  let score = 0;

  if (titleGeography.length > 0) score += WEIGHTS.titleGeography;
  else if (abstractGeography.length > 0) score += WEIGHTS.abstractGeography;

  if (titleCommodity.length > 0) score += WEIGHTS.titleCommodity;
  else if (abstractCommodity.length > 0) score += WEIGHTS.abstractCommodity;

  if (titleMeasure.length > 0) score += WEIGHTS.titleMeasure;
  else if (abstractMeasure.length > 0) score += WEIGHTS.abstractMeasure;

  if (hasDatasetHint) score += WEIGHTS.datasetHint;

  if (titlePenalty.length > 0) score += WEIGHTS.titlePenalty;
  else if (abstractPenalty.length > 0) score += WEIGHTS.abstractPenalty;

  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score: clamped,
    geography: [...new Set([...titleGeography, ...abstractGeography])],
    commodity: [...new Set([...titleCommodity, ...abstractCommodity])],
    measure: [...new Set([...titleMeasure, ...abstractMeasure])],
    penalties: [...new Set([...titlePenalty, ...abstractPenalty])],
    hasDatasetHint,
    // Crop-economics papers list fertilizer as an input in the abstract, so
    // whether the commodity appears in the title is the discriminating signal.
    commodityInTitle: titleCommodity.length > 0,
  };
}
