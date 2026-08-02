import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "data", "live-snapshots.js");
const LIMIT = bounded(process.env.BIDAI_PUBLIC_SOURCE_LIMIT, 30, 1, 100);
const DETAIL_LIMIT = bounded(process.env.BIDAI_PUBLIC_DETAIL_LIMIT, 12, 1, 40);
const TIMEOUT_MS = bounded(process.env.BIDAI_PUBLIC_REQUEST_TIMEOUT_MS, 25_000, 5_000, 60_000);
const USER_AGENT = "BidAIPro/1.0 (+public auction snapshot; low-volume research collector)";

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function money(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : fallback;
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function iso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function decodeHtml(value) {
  return text(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function modelKey(sourceKey, title) {
  const normalized = text(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ").slice(0, 160);
  return normalized ? `${sourceKey}:title-exact-v1:${normalized}` : "";
}

function categoryFor(title, fallback = "General merchandise") {
  const value = text(title).toLowerCase();
  if (/\b(gold|silver|ring|bracelet|necklace|jewel|diamond|coin|bullion)\b/.test(value)) return "Jewelry, coins & precious metals";
  if (/\b(watch|timepiece|chronograph)\b/.test(value)) return "Watches";
  if (/\b(shoe|sneaker|boot|footwear)\b/.test(value)) return "Shoes & sneakers";
  if (/\b(hat|cap|beanie|headwear)\b/.test(value)) return "Hats & headwear";
  if (/\b(phone|computer|laptop|camera|console|electronic|audio|speaker)\b/.test(value)) return "Electronics";
  if (/\b(collectible|memorabilia|card|comic|antique|vintage|figurine)\b/.test(value)) return "Collectibles";
  if (/\b(car|truck|vehicle|tractor|trailer|bus|van)\b/.test(value)) return "Vehicles & equipment";
  return fallback;
}

function resaleVerticalFor(title, category = "") {
  const value = `${text(title)} ${text(category)}`.toLowerCase();
  if (/\b(shoe|sneaker|boot|footwear)\b/.test(value)) return "Footwear & Sneakers";
  if (/\b(watch|timepiece|chronograph)\b/.test(value)) return "Watches";
  if (/\b(ring|jewel|gold|silver|diamond|bracelet|necklace|earring|coin|bullion)\b/.test(value)) return "Rings & Jewelry";
  if (/\b(hat|cap|beanie|headwear)\b/.test(value)) return "Hats & Headwear";
  if (/\b(collectible|memorabilia|card|comic|antique|vintage|figurine|art|craft)\b/.test(value)) return "Collectibles";
  if (/\b(phone|computer|laptop|camera|console|electronic|audio|speaker|printer|scanner)\b/.test(value)) return "Electronics";
  return "Other";
}

function record(sourceKey, source, externalId, title, url, fields = {}) {
  const observedAt = fields.observedAt || new Date().toISOString();
  const category = text(fields.category, categoryFor(title));
  return {
    externalId: text(externalId),
    sourceKey,
    source,
    title: decodeHtml(title),
    url,
    sourceUrl: url,
    category,
    resaleVertical: resaleVerticalFor(title, category),
    modelKey: modelKey(sourceKey, title),
    forecastBasis: "Exact normalized title only; similar items require separately labeled analog evidence.",
    currentBid: money(fields.currentBid, 0),
    bidCount: integer(fields.bidCount),
    endsAt: iso(fields.endsAt),
    status: fields.status || (iso(fields.endsAt) && Date.parse(fields.endsAt) <= Date.now() ? "ended" : "active"),
    imageUrl: safeUrl(fields.imageUrl, url),
    buyerPremium: money(fields.buyerPremium),
    shippingKnown: false,
    feeKnown: fields.buyerPremium !== null && fields.buyerPremium !== undefined,
    identifiedAs: "Source listing title; identity, condition, authenticity, and final costs require verification.",
    riskSummary: "Public source snapshot. Open the original lot and verify buyer premium, tax, shipping, pickup, condition, authenticity, and close time before bidding.",
    observedAt,
  };
}

async function fetchResponse(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "user-agent": USER_AGENT, ...options.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function fetchText(url, options = {}) {
  return (await fetchResponse(url, options)).text();
}

async function parallel(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { output[index] = await mapper(values[index], index); } catch { output[index] = null; }
    }
  }));
  return output.filter(Boolean);
}

function xmlLocations(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeHtml(match[1]));
}

