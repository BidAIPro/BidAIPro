import {
  fetchPpmsLiveBid,
  isValidPpmsAuctionId,
  PpmsLiveBidError,
} from "../../../lib/gsa-ppms-live-bid.ts";
import {
  publicApiHeaders,
  publicApiPreflight,
} from "../../../lib/public-api-cors.ts";
import {
  fetchGsaFleetVehicleActivity,
  GsaFleetClientError,
} from "../../../lib/gsa-fleet-client.ts";
import type { AuctionStatus } from "../../../lib/auction-types.ts";

export const revalidate = 10;
export const OPTIONS = publicApiPreflight;

const LIVE_CACHE_CONTROL = "public, max-age=0, s-maxage=10, must-revalidate";
const API_VERSION = "2026-08-05.3";

interface UpstreamDiagnostic {
  sourceCode: string;
  upstreamStatus: number | null;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  diagnostic?: UpstreamDiagnostic,
): Response {
  const headers = publicApiHeaders({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-BidAI-API-Version": API_VERSION,
  });
  if (status === 503 || status === 504) headers.set("Retry-After", "15");

  return Response.json(
    {
      data: null,
      error: {
        code,
        message,
        ...(diagnostic ? { diagnostic } : {}),
      },
    },
    { status, headers },
  );
}

