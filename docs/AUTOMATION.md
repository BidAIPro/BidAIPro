# Automated multi-market collection and ingestion

BidAI Pro can collect the real ShopGoodwill public catalog directly and merge it with snapshots from multiple Apify Tasks, persistent Apify Datasets, and authorized HTTPS JSON feeds. The built-in ShopGoodwill source is enabled in the included workflow and does not use a token. Optional external sources run only when `BIDAI_SOURCE_AUTHORIZED` is exactly `true`.

The supported source modes are:

1. **Built-in ShopGoodwill catalog:** each due catalog pass reads the public bid search in 40-item pages, up to the source's 10,000-result broad-search cap, and adds dedicated discovery pools for footwear, watches, rings, hats, collectibles, electronics, and authenticated-sneaker wording. Near close, only known item-detail records are requested.
2. **Apify Task plus Dataset:** BidAI Pro starts a preconfigured Task when that market is due, waits for the run to succeed, and imports the run's Dataset.
3. **Persistent Apify Dataset:** BidAI Pro imports structured items already written by a separately scheduled collector.
4. **Generic JSON feed:** BidAI Pro imports an authorized HTTPS endpoint.
5. **Completed-sales enrichment:** after auction refreshes, BidAI Pro can send stale active listing identities to one explicitly authorized HTTPS resale provider and merge back exact-model completed sales and market counts.
6. **eBay active-used enrichment:** an optional official eBay Browse API step searches active fixed-price/best-offer listings with `conditions:{USED}`, accepts only closely title-matched USD results, and stores asking-price statistics separately from sold evidence.

BidAI Pro does not invent listing records. Every visible automated listing must arrive from the built-in ShopGoodwill public catalog or one of the configured sources and must retain its canonical source URL. Apify Actor and Task definitions are created and maintained in Apify; this repository only starts configured Tasks and consumes their structured output.

For any additional source, configure only an official API, licensed data feed, operator-approved endpoint, or another source you are authorized to access programmatically. The authorization switch is a deployment safeguard, not a substitute for that permission. Follow the feed owner's rate limits, data-retention requirements, and license terms.

## Built-in ShopGoodwill source

The workflow sets `BIDAI_SHOPGOODWILL_ENABLED=true`, `BIDAI_SHOPGOODWILL_CATALOG_LIMIT=10000`, and `BIDAI_SHOPGOODWILL_PRIORITY_LIMIT=200`. The first value activates the source; the second caps the broad nearest-close search; the third caps each priority search. The source service itself currently exposes at most 10,000 broad results to one search, so “all” means all records returned within that documented runtime cap plus the dedicated category searches—not a claim that every item in the marketplace is available through one query.

The collector stores the source ID, title, category path, current bid, bid count, end time, image, and direct item URL. It deliberately leaves shipping and resale value unknown unless a trustworthy feed supplies them. Its model key is a conservative exact normalization of the complete source title, including size and variant wording; it never groups merely similar category items. A closing forecast remains unavailable until five completed listings share that exact normalized title. The collector does not fabricate sold comparables or resale profit, so a real item can remain **Research** until exact-title auction outcomes, completed resale evidence, and cost inputs exist.

Authentication has three important boundaries:

- catalog text with explicit wording such as `authenticated`, `certificate of authenticity`, `COA`, or a named authentication service is labeled `source-stated`;
- that label records what the source listing says and is searchable/filterable in the interface;
- it is never presented as independent authentication, and the user must verify the authenticator, paperwork, identifiers, item, and return terms.

After pushing the workflow, open **Actions > Refresh authorized auction data > Run workflow** once for an immediate full discovery pass. No secret is required for the built-in source. To stop that source, change `BIDAI_SHOPGOODWILL_ENABLED` to `false` in `.github/workflows/refresh-auction-data.yml` and push the change.

## GitHub setup

In the GitHub repository, open **Settings > Secrets and variables > Actions**. Non-sensitive source configuration and cadence values can be repository variables; credentials, bearer tokens, and signed URLs must remain repository secrets. The legacy single-Dataset and single-feed setup remains available afterward.

### Multi-market mode

1. Create one Apify Task, Dataset, or authorized HTTPS feed per auction marketplace. Map every output to the flat item schema below.
2. Create `BIDAI_APIFY_TOKEN` when any configured Task must be started or any Dataset is private.
3. Create `BIDAI_SOURCE_CONFIG_JSON` as a repository variable containing up to 20 non-sensitive source objects. The in-app **Connect source** form can create or update this variable with a fine-grained GitHub token that has repository **Variables: write** permission.
4. When the configuration must be a secret because it contains a signed URL, create `BIDAI_SOURCE_CONFIG_JSON` as a repository secret instead and create `BIDAI_SOURCE_AUTHORIZED` with the exact value `true`. A non-empty repository variable is authorized explicitly by the included workflow.
5. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh. A manual run forces all configured Tasks to collect immediately.

