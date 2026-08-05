import type {
  GsaVehicleCondition,
  GsaVehicleOperability,
} from "./gsa-normalizer.ts";
import { normalizePpmsVehicleAuction } from "./gsa-ppms-normalizer.ts";
import {
  GSA_PPMS_CATALOG_ENDPOINT,
  GSA_PPMS_SALE_PREVIEW_ENDPOINT,
} from "./gsa-ppms-client.ts";

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_DETAIL_CONCURRENCY = 6;
const MAX_LOOKBACK_DAYS = 366;
const MAX_PAGES = 50;
const MAX_JSON_BYTES = 5 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface GsaClosedComparable {
  id: string;
  auctionId: string;
  lotId: string;
  sourceUrl: string;
  title: string;
  closedHighBidCents: number;
  bidderCount: number | null;
  endedAt: string;
  year: number | null;
  make: string | null;
  modelLabel: string | null;
  mileage: number | null;
  bodyType: string | null;
  condition: GsaVehicleCondition;
  operability: GsaVehicleOperability;
  damageFlags: readonly string[];
  issueFlags: readonly string[];
  city: string | null;
  state: string | null;
  detailEnriched: boolean;
}

export interface GsaClosedCompCoverage {
  from: string;
  to: string;
  catalogRows: number;
  closedRows: number;
  usableClosedHighBids: number;
  excludedTerminated: number;
  excludedNoBid: number;
  detailRequested: number;
  detailSucceeded: number;
  detailFailed: number;
}

export interface GsaClosedCompDiscovery {
  comparables: GsaClosedComparable[];
  coverage: GsaClosedCompCoverage;
  observedAt: string;
}

export interface FetchClosedGsaVehicleCompOptions {
  now?: Date;
  from?: Date;
  to?: Date;
  lookbackDays?: number;
  pageSize?: number;
  detailConcurrency?: number;
  signal?: AbortSignal;
}

export class GsaClosedCompError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; upstreamStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GsaClosedCompError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const clean = String(value).trim();
  return clean ? clean : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(cleanText(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
  return value;
}

function dayEnvelope(value: Date, end = false): string {
  return `${value.toISOString().slice(0, 10)}T${end ? "23:59:59.999" : "00:00:00.000"}`;
}

function catalogBody(from: Date, to: Date): string {
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
    auctionEndDateFrom: dayEnvelope(from),
    auctionEndDateTo: dayEnvelope(to, true),
    auctionStatus: "closed",
  });
}

