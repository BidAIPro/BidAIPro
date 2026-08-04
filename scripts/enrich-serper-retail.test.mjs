import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyIdentity,
  marketFromPayload,
  mergeFreeRetailEvidence,
  normalizeShoppingResult,
  parseStrictPrice,
  queryForItem,
  reconcilePersistentQueue,
  runEnrichment,
  selectDueQueue,
} from "./enrich-serper-retail.mjs";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const FIXED_NOW = new Date("2026-08-03T18:00:00.000Z");

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
    currentBid: 25,
    bidCount: 3,
    endsAt: "2026-08-05T18:00:00.000Z",
    ...extra,
  };
}

function shoppingResult({ title, source, price, link, delivery = "Free shipping", ...rest }) {
  return { title, source, price, link, delivery, ...rest };
}

async function fixture(items) {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-serper-test-"));
  await mkdir(join(root, "data"), { recursive: true });
  const path = join(root, "data", "live-snapshots.js");
  const envelope = { observedAt: FIXED_NOW.toISOString(), sourceMode: "test", sourceNotes: [], items };
  await writeFile(path, `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`, "utf8");
  return { root, path };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("identity classification distinguishes exact, strong, approximate, model conflict, and accessory mismatch", () => {
  const phone = activeItem("phone", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", { brand: "Apple" });
  const exact = classifyIdentity(phone, { title: "Apple iPhone 15 Pro 256GB Unlocked Smartphone", brand: "Apple" });
  assert.equal(exact.accepted, true);
  assert.equal(exact.matchType, "exact");
  assert.equal(exact.matchedBy, "model and title");

  const modelConflict = classifyIdentity(phone, { title: "Apple iPhone 14 Pro 256GB Unlocked Smartphone", brand: "Apple" });
  assert.equal(modelConflict.accepted, false);
  assert.equal(modelConflict.reasonCode, "model-conflict");

  const accessory = classifyIdentity(phone, { title: "Protective Case for Apple iPhone 15 Pro Smartphone", brand: "Apple" });
  assert.equal(accessory.accepted, false);
  assert.equal(accessory.reasonCode, "accessory-mismatch");

  const mixer = activeItem("mixer", "KitchenAid Artisan 5 Quart Stand Mixer Empire Red");
  const strong = classifyIdentity(mixer, { title: "KitchenAid Artisan Series 5 Quart Stand Mixer Red" });
  assert.equal(strong.accepted, true);
  assert.equal(strong.matchType, "strong");
  assert.ok(strong.matchScore >= 80);

  const typewriter = activeItem("typewriter", "Vintage Olympia Portable Manual Typewriter with Case");
  const approximate = classifyIdentity(typewriter, { title: "Olympia Portable Typewriter Vintage Working" });
  assert.equal(approximate.accepted, true);
  assert.equal(approximate.matchType, "approximate");
});

test("identifier queries and exact identifier matches take precedence over title inference", () => {
  const target = activeItem("console", "Sony PlayStation Console", { upc: "711719542028" });
  assert.deepEqual(queryForItem(target), {
    type: "identifier",
    value: "711719542028",
    key: "identifier:711719542028",
  });
  const match = classifyIdentity(target, {
    title: "Sony PS5 Disc Edition Game Console",
    gtin: "00711719542028",
  });
  assert.equal(match.accepted, true);
  assert.equal(match.matchType, "exact");
  assert.equal(match.matchedBy, "catalog identifier");
});

test("normalization keeps structured price evidence and rejects installments, ranges, accessories, and model conflicts", () => {
  const target = activeItem("phone", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", { brand: "Apple" });
  const query = queryForItem(target);
  const accepted = normalizeShoppingResult(shoppingResult({
    title: "Apple iPhone 15 Pro 256GB Unlocked Smartphone - Used",
    source: "Example Mobile",
    price: "$799.99",
    delivery: "$12.50 shipping",
    link: "https://merchant.example/products/iphone-15-pro",
    productId: "google-product-1",
    rating: 4.7,
    ratingCount: 812,
    offers: "10+",
  }), target, query, FIXED_NOW.toISOString());
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.offer.price, 799.99);
  assert.equal(accepted.offer.shipping, 12.5);
  assert.equal(accepted.offer.totalPrice, 812.49);
  assert.equal(accepted.offer.source, "Example Mobile");
  assert.equal(accepted.offer.link, "https://merchant.example/products/iphone-15-pro");
  assert.equal(accepted.offer.rating, 4.7);
  assert.equal(accepted.offer.reviews, 812);
  assert.equal(accepted.offer.offerCount, 10);
  assert.equal(accepted.offer.offerCountIsMinimum, true);
  assert.equal(accepted.offer.condition, "used");
  assert.equal(accepted.offer.isCurrent, true);

  const common = {
    source: "Bad Merchant",
    link: "https://bad.example/product",
    title: target.title,
  };
  assert.equal(normalizeShoppingResult({ ...common, price: "$29.99/mo" }, target, query).reasonCode, "installment-price");
  assert.equal(normalizeShoppingResult({ ...common, price: "$700 - $900" }, target, query).reasonCode, "price-range");
  assert.equal(normalizeShoppingResult({ ...common, title: "Case for Apple iPhone 15 Pro", price: "$19.99" }, target, query).reasonCode, "accessory-mismatch");
  assert.equal(normalizeShoppingResult({ ...common, title: "Apple iPhone 14 Pro 256GB", price: "$599" }, target, query).reasonCode, "model-conflict");
  assert.equal(normalizeShoppingResult({ ...common, title: "Apple iPhone 15 Pro 128GB", price: "$699" }, target, query).reasonCode, "variant-conflict");
  assert.equal(parseStrictPrice("$1,299.99"), 1299.99);
  assert.equal(parseStrictPrice("starting at $799"), null);
});

test("a corroborated exact shopping market stores price, shipping, sources, popularity, and rejection accounting", () => {
  const target = activeItem("phone", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", { brand: "Apple" });
  const query = queryForItem(target);
  const market = marketFromPayload(target, query, { shopping: [
    shoppingResult({
      title: target.title,
      source: "Merchant A",
      price: "$700.00",
      delivery: "Free shipping",
      link: "https://a.example/iphone",
      rating: 4.5,
      ratingCount: 100,
      offers: "3",
    }),
    shoppingResult({
      title: `${target.title} - Excellent Condition`,
      source: "Merchant B",
      price: "$800.00",
      delivery: "$20.00 shipping",
      link: "https://b.example/iphone",
      rating: 4.9,
      ratingCount: 500,
      offers: "12+",
    }),
    shoppingResult({
      title: "Case for Apple iPhone 15 Pro",
      source: "Accessory Shop",
      price: "$15.00",
      link: "https://accessory.example/case",
    }),
  ] }, FIXED_NOW.toISOString());
  assert.equal(market.status, "available");
  assert.equal(market.catalog.matchType, "exact");
  assert.equal(market.catalog.sampleSize, 2);
  assert.equal(market.catalog.sourceCount, 2);
  assert.equal(market.priceSummary.priceLow, 700);
  assert.equal(market.priceSummary.priceMedian, 750);
  assert.equal(market.priceSummary.priceAverage, 750);
  assert.equal(market.priceSummary.priceHigh, 800);
  assert.equal(market.priceSummary.landedMedian, 760);
  assert.equal(market.offers.length, 2);
  assert.equal(market.productInterest.reviewCountMax, 500);
  assert.equal(market.productInterest.merchantOfferCountMax, 12);
  assert.equal(market.rejections.byReason["accessory-mismatch"], 1);
  assert.equal(market.checkedAt, FIXED_NOW.toISOString());
});

test("the persistent queue removes ended records, preserves attempt state, adds new records, and honors the run cap", () => {
  const first = activeItem("first", "Apple iPhone 15 Pro 256GB Unlocked Smartphone");
  const second = activeItem("second", "KitchenAid Artisan 5 Quart Stand Mixer Empire Red");
  const ended = activeItem("ended", "Sony PlayStation 5 Disc Edition Console", { endsAt: "2026-08-03T17:59:00.000Z" });
  const oldQuery = queryForItem(second);
  const prior = [{
    queryKey: oldQuery.key,
    query: { type: oldQuery.type, value: oldQuery.value },
    listingKeys: ["id:second", "id:ended"],
    enqueuedAt: "2026-08-01T00:00:00.000Z",
    lastAttemptAt: "2026-08-02T00:00:00.000Z",
    nextEligibleAt: "2026-08-02T01:00:00.000Z",
    attempts: 4,
    lastStatus: "completed",
  }];
  const queue = reconcilePersistentQueue([first, second, ended], prior, FIXED_NOW.getTime());
  assert.equal(queue.length, 2);
  const retained = queue.find((entry) => entry.queryKey === oldQuery.key);
  assert.deepEqual(retained.listingKeys, ["id:second"]);
  assert.equal(retained.attempts, 4);
  assert.equal(retained.enqueuedAt, "2026-08-01T00:00:00.000Z");
  assert.ok(queue.every((entry) => !entry.listingKeys.includes("id:ended")));
  const due = selectDueQueue(queue, 1, FIXED_NOW.getTime());
  assert.equal(due.length, 1);
  assert.equal(due[0].listingKeys[0], "id:first", "never-attempted records are researched before recycling an old query");
});

test("never-researched active listings closest to auction close are priced first", () => {
  const later = activeItem("later", "KitchenAid Artisan 5 Quart Stand Mixer Empire Red", {
    endsAt: "2026-08-05T18:00:00.000Z",
  });
  const sooner = activeItem("sooner", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", {
    endsAt: "2026-08-03T18:20:00.000Z",
  });
  const queue = reconcilePersistentQueue([later, sooner], [], FIXED_NOW.getTime());
  const due = selectDueQueue(queue, 1, FIXED_NOW.getTime());
  assert.equal(due[0].listingKeys[0], "id:sooner");
  assert.equal(due[0].earliestEndsAt, "2026-08-03T18:20:00.000Z");
});

test("incremental runs rotate through active records, persist history, and project strong evidence into the UI catalog field", async (t) => {
  const sample = await fixture([
    activeItem("phone", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", { brand: "Apple" }),
    activeItem("mixer", "KitchenAid Artisan 5 Quart Stand Mixer Empire Red"),
  ]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://google.serper.dev/shopping");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-API-KEY"], "test-serper-key");
    assert.equal(options.headers["Content-Type"], "application/json");
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.gl, "us");
    assert.equal(body.hl, "en");
    if (/iphone/i.test(body.q)) {
      return response({ shopping: [
        shoppingResult({ title: "Apple iPhone 15 Pro 256GB Unlocked Smartphone", source: "Phone A", price: "$700", link: "https://phone-a.example/15" }),
        shoppingResult({ title: "Apple iPhone 15 Pro 256GB Unlocked Smartphone", source: "Phone B", price: "$750", link: "https://phone-b.example/15" }),
      ] });
    }
    return response({ shopping: [
      shoppingResult({ title: "KitchenAid Artisan Series 5 Quart Stand Mixer Red", source: "Kitchen A", price: "$299", link: "https://kitchen-a.example/mixer" }),
      shoppingResult({ title: "KitchenAid Artisan 5 Quart Stand Mixer Empire Red", source: "Kitchen B", price: "$329", link: "https://kitchen-b.example/mixer" }),
    ] });
  };
  const silent = { log() {}, warn() {} };
  const common = {
    path: sample.path,
    apiKey: "test-serper-key",
    fetchImpl,
    logger: silent,
    delay: async () => {},
    delayMs: 0,
    maxQueriesPerRun: 1,
    refreshHours: 24,
    retryHours: 1,
  };
  const firstRun = await runEnrichment({ ...common, now: FIXED_NOW });
  assert.equal(firstRun.requested, 1);
  let envelope = await readEnvelope(sample.path);
  assert.equal(envelope.items.filter((item) => item.serperRetailMarket).length, 1);
  assert.equal(envelope.serperRetailEnrichment.queue.length, 2);
  assert.equal(envelope.serperRetailEnrichment.queue.filter((entry) => entry.attempts === 1).length, 1);

  const secondRun = await runEnrichment({ ...common, now: new Date(FIXED_NOW.getTime() + 60_000) });
  assert.equal(secondRun.requested, 1);
  envelope = await readEnvelope(sample.path);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].q, calls[1].q);
  assert.ok(envelope.items.every((item) => item.serperRetailMarket?.status === "available"));
  assert.ok(envelope.items.every((item) => item.freeRetailMarket?.provider === "serper"));
  assert.ok(envelope.items.every((item) => item.serperRetailHistory?.length === 1));
  assert.ok(envelope.items.every((item) => item.serperRetailMarket.checkedAt));
  assert.ok(envelope.serperRetailEnrichment.queue.every((entry) => entry.attempts === 1));
});

