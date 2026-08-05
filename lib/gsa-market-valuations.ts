import type {
  GsaVehicleCondition,
  GsaVehicleOperability,
} from "./gsa-normalizer.ts";
import type {
  GsaClosedComparable,
  GsaClosedCompCoverage,
} from "./gsa-closed-comps.ts";
import { GSA_PPMS_CATALOG_ENDPOINT } from "./gsa-ppms-client.ts";

const CALCULATION_VERSION = "gsa-weighted-auction-comps-v2";
const MAX_COMPARABLES = 15;
const MAX_PUBLISHED_SAMPLES = 12;
const MIN_BODY_CLASS_COMPARABLES = 3;

export type GsaMarketMatchBasis =
  | "family-year-mileage"
  | "family"
  | "body-class";

export interface GsaMarketValuationSubject {
  id: string;
  externalId?: string | null;
  sourceUrl: string;
  title: string;
  year: number | null;
  make: string | null;
  modelLabel: string | null;
  vin?: string | null;
  mileage: number | null;
  bodyType: string | null;
  condition: GsaVehicleCondition;
  operability: GsaVehicleOperability;
  damageFlags?: readonly string[];
  issueFlags?: readonly string[];
}

export interface GsaComparableAdjustment {
  sampleId: string;
  auctionId: string;
  sourceUrl: string;
  title: string;
  vin: string | null;
  endedAt: string;
  year: number | null;
  mileage: number | null;
  mileageDifference: number | null;
  mileageCloseness: number;
  condition: GsaVehicleCondition;
  rawClosedHighBidCents: number;
  adjustedHighBidCents: number;
  weight: number;
  matchScore: number;
  factors: {
    year: number;
    mileage: number;
    condition: number;
    operability: number;
    disclosedIssues: number;
  };
}

export interface GsaMarketAdjustmentDetail {
  model: typeof CALCULATION_VERSION;
  subjectInputs: {
    family: string | null;
    vehicleClass: string | null;
    year: number | null;
    mileage: number | null;
    condition: GsaVehicleCondition;
    operability: GsaVehicleOperability;
    disclosedIssueCount: number;
  };
  parameters: {
    yearAnnualRate: number;
    mileageElasticity: number;
    conditionStepRate: number;
    operabilityStepRate: number;
    issueStepRate: number;
  };
  notes: readonly string[];
}

export interface AvailableGsaMarketValuation {
  subjectAuctionId: string;
  externalId: string;
  status: "available";
  provider: "Official GSA Auctions";
  valuationType: "auction-comp";
  currency: "USD";
  lowCents: number;
  medianCents: number;
  highCents: number;
  asOf: string;
  sampleSize: number;
  confidence: number;
  matchBasis: GsaMarketMatchBasis;
  matchLabel: string;
  family: string | null;
  vehicleClass: string | null;
  sourceUrls: readonly string[];
  sampleIds: readonly string[];
  adjustmentDetail: GsaMarketAdjustmentDetail;
  comparables: readonly GsaComparableAdjustment[];
  provenanceNote: string;
}

export interface UnavailableGsaMarketValuation {
  subjectAuctionId: string;
  externalId: string;
  status: "unavailable";
  provider: "Official GSA Auctions";
  valuationType: "auction-comp";
  currency: "USD";
  lowCents: null;
  medianCents: null;
  highCents: null;
  asOf: string;
  sampleSize: 0;
  confidence: 0;
  matchBasis: null;
  matchLabel: "No defensible GSA vehicle-class match";
  family: string | null;
  vehicleClass: string | null;
  sourceUrls: readonly [string];
  sampleIds: readonly [];
  adjustmentDetail: GsaMarketAdjustmentDetail;
  comparables: readonly [];
  provenanceNote: string;
}

export type GsaMarketValuation =
  | AvailableGsaMarketValuation
  | UnavailableGsaMarketValuation;

export interface GsaMarketValuationSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  calculationVersion: typeof CALCULATION_VERSION;
  source: {
    provider: "U.S. General Services Administration";
    official: true;
    dataKind: "closed-high-bid-comparables";
    catalogUrl: typeof GSA_PPMS_CATALOG_ENDPOINT;
    semantics: string;
  };
  corpus: GsaClosedCompCoverage;
  coverage: {
    subjectCount: number;
    valuedCount: number;
    unavailableCount: number;
    basisCounts: Record<GsaMarketMatchBasis, number>;
  };
  valuations: readonly GsaMarketValuation[];
}

interface Candidate {
  comp: GsaClosedComparable;
  family: string | null;
  vehicleClass: string | null;
  preliminaryScore: number;
}

