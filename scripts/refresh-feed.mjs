import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const AUTHORIZED_VALUE = "true";
const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const MAX_HISTORY_POINTS = 250;
const MAX_RETAINED_ITEMS = 5_000;
const MAX_RESPONSE_BYTES = 20_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const APIFY_API_ORIGIN = "https://api.apify.com";

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

function bearerToken(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 8_192 || /[\r\n]/.test(raw)) {
    throw new Error(`${label} is not a valid bearer token.`);
  }
  return raw;
}

function feedRequestConfiguration(environment) {
  const apifyDatasetId = text(environment.BIDAI_APIFY_DATASET_ID);
  if (apifyDatasetId) {
    if (!/^[a-zA-Z0-9._~-]{1,200}$/.test(apifyDatasetId)) {
      throw new Error("BIDAI_APIFY_DATASET_ID must be an Apify dataset ID or username~dataset-name.");
    }

    const feedUrl = new URL(`/v2/datasets/${encodeURIComponent(apifyDatasetId)}/items`, APIFY_API_ORIGIN);
    feedUrl.searchParams.set("format", "json");
    feedUrl.searchParams.set("clean", "true");
    feedUrl.searchParams.set("desc", "1");
    feedUrl.searchParams.set("limit", String(MAX_RETAINED_ITEMS));

    const headers = { accept: "application/json" };
    const token = bearerToken(environment.BIDAI_APIFY_TOKEN, "BIDAI_APIFY_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;

    return {
      feedUrl,
      headers,
      sourceMode: "apify-dataset",
      sourceLabel: "Apify dataset",
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
    sourceLabel: "Authorized feed",
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

function stableIdentity(record, normalized) {
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
  const identitySeed = suppliedId || normalized.url || [normalized.title, normalized.category, normalized.endsAt].join("|");
  const label = slug(suppliedId || normalized.title) || "item";
  return {
    id: `feed-${label}-${digest(identitySeed).slice(0, 12)}`,
    externalId: suppliedId || `derived-${digest(identitySeed).slice(0, 16)}`,
  };
}

function normalizeStatus(value, finalPrice, endsAt) {
  const raw = text(value, "active").toLowerCase();
  if (finalPrice > 0 || ["ended", "closed", "complete", "completed", "sold"].some((word) => raw.includes(word))) {
    return "ended";
  }
  if (endsAt && Date.parse(endsAt) <= Date.now()) return "ended";
  return "active";
}

function normalizeObservation(point, defaults) {
  const observedAt = timestamp(
    pick(point, "observedAt", "observed_at", "capturedAt", "captured_at", "timestamp"),
    defaults.observedAt,
  );
  if (!observedAt) return null;

  return {
    observedAt,
    currentBid: money(pick(point, "currentBid", "current_bid", "price", "bidAmount", "bid_amount"), defaults.currentBid),
    bidCount: integer(pick(point, "bidCount", "bid_count", "bids"), defaults.bidCount),
    expectedClose: money(pick(point, "expectedClose", "expected_close", "predictedFinal", "predicted_final"), defaults.expectedClose),
    status: normalizeStatus(pick(point, "status", "state"), defaults.finalPrice, defaults.endsAt),
  };
}

function mergeObservations(...collections) {
  const byTimestamp = new Map();
  for (const collection of collections) {
    for (const observation of Array.isArray(collection) ? collection : []) {
      if (observation?.observedAt) byTimestamp.set(observation.observedAt, observation);
    }
  }
  return [...byTimestamp.values()]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .slice(-MAX_HISTORY_POINTS);
}

function externalIdentityKey(value) {
  return text(value).toLowerCase();
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

function recordObservedAt(record) {
  return timestamp(pick(record, "observedAt", "observed_at", "capturedAt", "captured_at", "timestamp"));
}

function normalizeRecord(record, index, capturedAt, sourceLabel = "Authorized feed", requireObservedAt = false) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const title = text(pick(record, "title", "name", "listingTitle", "listing_title"));
  if (!title) return null;

  const currentBid = money(pick(record, "currentBid", "current_bid", "currentPrice", "current_price", "price", "bidAmount", "bid_amount"));
  const finalPrice = money(pick(record, "finalPrice", "final_price", "soldPrice", "sold_price"), 0);
  const endsAt = timestamp(pick(record, "endsAt", "ends_at", "endTime", "end_time", "closeTime", "close_time"));
  const suppliedObservedAt = recordObservedAt(record);
  if (requireObservedAt && !suppliedObservedAt) return null;
  const observedAt = suppliedObservedAt || capturedAt;
  const expectedClose = money(pick(record, "expectedClose", "expected_close", "predictedFinal", "predicted_final"), 0);
  const normalized = {
    title,
    category: text(pick(record, "category", "department", "type"), "Unclassified"),
    url: httpUrl(pick(record, "url", "sourceUrl", "source_url", "listingUrl", "listing_url")),
    endsAt,
  };
  const identity = stableIdentity(record, normalized);
  const status = normalizeStatus(pick(record, "status", "state"), finalPrice, endsAt);
  const bid = Math.max(currentBid, finalPrice);
  const defaults = {
    observedAt,
    currentBid: bid,
    bidCount: integer(pick(record, "bidCount", "bid_count", "bids")),
    expectedClose,
    finalPrice,
    endsAt,
  };
  const suppliedHistory = pick(record, "observations", "history", "snapshots", "bidHistory", "bid_history");
  const history = (Array.isArray(suppliedHistory) ? suppliedHistory : [])
    .map((point) => normalizeObservation(point, defaults))
    .filter(Boolean);
  const currentObservation = normalizeObservation(record, defaults);

  return {
    id: identity.id,
    externalId: identity.externalId,
    source: text(pick(record, "source", "sourceName", "source_name"), sourceLabel),
    url: normalized.url,
    sourceUrl: normalized.url,
    imageUrl: httpUrl(pick(record, "imageUrl", "image_url", "thumbnailUrl", "thumbnail_url")),
    title: normalized.title,
    category: normalized.category,
    status,
    currentBid: bid,
    shipping: money(pick(record, "shipping", "shippingCost", "shipping_cost")),
    bidCount: defaults.bidCount,
    endsAt,
    expectedClose,
    resaleLow: money(pick(record, "resaleLow", "resale_low")),
    resaleMedian: money(pick(record, "resaleMedian", "resale_median", "resaleValue", "resale_value")),
    resaleHigh: money(pick(record, "resaleHigh", "resale_high")),
    finalPrice: finalPrice || null,
    demand: score(pick(record, "demand", "demandScore", "demand_score"), 50),
    rarity: score(pick(record, "rarity", "rarityScore", "rarity_score")),
    identityConfidence: ratio(pick(record, "identityConfidence", "identity_confidence"), 0.35),
    conditionConfidence: ratio(pick(record, "conditionConfidence", "condition_confidence"), 0.35),
    compCount: integer(pick(record, "compCount", "comp_count", "comparableCount", "comparable_count")),
    compRecencyDays: integer(pick(record, "compRecencyDays", "comp_recency_days"), 365),
    identifiedAs: text(pick(record, "identifiedAs", "identified_as"), "Feed-provided identity; verify before bidding"),
    publishedResearch: true,
    marketplaceFee: percentage(pick(record, "marketplaceFee", "marketplace_fee"), 0),
    taxRate: percentage(pick(record, "taxRate", "tax_rate")),
    buyerPremium: percentage(pick(record, "buyerPremium", "buyer_premium")),
    outboundShipping: money(pick(record, "outboundShipping", "outbound_shipping"), 0),
    repairReserve: money(pick(record, "repairReserve", "repair_reserve"), 0),
    returnReserve: money(pick(record, "returnReserve", "return_reserve"), 0),
    observedAt,
    observations: mergeObservations(history, currentObservation ? [currentObservation] : []),
    feedOrder: index,
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
  const serialized = JSON.stringify(envelope, null, 2)
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
  if (process.env.BIDAI_SOURCE_AUTHORIZED !== AUTHORIZED_VALUE) {
    console.log("[refresh-feed] No-op: BIDAI_SOURCE_AUTHORIZED must be exactly 'true'. No network request was made.");
    return;
  }

  const requestConfiguration = feedRequestConfiguration(process.env);

  let response;
  try {
    response = await fetch(requestConfiguration.feedUrl, {
      headers: requestConfiguration.headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The authorized feed request failed.");
  }
  if (!response.ok) throw new Error(`The authorized feed returned HTTP ${response.status}.`);

  let payload;
  try {
    payload = await readJsonResponse(response);
  } catch (error) {
    if (String(error?.message || "").includes("exceeds the 20 MB limit")) throw error;
    throw new Error("The authorized feed did not return valid JSON.");
  }

  const records = extractRecords(payload);
  if (!records.length) throw new Error("The authorized feed contained no item records.");

  const isApifyDataset = requestConfiguration.sourceMode === "apify-dataset";
  const recordEntries = records.map((record, originalIndex) => ({
    record,
    originalIndex,
    observedAt: recordObservedAt(record),
  }));
  if (isApifyDataset && recordEntries.some((entry) => !entry.observedAt)) {
    throw new Error("Every Apify dataset item must include a valid observedAt timestamp.");
  }
  if (isApifyDataset && recordEntries.some(({ record }) => {
    const currency = text(pick(record, "currency", "currencyCode", "currency_code", "priceCurrency")).toUpperCase();
    return currency && currency !== "USD";
  })) {
    throw new Error("Apify dataset monetary fields must be denominated in USD.");
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
  const normalized = recordEntries
    .map((entry, index) => normalizeRecord(
      entry.record,
      index,
      capturedAt,
      requestConfiguration.sourceLabel,
      isApifyDataset,
    ))
    .filter(Boolean);
  if (!normalized.length) throw new Error("The authorized feed contained no records with a title.");

  const previousEnvelope = await readPreviousEnvelope();
  const previousById = new Map(previousEnvelope.items.map((item) => [item.id, item]));
  const previousByExternalId = new Map(
    previousEnvelope.items
      .map((item) => [externalIdentityKey(item?.externalId), item])
      .filter(([key]) => key),
  );
  const matchedPreviousIds = new Set();
  const mergedById = new Map();
  for (const item of normalized) {
    const previous = previousById.get(item.id) || previousByExternalId.get(externalIdentityKey(item.externalId));
    const retainedId = previous?.id || item.id;
    const duplicate = mergedById.get(retainedId);
    if (previous?.id) matchedPreviousIds.add(previous.id);
    mergedById.set(retainedId, {
      ...(previous || {}),
      ...(duplicate || {}),
      ...item,
      id: retainedId,
      observations: mergeObservations(previous?.observations, duplicate?.observations, item.observations),
    });
  }

  for (const previous of previousEnvelope.items) {
    if (!previous?.id || matchedPreviousIds.has(previous.id) || mergedById.has(previous.id)) continue;
    mergedById.set(previous.id, previous);
  }

  const items = [...mergedById.values()]
    .map(({ feedOrder: _feedOrder, ...item }) => item)
    .map(reconcileRetainedStatus)
    .sort(retentionOrder)
    .slice(0, MAX_RETAINED_ITEMS);
  const incomingNotes = pick(payload, "sourceNotes", "source_notes", "notes");
  const sourceNotes = (Array.isArray(incomingNotes) ? incomingNotes : [])
    .map((note) => text(note))
    .filter(Boolean);
  const envelope = {
    observedAt: capturedAt,
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
