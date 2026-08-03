import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assessIdentity, queryForItem } from "./enrich-free-retail.mjs";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const API_ROOT = "https://api.linksynergy.com/productsearch/1.0";
const PROVIDER = "rakuten";
const STRATEGY_VERSION = "rakuten-product-search-v1";
const DEFAULT_BATCH_SIZE = 300;
const MAX_BATCH_SIZE = 500;
const DEFAULT_DELAY_MS = 650;
const ATTEMPT_FRESH_MS = 23 * 60 * 60_000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

const NON_CATALOG_TITLE = /^(?:no shipping|pick[ -]?up|payment due|sales tax|terms(?: and conditions)?|inspection(?:s)?|as-is,? where-is)/i;
const COMPOSITE_TITLE = /\b(?:assorted|bulk|gaylord|mixed|misc(?:ellaneous)?|unsorted|wholesale|lot|collection of|set of \d+|\d+(?:\.\d+)?\s*(?:lb|lbs|pounds)\b)/i;
const UNIQUE_METAL_TITLE = /(?:\b(?:gold|silver|sterling|platinum|palladium)\b.*\b(?:bracelet|chain|earrings?|jewelry|necklace|pendant|rings?)\b|\b(?:bracelet|chain|earrings?|jewelry|necklace|pendant|rings?)\b.*\b(?:gold|silver|sterling|platinum|palladium)\b)/i;
const UNAVAILABLE = /out\s*of\s*stock|unavailable|sold\s*out|discontinued/i;

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
  const configured = Date.parse(cleanText(process.env.BIDAI_RAKUTEN_RETAIL_NOW));
  return new Date(Number.isFinite(configured) ? configured : Date.now());
}

function sleep(milliseconds) {
  return milliseconds > 0 ? new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)) : Promise.resolve();
}

