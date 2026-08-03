import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./enrich-market-prices.mjs", import.meta.url));

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
  const root = await mkdtemp(join(tmpdir(), "bidaipro-market-price-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-market-prices.mjs"));
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
      category: "Video Games & Consoles",
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

function shoppingOffer(id, price, source, condition = "used", reviews = 0) {
  return {
    product_id: id,
    title: `Sony PlayStation 5 Disc Edition Console ${id}`,
    extracted_price: price,
    delivery: "$5 delivery",
    product_link: `https://merchant.example/${id}`,
    source,
    second_hand_condition: condition,
    rating: 4.7,
    reviews,
  };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("missing market credentials is a byte-stable no-op", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const before = await readFile(sample.path, "utf8");
  const result = await runNode([join(sample.root, "scripts", "enrich-market-prices.mjs")], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_SERPAPI_KEY: "", BIDAI_SEARCHAPI_KEY: "", BIDAI_PRICECHARTING_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(sample.path, "utf8"), before);
});

test("SearchAPI analog offers give duplicate listings one real conservative benchmark with one query", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const envelope = await readEnvelope(sample.path);
  envelope.items.push({ ...envelope.items[0], id: "shopgoodwill-456", externalId: "456" });
  await writeFile(sample.path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  const shopping = { shopping_results: Array.from({ length: 6 }, (_, index) => ({
    product_id: `analog-${index}`,
    title: `Sony PlayStation 5 Console Standard Used Bundle ${index}`,
    extracted_price: 100 + index * 10,
    product_link: `https://www.google.com/shopping/product/analog-${index}`,
    seller: index % 2 ? "Merchant A" : "Merchant B",
    durability: "Pre-owned",
  })) };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const shopping = JSON.parse(Buffer.from(process.env.TEST_SHOPPING, "base64").toString("utf8"));
    let calls = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (!String(url).includes("searchapi.io")) throw new Error("Unexpected provider URL");
      if (options.headers?.authorization !== "Bearer search-key") throw new Error("Missing SearchAPI bearer token");
      calls += 1;
      if (calls > 1) throw new Error("Duplicate query was not deduplicated");
      return new Response(JSON.stringify(shopping), { status: 200 });
    };
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-market-prices.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_SEARCHAPI_KEY: "search-key",
      BIDAI_SERPAPI_KEY: "",
      BIDAI_PRICECHARTING_TOKEN: "",
      TEST_SHOPPING: Buffer.from(JSON.stringify(shopping)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /using 1 Google Shopping query/);
  const items = (await readEnvelope(sample.path)).items;
  assert.equal(items[0].retailMarket.provider, "searchapi");
  assert.equal(items[0].retailMarket.status, "available");
  assert.equal(items[0].retailMarket.analog.sampleSize, 6);
  assert.equal(items[0].retailMarket.analog.sourceCount, 2);
  assert.equal(items[0].retailMarket.analog.priceMedian, 125);
  assert.equal(items[0].retailMarket.analog.planningReservePercent, 55);
  assert.deepEqual(items[1].retailMarket, items[0].retailMarket);
});

test("a unique item falls back to a real category-level Shopping benchmark", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const envelope = await readEnvelope(sample.path);
  envelope.items[0].title = "One Of A Kind Hand Painted Mystery Object";
  envelope.items[0].modelKey = "";
  envelope.items[0].category = "Cameras & Camcorders";
  await writeFile(sample.path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  const categoryResults = { shopping_results: Array.from({ length: 6 }, (_, index) => ({
    product_id: `category-${index}`,
    title: `Vintage Cameras Camcorders Equipment ${index}`,
    extracted_price: 50 + index * 10,
    product_link: `https://www.google.com/shopping/product/category-${index}`,
    seller: index % 2 ? "Merchant A" : "Merchant B",
  })) };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const categoryResults = JSON.parse(Buffer.from(process.env.TEST_SHOPPING, "base64").toString("utf8"));
    globalThis.fetch = async (url) => {
      const query = new URL(String(url)).searchParams.get("q");
      return new Response(JSON.stringify(query === "cameras camcorders" ? categoryResults : { shopping_results: [] }), { status: 200 });
    };
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-market-prices.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_SEARCHAPI_KEY: "search-key",
      BIDAI_SERPAPI_KEY: "",
      BIDAI_PRICECHARTING_TOKEN: "",
      TEST_SHOPPING: Buffer.from(JSON.stringify(categoryResults)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.retailMarket.status, "available");
  assert.deepEqual(item.retailMarket.queriesTried, ["one kind hand painted mystery object", "cameras camcorders"]);
  assert.equal(item.retailMarket.analog.categoryAnalogCount, 6);
  assert.equal(item.retailMarket.analog.priceMedian, 75);
  assert.match(item.retailMarket.analog.note, /category match/);
});

