import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("generated snapshots are isolated from main and still deployed", async () => {
  const [refresh, ignore, index, script] = await Promise.all([
    readFile(join(root, ".github", "workflows", "refresh-auction-data.yml"), "utf8"),
    readFile(join(root, ".gitignore"), "utf8"),
    readFile(join(root, "index.html"), "utf8"),
    readFile(join(root, "script.js"), "utf8"),
  ]);

  assert.match(ignore, /^data\/live-snapshots\.js$/m);
  assert.match(refresh, /auction-data/);
  assert.match(refresh, /git commit-tree/);
  assert.match(refresh, /merge-published-snapshots\.mjs/);
  assert.match(refresh, /--force-with-lease=/);
  assert.doesNotMatch(refresh, /git push --force(?!-with-lease)/);
  assert.match(refresh, /bidai-\$\{\{[\s\S]*near-close[\s\S]*catalog/);
  assert.doesNotMatch(refresh, /git push origin HEAD:main/);
  assert.match(refresh, /actions\/configure-pages@/);
  assert.match(refresh, /actions\/upload-pages-artifact@/);
  assert.match(refresh, /actions\/deploy-pages@/);
  assert.match(refresh, /Verify a snapshot is available for deployment/);
  assert.match(refresh, /continue-on-error:\s*true/);
  assert.match(refresh, /name: Refresh due auction sources[\s\S]*?if: github\.event_name != 'push'[\s\S]*?refresh-all-sources\.mjs/);
  assert.match(refresh, /cron: "23 5 \* \* \*"/);
  assert.match(refresh, /name: Enrich with keyless exact-product retail references[\s\S]*?BIDAI_FREE_RETAIL_BATCH_SIZE: "20"[\s\S]*?enrich-free-retail\.mjs/);
  assert.match(refresh, /name: Enrich with free-account Rakuten partner retail prices[\s\S]*?BIDAI_RAKUTEN_ACCESS_TOKEN:[\s\S]*?BIDAI_RAKUTEN_RETAIL_BATCH_SIZE: "300"[\s\S]*?enrich-rakuten-retail\.mjs/);
  assert.match(refresh, /name: Research active items through the persistent Google Shopping queue[\s\S]*?BIDAI_SERPER_API_KEY:[\s\S]*?BIDAI_SERPER_MAX_QUERIES_PER_RUN:[\s\S]*?enrich-serper-retail\.mjs/);
  assert.match(refresh, /write-snapshot-manifest\.mjs/);
  assert.match(refresh, /name: Enrich with authorized eBay Browse used asking prices[\s\S]*?if: github\.event_name == 'push'[\s\S]*?enrich-ebay-used\.mjs/);
  assert.match(refresh, /BIDAI_EBAY_USED_BATCH_SIZE:.*'250'.*'100'/);
  assert.doesNotMatch(refresh, /BIDAI_EBAY_USE_BROWSE/);
  assert.doesNotMatch(index, /<script[^>]+src=["']data\/live-snapshots\.js/i);
  assert.match(script, /raw\.githubusercontent\.com\/BidAIPro\/BidAIPro\/auction-data\/data\/live-snapshots\.js/);
  assert.match(script, /async function fetchPublishedSnapshot/);
});