async function boundedJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel();
    throw new GsaClosedCompError(
      `GSA_CLOSED_${operation}_HTTP_ERROR`,
      `The official GSA closed-auction ${operation.toLowerCase()} request returned an error.`,
      { upstreamStatus: response.status },
    );
  }

  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    void response.body?.cancel();
    throw new GsaClosedCompError(
      `GSA_CLOSED_${operation}_TOO_LARGE`,
      `The official GSA closed-auction ${operation.toLowerCase()} response was too large.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new GsaClosedCompError(
      `GSA_CLOSED_${operation}_TOO_LARGE`,
      `The official GSA closed-auction ${operation.toLowerCase()} response was too large.`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GsaClosedCompError(
      `GSA_CLOSED_${operation}_INVALID_JSON`,
      `The official GSA closed-auction ${operation.toLowerCase()} response was not valid JSON.`,
      { cause: error },
    );
  }
}

async function fetchCatalogPage(
  fetchImpl: typeof fetch,
  body: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
) {
  const url = new URL(GSA_PPMS_CATALOG_ENDPOINT);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(pageSize));
  // Despite its legacy name, this is the sort used by GSA's public closed page
  // to return the most recently ended lots first.
  url.searchParams.set("sort", "AUCTION_END_DATE_TIME_ASC,ASC");
  const request = new Request(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
    signal,
  });
  request.headers.delete("Origin");
  const payload = await boundedJson(await fetchImpl(request), "CATALOG");
  if (!isRecord(payload) || !Array.isArray(payload.auctionDTOList)) {
    throw new GsaClosedCompError(
      "GSA_CLOSED_CATALOG_SHAPE_CHANGED",
      "The official GSA closed-auction catalog response shape was not recognized.",
    );
  }
  const totalElements = positiveInteger(payload.totalElements) ?? 0;
  const totalPages = positiveInteger(payload.totalPages) ?? 0;
  if (totalPages > MAX_PAGES || (totalElements > 0 && totalPages === 0)) {
    throw new GsaClosedCompError(
      "GSA_CLOSED_CATALOG_PAGINATION_INVALID",
      "The official GSA closed-auction catalog returned invalid pagination metadata.",
    );
  }
  return {
    rows: payload.auctionDTOList.filter(isRecord),
    totalElements,
    totalPages,
  };
}

async function fetchDetail(
  fetchImpl: typeof fetch,
  lotId: string,
  signal?: AbortSignal,
): Promise<JsonRecord | null> {
  try {
    const request = new Request(
      `${GSA_PPMS_SALE_PREVIEW_ENDPOINT}/${encodeURIComponent(lotId)}`,
      { headers: { Accept: "application/json" }, signal },
    );
    request.headers.delete("Origin");
    const payload = await boundedJson(await fetchImpl(request), "DETAIL");
    return isRecord(payload) ? payload : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return results;
}

/**
 * Reads GSA's first-party closed category-300 catalog and enriches each row
 * from the public lot-detail service. Only an exact Closed status with a
 * positive final displayed high bid becomes a comparable; Terminated and
 * no-bid rows are retained only in coverage counts.
 */
export async function fetchClosedGsaVehicleComps(
  fetchImpl: typeof fetch,
  options: FetchClosedGsaVehicleCompOptions = {},
): Promise<GsaClosedCompDiscovery> {
  const now = validDate(options.now ?? new Date(), "now");
  const to = validDate(options.to ?? now, "to");
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > MAX_LOOKBACK_DAYS) {
    throw new RangeError(`lookbackDays must be between 1 and ${MAX_LOOKBACK_DAYS}.`);
  }
  const from = validDate(
    options.from ?? new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1_000),
    "from",
  );
  if (from.getTime() > to.getTime()) throw new RangeError("from must not be after to.");
  if (to.getTime() - from.getTime() > MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000) {
    throw new RangeError(`The closed-comp range cannot exceed ${MAX_LOOKBACK_DAYS} days.`);
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new RangeError(`pageSize must be between 1 and ${DEFAULT_PAGE_SIZE}.`);
  }
  const detailConcurrency = options.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  if (!Number.isInteger(detailConcurrency) || detailConcurrency < 1 || detailConcurrency > 6) {
    throw new RangeError("detailConcurrency must be between 1 and 6.");
  }

  const body = catalogBody(from, to);
  const first = await fetchCatalogPage(fetchImpl, body, 1, pageSize, options.signal);
  const rows = [...first.rows];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const nextPage = await fetchCatalogPage(fetchImpl, body, page, pageSize, options.signal);
    if (
      nextPage.totalElements !== first.totalElements ||
      nextPage.totalPages !== first.totalPages
    ) {
      throw new GsaClosedCompError(
        "GSA_CLOSED_CATALOG_CHANGED_DURING_PAGINATION",
        "The official GSA closed-auction catalog changed while it was being paged.",
      );
    }
    rows.push(...nextPage.rows);
  }

  const byAuctionId = new Map<string, JsonRecord>();
  for (const row of rows) {
    const auctionId = cleanText(row.auctionId);
    const lotId = cleanText(row.lotId);
    if (auctionId && lotId) byAuctionId.set(auctionId, row);
  }
  const catalogRows = [...byAuctionId.values()];
  if (catalogRows.length !== first.totalElements) {
    throw new GsaClosedCompError(
      "GSA_CLOSED_CATALOG_INCOMPLETE",
      "The official GSA closed-auction catalog did not return every advertised row.",
    );
  }

  const details = await mapConcurrent(catalogRows, detailConcurrency, (row) =>
    fetchDetail(fetchImpl, cleanText(row.lotId)!, options.signal),
  );
  const comparables: GsaClosedComparable[] = [];
  let closedRows = 0;
  let excludedTerminated = 0;
  let excludedNoBid = 0;

  catalogRows.forEach((row, index) => {
    const status = cleanText(row.status)?.toLowerCase();
    if (status !== "closed") {
      excludedTerminated += 1;
      return;
    }
    closedRows += 1;
    const normalized = normalizePpmsVehicleAuction(row, details[index], [], now);
    if (normalized.currentBid === null || normalized.currentBid <= 0) {
      excludedNoBid += 1;
      return;
    }
    const auctionId = cleanText(row.auctionId)!;
    const lotId = cleanText(row.lotId)!;
    if (!normalized.endsAt) return;
    comparables.push({
      id: `gsa-closed:${auctionId}`,
      auctionId,
      lotId,
      sourceUrl: `https://gsaauctions.gov/auctions/preview/${auctionId}`,
      title: normalized.title,
      closedHighBidCents: Math.round(normalized.currentBid * 100),
      bidderCount: normalized.bidderCount,
      endedAt: normalized.endsAt,
      year: normalized.year,
      make: normalized.make,
      modelLabel: normalized.modelLabel,
      mileage: normalized.mileage,
      bodyType: normalized.bodyType,
      condition: normalized.condition,
      operability: normalized.operability,
      damageFlags: normalized.damageFlags,
      issueFlags: normalized.issueFlags,
      city: normalized.location.city,
      state: normalized.location.state,
      detailEnriched: details[index] !== null,
    });
  });

  return {
    comparables,
    coverage: {
      from: dayEnvelope(from),
      to: dayEnvelope(to, true),
      catalogRows: catalogRows.length,
      closedRows,
      usableClosedHighBids: comparables.length,
      excludedTerminated,
      excludedNoBid,
      detailRequested: catalogRows.length,
      detailSucceeded: details.filter((detail) => detail !== null).length,
      detailFailed: details.filter((detail) => detail === null).length,
    },
    observedAt: now.toISOString(),
  };
}