function stableHash(value) {
  return createHash("sha256").update(cleanText(value)).digest("hex").slice(0, 24);
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagMatch(block, names) {
  for (const name of names) {
    const escaped = escapePattern(name);
    const match = String(block).match(new RegExp(`<(?:(?:[\\w-]+):)?${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${escaped}\\s*>`, "i"));
    if (match) return { attributes: match[1] || "", text: cleanText(decodeXml(match[2]).replace(/<[^>]+>/g, " ")) };
  }
  return null;
}

function tagText(block, names, fallback = "") {
  return tagMatch(block, names)?.text || fallback;
}

function attributeValue(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\b${escapePattern(name)}\\s*=\\s*[\"']([^\"']+)[\"']`, "i"));
  return match ? cleanText(decodeXml(match[1])) : "";
}

function productBlocks(xml) {
  const source = String(xml ?? "");
  const blocks = [];
  for (const tag of ["item", "product"]) {
    const pattern = new RegExp(`<(?:(?:[\\w-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${tag}\\s*>`, "gi");
    for (const match of source.matchAll(pattern)) blocks.push(match[1]);
    if (blocks.length) break;
  }
  return blocks;
}

function identifierDigits(value) {
  const digits = cleanText(value).replace(/\D/g, "");
  return [8, 10, 12, 13, 14].includes(digits.length) ? digits : "";
}

function parseProductBlock(block) {
  const regularPriceTag = tagMatch(block, ["price", "retailprice", "listprice"]);
  const salePriceTag = tagMatch(block, ["saleprice", "sale_price", "currentprice"]);
  const explicitCurrency = tagText(block, ["currency", "currencycode"]);
  const currency = cleanText(
    attributeValue(salePriceTag?.attributes, "currency")
      || attributeValue(regularPriceTag?.attributes, "currency")
      || explicitCurrency,
    "USD",
  ).toUpperCase();
  const regularPrice = money(regularPriceTag?.text);
  const salePrice = money(salePriceTag?.text);
  const upc = identifierDigits(tagText(block, ["upccode", "upc"]));
  const ean = identifierDigits(tagText(block, ["eancode", "ean"]));
  const gtin = identifierDigits(tagText(block, ["gtin", "gtincode"]));
  return {
    title: tagText(block, ["productname", "product_name", "title", "name"]),
    brand: tagText(block, ["brand", "brandname", "manufacturer"]),
    model: tagText(block, ["model", "modelname", "mpn", "manufacturersku"]),
    category: tagText(block, ["category", "primarycategory", "productcategory"]),
    description: tagText(block, ["description", "shortdescription"]),
    upc,
    ean,
    gtin,
    sku: tagText(block, ["sku", "advertisersku", "merchantsku"]),
    merchant: tagText(block, ["merchantname", "advertisername", "merchant", "advertiser"]),
    merchantId: tagText(block, ["mid", "merchantid", "advertiserid"]),
    linkId: tagText(block, ["linkid", "productid", "offerid"]),
    url: tagText(block, ["linkurl", "producturl", "clickurl", "url"]),
    imageUrl: tagText(block, ["imageurl", "image_url"]),
    condition: tagText(block, ["condition"], "New"),
    availability: tagText(block, ["availability", "stock", "instock"]),
    currency,
    regularPrice,
    salePrice,
    price: salePrice || regularPrice,
  };
}

export function parseProductSearchXml(xml) {
  return productBlocks(xml).map(parseProductBlock);
}

function identifiersFromCandidate(candidate) {
  return [...new Set([candidate?.upc, candidate?.ean, candidate?.gtin].map(identifierDigits).filter(Boolean))];
}

function matchTierFor(identity) {
  return identity?.matchedBy === "catalog identifier"
    ? "exact-upc-gtin"
    : identity?.matchedBy === "title and model" ? "exact-model" : "strict-title";
}

function normalizeOffer(candidate, identity, observedAt) {
  if (candidate.currency !== "USD" || !candidate.price || UNAVAILABLE.test(candidate.availability)) return null;
  const url = httpUrl(candidate.url);
  const merchant = cleanText(candidate.merchant);
  const merchantId = cleanText(candidate.merchantId) || (merchant ? `name-${stableHash(merchant.toLowerCase())}` : "");
  const linkId = cleanText(candidate.linkId) || (url ? `url-${stableHash(url)}` : "");
  if (!url || !merchant || !merchantId || !linkId) return null;
  const price = candidate.price;
  const listPrice = candidate.regularPrice && candidate.regularPrice >= price ? candidate.regularPrice : null;
  return {
    id: `rakuten:${merchantId}:${linkId}`.slice(0, 500),
    title: cleanText(candidate.title).slice(0, 500),
    merchant: merchant.slice(0, 160),
    merchantId: merchantId.slice(0, 160),
    linkId: linkId.slice(0, 200),
    source: merchant.slice(0, 160),
    url,
    currency: "USD",
    price,
    listPrice,
    totalPrice: price,
    condition: cleanText(candidate.condition, "New").slice(0, 100),
    availability: cleanText(candidate.availability, "Product feed result").slice(0, 160),
    observedAt,
    freshness: "current",
    isCurrent: true,
    matchScore: identity.score,
    matchTier: matchTierFor(identity),
    evidenceType: "active-merchant-asking-price",
    listingState: "current merchant asking offer; not a completed sale",
  };
}

function quantile(values, probability) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) * 100) / 100;
}

function average(values) {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
}

function insufficientMarket(query, observedAt, reason) {
  return {
    status: "insufficient",
    provider: PROVIDER,
    channel: "Rakuten Advertising Product Search",
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    query: { type: query.type, value: query.value },
    catalog: null,
    offers: [],
    reason,
    note: "No retail value is asserted without a strict product-identity match and an auditable current USD merchant offer.",
  };
}

