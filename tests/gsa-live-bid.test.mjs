import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchPpmsLiveBid,
  isValidPpmsAuctionId,
  PpmsLiveBidError,
} from "../lib/gsa-ppms-live-bid.ts";
import {
  GET as liveBidRoute,
  OPTIONS as liveBidPreflight,
} from "../app/api/live-bid/route.ts";

function response(payload, init = {}) {
  return Response.json(payload, init);
}

test("validates PPMS auction ids before making a request", async () => {
  for (const id of ["", "0", "001", "-1", "372696/extra", "abc", "9007199254740992"]) {
    assert.equal(isValidPpmsAuctionId(id), false, id);
  }
  assert.equal(isValidPpmsAuctionId("372696"), true);

  let called = false;
  await assert.rejects(
    fetchPpmsLiveBid("../372696", {
      fetchImpl: async () => {
        called = true;
        return response({});
      },
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_INVALID_ID",
  );
  assert.equal(called, false);
});

test("maps the official PPMS live response to a cents-based snapshot", async () => {
  let requestedRequest;
  const snapshot = await fetchPpmsLiveBid("372696", {
    fetchImpl: async (input, init) => {
      requestedRequest = input instanceof Request ? input : new Request(input, init);
      return response({
        auctionId: 372696,
        currentBid: 2510.5,
        numberOfBidders: 3,
        status: "Active",
        endDate: "2026-08-07T12:00:00",
      });
    },
    now: () => new Date("2026-08-05T21:00:00.000Z"),
  });

  assert.equal(
    requestedRequest.url,
    "https://www.ppms.gov/gw/auction/ppms/api/v1/auctions/getAuction/372696",
  );
  assert.equal(requestedRequest.method, "GET");
  assert.equal(requestedRequest.headers.get("accept"), "application/json");
  assert.equal(requestedRequest.headers.get("origin"), null);
  assert.ok(requestedRequest.signal instanceof AbortSignal);
  assert.deepEqual(snapshot, {
    externalId: "372696",
    currentBidCents: 251_050,
    bidderCount: 3,
    status: "active",
    endsAt: "2026-08-07T17:00:00.000Z",
    lastCheckedAt: "2026-08-05T21:00:00.000Z",
  });
});

test("accepts explicit null bid facts without manufacturing a zero", async () => {
  const snapshot = await fetchPpmsLiveBid("372696", {
    fetchImpl: async () =>
      response({
        auctionId: "372696",
        currentBid: null,
        numberOfBidders: null,
        status: "Scheduled",
        endDate: "2026-01-05T10:21:00",
      }),
  });

  assert.equal(snapshot.currentBidCents, null);
  assert.equal(snapshot.bidderCount, null);
  assert.equal(snapshot.status, "preview");
  assert.equal(snapshot.endsAt, "2026-01-05T16:21:00.000Z");
});

test("rejects a mismatched auction id and malformed required facts", async () => {
  await assert.rejects(
    fetchPpmsLiveBid("372696", {
      fetchImpl: async () =>
        response({
          auctionId: 372697,
          currentBid: 100,
          numberOfBidders: 1,
          status: "Active",
          endDate: "2026-08-07T12:00:00",
        }),
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_ID_MISMATCH",
  );

  await assert.rejects(
    fetchPpmsLiveBid("372696", {
      fetchImpl: async () =>
        response({
          auctionId: 372696,
          currentBid: "not money",
          numberOfBidders: 1,
          status: "Active",
          endDate: "2026-08-07T12:00:00",
        }),
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_SHAPE_CHANGED",
  );

  await assert.rejects(
    fetchPpmsLiveBid("372696", {
      fetchImpl: async () =>
        response({
          auctionId: 372696,
          currentBid: 100,
          numberOfBidders: 1,
          status: "NewFutureStatus",
          endDate: "2026-08-07T12:00:00",
        }),
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_SHAPE_CHANGED",
  );
});

test("rejects oversized PPMS responses before parsing", async () => {
  await assert.rejects(
    fetchPpmsLiveBid("372696", {
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(64 * 1024 + 1),
          },
        }),
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_TOO_LARGE",
  );
});

test("bounds an unresponsive PPMS request with an abortable timeout", async () => {
  await assert.rejects(
    fetchPpmsLiveBid("372696", {
      timeoutMs: 10,
      fetchImpl: async (input, init) =>
        new Promise((_resolve, reject) => {
          const request = input instanceof Request ? input : new Request(input, init);
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    }),
    (error) =>
      error instanceof PpmsLiveBidError &&
      error.code === "GSA_PPMS_LIVE_TIMEOUT",
  );
});

test("serves live snapshots with Pages CORS and no more than ten seconds of edge cache", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    response({
      auctionId: 372696,
      currentBid: 2510,
      numberOfBidders: 3,
      status: "Active",
      endDate: "2026-08-07T12:00:00",
    });

  const routeResponse = await liveBidRoute(
    new Request("https://example.test/api/live-bid?id=372696"),
  );
  const payload = await routeResponse.json();
  assert.equal(routeResponse.status, 200);
  assert.equal(payload.data.currentBidCents, 251_000);
  assert.equal(
    routeResponse.headers.get("x-bidai-api-version"),
    "2026-08-05.2",
  );
  assert.equal(
    routeResponse.headers.get("cache-control"),
    "public, max-age=0, s-maxage=10, must-revalidate",
  );
  assert.equal(
    routeResponse.headers.get("access-control-allow-origin"),
    "https://bidaipro.github.io",
  );

  const preflight = liveBidPreflight();
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("rejects a non-numeric route id without contacting PPMS", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  const routeResponse = await liveBidRoute(
    new Request("https://example.test/api/live-bid?id=not-a-number"),
  );
  assert.equal(routeResponse.status, 400);
  assert.equal(routeResponse.headers.get("cache-control"), "no-store");
  assert.equal((await routeResponse.json()).error.code, "INVALID_AUCTION_ID");
});

test("returns only sanitized upstream diagnostics when PPMS rejects a request", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  globalThis.fetch = async () =>
    new Response("Invalid CORS request", { status: 403 });
  console.error = () => {};

  const routeResponse = await liveBidRoute(
    new Request("https://example.test/api/live-bid?id=372696"),
  );
  const payload = await routeResponse.json();
  assert.equal(routeResponse.status, 502);
  assert.equal(
    routeResponse.headers.get("x-bidai-api-version"),
    "2026-08-05.2",
  );
  assert.deepEqual(payload.error.diagnostic, {
    sourceCode: "GSA_PPMS_LIVE_HTTP_ERROR",
    upstreamStatus: 403,
  });
  assert.equal(JSON.stringify(payload).includes("Invalid CORS request"), false);
});
