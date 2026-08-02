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
  assert.equal(result.decisionVerdict, "YES");
  assert.ok(result.rankingScore >= 50);
  assert.ok(result.bidHeadroom > 0);
  assert.ok(result.researchCoverageScore > 0);
  assert.equal(model.recommendationLabel(result.recommendationState), "YES · Pawn profit");
});

test("snapshot cadence is configurable outside the locked final five and one minute windows", () => {
  const model = loadModel();
  model.setCloudControl({ normalMinutes: 120, nearCloseMinutes: 10 });
  const now = Date.now();
  const plan = (millisecondsRemaining) => model.snapshotPlanFor({
    status: "active",
    endsAt: new Date(now + millisecondsRemaining).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
  });

  assert.equal(plan(2 * 60 * 60_000).intervalMinutes, 120);
  assert.equal(plan(20 * 60_000).intervalMinutes, 10);
  assert.equal(plan(4 * 60_000).intervalMinutes, 0.5);
  assert.equal(plan(50_000).intervalMinutes, 1 / 12);
  assert.match(plan(4 * 60_000).label, /30 sec/);
  assert.match(plan(50_000).label, /5 sec/);
});

test("online resale becomes the recommendation when pawn misses the target-safe ceiling", () => {
  const model = loadModel();
  const result = model.assess(baseItem({ currentBid: 350 }));
  assert.equal(result.pawnSafeNow, false);
  assert.equal(result.pawnLikelyProfitable, false);
  assert.equal(result.onlineSafeNow, true);
  assert.equal(result.exitType, "online-resale");
  assert.equal(result.recommendationState, "retail-safe");
  assert.equal(result.decisionVerdict, "YES");
  assert.ok(result.resaleBreakEvenBid > result.resaleMaxBid);
  assert.ok(result.profitAtCurrentBid > 0);
});

test("a popular non-metal item can use the online route without a metal estimate", () => {
  const model = loadModel();
  const item = baseItem();
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasMetalEstimate, false);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.onlineSafeNow, true);
  assert.equal(result.exitType, "online-resale");
  assert.equal(result.onlinePopularityKnown, true);
  assert.ok(result.onlinePopularityScore > 0);
  assert.ok(result.onlineSaleLikelihood > 0);
});

test("plated-metal wording rejects a stored solid-gold pawn estimate", () => {
  const model = loadModel();
  const item = baseItem({
    title: "6.4g 925 Sterling Rhodium Plate / 14K Rose Gold Plate CZ Ring",
    comparableSales: [],
    resaleMarket: null,
  });
  const result = model.assess(item);
  assert.equal(result.metalEvidenceTitleConflict, true);
  assert.equal(result.hasMetalEstimate, false);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.pawnCashEstimate, null);
  assert.equal(result.recommendationState, "no-evidence");
});

