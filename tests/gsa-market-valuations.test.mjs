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
    vin: null,
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
  assert.equal(canonicalVehicleFamily(subject({
    title: "2021 Ford Transit Connect Cargo Van",
    modelLabel: "Transit Connect",
  })), "ford-transit-connect");
  assert.equal(canonicalVehicleFamily(subject({
    make: "Jeep",
    title: "2020 Jeep Grand Cherokee",
    modelLabel: "Grand Cherokee",
  })), "jeep-grand-cherokee");
  assert.equal(canonicalVehicleFamily(subject({
    make: "Chevrolet",
    title: "2017 Chevrolet K3500",
    modelLabel: "K3500",
  })), "chevrolet-silverado-3500");
  assert.equal(classifyVehicle(subject({
    make: "Chevrolet",
    title: "2017 Chevrolet K3500",
    modelLabel: "K3500",
    bodyType: null,
  })), "pickup-one-ton");
  assert.notEqual(
    canonicalVehicleFamily(subject({
      make: "Jeep",
      title: "2020 Jeep Grand Cherokee",
      modelLabel: "Grand Cherokee",
    })),
    canonicalVehicleFamily(subject({
      make: "Jeep",
      title: "2020 Jeep Cherokee",
      modelLabel: "Cherokee",
    })),
  );
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
    ...Array.from({ length: 20 }, (_, index) =>
      comp(2_000 + index, { mileage: 120_000 + index * 1_000 })),
    comp(1002, { year: 2017, mileage: 104_000 }),
  ], asOf);

  assert.equal(valuation.status, "available");
  assert.equal(valuation.sampleSize, 15);
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
    [
      comp(2001, {
        title: "2020 Chevrolet Express Cargo Van",
        year: 2020,
        make: "Chevrolet",
        modelLabel: "Express",
        mileage: 65_000,
        bodyType: "van",
      }),
      comp(2002, {
        title: "2021 Ford E-350 Cargo Van",
        year: 2021,
        make: "Ford",
        modelLabel: "E350",
        mileage: 70_000,
        bodyType: "van",
      }),
      comp(2003, {
        title: "2020 GMC Savana Cargo Van",
        year: 2020,
        make: "GMC",
        modelLabel: "Savana",
        mileage: 72_000,
        bodyType: "van",
      }),
    ],
    asOf,
  );

  assert.equal(valuation.status, "available");
  assert.equal(valuation.matchBasis, "body-class");
  assert.ok(valuation.confidence <= 0.25);
  assert.match(valuation.matchLabel, /Same vehicle class only/);
  assert.match(valuation.provenanceNote, /not an exact-model/i);
});

test("keeps one close newer-vehicle comp instead of widening to remote family rows", () => {
  const valuation = buildGsaMarketValuation(subject({
    id: "gsa:ppms:new-ram",
    externalId: "new-ram",
    title: "2023 Ram 2500",
    year: 2023,
    make: "Ram",
    modelLabel: "2500",
    mileage: 10_790,
  }), [
    comp(3001, {
      title: "2023 Ram 2500 Tradesman",
      year: 2023,
      make: "Ram",
      modelLabel: "2500",
      mileage: 22_595,
    }),
    ...Array.from({ length: 20 }, (_, index) => comp(3_100 + index, {
      title: "2015 Ram 2500",
      year: 2015,
      make: "Ram",
      modelLabel: "2500",
      mileage: 100_000 + index * 2_000,
    })),
  ], asOf);

  assert.equal(valuation.status, "available");
  assert.equal(valuation.matchBasis, "family-year-mileage");
  assert.equal(valuation.sampleSize, 1);
  assert.equal(valuation.comparables[0].auctionId, "3001");
  assert.ok(valuation.confidence <= 0.28);
});

