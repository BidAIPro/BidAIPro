import assert from "node:assert/strict";
import test from "node:test";

import {
  GSA_FLEET_CLOSING_SOURCE_CHECK_SCOPE,
  listGsaFleetClosingCandidates,
  runGsaFleetClosingWindowRefresh,
  saleNumberFromLot,
} from "../lib/gsa-fleet-closing-refresh.ts";
import { GsaFleetClientError } from "../lib/gsa-fleet-client.ts";

class FakeStatement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.database, this.sql, args);
  }

  async all() {
    this.database.operations.push({ kind: "all", sql: this.sql, args: this.args });
    return {
      results: this.database.candidates.map((candidate) => ({ ...candidate })),
      success: true,
      meta: {},
    };
  }

  async run() {
    this.database.operations.push({ kind: "run", sql: this.sql, args: this.args });
    return { results: [], success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor(candidates) {
    this.candidates = candidates;
    this.operations = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.operations.push({ kind: "batch", statements });
    return statements.map(() => ({ results: [], success: true, meta: { changes: 1 } }));
  }
}

const START = Date.parse("2026-08-05T21:00:00.000Z");

function iso(offsetMs) {
  return new Date(START + offsetMs).toISOString();
}

function candidate(overrides = {}) {
  return {
    id: "gsa-fleet:fleet-active-1",
    external_id: "fleet-active-1",
    sale_lot_number: "3FDDCI26140 / Run 244 / fleet-active-1",
    vin: "1C6RR6FG9JS283922",
    status: "closing",
    current_bid_cents: 1_372_500,
    bidder_count: null,
    ends_at: iso(4 * 60_000),
    last_checked_at: iso(-31_000),
    extension_count: 0,
    ...overrides,
  };
}

function activity(row, checkedAt, overrides = {}) {
  return {
    source: "gsa-fleet",
    observedAt: checkedAt,
    detail: {
      sourceId: row.external_id,
      saleStatus: "Active",
      vehicleSaleStatus: "Lotted",
      startsAt: iso(-60 * 60_000),
      effectiveEndsAt: row.ends_at,
      highBidCents: row.current_bid_cents,
    },
    bidHistory: {
      kind: "anonymized-bidder-high-snapshots",
      isCompleteIncrementHistory: false,
      totalBids: 64,
      activeItemsCount: 1,
      extendedEndsAt: null,
      highestBidCents: row.current_bid_cents,
      bids: [],
    },
    currentBidCents: row.current_bid_cents,
    effectiveEndsAt: row.ends_at,
    ...overrides,
  };
}

function clock() {
  let current = START;
  const sleeps = [];
  return {
    now: () => new Date(current),
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      current += delayMs;
    },
    sleeps,
  };
}

function batchedStatements(database) {
  return database.operations
    .filter((operation) => operation.kind === "batch")
    .flatMap((operation) => operation.statements);
}

test("selects persisted active Fleet Internet auctions and derives their sale number", async () => {
  const database = new FakeD1([
    candidate(),
    candidate({
      id: "invalid-sale",
      external_id: "invalid-sale",
      sale_lot_number: "GSA Fleet / invalid-sale",
    }),
    candidate({ id: "invalid-vin", external_id: "invalid-vin", vin: "?" }),
  ]);
  const rows = await listGsaFleetClosingCandidates(database, new Date(START), 123);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sale_number, "3FDDCI26140");
  assert.equal(rows[0].vin, "1C6RR6FG9JS283922");
  const query = database.operations.find((operation) => operation.kind === "all");
  assert.match(query.sql, /source_key = 'gsa-fleet'/);
  assert.match(query.sql, /status IN \('active', 'closing'\)/);
  assert.match(query.sql, /JOIN vehicles v ON v\.auction_id = a\.id/);
  assert.match(query.sql, /a\.ends_at <= \?1/);
  assert.deepEqual(query.args, [iso(30 * 60_000), iso(0), 123]);
  assert.equal(saleNumberFromLot("  3fddci26140 / Run 244"), "3FDDCI26140");
  assert.equal(saleNumberFromLot("GSA Fleet / unknown"), null);
});

test("uses the Fleet VIN and sale number and collects every 15 seconds in the final minute", async () => {
  const row = candidate({ ends_at: iso(55_000), last_checked_at: iso(-16_000) });
  const database = new FakeD1([row]);
  const testClock = clock();
  const requests = [];
  let calls = 0;

  const summary = await runGsaFleetClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchActivity: async (vin, saleNumber, options) => {
      calls += 1;
      requests.push({ vin, saleNumber, now: options.now.toISOString(), forceRefresh: options.forceRefresh });
      return activity(row, options.now.toISOString(), {
        currentBidCents: row.current_bid_cents + calls * 100,
      });
    },
  });

  assert.equal(calls, 4);
  assert.deepEqual(summary.waitedOffsetsMs, [15_000, 30_000, 45_000]);
  assert.deepEqual(testClock.sleeps, [15_000, 15_000, 15_000]);
  assert.equal(summary.observationsAppended, 4);
  assert.equal(requests[0].vin, row.vin);
  assert.equal(requests[0].saleNumber, "3FDDCI26140");
  assert.equal(requests[0].forceRefresh, true);
});

