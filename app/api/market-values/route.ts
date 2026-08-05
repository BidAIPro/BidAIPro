import { env } from "cloudflare:workers";
import { resolveMarketValuationBatch } from "../../../lib/market-valuation";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

// GitHub Pages statically emits this route only as an unused placeholder; the
// Pages client calls the live Sites API origin configured at build time.
export const revalidate = 300;
export const OPTIONS = publicApiPreflight;

const MAX_BATCH_SIZE = 12;
const EXTERNAL_ID = /^[a-z0-9:_-]{1,128}$/i;

function requestedIds(request: Request): string[] {
  const raw = new URL(request.url).searchParams.get("ids") ?? "";
  return [...new Set(
    raw.split(",").map((value) => value.trim()).filter((value) => EXTERNAL_ID.test(value)),
  )].slice(0, MAX_BATCH_SIZE);
}

export async function GET(request: Request) {
  const ids = requestedIds(request);
  if (!ids.length) {
    return Response.json(
      {
        data: [],
        meta: {
          requested: 0,
          resolved: 0,
          refreshed: 0,
          generatedAt: new Date().toISOString(),
        },
        errors: [{ externalId: "", code: "VALID_EXTERNAL_IDS_REQUIRED" }],
      },
      {
        status: 400,
        headers: publicApiHeaders({ "Cache-Control": "no-store" }),
      },
    );
  }

  try {
    const result = await resolveMarketValuationBatch(env.DB, ids);
    return Response.json(result, {
      headers: publicApiHeaders({ "Cache-Control": "no-store" }),
    });
  } catch {
    return Response.json(
      {
        data: [],
        meta: {
          requested: ids.length,
          resolved: 0,
          refreshed: 0,
          generatedAt: new Date().toISOString(),
        },
        errors: ids.map((externalId) => ({
          externalId,
          code: "MARKET_VALUATION_TEMPORARILY_UNAVAILABLE",
        })),
      },
      {
        status: 503,
        headers: publicApiHeaders({
          "Cache-Control": "no-store",
          "Retry-After": "60",
        }),
      },
    );
  }
}
