import {
  extractBodyType,
  extractDamageFlags,
  extractIssueFlags,
  extractMake,
  extractMileage,
  extractVin,
  extractYear,
  inferOperability,
  sanitizeHtmlToText,
  type GsaAuctionStatus,
  type GsaLocation,
  type GsaVehicleAuction,
  type GsaVehicleCondition,
} from "./gsa-normalizer.ts";

type JsonRecord = Record<string, unknown>;

export interface PpmsImageAttachment {
  id: string;
  uri: string;
  fileName: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(record: JsonRecord | null, ...names: string[]): unknown {
  if (!record) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(record).find(([name]) => wanted.has(name.toLowerCase()))?.[1];
}

function recordField(record: JsonRecord | null, ...names: string[]): JsonRecord | null {
  const value = field(record, ...names);
  return isRecord(value) ? value : null;
}

function text(value: unknown): string | null {
  const clean = sanitizeHtmlToText(value);
  return clean ? clean : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const clean = text(value)?.replace(/[$,\s]/g, "");
  if (!clean || !/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function sourceLines(sourceHtml: string): string[] {
  const blocks = [...sourceHtml.matchAll(/<(?:li|p)\b[^>]*>([\s\S]*?)<\/(?:li|p)\s*>/gi)]
    .map((match) => sanitizeHtmlToText(match[1]))
    .filter(Boolean);
  if (blocks.length > 0) return blocks;
  const clean = sanitizeHtmlToText(sourceHtml);
  return clean ? clean.split(/(?<=[.!?])\s+/) : [];
}

function structuredSpecs(sourceHtml: string): Map<string, string> {
  const specs = new Map<string, string>();
  for (const line of sourceLines(sourceHtml)) {
    const match = line.match(/^([^:]{2,45}):\s*(.+)$/);
    if (!match) continue;
    specs.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
  }
  return specs;
}

function spec(specs: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = specs.get(name.toLowerCase());
    if (value) return value;
  }
  return null;
}

function conditionFromCode(value: string | null): GsaVehicleCondition {
  switch (value?.trim().toUpperCase()) {
    case "N":
    case "1":
      return "new";
    case "U":
    case "4":
      return "usable";
    case "R":
    case "7":
      return "repairable";
    case "X":
      return "salvage";
    case "S":
      return "scrap";
    default:
      return "unknown";
  }
}

function normalizeStatus(value: unknown): GsaAuctionStatus {
  const clean = (text(value) ?? "").toLowerCase();
  if (clean === "active" || clean === "a") return "active";
  if (clean === "preview" || clean === "p") return "preview";
  if (clean === "scheduled" || clean === "s" || clean === "") return "scheduled";
  return "unknown";
}

const CENTRAL_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallClockParts(date: Date): number[] {
  const values = new Map(
    CENTRAL_PARTS.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return (["year", "month", "day", "hour", "minute", "second"] as const).map((part) =>
    Number.parseInt(values.get(part) ?? "", 10),
  );
}

/** PPMS emits offset-less auction timestamps in the GSA site server's CST/CDT clock. */
export function parsePpmsCentralDate(value: unknown): string | null {
  const clean = text(value);
  if (!clean) return null;

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(clean)) {
    const timestamp = Date.parse(clean);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  const match = clean.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/,
  );
  if (!match) return null;
  const expected = match.slice(1).map((part, index) =>
    index === 5 && part === undefined ? 0 : Number.parseInt(part ?? "", 10),
  );
  if (expected.some((part) => !Number.isFinite(part))) return null;

  const [year, month, day, hour, minute, second] = expected;
  const wallClockUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  // Chicago is UTC-5 during daylight time and UTC-6 during standard time.
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(wallClockUtc + offsetHours * 60 * 60 * 1000);
    if (wallClockParts(candidate).every((part, index) => part === expected[index])) {
      return candidate.toISOString();
    }
  }
  return null;
}

function normalizeLocation(value: unknown): GsaLocation {
  const location = isRecord(value) ? value : null;
  return {
    addressLines: [
      text(field(location, "addressLine1", "line1")),
      text(field(location, "addressLine2", "line2")),
      text(field(location, "addressLine3", "line3")),
    ].filter((line): line is string => line !== null),
    city: text(field(location, "city")),
    state: text(field(location, "state", "stateCode")),
    postalCode: text(field(location, "zipCode", "zip")),
  };
}

function conditionSectionLines(sourceHtml: string): string[] {
  const section = sourceHtml.match(
    /<h[1-6]\b[^>]*>\s*Condition(?:\s*&amp;\s*Markings)?\s*<\/h[1-6]\s*>([\s\S]*?)(?=<h[1-6]\b|$)/i,
  )?.[1];
  const candidates = sourceLines(section ?? sourceHtml);
  const flags = (line: string) =>
    extractDamageFlags(line).length > 0 ||
    extractIssueFlags(line).length > 0 ||
    /\b(?:condition|repair|missing|damage|defect|wear|as[- ]is)\b/i.test(line);
  const seen = new Set<string>();
  return candidates.filter(flags).filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function booleanSpec(value: string | null): boolean | null {
  if (!value) return null;
  if (/^(?:yes|y|true)$/i.test(value.trim())) return true;
  if (/^(?:no|n|false)$/i.test(value.trim())) return false;
  return null;
}

function titleModel(title: string, year: number | null, make: string | null): string | null {
  let value = title;
  if (year !== null) value = value.replace(new RegExp(`\\b${year}\\b`), " ");
  if (make) value = value.replace(new RegExp(`\\b${make.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), " ");
  value = value.replace(/\s+/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "").trim();
  return value || null;
}

function auctionDescription(detail: JsonRecord | null): JsonRecord | null {
  return recordField(detail, "auctionDescriptionDTO", "auctionDescription");
}

export function ppmsImageAttachments(detailValue: unknown): PpmsImageAttachment[] {
  const detail = isRecord(detailValue) ? detailValue : null;
  const imagesAndDocs = recordField(detail, "imagesAndDocs");
  const rawImages = field(imagesAndDocs, "image", "images");
  if (!Array.isArray(rawImages)) return [];

  const attachments: PpmsImageAttachment[] = [];
  const seen = new Set<string>();
  for (const rawImage of rawImages) {
    if (!isRecord(rawImage)) continue;
    if (
      field(rawImage, "valid") === false ||
      text(field(rawImage, "virusScanStatus"))?.toUpperCase() === "INFECTED"
    ) {
      continue;
    }
    const id = text(field(rawImage, "id"));
    const uri = text(field(rawImage, "uri"));
    const fileName = text(field(rawImage, "name", "fileName"));
    if (!id || !uri || !fileName || seen.has(`${id}|${uri}`)) continue;
    seen.add(`${id}|${uri}`);
    attachments.push({ id, uri, fileName });
  }
  return attachments.sort((left, right) => {
    const leftRaw = rawImages.find((image) => isRecord(image) && text(field(image, "id")) === left.id);
    const rightRaw = rawImages.find((image) => isRecord(image) && text(field(image, "id")) === right.id);
    return (isRecord(leftRaw) ? integerValue(field(leftRaw, "attachmentOrder")) ?? 9999 : 9999) -
      (isRecord(rightRaw) ? integerValue(field(rightRaw, "attachmentOrder")) ?? 9999 : 9999);
  });
}

export function normalizePpmsVehicleAuction(
  catalogValue: unknown,
  detailValue: unknown,
  signedImages: readonly string[],
  observedAt: Date,
): GsaVehicleAuction {
  if (!isRecord(catalogValue)) throw new TypeError("PPMS catalog row is not an object.");
  const catalog = catalogValue;
  const detail = isRecord(detailValue) ? detailValue : null;
  const descriptionRecord = auctionDescription(detail);
  const sourceHtml = String(field(descriptionRecord, "itemDescription") ?? "");
  const description = sanitizeHtmlToText(sourceHtml);
  const specs = structuredSpecs(sourceHtml);
  const title = text(field(catalog, "lotName")) ?? text(field(detail, "salesDescription")) ?? "Untitled GSA vehicle";
  const factText = `${title} ${description}`;
  const year = extractYear(`${title} ${spec(specs, "model year") ?? ""}`, observedAt);
  const make = extractMake(title) ?? text(field(descriptionRecord, "make")) ?? spec(specs, "make");
  const model = text(field(descriptionRecord, "model")) ?? spec(specs, "model") ?? titleModel(title, year, make);
  const structuredMileage = integerValue(field(descriptionRecord, "odometer"));
  const descriptionMileage =
    integerValue(spec(specs, "mileage", "odometer")) ?? extractMileage(description);
  // The structured field is the canonical PPMS input. Preserve conflicts from
  // the prose rather than silently choosing whichever value is larger/newer.
  const mileage = structuredMileage ?? descriptionMileage ?? extractMileage(factText);
  const mileageConflict =
    structuredMileage !== null &&
    descriptionMileage !== null &&
    structuredMileage !== descriptionMileage;
  const vin = extractVin(`${spec(specs, "vin") ?? ""} ${factText}`);
  const bodyLabel = spec(specs, "body style", "body type");
  const bodyType = extractBodyType(`${bodyLabel ?? ""} ${title} ${description}`) ?? text(field(descriptionRecord, "bodyType"));
  const conditionCode = text(field(descriptionRecord, "conditionCode"));
  const damageFlags = extractDamageFlags(description);
  const issueFlags = [
    ...extractIssueFlags(description),
    ...(mileageConflict ? ["odometer-conflict"] : []),
  ];
  const images = signedImages.filter((value) => /^https:\/\//i.test(value));
  const location = normalizeLocation(field(detail, "propertyLocation"));
  const catalogLocation = normalizeLocation(field(catalog, "location"));
  const auctionId = text(field(catalog, "auctionId"));
  const lotId = text(field(catalog, "lotId"));
  if (!auctionId || !lotId) throw new TypeError("PPMS catalog row is missing its auction or lot id.");
  const biddingDetails = recordField(detail, "biddingDetailsDTO");
  const templateCodes = recordField(biddingDetails, "templateCodes");

  return {
    id: `gsa:ppms:${auctionId}`,
    source: "gsa-auctions",
    saleNumber: text(field(catalog, "salesNumber")),
    lotNumber: text(field(catalog, "lotNumber")),
    lotSequence: text(field(catalog, "lotNumber")),
    title,
    description,
    status: normalizeStatus(field(catalog, "status")),
    startsAt: parsePpmsCentralDate(field(catalog, "startDate")),
    endsAt: parsePpmsCentralDate(field(catalog, "endDate")),
    currentBid: numberValue(field(catalog, "currentBid")),
    bidderCount: integerValue(field(catalog, "numberOfBidders")),
    bidIncrement:
      numberValue(field(catalog, "bidIncrement")) ?? numberValue(field(templateCodes, "bidIncrement")),
    reserve: numberValue(field(catalog, "reserveAmount")),
    inactivityMinutes:
      integerValue(field(catalog, "inactivityPeriod")) ?? integerValue(field(templateCodes, "inactiveTime")),
    url: `https://gsaauctions.gov/auctions/preview/${auctionId}`,
    imageUrl: images[0] ?? null,
    images,
    vin,
    mileage,
    odometerStatus:
      mileage === null
        ? "not-reported"
        : mileageConflict
          ? "conflicting-readings"
          : "reported-not-verified",
    bodyType,
    year,
    make,
    modelLabel: model,
    transmission: spec(specs, "transmission type", "transmission"),
    fuelType: spec(specs, "fuel type"),
    cylinders: integerValue(spec(specs, "no of cylinders", "number of cylinders", "cylinders")),
    color: spec(specs, "color", "exterior color"),
    openRecall: booleanSpec(spec(specs, "open recall", "recall")),
    conditionCode,
    condition: conditionFromCode(conditionCode),
    operability: inferOperability(description),
    damageFlags,
    issueFlags,
    conditionNotes: [
      ...(mileageConflict
        ? [
            `GSA mileage conflict: structured odometer ${structuredMileage!.toLocaleString("en-US")} miles; listing description ${descriptionMileage!.toLocaleString("en-US")} miles. Verify before valuation.`,
          ]
        : []),
      ...conditionSectionLines(sourceHtml),
    ].slice(0, 12),
    detailEnriched: detail !== null,
    location: location.city || location.state ? location : catalogLocation,
    saleLocation: catalogLocation,
    agency: {
      code: null,
      name: text(field(detail, "sellingAgency")) ?? text(field(catalog, "sellingAgency")),
      bureauCode: text(field(detail, "lotAgencyBureau")),
      bureauName: null,
    },
    evidence: {
      title: true,
      vin: vin !== null,
      mileage: mileage !== null,
      bodyType: bodyType !== null,
      matched: [
        "official-category:300",
        vin ? "vin" : null,
        mileage !== null ? "mileage" : null,
        bodyType ? `body:${bodyType}` : null,
      ].filter((value): value is string => value !== null),
    },
  };
}
