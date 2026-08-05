import type {
  AuctionOpportunity,
  DealAssessment,
  ValuationReference,
  VehicleSnapshot,
} from "./auction-types.ts";
import {
  buildReferenceClosingForecast,
  type ReferenceClosingOutcome,
} from "./closing-forecast.ts";
import {
  assessDeal,
  DEFAULT_DEAL_COSTS,
  DEFAULT_PROFIT_TARGET,
} from "./deal-model.ts";
import type { GsaClosedComparable } from "./gsa-closed-comps.ts";
import {
  GSA_FLEET_BROWSE_URL,
  type GsaFleetVehicleDetail,
  type GsaFleetVehicleRecord,
} from "./gsa-fleet-client.ts";
import {
  buildGsaMarketValuation,
  canonicalVehicleFamily,
  classifyVehicle,
  type GsaMarketValuationSubject,
} from "./gsa-market-valuations.ts";

const FLEET_PROVIDER = "Official GSA Fleet awarded-sale comps";

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
    warnings: [...assessment.warnings, "A current online bid is not available."],
    reasonCodes: [...assessment.reasonCodes, "CURRENT_BID_UNAVAILABLE"],
  };
}

export interface GsaFleetComparableIndex {
  all: readonly GsaClosedComparable[];
  byFamily: ReadonlyMap<string, readonly GsaClosedComparable[]>;
  byClass: ReadonlyMap<string, readonly GsaClosedComparable[]>;
}

export interface GsaFleetValuationResult {
  valuation: ValuationReference;
  terminalOutcomes: readonly ReferenceClosingOutcome[];
}

function titleCase(value: string | null, fallback: string): string {
  const clean = value?.trim();
  if (!clean) return fallback;
  if (clean !== clean.toUpperCase()) return clean;
  return clean.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** Normalizes frequent Fleet abbreviations only where the identity is clear. */
export function normalizeGsaFleetModel(value: string | null): string | null {
  const clean = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!clean) return null;
  const compact = clean.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (/^(?:GRCHEROKEE|GRANDCHEROK|GRANDCHEROKEE)$/.test(compact)) {
    return "Grand Cherokee";
  }
  if (/^ECONOLINEE?350$/.test(compact)) return "E-350";
  return titleCase(clean, clean);
}

function opportunityTitle(row: GsaFleetVehicleRecord): string {
  const year = row.year ?? 0;
  const make = titleCase(row.make, "Make pending");
  const model = normalizeGsaFleetModel(row.model) ?? "Model pending";
  return `${year || "Year pending"} ${make} ${model}`;
}

function subjectFor(row: GsaFleetVehicleRecord): GsaMarketValuationSubject {
  return {
    id: `fleet-${row.sourceId}`,
    externalId: row.externalKey,
    sourceUrl: row.sourceUrl,
    title: opportunityTitle(row),
    year: row.year,
    make: row.make,
    modelLabel: normalizeGsaFleetModel(row.model),
    vin: row.vin,
    mileage: row.mileage,
    bodyType: row.vehicleType,
    condition: "unknown",
    operability: "unknown",
  };
}

function pushIndex(
  index: Map<string, GsaClosedComparable[]>,
  key: string | null,
  comparable: GsaClosedComparable,
): void {
  if (!key) return;
  const rows = index.get(key) ?? [];
  rows.push(comparable);
  index.set(key, rows);
}

/** Converts only authoritative Sold/Awarded Fleet outcomes into comp rows. */
export function gsaFleetClosedComparable(
  row: GsaFleetVehicleRecord,
): GsaClosedComparable | null {
  if (!row.isComparableOutcome || row.finalPriceCents === null || row.finalPriceCents <= 0) {
    return null;
  }
  const endedAt = row.effectiveEndsAt ?? row.endsAt;
  if (!endedAt) return null;
  return {
    id: `gsa-fleet:${row.sourceId}`,
    auctionId: row.sourceId,
    lotId: row.saleRunNumber ?? row.vin ?? row.sourceId,
    sourceUrl: row.sourceUrl,
    title: opportunityTitle(row),
    closedHighBidCents: row.finalPriceCents,
    bidderCount: null,
    endedAt,
    year: row.year,
    make: row.make,
    modelLabel: normalizeGsaFleetModel(row.model),
    vin: row.vin,
    mileage: row.mileage,
    bodyType: row.vehicleType,
    condition: "unknown",
    operability: "unknown",
    damageFlags: [],
    issueFlags: [],
    city: row.location.city,
    state: row.location.state,
    detailEnriched: false,
  };
}

