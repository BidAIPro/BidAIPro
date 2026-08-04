import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const USAGE = [
  "Usage:",
  "  node scripts/merge-published-snapshots.mjs --target <local> --incoming <remote>",
  "  node scripts/merge-published-snapshots.mjs <local> <remote>",
].join("\n");

const ITEM_TIME_FIELDS = [
  "lastCheckedAt",
  "observedAt",
  "updatedAt",
  "capturedAt",
  "finalObservedAt",
  "outcomeObservedAt",
];
const STATE_TIME_FIELDS = [
  "lastRunAt",
  "lastCheckedAt",
  "checkedAt",
  "researchedAt",
  "updatedAt",
  "observedAt",
  "capturedAt",
  "asOf",
  "lastAttemptAt",
  "rateLimitedAt",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizedIdentity(value) {
  return cleanText(value).toLowerCase();
}

function sourceIdentity(item) {
  return normalizedIdentity(item?.sourceKey || item?.marketplaceKey || item?.source);
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1_000 : value;
  }
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newestTime(value, fields = STATE_TIME_FIELDS) {
  if (!isPlainObject(value)) return Number.NEGATIVE_INFINITY;
  return fields.reduce((newest, field) => Math.max(newest, timestampMs(value[field])), Number.NEGATIVE_INFINITY);
}

function newestTimestamp(...values) {
  const valid = values
    .map((value) => ({ value, time: timestampMs(value) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => right.time - left.time);
  return valid[0]?.value || null;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function listingAliases(item) {
  if (!isPlainObject(item)) return [];
  const aliases = [];
  const id = normalizedIdentity(item.id);
  const source = sourceIdentity(item);
  const externalId = normalizedIdentity(item.externalId || item.listingId || item.itemId);
  if (id) aliases.push(`id:${id}`);
  if (source && externalId) aliases.push(`external:${source}:${externalId}`);
  return [...new Set(aliases)];
}

function entryTime(entry) {
  return newestTime(entry, [
    "lastCheckedAt",
    "checkedAt",
    "researchedAt",
    "observedAt",
    "updatedAt",
    "capturedAt",
    "asOf",
    "lastAttemptAt",
    "endedAt",
    "soldAt",
  ]);
}

function observationKey(entry) {
  if (!isPlainObject(entry)) return `value:${stableJson(entry)}`;
  const observedAt = normalizedIdentity(entry.observedAt || entry.capturedAt || entry.checkedAt);
  if (observedAt) return `observation:${observedAt}`;
  return `observation:${stableJson(entry)}`;
}

function comparableKey(entry) {
  if (!isPlainObject(entry)) return `value:${stableJson(entry)}`;
  const source = normalizedIdentity(entry.source || entry.sourceKey || entry.provider || entry.channel);
  const externalId = normalizedIdentity(entry.externalId || entry.id || entry.itemId || entry.listingId);
  if (externalId) return `comparable-id:${source}:${externalId}`;
  const url = normalizedIdentity(entry.url || entry.sourceUrl || entry.link);
  if (url) return `comparable-url:${url}`;
  const model = normalizedIdentity(entry.modelKey || entry.compGroup || entry.similarItemKey);
  const endedAt = normalizedIdentity(entry.endedAt || entry.soldAt || entry.asOf || entry.observedAt);
  const title = normalizedIdentity(entry.title);
  const price = Number(entry.soldPrice ?? entry.finalPrice ?? entry.totalPrice ?? entry.price);
  if (model || title || endedAt || Number.isFinite(price)) {
    return `comparable:${source}:${model}:${title}:${endedAt}:${Number.isFinite(price) ? price : ""}`;
  }
  return `comparable:${stableJson(entry)}`;
}

function historyKey(entry) {
  if (!isPlainObject(entry)) return `value:${stableJson(entry)}`;
  const at = normalizedIdentity(
    entry.researchedAt
      || entry.observedAt
      || entry.checkedAt
      || entry.asOf
      || entry.updatedAt
      || entry.capturedAt,
  );
  const source = normalizedIdentity(entry.provider || entry.source || entry.sourceKey || entry.channel);
  const query = isPlainObject(entry.query)
    ? normalizedIdentity(entry.query.key || entry.query.value || stableJson(entry.query))
    : normalizedIdentity(entry.query);
  if (at || source || query) return `history:${at}:${source}:${query}`;
  return `history:${stableJson(entry)}`;
}

function genericEntryKey(entry) {
  if (!isPlainObject(entry)) return `value:${stableJson(entry)}`;
  for (const field of ["queryKey", "key", "id"]) {
    const value = normalizedIdentity(entry[field]);
    if (value) return `${field}:${value}`;
  }
  const source = sourceIdentity(entry);
  const externalId = normalizedIdentity(entry.externalId || entry.listingId || entry.itemId);
  if (source && externalId) return `external:${source}:${externalId}`;
  const url = normalizedIdentity(entry.url || entry.sourceUrl || entry.link);
  if (url) return `url:${url}`;
  return `object:${stableJson(entry)}`;
}

function mergeTimedObjects(target, incoming, fields = STATE_TIME_FIELDS) {
  if (!isPlainObject(target)) return incoming;
  if (!isPlainObject(incoming)) return target;
  const targetTime = newestTime(target, fields);
  const incomingTime = newestTime(incoming, fields);
  // The local target wins a tie. It may contain work that has not been pushed
  // yet, while the incoming record is the last remote checkpoint.
  const newer = incomingTime > targetTime ? incoming : target;
  const older = newer === incoming ? target : incoming;
  const merged = { ...older, ...newer };
  for (const key of new Set([...Object.keys(older), ...Object.keys(newer)])) {
    const olderValue = older[key];
    const newerValue = newer[key];
    if (Array.isArray(olderValue) && Array.isArray(newerValue)) {
      merged[key] = mergeGenericArrays(olderValue, newerValue);
    } else if (isPlainObject(olderValue) && isPlainObject(newerValue)) {
      // Pass the parent-selected newer value as the local/tie winner while
      // still allowing an independently newer nested timestamp to prevail.
      merged[key] = mergeTimedObjects(newerValue, olderValue);
    }
  }
  if (Array.isArray(merged.queue)) merged.queueSize = merged.queue.length;
  return merged;
}

function mergeArrayEntries(olderValues, newerValues, keyFor) {
  const merged = new Map();
  for (const entry of [...olderValues, ...newerValues]) {
    const key = keyFor(entry);
    if (!merged.has(key)) {
      merged.set(key, entry);
      continue;
    }
    const previous = merged.get(key);
    if (isPlainObject(previous) && isPlainObject(entry)) {
      const entryIsNewer = entryTime(entry) >= entryTime(previous);
      const newer = entryIsNewer ? entry : previous;
      const older = entryIsNewer ? previous : entry;
      merged.set(key, mergeTimedObjects(newer, older));
    }
  }
  return [...merged.values()];
}

function mergeGenericArrays(olderValues = [], newerValues = []) {
  return mergeArrayEntries(olderValues, newerValues, genericEntryKey);
}

function mergeEvidenceArray(field, olderValues = [], newerValues = []) {
  if (field === "observations") return mergeArrayEntries(olderValues, newerValues, observationKey);
  if (/compar/i.test(field)) return mergeArrayEntries(olderValues, newerValues, comparableKey);
  if (/history$/i.test(field)) return mergeArrayEntries(olderValues, newerValues, historyKey);
  return newerValues;
}

function mergeListingValues(older, newer) {
  const merged = { ...older, ...newer };
  for (const field of new Set([...Object.keys(older || {}), ...Object.keys(newer || {})])) {
    const olderValue = older?.[field];
    const newerValue = newer?.[field];
    if (Array.isArray(olderValue) && Array.isArray(newerValue)
      && (field === "observations" || /compar/i.test(field) || /history$/i.test(field))) {
      merged[field] = mergeEvidenceArray(field, olderValue, newerValue);
    } else if (isPlainObject(olderValue) && isPlainObject(newerValue)) {
      // Evidence objects have their own checked/as-of timestamps. Honor those
      // independently from the listing's auction-check timestamp.
      merged[field] = mergeTimedObjects(newerValue, olderValue);
    }
  }
  return merged;
}

function mergeItems(targetItems = [], incomingItems = []) {
  const records = [
    ...targetItems.filter(isPlainObject).map((item, order) => ({ item, origin: "target", order })),
    ...incomingItems.filter(isPlainObject).map((item, order) => ({ item, origin: "incoming", order })),
  ];
  const parent = records.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const ownerByAlias = new Map();
  records.forEach(({ item }, index) => {
    for (const alias of listingAliases(item)) {
      if (ownerByAlias.has(alias)) unite(index, ownerByAlias.get(alias));
      else ownerByAlias.set(alias, index);
    }
  });

  const components = new Map();
  records.forEach((record, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(record);
  });

  return [...components.values()]
    .map((component) => {
      const ordered = component.slice().sort((left, right) => {
        const timeDifference = newestTime(left.item, ITEM_TIME_FIELDS) - newestTime(right.item, ITEM_TIME_FIELDS);
        if (timeDifference) return timeDifference;
        if (left.origin !== right.origin) return left.origin === "incoming" ? -1 : 1;
        return left.order - right.order;
      });
      const merged = ordered.reduce((result, { item }) => (
        result ? mergeListingValues(result, item) : { ...item }
      ), null);
      const retainedTargetId = component
        .filter(({ origin, item }) => origin === "target" && cleanText(item.id))
        .sort((left, right) => left.order - right.order)[0]?.item.id;
      if (retainedTargetId) merged.id = retainedTargetId;
      const targetOrder = Math.min(...component.filter(({ origin }) => origin === "target").map(({ order }) => order));
      const incomingOrder = Math.min(...component.filter(({ origin }) => origin === "incoming").map(({ order }) => order));
      return {
        item: merged,
        sortGroup: Number.isFinite(targetOrder) ? 0 : 1,
        sortOrder: Number.isFinite(targetOrder) ? targetOrder : incomingOrder,
      };
    })
    .sort((left, right) => left.sortGroup - right.sortGroup || left.sortOrder - right.sortOrder)
    .map(({ item }) => item);
}

function mergeSourceHealth(targetHealth, incomingHealth) {
  const target = isPlainObject(targetHealth) ? targetHealth : {};
  const incoming = isPlainObject(incomingHealth) ? incomingHealth : {};
  const merged = {};
  for (const source of new Set([...Object.keys(target), ...Object.keys(incoming)])) {
    if (isPlainObject(target[source]) && isPlainObject(incoming[source])) {
      merged[source] = mergeTimedObjects(target[source], incoming[source], ["checkedAt", "lastCheckedAt", "observedAt", "updatedAt"]);
    } else {
      merged[source] = target[source] ?? incoming[source];
    }
  }
  return merged;
}

function pruneSerperQueueToActiveItems(envelope) {
  const enrichment = envelope?.serperRetailEnrichment;
  if (!isPlainObject(enrichment) || !Array.isArray(enrichment.queue)) return;
  const referenceTime = Math.max(
    timestampMs(envelope.lastCheckedAt),
    timestampMs(envelope.observedAt),
  );
  const activeAliases = new Set();
  for (const item of envelope.items) {
    const endsAt = timestampMs(item?.endsAt);
    if (item?.status !== "active" || (Number.isFinite(endsAt) && Number.isFinite(referenceTime) && endsAt <= referenceTime)) continue;
    for (const alias of listingAliases(item)) activeAliases.add(alias);
    const source = sourceIdentity(item);
    const externalId = normalizedIdentity(item?.externalId || item?.listingId || item?.itemId);
    if (source && externalId) activeAliases.add(`source:${source}:${externalId}`);
  }
  enrichment.queue = enrichment.queue
    .map((entry) => {
      if (!isPlainObject(entry) || !Array.isArray(entry.listingKeys)) return entry;
      const listingKeys = entry.listingKeys.filter((key) => activeAliases.has(normalizedIdentity(key)));
      return listingKeys.length ? { ...entry, listingKeys: [...new Set(listingKeys)] } : null;
    })
    .filter(Boolean);
  enrichment.queueSize = enrichment.queue.length;
}

function mergeEnvelopes(targetEnvelope, incomingEnvelope) {
  if (!isPlainObject(targetEnvelope) || !Array.isArray(targetEnvelope.items)) {
    throw new Error("The target snapshot must contain an items array.");
  }
  if (!isPlainObject(incomingEnvelope) || !Array.isArray(incomingEnvelope.items)) {
    throw new Error("The incoming snapshot must contain an items array.");
  }
  const targetTime = newestTime(targetEnvelope, ["lastCheckedAt", "observedAt"]);
  const incomingTime = newestTime(incomingEnvelope, ["lastCheckedAt", "observedAt"]);
  const newer = incomingTime > targetTime ? incomingEnvelope : targetEnvelope;
  const older = newer === incomingEnvelope ? targetEnvelope : incomingEnvelope;
  const merged = { ...older, ...newer };
  merged.items = mergeItems(targetEnvelope.items, incomingEnvelope.items);
  merged.sourceHealth = mergeSourceHealth(targetEnvelope.sourceHealth, incomingEnvelope.sourceHealth);

  for (const key of new Set([...Object.keys(targetEnvelope), ...Object.keys(incomingEnvelope)])) {
    if (key === "items" || key === "sourceHealth") continue;
    const targetValue = targetEnvelope[key];
    const incomingValue = incomingEnvelope[key];
    if (/enrichment$/i.test(key) && isPlainObject(targetValue) && isPlainObject(incomingValue)) {
      merged[key] = mergeTimedObjects(targetValue, incomingValue);
    } else if (Array.isArray(targetValue) && Array.isArray(incomingValue)) {
      merged[key] = mergeGenericArrays(older === targetEnvelope ? targetValue : incomingValue, newer === targetEnvelope ? targetValue : incomingValue);
    }
  }

  merged.observedAt = newestTimestamp(targetEnvelope.observedAt, incomingEnvelope.observedAt);
  merged.lastCheckedAt = newestTimestamp(
    targetEnvelope.lastCheckedAt,
    targetEnvelope.observedAt,
    incomingEnvelope.lastCheckedAt,
    incomingEnvelope.observedAt,
  );
  pruneSerperQueueToActiveItems(merged);
  return merged;
}

function parseSnapshotSource(source, label = "snapshot") {
  const value = String(source ?? "").replace(/^\uFEFF/, "").trim();
  let serialized = value;
  const assignmentIndex = value.indexOf("window.BIDAI_LIVE_SNAPSHOTS");
  if (assignmentIndex >= 0) {
    const equalsIndex = value.indexOf("=", assignmentIndex);
    if (equalsIndex < 0) throw new Error(`${label} has an invalid snapshot assignment.`);
    serialized = value.slice(equalsIndex + 1).trim().replace(/;\s*$/, "");
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`${label} does not contain valid snapshot JSON.`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
    throw new Error(`${label} must contain an object with an items array.`);
  }
  return parsed;
}

function serializeSnapshot(envelope) {
  return `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
}

async function writeSnapshotAtomically(path, envelope) {
  const targetPath = resolve(path);
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeSnapshot(envelope), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function mergeSnapshotFiles(targetPath, incomingPath) {
  const resolvedTarget = resolve(targetPath);
  const resolvedIncoming = resolve(incomingPath);
  if (resolvedTarget.toLowerCase() === resolvedIncoming.toLowerCase()) {
    throw new Error("Target and incoming snapshot paths must be different.");
  }
  const [targetSource, incomingSource] = await Promise.all([
    readFile(resolvedTarget, "utf8"),
    readFile(resolvedIncoming, "utf8"),
  ]);
  const target = parseSnapshotSource(targetSource, "Target snapshot");
  const incoming = parseSnapshotSource(incomingSource, "Incoming snapshot");
  const merged = mergeEnvelopes(target, incoming);
  await writeSnapshotAtomically(resolvedTarget, merged);
  return merged;
}

function parseCliArguments(argv) {
  let target = "";
  let incoming = "";
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target" || argument === "--incoming") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
      if (argument === "--target") target = value;
      else incoming = value;
      index += 1;
    } else if (argument.startsWith("--target=")) {
      target = argument.slice("--target=".length);
    } else if (argument.startsWith("--incoming=")) {
      incoming = argument.slice("--incoming=".length);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length) {
    if (target || incoming || positional.length !== 2) {
      throw new Error("Provide either both named paths or exactly two positional paths.");
    }
    [target, incoming] = positional;
  }
  if (!target || !incoming) throw new Error("Both target and incoming snapshot paths are required.");
  return { target, incoming };
}

async function main(argv = process.argv.slice(2)) {
  const { target, incoming } = parseCliArguments(argv);
  const merged = await mergeSnapshotFiles(target, incoming);
  console.log(`[merge-published-snapshots] Merged ${merged.items.length.toLocaleString("en-US")} listing${merged.items.length === 1 ? "" : "s"} into ${resolve(target)}.`);
  return merged;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invokedPath.toLowerCase() === modulePath.toLowerCase()) {
  main().catch((error) => {
    console.error(`[merge-published-snapshots] ${error.message}\n${USAGE}`);
    process.exitCode = 1;
  });
}

export {
  mergeEnvelopes,
  mergeItems,
  mergeListingValues,
  mergeSnapshotFiles,
  mergeSourceHealth,
  parseCliArguments,
  parseSnapshotSource,
  serializeSnapshot,
  writeSnapshotAtomically,
};
