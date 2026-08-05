import snapshotDocument from "../public/market-valuations.json" with { type: "json" };
import {
  validateGsaMarketValuationSnapshot,
  type GsaMarketValuation,
  type GsaMarketValuationSnapshot,
} from "./gsa-market-valuations.ts";

const snapshot = validateGsaMarketValuationSnapshot(snapshotDocument);
const bySubjectId = new Map(
  snapshot.valuations.map((valuation) => [valuation.subjectAuctionId, valuation]),
);
const byExternalId = new Map(
  snapshot.valuations.map((valuation) => [valuation.externalId, valuation]),
);

/** Returns the validated, build-time official GSA closed-comp snapshot. */
export function getGsaMarketValuationSnapshot(): GsaMarketValuationSnapshot {
  return snapshot;
}

/** Looks up either the normalized `gsa:ppms:*` id or the numeric PPMS id. */
export function getGsaMarketValuation(
  subjectAuctionId: string,
): GsaMarketValuation | null {
  const key = subjectAuctionId.trim();
  return bySubjectId.get(key) ?? byExternalId.get(key) ?? null;
}