export function buildGsaFleetComparableIndex(
  rows: readonly GsaFleetVehicleRecord[],
): GsaFleetComparableIndex {
  const all = rows.flatMap((row) => {
    const comparable = gsaFleetClosedComparable(row);
    return comparable ? [comparable] : [];
  });
  const byFamily = new Map<string, GsaClosedComparable[]>();
  const byClass = new Map<string, GsaClosedComparable[]>();
  for (const comparable of all) {
    const shape = {
      make: comparable.make,
      modelLabel: comparable.modelLabel,
      title: comparable.title,
      bodyType: comparable.bodyType,
    };
    pushIndex(byFamily, canonicalVehicleFamily(shape), comparable);
    pushIndex(byClass, classifyVehicle(shape), comparable);
  }
  return { all, byFamily, byClass };
}

export function gsaFleetComparableCandidatesForSubject(
  subject: GsaMarketValuationSubject,
  index: GsaFleetComparableIndex,
): readonly GsaClosedComparable[] {
  const family = canonicalVehicleFamily(subject);
  const vehicleClass = classifyVehicle(subject);
  function nearby(
    comparable: GsaClosedComparable,
    mode: "family" | "class",
  ): boolean {
    if (subject.year !== null) {
      if (comparable.year === null) return false;
      if (Math.abs(subject.year - comparable.year) > (mode === "family" ? 5 : 2)) {
        return false;
      }
    }
    if (subject.mileage === null) return mode === "family";
    if (comparable.mileage === null) return false;
    const difference = Math.abs(subject.mileage - comparable.mileage);
    const maximum = mode === "family"
      ? Math.max(40_000, subject.mileage * 0.75)
      : Math.max(15_000, subject.mileage * 0.35);
    return difference <= maximum;
  }
  function ranked(values: readonly GsaClosedComparable[], mode: "family" | "class") {
    return values
      .filter((comparable) => nearby(comparable, mode))
      .sort((left, right) => {
        const leftYear = subject.year === null || left.year === null
          ? 0
          : Math.abs(subject.year - left.year);
        const rightYear = subject.year === null || right.year === null
          ? 0
          : Math.abs(subject.year - right.year);
        const leftMileage = subject.mileage === null || left.mileage === null
          ? 0
          : Math.abs(subject.mileage - left.mileage);
        const rightMileage = subject.mileage === null || right.mileage === null
          ? 0
          : Math.abs(subject.mileage - right.mileage);
        return leftYear - rightYear || leftMileage - rightMileage ||
          Date.parse(right.endedAt) - Date.parse(left.endedAt);
      })
      .slice(0, 200);
  }

  // A known family should never be diluted by thousands of merely same-class
  // rows. Only fall back to class when no nearby family outcome exists.
  const familyRows = family ? ranked(index.byFamily.get(family) ?? [], "family") : [];
  if (familyRows.length) return familyRows;
  if (!vehicleClass || subject.mileage === null) return [];
  return ranked(index.byClass.get(vehicleClass) ?? [], "class");
}

export function gsaFleetComparableCandidates(
  row: GsaFleetVehicleRecord,
  index: GsaFleetComparableIndex,
): readonly GsaClosedComparable[] {
  return gsaFleetComparableCandidatesForSubject(subjectFor(row), index);
}

