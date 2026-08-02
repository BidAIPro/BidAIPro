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
- open any record directly on its source site and inspect observation age, bid history, exact-model auction outcomes, completed resale evidence, and its full cost stack;
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

When at least three qualifying exact-model resale sales exist, decision calculations use their empirical P20, median, and P80 values. Explicit source resale fields remain available for audit, but they do not override qualifying completed-sale evidence or promote an unsupported item.

For tested 14K-gold lots, an authorized feed may instead attach `intrinsicValueEvidence: true` with a timestamped USD-per-gram `valuationBasis` and a positive conservative resale range. The quote must be no later than the listing snapshot and no more than 24 hours old; intrinsic evidence can support a resale floor but never substitutes for auction-close outcomes or creates a closing forecast. See [docs/AUTOMATION.md](docs/AUTOMATION.md#intrinsic-14k-gold-evidence) for the exact contract.

Profit and safe-ceiling calculations expose inbound shipping, tax, buyer premium, marketplace fees, outbound shipping, repair/testing reserve, and return/loss reserve. Missing shipping or resale evidence blocks the bid ceiling instead of silently assuming zero. The Learning view uses one fixed-horizon sample per ended listing: the eligible immutable forecast nearest six hours before close, within a three-to-nine-hour window. Source estimates, post-close forecasts, and forecasts outside that window are excluded.

## Automatic refreshes

The repository includes a scheduled GitHub Actions pipeline that can merge structured results from multiple Apify collectors, Apify Datasets, and authorized HTTPS JSON feeds. It normalizes current bids and ended outcomes, preserves observation history by marketplace, and republishes the data file only when something changed. The workflow checks every five minutes; configured collectors are run adaptively every six hours, hourly, every 15 minutes, or every five minutes as their nearest active listing approaches its close.

For a production multi-market setup, configure these GitHub Actions secrets:

- `BIDAI_SOURCE_CONFIG_JSON` — a JSON array describing up to 20 marketplace sources and their Apify Task, Dataset, or authorized feed;
- `BIDAI_APIFY_TOKEN` — required when a configured private Dataset is read or an Apify Task is started;
- `BIDAI_SOURCE_AUTHORIZED=true` — the exact permission-gate value required before collection or import is attempted.

Each configured Apify Task is a collector that you create and authorize in Apify. BidAI Pro can start that task when its marketplace is due, wait for a successful run, import the resulting Dataset, and retain unmatched records from every other market. The original single-source `BIDAI_APIFY_DATASET_ID` and `BIDAI_FEED_URL` secrets remain supported.

Setup, the multi-source secret format, the flat item schema, and generic feed details are in `docs/AUTOMATION.md`. Until a real source is configured, the workflow performs a guarded no-op and the checked-in point-in-time research pass remains visible. The interface never fills an unconnected marketplace with fabricated listings.

## Data-source boundary

This repository does not automate bidding. Its checked-in ShopGoodwill records are labeled point-in-time manual research snapshots. Scheduled collection is delegated to the Apify Tasks or HTTPS feeds that the repository owner configures; BidAI Pro performs adaptive orchestration, normalization, retention, learning, and direct source linking. Recommendations are decision support, not guarantees; verify authenticity, condition, taxes, fees, shipping, and resale restrictions before bidding.
