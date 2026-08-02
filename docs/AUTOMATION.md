# Automated dataset and feed ingestion

BidAI Pro can refresh auction snapshots from either an Apify Dataset or a generic JSON feed on a schedule. It runs only when `BIDAI_SOURCE_AUTHORIZED` is exactly `true`.

The two ingestion modes are:

1. **Apify Dataset mode:** set `BIDAI_APIFY_DATASET_ID` and optionally `BIDAI_APIFY_TOKEN`. BidAI Pro downloads the dataset's structured item results.
2. **Generic JSON feed mode:** set `BIDAI_FEED_URL` to an authorized HTTPS endpoint.

Apify Dataset mode takes precedence whenever `BIDAI_APIFY_DATASET_ID` is set. In that case, `BIDAI_FEED_URL` is ignored. BidAI Pro is the dataset consumer only: it does not create, configure, start, or schedule an Apify Actor, crawler, or other collector. Collection must be configured separately so its output conforms to the flat item schema below.

Direct source automation requires permission from the source operator. Configure this workflow only for an official API, licensed data feed, operator-approved endpoint, or another source you are authorized to access programmatically. The authorization switch is a deployment safeguard, not a substitute for that permission. Follow the feed owner's rate limits, data-retention requirements, and license terms.

## GitHub setup

In the GitHub repository, open **Settings > Secrets and variables > Actions**, then choose one source mode.

### Apify Dataset mode

1. Configure and schedule an Apify collector separately, have it write one flat item per auction listing to a named, persistent Dataset, and let each run finish before BidAI Pro's `:17` or `:47` import.
2. Create a repository secret named `BIDAI_APIFY_DATASET_ID` containing the Dataset ID, not an Actor ID, task ID, run ID, or full URL.
3. For a private Dataset, create `BIDAI_APIFY_TOKEN` containing an Apify API token scoped to read that Dataset. The token is optional for a deliberately public Dataset.
4. Create `BIDAI_SOURCE_AUTHORIZED` with the exact value `true` only after source access has been authorized.
5. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh.

### Generic JSON feed mode

1. Obtain an HTTPS JSON endpoint that you have permission to use.
2. Create a repository secret named `BIDAI_FEED_URL` containing the full endpoint URL. A signed endpoint URL may be used; never put it in a tracked file.
3. Create `BIDAI_SOURCE_AUTHORIZED` with the exact value `true` only after permission has been confirmed.
4. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh.

Keep `BIDAI_APIFY_TOKEN`, signed feed URLs, and all other credentials in GitHub Actions secrets. Do not add them to workflow YAML, source files, generated snapshots, screenshots, or documentation. If both modes are configured, remove `BIDAI_APIFY_DATASET_ID` whenever you intend to use the generic feed.

The workflow also runs at minutes 17 and 47 of every hour. Adjust the schedule in `.github/workflows/refresh-auction-data.yml` if the feed owner's rate limit requires a slower interval.

If authorization is absent or has any value other than lowercase `true`, the refresh script exits successfully without making a network request. Removing or changing that secret is the quickest way to stop ingestion. Removing the Dataset ID and feed URL disables both source modes while leaving existing published snapshots intact.

## Flat item schema

An Apify Dataset item must be a flat JSON object, and a generic feed must expose the same kind of objects. Do not place listing fields inside `data`, `item`, `auction`, or other nested objects; map the collector output before BidAI Pro reads it. Arrays are used only for optional observation history, comparable-sale evidence, and prior-auction evidence. `forecast` and `valuationBasis` are the supported nested analysis objects.

