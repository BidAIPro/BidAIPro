import type { AuctionOpportunity } from "./auction-types";

const ACTIVE_BOARD_OUTCOME_ANCHOR_LIMIT = 15;

/**
 * Keeps every sortable board fact while removing detail-only ledgers and Fleet
 * galleries. The selected-vehicle endpoint returns the unabridged record.
 */
export function compactOpportunityForBoard(
  opportunity: AuctionOpportunity,
): AuctionOpportunity {
  const valuation = {
    status: opportunity.valuation.status,
    provider: opportunity.valuation.provider,
    providerKind: opportunity.valuation.providerKind,
    valuationType: opportunity.valuation.valuationType,
    lowCents: opportunity.valuation.lowCents,
    medianCents: opportunity.valuation.medianCents,
    highCents: opportunity.valuation.highCents,
    asOf: opportunity.valuation.asOf,
    confidence: opportunity.valuation.confidence,
    sampleSize: opportunity.valuation.sampleSize,
    sourceUrl: opportunity.valuation.sourceUrl,
  } as AuctionOpportunity["valuation"];
  const forecast = {
    status: opportunity.forecast.status,
    lowCents: opportunity.forecast.lowCents,
    expectedCents: opportunity.forecast.expectedCents,
    highCents: opportunity.forecast.highCents,
    asOf: opportunity.forecast.asOf,
    confidence: opportunity.forecast.confidence,
    sampleSize: opportunity.forecast.sampleSize,
    exactModelCount: opportunity.forecast.exactModelCount,
    provenance: opportunity.forecast.provenance,
    reasonCodes: opportunity.forecast.reasonCodes.includes("MARKET_ONLY_BEFORE_PUBLIC_BID")
      ? ["MARKET_ONLY_BEFORE_PUBLIC_BID"]
      : [],
    evidenceIds: [],
    // Urgent 30/15-second browser bid polling must retain enough terminal
    // evidence to recompute the same close model without abruptly downgrading a
    // highly rated card. Preview rows cannot be polled and keep no anchors.
    outcomeAnchors:
      opportunity.status === "active" || opportunity.status === "closing"
        ? (opportunity.forecast.outcomeAnchors ?? []).slice(
            0,
            ACTIVE_BOARD_OUTCOME_ANCHOR_LIMIT,
          )
        : [],
  } as unknown as AuctionOpportunity["forecast"];
  const assessment = {
    status: opportunity.assessment.status,
    score: opportunity.assessment.score,
    tier: opportunity.assessment.tier,
    confidence: opportunity.assessment.confidence,
    safeMaxBidCents: opportunity.assessment.safeMaxBidCents,
    allInAtCurrentBidCents: opportunity.assessment.allInAtCurrentBidCents,
    projectedProfitCents: opportunity.assessment.projectedProfitCents,
    discountToValue: opportunity.assessment.discountToValue,
    warnings: [],
    reasonCodes: opportunity.assessment.reasonCodes.slice(0, 1),
  } as unknown as AuctionOpportunity["assessment"];
  return {
    ...opportunity,
    images: opportunity.source === "gsa-fleet"
      ? opportunity.images.slice(0, 1)
      : opportunity.images,
    vehicle: {
      ...opportunity.vehicle,
      description: "",
    },
    valuation,
    forecast,
    assessment,
    provenance: {
      listing: opportunity.provenance.listing,
      listingObservedAt: opportunity.provenance.listingObservedAt,
      valuation: opportunity.provenance.valuation,
    },
  };
}