Each source object accepts:

| Field | Required | Meaning |
| --- | --- | --- |
| `key` | yes | Stable lowercase marketplace key, such as `shopgoodwill`, `ebay`, or `hibid`. |
| `name` | yes | Human-readable marketplace name shown in the app. |
| `taskId` | one of these | Apify Task ID. When due, BidAI Pro starts it and imports the run Dataset. |
| `datasetId` | one of these | Persistent Apify Dataset ID. It can also accompany `taskId` so a not-yet-due Task can reuse its current Dataset. |
| `feedUrl` | one of these | Authorized HTTPS JSON endpoint. |

Example configuration value showing shape only (replace every placeholder with a real ID or endpoint):

```json
[
  {"key":"shopgoodwill","name":"ShopGoodwill","taskId":"YOUR_TASK_ID","datasetId":"YOUR_DATASET_ID"},
  {"key":"ebay","name":"eBay Auctions","datasetId":"YOUR_DATASET_ID"},
  {"key":"hibid","name":"HiBid","feedUrl":"https://YOUR_AUTHORIZED_ENDPOINT"}
]
```

`BIDAI_APIFY_DATASET_IDS` can hold comma- or newline-separated Dataset IDs, and `BIDAI_FEED_URLS` can hold newline-separated URLs or a JSON array. These list forms are convenient but receive generic source names; `BIDAI_SOURCE_CONFIG_JSON` is preferred because it preserves a stable marketplace key and display name.

### In-app cloud controls

The Sources view can dispatch `refresh-auction-data.yml` and update the repository's non-sensitive refresh variables through GitHub's REST API. Enter a fine-grained personal access token scoped to this repository with **Actions: write** and **Variables: write** permissions. BidAI Pro stores that token only in `sessionStorage`, so it is cleared when the browser tab/session ends; it is never written to `localStorage`, the generated data file, or the repository.

The schedule form writes:

- `BIDAI_NORMAL_REFRESH_MINUTES`: `15`, `30`, `60`, `120`, `240`, or `360`;
- `BIDAI_NEAR_CLOSE_REFRESH_MINUTES`: `5`, `10`, or `15` for auctions inside 30 minutes.

The final-five-minute 30-second rule and final-minute five-second rule are code-locked and cannot be changed by repository variables or the UI. The workflow still uses GitHub's five-minute scheduled wake-up; once awake for a known closing item, the runner remains active to perform the sub-minute checks.

### Apify Dataset mode

1. Configure and schedule an Apify collector separately and have it write one flat item per auction listing to a named, persistent Dataset.
2. Create a repository secret named `BIDAI_APIFY_DATASET_ID` containing the Dataset ID, not an Actor ID, task ID, run ID, or full URL.
3. For a private Dataset, create `BIDAI_APIFY_TOKEN` containing an Apify API token scoped to read that Dataset. The token is optional for a deliberately public Dataset.
4. Create `BIDAI_SOURCE_AUTHORIZED` with the exact value `true` only after source access has been authorized.
5. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh.

### Generic JSON feed mode

1. Obtain an HTTPS JSON endpoint that you have permission to use.
2. Create a repository secret named `BIDAI_FEED_URL` containing the full endpoint URL. A signed endpoint URL may be used; never put it in a tracked file.
3. Create `BIDAI_SOURCE_AUTHORIZED` with the exact value `true` only after permission has been confirmed.
4. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh.

Keep `BIDAI_APIFY_TOKEN`, signed feed URLs, and all other credentials in GitHub Actions secrets. `BIDAI_SOURCE_CONFIG_JSON` may be a repository variable only when its IDs and feed URLs are non-sensitive. Do not add credentials to workflow YAML, source files, generated snapshots, screenshots, or documentation. The legacy single-source mode gives `BIDAI_APIFY_DATASET_ID` precedence over `BIDAI_FEED_URL`.

### Completed-sales resale feed

The included `scripts/enrich-resale.mjs` step is a batch integration point for a licensed resale-data provider or approved eBay Marketplace Insights access. The public eBay Browse API exposes active listings, not a general completed-sales dataset; Marketplace Insights access is restricted. BidAI Pro therefore leaves resale price and velocity unavailable until this feed is connected.

Create these GitHub Actions secrets:

| Secret | Requirement |
| --- | --- |
| `BIDAI_RESALE_SOURCE_AUTHORIZED` | Must be exactly `true`; otherwise the step makes no request. |
| `BIDAI_RESALE_FEED_URL` | HTTPS endpoint accepting the batch request below. |
| `BIDAI_RESALE_FEED_TOKEN` | Optional bearer token. |

