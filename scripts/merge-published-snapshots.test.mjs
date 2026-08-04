import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  mergeEnvelopes,
  mergeSnapshotFiles,
  parseCliArguments,
  parseSnapshotSource,
  serializeSnapshot,
} from "./merge-published-snapshots.mjs";

const scriptPath = fileURLToPath(new URL("./merge-published-snapshots.mjs", import.meta.url));

function listing(overrides = {}) {
  return {
    id: "stable-local-id",
    externalId: "42",
    sourceKey: "shopgoodwill",
    source: "ShopGoodwill",
    title: "Vintage camera",
    currentBid: 100,
    status: "active",
    endsAt: "2026-08-04T14:00:00.000Z",
    observedAt: "2026-08-04T12:00:00.000Z",
    lastCheckedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    observedAt: "2026-08-04T12:00:00.000Z",
    lastCheckedAt: "2026-08-04T12:00:00.000Z",
    sourceMode: "test",
    sourceNotes: [],
    sourceHealth: {},
    items: [],
    ...overrides,
  };
}

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("merges concurrent listing changes without losing evidence or stable identity", () => {
  const target = envelope({
    observedAt: "2026-08-04T12:05:00.000Z",
    lastCheckedAt: "2026-08-04T12:05:00.000Z",
    sourceNotes: ["local catalog"],
    sourceHealth: {
      shopgoodwill: { checkedAt: "2026-08-04T12:05:00.000Z", status: "connected", itemCount: 12 },
      ebay: { checkedAt: "2026-08-04T11:00:00.000Z", status: "temporarily-unavailable" },
    },
    serperRetailEnrichment: {
      lastRunAt: "2026-08-04T12:05:00.000Z",
      requested: 2,
      queueSize: 1,
      queue: [{
        queryKey: "camera",
        listingKeys: ["id:stable-local-id"],
        lastAttemptAt: "2026-08-04T12:05:00.000Z",
        attempts: 2,
        lastStatus: "available",
      }],
    },
    items: [listing({
      currentBid: 125,
      observedAt: "2026-08-04T12:05:00.000Z",
      lastCheckedAt: "2026-08-04T12:05:00.000Z",
      observations: [
        { observedAt: "2026-08-04T12:00:00.000Z", currentBid: 100 },
        { observedAt: "2026-08-04T12:05:00.000Z", currentBid: 125 },
      ],
      retailMarket: { checkedAt: "2026-08-04T11:00:00.000Z", provider: "local", priceMedian: 230 },
      comparableSales: [{ source: "eBay", externalId: "sale-1", soldPrice: 220, endedAt: "2026-07-01T00:00:00.000Z" }],
      retailMarketHistory: [{ checkedAt: "2026-08-04T12:05:00.000Z", provider: "local", priceMedian: 250 }],
    })],
  });
  const incoming = envelope({
    observedAt: "2026-08-04T12:00:00.000Z",
    lastCheckedAt: "2026-08-04T12:00:00.000Z",
    sourceNotes: ["remote pricing"],
    sourceHealth: {
      shopgoodwill: { checkedAt: "2026-08-04T12:00:00.000Z", status: "partial", message: "Older diagnostic retained" },
      ebay: { checkedAt: "2026-08-04T12:10:00.000Z", status: "connected", itemCount: 45 },
    },
    serperRetailEnrichment: {
      lastRunAt: "2026-08-04T12:00:00.000Z",
      rateLimitedAt: "2026-08-04T12:00:00.000Z",
      queueSize: 2,
      queue: [
        { queryKey: "camera", listingKeys: ["external:shopgoodwill:42"], lastAttemptAt: "2026-08-04T12:00:00.000Z", attempts: 1 },
        { queryKey: "lens", listingKeys: ["external:shopgoodwill:84"], attempts: 0 },
      ],
    },
    items: [listing({
      id: "different-generated-id",
      retailMarket: { checkedAt: "2026-08-04T12:00:00.000Z", provider: "remote", priceMedian: 245 },
      observations: [{ observedAt: "2026-08-04T12:00:00.000Z", currentBid: 100, bidCount: 4 }],
      comparableSales: [
        { source: "eBay", externalId: "sale-1", soldPrice: 220, endedAt: "2026-07-01T00:00:00.000Z", url: "https://example.test/sale-1" },
        { source: "eBay", externalId: "sale-2", soldPrice: 240, endedAt: "2026-07-15T00:00:00.000Z" },
      ],
      retailMarketHistory: [{ checkedAt: "2026-08-04T12:00:00.000Z", provider: "remote", priceMedian: 245 }],
    })],
  });

  const merged = mergeEnvelopes(target, incoming);
  assert.equal(merged.items.length, 1);
  const item = merged.items[0];
  assert.equal(item.id, "stable-local-id");
  assert.equal(item.currentBid, 125, "newer auction check must win core fields");
  assert.equal(item.retailMarket.priceMedian, 245, "evidence with its own newer check must survive the newer auction record");
  assert.equal(item.observations.length, 2);
  assert.equal(item.observations[0].bidCount, 4, "duplicate observations should merge richer fields");
  assert.deepEqual(item.comparableSales.map((entry) => entry.externalId), ["sale-1", "sale-2"]);
  assert.equal(item.comparableSales[0].url, "https://example.test/sale-1");
  assert.equal(item.retailMarketHistory.length, 2);
  assert.equal(merged.sourceHealth.shopgoodwill.status, "connected");
  assert.equal(merged.sourceHealth.shopgoodwill.message, "Older diagnostic retained");
  assert.equal(merged.sourceHealth.ebay.status, "connected");
  assert.deepEqual(merged.sourceNotes, ["remote pricing", "local catalog"]);
  assert.equal(merged.serperRetailEnrichment.requested, 2);
  assert.equal(merged.serperRetailEnrichment.rateLimitedAt, "2026-08-04T12:00:00.000Z");
  assert.equal(merged.serperRetailEnrichment.queue.length, 1, "queue entries with no active listing must be removed");
  assert.equal(merged.serperRetailEnrichment.queueSize, 1);
  assert.equal(merged.serperRetailEnrichment.queue.some((entry) => entry.queryKey === "lens"), false);
  assert.equal(merged.serperRetailEnrichment.queue.find((entry) => entry.queryKey === "camera").attempts, 2);
  assert.deepEqual(
    merged.serperRetailEnrichment.queue.find((entry) => entry.queryKey === "camera").listingKeys.sort(),
    ["external:shopgoodwill:42", "id:stable-local-id"],
  );
  assert.equal(merged.lastCheckedAt, "2026-08-04T12:05:00.000Z");
});

