import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./refresh-feed.mjs", import.meta.url));

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
  const root = await mkdtemp(join(tmpdir(), "bidaipro-feed-test-"));
  const scripts = join(root, "scripts");
  const data = join(root, "data");
  await mkdir(scripts, { recursive: true });
  await mkdir(data, { recursive: true });
  await copyFile(sourceScript, join(scripts, "refresh-feed.mjs"));
  return { root, scripts, data };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  assert.ok(source.startsWith(OUTPUT_PREFIX));
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("Apify mode authenticates, keeps stable history, and lets the newest row win", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outputPath = join(fixture.data, "live-snapshots.js");
  const priorEnvelope = {
    observedAt: "2026-08-01T10:00:00.000Z",
    sourceMode: "published-manual-research-snapshot",
    sourceNotes: [],
    items: [{
      id: "manual-retained",
      externalId: "manual-retained",
      title: "Retained manual research",
      status: "ended",
      observedAt: "2026-08-01T10:00:00.000Z",
      observations: [],
    }, {
      id: "legacy-shopgoodwill-prototype",
      externalId: "999999999",
      source: "ShopGoodwill manual research snapshot",
      sourceKey: "shopgoodwill",
      title: "Legacy unsupported prototype estimate",
      resaleMedian: 999,
      status: "active",
      observedAt: "2026-08-01T10:00:00.000Z",
      observations: [],
    }],
  };
  await writeFile(outputPath, `${OUTPUT_PREFIX}${JSON.stringify(priorEnvelope)};\n`, "utf8");

  const expectedUrl = "https://api.apify.com/v2/datasets/test-account~auction-data/items?format=json&clean=true&desc=1&limit=5000";
  const payload = [
    {
      externalId: "lot-42",
      title: "Newer auction observation",
      url: "https://example.com/lot-42",
      currentBid: "$1,234.56",
      bidCount: 12,
      taxRate: "8.25%",
      compGroup: "camera:model-x",
      forecastBasis: "Five exact-model completed sales and a matched closing-curve cohort.",
      comparableSales: [
        {
          title: "Model X sold one",
          soldPrice: "$900.00",
          soldAt: "2026-07-15T12:00:00Z",
          url: "https://comps.example.com/sale-1#ignored",
          source: "Completed sales feed",
          similarItemKey: "camera:model-x",
          matchReason: "Exact model and included lens",
          matchScore: 0.96,
        },
        { id: "sale-2", title: "Model X sold two", price: 1000, endedAt: "2026-07-16T12:00:00Z", source: "Completed sales feed", modelKey: "camera:model-x", matchScore: 94 },
        { id: "sale-3", title: "Model X sold three", finalPrice: 1100, endedAt: "2026-07-17T12:00:00Z", source: "Completed sales feed", modelKey: "camera:model-x", matchScore: 93 },
        { id: "sale-4", title: "Model X sold four", soldPrice: 1200, soldAt: "2026-07-18T12:00:00Z", source: "Completed sales feed", modelKey: "camera:model-x", matchScore: 92 },
        { id: "sale-5", title: "Model X sold five", price: 1300, endedAt: "2026-07-19T12:00:00Z", source: "Completed sales feed", modelKey: "camera:model-x", matchScore: 91 },
        { title: "Future sale retained only for audit", price: 9999, endedAt: "2026-08-03T12:00:00Z", source: "Completed sales feed" },
        { title: "Undated sale retained only for audit", price: 8888, source: "Completed sales feed" },
      ],
      auctionComparables: [{
        id: "model-x-auction-1",
        title: "Model X prior auction",
        finalPrice: 975,
        endedAt: "2026-07-14T12:00:00Z",
        sourceUrl: "https://comps.example.com/auction-1",
        source: "Auction archive",
        modelKey: "camera:model-x",
        matchScore: 95,
        bidAtComparableTime: 725,
        hoursToClose: 4.5,
      }],
      forecast: {
        status: "verified",
        asOf: "2026-08-02T12:00:00Z",
        modelVersion: "closing-curve-v2",
        expected: 1450,
        low: 1300,
        high: 1625,
        sampleSize: 5,
        exactModelCount: 5,
        curveCount: 9,
        confidence: "84%",
        method: "exact-model weighted median",
        reasonCodes: ["EXACT_MODEL_SAMPLE"],
      },
      history: [{
        observedAt: "2026-08-02T11:30:00.000Z",
        currentBid: 1000,
        bidCount: 9,
        status: "active",
      }],
      observedAt: "2026-08-02T12:00:00.000Z",
    },
    {
      externalId: "lot-42",
      title: "Older auction observation",
      url: "https://example.com/lot-42",
      currentBid: 900,
      bidCount: 8,
      taxRate: 0.0825,
      observedAt: "2026-08-02T11:00:00.000Z",
    },
    {
      externalId: "lot-42",
      title: "Oldest auction observation with forecast",
      url: "https://example.com/lot-42",
      currentBid: 700,
      bidCount: 5,
      observedAt: "2026-08-02T10:00:00.000Z",
      forecast: {
        status: "verified",
        asOf: "2026-08-02T10:00:00Z",
        modelVersion: "closing-curve-v1",
        expected: 1100,
        low: 950,
        high: 1250,
        sampleSize: 6,
        exactModelCount: 6,
        curveCount: 7,
        confidence: 0.72,
        method: "earlier exact-model curve",
        reasonCodes: ["EXACT_MODEL_SAMPLE"],
      },
    },
  ];
  const preloadPath = join(fixture.root, "mock-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== process.env.BIDAI_TEST_EXPECTED_URL) throw new Error("Unexpected Apify URL");
      if (options.headers?.authorization !== "Bearer test-token") throw new Error("Missing Apify bearer token");
      if (options.headers?.accept !== "application/json") throw new Error("Missing JSON accept header");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const childArgs = ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")];
  const childOptions = {
    cwd: fixture.root,
    env: {
      ...process.env,
      BIDAI_SOURCE_AUTHORIZED: "true",
      BIDAI_APIFY_DATASET_ID: "test-account~auction-data",
      BIDAI_APIFY_TOKEN: "test-token",
      BIDAI_FEED_URL: "",
      BIDAI_TEST_EXPECTED_URL: expectedUrl,
      BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const result = await runNode(childArgs, childOptions);

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(outputPath);
  assert.equal(envelope.sourceMode, "apify-dataset");
  assert.equal(envelope.observedAt, "2026-08-02T12:00:00.000Z");
  assert.equal(envelope.items.length, 2);
  const imported = envelope.items.find((item) => item.externalId === "lot-42");
  assert.ok(imported);
  assert.equal(imported.title, "Newer auction observation");
  assert.equal(imported.currentBid, 1234.56);
  assert.equal(imported.bidCount, 12);
  assert.equal(imported.taxRate, 8.25);
  assert.equal(imported.shipping, null);
  assert.equal(imported.shippingKnown, false);
  assert.equal(imported.marketplaceFee, null);
  assert.equal(imported.feeKnown, false);
  assert.equal(imported.source, "Apify dataset");
  assert.equal(imported.publishedResearch, true);
  assert.equal(imported.url, imported.sourceUrl);
  assert.equal(imported.modelKey, "camera:model-x");
  assert.match(imported.forecastBasis, /exact-model/i);
  assert.equal(imported.compCount, 5);
  assert.equal(imported.resaleLow, 980);
  assert.equal(imported.resaleMedian, 1100);
  assert.equal(imported.resaleHigh, 1220);
  assert.equal(imported.comparableSales.length, 7);
  assert.equal(imported.comparableSales[0].soldPrice, 900);
  assert.equal(imported.comparableSales[0].modelKey, "camera:model-x");
  assert.equal(imported.comparableSales[0].matchScore, 96);
  assert.equal(imported.comparableSales[0].url, "https://comps.example.com/sale-1");
  assert.equal(imported.auctionComparables[0].finalPrice, 975);
  assert.equal(imported.auctionComparables[0].bidAtComparableTime, 725);
  assert.equal(imported.auctionComparables[0].hoursToClose, 4.5);
  assert.deepEqual(imported.forecast, {
    status: "insufficient-data",
    asOf: "2026-08-02T12:00:00.000Z",
    modelVersion: "closing-curve-v2",
    expected: null,
    low: null,
    high: null,
    sampleSize: 5,
    exactModelCount: 5,
    curveCount: 9,
    confidence: 0.84,
    method: "exact-model weighted median",
    reasonCodes: ["EXACT_MODEL_SAMPLE", "EXACT_MODEL_EVIDENCE_NOT_REVALIDATED"],
  });
  assert.deepEqual(imported.observations.map((point) => point.currentBid), [700, 900, 1000, 1234.56]);
  assert.equal(imported.observations[0].forecast.expected, 1100);
  assert.equal(imported.observations[0].forecast.modelVersion, "closing-curve-v1");
  assert.equal(imported.observations[0].forecast.curveCount, 7);
  assert.equal(imported.observations[0].forecast.confidence, 0.72);
  assert.equal("forecast" in imported.observations[1], false, "A current forecast must not leak into older history");
  assert.equal("forecast" in imported.observations[2], false, "Nested supplied history must remain forecast-free");
  assert.deepEqual(imported.observations[3].forecast, imported.forecast);
  assert.ok(envelope.items.some((item) => item.id === "manual-retained"));
  assert.equal(envelope.items.some((item) => item.id === "legacy-shopgoodwill-prototype"), false);

  const firstOutput = await readFile(outputPath, "utf8");
  const repeatedResult = await runNode(childArgs, childOptions);
  assert.equal(repeatedResult.code, 0, repeatedResult.stderr);
  assert.equal(await readFile(outputPath, "utf8"), firstOutput, "Repeated identical data should be byte-stable");
});

test("Apify Dataset ingestion follows pagination beyond the first 5,000 real records", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "paginated-fetch.mjs");
  await writeFile(preloadPath, `
    const makeRecord = (index) => ({
      id: "catalog-" + index,
      title: "Catalog listing " + index,
      currentBid: index + 1,
      observedAt: "2026-08-02T12:00:00.000Z"
    });
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      const offset = Number(parsed.searchParams.get("offset") || 0);
      const payload = offset === 0
        ? Array.from({ length: 5000 }, (_, index) => makeRecord(index))
        : offset === 5000 ? [makeRecord(5000)] : [];
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "large-catalog",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  assert.equal(envelope.items.length, 5001);
  assert.ok(envelope.items.some((item) => item.externalId === "catalog-5000"));
});

test("the built-in ShopGoodwill catalog pages real listings and preserves source-only authentication claims", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-catalog-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== "https://buyerapi.shopgoodwill.com/api/Search/ItemListing") {
        throw new Error("Unexpected ShopGoodwill URL: " + url);
      }
      if (options.method !== "POST") throw new Error("Catalog request must use POST");
      if (options.headers?.origin !== "https://shopgoodwill.com") throw new Error("Missing source origin");
      const request = JSON.parse(options.body);
      const makeItem = (index) => ({
        itemId: 270000000 + index,
        title: index === 1 ? "Nike Air Jordan Sneakers W/ COA" : "Real catalog listing " + index,
        currentPrice: index + 10,
        numBids: index,
        endTime: "2026-08-02T04:08:05",
        imageURL: "https://shopgoodwillimages.azureedge.net/production\\\\item-" + index + ".jpeg",
        categoryName: index === 1 ? "Shoes" : "Collectibles",
        catFullName: index === 1 ? "Clothing > Shoes" : "Collectibles > General",
      });
      const items = request.selectedCategoryIds === "500"
        ? [{ ...makeItem(42), itemId: 270000042, title: "Category fan-out listing", categoryName: "Tools", catFullName: "Tools > Hand Tools" }]
        : request.page === 1
          ? Array.from({ length: 40 }, (_, index) => makeItem(index + 1))
          : request.page === 2 ? [makeItem(41)] : [];
      return new Response(JSON.stringify({
        searchResults: { items, itemCount: request.selectedCategoryIds === "500" ? 1 : 41 },
        maxTotalRecords: 10000,
        categoryListModel: { categoryWithNonZeroChild: [{ categoryId: 500, name: "Tools", levelNumber: 1 }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "catalog",
        BIDAI_SHOPGOODWILL_CATALOG_LIMIT: "41",
        BIDAI_SHOPGOODWILL_CATEGORY_LIMIT: "1",
        BIDAI_SHOPGOODWILL_PRIORITY_LIMIT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  assert.equal(envelope.sourceMode, "shopgoodwill-public-catalog");
  assert.equal(envelope.items.length, 42);
  assert.ok(envelope.items.some((item) => item.title === "Category fan-out listing"));
  const footwear = envelope.items.find((item) => item.externalId === "270000001");
  assert.ok(footwear);
  assert.equal(footwear.sourceKey, "shopgoodwill");
  assert.equal(footwear.url, "https://shopgoodwill.com/item/270000001");
  assert.equal(footwear.category, "Clothing > Shoes");
  assert.equal(footwear.resaleVertical, "Footwear & Sneakers");
  assert.equal(footwear.authenticationStatus, "source-stated");
  assert.match(footwear.authenticationEvidence, /independently verify/i);
  assert.equal(footwear.bidCount, 1);
  assert.equal(footwear.endsAt, "2026-08-02T11:08:05.000Z");
  assert.equal(footwear.imageUrl, "https://shopgoodwillimages.azureedge.net/production/item-1.jpeg");
  assert.equal("forecast" in footwear, false, "Catalog volume must not fabricate a profitability forecast");
});

test("the ShopGoodwill close check records a final outcome from the item-detail service", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-detail-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== "https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/272052012") {
        throw new Error("Unexpected ShopGoodwill detail URL: " + url);
      }
      if (options.method) throw new Error("Item detail request must use GET");
      return new Response(JSON.stringify({
        itemId: 272052012,
        title: "Final Talbots Watch",
        currentPrice: 72.5,
        numberOfBids: 9,
        endTime: "2026-08-02T04:08:05",
        serverTime: "2026-08-02T04:08:20",
        isItemEndTimeExpire: true,
        category: "Watches",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "items",
        BIDAI_SHOPGOODWILL_ITEM_IDS: "272052012",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  assert.equal(envelope.items[0].status, "ended");
  assert.equal(envelope.items[0].finalPrice, 72.5);
  assert.equal(envelope.items[0].bidCount, 9);
  assert.equal(envelope.items[0].resaleVertical, "Watches");
});

test("source-described gold weight receives a live melt ceiling without becoming verified resale evidence", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-metal-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      if (String(url) === "https://api.gold-api.com/price/XAU") {
        return new Response(JSON.stringify({ currency: "USD", price: 3100, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://api.gold-api.com/price/XAG") {
        return new Response(JSON.stringify({ currency: "USD", price: 35, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/272052013") {
        return new Response(JSON.stringify({
          itemId: 272052013,
          title: "14K Yellow Gold Band 10 Grams",
          currentPrice: 250,
          numberOfBids: 5,
          endTime: "2099-08-02T04:08:05",
          serverTime: "2099-08-01T04:08:05",
          category: "Jewelry",
        }), { status: 200 });
      }
      throw new Error("Unexpected URL: " + url);
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "items",
        BIDAI_SHOPGOODWILL_ITEM_IDS: "272052013",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(join(fixture.data, "live-snapshots.js"))).items[0];
  assert.equal(item.metalEstimate.metal, "gold");
  assert.equal(item.metalEstimate.purityLabel, "14k");
  assert.equal(item.metalEstimate.grossWeightGrams, 10);
  assert.ok(item.metalEstimate.meltCeiling > 580 && item.metalEstimate.meltCeiling < 582);
  assert.equal(item.metalEstimate.singleMetalOnly, true);
  assert.match(item.metalEstimate.nonMetalWarning, /one precious-metal material/i);
  assert.equal(item.metalEstimate.requiresIndependentTesting, true);
  assert.equal(item.resaleMarket, undefined);
  assert.equal(item.resaleMedian, undefined);
  assert.equal(item.intrinsicValueEvidence, undefined);
});

test("a leading-decimal gram weight is not inflated by ten times", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-decimal-metal-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      if (String(url) === "https://api.gold-api.com/price/XAU") {
        return new Response(JSON.stringify({ currency: "USD", price: 3100, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://api.gold-api.com/price/XAG") {
        return new Response(JSON.stringify({ currency: "USD", price: 35, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/272052015") {
        return new Response(JSON.stringify({
          itemId: 272052015,
          title: "Charming 14K Yellow Gold Pendant .8g",
          currentPrice: 23,
          numberOfBids: 6,
          endTime: "2099-08-02T04:08:05",
          serverTime: "2099-08-01T04:08:05",
          category: "Jewelry",
        }), { status: 200 });
      }
      throw new Error("Unexpected URL: " + url);
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "items",
        BIDAI_SHOPGOODWILL_ITEM_IDS: "272052015",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(join(fixture.data, "live-snapshots.js"))).items[0];
  assert.equal(item.metalEstimate.grossWeightGrams, 0.8);
  assert.ok(item.metalEstimate.meltCeiling > 46 && item.metalEstimate.meltCeiling < 47);
});

test("faux stones and turquoise cannot create a pawn melt estimate", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-stone-metal-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      if (String(url) === "https://api.gold-api.com/price/XAU") {
        return new Response(JSON.stringify({ currency: "USD", price: 3100, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://api.gold-api.com/price/XAG") {
        return new Response(JSON.stringify({ currency: "USD", price: 35, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/272052016") {
        return new Response(JSON.stringify({
          itemId: 272052016,
          title: "Sterling Faux Stones & Turquoise Necklace 133.97 Grams",
          currentPrice: 127,
          numberOfBids: 9,
          endTime: "2099-08-02T04:08:05",
          serverTime: "2099-08-01T04:08:05",
          category: "Jewelry",
        }), { status: 200 });
      }
      throw new Error("Unexpected URL: " + url);
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "items",
        BIDAI_SHOPGOODWILL_ITEM_IDS: "272052016",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(join(fixture.data, "live-snapshots.js"))).items[0];
  assert.equal(item.metalEstimate, undefined);
});

test("mixed, plated, rhodium, gold, silver, and CZ wording cannot create a pawn melt estimate", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preloadPath = join(fixture.root, "shopgoodwill-plated-metal-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      if (String(url) === "https://api.gold-api.com/price/XAU") {
        return new Response(JSON.stringify({ currency: "USD", price: 3100, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://api.gold-api.com/price/XAG") {
        return new Response(JSON.stringify({ currency: "USD", price: 35, updatedAt: new Date().toISOString() }), { status: 200 });
      }
      if (String(url) === "https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/272052014") {
        return new Response(JSON.stringify({
          itemId: 272052014,
          title: "6.4g 925 Sterling Rhodium Plate / 14K Rose Gold Plate CZ Ring",
          currentPrice: 65,
          numberOfBids: 2,
          endTime: "2099-08-02T04:08:05",
          serverTime: "2099-08-01T04:08:05",
          category: "Jewelry",
        }), { status: 200 });
      }
      throw new Error("Unexpected URL: " + url);
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_SHOPGOODWILL_MODE: "items",
        BIDAI_SHOPGOODWILL_ITEM_IDS: "272052014",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const item = (await readEnvelope(join(fixture.data, "live-snapshots.js"))).items[0];
  assert.equal(item.metalEstimate, undefined);
});

test("authorization guard makes no request and leaves published data unchanged", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const outputPath = join(fixture.data, "live-snapshots.js");
  const original = `${OUTPUT_PREFIX}{"observedAt":null,"sourceMode":"test","sourceNotes":[],"items":[]};\n`;
  await writeFile(outputPath, original, "utf8");
  const preloadPath = join(fixture.root, "reject-fetch.mjs");
  await writeFile(preloadPath, "globalThis.fetch = async () => { throw new Error('fetch must not run'); };\n", "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_APIFY_DATASET_ID: "test-account~auction-data",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(outputPath, "utf8"), original);
});

test("generic HTTPS feed mode remains available when no Apify dataset is configured", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const feedUrl = "https://feeds.example.invalid/authorized-auctions.json";
  const preloadPath = join(fixture.root, "generic-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== process.env.BIDAI_TEST_EXPECTED_URL) throw new Error("Unexpected generic feed URL");
      if (options.headers?.authorization) throw new Error("Generic feed must not receive the Apify token");
      return new Response(JSON.stringify({
        generatedAt: "2026-08-02T13:00:00.000Z",
        items: [
          {
            id: "generic-1",
            title: "Generic authorized record",
            sourceUrl: "https://example.com/generic-1",
            currentBid: 42,
            observedAt: "2026-08-02T13:00:00.000Z"
          },
          {
            id: "generic-1",
            title: "Older generic observation supplied out of order",
            sourceUrl: "https://example.com/generic-1",
            currentBid: 30,
            observedAt: "2026-08-02T12:00:00.000Z"
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_APIFY_TOKEN: "must-not-be-used",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_EXPECTED_URL: feedUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  assert.equal(envelope.sourceMode, "authorized-feed");
  assert.equal(envelope.items.length, 1);
  assert.equal(envelope.items[0].source, "Authorized feed");
  assert.equal(envelope.items[0].url, "https://example.com/generic-1");
  assert.equal(envelope.items[0].sourceUrl, envelope.items[0].url);
  assert.equal(envelope.items[0].currentBid, 42, "The chronologically newest generic row must win");
  assert.deepEqual(envelope.items[0].observations.map((point) => point.currentBid), [30, 42]);
  assert.deepEqual(envelope.items[0].comparableSales, []);
  assert.deepEqual(envelope.items[0].auctionComparables, []);
  assert.equal(envelope.items[0].compCount, 0);
  assert.equal(envelope.items[0].resaleLow, null);
  assert.equal(envelope.items[0].resaleMedian, null);
  assert.equal(envelope.items[0].resaleHigh, null);
  assert.equal(envelope.items[0].shipping, null);
  assert.equal(envelope.items[0].shippingKnown, false);
  assert.equal(envelope.items[0].marketplaceFee, null);
  assert.equal(envelope.items[0].feeKnown, false);
  assert.equal("forecast" in envelope.items[0], false, "The importer must not fabricate a forecast");
});

test("every check advances lastCheckedAt while only higher bids advance the price curve", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outputPath = join(fixture.data, "live-snapshots.js");
  const feedUrl = "https://feeds.example.invalid/bid-increases-only.json";
  const preloadPath = join(fixture.root, "bid-increase-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  `, "utf8");
  const runPayload = async (currentBid, observedAt) => runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify({
          items: [{
            id: "strict-bid-history",
            title: "Strict bid history listing",
            url: "https://example.com/strict-bid-history",
            currentBid,
            bidCount: currentBid === 100 ? 2 : 3,
            observedAt,
          }],
        })).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal((await runPayload(100, "2026-08-02T10:00:00Z")).code, 0);
  let envelope = await readEnvelope(outputPath);
  assert.equal(envelope.items[0].observedAt, "2026-08-02T10:00:00.000Z");
  assert.equal(envelope.items[0].lastCheckedAt, "2026-08-02T10:00:00.000Z");
  assert.equal((await runPayload(100, "2026-08-02T11:00:00Z")).code, 0);
  envelope = await readEnvelope(outputPath);
  assert.equal(envelope.items[0].observedAt, "2026-08-02T10:00:00.000Z", "An unchanged bid must preserve the last price-change time");
  assert.equal(envelope.items[0].lastCheckedAt, "2026-08-02T11:00:00.000Z", "An unchanged bid must still record a successful check");
  assert.deepEqual(envelope.items[0].observations.map((point) => point.currentBid), [100]);

  assert.equal((await runPayload(125, "2026-08-02T12:00:00Z")).code, 0);
  const increased = await readEnvelope(outputPath);
  assert.deepEqual(increased.items[0].observations.map((point) => point.currentBid), [100, 125]);
  assert.equal(increased.items[0].observedAt, "2026-08-02T12:00:00.000Z");
  assert.equal(increased.items[0].lastCheckedAt, "2026-08-02T12:00:00.000Z");

  assert.equal((await runPayload(110, "2026-08-02T13:00:00Z")).code, 0);
  const afterLowerBid = await readEnvelope(outputPath);
  assert.equal(afterLowerBid.items[0].currentBid, 125, "A lower reported bid must never roll price backward");
  assert.equal(afterLowerBid.items[0].observedAt, "2026-08-02T12:00:00.000Z");
  assert.equal(afterLowerBid.items[0].lastCheckedAt, "2026-08-02T13:00:00.000Z");
  assert.deepEqual(afterLowerBid.items[0].observations.map((point) => point.currentBid), [100, 125]);
  assert.equal(afterLowerBid.lastCheckedAt, "2026-08-02T13:00:00.000Z");

  assert.equal((await runPayload(115, "2026-08-02T11:30:00Z")).code, 0);
  const afterOutOfOrderCheck = await readEnvelope(outputPath);
  assert.equal(afterOutOfOrderCheck.items[0].currentBid, 125);
  assert.equal(afterOutOfOrderCheck.items[0].lastCheckedAt, "2026-08-02T13:00:00.000Z", "An older check must not roll lastCheckedAt backward");
});

