const ROAD_BODY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:sport\s+utility(?:\s+vehicle)?|suv)\b/i, "suv"],
  [/\b(?:pickup(?:\s+truck)?|pick-up(?:\s+truck)?)\b/i, "pickup"],
  [/\b(?:chassis\s+cab|cab(?:\s+and|\s*&)?\s+chassis)\b/i, "cab-chassis"],
  [/\b(?:mini\s*van|minivan)\b/i, "minivan"],
  [/\b(?:cargo|passenger|conversion)\s+van\b/i, "van"],
  [/\bambulance\b/i, "ambulance"],
  [/\b(?:transit|shuttle|school)\s+bus\b/i, "bus"],
  [/\b(?:station\s+wagon|wagon)\b/i, "wagon"],
  [/\bhatchback\b/i, "hatchback"],
  [/\bcrossover\b/i, "crossover"],
  [/\bconvertible\b/i, "convertible"],
  [/\bcoupe\b/i, "coupe"],
  [/\bsedan\b/i, "sedan"],
  [/\bvan\b/i, "van"],
  [/\bbus\b/i, "bus"],
  [/\btruck\b/i, "truck"],
];

const VEHICLE_TITLE_PATTERN =
  /\b(?:automobile|motor\s+vehicle|police\s+interceptor|patrol\s+vehicle)\b/i;

const NON_ROAD_TITLE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:utility|cargo|equipment|boat|travel|flatbed|dump|semi|tractor)\s+trailer\b|\btrailer\b/i,
    "trailer",
  ],
  [/\b(?:forklift|fork\s+lift|pallet\s+truck)\b/i, "material-handling-equipment"],
  [
    /\b(?:farm|agricultural|lawn|garden)\s+tractor\b|\btractor\b|\b(?:skid\s*steer|loader|excavator|bulldozer|backhoe|grader)\b/i,
    "heavy-equipment",
  ],
  [/\b(?:boat|vessel|watercraft|aircraft|airplane|helicopter)\b/i, "other-transport"],
  [/\b(?:motorcycle|motorbike|scooter|atv|utv|golf\s+cart)\b/i, "recreational-vehicle"],
  [
    /\b(?:vehicle|automotive|car|truck)\s+(?:parts?|accessor(?:y|ies)|tires?|wheels?|rims?|lift|hoist|rack|tool\s*box|bed\s+cap|camper\s+shell)\b|\b(?:parts?|accessor(?:y|ies)|tires?|wheels?|rims?)\s+(?:for|and)\s+(?:vehicle|automotive|car|truck)s?\b/i,
    "parts-or-accessories",
  ],
  [
    /\b(?:engine|transmission)(?:s)?(?:\s+(?:assembly|assemblies|only|parts?))?\s+(?:and|\/|&)\s+(?:engine|transmission)(?:s)?\b|\b(?:engine|transmission)\s+(?:assembly|only|parts?)\b/i,
    "parts-or-accessories",
  ],
  [
    /\b(?:replacement|remanufactured|rebuilt|spare)\s+(?:engine|transmission)\b|\b(?:engine|transmission)\s+(?:replacement|component|unit)\b/i,
    "parts-or-accessories",
  ],
  [/\b(?:for\s+parts\s+only|parts\s+only|scrap\s+metal)\b/i, "parts-or-scrap"],
];

const MAKE_NAMES = [
  "Alfa Romeo",
  "Aston Martin",
  "Audi",
  "BMW",
  "Buick",
  "Cadillac",
  "Chevrolet",
  "Chevy",
  "Chrysler",
  "Dodge",
  "Fiat",
  "Ford",
  "Freightliner",
  "Genesis",
  "GMC",
  "Honda",
  "Hummer",
  "Hyundai",
  "Infiniti",
  "International",
  "Isuzu",
  "Jaguar",
  "Jeep",
  "Kia",
  "Land Rover",
  "Lexus",
  "Lincoln",
  "Maserati",
  "Mazda",
  "Mercedes-Benz",
  "Mercedes",
  "Mercury",
  "Mini",
  "Mitsubishi",
  "Nissan",
  "Oldsmobile",
  "Peterbilt",
  "Plymouth",
  "Pontiac",
  "Porsche",
  "Ram",
  "Rivian",
  "Saab",
  "Saturn",
  "Scion",
  "Smart",
  "Subaru",
  "Suzuki",
  "Tesla",
  "Toyota",
  "Volkswagen",
  "Volvo",
] as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  quot: '"',
};

