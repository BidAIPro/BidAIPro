import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PREFIX = "window.BIDAI_LIVE_SNAPSHOTS = ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "data", "live-snapshots.js");
const findingsPath = process.env.BIDAI_WEB_RESEARCH_FILE
  ? join(root, process.env.BIDAI_WEB_RESEARCH_FILE)
  : join(root, "data", "web-research-findings.json");

function text(value, fallback = "") {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || fallback;
}

function safeUrl(value) {
  try {
    const url = new URL(text(value));
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

function normalizeResult(entry) {
  const url = safeUrl(entry?.url || entry?.sourceUrl);
  const title = text(entry?.title);
  if (!url || !title) return null;
  return {
    title: title.slice(0, 500),
    url,
    source: text(entry?.source, new URL(url).hostname).slice(0, 120),
    price: money(entry?.price),
    listingState: text(entry?.listingState, "observed").toLowerCase().slice(0, 40),
    matchType: text(entry?.matchType, "lead").toLowerCase().slice(0, 80),
    dateLabel: text(entry?.dateLabel, "Date not exposed").slice(0, 120),
    note: text(entry?.note).slice(0, 500),
  };
}

function normalizeFinding(entry, generatedAt, method) {
  const sourceKey = text(entry?.sourceKey).toLowerCase();
  const externalId = text(entry?.externalId);
  const results = (Array.isArray(entry?.results) ? entry.results : []).map(normalizeResult).filter(Boolean).slice(0, 20);
  if (!sourceKey || !externalId || !results.length) return null;
  const summary = entry?.priceSummary && typeof entry.priceSummary === "object" ? entry.priceSummary : {};
  return {
    sourceKey,
    externalId,
    researchMarket: {
      status: "reference-only",
      method: text(entry?.method, method).slice(0, 160),
      researchedAt: generatedAt,
      query: text(entry?.query).slice(0, 500),
      summary: text(entry?.summary).slice(0, 1_000),
      limitation: text(entry?.limitation, "Reference-only research does not create a bid ceiling.").slice(0, 1_000),
      priceSummary: {
        currency: text(summary.currency, "USD").toUpperCase().slice(0, 8),
        sampleSize: Math.max(0, Math.round(Number(summary.sampleSize) || 0)),
        soldSampleSize: Math.max(0, Math.round(Number(summary.soldSampleSize) || 0)),
        askingSampleSize: Math.max(0, Math.round(Number(summary.askingSampleSize) || 0)),
        low: money(summary.low),
        median: money(summary.median),
        average: money(summary.average),
        high: money(summary.high),
        soldReference: money(summary.soldReference),
        askingLow: money(summary.askingLow),
        askingMedian: money(summary.askingMedian),
        askingHigh: money(summary.askingHigh),
        decisionEligible: false,
      },
      results,
    },
  };
}

async function readSnapshot() {
  const source = await readFile(snapshotPath, "utf8");
  if (!source.startsWith(OUTPUT_PREFIX)) throw new Error("Snapshot file has an unsupported format.");
  const envelope = JSON.parse(source.slice(OUTPUT_PREFIX.length).trim().replace(/;$/, ""));
  if (!envelope || !Array.isArray(envelope.items)) throw new Error("Snapshot file does not contain an item array.");
  return { source, envelope };
}

async function writeSnapshot(envelope) {
  await mkdir(dirname(snapshotPath), { recursive: true });
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`, "utf8");
    await rename(temporary, snapshotPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const findingsSource = JSON.parse(await readFile(findingsPath, "utf8"));
  const generatedAt = new Date(findingsSource?.generatedAt || "").toISOString();
  const method = text(findingsSource?.method, "Agent-assisted public web research");
  const findings = (Array.isArray(findingsSource?.findings) ? findingsSource.findings : [])
    .map((entry) => normalizeFinding(entry, generatedAt, method))
    .filter(Boolean);
  if (!findings.length) {
    console.log("No-op: no valid public web research findings were supplied.");
    return;
  }

  const { source, envelope } = await readSnapshot();
  const byKey = new Map(findings.map((entry) => [`${entry.sourceKey}|${entry.externalId}`, entry.researchMarket]));
  let matched = 0;
  envelope.items = envelope.items.map((item) => {
    const researchMarket = byKey.get(`${text(item?.sourceKey).toLowerCase()}|${text(item?.externalId)}`);
    if (!researchMarket) return item;
    matched += 1;
    return { ...item, researchMarket };
  });
  envelope.sourceNotes = [
    ...(Array.isArray(envelope.sourceNotes) ? envelope.sourceNotes : []),
    `Applied ${matched} agent-researched public-web finding${matched === 1 ? "" : "s"} from ${generatedAt}; reference-only evidence cannot create a bid ceiling.`,
  ].filter((value, index, values) => value && values.indexOf(value) === index).slice(-20);

  const nextSource = `${OUTPUT_PREFIX}${JSON.stringify(envelope, null, 2)};\n`;
  if (nextSource === source) {
    console.log("No-op: public web research is unchanged.");
    return;
  }
  await writeSnapshot(envelope);
  console.log(`Applied public web research to ${matched} of ${findings.length} requested listing${findings.length === 1 ? "" : "s"}.`);
}

await main();
