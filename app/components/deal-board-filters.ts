import type { AuctionOpportunity } from "../../lib/auction-types";

export type StateFilterOption = {
  value: string;
  count: number;
};

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
    if (auction.status !== "active") continue;
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
