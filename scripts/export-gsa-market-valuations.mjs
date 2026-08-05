import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fetchClosedGsaVehicleComps } from "../lib/gsa-closed-comps.ts";
import {
  buildGsaMarketValuationSnapshot,
  validateGsaMarketValuationSnapshot,
} from "../lib/gsa-market-valuations.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const inputPath = resolve(argument("--input", "work/gsa-vehicles.json"));
const outputPath = resolve(argument("--output", "public/market-valuations.json"));
const lookbackDays = Number.parseInt(argument("--days", "90"), 10);
if (!Number.isInteger(lookbackDays) || lookbackDays < 30 || lookbackDays > 366) {
  throw new RangeError("--days must be an integer between 30 and 366.");
}

const activeSnapshot = JSON.parse(await readFile(inputPath, "utf8"));
if (!record(activeSnapshot) || !Array.isArray(activeSnapshot.auctions)) {
  throw new TypeError("The active GSA snapshot is missing its auctions array.");
}
const subjects = activeSnapshot.auctions
  .filter((auction) => record(auction) && auction.status === "active")
  .map((auction) => ({
    id: String(auction.id),
    externalId: String(auction.url ?? "").match(/\/preview\/(\d+)/)?.[1] ?? null,
    sourceUrl: String(auction.url),
    title: String(auction.title),
    year: Number.isInteger(auction.year) ? auction.year : null,
    make: typeof auction.make === "string" ? auction.make : null,
    modelLabel: typeof auction.modelLabel === "string" ? auction.modelLabel : null,
    mileage: Number.isInteger(auction.mileage) && auction.mileage >= 0 ? auction.mileage : null,
    bodyType: typeof auction.bodyType === "string" ? auction.bodyType : null,
    condition: typeof auction.condition === "string" ? auction.condition : "unknown",
    operability: typeof auction.operability === "string" ? auction.operability : "unknown",
    damageFlags: Array.isArray(auction.damageFlags) ? auction.damageFlags.map(String) : [],
    issueFlags: Array.isArray(auction.issueFlags) ? auction.issueFlags.map(String) : [],
  }));
if (subjects.length < 10) {
  throw new Error("Refusing to export valuations without a credible active-vehicle subject set.");
}

const now = new Date();
const discovery = await fetchClosedGsaVehicleComps(fetch, {
  now,
  lookbackDays,
  pageSize: 200,
  detailConcurrency: 6,
  signal: AbortSignal.timeout(240_000),
});
if (discovery.comparables.length < 25) {
  throw new Error("Refusing to export valuations from a materially empty GSA closed-comp corpus.");
}
if (discovery.coverage.detailSucceeded < Math.ceil(discovery.coverage.detailRequested * 0.9)) {
  throw new Error("Refusing to export valuations from a materially incomplete GSA detail corpus.");
}

const snapshot = buildGsaMarketValuationSnapshot(subjects, discovery.comparables, {
  generatedAt: now,
  corpus: discovery.coverage,
});
validateGsaMarketValuationSnapshot(snapshot);
if (snapshot.coverage.valuedCount < Math.ceil(subjects.length * 0.5)) {
  throw new Error("Refusing to publish a GSA comp snapshot with implausibly low subject coverage.");
}

const revision = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const output = { ...snapshot, revision };
const temporaryPath = `${outputPath}.tmp`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(temporaryPath, `${JSON.stringify(output)}\n`, "utf8");
await rename(temporaryPath, outputPath);

console.log(JSON.stringify({
  inputPath,
  outputPath,
  lookbackDays,
  activeSubjects: subjects.length,
  closedCatalogRows: discovery.coverage.catalogRows,
  usableClosedHighBids: discovery.coverage.usableClosedHighBids,
  detailSucceeded: discovery.coverage.detailSucceeded,
  valuedCount: snapshot.coverage.valuedCount,
  unavailableCount: snapshot.coverage.unavailableCount,
  basisCounts: snapshot.coverage.basisCounts,
  generatedAt: snapshot.generatedAt,
  revision,
}));