function compact(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toUpperCase()
    .replace(/FORD MOTOR (?:CO|COMPANY)/g, "FORD")
    .replace(/CHEVROLET MOTOR DIVISION|CHEVROLET TRUCK/g, "CHEVROLET")
    .replace(/DODGE TRUCK|RAM TRUCK/g, "RAM")
    .replace(/[^A-Z0-9]+/g, "");
}

function canonicalMake(value: string | null): string | null {
  const make = compact(value);
  if (!make) return null;
  if (make.includes("FORD")) return "ford";
  if (make.includes("CHEVROLET") || make === "CHEVY") return "chevrolet";
  if (make === "GMC" || make.includes("GENERALMOTORS")) return "gmc";
  if (make.includes("RAM")) return "ram";
  if (make.includes("DODGE")) return "dodge";
  if (make.includes("INTERNATIONAL")) return "international";
  if (make.includes("FREIGHTLINER")) return "freightliner";
  if (make.includes("NISSAN")) return "nissan";
  if (make.includes("CHRYSLER")) return "chrysler";
  if (make.includes("JEEP")) return "jeep";
  if (make.includes("KTM")) return "ktm";
  return make.toLowerCase();
}

/** Canonical family names intentionally collapse trim and cab spelling noise. */
export function canonicalVehicleFamily(
  vehicle: Pick<GsaMarketValuationSubject, "make" | "modelLabel" | "title">,
): string | null {
  const make = canonicalMake(vehicle.make);
  const text = compact(`${vehicle.make ?? ""} ${vehicle.modelLabel ?? ""} ${vehicle.title}`);
  const known: readonly [string, RegExp][] = [
    ["ford-f150", /\bF?150\b|F150/],
    ["ford-f250", /F250/],
    ["ford-f350", /F350/],
    ["ford-f450", /F450/],
    ["ford-f550", /F550/],
    ["ford-ranger", /RANGER/],
    ["ford-transit-connect", /TRANSITCONNECT/],
    ["ford-transit", /TRANSIT/],
    ["ford-e150", /E150/],
    ["ford-e250", /E250/],
    ["ford-e350", /E350/],
    ["ford-explorer", /EXPLORER/],
    ["ford-expedition", /EXPEDITION/],
    ["chevrolet-silverado-1500", /(?:SILVERAD[O0].*1500|(?:K|C)?1500.*SILVERAD[O0])/],
    ["chevrolet-silverado-2500", /(?:SILVERAD[O0].*2500|(?:K|C)?2500.*SILVERAD[O0])/],
    ["chevrolet-silverado-3500", /(?:SILVERAD[O0].*3500|(?:K|C)?3500.*SILVERAD[O0])/],
    ["chevrolet-silverado", /SILVERAD[O0]/],
    ["chevrolet-express", /EXPRESS/],
    ["chevrolet-tahoe", /TAHOE/],
    ["chevrolet-suburban", /SUBURBAN/],
    ["chevrolet-equinox", /EQUINOX/],
    ["chevrolet-malibu", /MALIBU/],
    ["chevrolet-volt", /VOLT/],
    ["ram-1500", /(?:RAM.*1500|1500.*(?:RAM|TRADESMAN|CLASSIC))/],
    ["ram-2500", /(?:RAM.*2500|2500.*(?:RAM|TRADESMAN|ST))/],
    ["ram-3500", /(?:RAM.*3500|3500.*(?:RAM|TRADESMAN))/],
    ["ram-4500", /(?:RAM.*4500|4500.*RAM)/],
    ["ram-5500", /(?:RAM.*5500|5500.*RAM)/],
    ["dodge-grand-caravan", /GRANDCARAVAN/],
    ["dodge-durango", /DURANGO/],
    ["dodge-charger", /CHARGER/],
    ["nissan-titan", /TITAN/],
    ["nissan-pathfinder", /PATHFINDER/],
    ["jeep-grand-cherokee", /GRANDCHEROKEE/],
    ["jeep-cherokee", /CHEROKEE/],
  ];

  for (const [family, pattern] of known) {
    if (!pattern.test(text)) continue;
    const familyMake = family.split("-")[0];
    if (
      familyMake === make ||
      (familyMake === "ram" && (make === "dodge" || make === "ram"))
    ) {
      return family;
    }
  }

  const model = compact(vehicle.modelLabel);
  if (!make || !model || model.length < 2) return null;
  return `${make}-${model.toLowerCase()}`;
}