test("generic evidence is normalized and under-supported exact-model forecasts cannot publish money", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const comparableSales = Array.from({ length: 55 }, (_, index) => ({
    id: `verified-sale-${index + 1}`,
    title: `Verified sale ${index + 1}`,
    soldPrice: 100 + index,
    soldAt: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    url: `https://comps.example.invalid/sale-${index + 1}`,
    source: "Licensed sold feed",
    modelKey: "watch:reference-12",
    matchScore: 90,
  }));
  comparableSales.splice(2, 0,
    { title: "Malformed sale without price", source: "Licensed sold feed" },
    { title: "Non-USD sale", soldPrice: 999, currency: "EUR", source: "Licensed sold feed" },
  );
  const payload = {
    generatedAt: "2026-08-02T14:00:00Z",
    items: [{
      id: "evidence-1",
      title: "Evidence-backed generic record",
      similarItemKey: "watch:reference-12",
      currentBid: 275,
      shipping: 0,
      marketplaceFee: 0,
      observedAt: "2026-08-02T14:00:00Z",
      resaleLow: 88,
      comparableSales,
      auctionComparables: "not-an-array",
      forecast: {
        status: "verified",
        expected: 500,
        low: 450,
        high: 600,
        sampleSize: 12,
        exactModelCount: 4,
        curveCount: 18,
        confidence: "81%",
        reasonCodes: ["TOO_FEW_COMPS"],
      },
    }],
  };
  const feedUrl = "https://feeds.example.invalid/evidence.json";
  const preloadPath = join(fixture.root, "evidence-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  const item = envelope.items[0];
  assert.equal(item.modelKey, "watch:reference-12");
  assert.equal(item.comparableSales.length, 50);
  assert.equal(item.compCount, 50);
  assert.equal(item.resaleLow, 88, "An explicit source estimate must not be overwritten");
  assert.equal(item.resaleMedian, 124.5);
  assert.equal(item.resaleHigh, 139.2);
  assert.deepEqual(item.auctionComparables, []);
  assert.equal(item.shipping, 0);
  assert.equal(item.shippingKnown, true);
  assert.equal(item.marketplaceFee, 0);
  assert.equal(item.feeKnown, true);
  assert.equal(item.forecast.status, "insufficient-data");
  assert.equal(item.forecast.sampleSize, 12);
  assert.equal(item.forecast.exactModelCount, 4);
  assert.equal(item.forecast.curveCount, 18);
  assert.equal(item.forecast.confidence, 0.81);
  assert.equal(item.forecast.expected, null);
  assert.equal(item.forecast.low, null);
  assert.equal(item.forecast.high, null);
  assert.deepEqual(item.observations[0].forecast, item.forecast);
});

