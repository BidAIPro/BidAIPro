import assert from "node:assert/strict";
import test from "node:test";

import {
  GSA_AUCTIONS_ENDPOINT,
  GSA_PUBLIC_FEED_LIMITATIONS,
} from "../lib/gsa-client.ts";
import { GSA_PPMS_CATALOG_ENDPOINT } from "../lib/gsa-ppms-client.ts";
import { prepareGsaRunnerSnapshot } from "../lib/gsa-snapshot-export.ts";

const NOW = new Date("2026-08-05T18:00:00.000Z");

function auction(index, overrides = {}) {
  const id = String(index).padStart(3, "0");
  const image = `https://images.gsa.gov/auctions/${id}.jpg`;
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
    ...overrides,
  };
}

function coverage(auctions, withDetail = false) {
  return {
    totalLots: auctions.length,
    vehicleLots: auctions.length,
    excludedLots: 0,
    withVin: auctions.filter((item) => item.vin !== null).length,
    withMileage: auctions.filter((item) => item.mileage !== null).length,
    withBodyType: auctions.filter((item) => item.bodyType !== null).length,
    withImage: auctions.filter((item) => item.imageUrl !== null).length,
    withCurrentBid: auctions.filter((item) => item.currentBid !== null).length,
    statusCounts: {
      active: auctions.filter((item) => item.status === "active").length,
      preview: auctions.filter((item) => item.status === "preview").length,
      scheduled: 0,
      unknown: 0,
    },
    exclusionCounts: {},
    ...(withDetail
      ? {
          detailEnrichment: {
            requested: auctions.length,
            succeeded: auctions.length,
            failed: 0,
            imagesDiscovered: auctions.length,
            imagesSigned: auctions.length,
          },
        }
      : {}),
  };
}

function sourceHealth(sourceMode, credentialMode) {
  return {
    source: "GSA Auctions API",
    official: true,
    endpoint: sourceMode === "ppms-public-catalog"
      ? GSA_PPMS_CATALOG_ENDPOINT
      : GSA_AUCTIONS_ENDPOINT,
    sourceMode,
    status: "live",
    cache: "refresh",
    credentialMode,
    fetchedAt: NOW.toISOString(),
    observedAt: NOW.toISOString(),
    cachedUntil: "2026-08-05T18:45:00.000Z",
    staleSince: null,
    ageSeconds: 0,
    lastErrorCode: null,
    discoveryCadence: "hourly",
    limitations: [...GSA_PUBLIC_FEED_LIMITATIONS],
  };
}

test("keeps PPMS primary and applies its signed-image freshness envelope", () => {
  const auctions = Array.from({ length: 10 }, (_, index) => {
    const value = auction(index + 1);
    const signed = `https://gsa-prod-ppms-attachments-prod.s3.amazonaws.com/${index}.jpg?X-Amz-Expires=3600`;
    return { ...value, imageUrl: signed, images: [signed] };
  });
  const prepared = prepareGsaRunnerSnapshot({
    auctions,
    coverage: coverage(auctions, true),
    sourceHealth: sourceHealth("ppms-public-catalog", "public-catalog"),
  }, NOW);

  assert.equal(prepared.source, "gsa-ppms");
  assert.equal(prepared.auctions.length, 10);
  assert.equal(prepared.coverage.detailEnrichment.succeeded, 10);
  assert.equal(prepared.imageExpiresAt, "2026-08-05T18:55:00.000Z");
  assert.equal(prepared.expiresAt, "2026-08-06T18:00:00.000Z");
});

test("prepares a keyed documented-API snapshot with stable, host-validated images", () => {
  const auctions = Array.from({ length: 10 }, (_, index) => auction(index + 1));
  auctions.push(auction(11, { status: "preview" }));
  auctions[9] = auction(10, {
    imageUrl: "https://tracking.example.test/vehicle.jpg",
    images: ["https://tracking.example.test/vehicle.jpg"],
  });
  const prepared = prepareGsaRunnerSnapshot({
    auctions,
    coverage: coverage(auctions),
    sourceHealth: sourceHealth("legacy-bulk-feed", "configured"),
  }, NOW);

  assert.equal(prepared.source, "gsa-auctions-api");
  assert.equal(prepared.auctions.length, 10);
  assert.equal(prepared.coverage.vehicleLots, 10);
  assert.equal(prepared.coverage.statusCounts.active, 10);
  assert.equal(prepared.coverage.withImage, 9);
  assert.equal(prepared.auctions[9].imageUrl, null);
  assert.deepEqual(prepared.auctions[9].images, []);
  assert.equal(prepared.imageExpiresAt, prepared.expiresAt);
  assert.equal(prepared.imageExpiresAt, "2026-08-06T18:00:00.000Z");
});

test("refuses unconfigured legacy exports and materially untrusted image sets", () => {
  const official = Array.from({ length: 10 }, (_, index) => auction(index + 1));
  assert.throws(
    () => prepareGsaRunnerSnapshot({
      auctions: official,
      coverage: coverage(official),
      sourceHealth: sourceHealth("legacy-bulk-feed", "shared-demo"),
    }, NOW),
    /configured API key/i,
  );

  const untrusted = official.map((item, index) => ({
    ...item,
    imageUrl: `https://example.test/${index}.jpg`,
    images: [`https://example.test/${index}.jpg`],
  }));
  assert.throws(
    () => prepareGsaRunnerSnapshot({
      auctions: untrusted,
      coverage: coverage(untrusted),
      sourceHealth: sourceHealth("legacy-bulk-feed", "configured"),
    }, NOW),
    /untrusted hosts/i,
  );
});
