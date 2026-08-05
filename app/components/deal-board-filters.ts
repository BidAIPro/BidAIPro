import type { AuctionOpportunity } from "../../lib/auction-types";
import { mergeOpportunityFeed } from "../../lib/opportunity-feed.ts";

export type BoardVehicleCategory = "cars" | "trucks" | "other";

const TRUCK_BODY_PATTERN = /\b(?:pickup(?:\s+truck)?|truck|chassis\s+cab|cab\s+chassis|crew\s+cab|extended\s+cab|regular\s+cab)\b/i;
const TRUCK_MODEL_PATTERN = /\b(?:silverado|sierra|colorado|canyon|tacoma|tundra|frontier|titan|ridgeline|gladiator|ranger|maverick|ram\s*(?:1500|2500|3500|4500|5500)|f[-\s]?(?:150|250|350|450|550))\b/i;
const PASSENGER_CAR_PATTERN = /\b(?:passenger\s+cars?|sedans?|coupes?|hatchbacks?|station\s+wagons?|wagons?|convertibles?|roadsters?|sport\s+utility\s+vehicles?|suvs?|crossovers?|mini[-\s]?vans?|passenger\s+vans?)\b/i;

export type StateFilterOption = {
  value: string;
  count: number;
};

export function isOpenBoardAuction(
  auction: Pick<AuctionOpportunity, "status">,
): boolean {
  return auction.status === "active" || auction.status === "closing";
}

/**
 * Cars includes normal passenger road vehicles (including SUVs, crossovers,
 * and minivans); Trucks covers pickup/truck classes. Cargo vans, buses,
 * motorcycles, trailers, and unrecognized specialty vehicles remain Other.
 */
export function boardVehicleCategory(
  auction: Pick<AuctionOpportunity, "title" | "vehicle">,
): BoardVehicleCategory {
  const bodyStyle = auction.vehicle.bodyStyle?.trim() ?? "";
  const identity = [
    auction.title,
    auction.vehicle.make,
    auction.vehicle.model,
    auction.vehicle.trim,
  ].filter(Boolean).join(" ");

  if (TRUCK_BODY_PATTERN.test(bodyStyle) || TRUCK_MODEL_PATTERN.test(identity)) {
    return "trucks";
  }
  if (
    PASSENGER_CAR_PATTERN.test(bodyStyle) ||
    /^(?:car|automobile)$/i.test(bodyStyle) ||
    PASSENGER_CAR_PATTERN.test(auction.title)
  ) {
    return "cars";
  }
  return "other";
}

/**
 * Replace rows only for sources represented authoritatively by a response.
 * This prevents a one-source fallback from erasing a newer combined board.
 */
export function mergeAuthoritativeOpportunityFeed(
  current: readonly AuctionOpportunity[],
  incoming: readonly AuctionOpportunity[],
  authoritativeSources: ReadonlySet<AuctionOpportunity["source"]>,
): AuctionOpportunity[] {
  const refreshed = mergeOpportunityFeed(current, incoming);
  const refreshedIds = new Set(refreshed.map((auction) => auction.id));
  const retained = current.filter((auction) =>
    !authoritativeSources.has(auction.source) && !refreshedIds.has(auction.id)
  );
  return [...refreshed, ...retained];
}

function compareOptionalNumberDescending(
  left: number | null | undefined,
  right: number | null | undefined,
) {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : 1;
  }
  if (right === null || right === undefined) return -1;
  return right - left;
}

function opportunityEventTime(auction: AuctionOpportunity) {
  const value = auction.endsAt ?? auction.startsAt;
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** Stable Best Deal ordering prevents equal-score rows from reshuffling. */
export function compareBestDealOpportunities(
  left: AuctionOpportunity,
  right: AuctionOpportunity,
) {
  return right.assessment.score - left.assessment.score ||
    right.assessment.confidence - left.assessment.confidence ||
    compareOptionalNumberDescending(
      left.assessment.projectedProfitCents,
      right.assessment.projectedProfitCents,
    ) ||
    opportunityEventTime(left) - opportunityEventTime(right) ||
    left.id.localeCompare(right.id, "en-US");
}

export function normalizeAuctionState(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "—" || /^unknown$/i.test(trimmed)) return null;
  return trimmed.length === 2 ? trimmed.toUpperCase() : trimmed;
}

export function buildStateFilterOptions(
  auctions: readonly AuctionOpportunity[],
): StateFilterOption[] {
  const counts = new Map<string, number>();
  for (const auction of auctions) {
    if (!isOpenBoardAuction(auction) && auction.status !== "preview") continue;
    const state = normalizeAuctionState(auction.location.state);
    if (!state) continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, "en-US"));
}

export function auctionMatchesState(
  auction: AuctionOpportunity,
  selectedState: string,
): boolean {
  return selectedState === "all" || normalizeAuctionState(auction.location.state) === selectedState;
}

export function countAdvancedBoardFilters(filters: {
  state: string;
  condition: string;
  maxBid: string;
}): number {
  return Number(filters.state !== "all") +
    Number(filters.condition !== "all") +
    Number(filters.maxBid.trim().length > 0);
}
