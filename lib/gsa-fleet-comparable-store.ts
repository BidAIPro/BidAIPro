import {
  buildGsaFleetComparableIndexFromComparables,
  buildGsaFleetComparableIndex,
  normalizeGsaFleetModel,
  type GsaFleetComparableIndex,
} from "./gsa-fleet-adapter.ts";
import {
  fetchGsaFleetClosedResults,
  GSA_FLEET_BROWSE_URL,
  type GsaFleetClosedResultsOptions,
} from "./gsa-fleet-client.ts";
import type { GsaClosedComparable } from "./gsa-closed-comps.ts";
import type {
  GsaVehicleCondition,
  GsaVehicleOperability,
} from "./gsa-normalizer.ts";

const PAGE_SIZE = 5_000;
const MAX_COMPARABLES = 25_000;
const MIN_DURABLE_COMPARABLES = 100;

interface StoredFleetComparable {
  external_id: string;
  canonical_url: string | null;
  vin: string | null;
  year: number;
  make: string;
  model: string;
  mileage: number | null;
  condition: string | null;
  operability: string | null;
  city: string | null;
  state: string | null;
  awarded_price_cents: number;
  ended_at: string;
  outcome_observed_at: string;
}

interface CompletedFleetComparableSync {
  checked_at: string;
}

export interface DurableGsaFleetComparableIndex {
  index: GsaFleetComparableIndex;
  observedAt: string | null;
  rowCount: number;
}

export interface ResolvedGsaFleetComparableIndex extends DurableGsaFleetComparableIndex {
  mode: "durable" | "recent-official-fallback";
}

type FleetClosedFetcher = typeof fetchGsaFleetClosedResults;

export interface ResolveGsaFleetComparableIndexOptions {
  now?: Date;
  signal?: AbortSignal;
  fallbackDays?: number;
  getFleetClosed?: FleetClosedFetcher;
}

function condition(value: string | null): GsaVehicleCondition {
  switch (value) {
    case "new":
    case "usable":
    case "repairable":
    case "salvage":
    case "scrap":
      return value;
    default:
      return "unknown";
  }
}

function operability(value: string | null): GsaVehicleOperability {
  switch (value) {
    case "runs-and-drives":
    case "runs":
    case "non-operational":
      return value;
    default:
      return "unknown";
  }
}

function validRow(row: StoredFleetComparable): boolean {
  return (
    typeof row.external_id === "string" && row.external_id.length > 0 &&
    Number.isSafeInteger(row.year) && row.year >= 1900 && row.year <= 2200 &&
    typeof row.make === "string" && row.make.length > 0 &&
    typeof row.model === "string" && row.model.length > 0 &&
    Number.isSafeInteger(row.awarded_price_cents) && row.awarded_price_cents > 0 &&
    typeof row.ended_at === "string" && Number.isFinite(Date.parse(row.ended_at)) &&
    typeof row.outcome_observed_at === "string" &&
    Number.isFinite(Date.parse(row.outcome_observed_at))
  );
}

/**
 * Reads compact, authoritative Fleet awarded outcomes already normalized by
 * the hourly sync. This avoids materializing the 17k-row public GraphQL corpus
 * inside a 128 MB Worker while preserving the same valuation inputs.
 */
