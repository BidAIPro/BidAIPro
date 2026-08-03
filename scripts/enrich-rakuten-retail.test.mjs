import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./enrich-rakuten-retail.mjs", import.meta.url));
const freeScript = fileURLToPath(new URL("./enrich-free-retail.mjs", import.meta.url));
const { selectTargetGroups } = await import("./enrich-rakuten-retail.mjs");

function runNode(args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function activeItem(id, title, extra = {}) {
  return {
    id,
    externalId: id,
    sourceKey: "shopgoodwill",
    source: "ShopGoodwill",
    title,
    category: "Electronics",
    resaleVertical: "Electronics",
    url: `https://shopgoodwill.com/item/${id}`,
    status: "active",
    currentBid: 20,
    bidCount: 2,
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...extra,
  };
}

async function fixture(items) {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-rakuten-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "enrich-rakuten-retail.mjs"));
  await copyFile(freeScript, join(root, "scripts", "enrich-free-retail.mjs"));
  const path = join(root, "data", "live-snapshots.js");
  const envelope = { observedAt: new Date().toISOString(), sourceMode: "test", sourceNotes: [], items };
  await writeFile(path, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  return { root, path, script: join(root, "scripts", "enrich-rakuten-retail.mjs") };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

async function mockPreload(root, implementation) {
  const path = join(root, `mock-rakuten-fetch-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, implementation, "utf8");
  return pathToFileURL(path).href;
}

function productXml({ mid, merchant, linkId, title, upc = "", price, salePrice = "", url, brand = "", model = "", currency = "USD" }) {
  return `<item>
    <mid>${mid}</mid><merchantname>${merchant}</merchantname><linkid>${linkId}</linkid>
    <productname>${title}</productname><brand>${brand}</brand><model>${model}</model><upccode>${upc}</upccode>
    <price currency="${currency}">${price}</price>${salePrice ? `<saleprice currency="${currency}">${salePrice}</saleprice>` : ""}
    <linkurl><![CDATA[${url}]]></linkurl><condition>New</condition><availability>In stock</availability>
  </item>`;
}

test("missing access token is a byte-stable no-op", async (t) => {
  const sample = await fixture([activeItem("one", "Sony PlayStation 5 Disc Edition Console")]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const before = await readFile(sample.path);
  const marker = join(sample.root, "fetch-called.txt");
  const preload = await mockPreload(sample.root, `
    import { writeFileSync } from "node:fs";
    globalThis.fetch = async () => { writeFileSync(process.env.TEST_MARKER, "called"); throw new Error("fetch must not run"); };
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_RAKUTEN_ACCESS_TOKEN: "", TEST_MARKER: marker },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /not configured/i);
  assert.deepEqual(await readFile(sample.path), before);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("strict XML matches from two merchants create multi-merchant retail statistics", async (t) => {
  const item = activeItem("ps5", "Sony PlayStation 5 Disc Edition Console", { upc: "711719542028" });
  const sample = await fixture([item]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const xml = `<?xml version="1.0"?><result>
    ${productXml({ mid: "10", merchant: "Best Buy &amp; Co", linkId: "bb-ps5", title: "Sony PlayStation 5 Disc Edition Console", upc: "711719542028", price: "499.99", salePrice: "449.99", url: "https://click.example/bestbuy-ps5", brand: "Sony", model: "PlayStation 5 Disc Edition" })}
    ${productXml({ mid: "20", merchant: "Walmart", linkId: "wm-ps5", title: "Sony PlayStation 5 Disc Edition Console", upc: "711719542028", price: "469.99", url: "https://click.example/walmart-ps5", brand: "Sony", model: "PlayStation 5 Disc Edition" })}
    ${productXml({ mid: "30", merchant: "Wrong Store", linkId: "wrong", title: "Sony PlayStation 4 Slim Console", upc: "711719999999", price: "19.99", url: "https://click.example/wrong", brand: "Sony", model: "PlayStation 4 Slim" })}
    ${productXml({ mid: "40", merchant: "Canadian Store", linkId: "cad", title: "Sony PlayStation 5 Disc Edition Console", upc: "711719542028", price: "1.00", url: "https://click.example/cad", brand: "Sony", model: "PlayStation 5 Disc Edition", currency: "CAD" })}
  </result>`;
  const preload = await mockPreload(sample.root, `
    const xml = Buffer.from(process.env.TEST_XML, "base64").toString("utf8");
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url));
      if (parsed.href.split("?")[0] !== "https://api.linksynergy.com/productsearch/1.0") throw new Error("wrong endpoint");
      if (parsed.searchParams.get("exact") !== "711719542028" || parsed.searchParams.has("keyword")) throw new Error("wrong exact query");
      if (parsed.searchParams.get("language") !== "en_US" || parsed.searchParams.get("max") !== "100") throw new Error("missing search controls");
      if (options.headers.authorization !== "Bearer test-token") throw new Error("missing bearer token");
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    };
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_RAKUTEN_ACCESS_TOKEN: "test-token",
      BIDAI_RAKUTEN_RETAIL_DELAY_MS: "0",
      TEST_XML: Buffer.from(xml).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const market = (await readEnvelope(sample.path)).items[0].partnerRetailMarket;
  assert.equal(market.provider, "rakuten");
  assert.equal(market.status, "available");
  assert.equal(market.offers.length, 2, "wrong-identity and non-USD results must be rejected");
  assert.equal(market.catalog.matchTier, "exact-upc-gtin");
  assert.equal(market.catalog.matchScore, 100);
  assert.equal(market.catalog.sourceCount, 2);
  assert.equal(market.catalog.sampleSize, 2);
  assert.equal(market.catalog.priceLow, 449.99);
  assert.equal(market.catalog.priceMedian, 459.99);
  assert.equal(market.catalog.priceAverage, 459.99);
  assert.equal(market.catalog.priceHigh, 469.99);
  assert.equal(market.catalog.planningReservePercent, 55);
  assert.equal(market.offers[0].merchant, "Best Buy & Co");
  assert.equal(market.offers[0].listPrice, 499.99);
  assert.match(market.offers[0].id, /^rakuten:10:bb-ps5$/);
  assert.match(market.note, /not used-condition sold comps/i);
  assert.equal(market.safeBid, undefined);
  assert.equal(market.demand, undefined);
});

test("a weak or conflicting product match cannot emit a retail price", async (t) => {
  const sample = await fixture([activeItem("phone", "Apple iPhone 13 Pro 256GB Smartphone")]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const xml = `<result>${productXml({ mid: "1", merchant: "Phone Shop", linkId: "iphone12", title: "Apple iPhone 12 Pro 256GB Smartphone", price: "899", url: "https://click.example/iphone12", brand: "Apple", model: "iPhone 12 Pro" })}</result>`;
  const preload = await mockPreload(sample.root, `
    const xml = Buffer.from(process.env.TEST_XML, "base64").toString("utf8");
    globalThis.fetch = async () => new Response(xml, { status: 200 });
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_RAKUTEN_ACCESS_TOKEN: "token", BIDAI_RAKUTEN_RETAIL_DELAY_MS: "0", TEST_XML: Buffer.from(xml).toString("base64") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const market = (await readEnvelope(sample.path)).items[0].partnerRetailMarket;
  assert.equal(market.status, "insufficient");
  assert.equal(market.catalog, null);
  assert.deepEqual(market.offers, []);
  assert.match(market.reason, /conflicted|strictly match/i);
});

test("expired listings are skipped while an active catalog product is fetched", async (t) => {
  const expired = activeItem("expired", "Sony PlayStation 5 Disc Edition Console", { endsAt: new Date(Date.now() - 60_000).toISOString() });
  const active = activeItem("active", "Nintendo Switch OLED Console");
  const sample = await fixture([expired, active]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const queryFile = join(sample.root, "queries.txt");
  const preload = await mockPreload(sample.root, `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.TEST_QUERY_FILE, new URL(String(url)).searchParams.get("keyword") + "\\n");
      return new Response("<result></result>", { status: 200 });
    };
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: { ...process.env, BIDAI_RAKUTEN_ACCESS_TOKEN: "token", BIDAI_RAKUTEN_RETAIL_DELAY_MS: "0", TEST_QUERY_FILE: queryFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  const queries = await readFile(queryFile, "utf8");
  assert.match(queries, /nintendo switch oled/i);
  assert.doesNotMatch(queries, /playstation/i);
  const items = (await readEnvelope(sample.path)).items;
  assert.equal(items.find((entry) => entry.id === "expired").partnerRetailMarket, undefined);
  assert.equal(items.find((entry) => entry.id === "active").partnerRetailMarket.status, "insufficient");
});

test("duplicate product queries are requested once and applied to every active auction", async (t) => {
  const sample = await fixture([
    activeItem("one", "Nintendo Switch OLED Console"),
    activeItem("two", "Nintendo Switch OLED Console"),
  ]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const callsFile = join(sample.root, "calls.txt");
  const xml = `<result>${productXml({ mid: "9", merchant: "Game Store", linkId: "switch", title: "Nintendo Switch OLED Console", price: "349.99", url: "https://click.example/switch", brand: "Nintendo", model: "Switch OLED" })}</result>`;
  const preload = await mockPreload(sample.root, `
    import { writeFileSync } from "node:fs";
    const xml = Buffer.from(process.env.TEST_XML, "base64").toString("utf8");
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      const parsed = new URL(String(url));
      if (!/nintendo switch oled/i.test(parsed.searchParams.get("keyword"))) throw new Error("wrong keyword");
      return new Response(xml, { status: 200 });
    };
    process.on("exit", () => writeFileSync(process.env.TEST_CALLS_FILE, String(calls)));
  `);
  const result = await runNode(["--import", preload, sample.script], {
    cwd: sample.root,
    env: {
      ...process.env,
      BIDAI_RAKUTEN_ACCESS_TOKEN: "token",
      BIDAI_RAKUTEN_RETAIL_DELAY_MS: "0",
      TEST_XML: Buffer.from(xml).toString("base64"),
      TEST_CALLS_FILE: callsFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(callsFile, "utf8"), "1");
  const items = (await readEnvelope(sample.path)).items;
  assert.equal(items[0].partnerRetailMarket.status, "reference-only");
  assert.equal(items[1].partnerRetailMarket.status, "reference-only");
  assert.equal(items[0].partnerRetailMarket.catalog.priceMedian, 349.99);
});

test("a bounded batch rotates across resale verticals instead of starving categories", () => {
  const items = [
    activeItem("electronics-one", "Sony PlayStation 5 Disc Edition Console", { bidCount: 100 }),
    activeItem("electronics-two", "Nintendo Switch OLED Console", { bidCount: 90 }),
    activeItem("footwear", "Gaerne SG 10 Motocross Motorcycle Boots", {
      category: "Footwear & Sneakers",
      resaleVertical: "Footwear & Sneakers",
      bidCount: 1,
    }),
  ];
  const selected = selectTargetGroups(items, 2, Date.now());
  assert.deepEqual(new Set(selected.map((group) => group.representative.resaleVertical)), new Set([
    "Electronics",
    "Footwear & Sneakers",
  ]));
});
