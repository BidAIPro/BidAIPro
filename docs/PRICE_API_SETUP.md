# Real market-price setup

BidAI Pro can automatically attach Google Shopping prices while the computer is off. GitHub Actions performs the research; the website only reads the published results.

## Recommended provider: SearchAPI

1. Create a SearchAPI account at <https://www.searchapi.io/> and copy its API key.
2. Open the BidAIPro repository on GitHub.
3. Go to **Settings → Secrets and variables → Actions → New repository secret**.
4. Name the secret `BIDAI_SEARCHAPI_KEY` and paste the API key as its value.
5. Open **Actions → Refresh authorized auction data → Run workflow**.

No GitHub personal-access token is needed for normal refreshes. The SearchAPI key is a price-provider credential and remains encrypted in GitHub Actions; it is never written into the website or published snapshot.

The workflow processes up to 200 unique Shopping queries each hour. Identical normalized product queries share one response. Each item follows this pricing ladder:

1. Exact or close used-market offers from at least five listings and two merchants.
2. Exact or close new-retail offers from at least five listings and two merchants, with the configured resale discount.
3. Broader title analogs from at least five real Shopping offers and two merchants.
4. A category-level Shopping benchmark when the unique title returns too few offers.

Tiers 3 and 4 are visibly labeled **Google market analog**, retain the merchant links and observed range, receive a 55% planning reserve, and cannot create a safe bid ceiling by themselves.

## Alternate providers

- `BIDAI_SERPAPI_KEY` uses SerpApi's Google Shopping API when SearchAPI is not configured.
- `BIDAI_EBAY_CLIENT_ID` and `BIDAI_EBAY_CLIENT_SECRET` add eBay active-used offers for identifiable products.
- `BIDAI_PRICECHARTING_TOKEN` adds specialty guide and retailer-reference values for supported games, cards, comics, and collectibles.
- An authorized completed-sales feed remains the strongest source because it supplies actual sold prices and resale velocity.

SearchAPI takes priority if both Shopping-provider secrets exist.
