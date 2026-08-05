import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

// The production bundle runs inside workerd, where this module is native.
// Stub only the unused binding object so Node can exercise the HTML renderer.
register(new URL("./cloudflare-workers-loader.mjs", import.meta.url));

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the production Deal Board", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Deal Board · BidAI Pro<\/title>/i);
  assert.match(html, /BIDAI/);
  assert.match(html, /The deal board/i);
  assert.match(html, /Official GSA vehicle intelligence/i);
  assert.match(html, /Modeled headroom/i);
  assert.match(html, /Automatic market pricing/i);
  assert.match(html, /Not affiliated with or endorsed by/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders a complete vehicle underwriting dossier", async () => {
  const response = await render("/vehicle/gsa-372696");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /2018 Dodge Durango SXT/i);
  assert.match(html, /Vehicle dossier/i);
  assert.match(html, /Odometer mileage/i);
  assert.match(html, /Damage, condition &amp; disclosed issues/i);
  assert.match(html, /All-in cost waterfall/i);
  assert.match(html, /Current bid .*no added costs/i);
  assert.match(html, /Modeled added-cost total/i);
  assert.match(html, /Modeled all-in cost now/i);
  assert.match(html, /Automatic numeric market evidence/i);
  assert.match(html, /Mileage \+ condition estimate/i);
  assert.match(html, /Secondary verification links/i);
  assert.match(html, /KBB/i);
  assert.match(html, /Comparable outcome ledger/i);
  assert.match(html, /Forecast evidence/i);
  assert.match(html, /Close forecast/i);
  assert.match(html, /Open official auction/i);
});

test("server-renders the comparable outcome ledger with explicit award semantics", async () => {
  const response = await render("/comps");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Comparable ledger/i);
  assert.match(html, /closed high bid is not proof/i);
  assert.match(html, /hourly official closed-catalog sync adds terminal high bids/i);
});

test("keeps social metadata and database capability wired", async () => {
  const [layout, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /\/og\.png/);
  assert.match(layout, /bidaipro\.github\.io\/BidAIPro/);
  assert.match(hosting, /"d1"\s*:\s*"DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(templateRoot);
});

test("keeps the open deal board fresh and expires reference snapshots", async () => {
  const [board, opportunityRoute, gallery, liveDetail, comparableLedger, styles, evidenceLabels] = await Promise.all([
    readFile(new URL("../app/components/deal-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/opportunities/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/vehicle-gallery.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/live-vehicle-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/comps/comparable-ledger.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/evidence-labels.ts", import.meta.url), "utf8"),
  ]);

  assert.match(board, /fetch\(publicApiUrl\("\/api\/opportunities"\)/);
  assert.match(board, /fetchGsaRunnerSnapshot/);
  assert.match(board, /publishedSnapshotOpportunities/);
  assert.match(board, /OPPORTUNITY_REQUEST_TIMEOUT_MS/);
  assert.match(board, /LIVE_BID_REQUEST_TIMEOUT_MS/);
  assert.match(board, /controller\.abort\(\)/);
  assert.match(board, /Vehicle catalog temporarily unavailable/);
  assert.match(board, /className={`state-select/);
  assert.match(board, /All states \(\{activeAuctionCount\}\)/);
  assert.match(board, /market values continue filling in after vehicles appear/);
  assert.match(board, /Official closed-catalog results are imported hourly/);
  assert.match(liveDetail, /OPPORTUNITY_REQUEST_TIMEOUT_MS/);
  assert.match(liveDetail, /MARKET_VALUE_REQUEST_TIMEOUT_MS/);
  assert.match(liveDetail, /LIVE_BID_REQUEST_TIMEOUT_MS/);
  assert.match(comparableLedger, /LEDGER_REQUEST_TIMEOUT_MS/);
  assert.match(board, /setInterval\(\(\) => void loadOpportunities\(\), 60 \* 60_000\)/);
  assert.match(board, /PHOTOS_RETRY_INTERVAL_MS/);
  assert.match(board, /visibilitychange/);
  assert.match(board, /Photos temporarily refreshing/);
  assert.match(board, /photosRefreshing=\{photosNeedRefresh\}/);
  assert.match(board, /setAuctions\(\(current\) =>/);
  assert.match(board, /\/api\/live-bid\?id=\$\{encodeURIComponent\(auction\.externalId\)\}/);
  assert.match(board, /getRefreshDecision/);
  assert.match(board, /remainingMs > 30 \* 60_000/);
  assert.match(board, /if \(!sourceMeta\.liveBidPolling\) return/);
  assert.match(board, /Snapshot only · verify bid/);
  assert.match(board, /MarketValueEvidence/);
  assert.match(board, /\/api\/market-values\?ids=/);
  assert.match(board, /applyValuationToOpportunity/);
  assert.match(board, /VehicleGallery/);
  assert.match(board, /value: "confidence", label: "Highest confidence"/);
  assert.match(board, /sort === "confidence"[^\n]+assessment\.confidence/);
  assert.match(board, /selectedSort\.orderCopy/);
  assert.match(evidenceLabels, /Close forecast · no matched comps/);
  assert.match(evidenceLabels, /valuation .*comps.* used/);
  assert.doesNotMatch(board, /forecast\.sampleSize\} GSA comps/);
  assert.match(styles, /\.state-select select, \.sort-select select \{ position: absolute; inset: 0;[^}]+opacity: 0;/);
  assert.doesNotMatch(board, /setTimeout\(\(\) =>[^]*650/);
  for (const publicClient of [board, liveDetail, comparableLedger]) {
    assert.doesNotMatch(publicClient, /cache:\s*["']no-store["']/);
  }
  assert.match(opportunityRoute, /Date\.parse\(auction\.endsAt\) > now/);
  assert.match(opportunityRoute, /status: "stale"/);
  assert.doesNotMatch(opportunityRoute, /imageUrl: null, images: \[\]/);
  assert.match(opportunityRoute, /liveBidPolling: false/);
  assert.doesNotMatch(opportunityRoute, /SEED_AUCTIONS/);
  assert.match(opportunityRoute, /publicApiHeaders/);
  assert.match(gallery, /aria-modal="true"/);
  assert.match(gallery, /ArrowLeft/);
  assert.match(gallery, /ArrowRight/);
  assert.match(gallery, /Escape/);
});
