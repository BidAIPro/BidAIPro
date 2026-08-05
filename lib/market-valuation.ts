import type {
  ValuationEvidence,
  ValuationReference,
  VehicleCondition,
  VehicleOperability,
} from "./auction-types";
import { getGsaMarketValuation } from "./gsa-market-valuation-snapshot.ts";
import { canonicalVehicleFamily } from "./gsa-market-valuations.ts";

const CARMAX_PROVIDER = "CarMax recent offers";
const GSA_COMPS_PROVIDER = "Observed GSA auction comps";
const CARMAX_WINDOW = "the last 45 days";
const CARMAX_CACHE_MS = 24 * 60 * 60 * 1_000;
const GSA_COMPS_CACHE_MS = 60 * 60 * 1_000;
const MISS_CACHE_MS = 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 7_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export interface MarketVehicleRecord {
  auctionId: string;
  vehicleId: string;
  externalId: string;
  normalizedVehicleKey: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  series: string | null;
  vin: string | null;
  mileage: number | null;
  condition: VehicleCondition;
  operability: VehicleOperability;
  damageFlags: string[];
  issueFlags: string[];
  postalCode: string | null;
}

export interface CanonicalVehicleIdentity {
  year: number;
  make: string;
  model: string;
  trim: string | null;
  series: string | null;
  bodyClass: string | null;
  matchBasis: "vin-decoded-year-make-model" | "gsa-year-make-model";
}

export interface CarMaxOffer {
  mileage: number;
  offerCents: number;
  observedAt: string | null;
  trim: string | null;
}

export interface CarMaxMarketSample {
  rawLowCents: number;
  rawHighCents: number;
  offers: CarMaxOffer[];
  reportedSampleSize: number;
}

export interface MarketValuationItem {
  externalId: string;
  valuation: ValuationReference;
  cacheStatus: "fresh" | "refreshed" | "unavailable";
}

export interface MarketValuationBatchResult {
  data: MarketValuationItem[];
  meta: {
    requested: number;
    resolved: number;
    refreshed: number;
    generatedAt: string;
  };
  errors?: Array<{ externalId: string; code: string }>;
}

interface D1VehicleRow {
  auction_id: string;
  vehicle_id: string;
  external_id: string;
  normalized_vehicle_key: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  series: string | null;
  vin: string | null;
  mileage: number | null;
  condition: string;
  operability: string;
  damage_flags_json: string;
  feature_flags_json: string;
  postal_code: string | null;
}

interface D1ValuationRow {
  provider: string;
  provider_kind: string;
  status: string;
  valuation_type: string;
  input_mileage: number | null;
  low_cents: number | null;
  median_cents: number | null;
  high_cents: number | null;
  raw_low_cents: number | null;
  raw_median_cents: number | null;
  raw_high_cents: number | null;
  comparable_median_mileage: number | null;
  mileage_adjustment_cents: number | null;
  condition_adjustment_cents: number | null;
  condition_adjustment_bps: number | null;
  condition_basis: string | null;
  match_basis: string | null;
  confidence_bps: number;
  sample_size: number;
  as_of: string;
  source_url: string | null;
  provenance_note: string;
}