test("rejects family rows with remote years, mileage, condition, or a conflicting class", () => {
  const remote = buildGsaMarketValuation(subject({
    id: "gsa:ppms:remote-ram",
    externalId: "remote-ram",
    title: "2023 Ram 2500",
    year: 2023,
    make: "Ram",
    modelLabel: "2500",
    mileage: 10_790,
  }), [
    comp(4001, {
      title: "2015 Ram 2500",
      year: 2015,
      make: "Ram",
      modelLabel: "2500",
      mileage: 120_000,
    }),
    comp(4002, {
      title: "2023 Ram 2500 Salvage",
      year: 2023,
      make: "Ram",
      modelLabel: "2500",
      mileage: 12_000,
      condition: "salvage",
    }),
  ], asOf);
  const transit = buildGsaMarketValuation(subject({
    id: "gsa:ppms:transit",
    externalId: "transit",
    title: "2021 Ford Transit Cargo Van",
    year: 2021,
    make: "Ford",
    modelLabel: "Transit",
    mileage: 11_081,
    bodyType: "van",
  }), [comp(4003, {
    title: "2021 Ford Transit Connect Cargo Van",
    year: 2021,
    make: "Ford",
    modelLabel: "Transit Connect",
    mileage: 12_500,
    bodyType: "van",
  })], asOf);

  assert.equal(remote.status, "unavailable");
  assert.equal(transit.status, "unavailable");
});

test("counts repeated VIN observations once and keeps the latest terminal result", () => {
  const repeatedVin = "1FT7W2BT0JEC12345";
  const valuation = buildGsaMarketValuation(subject(), [
    comp(5001, { vin: repeatedVin, endedAt: "2026-07-01T15:00:00.000Z" }),
    comp(5002, { vin: repeatedVin, endedAt: "2026-07-20T15:00:00.000Z" }),
    comp(5003, { vin: "1FT7W2BT0JEC54321", endedAt: "2026-07-10T15:00:00.000Z" }),
  ], asOf);

  assert.equal(valuation.status, "available");
  assert.equal(valuation.sampleSize, 2);
  assert.equal(valuation.comparables.some((sample) => sample.auctionId === "5001"), false);
  assert.equal(valuation.comparables.some((sample) => sample.auctionId === "5002"), true);
});

test("penalizes dispersed adjusted outcomes in confidence", () => {
  const clustered = buildGsaMarketValuation(subject(), [
    1_000_000, 1_050_000, 1_100_000, 1_150_000, 1_200_000,
  ].map((closedHighBidCents, index) => comp(6_000 + index, { closedHighBidCents })), asOf);
  const dispersed = buildGsaMarketValuation(subject(), [
    100_000, 200_000, 1_000_000, 3_000_000, 5_000_000,
  ].map((closedHighBidCents, index) => comp(6_100 + index, { closedHighBidCents })), asOf);

  assert.equal(clustered.status, "available");
  assert.equal(dispersed.status, "available");
  assert.ok(clustered.confidence > dispersed.confidence);
});

test("excludes an isolated implausible price without discarding sparse newer-vehicle evidence", () => {
  const guarded = buildGsaMarketValuation(subject(), [
    comp(6_200, { closedHighBidCents: 9_966 }),
    comp(6_201, { closedHighBidCents: 760_000 }),
    comp(6_202, { closedHighBidCents: 790_000 }),
    comp(6_203, { closedHighBidCents: 820_000 }),
    comp(6_204, { closedHighBidCents: 850_000 }),
    comp(6_205, { closedHighBidCents: 880_000 }),
  ], asOf);
  const sparse = buildGsaMarketValuation(subject(), [
    comp(6_300, { closedHighBidCents: 9_966 }),
    comp(6_301, { closedHighBidCents: 820_000 }),
  ], asOf);

  assert.equal(guarded.status, "available");
  assert.equal(guarded.sampleSize, 5);
  assert.equal(guarded.comparables.some((sample) => sample.auctionId === "6200"), false);
  assert.ok(guarded.lowCents > 500_000);
  assert.equal(sparse.status, "available");
  assert.equal(sparse.sampleSize, 2);
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
