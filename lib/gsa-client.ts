import {
  normalizeGsaPayload,
  type GsaCoverage,
  type GsaVehicleAuction,
} from "./gsa-normalizer.ts";
import {
  GSA_PPMS_CATALOG_ENDPOINT,
  PpmsClientError,
  fetchPpmsVehicleAuctions,
} from "./gsa-ppms-client.ts";

/** Legacy documented bulk feed, retained only as a fallback. */
export const GSA_AUCTIONS_ENDPOINT = "https://api.gsa.gov/assets/gsaauctions/v2/auctions";
export const GSA_DISCOVERY_ENDPOINT = GSA_PPMS_CATALOG_ENDPOINT;
// PPMS image signatures last one hour. Refresh with headroom so a cached page
// never receives an image URL that is already at its expiry boundary.
export const GSA_CACHE_SECONDS = 45 * 60;
export const GSA_STALE_MAX_AGE_SECONDS = 24 * 60 * 60;

const PPMS_REQUEST_TIMEOUT_MS = 45_000;
const LEGACY_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export const GSA_PUBLIC_FEED_LIMITATIONS = [
  "Discovery prefers the first-party public GSA Auctions category-300 JSON catalog and bounded lot-detail requests; the documented keyed Auctions API is the official fallback when configured.",
  "Bid amount and bidder count are point-in-time fields and can lag the interactive bidding screen.",
  "Mileage is seller-reported and not independently verified; conflicting structured and narrative readings are retained and flagged.",
  "PPMS images use short-lived GSA storage signatures; repository snapshots host-validate documented Auctions API ImageURL values before publication.",
  "VIN, mileage, body style, images, condition details, and reserve information are not guaranteed for every lot.",
  "The GSA catalog does not provide a dependable closed-sale comp history or Kelley Blue Book valuation.",
] as const;

export type GsaSourceStatus = "live" | "stale";
export type GsaCacheStatus = "refresh" | "memory-hit" | "stale-fallback";

export interface GsaSourceHealth {
  source: "GSA Auctions API";
  official: true;
  endpoint: string;
  sourceMode: "ppms-public-catalog" | "legacy-bulk-feed";
  status: GsaSourceStatus;
  cache: GsaCacheStatus;
  credentialMode: "public-catalog" | "configured" | "shared-demo";
  fetchedAt: string;
  observedAt: string;
  cachedUntil: string;
  staleSince: string | null;
  ageSeconds: number;
  lastErrorCode: string | null;
  discoveryCadence: "hourly";
  limitations: string[];
}

export interface GsaDiscoveryResult {
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  sourceHealth: GsaSourceHealth;
}

export class GsaClientError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; upstreamStatus?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GsaClientError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

interface Snapshot {
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  fetchedAt: string;
  observedAt: string;
  cachedUntil: string;
  credentialMode: "public-catalog" | "configured" | "shared-demo";
  endpoint: string;
  sourceMode: "ppms-public-catalog" | "legacy-bulk-feed";
}

interface ClientOptions {
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  now?: Date;
  apiKey?: string;
}

let lastKnownGood: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

function validNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("now must be a valid date.");
  return now;
}

function getCredential(explicitKey?: string): { apiKey: string; mode: "configured" | "shared-demo" } {
  const configuredKey = explicitKey?.trim() || process.env.GSA_API_KEY?.trim();
  return configuredKey
    ? { apiKey: configuredKey, mode: "configured" }
    : { apiKey: "DEMO_KEY", mode: "shared-demo" };
}

function secondsBetween(later: Date, earlierIso: string): number {
  return Math.max(0, Math.floor((later.getTime() - Date.parse(earlierIso)) / 1000));
}

function sourceHealth(
  snapshot: Snapshot,
  now: Date,
  status: GsaSourceStatus,
  cache: GsaCacheStatus,
  lastErrorCode: string | null = null,
): GsaSourceHealth {
  return {
    source: "GSA Auctions API",
    official: true,
    endpoint: snapshot.endpoint,
    sourceMode: snapshot.sourceMode,
    status,
    cache,
    credentialMode: snapshot.credentialMode,
    fetchedAt: snapshot.fetchedAt,
    observedAt: snapshot.observedAt,
    cachedUntil: snapshot.cachedUntil,
    staleSince: status === "stale" ? snapshot.cachedUntil : null,
    ageSeconds: secondsBetween(now, snapshot.fetchedAt),
    lastErrorCode,
    discoveryCadence: "hourly",
    limitations: [...GSA_PUBLIC_FEED_LIMITATIONS],
  };
}

