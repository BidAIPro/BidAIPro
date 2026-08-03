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
- click any record to open a complete underwriting popup, including profit rank, item facts, research coverage, unresolved intelligence, pawn and retail exits, dealer references, demand, sale speed, bid ladder, every cost, bid history, comparables, risks, and a pre-bid checklist;
- open any record directly on its source site and audit every retained input against the original listing;
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

Unique items do not require a one-for-one twin. When exact matches are unavailable, at least five stable, dated, materially similar completed sales may form a separately labeled **near-match analog** tier. Analog evidence must have a 65%+ supplied match score plus either an explicit analog label or strong title-token overlap. It receives a configurable 40% uncertainty reserve and needs stronger recent-sale volume to pass the demand gate. Analog pricing is never used for precious-metal melt decisions.

Resale popularity is separate from auction popularity. When an authorized resale feed supplies a current sold count, active count, and optional median days to sell, BidAI Pro calculates `sell-through = sold / (sold + active)` and a disclosed 0–100 liquidity score. The popularity display follows an evidence ladder: verified resale demand first, external product-interest counts second, matched eBay active-market presence third, source-auction bid activity fourth, and unknown last. Every fallback is named in the list and item dossier. ShopGoodwill bid counts remain labeled auction activity and are never presented as eBay sell-through. When completed sales are unavailable, active used offers from eBay can form a used-price consensus after at least five close title matches survive validation. Those asking prices are labeled separately, receive a configurable 30% haircut before planning calculations, and never masquerade as sold prices or verified sell-through.