export function marketFromXml(target, query, xml, observedAt = new Date().toISOString()) {
  const products = parseProductSearchXml(xml);
  const accepted = products
    .map((candidate) => ({ candidate, identity: assessIdentity(target, candidate, query) }))
    .filter((entry) => entry.identity.accepted)
    .sort((left, right) => right.identity.score - left.identity.score);
  if (!accepted.length) {
    return insufficientMarket(query, observedAt, products.length
      ? "Rakuten results conflicted with or did not strictly match this listing's product identity"
      : "Rakuten returned no matching retail products");
  }

  const deduplicated = new Map();
  for (const entry of accepted) {
    const offer = normalizeOffer(entry.candidate, entry.identity, observedAt);
    if (!offer) continue;
    const existing = deduplicated.get(offer.id);
    if (!existing || offer.price < existing.offer.price || offer.matchScore > existing.offer.matchScore) {
      deduplicated.set(offer.id, { ...entry, offer });
    }
  }
  const matched = [...deduplicated.values()];
  if (!matched.length) {
    return insufficientMarket(query, observedAt, "Strictly matched Rakuten products had no usable current USD merchant price and link");
  }
  const offers = matched.map((entry) => entry.offer).sort((left, right) => left.totalPrice - right.totalPrice);
  const merchants = new Set(offers.map((offer) => offer.merchantId.toLowerCase()));
  const prices = offers.map((offer) => offer.totalPrice);
  const best = matched.sort((left, right) => right.identity.score - left.identity.score || left.offer.price - right.offer.price)[0];
  const sourceCount = merchants.size;
  const available = offers.length >= 2 && sourceCount >= 2;
  const evidenceType = sourceCount >= 2 ? "current-multi-merchant-retail-offers" : "current-single-merchant-retail-offer";
  const identifiers = identifiersFromCandidate(best.candidate);
  const matchTier = matchTierFor(best.identity);
  const catalog = {
    title: cleanText(best.candidate.title).slice(0, 500),
    brand: cleanText(best.candidate.brand).slice(0, 160),
    model: cleanText(best.candidate.model).slice(0, 160),
    category: cleanText(best.candidate.category).slice(0, 300),
    identifiers: {
      upc: cleanText(best.candidate.upc),
      ean: cleanText(best.candidate.ean),
      gtin: cleanText(best.candidate.gtin),
      sku: cleanText(best.candidate.sku),
      all: identifiers,
    },
    matchScore: best.identity.score,
    matchedBy: best.identity.matchedBy,
    matchTier,
    evidenceType,
    sampleSize: offers.length,
    sourceCount,
    priceLow: quantile(prices, 0),
    priceMedian: quantile(prices, 0.5),
    priceAverage: average(prices),
    priceHigh: quantile(prices, 1),
    planningReservePercent: available ? 55 : 65,
    sourceUrl: best.offer.url,
  };
  return {
    status: available ? "available" : "reference-only",
    provider: PROVIDER,
    channel: "Rakuten Advertising Product Search",
    strategyVersion: STRATEGY_VERSION,
    currency: "USD",
    asOf: observedAt,
    query: { type: query.type, value: query.value },
    catalog,
    offers,
    reason: available
      ? "Multiple current merchant offers strictly matched this product"
      : "Only one current merchant source strictly matched; this remains a retail reference only",
    note: "Current merchant asking prices for the matched product. They are not used-condition sold comps, demand evidence, guaranteed resale proceeds, or a safe-bid recommendation.",
  };
}

function partnerAttemptAt(item) {
  const parsed = Date.parse(item?.partnerRetailMarket?.lastAttempt?.asOf || item?.partnerRetailMarket?.asOf || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function catalogSuitable(item, query) {
  if (!query) return false;
  if (query.type === "identifier") return true;
  const title = cleanText(item?.title);
  return title.length >= 8
    && !NON_CATALOG_TITLE.test(title)
    && !COMPOSITE_TITLE.test(title)
    && !UNIQUE_METAL_TITLE.test(title)
    && query.value.split(/\s+/).filter(Boolean).length >= 3;
}

function targetPriority(item, nowMs) {
  const closesAt = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(closesAt) ? Math.max(0, (closesAt - nowMs) / 3_600_000) : 9_999;
  const identifierBonus = queryForItem(item)?.type === "identifier" ? 1_000 : 0;
  return identifierBonus + Math.min(500, Number(item?.bidCount) || 0) + Math.max(0, 250 - hours);
}

export function selectTargetGroups(items, limit = DEFAULT_BATCH_SIZE, nowMs = Date.now()) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status !== "active") continue;
    const closesAt = Date.parse(item?.endsAt || "");
    if (Number.isFinite(closesAt) && closesAt <= nowMs) continue;
    const attemptedAt = partnerAttemptAt(item);
    if (attemptedAt > 0 && nowMs - attemptedAt < ATTEMPT_FRESH_MS) continue;
    const query = queryForItem(item);
    if (!catalogSuitable(item, query)) continue;
    if (!groups.has(query.key)) groups.set(query.key, { query, members: [] });
    groups.get(query.key).members.push(item);
  }
  const prepared = [...groups.values()]
    .map((group) => {
      group.members.sort((left, right) => targetPriority(right, nowMs) - targetPriority(left, nowMs));
      return { ...group, representative: group.members[0] };
    });
  const buckets = new Map();
  for (const group of prepared) {
    const vertical = cleanText(group.representative?.resaleVertical)
      || cleanText(group.representative?.category).split(">")[0].trim()
      || "Other";
    if (!buckets.has(vertical)) buckets.set(vertical, []);
    buckets.get(vertical).push(group);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => targetPriority(right.representative, nowMs) - targetPriority(left.representative, nowMs));
  }
  const maximum = Math.min(MAX_BATCH_SIZE, Math.max(0, limit));
  const selected = [];
  const queues = [...buckets.values()];
  while (selected.length < maximum && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (selected.length >= maximum) break;
      const group = queue.shift();
      if (group) selected.push(group);
    }
  }
  return selected;
}

