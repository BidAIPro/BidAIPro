import assert from "node:assert/strict";
import test from "node:test";

import { buildReferenceClosingForecast } from "../lib/closing-forecast.ts";

const asOf = "2026-08-05T12:00:00.000Z";

function valuation(overrides = {}) {
  return {
    status: "reference-only",
    lowCents: 1_000_000,
    medianCents: 1_200_000,
    highCents: 1_500_000,
    confidence: 0.7,
    asOf,
    // This must never be copied into the forecast outcome count.
    sampleSize: 30,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    currentBidCents: 400_000,
    bidderCount: 3,
    endsAt: "2026-08-07T12:00:00.000Z",
    asOf,
    valuation: valuation(),
    ...overrides,
  };
}

test("numeric market anchors create a low-confidence reference without inventing close comps", () => {
  const forecast = buildReferenceClosingForecast(input());

  assert.equal(forecast.status, "reference-only");
  assert.equal(forecast.provenance, "market-reference-heuristic");
  assert.equal(forecast.sampleSize, 0);
  assert.equal(forecast.curveCount, 0);
  assert.equal(forecast.subjectObservationCount, 0);
  assert.deepEqual(forecast.evidenceIds, []);
  assert.ok(forecast.confidence > 0 && forecast.confidence <= 0.35);
  assert.ok(forecast.reasonCodes.includes("MARKET_VALUE_ANCHOR_USED"));
  assert.ok(forecast.reasonCodes.includes("HEURISTIC_TIME_TO_CLOSE"));
  assert.ok(forecast.lowCents >= 400_000);
  assert.ok(forecast.lowCents <= forecast.expectedCents);
  assert.ok(forecast.expectedCents <= forecast.highCents);
});

test("only distinct defensible terminal outcomes count as forecast evidence", () => {
  const forecast = buildReferenceClosingForecast(input({
    terminalOutcomes: [
      { id: "close-a", adjustedCloseCents: 900_000, matchScore: 0.95, exactModel: true },
      { id: "close-b", adjustedCloseCents: 1_100_000, matchScore: 0.8 },
      { id: "close-b", adjustedCloseCents: 1_150_000, matchScore: 0.8 },
      { id: "too-distant", adjustedCloseCents: 8_000_000, matchScore: 0.2 },
      { id: "invalid", adjustedCloseCents: -1, matchScore: 1 },
    ],
  }));

  assert.equal(forecast.sampleSize, 2);
  assert.equal(forecast.exactModelCount, 1);
  assert.equal(forecast.curveCount, 0);
  assert.deepEqual(forecast.evidenceIds, ["close-a", "close-b"]);
  assert.deepEqual(forecast.outcomeAnchors.map((outcome) => outcome.id), ["close-a", "close-b"]);
  assert.ok(forecast.reasonCodes.includes("TERMINAL_HIGH_BID_OUTCOMES_USED"));
  assert.ok(forecast.highCents < 2_000_000);
});

test("explicit terminal outcomes can anchor a reference when valuation is unavailable", () => {
  const forecast = buildReferenceClosingForecast(input({
    valuation: valuation({
      status: "unavailable",
      lowCents: null,
      medianCents: null,
      highCents: null,
      confidence: 0,
    }),
    terminalOutcomes: [
      { id: "a", adjustedCloseCents: 800_000, matchScore: 0.9 },
      { id: "b", adjustedCloseCents: 1_000_000, matchScore: 0.8 },
      { id: "c", adjustedCloseCents: 1_200_000, matchScore: 0.75 },
    ],
  }));

  assert.equal(forecast.status, "reference-only");
  assert.equal(forecast.sampleSize, 3);
  assert.ok(!forecast.reasonCodes.includes("MARKET_VALUE_ANCHOR_USED"));
  assert.ok(forecast.expectedCents >= forecast.currentBidAtForecastCents);
});