The workflow posts up to 500 stale active targets per run:

```json
{
  "generatedAt": "2026-08-02T15:00:00Z",
  "targets": [{
    "id": "shopgoodwill-123",
    "externalId": "123",
    "sourceKey": "shopgoodwill",
    "title": "source listing title",
    "category": "source category",
    "resaleVertical": "Electronics",
    "modelKey": "exact normalized model key",
    "url": "https://shopgoodwill.com/item/123"
  }]
}
```

The response may be an array or `{ "items": [...] }`. Each result must identify the target by `sourceKey` + `externalId` or by the exact `modelKey`, and supply `asOf`, `lookbackDays`, `soldListingCount`, `activeListingCount`, `channel`, optional `medianDaysToSell`, and at least three `comparableSales`. Every sale needs a stable ID or URL, USD sold price, completed timestamp, exact target model key, match score of at least 75, and source. Future, undated, active-only, mismatched, duplicated, and non-USD records are rejected.

The pipeline derives P20, median, P80, average in the browser, sell-through, and liquidity from that evidence. It never treats an active asking price as a sold comparable. If no authorized feed is configured, the step is a byte-stable no-op and the interface says the resale evidence is unavailable.

### eBay active-used asking-price fallback

The included `scripts/enrich-ebay-used.mjs` step uses the official eBay Browse API when completed-sale evidence is absent. It answers “what are comparable used items listed for online?” and is never described as a sold-price feed.

Create an eBay production application, complete eBay's required Buy API production-access process, then add these GitHub Actions secrets:

| Secret | Requirement |
| --- | --- |
| `BIDAI_EBAY_CLIENT_ID` | Production eBay application client ID. |
| `BIDAI_EBAY_CLIENT_SECRET` | Matching production client secret. |

The hourly/manual workflow requests a client-credentials OAuth token only at runtime, processes at most 150 stale targets per run to stay within eBay's default Browse API call limit, and searches the US marketplace by default. It requires at least five unique results that are USD-priced, explicitly returned as used/pre-owned, have stable eBay IDs and URLs, and share at least 65% of the significant target-title tokens with at least three tokens in common. Price totals include the lowest stated USD shipping charge. The browser revalidates the records, requires an observation no more than 24 hours old, displays P20/median/average/P80, and applies a default 30% haircut before any planning value or safe ceiling is calculated.

Active asking prices do not prove what an item will sell for and do not create a sell-through rate. Exact-model completed sales remain the preferred evidence tier. If credentials are missing, OAuth fails, fewer than five matches qualify, or eBay returns no usable result, the connector does not publish a value for that item. No credentials or access tokens are written to `data/live-snapshots.js`.

### Broad retail and specialty price research

The included `scripts/enrich-market-prices.mjs` step adds two independent optional providers on the hourly/manual workflow pass:

| Secret | Provider and purpose |
| --- | --- |
| `BIDAI_SERPAPI_KEY` | SerpApi Google Shopping results for broad used/refurbished and new-retail offer research. |
| `BIDAI_PRICECHARTING_TOKEN` | Paid PriceCharting current guide, retailer buy/sell, and yearly unit-volume evidence for supported specialty categories. |

SerpApi results must be USD-priced, have a stable public offer or product link, share at least 65% of significant target-title tokens with at least three tokens in common, and produce at least five qualifying offers from at least two merchants in the same condition group. Used/refurbished and new/unspecified offers are stored separately. New-retail prices never masquerade as used prices and receive a default 45% condition/resale haircut. Product rating and review counts are stored only as interest evidence; they do not create sell-through or modeled resale speed.

PriceCharting is queried only for eligible games, consoles, cards, comics, Funko, LEGO, coins, currency, and similar titles. Its best product result must clear the same 65% title-coverage gate. Penny-denominated values are converted to USD. The app keeps current guide value, retailer buy, retailer sell, condition basis, raw annual unit volume, match score, observation time, and a public provider-search link separate. A default 15% reserve applies to the guide value used for an online ceiling. Retailer buy/sell values are dealer references and never create a pawn estimate; reported annual sales volume can independently support the retail demand gate.

The default batch limits are 40 broad-market targets and 20 specialty targets. Broad results refresh after 23 hours; specialty values refresh after 47 hours. Missing credentials are a byte-stable no-op. Weak and empty results store only an `insufficient` state, never a guessed price. Provider tokens are used only by GitHub Actions and are never added to the published snapshot file.

### Pawn-first exit decision

