import type { AuctionOpportunity, AuctionStatus } from "./auction-types.ts";
import {
  buildGsaFleetComparableIndex,
  buildGsaFleetOutcomeValuation,
  gsaFleetComparableCandidates,
  gsaFleetComparableCandidatesForSubject,
  gsaFleetListingToOpportunity,
  type GsaFleetComparableIndex,
} from "./gsa-fleet-adapter.ts";
import {
  enrichGsaFleetVehicleDetails,
  fetchGsaFleetActiveListings,
  fetchGsaFleetClosedResults,
  type GsaFleetVehicleDetail,
} from "./gsa-fleet-client.ts";
import { resolveGsaFleetComparableIndex } from "./gsa-fleet-comparable-store.ts";
import { getGsaVehicleAuctions, type GsaDiscoveryResult } from "./gsa-client.ts";
import type { GsaCoverage, GsaVehicleAuction } from "./gsa-normalizer.ts";
import {
  fetchGsaRunnerSnapshot,
  type GsaRunnerSnapshot,
} from "./gsa-runner-snapshot.ts";
import {
  applyValuationToOpportunity,
  discoveryToOpportunity,
} from "./opportunity-adapter.ts";
import { compactOpportunityForBoard } from "./opportunity-presentation.ts";
import { applyLiveBidSnapshot } from "./live-bid-snapshot.ts";

export const DEAL_BOARD_CACHE_KEY = "deal-board";
export const DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION = 1;
// Reuse the existing Fleet-outcome trigger so the Worker stays within the
// five-trigger limit on Cloudflare's Free plan.
export const DEAL_BOARD_SNAPSHOT_REBUILD_CRON = "49 * * * *";

const DEFAULT_MAX_AGE_MS = 70 * 60_000;
const DEFAULT_DETAIL_LIMIT = 100;
const MAX_SNAPSHOT_ITEMS = 10_000;
const MAX_GENERATION_JSON_BYTES = 64 * 1024 * 1024;
const MAX_FULL_ROW_JSON_BYTES = 96 * 1024;
const MAX_BOARD_ROW_JSON_BYTES = 48 * 1024;
const MAX_METADATA_JSON_BYTES = 256 * 1024;
const MAX_INDEX_JSON_BYTES = 1_500_000;
const MAX_CHUNK_JSON_BYTES = 1_500_000;
const TARGET_CHUNK_JSON_BYTES = 1_400_000;
const MAX_SNAPSHOT_CHUNKS = 40;
const CHUNK_READ_PAGE_SIZE = 10;
const CHUNKS_PER_WRITE = 9;
// D1 currently allows 100 bound parameters per statement. Each keyed auction
// lookup consumes two, leaving room for future predicates without approaching
// the platform limit.
const AUCTION_LOOKUP_PAIR_BATCH_SIZE = 45;
const BID_HISTORY_LOOKUP_BATCH_SIZE = 90;
const BID_HISTORY_POINTS_PER_AUCTION = 24;
const ABANDONED_BUILD_LEASE_MS = 20 * 60_000;
const GSA_RETAIN_MAX_AGE_MS = 24 * 60 * 60_000;
// Two complete generations provide rollback safety without retaining an
// unbounded duplicate of the roughly 4,000-row Fleet inventory.
const RETAIN_COMPLETE_GENERATIONS = 2;
const AUCTION_STATUSES = new Set<unknown>([
  "preview", "active", "closing", "ended", "sold", "unsold", "cancelled",
]);

type JsonRecord = Record<string, unknown>;

type GsaFetcher = typeof getGsaVehicleAuctions;
type GsaRunnerFetcher = typeof fetchGsaRunnerSnapshot;
type FleetActiveFetcher = typeof fetchGsaFleetActiveListings;
type FleetClosedFetcher = typeof fetchGsaFleetClosedResults;
type FleetDetailEnricher = typeof enrichGsaFleetVehicleDetails;

export interface DealBoardSnapshotBuildOptions {
  now?: Date;
  apiKey?: string;
  signal?: AbortSignal;
  maxAgeMs?: number;
  detailLimit?: number;
  getGsaAuctions?: GsaFetcher;
  getGsaRunnerSnapshot?: GsaRunnerFetcher;
  getFleetActive?: FleetActiveFetcher;
  getFleetClosed?: FleetClosedFetcher;
  enrichFleetDetails?: FleetDetailEnricher;
  /** Compact authoritative outcomes preloaded from D1 for Worker-safe builds. */
  fleetComparableIndex?: GsaFleetComparableIndex;
  fleetComparableObservedAt?: string | null;
}

export interface BuiltDealBoardSnapshot {
  generatedAt: string;
  expiresAt: string;
  opportunities: AuctionOpportunity[];
  metadata: JsonRecord;
  gsaInventoryMode: "live" | "runner-snapshot" | "retained-snapshot" | "unavailable";
}

export interface PersistedDealBoardSnapshot {
  snapshotId: string;
  generatedAt: string;
  expiresAt: string;
  itemCount: number;
}

export interface ServedDealBoardSnapshot {
  snapshotId: string;
  generatedAt: string;
  refreshedAt: string;
  expiresAt: string;
  stale: boolean;
  data: AuctionOpportunity[];
  meta: JsonRecord;
}

export interface DealBoardBidReconciliationSummary {
  snapshotId: string | null;
  considered: number;
  updated: number;
  reconciledAt: string;
}

export interface DealBoardBackgroundContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface DealBoardSnapshotFreshness {
  snapshotId: string;
  generatedAt: string;
  expiresAt: string;
  itemCount: number;
  fresh: boolean;
}

let pendingOnDemandSnapshotTask: Promise<void> | null = null;
const ON_DEMAND_SNAPSHOT_LEASE_ID = "deal-board:on-demand-warm-lease";
const ON_DEMAND_SNAPSHOT_LEASE_CODE = "DEAL_BOARD_ON_DEMAND_WARM_LEASE";
const ON_DEMAND_SNAPSHOT_COOLDOWN_CODE = "DEAL_BOARD_ON_DEMAND_WARM_COOLDOWN";
const ON_DEMAND_SNAPSHOT_FAILURE_COOLDOWN_MS = 5 * 60_000;

/** Coalesces request-triggered cache warming within one Worker isolate. */
export function scheduleDealBoardSnapshotTask(
  context: DealBoardBackgroundContext | null,
  task: () => Promise<unknown>,
): boolean {
  if (!context || pendingOnDemandSnapshotTask) return false;
  const pending = Promise.resolve()
    .then(task)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (pendingOnDemandSnapshotTask === pending) {
        pendingOnDemandSnapshotTask = null;
      }
    });
  pendingOnDemandSnapshotTask = pending;
  context.waitUntil(pending);
  return true;
}

/**
 * Claims a D1-backed lease before public request warming. The fixed primary
 * key makes the warm endpoint idempotent across Worker isolates, while the
 * freshness predicate avoids rebuilding a board with more than ten minutes
 * of useful life remaining.
 */
export async function runWithDealBoardSnapshotLease<T>(
  db: D1Database,
  task: () => Promise<T>,
  options: {
    now?: Date;
    minimumFreshMs?: number;
    skipFreshSnapshot?: boolean;
  } = {},
): Promise<
  | { status: "executed"; value: T }
  | { status: "busy" }
  | { status: "cooldown"; retryAt: string }
  | { status: "skipped" }