/** Returns a deliberately coarse class only when cross-model comparison is defensible. */
export function classifyVehicle(
  vehicle: Pick<GsaMarketValuationSubject, "make" | "modelLabel" | "title" | "bodyType">,
): string | null {
  const family = canonicalVehicleFamily(vehicle);
  const text = compact(`${vehicle.title} ${vehicle.modelLabel ?? ""} ${vehicle.bodyType ?? ""}`);

  if (/FIRE|PUMPER|FIREAPPARATUS|FOAMTRUCK/.test(text)) return "fire-apparatus";
  if (/MOTORCYCLE|MOTORBIKE|KTM/.test(text)) return "motorcycle";
  if (/TRAM|GOLFCART|LOWSPEED|MOTOELECTRIC/.test(text)) return "low-speed-vehicle";
  if (/BUS|SHUTTLE|COACH/.test(text)) return "bus-shuttle";
  if (
    /FREIGHTLINER|INTERNATIONAL|OSHKOSH|L9000|HEAVYDUTY|TRACTORTRUCK|DUMPTRUCK/.test(text)
  ) return "truck-heavy-duty";

  if (family && /-(?:f150|silverado-1500|ranger|titan|1500)$/.test(family)) {
    return "pickup-light-duty";
  }
  if (family && /-(?:f250|silverado-2500|2500)$/.test(family)) {
    return "pickup-three-quarter-ton";
  }
  if (family && /-(?:f350|silverado-3500|3500)$/.test(family)) {
    return "pickup-one-ton";
  }
  if (family && /-(?:f450|f550|4500|5500)$/.test(family)) return "pickup-heavy-duty";
  if (/PICKUP|CREWCAB|QUADCAB|DOUBLECAB|FLATBED/.test(text)) return "pickup-other";

  if (family && /grand-caravan/.test(family)) return "minivan";
  if (family && /transit-connect/.test(family)) return "compact-van";
  if (family && /(?:transit|express|e150|e250|e350)/.test(family)) return "full-size-van";
  if (/MINIVAN|GRANDCARAVAN/.test(text)) return "minivan";
  if (/CARGOVAN|PASSENGERVAN|FULLSIZEVAN|\bVAN\b/.test(text)) return "full-size-van";

  if (family && /(?:expedition|tahoe|suburban)/.test(family)) return "suv-full-size";
  if (family && /(?:explorer|durango|pathfinder|grand-cherokee)/.test(family)) {
    return "suv-midsize";
  }
  if (family && /(?:cherokee|equinox)/.test(family)) return "suv-compact";
  if (/SPORTUTILITY|CROSSOVER|\bSUV\b/.test(text)) return "suv-other";

  if (/HATCHBACK/.test(text)) return "passenger-hatchback";
  if (/SEDAN|4DOOR|PASSENGERCAR|MALIBU|CHARGER|VOLT/.test(text)) return "passenger-sedan";
  return null;
}

function conditionScore(value: GsaVehicleCondition): number {
  return { new: 5, usable: 4, unknown: 3, repairable: 2, salvage: 1, scrap: 0 }[value];
}

