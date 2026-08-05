import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCarMaxValuation,
  buildD1GsaComparableValuation,
  carMaxValueUrls,
  listingConditionAdjustment,
  normalizeMarketCondition,
  parseCarMaxNextData,
  parseCarMaxReaderText,
  parseNhtsaVinResponse,
  resolveMarketValuationBatch,
} from "../lib/market-valuation.ts";
import { getGsaMarketValuationSnapshot } from "../lib/gsa-market-valuation-snapshot.ts";
import { applyValuationToOpportunity } from "../lib/opportunity-adapter.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

const nextData = {
  props: {
    pageProps: {
      appraisalData: {
        percentileLow: 10_000,
        percentileHigh: 20_000,
        offerData: [
          { mileage: 10_000, offer: 20_000, created: "2026-08-03", trimDisplay: "XL" },
          { mileage: 50_000, offer: 16_000, created: "2026-08-04", trimDisplay: "XL" },
          { mileage: 100_000, offer: 12_000, created: "2026-08-05", trimDisplay: "XL" },
        ],
      },
    },
  },
};

const coveredExternalId = getGsaMarketValuationSnapshot().valuations.find(
  (valuation) => valuation.status === "available",
)?.externalId;

function vehicleRow(externalId = coveredExternalId) {
  return {
    auction_id: `auction-${externalId}`,
    vehicle_id: `vehicle-${externalId}`,
    external_id: externalId,
    normalized_vehicle_key: "2016|ford|f-250",
    year: 2016,
    make: "Ford",
    model: "F-250",
    trim: "XL",
    series: null,
    vin: null,
    mileage: 100_000,
    condition: "good",
    operability: "runs-and-drives",
    damage_flags_json: "[]",
    feature_flags_json: "[]",
    postal_code: "60601",
  };
}

function cachedValuationRow() {
  return {
    provider: "Cached licensed market value",
    provider_kind: "licensed-provider",
    status: "provider",
    valuation_type: "trade-in",
    input_mileage: 100_000,
    low_cents: 1_500_000,
    median_cents: 1_700_000,
    high_cents: 1_900_000,
    raw_low_cents: 1_500_000,
    raw_median_cents: 1_700_000,
    raw_high_cents: 1_900_000,
    comparable_median_mileage: 100_000,
    mileage_adjustment_cents: 0,
    condition_adjustment_cents: 0,
    condition_adjustment_bps: 0,
    condition_basis: "cached test evidence",
    match_basis: "cached exact match",
    confidence_bps: 8500,
    sample_size: 20,
    as_of: "2026-08-05T00:00:00.000Z",
    source_url: "https://example.com/value",
    provenance_note: "A valid unexpired cached provider value.",
  };
}

function fakeD1(handler) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: () => handler("first", sql, args),
            all: () => handler("all", sql, args),
            run: () => handler("run", sql, args),
          };
        },
      };
    },
  };
}

test("parses CarMax __NEXT_DATA__ ranges and recent mileage/offer samples", () => {
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;
  const parsed = parseCarMaxNextData(html);

  assert.ok(parsed);
  assert.equal(parsed.rawLowCents, 1_000_000);
  assert.equal(parsed.rawHighCents, 2_000_000);
  assert.equal(parsed.offers.length, 3);
  assert.deepEqual(parsed.offers[2], {
    mileage: 100_000,
    offerCents: 1_200_000,
    observedAt: "2026-08-05",
    trim: "XL",
  });
});

test("strictly parses CarMax Reader text only when provenance and range are clear", () => {
  const parsed = parseCarMaxReaderText(`
    2016 Ford F250 value ranges from $9,400 - $20,000.
    Values are based on a sample of real CarMax offers over the last 45 days.
    55K miles | $13,000
    72,736 miles | $14,000
    108K miles | $20,000
  `);

  assert.ok(parsed);
  assert.equal(parsed.rawLowCents, 940_000);
  assert.equal(parsed.rawHighCents, 2_000_000);
  assert.equal(parsed.offers.length, 3);
  assert.equal(
    parseCarMaxReaderText("A random price range is $9,400 - $20,000."),
    null,
  );
});