async function collectEbay() {
  const clientId = text(process.env.BIDAI_EBAY_CLIENT_ID);
  const clientSecret = text(process.env.BIDAI_EBAY_CLIENT_SECRET);
  if (!clientId || !clientSecret) throw new Error("Add BIDAI_EBAY_CLIENT_ID and BIDAI_EBAY_CLIENT_SECRET repository secrets.");
  const tokenResponse = await fetchResponse("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  const token = (await tokenResponse.json()).access_token;
  if (!token) throw new Error("eBay did not return an application token.");
  const queries = ["gold jewelry", "silver bullion", "authenticated sneakers", "watches", "electronics", "collectibles", "vintage hats", "cameras"];
  const pages = await parallel(queries, 2, async (query) => {
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    url.searchParams.set("q", query);
    url.searchParams.set("filter", "buyingOptions:{AUCTION},deliveryCountry:US");
    url.searchParams.set("limit", String(Math.min(50, LIMIT)));
    const response = await fetchResponse(url, { headers: { authorization: `Bearer ${token}`, "x-ebay-c-marketplace-id": "EBAY_US" } });
    return (await response.json()).itemSummaries || [];
  });
  const seen = new Set();
  return pages.flat().filter((item) => item?.itemId && !seen.has(item.itemId) && seen.add(item.itemId)).slice(0, LIMIT).map((item) => record(
    "ebay", "eBay Auctions", item.itemId, item.title, item.itemWebUrl,
    {
      currentBid: item.currentBidPrice?.value ?? item.price?.value,
      bidCount: item.bidCount,
      endsAt: item.itemEndDate,
      imageUrl: item.image?.imageUrl,
      category: item.categories?.[0]?.categoryName,
    },
  ));
}

async function collectHiBid() {
  const html = await fetchText("https://hibid.com/lots");
  const stateMatch = html.match(/<script[^>]+id=["']hibid-state["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!stateMatch) throw new Error("HiBid did not expose its public lot-state payload.");
  const payload = JSON.parse(stateMatch[1].trim());
  const state = payload?.["apollo.state"] || payload?.props?.pageProps?.apolloState || payload?.apolloState || payload;
  const auctions = new Map(Object.entries(state).filter(([key]) => /^Auction:/.test(key)));
  return Object.entries(state).filter(([key, value]) => (/^Lot:/.test(key) || value?.__typename === "Lot") && value?.lead).slice(0, LIMIT).map(([key, lot]) => {
    const auctionRef = lot.auction?.__ref;
    const auction = auctions.get(auctionRef) || {};
    const externalId = lot.id || lot.itemId || key.split(":").pop();
    return record("hibid", "HiBid", externalId, lot.lead, safeUrl(`/lot/${externalId}`, "https://hibid.com"), {
      currentBid: lot.lotState?.highBid,
      bidCount: lot.lotState?.bidCount,
      endsAt: lot.lotState?.timeLeftTitle?.replace(/^.*?at:\s*/i, "") || auction.bidCloseDateTime,
      imageUrl: lot.featuredPicture?.hdThumbnailLocation || lot.featuredPicture?.thumbnailLocation || lot.featuredPicture?.fullSizeLocation || lot.featuredPicture?.url,
      category: lot.category?.name || categoryFor(lot.lead),
      buyerPremium: auction.buyerPremium,
      status: lot.lotState?.isClosed ? "ended" : "active",
    });
  });
}

function findProductJson(value) {
  if (!value || typeof value !== "object") return null;
  if (String(value["@type"] || "").toLowerCase() === "product") return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findProductJson(child);
    if (found) return found;
  }
  return null;
}

async function collectLiveAuctioneers() {
  const response = await fetchResponse("https://www.liveauctioneers.com/sitemap-items-recent-0.xml.gz");
  const xml = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const urls = xmlLocations(xml).slice(0, DETAIL_LIMIT);
  return parallel(urls, 2, async (url) => {
    const html = await fetchText(url);
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    let product = null;
    for (const script of scripts) {
      try { product = findProductJson(JSON.parse(script[1])); } catch { /* keep looking */ }
      if (product) break;
    }
    if (!product?.name) return null;
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
    const externalId = product.sku || url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] || createHash("sha256").update(url).digest("hex").slice(0, 16);
    return record("liveauctioneers", "LiveAuctioneers", externalId, product.name, product.url || url, {
      currentBid: offer.price,
      endsAt: offer.availabilityEnds || offer.priceValidUntil,
      imageUrl: Array.isArray(product.image) ? product.image[0] : product.image,
      category: product.category,
    });
  });
}

