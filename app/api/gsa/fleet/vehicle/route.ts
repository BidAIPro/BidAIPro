import {
  fetchGsaFleetVehicleDetail,
  GsaFleetClientError,
} from "../../../../../lib/gsa-fleet-client.ts";
import {
  publicApiHeaders,
  publicApiPreflight,
} from "../../../../../lib/public-api-cors.ts";

export const revalidate = 60;
export const OPTIONS = publicApiPreflight;

function validIdentifier(value: string): boolean {
  return /^[A-Z0-9_ -]{3,64}$/.test(value);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const vin = params.get("vin")?.trim().toUpperCase() ?? "";
  const saleNumber = params.get("saleNumber")?.trim().toUpperCase() ?? "";
  if (!validIdentifier(vin) || !validIdentifier(saleNumber)) {
    return Response.json(
      { data: null, error: { code: "INVALID_FLEET_VEHICLE", message: "VIN and sale number are required." } },
      { status: 400, headers: publicApiHeaders({ "Cache-Control": "no-store" }) },
    );
  }
  try {
    const detail = await fetchGsaFleetVehicleDetail(vin, {
      signal: AbortSignal.timeout(12_000),
    });
    if (detail.saleNumber && detail.saleNumber.toUpperCase() !== saleNumber) {
      throw new GsaFleetClientError(
        "GSA_FLEET_DETAIL_SALE_MISMATCH",
        "The public GSA Fleet detail record belongs to a different sale.",
      );
    }
    return Response.json(
      {
        data: {
          sourceId: detail.sourceId,
          vin: detail.vin,
          saleNumber: detail.saleNumber,
          images: detail.images,
          comments: detail.comments,
          conditionReportUrl: detail.conditionReportUrl,
          openRecallCount: detail.openRecallCount,
          bodyStyle: detail.bodyStyle,
          series: detail.series,
          transmission: detail.transmission,
          drivetrain: detail.drivetrain,
          currentBidCents: detail.highBidCents,
          endsAt: detail.effectiveEndsAt,
          observedAt: detail.observedAt,
        },
      },
      {
        headers: publicApiHeaders({
          "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
        }),
      },
    );
  } catch (error) {
    const sourceCode = error instanceof GsaFleetClientError
      ? error.code
      : "GSA_FLEET_DETAIL_UNAVAILABLE";
    return Response.json(
      {
        data: null,
        error: {
          code: sourceCode,
          message: "The official GSA Fleet gallery is temporarily unavailable.",
        },
      },
      { status: 502, headers: publicApiHeaders({ "Cache-Control": "no-store" }) },
    );
  }
}
