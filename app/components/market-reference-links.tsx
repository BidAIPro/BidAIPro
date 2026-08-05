import { BadgeDollarSign, ExternalLink, History, Search } from "lucide-react";
import type { AuctionOpportunity } from "../../lib/auction-types";
import { freeMarketReferences } from "../../lib/market-references";

type MarketReferenceLinksProps = {
  auction: AuctionOpportunity;
  compact?: boolean;
};

export function MarketReferenceLinks({
  auction,
  compact = false,
}: MarketReferenceLinksProps) {
  const references = freeMarketReferences(auction);
  const hasVinSpecificReference = references.some((reference) => reference.id === "carfax");

  if (compact) {
    const soldListings = references.find((reference) => reference.kind === "sold-listings");
    return (
      <div className="market-reference-compact" aria-label="Free independent market references">
        <span><BadgeDollarSign size={14} /> Free market checks</span>
        <div>
          {references.slice(0, 3).map((reference) => (
            <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" title={reference.description}>
              {reference.provider}<ExternalLink size={11} aria-hidden="true" />
            </a>
          ))}
          {soldListings ? <a href={soldListings.url} target="_blank" rel="noreferrer" title={soldListings.description}>Sold listings<ExternalLink size={11} aria-hidden="true" /></a> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="market-reference-panel">
      <div className="market-reference-heading">
        <div><BadgeDollarSign size={19} /><span><strong>Free independent market references</strong><small>{hasVinSpecificReference ? "VIN-specific lookup plus model-level values and comparables" : "Model-level values and comparables · VIN not captured"}</small></span></div>
        <em>No copied or invented values</em>
      </div>
      <div className="market-reference-grid">
        {references.map((reference) => (
          <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer" className={`market-reference-link ${reference.kind}`}>
            <span className="market-reference-icon">{reference.kind === "sold-listings" ? <History size={17} /> : reference.kind === "asking-comps" ? <Search size={17} /> : <BadgeDollarSign size={17} />}</span>
            <span><strong>{reference.label}</strong><small>{reference.description}</small><em>{reference.coverageNote}</em></span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ))}
      </div>
      <p className="market-reference-note">Use the captured mileage, trim, ZIP, condition, and damage disclosures when refining each source. Active asking prices are not sale prices; sold-listing prices may not be accepted or settled transaction amounts; and broad model values may overstate repairable or non-operational vehicles.</p>
    </div>
  );
}