> {
  const now = validDate(options.now ?? new Date(), "now");
  const minimumFreshMs = options.minimumFreshMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(minimumFreshMs) ||
    minimumFreshMs < 0 ||
    minimumFreshMs > 60 * 60_000
  ) {
    throw new RangeError("minimumFreshMs must be between 0 and 3600000.");
  }
  const nowIso = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - ABANDONED_BUILD_LEASE_MS,
  ).toISOString();
  await db.prepare(
    `DELETE FROM deal_board_snapshots
     WHERE id = ?1 AND (
       (status = 'building'
         AND error_code = '${ON_DEMAND_SNAPSHOT_LEASE_CODE}'
         AND updated_at < ?2)
       OR
       (status = 'failed'
         AND error_code = '${ON_DEMAND_SNAPSHOT_COOLDOWN_CODE}'
         AND expires_at <= ?3)
     )`,
  ).bind(ON_DEMAND_SNAPSHOT_LEASE_ID, staleBefore, nowIso).run();

  const freshUntil = new Date(now.getTime() + minimumFreshMs).toISOString();
  const skipFreshPredicate = options.skipFreshSnapshot === false
    ? ""
    : `WHERE NOT EXISTS (
         SELECT 1 FROM deal_board_snapshots
         WHERE cache_key = ?2 AND schema_version = ?3
           AND status = 'complete' AND expires_at > ?5
       )`;
  const claimStatement = db.prepare(
    `INSERT OR IGNORE INTO deal_board_snapshots (
       id, cache_key, schema_version, status, generated_at, refreshed_at,
       expires_at, item_count, metadata_json, opportunity_index_json,
       error_code, error_message, created_at, updated_at
     ) SELECT ?1, ?2, ?3, 'building', ?4, ?4, ?4, 0, '{}', '{}',
       '${ON_DEMAND_SNAPSHOT_LEASE_CODE}', NULL, ?4, ?4
     ${skipFreshPredicate}`,
  );
  const claimed = await (options.skipFreshSnapshot === false
    ? claimStatement.bind(
        ON_DEMAND_SNAPSHOT_LEASE_ID,
        DEAL_BOARD_CACHE_KEY,
        DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION,
        nowIso,
      )
    : claimStatement.bind(
        ON_DEMAND_SNAPSHOT_LEASE_ID,
        DEAL_BOARD_CACHE_KEY,
        DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION,
        nowIso,
        freshUntil,
      )).run();
  if (Number(claimed.meta.changes) !== 1) {
    const existing = await db.prepare(
      `SELECT status, expires_at, error_code
       FROM deal_board_snapshots
       WHERE id = ?1
       LIMIT 1`,
    ).bind(ON_DEMAND_SNAPSHOT_LEASE_ID).first<{
      status: string;
      expires_at: string;
      error_code: string | null;
    }>();
    if (
      existing?.status === "failed" &&
      existing.error_code === ON_DEMAND_SNAPSHOT_COOLDOWN_CODE &&
      Date.parse(existing.expires_at) > now.getTime()
    ) {
      return { status: "cooldown", retryAt: existing.expires_at };
    }
    if (
      existing?.status === "building" &&
      existing.error_code === ON_DEMAND_SNAPSHOT_LEASE_CODE
    ) {
      return { status: "busy" };
    }
    return { status: "skipped" };
  }

  try {
    const value = await task();
    try {
      await db.prepare(
        `DELETE FROM deal_board_snapshots
         WHERE id = ?1 AND status = 'building'
           AND error_code = '${ON_DEMAND_SNAPSHOT_LEASE_CODE}'`,
      ).bind(ON_DEMAND_SNAPSHOT_LEASE_ID).run();
    } catch {
      // The completed generation is authoritative. A stranded lease is reaped
      // after its bounded lifetime and must not turn a successful rebuild into
      // a false public failure.
    }
    return { status: "executed", value };
  } catch (error) {
    const detail = errorDetail(error);
    const retryAt = new Date(
      now.getTime() + ON_DEMAND_SNAPSHOT_FAILURE_COOLDOWN_MS,
    ).toISOString();
    try {
      await db.prepare(
        `UPDATE deal_board_snapshots SET
           status = 'failed', expires_at = ?2,
           error_code = '${ON_DEMAND_SNAPSHOT_COOLDOWN_CODE}',
           error_message = ?3, updated_at = ?4
         WHERE id = ?1 AND status = 'building'
           AND error_code = '${ON_DEMAND_SNAPSHOT_LEASE_CODE}'`,
      ).bind(
        ON_DEMAND_SNAPSHOT_LEASE_ID,
        retryAt,
        detail.message,
        nowIso,
      ).run();
    } catch {
      // Preserve the source failure. The original building lease still
      // throttles retries and is eventually recovered as abandoned.
    }
    throw error;
  }
}

interface SnapshotRow {
  id: string;
  generated_at: string;
  refreshed_at: string;
  expires_at: string;
  item_count: number;
  metadata_json: string;
  opportunity_index_json: string;
}

interface SnapshotChunkRow {
  id: string;
  chunk_index: number;
  item_count: number;
  payload_count: number;
  active_count: number;
  contains_gsa_auctions: number;
  contains_gsa_fleet: number;
  payload_json: string;
  board_json: string;
}

interface StoredAuctionState {
  id: string;
  source_key: string;
  external_id: string;
  status: AuctionStatus;
  current_bid_cents: number | null;
  bidder_count: number | null;
  ends_at: string | null;
  last_checked_at: string;
}

interface StoredBidObservation {
  auction_id: string;
  observed_at: string;
  current_bid_cents: number;
  bidder_count: number | null;
}

interface SerializedChunk {
  id: string;
  snapshotId: string;
  chunkIndex: number;
  itemCount: number;
  payloadCount: number;
  activeCount: number;
  containsGsaAuctions: boolean;
  containsGsaFleet: boolean;
  payloadJson: string;
  boardJson: string;
}

