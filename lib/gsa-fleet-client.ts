export const GSA_FLEET_SOURCE = "gsa-fleet" as const;
export const GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT =
  "https://api.shared-public.gsafleet.gov/graphql/shared-public-gateway";
export const GSA_FLEET_MARKETPLACE_ORIGIN = "https://marketplace.gsafleet.gov";
export const GSA_FLEET_BROWSE_URL =
  `${GSA_FLEET_MARKETPLACE_ORIGIN}/sales/browse-vehicles?saleEventStatus=Coming+soon%252CActive`;

export const GSA_FLEET_ACTIVE_CACHE_SECONDS = 60;
export const GSA_FLEET_CLOSED_CACHE_SECONDS = 60 * 60;
export const GSA_FLEET_DETAIL_CACHE_SECONDS = 15 * 60;
export const GSA_FLEET_DEFAULT_PAGE_SIZE = 1_000;
export const GSA_FLEET_MAX_ACTIVE_ROWS = 10_000;
export const GSA_FLEET_MAX_CLOSED_ROWS = 25_000;
export const GSA_FLEET_MAX_DETAIL_BATCH = 100;

export const GSA_FLEET_PUBLIC_LIMITATIONS = [
  "The shared-public GraphQL gateway is the public data source used by GSA Fleet Marketplace; the authenticated marketplace gateway is not used.",
  "Rows selected as coming soon or active are all reported upstream with saleStatus Active, so their phase is derived from sale timestamps.",
  "Internet sales expose public online-bid data; Live sales generally do not expose a current online bid.",
  "Public bid history contains anonymized bidder-high snapshots and a total bid count, not every raw bid increment.",
  "A high bid is kept separate from an awarded outcome; only winning-bid or sale-proceeds amounts on Sold or Awarded vehicles are treated as final results.",
] as const;

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_SIZE = 25_000;
const MAX_LISTING_PAGES = 30;
const MAX_DETAIL_CONCURRENCY = 6;
const MAX_LISTING_CACHE_ENTRIES = 32;
const MAX_DETAIL_CACHE_ENTRIES = 512;

type JsonRecord = Record<string, unknown>;

export type GsaFleetSaleChannel = "internet" | "live" | "unknown";
export type GsaFleetSalePhase = "coming" | "active" | "ended" | "closed" | "unknown";
export type GsaFleetOutcomeStatus =
  | "sold"
  | "awarded"
  | "lotted"
  | "removed"
  | "unknown";
export type GsaFleetFinalPriceBasis = "winning-bid" | "sale-proceeds" | "unavailable";
export type GsaFleetSnapshotKind = "active-and-coming" | "closed-results";
export type GsaFleetCacheStatus = "refresh" | "memory-hit";

export interface GsaFleetVehicleLocation {
  vendorName: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/**
 * A normalized source row. This deliberately remains upstream-facing data;
 * adapters decide whether and how it becomes a board opportunity or a comp.
 */
export interface GsaFleetVehicleRecord {
  source: typeof GSA_FLEET_SOURCE;
  sourceId: string;
  externalKey: string;
  sourceUrl: string;
  vin: string | null;
  saleNumber: string | null;
  saleRunNumber: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  mileage: number | null;
  vehicleType: string | null;
  fuelType: string | null;
  conditionCode: string | null;
  saleType: string | null;
  saleStatus: string | null;
  vehicleSaleStatus: string | null;
  channel: GsaFleetSaleChannel;
  phase: GsaFleetSalePhase;
  outcome: GsaFleetOutcomeStatus;
  startsAt: string | null;
  endsAt: string | null;
  extendedEndsAt: string | null;
  effectiveEndsAt: string | null;
  highBidCents: number | null;
  floorPriceCents: number | null;
  winningBidCents: number | null;
  saleProceedsCents: number | null;
  finalPriceCents: number | null;
  finalPriceBasis: GsaFleetFinalPriceBasis;
  isComparableOutcome: boolean;
  location: GsaFleetVehicleLocation;
  vendorTimezone: string | null;
  images: readonly string[];
  observedAt: string;
}

export interface GsaFleetListingSnapshot {
  source: typeof GSA_FLEET_SOURCE;
  kind: GsaFleetSnapshotKind;
  endpoint: typeof GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT;
  sourceUrl: typeof GSA_FLEET_BROWSE_URL;
  observedAt: string;
  advertisedCount: number;
  complete: true;
  cache: GsaFleetCacheStatus;
  rows: readonly GsaFleetVehicleRecord[];
  limitations: readonly string[];
}

export interface GsaFleetVehicleDetail {
  source: typeof GSA_FLEET_SOURCE;
  sourceId: string;
  sourceUrl: string;
  vin: string;
  saleNumber: string | null;
  saleRunNumber: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  series: string | null;
  bodyStyle: string | null;
  vehicleType: string | null;
  mileage: number | null;
  conditionCode: string | null;
  color: string | null;
  engineType: string | null;
  engineSize: string | null;
  transmission: string | null;
  drivetrain: string | null;
  fuelType: string | null;
  interior: string | null;
  interiorColor: string | null;
  seatCount: number | null;
  openRecallCount: number | null;
  comments: string | null;
  equipment: readonly string[];
  location: GsaFleetVehicleLocation;
  saleType: string | null;
  saleStatus: string | null;
  vehicleSaleStatus: string | null;
  startsAt: string | null;
  endsAt: string | null;
  extendedEndsAt: string | null;
  effectiveEndsAt: string | null;
  highBidCents: number | null;
  floorPriceCents: number | null;
  askingPriceCents: number | null;
  winningBidCents: number | null;
  saleProceedsCents: number | null;
  bidIncrementCents: number | null;
  images: readonly string[];
  conditionReportUrl: string | null;
  conditionReportApproved: boolean;
  observedAt: string;
}

export interface GsaFleetDetailEnrichment {
  listing: GsaFleetVehicleRecord;
  detail: GsaFleetVehicleDetail | null;
  errorCode: string | null;
}

export interface GsaFleetDetailBatchResult {
  source: typeof GSA_FLEET_SOURCE;
  observedAt: string;
  requested: number;
  succeeded: number;
  failed: number;
  vehicles: readonly GsaFleetDetailEnrichment[];
}

export interface GsaFleetPublicBidSnapshot {
  bidderLabel: string | null;
  bidAt: string;
  amountCents: number;
  isHighBid: boolean;
}

export interface GsaFleetPublicBidHistory {
  kind: "anonymized-bidder-high-snapshots";
  isCompleteIncrementHistory: false;
  totalBids: number;
  activeItemsCount: number;
  extendedEndsAt: string | null;
  highestBidCents: number | null;
  bids: readonly GsaFleetPublicBidSnapshot[];
}

export interface GsaFleetVehicleActivity {
  source: typeof GSA_FLEET_SOURCE;
  observedAt: string;
  detail: GsaFleetVehicleDetail;
  bidHistory: GsaFleetPublicBidHistory;
  currentBidCents: number | null;
  effectiveEndsAt: string | null;
}

export interface GsaFleetClientOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
  timeoutMs?: number;
  forceRefresh?: boolean;
  /** Disable module retention for memory-bounded one-shot Worker rebuilds. */
  cacheResult?: boolean;
}

