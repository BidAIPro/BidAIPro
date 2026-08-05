import {
  BadgeDollarSign,
  CalendarDays,
  Database,
  ExternalLink,
  Gauge,
  History,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { AuctionOpportunity, ValuationEvidence, ValuationReference } from "../../lib/auction-types";
import { freeMarketReferences } from "../../lib/market-references";

type MarketValueEvidenceProps = {
  auction: AuctionOpportunity;
  compact?: boolean;
  loading?: boolean;
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(cents: number | null | undefined) {
  return cents === null || cents === undefined ? "Unavailable" : money.format(cents / 100);
}

function shortDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function valuationEvidence(valuation: ValuationReference): ValuationEvidence | undefined {
  return valuation.evidence;
}

function rangeLabel(low: number | null, high: number | null) {
  if (low === null && high === null) return "Range unavailable";
  if (low === null) return `Up to ${dollars(high)}`;
  if (high === null) return `From ${dollars(low)}`;
  return `${dollars(low)}–${dollars(high)}`;
}

function observationLabel(sampleSize: number) {
  return `${integer.format(sampleSize)} ${sampleSize === 1 ? "observation" : "observations"}`;
}

function valuationTypeLabel(type: ValuationReference["valuationType"]) {
  if (type === "trade-in") return "Offer / trade-in reference";
  if (type === "private-party") return "Private-party reference";
  if (type === "retail") return "Retail market reference";
  if (type === "auction-comp") return "Auction comparable reference";
  return "Composite market reference";
}

/**
 * Presents the numeric value pulled for a vehicle first. Provider lookup links
 * remain available only as secondary verification evidence.
 */
export function MarketValueEvidence({
  auction,
  compact = false,
  loading = false,
}: MarketValueEvidenceProps) {
  const { valuation } = auction;
  const evidence = valuationEvidence(valuation);
  const references = freeMarketReferences(auction);
  const hasNumericValue =
    valuation.status !== "unavailable" && valuation.medianCents !== null;
  const inputMileage = evidence?.inputMileage ?? auction.vehicle.mileage ?? null;
  const rawLow = evidence?.rawLowCents ?? valuation.lowCents;
  const rawMedian = evidence?.rawMedianCents ?? valuation.medianCents;
  const rawHigh = evidence?.rawHighCents ?? valuation.highCents;
  const hasDistinctRawRange = Boolean(
    evidence &&
      (rawLow !== valuation.lowCents ||
        rawMedian !== valuation.medianCents ||
        rawHigh !== valuation.highCents),
  );

  if (compact) {
    return (
      <div
        className={`market-evidence-compact ${hasNumericValue ? "has-value" : "is-pending"}`}
        aria-label="Automatic numeric market evidence"
      >
        <div className="market-evidence-compact-copy">
          <span className="market-evidence-status-icon"><BadgeDollarSign size={15} /></span>
          <span>
            <strong>{hasNumericValue ? "Automatic market evidence" : loading ? "Pulling market value…" : "No automatic market match"}</strong>
            <small>
              {hasNumericValue
                ? `${valuation.provider} · ${observationLabel(valuation.sampleSize)}`
                : loading
                  ? "Matching year, make, model, and mileage"
                  : "This source has no usable numeric match yet"}
            </small>
          </span>
        </div>
        {hasNumericValue ? (
          <div className="market-evidence-compact-value">
            <span>{rangeLabel(valuation.lowCents, valuation.highCents)}</span>
            <strong>{dollars(valuation.medianCents)}</strong>
            <small>{inputMileage === null ? "Model-level estimate" : `Adjusted to ${integer.format(inputMileage)} mi`}</small>
          </div>
        ) : null}
        {hasNumericValue && valuation.sourceUrl ? (
          <a href={valuation.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open ${valuation.provider} source evidence`}>
            Source <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`market-evidence-panel ${hasNumericValue ? "has-value" : "is-pending"}`}>
      <div className="market-evidence-heading">
        <div>
          <span className="market-evidence-status-icon"><BadgeDollarSign size={19} /></span>
          <span>
            <strong>Automatic numeric market evidence</strong>
            <small>
              {hasNumericValue
                ? `${valuation.provider} · ${valuationTypeLabel(valuation.valuationType)}`
                : loading
                  ? "Pulling a matching market value now"
                  : "No usable numeric match returned for this vehicle"}
            </small>
          </span>
        </div>
        <em>{hasNumericValue ? `${Math.round(valuation.confidence * 100)}% confidence` : loading ? "In progress" : "Not priced"}</em>
      </div>

      {hasNumericValue ? (
        <>
          <div className="market-value-primary" aria-label="Mileage and condition adjusted market range">
            <div><span>Adjusted low</span><strong>{dollars(valuation.lowCents)}</strong></div>
            <div className="market-value-median"><span>Mileage + condition estimate</span><strong>{dollars(valuation.medianCents)}</strong></div>
            <div><span>Adjusted high</span><strong>{dollars(valuation.highCents)}</strong></div>
          </div>

          <div className="market-evidence-facts">
            <span><Database size={14} /><b>{observationLabel(valuation.sampleSize)}</b></span>
            <span><CalendarDays size={14} /><b>As of {shortDate(valuation.asOf)}</b></span>
            <span><Gauge size={14} /><b>{inputMileage === null ? "Mileage not captured" : `${integer.format(inputMileage)} mi input`}</b></span>
            <span><ShieldCheck size={14} /><b>{evidence?.matchBasis ?? "Year / make / model match"}</b></span>
          </div>

          {hasDistinctRawRange ? (
            <div className="market-source-range">
              <span>
                <strong>Provider source range</strong>
                <small>{rangeLabel(rawLow, rawHigh)} · midpoint {dollars(rawMedian)}</small>
              </span>
              <span>
                <strong>Mileage adjustment</strong>
                <small>
                  {evidence?.mileageAdjustmentCents === null || evidence?.mileageAdjustmentCents === undefined
                    ? "Applied within the displayed estimate"
                    : `${evidence.mileageAdjustmentCents >= 0 ? "+" : "−"}${dollars(Math.abs(evidence.mileageAdjustmentCents))}`}
                  {evidence?.comparableMedianMileage === null || evidence?.comparableMedianMileage === undefined
                    ? ""
                    : ` vs. ${integer.format(evidence.comparableMedianMileage)} mi source median`}
                </small>
              </span>
              {evidence?.conditionBasis ? (
                <span>
                  <strong>Condition / issue adjustment</strong>
                  <small>
                    {evidence.conditionAdjustmentCents === null || evidence.conditionAdjustmentCents === undefined
                      ? "Included in the adjusted range"
                      : `${evidence.conditionAdjustmentCents >= 0 ? "+" : "−"}${dollars(Math.abs(evidence.conditionAdjustmentCents))}`}
                    {evidence.conditionAdjustmentPct === null || evidence.conditionAdjustmentPct === undefined
                      ? ""
                      : ` (${Math.round(evidence.conditionAdjustmentPct * 100)}%)`}
                    {` · ${evidence.conditionBasis}`}
                  </small>
                </span>
              ) : null}
            </div>
          ) : (
            <p className="market-adjustment-note">
              <Gauge size={14} /> {inputMileage === null
                ? "The source did not receive a usable mileage input; treat this as a model-level range."
                : `The displayed estimate uses the captured ${integer.format(inputMileage)}-mile odometer reading.`}
            </p>
          )}

          <div className="market-provenance">
            <div><strong>{valuation.provider}</strong><span>{valuation.provenanceNote}</span></div>
            {valuation.sourceUrl ? <a href={valuation.sourceUrl} target="_blank" rel="noreferrer">Open source evidence <ExternalLink size={13} /></a> : null}
          </div>
        </>
      ) : (
        <div className="market-evidence-empty">
          <span className={loading ? "market-evidence-spinner" : ""}><Search size={19} /></span>
          <div>
            <strong>{loading ? "Automatic valuation in progress" : "Automatic value unavailable"}</strong>
            <p>{loading
              ? "BidAI Pro is matching this GSA vehicle and its mileage against the connected market source."
              : "No numeric reference passed the match checks. Bid and modeled all-in cost remain visible, but no market value is invented."}</p>
          </div>
        </div>
      )}

      <div className="secondary-market-references">
        <div><strong>Secondary verification links</strong><span>Open a provider if you want to cross-check the automatic number.</span></div>
        <div>
          {references.slice(0, 5).map((reference) => (
            <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" title={reference.description}>
              {reference.kind === "sold-listings" ? <History size={13} /> : reference.kind === "asking-comps" ? <Search size={13} /> : <BadgeDollarSign size={13} />}
              {reference.provider}<ExternalLink size={10} aria-hidden="true" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