The browser independently evaluates two strict gates for every item. The pawn gate exists only when valid fresh precious-metal evidence supplies spot price, source-stated purity, and source-stated weight. Used-retail prices, active listings, and dealer buy guides cannot become pawn estimates. The retail gate first establishes price from qualifying completed sales, a matched specialty guide, five sufficiently matched used offers, or five multi-merchant new-retail offers after the stronger replacement-cost haircut. It then requires a separate demand score of at least 55/100 by default.

ShopGoodwill title parsing rejects plated, filled, vermeil, overlay, bonded, clad, washed, rolled, and electroplated metal descriptions before generating a melt scenario. The browser repeats that negative-wording check against stored `metalEstimate` records, so an older or externally supplied solid-metal estimate cannot pass when the listing title explicitly describes a non-solid finish. Separately stated sterling may still be modeled as silver when gold-plated accents are excluded.

Retail demand evidence can be: validated sold-versus-active counts and optional time-to-sale; reported specialty-market annual unit volume; or sufficient recent exact-model completed-sale frequency. Three completed sales within 90 days establish a demand signal but score only 50/100 by default, so they do not pass alone. Five recent sales score above the default threshold. Active listings, merchant count, auction bids, product ratings, and reviews never count as completed-sale demand.

The recommendation hierarchy is:

1. Return **YES · Pawn profit** when the precious-metal pawn ceiling remains above the observed bid and preserves the configured profit and margin.
2. Otherwise return **YES · Retail profit** only when both the retail price gate and retail demand gate pass and the conservative retail ceiling remains above the observed bid.
3. Return **NO · Demand unproven** when price exists but the independent demand gate fails; the retail ceiling remains `$0`.
4. Return **NO · Margin too low** when an evidence-qualified route exists but the observed bid is already above its target-safe ceiling.
5. Return **NO · Evidence missing** when neither route qualifies.

Each route exposes its own likely cash or sale value, profit at the observed bid, target-safe ceiling, and modeled break-even bid. Pawn liquidity and online resale popularity remain separate signals. The selected route controls ranking, but the alternative route remains visible for comparison.

The queue applies that hierarchy before any score: pawn-safe YES, retail-safe YES, qualified-but-over-ceiling NO, demand-failed NO, and evidence-missing NO. A relative 0–100 ranking score orders records inside a tier. Approved routes receive scores of at least 50; a margin-failed route is capped at 49, a demand-failed route is capped at 24, and a record without a qualified route scores 0. The score cannot turn a NO into a YES.

Clicking a record opens a complete underwriting dossier in a modal. It shows the raw listing facts, weighted research coverage, unresolved inputs, acquisition stack, pawn range, retail range, net proceeds, demand proof, sale velocity, target-safe and break-even bids, profit at key bid levels, retained bid changes, attached comparable transactions, source links, listing-specific risks, and a pre-bid verification checklist. The separate source-listing control opens the real auction page. Missing values stay labeled unavailable instead of being inferred from unrelated categories.

The GitHub-hosted workflow has an hourly wake-up plus a five-minute wake-up. Due checks are decided from each item's `lastCheckedAt` and the configured normal/near-close intervals. When a known auction enters its final five minutes, that workflow run remains active and polls the source every 30 seconds; in the final minute it polls every five seconds through close, with a one-minute final-result grace period. A later due ShopGoodwill catalog pass also retries unresolved outcomes that ended within the prior 24 hours, up to 500 per run, so one delayed scheduled start does not automatically discard the final price. Up to four optional Tasks start concurrently; their Datasets are imported sequentially to keep history merges atomic. GitHub Actions scheduled starts can be delayed, so every interval is best effort and also depends on source response time.

The snapshot rule is intentionally strict: the first price observation is retained, and a later price observation is appended only when its current bid is strictly higher than the highest stored bid. Unchanged or lower bids do not advance `observedAt` and do not add bid history. Every successful check does advance `lastCheckedAt`, at both the item and envelope levels, so the published UI can distinguish “price last changed” from “source last checked.” A final status and final price may still be joined to the listing so the learning loop can score the auction outcome.

If neither a non-empty `BIDAI_SOURCE_CONFIG_JSON` repository variable nor a lowercase-`true` `BIDAI_SOURCE_AUTHORIZED` secret is present, optional Apify and feed sources are skipped; the built-in ShopGoodwill source still runs while its workflow switch is `true`. Removing the variable, or removing/changing the authorization secret used with secret-based configuration, stops optional sources. Disabling the built-in switch and removing all source configuration stops ingestion while leaving existing published snapshots intact.

## Flat item schema

An Apify Dataset item must be a flat JSON object, and a generic feed must expose the same kind of objects. Do not place listing fields inside `data`, `item`, `auction`, or other nested objects; map the collector output before BidAI Pro reads it. Arrays are used only for optional observation history, comparable-sale evidence, and prior-auction evidence. `forecast`, `valuationBasis`, `resaleMarket`, `askingMarket`, `retailMarket`, `specialtyMarket`, and `metalEstimate` are the supported nested analysis objects.

