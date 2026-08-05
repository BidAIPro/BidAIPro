import assert from "node:assert/strict";
import test from "node:test";

import {
  readDurableGsaFleetComparableIndex,
  resolveGsaFleetComparableIndex,
} from "../lib/gsa-fleet-comparable-store.ts";

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
    this.database.operations.push({ sql: this.sql, args: this.args });
    return { success: true, results: this.database.rows, meta: {} };
  }
}

test("loads only compact authoritative Fleet awards into the durable comp index", async () => {
  const database = {
    rows: [{
      external_id: "fleet-award-1",
      canonical_url: "https://marketplace.gsafleet.gov/sales/vehicle-details/VIN1",
      vin: "1C6RR6FG9JS283922",
      year: 2018,
      make: "RAM",
      model: "RAM 1500",
      mileage: 25_234,
      condition: "usable",
      operability: "unknown",
      city: "Conshohocken",
      state: "PA",
      awarded_price_cents: 2_100_000,
      ended_at: "2026-08-01T18:00:00.000Z",
      outcome_observed_at: "2026-08-02T01:00:00.000Z",
    }],
    operations: [],
    prepare(sql) {
      return new FakeStatement(this, sql);
    },
  };

  const result = await readDurableGsaFleetComparableIndex(database);
  assert.equal(result.rowCount, 1);
  assert.equal(result.observedAt, "2026-08-02T01:00:00.000Z");
  assert.equal(result.index.all[0].closedHighBidCents, 2_100_000);
  assert.equal(result.index.all[0].condition, "usable");
  assert.match(
    database.operations[0].sql,
    /outcome_status = 'awarded-price-official-gsa-fleet'/,
  );
  assert.match(database.operations[0].sql, /ended_at < \?1/);
  assert.deepEqual(database.operations[0].args, [null, null, 5_000]);
});

test("uses a bounded recent official fallback while a new D1 corpus is warming", async () => {
  const database = {
    rows: [],
    operations: [],
    prepare(sql) {
      return new FakeStatement(this, sql);
    },
  };
  let fetchOptions;
  const result = await resolveGsaFleetComparableIndex(database, {
    now: new Date("2026-08-05T18:00:00.000Z"),
    getFleetClosed: async (options) => {
      fetchOptions = options;
      return {
        source: "gsa-fleet",
        kind: "closed-results",
        endpoint: "https://api.shared-public.gsafleet.gov/graphql/shared-public-gateway",
        sourceUrl: "https://marketplace.gsafleet.gov/sales/browse-vehicles",
        observedAt: "2026-08-05T18:00:00.000Z",
        advertisedCount: 1,
        complete: true,
        cache: "refresh",
        limitations: [],
        rows: [{
          source: "gsa-fleet",
          sourceId: "fleet-k3500-award",
          externalKey: "gsa-fleet:fleet-k3500-award",
          sourceUrl: "https://marketplace.gsafleet.gov/sales/vehicle-details/1GC4KZCG0HF100001",
          vin: "1GC4KZCG0HF100001",
          saleNumber: "4ZFBPC26351",
          saleRunNumber: "1",
          year: 2017,
          make: "CHEVROLET",
          model: "K3500",
          mileage: 31_000,
          vehicleType: "Pickup Trucks (4x4)",
          fuelType: "Gasoline - Dedicated",
          conditionCode: "4",
          saleType: "Live",
          saleStatus: "Sale Complete",
          vehicleSaleStatus: "Awarded",
          channel: "live",
          phase: "closed",
          outcome: "awarded",
          startsAt: "2026-08-01T18:00:00.000Z",
          endsAt: "2026-08-01T18:00:00.000Z",
          extendedEndsAt: null,
          effectiveEndsAt: "2026-08-01T18:00:00.000Z",
          highBidCents: null,
          floorPriceCents: null,
          winningBidCents: null,
          saleProceedsCents: 3_500_000,
          finalPriceCents: 3_500_000,
          finalPriceBasis: "sale-proceeds",
          isComparableOutcome: true,
          location: { vendorName: "Fleet vendor", city: "Dallas", state: "TX", postalCode: null },
          vendorTimezone: "US/Central",
          images: [],
          observedAt: "2026-08-05T18:00:00.000Z",
        }],
      };
    },
  });

  assert.equal(result.mode, "recent-official-fallback");
  assert.equal(result.rowCount, 1);
  assert.equal(result.index.all[0].modelLabel, "K3500");
  assert.equal(fetchOptions.since.toISOString(), "2026-07-29T18:00:00.000Z");
  assert.equal(fetchOptions.maxRows, 25_000);
});
