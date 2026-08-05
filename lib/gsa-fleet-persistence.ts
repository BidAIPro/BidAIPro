import {
  fetchGsaFleetClosedResults,
  GSA_FLEET_MAX_CLOSED_ROWS,
  GSA_FLEET_SOURCE,
  type GsaFleetListingSnapshot,
  type GsaFleetVehicleRecord,
} from "./gsa-fleet-client.ts";
import { gsaFleetValuationCondition } from "./gsa-fleet-adapter.ts";
import { canonicalVehicleFamily } from "./gsa-market-valuations.ts";

export const GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE = "hourly-internet-catalog";
export const GSA_FLEET_CLOSED_SOURCE_CHECK_SCOPE = "closed-outcome-incremental";
export const GSA_FLEET_HISTORY_SOURCE_CHECK_SCOPE = "closed-outcome-history-backfill";

const DAY_MS = 86_400_000;
const DEFAULT_BOOTSTRAP_DAYS = 7;
const DEFAULT_OVERLAP_DAYS = 2;
const DEFAULT_HISTORY_WINDOW_DAYS = 14;

interface ExistingFleetAuctionState {
  current_bid_cents: number | null;
  status: string;
  ends_at: string | null;
}

interface LatestFleetClosedCheck {
  checked_at: string | null;
}

interface FleetHistoryCursor {
  checked_at: string | null;
  result_count: number | null;
  coverage_status: string | null;
}

interface EarliestFleetComparable {
  ended_at: string | null;
}

export interface GsaFleetActivePersistenceSummary {
  advertised: number;
  activeInternetVehicles: number;
  insertedOrUpdated: number;
  observationsAppended: number;
  archived: number;
  sourceCheckId: string;
}

export interface GsaFleetClosedSyncWindow {
  since: Date;
  through: Date;
  mode: "bootstrap" | "incremental";
}

export interface SyncClosedGsaFleetOutcomesOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  bootstrapDays?: number;
  overlapDays?: number;
  pageSize?: number;
  maxRows?: number;
  signal?: AbortSignal;
}

export interface GsaFleetClosedSyncSummary {
  sourceCheckId: string;
  mode: GsaFleetClosedSyncWindow["mode"];
  since: string;
  through: string;
  advertised: number;
  closedRows: number;
  confirmedAwardedOutcomes: number;
  insertedOrUpdated: number;
  excludedWithoutConfirmedPrice: number;
}

export interface GsaFleetHistoryBackfillSummary {
  status: "backfilled" | "complete" | "not-ready";
  since: string | null;
  through: string | null;
  closedRows: number;
  confirmedAwardedOutcomes: number;
}

function chunks<T>(values: readonly T[], size = 30): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function comparableOutcomeRows(rows: readonly GsaFleetVehicleRecord[]) {
  return rows.filter((vehicle) =>
    vehicle.isComparableOutcome &&
    vehicle.finalPriceCents !== null &&
    vehicle.finalPriceCents > 0 &&
    vehicle.year !== null &&
    vehicle.make !== null &&
    vehicle.model !== null &&
    vehicle.effectiveEndsAt !== null
  );
}