export interface GsaFleetListingOptions extends GsaFleetClientOptions {
  pageSize?: number;
  maxRows?: number;
}

export interface GsaFleetClosedResultsOptions extends GsaFleetListingOptions {
  /** Inclusive lower bound applied to the upstream saleEndDate filter. */
  since?: Date | string;
  /** Exclusive upper bound used to fetch a bounded historical backfill window. */
  through?: Date | string;
}

export interface GsaFleetDetailBatchOptions extends GsaFleetClientOptions {
  concurrency?: number;
  maxVehicles?: number;
}

export class GsaFleetClientError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; upstreamStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GsaFleetClientError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

const LISTING_QUERY = `
  query GsaFleetVehicleListings(
    $limit: Float
    $offset: Float
    $filters: [Filter!]
  ) {
    getVehicleListingDetails(
      limit: $limit
      offset: $offset
      filters: $filters
      search: 0
    ) {
      count
      hasMore
      rows {
        id
        makeName
        modelName
        modelYear
        vin
        vehicleMiles
        vehicleType
        vehicleCondition
        vendorName
        vendorCity
        vendorState
        saleType
        saleStatus
        vehicleSaleStatus
        saleStartDate
        saleEndDate
        extendedSaleEndDate
        saleNumber
        saleRunNumber
        photoUrl
        photoUrlLarge
        fuelType
        vendorTimezone
        highBid
        floorPrice
        winningBidAmt
        saleProceedsAmt
      }
    }
  }
`;

// The historical corpus needs only identity, odometer, class, outcome, and
// close-time fields. Requesting it in one bounded page avoids 9–18 sequential
// round trips and keeps the cold-path response below the JSON byte limit.
const CLOSED_LISTING_QUERY = `
  query GsaFleetClosedVehicleListings(
    $limit: Float
    $offset: Float
    $filters: [Filter!]
  ) {
    getVehicleListingDetails(
      limit: $limit
      offset: $offset
      filters: $filters
      search: 0
    ) {
      count
      hasMore
      rows {
        id
        makeName
        modelName
        modelYear
        vin
        vehicleMiles
        vehicleType
        vehicleCondition
        saleStatus
        vehicleSaleStatus
        saleEndDate
        extendedSaleEndDate
        saleNumber
        saleRunNumber
        winningBidAmt
        saleProceedsAmt
      }
    }
  }
`;

const DETAIL_FIELDS = `
  id
  modelYear
  makeName
  modelName
  vehicleType
  vehicleBodyStyle
  vehicleSeries
  makeColorName
  vehicleMiles
  vehicleEngineType
  fuelType
  vin
  vehicleEngineSize
  vehicleTransmission
  vehicleNumberOfSeats
  vehicleDriveType
  vehicleInterior
  openRecall
  vehicleInteriorColor
  vehicleAdditionalEquip1
  vehicleAdditionalEquip2
  vehicleCondition
  comments
  vendorName
  vendorCity
  vendorState
  vendorPostalCode
  saleType
  saleStatus
  vehicleSaleStatus
  highBid
  saleStartDate
  saleEndDate
  extendedSaleEndDate
  saleNumber
  saleRunNumber
  eimsConditionReportLink
  eimsCrApproved
  photoUrl
  photoUrlLarge
  bidIncrement
  floorPrice
  askingPrice
  saleProceedsAmt
  winningBidAmt
  eimsVehiclePhotos {
    photoUrl
    photoDescription
  }
`;