test("stores Fleet bid changes without mislabeling total bids as distinct bidders", async () => {
  const row = candidate({ ends_at: iso(10 * 60_000), last_checked_at: iso(-6 * 60_000) });
  const database = new FakeD1([row]);

  const summary = await runGsaFleetClosingWindowRefresh(database, {
    now: () => new Date(START),
    sleep: async () => assert.fail("a ten-minute auction must not use sub-minute checkpoints"),
    fetchActivity: async (_vin, _saleNumber, options) => activity(
      row,
      options.now.toISOString(),
      { currentBidCents: row.current_bid_cents + 500 },
    ),
  });

  assert.equal(summary.observationsAppended, 1);
  const observation = batchedStatements(database).find((statement) =>
    statement.sql.includes("INSERT OR IGNORE INTO bid_observations"),
  );
  const update = batchedStatements(database).find((statement) =>
    statement.sql.includes("UPDATE auctions SET"),
  );
  assert.match(observation.sql, /bidder_count, status.*NULL, \?5/s);
  assert.doesNotMatch(update.sql, /bidder_count\s*=/);
  assert.equal(observation.args[3], row.current_bid_cents + 500);
});

test("preserves a Fleet extension and increments its observation counter", async () => {
  const row = candidate({ extension_count: 2 });
  const database = new FakeD1([row]);
  const extendedEnd = iso(6 * 60_000);

  const summary = await runGsaFleetClosingWindowRefresh(database, {
    now: () => new Date(START),
    sleep: async () => assert.fail("the extension leaves the sub-minute cadence"),
    fetchActivity: async (_vin, _saleNumber, options) => activity(
      row,
      options.now.toISOString(),
      { effectiveEndsAt: extendedEnd },
    ),
  });

  assert.equal(summary.observationsAppended, 1);
  const observation = batchedStatements(database).find((statement) =>
    statement.sql.includes("INSERT OR IGNORE INTO bid_observations"),
  );
  assert.equal(observation.args[5], extendedEnd);
  assert.equal(observation.args[6], 3);
});

test("stops on a terminal Fleet result but keeps its displayed high bid unverified", async () => {
  const row = candidate({ ends_at: iso(30_000), last_checked_at: iso(-16_000) });
  const database = new FakeD1([row]);
  const testClock = clock();

  const summary = await runGsaFleetClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchActivity: async (_vin, _saleNumber, options) => {
      const result = activity(row, options.now.toISOString());
      result.detail.saleStatus = "Closed";
      result.detail.vehicleSaleStatus = "Sold";
      result.detail.winningBidCents = row.current_bid_cents + 25_000;
      return result;
    },
  });

  assert.equal(summary.passes, 1);
  assert.deepEqual(testClock.sleeps, []);
  const sql = batchedStatements(database).map((statement) => statement.sql).join("\n");
  assert.match(sql, /'closed-high-bid-unverified'/);
  assert.doesNotMatch(sql, /INSERT INTO comparable_sales/);
  assert.doesNotMatch(sql, /awarded_price_cents/);
});

test("records Fleet gateway failures while allowing other bounded refreshes to finish", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => candidate({
    id: `gsa-fleet:fleet-active-${index}`,
    external_id: `fleet-active-${index}`,
    vin: `1C6RR6FG9JS2839${String(index).padStart(2, "0")}`,
    ends_at: iso(10 * 60_000),
    last_checked_at: iso(-6 * 60_000),
  }));
  const database = new FakeD1(rows);
  let active = 0;
  let maximumActive = 0;

  const summary = await runGsaFleetClosingWindowRefresh(database, {
    now: () => new Date(START),
    concurrency: 3,
    sleep: async () => assert.fail("the pass is outside the sub-minute cadence"),
    fetchActivity: async (vin, _saleNumber, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      if (vin === rows[0].vin) {
        throw new GsaFleetClientError("GSA_FLEET_HTTP_ERROR", "unavailable", {
          upstreamStatus: 503,
        });
      }
      const row = rows.find((value) => value.vin === vin);
      return activity(row, options.now.toISOString());
    },
  });

  assert.equal(maximumActive, 3);
  assert.equal(summary.succeeded, 6);
  assert.equal(summary.failed, 1);
  const failedCheck = database.operations.find(
    (operation) => operation.kind === "run" && operation.sql.includes("coverage_status = 'failed'"),
  );
  assert.equal(failedCheck.args[1], 503);
  assert.equal(failedCheck.args[3], "GSA_FLEET_HTTP_ERROR");
  assert.equal(GSA_FLEET_CLOSING_SOURCE_CHECK_SCOPE, "closing-window-bid");
});
