import assert from "node:assert/strict";
import test from "node:test";

import { getGsaVehicleAuctions } from "../lib/gsa-client.ts";

test("keeps the API key server-side, follows the official download safely, and falls back stale", async () => {
  const previousKey = process.env.GSA_API_KEY;
  const secret = "test-secret-that-must-not-leak";
  process.env.GSA_API_KEY = secret;

  try {
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });

      if (calls.length === 1) {
        return new Response(null, {
          status: 303,
          headers: {
            Location:
              "https://fleet-data.s3.us-gov-west-1.amazonaws.com/active-auctions.json?X-Amz-Signature=example",
          },
        });
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              SaleNo: "TEST-SALE",
              LotNo: "1",
              ItemName: "2020 Toyota Camry Sedan",
              AuctionStatus: "A",
              HighBidAmount: "5000",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const fresh = await getGsaVehicleAuctions({
      fetchImpl,
      forceRefresh: true,
      now: new Date("2026-08-04T12:00:00.000Z"),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.get("x-api-key"), secret);
    assert.equal(calls[1].headers.get("x-api-key"), null);
    assert.match(calls[0].url, /^https:\/\/api\.gsa\.gov\//);
    assert.doesNotMatch(calls[0].url, /test-secret|api_key=/i);
    assert.equal(fresh.auctions.length, 1);
    assert.equal(fresh.sourceHealth.status, "live");
    assert.equal(fresh.sourceHealth.credentialMode, "configured");
    assert.equal(JSON.stringify(fresh).includes(secret), false);
    assert.match(fresh.sourceHealth.limitations.join(" "), /not a sub-minute live bid stream/i);

    const stale = await getGsaVehicleAuctions({
      fetchImpl: async () => new Response(null, { status: 429 }),
      forceRefresh: true,
      now: new Date("2026-08-04T14:00:00.000Z"),
    });

    assert.equal(stale.sourceHealth.status, "stale");
    assert.equal(stale.sourceHealth.cache, "stale-fallback");
    assert.equal(stale.sourceHealth.lastErrorCode, "GSA_UPSTREAM_HTTP_ERROR");
    assert.equal(stale.auctions[0].id, fresh.auctions[0].id);
  } finally {
    if (previousKey === undefined) delete process.env.GSA_API_KEY;
    else process.env.GSA_API_KEY = previousKey;
  }
});
