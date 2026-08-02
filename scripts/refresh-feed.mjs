import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const AUTHORIZED_VALUE = "true";
const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const MAX_HISTORY_POINTS = 250;
const MAX_COMPARABLES = 50;
const APIFY_PAGE_SIZE = 5_000;
const MAX_RETAINED_ITEMS = 50_000;
const MAX_RESPONSE_BYTES = 20_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const APIFY_API_ORIGIN = "https://api.apify.com";
const SHOPGOODWILL_API_ORIGIN = "https://buyerapi.shopgoodwill.com";
const SHOPGOODWILL_SEARCH_PATH = "/api/Search/ItemListing";
const SHOPGOODWILL_ITEM_PATH = "/api/ItemDetail/GetItemDetailModelByItemId/";
const SHOPGOODWILL_PAGE_SIZE = 40;
const SHOPGOODWILL_MAX_CATALOG_ITEMS = 10_000;
const SHOPGOODWILL_REQUEST_CONCURRENCY = 4;
const SHOPGOODWILL_PRIORITY_SEARCH_LIMIT = 200;
const SHOPGOODWILL_PRIORITY_SEARCHES = [
  "authenticated sneakers",
  "shoes",
  "watches",
  "rings",
  "hats",
  "collectibles",
  "electronics",
];
const VERIFIED_FORECAST_STATUSES = new Set(["available", "ready", "verified"]);
const SOURCE_DOMAINS = [
  ["shopgoodwill.com", "shopgoodwill"],
  ["ebay.com", "ebay"],
  ["hibid.com", "hibid"],
  ["liveauctioneers.com", "liveauctioneers"],
  ["invaluable.com", "invaluable"],
  ["govdeals.com", "govdeals"],
  ["publicsurplus.com", "publicsurplus"],
  ["propertyroom.com", "propertyroom"],
  ["proxibid.com", "proxibid"],
  ["bidspotter.com", "bidspotter"],
];

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repositoryRoot, "data");
const outputPath = join(outputDirectory, "live-snapshots.js");

function pick(record, ...keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function hasOwn(record, ...keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record || {}, key));
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function money(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : fallback;
  }

  const raw = String(value).trim();
  const negativeAccounting = /^\(.*\)$/.test(raw);
  const parsed = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed) || negativeAccounting || parsed < 0) return fallback;
  return Math.round(parsed * 100) / 100;
}

function ratio(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  let parsed = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return fallback;
  if (raw.includes("%") || parsed > 1) parsed /= 100;
  return Math.min(1, Math.max(0, Math.round(parsed * 10_000) / 10_000));
}

function percentage(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  let parsed = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return fallback;
  if (!raw.includes("%") && parsed > 0 && parsed <= 1) parsed *= 100;
  return Math.min(100, Math.max(0, Math.round(parsed * 10_000) / 10_000));
}

function score(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function nonnegativeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed * 10_000) / 10_000;
}

function timestamp(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  let candidate = value;
  if (typeof candidate === "number" && candidate > 0 && candidate < 10_000_000_000) {
    candidate *= 1000;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeSourceKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sourceKeyFor(record, url, fallback = "authorized-feed") {
  const explicit = normalizeSourceKey(pick(
    record,
    "sourceKey",
    "source_key",
    "marketplaceKey",
    "marketplace_key",
    "marketplace",
  ));
  if (explicit) return explicit;
  const normalizedUrl = httpUrl(url || pick(record, "url", "sourceUrl", "source_url", "listingUrl", "listing_url"));
  if (normalizedUrl) {
    const hostname = new URL(normalizedUrl).hostname.toLowerCase().replace(/^www\./, "");
    const known = SOURCE_DOMAINS.find(([domain]) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (known) return known[1];
    const hostKey = normalizeSourceKey(hostname.split(".").slice(-2, -1)[0] || hostname);
    if (hostKey) return hostKey;
  }
  return normalizeSourceKey(fallback) || "authorized-feed";
}

function comparableCurrency(value) {
  return text(pick(value, "currency", "currencyCode", "currency_code", "priceCurrency", "price_currency")).toUpperCase();
}

function normalizeComparable(value, kind, fallbackSource) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currency = comparableCurrency(value);
  if (currency && currency !== "USD") return null;

  const title = text(pick(value, "title", "name", "listingTitle", "listing_title")).slice(0, 500);
  const price = money(pick(value, "price", "finalPrice", "final_price", "soldPrice", "sold_price"), null);
  if (!title || !(price > 0)) return null;

  const endedAt = timestamp(pick(value, "endedAt", "ended_at", "soldAt", "sold_at", "endTime", "end_time"));
  const source = text(pick(value, "source", "sourceName", "source_name"), fallbackSource).slice(0, 200);
  const url = httpUrl(pick(value, "url", "sourceUrl", "source_url", "listingUrl", "listing_url"));
  const externalId = text(pick(value, "externalId", "external_id", "listingId", "listing_id", "auctionId", "auction_id", "itemId", "item_id", "id")).slice(0, 200);
  return {
    id: externalId || null,
    externalId: externalId || null,
    title,
    price,
    finalPrice: kind === "auction" ? price : null,
    soldPrice: kind === "sale" ? price : null,
    endedAt,
    soldAt: kind === "sale" ? endedAt : null,
    url,
    outcomeObservedAt: timestamp(pick(value, "outcomeObservedAt", "outcome_observed_at", "finalObservedAt", "final_observed_at", "capturedAt", "captured_at", "observedAt", "observed_at")),
    source,
    modelKey: text(pick(value, "modelKey", "model_key", "compGroup", "comp_group", "similarItemKey", "similar_item_key")).slice(0, 200),
    matchReason: text(pick(value, "matchReason", "match_reason")).slice(0, 500),
    matchScore: percentage(pick(value, "matchScore", "match_score", "similarityScore", "similarity_score"), null),
    bidAtComparableTime: money(pick(value, "bidAtComparableTime", "bid_at_comparable_time"), null),
    hoursToClose: nonnegativeNumber(pick(value, "hoursToClose", "hours_to_close"), null),
  };
}

function normalizeComparables(value, kind, fallbackSource) {
  if (!Array.isArray(value)) return [];
  return value
    .map((comparable) => normalizeComparable(comparable, kind, fallbackSource))
    .filter(Boolean)
    .slice(0, MAX_COMPARABLES);
}

function mergeComparableEvidence(...collections) {
  const byStableKey = new Map();
  for (const collection of collections) {
    for (const comparable of Array.isArray(collection) ? collection : []) {
      if (!comparable || typeof comparable !== "object") continue;
      const key = comparableOutcomeKey(comparable);
      const existing = byStableKey.get(key);
      if (!existing) {
        byStableKey.set(key, comparable);
        continue;
      }

      const existingKnownTime = Date.parse(existing.outcomeObservedAt || "");
      const incomingKnownTime = Date.parse(comparable.outcomeObservedAt || "");
      const incomingIsEarlier = Number.isFinite(incomingKnownTime)
        && (!Number.isFinite(existingKnownTime) || incomingKnownTime < existingKnownTime);
      const preferred = incomingIsEarlier ? comparable : existing;
      const fallback = incomingIsEarlier ? existing : comparable;
      const merged = { ...fallback, ...preferred };
      for (const [field, value] of Object.entries(fallback)) {
        if (!supplied(preferred[field]) && supplied(value)) merged[field] = value;
      }
      const earliestKnownTime = [existingKnownTime, incomingKnownTime]
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      merged.outcomeObservedAt = Number.isFinite(earliestKnownTime)
        ? new Date(earliestKnownTime).toISOString()
        : null;
      byStableKey.set(key, merged);
    }
  }

  return [...byStableKey.values()].slice(-MAX_COMPARABLES);
}

function normalizedModelKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([:|/])\s*/g, "$1");
}

function comparableOutcomeKey(comparable) {
  const stableId = text(pick(comparable, "externalId", "id")).toLowerCase();
  if (stableId) return `id:${text(comparable?.source).toLowerCase()}:${stableId}`;
  const url = httpUrl(comparable?.url);
  if (url) return `url:${url.toLowerCase()}`;
  return [
    normalizedModelKey(comparable?.modelKey),
    text(comparable?.title).toLowerCase(),
    money(pick(comparable, "price", "finalPrice", "soldPrice"), null),
    timestamp(pick(comparable, "endedAt", "soldAt")),
    text(comparable?.source).toLowerCase(),
  ].join("|");
}