type JsonRecord = Record<string, unknown>;

export type GsaAuctionStatus = "active" | "preview" | "scheduled" | "unknown";

export type GsaVehicleCondition =
  | "new"
  | "usable"
  | "repairable"
  | "salvage"
  | "scrap"
  | "unknown";

export type GsaVehicleOperability =
  | "runs-and-drives"
  | "runs"
  | "non-operational"
  | "unknown";

export interface GsaVehicleEvidence {
  title: boolean;
  vin: boolean;
  mileage: boolean;
  bodyType: boolean;
  matched: string[];
}

export interface GsaLocation {
  addressLines: string[];
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface GsaVehicleAuction {
  id: string;
  source: "gsa-auctions";
  saleNumber: string | null;
  lotNumber: string | null;
  lotSequence: string | null;
  title: string;
  description: string;
  status: GsaAuctionStatus;
  startsAt: string | null;
  endsAt: string | null;
  currentBid: number | null;
  bidderCount: number | null;
  bidIncrement: number | null;
  reserve: number | null;
  inactivityMinutes: number | null;
  url: string;
  imageUrl: string | null;
  images: string[];
  vin: string | null;
  mileage: number | null;
  odometerStatus: "reported-not-verified" | "conflicting-readings" | "not-reported";
  bodyType: string | null;
  year: number | null;
  make: string | null;
  modelLabel: string | null;
  transmission: string | null;
  fuelType: string | null;
  cylinders: number | null;
  color: string | null;
  openRecall: boolean | null;
  conditionCode: string | null;
  condition: GsaVehicleCondition;
  operability: GsaVehicleOperability;
  damageFlags: string[];
  issueFlags: string[];
  conditionNotes: string[];
  /** False only when a PPMS catalog row could not be enriched from its lot detail. */
  detailEnriched?: boolean;
  location: GsaLocation;
  saleLocation: GsaLocation;
  agency: {
    code: string | null;
    name: string | null;
    bureauCode: string | null;
    bureauName: string | null;
  };
  evidence: GsaVehicleEvidence;
}

export interface GsaCoverage {
  totalLots: number;
  vehicleLots: number;
  excludedLots: number;
  withVin: number;
  withMileage: number;
  withBodyType: number;
  withImage: number;
  withCurrentBid: number;
  statusCounts: Record<GsaAuctionStatus, number>;
  exclusionCounts: Record<string, number>;
  detailEnrichment?: {
    requested: number;
    succeeded: number;
    failed: number;
    imagesDiscovered: number;
    imagesSigned: number;
  };
}

export interface NormalizedGsaPayload {
  auctions: GsaVehicleAuction[];
  coverage: GsaCoverage;
  observedAt: string;
}

interface Classification {
  isVehicle: boolean;
  exclusionReason: string | null;
  evidence: GsaVehicleEvidence;
  vin: string | null;
  mileage: number | null;
  bodyType: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getField(record: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return record[name];
    }
  }

  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(key.toLowerCase())) {
      return value;
    }
  }

  return undefined;
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z][\da-z]+));?/gi,
    (match, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
        if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return " ";
          }
        }
        return " ";
      }

      const decoded = named ? NAMED_ENTITIES[named.toLowerCase()] : undefined;
      return decoded ?? match;
    },
  );
}