test("a newer incoming auction check wins while local-only evidence remains", () => {
  const target = envelope({ items: [listing({
    currentBid: 100,
    resaleMarket: { checkedAt: "2026-08-04T12:01:00.000Z", priceMedian: 300 },
    askingMarketHistory: [{ asOf: "2026-08-04T12:01:00.000Z", provider: "ebay", priceMedian: 300 }],
  })] });
  const incoming = envelope({
    observedAt: "2026-08-04T12:10:00.000Z",
    lastCheckedAt: "2026-08-04T12:10:00.000Z",
    items: [listing({
      id: "remote-id",
      currentBid: 140,
      bidCount: 7,
      observedAt: "2026-08-04T12:10:00.000Z",
      lastCheckedAt: "2026-08-04T12:10:00.000Z",
      observations: [{ observedAt: "2026-08-04T12:10:00.000Z", currentBid: 140, bidCount: 7 }],
    })],
  });

  const [item] = mergeEnvelopes(target, incoming).items;
  assert.equal(item.id, "stable-local-id");
  assert.equal(item.currentBid, 140);
  assert.equal(item.bidCount, 7);
  assert.equal(item.resaleMarket.priceMedian, 300);
  assert.equal(item.askingMarketHistory.length, 1);
});

test("atomically updates the target file and accepts both snapshot encodings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-snapshot-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = join(root, "target.js");
  const incomingPath = join(root, "incoming.json");
  await writeFile(targetPath, serializeSnapshot(envelope({ items: [listing()] })), "utf8");
  await writeFile(incomingPath, JSON.stringify(envelope({
    observedAt: "2026-08-04T12:20:00.000Z",
    lastCheckedAt: "2026-08-04T12:20:00.000Z",
    items: [listing({ currentBid: 160, observedAt: "2026-08-04T12:20:00.000Z", lastCheckedAt: "2026-08-04T12:20:00.000Z" })],
  })), "utf8");

  const merged = await mergeSnapshotFiles(targetPath, incomingPath);
  assert.equal(merged.items[0].currentBid, 160);
  const written = await readFile(targetPath, "utf8");
  assert.ok(written.startsWith("window.BIDAI_LIVE_SNAPSHOTS = "));
  assert.equal(parseSnapshotSource(written).items[0].currentBid, 160);
  assert.deepEqual((await readdir(root)).sort(), ["incoming.json", "target.js"]);
});

test("CLI supports named and positional paths and reports invalid usage", async (t) => {
  assert.deepEqual(parseCliArguments(["--target", "local.js", "--incoming", "remote.js"]), {
    target: "local.js",
    incoming: "remote.js",
  });
  assert.deepEqual(parseCliArguments(["local.js", "remote.js"]), {
    target: "local.js",
    incoming: "remote.js",
  });
  assert.throws(() => parseCliArguments(["--target", "local.js"]), /both target and incoming/i);

  const root = await mkdtemp(join(tmpdir(), "bidaipro-snapshot-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = join(root, "target.js");
  const incomingPath = join(root, "incoming.js");
  await writeFile(targetPath, serializeSnapshot(envelope({ items: [listing()] })), "utf8");
  await writeFile(incomingPath, serializeSnapshot(envelope({
    lastCheckedAt: "2026-08-04T12:30:00.000Z",
    items: [listing({ currentBid: 175, lastCheckedAt: "2026-08-04T12:30:00.000Z" })],
  })), "utf8");

  const positional = await runCli([targetPath, incomingPath], root);
  assert.equal(positional.code, 0, positional.stderr);
  assert.match(positional.stdout, /Merged 1 listing/);
  assert.equal(parseSnapshotSource(await readFile(targetPath, "utf8")).items[0].currentBid, 175);

  const named = await runCli(["--target", targetPath, "--incoming", incomingPath], root);
  assert.equal(named.code, 0, named.stderr);
  assert.equal(parseSnapshotSource(await readFile(targetPath, "utf8")).items.length, 1, "re-merging the same checkpoint must be idempotent");

  const invalid = await runCli(["--target", targetPath], root);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Usage:/);
});
