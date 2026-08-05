import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDeal,
  buildClosingForecast,
  calculateBreakEvenBid,
  calculateCostBreakdown,
  calculateSafeMaxBid,
} from "../lib/deal-model.ts";

const costs = {
  buyerPremiumRate: 0.1,
  purchaseTaxRate: 0.05,
  sellingFeeRate: 0.08,
  transportCents: 10_000,
  titleRegistrationCents: 20_000,
  inspectionCents: 30_000,
  repairsCents: 40_000,
  storageCents: 50_000,
  riskReserveCents: 60_000,
};

test("cost breakdown keeps purchase, acquisition, and exit costs explicit", () => {
  assert.deepEqual(calculateCostBreakdown(1_000_000, 1_500_000, costs), {
    purchaseBidCents: 1_000_000,
    buyerPremiumCents: 100_000,
    purchaseTaxCents: 55_000,
    transportCents: 10_000,
    titleRegistrationCents: 20_000,
    inspectionCents: 30_000,
    repairsCents: 40_000,
    storageCents: 50_000,
    sellingFeesCents: 120_000,
    riskReserveCents: 60_000,
    totalAcquisitionCents: 1_365_000,
    totalExitCostsCents: 120_000,
    totalAllInCents: 1_485_000,
  });
});

test("safe and break-even ceilings are exact after rounded fees", () => {
  const value = 2_000_000;
  const target = { minimumProfitCents: 250_000, targetMarginRate: 0.1 };
  const safeMax = calculateSafeMaxBid(value, costs, target);
  const breakEven = calculateBreakEvenBid(value, costs);

  const safeProfit =
    value - calculateCostBreakdown(safeMax, value, costs).totalAllInCents;
  const nextSafeProfit =
    value - calculateCostBreakdown(safeMax + 1, value, costs).totalAllInCents;
  const breakEvenProfit =
    value - calculateCostBreakdown(breakEven, value, costs).totalAllInCents;
  const nextBreakEvenProfit =
    value - calculateCostBreakdown(breakEven + 1, value, costs).totalAllInCents;

  assert.ok(safeProfit >= 250_000);
  assert.ok(nextSafeProfit < 250_000);
  assert.ok(breakEvenProfit >= 0);
  assert.ok(nextBreakEvenProfit < 0);
  assert.ok(safeMax < breakEven);
});

test("closing forecast uses only closed outcomes and de-duplicates evidence", () => {
  const forecast = buildClosingForecast({
    currentBidCents: 50_000,
    asOf: "2026-08-05T00:00:00.000Z",
    outcomes: [
      { id: "a", finalPriceCents: 100_000, matchScore: 0.95 },
      { id: "b", finalPriceCents: 120_000, matchScore: 0.9 },
      { id: "c", finalPriceCents: 140_000, matchScore: 0.8 },
      { id: "d", finalPriceCents: 160_000, matchScore: 0.7 },
      { id: "e", finalPriceCents: 180_000, matchScore: 0.6 },
      { id: "e", finalPriceCents: 180_000, matchScore: 0.6 },
    ],
  });

  assert.equal(forecast.status, "available");
  assert.equal(forecast.provenance, "historical-gsa");
  assert.equal(forecast.sampleSize, 5);
  assert.equal(forecast.exactModelCount, 2);
  assert.deepEqual(forecast.evidenceIds, ["a", "b", "c", "d", "e"]);
  assert.equal(forecast.lowCents, 116_000);
  assert.equal(forecast.expectedCents, 140_000);
  assert.equal(forecast.highCents, 164_000);
});

test("forecast remains insufficient until enough verified outcomes exist", () => {
  const forecast = buildClosingForecast({
    currentBidCents: 50_000,
    asOf: "2026-08-05T00:00:00.000Z",
    outcomes: [
      { id: "a", finalPriceCents: 100_000 },
      { id: "b", finalPriceCents: 110_000 },
    ],
  });

  assert.equal(forecast.status, "insufficient");
  assert.equal(forecast.expectedCents, null);
  assert.deepEqual(forecast.reasonCodes, ["INSUFFICIENT_CLOSED_GSA_COMPS"]);
});

test("reference-only valuation and forecast cannot become actionable", () => {
  const valuation = {
    status: "reference-only",
    provider: "Internal scenario reference (not KBB)",
    providerKind: "mock-reference",
    valuationType: "composite",
    lowCents: 1_000_000,
    medianCents: 1_200_000,
    highCents: 1_400_000,
    asOf: "2026-08-05T00:00:00.000Z",
    confidence: 0.9,
    sampleSize: 0,
    provenanceNote: "Illustrative only; no licensed provider.",
  };
  const forecast = {
    status: "reference-only",
    lowCents: 120_000,
    expectedCents: 150_000,
    highCents: 180_000,
    asOf: "2026-08-05T00:00:00.000Z",
    modelVersion: "scenario-reference-v1",
    method: "Illustrative scenario",
    confidence: 0.9,
    sampleSize: 0,
    exactModelCount: 0,
    curveCount: 0,
    evidenceIds: [],
    provenance: "mock-reference",
    reasonCodes: ["MOCK_REFERENCE_NOT_MODEL"],
  };
  const assessment = assessDeal({
    currentBidCents: 100_000,
    valuation,
    forecast,
    costs: {
      buyerPremiumRate: 0,
      purchaseTaxRate: 0,
      sellingFeeRate: 0,
      transportCents: 0,
      titleRegistrationCents: 0,
      inspectionCents: 0,
      repairsCents: 0,
      storageCents: 0,
      riskReserveCents: 0,
    },
    target: { minimumProfitCents: 100_000, targetMarginRate: 0.1 },
    calculatedAt: "2026-08-05T00:00:00.000Z",
  });

  assert.notEqual(assessment.status, "actionable");
  assert.ok(assessment.reasonCodes.includes("REFERENCE_ONLY_VALUATION"));
  assert.ok(assessment.reasonCodes.includes("REFERENCE_ONLY_FORECAST"));
});

test("provider valuation plus historical forecast can be actionable", () => {
  const assessment = assessDeal({
    currentBidCents: 100_000,
    valuation: {
      status: "provider",
      provider: "Licensed provider example",
      providerKind: "licensed-provider",
      valuationType: "trade-in",
      lowCents: 1_000_000,
      medianCents: 1_200_000,
      highCents: 1_400_000,
      asOf: "2026-08-05T00:00:00.000Z",
      confidence: 0.9,
      sampleSize: 20,
      provenanceNote: "Provider-supplied test fixture.",
    },
    forecast: {
      status: "available",
      lowCents: 120_000,
      expectedCents: 150_000,
      highCents: 180_000,
      asOf: "2026-08-05T00:00:00.000Z",
      modelVersion: "test-v1",
      method: "Verified test outcomes",
      confidence: 0.9,
      sampleSize: 20,
      exactModelCount: 10,
      curveCount: 10,
      evidenceIds: ["comp-1"],
      provenance: "historical-gsa",
      reasonCodes: [],
    },
    costs: {
      buyerPremiumRate: 0,
      purchaseTaxRate: 0,
      sellingFeeRate: 0,
      transportCents: 0,
      titleRegistrationCents: 0,
      inspectionCents: 0,
      repairsCents: 0,
      storageCents: 0,
      riskReserveCents: 0,
    },
    target: { minimumProfitCents: 100_000, targetMarginRate: 0.1 },
    calculatedAt: "2026-08-05T00:00:00.000Z",
  });

  assert.equal(assessment.status, "actionable");
  assert.equal(assessment.safeMaxBidCents, 900_000);
  assert.equal(assessment.breakEvenBidCents, 1_000_000);
});
