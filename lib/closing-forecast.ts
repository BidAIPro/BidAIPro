import type {
  ClosingOutcomeAnchor,
  ClosingForecast,
  ValuationReference,
} from "./auction-types";

const MODEL_VERSION = "gsa-reference-close-v1";
const DEFAULT_ROUNDING_CENTS = 10_000;
const MAX_REASONABLE_MONEY_CENTS = 10_000_000_000;
const MIN_VALUATION_CONFIDENCE = 0.2;
const MIN_OUTCOME_MATCH_SCORE = 0.45;
const MAX_REFERENCE_CONFIDENCE = 0.35;

/** Terminal auction price after subject-vehicle adjustments, when applicable. */
export type ReferenceClosingOutcome = ClosingOutcomeAnchor;

export interface SubjectBidObservation {
  observedAt: string;
  currentBidCents: number;
  bidderCount?: number | null;
}

export interface ReferenceClosingForecastInput {
  currentBidCents: number | null;
  bidderCount?: number | null;
  endsAt?: string | null;
  asOf: string;
  valuation: Pick<
    ValuationReference,
    | "status"
    | "lowCents"
    | "medianCents"
    | "highCents"
    | "confidence"
    | "asOf"
  >;
  terminalOutcomes?: readonly ReferenceClosingOutcome[];
  subjectBidObservations?: readonly SubjectBidObservation[];
  roundingCents?: number;
  modelVersion?: string;
}

interface WeightedValue {
  value: number;
  weight: number;
}

interface PriceAnchors {
  low: number;
  median: number;
  high: number;
  valuationUsed: boolean;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function finiteMoney(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_REASONABLE_MONEY_CENTS
  ) {
    return null;
  }
  return Math.round(value);
}

function validTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedQuantile(values: readonly WeightedValue[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = totalWeight * clamp(percentile, 0, 1);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= target) return item.value;
  }
  return sorted.at(-1)!.value;
}

function normalizedOutcomes(values: readonly ReferenceClosingOutcome[]) {
  const deduplicated = new Map<string, ReferenceClosingOutcome & {
    adjustedCloseCents: number;
    matchScore: number;
    weight: number;
  }>();

  for (const outcome of values) {
    const id = typeof outcome.id === "string" ? outcome.id.trim() : "";
    const adjustedCloseCents = finiteMoney(outcome.adjustedCloseCents);
    const matchScore = outcome.matchScore === undefined
      ? 0.65
      : clamp(outcome.matchScore, 0, 1);
    const suppliedWeight = outcome.weight === undefined ? 1 : outcome.weight;
    if (
      !id ||
      adjustedCloseCents === null ||
      adjustedCloseCents <= 0 ||
      matchScore < MIN_OUTCOME_MATCH_SCORE ||
      !Number.isFinite(suppliedWeight) ||
      suppliedWeight <= 0
    ) {
      continue;
    }
    deduplicated.set(id, {
      ...outcome,
      id,
      adjustedCloseCents,
      matchScore,
      // Squaring similarity prevents a marginal match from carrying the same
      // influence as a strong comparable while retaining explicit source weight.
      weight: Math.min(10, suppliedWeight) * matchScore * matchScore,
    });
  }

  return [...deduplicated.values()];
}

function valuationAnchors(
  valuation: ReferenceClosingForecastInput["valuation"],
): [number, number, number] | null {
  if (
    valuation.status === "unavailable" ||
    !Number.isFinite(valuation.confidence) ||
    valuation.confidence < MIN_VALUATION_CONFIDENCE
  ) {
    return null;
  }
  const low = finiteMoney(valuation.lowCents);
  const median = finiteMoney(valuation.medianCents);
  const high = finiteMoney(valuation.highCents);
  if (
    low === null || median === null || high === null ||
    low <= 0 || low > median || median > high
  ) {
    return null;
  }
  return [low, median, high];
}

