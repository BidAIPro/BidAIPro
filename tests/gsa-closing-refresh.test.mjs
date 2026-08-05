import assert from "node:assert/strict";
import test from "node:test";

import {
  listClosingAuctionCandidates,
  runClosingWindowRefresh,
  SOURCE_CHECK_SCOPE,
} from "../lib/gsa-closing-refresh.ts";
import { PpmsLiveBidError } from "../lib/gsa-ppms-live-bid.ts";

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
    return statements.map((statement) => ({
      results: [],
      success: true,
      meta: { changes: statement.sql.includes("INSERT OR IGNORE INTO bid_observations") ? 1 : 1 },
    }));
  }
}

const START = Date.parse("2026-08-05T21:00:00.000Z");

function iso(offsetMs) {
  return new Date(START + offsetMs).toISOString();
}

function candidate(overrides = {}) {
  return {
    id: "gsa:auction:372696",
    external_id: "372696",
    status: "active",
    current_bid_cents: 250_000,
    bidder_count: 2,
    ends_at: iso(10 * 60_000),
    last_checked_at: iso(-6 * 60_000),
    extension_count: 0,
    ...overrides,
  };
}

function unchangedSnapshot(row, checkedAt) {
  return {
    externalId: row.external_id,
    currentBidCents: row.current_bid_cents,
    bidderCount: row.bidder_count,
    status: row.status,
    endsAt: row.ends_at,
    lastCheckedAt: checkedAt,
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

test("selects numeric nonterminal auctions through the next 30 minutes and post-close", async () => {
  const database = new FakeD1([
    candidate(),
    candidate({ id: "bad", external_id: "not-ppms" }),
  ]);
  const rows = await listClosingAuctionCandidates(database, new Date(START), 123);

  assert.deepEqual(rows.map((row) => row.external_id), ["372696"]);
  const query = database.operations.find((operation) => operation.kind === "all");
  assert.match(query.sql, /status IN \('preview', 'active', 'closing'\)/);
  assert.match(query.sql, /a\.ends_at <= \?1/);
  assert.match(query.sql, /external_id GLOB '\[1-9\]\*'/);
  assert.deepEqual(query.args, [iso(30 * 60_000), iso(0), 123]);
});

test("does one extra pass at 30 seconds for a due auction inside five minutes", async () => {
  const row = candidate({
    ends_at: iso(4 * 60_000),
    last_checked_at: iso(-31_000),
  });
  const database = new FakeD1([row]);
  const testClock = clock();
  let calls = 0;

  const summary = await runClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchLiveBid: async (_id, options) => {
      calls += 1;
      return {
        ...unchangedSnapshot(row, options.now().toISOString()),
        currentBidCents: row.current_bid_cents + calls * 100,
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(summary.passes, 2);
  assert.deepEqual(summary.waitedOffsetsMs, [30_000]);
  assert.deepEqual(testClock.sleeps, [30_000]);
  assert.equal(summary.observationsAppended, 2);
});

test("collects at 15, 30, and 45 seconds during the final minute", async () => {
  const row = candidate({
    ends_at: iso(55_000),
    last_checked_at: iso(-16_000),
  });
  const database = new FakeD1([row]);
  const testClock = clock();
  let calls = 0;

  const summary = await runClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchLiveBid: async (_id, options) => {
      calls += 1;
      return {
        ...unchangedSnapshot(row, options.now().toISOString()),
        bidderCount: row.bidder_count + calls,
      };
    },
  });

  assert.equal(calls, 4);
  assert.equal(summary.passes, 4);
  assert.deepEqual(summary.waitedOffsetsMs, [15_000, 30_000, 45_000]);
  assert.deepEqual(testClock.sleeps, [15_000, 15_000, 15_000]);
});

test("does not wait after PPMS confirms a terminal result and stores only an unverified high bid", async () => {
  const row = candidate({
    ends_at: iso(30_000),
    last_checked_at: iso(-16_000),
  });
  const database = new FakeD1([row]);
  const testClock = clock();

  const summary = await runClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchLiveBid: async (_id, options) => ({
      ...unchangedSnapshot(row, options.now().toISOString()),
      status: "ended",
    }),
  });

  assert.equal(summary.passes, 1);
  assert.deepEqual(testClock.sleeps, []);
  const sql = batchedStatements(database).map((statement) => statement.sql).join("\n");
  assert.match(sql, /final_status = CASE/);
  assert.match(sql, /'closed-high-bid-unverified'/);
  assert.match(sql, /INSERT INTO comparable_sales/);
  assert.match(sql, /awarded_price_cents = NULL/);
  assert.match(sql, /award_status = 'unknown'/);
  assert.doesNotMatch(sql, /awarded_price_cents\s*=\s*(?:excluded|\?|\d)/);
});

