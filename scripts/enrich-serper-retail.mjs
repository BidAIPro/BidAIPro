import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const SERPER_SHOPPING_URL = "https://google.serper.dev/shopping";
const PROVIDER = "serper";
const CHANNEL = "Google Shopping via Serper";
const STRATEGY_VERSION = "serper-google-shopping-v1";
const DEFAULT_MAX_QUERIES_PER_RUN = 25;
const MAX_QUERIES_PER_RUN = 500;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_RETRY_HOURS = 2;
const MAX_OFFERS = 50;
const MAX_HISTORY = 365;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "auction", "authentic", "authenticated", "goodwill", "item", "preowned", "shopgoodwill", "used",
]);

const QUERY_NOISE = new Set([
  "as", "assorted", "bulk", "collection", "estate", "includes", "including", "lot", "misc", "mixed", "nice", "parts",
  "set", "tested", "untested", "working",
]);

const GENERIC_PRODUCT_WORDS = new Set([
  "black", "blue", "brown", "gold", "gray", "green", "jewelry", "men", "mens", "new", "pink", "red", "silver",
  "size", "vintage", "white", "women", "womens",
]);

const ACCESSORY_WORDS = new Set([
  "adapter", "band", "battery", "box", "bumper", "cable", "case", "charger", "charging", "clip", "cover", "dock",
  "film", "filter", "holder", "lenscap", "manual", "mount", "protector", "replacement", "screen", "sleeve", "stand",
  "strap", "stylus",
]);

const MODEL_PREFIXES = new Set([
  "air", "edition", "galaxy", "gen", "generation", "hero", "ipad", "iphone", "jordan", "mark", "mk", "model", "note",
  "pixel", "playstation", "pro", "ps", "series", "switch", "watch", "xbox",
]);

const INSTALLMENT_PATTERN = /(?:\b(?:afterpay|affirm|klarna|installments?|lease|monthly|payments?|per\s+month|financ(?:e|ing))\b|\/(?:mo|month|wk|week)\b|\b(?:mo|month|wk|week)\b\s*(?:payment)?)/i;
const RANGE_PATTERN = /(?:\b(?:from|starting\s+at)\s*\$|\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:-|–|—|\bto\b)\s*\$?\s*\d[\d,]*(?:\.\d{1,2})?)/i;
const NON_PRODUCT_TITLE = /^(?:no shipping|pick[ -]?up|payment due|sales tax|terms(?: and conditions)?|inspection(?:s)?|as-is,? where-is)/i;

function cleanText(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, parsed) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function stableHash(value) {
  return createHash("sha256").update(cleanText(value)).digest("hex").slice(0, 24);
}

function httpUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1_000 : value;
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function configuredNow() {
  const parsed = timestampMs(process.env.BIDAI_SERPER_NOW);
  return new Date(parsed ?? Date.now());
}

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) : Promise.resolve();
}

function rawTokens(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function usefulTokens(value) {
  return [...new Set(rawTokens(value)
    .map((token) => token.replace(/^-|-$/g, ""))
    .filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOP_WORDS.has(token) && !QUERY_NOISE.has(token)))];
}

function identifierDigits(value) {
  const digits = cleanText(value).replace(/\D/g, "");
  return [8, 10, 12, 13, 14].includes(digits.length) ? digits : "";
}

export function identifiersFrom(value) {
  const found = [];
  const add = (candidate) => {
    if (Array.isArray(candidate)) return candidate.forEach(add);
    const normalized = identifierDigits(candidate);
    if (normalized) found.push(normalized);
  };
  add(value?.upc);
  add(value?.ean);
  add(value?.gtin);
  add(value?.isbn);
  add(value?.identifiers?.upc);
  add(value?.identifiers?.ean);
  add(value?.identifiers?.gtin);
  add(value?.identifiers?.isbn);
  add(value?.identifiers?.all);
  return [...new Set(found)];
}

function explicitModelValues(value) {
  return [...new Set([
    value?.model,
    value?.mpn,
    value?.manufacturerPartNumber,
    value?.identifiers?.model,
    value?.identifiers?.mpn,
  ].map((entry) => cleanText(entry)).filter(Boolean))];
}

function modelTokenIsNoise(token) {
  return /^(?:\d+(?:gb|tb|mb|g|kg|lb|lbs|oz|ct|ctw|mm|cm|in|ft|v|ah|w)|(?:18|19|20)\d{2}s?|\d+k)$/i.test(token);
}

function canonicalModelPrefix(value) {
  return { ps: "playstation", mk: "mark" }[value] || value;
}

export function modelKeys(value) {
  const tokens = rawTokens(value);
  const keys = new Set();
  tokens.forEach((token, index) => {
    const compact = token.replace(/-/g, "");
    if (/[a-z]/.test(compact) && /\d/.test(compact) && compact.length >= 3 && !modelTokenIsNoise(compact)) {
      keys.add(compact);
      const parts = compact.match(/^([a-z]{1,12})(\d[a-z0-9]*)$/);
      if (parts) keys.add(`${canonicalModelPrefix(parts[1])}:${parts[2]}`);
    }
    if (!/^\d{1,6}[a-z]?$/.test(token) || modelTokenIsNoise(token)) return;
    const prior = (tokens[index - 1] || "").replace(/-/g, "");
    if (MODEL_PREFIXES.has(prior)) keys.add(`${canonicalModelPrefix(prior)}:${token}`);
  });
  return keys;
}

