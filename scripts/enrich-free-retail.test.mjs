import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./enrich-free-retail.mjs", import.meta.url));

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

function activeItem(id, title, vertical = "Electronics") {
  return {
    id,
    externalId: id,
    sourceKey: "shopgoodwill",
    source: "ShopGoodwill",
    title,
    modelKey: `shopgoodwill:title-exact-v1:${title.toLowerCase()}`,
    category: vertical,
    resaleVertical: vertical,
    url: `https://shopgoodwill.com/item/${id}`,
    status: "active",
    currentBid: 20,
    bidCount: 2,
    retailMarket: { status: "available", provider: "existing-source", priceMedian: 999 },
  };
}

async function fixture(items = [activeItem("one", "Sony PlayStation 5 Disc Edition Console")]) {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-free-retail-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-free-retail.mjs"));
  const path = join(root, "data", "live-snapshots.js");
  const envelope = { observedAt: new Date().toISOString(), sourceMode: "test", sourceNotes: [], items };
  await writeFile(path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  return { root, path, script: join(root, "scripts", "enrich-free-retail.mjs") };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

async function mockPreload(root, implementation) {
  const path = join(root, `mock-upc-fetch-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, implementation, "utf8");
  return pathToFileURL(path).href;
}

function currentOffer(merchant, domain, price, linkSuffix, updated = Math.floor(Date.now() / 1000)) {
  return {
    merchant,
    domain,
    title: "Sony PlayStation 5 Disc Edition Console",
    currency: "USD",
    list_price: price + 20,
    price,
    shipping: 0,
    condition: "New",
    availability: "In stock",
    link: `https://${domain}/product/${linkSuffix}`,
    updated_t: updated,
  };
}

test("an exact product with fresh offers from two merchants creates current retail evidence", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const payload = {
    total: 1,
    items: [{
      ean: "0711719542028",
      upc: "711719542028",
      title: "Sony PlayStation 5 Disc Edition Console",
      brand: "Sony",
      model: "PlayStation 5 Disc Edition",
      category: "Video Game Consoles",
      currency: "USD",
      lowest_recorded_price: 399,
      highest_recorded_price: 599,
      offers: [
        currentOffer("Best Buy", "bestbuy.com", 449, "ps5"),
        currentOffer("Walmart", "walmart.com", 469, "ps5"),
      ],
    }],
  };
  const preload = await mockPreload(sample.root, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.origin !== "https://api.upcitemdb.com" || parsed.pathname !== "/prod/trial/search") throw new Error("Wrong free endpoint");
      if (!parsed.searchParams.get("s").includes("playstation")) throw new Error("Missing title query");
      if (/shopgoodwill|title exact|v1/i.test(parsed.searchParams.get("s"))) throw new Error("Internal model-key metadata leaked into product query");
      if (parsed.searchParams.get("type") !== "product" || parsed.searchParams.get("match_mode") !== "0") throw new Error("Missing product search controls");
      if (options.headers.accept !== "application/json") throw new Error("Missing accept header");
      return new Response(JSON.stringify(payload), { status: 200 });
    };
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_FREE_RETAIL_DELAY_MS: "0",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.freeRetailMarket.provider, "upcitemdb");
  assert.equal(item.freeRetailMarket.status, "available");
  assert.equal(item.freeRetailMarket.catalog.brand, "Sony");
  assert.equal(item.freeRetailMarket.priceSummary.currentOfferCount, 2);
  assert.equal(item.freeRetailMarket.priceSummary.sourceCount, 2);
  assert.equal(item.freeRetailMarket.priceSummary.priceMedian, 459);
  assert.equal(item.freeRetailMarket.offers[0].freshness, "current");
  assert.match(item.freeRetailMarket.offers[0].listingState, /not a completed sale/i);
  assert.equal(item.freeRetailMarket.historicalReference.priceLow, 399);
  assert.equal(item.retailMarket.provider, "existing-source", "the independent existing retail field must not be overwritten");
});