test("BidAI Pro generates and snapshots an exact-model time-to-close forecast from five dated outcomes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const finalPrices = [200, 250, 300, 350];
  const endedItems = finalPrices.map((finalPrice, index) => {
    const day = 20 + index;
    return {
      id: `ended-${index + 1}`,
      title: `Exact Model X completed outcome ${index + 1}`,
      modelKey: "camera:model-x",
      sourceUrl: `https://archive.example.invalid/model-x-${index + 1}`,
      finalPrice,
      endsAt: `2026-07-${day}T12:00:00Z`,
      observedAt: `2026-07-${day}T13:00:00Z`,
      history: [{
        observedAt: `2026-07-${day - 3}T12:00:00Z`,
        currentBid: finalPrice / 2,
        bidCount: 4 + index,
        status: "active",
      }],
    };
  });
  const payload = {
    generatedAt: "2030-08-02T12:00:00Z",
    items: [
      {
        id: "target-model-x",
        title: "Active exact Model X target",
        modelKey: "CAMERA:model-x",
        sourceUrl: "https://auction.example.invalid/target-model-x",
        currentBid: 100,
        bidCount: 7,
        endsAt: "2026-08-05T12:00:00Z",
        observedAt: "2026-08-02T12:00:00Z",
        auctionComparables: [{
          id: "model-x-curve-5",
          title: "Exact Model X archived auction curve",
          modelKey: "camera:model-x",
          finalPrice: 400,
          endedAt: "2026-07-24T12:00:00Z",
          sourceUrl: "https://archive.example.invalid/model-x-5",
          source: "Licensed auction archive",
          matchScore: 96,
          bidAtComparableTime: 200,
          hoursToClose: 72,
        }],
        history: [{
          observedAt: "2026-08-02T11:00:00Z",
          currentBid: 80,
          bidCount: 6,
          status: "active",
        }],
      },
      {
        id: "target-with-source",
        title: "Active target with verified source forecast",
        modelKey: "camera:model-x",
        sourceUrl: "https://auction.example.invalid/target-with-source",
        currentBid: 110,
        endsAt: "2026-08-05T12:00:00Z",
        observedAt: "2026-08-02T12:00:00Z",
        forecast: {
          status: "verified",
          asOf: "2026-08-02T12:00:00Z",
          modelVersion: "licensed-source-v3",
          expected: 333,
          low: 275,
          high: 410,
          sampleSize: 8,
          exactModelCount: 6,
          curveCount: 5,
          method: "licensed source model",
          reasonCodes: ["SOURCE_VERIFIED"],
        },
      },
      {
        id: "target-with-unsubstantiated-source",
        title: "Active target with unsubstantiated source forecast",
        modelKey: "camera:model-y",
        sourceUrl: "https://auction.example.invalid/target-with-unsubstantiated-source",
        currentBid: 95,
        endsAt: "2026-08-05T12:00:00Z",
        observedAt: "2026-08-02T12:00:00Z",
        forecast: {
          status: "verified",
          asOf: "2026-08-02T12:00:00Z",
          modelVersion: "self-reported-source-v1",
          expected: 500,
          low: 400,
          high: 600,
          sampleSize: 50,
          exactModelCount: 50,
          method: "source-declared model",
          reasonCodes: ["SOURCE_DECLARED"],
        },
      },
      {
        id: "target-with-stale-source",
        title: "Active target with a stale source forecast",
        modelKey: "camera:model-x",
        sourceUrl: "https://auction.example.invalid/target-with-stale-source",
        currentBid: 120,
        endsAt: "2026-08-05T12:00:00Z",
        observedAt: "2026-08-02T12:00:00Z",
        forecast: {
          status: "verified",
          asOf: "2026-08-02T09:00:00Z",
          modelVersion: "stale-source-v1",
          expected: 350,
          low: 300,
          high: 425,
          sampleSize: 8,
          exactModelCount: 8,
          method: "stale licensed source model",
          reasonCodes: ["SOURCE_VERIFIED"],
        },
      },
      {
        id: "target-final-distribution",
        title: "Active Model X target without a closing time",
        modelKey: "camera:model-x",
        sourceUrl: "https://auction.example.invalid/target-final-distribution",
        currentBid: 225,
        observedAt: "2026-08-02T12:00:00Z",
      },
      ...endedItems,
    ],
  };
  const feedUrl = "https://feeds.example.invalid/empirical-learning.json";
  const preloadPath = join(fixture.root, "empirical-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  `, "utf8");
  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  const target = envelope.items.find((item) => item.externalId === "target-model-x");
  assert.ok(target);
  assert.deepEqual(target.forecast, {
    status: "available",
    asOf: "2026-08-02T12:00:00.000Z",
    modelVersion: "empirical-close-v1",
    expected: 200,
    low: 200,
    high: 200,
    sampleSize: 5,
    exactModelCount: 5,
    curveCount: 5,
    confidence: null,
    method: "exact-model time-to-close uplift",
    evidenceIds: [
      "id:authorized feed:ended-1",
      "id:authorized feed:ended-2",
      "id:authorized feed:ended-3",
      "id:authorized feed:ended-4",
      "id:licensed auction archive:model-x-curve-5",
    ],
    evidenceHash: "7464c4efcb14c1116755d53cf8e09e41f16f13aaebe07a31323c49c0e55716da",
    reasonCodes: ["BIDAI_EMPIRICAL_EXACT_MODEL", "TIME_TO_CLOSE_UPLIFT", "DATED_OUTCOMES_ONLY"],
  });
  assert.equal("forecast" in target.observations[0], false, "An older target observation must remain immutable");
  assert.deepEqual(target.observations[1].forecast, target.forecast);

  const endedLearningItem = envelope.items.find((item) => item.externalId === "ended-1");
  assert.deepEqual(
    endedLearningItem.observations.map((observation) => observation.status),
    ["active", "ended"],
    "A final-price refresh must not rewrite a pre-close observation as ended",
  );

  const sourceTarget = envelope.items.find((item) => item.externalId === "target-with-source");
  assert.equal(sourceTarget.forecast.modelVersion, "licensed-source-v3");
  assert.equal(sourceTarget.forecast.expected, 333, "A verified source forecast must not be overwritten");
  assert.deepEqual(sourceTarget.observations.at(-1).forecast, sourceTarget.forecast);

  const unsupportedSourceTarget = envelope.items.find((item) => item.externalId === "target-with-unsubstantiated-source");
  assert.equal(unsupportedSourceTarget.forecast.status, "insufficient-data");
  assert.equal(unsupportedSourceTarget.forecast.expected, null);
  assert.ok(unsupportedSourceTarget.forecast.reasonCodes.includes("EXACT_MODEL_EVIDENCE_NOT_REVALIDATED"));
  assert.deepEqual(unsupportedSourceTarget.observations.at(-1).forecast, unsupportedSourceTarget.forecast);

  const staleSourceTarget = envelope.items.find((item) => item.externalId === "target-with-stale-source");
  assert.equal(staleSourceTarget.forecast.modelVersion, "empirical-close-v1");
  assert.equal(staleSourceTarget.forecast.expected, 240, "A stale source forecast must not block the point-in-time empirical model");

  const distributionTarget = envelope.items.find((item) => item.externalId === "target-final-distribution");
  assert.equal(distributionTarget.forecast.method, "exact-model final-price distribution");
  assert.equal(distributionTarget.forecast.curveCount, 0);
  assert.equal(distributionTarget.forecast.low, 240);
  assert.equal(distributionTarget.forecast.expected, 300);
  assert.equal(distributionTarget.forecast.high, 360);
});

