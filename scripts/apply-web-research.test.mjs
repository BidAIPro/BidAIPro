import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const sourceScript = fileURLToPath(new URL("./apply-web-research.mjs", import.meta.url));

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bidaipro-web-research-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await copyFile(sourceScript, join(root, "scripts", "apply-web-research.mjs"));
  const snapshotPath = join(root, "data", "live-snapshots.js");
  const findingsPath = join(root, "data", "web-research-findings.json");
  const envelope = {
    observedAt: "2026-08-02T21:00:00.000Z",
    sourceMode: "test",
    sourceNotes: [],
    items: [{ id: "one", sourceKey: "shopgoodwill", externalId: "123", title: "Example item" }],
  };
  const findings = {
    generatedAt: "2026-08-02T22:00:00.000Z",
    method: "Agent public web research",
    findings: [{
      sourceKey: "shopgoodwill",
      externalId: "123",
      query: "Example item sold",
      summary: "A public sold result was found.",
      limitation: "One result cannot establish a ceiling.",
      priceSummary: { currency: "USD", sampleSize: 1, soldSampleSize: 1, median: 75, decisionEligible: true },
      results: [{
        title: "Example item sold result",
        url: "https://market.example/item/123",
        source: "Example market",
        price: 75,
        listingState: "sold",
        matchType: "close match",
        dateLabel: "Sold Jul 1, 2026",
      }],
    }],
  };
  await writeFile(snapshotPath, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");
  await writeFile(findingsPath, `${JSON.stringify(findings)}\n`, "utf8");
  return { root, snapshotPath };
}

async function readEnvelope(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
}

test("agent web findings attach an auditable reference-only ledger without authorizing a ceiling", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const result = await runNode([join(sample.root, "scripts", "apply-web-research.mjs")], {
    cwd: sample.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Applied public web research to 1/);
  const item = (await readEnvelope(sample.snapshotPath)).items[0];
  assert.equal(item.researchMarket.status, "reference-only");
  assert.equal(item.researchMarket.priceSummary.median, 75);
  assert.equal(item.researchMarket.priceSummary.decisionEligible, false);
  assert.equal(item.researchMarket.results[0].listingState, "sold");
  assert.equal(item.researchMarket.results[0].url, "https://market.example/item/123");
});

test("reapplying the same research is byte-stable", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const options = { cwd: sample.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] };
  const first = await runNode([join(sample.root, "scripts", "apply-web-research.mjs")], options);
  assert.equal(first.code, 0, first.stderr);
  const before = await readFile(sample.snapshotPath, "utf8");
  const second = await runNode([join(sample.root, "scripts", "apply-web-research.mjs")], options);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /No-op/);
  assert.equal(await readFile(sample.snapshotPath, "utf8"), before);
});
