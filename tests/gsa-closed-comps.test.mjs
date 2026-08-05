import assert from "node:assert/strict";
import test from "node:test";

import { fetchClosedGsaVehicleComps } from "../lib/gsa-closed-comps.ts";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function row(overrides) {
  return {
    auctionId: 1001,
    lotId: 2001,
    lotNumber: 1,
    salesNumber: "TEST26001",
    status: "Closed",
    startDate: "2026-07-01T10:00:00",
    endDate: "2026-07-10T10:00:00",
    lotName: "2018 Ford F-250",
    currentBid: 12_345,
    numberOfBidders: 8,
    location: { city: "Dallas", state: "TX", zipCode: "75201" },
    ...overrides,
  };
}

function detail(make = "FORD MOTOR CO", model = "F250", mileage = "90000") {
  return {
    propertyLocation: { city: "Dallas", state: "TX", zipCode: "75201" },
    auctionDescriptionDTO: {
      make,
      model,
      odometer: mileage,
      bodyType: "Pickup",
      conditionCode: "U",
      itemDescription: `<ul><li>Model Year: 2018</li><li>Mileage: ${mileage}</li><li>VIN: 1FT7W2BT0JEC12345</li><li>Body Style: Pickup</li></ul>`,
    },
  };
}

test("fetches the complete date-bounded closed PPMS corpus and excludes terminated and no-bid rows", async () => {
  const catalogBodies = [];
  const calls = [];
  const fetchImpl = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    calls.push(url.toString());
    if (url.pathname.endsWith("/api/v1/auctions") && request.method === "POST") {
      catalogBodies.push(JSON.parse(await request.text()));
      const page = Number(url.searchParams.get("page"));
      return json({
        totalElements: 3,
        totalPages: 2,
        auctionDTOList: page === 1
          ? [
              row({ auctionId: 1001, lotId: 2001 }),
              row({ auctionId: 1002, lotId: 2002, status: "Terminated", currentBid: 9_000 }),
            ]
          : [row({ auctionId: 1003, lotId: 2003, currentBid: null, numberOfBidders: 0 })],
      });
    }
    const lotId = url.pathname.match(/\/preview\/auctions\/(\d+)$/)?.[1];
    if (lotId) return json(detail());
    return json({ error: "not found" }, 404);
  };

  const result = await fetchClosedGsaVehicleComps(fetchImpl, {
    now: new Date("2026-08-05T17:00:00.000Z"),
    from: new Date("2026-07-06T00:00:00.000Z"),
    to: new Date("2026-08-05T17:00:00.000Z"),
    pageSize: 2,
    detailConcurrency: 2,
  });

  assert.equal(catalogBodies.length, 2);
  assert.equal(catalogBodies[0].auctionStatus, "closed");
  assert.deepEqual(catalogBodies[0].categoryCodeList, ["300"]);
  assert.equal(catalogBodies[0].auctionEndDateFrom, "2026-07-06T00:00:00.000");
  assert.equal(catalogBodies[0].auctionEndDateTo, "2026-08-05T23:59:59.999");
  assert.ok(calls.some((url) => url.includes("page=2")));
  assert.equal(result.coverage.catalogRows, 3);
  assert.equal(result.coverage.closedRows, 2);
  assert.equal(result.coverage.excludedTerminated, 1);
  assert.equal(result.coverage.excludedNoBid, 1);
  assert.equal(result.coverage.detailSucceeded, 3);
  assert.equal(result.comparables.length, 1);
  assert.equal(result.comparables[0].closedHighBidCents, 1_234_500);
  assert.equal(result.comparables[0].mileage, 90_000);
  assert.equal(result.comparables[0].vin, "1FT7W2BT0JEC12345");
  assert.equal(result.comparables[0].sourceUrl, "https://gsaauctions.gov/auctions/preview/1001");
});