interface ResolvedGsaInventory {
  discovery: GsaDiscoveryResult;
  mode: "live" | "runner-snapshot";
  imageExpiresAt: string;
  directErrorCode: string | null;
  runnerRevision: string | null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function trackedForBidRefresh(opportunity: AuctionOpportunity): boolean {
  return opportunity.status === "active" || opportunity.status === "closing";
}

function chunkSortRank(opportunity: AuctionOpportunity): number {
  const activeRank = trackedForBidRefresh(opportunity) ? 0 : 2;
  return activeRank + (opportunity.source === "gsa-auctions" ? 0 : 1);
}

function buildSnapshotChunks(
  snapshotId: string,
  sourceOpportunities: readonly AuctionOpportunity[],
): { chunks: SerializedChunk[]; indexJson: string; generationBytes: number } {
  const chunks: SerializedChunk[] = [];
  const index: Record<string, number> = {};
  let payloadRows: string[] = [];
  let boardRows: string[] = [];
  let opportunities: AuctionOpportunity[] = [];
  let combinedBytes = 4; // Two empty JSON array pairs.
  let generationBytes = 0;

  function flush(): void {
    if (opportunities.length === 0) return;
    const chunkIndex = chunks.length;
    const payloadJson = `[${payloadRows.join(",")}]`;
    const boardJson = `[${boardRows.join(",")}]`;
    chunks.push({
      id: `${snapshotId}:chunk:${chunkIndex}`,
      snapshotId,
      chunkIndex,
      itemCount: opportunities.length,
      payloadCount: payloadRows.length,
      activeCount: opportunities.filter(trackedForBidRefresh).length,
      containsGsaAuctions: opportunities.some((item) => item.source === "gsa-auctions"),
      containsGsaFleet: opportunities.some((item) => item.source === "gsa-fleet"),
      payloadJson,
      boardJson,
    });
    for (const opportunity of opportunities) {
      index[`id:${opportunity.id}`] = chunkIndex;
      if (index[`external:${opportunity.externalId}`] === undefined) {
        index[`external:${opportunity.externalId}`] = chunkIndex;
      }
    }
    generationBytes += utf8Bytes(payloadJson) + utf8Bytes(boardJson);
    payloadRows = [];
    boardRows = [];
    opportunities = [];
    combinedBytes = 4;
  }

  const sorted = [...sourceOpportunities].sort((left, right) =>
    chunkSortRank(left) - chunkSortRank(right) || left.id.localeCompare(right.id)
  );
  for (const opportunity of sorted) {
    const tracked = trackedForBidRefresh(opportunity);
    // Serialize one row at a time. Retaining a 4k-row intermediate string
    // array doubled peak memory before the chunk strings were assembled.
    const payloadJson = tracked ? JSON.stringify(opportunity) : "";
    const boardJson = JSON.stringify(
      tracked ? compactOpportunityForBoard(opportunity) : opportunity,
    );
    const fullBytes = payloadJson ? utf8Bytes(payloadJson) : 0;
    const boardBytes = utf8Bytes(boardJson);
    if (fullBytes > MAX_FULL_ROW_JSON_BYTES || boardBytes > MAX_BOARD_ROW_JSON_BYTES) {
      throw new TypeError("One deal-board opportunity exceeds the bounded cache row size.");
    }
    const separatorBytes = (payloadRows.length > 0 && payloadJson ? 1 : 0) +
      (boardRows.length > 0 ? 1 : 0);
    const nextBytes = fullBytes + boardBytes + separatorBytes;
    if (opportunities.length > 0 && combinedBytes + nextBytes > TARGET_CHUNK_JSON_BYTES) {
      flush();
    }
    if (combinedBytes + nextBytes > MAX_CHUNK_JSON_BYTES) {
      throw new TypeError("One deal-board opportunity cannot fit in a bounded cache chunk.");
    }
    if (payloadJson) payloadRows.push(payloadJson);
    boardRows.push(boardJson);
    opportunities.push(opportunity);
    combinedBytes += nextBytes;
  }
  flush();
  if (chunks.length === 0 || chunks.length > MAX_SNAPSHOT_CHUNKS) {
    throw new TypeError("The deal-board generation exceeds the bounded cache chunk count.");
  }
  if (generationBytes > MAX_GENERATION_JSON_BYTES) {
    throw new TypeError("The deal-board generation exceeds the bounded cache size.");
  }
  const indexJson = JSON.stringify(index);
  if (utf8Bytes(indexJson) > MAX_INDEX_JSON_BYTES) {
    throw new TypeError("The deal-board opportunity index exceeds the bounded cache size.");
  }
  return { chunks, indexJson, generationBytes };
}

function chunkInsertSql(count: number, updateExisting: boolean): string {
  let parameter = 1;
  const values = Array.from({ length: count }, () => {
    const placeholders = Array.from({ length: 11 }, () => `?${parameter++}`);
    return `(${placeholders.join(", ")}, ${placeholders[10]})`;
  }).join(", ");
  const conflict = updateExisting
    ? ` ON CONFLICT(id) DO UPDATE SET
        item_count = excluded.item_count,
        payload_count = excluded.payload_count,
        active_count = excluded.active_count,
        contains_gsa_auctions = excluded.contains_gsa_auctions,
        contains_gsa_fleet = excluded.contains_gsa_fleet,
        payload_json = excluded.payload_json,
        board_json = excluded.board_json,
        updated_at = excluded.updated_at`
    : "";
  return `INSERT INTO deal_board_snapshot_chunks (
    id, snapshot_id, chunk_index, item_count, payload_count, active_count,
    contains_gsa_auctions, contains_gsa_fleet, payload_json, board_json,
    created_at, updated_at
  ) VALUES ${values}${conflict}`;
}

function snapshotChunkStatements(
  db: D1Database,
  chunksToWrite: readonly SerializedChunk[],
  observedAt: string,
  updateExisting: boolean,
): D1PreparedStatement[] {
  return chunks(chunksToWrite, CHUNKS_PER_WRITE).map((group) => {
    const args = group.flatMap((chunk) => [
      chunk.id,
      chunk.snapshotId,
      chunk.chunkIndex,
      chunk.itemCount,
      chunk.payloadCount,
      chunk.activeCount,
      chunk.containsGsaAuctions ? 1 : 0,
      chunk.containsGsaFleet ? 1 : 0,
      chunk.payloadJson,
      chunk.boardJson,
      observedAt,
    ]);
    return db.prepare(chunkInsertSql(group.length, updateExisting)).bind(...args);
  });
}

async function writeSnapshotChunks(
  db: D1Database,
  chunksToWrite: readonly SerializedChunk[],
  observedAt: string,
): Promise<void> {
  // Partial staged chunks are invisible while the parent generation is still
  // `building`, so keep large generation writes in bounded statements.
  for (const statement of snapshotChunkStatements(
    db,
    chunksToWrite,
    observedAt,
    false,
  )) {
    await statement.run();
  }
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function activeAt(auction: GsaVehicleAuction, nowMs: number): boolean {
  return auction.status === "active" &&
    (auction.endsAt === null || Date.parse(auction.endsAt) > nowMs);
}

function gsaCoverageForActive(
  original: GsaCoverage,
  auctions: readonly GsaVehicleAuction[],
): GsaCoverage {
  const enriched = auctions.filter((auction) => auction.detailEnriched !== false).length;
  const imageCount = auctions.reduce((total, auction) => total + auction.images.length, 0);
  return {
    ...original,
    totalLots: auctions.length + original.excludedLots,
    vehicleLots: auctions.length,
    withVin: auctions.filter((auction) => auction.vin !== null).length,
    withMileage: auctions.filter((auction) => auction.mileage !== null).length,
    withBodyType: auctions.filter((auction) => auction.bodyType !== null).length,
    withImage: auctions.filter((auction) => auction.imageUrl !== null).length,
    withCurrentBid: auctions.filter((auction) => auction.currentBid !== null).length,
    statusCounts: { active: auctions.length, preview: 0, scheduled: 0, unknown: 0 },
    detailEnrichment: {
      requested: auctions.length,
      succeeded: enriched,
      failed: auctions.length - enriched,
      imagesDiscovered: imageCount,
      imagesSigned: imageCount,
    },
  };
}

function attachFleetOutcomeEvidence(
  auction: GsaVehicleAuction,
  opportunity: AuctionOpportunity,
  index: GsaFleetComparableIndex,
  observedAt: string,
): AuctionOpportunity {
  const subject = {
    id: opportunity.id,
    externalId: opportunity.externalId,
    sourceUrl: opportunity.sourceUrl,
    title: opportunity.title,
    year: auction.year,
    make: auction.make,
    modelLabel: auction.modelLabel,
    vin: auction.vin,
    mileage: auction.mileage,
    bodyType: auction.bodyType,
    condition: auction.condition,
    operability: auction.operability,
    damageFlags: auction.damageFlags,
    issueFlags: auction.issueFlags,
  };
  const evidence = buildGsaFleetOutcomeValuation(
    subject,
    gsaFleetComparableCandidatesForSubject(subject, index),
    observedAt,
  );
  if (evidence.valuation.status === "unavailable") return opportunity;
  return applyValuationToOpportunity(
    opportunity,
    evidence.valuation,
    observedAt,
    evidence.terminalOutcomes,
  );
}

function snapshotExpiry(
  now: Date,
  maxAgeMs: number,
  imageExpiresAt: string | null,
): string {
  const maximum = now.getTime() + maxAgeMs;
  const imageExpiry = imageExpiresAt ? Date.parse(imageExpiresAt) : Number.NaN;
  const expiry = Number.isFinite(imageExpiry) && imageExpiry > now.getTime()
    ? Math.min(maximum, imageExpiry)
    : maximum;
  return new Date(expiry).toISOString();
}

function runnerDiscovery(
  snapshot: GsaRunnerSnapshot,
  now: Date,
  directErrorCode: string,
): GsaDiscoveryResult {
  return {
    auctions: snapshot.auctions,
    coverage: snapshot.coverage,
    sourceHealth: {
      ...snapshot.sourceHealth,
      status: "stale",
      cache: "stale-fallback",
      staleSince: snapshot.generatedAt,
      ageSeconds: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(snapshot.generatedAt)) / 1_000),
      ),
      lastErrorCode: directErrorCode,
    },
  };
}

async function resolveGsaInventory(
  now: Date,
  options: DealBoardSnapshotBuildOptions,
): Promise<ResolvedGsaInventory | null> {
  let directErrorCode = "DEAL_BOARD_GSA_DIRECT_UNAVAILABLE";
  try {
    const discovery = await (options.getGsaAuctions ?? getGsaVehicleAuctions)({
      apiKey: options.apiKey,
      forceRefresh: true,
      now,
    });
    if (discovery.sourceHealth.status === "live") {
      return {
        discovery,
        mode: "live",
        imageExpiresAt: discovery.sourceHealth.cachedUntil,
        directErrorCode: null,
        runnerRevision: null,
      };
    }
    directErrorCode = discovery.sourceHealth.lastErrorCode ?? "DEAL_BOARD_GSA_STALE_FALLBACK";
  } catch (error) {
    directErrorCode = errorDetail(error).code;
  }

  try {
    const runner = await (options.getGsaRunnerSnapshot ?? fetchGsaRunnerSnapshot)({ now });
    return {
      discovery: runnerDiscovery(runner, now, directErrorCode),
      mode: "runner-snapshot",
      imageExpiresAt: runner.imageExpiresAt,
      directErrorCode,
      runnerRevision: runner.revision,
    };
  } catch {
    return null;
  }
}

