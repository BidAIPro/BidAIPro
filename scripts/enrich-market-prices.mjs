import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const SERPAPI_URL = "https://serpapi.com/search.json";
const SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search";
const PRICECHARTING_URL = "https://www.pricecharting.com/api/product";
const MAX_OFFERS = 60;
const MAX_HISTORY = 365;
const CLOSE_MATCH_SCORE = 65;
const ANALOG_MATCH_SCORE = 35;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "auction", "authentic", "authenticated", "beautiful", "goodwill", "item", "lot", "nice", "preowned", "shopgoodwill", "used",
]);

const LISTING_NOISE_WORDS = new Set([
  "assorted", "bundle", "case", "cable", "charger", "collection", "complete", "estate", "foam", "hard", "includes",
  "misc", "mixed", "mount", "mounts", "nwt", "open", "parts", "set", "tested", "untested", "usb", "working",
]);

const GENERIC_PRODUCT_WORDS = new Set([
  "925", "sterling", "silver", "gold", "platinum", "palladium", "metal", "jewelry", "ring", "necklace", "bracelet",
  "earring", "earrings", "pendant", "chain", "watch", "watches", "vintage", "women", "womens", "men", "mens", "ladies",
]);

const SPECIALTY_PATTERN = /video game|gaming|console|playstation|xbox|nintendo|gameboy|game boy|pokemon|trading card|sports card|comic|funko|lego|coin|currency/i;

function cleanText(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function pennies(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) / 100 : null;
}

function httpUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function tokens(value) {
  return [...new Set(cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOP_WORDS.has(token)))];
}

function queryFor(item) {
  const titleTokens = tokens(item?.title);
  const modelTokens = tokens(item?.modelKey);
  const conciseTokens = titleTokens.filter((token) => !LISTING_NOISE_WORDS.has(token));
  const parts = modelTokens.length >= 3 ? modelTokens.slice(0, 9) : conciseTokens.slice(0, 9);
  return parts.join(" ").slice(0, 120);
}

function categoryQueryFor(item) {
  const segments = cleanText(item?.category).split(">").map((value) => value.trim()).filter(Boolean);
  const categoryText = segments.slice(-2).join(" ") || cleanText(item?.resaleVertical, "general merchandise");
  return tokens(categoryText).slice(0, 8).join(" ").slice(0, 120);
}

function hasDistinctIdentity(item) {
  const titleTokens = tokens(item?.title);
  const distinctive = titleTokens.filter((token) => !GENERIC_PRODUCT_WORDS.has(token) && !LISTING_NOISE_WORDS.has(token));
  const modelLike = titleTokens.some((token) => /[a-z]/.test(token) && /\d/.test(token));
  return modelLike || distinctive.length >= 2;
}

function matchScore(targetTitle, candidateTitle) {
  const target = tokens(targetTitle);
  const candidate = tokens(candidateTitle);
  if (target.length < 3 || candidate.length < 3) return 0;
  const candidateSet = new Set(candidate);
  const shared = target.filter((token) => candidateSet.has(token)).length;
  if (shared < 3) return 0;
  const coverage = shared / target.length;
  const union = new Set([...target, ...candidate]).size;
  const jaccard = union ? shared / union : 0;
  if (coverage < 0.65) return 0;
  return Math.round(Math.min(1, coverage * 0.8 + jaccard * 0.2) * 10_000) / 100;
}

function quantile(values, probability) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) * 100) / 100;
}

