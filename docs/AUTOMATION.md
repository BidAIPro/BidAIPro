# Authorized feed automation

BidAI Pro can refresh auction snapshots from a JSON feed on a schedule. The integration is deliberately source-neutral: it calls only the endpoint configured in `BIDAI_FEED_URL`, and it runs only when `BIDAI_SOURCE_AUTHORIZED` is exactly `true`.

Direct source automation requires permission from the source operator. Configure this workflow only for an official API, licensed data feed, operator-approved endpoint, or another source you are authorized to access programmatically. The authorization switch is a deployment safeguard, not a substitute for that permission. Follow the feed owner's rate limits, data-retention requirements, and license terms.

## GitHub setup

1. Obtain an HTTPS JSON endpoint that you have permission to use.
2. In the GitHub repository, open **Settings > Secrets and variables > Actions**.
3. Create a repository secret named `BIDAI_FEED_URL` containing the full endpoint URL. A signed endpoint URL may be used; never put it in a tracked file.
4. Create a repository secret named `BIDAI_SOURCE_AUTHORIZED` with the exact value `true` only after permission has been confirmed.
5. Open **Actions > Refresh authorized auction data > Run workflow** for the first refresh.

The workflow also runs at minutes 17 and 47 of every hour. Adjust the schedule in `.github/workflows/refresh-auction-data.yml` if the feed owner's rate limit requires a slower interval.

If authorization is absent or has any value other than lowercase `true`, the refresh script exits successfully without making a network request. Removing or changing that secret is the quickest way to stop collection.

## Feed shape

The endpoint must return JSON. It may return an array directly or place an array under `items`, `listings`, `auctions`, `records`, or `snapshots`. See `data/feed-schema.example.json` for a complete example.

Each item should include:

- a durable source identifier in `id`, `externalId`, `listingId`, `auctionId`, or `itemId`;
- `title`, `currentBid`, `bidCount`, `endsAt`, and `observedAt`;
- optional `shipping`, resale estimates, confidence values, demand, rarity, and final outcome;
- optional history under `history`, `observations`, `snapshots`, or `bidHistory`.

Dollar values may be JSON numbers or formatted strings such as `"$1,249.50"`. Timestamps may be ISO 8601 strings, Unix seconds, or Unix milliseconds. Confidence and rate fields accept either decimal ratios or percentages. The importer normalizes these representations and rejects records without a title.

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

Listings that disappear from a later feed response are retained instead of being deleted, including ended auctions and manually published research. This preserves final prices and earlier predictions for learning. Storage is capped at 5,000 items; active records are retained first, then records are ordered by newest observation, with stable ID as the deterministic tie-breaker. Current feed records receive the current capture timestamp when the endpoint does not provide one, so they remain ahead of stale retained records.

The workflow commits the file to `main` only when its content changes. That commit triggers the repository's normal GitHub Pages deployment flow. GitHub secrets are injected only into the refresh step and are never written to the generated file or logs.

## Operational checks

- Run `node scripts/refresh-feed.mjs` without secrets to confirm the guarded no-op path.
- Use **Run workflow** after changing the endpoint or schema.
- Inspect the workflow summary before relying on new data.
- Remove `BIDAI_SOURCE_AUTHORIZED` immediately if permission is withdrawn.
- Treat automated rankings as research support; verify identity, condition, fees, taxes, shipping, and resale evidence before bidding.