For Apify mode, `title` and a valid `observedAt` are required on every row. Generic feeds require `title` and may omit `observedAt`, though supplying it is strongly recommended. For stable, useful automated analysis, every collector result should provide these canonical fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `id` | string | Durable listing ID; reuse it on every refresh. |
| `sourceKey` | string | Stable marketplace key; prevents the same external ID on different sites from colliding. |
| `source` | string | Human-readable marketplace or feed name. |
| `title` | string | Listing title; required. |
| `url` | string | Canonical public HTTP(S) listing URL; required for the direct-listing interaction. `sourceUrl` and `listingUrl` are also accepted. |
| `category` | string | Broad category used for filtering. |
| `currentBid` | number | Current bid in US dollars, without currency symbols when possible. |
| `bidCount` | integer | Number of bids observed. |
| `endsAt` | ISO 8601 string | Scheduled auction end time, including a timezone. |
| `observedAt` | ISO 8601 string | Time this snapshot was captured, including a timezone. |
| `lastCheckedAt` | ISO 8601 string | Pipeline-managed time of the latest successful source check. Unlike `observedAt`, it advances even when the bid is unchanged. Feed values are not required. |
| `modelKey` | string | Normalized maker/model/variant key used to require like-for-like evidence; `compGroup` and `similarItemKey` are aliases. |
| `forecastBasis` | string | Human-readable description of the evidence used by the source forecast. |
| `comparableSales` | array | Real completed-sale evidence used for resale ranges; capped at 50 normalized entries. |
| `auctionComparables` | array | Real prior-auction evidence used to assess bidding curves; capped at 50 normalized entries. |
| `forecast` | object | Optional source-supplied auction-close forecast. When it is absent or under-supported, BidAI Pro may generate a strictly historical exact-model forecast after ingestion. |
| `intrinsicValueEvidence` | boolean | Optional intrinsic-value switch. It must normalize to `true` and be accompanied by a valid `valuationBasis`. |
| `valuationBasis` | object | Optional timestamped 14K-gold valuation basis. It supports a conservative resale floor; it is not auction-close evidence. |
| `resaleMarket` | object | Validated completed-sales market window: channel, as-of, lookback, sold/active counts, sell-through, median days, and liquidity. |
| `resaleMarketHistory` | array | Up to 365 timestamped validated market summaries retained for price and velocity learning. |
| `askingMarket` | object | Current active-used asking-price evidence, kept separate from completed sales and validated again in the browser. |
| `askingMarketHistory` | array | Up to 365 timestamped summaries of active-used asking prices for longitudinal learning. |
| `retailMarket` | object | Multi-merchant Google Shopping evidence with used and new condition groups, raw offer links, statistics, and product-interest fields. |
| `retailMarketHistory` | array | Up to 365 timestamped broad-market summaries for longitudinal price learning. |
| `specialtyMarket` | object | Strictly matched specialty guide values, direct retailer buy/sell references, raw annual unit volume, and provider link. |
| `metalEstimate` | object | Source-described purity/weight plus a fresh live spot quote and gross melt ceiling; informational until independently tested. |

Useful optional flat fields are `shipping`, `status`, `finalPrice`, `expectedClose`, `resaleLow`, `resaleMedian`, `resaleHigh`, `demand`, `rarity`, `identityConfidence`, `conditionConfidence`, `imageUrl`, `resaleVertical`, `authenticationStatus`, `authenticationEvidence`, `riskSummary`, `compCount`, `compRecencyDays`, `marketplaceFee`, `taxRate`, `buyerPremium`, `outboundShipping`, `repairReserve`, and `returnReserve`. `shippingKnown` and `feeKnown` may be supplied explicitly; otherwise the importer marks them true only when the corresponding numeric field was actually present and valid. Missing shipping, fees, and material cost reserves remain `null`, not zero.

Example Apify Dataset item:

```json
{
  "id": "auction-272238150",
  "sourceKey": "shopgoodwill",
  "source": "ShopGoodwill",
  "title": "Tested 14K gold jewelry lot",
  "url": "https://example.invalid/item/272238150",
  "category": "Jewelry",
  "currentBid": 166.0,
  "bidCount": 12,
  "shipping": 14.95,
  "endsAt": "2026-08-04T01:25:00Z",
  "observedAt": "2026-08-02T04:10:00Z",
  "status": "active",
  "modelKey": "jewelry:14k-scrap-lot",
  "forecastBasis": "No verified auction-close forecast is attached in this abbreviated example",
  "comparableSales": [
    {
      "id": "14k-18g-01",
      "title": "Tested 14K jewelry scrap, 18.0g",
      "soldPrice": 1025,
      "soldAt": "2026-07-29T19:04:00Z",
      "url": "https://comps.example.invalid/sold/14k-18g-01",
      "source": "Licensed completed-sales feed",
      "outcomeObservedAt": "2026-07-29T19:10:00Z",
      "modelKey": "jewelry:14k-scrap-lot",
      "matchReason": "Same purity and gross weight within 2%",
      "matchScore": 97
    }
  ]
}
```

