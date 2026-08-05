import type { GsaSourceHealth } from "./gsa-client.ts";
import type { GsaCoverage, GsaVehicleAuction } from "./gsa-normalizer.ts";

export const GSA_RUNNER_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/BidAIPro/BidAIPro/gsa-auction-data/gsa-vehicles.json";

const SNAPSHOT_SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MIN_VEHICLE_COUNT = 10;
const MAX_IMAGES_PER_AUCTION = 6;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface GsaRunnerSnapshot {
  schemaVersion: 1;
  source: "gsa-ppms";
  revision: string;
  itemCount: number;
  generatedAt: string;
  expiresAt: string;
  imageExpiresAt: string;
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  sourceHealth: GsaSourceHealth;
}

export class GsaRunnerSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GsaRunnerSnapshotError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isText(value: unknown, maximumLength: number, allowEmpty = true): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function isNullableText(value: unknown, maximumLength: number): value is string | null {
  return value === null || isText(value, maximumLength);
}

function isStringArray(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isText(item, maximumLength, false))
  );
}

function isNullableFiniteNumber(value: unknown, maximum: number): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum);
}

function isNullableInteger(value: unknown, maximum: number): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum);
}

function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}

function isListingUrl(value: unknown): value is string {
  if (!isText(value, 2_048, false)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "gsaauctions.gov" || url.hostname === "www.gsaauctions.gov") &&
      url.pathname.startsWith("/auctions/")
    );
  } catch {
    return false;
  }
}

function isSignedGsaImageUrl(value: unknown): value is string {
  if (!isText(value, 4_096, false)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringArray(value.addressLines, 5, 300) &&
    isNullableText(value.city, 120) &&
    isNullableText(value.state, 80) &&
    isNullableText(value.postalCode, 24)
  );
}

function isAuction(value: unknown): value is GsaVehicleAuction {
  if (!isRecord(value)) return false;
  return (
    isText(value.id, 160, false) &&
    value.source === "gsa-auctions" &&
    isNullableText(value.saleNumber, 100) &&
    isNullableText(value.lotNumber, 100) &&
    isNullableText(value.lotSequence, 100) &&
    isText(value.title, 1_000, false) &&
    isText(value.description, 20_000) &&
    value.status === "active" &&
    isNullableIsoDate(value.startsAt) &&
    isNullableIsoDate(value.endsAt) &&
    isNullableFiniteNumber(value.currentBid, 1_000_000_000) &&
    isNullableInteger(value.bidderCount, 10_000_000) &&
    isNullableFiniteNumber(value.bidIncrement, 10_000_000) &&
    isNullableFiniteNumber(value.reserve, 1_000_000_000) &&
    isNullableInteger(value.inactivityMinutes, 100_000) &&
    isListingUrl(value.url) &&
    (value.imageUrl === null || isSignedGsaImageUrl(value.imageUrl)) &&
    Array.isArray(value.images) &&
    value.images.length <= MAX_IMAGES_PER_AUCTION &&
    value.images.every(isSignedGsaImageUrl) &&
    isNullableText(value.vin, 32) &&
    isNullableInteger(value.mileage, 2_000_000) &&
    ["reported-not-verified", "conflicting-readings", "not-reported"].includes(String(value.odometerStatus)) &&
    isNullableText(value.bodyType, 120) &&
    isNullableInteger(value.year, 3_000) &&
    isNullableText(value.make, 120) &&
    isNullableText(value.modelLabel, 500) &&
    isNullableText(value.transmission, 200) &&
    isNullableText(value.fuelType, 100) &&
    isNullableInteger(value.cylinders, 100) &&
    isNullableText(value.color, 100) &&
    (value.openRecall === null || typeof value.openRecall === "boolean") &&
    isNullableText(value.conditionCode, 100) &&
    ["new", "usable", "repairable", "salvage", "scrap", "unknown"].includes(String(value.condition)) &&
    ["runs-and-drives", "runs", "non-operational", "unknown"].includes(String(value.operability)) &&
    isStringArray(value.damageFlags, 40, 200) &&
    isStringArray(value.issueFlags, 40, 200) &&
    isStringArray(value.conditionNotes, 100, 2_000) &&
    (value.detailEnriched === undefined || typeof value.detailEnriched === "boolean") &&
    isLocation(value.location) &&
    isLocation(value.saleLocation) &&
    isRecord(value.agency) &&
    isNullableText(value.agency.code, 100) &&
    isNullableText(value.agency.name, 300) &&
    isNullableText(value.agency.bureauCode, 100) &&
    isNullableText(value.agency.bureauName, 300) &&
    isRecord(value.evidence)
    && typeof value.evidence.title === "boolean"
    && typeof value.evidence.vin === "boolean"
    && typeof value.evidence.mileage === "boolean"
    && typeof value.evidence.bodyType === "boolean"
    && isStringArray(value.evidence.matched, 20, 200)
  );
}

