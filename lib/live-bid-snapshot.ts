import type {
  AuctionOpportunity,
  AuctionStatus,
  DealAssessment,
} from "./auction-types";
import {
  assessDeal,
  DEFAULT_DEAL_COSTS,
  DEFAULT_PROFIT_TARGET,
} from "./deal-model.ts";
import {
  buildReferenceClosingForecast,
  type SubjectBidObservation,
} from "./closing-forecast.ts";

export interface LiveBidSnapshot {
  externalId: string;
  status: AuctionStatus;
  currentBidCents: number | null;
  bidderCount: number | null;
  endsAt: string | null;
  lastCheckedAt: string;
  /** Official or locally observed points used only for bid-trend context. */
  subjectBidObservations?: readonly SubjectBidObservation[];
}

function requireObservedBid(
  assessment: DealAssessment,
  currentBidCents: number | null,
): DealAssessment {
  if (currentBidCents !== null) return assessment;
  return {
    ...assessment,
    status: "insufficient",
    score: 0,
    tier: 4,
    expectedCloseCents: null,
    allInAtExpectedCloseCents: null,
    projectedProfitCents: null,
    downsideProfitCents: null,
    roi: null,
    discountToValue: null,
    probabilityProfitable: null,
    probabilityWinUnderCeiling: null,
    confidence: 0,
    warnings: [...assessment.warnings, "A current auction bid is not available."],
    reasonCodes: [...assessment.reasonCodes, "CURRENT_BID_UNAVAILABLE"],
  };
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

  const observations: SubjectBidObservation[] = [
    ...(auction.currentBidCents === null
      ? []
      : [{
          observedAt: auction.lastCheckedAt,
          currentBidCents: auction.currentBidCents,
          bidderCount: auction.bidderCount,
        }]),
    ...(snapshot.subjectBidObservations ?? []),
    ...(snapshot.currentBidCents === null
      ? []
      : [{
          observedAt: snapshot.lastCheckedAt,
          currentBidCents: snapshot.currentBidCents,
          bidderCount: snapshot.bidderCount,
        }]),
  ];
  const forecast = buildReferenceClosingForecast({
    currentBidCents: snapshot.currentBidCents,
    bidderCount: snapshot.bidderCount,
    endsAt: snapshot.endsAt,
    asOf: snapshot.lastCheckedAt,
    valuation: auction.valuation,
    terminalOutcomes: auction.forecast.outcomeAnchors ?? [],
    subjectBidObservations: observations,
  });

  return {
    ...auction,
    status: snapshot.status,
    currentBidCents: snapshot.currentBidCents,
    bidderCount: snapshot.bidderCount,
    endsAt: snapshot.endsAt,
    lastCheckedAt: snapshot.lastCheckedAt,
    forecast,
    assessment: requireObservedBid(assessDeal({
      currentBidCents: snapshot.currentBidCents ?? 0,
      valuation: auction.valuation,
      forecast,
      costs: DEFAULT_DEAL_COSTS,
      target: DEFAULT_PROFIT_TARGET,
      calculatedAt: snapshot.lastCheckedAt,
      dataConfidence: 0.25,
    }), snapshot.currentBidCents),
  };
}
