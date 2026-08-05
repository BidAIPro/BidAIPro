import assert from "node:assert/strict";
import test from "node:test";
import { persistGsaDiscovery } from "../lib/gsa-persistence.ts";

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
    if (this.sql.includes("SELECT result_count, expected_result_count")) {
      return this.database.previousCoverage;
    }
    return null;
  }

  async run() {
    this.database.operations.push({ kind: "run", sql: this.sql, args: this.args });
    return { results: [], success: true, meta: { changes: this.sql.includes("UPDATE auctions SET") ? 0 : 1 } };
  }
}

class FakeD1 {
  constructor(previousCoverage = null) {
    this.previousCoverage = previousCoverage;
    this.operations = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.operations.push({ kind: "batch", statements });
    return statements.map((statement) => ({
      results: statement.sql.includes("SELECT current_bid_cents") ? [] : [],
      success: true,
      meta: { changes: 1 },
    }));
  }
}

function sourceHealth(status = "live") {
  return {
    source: "GSA Auctions API",
    official: true,
    endpoint: "https://api.gsa.gov/assets/gsaauctions/v2/auctions",
    sourceMode: "legacy-bulk-feed",
    status,
    cache: status === "live" ? "refresh" : "stale-fallback",
    credentialMode: "configured",
    fetchedAt: "2026-08-05T05:00:00.000Z",
    observedAt: "2026-08-05T05:00:00.000Z",
    cachedUntil: "2026-08-05T06:00:00.000Z",
    staleSince: null,
    ageSeconds: 0,
    lastErrorCode: null,
    discoveryCadence: "hourly",
    limitations: [],
  };
}

function vehicle(overrides = {}) {
  return {
    id: "gsa:test-sale:001",
    source: "gsa-auctions",
    saleNumber: "TEST-SALE",
    lotNumber: "001",
    lotSequence: "001",
    title: "2020 Ford Transit",
    description: "Source details pending.",
    status: "active",
    startsAt: null,
    endsAt: null,
    currentBid: null,
    bidderCount: null,
    bidIncrement: null,
    reserve: null,
    inactivityMinutes: null,
    url: "https://www.gsaauctions.gov/auctions/preview/123456",
    imageUrl: null,
    images: [],
    vin: null,
    mileage: null,
    odometerStatus: "not-reported",
    bodyType: "van",
    year: 2020,
    make: "Ford",
    modelLabel: "Transit",
    transmission: null,
    fuelType: null,
    cylinders: null,
    color: null,
    openRecall: null,
    conditionCode: null,
    condition: "unknown",
    operability: "unknown",
    damageFlags: [],
    issueFlags: [],
    conditionNotes: [],
    location: { addressLines: [], city: "Dallas", state: "TX", postalCode: "75201" },
    saleLocation: { addressLines: [], city: null, state: null, postalCode: null },
    agency: { code: null, name: "GSA", bureauCode: null, bureauName: null },
    evidence: { title: true, vin: false, mileage: false, bodyType: true, matched: [] },
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return {
    auctions: [vehicle()],
    coverage: {
      totalLots: 100,
      vehicleLots: 1,
      excludedLots: 99,
      withVin: 0,
      withMileage: 0,
      withBodyType: 1,
      withImage: 0,
      withCurrentBid: 0,
      statusCounts: { active: 1, preview: 0, scheduled: 0, unknown: 0 },
      exclusionCounts: {},
    },
    sourceHealth: sourceHealth(),
    ...overrides,
  };
}

test("refuses stale and implausibly empty catalogs before mutating auction state", async () => {
  const staleDb = new FakeD1();
  await assert.rejects(
    persistGsaDiscovery(staleDb, discovery({ sourceHealth: sourceHealth("stale") })),
    (error) => error.code === "GSA_STALE_SNAPSHOT_REJECTED",
  );
  assert.equal(staleDb.operations.length, 0);

  const emptyDb = new FakeD1();
  await assert.rejects(
    persistGsaDiscovery(emptyDb, discovery({
      auctions: [],
      coverage: { ...discovery().coverage, totalLots: 0, vehicleLots: 0 },
    })),
    (error) => error.code === "GSA_IMPLAUSIBLE_COVERAGE",
  );
  assert.equal(emptyDb.operations.some((operation) => operation.sql?.includes("INSERT INTO auctions")), false);
});

test("preserves unknown bid facts, requires consecutive misses, and completes telemetry last", async () => {
  const database = new FakeD1();
  await persistGsaDiscovery(database, discovery());

  const batchedStatements = database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
  const auctionInsert = batchedStatements.find((statement) => statement.sql.includes("INSERT INTO auctions"));
  const observationInsert = batchedStatements.find((statement) => statement.sql.includes("INSERT INTO bid_observations"));
  assert.equal(auctionInsert.args[6], null);
  assert.equal(auctionInsert.args[7], null);
  assert.equal(auctionInsert.args[11], null);
  assert.equal(observationInsert.args[4], null);
  assert.equal(observationInsert.args[5], null);
  assert.equal(observationInsert.args[7], null);

  const runs = database.operations.filter((operation) => operation.kind === "run");
  const archive = runs.find((operation) => operation.sql.includes("WITH previous_complete"));
  assert.match(archive.sql, /last_seen_at < \(SELECT checked_at FROM previous_complete\)/);
  const comparableIndex = runs.findIndex((operation) => operation.sql.includes("INSERT OR IGNORE INTO comparable_sales"));
  const completionIndex = runs.findIndex((operation) => operation.sql.includes("UPDATE source_checks") && operation.sql.includes("coverage_status = 'complete'"));
  assert.ok(comparableIndex >= 0 && completionIndex > comparableIndex);
});

test("does not erase stored enrichment when one PPMS lot detail is unavailable", async () => {
  const database = new FakeD1();
  await persistGsaDiscovery(database, discovery({
    auctions: [vehicle({ detailEnriched: false })],
  }));

  const statements = database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
  const auctionUpsert = statements.find((statement) => statement.sql.includes("INSERT INTO auctions"));
  const vehicleUpsert = statements.find((statement) => statement.sql.includes("INSERT INTO vehicles"));

  assert.match(auctionUpsert.sql, /primary_image_url = COALESCE/);
  assert.match(auctionUpsert.sql, /julianday\(excluded\.last_checked_at\).*julianday\(auctions\.last_checked_at\)/s);
  assert.match(vehicleUpsert.sql, /excluded\.source_description IS NULL THEN vehicles\.odometer_status/);
  assert.match(vehicleUpsert.sql, /THEN vehicles\.damage_flags_json/);
  assert.equal(vehicleUpsert.args[16], null);
  assert.equal(vehicleUpsert.args[19], null);
});
