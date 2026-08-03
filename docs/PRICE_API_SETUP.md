# Retail and resale price setup

BidAI Pro now has one built-in, no-credential retail-catalog path and one authorized broad used-market path. They answer different questions and are deliberately kept separate:

- **Retail catalog reference:** what a correctly identified product has been offered for new at a retailer.
- **Used asking market:** what matched used items are currently listed for online.
- **Completed sales:** what matched items actually sold for; this remains the strongest resale evidence.

No source is allowed to copy the auction's current bid into a retail field.

## Built in: keyless retail catalog matching

`scripts/enrich-free-retail.mjs` uses UPCitemdb's documented free trial endpoints. It needs no account, API key, GitHub token, or repository secret. A dedicated daily GitHub Actions pass runs while the user's computer is off.

The connector:

1. extracts a concise brand/model or product query instead of sending the noisy auction title;
2. checks every returned product rather than trusting the first search result;
3. rejects conflicting model, capacity, size, and bundle identities;
4. stores real USD merchant offers with their links and update timestamps;
5. labels older catalog observations as historical references rather than current offers; and
6. records misses so the same unpriceable titles cannot starve the rest of the queue.

UPCitemdb's free plan permits 100 combined requests per day but only 20 keyword searches per day. BidAI Pro therefore processes a rotating maximum of 20 unique product queries during the daily pass, shares a result across duplicate listings, caches matches, and respects the documented pacing limit. This source is useful for branded/model-number products. It is not expected to identify unique jewelry, art, mixed lots, generic clothing, or one-off vintage items.

A recent exact retail observation can now populate a clearly labeled **retail catalog reference** and provisional price math. Offers older than 45 days and catalog historical low/high values are retained only for audit and cannot populate the displayed current price. A current reference receives a large used-condition/uncertainty reserve and can never create a safe bid or a YES by itself. Current new-retail price is not used resale value.

Official documentation:

- <https://www.upcitemdb.com/api/>
- <https://www.upcitemdb.com/wp/docs/main/development/plan/>
- <https://www.upcitemdb.com/wp/docs/main/development/responses/>

## High-volume current retail: Rakuten Advertising

This is the broad free-account source built for pricing most identifiable branded products. The included `scripts/enrich-rakuten-retail.mjs` adapter checks up to 300 active product groups on each hourly/manual pass, rotates across resale verticals, deduplicates identical products, and accepts only strict title/model/UPC matches with current USD merchant links.

1. [Create a free Rakuten Advertising publisher account](https://pubhelp.rakutenadvertising.com/hc/en-us/articles/20898125890573-Publisher-Sign-Up-Process). Rakuten states that publisher registration and advertiser-program applications have no fee.
2. In the publisher dashboard, apply to relevant advertiser programs. Product Search returns product data only from active advertiser partners.
3. Open the [Rakuten Developer Portal](https://developers.rakutenadvertising.com/), create/copy the Product Search bearer token from **Applications**, and keep it private.
4. In the BidAIPro GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**.
5. Add the token as `BIDAI_RAKUTEN_ACCESS_TOKEN`.
6. Run **Actions → Refresh authorized auction data → Run workflow** once, or wait for the next hourly pass.

This is a retailer API credential, not a GitHub personal-access token. The workflow sends it only to `api.linksynergy.com`; it is never stored in the website data. Rakuten's official Product Search response includes regular price, sale price, UPC, SKU, merchant, and product URL, and the endpoint is documented at 100 calls per minute. These are current new-retail offers—not completed sales, used resale proceeds, popularity proof, or guaranteed profit.

Official documentation:

- <https://developers.rakutenadvertising.com/guides/product_search>
- <https://pubhelp.rakutenadvertising.com/hc/en-us/articles/10623933503373-Product-Links>
- <https://pubhelp.rakutenadvertising.com/hc/en-us/articles/360049778112-Find-and-Apply-to-Advertiser-Programs>

## Broad used asking prices: eBay Browse

eBay decommissioned the Finding API on February 5, 2025. BidAI Pro no longer calls it and never falls back to it. The supported replacement is eBay Browse, which requires client-credentials OAuth and eBay production access.

1. Create an eBay developer account at <https://developer.ebay.com/signin?tab=register>.
2. Create production application keys and complete any Buy API / Partner Network approval eBay requires.
3. In the BidAIPro repository, open **Settings → Secrets and variables → Actions**.
4. Add these repository secrets:

| Secret | Value |
| --- | --- |
| `BIDAI_EBAY_CLIENT_ID` | Production client ID / App ID |
| `BIDAI_EBAY_CLIENT_SECRET` | Production client secret / Cert ID |

No browser GitHub token is involved. GitHub Actions exchanges those secrets for a short-lived eBay access token, uses it only in the cloud job, and never publishes it in the snapshot.

The connector accepts only USD used/pre-owned results with stable IDs, direct links, and adequate title identity. Five close matches can form a used asking-price consensus. A broader five-offer/two-seller set remains a heavily reserved analog. Active asking prices are not completed sales, do not prove sell-through, and cannot establish demand by themselves.

Official deprecation record: <https://www.developer.ebay.com/develop/get-started/api-deprecation-status>

## Where genuinely broad retail prices can come from

There is no legitimate, production-grade API that is simultaneously keyless, unlimited, and able to price arbitrary auction merchandise. The strongest authorized expansion path is a source stack:

| Source | Best use | Access reality |
| --- | --- | --- |
| Rakuten Advertising Product Search | **Included adapter:** broad new-retail price, sale price, UPC, SKU, merchant and product URL | Free publisher account and advertiser relationships; `BIDAI_RAKUTEN_ACCESS_TOKEN` required |
| CJ Affiliate product feeds | Broad merchant catalogs with price, sale price, brand, GTIN/MPN, condition and availability | Free publisher account; token and advertiser relationships required |
| StockX API | Sneakers, streetwear, handbags, electronics, cards and collectibles; live bid/ask plus retail price | Developer approval and OAuth required |
| BrickLink Price Guide | LEGO completed-sale and current-stock statistics | Registered seller and OAuth required |
| Discogs / Reverb | Music media and instruments | Marketplace token and exact catalog matching required |

These are preferable to pretending Amazon, Walmart, or Target expose an unrestricted public pricing feed. Each additional provider must write its own evidence field so one connector cannot erase another connector's results.

## Optional providers already supported

- `BIDAI_SEARCHAPI_KEY` or `BIDAI_SERPAPI_KEY` adds Google Shopping offer research.
- `BIDAI_PRICECHARTING_TOKEN` adds specialty guide, retailer buy/sell, and yearly-volume evidence for supported collectibles.
- `BIDAI_RESALE_FEED_URL` plus optional `BIDAI_RESALE_FEED_TOKEN` connects an authorized completed-sales provider.

## How to verify a refresh

1. Push the local changes with GitHub Desktop.
2. Open **Actions → Refresh authorized auction data → Run workflow** if an immediate cloud run is needed; otherwise wait for the schedule.
3. After the workflow publishes a snapshot, press **Refresh published data** in BidAI Pro.
4. Open an item and inspect **Check the price source**. The dossier must show source links, match tier, observation count, range, reserve, and whether the evidence is current retail, historical retail, active used asking, or completed sale.

Ordinary dashboard refreshes require no GitHub personal-access token.
