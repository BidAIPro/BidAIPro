import {
  normalizePpmsVehicleAuction,
  ppmsImageAttachments,
  type PpmsImageAttachment,
} from "./gsa-ppms-normalizer.ts";
import type { GsaCoverage, GsaVehicleAuction } from "./gsa-normalizer.ts";

export const GSA_PPMS_CATALOG_ENDPOINT =
  "https://www.ppms.gov/gw/auction/ppms/api/v1/auctions";
export const GSA_PPMS_SALE_PREVIEW_ENDPOINT =
  "https://www.ppms.gov/gw/sales/ppms/api/v1/sales/preview/auctions";
export const GSA_PPMS_IMAGE_SIGNING_ENDPOINT =
  "https://www.ppms.gov/gw/common/ppms/api/v1/storage/presigned-urls";

// PPMS applies an Origin allowlist to edge-originated requests as well as
// browser requests. Sites edge subrequests receive 403 unless they use the
// target service's own origin.
function ppmsRequest(
  input: string | URL,
  init: RequestInit = {},
  jsonBody = false,
): Request {
  const request = new Request(input, init);
  request.headers.set("Accept", "application/json");
  request.headers.set("Origin", new URL(request.url).origin);
  if (jsonBody) request.headers.set("Content-Type", "application/json");
  return request;
}

const CATALOG_PAGE_SIZE = 200;
const MAX_CATALOG_PAGES = 25;
// Cloudflare Workers permit six simultaneous outbound connections per
// invocation; keeping the pool at that limit avoids queued detail requests.
const DETAIL_CONCURRENCY = 6;
// Six photos is enough for the board/detail experience without returning a
// multi-megabyte response full of expiring storage signatures.
const MAX_IMAGES_PER_VEHICLE = 6;
const IMAGE_SIGNING_BATCH_SIZE = 100;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface PpmsDetailCoverage {
  requested: number;
  succeeded: number;
  failed: number;
  imagesDiscovered: number;
  imagesSigned: number;
}

export interface PpmsDiscovery {
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  observedAt: string;
}

