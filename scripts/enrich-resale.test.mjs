import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./enrich-resale.mjs", import.meta.url));

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

async function fixtureWithItem() {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-resale-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-resale.mjs"));
  const envelope = {
    observedAt: new Date().toISOString(),
    sourceMode: "test",
    sourceNotes: [],
    items: [{
      id: "shopgoodwill-123",
      externalId: "123",
      sourceKey: "shopgoodwill",
      source: "ShopGoodwill",
      title: "Exact Model X Camera",
      category: "Electronics",
      resaleVertical: "Electronics",
      modelKey: "camera:model-x",
      url: "https://shopgoodwill.com/item/123",
      status: "active",
      currentBid: 50,
      bidCount: 8,
      observedAt: new Date().toISOString(),
      comparableSales: [],
    }],
  };
  const path = join(root, "data", "live-snapshots.js");
  await writeFile(path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  return { root, path, envelope };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("authorization guard makes no request and leaves snapshots byte-stable", async (t) => {
  const fixture = await fixtureWithItem();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const before = await readFile(fixture.path, "utf8");
  const result = await runNode([join(fixture.root, "scripts", "enrich-resale.mjs")], {
    cwd: fixture.root,
    env: { ...process.env, BIDAI_RESALE_SOURCE_AUTHORIZED: "false", BIDAI_RESALE_FEED_URL: "https://feed.example.com/comps" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(fixture.path, "utf8"), before);
});

test("completed exact-model sales produce median, quick-sale price, and liquidity", async (t) => {
  const fixture = await fixtureWithItem();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = new Date();
  const asOf = now.toISOString();
  const soldAt = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString();
  const payload = {
    items: [{
      sourceKey: "shopgoodwill",
      externalId: "123",
      modelKey: "camera:model-x",
      channel: "eBay completed sales",
      asOf,
      lookbackDays: 90,
      soldListingCount: 6,
      activeListingCount: 4,
      medianDaysToSell: 10,
      query: "exact model x camera",
      comparableSales: [
        { id: "sale-1", title: "Model X one", soldPrice: 100, soldAt: soldAt(3), source: "eBay", modelKey: "camera:model-x", matchScore: 96 },
        { id: "sale-2", title: "Model X two", soldPrice: 150, soldAt: soldAt(2), source: "eBay", modelKey: "camera:model-x", matchScore: 95 },
        { id: "sale-3", title: "Model X three", soldPrice: 200, soldAt: soldAt(1), source: "eBay", modelKey: "camera:model-x", matchScore: 94 },
      ],
    }],
  };
  const preload = join(fixture.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== "https://feed.example.com/comps") throw new Error("Unexpected URL");
      if (options.method !== "POST") throw new Error("Expected POST");
      if (options.headers.authorization !== "Bearer resale-token") throw new Error("Missing token");
      const request = JSON.parse(options.body);
      if (request.targets[0].modelKey !== "camera:model-x") throw new Error("Missing target model");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(fixture.root, "scripts", "enrich-resale.mjs")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      BIDAI_RESALE_SOURCE_AUTHORIZED: "true",
      BIDAI_RESALE_FEED_URL: "https://feed.example.com/comps",
      BIDAI_RESALE_FEED_TOKEN: "resale-token",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(fixture.path)).items[0];
  assert.equal(item.resaleLow, 120);
  assert.equal(item.resaleMedian, 150);
  assert.equal(item.resaleHigh, 180);
  assert.equal(item.comparableSales.length, 3);
  assert.equal(item.resaleMarket.status, "available");
  assert.equal(item.resaleMarket.sellThroughRate, 0.6);
  assert.equal(item.resaleMarket.liquidityScore, 67);
  assert.equal(item.resaleMarket.liquidityLabel, "strong");
  assert.equal(item.resaleMarket.quickSalePrice, 120);
  assert.equal(item.resaleMarketHistory.length, 1);
  assert.equal(item.resaleMarketHistory[0].priceMedian, 150);
});

test("asking-only or malformed results never become sold-price evidence", async (t) => {
  const fixture = await fixtureWithItem();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const before = await readFile(fixture.path, "utf8");
  const payload = { items: [{
    sourceKey: "shopgoodwill",
    externalId: "123",
    modelKey: "camera:model-x",
    asOf: new Date().toISOString(),
    lookbackDays: 90,
    soldListingCount: 3,
    activeListingCount: 20,
    comparableSales: [
      { id: "active-1", title: "Active asking price", price: 999, source: "eBay", modelKey: "camera:model-x", matchScore: 99 },
    ],
  }] };
  const preload = join(fixture.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(fixture.root, "scripts", "enrich-resale.mjs")], {
    cwd: fixture.root,
    env: {
      ...process.env,
      BIDAI_RESALE_SOURCE_AUTHORIZED: "true",
      BIDAI_RESALE_FEED_URL: "https://feed.example.com/comps",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(fixture.path, "utf8"), before);
});