### Comparable evidence

Each entry in `comparableSales` or `auctionComparables` must be an object with a non-empty `title` and a positive USD price. The importer accepts `price`, `finalPrice`, or `soldPrice` as price aliases and `endedAt` or `soldAt` as date aliases. Include a durable `id` or canonical `url` so repeated records cannot inflate the sample, plus `source` so a user can audit the evidence. A comparable must have a valid ending timestamp on or before the target observation before it can influence any derived price or forecast. Undated and future entries may remain visible for audit, but they are never pricing inputs.

Comparable entries may also carry `modelKey` (or `compGroup`/`similarItemKey`), `matchReason`, `matchScore`, `outcomeObservedAt`, `bidAtComparableTime`, and `hoursToClose`. Production pricing evidence should always supply and reuse the original `outcomeObservedAt` so later refreshes cannot make old evidence appear newly discovered. When it is omitted, the importer records the parent listing's `observedAt` as a fallback; do not rely on that fallback for immutable learning across repeated refreshes. Pricing evidence requires the exact normalized model key, a match score of at least 75, a stable ID or URL, an end time on or before the target snapshot, and an outcome capture time on or before that snapshot. At most 50 valid entries are retained in each evidence array. Generic feeds quietly discard malformed or explicitly non-USD comparable entries. Apify imports reject the row when either evidence field is not an array or contains a malformed/non-USD entry, preventing partial evidence from being published as complete.

When `resaleLow`, `resaleMedian`, or `resaleHigh` is absent, the importer derives only the missing value after at least three qualifying exact-model completed sales, using empirical P20, median, and P80 values. Explicit feed values, including zero, remain stored as source inputs for audit. When qualifying completed-sale evidence exists, however, browser decision calculations use the evidence-derived P20, median, and P80 values instead of the explicit source range. Explicit source resale values alone cannot promote an unsupported listing. `compCount` is derived from the qualifying completed-sale count only when the feed omits it. Auction comparables never create resale values, and an item without qualifying completed-sale evidence receives a zero comparable count and `null` derived resale values—never synthetic comps.

Completed-sale entries may additionally provide `listedAt`, `daysToSell`, and `condition`; these support transparent time-to-sale analysis but never replace the completed-sale timestamp or exact-model checks.

### Intrinsic 14K-gold evidence

An authorized feed may set `intrinsicValueEvidence` to `true` and provide `valuationBasis` when a tested 14K-gold item's resale floor is supported by a timestamped melt reference. The valuation basis must contain all of the following canonical fields:

| Field | Requirement |
| --- | --- |
| `referenceObservedAt` | Valid timestamp no later than the parent item's `observedAt`. |
| `currency` | Exactly `USD`. |
| `unit` | Exactly `gram`. |
| `purity` | Exactly `14k`. |
| `grossWeightGrams` | Positive number. |
| `reference14kMeltPerGram` | Positive USD value per gram. |
| `source` | Optional human-readable quote source. |
| `sourceUrl` | Optional HTTP(S) audit link. |

If the switch is absent or false, or any required basis field is invalid, the importer does not treat the listing as having intrinsic evidence. The browser applies a second freshness check: the reference quote must be no more than 24 hours old relative to the listing snapshot. It also requires a positive, coherent conservative source range (`resaleLow > 0`, `resaleMedian > 0`, `resaleLow <= resaleMedian`, and `resaleHigh >= resaleMedian`) before intrinsic evidence can support profit or safe-bid calculations. Intrinsic evidence never counts toward the five exact-model auction-close outcomes and cannot create an expected closing forecast.

Compact item fragment:

```json
{
  "intrinsicValueEvidence": true,
  "valuationBasis": {
    "referenceObservedAt": "2026-08-01T15:45:00Z",
    "currency": "USD",
    "unit": "gram",
    "purity": "14k",
    "grossWeightGrams": 18.3,
    "reference14kMeltPerGram": 58.75,
    "source": "Licensed metals quote",
    "sourceUrl": "https://metals.example.invalid/14k-usd-per-gram"
  },
  "resaleLow": 875,
  "resaleMedian": 950,
  "resaleHigh": 1030
}
```

