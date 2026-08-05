import { env } from "cloudflare:workers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
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
import { compactOpportunityForBoard } from "../../../lib/opportunity-presentation";
import { applyLiveBidSnapshot } from "../../../lib/live-bid-snapshot";
import {
  persistDealBoardSnapshot,
  readDealBoardSnapshot,
  readDealBoardSnapshotFreshness,
  readDealBoardSnapshotOpportunity,
  rebuildDealBoardSnapshot,
  runWithDealBoardSnapshotLease,
  scheduleDealBoardSnapshotTask,
  type BuiltDealBoardSnapshot,
} from "../../../lib/deal-board-snapshot";
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
  fetchGsaFleetVehicleDetail,
  GsaFleetClientError,
  type GsaFleetVehicleDetail,
  type GsaFleetVehicleRecord,
} from "../../../lib/gsa-fleet-client";
import { resolveGsaFleetComparableIndex } from "../../../lib/gsa-fleet-comparable-store";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

export const revalidate = 300;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=300, stale-if-error=600";
const DETAIL_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=300";
const DIRECT_GSA_DEADLINE_MS = 18_000;
const ON_DEMAND_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
const WARM_SNAPSHOT_MINIMUM_FRESH_MS = 35 * 60_000;

function scheduleSnapshotRebuild(): boolean {
  return scheduleDealBoardSnapshotTask(
    getRequestExecutionContext(),
    () => runWithDealBoardSnapshotLease(
      env.DB,
      () => rebuildDealBoardSnapshot(env.DB, {
        apiKey: env.GSA_API_KEY,
        signal: AbortSignal.timeout(55_000),
      }),
    ),
  );
}

function scheduleComputedSnapshot(
  opportunities: AuctionOpportunity[],
  metadata: Record<string, unknown>,
  now: Date,
  gsaInventoryMode: BuiltDealBoardSnapshot["gsaInventoryMode"],
  upstreamExpiresAt: string,
): void {
  if (opportunities.length === 0) return;
  const upstreamExpiryMs = Date.parse(upstreamExpiresAt);
  if (!Number.isFinite(upstreamExpiryMs) || upstreamExpiryMs <= now.getTime()) return;
  const generatedAt = now.toISOString();
  const expiresAt = new Date(
    Math.min(now.getTime() + ON_DEMAND_SNAPSHOT_MAX_AGE_MS, upstreamExpiryMs),
  ).toISOString();
  const originalSnapshot = metadata.snapshot !== null &&
      typeof metadata.snapshot === "object" &&
      !Array.isArray(metadata.snapshot)
    ? metadata.snapshot as Record<string, unknown>
    : {};
  scheduleDealBoardSnapshotTask(
    getRequestExecutionContext(),
    () => runWithDealBoardSnapshotLease(
      env.DB,
      () => persistDealBoardSnapshot(env.DB, {
        generatedAt,
        expiresAt,
        opportunities,
        gsaInventoryMode,
        metadata: {
          ...metadata,
          snapshot: {
            ...originalSnapshot,
            upstreamGeneratedAt: originalSnapshot.generatedAt ?? null,
            upstreamExpiresAt,
            generatedAt,
            refreshedAt: generatedAt,
            expiresAt,
          },
        },
      }),
      { skipFreshSnapshot: false },
    ),
  );
}

interface FleetBoardSnapshot {
  opportunities: AuctionOpportunity[];
  advertisedActiveCount: number;
  visibleCount: number;
  activeInternetCount: number;
  comingCount: number;
  closedOutcomeCount: number;
  observedAt: string;
  detailSucceeded: number;
  closedOutcomeErrorCode: string | null;
  comparableMode: "durable" | "recent-official-fallback" | "unavailable";
  activeInventoryErrorCode: string | null;
  cacheStatus: "refresh" | "stale-fallback";
  comparableIndex: GsaFleetComparableIndex;
  recordsByOpportunityId: Map<string, GsaFleetVehicleRecord>;
}

let fleetBoardCache: { expiresAt: number; value: FleetBoardSnapshot } | null = null;
let fleetBoardRequest: Promise<FleetBoardSnapshot> | null = null;

