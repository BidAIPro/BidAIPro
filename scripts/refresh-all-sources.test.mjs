import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-multisource-test-"));
  const scripts = join(root, "scripts");
  const data = join(root, "data");
  await mkdir(scripts, { recursive: true });
  await mkdir(data, { recursive: true });
  await copyFile(join(sourceDirectory, "refresh-feed.mjs"), join(scripts, "refresh-feed.mjs"));
  await copyFile(join(sourceDirectory, "refresh-all-sources.mjs"), join(scripts, "refresh-all-sources.mjs"));
  return { root, scripts, data, outputPath: join(data, "live-snapshots.js") };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  assert.ok(source.startsWith(OUTPUT_PREFIX));
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("authorization guard leaves the published multi-market file unchanged", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const original = `${OUTPUT_PREFIX}${JSON.stringify({ observedAt: null, sourceMode: "published", sourceNotes: [], items: [] })};\n`;
  await writeFile(fixture.outputPath, original, "utf8");

  const result = await runNode([join(fixture.scripts, "refresh-all-sources.mjs")], {
    cwd: fixture.root,
    env: { ...process.env, BIDAI_SOURCE_AUTHORIZED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(fixture.outputPath, "utf8"), original);
});

test("two marketplace Datasets merge real records without cross-site ID collisions", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "mock-multisource-fetch.mjs");
  await writeFile(preloadPath, `
    const records = {
      "shopgoodwill-data": [{
        externalId: "lot-42",
        title: "ShopGoodwill camera lot",
        url: "https://shopgoodwill.com/item/42",
        currentBid: 120,
        observedAt: "2026-08-02T12:00:00.000Z"
      }],
      "ebay-data": [{
        externalId: "lot-42",
        title: "eBay watch auction",
        url: "https://www.ebay.com/itm/42",
        currentBid: 220,
        observedAt: "2026-08-02T12:05:00.000Z"
      }]
    };
    globalThis.fetch = async (url) => {
      const match = String(url).match(/\\/datasets\\/([^/]+)\\/items/);
      const payload = match ? records[decodeURIComponent(match[1])] : null;
      if (!payload) throw new Error("Unexpected test request: " + url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode([join(fixture.scripts, "refresh-all-sources.mjs")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(preloadPath).href}`.trim(),
      BIDAI_SOURCE_AUTHORIZED: "true",
      BIDAI_APIFY_TOKEN: "test-token",
      BIDAI_SOURCE_CONFIG_JSON: JSON.stringify([
        { key: "shopgoodwill", name: "ShopGoodwill", datasetId: "shopgoodwill-data" },
        { key: "ebay", name: "eBay Auctions", datasetId: "ebay-data" },
      ]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(fixture.outputPath);
  assert.equal(envelope.items.length, 2);
  assert.equal(new Set(envelope.items.map((item) => item.id)).size, 2);
  assert.deepEqual(new Set(envelope.items.map((item) => item.sourceKey)), new Set(["shopgoodwill", "ebay"]));
  assert.ok(envelope.items.every((item) => item.url === item.sourceUrl));
});

test("a near-close source starts its Apify Task and imports the successful run Dataset", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = Date.now();
  const existing = {
    observedAt: new Date(now - 6 * 60_000).toISOString(),
    sourceMode: "published",
    sourceNotes: [],
    items: [{
      id: "existing-shopgoodwill",
      externalId: "existing-shopgoodwill",
      sourceKey: "shopgoodwill",
      source: "ShopGoodwill",
      sourceUrl: "https://shopgoodwill.com/item/existing",
      title: "Existing live listing",
      status: "active",
      endsAt: new Date(now + 30 * 60_000).toISOString(),
      observedAt: new Date(now - 6 * 60_000).toISOString(),
      observations: [],
    }],
  };
  await writeFile(fixture.outputPath, `${OUTPUT_PREFIX}${JSON.stringify(existing)};\n`, "utf8");
  const preloadPath = join(fixture.root, "mock-task-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes("/actor-tasks/shopgoodwill-task/runs")) {
        if (options.method !== "POST") throw new Error("Task was not started with POST");
        return new Response(JSON.stringify({ data: { status: "SUCCEEDED", defaultDatasetId: "fresh-run-data" } }), { status: 200 });
      }
      if (value.includes("/datasets/fresh-run-data/items")) {
        return new Response(JSON.stringify([{
          externalId: "fresh-lot",
          title: "Fresh near-close listing",
          url: "https://shopgoodwill.com/item/fresh-lot",
          currentBid: 310,
          observedAt: new Date().toISOString()
        }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("Unexpected test request: " + value);
    };
  `, "utf8");

  const result = await runNode([join(fixture.scripts, "refresh-all-sources.mjs")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(preloadPath).href}`.trim(),
      BIDAI_SOURCE_AUTHORIZED: "true",
      BIDAI_APIFY_TOKEN: "test-token",
      BIDAI_SOURCE_CONFIG_JSON: JSON.stringify([
        { key: "shopgoodwill", name: "ShopGoodwill", taskId: "shopgoodwill-task" },
      ]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /adaptive snapshot window/);
  const envelope = await readEnvelope(fixture.outputPath);
  const fresh = envelope.items.find((item) => item.externalId === "fresh-lot");
  assert.ok(fresh);
  assert.equal(fresh.sourceKey, "shopgoodwill");
  assert.equal(fresh.source, "ShopGoodwill");
});
