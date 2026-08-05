import type { AuctionStatus } from "./auction-types";
import {
  fetchPpmsLiveBid,
  isValidPpmsAuctionId,
  PpmsLiveBidError,
  type PpmsLiveBidSnapshot,
} from "./gsa-ppms-live-bid.ts";
import {
  getRefreshDecision,
  type RefreshCadenceBucket,
  type RefreshDecision,
} from "./refresh-policy.ts";

const SOURCE_CHECK_SCOPE = "closing-window-bid";
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;
const DEFAULT_CANDIDATE_LIMIT = 500;
const MAX_CANDIDATE_LIMIT = 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;

const TERMINAL_STATUSES = new Set<AuctionStatus>([
  "ended",
  "sold",
  "unsold",
  "cancelled",
]);

export interface ClosingAuctionCandidate {
  id: string;
  external_id: string;
  status: AuctionStatus;
  current_bid_cents: number | null;
  bidder_count: number | null;
  ends_at: string;
  last_checked_at: string;
  extension_count: number;
}

export interface ClosingRefreshPassSummary {
  considered: number;
  due: number;
  succeeded: number;
  failed: number;
  observationsAppended: number;
  dueBuckets: RefreshCadenceBucket[];
}

export interface ClosingRefreshCycleSummary extends ClosingRefreshPassSummary {
  passes: number;
  waitedOffsetsMs: number[];
}

type LiveBidFetcher = (
  auctionId: string,
  options?: Parameters<typeof fetchPpmsLiveBid>[1],
) => Promise<PpmsLiveBidSnapshot>;

export interface ClosingRefreshOptions {
  now?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  fetchLiveBid?: LiveBidFetcher;
  concurrency?: number;
  candidateLimit?: number;
}

interface DueCandidate {
  candidate: ClosingAuctionCandidate;
  decision: RefreshDecision;
}

