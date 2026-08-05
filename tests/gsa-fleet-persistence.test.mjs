import assert from "node:assert/strict";
import test from "node:test";

import {
  GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE,
  GSA_FLEET_CLOSED_SOURCE_CHECK_SCOPE,
  gsaFleetClosedSyncWindow,
  persistGsaFleetActiveListings,
  syncClosedGsaFleetOutcomes,
} from "../lib/gsa-fleet-persistence.ts";

const NOW = new Date("2026-08-05T18:00:00.000Z");

class FakeStatement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.database, this.sql, args);
  }

  async first() {
    this.database.operations.push({ kind: "first", sql: this.sql, args: this.args });
    return { checked_at: this.database.coveredThrough };
  }

  async run() {
    this.database.operations.push({ kind: "run", sql: this.sql, args: this.args });
    return {
      success: true,
      results: [],
      meta: { changes: this.sql.includes("UPDATE auctions SET") ? 2 : 1 },
    };
  }
}

class FakeD1 {
  constructor(coveredThrough = null) {
    this.coveredThrough = coveredThrough;
    this.operations = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.operations.push({ kind: "batch", statements });
    return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  }
}

function fleetVehicle(overrides = {}) {
  return {
    source: "gsa-fleet",
    sourceId: "fleet-active-1",
    externalKey: "gsa-fleet:fleet-active-1",
    sourceUrl: "https://marketplace.gsafleet.gov/sales/vehicle-details/1C6RR6FG9JS283922",
    vin: "1C6RR6FG9JS283922",
    saleNumber: "3FDDCI26140",
    saleRunNumber: "244",
    year: 2018,
    make: "RAM",
    model: "RAM 1500",
    mileage: 25_234,
    vehicleType: "Pickup Trucks (4x2)",
    fuelType: "Gasoline - Dedicated",
    conditionCode: "4",
    saleType: "Internet",
    saleStatus: "Active",
    vehicleSaleStatus: "Lotted",
    channel: "internet",
    phase: "active",
    outcome: "lotted",
    startsAt: "2026-08-05T17:00:00.000Z",
    endsAt: "2026-08-05T19:00:00.000Z",
    extendedEndsAt: null,
    effectiveEndsAt: "2026-08-05T19:00:00.000Z",
    highBidCents: 1_372_500,
    floorPriceCents: 1_100_000,
    winningBidCents: null,
    saleProceedsCents: null,
    finalPriceCents: null,
    finalPriceBasis: "unavailable",
    isComparableOutcome: false,
    location: {
      vendorName: "Fleet auction vendor",
      city: "Conshohocken",
      state: "PA",
      postalCode: null,
    },
    vendorTimezone: "US/Eastern",
    images: ["https://media.ext.edgeapps.net/example/truck.jpg"],
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function snapshot(rows) {
  return {
    source: "gsa-fleet",
    kind: "active-and-coming",
    endpoint: "https://api.shared-public.gsafleet.gov/graphql/shared-public-gateway",
    sourceUrl: "https://marketplace.gsafleet.gov/sales/browse-vehicles",
    observedAt: NOW.toISOString(),
    advertisedCount: rows.length,
    complete: true,
    cache: "refresh",
    rows,
    limitations: [],
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function closedListing(overrides = {}) {
  return {
    id: "fleet-closed-1",
    makeName: "RAM",
    modelName: "RAM 1500",
    modelYear: 2018,
    vin: "1C6RR6FG9JS283922",
    vehicleMiles: 25_234,
    vehicleType: "Pickup Trucks (4x2)",
    vehicleCondition: "4",
    vendorName: "Fleet auction vendor",
    vendorCity: "Conshohocken",
    vendorState: "PA",
    saleType: "Internet",
    saleStatus: "Closed",
    vehicleSaleStatus: "Sold",
    saleStartDate: "2026-08-01T17:00:00.000Z",
    saleEndDate: "2026-08-04T19:00:00.000Z",
    extendedSaleEndDate: null,
    saleNumber: "3FDDCI26140",
    saleRunNumber: "244",
    photoUrl: null,
    photoUrlLarge: null,
    fuelType: "Gasoline - Dedicated",
    vendorTimezone: "US/Eastern",
    highBid: 13_725,
    floorPrice: 11_000,
    winningBidAmt: 13_825,
    saleProceedsAmt: 13_825,
    ...overrides,
  };
}

test("persists only active Internet rows and appends source-linked bid observations", async () => {
  const database = new FakeD1();
  const summary = await persistGsaFleetActiveListings(database, snapshot([
    fleetVehicle(),
    fleetVehicle({
      sourceId: "fleet-coming",
      externalKey: "gsa-fleet:fleet-coming",
      phase: "coming",
      highBidCents: null,
    }),
    fleetVehicle({
      sourceId: "fleet-live",
      externalKey: "gsa-fleet:fleet-live",
      channel: "live",
      saleType: "Live",
    }),
  ]));

  assert.equal(summary.activeInternetVehicles, 1);
  assert.equal(summary.observationsAppended, 1);
  assert.equal(summary.archived, 2);

  const statements = database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
  const auction = statements.find((statement) => statement.sql.includes("INSERT INTO auctions"));
  const observation = statements.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO bid_observations"));
  assert.equal(auction.args[0], "gsa-fleet:fleet-active-1");
  assert.equal(auction.args[1], "fleet-active-1");
  assert.equal(auction.args[5], 1_372_500);
  assert.equal(observation.args[1], "gsa-fleet:fleet-active-1");
  assert.equal(observation.args[4], 1_372_500);
  assert.match(observation.sql, /bidder_count.*NULL/s);

  const runs = database.operations.filter((operation) => operation.kind === "run");
  const startedCheck = runs[0];
  assert.equal(startedCheck.args[1], GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE);
  const archive = runs.find((operation) => operation.sql.includes("WITH previous_complete"));
  assert.match(archive.sql, /last_seen_at < \(SELECT checked_at FROM previous_complete\)/);
  assert.match(runs.at(-1).sql, /coverage_status = 'complete'/);
});

test("uses an overlapping Fleet outcome cursor without skipping an outage", () => {
  const bootstrap = gsaFleetClosedSyncWindow(null, NOW);
  assert.equal(bootstrap.mode, "bootstrap");
  assert.equal(bootstrap.since.toISOString(), "2026-07-29T18:00:00.000Z");

  const incremental = gsaFleetClosedSyncWindow("2026-08-05T17:00:00.000Z", NOW);
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.since.toISOString(), "2026-08-03T17:00:00.000Z");
  assert.equal(incremental.through.toISOString(), NOW.toISOString());
});

test("upserts confirmed Fleet awards while excluding an unawarded displayed high bid", async () => {
  const database = new FakeD1("2026-08-04T18:00:00.000Z");
  let requestBody;
  const fetchImpl = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return json({
      data: {
        getVehicleListingDetails: {
          count: 3,
          hasMore: false,
          rows: [
            closedListing(),
            closedListing({
              id: "fleet-live-award",
              vin: "1FM5K8D80JGA44616",
              saleType: "Live",
              vehicleSaleStatus: "Awarded",
              highBid: null,
              winningBidAmt: null,
              saleProceedsAmt: 13_200,
            }),
            closedListing({
              id: "fleet-unawarded",
              vin: "1FTEW1LP5SKE08763",
              vehicleSaleStatus: "Lotted",
              highBid: 14_600,
              winningBidAmt: null,
              saleProceedsAmt: null,
            }),
          ],
        },
      },
    });
  };

  const summary = await syncClosedGsaFleetOutcomes(database, {
    now: NOW,
    fetchImpl,
    pageSize: 10,
    maxRows: 10,
  });

  assert.equal(summary.confirmedAwardedOutcomes, 2);
  assert.equal(summary.excludedWithoutConfirmedPrice, 1);
  assert.equal(requestBody.variables.filters[0].conditions[1].key, "saleEndDate");

  const upserts = database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
  assert.equal(upserts.length, 2);
  assert.match(upserts[0].sql, /'gsa-fleet'/);
  assert.match(upserts[0].sql, /'confirmed'/);
  assert.match(upserts[0].sql, /'awarded-price-official-gsa-fleet'/);
  assert.equal(upserts[0].args[1], "fleet-closed-1");
  assert.equal(upserts[0].args[9], "usable");
  assert.equal(upserts[0].args[12], 1_372_500);
  assert.equal(upserts[0].args[13], 1_382_500);
  assert.equal(upserts[1].args[12], 0);
  assert.equal(upserts[1].args[13], 1_320_000);

  const cursor = database.operations.find((operation) => operation.kind === "first");
  assert.equal(cursor.args[0], GSA_FLEET_CLOSED_SOURCE_CHECK_SCOPE);
  const completion = database.operations.filter((operation) => operation.kind === "run").at(-1);
  assert.match(completion.sql, /coverage_status = 'complete'/);
});
