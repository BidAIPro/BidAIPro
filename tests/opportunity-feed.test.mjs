import assert from "node:assert/strict";
import test from "node:test";

import { mergeOpportunityFeed } from "../lib/opportunity-feed.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

function opportunity(overrides = {}) {
  return {
    id: "auction-1",
    lastCheckedAt: "2026-08-05T17:00:00.000Z",
    imageUrl: null,
    images: [],
    valuation: { status: "unavailable" },
    ...overrides,
  };
}

test("an older cached response cannot erase newer renewed photos", () => {
  const current = opportunity({
    lastCheckedAt: "2026-08-05T17:05:00.000Z",
    imageUrl: "https://example.test/new-hero.jpg",
    images: ["https://example.test/new-hero.jpg", "https://example.test/new-side.jpg"],
  });
  const stale = opportunity({ lastCheckedAt: "2026-08-05T17:00:00.000Z" });

  assert.strictEqual(mergeOpportunityFeed([current], [stale])[0], current);
});

test("equal observations prefer the copy with richer image evidence", () => {
  const current = opportunity({
    imageUrl: "https://example.test/hero.jpg",
    images: ["https://example.test/hero.jpg"],
  });
  const stripped = opportunity();

  assert.strictEqual(mergeOpportunityFeed([current], [stripped])[0], current);
});

test("a genuinely newer observation replaces renewed signatures", () => {
  const current = opportunity({
    imageUrl: "https://example.test/old-hero.jpg",
    images: ["https://example.test/old-hero.jpg"],
  });
  const renewed = opportunity({
    lastCheckedAt: "2026-08-05T17:05:00.000Z",
    imageUrl: "https://example.test/new-hero.jpg",
    images: ["https://example.test/new-hero.jpg"],
  });

  assert.strictEqual(mergeOpportunityFeed([current], [renewed])[0], renewed);
});

function modeledOpportunity(overrides = {}) {
  return structuredClone({
    ...SEED_AUCTIONS[0],
    id: "modeled-auction-1",
    externalId: "modeled-external-1",
    ...overrides,
  });
}

test("a newer background valuation enriches a newer live bid without rolling it back", () => {
  const live = modeledOpportunity({
    currentBidCents: 1_250_000,
    bidderCount: 9,
    lastCheckedAt: "2026-08-05T18:10:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T17:00:00.000Z",
      medianCents: 1_400_000,
    },
  });
  const background = modeledOpportunity({
    currentBidCents: 900_000,
    bidderCount: 5,
    lastCheckedAt: "2026-08-05T18:00:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T18:05:00.000Z",
      lowCents: 1_800_000,
      medianCents: 2_000_000,
      highCents: 2_200_000,
      sampleSize: 30,
    },
  });

  const merged = mergeOpportunityFeed([live], [background])[0];

  assert.equal(merged.currentBidCents, 1_250_000);
  assert.equal(merged.bidderCount, 9);
  assert.equal(merged.lastCheckedAt, "2026-08-05T18:10:00.000Z");
  assert.equal(merged.valuation.medianCents, 2_000_000);
  assert.equal(merged.valuation.asOf, "2026-08-05T18:05:00.000Z");
  assert.equal(merged.forecast.asOf, "2026-08-05T18:10:00.000Z");
  assert.equal(merged.forecast.currentBidAtForecastCents, 1_250_000);
  assert.equal(merged.assessment.calculatedAt, "2026-08-05T18:10:00.000Z");
});

test("a newer listing keeps its bid while retaining a later existing valuation", () => {
  const current = modeledOpportunity({
    currentBidCents: 800_000,
    bidderCount: 4,
    lastCheckedAt: "2026-08-05T18:00:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T18:20:00.000Z",
      lowCents: 1_700_000,
      medianCents: 1_900_000,
      highCents: 2_100_000,
      sampleSize: 24,
    },
  });
  const incoming = modeledOpportunity({
    currentBidCents: 1_100_000,
    bidderCount: 8,
    lastCheckedAt: "2026-08-05T18:10:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T18:05:00.000Z",
      lowCents: 1_200_000,
      medianCents: 1_300_000,
      highCents: 1_400_000,
    },
  });

  const merged = mergeOpportunityFeed([current], [incoming])[0];

  assert.equal(merged.currentBidCents, 1_100_000);
  assert.equal(merged.bidderCount, 8);
  assert.equal(merged.lastCheckedAt, "2026-08-05T18:10:00.000Z");
  assert.equal(merged.valuation.medianCents, 1_900_000);
  assert.equal(merged.forecast.asOf, "2026-08-05T18:20:00.000Z");
  assert.equal(merged.forecast.currentBidAtForecastCents, 1_100_000);
});

test("a newer unavailable valuation cannot erase older numeric evidence", () => {
  const current = modeledOpportunity({
    lastCheckedAt: "2026-08-05T18:00:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T18:00:00.000Z",
      medianCents: 1_900_000,
    },
  });
  const incoming = modeledOpportunity({
    lastCheckedAt: "2026-08-05T18:10:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      status: "unavailable",
      lowCents: null,
      medianCents: null,
      highCents: null,
      asOf: "2026-08-05T18:10:00.000Z",
    },
  });

  const merged = mergeOpportunityFeed([current], [incoming])[0];

  assert.equal(merged.lastCheckedAt, "2026-08-05T18:10:00.000Z");
  assert.equal(merged.valuation.medianCents, 1_900_000);
  assert.equal(merged.valuation.status, current.valuation.status);
});
