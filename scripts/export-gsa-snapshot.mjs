import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GSA_CACHE_SECONDS, GSA_PUBLIC_FEED_LIMITATIONS } from "../lib/gsa-client.ts";
import {
  fetchPpmsVehicleAuctions,
  GSA_PPMS_CATALOG_ENDPOINT,
} from "../lib/gsa-ppms-client.ts";

const outputPath = resolve(process.argv[2] ?? "work/gsa-vehicles.json");
const previousPath = process.argv[3] ? resolve(process.argv[3]) : null;
const now = new Date();
const discovery = await fetchPpmsVehicleAuctions(fetch, now, AbortSignal.timeout(120_000));
const auctions = discovery.auctions.filter((auction) => auction.status === "active");

if (auctions.length < 10) {
  throw new Error("Refusing to publish an unavailable or empty GSA snapshot.");
}
if (discovery.coverage.vehicleLots !== auctions.length) {
  throw new Error("Refusing to publish a partial GSA vehicle snapshot.");
}
if (
  discovery.coverage.detailEnrichment?.requested !== auctions.length ||
  discovery.coverage.detailEnrichment.succeeded < Math.ceil(auctions.length * 0.9)
) {
  throw new Error("Refusing to publish a materially incomplete GSA detail snapshot.");
}

let previousCount = null;
if (previousPath) {
  try {
    const previous = JSON.parse(await readFile(previousPath, "utf8"));
    if (
      previous?.schemaVersion !== 1 ||
      previous?.source !== "gsa-ppms" ||
      !Number.isSafeInteger(previous?.itemCount) ||
      previous.itemCount < 10
    ) {
      throw new Error("The prior GSA snapshot metadata was invalid.");
    }
    previousCount = previous.itemCount;
    if (auctions.length < Math.ceil(previousCount * 0.5)) {
      throw new Error(
        `Refusing to publish a collapsed GSA catalog (${auctions.length} of ${previousCount}).`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const generatedAt = now.toISOString();
const imageExpiresAt = new Date(now.getTime() + 55 * 60_000).toISOString();
const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
const revision = createHash("sha256")
  .update(JSON.stringify({ generatedAt, auctions }))
  .digest("hex");
const sourceHealth = {
  source: "GSA Auctions API",
  official: true,
  endpoint: GSA_PPMS_CATALOG_ENDPOINT,
  sourceMode: "ppms-public-catalog",
  status: "live",
  cache: "refresh",
  credentialMode: "public-catalog",
  fetchedAt: generatedAt,
  observedAt: discovery.observedAt,
  cachedUntil: new Date(now.getTime() + GSA_CACHE_SECONDS * 1_000).toISOString(),
  staleSince: null,
  ageSeconds: 0,
  lastErrorCode: null,
  discoveryCadence: "hourly",
  limitations: [...GSA_PUBLIC_FEED_LIMITATIONS],
};

const snapshot = {
  schemaVersion: 1,
  source: "gsa-ppms",
  revision,
  itemCount: auctions.length,
  generatedAt,
  // PPMS image signatures expire after one hour. A 55-minute envelope keeps
  // stale signatures off the public site if a scheduled refresh is delayed,
  // while the non-image vehicle facts remain usable for up to 24 hours.
  expiresAt,
  imageExpiresAt,
  auctions,
  coverage: discovery.coverage,
  sourceHealth,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot)}\n`, "utf8");

console.log(JSON.stringify({
  outputPath,
  auctions: auctions.length,
  withMileage: discovery.coverage.withMileage,
  withImage: discovery.coverage.withImage,
  generatedAt: snapshot.generatedAt,
  expiresAt: snapshot.expiresAt,
  imageExpiresAt: snapshot.imageExpiresAt,
  revision,
  previousCount,
}));
