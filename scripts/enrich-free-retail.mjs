import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const API_ROOT = "https://api.upcitemdb.com/prod/trial";
const PROVIDER = "upcitemdb";
const STRATEGY_VERSION = "upcitemdb-free-retail-v1";
const DEFAULT_DAILY_TITLE_SEARCHES = 20;
const DEFAULT_DELAY_MS = 31_000;
const DEFAULT_FRESH_DAYS = 45;
const ATTEMPT_FRESH_MS = 23 * 60 * 60_000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "auction", "authentic", "authenticated", "beautiful", "goodwill", "item", "nice", "preowned", "shopgoodwill", "used",
]);

const LISTING_NOISE = new Set([
  "assorted", "bundle", "case", "charger", "collection", "estate", "includes", "lot", "misc", "mixed", "nwt", "open",
  "parts", "set", "tested", "untested", "working",
]);

const MODEL_PREFIXES = new Set([
  "air", "edition", "gen", "generation", "galaxy", "hero", "iphone", "ipad", "jordan", "mark", "mk", "model",
  "note", "pixel", "playstation", "pro", "ps", "series", "switch", "watch", "xbox",
]);

const NON_PRODUCT_TITLE = /^(?:no shipping|pick[ -]?up|payment due|sales tax|terms(?: and conditions)?|inspection(?:s)?|as-is,? where-is)/i;
const COMPOSITE_LOT_TITLE = /\b(?:assorted|bulk|gaylord|lot|set of \d+|unsorted|wholesale|\d+(?:\.\d+)?\s*(?:lb|lbs|pounds)\b)/i;
const UNIQUE_METAL_TITLE = /(?:\b(?:gold|silver|sterling|platinum|palladium)\b.*\b(?:bracelet|chain|earrings?|jewelry|necklace|pendant|rings?)\b|\b(?:bracelet|chain|earrings?|jewelry|necklace|pendant|rings?)\b.*\b(?:gold|silver|sterling|platinum|palladium)\b)/i;

function cleanText(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function httpUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function nowDate() {
  const configured = Date.parse(cleanText(process.env.BIDAI_FREE_RETAIL_NOW));
  return new Date(Number.isFinite(configured) ? configured : Date.now());
}

function textTokens(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function usefulTokens(value) {
  return [...new Set(textTokens(value)
    .filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOP_WORDS.has(token) && !LISTING_NOISE.has(token)))];
}

function modelKeys(value) {
  const raw = textTokens(value);
  const keys = new Set();
  raw.forEach((token, index) => {
    if (/[a-z]/.test(token) && /\d/.test(token) && token.length >= 2) keys.add(token);
    if (!/^\d{1,6}$/.test(token)) return;
    const numeric = Number(token);
    if (token.length === 4 && numeric >= 1900 && numeric <= 2099) return;
    const prior = raw[index - 1] || "";
    if (MODEL_PREFIXES.has(prior)) keys.add(`${prior}:${token}`);
    else if (token.length >= 3) keys.add(token);
  });
  return keys;
}

function hasStrongModelSignal(value) {
  const source = cleanText(value).toLowerCase();
  const raw = source.match(/[a-z0-9-]+/g) || [];
  if (raw.some((token) => /[a-z]/.test(token)
    && /\d/.test(token)
    && !/^\d+(?:lb|lbs|g|kg|oz|ct|ctw|mm|cm|in|ft|v|ah|w|x)$/.test(token))) return true;
  if (/\b[a-z]{1,8}-\d{2,6}[a-z]?\b/.test(source)) return true;
  const tokens = textTokens(source);
  return tokens.some((token, index) => /^\d{1,4}$/.test(token) && MODEL_PREFIXES.has(tokens[index - 1] || ""));
}

function isCatalogCandidate(item) {
  if (identifiersFrom(item).length) return true;
  const title = cleanText(item?.title);
  if (!title || NON_PRODUCT_TITLE.test(title) || COMPOSITE_LOT_TITLE.test(title) || UNIQUE_METAL_TITLE.test(title)) return false;
  const vertical = verticalFor(item).toLowerCase();
  if (/rings?\s*&\s*jewelry|jewelry|precious metal/.test(vertical)) return false;
  return usefulTokens(title).length >= 3;
}

function identifiersFrom(value) {
  const candidates = [];
  const add = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(add);
    const digits = cleanText(entry).replace(/\D/g, "");
    if ([8, 10, 12, 13, 14].includes(digits.length)) candidates.push(digits);
  };
  add(value?.upc);
  add(value?.ean);
  add(value?.gtin);
  add(value?.isbn);
  add(value?.identifiers?.upc);
  add(value?.identifiers?.ean);
  add(value?.identifiers?.gtin);
  add(value?.identifiers?.isbn);
  return [...new Set(candidates)];
}