const DETAIL_QUERY = `
  query GsaFleetVehicleDetail($vin: String) {
    getVehicleDetailsByVin(vin: $vin) {
      ${DETAIL_FIELDS}
    }
  }
`;

const VEHICLE_ACTIVITY_QUERY = `
  query GsaFleetVehicleActivity(
    $vin: String
    $vehicleBidHistoryInput: VehicleBidHistoryInput!
  ) {
    getVehicleDetailsByVin(vin: $vin) {
      ${DETAIL_FIELDS}
    }
    vehicleBidHistory(vehicleBidHistoryInput: $vehicleBidHistoryInput) {
      activeItemsCount
      extendedSaleEndDate
      totalBids
      bids {
        bidderUserId
        bidDate
        bidAmt
        isHighBid
      }
      highestBidder {
        bidAmt
      }
    }
  }
`;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const listingCaches = new WeakMap<object, Map<string, CacheEntry<GsaFleetListingSnapshot>>>();
const detailCaches = new WeakMap<object, Map<string, CacheEntry<GsaFleetVehicleDetail>>>();

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maximumLength = 4_096): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value).trim();
  if (!cleaned || cleaned.length > maximumLength) return null;
  return cleaned;
}

function requiredText(value: unknown, field: string, maximumLength = 256): string {
  const cleaned = cleanText(value, maximumLength);
  if (!cleaned) {
    throw new GsaFleetClientError(
      "GSA_FLEET_PAYLOAD_SHAPE_CHANGED",
      `The public GSA Fleet response did not include a valid ${field}.`,
    );
  }
  return cleaned;
}

function validDate(value: Date | undefined): Date {
  const date = value ?? new Date();
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a valid date.");
  return date;
}

