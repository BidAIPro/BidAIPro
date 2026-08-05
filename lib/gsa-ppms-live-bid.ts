import { parsePpmsCentralDate } from "./gsa-ppms-normalizer.ts";
import type { AuctionStatus } from "./auction-types.ts";

export const GSA_PPMS_LIVE_AUCTION_ENDPOINT =
  "https://www.ppms.gov/gw/auction/ppms/api/v1/auctions/getAuction";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const AUCTION_ID_PATTERN = /^[1-9]\d{0,11}$/;

type JsonRecord = Record<string, unknown>;

export interface PpmsLiveBidSnapshot {
  externalId: string;
  currentBidCents: number | null;
  bidderCount: number | null;
  status: AuctionStatus;
  endsAt: string;
  lastCheckedAt: string;
}

export class PpmsLiveBidError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; upstreamStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PpmsLiveBidError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

export function isValidPpmsAuctionId(value: unknown): value is string {
  if (typeof value !== "string" || !AUCTION_ID_PATTERN.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sourceAuctionId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return isValidPpmsAuctionId(clean) ? clean : null;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function moneyToCents(value: unknown): number | null {
  if (value === null) return null;
  const dollars = nonNegativeNumber(value);
  if (dollars === null) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response contained an invalid current bid.",
    );
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response contained an invalid current bid.",
    );
  }
  return cents;
}

function bidderCount(value: unknown): number | null {
  if (value === null) return null;
  const count = nonNegativeNumber(value);
  if (count === null || !Number.isSafeInteger(count)) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response contained an invalid bidder count.",
    );
  }
  return count;
}

function liveStatus(value: unknown): AuctionStatus {
  if (typeof value !== "string" || !value.trim()) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response did not contain a valid status.",
    );
  }
  const status = value.trim().toLowerCase();
  if (status === "active" || status === "a") return "active";
  if (
    status === "preview" ||
    status === "p" ||
    status === "scheduled" ||
    status === "pending" ||
    status === "s"
  ) {
    return "preview";
  }
  if (status === "closing") return "closing";
  if (
    status === "closed" ||
    status === "ended" ||
    status === "complete" ||
    status === "completed"
  ) {
    return "ended";
  }
  if (status === "awarded" || status === "sold") return "sold";
  if (status === "unsold") return "unsold";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  throw new PpmsLiveBidError(
    "GSA_PPMS_LIVE_SHAPE_CHANGED",
    "The official GSA Auctions live response contained an unrecognized status.",
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_TOO_LARGE",
      "The official GSA Auctions live response was too large.",
    );
  }

  const contentType = response.headers.get("content-type");
  if (contentType && !/(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType)) {
    void response.body?.cancel();
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_INVALID_CONTENT_TYPE",
      "The official GSA Auctions live response was not JSON.",
    );
  }

  if (!response.body) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_INVALID_JSON",
      "The official GSA Auctions live response was empty.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PpmsLiveBidError(
        "GSA_PPMS_LIVE_TOO_LARGE",
        "The official GSA Auctions live response was too large.",
      );
    }
    chunks.push(value);
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
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_INVALID_JSON",
      "The official GSA Auctions live response was not valid JSON.",
      { cause: error },
    );
  }
}

function normalizeSnapshot(
  payload: unknown,
  requestedAuctionId: string,
  lastCheckedAt: string,
): PpmsLiveBidSnapshot {
  if (!isRecord(payload)) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response shape was not recognized.",
    );
  }

  const requiredFields = [
    "auctionId",
    "currentBid",
    "numberOfBidders",
    "status",
    "endDate",
  ];
  if (requiredFields.some((field) => !hasOwn(payload, field))) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response was missing required fields.",
    );
  }

  const returnedAuctionId = sourceAuctionId(payload.auctionId);
  if (!returnedAuctionId) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response contained an invalid auction id.",
    );
  }
  if (returnedAuctionId !== requestedAuctionId) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_ID_MISMATCH",
      "The official GSA Auctions live response did not match the requested auction.",
    );
  }

  const endsAt = parsePpmsCentralDate(payload.endDate);
  if (!endsAt) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_SHAPE_CHANGED",
      "The official GSA Auctions live response contained an invalid end date.",
    );
  }

  return {
    externalId: returnedAuctionId,
    currentBidCents: moneyToCents(payload.currentBid),
    bidderCount: bidderCount(payload.numberOfBidders),
    status: liveStatus(payload.status),
    endsAt,
    lastCheckedAt,
  };
}

export async function fetchPpmsLiveBid(
  auctionId: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: () => Date;
  } = {},
): Promise<PpmsLiveBidSnapshot> {
  if (!isValidPpmsAuctionId(auctionId)) {
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_INVALID_ID",
      "A positive numeric GSA auction id is required.",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > REQUEST_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${REQUEST_TIMEOUT_MS}`);
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const upstreamRequest = new Request(
      `${GSA_PPMS_LIVE_AUCTION_ENDPOINT}/${auctionId}`,
      {
        method: "GET",
        signal: controller.signal,
      },
    );
    upstreamRequest.headers.set("Accept", "application/json");
    // Rewriting a mutable Request and setting the target origin follows the
    // Cloudflare Workers CORS-proxy pattern and prevents PPMS's 403 response.
    upstreamRequest.headers.set("Origin", new URL(upstreamRequest.url).origin);
    const request = fetchImpl(upstreamRequest);
    const timedRequest = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new PpmsLiveBidError(
            "GSA_PPMS_LIVE_TIMEOUT",
            "The official GSA Auctions live request timed out.",
          ),
        );
      }, timeoutMs);
    });
    const response = await Promise.race([request, timedRequest]);

    if (!response.ok) {
      void response.body?.cancel();
      throw new PpmsLiveBidError(
        response.status === 404
          ? "GSA_PPMS_LIVE_NOT_FOUND"
          : "GSA_PPMS_LIVE_HTTP_ERROR",
        response.status === 404
          ? "The requested GSA auction was not found."
          : "The official GSA Auctions live request returned an error.",
        { upstreamStatus: response.status },
      );
    }

    const payload = await boundedJson(response);
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    return normalizeSnapshot(payload, auctionId, checkedAt);
  } catch (error) {
    if (error instanceof PpmsLiveBidError) throw error;
    if (controller.signal.aborted) {
      throw new PpmsLiveBidError(
        "GSA_PPMS_LIVE_TIMEOUT",
        "The official GSA Auctions live request timed out.",
        { cause: error },
      );
    }
    throw new PpmsLiveBidError(
      "GSA_PPMS_LIVE_NETWORK_ERROR",
      "The official GSA Auctions live request could not be completed.",
      { cause: error },
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