function titleQueryFor(item) {
  // `modelKey` in the snapshot is an internal deduplication key such as
  // `shopgoodwill:title-exact-v1:...`, not manufacturer product metadata.
  // Sending that prefix to a catalog search both harms recall and can make the
  // source/version tokens look like a false model conflict.
  const coreTitle = cleanText(item?.title)
    .split(/\b(?:includes?|including|plus|with)\b|\bw\//i, 1)[0]
    .replace(/\b(?:item )?(?:does not power on|for parts(?: or repair)?|as is)\b.*$/i, "");
  const tokens = usefulTokens(coreTitle);
  let modelIndex = -1;
  let includeVariant = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/[a-z]/.test(token)
      && /\d/.test(token)
      && !/^\d+(?:lb|lbs|g|kg|oz|ct|ctw|mm|cm|in|ft|v|ah|w|x)$/.test(token)
      && !/^(?:18|19|20)\d{2}s?$/.test(token)) {
      modelIndex = index;
      includeVariant = true;
      break;
    }
    if (/^\d{1,6}[a-z]?$/.test(token) && MODEL_PREFIXES.has(tokens[index - 1] || "")) {
      modelIndex = index;
      includeVariant = true;
      break;
    }
    if (/^\d{2,6}[a-z]?$/.test(token)
      && index > 0
      && new RegExp(`\\b${tokens[index - 1]}-${token}\\b`, "i").test(coreTitle)) {
      modelIndex = index;
      break;
    }
  }
  const selected = modelIndex >= 0
    ? tokens.slice(0, Math.min(tokens.length, modelIndex + (includeVariant ? 2 : 1), 6))
    : tokens.slice(0, 5);
  return selected.join(" ").slice(0, 100);
}

export function queryForItem(item) {
  const identifier = identifiersFrom(item)[0];
  if (identifier) return { type: "identifier", value: identifier, key: `identifier:${identifier}` };
  const value = titleQueryFor(item);
  return value ? { type: "title", value, key: `title:${value.toLowerCase()}` } : null;
}

function verticalFor(item) {
  return cleanText(item?.resaleVertical)
    || cleanText(item?.category).split(">").map((part) => part.trim()).filter(Boolean)[0]
    || "Other";
}

function attemptAt(item) {
  const direct = Date.parse(item?.freeRetailMarket?.lastAttempt?.asOf || item?.freeRetailMarket?.asOf || "");
  return Number.isFinite(direct) ? direct : 0;
}

function targetPriority(item, nowMs) {
  const end = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(end) ? Math.max(0, (end - nowMs) / 3_600_000) : 9_999;
  const identity = identifiersFrom(item).length ? 900 : hasStrongModelSignal(item?.title) ? 500 : 100;
  return identity + Math.min(250, Number(item?.bidCount) || 0) + Math.max(0, 200 - hours);
}

function isRecentAttempt(item, nowMs) {
  const attempted = attemptAt(item);
  return attempted > 0 && nowMs - attempted < ATTEMPT_FRESH_MS;
}

export function selectTargetGroups(items, limit = DEFAULT_DAILY_TITLE_SEARCHES, nowMs = Date.now()) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status !== "active" || !isCatalogCandidate(item) || isRecentAttempt(item, nowMs)) continue;
    const closesAt = Date.parse(item?.endsAt || "");
    if (Number.isFinite(closesAt) && closesAt <= nowMs) continue;
    const query = queryForItem(item);
    if (!query) continue;
    if (!grouped.has(query.key)) grouped.set(query.key, { query, members: [] });
    grouped.get(query.key).members.push(item);
  }
  const buckets = new Map();
  for (const group of grouped.values()) {
    group.members.sort((left, right) => targetPriority(right, nowMs) - targetPriority(left, nowMs));
    group.representative = group.members[0];
    const vertical = verticalFor(group.representative);
    if (!buckets.has(vertical)) buckets.set(vertical, []);
    buckets.get(vertical).push(group);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => {
      const age = attemptAt(left.representative) - attemptAt(right.representative);
      return age || targetPriority(right.representative, nowMs) - targetPriority(left.representative, nowMs);
    });
  }
  const selected = [];
  const queues = [...buckets.values()];
  while (selected.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (selected.length >= limit) break;
      const group = queue.shift();
      if (group) selected.push(group);
    }
  }
  return selected;
}

function sharedCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function brandConflict(target, candidate) {
  const targetBrand = usefulTokens(target?.brand);
  const candidateBrand = usefulTokens(candidate?.brand);
  if (!targetBrand.length || !candidateBrand.length) return false;
  return sharedCount(targetBrand, candidateBrand) === 0;
}

function modelConflict(target, candidate) {
  const targetModels = modelKeys(`${target?.title || ""} ${target?.model || ""}`);
  const candidateModels = modelKeys(`${candidate?.title || ""} ${candidate?.model || ""}`);
  if (!targetModels.size || !candidateModels.size) return false;
  const targetPairs = new Map([...targetModels]
    .filter((model) => model.includes(":"))
    .map((model) => model.split(":", 2)));
  const candidatePairs = new Map([...candidateModels]
    .filter((model) => model.includes(":"))
    .map((model) => model.split(":", 2)));
  for (const [prefix, value] of targetPairs) {
    if (candidatePairs.has(prefix) && candidatePairs.get(prefix) !== value) return true;
  }
  return ![...targetModels].some((model) => candidateModels.has(model));
}

export function assessIdentity(target, candidate, query) {
  const targetIdentifiers = new Set(identifiersFrom(target));
  const candidateIdentifiers = new Set(identifiersFrom(candidate));
  const identifierMatch = [...targetIdentifiers].some((identifier) => candidateIdentifiers.has(identifier))
    || (query?.type === "identifier" && candidateIdentifiers.has(query.value));
  if (brandConflict(target, candidate)) return { accepted: false, score: 0, reason: "Conflicting product brand" };
  if (modelConflict(target, candidate)) return { accepted: false, score: 0, reason: "Conflicting product model or generation" };
  if (query?.type === "identifier" && !identifierMatch) {
    return { accepted: false, score: 0, reason: "Catalog response did not confirm the requested identifier" };
  }
  const targetTokens = usefulTokens(target?.title);
  const candidateTokens = usefulTokens(candidate?.title);
  const candidateBrand = usefulTokens(candidate?.brand);
  if (!identifierMatch && candidateBrand.length && sharedCount(candidateBrand, targetTokens) === 0) {
    return { accepted: false, score: 0, reason: "Catalog brand is not present in the auction title" };
  }
  const shared = sharedCount(targetTokens, candidateTokens);
  const coverage = targetTokens.length ? shared / targetTokens.length : 0;
  const candidateCoverage = candidateTokens.length ? shared / candidateTokens.length : 0;
  const modelMatch = (() => {
    const left = modelKeys(`${target?.title || ""} ${target?.model || ""}`);
    const right = modelKeys(`${candidate?.title || ""} ${candidate?.model || ""}`);
    return left.size && [...left].some((model) => right.has(model));
  })();
  const accepted = identifierMatch || (shared >= 3 && coverage >= 0.5 && candidateCoverage >= 0.35) || (modelMatch && shared >= 2);
  const score = identifierMatch
    ? 100
    : Math.round(Math.min(99, coverage * 65 + candidateCoverage * 20 + (modelMatch ? 15 : 0)) * 100) / 100;
  return {
    accepted,
    score,
    reason: accepted ? "Strict title and model identity match" : "Insufficient title identity overlap",
    matchedBy: identifierMatch ? "catalog identifier" : modelMatch ? "title and model" : "strict title",
  };
}

function sourceUpdatedAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function unavailable(value) {
  return /out\s*of\s*stock|unavailable|sold\s*out|discontinued/i.test(cleanText(value));
}

