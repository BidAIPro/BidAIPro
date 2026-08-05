import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGsaFleetComparableIndex,
  gsaFleetComparableCandidates,
  gsaFleetListingToOpportunity,
} from "../lib/gsa-fleet-adapter.ts";
import { applyLiveBidSnapshot } from "../lib/live-bid-snapshot.ts";

const observedAt = "2026-08-05T12:00:00.000Z";

function row(overrides = {}) {
  const sourceId = overrides.sourceId ?? crypto.randomUUID();
  const vin = overrides.vin ?? "1N6AA1ED0RN100001";
  return {
    source: "gsa-fleet",
    sourceId,
    externalKey: `gsa-fleet:${sourceId}`,
    sourceUrl: `https://marketplace.gsafleet.gov/sales/vehicle-details/${vin}`,
    vin,
    saleNumber: "8ABCPC26123",
    saleRunNumber: "12",
    year: 2024,
    make: "NISSAN",
    model: "Titan",
    mileage: 20_000,
    vehicleType: "Pickup Trucks (4x4)",
    fuelType: "Gasoline - Dedicated",
    conditionCode: "4",
    saleType: "Internet",
    saleStatus: "Active",
    vehicleSaleStatus: "Lotted",
    channel: "internet",
    phase: "active",
    outcome: "lotted",
    startsAt: "2026-08-01T12:00:00.000Z",
    endsAt: "2026-08-07T12:00:00.000Z",
    extendedEndsAt: null,
    effectiveEndsAt: "2026-08-07T12:00:00.000Z",
    highBidCents: 500_000,
    floorPriceCents: null,
    winningBidCents: null,
    saleProceedsCents: null,
    finalPriceCents: null,
    finalPriceBasis: "unavailable",
    isComparableOutcome: false,
    location: { vendorName: "Public Auto", city: "Dallas", state: "TX", postalCode: null },
    vendorTimezone: "US/Central",
    images: ["https://example.com/titan.jpg"],
    observedAt,
    ...overrides,
  };
}

function sold(overrides = {}) {
  return row({
    sourceId: crypto.randomUUID(),
    vin: `1N6AA1ED0PN${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    year: 2023,
    mileage: 25_000,
    saleStatus: "Closed",
    vehicleSaleStatus: "Sold",
    phase: "closed",
    outcome: "sold",
    highBidCents: null,
    winningBidCents: null,
    saleProceedsCents: 2_000_000,
    finalPriceCents: 2_000_000,
    finalPriceBasis: "sale-proceeds",
    isComparableOutcome: true,
    startsAt: "2026-06-01T12:00:00.000Z",
    endsAt: "2026-06-01T12:00:00.000Z",
    effectiveEndsAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  });
}

test("uses a sparse close Fleet outcome without widening to a remote model year", () => {
  const subject = row();
  const close = sold({ saleProceedsCents: 2_200_000, finalPriceCents: 2_200_000 });
  const remote = sold({
    year: 2010,
    mileage: 210_000,
    saleProceedsCents: 400_000,
    finalPriceCents: 400_000,
  });
  const index = buildGsaFleetComparableIndex([close, remote]);
  const candidates = gsaFleetComparableCandidates(subject, index);
  const opportunity = gsaFleetListingToOpportunity(subject, candidates);

  assert.equal(opportunity.source, "gsa-fleet");
  assert.equal(opportunity.valuation.sampleSize, 1);
  assert.ok(opportunity.valuation.medianCents > 1_500_000);
  assert.equal(opportunity.forecast.sampleSize, 1);
  assert.ok(opportunity.forecast.expectedCents >= subject.highBidCents);

  const refreshed = applyLiveBidSnapshot(opportunity, {
    externalId: opportunity.externalId,
    status: "active",
    currentBidCents: 750_000,
    bidderCount: null,
    endsAt: "2026-08-07T12:00:00.000Z",
    lastCheckedAt: "2026-08-05T12:05:00.000Z",
  });
  assert.equal(refreshed.forecast.sampleSize, 1);
  assert.deepEqual(refreshed.forecast.evidenceIds, opportunity.forecast.evidenceIds);
  assert.ok(refreshed.forecast.expectedCents >= 750_000);
});

test("keeps scrap outcomes out of usable Fleet valuation and forecast evidence", () => {
  const subject = row({ conditionCode: "4" });
  const normalA = sold({
    sourceId: "usable-a",
    conditionCode: "4",
    saleProceedsCents: 2_000_000,
    finalPriceCents: 2_000_000,
  });
  const normalB = sold({
    sourceId: "usable-b",
    conditionCode: "4",
    saleProceedsCents: 2_200_000,
    finalPriceCents: 2_200_000,
  });
  const scrap = sold({
    sourceId: "scrap-outcome",
    conditionCode: "S",
    saleProceedsCents: 10_000,
    finalPriceCents: 10_000,
  });
  const index = buildGsaFleetComparableIndex([normalA, normalB, scrap]);
  const opportunity = gsaFleetListingToOpportunity(
    subject,
    gsaFleetComparableCandidates(subject, index),
  );

  assert.equal(opportunity.vehicle.condition, "fair");
  assert.equal(opportunity.valuation.sampleSize, 2);
  assert.equal(opportunity.forecast.sampleSize, 2);
  assert.equal(
    opportunity.forecast.evidenceIds.includes("gsa-fleet:scrap-outcome"),
    false,
  );
  assert.ok(opportunity.valuation.lowCents > 1_000_000);
});

test("values Chevrolet K3500 listings from equivalent Silverado 3500 outcomes", () => {
  const subject = row({
    vin: "1GC4KZCG0HF100001",
    year: 2017,
    make: "CHEVROLET",
    model: "K3500",
    mileage: 31_976,
  });
  const equivalent = sold({
    sourceId: "silverado-3500-award",
    vin: "1GC4KZCG0JF100002",
    year: 2018,
    make: "CHEVROLET",
    model: "Silverado 3500",
    mileage: 35_000,
    saleProceedsCents: 3_700_000,
    finalPriceCents: 3_700_000,
  });
  const index = buildGsaFleetComparableIndex([equivalent]);
  const opportunity = gsaFleetListingToOpportunity(
    subject,
    gsaFleetComparableCandidates(subject, index),
  );

  assert.equal(opportunity.valuation.sampleSize, 1);
  assert.ok(opportunity.valuation.medianCents > 3_000_000);
  assert.equal(opportunity.forecast.sampleSize, 1);
});

test("scheduled live Fleet sales stay preview-only and never invent an online bid", () => {
  const subject = row({
    saleType: "Live",
    channel: "live",
    phase: "coming",
    highBidCents: 999_900,
    startsAt: "2026-08-10T12:00:00.000Z",
    endsAt: "2026-08-10T12:00:00.000Z",
    effectiveEndsAt: "2026-08-10T12:00:00.000Z",
  });
  const opportunity = gsaFleetListingToOpportunity(subject, []);

  assert.equal(opportunity.status, "preview");
  assert.equal(opportunity.onlineBidding, false);
  assert.equal(opportunity.currentBidCents, null);
  assert.equal(opportunity.forecast.status, "insufficient");
  assert.equal(opportunity.assessment.status, "insufficient");
  assert.equal(opportunity.assessment.score, 0);
});
