import assert from "node:assert/strict";
import test from "node:test";

import {
  GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT,
  enrichGsaFleetVehicleDetails,
  fetchGsaFleetActiveListings,
  fetchGsaFleetClosedResults,
  fetchGsaFleetVehicleActivity,
  normalizeGsaFleetImageUrl,
} from "../lib/gsa-fleet-client.ts";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listingRow(overrides = {}) {
  return {
    id: "id-active",
    makeName: "RAM",
    modelName: "RAM 1500",
    modelYear: 2018,
    vin: "1C6RR6FG9JS283922",
    vehicleMiles: 25234,
    vehicleType: "Pickup Trucks (4x2)",
    vehicleCondition: "4",
    vendorName: "Carriage Trade Public Auto Auction",
    vendorCity: "Conshohocken",
    vendorState: "PA",
    saleType: "Internet",
    saleStatus: "Active",
    vehicleSaleStatus: "Lotted",
    saleStartDate: "2026-08-05T17:00:00.000Z",
    saleEndDate: "2026-08-05T19:00:00.000Z",
    extendedSaleEndDate: null,
    saleNumber: "3FDDCI26140",
    saleRunNumber: "244",
    photoUrl: "http://media.ext.edgeapps.net/example/truck.jpg",
    photoUrlLarge: "http://media.ext.edgeapps.net/example/truck.jpg",
    fuelType: "Gasoline - Dedicated",
    vendorTimezone: "US/Eastern",
    highBid: "13725.00",
    floorPrice: "11000.00",
    winningBidAmt: null,
    saleProceedsAmt: null,
    ...overrides,
  };
}

function detailRow(overrides = {}) {
  return {
    id: "id-active",
    modelYear: 2018,
    makeName: "RAM",
    modelName: "RAM 1500",
    vehicleType: "Pickup Trucks (4x2)",
    vehicleBodyStyle: "Quad Cab",
    vehicleSeries: "TRADESMAN",
    makeColorName: "White",
    vehicleMiles: 25234,
    vehicleEngineType: "6-Cylinder Gas",
    fuelType: "Gasoline - Dedicated",
    vin: "1C6RR6FG9JS283922",
    vehicleEngineSize: "3.6 L",
    vehicleTransmission: "Automatic Transmission",
    vehicleNumberOfSeats: "5",
    vehicleDriveType: "Rear Wheel Drive",
    vehicleInterior: "Cloth",
    openRecall: 0,
    vehicleInteriorColor: "GRAY",
    vehicleAdditionalEquip1: "Bluetooth Connection; Bedliner; ",
    vehicleAdditionalEquip2: "Bedliner; Reverse Camera; ",
    vehicleCondition: "4",
    comments: "Body/Paint Damage",
    vendorName: "Carriage Trade Public Auto Auction",
    vendorCity: "Conshohocken",
    vendorState: "PA",
    vendorPostalCode: "19428",
    saleType: "Internet",
    saleStatus: "Active",
    vehicleSaleStatus: "Lotted",
    highBid: "13725.00",
    saleStartDate: "2026-08-05T17:00:00.000Z",
    saleEndDate: "2026-08-05T19:00:00.000Z",
    extendedSaleEndDate: "2026-08-05T19:05:00.000Z",
    saleNumber: "3FDDCI26140",
    saleRunNumber: "244",
    eimsConditionReportLink: "/PDFConditionReportServlet?clientid=GSA&iid=abc",
    eimsCrApproved: true,
    photoUrl: "http://media.ext.edgeapps.net/example/truck.jpg",
    photoUrlLarge: "http://media.ext.edgeapps.net/example/truck.jpg",
    bidIncrement: "25.00",
    floorPrice: "11000.00",
    askingPrice: 11000,
    saleProceedsAmt: null,
    winningBidAmt: null,
    eimsVehiclePhotos: [
      {
        photoUrl: "http://media.ext.edgeapps.net/example/truck.jpg",
        photoDescription: "Approved Photo",
      },
      {
        photoUrl: "http://pics.autoims.com/example/truck-2.jpg",
        photoDescription: "Extra Photo 1",
      },
    ],
    ...overrides,
  };
}

