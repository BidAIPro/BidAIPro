"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CarFront,
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  FileSearch,
  Fuel,
  Gauge,
  MapPin,
  ShieldCheck,
  TrendingUp,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AuctionOpportunity, ValuationReference } from "../../lib/auction-types";
import { applyLiveBidSnapshot, type LiveBidSnapshot } from "../../lib/live-bid-snapshot";
import { applyValuationToOpportunity } from "../../lib/opportunity-adapter";
import { publicApiUrl } from "../../lib/public-api";
import { getRefreshDecision } from "../../lib/refresh-policy";
import { MarketValueEvidence } from "./market-reference-links";
import { VehicleGallery } from "./vehicle-gallery";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(cents: number | null | undefined) {
  return cents === null || cents === undefined ? "Unavailable" : money.format(cents / 100);
}

function mileage(auction: AuctionOpportunity) {
  return auction.vehicle.mileage === null || auction.vehicle.mileage === undefined
    ? "Unknown — verify before pricing"
    : `${integer.format(auction.vehicle.mileage)} miles`;
}

function odometerStatusLabel(status: AuctionOpportunity["vehicle"]["odometerStatus"]) {
  if (status === "conflicting-readings") return "Conflicting GSA readings";
  if (status === "not-reported") return "Not reported";
  return "GSA reported · verify";
}

function LoadingState({ title, copy }: { title: string; copy: string }) {
  return (
    <main className="detail-shell">
      <header className="detail-topbar"><Link href="/" className="detail-brand"><span><TrendingUp size={18} /></span><strong>BIDAI</strong><em>PRO</em></Link></header>
      <div className="live-detail-state"><span className="live-detail-spinner" /><h1>{title}</h1><p>{copy}</p><Link href="/" className="outline-cta"><ArrowLeft size={15} /> Return to deal board</Link></div>
    </main>
  );
}

