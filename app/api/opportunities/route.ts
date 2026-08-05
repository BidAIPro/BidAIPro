import { env } from "cloudflare:workers";
import { getGsaVehicleAuctions, GsaClientError } from "../../../lib/gsa-client";
import {
  fetchGsaRunnerSnapshot,
  GsaRunnerSnapshotError,
} from "../../../lib/gsa-runner-snapshot";
import type { GsaRunnerSnapshot } from "../../../lib/gsa-runner-snapshot";
import type { GsaCoverage, GsaVehicleAuction } from "../../../lib/gsa-normalizer";
import { persistGsaDiscovery } from "../../../lib/gsa-persistence";
import {
  applyValuationToOpportunity,
  discoveryToOpportunity,
} from "../../../lib/opportunity-adapter";
import type { AuctionOpportunity } from "../../../lib/auction-types";
import {
  buildGsaFleetComparableIndex,
  buildGsaFleetOutcomeValuation,
  gsaFleetComparableCandidates,
  gsaFleetComparableCandidatesForSubject,
  gsaFleetListingToOpportunity,
  type GsaFleetComparableIndex,
} from "../../../lib/gsa-fleet-adapter";
import {
  enrichGsaFleetVehicleDetails,
  fetchGsaFleetActiveListings,
  fetchGsaFleetClosedResults,
  GsaFleetClientError,
  type GsaFleetVehicleDetail,
} from "../../../lib/gsa-fleet-client";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

export const revalidate = 300;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=300, stale-if-error=600";

interface FleetBoardSnapshot {
  opportunities: AuctionOpportunity[];
  advertisedActiveCount: number;
  visibleCount: number;
  activeInternetCount: number;
  comingCount: number;
  closedOutcomeCount: number;
  observedAt: string;
  detailSucceeded: number;
  comparableIndex: GsaFleetComparableIndex;
}

let fleetBoardCache: { expiresAt: number; value: FleetBoardSnapshot } | null = null;
let fleetBoardRequest: Promise<FleetBoardSnapshot> | null = null;

async function buildFleetBoard(now: Date): Promise<FleetBoardSnapshot> {
  if (fleetBoardCache && fleetBoardCache.expiresAt > now.getTime()) {
    return fleetBoardCache.value;
  }
  if (fleetBoardRequest) return fleetBoardRequest;

  fleetBoardRequest = (async () => {
    const [active, closed] = await Promise.all([
      fetchGsaFleetActiveListings({
        now,
        pageSize: 10_000,
        maxRows: 10_000,
        signal: AbortSignal.timeout(25_000),
      }),
      fetchGsaFleetClosedResults({
        now,
        pageSize: 25_000,
        maxRows: 25_000,
        signal: AbortSignal.timeout(25_000),
      }),
    ]);
    const index = buildGsaFleetComparableIndex(closed.rows);
    const visibleRows = active.rows.filter((row) =>
      row.phase === "coming" || row.phase === "active"
    );
    const activeInternet = visibleRows
      .filter((row) => row.phase === "active" && row.channel === "internet" && row.vin)
      .slice(0, 100);
    let details = new Map<string, GsaFleetVehicleDetail>();
    let detailSucceeded = 0;
    if (activeInternet.length) {
      try {
        const enriched = await enrichGsaFleetVehicleDetails(activeInternet, {
          now,
          concurrency: 6,
          maxVehicles: 100,
          signal: AbortSignal.timeout(12_000),
        });
        details = new Map(enriched.vehicles.flatMap((item) =>
          item.detail ? [[item.listing.sourceId, item.detail] as const] : []
        ));
        detailSucceeded = enriched.succeeded;
      } catch {
        // A complete listing is still returned if optional dossier enrichment fails.
      }
    }
    const opportunities = visibleRows.map((row) =>
      gsaFleetListingToOpportunity(
        row,
        gsaFleetComparableCandidates(row, index),
        details.get(row.sourceId),
      )
    );
    const value: FleetBoardSnapshot = {
      opportunities,
      advertisedActiveCount: active.advertisedCount,
      visibleCount: visibleRows.length,
      activeInternetCount: visibleRows.filter((row) =>
        row.channel === "internet" && row.phase === "active"
      ).length,
      comingCount: visibleRows.filter((row) => row.phase === "coming").length,
      closedOutcomeCount: index.all.length,
      observedAt: active.observedAt,
      detailSucceeded,
      comparableIndex: index,
    };
    fleetBoardCache = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  })().finally(() => {
    fleetBoardRequest = null;
  });
  return fleetBoardRequest;
}

function combinedCoverage(
  gsaCoverage: GsaCoverage | null,
  gsaCount: number,
  fleet: FleetBoardSnapshot | null,
) {
  return {
    ...(gsaCoverage ?? {}),
    vehicleLots: gsaCount + (fleet?.visibleCount ?? 0),
    sources: {
      gsaAuctions: gsaCount,
      gsaFleet: fleet?.visibleCount ?? 0,
      gsaFleetAdvertised: fleet?.advertisedActiveCount ?? 0,
      gsaFleetActiveInternet: fleet?.activeInternetCount ?? 0,
      gsaFleetComing: fleet?.comingCount ?? 0,
      gsaFleetClosedOutcomes: fleet?.closedOutcomeCount ?? 0,
      gsaFleetDetails: fleet?.detailSucceeded ?? 0,
    },
  };
}