function operabilityScore(value: GsaVehicleOperability): number {
  return { "runs-and-drives": 3, runs: 2, unknown: 1, "non-operational": 0 }[value];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ratioCloseness(left: number | null, right: number | null): number {
  if (!left || !right || left <= 0 || right <= 0) return 0.4;
  return Math.exp(-Math.abs(Math.log(left / right)) / 0.75);
}

type MatchMode = "tight-family" | "family" | "body-class";
type ConditionBand = "normal" | "repairable" | "terminal" | "unknown";
type OperabilityBand = "mobile" | "non-operational" | "unknown";

const DEFENSIBLE_BODY_CLASS_FALLBACKS = new Set([
  "compact-van",
  "full-size-van",
  "minivan",
  "passenger-hatchback",
  "passenger-sedan",
  "pickup-light-duty",
  "pickup-one-ton",
  "pickup-three-quarter-ton",
  "suv-compact",
  "suv-full-size",
  "suv-midsize",
]);

function conditionBand(value: GsaVehicleCondition): ConditionBand {
  if (value === "new" || value === "usable") return "normal";
  if (value === "repairable") return "repairable";
  if (value === "salvage" || value === "scrap") return "terminal";
  return "unknown";
}

function operabilityBand(value: GsaVehicleOperability): OperabilityBand {
  if (value === "runs" || value === "runs-and-drives") return "mobile";
  return value === "non-operational" ? "non-operational" : "unknown";
}

function conditionCompatible(
  subject: GsaVehicleCondition,
  comparable: GsaVehicleCondition,
  mode: MatchMode,
): boolean {
  const left = conditionBand(subject);
  const right = conditionBand(comparable);
  if (mode === "body-class") return left === right;
  if (left === "unknown" || right === "unknown") return true;
  if (mode === "tight-family") return left === right;
  if (left === "terminal" || right === "terminal") return left === right;
  return true;
}

function operabilityCompatible(
  subject: GsaVehicleOperability,
  comparable: GsaVehicleOperability,
  mode: MatchMode,
): boolean {
  const left = operabilityBand(subject);
  const right = operabilityBand(comparable);
  if (mode === "body-class") return left === right;
  if (left === "unknown" || right === "unknown") return true;
  return left === right;
}

function classCompatible(subjectClass: string | null, comparableClass: string | null): boolean {
  return subjectClass === null || comparableClass === null || subjectClass === comparableClass;
}

function yearCompatible(
  subjectYear: number | null,
  comparableYear: number | null,
  referenceYear: number,
  mode: MatchMode,
): boolean {
  if (subjectYear === null) return mode !== "body-class";
  if (comparableYear === null) return false;
  const recent = referenceYear - subjectYear <= 4;
  const maximumDifference = mode === "tight-family"
    ? recent ? 2 : 3
    : mode === "family"
      ? recent ? 3 : 5
      : recent ? 1 : 2;
  return Math.abs(subjectYear - comparableYear) <= maximumDifference;
}

function mileageCompatible(
  subjectMileage: number | null,
  comparableMileage: number | null,
  mode: MatchMode,
): boolean {
  if (subjectMileage === null) return mode !== "body-class";
  if (comparableMileage === null) return false;
  const difference = Math.abs(subjectMileage - comparableMileage);
  const maximumDifference = mode === "tight-family"
    ? Math.max(20_000, subjectMileage * 0.5)
    : mode === "family"
      ? Math.max(40_000, subjectMileage * 0.75)
      : Math.max(15_000, subjectMileage * 0.35);
  if (difference > maximumDifference) return false;

  // Ratios are unstable around a near-zero odometer. In that case, retain the
  // strict absolute ceiling instead of rejecting an otherwise close new unit.
  if (Math.min(subjectMileage, comparableMileage) < 1_000) {
    const lowMileageCeiling = mode === "body-class" ? 15_000 : mode === "tight-family" ? 25_000 : 40_000;
    return Math.max(subjectMileage, comparableMileage) <= lowMileageCeiling;
  }
  const ratio = Math.max(
    subjectMileage / comparableMileage,
    comparableMileage / subjectMileage,
  );
  const maximumRatio = subjectMileage < 25_000
    ? mode === "tight-family" ? 3 : mode === "family" ? 4 : 2.75
    : mode === "tight-family" ? 1.75 : mode === "family" ? 2.25 : 1.5;
  return ratio <= maximumRatio;
}

function eligibleCandidate(
  subject: GsaMarketValuationSubject,
  comp: GsaClosedComparable,
  subjectClass: string | null,
  comparableClass: string | null,
  referenceYear: number,
  mode: MatchMode,
): boolean {
  return classCompatible(subjectClass, comparableClass) &&
    yearCompatible(subject.year, comp.year, referenceYear, mode) &&
    mileageCompatible(subject.mileage, comp.mileage, mode) &&
    conditionCompatible(subject.condition, comp.condition, mode) &&
    operabilityCompatible(subject.operability, comp.operability, mode);
}

function canonicalVin(value: string | null | undefined): string | null {
  const vin = value?.trim().toUpperCase() ?? "";
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}

function uniqueComparableRows(
  subject: GsaMarketValuationSubject,
  comps: readonly GsaClosedComparable[],
): GsaClosedComparable[] {
  const subjectExternalId = externalId(subject);
  const subjectVin = canonicalVin(subject.vin);
  const withoutVin: GsaClosedComparable[] = [];
  const byVin = new Map<string, GsaClosedComparable>();
  for (const comp of comps) {
    if (comp.auctionId === subjectExternalId || comp.id === subject.id) continue;
    const vin = canonicalVin(comp.vin);
    if (subjectVin !== null && vin === subjectVin) continue;
    if (vin === null) {
      withoutVin.push(comp);
      continue;
    }
    const previous = byVin.get(vin);
    if (!previous || Date.parse(comp.endedAt) > Date.parse(previous.endedAt)) {
      byVin.set(vin, comp);
    }
  }
  return [...withoutVin, ...byVin.values()];
}

function preliminaryScore(
  subject: GsaMarketValuationSubject,
  comp: GsaClosedComparable,
  familyMatch: boolean,
  classMatch: boolean,
): number {
  const year = subject.year !== null && comp.year !== null
    ? Math.exp(-Math.abs(subject.year - comp.year) / 5)
    : 0.55;
  const mileage = ratioCloseness(subject.mileage, comp.mileage);
  const condition = Math.exp(
    -Math.abs(conditionScore(subject.condition) - conditionScore(comp.condition)) / 2.5,
  );
  const operability = Math.exp(
    -Math.abs(operabilityScore(subject.operability) - operabilityScore(comp.operability)) / 2,
  );
  const identity = familyMatch ? 1 : classMatch ? 0.58 : 0;
  return identity *
    (0.35 + year * 0.65) *
    (0.35 + mileage * 0.65) *
    (0.55 + condition * 0.45) *
    (0.75 + operability * 0.25);
}

function matchCandidates(
  subject: GsaMarketValuationSubject,
  comps: readonly GsaClosedComparable[],
  referenceYear: number,
) {
  const subjectFamily = canonicalVehicleFamily(subject);
  const subjectClass = classifyVehicle(subject);
  const candidates: Candidate[] = uniqueComparableRows(subject, comps)
    .map((comp) => {
    const comparableShape = {
      make: comp.make,
      modelLabel: comp.modelLabel,
      title: comp.title,
      bodyType: comp.bodyType,
    };
    const family = canonicalVehicleFamily(comparableShape);
    const vehicleClass = classifyVehicle(comparableShape);
    const familyMatch = subjectFamily !== null && family === subjectFamily;
    const classMatch = subjectClass !== null && vehicleClass === subjectClass;
    return {
      comp,
      family,
      vehicleClass,
      preliminaryScore: preliminaryScore(subject, comp, familyMatch, classMatch),
    };
    });

  const exact = candidates.filter(({ comp, family }) => {
    if (!subjectFamily || family !== subjectFamily) return false;
    const comparableClass = classifyVehicle({
      make: comp.make,
      modelLabel: comp.modelLabel,
      title: comp.title,
      bodyType: comp.bodyType,
    });
    return eligibleCandidate(
      subject,
      comp,
      subjectClass,
      comparableClass,
      referenceYear,
      "tight-family",
    );
  });
  // One or two close comps are more useful than a large set of remote rows.
  // Sample quantity affects confidence below; it must never force widening.
  if (exact.length > 0) {
    return { basis: "family-year-mileage" as const, candidates: exact, subjectFamily, subjectClass };
  }

  const family = candidates.filter((candidate) => {
    if (subjectFamily === null || candidate.family !== subjectFamily) return false;
    return eligibleCandidate(
      subject,
      candidate.comp,
      subjectClass,
      candidate.vehicleClass,
      referenceYear,
      "family",
    );
  });
  if (family.length > 0) {
    return { basis: "family" as const, candidates: family, subjectFamily, subjectClass };
  }

  const vehicleClass = DEFENSIBLE_BODY_CLASS_FALLBACKS.has(subjectClass ?? "")
    ? candidates.filter((candidate) =>
        candidate.vehicleClass === subjectClass && eligibleCandidate(
          subject,
          candidate.comp,
          subjectClass,
          candidate.vehicleClass,
          referenceYear,
          "body-class",
        )
      )
    : [];
  const distinctFamilies = new Set(
    vehicleClass.map((candidate) => candidate.family).filter((family) => family !== null),
  );
  if (
    vehicleClass.length >= MIN_BODY_CLASS_COMPARABLES &&
    distinctFamilies.size >= 2
  ) {
    return { basis: "body-class" as const, candidates: vehicleClass, subjectFamily, subjectClass };
  }
  return { basis: null, candidates: [], subjectFamily, subjectClass };
}

function weightedQuantile(
  samples: readonly { value: number; weight: number }[],
  quantile: number,
): number {
  const sorted = [...samples].sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  const target = total * quantile;
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.weight;
    if (cumulative >= target) return Math.round(sample.value);
  }
  return Math.round(sorted.at(-1)!.value);
}

