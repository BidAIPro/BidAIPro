import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeSnapshotManifest } from "./write-snapshot-manifest.mjs";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";

test("writes a deterministic lightweight manifest for the published snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bidai-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "live-snapshots.js");
  const manifestPath = join(directory, "snapshot-manifest.json");
  const envelope = {
    observedAt: "2026-08-03T10:00:00.000Z",
    lastCheckedAt: "2026-08-03T10:05:00.000Z",
    items: [
      { id: "active", status: "active" },
      { id: "ended", status: "ended" },
    ],
  };
  await writeFile(snapshotPath, `${OUTPUT_PREFIX}${JSON.stringify(envelope)};\n`, "utf8");

  const first = await writeSnapshotManifest({ snapshotPath, manifestPath });
  const firstSource = await readFile(manifestPath, "utf8");
  const second = await writeSnapshotManifest({ snapshotPath, manifestPath });

  assert.equal(first.revision.length, 64);
  assert.equal(first.lastCheckedAt, envelope.lastCheckedAt);
  assert.equal(first.itemCount, 2);
  assert.equal(first.activeItemCount, 1);
  assert.deepEqual(second, first);
  assert.equal(await readFile(manifestPath, "utf8"), firstSource);
});

test("rejects a file that is not a BidAI Pro snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bidai-manifest-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "live-snapshots.js");
  await writeFile(snapshotPath, "window.UNRELATED = {};\n", "utf8");
  await assert.rejects(
    writeSnapshotManifest({ snapshotPath, manifestPath: join(directory, "manifest.json") }),
    /unsupported format/,
  );
});
