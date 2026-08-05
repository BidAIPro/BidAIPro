import { env } from "cloudflare:workers";
import {
  GSA_AUCTIONS_ENDPOINT,
  GSA_PUBLIC_FEED_LIMITATIONS,
  GsaClientError,
  getGsaVehicleAuctions,
} from "../../../../lib/gsa-client";

export const revalidate = 3600;

const SUCCESS_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400";

export async function GET(): Promise<Response> {
  try {
    const result = await getGsaVehicleAuctions({ apiKey: env.GSA_API_KEY });
    const headers = new Headers({
      "Cache-Control": SUCCESS_CACHE_CONTROL,
      "Content-Type": "application/json; charset=utf-8",
      "X-Data-Freshness": result.sourceHealth.status,
      "X-GSA-Source-Status": result.sourceHealth.status,
    });

    if (result.sourceHealth.status === "stale") {
      headers.set("Warning", '110 - "GSA Auctions data is stale"');
    }

    return Response.json(
      {
        data: result.auctions,
        meta: {
          coverage: result.coverage,
          sourceHealth: result.sourceHealth,
        },
      },
      { status: 200, headers },
    );
  } catch (error) {
    const code = error instanceof GsaClientError ? error.code : "GSA_UNKNOWN_ERROR";

    return Response.json(
      {
        data: [],
        meta: {
          coverage: null,
          sourceHealth: {
            source: "GSA Auctions API",
            official: true,
            endpoint: GSA_AUCTIONS_ENDPOINT,
            status: "unavailable",
            discoveryCadence: "hourly",
            lastErrorCode: code,
            limitations: [...GSA_PUBLIC_FEED_LIMITATIONS],
          },
        },
        error: {
          code: "GSA_DISCOVERY_UNAVAILABLE",
          message: "Official GSA vehicle discovery is temporarily unavailable.",
        },
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "300",
          "X-GSA-Source-Status": "unavailable",
        },
      },
    );
  }
}
