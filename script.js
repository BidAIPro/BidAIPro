(() => {
  "use strict";

  const STORAGE_KEY = "bidaipro.auction-workspace.v1";
  const MAX_IMPORT_ROWS = 5000;
  const QUEUE_PAGE_SIZE = 250;
  const VIEW_TITLES = {
    opportunities: "Opportunities",
    watchlist: "Watchlist",
    learning: "Learning",
    sources: "Sources",
    settings: "Settings",
  };

  const DEFAULT_SETTINGS = {
    marketplaceFee: 13.25,
    taxRate: 8.25,
    buyerPremium: 0,
    outboundShipping: 14,
    repairReserve: 25,
    returnReserve: 18,
    minimumProfit: 50,
    targetMargin: 22,
  };

  const AUCTION_MARKETS = [
    { key: "shopgoodwill", name: "ShopGoodwill", domain: "shopgoodwill.com", homeUrl: "https://shopgoodwill.com/", focus: "Donated goods, jewelry, collectibles, electronics" },
    { key: "ebay", name: "eBay Auctions", domain: "ebay.com", homeUrl: "https://www.ebay.com/", focus: "General merchandise and worldwide collectibles" },
    { key: "hibid", name: "HiBid", domain: "hibid.com", homeUrl: "https://hibid.com/", focus: "Estate, equipment, vehicles, jewelry, local auctions" },
    { key: "liveauctioneers", name: "LiveAuctioneers", domain: "liveauctioneers.com", homeUrl: "https://www.liveauctioneers.com/", focus: "Art, antiques, coins, jewelry, collectibles" },
    { key: "invaluable", name: "Invaluable", domain: "invaluable.com", homeUrl: "https://www.invaluable.com/", focus: "Fine art, decorative art, jewelry, auction houses" },
    { key: "govdeals", name: "GovDeals", domain: "govdeals.com", homeUrl: "https://www.govdeals.com/", focus: "Government surplus, vehicles, equipment, real estate" },
    { key: "publicsurplus", name: "Public Surplus", domain: "publicsurplus.com", homeUrl: "https://www.publicsurplus.com/", focus: "Government and educational surplus" },
    { key: "propertyroom", name: "PropertyRoom", domain: "propertyroom.com", homeUrl: "https://www.propertyroom.com/", focus: "Police surplus, jewelry, electronics, vehicles" },
    { key: "proxibid", name: "Proxibid", domain: "proxibid.com", homeUrl: "https://www.proxibid.com/", focus: "Equipment, vehicles, estate and specialty auctions" },
    { key: "bidspotter", name: "BidSpotter", domain: "bidspotter.com", homeUrl: "https://www.bidspotter.com/en-us", focus: "Industrial, commercial, plant and machinery" },
  ];

  const PUBLISHED_RESEARCH = (() => {
    const payload = window.BIDAI_LIVE_SNAPSHOTS;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
      return { observedAt: null, sourceMode: "unavailable", items: [] };
    }
    return {
      observedAt: payload.observedAt || null,
      sourceMode: payload.sourceMode || "published-research",
      items: payload.items.filter((item) => item && item.id && item.title),
    };
  })();


  const aliases = {
    externalId: ["externalid", "itemid", "itemnumber", "itemno", "auctionid", "listingid", "id"],
    title: ["title", "itemtitle", "description", "itemname", "listingtitle"],
    category: ["category", "categoryname", "department"],
    currentBid: ["currentbid", "currentprice", "price", "bidamount", "winningbid"],
    shipping: ["shipping", "shippingcost", "shippingandhandling", "inboundshipping", "handling"],
    bidCount: ["bidcount", "bids", "numberofbids"],
    endsAt: ["endsat", "enddate", "endtime", "auctionend", "closeddate", "dateclosed"],
    expectedClose: ["expectedclose", "predictedfinal", "expectedfinalbid", "projectedclose", "sourceestimate", "sourcepriceestimate"],
    resaleLow: ["resalelow", "valuelow", "comparablelow"],
    resaleMedian: ["resalemedian", "resalevalue", "estimatedvalue", "comparablemedian"],
    resaleHigh: ["resalehigh", "valuehigh", "comparablehigh"],
    finalPrice: ["finalprice", "finalbid", "endingprice", "soldprice", "actualfinal"],
    status: ["status", "auctionstatus"],
    source: ["source", "datasource"],
    sourceKey: ["sourcekey", "marketplacekey", "marketplace"],
    url: ["url", "itemurl", "listingurl", "link"],
    observedAt: ["observedat", "snapshotat", "capturedat", "timestamp"],
    demand: ["demand", "demandscore", "popularity", "liquidityscore"],
    rarity: ["rarity", "rarityscore", "scarcityscore"],
    identityConfidence: ["identityconfidence", "identityscore", "matchconfidence"],
    conditionConfidence: ["conditionconfidence", "conditionscore"],
    compCount: ["compcount", "comparables", "soldcomps", "comparablecount"],
    compRecencyDays: ["comprecencydays", "compagedays", "comparablerecencydays"],
    identifiedAs: ["identifiedas", "normalizedidentity", "itemidentity", "model"],
    modelKey: ["modelkey", "compgroup", "similaritemkey", "normalizedmodel"],
    forecastBasis: ["forecastbasis", "forecastmethod", "predictionbasis"],
    marketplaceFee: ["marketplacefee", "sellingfee", "resalefeepercent"],
    taxRate: ["taxrate", "salestax", "taxpercent"],
    buyerPremium: ["buyerpremium", "buyerpremiumpercent"],
    outboundShipping: ["outboundshipping", "resaleshipping", "sellershipping"],
    repairReserve: ["repairreserve", "testingreserve", "prepreserve"],
    returnReserve: ["returnreserve", "lossreserve", "riskreserve"],
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
  const cleanKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedModelKey = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([:|/])\s*/g, "$1");
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
  const safeHttpUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (_error) {
      return "";
    }
  };
  const normalizeMarketKey = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const marketplaceFor = (item = {}) => {
    const explicitKey = normalizeMarketKey(item.sourceKey || item.marketplaceKey || item.marketplace);
    const explicitMarket = AUCTION_MARKETS.find((market) => market.key === explicitKey);
    if (explicitMarket) return explicitMarket;
    const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
    const hostname = (() => {
      try { return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch (_error) { return ""; }
    })();
    const domainMarket = AUCTION_MARKETS.find((market) => hostname === market.domain || hostname.endsWith(`.${market.domain}`));
    if (domainMarket) return domainMarket;
    const sourceName = String(item.source || item.marketplace || "").trim();
    const namedMarket = AUCTION_MARKETS.find((market) => sourceName.toLowerCase().includes(market.name.toLowerCase().replace(" auctions", "")));
    if (namedMarket) return namedMarket;
    const fallbackKey = explicitKey || normalizeMarketKey(hostname || sourceName) || "other-source";
    return {
      key: fallbackKey,
      name: sourceName || hostname || "Other source",
      domain: hostname,
      homeUrl: sourceUrl ? new URL(sourceUrl).origin : "",
      focus: "Feed-provided auction source",
    };
  };
  const openSourceListing = (value) => {
    const sourceUrl = safeHttpUrl(value);
    if (!sourceUrl) return false;
    window.location.assign(sourceUrl);
    return true;
  };
  const money = (value, digits = 0) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
  const percent = (value, digits = 0) => `${(Number(value) * 100).toFixed(digits)}%`;
  const parseMoney = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const parseOptionalMoney = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parseConfidence = (value, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(String(value ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed > 1 ? parsed / 100 : parsed);
  };
  const parseScore = (value, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(String(value ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(clamp(parsed > 1 ? parsed / 100 : parsed) * 100);
  };
  const VERIFIED_FORECAST_STATUSES = new Set(["available", "ready", "verified"]);
  const isVerifiedForecast = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const low = Number(value.low);
    const expected = Number(value.expected);
    const high = Number(value.high);
    const sampleSize = Number(value.sampleSize);
    const exactModelCount = Number(value.exactModelCount);
    return VERIFIED_FORECAST_STATUSES.has(String(value.status || "").toLowerCase())
      && typeof value.modelVersion === "string"
      && value.modelVersion.trim().length > 0
      && Number.isFinite(low)
      && Number.isFinite(expected)
      && Number.isFinite(high)
      && low > 0
      && low <= expected
      && expected <= high
      && Number.isFinite(sampleSize)
      && sampleSize >= 5
      && Number.isFinite(exactModelCount)
      && exactModelCount >= 5
      && Number.isFinite(Date.parse(value.asOf || ""));
  };
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const quantile = (values, percentile) => {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * clamp(percentile);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  const formatDateTime = (value) => {
    if (value === null || value === undefined || value === "") return "Unknown";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unknown"
      : date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const observedAtFor = (item) => {
    const observations = Array.isArray(item?.observations) ? item.observations : [];
    return item?.observedAt || observations.at(-1)?.observedAt || null;
  };
  const freshnessFor = (item) => {
    const observedAt = observedAtFor(item);
    const timestamp = Date.parse(observedAt || "");
    if (!Number.isFinite(timestamp)) return { className: "is-unknown", label: "Observation time unknown", short: "unknown age", observedAt: null };
    const ageMinutes = (Date.now() - timestamp) / 60000;
    if (ageMinutes < -5) return { className: "is-invalid", label: "Future-dated snapshot", short: "clock error", observedAt };
    const normalizedAgeMinutes = Math.max(0, ageMinutes);
    const short = normalizedAgeMinutes < 2
      ? "just now"
      : normalizedAgeMinutes < 60
        ? `${Math.round(normalizedAgeMinutes)}m ago`
        : normalizedAgeMinutes < 1440
          ? `${Math.round(normalizedAgeMinutes / 60)}h ago`
          : `${Math.round(normalizedAgeMinutes / 1440)}d ago`;
    const className = normalizedAgeMinutes <= 45 ? "is-fresh" : normalizedAgeMinutes <= 120 ? "is-aging" : "is-stale";
    const label = className === "is-fresh" ? "Fresh snapshot" : className === "is-aging" ? "Delayed snapshot" : "Stale snapshot";
    return { className, label, short, observedAt };
  };

  function loadWorkspace() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!stored || typeof stored !== "object") throw new Error("empty");
      return {
        userItems: Array.isArray(stored.userItems) ? stored.userItems : [],
        watchIds: Array.isArray(stored.watchIds) ? stored.watchIds : [],
        settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
      };
    } catch (_error) {
      return { userItems: [], watchIds: [], settings: { ...DEFAULT_SETTINGS } };
    }
  }

  let workspace = loadWorkspace();
  let activeView = "opportunities";
  let selectedId = PUBLISHED_RESEARCH.items[0]?.id || workspace.userItems[0]?.id || "";
  let historicalIndexCache = null;
  let visibleQueueLimit = QUEUE_PAGE_SIZE;

  function saveWorkspace() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      return true;
    } catch (_error) {
      toast("This browser could not save the workspace.", "error");
      return false;
    }
  }

  function allItems() {
    return [...PUBLISHED_RESEARCH.items, ...workspace.userItems].map((item) => {
      const marketplace = marketplaceFor(item);
      return {
        ...item,
        sourceKey: marketplace.key,
        marketplaceName: marketplace.name,
        status: item.status === "active" && item.endsAt && Date.parse(item.endsAt) <= Date.now() ? "ended" : item.status,
        watched: workspace.watchIds.includes(item.id),
      };
    });
  }

  function invalidateHistoricalIndex() {
    historicalIndexCache = null;
  }

  function comparableKey(comparable) {
    const stableId = String(comparable.externalId || comparable.id || "").trim().toLowerCase();
    if (stableId) return `id:${String(comparable.source || "").trim().toLowerCase()}:${stableId}`;
    const url = safeHttpUrl(comparable.url || comparable.sourceUrl);
    if (url) return `url:${url.toLowerCase()}`;
    return `fallback:${[
      normalizedModelKey(comparable.modelKey),
      String(comparable.title || "").trim().toLowerCase(),
      comparable.endedAt || comparable.soldAt || "",
      String(comparable.source || "").trim().toLowerCase(),
    ].join("|")}`;
  }

  function normalizedAuctionComparable(value, fallback = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const finalPrice = Number(value.finalPrice ?? value.soldPrice ?? value.price);
    if (!(finalPrice > 0)) return null;
    const endedAt = value.endedAt || value.soldAt || value.endsAt || fallback.endedAt || null;
    const rawMatchScore = value.matchScore ?? fallback.matchScore;
    const parsedMatchScore = rawMatchScore === null || rawMatchScore === undefined || rawMatchScore === ""
      ? null
      : Number(rawMatchScore);
    return {
      id: String(value.id || value.externalId || fallback.id || ""),
      externalId: String(value.externalId || value.id || fallback.externalId || ""),
      title: String(value.title || fallback.title || "Comparable auction"),
      finalPrice,
      endedAt,
      observedAt: value.observedAt || null,
      outcomeObservedAt: value.outcomeObservedAt || value.finalObservedAt || value.capturedAt || value.observedAt || fallback.outcomeObservedAt || null,
      url: safeHttpUrl(value.url || value.sourceUrl || fallback.url),
      source: String(value.source || fallback.source || "Recorded auction outcome"),
      category: String(value.category || fallback.category || "Unclassified"),
      modelKey: String(value.modelKey || value.compGroup || value.similarItemKey || ""),
      matchReason: String(value.matchReason || fallback.matchReason || "Exact normalized model"),
      matchScore: Number.isFinite(parsedMatchScore) ? clamp(parsedMatchScore > 1 ? parsedMatchScore / 100 : parsedMatchScore) : null,
      bidAtComparableTime: Number(value.bidAtComparableTime || value.currentBidAtMatch || 0) || null,
      hoursToClose: Number(value.hoursToClose ?? value.timeToCloseHours) || null,
      observations: Array.isArray(value.observations) ? value.observations.slice(-250) : [],
    };
  }

  function historicalIndex() {
    if (historicalIndexCache) return historicalIndexCache;
    const byModel = new Map();
    const byCategory = new Map();
    const addComparable = (comparable) => {
      if (!comparable) return;
      const modelKey = normalizedModelKey(comparable.modelKey);
      const categoryKey = cleanKey(comparable.category);
      if (modelKey) {
        if (!byModel.has(modelKey)) byModel.set(modelKey, []);
        byModel.get(modelKey).push(comparable);
      }
      if (categoryKey) {
        if (!byCategory.has(categoryKey)) byCategory.set(categoryKey, []);
        byCategory.get(categoryKey).push(comparable);
      }
    };
    for (const item of allItems()) {
      const itemObservedAt = observedAtFor(item);
      for (const entry of Array.isArray(item.auctionComparables) ? item.auctionComparables : []) {
        addComparable(normalizedAuctionComparable(entry, {
          category: item.category,
          source: item.source,
          outcomeObservedAt: itemObservedAt,
        }));
      }
      if (!(Number(item.finalPrice) > 0) || item.status !== "ended") continue;
      addComparable(normalizedAuctionComparable(item, {
        id: item.id,
        externalId: item.externalId,
        title: item.title,
        endedAt: item.endsAt,
        url: item.url || item.sourceUrl,
        source: item.source,
        category: item.category,
        outcomeObservedAt: item.outcomeObservedAt || item.finalObservedAt || itemObservedAt,
        matchReason: "Recorded completed auction",
        matchScore: 1,
      }));
    }
    historicalIndexCache = { byModel, byCategory };
    return historicalIndexCache;
  }

  function uniqueComparables(values, target, asOf) {
    const cutoff = Date.parse(asOf || "") || Date.now();
    const excludedIds = new Set([target?.id, target?.externalId]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase()));
    const targetUrl = safeHttpUrl(target?.url || target?.sourceUrl).toLowerCase();
    const seen = new Set();
    return values
      .filter(Boolean)
      .filter((entry) => !excludedIds.has(String(entry.id || "").trim().toLowerCase())
        && !excludedIds.has(String(entry.externalId || "").trim().toLowerCase()))
      .filter((entry) => !targetUrl || safeHttpUrl(entry.url || entry.sourceUrl).toLowerCase() !== targetUrl)
      .filter((entry) => Number.isFinite(Date.parse(entry.endedAt || "")) && Date.parse(entry.endedAt) <= cutoff)
      .filter((entry) => Number.isFinite(Date.parse(entry.outcomeObservedAt || "")) && Date.parse(entry.outcomeObservedAt) <= cutoff)
      .filter((entry) => {
        const key = comparableKey(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Date.parse(b.endedAt || "") - Date.parse(a.endedAt || ""))
      .slice(0, 50);
  }

  function exactAuctionComparables(item) {
    const modelKey = normalizedModelKey(item.modelKey);
    if (!modelKey) return [];
    const embedded = (Array.isArray(item.auctionComparables) ? item.auctionComparables : [])
      .map((entry) => normalizedAuctionComparable(entry, {
        category: item.category,
        source: item.source,
        outcomeObservedAt: observedAtFor(item),
      }))
      .filter((entry) => normalizedModelKey(entry?.modelKey) === modelKey && Number(entry.matchScore) >= 0.75);
    const indexed = (historicalIndex().byModel.get(modelKey) || [])
      .filter((entry) => Number(entry.matchScore) >= 0.75);
    return uniqueComparables([...embedded, ...indexed], item, observedAtFor(item));
  }

  function categoryReferenceComparables(item) {
    const categoryKey = cleanKey(item.category);
    if (!categoryKey) return [];
    return uniqueComparables(historicalIndex().byCategory.get(categoryKey) || [], item, observedAtFor(item)).slice(0, 10);
  }

  function comparableBidAtHorizon(comparable, targetHours) {
    if (!Number.isFinite(targetHours)) return null;
    const tolerance = Math.max(2, targetHours * 0.35);
    if (Number(comparable.bidAtComparableTime) > 0
      && comparable.hoursToClose !== null
      && comparable.hoursToClose !== undefined
      && Number.isFinite(Number(comparable.hoursToClose))
      && Number(comparable.hoursToClose) >= 0
      && Math.abs(Number(comparable.hoursToClose) - targetHours) <= tolerance) {
      return Number(comparable.bidAtComparableTime);
    }
    const closeAt = Date.parse(comparable.endedAt || "");
    if (!Number.isFinite(closeAt)) return null;
    const matches = (Array.isArray(comparable.observations) ? comparable.observations : [])
      .map((point) => ({
        bid: Number(point?.currentBid),
        hours: (closeAt - Date.parse(point?.observedAt || "")) / 3600000,
      }))
      .filter((point) => point.bid > 0 && Number.isFinite(point.hours) && point.hours >= 0)
      .filter((point) => Math.abs(point.hours - targetHours) <= tolerance)
      .sort((a, b) => Math.abs(a.hours - targetHours) - Math.abs(b.hours - targetHours));
    return matches[0]?.bid || null;
  }

  function observationHorizonHours(item) {
    const closeAt = Date.parse(item?.endsAt || "");
    const observedAt = Date.parse(observedAtFor(item) || "");
    if (!Number.isFinite(closeAt) || !Number.isFinite(observedAt)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (closeAt - observedAt) / 3600000);
  }

  function forecastFor(item) {
    const currentBid = Math.max(0, Number(item.currentBid) || 0);
    const modelKey = normalizedModelKey(item.modelKey);
    const comparables = modelKey ? exactAuctionComparables(item) : [];
    const supplied = item.forecast && typeof item.forecast === "object" ? item.forecast : null;
    const suppliedExpected = Number(supplied?.expected);
    const suppliedExact = Math.max(0, Number(supplied?.exactModelCount) || 0);
    const suppliedAsOf = Date.parse(supplied?.asOf || "");
    const observedAt = Date.parse(observedAtFor(item) || "");
    const endsAt = Date.parse(item.endsAt || "");
    const suppliedIsPointInTime = isVerifiedForecast(supplied)
      && Boolean(modelKey)
      && comparables.length >= 5
      && Number(supplied.low) >= currentBid
      && (!Number.isFinite(observedAt) || suppliedAsOf <= observedAt + 300000)
      && (!Number.isFinite(observedAt) || observedAt - suppliedAsOf <= 7200000)
      && (!Number.isFinite(endsAt) || suppliedAsOf <= endsAt);
    if (suppliedIsPointInTime) {
      return {
        status: "available",
        expected: Math.max(currentBid, suppliedExpected),
        low: Math.min(Math.max(currentBid, suppliedExpected), Math.max(currentBid, Number(supplied.low) || suppliedExpected)),
        high: Math.max(currentBid, suppliedExpected, Number(supplied.high) || suppliedExpected),
        sampleSize: comparables.length,
        exactModelCount: comparables.length,
        curveCount: Math.max(0, Number(supplied.curveCount) || 0),
        method: String(supplied.method || "Source empirical forecast"),
        modelVersion: String(supplied.modelVersion || "source-model"),
        asOf: supplied.asOf || observedAtFor(item),
        confidence: parseConfidence(supplied.confidence, 0.55 + Math.min(0.35, suppliedExact * 0.025)),
        reasonCodes: Array.isArray(supplied.reasonCodes) ? supplied.reasonCodes.map(String).slice(0, 8) : [],
        evidenceIds: Array.isArray(supplied.evidenceIds) ? supplied.evidenceIds.map(String).slice(0, 250) : [],
        evidenceHash: String(supplied.evidenceHash || ""),
        comparables,
        categoryReferences: categoryReferenceComparables(item),
        sourceEstimate: Number(item.expectedClose) > 0 ? Number(item.expectedClose) : null,
      };
    }

    if (comparables.length >= 5) {
      const targetHours = observationHorizonHours(item);
      const curveComparableValues = currentBid > 0
        ? comparables
            .map((entry) => ({ entry, matchedBid: comparableBidAtHorizon(entry, targetHours) }))
            .filter(({ matchedBid }) => Number(matchedBid) > 0)
            .map(({ entry, matchedBid }) => currentBid * (entry.finalPrice / matchedBid))
        : [];
      const values = curveComparableValues.length >= 5
        ? curveComparableValues
        : comparables.map((entry) => entry.finalPrice);
      const expected = Math.max(currentBid, quantile(values, 0.5));
      return {
        status: "available",
        expected,
        low: Math.max(currentBid, quantile(values, 0.2)),
        high: Math.max(expected, quantile(values, 0.8)),
        sampleSize: comparables.length,
        exactModelCount: comparables.length,
        curveCount: curveComparableValues.length,
        method: curveComparableValues.length >= 5 ? "Same-model time-to-close terminal uplift" : "Same-model completed-auction distribution",
        modelVersion: "empirical-close-v1",
        asOf: observedAtFor(item),
        confidence: clamp(0.5 + Math.min(0.38, comparables.length * 0.035) + Math.min(0.1, curveComparableValues.length * 0.015)),
        reasonCodes: [],
        comparables,
        categoryReferences: categoryReferenceComparables(item),
        sourceEstimate: Number(item.expectedClose) > 0 ? Number(item.expectedClose) : null,
      };
    }

    return {
      status: "insufficient",
      expected: null,
      low: null,
      high: null,
      sampleSize: comparables.length,
      exactModelCount: comparables.length,
      curveCount: comparables.filter((entry) => Number(entry.bidAtComparableTime) > 0).length,
      method: item.modelKey ? `Insufficient exact-model outcomes (${comparables.length}/5)` : "A normalized model key is required",
      modelVersion: "empirical-close-v1",
      asOf: observedAtFor(item),
      confidence: 0,
      reasonCodes: [item.modelKey ? "MINIMUM_EXACT_COMPS_NOT_MET" : "MODEL_KEY_MISSING"],
      comparables,
      categoryReferences: categoryReferenceComparables(item),
      sourceEstimate: Number(item.expectedClose) > 0 ? Number(item.expectedClose) : null,
    };
  }

  function hoursRemaining(item) {
    if (!item?.endsAt) return Number.POSITIVE_INFINITY;
    const value = new Date(item.endsAt).getTime();
    return Number.isFinite(value) ? Math.max(0, (value - Date.now()) / 3600000) : Number.POSITIVE_INFINITY;
  }

  function snapshotPlanFor(item) {
    const endTime = Date.parse(item?.endsAt || "");
    const finalRecorded = Number(item?.finalPrice) > 0;
    if (item?.status === "ended" && finalRecorded) {
      return { intervalMinutes: null, label: "Final outcome", urgency: "complete", nextDueAt: null, due: false };
    }
    const afterCloseHours = Number.isFinite(endTime) && endTime <= Date.now() ? (Date.now() - endTime) / 3600000 : null;
    const hours = hoursRemaining(item);
    const intervalMinutes = afterCloseHours !== null
      ? (afterCloseHours <= 1 / 60 ? 0.5 : 60)
      : hours <= 5 / 60 ? 0.5 : hours <= 0.5 ? 5 : 60;
    const urgency = afterCloseHours !== null
      ? (afterCloseHours <= 1 / 60 ? "critical" : "elevated")
      : hours <= 5 / 60 ? "critical" : hours <= 0.5 ? "high" : "standard";
    const observedAt = Date.parse(observedAtFor(item) || "");
    const nextDueAt = Number.isFinite(observedAt) ? new Date(observedAt + intervalMinutes * 60000).toISOString() : null;
    return {
      intervalMinutes,
      label: afterCloseHours !== null
        ? (intervalMinutes === 0.5 ? "Final check every 30 sec" : "Final check hourly")
        : intervalMinutes === 0.5 ? "Every 30 sec" : intervalMinutes < 60 ? `Every ${intervalMinutes} min` : "Hourly",
      urgency,
      nextDueAt,
      due: !nextDueAt || Date.parse(nextDueAt) <= Date.now(),
    };
  }

  function assess(item) {
    const s = workspace.settings;
    const hours = hoursRemaining(item);
    const configuredNumber = (value, fallback) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
      ? Number(fallback) || 0
      : Number(value);
    const forecast = forecastFor(item);
    const currentBid = Math.max(0, Number(item.currentBid) || 0);
    const expectedClose = forecast.status === "available" ? Number(forecast.expected) : null;
    const modeledBid = expectedClose ?? currentBid;
    const marketplaceFee = configuredNumber(item.marketplaceFee, s.marketplaceFee);
    const taxRate = configuredNumber(item.taxRate, s.taxRate);
    const buyerPremium = configuredNumber(item.buyerPremium, s.buyerPremium);
    const outboundShipping = configuredNumber(item.outboundShipping, s.outboundShipping);
    const repairReserve = configuredNumber(item.repairReserve, s.repairReserve);
    const returnReserve = configuredNumber(item.returnReserve, s.returnReserve);
    const hasNumericShipping = item.shipping !== null
      && item.shipping !== undefined
      && item.shipping !== ""
      && Number.isFinite(Number(item.shipping));
    const shippingIsUnacceptedEstimate = item.shippingQuoted === null
      && item.shippingAssumed !== null
      && item.shippingAssumed !== undefined
      && item.shippingEstimateAccepted !== true;
    const shippingKnown = hasNumericShipping && item.shippingKnown !== false && !shippingIsUnacceptedEstimate;
    const shipping = shippingKnown ? Math.max(0, Number(item.shipping)) : 0;
    const resaleModelKey = normalizedModelKey(item.modelKey);
    const evidenceCutoff = Date.parse(observedAtFor(item) || "") || Date.now();
    const qualifyingResaleEvidence = (Array.isArray(item.comparableSales) ? item.comparableSales : [])
      .filter((entry) => Number(entry?.soldPrice ?? entry?.finalPrice ?? entry?.price) > 0)
      .filter((entry) => resaleModelKey && normalizedModelKey(entry?.modelKey || entry?.compGroup || entry?.similarItemKey) === resaleModelKey)
      .filter((entry) => {
        const rawScore = entry?.matchScore;
        const parsedScore = rawScore === null || rawScore === undefined || rawScore === "" ? null : Number(rawScore);
        const matchScore = Number.isFinite(parsedScore) ? clamp(parsedScore > 1 ? parsedScore / 100 : parsedScore) : null;
        return matchScore !== null && matchScore >= 0.75;
      })
      .filter((entry) => Boolean(entry?.id || entry?.externalId || safeHttpUrl(entry?.url || entry?.sourceUrl)))
      .filter((entry) => {
        const ended = Date.parse(entry?.soldAt || entry?.endedAt || "");
        const knownAt = Date.parse(entry?.outcomeObservedAt || entry?.finalObservedAt || entry?.capturedAt || entry?.observedAt || observedAtFor(item) || "");
        return Number.isFinite(ended) && ended <= evidenceCutoff && Number.isFinite(knownAt) && knownAt <= evidenceCutoff;
      });
    const uniqueResaleEvidence = [...new Map(qualifyingResaleEvidence.map((entry) => [comparableKey(entry), entry])).values()];
    const resaleEvidenceCount = uniqueResaleEvidence.length;
    const comparableResalePrices = uniqueResaleEvidence.map((entry) => Number(entry.soldPrice ?? entry.finalPrice ?? entry.price));
    const intrinsicQuoteAt = Date.parse(item.valuationBasis?.referenceObservedAt || "");
    const hasIntrinsicEvidence = item.intrinsicValueEvidence === true
      && Number(item.valuationBasis?.grossWeightGrams) > 0
      && Number(item.valuationBasis?.reference14kMeltPerGram) > 0
      && Number.isFinite(intrinsicQuoteAt)
      && intrinsicQuoteAt <= evidenceCutoff
      && evidenceCutoff - intrinsicQuoteAt <= 86400000;
    const hasComparableResaleEvidence = resaleEvidenceCount >= 3;
    const sourceResaleLow = Math.max(0, Number(item.resaleLow) || 0);
    const sourceResaleMedian = Math.max(0, Number(item.resaleMedian) || 0);
    const sourceResaleHigh = Math.max(0, Number(item.resaleHigh) || 0);
    const resaleLow = hasComparableResaleEvidence ? quantile(comparableResalePrices, 0.2) : sourceResaleLow;
    const resaleMedian = hasComparableResaleEvidence ? quantile(comparableResalePrices, 0.5) : sourceResaleMedian;
    const resaleHigh = hasComparableResaleEvidence ? quantile(comparableResalePrices, 0.8) : sourceResaleHigh;
    const landedAt = (bid) => ((Math.max(0, bid) * (1 + buyerPremium / 100) + shipping) * (1 + taxRate / 100));
    const buyerPremiumCost = modeledBid * buyerPremium / 100;
    const acquisitionSubtotal = modeledBid + buyerPremiumCost + shipping;
    const taxCost = acquisitionSubtotal * taxRate / 100;
    const acquisition = acquisitionSubtotal + taxCost;
    const currentAcquisition = landedAt(currentBid);
    const netResale = (sale) => sale * (1 - marketplaceFee / 100) - outboundShipping - repairReserve - returnReserve;
    const netLow = netResale(resaleLow);
    const netMedian = netResale(resaleMedian);
    const netHigh = netResale(resaleHigh);
    const hasResaleEvidence = resaleMedian > 0
      && resaleLow > 0
      && resaleLow <= resaleMedian
      && resaleHigh >= resaleMedian
      && (hasComparableResaleEvidence || hasIntrinsicEvidence);
    const hasForecast = forecast.status === "available";
    const hasDecisionInputs = hasResaleEvidence && shippingKnown;
    const profitLow = hasForecast && hasDecisionInputs ? netLow - landedAt(forecast.high) : null;
    const profitExpected = hasForecast && hasDecisionInputs ? netMedian - acquisition : null;
    const profitHigh = hasForecast && hasDecisionInputs ? netHigh - landedAt(forecast.low) : null;
    const profitAtCurrentBid = hasDecisionInputs ? netMedian - currentAcquisition : null;
    const conservativeResale = resaleLow + Math.max(0, resaleMedian - resaleLow) * 0.2;
    const desiredProfit = Math.max(Number(s.minimumProfit) || 0, conservativeResale * (Number(s.targetMargin) || 0) / 100);
    const maximumLanded = Math.max(0, netResale(conservativeResale) - desiredProfit);
    const maxBid = hasDecisionInputs
      ? Math.max(0, (maximumLanded / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100))
      : null;
    const comparableCount = Math.max(Number(item.compCount) || 0, forecast.exactModelCount || 0);
    const compCoverage = clamp(Math.log2(comparableCount + 1) / 4);
    const suppliedRecencyDays = Number(item.compRecencyDays);
    const compRecencyDays = Number.isFinite(suppliedRecencyDays) && suppliedRecencyDays >= 0
      ? suppliedRecencyDays
      : 365;
    const recency = clamp(1 - compRecencyDays / 365);
    const confidence = clamp(
      parseConfidence(item.identityConfidence, 0.35) * 0.28 +
      parseConfidence(item.conditionConfidence, 0.35) * 0.2 +
      compCoverage * 0.25 +
      recency * 0.12 +
      clamp((Number(item.demand) || 50) / 100) * 0.1 +
      forecast.confidence * 0.05,
    );
    const roi = profitExpected === null ? null : profitExpected / Math.max(1, acquisition);
    const marginComponent = clamp((roi + 0.15) / 1.15);
    const urgency = clamp(1 - hours / 72);
    const rawScore = 100 * clamp(
      marginComponent * 0.34 +
      clamp((Number(item.demand) || 50) / 100) * 0.2 +
      confidence * 0.2 +
      clamp((Number(item.rarity) || 0) / 100) * 0.1 +
      urgency * 0.06 +
      forecast.confidence * 0.1,
    );
    const freshness = freshnessFor(item);
    const endTimestamp = Date.parse(item.endsAt || "");
    const actionableSnapshot = item.status === "active"
      && Number.isFinite(endTimestamp)
      && endTimestamp > Date.now()
      && currentBid > 0
      && (freshness.className === "is-fresh" || freshness.className === "is-aging");
    const score = hasForecast && hasDecisionInputs && actionableSnapshot
      ? Math.round(rawScore)
      : Math.min(35, hasResaleEvidence ? Math.round(rawScore) : 15);
    let signal = "research";
    if (hasForecast && hasDecisionInputs && (profitExpected < 0 || maxBid < currentBid * 0.9)) signal = "avoid";
    else if (hasForecast && hasDecisionInputs && actionableSnapshot && score >= 70 && maxBid > currentBid && profitLow >= Number(s.minimumProfit || 0)) signal = "candidate";
    else if (hasForecast && hasDecisionInputs && actionableSnapshot && score >= 48 && profitExpected > 0) signal = "watch";
    if (["research", "avoid"].includes(item.riskGate)) signal = item.riskGate;
    return {
      expectedClose,
      modeledBid,
      currentBid,
      forecast,
      hasForecast,
      marketplaceFee,
      marketplaceFeeCost: resaleMedian * marketplaceFee / 100,
      taxRate,
      taxCost,
      buyerPremium,
      buyerPremiumCost,
      outboundShipping,
      repairReserve,
      returnReserve,
      shipping,
      shippingKnown,
      resaleLow,
      resaleMedian,
      resaleHigh,
      acquisition,
      currentAcquisition,
      sellingCosts: resaleMedian - netMedian,
      profitLow,
      profitExpected,
      profitHigh,
      profitAtCurrentBid,
      confidence: hasResaleEvidence ? confidence : Math.min(confidence, 0.2),
      score,
      signal,
      maxBid,
      roi,
      hours,
      hasResaleEvidence,
      resaleEvidenceCount,
      resaleEvidenceType: hasIntrinsicEvidence ? "intrinsic liquidation basis" : `${resaleEvidenceCount} exact-model sold comparable${resaleEvidenceCount === 1 ? "" : "s"}`,
      hasDecisionInputs,
      actionableSnapshot,
    };
  }

  function signalLabel(signal) {
    return { candidate: "Candidate", watch: "Watch", research: "Research", avoid: "Avoid" }[signal] || "Research";
  }

  function scoreColor(signal, dark = false) {
    if (signal === "candidate") return dark ? "#c7f36d" : "#7daa2c";
    if (signal === "watch") return "#d59035";
    if (signal === "avoid") return "#d95043";
    return "#6d91d9";
  }

  function timeLabel(item) {
    if (item.status === "ended") return "Ended";
    const hours = hoursRemaining(item);
    if (!Number.isFinite(hours)) return "End time unknown";
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m left`;
    if (hours < 48) return `${Math.round(hours)}h left`;
    return `${Math.round(hours / 24)}d left`;
  }

  function initialsFor(item) {
    if (item.initials) return item.initials;
    return String(item.title || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function renderOpportunityRow(item) {
    const a = assess(item);
    const selected = selectedId === item.id ? " is-selected" : "";
    const watched = item.watched ? " is-watched" : "";
    const statusText = item.status === "ended" ? "Ended" : timeLabel(item);
    const freshness = freshnessFor(item);
    const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
    const marketplace = marketplaceFor(item);
    const snapshotPlan = snapshotPlanFor(item);
    const imageUrl = safeHttpUrl(item.imageUrl);
    const authenticationBadge = item.authenticationStatus === "source-stated"
      ? '<span class="status-pill authentication-source">AUTH CLAIM</span>'
      : "";
    return `
      <article class="opportunity-row${selected}${sourceUrl ? " has-source-link" : ""}" data-select-id="${escapeHtml(item.id)}"${sourceUrl ? ` data-source-url="${escapeHtml(sourceUrl)}"` : ""} role="group" tabindex="0" aria-label="${escapeHtml(item.title)}; ${sourceUrl ? `press Enter to open on ${escapeHtml(marketplace.name)}` : "source listing URL unavailable"}">
        <div class="item-cell">
          ${imageUrl ? `<img class="item-thumbnail" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" />` : `<span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>`}
          <span class="item-copy">
            ${sourceUrl ? `<a class="row-title-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener" data-direct-listing>${escapeHtml(item.title)}</a>` : `<strong>${escapeHtml(item.title)}</strong>`}
            <small>${escapeHtml(marketplace.name)} · ${escapeHtml(item.category)} · ${escapeHtml(item.externalId)}</small>
            <span class="signal-line"><span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span><span class="status-pill">${statusText}</span><span class="snapshot-freshness ${freshness.className}" title="Observed ${escapeHtml(formatDateTime(freshness.observedAt))}">${escapeHtml(freshness.short)}</span><span class="snapshot-cadence ${escapeHtml(snapshotPlan.urgency)}">${escapeHtml(snapshotPlan.label)}</span>${authenticationBadge}${item.publishedResearch ? '<span class="status-pill research-source">PUBLISHED</span>' : ""}</span>
          </span>
          <span class="score-mini" style="--score:${a.score};--score-color:${scoreColor(a.signal)}" data-score="${a.score}" aria-label="Opportunity score ${a.score} out of 100"></span>
        </div>
        <div class="money-cell"><span>Observed bid</span><strong>${money(item.currentBid)}</strong><small>${a.hasForecast ? `Expected ${money(a.expectedClose)} · ` : "No learned close · "}${Number(item.bidCount) || 0} bids</small></div>
        <div class="money-cell"><span>Safe ceiling</span><strong>${a.hasDecisionInputs ? money(a.maxBid) : "Incomplete"}</strong><small>${a.hasDecisionInputs ? "after all configured costs" : a.shippingKnown ? "add resale evidence" : "shipping required"}</small></div>
        <div class="money-cell"><span>Expected profit</span><strong class="${a.profitExpected === null ? "" : a.profitExpected >= 0 ? "positive" : "negative"}">${a.profitExpected === null ? "Insufficient" : money(a.profitExpected)}</strong><small>${a.roi === null ? "needs verified forecast" : `${percent(a.roi)} ROI`}</small></div>
        <div class="row-actions">
          <button class="row-analyze" type="button" data-open-id="${escapeHtml(item.id)}" aria-label="Open BidAI analysis for ${escapeHtml(item.title)}">Analyze</button>
          ${sourceUrl ? `<a class="row-direct-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener" data-direct-listing title="Open source listing" aria-label="Open ${escapeHtml(item.title)} on its source site">↗</a>` : ""}
          <button class="row-watch${watched}" type="button" data-watch-id="${escapeHtml(item.id)}" aria-label="${item.watched ? "Remove from" : "Add to"} watchlist" aria-pressed="${item.watched ? "true" : "false"}">${item.watched ? "◆" : "◇"}</button>
        </div>
      </article>`;
  }

  function curveFor(item, assessment) {
    const points = (Array.isArray(item.observations) ? item.observations : [])
      .filter((point) => Number(point?.currentBid) >= 0)
      .sort((a, b) => Date.parse(a.observedAt || "") - Date.parse(b.observedAt || ""))
      .slice(-6);
    const observed = points.map((point, index) => ({
      label: index === points.length - 1
        ? "Now"
        : (() => {
            const date = new Date(point.observedAt);
            return Number.isNaN(date.getTime())
              ? `S${index + 1}`
              : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" });
          })(),
      value: Number(point.currentBid) || 0,
      observed: true,
      current: index === points.length - 1,
    }));
    if (!observed.length) observed.push({ label: "Now", value: Number(item.currentBid) || 0, observed: true, current: true });
    if (item.status !== "ended" && assessment.hasForecast) {
      observed.push({ label: "Close", value: assessment.expectedClose, observed: false, current: false });
    }
    const max = Math.max(...observed.map((point) => point.value), 1);
    return observed.map((point) => ({ ...point, height: Math.max(6, Math.round(point.value / max * 100)) }));
  }

  function resaleComparablesFor(item) {
    const cutoff = Date.parse(observedAtFor(item) || "") || Date.now();
    return (Array.isArray(item.comparableSales) ? item.comparableSales : [])
      .map((entry) => {
        const price = Number(entry.soldPrice ?? entry.finalPrice ?? entry.price);
        if (!(price > 0)) return null;
        const rawMatchScore = Number(entry.matchScore ?? 0);
        return {
          title: String(entry.title || "Comparable sale"),
          price,
          endedAt: entry.soldAt || entry.endedAt || null,
          source: String(entry.source || "Resale market"),
          url: safeHttpUrl(entry.url || entry.sourceUrl),
          matchReason: String(entry.matchReason || "Resale comparable"),
          matchScore: clamp(rawMatchScore > 1 ? rawMatchScore / 100 : rawMatchScore),
        };
      })
      .filter(Boolean)
      .filter((entry) => Number.isFinite(Date.parse(entry.endedAt || "")) && Date.parse(entry.endedAt) <= cutoff)
      .sort((a, b) => Date.parse(b.endedAt || "") - Date.parse(a.endedAt || ""))
      .slice(0, 12);
  }

  function renderComparableTable(comparables, type) {
    if (!comparables.length) {
      return `<div class="no-history-state"><strong>No ${escapeHtml(type)} evidence stored</strong><p>The automated source must attach real completed transactions before this section can support a forecast.</p></div>`;
    }
    return `<div class="comparable-sales-list"><table class="comparable-sales-table">
      <thead><tr><th scope="col">Comparable</th><th scope="col">Match</th><th scope="col">Ended</th><th scope="col">Price</th><th scope="col">Source</th></tr></thead>
      <tbody>${comparables.slice(0, 8).map((entry) => {
        const price = Number(entry.finalPrice ?? entry.soldPrice ?? entry.price) || 0;
        const url = safeHttpUrl(entry.url || entry.sourceUrl);
        const matchScore = Number(entry.matchScore) > 0 ? `${Math.round(clamp(entry.matchScore) * 100)}%` : "—";
        return `<tr>
          <td><strong>${escapeHtml(entry.title || "Comparable result")}</strong><small>${escapeHtml(entry.matchReason || entry.source || "Recorded outcome")}</small></td>
          <td>${matchScore}</td>
          <td>${escapeHtml((entry.endedAt || entry.soldAt) ? formatDateTime(entry.endedAt || entry.soldAt) : "Unknown")}</td>
          <td><strong>${money(price)}</strong></td>
          <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">View result ↗</a>` : escapeHtml(entry.source || "Recorded")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function renderDetail(item) {
    const container = $("[data-opportunity-detail]");
    if (!container) return;
    if (!item) {
      container.innerHTML = '<div class="empty-state"><span>⌁</span><h4>Select an opportunity</h4><p>Use Analyze to inspect the conservative bid model; clicking the listing row opens its source auction.</p></div>';
      return;
    }
    const a = assess(item);
    const curve = curveFor(item, a);
    const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
    const freshness = freshnessFor(item);
    const marketplace = marketplaceFor(item);
    const snapshotPlan = snapshotPlanFor(item);
    const acquisitionComparables = a.forecast.comparables || [];
    const resaleComparables = resaleComparablesFor(item);
    const maxWaterfall = Math.max(a.resaleMedian, a.acquisition, a.sellingCosts, Math.abs(a.profitExpected), 1);
    const width = (value) => `${Math.max(3, Math.min(100, Math.abs(value) / maxWaterfall * 100)).toFixed(1)}%`;
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? item.evidence
      : [
          { label: "Identity", value: item.identifiedAs || "Identity not yet verified" },
          { label: "Authentication", value: item.authenticationEvidence || "No authentication evidence supplied" },
          { label: "Forecast", value: a.hasForecast ? `${a.forecast.exactModelCount} exact-model outcomes` : "Insufficient exact-model outcomes" },
          { label: "Costs", value: a.shippingKnown ? "Inbound shipping recorded" : "Inbound shipping missing" },
        ];
    container.innerHTML = `
      <div class="detail-top">
        <div class="detail-eyebrow"><span class="section-kicker"><i></i> SELECTED ANALYSIS</span>${item.publishedResearch ? '<span class="record-source-chip published">PUBLISHED RECORD</span>' : '<span class="record-source-chip private">PRIVATE RECORD</span>'}</div>
        <div class="detail-title-row">
          <span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>
          <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(marketplace.name)} · ${escapeHtml(item.externalId)} · ${escapeHtml(item.category)}</p></div>
          <span class="score-ring" style="--score:${a.score};--score-color:${scoreColor(a.signal, true)}" data-score="${a.score}" aria-label="Opportunity score ${a.score} out of 100"></span>
        </div>
        <div class="detail-signal"><span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span><span>${escapeHtml(item.identifiedAs || "Identity requires verification")}</span><span class="snapshot-freshness ${freshness.className}">${escapeHtml(freshness.label)} · ${escapeHtml(freshness.short)}</span></div>
      </div>
      <div class="detail-body">
        <div class="bid-metrics">
          <div class="bid-metric"><span>${item.status === "ended" ? "Final recorded bid" : "Observed bid"}</span><strong>${money(item.status === "ended" && item.finalPrice ? item.finalPrice : item.currentBid)}</strong><small>${Number(item.bidCount) || 0} bids · ${timeLabel(item)} · ${escapeHtml(freshness.short)}</small></div>
          <div class="bid-metric"><span>Expected close</span><strong>${a.hasForecast ? money(a.expectedClose) : "Insufficient history"}</strong><small>${a.hasForecast ? `${money(a.forecast.low)}–${money(a.forecast.high)}` : `${a.forecast.exactModelCount}/5 exact-model outcomes`}</small></div>
          <div class="bid-metric primary"><span>Safe ceiling</span><strong>${a.hasDecisionInputs ? money(a.maxBid) : "Incomplete inputs"}</strong><small>${a.hasDecisionInputs ? "target profit preserved" : a.shippingKnown ? "resale evidence required" : "shipping cost required"}</small></div>
        </div>
        <section class="forecast-basis-panel ${a.hasForecast ? "is-available" : "is-insufficient"}">
          <div class="forecast-basis-head"><div><span>FORECAST BASIS</span><h4>${a.hasForecast ? escapeHtml(a.forecast.method) : "Insufficient similar completed auctions"}</h4></div><strong>${a.hasForecast ? `${Math.round(a.forecast.confidence * 100)}% model confidence` : "Not ranked"}</strong></div>
          <div class="forecast-basis-grid">
            <div><span>Exact-model sample</span><strong>${a.forecast.exactModelCount}</strong></div>
            <div><span>Bid-curve matches</span><strong>${a.forecast.curveCount}</strong></div>
            <div><span>Model version</span><strong>${escapeHtml(a.forecast.modelVersion)}</strong></div>
            <div><span>Forecast as of</span><strong>${escapeHtml(formatDateTime(a.forecast.asOf))}</strong></div>
            <div><span>Evidence cohort</span><strong>${a.forecast.evidenceHash ? escapeHtml(a.forecast.evidenceHash.slice(0, 12)) : `${a.forecast.exactModelCount} revalidated outcomes`}</strong></div>
          </div>
          ${a.forecast.sourceEstimate ? `<p class="source-estimate-note">Source estimate: <strong>${money(a.forecast.sourceEstimate)}</strong>. It is displayed for audit but is not treated as a learned forecast without five exact-model outcomes.</p>` : ""}
          ${!a.hasForecast ? `<p class="no-history-copy">${escapeHtml(a.forecast.method)}. Category-wide outcomes are shown only as reference and are not used to estimate this item.</p>` : ""}
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>${a.hasForecast ? "Expected-close profit waterfall" : "Observed-bid cost position"}</h4><span>${a.hasForecast ? `${money(a.forecast.low)}–${money(a.forecast.high)} close range` : "forecast withheld until evidence threshold is met"}</span></div>
          <div class="waterfall">
            <div class="waterfall-row"><span>Median resale</span><span class="waterfall-track"><i style="--width:${width(a.resaleMedian)}"></i></span><strong>${money(a.resaleMedian)}</strong></div>
            <div class="waterfall-row cost"><span>${a.hasForecast ? "Expected landed cost" : "Landed at observed bid"}</span><span class="waterfall-track"><i style="--width:${width(a.acquisition)}"></i></span><strong>−${a.shippingKnown ? money(a.acquisition) : "Shipping missing"}</strong></div>
            <div class="waterfall-row cost"><span>Sell + risk costs</span><span class="waterfall-track"><i style="--width:${width(a.sellingCosts)}"></i></span><strong>−${money(a.sellingCosts)}</strong></div>
            <div class="waterfall-row profit ${a.profitExpected !== null && a.profitExpected < 0 ? "negative" : ""}"><span>Expected profit</span><span class="waterfall-track"><i style="--width:${width(a.profitExpected)}"></i></span><strong>${a.profitExpected === null ? "Insufficient inputs" : money(a.profitExpected)}</strong></div>
          </div>
          ${a.profitExpected !== null ? `<div class="profit-scenarios">
            <div class="downside"><span>Conservative case</span><strong>${money(a.profitLow)}</strong><small>${money(a.resaleLow)} resale · ${money(a.forecast.high)} close</small></div>
            <div class="base"><span>Base case</span><strong>${money(a.profitExpected)}</strong><small>${money(a.resaleMedian)} resale · ${money(a.expectedClose)} close</small></div>
            <div class="upside"><span>Upside case</span><strong>${money(a.profitHigh)}</strong><small>${money(a.resaleHigh)} resale · ${money(a.forecast.low)} close</small></div>
          </div>` : ""}
        </section>
        <section class="detail-section cost-risk-panel">
          <div class="detail-section-heading"><h4>Full cost stack</h4><span>${a.shippingKnown ? "configured inputs" : "blocked by missing shipping"}</span></div>
          <div class="cost-risk-grid">
            <div><span>${a.hasForecast ? "Expected acquisition bid" : "Observed bid basis"}</span><strong>${money(a.modeledBid)}</strong></div>
            <div><span>Inbound shipping</span><strong>${a.shippingKnown ? money(a.shipping) : "Unknown"}</strong></div>
            <div><span>Buyer premium (${a.buyerPremium.toFixed(2)}%)</span><strong>${money(a.buyerPremiumCost)}</strong></div>
            <div><span>Purchase tax (${a.taxRate.toFixed(2)}%)</span><strong>${money(a.taxCost)}</strong></div>
            <div><span>Marketplace fee (${a.marketplaceFee.toFixed(2)}%)</span><strong>${money(a.marketplaceFeeCost)}</strong></div>
            <div><span>Outbound shipping</span><strong>${money(a.outboundShipping)}</strong></div>
            <div><span>Repair / testing reserve</span><strong>${money(a.repairReserve)}</strong></div>
            <div><span>Return / loss reserve</span><strong>${money(a.returnReserve)}</strong></div>
          </div>
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Bid development</h4><span>timestamped observations${a.hasForecast ? " + evidence-based close" : ""}</span></div>
          <div class="curve-chart" aria-label="Bid snapshot curve">
            ${curve.map((point) => `<span class="curve-bar ${point.observed ? "observed" : ""} ${point.current ? "current" : ""}" title="${escapeHtml(point.label)}: ${money(point.value)}"><i style="--height:${point.height}%"></i><span>${escapeHtml(point.label)}</span></span>`).join("")}
          </div>
          <div class="curve-caption"><span>First retained: ${money(curve[0].value)}</span><strong>${a.hasForecast ? `Expected: ${money(a.expectedClose)}` : "Expected close withheld"}</strong></div>
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Evidence check</h4><span>${percent(a.confidence)} confidence</span></div>
          <div class="evidence-grid">${evidence.slice(0, 4).map((entry) => `<div class="evidence-item"><span>${escapeHtml(entry.label)}</span><strong title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</strong></div>`).join("")}</div>
          <div class="analysis-factors-grid">
            <div><span>Demand signal</span><strong>${Math.round(Number(item.demand) || 0)}/100</strong></div>
            <div><span>Rarity signal</span><strong>${Math.round(Number(item.rarity) || 0)}/100</strong></div>
            <div><span>Identity confidence</span><strong>${percent(parseConfidence(item.identityConfidence, 0))}</strong></div>
            <div><span>Condition confidence</span><strong>${percent(parseConfidence(item.conditionConfidence, 0))}</strong></div>
          </div>
          <div class="risk-summary-card"><span>LISTING-SPECIFIC RISK</span><p>${escapeHtml(item.riskSummary || "No source-specific risk summary was supplied; identity and condition still require independent verification.")}</p><small>Resale basis: ${escapeHtml(a.resaleEvidenceType)}. Inbound shipping: ${a.shippingKnown ? "recorded" : "missing"}.</small></div>
        </section>
        <section class="detail-section comparable-sales">
          <div class="detail-section-heading"><h4>Auction-close comparables</h4><span>${acquisitionComparables.length} exact-model outcomes attached</span></div>
          ${renderComparableTable(acquisitionComparables, "exact-model auction")}
        </section>
        <section class="detail-section comparable-sales">
          <div class="detail-section-heading"><h4>Resale sold comparables</h4><span>${resaleComparables.length} completed sales attached</span></div>
          ${renderComparableTable(resaleComparables, "resale sold")}
        </section>
        ${a.forecast.categoryReferences.length ? `<section class="detail-section comparable-sales category-reference"><div class="detail-section-heading"><h4>Broader category reference</h4><span>not used in this forecast</span></div>${renderComparableTable(a.forecast.categoryReferences, "category reference")}</section>` : ""}
        <section class="detail-section detail-source-ledger">
          <div class="detail-section-heading"><h4>Source and timing</h4><span>audit trail</span></div>
          <div class="source-metadata-grid">
            <div><span>Marketplace</span><strong>${escapeHtml(marketplace.name)}</strong><small>${escapeHtml(item.source || marketplace.domain || "Feed-provided source")}</small></div>
            <div><span>Listing ID</span><strong>${escapeHtml(item.externalId || item.id)}</strong></div>
            <div><span>Observed</span><strong>${escapeHtml(formatDateTime(freshness.observedAt))}</strong><small>${escapeHtml(freshness.short)} · ${escapeHtml(freshness.label)}</small></div>
            <div><span>Scheduled end</span><strong>${escapeHtml(formatDateTime(item.endsAt))}</strong><small>${escapeHtml(timeLabel(item))}</small></div>
            <div><span>Snapshot policy</span><strong>${escapeHtml(snapshotPlan.label)}</strong><small>${snapshotPlan.nextDueAt ? `${snapshotPlan.due ? "Due now" : `Next ${escapeHtml(formatDateTime(snapshotPlan.nextDueAt))}`}` : "Outcome capture complete"}</small></div>
            <div><span>Bid count</span><strong>${Number(item.bidCount) || 0}</strong></div>
            <div><span>Inbound shipping basis</span><strong>${a.shippingKnown ? money(a.shipping) : "Unknown"}</strong><small>${item.shippingQuoted === null && item.shippingAssumed ? "assumed, not quoted" : item.shippingKnown === false ? "not supplied" : "recorded input"}</small></div>
            <div><span>Normalized model key</span><strong title="${escapeHtml(item.modelKey || "Not supplied")}">${escapeHtml(item.modelKey || "Not supplied")}</strong><small>exact-match grouping key</small></div>
            <div><span>Forecast state</span><strong>${a.hasForecast ? "Verified evidence threshold met" : "Insufficient exact-model history"}</strong><small>${escapeHtml((a.forecast.reasonCodes || []).join(", ") || a.forecast.method)}</small></div>
          </div>
        </section>
        <div class="detail-actions">
          ${sourceUrl ? `<a class="button button-dark direct-listing-button" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener">Open on ${escapeHtml(marketplace.name)} <span aria-hidden="true">↗</span></a>` : ""}
          <button class="button button-primary" type="button" data-watch-id="${escapeHtml(item.id)}">${item.watched ? "Remove watch" : "Watch item"}</button>
          <button class="button button-quiet" type="button" data-update-id="${escapeHtml(item.id)}">Record update</button>
        </div>
        <p class="risk-note">A listing is never promoted from a source estimate alone. BidAI Pro requires real exact-model outcomes for a learned closing forecast and labels stale or incomplete inputs explicitly.</p>
      </div>`;
  }

  function filteredItems() {
    const query = String($("#global-search")?.value || "").trim().toLowerCase();
    const signal = $("#signal-filter")?.value || "all";
    const category = $("#category-filter")?.value || "all";
    const vertical = $("#vertical-filter")?.value || "all";
    const authentication = $("#authentication-filter")?.value || "all";
    const source = $("#source-filter")?.value || "all";
    return allItems()
      .filter((item) => {
        const haystack = [item.title, item.category, item.resaleVertical, item.authenticationEvidence, item.externalId, item.identifiedAs, item.marketplaceName, item.source].join(" ").toLowerCase();
        const assessment = assess(item);
        return (!query || haystack.includes(query)) &&
          (signal === "all" || assessment.signal === signal) &&
          (category === "all" || item.category === category) &&
          (vertical === "all" || (item.resaleVertical || "Other") === vertical) &&
          (authentication === "all" || (item.authenticationStatus || "not-supplied") === authentication) &&
          (source === "all" || item.sourceKey === source);
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        const scoreDifference = assess(b).score - assess(a).score;
        if (scoreDifference) return scoreDifference;
        const aEnds = Date.parse(a.endsAt || "");
        const bEnds = Date.parse(b.endsAt || "");
        if (Number.isFinite(aEnds) && Number.isFinite(bEnds)) return aEnds - bEnds;
        if (Number.isFinite(aEnds)) return -1;
        if (Number.isFinite(bEnds)) return 1;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
  }

  function populateCategories() {
    const select = $("#category-filter");
    if (!select) return;
    const current = select.value;
    const categories = [...new Set(allItems().map((item) => item.category).filter(Boolean))].sort();
    select.innerHTML = '<option value="all">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    select.value = categories.includes(current) ? current : "all";
  }

  function populateSources() {
    const select = $("#source-filter");
    if (!select) return;
    const current = select.value;
    const items = allItems();
    const itemCounts = new Map();
    for (const item of items) itemCounts.set(item.sourceKey, (itemCounts.get(item.sourceKey) || 0) + 1);
    const known = AUCTION_MARKETS.map((market) => ({ ...market, count: itemCounts.get(market.key) || 0 }));
    const other = [...new Set(items.map((item) => item.sourceKey).filter((key) => key && !AUCTION_MARKETS.some((market) => market.key === key)))]
      .map((key) => {
        const item = items.find((entry) => entry.sourceKey === key);
        return { key, name: item?.marketplaceName || key, count: itemCounts.get(key) || 0 };
      });
    const sources = [...known, ...other];
    select.innerHTML = '<option value="all">All marketplaces</option>' + sources
      .map((market) => `<option value="${escapeHtml(market.key)}">${escapeHtml(market.name)}${market.count ? ` (${market.count})` : ""}</option>`)
      .join("");
    select.value = sources.some((market) => market.key === current) ? current : "all";
  }

function renderMarketplaceCoverage() {
    const container = $("[data-marketplace-grid]");
    if (!container) return;
    const items = allItems();
    const observedMarkets = [...new Set(items.map((item) => item.sourceKey).filter(Boolean))]
      .filter((key) => !AUCTION_MARKETS.some((market) => market.key === key))
      .map((key) => marketplaceFor(items.find((item) => item.sourceKey === key)));
    container.innerHTML = [...AUCTION_MARKETS, ...observedMarkets].map((market) => {
      const marketItems = items.filter((item) => item.sourceKey === market.key);
      const active = marketItems.filter((item) => item.status === "active");
      const monitored = marketItems.filter((item) => item.status === "active" || !(Number(item.finalPrice) > 0));
      const observations = marketItems.reduce((total, item) => total + Math.max(1, Array.isArray(item.observations) ? item.observations.length : 0), 0);
      const latest = marketItems.map((item) => Date.parse(observedAtFor(item) || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const plans = monitored.map(snapshotPlanFor).filter((plan) => plan.intervalMinutes);
      const fastest = plans.length ? Math.min(...plans.map((plan) => plan.intervalMinutes)) : null;
      const connected = marketItems.length > 0;
      return `<article class="marketplace-card ${connected ? "is-connected" : "is-awaiting"}">
        <div class="marketplace-card-head"><span class="marketplace-monogram" aria-hidden="true">${escapeHtml(market.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase())}</span><div><strong>${escapeHtml(market.name)}</strong><small>${connected ? "REAL RECORDS CONNECTED" : "AWAITING AUTHORIZED FEED"}</small></div></div>
        <p>${escapeHtml(market.focus)}</p>
        <dl><div><dt>Active</dt><dd>${active.length}</dd></div><div><dt>Snapshots</dt><dd>${observations}</dd></div><div><dt>Fastest cadence</dt><dd>${fastest ? (fastest === 0.5 ? "30s" : fastest < 60 ? `${fastest}m` : "1h") : "—"}</dd></div></dl>
        <div class="marketplace-card-footer"><span>${latest ? `Latest ${escapeHtml(formatDateTime(new Date(latest).toISOString()))}` : "No listing data stored"}</span><a href="${escapeHtml(market.homeUrl)}" target="_blank" rel="noreferrer noopener">Visit site ↗</a></div>
      </article>`;
    }).join("");
  }

  function renderStats() {
    const active = allItems().filter((item) => item.status === "active");
    const assessments = active.map(assess);
    const forecasted = assessments.filter((item) => item.hasForecast && item.profitExpected !== null);
    const upside = forecasted.reduce((total, item) => total + Math.max(0, item.profitExpected), 0);
    const urgent = active.filter((item) => hoursRemaining(item) <= 12).length;
    const confidence = forecasted.length ? forecasted.reduce((total, item) => total + item.forecast.confidence, 0) / forecasted.length : 0;
    const observations = allItems().reduce((total, item) => total + (Array.isArray(item.observations) ? item.observations.length : 0), 0);
    const connectedMarkets = new Set(allItems().map((item) => item.sourceKey).filter(Boolean)).size;
    $("[data-stat-upside]").textContent = money(upside);
    $("[data-stat-urgent]").textContent = String(urgent);
    $("[data-stat-confidence]").textContent = percent(confidence);
    $("[data-stat-observations]").textContent = observations.toLocaleString("en-US");
    $$('[data-opportunity-count]').forEach((el) => { el.textContent = String(active.length); });
    $$('[data-watch-count]').forEach((el) => { el.textContent = String(workspace.watchIds.length); });
    $$('[data-research-count]').forEach((el) => { el.textContent = String(PUBLISHED_RESEARCH.items.length); });
    $$('[data-market-count]').forEach((el) => { el.textContent = String(connectedMarkets); });
    $$('[data-research-observed]').forEach((el) => {
      const observed = PUBLISHED_RESEARCH.observedAt ? new Date(PUBLISHED_RESEARCH.observedAt) : null;
      const formatted = observed && !Number.isNaN(observed.getTime())
        ? observed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "No published pass";
      const badge = el.closest(".snapshot-freshness");
      if (badge) {
        const freshness = freshnessFor({ observedAt: PUBLISHED_RESEARCH.observedAt });
        badge.classList.remove("is-fresh", "is-aging", "is-stale", "is-invalid", "is-unknown");
        badge.classList.add(freshness.className);
        el.textContent = PUBLISHED_RESEARCH.observedAt ? `${formatted} · ${freshness.short}` : formatted;
      } else {
        el.textContent = formatted;
      }
    });
    $$('[data-source-status]').forEach((el) => {
      const mode = String(PUBLISHED_RESEARCH.sourceMode || "").toLowerCase();
      let status = "Research snapshots loaded";
      if (!PUBLISHED_RESEARCH.items.length) status = "Awaiting research data";
      else if (connectedMarkets > 1) status = `${connectedMarkets} auction marketplaces connected`;
      else if (mode.includes("shopgoodwill")) status = `${PUBLISHED_RESEARCH.items.length.toLocaleString("en-US")} ShopGoodwill listings loaded`;
      else if (mode.includes("apify")) status = "Apify dataset loaded";
      else if (mode.includes("authorized")) status = "Authorized feed loaded";
      else if (mode.includes("manual")) status = "Manual research pass loaded";
      el.textContent = status;
    });
    renderMarketplaceCoverage();
  }

  function renderOpportunities() {
    populateCategories();
    populateSources();
    const items = filteredItems();
    const visibleItems = items.slice(0, visibleQueueLimit);
    const list = $("[data-opportunity-list]");
    const empty = $("[data-queue-empty]");
    if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id || "";
    list.innerHTML = visibleItems.map(renderOpportunityRow).join("");
    empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    const pagination = $("[data-queue-pagination]");
    const count = $("[data-queue-visible-count]");
    const loadMore = $("[data-load-more]");
    if (pagination) pagination.hidden = items.length === 0;
    if (count) count.textContent = `Showing ${visibleItems.length.toLocaleString()} of ${items.length.toLocaleString()} matching real listings`;
    if (loadMore) loadMore.hidden = visibleItems.length >= items.length;
    renderDetail(items.find((item) => item.id === selectedId) || items[0]);
    renderStats();
  }

  function resetQueueAndRender() {
    visibleQueueLimit = QUEUE_PAGE_SIZE;
    renderOpportunities();
  }

  function renderWatchlist() {
    const watched = allItems().filter((item) => item.watched);
    const grid = $("[data-watchlist-grid]");
    const empty = $("[data-watch-empty]");
    grid.innerHTML = watched.map((item) => {
      const a = assess(item);
      const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
      const marketplace = marketplaceFor(item);
      return `<article class="watch-card">
        <div class="watch-card-top"><span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span><div><h4>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h4><p>${escapeHtml(marketplace.name)} · ${escapeHtml(item.category)} · ${timeLabel(item)}</p></div></div>
        <div class="watch-card-metrics"><div><span>Observed bid</span><strong>${money(item.currentBid)}</strong></div><div><span>Expected close</span><strong>${a.hasForecast ? money(a.expectedClose) : "Insufficient"}</strong></div><div><span>Safe ceiling</span><strong>${a.hasDecisionInputs ? money(a.maxBid) : "Incomplete"}</strong></div></div>
        <div class="watch-card-actions"><button class="button button-primary" type="button" data-open-id="${escapeHtml(item.id)}">Open analysis</button>${sourceUrl ? `<a class="button button-dark" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener">Source listing ↗</a>` : ""}<button class="button button-quiet" type="button" data-watch-id="${escapeHtml(item.id)}">Remove</button></div>
      </article>`;
    }).join("");
    grid.hidden = watched.length === 0;
    empty.hidden = watched.length > 0;
    renderStats();
  }

  function learningSamples() {
    const calibrationHorizonHours = 6;
    return allItems().flatMap((item) => {
      if (item.status !== "ended" || !(Number(item.finalPrice) > 0)) return [];
      const observations = Array.isArray(item.observations) ? item.observations : [];
      const endedAt = Date.parse(item.endsAt || "");
      if (!Number.isFinite(endedAt)) return [];
      const priorForecasts = observations
        .filter((entry) => isVerifiedForecast(entry.forecast))
        .filter((entry) => {
          const observed = Date.parse(entry.observedAt || "");
          const forecastAsOf = Date.parse(entry.forecast?.asOf || "");
          const exactComparables = exactAuctionComparables({ ...item, observedAt: entry.forecast.asOf });
          const hasEvidenceIds = Object.prototype.hasOwnProperty.call(entry.forecast, "evidenceIds");
          const evidenceIds = hasEvidenceIds && Array.isArray(entry.forecast.evidenceIds)
            ? new Set(entry.forecast.evidenceIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean))
            : null;
          const comparableKeys = new Set(exactComparables.map((comparable) => comparableKey(comparable)));
          const evidenceRevalidated = hasEvidenceIds
            ? evidenceIds !== null
              && evidenceIds.size >= 5
              && [...evidenceIds].every((id) => comparableKeys.has(id))
            : exactComparables.length >= 5;
          return Number.isFinite(observed)
            && forecastAsOf <= observed + 300000
            && observed - forecastAsOf <= 7200000
            && Number(entry.forecast?.low) >= Math.max(0, Number(entry.currentBid) || 0)
            && observed <= endedAt
            && forecastAsOf <= endedAt
            && evidenceRevalidated;
        })
        .map((entry) => ({
          forecast: entry.forecast,
          horizonHours: (endedAt - Date.parse(entry.forecast.asOf)) / 3600000,
        }))
        .filter((entry) => entry.horizonHours >= 3 && entry.horizonHours <= 9)
        .sort((a, b) => Math.abs(a.horizonHours - calibrationHorizonHours) - Math.abs(b.horizonHours - calibrationHorizonHours));
      const prior = priorForecasts[0];
      const predicted = Number(prior?.forecast?.expected || 0);
      if (!(predicted > 0)) return [];
      return [{ category: item.category || "Unclassified", modelKey: item.modelKey || "", predicted, actual: Number(item.finalPrice), horizonHours: prior.horizonHours }];
    });
  }

  function renderLearning() {
    const samples = learningSamples();
    if (!samples.length) {
      $("[data-learning-summary]").innerHTML = `
        <article class="learning-metric accent"><span>6-hour outcomes</span><strong>0</strong><small>waiting for matched forecast cycles</small></article>
        <article class="learning-metric"><span>Typical 6-hour error</span><strong>—</strong><small>requires prior forecasts and outcomes</small></article>
        <article class="learning-metric"><span>Prediction bias</span><strong>—</strong><small>no production sample yet</small></article>
        <article class="learning-metric"><span>Within 15%</span><strong>—</strong><small>no production sample yet</small></article>`;
      $("[data-learning-table]").innerHTML = '<tr><td colspan="5"><div class="no-history-state"><strong>No completed 6-hour forecast cycle yet</strong><p>A verified forecast captured three to nine hours before close must be paired with the real final price.</p></div></td></tr>';
      return;
    }
    const errors = samples.map((sample) => Math.abs(sample.actual - sample.predicted) / Math.max(1, sample.actual));
    const ratios = samples.map((sample) => sample.actual / Math.max(1, sample.predicted));
    const typicalError = median(errors);
    const bias = median(ratios) - 1;
    const within15 = samples.filter((sample) => Math.abs(sample.actual - sample.predicted) / Math.max(1, sample.actual) <= 0.15).length / Math.max(1, samples.length);
    $("[data-learning-summary]").innerHTML = `
      <article class="learning-metric accent"><span>6-hour outcomes</span><strong>${samples.length}</strong><small>real recorded final prices</small></article>
      <article class="learning-metric"><span>Typical 6-hour error</span><strong>${percent(typicalError)}</strong><small>median absolute percentage error</small></article>
      <article class="learning-metric"><span>Prediction bias</span><strong>${bias >= 0 ? "+" : ""}${percent(bias)}</strong><small>${bias > 0.02 ? "closes above forecast" : bias < -0.02 ? "closes below forecast" : "near neutral"}</small></article>
      <article class="learning-metric"><span>Within 15%</span><strong>${percent(within15)}</strong><small>share of expected closes in range</small></article>`;
    const groups = Object.groupBy
      ? Object.groupBy(samples, (sample) => sample.category)
      : samples.reduce((result, sample) => {
          (result[sample.category] ||= []).push(sample);
          return result;
        }, {});
    $("[data-learning-table]").innerHTML = Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, categorySamples]) => {
        const categoryError = median(categorySamples.map((sample) => Math.abs(sample.actual - sample.predicted) / Math.max(1, sample.actual)));
        const categoryBias = median(categorySamples.map((sample) => sample.actual / Math.max(1, sample.predicted))) - 1;
        const signal = categorySamples.length < 3 ? "Early" : categoryError <= 0.15 ? "Calibrated" : "Learning";
        return `<tr><td><strong>${escapeHtml(category)}</strong></td><td>${categorySamples.length}</td><td><span class="calibration-bar"><i style="--width:${Math.min(100, categoryError * 300)}%"></i>${percent(categoryError)}</span></td><td>${categoryBias >= 0 ? "+" : ""}${percent(categoryBias)}</td><td><span class="signal-pill ${signal === "Calibrated" ? "candidate" : "watch"}">${signal}</span></td></tr>`;
      }).join("");
  }

  function renderSettingsForm() {
    const form = $("#settings-form");
    if (!form) return;
    Object.entries(workspace.settings).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value;
    });
  }

  function renderCurrentView() {
    if (activeView === "opportunities") renderOpportunities();
    if (activeView === "watchlist") renderWatchlist();
    if (activeView === "learning") renderLearning();
    if (activeView === "settings") renderSettingsForm();
    if (activeView === "sources") renderStats();
  }

  function setView(name, updateHash = true) {
    if (!VIEW_TITLES[name]) name = "opportunities";
    activeView = name;
    $$('[data-view]').forEach((section) => section.classList.toggle("is-active", section.dataset.view === name));
    $$('.nav-item[data-view-target]').forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === name));
    $("[data-view-title]").textContent = VIEW_TITLES[name];
    if (updateHash && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    closeMenu();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleWatch(id) {
    if (workspace.watchIds.includes(id)) {
      workspace.watchIds = workspace.watchIds.filter((value) => value !== id);
      toast("Removed from watchlist.");
    } else {
      workspace.watchIds.push(id);
      toast("Saved to your local watchlist.");
    }
    saveWorkspace();
    renderOpportunities();
    if (activeView === "watchlist") renderWatchlist();
  }

  function openItem(id) {
    selectedId = id;
    setView("opportunities");
  }

  function closeMenu() {
    document.body.classList.remove("menu-open");
    const toggle = $("[data-menu-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function toast(message, type = "success") {
    const region = $("[data-toast-region]");
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.innerHTML = `<i>${type === "error" ? "!" : "✓"}</i><span>${escapeHtml(message)}</span>`;
    region.appendChild(element);
    window.setTimeout(() => element.remove(), 3600);
  }

  function lookup(record, names) {
    const entries = Object.entries(record || {});
    for (const name of names) {
      const match = entries.find(([candidate]) => cleanKey(candidate) === name);
      if (match && match[1] !== "" && match[1] !== null && match[1] !== undefined) return match[1];
    }
    return undefined;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const next = text[index + 1];
      if (character === '"' && quoted && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === "," && !quoted) {
        row.push(field.trim());
        field = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && next === "\n") index += 1;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    const [headers, ...values] = rows;
    if (!headers) return [];
    return values.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
  }

  function parseJson(text) {
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
      for (const name of ["items", "listings", "auctions", "records", "snapshots"]) {
        if (Array.isArray(payload[name])) return payload[name];
      }
      return [payload];
    }
    return [];
  }

  function safeDate(value, fallback) {
    const parsed = new Date(value || fallback);
    return Number.isNaN(parsed.getTime()) ? new Date(fallback).toISOString() : parsed.toISOString();
  }

  function optionalDate(value) {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function normalizeSnapshot(record, index = 0, sourceName = "Manual entry") {
    const title = String(lookup(record, aliases.title) ?? record.title ?? "").trim();
    if (!title) return null;
    const rawId = String(lookup(record, aliases.externalId) ?? record.externalId ?? `snapshot-${index + 1}`).trim();
    const externalId = rawId || `snapshot-${index + 1}`;
    const currentBid = Math.max(0, parseMoney(lookup(record, aliases.currentBid) ?? record.currentBid));
    const finalPrice = Math.max(0, parseMoney(lookup(record, aliases.finalPrice) ?? record.finalPrice));
    const rawShipping = lookup(record, aliases.shipping) ?? record.shipping;
    const parsedShipping = parseOptionalMoney(rawShipping);
    const shipping = parsedShipping === null ? null : Math.max(0, parsedShipping);
    const bidCount = Math.max(0, Math.round(Number(lookup(record, aliases.bidCount) ?? record.bidCount) || 0));
    const endsAt = optionalDate(lookup(record, aliases.endsAt) ?? record.endsAt);
    const observedAt = safeDate(lookup(record, aliases.observedAt) ?? record.observedAt, new Date().toISOString());
    const statusValue = String(lookup(record, aliases.status) ?? record.status ?? "active").toLowerCase();
    const status = finalPrice > 0 || statusValue.includes("ended") || statusValue.includes("closed") || (endsAt && new Date(endsAt).getTime() <= Date.now()) ? "ended" : "active";
    const expectedProvided = parseMoney(lookup(record, aliases.expectedClose) ?? record.expectedClose);
    const expectedClose = expectedProvided > 0 ? expectedProvided : 0;
    const modelKey = String(lookup(record, aliases.modelKey) ?? record.modelKey ?? "").trim();
    const comparableSales = Array.isArray(record.comparableSales) ? record.comparableSales.slice(0, 50) : [];
    const qualifyingComparableSales = comparableSales
      .filter((entry) => modelKey && normalizedModelKey(entry?.modelKey || entry?.compGroup || entry?.similarItemKey) === normalizedModelKey(modelKey))
      .filter((entry) => {
        const ended = Date.parse(entry?.soldAt || entry?.endedAt || "");
        return Number.isFinite(ended) && ended <= Date.parse(observedAt);
      });
    const comparablePrices = [...new Map(qualifyingComparableSales
      .map((entry) => [comparableKey(entry), Number(entry?.soldPrice ?? entry?.finalPrice ?? entry?.price)])
      .filter(([, value]) => value > 0)).values()];
    const suppliedResaleMedian = Math.max(0, parseMoney(lookup(record, aliases.resaleMedian) ?? record.resaleMedian));
    const resaleMedian = suppliedResaleMedian || quantile(comparablePrices, 0.5);
    const resaleLow = Math.max(0, parseMoney(lookup(record, aliases.resaleLow) ?? record.resaleLow)) || quantile(comparablePrices, 0.2);
    const resaleHigh = Math.max(0, parseMoney(lookup(record, aliases.resaleHigh) ?? record.resaleHigh)) || quantile(comparablePrices, 0.8);
    const identityConfidence = parseConfidence(lookup(record, aliases.identityConfidence) ?? record.identityConfidence, resaleMedian ? 0.42 : 0.35);
    const conditionConfidence = parseConfidence(lookup(record, aliases.conditionConfidence) ?? record.conditionConfidence, 0.35);
    const demand = parseScore(lookup(record, aliases.demand) ?? record.demand, 50);
    const rarity = parseScore(lookup(record, aliases.rarity) ?? record.rarity, 0);
    const compCount = Math.max(0, Math.round(Number(lookup(record, aliases.compCount) ?? record.compCount) || comparablePrices.length));
    const compRecencyDays = Math.max(0, Math.round(Number(lookup(record, aliases.compRecencyDays) ?? record.compRecencyDays) || 365));
    const optionalNumber = (name) => {
      const value = lookup(record, aliases[name]) ?? record[name];
      const parsed = parseOptionalMoney(value);
      return parsed === null ? undefined : Math.max(0, parsed);
    };
    const source = String(lookup(record, aliases.source) ?? record.source ?? sourceName);
    const url = String(lookup(record, aliases.url) ?? record.url ?? "").trim() || null;
    const sourceKey = marketplaceFor({
      sourceKey: lookup(record, aliases.sourceKey) ?? record.sourceKey,
      source,
      url,
    }).key;
    const id = `user-${cleanKey(sourceKey) || "source"}-${cleanKey(externalId) || cleanKey(title) || Date.now()}`;
    return {
      id,
      externalId,
      source,
      sourceKey,
      url,
      title,
      category: String(lookup(record, aliases.category) ?? record.category ?? "Unclassified").trim() || "Unclassified",
      modelKey,
      forecastBasis: String(lookup(record, aliases.forecastBasis) ?? record.forecastBasis ?? "").trim(),
      initials: initialsFor({ title }),
      accent: "silver",
      status,
      currentBid: Math.max(currentBid, finalPrice || 0),
      shipping,
      bidCount,
      endsAt,
      expectedClose,
      resaleLow,
      resaleMedian,
      resaleHigh,
      finalPrice: finalPrice || null,
      identityConfidence,
      conditionConfidence,
      rarity,
      demand,
      compCount,
      compRecencyDays,
      identifiedAs: String(lookup(record, aliases.identifiedAs) ?? record.identifiedAs ?? "User-provided snapshot; identity not independently verified"),
      marketplaceFee: optionalNumber("marketplaceFee"),
      taxRate: optionalNumber("taxRate"),
      buyerPremium: optionalNumber("buyerPremium"),
      outboundShipping: optionalNumber("outboundShipping"),
      repairReserve: optionalNumber("repairReserve"),
      returnReserve: optionalNumber("returnReserve"),
      shippingKnown: shipping !== null,
      comparableSales,
      auctionComparables: Array.isArray(record.auctionComparables) ? record.auctionComparables.slice(0, 50) : [],
      forecast: record.forecast && typeof record.forecast === "object" ? record.forecast : null,
      observedAt,
      observations: [{
        observedAt,
        currentBid: Math.max(currentBid, finalPrice || 0),
        bidCount,
        expectedClose,
        status,
        ...(record.forecast && typeof record.forecast === "object" ? { forecast: record.forecast } : {}),
      }],
      evidence: [
        { label: "Source", value: "User-provided snapshot" },
        { label: "Resale", value: resaleMedian ? "User estimate supplied" : "Needs sold comps" },
        { label: "Risk", value: "Condition unverified" },
      ],
    };
  }

  function mergeSnapshot(snapshot) {
    invalidateHistoricalIndex();
    const snapshotSourceKey = marketplaceFor(snapshot).key;
    const index = workspace.userItems.findIndex((item) => item.id === snapshot.id || (
      marketplaceFor(item).key === snapshotSourceKey
      && cleanKey(item.externalId) === cleanKey(snapshot.externalId)
    ));
    if (index >= 0) {
      const existing = workspace.userItems[index];
      const bidIncreased = Number(snapshot.currentBid) > Number(existing.currentBid);
      const nextSnapshot = bidIncreased ? snapshot : {
        ...snapshot,
        currentBid: existing.currentBid,
        bidCount: existing.bidCount,
        expectedClose: existing.expectedClose,
        observedAt: existing.observedAt,
        forecast: existing.forecast,
      };
      const history = bidIncreased
        ? [...(Array.isArray(existing.observations) ? existing.observations : []), ...snapshot.observations].slice(-250)
        : (Array.isArray(existing.observations) ? existing.observations : []);
      workspace.userItems[index] = {
        ...existing,
        ...nextSnapshot,
        id: existing.id,
        observations: history,
        createdAt: existing.createdAt || existing.observedAt,
        updatedAt: bidIncreased ? snapshot.observedAt : existing.updatedAt,
      };
      return { id: existing.id, updated: true };
    }
    workspace.userItems.push({ ...snapshot, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt });
    return { id: snapshot.id, updated: false };
  }

  async function importFiles(files) {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        const isJson = file.name.toLowerCase().endsWith(".json");
        const rawPayload = isJson ? JSON.parse(text) : null;
        const isWorkspaceBackup = rawPayload && rawPayload.product === "BidAI Pro" && Array.isArray(rawPayload.items);
        const records = isJson ? parseJson(text) : parseCsv(text);
        if (records.length > MAX_IMPORT_ROWS) throw new Error(`Imports are limited to ${MAX_IMPORT_ROWS.toLocaleString()} rows per file.`);
        if (isWorkspaceBackup && rawPayload.settings && typeof rawPayload.settings === "object") {
          workspace.settings = { ...DEFAULT_SETTINGS, ...rawPayload.settings };
        }
        records.forEach((record, index) => {
          const snapshot = normalizeSnapshot(record, index, `User import · ${file.name}`);
          if (!snapshot) {
            skipped += 1;
            return;
          }
          if (isWorkspaceBackup && Array.isArray(record.observations) && record.observations.length) {
            snapshot.observations = record.observations.slice(-250).map((entry) => ({
              observedAt: safeDate(entry.observedAt, snapshot.observedAt),
              currentBid: Math.max(0, Number(entry.currentBid) || 0),
              bidCount: Math.max(0, Math.round(Number(entry.bidCount) || 0)),
              expectedClose: Math.max(0, Number(entry.expectedClose) || 0),
              status: entry.status === "ended" ? "ended" : "active",
              ...(entry.forecast && typeof entry.forecast === "object" ? { forecast: entry.forecast } : {}),
            }));
          }
          const result = mergeSnapshot(snapshot);
          imported += 1;
          if (result.updated) updated += 1;
          selectedId = result.id;
        });
        if (isWorkspaceBackup && Array.isArray(rawPayload.watchIds)) {
          workspace.watchIds = [...new Set([...workspace.watchIds, ...rawPayload.watchIds.map(String)])];
        }
      } catch (error) {
        toast(`${file.name}: ${error.message || "Could not read file."}`, "error");
      }
    }
    saveWorkspace();
    renderStats();
    renderOpportunities();
    if (imported) {
      toast(`${imported} snapshot${imported === 1 ? "" : "s"} saved; ${updated} updated existing items${skipped ? `; ${skipped} skipped` : ""}.`);
      setView("opportunities");
    }
  }

  function fillSnapshotForm(id) {
    const item = allItems().find((candidate) => candidate.id === id);
    if (!item) return;
    const form = $("#snapshot-form");
    const values = {
      title: item.title,
      externalId: item.externalId,
      category: item.category,
      modelKey: item.modelKey || "",
      url: item.url || "",
      currentBid: item.currentBid,
      shipping: item.shipping,
      bidCount: item.bidCount,
      endsAt: item.endsAt ? new Date(item.endsAt).toISOString().slice(0, 16) : "",
      expectedClose: item.expectedClose,
      finalPrice: item.finalPrice || "",
      resaleLow: item.resaleLow,
      resaleMedian: item.resaleMedian,
      resaleHigh: item.resaleHigh,
      status: item.status,
    };
    Object.entries(values).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value ?? ""; });
    setView("sources");
    window.setTimeout(() => {
      $("#manual-snapshot-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#snapshot-current")?.focus();
    }, 80);
  }

  function addSnapshot() {
    $("#snapshot-form")?.reset();
    setView("sources");
    window.setTimeout(() => {
      $("#manual-snapshot-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#snapshot-title")?.focus();
    }, 80);
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportWorkspace() {
    const payload = {
      product: "BidAI Pro",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourcePolicy: "Production records from published feeds and user-provided snapshots only.",
      settings: workspace.settings,
      watchIds: workspace.watchIds,
      items: workspace.userItems,
    };
    downloadBlob(JSON.stringify(payload, null, 2), `bidaipro-workspace-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    toast("Private workspace exported.");
  }

  function downloadTemplate() {
    const csv = [
      "id,source_key,source,title,category,model_key,url,current_bid,shipping,bid_count,ends_at,source_estimate,resale_low,resale_median,resale_high,demand,rarity,identity_confidence,condition_confidence,final_price,status,observed_at",
    ].join("\r\n");
    downloadBlob(csv, "bidaipro-snapshot-template.csv", "text/csv;charset=utf-8");
    toast("CSV template downloaded.");
  }

  function saveSettings(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    workspace.settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, Math.max(0, Number(data.get(key)) || 0)]));
    saveWorkspace();
    renderStats();
    toast("Cost assumptions saved.");
  }

  function handleManualSnapshot(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    data.source = "Manual user snapshot";
    data.observedAt = new Date().toISOString();
    const snapshot = normalizeSnapshot(data, 0, "Manual user snapshot");
    if (!snapshot) {
      toast("Add a listing title before saving.", "error");
      return;
    }
    const result = mergeSnapshot(snapshot);
    selectedId = result.id;
    saveWorkspace();
    form.reset();
    toast(result.updated ? "Item updated and observation preserved." : "Snapshot added to your private workspace.");
    setView("opportunities");
  }

  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view-target]");
    if (viewButton) {
      setView(viewButton.dataset.viewTarget);
      return;
    }
    const importButton = event.target.closest("[data-import-trigger]");
    if (importButton) {
      $("#snapshot-file").click();
      return;
    }
    if (event.target.closest("[data-add-snapshot]")) {
      addSnapshot();
      return;
    }
    if (event.target.closest("[data-load-more]")) {
      visibleQueueLimit += QUEUE_PAGE_SIZE;
      renderOpportunities();
      return;
    }
    const watchButton = event.target.closest("[data-watch-id]");
    if (watchButton) {
      event.stopPropagation();
      toggleWatch(watchButton.dataset.watchId);
      return;
    }
    const openButton = event.target.closest("[data-open-id]");
    if (openButton) {
      openItem(openButton.dataset.openId);
      return;
    }
    const updateButton = event.target.closest("[data-update-id]");
    if (updateButton) {
      fillSnapshotForm(updateButton.dataset.updateId);
      return;
    }
    if (event.target.closest("[data-direct-listing]")) return;
    const row = event.target.closest("[data-select-id]");
    if (row) {
      if (!openSourceListing(row.dataset.sourceUrl)) {
        selectedId = row.dataset.selectId;
        renderOpportunities();
      }
      return;
    }
    if (event.target.closest("[data-export-workspace]")) {
      exportWorkspace();
      return;
    }
    if (event.target.closest("[data-download-template]")) {
      downloadTemplate();
      return;
    }
    if (event.target.closest("[data-reset-settings]")) {
      workspace.settings = { ...DEFAULT_SETTINGS };
      saveWorkspace();
      renderSettingsForm();
      toast("Default assumptions restored.");
      return;
    }
    if (event.target.closest("[data-clear-workspace]")) {
      if (window.confirm("Clear imported snapshots, observation history, and your watchlist from this browser?")) {
        workspace = { userItems: [], watchIds: [], settings: { ...workspace.settings } };
        invalidateHistoricalIndex();
        selectedId = PUBLISHED_RESEARCH.items[0]?.id || "";
        saveWorkspace();
        renderStats();
        toast("Private workspace data cleared.");
      }
      return;
    }
    if (event.target.closest("[data-menu-toggle]")) {
      const open = !document.body.classList.contains("menu-open");
      document.body.classList.toggle("menu-open", open);
      $("[data-menu-toggle]").setAttribute("aria-expanded", String(open));
      return;
    }
    if (event.target.closest("[data-close-menu]")) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $("#global-search")?.focus();
    }
    if (event.key === "Escape") closeMenu();
    if (event.target.closest?.("[data-direct-listing], [data-watch-id], [data-open-id]")) return;
    const row = event.target.closest?.("[data-select-id]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (!openSourceListing(row.dataset.sourceUrl)) {
        selectedId = row.dataset.selectId;
        renderOpportunities();
      }
    }
  });

  $("#global-search").addEventListener("input", () => {
    visibleQueueLimit = QUEUE_PAGE_SIZE;
    if (activeView !== "opportunities") setView("opportunities");
    else renderOpportunities();
  });
  $("#signal-filter").addEventListener("change", resetQueueAndRender);
  $("#category-filter").addEventListener("change", resetQueueAndRender);
  $("#vertical-filter").addEventListener("change", resetQueueAndRender);
  $("#authentication-filter").addEventListener("change", resetQueueAndRender);
  $("#source-filter").addEventListener("change", resetQueueAndRender);
  $("#snapshot-file").addEventListener("change", (event) => {
    if (event.target.files?.length) importFiles(Array.from(event.target.files));
    event.target.value = "";
  });
  $("#snapshot-form").addEventListener("submit", handleManualSnapshot);
  $("#settings-form").addEventListener("submit", saveSettings);

  const dropZone = $("[data-drop-zone]");
  ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  }));
  dropZone.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) importFiles(Array.from(event.dataTransfer.files));
  });

  window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "opportunities", false));
  $$('[data-current-year]').forEach((element) => { element.textContent = String(new Date().getFullYear()); });
  setView(location.hash.slice(1) || "opportunities", false);
})();
