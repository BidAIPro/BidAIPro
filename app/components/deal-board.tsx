"use client";

import {
  Activity,
  AlertTriangle,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuctionOpportunity, ValuationReference } from "../../lib/auction-types";
import { applyLiveBidSnapshot, type LiveBidSnapshot } from "../../lib/live-bid-snapshot";
import { applyValuationToOpportunity } from "../../lib/opportunity-adapter";
import { publicApiUrl } from "../../lib/public-api";
import { getRefreshDecision } from "../../lib/refresh-policy";
import { MarketValueEvidence } from "./market-reference-links";
import { VehicleGallery } from "./vehicle-gallery";

type SortKey = "deal" | "ending" | "profit" | "bid";
type QuickFilter = "all" | "closing" | "trucks" | "high-confidence" | "under-10k" | "saved";

type MarketValueResponse = {
  data?: Array<{
    externalId: string;
    valuation: ValuationReference;
    cacheStatus: "fresh" | "refreshed" | "unavailable";
  }>;
  meta?: {
    requested?: number;
    resolved?: number;
    refreshed?: number;
    generatedAt?: string;
  };
  errors?: Array<{ externalId: string; code: string }>;
};

const MARKET_VALUE_BATCH_SIZE = 12;
const MARKET_VALUE_REFRESH_MS = 55 * 60_000;

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

function odometerStatusLabel(status: AuctionOpportunity["vehicle"]["odometerStatus"]) {
  if (status === "conflicting-readings") return "Conflicting GSA readings";
  if (status === "not-reported") return "Not reported";
  return "GSA reported · verify";
}

