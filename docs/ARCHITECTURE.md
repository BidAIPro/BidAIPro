# BidAI Pro architecture

## What GitHub Pages provides now

GitHub Pages hosts the BidAI Pro control surface as a static application. All current calculations run in the browser, and workspace data remains in that browser's local storage unless the user exports it.

The current application supports:

- user-entered and imported auction snapshots;
- repeated observations for the same listing;
- direct links from every sourced opportunity to its canonical auction page;
- marketplace filtering and connection health for ten auction-market families;
- landed-cost and conservative resale calculations;
- maximum-bid, opportunity, demand, rarity, and confidence signals;
- watchlists, settings, outcome recording, and local calibration;
- portable JSON backups.

GitHub Pages cannot run a database, scheduled monitor, secret API keys, or a continuously active agent. The repository's GitHub Actions workflow provides scheduled server-side orchestration while Pages remains the static control surface.

## Production monitoring path

The static site is designed to become the control surface for a separate, permissioned intelligence service:

```text
ShopGoodwill public catalog, Apify Tasks, authorized feeds, or user exports
                  |
                  v
     Adaptive multi-source scheduler
                  |
                  v
          Snapshot ingestion
                  |
                  v
    Identity + condition normalization
                  |
        +---------+---------+
        |                   |
        v                   v
 Auction-close model   Resale valuation
        |                   |
        +---------+---------+
                  |
                  v
       Profit/risk distribution
                  |
                  v
         BidAI Pro dashboard
```

The included workflow supplies built-in ShopGoodwill discovery, the adaptive scheduler, the normalized snapshot store, live spot-metal context, and a guarded completed-sales enrichment hook. A fuller production service can add:

- a durable job queue for higher source counts and long-running collectors;
- a SQL database for listings, snapshots, outcomes, comparable sales, predictions, and model versions;
- object storage for source documents and images when licensing permits;
- category-specific resale integrations and a licensed precious-metals feed;
- immutable prediction records so every forecast can be evaluated without future-data leakage.

## Learning loop

Each listing should have a stable source ID. The first observation and only later strictly higher bids are appended with timestamps; unchanged and lower prices are discarded. A forecast stored on an observation is treated as an immutable point-in-time prediction. When the auction ends, its actual final price is joined without rewriting that forecast.

The dashboard reports one fixed-horizon calibration sample per ended listing: the eligible verified forecast nearest six hours before close, limited to a three-to-nine-hour window. Source estimates, post-close forecasts, and forecasts whose five-outcome exact-model evidence cannot be revalidated are excluded. Category-level calibration then measures the typical difference between those approximately six-hour predictions and actual closes.

Auction-close forecasting and resale valuation use separate evidence. `exactModelCount` means completed auction-close outcomes with the same normalized model key; completed resale sales never satisfy that five-outcome forecast threshold. Resale calculations use empirical P20, median, average, and P80 values when at least three qualifying exact-model completed sales exist; P20 is the quick-sale target and the median anchors profit. Sold-versus-active counts and median days to sell produce a separate liquidity score. Explicit source resale ranges and auction bid counts remain audit inputs, never substitutes for completed-sale velocity.

The economic maximum bid remains independent of the predicted closing price:

```text
maximum bid = conservative net resale value
              - minimum required profit
              - shipping, tax, fees, repair, return, and risk reserves
```

The closing-price forecast estimates whether the user is likely to win at that maximum; it must never raise the maximum merely because other bidders may pay more.

## Safety and confidence

The product should show a distribution and evidence quality rather than promise profit. Missing shipping, uncertain identity, unverified precious-metal content, thin comparable sales, or authenticity risk should force a research label or lower bid ceiling.

The GitHub Pages application makes no cross-origin marketplace requests. GitHub Actions performs the built-in ShopGoodwill public-catalog calls and any configured Apify/feed calls server-side; the browser reads only normalized real records committed by the workflow. Authentication wording from a source is preserved as a claim, never upgraded to an independent verification.
