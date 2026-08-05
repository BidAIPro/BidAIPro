import type { AuctionStatus } from "./auction-types";
import {
  fetchGsaFleetVehicleActivity,
  GsaFleetClientError,
  type GsaFleetVehicleActivity,
} from "./gsa-fleet-client.ts";
import {
  getRefreshDecision,
  type RefreshCadenceBucket,
  type RefreshDecision,
} from "./refresh-policy.ts";

export const GSA_FLEET_CLOSING_SOURCE_CHECK_SCOPE = "closing-window-bid";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;
const DEFAULT_CANDIDATE_LIMIT = 500;
const MAX_CANDIDATE_LIMIT = 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const SAFE_SOURCE_IDENTIFIER = /^[A-Za-z0-9_ -]{3,64}$/;

const TERMINAL_STATUSES = new Set<AuctionStatus>([
  "ended",
  "sold",
  "unsold",
  "cancelled",
]);

export interface GsaFleetClosingCandidate {
  id: string;
  external_id: string;
  sale_lot_number: string;
  vin: string;
  status: AuctionStatus;
  current_bid_cents: number | null;
  bidder_count: number | null;
  ends_at: string;
  last_checked_at: string;
  extension_count: number;
  sale_number: string;
}

export interface GsaFleetClosingRefreshPassSummary {
  considered: number;
  due: number;
  succeeded: number;
  failed: number;
  observationsAppended: number;
  dueBuckets: RefreshCadenceBucket[];
}

export interface GsaFleetClosingRefreshCycleSummary
  extends GsaFleetClosingRefreshPassSummary {
  passes: number;
  waitedOffsetsMs: number[];
}

type FleetActivityFetcher = (
  vin: string,
  saleNumber: string,
  options?: Parameters<typeof fetchGsaFleetVehicleActivity>[2],
) => Promise<GsaFleetVehicleActivity>;

export interface GsaFleetClosingRefreshOptions {
  now?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  fetchActivity?: FleetActivityFetcher;
  concurrency?: number;
  candidateLimit?: number;
}

interface DueCandidate {
  candidate: GsaFleetClosingCandidate;
  decision: RefreshDecision;
}

interface FleetRefreshSnapshot {
  currentBidCents: number | null;
  status: AuctionStatus;
  endsAt: string;
  observedAt: string;
}