test("transient API failure retains prior Serper and stronger free-retail evidence while recording the failed research attempt", async (t) => {
  const oldSerper = {
    status: "available",
    provider: "serper",
    channel: "Google Shopping via Serper",
    asOf: "2026-08-02T18:00:00.000Z",
    checkedAt: "2026-08-02T18:00:00.000Z",
    query: { type: "title", value: "apple iphone 15 pro" },
    catalog: { matchType: "exact", matchTier: "exact", matchScore: 95, sampleSize: 2, sourceCount: 2, priceLow: 700, priceMedian: 725, priceHigh: 750 },
    priceSummary: { sampleSize: 2, sourceCount: 2, priceLow: 700, priceMedian: 725, priceHigh: 750 },
    offers: [{ id: "old", source: "Old Source", url: "https://old.example/item", price: 725, totalPrice: 725, matchScore: 95 }],
  };
  const strongerCatalog = {
    status: "available",
    provider: "upcitemdb",
    asOf: "2026-08-02T17:00:00.000Z",
    catalog: { matchTier: "exact-upc-gtin", matchScore: 100, sampleSize: 3, sourceCount: 3, priceLow: 690, priceMedian: 720, priceHigh: 760 },
    offers: [],
  };
  const sample = await fixture([activeItem("phone", "Apple iPhone 15 Pro 256GB Unlocked Smartphone", {
    serperRetailMarket: oldSerper,
    freeRetailMarket: strongerCatalog,
  })]);
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const result = await runEnrichment({
    path: sample.path,
    apiKey: "test-serper-key",
    fetchImpl: async () => response({ message: "service unavailable" }, 503),
    now: FIXED_NOW,
    logger: { log() {}, warn() {} },
    delay: async () => {},
    delayMs: 0,
    maxQueriesPerRun: 1,
  });
  assert.equal(result.transientFailures, 1);
  assert.equal(result.stoppedStatus, 503);
  const item = (await readEnvelope(sample.path)).items[0];
  assert.equal(item.serperRetailMarket.status, "available");
  assert.equal(item.serperRetailMarket.catalog.priceMedian, 725);
  assert.equal(item.serperRetailMarket.lastAttempt.status, "error");
  assert.equal(item.serperRetailMarket.lastAttempt.httpStatus, 503);
  assert.equal(item.freeRetailMarket.provider, "upcitemdb");
  assert.equal(item.freeRetailMarket.catalog.priceMedian, 720);
  assert.equal(item.serperRetailHistory.at(-1).status, "insufficient");
  assert.equal(item.serperRetailHistory.at(-1).transient, true);
});

test("a weaker Serper catalog result cannot replace stronger existing exact catalog evidence", () => {
  const existing = {
    status: "available",
    provider: "upcitemdb",
    catalog: { matchTier: "exact-upc-gtin", matchScore: 100, sourceCount: 4, sampleSize: 4 },
  };
  const attempted = {
    status: "reference-only",
    provider: "serper",
    asOf: FIXED_NOW.toISOString(),
    catalog: { matchType: "strong", matchTier: "strong", matchScore: 84, sourceCount: 1, sampleSize: 1 },
  };
  const retained = mergeFreeRetailEvidence(existing, attempted);
  assert.equal(retained.provider, "upcitemdb");
  assert.equal(retained.catalog.matchScore, 100);
  assert.equal(retained.lastAttempt.provider, "serper");
});