/** Builds one point-in-time board while retaining source-specific freshness. */
export async function buildDealBoardSnapshot(
  options: DealBoardSnapshotBuildOptions = {},
): Promise<BuiltDealBoardSnapshot> {
  const now = validDate(options.now ?? new Date(), "now");
  const maxAgeMs = boundedInteger(
    options.maxAgeMs,
    DEFAULT_MAX_AGE_MS,
    5 * 60_000,
    2 * 60 * 60_000,
    "maxAgeMs",
  );
  const detailLimit = boundedInteger(
    options.detailLimit,
    DEFAULT_DETAIL_LIMIT,
    0,
    100,
    "detailLimit",
  );
  const sourceSignal = options.signal ?? AbortSignal.timeout(45_000);
  const [gsaInventory, fleetActive] = await Promise.all([
    resolveGsaInventory(now, options),
    (options.getFleetActive ?? fetchGsaFleetActiveListings)({
      forceRefresh: true,
      now,
      pageSize: 10_000,
      maxRows: 10_000,
      signal: sourceSignal,
      cacheResult: false,
    }),
  ]);
  if (
    !fleetActive.complete ||
    fleetActive.rows.length === 0 ||
    fleetActive.rows.length !== fleetActive.advertisedCount
  ) {
    const error = new Error(
      "An incomplete GSA Fleet response cannot replace the last complete deal-board snapshot.",
    ) as Error & { code: string };
    error.code = "DEAL_BOARD_FLEET_INCOMPLETE";
    throw error;
  }

  let comparableIndex = options.fleetComparableIndex ?? null;
  let comparableObservedAt = options.fleetComparableObservedAt ?? null;
  if (comparableIndex) {
    if (comparableIndex.all.length === 0) {
      const error = new Error(
        "The durable GSA Fleet comparable corpus is empty.",
      ) as Error & { code: string };
      error.code = "DEAL_BOARD_FLEET_COMPARABLE_STORE_EMPTY";
      throw error;
    }
  } else {
    // Retained for deterministic tests and non-Worker tooling. Production
    // rebuilds inject the compact D1 index and never materialize this corpus.
    const fleetClosed = await (options.getFleetClosed ?? fetchGsaFleetClosedResults)({
      forceRefresh: true,
      now,
      pageSize: 5_000,
      maxRows: 25_000,
      signal: sourceSignal,
      cacheResult: false,
    });
    if (
      !fleetClosed.complete ||
      fleetClosed.rows.length === 0 ||
      fleetClosed.rows.length !== fleetClosed.advertisedCount
    ) {
      const error = new Error(
        "An incomplete GSA Fleet comparable response cannot replace the last complete deal-board snapshot.",
      ) as Error & { code: string };
      error.code = "DEAL_BOARD_FLEET_INCOMPLETE";
      throw error;
    }
    comparableIndex = buildGsaFleetComparableIndex(fleetClosed.rows);
    comparableObservedAt = fleetClosed.observedAt;
  }
  const visibleFleetRows = fleetActive.rows.filter((row) =>
    row.phase === "coming" || row.phase === "active"
  );
  const detailRows = visibleFleetRows
    .filter((row) => row.phase === "active" && row.channel === "internet" && row.vin)
    .slice(0, detailLimit);
  const details = new Map<string, GsaFleetVehicleDetail>();
  let detailSucceeded = 0;
  if (detailRows.length > 0) {
    try {
      const enriched = await (options.enrichFleetDetails ?? enrichGsaFleetVehicleDetails)(
        detailRows,
        {
          now,
          concurrency: 6,
          maxVehicles: Math.max(1, detailLimit),
          signal: options.signal ?? AbortSignal.timeout(15_000),
        },
      );
      for (const item of enriched.vehicles) {
        if (item.detail) details.set(item.listing.sourceId, item.detail);
      }
      detailSucceeded = enriched.succeeded;
    } catch {
      // Optional detail/gallery enrichment must not erase complete listings.
    }
  }

  const fleetOpportunities = visibleFleetRows.map((row) => {
    const opportunity = gsaFleetListingToOpportunity(
      row,
      gsaFleetComparableCandidates(row, comparableIndex),
      details.get(row.sourceId),
    );
    // Coming Soon is large (~4k rows) and cannot retain detail-only ledgers in
    // a 128 MB Worker. Its board model still includes mileage, condition,
    // valuation, forecast, and assessment; activation rebuilds the full row.
    return trackedForBidRefresh(opportunity)
      ? opportunity
      : compactOpportunityForBoard(opportunity);
  });
  const gsaDiscovery = gsaInventory?.discovery ?? null;
  const activeGsaAuctions = (gsaDiscovery?.auctions ?? []).filter((auction) =>
    activeAt(auction, now.getTime())
  );
  const gsaOpportunities = activeGsaAuctions.map((auction) => {
    const opportunity = discoveryToOpportunity(
      auction,
      gsaDiscovery!.sourceHealth.observedAt,
    );
    return attachFleetOutcomeEvidence(
      auction,
      opportunity,
      comparableIndex,
      gsaDiscovery!.sourceHealth.observedAt,
    );
  });
  const opportunities = [...gsaOpportunities, ...fleetOpportunities];
  if (opportunities.length === 0 || opportunities.length > MAX_SNAPSHOT_ITEMS) {
    const error = new Error(
      "The official sources returned an implausible deal-board inventory size.",
    ) as Error & { code: string };
    error.code = "DEAL_BOARD_IMPLAUSIBLE_INVENTORY";
    throw error;
  }

  const gsaCoverage = gsaDiscovery
    ? gsaCoverageForActive(gsaDiscovery.coverage, activeGsaAuctions)
    : null;
  const activeInternetCount = visibleFleetRows.filter((row) =>
    row.channel === "internet" && row.phase === "active"
  ).length;
  const comingCount = visibleFleetRows.filter((row) => row.phase === "coming").length;
  const generatedAt = now.toISOString();
  const expiresAt = snapshotExpiry(now, maxAgeMs, gsaInventory?.imageExpiresAt ?? null);
  const gsaSourceHealth = gsaDiscovery?.sourceHealth ?? {
    status: "unavailable",
    cache: "unavailable",
    discoveryCadence: "hourly",
    lastErrorCode: "GSA_DIRECT_AND_RUNNER_UNAVAILABLE",
  };
  return {
    generatedAt,
    expiresAt,
    opportunities,
    gsaInventoryMode: gsaInventory?.mode ?? "unavailable",
    metadata: {
      mode: gsaInventory?.mode === "live"
        ? "official-gsa-auctions-and-fleet"
        : gsaInventory?.mode === "runner-snapshot"
          ? "official-gsa-fleet-with-gsa-auctions-snapshot"
          : "official-gsa-fleet-only",
      coverage: {
        ...(gsaCoverage ?? {}),
        vehicleLots: opportunities.length,
        sources: {
          gsaAuctions: gsaOpportunities.length,
          gsaFleet: fleetOpportunities.length,
          gsaFleetAdvertised: fleetActive.advertisedCount,
          gsaFleetActiveInternet: activeInternetCount,
          gsaFleetComing: comingCount,
          gsaFleetClosedOutcomes: comparableIndex.all.length,
          gsaFleetDetails: detailSucceeded,
        },
      },
      sourceHealth: {
        ...gsaSourceHealth,
        status: gsaInventory?.mode === "live"
          ? "live"
          : gsaInventory?.mode === "runner-snapshot"
            ? "stale"
            : "partial",
        delivery: gsaInventory?.mode === "runner-snapshot"
          ? "github-branch-snapshot"
          : gsaInventory?.mode === "live"
            ? "direct-official-source"
            : "gsa-fleet-only",
        gsaRunnerRevision: gsaInventory?.runnerRevision ?? null,
        gsaDirectErrorCode: gsaInventory?.directErrorCode ?? null,
        liveBidPolling: (
          gsaInventory?.mode === "live" &&
          gsaDiscovery?.sourceHealth.sourceMode === "ppms-public-catalog"
        ) || activeInternetCount > 0,
        liveBidPollingBySource: {
          "gsa-auctions": gsaInventory?.mode === "live" &&
            gsaDiscovery?.sourceHealth.sourceMode === "ppms-public-catalog",
          "gsa-fleet": activeInternetCount > 0,
        },
        fleetObservedAt: fleetActive.observedAt,
        fleetComparableObservedAt: comparableObservedAt,
      },
      snapshot: {
        generatedAt,
        refreshedAt: generatedAt,
        expiresAt,
        imageExpiresAt: gsaInventory?.imageExpiresAt ?? null,
        imagesFresh: gsaInventory?.imageExpiresAt
          ? Date.parse(gsaInventory.imageExpiresAt) > now.getTime()
          : true,
      },
    },
  };
}

