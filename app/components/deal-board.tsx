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
import { fetchGsaRunnerSnapshot } from "../../lib/gsa-runner-snapshot";
import { applyLiveBidSnapshot, type LiveBidSnapshot } from "../../lib/live-bid-snapshot";
import { applyValuationToOpportunity, discoveryToOpportunity } from "../../lib/opportunity-adapter";
import { mergeOpportunityFeed } from "../../lib/opportunity-feed";
import { closeForecastEvidenceLabel, valuationEvidenceCountLabel } from "../../lib/evidence-labels";
import { publicApiUrl } from "../../lib/public-api";
import { getRefreshDecision } from "../../lib/refresh-policy";
import {
  auctionMatchesState,
  buildStateFilterOptions,
  countAdvancedBoardFilters,
} from "./deal-board-filters";
import { MarketValueEvidence } from "./market-reference-links";
import { VehicleGallery } from "./vehicle-gallery";

type SortKey = "deal" | "ending" | "confidence" | "profit" | "bid";
type QuickFilter = "all" | "coming" | "closing" | "trucks" | "high-confidence" | "under-10k" | "saved";
type BoardSource = "gsa-auctions" | "gsa-fleet";
type PollingBySource = Record<BoardSource, boolean>;

type SourceHealthMeta = {
  status?: string;
  liveBidPolling?: boolean;
  liveBidPollingBySource?: Partial<Record<BoardSource, boolean>>;
};

const SORT_OPTIONS: ReadonlyArray<{
  value: SortKey;
  label: string;
  orderCopy: string;
}> = [
  { value: "deal", label: "Best deal", orderCopy: "Deal Score order" },
  { value: "ending", label: "Ending soon", orderCopy: "Closing-time order" },
  { value: "confidence", label: "Highest confidence", orderCopy: "Confidence order" },
  { value: "profit", label: "Highest profit", orderCopy: "Projected-profit order" },
  { value: "bid", label: "Lowest bid", orderCopy: "Current-bid order" },
];

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
const MARKET_VALUE_REQUEST_TIMEOUT_MS = 10_000;
const LIVE_BID_REQUEST_TIMEOUT_MS = 10_000;
const OPPORTUNITY_REQUEST_TIMEOUT_MS = 35_000;
const PUBLISHED_SNAPSHOT_TIMEOUT_MS = 6_000;
const PHOTOS_RETRY_INTERVAL_MS = 2 * 60_000;
const FOCUS_REFRESH_MINIMUM_AGE_MS = 60_000;
const INITIAL_RENDER_LIMIT = 48;
const RENDER_LIMIT_INCREMENT = 48;

const NO_LIVE_POLLING: PollingBySource = {
  "gsa-auctions": false,
  "gsa-fleet": false,
};

function boardSource(auction: AuctionOpportunity): BoardSource {
  return String(auction.source) === "gsa-fleet" ? "gsa-fleet" : "gsa-auctions";
}

function sourceLabel(auction: AuctionOpportunity) {
  return boardSource(auction) === "gsa-fleet" ? "GSA Fleet Marketplace" : "GSA Auctions";
}

function sourceSaleType(auction: AuctionOpportunity) {
  return auction.saleType ?? "unknown";
}

function isScheduledLiveSale(auction: AuctionOpportunity) {
  const saleType = sourceSaleType(auction);
  return boardSource(auction) === "gsa-fleet" &&
    auction.status === "preview" &&
    (saleType === "live" || auction.onlineBidding === false);
}

function canPollAuction(auction: AuctionOpportunity) {
  if (auction.status !== "active") return false;
  if (boardSource(auction) === "gsa-fleet") {
    const saleType = sourceSaleType(auction);
    return Boolean(auction.vehicle.vin) &&
      auction.onlineBidding !== false &&
      (saleType === "internet" || saleType === "unknown");
  }
  return auction.id.startsWith("live-") && /^\d+$/.test(auction.externalId);
}

function livePollingForAuction(
  auction: AuctionOpportunity,
  liveBidPollingBySource: PollingBySource,
) {
  return canPollAuction(auction) && liveBidPollingBySource[boardSource(auction)];
}