test("a sparse final refresh preserves the evidence and forecast snapshot needed for learning", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const feedUrl = "https://feeds.example.invalid/partial-final.json";
  const preloadPath = join(fixture.root, "partial-final-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  `, "utf8");
  const runPayload = (payload) => runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const auctionComparables = Array.from({ length: 5 }, (_, index) => ({
    id: `gold-close-${index + 1}`,
    title: `Exact 14k gold lot close ${index + 1}`,
    modelKey: "gold:14k:20g",
    finalPrice: 200 + index * 20,
    endedAt: `2026-07-${20 + index}T12:00:00Z`,
    outcomeObservedAt: `2026-07-${20 + index}T12:05:00Z`,
    source: "Licensed auction archive",
    matchScore: 95,
  }));
  const firstPayload = {
    generatedAt: "2026-08-02T12:00:00Z",
    items: [{
      id: "gold-target",
      title: "Exact 14k gold target",
      category: "Jewelry",
      modelKey: "gold:14k:20g",
      currentBid: 100,
      shipping: 12,
      endsAt: "2030-08-02T18:00:00Z",
      observedAt: "2030-08-02T12:00:00Z",
      resaleLow: 800,
      resaleMedian: 900,
      resaleHigh: 1000,
      intrinsicValueEvidence: true,
      valuationBasis: {
        referenceObservedAt: "2030-08-02T11:30:00Z",
        currency: "USD",
        unit: "gram",
        purity: "14k",
        grossWeightGrams: 20,
        reference14kMeltPerGram: 70,
        source: "Licensed metals feed",
      },
      auctionComparables,
    }],
  };
  const firstRun = await runPayload(firstPayload);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const firstEnvelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  const first = firstEnvelope.items[0];
  assert.equal(first.forecast.status, "available");
  assert.equal(first.forecast.evidenceIds.length, 5);
  assert.equal(first.observations[0].forecast.evidenceHash, first.forecast.evidenceHash);

  const finalPayload = {
    generatedAt: "2030-08-02T19:00:00Z",
    items: [{
      id: "gold-target",
      title: "Exact 14k gold target",
      finalPrice: 250,
      endsAt: "2030-08-02T18:00:00Z",
      observedAt: "2030-08-02T19:00:00Z",
      status: "ended",
    }],
  };
  const finalRun = await runPayload(finalPayload);
  assert.equal(finalRun.code, 0, finalRun.stderr);
  const finalEnvelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  const ended = finalEnvelope.items[0];
  assert.equal(ended.status, "ended");
  assert.equal(ended.finalPrice, 250);
  assert.equal(ended.modelKey, "gold:14k:20g");
  assert.equal(ended.shipping, 12);
  assert.equal(ended.resaleMedian, 900);
  assert.equal(ended.intrinsicValueEvidence, true);
  assert.equal(ended.valuationBasis.reference14kMeltPerGram, 70);
  assert.equal(ended.auctionComparables.length, 5);
  assert.equal(ended.observations.length, 2);
  assert.equal(ended.observations[0].forecast.evidenceIds.length, 5);
  assert.equal("forecast" in ended.observations[1], false);
});

