import assert from "node:assert/strict";
import test from "node:test";

import { mergeOpportunityFeed } from "../lib/opportunity-feed.ts";

function opportunity(overrides = {}) {
  return {
    id: "auction-1",
    lastCheckedAt: "2026-08-05T17:00:00.000Z",
    imageUrl: null,
    images: [],
    valuation: { status: "unavailable" },
    ...overrides,
  };
}

test("an older cached response cannot erase newer renewed photos", () => {
  const current = opportunity({
    lastCheckedAt: "2026-08-05T17:05:00.000Z",
    imageUrl: "https://example.test/new-hero.jpg",
    images: ["https://example.test/new-hero.jpg", "https://example.test/new-side.jpg"],
  });
  const stale = opportunity({ lastCheckedAt: "2026-08-05T17:00:00.000Z" });

  assert.strictEqual(mergeOpportunityFeed([current], [stale])[0], current);
});

test("equal observations prefer the copy with richer image evidence", () => {
  const current = opportunity({
    imageUrl: "https://example.test/hero.jpg",
    images: ["https://example.test/hero.jpg"],
  });
  const stripped = opportunity();

  assert.strictEqual(mergeOpportunityFeed([current], [stripped])[0], current);
});

test("a genuinely newer observation replaces renewed signatures", () => {
  const current = opportunity({
    imageUrl: "https://example.test/old-hero.jpg",
    images: ["https://example.test/old-hero.jpg"],
  });
  const renewed = opportunity({
    lastCheckedAt: "2026-08-05T17:05:00.000Z",
    imageUrl: "https://example.test/new-hero.jpg",
    images: ["https://example.test/new-hero.jpg"],
  });

  assert.strictEqual(mergeOpportunityFeed([current], [renewed])[0], renewed);
});
