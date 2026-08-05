import type {
  ClosingForecast,
  DealAssessment,
  DealCostBreakdown,
  ValuationReference,
} from "./auction-types";

const SCORE_MAX = 100;
const DEFAULT_MINIMUM_SAMPLE_SIZE = 5;

export interface DealCostInputs {
  buyerPremiumRate: number;
  purchaseTaxRate: number;
  sellingFeeRate: number;
  transportCents: number;
  titleRegistrationCents: number;
  inspectionCents: number;
  repairsCents: number;
  storageCents: number;
  riskReserveCents: number;
}

export interface ProfitTarget {
  minimumProfitCents: number;
  targetMarginRate: number;
}

export interface DealModelInput {
  currentBidCents: number;
  valuation: ValuationReference;
  forecast: ClosingForecast;
  costs: DealCostInputs;
  target: ProfitTarget;
  calculatedAt: string;
  /** Independent confidence in listing completeness, from 0 through 1. */
  dataConfidence?: number;
}

export interface ComparableOutcome {
  id: string;
  finalPriceCents: number;
  /** Similarity to the subject vehicle, from 0 through 1. */
  matchScore?: number;
  /** Price at the same time-to-close as the subject auction. */
  bidAtComparableTimeCents?: number;
}

export interface ForecastModelInput {
  currentBidCents: number;
  asOf: string;
  outcomes: readonly ComparableOutcome[];
  minimumSampleSize?: number;
  modelVersion?: string;
}

export const DEFAULT_DEAL_COSTS: Readonly<DealCostInputs> = {
  buyerPremiumRate: 0,
  purchaseTaxRate: 0,
  sellingFeeRate: 0.08,
  transportCents: 85_000,
  titleRegistrationCents: 22_500,
  inspectionCents: 17_500,
  repairsCents: 0,
  storageCents: 0,
  riskReserveCents: 75_000,
};

export const DEFAULT_PROFIT_TARGET: Readonly<ProfitTarget> = {
  minimumProfitCents: 150_000,
  targetMarginRate: 0.12,
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const asMoney = (value: number, field: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite, non-negative number`);
  }

  return Math.round(value);
};

const asRate = (value: number, field: string) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be between 0 and 1`);
  }

  return value;
};

const normalizeCostInputs = (costs: DealCostInputs): DealCostInputs => ({
  buyerPremiumRate: asRate(costs.buyerPremiumRate, "buyerPremiumRate"),
  purchaseTaxRate: asRate(costs.purchaseTaxRate, "purchaseTaxRate"),
  sellingFeeRate: asRate(costs.sellingFeeRate, "sellingFeeRate"),
  transportCents: asMoney(costs.transportCents, "transportCents"),
  titleRegistrationCents: asMoney(
    costs.titleRegistrationCents,
    "titleRegistrationCents",
  ),
  inspectionCents: asMoney(costs.inspectionCents, "inspectionCents"),
  repairsCents: asMoney(costs.repairsCents, "repairsCents"),
  storageCents: asMoney(costs.storageCents, "storageCents"),
  riskReserveCents: asMoney(costs.riskReserveCents, "riskReserveCents"),
});

/**
 * Calculates transaction costs for one possible winning bid. The exit value is
 * supplied separately because seller fees are based on resale proceeds, not on
 * the auction bid.
 */
export function calculateCostBreakdown(
  purchaseBidCents: number,
  exitValueCents: number,
  inputCosts: DealCostInputs,
): DealCostBreakdown {
  const bid = asMoney(purchaseBidCents, "purchaseBidCents");
  const exitValue = asMoney(exitValueCents, "exitValueCents");
  const costs = normalizeCostInputs(inputCosts);
  const buyerPremiumCents = Math.round(bid * costs.buyerPremiumRate);
  const purchaseTaxCents = Math.round(
    (bid + buyerPremiumCents) * costs.purchaseTaxRate,
  );
  const sellingFeesCents = Math.round(exitValue * costs.sellingFeeRate);
  const totalAcquisitionCents =
    bid +
    buyerPremiumCents +
    purchaseTaxCents +
    costs.transportCents +
    costs.titleRegistrationCents +
    costs.inspectionCents +
    costs.repairsCents +
    costs.storageCents +
    costs.riskReserveCents;
  const totalExitCostsCents = sellingFeesCents;

  return {
    purchaseBidCents: bid,
    buyerPremiumCents,
    purchaseTaxCents,
    transportCents: costs.transportCents,
    titleRegistrationCents: costs.titleRegistrationCents,
    inspectionCents: costs.inspectionCents,
    repairsCents: costs.repairsCents,
    storageCents: costs.storageCents,
    sellingFeesCents,
    riskReserveCents: costs.riskReserveCents,
    totalAcquisitionCents,
    totalExitCostsCents,
    totalAllInCents: totalAcquisitionCents + totalExitCostsCents,
  };
}