function attachFleetOutcomeEvidence(
  auction: GsaVehicleAuction,
  opportunity: AuctionOpportunity,
  index: GsaFleetComparableIndex,
  observedAt: string,
): AuctionOpportunity {
  const subject = {
    id: opportunity.id,
    externalId: opportunity.externalId,
    sourceUrl: opportunity.sourceUrl,
    title: opportunity.title,
    year: auction.year,
    make: auction.make,
    modelLabel: auction.modelLabel,
    vin: auction.vin,
    mileage: auction.mileage,
    bodyType: auction.bodyType,
    condition: auction.condition,
    operability: auction.operability,
    damageFlags: auction.damageFlags,
    issueFlags: auction.issueFlags,
  };
  const evidence = buildGsaFleetOutcomeValuation(
    subject,
    gsaFleetComparableCandidatesForSubject(subject, index),
    observedAt,
  );
  if (evidence.valuation.status === "unavailable") return opportunity;
  return applyValuationToOpportunity(
    opportunity,
    evidence.valuation,
    observedAt,
    evidence.terminalOutcomes,
  );
}

function combinedSourceHealth(
  gsaHealth: Record<string, unknown>,
  gsaLiveBidPolling: boolean,
  fleet: FleetBoardSnapshot | null,
) {
  const fleetLive = (fleet?.activeInternetCount ?? 0) > 0;
  return {
    ...gsaHealth,
    status: fleet ? "live" : gsaHealth.status,
    liveBidPolling: gsaLiveBidPolling || fleetLive,
    liveBidPollingBySource: {
      "gsa-auctions": gsaLiveBidPolling,
      "gsa-fleet": fleetLive,
    },
    fleetObservedAt: fleet?.observedAt ?? null,
  };
}

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
  const requestNow = new Date();
  const fleetRequest = buildFleetBoard(requestNow)
    .then((data) => ({ data, errorCode: null as string | null }))
    .catch((error) => ({
      data: null,
      errorCode: error instanceof GsaFleetClientError
        ? error.code
        : "GSA_FLEET_UNKNOWN_ERROR",
    }));
  try {
    const discovery = await getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY });
    const now = Date.now();
    const activeAuctions = discovery.auctions.filter((auction) => isActiveAt(auction, now));
    let gsaOpportunities = activeAuctions.map((auction) =>
      discoveryToOpportunity(auction, discovery.sourceHealth.observedAt),
    );
    const fleet = await fleetRequest;
    if (fleet.data) {
      gsaOpportunities = gsaOpportunities.map((opportunity, index) =>
        attachFleetOutcomeEvidence(
          activeAuctions[index]!,
          opportunity,
          fleet.data!.comparableIndex,
          discovery.sourceHealth.observedAt,
        )
      );
    }
    const opportunities = [
      ...gsaOpportunities,
      ...(fleet.data?.opportunities ?? []),
    ];
    const gsaCoverage = coverageForResponse(discovery.coverage, activeAuctions);
    const gsaLive = discovery.sourceHealth.sourceMode === "ppms-public-catalog";

    return Response.json(
      {
        data: opportunities,
        meta: {
          mode: fleet.data
            ? "official-gsa-auctions-and-fleet"
            : "official-gsa-public-catalog",
          coverage: combinedCoverage(
            gsaCoverage,
            activeAuctions.length,
            fleet.data,
          ),
          sourceHealth: {
            ...combinedSourceHealth(
              discovery.sourceHealth as unknown as Record<string, unknown>,
              gsaLive,
              fleet.data,
            ),
            fleetErrorCode: fleet.errorCode,
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
      let opportunities = responseAuctions.map((auction) =>
        discoveryToOpportunity(auction, observedAt),
      );
      const persistence = await persistSnapshotOnce(snapshot, now);
      const fleet = await fleetRequest;
      if (fleet.data) {
        opportunities = opportunities.map((opportunity, index) =>
          attachFleetOutcomeEvidence(
            responseAuctions[index]!,
            opportunity,
            fleet.data!.comparableIndex,
            observedAt,
          )
        );
      }
      const combinedOpportunities = [
        ...opportunities,
        ...(fleet.data?.opportunities ?? []),
      ];
      const gsaCoverage = coverageForResponse(snapshot.coverage, responseAuctions);

      return Response.json(
        {
          data: combinedOpportunities,
          meta: {
            mode: fleet.data
              ? "official-gsa-fleet-with-gsa-auctions-snapshot"
              : "official-gsa-runner-snapshot",
            coverage: combinedCoverage(
              gsaCoverage,
              responseAuctions.length,
              fleet.data,
            ),
            persistence,
            snapshot: {
              revision: snapshot.revision,
              generatedAt: snapshot.generatedAt,
              expiresAt: snapshot.expiresAt,
              imageExpiresAt: snapshot.imageExpiresAt,
              imagesFresh,
            },
            sourceHealth: {
              ...combinedSourceHealth(
                {
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
                },
                false,
                fleet.data,
              ),
              cache: "stale-fallback",
              fleetErrorCode: fleet.errorCode,
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
      const fleet = await fleetRequest;
      const snapshotErrorCode =
        snapshotError instanceof GsaRunnerSnapshotError
          ? snapshotError.code
          : "GSA_RUNNER_SNAPSHOT_UNKNOWN_ERROR";
      if (fleet.data) {
        return Response.json(
          {
            data: fleet.data.opportunities,
            meta: {
              mode: "official-gsa-fleet-only",
              coverage: combinedCoverage(null, 0, fleet.data),
              sourceHealth: combinedSourceHealth(
                {
                  status: "live",
                  lastErrorCode: `${directErrorCode}__${snapshotErrorCode}`,
                  discoveryCadence: "hourly",
                },
                false,
                fleet.data,
              ),
            },
          },
          { headers: publicApiHeaders({ "Cache-Control": CACHE_CONTROL }) },
        );
      }
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
