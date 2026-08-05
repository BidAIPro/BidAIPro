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
  assert.match(html, /Safe bid ceiling/i);
  assert.match(html, /demo references|licensed KBB|not KBB/i);
  assert.match(html, /Not affiliated with or endorsed by/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders a complete vehicle underwriting dossier", async () => {
  const response = await render("/vehicle/gsa-372696");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /2018 Dodge Durango SXT/i);
  assert.match(html, /Vehicle dossier/i);
  assert.match(html, /All-in cost waterfall/i);
  assert.match(html, /Comparable outcome ledger/i);
  assert.match(html, /Open official auction/i);
});

test("server-renders the comparable outcome ledger with explicit award semantics", async () => {
  const response = await render("/comps");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Comparable ledger/i);
  assert.match(html, /closed high bid is not proof/i);
  assert.match(html, /Historical bulk backfill is not active/i);
});

test("keeps social metadata and database capability wired", async () => {
  const [layout, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /\/og\.png/);
  assert.match(layout, /x-forwarded-host/);
  assert.match(hosting, /"d1"\s*:\s*"DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(templateRoot);
});

test("keeps the open deal board fresh and expires reference snapshots", async () => {
  const [board, opportunityRoute] = await Promise.all([
    readFile(new URL("../app/components/deal-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/opportunities/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(board, /fetch\("\/api\/opportunities"/);
  assert.match(board, /setInterval\(\(\) => void loadOpportunities\(\), 60 \* 60_000\)/);
  assert.match(board, /setAuctions\(payload\.data\)/);
  assert.doesNotMatch(board, /setTimeout\(\(\) =>[^]*650/);
  assert.match(opportunityRoute, /Date\.parse\(auction\.endsAt\) > now/);
});