function normalizeOffer(offer, observedAt, maximumAgeDays) {
  const currency = cleanText(offer?.currency, "USD").toUpperCase();
  const price = money(offer?.price);
  const link = httpUrl(offer?.link);
  if (currency !== "USD" || !price || !link) return null;
  const shipping = money(offer?.shipping) ?? 0;
  const updatedAt = sourceUpdatedAt(offer?.updated_t || offer?.updatedAt);
  const ageDays = updatedAt ? Math.max(0, (Date.parse(observedAt) - Date.parse(updatedAt)) / 86_400_000) : null;
  const available = !unavailable(offer?.availability);
  const isCurrent = available && ageDays !== null && ageDays <= maximumAgeDays;
  const domain = cleanText(offer?.domain);
  const merchant = cleanText(offer?.merchant, domain || "merchant");
  return {
    id: `${domain || merchant}|${link}`.slice(0, 500),
    title: cleanText(offer?.title).slice(0, 500),
    merchant: merchant.slice(0, 160),
    source: merchant.slice(0, 160),
    domain: domain.slice(0, 200),
    url: link,
    currency: "USD",
    price,
    listPrice: money(offer?.list_price),
    shipping,
    totalPrice: Math.round((price + shipping) * 100) / 100,
    condition: cleanText(offer?.condition, "Not stated").slice(0, 100),
    availability: cleanText(offer?.availability, "Not stated").slice(0, 160),
    sourceUpdatedAt: updatedAt,
    observedAt,
    ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
    freshness: isCurrent ? "current" : updatedAt ? "stale" : "unknown",
    isCurrent,
    evidenceType: "active-merchant-asking-price",
    listingState: "merchant asking offer; not a completed sale",
  };
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
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
}

function normalizedCatalog(candidate, identity, evidence) {
  const ids = identifiersFrom(candidate);
  const primaryIdentifier = cleanText(candidate?.upc || candidate?.ean || candidate?.gtin || candidate?.isbn || ids[0]);
  const sourceUrl = primaryIdentifier
    ? `https://www.upcitemdb.com/upc/${encodeURIComponent(primaryIdentifier)}`
    : "https://www.upcitemdb.com/";
  return {
    title: cleanText(candidate?.title).slice(0, 500),
    brand: cleanText(candidate?.brand).slice(0, 160),
    model: cleanText(candidate?.model).slice(0, 160),
    category: cleanText(candidate?.category).slice(0, 300),
    identifiers: {
      upc: cleanText(candidate?.upc),
      ean: cleanText(candidate?.ean),
      gtin: cleanText(candidate?.gtin),
      asin: cleanText(candidate?.asin),
      all: ids,
    },
    images: (Array.isArray(candidate?.images) ? candidate.images : []).map(httpUrl).filter(Boolean).slice(0, 8),
    matchScore: identity.score,
    matchedBy: identity.matchedBy,
    matchTier: identity.matchedBy === "catalog identifier"
      ? "exact-upc-gtin"
      : identity.matchedBy === "title and model" ? "exact-model" : "strict-title",
    evidenceType: evidence.evidenceType,
    sampleSize: evidence.sampleSize,
    sourceCount: evidence.sourceCount,
    priceLow: evidence.priceLow,
    priceMedian: evidence.priceMedian,
    priceAverage: evidence.priceAverage,
    priceHigh: evidence.priceHigh,
    planningReservePercent: evidence.planningReservePercent,
    sourceUrl,
  };
}

function historicalReference(candidate, observedAt) {
  const currency = cleanText(candidate?.currency, "USD").toUpperCase();
  if (currency !== "USD") return null;
  const priceLow = money(candidate?.lowest_recorded_price);
  const priceHigh = money(candidate?.highest_recorded_price);
  if (!priceLow && !priceHigh) return null;
  return {
    currency: "USD",
    priceLow,
    priceHigh,
    observedAt,
    evidenceType: "catalog historical recorded range",
    note: "UPCitemdb historical recorded prices are kept separate from current merchant offers and are not completed-sale evidence.",
  };
}

function insufficientMarket(query, observedAt, reason, extra = {}) {
  return {
    status: "insufficient",
    provider: PROVIDER,
    channel: "UPCitemdb free catalog and merchant offers",
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    query: { type: query.type, value: query.value },
    catalog: null,
    offers: [],
    priceSummary: {
      currentOfferCount: 0,
      sourceCount: 0,
      priceLow: null,
      priceMedian: null,
      priceAverage: null,
      priceHigh: null,
    },
    historicalReference: null,
    reason,
    note: "No retail value is asserted without a strict catalog identity match and auditable USD price evidence.",
    ...extra,
  };
}

