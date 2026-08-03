import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./enrich-ebay-used.mjs", import.meta.url));

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-ebay-used-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-ebay-used.mjs"));
  const envelope = {
    observedAt: new Date().toISOString(),
    sourceMode: "test",
    sourceNotes: [],
    items: [{
      id: "shopgoodwill-123",
      externalId: "123",
      sourceKey: "shopgoodwill",
      source: "ShopGoodwill",
      title: "Sony PlayStation 5 Disc Edition Console",
      category: "Electronics",
      resaleVertical: "Electronics",
      modelKey: "sony playstation 5 disc edition console",
      url: "https://shopgoodwill.com/item/123",
      status: "active",
      currentBid: 50,
      bidCount: 8,
      observedAt: new Date().toISOString(),
    }],
  };
  const path = join(root, "data", "live-snapshots.js");
  await writeFile(path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  return { root, path };
}

function listing(id, price, condition = "Used") {
  return {
    itemId: id,
    title: `Sony PlayStation 5 Disc Edition Console ${id}`,
    condition,
    price: { value: String(price), currency: "USD" },
    shippingOptions: [{ shippingCost: { value: "5", currency: "USD" } }],
    itemWebUrl: `https://www.ebay.com/itm/${id}`,
  };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("missing eBay credentials is a byte-stable no-op", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const before = await readFile(sample.path, "utf8");
  const result = await runNode([join(sample.root, "scripts", "enrich-ebay-used.mjs")], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_EBAY_CLIENT_ID: "", BIDAI_EBAY_CLIENT_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(sample.path, "utf8"), before);
});

test("five matched used listings produce online used price statistics", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const payload = { itemSummaries: [listing("one", 120), listing("two", 140), listing("three", 160), listing("four", 180), listing("five", 200)] };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes("/identity/v1/oauth2/token")) {
        if (options.method !== "POST" || !String(options.headers.authorization).startsWith("Basic ")) throw new Error("Bad OAuth request");
        return new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 });
      }
      const parsed = new URL(target);
      if (!target.includes("/buy/browse/v1/item_summary/search")) throw new Error("Unexpected URL");
      if (parsed.searchParams.get("filter") !== "conditions:{USED},buyingOptions:{FIXED_PRICE|BEST_OFFER}") throw new Error("Missing used fixed-price filter");
      if (!parsed.searchParams.get("q").split(" ").includes("5")) throw new Error("Single-digit model token was dropped");
      if (options.headers.authorization !== "Bearer test-token") throw new Error("Missing bearer token");
      return new Response(JSON.stringify(payload), { status: 200 });
    };
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-ebay-used.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_EBAY_CLIENT_ID: "client-id",
      BIDAI_EBAY_CLIENT_SECRET: "client-secret",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.askingMarket.status, "available");
  assert.equal(item.askingMarket.channel, "eBay active used listings");
  assert.equal(item.askingMarket.sampleSize, 5);
  assert.equal(item.askingMarket.priceLow, 141);
  assert.equal(item.askingMarket.priceMedian, 165);
  assert.equal(item.askingMarket.priceAverage, 165);
  assert.equal(item.askingMarket.priceHigh, 189);
  assert.equal(item.askingMarket.listings.length, 5);
  assert.equal(item.askingMarketHistory.length, 1);
});

test("new or weakly matched listings cannot create used-price evidence", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const payload = {
    itemSummaries: [
      listing("one", 120),
      listing("two", 140),
      listing("three", 160),
      listing("four", 180),
      listing("new", 999, "New"),
      { ...listing("wrong", 800), title: "Apple MacBook Pro Laptop Computer" },
    ],
  };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url) => String(url).includes("/identity/v1/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "test-token" }), { status: 200 })
      : new Response(JSON.stringify(payload), { status: 200 });
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-ebay-used.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_EBAY_CLIENT_ID: "client-id",
      BIDAI_EBAY_CLIENT_SECRET: "client-secret",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.askingMarket.status, "insufficient");
  assert.equal(item.askingMarket.sampleSize, 4);
  assert.deepEqual(item.askingMarket.listings, []);
  assert.equal(item.askingMarket.priceMedian, undefined);
  assert.equal(item.askingMarketHistory, undefined);
});