export class PpmsClientError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; upstreamStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PpmsClientError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).trim();
  return clean ? clean : null;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel();
    throw new PpmsClientError(
      `GSA_PPMS_${operation}_HTTP_ERROR`,
      `The official GSA Auctions ${operation.toLowerCase()} request returned an error.`,
      { upstreamStatus: response.status },
    );
  }

  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    void response.body?.cancel();
    throw new PpmsClientError(
      `GSA_PPMS_${operation}_TOO_LARGE`,
      `The official GSA Auctions ${operation.toLowerCase()} response was too large.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new PpmsClientError(
      `GSA_PPMS_${operation}_TOO_LARGE`,
      `The official GSA Auctions ${operation.toLowerCase()} response was too large.`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new PpmsClientError(
      `GSA_PPMS_${operation}_INVALID_JSON`,
      `The official GSA Auctions ${operation.toLowerCase()} response was not valid JSON.`,
      { cause: error },
    );
  }
}

function catalogBody(): string {
  return JSON.stringify({
    categoryCodeList: ["300"],
    unCheckedCategoryList: [],
    auctionSearchTypeAdvanced: "ALL_WORDS",
    advancedSearchText: "",
    zipCode: "",
    radius: "",
    auctionType: "",
    minPrice: "",
    maxPrice: "",
    saleNumber: "",
    bidDeposit: null,
    states: [],
    auctionEndDateFrom: "",
    auctionEndDateTo: "",
    auctionStatus: "active",
  });
}

async function fetchCatalogPage(
  fetchImpl: typeof fetch,
  page: number,
  signal: AbortSignal,
): Promise<{ rows: JsonRecord[]; totalElements: number; totalPages: number }> {
  const url = new URL(GSA_PPMS_CATALOG_ENDPOINT);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(CATALOG_PAGE_SIZE));
  url.searchParams.set("sort", "AUCTION_END_DATE_TIME_ASC,ASC");
  const response = await fetchImpl(
    ppmsRequest(
      url,
      {
        method: "POST",
        body: catalogBody(),
        signal,
      },
      true,
    ),
  );
  const payload = await jsonResponse(response, "CATALOG");
  if (!isRecord(payload) || !Array.isArray(payload.auctionDTOList)) {
    throw new PpmsClientError(
      "GSA_PPMS_CATALOG_SHAPE_CHANGED",
      "The official GSA Auctions catalog response shape was not recognized.",
    );
  }
  const rows = payload.auctionDTOList.filter(isRecord);
  const totalElements = safeInteger(payload.totalElements);
  const totalPages = safeInteger(payload.totalPages);
  if (totalElements === null || totalPages === null || totalPages > MAX_CATALOG_PAGES) {
    throw new PpmsClientError(
      "GSA_PPMS_CATALOG_PAGINATION_INVALID",
      "The official GSA Auctions catalog returned invalid pagination metadata.",
    );
  }
  return { rows, totalElements, totalPages };
}

async function fetchCompleteCatalog(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<JsonRecord[]> {
  const first = await fetchCatalogPage(fetchImpl, 1, signal);
  const rows = [...first.rows];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await fetchCatalogPage(fetchImpl, page, signal);
    if (next.totalElements !== first.totalElements || next.totalPages !== first.totalPages) {
      throw new PpmsClientError(
        "GSA_PPMS_CATALOG_CHANGED_DURING_PAGINATION",
        "The official GSA Auctions catalog changed while it was being paged; retrying avoids a partial snapshot.",
      );
    }
    rows.push(...next.rows);
  }

  const byAuction = new Map<string, JsonRecord>();
  for (const row of rows) {
    const auctionId = text(row.auctionId);
    const lotId = text(row.lotId);
    if (!auctionId || !lotId) continue;
    byAuction.set(auctionId, row);
  }
  if (byAuction.size !== first.totalElements) {
    throw new PpmsClientError(
      "GSA_PPMS_CATALOG_INCOMPLETE",
      "The official GSA Auctions catalog did not return every advertised active vehicle.",
    );
  }
  return [...byAuction.values()];
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
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

async function fetchDetail(
  fetchImpl: typeof fetch,
  row: JsonRecord,
  signal: AbortSignal,
): Promise<JsonRecord | null> {
  const lotId = text(row.lotId);
  if (!lotId) return null;
  try {
    const response = await fetchImpl(
      ppmsRequest(
        `${GSA_PPMS_SALE_PREVIEW_ENDPOINT}/${encodeURIComponent(lotId)}`,
        { signal },
      ),
    );
    const payload = await jsonResponse(response, "DETAIL");
    return isRecord(payload) ? payload : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

function trustedSignedImage(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!/(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function signImages(
  fetchImpl: typeof fetch,
  attachments: readonly PpmsImageAttachment[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  for (let offset = 0; offset < attachments.length; offset += IMAGE_SIGNING_BATCH_SIZE) {
    const batch = attachments.slice(offset, offset + IMAGE_SIGNING_BATCH_SIZE);
    let payload: unknown;
    try {
      const response = await fetchImpl(
        ppmsRequest(
          GSA_PPMS_IMAGE_SIGNING_ENDPOINT,
          {
            method: "POST",
            body: JSON.stringify(batch),
            signal,
          },
          true,
        ),
      );
      payload = await jsonResponse(response, "IMAGE_SIGNING");
    } catch (error) {
      if (signal.aborted) throw error;
      continue;
    }
    if (!Array.isArray(payload)) continue;
    for (const item of payload) {
      if (!isRecord(item)) continue;
      const id = text(item.id);
      const uri = text(item.uri);
      const url = trustedSignedImage(item.presignedUrl);
      if (id && uri && url) signed.set(`${id}|${uri}`, url);
    }
  }
  return signed;
}

function coverageFor(
  auctions: readonly GsaVehicleAuction[],
  detailCoverage: PpmsDetailCoverage,
): GsaCoverage {
  return {
    totalLots: auctions.length,
    vehicleLots: auctions.length,
    excludedLots: 0,
    withVin: auctions.filter((auction) => auction.vin !== null).length,
    withMileage: auctions.filter((auction) => auction.mileage !== null).length,
    withBodyType: auctions.filter((auction) => auction.bodyType !== null).length,
    withImage: auctions.filter((auction) => auction.imageUrl !== null).length,
    withCurrentBid: auctions.filter((auction) => auction.currentBid !== null).length,
    statusCounts: {
      active: auctions.filter((auction) => auction.status === "active").length,
      preview: auctions.filter((auction) => auction.status === "preview").length,
      scheduled: auctions.filter((auction) => auction.status === "scheduled").length,
      unknown: auctions.filter((auction) => auction.status === "unknown").length,
    },
    exclusionCounts: {},
    detailEnrichment: detailCoverage,
  };
}

/**
 * Reads the same first-party JSON catalog and detail services used by the
 * public GSA Auctions website. Requests are bounded and the category/status
 * filters are explicit, so this is not an HTML scraper or an unbounded crawl.
 */
export async function fetchPpmsVehicleAuctions(
  fetchImpl: typeof fetch,
  observedAt: Date,
  signal: AbortSignal,
): Promise<PpmsDiscovery> {
  const rows = await fetchCompleteCatalog(fetchImpl, signal);
  const details = await mapConcurrent(rows, DETAIL_CONCURRENCY, (row) =>
    fetchDetail(fetchImpl, row, signal),
  );
  if (rows.length > 0 && details.every((detail) => detail === null)) {
    throw new PpmsClientError(
      "GSA_PPMS_DETAILS_UNAVAILABLE",
      "The official GSA Auctions catalog was available, but none of its vehicle details could be read.",
    );
  }
  const attachmentsByAuction = details.map((detail) =>
    ppmsImageAttachments(detail).slice(0, MAX_IMAGES_PER_VEHICLE),
  );
  const attachments = attachmentsByAuction.flat();
  const signed = await signImages(fetchImpl, attachments, signal);
  const auctions = rows.map((row, index) => {
    const imageUrls = attachmentsByAuction[index]!
      .map((attachment) => signed.get(`${attachment.id}|${attachment.uri}`) ?? null)
      .filter((url): url is string => url !== null);
    return normalizePpmsVehicleAuction(row, details[index], imageUrls, observedAt);
  });
  const detailCoverage: PpmsDetailCoverage = {
    requested: rows.length,
    succeeded: details.filter((detail) => detail !== null).length,
    failed: details.filter((detail) => detail === null).length,
    imagesDiscovered: attachments.length,
    imagesSigned: signed.size,
  };
  return {
    auctions,
    coverage: coverageFor(auctions, detailCoverage),
    observedAt: observedAt.toISOString(),
  };
}