function eligibleDatedComparables(comparables, cutoff, requiredModelKey = "") {
  const cutoffTime = Date.parse(cutoff || "");
  if (!Number.isFinite(cutoffTime)) return [];
  const requiredKey = normalizedModelKey(requiredModelKey);
  const deduplicated = new Map();
  for (const comparable of Array.isArray(comparables) ? comparables : []) {
    const endedAt = timestamp(pick(comparable, "endedAt", "soldAt"));
    const endedTime = Date.parse(endedAt || "");
    const price = money(pick(comparable, "price", "finalPrice", "soldPrice"), null);
    const outcomeObservedTime = Date.parse(comparable?.outcomeObservedAt || "");
    if (!Number.isFinite(endedTime) || endedTime > cutoffTime || !(price > 0)) continue;
    if (!Number.isFinite(outcomeObservedTime) || outcomeObservedTime > cutoffTime) continue;
    if (requiredKey && normalizedModelKey(comparable?.modelKey) !== requiredKey) continue;
    if (requiredKey && !(percentage(comparable?.matchScore, null) >= 75)) continue;
    if (requiredKey && !pick(comparable, "externalId", "id") && !httpUrl(comparable?.url)) continue;
    const normalized = { ...comparable, price, endedAt };
    const key = comparableOutcomeKey(normalized);
    if (!deduplicated.has(key)) deduplicated.set(key, normalized);
  }
  return [...deduplicated.values()];
}

function comparableRanges(comparableSales) {
  const prices = comparableSales
    .map((comparable) => comparable.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (prices.length < 3) return null;
  return {
    low: quantile(prices, 0.2),
    median: quantile(prices, 0.5),
    high: quantile(prices, 0.8),
  };
}

function supplied(value) {
  return value !== undefined && value !== null && value !== "";
}

function boolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function normalizePurity(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, "");
  if (/^14k(?:t)?$/.test(raw)) return "14k";
  const parsed = Number.parseFloat(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  if (Math.abs(parsed - 14) <= 0.01) return "14k";
  if (Math.abs(parsed - 0.585) <= 0.005) return "14k";
  if (Math.abs(parsed - 58.5) <= 0.5) return "14k";
  return null;
}

function normalizeGramUnit(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, " ");
  return ["g", "gram", "grams", "per gram", "usd/g", "$/g"].includes(raw) ? "gram" : null;
}

function normalizeValuationBasis(value, observedAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const referenceObservedAt = timestamp(pick(
    value,
    "referenceObservedAt",
    "reference_observed_at",
    "quoteObservedAt",
    "quote_observed_at",
  ));
  const referenceTime = Date.parse(referenceObservedAt || "");
  const observationTime = Date.parse(observedAt || "");
  const currency = text(pick(value, "currency", "currencyCode", "currency_code")).toUpperCase();
  const unit = normalizeGramUnit(pick(value, "unit", "weightUnit", "weight_unit", "referenceUnit", "reference_unit"));
  const purity = normalizePurity(pick(value, "purity", "karat", "karats"));
  const grossWeightGrams = nonnegativeNumber(pick(
    value,
    "grossWeightGrams",
    "gross_weight_grams",
    "grossWeight",
    "gross_weight",
    "weightGrams",
    "weight_grams",
  ), null);
  const reference14kMeltPerGram = money(pick(
    value,
    "reference14kMeltPerGram",
    "reference_14k_melt_per_gram",
    "meltPerGram",
    "melt_per_gram",
  ), null);
  if (!Number.isFinite(referenceTime)
    || !Number.isFinite(observationTime)
    || referenceTime > observationTime
    || currency !== "USD"
    || unit !== "gram"
    || purity !== "14k"
    || !(grossWeightGrams > 0)
    || !(reference14kMeltPerGram > 0)) return null;

  return {
    referenceObservedAt,
    currency: "USD",
    unit: "gram",
    purity: "14k",
    grossWeight: grossWeightGrams,
    grossWeightGrams,
    reference14kMeltPerGram,
    source: text(pick(value, "source", "sourceName", "source_name")).slice(0, 200),
    sourceUrl: httpUrl(pick(value, "sourceUrl", "source_url", "url")),
  };
}

function normalizeForecast(value, context = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currency = comparableCurrency(value);
  if (currency && currency !== "USD") return null;

  const sampleSize = integer(pick(value, "sampleSize", "sample_size", "compCount", "comp_count"), 0);
  const exactModelCount = Math.min(
    sampleSize,
    integer(pick(value, "exactModelCount", "exact_model_count"), 0),
  );
  const suppliedStatus = text(pick(value, "status", "state"))
    .toLowerCase()
    .slice(0, 80);
  const asOf = timestamp(pick(value, "asOf", "as_of", "observedAt", "observed_at"));
  const modelVersion = text(pick(value, "modelVersion", "model_version", "version")).slice(0, 120);
  const expected = money(pick(value, "expected", "expectedClose", "expected_close"), null);
  const low = money(pick(value, "low", "lower", "lowerBound", "lower_bound"), null);
  const high = money(pick(value, "high", "upper", "upperBound", "upper_bound"), null);
  const observationTime = Date.parse(context.observedAt || "");
  const asOfTime = Date.parse(asOf || "");
  const currentBid = money(context.currentBid, null);
  const timestampAligned = Number.isFinite(asOfTime)
    && (!Number.isFinite(observationTime)
      || (asOfTime <= observationTime + 5 * 60_000
        && observationTime - asOfTime <= 2 * 60 * 60_000));
  const intervalCoherent = low > 0 && expected >= low && high >= expected;
  const clearsCurrentBid = currentBid === null || low >= currentBid;
  const verified = sampleSize >= 5
    && exactModelCount >= 5
    && VERIFIED_FORECAST_STATUSES.has(suppliedStatus)
    && Boolean(modelVersion)
    && timestampAligned
    && intervalCoherent
    && clearsCurrentBid;
  const reasonCodes = pick(value, "reasonCodes", "reason_codes", "reasons");
  const rawEvidenceIds = pick(value, "evidenceIds", "evidence_ids", "cohortIds", "cohort_ids");
  const evidenceIds = [...new Set((Array.isArray(rawEvidenceIds) ? rawEvidenceIds : [])
    .map((identifier) => text(identifier).slice(0, 500))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_HISTORY_POINTS);
  const suppliedEvidenceHash = text(pick(value, "evidenceHash", "evidence_hash")).toLowerCase();
  const evidenceHash = evidenceIds.length
    ? digest(evidenceIds.join("\n"))
    : (/^[a-f0-9]{64}$/.test(suppliedEvidenceHash) ? suppliedEvidenceHash : null);
  return {
    status: verified ? suppliedStatus : "insufficient-data",
    asOf,
    modelVersion,
    expected: verified ? expected : null,
    low: verified ? low : null,
    high: verified ? high : null,
    sampleSize,
    exactModelCount,
    curveCount: integer(pick(value, "curveCount", "curve_count"), null),
    confidence: ratio(pick(value, "confidence", "forecastConfidence", "forecast_confidence"), null),
    method: text(pick(value, "method", "forecastMethod", "forecast_method")).slice(0, 200),
    reasonCodes: (Array.isArray(reasonCodes) ? reasonCodes : [])
      .map((reason) => text(reason).slice(0, 120))
      .filter(Boolean)
      .slice(0, 20),
    ...(evidenceIds.length ? { evidenceIds } : {}),
    ...(evidenceHash ? { evidenceHash } : {}),
  };
}

function apifyComparableArraysAreValid(record) {
  const groups = [
    [pick(record, "comparableSales", "comparable_sales", "soldComparables", "sold_comparables"), "sale"],
    [pick(record, "auctionComparables", "auction_comparables", "auctionComps", "auction_comps"), "auction"],
  ];
  return groups.every(([collection, kind]) => {
    if (collection === undefined) return true;
    if (!Array.isArray(collection)) return false;
    return collection.every((comparable) => normalizeComparable(comparable, kind, "Apify dataset"));
  });
}

function apifyForecastIsValid(record) {
  const value = pick(record, "forecast", "verifiedForecast", "verified_forecast");
  if (value === undefined) return true;
  return Boolean(normalizeForecast(value));
}

async function readJsonResponse(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("The authorized feed response exceeds the 20 MB limit.");
  }
  if (!response.body) return response.json();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The authorized feed response exceeds the 20 MB limit.");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(combined));
}