function resultFromSnapshot(
  snapshot: Snapshot,
  now: Date,
  status: GsaSourceStatus,
  cache: GsaCacheStatus,
  lastErrorCode: string | null = null,
): GsaDiscoveryResult {
  return {
    auctions: snapshot.auctions,
    coverage: snapshot.coverage,
    sourceHealth: sourceHealth(snapshot, now, status, cache, lastErrorCode),
  };
}

function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - now.getTime()) / 1000));
}

function isTrustedDownloadUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.hostname === "api.gsa.gov") return true;
  return /\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(url.hostname);
}

async function fetchOfficialFeed(
  fetchImpl: typeof fetch,
  requestUrl: URL,
  signal: AbortSignal,
): Promise<Response> {
  const cacheOptions = { revalidate: GSA_CACHE_SECONDS };
  let currentUrl = requestUrl;

  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
      next: cacheOptions,
    } as RequestInit & { next?: { revalidate: number } });

    if (response.status < 300 || response.status >= 400) return response;
    if (redirectCount === 4) {
      throw new GsaClientError(
        "GSA_TOO_MANY_REDIRECTS",
        "The official GSA feed returned too many redirects.",
      );
    }

    const location = response.headers.get("location");
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(location ?? "", currentUrl);
    } catch (error) {
      throw new GsaClientError(
        "GSA_INVALID_REDIRECT",
        "The official GSA feed returned an invalid redirect.",
        { cause: error },
      );
    }

    if (!location || !isTrustedDownloadUrl(downloadUrl)) {
      throw new GsaClientError(
        "GSA_UNTRUSTED_REDIRECT",
        "The official GSA feed redirected to an untrusted download location.",
      );
    }

    void response.body?.cancel();
    currentUrl = downloadUrl;
  }

  throw new GsaClientError("GSA_TOO_MANY_REDIRECTS", "The official GSA feed returned too many redirects.");
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GsaClientError("GSA_RESPONSE_TOO_LARGE", "The official GSA feed exceeded the response limit.");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel();
        throw new GsaClientError(
          "GSA_RESPONSE_TOO_LARGE",
          "The official GSA feed exceeded the response limit.",
        );
      }
      chunks.push(value);
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    totalBytes = bytes.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      throw new GsaClientError(
        "GSA_RESPONSE_TOO_LARGE",
        "The official GSA feed exceeded the response limit.",
      );
    }
    chunks.push(bytes);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GsaClientError("GSA_INVALID_JSON", "The official GSA feed returned invalid JSON.", {
      cause: error,
    });
  }
}

