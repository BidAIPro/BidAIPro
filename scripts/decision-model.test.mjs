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

test("ended and time-expired auctions are excluded from active opportunity views", () => {
  const model = loadModel();
  const now = Date.parse("2026-08-03T02:00:00.000Z");

  assert.equal(model.isActiveOpportunity({
    status: "active",
    endsAt: "2026-08-03T02:00:01.000Z",
  }, now), true);
  assert.equal(model.isActiveOpportunity({
    status: "active",
    endsAt: "2026-08-03T01:59:59.000Z",
  }, now), false);
  assert.equal(model.isActiveOpportunity({
    status: "ended",
    endsAt: "2026-08-03T03:00:00.000Z",
  }, now), false);
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
  assert.equal(result.recommendationState, "mixed-material");
  assert.equal(result.maxBid, 0);
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
  assert.equal(result.decisionApproved, false);
  assert.equal(result.retailValueDecisionState, "supports-profit");
  assert.equal(result.retailValueLead, true);
  assert.ok(result.bestPriceConservativeProfitAtCurrentBid > 0);
  assert.ok(result.bestPriceProvisionalMaxBid > result.currentBid);
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
  assert.equal(result.decisionApproved, false);
  assert.equal(result.retailValueDecisionState, "supports-profit");
  assert.ok(result.bestPriceConservativeProfitAtCurrentBid > 0);
  assert.ok(result.bestPriceProvisionalMaxBid > result.currentBid);
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
  assert.equal(result.hasPriceEstimate, false);
  assert.equal(result.bestPriceKind, "unpriced");
  assert.equal(result.bestPriceMedian, null);
  assert.equal(result.bestPriceProfitAtCurrentBid, null);
  assert.equal(result.bestPriceConservativeProfitAtCurrentBid, null);
  assert.equal(result.retailValueDecisionState, "unpriced");
  assert.equal(result.retailValueLead, false);
  assert.equal(result.bestPriceBreakEvenBid, 0);
  assert.equal(result.bestPriceLabel, "No independent market price");
  assert.equal(result.pricingStatus, "queued");
});

