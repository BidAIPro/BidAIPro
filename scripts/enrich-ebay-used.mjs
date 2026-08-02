import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const MAX_LISTINGS = 50;
const MAX_HISTORY = 365;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "auction", "authentic", "authenticated", "beautiful", "goodwill", "item", "lot", "nice", "preowned", "shopgoodwill", "used",
]);

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
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))];
}

function queryFor(item) {
  const titleTokens = tokens(item?.title).slice(0, 12);
  return titleTokens.join(" ").slice(0, 100);
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

function hasFreshAskingMarket(item) {
  const asOf = Date.parse(item?.askingMarket?.asOf || "");
  return Number.isFinite(asOf) && Date.now() - asOf < 23 * 60 * 60_000;
}

function targetPriority(item) {
  const end = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(end) ? Math.max(0, (end - Date.now()) / 3_600_000) : 9_999;
  const authenticated = item?.authenticationStatus === "source-stated" ? 1_000 : 0;
  const knownVertical = item?.resaleVertical && item.resaleVertical !== "Other" ? 500 : 0;
  return authenticated + knownVertical + Math.min(500, Number(item?.bidCount) || 0) + Math.max(0, 250 - hours);
}

function selectTargets(items) {
  const limit = Math.min(500, positiveInteger(process.env.BIDAI_EBAY_USED_BATCH_SIZE, 150));
  return items
    .filter((item) => item?.status === "active" && cleanText(item?.title) && !hasFreshAskingMarket(item))
    .filter((item) => !item?.metalEstimate)
    .filter((item) => queryFor(item).split(" ").length >= 3)
    .sort((left, right) => targetPriority(right) - targetPriority(left))
    .slice(0, limit);
}

async function obtainAccessToken(clientId, clientSecret) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: OAUTH_SCOPE }).toString(),
  });
  if (!response.ok) throw new Error(`eBay OAuth failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const accessToken = cleanText(payload?.access_token);
  if (!accessToken) throw new Error("eBay OAuth response did not contain an access token.");
  return accessToken;
}

function shippingTotal(summary) {
  const options = Array.isArray(summary?.shippingOptions) ? summary.shippingOptions : [];
  const costs = options
    .map((option) => option?.shippingCost)
    .filter((cost) => cleanText(cost?.currency, "USD").toUpperCase() === "USD")
    .map((cost) => money(cost?.value))
    .filter((value) => value !== null);
  return costs.length ? Math.min(...costs) : 0;
}

function normalizeListing(summary, target) {
  const condition = cleanText(summary?.condition);
  const currency = cleanText(summary?.price?.currency, "USD").toUpperCase();
  const price = money(summary?.price?.value);
  const url = httpUrl(summary?.itemWebUrl || summary?.itemHref);
  const externalId = cleanText(summary?.itemId || summary?.legacyItemId).slice(0, 200);
  const title = cleanText(summary?.title).slice(0, 500);
  const score = matchScore(target.title, title);
  if (currency !== "USD" || !price || !url || !externalId || !/used|pre-owned|preowned/i.test(condition) || score < 65) return null;
  const shipping = shippingTotal(summary);
  return {
    id: externalId,
    externalId,
    title,
    price,
    shipping,
    totalPrice: Math.round((price + shipping) * 100) / 100,
    url,
    condition,
    source: "eBay active used listing",
    matchScore: score,
  };
}

async function searchUsedListings(target, accessToken, marketplaceId) {
  const query = queryFor(target);
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("filter", "conditions:{USED},buyingOptions:{FIXED_PRICE|BEST_OFFER}");
  url.searchParams.set("limit", String(MAX_LISTINGS));
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-ebay-c-marketplace-id": marketplaceId,
      "accept-language": "en-US",
    },
  });
  if (!response.ok) {
    const error = new Error(`eBay Browse search failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const unique = new Map();
  for (const summary of Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : []) {
    const listing = normalizeListing(summary, target);
    if (listing && !unique.has(listing.externalId)) unique.set(listing.externalId, listing);
  }
  const listings = [...unique.values()].slice(0, MAX_LISTINGS);
  const asOf = new Date().toISOString();
  if (listings.length < 5) {
    return {
      askingMarket: {
        status: "insufficient",
        channel: "eBay active used listings",
        currency: "USD",
        asOf,
        query,
        usedOnly: true,
        sampleSize: listings.length,
        reason: "Fewer than five sufficiently matched used listings",
        listings: [],
      },
      historyEntry: null,
    };
  }
  const totals = listings.map((listing) => listing.totalPrice);
  return {
    askingMarket: {
      status: "available",
      channel: "eBay active used listings",
      currency: "USD",
      asOf,
      query,
      usedOnly: true,
      sampleSize: listings.length,
      priceLow: quantile(totals, 0.2),
      priceMedian: quantile(totals, 0.5),
      priceAverage: average(totals),
      priceHigh: quantile(totals, 0.8),
      listings,
    },
    historyEntry: {
      asOf,
      channel: "eBay active used listings",
      sampleSize: listings.length,
      priceLow: quantile(totals, 0.2),
      priceMedian: quantile(totals, 0.5),
      priceAverage: average(totals),
      priceHigh: quantile(totals, 0.8),
    },
  };
}

function appendHistory(item, entry) {
  const prior = Array.isArray(item?.askingMarketHistory) ? item.askingMarketHistory : [];
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
  const clientId = cleanText(process.env.BIDAI_EBAY_CLIENT_ID);
  const clientSecret = cleanText(process.env.BIDAI_EBAY_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    console.log("No-op: eBay client credentials are not configured.");
    return;
  }
  const { source, envelope } = await readEnvelope();
  const targets = selectTargets(envelope.items);
  if (!targets.length) {
    console.log("No-op: no active listings need a used-price refresh.");
    return;
  }
  const marketplaceId = cleanText(process.env.BIDAI_EBAY_MARKETPLACE_ID, "EBAY_US").toUpperCase();
  const accessToken = await obtainAccessToken(clientId, clientSecret);
  let blockedStatus = null;
  const results = await mapWithConcurrency(targets, 4, async (target) => {
    if (blockedStatus) return null;
    try {
      return await searchUsedListings(target, accessToken, marketplaceId);
    } catch (error) {
      if ([401, 403, 429].includes(error.status)) {
        if (!blockedStatus) console.warn(`${error.message} Remaining used-price lookups were skipped.`);
        blockedStatus = error.status;
        return null;
      }
      console.warn(`Used-price lookup skipped for ${cleanText(target.id, target.externalId)}: ${error.message}`);
      return null;
    }
  });
  const byId = new Map(targets.map((target, index) => [target.id, results[index]]));
  let changed = 0;
  envelope.items = envelope.items.map((item) => {
    const result = byId.get(item.id);
    if (!result) return item;
    changed += 1;
    return {
      ...item,
      askingMarket: result.askingMarket,
      ...(result.historyEntry ? { askingMarketHistory: appendHistory(item, result.historyEntry) } : {}),
    };
  });
  if (!changed) {
    console.log("No-op: eBay returned fewer than five sufficiently matched used listings per target.");
    return;
  }
  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource === source) {
    console.log("No-op: used-price evidence is unchanged.");
    return;
  }
  await writeEnvelope(envelope);
  const available = results.filter((result) => result?.askingMarket?.status === "available").length;
  console.log(`Reviewed ${changed} listing${changed === 1 ? "" : "s"}; ${available} received matched eBay used asking-price evidence.`);
}

await main();