test("fetches a bounded complete active/coming snapshot and normalizes source classifications", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init, body: JSON.parse(init.body) });
    const offset = calls.at(-1).body.variables.offset;
    if (offset === 0) {
      return json({
        data: {
          getVehicleListingDetails: {
            count: 2,
            hasMore: true,
            rows: [listingRow()],
          },
        },
      });
    }
    return json({
      data: {
        getVehicleListingDetails: {
          count: 2,
          hasMore: false,
          rows: [
            listingRow({
              id: "id-coming",
              vin: "5NPD74LF9LH602097",
              makeName: "HYUNDAI",
              modelName: "ELANTRA GLS",
              modelYear: 2020,
              saleNumber: "4PFBPI26353",
              saleStartDate: "2026-08-13T17:00:00.000Z",
              saleEndDate: "2026-08-20T17:00:00.000Z",
              highBid: null,
            }),
          ],
        },
      },
    });
  };

  const snapshot = await fetchGsaFleetActiveListings({
    fetchImpl,
    forceRefresh: true,
    now: new Date("2026-08-05T18:00:00.000Z"),
    pageSize: 1,
    maxRows: 10,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].input, GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT);
  assert.equal("credentials" in calls[0].init, false);
  assert.equal("cache" in calls[0].init, false);
  assert.equal("referrerPolicy" in calls[0].init, false);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
  assert.deepEqual(calls[0].body.variables.filters[0].conditions[0].value, [
    "Coming soon",
    "Active",
  ]);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.advertisedCount, 2);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0].source, "gsa-fleet");
  assert.equal(snapshot.rows[0].phase, "active");
  assert.equal(snapshot.rows[0].channel, "internet");
  assert.equal(snapshot.rows[0].highBidCents, 1_372_500);
  assert.equal(snapshot.rows[0].images.length, 1);
  assert.match(snapshot.rows[0].images[0], /^https:\/\//);
  assert.equal(snapshot.rows[1].phase, "coming");

  const cached = await fetchGsaFleetActiveListings({
    fetchImpl,
    now: new Date("2026-08-05T18:00:30.000Z"),
    pageSize: 1,
    maxRows: 10,
  });
  assert.equal(calls.length, 2);
  assert.equal(cached.cache, "memory-hit");
  assert.equal(cached.rows[0].phase, "active");
});

test("imports closed outcomes without treating an unawarded high bid as a final price", async () => {
  let requestBody;
  const fetchImpl = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return json({
      data: {
        getVehicleListingDetails: {
          count: 3,
          hasMore: false,
          rows: [
            listingRow({
              id: "closed-winning",
              saleStatus: "Closed",
              vehicleSaleStatus: "Sold",
              winningBidAmt: 13825,
              saleProceedsAmt: 13825,
            }),
            listingRow({
              id: "closed-proceeds",
              vin: "1FM5K8D80JGA44616",
              saleType: "Live",
              saleStatus: "Sale Complete",
              vehicleSaleStatus: "Awarded",
              highBid: null,
              winningBidAmt: null,
              saleProceedsAmt: 13200,
            }),
            listingRow({
              id: "closed-lotted",
              vin: "1FTEW1LP5SKE08763",
              saleStatus: "Closed",
              vehicleSaleStatus: "Lotted",
              highBid: 14600,
              winningBidAmt: null,
              saleProceedsAmt: null,
            }),
          ],
        },
      },
    });
  };

  const snapshot = await fetchGsaFleetClosedResults({
    fetchImpl,
    forceRefresh: true,
    now: new Date("2026-08-05T18:00:00.000Z"),
    since: "2026-08-01",
    pageSize: 10,
    maxRows: 10,
  });

  const conditions = requestBody.variables.filters[0].conditions;
  assert.deepEqual(conditions[0].value, ["Closed", "Sale Complete"]);
  assert.deepEqual(conditions[1], {
    operator: "$gte",
    key: "saleEndDate",
    value: "2026-08-01",
  });
  assert.equal(snapshot.rows[0].finalPriceCents, 1_382_500);
  assert.equal(snapshot.rows[0].finalPriceBasis, "winning-bid");
  assert.equal(snapshot.rows[0].isComparableOutcome, true);
  assert.equal(snapshot.rows[1].finalPriceCents, 1_320_000);
  assert.equal(snapshot.rows[1].finalPriceBasis, "sale-proceeds");
  assert.equal(snapshot.rows[2].highBidCents, 1_460_000);
  assert.equal(snapshot.rows[2].finalPriceCents, null);
  assert.equal(snapshot.rows[2].isComparableOutcome, false);
});

