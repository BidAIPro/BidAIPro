import type { AuctionStatus } from "./auction-types";

export const HOUR_MS = 60 * 60 * 1_000;
export const FIVE_MINUTES_MS = 5 * 60 * 1_000;
export const THIRTY_SECONDS_MS = 30 * 1_000;
export const FIFTEEN_SECONDS_MS = 15 * 1_000;
export const DEFAULT_CLOSE_GRACE_MS = 2 * 60 * 1_000;

const DAY_MS = 24 * HOUR_MS;
const TERMINAL_STATUSES = new Set<AuctionStatus>([
  "ended",
  "sold",
  "unsold",
  "cancelled",
]);

export type RefreshCadenceBucket =
  | "normal"
  | "last-30-minutes"
  | "last-5-minutes"
  | "last-minute"
  | "close-grace"
  | "close-reconciliation"
  | "stale-close-reconciliation"
  | "stopped";

export interface RefreshPolicyInput {
  now: Date | string | number;
  endsAt: Date | string | number;
  lastCheckedAt?: Date | string | number | null;
  status: AuctionStatus;
  /** True only after GSA has supplied a terminal result. */
  closeConfirmed?: boolean;
  gracePeriodMs?: number;
}

export interface RefreshDecision {
  cadenceBucket: RefreshCadenceBucket;
  intervalMs: number | null;
  dueAt: string | null;
  shouldRefresh: boolean;
  remainingMs: number;
  reason: string;
}

interface ActiveCadence {
  cadenceBucket: Exclude<RefreshCadenceBucket, "stopped">;
  intervalMs: number;
  bucketStartedAt: number | null;
  nextTransitionAt: number | null;
  reason: string;
}

function epoch(value: Date | string | number, field: string) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();

  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${field} must be a valid date or epoch timestamp`);
  }

  return parsed;
}

function activeCadence(
  now: number,
  endsAt: number,
  gracePeriodMs: number,
): ActiveCadence {
  const remaining = endsAt - now;

  if (remaining > 30 * 60 * 1_000) {
    return {
      cadenceBucket: "normal",
      intervalMs: HOUR_MS,
      bucketStartedAt: null,
      nextTransitionAt: endsAt - 30 * 60 * 1_000,
      reason: "More than 30 minutes remain; check hourly.",
    };
  }

  if (remaining > 5 * 60 * 1_000) {
    return {
      cadenceBucket: "last-30-minutes",
      intervalMs: FIVE_MINUTES_MS,
      bucketStartedAt: endsAt - 30 * 60 * 1_000,
      nextTransitionAt: endsAt - 5 * 60 * 1_000,
      reason: "Thirty minutes or less remain; check every five minutes.",
    };
  }

  if (remaining > 60 * 1_000) {
    return {
      cadenceBucket: "last-5-minutes",
      intervalMs: THIRTY_SECONDS_MS,
      bucketStartedAt: endsAt - 5 * 60 * 1_000,
      nextTransitionAt: endsAt - 60 * 1_000,
      reason: "Five minutes or less remain; check every 30 seconds.",
    };
  }

  if (remaining > 0) {
    return {
      cadenceBucket: "last-minute",
      intervalMs: FIFTEEN_SECONDS_MS,
      bucketStartedAt: endsAt - 60 * 1_000,
      nextTransitionAt: endsAt,
      reason: "One minute or less remains; check every 15 seconds.",
    };
  }

  const elapsedSinceScheduledClose = now - endsAt;
  if (elapsedSinceScheduledClose < gracePeriodMs) {
    return {
      cadenceBucket: "close-grace",
      intervalMs: FIFTEEN_SECONDS_MS,
      bucketStartedAt: endsAt,
      nextTransitionAt: endsAt + gracePeriodMs,
      reason: "Scheduled close passed but GSA has not confirmed the outcome.",
    };
  }

  if (elapsedSinceScheduledClose < DAY_MS) {
    return {
      cadenceBucket: "close-reconciliation",
      intervalMs: FIVE_MINUTES_MS,
      bucketStartedAt: endsAt + gracePeriodMs,
      nextTransitionAt: endsAt + DAY_MS,
      reason: "Reconcile the unconfirmed result every five minutes.",
    };
  }

  return {
    cadenceBucket: "stale-close-reconciliation",
    intervalMs: HOUR_MS,
    bucketStartedAt: endsAt + DAY_MS,
    nextTransitionAt: null,
    reason: "The result is still unconfirmed after 24 hours; retry hourly.",
  };
}

/**
 * Returns both the cadence and the next due time. The due time is pulled
 * forward to each urgency boundary so a previously hourly job cannot sleep
 * through the final 30-, 5-, or 1-minute window.
 */
export function getRefreshDecision(input: RefreshPolicyInput): RefreshDecision {
  const now = epoch(input.now, "now");
  const endsAt = epoch(input.endsAt, "endsAt");
  const remainingMs = endsAt - now;
  const terminalStatus = TERMINAL_STATUSES.has(input.status);

  if (input.closeConfirmed || terminalStatus) {
    return {
      cadenceBucket: "stopped",
      intervalMs: null,
      dueAt: null,
      shouldRefresh: false,
      remainingMs,
      reason: "GSA has confirmed a terminal auction outcome.",
    };
  }

  const gracePeriodMs = Math.max(
    0,
    Math.round(input.gracePeriodMs ?? DEFAULT_CLOSE_GRACE_MS),
  );
  const cadence = activeCadence(now, endsAt, gracePeriodMs);

  if (input.lastCheckedAt === undefined || input.lastCheckedAt === null) {
    return {
      cadenceBucket: cadence.cadenceBucket,
      intervalMs: cadence.intervalMs,
      dueAt: new Date(now).toISOString(),
      shouldRefresh: true,
      remainingMs,
      reason: "No successful source check has been recorded.",
    };
  }

  const recordedLastCheck = epoch(input.lastCheckedAt, "lastCheckedAt");
  // A future timestamp indicates clock skew; treating it as now avoids a long
  // accidental pause while keeping the function deterministic.
  const lastCheckedAt = Math.min(recordedLastCheck, now);
  const candidates = [lastCheckedAt + cadence.intervalMs];

  if (
    cadence.bucketStartedAt !== null &&
    lastCheckedAt < cadence.bucketStartedAt &&
    cadence.bucketStartedAt <= now
  ) {
    candidates.push(cadence.bucketStartedAt);
  }

  if (cadence.nextTransitionAt !== null && cadence.nextTransitionAt > now) {
    candidates.push(cadence.nextTransitionAt);
  }

  const dueAtEpoch = Math.min(...candidates);

  return {
    cadenceBucket: cadence.cadenceBucket,
    intervalMs: cadence.intervalMs,
    dueAt: new Date(dueAtEpoch).toISOString(),
    shouldRefresh: dueAtEpoch <= now,
    remainingMs,
    reason: cadence.reason,
  };
}
