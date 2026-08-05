# BidAI Pro — GSA Vehicle Intelligence

BidAI Pro is a vehicle-only government auction intelligence application. It discovers official GSA vehicle listings, preserves auction and bid history, separates market valuation from closing-price forecasts, and calculates a conservative bid ceiling after acquisition, resale, and risk costs.

## Source policy

- The official source is [`gsaauctions.gov`](https://gsaauctions.gov/), not `gsaauctions.com`.
- Hourly discovery uses the documented [GSA Auctions API](https://gsa.github.io/auctions_api/).
- The public bulk feed can lag the interactive auction page. The sub-minute live-detail adapter remains disabled until GSA authorizes that access or supplies a higher-freshness feed.
- KBB is not scraped. `KBB_API_KEY` is reserved for a licensed commercial integration. Demo market references are labeled as reference-only throughout the product.
- A closed GSA high bid is not called a sale until an authoritative award source confirms the outcome.

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

The test suite covers the official-feed normalizer and credential-safe client, valuation/forecast separation, cost and safe-ceiling math, auction refresh boundaries, server-rendered pages, and social metadata.

## Monitoring cadence

| Time remaining | Auction-specific check cadence |
| --- | ---: |
| More than 30 minutes | 1 hour |
| 30 minutes to 5 minutes | 5 minutes |
| 5 minutes to 1 minute | 30 seconds |
| Final minute | 15 seconds |
| Scheduled close, outcome unconfirmed | 15-second grace, then reconciliation |

The scheduling policy is implemented and tested independently of the source adapter. Production sub-minute checks must use an authorized live-detail source; the hourly public feed cannot meet that service level.

## Important disclaimer

BidAI Pro is independent research software and is not affiliated with or endorsed by the U.S. General Services Administration. It does not place bids. Users must verify live bids, extensions, reserve status, condition, title documentation, inspection terms, and closing times on the official auction record.
