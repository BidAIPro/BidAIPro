"use client";

import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  Bell,
  Bookmark,
  BookmarkCheck,
  CarFront,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  Gauge,
  Grid2X2,
  HeartPulse,
  LayoutDashboard,
  List,
  MapPin,
  Menu,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AuctionOpportunity } from "../../lib/auction-types";
import { SEED_AUCTIONS } from "../../lib/seed-auctions";

type SortKey = "deal" | "ending" | "profit" | "bid";
type QuickFilter = "all" | "closing" | "trucks" | "high-confidence" | "under-10k" | "saved";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(cents: number | null | undefined) {
  return cents === null || cents === undefined ? "—" : money.format(cents / 100);
}

function formatMileage(value: number | null | undefined) {
  return value === null || value === undefined ? "Mileage unknown" : `${integer.format(value)} mi`;
}

function timeLeft(endsAt: string, now: number) {
  const distance = new Date(endsAt).getTime() - now;
  if (distance <= 0) return { label: "Closing confirmation", urgent: true, seconds: 0 };
  const seconds = Math.floor(distance / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  if (days > 0) return { label: `${days}d ${hours}h`, urgent: false, seconds };
  if (hours > 0) return { label: `${hours}h ${minutes}m`, urgent: false, seconds };
  if (minutes > 5) return { label: `${minutes}m ${remainder.toString().padStart(2, "0")}s`, urgent: true, seconds };
  return {
    label: `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`,
    urgent: true,
    seconds,
  };
}

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function scoreLabel(score: number) {
  if (score >= 75) return "Strong deal";
  if (score >= 55) return "Worth watching";
  if (score >= 35) return "Needs diligence";
  return "High risk";
}

function statusTone(status: AuctionOpportunity["assessment"]["status"]) {
  if (status === "actionable") return "positive";
  if (status === "watch") return "watch";
  if (status === "avoid") return "negative";
  return "neutral";
}

function DealScore({ score }: { score: number }) {
  const bounded = Math.max(0, Math.min(100, score));
  return (
    <div className="deal-score" style={{ "--score": `${bounded * 3.6}deg` } as CSSProperties}>
      <div>
        <strong>{bounded}</strong>
        <span>/100</span>
      </div>
    </div>
  );
}

function PollingLabel({ auction, now }: { auction: AuctionOpportunity; now: number }) {
  if (auction.id.startsWith("live-")) {
    return <span className="poll-label"><Activity size={13} /> 1 hr catalog</span>;
  }
  const remaining = timeLeft(auction.endsAt, now).seconds;
  const interval = remaining <= 60 ? "15 sec" : remaining <= 300 ? "30 sec" : remaining <= 1_800 ? "5 min" : "1 hr";
  return (
    <span className="poll-label">
      <Activity size={13} /> {interval} watch
    </span>
  );
}

function OpportunityCard({
  auction,
  now,
  saved,
  onSave,
  compact,
}: {
  auction: AuctionOpportunity;
  now: number;
  saved: boolean;
  onSave: () => void;
  compact: boolean;
}) {
  const discoveryOnly = auction.id.startsWith("live-");
  const countdown = discoveryOnly
    ? { label: "Exact time at GSA", urgent: false, seconds: Number.POSITIVE_INFINITY }
    : timeLeft(auction.endsAt, now);
  const currentBid = auction.currentBidCents;
  const marketValue = auction.valuation.medianCents;
  const predictedClose = auction.forecast.expectedCents;
  const safeMax = auction.assessment.safeMaxBidCents;
  const headroom = marketValue === null ? null : marketValue - auction.assessment.allInAtCurrentBidCents;
  const headroomPct = marketValue && headroom !== null ? Math.max(0, Math.min(100, (headroom / marketValue) * 100)) : 0;
  const primaryReason = auction.assessment.reasonCodes[0]?.replaceAll("_", " ") ?? "Review source evidence";

  return (
    <article className={`opportunity-card ${compact ? "is-compact" : ""}`}>
      <div className="vehicle-media">
        {/* The source-provided image remains remote and links back to the official record. */}
        {auction.imageUrl ? (
          <img src={auction.imageUrl} alt={`${auction.title} from the official GSA listing`} loading="lazy" />
        ) : (
          <div className="vehicle-placeholder"><CarFront size={44} /><span>{auction.vehicle.year} {auction.vehicle.make}</span><small>Photos available at the official GSA listing</small></div>
        )}
        <div className="media-scrim" />
        <div className="media-topline">
          <span className={`status-pill ${statusTone(auction.assessment.status)}`}>
            <span /> {auction.assessment.status === "actionable" ? "Opportunity" : auction.assessment.status}
          </span>
          <button className="icon-button glass" type="button" onClick={onSave} aria-label={saved ? "Remove from watchlist" : "Add to watchlist"}>
            {saved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
          </button>
        </div>
        <div className={`countdown ${countdown.urgent ? "urgent" : ""}`}>
          <Clock3 size={15} />
          <span>Closes in</span>
          <strong>{countdown.label}</strong>
        </div>
        <span className="image-source">{auction.imageUrl ? "Official GSA listing image" : "Image not republished"}</span>
      </div>

      <div className="vehicle-content">
        <div className="vehicle-heading">
          <div>
            <div className="lot-line">
              <span>{auction.saleLotNumber}</span>
              <span>•</span>
              <span>{auction.vehicle.condition}</span>
            </div>
            <h2>{auction.title}</h2>
            <div className="vehicle-meta">
              <span><Gauge size={14} /> {formatMileage(auction.vehicle.mileage)}</span>
              <span><MapPin size={14} /> {auction.location.city}, {auction.location.state}</span>
              <span><CarFront size={14} /> {auction.vehicle.drivetrain ?? auction.vehicle.bodyStyle ?? "Vehicle"}</span>
            </div>
          </div>
          <div className="score-lockup">
            <DealScore score={auction.assessment.score} />
            <div><strong>{scoreLabel(auction.assessment.score)}</strong><span>{Math.round(auction.assessment.confidence * 100)}% confidence</span></div>
          </div>
        </div>

        <div className="price-stack">
          <div>
            <span>Current bid</span>
            <strong>{dollars(currentBid)}</strong>
            <small>{auction.bidCount ?? 0} bids</small>
          </div>
          <div>
            <span>Projected close</span>
            <strong>{dollars(predictedClose)}</strong>
            <small>{auction.forecast.lowCents !== null && auction.forecast.highCents !== null ? `${dollars(auction.forecast.lowCents)}–${dollars(auction.forecast.highCents)}` : "More evidence needed"}</small>
          </div>
          <div>
            <span>Market reference</span>
            <strong>{dollars(marketValue)}</strong>
            <small>{auction.valuation.status === "provider" ? auction.valuation.provider : "Demo reference · not KBB"}</small>
          </div>
          <div className="ceiling-metric">
            <span>Safe bid ceiling</span>
            <strong>{dollars(safeMax)}</strong>
            <small>After costs + risk reserve</small>
          </div>
        </div>

        <div className="headroom-row">
          <div className="headroom-copy">
            <span>Risk-adjusted headroom now</span>
            <strong className={headroom !== null && headroom >= 0 ? "positive-text" : "negative-text"}>{dollars(headroom)}</strong>
          </div>
          <div className="headroom-track" aria-label={`${Math.round(headroomPct)} percent headroom`}>
            <span style={{ width: `${headroomPct}%` }} />
          </div>
          <span className="reason-chip"><Sparkles size={13} /> {primaryReason}</span>
        </div>

        <div className="evidence-row">
          <div>
            <span className="evidence-chip"><Database size={13} /> {auction.forecast.sampleSize} GSA comps</span>
            <span className="evidence-chip"><ShieldCheck size={13} /> VIN {auction.vehicle.vin ? "captured" : "pending"}</span>
            <PollingLabel auction={auction} now={now} />
          </div>
          <div className="card-actions">
            <span className="freshness">Checked {relativeTime(auction.lastCheckedAt, now)}</span>
            {auction.id.startsWith("live-") ? (
              <span className="secondary-button disabled">Valuation pending</span>
            ) : (
              <Link href={`/vehicle/${auction.id}`} className="secondary-button">Full analysis <ArrowRight size={15} /></Link>
            )}
            <a href={auction.sourceUrl} target="_blank" rel="noreferrer" className="primary-button">View at GSA <ExternalLink size={15} /></a>
          </div>
        </div>
      </div>
    </article>
  );
}

export function DealBoard() {
  const [now, setNow] = useState(() => Date.now());
  const [auctions, setAuctions] = useState<AuctionOpportunity[]>(() => [...SEED_AUCTIONS]);
  const [sourceMeta, setSourceMeta] = useState({
    mode: "loading",
    status: "checking",
    vehicleLots: SEED_AUCTIONS.length,
  });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("deal");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [compact, setCompact] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [maxBid, setMaxBid] = useState("");
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/opportunities", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Opportunity feed returned ${response.status}`);
        return response.json() as Promise<{
          data?: AuctionOpportunity[];
          meta?: {
            mode?: string;
            coverage?: { vehicleLots?: number } | null;
            sourceHealth?: { status?: string } | null;
          };
        }>;
      })
      .then((payload) => {
        if (Array.isArray(payload.data) && payload.data.length) setAuctions(payload.data);
        setSourceMeta({
          mode: payload.meta?.mode ?? "unknown",
          status: payload.meta?.sourceHealth?.status ?? "unknown",
          vehicleLots: payload.meta?.coverage?.vehicleLots ?? payload.data?.length ?? SEED_AUCTIONS.length,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setSourceMeta({ mode: "last-known-demo-snapshot", status: "unavailable", vehicleLots: SEED_AUCTIONS.length });
      });
    return () => controller.abort();
  }, []);

  const states = useMemo(() => Array.from(new Set(auctions.map((item) => item.location.state))).sort(), [auctions]);
  const conditions = useMemo(() => Array.from(new Set(auctions.map((item) => item.vehicle.condition))).sort(), [auctions]);

  const opportunities = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const maxBidCents = maxBid ? Number(maxBid) * 100 : null;
    const result = auctions.filter((auction) => {
      const haystack = `${auction.title} ${auction.vehicle.vin ?? ""} ${auction.location.city} ${auction.location.state} ${auction.vehicle.bodyStyle ?? ""}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (stateFilter !== "all" && auction.location.state !== stateFilter) return false;
      if (conditionFilter !== "all" && auction.vehicle.condition !== conditionFilter) return false;
      if (maxBidCents !== null && auction.currentBidCents > maxBidCents) return false;
      if (quickFilter === "closing") {
        const remaining = new Date(auction.endsAt).getTime() - now;
        if (auction.id.startsWith("live-") || remaining < 0 || remaining > 30 * 60_000) return false;
      }
      if (quickFilter === "trucks" && !`${auction.vehicle.bodyStyle ?? ""} ${auction.title}`.toLowerCase().match(/truck|pickup|silverado|ram|f-?2/)) return false;
      if (quickFilter === "high-confidence" && auction.assessment.confidence < 0.7) return false;
      if (quickFilter === "under-10k" && auction.currentBidCents > 1_000_000) return false;
      if (quickFilter === "saved" && !saved.has(auction.id)) return false;
      return auction.status === "active";
    });

    return result.sort((a, b) => {
      if (sort === "ending") return new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime();
      if (sort === "profit") return (b.assessment.projectedProfitCents ?? -Infinity) - (a.assessment.projectedProfitCents ?? -Infinity);
      if (sort === "bid") return a.currentBidCents - b.currentBidCents;
      return b.assessment.score - a.assessment.score;
    });
  }, [auctions, conditionFilter, maxBid, now, query, quickFilter, saved, sort, stateFilter]);

  const totalHeadroom = auctions.reduce((sum, item) => sum + Math.max(0, item.assessment.projectedProfitCents ?? 0), 0);
  const closingCount = auctions.filter((item) => {
    const remaining = new Date(item.endsAt).getTime() - now;
    return !item.id.startsWith("live-") && remaining >= 0 && remaining <= 30 * 60_000;
  }).length;
  const medianDiscount = [...auctions]
    .map((item) => item.assessment.discountToValue ?? 0)
    .sort((a, b) => a - b)[Math.floor(auctions.length / 2)] ?? 0;

  function toggleSaved(id: string) {
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function refreshSnapshot() {
    setRefreshing(true);
    window.setTimeout(() => {
      setNow(Date.now());
      setRefreshing(false);
    }, 650);
  }

  return (
    <div className="app-shell">
      <aside className={`nav-rail ${navOpen ? "is-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><TrendingUp size={20} /></div>
          <div><strong>BIDAI</strong><span>PRO</span><small>GSA Vehicle Intelligence</small></div>
          <button type="button" className="nav-close" onClick={() => setNavOpen(false)} aria-label="Close navigation"><X /></button>
        </div>

        <nav aria-label="Primary navigation">
          <p>Workspace</p>
          <a className={quickFilter === "all" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("all")}><LayoutDashboard size={18} /> Deal board <span>{auctions.length}</span></a>
          <a className={quickFilter === "closing" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("closing")}><Clock3 size={18} /> Closing room <span className="attention">{closingCount}</span></a>
          <a className={quickFilter === "saved" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("saved")}><Bookmark size={18} /> Watchlist <span>{saved.size}</span></a>
          <p>Intelligence</p>
          <a href="#deal-board" onClick={() => setQuickFilter("high-confidence")}><CircleDollarSign size={18} /> Market values</a>
          <a href="#deal-board"><Database size={18} /> Closed comps</a>
          <a href="#source-health"><HeartPulse size={18} /> Data health</a>
        </nav>

        <div className="source-health-card" id="source-health">
          <div><Activity size={16} /><span>Source health</span><strong>{sourceMeta.status === "live" ? "Operational" : sourceMeta.status === "checking" ? "Checking" : "Fallback"}</strong></div>
          <p>{sourceMeta.status === "live" ? `Official GSA catalog delivered ${sourceMeta.vehicleLots} vehicle lots.` : "Last-known official snapshot is visible. Closing-detail adapter remains permission-gated."}</p>
          <div className="health-meter"><span /></div>
          <small>Hourly discovery · adaptive watch planned</small>
        </div>

        <button className="settings-link" type="button"><Settings2 size={17} /> Preferences</button>
      </aside>

      <main className="main-canvas" id="deal-board">
        <header className="topbar">
          <button className="mobile-menu" type="button" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Menu /></button>
          <div className="global-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search make, model, VIN, city…" aria-label="Search vehicle auctions" />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-status">
            <span className="live-dot" />
            <div><strong>Official source</strong><small>{sourceMeta.status === "live" ? "Hourly feed" : "Snapshot fallback"}</small></div>
          </div>
          <button className="icon-button" type="button" aria-label="Notifications"><Bell size={18} /><span className="notification-dot" /></button>
          <div className="avatar">ZK</div>
        </header>

        <div className="page-wrap">
          <section className="page-intro">
            <div>
              <p className="eyebrow"><span /> Official GSA vehicle intelligence</p>
              <h1>The deal board</h1>
              <p>Every active vehicle, ranked by projected-close economics—not an artificially low early bid.</p>
            </div>
            <div className="intro-actions">
              <button type="button" className="refresh-button" onClick={refreshSnapshot} disabled={refreshing}>
                <RefreshCw size={16} className={refreshing ? "spin" : ""} /> {refreshing ? "Checking…" : "Refresh view"}
              </button>
              <button type="button" className="filter-button" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={16} /> Filters</button>
            </div>
          </section>

          <section className="metric-grid" aria-label="Auction intelligence summary">
            <article>
              <div className="metric-icon blue"><CarFront size={18} /></div>
              <div><span>Tracked opportunities</span><strong>{auctions.length}</strong><small>Official GSA vehicle lots</small></div>
              <em>{sourceMeta.mode === "official-hourly-feed" ? "Live hourly discovery" : "Last-known snapshot"}</em>
            </article>
            <article>
              <div className="metric-icon green"><CircleDollarSign size={18} /></div>
              <div><span>Modeled headroom</span><strong>{dollars(totalHeadroom)}</strong><small>Across active shortlist</small></div>
              <em>After risk reserves</em>
            </article>
            <article>
              <div className="metric-icon violet"><TrendingUp size={18} /></div>
              <div><span>Median value gap</span><strong>{Math.round(medianDiscount * 100)}%</strong><small>At projected close</small></div>
              <em>Reference-only</em>
            </article>
            <article>
              <div className="metric-icon amber"><Clock3 size={18} /></div>
              <div><span>Closing room</span><strong>{closingCount}</strong><small>Inside 30 minutes</small></div>
              <em className={closingCount ? "urgent-copy" : ""}>{closingCount ? "Adaptive watch" : "No urgent lots"}</em>
            </article>
          </section>

          <section className="source-notice">
            <ShieldCheck size={18} />
            <div>
              <strong>Evidence-aware by design</strong>
              <span>Market values are demo references until a licensed KBB, Black Book, J.D. Power, or other provider is connected. Current GSA bids never substitute for vehicle value.</span>
            </div>
            <a href="#source-health">View source ledger <ArrowRight size={14} /></a>
          </section>

          <section className="board-toolbar">
            <div className="quick-filters" role="tablist" aria-label="Opportunity views">
              {([
                ["all", "Best deals"],
                ["closing", "Closing soon"],
                ["high-confidence", "High confidence"],
                ["under-10k", "Under $10k"],
                ["trucks", "Trucks"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" className={quickFilter === value ? "active" : ""} onClick={() => setQuickFilter(value)}>{label}</button>
              ))}
            </div>
            <div className="board-controls">
              <label className="sort-select"><ArrowDownUp size={15} /><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort auctions"><option value="deal">Best deal</option><option value="ending">Ending soon</option><option value="profit">Highest profit</option><option value="bid">Lowest bid</option></select><ChevronDown size={14} /></label>
              <div className="view-switch" aria-label="View style"><button type="button" className={!compact ? "active" : ""} onClick={() => setCompact(false)} aria-label="Card view"><Grid2X2 size={16} /></button><button type="button" className={compact ? "active" : ""} onClick={() => setCompact(true)} aria-label="Compact view"><List size={17} /></button></div>
            </div>
          </section>

          <div className="result-line"><strong>{opportunities.length} opportunities</strong><span>Sorted by projected-close Deal Score</span></div>

          <section className={`opportunity-list ${compact ? "compact-list" : ""}`}>
            {opportunities.map((auction) => (
              <OpportunityCard key={auction.id} auction={auction} now={now} saved={saved.has(auction.id)} onSave={() => toggleSaved(auction.id)} compact={compact} />
            ))}
            {!opportunities.length && (
              <div className="empty-state"><Search size={28} /><h2>No vehicles match these filters</h2><p>Clear a filter or widen the bid range to bring opportunities back into view.</p><button type="button" onClick={() => { setQuery(""); setQuickFilter("all"); setStateFilter("all"); setConditionFilter("all"); setMaxBid(""); }}>Reset filters</button></div>
            )}
          </section>

          <footer className="site-footer">
            <div><strong>BidAI Pro</strong><span>Independent research tool · Not affiliated with or endorsed by the U.S. General Services Administration.</span></div>
            <p>Verify all facts, terms, bid amounts, and closing times on the official GSA listing before bidding. BidAI Pro does not place bids.</p>
          </footer>
        </div>
      </main>

      {filtersOpen && (
        <div className="filter-backdrop" role="presentation" onMouseDown={() => setFiltersOpen(false)}>
          <section className="filter-panel" role="dialog" aria-modal="true" aria-labelledby="filter-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="filter-header"><div><p>Opportunity controls</p><h2 id="filter-title">Refine the board</h2></div><button type="button" className="icon-button" onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X /></button></div>
            <label><span>State</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="all">All states</option>{states.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
            <label><span>Condition</span><select value={conditionFilter} onChange={(event) => setConditionFilter(event.target.value)}><option value="all">All conditions</option>{conditions.map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></label>
            <label><span>Maximum current bid</span><div className="money-input"><span>$</span><input inputMode="numeric" value={maxBid} onChange={(event) => setMaxBid(event.target.value.replace(/\D/g, ""))} placeholder="No maximum" /></div></label>
            <div className="filter-summary"><Settings2 size={16} /><span>Cost profile</span><strong>Standard buyer · 12% risk reserve</strong></div>
            <div className="filter-actions"><button type="button" onClick={() => { setStateFilter("all"); setConditionFilter("all"); setMaxBid(""); }}>Reset</button><button type="button" className="apply" onClick={() => setFiltersOpen(false)}>Show {opportunities.length} vehicles</button></div>
          </section>
        </div>
      )}

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <a className={quickFilter === "all" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("all")}><LayoutDashboard size={19} /><span>Deals</span></a>
        <a className={quickFilter === "closing" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("closing")}><Clock3 size={19} /><span>Closing</span></a>
        <a className={quickFilter === "saved" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("saved")}><Bookmark size={19} /><span>Saved</span></a>
        <button type="button" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={19} /><span>Filters</span></button>
      </nav>
    </div>
  );
}