function errorDetail(error: unknown): { code: string; message: string } {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return {
    code: typeof value?.code === "string"
      ? value.code.slice(0, 120)
      : "DEAL_BOARD_SNAPSHOT_REBUILD_FAILED",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : "The precomputed deal-board rebuild failed.",
  };
}

async function recordBuildFailure(
  db: D1Database,
  error: unknown,
  now: Date,
): Promise<void> {
  const detail = errorDetail(error);
  const observedAt = now.toISOString();
  await db.prepare(
    `INSERT INTO deal_board_snapshots (
       id, cache_key, schema_version, status, generated_at, refreshed_at,
       expires_at, item_count, metadata_json, error_code, error_message,
       created_at, updated_at
     ) VALUES (?1, ?2, ?3, 'failed', ?4, ?4, ?4, 0, '{}', ?5, ?6, ?4, ?4)`,
  ).bind(
    crypto.randomUUID(),
    DEAL_BOARD_CACHE_KEY,
    DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION,
    observedAt,
    detail.code,
    detail.message,
  ).run();
}

/** Publishes a generation only after every bounded JSON chunk is durable. */
export async function persistDealBoardSnapshot(
  db: D1Database,
  built: BuiltDealBoardSnapshot,
): Promise<PersistedDealBoardSnapshot> {
  if (
    !Number.isFinite(Date.parse(built.generatedAt)) ||
    !Number.isFinite(Date.parse(built.expiresAt)) ||
    built.opportunities.length === 0 ||
    built.opportunities.length > MAX_SNAPSHOT_ITEMS ||
    !isRecord(built.metadata)
  ) {
    throw new TypeError("The deal-board snapshot is not safe to persist.");
  }
  const uniqueIds = new Set(built.opportunities.map((item) => item.id));
  if (uniqueIds.size !== built.opportunities.length) {
    throw new TypeError("The deal-board snapshot contains duplicate opportunity IDs.");
  }

  const snapshotId = crypto.randomUUID();
  // Full JSON retains outcome anchors for bid-only recalculation; compact JSON
  // is the ready-to-serve board model. Source/status sorting concentrates live
  // auctions into very few chunks, keeping minute reconciliation inexpensive.
  const chunked = buildSnapshotChunks(snapshotId, built.opportunities);
  const metadata = {
    ...built.metadata,
    snapshot: {
      ...(isRecord(built.metadata.snapshot) ? built.metadata.snapshot : {}),
      id: snapshotId,
      generatedAt: built.generatedAt,
      refreshedAt: built.generatedAt,
      expiresAt: built.expiresAt,
      payloadBytes: chunked.generationBytes,
      chunkCount: chunked.chunks.length,
    },
  };
  const metadataJson = JSON.stringify(metadata);
  if (utf8Bytes(metadataJson) > MAX_METADATA_JSON_BYTES) {
    throw new TypeError("The deal-board metadata exceeds the bounded cache size.");
  }
  // A Worker hard timeout cannot reach the catch below. Reap expired leases
  // before opening a new generation so orphan chunks cannot accumulate.
  const abandonedBefore = new Date(
    Date.parse(built.generatedAt) - ABANDONED_BUILD_LEASE_MS,
  ).toISOString();
  await db.prepare(
    `DELETE FROM deal_board_snapshots
     WHERE cache_key = ?1 AND status = 'building' AND updated_at < ?2`,
  ).bind(DEAL_BOARD_CACHE_KEY, abandonedBefore).run();
  await db.prepare(
    `INSERT INTO deal_board_snapshots (
       id, cache_key, schema_version, status, generated_at, refreshed_at,
       expires_at, item_count, metadata_json, opportunity_index_json,
       error_code, error_message, created_at, updated_at
     ) VALUES (?1, ?2, ?3, 'building', ?4, ?4, ?5, 0, '{}', ?6,
       NULL, NULL, ?4, ?4)`,
  ).bind(
    snapshotId,
    DEAL_BOARD_CACHE_KEY,
    DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION,
    built.generatedAt,
    built.expiresAt,
    chunked.indexJson,
  ).run();

  try {
    await writeSnapshotChunks(db, chunked.chunks, built.generatedAt);
    const observed = await db.prepare(
      `SELECT COUNT(*) AS chunk_count, COALESCE(SUM(item_count), 0) AS item_count
       FROM deal_board_snapshot_chunks
       WHERE snapshot_id = ?1`,
    ).bind(snapshotId).first<{ chunk_count: number; item_count: number }>();
    if (
      !observed ||
      observed.chunk_count !== chunked.chunks.length ||
      observed.item_count !== built.opportunities.length
    ) {
      const error = new Error(
        "The durable deal-board chunks do not match the expected generation.",
      ) as Error & { code: string };
      error.code = "DEAL_BOARD_CHUNK_COUNT_MISMATCH";
      throw error;
    }
    const promoted = await db.prepare(
      `UPDATE deal_board_snapshots SET
         status = 'complete', item_count = ?2, metadata_json = ?3,
         error_code = NULL, error_message = NULL, updated_at = ?4
       WHERE id = ?1 AND status = 'building'`,
    ).bind(
      snapshotId,
      built.opportunities.length,
      metadataJson,
      built.generatedAt,
    ).run();
    if (Number(promoted.meta.changes) !== 1) {
      const error = new Error(
        "The deal-board generation could not be atomically promoted.",
      ) as Error & { code: string };
      error.code = "DEAL_BOARD_PROMOTION_FAILED";
      throw error;
    }
    await db.prepare(
      `DELETE FROM deal_board_snapshots
       WHERE cache_key = ?1
         AND status <> 'building'
         AND id NOT IN (
           SELECT id FROM deal_board_snapshots
           WHERE cache_key = ?1 AND status = 'complete'
           ORDER BY generated_at DESC
           LIMIT ?2
         )`,
    ).bind(DEAL_BOARD_CACHE_KEY, RETAIN_COMPLETE_GENERATIONS).run();
  } catch (error) {
    const detail = errorDetail(error);
    await db.prepare(
      `UPDATE deal_board_snapshots SET
         status = 'failed', error_code = ?2, error_message = ?3, updated_at = ?4
       WHERE id = ?1`,
    ).bind(snapshotId, detail.code, detail.message, new Date().toISOString()).run();
    throw error;
  }

  return {
    snapshotId,
    generatedAt: built.generatedAt,
    expiresAt: built.expiresAt,
    itemCount: built.opportunities.length,
  };
}