function upstreamDiagnostic(error: unknown): UpstreamDiagnostic | null {
  if (error instanceof PpmsLiveBidError) {
    return {
      sourceCode: error.code,
      upstreamStatus: error.upstreamStatus,
    };
  }
  if (error === null || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; upstreamStatus?: unknown };
  if (
    typeof candidate.code !== "string" ||
    !candidate.code.startsWith("GSA_PPMS_LIVE_")
  ) {
    return null;
  }
  return {
    sourceCode: candidate.code,
    upstreamStatus:
      typeof candidate.upstreamStatus === "number" &&
      Number.isInteger(candidate.upstreamStatus)
        ? candidate.upstreamStatus
        : null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const source = searchParams.get("source") ?? "gsa-auctions";
  if (source === "gsa-fleet") {
    const vin = searchParams.get("vin")?.trim().toUpperCase() ?? "";
    const saleNumber = searchParams.get("saleNumber")?.trim().toUpperCase() ?? "";
    if (!/^[A-Z0-9_ -]{3,64}$/.test(vin)) {
      return errorResponse(
        400,
        "INVALID_FLEET_VIN",
        "A valid GSA Fleet VIN or manufacturer serial is required.",
      );
    }
    if (!/^[A-Z0-9_ -]{3,64}$/.test(saleNumber)) {
      return errorResponse(
        400,
        "INVALID_FLEET_SALE_NUMBER",
        "A valid GSA Fleet sale number is required.",
      );
    }
    try {
      const activity = await fetchGsaFleetVehicleActivity(vin, saleNumber, {
        signal: AbortSignal.timeout(9_000),
        forceRefresh: true,
      });
      const now = Date.parse(activity.observedAt);
      const startsAt = activity.detail.startsAt
        ? Date.parse(activity.detail.startsAt)
        : Number.NaN;
      const endsAt = activity.effectiveEndsAt
        ? Date.parse(activity.effectiveEndsAt)
        : Number.NaN;
      const status: AuctionStatus = Number.isFinite(endsAt) && endsAt <= now
        ? "ended"
        : Number.isFinite(startsAt) && startsAt > now
          ? "preview"
          : "active";
      const observations = activity.bidHistory.bids
        .map((bid) => ({
          observedAt: bid.bidAt,
          currentBidCents: bid.amountCents,
        }))
        .sort((left, right) =>
          Date.parse(left.observedAt) - Date.parse(right.observedAt)
        );
      return Response.json(
        {
          data: {
            externalId: `gsa-fleet:${activity.detail.sourceId}`,
            status,
            currentBidCents: activity.currentBidCents,
            // totalBids is bid activity, not a count of distinct bidders.
            bidderCount: null,
            endsAt: activity.effectiveEndsAt,
            lastCheckedAt: activity.observedAt,
            subjectBidObservations: observations,
            totalBids: activity.bidHistory.totalBids,
            bidHistoryKind: activity.bidHistory.kind,
          },
        },
        {
          status: 200,
          headers: publicApiHeaders({
            "Cache-Control": LIVE_CACHE_CONTROL,
            "Content-Type": "application/json; charset=utf-8",
            "X-BidAI-API-Version": API_VERSION,
            "X-Data-Freshness": "live",
          }),
        },
      );
    } catch (error) {
      const diagnostic = error instanceof GsaFleetClientError
        ? { sourceCode: error.code, upstreamStatus: error.upstreamStatus }
        : { sourceCode: "GSA_FLEET_LIVE_UNEXPECTED_ERROR", upstreamStatus: null };
      console.error("gsa_fleet_live_bid_failed", { vin, ...diagnostic });
      return errorResponse(
        diagnostic.upstreamStatus === 404 ? 404 : 502,
        diagnostic.upstreamStatus === 404
          ? "GSA_FLEET_VEHICLE_NOT_FOUND"
          : "GSA_FLEET_LIVE_BID_UNAVAILABLE",
        diagnostic.upstreamStatus === 404
          ? "The requested GSA Fleet vehicle was not found."
          : "A verified GSA Fleet live bid could not be read from the official public response.",
        diagnostic,
      );
    }
  }
  if (source !== "gsa-auctions") {
    return errorResponse(
      400,
      "INVALID_AUCTION_SOURCE",
      "The requested auction source is not supported.",
    );
  }

  const id = searchParams.get("id");
  if (!isValidPpmsAuctionId(id)) {
    return errorResponse(
      400,
      "INVALID_AUCTION_ID",
      "A positive numeric GSA auction id is required.",
    );
  }

  try {
    const snapshot = await fetchPpmsLiveBid(id);
    return Response.json(
      { data: snapshot },
      {
        status: 200,
        headers: publicApiHeaders({
          "Cache-Control": LIVE_CACHE_CONTROL,
          "Content-Type": "application/json; charset=utf-8",
          "X-BidAI-API-Version": API_VERSION,
          "X-Data-Freshness": "live",
        }),
      },
    );
  } catch (error) {
    const diagnostic = upstreamDiagnostic(error);
    if (diagnostic) {
      // Log only bounded diagnostic facts. Never serialize the exception,
      // request headers, response body, URL, environment, or credentials.
      console.error("gsa_live_bid_failed", { auctionId: id, ...diagnostic });
      if (diagnostic.sourceCode === "GSA_PPMS_LIVE_NOT_FOUND") {
        return errorResponse(
          404,
          "GSA_AUCTION_NOT_FOUND",
          "The requested GSA auction was not found.",
          diagnostic,
        );
      }
      if (diagnostic.sourceCode === "GSA_PPMS_LIVE_TIMEOUT") {
        return errorResponse(
          504,
          "GSA_LIVE_BID_TIMEOUT",
          "The official GSA live bid service did not respond in time.",
          diagnostic,
        );
      }
      if (
        diagnostic.upstreamStatus === 429 ||
        diagnostic.upstreamStatus === 503
      ) {
        return errorResponse(
          503,
          "GSA_LIVE_BID_UNAVAILABLE",
          "The official GSA live bid service is temporarily unavailable.",
          diagnostic,
        );
      }
      return errorResponse(
        502,
        "GSA_LIVE_BID_INVALID_RESPONSE",
        "A verified live bid could not be read from the official GSA response.",
        diagnostic,
      );
    }

    const unexpectedDiagnostic: UpstreamDiagnostic = {
      sourceCode: "GSA_PPMS_LIVE_UNEXPECTED_ERROR",
      upstreamStatus: null,
    };
    console.error("gsa_live_bid_failed", {
      auctionId: id,
      ...unexpectedDiagnostic,
    });
    return errorResponse(
      502,
      "GSA_LIVE_BID_INVALID_RESPONSE",
      "A verified live bid could not be read from the official GSA response.",
      unexpectedDiagnostic,
    );
  }
}