The free eBay [Finding API](https://developer.ebay.com/support/kb-article?KBid=1445) supplies the default broad active-used fallback using a developer App ID directly—no paid provider, client secret, or OAuth token is needed for this pricing step. Approved eBay partners can opt into the newer Browse transport, but BidAI Pro does not require that approval for pricing. Close matches remain the preferred eBay tier. If those are sparse, the same free response can form a separately labeled title or category asking-price analog from at least five offers and two sellers, with a 55%–65% reserve and no safe ceiling. eBay's sales-history [Marketplace Insights API is restricted](https://developer.ebay.com/api-docs/buy/ref-marketplace-supported.html), so the repository keeps its separate authorized completed-sales integration and never fabricates sold data.

The paid Google Shopping connector remains optional rather than the default. SearchAPI and SerpApi results can add another merchant set, but the zero-cost eBay path runs independently when no paid shopping key is configured. Review counts are shown only as product-interest evidence and never converted into sell-through or sale speed.

For games, consoles, cards, comics, Funko, LEGO, coins, and similar supported collectibles, the optional [PriceCharting Prices API](https://www.pricecharting.com/api-documentation) can supply a current guide value, retailer buy value, retailer sell value, and yearly unit volume. The title match must clear the same strict identity gate. The current guide receives a configurable 15% planning reserve. Retailer buy/sell values remain dealer references—not pawn quotes—while raw yearly unit volume can independently prove retail demand. PriceCharting requires a paid API subscription and reports current values rather than historical prices.

For source titles that explicitly provide gold/silver purity and gram weight, the ShopGoodwill collector attaches a live USD spot scenario from [Gold API](https://gold-api.com/docs). Pawn candidates must describe one precious-metal material only. Gold-plus-silver, palladium, platinum, rhodium, steel, brass, copper, mixed/two-tone wording, stones, gems, pearls, enamel, watch movements, leather/resin, plated, filled, vermeil, overlay, bonded, clad, washed, rolled, and electroplated material are hard rejected. They receive a `$0` ceiling even if a stale stored estimate exists. Accepted single-metal listings still show the stated karat/fineness and require independent purity and net-weight testing. The pawn model starts from 95% recoverable gross melt; its default likely cash case is 50% of that adjusted melt, with a displayed 35%–65% range and a $10 testing reserve. The safe ceiling always uses the low case. This is a planning estimate, not an appraisal or guaranteed offer.

Every item now receives two deliberately separate outputs. **The bid-safe decision** keeps the strict two-gate YES/NO model. **Gate one: pawn.** A pawn ceiling exists only when fresh precious-metal spot data can be combined with source-stated purity and weight; ordinary used-retail prices and dealer buy guides never become pawn estimates. **Gate two: retail.** A retail price can come from exact-model completed sales, a matched specialty guide, multi-source used offers, or a deeply discounted new-retail proxy—but it receives a safe bid ceiling only when an independent demand score also passes. **The retail-value outlook** is shown whenever an independent price exists, even if demand is still unproven. It reports the observed range, midpoint retail value, conservative value after the source-specific reserve, estimated net proceeds, midpoint and conservative profit at the observed bid, price-based break-even, and a clearly labeled provisional limit.

The default retail demand threshold is 55/100 and is adjustable. A retail route that has price evidence but fails demand keeps its **NO SAFE BID** answer and no target-safe ceiling, but no longer hides the useful price math. Its separate retail-value decision says whether the conservative price supports profit, is positive but below target, survives only at the unreserved midpoint, or remains below landed cost. A route that passes demand still must clear all acquisition costs, marketplace fees, shipping, condition reserves, minimum profit, and target margin. Active listings, auction bids, and product reviews cannot pass demand by themselves.

Profit and ceiling calculations expose inbound shipping, tax, buyer premium, marketplace fees, outbound shipping, repair/testing reserve, and return/loss reserve. The **target-safe ceiling** preserves the configured minimum profit and margin using a decision-qualified exit. The separately labeled **provisional retail limit** applies the price source's uncertainty reserve and all configured costs but is never called safe until demand passes. The **modeled break-even bid** marks where estimated profit reaches zero; it is a boundary, not a recommended bid. If the source omits inbound shipping, the calculation uses the clearly labeled, user-configurable conservative estimate instead of silently assuming zero.

The evidence-weighted queue orders active records by decision tier: pawn-safe YES, retail-safe YES, conservative retail-value leads, qualified routes below target, priced but uncertain/loss cases, then unpriced records. **Top profit is a ranking view, not a hiding filter:** all matching category records remain visible, with safe decisions first and unpriced listings last. Dedicated **Highest resale value** and **Most popular** views sort their respective measures from highest to lowest, place missing values last, and keep the evidence type visible on every row. A provisional price or sub-50 ranking score never overrides a NO. Clicking a row opens its complete dossier in a popup, while the separate source-listing control goes directly to the real auction. **Closing ≤ 5 min** preserves the same ranking inside the five-minute window.

## Automatic refreshes

The repository includes a scheduled GitHub Actions pipeline that runs in GitHub's cloud even when your computer is off. ShopGoodwill is built in: each due discovery pass reads the real public bid catalog, imports up to the source's 10,000-result broad-search cap, fans out across every discovered top-level category, and adds priority discovery for footwear, watches, rings and jewelry, hats, collectibles, electronics, and authenticated-sneaker wording. It does not require an Apify account or a private feed secret. The dashboard displays real listing thumbnails, counted parent-category filters, and a clickable category coverage ledger.

The normal check interval is configurable from 15 minutes to six hours, and the inside-30-minute interval is configurable from five to 15 minutes. The final five minutes are permanently locked to 30-second checks, and the final minute is permanently locked to five-second checks. GitHub's five-minute schedule wakes a runner, which stays active for these sub-minute item checks. Bid history keeps the first observation and only strictly higher bids; unchanged and lower prices do not add price points, but every successful request advances the separate `lastCheckedAt` time so the UI can prove when pricing was most recently checked. Final status and price may still be recorded so the learning loop receives the real outcome. GitHub scheduled starts and source response time can delay any best-effort interval.

After pushing, **Refresh published data** reloads the newest completed `data/live-snapshots.js` with cache bypass and requires no token. To force a new collection instead of waiting for the schedule, use **Run collection on GitHub** and GitHub's normal signed-in workflow UI. A token is requested inside BidAI Pro only when you deliberately use the advanced forms to write repository variables or dispatch Actions through the GitHub API; ordinary dashboard refresh never requests or stores one.

The hourly workflow also runs bounded, failure-isolated public collectors for HiBid, LiveAuctioneers, GovDeals, Public Surplus, PropertyRoom, Proxibid, and BidSpotter using public lot pages or published sitemaps. eBay auction discovery uses its official Browse API when the optional client secret and production approval are present; price research can still use the App-ID-only Finding route. Marketplace cards report **connected**, **collector ready**, **temporarily unavailable**, or **authorization required** from the last real check; a blocked site does not stop other sources or erase retained records. Invaluable remains authorization-only because its published partner API uploads auction catalogs rather than exposing a public listing-read feed.

For any other marketplace or as a fallback, use **Add authorized feed** on a marketplace card to save an Apify Task ID, Dataset ID, or non-secret HTTPS feed URL as the `BIDAI_SOURCE_CONFIG_JSON` repository variable. A card becomes connected only after real records are successfully ingested. The controls do not invent an endpoint or bypass provider authorization. Configure sensitive credentials as GitHub Actions secrets:

- `BIDAI_APIFY_TOKEN` — required when a configured private Dataset is read or an Apify Task is started;
- `BIDAI_SOURCE_CONFIG_JSON` — use a secret instead of the UI variable when the JSON contains a signed or otherwise sensitive feed URL;
- `BIDAI_SOURCE_AUTHORIZED=true` — required for secret-based optional source configuration; a non-empty repository variable is authorized by the workflow explicitly.

The schedule controls write two non-sensitive repository variables: `BIDAI_NORMAL_REFRESH_MINUTES` and `BIDAI_NEAR_CLOSE_REFRESH_MINUTES`. They cannot change the locked final-five-minute or final-minute rules.

To populate real resale medians and velocity, configure an approved completed-sales provider:

- `BIDAI_RESALE_SOURCE_AUTHORIZED=true` — permission gate for the resale request;
- `BIDAI_RESALE_FEED_URL` — HTTPS batch endpoint that returns exact-model completed sales plus current sold/active counts;
- `BIDAI_RESALE_FEED_TOKEN` — optional bearer token for that endpoint.

To enable the zero-cost pricing stack, create an eBay developer application and add this repository secret:

- `BIDAI_EBAY_CLIENT_ID` — eBay production App ID (Client ID). This alone enables free Finding API pricing.

The scheduled workflow runs this enrichment on the hourly/manual pass and after a GitHub Desktop push. Push deployments reuse the last published auction snapshot instead of blocking on a full catalog crawl, then price up to 250 stale product groups before deployment; hourly runs price up to 100. Duplicate auction listings share one result. The App ID is never written to the repository or public snapshot. `BIDAI_EBAY_CLIENT_SECRET` remains optional for the separate eBay auction-source collector or an approved Browse integration; set `BIDAI_EBAY_USE_BROWSE=true` only after eBay grants that production access.

### Independent-price rule

The observed auction bid is an acquisition cost, never a resale comparable. BidAI Pro shows a resale number only when it can cite independent evidence: matched completed sales, at least five matched used offers, a multi-merchant retail set, a specialty price guide, verified precious-metal inputs, the stored public-web research ledger, or a clearly labeled eBay/Google market analog. Exact and close matches are preferred. Broader title/category asking analogs are reference-only, receive a 55%–65% reserve, and cannot create a safe bid ceiling. Every priced item retains source links, observation time, sample size, range, and the reserve applied to that source.

Paid or specialty providers remain optional:

- `BIDAI_SEARCHAPI_KEY` — preferred SearchAPI key for Google Shopping research. SearchAPI is used when both shopping-provider keys are present;
- `BIDAI_SERPAPI_KEY` — alternate SerpApi key for the same Google Shopping research path;
- `BIDAI_PRICECHARTING_TOKEN` — paid PriceCharting API token; the default workflow checks at most 20 eligible stale specialty targets per run and respects the provider's request pacing.

Listings with the same normalized query share one API response, so duplicate products do not consume duplicate calls. Credentials remain in GitHub Actions secrets and provider tokens are never written to the public data file.

The one-time setup walkthrough is in [`docs/PRICE_API_SETUP.md`](docs/PRICE_API_SETUP.md).

Each configured Apify Task is a collector that you create and authorize in Apify. BidAI Pro can start that task when its marketplace is due, wait for a successful run, import the resulting Dataset, and retain unmatched records from every other market. The original single-source `BIDAI_APIFY_DATASET_ID` and `BIDAI_FEED_URL` secrets remain supported.

Setup, the built-in ShopGoodwill source, the completed-sales contract, the multi-source configuration format, the flat item schema, and generic feed details are in `docs/AUTOMATION.md`. Apify Datasets are paged in 5,000-record batches and the normalized catalog retains up to 50,000 real listings. The interface never fills an unconnected marketplace or resale channel with fabricated listings or prices.

## Data-source boundary

This repository does not automate bidding. ShopGoodwill discovery and near-close checks use the same public buyer catalog services that support its browse and item pages; additional markets are delegated to Apify Tasks or HTTPS feeds that the repository owner configures. BidAI Pro performs adaptive orchestration, normalization, retention, learning, and direct source linking. “Source-stated authentication” means only that the listing used explicit wording such as “authenticated” or “COA”; it is not an independent authentication. Recommendations are decision support, not guarantees; verify authenticity, condition, taxes, fees, shipping, and resale restrictions before bidding.
