import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getGsaVehicleAuctions } from "../lib/gsa-client.ts";
import { prepareGsaRunnerSnapshot } from "../lib/gsa-snapshot-export.ts";

const outputPath = resolve(process.argv[2] ?? "work/gsa-vehicles.json");
const now = new Date();
const discovery = await getGsaVehicleAuctions({
  apiKey: process.env.GSA_API_KEY,
  forceRefresh: true,
  now,
});
const prepared = prepareGsaRunnerSnapshot(discovery, now);
const { auctions, coverage, generatedAt, expiresAt, imageExpiresAt } = prepared;
const revision = createHash("sha256")
  .update(JSON.stringify({ generatedAt, auctions }))
  .digest("hex");

const snapshot = {
  schemaVersion: 1,
  source: prepared.source,
  revision,
  itemCount: auctions.length,
  generatedAt,
  expiresAt,
  imageExpiresAt,
  auctions,
  coverage,
  sourceHealth: discovery.sourceHealth,
};

const serialized = `${JSON.stringify(snapshot)}\n`;
if (Buffer.byteLength(serialized, "utf8") > 6 * 1024 * 1024) {
  throw new Error("Refusing to publish a GSA snapshot above the six-megabyte reader limit.");
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");

console.log(JSON.stringify({
  outputPath,
  auctions: auctions.length,
  withMileage: coverage.withMileage,
  withImage: coverage.withImage,
  sourceMode: discovery.sourceHealth.sourceMode,
  credentialMode: discovery.sourceHealth.credentialMode,
  generatedAt: snapshot.generatedAt,
  expiresAt: snapshot.expiresAt,
  imageExpiresAt: snapshot.imageExpiresAt,
  revision,
}));
