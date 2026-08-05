import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeGsaClosedCompCorpus,
  retainedClosedCompCoverage,
  validateGsaClosedCompCorpus,
} from "../lib/gsa-closed-comp-corpus.ts";
import {
  CLOSED_COMP_SOURCE_CHECK_SCOPE,
  closedCompSyncWindow,
  syncClosedGsaVehicleComps,
} from "../lib/gsa-closed-comp-sync.ts";

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
    return { success: true, results: [], meta: { changes: 1 } };
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

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function catalogRow(overrides = {}) {
  return {
    auctionId: 1001,
    lotId: 2001,
    lotNumber: 1,
    salesNumber: "TEST26001",
    status: "Closed",
    startDate: "2026-08-01T10:00:00",
    endDate: "2026-08-05T10:00:00",
    lotName: "2018 Ford F-250",
    currentBid: 12_345,
    numberOfBidders: 8,
    location: { city: "Dallas", state: "TX", zipCode: "75201" },
    ...overrides,
  };
}

function detail() {
  return {
    propertyLocation: { city: "Dallas", state: "TX", zipCode: "75201" },
    auctionDescriptionDTO: {
      make: "FORD MOTOR CO",
      model: "F250",
      odometer: "90000",
      bodyType: "Pickup",
      conditionCode: "U",
      itemDescription: "<ul><li>Model Year: 2018</li><li>Mileage: 90000</li></ul>",
    },
  };
}

function comp(id, overrides = {}) {
  return {
    id: `gsa-closed:${id}`,
    auctionId: String(id),
    lotId: String(Number(id) + 1000),
    sourceUrl: `https://gsaauctions.gov/auctions/preview/${id}`,
    title: "2018 Ford F-250",
    closedHighBidCents: 1_234_500,
    bidderCount: 8,
    endedAt: "2026-08-04T12:00:00.000Z",
    year: 2018,
    make: "Ford",
    modelLabel: "F250",
    mileage: 90_000,
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

function coverage(overrides = {}) {
  return {
    from: "2026-08-03T00:00:00.000",
    to: "2026-08-05T23:59:59.999",
    catalogRows: 1,
    closedRows: 1,
    usableClosedHighBids: 1,
    excludedTerminated: 0,
    excludedNoBid: 0,
    detailRequested: 1,
    detailSucceeded: 1,
    detailFailed: 0,
    ...overrides,
  };
}

test("uses overlapping bounded windows and catches up without skipping an outage", () => {
  const bootstrap = closedCompSyncWindow(null, NOW);
  assert.equal(bootstrap.mode, "bootstrap");
  assert.equal(bootstrap.from.toISOString(), "2026-07-29T18:00:00.000Z");

  const incremental = closedCompSyncWindow("2026-08-05T17:00:00.000Z", NOW);
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.from.toISOString(), "2026-08-03T17:00:00.000Z");
  assert.equal(incremental.to.toISOString(), NOW.toISOString());

  const catchUp = closedCompSyncWindow("2026-06-01T00:00:00.000Z", NOW);
  assert.equal(catchUp.mode, "catch-up");
  assert.equal(
    catchUp.to.getTime() - catchUp.from.getTime(),
    14 * 86_400_000,
  );
});

test("hourly sync upserts only official terminal high bids and completes telemetry last", async () => {
  const database = new FakeD1("2026-08-04T18:00:00.000Z");
  const requestBodies = [];
  const fetchImpl = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/api/v1/auctions")) {
      requestBodies.push(JSON.parse(await request.text()));
      return json({
        totalElements: 2,
        totalPages: 1,
        auctionDTOList: [
          catalogRow(),
          catalogRow({ auctionId: 1002, lotId: 2002, status: "Terminated" }),
        ],
      });
    }
    return json(detail());
  };

  const summary = await syncClosedGsaVehicleComps(database, {
    now: NOW,
    fetchImpl,
    detailConcurrency: 2,
  });

  assert.equal(summary.mode, "incremental");
  assert.equal(summary.usableClosedHighBids, 1);
  assert.equal(summary.excludedTerminated, 1);
  assert.equal(requestBodies[0].auctionStatus, "closed");
  const upserts = database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
  assert.equal(upserts.length, 1);
  assert.match(upserts[0].sql, /'closed-high-bid-official-catalog'/);
  assert.match(upserts[0].sql, /\?13, NULL, 'unknown'/);
  assert.match(
    upserts[0].sql,
    /awarded_price_cents = comparable_sales\.awarded_price_cents/,
  );
  assert.doesNotMatch(upserts[0].sql, /awarded_price_cents = (?:excluded|NULL)/);
  assert.doesNotMatch(upserts[0].sql, /current_bid/i);
  assert.equal(upserts[0].args[1], "1001");
  assert.equal(upserts[0].args[3], "2018|ford-f250");
  assert.equal(upserts[0].args[12], 1_234_500);

  const runs = database.operations.filter((operation) => operation.kind === "run");
  const completion = runs.at(-1);
  assert.match(completion.sql, /coverage_status = 'complete'/);
  const cursorQuery = database.operations.find((operation) => operation.kind === "first");
  assert.equal(cursorQuery.args[0], CLOSED_COMP_SOURCE_CHECK_SCOPE);
});

