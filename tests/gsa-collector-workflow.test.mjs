import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hosted collector uses the keyed official fallback and no-ops explicitly when unconfigured", async () => {
  const [workflow, exporter, readme] = await Promise.all([
    readFile(new URL("../.github/workflows/refresh-gsa-auction-data.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/export-gsa-snapshot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /GSA_API_KEY: \$\{\{ secrets\.GSA_API_KEY \}\}/);
  assert.match(workflow, /id: configuration/);
  assert.match(workflow, /configured=false/);
  assert.match(workflow, /successful no-op/);
  assert.match(workflow, /if: steps\.configuration\.outputs\.configured == 'true'/);
  assert.match(workflow, /Warm the website's precomputed deal board/);
  assert.match(workflow, /api\/opportunities\?warm=1/);
  assert.match(workflow, /--request POST/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /GSA_API_KEY:\s*DEMO_KEY|api_key=DEMO_KEY/);
  assert.match(exporter, /getGsaVehicleAuctions/);
  assert.match(exporter, /prepareGsaRunnerSnapshot/);
  assert.match(exporter, /apiKey: process\.env\.GSA_API_KEY/);
  assert.doesNotMatch(exporter, /fetchPpmsVehicleAuctions/);
  assert.match(readme, /api\.data\.gov\/signup/);
  assert.match(readme, /repository secret named `GSA_API_KEY`/);
  assert.match(readme, /explicit successful no-op/);
});