export async function readDurableGsaFleetComparableIndex(
  db: D1Database,
): Promise<DurableGsaFleetComparableIndex> {
  const comparables: GsaClosedComparable[] = [];
  let observedAt: string | null = null;
  let lastEndedAt: string | null = null;
  let lastExternalId: string | null = null;
  let scannedRows = 0;
  while (true) {
    const remainingWithOverflowSentinel = MAX_COMPARABLES - scannedRows + 1;
    const limit = Math.min(PAGE_SIZE, remainingWithOverflowSentinel);
    const page: D1Result<StoredFleetComparable> = await db.prepare(
      `SELECT external_id, canonical_url, vin, year, make, model, mileage,
         condition, operability, city, state, awarded_price_cents, ended_at,
         outcome_observed_at
       FROM comparable_sales
       WHERE source_key = 'gsa-fleet'
         AND award_status = 'confirmed'
         AND outcome_status = 'awarded-price-official-gsa-fleet'
         AND awarded_price_cents IS NOT NULL
         AND awarded_price_cents > 0
         AND (
           ?1 IS NULL OR ended_at < ?1 OR
           (ended_at = ?1 AND external_id > ?2)
         )
       ORDER BY ended_at DESC, external_id
       LIMIT ?3`,
    ).bind(lastEndedAt, lastExternalId, limit).all<StoredFleetComparable>();
    const rows: StoredFleetComparable[] = page.results ?? [];
    scannedRows += rows.length;
    for (const row of rows) {
      if (!validRow(row)) continue;
      comparables.push({
        id: `gsa-fleet:${row.external_id}`,
        auctionId: row.external_id,
        lotId: row.vin ?? row.external_id,
        sourceUrl: row.canonical_url ?? GSA_FLEET_BROWSE_URL,
        title: `${row.year} ${row.make} ${row.model}`,
        closedHighBidCents: row.awarded_price_cents,
        bidderCount: null,
        endedAt: row.ended_at,
        year: row.year,
        make: row.make,
        modelLabel: normalizeGsaFleetModel(row.model),
        vin: row.vin,
        mileage: row.mileage,
        bodyType: null,
        condition: condition(row.condition),
        operability: operability(row.operability),
        damageFlags: [],
        issueFlags: [],
        city: row.city,
        state: row.state,
        detailEnriched: false,
      });
      if (observedAt === null || row.outcome_observed_at > observedAt) {
        observedAt = row.outcome_observed_at;
      }
    }
    if (scannedRows > MAX_COMPARABLES) {
      const error = new Error(
        `The durable GSA Fleet comparable corpus exceeds ${MAX_COMPARABLES} rows.`,
      ) as Error & { code: string };
      error.code = "GSA_FLEET_COMPARABLE_STORE_LIMIT_EXCEEDED";
      throw error;
    }
    if (rows.length < limit) break;
    const last: StoredFleetComparable = rows.at(-1)!;
    lastEndedAt = last.ended_at;
    lastExternalId = last.external_id;
  }
  return {
    index: buildGsaFleetComparableIndexFromComparables(comparables),
    observedAt,
    rowCount: comparables.length,
  };
}

/**
 * Uses durable awarded outcomes when available and falls back to a bounded
 * recent official window during a new deployment or delayed first cron run.
 * This keeps the public board valued while D1 warms without materializing the
 * full Fleet history inside a memory-limited Worker.
 */
export async function resolveGsaFleetComparableIndex(
  db: D1Database,
  options: ResolveGsaFleetComparableIndexOptions = {},
): Promise<ResolvedGsaFleetComparableIndex> {
  const durable = await readDurableGsaFleetComparableIndex(db);
  const completedSync = durable.rowCount >= MIN_DURABLE_COMPARABLES
    ? await db.prepare(
        `SELECT checked_at
         FROM source_checks
         WHERE source_key = 'gsa-fleet'
           AND scope = 'closed-outcome-incremental'
           AND success = 1
           AND coverage_status = 'complete'
         ORDER BY checked_at DESC
         LIMIT 1`,
      ).first<CompletedFleetComparableSync>()
    : null;
  if (
    durable.rowCount >= MIN_DURABLE_COMPARABLES &&
    completedSync &&
    Number.isFinite(Date.parse(completedSync.checked_at))
  ) {
    return { ...durable, mode: "durable" };
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
  const fallbackDays = options.fallbackDays ?? 7;
  if (!Number.isSafeInteger(fallbackDays) || fallbackDays < 1 || fallbackDays > 30) {
    throw new RangeError("fallbackDays must be between 1 and 30.");
  }
  const fetcher = options.getFleetClosed ?? fetchGsaFleetClosedResults;
  const fetchOptions: GsaFleetClosedResultsOptions = {
    now,
    since: new Date(now.getTime() - fallbackDays * 86_400_000),
    pageSize: 1_000,
    maxRows: 25_000,
    forceRefresh: true,
    cacheResult: false,
    signal: options.signal ?? AbortSignal.timeout(20_000),
  };
  const snapshot = await fetcher(fetchOptions);
  if (
    !snapshot.complete ||
    snapshot.rows.length === 0 ||
    snapshot.rows.length !== snapshot.advertisedCount
  ) {
    const error = new Error(
      "The recent official GSA Fleet comparable fallback was empty or incomplete.",
    ) as Error & { code: string };
    error.code = "GSA_FLEET_COMPARABLE_FALLBACK_INCOMPLETE";
    throw error;
  }
  const index = buildGsaFleetComparableIndex(snapshot.rows);
  if (index.all.length === 0) {
    const error = new Error(
      "The recent official GSA Fleet window contained no confirmed awarded outcomes.",
    ) as Error & { code: string };
    error.code = "GSA_FLEET_COMPARABLE_FALLBACK_EMPTY";
    throw error;
  }
  return {
    index,
    observedAt: snapshot.observedAt,
    rowCount: index.all.length,
    mode: "recent-official-fallback",
  };
}