interface D1ComparableRow {
  external_id: string;
  canonical_url: string | null;
  mileage: number | null;
  closed_high_bid_cents: number;
  ended_at: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const suffix = value.trim().match(/^\$?([\d,.]+)\s*([km])?$/i);
  if (!suffix) return null;
  const parsed = Number(suffix[1]!.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return parsed * (suffix[2]?.toLowerCase() === "k" ? 1_000 : suffix[2]?.toLowerCase() === "m" ? 1_000_000 : 1);
}

function moneyCents(value: unknown): number | null {
  const dollars = finiteNumber(value);
  return dollars !== null && dollars >= 100 && dollars <= 1_000_000
    ? Math.round(dollars * 100)
    : null;
}

function mileage(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 2_000_000
    ? Math.round(parsed)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstField(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return null;
}

function findAppraisalData(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  const record = objectValue(value);
  if (!record) return null;
  const nested = objectValue(record.appraisalData);
  if (nested) return nested;
  if (
    (record.percentileLow !== undefined || record.percentileHigh !== undefined) &&
    (Array.isArray(record.offerData) || Array.isArray(record.offers))
  ) {
    return record;
  }
  for (const key of ["props", "pageProps", "data", "initialState"]) {
    const found = findAppraisalData(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function parseOffer(value: unknown): CarMaxOffer | null {
  const record = objectValue(value);
  if (!record) return null;
  const parsedMileage = mileage(firstField(record, ["mileage", "odometer", "miles"]));
  const parsedOffer = moneyCents(firstField(record, [
    "offer",
    "offerAmount",
    "amount",
    "price",
    "value",
  ]));
  if (parsedMileage === null || parsedOffer === null) return null;
  return {
    mileage: parsedMileage,
    offerCents: parsedOffer,
    observedAt: textValue(firstField(record, ["created", "createdAt", "offerDate", "date"])),
    trim: textValue(firstField(record, ["trimDisplay", "trim", "trimCode"])),
  };
}

/** Parses the public `__NEXT_DATA__` payload embedded in a CarMax value page. */
export function parseCarMaxNextData(input: string): CarMaxMarketSample | null {
  const scriptMatch = input.match(
    /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  const jsonText = scriptMatch?.[1]?.trim() ?? (input.trim().startsWith("{") ? input.trim() : null);
  if (!jsonText) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const appraisal = findAppraisalData(payload);
  if (!appraisal) return null;
  const offerValues = firstField(appraisal, ["offerData", "offers"]);
  const offers = Array.isArray(offerValues)
    ? offerValues.map(parseOffer).filter((offer): offer is CarMaxOffer => offer !== null)
    : [];
  let rawLowCents = moneyCents(firstField(appraisal, ["percentileLow", "low", "lowValue"]));
  let rawHighCents = moneyCents(firstField(appraisal, ["percentileHigh", "high", "highValue"]));
  if (offers.length) {
    const amounts = offers.map((offer) => offer.offerCents).sort((a, b) => a - b);
    rawLowCents ??= amounts[0]!;
    rawHighCents ??= amounts[amounts.length - 1]!;
  }
  if (rawLowCents === null || rawHighCents === null || rawLowCents > rawHighCents) return null;
  const reported = finiteNumber(firstField(appraisal, ["sampleSize", "offerCount", "totalOffers"]));
  return {
    rawLowCents,
    rawHighCents,
    offers,
    reportedSampleSize: Math.max(offers.length, reported === null ? 0 : Math.round(reported)),
  };
}

function parseReaderMileage(line: string): number | null {
  const match = line.match(/\b([\d,.]+)\s*([kKmM])?\s*(?:miles?|mi)\b/);
  return match ? mileage(`${match[1]}${match[2] ?? ""}`) : null;
}

/** Strict fallback parser for Jina Reader output from the same CarMax page. */
export function parseCarMaxReaderText(input: string): CarMaxMarketSample | null {
  if (!/carmax/i.test(input) || !/(?:real|recent)\s+carmax\s+offers?/i.test(input)) return null;
  const range = input.match(
    /(?:ranges?[^$\n]{0,80}(?:from|between)|value[^$\n]{0,80})\s*\$([\d,]+)\s*(?:-|\u2013|\u2014|to)\s*\$([\d,]+)/i,
  ) ?? input.match(/\$([\d,]+)\s*(?:-|\u2013|\u2014|to)\s*\$([\d,]+)/);
  if (!range) return null;
  const rawLowCents = moneyCents(range[1]);
  const rawHighCents = moneyCents(range[2]);
  if (rawLowCents === null || rawHighCents === null || rawLowCents > rawHighCents) return null;

  const offers: CarMaxOffer[] = [];
  for (const line of input.split(/\r?\n/)) {
    const dollars = [...line.matchAll(/\$([\d,]+)/g)];
    const parsedMileage = parseReaderMileage(line);
    if (dollars.length !== 1 || parsedMileage === null) continue;
    const parsedOffer = moneyCents(dollars[0]![1]);
    if (parsedOffer === null) continue;
    offers.push({ mileage: parsedMileage, offerCents: parsedOffer, observedAt: null, trim: null });
  }
  const countMatch = input.match(/(?:based on|sample of)\s+([\d,]+)\s+(?:real\s+)?(?:carmax\s+)?offers?/i);
  const count = countMatch ? finiteNumber(countMatch[1]) : null;
  return {
    rawLowCents,
    rawHighCents,
    offers,
    reportedSampleSize: Math.max(offers.length, count === null ? 0 : Math.round(count)),
  };
}

export function parseCarMaxResponse(input: string): CarMaxMarketSample | null {
  return parseCarMaxNextData(input) ?? parseCarMaxReaderText(input);
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function weightedMedian(
  values: readonly { value: number; weight: number }[],
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function normalizedWords(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function comparableOffers(sample: CarMaxMarketSample, trim: string | null) {
  const targetTrim = normalizedWords(trim);
  if (!targetTrim) return sample.offers;
  const matching = sample.offers.filter((offer) => {
    const candidate = normalizedWords(offer.trim);
    return candidate && (candidate === targetTrim || candidate.includes(targetTrim) || targetTrim.includes(candidate));
  });
  return matching.length >= 3 ? matching : sample.offers;
}

export function listingConditionAdjustment(
  vehicle: Pick<
    MarketVehicleRecord,
    "condition" | "operability" | "damageFlags" | "issueFlags"
  >,
): { pct: number; basis: string } {
  const reasons: string[] = [];
  let pct = 0;
  const conditionRate: Record<VehicleCondition, number> = {
    good: 0,
    fair: -0.08,
    repairable: -0.22,
    salvage: -0.4,
    unknown: 0,
  };
  const conditionPct = conditionRate[vehicle.condition];
  if (conditionPct) {
    pct += conditionPct;
    reasons.push(`${vehicle.condition} condition ${Math.round(conditionPct * 100)}%`);
  }
  if (vehicle.operability === "non-operational") {
    pct -= 0.18;
    reasons.push("non-operational -18%");
  } else if (vehicle.operability === "runs") {
    pct -= 0.04;
    reasons.push("runs but drive status unconfirmed -4%");
  }
  const damageCount = Math.min(4, new Set(vehicle.damageFlags.map(normalizedWords)).size);
  const issueCount = Math.min(4, new Set(vehicle.issueFlags.map(normalizedWords)).size);
  if (damageCount) {
    const rate = damageCount * -0.025;
    pct += rate;
    reasons.push(`${damageCount} disclosed damage flag${damageCount === 1 ? "" : "s"} ${Math.round(rate * 100)}%`);
  }
  if (issueCount) {
    const rate = issueCount * -0.01;
    pct += rate;
    reasons.push(`${issueCount} disclosed issue flag${issueCount === 1 ? "" : "s"} ${Math.round(rate * 100)}%`);
  }
  pct = Math.max(-0.45, Math.min(0, pct));
  return {
    pct: Number(pct.toFixed(4)),
    basis: reasons.length
      ? `${reasons.join("; ")}; total deduction capped at 45%.`
      : "No automatic condition deduction; the GSA listing has no modeled adverse condition, operability, damage, or issue flag.",
  };
}

/** Builds a transparent, mileage-adjusted planning reference from recent offers. */
export function buildCarMaxValuation(
  sample: CarMaxMarketSample,
  vehicle: Pick<
    MarketVehicleRecord,
    "mileage" | "trim" | "condition" | "operability" | "damageFlags" | "issueFlags"
  >,
  options: {
    sourceUrl: string;
    matchBasis: string;
    asOf: string;
  },
): ValuationReference {
  const offers = comparableOffers(sample, vehicle.trim);
  const rawOfferMedian = median(offers.map((offer) => offer.offerCents));
  const rawMedianCents = Math.min(
    sample.rawHighCents,
    Math.max(
      sample.rawLowCents,
      rawOfferMedian ?? Math.round((sample.rawLowCents + sample.rawHighCents) / 2),
    ),
  );
  const comparableMedianMileage = median(offers.map((offer) => offer.mileage));
  let mileageAdjustmentCents: number | null = null;
  if (vehicle.mileage !== null && offers.length >= 3) {
    const mileageWeightedMedian = weightedMedian(
      offers.map((offer) => ({
        value: offer.offerCents,
        weight: 1 / (1 + Math.abs(offer.mileage - vehicle.mileage!) / 25_000),
      })),
    );
    if (mileageWeightedMedian !== null) {
      const maximumAdjustment = Math.round(rawMedianCents * 0.25);
      mileageAdjustmentCents = Math.max(
        -maximumAdjustment,
        Math.min(maximumAdjustment, mileageWeightedMedian - rawMedianCents),
      );
    }
  }
  const adjustment = mileageAdjustmentCents ?? 0;
  const afterMileageLow = Math.max(50_000, sample.rawLowCents + adjustment);
  const afterMileageMedian = Math.max(afterMileageLow, rawMedianCents + adjustment);
  const afterMileageHigh = Math.max(afterMileageMedian, sample.rawHighCents + adjustment);
  const conditionAdjustment = listingConditionAdjustment(vehicle);
  const conditionFactor = 1 + conditionAdjustment.pct;
  const conditionAdjustmentCents = Math.round(afterMileageMedian * conditionAdjustment.pct);
  const adjustedLow = Math.max(50_000, Math.round(afterMileageLow * conditionFactor));
  const adjustedMedian = Math.max(adjustedLow, Math.round(afterMileageMedian * conditionFactor));
  const adjustedHigh = Math.max(adjustedMedian, Math.round(afterMileageHigh * conditionFactor));
  const nearestDistance = vehicle.mileage === null || !offers.length
    ? null
    : Math.min(...offers.map((offer) => Math.abs(offer.mileage - vehicle.mileage!)));
  const count = Math.max(sample.reportedSampleSize, offers.length);
  const confidence = Math.min(
    0.78,
    (offers.length >= 8 ? 0.64 : offers.length >= 5 ? 0.57 : offers.length >= 3 ? 0.5 : 0.4) +
      (nearestDistance !== null && nearestDistance <= 30_000 ? 0.08 : 0),
  );
  const datedOffers = offers
    .map((offer) => offer.observedAt)
    .filter((date): date is string => Boolean(date && !Number.isNaN(Date.parse(date))));
  const asOf = datedOffers.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? options.asOf;
  const mileageNote = vehicle.mileage === null
    ? "GSA did not report mileage, so the source range is not mileage-adjusted."
    : mileageAdjustmentCents === null
      ? "The page did not expose enough mileage samples to calculate a mileage adjustment."
      : `The displayed range is shifted ${mileageAdjustmentCents >= 0 ? "up" : "down"} by $${Math.abs(mileageAdjustmentCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })} using offers nearest ${vehicle.mileage.toLocaleString("en-US")} miles.`;

  return {
    status: "reference-only",
    provider: CARMAX_PROVIDER,
    providerKind: "market-comps",
    valuationType: "trade-in",
    lowCents: adjustedLow,
    medianCents: adjustedMedian,
    highCents: adjustedHigh,
    asOf,
    confidence: Number(confidence.toFixed(2)),
    sampleSize: count,
    sourceUrl: options.sourceUrl,
    provenanceNote: `Automatically calculated from the recent real-offer range CarMax publishes for this model year (${CARMAX_WINDOW}). ${mileageNote} BidAI then applies only the bounded deductions supported by GSA's condition, operability, damage, and issue disclosures. History and local demand can still change an actual offer.`,
    evidence: {
      rawLowCents: sample.rawLowCents,
      rawMedianCents,
      rawHighCents: sample.rawHighCents,
      inputMileage: vehicle.mileage,
      comparableMedianMileage,
      mileageAdjustmentCents,
      conditionAdjustmentCents,
      conditionAdjustmentPct: conditionAdjustment.pct,
      conditionBasis: conditionAdjustment.basis,
      matchBasis: options.matchBasis,
    },
  };
}

export function isValidVin(value: string | null | undefined): value is string {
  return Boolean(value && /^[A-HJ-NPR-Z0-9]{17}$/i.test(value));
}

function plausibleIdentity(identity: CanonicalVehicleIdentity): boolean {
  return identity.year >= 1981 && identity.year <= new Date().getUTCFullYear() + 1 &&
    normalizedWords(identity.make).length >= 2 && normalizedWords(identity.model).length >= 1;
}

export function gsaCanonicalIdentity(
  vehicle: Pick<MarketVehicleRecord, "year" | "make" | "model" | "trim" | "series">,
): CanonicalVehicleIdentity {
  return {
    year: vehicle.year,
    make: vehicle.make.trim(),
    model: vehicle.model.trim(),
    trim: vehicle.trim?.trim() || null,
    series: vehicle.series?.trim() || null,
    bodyClass: null,
    matchBasis: "gsa-year-make-model",
  };
}

export function parseNhtsaVinResponse(
  input: unknown,
  fallback: CanonicalVehicleIdentity,
): CanonicalVehicleIdentity {
  const root = objectValue(input);
  const results = root?.Results;
  const first = Array.isArray(results) ? objectValue(results[0]) : null;
  if (!first) return fallback;
  const decoded: CanonicalVehicleIdentity = {
    year: Math.round(finiteNumber(first.ModelYear) ?? fallback.year),
    make: textValue(first.Make) ?? fallback.make,
    model: textValue(first.Model) ?? fallback.model,
    trim: textValue(first.Trim) ?? fallback.trim,
    series: textValue(first.Series) ?? fallback.series,
    bodyClass: textValue(first.BodyClass),
    matchBasis: "vin-decoded-year-make-model",
  };
  return plausibleIdentity(decoded) ? decoded : fallback;
}

function carMaxSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(f|e)-(?=\d)/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanModel(model: string): string {
  return model
    .replace(/^\d{4}\s+/, "")
    .replace(/\b(?:pickup|truck|sedan|suv|vehicle)\b.*$/i, "")
    .replace(/\b(?:4x2|4x4|awd|fwd|rwd)\b.*$/i, "")
    .replace(/\bsuper\s+duty\b/gi, "")
    .trim() || model.trim();
}

export function carMaxValueUrls(identity: CanonicalVehicleIdentity): string[] {
  const make = carMaxSlug(identity.make);
  const cleaned = cleanModel(identity.model);
  const models = [carMaxSlug(cleaned)];
  if (/^transit$/i.test(cleaned) && identity.series) {
    const series = identity.series.match(/(?:t-?)?(150|250|350)/i)?.[1];
    if (series) models.unshift(`transit-${series}`);
  }
  const uncleaned = carMaxSlug(identity.model);
  if (uncleaned && !models.includes(uncleaned)) models.push(uncleaned);
  return [...new Set(models.filter(Boolean))]
    .slice(0, 2)
    .map((model) => `https://www.carmax.com/value/${make}/${model}/${identity.year}`);
}

async function fetchText(fetchImpl: FetchLike, url: string): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) return { text: "", status: response.status };
    const text = await response.text();
    return {
      text: text.length <= MAX_RESPONSE_BYTES ? text : "",
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function decodeVinIdentity(
  fetchImpl: FetchLike,
  vehicle: MarketVehicleRecord,
): Promise<CanonicalVehicleIdentity> {
  const fallback = gsaCanonicalIdentity(vehicle);
  if (!isValidVin(vehicle.vin)) return fallback;
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vehicle.vin)}?format=json`;
    const response = await fetchText(fetchImpl, url);
    if (response.status < 200 || response.status >= 300) return fallback;
    return parseNhtsaVinResponse(JSON.parse(response.text), fallback);
  } catch {
    return fallback;
  }
}

export async function fetchCarMaxValuation(
  fetchImpl: FetchLike,
  vehicle: MarketVehicleRecord,
  asOf: string,
  decodedIdentity?: CanonicalVehicleIdentity,
): Promise<ValuationReference | null> {
  const identity = decodedIdentity ?? await decodeVinIdentity(fetchImpl, vehicle);
  if (!plausibleIdentity(identity)) return null;
  for (const sourceUrl of carMaxValueUrls(identity)) {
    try {
      const direct = await fetchText(fetchImpl, sourceUrl);
      const directSample = direct.status >= 200 && direct.status < 300
        ? parseCarMaxResponse(direct.text)
        : null;
      if (directSample) {
        return buildCarMaxValuation(directSample, vehicle, {
          sourceUrl,
          matchBasis: identity.matchBasis,
          asOf,
        });
      }

      const readerUrl = `https://r.jina.ai/http://www.carmax.com${new URL(sourceUrl).pathname}`;
      const reader = await fetchText(fetchImpl, readerUrl);
      const readerSample = reader.status >= 200 && reader.status < 300
        ? parseCarMaxReaderText(reader.text)
        : null;
      if (readerSample) {
        return buildCarMaxValuation(readerSample, vehicle, {
          sourceUrl,
          matchBasis: `${identity.matchBasis}; CarMax page delivered through Jina Reader`,
          asOf,
        });
      }
    } catch {
      // Try the second canonical model candidate, then the GSA-comp fallback.
    }
  }
  return null;
}

export function unavailableMarketValuation(asOf: string): ValuationReference {
  return {
    status: "unavailable",
    provider: "Automatic market coverage unavailable",
    providerKind: "market-comps",
    valuationType: "composite",
    lowCents: null,
    medianCents: null,
    highCents: null,
    asOf,
    confidence: 0,
    sampleSize: 0,
    provenanceNote: "No recent CarMax offer range or closed GSA comparable was available for this exact vehicle family. No numeric value was invented.",
  };
}

function rowEvidence(row: D1ValuationRow): ValuationEvidence | undefined {
  if (
    row.raw_low_cents === null && row.raw_median_cents === null &&
    row.raw_high_cents === null && row.match_basis === null
  ) return undefined;
  return {
    rawLowCents: row.raw_low_cents,
    rawMedianCents: row.raw_median_cents,
    rawHighCents: row.raw_high_cents,
    inputMileage: row.input_mileage,
    comparableMedianMileage: row.comparable_median_mileage,
    mileageAdjustmentCents: row.mileage_adjustment_cents,
    conditionAdjustmentCents: row.condition_adjustment_cents,
    conditionAdjustmentPct: row.condition_adjustment_bps === null
      ? null
      : row.condition_adjustment_bps / 10_000,
    conditionBasis: row.condition_basis,
    matchBasis: row.match_basis ?? "cached market reference",
  };
}

function valuationFromRow(row: D1ValuationRow): ValuationReference {
  return {
    status: row.status === "provider" || row.status === "reference-only"
      ? row.status
      : "unavailable",
    provider: row.provider,
    providerKind: row.provider_kind === "licensed-provider" || row.provider_kind === "mock-reference"
      ? row.provider_kind
      : "market-comps",
    valuationType:
      row.valuation_type === "trade-in" || row.valuation_type === "private-party" ||
      row.valuation_type === "retail" || row.valuation_type === "auction-comp"
        ? row.valuation_type
        : "composite",
    lowCents: row.low_cents,
    medianCents: row.median_cents,
    highCents: row.high_cents,
    asOf: row.as_of,
    confidence: Math.max(0, Math.min(1, row.confidence_bps / 10_000)),
    sampleSize: Math.max(0, row.sample_size),
    sourceUrl: row.source_url ?? undefined,
    provenanceNote: row.provenance_note,
    evidence: rowEvidence(row),
  };
}

export function normalizeMarketCondition(value: string): VehicleCondition {
  if (value === "usable" || value === "new") return "good";
  if (value === "scrap") return "salvage";
  return value === "good" || value === "fair" || value === "repairable" || value === "salvage"
    ? value
    : "unknown";
}

function operability(value: string): VehicleOperability {
  return value === "runs-and-drives" || value === "runs" || value === "non-operational"
    ? value
    : "unknown";
}

function stringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
  } catch {
    return [];
  }
}

function vehicleFromRow(row: D1VehicleRow): MarketVehicleRecord {
  return {
    auctionId: row.auction_id,
    vehicleId: row.vehicle_id,
    externalId: row.external_id,
    normalizedVehicleKey: row.normalized_vehicle_key,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    series: row.series,
    vin: row.vin,
    mileage: row.mileage,
    condition: normalizeMarketCondition(row.condition),
    operability: operability(row.operability),
    damageFlags: stringArray(row.damage_flags_json),
    issueFlags: stringArray(row.feature_flags_json),
    postalCode: row.postal_code,
  };
}

async function readVehicle(db: D1Database, externalId: string): Promise<MarketVehicleRecord | null> {
  const row = await db.prepare(
    `SELECT a.id AS auction_id, v.id AS vehicle_id, a.external_id,
       v.normalized_vehicle_key, v.year, v.make, v.model, v.trim, v.series,
       v.vin, v.mileage, v.condition, v.operability, v.damage_flags_json,
       v.feature_flags_json, a.postal_code
     FROM auctions a
     JOIN vehicles v ON v.auction_id = a.id
     WHERE a.source_key = 'gsa-auctions' AND a.external_id = ?1
     LIMIT 1`,
  ).bind(externalId).first<D1VehicleRow>();
  return row ? vehicleFromRow(row) : null;
}

async function readCachedValuation(
  db: D1Database,
  vehicleId: string,
  nowIso: string,
): Promise<ValuationReference | null> {
  const row = await db.prepare(
    `SELECT provider, provider_kind, status, valuation_type, input_mileage,
       low_cents, median_cents, high_cents, raw_low_cents, raw_median_cents,
       raw_high_cents, comparable_median_mileage, mileage_adjustment_cents,
       condition_adjustment_cents, condition_adjustment_bps, condition_basis,
       match_basis, confidence_bps, sample_size, as_of, source_url,
       provenance_note
     FROM valuations
     WHERE vehicle_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)
     ORDER BY CASE WHEN provider = 'CarMax recent offers' THEN 0 ELSE 1 END,
       created_at DESC
     LIMIT 1`,
  ).bind(vehicleId, nowIso).first<D1ValuationRow>();
  return row ? valuationFromRow(row) : null;
}

function quartile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))]!;
}