### Source forecasts

`expectedClose` remains the source's legacy point estimate. It is not promoted to verified evidence and stays separate from the optional `forecast` object. A supplied forecast accepts these fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `status` | string | Source forecast state: `available`, `ready`, or `verified`. Other values are not treated as verified. |
| `asOf` | ISO 8601 string | Time the forecast was calculated. |
| `modelVersion` | string | Required non-empty reproducible source-model version. |
| `expected` | USD number | Expected final auction price. |
| `low` / `high` | USD number | Required positive forecast interval satisfying `low <= expected <= high`. |
| `sampleSize` | integer | Number of real auction-close outcomes used. Completed resale sales do not count. |
| `exactModelCount` | integer | Exact-model auction-close outcomes within the sample. Completed resale sales do not count. |
| `curveCount` | integer | Optional count of comparable auction curves used. |
| `confidence` | ratio or percentage | Optional source confidence, normalized to a `0`–`1` ratio. |
| `method` | string | Forecast method name. |
| `reasonCodes` | string array | Machine-readable evidence and warning codes, capped at 20. |
| `evidenceIds` | string array | Optional stable IDs for the exact auction outcomes in the forecast cohort. |
| `evidenceHash` | SHA-256 string | Optional cohort fingerprint. BidAI Pro recomputes it whenever `evidenceIds` are supplied. |

BidAI Pro requires an allowed status, a valid `asOf`, a non-empty `modelVersion`, a positive coherent interval, `sampleSize >= 5`, and `exactModelCount >= 5` before it treats a source forecast as verified. The pipeline and browser independently require five qualifying exact-model auction-close outcomes available in the published dataset—either retained ended listings or attached `auctionComparables`—and require the forecast `asOf` to align within two hours of the listing observation. A large broad-category or resale-sale sample cannot substitute for exact-model auction evidence. If a threshold is missed, the supplied object is retained as insufficient evidence and cannot create expected-profit rankings. This guard never turns listing `expectedClose` into a verified forecast.

### BidAI Pro empirical closing forecasts

After records and retained history are merged, BidAI Pro can generate a closing forecast for an active item whose current source forecast does not pass the verified threshold. The empirical model is deliberately narrow:

- the target must have a non-empty normalized `modelKey`;
- at least five deduplicated completed outcomes must have the exact same normalized `modelKey`;
- each attached comparable must have a stable ID or URL, a match score of at least 75, a positive real final price, a valid end time on or before the target's `observedAt`, and an outcome-capture time known by that observation;
- sources are retained ended items with `finalPrice` and exact-model `auctionComparables` only;
- the target itself, matching target URL, future and undated outcomes, category-only matches, `expectedClose`, source resale comps, and the target's own `finalPrice` are excluded.

The model publishes the 20th, 50th, and 80th percentiles as `low`, `expected`, and `high`, never below the current bid. Its `modelVersion` is `empirical-close-v1`, `status` is `available`, and `sampleSize`/`exactModelCount` report the deduplicated outcome count. Each generated forecast also stores sorted `evidenceIds` and their SHA-256 `evidenceHash`, binding the historical prediction to the exact cohort used at that moment.

When at least five outcomes also have a bid observation at a reasonably matching time-to-close, the distribution uses each outcome's final-price-to-bid uplift applied to the target's current bid. A match uses explicit `bidAtComparableTime`/`hoursToClose` or retained bid history and must fall within 25% of the target hours-to-close, with a minimum one-hour and maximum 24-hour tolerance. Otherwise the forecast uses the exact-model final-price distribution. `curveCount`, `method`, and `reasonCodes` disclose which path ran.

A verified source forecast is never overwritten by the empirical model. A generated forecast is written to the active item's top level and only to the observation whose timestamp equals the target `observedAt`. Earlier observations are not rewritten, so subsequent final outcomes can be scored against the prediction that genuinely existed at that point in time.

### Six-hour learning calibration

The Learning view evaluates one fixed-horizon sample per ended listing. It selects the eligible immutable forecast nearest six hours before close, provided that the forecast was captured between three and nine hours before the recorded ending time. The forecast must have been attached to its timestamped observation before close, its `asOf` must align with that observation using the same two-hour source-forecast rule, and at least five qualifying exact-model auction outcomes must have been known by that `asOf` time.

The final price is joined to that single selected forecast without rewriting the historical prediction. When `evidenceIds` are present, every cohort ID must still resolve to a qualifying exact-model outcome known at forecast time; older forecasts without cohort IDs use the compatible five-outcome revalidation rule. Source `expectedClose` estimates, forecasts created after close, forecasts outside the three-to-nine-hour window, and forecasts whose exact-model evidence cannot be revalidated are excluded. Dashboard error, bias, and within-15-percent metrics therefore describe the approximately six-hour horizon only; they are not aggregates of every forecast made during an auction.