function unavailableValuation(asOf: string): ValuationReference {
  return {
    status: "unavailable",
    provider: FLEET_PROVIDER,
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: null,
    medianCents: null,
    highCents: null,
    asOf,
    confidence: 0,
    sampleSize: 0,
    sourceUrl: GSA_FLEET_BROWSE_URL,
    provenanceNote:
      "No Fleet outcome passed the vehicle-family, year, mileage, class, condition, and relist guardrails for this vehicle.",
  };
}

export function buildGsaFleetOutcomeValuation(
  subject: GsaMarketValuationSubject,
  candidates: readonly GsaClosedComparable[],
  asOf: string,
): GsaFleetValuationResult {
  const modeled = buildGsaMarketValuation(subject, candidates, asOf);
  if (modeled.status === "unavailable") {
    return { valuation: unavailableValuation(asOf), terminalOutcomes: [] };
  }
  const nearest = modeled.comparables[0];
  const valuation: ValuationReference = {
    status: "reference-only",
    provider: FLEET_PROVIDER,
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: modeled.lowCents,
    medianCents: modeled.medianCents,
    highCents: modeled.highCents,
    asOf: modeled.asOf,
    confidence: modeled.confidence,
    sampleSize: modeled.sampleSize,
    sourceUrl: nearest?.sourceUrl ?? GSA_FLEET_BROWSE_URL,
    provenanceNote:
      `Mileage-, year-, condition-, and class-guarded reference from ${modeled.sampleSize} official GSA Fleet Sold/Awarded outcome${modeled.sampleSize === 1 ? "" : "s"}. ` +
      "Winning-bid or sale-proceeds amounts are used only when the official vehicle outcome is Sold or Awarded.",
    evidence: {
      rawLowCents: modeled.lowCents,
      rawMedianCents: modeled.medianCents,
      rawHighCents: modeled.highCents,
      inputMileage: subject.mileage,
      comparableMedianMileage: nearest?.mileage ?? null,
      mileageAdjustmentCents: nearest
        ? nearest.adjustedHighBidCents - nearest.rawClosedHighBidCents
        : null,
      conditionAdjustmentCents: null,
      conditionAdjustmentPct: null,
      conditionBasis: "GSA Fleet condition codes are displayed but not inferred without an official public mapping.",
      matchBasis: `${modeled.matchLabel}; official GSA Fleet Sold/Awarded outcomes`,
    },
  };
  const terminalOutcomes: ReferenceClosingOutcome[] = modeled.comparables.map((comparable) => ({
    id: comparable.sampleId,
    adjustedCloseCents: comparable.adjustedHighBidCents,
    matchScore: comparable.matchScore,
    weight: comparable.weight,
    exactModel: modeled.matchBasis === "family-year-mileage" && comparable.matchScore >= 0.85,
  }));
  return { valuation, terminalOutcomes };
}

export function buildGsaFleetValuation(
  row: GsaFleetVehicleRecord,
  candidates: readonly GsaClosedComparable[],
  asOf = row.observedAt,
): GsaFleetValuationResult {
  return buildGsaFleetOutcomeValuation(subjectFor(row), candidates, asOf);
}

function detailRiskFlags(
  row: GsaFleetVehicleRecord,
  detail?: GsaFleetVehicleDetail | null,
): string[] {
  const flags = [
    ...(row.conditionCode
      ? [`GSA Fleet condition code ${row.conditionCode} — verify the official condition report`]
      : ["Condition code not reported by GSA Fleet"]),
    ...(row.mileage === null ? ["Mileage not reported by GSA Fleet"] : []),
    ...(detail?.openRecallCount
      ? [`${detail.openRecallCount} open recall${detail.openRecallCount === 1 ? "" : "s"} reported`]
      : []),
    ...(detail?.comments?.trim()
      ? [detail.comments.trim().replace(/\s+/g, " ").slice(0, 500)]
      : []),
  ];
  return [...new Set(flags)];
}