function average(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function statsFor(offers) {
  const initialTotals = offers.map((offer) => offer.totalPrice).filter((value) => Number.isFinite(value) && value > 0);
  const initialMedian = quantile(initialTotals, 0.5);
  const robustOffers = initialMedian
    ? offers.filter((offer) => offer.totalPrice >= initialMedian * 0.25 && offer.totalPrice <= initialMedian * 4)
    : offers;
  const retained = robustOffers.length >= 5 ? robustOffers : offers;
  const totals = retained.map((offer) => offer.totalPrice);
  return {
    sampleSize: retained.length,
    sourceCount: new Set(retained.map((offer) => offer.source.toLowerCase())).size,
    priceLow: quantile(totals, 0.2),
    priceMedian: quantile(totals, 0.5),
    priceAverage: average(totals),
    priceHigh: quantile(totals, 0.8),
    offers: retained,
  };
}

async function readEnvelope() {
  const source = await readFile(outputPath, "utf8");
  if (!source.startsWith(OUTPUT_PREFIX)) throw new Error("Snapshot file has an unsupported format.");
  const envelope = JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
  if (!envelope || !Array.isArray(envelope.items)) throw new Error("Snapshot file does not contain an item array.");
  return { source, envelope };
}

async function writeEnvelope(envelope) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`, "utf8");
    await rename(temporary, outputPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isFresh(value, maximumAgeHours) {
  const asOf = Date.parse(value?.asOf || "");
  return Number.isFinite(asOf) && Date.now() - asOf < maximumAgeHours * 60 * 60_000;
}

function targetPriority(item) {
  const end = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(end) ? Math.max(0, (end - Date.now()) / 3_600_000) : 9_999;
  const authenticated = item?.authenticationStatus === "source-stated" ? 1_000 : 0;
  const knownVertical = item?.resaleVertical && item.resaleVertical !== "Other" ? 500 : 0;
  return authenticated + knownVertical + Math.min(500, Number(item?.bidCount) || 0) + Math.max(0, 250 - hours);
}

function selectTargets(items, field, limit, specialtyOnly = false) {
  return items
    .filter((item) => item?.status === "active" && cleanText(item?.title) && !isFresh(item?.[field], field === "specialtyMarket" ? 47 : 23))
    .filter((item) => hasDistinctIdentity(item) && queryFor(item).split(" ").length >= 3)
    .filter((item) => !specialtyOnly || SPECIALTY_PATTERN.test(`${item?.title || ""} ${item?.category || ""} ${item?.resaleVertical || ""}`))
    .sort((left, right) => targetPriority(right) - targetPriority(left))
    .slice(0, limit);
}

function selectTargetGroups(items, field, limit) {
  const candidates = items
    .filter((item) => item?.status === "active" && cleanText(item?.title) && !isFresh(item?.[field], 23))
    .filter((item) => Boolean(queryFor(item)))
    .sort((left, right) => targetPriority(right) - targetPriority(left));
  const groups = new Map();
  for (const item of candidates) {
    const query = queryFor(item).toLowerCase();
    if (!groups.has(query)) groups.set(query, { representative: item, members: [] });
    groups.get(query).members.push(item);
  }
  return [...groups.values()].slice(0, limit);
}

function deliveryAmount(value) {
  const text = cleanText(value);
  if (!text || /free/i.test(text)) return 0;
  const parsed = money(text);
  return parsed ?? 0;
}

function normalizeShoppingOffer(result, target, matchTitle = target?.title, categoryFallback = false) {
  const title = cleanText(result?.title).slice(0, 500);
  let score = matchScore(matchTitle, title);
  if (categoryFallback && score < ANALOG_MATCH_SCORE) {
    const categoryTokens = tokens(matchTitle);
    const candidateTokens = new Set(tokens(title));
    const shared = categoryTokens.filter((token) => candidateTokens.has(token)).length;
    if (shared >= 1) score = Math.min(49, ANALOG_MATCH_SCORE + shared * 4);
  }
  const price = money(result?.extracted_price ?? result?.price);
  const url = httpUrl(result?.link || result?.product_link || result?.offers_link);
  const source = cleanText(result?.source || result?.seller, "Google Shopping merchant").slice(0, 200);
  if (score < ANALOG_MATCH_SCORE || !price || !url || !title || !source) return null;
  const statedCondition = cleanText(result?.second_hand_condition || result?.durability || result?.condition);
  const condition = /refurb/i.test(statedCondition || title)
    ? "refurbished"
    : /used|pre-owned|preowned|second hand/i.test(statedCondition || title) ? "used" : "new/unspecified";
  const shipping = deliveryAmount(result?.delivery);
  const reviews = Math.max(0, Math.round(Number(result?.reviews) || 0));
  const rating = Number(result?.rating);
  return {
    id: cleanText(result?.product_id || `${source}:${title}:${price}`).slice(0, 300),
    title,
    price,
    shipping,
    totalPrice: Math.round((price + shipping) * 100) / 100,
    url,
    condition,
    source,
    matchScore: score,
    matchTier: score >= CLOSE_MATCH_SCORE ? "close" : categoryFallback ? "category-analog" : "market-analog",
    ...(Number.isFinite(rating) && rating > 0 ? { rating: Math.round(rating * 10) / 10 } : {}),
    ...(reviews > 0 ? { reviews } : {}),
  };
}

async function searchShopping(target, apiKey, provider = "serpapi") {
  const query = queryFor(target);
  const usingSearchApi = provider === "searchapi";
  const unique = new Map();
  const queriesTried = [];
  const collect = async (searchQuery, categoryFallback = false) => {
    const url = new URL(usingSearchApi ? SEARCHAPI_URL : SERPAPI_URL);
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    const fetchOptions = {};
    if (usingSearchApi) fetchOptions.headers = { authorization: `Bearer ${apiKey}` };
    else url.searchParams.set("api_key", apiKey);
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const error = new Error(`${usingSearchApi ? "SearchAPI" : "SerpApi"} shopping search failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    queriesTried.push(searchQuery);
    const payload = await response.json();
    const shoppingResults = [
      ...(Array.isArray(payload?.shopping_results) ? payload.shopping_results : []),
      ...(Array.isArray(payload?.shopping_ads) ? payload.shopping_ads : []),
    ];
    for (const result of shoppingResults) {
      const offer = normalizeShoppingOffer(result, target, categoryFallback ? searchQuery : target.title, categoryFallback);
      if (!offer) continue;
      const key = `${offer.source.toLowerCase()}|${offer.id}|${offer.totalPrice}`;
      if (!unique.has(key)) unique.set(key, offer);
    }
  };
  await collect(query);
  const initialSources = new Set([...unique.values()].map((offer) => offer.source.toLowerCase())).size;
  const categoryQuery = categoryQueryFor(target);
  if ((unique.size < 5 || initialSources < 2) && categoryQuery && categoryQuery.toLowerCase() !== query.toLowerCase()) {
    await collect(categoryQuery, true);
  }
  const offers = [...unique.values()].slice(0, MAX_OFFERS);
  const closeOffers = offers.filter((offer) => offer.matchScore >= CLOSE_MATCH_SCORE);
  const usedOffers = closeOffers.filter((offer) => ["used", "refurbished"].includes(offer.condition));
  const newOffers = closeOffers.filter((offer) => offer.condition === "new/unspecified");
  const used = statsFor(usedOffers);
  const newRetail = statsFor(newOffers);
  const { offers: _usedRetainedOffers, ...usedSummary } = used;
  const { offers: _newRetainedOffers, ...newRetailSummary } = newRetail;
  const usableUsed = used.sampleSize >= 5 && used.sourceCount >= 2;
  const usableNew = newRetail.sampleSize >= 5 && newRetail.sourceCount >= 2;
  const targetIsNew = /\b(?:new|nib|sealed|unused|new with tags|nwt)\b/i.test(`${target?.title || ""} ${target?.condition || ""}`);
  const analogUsedOffers = offers.filter((offer) => ["used", "refurbished"].includes(offer.condition));
  const analogNewOffers = offers.filter((offer) => offer.condition === "new/unspecified");
  const preferredAnalogOffers = targetIsNew && analogNewOffers.length >= 5
    ? analogNewOffers
    : analogUsedOffers.length >= 5 ? analogUsedOffers
      : analogNewOffers.length >= 5 ? analogNewOffers : offers;
  const analogStats = statsFor(preferredAnalogOffers);
  const usableAnalog = !usableUsed && !usableNew && analogStats.sampleSize >= 5 && analogStats.sourceCount >= 2;
  const asOf = new Date().toISOString();
  const reviewCounts = offers.map((offer) => offer.reviews).filter((value) => Number.isFinite(value) && value > 0);
  const ratings = offers.map((offer) => offer.rating).filter((value) => Number.isFinite(value) && value > 0);
  const channel = `Google Shopping via ${usingSearchApi ? "SearchAPI" : "SerpApi"}`;
  const retailMarket = {
    status: usableUsed || usableNew || usableAnalog ? "available" : "insufficient",
    channel,
    provider: usingSearchApi ? "searchapi" : "serpapi",
    currency: "USD",
    asOf,
    query,
    queriesTried,
    sampleSize: offers.length,
    sourceCount: new Set(offers.map((offer) => offer.source.toLowerCase())).size,
    used: usableUsed ? usedSummary : { sampleSize: used.sampleSize, sourceCount: used.sourceCount },
    newRetail: usableNew ? newRetailSummary : { sampleSize: newRetail.sampleSize, sourceCount: newRetail.sourceCount },
    analog: usableAnalog ? {
      sampleSize: analogStats.sampleSize,
      sourceCount: analogStats.sourceCount,
      priceLow: analogStats.priceLow,
      priceMedian: analogStats.priceMedian,
      priceAverage: analogStats.priceAverage,
      priceHigh: analogStats.priceHigh,
      conditionBasis: preferredAnalogOffers === analogNewOffers ? "new/unspecified" : preferredAnalogOffers === analogUsedOffers ? "used/refurbished" : "mixed/unspecified",
      minimumMatchScore: ANALOG_MATCH_SCORE,
      averageMatchScore: Math.round(average(analogStats.offers.map((offer) => offer.matchScore)) * 10) / 10,
      categoryAnalogCount: analogStats.offers.filter((offer) => offer.matchTier === "category-analog").length,
      planningReservePercent: 55,
      note: "Real Google Shopping offers with a broader title or category match; reference-only and never an exact sold comparable.",
    } : { sampleSize: analogStats.sampleSize, sourceCount: analogStats.sourceCount },
    productInterest: {
      reviewCountMax: reviewCounts.length ? Math.max(...reviewCounts) : 0,
      reviewCountMedian: quantile(reviewCounts, 0.5) || 0,
      ratingAverage: ratings.length ? average(ratings) : null,
      note: "Reviews indicate product interest, not resale sell-through.",
    },
    offers: usableUsed || usableNew || usableAnalog ? offers : [],
    ...(!(usableUsed || usableNew || usableAnalog) ? { reason: "Fewer than five matched or analogous offers from at least two merchants" } : {}),
  };
  return {
    retailMarket,
    queryCount: queriesTried.length,
    historyEntry: usableUsed || usableNew || usableAnalog ? {
      asOf,
      channel: retailMarket.channel,
      used: retailMarket.used,
      newRetail: retailMarket.newRetail,
      analog: retailMarket.analog,
      sourceCount: retailMarket.sourceCount,
    } : null,
  };
}