test("shows raw provider range separately from mileage and GSA-condition adjustments", () => {
  const sample = parseCarMaxNextData(JSON.stringify(nextData));
  assert.ok(sample);
  const valuation = buildCarMaxValuation(
    sample,
    {
      mileage: 100_000,
      trim: "XL",
      condition: "repairable",
      operability: "non-operational",
      damageFlags: ["body damage"],
      issueFlags: ["warning light"],
    },
    {
      sourceUrl: "https://www.carmax.com/value/ford/f250/2016",
      matchBasis: "vin-decoded-year-make-model",
      asOf: "2026-08-05T00:00:00.000Z",
    },
  );

  assert.equal(valuation.status, "reference-only");
  assert.equal(valuation.evidence.rawLowCents, 1_000_000);
  assert.equal(valuation.evidence.rawMedianCents, 1_600_000);
  assert.equal(valuation.evidence.mileageAdjustmentCents, -400_000);
  assert.equal(valuation.evidence.conditionAdjustmentPct, -0.435);
  assert.equal(valuation.evidence.conditionAdjustmentCents, -522_000);
  assert.equal(valuation.medianCents, 678_000);
  assert.match(valuation.provenanceNote, /GSA's condition, operability, damage, and issue/i);
});

test("caps listing deductions and explains exactly which disclosed facts affected value", () => {
  const adjustment = listingConditionAdjustment({
    condition: "salvage",
    operability: "non-operational",
    damageFlags: ["collision", "glass", "body", "frame", "paint"],
    issueFlags: ["engine", "transmission", "recall", "brakes", "battery"],
  });
  assert.equal(adjustment.pct, -0.45);
  assert.match(adjustment.basis, /capped at 45%/i);
  assert.match(adjustment.basis, /4 disclosed damage flags/i);
});

test("maps stored GSA condition vocabulary into the market adjustment model", () => {
  assert.equal(normalizeMarketCondition("usable"), "good");
  assert.equal(normalizeMarketCondition("new"), "good");
  assert.equal(normalizeMarketCondition("scrap"), "salvage");
  assert.equal(normalizeMarketCondition("repairable"), "repairable");
});

test("uses a valid NHTSA VIN decode and normalizes CarMax model URLs", () => {
  const fallback = {
    year: 2016,
    make: "Ford",
    model: "F-250 Pickup 4X4 Crew Cab",
    trim: null,
    series: null,
    bodyClass: null,
    matchBasis: "gsa-year-make-model",
  };
  const decoded = parseNhtsaVinResponse({
    Results: [{ ModelYear: "2016", Make: "FORD", Model: "F-250", Trim: "XL" }],
  }, fallback);

  assert.equal(decoded.matchBasis, "vin-decoded-year-make-model");
  assert.equal(
    carMaxValueUrls(decoded)[0],
    "https://www.carmax.com/value/ford/f250/2016",
  );
});

test("applying a numeric valuation recomputes the opportunity ceiling", () => {
  const opportunity = SEED_AUCTIONS[0];
  const valuation = {
    ...opportunity.valuation,
    status: "reference-only",
    provider: "Observed GSA auction comps",
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: 1_800_000,
    medianCents: 2_000_000,
    highCents: 2_200_000,
    asOf: "2026-08-05T00:00:00.000Z",
    sampleSize: 12,
    confidence: 0.72,
  };
  const updated = applyValuationToOpportunity(opportunity, valuation);

  assert.equal(updated.valuation.provider, "Observed GSA auction comps");
  assert.notEqual(updated.assessment.safeMaxBidCents, null);
  assert.equal(updated.assessment.conservativeValueCents, 1_800_000);
});

test("D1 closed comps use terminal evidence and prefer the nearest reported mileage", () => {
  const row = vehicleRow("subject-500");
  const vehicle = {
    auctionId: row.auction_id,
    vehicleId: row.vehicle_id,
    externalId: row.external_id,
    normalizedVehicleKey: row.normalized_vehicle_key,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    series: row.series,
    vin: row.vin,
    mileage: row.mileage,
    condition: row.condition,
    operability: row.operability,
    damageFlags: ["body damage"],
    issueFlags: [],
    postalCode: row.postal_code,
  };
  const identity = {
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    series: vehicle.series,
    bodyClass: null,
    matchBasis: "gsa-year-make-model",
  };
  const rows = [
    {
      external_id: "far-new",
      canonical_url: "https://gsaauctions.gov/auctions/preview/far-new",
      mileage: 220_000,
      closed_high_bid_cents: 900_000,
      ended_at: "2026-08-05T11:00:00.000Z",
    },
    {
      external_id: "nearest",
      canonical_url: "https://gsaauctions.gov/auctions/preview/nearest",
      mileage: 103_000,
      closed_high_bid_cents: 1_200_000,
      ended_at: "2026-08-04T11:00:00.000Z",
    },
    {
      external_id: "middle",
      canonical_url: "https://gsaauctions.gov/auctions/preview/middle",
      mileage: 140_000,
      closed_high_bid_cents: 1_050_000,
      ended_at: "2026-08-03T11:00:00.000Z",
    },
  ];

  const lowBid = buildD1GsaComparableValuation(
    { ...vehicle, currentBidCents: 1 },
    identity,
    rows,
    "2026-08-05T12:00:00.000Z",
  );
  const highBid = buildD1GsaComparableValuation(
    { ...vehicle, currentBidCents: 99_000_000 },
    identity,
    rows,
    "2026-08-05T12:00:00.000Z",
  );

  assert.deepEqual(lowBid, highBid);
  assert.equal(lowBid.sourceUrl, rows[1].canonical_url);
  assert.notEqual(lowBid.evidence.mileageAdjustmentCents, null);
  assert.ok(lowBid.evidence.conditionAdjustmentCents < 0);
  assert.equal(lowBid.evidence.conditionAdjustmentPct, -0.025);
  assert.match(lowBid.evidence.matchBasis, /official terminal closed-high-bid only/i);
  assert.match(lowBid.provenanceNote, /closest available mileage is shown first/i);
  assert.doesNotMatch(JSON.stringify(lowBid), /currentBid/i);
});

test("serves bundled values per ID when D1 is unavailable without calling external providers", async () => {
  assert.ok(coveredExternalId);
  let fetchCalls = 0;
  const database = {
    prepare() {
      throw new Error("D1 binding unavailable");
    },
  };

  const result = await resolveMarketValuationBatch(
    database,
    [coveredExternalId, "definitely-not-in-the-bundled-snapshot"],
    {
      now: new Date("2026-08-05T12:00:00.000Z"),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("external fetch should not run");
      },
    },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.meta.requested, 2);
  assert.equal(result.meta.resolved, 1);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].externalId, coveredExternalId);
  assert.equal(result.data[0].valuation.provider, "Official GSA closed-high-bid comps");
  assert.ok(result.data[0].valuation.medianCents > 0);
  assert.deepEqual(result.errors, [{
    externalId: "definitely-not-in-the-bundled-snapshot",
    code: "MARKET_VALUATION_DATABASE_UNAVAILABLE",
  }]);
});