export function marketFromPayload(target, query, payload, observedAt = new Date().toISOString(), maximumAgeDays = DEFAULT_FRESH_DAYS) {
  const candidates = Array.isArray(payload?.items) ? payload.items : [];
  const assessed = candidates
    .map((candidate) => ({ candidate, identity: assessIdentity(target, candidate, query) }))
    .filter((entry) => entry.identity.accepted)
    .sort((left, right) => right.identity.score - left.identity.score);
  if (!assessed.length) {
    return insufficientMarket(query, observedAt, candidates.length
      ? "UPCitemdb results conflicted with or did not strictly match this listing's product identity"
      : "UPCitemdb returned no matching catalog product");
  }
  const { candidate, identity } = assessed[0];
  const deduplicated = new Map();
  for (const rawOffer of Array.isArray(candidate?.offers) ? candidate.offers : []) {
    const offer = normalizeOffer(rawOffer, observedAt, maximumAgeDays);
    if (!offer) continue;
    const key = `${offer.url.toLowerCase()}|${offer.totalPrice}`;
    if (!deduplicated.has(key)) deduplicated.set(key, offer);
  }
  const offers = [...deduplicated.values()];
  const current = offers.filter((offer) => offer.isCurrent);
  const sources = new Set(current.map((offer) => cleanText(offer.domain || offer.merchant).toLowerCase()).filter(Boolean));
  const totals = current.map((offer) => offer.totalPrice);
  const history = historicalReference(candidate, observedAt);
  const status = current.length >= 2 && sources.size >= 2
    ? "available"
    : current.length || offers.length || history ? "reference-only" : "insufficient";
  const evidence = totals.length ? {
    evidenceType: "current-retail-merchant-offers",
    sampleSize: current.length,
    sourceCount: sources.size,
    priceLow: quantile(totals, 0),
    priceMedian: quantile(totals, 0.5),
    priceAverage: average(totals),
    priceHigh: quantile(totals, 1),
    planningReservePercent: current.length >= 2 && sources.size >= 2 ? 55 : 65,
  } : {
    evidenceType: "retail-catalog-identity-only",
    sampleSize: 0,
    sourceCount: 0,
    priceLow: null,
    priceMedian: null,
    priceAverage: null,
    priceHigh: null,
    planningReservePercent: 75,
  };
  const offerMatchTier = identity.matchedBy === "catalog identifier"
    ? "exact-upc-gtin"
    : identity.matchedBy === "title and model" ? "exact-model" : "strict-title";
  for (const offer of offers) {
    offer.matchScore = identity.score;
    offer.matchTier = offerMatchTier;
  }
  return {
    status,
    provider: PROVIDER,
    channel: "UPCitemdb free catalog and merchant offers",
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    query: { type: query.type, value: query.value },
    catalog: normalizedCatalog(candidate, identity, evidence),
    offers,
    priceSummary: {
      currentOfferCount: current.length,
      sourceCount: sources.size,
      priceLow: quantile(totals, 0),
      priceMedian: quantile(totals, 0.5),
      priceAverage: average(totals),
      priceHigh: quantile(totals, 1),
    },
    historicalReference: history,
    ...(status === "insufficient" ? { reason: "The matched catalog product had no usable USD merchant or historical price evidence" } : {}),
    note: status === "available"
      ? "Current auditable merchant asking offers; they are retail references, not completed sales or guaranteed resale proceeds."
      : "Reference-only catalog evidence. Stale offers and historical ranges remain visible for audit but never become the current retail midpoint, a safe bid, or completed-sale value.",
  };
}

