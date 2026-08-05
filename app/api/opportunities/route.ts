import { env } from "cloudflare:workers";
import { getGsaVehicleAuctions, GsaClientError } from "../../../lib/gsa-client";
import {
  fetchGsaRunnerSnapshot,
  GsaRunnerSnapshotError,
} from "../../../lib/gsa-runner-snapshot";
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

export async function GET() {
  try {
    const discovery = await getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY });
    const now = Date.now();
    const active = discovery.auctions
      .filter((auction) => isActiveAt(auction, now))
      .map((auction) => discoveryToOpportunity(auction, discovery.sourceHealth.observedAt));
    const opportunities = active;

    return Response.json(
      {
        data: opportunities,
        meta: {
          mode: "official-gsa-public-catalog",
          coverage: discovery.coverage,
          sourceHealth: discovery.sourceHealth,
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
      const opportunities = snapshot.auctions
        .filter((auction) => isActiveAt(auction, now))
        .map((auction) =>
          discoveryToOpportunity(
            imagesFresh ? auction : { ...auction, imageUrl: null, images: [] },
            observedAt,
          ),
        );

      return Response.json(
        {
          data: opportunities,
          meta: {
            mode: "official-gsa-runner-snapshot",
            coverage: snapshot.coverage,
            snapshot: {
              revision: snapshot.revision,
              generatedAt: snapshot.generatedAt,
              expiresAt: snapshot.expiresAt,
              imageExpiresAt: snapshot.imageExpiresAt,
              imagesFresh,
            },
            sourceHealth: {
              ...snapshot.sourceHealth,
              status: "live",
              cache: "refresh",
              ageSeconds: Math.max(
                0,
                Math.floor((now - Date.parse(snapshot.generatedAt)) / 1_000),
              ),
              lastErrorCode: directErrorCode,
              delivery: "github-actions-snapshot",
            },
          },
        },
        { headers: publicApiHeaders({ "Cache-Control": CACHE_CONTROL }) },
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