function bundledGsaComparableValuation(externalId: string): ValuationReference | null {
  const value = getGsaMarketValuation(externalId);
  if (!value || value.status !== "available") return null;
  const rawAmounts = value.comparables
    .map((comparable) => comparable.rawClosedHighBidCents)
    .sort((a, b) => a - b);
  const rawLowCents = rawAmounts.length ? quartile(rawAmounts, 0.25) : null;
  const rawMedianCents = median(rawAmounts);
  const rawHighCents = rawAmounts.length ? quartile(rawAmounts, 0.75) : null;
  const comparableMedianMileage = median(
    value.comparables
      .map((comparable) => comparable.mileage)
      .filter((miles): miles is number => miles !== null),
  );
  return {
    status: "reference-only",
    provider: "Official GSA closed-high-bid comps",
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: value.lowCents,
    medianCents: value.medianCents,
    highCents: value.highCents,
    asOf: value.asOf,
    confidence: value.confidence,
    sampleSize: value.sampleSize,
    sourceUrl: value.sourceUrls[1] ?? value.sourceUrls[0],
    provenanceNote: `${value.provenanceNote} ${value.matchLabel}. The subject auction's current bid is not an input.`,
    evidence: {
      rawLowCents,
      rawMedianCents,
      rawHighCents,
      inputMileage: value.adjustmentDetail.subjectInputs.mileage,
      comparableMedianMileage,
      mileageAdjustmentCents: null,
      conditionAdjustmentCents: null,
      conditionAdjustmentPct: null,
      conditionBasis: value.adjustmentDetail.notes.join(" "),
      matchBasis: `${value.matchBasis}; ${value.matchLabel}; ${value.adjustmentDetail.model}`,
    },
  };
}

