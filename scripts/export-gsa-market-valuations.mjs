import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fetchClosedGsaVehicleComps } from "../lib/gsa-closed-comps.ts";
import {
  mergeGsaClosedCompCorpus,
  retainedClosedCompCoverage,
  validateGsaClosedCompCorpus,
} from "../lib/gsa-closed-comp-corpus.ts";
import { closedCompSyncWindow } from "../lib/gsa-closed-comp-sync.ts";
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
const corpusPath = resolve(argument("--corpus", "work/gsa-closed-comps.json"));
const lookbackDays = Number.parseInt(argument("--days", "90"), 10);
const retentionDays = Number.parseInt(argument("--retention-days", "366"), 10);
const forceFull = process.argv.includes("--full");
if (!Number.isInteger(lookbackDays) || lookbackDays < 30 || lookbackDays > 366) {
  throw new RangeError("--days must be an integer between 30 and 366.");
}
if (!Number.isInteger(retentionDays) || retentionDays < lookbackDays || retentionDays > 1_825) {
  throw new RangeError("--retention-days must be between --days and 1825.");
}

async function readPreviousCorpus() {
  if (forceFull) return null;
  try {
    return validateGsaClosedCompCorpus(JSON.parse(await readFile(corpusPath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
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
const previousCorpus = await readPreviousCorpus();
let refreshWindow = previousCorpus
  ? closedCompSyncWindow(previousCorpus.refreshedAt, now, {
      bootstrapDays: 7,
      overlapDays: 3,
      maxWindowDays: 30,
    })
  : {
      from: new Date(now.getTime() - lookbackDays * 86_400_000),
      to: now,
      mode: "bootstrap",
    };
const refreshStartedAt = refreshWindow.from;
let corpus = previousCorpus;
let discovery;
let refreshWindows = 0;
do {
  discovery = await fetchClosedGsaVehicleComps(fetch, {
    now,
    from: refreshWindow.from,
    to: refreshWindow.to,
    pageSize: 200,
    detailConcurrency: 6,
    signal: AbortSignal.timeout(240_000),
  });
  if (!corpus && discovery.comparables.length < 25) {
    throw new Error("Refusing to export valuations from a materially empty GSA closed-comp corpus.");
  }
  if (discovery.coverage.detailSucceeded < Math.ceil(discovery.coverage.detailRequested * 0.9)) {
    throw new Error("Refusing to export valuations from a materially incomplete GSA detail corpus.");
  }
  corpus = mergeGsaClosedCompCorpus(corpus, discovery, {
    now,
    coveredThrough: refreshWindow.to,
    retentionDays,
  });
  refreshWindows += 1;
  if (refreshWindow.mode !== "catch-up") break;
  if (refreshWindows >= 20) {
    throw new Error("Refusing to publish before the retained GSA comp corpus catches up completely.");
  }
  refreshWindow = closedCompSyncWindow(corpus.refreshedAt, now, {
    bootstrapDays: 7,
    overlapDays: 3,
    maxWindowDays: 30,
  });
} while (true);

if (!discovery || !corpus) {
  throw new Error("The GSA comp refresh did not produce a retained corpus.");
}
if (corpus.comparables.length < 25) {
  throw new Error("Refusing to export valuations from a materially empty retained GSA comp corpus.");
}

const snapshot = buildGsaMarketValuationSnapshot(subjects, corpus.comparables, {
  generatedAt: now,
  corpus: retainedClosedCompCoverage(corpus),
});
validateGsaMarketValuationSnapshot(snapshot);
if (snapshot.coverage.valuedCount < Math.ceil(subjects.length * 0.5)) {
  throw new Error("Refusing to publish a GSA comp snapshot with implausibly low subject coverage.");
}

const revision = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const output = { ...snapshot, revision };
const temporaryPath = `${outputPath}.tmp`;
const corpusTemporaryPath = `${corpusPath}.tmp`;
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(corpusPath), { recursive: true });
await writeFile(temporaryPath, `${JSON.stringify(output)}\n`, "utf8");
await rename(temporaryPath, outputPath);
// The checkpoint is written only after a complete, validated valuation export.
// If this rename fails, the next run safely repeats the overlapping window.
await writeFile(corpusTemporaryPath, `${JSON.stringify(corpus)}\n`, "utf8");
await rename(corpusTemporaryPath, corpusPath);

console.log(JSON.stringify({
  inputPath,
  outputPath,
  corpusPath,
  lookbackDays,
  retentionDays,
  refreshWindows,
  refreshMode: refreshWindow.mode,
  refreshFrom: refreshStartedAt.toISOString(),
  refreshTo: refreshWindow.to.toISOString(),
  activeSubjects: subjects.length,
  closedCatalogRows: discovery.coverage.catalogRows,
  usableClosedHighBids: discovery.coverage.usableClosedHighBids,
  retainedClosedHighBids: corpus.comparables.length,
  detailSucceeded: discovery.coverage.detailSucceeded,
  valuedCount: snapshot.coverage.valuedCount,
  unavailableCount: snapshot.coverage.unavailableCount,
  basisCounts: snapshot.coverage.basisCounts,
  generatedAt: snapshot.generatedAt,
  revision,
}));
