# Free market-price setup

BidAI Pro's default automated pricing path has no recurring API subscription. GitHub Actions runs the research while the computer is off; the public website reads only the resulting evidence.

## 1. Free eBay Finding API — broad merchandise

1. Create a free eBay developer account at <https://developer.ebay.com/signin?tab=register>.
2. Create production application keys.
3. Copy the production **App ID (Client ID)**. The default Finding API pricing route does not need the Cert ID or OAuth.
4. Open the BidAIPro repository on GitHub.
5. Go to **Settings → Secrets and variables → Actions → New repository secret**.
6. Add it as `BIDAI_EBAY_CLIENT_ID`.

The hourly workflow sends the App ID only to eBay's Finding service. It uses at most one close-title query plus one category fallback for each unique product group. With the configured 100-group hourly batch, the bounded worst case is 4,800 searches per day. Duplicate auction listings reuse the same response.

The eBay pricing ladder is:

1. Five or more close used-title matches: used asking-price consensus with the standard planning haircut.
2. Five or more broader title matches from at least two eBay sellers: reference-only analog with a 55% reserve.
3. Five or more category matches from at least two eBay sellers: reference-only category benchmark with a 65% reserve.

Active asking prices are not completed sales. Tiers 2 and 3 show a provisional price and estimated profit, but never create a safe bid ceiling or pretend to prove demand.

## 2. Run it

1. Push the local changes with GitHub Desktop.
2. Open **Actions → Refresh authorized auction data → Run workflow**.
3. After the workflow publishes its snapshot, press **Refresh published data** in BidAI Pro.

No GitHub personal-access token is needed for ordinary refreshes. The eBay App ID remains encrypted in GitHub Actions and is never written into the website or published snapshot.

If eBay later approves the application for its limited-release Browse API, you may also add `BIDAI_EBAY_CLIENT_SECRET` and set the repository variable `BIDAI_EBAY_USE_BROWSE=true`. That is optional; free Finding pricing remains the default.

## Why Amazon, Walmart, and Target are not the default

- Amazon's product API is tied to the Associates program and currently requires qualifying sales; it is not an open zero-cost catalog for this use case.
- Walmart's documented catalog and pricing APIs require an approved Marketplace seller or solution-provider account.
- Target does not publish a comparable general-purpose product-pricing API.
- Best Buy publishes a free API, but its current terms restrict using the data to analyze Best Buy pricing for another retailer and limit caching to 72 hours. That is incompatible with BidAI Pro's resale analysis and long-term price history.

Automating undocumented store endpoints would be brittle and could stop without warning. BidAI Pro uses the official free eBay interface instead.

## Optional providers

- `BIDAI_SEARCHAPI_KEY` or `BIDAI_SERPAPI_KEY` adds paid Google Shopping coverage, but neither is required.
- `BIDAI_PRICECHARTING_TOKEN` adds paid specialty-guide data for supported games and collectibles.
- An authorized completed-sales feed remains the strongest input because it can supply actual sold prices and resale velocity.
