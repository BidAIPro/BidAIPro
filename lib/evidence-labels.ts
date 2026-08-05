import type { ClosingForecast, ValuationReference } from "./auction-types";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function valuationEvidenceCountLabel(
  valuation: Pick<ValuationReference, "sampleSize" | "valuationType">,
) {
  const count = integer.format(valuation.sampleSize);
  if (valuation.valuationType === "auction-comp") {
    return `${count} valuation ${valuation.sampleSize === 1 ? "comp" : "comps"} used`;
  }
  return `${count} market ${valuation.sampleSize === 1 ? "observation" : "observations"}`;
}

export function closeForecastEvidenceLabel(
  forecast: Pick<ClosingForecast, "sampleSize" | "status" | "provenance">,
) {
  if (forecast.status === "insufficient") return "Projected close · insufficient evidence";
  if (
    forecast.sampleSize === 0 &&
    forecast.provenance === "market-reference-heuristic"
  ) {
    return "Projected close · market-value anchor";
  }
  return `Projected close · ${integer.format(forecast.sampleSize)} similar closed ${forecast.sampleSize === 1 ? "outcome" : "outcomes"}`;
}
