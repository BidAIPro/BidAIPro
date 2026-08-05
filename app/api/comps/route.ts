import { env } from "cloudflare:workers";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

export const revalidate = 300;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";

interface ComparableRow {
  id: string;
  canonical_url: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  mileage: number | null;
  condition: string | null;
  state: string | null;
  closed_high_bid_cents: number;
  awarded_price_cents: number | null;
  award_status: string;
  outcome_status: string;
  ended_at: string;
}

export async function GET() {
  try {
    const result = await env.DB.prepare(
      `SELECT id, canonical_url, year, make, model, trim, mileage, condition,
        state, closed_high_bid_cents, awarded_price_cents, award_status,
        outcome_status, ended_at
       FROM comparable_sales
       WHERE closed_high_bid_cents > 0
         AND outcome_status IN ('closed-high-bid', 'closed-high-bid-official-catalog')
       ORDER BY ended_at DESC
       LIMIT 100`,
    ).all<ComparableRow>();

    return Response.json(
      {
        data: result.results ?? [],
        meta: {
          status: "available",
          count: result.results?.length ?? 0,
          semantics: "Only terminal closed high bids are listed. They are not awarded sale prices unless award_status is confirmed; official closed-catalog rows are labeled in outcome_status.",
        },
      },
      { headers: publicApiHeaders({ "Cache-Control": CACHE_CONTROL }) },
    );
  } catch {
    return Response.json(
      {
        data: [],
        meta: {
          status: "unavailable",
          count: 0,
          semantics: "The comparable ledger is initializing or temporarily unavailable.",
        },
      },
      { headers: publicApiHeaders({ "Cache-Control": "no-store" }) },
    );
  }
}