## Generic feed envelope

The generic endpoint must return JSON. It may return an array directly or place an array under `items`, `listings`, `auctions`, `records`, or `snapshots`. An Apify Dataset response is already a direct array. See `data/feed-schema.example.json` for a complete envelope example.

Each item should include:

- a durable source identifier in `id`, `externalId`, `listingId`, `auctionId`, or `itemId`;
- `title`, `currentBid`, `bidCount`, `endsAt`, and `observedAt`;
- optional `shipping`, resale estimates, confidence values, demand, rarity, and final outcome;
- optional history under `history`, `observations`, `snapshots`, or `bidHistory`.

Dollar values may be JSON numbers or formatted strings such as `"$1,249.50"`. All monetary fields are USD; the importer does not convert currencies, and Apify rows that explicitly declare another currency are rejected. Apify rows must also be flat objects with a title and valid `observedAt`; malformed evidence arrays reject the row instead of silently weakening it. Timestamps may be ISO 8601 strings, Unix seconds, or Unix milliseconds. Confidence, match-score, and rate fields accept either decimal ratios or percentages. The importer normalizes these representations and rejects records without a title.

Durable source IDs are strongly recommended. When one is missing, the importer derives an ID from the listing URL or a combination of title, category, and ending time. Derived IDs are deterministic but can change if those identity fields change upstream.

## Generated data and history

The script writes `data/live-snapshots.js` atomically in this form:

```js
window.BIDAI_LIVE_SNAPSHOTS = {
  observedAt: "2026-08-01T16:30:00.000Z",
  lastCheckedAt: "2026-08-01T16:45:00.000Z",
  sourceMode: "authorized-feed",
  sourceNotes: ["Automated snapshots from a permissioned JSON feed."],
  items: [/* normalized items */]
};
```

The actual value is an object envelope with `observedAt`, `lastCheckedAt`, `sourceMode`, `sourceNotes`, and `items`. `observedAt` is the newest retained higher-bid observation; `lastCheckedAt` is the newest successful source check. Every feed item is marked as published research, and listing links are exposed under both `url` and `sourceUrl` for front-end compatibility. Comparable links are normalized to HTTP(S), URL fragments are removed, non-web schemes are discarded, and comparable text fields and arrays are bounded before publication.

Before writing, it merges prior observations for matching stable IDs, sorts the history chronologically, removes duplicate timestamps and non-increasing bids, and keeps the most recent 250 strictly increasing bid observations per item. When a source supplies a forecast on a qualifying higher-bid record, the importer stores the same normalized forecast inside that current observation as an auditable point-in-time prediction. When the empirical model is eligible, its generated forecast is stored in the same way. Earlier observations are never rewritten.

Listings that disappear from a later feed response are retained instead of being deleted, including ended auctions and manually published research. Apify Datasets are read in 5,000-record pages and normalized storage is capped at 50,000 items; the 20 MB response limit applies to each page or generic-feed response. Records are ordered by active state and newest qualifying higher-bid observation, with stable ID as the deterministic tie-breaker. An unchanged bid preserves the price curve but advances `lastCheckedAt`, intentionally creating a small data update that proves the source was checked.

The workflow commits the file to `main` only when its content changes. That commit triggers the repository's normal GitHub Pages deployment flow. GitHub secrets are injected only into the refresh step and are never written to the generated file or logs. The generated browser data contains normalized listing fields, not the Apify token or feed credentials.

## Operational checks

- Run `node scripts/refresh-all-sources.mjs` without workflow variables to confirm the guarded no-op path.
- Run it with `BIDAI_SHOPGOODWILL_ENABLED=true` and an hourly/manual event context to exercise the built-in source.
- Run `node --test scripts/refresh-feed.test.mjs scripts/refresh-all-sources.test.mjs` before pushing ingestion changes.
- Use **Run workflow** after changing the Dataset, endpoint, or schema.
- Confirm the Apify Dataset contains flat item objects before enabling the schedule; a successful Actor run does not guarantee compatible output.
- Confirm every production record carries the real auction URL; clicking a row opens the BidAI Pro dossier, and its separate source-listing control opens the real auction URL.
- Use the same durable listing ID across repeated observations, numeric USD values, and a single string `imageUrl` rather than an image array.
- Inspect the workflow summary before relying on new data.
- Remove `BIDAI_SOURCE_AUTHORIZED` immediately if permission for an optional source is withdrawn; disable the built-in workflow switch separately when needed.
- Treat automated rankings as research support; verify identity, condition, fees, taxes, shipping, and resale evidence before bidding.
