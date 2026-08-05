import type { AuctionOpportunity, AuctionStatus } from "./auction-types";
import {
  assessDeal,
  DEFAULT_DEAL_COSTS,
  DEFAULT_PROFIT_TARGET,
} from "./deal-model.ts";

export interface LiveBidSnapshot {
  externalId: string;
  status: AuctionStatus;
  currentBidCents: number | null;
  bidderCount: number | null;
  endsAt: string | null;
  lastCheckedAt: string;
}

/** Applies an auction-only refresh without discarding the enriched vehicle facts. */
export function applyLiveBidSnapshot(
  auction: AuctionOpportunity,
  snapshot: LiveBidSnapshot,
): AuctionOpportunity {
  if (snapshot.externalId !== auction.externalId) return auction;
  const incomingCheckedAt = Date.parse(snapshot.lastCheckedAt);
  const currentCheckedAt = Date.parse(auction.lastCheckedAt);
  if (
    !Number.isFinite(incomingCheckedAt) ||
    !Number.isFinite(currentCheckedAt) ||
    incomingCheckedAt <= currentCheckedAt
  ) {
    return auction;
  }

  return {
    ...auction,
    status: snapshot.status,
    currentBidCents: snapshot.currentBidCents,
    bidderCount: snapshot.bidderCount,
    endsAt: snapshot.endsAt,
    lastCheckedAt: snapshot.lastCheckedAt,
    assessment: assessDeal({
      currentBidCents: snapshot.currentBidCents ?? 0,
      valuation: auction.valuation,
      forecast: auction.forecast,
      costs: DEFAULT_DEAL_COSTS,
      target: DEFAULT_PROFIT_TARGET,
      calculatedAt: snapshot.lastCheckedAt,
      dataConfidence: 0.25,
    }),
  };
}
