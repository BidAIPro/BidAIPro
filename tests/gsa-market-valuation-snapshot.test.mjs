import assert from "node:assert/strict";
import test from "node:test";

import {
  getGsaMarketValuation,
  getGsaMarketValuationSnapshot,
} from "../lib/gsa-market-valuation-snapshot.ts";

test("loads the generated official GSA valuation snapshot by normalized or external id", () => {
  const snapshot = getGsaMarketValuationSnapshot();
  assert.equal(snapshot.coverage.subjectCount, snapshot.valuations.length);
  assert.equal(snapshot.coverage.valuedCount, snapshot.coverage.subjectCount);
  assert.equal(snapshot.coverage.unavailableCount, 0);
  const first = snapshot.valuations[0];
  assert.ok(first);
  assert.equal(getGsaMarketValuation(first.subjectAuctionId), first);
  assert.equal(getGsaMarketValuation(first.externalId), first);
  assert.equal(getGsaMarketValuation("missing"), null);
});