interface RefreshResult {
  success: boolean;
  observationAppended: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
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

function snapshotChanged(
  candidate: ClosingAuctionCandidate,
  snapshot: PpmsLiveBidSnapshot,
) {
  return (
    candidate.current_bid_cents !== snapshot.currentBidCents ||
    candidate.bidder_count !== snapshot.bidderCount ||
    candidate.status !== snapshot.status ||
    candidate.ends_at !== snapshot.endsAt
  );
}

function extensionCount(
  candidate: ClosingAuctionCandidate,
  snapshot: PpmsLiveBidSnapshot,
) {
  const previousEnd = Date.parse(candidate.ends_at);
  const nextEnd = Date.parse(snapshot.endsAt);
  return candidate.extension_count +
    (Number.isFinite(previousEnd) && Number.isFinite(nextEnd) && nextEnd > previousEnd
      ? 1
      : 0);
}

function updateCandidate(
  candidate: ClosingAuctionCandidate,
  snapshot: PpmsLiveBidSnapshot,
  nextExtensionCount: number,
) {
  candidate.current_bid_cents = snapshot.currentBidCents;
  candidate.bidder_count = snapshot.bidderCount;
  candidate.status = snapshot.status;
  candidate.ends_at = snapshot.endsAt;
  candidate.last_checked_at = snapshot.lastCheckedAt;
  candidate.extension_count = nextExtensionCount;
}

function sourceError(error: unknown) {
  return {
    code:
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code.slice(0, 120)
        : "GSA_PPMS_CLOSING_REFRESH_FAILED",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "The official GSA live bid refresh failed.",
    statusCode:
      error instanceof PpmsLiveBidError ? error.upstreamStatus : null,
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
 * Selects only known PPMS auctions that are entering the closing window or
 * whose scheduled close has passed without a terminal result. Upcoming rows
 * sort ahead of old reconciliation rows so stale records cannot starve a live
 * closing auction if the safety limit is reached.
 */
export async function listClosingAuctionCandidates(
  db: D1Database,
  now: Date,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): Promise<ClosingAuctionCandidate[]> {
  const limit = boundedInteger(candidateLimit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT);
  const nowIso = now.toISOString();
  const windowEndIso = new Date(now.getTime() + THIRTY_MINUTES_MS).toISOString();
  const result = await db.prepare(
    `SELECT
       a.id, a.external_id, a.status, a.current_bid_cents, a.bidder_count,
       a.ends_at, a.last_checked_at,
       COALESCE((
         SELECT MAX(o.extension_count)
         FROM bid_observations o
         WHERE o.auction_id = a.id
       ), 0) AS extension_count
     FROM auctions a
     WHERE a.source_key = 'gsa-auctions'
       AND a.status IN ('preview', 'active', 'closing')
       AND a.ends_at IS NOT NULL
       AND a.ends_at <= ?1
       AND a.external_id GLOB '[1-9]*'
       AND a.external_id NOT GLOB '*[^0-9]*'
     ORDER BY
       CASE WHEN a.ends_at >= ?2 THEN 0 ELSE 1 END,
       CASE
         WHEN a.ends_at >= ?2 THEN a.ends_at
         ELSE a.last_checked_at
       END ASC
     LIMIT ?3`,
  ).bind(windowEndIso, nowIso, limit).all<ClosingAuctionCandidate>();

  return (result.results ?? []).filter((row) => isValidPpmsAuctionId(row.external_id));
}

function dueCandidates(
  candidates: readonly ClosingAuctionCandidate[],
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
      // Invalid timestamps are ignored here rather than allowing one corrupt
      // row to stop refreshes for every healthy closing auction.
    }
  }
  return due;
}

async function beginSourceCheck(
  db: D1Database,
  candidate: ClosingAuctionCandidate,
  sourceCheckId: string,
  checkedAt: string,
) {
  await db.prepare(
    `INSERT INTO source_checks (
      id, source_key, auction_id, scope, checked_at, success, status_code,
      latency_ms, result_count, expected_result_count, coverage_status,
      error_code, error_message, response_hash, created_at
    ) VALUES (
      ?1, 'gsa-auctions', ?2, ?3, ?4, 0, NULL,
      NULL, 0, 1, 'in-progress', NULL, NULL, NULL, ?4
    )`,
  ).bind(sourceCheckId, candidate.id, SOURCE_CHECK_SCOPE, checkedAt).run();
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
  candidate: ClosingAuctionCandidate,
  checkedAt: Date,
  fetchLiveBid: LiveBidFetcher,
): Promise<RefreshResult> {
  const sourceCheckId = crypto.randomUUID();
  const checkStartedMs = Date.now();
  const checkedAtIso = checkedAt.toISOString();
  await beginSourceCheck(db, candidate, sourceCheckId, checkedAtIso);

  try {
    const snapshot = await fetchLiveBid(candidate.external_id, {
      now: () => checkedAt,
    });
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
           SELECT ?1, a.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?3
           FROM auctions a
           WHERE a.id = ?9
             AND a.external_id = ?10
             AND ?3 > a.last_checked_at
             AND (
               a.current_bid_cents IS NOT ?4
               OR a.bidder_count IS NOT ?5
               OR a.status IS NOT ?6
               OR a.ends_at IS NOT ?7
             )`,
        ).bind(
          crypto.randomUUID(),
          sourceCheckId,
          snapshot.lastCheckedAt,
          snapshot.currentBidCents,
          snapshot.bidderCount,
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
           bidder_count = ?4,
           status = ?5,
           ends_at = ?6,
           ended_at = CASE
             WHEN ?5 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN COALESCE(ended_at, ?6)
             ELSE ended_at
           END,
           final_bid_cents = CASE
             WHEN ?5 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN ?3 ELSE final_bid_cents
           END,
           final_status = CASE
             WHEN ?5 IN ('ended', 'sold', 'unsold', 'cancelled')
             THEN 'closed-high-bid-unverified' ELSE final_status
           END,
           last_checked_at = ?7,
           price_changed_at = CASE
             WHEN current_bid_cents IS NOT ?3 OR bidder_count IS NOT ?4
             THEN ?7 ELSE price_changed_at
           END,
           updated_at = ?7
         WHERE id = ?1
           AND external_id = ?2
           AND ?7 > last_checked_at`,
      ).bind(
        candidate.id,
        candidate.external_id,
        snapshot.currentBidCents,
        snapshot.bidderCount,
        snapshot.status,
        snapshot.endsAt,
        snapshot.lastCheckedAt,
      ),
    );
    if (isTerminal(snapshot.status) && snapshot.currentBidCents !== null) {
      statements.push(
        db.prepare(
          `INSERT INTO comparable_sales (
             id, source_key, external_id, source_auction_id, canonical_url,
             normalized_vehicle_key, vin, year, make, model, trim, drivetrain,
             mileage, condition, title_status, operability, city, state,
             closed_high_bid_cents, awarded_price_cents, award_status,
             reserve_status, currency, outcome_status, ended_at,
             outcome_observed_at, created_at
           )
           SELECT
             'comp:' || a.id, a.source_key, a.external_id, a.id, a.canonical_url,
             v.normalized_vehicle_key, v.vin, v.year, v.make, v.model, v.trim,
             v.drivetrain, v.mileage, v.condition, v.title_status, v.operability,
             a.city, a.state, a.current_bid_cents, NULL, 'unknown',
             a.reserve_status, a.currency,
             CASE
               WHEN a.current_bid_cents > 0 THEN 'closed-high-bid'
               WHEN a.current_bid_cents = 0 AND a.bidder_count = 0 THEN 'no-bid'
               ELSE 'closed-outcome-unknown'
             END,
             a.ends_at, ?2, ?2
           FROM auctions a
           JOIN vehicles v ON v.auction_id = a.id
           WHERE a.id = ?1
             AND a.last_checked_at = ?2
             AND a.status IN ('ended', 'sold', 'unsold', 'cancelled')
             AND a.current_bid_cents IS NOT NULL
           ON CONFLICT(source_key, external_id) DO UPDATE SET
             source_auction_id = excluded.source_auction_id,
             canonical_url = excluded.canonical_url,
             normalized_vehicle_key = excluded.normalized_vehicle_key,
             vin = excluded.vin,
             year = excluded.year,
             make = excluded.make,
             model = excluded.model,
             trim = excluded.trim,
             drivetrain = excluded.drivetrain,
             mileage = excluded.mileage,
             condition = excluded.condition,
             title_status = excluded.title_status,
             operability = excluded.operability,
             city = excluded.city,
             state = excluded.state,
             closed_high_bid_cents = excluded.closed_high_bid_cents,
             awarded_price_cents = NULL,
             award_status = 'unknown',
             reserve_status = excluded.reserve_status,
             outcome_status = excluded.outcome_status,
             ended_at = excluded.ended_at,
             outcome_observed_at = excluded.outcome_observed_at`,
        ).bind(candidate.id, snapshot.lastCheckedAt),
      );
    }
    statements.push(
      db.prepare(
        `UPDATE source_checks SET
           success = 1, status_code = 200, latency_ms = ?2,
           result_count = 1, expected_result_count = 1,
           coverage_status = 'complete', error_code = NULL, error_message = NULL
         WHERE id = ?1`,
      ).bind(
        sourceCheckId,
        Math.max(0, Date.now() - checkStartedMs),
      ),
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
  candidates: ClosingAuctionCandidate[],
  now: Date,
  options: ClosingRefreshOptions,
): Promise<ClosingRefreshPassSummary> {
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
      options.fetchLiveBid ?? fetchPpmsLiveBid,
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
  total: ClosingRefreshCycleSummary,
  pass: ClosingRefreshPassSummary,
) {
  total.due += pass.due;
  total.succeeded += pass.succeeded;
  total.failed += pass.failed;
  total.observationsAppended += pass.observationsAppended;
  total.dueBuckets = [...new Set([...total.dueBuckets, ...pass.dueBuckets])];
}

/**
 * Runs the minute-level server collector. Each sub-minute checkpoint is
 * scheduled only when at least one candidate will be due in an urgent cadence.
 */
export async function runClosingWindowRefresh(
  db: D1Database,
  options: ClosingRefreshOptions = {},
): Promise<ClosingRefreshCycleSummary> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((delayMs: number) => scheduler.wait(delayMs));
  const cycleStartedAt = now();
  const candidates = await listClosingAuctionCandidates(
    db,
    cycleStartedAt,
    options.candidateLimit,
  );
  const initial = await refreshPass(db, candidates, cycleStartedAt, options);
  const summary: ClosingRefreshCycleSummary = {
    ...initial,
    passes: 1,
    waitedOffsetsMs: [],
  };

  // Evaluate the fixed sub-minute checkpoints against every candidate, not
  // just rows due at second zero. This prevents a row checked shortly before
  // the cron tick from going unobserved for the rest of its closing minute.
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

export { SOURCE_CHECK_SCOPE };
