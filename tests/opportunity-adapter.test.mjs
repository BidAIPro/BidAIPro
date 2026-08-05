import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryToOpportunity,
  mergeEnrichedSeeds,
} from "../lib/opportunity-adapter.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

const observedAt = "2026-08-05T04:00:00.000Z";

function discovery(overrides = {}) {
  return {
    id: "gsa:3-1-qsc-i-26-506:007",
    source: "gsa-auctions",
    saleNumber: "3-1-QSC-I-26-506",
    lotNumber: "007",
    lotSequence: "007",
    title: "2021 Ford Transit",
    description: "VIN NM0GE9E26M1495395, 11,081 miles, used condition.",
    status: "active",
    startsAt: "2026-07-29T00:00:00.000Z",
    endsAt: "2026-08-05T00:00:00.000Z",
    currentBid: 9186,
    bidderCount: 3,
    bidIncrement: 62,
    reserve: null,
    inactivityMinutes: 10,
    url: "https://www.gsaauctions.gov/auctions/preview/372498",
    imageUrl: "https://example.com/signed.jpg",
    images: ["https://example.com/signed.jpg"],
    vin: "NM0GE9E26M1495395",
    mileage: 11081,
    bodyType: "minivan",
    year: 2021,
    make: "Ford",
    modelLabel: "Transit",
    location: { addressLines: [], city: "Fort Worth", state: "TX", postalCode: "76102" },
    saleLocation: { addressLines: [], city: null, state: null, postalCode: null },
    agency: { code: null, name: null, bureauCode: null, bureauName: null },
    evidence: { title: true, vin: true, mileage: true, bodyType: true, matched: ["vehicle-title", "vin"] },
    ...overrides,
  };
}

test("official discovery stays visible without fabricating value or a safe ceiling", () => {
  const opportunity = discoveryToOpportunity(discovery(), observedAt);
  assert.equal(opportunity.externalId, "372498");
  assert.equal(opportunity.currentBidCents, 918600);
  assert.equal(opportunity.vehicle.vin, "NM0GE9E26M1495395");
  assert.equal(opportunity.imageUrl, "");
  assert.equal(opportunity.valuation.status, "unavailable");
  assert.equal(opportunity.forecast.status, "insufficient");
  assert.equal(opportunity.assessment.status, "insufficient");
  assert.equal(opportunity.assessment.safeMaxBidCents, null);
  assert.equal(opportunity.assessment.score, 0);
});

test("an enriched record replaces the discovery shell while current auction facts stay fresh", () => {
  const seed = SEED_AUCTIONS[0];
  const live = discoveryToOpportunity(
    discovery({
      id: "gsa:seed:001",
      url: seed.sourceUrl,
      currentBid: 4321,
      bidderCount: 9,
      endsAt: "2026-08-08T00:00:00.000Z",
    }),
    observedAt,
  );
  const [merged] = mergeEnrichedSeeds([live], [seed]);
  assert.equal(merged.id, seed.id);
  assert.equal(merged.valuation.status, "reference-only");
  assert.equal(merged.currentBidCents, 432100);
  assert.equal(merged.bidCount, 9);
  assert.equal(merged.lastCheckedAt, observedAt);
});

test("healthy official discovery never appends unmatched reference snapshots", () => {
  const live = discoveryToOpportunity(discovery(), observedAt);
  const merged = mergeEnrichedSeeds([live], SEED_AUCTIONS);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].externalId, "372498");
});
