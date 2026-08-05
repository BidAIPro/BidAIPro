import assert from "node:assert/strict";
import test from "node:test";

import { compactOpportunityForBoard } from "../lib/opportunity-presentation.ts";
import { SEED_AUCTIONS } from "../lib/seed-auctions.ts";

test("board serialization removes detail-only Fleet payload without losing pricing facts", () => {
  const source = {
    ...SEED_AUCTIONS[0],
    source: "gsa-fleet",
    images: ["https://example.test/one.jpg", "https://example.test/two.jpg"],
    vehicle: {
      ...SEED_AUCTIONS[0].vehicle,
      description: "Long official detail comments",
    },
    forecast: {
      ...SEED_AUCTIONS[0].forecast,
      evidenceIds: ["one", "two"],
      outcomeAnchors: Array.from({ length: 20 }, (_, index) => ({
        id: `outcome-${index}`,
        adjustedCloseCents: 1_200_000 + index * 10_000,
        matchScore: 0.9,
        weight: 1,
      })),
    },
    assessment: {
      ...SEED_AUCTIONS[0].assessment,
      warnings: ["Detailed warning"],
      reasonCodes: ["PRIMARY", "SECONDARY"],
    },
  };

  const compact = compactOpportunityForBoard(source);

  assert.deepEqual(compact.images, ["https://example.test/one.jpg"]);
  assert.equal(compact.vehicle.description, "");
  assert.deepEqual(compact.forecast.evidenceIds, []);
  assert.deepEqual(
    compact.forecast.outcomeAnchors,
    source.forecast.outcomeAnchors.slice(0, 15),
  );
  assert.deepEqual(compact.assessment.warnings, []);
  assert.deepEqual(compact.assessment.reasonCodes, ["PRIMARY"]);
  assert.equal(compact.currentBidCents, source.currentBidCents);
  assert.equal(compact.forecast.expectedCents, source.forecast.expectedCents);
  assert.equal(compact.valuation.medianCents, source.valuation.medianCents);
});

test("preview board rows omit close anchors because urgent polling cannot run", () => {
  const source = {
    ...SEED_AUCTIONS[0],
    status: "preview",
    forecast: {
      ...SEED_AUCTIONS[0].forecast,
      outcomeAnchors: [
        { id: "preview-outcome", adjustedCloseCents: 1_200_000 },
      ],
    },
  };

  assert.deepEqual(compactOpportunityForBoard(source).forecast.outcomeAnchors, []);
});
