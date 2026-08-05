import assert from "node:assert/strict";
import test from "node:test";
import { applyLiveBidSnapshot } from "../lib/live-bid-snapshot.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

test("live bid refresh updates auction facts and recalculates modeled all-in cost", () => {
  const original = {
    ...SEED_AUCTIONS[0],
    id: "live-gsa-ppms-372696",
    externalId: "372696",
  };
  const updated = applyLiveBidSnapshot(original, {
    externalId: "372696",
    status: "active",
    currentBidCents: 1_250_000,
    bidderCount: 9,
    endsAt: "2026-08-05T21:15:00.000Z",
    lastCheckedAt: "2026-08-05T21:14:45.000Z",
  });

  assert.equal(updated.currentBidCents, 1_250_000);
  assert.equal(updated.bidderCount, 9);
  assert.equal(updated.endsAt, "2026-08-05T21:15:00.000Z");
  assert.equal(updated.lastCheckedAt, "2026-08-05T21:14:45.000Z");
  assert.equal(updated.vehicle, original.vehicle);
  assert.equal(
    updated.assessment.allInAtCurrentBidCents,
    updated.assessment.costs.totalAllInCents,
  );
  assert.ok(updated.assessment.allInAtCurrentBidCents > updated.currentBidCents);
});

test("a mismatched snapshot cannot update the wrong auction", () => {
  const original = SEED_AUCTIONS[0];
  const updated = applyLiveBidSnapshot(original, {
    externalId: "different",
    status: "ended",
    currentBidCents: 1,
    bidderCount: 1,
    endsAt: null,
    lastCheckedAt: "2026-08-05T21:14:45.000Z",
  });
  assert.equal(updated, original);
});

test("a cached or delayed snapshot cannot move newer auction state backward", () => {
  const original = {
    ...SEED_AUCTIONS[0],
    externalId: "372696",
    currentBidCents: 2_000_000,
    bidderCount: 12,
    lastCheckedAt: "2026-08-05T21:15:00.000Z",
  };
  const updated = applyLiveBidSnapshot(original, {
    externalId: "372696",
    status: "active",
    currentBidCents: 1_250_000,
    bidderCount: 9,
    endsAt: "2026-08-05T21:15:00.000Z",
    lastCheckedAt: "2026-08-05T21:14:45.000Z",
  });

  assert.equal(updated, original);
});
