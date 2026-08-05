import { env } from "cloudflare:workers";
import { getGsaVehicleAuctions, GsaClientError } from "../../../lib/gsa-client";
import { discoveryToOpportunity } from "../../../lib/opportunity-adapter";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";
import { SEED_AUCTIONS } from "../../../lib/seed-auctions";

export const revalidate = 3600;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400";

export async function GET() {
  try {
    const discovery = await getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY });
    const active = discovery.auctions
      .filter((auction) => auction.status === "active")
      .map((auction) => discoveryToOpportunity(auction, discovery.sourceHealth.observedAt));
    const opportunities = active;

    return Response.json(
      {
        data: opportunities,
        meta: {
          mode: "official-hourly-feed",
          coverage: discovery.coverage,
          sourceHealth: discovery.sourceHealth,
        },
      },
      { headers: publicApiHeaders({ "Cache-Control": CACHE_CONTROL }) },
    );
  } catch (error) {
    const errorCode = error instanceof GsaClientError ? error.code : "GSA_UNKNOWN_ERROR";
    const now = Date.now();
    const activeReferenceSnapshot = SEED_AUCTIONS.filter(
      (auction) => auction.endsAt !== null && Date.parse(auction.endsAt) > now,
    );
    return Response.json(
      {
        data: activeReferenceSnapshot,
        meta: {
          mode: "last-known-demo-snapshot",
          coverage: null,
          sourceHealth: {
            status: "unavailable",
            lastErrorCode: errorCode,
            discoveryCadence: "hourly",
          },
        },
      },
      {
        headers: publicApiHeaders({
          "Cache-Control": "no-store",
          Warning: '110 - "Official GSA feed unavailable"',
        }),
      },
    );
  }
}