export function LiveVehicleDetail() {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("id")?.trim() ?? "";
  const [auction, setAuction] = useState<AuctionOpportunity | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [liveBidPolling, setLiveBidPolling] = useState(false);
  const [marketValueLoading, setMarketValueLoading] = useState(false);
  const liveBidRequest = useRef<AbortController | null>(null);
  const liveBidLastAttempt = useRef(0);
  const marketValueRequest = useRef<AbortController | null>(null);
  const marketValueAttempted = useRef<string | null>(null);

  useEffect(() => {
    if (!requestedId) return;

    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(publicApiUrl("/api/opportunities"), { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Opportunity feed returned ${response.status}`);
        const payload = await response.json() as {
          data?: AuctionOpportunity[];
          meta?: { sourceHealth?: { liveBidPolling?: boolean } | null };
        };
        const match = payload.data?.find((item) => item.id === requestedId || item.externalId === requestedId) ?? null;
        setAuction(match);
        setLiveBidPolling(payload.meta?.sourceHealth?.liveBidPolling === true);
        setStatus(match ? "ready" : "missing");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus("error");
      }
    }
    void load();
    return () => controller.abort();
  }, [requestedId]);

  const marketValueExternalId = auction?.externalId ?? null;

  useEffect(() => {
    if (!marketValueExternalId || marketValueAttempted.current === marketValueExternalId) return;
    marketValueAttempted.current = marketValueExternalId;
    const controller = new AbortController();
    marketValueRequest.current = controller;
    setMarketValueLoading(true);

    void (async () => {
      try {
        const response = await fetch(
          publicApiUrl(`/api/market-values?ids=${encodeURIComponent(marketValueExternalId)}`),
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Market value feed returned ${response.status}`);
        const payload = await response.json() as {
          data?: Array<{
            externalId: string;
            valuation: ValuationReference;
            cacheStatus: "fresh" | "refreshed" | "unavailable";
          }>;
          meta?: { generatedAt?: string };
        };
        const result = payload.data?.find((item) => item.externalId === marketValueExternalId);
        if (!result) throw new Error("Market value feed omitted this vehicle");
        setAuction((current) => current && !(
          result.valuation.status === "unavailable" &&
          current.valuation.status !== "unavailable"
        )
          ? applyValuationToOpportunity(
              current,
              result.valuation,
              payload.meta?.generatedAt ?? new Date().toISOString(),
            )
          : current
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      } finally {
        if (marketValueRequest.current === controller) {
          marketValueRequest.current = null;
          setMarketValueLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
      if (marketValueRequest.current === controller) marketValueRequest.current = null;
    };
  }, [marketValueExternalId]);

  useEffect(() => {
    if (!liveBidPolling || !auction?.id.startsWith("live-") || !auction.endsAt || !/^\d+$/.test(auction.externalId)) {
      return;
    }

    function refreshIfDue() {
      if (!auction || liveBidRequest.current) return;
      const checkedAt = Date.now();
      const decision = getRefreshDecision({
        now: checkedAt,
        endsAt: auction.endsAt!,
        lastCheckedAt: auction.lastCheckedAt,
        status: auction.status,
      });
      if (!decision.shouldRefresh || decision.intervalMs === null) return;
      if (checkedAt - liveBidLastAttempt.current < Math.max(10_000, decision.intervalMs - 1_000)) {
        return;
      }

      const controller = new AbortController();
      liveBidRequest.current = controller;
      liveBidLastAttempt.current = checkedAt;
      void (async () => {
        try {
          const response = await fetch(
            publicApiUrl(`/api/live-bid?id=${encodeURIComponent(auction.externalId)}`),
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error(`Live bid feed returned ${response.status}`);
          const payload = await response.json() as { data?: LiveBidSnapshot };
          if (!payload.data || payload.data.externalId !== auction.externalId) {
            throw new Error("Live bid feed returned the wrong auction");
          }
          setAuction((current) => current ? applyLiveBidSnapshot(current, payload.data!) : current);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
        } finally {
          if (liveBidRequest.current === controller) liveBidRequest.current = null;
        }
      })();
    }

    refreshIfDue();
    const timer = window.setInterval(refreshIfDue, 5_000);
    return () => {
      window.clearInterval(timer);
      liveBidRequest.current?.abort();
      liveBidRequest.current = null;
    };
  }, [auction, liveBidPolling]);

  if (!requestedId) return <LoadingState title="Choose a vehicle from the deal board" copy="This analysis page needs an active GSA vehicle identifier." />;
  if (status === "loading") return <LoadingState title="Loading vehicle analysis" copy="Retrieving the latest GSA listing snapshot…" />;
  if (status === "error") return <LoadingState title="Vehicle feed is temporarily unavailable" copy="Return to the deal board or verify this vehicle directly at GSA Auctions." />;
  if (!auction || status === "missing") return <LoadingState title="Vehicle not found in the active feed" copy="It may have closed, changed identifiers, or left the current GSA catalog." />;

  const { costs } = auction.assessment;
  const allInNow = auction.currentBidCents === null ? null : auction.assessment.allInAtCurrentBidCents;
  const addedCostsNow = auction.currentBidCents === null || allInNow === null ? null : Math.max(0, allInNow - auction.currentBidCents);
  const costRows = [
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
        <div className="detail-source-status"><span /> {liveBidPolling ? "Live source checks available" : "Snapshot · verify current bid"}</div>
      </header>

      <div className="detail-wrap">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/">Deal board</Link><span>/</span><span>{auction.vehicle.make}</span><span>/</span><strong>{auction.saleLotNumber}</strong></nav>

        <section className="detail-hero">
          <div className="detail-photo">
            <VehicleGallery images={[auction.imageUrl, ...(auction.images ?? [])]} title={auction.title} fallbackTitle={`${auction.vehicle.year} ${auction.vehicle.make} ${auction.vehicle.model}`} fallbackCopy="Official photo unavailable here. Open the GSA record to view its complete gallery." variant="detail" priority />
            <div className="detail-photo-overlay" />
            <span className="official-image-label"><BadgeCheck size={13} /> Official listing media</span>
            <div className="detail-photo-meta"><span><MapPin size={13} /> {auction.location.city}, {auction.location.state}</span><span><Gauge size={13} /> {mileage(auction)} · {odometerStatusLabel(auction.vehicle.odometerStatus)}</span></div>
          </div>

          <div className="detail-decision">
            <div className="detail-title-row">
              <div><p>{auction.saleLotNumber} · {auction.vehicle.condition}</p><h1>{auction.title}</h1><span>{auction.vehicle.vin ? `VIN ${auction.vehicle.vin}` : "VIN pending"}</span></div>
              <div className={`detail-score ${auction.assessment.score >= 70 ? "good" : auction.assessment.score >= 45 ? "watch" : "risk"}`}><strong>{auction.assessment.status === "insufficient" ? "—" : auction.assessment.score}</strong><span>Deal score</span></div>
            </div>

            <div className={`mileage-spotlight ${auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "is-unknown" : ""}`}><Gauge size={24} aria-hidden="true" /><div><span>Odometer mileage</span><strong>{mileage(auction)}</strong><small className={`odometer-status ${auction.vehicle.odometerStatus === "conflicting-readings" ? "has-conflict" : ""}`}>{odometerStatusLabel(auction.vehicle.odometerStatus)} · Mileage materially affects market value and the safe bid.</small></div></div>

            <div className="decision-banner"><div><ShieldCheck size={20} /><span><strong>{auction.assessment.status === "actionable" ? "Actionable opportunity" : auction.assessment.status === "watch" ? "Watch with discipline" : "Diligence required"}</strong><small>{auction.assessment.reasonCodes[0]?.replaceAll("_", " ") ?? "Review the complete evidence ledger"}</small></span></div><em>{Math.round(auction.assessment.confidence * 100)}% confidence</em></div>

            <div className="decision-grid">
              <article><span>Current bid · before costs</span><strong>{dollars(auction.currentBidCents)}</strong><small>Observed GSA auction price only</small></article>
              <article className="all-in-decision"><span>Modeled all-in now</span><strong>{dollars(allInNow)}</strong><small>{addedCostsNow === null ? "Added costs unavailable" : `Includes ${dollars(addedCostsNow)} modeled added costs`}</small></article>
              <article><span>Adjusted market value</span><strong>{auction.valuation.medianCents === null ? marketValueLoading ? "Pulling…" : "Unavailable" : dollars(auction.valuation.medianCents)}</strong><small>{auction.valuation.medianCents === null ? "Automatic numeric lookup" : `${auction.valuation.provider} · ${auction.valuation.sampleSize} observations`}</small></article>
              <article className="primary-decision"><span>Safe bid ceiling · before costs</span><strong>{dollars(auction.assessment.safeMaxBidCents)}</strong><small>Maximum auction bid under current assumptions</small></article>
            </div>

            <div className="decision-actions"><a href={auction.sourceUrl} target="_blank" rel="noreferrer" className="official-cta">Open official auction <ExternalLink size={16} /></a><Link href="#cost-model" className="outline-cta">Inspect costs <Wrench size={15} /></Link><span><Clock3 size={14} /> Updated {new Date(auction.lastCheckedAt).toLocaleString()}</span></div>
          </div>
        </section>

        {!liveBidPolling && (
          <section className="detail-feed-warning" aria-label="Bid freshness warning">
            <AlertTriangle size={18} />
            <div><strong>Snapshot bid — live refresh unavailable</strong><span>GSA blocks the hosted live-bid connection. Verify the bid, bidder count, extensions, and closing status at the official auction before acting.</span></div>
            <a href={auction.sourceUrl} target="_blank" rel="noreferrer">Verify live at GSA <ExternalLink size={14} /></a>
          </section>
        )}

        <section className="detail-stat-strip">
          <article><CircleDollarSign size={17} /><span>Projected close<strong>{dollars(auction.forecast.expectedCents)}</strong><small>Before added costs</small></span></article>
          <article><TrendingUp size={17} /><span>Conservative value<strong>{dollars(auction.assessment.conservativeValueCents)}</strong><small>Independent of live bid</small></span></article>
          <article><Database size={17} /><span>Evidence base<strong>{auction.forecast.sampleSize} comps</strong><small>{auction.forecast.exactModelCount} exact-model matches</small></span></article>
          <article><ShieldCheck size={17} /><span>Model confidence<strong>{Math.round(auction.assessment.confidence * 100)}%</strong><small>Forecast, not a guarantee</small></span></article>
        </section>

        <div className="detail-grid">
          <section className="analysis-card vehicle-card-detail">
            <div className="section-heading"><div><p>Source facts</p><h2>Vehicle dossier</h2></div><CarFront size={18} /></div>
            <dl className="spec-grid">
              <div><dt>Year</dt><dd>{auction.vehicle.year}</dd></div><div><dt>Make</dt><dd>{auction.vehicle.make}</dd></div>
              <div><dt>Model</dt><dd>{auction.vehicle.model}</dd></div><div className={`mileage-spec ${auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "is-unknown" : ""}`}><dt>Mileage</dt><dd><Gauge size={13} /> {mileage(auction)}</dd></div>
              <div><dt>Trim</dt><dd>{auction.vehicle.trim ?? "Not stated"}</dd></div><div><dt>Body</dt><dd>{auction.vehicle.bodyStyle ?? "Not stated"}</dd></div>
              <div><dt>Drivetrain</dt><dd>{auction.vehicle.drivetrain ?? "Not stated"}</dd></div><div><dt>Transmission</dt><dd>{auction.vehicle.transmission ?? "Not stated"}</dd></div>
              <div><dt>Fuel</dt><dd><Fuel size={12} /> {auction.vehicle.fuelType ?? "Not stated"}</dd></div><div><dt>Title</dt><dd>{auction.vehicle.titleStatus ?? "Verify at GSA"}</dd></div>
            </dl>
            <div className={`condition-disclosure ${auction.vehicle.riskFlags.length ? "has-issues" : ""}`}><div><AlertTriangle size={17} /><strong>Damage, condition &amp; disclosed issues</strong></div><p><b>{auction.vehicle.condition}</b> condition · <b>{auction.vehicle.operability}</b></p>{auction.vehicle.riskFlags.length ? <ul>{auction.vehicle.riskFlags.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>No structured damage was captured. This is not a clean-condition guarantee—verify every photo, disclosure, and inspection report at GSA.</p>}</div>
            <p className="vehicle-description"><strong>Official listing description</strong>{auction.vehicle.description || "No description was captured; review the official listing before pricing."}</p>
          </section>

          <section className="analysis-card market-card">
            <div className="section-heading"><div><p>Market intelligence</p><h2>Automatic market value</h2></div><FileSearch size={18} /></div>
            <p className="section-copy">BidAI Pro pulls the numeric source evidence automatically and keeps it independent of the live GSA bid. The displayed range identifies the provider, sample, as-of date, confidence, and mileage adjustment.</p>
            <p className="market-vehicle-facts">The automatic match is prepared for <b>{auction.vehicle.year} {auction.vehicle.make} {auction.vehicle.model}</b>, VIN <b>{auction.vehicle.vin ?? "not captured"}</b>, captured mileage <b>{mileage(auction)}</b>, ZIP <b>{auction.location.postalCode || "not captured"}</b>, and condition <b>{auction.vehicle.condition}</b>.</p>
            <MarketValueEvidence auction={auction} loading={marketValueLoading} />
          </section>

          <section className="analysis-card cost-card" id="cost-model">
            <div className="section-heading"><div><p>Underwriting</p><h2>Price before and after modeled costs</h2></div><Wrench size={18} /></div>
            <div className="cost-list">{costRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{dollars(value)}</strong></div>)}</div>
            <div className="cost-comparison" aria-label="Price before and after modeled costs"><div className="bid-only-total"><span><strong>Current bid · no added costs</strong><small>Observed auction price only</small></span><strong>{dollars(auction.currentBidCents)}</strong></div><div className="added-cost-total"><span><strong>Modeled added-cost total</strong><small>Acquisition + exit + risk costs</small></span><strong>{dollars(addedCostsNow)}</strong></div><div className="cost-total"><span><strong>Modeled all-in cost now</strong><small>Bid + modeled added costs</small></span><strong>{dollars(allInNow)}</strong></div></div>
          </section>

          <section className="analysis-card risk-card">
            <div className="section-heading"><div><p>Diligence</p><h2>Risk &amp; evidence checklist</h2></div><AlertTriangle size={18} /></div>
            <div className="risk-list">{[...auction.vehicle.riskFlags, ...auction.assessment.warnings].length ? [...new Set([...auction.vehicle.riskFlags, ...auction.assessment.warnings])].map((risk) => <div className="risk-item" key={risk}><AlertTriangle size={15} /><span><strong>{risk}</strong><small>Verify at the official listing and during inspection.</small></span></div>) : <div className="risk-item clear"><ShieldCheck size={15} /><span><strong>No structured issues captured</strong><small>Normal used-vehicle diligence still applies.</small></span></div>}</div>
          </section>
        </div>

        <section className="detail-disclaimer"><ShieldCheck size={20} /><div><strong>Independent decision support, not an auction or appraisal</strong><p>BidAI Pro does not guarantee value, condition, mileage, closing price, or award. Verify the live bid, extensions, inspection terms, title documentation, odometer, and every vehicle fact at the official source.</p></div><a href={auction.sourceUrl} target="_blank" rel="noreferrer">Verify at GSA <ExternalLink size={14} /></a></section>
      </div>
    </main>
  );
}