function specialtyCondition(item) {
  return /complete(?:\s+in)?\s+box|\bcib\b|with box/i.test(item?.title || "") ? "cib" : "loose";
}

function specialtySourceUrl(query) {
  const url = new URL("https://www.pricecharting.com/search-products");
  url.searchParams.set("type", "prices");
  url.searchParams.set("q", query);
  return url.toString();
}

async function searchPriceCharting(target, token) {
  const query = queryFor(target);
  const url = new URL(PRICECHARTING_URL);
  url.searchParams.set("t", token);
  url.searchParams.set("q", query);
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`PriceCharting lookup failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const productName = cleanText(payload?.["product-name"]);
  const consoleName = cleanText(payload?.["console-name"]);
  const candidateTitle = `${productName} ${consoleName}`.trim();
  const score = matchScore(target.title, candidateTitle);
  const conditionBasis = specialtyCondition(target);
  const guideValue = pennies(payload?.[`${conditionBasis}-price`]);
  const retailerBuyValue = pennies(payload?.[`retail-${conditionBasis}-buy`]);
  const retailerSellValue = pennies(payload?.[`retail-${conditionBasis}-sell`]);
  const annualSalesVolume = Math.max(0, Math.round(Number(payload?.["sales-volume"]) || 0));
  const asOf = new Date().toISOString();
  const eligible = payload?.status === "success"
    && cleanText(payload?.id)
    && productName
    && score >= 65
    && (guideValue || retailerSellValue);
  return {
    status: eligible ? "available" : "insufficient",
    channel: "PriceCharting current price guide",
    currency: "USD",
    asOf,
    query,
    ...(eligible ? {
      productId: cleanText(payload.id),
      productName,
      consoleName,
      matchScore: score,
      conditionBasis,
      guideValue: guideValue || retailerSellValue,
      retailerBuyValue,
      retailerSellValue: retailerSellValue || guideValue,
      annualSalesVolume,
      sourceUrl: specialtySourceUrl(query),
    } : {
      reason: score < 65 ? "Best PriceCharting result did not meet the title-match threshold" : "No usable current value was returned",
    }),
  };
}

function appendHistory(item, field, entry) {
  const prior = Array.isArray(item?.[field]) ? item[field] : [];
  const byAsOf = new Map(prior
    .filter((value) => value && Number.isFinite(Date.parse(value.asOf || "")))
    .map((value) => [value.asOf, value]));
  byAsOf.set(entry.asOf, entry);
  return [...byAsOf.values()]
    .sort((left, right) => Date.parse(left.asOf) - Date.parse(right.asOf))
    .slice(-MAX_HISTORY);
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

async function main() {
  const serpApiKey = cleanText(process.env.BIDAI_SERPAPI_KEY);
  const searchApiKey = cleanText(process.env.BIDAI_SEARCHAPI_KEY);
  const priceChartingToken = cleanText(process.env.BIDAI_PRICECHARTING_TOKEN);
  if (!serpApiKey && !searchApiKey && !priceChartingToken) {
    console.log("No-op: broad-market and specialty-price credentials are not configured.");
    return;
  }
  const { source, envelope } = await readEnvelope();
  const updates = new Map();

  const shoppingApiKey = searchApiKey || serpApiKey;
  const shoppingProvider = searchApiKey ? "searchapi" : "serpapi";
  let shoppingQueryCount = 0;
  if (shoppingApiKey) {
    const requestedBatchSize = process.env.BIDAI_MARKET_PRICE_BATCH_SIZE
      || process.env.BIDAI_SEARCHAPI_BATCH_SIZE
      || process.env.BIDAI_SERPAPI_BATCH_SIZE;
    const targetGroups = selectTargetGroups(envelope.items, "retailMarket", Math.min(500, positiveInteger(requestedBatchSize, 200)));
    let blockedStatus = null;
    const results = await mapWithConcurrency(targetGroups, 5, async (group) => {
      if (blockedStatus) return null;
      const target = group.representative;
      try {
        const result = await searchShopping(target, shoppingApiKey, shoppingProvider);
        shoppingQueryCount += result.queryCount;
        return result;
      } catch (error) {
        if ([401, 403, 429].includes(error.status)) blockedStatus = error.status;
        console.warn(`Shopping-price lookup skipped for ${cleanText(target.id, target.externalId)}: ${error.message}`);
        return null;
      }
    });
    targetGroups.forEach((group, index) => {
      if (!results[index]) return;
      for (const target of group.members) {
        updates.set(target.id, { ...(updates.get(target.id) || {}), shopping: results[index] });
      }
    });
  }

  if (priceChartingToken) {
    const targets = selectTargets(envelope.items, "specialtyMarket", Math.min(50, positiveInteger(process.env.BIDAI_PRICECHARTING_BATCH_SIZE, 20)), true);
    let blockedStatus = null;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (blockedStatus) break;
      try {
        const result = await searchPriceCharting(target, priceChartingToken);
        updates.set(target.id, { ...(updates.get(target.id) || {}), specialty: result });
      } catch (error) {
        if ([401, 403, 429].includes(error.status)) blockedStatus = error.status;
        console.warn(`Specialty-price lookup skipped for ${cleanText(target.id, target.externalId)}: ${error.message}`);
      }
      if (index < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, 1_050));
    }
  }

  if (!updates.size) {
    console.log("No-op: no active listings need a market-price refresh.");
    return;
  }
  envelope.items = envelope.items.map((item) => {
    const update = updates.get(item.id);
    if (!update) return item;
    const next = { ...item };
    if (update.shopping) {
      next.retailMarket = update.shopping.retailMarket;
      if (update.shopping.historyEntry) next.retailMarketHistory = appendHistory(item, "retailMarketHistory", update.shopping.historyEntry);
    }
    if (update.specialty) next.specialtyMarket = update.specialty;
    return next;
  });
  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource === source) {
    console.log("No-op: market-price evidence is unchanged.");
    return;
  }
  await writeEnvelope(envelope);
  const shoppingAvailable = [...updates.values()].filter((entry) => entry.shopping?.retailMarket?.status === "available").length;
  const specialtyAvailable = [...updates.values()].filter((entry) => entry.specialty?.status === "available").length;
  console.log(`Stored market research for ${updates.size} listing${updates.size === 1 ? "" : "s"} using ${shoppingQueryCount} Google Shopping quer${shoppingQueryCount === 1 ? "y" : "ies"}: ${shoppingAvailable} broad-market and ${specialtyAvailable} specialty matches available.`);
}

await main();
