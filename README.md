# BidAI Pro

BidAI Pro is a private-first auction intelligence workspace for evaluating resale opportunities. It estimates landed cost, conservative resale value, expected profit, risk, demand, and a maximum rational bid from published research, authorized feeds, and snapshots you provide.

The GitHub Pages version is intentionally dependency-free: it runs entirely in the browser, stores your workspace on the current device, and does not send listing data to a server.

## Publish with GitHub Desktop

The local repository is:

`C:\Users\zk861\OneDrive\Documents\GitHub\BidAIPro`

1. Open GitHub Desktop.
2. If the repository is not already shown, choose **File -> Add local repository** and select the folder above.
3. Review the files in the **Changes** tab.
4. Enter a summary such as `Build BidAI Pro auction intelligence dashboard`.
5. Click **Commit to main**, then **Push origin**.
6. On GitHub, open **Settings -> Pages** and select **GitHub Actions** as the source if needed.

The published site will normally be available at:

`https://bidaipro.github.io/BidAIPro/`

## Use it locally

Open `index.html` in a browser. There is no install or build step.

You can:

- review the checked-in point-in-time ShopGoodwill research pass, with each listing timestamped and linked back to its source;
- open any record directly on its source site and inspect observation age, bid history, exact-model auction outcomes, completed resale evidence, resale velocity, pawn scenarios, and its full cost stack;
- record a single auction snapshot;
- import repeated CSV or JSON snapshots to build price history;
- mark ended auctions with an actual final price so calibration can improve;
- keep a local watchlist and risk settings;
- export the complete browser workspace as JSON for backup.

Data is stored in browser `localStorage`. Clearing browser data removes it, so export backups regularly.

## Snapshot inputs

The importer accepts CSV or JSON. Common CSV headers include:

`id,source_key,source,title,category,model_key,url,current_bid,shipping,bid_count,ends_at,source_estimate,resale_low,resale_median,resale_high,demand,rarity,identity_confidence,condition_confidence,status,final_price,observed_at`

Money values are in US dollars. Confidence values can be decimals such as `0.82` or percentages such as `82`.

## Production forecast rules

BidAI Pro keeps the observed bid, a source-provided price estimate, and a learned closing forecast separate. A source estimate is visible for audit but cannot create expected-profit rankings. A monetary closing forecast is shown only when it is backed by at least five completed **auction-close outcomes** with the same normalized `modelKey`. Completed resale sales support resale valuation; they never count toward the auction-close threshold.

When five or more same-model auction records include both the earlier bid and matching hours-to-close, BidAI Pro estimates the terminal price from those historical closing curves. Otherwise it uses the same-model completed-auction price distribution. The displayed interval is the 20th-to-80th percentile range, never a fixed uplift. Broader category outcomes are reference-only and are not used to price the selected item.

A source forecast must use the status `available`, `ready`, or `verified`; provide a non-empty `modelVersion`; include a positive, coherent interval where `low <= expected <= high`; and identify at least five exact-model auction-close outcomes within its sample. The app independently revalidates those outcomes before treating the forecast as available.

When at least three qualifying exact-model resale sales exist, decision calculations use their empirical P20, median, and P80 values. The interface also reports the arithmetic average, but the median remains the profit anchor because it is less sensitive to unusually high or low sales. The P20 value is the quick-sale target. Explicit source resale fields remain available for audit, but they do not override qualifying completed-sale evidence or promote an unsupported item.

Resale popularity is separate from auction popularity. When an authorized resale feed supplies a current sold count, active count, and optional median days to sell, BidAI Pro calculates `sell-through = sold / (sold + active)` and a disclosed 0–100 liquidity score. ShopGoodwill bid counts remain labeled auction activity and are never presented as eBay sell-through. When completed sales are unavailable, the optional eBay connector can collect at least five closely matched **active used fixed-price or best-offer** listing totals. Those asking prices are labeled separately, receive a configurable 30% haircut before planning calculations, and never masquerade as sold prices or verified sell-through.

