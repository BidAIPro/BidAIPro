import assert from "node:assert/strict";
import test from "node:test";

import {
  auctionMatchesState,
  boardVehicleCategory,
  buildStateFilterOptions,
  compareBestDealOpportunities,
  countAdvancedBoardFilters,
  isOpenBoardAuction,
  mergeAuthoritativeOpportunityFeed,
  normalizeAuctionState,
} from "../app/components/deal-board-filters.ts";

function categoryAuction({ title, bodyStyle, make = "Ford", model = "Unknown" }) {
  return {
    title,
    vehicle: { bodyStyle, make, model },
  };
}

test("divides passenger cars, trucks, and all remaining vehicle classes", () => {
  assert.equal(boardVehicleCategory(categoryAuction({
    title: "2022 Chevrolet Malibu",
    bodyStyle: "4 Door Sedan",
    make: "Chevrolet",
    model: "Malibu",
  })), "cars");
  assert.equal(boardVehicleCategory(categoryAuction({
    title: "2021 Ford F-250",
    bodyStyle: undefined,
    model: "F-250",
  })), "trucks");
  assert.equal(boardVehicleCategory(categoryAuction({
    title: "2020 Chevrolet Silverado 1500",
    bodyStyle: "Crew Cab Pickup",
    make: "Chevrolet",
    model: "Silverado 1500",
  })), "trucks");
  assert.equal(boardVehicleCategory(categoryAuction({
    title: "2023 Ford Explorer",
    bodyStyle: "Sport Utility Vehicle",
    model: "Explorer",
  })), "cars");
  assert.equal(boardVehicleCategory(categoryAuction({
    title: "2022 Dodge Grand Caravan",
    bodyStyle: "Minivan",
    make: "Dodge",
    model: "Grand Caravan",
  })), "cars");

  for (const [title, bodyStyle] of [
    ["2022 Ford Transit Cargo", "Cargo Van"],
    ["2019 Blue Bird Transit", "Bus"],
    ["2021 Harley-Davidson", "Motorcycle"],
  ]) {
    assert.equal(boardVehicleCategory(categoryAuction({ title, bodyStyle })), "other");
  }
});

function dealAuction({
  id = "b",
  score = 60,
  confidence = 0.5,
  profit = 10_000,
  endsAt = "2026-08-06T12:00:00.000Z",
} = {}) {
  return {
    id,
    endsAt,
    startsAt: null,
    assessment: {
      score,
      confidence,
      projectedProfitCents: profit,
    },
  };
}

test("Best Deal ties resolve deterministically", () => {
  const base = dealAuction();
  assert.ok(compareBestDealOpportunities(dealAuction({ score: 61 }), base) < 0);
  assert.ok(compareBestDealOpportunities(dealAuction({ confidence: 0.6 }), base) < 0);
  assert.ok(compareBestDealOpportunities(dealAuction({ profit: 20_000 }), base) < 0);
  assert.ok(compareBestDealOpportunities(dealAuction({
    endsAt: "2026-08-06T11:00:00.000Z",
  }), base) < 0);
  assert.ok(compareBestDealOpportunities(dealAuction({ id: "a" }), base) < 0);

  const equalRows = ["d", "a", "c", "b"].map((id) => dealAuction({ id }));
  equalRows.sort(compareBestDealOpportunities);
  assert.deepEqual(equalRows.map((auction) => auction.id), ["a", "b", "c", "d"]);
});

test("a partial one-source response cannot erase the other catalog", () => {
  const current = [
    { id: "auction-old", source: "gsa-auctions" },
    { id: "fleet-coming", source: "gsa-fleet" },
  ];
  const auctionsOnly = [{ id: "auction-new", source: "gsa-auctions" }];

  assert.deepEqual(
    mergeAuthoritativeOpportunityFeed(
      current,
      auctionsOnly,
      new Set(["gsa-auctions"]),
    ).map((auction) => auction.id),
    ["auction-new", "fleet-coming"],
  );
  assert.deepEqual(
    mergeAuthoritativeOpportunityFeed(
      current,
      auctionsOnly,
      new Set(),
    ).map((auction) => auction.id),
    ["auction-new", "auction-old", "fleet-coming"],
  );
  assert.deepEqual(
    mergeAuthoritativeOpportunityFeed(
      current,
      auctionsOnly,
      new Set(["gsa-auctions", "gsa-fleet"]),
    ).map((auction) => auction.id),
    ["auction-new"],
  );
});

test("builds a counted state menu from active and coming-soon auctions", () => {
  const auctions = [
    { status: "active", location: { state: "tx" } },
    { status: "closing", location: { state: "TX" } },
    { status: "active", location: { state: "TX" } },
    { status: "active", location: { state: "OK" } },
    { status: "preview", location: { state: "FL" } },
    { status: "active", location: { state: "\u2014" } },
    { status: "closed", location: { state: "FL" } },
  ];

  assert.deepEqual(buildStateFilterOptions(auctions), [
    { value: "FL", count: 1 },
    { value: "OK", count: 1 },
    { value: "TX", count: 3 },
  ]);
  assert.equal(auctionMatchesState(auctions[0], "TX"), true);
  assert.equal(auctionMatchesState(auctions[3], "TX"), false);
  assert.equal(auctionMatchesState(auctions[3], "all"), true);
  assert.equal(normalizeAuctionState("\u2014"), null);
  assert.equal(normalizeAuctionState(" unknown "), null);
  assert.equal(isOpenBoardAuction({ status: "active" }), true);
  assert.equal(isOpenBoardAuction({ status: "closing" }), true);
  assert.equal(isOpenBoardAuction({ status: "preview" }), false);
});

test("counts state, condition, and bid controls as advanced filters", () => {
  assert.equal(countAdvancedBoardFilters({ state: "all", condition: "all", maxBid: "" }), 0);
  assert.equal(countAdvancedBoardFilters({ state: "TX", condition: "good", maxBid: "12000" }), 3);
  assert.equal(countAdvancedBoardFilters({ state: "TX", condition: "all", maxBid: "   " }), 1);
});
