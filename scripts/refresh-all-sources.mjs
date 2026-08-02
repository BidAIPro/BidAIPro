import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const AUTHORIZED_VALUE = "true";
const MAX_SOURCES = 20;
const MAX_PARALLEL_COLLECTORS = 4;
const APIFY_API_ORIGIN = "https://api.apify.com";
const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const refreshScript = join(root, "scripts", "refresh-feed.mjs");
const snapshotPath = join(root, "data", "live-snapshots.js");

function text(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function sourceKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeId(value, label) {
  const normalized = text(value);
  if (!/^[a-zA-Z0-9._~-]{1,200}$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function httpsUrl(value, label) {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== "https:") throw new Error("protocol");
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
}

function parseJsonConfig(value) {
  const raw = text(value);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BIDAI_SOURCE_CONFIG_JSON must be a JSON array.");
  }
  if (!Array.isArray(parsed)) throw new Error("BIDAI_SOURCE_CONFIG_JSON must be a JSON array.");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Source config entry ${index + 1} must be an object.`);
    }
    const key = sourceKey(entry.key || entry.sourceKey || entry.name);
    if (!key) throw new Error(`Source config entry ${index + 1} needs a key.`);
    const name = text(entry.name, key);
    const taskId = entry.taskId ? safeId(entry.taskId, `Task ID for ${name}`) : null;
    const datasetId = entry.datasetId ? safeId(entry.datasetId, `Dataset ID for ${name}`) : null;
    const feedUrl = entry.feedUrl ? httpsUrl(entry.feedUrl, `Feed URL for ${name}`) : null;
    if (!taskId && !datasetId && !feedUrl) throw new Error(`${name} needs a taskId, datasetId, or feedUrl.`);
    return { key, name, taskId, datasetId, feedUrl };
  });
}

function parseSimpleList(value) {
  return text(value)
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseUrlList(value) {
  const raw = text(value);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("BIDAI_FEED_URLS must be a JSON array or newline-separated URLs."); }
    if (!Array.isArray(parsed)) throw new Error("BIDAI_FEED_URLS must be a JSON array or newline-separated URLs.");
    return parsed.map(String);
  }
  return raw.split(/[\r\n]+/).map((entry) => entry.trim()).filter(Boolean);
}

async function readExistingItems() {
  try {
    const source = await readFile(snapshotPath, "utf8");
    if (source.startsWith(OUTPUT_PREFIX)) {
      return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, "")).items || [];
    }
    const sandbox = { window: {} };
    runInNewContext(source, sandbox, { timeout: 1_000 });
    return sandbox.window.BIDAI_LIVE_SNAPSHOTS?.items || [];
  } catch {
    return [];
  }
}

function snapshotIntervalMinutes(item, now) {
  const end = Date.parse(item?.endsAt || "");
  if (item?.status === "ended" && Number(item?.finalPrice) > 0) return 360;
  if (Number.isFinite(end) && end <= now) {
    const hoursAfterClose = (now - end) / 3_600_000;
    return hoursAfterClose <= 1 ? 5 : hoursAfterClose <= 24 ? 60 : 360;
  }
  if (item?.status === "ended") return 60;
  if (!Number.isFinite(end)) return 360;
  const hours = (end - now) / 3_600_000;
  return hours <= 1 ? 5 : hours <= 6 ? 15 : hours <= 24 ? 60 : 360;
}

function taskIsDue(config, items, now) {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || process.env.BIDAI_FORCE_COLLECTORS === "true") return true;
  const relevant = items.filter((item) => {
    const explicit = sourceKey(item?.sourceKey || item?.marketplaceKey || item?.source);
    if (explicit === config.key || explicit.startsWith(`${config.key}-`)) return true;
    try {
      const host = new URL(item?.sourceUrl || item?.url || "").hostname
        .toLowerCase()
        .replace(/^www\./, "");
      return host === `${config.key}.com` || host.endsWith(`.${config.key}.com`);
    } catch {
      return false;
    }
  });
  if (!relevant.length) return true;
  return relevant.some((item) => {
    const observed = Date.parse(item?.observedAt || "");
    const interval = snapshotIntervalMinutes(item, now);
    return !Number.isFinite(observed) || now - observed >= interval * 60_000;
  });
}

async function runApifyTask(config, token) {
  if (!token) throw new Error(`BIDAI_APIFY_TOKEN is required to run the ${config.name} collector task.`);
  const endpoint = new URL(`/v2/actor-tasks/${encodeURIComponent(config.taskId)}/runs`, APIFY_API_ORIGIN);
  endpoint.searchParams.set("waitForFinish", "240");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(250_000),
  });
  if (!response.ok) throw new Error(`${config.name} collector returned HTTP ${response.status}.`);
  const payload = await response.json();
  const status = text(payload?.data?.status).toUpperCase();
  if (status && status !== "SUCCEEDED") {
    throw new Error(`${config.name} collector did not finish successfully (status: ${status}).`);
  }
  const datasetId = text(payload?.data?.defaultDatasetId);
  if (!datasetId) throw new Error(`${config.name} collector did not return a Dataset ID.`);
  return safeId(datasetId, `Dataset ID returned by ${config.name}`);
}

function runRefresh(config, datasetId = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [refreshScript], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        BIDAI_APIFY_DATASET_ID: datasetId || "",
        BIDAI_FEED_URL: datasetId ? "" : (config.feedUrl || ""),
        BIDAI_SOURCE_KEY_OVERRIDE: config.key,
        BIDAI_SOURCE_LABEL_OVERRIDE: config.name,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${config.name} refresh exited with code ${code}.`)));
  });
}