function isCoverage(value: unknown, auctionCount: number): value is GsaCoverage {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.vehicleLots) &&
    value.vehicleLots === auctionCount &&
    Number.isSafeInteger(value.totalLots) &&
    Number(value.totalLots) >= auctionCount &&
    Number.isSafeInteger(value.excludedLots) &&
    Number.isSafeInteger(value.withMileage) &&
    Number(value.withMileage) >= 0 &&
    Number(value.withMileage) <= auctionCount &&
    Number.isSafeInteger(value.withImage) &&
    Number(value.withImage) >= 0 &&
    Number(value.withImage) <= auctionCount &&
    Number.isSafeInteger(value.withVin) &&
    Number.isSafeInteger(value.withBodyType) &&
    Number.isSafeInteger(value.withCurrentBid) &&
    isRecord(value.statusCounts) &&
    isRecord(value.exclusionCounts)
  );
}

function isSourceHealth(value: unknown): value is GsaSourceHealth {
  return (
    isRecord(value) &&
    value.source === "GSA Auctions API" &&
    value.official === true &&
    value.sourceMode === "ppms-public-catalog" &&
    value.credentialMode === "public-catalog" &&
    isText(value.endpoint, 2_048, false) &&
    isIsoDate(value.fetchedAt) &&
    isIsoDate(value.observedAt) &&
    isIsoDate(value.cachedUntil) &&
    value.status === "live" &&
    ["refresh", "memory-hit"].includes(String(value.cache)) &&
    (value.staleSince === null || isIsoDate(value.staleSince)) &&
    Number.isSafeInteger(value.ageSeconds) &&
    Number(value.ageSeconds) >= 0 &&
    (value.lastErrorCode === null || isText(value.lastErrorCode, 500, false)) &&
    value.discoveryCadence === "hourly" &&
    Array.isArray(value.limitations) &&
    value.limitations.length <= 30 &&
    value.limitations.every((item) => isText(item, 1_000, false))
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function normalizeSnapshot(value: unknown, now: Date): Promise<GsaRunnerSnapshot> {
  if (!isRecord(value) || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_SCHEMA_INVALID",
      "The runner snapshot schema was not recognized.",
    );
  }
  if (
    value.source !== "gsa-ppms" ||
    typeof value.revision !== "string" ||
    !REVISION_PATTERN.test(value.revision) ||
    !Number.isSafeInteger(value.itemCount) ||
    !isIsoDate(value.generatedAt) ||
    !isIsoDate(value.expiresAt) ||
    !isIsoDate(value.imageExpiresAt)
  ) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_HEADER_INVALID",
      "The runner snapshot header was invalid.",
    );
  }
  const generatedAt = Date.parse(value.generatedAt);
  const expiresAt = Date.parse(value.expiresAt);
  const imageExpiresAt = Date.parse(value.imageExpiresAt);
  if (
    generatedAt > now.getTime() + MAX_FUTURE_SKEW_MS ||
    expiresAt <= now.getTime() ||
    expiresAt < generatedAt ||
    imageExpiresAt < generatedAt ||
    imageExpiresAt > expiresAt
  ) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_EXPIRED",
      "The runner snapshot is outside its freshness window.",
    );
  }
  if (
    !Array.isArray(value.auctions) ||
    value.auctions.length < MIN_VEHICLE_COUNT ||
    value.itemCount !== value.auctions.length
  ) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_COUNT_INVALID",
      "The runner snapshot vehicle count was invalid.",
    );
  }
  if (!value.auctions.every(isAuction)) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_AUCTION_INVALID",
      "The runner snapshot contained an invalid vehicle record.",
    );
  }
  const ids = new Set(value.auctions.map((auction) => auction.id));
  if (ids.size !== value.auctions.length) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_DUPLICATE",
      "The runner snapshot contained duplicate vehicle records.",
    );
  }
  if (!isCoverage(value.coverage, value.auctions.length) || !isSourceHealth(value.sourceHealth)) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_META_INVALID",
      "The runner snapshot metadata was invalid.",
    );
  }
  const expectedRevision = await sha256Hex(JSON.stringify({
    generatedAt: value.generatedAt,
    auctions: value.auctions,
  }));
  if (expectedRevision !== value.revision) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_REVISION_INVALID",
      "The runner snapshot integrity revision did not match its contents.",
    );
  }
  return value as unknown as GsaRunnerSnapshot;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel();
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_HTTP_ERROR",
      "The runner snapshot request returned an error.",
    );
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_TOO_LARGE",
      "The runner snapshot was too large.",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_TOO_LARGE",
      "The runner snapshot was too large.",
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GsaRunnerSnapshotError(
      "GSA_RUNNER_SNAPSHOT_JSON_INVALID",
      "The runner snapshot was not valid JSON.",
      { cause: error },
    );
  }
}

export async function fetchGsaRunnerSnapshot(options: {
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
} = {}): Promise<GsaRunnerSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const timeoutMs = Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Avoid pinning an older bounded runner artifact behind intermediary caches
  // after a newer validated snapshot has been published.
  const cacheBucket = Math.floor(now.getTime() / 60_000);
  try {
    const response = await fetchImpl(`${GSA_RUNNER_SNAPSHOT_URL}?v=${cacheBucket}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return await normalizeSnapshot(await readBoundedJson(response), now);
  } catch (error) {
    if (error instanceof GsaRunnerSnapshotError) throw error;
    throw new GsaRunnerSnapshotError(
      controller.signal.aborted
        ? "GSA_RUNNER_SNAPSHOT_TIMEOUT"
        : "GSA_RUNNER_SNAPSHOT_NETWORK_ERROR",
      controller.signal.aborted
        ? "The runner snapshot request timed out."
        : "The runner snapshot request could not be completed.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