test("failed upstream refresh records bounded failure telemetry without mutating comps", async () => {
  const database = new FakeD1("2026-08-04T18:00:00.000Z");
  await assert.rejects(
    syncClosedGsaVehicleComps(database, {
      now: NOW,
      fetchImpl: async () => new Response(null, { status: 503 }),
    }),
    (error) => error.code === "GSA_CLOSED_CATALOG_HTTP_ERROR",
  );

  assert.equal(database.operations.some((operation) => operation.kind === "batch"), false);
  const failure = database.operations
    .filter((operation) => operation.kind === "run")
    .at(-1);
  assert.match(failure.sql, /coverage_status = 'failed'/);
  assert.equal(failure.args[1], 503);
  assert.equal(failure.args[3], "GSA_CLOSED_CATALOG_HTTP_ERROR");
});

test("corpus merges overlapping corrections idempotently and rejects subject-bid fields", () => {
  const initial = mergeGsaClosedCompCorpus(null, {
    comparables: [comp(1001), comp(1002, { endedAt: "2026-08-03T12:00:00.000Z" })],
    coverage: coverage({ catalogRows: 2, closedRows: 2, usableClosedHighBids: 2, detailRequested: 2, detailSucceeded: 2 }),
    observedAt: "2026-08-04T18:00:00.000Z",
  }, { now: new Date("2026-08-04T18:00:00.000Z"), retentionDays: 366 });
  const merged = mergeGsaClosedCompCorpus(initial, {
    comparables: [comp(1001, { closedHighBidCents: 1_300_000 }), comp(1003)],
    coverage: coverage({ catalogRows: 2, closedRows: 2, usableClosedHighBids: 2, detailRequested: 2, detailSucceeded: 2 }),
    observedAt: NOW.toISOString(),
  }, { now: NOW, retentionDays: 366 });

  assert.equal(merged.comparables.length, 3);
  assert.equal(merged.comparables.find((value) => value.auctionId === "1001").closedHighBidCents, 1_300_000);
  assert.equal(retainedClosedCompCoverage(merged).usableClosedHighBids, 3);
  assert.throws(
    () => mergeGsaClosedCompCorpus(merged, {
      comparables: [],
      coverage: coverage({ catalogRows: 0, closedRows: 0, usableClosedHighBids: 0, detailRequested: 0, detailSucceeded: 0 }),
      observedAt: "2026-08-04T18:00:00.000Z",
    }, { now: new Date("2026-08-04T18:00:00.000Z") }),
    /backward in time/i,
  );
  assert.throws(
    () => validateGsaClosedCompCorpus({ ...merged, subjectBidCents: 5 }),
    /forbidden subject bid/i,
  );
});
