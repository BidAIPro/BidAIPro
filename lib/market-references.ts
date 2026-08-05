import type { AuctionOpportunity } from "./auction-types";

export type MarketReferenceKind =
  | "valuation"
  | "asking-comps"
  | "sold-listings";

export interface FreeMarketReference {
  id: "carfax" | "kbb" | "edmunds" | "jd-power" | "cars" | "ebay-sold";
  provider: string;
  label: string;
  description: string;
  url: string;
  kind: MarketReferenceKind;
  coverageNote: string;
}

function slug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function searchPhrase(auction: AuctionOpportunity) {
  return [
    auction.vehicle.year || null,
    auction.vehicle.make,
    auction.vehicle.model,
    auction.vehicle.trim,
  ].filter(Boolean).join(" ");
}

function isUsefulSegment(value: string) {
  const normalized = slug(value);
  return normalized.length > 0 && ![
    "unknown",
    "pending",
    "not-available",
    "not-reported",
    "not-stated",
    "make-pending",
    "model-pending",
    "vehicle",
  ].includes(normalized);
}

/**
 * Free, user-opened research references. We intentionally link to provider
 * pages instead of scraping or republishing proprietary valuation data.
 */
export function freeMarketReferences(
  auction: AuctionOpportunity,
): readonly FreeMarketReference[] {
  const currentYear = new Date().getUTCFullYear();
  const year = Number.isInteger(auction.vehicle.year)
    && auction.vehicle.year >= 1886
    && auction.vehicle.year <= currentYear + 2
    ? auction.vehicle.year
    : null;
  const make = slug(auction.vehicle.make);
  const model = slug(auction.vehicle.model);
  const hasMake = isUsefulSegment(auction.vehicle.make);
  const hasModel = isUsefulSegment(auction.vehicle.model);
  const hasVehicleIdentity = year !== null && hasMake && hasModel;
  const phrase = hasVehicleIdentity ? searchPhrase(auction) : "";
  const zip = auction.location.postalCode?.trim() || null;

  const cars = new URL(hasVehicleIdentity
    ? "https://www.cars.com/shopping/results/"
    : "https://www.cars.com/shopping/");
  if (hasVehicleIdentity) {
    cars.searchParams.set("stock_type", "used");
    cars.searchParams.set("makes[]", make);
    cars.searchParams.set("models[]", `${make}-${model}`);
    cars.searchParams.set("year_min", String(year));
    cars.searchParams.set("year_max", String(year));
    cars.searchParams.set("maximum_distance", "all");
    if (zip) cars.searchParams.set("zip", zip);
    cars.searchParams.set("sort", "best_match_desc");
  }

  const ebay = new URL(phrase
    ? "https://www.ebay.com/sch/i.html"
    : "https://www.ebay.com/b/Cars-Trucks/6001/bn_1865117");
  if (phrase) {
    ebay.searchParams.set("_nkw", phrase);
    ebay.searchParams.set("_sacat", "6001");
    ebay.searchParams.set("LH_Complete", "1");
    ebay.searchParams.set("LH_Sold", "1");
  }

  const references: FreeMarketReference[] = [];
  if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(auction.vehicle.vin ?? "")) {
    references.push({
      id: "carfax",
      provider: "CARFAX",
      label: "Free VIN-specific value",
      description: `Enter the captured VIN${zip ? " and ZIP" : ""} for a free history-based vehicle value.`,
      url: "https://www.carfax.com/value/",
      kind: "valuation",
      coverageNote: `VIN ${auction.vehicle.vin} · ${zip ? `ZIP ${zip}` : "ZIP not captured; enter your market area"}`,
    });
  }

  references.push(
    {
      id: "kbb",
      provider: "Kelley Blue Book",
      label: "KBB value lookup",
      description: "Free consumer value workflow using VIN or year, make, and model.",
      url: "https://www.kbb.com/car-values/",
      kind: "valuation",
      coverageNote: "Opens KBB directly; values are not copied into BidAI Pro",
    },
    {
      id: "edmunds",
      provider: "Edmunds",
      label: "Edmunds appraisal range",
      description: "Free condition, trim, and mileage-sensitive appraisal workflow.",
      url: "https://www.edmunds.com/appraisal/",
      kind: "valuation",
      coverageNote: "Use the displayed VIN or select the vehicle manually",
    },
    {
      id: "jd-power",
      provider: "J.D. Power",
      label: "J.D. Power values",
      description: "Prices paid, trim-level pricing, and estimated trade-in references.",
      url: year !== null && hasMake
        ? `https://www.jdpower.com/cars/${year}/${make}`
        : "https://www.jdpower.com/cars",
      kind: "valuation",
      coverageNote: hasModel
        ? `Select ${auction.vehicle.model} when the provider offers it`
        : "Select the vehicle manually; model was not captured",
    },
    {
      id: "cars",
      provider: "Cars.com",
      label: "Active asking comps",
      description: hasVehicleIdentity
        ? "Nationwide used listings filtered to the same year, make, and model."
        : "Open the used-vehicle marketplace and select the closest comparable manually.",
      url: cars.toString(),
      kind: "asking-comps",
      coverageNote: hasVehicleIdentity
        ? `${zip ? `ZIP ${zip} supplied; ` : "ZIP not captured; "}asking prices are not sale prices`
        : "Vehicle identity is incomplete; no filters were invented",
    },
    {
      id: "ebay-sold",
      provider: "eBay Motors",
      label: "Sold-listing search",
      description: phrase
        ? "Completed and sold listing search, useful for uncommon fleet vehicles."
        : "Open eBay Motors and search sold listings for the closest comparable manually.",
      url: ebay.toString(),
      kind: "sold-listings",
      coverageNote: "Displayed prices may not be the accepted or settled transaction amount",
    },
  );
  return references;
}
