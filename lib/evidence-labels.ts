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
  forecast: Pick<ClosingForecast, "sampleSize">,
) {
  if (forecast.sampleSize === 0) return "Close forecast · no matched comps";
  return `Close forecast · ${integer.format(forecast.sampleSize)} matched ${forecast.sampleSize === 1 ? "comp" : "comps"}`;
}