test("enriches a bounded detail batch and rejects a relisting mismatch", async () => {
  const listingFetch = async () =>
    json({
      data: {
        getVehicleListingDetails: {
          count: 2,
          hasMore: false,
          rows: [
            listingRow(),
            listingRow({
              id: "id-coming",
              vin: "5NPD74LF9LH602097",
              saleNumber: "4PFBPI26353",
            }),
          ],
        },
      },
    });
  const listing = await fetchGsaFleetActiveListings({
    fetchImpl: listingFetch,
    forceRefresh: true,
    now: new Date("2026-08-05T18:00:00.000Z"),
    maxRows: 10,
  });

  const detailFetch = async (_input, init) => {
    const vin = JSON.parse(init.body).variables.vin;
    return json({
      data: {
        getVehicleDetailsByVin:
          vin === "1C6RR6FG9JS283922"
            ? detailRow()
            : detailRow({
                id: "different-listing-id",
                vin: "5NPD74LF9LH602097",
                saleNumber: "4PFBPI26353",
              }),
      },
    });
  };
  const enriched = await enrichGsaFleetVehicleDetails(listing.rows, {
    fetchImpl: detailFetch,
    forceRefresh: true,
    now: new Date("2026-08-05T18:00:00.000Z"),
    maxVehicles: 2,
    concurrency: 2,
  });

  assert.equal(enriched.requested, 2);
  assert.equal(enriched.succeeded, 1);
  assert.equal(enriched.failed, 1);
  assert.equal(enriched.vehicles[0].detail.images.length, 2);
  assert.equal(enriched.vehicles[0].detail.equipment.length, 3);
  assert.match(enriched.vehicles[0].detail.images[1], /^https:\/\/pics\.autoims\.com/);
  assert.equal(enriched.vehicles[1].errorCode, "GSA_FLEET_DETAIL_ID_MISMATCH");
});

test("fetches one vehicle detail with explicitly partial public bid history", async () => {
  let request;
  const fetchImpl = async (input, init) => {
    request = { input, init, body: JSON.parse(init.body) };
    return json({
      data: {
        getVehicleDetailsByVin: detailRow(),
        vehicleBidHistory: {
          activeItemsCount: 64,
          extendedSaleEndDate: "2026-08-05T19:10:00.000Z",
          totalBids: 64,
          bids: [
            {
              bidderUserId: "BIDDER 1",
              bidDate: "2026-08-05T18:20:00.032Z",
              bidAmt: "13725.00",
              isHighBid: true,
            },
            {
              bidderUserId: "BIDDER 2",
              bidDate: "2026-08-05T18:19:59.032Z",
              bidAmt: "13700.00",
              isHighBid: false,
            },
            {
              bidderUserId: "unexpected-public-label",
              bidDate: "2026-08-05T18:14:38.563Z",
              bidAmt: "13650.00",
              isHighBid: false,
            },
          ],
          highestBidder: { bidAmt: "13725.00" },
        },
      },
    });
  };

  const activity = await fetchGsaFleetVehicleActivity(
    "1C6RR6FG9JS283922",
    "3FDDCI26140",
    {
      fetchImpl,
      now: new Date("2026-08-05T18:21:00.000Z"),
    },
  );

  assert.equal(request.input, GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT);
  assert.equal(new Headers(request.init.headers).get("authorization"), null);
  assert.equal(request.body.variables.vehicleBidHistoryInput.limit, 100);
  assert.equal(request.body.variables.vehicleBidHistoryInput.offset, 1);
  assert.equal(activity.currentBidCents, 1_372_500);
  assert.equal(activity.effectiveEndsAt, "2026-08-05T19:10:00.000Z");
  assert.equal(activity.bidHistory.totalBids, 64);
  assert.equal(activity.bidHistory.isCompleteIncrementHistory, false);
  assert.equal(activity.bidHistory.bids.length, 3);
  assert.equal(activity.bidHistory.bids[0].amountCents, 1_365_000);
  assert.equal(activity.bidHistory.bids[0].bidderLabel, null);
});

test("normalizes only safe HTTP(S) image URLs", () => {
  assert.equal(
    normalizeGsaFleetImageUrl("http://pics.autoims.com/example.jpg#fragment"),
    "https://pics.autoims.com/example.jpg",
  );
  assert.equal(normalizeGsaFleetImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeGsaFleetImageUrl("https://user:pass@example.com/photo.jpg"), null);
  assert.equal(normalizeGsaFleetImageUrl("[no photo]"), null);
});
