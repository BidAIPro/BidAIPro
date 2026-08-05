import { env } from "cloudflare:workers";
import { publicApiHeaders, publicApiPreflight } from "../../../lib/public-api-cors";

export const revalidate = 300;

export const OPTIONS = publicApiPreflight;

const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";

interface ComparableRow {
  id: string;
  source_key: string;
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
  comparable_price_cents: number;
  price_basis: "official-awarded-price" | "terminal-high-bid";
  award_status: string;
  outcome_status: string;
  ended_at: string;
}

export async function GET() {
  try {
    const result = await env.DB.prepare(
      `SELECT id, source_key, canonical_url, year, make, model, trim, mileage, condition,
        state, closed_high_bid_cents, awarded_price_cents,
        CASE WHEN source_key = 'gsa-fleet'
          THEN awarded_price_cents ELSE closed_high_bid_cents END AS comparable_price_cents,
        CASE WHEN source_key = 'gsa-fleet'
          THEN 'official-awarded-price' ELSE 'terminal-high-bid' END AS price_basis,
        award_status, outcome_status, ended_at
       FROM comparable_sales
       WHERE (
         source_key = 'gsa-auctions'
         AND closed_high_bid_cents > 0
         AND outcome_status IN ('closed-high-bid', 'closed-high-bid-official-catalog')
       ) OR (
         source_key = 'gsa-fleet'
         AND awarded_price_cents > 0
         AND award_status = 'confirmed'
         AND outcome_status = 'awarded-price-official-gsa-fleet'
       )
       ORDER BY ended_at DESC
       LIMIT 100`,
    ).all<ComparableRow>();

    return Response.json(
      {
        data: result.results ?? [],
        meta: {
          status: "available",
          count: result.results?.length ?? 0,
          semantics: "GSA Auctions rows are terminal displayed high bids and are not awards unless separately confirmed. GSA Fleet rows expose official awarded winning-bid or sale-proceeds amounts, carry award_status confirmed, and retain any displayed high bid separately.",
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
