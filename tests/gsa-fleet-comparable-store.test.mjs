import assert from "node:assert/strict";
import test from "node:test";

import { readDurableGsaFleetComparableIndex } from "../lib/gsa-fleet-comparable-store.ts";

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