/** Fetches, computes, and atomically promotes one official board generation. */
export async function rebuildDealBoardSnapshot(
  db: D1Database,
  options: DealBoardSnapshotBuildOptions = {},
): Promise<PersistedDealBoardSnapshot> {
  const now = validDate(options.now ?? new Date(), "now");
  let built: BuiltDealBoardSnapshot;
  try {
    let buildOptions = { ...options, now };
    if (!options.fleetComparableIndex && !options.getFleetClosed) {
      const durable = await resolveGsaFleetComparableIndex(db, {
        now,
        signal: options.signal,
      });
      buildOptions = {
        ...buildOptions,
        fleetComparableIndex: durable.index,
        fleetComparableObservedAt: durable.observedAt,
      };
    }
    built = await buildDealBoardSnapshot(buildOptions);
  } catch (error) {
    await recordBuildFailure(db, error, now);
    throw error;
  }
  if (built.gsaInventoryMode === "unavailable") {
    const retained = await readRetainedGsaOpportunities(db, now);
    if (retained.length > 0) {
      const coverage = isRecord(built.metadata.coverage) ? built.metadata.coverage : {};
      const sources = isRecord(coverage.sources) ? coverage.sources : {};
      const sourceHealth = isRecord(built.metadata.sourceHealth)
        ? built.metadata.sourceHealth
        : {};
      const snapshot = isRecord(built.metadata.snapshot) ? built.metadata.snapshot : {};
      built = {
        ...built,
        gsaInventoryMode: "retained-snapshot",
        opportunities: [...retained, ...built.opportunities],
        metadata: {
          ...built.metadata,
          mode: "official-gsa-fleet-with-retained-gsa-auctions-snapshot",
          coverage: {
            ...coverage,
            vehicleLots: retained.length + built.opportunities.length,
            sources: { ...sources, gsaAuctions: retained.length },
          },
          sourceHealth: {
            ...sourceHealth,
            status: "stale",
            delivery: "d1-retained-gsa-auctions-with-live-gsa-fleet",
            gsaInventoryRetained: true,
            liveBidPollingBySource: {
              ...(isRecord(sourceHealth.liveBidPollingBySource)
                ? sourceHealth.liveBidPollingBySource
                : {}),
              "gsa-auctions": false,
            },
          },
          snapshot: {
            ...snapshot,
            imageExpiresAt: null,
            imagesFresh: false,
          },
        },
      };
    } else {
      const error = new Error(
        "GSA Auctions inventory is unavailable; a Fleet-only board cannot replace the last complete combined snapshot.",
      ) as Error & { code: string };
      error.code = "DEAL_BOARD_GSA_INCOMPLETE";
      await recordBuildFailure(db, error, now);
      throw error;
    }
  }
  return persistDealBoardSnapshot(db, built);
}

function validOpportunityObject(
  value: unknown,
  expectedId?: string,
): value is AuctionOpportunity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (expectedId === undefined || value.id === expectedId) &&
    (value.source === "gsa-auctions" || value.source === "gsa-fleet") &&
    isRecord(value.valuation) &&
    isRecord(value.forecast) &&
    isRecord(value.assessment)
  );
}

function parseOpportunityArray(value: string): AuctionOpportunity[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const opportunities: AuctionOpportunity[] = [];
    for (const item of parsed) {
      if (!validOpportunityObject(item)) return null;
      opportunities.push(item);
    }
    return opportunities;
  } catch {
    return null;
  }
}

async function recentCompleteSnapshots(
  db: D1Database,
): Promise<SnapshotRow[]> {
  const result = await db.prepare(
    `SELECT id, generated_at, refreshed_at, expires_at, item_count,
       metadata_json, opportunity_index_json
     FROM deal_board_snapshots
     WHERE cache_key = ?1
       AND schema_version = ?2
       AND status = 'complete'
     ORDER BY generated_at DESC
     LIMIT ?3`,
  ).bind(
    DEAL_BOARD_CACHE_KEY,
    DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION,
    RETAIN_COMPLETE_GENERATIONS,
  ).all<SnapshotRow>();
  return result.results ?? [];
}

async function latestCompleteSnapshot(
  db: D1Database,
): Promise<SnapshotRow | null> {
  return (await recentCompleteSnapshots(db))[0] ?? null;
}

/** Checks the promoted generation without loading its multi-megabyte chunks. */
export async function readDealBoardSnapshotFreshness(
  db: D1Database,
  nowValue = new Date(),
  minimumFreshMs = 10 * 60_000,
): Promise<DealBoardSnapshotFreshness | null> {
  const now = validDate(nowValue, "now");
  if (
    !Number.isSafeInteger(minimumFreshMs) ||
    minimumFreshMs < 0 ||
    minimumFreshMs > 60 * 60_000
  ) {
    throw new RangeError("minimumFreshMs must be between 0 and 3600000.");
  }
  const row = await db.prepare(
    `SELECT id, generated_at, expires_at, item_count
     FROM deal_board_snapshots
     WHERE cache_key = ?1 AND schema_version = ?2 AND status = 'complete'
     ORDER BY generated_at DESC
     LIMIT 1`,
  ).bind(DEAL_BOARD_CACHE_KEY, DEAL_BOARD_SNAPSHOT_SCHEMA_VERSION).first<{
    id: string;
    generated_at: string;
    expires_at: string;
    item_count: number;
  }>();
  if (
    !row || !row.id ||
    !Number.isFinite(Date.parse(row.generated_at)) ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    !Number.isSafeInteger(row.item_count) ||
    row.item_count <= 0 || row.item_count > MAX_SNAPSHOT_ITEMS
  ) {
    return null;
  }
  return {
    snapshotId: row.id,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    itemCount: row.item_count,
    fresh: Date.parse(row.expires_at) > now.getTime() + minimumFreshMs,
  };
}