test("schedules the remaining urgent checkpoints even when second-zero is not yet due", async () => {
  const row = candidate({
    ends_at: iso(55_000),
    last_checked_at: iso(-5_000),
  });
  const database = new FakeD1([row]);
  const testClock = clock();
  let calls = 0;

  const summary = await runClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchLiveBid: async (_id, options) => {
      calls += 1;
      return unchangedSnapshot(row, options.now().toISOString());
    },
  });

  assert.equal(summary.due, 3);
  assert.equal(calls, 3);
  assert.deepEqual(summary.waitedOffsetsMs, [15_000, 30_000, 45_000]);
  assert.deepEqual(testClock.sleeps, [15_000, 15_000, 15_000]);
});

test("persists an extended end time and increments the observation extension count", async () => {
  const row = candidate({
    ends_at: iso(4 * 60_000),
    last_checked_at: iso(-31_000),
    extension_count: 2,
  });
  const database = new FakeD1([row]);
  const testClock = clock();

  const summary = await runClosingWindowRefresh(database, {
    now: testClock.now,
    sleep: testClock.sleep,
    fetchLiveBid: async (_id, options) => ({
      ...unchangedSnapshot(row, options.now().toISOString()),
      endsAt: iso(6 * 60_000),
    }),
  });

  assert.equal(summary.observationsAppended, 1);
  assert.deepEqual(testClock.sleeps, []);
  const observation = batchedStatements(database).find((statement) =>
    statement.sql.includes("INSERT OR IGNORE INTO bid_observations"),
  );
  const auctionUpdate = batchedStatements(database).find((statement) =>
    statement.sql.includes("UPDATE auctions SET"),
  );
  assert.equal(observation.args[6], iso(6 * 60_000));
  assert.equal(observation.args[7], 3);
  assert.match(observation.sql, /\?3 > a\.last_checked_at/);
  assert.match(auctionUpdate.sql, /\?7 > last_checked_at/);
});

test("updates freshness telemetry without appending an unchanged observation", async () => {
  const row = candidate();
  const database = new FakeD1([row]);

  const summary = await runClosingWindowRefresh(database, {
    now: () => new Date(START),
    sleep: async () => assert.fail("a ten-minute auction must not use a sub-minute wait"),
    fetchLiveBid: async (_id, options) => unchangedSnapshot(row, options.now().toISOString()),
  });

  assert.equal(summary.succeeded, 1);
  assert.equal(summary.observationsAppended, 0);
  const allStatements = [
    ...database.operations.filter((operation) => operation.kind === "run"),
    ...batchedStatements(database),
  ];
  assert.equal(
    allStatements.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO bid_observations")),
    false,
  );
  assert.equal(
    allStatements.some((statement) => statement.sql.includes("coverage_status = 'complete'")),
    true,
  );
  assert.equal(SOURCE_CHECK_SCOPE, "closing-window-bid");
});

test("records a failed source check and continues other bounded refreshes", async () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    candidate({
      id: `gsa:auction:${372696 + index}`,
      external_id: String(372696 + index),
    }),
  );
  const database = new FakeD1(rows);
  let active = 0;
  let maximumActive = 0;

  const summary = await runClosingWindowRefresh(database, {
    now: () => new Date(START),
    concurrency: 3,
    sleep: async () => assert.fail("non-urgent refreshes must not wait"),
    fetchLiveBid: async (id, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      if (id === rows[0].external_id) {
        throw new PpmsLiveBidError("GSA_PPMS_LIVE_HTTP_ERROR", "upstream unavailable", {
          upstreamStatus: 503,
        });
      }
      const row = rows.find((value) => value.external_id === id);
      return unchangedSnapshot(row, options.now().toISOString());
    },
  });

  assert.equal(maximumActive, 3);
  assert.equal(summary.succeeded, 8);
  assert.equal(summary.failed, 1);
  const failedCheck = database.operations.find(
    (operation) => operation.kind === "run" && operation.sql.includes("coverage_status = 'failed'"),
  );
  assert.equal(failedCheck.args[1], 503);
  assert.equal(failedCheck.args[3], "GSA_PPMS_LIVE_HTTP_ERROR");
});