function pollingAvailability(meta: SourceHealthMeta | null | undefined): PollingBySource {
  const bySource = meta?.liveBidPollingBySource;
  if (bySource) {
    return {
      "gsa-auctions": bySource["gsa-auctions"] === true,
      "gsa-fleet": bySource["gsa-fleet"] === true,
    };
  }
  // Older opportunity feeds only exposed one GSA Auctions polling flag.
  return {
    "gsa-auctions": meta?.liveBidPolling === true,
    "gsa-fleet": false,
  };
}

function hasNumericValuation(auction: AuctionOpportunity) {
  return auction.valuation.status !== "unavailable" && auction.valuation.medianCents !== null;
}

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

async function publishedSnapshotOpportunities(): Promise<{
  data: AuctionOpportunity[];
  generatedAt: string;
  imagesFresh: boolean;
  imageExpiresAt: string;
}> {
  const snapshot = await fetchGsaRunnerSnapshot({ timeoutMs: PUBLISHED_SNAPSHOT_TIMEOUT_MS });
  const now = Date.now();
  const imagesFresh = Date.parse(snapshot.imageExpiresAt) > now;
  const activeAuctions = snapshot.auctions.filter((auction) =>
    auction.status === "active" && (
      auction.endsAt === null || Date.parse(auction.endsAt) > now
    )
  );
  return {
    data: activeAuctions.map((auction) =>
      discoveryToOpportunity(auction, snapshot.sourceHealth.observedAt)
    ),
    generatedAt: snapshot.generatedAt,
    imagesFresh,
    imageExpiresAt: snapshot.imageExpiresAt,
  };
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
  const isFleet = boardSource(auction) === "gsa-fleet";
  if (isScheduledLiveSale(auction)) {
    return <span className="poll-label"><Clock3 size={13} /> Scheduled live sale · no online bid feed</span>;
  }
  if (auction.status === "preview") {
    return <span className="poll-label"><Clock3 size={13} /> {isFleet ? "Internet bidding opens soon" : "Auction opens soon"}</span>;
  }
  if (!canPollAuction(auction)) {
    return <span className="poll-label"><Activity size={13} /> Reference snapshot</span>;
  }
  if (!livePollingAvailable) {
    return <span className="poll-label"><AlertTriangle size={13} /> Snapshot only · verify bid</span>;
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
  photosRefreshing,
}: {
  auction: AuctionOpportunity;
  now: number;
  saved: boolean;
  onSave: () => void;
  compact: boolean;
  livePollingAvailable: boolean;
  marketValueLoading: boolean;
  photosRefreshing: boolean;
}) {
  const isFleet = boardSource(auction) === "gsa-fleet";
  const isComingSoon = auction.status === "preview";
  const scheduledLiveSale = isScheduledLiveSale(auction);
  const startsAt = auction.startsAt ?? null;
  const scheduledEventUnderway = scheduledLiveSale && startsAt !== null && Date.parse(startsAt) <= now;
  const countdown = timeLeft(auction.endsAt, now);
  const eventCountdown = isComingSoon && startsAt ? timeLeft(startsAt, now) : countdown;
  const sourceName = sourceLabel(auction);
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
          fallbackCopy={`Official photo unavailable here; open the ${sourceName} listing for its gallery.`}
          variant="card"
          lazyGalleryUrl={isFleet && auction.vehicle.vin && auction.saleNumber
            ? publicApiUrl(`/api/gsa/fleet/vehicle?vin=${encodeURIComponent(auction.vehicle.vin)}&saleNumber=${encodeURIComponent(auction.saleNumber)}`)
            : undefined}
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
        <div className={`countdown ${!isComingSoon && eventCountdown.urgent ? "urgent" : ""}`}>
          <Clock3 size={15} />
          <span>{scheduledEventUnderway ? "Sale status" : scheduledLiveSale ? "Sale in" : isComingSoon ? "Opens in" : "Closes in"}</span>
          <strong>{scheduledEventUnderway ? "Underway · verify" : eventCountdown.label}</strong>
        </div>
        <span className="image-source">{
          auction.imageUrl
            ? photosRefreshing ? "Official photo · renewal pending" : `Official ${sourceName} image`
            : photosRefreshing ? "Photos temporarily refreshing" : `Open photos at ${isFleet ? "GSA Fleet" : "GSA Auctions"}`
        }</span>
      </div>

      <div className="vehicle-content">
        <div className="vehicle-heading">
          <div>
            <div className="lot-line">
              <span>{sourceName}</span>
              <span>•</span>
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
            <span>{scheduledLiveSale ? "Scheduled live-sale price" : "Current bid · before costs"}</span>
            <strong>{dollars(currentBid)}</strong>
            <small>{scheduledLiveSale
              ? "Bidding occurs at the live sale"
              : currentBid === null && isComingSoon
                ? "Bidding has not opened"
                : auction.bidderCount === null
                  ? `${sourceName} bid; bidders unavailable`
                  : `${sourceName} bid · ${auction.bidderCount} bidders`}</small>
          </div>
          <div>
            <span>Projected close · before costs</span>
            <strong>{dollars(predictedClose)}</strong>
            <small>{auction.forecast.lowCents !== null && auction.forecast.highCents !== null ? `${dollars(auction.forecast.lowCents)}–${dollars(auction.forecast.highCents)}` : "Needs matched close-price comps"}</small>
          </div>
          <div>
            <span>Adjusted market value</span>
            <strong>{marketValue === null ? marketValueLoading ? "Pulling…" : "Unavailable" : dollars(marketValue)}</strong>
            <small>{marketValue === null ? "Automatic numeric lookup" : `${auction.valuation.provider} · ${valuationEvidenceCountLabel(auction.valuation)}`}</small>
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
            <span
              className="evidence-chip"
              title="Comparable closed outcomes used for the projected-close forecast; separate from the market-value observations above."
            ><Database size={13} /> {closeForecastEvidenceLabel(auction.forecast)}</span>
            <span className="evidence-chip"><ShieldCheck size={13} /> VIN {auction.vehicle.vin ? "captured" : "pending"}</span>
            <PollingLabel auction={auction} now={now} livePollingAvailable={livePollingAvailable} />
          </div>
          <div className="card-actions">
            <span className="freshness">Checked {relativeTime(auction.lastCheckedAt, now)}</span>
            <Link href={`/vehicle/?id=${encodeURIComponent(auction.id)}`} className="secondary-button">Full analysis <ArrowRight size={15} /></Link>
            <a href={auction.sourceUrl} target="_blank" rel="noreferrer" className="primary-button">View at {isFleet ? "GSA Fleet" : "GSA Auctions"} <ExternalLink size={15} /></a>
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
    liveBidPollingBySource: NO_LIVE_POLLING,
    imagesFresh: null as boolean | null,
    imageExpiresAt: null as string | null,
    message: "Connecting to the official catalog and published snapshot.",
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
  const [renderWindow, setRenderWindow] = useState({ scope: "", limit: INITIAL_RENDER_LIMIT });
  const opportunityRequest = useRef<AbortController | null>(null);
  const marketValueRequest = useRef<AbortController | null>(null);
  const marketValueAttempts = useRef<Map<string, number>>(new Map());
  const liveBidRequests = useRef<Map<string, AbortController>>(new Map());
  const liveBidAttempts = useRef<Map<string, number>>(new Map());
  const lastOpportunityLoadAt = useRef(0);

  const loadMarketValues = useCallback(async (opportunities: readonly AuctionOpportunity[]) => {
    const checkedAt = Date.now();
    const pending = opportunities.filter((auction) => {
      const previousAttempt = marketValueAttempts.current.get(auction.externalId) ?? 0;
      return auction.status === "active" &&
        boardSource(auction) !== "gsa-fleet" &&
        checkedAt - previousAttempt >= MARKET_VALUE_REFRESH_MS;
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

        const batchController = new AbortController();
        const abortBatch = () => batchController.abort();
        controller.signal.addEventListener("abort", abortBatch, { once: true });
        const batchTimeout = window.setTimeout(
          () => batchController.abort(),
          MARKET_VALUE_REQUEST_TIMEOUT_MS,
        );

        try {
          const response = await fetch(
            publicApiUrl(`/api/market-values?ids=${encodeURIComponent(externalIds.join(","))}`),
            { signal: batchController.signal },
          );
          if (!response.ok) throw new Error(`Market value feed returned ${response.status}`);
          const payload = await response.json() as MarketValueResponse;
          if (!Array.isArray(payload.data)) throw new Error("Market value feed omitted its data array");
          const byExternalId = new Map(payload.data.map((item) => [item.externalId, item.valuation]));
          const calculatedAt = payload.meta?.generatedAt ?? new Date().toISOString();

          setAuctions((current) => current.map((auction) => {
            const valuation = byExternalId.get(auction.externalId);
            if (!valuation || valuation.status === "unavailable") return auction;
            if (
              hasNumericValuation(auction) &&
              valuation.confidence <= auction.valuation.confidence
            ) return auction;
            return applyValuationToOpportunity(auction, valuation, calculatedAt);
          }));
        } catch {
          if (controller.signal.aborted) return;
          // A transient batch failure should be eligible for the next manual or
          // scheduled refresh instead of becoming a one-session dead end.
          for (const externalId of externalIds) marketValueAttempts.current.delete(externalId);
        } finally {
          window.clearTimeout(batchTimeout);
          controller.signal.removeEventListener("abort", abortBatch);
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
    lastOpportunityLoadAt.current = Date.now();
    opportunityRequest.current?.abort();
    const controller = new AbortController();
    opportunityRequest.current = controller;
    setRefreshing(true);

    let primaryAccepted = false;
    const publishedSnapshot = publishedSnapshotOpportunities()
      .then((snapshot) => {
        if (
          primaryAccepted ||
          opportunityRequest.current !== controller ||
          snapshot.data.length === 0
        ) return snapshot;

        setAuctions((current) => mergeOpportunityFeed(current, snapshot.data));
        void loadMarketValues(snapshot.data);
        setSourceMeta({
          mode: "published-gsa-snapshot",
          status: "snapshot",
          vehicleLots: snapshot.data.length,
          liveBidPolling: false,
          liveBidPollingBySource: NO_LIVE_POLLING,
          imagesFresh: snapshot.imagesFresh,
          imageExpiresAt: snapshot.imageExpiresAt,
          message: snapshot.imagesFresh
            ? "Published official GSA snapshot loaded while live source checks continue."
            : "Vehicle records are loaded and official photos are being renewed; cached photos remain visible when available.",
        });
        return snapshot;
      })
      .catch(() => null);

    const requestTimeout = window.setTimeout(
      () => controller.abort(),
      OPPORTUNITY_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(publicApiUrl("/api/opportunities"), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Opportunity feed returned ${response.status}`);
      const payload = await response.json() as {
        data?: AuctionOpportunity[];
        meta?: {
          mode?: string;
          coverage?: { vehicleLots?: number } | null;
          sourceHealth?: SourceHealthMeta | null;
          snapshot?: { imagesFresh?: boolean; imageExpiresAt?: string } | null;
        };
      };
      if (!Array.isArray(payload.data)) throw new Error("Opportunity feed omitted its data array");

      if (payload.data.length === 0) {
        const snapshot = await publishedSnapshot;
        if (opportunityRequest.current !== controller) return;
        if (snapshot?.data.length) return;

        setAuctions([]);
        setSourceMeta({
          mode: payload.meta?.mode ?? "official-catalog-empty",
          status: payload.meta?.sourceHealth?.status ?? "unavailable",
          vehicleLots: 0,
          liveBidPolling: false,
          liveBidPollingBySource: NO_LIVE_POLLING,
          imagesFresh: null,
          imageExpiresAt: null,
          message: payload.meta?.sourceHealth?.status === "live"
            ? "The official catalog currently reports no active vehicle lots."
            : "The live catalog and published snapshot are temporarily unavailable. Try again shortly.",
        });
        return;
      }

      primaryAccepted = true;
      setAuctions((current) => mergeOpportunityFeed(current, payload.data!));
      void loadMarketValues(payload.data);
      const liveBidPollingBySource = pollingAvailability(payload.meta?.sourceHealth);
      const liveBidPolling = Object.values(liveBidPollingBySource).some(Boolean);
      setSourceMeta({
        mode: payload.meta?.mode ?? "unknown",
        status: payload.meta?.sourceHealth?.status ?? "unknown",
        vehicleLots: payload.meta?.coverage?.vehicleLots ?? payload.data.length,
        liveBidPolling,
        liveBidPollingBySource,
        imagesFresh: payload.meta?.snapshot?.imagesFresh ?? true,
        imageExpiresAt: payload.meta?.snapshot?.imageExpiresAt ?? null,
        message: liveBidPolling
          ? "Official GSA Auctions and GSA Fleet records are connected; live checks run where each sale supports online bidding."
          : "Official GSA records loaded from the latest published source snapshots.",
      });
    } catch (error) {
      if (opportunityRequest.current !== controller) return;
      const snapshot = await publishedSnapshot;
      if (opportunityRequest.current !== controller || snapshot?.data.length) return;
      setSourceMeta({
        mode: "official-sources-unavailable",
        status: "unavailable",
        vehicleLots: 0,
        liveBidPolling: false,
        liveBidPollingBySource: NO_LIVE_POLLING,
        imagesFresh: null,
        imageExpiresAt: null,
        message: error instanceof Error && error.name === "AbortError"
          ? "The live source timed out and the published snapshot could not be loaded. Try Refresh view."
          : "The live catalog and published snapshot could not be loaded. Try Refresh view.",
      });
    } finally {
      window.clearTimeout(requestTimeout);
      if (opportunityRequest.current === controller) {
        opportunityRequest.current = null;
        setRefreshing(false);
      }
    }
  }, [loadMarketValues]);

  const loadLiveBid = useCallback(async (auction: AuctionOpportunity) => {
    if (!canPollAuction(auction)) return;
    if (liveBidRequests.current.has(auction.id)) return;

    const source = boardSource(auction);
    const params = new URLSearchParams({ source });
    if (source === "gsa-fleet") {
      params.set("vin", auction.vehicle.vin!);
      if (auction.saleNumber) params.set("saleNumber", auction.saleNumber);
    } else {
      params.set("id", auction.externalId);
    }

    const controller = new AbortController();
    liveBidRequests.current.set(auction.id, controller);
    liveBidAttempts.current.set(auction.id, Date.now());
    const requestTimeout = window.setTimeout(
      () => controller.abort(),
      LIVE_BID_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        publicApiUrl(`/api/live-bid?${params.toString()}`),
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`Live bid feed returned ${response.status}`);
      const payload = await response.json() as { data?: LiveBidSnapshot };
      if (!payload.data) {
        throw new Error("Live bid feed returned the wrong auction");
      }
      const snapshot = source === "gsa-fleet" && payload.data.externalId !== auction.externalId
        ? { ...payload.data, externalId: auction.externalId }
        : payload.data;
      if (snapshot.externalId !== auction.externalId) {
        throw new Error("Live bid feed returned the wrong auction");
      }
      setAuctions((current) => current.map((item) =>
        item.id === auction.id ? applyLiveBidSnapshot(item, snapshot) : item
      ));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
    } finally {
      window.clearTimeout(requestTimeout);
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

  const photosNeedRefresh = sourceMeta.imagesFresh === false || (
    sourceMeta.imageExpiresAt !== null && Date.parse(sourceMeta.imageExpiresAt) <= now
  );

  useEffect(() => {
    if (!photosNeedRefresh) return;
    const initialRetry = window.setTimeout(() => void loadOpportunities(), 0);
    const timer = window.setInterval(
      () => void loadOpportunities(),
      PHOTOS_RETRY_INTERVAL_MS,
    );
    return () => {
      window.clearTimeout(initialRetry);
      window.clearInterval(timer);
    };
  }, [loadOpportunities, photosNeedRefresh]);

  useEffect(() => {
    function refreshVisibleBoard() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastOpportunityLoadAt.current < FOCUS_REFRESH_MINIMUM_AGE_MS) return;
      void loadOpportunities();
    }

    document.addEventListener("visibilitychange", refreshVisibleBoard);
    window.addEventListener("focus", refreshVisibleBoard);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisibleBoard);
      window.removeEventListener("focus", refreshVisibleBoard);
    };
  }, [loadOpportunities]);

  useEffect(() => {
    function refreshDueClosingAuctions() {
      const checkedAt = Date.now();
      for (const auction of auctions) {
        if (!livePollingForAuction(auction, sourceMeta.liveBidPollingBySource) || !auction.endsAt) continue;
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
  }, [auctions, loadLiveBid, sourceMeta.liveBidPollingBySource]);

  useEffect(() => () => {
    marketValueRequest.current?.abort();
    marketValueRequest.current = null;
    for (const controller of liveBidRequests.current.values()) controller.abort();
    liveBidRequests.current.clear();
  }, []);

  const stateOptions = useMemo(() => buildStateFilterOptions(auctions), [auctions]);
  const conditions = useMemo(() => Array.from(new Set(auctions.map((item) => item.vehicle.condition))).sort(), [auctions]);
  const visibleStateOptions = useMemo(() => {
    if (stateFilter === "all" || stateOptions.some((option) => option.value === stateFilter)) {
      return stateOptions;
    }
    return [...stateOptions, { value: stateFilter, count: 0 }]
      .sort((a, b) => a.value.localeCompare(b.value, "en-US"));
  }, [stateFilter, stateOptions]);

  const opportunities = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const maxBidCents = maxBid ? Number(maxBid) * 100 : null;
    const result = auctions.filter((auction) => {
      const haystack = `${auction.title} ${auction.vehicle.vin ?? ""} ${auction.location.city} ${auction.location.state} ${auction.vehicle.bodyStyle ?? ""}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
      if (!auctionMatchesState(auction, stateFilter)) return false;
      if (conditionFilter !== "all" && auction.vehicle.condition !== conditionFilter) return false;
      if (maxBidCents !== null && (auction.currentBidCents === null || auction.currentBidCents > maxBidCents)) return false;
      if (quickFilter === "coming") {
        if (auction.status !== "preview") return false;
      } else if (auction.status !== "active") {
        return false;
      }
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
      return true;
    });

    return result.sort((a, b) => {
      if (sort === "ending") {
        const aDate = a.startsAt ?? a.endsAt;
        const bDate = b.startsAt ?? b.endsAt;
        return (aDate ? new Date(aDate).getTime() : Number.POSITIVE_INFINITY) - (bDate ? new Date(bDate).getTime() : Number.POSITIVE_INFINITY);
      }
      if (sort === "confidence") return b.assessment.confidence - a.assessment.confidence || b.assessment.score - a.assessment.score;
      if (sort === "profit") return (b.assessment.projectedProfitCents ?? -Infinity) - (a.assessment.projectedProfitCents ?? -Infinity);
      if (sort === "bid") return (a.currentBidCents ?? Number.POSITIVE_INFINITY) - (b.currentBidCents ?? Number.POSITIVE_INFINITY);
      return b.assessment.score - a.assessment.score;
    });
  }, [auctions, conditionFilter, maxBid, now, query, quickFilter, saved, sort, stateFilter]);

  const activeAuctionCount = auctions.filter((auction) => auction.status === "active").length;
  const comingSoonCount = auctions.filter((auction) => auction.status === "preview").length;
  const boardAuctionCount = activeAuctionCount + comingSoonCount;
  const renderScope = `${query}\u0000${sort}\u0000${quickFilter}\u0000${stateFilter}\u0000${conditionFilter}\u0000${maxBid}`;
  const renderLimit = renderWindow.scope === renderScope ? renderWindow.limit : INITIAL_RENDER_LIMIT;
  const renderedOpportunities = opportunities.slice(0, renderLimit);
  const advancedFilterCount = countAdvancedBoardFilters({
    state: stateFilter,
    condition: conditionFilter,
    maxBid,
  });

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
  const selectedStateLabel = stateFilter === "all"
    ? `All states (${boardAuctionCount})`
    : `${stateFilter} (${stateOptions.find((state) => state.value === stateFilter)?.count ?? 0})`;
  const selectedSort = SORT_OPTIONS.find((option) => option.value === sort) ?? SORT_OPTIONS[0]!;
  const snapshotOnlyActiveCount = auctions.filter((auction) =>
    canPollAuction(auction) && !sourceMeta.liveBidPollingBySource[boardSource(auction)]
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

  function resetAdvancedFilters() {
    setStateFilter("all");
    setConditionFilter("all");
    setMaxBid("");
  }

  function resetAllFilters() {
    setQuery("");
    setQuickFilter("all");
    resetAdvancedFilters();
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
          <a className={quickFilter === "all" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("all")}><LayoutDashboard size={18} /> Deal board <span>{activeAuctionCount}</span></a>
          <a className={quickFilter === "coming" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("coming")}><CarFront size={18} /> Coming soon <span>{comingSoonCount}</span></a>
          <a className={quickFilter === "closing" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("closing")}><Clock3 size={18} /> Closing room <span className="attention">{closingCount}</span></a>
          <a className={quickFilter === "saved" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("saved")}><Bookmark size={18} /> Watchlist <span>{saved.size}</span></a>
          <p>Intelligence</p>
          <a href="#deal-board" onClick={() => setQuickFilter("high-confidence")}><CircleDollarSign size={18} /> Market values</a>
          <Link href="/comps"><Database size={18} /> Comp ledger</Link>
          <a href="#source-health"><HeartPulse size={18} /> Data health</a>
        </nav>

        <div className="source-health-card" id="source-health">
          <div><Activity size={16} /><span>Source health</span><strong>{sourceMeta.status === "live" ? "Operational" : sourceMeta.status === "checking" ? "Checking" : sourceMeta.vehicleLots ? "Snapshot" : "Unavailable"}</strong></div>
          <p>{sourceMeta.message}</p>
          <div className={`health-meter ${sourceMeta.status === "live" ? "" : "is-stale"}`}><span /></div>
          <small>{sourceMeta.liveBidPolling ? "Two official catalogs · source-aware closing checks" : "Official snapshots · verify current bids"}</small>
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
            <div><strong>Official sources</strong><small>{sourceMeta.liveBidPolling ? "Source-aware live checks" : sourceMeta.status === "checking" ? "Connecting…" : sourceMeta.vehicleLots ? "Snapshots · verify bids" : "Temporarily unavailable"}</small></div>
          </div>
          <button className="icon-button" type="button" aria-label="Notifications"><Bell size={18} /><span className="notification-dot" /></button>
          <div className="avatar">ZK</div>
        </header>

        <div className="page-wrap">
          <section className="page-intro">
            <div>
              <p className="eyebrow"><span /> Official GSA vehicle intelligence</p>
              <h1>The deal board</h1>
              <p>Active and coming-soon vehicles from GSA Auctions and GSA Fleet in one underwriting queue. Deal Scores activate only when value and comparable evidence are available.</p>
            </div>
            <div className="intro-actions">
              <button type="button" className="refresh-button" onClick={refreshSnapshot} disabled={refreshing}>
                <RefreshCw size={16} className={refreshing ? "spin" : ""} /> {refreshing ? "Checking…" : "Refresh view"}
              </button>
              <button type="button" className="filter-button" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={16} /> Filters{advancedFilterCount > 0 && <span className="filter-count">{advancedFilterCount}</span>}</button>
            </div>
          </section>

          <section className="metric-grid" aria-label="Auction intelligence summary">
            <article>
              <div className="metric-icon blue"><CarFront size={18} /></div>
              <div><span>Tracked opportunities</span><strong>{boardAuctionCount}</strong><small>{activeAuctionCount} active · {comingSoonCount} coming soon</small></div>
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

          {snapshotOnlyActiveCount > 0 && sourceMeta.status !== "checking" && (
            <section className="source-notice snapshot-warning">
              <AlertTriangle size={18} />
              <div>
                <strong>Some current bids are snapshot values</strong>
                <span>{snapshotOnlyActiveCount} active online auction{snapshotOnlyActiveCount === 1 ? "" : "s"} cannot be refreshed live from this host. Each vehicle card shows its own polling status; scheduled live sales never imply an online bid feed.</span>
              </div>
              <a href="#deal-board">Review cards <ArrowRight size={14} /></a>
            </section>
          )}

          <section className="source-notice comp-ledger-notice" id="comp-ledger">
            <Database size={18} />
            <div>
              <strong>Comparable ledger</strong>
              <span>Official closed-catalog results are imported hourly and merged with outcomes observed by this installation. High bids remain separate from awarded prices unless an authoritative source confirms the award.</span>
            </div>
            <Link href="/comps">Open ledger <ArrowRight size={14} /></Link>
          </section>

          <section className="board-toolbar">
            <div className="quick-filters" role="tablist" aria-label="Opportunity views">
              {([
                ["all", "Best deals"],
                ["coming", `Coming soon (${comingSoonCount})`],
                ["closing", "Closing soon"],
                ["high-confidence", "High confidence"],
                ["under-10k", "Under $10k"],
                ["trucks", "Trucks"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" className={quickFilter === value ? "active" : ""} onClick={() => setQuickFilter(value)}>{label}</button>
              ))}
            </div>
            <div className="board-controls">
              <label className={`state-select ${stateFilter !== "all" ? "is-active" : ""}`}>
                <MapPin size={15} aria-hidden="true" />
                <span>State</span>
                <strong>{selectedStateLabel}</strong>
                <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label="Filter auctions by state">
                  <option value="all">All states ({boardAuctionCount})</option>
                  {visibleStateOptions.map((state) => <option key={state.value} value={state.value}>{state.value} ({state.count})</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
              <label className="sort-select">
                <ArrowDownUp size={15} aria-hidden="true" />
                <strong>{selectedSort.label}</strong>
                <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort auctions">
                  {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
              <div className="view-switch" aria-label="View style"><button type="button" className={!compact ? "active" : ""} onClick={() => setCompact(false)} aria-label="Card view"><Grid2X2 size={16} /></button><button type="button" className={compact ? "active" : ""} onClick={() => setCompact(true)} aria-label="Compact view"><List size={17} /></button></div>
            </div>
          </section>

          <div className="result-line"><strong>{opportunities.length} opportunities</strong><span>{stateFilter === "all" ? "All states" : stateFilter} · {selectedSort.orderCopy}; showing {Math.min(renderLimit, opportunities.length)} on the board</span></div>

          <section className={`opportunity-list ${compact ? "compact-list" : ""}`}>
            {renderedOpportunities.map((auction) => (
              <OpportunityCard key={auction.id} auction={auction} now={now} saved={saved.has(auction.id)} onSave={() => toggleSaved(auction.id)} compact={compact} livePollingAvailable={livePollingForAuction(auction, sourceMeta.liveBidPollingBySource)} marketValueLoading={marketValueLoadingIds.has(auction.externalId)} photosRefreshing={photosNeedRefresh && boardSource(auction) === "gsa-auctions"} />
            ))}
            {renderedOpportunities.length < opportunities.length && (
              <div className="show-more-opportunities">
                <span>Showing {renderedOpportunities.length} of {opportunities.length} matching vehicles</span>
                <button type="button" onClick={() => setRenderWindow({ scope: renderScope, limit: renderLimit + RENDER_LIMIT_INCREMENT })}>
                  Show {Math.min(RENDER_LIMIT_INCREMENT, opportunities.length - renderedOpportunities.length)} more
                </button>
              </div>
            )}
            {!opportunities.length && (
              <div className="empty-state"><Search size={28} /><h2>{sourceMeta.status === "checking" ? "Checking the official GSA catalogs" : auctions.length === 0 && sourceMeta.status === "unavailable" ? "Vehicle catalogs temporarily unavailable" : auctions.length === 0 ? "No active or coming-soon vehicle lots are available" : quickFilter === "coming" ? "No coming-soon vehicles match these filters" : "No vehicles match these filters"}</h2><p>{auctions.length === 0 ? sourceMeta.message : "Clear a filter or widen the bid range to bring opportunities back into view."}</p><button type="button" onClick={resetAllFilters}>Reset filters</button></div>
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
            <label><span>State</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="all">All states ({boardAuctionCount})</option>{visibleStateOptions.map((state) => <option key={state.value} value={state.value}>{state.value} ({state.count})</option>)}</select></label>
            <label><span>Condition</span><select value={conditionFilter} onChange={(event) => setConditionFilter(event.target.value)}><option value="all">All conditions</option>{conditions.map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></label>
            <label><span>Maximum current bid</span><div className="money-input"><span>$</span><input inputMode="numeric" value={maxBid} onChange={(event) => setMaxBid(event.target.value.replace(/\D/g, ""))} placeholder="No maximum" /></div></label>
            <div className="filter-summary"><Settings2 size={16} /><span>Current selection</span><strong>{opportunities.length} of {boardAuctionCount} active or coming-soon vehicles · {advancedFilterCount} filter{advancedFilterCount === 1 ? "" : "s"}</strong></div>
            <div className="filter-actions"><button type="button" onClick={resetAdvancedFilters}>Reset</button><button type="button" className="apply" onClick={() => setFiltersOpen(false)}>Show {opportunities.length} vehicles</button></div>
          </section>
        </div>
      )}

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <a className={quickFilter === "all" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("all")}><LayoutDashboard size={19} /><span>Deals</span></a>
        <a className={quickFilter === "closing" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("closing")}><Clock3 size={19} /><span>Closing</span></a>
        <a className={quickFilter === "saved" ? "active" : ""} href="#deal-board" onClick={() => setQuickFilter("saved")}><Bookmark size={19} /><span>Saved</span></a>
        <button type="button" className={advancedFilterCount > 0 ? "active" : ""} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={19} /><span>Filters{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}</span></button>
      </nav>
    </div>
  );
}
