# BidAI Pro — GSA Vehicle Intelligence

BidAI Pro is a vehicle-only government auction intelligence application. It discovers official GSA vehicle listings, preserves auction and bid history, separates market valuation from closing-price forecasts, and calculates a conservative bid ceiling after acquisition, resale, and risk costs.

## Public website

The production frontend is published at [bidaipro.github.io/BidAIPro](https://bidaipro.github.io/BidAIPro/). GitHub Pages builds the static interface from the `main` branch, while the public API and D1 database remain on the server-side Sites deployment. The browser is given only the public backend origin; provider credentials and database bindings are never included in the Pages bundle.

Every push to `main` runs `.github/workflows/deploy-pages.yml` and publishes `out` after a successful static export.

## GitHub Desktop

Add this exact folder as the local repository:

```text
C:\Users\zk861\OneDrive\Documents\Bid Projector
```

It is configured to push `main` to `https://github.com/BidAIPro/BidAIPro.git`. The previous application history is preserved as a merge parent, and the former `BidAIPro/Bid-Projector` remote is retained locally as `bid-projector-backup`. In GitHub Desktop, confirm the current branch is `main`, then use **Push origin**. Do not select the older clone at `C:\Users\zk861\OneDrive\Documents\GitHub\BidAIPro` when working on this replacement.

## Source policy

- The official sources are [`gsaauctions.gov`](https://gsaauctions.gov/) and the [GSA Fleet Marketplace](https://marketplace.gsafleet.gov/sales/browse-vehicles). The unrelated `gsaauctions.com` domain is not used.
- Primary discovery uses the same first-party PPMS category-300 catalog, lot-detail, image-signing, and live-auction JSON services used by the public GSA Auctions site. It does not scrape auction-page HTML.
- The catalog is paginated and rejected if its returned rows do not match GSA's advertised active-vehicle count. The legacy documented [GSA Auctions API](https://gsa.github.io/auctions_api/) remains a fallback and uses `GSA_API_KEY` when configured.
- Official listing photos use short-lived GSA-signed URLs. Up to six photos per lot are preserved in an accessible full-screen gallery with keyboard and thumbnail navigation. The repository-owned `refresh-gsa-auction-data.yml` workflow renews the validated GSA Auctions snapshot twice hourly; GSA Fleet cards lazily recover missing browse thumbnails from the official detail gallery with bounded concurrency.
- Structured odometer mileage is retained as the primary source fact. When the narrative description reports a different mileage, both readings are preserved and the vehicle is visibly marked for verification.
- GSA Fleet inventory is read from its shared-public GraphQL gateway. Internet auctions retain current bids and public anonymized bidder-high snapshots; scheduled Live sales are labeled as offline events and never receive an invented online bid. Active/coming rows are classified from official start/end timestamps because the upstream feed reports both under its Active status.
- Numeric market evidence is pulled automatically and kept separate from the live bid. Current inventory is valued from official GSA Auctions terminal high bids and confirmed GSA Fleet Sold/Awarded outcomes. The v2 matcher retains one or two genuinely close comps instead of widening, enforces hard family/class/year/mileage/condition/operability limits, separates easily confused models, deduplicates relisted VINs, caps the pool at 15, and penalizes sparse or dispersed evidence. Valid cached CarMax recent-offer evidence can take precedence where it is stronger. Every displayed number identifies its source, sample count, as-of date, match basis, and confidence; manual KBB, CARFAX, Edmunds, and J.D. Power links remain secondary cross-checks only.
- Projected close is recomputed from the current official bid, scheduled time remaining, similar terminal outcomes, public bid activity when available, and the market-value range. Before a public bid appears, a visibly low-confidence market/outcome-only projection is shown without inventing a $0 bid or activating a Deal Score. It remains explicitly reference-only until calibrated time-matched bid curves have adequate coverage; it is never used to make a reference-only record actionable.
- A closed GSA high bid is not called a sale until an authoritative award source confirms the outcome.
- The comparable ledger accrues outcomes for lots observed by this installation. GSA Auctions terminal high bids refresh at minute 39; confirmed GSA Fleet Sold/Awarded outcomes refresh at minute 49. The Fleet job also walks one bounded 14-day window backward on each run until the available historical corpus is covered. High bids and authoritative award/proceeds prices remain separate fields.
- `scripts/export-gsa-market-valuations.mjs` keeps a validated retained checkpoint at `work/gsa-closed-comps.json`. Normal runs fetch one or more bounded, overlapping increments and merge them idempotently; `--full` intentionally rebuilds the baseline. The public valuation snapshot is replaced only after the corpus is fully caught up and passes completeness and subject-bid-leakage checks.

## Website-native background processing

The deployed website owns all recurring catalog, outcome, bid, forecast, risk, confidence, and Deal Score work. These server-side jobs continue when nobody has the site open, so an open browser or active tab is not required. The five configured triggers are:

| Trigger | Website job |
| --- | --- |
| Every hour at minute 09 | Refresh the active GSA Auctions catalog. |
| Every hour at minute 19 | Refresh active and coming-soon GSA Fleet inventory. |
| Every hour at minute 39 | Import terminal GSA Auctions high bids into the comparable ledger. |
| Every hour at minute 49 | Import recent confirmed GSA Fleet outcomes, backfill one older 14-day history window, then build and atomically promote a complete deal-board generation. |
| Every minute | Run closing-window source checks and reconcile cached bids, projected closes, confidence, risk, and Deal Scores. Urgent auctions use the bounded sub-minute cadence described below when their source is reachable. |

Page requests read the most recent complete board generation instead of rebuilding thousands of vehicles in the visitor's browser. During a brand-new or delayed database warm-up, the API uses a complete bounded recent official Fleet outcome window so the board remains valued while durable history fills. An incomplete or failed rebuild is never promoted over the last complete generation.

GSA Auctions is additionally refreshed by `.github/workflows/refresh-gsa-auction-data.yml` at minutes 17 and 47. That repository-owned collector updates only the `gsa-auction-data` branch and keeps one-hour signed photo URLs usable even though the Sites runtime is blocked by GSA. It is ordinary, visible website infrastructure in this repository; no Codex/chat scheduled task or desktop session is involved.

## Current GSA Auctions hosted-source limitation

GSA Auctions currently returns HTTP 403 to the Sites/Cloudflare runtime. When direct discovery fails, the deployed site falls back to a strictly validated PPMS runner snapshot generated by the repository workflow. Snapshot responses are visibly labeled, never presented as live polling, and never replaced with demo vehicles. Runner snapshots are accepted for at most 24 hours, and the twice-hourly collector renews their shorter-lived signed image URLs. GSA Fleet Marketplace uses a separate public gateway and remains independently available when this limitation occurs.

A valid runner snapshot can seed D1 while it is inside that freshness window. The GitHub-hosted repository collector can renew catalog facts, snapshot bids, and signed photos, but it is not a sub-minute live-bid connection. Auction-specific 30/15-second closing checks still require an allowed low-latency collector or a supported feed credential. Do not represent GSA Auctions live polling as operational until production source health reports `liveBidPolling: true`.

## Local development

```powershell
pnpm install
pnpm dev
```

Copy `.env.example` to `.env.local` when adding provider credentials. Never commit secrets.

## Quality checks

```powershell
pnpm test
pnpm lint
pnpm exec drizzle-kit generate
```

The test suite covers PPMS catalog/detail/image normalization, the legacy credential-safe fallback, mileage conflicts, damage and issue extraction, nullable source facts, valuation/forecast separation, cost and safe-ceiling math, live-bid refresh boundaries, server-rendered pages, and social metadata.

## Target monitoring cadence

| Time remaining | Auction-specific check cadence |
| --- | ---: |
| More than 30 minutes | 1 hour |
| 30 minutes to 5 minutes | 5 minutes |
| 5 minutes to 1 minute | 30 seconds |
| Final minute | 15 seconds |
| Scheduled close, outcome unconfirmed | 15-second grace, then reconciliation |

The website's server-side scheduler implements these boundaries without requiring an open browser, but checks run only when the upstream live adapter is reachable. The current hosted deployment is permission-gated by GSA and explicitly displays snapshot warnings instead of claiming that these checks succeeded. Once an allowed collector is connected, changed bids, extensions, and terminal high bids can be persisted by the same website-native jobs.

## Important disclaimer

BidAI Pro is independent research software and is not affiliated with or endorsed by the U.S. General Services Administration. It does not place bids. Users must verify live bids, extensions, reserve status, condition, title documentation, inspection terms, and closing times on the official auction record.
