import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGsaMarketValuation,
  buildGsaMarketValuationSnapshot,
  canonicalVehicleFamily,
  classifyVehicle,
  validateGsaMarketValuationSnapshot,
} from "../lib/gsa-market-valuations.ts";

function subject(overrides = {}) {
  return {
    id: "gsa:ppms:9001",
    externalId: "9001",
    sourceUrl: "https://gsaauctions.gov/auctions/preview/9001",
    title: "2018 Ford F-250 XL",
    year: 2018,
    make: "Ford",
    modelLabel: "F250XL",
    mileage: 100_000,
    bodyType: "pickup",
    condition: "usable",
    operability: "runs-and-drives",
    damageFlags: [],
    issueFlags: [],
    ...overrides,
  };
}

function comp(id, overrides = {}) {
  return {
    id: `gsa-closed:${id}`,
    auctionId: String(id),
    lotId: String(Number(id) + 1000),
    sourceUrl: `https://gsaauctions.gov/auctions/preview/${id}`,
    title: "2017 Ford F-250",
    closedHighBidCents: 1_200_000,
    bidderCount: 8,
    endedAt: "2026-07-15T15:00:00.000Z",
    year: 2017,
    make: "FORD MOTOR CO",
    modelLabel: "F250",
    mileage: 110_000,
    bodyType: "pickup",
    condition: "usable",
    operability: "runs-and-drives",
    damageFlags: [],
    issueFlags: [],
    city: "Dallas",
    state: "TX",
    detailEnriched: true,
    ...overrides,
  };
}

const asOf = "2026-08-05T17:00:00.000Z";

test("canonicalizes common noisy model families and defensible vehicle classes", () => {
  assert.equal(canonicalVehicleFamily(subject()), "ford-f250");
  assert.equal(canonicalVehicleFamily(subject({
    make: "Dodge",
    modelLabel: "RAM 1500 CREW CAB 4X4",
    title: "2019 Dodge Ram",
  })), "ram-1500");
  assert.equal(classifyVehicle(subject()), "pickup-three-quarter-ton");
  assert.equal(classifyVehicle(subject({
    make: "Chevrolet",
    modelLabel: "Express",
    title: "2019 Chevrolet Express Passenger Van",
    bodyType: "van",
  })), "full-size-van");
});
test("produces weighted ranges from family/year/mileage comps without using the subject bid", () => {
  const comps = [
    comp(1001, { closedHighBidCents: 900_000, year: 2016, mileage: 140_000 }),
    comp(1002, { closedHighBidCents: 1_200_000, year: 2018, mileage: 100_000 }),
    comp(1003, { closedHighBidCents: 1_500_000, year: 2020, mileage: 70_000 }),
    comp(1004, { closedHighBidCents: 1_800_000, year: 2019, mileage: 80_000 }),
  ];
  const lowBid = buildGsaMarketValuation({ ...subject(), currentBid: 1 }, comps, asOf);
  const highBid = buildGsaMarketValuation({ ...subject(), currentBid: 99_000_000 }, comps, asOf);

  assert.deepEqual(lowBid, highBid);
  assert.equal(lowBid.status, "available");
  assert.equal(lowBid.matchBasis, "family-year-mileage");
  assert.ok(lowBid.lowCents > 0);
  assert.ok(lowBid.lowCents <= lowBid.medianCents);
  assert.ok(lowBid.medianCents <= lowBid.highCents);
  assert.equal(lowBid.sampleSize, 4);
  assert.match(lowBid.adjustmentDetail.notes[0], /bid is not an input/i);
  assert.doesNotMatch(JSON.stringify(lowBid), /currentBid|subjectBid/i);
});

test("excludes the subject auction and publishes the closest available mileage first", () => {
  const valuation = buildGsaMarketValuation(subject(), [
    comp(9001, { closedHighBidCents: 99_000_000, mileage: 100_000 }),
    ...Array.from({ length: 31 }, (_, index) =>
      comp(2_000 + index, { mileage: 150_000 + index * 1_000 })),
    // Its older year and poor condition would place it outside the top 30 by
    // overall score, but it is still the nearest available odometer match.
    comp(1002, { year: 2013, mileage: 104_000, condition: "scrap" }),
  ], asOf);

  assert.equal(valuation.status, "available");
  assert.equal(valuation.sampleSize, 30);
  assert.equal(valuation.comparables[0].auctionId, "1002");
  assert.equal(valuation.comparables[0].mileageDifference, 4_000);
  assert.ok(valuation.comparables[0].mileageCloseness > valuation.comparables[1].mileageCloseness);
  assert.equal(valuation.sampleIds.includes("gsa-closed:9001"), false);
  assert.ok(valuation.highCents < 99_000_000);
});

test("uses a visibly low-confidence same-class fallback rather than calling it an exact value", () => {
  const valuation = buildGsaMarketValuation(
    subject({
      id: "gsa:ppms:van",
      title: "2021 Ford Transit Cargo Van",
      year: 2021,
      make: "Ford",
      modelLabel: "Transit",
      mileage: 60_000,
      bodyType: "van",
    }),
    [comp(2001, {
      title: "2019 Chevrolet Express Cargo Van",
      year: 2019,
      make: "Chevrolet",
      modelLabel: "Express",
      mileage: 80_000,
      bodyType: "van",
    })],
    asOf,
  );

  assert.equal(valuation.status, "available");
  assert.equal(valuation.matchBasis, "body-class");
  assert.ok(valuation.confidence <= 0.45);
  assert.match(valuation.matchLabel, /Same vehicle class only/);
  assert.match(valuation.provenanceNote, /not an exact-model/i);
});

test("builds and validates a complete snapshot and rejects subject-bid leakage", () => {
  const corpus = {
    from: "2026-05-07T00:00:00.000",
    to: "2026-08-05T23:59:59.999",
    catalogRows: 4,
    closedRows: 4,
    usableClosedHighBids: 4,
    excludedTerminated: 0,
    excludedNoBid: 0,
    detailRequested: 4,
    detailSucceeded: 4,
    detailFailed: 0,
  };
  const snapshot = buildGsaMarketValuationSnapshot(
    [subject()],
    [comp(1), comp(2), comp(3)],
    { generatedAt: asOf, corpus },
  );
  assert.equal(validateGsaMarketValuationSnapshot(snapshot), snapshot);
  assert.equal(snapshot.coverage.valuedCount, 1);
  assert.throws(
    () => validateGsaMarketValuationSnapshot({ ...snapshot, currentBidCents: 5 }),
    /forbidden/i,
  );
});