function adjustmentDetail(
  subject: GsaMarketValuationSubject,
  family: string | null,
  vehicleClass: string | null,
  basis: GsaMarketMatchBasis | null,
): GsaMarketAdjustmentDetail {
  return {
    model: CALCULATION_VERSION,
    subjectInputs: {
      family,
      vehicleClass,
      year: subject.year,
      mileage: subject.mileage,
      condition: subject.condition,
      operability: subject.operability,
      disclosedIssueCount: (subject.damageFlags?.length ?? 0) + (subject.issueFlags?.length ?? 0),
    },
    parameters: {
      yearAnnualRate: 0.045,
      mileageElasticity: 0.28,
      conditionStepRate: 0.12,
      operabilityStepRate: 0.1,
      issueStepRate: 0.035,
    },
    notes: [
      "Subject auction bid is not an input to this valuation.",
      "Each comparable is adjusted toward the subject's year, mileage, condition, operability, and disclosed issue burden.",
      basis === "body-class"
        ? "Same-class fallback is a low-confidence auction benchmark, not an exact model valuation."
        : "Closed GSA high bids are auction-market evidence and are not confirmed award prices or retail appraisals.",
    ],
  };
}

function externalId(subject: GsaMarketValuationSubject): string {
  return subject.externalId?.trim() || subject.id.match(/(\d+)$/)?.[1] || subject.id;
}