For Apify mode, `title` and a valid `observedAt` are required on every row. Generic feeds require `title` and may omit `observedAt`, though supplying it is strongly recommended. For stable, useful automated analysis, every collector result should provide these canonical fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `id` | string | Durable listing ID; reuse it on every refresh. |
| `title` | string | Listing title; required. |
| `url` | string | Public HTTP(S) listing URL; `sourceUrl` and `listingUrl` are also accepted. |
| `category` | string | Broad category used for filtering. |
| `currentBid` | number | Current bid in US dollars, without currency symbols when possible. |
| `bidCount` | integer | Number of bids observed. |
| `endsAt` | ISO 8601 string | Scheduled auction end time, including a timezone. |
| `observedAt` | ISO 8601 string | Time this snapshot was captured, including a timezone. |
| `modelKey` | string | Normalized maker/model/variant key used to require like-for-like evidence; `compGroup` and `similarItemKey` are aliases. |
| `forecastBasis` | string | Human-readable description of the evidence used by the source forecast. |
| `comparableSales` | array | Real completed-sale evidence used for resale ranges; capped at 50 normalized entries. |
| `auctionComparables` | array | Real prior-auction evidence used to assess bidding curves; capped at 50 normalized entries. |
| `forecast` | object | Optional source-supplied auction-close forecast. When it is absent or under-supported, BidAI Pro may generate a strictly historical exact-model forecast after ingestion. |
| `intrinsicValueEvidence` | boolean | Optional intrinsic-value switch. It must normalize to `true` and be accompanied by a valid `valuationBasis`. |
| `valuationBasis` | object | Optional timestamped 14K-gold valuation basis. It supports a conservative resale floor; it is not auction-close evidence. |

Useful optional flat fields are `shipping`, `status`, `finalPrice`, `expectedClose`, `resaleLow`, `resaleMedian`, `resaleHigh`, `demand`, `rarity`, `identityConfidence`, `conditionConfidence`, `imageUrl`, `source`, `compCount`, `compRecencyDays`, `marketplaceFee`, `taxRate`, `buyerPremium`, `outboundShipping`, `repairReserve`, and `returnReserve`. `shippingKnown` and `feeKnown` may be supplied explicitly; otherwise the importer marks them true only when the corresponding numeric field was actually present and valid. Missing shipping, fees, and material cost reserves remain `null`, not zero.

Example Apify Dataset item:

```json
{
  "id": "auction-272238150",
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
  sourceMode: "authorized-feed",
  sourceNotes: ["Automated snapshots from a permissioned JSON feed."],
  items: [/* normalized items */]
};
```

The actual value is an object envelope with `observedAt`, `sourceMode`, `sourceNotes`, and `items`. Every feed item is marked as published research, and listing links are exposed under both `url` and `sourceUrl` for front-end compatibility. Comparable links are normalized to HTTP(S), URL fragments are removed, non-web schemes are discarded, and comparable text fields and arrays are bounded before publication.

Before writing, it merges prior observations for matching stable IDs, sorts the history chronologically, removes duplicate timestamps, and keeps the most recent 250 observations per item. This gives the app a bid-development series even when the feed supplies only the latest observation. When a source supplies a forecast on the current record, the importer stores the same normalized forecast inside that current observation as an auditable point-in-time prediction. When the empirical model is eligible, its generated forecast is stored in the same way. Earlier supplied history points receive a forecast only when that history point carried its own source or previously generated forecast; the importer never backfills the current forecast into prior observations. Repeated observations therefore preserve which model version, range, sample, and confidence were actually available at each bid snapshot.

Listings that disappear from a later feed response are retained instead of being deleted, including ended auctions and manually published research. This preserves final prices and earlier predictions for learning. Storage is capped at 5,000 items and responses are capped at 20 MB. Records are ordered by active state and newest observation, with stable ID as the deterministic tie-breaker; retained active listings whose end time has passed are reclassified as ended. Generic feed records receive the current capture timestamp when the endpoint does not provide one. Apify rows must provide `observedAt`, and the published envelope time comes from the newest row so an unchanged Dataset does not create meaningless refresh commits.

The workflow commits the file to `main` only when its content changes. That commit triggers the repository's normal GitHub Pages deployment flow. GitHub secrets are injected only into the refresh step and are never written to the generated file or logs. The generated browser data contains normalized listing fields, not the Apify token or feed credentials.

## Operational checks

- Run `node scripts/refresh-feed.mjs` without secrets to confirm the guarded no-op path.
- Use **Run workflow** after changing the Dataset, endpoint, or schema.
- Confirm the Apify Dataset contains flat item objects before enabling the schedule; a successful Actor run does not guarantee compatible output.
- Use the same durable listing ID across repeated observations, numeric USD values, and a single string `imageUrl` rather than an image array.
- Inspect the workflow summary before relying on new data.
- Remove `BIDAI_SOURCE_AUTHORIZED` immediately if permission is withdrawn.
- Treat automated rankings as research support; verify identity, condition, fees, taxes, shipping, and resale evidence before bidding.
