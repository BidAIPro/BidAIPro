import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDealBoardSnapshot,
  persistDealBoardSnapshot,
  readDealBoardSnapshot,
  readDealBoardSnapshotOpportunity,
  rebuildDealBoardSnapshot,
  reconcileDealBoardSnapshotBids,
} from "../lib/deal-board-snapshot.ts";
import { compactOpportunityForBoard } from "../lib/opportunity-presentation.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

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
    if (this.sql.includes("COUNT(*) AS chunk_count")) {
      return this.database.aggregateRow;
    }
    if (this.sql.includes("FROM deal_board_snapshot_chunks")) {
      return this.database.targetedChunk;
    }
    return null;
  }

  async all() {
    this.database.operations.push({ kind: "all", sql: this.sql, args: this.args });
    if (this.sql.includes("FROM deal_board_snapshots")) {
      return { success: true, results: this.database.snapshotRows, meta: {} };
    }
    if (this.sql.includes("active_count > 0")) {
      return { success: true, results: this.database.activeRows, meta: {} };
    }
    if (this.sql.includes("contains_gsa_auctions = 1")) {
      return { success: true, results: this.database.retainedRows, meta: {} };
    }
    return { success: true, results: [], meta: {} };
  }

  async run() {
    this.database.operations.push({ kind: "run", sql: this.sql, args: this.args });
    if (
      this.database.failFirstChunkWrite &&
      this.sql.includes("INSERT INTO deal_board_snapshot_chunks")
    ) {
      this.database.failFirstChunkWrite = false;
      throw new Error("simulated D1 chunk failure");
    }
    return { success: true, results: [], meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor({
    snapshotRow = null,
    boardRows = [],
    activeRows = [],
    auctionStates = [],
    bidObservations = [],
    targetedChunk = null,
    retainedRows = [],
    aggregateRow = { chunk_count: 1, item_count: 1 },
    failFirstChunkWrite = false,
    snapshotRows = null,
    boardRowsBySnapshot = null,
  } = {}) {
    this.snapshotRows = snapshotRows ?? (snapshotRow ? [snapshotRow] : []);
    this.boardRows = boardRows;
    this.boardRowsBySnapshot = boardRowsBySnapshot;
    this.activeRows = activeRows;
    this.auctionStates = auctionStates;
    this.bidObservations = bidObservations;
    this.targetedChunk = targetedChunk;
    this.retainedRows = retainedRows;
    this.aggregateRow = aggregateRow;
    this.failFirstChunkWrite = failFirstChunkWrite;
    this.operations = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.operations.push({ kind: "batch", statements });
    if (statements[0]?.sql.includes("FROM auctions")) {
      return statements.map((statement) => {
        const keys = new Set();
        for (let index = 0; index < statement.args.length; index += 2) {
          keys.add(`${statement.args[index]}|${statement.args[index + 1]}`);
        }
        return {
          success: true,
          results: this.auctionStates.filter((row) =>
            keys.has(`${row.source_key}|${row.external_id}`)
          ),
          meta: {},
        };
      });
    }
    if (statements[0]?.sql.includes("FROM bid_observations")) {
      return statements.map((statement) => ({
        success: true,
        results: this.bidObservations.filter((row) =>
          statement.args.includes(row.auction_id)
        ),
        meta: {},
      }));
    }
    if (statements[0]?.sql.includes("SELECT chunk_index, item_count, board_json")) {
      return statements.map((statement) => {
        const snapshotId = statement.args[0];
        const limit = statement.args[1];
        const offset = statement.args[2];
        const source = this.boardRowsBySnapshot?.[snapshotId] ?? this.boardRows;
        return {
          success: true,
          results: source.slice(offset, offset + limit),
          meta: {},
        };
      });
    }
    return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  }
}

function fleetRecord(overrides = {}) {
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
    highBidCents: 1_000_000,
    floorPriceCents: null,
    winningBidCents: null,
    saleProceedsCents: null,
    finalPriceCents: null,
    finalPriceBasis: "unavailable",
    isComparableOutcome: false,
    location: {
      vendorName: "Fleet auction vendor",
      city: "Conshohocken",
      state: "PA",
      postalCode: "19428",
    },
    vendorTimezone: "US/Eastern",
    images: ["https://example.test/truck.jpg"],
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fleetSnapshot(kind, rows) {
  return {
    source: "gsa-fleet",
    kind,
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

function gsaDiscovery() {
  return {
    auctions: [],
    coverage: {
      totalLots: 1,
      vehicleLots: 0,
      excludedLots: 1,
      withVin: 0,
      withMileage: 0,
      withBodyType: 0,
      withImage: 0,
      withCurrentBid: 0,
      statusCounts: { active: 0, preview: 0, scheduled: 0, unknown: 0 },
      exclusionCounts: { nonVehicle: 1 },
    },
    sourceHealth: {
      source: "GSA Auctions API",
      official: true,
      endpoint: "https://api.gsa.gov/example",
      sourceMode: "ppms-public-catalog",
      status: "live",
      cache: "refresh",
      credentialMode: "public-catalog",
      fetchedAt: NOW.toISOString(),
      observedAt: NOW.toISOString(),
      cachedUntil: "2026-08-05T19:00:00.000Z",
      staleSince: null,
      ageSeconds: 0,
      lastErrorCode: null,
      discoveryCadence: "hourly",
      limitations: [],
    },
  };
}

function storedOpportunity(overrides = {}) {
  return structuredClone({
    ...SEED_AUCTIONS[0],
    id: "snapshot-auction-1",
    externalId: "123456",
    status: "active",
    currentBidCents: 1_000_000,
    bidderCount: 4,
    endsAt: "2026-08-05T18:30:00.000Z",
    lastCheckedAt: "2026-08-05T17:00:00.000Z",
    valuation: {
      ...SEED_AUCTIONS[0].valuation,
      asOf: "2026-08-05T17:00:00.000Z",
    },
    forecast: {
      ...SEED_AUCTIONS[0].forecast,
      asOf: "2026-08-05T17:00:00.000Z",
      outcomeAnchors: [{
        id: "official-outcome-1",
        adjustedCloseCents: 2_000_000,
        matchScore: 0.9,
        weight: 1,
      }],
    },
    ...overrides,
  });
}

test("background build computes Fleet valuation, close forecast, and assessment", async () => {
  const active = fleetRecord();
  let closedOptions;
  const closed = [19_000, 20_000, 21_000].map((dollars, index) => fleetRecord({
    sourceId: `fleet-closed-${index}`,
    externalKey: `gsa-fleet:fleet-closed-${index}`,
    vin: `1C6RR6FG9JS28392${index}`,
    phase: "closed",
    outcome: "sold",
    saleStatus: "Closed",
    vehicleSaleStatus: "Sold",
    endsAt: `2026-07-0${index + 1}T19:00:00.000Z`,
    effectiveEndsAt: `2026-07-0${index + 1}T19:00:00.000Z`,
    highBidCents: dollars * 100,
    winningBidCents: dollars * 100,
    saleProceedsCents: dollars * 100,
    finalPriceCents: dollars * 100,
    finalPriceBasis: "winning-bid",
    isComparableOutcome: true,
    mileage: 25_000 + index * 1_000,
  }));

  const built = await buildDealBoardSnapshot({
    now: NOW,
    detailLimit: 0,
    getGsaAuctions: async () => gsaDiscovery(),
    getFleetActive: async () => fleetSnapshot("active-and-coming", [active]),
    getFleetClosed: async (options) => {
      closedOptions = options;
      return fleetSnapshot("closed-results", closed);
    },
  });

  assert.equal(built.opportunities.length, 1);
  const opportunity = built.opportunities[0];
  assert.equal(opportunity.source, "gsa-fleet");
  assert.equal(opportunity.valuation.status, "reference-only");
  // The subject VIN is excluded even when it appears as an older relist.
  assert.equal(opportunity.valuation.sampleSize, 2);
  assert.equal(opportunity.forecast.status, "reference-only");
  assert.ok(opportunity.forecast.expectedCents >= opportunity.currentBidCents);
  assert.equal(opportunity.assessment.calculatedAt, NOW.toISOString());
  assert.equal(built.expiresAt, "2026-08-05T19:00:00.000Z");
  assert.equal(closedOptions.pageSize, 5_000);
  assert.equal(closedOptions.maxRows, 25_000);
});

test("publishes only after all rows are durable and marks a failed partial generation", async () => {
  const opportunity = storedOpportunity();
  const built = {
    generatedAt: NOW.toISOString(),
    expiresAt: "2026-08-05T19:00:00.000Z",
    opportunities: [opportunity],
    metadata: { mode: "official", sourceHealth: { status: "live" } },
    gsaInventoryMode: "live",
  };
  const database = new FakeD1();
  const result = await persistDealBoardSnapshot(database, built);
  assert.equal(result.itemCount, 1);
  const operations = database.operations;
  const buildingIndex = operations.findIndex((operation) =>
    operation.kind === "run" && operation.sql.includes("'building'")
  );
  const rowIndex = operations.findIndex((operation) =>
    operation.kind === "run" && operation.sql.includes("deal_board_snapshot_chunks")
  );
  const aggregateIndex = operations.findIndex((operation) =>
    operation.kind === "first" && operation.sql.includes("COUNT(*) AS chunk_count")
  );
  const completeIndex = operations.findIndex((operation) =>
    operation.kind === "run" && operation.sql.includes("status = 'complete'")
  );
  assert.ok(
    buildingIndex >= 0 && rowIndex > buildingIndex &&
      aggregateIndex > rowIndex && completeIndex > aggregateIndex,
  );
  const row = operations[rowIndex];
  assert.ok(row.args.length <= 100);
  assert.match(row.args[8], /official-outcome-1/);
  assert.notEqual(JSON.parse(row.args[8])[0].vehicle.description, "");
  assert.equal(JSON.parse(row.args[9])[0].vehicle.description, "");

  const failed = new FakeD1({ failFirstChunkWrite: true });
  await assert.rejects(
    persistDealBoardSnapshot(failed, built),
    /simulated D1 chunk failure/,
  );
  const failureUpdate = failed.operations.find((operation) =>
    operation.kind === "run" && operation.sql.includes("status = 'failed'")
  );
  assert.ok(failureUpdate);
  assert.equal(
    failed.operations.some((operation) =>
      operation.kind === "run" && operation.sql.includes("status = 'complete'")
    ),
    false,
  );

  const mismatch = new FakeD1({
    aggregateRow: { chunk_count: 1, item_count: 0 },
  });
  await assert.rejects(
    persistDealBoardSnapshot(mismatch, built),
    (error) => error.code === "DEAL_BOARD_CHUNK_COUNT_MISMATCH",
  );
  assert.equal(
    mismatch.operations.some((operation) =>
      operation.kind === "run" && operation.sql.includes("status = 'complete'")
    ),
    false,
  );
});

test("serves the last complete generation after expiry with explicit stale semantics", async () => {
  const opportunity = storedOpportunity();
  const board = compactOpportunityForBoard(opportunity);
  const database = new FakeD1({
    snapshotRow: {
      id: "snapshot-1",
      generated_at: "2026-08-05T16:00:00.000Z",
      refreshed_at: "2026-08-05T17:45:00.000Z",
      expires_at: "2026-08-05T17:00:00.000Z",
      item_count: 1,
      metadata_json: JSON.stringify({
        mode: "official-gsa-auctions-and-fleet",
        sourceHealth: { status: "live" },
        snapshot: { imageExpiresAt: "2026-08-05T17:00:00.000Z" },
      }),
      opportunity_index_json: JSON.stringify({ [`id:${opportunity.id}`]: 0 }),
    },
    boardRows: [{
      chunk_index: 0,
      item_count: 1,
      board_json: JSON.stringify([board]),
    }],
  });

  const served = await readDealBoardSnapshot(database, NOW);
  assert.equal(served.stale, true);
  assert.equal(served.data.length, 1);
  assert.equal(served.meta.sourceHealth.status, "stale");
  assert.equal(served.meta.sourceHealth.cache, "stale-durable-snapshot");
  assert.equal(served.meta.snapshot.imagesFresh, false);
  assert.equal(served.meta.snapshot.refreshedAt, "2026-08-05T17:45:00.000Z");
});

test("minute reconciliation updates bid, time-based forecast, and assessment in cached rows", async () => {
  const opportunity = storedOpportunity();
  const database = new FakeD1({
    snapshotRow: {
      id: "snapshot-1",
      generated_at: "2026-08-05T17:00:00.000Z",
      refreshed_at: "2026-08-05T17:00:00.000Z",
      expires_at: "2026-08-05T19:00:00.000Z",
      item_count: 1,
      metadata_json: "{}",
      opportunity_index_json: JSON.stringify({ [`id:${opportunity.id}`]: 0 }),
    },
    activeRows: [{
      id: "snapshot-1:chunk:0",
      chunk_index: 0,
      item_count: 1,
      payload_count: 1,
      active_count: 1,
      contains_gsa_auctions: 1,
      contains_gsa_fleet: 0,
      payload_json: JSON.stringify([opportunity]),
      board_json: JSON.stringify([compactOpportunityForBoard(opportunity)]),
    }],
    auctionStates: [{
      id: "auction-db-1",
      source_key: "gsa-auctions",
      external_id: opportunity.externalId,
      status: "closing",
      current_bid_cents: 1_250_000,
      bidder_count: 7,
      ends_at: "2026-08-05T18:35:00.000Z",
      last_checked_at: "2026-08-05T17:05:00.000Z",
    }],
    bidObservations: [{
      auction_id: "auction-db-1",
      observed_at: "2026-08-05T16:55:00.000Z",
      current_bid_cents: 900_000,
      bidder_count: 3,
    }, {
      auction_id: "auction-db-1",
      observed_at: "2026-08-05T17:00:00.000Z",
      current_bid_cents: 1_000_000,
      bidder_count: 4,
    }],
  });

  const result = await reconcileDealBoardSnapshotBids(database, NOW);
  assert.equal(result.considered, 1);
  assert.equal(result.updated, 1);
  const stateBatch = database.operations.find((operation) =>
    operation.kind === "batch" && operation.statements[0]?.sql.includes("FROM auctions")
  );
  assert.ok(stateBatch.statements[0].args.length <= 100);
  assert.doesNotMatch(stateBatch.statements[0].sql, /source_key IN/);
  const updateBatch = database.operations.find((operation) =>
    operation.kind === "batch" &&
      operation.statements[0]?.sql.includes("INSERT INTO deal_board_snapshot_chunks")
  );
  assert.ok(updateBatch.statements.some((statement) =>
    statement.sql.includes("UPDATE deal_board_snapshots SET refreshed_at")
  ));
  const updated = JSON.parse(updateBatch.statements[0].args[8])[0];
  assert.equal(updated.status, "closing");
  assert.equal(updated.currentBidCents, 1_250_000);
  assert.equal(updated.endsAt, "2026-08-05T18:35:00.000Z");
  assert.equal(updated.forecast.asOf, "2026-08-05T17:05:00.000Z");
  assert.ok(updated.forecast.subjectObservationCount >= 2);
  assert.equal(updated.assessment.calculatedAt, "2026-08-05T17:05:00.000Z");
});

test("targeted detail reads one indexed chunk without loading the full board", async () => {
  const opportunity = storedOpportunity();
  const database = new FakeD1({
    snapshotRow: {
      id: "snapshot-1",
      generated_at: NOW.toISOString(),
      refreshed_at: NOW.toISOString(),
      expires_at: "2026-08-05T19:00:00.000Z",
      item_count: 1,
      metadata_json: JSON.stringify({ sourceHealth: { status: "live" } }),
      opportunity_index_json: JSON.stringify({ [`id:${opportunity.id}`]: 0 }),
    },
    targetedChunk: {
      payload_json: JSON.stringify([opportunity]),
      board_json: JSON.stringify([compactOpportunityForBoard(opportunity)]),
    },
  });

  const served = await readDealBoardSnapshotOpportunity(
    database,
    opportunity.id,
    NOW,
  );
  assert.equal(served.data[0].id, opportunity.id);
  assert.equal(
    database.operations.filter((operation) =>
      operation.kind === "first" && operation.sql.includes("deal_board_snapshot_chunks")
    ).length,
    1,
  );
  assert.equal(
    database.operations.some((operation) =>
      operation.kind === "batch" &&
      operation.statements[0]?.sql.includes("SELECT chunk_index, item_count, board_json")
    ),
    false,
  );
});

test("falls back to the retained previous complete generation when newest chunks are corrupt", async () => {
  const opportunity = storedOpportunity();
  const board = compactOpportunityForBoard(opportunity);
  const header = (id, generatedAt, chunkCount = undefined) => ({
    id,
    generated_at: generatedAt,
    refreshed_at: generatedAt,
    expires_at: "2026-08-05T19:00:00.000Z",
    item_count: 1,
    metadata_json: JSON.stringify({
      sourceHealth: { status: "live" },
      ...(chunkCount === undefined ? {} : { snapshot: { chunkCount } }),
    }),
    opportunity_index_json: "{}",
  });
  const database = new FakeD1({
    snapshotRows: [
      header("snapshot-new-corrupt", "2026-08-05T17:30:00.000Z", 2),
      header("snapshot-previous", "2026-08-05T17:00:00.000Z"),
    ],
    boardRowsBySnapshot: {
      "snapshot-new-corrupt": [{
        chunk_index: 0,
        item_count: 1,
        board_json: JSON.stringify([board]),
      }],
      "snapshot-previous": [{
        chunk_index: 0,
        item_count: 1,
        board_json: JSON.stringify([board]),
      }],
    },
  });

  const served = await readDealBoardSnapshot(database, NOW);
  assert.equal(served.snapshotId, "snapshot-previous");
  assert.equal(served.data.length, 1);
});

test("rejects a partial Fleet inventory even when the source labels it complete", async () => {
  const active = fleetSnapshot("active-and-coming", [fleetRecord()]);
  active.advertisedCount = 2;
  const closed = fleetSnapshot("closed-results", [fleetRecord({
    sourceId: "closed-1",
    phase: "closed",
    outcome: "sold",
    finalPriceCents: 2_000_000,
    isComparableOutcome: true,
  })]);
  await assert.rejects(
    buildDealBoardSnapshot({
      now: NOW,
      detailLimit: 0,
      getGsaAuctions: async () => gsaDiscovery(),
      getFleetActive: async () => active,
      getFleetClosed: async () => closed,
    }),
    (error) => error.code === "DEAL_BOARD_FLEET_INCOMPLETE",
  );
});

test("preserves upstream stale provenance and explicit retained-image freshness", async () => {
  const opportunity = storedOpportunity();
  const database = new FakeD1({
    snapshotRow: {
      id: "runner-backed",
      generated_at: "2026-08-05T17:30:00.000Z",
      refreshed_at: "2026-08-05T17:30:00.000Z",
      expires_at: "2026-08-05T19:00:00.000Z",
      item_count: 1,
      metadata_json: JSON.stringify({
        sourceHealth: {
          status: "stale",
          staleSince: "2026-08-04T18:30:00.000Z",
        },
        snapshot: { imageExpiresAt: null, imagesFresh: false },
      }),
      opportunity_index_json: "{}",
    },
    boardRows: [{
      chunk_index: 0,
      item_count: 1,
      board_json: JSON.stringify([compactOpportunityForBoard(opportunity)]),
    }],
  });

  const served = await readDealBoardSnapshot(database, NOW);
  assert.equal(served.stale, false);
  assert.equal(served.meta.sourceHealth.status, "stale");
  assert.equal(served.meta.sourceHealth.staleSince, "2026-08-04T18:30:00.000Z");
  assert.equal(served.meta.snapshot.imagesFresh, false);
});

test("does not republish retained GSA inventory observed more than 24 hours ago", async () => {
  const oldGsa = storedOpportunity({
    status: "preview",
    endsAt: null,
    lastCheckedAt: "2026-08-04T17:59:59.000Z",
  });
  const active = fleetRecord();
  const closed = fleetRecord({
    sourceId: "fleet-closed-retention",
    externalKey: "gsa-fleet:fleet-closed-retention",
    phase: "closed",
    outcome: "sold",
    saleStatus: "Closed",
    vehicleSaleStatus: "Sold",
    finalPriceCents: 2_000_000,
    winningBidCents: 2_000_000,
    saleProceedsCents: 2_000_000,
    finalPriceBasis: "winning-bid",
    isComparableOutcome: true,
  });
  const database = new FakeD1({
    snapshotRow: {
      id: "previous",
      generated_at: "2026-08-04T17:59:59.000Z",
      refreshed_at: "2026-08-04T17:59:59.000Z",
      expires_at: "2026-08-04T19:00:00.000Z",
      item_count: 1,
      metadata_json: "{}",
      opportunity_index_json: "{}",
    },
    retainedRows: [{ payload_json: JSON.stringify([oldGsa]) }],
  });

  await rebuildDealBoardSnapshot(database, {
    now: NOW,
    detailLimit: 0,
    getGsaAuctions: async () => {
      throw new Error("direct unavailable");
    },
    getGsaRunnerSnapshot: async () => {
      throw new Error("runner unavailable");
    },
    getFleetActive: async () => fleetSnapshot("active-and-coming", [active]),
    getFleetClosed: async () => fleetSnapshot("closed-results", [closed]),
  });
  const written = database.operations.find((operation) =>
    operation.kind === "run" && operation.sql.includes("deal_board_snapshot_chunks")
  );
  assert.doesNotMatch(written.args[9], new RegExp(oldGsa.id));
});