function modelsFrom(value) {
  const keys = new Set(modelKeys(value?.title));
  for (const explicit of explicitModelValues(value)) {
    for (const key of modelKeys(explicit)) keys.add(key);
    const compact = cleanText(explicit).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (compact.length >= 3 && /[a-z]/.test(compact) && /\d/.test(compact) && !modelTokenIsNoise(compact)) keys.add(compact);
  }
  return keys;
}

function canonicalBrand(value) {
  return usefulTokens(value?.brand || value?.manufacturer).join(" ");
}

function listingKey(item) {
  const id = cleanText(item?.id);
  if (id) return `id:${id}`;
  const source = cleanText(item?.sourceKey || item?.source).toLowerCase();
  const external = cleanText(item?.externalId);
  if (source && external) return `source:${source}:${external}`;
  return `derived:${stableHash(`${source}|${external}|${item?.url || ""}|${item?.title || ""}|${item?.endsAt || ""}`)}`;
}

function activeForResearch(item, nowMs) {
  if (item?.status !== "active" || !cleanText(item?.title) || NON_PRODUCT_TITLE.test(cleanText(item?.title))) return false;
  const closesAt = timestampMs(item?.endsAt);
  return closesAt === null || closesAt > nowMs;
}

function conciseTitle(value) {
  return cleanText(value)
    .split(/\b(?:includes?|including|plus|w\/)\b/i, 1)[0]
    .replace(/\b(?:for parts(?: or repair)?|does not power on|as[ -]is)\b.*$/i, "");
}

export function queryForItem(item) {
  const identifier = identifiersFrom(item)[0];
  if (identifier) return { type: "identifier", value: identifier, key: `identifier:${identifier}` };

  const models = explicitModelValues(item);
  if (models.length) {
    const brand = canonicalBrand(item);
    const titleTokens = usefulTokens(conciseTitle(item?.title));
    const modelTokens = usefulTokens(models[0]);
    const selected = [...new Set([...usefulTokens(brand), ...modelTokens, ...titleTokens])].slice(0, 10);
    const value = selected.join(" ").slice(0, 140);
    if (value) return { type: "model", value, key: `model:${value.toLowerCase()}` };
  }

  const selected = usefulTokens(conciseTitle(item?.title)).slice(0, 10);
  const value = selected.join(" ").slice(0, 140);
  return value ? { type: "title", value, key: `title:${value.toLowerCase()}` } : null;
}

function sharedCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function titleSimilarity(targetTitle, candidateTitle) {
  const target = usefulTokens(targetTitle);
  const candidate = usefulTokens(candidateTitle);
  if (!target.length || !candidate.length) return { score: 0, shared: 0, coverage: 0, precision: 0, distinctiveShared: 0 };
  const shared = sharedCount(target, candidate);
  const coverage = shared / target.length;
  const precision = shared / candidate.length;
  const union = new Set([...target, ...candidate]).size;
  const jaccard = union ? shared / union : 0;
  const distinctive = target.filter((token) => !GENERIC_PRODUCT_WORDS.has(token));
  const distinctiveShared = sharedCount(distinctive, candidate);
  const score = Math.round(Math.min(1, coverage * 0.62 + precision * 0.18 + jaccard * 0.2) * 10_000) / 100;
  return { score, shared, coverage, precision, distinctiveShared };
}

function modelFamily(key) {
  const paired = key.match(/^([a-z]+):(.+)$/);
  if (paired) return paired[1];
  const compact = key.match(/^([a-z]+)\d/);
  return compact?.[1] || "";
}

function modelsConflict(targetModels, candidateModels) {
  if (!targetModels.size || !candidateModels.size) return false;
  if ([...targetModels].some((key) => candidateModels.has(key))) return false;
  for (const target of targetModels) {
    const family = modelFamily(target);
    if (!family) continue;
    const sameFamily = [...candidateModels].filter((candidate) => modelFamily(candidate) === family);
    if (sameFamily.length && !sameFamily.includes(target)) return true;
  }
  return false;
}