async function fetchJson(url, requestConfiguration) {
  let response;
  try {
    response = await fetch(url, {
      headers: requestConfiguration.headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The authorized feed request failed.");
  }
  if (!response.ok) throw new Error(`The authorized feed returned HTTP ${response.status}.`);
  try {
    return await readJsonResponse(response);
  } catch (error) {
    if (String(error?.message || "").includes("exceeds the 20 MB limit")) throw error;
    throw new Error("The authorized feed did not return valid JSON.");
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchShopGoodwillJson(path, options = {}) {
  const url = new URL(path, SHOPGOODWILL_API_ORIGIN);
  let lastStatus = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          accept: "application/json",
          origin: "https://shopgoodwill.com",
          referer: "https://shopgoodwill.com/",
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === 2) throw new Error("The ShopGoodwill public catalog request failed.");
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (response.ok) {
      try {
        return await readJsonResponse(response);
      } catch (error) {
        if (String(error?.message || "").includes("exceeds the 20 MB limit")) throw error;
        throw new Error("The ShopGoodwill public catalog did not return valid JSON.");
      }
    }
    lastStatus = response.status;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
    const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") || "", 10);
    await sleep(Number.isFinite(retryAfterSeconds)
      ? Math.min(10_000, retryAfterSeconds * 1_000)
      : 750 * (attempt + 1));
  }
  throw new Error(`The ShopGoodwill public catalog returned HTTP ${lastStatus}.`);
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function shopGoodwillSearchRequest(page, searchText = "") {
  return {
    searchText,
    selectedGroup: searchText ? "Keyword" : "",
    selectedCategoryIds: null,
    selectedSellerIds: null,
    lowPrice: "0",
    highPrice: "999999",
    searchBuyNowOnly: "0",
    searchPickupOnly: false,
    searchNoPickupOnly: false,
    searchOneCentShippingOnly: false,
    searchDescriptions: Boolean(searchText),
    searchClosedAuctions: false,
    closedAuctionEndingDate: new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }),
    closedAuctionDaysBack: "7",
    searchCanadaShipping: false,
    searchInternationalShippingOnly: false,
    sortColumn: 1,
    page,
    pageSize: SHOPGOODWILL_PAGE_SIZE,
    sortDescending: false,
    savedSearchId: 0,
    useBuyerPrefs: true,
    searchUSOnlyShipping: false,
    categoryLevelNo: 1,
    isSize: false,
    isMultipleCategoryIds: false,
    partNumber: "",
    catIds: "",
    isWeddingCatagory: false,
    sellerStore: "",
  };
}

async function fetchShopGoodwillSearchPage(page, searchText = "") {
  const payload = await fetchShopGoodwillJson(SHOPGOODWILL_SEARCH_PATH, {
    method: "POST",
    body: JSON.stringify(shopGoodwillSearchRequest(page, searchText)),
  });
  const items = payload?.searchResults?.items;
  if (!Array.isArray(items)) throw new Error("The ShopGoodwill catalog response did not include listing items.");
  return payload;
}

function zonedDateTimeToIso(value, timeZone = "America/Los_Angeles") {
  const match = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/,
  );
  if (!match) return timestamp(value);
  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond: Number(String(match[7] || "0").padEnd(3, "0")),
  };
  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
    desired.millisecond,
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let candidate = desiredAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, Number(partValue)]));
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      desired.millisecond,
    );
    candidate += desiredAsUtc - representedAsUtc;
  }
  return new Date(candidate).toISOString();
}

function shopGoodwillCategory(record) {
  const breadcrumb = Array.isArray(record?.categoryBreadCrumbs)
    ? record.categoryBreadCrumbs
        .map((entry) => text(pick(entry, "name", "label", "categoryName")))
        .filter(Boolean)
        .join(" > ")
    : "";
  return text(
    pick(record, "catFullName", "categoryFullName", "categoryName", "category", "subcategory"),
    breadcrumb || "Unclassified",
  );
}

function resaleVerticalFor(record, category) {
  const haystack = `${text(record?.title)} ${category}`.toLowerCase();
  if (/\b(shoe|shoes|sneaker|sneakers|footwear|boots?|loafers?|heels?|sandals?)\b/.test(haystack)) return "Footwear & Sneakers";
  if (/\b(watch|watches|timepiece|chronograph)\b/.test(haystack)) return "Watches";
  if (/\b(ring|rings|jewelry|jewellery|gemstone|gold|silver|diamond|bracelet|necklace|earrings?)\b/.test(haystack)) return "Rings & Jewelry";
  if (/\b(hat|hats|cap|caps|headwear|snapback|beanie)\b/.test(haystack)) return "Hats & Headwear";
  if (/\b(collectible|collectibles|memorabilia|trading card|comic|figurine|action figure|antique|vintage)\b/.test(haystack)) return "Collectibles";
  if (/\b(electronics?|computer|laptop|tablet|phone|camera|console|gaming|audio|stereo|receiver|speaker|headphones?)\b/.test(haystack)) return "Electronics";
  return "Other";
}

function authenticationFor(record) {
  const evidenceText = `${text(record?.title)} ${text(record?.description)}`;
  const match = evidenceText.match(/\b(authenticated|authentication (?:card|certificate)|certificate of authenticity|coa(?: included| attached| authenticated)?|entrupy|real authentication)\b/i);
  if (!match) return { status: "not-supplied", evidence: "No authentication evidence is supplied in the catalog record." };
  return {
    status: "source-stated",
    evidence: `The source listing states “${match[0]}”; independently verify the document and item before bidding.`,
  };
}

