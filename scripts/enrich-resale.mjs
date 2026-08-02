import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const AUTHORIZED_VALUE = "true";
const MAX_RESPONSE_BYTES = 20_000_000;
const MAX_COMPARABLES = 50;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "data", "live-snapshots.js");

function text(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function timestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function percentage(value) {
  if (value === null || value === undefined || value === "") return null;
  let parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  if (String(value).includes("%") || parsed > 1) parsed /= 100;
  return parsed >= 0 && parsed <= 1 ? parsed : null;
}

function httpsUrl(value) {
  try {
    const parsed = new URL(text(value));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function httpUrl(value) {
  try {
    const parsed = new URL(text(value));
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizedModelKey(value) {
  return text(value).toLowerCase().replace(/\s+/g, " ").replace(/\s*([:|/])\s*/g, "$1");
}

function stableComparableKey(value) {
  const id = text(value?.externalId || value?.id).toLowerCase();
  if (id) return `id:${text(value?.source).toLowerCase()}:${id}`;
  const url = httpUrl(value?.url || value?.sourceUrl);
  return url ? `url:${url.toLowerCase()}` : "";
}

function quantile(values, probability) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return Math.round((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) * 100) / 100;
}

function liquidityLabel(score) {
  if (score >= 80) return "hot";
  if (score >= 60) return "strong";
  if (score >= 40) return "moderate";
  return "slow";
}

async function readEnvelope() {
  const source = await readFile(outputPath, "utf8");
  if (!source.startsWith(OUTPUT_PREFIX)) throw new Error("Snapshot file has an unsupported format.");
  const envelope = JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
  if (!envelope || !Array.isArray(envelope.items)) throw new Error("Snapshot file does not contain an item array.");
  return { source, envelope };
}

function targetPriority(item) {
  const end = Date.parse(item?.endsAt || "");
  const hours = Number.isFinite(end) ? Math.max(0, (end - Date.now()) / 3_600_000) : 9999;
  const verticalBonus = item?.resaleVertical && item.resaleVertical !== "Other" ? 500 : 0;
  const authBonus = item?.authenticationStatus === "source-stated" ? 500 : 0;
  return authBonus + verticalBonus + Math.min(500, Number(item?.bidCount) || 0) + Math.max(0, 250 - hours);
}

function selectTargets(items) {
  const limit = Math.min(1_000, Math.max(1, integer(process.env.BIDAI_RESALE_BATCH_SIZE, 500)));
  const staleBefore = Date.now() - 24 * 60 * 60_000;
  return items
    .filter((item) => item?.status === "active" && text(item?.modelKey) && text(item?.title))
    .filter((item) => {
      const asOf = Date.parse(item?.resaleMarket?.asOf || "");
      return !Number.isFinite(asOf) || asOf < staleBefore;
    })
    .sort((a, b) => targetPriority(b) - targetPriority(a))
    .slice(0, limit)
    .map((item) => ({
      id: text(item.id),
      externalId: text(item.externalId),
      sourceKey: text(item.sourceKey),
      title: text(item.title).slice(0, 500),
      category: text(item.category).slice(0, 250),
      resaleVertical: text(item.resaleVertical).slice(0, 120),
      modelKey: text(item.modelKey).slice(0, 250),
      url: httpUrl(item.url || item.sourceUrl),
    }));
}

function normalizeComparable(value, target, asOf) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currency = text(value.currency || value.currencyCode || "USD").toUpperCase();
  const title = text(value.title).slice(0, 500);
  const price = money(value.soldPrice ?? value.finalPrice ?? value.price);
  const endedAt = timestamp(value.soldAt || value.endedAt);
  const outcomeObservedAt = timestamp(value.outcomeObservedAt || asOf);
  const source = text(value.source, "Authorized completed-sales feed").slice(0, 200);
  const externalId = text(value.externalId || value.id || value.listingId).slice(0, 200);
  const url = httpUrl(value.url || value.sourceUrl);
  const matchScore = percentage(value.matchScore ?? value.similarityScore);
  const modelKey = text(value.modelKey || value.compGroup || value.similarItemKey).slice(0, 250);
  const asOfTime = Date.parse(asOf);
  if (currency !== "USD" || !title || !(price > 0) || !endedAt || !outcomeObservedAt) return null;
  if (Date.parse(endedAt) > asOfTime || Date.parse(outcomeObservedAt) > asOfTime + 5 * 60_000) return null;
  if (normalizedModelKey(modelKey) !== normalizedModelKey(target.modelKey) || !(matchScore >= 0.75)) return null;
  if (!externalId && !url) return null;
  const listedAt = timestamp(value.listedAt || value.startedAt);
  const suppliedDaysToSell = Number(value.daysToSell);
  const derivedDaysToSell = listedAt ? Math.max(0, (Date.parse(endedAt) - Date.parse(listedAt)) / 86_400_000) : null;
  const daysToSell = Number.isFinite(suppliedDaysToSell) && suppliedDaysToSell >= 0
    ? Math.round(suppliedDaysToSell * 100) / 100
    : (Number.isFinite(derivedDaysToSell) ? Math.round(derivedDaysToSell * 100) / 100 : null);
  return {
    id: externalId || null,
    externalId: externalId || null,
    title,
    price,
    finalPrice: null,
    soldPrice: price,
    endedAt,
    soldAt: endedAt,
    url,
    outcomeObservedAt,
    listedAt,
    daysToSell,
    condition: text(value.condition || value.itemCondition).slice(0, 120),
    source,
    modelKey,
    matchReason: text(value.matchReason).slice(0, 500),
    matchScore: Math.round(matchScore * 10_000) / 100,
    bidAtComparableTime: null,
    hoursToClose: null,
  };
}

function normalizeResult(value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const resultExternalId = text(value.externalId);
  const resultSourceKey = text(value.sourceKey);
  const resultModelKey = text(value.modelKey);
  const identityMatches = (resultExternalId && resultSourceKey
    && resultExternalId === target.externalId && resultSourceKey === target.sourceKey)
    || (resultModelKey && normalizedModelKey(resultModelKey) === normalizedModelKey(target.modelKey));
  if (!identityMatches) return null;

  const asOf = timestamp(value.asOf || value.observedAt);
  const asOfTime = Date.parse(asOf || "");
  if (!Number.isFinite(asOfTime) || asOfTime > Date.now() + 5 * 60_000 || Date.now() - asOfTime > 30 * 86_400_000) return null;
  const lookbackDays = integer(value.lookbackDays);
  const soldListingCount = integer(value.soldListingCount ?? value.soldCount);
  const activeListingCount = integer(value.activeListingCount ?? value.activeCount);
  if (lookbackDays < 1 || lookbackDays > 365 || soldListingCount < 1) return null;

  const deduplicated = new Map();
  for (const raw of Array.isArray(value.comparableSales) ? value.comparableSales : []) {
    const comparable = normalizeComparable(raw, target, asOf);
    const key = stableComparableKey(comparable);
    if (comparable && key && !deduplicated.has(key)) deduplicated.set(key, comparable);
  }
  const comparableSales = [...deduplicated.values()].slice(0, MAX_COMPARABLES);
  if (comparableSales.length < 3 || soldListingCount < comparableSales.length) return null;
  const prices = comparableSales.map((comparable) => comparable.soldPrice);
  const priceLow = quantile(prices, 0.2);
  const priceMedian = quantile(prices, 0.5);
  const priceHigh = quantile(prices, 0.8);
  const denominator = soldListingCount + activeListingCount;
  if (!(denominator > 0)) return null;
  const sellThroughRate = Math.round((soldListingCount / denominator) * 10_000) / 10_000;
  const rawMedianDays = Number(value.medianDaysToSell);
  const compDays = comparableSales.map((entry) => entry.daysToSell).filter(Number.isFinite);
  const medianDaysToSell = Number.isFinite(rawMedianDays) && rawMedianDays >= 0
    ? Math.round(rawMedianDays * 100) / 100
    : quantile(compDays, 0.5);
  const speedFactor = medianDaysToSell === null ? 0.5 : Math.max(0, Math.min(1, 1 - medianDaysToSell / 90));
  const liquidityScore = Math.round(100 * (sellThroughRate * 0.75 + speedFactor * 0.25));
  return {
    comparableSales,
    resaleMarket: {
      status: "available",
      currency: "USD",
      sampleSize: comparableSales.length,
      priceLow,
      quickSalePrice: priceLow,
      priceMedian,
      priceHigh,
      channel: text(value.channel || value.marketplace || value.source, "Completed-sales feed").slice(0, 120),
      asOf,
      lookbackDays,
      soldListingCount,
      activeListingCount,
      sellThroughRate,
      medianDaysToSell,
      liquidityScore,
      liquidityLabel: liquidityLabel(liquidityScore),
      query: text(value.query || value.searchQuery).slice(0, 500),
    },
  };
}

async function fetchResults(feedUrl, targets) {
  const token = text(process.env.BIDAI_RESALE_FEED_TOKEN);
  if (token.length > 8_192 || /[\r\n]/.test(token)) throw new Error("BIDAI_RESALE_FEED_TOKEN is invalid.");
  const response = await fetch(feedUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ generatedAt: new Date().toISOString(), targets }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Authorized resale feed returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Authorized resale feed response is too large.");
  const source = await response.text();
  if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) throw new Error("Authorized resale feed response is too large.");
  const payload = JSON.parse(source);
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
}

async function writeAtomically(envelope) {
  const serialized = [
    "{",
    `  "observedAt": ${JSON.stringify(envelope.observedAt)},`,
    `  "sourceMode": ${JSON.stringify(envelope.sourceMode)},`,
    `  "sourceNotes": ${JSON.stringify(envelope.sourceNotes)},`,
    "  \"items\": [",
    envelope.items.map((item) => `    ${JSON.stringify(item)}`).join(",\n"),
    "  ]",
    "}",
  ].join("\n").replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const source = `${OUTPUT_PREFIX}${serialized};\n`;
  const temporaryPath = join(dirname(outputPath), `.live-snapshots.resale.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function run() {
  const feedUrl = httpsUrl(process.env.BIDAI_RESALE_FEED_URL);
  if (process.env.BIDAI_RESALE_SOURCE_AUTHORIZED !== AUTHORIZED_VALUE || !feedUrl) {
    console.log("[enrich-resale] No-op: an explicitly authorized HTTPS completed-sales feed is not configured.");
    return;
  }
  const { source, envelope } = await readEnvelope();
  const targets = selectTargets(envelope.items);
  if (!targets.length) {
    console.log("[enrich-resale] No stale active listings need completed-sales enrichment.");
    return;
  }
  const targetByExternalIdentity = new Map(targets
    .map((target) => [`external:${target.sourceKey}:${target.externalId}`, target]));
  const targetsByModel = new Map();
  for (const target of targets) {
    const key = normalizedModelKey(target.modelKey);
    if (!targetsByModel.has(key)) targetsByModel.set(key, []);
    targetsByModel.get(key).push(target);
  }
  const results = await fetchResults(feedUrl, targets);
  const byItemId = new Map();
  for (const result of results) {
    const externalTarget = targetByExternalIdentity.get(`external:${text(result?.sourceKey)}:${text(result?.externalId)}`);
    const matchingTargets = externalTarget
      ? [externalTarget]
      : (targetsByModel.get(normalizedModelKey(result?.modelKey)) || []);
    for (const target of matchingTargets) {
      const normalized = normalizeResult(result, target);
      if (normalized) byItemId.set(target.id, normalized);
    }
  }
  if (!byItemId.size) {
    console.log("[enrich-resale] Feed returned no qualifying completed-sales evidence; snapshot file is unchanged.");
    return;
  }
  const items = envelope.items.map((item) => {
    const enrichment = byItemId.get(item.id);
    if (!enrichment) return item;
    const resaleMarketHistory = [...(Array.isArray(item.resaleMarketHistory) ? item.resaleMarketHistory : []), enrichment.resaleMarket]
      .filter((entry) => entry && timestamp(entry.asOf))
      .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf))
      .filter((entry, index, values) => index === values.findIndex((candidate) => candidate.asOf === entry.asOf))
      .slice(-365);
    return {
      ...item,
      comparableSales: enrichment.comparableSales,
      resaleMarket: enrichment.resaleMarket,
      resaleMarketHistory,
      resaleLow: enrichment.resaleMarket.priceLow,
      resaleMedian: enrichment.resaleMarket.priceMedian,
      resaleHigh: enrichment.resaleMarket.priceHigh,
      compCount: enrichment.resaleMarket.sampleSize,
      compRecencyDays: Math.max(0, Math.round((Date.now() - Math.max(...enrichment.comparableSales.map((entry) => Date.parse(entry.endedAt)))) / 86_400_000)),
    };
  });
  const nextEnvelope = {
    ...envelope,
    sourceNotes: [...new Set([
      ...(Array.isArray(envelope.sourceNotes) ? envelope.sourceNotes : []),
      "Resale medians and liquidity use exact-model completed sales from the configured authorized feed; active asking prices are excluded.",
    ])],
    items,
  };
  await writeAtomically(nextEnvelope);
  if ((await readFile(outputPath, "utf8")) === source) {
    console.log("[enrich-resale] Qualifying evidence was already current.");
  } else {
    console.log(`[enrich-resale] Enriched ${byItemId.size} listing${byItemId.size === 1 ? "" : "s"} with completed-sales evidence.`);
  }
}

run().catch((error) => {
  console.error(`[enrich-resale] ${error.message}`);
  process.exitCode = 1;
});
