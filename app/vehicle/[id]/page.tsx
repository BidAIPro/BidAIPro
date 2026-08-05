import type { Metadata } from "next";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CarFront,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  Fuel,
  Gauge,
  MapPin,
  Scale,
  ShieldCheck,
  TrendingUp,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketValueEvidence } from "../../components/market-reference-links";
import { VehicleGallery } from "../../components/vehicle-gallery";
import type { AuctionOpportunity } from "../../../lib/auction-types";
import { SEED_AUCTIONS } from "../../../lib/seed-auctions";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(cents: number | null | undefined) {
  return cents === null || cents === undefined ? "Unavailable" : money.format(cents / 100);
}

function asPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function odometerStatusLabel(status: AuctionOpportunity["vehicle"]["odometerStatus"]) {
  if (status === "conflicting-readings") return "Conflicting GSA readings";
  if (status === "not-reported") return "Not reported";
  return "GSA reported · verify";
}

export function generateStaticParams() {
  return SEED_AUCTIONS.map((auction) => ({ id: auction.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const auction = SEED_AUCTIONS.find((item) => item.id === id);
  if (!auction) return { title: "Vehicle not found" };
  return {
    title: auction.title,
    description: `${auction.title}: current bid ${dollars(auction.currentBidCents)}, projected close ${dollars(auction.forecast.expectedCents)}, and complete risk-adjusted analysis.`,
  };
}

export default async function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = SEED_AUCTIONS.find((item) => item.id === id);
  if (!auction) notFound();

  const { costs } = auction.assessment;
  const valueLow = auction.valuation.lowCents ?? 0;
  const valueMedian = auction.valuation.medianCents ?? 0;
  const valueHigh = auction.valuation.highCents ?? Math.max(valueMedian, 1);
  const rangeSpan = Math.max(1, valueHigh - valueLow);
  const bidPosition = auction.currentBidCents === null ? 0 : Math.max(0, Math.min(100, ((auction.currentBidCents - valueLow) / rangeSpan) * 100));
  const ceilingPosition = auction.assessment.safeMaxBidCents === null ? 0 : Math.max(0, Math.min(100, ((auction.assessment.safeMaxBidCents - valueLow) / rangeSpan) * 100));
  const forecastPosition = auction.forecast.expectedCents === null ? 0 : Math.max(0, Math.min(100, ((auction.forecast.expectedCents - valueLow) / rangeSpan) * 100));
  const allInNow = auction.currentBidCents === null ? null : auction.assessment.allInAtCurrentBidCents;
  const addedCostsNow = auction.currentBidCents === null || allInNow === null ? null : Math.max(0, allInNow - auction.currentBidCents);

  const costRows = [
    ["Current bid", costs.purchaseBidCents],
    ["Buyer premium", costs.buyerPremiumCents],
    ["Purchase tax", costs.purchaseTaxCents],
    ["Transport / towing", costs.transportCents],
    ["Title & registration", costs.titleRegistrationCents],
    ["Inspection", costs.inspectionCents],
    ["Immediate repairs", costs.repairsCents],
    ["Storage", costs.storageCents],
    ["Selling fees", costs.sellingFeesCents],
    ["Risk reserve", costs.riskReserveCents],
  ] as const;

  return (
    <main className="detail-shell">
      <header className="detail-topbar">
        <Link href="/" className="detail-brand"><span><TrendingUp size={18} /></span><strong>BIDAI</strong><em>PRO</em></Link>
        <Link href="/" className="back-link"><ArrowLeft size={15} /> Back to deal board</Link>
        <div className="detail-source-status"><span /> Official GSA record · snapshot</div>
      </header>

      <div className="detail-wrap">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/">Deal board</Link><span>/</span><span>{auction.vehicle.make}</span><span>/</span><strong>{auction.saleLotNumber}</strong>
        </nav>

        <section className="detail-hero">
          <div className="detail-photo">
            <VehicleGallery
              images={[auction.imageUrl, ...auction.images]}
              title={auction.title}
              fallbackTitle={`${auction.vehicle.year} ${auction.vehicle.make} ${auction.vehicle.model}`}
              fallbackCopy="Official photo unavailable here. Open the GSA record to view its complete gallery."
              variant="detail"
              priority
            />
            <div className="detail-photo-overlay" />
            <span className="official-image-label"><BadgeCheck size={13} /> Official listing image</span>
            <div className="detail-photo-meta"><span><MapPin size={13} /> {auction.location.city}, {auction.location.state}</span><span><Gauge size={13} /> {auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "Mileage unknown" : `${integer.format(auction.vehicle.mileage)} miles`} · {odometerStatusLabel(auction.vehicle.odometerStatus)}</span></div>
          </div>

          <div className="detail-decision">
            <div className="detail-title-row">
              <div>
                <p>{auction.saleLotNumber} · {auction.vehicle.condition}</p>
                <h1>{auction.title}</h1>
                <span>{auction.vehicle.vin ? `VIN ${auction.vehicle.vin}` : "VIN pending"}</span>
              </div>
              <div className={`detail-score ${auction.assessment.score >= 70 ? "good" : auction.assessment.score >= 45 ? "watch" : "risk"}`}><strong>{auction.assessment.score}</strong><span>Deal score</span></div>
            </div>

            <div className={`mileage-spotlight ${auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "is-unknown" : ""}`}>
              <Gauge size={24} aria-hidden="true" />
              <div><span>Odometer mileage</span><strong>{auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "Unknown — verify before pricing" : `${integer.format(auction.vehicle.mileage)} miles`}</strong><small className={`odometer-status ${auction.vehicle.odometerStatus === "conflicting-readings" ? "has-conflict" : ""}`}>{odometerStatusLabel(auction.vehicle.odometerStatus)} · Mileage materially affects market value and the safe bid.</small></div>
            </div>

            <div className="decision-banner">
              <div><ShieldCheck size={20} /><span><strong>{auction.assessment.status === "actionable" ? "Actionable opportunity" : auction.assessment.status === "watch" ? "Watch with discipline" : "Diligence required"}</strong><small>{auction.assessment.reasonCodes[0]?.replaceAll("_", " ") ?? "Review the complete evidence ledger"}</small></span></div>
              <em>{Math.round(auction.assessment.confidence * 100)}% model confidence</em>
            </div>

            <div className="decision-grid">
              <article><span>Current bid · before costs</span><strong>{dollars(auction.currentBidCents)}</strong><small>{auction.bidderCount === null ? "GSA auction price only" : `${auction.bidderCount} bidders · auction price only`}</small></article>
              <article className="all-in-decision"><span>Modeled all-in now</span><strong>{dollars(allInNow)}</strong><small>{addedCostsNow === null ? "Added costs unavailable" : `Includes ${dollars(addedCostsNow)} modeled added costs`}</small></article>
              <article><span>Projected close · before costs</span><strong>{dollars(auction.forecast.expectedCents)}</strong><small>{dollars(auction.forecast.lowCents)}–{dollars(auction.forecast.highCents)} auction price</small></article>
              <article className="primary-decision"><span>Safe bid ceiling · before costs</span><strong>{dollars(auction.assessment.safeMaxBidCents)}</strong><small>Maximum auction bid under current assumptions</small></article>
            </div>

            <div className="decision-actions">
              <a href={auction.sourceUrl} target="_blank" rel="noreferrer" className="official-cta">Open official auction <ExternalLink size={16} /></a>
              <Link href="#cost-model" className="outline-cta">Inspect the math <ArrowRight size={15} /></Link>
              <span><Clock3 size={14} /> Scheduled close {auction.endsAt ? new Date(auction.endsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "unavailable"}</span>
            </div>
          </div>
        </section>

        <section className="detail-stat-strip">
          <article><CircleDollarSign size={17} /><span>Projected profit<strong>{dollars(auction.assessment.projectedProfitCents)}</strong><small>{asPercent(auction.assessment.roi)} modeled ROI</small></span></article>
          <article><Scale size={17} /><span>Break-even bid<strong>{dollars(auction.assessment.breakEvenBidCents)}</strong><small>Current cost profile</small></span></article>
          <article><Database size={17} /><span>Evidence base<strong>{auction.forecast.sampleSize} comps</strong><small>{auction.forecast.exactModelCount} exact-model matches</small></span></article>
          <article><TrendingUp size={17} /><span>Win under ceiling<strong>{asPercent(auction.assessment.probabilityWinUnderCeiling)}</strong><small>Forecast, not a guarantee</small></span></article>
        </section>

        <div className="detail-grid">
          <section className="analysis-card market-card">
            <div className="section-heading"><div><p>Market intelligence</p><h2>Numeric value range &amp; bid position</h2></div><span className="evidence-label"><Database size={13} /> {auction.valuation.sampleSize} reference observations</span></div>
            <p className="section-copy">The numeric market evidence stays independent of the live GSA bid. Condition, mileage, title, operability, geography, and data gaps remain explicit.</p>
            <div className="market-range">
              <div className="range-labels"><span>Low {dollars(auction.valuation.lowCents)}</span><span>Median {dollars(auction.valuation.medianCents)}</span><span>High {dollars(auction.valuation.highCents)}</span></div>
              <div className="range-track">
                <span className="range-fill" />
                <i className="range-marker bid" style={{ left: `${bidPosition}%` }}><b>Current bid</b></i>
                <i className="range-marker forecast" style={{ left: `${forecastPosition}%` }}><b>P50 close</b></i>
                <i className="range-marker ceiling" style={{ left: `${ceilingPosition}%` }}><b>Safe max</b></i>
              </div>
            </div>
            <div className="market-legend"><span><i className="dot bid" /> Current bid {dollars(auction.currentBidCents)}</span><span><i className="dot forecast" /> Projected close {dollars(auction.forecast.expectedCents)}</span><span><i className="dot ceiling" /> Safe ceiling {dollars(auction.assessment.safeMaxBidCents)}</span></div>
            <p className="market-vehicle-facts">The numeric reference is prepared for <b>{auction.vehicle.year} {auction.vehicle.make} {auction.vehicle.model}</b>, VIN <b>{auction.vehicle.vin ?? "not captured"}</b>, mileage <b>{auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "unknown" : `${integer.format(auction.vehicle.mileage)} mi`}</b>, ZIP <b>{auction.location.postalCode || "not captured"}</b>, and condition <b>{auction.vehicle.condition}</b>.</p>
            <MarketValueEvidence auction={auction} />
          </section>

          <section className="analysis-card vehicle-card-detail">
            <div className="section-heading"><div><p>Source facts</p><h2>Vehicle dossier</h2></div><CarFront size={18} /></div>
            <dl className="spec-grid">
              <div><dt>Year</dt><dd>{auction.vehicle.year}</dd></div>
              <div><dt>Make</dt><dd>{auction.vehicle.make}</dd></div>
              <div><dt>Model</dt><dd>{auction.vehicle.model}</dd></div>
              <div className={`mileage-spec ${auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "is-unknown" : ""}`}><dt>Mileage</dt><dd><Gauge size={13} /> {auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "Unknown — verify" : `${integer.format(auction.vehicle.mileage)} mi`}</dd></div>
              <div><dt>Trim</dt><dd>{auction.vehicle.trim ?? "Not stated"}</dd></div>
              <div><dt>Body</dt><dd>{auction.vehicle.bodyStyle ?? "Not stated"}</dd></div>
              <div><dt>Drivetrain</dt><dd>{auction.vehicle.drivetrain ?? "Not stated"}</dd></div>
              <div><dt>Transmission</dt><dd>{auction.vehicle.transmission ?? "Not stated"}</dd></div>
              <div><dt>Fuel</dt><dd><Fuel size={12} /> {auction.vehicle.fuelType ?? "Not stated"}</dd></div>
              <div><dt>Operability</dt><dd>{auction.vehicle.operability}</dd></div>
              <div><dt>Title status</dt><dd>{auction.vehicle.titleStatus ?? "SF-97 / verify"}</dd></div>
            </dl>
            <div className={`condition-disclosure ${auction.vehicle.riskFlags.length ? "has-issues" : ""}`}>
              <div><AlertTriangle size={17} aria-hidden="true" /><strong>Damage, condition &amp; disclosed issues</strong></div>
              <p><b>{auction.vehicle.condition}</b> condition · <b>{auction.vehicle.operability}</b></p>
              {auction.vehicle.riskFlags.length ? (
                <ul>{auction.vehicle.riskFlags.map((risk) => <li key={risk}>{risk}</li>)}</ul>
              ) : (
                <p>No structured damage was captured. This is not a clean-condition guarantee—verify every photo, disclosure, and inspection report at GSA.</p>
              )}
            </div>
            <p className="vehicle-description"><strong>Official listing description</strong>{auction.vehicle.description || "No description was captured; review the official listing before pricing."}</p>
          </section>

          <section className="analysis-card cost-card" id="cost-model">
            <div className="section-heading"><div><p>Underwriting</p><h2>All-in cost waterfall</h2></div><Wrench size={18} /></div>
            <div className="cost-list">
              {costRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{dollars(value)}</strong></div>)}
            </div>
            <div className="cost-comparison" aria-label="Price before and after modeled costs">
              <div className="bid-only-total"><span><strong>Current bid · no added costs</strong><small>Observed auction price only</small></span><strong>{dollars(auction.currentBidCents)}</strong></div>
              <div className="added-cost-total"><span><strong>Modeled added-cost total</strong><small>Acquisition + exit + risk costs</small></span><strong>{dollars(addedCostsNow)}</strong></div>
              <div className="cost-total"><span><strong>Modeled all-in cost now</strong><small>Bid + acquisition + exit costs</small></span><strong>{dollars(allInNow)}</strong></div>
            </div>
            <div className="profit-row"><span>Projected profit at expected close</span><strong className={(auction.assessment.projectedProfitCents ?? -1) >= 0 ? "profit" : "loss"}>{dollars(auction.assessment.projectedProfitCents)}</strong></div>
          </section>

          <section className="analysis-card risk-card">
            <div className="section-heading"><div><p>Diligence</p><h2>Risk & evidence checklist</h2></div><AlertTriangle size={18} /></div>
            <div className="risk-list">
              {auction.vehicle.riskFlags.length ? auction.vehicle.riskFlags.map((risk) => <div className="risk-item" key={risk}><AlertTriangle size={15} /><span><strong>{risk}</strong><small>Verify on the official listing and during inspection.</small></span></div>) : <div className="risk-item clear"><CheckCircle2 size={15} /><span><strong>No material structured risks detected</strong><small>Normal used-vehicle diligence still applies.</small></span></div>}
              <div className="risk-item clear"><CheckCircle2 size={15} /><span><strong>Market value kept independent</strong><small>The current bid was not used as a resale valuation input.</small></span></div>
              <div className="risk-item clear"><CheckCircle2 size={15} /><span><strong>Point-in-time forecast preserved</strong><small>Model {auction.forecast.modelVersion} · {auction.forecast.provenance}</small></span></div>
              {auction.assessment.warnings.map((warning) => <div className="risk-item" key={warning}><AlertTriangle size={15} /><span><strong>{warning}</strong><small>Applied to score, ceiling, or confidence.</small></span></div>)}
            </div>
          </section>
        </div>

        <section className="analysis-card evidence-card">
          <div className="section-heading"><div><p>Forecast evidence</p><h2>Comparable outcome ledger</h2></div><span className="evidence-label"><ShieldCheck size={13} /> Immutable as-of snapshot</span></div>
          <div className="evidence-summary">
            <div><span>P20 close</span><strong>{dollars(auction.forecast.lowCents)}</strong></div>
            <div><span>P50 expected</span><strong>{dollars(auction.forecast.expectedCents)}</strong></div>
            <div><span>P80 close</span><strong>{dollars(auction.forecast.highCents)}</strong></div>
            <div><span>Confidence</span><strong>{Math.round(auction.forecast.confidence * 100)}%</strong></div>
          </div>
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <thead><tr><th>Evidence ID</th><th>Type</th><th>Use</th><th>Status</th></tr></thead>
              <tbody>
                {auction.forecast.evidenceIds.slice(0, 6).map((evidenceId, index) => <tr key={evidenceId}><td>{evidenceId}</td><td>{index < auction.forecast.exactModelCount ? "Exact model" : "Adjusted vehicle comp"}</td><td>{index % 2 ? "Range calibration" : "Close distribution"}</td><td><span>Closed high bid · award unconfirmed</span></td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="evidence-footnote">GSA closed “current bid” records are treated as closed high bids until an authoritative award source confirms a sale. Forecast evidence never changes the safe bid ceiling.</p>
        </section>

        <section className="detail-disclaimer">
          <ShieldCheck size={20} />
          <div><strong>Independent decision support, not an auction or appraisal</strong><p>BidAI Pro is not affiliated with or endorsed by GSA, does not place bids, and does not guarantee value, condition, closing price, or award. Verify the live bid, extensions, reserve, inspection terms, title documentation, and all vehicle facts at the official source.</p></div>
          <a href={auction.sourceUrl} target="_blank" rel="noreferrer">Verify at GSA <ExternalLink size={14} /></a>
        </section>
      </div>
    </main>
  );
}