test("the same evidence converges toward the current bid as scheduled close approaches", () => {
  const early = buildReferenceClosingForecast(input({
    endsAt: "2026-08-07T12:00:00.000Z",
  }));
  const late = buildReferenceClosingForecast(input({
    endsAt: "2026-08-05T12:02:00.000Z",
  }));
  const atClose = buildReferenceClosingForecast(input({
    endsAt: asOf,
  }));

  assert.ok(early.expectedCents > late.expectedCents);
  assert.ok(late.expectedCents > 400_000);
  assert.equal(atClose.lowCents, 400_000);
  assert.equal(atClose.expectedCents, 400_000);
  assert.equal(atClose.highCents, 400_000);
  assert.equal(atClose.horizonSeconds, 0);
});

test("raising the current bid cannot lower any projected-close point", () => {
  const lowerBid = buildReferenceClosingForecast(input({ currentBidCents: 300_000 }));
  const higherBid = buildReferenceClosingForecast(input({ currentBidCents: 700_000 }));

  assert.ok(higherBid.lowCents >= lowerBid.lowCents);
  assert.ok(higherBid.expectedCents >= lowerBid.expectedCents);
  assert.ok(higherBid.highCents >= lowerBid.highCents);
  assert.ok(higherBid.lowCents >= 700_000);
});

test("observed price movement and bidders provide only a bounded engagement adjustment", () => {
  const quiet = buildReferenceClosingForecast(input({
    bidderCount: 0,
    subjectBidObservations: [],
  }));
  const active = buildReferenceClosingForecast(input({
    bidderCount: 10,
    subjectBidObservations: [
      { observedAt: "2026-08-05T10:00:00.000Z", currentBidCents: 200_000, bidderCount: 2 },
      { observedAt: "2026-08-05T11:00:00.000Z", currentBidCents: 300_000, bidderCount: 5 },
      { observedAt: asOf, currentBidCents: 400_000, bidderCount: 10 },
    ],
  }));

  assert.ok(active.expectedCents >= quiet.expectedCents);
  assert.ok(active.highCents <= 1_500_000);
  assert.equal(active.subjectObservationCount, 3);
  assert.ok(active.reasonCodes.includes("SUBJECT_BID_TREND_USED"));
  assert.ok(active.reasonCodes.includes("BIDDER_ENGAGEMENT_USED"));
});

test("a bid above every anchor is floored at the bid and capped to a narrow uncertainty band", () => {
  const forecast = buildReferenceClosingForecast(input({
    currentBidCents: 2_000_000,
  }));

  assert.equal(forecast.lowCents, 2_000_000);
  assert.equal(forecast.expectedCents, 2_000_000);
  assert.ok(forecast.highCents >= 2_000_000);
  assert.ok(forecast.highCents <= 2_100_000);
  assert.ok(forecast.reasonCodes.includes("CURRENT_BID_ABOVE_REFERENCE_RANGE"));
  assert.ok(forecast.confidence < 0.2);
});

test("a missing public bid gets a market-only projection without becoming a fake bid", () => {
  const noBid = buildReferenceClosingForecast(input({ currentBidCents: null }));

  assert.equal(noBid.status, "reference-only");
  assert.equal(noBid.currentBidAtForecastCents, null);
  assert.ok(noBid.lowCents > 0);
  assert.ok(noBid.expectedCents >= noBid.lowCents);
  assert.ok(noBid.highCents >= noBid.expectedCents);
  assert.ok(noBid.confidence <= 0.28);
  assert.ok(noBid.reasonCodes.includes("CURRENT_BID_UNAVAILABLE"));
  assert.ok(noBid.reasonCodes.includes("MARKET_ONLY_BEFORE_PUBLIC_BID"));
});

test("missing defensible anchors remains explicitly insufficient", () => {
  const noEvidence = buildReferenceClosingForecast(input({
    valuation: valuation({ confidence: 0.05 }),
  }));

  assert.equal(noEvidence.status, "insufficient");
  assert.deepEqual(noEvidence.reasonCodes, ["NO_DEFENSIBLE_CLOSE_REFERENCE"]);
});
