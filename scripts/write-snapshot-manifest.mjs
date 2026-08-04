import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSnapshotPath = join(root, "data", "live-snapshots.js");
const defaultManifestPath = join(root, "data", "snapshot-manifest.json");

function snapshotEnvelope(source) {
  const assignmentIndex = source.indexOf(OUTPUT_PREFIX);
  if (assignmentIndex < 0) throw new Error("Snapshot file has an unsupported format.");
  const json = source.slice(assignmentIndex + OUTPUT_PREFIX.length).trim().replace(/;$/, "");
  const envelope = JSON.parse(json);
  if (!envelope || !Array.isArray(envelope.items)) throw new Error("Snapshot file does not contain an item array.");
  return envelope;
}

async function writeAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeSnapshotManifest({
  snapshotPath = defaultSnapshotPath,
  manifestPath = defaultManifestPath,
} = {}) {
  const source = await readFile(snapshotPath, "utf8");
  const envelope = snapshotEnvelope(source);
  const revision = createHash("sha256").update(source).digest("hex");
  const activeItemCount = envelope.items.filter((item) => item?.status === "active").length;
  const manifest = {
    schemaVersion: 1,
    revision,
    observedAt: envelope.observedAt || null,
    lastCheckedAt: envelope.lastCheckedAt || envelope.observedAt || null,
    itemCount: envelope.items.length,
    activeItemCount,
  };
  await writeAtomically(manifestPath, manifest);
  console.log(`[snapshot-manifest] ${revision.slice(0, 12)} · ${activeItemCount.toLocaleString("en-US")} active / ${envelope.items.length.toLocaleString("en-US")} retained.`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await writeSnapshotManifest();
}
