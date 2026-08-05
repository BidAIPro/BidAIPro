import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () => text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);
const updatedAt = () => text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`);

export const auctions = sqliteTable(
  "auctions",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull().default("gsa-auctions"),
    externalId: text("external_id").notNull(),
    saleLotNumber: text("sale_lot_number").notNull(),
    title: text("title").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    status: text("status").notNull(),
    currency: text("currency").notNull().default("USD"),
    currentBidCents: integer("current_bid_cents"),
    bidderCount: integer("bidder_count"),
    bidIncrementCents: integer("bid_increment_cents"),
    reserveStatus: text("reserve_status"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    endedAt: text("ended_at"),
    finalBidCents: integer("final_bid_cents"),
    finalStatus: text("final_status"),
    sellerAgency: text("seller_agency"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    address: text("address"),
    pickupTerms: text("pickup_terms"),
    paymentTerms: text("payment_terms"),
    removalDeadline: text("removal_deadline"),
    primaryImageUrl: text("primary_image_url"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastCheckedAt: text("last_checked_at").notNull(),
    priceChangedAt: text("price_changed_at"),
    rawPayloadHash: text("raw_payload_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_auctions_source_external").on(table.sourceKey, table.externalId),
    uniqueIndex("uq_auctions_source_lot").on(table.sourceKey, table.saleLotNumber),
    index("idx_auctions_status_ends_at").on(table.status, table.endsAt),
    index("idx_auctions_source_last_checked").on(table.sourceKey, table.lastCheckedAt),
  ],
);

export const vehicles = sqliteTable(
  "vehicles",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    vin: text("vin"),
    normalizedVehicleKey: text("normalized_vehicle_key").notNull(),
    year: integer("year").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    trim: text("trim"),
    series: text("series"),
    bodyStyle: text("body_style"),
    mileage: integer("mileage"),
    odometerStatus: text("odometer_status"),
    engine: text("engine"),
    cylinders: integer("cylinders"),
    fuelType: text("fuel_type"),
    transmission: text("transmission"),
    drivetrain: text("drivetrain"),
    exteriorColor: text("exterior_color"),
    interiorColor: text("interior_color"),
    titleStatus: text("title_status"),
    condition: text("condition").notNull().default("unknown"),
    operability: text("operability").notNull().default("unknown"),
    keysCount: integer("keys_count"),
    conditionDescription: text("condition_description"),
    damageFlagsJson: text("damage_flags_json").notNull().default("[]"),
    featureFlagsJson: text("feature_flags_json").notNull().default("[]"),
    serviceRecordsJson: text("service_records_json").notNull().default("[]"),
    sourceDescription: text("source_description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_vehicles_auction_id").on(table.auctionId),
    index("idx_vehicles_normalized_key_mileage").on(
      table.normalizedVehicleKey,
      table.mileage,
    ),
    index("idx_vehicles_vin").on(table.vin),
  ],
);

export const sourceChecks = sqliteTable(
  "source_checks",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    auctionId: text("auction_id").references(() => auctions.id, {
      onDelete: "set null",
    }),
    scope: text("scope").notNull(),
    checkedAt: text("checked_at").notNull(),
    success: integer("success", { mode: "boolean" }).notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    resultCount: integer("result_count"),
    expectedResultCount: integer("expected_result_count"),
    coverageStatus: text("coverage_status").notNull().default("unknown"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    responseHash: text("response_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_source_checks_source_checked").on(table.sourceKey, table.checkedAt),
    index("idx_source_checks_auction_checked").on(table.auctionId, table.checkedAt),
  ],
);

export const bidObservations = sqliteTable(
  "bid_observations",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    sourceCheckId: text("source_check_id").references(() => sourceChecks.id, {
      onDelete: "set null",
    }),
    observedAt: text("observed_at").notNull(),
    currentBidCents: integer("current_bid_cents"),
    bidderCount: integer("bidder_count"),
    status: text("status").notNull(),
    endsAt: text("ends_at"),
    extensionCount: integer("extension_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_bid_observations_auction_observed").on(
      table.auctionId,
      table.observedAt,
    ),
    index("idx_bid_observations_auction_time").on(table.auctionId, table.observedAt),
  ],
);

export const valuations = sqliteTable(
  "valuations",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    vehicleId: text("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerKind: text("provider_kind").notNull(),
    providerRecordId: text("provider_record_id"),
    status: text("status").notNull(),
    valuationType: text("valuation_type").notNull(),
    regionPostalCode: text("region_postal_code"),
    inputMileage: integer("input_mileage"),
    inputCondition: text("input_condition"),
    lowCents: integer("low_cents"),
    medianCents: integer("median_cents"),
    highCents: integer("high_cents"),
    confidenceBps: integer("confidence_bps").notNull().default(0),
    sampleSize: integer("sample_size").notNull().default(0),
    asOf: text("as_of").notNull(),
    expiresAt: text("expires_at"),
    sourceUrl: text("source_url"),
    provenanceNote: text("provenance_note").notNull(),
    rawPayloadHash: text("raw_payload_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_valuations_vehicle_as_of").on(table.vehicleId, table.asOf),
    index("idx_valuations_auction_status_as_of").on(
      table.auctionId,
      table.status,
      table.asOf,
    ),
  ],
);

export const comparableSales = sqliteTable(
  "comparable_sales",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    sourceAuctionId: text("source_auction_id").references(() => auctions.id, {
      onDelete: "set null",
    }),
    canonicalUrl: text("canonical_url"),
    normalizedVehicleKey: text("normalized_vehicle_key").notNull(),
    vin: text("vin"),
    year: integer("year").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    trim: text("trim"),
    drivetrain: text("drivetrain"),
    mileage: integer("mileage"),
    condition: text("condition"),
    titleStatus: text("title_status"),
    operability: text("operability"),
    city: text("city"),
    state: text("state"),
    // GSA closed records expose a high bid, but that is not proof of award.
    // Preserve the observed number separately and fill the awarded price only
    // when an authoritative outcome source confirms the sale.
    closedHighBidCents: integer("closed_high_bid_cents").notNull(),
    awardedPriceCents: integer("awarded_price_cents"),
    awardStatus: text("award_status").notNull().default("unknown"),
    reserveStatus: text("reserve_status"),
    currency: text("currency").notNull().default("USD"),
    outcomeStatus: text("outcome_status").notNull(),
    endedAt: text("ended_at").notNull(),
    outcomeObservedAt: text("outcome_observed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_comparable_sales_source_external").on(
      table.sourceKey,
      table.externalId,
    ),
    index("idx_comparable_sales_vehicle_ended").on(
      table.normalizedVehicleKey,
      table.endedAt,
    ),
  ],
);

export const comparableLinks = sqliteTable(
  "comparable_links",
  {
    id: text("id").primaryKey(),
    subjectAuctionId: text("subject_auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    comparableSaleId: text("comparable_sale_id")
      .notNull()
      .references(() => comparableSales.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    matchScoreBps: integer("match_score_bps").notNull(),
    matchReason: text("match_reason").notNull(),
    adjustmentCents: integer("adjustment_cents").notNull().default(0),
    weightBps: integer("weight_bps").notNull().default(10000),
    asOf: text("as_of").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_comparable_links_subject_comp_purpose").on(
      table.subjectAuctionId,
      table.comparableSaleId,
      table.purpose,
    ),
    index("idx_comparable_links_subject_purpose").on(
      table.subjectAuctionId,
      table.purpose,
    ),
  ],
);

export const forecasts = sqliteTable(
  "forecasts",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    asOf: text("as_of").notNull(),
    horizonSeconds: integer("horizon_seconds").notNull(),
    currentBidAtForecastCents: integer("current_bid_at_forecast_cents").notNull(),
    status: text("status").notNull(),
    modelVersion: text("model_version").notNull(),
    method: text("method").notNull(),
    lowCents: integer("low_cents"),
    expectedCents: integer("expected_cents"),
    highCents: integer("high_cents"),
    confidenceBps: integer("confidence_bps").notNull().default(0),
    sampleSize: integer("sample_size").notNull().default(0),
    exactModelCount: integer("exact_model_count").notNull().default(0),
    curveCount: integer("curve_count").notNull().default(0),
    evidenceIdsJson: text("evidence_ids_json").notNull().default("[]"),
    evidenceHash: text("evidence_hash"),
    provenance: text("provenance").notNull(),
    reasonCodesJson: text("reason_codes_json").notNull().default("[]"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_forecasts_auction_as_of_model").on(
      table.auctionId,
      table.asOf,
      table.modelVersion,
    ),
    index("idx_forecasts_auction_as_of").on(table.auctionId, table.asOf),
  ],
);

export const dealAssessments = sqliteTable(
  "deal_assessments",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    valuationId: text("valuation_id").references(() => valuations.id, {
      onDelete: "set null",
    }),
    forecastId: text("forecast_id").references(() => forecasts.id, {
      onDelete: "set null",
    }),
    calculatedAt: text("calculated_at").notNull(),
    modelVersion: text("model_version").notNull(),
    status: text("status").notNull(),
    tier: integer("tier").notNull(),
    score: integer("score").notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    conservativeValueCents: integer("conservative_value_cents"),
    expectedCloseCents: integer("expected_close_cents"),
    safeMaxBidCents: integer("safe_max_bid_cents"),
    breakEvenBidCents: integer("break_even_bid_cents"),
    projectedProfitCents: integer("projected_profit_cents"),
    downsideProfitCents: integer("downside_profit_cents"),
    roiBps: integer("roi_bps"),
    discountToValueBps: integer("discount_to_value_bps"),
    probabilityProfitableBps: integer("probability_profitable_bps"),
    probabilityWinUnderCeilingBps: integer("probability_win_under_ceiling_bps"),
    purchaseBidCents: integer("purchase_bid_cents").notNull(),
    buyerPremiumCents: integer("buyer_premium_cents").notNull(),
    purchaseTaxCents: integer("purchase_tax_cents").notNull(),
    transportCents: integer("transport_cents").notNull(),
    titleRegistrationCents: integer("title_registration_cents").notNull(),
    inspectionCents: integer("inspection_cents").notNull(),
    repairsCents: integer("repairs_cents").notNull(),
    storageCents: integer("storage_cents").notNull(),
    sellingFeesCents: integer("selling_fees_cents").notNull(),
    riskReserveCents: integer("risk_reserve_cents").notNull(),
    totalAcquisitionCents: integer("total_acquisition_cents").notNull(),
    totalExitCostsCents: integer("total_exit_costs_cents").notNull(),
    totalAllInCents: integer("total_all_in_cents").notNull(),
    warningsJson: text("warnings_json").notNull().default("[]"),
    reasonCodesJson: text("reason_codes_json").notNull().default("[]"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_deal_assessments_auction_calculated").on(
      table.auctionId,
      table.calculatedAt,
    ),
    index("idx_deal_assessments_status_score").on(table.status, table.score),
  ],
);

export const refreshJobs = sqliteTable(
  "refresh_jobs",
  {
    id: text("id").primaryKey(),
    auctionId: text("auction_id").references(() => auctions.id, {
      onDelete: "cascade",
    }),
    sourceKey: text("source_key").notNull().default("gsa-auctions"),
    jobType: text("job_type").notNull(),
    cadenceBucket: text("cadence_bucket").notNull(),
    status: text("status").notNull().default("pending"),
    dueAt: text("due_at").notNull(),
    lockedUntil: text("locked_until"),
    leaseOwner: text("lease_owner"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lastAttemptAt: text("last_attempt_at"),
    completedAt: text("completed_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_refresh_jobs_status_due").on(table.status, table.dueAt),
    index("idx_refresh_jobs_auction_type").on(table.auctionId, table.jobType),
    index("idx_refresh_jobs_lock").on(table.lockedUntil),
  ],
);

export const watchlistEntries = sqliteTable(
  "watchlist_entries",
  {
    id: text("id").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    personalMaxBidCents: integer("personal_max_bid_cents"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_watchlist_owner_auction").on(table.ownerKey, table.auctionId),
    index("idx_watchlist_owner_created").on(table.ownerKey, table.createdAt),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    auctionId: text("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    watchlistEntryId: text("watchlist_entry_id").references(
      () => watchlistEntries.id,
      { onDelete: "set null" },
    ),
    alertType: text("alert_type").notNull(),
    thresholdCents: integer("threshold_cents"),
    thresholdScore: integer("threshold_score"),
    leadSeconds: integer("lead_seconds"),
    channel: text("channel").notNull().default("in-app"),
    status: text("status").notNull().default("active"),
    lastTriggeredAt: text("last_triggered_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_alerts_owner_status").on(table.ownerKey, table.status),
    index("idx_alerts_auction_status").on(table.auctionId, table.status),
  ],
);

export type AuctionRow = typeof auctions.$inferSelect;
export type NewAuctionRow = typeof auctions.$inferInsert;
export type VehicleRow = typeof vehicles.$inferSelect;
export type BidObservationRow = typeof bidObservations.$inferSelect;
export type ValuationRow = typeof valuations.$inferSelect;
export type ComparableSaleRow = typeof comparableSales.$inferSelect;
export type ForecastRow = typeof forecasts.$inferSelect;
export type DealAssessmentRow = typeof dealAssessments.$inferSelect;
export type SourceCheckRow = typeof sourceChecks.$inferSelect;
export type RefreshJobRow = typeof refreshJobs.$inferSelect;