test("an unsuccessful external lookup stays unpriced and reports the last check", () => {
  const model = loadModel();
  const checkedAt = new Date().toISOString();
  const item = baseItem({
    comparableSales: [],
    resaleMarket: null,
    askingMarket: {
      status: "insufficient",
      asOf: checkedAt,
      query: "example identifiable item",
      sampleSize: 2,
      reason: "Fewer than five matched used offers",
      listings: [],
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasPriceEstimate, false);
  assert.equal(result.bestPriceMedian, null);
  assert.equal(result.pricingStatus, "no-match");
  assert.equal(result.pricingAttempted, true);
  assert.equal(result.pricingLastCheckedAt, checkedAt);
});

test("public web research produces a provisional price and profit estimate without becoming a safe ceiling", () => {
  const model = loadModel();
  const item = baseItem({
    title: "White satin corset bubble hem mini dress NWT",
    category: "Clothing",
    currentBid: 10,
    comparableSales: [],
    resaleMarket: null,
    researchMarket: {
      status: "reference-only",
      researchedAt: new Date().toISOString(),
      priceSummary: {
        sampleSize: 5,
        soldSampleSize: 2,
        askingSampleSize: 3,
        low: 14,
        median: 44,
        average: 37.6,
        high: 60,
        decisionEligible: false,
      },
      results: [
        { title: "Sold analog one", url: "https://example.com/1", source: "Market A", price: 25, listingState: "sold" },
        { title: "Sold analog two", url: "https://example.com/2", source: "Market A", price: 60, listingState: "sold" },
        { title: "Active analog", url: "https://example.com/3", source: "Market B", price: 45, listingState: "asking" },
        { title: "Ended analog", url: "https://example.com/4", source: "Market C", price: 44, listingState: "ended-by-seller" },
        { title: "Retail analog", url: "https://example.com/5", source: "Market D", price: 14, listingState: "active-retail" },
      ],
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasResearchEstimate, true);
  assert.equal(result.researchRawMedian, 44);
  assert.equal(result.researchRawAverage, 37.6);
  assert.equal(result.researchSoldCount, 2);
  assert.equal(result.researchAskingCount, 3);
  assert.equal(result.researchPlanningFactor, 0.55);
  assert.equal(result.hasResaleEvidence, false);
  assert.equal(result.hasPriceEstimate, true);
  assert.equal(result.bestPriceKind, "web-research");
  assert.equal(result.bestPriceMedian, 44);
  assert.equal(result.decisionApproved, false);
  assert.equal(result.maxBid, 0);
  assert.ok(Number.isFinite(result.researchProfitAtCurrentBid));
  assert.ok(Number.isFinite(result.bestPriceConservativeProfitAtCurrentBid));
  assert.match(result.retailValueDecisionLabel, /RETAIL VALUE|PROFIT TARGET|RESERVE|BELOW COST/);
  assert.equal(result.researchProvisionalMaxBid, 0);
});

test("an exact free retail-catalog match produces a visible price but never a safe used-resale bid", () => {
  const model = loadModel();
  const checkedAt = new Date().toISOString();
  const item = baseItem({
    currentBid: 40,
    comparableSales: [],
    resaleMarket: null,
    freeRetailMarket: {
      status: "reference-only",
      provider: "upcitemdb",
      asOf: checkedAt,
      evidenceType: "current-retail-offers",
      catalog: {
        matchTier: "exact-model",
        matchScore: 96,
        evidenceType: "current-retail-offers",
        sampleSize: 1,
        sourceCount: 1,
        priceLow: 529,
        priceMedian: 529,
        priceAverage: 529,
        priceHigh: 529,
        planningReservePercent: 65,
        sourceUrl: "https://www.upcitemdb.com/upc/887276353340",
      },
      offers: [{
        id: "upc-offer-1",
        title: "Brand Model 123 Watch",
        price: 529,
        totalPrice: 529,
        url: "https://merchant.example/model-123",
        condition: "new",
        source: "Actual Retailer",
        matchScore: 96,
      }],
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasFreeRetailReference, true);
  assert.equal(result.hasPriceEstimate, true);
  assert.equal(result.bestPriceKind, "retail-catalog-reference");
  assert.equal(result.bestPriceMedian, 529);
  assert.equal(result.bestPricePlanningFactor, 0.35);
  assert.equal(result.bestPriceLabel, "Matched retail catalog reference");
  assert.equal(result.hasResaleEvidence, false);
  assert.equal(result.decisionApproved, false);
  assert.equal(result.maxBid, 0);
  assert.equal(result.recommendationState, "no-evidence");
  assert.equal(result.pricingLastCheckedAt, checkedAt);
  assert.ok(Number.isFinite(result.bestPriceProfitAtCurrentBid));
});

test("stale catalog merchant offers never become a current retail value", () => {
  const model = loadModel();
  const checkedAt = new Date().toISOString();
  const item = baseItem({
    comparableSales: [],
    resaleMarket: null,
    freeRetailMarket: {
      status: "reference-only",
      provider: "upcitemdb",
      asOf: checkedAt,
      catalog: {
        matchTier: "exact-model",
        matchScore: 96,
        evidenceType: "retail-catalog-identity-only",
        sampleSize: 0,
        sourceCount: 0,
        priceLow: null,
        priceMedian: null,
        priceAverage: null,
        priceHigh: null,
        sourceUrl: "https://www.upcitemdb.com/upc/818279027259",
      },
      offers: [{
        id: "old-offer",
        title: "Brand Model 123 Watch",
        totalPrice: 999,
        url: "https://merchant.example/old",
        source: "Old merchant",
        matchScore: 96,
        isCurrent: false,
        freshness: "stale",
      }],
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasFreeRetailReference, false);
  assert.equal(result.hasPriceEstimate, false);
  assert.equal(result.bestPriceKind, "unpriced");
  assert.equal(result.bestPriceMedian, null);
  assert.equal(result.maxBid, 0);
});

test("an authorized partner retail catalog outranks a weaker keyless reference", () => {
  const model = loadModel();
  const checkedAt = new Date().toISOString();
  const item = baseItem({
    currentBid: 50,
    comparableSales: [],
    resaleMarket: null,
    partnerRetailMarket: {
      status: "available",
      provider: "rakuten",
      asOf: checkedAt,
      catalog: {
        matchTier: "exact-model",
        matchScore: 97,
        evidenceType: "current-retail-merchant-offers",
        sampleSize: 3,
        sourceCount: 3,
        priceLow: 480,
        priceMedian: 500,
        priceAverage: 500,
        priceHigh: 520,
        planningReservePercent: 55,
        sourceUrl: "https://retailer.example/model-123",
      },
      offers: [{
        id: "partner-offer",
        title: "Brand Model 123 Watch",
        totalPrice: 500,
        url: "https://retailer.example/model-123",
        source: "Partner retailer",
        matchScore: 97,
        isCurrent: true,
        freshness: "current",
      }],
    },
    freeRetailMarket: {
      status: "reference-only",
      provider: "upcitemdb",
      asOf: checkedAt,
      catalog: {
        matchTier: "exact-model",
        matchScore: 95,
        evidenceType: "current-retail-merchant-offers",
        sampleSize: 1,
        sourceCount: 1,
        priceLow: 300,
        priceMedian: 300,
        priceAverage: 300,
        priceHigh: 300,
        sourceUrl: "https://www.upcitemdb.com/upc/123456789012",
      },
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasFreeRetailReference, true);
  assert.equal(result.freeRetailProvider, "rakuten");
  assert.equal(result.bestPriceMedian, 500);
  assert.equal(result.bestPriceSampleSize, 3);
  assert.equal(result.hasResaleEvidence, false);
  assert.equal(result.decisionApproved, false);
  assert.equal(result.maxBid, 0);
});

test("a real Google Shopping analog produces a conservative price without becoming an exact resale comp", () => {
  const model = loadModel();
  const offers = Array.from({ length: 6 }, (_, index) => ({
    id: `analog-${index}`,
    title: `Similar model market offer ${index}`,
    url: `https://merchant.example/analog-${index}`,
    source: index % 2 ? "Merchant A" : "Merchant B",
    condition: "used",
    matchScore: 45 + index,
    price: 100 + index * 10,
    totalPrice: 100 + index * 10,
  }));
  const item = baseItem({
    comparableSales: [],
    resaleMarket: null,
    retailMarket: {
      status: "available",
      channel: "Google Shopping via SearchAPI",
      provider: "searchapi",
      asOf: new Date().toISOString(),
      offers,
      analog: {
        sampleSize: 6,
        sourceCount: 2,
        priceLow: 110,
        priceMedian: 125,
        priceAverage: 125,
        priceHigh: 140,
        conditionBasis: "used/refurbished",
        planningReservePercent: 55,
      },
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasMarketAnalogEstimate, true);
  assert.equal(result.hasResaleEvidence, false);
  assert.equal(result.bestPriceKind, "market-analog");
  assert.equal(result.bestPriceMedian, 125);
  assert.equal(result.bestPriceSampleSize, 6);
  assert.ok(Math.abs(result.bestPricePlanningFactor - 0.45) < 1e-9);
  assert.equal(result.bestPriceLabel, "Broad-market analog estimate");
  assert.equal(result.maxBid, 0);
  assert.ok(Number.isFinite(result.bestPriceProfitAtCurrentBid));
  assert.ok(Number.isFinite(result.bestPriceConservativeProfitAtCurrentBid));
  assert.equal(result.decisionApproved, false);
});

test("category browsing groups detailed source paths into populated parent categories", () => {
  const model = loadModel();
  assert.equal(model.categoryRootFor("Clothing > Shoes > Men's"), "Clothing");
  assert.equal(model.categoryRootFor("Computers & Electronics > Audio"), "Computers & Electronics");
  assert.equal(model.categoryRootFor(""), "Unclassified");
});

test("published snapshot refresh parses data without evaluating executable script", () => {
  const model = loadModel();
  const parsed = model.parsePublishedSnapshotScript(`window.BIDAI_LIVE_SNAPSHOTS = ${JSON.stringify({
    observedAt: "2026-08-02T18:00:00.000Z",
    lastCheckedAt: "2026-08-02T18:05:00.000Z",
    sourceMode: "test-refresh",
    items: [{ id: "real-1", title: "Real listing" }, { id: "", title: "Rejected" }],
  })};`);
  assert.equal(parsed.sourceMode, "test-refresh");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, "real-1");
});

test("near-match completed sales form a separately discounted analog valuation tier", () => {
  const model = loadModel();
  const soldAt = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const item = baseItem({
    title: "Brand Model 123 Camera Body",
    category: "Cameras & Camcorders",
    resaleMarket: null,
    comparableSales: Array.from({ length: 8 }, (_, index) => ({
      id: `analog-${index}`,
      externalId: `analog-${index}`,
      title: `Brand Model 124 Camera Body ${index}`,
      soldPrice: 500 + index * 20,
      soldAt: soldAt(index + 1),
      endedAt: soldAt(index + 1),
      outcomeObservedAt: soldAt(index + 1),
      modelKey: "brand:model-124",
      matchType: "analog",
      matchScore: 82,
      source: "Licensed completed-sales test feed",
    })),
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.hasComparableResaleEvidence, false);
  assert.equal(result.hasAnalogResaleEvidence, true);
  assert.equal(result.resaleEvidenceKind, "analog-completed");
  assert.equal(result.analogCompHaircut, 0.4);
  assert.equal(result.resaleMedian, result.rawMarketMedian * 0.6);
  assert.match(result.resaleEvidenceType, /near-match completed sales/);
});

test("mixed-metal precious-metal listings are hard rejected with a zero ceiling", () => {
  const model = loadModel();
  const item = baseItem({ title: "14K Gold and Palladium Ring 10g", category: "Jewelry & Gemstones" });
  const result = model.assess(item);
  assert.equal(result.strictMetalPurityReject, true);
  assert.match(result.metalPurityRejectionReason, /palladium|gold and silver/i);
  assert.equal(result.recommendationState, "mixed-material");
  assert.equal(result.decisionApproved, false);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.maxBid, 0);
});

test("single-metal gold listings remain eligible for conservative melt analysis", () => {
  const model = loadModel();
  const item = baseItem({ title: "14K Gold Band 10g", category: "Jewelry & Gemstones" });
  const result = model.assess(item);
  assert.equal(result.strictMetalPurityReject, false);
  assert.equal(result.hasPawnEstimate, true);
});

test("fresh eBay active-listing depth produces a labeled market-presence score without passing resale demand", () => {
  const model = loadModel();
  const item = baseItem({
    comparableSales: [],
    resaleMarket: null,
    askingMarket: {
      status: "insufficient",
      asOf: new Date().toISOString(),
      listings: [],
      marketPresence: {
        evidenceType: "active-listing-depth",
        asOf: new Date().toISOString(),
        searchResultCount: 243,
        matchedListingCount: 18,
        sellerCount: 9,
      },
    },
  });
  delete item.metalEstimate;
  const result = model.assess(item);
  assert.equal(result.marketPresenceKnown, true);
  assert.equal(result.popularityEvidenceLevel, "market-presence");
  assert.ok(result.popularityScore > 0);
  assert.match(result.popularityEvidenceType, /competing supply, not completed sales/i);
  assert.equal(result.hasRetailDemandEvidence, false);
  assert.equal(result.retailDemandPass, false);
  assert.equal(result.onlinePopularityKnown, false);
});

test("resale-value and popularity ranking modes sort highest-first with evidence quality visible", () => {
  const model = loadModel();
  const assessment = (overrides = {}) => ({
    hasPriceEstimate: false,
    bestPriceMedian: 0,
    bestPriceSampleSize: 0,
    popularityEvidenceRank: 0,
    popularityScore: 0,
    rankTier: 5,
    rankingScore: 0,
    decisionProfitAtCurrentBid: null,
    resalePopularityScore: 0,
    researchCoverageScore: 0,
    ...overrides,
  });
  const entries = [
    { item: { title: "Lower value", status: "active" }, assessment: assessment({ hasPriceEstimate: true, bestPriceMedian: 200, popularityEvidenceRank: 2, popularityScore: 90 }) },
    { item: { title: "Higher value", status: "active" }, assessment: assessment({ hasPriceEstimate: true, bestPriceMedian: 900, popularityEvidenceRank: 3, popularityScore: 55 }) },
    { item: { title: "Unknown value", status: "active" }, assessment: assessment({ popularityEvidenceRank: 4, popularityScore: 80 }) },
  ];
  const byResale = [...entries].sort((left, right) => model.compareOpportunityEntries(left, right, "resale"));
  assert.deepEqual(byResale.map((entry) => entry.item.title), ["Higher value", "Lower value", "Unknown value"]);
  const byPopularity = [...entries].sort((left, right) => model.compareOpportunityEntries(left, right, "popular"));
  assert.deepEqual(byPopularity.map((entry) => entry.item.title), ["Unknown value", "Higher value", "Lower value"]);
});

test("Top profit keeps every listing visible and ranks bid-safe decisions before retail-value outlooks", () => {
  const model = loadModel();
  const assessment = (overrides = {}) => ({
    decisionApproved: false,
    decisionProfitAtCurrentBid: null,
    bestPriceConservativeProfitAtCurrentBid: null,
    retailValueDecisionRank: 0,
    rankTier: 5,
    rankingScore: 0,
    resalePopularityScore: 0,
    researchCoverageScore: 0,
    hasPriceEstimate: false,
    hasPawnEstimate: false,
    pawnLikelyProfitable: false,
    retailLikelyProfitable: false,
    hours: 1,
    ...overrides,
  });
  const safe = { item: { title: "Bid-safe", status: "active" }, assessment: assessment({ decisionApproved: true, decisionProfitAtCurrentBid: 20, retailValueDecisionRank: 4, rankTier: 1 }) };
  const priceLead = { item: { title: "Retail value lead", status: "active" }, assessment: assessment({ hasPriceEstimate: true, bestPriceConservativeProfitAtCurrentBid: 100, retailValueDecisionRank: 4, rankTier: 2 }) };
  const pricedLoss = { item: { title: "Priced loss", status: "active" }, assessment: assessment({ hasPriceEstimate: true, bestPriceConservativeProfitAtCurrentBid: -20, retailValueDecisionRank: 1, rankTier: 4 }) };
  const unpriced = { item: { title: "Unpriced", status: "active" }, assessment: assessment() };

  for (const entry of [safe, priceLead, pricedLoss, unpriced]) {
    assert.equal(model.matchesQueueMode(entry.item, entry.assessment, "profit"), true);
  }
  const ranked = [unpriced, pricedLoss, priceLead, safe]
    .sort((left, right) => model.compareOpportunityEntries(left, right, "profit"));
  assert.deepEqual(ranked.map((entry) => entry.item.title), ["Bid-safe", "Retail value lead", "Priced loss", "Unpriced"]);
  assert.equal(model.matchesQueueMode(priceLead.item, priceLead.assessment, "thin"), true);
  assert.equal(model.matchesQueueMode(unpriced.item, unpriced.assessment, "research"), true);
});

test("a stale stored metal weight that disagrees with a leading-decimal title is rejected", () => {
  const model = loadModel();
  const item = baseItem({ title: "Charming 14K Yellow Gold Pendant .8g" });
  const result = model.assess(item);
  assert.equal(result.metalWeightMismatch, true);
  assert.equal(result.strictMetalPurityReject, true);
  assert.match(result.metalPurityRejectionReason, /10\.00 g.*0\.80 g/i);
  assert.equal(result.hasPawnEstimate, false);
  assert.equal(result.maxBid, 0);
});