function priceAnchors(
  valuation: ReferenceClosingForecastInput["valuation"],
  outcomes: ReturnType<typeof normalizedOutcomes>,
): PriceAnchors | null {
  const valuationRange = valuationAnchors(valuation);
  if (outcomes.length === 0) {
    return valuationRange
      ? {
          low: valuationRange[0],
          median: valuationRange[1],
          high: valuationRange[2],
          valuationUsed: true,
        }
      : null;
  }

  const weighted = outcomes.map((outcome) => ({
    value: outcome.adjustedCloseCents,
    weight: outcome.weight,
  }));
  const outcomeRange = [
    weightedQuantile(weighted, 0.2),
    weightedQuantile(weighted, 0.5),
    weightedQuantile(weighted, 0.8),
  ] as const;
  if (!valuationRange) {
    return {
      low: outcomeRange[0],
      median: outcomeRange[1],
      high: outcomeRange[2],
      valuationUsed: false,
    };
  }

  // Terminal outcomes are direct close-price evidence. A valuation is only a
  // stabilizer, with its influence shrinking quickly as outcome coverage grows.
  const valuationWeight = clamp(3 / (outcomes.length + 3), 0.12, 0.5);
  const outcomeWeight = 1 - valuationWeight;
  return {
    low: Math.round(outcomeRange[0] * outcomeWeight + valuationRange[0] * valuationWeight),
    median: Math.round(outcomeRange[1] * outcomeWeight + valuationRange[1] * valuationWeight),
    high: Math.round(outcomeRange[2] * outcomeWeight + valuationRange[2] * valuationWeight),
    valuationUsed: true,
  };
}

/**
 * How much of the gap between today's bid and historical anchors remains in a
 * reference estimate. These conservative weights are explicit and versioned;
 * empirical time-matched curves should replace them when coverage is adequate.
 */
function timeToCloseWeight(horizonSeconds: number | null): number {
  if (horizonSeconds === null) return 0.55;
  if (horizonSeconds <= 0) return 0;
  if (horizonSeconds < 60) return 0.1;
  if (horizonSeconds < 5 * 60) return 0.2;
  if (horizonSeconds < 30 * 60) return 0.35;
  if (horizonSeconds < 6 * 60 * 60) return 0.55;
  if (horizonSeconds < 24 * 60 * 60) return 0.7;
  if (horizonSeconds < 7 * 24 * 60 * 60) return 0.8;
  return 0.9;
}

function subjectObservations(
  values: readonly SubjectBidObservation[],
  asOfMs: number,
) {
  const deduplicated = new Map<string, SubjectBidObservation & {
    observedAtMs: number;
    currentBidCents: number;
  }>();
  for (const observation of values) {
    const observedAtMs = validTimestamp(observation.observedAt);
    const currentBidCents = finiteMoney(observation.currentBidCents);
    if (
      observedAtMs === null || observedAtMs > asOfMs ||
      currentBidCents === null
    ) {
      continue;
    }
    deduplicated.set(`${observedAtMs}:${currentBidCents}`, {
      ...observation,
      observedAtMs,
      currentBidCents,
    });
  }
  return [...deduplicated.values()]
    .sort((left, right) => left.observedAtMs - right.observedAtMs)
    .slice(-24);
}

function bidAggression(
  currentBidCents: number,
  observations: ReturnType<typeof subjectObservations>,
): number {
  const earlier = observations.filter((observation) =>
    observation.currentBidCents <= currentBidCents
  );
  if (earlier.length < 2 || currentBidCents <= 0) return 0;
  const baseline = earlier[0]!.currentBidCents;
  const relativeLift = clamp(
    (currentBidCents - baseline) / Math.max(currentBidCents, 1),
    0,
    1,
  );
  let increases = 0;
  for (let index = 1; index < earlier.length; index += 1) {
    if (earlier[index]!.currentBidCents > earlier[index - 1]!.currentBidCents) {
      increases += 1;
    }
  }
  return clamp(relativeLift * 0.7 + Math.min(1, increases / 5) * 0.3, 0, 1);
}

