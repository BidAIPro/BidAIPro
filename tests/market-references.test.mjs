import assert from "node:assert/strict";
import test from "node:test";
import { freeMarketReferences } from "../lib/market-references.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

test("builds lawful free research links without treating them as imported values", () => {
  const auction = SEED_AUCTIONS[0];
  const references = freeMarketReferences(auction);
  const ids = references.map((reference) => reference.id);

  assert.deepEqual(ids, ["carfax", "kbb", "edmunds", "jd-power", "cars", "ebay-sold"]);
  assert.equal(references[0].url, "https://www.carfax.com/value/");
  assert.match(references[0].coverageNote, new RegExp(auction.vehicle.vin));

  const cars = new URL(references.find((reference) => reference.id === "cars").url);
  assert.equal(cars.hostname, "www.cars.com");
  assert.equal(cars.searchParams.get("year_min"), String(auction.vehicle.year));
  assert.equal(cars.searchParams.get("makes[]"), "dodge");

  const sold = new URL(references.find((reference) => reference.id === "ebay-sold").url);
  assert.equal(sold.hostname, "www.ebay.com");
  assert.equal(sold.searchParams.get("LH_Complete"), "1");
  assert.equal(sold.searchParams.get("LH_Sold"), "1");
  assert.match(sold.searchParams.get("_nkw"), /2018 Dodge Durango SXT/i);

  const serialized = JSON.stringify(references);
  assert.equal(serialized.includes(String(auction.currentBidCents)), false);
  assert.equal(auction.valuation.status, "reference-only");
});

test("omits the VIN-specific CARFAX workflow when GSA did not capture a valid VIN", () => {
  const auction = {
    ...SEED_AUCTIONS[0],
    vehicle: { ...SEED_AUCTIONS[0].vehicle, vin: undefined },
  };
  const references = freeMarketReferences(auction);

  assert.equal(references.some((reference) => reference.id === "carfax"), false);
  assert.equal(references.some((reference) => reference.id === "ebay-sold"), true);
  assert.equal(references.some((reference) => reference.id === "cars"), true);
});

test("never invents location or vehicle identity for incomplete listings", () => {
  const auction = {
    ...SEED_AUCTIONS[0],
    location: { ...SEED_AUCTIONS[0].location, postalCode: "" },
    vehicle: {
      ...SEED_AUCTIONS[0].vehicle,
      year: Number.NaN,
      make: "Make pending",
      model: "Model pending",
    },
  };
  const references = freeMarketReferences(auction);
  const serialized = JSON.stringify(references);
  const cars = new URL(references.find((reference) => reference.id === "cars").url);
  const jdPower = new URL(references.find((reference) => reference.id === "jd-power").url);

  assert.equal(serialized.includes("30301"), false);
  assert.equal(serialized.includes("NaN"), false);
  assert.equal(cars.pathname, "/shopping/");
  assert.equal(cars.search, "");
  assert.equal(jdPower.pathname, "/cars");
  assert.match(references.find((reference) => reference.id === "cars").coverageNote, /no filters were invented/i);
});