async function requestProducts(query, token) {
  const endpoint = new URL(API_ROOT);
  endpoint.searchParams.set(query.type === "identifier" ? "exact" : "keyword", query.value);
  endpoint.searchParams.set("language", "en_US");
  endpoint.searchParams.set("max", "100");
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/xml, text/xml;q=0.9",
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const error = new Error(`Rakuten Product Search request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.text();
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

function evidenceStrength(market) {
  const catalog = market?.catalog || {};
  return statusRank(market?.status) * 1_000_000
    + Math.max(0, Number(catalog.sourceCount) || 0) * 10_000
    + Math.max(0, Number(catalog.sampleSize) || 0) * 100
    + Math.max(0, Number(catalog.matchScore) || 0);
}

function retainBetterEvidence(existing, attempted) {
  if (!existing || evidenceStrength(attempted) >= evidenceStrength(existing)) return attempted;
  return {
    ...existing,
    lastAttempt: {
      asOf: attempted.asOf,
      status: attempted.status,
      query: attempted.query,
      reason: attempted.reason || "The latest lookup produced weaker evidence than the retained Rakuten retail reference",
    },
  };
}

export async function runEnrichment({ path = outputPath } = {}) {
  const token = cleanText(process.env.BIDAI_RAKUTEN_ACCESS_TOKEN);
  if (!token) {
    console.log("No-op: BIDAI_RAKUTEN_ACCESS_TOKEN is not configured.");
    return { changed: 0, requested: 0, missingToken: true };
  }
  const loaded = await readEnvelope(path);
  if (!loaded) {
    console.log("No-op: data/live-snapshots.js does not exist yet.");
    return { changed: 0, requested: 0, missing: true };
  }
  const { source, envelope } = loaded;
  const now = nowDate();
  const observedAt = now.toISOString();
  const batchSize = Math.min(MAX_BATCH_SIZE, positiveInteger(process.env.BIDAI_RAKUTEN_RETAIL_BATCH_SIZE, DEFAULT_BATCH_SIZE));
  const delayMs = nonNegativeInteger(process.env.BIDAI_RAKUTEN_RETAIL_DELAY_MS, DEFAULT_DELAY_MS);
  const groups = selectTargetGroups(envelope.items, batchSize, now.getTime());
  if (!groups.length) {
    console.log("No-op: no active catalog-suitable listings currently need a Rakuten lookup.");
    return { changed: 0, requested: 0 };
  }

  const updates = new Map();
  let requested = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (index > 0) await sleep(delayMs);
    requested += 1;
    try {
      const xml = await requestProducts(group.query, token);
      for (const member of group.members) updates.set(member, marketFromXml(member, group.query, xml, observedAt));
    } catch (error) {
      const reason = `Rakuten Product Search lookup failed: ${error.message}`;
      for (const member of group.members) updates.set(member, insufficientMarket(group.query, observedAt, reason));
      console.warn(`Rakuten retail lookup skipped for ${cleanText(group.representative?.id, "listing")}: ${error.message}`);
      if ([401, 403, 429].includes(error.status)) break;
    }
  }

  let changed = 0;
  envelope.items = envelope.items.map((item) => {
    const attempted = updates.get(item);
    if (!attempted) return item;
    changed += 1;
    return { ...item, partnerRetailMarket: retainBetterEvidence(item.partnerRetailMarket, attempted) };
  });
  envelope.partnerRetailEnrichment = {
    provider: PROVIDER,
    strategyVersion: STRATEGY_VERSION,
    lastRunAt: observedAt,
    requested,
    reviewedListings: changed,
  };
  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource !== source) await writeEnvelope(envelope, path);
  const available = [...updates.values()].filter((market) => market.status === "available").length;
  const references = [...updates.values()].filter((market) => market.status === "reference-only").length;
  console.log(`Rakuten reviewed ${changed} listing${changed === 1 ? "" : "s"} across ${requested} request${requested === 1 ? "" : "s"}; ${available} received multi-merchant retail evidence and ${references} received a single-merchant reference.`);
  return { changed, requested, available, references };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runEnrichment();
}
