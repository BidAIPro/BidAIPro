import type { GsaDiscoveryResult } from "./gsa-client.ts";
import { GSA_AUCTIONS_ENDPOINT } from "./gsa-client.ts";
import type { GsaCoverage, GsaVehicleAuction } from "./gsa-normalizer.ts";

const MIN_VEHICLE_COUNT = 10;
const MAX_IMAGES_PER_AUCTION = 6;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const PPMS_IMAGE_FRESHNESS_MS = 55 * 60_000;

export type GsaRunnerSnapshotSource = "gsa-ppms" | "gsa-auctions-api";

export interface PreparedGsaRunnerSnapshot {
  source: GsaRunnerSnapshotSource;
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  generatedAt: string;
  expiresAt: string;
  imageExpiresAt: string;
}

function isOfficialLegacyImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "gsa.gov" ||
      hostname.endsWith(".gsa.gov") ||
      hostname === "gsaauctions.gov" ||
      hostname.endsWith(".gsaauctions.gov")
    );
  } catch {
    return false;
  }
}

function legacyAuctionWithTrustedImages(auction: GsaVehicleAuction): GsaVehicleAuction {
  const images = [...new Set([auction.imageUrl, ...auction.images].filter(
    (value): value is string => typeof value === "string" && isOfficialLegacyImageUrl(value),
  ))].slice(0, MAX_IMAGES_PER_AUCTION);
  return {
    ...auction,
    imageUrl: images[0] ?? null,
    images,
  };
}

function snapshotCoverage(
  source: GsaCoverage,
  auctions: readonly GsaVehicleAuction[],
  includeDetailEnrichment: boolean,
): GsaCoverage {
  return {
    totalLots: Math.max(source.totalLots, auctions.length),
    vehicleLots: auctions.length,
    excludedLots: source.excludedLots,
    withVin: auctions.filter((auction) => auction.vin !== null).length,
    withMileage: auctions.filter((auction) => auction.mileage !== null).length,
    withBodyType: auctions.filter((auction) => auction.bodyType !== null).length,
    withImage: auctions.filter((auction) => auction.imageUrl !== null).length,
    withCurrentBid: auctions.filter((auction) => auction.currentBid !== null).length,
    statusCounts: {
      active: auctions.length,
      preview: 0,
      scheduled: 0,
      unknown: 0,
    },
    exclusionCounts: { ...source.exclusionCounts },
    ...(includeDetailEnrichment && source.detailEnrichment
      ? { detailEnrichment: { ...source.detailEnrichment } }
      : {}),
  };
}

/**
 * Converts one fresh official discovery result into the bounded artifact read
 * by the hosted site. PPMS remains primary; the keyed documented API is an
 * authenticated collector fallback when hosted-runner egress is rejected.
 */
export function prepareGsaRunnerSnapshot(
  discovery: GsaDiscoveryResult,
  now: Date,
): PreparedGsaRunnerSnapshot {
  if (Number.isNaN(now.getTime())) throw new TypeError("now must be a valid date.");
  if (discovery.sourceHealth.status !== "live" || discovery.sourceHealth.cache !== "refresh") {
    throw new Error("Refusing to publish a stale GSA discovery result.");
  }

  const sourceMode = discovery.sourceHealth.sourceMode;
  const activeSourceAuctions = discovery.auctions.filter((auction) => auction.status === "active");
  const suppliedLegacyImages = sourceMode === "legacy-bulk-feed"
    ? activeSourceAuctions.filter((auction) => auction.imageUrl !== null).length
    : 0;
  const auctions = sourceMode === "legacy-bulk-feed"
    ? activeSourceAuctions.map(legacyAuctionWithTrustedImages)
    : activeSourceAuctions.map((auction) => ({
        ...auction,
        images: auction.images.slice(0, MAX_IMAGES_PER_AUCTION),
      }));

  if (auctions.length < MIN_VEHICLE_COUNT) {
    throw new Error("Refusing to publish an unavailable or empty GSA snapshot.");
  }
  if (new Set(auctions.map((auction) => auction.id)).size !== auctions.length) {
    throw new Error("Refusing to publish a GSA snapshot with duplicate vehicle IDs.");
  }

  if (sourceMode === "ppms-public-catalog") {
    if (discovery.coverage.vehicleLots !== auctions.length) {
      throw new Error("Refusing to publish a partial GSA PPMS vehicle snapshot.");
    }
    if (
      discovery.coverage.detailEnrichment?.requested !== auctions.length ||
      discovery.coverage.detailEnrichment.succeeded < Math.ceil(auctions.length * 0.9)
    ) {
      throw new Error("Refusing to publish a materially incomplete GSA detail snapshot.");
    }
  } else {
    if (
      discovery.sourceHealth.endpoint !== GSA_AUCTIONS_ENDPOINT ||
      discovery.sourceHealth.credentialMode !== "configured"
    ) {
      throw new Error("Refusing to publish a legacy GSA snapshot without a configured API key.");
    }
    const trustedLegacyImages = auctions.filter((auction) => auction.imageUrl !== null).length;
    if (
      suppliedLegacyImages > 0 &&
      trustedLegacyImages < Math.ceil(suppliedLegacyImages * 0.9)
    ) {
      throw new Error("Refusing to publish legacy GSA image URLs from untrusted hosts.");
    }
  }

  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_MAX_AGE_MS).toISOString();
  const imageExpiresAt = sourceMode === "legacy-bulk-feed"
    ? expiresAt
    : new Date(now.getTime() + PPMS_IMAGE_FRESHNESS_MS).toISOString();

  return {
    source: sourceMode === "legacy-bulk-feed" ? "gsa-auctions-api" : "gsa-ppms",
    auctions,
    coverage: snapshotCoverage(
      discovery.coverage,
      auctions,
      sourceMode === "ppms-public-catalog",
    ),
    generatedAt,
    expiresAt,
    imageExpiresAt,
  };
}