export function buildD1GsaComparableValuation(
  vehicle: MarketVehicleRecord,
  identity: CanonicalVehicleIdentity,
  rowsValue: readonly D1ComparableRow[],
  asOf: string,
): ValuationReference | null {
  const rows = [...rowsValue]
    .filter((row) =>
      Number.isSafeInteger(row.closed_high_bid_cents) && row.closed_high_bid_cents > 0 &&
      Number.isFinite(Date.parse(row.ended_at))
    )
    .sort((left, right) => {
      if (vehicle.mileage !== null) {
        const leftDifference = left.mileage === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(left.mileage - vehicle.mileage);
        const rightDifference = right.mileage === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(right.mileage - vehicle.mileage);
        if (leftDifference !== rightDifference) return leftDifference - rightDifference;
      }
      return Date.parse(right.ended_at) - Date.parse(left.ended_at);
    })
    .slice(0, 25);
  if (!rows.length) return null;

  const rawAmounts = rows.map((row) => row.closed_high_bid_cents).sort((a, b) => a - b);
  const mileageAdjustedAmounts = rows.map((row) => {
    if (!vehicle.mileage || !row.mileage || vehicle.mileage <= 0 || row.mileage <= 0) {
      return row.closed_high_bid_cents;
    }
    const mileageFactor = Math.min(
      1.45,
      Math.max(0.65, Math.pow(row.mileage / vehicle.mileage, 0.28)),
    );
    return Math.max(1, Math.round(row.closed_high_bid_cents * mileageFactor));
  }).sort((a, b) => a - b);
  const rawMedianCents = median(rawAmounts)!;
  const mileageAdjustedMedianCents = median(mileageAdjustedAmounts)!;
  const conditionAdjustment = listingConditionAdjustment(vehicle);
  const conditionFactor = 1 + conditionAdjustment.pct;
  const adjustedAmounts = mileageAdjustedAmounts
    .map((amount) => Math.max(1, Math.round(amount * conditionFactor)))
    .sort((a, b) => a - b);
  const medianCents = median(adjustedAmounts)!;
  const comparableMedianMileage = median(
    rows.map((row) => row.mileage).filter((value): value is number => value !== null),
  );
  const newest = [...rows].sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at))[0]!;
  const nearest = rows[0]!;
  const mileageSampleCount = rows.filter((row) => row.mileage !== null).length;
  return {
    status: "reference-only",
    provider: GSA_COMPS_PROVIDER,
    providerKind: "market-comps",
    valuationType: "auction-comp",
    lowCents: quartile(adjustedAmounts, 0.25),
    medianCents,
    highCents: quartile(adjustedAmounts, 0.75),
    asOf: newest.ended_at || asOf,
    confidence: Number(Math.min(0.7, 0.3 + rows.length * 0.055).toFixed(2)),
    sampleSize: rows.length,
    sourceUrl: nearest.canonical_url ?? "https://gsaauctions.gov/auctions/home",
    provenanceNote: `Mileage- and listing-condition-adjusted range from ${rows.length} terminal GSA closed high bid${rows.length === 1 ? "" : "s"} for the exact stored or VIN-decoded year/make/model; ${mileageSampleCount} reported mileage and the closest available mileage is shown first. A closed high bid is not proof of award, and the current subject bid was never used as market value.`,
    evidence: {
      rawLowCents: quartile(rawAmounts, 0.25),
      rawMedianCents,
      rawHighCents: quartile(rawAmounts, 0.75),
      inputMileage: vehicle.mileage,
      comparableMedianMileage,
      mileageAdjustmentCents: mileageAdjustedMedianCents - rawMedianCents,
      conditionAdjustmentCents: medianCents - mileageAdjustedMedianCents,
      conditionAdjustmentPct: conditionAdjustment.pct,
      conditionBasis: conditionAdjustment.basis,
      matchBasis: `${identity.matchBasis}; official terminal closed-high-bid only; nearest-mileage first`,
    },
  };
}