function maximumBidForProfit(
  conservativeValueCents: number,
  inputCosts: DealCostInputs,
  requiredProfitCents: number,
) {
  const value = asMoney(conservativeValueCents, "conservativeValueCents");
  const requiredProfit = asMoney(requiredProfitCents, "requiredProfitCents");

  let low = 0;
  let high = value;
  let answer = -1;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const profit =
      value - calculateCostBreakdown(candidate, value, inputCosts).totalAllInCents;

    if (profit >= requiredProfit) {
      answer = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return Math.max(0, answer);
}

/** The highest purchase bid that still meets the requested profit target. */
export function calculateSafeMaxBid(
  conservativeValueCents: number,
  costs: DealCostInputs,
  target: ProfitTarget,
) {
  const value = asMoney(conservativeValueCents, "conservativeValueCents");
  const minimumProfit = asMoney(
    target.minimumProfitCents,
    "minimumProfitCents",
  );
  const targetMargin = asRate(target.targetMarginRate, "targetMarginRate");
  const requiredProfit = Math.max(
    minimumProfit,
    Math.round(value * targetMargin),
  );

  return maximumBidForProfit(value, costs, requiredProfit);
}

/** The highest purchase bid that does not lose money under the cost model. */
export function calculateBreakEvenBid(
  conservativeValueCents: number,
  costs: DealCostInputs,
) {
  return maximumBidForProfit(conservativeValueCents, costs, 0);
}

function quantile(sorted: readonly number[], percentile: number) {
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;

  return Math.round(
    sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight,
  );
}

/**
 * Creates a close-price range from verified closed-auction outcomes. Vehicle
 * value never enters this function: a forecast describes bidder behavior, not
 * the asset's appraisal.
 */
export function buildClosingForecast(input: ForecastModelInput): ClosingForecast {
  const currentBid = asMoney(input.currentBidCents, "currentBidCents");
  const minimumSampleSize = Math.max(
    2,
    Math.round(input.minimumSampleSize ?? DEFAULT_MINIMUM_SAMPLE_SIZE),
  );
  const modelVersion = input.modelVersion ?? "gsa-close-comps-v1";
  const deduplicated = new Map<string, ComparableOutcome>();

  for (const outcome of input.outcomes) {
    if (
      outcome.id.trim() &&
      Number.isFinite(outcome.finalPriceCents) &&
      outcome.finalPriceCents > 0
    ) {
      deduplicated.set(outcome.id, outcome);
    }
  }

  const outcomes = [...deduplicated.values()];
  const evidenceIds = outcomes.map(({ id }) => id);
  const exactModelCount = outcomes.filter(
    ({ matchScore }) => (matchScore ?? 0) >= 0.9,
  ).length;
  const curveCount = outcomes.filter(
    ({ bidAtComparableTimeCents }) =>
      Number.isFinite(bidAtComparableTimeCents) &&
      (bidAtComparableTimeCents ?? 0) > 0,
  ).length;

  if (outcomes.length < minimumSampleSize) {
    return {
      status: "insufficient",
      lowCents: null,
      expectedCents: null,
      highCents: null,
      asOf: input.asOf,
      modelVersion,
      method: "Verified closed GSA comparable outcomes",
      confidence: 0,
      sampleSize: outcomes.length,
      exactModelCount,
      curveCount,
      evidenceIds,
      provenance: "insufficient",
      reasonCodes: [
        outcomes.length === 0
          ? "NO_CLOSED_GSA_COMPS"
          : "INSUFFICIENT_CLOSED_GSA_COMPS",
      ],
    };
  }

  const estimates = outcomes
    .map((outcome) => {
      const comparableBid = outcome.bidAtComparableTimeCents;
      const estimate =
        comparableBid && comparableBid > 0
          ? currentBid * (outcome.finalPriceCents / comparableBid)
          : outcome.finalPriceCents;

      return Math.max(currentBid, Math.round(estimate));
    })
    .sort((left, right) => left - right);
  const averageMatch =
    outcomes.reduce(
      (sum, outcome) => sum + clamp(outcome.matchScore ?? 0.65, 0, 1),
      0,
    ) / outcomes.length;
  const sampleConfidence = clamp(outcomes.length / 20, 0, 1);
  const curveCoverage = curveCount / outcomes.length;
  const confidence = clamp(
    averageMatch * 0.55 + sampleConfidence * 0.3 + curveCoverage * 0.15,
    0,
    0.95,
  );

  return {
    status: "available",
    lowCents: quantile(estimates, 0.2),
    expectedCents: quantile(estimates, 0.5),
    highCents: quantile(estimates, 0.8),
    asOf: input.asOf,
    modelVersion,
    method:
      curveCount > 0
        ? "Time-matched bid curves and verified closed GSA comparables"
        : "Verified closed GSA comparable outcomes",
    confidence: Number(confidence.toFixed(4)),
    sampleSize: outcomes.length,
    exactModelCount,
    curveCount,
    evidenceIds,
    provenance: "historical-gsa",
    reasonCodes: [],
  };
}

/** Piecewise-linear CDF over a forecast's low, expected, and high points. */
export function probabilityAtOrBelow(
  forecast: ClosingForecast,
  thresholdCents: number,
): number | null {
  const { lowCents, expectedCents, highCents } = forecast;

  if (
    lowCents === null ||
    expectedCents === null ||
    highCents === null ||
    lowCents > expectedCents ||
    expectedCents > highCents
  ) {
    return null;
  }

  const threshold = asMoney(thresholdCents, "thresholdCents");
  if (threshold < lowCents) return 0;
  if (threshold >= highCents) return 1;

  if (threshold <= expectedCents) {
    if (expectedCents === lowCents) return 0.5;
    return (0.5 * (threshold - lowCents)) / (expectedCents - lowCents);
  }

  if (highCents === expectedCents) return 1;
  return (
    0.5 +
    (0.5 * (threshold - expectedCents)) / (highCents - expectedCents)
  );
}

function assessmentTier(status: DealAssessment["status"], score: number) {
  if (status === "actionable" && score >= 75) return 1 as const;
  if ((status === "actionable" || status === "watch") && score >= 55) {
    return 2 as const;
  }
  if (status === "watch" && score >= 30) return 3 as const;
  return 4 as const;
}

/**
 * Ranks an opportunity from an independent value, an independent closing-price
 * forecast, and explicit transaction costs. Reference-only seed values can
 * never produce an actionable recommendation.
 */
export function assessDeal(input: DealModelInput): DealAssessment {
  const currentBid = asMoney(input.currentBidCents, "currentBidCents");
  const conservativeValue =
    input.valuation.status !== "unavailable" &&
    input.valuation.lowCents !== null &&
    input.valuation.lowCents > 0
      ? Math.round(input.valuation.lowCents)
      : null;
  const expectedClose =
    input.forecast.status !== "insufficient" &&
    input.forecast.expectedCents !== null &&
    input.forecast.expectedCents >= currentBid
      ? Math.round(input.forecast.expectedCents)
      : null;
  const currentCosts = calculateCostBreakdown(
    currentBid,
    conservativeValue ?? 0,
    input.costs,
  );
  const warnings: string[] = [];
  const reasonCodes: string[] = [];

  if (conservativeValue === null) {
    warnings.push("No independently sourced valuation is available.");
    reasonCodes.push("VALUATION_UNAVAILABLE");
  } else if (input.valuation.status === "reference-only") {
    warnings.push(
      "The displayed value is an unlicensed planning reference, not KBB or a provider appraisal.",
    );
    reasonCodes.push("REFERENCE_ONLY_VALUATION");
  }

  if (input.forecast.status === "insufficient") {
    warnings.push("There are not enough verified GSA outcomes for a close forecast.");
    reasonCodes.push("FORECAST_INSUFFICIENT");
  } else if (input.forecast.status === "reference-only") {
    warnings.push(
      "The closing range is an illustrative scenario, not a trained forecast.",
    );
    reasonCodes.push("REFERENCE_ONLY_FORECAST");
  }

  if (conservativeValue === null) {
    return {
      status: "insufficient",
      score: 0,
      tier: 4,
      calculatedAt: input.calculatedAt,
      conservativeValueCents: null,
      expectedCloseCents: expectedClose,
      allInAtCurrentBidCents: currentCosts.totalAllInCents,
      allInAtExpectedCloseCents: null,
      safeMaxBidCents: null,
      breakEvenBidCents: null,
      projectedProfitCents: null,
      downsideProfitCents: null,
      roi: null,
      discountToValue: null,
      probabilityProfitable: null,
      probabilityWinUnderCeiling: null,
      confidence: 0,
      costs: currentCosts,
      warnings,
      reasonCodes,
    };
  }

  const safeMaxBid = calculateSafeMaxBid(
    conservativeValue,
    input.costs,
    input.target,
  );
  const breakEvenBid = calculateBreakEvenBid(conservativeValue, input.costs);
  const expectedCosts =
    expectedClose === null
      ? null
      : calculateCostBreakdown(expectedClose, conservativeValue, input.costs);
  const highClose =
    input.forecast.status !== "insufficient" &&
    input.forecast.highCents !== null
      ? Math.max(currentBid, Math.round(input.forecast.highCents))
      : null;
  const downsideCosts =
    highClose === null
      ? null
      : calculateCostBreakdown(highClose, conservativeValue, input.costs);
  const projectedProfit =
    expectedCosts === null
      ? null
      : conservativeValue - expectedCosts.totalAllInCents;
  const downsideProfit =
    downsideCosts === null
      ? null
      : conservativeValue - downsideCosts.totalAllInCents;
  const roi =
    projectedProfit === null || expectedCosts === null
      ? null
      : projectedProfit / Math.max(1, expectedCosts.totalAllInCents);
  const discountToValue =
    expectedClose === null
      ? (conservativeValue - currentBid) / conservativeValue
      : (conservativeValue - expectedClose) / conservativeValue;
  const probabilityWinUnderCeiling = probabilityAtOrBelow(
    input.forecast,
    safeMaxBid,
  );
  const probabilityProfitable = probabilityAtOrBelow(
    input.forecast,
    breakEvenBid,
  );
  const listingConfidence = clamp(input.dataConfidence ?? 1, 0, 1);
  const valuationConfidence = clamp(input.valuation.confidence, 0, 1);
  const forecastConfidence =
    input.forecast.status === "insufficient"
      ? 0
      : clamp(input.forecast.confidence, 0, 1);
  const provenanceFactor =
    input.valuation.status === "provider" &&
    input.forecast.status === "available"
      ? 1
      : 0.55;
  const confidence = Number(
    clamp(
      (valuationConfidence * 0.45 +
        forecastConfidence * 0.4 +
        listingConfidence * 0.15) *
        provenanceFactor,
      0,
      1,
    ).toFixed(4),
  );

  const discountScore =
    clamp((discountToValue + 0.05) / 0.45, 0, 1) * 30;
  const ceilingHeadroom =
    safeMaxBid <= 0
      ? 0
      : clamp((safeMaxBid - currentBid) / safeMaxBid, 0, 1);
  const roiScore = roi === null ? 0 : clamp(roi / 0.25, 0, 1) * 20;
  const probabilityScore =
    (((probabilityProfitable ?? 0) + (probabilityWinUnderCeiling ?? 0)) / 2) *
    15;
  const score = Math.round(
    clamp(
      discountScore +
        ceilingHeadroom * 25 +
        roiScore +
        probabilityScore +
        confidence * 10,
      0,
      SCORE_MAX,
    ),
  );

  let status: DealAssessment["status"] = "watch";
  if (
    currentBid > breakEvenBid ||
    (projectedProfit !== null && projectedProfit < 0)
  ) {
    status = "avoid";
    warnings.push("Modeled acquisition cost is above the break-even ceiling.");
    reasonCodes.push("ABOVE_BREAK_EVEN");
  } else if (
    input.valuation.status === "provider" &&
    input.forecast.status === "available" &&
    currentBid <= safeMaxBid &&
    (projectedProfit ?? -1) >= input.target.minimumProfitCents &&
    (probabilityWinUnderCeiling ?? 0) >= 0.35 &&
    confidence >= 0.5
  ) {
    status = "actionable";
    reasonCodes.push("MEETS_PROFIT_AND_CONFIDENCE_THRESHOLDS");
  } else if (currentBid > safeMaxBid) {
    warnings.push("The current bid is above the target-profit ceiling.");
    reasonCodes.push("ABOVE_SAFE_MAX_BID");
  } else {
    reasonCodes.push("MONITOR_BELOW_SAFE_MAX_BID");
  }

  return {
    status,
    score,
    tier: assessmentTier(status, score),
    calculatedAt: input.calculatedAt,
    conservativeValueCents: conservativeValue,
    expectedCloseCents: expectedClose,
    allInAtCurrentBidCents: currentCosts.totalAllInCents,
    allInAtExpectedCloseCents: expectedCosts?.totalAllInCents ?? null,
    safeMaxBidCents: safeMaxBid,
    breakEvenBidCents: breakEvenBid,
    projectedProfitCents: projectedProfit,
    downsideProfitCents: downsideProfit,
    roi: roi === null ? null : Number(roi.toFixed(4)),
    discountToValue: Number(discountToValue.toFixed(4)),
    probabilityProfitable:
      probabilityProfitable === null
        ? null
        : Number(probabilityProfitable.toFixed(4)),
    probabilityWinUnderCeiling:
      probabilityWinUnderCeiling === null
        ? null
        : Number(probabilityWinUnderCeiling.toFixed(4)),
    confidence,
    costs: currentCosts,
    warnings,
    reasonCodes,
  };
}