async function upsertFleetComparableRows(
  db: D1Database,
  rows: readonly GsaFleetVehicleRecord[],
  observedAt: string,
): Promise<number> {
  const comparableRows = comparableOutcomeRows(rows);
  const upsert = db.prepare(
    `INSERT INTO comparable_sales (
       id, source_key, external_id, source_auction_id, canonical_url,
       normalized_vehicle_key, vin, year, make, model, trim, drivetrain,
       mileage, condition, title_status, operability, city, state,
       closed_high_bid_cents, awarded_price_cents, award_status,
       reserve_status, currency, outcome_status, ended_at,
       outcome_observed_at, created_at
     ) VALUES (
       ?1, 'gsa-fleet', ?2,
       (SELECT id FROM auctions WHERE source_key = 'gsa-fleet' AND external_id = ?2 LIMIT 1),
       ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, ?10, NULL, 'unknown',
       ?11, ?12, ?13, ?14, 'confirmed', ?15, 'USD',
       'awarded-price-official-gsa-fleet', ?16, ?17, ?17
     ) ON CONFLICT(source_key, external_id) DO UPDATE SET
       source_auction_id = COALESCE(excluded.source_auction_id, comparable_sales.source_auction_id),
       canonical_url = excluded.canonical_url,
       normalized_vehicle_key = excluded.normalized_vehicle_key,
       vin = COALESCE(excluded.vin, comparable_sales.vin),
       year = excluded.year,
       make = excluded.make,
       model = excluded.model,
       mileage = COALESCE(excluded.mileage, comparable_sales.mileage),
       condition = excluded.condition,
       city = excluded.city,
       state = excluded.state,
       closed_high_bid_cents = excluded.closed_high_bid_cents,
       awarded_price_cents = excluded.awarded_price_cents,
       award_status = 'confirmed',
       reserve_status = excluded.reserve_status,
       outcome_status = 'awarded-price-official-gsa-fleet',
       ended_at = excluded.ended_at,
       outcome_observed_at = excluded.outcome_observed_at
     WHERE excluded.outcome_observed_at >= comparable_sales.outcome_observed_at`,
  );
  for (const group of chunks(comparableRows, 30)) {
    await db.batch(group.map((vehicle) => upsert.bind(
      `comp:gsa-fleet:${vehicle.sourceId}`,
      vehicle.sourceId,
      vehicle.sourceUrl,
      normalizedVehicleKey(vehicle),
      vehicle.vin,
      vehicle.year,
      vehicle.make,
      vehicle.model,
      vehicle.mileage,
      gsaFleetValuationCondition(vehicle.conditionCode),
      vehicle.location.city,
      vehicle.location.state,
      vehicle.highBidCents !== null && vehicle.highBidCents > 0
        ? vehicle.highBidCents
        : 0,
      vehicle.finalPriceCents,
      vehicle.floorPriceCents === null ? null : "floor-price-exposed",
      vehicle.effectiveEndsAt,
      observedAt,
    )));
  }
  return comparableRows.length;
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

function fleetAuctionId(vehicle: GsaFleetVehicleRecord): string {
  return vehicle.externalKey;
}

function title(vehicle: GsaFleetVehicleRecord): string {
  return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "GSA Fleet vehicle";
}

function saleLotNumber(vehicle: GsaFleetVehicleRecord): string {
  return [
    vehicle.saleNumber ?? "GSA Fleet",
    vehicle.saleRunNumber ? `Run ${vehicle.saleRunNumber}` : null,
    vehicle.sourceId,
  ].filter(Boolean).join(" / ");
}

function normalizedVehicleKey(vehicle: GsaFleetVehicleRecord): string {
  const vehicleTitle = title(vehicle);
  const family = canonicalVehicleFamily({
    make: vehicle.make,
    modelLabel: vehicle.model,
    title: vehicleTitle,
  });
  const fallbackFamily = [vehicle.make, vehicle.model]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim() || "unknown";
  return `${vehicle.year ?? "unknown"}|${family ?? fallbackFamily}`;
}

function conditionDescription(vehicle: GsaFleetVehicleRecord): string {
  const details = [
    "Official GSA Fleet Marketplace listing.",
    vehicle.conditionCode ? `Upstream condition code: ${vehicle.conditionCode}.` : null,
    vehicle.saleType ? `Sale type: ${vehicle.saleType}.` : null,
  ];
  return details.filter(Boolean).join(" ");
}

function assertSnapshot(
  snapshot: GsaFleetListingSnapshot,
  expectedKind: GsaFleetListingSnapshot["kind"],
): void {
  if (
    snapshot.source !== GSA_FLEET_SOURCE ||
    snapshot.kind !== expectedKind ||
    snapshot.complete !== true ||
    !Number.isSafeInteger(snapshot.advertisedCount) ||
    snapshot.advertisedCount < 0 ||
    (expectedKind === "active-and-coming" && snapshot.advertisedCount === 0) ||
    snapshot.advertisedCount !== snapshot.rows.length ||
    !Number.isFinite(Date.parse(snapshot.observedAt))
  ) {
    const error = new Error(
      "The public GSA Fleet snapshot failed the completeness guard and was not persisted.",
    ) as Error & { code: string };
    error.code = "GSA_FLEET_IMPLAUSIBLE_COVERAGE";
    throw error;
  }
}

async function readExistingFleetAuctions(
  db: D1Database,
  vehicles: readonly GsaFleetVehicleRecord[],
): Promise<Map<string, ExistingFleetAuctionState>> {
  const existing = new Map<string, ExistingFleetAuctionState>();
  const statement = db.prepare(
    `SELECT current_bid_cents, status, ends_at
     FROM auctions
     WHERE source_key = 'gsa-fleet' AND external_id = ?1`,
  );
  for (const group of chunks(vehicles, 40)) {
    const results = await db.batch(group.map((vehicle) => statement.bind(vehicle.sourceId)));
    results.forEach((result, index) => {
      const row = result.results?.[0] as ExistingFleetAuctionState | undefined;
      if (row) existing.set(group[index]!.sourceId, row);
    });
  }
  return existing;
}

function activeSnapshotChanged(
  previous: ExistingFleetAuctionState | undefined,
  vehicle: GsaFleetVehicleRecord,
): boolean {
  return !previous ||
    previous.current_bid_cents !== vehicle.highBidCents ||
    previous.status !== "active" ||
    previous.ends_at !== vehicle.effectiveEndsAt;
}

/**
 * Stores only genuinely active Internet auctions. Scheduled in-person sales
 * remain discoverable from the public feed but are not represented as live web
 * bids. Missing rows require two complete catalog checks before archival.
 */
export async function persistGsaFleetActiveListings(
  db: D1Database,
  snapshot: GsaFleetListingSnapshot,
  options: { latencyMs?: number } = {},
): Promise<GsaFleetActivePersistenceSummary> {
  assertSnapshot(snapshot, "active-and-coming");
  const observedAt = snapshot.observedAt;
  const sourceCheckId = crypto.randomUUID();
  const activeInternetVehicles = snapshot.rows.filter(
    (vehicle) => vehicle.channel === "internet" && vehicle.phase === "active",
  );

  await db.prepare(
    `INSERT INTO source_checks (
       id, source_key, scope, checked_at, success, status_code, latency_ms,
       result_count, expected_result_count, coverage_status, error_code,
       error_message, response_hash, created_at
     ) VALUES (?1, 'gsa-fleet', ?2, ?3, 0, 200, ?4, ?5, ?6,
       'in-progress', NULL, NULL, NULL, ?3)`,
  ).bind(
    sourceCheckId,
    GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE,
    observedAt,
    options.latencyMs ?? null,
    activeInternetVehicles.length,
    snapshot.advertisedCount,
  ).run();

  const existing = await readExistingFleetAuctions(db, activeInternetVehicles);
  const auctionStatement = db.prepare(
    `INSERT INTO auctions (
       id, source_key, external_id, sale_lot_number, title, canonical_url,
       status, currency, current_bid_cents, bidder_count, bid_increment_cents,
       reserve_status, starts_at, ends_at, seller_agency, city, state,
       postal_code, address, primary_image_url, first_seen_at, last_seen_at,
       last_checked_at, price_changed_at, created_at, updated_at
     ) VALUES (
       ?1, 'gsa-fleet', ?2, ?3, ?4, ?5, 'active', 'USD', ?6, NULL, NULL,
       ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?15, ?15, ?15, ?16, ?15, ?15
     ) ON CONFLICT(source_key, external_id) DO UPDATE SET
       sale_lot_number = excluded.sale_lot_number,
       title = excluded.title,
       canonical_url = excluded.canonical_url,
       status = CASE WHEN excluded.last_checked_at >= auctions.last_checked_at
         THEN excluded.status ELSE auctions.status END,
       current_bid_cents = CASE WHEN excluded.last_checked_at >= auctions.last_checked_at
         THEN excluded.current_bid_cents ELSE auctions.current_bid_cents END,
       reserve_status = excluded.reserve_status,
       starts_at = excluded.starts_at,
       ends_at = CASE WHEN excluded.last_checked_at >= auctions.last_checked_at
         THEN excluded.ends_at ELSE auctions.ends_at END,
       seller_agency = excluded.seller_agency,
       city = excluded.city,
       state = excluded.state,
       postal_code = excluded.postal_code,
       primary_image_url = COALESCE(excluded.primary_image_url, auctions.primary_image_url),
       last_seen_at = CASE WHEN excluded.last_seen_at >= auctions.last_seen_at
         THEN excluded.last_seen_at ELSE auctions.last_seen_at END,
       last_checked_at = CASE WHEN excluded.last_checked_at >= auctions.last_checked_at
         THEN excluded.last_checked_at ELSE auctions.last_checked_at END,
       price_changed_at = CASE
         WHEN excluded.last_checked_at >= auctions.last_checked_at
           AND auctions.current_bid_cents IS NOT excluded.current_bid_cents
         THEN excluded.last_checked_at ELSE auctions.price_changed_at END,
       updated_at = CASE WHEN excluded.updated_at >= auctions.updated_at
         THEN excluded.updated_at ELSE auctions.updated_at END`,
  );
  const vehicleStatement = db.prepare(
    `INSERT INTO vehicles (
       id, auction_id, vin, normalized_vehicle_key, year, make, model,
       body_style, mileage, odometer_status, fuel_type, condition, operability,
       condition_description, damage_flags_json, feature_flags_json,
       service_records_json, source_description, created_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'unknown', 'unknown',
       ?12, '[]', ?13, '[]', ?12, ?14, ?14
     ) ON CONFLICT(auction_id) DO UPDATE SET
       vin = COALESCE(excluded.vin, vehicles.vin),
       normalized_vehicle_key = excluded.normalized_vehicle_key,
       year = excluded.year,
       make = excluded.make,
       model = excluded.model,
       body_style = COALESCE(excluded.body_style, vehicles.body_style),
       mileage = COALESCE(excluded.mileage, vehicles.mileage),
       odometer_status = excluded.odometer_status,
       fuel_type = COALESCE(excluded.fuel_type, vehicles.fuel_type),
       condition_description = excluded.condition_description,
       feature_flags_json = excluded.feature_flags_json,
       source_description = excluded.source_description,
       updated_at = excluded.updated_at`,
  );
  const observationStatement = db.prepare(
    `INSERT OR IGNORE INTO bid_observations (
       id, auction_id, source_check_id, observed_at, current_bid_cents,
       bidder_count, status, ends_at, extension_count, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'active', ?6, 0, ?4)`,
  );

  let observationsAppended = 0;
  for (const group of chunks(activeInternetVehicles, 20)) {
    const statements: D1PreparedStatement[] = [];
    for (const vehicle of group) {
      const auctionId = fleetAuctionId(vehicle);
      const didChange = activeSnapshotChanged(existing.get(vehicle.sourceId), vehicle);
      statements.push(auctionStatement.bind(
        auctionId,
        vehicle.sourceId,
        saleLotNumber(vehicle),
        title(vehicle),
        vehicle.sourceUrl,
        vehicle.highBidCents,
        vehicle.floorPriceCents === null ? null : "floor-price-exposed",
        vehicle.startsAt,
        vehicle.effectiveEndsAt,
        vehicle.location.vendorName ?? "U.S. General Services Administration",
        vehicle.location.city ?? "Location pending",
        vehicle.location.state ?? "—",
        vehicle.location.postalCode ?? "",
        vehicle.images[0] ?? null,
        observedAt,
        didChange ? observedAt : null,
      ));
      statements.push(vehicleStatement.bind(
        `${auctionId}:vehicle`,
        auctionId,
        vehicle.vin,
        normalizedVehicleKey(vehicle),
        vehicle.year ?? 0,
        vehicle.make ?? "Unknown",
        vehicle.model ?? title(vehicle),
        vehicle.vehicleType,
        vehicle.mileage,
        vehicle.mileage === null ? "not-reported" : "reported",
        vehicle.fuelType,
        conditionDescription(vehicle),
        JSON.stringify(vehicle.conditionCode ? [`gsa-fleet-condition-code:${vehicle.conditionCode}`] : []),
        observedAt,
      ));
      if (didChange) {
        observationsAppended += 1;
        statements.push(observationStatement.bind(
          crypto.randomUUID(),
          auctionId,
          sourceCheckId,
          observedAt,
          vehicle.highBidCents,
          vehicle.effectiveEndsAt,
        ));
      }
    }
    await db.batch(statements);
  }

  const archiveResult = await db.prepare(
    `WITH previous_complete AS (
       SELECT MAX(checked_at) AS checked_at
       FROM source_checks
       WHERE source_key = 'gsa-fleet'
         AND scope = ?2
         AND success = 1
         AND coverage_status = 'complete'
         AND checked_at < ?1
     )
     UPDATE auctions SET
       status = 'ended',
       ended_at = COALESCE(ends_at, ?1),
       final_bid_cents = current_bid_cents,
       final_status = 'closed-high-bid-unverified',
       updated_at = ?1
     WHERE source_key = 'gsa-fleet'
       AND status IN ('active', 'closing')
       AND (SELECT checked_at FROM previous_complete) IS NOT NULL
       AND last_seen_at < (SELECT checked_at FROM previous_complete)`,
  ).bind(observedAt, GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE).run();

  await db.prepare(
    `UPDATE source_checks
     SET success = 1, coverage_status = 'complete'
     WHERE id = ?1`,
  ).bind(sourceCheckId).run();

  return {
    advertised: snapshot.advertisedCount,
    activeInternetVehicles: activeInternetVehicles.length,
    insertedOrUpdated: activeInternetVehicles.length,
    observationsAppended,
    archived: archiveResult.meta.changes ?? 0,
    sourceCheckId,
  };
}

export function gsaFleetClosedSyncWindow(
  coveredThrough: string | null,
  nowValue: Date,
  options: Pick<SyncClosedGsaFleetOutcomesOptions, "bootstrapDays" | "overlapDays"> = {},
): GsaFleetClosedSyncWindow {
  const now = validDate(nowValue, "now");
  const bootstrapDays = boundedInteger(
    options.bootstrapDays ?? DEFAULT_BOOTSTRAP_DAYS,
    "bootstrapDays",
    1,
    30,
  );
  const overlapDays = boundedInteger(
    options.overlapDays ?? DEFAULT_OVERLAP_DAYS,
    "overlapDays",
    1,
    7,
  );
  const coveredMs = coveredThrough ? Date.parse(coveredThrough) : Number.NaN;
  if (!Number.isFinite(coveredMs) || coveredMs > now.getTime()) {
    return {
      since: new Date(now.getTime() - bootstrapDays * DAY_MS),
      through: now,
      mode: "bootstrap",
    };
  }
  return {
    since: new Date(coveredMs - overlapDays * DAY_MS),
    through: now,
    mode: "incremental",
  };
}

function fleetErrorDetails(error: unknown): {
  code: string;
  message: string;
  upstreamStatus: number | null;
} {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return {
    code: typeof object?.code === "string"
      ? object.code.slice(0, 120)
      : "GSA_FLEET_SYNC_FAILED",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : "The official GSA Fleet Marketplace refresh failed.",
    upstreamStatus: typeof object?.upstreamStatus === "number" ? object.upstreamStatus : null,
  };
}

/** Records a bounded Fleet failure row when fetching fails before persistence starts. */
export async function recordGsaFleetSourceFailure(
  db: D1Database,
  error: unknown,
  options: {
    scope?: string;
    checkedAt?: string;
    latencyMs?: number;
  } = {},
): Promise<void> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const detail = fleetErrorDetails(error);
  await db.prepare(
    `INSERT INTO source_checks (
       id, source_key, scope, checked_at, success, status_code, latency_ms,
       result_count, expected_result_count, coverage_status, error_code,
       error_message, response_hash, created_at
     ) VALUES (?1, 'gsa-fleet', ?2, ?3, 0, ?4, ?5, 0, NULL,
       'failed', ?6, ?7, NULL, ?3)`,
  ).bind(
    crypto.randomUUID(),
    options.scope ?? GSA_FLEET_ACTIVE_SOURCE_CHECK_SCOPE,
    checkedAt,
    detail.upstreamStatus,
    options.latencyMs ?? null,
    detail.code,
    detail.message,
  ).run();
}

