import type {
  GsaClosedComparable,
  GsaClosedCompCoverage,
  GsaClosedCompDiscovery,
} from "./gsa-closed-comps.ts";

const DAY_MS = 86_400_000;
const MAX_RETENTION_DAYS = 1_825;

export interface GsaClosedCompCorpusSnapshot {
  schemaVersion: 1;
  refreshedAt: string;
  retentionDays: number;
  refresh: GsaClosedCompCoverage;
  comparables: readonly GsaClosedComparable[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function containsSubjectBidKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSubjectBidKey);
  const object = record(value);
  if (!object) return false;
  return Object.entries(object).some(([key, nested]) =>
    /^(?:currentBid|currentBidCents|subjectBid|subjectBidCents)$/i.test(key) ||
    containsSubjectBidKey(nested)
  );
}

/** Rejects malformed, duplicated, nonterminal, or subject-bid-tainted corpora. */
export function validateGsaClosedCompCorpus(
  value: unknown,
): GsaClosedCompCorpusSnapshot {
  const corpus = record(value);
  if (corpus?.schemaVersion !== 1 || !Array.isArray(corpus.comparables)) {
    throw new TypeError("Unsupported GSA closed-comp corpus schema.");
  }
  if (!Number.isFinite(Date.parse(String(corpus.refreshedAt)))) {
    throw new TypeError("The GSA closed-comp corpus has an invalid refreshedAt value.");
  }
  if (
    !Number.isInteger(corpus.retentionDays) || Number(corpus.retentionDays) < 1 ||
    Number(corpus.retentionDays) > MAX_RETENTION_DAYS
  ) {
    throw new TypeError("The GSA closed-comp corpus has an invalid retention window.");
  }
  if (!record(corpus.refresh) || containsSubjectBidKey(corpus)) {
    throw new TypeError("The GSA closed-comp corpus metadata is invalid or contains a forbidden subject bid.");
  }

  const ids = new Set<string>();
  for (const value of corpus.comparables) {
    const comp = record(value);
    const sourceUrl = typeof comp?.sourceUrl === "string" ? comp.sourceUrl : "";
    const vin = comp?.vin;
    let officialSource = false;
    try {
      const parsed = new URL(sourceUrl);
      officialSource = parsed.protocol === "https:" && parsed.hostname === "gsaauctions.gov";
    } catch {
      officialSource = false;
    }
    if (
      !comp || typeof comp.auctionId !== "string" || !comp.auctionId ||
      ids.has(comp.auctionId) || !Number.isSafeInteger(comp.closedHighBidCents) ||
      Number(comp.closedHighBidCents) <= 0 ||
      !Number.isFinite(Date.parse(String(comp.endedAt))) || !officialSource ||
      (vin !== undefined && vin !== null && (
        typeof vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())
      ))
    ) {
      throw new TypeError("The GSA closed-comp corpus contains an invalid comparable.");
    }
    ids.add(comp.auctionId);
  }
  return corpus as unknown as GsaClosedCompCorpusSnapshot;
}

/**
 * Merges an overlapping official refresh into the retained corpus. Newer
 * observations win by auction id, so reruns are idempotent and GSA corrections
 * replace stale values without producing duplicate evidence.
 */
export function mergeGsaClosedCompCorpus(
  previous: GsaClosedCompCorpusSnapshot | null,
  discovery: GsaClosedCompDiscovery,
  options: { now?: Date; coveredThrough?: Date; retentionDays?: number } = {},
): GsaClosedCompCorpusSnapshot {
  const now = options.now ?? new Date(discovery.observedAt);
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
  const coveredThrough = options.coveredThrough ?? now;
  if (!Number.isFinite(coveredThrough.getTime()) || coveredThrough.getTime() > now.getTime()) {
    throw new TypeError("coveredThrough must be a valid date no later than now.");
  }
  const retentionDays = options.retentionDays ?? previous?.retentionDays ?? 366;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
    throw new RangeError(`retentionDays must be between 1 and ${MAX_RETENTION_DAYS}.`);
  }
  if (previous) {
    validateGsaClosedCompCorpus(previous);
    if (Date.parse(previous.refreshedAt) > coveredThrough.getTime()) {
      throw new RangeError("A closed-comp refresh cannot move the retained corpus backward in time.");
    }
  }

  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const merged = new Map<string, GsaClosedComparable>();
  for (const comp of previous?.comparables ?? []) {
    if (Date.parse(comp.endedAt) >= cutoff) merged.set(comp.auctionId, comp);
  }
  for (const comp of discovery.comparables) {
    if (Date.parse(comp.endedAt) >= cutoff) merged.set(comp.auctionId, comp);
  }

  const snapshot: GsaClosedCompCorpusSnapshot = {
    schemaVersion: 1,
    refreshedAt: coveredThrough.toISOString(),
    retentionDays,
    refresh: discovery.coverage,
    comparables: [...merged.values()].sort((left, right) =>
      Date.parse(right.endedAt) - Date.parse(left.endedAt) ||
      left.auctionId.localeCompare(right.auctionId)
    ),
  };
  return validateGsaClosedCompCorpus(snapshot);
}

/** Describes the retained, usable high-bid corpus used by the valuation model. */
export function retainedClosedCompCoverage(
  corpus: GsaClosedCompCorpusSnapshot,
): GsaClosedCompCoverage {
  validateGsaClosedCompCorpus(corpus);
  const detailSucceeded = corpus.comparables.filter((comp) => comp.detailEnriched).length;
  const endedTimes = corpus.comparables.map((comp) => Date.parse(comp.endedAt));
  const earliest = endedTimes.length ? new Date(Math.min(...endedTimes)).toISOString() : corpus.refresh.from;
  return {
    from: earliest,
    to: corpus.refreshedAt,
    catalogRows: corpus.comparables.length,
    closedRows: corpus.comparables.length,
    usableClosedHighBids: corpus.comparables.length,
    // These exclusions describe the latest overlapping official refresh. The
    // retained array itself contains only usable terminal high bids.
    excludedTerminated: corpus.refresh.excludedTerminated,
    excludedNoBid: corpus.refresh.excludedNoBid,
    detailRequested: corpus.comparables.length,
    detailSucceeded,
    detailFailed: corpus.comparables.length - detailSucceeded,
  };
}