function matchLabel(basis: GsaMarketMatchBasis): string {
  if (basis === "family-year-mileage") {
    return "Same vehicle family; year-banded, mileage-weighted, nearest mileage shown first";
  }
  if (basis === "family") {
    return "Same vehicle family; broader range, mileage-weighted, nearest mileage shown first";
  }
  return "Same vehicle class only; low-confidence auction benchmark";
}

function confidenceFor(
  basis: GsaMarketMatchBasis,
  samples: readonly GsaComparableAdjustment[],
): number {
  const cap = basis === "family-year-mileage" ? 0.82 : basis === "family" ? 0.58 : 0.25;
  const weightTotal = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const squaredWeightTotal = samples.reduce((sum, sample) => sum + sample.weight ** 2, 0);
  const effectiveSampleSize = squaredWeightTotal > 0
    ? weightTotal ** 2 / squaredWeightTotal
    : 0;
  const sampleFactor = 0.18 + 0.82 * (1 - Math.exp(-effectiveSampleSize / 4));
  const averageMatch = samples.reduce((sum, sample) => sum + sample.matchScore, 0) / samples.length;
  const quantileInput = samples.map((sample) => ({
    value: sample.adjustedHighBidCents,
    weight: sample.weight,
  }));
  const median = weightedQuantile(quantileInput, 0.5);
  const interquantileSpread = weightedQuantile(quantileInput, 0.8) -
    weightedQuantile(quantileInput, 0.2);
  const relativeSpread = median > 0 ? interquantileSpread / median : Number.POSITIVE_INFINITY;
  const dispersionFactor = clamp(1 - Math.max(0, relativeSpread - 0.45) * 0.55, 0.35, 1);
  const sparseCap = effectiveSampleSize < 1.5
    ? 0.28
    : effectiveSampleSize < 2.5
      ? 0.4
      : cap;
  return Number(Math.min(
    cap,
    sparseCap,
    cap * sampleFactor * (0.55 + averageMatch * 0.45) * dispersionFactor,
  ).toFixed(4));
}

/**
 * Builds an auction-market reference solely from historical closed GSA lots.
 * The subject type intentionally has no current-bid field, and the calculation
 * never floors, scales, or otherwise conditions its result on the subject bid.
 */
