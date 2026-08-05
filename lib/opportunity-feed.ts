import type { AuctionOpportunity } from "./auction-types";
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
    const alternate = merged === fresh ? prior : fresh;
    if (
      alternate.valuation.status !== "unavailable" &&
      merged.valuation.status === "unavailable"
    ) {
      merged = applyValuationToOpportunity(
        merged,
        alternate.valuation,
        merged.lastCheckedAt,
      );
    }
    return merged;
  });
}
