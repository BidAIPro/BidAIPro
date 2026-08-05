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
- Official listing photos use short-lived GSA-signed URLs. Up to six photos per lot are preserved in an accessible full-screen gallery with keyboard and thumbnail navigation; expired links degrade to a placeholder.
- Structured odometer mileage is retained as the primary source fact. When the narrative description reports a different mileage, both readings are preserved and the vehicle is visibly marked for verification.
- GSA Fleet inventory is read from its shared-public GraphQL gateway. Internet auctions retain current bids and public anonymized bidder-high snapshots; scheduled Live sales are labeled as offline events and never receive an invented online bid. Active/coming rows are classified from official start/end timestamps because the upstream feed reports both under its Active status.
- Numeric market evidence is pulled automatically and kept separate from the live bid. Current inventory is valued from official GSA Auctions terminal high bids and confirmed GSA Fleet Sold/Awarded outcomes. The v2 matcher retains one or two genuinely close comps instead of widening, enforces hard family/class/year/mileage/condition/operability limits, separates easily confused models, deduplicates relisted VINs, caps the pool at 15, and penalizes sparse or dispersed evidence. Valid cached CarMax recent-offer evidence can take precedence where it is stronger. Every displayed number identifies its source, sample count, as-of date, match basis, and confidence; manual KBB, CARFAX, Edmunds, and J.D. Power links remain secondary cross-checks only.
- Projected close is recomputed from the current official bid, scheduled time remaining, similar terminal outcomes, public bid activity when available, and the market-value range. Before a public bid appears, a visibly low-confidence market/outcome-only projection is shown without inventing a $0 bid or activating a Deal Score. It remains explicitly reference-only until calibrated time-matched bid curves have adequate coverage; it is never used to make a reference-only record actionable.
- A closed GSA high bid is not called a sale until an authoritative award source confirms the outcome.
- The comparable ledger accrues outcomes for lots observed by this installation. GSA Auctions terminal high bids refresh at minute 39; confirmed GSA Fleet Sold/Awarded outcomes refresh at minute 49. High bids and authoritative award/proceeds prices remain separate fields.
- `scripts/export-gsa-market-valuations.mjs` keeps a validated retained checkpoint at `work/gsa-closed-comps.json`. Normal runs fetch one or more bounded, overlapping increments and merge them idempotently; `--full` intentionally rebuilds the baseline. The public valuation snapshot is replaced only after the corpus is fully caught up and passes completeness and subject-bid-leakage checks.

## Current GSA Auctions hosted-source limitation

GSA Auctions currently returns HTTP 403 to both the Sites/Cloudflare runtime and GitHub-hosted Actions runners. The deployed site therefore uses a strictly validated, manually published PPMS snapshot when direct GSA Auctions discovery fails. Snapshot responses are visibly labeled, never presented as live polling, and never replaced with demo vehicles. Vehicle facts expire after 24 hours; short-lived GSA Auctions image links are removed after 55 minutes. GSA Fleet Marketplace uses a separate public gateway and remains independently available when this limitation occurs.

The current snapshot can seed D1 once while it is inside the source freshness window, but it cannot create continuing bid history by itself. Automatic catalog refresh and auction-specific closing checks require either an allowed-network collector or a configured supported GSA feed credential. Do not represent the cadence below as operational until production source health reports `liveBidPolling: true`.

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

The scheduler and browser policy implement these boundaries, but checks run only when the upstream live adapter is reachable. The current hosted deployment is permission-gated by GSA and explicitly displays snapshot warnings instead of claiming that these checks succeeded. Once an allowed collector is connected, changed bids, extensions, and terminal high bids can be persisted without requiring an open browser.

## Important disclaimer

BidAI Pro is independent research software and is not affiliated with or endorsed by the U.S. General Services Administration. It does not place bids. Users must verify live bids, extensions, reserve status, condition, title documentation, inspection terms, and closing times on the official auction record.
