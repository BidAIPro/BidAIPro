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
  assert.match(refresh, /--force-with-lease=/);
  assert.doesNotMatch(refresh, /git push origin HEAD:main/);
  assert.match(refresh, /actions\/configure-pages@/);
  assert.match(refresh, /actions\/upload-pages-artifact@/);
  assert.match(refresh, /actions\/deploy-pages@/);
  assert.match(refresh, /Verify a snapshot is available for deployment/);
  assert.match(refresh, /continue-on-error:\s*true/);
  assert.doesNotMatch(index, /<script[^>]+src=["']data\/live-snapshots\.js/i);
  assert.match(script, /raw\.githubusercontent\.com\/BidAIPro\/BidAIPro\/auction-data\/data\/live-snapshots\.js/);
  assert.match(script, /async function fetchPublishedSnapshot/);
});