export function sanitizeHtmlToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";

  let text = String(value).replace(/\0/g, " ");
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
    text = decodeEntities(text);
  }

  return text
    .replace(/<\s*br\s*\/?\s*>/gi, " ")
    .replace(/<\/?(?:address|article|aside|blockquote|div|dl|dt|dd|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function asCleanText(value: unknown): string | null {
  const text = sanitizeHtmlToText(value);
  return text.length > 0 ? text : null;
}

function extractLotDescriptions(rawLotInfo: unknown): string[] {
  const entries = Array.isArray(rawLotInfo) ? rawLotInfo : rawLotInfo ? [rawLotInfo] : [];
  const descriptions: string[] = [];

  for (const entry of entries) {
    const value = isRecord(entry)
      ? getField(entry, "LotDescript", "LotDescription", "Description")
      : entry;
    const text = asCleanText(value);
    if (text) descriptions.push(text);
  }

  return descriptions;
}

function uniqueTexts(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function extractVin(text: string): string | null {
  const labeled = text.match(/\bVIN\s*(?:NUMBER|NO\.?|#)?\s*[:=\-]?\s*([A-HJ-NPR-Z0-9]{17})\b/i);
  const candidate = labeled?.[1] ?? text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i)?.[0];
  if (!candidate || !/[A-Z]/i.test(candidate) || !/\d/.test(candidate)) return null;
  return candidate.toUpperCase();
}

function parseMileageCandidate(value: string | undefined): number | null {
  if (!value) return null;
  const mileage = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isSafeInteger(mileage) && mileage >= 0 && mileage <= 2_000_000 ? mileage : null;
}

export function extractMileage(text: string): number | null {
  const labeled = text.match(
    /\b(?:mileage|odometer|odo)(?:\s+reading)?\s*(?:is|:|=|-)??\s*([\d,]{1,12})(?:\.\d+)?\b/i,
  );
  const followedByMiles = text.match(/\b([\d,]{1,12})(?:\.\d+)?\s*(?:actual\s+)?miles?\b/i);
  return parseMileageCandidate(labeled?.[1]) ?? parseMileageCandidate(followedByMiles?.[1]);
}

export function extractBodyType(text: string): string | null {
  for (const [pattern, bodyType] of ROAD_BODY_PATTERNS) {
    if (pattern.test(text)) return bodyType;
  }
  return null;
}

export function extractYear(text: string, observedAt: Date): number | null {
  const maximumYear = observedAt.getUTCFullYear() + 2;
  for (const match of text.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    const year = Number.parseInt(match[1] ?? "", 10);
    if (year >= 1900 && year <= maximumYear) return year;
  }
  return null;
}

export function extractMake(text: string): string | null {
  for (const make of MAKE_NAMES) {
    const escaped = make.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) {
      if (make === "Chevy") return "Chevrolet";
      if (make === "Mercedes") return "Mercedes-Benz";
      return make;
    }
  }
  return null;
}

const DAMAGE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:dent(?:ed|s)?|body damage|collision|accident damage|hail damage)\b/i, "body-damage"],
  [/\b(?:rust(?:ed|ing)?|corrosion|corroded)\b/i, "rust-or-corrosion"],
  [/\b(?:cracked|broken|shattered)\s+(?:windshield|window|glass)\b|\bwindshield\s+(?:is\s+)?(?:cracked|broken)\b/i, "glass-damage"],
  [/\b(?:mold|mildew|moss|water intrusion|water damage|flood damage)\b/i, "water-or-organic-growth"],
  [/\b(?:missing parts?|parts? (?:is|are) missing|stripped)\b/i, "missing-parts"],
  [/\b(?:flat|damaged|worn|dry-rotted)\s+tires?\b|\btires?\s+(?:are\s+)?(?:flat|damaged|worn|dry-rotted)\b/i, "tire-damage"],
  [/\b(?:torn|ripped|damaged|stained)\s+(?:seat|seats|upholstery|interior)\b/i, "interior-damage"],
  [/\b(?:fire damage|burned|burnt)\b/i, "fire-damage"],
  [/\b(?:scratches|scratched|paint damage|peeling paint)\b/i, "paint-damage"],
];

const ISSUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:does not|doesn't|will not|won't|unable to)\s+(?:start|run|drive)\b|\b(?:non[- ]?running|inoperable|non[- ]?operational)\b/i, "non-operational"],
  [/\b(?:engine (?:issue|issues|problem|problems|damage)|check engine|engine knock|engine seized)\b/i, "engine-issue"],
  [/\b(?:transmission (?:issue|issues|problem|problems|damage)|transmission slips?)\b/i, "transmission-issue"],
  [/\b(?:dead battery|battery (?:is )?(?:dead|missing|weak|damaged))\b/i, "battery-issue"],
  [/\b(?:fluid|oil|coolant|fuel|transmission)\s+leaks?\b|\bleaks?\s+(?:fluid|oil|coolant|fuel)\b/i, "fluid-leak"],
  [/\bopen recall\s*:\s*yes\b|\bactive recall\b/i, "open-recall"],
  [/\b(?:unknown operating condition|operating condition (?:is )?unknown|running condition (?:is )?unknown)\b/i, "operability-unknown"],
];

