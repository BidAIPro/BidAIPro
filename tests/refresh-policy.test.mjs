import assert from "node:assert/strict";
import test from "node:test";

import {
  FIFTEEN_SECONDS_MS,
  FIVE_MINUTES_MS,
  getRefreshDecision,
  HOUR_MS,
  THIRTY_SECONDS_MS,
} from "../lib/refresh-policy.ts";

const end = Date.parse("2026-08-05T18:00:00.000Z");

function decision(remainingMs, overrides = {}) {
  const now = end - remainingMs;
  return getRefreshDecision({
    now,
    endsAt: end,
    lastCheckedAt: now,
    status: "active",
    ...overrides,
  });
}

test("uses the exact requested cadence at every countdown boundary", () => {
  assert.equal(decision(30 * 60_000 + 1).intervalMs, HOUR_MS);

  const atThirty = decision(30 * 60_000);
  assert.equal(atThirty.cadenceBucket, "last-30-minutes");
  assert.equal(atThirty.intervalMs, FIVE_MINUTES_MS);

  const atFive = decision(5 * 60_000);
  assert.equal(atFive.cadenceBucket, "last-5-minutes");
  assert.equal(atFive.intervalMs, THIRTY_SECONDS_MS);

  const atOne = decision(60_000);
  assert.equal(atOne.cadenceBucket, "last-minute");
  assert.equal(atOne.intervalMs, FIFTEEN_SECONDS_MS);
});

test("an hourly schedule wakes at the upcoming 30-minute boundary", () => {
  const now = end - 40 * 60_000;
  const result = getRefreshDecision({
    now,
    endsAt: end,
    lastCheckedAt: now,
    status: "active",
  });

  assert.equal(result.cadenceBucket, "normal");
  assert.equal(result.dueAt, "2026-08-05T17:30:00.000Z");
  assert.equal(result.shouldRefresh, false);
});

test("crossing an urgency boundary makes a source check immediately due", () => {
  const now = end - 29 * 60_000;
  const result = getRefreshDecision({
    now,
    endsAt: end,
    lastCheckedAt: end - 31 * 60_000,
    status: "active",
  });

  assert.equal(result.cadenceBucket, "last-30-minutes");
  assert.equal(result.dueAt, "2026-08-05T17:30:00.000Z");
  assert.equal(result.shouldRefresh, true);
});

test("continues every 15 seconds through the post-close grace window", () => {
  const now = end + 30_000;
  const result = getRefreshDecision({
    now,
    endsAt: end,
    lastCheckedAt: end + 20_000,
    status: "active",
  });

  assert.equal(result.cadenceBucket, "close-grace");
  assert.equal(result.intervalMs, FIFTEEN_SECONDS_MS);
  assert.equal(result.dueAt, "2026-08-05T18:00:35.000Z");
});

test("backs off for reconciliation after grace while close is unconfirmed", () => {
  const now = end + 3 * 60_000;
  const result = getRefreshDecision({
    now,
    endsAt: end,
    lastCheckedAt: end + 2 * 60_000,
    status: "active",
  });

  assert.equal(result.cadenceBucket, "close-reconciliation");
  assert.equal(result.intervalMs, FIVE_MINUTES_MS);
});

test("stops only after a terminal outcome is confirmed", () => {
  const result = getRefreshDecision({
    now: end + 10_000,
    endsAt: end,
    lastCheckedAt: end,
    status: "sold",
  });

  assert.equal(result.cadenceBucket, "stopped");
  assert.equal(result.intervalMs, null);
  assert.equal(result.dueAt, null);
  assert.equal(result.shouldRefresh, false);
});