async function gsaComparableValuation(
  db: D1Database,
  vehicle: MarketVehicleRecord,
  identity: CanonicalVehicleIdentity,
  asOf: string,
): Promise<ValuationReference | null> {
  const family = canonicalVehicleFamily({
    make: identity.make,
    modelLabel: identity.model,
    title: `${identity.year} ${identity.make} ${identity.model}`,
  });
  const canonicalKey = family
    ? `${identity.year}|${family}`
    : `${identity.year}|${identity.make}|${identity.model}`
      .toLowerCase().replace(/\s+/g, " ").trim();
  const result = await db.prepare(
    `SELECT external_id, canonical_url, mileage, closed_high_bid_cents, ended_at
     FROM comparable_sales
     WHERE external_id <> ?1
       AND closed_high_bid_cents > 0
       AND outcome_status = 'closed-high-bid-official-catalog'
       AND ended_at <= ?6
       AND (
         normalized_vehicle_key = ?2 OR
         (year = ?3 AND lower(make) = lower(?4) AND lower(model) = lower(?5))
       )
     ORDER BY
       CASE WHEN ?7 IS NULL OR mileage IS NULL THEN 1 ELSE 0 END,
       ABS(COALESCE(mileage, ?7) - COALESCE(?7, mileage)) ASC,
       ended_at DESC
     LIMIT 25`,
  ).bind(
    vehicle.externalId,
    canonicalKey,
    identity.year,
    identity.make,
    identity.model,
    asOf,
    vehicle.mileage,
  ).all<D1ComparableRow>();
  return buildD1GsaComparableValuation(vehicle, identity, result.results ?? [], asOf);
}