test("a matched specialty guide supplies retail price and yearly demand without becoming a pawn quote", () => {
  const model = loadModel();
  const now = new Date().toISOString();
  const item = baseItem({
    currentBid: 50,
    comparableSales: [],
    resaleMarket: null,
    specialtyMarket: {
      status: "available",
      channel: "PriceCharting current price guide",
      asOf: now,
      productId: "6910",
      productName: "Brand Model 123 Watch",
      matchScore: 96,
      conditionBasis: "loose",
      guideValue: 400,
      retailerBuyValue: 250,
      retailerSellValue: 420,
      annualSalesVolume: 1_840,
      sourceUrl: "https://www.pricecharting.com/search-products?q=brand+model+123",
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasSpecialtyEvidence, true);
  assert.equal(result.hasDirectRetailerBuy, true);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.pawnCashEstimate, null);
  assert.equal(result.rawMarketMedian, 400);
  assert.equal(result.resaleMedian, 340);
  assert.equal(result.specialtyAnnualSalesVolume, 1_840);
  assert.equal(result.specialtyRetailerBuyValue, 250);
  assert.equal(result.specialtyRetailSellValue, 420);
  assert.equal(result.retailDemandPass, true);
  assert.equal(result.onlinePopularityKnown, true);
  assert.ok(result.onlinePopularityScore > 0);
  assert.equal(result.exitType, "online-resale");
  assert.equal(result.recommendationState, "retail-safe");
  assert.match(result.retailChannel, /PriceCharting/);
});

test("an evidence-backed item above every ceiling remains rankable without becoming a YES", () => {
  const model = loadModel();
  const result = model.assess(baseItem({ currentBid: 2_000 }));
  assert.equal(result.recommendationState, "no-margin");
  assert.equal(result.decisionVerdict, "NO");
  assert.ok(result.maxBid > 0);
  assert.ok(result.bidHeadroom < 0);
  assert.ok(result.rankingScore > 0);
  assert.ok(result.rankingScore < 50);
});

test("matched used offers provide raw average and median without inventing sell-through", () => {
  const model = loadModel();
  const now = new Date().toISOString();
  const prices = [120, 140, 160, 180, 200];
  const item = baseItem({
    title: "Hoka Challenger ATR 5 Running Shoes Size 8",
    category: "Footwear & Sneakers",
    resaleVertical: "Footwear & Sneakers",
    currentBid: 25,
    comparableSales: [],
    resaleMarket: null,
    retailMarket: {
      status: "available",
      asOf: now,
      productInterest: { reviewCountMax: 1_200 },
      offers: prices.map((price, index) => ({
        id: `offer-${index}`,
        title: `Hoka Challenger ATR 5 Running Shoes Size 8 ${index}`,
        price,
        totalPrice: price,
        url: `https://merchant.example/offer-${index}`,
        condition: "used",
        source: index % 2 ? "Merchant A" : "Merchant B",
        matchScore: 95,
      })),
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.resaleEvidenceKind, "used-market");
  assert.equal(result.hasRetailUsedEvidence, true);
  assert.equal(result.rawMarketMedian, 160);
  assert.equal(result.rawMarketAverage, 160);
  assert.equal(result.resaleMedian, 112);
  assert.equal(result.productReviewCountMax, 1_200);
  assert.equal(result.productInterestKnown, true);
  assert.equal(result.onlinePopularityKnown, false);
  assert.equal(result.onlinePopularityScore, 0);
  assert.equal(result.retailDemandPass, false);
  assert.equal(result.recommendationState, "no-demand");
  assert.equal(result.decisionVerdict, "NO");
  assert.equal(result.resaleMaxBid, 0);
  assert.equal(result.profitAtCurrentBid, null);
});

test("new-retail offers remain a separately labeled and deeply discounted fallback", () => {
  const model = loadModel();
  const prices = [450, 470, 490, 510, 530];
  const item = baseItem({
    title: "Hoka Challenger ATR 5 Running Shoes Size 8",
    category: "Footwear & Sneakers",
    resaleVertical: "Footwear & Sneakers",
    currentBid: 40,
    comparableSales: [],
    resaleMarket: null,
    retailMarket: {
      status: "available",
      asOf: new Date().toISOString(),
      offers: prices.map((price, index) => ({
        id: `new-${index}`,
        title: `Hoka Challenger ATR 5 Running Shoes Size 8 ${index}`,
        price,
        totalPrice: price,
        url: `https://merchant.example/new-${index}`,
        condition: "new/unspecified",
        source: index % 2 ? "Merchant A" : "Merchant B",
        matchScore: 95,
      })),
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasRetailNewEvidence, true);
  assert.equal(result.resaleEvidenceKind, "retail-replacement");
  assert.equal(result.rawMarketMedian, 490);
  assert.equal(result.retailReplacementHaircut, 0.45);
  assert.equal(result.resaleMedian, 269.5);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.retailDemandPass, false);
  assert.equal(result.recommendationState, "no-demand");
  assert.equal(result.maxBid, 0);
  assert.match(result.resaleEvidenceType, /new-retail offers/);
  assert.match(result.safeCeilingBasis, /demand did not clear/);
});

test("three recent completed sales can establish price but still fail the popularity threshold", () => {
  const model = loadModel();
  const item = baseItem({ resaleMarket: null });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasComparableResaleEvidence, true);
  assert.equal(result.recentCompletedSalesCount, 3);
  assert.equal(result.completedSalesDemandScore, 50);
  assert.equal(result.retailDemandPass, false);
  assert.equal(result.recommendationState, "no-demand");
  assert.equal(result.maxBid, 0);
});

test("five recent completed sales pass retail demand and create a defensible ceiling", () => {
  const model = loadModel();
  const item = baseItem({
    resaleMarket: null,
    comparableSales: [
      comparable("sale-1", 780, "brand:model-123", 5),
      comparable("sale-2", 820, "brand:model-123", 4),
      comparable("sale-3", 860, "brand:model-123", 3),
      comparable("sale-4", 900, "brand:model-123", 2),
      comparable("sale-5", 940, "brand:model-123", 1),
    ],
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.recentCompletedSalesCount, 5);
  assert.ok(result.completedSalesDemandScore >= result.minimumRetailDemandScore);
  assert.equal(result.retailDemandPass, true);
  assert.equal(result.recommendationState, "retail-safe");
  assert.ok(result.resaleMaxBid > result.currentBid);
  assert.match(result.retailDemandEvidenceType, /5 exact-model completed sales/);
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
  assert.equal(result.rankingScore, 0);
  assert.equal(result.bidHeadroom, -result.currentBid);
});
