# BidAI Pro architecture

## What GitHub Pages provides now

GitHub Pages hosts the BidAI Pro control surface as a static application. All current calculations run in the browser, and workspace data remains in that browser's local storage unless the user exports it.

The current application supports:

- user-entered and imported auction snapshots;
- repeated observations for the same listing;
- landed-cost and conservative resale calculations;
- maximum-bid, opportunity, demand, rarity, and confidence signals;
- watchlists, settings, outcome recording, and local calibration;
- portable JSON backups.

GitHub Pages cannot run a database, scheduled monitor, secret API keys, or a continuously active agent. Closing the browser stops all activity.

## Production monitoring path

The static site is designed to become the control surface for a separate, permissioned intelligence service:

```text
Authorized auction feed or user exports
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

Recommended hosted components:

- a scheduled worker for an approved feed;
- a SQL database for listings, snapshots, outcomes, comparable sales, predictions, and model versions;
- object storage for source documents and images when licensing permits;
- category-specific resale integrations and a licensed precious-metals feed;
- immutable prediction records so every forecast can be evaluated without future-data leakage.

## Learning loop

Each listing should have a stable source ID. Repeated observations are appended with timestamps. When the auction ends, its actual final price is joined to every earlier prediction. Category-level calibration then learns the typical difference between predicted and actual closes.

The economic maximum bid remains independent of the predicted closing price:

```text
maximum bid = conservative net resale value
              - minimum required profit
              - shipping, tax, fees, repair, return, and risk reserves
```

The closing-price forecast estimates whether the user is likely to win at that maximum; it must never raise the maximum merely because other bidders may pay more.

## Safety and confidence

The product should show a distribution and evidence quality rather than promise profit. Missing shipping, uncertain identity, unverified precious-metal content, thin comparable sales, or authenticity risk should force a research label or lower bid ceiling.

Automatic collection should be enabled only for a source the operator is authorized to access programmatically. The GitHub Pages application therefore makes no automated requests to ShopGoodwill.