async function persistValuation(
  db: D1Database,
  vehicle: MarketVehicleRecord,
  valuation: ValuationReference,
  createdAt: string,
): Promise<void> {
  const ttl = valuation.provider === CARMAX_PROVIDER
    ? CARMAX_CACHE_MS
    : valuation.provider === GSA_COMPS_PROVIDER || valuation.provider.startsWith("Official GSA")
      ? GSA_COMPS_CACHE_MS
      : MISS_CACHE_MS;
  const expiresAt = new Date(Date.parse(createdAt) + ttl).toISOString();
  const evidence = valuation.evidence;
  await db.prepare(
    `INSERT INTO valuations (
       id, auction_id, vehicle_id, provider, provider_kind, provider_record_id,
       status, valuation_type, region_postal_code, input_mileage,
       input_condition, low_cents, median_cents, high_cents, raw_low_cents,
       raw_median_cents, raw_high_cents, comparable_median_mileage,
       mileage_adjustment_cents, condition_adjustment_cents,
       condition_adjustment_bps, condition_basis, match_basis, confidence_bps,
       sample_size, as_of, expires_at, source_url, provenance_note,
       raw_payload_hash, created_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
       ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
       ?27, ?28, NULL, ?29
     )`,
  ).bind(
    crypto.randomUUID(),
    vehicle.auctionId,
    vehicle.vehicleId,
    valuation.provider,
    valuation.providerKind,
    valuation.status,
    valuation.valuationType,
    vehicle.postalCode,
    vehicle.mileage,
    vehicle.condition,
    valuation.lowCents,
    valuation.medianCents,
    valuation.highCents,
    evidence?.rawLowCents ?? null,
    evidence?.rawMedianCents ?? null,
    evidence?.rawHighCents ?? null,
    evidence?.comparableMedianMileage ?? null,
    evidence?.mileageAdjustmentCents ?? null,
    evidence?.conditionAdjustmentCents ?? null,
    evidence?.conditionAdjustmentPct === null || evidence?.conditionAdjustmentPct === undefined
      ? null
      : Math.round(evidence.conditionAdjustmentPct * 10_000),
    evidence?.conditionBasis ?? null,
    evidence?.matchBasis ?? null,
    Math.round(valuation.confidence * 10_000),
    valuation.sampleSize,
    valuation.asOf,
    expiresAt,
    valuation.sourceUrl ?? null,
    valuation.provenanceNote,
    createdAt,
  ).run();
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function resolveMarketValuationBatch(
  db: D1Database,
  externalIds: readonly string[],
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<MarketValuationBatchResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const ids = [...new Set(externalIds)].slice(0, 12);
  const outcomes = await mapWithConcurrency(ids, 4, async (externalId): Promise<{
    item?: MarketValuationItem;
    refreshed: boolean;
    error?: { externalId: string; code: string };
  }> => {
    const bundled = bundledGsaComparableValuation(externalId);
    let vehicle: MarketVehicleRecord | null;

    try {
      vehicle = await readVehicle(db, externalId);
    } catch {
      // The build-time snapshot is deliberately independent of D1. A missing
      // binding, table, or migration must not take numeric coverage offline.
      if (bundled) {
        return {
          item: { externalId, valuation: bundled, cacheStatus: "fresh" },
          refreshed: false,
        };
      }
      return {
        refreshed: false,
        error: { externalId, code: "MARKET_VALUATION_DATABASE_UNAVAILABLE" },
      };
    }

    if (!vehicle) {
      return bundled
        ? {
            item: { externalId, valuation: bundled, cacheStatus: "fresh" },
            refreshed: false,
          }
        : {
            refreshed: false,
            error: { externalId, code: "VEHICLE_NOT_FOUND" },
          };
    }

    let cached: ValuationReference | null = null;
    try {
      cached = await readCachedValuation(db, vehicle.vehicleId, nowIso);
    } catch {
      // Continue with the bundled or live source. This commonly protects a
      // deployment while a newly added valuation-cache migration is pending.
    }
    if (cached && cached.status !== "unavailable") {
      return {
        item: { externalId, valuation: cached, cacheStatus: "fresh" },
        refreshed: false,
      };
    }

    // The bundled corpus keeps this path immediate. A local D1 query may
    // supersede it only when at least three exact-identity, official terminal
    // comps closed after the bundle was generated; no upstream request is made.
    if (bundled) {
      try {
        const incremental = await gsaComparableValuation(
          db,
          vehicle,
          gsaCanonicalIdentity(vehicle),
          nowIso,
        );
        if (
          incremental && incremental.sampleSize >= 3 &&
          Date.parse(incremental.asOf) > Date.parse(bundled.asOf)
        ) {
          try {
            await persistValuation(db, vehicle, incremental, nowIso);
          } catch {
            // The fresh value remains usable even if cache persistence fails.
          }
          return {
            item: { externalId, valuation: incremental, cacheStatus: "refreshed" },
            refreshed: true,
          };
        }
      } catch {
        // Bundled values remain available when D1 has not been initialized or
        // the incremental ledger is temporarily unavailable.
      }
      return {
        item: { externalId, valuation: bundled, cacheStatus: "fresh" },
        refreshed: false,
      };
    }

    // Preserve a still-valid negative cache for an uncovered vehicle.
    if (cached) {
      return {
        item: { externalId, valuation: cached, cacheStatus: "unavailable" },
        refreshed: false,
      };
    }

    try {
      const identity = await decodeVinIdentity(fetchImpl, vehicle);
      const carMax = await fetchCarMaxValuation(fetchImpl, vehicle, nowIso, identity);
      let gsaComparable: ValuationReference | null = null;
      if (!carMax) {
        try {
          gsaComparable = await gsaComparableValuation(db, vehicle, identity, nowIso);
        } catch {
          // D1 comparable history is optional evidence, not an API dependency.
        }
      }
      const valuation = carMax ?? gsaComparable ?? unavailableMarketValuation(nowIso);
      try {
        await persistValuation(db, vehicle, valuation, nowIso);
      } catch {
        // A cache write or migration failure must not discard a computed value.
      }
      return {
        item: {
          externalId,
          valuation,
          cacheStatus: valuation.status === "unavailable" ? "unavailable" : "refreshed",
        },
        refreshed: true,
      };
    } catch {
      return {
        item: {
          externalId,
          valuation: unavailableMarketValuation(nowIso),
          cacheStatus: "unavailable",
        },
        refreshed: false,
        error: { externalId, code: "MARKET_VALUATION_REFRESH_FAILED" },
      };
    }
  });
  const resolvedItems = outcomes.flatMap((outcome) => outcome.item ? [outcome.item] : []);
  const errors = outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []);
  const refreshed = outcomes.filter((outcome) => outcome.refreshed).length;
  const byExternalId = new Map(
    resolvedItems.map((item) => [item.externalId, item]),
  );
  const data = ids.flatMap((externalId) => {
    const item = byExternalId.get(externalId);
    return item ? [item] : [];
  });

  return {
    data,
    meta: {
      requested: ids.length,
      resolved: data.filter((item) => item.valuation.status !== "unavailable").length,
      refreshed,
      generatedAt: nowIso,
    },
    ...(errors.length ? { errors } : {}),
  };
}
