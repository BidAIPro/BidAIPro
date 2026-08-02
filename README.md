# BidAI Pro

BidAI Pro is a private-first auction intelligence workspace for evaluating resale opportunities. It estimates landed cost, conservative resale value, expected profit, risk, demand, and a maximum rational bid from snapshots you provide.

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

- review illustrative opportunities and inspect their cost assumptions;
- record a single auction snapshot;
- import repeated CSV or JSON snapshots to build price history;
- mark ended auctions with an actual final price so calibration can improve;
- keep a local watchlist and risk settings;
- export the complete browser workspace as JSON for backup.

Data is stored in browser `localStorage`. Clearing browser data removes it, so export backups regularly.

## Snapshot inputs

The importer accepts CSV or JSON. Common CSV headers include:

`id,title,category,url,current_bid,shipping,bid_count,ends_at,expected_close,resale_low,resale_median,resale_high,demand,rarity,identity_confidence,condition_confidence,status,final_price,observed_at`

Money values are in US dollars. Confidence values can be decimals such as `0.82` or percentages such as `82`.

## Data-source boundary

This repository does not crawl ShopGoodwill or automate bidding. It analyzes user-provided snapshots and can later be connected to a data feed for which the operator has permission. Recommendations are decision support, not guarantees; verify authenticity, condition, taxes, fees, shipping, and resale restrictions before bidding.
