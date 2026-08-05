import type {
  AuctionOpportunity,
  ClosingForecast,
  ValuationReference,
  VehicleSnapshot,
} from "./auction-types";
import { assessDeal, type DealCostInputs } from "./deal-model.ts";

const OBSERVED_AT = "2026-08-05T03:01:03.000Z";
const REFERENCE_PROVIDER = "Internal scenario reference (not KBB)";

interface SeedDefinition {
  externalId: string;
  saleLotNumber: string;
  title: string;
  currentBidCents: number;
  bidderCount: number;
  endsAt: string;
  location: AuctionOpportunity["location"];
  vehicle: VehicleSnapshot;
  referenceValue: readonly [low: number, median: number, high: number];
  referenceClose: readonly [low: number, expected: number, high: number];
  costs?: Partial<DealCostInputs>;
  dataConfidence?: number;
}

const BASE_COSTS: DealCostInputs = {
  buyerPremiumRate: 0,
  purchaseTaxRate: 0,
  sellingFeeRate: 0.08,
  transportCents: 90_000,
  titleRegistrationCents: 22_500,
  inspectionCents: 17_500,
  repairsCents: 75_000,
  storageCents: 0,
  riskReserveCents: 100_000,
};

function referenceValuation(
  values: SeedDefinition["referenceValue"],
): ValuationReference {
  return {
    status: "reference-only",
    provider: REFERENCE_PROVIDER,
    providerKind: "mock-reference",
    valuationType: "composite",
    lowCents: values[0],
    medianCents: values[1],
    highCents: values[2],
    asOf: OBSERVED_AT,
    confidence: 0.2,
    sampleSize: 0,
    provenanceNote:
      "Illustrative product-development range only. No licensed valuation provider, including KBB, supplied this value.",
  };
}

function referenceForecast(
  range: SeedDefinition["referenceClose"],
): ClosingForecast {
  return {
    status: "reference-only",
    lowCents: range[0],
    expectedCents: range[1],
    highCents: range[2],
    asOf: OBSERVED_AT,
    modelVersion: "scenario-reference-v1",
    method: "Illustrative close scenario; not trained on GSA outcomes",
    confidence: 0.15,
    sampleSize: 0,
    exactModelCount: 0,
    curveCount: 0,
    evidenceIds: [],
    provenance: "mock-reference",
    reasonCodes: ["MOCK_REFERENCE_NOT_MODEL"],
  };
}

function seedAuction(definition: SeedDefinition): AuctionOpportunity {
  const valuation = referenceValuation(definition.referenceValue);
  const forecast = referenceForecast(definition.referenceClose);
  const costs = { ...BASE_COSTS, ...definition.costs };

  return {
    id: `gsa-${definition.externalId}`,
    externalId: definition.externalId,
    saleLotNumber: definition.saleLotNumber,
    source: "gsa-auctions",
    title: definition.title,
    sourceUrl: `https://gsaauctions.gov/auctions/preview/${definition.externalId}`,
    // GSA listing photos are issued as expiring signed URLs. Persisting those
    // credentials would create broken or sensitive seed data, so the UI should
    // use its local fallback until a live source check supplies a fresh URL.
    imageUrl: "",
    images: [],
    imageSource: "gsa-auctions",
    status: "active",
    currentBidCents: definition.currentBidCents,
    bidderCount: definition.bidderCount,
    endsAt: definition.endsAt,
    lastCheckedAt: OBSERVED_AT,
    location: definition.location,
    vehicle: definition.vehicle,
    valuation,
    forecast,
    assessment: assessDeal({
      currentBidCents: definition.currentBidCents,
      valuation,
      forecast,
      costs,
      target: { minimumProfitCents: 150_000, targetMarginRate: 0.12 },
      calculatedAt: OBSERVED_AT,
      dataConfidence: definition.dataConfidence ?? 0.35,
    }),
    provenance: {
      listing: "Official GSA Auctions",
      listingObservedAt: OBSERVED_AT,
      valuation: "mock-reference",
    },
  };
}

/**
 * Official GSA active-list facts observed on August 5, 2026 UTC. Values and
 * closing ranges are deliberately marked as mock references and must be
 * replaced by licensed provider data and verified closed-auction evidence.
 */