test("stale merchant offers and catalog history remain separate reference-only evidence", async (t) => {
  const item = activeItem("scope", "Celestron NexStar 8SE Computerized Telescope", "Science & Education");
  const sample = await fixture([item]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const old = Math.floor((Date.now() - 400 * 86_400_000) / 1000);
  const payload = { items: [{
    title: "Celestron NexStar 8SE Computerized Telescope",
    brand: "Celestron",
    model: "NexStar 8SE",
    currency: "USD",
    lowest_recorded_price: 899,
    highest_recorded_price: 1599,
    offers: [{ ...currentOffer("Old Telescope Store", "example.com", 1299, "scope", old), title: "Celestron NexStar 8SE Telescope" }],
  }] };
  const preload = await mockPreload(sample.root, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0", TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const market = (await readEnvelope(sample.path)).items[0].freeRetailMarket;
  assert.equal(market.status, "reference-only");
  assert.equal(market.offers[0].freshness, "stale");
  assert.equal(market.priceSummary.currentOfferCount, 0);
  assert.equal(market.priceSummary.priceMedian, null);
  assert.equal(market.catalog.sampleSize, 0);
  assert.equal(market.catalog.priceMedian, null);
  assert.deepEqual([market.historicalReference.priceLow, market.historicalReference.priceHigh], [899, 1599]);
  assert.match(market.historicalReference.note, /separate from current/i);
});

test("a conflicting model generation cannot become retail evidence", async (t) => {
  const sample = await fixture([activeItem("phone", "Apple iPhone 13 Pro 256GB Smartphone", "Phones")]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const payload = { items: [{
    title: "Apple iPhone 12 Pro 256GB Smartphone",
    brand: "Apple",
    model: "iPhone 12 Pro",
    currency: "USD",
    lowest_recorded_price: 799,
    offers: [currentOffer("Phone Store", "phones.example", 899, "iphone")],
  }] };
  const preload = await mockPreload(sample.root, `
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0", TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const market = (await readEnvelope(sample.path)).items[0].freeRetailMarket;
  assert.equal(market.status, "insufficient");
  assert.equal(market.catalog, null);
  assert.match(market.reason, /conflicted|strictly match/i);
});

test("HTTP 429 records the attempted miss and stops later catalog requests", async (t) => {
  const items = [
    activeItem("camera", "GoPro Hero 12 Black Action Camera", "Cameras"),
    activeItem("console", "Nintendo Switch OLED Console", "Electronics"),
  ];
  const sample = await fixture(items);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const callFile = join(sample.root, "calls.txt");
  const preload = await mockPreload(sample.root, `
    import { writeFileSync } from "node:fs";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "retry-after": "60" } });
    };
    process.on("exit", () => writeFileSync(process.env.TEST_CALL_FILE, String(calls)));
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0", TEST_CALL_FILE: callFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(callFile, "utf8"), "1");
  const envelope = await readEnvelope(sample.path);
  const attempted = envelope.items.find((entry) => entry.freeRetailMarket);
  const unattempted = envelope.items.find((entry) => !entry.freeRetailMarket);
  assert.ok(attempted);
  assert.ok(unattempted);
  assert.equal(attempted.freeRetailMarket.status, "insufficient");
  assert.match(attempted.freeRetailMarket.reason, /rate limit/i);
  assert.ok(envelope.freeRetailEnrichment.rateLimitedAt);
});

test("duplicate product queries are fetched once and applied to every matching auction", async (t) => {
  const first = activeItem("first", "Sony PlayStation 5 Disc Edition Console");
  const second = activeItem("second", "Sony PlayStation 5 Disc Edition Console");
  const sample = await fixture([first, second]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const callFile = join(sample.root, "calls.txt");
  const payload = { items: [{
    title: "Sony PlayStation 5 Disc Edition Console",
    brand: "Sony",
    model: "PlayStation 5 Disc Edition",
    currency: "USD",
    offers: [currentOffer("Best Buy", "bestbuy.com", 449, "ps5")],
  }] };
  const preload = await mockPreload(sample.root, `
    import { writeFileSync } from "node:fs";
    const payload = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, "base64").toString("utf8"));
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(payload), { status: 200 }); };
    process.on("exit", () => writeFileSync(process.env.TEST_CALL_FILE, String(calls)));
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_FREE_RETAIL_DELAY_MS: "0",
      TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
      TEST_CALL_FILE: callFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(callFile, "utf8"), "1");
  const items = (await readEnvelope(sample.path)).items;
  assert.equal(items[0].freeRetailMarket.status, "reference-only");
  assert.equal(items[1].freeRetailMarket.status, "reference-only");
});

test("recorded misses make the next round-robin run advance to an untried group", async (t) => {
  const items = [
    activeItem("camera", "GoPro Hero 12 Black Action Camera", "Cameras"),
    activeItem("console", "Nintendo Switch OLED Console", "Electronics"),
  ];
  const sample = await fixture(items);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const callFile = join(sample.root, "queries.txt");
  const preload = await mockPreload(sample.root, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.TEST_CALL_FILE, new URL(String(url)).searchParams.get("s") + "\\n");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
  `);
  const options = {
    cwd: sample.root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0", BIDAI_FREE_RETAIL_BATCH_SIZE: "1", TEST_CALL_FILE: callFile },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const firstRun = await runNode(["--import", preload, sample.script], options);
  const secondRun = await runNode(["--import", preload, sample.script], options);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  assert.equal(secondRun.code, 0, secondRun.stderr);
  const queries = (await readFile(callFile, "utf8")).trim().split(/\r?\n/);
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0], queries[1]);
  const markets = (await readEnvelope(sample.path)).items.map((entry) => entry.freeRetailMarket);
  assert.ok(markets.every((market) => market?.status === "insufficient"));
});

test("expired auctions are never sent to the retail catalog", async (t) => {
  const ended = activeItem("ended", "Sony PlayStation 5 Disc Edition Console");
  ended.endsAt = new Date(Date.now() - 60_000).toISOString();
  const live = activeItem("live", "Nintendo Switch OLED Console");
  live.endsAt = new Date(Date.now() + 3_600_000).toISOString();
  const sample = await fixture([ended, live]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const callFile = join(sample.root, "queries.txt");
  const preload = await mockPreload(sample.root, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.TEST_CALL_FILE, new URL(String(url)).searchParams.get("s") + "\\n");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0", TEST_CALL_FILE: callFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const queries = await readFile(callFile, "utf8");
  assert.match(queries, /nintendo switch oled/i);
  assert.doesNotMatch(queries, /playstation/i);
  const items = (await readEnvelope(sample.path)).items;
  assert.equal(items.find((item) => item.id === "ended").freeRetailMarket, undefined);
});

test("a missing snapshot is a clean no-credential no-op", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-free-retail-missing-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-free-retail.mjs"));
  const result = await runNode([join(root, "scripts", "enrich-free-retail.mjs")], {
    cwd: root,
    env: { ...process.env, BIDAI_FREE_RETAIL_DELAY_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /does not exist/i);
});
