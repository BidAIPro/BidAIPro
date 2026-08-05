import type {
  AuctionOpportunity,
  ClosingForecast,
  ValuationReference,
  VehicleCondition,
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

function vehicleCondition(condition: GsaVehicleAuction["condition"]): VehicleCondition {
  switch (condition) {
    case "new":
    case "usable":
      return "good";
    case "repairable":
      return "repairable";
    case "salvage":
    case "scrap":
      return "salvage";
    default:
      return "unknown";
  }
}

function readableFlag(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceRiskFlags(auction: GsaVehicleAuction): string[] {
  const flags = [
    ...auction.damageFlags.map(readableFlag),
    ...auction.issueFlags.map(readableFlag),
    ...auction.conditionNotes,
    ...(auction.openRecall === true ? ["Open recall disclosed"] : []),
    ...(auction.mileage === null ? ["Mileage not reported by GSA"] : []),
  ];
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const clean = flag.trim();
    const key = clean.toLocaleLowerCase("en-US");
    if (!clean || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Applies an independently fetched value to an opportunity and reruns the
 * exact same ceiling/cost model used when the listing was first adapted.
 */
export function applyValuationToOpportunity(
  opportunity: AuctionOpportunity,
  valuation: ValuationReference,
  calculatedAt = valuation.asOf,
): AuctionOpportunity {
  const listingConfidence = opportunity.vehicle.vin && opportunity.vehicle.mileage !== undefined
    ? 0.65
    : 0.45;
  return {
    ...opportunity,
    valuation,
    assessment: assessDeal({
      currentBidCents: opportunity.currentBidCents ?? 0,
      valuation,
      forecast: opportunity.forecast,
      costs: DEFAULT_DEAL_COSTS,
      target: DEFAULT_PROFIT_TARGET,
      calculatedAt,
      dataConfidence: listingConfidence,
    }),
    provenance: {
      ...opportunity.provenance,
      valuation: valuation.status === "unavailable" ? "unavailable" : "provider",
    },
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
  const currentBidCents = auction.currentBid === null ? null : Math.round(auction.currentBid * 100);
  const title = auction.title || "Untitled GSA vehicle";
  const year = auction.year ?? Number(title.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0);
  const make = auction.make ?? "Make pending";
  const model = auction.modelLabel ?? title.replace(/^\s*(?:19|20)\d{2}\s+/, "").trim();
  const images = [...new Set([auction.imageUrl, ...auction.images].filter((value): value is string => Boolean(value)))];

  return {
    id: `live-${auction.id.replace(/[^a-z0-9]+/gi, "-")}`,
    externalId: externalId(auction),
    saleLotNumber:
      [auction.saleNumber, auction.lotNumber].filter(Boolean).join(" · Lot ") || auction.id,
    source: "gsa-auctions",
    title,
    sourceUrl: auction.url,
    // PPMS signs official listing images for one hour. The feed refreshes them
    // with headroom and the client falls back cleanly if a signature expires.
    imageUrl: images[0] ?? "",
    images,
    imageSource: "gsa-auctions",
    status: auction.status === "active" ? "active" : "preview",
    currentBidCents,
    bidderCount: auction.bidderCount,
    endsAt: auction.endsAt,
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
      odometerStatus: auction.odometerStatus,
      bodyStyle: auction.bodyType ?? undefined,
      transmission: auction.transmission ?? undefined,
      fuelType: auction.fuelType ?? undefined,
      color: auction.color ?? undefined,
      condition: vehicleCondition(auction.condition),
      operability: auction.operability,
      description: auction.description || "Review the official GSA record for complete vehicle details.",
      riskFlags: sourceRiskFlags(auction),
    },
    valuation,
    forecast,
    assessment: assessDeal({
      // The model requires a numeric purchase basis, but the assessment is
      // deliberately insufficient and never actionable when the feed omits it.
      currentBidCents: currentBidCents ?? 0,
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
