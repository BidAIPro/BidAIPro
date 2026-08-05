import {
  fetchClosedGsaVehicleComps,
  type GsaClosedComparable,
  type GsaClosedCompDiscovery,
} from "./gsa-closed-comps.ts";
import { canonicalVehicleFamily } from "./gsa-market-valuations.ts";

export const CLOSED_COMP_SOURCE_CHECK_SCOPE = "closed-comp-incremental";

const DAY_MS = 86_400_000;
const DEFAULT_BOOTSTRAP_DAYS = 7;
const DEFAULT_OVERLAP_DAYS = 2;
const DEFAULT_MAX_WINDOW_DAYS = 14;
const MAX_BOOTSTRAP_DAYS = 30;

interface LatestClosedCompCheck {
  checked_at: string | null;
}

export interface ClosedCompSyncWindow {
  from: Date;
  to: Date;
  mode: "bootstrap" | "incremental" | "catch-up";
}

export interface SyncClosedGsaVehicleCompsOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  bootstrapDays?: number;
  overlapDays?: number;
  maxWindowDays?: number;
  detailConcurrency?: number;
  signal?: AbortSignal;
}

export interface ClosedCompSyncSummary {
  sourceCheckId: string;
  mode: ClosedCompSyncWindow["mode"];
  from: string;
  to: string;
  catalogRows: number;
  terminalClosedRows: number;
  usableClosedHighBids: number;
  insertedOrUpdated: number;
  excludedTerminated: number;
  excludedNoBid: number;
  detailSucceeded: number;
  detailFailed: number;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
  return value;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

/**
 * Creates a bounded, overlapping time window. The overlap intentionally
 * rechecks recently closed lots in case GSA finalizes or corrects a row after
 * its scheduled end. A long outage advances in bounded catch-up slices rather
 * than issuing one unsafe, unbounded request.
 */
export function closedCompSyncWindow(
  coveredThrough: string | null,
  nowValue: Date,
  options: Pick<
    SyncClosedGsaVehicleCompsOptions,
    "bootstrapDays" | "overlapDays" | "maxWindowDays"
  > = {},
): ClosedCompSyncWindow {
  const now = validDate(nowValue, "now");
  const bootstrapDays = boundedInteger(
    options.bootstrapDays ?? DEFAULT_BOOTSTRAP_DAYS,
    "bootstrapDays",
    1,
    MAX_BOOTSTRAP_DAYS,
  );
  const overlapDays = boundedInteger(
    options.overlapDays ?? DEFAULT_OVERLAP_DAYS,
    "overlapDays",
    1,
    7,
  );
  const maxWindowDays = boundedInteger(
    options.maxWindowDays ?? DEFAULT_MAX_WINDOW_DAYS,
    "maxWindowDays",
    2,
    30,
  );
  if (overlapDays >= maxWindowDays) {
    throw new RangeError("overlapDays must be smaller than maxWindowDays.");
  }

  const coveredMs = coveredThrough ? Date.parse(coveredThrough) : Number.NaN;
  if (!Number.isFinite(coveredMs) || coveredMs > now.getTime()) {
    return {
      from: new Date(now.getTime() - bootstrapDays * DAY_MS),
      to: now,
      mode: "bootstrap",
    };
  }

  const from = new Date(coveredMs - overlapDays * DAY_MS);
  const boundedToMs = Math.min(now.getTime(), from.getTime() + maxWindowDays * DAY_MS);
  return {
    from,
    to: new Date(boundedToMs),
    mode: boundedToMs < now.getTime() ? "catch-up" : "incremental",
  };
}

function normalizedVehicleKey(comp: GsaClosedComparable): string {
  const family = canonicalVehicleFamily({
    make: comp.make,
    modelLabel: comp.modelLabel,
    title: comp.title,
  });
  if (family) return `${comp.year ?? "unknown"}|${family}`;
  return [comp.year ?? "unknown", comp.make ?? "unknown", comp.modelLabel ?? comp.title]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function assertOfficialTerminalComparables(
  discovery: GsaClosedCompDiscovery,
  window: ClosedCompSyncWindow,
): void {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const ids = new Set<string>();
  for (const comp of discovery.comparables) {
    const endedAt = Date.parse(comp.endedAt);
    if (
      !comp.auctionId || ids.has(comp.auctionId) ||
      !Number.isSafeInteger(comp.closedHighBidCents) || comp.closedHighBidCents <= 0 ||
      !Number.isFinite(endedAt) || endedAt < from - DAY_MS || endedAt > to + DAY_MS
    ) {
      throw new TypeError("The official closed-auction result contained an invalid terminal comparable.");
    }
    ids.add(comp.auctionId);
  }
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
  upstreamStatus: number | null;
} {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return {
    code: typeof object?.code === "string" ? object.code.slice(0, 120) : "GSA_CLOSED_COMP_SYNC_FAILED",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : "The official GSA closed-comp refresh failed.",
    upstreamStatus: typeof object?.upstreamStatus === "number" ? object.upstreamStatus : null,
  };
}

/**
 * Incrementally adds first-party terminal GSA rows to the comparable ledger.
 * Only an exact Closed status with a positive displayed high bid can reach this
 * function through `fetchClosedGsaVehicleComps`; award price remains null.
 */
export async function syncClosedGsaVehicleComps(
  db: D1Database,
  options: SyncClosedGsaVehicleCompsOptions = {},
): Promise<ClosedCompSyncSummary> {
  const now = validDate(options.now ?? new Date(), "now");
  const latest = await db.prepare(
    `SELECT MAX(checked_at) AS checked_at
     FROM source_checks
     WHERE source_key = 'gsa-auctions'
       AND scope = ?1
       AND success = 1
       AND coverage_status = 'complete'`,
  ).bind(CLOSED_COMP_SOURCE_CHECK_SCOPE).first<LatestClosedCompCheck>();
  const window = closedCompSyncWindow(latest?.checked_at ?? null, now, options);
  const sourceCheckId = crypto.randomUUID();
  const startedAt = Date.now();

  await db.prepare(
    `INSERT INTO source_checks (
       id, source_key, scope, checked_at, success, status_code, latency_ms,
       result_count, expected_result_count, coverage_status, error_code,
       error_message, response_hash, created_at
     ) VALUES (?1, 'gsa-auctions', ?2, ?3, 0, NULL, NULL, 0, NULL,
       'in-progress', NULL, NULL, NULL, ?4)`,
  ).bind(
    sourceCheckId,
    CLOSED_COMP_SOURCE_CHECK_SCOPE,
    window.to.toISOString(),
    now.toISOString(),
  ).run();

  try {
    const discovery = await fetchClosedGsaVehicleComps(options.fetchImpl ?? fetch, {
      now,
      from: window.from,
      to: window.to,
      pageSize: 200,
      detailConcurrency: options.detailConcurrency ?? 6,
      signal: options.signal,
    });
    assertOfficialTerminalComparables(discovery, window);
    if (
      discovery.coverage.detailRequested > 0 &&
      discovery.coverage.detailSucceeded < Math.ceil(discovery.coverage.detailRequested * 0.9)
    ) {
      const error = new Error(
        "The official GSA closed-comp detail refresh was materially incomplete and was not persisted.",
      ) as Error & { code: string };
      error.code = "GSA_CLOSED_COMP_DETAIL_INCOMPLETE";
      throw error;
    }

    const upsert = db.prepare(
      `INSERT INTO comparable_sales (
         id, source_key, external_id, source_auction_id, canonical_url,
         normalized_vehicle_key, vin, year, make, model, trim, drivetrain,
         mileage, condition, title_status, operability, city, state,
         closed_high_bid_cents, awarded_price_cents, award_status,
         reserve_status, currency, outcome_status, ended_at,
         outcome_observed_at, created_at
       ) VALUES (
         ?1, 'gsa-auctions', ?2,
         (SELECT id FROM auctions WHERE source_key = 'gsa-auctions' AND external_id = ?2 LIMIT 1),
         ?3, ?4, NULL, ?5, ?6, ?7, NULL, NULL, ?8, ?9, NULL, ?10, ?11, ?12,
         ?13, NULL, 'unknown', NULL, 'USD', 'closed-high-bid-official-catalog', ?14, ?15, ?15
       ) ON CONFLICT(source_key, external_id) DO UPDATE SET
         source_auction_id = COALESCE(excluded.source_auction_id, comparable_sales.source_auction_id),
         canonical_url = excluded.canonical_url,
         normalized_vehicle_key = excluded.normalized_vehicle_key,
         year = excluded.year,
         make = excluded.make,
         model = excluded.model,
         mileage = excluded.mileage,
         condition = excluded.condition,
         operability = excluded.operability,
         city = excluded.city,
         state = excluded.state,
         closed_high_bid_cents = excluded.closed_high_bid_cents,
         awarded_price_cents = comparable_sales.awarded_price_cents,
         award_status = comparable_sales.award_status,
         outcome_status = 'closed-high-bid-official-catalog',
         ended_at = excluded.ended_at,
         outcome_observed_at = excluded.outcome_observed_at
       WHERE excluded.outcome_observed_at >= comparable_sales.outcome_observed_at`,
    );

    for (const group of chunks(discovery.comparables, 20)) {
      await db.batch(group.map((comp) => upsert.bind(
        `comp:gsa:${comp.auctionId}`,
        comp.auctionId,
        comp.sourceUrl,
        normalizedVehicleKey(comp),
        comp.year ?? 0,
        comp.make ?? "Unknown",
        comp.modelLabel ?? comp.title,
        comp.mileage,
        comp.condition,
        comp.operability,
        comp.city,
        comp.state,
        comp.closedHighBidCents,
        comp.endedAt,
        discovery.observedAt,
      )));
    }

    await db.prepare(
      `UPDATE source_checks SET
         success = 1, status_code = 200, latency_ms = ?2,
         result_count = ?3, expected_result_count = ?4,
         coverage_status = 'complete', error_code = NULL, error_message = NULL
       WHERE id = ?1`,
    ).bind(
      sourceCheckId,
      Math.max(0, Date.now() - startedAt),
      discovery.comparables.length,
      discovery.coverage.catalogRows,
    ).run();

    return {
      sourceCheckId,
      mode: window.mode,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      catalogRows: discovery.coverage.catalogRows,
      terminalClosedRows: discovery.coverage.closedRows,
      usableClosedHighBids: discovery.coverage.usableClosedHighBids,
      insertedOrUpdated: discovery.comparables.length,
      excludedTerminated: discovery.coverage.excludedTerminated,
      excludedNoBid: discovery.coverage.excludedNoBid,
      detailSucceeded: discovery.coverage.detailSucceeded,
      detailFailed: discovery.coverage.detailFailed,
    };
  } catch (error) {
    const details = errorDetails(error);
    await db.prepare(
      `UPDATE source_checks SET
         success = 0, status_code = ?2, latency_ms = ?3,
         coverage_status = 'failed', error_code = ?4, error_message = ?5
       WHERE id = ?1`,
    ).bind(
      sourceCheckId,
      details.upstreamStatus,
      Math.max(0, Date.now() - startedAt),
      details.code,
      details.message,
    ).run();
    throw error;
  }
}