test("uses the bundled value when the new D1 cache columns are not migrated", async () => {
  assert.ok(coveredExternalId);
  let fetchCalls = 0;
  const database = fakeD1((operation, sql) => {
    if (operation === "first" && sql.includes("FROM auctions a")) {
      return vehicleRow();
    }
    if (operation === "first" && sql.includes("FROM valuations")) {
      throw new Error("no such column: raw_low_cents");
    }
    throw new Error(`Unexpected database operation: ${operation}`);
  });

  const result = await resolveMarketValuationBatch(database, [coveredExternalId], {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("external fetch should not run");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.data[0].valuation.provider, "Official GSA closed-high-bid comps");
  assert.equal(result.errors, undefined);
});

test("keeps a valid D1 cache ahead of the bundled snapshot", async () => {
  assert.ok(coveredExternalId);
  let fetchCalls = 0;
  const database = fakeD1((operation, sql) => {
    if (operation === "first" && sql.includes("FROM auctions a")) return vehicleRow();
    if (operation === "first" && sql.includes("FROM valuations")) return cachedValuationRow();
    throw new Error(`Unexpected database operation: ${operation}`);
  });

  const result = await resolveMarketValuationBatch(database, [coveredExternalId], {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("external fetch should not run");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.data[0].valuation.provider, "Cached licensed market value");
  assert.equal(result.data[0].valuation.medianCents, 1_700_000);
  assert.equal(result.data[0].cacheStatus, "fresh");
});

test("returns an uncovered CarMax value even when its D1 cache write fails", async () => {
  const externalId = "integration-uncovered-carmax";
  let fetchCalls = 0;
  const database = fakeD1((operation, sql) => {
    if (operation === "first" && sql.includes("FROM auctions a")) {
      return vehicleRow(externalId);
    }
    if (operation === "first" && sql.includes("FROM valuations")) return null;
    if (operation === "run" && sql.includes("INSERT INTO valuations")) {
      throw new Error("no such column: raw_low_cents");
    }
    throw new Error(`Unexpected database operation: ${operation}`);
  });
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;

  const result = await resolveMarketValuationBatch(database, [externalId], {
    now: new Date("2026-08-05T12:00:00.000Z"),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(html, { status: 200 });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.meta.refreshed, 1);
  assert.equal(result.meta.resolved, 1);
  assert.equal(result.data[0].valuation.provider, "CarMax recent offers");
  assert.ok(result.data[0].valuation.medianCents > 0);
  assert.equal(result.errors, undefined);
});