export function buildGsaMarketValuation(
  subject: GsaMarketValuationSubject,
  comps: readonly GsaClosedComparable[],
  asOf: Date | string,
): GsaMarketValuation {
  const timestamp = typeof asOf === "string" ? new Date(asOf) : asOf;
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("asOf must be a valid date.");
  const asOfIso = timestamp.toISOString();
  const match = matchCandidates(subject, comps, timestamp.getUTCFullYear());
  const detail = adjustmentDetail(subject, match.subjectFamily, match.subjectClass, match.basis);

  if (match.basis === null) {
    return {
      subjectAuctionId: subject.id,
      externalId: externalId(subject),
      status: "unavailable",
      provider: "Official GSA Auctions",
      valuationType: "auction-comp",
      currency: "USD",
      lowCents: null,
      medianCents: null,
      highCents: null,
      asOf: asOfIso,
      sampleSize: 0,
      confidence: 0,
      matchBasis: null,
      matchLabel: "No defensible GSA vehicle-class match",
      family: match.subjectFamily,
      vehicleClass: match.subjectClass,
      sourceUrls: [GSA_PPMS_CATALOG_ENDPOINT],
      sampleIds: [],
      adjustmentDetail: detail,
      comparables: [],
      provenanceNote: "No same-family or defensible same-class closed GSA high bid was found in the selected corpus.",
    };
  }

  const rankedCandidates = [...match.candidates]
    .sort((left, right) => right.preliminaryScore - left.preliminaryScore);
  const selected = rankedCandidates.slice(0, MAX_COMPARABLES);
  const samples = selected.map(({ comp, preliminaryScore }): GsaComparableAdjustment => {
    const yearFactor = subject.year !== null && comp.year !== null
      ? clamp(Math.exp((subject.year - comp.year) * 0.045), 0.7, 1.4)
      : 1;
    const mileageFactor = subject.mileage && comp.mileage
      ? clamp(Math.pow(comp.mileage / subject.mileage, 0.28), 0.65, 1.45)
      : 1;
    const conditionFactor = clamp(
      Math.exp((conditionScore(subject.condition) - conditionScore(comp.condition)) * 0.12),
      0.72,
      1.35,
    );
    const operabilityFactor = clamp(
      Math.exp((operabilityScore(subject.operability) - operabilityScore(comp.operability)) * 0.1),
      0.75,
      1.3,
    );
    const subjectIssues = (subject.damageFlags?.length ?? 0) + (subject.issueFlags?.length ?? 0);
    const comparableIssues = comp.damageFlags.length + comp.issueFlags.length;
    const issueFactor = clamp(Math.exp((comparableIssues - subjectIssues) * 0.035), 0.8, 1.25);
    const totalFactor = clamp(
      yearFactor * mileageFactor * conditionFactor * operabilityFactor * issueFactor,
      0.45,
      1.8,
    );
    const endedAgeDays = Math.max(0, (timestamp.getTime() - Date.parse(comp.endedAt)) / 86_400_000);
    const recencyWeight = Math.exp(-endedAgeDays / 365);
    const basisWeight = match.basis === "family-year-mileage" ? 1 : match.basis === "family" ? 0.78 : 0.48;
    const weight = Math.max(0.01, basisWeight * preliminaryScore * recencyWeight);
    return {
      sampleId: comp.id,
      auctionId: comp.auctionId,
      sourceUrl: comp.sourceUrl,
      title: comp.title,
      vin: canonicalVin(comp.vin),
      endedAt: comp.endedAt,
      year: comp.year,
      mileage: comp.mileage,
      mileageDifference: subject.mileage !== null && comp.mileage !== null
        ? Math.abs(subject.mileage - comp.mileage)
        : null,
      mileageCloseness: Number(ratioCloseness(subject.mileage, comp.mileage).toFixed(4)),
      condition: comp.condition,
      rawClosedHighBidCents: comp.closedHighBidCents,
      adjustedHighBidCents: Math.max(1, Math.round(comp.closedHighBidCents * totalFactor)),
      weight: Number(weight.toFixed(6)),
      matchScore: Number(clamp(preliminaryScore, 0, 1).toFixed(4)),
      factors: {
        year: Number(yearFactor.toFixed(4)),
        mileage: Number(mileageFactor.toFixed(4)),
        condition: Number(conditionFactor.toFixed(4)),
        operability: Number(operabilityFactor.toFixed(4)),
        disclosedIssues: Number(issueFactor.toFixed(4)),
      },
    };
  });
  const quantileInput = samples.map((sample) => ({
    value: sample.adjustedHighBidCents,
    weight: sample.weight,
  }));
  // Keep the closest reported mileage visible first. The valuation itself
  // still uses every selected sample with year, mileage, condition, issue, and
  // recency weights; this ordering makes the nearest available odometer match
  // explicit when an identical-mileage comparable does not exist.
  const publishedSamples = [...samples]
    .sort((left, right) => {
      if (subject.mileage !== null) {
        const leftDifference = left.mileageDifference ?? Number.POSITIVE_INFINITY;
        const rightDifference = right.mileageDifference ?? Number.POSITIVE_INFINITY;
        if (leftDifference !== rightDifference) return leftDifference - rightDifference;
      }
      return right.matchScore - left.matchScore ||
        Date.parse(right.endedAt) - Date.parse(left.endedAt);
    })
    .slice(0, MAX_PUBLISHED_SAMPLES);

  return {
    subjectAuctionId: subject.id,
    externalId: externalId(subject),
    status: "available",
    provider: "Official GSA Auctions",
    valuationType: "auction-comp",
    currency: "USD",
    lowCents: weightedQuantile(quantileInput, 0.2),
    medianCents: weightedQuantile(quantileInput, 0.5),
    highCents: weightedQuantile(quantileInput, 0.8),
    asOf: asOfIso,
    sampleSize: samples.length,
    confidence: confidenceFor(match.basis, samples),
    matchBasis: match.basis,
    matchLabel: matchLabel(match.basis),
    family: match.subjectFamily,
    vehicleClass: match.subjectClass,
    sourceUrls: [
      GSA_PPMS_CATALOG_ENDPOINT,
      ...publishedSamples.map((sample) => sample.sourceUrl),
    ],
    sampleIds: publishedSamples.map((sample) => sample.sampleId),
    adjustmentDetail: detail,
    comparables: publishedSamples,
    provenanceNote: match.basis === "body-class"
      ? "Low-confidence estimate from similar-class official GSA closed high bids; it is not an exact-model or retail value."
      : "Mileage-, year-, and condition-adjusted official GSA closed high bids; high bids are not confirmed awards.",
  };
}