function snapshotMetadata(snapshot: SnapshotRow): JsonRecord | null {
  if (
    !Number.isSafeInteger(snapshot.item_count) ||
    snapshot.item_count <= 0 ||
    snapshot.item_count > MAX_SNAPSHOT_ITEMS
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(snapshot.metadata_json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function snapshotBoardData(
  db: D1Database,
  snapshot: SnapshotRow,
  metadata: JsonRecord,
): Promise<AuctionOpportunity[] | null> {
  const statements = Array.from(
    { length: Math.ceil(MAX_SNAPSHOT_CHUNKS / CHUNK_READ_PAGE_SIZE) },
    (_value, pageIndex) => db.prepare(
      `SELECT chunk_index, item_count, board_json
       FROM deal_board_snapshot_chunks
       WHERE snapshot_id = ?1
       ORDER BY chunk_index
       LIMIT ?2 OFFSET ?3`,
    ).bind(
      snapshot.id,
      CHUNK_READ_PAGE_SIZE,
      pageIndex * CHUNK_READ_PAGE_SIZE,
    ),
  );
  // D1 batch executes these read pages in one transaction, so a minute bid
  // reconciliation cannot expose a mixed old/new board between pages.
  const pages = await db.batch<{
    chunk_index: number;
    item_count: number;
    board_json: string;
  }>(statements);
  const data: AuctionOpportunity[] = [];
  let chunkCount = 0;
  for (const page of pages) {
    for (const row of page.results ?? []) {
      chunkCount += 1;
      const opportunities = parseOpportunityArray(row.board_json);
      if (!opportunities || opportunities.length !== row.item_count) return null;
      data.push(...opportunities);
    }
  }
  const snapshotInfo = isRecord(metadata.snapshot) ? metadata.snapshot : null;
  const expectedChunkCount = snapshotInfo?.chunkCount;
  if (
    expectedChunkCount !== undefined &&
    (!Number.isSafeInteger(expectedChunkCount) || expectedChunkCount !== chunkCount)
  ) {
    return null;
  }
  return data.length === snapshot.item_count ? data : null;
}

async function readRetainedGsaOpportunities(
  db: D1Database,
  now: Date,
): Promise<AuctionOpportunity[]> {
  for (const snapshot of await recentCompleteSnapshots(db)) {
    const retained: AuctionOpportunity[] = [];
    const result = await db.prepare(
      `SELECT payload_json
       FROM deal_board_snapshot_chunks
       WHERE snapshot_id = ?1 AND contains_gsa_auctions = 1
       ORDER BY chunk_index`,
    ).bind(snapshot.id).all<{ payload_json: string }>();
    let valid = true;
    for (const row of result.results ?? []) {
      const opportunities = parseOpportunityArray(row.payload_json);
      if (!opportunities) {
        valid = false;
        break;
      }
      for (const opportunity of opportunities) {
        if (opportunity.source !== "gsa-auctions") continue;
        const observedMs = Date.parse(opportunity.lastCheckedAt);
        if (
          !Number.isFinite(observedMs) ||
          observedMs > now.getTime() ||
          now.getTime() - observedMs > GSA_RETAIN_MAX_AGE_MS
        ) {
          continue;
        }
        const endMs = opportunity.endsAt ? Date.parse(opportunity.endsAt) : Number.NaN;
        if (
          opportunity.status === "preview" ||
          ((opportunity.status === "active" || opportunity.status === "closing") &&
            (!Number.isFinite(endMs) || endMs > now.getTime()))
        ) {
          retained.push(opportunity);
        }
      }
    }
    if (valid) return retained;
  }
  return [];
}

/**
 * Reads the last complete generation even after its freshness deadline. This
 * outage fallback is explicitly marked stale; partial builds never leak.
 */
export async function readDealBoardSnapshot(
  db: D1Database,
  nowValue = new Date(),
): Promise<ServedDealBoardSnapshot | null> {
  const now = validDate(nowValue, "now");
  for (const snapshot of await recentCompleteSnapshots(db)) {
    const metadata = snapshotMetadata(snapshot);
    if (!metadata) continue;
    const data = await snapshotBoardData(db, snapshot, metadata);
    if (!data) continue;
    return servedSnapshot(snapshot, metadata, data, now);
  }
  return null;
}

function servedSnapshot(
  snapshot: SnapshotRow,
  metadata: JsonRecord,
  data: AuctionOpportunity[],
  now: Date,
): ServedDealBoardSnapshot {
  const originalSourceHealth = isRecord(metadata.sourceHealth)
    ? metadata.sourceHealth
    : {};
  const originalSnapshot = isRecord(metadata.snapshot) ? metadata.snapshot : {};
  const imageExpiresAt = typeof originalSnapshot.imageExpiresAt === "string"
    ? originalSnapshot.imageExpiresAt
    : null;
  const stale = Date.parse(snapshot.expires_at) <= now.getTime();
  const originalMode = typeof metadata.mode === "string"
    ? metadata.mode
    : "official-sources";
  const originalStatus = typeof originalSourceHealth.status === "string"
    ? originalSourceHealth.status
    : "live";
  const upstreamStaleSince = typeof originalSourceHealth.staleSince === "string" &&
      Number.isFinite(Date.parse(originalSourceHealth.staleSince))
    ? originalSourceHealth.staleSince
    : null;
  const cacheStaleSince = stale ? snapshot.expires_at : null;
  const staleCandidates = [upstreamStaleSince, cacheStaleSince]
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const effectiveStaleSince = staleCandidates[0] ?? null;
  const cacheAgeSeconds = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(snapshot.generated_at)) / 1_000),
  );
  const sourceAgeSeconds = effectiveStaleSince
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(effectiveStaleSince)) / 1_000))
    : cacheAgeSeconds;
  const explicitImagesFresh = typeof originalSnapshot.imagesFresh === "boolean"
    ? originalSnapshot.imagesFresh
    : null;
  return {
    snapshotId: snapshot.id,
    generatedAt: snapshot.generated_at,
    refreshedAt: snapshot.refreshed_at,
    expiresAt: snapshot.expires_at,
    stale,
    data,
    meta: {
      ...metadata,
      mode: `precomputed-${originalMode}`,
      sourceHealth: {
        ...originalSourceHealth,
        status: stale ? "stale" : originalStatus,
        cache: stale ? "stale-durable-snapshot" : "durable-snapshot",
        delivery: "d1-precomputed-deal-board",
        staleSince: effectiveStaleSince,
        upstreamStaleSince,
        ageSeconds: sourceAgeSeconds,
        cacheAgeSeconds,
      },
      snapshot: {
        ...originalSnapshot,
        id: snapshot.id,
        generatedAt: snapshot.generated_at,
        refreshedAt: snapshot.refreshed_at,
        expiresAt: snapshot.expires_at,
        imageExpiresAt,
        imagesFresh: explicitImagesFresh === false
          ? false
          : imageExpiresAt === null || Date.parse(imageExpiresAt) > now.getTime(),
      },
    },
  };
}

/** Reads one full dossier row without loading the complete 4k-row board. */
export async function readDealBoardSnapshotOpportunity(
  db: D1Database,
  requestedId: string,
  nowValue = new Date(),
): Promise<ServedDealBoardSnapshot | null> {
  const cleanId = requestedId.trim();
  if (!cleanId || cleanId.length > 160) return null;
  const now = validDate(nowValue, "now");
  for (const snapshot of await recentCompleteSnapshots(db)) {
    const metadata = snapshotMetadata(snapshot);
    if (!metadata) continue;
    let lookup: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(snapshot.opportunity_index_json);
      if (!isRecord(parsed)) continue;
      lookup = parsed;
    } catch {
      continue;
    }
    const indexed = lookup[`id:${cleanId}`] ?? lookup[`external:${cleanId}`];
    if (
      !Number.isSafeInteger(indexed) ||
      Number(indexed) < 0 ||
      Number(indexed) >= MAX_SNAPSHOT_CHUNKS
    ) {
      continue;
    }
    const row = await db.prepare(
      `SELECT payload_json, board_json
       FROM deal_board_snapshot_chunks
       WHERE snapshot_id = ?1 AND chunk_index = ?2
       LIMIT 1`,
    ).bind(snapshot.id, indexed).first<{
      payload_json: string;
      board_json: string;
    }>();
    if (!row) continue;
    const full = parseOpportunityArray(row.payload_json);
    const board = parseOpportunityArray(row.board_json);
    if (!full || !board) continue;
    const opportunity = [...full, ...board].find((item) =>
      item.id === cleanId || item.externalId === cleanId
    ) ?? null;
    if (opportunity) return servedSnapshot(snapshot, metadata, [opportunity], now);
  }
  return null;
}

function sourceExternalId(opportunity: AuctionOpportunity): string {
  if (opportunity.source === "gsa-fleet" && opportunity.externalId.startsWith("gsa-fleet:")) {
    return opportunity.externalId.slice("gsa-fleet:".length);
  }
  return opportunity.externalId;
}

function validStoredAuctionState(value: unknown): value is StoredAuctionState {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.source_key === "gsa-auctions" || value.source_key === "gsa-fleet") &&
    typeof value.external_id === "string" &&
    AUCTION_STATUSES.has(value.status) &&
    (value.current_bid_cents === null || Number.isSafeInteger(value.current_bid_cents)) &&
    (value.bidder_count === null || Number.isSafeInteger(value.bidder_count)) &&
    (value.ends_at === null || typeof value.ends_at === "string") &&
    typeof value.last_checked_at === "string" &&
    Number.isFinite(Date.parse(value.last_checked_at))
  );
}

interface AuctionLookupKey {
  sourceKey: "gsa-auctions" | "gsa-fleet";
  externalId: string;
}

function auctionStateLookupSql(count: number): string {
  let parameter = 1;
  const predicates = Array.from({ length: count }, () => {
    const sourceParameter = parameter++;
    const externalParameter = parameter++;
    return `(source_key = ?${sourceParameter} AND external_id = ?${externalParameter})`;
  });
  return `SELECT id, source_key, external_id, status, current_bid_cents, bidder_count,
       ends_at, last_checked_at
     FROM auctions
     WHERE ${predicates.join(" OR ")}`;
}

function bidHistoryLookupSql(count: number): string {
  const placeholders = Array.from({ length: count }, (_value, index) => `?${index + 1}`);
  return `SELECT auction_id, observed_at, current_bid_cents, bidder_count
     FROM (
       SELECT auction_id, observed_at, current_bid_cents, bidder_count,
         ROW_NUMBER() OVER (
           PARTITION BY auction_id ORDER BY observed_at DESC
         ) AS observation_rank
       FROM bid_observations
       WHERE auction_id IN (${placeholders.join(", ")})
         AND current_bid_cents IS NOT NULL
     )
     WHERE observation_rank <= ${BID_HISTORY_POINTS_PER_AUCTION}
     ORDER BY auction_id, observed_at`;
}

