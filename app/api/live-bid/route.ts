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

function errorResponse(status: number, code: string, message: string): Response {
  const headers = publicApiHeaders({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (status === 503 || status === 504) headers.set("Retry-After", "15");

  return Response.json(
    { data: null, error: { code, message } },
    { status, headers },
  );
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
          "X-Data-Freshness": "live",
        }),
      },
    );
  } catch (error) {
    if (error instanceof PpmsLiveBidError) {
      if (error.code === "GSA_PPMS_LIVE_NOT_FOUND") {
        return errorResponse(
          404,
          "GSA_AUCTION_NOT_FOUND",
          "The requested GSA auction was not found.",
        );
      }
      if (error.code === "GSA_PPMS_LIVE_TIMEOUT") {
        return errorResponse(
          504,
          "GSA_LIVE_BID_TIMEOUT",
          "The official GSA live bid service did not respond in time.",
        );
      }
      if (error.upstreamStatus === 429 || error.upstreamStatus === 503) {
        return errorResponse(
          503,
          "GSA_LIVE_BID_UNAVAILABLE",
          "The official GSA live bid service is temporarily unavailable.",
        );
      }
    }

    return errorResponse(
      502,
      "GSA_LIVE_BID_INVALID_RESPONSE",
      "A verified live bid could not be read from the official GSA response.",
    );
  }
}