async function requestCatalog(query) {
  const endpoint = new URL(`${API_ROOT}/${query.type === "identifier" ? "lookup" : "search"}`);
  endpoint.searchParams.set(query.type === "identifier" ? "upc" : "s", query.value);
  if (query.type === "title") {
    endpoint.searchParams.set("type", "product");
    endpoint.searchParams.set("match_mode", "0");
  }
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const error = new Error(`UPCitemdb request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.retryAfter = cleanText(response.headers?.get?.("retry-after"));
    throw error;
  }
  return response.json();
}

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
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

function statusRank(value) {
  return { insufficient: 0, "reference-only": 1, available: 2 }[value] ?? 0;
}

function retainBetterEvidence(existing, attempted) {
  if (!existing || statusRank(attempted?.status) >= statusRank(existing?.status)) return attempted;
  return {
    ...existing,
    lastAttempt: {
      asOf: attempted.asOf,
      status: attempted.status,
      query: attempted.query,
      reason: attempted.reason || "The latest lookup produced weaker evidence than the retained retail reference",
    },
  };
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function runState(envelope, date) {
  const prior = envelope?.freeRetailEnrichment;
  return prior?.provider === PROVIDER && prior?.utcDay === utcDay(date)
    ? { ...prior }
    : { provider: PROVIDER, utcDay: utcDay(date), titleSearches: 0, identifierLookups: 0, requests: 0 };
}

export async function runEnrichment({ path = outputPath } = {}) {
  const loaded = await readEnvelope(path);
  if (!loaded) {
    console.log("No-op: data/live-snapshots.js does not exist yet.");
    return { changed: 0, requested: 0, missing: true };
  }
  const { source, envelope } = loaded;
  const now = nowDate();
  const observedAt = now.toISOString();
  const dailyLimit = Math.min(DEFAULT_DAILY_TITLE_SEARCHES, positiveInteger(
    process.env.BIDAI_FREE_RETAIL_MAX_TITLE_SEARCHES || process.env.BIDAI_FREE_RETAIL_MAX_SEARCHES,
    DEFAULT_DAILY_TITLE_SEARCHES,
  ));
  const delayMs = nonNegativeInteger(process.env.BIDAI_FREE_RETAIL_DELAY_MS, DEFAULT_DELAY_MS);
  const maximumAgeDays = positiveInteger(process.env.BIDAI_FREE_RETAIL_OFFER_MAX_AGE_DAYS, DEFAULT_FRESH_DAYS);
  const state = runState(envelope, now);
  const titleRemaining = Math.max(0, dailyLimit - (Number(state.titleSearches) || 0));
  const requestLimit = Math.max(1, positiveInteger(process.env.BIDAI_FREE_RETAIL_BATCH_SIZE, dailyLimit));
  const candidates = selectTargetGroups(envelope.items, Math.max(requestLimit, dailyLimit), now.getTime());
  const groups = [];
  let titleSlots = titleRemaining;
  for (const group of candidates) {
    if (groups.length >= requestLimit) break;
    if (group.query.type === "title") {
      if (titleSlots <= 0) continue;
      titleSlots -= 1;
    }
    groups.push(group);
  }
  if (!groups.length) {
    console.log(titleRemaining <= 0
      ? `No-op: the free UPCitemdb daily title-search limit (${dailyLimit}) has been reached.`
      : "No-op: no active catalog-price groups currently need a lookup.");
    return { changed: 0, requested: 0 };
  }

  const updates = new Map();
  let requested = 0;
  let rateLimited = false;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (index > 0) await sleep(delayMs);
    requested += 1;
    state.requests = (Number(state.requests) || 0) + 1;
    if (group.query.type === "title") state.titleSearches = (Number(state.titleSearches) || 0) + 1;
    else state.identifierLookups = (Number(state.identifierLookups) || 0) + 1;
    try {
      const payload = await requestCatalog(group.query);
      for (const member of group.members) updates.set(member.id, marketFromPayload(member, group.query, payload, observedAt, maximumAgeDays));
    } catch (error) {
      const reason = error.status === 429
        ? "UPCitemdb free API rate limit reached before this product could be priced"
        : `UPCitemdb lookup failed: ${error.message}`;
      for (const member of group.members) updates.set(member.id, insufficientMarket(group.query, observedAt, reason));
      if (error.status === 429) {
        rateLimited = true;
        state.rateLimitedAt = observedAt;
        state.retryAfter = error.retryAfter || null;
        console.warn(`${error.message} Remaining free retail lookups were skipped.`);
        break;
      }
      console.warn(`Free retail lookup skipped for ${cleanText(group.representative?.id, "listing")}: ${error.message}`);
    }
  }

  let changed = 0;
  envelope.items = envelope.items.map((item) => {
    const attempted = updates.get(item.id);
    if (!attempted) return item;
    changed += 1;
    return {
      ...item,
      freeRetailMarket: retainBetterEvidence(item.freeRetailMarket, attempted),
    };
  });
  envelope.freeRetailEnrichment = { ...state, lastRunAt: observedAt };
  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource !== source) await writeEnvelope(envelope, path);
  const available = [...updates.values()].filter((market) => market.status === "available").length;
  const references = [...updates.values()].filter((market) => market.status === "reference-only").length;
  console.log(`UPCitemdb reviewed ${changed} listing${changed === 1 ? "" : "s"} across ${requested} catalog request${requested === 1 ? "" : "s"}; ${available} received multi-merchant current retail evidence and ${references} received catalog-only or historical references${rateLimited ? " before rate limiting stopped the run" : ""}.`);
  return { changed, requested, available, references, rateLimited };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runEnrichment();
}
