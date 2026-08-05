import type { AuctionOpportunity, ValuationReference } from "./auction-types";
import { applyValuationToOpportunity } from "./opportunity-adapter.ts";

function imageEvidenceCount(auction: AuctionOpportunity) {
  return new Set(
    [auction.imageUrl, ...(auction.images ?? [])]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  ).size;
}

function preferredRecord(current: AuctionOpportunity, incoming: AuctionOpportunity) {
  const currentCheckedAt = Date.parse(current.lastCheckedAt);
  const incomingCheckedAt = Date.parse(incoming.lastCheckedAt);

  if (incomingCheckedAt > currentCheckedAt) return incoming;
  if (currentCheckedAt > incomingCheckedAt) return current;

  // The hosted API and raw data branch can briefly expose the same observation
  // with different photo completeness. Never let the image-poor copy win a tie.
  return imageEvidenceCount(incoming) >= imageEvidenceCount(current)
    ? incoming
    : current;
}

function usableValuation(valuation: ValuationReference): boolean {
  return valuation.status !== "unavailable" &&
    valuation.lowCents !== null &&
    valuation.medianCents !== null &&
    valuation.highCents !== null;
}

function observedAt(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function preferredValuation(
  current: ValuationReference,
  incoming: ValuationReference,
  merged: ValuationReference,
): ValuationReference {
  const currentUsable = usableValuation(current);
  const incomingUsable = usableValuation(incoming);
  if (currentUsable !== incomingUsable) return currentUsable ? current : incoming;
  if (!currentUsable) return merged;

  const currentObservedAt = observedAt(current.asOf);
  const incomingObservedAt = observedAt(incoming.asOf);
  if (currentObservedAt !== incomingObservedAt) {
    return currentObservedAt > incomingObservedAt ? current : incoming;
  }

  // Equal valuation observations should not churn an otherwise preferred live
  // listing record. Confidence and sample size provide deterministic fallbacks
  // when neither valuation belongs to that record.
  if (merged === current || merged === incoming) return merged;
  return incoming.confidence !== current.confidence
    ? incoming.confidence > current.confidence ? incoming : current
    : incoming.sampleSize >= current.sampleSize ? incoming : current;
}

function mergedCalculationTime(
  auction: AuctionOpportunity,
  valuation: ValuationReference,
): string {
  return observedAt(valuation.asOf) > observedAt(auction.lastCheckedAt)
    ? valuation.asOf
    : auction.lastCheckedAt;
}

/** Older cached feeds must not erase newer facts or renewed image signatures. */
export function mergeOpportunityFeed(
  current: readonly AuctionOpportunity[],
  incoming: readonly AuctionOpportunity[],
): AuctionOpportunity[] {
  const existing = new Map(current.map((auction) => [auction.id, auction]));
  return incoming.map((fresh) => {
    const prior = existing.get(fresh.id);
    if (!prior) return fresh;

    let merged = preferredRecord(prior, fresh);
    const valuation = preferredValuation(
      prior.valuation,
      fresh.valuation,
      merged.valuation,
    );
    if (valuation !== merged.valuation) {
      merged = applyValuationToOpportunity(
        merged,
        valuation,
        mergedCalculationTime(merged, valuation),
      );
    } else if (
      usableValuation(merged.valuation) &&
      merged.forecast.status === "insufficient"
    ) {
      // A newer catalog observation should update the projected close instead
      // of erasing the forecast that was attached to the prior enriched row.
      merged = applyValuationToOpportunity(
        merged,
        merged.valuation,
        mergedCalculationTime(merged, merged.valuation),
      );
    }
    return merged;
  });
}
