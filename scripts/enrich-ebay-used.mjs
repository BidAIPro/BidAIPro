import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const FINDING_URL = "https://svcs.ebay.com/services/search/FindingService/v1";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const MAX_LISTINGS = 50;
const MAX_HISTORY = 365;
const CLOSE_MATCH_SCORE = 65;
const ANALOG_MATCH_SCORE = 35;
const PRICING_STRATEGY_VERSION = "ebay-free-analog-v1";
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
    .filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOP_WORDS.has(token)))];
}

function queryCandidatesFor(item) {
  const titleTokens = tokens(item?.title);
  const modelTokens = tokens(item?.modelKey);
  const conciseTokens = titleTokens.filter((token) => !LISTING_NOISE_WORDS.has(token));
  const candidates = [
    modelTokens.slice(0, 9),
    conciseTokens.slice(0, 8),
    conciseTokens.slice(0, 6),
    titleTokens.slice(0, 10),
  ]
    .map((parts) => parts.join(" ").slice(0, 100))
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, 1);
}

function queryFor(item) {
  return queryCandidatesFor(item)[0] || "";
}

function categoryQueryFor(item) {
  const segments = cleanText(item?.category)
    .split(">").map((value) => value.trim()).filter(Boolean);
  const categoryText = segments.slice(-2).join(" ")
    || cleanText(item?.resaleVertical, "general merchandise");
  return tokens(categoryText).slice(0, 7).join(" ").slice(0, 100);
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

function analogMatchScore(targetTitle, candidateTitle) {
  const target = tokens(targetTitle);
  const candidate = new Set(tokens(candidateTitle));
  if (!target.length || !candidate.size) return 0;
  const shared = target.filter((token) => candidate.has(token)).length;
  const minimumShared = target.length <= 2 ? 1 : 2;
  const coverage = shared / target.length;
  if (shared < minimumShared || coverage < 0.3) return 0;
  return Math.round(Math.min(64, 35 + coverage * 24 + Math.min(5, shared)) * 100) / 100;
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

function statsFor(listings) {
  const initial = listings.map((listing) => listing.totalPrice).filter((value) => Number.isFinite(value) && value > 0);
  const initialMedian = quantile(initial, 0.5);
  const trimmed = initialMedian
    ? listings.filter((listing) => listing.totalPrice >= initialMedian * 0.25 && listing.totalPrice <= initialMedian * 4)
    : listings;
  const retained = trimmed.length >= 5 ? trimmed : listings;
  const totals = retained.map((listing) => listing.totalPrice);
  return {
    listings: retained,
    sampleSize: retained.length,
    sourceCount: new Set(retained.map((listing) => listing.source.toLowerCase())).size,
    priceLow: quantile(totals, 0.2),
    priceMedian: quantile(totals, 0.5),
    priceAverage: average(totals),
    priceHigh: quantile(totals, 0.8),
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

function hasFreshAskingMarket(item) {
  const asOf = Date.parse(item?.askingMarket?.asOf || "");
  return item?.askingMarket?.strategyVersion === PRICING_STRATEGY_VERSION
    && Number.isFinite(asOf)
    && Date.now() - asOf < 23 * 60 * 60_000;
}

function targetPriority(item) {
  const end = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(end) ? Math.max(0, (end - Date.now()) / 3_600_000) : 9_999;
  const authenticated = item?.authenticationStatus === "source-stated" ? 1_000 : 0;
  const knownVertical = item?.resaleVertical && item.resaleVertical !== "Other" ? 500 : 0;
  return authenticated + knownVertical + Math.min(500, Number(item?.bidCount) || 0) + Math.max(0, 250 - hours);
}

function selectTargetGroups(items) {
  const limit = Math.min(500, positiveInteger(process.env.BIDAI_EBAY_USED_BATCH_SIZE, 100));
  const candidates = items
    .filter((item) => item?.status === "active" && cleanText(item?.title) && !hasFreshAskingMarket(item))
    .filter((item) => !item?.metalEstimate)
    .filter((item) => Boolean(queryFor(item)))
    .sort((left, right) => targetPriority(right) - targetPriority(left));
  const buckets = new Map();
  for (const item of candidates) {
    const key = cleanText(item?.resaleVertical, "Other");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const selected = new Map();
  const groups = [...buckets.values()];
  while (selected.size < limit && groups.some((group) => group.length)) {
    for (const group of groups) {
      if (selected.size >= limit) break;
      const next = group.shift();
      if (!next) continue;
      const key = queryFor(next).toLowerCase();
      if (!selected.has(key)) selected.set(key, { representative: next, members: [] });
      selected.get(key).members.push(next);
    }
  }
  for (const group of selected.values()) group.members = [];
  for (const item of candidates) {
    const group = selected.get(queryFor(item).toLowerCase());
    if (group) group.members.push(item);
  }
  return [...selected.values()];
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
  if (!response.ok) {
    const error = new Error(`eBay OAuth failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const accessToken = cleanText(payload?.access_token);
  if (!accessToken) throw new Error("eBay OAuth response did not contain an access token.");
  return accessToken;
}

function first(value, fallback = null) {
  return Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback);
}

function findingSearchResult(payload) {
  const response = first(payload?.findItemsAdvancedResponse, {});
  const ack = cleanText(first(response?.ack));
  if (ack && !/success|warning/i.test(ack)) {
    const message = cleanText(first(first(response?.errorMessage, {})?.error, {})?.message, "eBay Finding API rejected the request.");
    throw new Error(message);
  }
  const searchResult = first(response?.searchResult, {});
  const pagination = first(response?.paginationOutput, {});
  const items = Array.isArray(searchResult?.item) ? searchResult.item : [];
  const totalEntries = Math.max(0, Math.round(Number(first(pagination?.totalEntries, items.length)) || 0));
  const summaries = items.map((item) => {
    const price = first(first(item?.sellingStatus, {})?.currentPrice, {});
    const shipping = first(first(item?.shippingInfo, {})?.shippingServiceCost, {});
    const condition = first(item?.condition, {});
    const seller = first(item?.sellerInfo, {});
    return {
      itemId: cleanText(first(item?.itemId)),
      title: cleanText(first(item?.title)),
      condition: cleanText(first(condition?.conditionDisplayName), "Used"),
      price: {
        value: price?.__value__ ?? first(price),
        currency: price?.["@currencyId"] || "USD",
      },
      shippingOptions: [{ shippingCost: {
        value: shipping?.__value__ ?? first(shipping, 0),
        currency: shipping?.["@currencyId"] || "USD",
      } }],
      itemWebUrl: cleanText(first(item?.viewItemURL)),
      seller: { username: cleanText(first(seller?.sellerUserName), "marketplace seller") },
    };
  });
  return { summaries, totalEntries };
}

async function searchFinding(query, appId) {
  const url = new URL(FINDING_URL);
  url.searchParams.set("OPERATION-NAME", "findItemsAdvanced");
  url.searchParams.set("SERVICE-VERSION", "1.13.0");
  url.searchParams.set("SECURITY-APPNAME", appId);
  url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
  url.searchParams.set("REST-PAYLOAD", "true");
  url.searchParams.set("keywords", query);
  url.searchParams.set("paginationInput.entriesPerPage", String(MAX_LISTINGS));
  url.searchParams.set("outputSelector(0)", "SellerInfo");
  url.searchParams.set("itemFilter(0).name", "Condition");
  url.searchParams.set("itemFilter(0).value", "Used");
  url.searchParams.set("itemFilter(1).name", "ListingType");
  url.searchParams.set("itemFilter(1).value", "FixedPrice");
  url.searchParams.set("itemFilter(2).name", "Currency");
  url.searchParams.set("itemFilter(2).value", "USD");
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`eBay Finding search failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return findingSearchResult(await response.json());
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

function normalizeListing(summary, target, matchTitle = target?.title, categoryFallback = false) {
  const condition = cleanText(summary?.condition);
  const currency = cleanText(summary?.price?.currency, "USD").toUpperCase();
  const price = money(summary?.price?.value);
  const url = httpUrl(summary?.itemWebUrl || summary?.itemHref);
  const externalId = cleanText(summary?.itemId || summary?.legacyItemId).slice(0, 200);
  const title = cleanText(summary?.title).slice(0, 500);
  const closeScore = matchScore(target?.title, title);
  const score = closeScore >= CLOSE_MATCH_SCORE
    ? closeScore
    : analogMatchScore(matchTitle, title);
  if (currency !== "USD" || !price || !url || !externalId || !/used|pre-owned|preowned/i.test(condition) || score < ANALOG_MATCH_SCORE) return null;
  const shipping = shippingTotal(summary);
  const seller = cleanText(summary?.seller?.username || summary?.seller?.userId, "marketplace seller").slice(0, 100);
  return {
    id: externalId,
    externalId,
    title,
    price,
    shipping,
    totalPrice: Math.round((price + shipping) * 100) / 100,
    url,
    condition,
    source: `eBay seller: ${seller}`,
    matchScore: score,
    matchTier: closeScore >= CLOSE_MATCH_SCORE ? "close" : categoryFallback ? "category-analog" : "market-analog",
  };
}

async function searchUsedListings(target, accessToken, marketplaceId, findingAppId = "") {
  const primaryQuery = queryFor(target);
  const unique = new Map();
  const queriesTried = [];
  const queryMetrics = [];
  const collect = async (query, categoryFallback = false) => {
    queriesTried.push(query);
    let summaries;
    let totalEntries = 0;
    if (findingAppId) {
      const result = await searchFinding(query, findingAppId);
      summaries = result.summaries;
      totalEntries = result.totalEntries;
    } else {
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
      summaries = Array.isArray(payload?.itemSummaries) ? payload.itemSummaries : [];
      totalEntries = Math.max(0, Math.round(Number(payload?.total) || summaries.length));
    }
    let matchedListings = 0;
    for (const summary of summaries) {
      const listing = normalizeListing(summary, target, categoryFallback ? query : target.title, categoryFallback);
      if (listing) matchedListings += 1;
      if (listing && !unique.has(listing.externalId)) unique.set(listing.externalId, listing);
    }
    queryMetrics.push({ query, categoryFallback, totalEntries, returnedEntries: summaries.length, matchedListings });
  };
  await collect(primaryQuery);
  const initialClose = [...unique.values()].filter((listing) => listing.matchScore >= CLOSE_MATCH_SCORE);
  const initialAnalogSources = new Set([...unique.values()].map((listing) => listing.source.toLowerCase())).size;
  const categoryQuery = categoryQueryFor(target);
  if (initialClose.length < 5 && (unique.size < 5 || initialAnalogSources < 2)
      && categoryQuery && categoryQuery.toLowerCase() !== primaryQuery.toLowerCase()) {
    await collect(categoryQuery, true);
  }
  const offers = [...unique.values()].slice(0, MAX_LISTINGS);
  const closeListings = offers.filter((listing) => listing.matchScore >= CLOSE_MATCH_SCORE);
  const closeStats = statsFor(closeListings);
  const analogStats = statsFor(offers);
  const exactAvailable = closeStats.sampleSize >= 5;
  const analogAvailable = !exactAvailable && analogStats.sampleSize >= 5 && analogStats.sourceCount >= 2;
  const asOf = new Date().toISOString();
  const query = queriesTried.at(-1) || queryFor(target);
  const categoryAnalogCount = analogStats.listings.filter((listing) => listing.matchTier === "category-analog").length;
  const planningReservePercent = categoryAnalogCount > 0 ? 65 : 55;
  const analogChannel = findingAppId ? "eBay Finding API free active asking prices" : "eBay Browse API active asking prices";
  const primaryMetrics = queryMetrics.find((entry) => !entry.categoryFallback) || queryMetrics[0] || null;
  const marketPresence = {
    status: closeStats.sampleSize > 0 ? "available" : "insufficient",
    channel: analogChannel,
    evidenceType: "active-listing-depth",
    asOf,
    query: primaryQuery,
    searchResultCount: Math.max(0, Number(primaryMetrics?.totalEntries) || 0),
    returnedListingCount: Math.max(0, Number(primaryMetrics?.returnedEntries) || 0),
    matchedListingCount: closeStats.sampleSize,
    sellerCount: closeStats.sourceCount,
    note: "Active matched listings measure market presence and competing supply, not completed-sale demand or sell-through.",
  };
  return {
    askingMarket: {
      status: exactAvailable ? "available" : "insufficient",
      channel: "eBay active used listings",
      strategyVersion: PRICING_STRATEGY_VERSION,
      currency: "USD",
      asOf,
      query,
      queriesTried,
      usedOnly: true,
      sampleSize: closeStats.sampleSize,
      marketPresence,
      ...(exactAvailable ? {
        priceLow: closeStats.priceLow,
        priceMedian: closeStats.priceMedian,
        priceAverage: closeStats.priceAverage,
        priceHigh: closeStats.priceHigh,
        listings: closeStats.listings,
      } : {
        reason: analogAvailable
          ? "Close matches were insufficient; a separate conservative eBay analog is available"
          : "Fewer than five sufficiently matched or analogous used listings",
        listings: [],
      }),
    },
    historyEntry: exactAvailable ? {
      asOf,
      channel: "eBay active used listings",
      sampleSize: closeStats.sampleSize,
      priceLow: closeStats.priceLow,
      priceMedian: closeStats.priceMedian,
      priceAverage: closeStats.priceAverage,
      priceHigh: closeStats.priceHigh,
    } : null,
    retailMarket: analogAvailable ? {
      status: "available",
      channel: analogChannel,
      provider: "ebay-free",
      strategyVersion: PRICING_STRATEGY_VERSION,
      currency: "USD",
      asOf,
      query: primaryQuery,
      queriesTried,
      sampleSize: analogStats.sampleSize,
      sourceCount: analogStats.sourceCount,
      used: { sampleSize: 0, sourceCount: 0 },
      newRetail: { sampleSize: 0, sourceCount: 0 },
      analog: {
        sampleSize: analogStats.sampleSize,
        sourceCount: analogStats.sourceCount,
        priceLow: analogStats.priceLow,
        priceMedian: analogStats.priceMedian,
        priceAverage: analogStats.priceAverage,
        priceHigh: analogStats.priceHigh,
        conditionBasis: "used/refurbished",
        minimumMatchScore: ANALOG_MATCH_SCORE,
        averageMatchScore: Math.round(average(analogStats.listings.map((listing) => listing.matchScore)) * 10) / 10,
        categoryAnalogCount,
        planningReservePercent,
        note: "Real eBay active used asking prices with a broader title or category match; reference-only, not completed sales.",
      },
      productInterest: {
        reviewCountMax: 0,
        reviewCountMedian: 0,
        ratingAverage: null,
        note: "Active asking offers do not establish demand or sell-through.",
      },
      marketPresence,
      offers: analogStats.listings,
    } : null,
    retailHistoryEntry: analogAvailable ? {
      asOf,
      channel: analogChannel,
      analog: {
        sampleSize: analogStats.sampleSize,
        sourceCount: analogStats.sourceCount,
        priceLow: analogStats.priceLow,
        priceMedian: analogStats.priceMedian,
        priceAverage: analogStats.priceAverage,
        priceHigh: analogStats.priceHigh,
        categoryAnalogCount,
        planningReservePercent,
      },
      sourceCount: analogStats.sourceCount,
    } : null,
  };
}

function appendHistory(item, entry, field = "askingMarketHistory") {
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
  const clientId = cleanText(process.env.BIDAI_EBAY_CLIENT_ID);
  const clientSecret = cleanText(process.env.BIDAI_EBAY_CLIENT_SECRET);
  if (!clientId) {
    console.log("No-op: eBay developer App ID is not configured.");
    return;
  }
  const { source, envelope } = await readEnvelope();
  const targetGroups = selectTargetGroups(envelope.items);
  if (!targetGroups.length) {
    console.log("No-op: no active listings need a used-price refresh.");
    return;
  }
  const marketplaceId = cleanText(process.env.BIDAI_EBAY_MARKETPLACE_ID, "EBAY_US").toUpperCase();
  const browseRequested = /^(?:1|true|yes)$/i.test(cleanText(process.env.BIDAI_EBAY_USE_BROWSE));
  let accessToken = null;
  let findingAppId = clientId;
  if (browseRequested && clientSecret) {
    try {
      accessToken = await obtainAccessToken(clientId, clientSecret);
      findingAppId = "";
    } catch (error) {
      console.warn(`${error.message} Falling back to the free App-ID Finding API.`);
    }
  }
  let blockedStatus = null;
  const results = await mapWithConcurrency(targetGroups, 4, async (group) => {
    if (blockedStatus) return null;
    const target = group.representative;
    try {
      return await searchUsedListings(target, accessToken, marketplaceId, findingAppId);
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
  const byId = new Map();
  targetGroups.forEach((group, index) => {
    for (const member of group.members) byId.set(member.id, results[index]);
  });
  let changed = 0;
  envelope.items = envelope.items.map((item) => {
    const result = byId.get(item.id);
    if (!result) return item;
    changed += 1;
    const next = {
      ...item,
      askingMarket: result.askingMarket,
      ...(result.historyEntry ? { askingMarketHistory: appendHistory(item, result.historyEntry) } : {}),
    };
    if (result.retailMarket) {
      next.retailMarket = result.retailMarket;
      next.retailMarketHistory = appendHistory(item, result.retailHistoryEntry, "retailMarketHistory");
    } else if (item.retailMarket?.provider === "ebay-free") {
      delete next.retailMarket;
    }
    return next;
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
  const analogs = results.filter((result) => result?.retailMarket?.status === "available").length;
  const transport = findingAppId ? "free eBay Finding API" : "approved eBay Browse API";
  console.log(`Reviewed ${changed} listing${changed === 1 ? "" : "s"} across ${targetGroups.length} unique product quer${targetGroups.length === 1 ? "y" : "ies"} through the ${transport}; ${available} groups received close-match used pricing and ${analogs} received conservative asking-price analogs.`);
}

await main();
