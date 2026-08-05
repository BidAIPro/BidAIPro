import assert from "node:assert/strict";
import test from "node:test";
import {
  applyValuationToOpportunity,
  discoveryToOpportunity,
} from "../lib/opportunity-adapter.ts";

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
    images: [
      "https://example.com/signed.jpg",
      "https://example.com/side.jpg",
      "https://example.com/signed.jpg",
    ],
    vin: "NM0GE9E26M1495395",
    mileage: 11081,
    odometerStatus: "reported-not-verified",
    bodyType: "minivan",
    year: 2021,
    make: "Ford",
    modelLabel: "Transit",
    transmission: "Automatic",
    fuelType: "Gasoline",
    cylinders: 4,
    color: "White",
    openRecall: false,
    conditionCode: "U",
    condition: "usable",
    operability: "runs-and-drives",
    damageFlags: ["paint-damage"],
    issueFlags: [],
    conditionNotes: ["Scratches on the passenger-side door."],
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
  assert.equal(opportunity.bidderCount, 3);
  assert.equal(opportunity.vehicle.vin, "NM0GE9E26M1495395");
  assert.equal(opportunity.imageUrl, "https://example.com/signed.jpg");
  assert.deepEqual(opportunity.images, [
    "https://example.com/signed.jpg",
    "https://example.com/side.jpg",
  ]);
  assert.equal(opportunity.vehicle.mileage, 11081);
  assert.equal(opportunity.vehicle.odometerStatus, "reported-not-verified");
  assert.equal(opportunity.vehicle.condition, "good");
  assert.equal(opportunity.vehicle.operability, "runs-and-drives");
  assert.deepEqual(opportunity.vehicle.riskFlags, [
    "Paint Damage",
    "Scratches on the passenger-side door.",
  ]);
  assert.equal(opportunity.valuation.status, "unavailable");
  assert.equal(opportunity.forecast.status, "insufficient");
  assert.equal(opportunity.assessment.status, "insufficient");
  assert.equal(opportunity.assessment.safeMaxBidCents, null);
  assert.equal(opportunity.assessment.score, 0);
  assert.equal(opportunity.endsAt, "2026-08-05T00:00:00.000Z");
});

test("missing source facts remain unavailable instead of becoming zero-valued deals", () => {
  const opportunity = discoveryToOpportunity(
    discovery({ currentBid: null, bidderCount: null, endsAt: null }),
    observedAt,
  );
  assert.equal(opportunity.currentBidCents, null);
  assert.equal(opportunity.bidderCount, null);
  assert.equal(opportunity.endsAt, null);
  assert.equal(opportunity.assessment.status, "insufficient");
  assert.equal(opportunity.assessment.safeMaxBidCents, null);
});

test("attaching a numeric valuation immediately creates a reference projected close", () => {
  const opportunity = discoveryToOpportunity(
    discovery({ endsAt: "2026-08-07T04:00:00.000Z" }),
    observedAt,
  );
  const valued = applyValuationToOpportunity(opportunity, {
    status: "reference-only",
    provider: "Official similar sale outcomes",
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: 1_500_000,
    medianCents: 1_800_000,
    highCents: 2_100_000,
    asOf: observedAt,
    confidence: 0.7,
    sampleSize: 12,
    provenanceNote: "Test-only valuation evidence.",
  });

  assert.equal(valued.forecast.status, "reference-only");
  assert.equal(valued.forecast.sampleSize, 0);
  assert.ok(valued.forecast.expectedCents >= valued.currentBidCents);
  assert.equal(valued.assessment.expectedCloseCents, valued.forecast.expectedCents);
});