function shopGoodwillExactTitleModelKey(title) {
  const normalizedTitle = text(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return normalizedTitle ? `shopgoodwill:title-exact-v1:${normalizedTitle}` : "";
}

function shopGoodwillRecord(record, capturedAt, detail = false) {
  const externalId = text(pick(record, "itemId", "id"));
  if (!externalId) return null;
  const title = text(record?.title);
  if (!title) return null;
  const currentBid = money(pick(record, "currentPrice", "minimumBid", "startingPrice"));
  const endsAt = zonedDateTimeToIso(record?.endTime);
  const serverTime = zonedDateTimeToIso(record?.serverTime);
  const ended = detail && (boolean(record?.isItemEndTimeExpire, false)
    || (endsAt && serverTime && Date.parse(endsAt) <= Date.parse(serverTime)));
  const category = shopGoodwillCategory(record);
  const authentication = authenticationFor(record);
  const bids = integer(pick(record, "numBids", "numberOfBids", "bidCount"));
  const imageUrl = text(pick(record, "imageURL", "imageUrl", "thumbnailUrlString"))
    .replaceAll("\\", "/");
  return {
    externalId,
    source: "ShopGoodwill",
    sourceKey: "shopgoodwill",
    url: `https://shopgoodwill.com/item/${encodeURIComponent(externalId)}`,
    imageUrl,
    title,
    category,
    resaleVertical: resaleVerticalFor(record, category),
    modelKey: shopGoodwillExactTitleModelKey(title),
    forecastBasis: "Exact normalized ShopGoodwill title only; no broad-category or semantic substitutions.",
    authenticationStatus: authentication.status,
    authenticationEvidence: authentication.evidence,
    currentBid,
    bidCount: bids,
    endsAt,
    status: ended ? "ended" : "active",
    ...(ended && currentBid > 0 ? { finalPrice: currentBid } : {}),
    demand: Math.min(95, Math.round(35 + Math.log2(bids + 1) * 12)),
    identifiedAs: authentication.status === "source-stated"
      ? "Source-stated authentication; document and item still require independent verification"
      : "Source listing title and category; identity and authenticity are not independently verified",
    riskSummary: authentication.status === "source-stated"
      ? "Authentication wording was supplied by the source listing, not independently verified by BidAI Pro. Confirm the authenticator, item identifiers, condition, and return options."
      : "The catalog record does not supply authentication evidence. Confirm identity, condition, shipping, and return options before bidding.",
    observedAt: capturedAt,
  };
}

function deduplicateShopGoodwillRecords(records) {
  const byId = new Map();
  for (const record of records) {
    if (!record?.externalId) continue;
    const prior = byId.get(record.externalId);
    if (!prior
      || Number(record.currentBid) > Number(prior.currentBid)
      || (Number(record.currentBid) === Number(prior.currentBid) && record.status === "ended" && prior.status !== "ended")) {
      byId.set(record.externalId, record);
    }
  }
  return [...byId.values()];
}

function shopGoodwillIds(environment, name) {
  return [...new Set(String(environment[name] || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{1,20}$/.test(value)))];
}

async function fetchShopGoodwillDetails(itemIds, capturedAt) {
  if (!itemIds.length) return [];
  const payloads = await mapWithConcurrency(
    itemIds,
    SHOPGOODWILL_REQUEST_CONCURRENCY,
    (itemId) => fetchShopGoodwillJson(`${SHOPGOODWILL_ITEM_PATH}${encodeURIComponent(itemId)}`),
  );
  return payloads
    .map((record) => shopGoodwillRecord(record, capturedAt, true))
    .filter(Boolean);
}

async function fetchShopGoodwillCatalog(environment) {
  const capturedAt = new Date().toISOString();
  const catalogLimit = boundedInteger(
    environment.BIDAI_SHOPGOODWILL_CATALOG_LIMIT,
    SHOPGOODWILL_MAX_CATALOG_ITEMS,
    1,
    SHOPGOODWILL_MAX_CATALOG_ITEMS,
  );
  const priorityLimit = boundedInteger(
    environment.BIDAI_SHOPGOODWILL_PRIORITY_LIMIT,
    SHOPGOODWILL_PRIORITY_SEARCH_LIMIT,
    0,
    1_000,
  );
  const first = await fetchShopGoodwillSearchPage(1);
  const sourceCap = boundedInteger(first?.maxTotalRecords, SHOPGOODWILL_MAX_CATALOG_ITEMS, 1, SHOPGOODWILL_MAX_CATALOG_ITEMS);
  const sourceCount = boundedInteger(first?.searchResults?.itemCount, catalogLimit, 0, Number.MAX_SAFE_INTEGER);
  const broadLimit = Math.min(catalogLimit, sourceCap, sourceCount || catalogLimit);
  const broadPages = Math.max(1, Math.ceil(broadLimit / SHOPGOODWILL_PAGE_SIZE));
  const remainingPages = Array.from({ length: Math.max(0, broadPages - 1) }, (_, index) => index + 2);
  const broadPayloads = [first, ...await mapWithConcurrency(
    remainingPages,
    SHOPGOODWILL_REQUEST_CONCURRENCY,
    (page) => fetchShopGoodwillSearchPage(page),
  )];
  const broadRecords = broadPayloads
    .flatMap((payload) => payload.searchResults.items)
    .slice(0, broadLimit)
    .map((record) => shopGoodwillRecord(record, capturedAt, false))
    .filter(Boolean);

  const priorityRecords = [];
  if (priorityLimit > 0) {
    const pagesPerSearch = Math.ceil(priorityLimit / SHOPGOODWILL_PAGE_SIZE);
    const requests = SHOPGOODWILL_PRIORITY_SEARCHES.flatMap((searchText) => (
      Array.from({ length: pagesPerSearch }, (_, index) => ({ searchText, page: index + 1 }))
    ));
    const priorityPayloads = await mapWithConcurrency(
      requests,
      SHOPGOODWILL_REQUEST_CONCURRENCY,
      ({ page, searchText }) => fetchShopGoodwillSearchPage(page, searchText),
    );
    for (let searchIndex = 0; searchIndex < SHOPGOODWILL_PRIORITY_SEARCHES.length; searchIndex += 1) {
      const offset = searchIndex * pagesPerSearch;
      const records = priorityPayloads
        .slice(offset, offset + pagesPerSearch)
        .flatMap((payload) => payload.searchResults.items)
        .slice(0, priorityLimit);
      priorityRecords.push(...records
        .map((record) => shopGoodwillRecord(record, capturedAt, false))
        .filter(Boolean));
    }
  }

  const recoveryRecords = await fetchShopGoodwillDetails(
    shopGoodwillIds(environment, "BIDAI_SHOPGOODWILL_OUTCOME_IDS"),
    capturedAt,
  );
  const records = deduplicateShopGoodwillRecords([...broadRecords, ...priorityRecords, ...recoveryRecords]);
  if (!records.length) throw new Error("The ShopGoodwill public catalog contained no active bid listings.");
  return {
    generatedAt: capturedAt,
    sourceMode: "shopgoodwill-public-catalog",
    sourceNotes: [
      `Loaded ${records.length.toLocaleString("en-US")} real ShopGoodwill bid listings, ordered toward the nearest closes.`,
      `The broad search is limited to ${sourceCap.toLocaleString("en-US")} results by the source service; priority searches add footwear, watches, rings, hats, collectibles, and electronics coverage.`,
      "Authentication is never inferred: only explicit source wording is labeled as source-stated, and still requires independent verification.",
    ],
    items: records,
  };
}

async function fetchShopGoodwillItems(environment) {
  const itemIds = shopGoodwillIds(environment, "BIDAI_SHOPGOODWILL_ITEM_IDS");
  if (!itemIds.length) throw new Error("No valid ShopGoodwill item IDs were supplied for the adaptive close check.");
  const capturedAt = new Date().toISOString();
  const records = await fetchShopGoodwillDetails(itemIds, capturedAt);
  if (!records.length) throw new Error("The ShopGoodwill adaptive close check returned no listing records.");
  return {
    generatedAt: capturedAt,
    sourceMode: "shopgoodwill-adaptive-close",
    sourceNotes: [
      `Checked ${records.length.toLocaleString("en-US")} known ShopGoodwill listing${records.length === 1 ? "" : "s"} near close.`,
      "Bid observations are retained only when the observed price is strictly higher; final outcome metadata may still be recorded.",
    ],
    items: records,
  };
}

async function fetchPayload(requestConfiguration) {
  if (requestConfiguration.sourceMode === "shopgoodwill-public-catalog") {
    return requestConfiguration.shopGoodwillMode === "items"
      ? fetchShopGoodwillItems(requestConfiguration.environment)
      : fetchShopGoodwillCatalog(requestConfiguration.environment);
  }
  if (requestConfiguration.sourceMode !== "apify-dataset") {
    return fetchJson(requestConfiguration.feedUrl, requestConfiguration);
  }

  const records = [];
  for (let offset = 0; offset < MAX_RETAINED_ITEMS; offset += APIFY_PAGE_SIZE) {
    const pageUrl = new URL(requestConfiguration.feedUrl);
    if (offset) pageUrl.searchParams.set("offset", String(offset));
    const page = await fetchJson(pageUrl, requestConfiguration);
    if (!Array.isArray(page)) throw new Error("The Apify Dataset response must be a JSON array.");
    records.push(...page.slice(0, MAX_RETAINED_ITEMS - records.length));
    if (page.length < APIFY_PAGE_SIZE || records.length >= MAX_RETAINED_ITEMS) break;
  }
  return records;
}

function bearerToken(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 8_192 || /[\r\n]/.test(raw)) {
    throw new Error(`${label} is not a valid bearer token.`);
  }
  return raw;
}

