import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./refresh-feed.mjs", import.meta.url));

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-feed-test-"));
  const scripts = join(root, "scripts");
  const data = join(root, "data");
  await mkdir(scripts, { recursive: true });
  await mkdir(data, { recursive: true });
  await copyFile(sourceScript, join(scripts, "refresh-feed.mjs"));
  return { root, scripts, data };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  assert.ok(source.startsWith(OUTPUT_PREFIX));
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("Apify mode authenticates, keeps stable history, and lets the newest row win", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const outputPath = join(fixture.data, "live-snapshots.js");
  const priorEnvelope = {
    observedAt: "2026-08-01T10:00:00.000Z",
    sourceMode: "published-manual-research-snapshot",
    sourceNotes: [],
    items: [{
      id: "manual-retained",
      externalId: "manual-retained",
      title: "Retained manual research",
      status: "ended",
      observedAt: "2026-08-01T10:00:00.000Z",
      observations: [],
    }],
  };
  await writeFile(outputPath, `${OUTPUT_PREFIX}${JSON.stringify(priorEnvelope)};\n`, "utf8");

  const expectedUrl = "https://api.apify.com/v2/datasets/demo~auction-data/items?format=json&clean=true&desc=1&limit=5000";
  const payload = [
    {
      externalId: "lot-42",
      title: "Newer auction observation",
      url: "https://example.com/lot-42",
      currentBid: "$1,234.56",
      bidCount: 12,
      taxRate: "8.25%",
      observedAt: "2026-08-02T12:00:00.000Z",
    },
    {
      externalId: "lot-42",
      title: "Older auction observation",
      url: "https://example.com/lot-42",
      currentBid: 900,
      bidCount: 8,
      taxRate: 0.0825,
      observedAt: "2026-08-02T11:00:00.000Z",
    },
  ];
  const preloadPath = join(fixture.root, "mock-fetch.mjs");
  await writeFile(preloadPath, `
    const payload = JSON.parse(Buffer.from(process.env.BIDAI_TEST_PAYLOAD, "base64").toString("utf8"));
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== process.env.BIDAI_TEST_EXPECTED_URL) throw new Error("Unexpected Apify URL");
      if (options.headers?.authorization !== "Bearer test-token") throw new Error("Missing Apify bearer token");
      if (options.headers?.accept !== "application/json") throw new Error("Missing JSON accept header");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const childArgs = ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")];
  const childOptions = {
    cwd: fixture.root,
    env: {
      ...process.env,
      BIDAI_SOURCE_AUTHORIZED: "true",
      BIDAI_APIFY_DATASET_ID: "demo~auction-data",
      BIDAI_APIFY_TOKEN: "test-token",
      BIDAI_FEED_URL: "",
      BIDAI_TEST_EXPECTED_URL: expectedUrl,
      BIDAI_TEST_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const result = await runNode(childArgs, childOptions);

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(outputPath);
  assert.equal(envelope.sourceMode, "apify-dataset");
  assert.equal(envelope.observedAt, "2026-08-02T12:00:00.000Z");
  assert.equal(envelope.items.length, 2);
  const imported = envelope.items.find((item) => item.externalId === "lot-42");
  assert.ok(imported);
  assert.equal(imported.title, "Newer auction observation");
  assert.equal(imported.currentBid, 1234.56);
  assert.equal(imported.bidCount, 12);
  assert.equal(imported.taxRate, 8.25);
  assert.equal(imported.source, "Apify dataset");
  assert.equal(imported.publishedResearch, true);
  assert.equal(imported.url, imported.sourceUrl);
  assert.deepEqual(imported.observations.map((point) => point.currentBid), [900, 1234.56]);
  assert.ok(envelope.items.some((item) => item.id === "manual-retained"));

  const firstOutput = await readFile(outputPath, "utf8");
  const repeatedResult = await runNode(childArgs, childOptions);
  assert.equal(repeatedResult.code, 0, repeatedResult.stderr);
  assert.equal(await readFile(outputPath, "utf8"), firstOutput, "Repeated identical data should be byte-stable");
});

test("authorization guard makes no request and leaves published data unchanged", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const outputPath = join(fixture.data, "live-snapshots.js");
  const original = `${OUTPUT_PREFIX}{"observedAt":null,"sourceMode":"test","sourceNotes":[],"items":[]};\n`;
  await writeFile(outputPath, original, "utf8");
  const preloadPath = join(fixture.root, "reject-fetch.mjs");
  await writeFile(preloadPath, "globalThis.fetch = async () => { throw new Error('fetch must not run'); };\n", "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "false",
        BIDAI_APIFY_DATASET_ID: "demo~auction-data",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No-op/);
  assert.equal(await readFile(outputPath, "utf8"), original);
});

test("generic HTTPS feed mode remains available when no Apify dataset is configured", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const feedUrl = "https://feeds.example.invalid/authorized-auctions.json";
  const preloadPath = join(fixture.root, "generic-fetch.mjs");
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) !== process.env.BIDAI_TEST_EXPECTED_URL) throw new Error("Unexpected generic feed URL");
      if (options.headers?.authorization) throw new Error("Generic feed must not receive the Apify token");
      return new Response(JSON.stringify({
        generatedAt: "2026-08-02T13:00:00.000Z",
        items: [{
          id: "generic-1",
          title: "Generic authorized record",
          sourceUrl: "https://example.com/generic-1",
          currentBid: 42,
          observedAt: "2026-08-02T13:00:00.000Z"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  `, "utf8");

  const result = await runNode(
    ["--import", pathToFileURL(preloadPath).href, join(fixture.scripts, "refresh-feed.mjs")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        BIDAI_SOURCE_AUTHORIZED: "true",
        BIDAI_APIFY_DATASET_ID: "",
        BIDAI_APIFY_TOKEN: "must-not-be-used",
        BIDAI_FEED_URL: feedUrl,
        BIDAI_TEST_EXPECTED_URL: feedUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const envelope = await readEnvelope(join(fixture.data, "live-snapshots.js"));
  assert.equal(envelope.sourceMode, "authorized-feed");
  assert.equal(envelope.items.length, 1);
  assert.equal(envelope.items[0].source, "Authorized feed");
  assert.equal(envelope.items[0].url, "https://example.com/generic-1");
  assert.equal(envelope.items[0].sourceUrl, envelope.items[0].url);
});