The public [eBay Browse API](https://developer.ebay.com/api-docs/buy/api-browse.html) supplies the active-used fallback using eBay's official [`conditions:{USED}` filter](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html). It requires an eBay application access token created from [OAuth client credentials](https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html). eBay's sales-history [Marketplace Insights API is restricted and not open to new users](https://developer.ebay.com/api-docs/buy/ref-marketplace-supported.html), so the repository keeps its separate authorized completed-sales integration and never fabricates sold data.

For source titles that explicitly provide gold/silver purity and gram weight, the ShopGoodwill collector attaches a live USD spot scenario from [Gold API](https://gold-api.com/docs). The pawn model starts from 95% recoverable gross melt, or 75% when stones, movements, straps, or other non-metal weight may be present. Its default likely cash case is 50% of that adjusted melt, with a displayed 35%–65% range and a $10 testing reserve. The safe ceiling always uses the low case. Every percentage is editable because an actual shop may test, discount, reject, or offer outside the range; this is a planning estimate, not an appraisal or guaranteed offer. A separately authorized feed may still attach tested intrinsic evidence under the stricter contract in [docs/AUTOMATION.md](docs/AUTOMATION.md#intrinsic-14k-gold-evidence).

Every item is evaluated as two separate exit paths. A qualifying direct pawn sale is checked first. If that route does not preserve the configured profit target, BidAI Pro checks the online route using exact-model completed sales or the conservative active-used fallback. A metal item can therefore switch to online resale when its collector or retail value supports profit but its estimated pawn offer does not. The interface shows the evidence, likely proceeds, likely profit at the observed bid, resale popularity, modeled sale likelihood, target-safe ceiling, and modeled break-even bid for both routes.

Profit and ceiling calculations expose inbound shipping, tax, buyer premium, marketplace fees, outbound shipping, repair/testing reserve, and return/loss reserve. The **target-safe ceiling** preserves the configured minimum profit and margin using the conservative exit case. The higher **modeled break-even bid** uses the likely exit case and marks where estimated profit reaches zero; it is a boundary, not a recommended bid. Both are always visible and become `$0` when no defensible real-price evidence exists. If the source omits inbound shipping, the calculation uses the clearly labeled, user-configurable $25 conservative estimate instead of silently assuming zero. The default queue ranks target-safe pawn exits first, target-safe online exits next by popularity and profit, then positive but below-target opportunities. **Closing ≤ 5 min** preserves that ranking inside the five-minute window.

## Automatic refreshes

The repository includes a scheduled GitHub Actions pipeline that runs in GitHub's cloud even when your computer is off. ShopGoodwill is built in: the hourly discovery pass reads the real public bid catalog, imports up to the source's 10,000-result broad-search cap, and adds priority discovery for footwear, watches, rings and jewelry, hats, collectibles, electronics, and authenticated-sneaker wording. It does not require an Apify account or a private feed secret. The dashboard displays real listing thumbnails and lets you filter those resale verticals and source-stated authentication claims.

Every source is checked hourly, known auctions inside 30 minutes are checked every five minutes, and a GitHub runner stays active to poll item details every 30 seconds inside the final five-minute window. Bid history keeps the first observation and only strictly higher bids; unchanged and lower prices do not create snapshots. Final status and price may still be recorded so the learning loop receives the real outcome.

After pushing, open **Actions > Refresh authorized auction data > Run workflow** once if you do not want to wait for the next hourly discovery. For additional marketplaces, configure these GitHub Actions secrets:

- `BIDAI_SOURCE_CONFIG_JSON` — a JSON array describing up to 20 marketplace sources and their Apify Task, Dataset, or authorized feed;
- `BIDAI_APIFY_TOKEN` — required when a configured private Dataset is read or an Apify Task is started;
- `BIDAI_SOURCE_AUTHORIZED=true` — the exact permission-gate value required before collection or import is attempted.

To populate real resale medians and velocity, configure an approved completed-sales provider:

- `BIDAI_RESALE_SOURCE_AUTHORIZED=true` — permission gate for the resale request;
- `BIDAI_RESALE_FEED_URL` — HTTPS batch endpoint that returns exact-model completed sales plus current sold/active counts;
- `BIDAI_RESALE_FEED_TOKEN` — optional bearer token for that endpoint.

To populate real active-used averages and medians as the fallback tier, create an eBay developer application, obtain the [production access eBay requires for Buy APIs](https://developer.ebay.com/api-docs/buy/static/buy-requirements.html), and add these repository secrets:

- `BIDAI_EBAY_CLIENT_ID` — eBay production application client ID;
- `BIDAI_EBAY_CLIENT_SECRET` — matching eBay production client secret.

The scheduled workflow runs this enrichment on the hourly/manual pass, obtains a short-lived OAuth token at runtime, and stays under the documented default Browse API call budget by processing at most 150 stale targets per run. It stores neither credential nor token in the repository. With no credentials or production approval, the step is a byte-stable no-op and the app continues to show `$0` for unsupported online-resale ceilings.

Each configured Apify Task is a collector that you create and authorize in Apify. BidAI Pro can start that task when its marketplace is due, wait for a successful run, import the resulting Dataset, and retain unmatched records from every other market. The original single-source `BIDAI_APIFY_DATASET_ID` and `BIDAI_FEED_URL` secrets remain supported.

Setup, the built-in ShopGoodwill source, the completed-sales contract, the multi-source secret format, the flat item schema, and generic feed details are in `docs/AUTOMATION.md`. Apify Datasets are paged in 5,000-record batches and the normalized catalog retains up to 50,000 real listings. The interface never fills an unconnected marketplace or resale channel with fabricated listings or prices.

## Data-source boundary

This repository does not automate bidding. ShopGoodwill discovery and near-close checks use the same public buyer catalog services that support its browse and item pages; additional markets are delegated to Apify Tasks or HTTPS feeds that the repository owner configures. BidAI Pro performs adaptive orchestration, normalization, retention, learning, and direct source linking. “Source-stated authentication” means only that the listing used explicit wording such as “authenticated” or “COA”; it is not an independent authentication. Recommendations are decision support, not guarantees; verify authenticity, condition, taxes, fees, shipping, and resale restrictions before bidding.