async function auctionStatesForOpportunities(
  db: D1Database,
  opportunities: readonly AuctionOpportunity[],
): Promise<Map<string, StoredAuctionState>> {
  const keyed = new Map<string, AuctionLookupKey>();
  for (const opportunity of opportunities) {
    if (!trackedForBidRefresh(opportunity)) continue;
    const key: AuctionLookupKey = {
      sourceKey: opportunity.source,
      externalId: sourceExternalId(opportunity),
    };
    keyed.set(`${key.sourceKey}|${key.externalId}`, key);
  }
  const lookups = [...keyed.values()];
  if (lookups.length === 0) return new Map();
  const statements = chunks(lookups, AUCTION_LOOKUP_PAIR_BATCH_SIZE).map((group) =>
    db.prepare(auctionStateLookupSql(group.length)).bind(
      ...group.flatMap((key) => [key.sourceKey, key.externalId]),
    )
  );
  const results = await db.batch<StoredAuctionState>(statements);
  const stateBySourceExternal = new Map<string, StoredAuctionState>();
  for (const result of results) {
    for (const state of result.results ?? []) {
      if (validStoredAuctionState(state)) {
        stateBySourceExternal.set(`${state.source_key}|${state.external_id}`, state);
      }
    }
  }
  return stateBySourceExternal;
}

async function bidHistoryForAuctionIds(
  db: D1Database,
  auctionIds: readonly string[],
): Promise<Map<string, Array<{
  observedAt: string;
  currentBidCents: number;
  bidderCount: number | null;
}>>> {
  const uniqueIds = [...new Set(auctionIds)];
  if (uniqueIds.length === 0) return new Map();
  const statements = chunks(uniqueIds, BID_HISTORY_LOOKUP_BATCH_SIZE).map((group) =>
    db.prepare(bidHistoryLookupSql(group.length)).bind(...group)
  );
  const results = await db.batch<StoredBidObservation>(statements);
  const grouped = new Map<string, Array<{
    observedAt: string;
    currentBidCents: number;
    bidderCount: number | null;
  }>>();
  for (const result of results) {
    for (const observation of result.results ?? []) {
      if (
        typeof observation.auction_id !== "string" ||
        typeof observation.observed_at !== "string" ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        !Number.isSafeInteger(observation.current_bid_cents) ||
        observation.current_bid_cents < 0 ||
        (observation.bidder_count !== null &&
          (!Number.isSafeInteger(observation.bidder_count) || observation.bidder_count < 0))
      ) {
        continue;
      }
      const values = grouped.get(observation.auction_id) ?? [];
      values.push({
        observedAt: observation.observed_at,
        currentBidCents: observation.current_bid_cents,
        bidderCount: observation.bidder_count,
      });
      grouped.set(observation.auction_id, values);
    }
  }
  return grouped;
}

/**
 * Applies D1's adaptive closing observations to the current precomputed rows.
 * This is intentionally bid-only: inventory, valuation evidence, and source
 * provenance continue to come from the last complete hourly generation.
 */
export async function reconcileDealBoardSnapshotBids(
  db: D1Database,
  nowValue = new Date(),
): Promise<DealBoardBidReconciliationSummary> {
  const now = validDate(nowValue, "now");
  const reconciledAt = now.toISOString();
  const snapshot = await latestCompleteSnapshot(db);
  if (!snapshot) {
    return { snapshotId: null, considered: 0, updated: 0, reconciledAt };
  }
  const stored = await db.prepare(
    `SELECT id, chunk_index, item_count, payload_count, active_count,
       contains_gsa_auctions, contains_gsa_fleet, payload_json, board_json
     FROM deal_board_snapshot_chunks
     WHERE snapshot_id = ?1 AND active_count > 0
     ORDER BY chunk_index`,
  ).bind(snapshot.id).all<SnapshotChunkRow>();
  const rows = stored.results ?? [];
  if (rows.length === 0) {
    await db.prepare(
      `UPDATE deal_board_snapshots SET refreshed_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'complete'`,
    ).bind(snapshot.id, reconciledAt).run();
    return { snapshotId: snapshot.id, considered: 0, updated: 0, reconciledAt };
  }

  const parsedChunks: Array<{
    row: SnapshotChunkRow;
    opportunities: AuctionOpportunity[];
    boardOpportunities: AuctionOpportunity[];
  }> = [];
  for (const row of rows) {
    const opportunities = parseOpportunityArray(row.payload_json);
    const boardOpportunities = parseOpportunityArray(row.board_json);
    if (
      opportunities && opportunities.length === row.payload_count &&
      boardOpportunities && boardOpportunities.length === row.item_count
    ) {
      parsedChunks.push({ row, opportunities, boardOpportunities });
    }
  }
  const stateBySourceExternal = await auctionStatesForOpportunities(
    db,
    parsedChunks.flatMap((chunk) => chunk.opportunities),
  );
  // Bid histories are fetched only for rows that actually received a newer
  // source observation; this preserves the last 24 aggression points without
  // rereading every active auction's history once per minute.
  const changedAuctionIds: string[] = [];
  for (const chunk of parsedChunks) {
    for (const opportunity of chunk.opportunities) {
      if (!trackedForBidRefresh(opportunity)) continue;
      const state = stateBySourceExternal.get(
        `${opportunity.source}|${sourceExternalId(opportunity)}`,
      );
      if (
        state &&
        Date.parse(state.last_checked_at) > Date.parse(opportunity.lastCheckedAt)
      ) {
        changedAuctionIds.push(state.id);
      }
    }
  }
  const bidHistoryByAuction = await bidHistoryForAuctionIds(db, changedAuctionIds);

  const changedChunks: SerializedChunk[] = [];
  let considered = 0;
  let updated = 0;
  for (const { row, opportunities, boardOpportunities } of parsedChunks) {
    let chunkChanged = false;
    let chunkUpdates = 0;
    const nextOpportunities = opportunities.map((opportunity) => {
      if (!trackedForBidRefresh(opportunity)) return opportunity;
      considered += 1;
      const state = stateBySourceExternal.get(
        `${opportunity.source}|${sourceExternalId(opportunity)}`,
      );
      if (!state) return opportunity;
      const next = applyLiveBidSnapshot(opportunity, {
        externalId: opportunity.externalId,
        status: state.status,
        currentBidCents: state.current_bid_cents,
        bidderCount: state.bidder_count,
        endsAt: state.ends_at,
        lastCheckedAt: state.last_checked_at,
        subjectBidObservations: bidHistoryByAuction.get(state.id) ?? [],
      });
      if (next !== opportunity) {
        chunkChanged = true;
        chunkUpdates += 1;
      }
      return next;
    });
    if (!chunkChanged) continue;
    const updatedById = new Map(nextOpportunities.map((item) => [item.id, item]));
    const nextBoardOpportunities = boardOpportunities.map((item) =>
      updatedById.get(item.id) ?? item
    );
    const payloadJson = JSON.stringify(nextOpportunities);
    const boardJson = JSON.stringify(
      nextBoardOpportunities.map(compactOpportunityForBoard),
    );
    if (utf8Bytes(payloadJson) + utf8Bytes(boardJson) > MAX_CHUNK_JSON_BYTES) {
      continue;
    }
    changedChunks.push({
      id: row.id,
      snapshotId: snapshot.id,
      chunkIndex: row.chunk_index,
      itemCount: row.item_count,
      payloadCount: nextOpportunities.length,
      activeCount: nextOpportunities.filter(trackedForBidRefresh).length,
      containsGsaAuctions: row.contains_gsa_auctions === 1,
      containsGsaFleet: row.contains_gsa_fleet === 1,
      payloadJson,
      boardJson,
    });
    updated += chunkUpdates;
  }
  const refreshStatement = db.prepare(
    `UPDATE deal_board_snapshots SET refreshed_at = ?2, updated_at = ?2
     WHERE id = ?1 AND status = 'complete'`,
  ).bind(snapshot.id, reconciledAt);
  if (changedChunks.length > 0) {
    // D1 batches are transactional: every visible chunk and its refresh marker
    // move together or roll back together.
    await db.batch([
      ...snapshotChunkStatements(db, changedChunks, reconciledAt, true),
      refreshStatement,
    ]);
  } else {
    await refreshStatement.run();
  }
  return {
    snapshotId: snapshot.id,
    considered,
    updated,
    reconciledAt,
  };
}
