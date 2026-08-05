export type ISODateTime = string;
export type MoneyCents = number;
export type AuctionSource = "gsa-auctions" | "gsa-fleet";

export type AuctionStatus =
  | "preview"
  | "active"
  | "closing"
  | "ended"
  | "sold"
  | "unsold"
  | "cancelled";

export type VehicleCondition =
  | "good"
  | "fair"
  | "repairable"
  | "salvage"
  | "unknown";

export type VehicleOperability =
  | "runs-and-drives"
  | "runs"
  | "non-operational"
  | "unknown";

export interface AuctionLocation {
  city: string;
  state: string;
  postalCode: string;
  address?: string;
}

export interface VehicleSnapshot {
  year: number;
  make: string;
  model: string;
  trim?: string;
  vin?: string;
  mileage?: number;
  odometerStatus?: "reported-not-verified" | "conflicting-readings" | "not-reported";
  bodyStyle?: string;
  transmission?: string;
  fuelType?: string;
  drivetrain?: string;
  color?: string;
  condition: VehicleCondition;
  operability: VehicleOperability;
  titleStatus?: string;
  description: string;
  riskFlags: readonly string[];
}

export type ValuationStatus = "provider" | "reference-only" | "unavailable";
export type ValuationProviderKind =
  | "licensed-provider"
  | "market-comps"
  | "mock-reference";
export type ValuationType =
  | "trade-in"
  | "private-party"
  | "retail"
  | "auction-comp"
  | "composite";

export interface ValuationEvidence {
  /** Unadjusted range reported by the source before mileage matching. */
  rawLowCents: MoneyCents | null;
  rawMedianCents: MoneyCents | null;
  rawHighCents: MoneyCents | null;
  inputMileage: number | null;
  comparableMedianMileage: number | null;
  /** Difference between the source median and the displayed median. */
  mileageAdjustmentCents: MoneyCents | null;
  conditionAdjustmentCents: MoneyCents | null;
  conditionAdjustmentPct: number | null;
  conditionBasis: string | null;
  matchBasis: string;
}

/**
 * An independently sourced vehicle value. A reference-only value may be shown
 * for product development, but it must not be presented as KBB or as a licensed
 * appraisal.
 */
export interface ValuationReference {
  status: ValuationStatus;
  provider: string;
  providerKind: ValuationProviderKind;
  valuationType: ValuationType;
  lowCents: MoneyCents | null;
  medianCents: MoneyCents | null;
  highCents: MoneyCents | null;
  asOf: ISODateTime;
  confidence: number;
  sampleSize: number;
  sourceUrl?: string;
  provenanceNote: string;
  evidence?: ValuationEvidence;
}

export type ForecastStatus = "available" | "reference-only" | "insufficient";
export type ForecastProvenance =
  | "historical-gsa"
  | "market-reference-heuristic"
  | "mock-reference"
  | "insufficient";

export interface ClosingOutcomeAnchor {
  id: string;
  adjustedCloseCents: MoneyCents;
  matchScore?: number;
  weight?: number;
  exactModel?: boolean;
}

/** A closing-price forecast, intentionally separate from vehicle value. */
export interface ClosingForecast {
  status: ForecastStatus;
  lowCents: MoneyCents | null;
  expectedCents: MoneyCents | null;
  highCents: MoneyCents | null;
  asOf: ISODateTime;
  modelVersion: string;
  method: string;
  confidence: number;
  /** Seconds from asOf to the then-current scheduled close. */
  horizonSeconds?: number | null;
  /** Official bid used to calculate this point-in-time forecast. */
  currentBidAtForecastCents?: MoneyCents | null;
  sampleSize: number;
  exactModelCount: number;
  curveCount: number;
  /** Subject-auction observations are not comparable-outcome samples. */
  subjectObservationCount?: number;
  evidenceIds: readonly string[];
  /** Bounded adjusted terminal outcomes retained for point-in-time refreshes. */
  outcomeAnchors?: readonly ClosingOutcomeAnchor[];
  provenance: ForecastProvenance;
  reasonCodes: readonly string[];
}

export interface DealCostBreakdown {
  purchaseBidCents: MoneyCents;
  buyerPremiumCents: MoneyCents;
  purchaseTaxCents: MoneyCents;
  transportCents: MoneyCents;
  titleRegistrationCents: MoneyCents;
  inspectionCents: MoneyCents;
  repairsCents: MoneyCents;
  storageCents: MoneyCents;
  sellingFeesCents: MoneyCents;
  riskReserveCents: MoneyCents;
  totalAcquisitionCents: MoneyCents;
  totalExitCostsCents: MoneyCents;
  totalAllInCents: MoneyCents;
}

export type DealStatus = "actionable" | "watch" | "avoid" | "insufficient";

export interface DealAssessment {
  status: DealStatus;
  score: number;
  tier: 1 | 2 | 3 | 4;
  calculatedAt: ISODateTime;
  conservativeValueCents: MoneyCents | null;
  expectedCloseCents: MoneyCents | null;
  allInAtCurrentBidCents: MoneyCents;
  allInAtExpectedCloseCents: MoneyCents | null;
  safeMaxBidCents: MoneyCents | null;
  breakEvenBidCents: MoneyCents | null;
  projectedProfitCents: MoneyCents | null;
  downsideProfitCents: MoneyCents | null;
  roi: number | null;
  discountToValue: number | null;
  probabilityProfitable: number | null;
  probabilityWinUnderCeiling: number | null;
  confidence: number;
  costs: DealCostBreakdown;
  warnings: readonly string[];
  reasonCodes: readonly string[];
}

export interface AuctionOpportunityProvenance {
  listing: "Official GSA Auctions" | "Official GSA Fleet Marketplace";
  listingObservedAt: ISODateTime;
  valuation: "mock-reference" | "provider" | "unavailable";
}

/**
 * Read model consumed by the Deal Board. Database writes remain normalized;
 * this object deliberately joins the latest records needed by one card/dossier.
 */
export interface AuctionOpportunity {
  id: string;
  externalId: string;
  saleLotNumber: string;
  source: AuctionSource;
  title: string;
  sourceUrl: string;
  imageUrl: string;
  images: readonly string[];
  imageSource: AuctionSource;
  status: AuctionStatus;
  /** Scheduled start; useful for coming-soon and in-person sales. */
  startsAt?: ISODateTime | null;
  saleNumber?: string | null;
  /** Upstream sale channel; only Internet rows expose online bid tracking. */
  saleType?: "internet" | "live" | "unknown";
  onlineBidding?: boolean;
  currentBidCents: MoneyCents | null;
  bidderCount: number | null;
  endsAt: ISODateTime | null;
  lastCheckedAt: ISODateTime;
  location: AuctionLocation;
  vehicle: VehicleSnapshot;
  valuation: ValuationReference;
  forecast: ClosingForecast;
  assessment: DealAssessment;
  provenance: AuctionOpportunityProvenance;
}