async function collectGovDeals() {
  const categories = [
    "coins-currency-precious-metals",
    "clothing-jewelry-accessories",
    "consumer-electronics",
    "photographic-equipment",
    "arts-crafts-collectibles",
    "tools-non-industrial",
    "passenger-vehicles",
    "computers-parts-supplies",
  ];
  const pages = await parallel(categories, 2, async (category) => ({ category, html: await fetchText(`https://prod-seo.govdeals.com/en/${category}`) }));
  const found = new Map();
  const perCategory = Math.max(1, Math.ceil(LIMIT / Math.max(1, pages.length)));
  for (const { category, html } of pages) {
    let categoryCount = 0;
    for (const match of html.matchAll(/href=["'](\/en\/asset\/(\d+)\/\d+)["'][\s\S]{0,3000}?title=["']([^"']+)["'][\s\S]{0,3500}?(?:pAssetCurrentBid[^>]*>|Current Bid[\s\S]{0,300}?)(?:\$|USD\s*)?([\d,]+(?:\.\d{1,2})?)/gi)) {
      const [, path, id, title, price] = match;
      if (!found.has(id)) {
        found.set(id, record("govdeals", "GovDeals", id, title, safeUrl(path, "https://www.govdeals.com"), { currentBid: price, category: categoryFor(title, category.replaceAll("-", " ")) }));
        categoryCount += 1;
      }
      if (categoryCount >= perCategory) break;
    }
  }
  if (!found.size) throw new Error("GovDeals public category pages did not return parseable lot cards.");
  return [...found.values()].slice(0, LIMIT);
}

async function collectPublicSurplus() {
  const html = await fetchText("https://www.publicsurplus.com/sms/browse/home");
  const found = new Map();
  for (const match of html.matchAll(/<div class=["']auction-item["'][\s\S]{0,5000}?href=["']\/sms\/auction\/view\?auc=(\d+)["'][\s\S]{0,3000}?title=["']([^"']+)["'][\s\S]{0,1800}?Price:\s*<b[^>]*>\s*\$?([\d,]+(?:\.\d{1,2})?)[\s\S]{0,1800}?updateTimeLeftSpan\([^,]+,\s*\d+,\s*["'][^"']+["'],\s*\d+,\s*(\d+)/gi)) {
    const [, id, rawTitle, price, endEpoch] = match;
    const title = rawTitle.replace(/^#\d+\s*-\s*/, "");
    found.set(id, record("publicsurplus", "Public Surplus", id, title, `https://www.publicsurplus.com/sms/auction/view?auc=${id}`, { currentBid: price, endsAt: Number(endEpoch) }));
    if (found.size >= LIMIT) break;
  }
  if (!found.size) throw new Error("Public Surplus did not return parseable auction cards.");
  return [...found.values()];
}

async function collectPropertyRoom() {
  const xml = await fetchText("https://www.propertyroom.com/sitemap.xml");
  const urls = xmlLocations(xml).filter((url) => /\/l\/.+\/\d+\/?$/i.test(url)).slice(-DETAIL_LIMIT).reverse();
  const details = await parallel(urls, 2, async (url) => {
    const html = await fetchText(url);
    const id = url.match(/\/(\d+)\/?$/)?.[1] || html.match(/LISTING_ID\s*=\s*["']?(\d+)/i)?.[1];
    if (!id) return null;
    const title = decodeHtml(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/LISTING_TITLE\s*=\s*["']([^"']+)/i)?.[1]);
    const imageUrl = decodeHtml(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]);
    if (!title) return null;
    return { id, title, url, imageUrl };
  });
  if (!details.length) throw new Error("PropertyRoom sitemap did not return current listing pages.");
  const response = await fetchResponse("https://www.propertyroom.com/ajax/ajax.svc/GetClientListings", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.propertyroom.com", referer: "https://www.propertyroom.com/" },
    body: JSON.stringify({ actionListings: details.map((item) => ({ lid: Number(item.id) })) }),
  });
  const states = await response.json();
  const byId = new Map((Array.isArray(states) ? states : []).map((state) => [String(state.lid), state]));
  return details.map((item) => {
    const state = byId.get(item.id) || {};
    const epoch = String(state.end || "").match(/Date\((\d+)/)?.[1];
    return record("propertyroom", "PropertyRoom", item.id, item.title, item.url, {
      currentBid: state.win,
      bidCount: state.bc,
      endsAt: epoch ? Number(epoch) : null,
      imageUrl: item.imageUrl,
      status: Number(state.lstat) === 0 ? "active" : "ended",
    });
  }).filter((item) => item.currentBid > 0);
}

async function collectProxibid() {
  const indexXml = await fetchText("https://www.proxibid.com/sitemap-lots.xml");
  const indexLocations = xmlLocations(indexXml);
  const detailXml = indexLocations.some((url) => /\/lotinformation\/\d+/i.test(url))
    ? indexXml
    : await fetchText(indexLocations[0]);
  const urls = xmlLocations(detailXml).filter((url) => /\/lotinformation\/\d+/i.test(url)).slice(0, DETAIL_LIMIT);
  return parallel(urls, 2, async (url) => {
    const html = await fetchText(url);
    const id = url.match(/\/lotinformation\/(\d+)/i)?.[1];
    const title = decodeHtml(html.match(/id=["']moreInfoLotTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const currentBid = money(html.match(new RegExp(`id=["']CurrentBid:${id}["'][^>]+value=["']([^"']+)`, "i"))?.[1]);
    const bidCount = integer(html.match(/(?:Bid Count|Bids)[^\d]{0,80}(\d+)/i)?.[1]);
    const dateText = decodeHtml(html.match(/<span>\s*<span class=["']live-icon["'][^>]*><\/span>[\s\S]{0,220}?<\/span>/i)?.[0]);
    const endsAt = iso(dateText.replace(/\|/g, " "));
    const imageUrl = decodeHtml(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]);
    if (!id || !title || currentBid === null) return null;
    return record("proxibid", "Proxibid", id, title, url, { currentBid, bidCount, endsAt, imageUrl });
  });
}

async function collectBidSpotter() {
  const index = await fetchText("https://www.bidspotter.com/lots_sitemapindex");
  const sitemapUrls = xmlLocations(index).slice(0, 1);
  if (!sitemapUrls.length) throw new Error("BidSpotter sitemap index contained no lot map.");
  const sitemapResponse = await fetchResponse(sitemapUrls[0]);
  const sitemapBytes = Buffer.from(await sitemapResponse.arrayBuffer());
  const xml = sitemapUrls[0].endsWith(".gz") ? gunzipSync(sitemapBytes).toString("utf8") : sitemapBytes.toString("utf8");
  const urls = xmlLocations(xml).slice(0, DETAIL_LIMIT);
  return parallel(urls, 2, async (url) => {
    const html = await fetchText(url);
    const layer = html.match(/window\.dataLayer\.push\(\{([\s\S]*?)\}\);/i)?.[1] || "";
    const field = (name) => decodeHtml(layer.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`, "i"))?.[1]);
    const id = field("lotId") || url.match(/\/lot-([a-f0-9-]+)/i)?.[1];
    const title = field("lotName") || decodeHtml(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]);
    const bidCount = integer(field("currentBids"));
    const openingPrice = money(field("openingPrice"));
    const imageUrl = decodeHtml(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1]);
    if (!id || !title || bidCount > 0 || openingPrice === null) return null;
    return record("bidspotter", "BidSpotter", id, title, url, {
      currentBid: openingPrice,
      bidCount,
      endsAt: field("lotEndsFrom"),
      imageUrl,
      category: field("lotCategory") || field("lotPrimaryCategory"),
      status: /expired|sold|closed/i.test(field("lotStatus")) ? "ended" : "active",
    });
  });
}

const collectors = [
  ["ebay", "eBay official Browse API", collectEbay],
  ["hibid", "HiBid public lot pages", collectHiBid],
  ["liveauctioneers", "LiveAuctioneers public sitemap", collectLiveAuctioneers],
  ["govdeals", "GovDeals public category pages", collectGovDeals],
  ["publicsurplus", "Public Surplus public auction cards", collectPublicSurplus],
  ["propertyroom", "PropertyRoom public sitemap", collectPropertyRoom],
  ["proxibid", "Proxibid public current-lot sitemap", collectProxibid],
  ["bidspotter", "BidSpotter public lot sitemap", collectBidSpotter],
];

async function readEnvelope() {
  const source = await readFile(snapshotPath, "utf8");
  return JSON.parse(source.slice(source.indexOf("=") + 1).trim().replace(/;\s*$/, ""));
}

function mergeRecords(envelope, records, checkedAt) {
  const items = Array.isArray(envelope.items) ? envelope.items : [];
  const byIdentity = new Map(items.map((item) => [`${item.sourceKey}|${item.externalId}`, item]));
  for (const incoming of records) {
    const identity = `${incoming.sourceKey}|${incoming.externalId}`;
    const previous = byIdentity.get(identity);
    const bidIncreased = !previous || Number(incoming.currentBid) > Number(previous.currentBid);
    const statusEnded = incoming.status === "ended";
    const supplied = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== ""));
    const stableId = previous?.id || `feed-${incoming.sourceKey}-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    const observation = {
      observedAt: checkedAt,
      currentBid: Number(incoming.currentBid) || 0,
      bidCount: Number(incoming.bidCount) || 0,
      endsAt: incoming.endsAt || null,
    };
    const observations = bidIncreased
      ? [...(Array.isArray(previous?.observations) ? previous.observations : []), observation].slice(-250)
      : (Array.isArray(previous?.observations) ? previous.observations : []);
    byIdentity.set(identity, {
      ...(previous || {}),
      ...supplied,
      id: stableId,
      publishedResearch: true,
      currentBid: bidIncreased ? observation.currentBid : Number(previous?.currentBid) || 0,
      bidCount: bidIncreased ? observation.bidCount : Number(previous?.bidCount) || 0,
      observedAt: bidIncreased ? checkedAt : (previous?.observedAt || checkedAt),
      lastCheckedAt: checkedAt,
      observations,
      ...(statusEnded && Number(incoming.currentBid) > 0 ? { finalPrice: Number(incoming.currentBid) } : {}),
    });
  }
  return [...byIdentity.values()]
    .map((item) => item.resaleVertical ? item : { ...item, resaleVertical: resaleVerticalFor(item.title, item.category) })
    .slice(0, 50_000);
}

async function writeEnvelope(envelope) {
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`, "utf8");
    await rename(temporary, snapshotPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const observedAt = new Date().toISOString();
  const sourceHealth = {};
  const records = [];
  await Promise.all(collectors.map(async ([key, mode, collect]) => {
    try {
      const items = (await collect()).filter((item) => item?.externalId && item?.title && item?.url).slice(0, LIMIT);
      records.push(...items);
      sourceHealth[key] = { mode, status: items.length ? "connected" : "ready-no-records", itemCount: items.length, checkedAt: observedAt };
      console.log(`[public-markets] ${key}: ${items.length} record${items.length === 1 ? "" : "s"}.`);
    } catch (error) {
      const authorizationRequired = /credential|client_id|client_secret|secret|authorized|authorization/i.test(text(error?.message));
      sourceHealth[key] = { mode, status: authorizationRequired ? "authorization-required" : "temporarily-unavailable", itemCount: 0, checkedAt: observedAt, message: text(error?.message).slice(0, 240) };
      console.warn(`[public-markets] ${key}: ${text(error?.message, "collector failed")}`);
    }
  }));
  sourceHealth.invaluable = {
    mode: "Invaluable partner Catalog Upload API / authorized feed",
    status: "authorization-required",
    itemCount: 0,
    checkedAt: observedAt,
    message: "Invaluable does not publish a public read API; connect a permitted partner feed to ingest records.",
  };

  const envelope = await readEnvelope();
  envelope.items = mergeRecords(envelope, records, observedAt);
  envelope.observedAt = records.length ? observedAt : envelope.observedAt;
  envelope.lastCheckedAt = observedAt;
  envelope.sourceMode = "multi-marketplace-live-snapshots";
  envelope.sourceHealth = { ...(envelope.sourceHealth || {}), ...sourceHealth };
  envelope.sourceNotes = [
    ...(Array.isArray(envelope.sourceNotes) ? envelope.sourceNotes : []),
    `Public marketplace collectors checked ${collectors.length} sources at ${observedAt}; ${records.length} real records were available in this run.`,
    "Invaluable remains authorization-only because its published API is for catalog uploads, not public listing reads.",
  ].slice(-20);
  await writeEnvelope(envelope);
  console.log(`[public-markets] Published ${records.length} public marketplace record${records.length === 1 ? "" : "s"}.`);
}

if (process.env.BIDAI_PUBLIC_MARKETS_TEST !== "true") {
  main().catch((error) => {
    console.error(`[public-markets] ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  categoryFor,
  collectBidSpotter,
  collectGovDeals,
  collectHiBid,
  collectLiveAuctioneers,
  collectPropertyRoom,
  collectProxibid,
  collectPublicSurplus,
  decodeHtml,
  findProductJson,
  modelKey,
  record,
  xmlLocations,
};