/**
 * Incrementally stores authoritative GSA Fleet awarded prices. A displayed
 * high bid is retained separately and is never promoted to an award by itself.
 */
export async function syncClosedGsaFleetOutcomes(
  db: D1Database,
  options: SyncClosedGsaFleetOutcomesOptions = {},
): Promise<GsaFleetClosedSyncSummary> {
  const now = validDate(options.now ?? new Date(), "now");
  const latest = await db.prepare(
    `SELECT MAX(checked_at) AS checked_at
     FROM source_checks
     WHERE source_key = 'gsa-fleet'
       AND scope = ?1
       AND success = 1
       AND coverage_status = 'complete'`,
  ).bind(GSA_FLEET_CLOSED_SOURCE_CHECK_SCOPE).first<LatestFleetClosedCheck>();
  const window = gsaFleetClosedSyncWindow(latest?.checked_at ?? null, now, options);
  const sourceCheckId = crypto.randomUUID();
  const startedAt = Date.now();

  await db.prepare(
    `INSERT INTO source_checks (
       id, source_key, scope, checked_at, success, status_code, latency_ms,
       result_count, expected_result_count, coverage_status, error_code,
       error_message, response_hash, created_at
     ) VALUES (?1, 'gsa-fleet', ?2, ?3, 0, NULL, NULL, 0, NULL,
       'in-progress', NULL, NULL, NULL, ?3)`,
  ).bind(
    sourceCheckId,
    GSA_FLEET_CLOSED_SOURCE_CHECK_SCOPE,
    window.through.toISOString(),
  ).run();

  try {
    const snapshot = await fetchGsaFleetClosedResults({
      fetchImpl: options.fetchImpl,
      now,
      since: window.since,
      pageSize: options.pageSize ?? 1_000,
      maxRows: options.maxRows ?? GSA_FLEET_MAX_CLOSED_ROWS,
      forceRefresh: true,
      cacheResult: false,
      signal: options.signal,
    });
    assertSnapshot(snapshot, "closed-results");
    const comparableRowCount = await upsertFleetComparableRows(
      db,
      snapshot.rows,
      snapshot.observedAt,
    );

    await db.prepare(
      `UPDATE source_checks SET
         success = 1, status_code = 200, latency_ms = ?2,
         result_count = ?3, expected_result_count = ?4,
         coverage_status = 'complete', error_code = NULL, error_message = NULL
       WHERE id = ?1`,
    ).bind(
      sourceCheckId,
      Math.max(0, Date.now() - startedAt),
      comparableRowCount,
      snapshot.advertisedCount,
    ).run();

    return {
      sourceCheckId,
      mode: window.mode,
      since: window.since.toISOString(),
      through: window.through.toISOString(),
      advertised: snapshot.advertisedCount,
      closedRows: snapshot.rows.length,
      confirmedAwardedOutcomes: comparableRowCount,
      insertedOrUpdated: comparableRowCount,
      excludedWithoutConfirmedPrice: snapshot.rows.length - comparableRowCount,
    };
  } catch (error) {
    const detail = fleetErrorDetails(error);
    await db.prepare(
      `UPDATE source_checks SET
         success = 0, status_code = ?2, latency_ms = ?3,
         coverage_status = 'failed', error_code = ?4, error_message = ?5
       WHERE id = ?1`,
    ).bind(
      sourceCheckId,
      detail.upstreamStatus,
      Math.max(0, Date.now() - startedAt),
      detail.code,
      detail.message,
    ).run();
    throw error;
  }
}