function timeLeft(endsAt: string | null, now: number) {
  if (!endsAt) {
    return { label: "Time unavailable", urgent: false, seconds: Number.POSITIVE_INFINITY };
  }
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

function scoreLabel(score: number, status: AuctionOpportunity["assessment"]["status"]) {
  if (status === "insufficient") return "Unscored";
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

function DealScore({ score, status }: { score: number; status: AuctionOpportunity["assessment"]["status"] }) {
  const bounded = Math.max(0, Math.min(100, score));
  const unscored = status === "insufficient";
  return (
    <div className="deal-score" style={{ "--score": `${bounded * 3.6}deg` } as CSSProperties}>
      <div>
        <strong>{unscored ? "—" : bounded}</strong>
        <span>{unscored ? "pending" : "/100"}</span>
      </div>
    </div>
  );
}

function PollingLabel({
  auction,
  now,
  livePollingAvailable,
}: {
  auction: AuctionOpportunity;
  now: number;
  livePollingAvailable: boolean;
}) {
  if (!livePollingAvailable) {
    return <span className="poll-label"><AlertTriangle size={13} /> Snapshot only · verify bid</span>;
  }
  if (!auction.id.startsWith("live-")) {
    return <span className="poll-label"><Activity size={13} /> Reference snapshot</span>;
  }
  if (!auction.endsAt) {
    return <span className="poll-label"><Activity size={13} /> Hourly checks</span>;
  }
  const decision = getRefreshDecision({
    now,
    endsAt: auction.endsAt,
    lastCheckedAt: auction.lastCheckedAt,
    status: auction.status,
  });
  const cadence = decision.intervalMs === null
    ? "Final status captured"
    : decision.intervalMs <= 15_000
      ? "15 sec checks"
      : decision.intervalMs <= 30_000
        ? "30 sec checks"
        : decision.intervalMs <= 5 * 60_000
          ? "5 min checks"
          : "Hourly checks";
  return (
    <span className="poll-label">
      <Activity size={13} /> {cadence}
    </span>
  );
}

function OpportunityCard({
  auction,
  now,
  saved,
  onSave,
  compact,
  livePollingAvailable,
  marketValueLoading,
}: {
  auction: AuctionOpportunity;
  now: number;
  saved: boolean;
  onSave: () => void;
  compact: boolean;
  livePollingAvailable: boolean;
  marketValueLoading: boolean;
}) {
  const countdown = timeLeft(auction.endsAt, now);
  const currentBid = auction.currentBidCents;
  const marketValue = auction.valuation.medianCents;
  const predictedClose = auction.forecast.expectedCents;
  const safeMax = auction.assessment.safeMaxBidCents;
  const allInNow = currentBid === null ? null : auction.assessment.allInAtCurrentBidCents;
  const addedCostsNow = currentBid === null || allInNow === null ? null : Math.max(0, allInNow - currentBid);
  const headroom = marketValue === null ? null : marketValue - auction.assessment.allInAtCurrentBidCents;
  const headroomPct = marketValue && headroom !== null ? Math.max(0, Math.min(100, (headroom / marketValue) * 100)) : 0;
  const primaryReason = auction.assessment.reasonCodes[0]?.replaceAll("_", " ") ?? "Review source evidence";
  const issueSummary = auction.vehicle.riskFlags.length
    ? `${auction.vehicle.riskFlags.slice(0, 2).join(" · ")}${auction.vehicle.riskFlags.length > 2 ? ` · +${auction.vehicle.riskFlags.length - 2} more` : ""}`
    : "No structured damage disclosed; verify photos, description, and inspection.";

  return (
    <article className={`opportunity-card ${compact ? "is-compact" : ""}`}>
      <div className="vehicle-media">
        <VehicleGallery
          images={[auction.imageUrl, ...(auction.images ?? [])]}
          title={auction.title}
          fallbackTitle={`${auction.vehicle.year} ${auction.vehicle.make}`}
          fallbackCopy="Official photo unavailable here; open the GSA listing for its gallery."
          variant="card"
        />
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
              <span><MapPin size={14} /> {auction.location.city}, {auction.location.state}</span>
              <span><CarFront size={14} /> {auction.vehicle.drivetrain ?? auction.vehicle.bodyStyle ?? "Vehicle"}</span>
            </div>
          </div>
          <div className="score-lockup">
            <DealScore score={auction.assessment.score} status={auction.assessment.status} />
            <div><strong>{scoreLabel(auction.assessment.score, auction.assessment.status)}</strong><span>{Math.round(auction.assessment.confidence * 100)}% confidence</span></div>
          </div>
        </div>

        <div className="critical-facts" aria-label="Mileage and condition summary">
          <div className={`mileage-fact ${auction.vehicle.mileage === null || auction.vehicle.mileage === undefined ? "is-unknown" : ""}`}>
            <Gauge size={19} aria-hidden="true" />
            <span><small>Odometer mileage</small><strong>{formatMileage(auction.vehicle.mileage)}</strong><em className={`odometer-status ${auction.vehicle.odometerStatus === "conflicting-readings" ? "has-conflict" : ""}`}>{odometerStatusLabel(auction.vehicle.odometerStatus)}</em></span>
          </div>
          <div className="condition-fact">
            <CarFront size={18} aria-hidden="true" />
            <span><small>Condition / operability</small><strong>{auction.vehicle.condition} · {auction.vehicle.operability}</strong></span>
          </div>
        </div>

        <div className={`issue-disclosure ${auction.vehicle.riskFlags.length ? "has-issues" : ""}`}>
          <AlertTriangle size={15} aria-hidden="true" />
          <div><strong>Damage &amp; issues</strong><span>{issueSummary}</span></div>
        </div>

        <div className="price-stack">
          <div>
            <span>Current bid · before costs</span>
            <strong>{dollars(currentBid)}</strong>
            <small>{auction.bidderCount === null ? "GSA bid only; bidders unavailable" : `GSA bid only · ${auction.bidderCount} bidders`}</small>
          </div>
          <div>
            <span>Projected close · before costs</span>
            <strong>{dollars(predictedClose)}</strong>
            <small>{auction.forecast.lowCents !== null && auction.forecast.highCents !== null ? `${dollars(auction.forecast.lowCents)}–${dollars(auction.forecast.highCents)}` : "More evidence needed"}</small>
          </div>
          <div>
            <span>Adjusted market value</span>
            <strong>{marketValue === null ? marketValueLoading ? "Pulling…" : "Unavailable" : dollars(marketValue)}</strong>
            <small>{marketValue === null ? "Automatic numeric lookup" : `${auction.valuation.provider} · ${auction.valuation.sampleSize} observations`}</small>
          </div>
          <div className="all-in-metric">
            <span>Modeled all-in now</span>
            <strong>{dollars(allInNow)}</strong>
            <small>{addedCostsNow === null ? "Added costs unavailable" : `Bid + ${dollars(addedCostsNow)} modeled costs`}</small>
          </div>
        </div>

        <MarketValueEvidence auction={auction} compact loading={marketValueLoading} />

        <div className="headroom-row">
          <div className="headroom-copy">
            <span>Risk-adjusted headroom now</span>
            <strong className={headroom !== null && headroom >= 0 ? "positive-text" : "negative-text"}>{dollars(headroom)}</strong>
          </div>
          <div className="headroom-track" aria-label={`${Math.round(headroomPct)} percent headroom`}>
            <span style={{ width: `${headroomPct}%` }} />
          </div>
          <span className="reason-chip"><Sparkles size={13} /> Safe bid {dollars(safeMax)} before costs · {primaryReason}</span>
        </div>

        <div className="evidence-row">
          <div>
            <span className="evidence-chip"><Database size={13} /> {auction.forecast.sampleSize} GSA comps</span>
            <span className="evidence-chip"><ShieldCheck size={13} /> VIN {auction.vehicle.vin ? "captured" : "pending"}</span>
            <PollingLabel auction={auction} now={now} livePollingAvailable={livePollingAvailable} />
          </div>
          <div className="card-actions">
            <span className="freshness">Checked {relativeTime(auction.lastCheckedAt, now)}</span>
            <Link href={`/vehicle/?id=${encodeURIComponent(auction.id)}`} className="secondary-button">Full analysis <ArrowRight size={15} /></Link>
            <a href={auction.sourceUrl} target="_blank" rel="noreferrer" className="primary-button">View at GSA <ExternalLink size={15} /></a>
          </div>
        </div>
      </div>
    </article>
  );
}

export function DealBoard() {
  const [now, setNow] = useState(() => Date.now());
  const [auctions, setAuctions] = useState<AuctionOpportunity[]>([]);
  const [sourceMeta, setSourceMeta] = useState({
    mode: "loading",
    status: "checking",
    vehicleLots: 0,
    liveBidPolling: false,
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
  const [marketValueLoadingIds, setMarketValueLoadingIds] = useState<Set<string>>(() => new Set());
  const [marketValueRefreshActive, setMarketValueRefreshActive] = useState(false);
  const opportunityRequest = useRef<AbortController | null>(null);
  const marketValueRequest = useRef<AbortController | null>(null);
  const marketValueAttempts = useRef<Map<string, number>>(new Map());
  const liveBidRequests = useRef<Map<string, AbortController>>(new Map());
  const liveBidAttempts = useRef<Map<string, number>>(new Map());

  const loadMarketValues = useCallback(async (opportunities: readonly AuctionOpportunity[]) => {
    const checkedAt = Date.now();
    const pending = opportunities.filter((auction) => {
      const previousAttempt = marketValueAttempts.current.get(auction.externalId) ?? 0;
      return auction.status === "active" && checkedAt - previousAttempt >= MARKET_VALUE_REFRESH_MS;
    });
    if (!pending.length) return;

    if (marketValueRequest.current) return;
    const controller = new AbortController();
    marketValueRequest.current = controller;
    const pendingIds = new Set(pending.map((auction) => auction.externalId));
    setMarketValueLoadingIds((current) => new Set([...current, ...pendingIds]));
    setMarketValueRefreshActive(true);

    try {
      for (let index = 0; index < pending.length; index += MARKET_VALUE_BATCH_SIZE) {
        const batch = pending.slice(index, index + MARKET_VALUE_BATCH_SIZE);
        const externalIds = batch.map((auction) => auction.externalId);
        for (const externalId of externalIds) marketValueAttempts.current.set(externalId, checkedAt);

        try {
          const response = await fetch(
            publicApiUrl(`/api/market-values?ids=${encodeURIComponent(externalIds.join(","))}`),
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error(`Market value feed returned ${response.status}`);
          const payload = await response.json() as MarketValueResponse;
          if (!Array.isArray(payload.data)) throw new Error("Market value feed omitted its data array");
          const byExternalId = new Map(payload.data.map((item) => [item.externalId, item.valuation]));
          const calculatedAt = payload.meta?.generatedAt ?? new Date().toISOString();

          setAuctions((current) => current.map((auction) => {
            const valuation = byExternalId.get(auction.externalId);
            return valuation && !(
              valuation.status === "unavailable" &&
              auction.valuation.status !== "unavailable"
            )
              ? applyValuationToOpportunity(auction, valuation, calculatedAt)
              : auction;
          }));
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
          // A transient batch failure should be eligible for the next manual or
          // scheduled refresh instead of becoming a one-session dead end.
          for (const externalId of externalIds) marketValueAttempts.current.delete(externalId);
        } finally {
          setMarketValueLoadingIds((current) => {
            const next = new Set(current);
            for (const externalId of externalIds) next.delete(externalId);
            return next;
          });
        }
      }
    } finally {
      if (marketValueRequest.current === controller) {
        marketValueRequest.current = null;
        setMarketValueRefreshActive(false);
        setMarketValueLoadingIds((current) => {
          const next = new Set(current);
          for (const externalId of pendingIds) next.delete(externalId);
          return next;
        });
      }
    }
  }, []);

  const loadOpportunities = useCallback(async () => {
    opportunityRequest.current?.abort();
    const controller = new AbortController();
    opportunityRequest.current = controller;
    setRefreshing(true);

    try {
      const response = await fetch(publicApiUrl("/api/opportunities"), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Opportunity feed returned ${response.status}`);
      const payload = await response.json() as {
        data?: AuctionOpportunity[];
        meta?: {
          mode?: string;
          coverage?: { vehicleLots?: number } | null;
          sourceHealth?: { status?: string; liveBidPolling?: boolean } | null;
        };
      };
      if (!Array.isArray(payload.data)) throw new Error("Opportunity feed omitted its data array");

      setAuctions((current) => {
        const existing = new Map(current.map((auction) => [auction.id, auction]));
        return payload.data!.map((fresh) => {
          const newer = existing.get(fresh.id);
          let merged = !newer || Date.parse(newer.lastCheckedAt) <= Date.parse(fresh.lastCheckedAt)
            ? fresh
            : {
                ...fresh,
                status: newer.status,
                currentBidCents: newer.currentBidCents,
                bidderCount: newer.bidderCount,
                endsAt: newer.endsAt,
                lastCheckedAt: newer.lastCheckedAt,
                assessment: newer.assessment,
              };
          if (
            newer &&
            newer.valuation.status !== "unavailable" &&
            merged.valuation.status === "unavailable"
          ) {
            merged = applyValuationToOpportunity(
              merged,
              newer.valuation,
              merged.lastCheckedAt,
            );
          }
          return merged;
        });
      });
      void loadMarketValues(payload.data);
      setSourceMeta({
        mode: payload.meta?.mode ?? "unknown",
        status: payload.meta?.sourceHealth?.status ?? "unknown",
        vehicleLots: payload.meta?.coverage?.vehicleLots ?? payload.data.length,
        liveBidPolling: payload.meta?.sourceHealth?.liveBidPolling === true,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setSourceMeta((current) => ({
        ...current,
        mode: "last-known-client-snapshot",
        status: "unavailable",
        liveBidPolling: false,
      }));
    } finally {
      if (opportunityRequest.current === controller) setRefreshing(false);
    }
  }, [loadMarketValues]);

  const loadLiveBid = useCallback(async (auction: AuctionOpportunity) => {
    if (!auction.id.startsWith("live-") || !/^\d+$/.test(auction.externalId)) return;
    if (liveBidRequests.current.has(auction.id)) return;

    const controller = new AbortController();
    liveBidRequests.current.set(auction.id, controller);
    liveBidAttempts.current.set(auction.id, Date.now());
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
      setAuctions((current) => current.map((item) =>
        item.id === auction.id ? applyLiveBidSnapshot(item, payload.data!) : item
      ));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
    } finally {
      if (liveBidRequests.current.get(auction.id) === controller) {
        liveBidRequests.current.delete(auction.id);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadOpportunities(), 0);
    const timer = window.setInterval(() => void loadOpportunities(), 60 * 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
      opportunityRequest.current?.abort();
    };
  }, [loadOpportunities]);

  useEffect(() => {
    if (!sourceMeta.liveBidPolling) return;
    function refreshDueClosingAuctions() {
      const checkedAt = Date.now();
      for (const auction of auctions) {
        if (!auction.id.startsWith("live-") || !auction.endsAt) continue;
        const remainingMs = Date.parse(auction.endsAt) - checkedAt;
        // The complete catalog refresh handles the normal hourly bucket. Only
        // closing vehicles receive isolated, higher-frequency source checks.
        if (remainingMs > 30 * 60_000) continue;
        const decision = getRefreshDecision({
          now: checkedAt,
          endsAt: auction.endsAt,
          lastCheckedAt: auction.lastCheckedAt,
          status: auction.status,
        });
        if (!decision.shouldRefresh || decision.intervalMs === null) continue;
        const lastAttempt = liveBidAttempts.current.get(auction.id) ?? 0;
        if (checkedAt - lastAttempt < Math.max(10_000, decision.intervalMs - 1_000)) continue;
        void loadLiveBid(auction);
      }
    }

    refreshDueClosingAuctions();
    const timer = window.setInterval(refreshDueClosingAuctions, 5_000);
    return () => window.clearInterval(timer);
  }, [auctions, loadLiveBid, sourceMeta.liveBidPolling]);

  useEffect(() => () => {
    marketValueRequest.current?.abort();
    marketValueRequest.current = null;
    for (const controller of liveBidRequests.current.values()) controller.abort();
    liveBidRequests.current.clear();
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
      if (maxBidCents !== null && (auction.currentBidCents === null || auction.currentBidCents > maxBidCents)) return false;
      if (quickFilter === "closing") {
        if (!auction.endsAt) return false;
        const remaining = new Date(auction.endsAt).getTime() - now;
        if (remaining < 0 || remaining > 30 * 60_000) return false;
      }
      if (quickFilter === "trucks" && !`${auction.vehicle.bodyStyle ?? ""} ${auction.title}`.toLowerCase().match(/truck|pickup|silverado|ram|f-?2/)) return false;
      if (
        quickFilter === "high-confidence" &&
        (auction.valuation.status === "unavailable" || auction.valuation.confidence < 0.7)
      ) return false;
      if (quickFilter === "under-10k" && (auction.currentBidCents === null || auction.currentBidCents > 1_000_000)) return false;
      if (quickFilter === "saved" && !saved.has(auction.id)) return false;
      return auction.status === "active";
    });

    return result.sort((a, b) => {
      if (sort === "ending") return (a.endsAt ? new Date(a.endsAt).getTime() : Number.POSITIVE_INFINITY) - (b.endsAt ? new Date(b.endsAt).getTime() : Number.POSITIVE_INFINITY);
      if (sort === "profit") return (b.assessment.projectedProfitCents ?? -Infinity) - (a.assessment.projectedProfitCents ?? -Infinity);
      if (sort === "bid") return (a.currentBidCents ?? Number.POSITIVE_INFINITY) - (b.currentBidCents ?? Number.POSITIVE_INFINITY);
      return b.assessment.score - a.assessment.score;
    });
  }, [auctions, conditionFilter, maxBid, now, query, quickFilter, saved, sort, stateFilter]);

  const profitEvidence = auctions
    .map((item) => item.assessment.projectedProfitCents)
    .filter((value): value is number => value !== null);
  const totalHeadroom = profitEvidence.length
    ? profitEvidence.reduce((sum, value) => sum + Math.max(0, value), 0)
    : null;
  const closingCount = auctions.filter((item) => {
    if (!item.endsAt) return false;
    const remaining = new Date(item.endsAt).getTime() - now;
    return remaining >= 0 && remaining <= 30 * 60_000;
  }).length;
  const discountEvidence = auctions
    .map((item) => item.assessment.discountToValue)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const medianDiscount = discountEvidence.length
    ? discountEvidence[Math.floor(discountEvidence.length / 2)]!
    : null;
  const marketValuedCount = auctions.filter((auction) =>
    auction.valuation.status !== "unavailable" && auction.valuation.medianCents !== null
  ).length;

  function toggleSaved(id: string) {
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function refreshSnapshot() {
    setNow(Date.now());
    void loadOpportunities();
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
          <Link href="/comps"><Database size={18} /> Comp ledger</Link>
          <a href="#source-health"><HeartPulse size={18} /> Data health</a>
        </nav>

        <div className="source-health-card" id="source-health">
          <div><Activity size={16} /><span>Source health</span><strong>{sourceMeta.status === "live" ? "Operational" : sourceMeta.status === "checking" ? "Checking" : "Snapshot"}</strong></div>
          <p>{sourceMeta.status === "live" ? `Official GSA catalog delivered ${sourceMeta.vehicleLots} vehicle lots.` : `${sourceMeta.vehicleLots || "Last-known"} official vehicle records are visible. Verify every current bid at GSA.`}</p>
          <div className={`health-meter ${sourceMeta.status === "live" ? "" : "is-stale"}`}><span /></div>
          <small>{sourceMeta.liveBidPolling ? "Hourly discovery · adaptive closing checks" : "Static snapshot · live bid refresh unavailable"}</small>
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
            <span className={`live-dot ${sourceMeta.status === "live" ? "" : "is-stale"}`} />
            <div><strong>Official source</strong><small>{sourceMeta.liveBidPolling ? "Live source checks" : "Snapshot · verify bids"}</small></div>
          </div>
          <button className="icon-button" type="button" aria-label="Notifications"><Bell size={18} /><span className="notification-dot" /></button>
          <div className="avatar">ZK</div>
        </header>

        <div className="page-wrap">
          <section className="page-intro">
            <div>
              <p className="eyebrow"><span /> Official GSA vehicle intelligence</p>
              <h1>The deal board</h1>
              <p>Every active vehicle in one underwriting queue. Deal Scores activate only when independent value and comparable evidence are available.</p>
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
              <em>{sourceMeta.liveBidPolling ? "Live source checks" : sourceMeta.status === "checking" ? "Checking official source" : "Snapshot · verify bids"}</em>
            </article>
            <article>
              <div className="metric-icon green"><CircleDollarSign size={18} /></div>
              <div><span>Modeled headroom</span><strong>{dollars(totalHeadroom)}</strong><small>{marketValuedCount} of {auctions.length} vehicles valued</small></div>
              <em>{marketValueRefreshActive ? "Pulling market values…" : totalHeadroom === null ? "Awaiting numeric evidence" : "After risk reserves"}</em>
            </article>
            <article>
              <div className="metric-icon violet"><TrendingUp size={18} /></div>
              <div><span>Median value gap</span><strong>{medianDiscount === null ? "—" : `${Math.round(medianDiscount * 100)}%`}</strong><small>{medianDiscount === null ? "Verified value required" : "At projected close"}</small></div>
              <em>{medianDiscount === null ? "Not yet scored" : "Reference-only"}</em>
            </article>
            <article>
              <div className="metric-icon amber"><Clock3 size={18} /></div>
              <div><span>Closing room</span><strong>{closingCount}</strong><small>Inside 30 minutes</small></div>
              <em className={closingCount ? "urgent-copy" : ""}>{closingCount ? "Verify live at GSA" : "No urgent lots"}</em>
            </article>
          </section>

          <section className="source-notice">
            <ShieldCheck size={18} />
            <div>
              <strong>Automatic market pricing</strong>
              <span>{marketValueRefreshActive
                ? `Pulling numeric market evidence automatically for ${marketValueLoadingIds.size} vehicles. Each result shows its provider, range, mileage adjustment, sample size, as-of date, and confidence.`
                : `${marketValuedCount} of ${auctions.length} active vehicles currently have automatic numeric market evidence. Source and confidence remain visible beside every value.`}</span>
            </div>
            <a href="#source-health">View source ledger <ArrowRight size={14} /></a>
          </section>

          {!sourceMeta.liveBidPolling && sourceMeta.status !== "checking" && (
            <section className="source-notice snapshot-warning">
              <AlertTriangle size={18} />
              <div>
                <strong>Current bids are snapshot values</strong>
                <span>This host cannot reach GSA&apos;s live bid service. Check the official auction before acting; the displayed bid may have changed since the listed check time.</span>
              </div>
              <a href="https://gsaauctions.gov/auctions/auctions-list" target="_blank" rel="noreferrer">Verify at GSA <ExternalLink size={14} /></a>
            </section>
          )}

          <section className="source-notice comp-ledger-notice" id="comp-ledger">
            <Database size={18} />
            <div>
              <strong>Comparable ledger</strong>
              <span>This installation records closed high bids after two confirmed catalog misses; award price remains unknown until an authoritative outcome source confirms it. Historical bulk backfill is not active.</span>
            </div>
            <Link href="/comps">Open ledger <ArrowRight size={14} /></Link>
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

          <div className="result-line"><strong>{opportunities.length} opportunities</strong><span>Deal Score order; insufficient-evidence rows remain unscored</span></div>

          <section className={`opportunity-list ${compact ? "compact-list" : ""}`}>
            {opportunities.map((auction) => (
              <OpportunityCard key={auction.id} auction={auction} now={now} saved={saved.has(auction.id)} onSave={() => toggleSaved(auction.id)} compact={compact} livePollingAvailable={sourceMeta.liveBidPolling} marketValueLoading={marketValueLoadingIds.has(auction.externalId)} />
            ))}
            {!opportunities.length && (
              <div className="empty-state"><Search size={28} /><h2>{sourceMeta.status === "checking" ? "Checking the official GSA catalog" : auctions.length === 0 ? "No active vehicle lots are available" : "No vehicles match these filters"}</h2><p>{auctions.length === 0 ? "The board will populate when the official source or a still-active reference snapshot is available." : "Clear a filter or widen the bid range to bring opportunities back into view."}</p><button type="button" onClick={() => { setQuery(""); setQuickFilter("all"); setStateFilter("all"); setConditionFilter("all"); setMaxBid(""); }}>Reset filters</button></div>
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
