import {
  fetchPpmsLiveBid,
  isValidPpmsAuctionId,
  PpmsLiveBidError,
} from "../../../lib/gsa-ppms-live-bid.ts";
import {
  publicApiHeaders,
  publicApiPreflight,
} from "../../../lib/public-api-cors.ts";

export const revalidate = 10;
export const OPTIONS = publicApiPreflight;

const LIVE_CACHE_CONTROL = "public, max-age=0, s-maxage=10, must-revalidate";
const API_VERSION = "2026-08-05.2";

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
  const id = new URL(request.url).searchParams.get("id");
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