interface RefreshResult {
  success: boolean;
  observationAppended: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function isTerminal(status: AuctionStatus) {
  return TERMINAL_STATUSES.has(status);
}

function isUrgentBucket(bucket: RefreshCadenceBucket) {
  return (
    bucket === "last-5-minutes" ||
    bucket === "last-minute" ||
    bucket === "close-grace"
  );
}

function cleanSourceIdentifier(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return SAFE_SOURCE_IDENTIFIER.test(cleaned) ? cleaned.toUpperCase() : null;
}

/** Fleet persistence stores the official sale number as the first lot segment. */
export function saleNumberFromLot(value: string): string | null {
  const firstSegment = value.split("/", 1)[0]?.trim() ?? "";
  if (!firstSegment || firstSegment.toLowerCase() === "gsa fleet") return null;
  return cleanSourceIdentifier(firstSegment);
}

function laterEnd(current: string, incoming: string | null): string {
  const currentMs = Date.parse(current);
  const incomingMs = incoming === null ? Number.NaN : Date.parse(incoming);
  if (!Number.isFinite(incomingMs)) return current;
  if (!Number.isFinite(currentMs) || incomingMs > currentMs) return incoming!;
  // A missing or stale extension in one response must not shorten a previously
  // observed extended close and accidentally slow the urgent refresh cadence.
  return current;
}

function activityStatus(
  activity: GsaFleetVehicleActivity,
  checkedAt: Date,
  endsAt: string,
): AuctionStatus {
  const vehicleStatus = activity.detail.vehicleSaleStatus?.trim().toLowerCase();
  const saleStatus = activity.detail.saleStatus?.trim().toLowerCase();
  if (
    vehicleStatus === "removed" ||
    vehicleStatus === "withdrawn" ||
    vehicleStatus === "cancelled" ||
    vehicleStatus === "canceled"
  ) {
    return "cancelled";
  }
  if (vehicleStatus === "sold" || vehicleStatus === "awarded") return "sold";
  if (saleStatus === "closed" || saleStatus === "sale complete") return "ended";

  const remainingMs = Date.parse(endsAt) - checkedAt.getTime();
  return Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= THIRTY_MINUTES_MS
    ? "closing"
    : "active";
}

function normalizeActivity(
  candidate: GsaFleetClosingCandidate,
  activity: GsaFleetVehicleActivity,
  checkedAt: Date,
): FleetRefreshSnapshot {
  const endsAt = laterEnd(candidate.ends_at, activity.effectiveEndsAt);
  return {
    // The detail gateway can transiently omit a displayed bid. Preserve the
    // last verified amount instead of replacing it with an evidence gap.
    currentBidCents: activity.currentBidCents ?? candidate.current_bid_cents,
    status: activityStatus(activity, checkedAt, endsAt),
    endsAt,
    observedAt: activity.observedAt,
  };
}

function snapshotChanged(
  candidate: GsaFleetClosingCandidate,
  snapshot: FleetRefreshSnapshot,
) {
  return (
    candidate.current_bid_cents !== snapshot.currentBidCents ||
    candidate.status !== snapshot.status ||
    candidate.ends_at !== snapshot.endsAt
  );
}

function extensionCount(
  candidate: GsaFleetClosingCandidate,
  snapshot: FleetRefreshSnapshot,
) {
  const previousEnd = Date.parse(candidate.ends_at);
  const nextEnd = Date.parse(snapshot.endsAt);
  return candidate.extension_count +
    (Number.isFinite(previousEnd) && Number.isFinite(nextEnd) && nextEnd > previousEnd
      ? 1
      : 0);
}

function updateCandidate(
  candidate: GsaFleetClosingCandidate,
  snapshot: FleetRefreshSnapshot,
  nextExtensionCount: number,
) {
  candidate.current_bid_cents = snapshot.currentBidCents;
  candidate.status = snapshot.status;
  candidate.ends_at = snapshot.endsAt;
  candidate.last_checked_at = snapshot.observedAt;
  candidate.extension_count = nextExtensionCount;
}

function sourceError(error: unknown) {
  return {
    code:
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code.slice(0, 120)
        : "GSA_FLEET_CLOSING_REFRESH_FAILED",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "The official GSA Fleet live bid refresh failed.",
    statusCode: error instanceof GsaFleetClientError ? error.upstreamStatus : null,
  };
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await work(values[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

/**
 * Active Fleet persistence contains Internet auctions only. Join the vehicle
 * row here because the public detail/activity query is keyed by VIN and sale
 * number rather than the Marketplace listing id.
 */
export async function listGsaFleetClosingCandidates(
  db: D1Database,
  now: Date,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): Promise<GsaFleetClosingCandidate[]> {
  const limit = boundedInteger(candidateLimit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT);
  const nowIso = now.toISOString();
  const windowEndIso = new Date(now.getTime() + THIRTY_MINUTES_MS).toISOString();
  const result = await db.prepare(
    `SELECT
       a.id, a.external_id, a.sale_lot_number, v.vin, a.status,
       a.current_bid_cents, a.bidder_count, a.ends_at, a.last_checked_at,
       COALESCE((
         SELECT MAX(o.extension_count)
         FROM bid_observations o
         WHERE o.auction_id = a.id
       ), 0) AS extension_count
     FROM auctions a
     JOIN vehicles v ON v.auction_id = a.id
     WHERE a.source_key = 'gsa-fleet'
       AND a.status IN ('active', 'closing')
       AND a.ends_at IS NOT NULL
       AND a.ends_at <= ?1
       AND v.vin IS NOT NULL
       AND TRIM(v.vin) <> ''
     ORDER BY
       CASE WHEN a.ends_at >= ?2 THEN 0 ELSE 1 END,
       CASE WHEN a.ends_at >= ?2 THEN a.ends_at ELSE a.last_checked_at END ASC
     LIMIT ?3`,
  ).bind(windowEndIso, nowIso, limit).all<Omit<GsaFleetClosingCandidate, "sale_number">>();

  const candidates: GsaFleetClosingCandidate[] = [];
  for (const row of result.results ?? []) {
    const saleNumber = saleNumberFromLot(row.sale_lot_number);
    const vin = cleanSourceIdentifier(row.vin);
    if (!saleNumber || !vin || !Number.isFinite(Date.parse(row.ends_at))) continue;
    candidates.push({ ...row, vin, sale_number: saleNumber });
  }
  return candidates;
}

function dueCandidates(
  candidates: readonly GsaFleetClosingCandidate[],
  now: Date,
): DueCandidate[] {
  const due: DueCandidate[] = [];
  for (const candidate of candidates) {
    if (isTerminal(candidate.status)) continue;
    try {
      const decision = getRefreshDecision({
        now,
        endsAt: candidate.ends_at,
        lastCheckedAt: candidate.last_checked_at,
        status: candidate.status,
        closeConfirmed: false,
      });
      if (decision.shouldRefresh) due.push({ candidate, decision });
    } catch {
      // One corrupt row must not block every healthy closing auction.
    }
  }
  return due;
}

async function beginSourceCheck(
  db: D1Database,
  candidate: GsaFleetClosingCandidate,
  sourceCheckId: string,
  checkedAt: string,
) {
  await db.prepare(
    `INSERT INTO source_checks (
       id, source_key, auction_id, scope, checked_at, success, status_code,
       latency_ms, result_count, expected_result_count, coverage_status,
       error_code, error_message, response_hash, created_at
     ) VALUES (
       ?1, 'gsa-fleet', ?2, ?3, ?4, 0, NULL,
       NULL, 0, 1, 'in-progress', NULL, NULL, NULL, ?4
     )`,
  ).bind(
    sourceCheckId,
    candidate.id,
    GSA_FLEET_CLOSING_SOURCE_CHECK_SCOPE,
    checkedAt,
  ).run();
}

async function failSourceCheck(
  db: D1Database,
  sourceCheckId: string,
  error: unknown,
  latencyMs: number,
) {
  const detail = sourceError(error);
  await db.prepare(
    `UPDATE source_checks SET
       success = 0, status_code = ?2, latency_ms = ?3,
       result_count = 0, expected_result_count = 1,
       coverage_status = 'failed', error_code = ?4, error_message = ?5
     WHERE id = ?1`,
  ).bind(
    sourceCheckId,
    detail.statusCode,
    Math.max(0, Math.round(latencyMs)),
    detail.code,
    detail.message,
  ).run();
}

async function refreshOneCandidate(
  db: D1Database,
  candidate: GsaFleetClosingCandidate,
  checkedAt: Date,
  fetchActivity: FleetActivityFetcher,
): Promise<RefreshResult> {
  const sourceCheckId = crypto.randomUUID();
  const checkStartedMs = Date.now();
  await beginSourceCheck(db, candidate, sourceCheckId, checkedAt.toISOString());

  try {
    const activity = await fetchActivity(candidate.vin, candidate.sale_number, {
      now: checkedAt,
      forceRefresh: true,
    });
    const snapshot = normalizeActivity(candidate, activity, checkedAt);
    const didChange = snapshotChanged(candidate, snapshot);
    const nextExtensionCount = extensionCount(candidate, snapshot);
    const statements: D1PreparedStatement[] = [];
    let observationIndex = -1;

    if (didChange) {
      observationIndex = statements.length;
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO bid_observations (
             id, auction_id, source_check_id, observed_at, current_bid_cents,
             bidder_count, status, ends_at, extension_count, created_at
           )
           SELECT ?1, a.id, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?3
           FROM auctions a
           WHERE a.id = ?8
             AND a.source_key = 'gsa-fleet'
             AND a.external_id = ?9
             AND ?3 > a.last_checked_at
             AND (
               a.current_bid_cents IS NOT ?4
               OR a.status IS NOT ?5
               OR a.ends_at IS NOT ?6
             )`,
        ).bind(
          crypto.randomUUID(),
          sourceCheckId,
          snapshot.observedAt,
          snapshot.currentBidCents,
          snapshot.status,
          snapshot.endsAt,
          nextExtensionCount,
          candidate.id,
          candidate.external_id,
        ),
      );
    }

    const auctionUpdateIndex = statements.length;
    statements.push(
      db.prepare(
        `UPDATE auctions SET
           current_bid_cents = ?3,
           status = ?4,
           ends_at = ?5,
           ended_at = CASE
             WHEN ?4 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN COALESCE(ended_at, ?5)
             ELSE ended_at
           END,
           final_bid_cents = CASE
             WHEN ?4 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN ?3 ELSE final_bid_cents
           END,
           final_status = CASE
             WHEN ?4 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN 'closed-high-bid-unverified' ELSE final_status
           END,
           last_seen_at = ?6,
           last_checked_at = ?6,
           price_changed_at = CASE
             WHEN current_bid_cents IS NOT ?3 THEN ?6 ELSE price_changed_at
           END,
           updated_at = ?6
         WHERE id = ?1
           AND source_key = 'gsa-fleet'
           AND external_id = ?2
           AND ?6 > last_checked_at`,
      ).bind(
        candidate.id,
        candidate.external_id,
        snapshot.currentBidCents,
        snapshot.status,
        snapshot.endsAt,
        snapshot.observedAt,
      ),
    );
    statements.push(
      db.prepare(
        `UPDATE source_checks SET
           success = 1, status_code = 200, latency_ms = ?2,
           result_count = 1, expected_result_count = 1,
           coverage_status = 'complete', error_code = NULL, error_message = NULL
         WHERE id = ?1`,
      ).bind(sourceCheckId, Math.max(0, Date.now() - checkStartedMs)),
    );

    const results = await db.batch(statements);
    const observationAppended =
      observationIndex >= 0 && (results[observationIndex]?.meta.changes ?? 0) > 0;
    if ((results[auctionUpdateIndex]?.meta.changes ?? 0) > 0) {
      updateCandidate(candidate, snapshot, nextExtensionCount);
    }
    return { success: true, observationAppended };
  } catch (error) {
    await failSourceCheck(db, sourceCheckId, error, Date.now() - checkStartedMs);
    return { success: false, observationAppended: false };
  }
}

async function refreshPass(
  db: D1Database,
  candidates: GsaFleetClosingCandidate[],
  now: Date,
  options: GsaFleetClosingRefreshOptions,
): Promise<GsaFleetClosingRefreshPassSummary> {
  const due = dueCandidates(candidates, now);
  const dueBuckets = [...new Set(due.map(({ decision }) => decision.cadenceBucket))];
  const concurrency = boundedInteger(
    options.concurrency,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const results = await mapBounded(
    due,
    concurrency,
    ({ candidate }) => refreshOneCandidate(
      db,
      candidate,
      now,
      options.fetchActivity ?? fetchGsaFleetVehicleActivity,
    ),
  );
  return {
    considered: candidates.length,
    due: due.length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    observationsAppended: results.filter((result) => result.observationAppended).length,
    dueBuckets,
  };
}

function addPassSummary(
  total: GsaFleetClosingRefreshCycleSummary,
  pass: GsaFleetClosingRefreshPassSummary,
) {
  total.due += pass.due;
  total.succeeded += pass.succeeded;
  total.failed += pass.failed;
  total.observationsAppended += pass.observationsAppended;
  total.dueBuckets = [...new Set([...total.dueBuckets, ...pass.dueBuckets])];
}

/** Runs the minute cron plus the 15/30/45-second urgent checkpoints. */
export async function runGsaFleetClosingWindowRefresh(
  db: D1Database,
  options: GsaFleetClosingRefreshOptions = {},
): Promise<GsaFleetClosingRefreshCycleSummary> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((delayMs: number) => scheduler.wait(delayMs));
  const cycleStartedAt = now();
  const candidates = await listGsaFleetClosingCandidates(
    db,
    cycleStartedAt,
    options.candidateLimit,
  );
  const initial = await refreshPass(db, candidates, cycleStartedAt, options);
  const summary: GsaFleetClosingRefreshCycleSummary = {
    ...initial,
    passes: 1,
    waitedOffsetsMs: [],
  };

  for (const offset of [15_000, 30_000, 45_000]) {
    const targetAt = new Date(cycleStartedAt.getTime() + offset);
    const targetDue = dueCandidates(candidates, targetAt).filter(({ decision }) =>
      isUrgentBucket(decision.cadenceBucket),
    );
    if (targetDue.length === 0) continue;

    const delayMs = Math.max(0, targetAt.getTime() - now().getTime());
    if (delayMs > 0) await sleep(delayMs);
    summary.waitedOffsetsMs.push(offset);
    const pass = await refreshPass(db, candidates, now(), options);
    summary.passes += 1;
    addPassSummary(summary, pass);
  }

  return summary;
}