test("matched shopping offers and a specialty guide produce separate real price signals", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const shopping = {
    shopping_results: [
      shoppingOffer("u1", 120, "Merchant A", "used", 1200),
      shoppingOffer("u2", 140, "Merchant B", "refurbished", 900),
      shoppingOffer("u3", 160, "Merchant A", "used", 1200),
      shoppingOffer("u4", 180, "Merchant B", "used", 900),
      shoppingOffer("u5", 200, "Merchant C", "used", 500),
      shoppingOffer("n1", 450, "Merchant A", "", 1200),
      shoppingOffer("n2", 470, "Merchant B", "", 900),
      shoppingOffer("n3", 490, "Merchant C", "", 500),
      shoppingOffer("n4", 510, "Merchant A", "", 1200),
      shoppingOffer("n5", 530, "Merchant B", "", 900),
    ],
  };
  const priceCharting = {
    status: "success",
    id: "6910",
    "product-name": "Sony PlayStation 5 Disc Edition Console",
    "console-name": "PlayStation 5",
    "loose-price": 32599,
    "retail-loose-buy": 21000,
    "retail-loose-sell": 34999,
    "sales-volume": 1840,
  };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const shopping = JSON.parse(Buffer.from(process.env.TEST_SHOPPING, "base64").toString("utf8"));
    const specialty = JSON.parse(Buffer.from(process.env.TEST_SPECIALTY, "base64").toString("utf8"));
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("serpapi.com")) return new Response(JSON.stringify(shopping), { status: 200 });
      if (target.includes("pricecharting.com")) return new Response(JSON.stringify(specialty), { status: 200 });
      throw new Error("Unexpected URL");
    };
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-market-prices.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_SERPAPI_KEY: "serp-key",
      BIDAI_PRICECHARTING_TOKEN: "price-token",
      TEST_SHOPPING: Buffer.from(JSON.stringify(shopping)).toString("base64"),
      TEST_SPECIALTY: Buffer.from(JSON.stringify(priceCharting)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.retailMarket.status, "available");
  assert.equal(item.retailMarket.used.sampleSize, 5);
  assert.equal(item.retailMarket.used.sourceCount, 3);
  assert.equal(item.retailMarket.used.priceMedian, 165);
  assert.equal(item.retailMarket.newRetail.priceMedian, 495);
  assert.equal(item.retailMarket.productInterest.reviewCountMax, 1200);
  assert.match(item.retailMarket.productInterest.note, /not resale sell-through/);
  assert.equal(item.specialtyMarket.status, "available");
  assert.equal(item.specialtyMarket.guideValue, 325.99);
  assert.equal(item.specialtyMarket.retailerBuyValue, 210);
  assert.equal(item.specialtyMarket.retailerSellValue, 349.99);
  assert.equal(item.specialtyMarket.annualSalesVolume, 1840);
  assert.ok(item.specialtyMarket.matchScore >= 65);
});

test("weak title matches cannot create broad-market or specialty evidence", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const shopping = { shopping_results: Array.from({ length: 8 }, (_, index) => ({
    product_id: `wrong-${index}`,
    title: `Apple MacBook Pro Laptop ${index}`,
    extracted_price: 800 + index,
    product_link: `https://merchant.example/wrong-${index}`,
    source: index % 2 ? "Merchant A" : "Merchant B",
    second_hand_condition: "used",
  })) };
  const priceCharting = { status: "success", id: "44", "product-name": "Nintendo Switch OLED", "console-name": "Nintendo Switch", "loose-price": 20000 };
  const preload = join(sample.root, "mock-fetch.mjs");
  await writeFile(preload, `
    const shopping = JSON.parse(Buffer.from(process.env.TEST_SHOPPING, "base64").toString("utf8"));
    const specialty = JSON.parse(Buffer.from(process.env.TEST_SPECIALTY, "base64").toString("utf8"));
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("serpapi.com") ? shopping : specialty), { status: 200 });
  `, "utf8");
  const result = await runNode(["--import", pathToFileURL(preload).href, join(sample.root, "scripts", "enrich-market-prices.mjs")], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_SERPAPI_KEY: "serp-key",
      BIDAI_PRICECHARTING_TOKEN: "price-token",
      TEST_SHOPPING: Buffer.from(JSON.stringify(shopping)).toString("base64"),
      TEST_SPECIALTY: Buffer.from(JSON.stringify(priceCharting)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.retailMarket.status, "insufficient");
  assert.equal(item.retailMarket.offers.length, 0);
  assert.equal(item.specialtyMarket.status, "insufficient");
  assert.equal(item.specialtyMarket.guideValue, undefined);
});