test("four exact, future, undated, and mismatched outcomes cannot generate a forecast", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const records = [{
    id: "guarded-target",
    title: "Guarded active target",
    category: "Cameras",
    modelKey: "camera:model-y",
    currentBid: 125,
    endsAt: "2026-08-05T12:00:00Z",
    observedAt: "2026-08-02T12:00:00Z",
    auctionComparables: [
      {
        id: "duplicate-outcome",
        title: "Duplicate outcome first representation",
        modelKey: "camera:model-y",
        matchScore: 95,
        finalPrice: 310,
        endedAt: "2026-07-24T12:00:00Z",
        source: "Licensed archive",
      },
      {
        id: "duplicate-outcome",
        title: "Duplicate outcome revised title and price",
        modelKey: "camera:model-y",
        matchScore: 96,
        finalPrice: 320,
        endedAt: "2026-07-24T12:00:00Z",
        source: "Licensed archive",
      },
    ],
  }];
  for (let index = 0; index < 3; index += 1) {
    records.push({
      id: `valid-exact-${index}`,
      title: `Valid exact outcome ${index}`,
      category: "Cameras",
      modelKey: "camera:model-y",
      finalPrice: 250 + index,
      endsAt: `2026-07-${20 + index}T12:00:00Z`,
      observedAt: `2026-07-${20 + index}T13:00:00Z`,
    });
  }
  records.push(
    {
      id: "cross-owner-duplicate-a",
      title: "Owner of a repeated archived outcome",
      modelKey: "unrelated:owner-a",
      currentBid: 10,
      endsAt: "2026-08-06T12:00:00Z",
      observedAt: "2026-08-01T12:00:00Z",
      auctionComparables: [{
        id: "duplicate-outcome",
        title: "Same archived outcome from owner A",
        modelKey: "camera:model-y",
        matchScore: 97,
        finalPrice: 315,
        endedAt: "2026-07-24T12:00:00Z",
        source: "Licensed archive",
      }],
    },
    {
      id: "cross-owner-duplicate-b",
      title: "Second owner of the repeated archived outcome",
      modelKey: "unrelated:owner-b",
      currentBid: 11,
      endsAt: "2026-08-06T12:00:00Z",
      observedAt: "2026-08-01T12:05:00Z",
      auctionComparables: [{
        id: "duplicate-outcome",
        title: "Same archived outcome with revised metadata",
        modelKey: "camera:model-y",
        matchScore: 98,
        finalPrice: 319,
        endedAt: "2026-07-24T12:00:00Z",
        source: "Licensed archive",
      }],
    },
    {
      id: "future-exact",
      title: "Future exact outcome",
      modelKey: "camera:model-y",
      finalPrice: 999,
      endsAt: "2026-08-02T13:00:00Z",
      observedAt: "2026-08-02T13:05:00Z",
    },
    {
      id: "undated-exact",
      title: "Undated exact outcome",
      modelKey: "camera:model-y",
      finalPrice: 888,
      observedAt: "2026-08-01T12:00:00Z",
    },
    {
      id: "late-backfilled-exact",
      title: "Exact outcome learned after the target snapshot",
      modelKey: "camera:model-y",
      finalPrice: 666,
      endsAt: "2026-07-26T12:00:00Z",
      observedAt: "2026-08-02T13:00:00Z",
    },
    {
      id: "category-only",
      title: "Same category but wrong model",
      category: "Cameras",
      modelKey: "camera:model-z",
      finalPrice: 777,
      endsAt: "2026-07-25T12:00:00Z",
      observedAt: "2026-07-25T13:00:00Z",
    },
  );
  const feedUrl = "https://feeds.example.invalid/guarded-learning.json";
  const preloadPath = join(fixture.root, "guarded-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  `, "utf8");
  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify({ generatedAt: "2026-08-02T12:00:00Z", items: records })).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  const target = envelope.items.find((item) => item.externalId === "guarded-target");
  assert.ok(target);
  assert.equal("forecast" in target, false);
  assert.equal("forecast" in target.observations.at(-1), false);
});