function vehicleSnapshot(
  row: GsaFleetVehicleRecord,
  detail?: GsaFleetVehicleDetail | null,
): VehicleSnapshot {
  return {
    year: row.year ?? 0,
    make: titleCase(row.make, "Make pending"),
    model: normalizeGsaFleetModel(row.model) ?? "Model pending",
    trim: detail?.series ?? undefined,
    vin: row.vin ?? undefined,
    mileage: row.mileage ?? undefined,
    odometerStatus: row.mileage === null ? "not-reported" : "reported-not-verified",
    bodyStyle: detail?.bodyStyle ?? row.vehicleType ?? undefined,
    transmission: detail?.transmission ?? undefined,
    fuelType: detail?.fuelType ?? row.fuelType ?? undefined,
    drivetrain: detail?.drivetrain ?? undefined,
    color: detail?.color ?? undefined,
    condition: "unknown",
    operability: "unknown",
    description: detail?.comments?.trim() ||
      `${row.channel === "live" ? "Scheduled in-person" : "Internet"} GSA Fleet sale through ${row.location.vendorName ?? "the listed vendor"}. Review the official condition report and listing before bidding.`,
    riskFlags: detailRiskFlags(row, detail),
  };
}

function boardStatus(row: GsaFleetVehicleRecord): AuctionOpportunity["status"] {
  if (row.channel === "internet" && row.phase === "active") return "active";
  if (row.phase === "ended" || row.phase === "closed") return "ended";
  return "preview";
}

export function gsaFleetListingToOpportunity(
  row: GsaFleetVehicleRecord,
  candidates: readonly GsaClosedComparable[],
  detail?: GsaFleetVehicleDetail | null,
): AuctionOpportunity {
  const { valuation, terminalOutcomes } = buildGsaFleetValuation(
    row,
    candidates,
    row.observedAt,
  );
  const currentBidCents = row.channel === "internet"
    ? detail?.highBidCents ?? row.highBidCents
    : null;
  const effectiveEndsAt = detail?.effectiveEndsAt ?? row.effectiveEndsAt;
  const images = [...new Set([...(detail?.images ?? []), ...row.images].filter(Boolean))];
  const forecast = buildReferenceClosingForecast({
    currentBidCents,
    bidderCount: null,
    endsAt: effectiveEndsAt,
    asOf: row.observedAt,
    valuation,
    terminalOutcomes,
  });
  const vehicle = vehicleSnapshot(row, detail);
  const listingConfidence = row.vin && row.mileage !== null ? 0.65 : 0.4;
  return {
    id: `fleet-${row.sourceId}`,
    externalId: row.externalKey,
    saleLotNumber:
      [row.saleNumber, row.saleRunNumber ? `Run ${row.saleRunNumber}` : null]
        .filter(Boolean).join(" · ") || row.vin || row.sourceId,
    source: "gsa-fleet",
    title: opportunityTitle(row),
    sourceUrl: row.sourceUrl,
    imageUrl: images[0] ?? "",
    images,
    imageSource: "gsa-fleet",
    status: boardStatus(row),
    startsAt: detail?.startsAt ?? row.startsAt,
    saleNumber: detail?.saleNumber ?? row.saleNumber,
    saleType: row.channel,
    onlineBidding: row.channel === "internet",
    currentBidCents,
    bidderCount: null,
    endsAt: effectiveEndsAt,
    lastCheckedAt: row.observedAt,
    location: {
      city: row.location.city ?? "Location pending",
      state: row.location.state ?? "—",
      postalCode: row.location.postalCode ?? "",
      address: row.location.vendorName ?? undefined,
    },
    vehicle,
    valuation,
    forecast,
    assessment: requireObservedBid(assessDeal({
      currentBidCents: currentBidCents ?? 0,
      valuation,
      forecast,
      costs: DEFAULT_DEAL_COSTS,
      target: DEFAULT_PROFIT_TARGET,
      calculatedAt: row.observedAt,
      dataConfidence: listingConfidence,
    }), currentBidCents),
    provenance: {
      listing: "Official GSA Fleet Marketplace",
      listingObservedAt: row.observedAt,
      valuation: valuation.status === "unavailable" ? "unavailable" : "provider",
    },
  };
}
