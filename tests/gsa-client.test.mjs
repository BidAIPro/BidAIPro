import assert from "node:assert/strict";
import test from "node:test";

import { getGsaVehicleAuctions } from "../lib/gsa-client.ts";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("prefers the complete PPMS vehicle catalog, safely falls back to the bulk API, and serves stale good data", async () => {
  const previousKey = process.env.GSA_API_KEY;
  const secret = "test-secret-that-must-not-leak";
  process.env.GSA_API_KEY = secret;

  try {
    const primaryCalls = [];
    const primaryFetch = async (input, init = {}) => {
      const url = new URL(String(input));
      primaryCalls.push({ url, init, headers: new Headers(init.headers) });
      if (url.pathname.endsWith("/api/v1/auctions")) {
        const request = JSON.parse(init.body);
        assert.deepEqual(request.categoryCodeList, ["300"]);
        assert.equal(request.auctionStatus, "active");
        assert.equal(url.searchParams.get("size"), "200");
        return json({
          totalPages: 1,
          totalElements: 1,
          auctionDTOList: [
            {
              lotId: 400035,
              auctionId: 372373,
              lotNumber: 4,
              salesNumber: "41QSCI26417",
              status: "Active",
              startDate: "2026-08-01T10:21:00",
              endDate: "2026-08-08T10:21:00",
              categoryCode: "320",
              lotName: "2009 Ford E-150 Van",
              currentBid: 8504,
              numberOfBidders: 7,
              location: { city: "Ridgefield", state: "WA", zipCode: "98642" },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/sales/preview/auctions/400035")) {
        return json({
          propertyLocation: { city: "Ridgefield", state: "WA", zipCode: "98642" },
          imagesAndDocs: {
            image: [
              {
                id: 2536152,
                uri: "sales/41QSCI26417/4/2536152.jpeg",
                name: "van.jpeg",
                valid: true,
                virusScanStatus: "CLEAN",
                attachmentOrder: 1,
              },
            ],
          },
          auctionDescriptionDTO: {
            make: "FORD MOTOR CO",
            model: "E150",
            odometer: "20631",
            bodyType: "VA",
            conditionCode: "U",
            itemDescription:
              "<ul><li>Mileage: 20,631</li><li>VIN: 1FMNE11W89DA83114</li><li>Body Style: Van</li></ul>",
          },
        });
      }
      if (url.pathname.endsWith("/storage/presigned-urls")) {
        return json([
          {
            id: "2536152",
            uri: "sales/41QSCI26417/4/2536152.jpeg",
            fileName: "van.jpeg",
            presignedUrl:
              "https://gsa-prod-ppms-attachments-prod.s3.amazonaws.com/sales/van.jpeg?X-Amz-Expires=3600",
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const fresh = await getGsaVehicleAuctions({
      fetchImpl: primaryFetch,
      forceRefresh: true,
      now: new Date("2026-08-04T12:00:00.000Z"),
    });

    assert.equal(primaryCalls.length, 3);
    assert.equal(primaryCalls.some((call) => call.url.searchParams.has("api_key")), false);
    assert.equal(fresh.auctions.length, 1);
    assert.equal(fresh.auctions[0].mileage, 20_631);
    assert.equal(fresh.auctions[0].images.length, 1);
    assert.equal(fresh.sourceHealth.status, "live");
    assert.equal(fresh.sourceHealth.sourceMode, "ppms-public-catalog");
    assert.equal(fresh.sourceHealth.credentialMode, "public-catalog");
    assert.equal(JSON.stringify(fresh).includes(secret), false);

    const staleCalls = [];
    const stale = await getGsaVehicleAuctions({
      fetchImpl: async (input) => {
        staleCalls.push(String(input));
        return new Response(null, { status: 429 });
      },
      forceRefresh: true,
      now: new Date("2026-08-04T14:00:00.000Z"),
    });

    assert.equal(stale.sourceHealth.status, "stale");
    assert.equal(stale.sourceHealth.cache, "stale-fallback");
    assert.match(stale.sourceHealth.lastErrorCode, /GSA_PPMS.*GSA_UPSTREAM_HTTP_ERROR/);
    assert.equal(stale.auctions[0].id, fresh.auctions[0].id);
    const legacyAttempt = new URL(staleCalls.find((url) => url.startsWith("https://api.gsa.gov/")));
    assert.equal(legacyAttempt.searchParams.get("api_key"), secret);

    const fallbackCalls = [];
    const legacyFetch = async (input, init = {}) => {
      const url = new URL(String(input));
      fallbackCalls.push({ url, headers: new Headers(init.headers) });
      if (url.hostname === "www.ppms.gov") return new Response(null, { status: 503 });
      if (url.hostname === "api.gsa.gov") {
        return new Response(null, {
          status: 303,
          headers: {
            Location:
              "https://fleet-data.s3.us-gov-west-1.amazonaws.com/active-auctions.json?X-Amz-Signature=example",
          },
        });
      }
      return json({
        results: [
          {
            SaleNo: "TEST-SALE",
            LotNo: "1",
            ItemName: "2020 Toyota Camry Sedan",
            AuctionStatus: "A",
            HighBidAmount: "5000",
          },
        ],
      });
    };
    const fallback = await getGsaVehicleAuctions({
      fetchImpl: legacyFetch,
      forceRefresh: true,
      now: new Date("2026-08-04T15:00:00.000Z"),
    });
    const apiCall = fallbackCalls.find((call) => call.url.hostname === "api.gsa.gov");
    const downloadCall = fallbackCalls.find((call) => call.url.hostname.endsWith("amazonaws.com"));
    assert.equal(apiCall.url.searchParams.get("api_key"), secret);
    assert.equal(apiCall.headers.get("x-api-key"), null);
    assert.equal(downloadCall.url.searchParams.has("api_key"), false);
    assert.equal(downloadCall.headers.get("x-api-key"), null);
    assert.equal(fallback.sourceHealth.sourceMode, "legacy-bulk-feed");
    assert.equal(JSON.stringify(fallback).includes(secret), false);
  } finally {
    if (previousKey === undefined) delete process.env.GSA_API_KEY;
    else process.env.GSA_API_KEY = previousKey;
  }
});
