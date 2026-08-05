import assert from "node:assert/strict";
import test from "node:test";

import {
  closeForecastEvidenceLabel,
  valuationEvidenceCountLabel,
} from "../lib/evidence-labels.ts";

test("keeps valuation and close-forecast evidence counts explicitly separate", () => {
  assert.equal(
    valuationEvidenceCountLabel({ sampleSize: 30, valuationType: "auction-comp" }),
    "30 valuation comps used",
  );
  assert.equal(
    closeForecastEvidenceLabel({ sampleSize: 0 }),
    "Close forecast · no matched comps",
  );
});

test("uses provider-neutral wording for non-auction market evidence", () => {
  assert.equal(
    valuationEvidenceCountLabel({ sampleSize: 1, valuationType: "retail" }),
    "1 market observation",
  );
  assert.equal(
    closeForecastEvidenceLabel({ sampleSize: 4 }),
    "Close forecast · 4 matched comps",
  );
});