async function withinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GsaClientError(
          "GSA_DIRECT_DEADLINE",
          "The direct GSA Auctions catalog exceeded the route deadline.",
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function buildFleetBoard(db: D1Database, now: Date): Promise<FleetBoardSnapshot> {
  if (fleetBoardCache && fleetBoardCache.expiresAt > now.getTime()) {
    return fleetBoardCache.value;
  }
  if (fleetBoardRequest) return fleetBoardRequest;

  const previous = fleetBoardCache?.value ?? null;
  fleetBoardRequest = (async () => {
    // Load compact D1 outcomes before the public inventory fetch so their raw
    // response pages are never resident at the same time in a 128 MB Worker.
    const closedResult = await resolveGsaFleetComparableIndex(db, {
      now,
      signal: AbortSignal.timeout(20_000),
    })
      .then((data) => ({ data, errorCode: null as string | null }))
      .catch((error) => ({
        data: null,
        errorCode: error instanceof Error && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "GSA_FLEET_COMPARABLE_STORE_UNKNOWN_ERROR",
      }));
    const active = await fetchGsaFleetActiveListings({
      now,
      pageSize: 10_000,
      maxRows: 10_000,
      cacheResult: false,
      signal: AbortSignal.timeout(25_000),
    });
    if (active.rows.length === 0 || active.rows.length !== active.advertisedCount) {
      throw new GsaFleetClientError(
        "GSA_FLEET_ACTIVE_INCOMPLETE",
        "The public GSA Fleet inventory did not match its advertised count.",
      );
    }
    // Active/Coming Soon inventory is independently authoritative. Optional
    // closed-outcome evidence may be unavailable without hiding that inventory.
    const index = closedResult.data?.index ?? buildGsaFleetComparableIndex([]);
    const closedOutcomeErrorCode = closedResult.errorCode ??
      (closedResult.data?.rowCount ? null : "GSA_FLEET_COMPARABLE_STORE_EMPTY");
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
    const opportunities = visibleRows.map((row) => {
      const opportunity = gsaFleetListingToOpportunity(
        row,
        gsaFleetComparableCandidates(row, index),
        details.get(row.sourceId),
      );
      return opportunity.status === "active" || opportunity.status === "closing"
        ? opportunity
        : compactOpportunityForBoard(opportunity);
    });
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
      closedOutcomeErrorCode,
      comparableMode: closedResult.data?.mode ?? "unavailable",
      activeInventoryErrorCode: null,
      cacheStatus: "refresh" as const,
      comparableIndex: index,
      recordsByOpportunityId: new Map(
        visibleRows.map((row) => [`fleet-${row.sourceId}`, row]),
      ),
    };
    fleetBoardCache = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  })().catch((error) => {
    if (!previous) throw error;
    const fallback = {
      ...previous,
      cacheStatus: "stale-fallback" as const,
      activeInventoryErrorCode: error instanceof GsaFleetClientError
        ? error.code
        : "GSA_FLEET_ACTIVE_INVENTORY_UNKNOWN_ERROR",
    };
    // Avoid refetching a failing upstream on every request while keeping the
    // retry window short enough to recover promptly.
    fleetBoardCache = { expiresAt: Date.now() + 30_000, value: fallback };
    return fallback;
  }).finally(() => {
    fleetBoardRequest = null;
  });
  return fleetBoardRequest;
}

function requestedOpportunityId(request?: Request): string | null {
  if (!request) return null;
  try {
    const value = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    return value && value.length <= 160 ? value : null;
  } catch {
    return null;
  }
}

