import { env } from "cloudflare:workers";
import { getGsaVehicleAuctions, GsaClientError } from "../../../lib/gsa-client";
import {
  fetchGsaRunnerSnapshot,
  GsaRunnerSnapshotError,
} from "../../../lib/gsa-runner-snapshot";
import type { GsaRunnerSnapshot } from "../../../lib/gsa-runner-snapshot";
import type { GsaCoverage, GsaVehicleAuction } from "../../../lib/gsa-normalizer";
import { persistGsaDiscovery } from "../../../lib/gsa-persistence";
import { discoveryToOpportunity } from "../../../lib/opportunity-adapter";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

export const revalidate = 300;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=300, stale-if-error=600";

function isActiveAt(auction: { status: string; endsAt: string | null }, now: number) {
  return auction.status === "active" &&
    (auction.endsAt === null || Date.parse(auction.endsAt) > now);
}

function coverageForResponse(
  original: GsaCoverage,
  auctions: GsaVehicleAuction[],
): GsaCoverage {
  const enriched = auctions.filter((auction) => auction.detailEnriched !== false).length;
  const imageCount = auctions.reduce((total, auction) => total + auction.images.length, 0);
  return {
    ...original,
    totalLots: auctions.length + original.excludedLots,
    vehicleLots: auctions.length,
    withVin: auctions.filter((auction) => auction.vin !== null).length,
    withMileage: auctions.filter((auction) => auction.mileage !== null).length,
    withBodyType: auctions.filter((auction) => auction.bodyType !== null).length,
    withImage: auctions.filter((auction) => auction.imageUrl !== null).length,
    withCurrentBid: auctions.filter((auction) => auction.currentBid !== null).length,
    statusCounts: { active: auctions.length, preview: 0, scheduled: 0, unknown: 0 },
    detailEnrichment: {
      requested: auctions.length,
      succeeded: enriched,
      failed: auctions.length - enriched,
      imagesDiscovered: imageCount,
      imagesSigned: imageCount,
    },
  };
}

async function persistSnapshotOnce(snapshot: GsaRunnerSnapshot, now: number) {
  if (Date.parse(snapshot.sourceHealth.cachedUntil) <= now) return "snapshot-too-old";
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM source_checks
       WHERE source_key = 'gsa-auctions'
         AND scope = 'hourly-catalog'
         AND checked_at = ?1
         AND success = 1
       LIMIT 1`,
    ).bind(snapshot.sourceHealth.observedAt).first();
    if (existing) return "already-stored";
    await persistGsaDiscovery(env.DB, {
      auctions: snapshot.auctions,
      coverage: snapshot.coverage,
      sourceHealth: snapshot.sourceHealth,
    });
    return "stored";
  } catch {
    return "unavailable";
  }
}

export async function GET() {
  try {
    const discovery = await getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY });
    const now = Date.now();
    const activeAuctions = discovery.auctions.filter((auction) => isActiveAt(auction, now));
    const opportunities = activeAuctions.map((auction) =>
      discoveryToOpportunity(auction, discovery.sourceHealth.observedAt),
    );

    return Response.json(
      {
        data: opportunities,
        meta: {
          mode: "official-gsa-public-catalog",
          coverage: coverageForResponse(discovery.coverage, activeAuctions),
          sourceHealth: {
            ...discovery.sourceHealth,
            liveBidPolling: discovery.sourceHealth.sourceMode === "ppms-public-catalog",
          },
        },
      },
      { headers: publicApiHeaders({ "Cache-Control": CACHE_CONTROL }) },
    );
  } catch (error) {
    const directErrorCode = error instanceof GsaClientError ? error.code : "GSA_UNKNOWN_ERROR";
    try {
      const snapshot = await fetchGsaRunnerSnapshot();
      const now = Date.now();
      const observedAt = snapshot.sourceHealth.observedAt;
      const imagesFresh = Date.parse(snapshot.imageExpiresAt) > now;
      // Preserve any still-cached photo instead of blanking every card at the
      // safety cutoff. VehicleImage degrades cleanly when a signature truly
      // expires, while imagesFresh makes the client retry the renewed feed.
      const responseAuctions = snapshot.auctions
        .filter((auction) => isActiveAt(auction, now));
      const opportunities = responseAuctions.map((auction) =>
        discoveryToOpportunity(auction, observedAt),
      );
      const persistence = await persistSnapshotOnce(snapshot, now);

      return Response.json(
        {
          data: opportunities,
          meta: {
            mode: "official-gsa-runner-snapshot",
            coverage: coverageForResponse(snapshot.coverage, responseAuctions),
            persistence,
            snapshot: {
              revision: snapshot.revision,
              generatedAt: snapshot.generatedAt,
              expiresAt: snapshot.expiresAt,
              imageExpiresAt: snapshot.imageExpiresAt,
              imagesFresh,
            },
            sourceHealth: {
              ...snapshot.sourceHealth,
              status: "stale",
              cache: "stale-fallback",
              staleSince: snapshot.generatedAt,
              ageSeconds: Math.max(
                0,
                Math.floor((now - Date.parse(snapshot.generatedAt)) / 1_000),
              ),
              lastErrorCode: directErrorCode,
              delivery: "github-branch-snapshot",
              liveBidPolling: false,
            },
          },
        },
        {
          headers: publicApiHeaders({
            "Cache-Control": "no-store",
            Warning: '110 - "Official GSA snapshot; live refresh unavailable"',
          }),
        },
      );
    } catch (snapshotError) {
      const snapshotErrorCode =
        snapshotError instanceof GsaRunnerSnapshotError
          ? snapshotError.code
          : "GSA_RUNNER_SNAPSHOT_UNKNOWN_ERROR";
      return Response.json(
        {
          data: [],
          meta: {
            mode: "official-sources-unavailable",
            coverage: null,
            sourceHealth: {
              status: "unavailable",
              lastErrorCode: `${directErrorCode}__${snapshotErrorCode}`,
              discoveryCadence: "hourly",
            },
          },
        },
        {
          headers: publicApiHeaders({
            "Cache-Control": "no-store",
            Warning: '110 - "Official GSA feeds unavailable"',
          }),
        },
      );
    }
  }
}
