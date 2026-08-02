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

An Apify Dataset item must be a flat JSON object, and a generic feed must expose the same kind of objects. Do not place listing fields inside `data`, `item`, `auction`, or other nested objects; map the collector output before BidAI Pro reads it. Arrays are used only for optional observation history.

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

Useful optional flat fields are `shipping`, `status`, `finalPrice`, `expectedClose`, `resaleLow`, `resaleMedian`, `resaleHigh`, `demand`, `rarity`, `identityConfidence`, `conditionConfidence`, `imageUrl`, `source`, `compCount`, `compRecencyDays`, `marketplaceFee`, `taxRate`, `buyerPremium`, `outboundShipping`, `repairReserve`, and `returnReserve`.

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
  "status": "active"
}
```

## Generic feed envelope

The generic endpoint must return JSON. It may return an array directly or place an array under `items`, `listings`, `auctions`, `records`, or `snapshots`. An Apify Dataset response is already a direct array. See `data/feed-schema.example.json` for a complete envelope example.

Each item should include:

- a durable source identifier in `id`, `externalId`, `listingId`, `auctionId`, or `itemId`;
- `title`, `currentBid`, `bidCount`, `endsAt`, and `observedAt`;
- optional `shipping`, resale estimates, confidence values, demand, rarity, and final outcome;
- optional history under `history`, `observations`, `snapshots`, or `bidHistory`.

Dollar values may be JSON numbers or formatted strings such as `"$1,249.50"`. All monetary fields are USD; the importer does not convert currencies, and Apify rows that explicitly declare another currency are rejected. Timestamps may be ISO 8601 strings, Unix seconds, or Unix milliseconds. Confidence and rate fields accept either decimal ratios or percentages. The importer normalizes these representations and rejects records without a title.

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

The actual value is an object envelope with `observedAt`, `sourceMode`, `sourceNotes`, and `items`. Every feed item is marked as published research, and listing links are exposed under both `url` and `sourceUrl` for front-end compatibility.

Before writing, it merges prior observations for matching stable IDs, sorts the history chronologically, removes duplicate timestamps, and keeps the most recent 250 observations per item. This gives the app a bid-development series even when the feed supplies only the latest observation.

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
