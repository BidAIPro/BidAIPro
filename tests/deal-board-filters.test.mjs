import assert from "node:assert/strict";
import test from "node:test";

import {
  auctionMatchesState,
  buildStateFilterOptions,
  countAdvancedBoardFilters,
  normalizeAuctionState,
} from "../app/components/deal-board-filters.ts";

test("builds a counted state menu from active auctions only", () => {
  const auctions = [
    { status: "active", location: { state: "tx" } },
    { status: "active", location: { state: "TX" } },
    { status: "active", location: { state: "OK" } },
    { status: "active", location: { state: "\u2014" } },
    { status: "closed", location: { state: "FL" } },
  ];

  assert.deepEqual(buildStateFilterOptions(auctions), [
    { value: "OK", count: 1 },
    { value: "TX", count: 2 },
  ]);
  assert.equal(auctionMatchesState(auctions[0], "TX"), true);
  assert.equal(auctionMatchesState(auctions[2], "TX"), false);
  assert.equal(auctionMatchesState(auctions[2], "all"), true);
  assert.equal(normalizeAuctionState("\u2014"), null);
  assert.equal(normalizeAuctionState(" unknown "), null);
});

test("counts state, condition, and bid controls as advanced filters", () => {
  assert.equal(countAdvancedBoardFilters({ state: "all", condition: "all", maxBid: "" }), 0);
  assert.equal(countAdvancedBoardFilters({ state: "TX", condition: "good", maxBid: "12000" }), 3);
  assert.equal(countAdvancedBoardFilters({ state: "TX", condition: "all", maxBid: "   " }), 1);
});
