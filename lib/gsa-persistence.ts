import type { GsaDiscoveryResult } from "./gsa-client";
import type { GsaVehicleAuction } from "./gsa-normalizer";

interface ExistingAuctionState {
  current_bid_cents: number;
  bid_count: number;
  status: string;
  ends_at: string;
}

export interface PersistenceSummary {
  discovered: number;
  insertedOrUpdated: number;
  observationsAppended: number;
  archived: number;
  sourceCheckId: string;
}

function chunks<T>(values: readonly T[], size = 40): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function cents(value: number | null) {
  return value === null ? null : Math.round(value * 100);
}

function sourceExternalId(auction: GsaVehicleAuction) {
  return auction.url.match(/\/preview\/(\d+)/)?.[1] ?? auction.id;
}

function normalizedVehicleKey(auction: GsaVehicleAuction) {
  return [auction.year ?? "unknown", auction.make ?? "unknown", auction.modelLabel ?? auction.title]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function changed(existing: ExistingAuctionState | null, auction: GsaVehicleAuction) {
  if (!existing) return true;
  return (
    existing.current_bid_cents !== (cents(auction.currentBid) ?? 0) ||
    existing.bid_count !== (auction.bidderCount ?? 0) ||
    existing.status !== auction.status ||
    existing.ends_at !== (auction.endsAt ?? existing.ends_at)
  );
}

async function readExisting(
  db: D1Database,
  auctions: readonly GsaVehicleAuction[],
): Promise<Map<string, ExistingAuctionState>> {
  const existing = new Map<string, ExistingAuctionState>();
  const statement = db.prepare(
    `SELECT current_bid_cents, bid_count, status, ends_at
     FROM auctions WHERE id = ?1`,
  );

  for (const group of chunks(auctions)) {
    const results = await db.batch(group.map((auction) => statement.bind(auction.id)));
    results.forEach((result, index) => {
      const row = result.results?.[0] as ExistingAuctionState | undefined;
      if (row) existing.set(group[index]!.id, row);
    });
  }
  return existing;
}

/**
 * Persists a complete official hourly feed without replacing good data with a
 * partial browser snapshot. Every successful listing check advances freshness;
 * bid history grows only when bid, bidder count, status, or effective end moves.
 */
export async function persistGsaDiscovery(
  db: D1Database,
  discovery: GsaDiscoveryResult,
  options: { latencyMs?: number } = {},
): Promise<PersistenceSummary> {
  if (discovery.sourceHealth.status !== "live") {
    const error = new Error("A stale fallback snapshot cannot be persisted as a fresh GSA catalog.") as Error & {
      code: string;
    };
    error.code = "GSA_STALE_SNAPSHOT_REJECTED";
    throw error;
  }

  const observedAt = discovery.sourceHealth.observedAt;
  const sourceCheckId = crypto.randomUUID();
  const activeAuctions = discovery.auctions.filter(
    (auction) => auction.status === "active" || auction.status === "preview",
  );

  // Create the source check before any observations so their foreign key is
  // always valid. It remains explicitly incomplete if a later D1 batch fails.
  await db.prepare(
    `INSERT INTO source_checks (
      id, source_key, scope, checked_at, success, status_code, latency_ms,
      result_count, expected_result_count, coverage_status, response_hash, created_at
    ) VALUES (?1, 'gsa-auctions', 'hourly-catalog', ?2, 0, 200, ?3, ?4, ?5, 'in-progress', NULL, ?2)`,
  ).bind(
    sourceCheckId,
    observedAt,
    options.latencyMs ?? null,
    activeAuctions.length,
    discovery.coverage.totalLots,
  ).run();

  const existing = await readExisting(db, activeAuctions);

  const upsertAuctionSql = `INSERT INTO auctions (
      id, source_key, external_id, sale_lot_number, title, canonical_url,
      status, currency, current_bid_cents, bid_count, bid_increment_cents,
      reserve_status, starts_at, ends_at, seller_agency, city, state,
      postal_code, address, primary_image_url, first_seen_at, last_seen_at,
      last_checked_at, price_changed_at, created_at, updated_at
    ) VALUES (
      ?1, 'gsa-auctions', ?2, ?3, ?4, ?5, ?6, 'USD', ?7, ?8, ?9,
      ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19, ?19, ?20, ?19, ?19
    ) ON CONFLICT(source_key, external_id) DO UPDATE SET
      sale_lot_number = excluded.sale_lot_number,
      title = excluded.title,
      canonical_url = excluded.canonical_url,
      status = excluded.status,
      current_bid_cents = excluded.current_bid_cents,
      bid_count = excluded.bid_count,
      bid_increment_cents = excluded.bid_increment_cents,
      reserve_status = excluded.reserve_status,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      seller_agency = excluded.seller_agency,
      city = excluded.city,
      state = excluded.state,
      postal_code = excluded.postal_code,
      address = excluded.address,
      primary_image_url = excluded.primary_image_url,
      last_seen_at = excluded.last_seen_at,
      last_checked_at = excluded.last_checked_at,
      price_changed_at = CASE
        WHEN auctions.current_bid_cents <> excluded.current_bid_cents
          OR auctions.bid_count <> excluded.bid_count
        THEN excluded.last_checked_at ELSE auctions.price_changed_at END,
      updated_at = excluded.updated_at`;

  const upsertVehicleSql = `INSERT INTO vehicles (
      id, auction_id, vin, normalized_vehicle_key, year, make, model,
      body_style, mileage, condition, operability, condition_description,
      damage_flags_json, feature_flags_json, service_records_json,
      source_description, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'unknown', 'unknown', ?10,
      '[]', '[]', '[]', ?10, ?11, ?11
    ) ON CONFLICT(auction_id) DO UPDATE SET
      vin = COALESCE(excluded.vin, vehicles.vin),
      normalized_vehicle_key = excluded.normalized_vehicle_key,
      year = excluded.year,
      make = excluded.make,
      model = excluded.model,
      body_style = COALESCE(excluded.body_style, vehicles.body_style),
      mileage = COALESCE(excluded.mileage, vehicles.mileage),
      source_description = excluded.source_description,
      updated_at = excluded.updated_at`;

  const insertObservationSql = `INSERT INTO bid_observations (
      id, auction_id, source_check_id, observed_at, current_bid_cents,
      bid_count, status, ends_at, extension_count, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?4)`;

  const auctionStatement = db.prepare(upsertAuctionSql);
  const vehicleStatement = db.prepare(upsertVehicleSql);
  const observationStatement = db.prepare(insertObservationSql);
  let observationsAppended = 0;

  for (const group of chunks(activeAuctions, 20)) {
    const writes: D1PreparedStatement[] = [];
    for (const auction of group) {
      const externalId = sourceExternalId(auction);
      const saleLotNumber = [auction.saleNumber, auction.lotNumber]
        .filter(Boolean)
        .join(" · Lot ") || auction.id;
      const endsAt = auction.endsAt ?? observedAt;
      const address = auction.location.addressLines.join(", ") || null;
      const previous = existing.get(auction.id) ?? null;
      const didChange = changed(previous, auction);

      writes.push(
        auctionStatement.bind(
          auction.id,
          externalId,
          saleLotNumber,
          auction.title,
          auction.url,
          auction.status,
          cents(auction.currentBid) ?? 0,
          auction.bidderCount ?? 0,
          cents(auction.bidIncrement),
          auction.reserve === null ? null : "reserve-value-exposed",
          auction.startsAt,
          endsAt,
          auction.agency.name,
          auction.location.city ?? "Location pending",
          auction.location.state ?? "—",
          auction.location.postalCode ?? "",
          address,
          auction.imageUrl,
          observedAt,
          didChange ? observedAt : null,
        ),
      );
      writes.push(
        vehicleStatement.bind(
          `${auction.id}:vehicle`,
          auction.id,
          auction.vin,
          normalizedVehicleKey(auction),
          auction.year ?? 0,
          auction.make ?? "Unknown",
          auction.modelLabel ?? auction.title,
          auction.bodyType,
          auction.mileage,
          auction.description,
          observedAt,
        ),
      );
      if (didChange) {
        observationsAppended += 1;
        writes.push(
          observationStatement.bind(
            crypto.randomUUID(),
            auction.id,
            sourceCheckId,
            observedAt,
            cents(auction.currentBid) ?? 0,
            auction.bidderCount ?? 0,
            auction.status,
            endsAt,
          ),
        );
      }
    }
    await db.batch(writes);
  }

  const archiveMissing = db.prepare(
    `UPDATE auctions SET
       status = 'ended',
       ended_at = ?1,
       final_bid_cents = current_bid_cents,
       final_status = 'closed-high-bid-unverified',
       updated_at = ?1
     WHERE source_key = 'gsa-auctions'
       AND status IN ('active', 'preview', 'closing')
       AND last_seen_at < ?1`,
  ).bind(observedAt);

  const completeSourceCheck = db.prepare(
    `UPDATE source_checks
     SET success = 1, coverage_status = 'complete'
     WHERE id = ?1`,
  ).bind(sourceCheckId);

  const [archiveResult] = await db.batch([archiveMissing, completeSourceCheck]);
  const archived = archiveResult?.meta.changes ?? 0;

  await db.prepare(
    `INSERT OR IGNORE INTO comparable_sales (
      id, source_key, external_id, source_auction_id, canonical_url,
      normalized_vehicle_key, vin, year, make, model, trim, drivetrain,
      mileage, condition, title_status, operability, city, state,
      closed_high_bid_cents, awarded_price_cents, award_status, reserve_status,
      currency, outcome_status, ended_at, outcome_observed_at, created_at
    )
    SELECT
      'comp:' || a.id, a.source_key, a.external_id, a.id, a.canonical_url,
      v.normalized_vehicle_key, v.vin, v.year, v.make, v.model, v.trim,
      v.drivetrain, v.mileage, v.condition, v.title_status, v.operability,
      a.city, a.state, a.current_bid_cents, NULL, 'unknown', a.reserve_status,
      a.currency,
      CASE WHEN a.current_bid_cents > 0 THEN 'closed-high-bid' ELSE 'no-bid' END,
      a.ended_at, ?1, ?1
    FROM auctions a
    JOIN vehicles v ON v.auction_id = a.id
    WHERE a.source_key = 'gsa-auctions'
      AND a.status = 'ended'
      AND a.ended_at = ?1`,
  ).bind(observedAt).run();

  return {
    discovered: discovery.coverage.totalLots,
    insertedOrUpdated: activeAuctions.length,
    observationsAppended,
    archived,
    sourceCheckId,
  };
}

/** Records an upstream or persistence failure without leaking credentials. */
export async function recordGsaSourceFailure(
  db: D1Database,
  error: unknown,
  options: { checkedAt?: string; latencyMs?: number } = {},
): Promise<void> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const errorCode =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 120)
      : "GSA_SYNC_FAILED";
  const errorMessage = error instanceof Error
    ? error.message.slice(0, 500)
    : "The official GSA catalog refresh failed.";

  await db.prepare(
    `INSERT INTO source_checks (
      id, source_key, scope, checked_at, success, status_code, latency_ms,
      result_count, expected_result_count, coverage_status, error_code,
      error_message, response_hash, created_at
    ) VALUES (?1, 'gsa-auctions', 'hourly-catalog', ?2, 0, ?3, ?4,
      0, NULL, 'failed', ?5, ?6, NULL, ?2)`,
  ).bind(
    crypto.randomUUID(),
    checkedAt,
    error && typeof error === "object" && "upstreamStatus" in error &&
      typeof error.upstreamStatus === "number" ? error.upstreamStatus : null,
    options.latencyMs ?? null,
    errorCode,
    errorMessage,
  ).run();
}