function variantSignals(value) {
  const source = cleanText(value).toLowerCase();
  const signals = new Map();
  const storage = source.match(/\b(\d+(?:\.\d+)?)\s*(tb|gb)\b/i);
  if (storage) {
    const gigabytes = Number(storage[1]) * (storage[2].toLowerCase() === "tb" ? 1_000 : 1);
    signals.set("storage", String(gigabytes));
  }
  const statedSize = source.match(/\bsize\s*[:#-]?\s*(\d+(?:\.\d+)?)\b/i);
  if (statedSize) signals.set("size", statedSize[1]);
  const millimeters = source.match(/\b(\d+(?:\.\d+)?)\s*mm\b/i);
  if (millimeters) signals.set("millimeters", millimeters[1]);
  return signals;
}

function variantsConflict(targetTitle, candidateTitle) {
  const target = variantSignals(targetTitle);
  const candidate = variantSignals(candidateTitle);
  return [...target].some(([kind, value]) => candidate.has(kind) && candidate.get(kind) !== value);
}

function obviousAccessoryMismatch(targetTitle, candidateTitle) {
  const target = new Set(usefulTokens(targetTitle));
  const candidate = usefulTokens(candidateTitle);
  const targetIsAccessory = [...ACCESSORY_WORDS].some((word) => target.has(word));
  if (targetIsAccessory) return false;
  const accessory = candidate.find((token) => ACCESSORY_WORDS.has(token));
  if (!accessory) return false;
  return /\b(?:for|compatible with|replacement for)\b/i.test(candidateTitle) || candidate.length <= 8 || accessory !== "screen";
}

function identifierRelationship(target, candidate) {
  const targetIds = identifiersFrom(target);
  if (!targetIds.length) return { matched: false, conflict: false };
  const candidateIds = identifiersFrom(candidate);
  const titleDigits = cleanText(candidate?.title).replace(/[^\d]+/g, " ").split(/\s+/).filter(Boolean);
  const canonical = (identifier) => identifier.replace(/^0+(?=\d)/, "");
  const candidateCanonical = new Set([...candidateIds, ...titleDigits].map(canonical));
  if (targetIds.some((identifier) => candidateCanonical.has(canonical(identifier)))) {
    return { matched: true, conflict: false };
  }
  return { matched: false, conflict: candidateIds.length > 0 };
}

export function classifyIdentity(target, candidate, query = queryForItem(target)) {
  const candidateTitle = cleanText(candidate?.title);
  if (!candidateTitle) return { accepted: false, reasonCode: "missing-title", reason: "Shopping result has no product title" };
  if (obviousAccessoryMismatch(target?.title, candidateTitle)) {
    return { accepted: false, reasonCode: "accessory-mismatch", reason: "Result is an accessory rather than the auctioned product" };
  }

  const targetBrand = canonicalBrand(target);
  const candidateBrand = canonicalBrand(candidate);
  if (targetBrand && candidateBrand && sharedCount(usefulTokens(targetBrand), usefulTokens(candidateBrand)) === 0) {
    return { accepted: false, reasonCode: "brand-conflict", reason: "Result names a conflicting manufacturer or brand" };
  }

  const targetModels = modelsFrom(target);
  const candidateModels = modelsFrom(candidate);
  if (modelsConflict(targetModels, candidateModels)) {
    return { accepted: false, reasonCode: "model-conflict", reason: "Result names a different model or generation" };
  }
  if (variantsConflict(target?.title, candidateTitle)) {
    return { accepted: false, reasonCode: "variant-conflict", reason: "Result names a different storage, size, or measured product variant" };
  }

  const identifiers = identifierRelationship(target, candidate);
  if (identifiers.conflict) {
    return { accepted: false, reasonCode: "identifier-conflict", reason: "Result contains a different UPC, EAN, GTIN, or ISBN" };
  }

  const similarity = titleSimilarity(target?.title, candidateTitle);
  const sharedModels = [...targetModels].filter((key) => candidateModels.has(key));
  if (identifiers.matched) {
    return { accepted: true, matchType: "exact", matchScore: 100, matchedBy: "catalog identifier", ...similarity };
  }
  if (sharedModels.length && similarity.coverage >= 0.55 && similarity.shared >= 2) {
    return {
      accepted: true,
      matchType: "exact",
      matchScore: Math.max(90, Math.min(99, Math.round(similarity.score + 18))),
      matchedBy: "model and title",
      sharedModels,
      ...similarity,
    };
  }
  if (similarity.coverage >= 0.68 && similarity.shared >= 3 && similarity.distinctiveShared >= 1) {
    return {
      accepted: true,
      matchType: "strong",
      matchScore: Math.max(80, Math.min(89, Math.round(similarity.score + (query?.type === "identifier" ? 6 : 0)))),
      matchedBy: "strong title",
      ...similarity,
    };
  }
  if (similarity.coverage >= 0.45 && similarity.shared >= 2 && similarity.distinctiveShared >= 1) {
    return {
      accepted: true,
      matchType: "approximate",
      matchScore: Math.max(45, Math.min(69, Math.round(similarity.score))),
      matchedBy: "partial title",
      ...similarity,
    };
  }
  return {
    accepted: false,
    reasonCode: "weak-identity",
    reason: "Result does not share enough distinctive product identity",
    ...similarity,
  };
}

export function parseStrictPrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? roundMoney(value) : null;
  const source = cleanText(value);
  if (!source || INSTALLMENT_PATTERN.test(source) || RANGE_PATTERN.test(source) || /[£€¥]/.test(source)) return null;
  const matches = [...source.matchAll(/(?:USD\s*)?\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/gi)]
    .map((match) => Number.parseFloat(match[1].replace(/,/g, "")))
    .filter((number) => Number.isFinite(number) && number > 0);
  const distinct = [...new Set(matches)];
  return distinct.length === 1 ? roundMoney(distinct[0]) : null;
}

function shippingFrom(value) {
  const source = cleanText(value);
  if (!source) return { shipping: null, shippingKnown: false };
  if (/\bfree\b/i.test(source)) return { shipping: 0, shippingKnown: true };
  if (/pickup|collect/i.test(source) && !/ship|deliver/i.test(source)) return { shipping: null, shippingKnown: false };
  const price = parseStrictPrice(source);
  return price === null ? { shipping: null, shippingKnown: false } : { shipping: price, shippingKnown: true };
}

function conditionFor(result, title) {
  const source = `${cleanText(result?.condition)} ${cleanText(result?.tag)} ${title}`;
  if (/refurb|renewed|remanufactured/i.test(source)) return "refurbished";
  if (/\bused\b|pre[ -]?owned|second[ -]?hand/i.test(source)) return "used";
  if (/\bnew\b|sealed|nib|new with tags|nwt/i.test(source)) return "new";
  return "unspecified";
}

function offerCountFrom(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { count: Math.round(value), minimum: false };
  const source = cleanText(value);
  const match = source.match(/(\d[\d,]*)\s*(\+)?/);
  if (!match) return { count: null, minimum: false };
  return { count: Number.parseInt(match[1].replace(/,/g, ""), 10), minimum: Boolean(match[2]) };
}

function rejection(reasonCode, reason) {
  return { accepted: false, reasonCode, reason };
}

export function normalizeShoppingResult(result, target, query = queryForItem(target), observedAt = new Date().toISOString()) {
  const title = cleanText(result?.title).slice(0, 500);
  if (!title) return rejection("missing-title", "Shopping result has no title");
  const rawPrice = result?.price ?? result?.extracted_price;
  if (INSTALLMENT_PATTERN.test(`${cleanText(rawPrice)} ${cleanText(result?.delivery)}`)) {
    return rejection("installment-price", "Installment or periodic payment is not a cash retail price");
  }
  if (RANGE_PATTERN.test(cleanText(rawPrice))) return rejection("price-range", "Price ranges and starting prices are ambiguous");
  const price = parseStrictPrice(rawPrice);
  if (!price) return rejection("invalid-price", "Shopping result has no single positive USD cash price");
  const link = httpUrl(result?.link || result?.productLink || result?.product_link);
  if (!link) return rejection("invalid-link", "Shopping result has no auditable HTTP product link");
  const source = cleanText(result?.source || result?.seller || result?.merchant).slice(0, 200);
  if (!source) return rejection("missing-source", "Shopping result has no merchant source");

  const candidate = {
    ...result,
    title,
    brand: result?.brand || result?.manufacturer,
    model: result?.model || result?.mpn,
  };
  const identity = classifyIdentity(target, candidate, query);
  if (!identity.accepted) return identity;

  const { shipping, shippingKnown } = shippingFrom(result?.delivery ?? result?.shipping);
  const totalPrice = roundMoney(price + (shippingKnown ? shipping : 0));
  const ratingValue = Number(result?.rating);
  const rating = Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 5 ? Math.round(ratingValue * 10) / 10 : null;
  const reviewsValue = Number(result?.ratingCount ?? result?.reviews ?? result?.reviewCount);
  const reviews = Number.isFinite(reviewsValue) && reviewsValue > 0 ? Math.round(reviewsValue) : 0;
  const offered = offerCountFrom(result?.offers ?? result?.offerCount);
  const productId = cleanText(result?.productId || result?.product_id).slice(0, 200);
  return {
    accepted: true,
    offer: {
      id: `serper:${productId || stableHash(`${source}|${link}|${title}`)}`,
      productId: productId || null,
      title,
      source,
      link,
      url: link,
      currency: "USD",
      price,
      shipping,
      shippingKnown,
      totalPrice,
      condition: conditionFor(result, title),
      rating,
      reviews,
      offerCount: offered.count,
      offerCountIsMinimum: offered.minimum,
      matchType: identity.matchType,
      matchTier: identity.matchType,
      matchScore: identity.matchScore,
      matchedBy: identity.matchedBy,
      observedAt,
      freshness: "current",
      isCurrent: true,
      evidenceType: "current-google-shopping-asking-price",
      listingState: "current merchant asking price; not a completed sale",
    },
  };
}

function quantile(values, probability) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return roundMoney(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function average(values) {
  return values.length ? roundMoney(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function rankForMatch(value) {
  return { approximate: 1, strong: 2, exact: 3 }[value] || 0;
}

function robustOffers(offers) {
  const median = quantile(offers.map((offer) => offer.price), 0.5);
  if (!median || offers.length < 5) return offers;
  const filtered = offers.filter((offer) => offer.price >= median * 0.25 && offer.price <= median * 4);
  return filtered.length >= 3 ? filtered : offers;
}

function rejectionSummary(rejections) {
  const byReason = {};
  for (const entry of rejections) byReason[entry.reasonCode] = (byReason[entry.reasonCode] || 0) + 1;
  return {
    total: rejections.length,
    byReason,
    examples: rejections.slice(0, 10).map((entry) => ({ reasonCode: entry.reasonCode, reason: entry.reason, title: entry.title })),
  };
}

function emptyMarket(query, observedAt, reason, rejections = []) {
  return {
    status: "insufficient",
    provider: PROVIDER,
    channel: CHANNEL,
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    checkedAt: observedAt,
    researchedAt: observedAt,
    query: { type: query?.type || "title", value: query?.value || "" },
    catalog: null,
    priceSummary: null,
    offers: [],
    productInterest: { reviewCountMax: 0, reviewCountMedian: 0, ratingAverage: null, merchantOfferCountMax: 0 },
    rejections: rejectionSummary(rejections),
    reason,
    note: "No price is asserted without a usable Google Shopping result and auditable merchant link.",
    lastAttempt: { asOf: observedAt, status: "completed", reason },
  };
}

export function marketFromPayload(target, query, payload, observedAt = new Date().toISOString()) {
  const results = [
    ...(Array.isArray(payload?.shopping) ? payload.shopping : []),
    ...(Array.isArray(payload?.shopping_results) ? payload.shopping_results : []),
  ];
  const accepted = [];
  const rejected = [];
  for (const result of results) {
    const normalized = normalizeShoppingResult(result, target, query, observedAt);
    if (normalized.accepted) accepted.push(normalized.offer);
    else rejected.push({ ...normalized, title: cleanText(result?.title).slice(0, 300) });
  }
  if (!accepted.length) {
    return emptyMarket(
      query,
      observedAt,
      results.length ? "Serper returned results, but none passed product-identity and cash-price validation" : "Serper returned no Google Shopping results",
      rejected,
    );
  }

  const unique = new Map();
  for (const offer of accepted) {
    const key = `${offer.source.toLowerCase()}|${offer.link.toLowerCase()}|${offer.price}`;
    const existing = unique.get(key);
    if (!existing || offer.matchScore > existing.matchScore) unique.set(key, offer);
  }
  const offers = [...unique.values()]
    .sort((left, right) => rankForMatch(right.matchType) - rankForMatch(left.matchType) || right.matchScore - left.matchScore || left.totalPrice - right.totalPrice)
    .slice(0, MAX_OFFERS);
  const bestRank = Math.max(...offers.map((offer) => rankForMatch(offer.matchType)));
  const bestMatchType = offers.find((offer) => rankForMatch(offer.matchType) === bestRank)?.matchType || "approximate";
  const sameTier = robustOffers(offers.filter((offer) => offer.matchType === bestMatchType));
  const sourceCount = new Set(sameTier.map((offer) => offer.source.toLowerCase())).size;
  const prices = sameTier.map((offer) => offer.price);
  const knownLanded = sameTier.filter((offer) => offer.shippingKnown).map((offer) => offer.totalPrice);
  const summary = {
    basisMatchType: bestMatchType,
    sampleSize: sameTier.length,
    sourceCount,
    priceLow: quantile(prices, 0),
    priceMedian: quantile(prices, 0.5),
    priceAverage: average(prices),
    priceHigh: quantile(prices, 1),
    landedSampleSize: knownLanded.length,
    landedLow: quantile(knownLanded, 0),
    landedMedian: quantile(knownLanded, 0.5),
    landedHigh: quantile(knownLanded, 1),
  };
  const available = ["exact", "strong"].includes(bestMatchType) && sameTier.length >= 2 && sourceCount >= 2;
  const reviewCounts = offers.map((offer) => offer.reviews).filter((value) => value > 0);
  const ratings = offers.map((offer) => offer.rating).filter((value) => Number.isFinite(value));
  const merchantOfferCounts = offers.map((offer) => offer.offerCount).filter((value) => Number.isFinite(value));
  const best = offers[0];
  return {
    status: available ? "available" : "reference-only",
    provider: PROVIDER,
    channel: CHANNEL,
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    checkedAt: observedAt,
    researchedAt: observedAt,
    query: { type: query.type, value: query.value },
    catalog: {
      title: best.title,
      matchTier: bestMatchType,
      matchType: bestMatchType,
      matchScore: best.matchScore,
      matchedBy: best.matchedBy,
      sampleSize: summary.sampleSize,
      sourceCount,
      priceLow: summary.priceLow,
      priceMedian: summary.priceMedian,
      priceAverage: summary.priceAverage,
      priceHigh: summary.priceHigh,
      sourceUrl: best.link,
      evidenceType: bestMatchType === "exact" ? "current-exact-product-retail-offers" : "current-strong-title-retail-offers",
      planningReservePercent: available ? 55 : 65,
    },
    priceSummary: summary,
    offers,
    productInterest: {
      reviewCountMax: reviewCounts.length ? Math.max(...reviewCounts) : 0,
      reviewCountMedian: quantile(reviewCounts, 0.5) || 0,
      ratingAverage: ratings.length ? Math.round(average(ratings) * 10) / 10 : null,
      merchantOfferCountMax: merchantOfferCounts.length ? Math.max(...merchantOfferCounts) : 0,
      note: "Review and merchant-offer counts are popularity signals, not proof of resale sell-through.",
    },
    rejections: rejectionSummary(rejected),
    reason: available
      ? "At least two independent merchants supplied exact or strong current product matches"
      : bestMatchType === "approximate"
        ? "Only approximate product matches were found; this is a retail reference, not a safe-bid basis"
        : "Only one independent merchant supplied a validated exact or strong current price",
    note: "Google Shopping merchant asking prices are not completed sales, guaranteed proceeds, or a safe-bid recommendation.",
    lastAttempt: { asOf: observedAt, status: "completed", resultStatus: available ? "available" : "reference-only" },
  };
}

function queueEntryFor(group, prior, nowIso) {
  return {
    queryKey: group.query.key,
    query: { type: group.query.type, value: group.query.value },
    listingKeys: [...group.listingKeys].sort(),
    enqueuedAt: cleanText(prior?.enqueuedAt, nowIso),
    lastAttemptAt: cleanText(prior?.lastAttemptAt) || null,
    nextEligibleAt: cleanText(prior?.nextEligibleAt) || null,
    attempts: Math.max(0, Number.parseInt(prior?.attempts, 10) || 0),
    lastStatus: cleanText(prior?.lastStatus) || null,
    earliestEndsAt: cleanText(group?.earliestEndsAt) || null,
  };
}

export function reconcilePersistentQueue(items, priorQueue = [], nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!activeForResearch(item, nowMs)) continue;
    const query = queryForItem(item);
    if (!query) continue;
    if (!groups.has(query.key)) groups.set(query.key, { query, listingKeys: [], earliestEndsAt: null });
    const group = groups.get(query.key);
    group.listingKeys.push(listingKey(item));
    const endsAt = timestampMs(item?.endsAt);
    const priorEndsAt = timestampMs(group.earliestEndsAt);
    if (endsAt !== null && (priorEndsAt === null || endsAt < priorEndsAt)) {
      group.earliestEndsAt = new Date(endsAt).toISOString();
    }
  }
  const priorByKey = new Map((Array.isArray(priorQueue) ? priorQueue : [])
    .filter((entry) => entry && cleanText(entry.queryKey))
    .map((entry) => [entry.queryKey, entry]));
  const orderedKeys = [
    ...(Array.isArray(priorQueue) ? priorQueue.map((entry) => cleanText(entry?.queryKey)).filter((key) => groups.has(key)) : []),
    ...[...groups.keys()].filter((key) => !priorByKey.has(key)).sort(),
  ];
  return [...new Set(orderedKeys)].map((key) => queueEntryFor(groups.get(key), priorByKey.get(key), nowIso));
}

export function selectDueQueue(queue, limit = DEFAULT_MAX_QUERIES_PER_RUN, nowMs = Date.now()) {
  const maximum = Math.min(MAX_QUERIES_PER_RUN, Math.max(0, Number.parseInt(limit, 10) || 0));
  return (Array.isArray(queue) ? queue : [])
    .map((entry, index) => ({
      entry,
      index,
      dueAt: timestampMs(entry?.nextEligibleAt) ?? 0,
      closesAt: timestampMs(entry?.earliestEndsAt) ?? Number.MAX_SAFE_INTEGER,
      identityRank: { identifier: 0, model: 1, title: 2 }[entry?.query?.type] ?? 3,
    }))
    .filter(({ dueAt }) => dueAt <= nowMs)
    .sort((left, right) => {
      const leftNever = left.entry?.lastAttemptAt ? 1 : 0;
      const rightNever = right.entry?.lastAttemptAt ? 1 : 0;
      return leftNever - rightNever
        || left.closesAt - right.closesAt
        || left.identityRank - right.identityRank
        || left.dueAt - right.dueAt
        || left.index - right.index;
    })
    .slice(0, maximum)
    .map(({ entry }) => entry);
}

function updateQueueAttempt(queue, queryKey, observedAt, status, waitHours) {
  const nextEligibleAt = new Date(Date.parse(observedAt) + waitHours * 3_600_000).toISOString();
  const current = queue.find((entry) => entry.queryKey === queryKey);
  if (!current) return queue;
  const updated = {
    ...current,
    lastAttemptAt: observedAt,
    nextEligibleAt,
    attempts: (Number(current.attempts) || 0) + 1,
    lastStatus: status,
  };
  return [...queue.filter((entry) => entry.queryKey !== queryKey), updated];
}

function marketHistoryEntry(market) {
  return {
    asOf: market.asOf,
    researchedAt: market.researchedAt || market.asOf,
    provider: PROVIDER,
    query: market.query,
    status: market.status,
    matchType: market.catalog?.matchType || null,
    sampleSize: market.priceSummary?.sampleSize || 0,
    sourceCount: market.priceSummary?.sourceCount || 0,
    priceLow: market.priceSummary?.priceLow || null,
    priceMedian: market.priceSummary?.priceMedian || null,
    priceHigh: market.priceSummary?.priceHigh || null,
    reason: market.reason || null,
    transient: Boolean(market.transient),
  };
}

function appendHistory(existing, entry) {
  const prior = Array.isArray(existing) ? existing.filter((value) => value && Number.isFinite(timestampMs(value.asOf))) : [];
  const key = `${entry.asOf}|${entry.query?.type || ""}|${entry.query?.value || ""}`;
  const withoutDuplicate = prior.filter((value) => `${value.asOf}|${value.query?.type || ""}|${value.query?.value || ""}` !== key);
  return [...withoutDuplicate, entry]
    .sort((left, right) => timestampMs(left.asOf) - timestampMs(right.asOf))
    .slice(-MAX_HISTORY);
}

function failedLookupMarket(query, observedAt, error, transient = true) {
  const reason = `Serper lookup failed before price evidence could be evaluated: ${cleanText(error?.message, "unknown error")}`;
  return {
    ...emptyMarket(query, observedAt, reason),
    transient,
    lookupFailed: true,
    lastAttempt: {
      asOf: observedAt,
      status: "error",
      httpStatus: Number(error?.status) || null,
      reason,
    },
  };
}

export function retainOnTransientFailure(existing, attempted) {
  if (!attempted?.lookupFailed || !existing || !["available", "reference-only"].includes(existing.status)) return attempted;
  return {
    ...existing,
    lastAttempt: attempted.lastAttempt,
  };
}

function catalogEvidenceStrength(market) {
  if (!market || typeof market !== "object") return 0;
  const status = { insufficient: 0, "reference-only": 1, available: 2 }[String(market.status || "").toLowerCase()] || 0;
  const catalog = market.catalog && typeof market.catalog === "object" ? market.catalog : {};
  const tier = String(catalog.matchType || catalog.matchTier || market.matchType || market.matchTier || "").toLowerCase();
  const identity = /exact|identifier|gtin|upc|ean|isbn|model/.test(tier) ? 3 : /strong|strict|close/.test(tier) ? 2 : /approx|analog|partial/.test(tier) ? 1 : 0;
  const sourceCount = Math.max(0, Number(catalog.sourceCount) || 0);
  const sampleSize = Math.max(0, Number(catalog.sampleSize) || 0);
  const matchScore = Math.max(0, Number(catalog.matchScore ?? market.matchScore) || 0);
  return status * 10_000_000 + identity * 1_000_000 + sourceCount * 10_000 + sampleSize * 100 + matchScore;
}

export function mergeFreeRetailEvidence(existing, attempted) {
  if (!attempted || attempted.transient) return existing;
  if (attempted.status === "insufficient") {
    return existing ? {
      ...existing,
      lastAttempt: {
        asOf: attempted.asOf,
        status: "completed",
        resultStatus: "insufficient",
        provider: PROVIDER,
        reason: attempted.reason || "The latest Serper lookup produced no validated catalog-retail reference",
      },
    } : existing;
  }
  const matchType = String(attempted.catalog?.matchType || attempted.catalog?.matchTier || "").toLowerCase();
  if (!["exact", "strong"].includes(matchType)) {
    return existing ? {
      ...existing,
      lastAttempt: {
        asOf: attempted.asOf,
        status: "completed",
        resultStatus: attempted.status,
        provider: PROVIDER,
        reason: "Only an approximate Serper product match was found; the existing catalog-retail reference was retained",
      },
    } : existing;
  }
  if (!existing || catalogEvidenceStrength(attempted) >= catalogEvidenceStrength(existing)) return attempted;
  return {
    ...existing,
    lastAttempt: {
      asOf: attempted.asOf,
      status: "completed",
      resultStatus: attempted.status,
      provider: PROVIDER,
      reason: "A stronger existing catalog-retail reference was retained after the Serper lookup",
    },
  };
}

function isTransientError(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || [408, 425, 429].includes(status) || status >= 500;
}

export async function requestSerperShopping(query, apiKey, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available.");
  const response = await fetchImpl(SERPER_SHOPPING_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ q: query.value, gl: "us", hl: "en", num: 20 }),
  });
  if (!response?.ok) {
    const error = new Error(`Serper Google Shopping request failed with HTTP ${response?.status ?? "unknown"}.`);
    error.status = response?.status;
    throw error;
  }
  const payload = await response.json();
  return payload && typeof payload === "object" ? payload : {};
}

