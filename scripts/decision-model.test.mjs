import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const scriptSource = await readFile(new URL("../script.js", import.meta.url), "utf8");

function loadModel() {
  const window = {
    BIDAI_TEST_MODE: true,
    BIDAI_LIVE_SNAPSHOTS: { observedAt: null, sourceMode: "test", items: [] },
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const context = vm.createContext({
    window,
    localStorage,
    console,
    URL,
    Date,
    Math,
    Intl,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    RegExp,
    Error,
  });
  vm.runInContext(scriptSource, context, { filename: "script.js" });
  return window.BIDAI_TEST_API;
}

function comparable(id, price, modelKey, daysAgo) {
  const soldAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    id,
    externalId: id,
    title: `Exact model sale ${id}`,
    soldPrice: price,
    soldAt,
    endedAt: soldAt,
    outcomeObservedAt: soldAt,
    modelKey,
    matchScore: 95,
    source: "Licensed completed-sales test feed",
  };
}

function baseItem(overrides = {}) {
  const now = new Date();
  const modelKey = "brand:model-123";
  return {
    id: "target-1",
    externalId: "target-1",
    sourceKey: "auction-test",
    source: "Auction Test",
    title: "Brand Model 123 Watch",
    category: "Watches",
    modelKey,
    currentBid: 100,
    shipping: 10,
    shippingKnown: true,
    bidCount: 8,
    observedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
    status: "active",
    identityConfidence: 0.9,
    conditionConfidence: 0.8,
    comparableSales: [
      comparable("sale-1", 800, modelKey, 3),
      comparable("sale-2", 900, modelKey, 2),
      comparable("sale-3", 1_000, modelKey, 1),
    ],
    resaleMarket: {
      status: "available",
      asOf: now.toISOString(),
      lookbackDays: 90,
      soldListingCount: 12,
      activeListingCount: 8,
      medianDaysToSell: 9,
      channel: "Licensed completed sales",
    },
    metalEstimate: {
      metal: "gold",
      purityLabel: "14K",
      purityFraction: 0.585,
      grossWeightGrams: 10,
      spotPerTroyOunce: 4_000,
      meltCeiling: 752.327,
      quoteObservedAt: now.toISOString(),
      sourceDescriptionStatus: "source-stated-tested",
      nonMetalWarning: "Purity and weight require verification",
    },
    ...overrides,
  };
}

test("a target-safe pawn route is recommended before an also-profitable online route", () => {
  const model = loadModel();
  const result = model.assess(baseItem());
  assert.equal(result.pawnSafeNow, true);
  assert.equal(result.onlineSafeNow, true);
  assert.equal(result.exitType, "pawn");
  assert.equal(result.recommendationState, "pawn-safe");
  assert.ok(result.pawnBreakEvenBid > result.pawnMaxBid);
  assert.ok(result.pawnProfitAtCurrentBid > 0);
  assert.equal(model.recommendationLabel(result.recommendationState), "Pawn profit now");
});

test("online resale becomes the recommendation when pawn misses the target-safe ceiling", () => {
  const model = loadModel();
  const result = model.assess(baseItem({ currentBid: 350 }));
  assert.equal(result.pawnSafeNow, false);
  assert.equal(result.pawnLikelyProfitable, false);
  assert.equal(result.onlineSafeNow, true);
  assert.equal(result.exitType, "online-resale");
  assert.equal(result.recommendationState, "online-safe");
  assert.ok(result.resaleBreakEvenBid > result.resaleMaxBid);
  assert.ok(result.profitAtCurrentBid > 0);
});

test("a popular non-metal item can use the online route without a pawn estimate", () => {
  const model = loadModel();
  const item = baseItem();
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasMetalEstimate, false);
  assert.equal(result.onlineSafeNow, true);
  assert.equal(result.exitType, "online-resale");
  assert.equal(result.onlinePopularityKnown, true);
  assert.ok(result.onlinePopularityScore > 0);
  assert.ok(result.onlineSaleLikelihood > 0);
});

test("an unsupported item receives zero ceilings instead of an invented exit", () => {
  const model = loadModel();
  const item = baseItem({ comparableSales: [], resaleMarket: null });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.exitType, "no-evidence");
  assert.equal(result.recommendationState, "no-evidence");
  assert.equal(result.maxBid, 0);
  assert.equal(result.breakEvenBid, 0);
  assert.equal(result.decisionProfitAtCurrentBid, null);
});