async function opportunitiesForResponse(
  opportunities: AuctionOpportunity[],
  requestedId: string | null,
  fleet: FleetBoardSnapshot | null,
): Promise<AuctionOpportunity[]> {
  if (!requestedId) return opportunities.map(compactOpportunityForBoard);
  const match = opportunities.find((item) =>
    item.id === requestedId || item.externalId === requestedId
  );
  if (!match) return [];
  if (match.source !== "gsa-fleet" || !fleet) return [match];

  const row = fleet.recordsByOpportunityId.get(match.id);
  if (!row?.vin) return [match];
  try {
    const detail = await fetchGsaFleetVehicleDetail(row.vin, {
      signal: AbortSignal.timeout(12_000),
    });
    if (
      detail.saleNumber && row.saleNumber &&
      detail.saleNumber.trim().toUpperCase() !== row.saleNumber.trim().toUpperCase()
    ) {
      return [match];
    }
    return [gsaFleetListingToOpportunity(
      row,
      gsaFleetComparableCandidates(row, fleet.comparableIndex),
      detail,
    )];
  } catch {
    // The already validated listing record is still a useful fallback when
    // the optional detail/gallery lookup is briefly unavailable.
    return [match];
  }
}

async function enrichPrecomputedFleetDetail(
  opportunity: AuctionOpportunity,
): Promise<AuctionOpportunity> {
  if (opportunity.source !== "gsa-fleet" || !opportunity.vehicle.vin) {
    return opportunity;
  }
  try {
    const detail = await fetchGsaFleetVehicleDetail(opportunity.vehicle.vin, {
      signal: AbortSignal.timeout(12_000),
    });
    const images = [...new Set([
      ...detail.images,
      opportunity.imageUrl,
      ...(opportunity.images ?? []),
    ].filter(Boolean))];
    const comments = detail.comments?.trim().replace(/\s+/g, " ") ?? "";
    const riskFlags = [...new Set([
      ...(opportunity.vehicle.riskFlags ?? []),
      ...(detail.openRecallCount
        ? [`${detail.openRecallCount} open recall${detail.openRecallCount === 1 ? "" : "s"} reported`]
        : []),
      ...(comments ? [comments.slice(0, 500)] : []),
    ])];
    const enriched = {
      ...opportunity,
      sourceUrl: detail.sourceUrl || opportunity.sourceUrl,
      imageUrl: images[0] ?? "",
      images,
      startsAt: detail.startsAt ?? opportunity.startsAt,
      saleNumber: detail.saleNumber ?? opportunity.saleNumber,
      vehicle: {
        ...opportunity.vehicle,
        trim: detail.series ?? opportunity.vehicle.trim,
        bodyStyle: detail.bodyStyle ?? opportunity.vehicle.bodyStyle,
        transmission: detail.transmission ?? opportunity.vehicle.transmission,
        fuelType: detail.fuelType ?? opportunity.vehicle.fuelType,
        drivetrain: detail.drivetrain ?? opportunity.vehicle.drivetrain,
        color: detail.color ?? opportunity.vehicle.color,
        description: comments || opportunity.vehicle.description,
        riskFlags,
      },
    };
    return applyLiveBidSnapshot(enriched, {
      externalId: enriched.externalId,
      status: enriched.status,
      currentBidCents: detail.highBidCents ?? enriched.currentBidCents,
      bidderCount: enriched.bidderCount,
      endsAt: detail.effectiveEndsAt ?? enriched.endsAt,
      lastCheckedAt: detail.observedAt,
    });
  } catch {
    return opportunity;
  }
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
    fleetClosedOutcomeErrorCode: fleet?.closedOutcomeErrorCode ?? null,
    fleetComparableMode: fleet?.comparableMode ?? "unavailable",
    fleetActiveInventoryErrorCode: fleet?.activeInventoryErrorCode ?? null,
    fleetCache: fleet?.cacheStatus ?? "unavailable",
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

export async function GET(request: Request) {
  const requestNow = new Date();
  const requestedId = requestedOpportunityId(request);
  try {
    const precomputed = requestedId
      ? await readDealBoardSnapshotOpportunity(env.DB, requestedId, requestNow)
      : await readDealBoardSnapshot(env.DB, requestNow);
    if (precomputed) {
      if (precomputed.stale && !requestedId) scheduleSnapshotRebuild();
      const responseData = requestedId && precomputed.data[0]
        ? [await enrichPrecomputedFleetDetail(precomputed.data[0])]
        : precomputed.data;
      return Response.json(
        { data: responseData, meta: precomputed.meta },
        { headers: publicApiHeaders({
          "Cache-Control": precomputed.stale
            ? "no-store"
            : requestedId ? DETAIL_CACHE_CONTROL : CACHE_CONTROL,
          "X-BidAI-Snapshot": precomputed.snapshotId,
          ...(precomputed.stale
            ? { Warning: '110 - "Precomputed official-source snapshot is stale"' }
            : {}),
        }) },
      );
    }
  } catch {
    // A missing migration or corrupt/partial cache must fall through to the
    // existing official-source path instead of taking the board offline.
  }
  const fleetRequest = buildFleetBoard(env.DB, requestNow)
    .then((data) => ({ data, errorCode: null as string | null }))
    .catch((error) => ({
      data: null,
      errorCode: error instanceof GsaFleetClientError
        ? error.code
        : "GSA_FLEET_UNKNOWN_ERROR",
    }));
  if (requestedId?.startsWith("fleet-")) {
    const fleet = await fleetRequest;
    if (fleet.data) {
      const data = await opportunitiesForResponse(
        fleet.data.opportunities,
        requestedId,
        fleet.data,
      );
      return Response.json(
        {
          data,
          meta: {
            mode: "official-gsa-fleet-detail",
            coverage: combinedCoverage(null, 0, fleet.data),
            sourceHealth: combinedSourceHealth(
              { status: "live", discoveryCadence: "hourly" },
              false,
              fleet.data,
            ),
          },
        },
        { headers: publicApiHeaders({ "Cache-Control": DETAIL_CACHE_CONTROL }) },
      );
    }
    return Response.json(
      {
        data: [],
        meta: {
          mode: "official-gsa-fleet-detail-unavailable",
          coverage: null,
          sourceHealth: {
            status: "unavailable",
            lastErrorCode: fleet.errorCode,
            discoveryCadence: "hourly",
          },
        },
      },
      { headers: publicApiHeaders({ "Cache-Control": "no-store" }) },
    );
  }
  try {
    const discovery = await withinDeadline(
      getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY }),
      DIRECT_GSA_DEADLINE_MS,
    );
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
    const responseOpportunities = await opportunitiesForResponse(
      opportunities,
      requestedId,
      fleet.data,
    );
    const completeBoardResponse = discovery.sourceHealth.status === "live" &&
      fleet.data !== null &&
      fleet.data.cacheStatus === "refresh" &&
      fleet.data.closedOutcomeErrorCode === null;
    const responseMeta = {
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
        partial: !completeBoardResponse,
      },
    };
    if (!requestedId && completeBoardResponse) {
      scheduleComputedSnapshot(
        opportunities,
        responseMeta,
        new Date(),
        "live",
        discovery.sourceHealth.cachedUntil,
      );
    }

    return Response.json(
      {
        data: responseOpportunities,
        meta: responseMeta,
      },
      { headers: publicApiHeaders({
        "Cache-Control": requestedId
          ? DETAIL_CACHE_CONTROL
          : completeBoardResponse ? CACHE_CONTROL : "no-store",
        ...(!requestedId && !completeBoardResponse
          ? { Warning: '110 - "One official board source is using fallback or incomplete evidence"' }
          : {}),
      }) },
    );
  } catch (error) {
    const directErrorCode = error instanceof GsaClientError ? error.code : "GSA_UNKNOWN_ERROR";
    try {
      const snapshot = await fetchGsaRunnerSnapshot();
      const now = Date.now();
      const observedAt = snapshot.sourceHealth.observedAt;
      const imagesFresh = Date.parse(snapshot.imageExpiresAt) > now;
      // Preserve any still-cached photo instead of blanking every card at the
      // safety cutoff. VehicleImage degrades cleanly when a signature is no
      // longer usable; imagesFresh remains explicit source-health metadata.
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
      const responseData = await opportunitiesForResponse(
        combinedOpportunities,
        requestedId,
        fleet.data,
      );
      const responseMeta = {
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
      };
      const completeRunnerBoardResponse = fleet.data !== null &&
        fleet.data.cacheStatus === "refresh" &&
        fleet.data.closedOutcomeErrorCode === null &&
        Number.isFinite(Date.parse(snapshot.expiresAt)) &&
        Date.parse(snapshot.expiresAt) > now;
      if (!requestedId && completeRunnerBoardResponse) {
        scheduleComputedSnapshot(
          combinedOpportunities,
          responseMeta,
          new Date(),
          "runner-snapshot",
          snapshot.expiresAt,
        );
      }
      return Response.json(
        {
          data: responseData,
          meta: responseMeta,
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
        const responseData = await opportunitiesForResponse(
          fleet.data.opportunities,
          requestedId,
          fleet.data,
        );
        const responseMeta = {
          mode: "official-gsa-fleet-only",
          coverage: combinedCoverage(null, 0, fleet.data),
          sourceHealth: combinedSourceHealth(
            {
              status: "partial",
              lastErrorCode: `${directErrorCode}__${snapshotErrorCode}`,
              discoveryCadence: "hourly",
            },
            false,
            fleet.data,
          ),
        };
        return Response.json(
          {
            data: responseData,
            meta: responseMeta,
          },
          { headers: publicApiHeaders({
            "Cache-Control": requestedId ? DETAIL_CACHE_CONTROL : "no-store",
            ...(!requestedId
              ? { Warning: '110 - "GSA Fleet-only response; GSA Auctions unavailable"' }
              : {}),
          }) },
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

function warmErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,120}$/.test(code)) return code;
  }
  return "DEAL_BOARD_SNAPSHOT_REBUILD_FAILED";
}

function warmHeaders(extra: HeadersInit = {}): Headers {
  const headers = publicApiHeaders(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

/** Public, idempotent warm-up action; durable D1 state throttles all callers. */
export async function POST(request: Request) {
  const now = new Date();
  try {
    if (new URL(request.url).searchParams.get("warm") !== "1") {
      return Response.json(
        { status: "invalid-action" },
        { status: 400, headers: warmHeaders() },
      );
    }
    const existing = await readDealBoardSnapshotFreshness(
      env.DB,
      now,
      WARM_SNAPSHOT_MINIMUM_FRESH_MS,
    );
    if (existing?.fresh) {
      return Response.json(
        { status: "fresh", snapshotId: existing.snapshotId, expiresAt: existing.expiresAt },
        { headers: warmHeaders() },
      );
    }

    const result = await runWithDealBoardSnapshotLease(
      env.DB,
      () => rebuildDealBoardSnapshot(env.DB, {
        now,
        apiKey: env.GSA_API_KEY,
        signal: AbortSignal.timeout(55_000),
      }),
      { now, skipFreshSnapshot: false },
    );
    const verified = await readDealBoardSnapshotFreshness(
      env.DB,
      new Date(),
      WARM_SNAPSHOT_MINIMUM_FRESH_MS,
    );
    if (result.status === "executed") {
      if (!verified?.fresh || verified.snapshotId !== result.value.snapshotId) {
        return Response.json(
          { status: "failed", errorCode: "DEAL_BOARD_SNAPSHOT_VERIFY_FAILED" },
          { status: 503, headers: warmHeaders() },
        );
      }
      return Response.json(
        { status: "rebuilt", snapshotId: verified.snapshotId, expiresAt: verified.expiresAt },
        { headers: warmHeaders() },
      );
    }
    if (verified?.fresh) {
      return Response.json(
        { status: "fresh", snapshotId: verified.snapshotId, expiresAt: verified.expiresAt },
        { headers: warmHeaders() },
      );
    }
    if (result.status === "cooldown") {
      const retrySeconds = Math.max(
        1,
        Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1_000),
      );
      return Response.json(
        { status: "cooldown", retryAt: result.retryAt },
        { status: 503, headers: warmHeaders({ "Retry-After": String(retrySeconds) }) },
      );
    }
    return Response.json(
      { status: result.status === "busy" ? "busy" : "not-rebuilt" },
      { status: 409, headers: warmHeaders({ "Retry-After": "15" }) },
    );
  } catch (error) {
    return Response.json(
      { status: "failed", errorCode: warmErrorCode(error) },
      { status: 503, headers: warmHeaders({ "Retry-After": "300" }) },
    );
  }
}