export function buildGsaMarketValuationSnapshot(
  subjects: readonly GsaMarketValuationSubject[],
  comps: readonly GsaClosedComparable[],
  options: { generatedAt: Date | string; corpus: GsaClosedCompCoverage },
): GsaMarketValuationSnapshot {
  const generatedAt = typeof options.generatedAt === "string"
    ? new Date(options.generatedAt)
    : options.generatedAt;
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new TypeError("generatedAt must be a valid date.");
  }
  const generatedAtIso = generatedAt.toISOString();
  const valuations = subjects.map((subject) =>
    buildGsaMarketValuation(subject, comps, generatedAtIso)
  );
  const basisCounts: Record<GsaMarketMatchBasis, number> = {
    "family-year-mileage": 0,
    family: 0,
    "body-class": 0,
  };
  for (const valuation of valuations) {
    if (valuation.matchBasis !== null) basisCounts[valuation.matchBasis] += 1;
  }
  const valuedCount = valuations.filter((valuation) => valuation.status === "available").length;
  return {
    schemaVersion: 1,
    generatedAt: generatedAtIso,
    calculationVersion: CALCULATION_VERSION,
    source: {
      provider: "U.S. General Services Administration",
      official: true,
      dataKind: "closed-high-bid-comparables",
      catalogUrl: GSA_PPMS_CATALOG_ENDPOINT,
      semantics: "Numeric references are weighted closed GSA high bids, not confirmed award prices or retail appraisals.",
    },
    corpus: options.corpus,
    coverage: {
      subjectCount: subjects.length,
      valuedCount,
      unavailableCount: subjects.length - valuedCount,
      basisCounts,
    },
    valuations,
  };
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

/** Validates an exported snapshot before it is published or loaded at runtime. */
export function validateGsaMarketValuationSnapshot(
  value: unknown,
): GsaMarketValuationSnapshot {
  const snapshot = record(value);
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.calculationVersion !== CALCULATION_VERSION) {
    throw new TypeError("Unsupported GSA market-valuation snapshot schema.");
  }
  if (!Number.isFinite(Date.parse(String(snapshot.generatedAt)))) {
    throw new TypeError("The GSA market-valuation snapshot has an invalid generatedAt value.");
  }
  if (containsSubjectBidKey(snapshot)) {
    throw new TypeError("Subject bid fields are forbidden in the GSA market-valuation snapshot.");
  }
  if (!Array.isArray(snapshot.valuations)) {
    throw new TypeError("The GSA market-valuation snapshot is missing valuations.");
  }
  const ids = new Set<string>();
  for (const value of snapshot.valuations) {
    const valuation = record(value);
    if (!valuation || typeof valuation.subjectAuctionId !== "string" || ids.has(valuation.subjectAuctionId)) {
      throw new TypeError("The GSA market-valuation snapshot contains an invalid or duplicate subject id.");
    }
    ids.add(valuation.subjectAuctionId);
    if (!Number.isFinite(Date.parse(String(valuation.asOf)))) {
      throw new TypeError("A GSA market valuation has an invalid asOf value.");
    }
    if (valuation.status === "available") {
      const low = valuation.lowCents;
      const median = valuation.medianCents;
      const high = valuation.highCents;
      if (
        !Number.isSafeInteger(low) || !Number.isSafeInteger(median) || !Number.isSafeInteger(high) ||
        Number(low) <= 0 || Number(low) > Number(median) || Number(median) > Number(high)
      ) {
        throw new TypeError("A GSA market valuation has an invalid numeric range.");
      }
      if (
        typeof valuation.confidence !== "number" || valuation.confidence <= 0 ||
        valuation.confidence > 1 || !Array.isArray(valuation.sampleIds) ||
        valuation.sampleIds.length === 0
      ) {
        throw new TypeError("A GSA market valuation has invalid evidence metadata.");
      }
    } else if (
      valuation.status !== "unavailable" || valuation.lowCents !== null ||
      valuation.medianCents !== null || valuation.highCents !== null
    ) {
      throw new TypeError("A GSA market valuation has an invalid status.");
    }
  }
  const coverage = record(snapshot.coverage);
  if (
    !coverage || coverage.subjectCount !== snapshot.valuations.length ||
    Number(coverage.valuedCount) + Number(coverage.unavailableCount) !== snapshot.valuations.length
  ) {
    throw new TypeError("The GSA market-valuation snapshot coverage is inconsistent.");
  }
  return snapshot as unknown as GsaMarketValuationSnapshot;
}