export const SEED_AUCTIONS: readonly AuctionOpportunity[] = [
  seedAuction({
    externalId: "372696",
    saleLotNumber: "4-1-QSC-V-26-005-001",
    title: "2018 Dodge Durango SXT",
    currentBidCents: 251_000,
    bidderCount: 3,
    endsAt: "2026-08-07T17:00:00.000Z",
    location: { city: "Fontana", state: "CA", postalCode: "92335" },
    vehicle: {
      year: 2018,
      make: "Dodge",
      model: "Durango",
      trim: "SXT",
      vin: "1C4RDHAG2JC431347",
      mileage: 79_401,
      bodyStyle: "SUV",
      transmission: "Automatic",
      fuelType: "Gasoline",
      color: "Silver",
      condition: "repairable",
      operability: "non-operational",
      description:
        "Official listing describes a six-cylinder Durango needing a replacement engine. It must be towed; GSA stock number 45708764.",
      riskFlags: [
        "Non-operational",
        "Replacement engine required",
        "Tow-away pickup required",
        "Repair scope requires inspection",
      ],
    },
    referenceValue: [400_000, 550_000, 700_000],
    referenceClose: [325_000, 430_000, 575_000],
    costs: {
      transportCents: 125_000,
      inspectionCents: 25_000,
      repairsCents: 650_000,
      riskReserveCents: 250_000,
    },
    dataConfidence: 0.65,
  }),
  seedAuction({
    externalId: "372697",
    saleLotNumber: "4-1-QSC-V-26-005-002",
    title: "2020 Nissan Pathfinder",
    currentBidCents: 351_000,
    bidderCount: 4,
    endsAt: "2026-08-07T17:10:00.000Z",
    location: { city: "Fontana", state: "CA", postalCode: "92335" },
    vehicle: {
      year: 2020,
      make: "Nissan",
      model: "Pathfinder",
      bodyStyle: "SUV",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official GSA active-catalog record. Mileage, VIN, equipment, operability, and detailed condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [1_050_000, 1_325_000, 1_575_000],
    referenceClose: [625_000, 825_000, 1_050_000],
  }),
  seedAuction({
    externalId: "372698",
    saleLotNumber: "4-1-QSC-V-26-005-003",
    title: "2019 RAM 1500",
    currentBidCents: 303_000,
    bidderCount: 4,
    endsAt: "2026-08-07T17:20:00.000Z",
    location: { city: "Fontana", state: "CA", postalCode: "92335" },
    vehicle: {
      year: 2019,
      make: "RAM",
      model: "1500",
      bodyStyle: "Pickup",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official GSA active-catalog record. Trim, mileage, VIN, drivetrain, and condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [1_300_000, 1_700_000, 2_100_000],
    referenceClose: [750_000, 1_050_000, 1_400_000],
  }),
  seedAuction({
    externalId: "372699",
    saleLotNumber: "4-1-QSC-V-26-005-004",
    title: "2009 Ford Explorer XLT",
    currentBidCents: 246_500,
    bidderCount: 5,
    endsAt: "2026-08-07T17:30:00.000Z",
    location: { city: "Tucson", state: "AZ", postalCode: "85714" },
    vehicle: {
      year: 2009,
      make: "Ford",
      model: "Explorer",
      trim: "XLT",
      bodyStyle: "SUV",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official GSA active-catalog record. Mileage, VIN, drivetrain, operability, and detailed condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [300_000, 400_000, 500_000],
    referenceClose: [285_000, 350_000, 440_000],
    costs: { transportCents: 105_000 },
  }),
  seedAuction({
    externalId: "372700",
    saleLotNumber: "4-1-QSC-V-26-005-005",
    title: "2016 Ford Explorer",
    currentBidCents: 151_000,
    bidderCount: 2,
    endsAt: "2026-08-07T17:40:00.000Z",
    location: { city: "Fontana", state: "CA", postalCode: "92335" },
    vehicle: {
      year: 2016,
      make: "Ford",
      model: "Explorer",
      bodyStyle: "SUV",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official GSA active-catalog record. Trim, mileage, VIN, drivetrain, and condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [700_000, 900_000, 1_100_000],
    referenceClose: [450_000, 625_000, 825_000],
  }),
  seedAuction({
    externalId: "372701",
    saleLotNumber: "4-1-QSC-V-26-005-006",
    title: "2020 Nissan Pathfinder",
    currentBidCents: 509_700,
    bidderCount: 7,
    endsAt: "2026-08-07T17:50:00.000Z",
    location: { city: "Fontana", state: "CA", postalCode: "92335" },
    vehicle: {
      year: 2020,
      make: "Nissan",
      model: "Pathfinder",
      bodyStyle: "SUV",
      condition: "unknown",
      operability: "unknown",
      description:
        "A second official 2020 Pathfinder lot in the GSA active catalog. Vehicle-specific mileage, VIN, equipment, and condition remain pending.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [1_050_000, 1_325_000, 1_575_000],
    referenceClose: [725_000, 900_000, 1_125_000],
  }),
  seedAuction({
    externalId: "372500",
    saleLotNumber: "3-1-QSC-I-26-506-009",
    title: "2024 Nissan Titan 4x4 Crew Cab SV",
    currentBidCents: 3_000_000,
    bidderCount: 6,
    endsAt: "2026-08-05T17:53:00.000Z",
    location: { city: "Salina", state: "KS", postalCode: "67401" },
    vehicle: {
      year: 2024,
      make: "Nissan",
      model: "Titan",
      trim: "SV",
      bodyStyle: "Crew Cab Pickup",
      drivetrain: "4x4",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official active-catalog title identifies an SV 4x4 Crew Cab. Mileage, VIN, operability, and detailed condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [3_400_000, 4_000_000, 4_600_000],
    referenceClose: [3_100_000, 3_450_000, 3_900_000],
    costs: { transportCents: 135_000, riskReserveCents: 175_000 },
  }),
  seedAuction({
    externalId: "372499",
    saleLotNumber: "3-1-QSC-I-26-506-008",
    title: "2020 Jeep Cherokee Latitude Plus FWD",
    currentBidCents: 888_500,
    bidderCount: 6,
    endsAt: "2026-08-05T17:43:00.000Z",
    location: { city: "Springfield", state: "MO", postalCode: "65802" },
    vehicle: {
      year: 2020,
      make: "Jeep",
      model: "Cherokee",
      trim: "Latitude Plus",
      bodyStyle: "SUV",
      drivetrain: "FWD",
      condition: "unknown",
      operability: "unknown",
      description:
        "Official active-catalog title identifies a Latitude Plus FWD. Mileage, VIN, operability, and detailed condition require a fresh detail-page check.",
      riskFlags: ["Mileage pending", "Condition details require live GSA verification"],
    },
    referenceValue: [1_000_000, 1_250_000, 1_500_000],
    referenceClose: [925_000, 1_075_000, 1_275_000],
    costs: { transportCents: 110_000 },
  }),
];