function rounded(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function insufficientForecast(
  input: ReferenceClosingForecastInput,
  reasonCode: string,
): ClosingForecast {
  const asOfMs = validTimestamp(input.asOf);
  const endsAtMs = validTimestamp(input.endsAt);
  const horizonSeconds = asOfMs !== null && endsAtMs !== null
    ? Math.max(0, Math.floor((endsAtMs - asOfMs) / 1_000))
    : null;
  return {
    status: "insufficient",
    lowCents: null,
    expectedCents: null,
    highCents: null,
    asOf: input.asOf,
    modelVersion: input.modelVersion ?? MODEL_VERSION,
    method: "Reference close estimate unavailable",
    confidence: 0,
    horizonSeconds,
    currentBidAtForecastCents: input.currentBidCents,
    sampleSize: 0,
    exactModelCount: 0,
    curveCount: 0,
    subjectObservationCount: 0,
    evidenceIds: [],
    outcomeAnchors: [],
    provenance: "insufficient",
    reasonCodes: [reasonCode],
  };
}

/**
 * Produces a deliberately low-confidence planning reference until calibrated,
 * time-matched comparable bid curves are available. It is never an appraisal,
 * trained forecast, award-price claim, or reason to make a deal actionable.
 */
export function buildReferenceClosingForecast(
  input: ReferenceClosingForecastInput,
): ClosingForecast {
  const asOfMs = validTimestamp(input.asOf);
  if (asOfMs === null) throw new RangeError("asOf must be a valid timestamp");
  const endsAtMs = validTimestamp(input.endsAt);
  const horizonSeconds = endsAtMs === null
    ? null
    : Math.max(0, Math.floor((endsAtMs - asOfMs) / 1_000));
  const outcomes = normalizedOutcomes(input.terminalOutcomes ?? []);
  const anchors = priceAnchors(input.valuation, outcomes);
  if (!anchors) {
    return insufficientForecast(input, "NO_DEFENSIBLE_CLOSE_REFERENCE");
  }
  const roundingCents = finiteMoney(input.roundingCents) ?? DEFAULT_ROUNDING_CENTS;
  const increment = Math.max(100, roundingCents);
  const currentBidCents = finiteMoney(input.currentBidCents);

  // A missing published bid is not the same thing as a $0 bid. Keep the deal
  // unscored elsewhere, but still provide the market/outcome anchored closing
  // reference the user asked for. As soon as a real bid appears, the dynamic
  // bid/time/aggression branch below replaces this market-only estimate.
  if (currentBidCents === null) {
    const lowCents = Math.max(increment, rounded(anchors.low, increment));
    const expectedCents = Math.max(lowCents, rounded(anchors.median, increment));
    const highCents = Math.max(expectedCents, rounded(anchors.high, increment));
    const averageMatch = outcomes.length
      ? outcomes.reduce((sum, outcome) => sum + outcome.matchScore, 0) / outcomes.length
      : 0;
    const valuationConfidence = anchors.valuationUsed
      ? clamp(input.valuation.confidence, 0, 1)
      : 0;
    let confidence = 0.06 +
      Math.min(0.14, outcomes.length * 0.012) * averageMatch +
      valuationConfidence * 0.1;
    if (horizonSeconds === null) confidence *= 0.7;
    confidence = Number(clamp(confidence, 0.03, 0.28).toFixed(4));
    return {
      status: "reference-only",
      lowCents,
      expectedCents,
      highCents,
      asOf: input.asOf,
      modelVersion: input.modelVersion ?? MODEL_VERSION,
      method:
        "Market-only closing reference from defensible valuation and terminal outcome anchors; no current public bid was available",
      confidence,
      horizonSeconds,
      currentBidAtForecastCents: null,
      sampleSize: outcomes.length,
      exactModelCount: outcomes.filter((outcome) => outcome.exactModel === true).length,
      curveCount: 0,
      subjectObservationCount: 0,
      evidenceIds: outcomes.map((outcome) => outcome.id),
      outcomeAnchors: outcomes.map((outcome) => ({
        id: outcome.id,
        adjustedCloseCents: outcome.adjustedCloseCents,
        matchScore: outcome.matchScore,
        weight: outcome.weight,
        exactModel: outcome.exactModel,
      })),
      provenance: "market-reference-heuristic",
      reasonCodes: [
        "REFERENCE_ONLY_CLOSE_ESTIMATE",
        "CURRENT_BID_UNAVAILABLE",
        "MARKET_ONLY_BEFORE_PUBLIC_BID",
        ...(anchors.valuationUsed ? ["MARKET_VALUE_ANCHOR_USED"] : []),
        ...(outcomes.length ? ["TERMINAL_HIGH_BID_OUTCOMES_USED"] : []),
        ...(endsAtMs === null ? ["END_TIME_UNAVAILABLE"] : []),
      ],
    };
  }
  const observations = subjectObservations(
    input.subjectBidObservations ?? [],
    asOfMs,
  );
  const aggression = bidAggression(currentBidCents, observations);
  const bidderCount = typeof input.bidderCount === "number" &&
      Number.isFinite(input.bidderCount) && input.bidderCount >= 0
    ? Math.floor(input.bidderCount)
    : null;
  const engagement = bidderCount === null
    ? 0
    : clamp(Math.log1p(bidderCount) / Math.log(11), 0, 1);
  const baseWeight = timeToCloseWeight(horizonSeconds);
  const timeWeight = clamp(
    baseWeight * (1 + engagement * 0.05 + aggression * 0.08),
    0,
    0.92,
  );
  const aggressiveMedian = anchors.median +
    (anchors.high - anchors.median) * aggression * 0.2;
  const rawLow = currentBidCents +
    timeWeight * Math.max(0, anchors.low - currentBidCents);
  const rawExpected = currentBidCents +
    timeWeight * Math.max(0, aggressiveMedian - currentBidCents);
  let rawHigh = currentBidCents +
    timeWeight * Math.max(0, anchors.high - currentBidCents);

  // If the observed bid already exceeds every anchor, retain a small explicit
  // uncertainty band while preventing an unsupported runaway extrapolation.
  if (currentBidCents >= anchors.high && horizonSeconds !== 0) {
    const evidenceSpread = Math.max(0, anchors.high - anchors.low);
    const residualRisk = Math.min(
      Math.max(DEFAULT_ROUNDING_CENTS, evidenceSpread * 0.15),
      Math.max(DEFAULT_ROUNDING_CENTS, currentBidCents * 0.05),
    );
    rawHigh = currentBidCents + residualRisk * timeWeight;
  }

  const lowCents = Math.max(currentBidCents, rounded(rawLow, increment));
  const expectedCents = Math.max(lowCents, rounded(rawExpected, increment));
  const highCents = Math.max(expectedCents, rounded(rawHigh, increment));
  const averageMatch = outcomes.length
    ? outcomes.reduce((sum, outcome) => sum + outcome.matchScore, 0) / outcomes.length
    : 0;
  const valuationConfidence = anchors.valuationUsed
    ? clamp(input.valuation.confidence, 0, 1)
    : 0;
  let confidence = 0.08 +
    Math.min(0.12, outcomes.length * 0.012) * averageMatch +
    valuationConfidence * 0.1 +
    Math.min(0.025, observations.length * 0.005);
  if (horizonSeconds === null) confidence *= 0.7;
  if (currentBidCents >= anchors.high) confidence *= 0.65;
  confidence = Number(clamp(confidence, 0.03, MAX_REFERENCE_CONFIDENCE).toFixed(4));
  const reasonCodes = [
    "REFERENCE_ONLY_CLOSE_ESTIMATE",
    "HEURISTIC_TIME_TO_CLOSE",
    ...(anchors.valuationUsed ? ["MARKET_VALUE_ANCHOR_USED"] : []),
    ...(outcomes.length ? ["TERMINAL_HIGH_BID_OUTCOMES_USED"] : []),
    ...(observations.length >= 2 ? ["SUBJECT_BID_TREND_USED"] : []),
    ...(bidderCount !== null ? ["BIDDER_ENGAGEMENT_USED"] : []),
    ...(endsAtMs === null ? ["END_TIME_UNAVAILABLE"] : []),
    ...(currentBidCents >= anchors.high ? ["CURRENT_BID_ABOVE_REFERENCE_RANGE"] : []),
  ];

  return {
    status: "reference-only",
    lowCents,
    expectedCents,
    highCents,
    asOf: input.asOf,
    modelVersion: input.modelVersion ?? MODEL_VERSION,
    method:
      "Reference-only blend of the current bid, scheduled time remaining, defensible price anchors, terminal high-bid outcomes, and observed engagement",
    confidence,
    horizonSeconds,
    currentBidAtForecastCents: currentBidCents,
    sampleSize: outcomes.length,
    exactModelCount: outcomes.filter((outcome) => outcome.exactModel === true).length,
    curveCount: 0,
    subjectObservationCount: observations.length,
    evidenceIds: outcomes.map((outcome) => outcome.id),
    outcomeAnchors: outcomes.map((outcome) => ({
      id: outcome.id,
      adjustedCloseCents: outcome.adjustedCloseCents,
      matchScore: outcome.matchScore,
      weight: outcome.weight,
      exactModel: outcome.exactModel,
    })),
    provenance: "market-reference-heuristic",
    reasonCodes,
  };
}