function matchingFlags(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string[] {
  return patterns.filter(([pattern]) => pattern.test(text)).map(([, flag]) => flag);
}

export function extractDamageFlags(text: string): string[] {
  return matchingFlags(text, DAMAGE_PATTERNS);
}

export function extractIssueFlags(text: string): string[] {
  return matchingFlags(text, ISSUE_PATTERNS);
}

export function inferOperability(text: string): GsaVehicleOperability {
  if (ISSUE_PATTERNS[0]![0].test(text)) return "non-operational";
  if (/\b(?:runs? and drives?|starts? and drives?|operational and drivable)\b/i.test(text)) {
    return "runs-and-drives";
  }
  if (/\b(?:engine runs?|vehicle runs?|starts? successfully|operational)\b/i.test(text)) {
    return "runs";
  }
  return "unknown";
}

function classifyVehicle(title: string, descriptiveText: string, observedAt: Date): Classification {
  const combined = `${title} ${descriptiveText}`.trim();
  const vin = extractVin(combined);
  const mileage = extractMileage(combined);
  const bodyType = extractBodyType(combined);
  const titleBodyType = extractBodyType(title);
  const titleHasVehicleWord = VEHICLE_TITLE_PATTERN.test(title);
  const titleHasYearAndMake = extractYear(title, observedAt) !== null && extractMake(title) !== null;
  const titleSignal = titleBodyType !== null || titleHasVehicleWord || titleHasYearAndMake;

  for (const [pattern, reason] of NON_ROAD_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      return {
        isVehicle: false,
        exclusionReason: reason,
        evidence: {
          title: titleSignal,
          vin: vin !== null,
          mileage: mileage !== null,
          bodyType: bodyType !== null,
          matched: [],
        },
        vin,
        mileage,
        bodyType,
      };
    }
  }

  const hasSupportingEvidence = vin !== null || mileage !== null || bodyType !== null;
  const matched = [
    titleSignal ? "vehicle-title" : null,
    vin ? "vin" : null,
    mileage !== null ? "mileage" : null,
    bodyType ? `body:${bodyType}` : null,
  ].filter((value): value is string => value !== null);

  return {
    isVehicle: titleSignal && hasSupportingEvidence,
    exclusionReason: titleSignal ? "insufficient-vehicle-evidence" : "non-vehicle-title",
    evidence: {
      title: titleSignal,
      vin: vin !== null,
      mileage: mileage !== null,
      bodyType: bodyType !== null,
      matched,
    },
    vin,
    mileage,
    bodyType,
  };
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const text = asCleanText(value);
  if (!text) return null;
  const normalized = text.replace(/[$,\s]/g, "");
  if (!/^\+?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseInteger(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function parseDate(value: unknown): string | null {
  const text = asCleanText(value);
  if (!text) return null;

  const dotNet = text.match(/^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/);
  const utcText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? `${text}Z`
    : text;
  const timestamp = dotNet ? Number.parseInt(dotNet[1] ?? "", 10) : Date.parse(utcText);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStatus(value: unknown): GsaAuctionStatus {
  const status = (asCleanText(value) ?? "").toLowerCase();
  if (status === "a" || status === "active") return "active";
  if (status === "p" || status === "preview") return "preview";
  if (status === "" || status === "s" || status === "scheduled") return "scheduled";
  return "unknown";
}

function canonicalizeUrl(value: unknown): string | null {
  const text = asCleanText(value);
  if (!text) return null;

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function imageCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(imageCandidates);
  if (isRecord(value)) {
    return imageCandidates(getField(value, "url", "URL", "imageUrl", "ImageURL", "src"));
  }
  if (typeof value !== "string") return value === undefined || value === null ? [] : [value];

  const pieces = value.split(/[|;\r\n]+|,(?=\s*https?:\/\/)/i);
  const matches = pieces.flatMap(
    (piece) => piece.match(/https?:\/\/[^\s|;<>"']+/gi) ?? (piece.trim() ? [piece.trim()] : []),
  );
  return matches.map((match) => match.replace(/[),]+$/g, ""));
}

function normalizeImages(value: unknown): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  for (const candidate of imageCandidates(value)) {
    const url = canonicalizeUrl(candidate);
    if (url && !seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
  }
  return images;
}

function normalizeLocation(
  record: JsonRecord,
  fields: {
    address: string[];
    city: string[];
    state: string[];
    postalCode: string[];
  },
): GsaLocation {
  return {
    addressLines: uniqueTexts(fields.address.map((field) => asCleanText(getField(record, field)))),
    city: asCleanText(getField(record, ...fields.city)),
    state: asCleanText(getField(record, ...fields.state)),
    postalCode: asCleanText(getField(record, ...fields.postalCode)),
  };
}

function idPart(value: string | null): string | null {
  if (!value) return null;
  const part = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return part || null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function buildStableId(
  saleNumber: string | null,
  lotNumber: string | null,
  lotSequence: string | null,
  fallbackSeed: string,
): string {
  const sale = idPart(saleNumber) ?? "unknown-sale";
  const lot = idPart(lotNumber) ?? idPart(lotSequence) ?? `lot-${stableHash(fallbackSeed)}`;
  return `gsa:${sale}:${lot}`;
}

function deriveModelLabel(title: string, year: number | null, make: string | null): string | null {
  let label = title;
  if (year !== null) label = label.replace(new RegExp(`\\b${year}\\b`, "i"), " ");
  if (make) {
    const aliases = make === "Chevrolet" ? "(?:Chevrolet|Chevy)" : make === "Mercedes-Benz" ? "Mercedes(?:-Benz)?" : make.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    label = label.replace(new RegExp(`\\b${aliases}\\b`, "i"), " ");
  }
  label = label.replace(/\s+/g, " ").replace(/^[\s,:;\-]+|[\s,:;\-]+$/g, "").trim();
  return label || null;
}

function extractRecords(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) throw new TypeError("GSA payload is not an object or array.");

  for (const field of ["results", "auctions", "items", "data"]) {
    const candidate = getField(payload, field);
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) {
      const nested = getField(candidate, "results", "auctions", "items");
      if (Array.isArray(nested)) return nested.filter(isRecord);
    }
  }

  throw new TypeError("GSA payload does not contain a recognized auction collection.");
}

function normalizeAuction(
  record: JsonRecord,
  observedAt: Date,
): { auction: GsaVehicleAuction | null; exclusionReason: string | null } {
  const title = asCleanText(getField(record, "ItemName", "ItemTitle", "Title")) ?? "Untitled GSA lot";
  const lotInfo = getField(record, "LotInfo", "LotInformation");
  const descriptionParts = uniqueTexts([
    ...extractLotDescriptions(lotInfo),
    asCleanText(getField(record, "Instruction1")),
    asCleanText(getField(record, "Instruction2")),
    asCleanText(getField(record, "Instruction3")),
  ]);
  const description = descriptionParts.join(" ");
  const classification = classifyVehicle(title, description, observedAt);
  if (!classification.isVehicle) {
    return { auction: null, exclusionReason: classification.exclusionReason };
  }

  const saleNumber = asCleanText(getField(record, "SaleNo", "SaleNumber"));
  const lotNumber = asCleanText(getField(record, "LotNo", "LotNumber"));
  const lotEntries = Array.isArray(lotInfo) ? lotInfo : lotInfo ? [lotInfo] : [];
  const lotSequence =
    lotEntries.map((entry) => (isRecord(entry) ? asCleanText(getField(entry, "LotSequence")) : null)).find(Boolean) ??
    asCleanText(getField(record, "LotSequence"));
  const startsAt = parseDate(getField(record, "AucStartDt", "AuctionStartDate"));
  const endsAt = parseDate(getField(record, "AucEndDt", "AuctionEndDate"));
  const images = normalizeImages(getField(record, "ImageURL", "ImageUrl", "Images"));
  const year = extractYear(`${title} ${description}`, observedAt);
  const make = extractMake(`${title} ${description}`);
  const damageFlags = extractDamageFlags(description);
  const issueFlags = extractIssueFlags(description);
  const fallbackSeed = [saleNumber, lotNumber, lotSequence, title, endsAt].filter(Boolean).join("|");

  const auction: GsaVehicleAuction = {
    id: buildStableId(saleNumber, lotNumber, lotSequence, fallbackSeed),
    source: "gsa-auctions",
    saleNumber,
    lotNumber,
    lotSequence,
    title,
    description,
    status: normalizeStatus(getField(record, "AuctionStatus")),
    startsAt,
    endsAt,
    currentBid: parseNumber(getField(record, "HighBidAmount", "CurrentBid")),
    bidderCount: parseInteger(getField(record, "BiddersCount", "BidderCount")),
    bidIncrement: parseNumber(getField(record, "AucIncrement", "AuctionIncrement")),
    reserve: parseNumber(getField(record, "Reserve")),
    inactivityMinutes: parseInteger(getField(record, "InactivityTime")),
    url:
      canonicalizeUrl(getField(record, "ItemDescURL", "ItemDescriptionURL", "URL")) ??
      "https://gsaauctions.gov/auctions/home",
    imageUrl: images[0] ?? null,
    images,
    vin: classification.vin,
    mileage: classification.mileage,
    odometerStatus: classification.mileage === null ? "not-reported" : "reported-not-verified",
    bodyType: classification.bodyType,
    year,
    make,
    modelLabel: deriveModelLabel(title, year, make),
    transmission: null,
    fuelType: null,
    cylinders: null,
    color: null,
    openRecall: issueFlags.includes("open-recall") ? true : null,
    conditionCode: null,
    condition: "unknown",
    operability: inferOperability(description),
    damageFlags,
    issueFlags,
    conditionNotes: [],
    location: normalizeLocation(record, {
      address: ["PropertyAddr1", "PropertyAddr2", "PropertyAddr3"],
      city: ["PropertyCity"],
      state: ["PropertyState", "PropertyST"],
      postalCode: ["PropertyZip", "PropertyPostalCode"],
    }),
    saleLocation: normalizeLocation(record, {
      address: ["LocationStAddr", "LocationAddress"],
      city: ["LocationCity"],
      state: ["LocationST", "LocationState"],
      postalCode: ["LocationZip", "LocationPostalCode"],
    }),
    agency: {
      code: asCleanText(getField(record, "AgencyCode")),
      name: asCleanText(getField(record, "AgencyName")),
      bureauCode: asCleanText(getField(record, "BureauCode")),
      bureauName: asCleanText(getField(record, "BureauName")),
    },
    evidence: classification.evidence,
  };

  return { auction, exclusionReason: null };
}

export function normalizeGsaPayload(payload: unknown, observedAt: Date = new Date()): NormalizedGsaPayload {
  if (Number.isNaN(observedAt.getTime())) throw new TypeError("observedAt must be a valid date.");

  const records = extractRecords(payload);
  const auctions: GsaVehicleAuction[] = [];
  const exclusionCounts: Record<string, number> = {};

  for (const record of records) {
    const result = normalizeAuction(record, observedAt);
    if (result.auction) {
      auctions.push(result.auction);
    } else {
      const reason = result.exclusionReason ?? "unknown";
      exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
    }
  }

  const statusCounts: Record<GsaAuctionStatus, number> = {
    active: 0,
    preview: 0,
    scheduled: 0,
    unknown: 0,
  };
  for (const auction of auctions) statusCounts[auction.status] += 1;

  return {
    auctions,
    coverage: {
      totalLots: records.length,
      vehicleLots: auctions.length,
      excludedLots: records.length - auctions.length,
      withVin: auctions.filter((auction) => auction.vin !== null).length,
      withMileage: auctions.filter((auction) => auction.mileage !== null).length,
      withBodyType: auctions.filter((auction) => auction.bodyType !== null).length,
      withImage: auctions.filter((auction) => auction.imageUrl !== null).length,
      withCurrentBid: auctions.filter((auction) => auction.currentBid !== null).length,
      statusCounts,
      exclusionCounts,
    },
    observedAt: observedAt.toISOString(),
  };
}