function isoDate(value: unknown): string | null {
  const text = cleanText(value, 128);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function latestDate(...values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = typeof value === "number" ? value : Number(cleanText(value, 64));
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return null;
  return parsed;
}

function vehicleYear(value: unknown, now: Date): number | null {
  const year = safeInteger(value, now.getUTCFullYear() + 2);
  return year !== null && year >= 1886 ? year : null;
}

function moneyCents(value: unknown): number | null {
  const text = cleanText(value, 64);
  if (!text) return null;
  const parsed = Number(text.replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000_000) return null;
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return resolved;
}

function saleChannel(value: string | null): GsaFleetSaleChannel {
  const normalized = value?.toLowerCase();
  if (normalized === "internet") return "internet";
  if (normalized === "live") return "live";
  return "unknown";
}

function outcomeStatus(value: string | null): GsaFleetOutcomeStatus {
  switch (value?.trim().toLowerCase()) {
    case "sold":
      return "sold";
    case "awarded":
      return "awarded";
    case "lotted":
      return "lotted";
    case "removed":
    case "withdrawn":
      return "removed";
    default:
      return "unknown";
  }
}

function salePhase(
  saleStatus: string | null,
  outcome: GsaFleetOutcomeStatus,
  startsAt: string | null,
  effectiveEndsAt: string | null,
  now: Date,
): GsaFleetSalePhase {
  const status = saleStatus?.trim().toLowerCase();
  if (
    status === "closed" ||
    status === "sale complete" ||
    outcome === "sold" ||
    outcome === "awarded" ||
    outcome === "removed"
  ) {
    return "closed";
  }
  if (startsAt && Date.parse(startsAt) > now.getTime()) return "coming";
  if (effectiveEndsAt && Date.parse(effectiveEndsAt) < now.getTime()) return "ended";
  if (
    startsAt &&
    effectiveEndsAt &&
    Date.parse(startsAt) <= now.getTime() &&
    Date.parse(effectiveEndsAt) >= now.getTime()
  ) {
    return "active";
  }
  return "unknown";
}

function finalPrice(
  outcome: GsaFleetOutcomeStatus,
  winningBidCents: number | null,
  saleProceedsCents: number | null,
): { cents: number | null; basis: GsaFleetFinalPriceBasis } {
  if (outcome !== "sold" && outcome !== "awarded") {
    return { cents: null, basis: "unavailable" };
  }
  if (winningBidCents !== null && winningBidCents > 0) {
    return { cents: winningBidCents, basis: "winning-bid" };
  }
  if (saleProceedsCents !== null && saleProceedsCents > 0) {
    return { cents: saleProceedsCents, basis: "sale-proceeds" };
  }
  return { cents: null, basis: "unavailable" };
}

export function normalizeGsaFleetImageUrl(value: unknown): string | null {
  const raw = cleanText(value, 2_048);
  if (!raw || raw === "[no photo]") return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function uniqueImages(values: readonly unknown[]): string[] {
  const images = new Set<string>();
  for (const value of values) {
    const image = normalizeGsaFleetImageUrl(value);
    if (image) images.add(image);
  }
  return [...images];
}

function safeIdentifier(value: string, field: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  // Fleet records occasionally use a manufacturer serial with an embedded
  // space in place of a conventional 17-character VIN.
  if (!/^[A-Za-z0-9_ -]{3,64}$/.test(cleaned)) {
    throw new TypeError(
      `${field} must contain 3 to 64 letters, numbers, spaces, underscores, or hyphens.`,
    );
  }
  return cleaned.toUpperCase();
}

export function gsaFleetVehicleDetailUrl(vin: string): string {
  return `${GSA_FLEET_MARKETPLACE_ORIGIN}/sales/vehicle-details/${encodeURIComponent(
    safeIdentifier(vin, "vin"),
  )}`;
}

function normalizeListingRow(value: unknown, now: Date, observedAt: string): GsaFleetVehicleRecord {
  if (!isRecord(value)) {
    throw new GsaFleetClientError(
      "GSA_FLEET_PAYLOAD_SHAPE_CHANGED",
      "The public GSA Fleet listing contained an invalid row.",
    );
  }
  const sourceId = requiredText(value.id, "vehicle ID", 128);
  const vin = cleanText(value.vin, 64)?.toUpperCase() ?? null;
  const saleNumber = cleanText(value.saleNumber, 128);
  const saleStatus = cleanText(value.saleStatus, 128);
  const vehicleSaleStatus = cleanText(value.vehicleSaleStatus, 128);
  const saleType = cleanText(value.saleType, 128);
  const startsAt = isoDate(value.saleStartDate);
  const endsAt = isoDate(value.saleEndDate);
  const extendedEndsAt = isoDate(value.extendedSaleEndDate);
  const effectiveEndsAt = latestDate(endsAt, extendedEndsAt);
  const outcome = outcomeStatus(vehicleSaleStatus);
  const winningBidCents = moneyCents(value.winningBidAmt);
  const saleProceedsCents = moneyCents(value.saleProceedsAmt);
  const price = finalPrice(outcome, winningBidCents, saleProceedsCents);
  const make = cleanText(value.makeName, 256);
  const model = cleanText(value.modelName, 256);
  const year = vehicleYear(value.modelYear, now);

  return {
    source: GSA_FLEET_SOURCE,
    sourceId,
    externalKey: `${GSA_FLEET_SOURCE}:${sourceId}`,
    sourceUrl: vin ? gsaFleetVehicleDetailUrl(vin) : GSA_FLEET_BROWSE_URL,
    vin,
    saleNumber,
    saleRunNumber: cleanText(value.saleRunNumber, 128),
    year,
    make,
    model,
    mileage: safeInteger(value.vehicleMiles, 10_000_000),
    vehicleType: cleanText(value.vehicleType, 256),
    fuelType: cleanText(value.fuelType, 256),
    conditionCode: cleanText(value.vehicleCondition, 128),
    saleType,
    saleStatus,
    vehicleSaleStatus,
    channel: saleChannel(saleType),
    phase: salePhase(saleStatus, outcome, startsAt, effectiveEndsAt, now),
    outcome,
    startsAt,
    endsAt,
    extendedEndsAt,
    effectiveEndsAt,
    highBidCents: moneyCents(value.highBid),
    floorPriceCents: moneyCents(value.floorPrice),
    winningBidCents,
    saleProceedsCents,
    finalPriceCents: price.cents,
    finalPriceBasis: price.basis,
    isComparableOutcome:
      price.cents !== null && year !== null && make !== null && model !== null,
    location: {
      vendorName: cleanText(value.vendorName, 512),
      city: cleanText(value.vendorCity, 256),
      state: cleanText(value.vendorState, 128),
      postalCode: null,
    },
    vendorTimezone: cleanText(value.vendorTimezone, 128),
    images: uniqueImages([value.photoUrlLarge, value.photoUrl]),
    observedAt,
  };
}

function reclassifyListingRow(row: GsaFleetVehicleRecord, now: Date): GsaFleetVehicleRecord {
  return {
    ...row,
    phase: salePhase(row.saleStatus, row.outcome, row.startsAt, row.effectiveEndsAt, now),
  };
}

function equipmentItems(...values: unknown[]): string[] {
  const items = new Set<string>();
  for (const value of values) {
    const text = cleanText(value, 32_768);
    if (!text) continue;
    for (const item of text.split(";")) {
      const cleaned = item.trim();
      if (cleaned && cleaned.length <= 512) items.add(cleaned);
    }
  }
  return [...items];
}

function normalizeDetail(value: unknown, now: Date, observedAt: string): GsaFleetVehicleDetail {
  if (!isRecord(value)) {
    throw new GsaFleetClientError(
      "GSA_FLEET_DETAIL_SHAPE_CHANGED",
      "The public GSA Fleet vehicle detail response was not recognized.",
    );
  }
  const sourceId = requiredText(value.id, "vehicle ID", 128);
  const vin = requiredText(value.vin, "VIN", 64).toUpperCase();
  const gallery = Array.isArray(value.eimsVehiclePhotos)
    ? value.eimsVehiclePhotos.flatMap((photo) =>
        isRecord(photo) ? [photo.photoUrl] : [],
      )
    : [];
  const endsAt = isoDate(value.saleEndDate);
  const extendedEndsAt = isoDate(value.extendedSaleEndDate);
  const conditionReport = cleanText(value.eimsConditionReportLink, 2_048);

  return {
    source: GSA_FLEET_SOURCE,
    sourceId,
    sourceUrl: gsaFleetVehicleDetailUrl(vin),
    vin,
    saleNumber: cleanText(value.saleNumber, 128),
    saleRunNumber: cleanText(value.saleRunNumber, 128),
    year: vehicleYear(value.modelYear, now),
    make: cleanText(value.makeName, 256),
    model: cleanText(value.modelName, 256),
    series: cleanText(value.vehicleSeries, 512),
    bodyStyle: cleanText(value.vehicleBodyStyle, 512),
    vehicleType: cleanText(value.vehicleType, 512),
    mileage: safeInteger(value.vehicleMiles, 10_000_000),
    conditionCode: cleanText(value.vehicleCondition, 128),
    color: cleanText(value.makeColorName, 256),
    engineType: cleanText(value.vehicleEngineType, 512),
    engineSize: cleanText(value.vehicleEngineSize, 256),
    transmission: cleanText(value.vehicleTransmission, 512),
    drivetrain: cleanText(value.vehicleDriveType, 512),
    fuelType: cleanText(value.fuelType, 512),
    interior: cleanText(value.vehicleInterior, 1_024),
    interiorColor: cleanText(value.vehicleInteriorColor, 256),
    seatCount: safeInteger(value.vehicleNumberOfSeats, 100),
    openRecallCount: safeInteger(value.openRecall, 1_000),
    comments: cleanText(value.comments, 32_768),
    equipment: equipmentItems(value.vehicleAdditionalEquip1, value.vehicleAdditionalEquip2),
    location: {
      vendorName: cleanText(value.vendorName, 512),
      city: cleanText(value.vendorCity, 256),
      state: cleanText(value.vendorState, 128),
      postalCode: cleanText(value.vendorPostalCode, 64),
    },
    saleType: cleanText(value.saleType, 128),
    saleStatus: cleanText(value.saleStatus, 128),
    vehicleSaleStatus: cleanText(value.vehicleSaleStatus, 128),
    startsAt: isoDate(value.saleStartDate),
    endsAt,
    extendedEndsAt,
    effectiveEndsAt: latestDate(endsAt, extendedEndsAt),
    highBidCents: moneyCents(value.highBid),
    floorPriceCents: moneyCents(value.floorPrice),
    askingPriceCents: moneyCents(value.askingPrice),
    winningBidCents: moneyCents(value.winningBidAmt),
    saleProceedsCents: moneyCents(value.saleProceedsAmt),
    bidIncrementCents: moneyCents(value.bidIncrement),
    images: uniqueImages([value.photoUrlLarge, value.photoUrl, ...gallery]),
    conditionReportUrl: conditionReport
      ? new URL(conditionReport, GSA_FLEET_MARKETPLACE_ORIGIN).toString()
      : null,
    conditionReportApproved: value.eimsCrApproved === true,
    observedAt,
  };
}

function normalizeBidHistory(value: unknown): GsaFleetPublicBidHistory {
  if (!isRecord(value)) {
    throw new GsaFleetClientError(
      "GSA_FLEET_BID_HISTORY_SHAPE_CHANGED",
      "The public GSA Fleet bid-history response was not recognized.",
    );
  }
  if (!Array.isArray(value.bids)) {
    throw new GsaFleetClientError(
      "GSA_FLEET_BID_HISTORY_SHAPE_CHANGED",
      "The public GSA Fleet bid-history response did not include a bids array.",
    );
  }
  const bids: GsaFleetPublicBidSnapshot[] = [];
  const seen = new Set<string>();
  for (const candidate of value.bids) {
    if (!isRecord(candidate)) continue;
    const bidAt = isoDate(candidate.bidDate);
    const amountCents = moneyCents(candidate.bidAmt);
    if (!bidAt || amountCents === null) continue;
    const rawBidder = cleanText(candidate.bidderUserId, 128);
    const bidderLabel = rawBidder && /^BIDDER\s+\d+$/i.test(rawBidder) ? rawBidder : null;
    const key = `${bidderLabel ?? "anonymous"}|${bidAt}|${amountCents}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bids.push({
      bidderLabel,
      bidAt,
      amountCents,
      isHighBid: candidate.isHighBid === true,
    });
  }
  bids.sort((left, right) => Date.parse(left.bidAt) - Date.parse(right.bidAt));
  const highestBidder = isRecord(value.highestBidder) ? value.highestBidder : null;
  return {
    kind: "anonymized-bidder-high-snapshots",
    isCompleteIncrementHistory: false,
    totalBids: safeInteger(value.totalBids, 10_000_000) ?? 0,
    activeItemsCount: safeInteger(value.activeItemsCount, 10_000_000) ?? 0,
    extendedEndsAt: isoDate(value.extendedSaleEndDate),
    highestBidCents: moneyCents(highestBidder?.bidAmt),
    bids,
  };
}

function timeoutMilliseconds(value: number | undefined): number {
  return boundedInteger(
    value,
    REQUEST_TIMEOUT_MS,
    MIN_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    "timeoutMs",
  );
}

function requestAbortSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("GSA Fleet request timed out."));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
    timedOut: () => timeoutTriggered,
  };
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel();
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_HTTP_ERROR`,
      `The public GSA Fleet ${operation.toLowerCase()} request returned an error.`,
      { upstreamStatus: response.status },
    );
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    void response.body?.cancel();
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_TOO_LARGE`,
      `The public GSA Fleet ${operation.toLowerCase()} response exceeded the size limit.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_TOO_LARGE`,
      `The public GSA Fleet ${operation.toLowerCase()} response exceeded the size limit.`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_INVALID_JSON`,
      `The public GSA Fleet ${operation.toLowerCase()} response was not valid JSON.`,
      { cause: error },
    );
  }
}