/**
 * Walks one bounded window backward from the durable corpus on each hourly
 * Fleet cycle. Incremental sync remains fast while older awarded outcomes are
 * accumulated without ever loading the full public history in one Worker.
 */
export async function backfillClosedGsaFleetOutcomes(
  db: D1Database,
  options: SyncClosedGsaFleetOutcomesOptions & { historyWindowDays?: number } = {},
): Promise<GsaFleetHistoryBackfillSummary> {
  const now = validDate(options.now ?? new Date(), "now");
  const windowDays = boundedInteger(
    options.historyWindowDays ?? DEFAULT_HISTORY_WINDOW_DAYS,
    "historyWindowDays",
    1,
    30,
  );
  const cursor = await db.prepare(
    `SELECT checked_at, result_count, coverage_status
     FROM source_checks
     WHERE source_key = 'gsa-fleet'
       AND scope = ?1
       AND success = 1
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(GSA_FLEET_HISTORY_SOURCE_CHECK_SCOPE).first<FleetHistoryCursor>();
  if (cursor?.coverage_status === "complete") {
    return {
      status: "complete",
      since: cursor.checked_at,
      through: cursor.checked_at,
      closedRows: 0,
      confirmedAwardedOutcomes: 0,
    };
  }

  let throughValue = cursor?.checked_at ?? null;
  if (!throughValue) {
    const earliest = await db.prepare(
      `SELECT MIN(ended_at) AS ended_at
       FROM comparable_sales
       WHERE source_key = 'gsa-fleet'
         AND award_status = 'confirmed'
         AND outcome_status = 'awarded-price-official-gsa-fleet'`,
    ).first<EarliestFleetComparable>();
    throughValue = earliest?.ended_at ?? null;
  }
  const throughMs = throughValue ? Date.parse(throughValue) : Number.NaN;
  if (!Number.isFinite(throughMs)) {
    return {
      status: "not-ready",
      since: null,
      through: null,
      closedRows: 0,
      confirmedAwardedOutcomes: 0,
    };
  }
  const through = new Date(throughMs);
  const since = new Date(throughMs - windowDays * DAY_MS);

  try {
    const snapshot = await fetchGsaFleetClosedResults({
      fetchImpl: options.fetchImpl,
      now,
      since,
      through,
      pageSize: options.pageSize ?? 1_000,
      maxRows: options.maxRows ?? GSA_FLEET_MAX_CLOSED_ROWS,
      forceRefresh: true,
      cacheResult: false,
      signal: options.signal,
    });
    if (
      snapshot.source !== GSA_FLEET_SOURCE ||
      snapshot.kind !== "closed-results" ||
      snapshot.complete !== true ||
      !Number.isSafeInteger(snapshot.advertisedCount) ||
      snapshot.advertisedCount < 0 ||
      snapshot.advertisedCount !== snapshot.rows.length
    ) {
      const error = new Error(
        "The historical GSA Fleet window failed the completeness guard.",
      ) as Error & { code: string };
      error.code = "GSA_FLEET_HISTORY_IMPLAUSIBLE_COVERAGE";
      throw error;
    }
    const comparableRowCount = await upsertFleetComparableRows(
      db,
      snapshot.rows,
      snapshot.observedAt,
    );
    const empty = snapshot.rows.length === 0;
    // A single empty window may be a seasonal gap. Stop only after two
    // consecutive 14-day windows contain no closed records.
    const complete = empty && cursor?.result_count === 0;
    await db.prepare(
      `INSERT INTO source_checks (
         id, source_key, scope, checked_at, success, status_code, latency_ms,
         result_count, expected_result_count, coverage_status, error_code,
         error_message, response_hash, created_at
       ) VALUES (?1, 'gsa-fleet', ?2, ?3, 1, 200, NULL, ?4, ?5, ?6,
         NULL, NULL, NULL, ?7)`,
    ).bind(
      crypto.randomUUID(),
      GSA_FLEET_HISTORY_SOURCE_CHECK_SCOPE,
      since.toISOString(),
      comparableRowCount,
      snapshot.advertisedCount,
      complete ? "complete" : empty ? "empty-window" : "partial",
      now.toISOString(),
    ).run();
    return {
      status: complete ? "complete" : "backfilled",
      since: since.toISOString(),
      through: through.toISOString(),
      closedRows: snapshot.rows.length,
      confirmedAwardedOutcomes: comparableRowCount,
    };
  } catch (error) {
    await recordGsaFleetSourceFailure(db, error, {
      scope: GSA_FLEET_HISTORY_SOURCE_CHECK_SCOPE,
      checkedAt: now.toISOString(),
    });
    throw error;
  }
}
