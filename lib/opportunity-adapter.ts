import type {
  AuctionOpportunity,
  ClosingForecast,
  ValuationReference,
} from "./auction-types";
import {
  assessDeal,
  DEFAULT_DEAL_COSTS,
  DEFAULT_PROFIT_TARGET,
} from "./deal-model.ts";
import type { GsaVehicleAuction } from "./gsa-normalizer.ts";

function externalId(auction: GsaVehicleAuction) {
  const previewId = auction.url.match(/\/preview\/(\d+)/)?.[1];
  return previewId ?? auction.id;
}

function unavailableValuation(observedAt: string): ValuationReference {
  return {
    status: "unavailable",
    provider: "No licensed valuation connected",
    providerKind: "market-comps",
    valuationType: "composite",
    lowCents: null,
    medianCents: null,
    highCents: null,
    asOf: observedAt,
    confidence: 0,
    sampleSize: 0,
    provenanceNote:
      "The official listing is live, but no independent licensed or verified comparable valuation has been attached yet.",
  };
}

function insufficientForecast(observedAt: string): ClosingForecast {
  return {
    status: "insufficient",
    lowCents: null,
    expectedCents: null,
    highCents: null,
    asOf: observedAt,
    modelVersion: "gsa-discovery-only-v1",
    method: "Awaiting verified comparable GSA outcomes",
    confidence: 0,
    sampleSize: 0,
    exactModelCount: 0,
    curveCount: 0,
    evidenceIds: [],
    provenance: "insufficient",
    reasonCodes: ["VERIFIED_GSA_OUTCOMES_REQUIRED"],
  };
}

/**
 * Converts an official hourly discovery record into a deliberately incomplete
 * Deal Board record. It is visible, but cannot receive a safe ceiling or an
 * actionable score until independent valuation and outcome evidence exist.
 */
export function discoveryToOpportunity(
  auction: GsaVehicleAuction,
  observedAt: string,
): AuctionOpportunity {
  const valuation = unavailableValuation(observedAt);
  const forecast = insufficientForecast(observedAt);
  const currentBidCents = Math.round((auction.currentBid ?? 0) * 100);
  const title = auction.title || "Untitled GSA vehicle";
  const year = auction.year ?? Number(title.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0);
  const make = auction.make ?? "Make pending";
  const model = auction.modelLabel ?? title.replace(/^\s*(?:19|20)\d{2}\s+/, "").trim();

  return {
    id: `live-${auction.id.replace(/[^a-z0-9]+/gi, "-")}`,
    externalId: externalId(auction),
    saleLotNumber:
      [auction.saleNumber, auction.lotNumber].filter(Boolean).join(" · Lot ") || auction.id,
    source: "gsa-auctions",
    title,
    sourceUrl: auction.url,
    // The official API may return a short-lived signed image URL. The product
    // does not persist or rehost it before reuse rights are confirmed.
    imageUrl: "",
    imageSource: "gsa-auctions",
    status: auction.status === "active" ? "active" : "preview",
    currentBidCents,
    bidCount: auction.bidderCount ?? 0,
    endsAt: auction.endsAt ?? new Date(Date.parse(observedAt) + 24 * 60 * 60_000).toISOString(),
    lastCheckedAt: observedAt,
    location: {
      city: auction.location.city ?? "Location pending",
      state: auction.location.state ?? "—",
      postalCode: auction.location.postalCode ?? "",
      address: auction.location.addressLines.join(", ") || undefined,
    },
    vehicle: {
      year,
      make,
      model,
      vin: auction.vin ?? undefined,
      mileage: auction.mileage ?? undefined,
      bodyStyle: auction.bodyType ?? undefined,
      condition: "unknown",
      operability: "unknown",
      description: auction.description || "Review the official GSA record for complete vehicle details.",
      riskFlags: [
        "Independent market value pending",
        "Verified GSA outcome comps pending",
        "Condition and operability require official-source verification",
      ],
    },
    valuation,
    forecast,
    assessment: assessDeal({
      currentBidCents,
      valuation,
      forecast,
      costs: DEFAULT_DEAL_COSTS,
      target: DEFAULT_PROFIT_TARGET,
      calculatedAt: observedAt,
      dataConfidence: 0.25,
    }),
    provenance: {
      listing: "Official GSA Auctions",
      listingObservedAt: observedAt,
      valuation: "unavailable",
    },
  };
}

export function mergeEnrichedSeeds(
  discovered: readonly AuctionOpportunity[],
  enriched: readonly AuctionOpportunity[],
): AuctionOpportunity[] {
  const byExternalId = new Map(enriched.map((auction) => [auction.externalId, auction]));
  const merged = discovered.map((auction) => {
    const seed = byExternalId.get(auction.externalId);
    if (!seed) return auction;
    byExternalId.delete(auction.externalId);
    return {
      ...seed,
      currentBidCents: auction.currentBidCents,
      bidCount: auction.bidCount,
      endsAt: auction.endsAt,
      lastCheckedAt: auction.lastCheckedAt,
      status: auction.status,
    };
  });
  // Never make unmatched reference snapshots look like currently active lots
  // when the official feed is healthy. The API route uses the complete seed
  // set only in its explicitly labeled fallback response.
  return merged;
}