function buildSources(environment) {
  const configured = parseJsonConfig(environment.BIDAI_SOURCE_CONFIG_JSON);
  const datasets = parseSimpleList(environment.BIDAI_APIFY_DATASET_IDS).map((datasetId, index) => ({
    key: `dataset-${index + 1}`,
    name: `Apify dataset ${index + 1}`,
    taskId: null,
    datasetId: safeId(datasetId, `Dataset ID ${index + 1}`),
    feedUrl: null,
  }));
  const feeds = parseUrlList(environment.BIDAI_FEED_URLS).map((feedUrl, index) => ({
    key: `feed-${index + 1}`,
    name: `Authorized feed ${index + 1}`,
    taskId: null,
    datasetId: null,
    feedUrl: httpsUrl(feedUrl, `Feed URL ${index + 1}`),
  }));
  if (text(environment.BIDAI_APIFY_DATASET_ID)) {
    datasets.unshift({
      key: sourceKey(environment.BIDAI_SOURCE_KEY_OVERRIDE) || "primary-dataset",
      name: text(environment.BIDAI_SOURCE_LABEL_OVERRIDE, "Primary Apify dataset"),
      taskId: null,
      datasetId: safeId(environment.BIDAI_APIFY_DATASET_ID, "BIDAI_APIFY_DATASET_ID"),
      feedUrl: null,
    });
  } else if (text(environment.BIDAI_FEED_URL)) {
    feeds.unshift({
      key: sourceKey(environment.BIDAI_SOURCE_KEY_OVERRIDE) || "primary-feed",
      name: text(environment.BIDAI_SOURCE_LABEL_OVERRIDE, "Primary authorized feed"),
      taskId: null,
      datasetId: null,
      feedUrl: httpsUrl(environment.BIDAI_FEED_URL, "BIDAI_FEED_URL"),
    });
  }
  const sources = [...configured, ...datasets, ...feeds];
  if (sources.length > MAX_SOURCES) throw new Error(`At most ${MAX_SOURCES} sources may be refreshed in one run.`);
  const seen = new Set();
  return sources.filter((entry) => {
    const fingerprint = `${entry.key}|${entry.taskId || ""}|${entry.datasetId || ""}|${entry.feedUrl || ""}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
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

async function prepareSource(config, existingItems, now, token) {
  let datasetId = config.datasetId;
  if (config.taskId && taskIsDue(config, existingItems, now)) {
    console.log(`[refresh-all-sources] Running ${config.name} collector for its adaptive snapshot window.`);
    datasetId = await runApifyTask(config, token);
  } else if (config.taskId) {
    console.log(`[refresh-all-sources] ${config.name} collector is not due yet; reusing its configured Dataset.`);
  }
  return { config, datasetId };
}

async function run() {
  if (process.env.BIDAI_SOURCE_AUTHORIZED !== AUTHORIZED_VALUE) {
    console.log("[refresh-all-sources] No-op: BIDAI_SOURCE_AUTHORIZED must be exactly 'true'.");
    return;
  }
  const sources = buildSources(process.env);
  if (!sources.length) {
    console.log("[refresh-all-sources] No configured auction sources; existing published data was left unchanged.");
    return;
  }
  const existingItems = await readExistingItems();
  const now = Date.now();
  const token = text(process.env.BIDAI_APIFY_TOKEN);
  const preparedSources = await mapWithConcurrency(
    sources,
    MAX_PARALLEL_COLLECTORS,
    (config) => prepareSource(config, existingItems, now, token),
  );
  for (const { config, datasetId } of preparedSources) {
    if (!datasetId && !config.feedUrl) {
      console.log(`[refresh-all-sources] ${config.name} has no Dataset available in this interval; existing records were retained.`);
      continue;
    }
    await runRefresh(config, datasetId);
  }
}

run().catch((error) => {
  console.error(`[refresh-all-sources] ${error.message}`);
  process.exitCode = 1;
});
