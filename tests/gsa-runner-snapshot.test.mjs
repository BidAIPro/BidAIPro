import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  fetchGsaRunnerSnapshot,
  GsaRunnerSnapshotError,
} from "../lib/gsa-runner-snapshot.ts";

const NOW = new Date("2026-08-05T15:00:00.000Z");

function auction(index) {
  const id = String(index).padStart(3, "0");
  const image = `https://gsa-prod-ppms-attachments-prod.s3.amazonaws.com/sales/${id}.jpeg?X-Amz-Expires=3600`;
  return {
    id: `gsa:test-sale:${id}`,
    source: "gsa-auctions",
    saleNumber: "TEST-SALE",
    lotNumber: id,
    lotSequence: id,
    title: `2020 Ford Transit Van ${id}`,
    description: "Mileage: 20,000. Minor scratches disclosed.",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-08-06T00:00:00.000Z",
    currentBid: 5_000 + index,
    bidderCount: 3,
    bidIncrement: 100,
    reserve: null,
    inactivityMinutes: null,
    url: `https://gsaauctions.gov/auctions/preview/${1000 + index}`,
    imageUrl: image,
    images: [image],
    vin: `1FMNE11W89DA${String(83000 + index).padStart(5, "0")}`,
    mileage: 20_000 + index,
    odometerStatus: "reported-not-verified",
    bodyType: "van",
    year: 2020,
    make: "Ford",
    modelLabel: "Transit Van",
    transmission: "Automatic",
    fuelType: "Gasoline",
    cylinders: 6,
    color: "White",
    openRecall: false,
    conditionCode: "U",
    condition: "usable",
    operability: "runs-and-drives",
    damageFlags: ["paint-damage"],
    issueFlags: [],
    conditionNotes: ["Minor scratches disclosed"],
    detailEnriched: true,
    location: {
      addressLines: ["100 Test Drive"],
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
    },
    saleLocation: {
      addressLines: [],
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
    },
    agency: {
      code: "GSA",
      name: "General Services Administration",
      bureauCode: null,
      bureauName: null,
    },
    evidence: {
      title: true,
      vin: true,
      mileage: true,
      bodyType: true,
      matched: ["vehicle-title", "vin", "mileage", "body:van"],
    },
  };
}

function snapshot(overrides = {}) {
  const generatedAt = "2026-08-05T14:45:00.000Z";
  const auctions = Array.from({ length: 10 }, (_, index) => auction(index + 1));
  const value = {
    schemaVersion: 1,
    source: "gsa-ppms",
    revision: "",
    itemCount: auctions.length,
    generatedAt,
    expiresAt: "2026-08-06T14:45:00.000Z",
    imageExpiresAt: "2026-08-05T15:40:00.000Z",
    auctions,
    coverage: {
      totalLots: auctions.length,
      vehicleLots: auctions.length,
      excludedLots: 0,
      withVin: auctions.length,
      withMileage: auctions.length,
      withBodyType: auctions.length,
      withImage: auctions.length,
      withCurrentBid: auctions.length,
      statusCounts: { active: auctions.length, preview: 0, scheduled: 0, unknown: 0 },
      exclusionCounts: {},
      detailEnrichment: {
        requested: auctions.length,
        succeeded: auctions.length,
        failed: 0,
        imagesDiscovered: auctions.length,
        imagesSigned: auctions.length,
      },
    },
    sourceHealth: {
      source: "GSA Auctions API",
      official: true,
      endpoint: "https://gsaauctions.gov/gw/auction/ppms/api/v1/auctions",
      sourceMode: "ppms-public-catalog",
      status: "live",
      cache: "refresh",
      credentialMode: "public-catalog",
      fetchedAt: generatedAt,
      observedAt: generatedAt,
      cachedUntil: "2026-08-05T15:30:00.000Z",
      staleSince: null,
      ageSeconds: 0,
      lastErrorCode: null,
      discoveryCadence: "hourly",
      limitations: ["Mileage is reported by the seller and is not independently verified."],
    },
    ...overrides,
  };
  value.revision = createHash("sha256")
    .update(JSON.stringify({ generatedAt: value.generatedAt, auctions: value.auctions }))
    .digest("hex");
  return value;
}

function responseFor(value) {
  return async () => new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

test("accepts a complete official PPMS runner snapshot", async () => {
  const value = snapshot();
  const result = await fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW });
  assert.equal(result.itemCount, 10);
  assert.equal(result.auctions.every((item) => item.mileage !== null), true);
  assert.equal(result.auctions.every((item) => item.images.length === 1), true);
});

test("keeps vehicle facts usable after signed image URLs expire", async () => {
  const value = snapshot({ imageExpiresAt: "2026-08-05T14:59:00.000Z" });
  const result = await fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW });
  assert.equal(result.itemCount, 10);
  assert.equal(Date.parse(result.imageExpiresAt) < NOW.getTime(), true);
});

test("rejects expired, collapsed, duplicate, unsafe, and tampered snapshots", async (t) => {
  await t.test("expired catalog", async () => {
    const value = snapshot({ expiresAt: "2026-08-05T14:59:59.000Z" });
    await assert.rejects(
      fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW }),
      (error) => error instanceof GsaRunnerSnapshotError && error.code === "GSA_RUNNER_SNAPSHOT_EXPIRED",
    );
  });

  await t.test("collapsed catalog", async () => {
    const auctions = Array.from({ length: 9 }, (_, index) => auction(index + 1));
    const value = snapshot({ auctions, itemCount: auctions.length });
    value.coverage.vehicleLots = auctions.length;
    value.revision = createHash("sha256")
      .update(JSON.stringify({ generatedAt: value.generatedAt, auctions }))
      .digest("hex");
    await assert.rejects(
      fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW }),
      (error) => error instanceof GsaRunnerSnapshotError && error.code === "GSA_RUNNER_SNAPSHOT_COUNT_INVALID",
    );
  });

  await t.test("duplicate IDs", async () => {
    const value = snapshot();
    value.auctions[1].id = value.auctions[0].id;
    value.revision = createHash("sha256")
      .update(JSON.stringify({ generatedAt: value.generatedAt, auctions: value.auctions }))
      .digest("hex");
    await assert.rejects(
      fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW }),
      (error) => error instanceof GsaRunnerSnapshotError && error.code === "GSA_RUNNER_SNAPSHOT_DUPLICATE",
    );
  });

  await t.test("untrusted image host", async () => {
    const value = snapshot();
    value.auctions[0].imageUrl = "https://example.com/tracker.jpg";
    value.auctions[0].images = [value.auctions[0].imageUrl];
    value.revision = createHash("sha256")
      .update(JSON.stringify({ generatedAt: value.generatedAt, auctions: value.auctions }))
      .digest("hex");
    await assert.rejects(
      fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW }),
      (error) => error instanceof GsaRunnerSnapshotError && error.code === "GSA_RUNNER_SNAPSHOT_AUCTION_INVALID",
    );
  });

  await t.test("revision mismatch", async () => {
    const value = snapshot();
    value.auctions[0].title = "Tampered title";
    await assert.rejects(
      fetchGsaRunnerSnapshot({ fetchImpl: responseFor(value), now: NOW }),
      (error) => error instanceof GsaRunnerSnapshotError && error.code === "GSA_RUNNER_SNAPSHOT_REVISION_INVALID",
    );
  });
});