async function graphqlRequest(
  fetchImpl: typeof fetch,
  operation: string,
  query: string,
  variables: JsonRecord,
  options: GsaFleetClientOptions,
): Promise<JsonRecord> {
  const abort = requestAbortSignal(options.signal, timeoutMilliseconds(options.timeoutMs));
  let payload: unknown;
  try {
    const response = await fetchImpl(GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: abort.signal,
    });
    payload = await readJson(response, operation);
  } catch (error) {
    if (error instanceof GsaFleetClientError) throw error;
    const code = options.signal?.aborted
      ? `GSA_FLEET_${operation}_ABORTED`
      : abort.timedOut()
        ? `GSA_FLEET_${operation}_TIMEOUT`
        : `GSA_FLEET_${operation}_NETWORK_ERROR`;
    throw new GsaFleetClientError(
      code,
      abort.timedOut()
        ? `The public GSA Fleet ${operation.toLowerCase()} request timed out.`
        : `The public GSA Fleet ${operation.toLowerCase()} request could not be completed.`,
      { cause: error },
    );
  } finally {
    abort.cleanup();
  }
  if (!isRecord(payload)) {
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_SHAPE_CHANGED`,
      `The public GSA Fleet ${operation.toLowerCase()} response was not recognized.`,
    );
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_GRAPHQL_ERROR`,
      `The public GSA Fleet ${operation.toLowerCase()} query returned an error.`,
    );
  }
  if (!isRecord(payload.data)) {
    throw new GsaFleetClientError(
      `GSA_FLEET_${operation}_SHAPE_CHANGED`,
      `The public GSA Fleet ${operation.toLowerCase()} response did not include data.`,
    );
  }
  return payload.data;
}