async function refreshPpmsSnapshot(fetchImpl: typeof fetch, now: Date): Promise<Snapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PPMS_REQUEST_TIMEOUT_MS);
  try {
    const normalized = await fetchPpmsVehicleAuctions(fetchImpl, now, controller.signal);
    const fetchedAt = now.toISOString();
    return {
      auctions: normalized.auctions,
      coverage: normalized.coverage,
      fetchedAt,
      observedAt: normalized.observedAt,
      cachedUntil: new Date(now.getTime() + GSA_CACHE_SECONDS * 1000).toISOString(),
      credentialMode: "public-catalog",
      endpoint: GSA_PPMS_CATALOG_ENDPOINT,
      sourceMode: "ppms-public-catalog",
    };
  } catch (error) {
    if (error instanceof PpmsClientError) {
      throw new GsaClientError(error.code, error.message, {
        cause: error,
        upstreamStatus: error.upstreamStatus ?? undefined,
      });
    }
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    throw new GsaClientError(
      timedOut ? "GSA_PPMS_TIMEOUT" : "GSA_PPMS_NETWORK_ERROR",
      timedOut
        ? "The official GSA Auctions public catalog timed out."
        : "The official GSA Auctions public catalog could not be reached.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshLegacySnapshot(
  fetchImpl: typeof fetch,
  now: Date,
  apiKey?: string,
): Promise<Snapshot> {
  const credential = getCredential(apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LEGACY_REQUEST_TIMEOUT_MS);
  const requestUrl = new URL(GSA_AUCTIONS_ENDPOINT);
  // This legacy API's official documentation requires api_key as a query
  // parameter. It is never returned to clients and is stripped on redirects.
  requestUrl.searchParams.set("api_key", credential.apiKey);
  requestUrl.searchParams.set("format", "JSON");

  let response: Response;
  try {
    response = await fetchOfficialFeed(fetchImpl, requestUrl, controller.signal);
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof GsaClientError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new GsaClientError(
      timedOut ? "GSA_TIMEOUT" : "GSA_NETWORK_ERROR",
      timedOut ? "The official GSA feed timed out." : "The official GSA feed could not be reached.",
      { cause: error },
    );
  }

  if (!response.ok) {
    clearTimeout(timeout);
    throw new GsaClientError("GSA_UPSTREAM_HTTP_ERROR", "The official GSA feed returned an error.", {
      upstreamStatus: response.status,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), now),
    });
  }

  let payload: unknown;
  try {
    payload = await readJsonWithLimit(response);
  } catch (error) {
    if (error instanceof GsaClientError) throw error;
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    throw new GsaClientError(
      timedOut ? "GSA_TIMEOUT" : "GSA_NETWORK_ERROR",
      timedOut ? "The official GSA feed timed out." : "The official GSA feed could not be read.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
  let normalized;
  try {
    normalized = normalizeGsaPayload(payload, now);
  } catch (error) {
    throw new GsaClientError("GSA_PAYLOAD_SHAPE_CHANGED", "The official GSA feed shape was not recognized.", {
      cause: error,
    });
  }

  const fetchedAt = now.toISOString();
  return {
    auctions: normalized.auctions,
    coverage: normalized.coverage,
    fetchedAt,
    observedAt: normalized.observedAt,
    cachedUntil: new Date(now.getTime() + GSA_CACHE_SECONDS * 1000).toISOString(),
    credentialMode: credential.mode,
    endpoint: GSA_AUCTIONS_ENDPOINT,
    sourceMode: "legacy-bulk-feed",
  };
}

async function refreshSnapshot(fetchImpl: typeof fetch, now: Date, apiKey?: string): Promise<Snapshot> {
  let ppmsError: unknown;
  try {
    return await refreshPpmsSnapshot(fetchImpl, now);
  } catch (error) {
    ppmsError = error;
  }

  try {
    return await refreshLegacySnapshot(fetchImpl, now, apiKey);
  } catch (legacyError) {
    const primaryCode = ppmsError instanceof GsaClientError ? ppmsError.code : "GSA_PPMS_UNAVAILABLE";
    const fallbackCode = legacyError instanceof GsaClientError ? legacyError.code : "GSA_LEGACY_UNAVAILABLE";
    throw new GsaClientError(
      `${primaryCode}__${fallbackCode}`,
      "Both official GSA Auctions discovery sources are currently unavailable.",
      {
        cause: legacyError,
        upstreamStatus:
          legacyError instanceof GsaClientError
            ? legacyError.upstreamStatus ?? undefined
            : ppmsError instanceof GsaClientError
              ? ppmsError.upstreamStatus ?? undefined
              : undefined,
      },
    );
  }
}

function errorCode(error: unknown): string {
  return error instanceof GsaClientError ? error.code : "GSA_UNKNOWN_ERROR";
}

export async function getGsaVehicleAuctions(options: ClientOptions = {}): Promise<GsaDiscoveryResult> {
  const now = validNow(options.now);
  const forceRefresh = options.forceRefresh ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!forceRefresh && lastKnownGood && Date.parse(lastKnownGood.cachedUntil) > now.getTime()) {
    return resultFromSnapshot(lastKnownGood, now, "live", "memory-hit");
  }

  try {
    if (!inFlight) {
      inFlight = refreshSnapshot(fetchImpl, now, options.apiKey).finally(() => {
        inFlight = null;
      });
    }
    const snapshot = await inFlight;
    lastKnownGood = snapshot;
    return resultFromSnapshot(snapshot, now, "live", "refresh");
  } catch (error) {
    if (
      lastKnownGood &&
      secondsBetween(now, lastKnownGood.fetchedAt) <= GSA_STALE_MAX_AGE_SECONDS
    ) {
      return resultFromSnapshot(lastKnownGood, now, "stale", "stale-fallback", errorCode(error));
    }
    throw error;
  }
}