test("Apify mode rejects malformed and non-USD evidence rows", async (t) => {
  const invalidCases = [
    {
      name: "row currency",
      record: {
        id: "bad-currency",
        title: "Wrong currency",
        currency: "EUR",
        observedAt: "2026-08-02T15:00:00Z",
      },
      error: /denominated in USD/i,
    },
    {
      name: "comparable currency",
      record: {
        id: "bad-comp-currency",
        title: "Wrong comparable currency",
        observedAt: "2026-08-02T15:00:00Z",
        comparableSales: [{ title: "Euro sale", soldPrice: 500, currency: "EUR" }],
      },
      error: /Every Apify comparable/i,
    },
    {
      name: "malformed comparable",
      record: {
        id: "bad-comp",
        title: "Malformed comparable",
        observedAt: "2026-08-02T15:00:00Z",
        comparableSales: [{ title: "Missing sold price" }],
      },
      error: /Every Apify comparable/i,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async (subtest) => {
      const fixture = await createFixture();
      subtest.after(() => rm(fixture.root, { recursive: true, force: true }));
      const preloadPath = join(fixture.root, "invalid-fetch.mjs");
      await writeFile(preloadPath, `
        const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
        globalThis.fetch = async () => new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      `, "utf8");
      const payload = [invalidCase.record];
      const result = await runNode(
        ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
        {
          cwd: fixture.root,
          env: {
            ...process.env,
            BIDAI_SOURCE_AUTHORIZED: "true",
            BIDAI_APIFY_DATASET_ID: "test-account~invalid-data",
            BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, invalidCase.error);
    });
  }
});