function cacheFor<T>(
  caches: WeakMap<object, Map<string, CacheEntry<T>>>,
  fetchImpl: typeof fetch,
): Map<string, CacheEntry<T>> {
  let cache = caches.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    caches.set(fetchImpl, cache);
  }
  return cache;
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  expiresAt: number,
  maximumEntries: number,
): void {
  cache.delete(key);
  cache.set(key, { expiresAt, value });
  while (cache.size > maximumEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function filterDate(value: Date | string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${name} must be a valid date.`);
  return parsed.toISOString().slice(0, 10);
}

function listingFilters(
  kind: GsaFleetSnapshotKind,
  since: string | null,
  through: string | null,
): JsonRecord[] {
  const statuses =
    kind === "active-and-coming" ? ["Coming soon", "Active"] : ["Closed", "Sale Complete"];
  const conditions: JsonRecord[] = [
    { operator: "$in", key: "saleStatus", value: statuses },
  ];
  if (since) conditions.push({ operator: "$gte", key: "saleEndDate", value: since });
  if (through) conditions.push({ operator: "$lt", key: "saleEndDate", value: through });
  return [{ operator: "$and", conditions }];
}

async function fetchListingSnapshot(
  kind: GsaFleetSnapshotKind,
  options: GsaFleetClosedResultsOptions,
): Promise<GsaFleetListingSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = validDate(options.now);
  const observedAt = now.toISOString();
  const defaultMaximum =
    kind === "active-and-coming" ? GSA_FLEET_MAX_ACTIVE_ROWS : GSA_FLEET_MAX_CLOSED_ROWS;
  const maxRows = boundedInteger(options.maxRows, defaultMaximum, 1, defaultMaximum, "maxRows");
  const pageSize = boundedInteger(
    options.pageSize,
    Math.min(GSA_FLEET_DEFAULT_PAGE_SIZE, maxRows),
    1,
    Math.min(MAX_PAGE_SIZE, maxRows),
    "pageSize",
  );
  const since = kind === "closed-results" ? filterDate(options.since, "since") : null;
  const through = kind === "closed-results" ? filterDate(options.through, "through") : null;
  if (since && through && since >= through) {
    throw new RangeError("since must be earlier than through.");
  }
  const cacheKey = `${kind}|${since ?? "all"}|${through ?? "open"}|${pageSize}|${maxRows}`;
  const cache = cacheFor(listingCaches, fetchImpl);
  const cached = cache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > now.getTime()) {
    return {
      ...cached.value,
      cache: "memory-hit",
      rows: cached.value.rows.map((row) => reclassifyListingRow(row, now)),
    };
  }

  const filters = listingFilters(kind, since, through);
  const byId = new Map<string, GsaFleetVehicleRecord>();
  let offset = 0;
  let advertisedCount = 0;
  let hasMore = true;
  let page = 0;

  while (hasMore) {
    page += 1;
    if (page > MAX_LISTING_PAGES) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_PAGE_LIMIT_EXCEEDED",
        "The public GSA Fleet listing exceeded the bounded page limit.",
      );
    }
    const data = await graphqlRequest(
      fetchImpl,
      "LISTING",
      kind === "closed-results" ? CLOSED_LISTING_QUERY : LISTING_QUERY,
      { limit: pageSize, offset, filters },
      options,
    );
    const listing = data.getVehicleListingDetails;
    if (!isRecord(listing) || !Array.isArray(listing.rows) || typeof listing.hasMore !== "boolean") {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_SHAPE_CHANGED",
        "The public GSA Fleet listing response was not recognized.",
      );
    }
    const count = safeInteger(listing.count, Number.MAX_SAFE_INTEGER);
    if (count === null) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_SHAPE_CHANGED",
        "The public GSA Fleet listing returned invalid pagination metadata.",
      );
    }
    if (count > maxRows) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_ROW_LIMIT_EXCEEDED",
        `The public GSA Fleet listing advertised ${count} rows, above the configured ${maxRows}-row limit.`,
      );
    }
    if (listing.rows.length > pageSize) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_PAGE_INVALID",
        "The public GSA Fleet listing returned more rows than requested.",
      );
    }
    advertisedCount = count;
    for (const row of listing.rows) {
      const normalized = normalizeListingRow(row, now, observedAt);
      byId.set(normalized.sourceId, normalized);
    }
    hasMore = listing.hasMore;
    if (hasMore && listing.rows.length === 0) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_PAGINATION_STALLED",
        "The public GSA Fleet listing stopped advancing before it was complete.",
      );
    }
    offset += listing.rows.length;
    if (offset > maxRows || byId.size > maxRows) {
      throw new GsaFleetClientError(
        "GSA_FLEET_LISTING_ROW_LIMIT_EXCEEDED",
        "The public GSA Fleet listing exceeded the configured row limit.",
      );
    }
  }

  const snapshot: GsaFleetListingSnapshot = {
    source: GSA_FLEET_SOURCE,
    kind,
    endpoint: GSA_FLEET_PUBLIC_GRAPHQL_ENDPOINT,
    sourceUrl: GSA_FLEET_BROWSE_URL,
    observedAt,
    advertisedCount,
    complete: true,
    cache: "refresh",
    rows: [...byId.values()],
    limitations: [...GSA_FLEET_PUBLIC_LIMITATIONS],
  };
  const cacheSeconds =
    kind === "active-and-coming"
      ? GSA_FLEET_ACTIVE_CACHE_SECONDS
      : GSA_FLEET_CLOSED_CACHE_SECONDS;
  if (options.cacheResult !== false) {
    cacheSet(
      cache,
      cacheKey,
      snapshot,
      now.getTime() + cacheSeconds * 1_000,
      MAX_LISTING_CACHE_ENTRIES,
    );
  }
  return snapshot;
}

export function fetchGsaFleetActiveListings(
  options: GsaFleetListingOptions = {},
): Promise<GsaFleetListingSnapshot> {
  return fetchListingSnapshot("active-and-coming", options);
}

export function fetchGsaFleetClosedResults(
  options: GsaFleetClosedResultsOptions = {},
): Promise<GsaFleetListingSnapshot> {
  return fetchListingSnapshot("closed-results", options);
}

async function fetchDetail(
  vin: string,
  options: GsaFleetClientOptions,
): Promise<GsaFleetVehicleDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = validDate(options.now);
  const normalizedVin = safeIdentifier(vin, "vin");
  const cache = cacheFor(detailCaches, fetchImpl);
  const cached = cache.get(normalizedVin);
  if (!options.forceRefresh && cached && cached.expiresAt > now.getTime()) return cached.value;

  const data = await graphqlRequest(
    fetchImpl,
    "DETAIL",
    DETAIL_QUERY,
    { vin: normalizedVin },
    options,
  );
  const detail = normalizeDetail(data.getVehicleDetailsByVin, now, now.toISOString());
  if (detail.vin !== normalizedVin) {
    throw new GsaFleetClientError(
      "GSA_FLEET_DETAIL_VIN_MISMATCH",
      "The public GSA Fleet detail response did not match the requested VIN.",
    );
  }
  cacheSet(
    cache,
    normalizedVin,
    detail,
    now.getTime() + GSA_FLEET_DETAIL_CACHE_SECONDS * 1_000,
    MAX_DETAIL_CACHE_ENTRIES,
  );
  return detail;
}

/** Reads one public Fleet vehicle dossier without requiring online-bid history. */
export function fetchGsaFleetVehicleDetail(
  vin: string,
  options: GsaFleetClientOptions = {},
): Promise<GsaFleetVehicleDetail> {
  return fetchDetail(vin, options);
}

function errorCode(error: unknown): string {
  return error instanceof GsaFleetClientError ? error.code : "GSA_FLEET_DETAIL_UNKNOWN_ERROR";
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return result;
}

export async function enrichGsaFleetVehicleDetails(
  listings: readonly GsaFleetVehicleRecord[],
  options: GsaFleetDetailBatchOptions = {},
): Promise<GsaFleetDetailBatchResult> {
  const now = validDate(options.now);
  const maximum = boundedInteger(
    options.maxVehicles,
    GSA_FLEET_MAX_DETAIL_BATCH,
    1,
    GSA_FLEET_MAX_DETAIL_BATCH,
    "maxVehicles",
  );
  if (listings.length > maximum) {
    throw new GsaFleetClientError(
      "GSA_FLEET_DETAIL_BATCH_LIMIT_EXCEEDED",
      `Detail enrichment is limited to ${maximum} vehicles per batch.`,
    );
  }
  const concurrency = boundedInteger(
    options.concurrency,
    4,
    1,
    MAX_DETAIL_CONCURRENCY,
    "concurrency",
  );
  const vehicles = await mapConcurrent(listings, concurrency, async (listing) => {
    if (listing.source !== GSA_FLEET_SOURCE) {
      return { listing, detail: null, errorCode: "GSA_FLEET_DETAIL_SOURCE_MISMATCH" };
    }
    if (!listing.vin) {
      return { listing, detail: null, errorCode: "GSA_FLEET_DETAIL_MISSING_VIN" };
    }
    try {
      const detail = await fetchDetail(listing.vin, { ...options, now });
      if (detail.sourceId !== listing.sourceId) {
        return { listing, detail: null, errorCode: "GSA_FLEET_DETAIL_ID_MISMATCH" };
      }
      if (
        listing.saleNumber &&
        detail.saleNumber &&
        detail.saleNumber !== listing.saleNumber
      ) {
        return { listing, detail: null, errorCode: "GSA_FLEET_DETAIL_SALE_MISMATCH" };
      }
      return { listing, detail, errorCode: null };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { listing, detail: null, errorCode: errorCode(error) };
    }
  });
  return {
    source: GSA_FLEET_SOURCE,
    observedAt: now.toISOString(),
    requested: vehicles.length,
    succeeded: vehicles.filter((vehicle) => vehicle.detail !== null).length,
    failed: vehicles.filter((vehicle) => vehicle.detail === null).length,
    vehicles,
  };
}

export async function fetchGsaFleetVehicleActivity(
  vin: string,
  saleNumber: string,
  options: GsaFleetClientOptions = {},
): Promise<GsaFleetVehicleActivity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = validDate(options.now);
  const normalizedVin = safeIdentifier(vin, "vin");
  const normalizedSaleNumber = safeIdentifier(saleNumber, "saleNumber");
  const data = await graphqlRequest(
    fetchImpl,
    "VEHICLE_ACTIVITY",
    VEHICLE_ACTIVITY_QUERY,
    {
      vin: normalizedVin,
      vehicleBidHistoryInput: {
        saleNumber: normalizedSaleNumber,
        vin: normalizedVin,
        limit: 100,
        offset: 1,
        orderBy: { column: "bidAmt", order: "DESC" },
      },
    },
    { ...options, forceRefresh: true, now },
  );
  const observedAt = now.toISOString();
  const detail = normalizeDetail(data.getVehicleDetailsByVin, now, observedAt);
  if (detail.vin !== normalizedVin) {
    throw new GsaFleetClientError(
      "GSA_FLEET_ACTIVITY_VIN_MISMATCH",
      "The public GSA Fleet vehicle activity did not match the requested VIN.",
    );
  }
  if (detail.saleNumber && detail.saleNumber.toUpperCase() !== normalizedSaleNumber) {
    throw new GsaFleetClientError(
      "GSA_FLEET_ACTIVITY_SALE_MISMATCH",
      "The public GSA Fleet vehicle activity did not match the requested sale.",
    );
  }
  const bidHistory = normalizeBidHistory(data.vehicleBidHistory);
  const bidMaximum = bidHistory.bids.reduce<number | null>(
    (maximum, bid) => (maximum === null || bid.amountCents > maximum ? bid.amountCents : maximum),
    null,
  );
  return {
    source: GSA_FLEET_SOURCE,
    observedAt,
    detail,
    bidHistory,
    currentBidCents:
      bidHistory.highestBidCents ?? bidMaximum ?? detail.highBidCents,
    effectiveEndsAt: latestDate(detail.effectiveEndsAt, bidHistory.extendedEndsAt),
  };
}

export function clearGsaFleetClientCache(fetchImpl?: typeof fetch): void {
  if (fetchImpl) {
    listingCaches.delete(fetchImpl);
    detailCaches.delete(fetchImpl);
    return;
  }
  const defaultFetch = fetch;
  listingCaches.delete(defaultFetch);
  detailCaches.delete(defaultFetch);
}