async function readEnvelope(path = outputPath) {
  try {
    const source = await readFile(path, "utf8");
    if (!source.startsWith(OUTPUT_PREFIX)) throw new Error("Snapshot file has an unsupported format.");
    const envelope = JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
    if (!envelope || !Array.isArray(envelope.items)) throw new Error("Snapshot file does not contain an item array.");
    return { source, envelope };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeEnvelope(envelope, path = outputPath) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function resolveRunNow(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value === "function") return resolveRunNow(value());
  const parsed = timestampMs(value);
  return new Date(parsed ?? configuredNow().getTime());
}

export async function runEnrichment({
  path = outputPath,
  apiKey = cleanText(process.env.BIDAI_SERPER_API_KEY || process.env.BIDAI_SERPER_KEY),
  fetchImpl = globalThis.fetch,
  now,
  logger = console,
  delay = sleep,
  maxQueriesPerRun = boundedPositiveInteger(process.env.BIDAI_SERPER_MAX_QUERIES_PER_RUN, DEFAULT_MAX_QUERIES_PER_RUN, MAX_QUERIES_PER_RUN),
  delayMs = nonNegativeInteger(process.env.BIDAI_SERPER_DELAY_MS, DEFAULT_DELAY_MS),
  refreshHours = positiveNumber(process.env.BIDAI_SERPER_REFRESH_HOURS, DEFAULT_REFRESH_HOURS),
  retryHours = positiveNumber(process.env.BIDAI_SERPER_RETRY_HOURS, DEFAULT_RETRY_HOURS),
} = {}) {
  if (!apiKey) {
    logger.log("No-op: BIDAI_SERPER_API_KEY is not configured.");
    return { changed: 0, requested: 0, missingToken: true };
  }
  const loaded = await readEnvelope(path);
  if (!loaded) {
    logger.log("No-op: data/live-snapshots.js does not exist yet.");
    return { changed: 0, requested: 0, missing: true };
  }
  const { source, envelope } = loaded;
  const runNow = resolveRunNow(now);
  const observedAt = runNow.toISOString();
  let queue = reconcilePersistentQueue(envelope.items, envelope.serperRetailEnrichment?.queue, runNow.getTime());
  const due = selectDueQueue(queue, Math.min(MAX_QUERIES_PER_RUN, Math.max(0, Number(maxQueriesPerRun) || 0)), runNow.getTime());
  const itemsByKey = new Map(envelope.items.map((item) => [listingKey(item), item]));
  const updates = new Map();
  let requested = 0;
  let completed = 0;
  let transientFailures = 0;
  let rejectedOrEmpty = 0;
  let stoppedStatus = null;

  for (let index = 0; index < due.length; index += 1) {
    const entry = due[index];
    if (index > 0) await delay(delayMs);
    requested += 1;
    let outcomeStatus = "completed";
    try {
      const payload = await requestSerperShopping(entry.query, apiKey, fetchImpl);
      for (const key of entry.listingKeys) {
        const item = itemsByKey.get(key);
        if (!item) continue;
        const market = marketFromPayload(item, entry.query, payload, observedAt);
        updates.set(key, market);
        if (market.status === "insufficient") rejectedOrEmpty += 1;
      }
      completed += 1;
      queue = updateQueueAttempt(queue, entry.queryKey, observedAt, outcomeStatus, refreshHours);
    } catch (error) {
      const transient = isTransientError(error);
      outcomeStatus = transient ? "transient-error" : "permanent-error";
      if (transient) transientFailures += 1;
      for (const key of entry.listingKeys) {
        const item = itemsByKey.get(key);
        if (!item) continue;
        updates.set(key, failedLookupMarket(entry.query, observedAt, error, transient));
      }
      queue = updateQueueAttempt(queue, entry.queryKey, observedAt, outcomeStatus, transient ? retryHours : refreshHours);
      logger.warn(`Serper retail lookup skipped for ${entry.queryKey}: ${error.message}`);
      if ([401, 403, 429].includes(Number(error?.status)) || Number(error?.status) >= 500 || !Number.isFinite(Number(error?.status))) {
        stoppedStatus = Number(error?.status) || "network";
        break;
      }
    }
  }

  let reviewedListings = 0;
  envelope.items = envelope.items.map((item) => {
    const key = listingKey(item);
    const attempted = updates.get(key);
    if (!attempted) return item;
    reviewedListings += 1;
    const retainedSerper = retainOnTransientFailure(item.serperRetailMarket, attempted);
    const nextFreeRetail = attempted.lookupFailed ? item.freeRetailMarket : mergeFreeRetailEvidence(item.freeRetailMarket, retainedSerper);
    return {
      ...item,
      serperRetailMarket: retainedSerper,
      ...(nextFreeRetail ? { freeRetailMarket: nextFreeRetail } : {}),
      serperRetailHistory: appendHistory(item.serperRetailHistory, marketHistoryEntry(attempted)),
    };
  });
  envelope.serperRetailEnrichment = {
    provider: PROVIDER,
    channel: CHANNEL,
    strategyVersion: STRATEGY_VERSION,
    lastRunAt: observedAt,
    maxQueriesPerRun: Math.min(MAX_QUERIES_PER_RUN, Math.max(0, Number(maxQueriesPerRun) || 0)),
    refreshHours,
    retryHours,
    requested,
    completed,
    reviewedListings,
    transientFailures,
    rejectedOrEmpty,
    stoppedStatus,
    queueSize: queue.length,
    dueAfterRun: selectDueQueue(queue, queue.length, runNow.getTime()).length,
    queue,
  };
  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource !== source) await writeEnvelope(envelope, path);
  logger.log(`Serper researched ${reviewedListings} active listing${reviewedListings === 1 ? "" : "s"} with ${requested} Google Shopping quer${requested === 1 ? "y" : "ies"}; ${queue.length} query group${queue.length === 1 ? "" : "s"} remain in the persistent queue.`);
  return { changed: reviewedListings, requested, completed, transientFailures, queueSize: queue.length, stoppedStatus };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runEnrichment();
}