function feedRequestConfiguration(environment) {
  const sourceLabelOverride = text(environment.BIDAI_SOURCE_LABEL_OVERRIDE);
  const sourceKeyOverride = normalizeSourceKey(environment.BIDAI_SOURCE_KEY_OVERRIDE);
  const apifyDatasetId = text(environment.BIDAI_APIFY_DATASET_ID);
  const shopGoodwillMode = text(environment.BIDAI_SHOPGOODWILL_MODE).toLowerCase();
  if (["catalog", "items"].includes(shopGoodwillMode)) {
    return {
      feedUrl: null,
      headers: { accept: "application/json" },
      sourceMode: "shopgoodwill-public-catalog",
      sourceLabel: "ShopGoodwill",
      sourceKey: "shopgoodwill",
      shopGoodwillMode,
      environment,
    };
  }
  if (apifyDatasetId) {
    if (!/^[a-zA-Z0-9._~-]{1,200}$/.test(apifyDatasetId)) {
      throw new Error("BIDAI_APIFY_DATASET_ID must be an Apify dataset ID or username~dataset-name.");
    }

    const feedUrl = new URL(`/v2/datasets/${encodeURIComponent(apifyDatasetId)}/items`, APIFY_API_ORIGIN);
    feedUrl.searchParams.set("format", "json");
    feedUrl.searchParams.set("clean", "true");
    feedUrl.searchParams.set("desc", "1");
    feedUrl.searchParams.set("limit", String(APIFY_PAGE_SIZE));

    const headers = { accept: "application/json" };
    const token = bearerToken(environment.BIDAI_APIFY_TOKEN, "BIDAI_APIFY_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;

    return {
      feedUrl,
      headers,
      sourceMode: "apify-dataset",
      sourceLabel: sourceLabelOverride || "Apify dataset",
      sourceKey: sourceKeyOverride || "apify-dataset",
    };
  }

  const configuredUrl = text(environment.BIDAI_FEED_URL);
  if (!configuredUrl) {
    throw new Error("Set BIDAI_APIFY_DATASET_ID or BIDAI_FEED_URL when source access is authorized.");
  }

  let feedUrl;
  try {
    feedUrl = new URL(configuredUrl);
    if (feedUrl.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new Error("BIDAI_FEED_URL must be a valid HTTPS URL.");
  }

  return {
    feedUrl,
    headers: { accept: "application/json" },
    sourceMode: "authorized-feed",
    sourceLabel: sourceLabelOverride || "Authorized feed",
    sourceKey: sourceKeyOverride || "authorized-feed",
  };
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableIdentity(record, normalized, sourceKey) {
  const suppliedId = text(pick(
    record,
    "externalId",
    "external_id",
    "listingId",
    "listing_id",
    "auctionId",
    "auction_id",
    "itemId",
    "item_id",
    "id",
  ));
  const sourceScope = normalizeSourceKey(sourceKey) || "source";
  const listingIdentity = suppliedId || normalized.url || [normalized.title, normalized.category, normalized.endsAt].join("|");
  const identitySeed = `${sourceScope}|${listingIdentity}`;
  const label = slug(`${sourceScope}-${suppliedId || normalized.title}`) || "item";
  return {
    id: `feed-${label}-${digest(identitySeed).slice(0, 12)}`,
    externalId: suppliedId || `derived-${digest(identitySeed).slice(0, 16)}`,
  };
}

function normalizeStatus(value, finalPrice, endsAt, referenceAt = null) {
  const raw = text(value, "active").toLowerCase();
  if (finalPrice > 0 || ["ended", "closed", "complete", "completed", "sold"].some((word) => raw.includes(word))) {
    return "ended";
  }
  const endTime = Date.parse(endsAt || "");
  const referenceTime = Date.parse(referenceAt || "");
  if (Number.isFinite(endTime) && Number.isFinite(referenceTime) && endTime <= referenceTime) return "ended";
  return "active";
}

function normalizeObservation(point, defaults) {
  const observedAt = timestamp(
    pick(point, "observedAt", "observed_at", "capturedAt", "captured_at", "timestamp"),
    defaults.observedAt,
  );
  if (!observedAt) return null;
  const pointCurrentBid = money(
    pick(point, "currentBid", "current_bid", "price", "bidAmount", "bid_amount"),
    defaults.currentBid,
  );
  const forecast = normalizeForecast(
    pick(point, "forecast", "verifiedForecast", "verified_forecast"),
    { observedAt, currentBid: pointCurrentBid },
  );
  const pointFinalPrice = money(pick(point, "finalPrice", "final_price", "soldPrice", "sold_price"), 0);
  const pointEndsAt = timestamp(
    pick(point, "endsAt", "ends_at", "endTime", "end_time", "closeTime", "close_time"),
    defaults.endsAt,
  );

  return {
    observedAt,
    currentBid: pointCurrentBid,
    bidCount: integer(pick(point, "bidCount", "bid_count", "bids"), defaults.bidCount),
    expectedClose: money(pick(point, "expectedClose", "expected_close", "predictedFinal", "predicted_final"), defaults.expectedClose),
    status: normalizeStatus(pick(point, "status", "state"), pointFinalPrice, pointEndsAt, observedAt),
    ...(forecast ? { forecast } : {}),
  };
}

function mergeObservations(...collections) {
  const byTimestamp = new Map();
  for (const collection of collections) {
    for (const observation of Array.isArray(collection) ? collection : []) {
      if (!observation?.observedAt) continue;
      const existing = byTimestamp.get(observation.observedAt);
      if (!existing) {
        byTimestamp.set(observation.observedAt, observation);
        continue;
      }
      const merged = { ...existing, ...observation };
      if (existing.forecast) merged.forecast = existing.forecast;
      byTimestamp.set(observation.observedAt, merged);
    }
  }
  const chronological = [...byTimestamp.values()]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const increases = [];
  let highestBid = Number.NEGATIVE_INFINITY;
  for (const observation of chronological) {
    const bid = Number(observation.currentBid);
    if (!Number.isFinite(bid) || bid <= highestBid) continue;
    increases.push(observation);
    highestBid = bid;
  }
  return increases.slice(-MAX_HISTORY_POINTS);
}

function externalIdentityKey(value, sourceKey = "") {
  const identity = text(value).toLowerCase();
  if (!identity) return "";
  return `${normalizeSourceKey(sourceKey) || "unknown-source"}:${identity}`;
}

function newestObservationTime(item) {
  const candidates = [item?.observedAt, ...(Array.isArray(item?.observations) ? item.observations.map((point) => point?.observedAt) : [])]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function retentionOrder(a, b) {
  const aActive = a?.status === "active" ? 0 : 1;
  const bActive = b?.status === "active" ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  const recency = newestObservationTime(b) - newestObservationTime(a);
  return recency || text(a?.id).localeCompare(text(b?.id));
}

function reconcileRetainedStatus(item) {
  if (item?.status !== "active" || !item?.endsAt || Date.parse(item.endsAt) > Date.now()) return item;
  return { ...item, status: "ended" };
}

function compactShopGoodwillItem(item) {
  if (item?.sourceKey !== "shopgoodwill") return item;
  const compact = { ...item };
  for (const [field, value] of Object.entries(compact)) {
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) delete compact[field];
  }
  if (compact.shippingKnown === false) delete compact.shippingKnown;
  if (compact.feeKnown === false) delete compact.feeKnown;
  if (compact.authenticationStatus === "not-supplied") delete compact.authenticationStatus;
  if (compact.authenticationEvidence === "No authentication evidence is supplied in the catalog record.") {
    delete compact.authenticationEvidence;
  }
  if (compact.identifiedAs === "Source listing title and category; identity and authenticity are not independently verified") {
    delete compact.identifiedAs;
  }
  if (compact.riskSummary === "The catalog record does not supply authentication evidence. Confirm identity, condition, shipping, and return options before bidding.") {
    delete compact.riskSummary;
  }
  return compact;
}

function hasVerifiedForecast(forecast, context = {}) {
  const normalized = normalizeForecast(forecast, context);
  return Boolean(normalized
    && VERIFIED_FORECAST_STATUSES.has(normalized.status)
    && normalized.expected > 0
    && normalized.low > 0
    && normalized.high > 0);
}

function sourceForecastCanBePreserved(item, items) {
  if (!hasVerifiedForecast(item?.forecast, {
    observedAt: item?.observedAt,
    currentBid: item?.currentBid,
  }) || !normalizedModelKey(item?.modelKey)) return false;
  const observedTime = Date.parse(item?.observedAt || "");
  const forecastTime = Date.parse(item?.forecast?.asOf || "");
  if (!Number.isFinite(observedTime) || !Number.isFinite(forecastTime)) return false;
  const ageMilliseconds = observedTime - forecastTime;
  if (ageMilliseconds < -5 * 60_000 || ageMilliseconds > 2 * 60 * 60_000) return false;
  return collectExactModelOutcomes(item, items).length >= 5;
}

function quantile(values, probability) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  const interpolated = lower + ((upper - lower) * (position - lowerIndex));
  return Math.round(interpolated * 100) / 100;
}

function curveHourTolerance(targetHoursToClose) {
  return Math.max(1, Math.min(24, targetHoursToClose * 0.25));
}

function matchingHistoryCurve(item, targetHoursToClose, finalPrice) {
  const endTime = Date.parse(item?.endsAt || "");
  if (!Number.isFinite(endTime) || !Number.isFinite(targetHoursToClose)) return null;
  const tolerance = curveHourTolerance(targetHoursToClose);
  let best = null;
  for (const observation of Array.isArray(item?.observations) ? item.observations : []) {
    const observedTime = Date.parse(observation?.observedAt || "");
    const bid = money(observation?.currentBid, null);
    if (!Number.isFinite(observedTime) || observedTime > endTime || !(bid > 0) || bid > finalPrice) continue;
    const hoursToClose = (endTime - observedTime) / 3_600_000;
    const distance = Math.abs(hoursToClose - targetHoursToClose);
    if (distance > tolerance || (best && distance >= best.distance)) continue;
    best = { bid, hoursToClose, distance };
  }
  return best;
}

function empiricalOutcomeKey(value) {
  const stableId = text(pick(value, "externalId", "id")).toLowerCase();
  if (stableId) return `id:${text(value?.source).toLowerCase()}:${stableId}`;
  const url = httpUrl(pick(value, "url", "sourceUrl"));
  if (url) return `url:${url.toLowerCase()}`;
  return comparableOutcomeKey({
    id: pick(value, "externalId", "id"),
    externalId: pick(value, "externalId", "id"),
    modelKey: value?.modelKey,
    title: value?.title,
    price: pick(value, "finalPrice", "price", "soldPrice"),
    endedAt: pick(value, "endsAt", "endedAt", "soldAt"),
    source: value?.source,
  });
}

function collectExactModelOutcomes(target, items) {
  const targetKey = normalizedModelKey(target?.modelKey);
  const targetObservedTime = Date.parse(target?.observedAt || "");
  if (!targetKey || !Number.isFinite(targetObservedTime)) return [];
  const targetUrl = httpUrl(pick(target, "url", "sourceUrl"));
  const targetEndTime = Date.parse(target?.endsAt || "");
  const targetHoursToClose = Number.isFinite(targetEndTime) && targetEndTime >= targetObservedTime
    ? (targetEndTime - targetObservedTime) / 3_600_000
    : null;
  const outcomes = new Map();
  const addOutcome = (outcome) => {
    if (!outcome?.key || !(outcome.finalPrice > 0)) return;
    const existing = outcomes.get(outcome.key);
    if (!existing) {
      outcomes.set(outcome.key, outcome);
      return;
    }
    if (!existing.curveBid && outcome.curveBid) {
      outcomes.set(outcome.key, { ...existing, curveBid: outcome.curveBid, curveHours: outcome.curveHours });
    }
  };

  for (const candidate of items) {
    if (!candidate || candidate.id === target.id || candidate.status !== "ended") continue;
    if (normalizedModelKey(candidate.modelKey) !== targetKey) continue;
    const finalPrice = money(candidate.finalPrice, null);
    const endedTime = Date.parse(candidate.endsAt || "");
    const capturedTime = Date.parse(candidate.observedAt || "");
    if (!(finalPrice > 0)
      || !Number.isFinite(endedTime)
      || endedTime > targetObservedTime
      || !Number.isFinite(capturedTime)
      || capturedTime > targetObservedTime) continue;
    const candidateUrl = httpUrl(pick(candidate, "url", "sourceUrl"));
    if (targetUrl && candidateUrl === targetUrl) continue;
    const curve = matchingHistoryCurve(candidate, targetHoursToClose, finalPrice);
    addOutcome({
      key: empiricalOutcomeKey(candidate),
      finalPrice,
      endedAt: candidate.endsAt,
      curveBid: curve?.bid ?? null,
      curveHours: curve?.hoursToClose ?? null,
    });
  }

  for (const owner of items) {
    const ownerObservedTime = Date.parse(owner?.observedAt || "");
    if (!Number.isFinite(ownerObservedTime) || ownerObservedTime > targetObservedTime) continue;
    const comparables = eligibleDatedComparables(owner?.auctionComparables, target.observedAt, targetKey);
    for (const comparable of comparables) {
      const comparableUrl = httpUrl(comparable.url);
      if (targetUrl && comparableUrl === targetUrl) continue;
      const finalPrice = money(pick(comparable, "finalPrice", "price", "soldPrice"), null);
      const comparableHours = nonnegativeNumber(comparable.hoursToClose, null);
      const comparableBid = money(comparable.bidAtComparableTime, null);
      const tolerance = Number.isFinite(targetHoursToClose) ? curveHourTolerance(targetHoursToClose) : null;
      const curveMatches = Number.isFinite(tolerance)
        && comparableHours !== null
        && comparableBid > 0
        && comparableBid <= finalPrice
        && Math.abs(comparableHours - targetHoursToClose) <= tolerance;
      addOutcome({
        key: empiricalOutcomeKey(comparable),
        finalPrice,
        endedAt: comparable.endedAt,
        curveBid: curveMatches ? comparableBid : null,
        curveHours: curveMatches ? comparableHours : null,
      });
    }
  }

  return [...outcomes.values()];
}

function buildEmpiricalClosingForecast(target, items) {
  if (target?.status !== "active" || !normalizedModelKey(target?.modelKey)) return null;
  const outcomes = collectExactModelOutcomes(target, items);
  if (outcomes.length < 5) return null;

  const currentBid = money(target.currentBid, 0);
  const curveOutcomes = currentBid > 0
    ? outcomes.filter((outcome) => outcome.curveBid > 0 && outcome.finalPrice >= outcome.curveBid)
    : [];
  const usesCurve = currentBid > 0 && curveOutcomes.length >= 5;
  const distribution = usesCurve
    ? curveOutcomes.map((outcome) => currentBid * (outcome.finalPrice / outcome.curveBid))
    : outcomes.map((outcome) => outcome.finalPrice);
  const evidenceIds = [...new Set(outcomes.map((outcome) => text(outcome.key)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const low = Math.max(currentBid, quantile(distribution, 0.2));
  const expected = Math.max(currentBid, quantile(distribution, 0.5));
  const high = Math.max(currentBid, quantile(distribution, 0.8));
  if (![low, expected, high].every(Number.isFinite)) return null;

  return {
    status: "available",
    asOf: timestamp(target.observedAt),
    modelVersion: "empirical-close-v1",
    expected,
    low,
    high,
    sampleSize: outcomes.length,
    exactModelCount: outcomes.length,
    curveCount: curveOutcomes.length,
    confidence: null,
    method: usesCurve ? "exact-model time-to-close uplift" : "exact-model final-price distribution",
    evidenceIds,
    evidenceHash: digest(evidenceIds.join("\n")),
    reasonCodes: usesCurve
      ? ["BIDAI_EMPIRICAL_EXACT_MODEL", "TIME_TO_CLOSE_UPLIFT", "DATED_OUTCOMES_ONLY"]
      : ["BIDAI_EMPIRICAL_EXACT_MODEL", "FINAL_PRICE_DISTRIBUTION", "DATED_OUTCOMES_ONLY"],
  };
}

function applyEmpiricalClosingForecasts(items) {
  return items.map((item) => {
    if (item?._forecastSnapshotLocked || item?.status !== "active" || sourceForecastCanBePreserved(item, items)) return item;
    const currentObservationExists = Array.isArray(item.observations)
      && item.observations.some((observation) => observation?.observedAt === item.observedAt);
    if (!currentObservationExists) return item;
    const forecast = buildEmpiricalClosingForecast(item, items);
    if (!forecast) {
      if (!hasVerifiedForecast(item.forecast, {
        observedAt: item?.observedAt,
        currentBid: item?.currentBid,
      })) return item;
      const unsupportedForecast = {
        ...item.forecast,
        status: "insufficient-data",
        expected: null,
        low: null,
        high: null,
        reasonCodes: [
          ...(Array.isArray(item.forecast.reasonCodes) ? item.forecast.reasonCodes : []),
          "EXACT_MODEL_EVIDENCE_NOT_REVALIDATED",
        ].slice(0, 20),
      };
      return {
        ...item,
        forecast: unsupportedForecast,
        observations: item.observations.map((observation) => (
          observation?.observedAt === item.observedAt
            ? { ...observation, forecast: unsupportedForecast }
            : observation
        )),
      };
    }
    return {
      ...item,
      forecast,
      observations: item.observations.map((observation) => (
        observation?.observedAt === item.observedAt
          ? { ...observation, forecast }
          : observation
      )),
    };
  });
}

function recordObservedAt(record) {
  return timestamp(pick(record, "observedAt", "observed_at", "capturedAt", "captured_at", "timestamp"));
}

function normalizeRecord(record, index, capturedAt, sourceLabel = "Authorized feed", requireObservedAt = false, fallbackSourceKey = "authorized-feed") {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const title = text(pick(record, "title", "name", "listingTitle", "listing_title"));
  if (!title) return null;

  const comparableSalesSupplied = hasOwn(record, "comparableSales", "comparable_sales", "soldComparables", "sold_comparables");
  const fieldPresence = {
    source: hasOwn(record, "source", "sourceName", "source_name"),
    sourceKey: true,
    url: hasOwn(record, "url", "sourceUrl", "source_url", "listingUrl", "listing_url"),
    sourceUrl: hasOwn(record, "url", "sourceUrl", "source_url", "listingUrl", "listing_url"),
    imageUrl: hasOwn(record, "imageUrl", "image_url", "imageURL", "thumbnailUrl", "thumbnail_url"),
    category: hasOwn(record, "category", "categoryName", "catFullName", "department", "type"),
    currentBid: hasOwn(record, "currentBid", "current_bid", "currentPrice", "current_price", "price", "bidAmount", "bid_amount", "finalPrice", "final_price", "soldPrice", "sold_price"),
    shipping: hasOwn(record, "shipping", "shippingCost", "shipping_cost", "shippingPrice"),
    shippingKnown: hasOwn(record, "shipping", "shippingCost", "shipping_cost", "shippingPrice", "shippingKnown", "shipping_known"),
    bidCount: hasOwn(record, "bidCount", "bid_count", "bids", "numBids", "numberOfBids"),
    endsAt: hasOwn(record, "endsAt", "ends_at", "endTime", "end_time", "closeTime", "close_time"),
    expectedClose: hasOwn(record, "expectedClose", "expected_close", "predictedFinal", "predicted_final"),
    resaleLow: comparableSalesSupplied || hasOwn(record, "resaleLow", "resale_low"),
    resaleMedian: comparableSalesSupplied || hasOwn(record, "resaleMedian", "resale_median", "resaleValue", "resale_value"),
    resaleHigh: comparableSalesSupplied || hasOwn(record, "resaleHigh", "resale_high"),
    finalPrice: hasOwn(record, "finalPrice", "final_price", "soldPrice", "sold_price"),
    demand: hasOwn(record, "demand", "demandScore", "demand_score"),
    rarity: hasOwn(record, "rarity", "rarityScore", "rarity_score"),
    identityConfidence: hasOwn(record, "identityConfidence", "identity_confidence"),
    conditionConfidence: hasOwn(record, "conditionConfidence", "condition_confidence"),
    resaleVertical: hasOwn(record, "resaleVertical", "resale_vertical"),
    authenticationStatus: hasOwn(record, "authenticationStatus", "authentication_status"),
    authenticationEvidence: hasOwn(record, "authenticationEvidence", "authentication_evidence"),
    riskSummary: hasOwn(record, "riskSummary", "risk_summary"),
    compCount: comparableSalesSupplied || hasOwn(record, "compCount", "comp_count", "comparableCount", "comparable_count"),
    compRecencyDays: hasOwn(record, "compRecencyDays", "comp_recency_days"),
    modelKey: hasOwn(record, "modelKey", "model_key", "compGroup", "comp_group", "similarItemKey", "similar_item_key"),
    forecastBasis: hasOwn(record, "forecastBasis", "forecast_basis", "predictionBasis", "prediction_basis"),
    identifiedAs: hasOwn(record, "identifiedAs", "identified_as"),
    marketplaceFee: hasOwn(record, "marketplaceFee", "marketplace_fee"),
    feeKnown: hasOwn(record, "marketplaceFee", "marketplace_fee", "feeKnown", "fee_known"),
    taxRate: hasOwn(record, "taxRate", "tax_rate"),
    buyerPremium: hasOwn(record, "buyerPremium", "buyer_premium"),
    outboundShipping: hasOwn(record, "outboundShipping", "outbound_shipping"),
    repairReserve: hasOwn(record, "repairReserve", "repair_reserve"),
    returnReserve: hasOwn(record, "returnReserve", "return_reserve"),
  };

  const currentBid = money(pick(record, "currentBid", "current_bid", "currentPrice", "current_price", "price", "bidAmount", "bid_amount"));
  const finalPrice = money(pick(record, "finalPrice", "final_price", "soldPrice", "sold_price"), 0);
  const endsAt = timestamp(pick(record, "endsAt", "ends_at", "endTime", "end_time", "closeTime", "close_time"));
  const suppliedObservedAt = recordObservedAt(record);
  if (requireObservedAt && !suppliedObservedAt) return null;
  const observedAt = suppliedObservedAt || capturedAt;
  const rawExpectedClose = pick(record, "expectedClose", "expected_close", "predictedFinal", "predicted_final");
  const expectedClose = money(rawExpectedClose, null);
  const normalized = {
    title,
    category: text(pick(record, "category", "catFullName", "categoryName", "department", "type"), "Unclassified"),
    url: httpUrl(pick(record, "url", "sourceUrl", "source_url", "listingUrl", "listing_url")),
    endsAt,
  };
  const recordSourceLabel = text(pick(record, "source", "sourceName", "source_name"), sourceLabel);
  const sourceKey = sourceKeyFor(record, normalized.url, fallbackSourceKey || recordSourceLabel);
  const identity = stableIdentity(record, normalized, sourceKey);
  const status = normalizeStatus(pick(record, "status", "state"), finalPrice, endsAt, observedAt);
  const bid = Math.max(currentBid, finalPrice);
  const defaults = {
    observedAt,
    currentBid: bid,
    bidCount: integer(pick(record, "bidCount", "bid_count", "bids", "numBids", "numberOfBids")),
    expectedClose,
    endsAt,
  };
  const suppliedHistory = pick(record, "observations", "history", "snapshots", "bidHistory", "bid_history");
  const history = (Array.isArray(suppliedHistory) ? suppliedHistory : [])
    .map((point) => normalizeObservation(point, defaults))
    .filter(Boolean);
  const currentObservation = normalizeObservation(record, defaults);
  const comparableSales = normalizeComparables(
    pick(record, "comparableSales", "comparable_sales", "soldComparables", "sold_comparables"),
    "sale",
    sourceLabel,
  ).map((comparable) => ({
    ...comparable,
    outcomeObservedAt: comparable.outcomeObservedAt || observedAt,
  }));
  const auctionComparables = normalizeComparables(
    pick(record, "auctionComparables", "auction_comparables", "auctionComps", "auction_comps"),
    "auction",
    sourceLabel,
  ).map((comparable) => ({
    ...comparable,
    outcomeObservedAt: comparable.outcomeObservedAt || observedAt,
  }));
  const modelKey = text(pick(record, "modelKey", "model_key", "compGroup", "comp_group", "similarItemKey", "similar_item_key"));
  const eligibleComparableSales = eligibleDatedComparables(comparableSales, observedAt, modelKey);
  const derivedResale = comparableRanges(eligibleComparableSales);
  const rawResaleLow = pick(record, "resaleLow", "resale_low");
  const rawResaleMedian = pick(record, "resaleMedian", "resale_median", "resaleValue", "resale_value");
  const rawResaleHigh = pick(record, "resaleHigh", "resale_high");
  const rawCompCount = pick(record, "compCount", "comp_count", "comparableCount", "comparable_count");
  const rawShipping = pick(record, "shipping", "shippingCost", "shipping_cost", "shippingPrice");
  const normalizedShipping = money(rawShipping, null);
  const rawMarketplaceFee = pick(record, "marketplaceFee", "marketplace_fee");
  const normalizedMarketplaceFee = percentage(rawMarketplaceFee, null);
  const suppliedForecast = pick(record, "forecast", "verifiedForecast", "verified_forecast");
  const forecast = normalizeForecast(suppliedForecast, { observedAt, currentBid: bid });
  const rawValuationBasis = pick(record, "valuationBasis", "valuation_basis", "intrinsicValuation", "intrinsic_valuation");
  const rawIntrinsicValueEvidence = pick(record, "intrinsicValueEvidence", "intrinsic_value_evidence");
  const intrinsicEvidenceSupplied = rawValuationBasis !== undefined || rawIntrinsicValueEvidence !== undefined;
  const valuationBasis = normalizeValuationBasis(rawValuationBasis, observedAt);
  const intrinsicValueEvidence = boolean(
    rawIntrinsicValueEvidence,
    false,
  ) && Boolean(valuationBasis);

  return {
    id: identity.id,
    externalId: identity.externalId,
    source: recordSourceLabel,
    sourceKey,
    url: normalized.url,
    sourceUrl: normalized.url,
    imageUrl: httpUrl(pick(record, "imageUrl", "image_url", "imageURL", "thumbnailUrl", "thumbnail_url")),
    title: normalized.title,
    category: normalized.category,
    resaleVertical: text(pick(record, "resaleVertical", "resale_vertical"), "Other"),
    authenticationStatus: text(pick(record, "authenticationStatus", "authentication_status"), "not-supplied"),
    authenticationEvidence: text(pick(record, "authenticationEvidence", "authentication_evidence"), "No authentication evidence supplied."),
    status,
    currentBid: bid,
    shipping: normalizedShipping,
    shippingKnown: normalizedShipping !== null
      && boolean(pick(record, "shippingKnown", "shipping_known"), supplied(rawShipping)),
    bidCount: defaults.bidCount,
    endsAt,
    expectedClose,
    resaleLow: supplied(rawResaleLow) ? money(rawResaleLow, null) : (derivedResale?.low ?? null),
    resaleMedian: supplied(rawResaleMedian) ? money(rawResaleMedian, null) : (derivedResale?.median ?? null),
    resaleHigh: supplied(rawResaleHigh) ? money(rawResaleHigh, null) : (derivedResale?.high ?? null),
    finalPrice: finalPrice || null,
    demand: score(pick(record, "demand", "demandScore", "demand_score"), 50),
    rarity: score(pick(record, "rarity", "rarityScore", "rarity_score")),
    identityConfidence: ratio(pick(record, "identityConfidence", "identity_confidence"), 0.35),
    conditionConfidence: ratio(pick(record, "conditionConfidence", "condition_confidence"), 0.35),
    compCount: supplied(rawCompCount) ? integer(rawCompCount) : eligibleComparableSales.length,
    compRecencyDays: integer(pick(record, "compRecencyDays", "comp_recency_days"), null),
    modelKey,
    forecastBasis: text(pick(record, "forecastBasis", "forecast_basis", "predictionBasis", "prediction_basis")),
    comparableSales,
    auctionComparables,
    ...(forecast ? { forecast } : {}),
    ...(intrinsicEvidenceSupplied ? { intrinsicValueEvidence, valuationBasis } : {}),
    identifiedAs: text(pick(record, "identifiedAs", "identified_as"), "Feed-provided identity; verify before bidding"),
    riskSummary: text(pick(record, "riskSummary", "risk_summary")),
    publishedResearch: true,
    marketplaceFee: normalizedMarketplaceFee,
    feeKnown: normalizedMarketplaceFee !== null
      && boolean(pick(record, "feeKnown", "fee_known"), supplied(rawMarketplaceFee)),
    taxRate: percentage(pick(record, "taxRate", "tax_rate")),
    buyerPremium: percentage(pick(record, "buyerPremium", "buyer_premium")),
    outboundShipping: money(pick(record, "outboundShipping", "outbound_shipping"), null),
    repairReserve: money(pick(record, "repairReserve", "repair_reserve"), null),
    returnReserve: money(pick(record, "returnReserve", "return_reserve"), null),
    observedAt,
    observations: mergeObservations(history, currentObservation ? [currentObservation] : []),
    feedOrder: index,
    _fieldPresence: fieldPresence,
  };
}

function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["items", "listings", "auctions", "records", "snapshots"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function normalizeEnvelope(value) {
  if (Array.isArray(value)) {
    return { observedAt: null, sourceMode: "legacy-array", sourceNotes: [], items: value };
  }
  if (value && typeof value === "object" && Array.isArray(value.items)) {
    return {
      observedAt: timestamp(value.observedAt),
      sourceMode: text(value.sourceMode, "published-research"),
      sourceNotes: Array.isArray(value.sourceNotes) ? value.sourceNotes.map((note) => text(note)).filter(Boolean) : [],
      items: value.items,
    };
  }
  return { observedAt: null, sourceMode: "unavailable", sourceNotes: [], items: [] };
}

async function readPreviousEnvelope() {
  try {
    const source = await readFile(outputPath, "utf8");
    if (!source.startsWith(OUTPUT_PREFIX)) return normalizeEnvelope(null);
    const serialized = source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, "");
    try {
      return normalizeEnvelope(JSON.parse(serialized));
    } catch {
      const sandbox = { window: {} };
      runInNewContext(source, sandbox, { timeout: 1_000 });
      return normalizeEnvelope(sandbox.window.BIDAI_LIVE_SNAPSHOTS);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[refresh-feed] Existing snapshot data could not be reused; rebuilding it.");
    return normalizeEnvelope(null);
  }
}

async function writeAtomically(envelope) {
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = join(outputDirectory, `.live-snapshots.${process.pid}.${Date.now()}.tmp`);
  const serialized = [
    "{",
    `  \"observedAt\": ${JSON.stringify(envelope.observedAt)},`,
    `  \"sourceMode\": ${JSON.stringify(envelope.sourceMode)},`,
    `  \"sourceNotes\": ${JSON.stringify(envelope.sourceNotes)},`,
    "  \"items\": [",
    envelope.items.map((item) => `    ${JSON.stringify(item)}`).join(",\n"),
    "  ]",
    "}",
  ].join("\n")
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const source = `${OUTPUT_PREFIX}${serialized};\n`;

  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function run() {
  const shopGoodwillMode = text(process.env.BIDAI_SHOPGOODWILL_MODE).toLowerCase();
  if (process.env.BIDAI_SOURCE_AUTHORIZED !== AUTHORIZED_VALUE
    && !["catalog", "items"].includes(shopGoodwillMode)) {
    console.log("[refresh-feed] No-op: BIDAI_SOURCE_AUTHORIZED must be exactly 'true'. No network request was made.");
    return;
  }

  const requestConfiguration = feedRequestConfiguration(process.env);

  const payload = await fetchPayload(requestConfiguration);

  const records = extractRecords(payload);
  if (!records.length) throw new Error("The authorized feed contained no item records.");

  const isApifyDataset = requestConfiguration.sourceMode === "apify-dataset";
  const recordEntries = records.map((record, originalIndex) => ({
    record,
    originalIndex,
    observedAt: recordObservedAt(record),
  }));
  if (isApifyDataset && recordEntries.some(({ record }) => (
    !record || typeof record !== "object" || Array.isArray(record)
    || !text(pick(record, "title", "name", "listingTitle", "listing_title"))
  ))) {
    throw new Error("Every Apify dataset item must be a flat object with a title.");
  }
  if (isApifyDataset && recordEntries.some((entry) => !entry.observedAt)) {
    throw new Error("Every Apify dataset item must include a valid observedAt timestamp.");
  }
  if (isApifyDataset && recordEntries.some(({ record }) => {
    const currency = comparableCurrency(record);
    return currency && currency !== "USD";
  })) {
    throw new Error("Apify dataset monetary fields must be denominated in USD.");
  }
  if (isApifyDataset && recordEntries.some(({ record }) => !apifyComparableArraysAreValid(record))) {
    throw new Error("Every Apify comparable must be a USD object with a title and positive sale price.");
  }
  if (isApifyDataset && recordEntries.some(({ record }) => !apifyForecastIsValid(record))) {
    throw new Error("Every supplied Apify forecast must be a USD object.");
  }
  if (isApifyDataset) {
    recordEntries.sort((a, b) => (
      Date.parse(a.observedAt) - Date.parse(b.observedAt) || b.originalIndex - a.originalIndex
    ));
  }

  const newestRecordObservation = recordEntries.reduce((latest, entry) => {
    if (!entry.observedAt) return latest;
    return !latest || Date.parse(entry.observedAt) > Date.parse(latest) ? entry.observedAt : latest;
  }, null);
  const capturedAt = timestamp(
    pick(payload, "generatedAt", "generated_at", "observedAt", "observed_at"),
    isApifyDataset ? newestRecordObservation : new Date().toISOString(),
  );
  if (!isApifyDataset) {
    recordEntries.sort((a, b) => {
      const aTime = Date.parse(a.observedAt || capturedAt || "");
      const bTime = Date.parse(b.observedAt || capturedAt || "");
      const chronology = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
      return chronology || a.originalIndex - b.originalIndex;
    });
  }
  const normalized = recordEntries
    .map((entry, index) => normalizeRecord(
      entry.record,
      index,
      capturedAt,
      requestConfiguration.sourceLabel,
      isApifyDataset,
      requestConfiguration.sourceKey,
    ))
    .filter(Boolean);
  if (!normalized.length) throw new Error("The authorized feed contained no records with a title.");

  const previousEnvelope = await readPreviousEnvelope();
  const previousById = new Map(previousEnvelope.items.map((item) => [item.id, item]));
  const previousByExternalId = new Map(
    previousEnvelope.items
      .map((item) => [externalIdentityKey(item?.externalId, item?.sourceKey || sourceKeyFor(item, item?.url || item?.sourceUrl, item?.source)), item])
      .filter(([key]) => key),
  );
  const matchedPreviousIds = new Set();
  const mergedById = new Map();
  for (const item of normalized) {
    const previous = previousById.get(item.id)
      || previousByExternalId.get(externalIdentityKey(item.externalId, item.sourceKey));
    const retainedId = previous?.id || item.id;
    const duplicate = mergedById.get(retainedId);
    const priorState = duplicate || previous;
    const bidIncreased = !priorState || Number(item.currentBid) > Number(priorState.currentBid);
    const snapshotItem = bidIncreased ? item : {
      ...item,
      currentBid: priorState.currentBid,
      bidCount: priorState.bidCount,
      expectedClose: priorState.expectedClose,
      observedAt: priorState.observedAt,
      ...(priorState.forecast ? { forecast: priorState.forecast } : {}),
    };
    if (!bidIncreased && !priorState.forecast) delete snapshotItem.forecast;
    const incomingObservations = item.observations.map((observation) => ({
      ...observation,
      ...(!item._fieldPresence?.currentBid && priorState?.currentBid !== undefined
        ? { currentBid: priorState.currentBid }
        : {}),
      ...(!item._fieldPresence?.bidCount && priorState?.bidCount !== undefined
        ? { bidCount: priorState.bidCount }
        : {}),
      ...(!item._fieldPresence?.expectedClose && priorState?.expectedClose !== undefined
        ? { expectedClose: priorState.expectedClose }
        : {}),
    }));
    if (previous?.id) matchedPreviousIds.add(previous.id);
    const merged = {
      ...(previous || {}),
      ...(duplicate || {}),
      ...snapshotItem,
      id: retainedId,
      observations: mergeObservations(previous?.observations, duplicate?.observations, incomingObservations),
      comparableSales: mergeComparableEvidence(
        previous?.comparableSales,
        duplicate?.comparableSales,
        item.comparableSales,
      ),
      auctionComparables: mergeComparableEvidence(
        previous?.auctionComparables,
        duplicate?.auctionComparables,
        item.auctionComparables,
      ),
    };
    for (const [field, wasSupplied] of Object.entries(item._fieldPresence || {})) {
      if (!wasSupplied && priorState && Object.prototype.hasOwnProperty.call(priorState, field)) {
        merged[field] = priorState[field];
      }
    }
    const immutableForecastSource = duplicate?.observedAt === snapshotItem.observedAt && duplicate?.forecast
      ? duplicate
      : (previous?.observedAt === snapshotItem.observedAt && previous?.forecast ? previous : null);
    if (immutableForecastSource) {
      merged.forecast = immutableForecastSource.forecast;
      merged._forecastSnapshotLocked = true;
    } else {
      delete merged._forecastSnapshotLocked;
      if (!Object.prototype.hasOwnProperty.call(snapshotItem, "forecast")) delete merged.forecast;
    }
    mergedById.set(retainedId, merged);
  }

  for (const previous of previousEnvelope.items) {
    if (!previous?.id || matchedPreviousIds.has(previous.id) || mergedById.has(previous.id)) continue;
    mergedById.set(previous.id, previous);
  }

  const retainedItems = [...mergedById.values()]
    .map(({ feedOrder: _feedOrder, _fieldPresence: _fieldPresence, ...item }) => item)
    .map(reconcileRetainedStatus)
    .sort(retentionOrder)
    .slice(0, MAX_RETAINED_ITEMS);
  const items = applyEmpiricalClosingForecasts(retainedItems)
    .map(({ _forecastSnapshotLocked: _locked, ...item }) => item)
    .map(compactShopGoodwillItem);
  const incomingNotes = pick(payload, "sourceNotes", "source_notes", "notes");
  const sourceNotes = (Array.isArray(incomingNotes) ? incomingNotes : [])
    .map((note) => text(note))
    .filter(Boolean);
  const publishedObservedAt = items.reduce((latest, item) => {
    const observedAt = timestamp(item?.observedAt);
    if (!observedAt) return latest;
    return !latest || Date.parse(observedAt) > Date.parse(latest) ? observedAt : latest;
  }, previousEnvelope.observedAt || null);
  const envelope = {
    observedAt: publishedObservedAt,
    sourceMode: text(pick(payload, "sourceMode", "source_mode"), requestConfiguration.sourceMode),
    sourceNotes: sourceNotes.length
      ? [...sourceNotes, "Prior unmatched records are retained for outcome and bid-history learning."]
      : [
          requestConfiguration.sourceMode === "apify-dataset"
            ? "Automated snapshots imported from the configured Apify dataset; verify each item before bidding."
            : "Automated snapshots from a permissioned JSON feed; verify each item before bidding.",
          "Prior unmatched records are retained for outcome and bid-history learning.",
        ],
    items,
  };
  await writeAtomically(envelope);
  console.log(`[refresh-feed] Wrote ${items.length} normalized item${items.length === 1 ? "" : "s"} to data/live-snapshots.js.`);
}

run().catch((error) => {
  console.error(`[refresh-feed] ${error.message}`);
  process.exitCode = 1;
});
