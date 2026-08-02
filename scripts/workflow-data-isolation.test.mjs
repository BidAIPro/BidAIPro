import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("generated snapshots are isolated from main and still deployed", async () => {
  const [refresh, ignore] = await Promise.all([
    readFile(join(root, ".github", "workflows", "refresh-auction-data.yml"), "utf8"),
    readFile(join(root, ".gitignore"), "utf8"),
  ]);

  assert.match(ignore, /^data\/live-snapshots\.js$/m);
  assert.match(refresh, /auction-data/);
  assert.match(refresh, /git commit-tree/);
  assert.doesNotMatch(refresh, /git push origin HEAD:main/);
  assert.match(refresh, /actions\/configure-pages@/);
  assert.match(refresh, /actions\/upload-pages-artifact@/);
  assert.match(refresh, /actions\/deploy-pages@/);
});
