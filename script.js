(async () => {
  "use strict";

  const STORAGE_KEY = "bidaipro.auction-workspace.v1";
  const CLOUD_CONTROL_KEY = "bidaipro.cloud-refresh.v1";
  const CLOUD_TOKEN_KEY = "bidaipro.github-token.session";
  const SETTINGS_REVISION = 2;
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
    repairReserve: 12,
    returnReserve: 8,
    minimumProfit: 25,
    targetMargin: 22,
    assumedInboundShipping: 18,
    analogCompHaircut: 40,
    askingPriceHaircut: 30,
    retailReplacementHaircut: 45,
    specialtyGuideHaircut: 15,
    minimumRetailDemandScore: 55,
    pawnPayoutPercent: 50,
    pawnTestingReserve: 10,
  };

  const DEFAULT_CLOUD_CONTROL = {
    repository: "BidAIPro/BidAIPro",
    normalMinutes: 60,
    nearCloseMinutes: 5,
    sourceConfigs: [],
    lastDispatchAt: null,
    lastPublishedRefreshAt: null,
  };

  const AUCTION_MARKETS = [
    { key: "shopgoodwill", name: "ShopGoodwill", domain: "shopgoodwill.com", homeUrl: "https://shopgoodwill.com/", focus: "Donated goods, jewelry, collectibles, electronics" },
    { key: "ebay", name: "eBay Auctions", domain: "ebay.com", homeUrl: "https://www.ebay.com/", setupUrl: "https://developer.ebay.com/my/keys", focus: "General merchandise and worldwide collectibles" },
    { key: "hibid", name: "HiBid", domain: "hibid.com", homeUrl: "https://hibid.com/", focus: "Estate, equipment, vehicles, jewelry, local auctions" },
    { key: "liveauctioneers", name: "LiveAuctioneers", domain: "liveauctioneers.com", homeUrl: "https://www.liveauctioneers.com/", focus: "Art, antiques, coins, jewelry, collectibles" },
    { key: "invaluable", name: "Invaluable", domain: "invaluable.com", homeUrl: "https://www.invaluable.com/", setupUrl: "https://www.invaluable.com/inv/apiinfo/", focus: "Fine art, decorative art, jewelry, auction houses" },
    { key: "govdeals", name: "GovDeals", domain: "govdeals.com", homeUrl: "https://www.govdeals.com/", focus: "Government surplus, vehicles, equipment, real estate" },
    { key: "publicsurplus", name: "Public Surplus", domain: "publicsurplus.com", homeUrl: "https://www.publicsurplus.com/", focus: "Government and educational surplus" },
    { key: "propertyroom", name: "PropertyRoom", domain: "propertyroom.com", homeUrl: "https://www.propertyroom.com/", focus: "Police surplus, jewelry, electronics, vehicles" },
    { key: "proxibid", name: "Proxibid", domain: "proxibid.com", homeUrl: "https://www.proxibid.com/", focus: "Equipment, vehicles, estate and specialty auctions" },
    { key: "bidspotter", name: "BidSpotter", domain: "bidspotter.com", homeUrl: "https://www.bidspotter.com/en-us", focus: "Industrial, commercial, plant and machinery" },
  ];

  function normalizePublishedResearch(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
      return { observedAt: null, lastCheckedAt: null, sourceMode: "unavailable", sourceHealth: {}, items: [] };
    }
    return {
      observedAt: payload.observedAt || null,
      lastCheckedAt: payload.lastCheckedAt || payload.observedAt || null,
      sourceMode: payload.sourceMode || "published-research",
      sourceHealth: payload.sourceHealth && typeof payload.sourceHealth === "object" ? payload.sourceHealth : {},
      items: payload.items.filter((item) => item && item.id && item.title),
    };
  }

  function parsePublishedSnapshotScript(source) {
    const assignment = "window.BIDAI_LIVE_SNAPSHOTS";
    const assignmentIndex = String(source || "").indexOf(assignment);
    if (assignmentIndex < 0) throw new Error("The published snapshot file has an unexpected format.");
    const equalsIndex = source.indexOf("=", assignmentIndex + assignment.length);
    if (equalsIndex < 0) throw new Error("The published snapshot file has an unexpected format.");
    const json = source.slice(equalsIndex + 1).trim().replace(/;\s*$/, "");
    return normalizePublishedResearch(JSON.parse(json));
  }

  const IS_TEST_MODE = window.BIDAI_TEST_MODE === true;
  const SNAPSHOT_BRANCH_URL = "https://raw.githubusercontent.com/BidAIPro/BidAIPro/auction-data/data/live-snapshots.js";

  async function fetchPublishedSnapshot() {
    const candidates = [
      new URL("data/live-snapshots.js", document.baseURI),
      new URL(SNAPSHOT_BRANCH_URL),
    ];
    const failures = [];
    for (const candidate of candidates) {
      candidate.searchParams.set("refresh", String(Date.now()));
      try {
        const response = await fetch(candidate, { cache: "no-store" });
        if (!response.ok) {
          failures.push(`${candidate.origin}: HTTP ${response.status}`);
          continue;
        }
        const snapshot = parsePublishedSnapshotScript(await response.text());
        if (!snapshot.items.length) {
          failures.push(`${candidate.origin}: no usable listings`);
          continue;
        }
        return snapshot;
      } catch (error) {
        failures.push(`${candidate.origin}: ${error.message || "request failed"}`);
      }
    }
    throw new Error(`Published snapshot delivery failed (${failures.join("; ")}).`);
  }

  let PUBLISHED_RESEARCH = normalizePublishedResearch(window.BIDAI_LIVE_SNAPSHOTS);
  let publishedSnapshotLoadError = "";
  if (!IS_TEST_MODE && !PUBLISHED_RESEARCH.items.length) {
    try {
      PUBLISHED_RESEARCH = await fetchPublishedSnapshot();
    } catch (error) {
      publishedSnapshotLoadError = error.message || "Published snapshot delivery failed.";
      PUBLISHED_RESEARCH = { ...normalizePublishedResearch(null), sourceMode: "delivery-error" };
      console.error(publishedSnapshotLoadError);
    }
  }


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
  const analogTitleSimilarity = (left, right) => {
    const ignored = new Set(["and", "the", "with", "for", "from", "lot", "new", "used", "vintage", "item", "set", "pair"]);
    const tokens = (value) => new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !ignored.has(token)) || []);
    const leftTokens = tokens(left);
    const rightTokens = tokens(right);
    if (!leftTokens.size || !rightTokens.size) return 0;
    const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return shared / new Set([...leftTokens, ...rightTokens]).size;
  };
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
  const checkedAtFor = (item) => item?.lastCheckedAt || observedAtFor(item);
  const newestIsoTimestamp = (...values) => values
    .map((value) => ({ value, time: Date.parse(value || "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)[0]?.value || null;
  const freshnessFor = (item) => {
    const checkedAt = checkedAtFor(item);
    const timestamp = Date.parse(checkedAt || "");
    if (!Number.isFinite(timestamp)) return { className: "is-unknown", label: "Check time unknown", short: "unknown age", checkedAt: null, observedAt: observedAtFor(item) };
    const ageMinutes = (Date.now() - timestamp) / 60000;
    if (ageMinutes < -5) return { className: "is-invalid", label: "Future-dated check", short: "clock error", checkedAt, observedAt: observedAtFor(item) };
    const normalizedAgeMinutes = Math.max(0, ageMinutes);
    const short = normalizedAgeMinutes < 2
      ? "just now"
      : normalizedAgeMinutes < 60
        ? `${Math.round(normalizedAgeMinutes)}m ago`
        : normalizedAgeMinutes < 1440
          ? `${Math.round(normalizedAgeMinutes / 60)}h ago`
          : `${Math.round(normalizedAgeMinutes / 1440)}d ago`;
    const className = normalizedAgeMinutes <= 45 ? "is-fresh" : normalizedAgeMinutes <= 120 ? "is-aging" : "is-stale";
    const label = className === "is-fresh" ? "Recently checked" : className === "is-aging" ? "Check delayed" : "Check overdue";
    return { className, label, short, checkedAt, observedAt: observedAtFor(item) };
  };

  function loadWorkspace() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!stored || typeof stored !== "object") throw new Error("empty");
      const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
      if (Number(stored.settingsRevision || 0) < SETTINGS_REVISION) {
        // Migrate the original one-size-fits-all stack only when a value was
        // never customized. Explicit user choices remain authoritative.
        if (Number(stored.settings?.repairReserve) === 25) settings.repairReserve = DEFAULT_SETTINGS.repairReserve;
        if (Number(stored.settings?.returnReserve) === 18) settings.returnReserve = DEFAULT_SETTINGS.returnReserve;
        if (Number(stored.settings?.minimumProfit) === 50) settings.minimumProfit = DEFAULT_SETTINGS.minimumProfit;
        if (Number(stored.settings?.assumedInboundShipping) === 25) settings.assumedInboundShipping = DEFAULT_SETTINGS.assumedInboundShipping;
      }
      return {
        userItems: Array.isArray(stored.userItems) ? stored.userItems : [],
        watchIds: Array.isArray(stored.watchIds) ? stored.watchIds : [],
        settings,
        settingsRevision: SETTINGS_REVISION,
      };
    } catch (_error) {
      return { userItems: [], watchIds: [], settings: { ...DEFAULT_SETTINGS }, settingsRevision: SETTINGS_REVISION };
    }
  }

  function loadCloudControl() {
    try {
      const stored = JSON.parse(localStorage.getItem(CLOUD_CONTROL_KEY) || "null");
      const merged = { ...DEFAULT_CLOUD_CONTROL, ...(stored && typeof stored === "object" ? stored : {}) };
      merged.repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(merged.repository || ""))
        ? String(merged.repository)
        : DEFAULT_CLOUD_CONTROL.repository;
      merged.normalMinutes = [15, 30, 60, 120, 240, 360].includes(Number(merged.normalMinutes)) ? Number(merged.normalMinutes) : 60;
      merged.nearCloseMinutes = [5, 10, 15].includes(Number(merged.nearCloseMinutes)) ? Number(merged.nearCloseMinutes) : 5;
      merged.sourceConfigs = Array.isArray(merged.sourceConfigs) ? merged.sourceConfigs : [];
      return merged;
    } catch (_error) {
      return { ...DEFAULT_CLOUD_CONTROL };
    }
  }

  function saveCloudControl() {
    try {
      localStorage.setItem(CLOUD_CONTROL_KEY, JSON.stringify(cloudControl));
    } catch (_error) {
      toast("Cloud refresh preferences could not be saved in this browser.", "error");
    }
  }

  function cloudToken() {
    try {
      return window.sessionStorage.getItem(CLOUD_TOKEN_KEY) || "";
    } catch (_error) {
      return "";
    }
  }

  function rememberCloudToken(token) {
    try {
      if (token) window.sessionStorage.setItem(CLOUD_TOKEN_KEY, token);
      else window.sessionStorage.removeItem(CLOUD_TOKEN_KEY);
    } catch (_error) {
      throw new Error("This browser blocked session-only token storage.");
    }
  }

  function validRepository(value) {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || "").trim());
  }

  async function githubApiRequest(path, { method = "GET", body, allow404 = false, repository = cloudControl.repository, token = cloudToken() } = {}) {
    if (!validRepository(repository)) throw new Error("Enter the GitHub repository as owner/repository.");
    if (!token) throw new Error("Enter a fine-grained GitHub token to control the cloud refresh.");
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && response.status === 404) return { status: 404, data: null };
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.message ? `: ${payload.message}` : "";
      throw new Error(`GitHub returned ${response.status}${detail}`);
    }
    return { status: response.status, data: payload };
  }

  async function upsertActionsVariable(name, value, credentials = {}) {
    const encodedName = encodeURIComponent(name);
    const updated = await githubApiRequest(`/actions/variables/${encodedName}`, {
      ...credentials,
      method: "PATCH",
      body: { name, value: String(value) },
      allow404: true,
    });
    if (updated.status !== 404) return;
    await githubApiRequest("/actions/variables", {
      ...credentials,
      method: "POST",
      body: { name, value: String(value) },
    });
  }

  async function readActionsVariable(name, credentials = {}) {
    const result = await githubApiRequest(`/actions/variables/${encodeURIComponent(name)}`, {
      ...credentials,
      allow404: true,
    });
    return result.status === 404 ? null : result.data?.value ?? null;
  }

  async function dispatchCloudRefresh(credentials = {}) {
    await githubApiRequest("/actions/workflows/refresh-auction-data.yml/dispatches", {
      ...credentials,
      method: "POST",
      body: { ref: "main" },
    });
    cloudControl.lastDispatchAt = new Date().toISOString();
    saveCloudControl();
    renderStats();
    toast("Cloud snapshot refresh requested. GitHub will update the published checks when the run finishes.");
  }

  let workspace = loadWorkspace();
  let cloudControl = loadCloudControl();
  let activeView = "opportunities";
  let selectedId = "";
  let historicalIndexCache = null;
  let visibleQueueLimit = QUEUE_PAGE_SIZE;
  let queueMode = "all";

  function saveWorkspace() {
    try {
      workspace.settingsRevision = SETTINGS_REVISION;
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
      ? (afterCloseHours <= 1 / 60 ? 1 / 12 : cloudControl.normalMinutes)
      : hours <= 1 / 60 ? 1 / 12
        : hours <= 5 / 60 ? 0.5
          : hours <= 0.5 ? cloudControl.nearCloseMinutes : cloudControl.normalMinutes;
    const urgency = afterCloseHours !== null
      ? (afterCloseHours <= 1 / 60 ? "critical" : "elevated")
      : hours <= 5 / 60 ? "critical" : hours <= 0.5 ? "high" : "standard";
    const checkedAt = Date.parse(checkedAtFor(item) || "");
    const nextDueAt = Number.isFinite(checkedAt) ? new Date(checkedAt + intervalMinutes * 60000).toISOString() : null;
    return {
      intervalMinutes,
      label: afterCloseHours !== null
        ? (intervalMinutes <= 1 / 12 ? "Final check every 5 sec" : `Final check every ${intervalMinutes} min`)
        : intervalMinutes <= 1 / 12 ? "Every 5 sec"
          : intervalMinutes === 0.5 ? "Every 30 sec"
            : intervalMinutes < 60 ? `Every ${intervalMinutes} min` : intervalMinutes === 60 ? "Hourly" : `Every ${intervalMinutes / 60} hr`,
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
    const currentBidKnown = item.currentBidKnown !== false;
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
    const assumedInboundShipping = Math.max(0, configuredNumber(null, s.assumedInboundShipping));
    const shipping = shippingKnown ? Math.max(0, Number(item.shipping)) : assumedInboundShipping;
    const shippingEstimated = !shippingKnown;
    const resaleModelKey = normalizedModelKey(item.modelKey);
    const listingEvidenceCutoff = Date.parse(observedAtFor(item) || "") || Date.now();
    const resaleMarketAsOf = Date.parse(item.resaleMarket?.asOf || "");
    const evidenceCutoff = Number.isFinite(resaleMarketAsOf)
      && resaleMarketAsOf <= Date.now() + 300000
      && Date.now() - resaleMarketAsOf <= 30 * 86400000
      ? Math.max(listingEvidenceCutoff, resaleMarketAsOf)
      : listingEvidenceCutoff;
    const allCompletedSaleEvidence = Array.isArray(item.comparableSales) ? item.comparableSales : [];
    const qualifyingResaleEvidence = allCompletedSaleEvidence
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
    const preciousMetalListing = Boolean(item.metalEstimate) || /\b(?:gold|silver|sterling|palladium|platinum)\b/i.test(String(item.title || ""));
    const qualifyingAnalogEvidence = allCompletedSaleEvidence
      .filter((entry) => Number(entry?.soldPrice ?? entry?.finalPrice ?? entry?.price) > 0)
      .filter((entry) => !resaleModelKey || normalizedModelKey(entry?.modelKey || entry?.compGroup || entry?.similarItemKey) !== resaleModelKey)
      .filter((entry) => {
        const rawScore = Number(entry?.matchScore);
        const matchScore = Number.isFinite(rawScore) ? clamp(rawScore > 1 ? rawScore / 100 : rawScore) : null;
        const explicitlyAnalog = /analog|near|similar|category/i.test(String(entry?.matchType || entry?.evidenceTier || ""));
        return matchScore !== null
          && matchScore >= 0.65
          && (explicitlyAnalog || analogTitleSimilarity(item.title, entry?.title) >= 0.45);
      })
      .filter((entry) => Boolean(entry?.id || entry?.externalId || safeHttpUrl(entry?.url || entry?.sourceUrl)))
      .filter((entry) => {
        const ended = Date.parse(entry?.soldAt || entry?.endedAt || "");
        const knownAt = Date.parse(entry?.outcomeObservedAt || entry?.finalObservedAt || entry?.capturedAt || entry?.observedAt || observedAtFor(item) || "");
        return Number.isFinite(ended) && ended <= evidenceCutoff && Number.isFinite(knownAt) && knownAt <= evidenceCutoff;
      });
    const uniqueAnalogEvidence = preciousMetalListing
      ? []
      : [...new Map(qualifyingAnalogEvidence.map((entry) => [comparableKey(entry), entry])).values()];
    const analogEvidenceCount = uniqueAnalogEvidence.length;
    const analogResalePrices = uniqueAnalogEvidence.map((entry) => Number(entry.soldPrice ?? entry.finalPrice ?? entry.price));
    const askingMarketAsOf = Date.parse(item.askingMarket?.asOf || "");
    const qualifyingUsedListings = (Array.isArray(item.askingMarket?.listings) ? item.askingMarket.listings : [])
      .filter((entry) => Number(entry?.totalPrice ?? entry?.price) > 0)
      .filter((entry) => /used|pre-owned|preowned/i.test(String(entry?.condition || "")))
      .filter((entry) => Boolean(entry?.id || entry?.externalId || safeHttpUrl(entry?.url)))
      .filter((entry) => {
        const rawScore = Number(entry?.matchScore);
        const matchScore = Number.isFinite(rawScore) ? clamp(rawScore > 1 ? rawScore / 100 : rawScore) : null;
        return matchScore !== null && matchScore >= 0.65;
      });
    const uniqueEbayUsedListings = [...new Map(qualifyingUsedListings.map((entry) => [comparableKey(entry), entry])).values()];
    const hasEbayUsedEvidence = item.askingMarket?.status === "available"
      && uniqueEbayUsedListings.length >= 5
      && Number.isFinite(askingMarketAsOf)
      && askingMarketAsOf <= Date.now() + 300000
      && Date.now() - askingMarketAsOf <= 24 * 86400000;
    const retailMarketAsOf = Date.parse(item.retailMarket?.asOf || "");
    const retailMarketFresh = item.retailMarket?.status === "available"
      && Number.isFinite(retailMarketAsOf)
      && retailMarketAsOf <= Date.now() + 300000
      && Date.now() - retailMarketAsOf <= 24 * 86400000;
    const qualifyingRetailOffers = (Array.isArray(item.retailMarket?.offers) ? item.retailMarket.offers : [])
      .filter((entry) => Number(entry?.totalPrice ?? entry?.price) > 0)
      .filter((entry) => Boolean(entry?.id || safeHttpUrl(entry?.url)))
      .filter((entry) => {
        const rawScore = Number(entry?.matchScore);
        const matchScore = Number.isFinite(rawScore) ? clamp(rawScore > 1 ? rawScore / 100 : rawScore) : null;
        return matchScore !== null && matchScore >= 0.65;
      });
    const retailUsedOffers = qualifyingRetailOffers.filter((entry) => /used|pre-owned|preowned|refurb/i.test(String(entry?.condition || "")));
    const retailNewOffers = qualifyingRetailOffers.filter((entry) => !/used|pre-owned|preowned|refurb/i.test(String(entry?.condition || "")));
    const retailUsedSourceCount = new Set(retailUsedOffers.map((entry) => String(entry.source || "").toLowerCase()).filter(Boolean)).size;
    const retailNewSourceCount = new Set(retailNewOffers.map((entry) => String(entry.source || "").toLowerCase()).filter(Boolean)).size;
    const hasRetailUsedEvidence = retailMarketFresh && retailUsedOffers.length >= 5 && retailUsedSourceCount >= 2;
    const hasRetailNewEvidence = retailMarketFresh && retailNewOffers.length >= 5 && retailNewSourceCount >= 2;
    const uniqueUsedListings = [...new Map([
      ...(hasEbayUsedEvidence ? uniqueEbayUsedListings : []),
      ...(hasRetailUsedEvidence ? retailUsedOffers : []),
    ].map((entry) => [comparableKey(entry), entry])).values()];
    const usedAskingPrices = uniqueUsedListings.map((entry) => Number(entry.totalPrice ?? entry.price));
    const hasUsedAskingEvidence = (hasEbayUsedEvidence || hasRetailUsedEvidence) && uniqueUsedListings.length >= 5;
    const onlineUsedLow = hasUsedAskingEvidence ? quantile(usedAskingPrices, 0.2) : null;
    const onlineUsedMedian = hasUsedAskingEvidence ? quantile(usedAskingPrices, 0.5) : null;
    const onlineUsedHigh = hasUsedAskingEvidence ? quantile(usedAskingPrices, 0.8) : null;
    const onlineUsedAverage = hasUsedAskingEvidence
      ? usedAskingPrices.reduce((total, value) => total + value, 0) / usedAskingPrices.length
      : null;
    const retailNewPrices = retailNewOffers.map((entry) => Number(entry.totalPrice ?? entry.price));
    const retailNewLow = hasRetailNewEvidence ? quantile(retailNewPrices, 0.2) : null;
    const retailNewMedian = hasRetailNewEvidence ? quantile(retailNewPrices, 0.5) : null;
    const retailNewHigh = hasRetailNewEvidence ? quantile(retailNewPrices, 0.8) : null;
    const retailNewAverage = hasRetailNewEvidence
      ? retailNewPrices.reduce((total, value) => total + value, 0) / retailNewPrices.length
      : null;
    const specialtyMarketAsOf = Date.parse(item.specialtyMarket?.asOf || "");
    const specialtyMatchScore = Number(item.specialtyMarket?.matchScore);
    const specialtyGuideValue = Math.max(0, Number(item.specialtyMarket?.guideValue) || 0);
    const specialtyRetailSellValue = Math.max(0, Number(item.specialtyMarket?.retailerSellValue) || 0);
    const specialtyRetailerBuyValue = Math.max(0, Number(item.specialtyMarket?.retailerBuyValue) || 0);
    const hasSpecialtyEvidence = item.specialtyMarket?.status === "available"
      && Boolean(item.specialtyMarket?.productId && safeHttpUrl(item.specialtyMarket?.sourceUrl))
      && Number.isFinite(specialtyMatchScore)
      && specialtyMatchScore >= 65
      && specialtyGuideValue > 0
      && Number.isFinite(specialtyMarketAsOf)
      && specialtyMarketAsOf <= Date.now() + 300000
      && Date.now() - specialtyMarketAsOf <= 72 * 3600000;
    const specialtyPrices = [specialtyGuideValue, specialtyRetailSellValue].filter((value) => value > 0);
    const specialtyRawLow = hasSpecialtyEvidence ? Math.min(...specialtyPrices) : null;
    const specialtyRawMedian = hasSpecialtyEvidence ? specialtyGuideValue : null;
    const specialtyRawHigh = hasSpecialtyEvidence ? Math.max(...specialtyPrices) : null;
    const soldListingCount = Math.max(0, Math.round(Number(item.resaleMarket?.soldListingCount) || 0));
    const activeListingCount = Math.max(0, Math.round(Number(item.resaleMarket?.activeListingCount) || 0));
    const resaleLookbackDays = Math.max(0, Math.round(Number(item.resaleMarket?.lookbackDays) || 0));
    const liquidityDenominator = soldListingCount + activeListingCount;
    const hasLiquidityEvidence = item.resaleMarket?.status === "available"
      && Number.isFinite(resaleMarketAsOf)
      && resaleMarketAsOf <= Date.now() + 300000
      && Date.now() - resaleMarketAsOf <= 30 * 86400000
      && resaleLookbackDays >= 1
      && resaleLookbackDays <= 365
      && resaleEvidenceCount >= 3
      && soldListingCount >= resaleEvidenceCount
      && liquidityDenominator > 0;
    const sellThroughRate = hasLiquidityEvidence ? soldListingCount / liquidityDenominator : null;
    const suppliedMedianDaysToSell = Number(item.resaleMarket?.medianDaysToSell);
    const medianDaysToSell = hasLiquidityEvidence && Number.isFinite(suppliedMedianDaysToSell) && suppliedMedianDaysToSell >= 0
      ? suppliedMedianDaysToSell
      : null;
    const speedFactor = medianDaysToSell === null ? 0.5 : clamp(1 - medianDaysToSell / 90);
    const liquidityScore = hasLiquidityEvidence
      ? Math.round(100 * (sellThroughRate * 0.75 + speedFactor * 0.25))
      : null;
    const liquidityLabel = liquidityScore === null
      ? "unknown"
      : liquidityScore >= 80 ? "hot" : liquidityScore >= 60 ? "strong" : liquidityScore >= 40 ? "moderate" : "slow";
    const hasComparableResaleEvidence = resaleEvidenceCount >= 3;
    const hasAnalogResaleEvidence = !hasComparableResaleEvidence && analogEvidenceCount >= 5;
    const analogCompHaircut = clamp(configuredNumber(null, s.analogCompHaircut) / 100, 0.2, 0.7);
    const askingPriceHaircut = clamp(configuredNumber(null, s.askingPriceHaircut) / 100, 0, 0.8);
    const retailReplacementHaircut = clamp(configuredNumber(null, s.retailReplacementHaircut) / 100, 0.2, 0.8);
    const specialtyGuideHaircut = clamp(configuredNumber(null, s.specialtyGuideHaircut) / 100, 0, 0.5);
    const resaleEvidenceKind = hasComparableResaleEvidence
      ? "completed"
      : hasAnalogResaleEvidence ? "analog-completed"
        : hasSpecialtyEvidence ? "specialty-guide"
          : hasUsedAskingEvidence ? "used-market"
            : hasRetailNewEvidence ? "retail-replacement" : "none";
    const evidencePlanningFactor = resaleEvidenceKind === "analog-completed"
      ? 1 - analogCompHaircut
      : resaleEvidenceKind === "specialty-guide"
      ? 1 - specialtyGuideHaircut
      : resaleEvidenceKind === "used-market"
        ? 1 - askingPriceHaircut
        : resaleEvidenceKind === "retail-replacement" ? 1 - retailReplacementHaircut : 1;
    const rawMarketLow = resaleEvidenceKind === "completed"
      ? quantile(comparableResalePrices, 0.2)
      : resaleEvidenceKind === "analog-completed" ? quantile(analogResalePrices, 0.2)
        : resaleEvidenceKind === "specialty-guide" ? specialtyRawLow
          : resaleEvidenceKind === "used-market" ? onlineUsedLow
            : resaleEvidenceKind === "retail-replacement" ? retailNewLow : null;
    const rawMarketMedian = resaleEvidenceKind === "completed"
      ? quantile(comparableResalePrices, 0.5)
      : resaleEvidenceKind === "analog-completed" ? quantile(analogResalePrices, 0.5)
        : resaleEvidenceKind === "specialty-guide" ? specialtyRawMedian
          : resaleEvidenceKind === "used-market" ? onlineUsedMedian
            : resaleEvidenceKind === "retail-replacement" ? retailNewMedian : null;
    const rawMarketHigh = resaleEvidenceKind === "completed"
      ? quantile(comparableResalePrices, 0.8)
      : resaleEvidenceKind === "analog-completed" ? quantile(analogResalePrices, 0.8)
        : resaleEvidenceKind === "specialty-guide" ? specialtyRawHigh
          : resaleEvidenceKind === "used-market" ? onlineUsedHigh
            : resaleEvidenceKind === "retail-replacement" ? retailNewHigh : null;
    const rawMarketAverage = resaleEvidenceKind === "completed"
      ? comparableResalePrices.reduce((total, value) => total + value, 0) / comparableResalePrices.length
      : resaleEvidenceKind === "analog-completed" ? analogResalePrices.reduce((total, value) => total + value, 0) / analogResalePrices.length
        : resaleEvidenceKind === "specialty-guide" ? specialtyRawMedian
          : resaleEvidenceKind === "used-market" ? onlineUsedAverage
            : resaleEvidenceKind === "retail-replacement" ? retailNewAverage : null;
    const resaleLow = Number(rawMarketLow || 0) * evidencePlanningFactor;
    const resaleMedian = Number(rawMarketMedian || 0) * evidencePlanningFactor;
    const resaleHigh = Number(rawMarketHigh || 0) * evidencePlanningFactor;
    const resaleAverage = rawMarketAverage === null ? null : rawMarketAverage * evidencePlanningFactor;
    const landedAt = (bid) => ((Math.max(0, bid) * (1 + buyerPremium / 100) + shipping) * (1 + taxRate / 100));
    const buyerPremiumCost = modeledBid * buyerPremium / 100;
    const acquisitionSubtotal = modeledBid + buyerPremiumCost + shipping;
    const taxCost = acquisitionSubtotal * taxRate / 100;
    const acquisition = acquisitionSubtotal + taxCost;
    const currentAcquisition = landedAt(currentBid);
    const currentBuyerPremiumCost = currentBid * buyerPremium / 100;
    const currentTaxCost = (currentBid + currentBuyerPremiumCost + shipping) * taxRate / 100;
    const netResale = (sale) => sale * (1 - marketplaceFee / 100) - outboundShipping - repairReserve - returnReserve;
    const netLow = netResale(resaleLow);
    const netMedian = netResale(resaleMedian);
    const netHigh = netResale(resaleHigh);
    const hasResaleEvidence = resaleMedian > 0
      && resaleLow > 0
      && resaleLow <= resaleMedian
      && resaleHigh >= resaleMedian
      && resaleEvidenceKind !== "none";
    const demandLookbackDays = 90;
    const demandAsOf = Math.min(Date.now(), evidenceCutoff);
    const selectedCompletedEvidence = resaleEvidenceKind === "analog-completed" ? uniqueAnalogEvidence : uniqueResaleEvidence;
    const recentCompletedSales = selectedCompletedEvidence.filter((entry) => {
      const ended = Date.parse(entry?.soldAt || entry?.endedAt || "");
      return Number.isFinite(ended) && ended >= demandAsOf - demandLookbackDays * 86400000 && ended <= demandAsOf;
    });
    const recentCompletedSalesPer30Days = recentCompletedSales.length / demandLookbackDays * 30;
    const requiredRecentCompletedSales = resaleEvidenceKind === "analog-completed" ? 5 : 3;
    const completedSalesDemandScore = recentCompletedSales.length >= requiredRecentCompletedSales
      ? Math.round(clamp((25 + 25 * Math.log2(recentCompletedSalesPer30Days + 1)) / 100) * 100)
      : 0;
    const specialtyAnnualSalesVolume = hasSpecialtyEvidence ? Math.max(0, Math.round(Number(item.specialtyMarket?.annualSalesVolume) || 0)) : 0;
    const hasSpecialtyDemandEvidence = hasSpecialtyEvidence && specialtyAnnualSalesVolume > 0;
    const specialtyDemandScore = hasSpecialtyDemandEvidence
      ? Math.round(clamp(Math.log10(specialtyAnnualSalesVolume + 1) / 4) * 100)
      : 0;
    const hasRecentCompletedDemand = recentCompletedSales.length >= requiredRecentCompletedSales;
    const retailDemandScore = hasLiquidityEvidence
      ? liquidityScore
      : hasSpecialtyDemandEvidence ? specialtyDemandScore
        : hasRecentCompletedDemand ? completedSalesDemandScore : 0;
    const minimumRetailDemandScore = clamp(configuredNumber(null, s.minimumRetailDemandScore) / 100, 0.2, 0.9) * 100;
    const hasRetailDemandEvidence = hasLiquidityEvidence || hasSpecialtyDemandEvidence || hasRecentCompletedDemand;
    const retailDemandPass = hasRetailDemandEvidence && retailDemandScore >= minimumRetailDemandScore;
    const retailDemandEvidenceType = hasLiquidityEvidence
      ? `${Math.round(sellThroughRate * 100)}% sell-through (${soldListingCount} sold / ${soldListingCount + activeListingCount} sold + active)${medianDaysToSell === null ? "" : `; ${medianDaysToSell.toFixed(1)} median days to sell`}`
      : hasSpecialtyDemandEvidence
        ? `${specialtyAnnualSalesVolume.toLocaleString()} reported units sold per year`
        : hasRecentCompletedDemand
          ? `${recentCompletedSales.length} ${resaleEvidenceKind === "analog-completed" ? "near-match" : "exact-model"} completed sales in the last ${demandLookbackDays} days`
          : "No completed-sale frequency, sell-through, or annual unit-volume evidence";
    const comparableRetailSources = [...new Set(selectedCompletedEvidence.map((entry) => String(entry.source || "").trim()).filter(Boolean))];
    const usedRetailSources = [...new Set(uniqueUsedListings.map((entry) => String(entry.source || "").trim()).filter(Boolean))];
    const newRetailSources = [...new Set(retailNewOffers.map((entry) => String(entry.source || "").trim()).filter(Boolean))];
    const retailChannel = resaleEvidenceKind === "completed"
      ? String(item.resaleMarket?.channel || comparableRetailSources.slice(0, 2).join(" + ") || "Completed-sales marketplace")
      : resaleEvidenceKind === "analog-completed"
        ? String(comparableRetailSources.slice(0, 2).join(" + ") || "Completed-sales marketplace")
        : resaleEvidenceKind === "specialty-guide"
        ? "PriceCharting Marketplace or a comparable collectible marketplace"
        : resaleEvidenceKind === "used-market"
          ? (usedRetailSources.slice(0, 3).join(" + ") || "Used fixed-price marketplace")
          : resaleEvidenceKind === "retail-replacement"
            ? (newRetailSources.slice(0, 3).join(" + ") || "General retail marketplace")
            : "No proven resale channel";
    // Category names such as "Jewelry & Gemstones" describe the catalog bin,
    // not necessarily the item. Purity gates must use item-specific evidence.
    const listingMaterialText = `${String(item.title || "")} ${String(item.metalEstimate?.nonMetalWarning || "")}`.toLowerCase();
    const preciousMetalIntent = Boolean(item.metalEstimate) || /\b(?:gold|silver|sterling|palladium|platinum)\b/.test(listingMaterialText);
    let metalPurityRejectionReason = null;
    if (preciousMetalIntent) {
      const hasGoldMaterial = /\bgold\b|\b(?:10|14|18|22|24)\s*k(?:t|arat)?\b/.test(listingMaterialText);
      const hasSilverMaterial = /\bsilver\b|\bsterling\b|\b(?:925|999|\.925|\.999)\b/.test(listingMaterialText);
      const otherMetal = listingMaterialText.match(/\b(palladium|platinum|rhodium|tungsten|titanium|copper|bronze|brass|stainless steel|steel|pewter|nickel|base metal)\b/);
      const nonMetalMaterial = listingMaterialText.match(/\b(diamonds?|gem(?:stone)?s?|pearls?|rub(?:y|ies)|sapphires?|emeralds?|opals?|crystals?|enamel|cz|cubic zirconia|zircon|moissanite|stones?|turquoise|jade(?:ite)?|bead(?:ed|s)?|faux|movement|leather|resin|plastic|glass|wood|rubber|ceramic)\b/);
      if (hasGoldMaterial && hasSilverMaterial) metalPurityRejectionReason = "Rejected: the listing describes both gold and silver.";
      else if (otherMetal) metalPurityRejectionReason = `Rejected: the listing also describes ${otherMetal[1]}.`;
      else if (/\b(?:mixed[ -]?metal|multi[ -]?metal|two[ -]?tone|tri[ -]?(?:color|tone)|bi[ -]?metal)\b/.test(listingMaterialText)) metalPurityRejectionReason = "Rejected: the listing explicitly describes a mixed-metal item.";
      else if (nonMetalMaterial) metalPurityRejectionReason = `Rejected: the stated weight may include ${nonMetalMaterial[1]} or another non-metal material.`;
      else if (/\b(?:plate(?:d)?|filled|overlay|bonded|clad|electroplate(?:d)?|vermeil|gold tone|silver tone)\b/.test(listingMaterialText)) metalPurityRejectionReason = "Rejected: plated, filled, bonded, vermeil, or tone material is not a single-metal pawn candidate.";
    }
    const titleWeightMatch = String(item.title || "").toLowerCase()
      .match(/(?:^|[^\d.])((?:\d+(?:\.\d+)?|\.\d+))\s*(?:g|grams?)\b/);
    const titleWeightGrams = titleWeightMatch ? Number(titleWeightMatch[1]) : null;
    const storedMetalWeightGrams = Number(item.metalEstimate?.grossWeightGrams);
    const metalWeightMismatch = Number.isFinite(titleWeightGrams) && titleWeightGrams > 0
      && Number.isFinite(storedMetalWeightGrams) && storedMetalWeightGrams > 0
      && Math.abs(storedMetalWeightGrams - titleWeightGrams) > Math.max(0.01, titleWeightGrams * 0.01);
    if (!metalPurityRejectionReason && metalWeightMismatch) {
      metalPurityRejectionReason = `Rejected: the stored ${storedMetalWeightGrams.toFixed(2)} g metal weight does not match the ${titleWeightGrams.toFixed(2)} g source-title weight.`;
    }
    const strictMetalPurityReject = Boolean(metalPurityRejectionReason);
    const hasForecast = forecast.status === "available";
    const resaleDecisionAvailable = hasResaleEvidence && retailDemandPass && !strictMetalPurityReject;
    const profitLow = hasForecast && resaleDecisionAvailable ? netLow - landedAt(forecast.high) : null;
    const profitExpected = hasForecast && resaleDecisionAvailable ? netMedian - acquisition : null;
    const profitHigh = hasForecast && resaleDecisionAvailable ? netHigh - landedAt(forecast.low) : null;
    const profitAtCurrentBid = resaleDecisionAvailable ? netMedian - currentAcquisition : null;
    const onlineProfitLowAtCurrentBid = resaleDecisionAvailable ? netLow - currentAcquisition : null;
    const onlineProfitHighAtCurrentBid = resaleDecisionAvailable ? netHigh - currentAcquisition : null;
    const meltPawnPayoutPercent = clamp(configuredNumber(null, s.pawnPayoutPercent) / 100, 0.2, 0.7) * 100;
    const pawnTestingReserve = Math.max(0, configuredNumber(null, s.pawnTestingReserve));
    const metalQuoteAt = Date.parse(item.metalEstimate?.quoteObservedAt || "");
    const quotedMeltCeiling = Number(item.metalEstimate?.meltCeiling);
    const recalculatedMeltCeiling = Number(item.metalEstimate?.grossWeightGrams)
      * Number(item.metalEstimate?.purityFraction)
      * Number(item.metalEstimate?.spotPerTroyOunce) / 31.1034768;
    const normalizedMetalTitle = String(item.title || "").toLowerCase();
    const statedMetal = String(item.metalEstimate?.metal || "").toLowerCase();
    const goldNonSolidWording = /\b(?:gold[ -]?(?:plate(?:d)?|filled|tone|overlay|bonded|clad|electroplate(?:d)?|wash(?:ed)?|over)|rolled[ -]?gold|vermeil|gp|g\.p\.|hge|rgep)\b/;
    const silverNonSolidWording = /\b(?:silver[ -]?(?:plate(?:d)?|tone|overlay|clad|electroplate(?:d)?)|silverplate|epns)\b/;
    const metalEvidenceTitleConflict = (statedMetal === "gold" && goldNonSolidWording.test(normalizedMetalTitle))
      || (statedMetal === "silver" && silverNonSolidWording.test(normalizedMetalTitle));
    const hasMetalEstimate = [quotedMeltCeiling, recalculatedMeltCeiling].every((value) => Number.isFinite(value) && value > 0)
      && Math.abs(quotedMeltCeiling - recalculatedMeltCeiling) / recalculatedMeltCeiling <= 0.03
      && Number.isFinite(metalQuoteAt)
      && metalQuoteAt <= Date.now() + 300000
      && Date.now() - metalQuoteAt <= 86400000
      && !metalEvidenceTitleConflict
      && !strictMetalPurityReject;
    const hasPossibleNonMetalWeight = /may include|stones?|movement|strap|band|pearl|gem/i.test(String(item.metalEstimate?.nonMetalWarning || ""));
    const recoverableWeightFactor = hasPossibleNonMetalWeight ? 0.75 : 0.95;
    const pawnMeltBasis = hasMetalEstimate ? quotedMeltCeiling * recoverableWeightFactor : null;
    const hasDirectRetailerBuy = hasSpecialtyEvidence && specialtyRetailerBuyValue > 0;
    const hasPawnEstimate = hasMetalEstimate;
    const pawnPayoutPercent = meltPawnPayoutPercent;
    const pawnLowPercent = Math.max(20, meltPawnPayoutPercent - 15);
    const pawnHighPercent = Math.min(75, meltPawnPayoutPercent + 15);
    const pawnCashLow = hasMetalEstimate ? pawnMeltBasis * pawnLowPercent / 100 : null;
    const pawnCashEstimate = hasMetalEstimate ? pawnMeltBasis * meltPawnPayoutPercent / 100 : null;
    const pawnCashHigh = hasMetalEstimate ? pawnMeltBasis * pawnHighPercent / 100 : null;
    const pawnBasisType = hasMetalEstimate ? "metal-melt" : "none";
    const pawnBasisLabel = hasMetalEstimate
      ? "fresh spot price plus source-stated purity and weight"
      : "no verified precious-metal liquidation evidence";
    const pawnProfitLow = hasPawnEstimate ? pawnCashLow - currentAcquisition - pawnTestingReserve : null;
    const pawnProfitAtCurrentBid = hasPawnEstimate ? pawnCashEstimate - currentAcquisition - pawnTestingReserve : null;
    const pawnProfitHigh = hasPawnEstimate ? pawnCashHigh - currentAcquisition - pawnTestingReserve : null;
    const conservativeResale = resaleLow + Math.max(0, resaleMedian - resaleLow) * 0.2;
    const desiredProfit = Math.max(Number(s.minimumProfit) || 0, conservativeResale * (Number(s.targetMargin) || 0) / 100);
    const maximumLanded = Math.max(0, netResale(conservativeResale) - desiredProfit);
    const resaleMaxBid = resaleDecisionAvailable
      ? Math.max(0, (maximumLanded / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100))
      : 0;
    const pawnRequiredProfit = Math.max(Number(s.minimumProfit) || 0, Number(pawnCashLow || 0) * (Number(s.targetMargin) || 0) / 100);
    const pawnMaximumLanded = Math.max(0, Number(pawnCashLow || 0) - pawnTestingReserve - pawnRequiredProfit);
    const pawnMaxBid = hasPawnEstimate
      ? Math.max(0, (pawnMaximumLanded / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100))
      : 0;
    const resaleBreakEvenBid = resaleDecisionAvailable
      ? Math.max(0, (Math.max(0, netMedian) / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100))
      : 0;
    const pawnBreakEvenBid = hasPawnEstimate
      ? Math.max(0, (Math.max(0, pawnCashEstimate - pawnTestingReserve) / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100))
      : 0;
    const minimumProfitTarget = Math.max(0, Number(s.minimumProfit) || 0);
    const pawnSafeNow = currentBidKnown && hasPawnEstimate && pawnMaxBid > currentBid;
    const retailSafeNow = currentBidKnown && resaleDecisionAvailable && resaleMaxBid > currentBid;
    const onlineSafeNow = retailSafeNow;
    const pawnLikelyProfitable = currentBidKnown && hasPawnEstimate && pawnProfitAtCurrentBid > 0;
    const retailLikelyProfitable = currentBidKnown && resaleDecisionAvailable && profitAtCurrentBid > 0;
    const onlineLikelyProfitable = retailLikelyProfitable;
    const highestEligibleCeiling = strictMetalPurityReject
      ? 0
      : Math.max(hasPawnEstimate ? pawnMaxBid : 0, resaleDecisionAvailable ? resaleMaxBid : 0);
    let exitType = "no-evidence";
    let recommendationState = "no-evidence";
    if (strictMetalPurityReject) {
      exitType = "rejected";
      recommendationState = "mixed-material";
    } else if (pawnSafeNow) {
      exitType = "pawn";
      recommendationState = "pawn-safe";
    } else if (retailSafeNow) {
      exitType = "online-resale";
      recommendationState = "retail-safe";
    } else if (hasPawnEstimate || resaleDecisionAvailable) {
      exitType = (hasPawnEstimate ? pawnMaxBid : -1) >= (resaleDecisionAvailable ? resaleMaxBid : -1) ? "pawn" : "online-resale";
      recommendationState = "no-margin";
    } else if (hasResaleEvidence && !retailDemandPass) {
      exitType = "online-resale";
      recommendationState = "no-demand";
    }
    const maxBid = highestEligibleCeiling;
    const selectedCeilingRoute = (hasPawnEstimate ? pawnMaxBid : -1) >= (resaleDecisionAvailable ? resaleMaxBid : -1) ? "pawn" : "online-resale";
    const breakEvenBid = selectedCeilingRoute === "pawn" ? pawnBreakEvenBid : resaleBreakEvenBid;
    const retailCeilingBasis = hasComparableResaleEvidence
      ? "Exact-model completed-sale P20 after all costs and the retail demand gate"
      : hasAnalogResaleEvidence
        ? `Near-match completed-sale P20 after a ${Math.round(analogCompHaircut * 100)}% uncertainty reserve, all costs, and the retail demand gate`
        : hasSpecialtyEvidence
        ? `Specialty guide after a ${Math.round(specialtyGuideHaircut * 100)}% reserve, all costs, and the retail demand gate`
        : hasUsedAskingEvidence
          ? `Matched used-market P20 after a ${Math.round(askingPriceHaircut * 100)}% haircut, all costs, and the retail demand gate`
          : hasRetailNewEvidence
            ? `New-retail P20 after a ${Math.round(retailReplacementHaircut * 100)}% condition/resale haircut, all costs, and the retail demand gate`
            : "No defensible retail price evidence";
    const safeCeilingBasis = recommendationState === "mixed-material"
      ? metalPurityRejectionReason
      : recommendationState === "no-demand"
      ? "No bid: a price was found, but independent retail demand did not clear the required threshold"
      : maxBid <= 0
        ? "No defensible profitable exit — do not bid"
        : selectedCeilingRoute === "pawn"
          ? `${pawnBasisLabel}; conservative pawn case after testing and profit reserves`
          : retailCeilingBasis;
    const decisionApproved = !strictMetalPurityReject && (pawnSafeNow || retailSafeNow);
    const decisionVerdict = decisionApproved ? "YES" : "NO";
    const hasDecisionInputs = hasPawnEstimate || resaleDecisionAvailable;
    const decisionProfitAtCurrentBid = strictMetalPurityReject || !currentBidKnown
      ? null
      : exitType === "pawn"
      ? pawnProfitAtCurrentBid
      : resaleDecisionAvailable ? profitAtCurrentBid : null;
    const decisionProfitLow = strictMetalPurityReject || !currentBidKnown
      ? null
      : exitType === "pawn"
      ? pawnProfitLow
      : resaleDecisionAvailable ? onlineProfitLowAtCurrentBid : null;
    const decisionProfitHigh = strictMetalPurityReject || !currentBidKnown
      ? null
      : exitType === "pawn"
      ? pawnProfitHigh
      : resaleDecisionAvailable ? onlineProfitHighAtCurrentBid : null;
    const comparableCount = Math.max(Number(item.compCount) || 0, forecast.exactModelCount || 0);
    const compCoverage = clamp(Math.log2(comparableCount + 1) / 4);
    const suppliedRecencyDays = Number(item.compRecencyDays);
    const compRecencyDays = Number.isFinite(suppliedRecencyDays) && suppliedRecencyDays >= 0
      ? suppliedRecencyDays
      : 365;
    const recency = clamp(1 - compRecencyDays / 365);
    const evidenceConfidence = clamp(
      parseConfidence(item.identityConfidence, 0.35) * 0.28 +
      parseConfidence(item.conditionConfidence, 0.35) * 0.2 +
      compCoverage * 0.25 +
      recency * 0.12 +
      clamp((liquidityScore ?? 0) / 100) * 0.1 +
      forecast.confidence * 0.05,
    );
    const metalConfidence = hasMetalEstimate
      ? clamp((item.metalEstimate?.sourceDescriptionStatus === "source-stated-tested" ? 0.62 : 0.46)
        - (hasPossibleNonMetalWeight ? 0.08 : 0)
        - (shippingEstimated ? 0.04 : 0))
      : 0;
    const askingConfidence = hasUsedAskingEvidence ? clamp(0.42 + Math.min(0.18, uniqueUsedListings.length / 100)) : 0;
    const specialtyConfidence = hasSpecialtyEvidence ? clamp(0.55 + Math.min(0.15, specialtyMatchScore / 500)) : 0;
    const retailReplacementConfidence = hasRetailNewEvidence ? clamp(0.3 + Math.min(0.12, retailNewOffers.length / 100)) : 0;
    const onlineEvidenceConfidence = hasComparableResaleEvidence
      ? evidenceConfidence
      : hasSpecialtyEvidence ? specialtyConfidence
        : hasUsedAskingEvidence ? askingConfidence : retailReplacementConfidence;
    const pawnConfidence = hasMetalEstimate ? metalConfidence : 0;
    const confidence = exitType === "pawn" ? pawnConfidence : onlineEvidenceConfidence;
    const pawnLiquidityScore = hasMetalEstimate ? 90 : 0;
    const pawnSaleLikelihood = hasMetalEstimate ? 0.9 : 0;
    const onlinePopularityScore = retailDemandScore;
    const onlineSaleLikelihood = hasLiquidityEvidence
      ? clamp(0.35 + sellThroughRate * 0.65)
      : hasRetailDemandEvidence ? clamp(0.25 + retailDemandScore / 100 * 0.65) : 0;
    const onlinePopularityKnown = hasRetailDemandEvidence;
    const productReviewCountMax = retailMarketFresh ? Math.max(0, Math.round(Number(item.retailMarket?.productInterest?.reviewCountMax) || 0)) : 0;
    const productInterestKnown = productReviewCountMax > 0;
    const resalePopularityScore = exitType === "pawn" ? pawnLiquidityScore : onlinePopularityScore;
    const saleLikelihood = exitType === "pawn" ? pawnSaleLikelihood : onlineSaleLikelihood;
    const roi = decisionProfitAtCurrentBid === null ? null : decisionProfitAtCurrentBid / Math.max(1, currentAcquisition);
    const marginComponent = clamp((roi + 0.15) / 1.15);
    const urgency = clamp(1 - hours / 72);
    const rawScore = 100 * clamp(
      marginComponent * 0.48 +
      clamp(resalePopularityScore / 100) * 0.24 +
      confidence * 0.18 +
      saleLikelihood * 0.05 +
      urgency * 0.05,
    );
    const freshness = freshnessFor(item);
    const endTimestamp = Date.parse(item.endsAt || "");
    const actionableSnapshot = item.status === "active"
      && Number.isFinite(endTimestamp)
      && endTimestamp > Date.now()
      && currentBid > 0
      && (freshness.className === "is-fresh" || freshness.className === "is-aging");
    const score = decisionApproved ? Math.round(rawScore) : 0;
    const ceilingProximity = maxBid > 0 ? clamp(maxBid / Math.max(1, currentBid)) : 0;
    const routeEvidenceConfidence = Math.max(pawnConfidence, onlineEvidenceConfidence);
    const rankingScore = decisionApproved
      ? Math.max(50, Math.round(rawScore))
      : recommendationState === "no-margin"
        ? Math.min(49, Math.round(49 * (ceilingProximity * 0.72 + routeEvidenceConfidence * 0.28)))
        : recommendationState === "no-demand"
          ? Math.min(24, Math.round(24 * clamp(retailDemandScore / Math.max(1, minimumRetailDemandScore))))
          : 0;
    const bidHeadroom = maxBid - currentBid;
    const bidHeadroomPercent = maxBid > 0 ? bidHeadroom / Math.max(1, currentBid) : null;
    const identitySupplied = Boolean(item.modelKey || item.identifiedAs);
    const conditionSupplied = Boolean(item.conditionSummary || Number(item.conditionConfidence) > 0);
    const sourceLinked = Boolean(safeHttpUrl(item.url || item.sourceUrl));
    const researchCoverageScore = Math.round(
      (sourceLinked ? 10 : 0)
      + (identitySupplied ? 10 : 0)
      + (conditionSupplied ? 10 : 0)
      + (shippingKnown ? 10 : 0)
      + (hasForecast ? 10 : 0)
      + (hasPawnEstimate ? 15 : 0)
      + (hasResaleEvidence ? 15 : 0)
      + (hasRetailDemandEvidence ? 15 : 0)
      + (retailChannel !== "No proven resale channel" ? 5 : 0)
    );
    const profitableNow = decisionApproved;
    const rankTier = pawnSafeNow
      ? 0
      : retailSafeNow ? 1
        : recommendationState === "no-margin" ? 3
          : recommendationState === "no-demand" ? 4 : 5;
    let signal = "research";
    if (recommendationState === "no-margin") signal = "avoid";
    else if (decisionApproved && actionableSnapshot) signal = "candidate";
    else if (decisionApproved) signal = "watch";
    if (["research", "avoid"].includes(item.riskGate)) signal = item.riskGate;
    return {
      expectedClose,
      modeledBid,
      currentBid,
      currentBidKnown,
      forecast,
      hasForecast,
      marketplaceFee,
      marketplaceFeeCost: resaleMedian * marketplaceFee / 100,
      taxRate,
      taxCost,
      currentTaxCost,
      buyerPremium,
      buyerPremiumCost,
      currentBuyerPremiumCost,
      outboundShipping,
      repairReserve,
      returnReserve,
      shipping,
      shippingKnown,
      shippingEstimated,
      assumedInboundShipping,
      resaleLow,
      resaleMedian,
      resaleHigh,
      resaleAverage,
      netResaleLow: hasResaleEvidence ? netLow : null,
      netResaleMedian: hasResaleEvidence ? netMedian : null,
      netResaleHigh: hasResaleEvidence ? netHigh : null,
      rawMarketLow,
      rawMarketMedian,
      rawMarketHigh,
      rawMarketAverage,
      resaleEvidenceKind,
      marketSampleSize: resaleEvidenceKind === "completed"
        ? resaleEvidenceCount
        : resaleEvidenceKind === "analog-completed" ? analogEvidenceCount
          : resaleEvidenceKind === "specialty-guide" ? 1
            : resaleEvidenceKind === "used-market" ? uniqueUsedListings.length
              : resaleEvidenceKind === "retail-replacement" ? retailNewOffers.length : 0,
      marketSourceCount: resaleEvidenceKind === "completed"
        ? new Set(uniqueResaleEvidence.map((entry) => String(entry.source || "").toLowerCase()).filter(Boolean)).size
        : resaleEvidenceKind === "analog-completed"
          ? new Set(uniqueAnalogEvidence.map((entry) => String(entry.source || "").toLowerCase()).filter(Boolean)).size
          : resaleEvidenceKind === "specialty-guide" ? 1
            : resaleEvidenceKind === "used-market"
              ? new Set(uniqueUsedListings.map((entry) => String(entry.source || "").toLowerCase()).filter(Boolean)).size
              : resaleEvidenceKind === "retail-replacement" ? retailNewSourceCount : 0,
      marketPlanningHaircut: 1 - evidencePlanningFactor,
      acquisition,
      currentAcquisition,
      sellingCosts: resaleMedian - netMedian,
      profitLow,
      profitExpected,
      profitHigh,
      profitAtCurrentBid,
      onlineProfitLowAtCurrentBid,
      onlineProfitHighAtCurrentBid,
      pawnPayoutPercent,
      pawnLowPercent,
      pawnHighPercent,
      pawnTestingReserve,
      recoverableWeightFactor,
      pawnMeltBasis,
      pawnCashLow,
      pawnCashEstimate,
      pawnCashHigh,
      pawnProfitLow,
      pawnProfitAtCurrentBid,
      pawnProfitHigh,
      hasMetalEstimate,
      metalEvidenceTitleConflict,
      metalWeightMismatch,
      strictMetalPurityReject,
      metalPurityRejectionReason,
      hasPawnEstimate,
      hasDirectRetailerBuy,
      pawnBasisType,
      pawnBasisLabel,
      confidence,
      score,
      rankingScore,
      researchCoverageScore,
      signal,
      maxBid,
      breakEvenBid,
      bidHeadroom,
      bidHeadroomPercent,
      resaleMaxBid,
      resaleBreakEvenBid,
      pawnMaxBid,
      pawnBreakEvenBid,
      safeCeilingBasis,
      exitType,
      recommendationState,
      decisionApproved,
      decisionVerdict,
      selectedCeilingRoute,
      decisionProfitAtCurrentBid,
      decisionProfitLow,
      decisionProfitHigh,
      profitableNow,
      pawnSafeNow,
      retailSafeNow,
      onlineSafeNow,
      pawnLikelyProfitable,
      retailLikelyProfitable,
      onlineLikelyProfitable,
      minimumProfitTarget,
      rankTier,
      resalePopularityScore,
      saleLikelihood,
      pawnLiquidityScore,
      pawnSaleLikelihood,
      onlinePopularityScore,
      onlineSaleLikelihood,
      onlinePopularityKnown,
      retailDemandPass,
      retailDemandScore,
      minimumRetailDemandScore,
      hasRetailDemandEvidence,
      retailDemandEvidenceType,
      retailChannel,
      demandLookbackDays,
      recentCompletedSalesCount: recentCompletedSales.length,
      completedSalesDemandScore,
      specialtyAnnualSalesVolume,
      hasSpecialtyDemandEvidence,
      productReviewCountMax,
      productInterestKnown,
      roi,
      hours,
      hasResaleEvidence,
      resaleEvidenceCount,
      resaleEvidenceType: hasComparableResaleEvidence
          ? `${resaleEvidenceCount} exact-model sold comparable${resaleEvidenceCount === 1 ? "" : "s"}`
          : hasAnalogResaleEvidence
            ? `${analogEvidenceCount} near-match completed sales with a ${Math.round(analogCompHaircut * 100)}% uncertainty reserve`
            : hasSpecialtyEvidence
            ? `matched ${String(item.specialtyMarket?.channel || "specialty market")} value with a ${Math.round(specialtyGuideHaircut * 100)}% reserve`
            : hasUsedAskingEvidence
              ? `${uniqueUsedListings.length} matched used-market offers with a ${Math.round(askingPriceHaircut * 100)}% haircut`
              : hasRetailNewEvidence
                ? `${retailNewOffers.length} matched new-retail offers with a ${Math.round(retailReplacementHaircut * 100)}% condition/resale haircut`
                : "no verified resale evidence",
      hasComparableResaleEvidence,
      hasAnalogResaleEvidence,
      analogEvidenceCount,
      analogCompHaircut,
      hasUsedAskingEvidence,
      hasRetailUsedEvidence,
      hasRetailNewEvidence,
      hasSpecialtyEvidence,
      specialtyGuideValue,
      specialtyRetailSellValue,
      specialtyRetailerBuyValue,
      onlineUsedLow,
      onlineUsedMedian,
      onlineUsedHigh,
      onlineUsedAverage,
      usedAskingCount: uniqueUsedListings.length,
      askingPriceHaircut,
      retailReplacementHaircut,
      specialtyGuideHaircut,
      retailNewLow,
      retailNewMedian,
      retailNewHigh,
      retailNewAverage,
      retailNewCount: retailNewOffers.length,
      askingMarketAsOf: Number.isFinite(askingMarketAsOf) ? new Date(askingMarketAsOf).toISOString() : null,
      retailMarketAsOf: Number.isFinite(retailMarketAsOf) ? new Date(retailMarketAsOf).toISOString() : null,
      specialtyMarketAsOf: Number.isFinite(specialtyMarketAsOf) ? new Date(specialtyMarketAsOf).toISOString() : null,
      hasLiquidityEvidence,
      soldListingCount,
      activeListingCount,
      sellThroughRate,
      medianDaysToSell,
      liquidityScore,
      liquidityLabel,
      resaleLookbackDays,
      resaleChannel: String(item.resaleMarket?.channel || "Completed-sales feed"),
      resaleMarketAsOf: Number.isFinite(resaleMarketAsOf) ? new Date(resaleMarketAsOf).toISOString() : null,
      hasDecisionInputs,
      actionableSnapshot,
    };
  }

  function signalLabel(signal) {
    return { candidate: "Candidate", watch: "Watch", research: "Research", avoid: "Avoid" }[signal] || "Research";
  }

  function recommendationLabel(state) {
    return {
      "mixed-material": "NO · Mixed material",
      "pawn-safe": "YES · Pawn profit",
      "retail-safe": "YES · Retail profit",
      "no-demand": "NO · Demand unproven",
      "no-margin": "NO · Margin too low",
      "no-evidence": "NO · Evidence missing",
    }[state] || "NO · Do not bid";
  }

  function recommendationClass(state) {
    if (["pawn-safe", "retail-safe"].includes(state)) return "is-safe";
    if (["mixed-material", "no-demand", "no-margin"].includes(state)) return "is-unsafe";
    return "is-unknown";
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

  function renderOpportunityRow(item, rank = null) {
    const a = assess(item);
    const publicResearch = publicWebResearchFor(item);
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
    const exitBadge = a.exitType === "pawn"
      ? '<span class="status-pill pawn-exit">CASH BUYER FIRST</span>'
      : a.hasComparableResaleEvidence
        ? '<span class="status-pill sold-exit">ONLINE · SOLD COMPS</span>'
        : a.hasSpecialtyEvidence
          ? '<span class="status-pill sold-exit">ONLINE · PRICE GUIDE</span>'
          : a.hasUsedAskingEvidence
            ? '<span class="status-pill asking-exit">ONLINE · USED MARKET</span>'
            : a.hasRetailNewEvidence ? '<span class="status-pill asking-exit">ONLINE · RETAIL PROXY</span>' : "";
    const verdictBadge = `<span class="exit-verdict ${recommendationClass(a.recommendationState)}">${escapeHtml(recommendationLabel(a.recommendationState))}</span>`;
    const researchRead = publicResearch ? publicResearchMarketRead(publicResearch, a.currentAcquisition) : null;
    const rowProfit = a.decisionProfitAtCurrentBid;
    const rowProfitLabel = a.decisionApproved
      ? (a.exitType === "pawn" ? "Likely pawn profit" : "Likely retail profit")
      : researchRead ? "Internet market read" : "Final decision";
    const rowDecisionValue = !a.currentBidKnown
      ? "BID UNKNOWN"
      : a.decisionApproved
        ? money(rowProfit)
        : a.recommendationState === "no-margin" && a.maxBid > 0 ? `OVER BY ${money(Math.max(0, -a.bidHeadroom))}`
          : a.recommendationState === "no-margin" ? "NO TARGET-SAFE BID"
            : a.recommendationState === "no-demand" ? "DEMAND FAIL"
              : researchRead ? researchRead.value : "RESEARCH";
    const rowDecisionClass = a.decisionApproved
      ? "positive"
      : researchRead?.tone === "reference" ? "research" : "negative";
    const exitSummary = a.exitType === "pawn"
      ? `${money(a.pawnCashEstimate)} likely cash offer · ${escapeHtml(a.pawnBasisLabel)}`
      : a.hasComparableResaleEvidence
        ? `${money(a.rawMarketMedian)} sold median · ${a.hasLiquidityEvidence ? `${a.liquidityLabel} liquidity` : "velocity unknown"}${a.hasPawnEstimate ? " · cash exit did not clear target" : ""}`
        : a.hasSpecialtyEvidence
          ? `${money(a.rawMarketMedian)} specialty guide · ${a.specialtyAnnualSalesVolume ? `${a.specialtyAnnualSalesVolume.toLocaleString()} yearly units` : "volume unavailable"}`
          : a.hasUsedAskingEvidence
            ? `${money(a.rawMarketAverage)} average used asking · ${Math.round(a.askingPriceHaircut * 100)}% haircut${a.hasPawnEstimate ? " · cash exit did not clear target" : ""}`
            : a.hasRetailNewEvidence
              ? `${money(a.rawMarketMedian)} new-retail median · ${Math.round(a.retailReplacementHaircut * 100)}% resale haircut`
              : researchRead
                ? researchRead.detail
                : "Internet research pending · no defensible online price evidence";
    return `
      <article class="opportunity-row${selected}${sourceUrl ? " has-source-link" : ""}" data-select-id="${escapeHtml(item.id)}"${sourceUrl ? ` data-source-url="${escapeHtml(sourceUrl)}"` : ""} role="group" tabindex="0" aria-label="${escapeHtml(item.title)}; press Enter to open the profitability analysis${sourceUrl ? `; use the source link to visit ${escapeHtml(marketplace.name)}` : "; source listing URL unavailable"}">
        <div class="item-cell">
          ${rank ? `<span class="profit-rank" title="Profit likelihood rank">#${rank}</span>` : ""}
          ${imageUrl ? `<img class="item-thumbnail" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" />` : `<span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>`}
          <span class="item-copy">
            ${sourceUrl ? `<a class="row-title-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener" data-direct-listing>${escapeHtml(item.title)}</a>` : `<strong>${escapeHtml(item.title)}</strong>`}
            <small>${escapeHtml(marketplace.name)} · ${escapeHtml(item.category)} · ${escapeHtml(item.externalId)}</small>
            <span class="signal-line">${verdictBadge}<span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span>${exitBadge}<span class="status-pill">${statusText}</span><span class="snapshot-freshness ${freshness.className}" title="Last checked ${escapeHtml(formatDateTime(freshness.checkedAt))}">${escapeHtml(freshness.short)}</span><span class="snapshot-cadence ${escapeHtml(snapshotPlan.urgency)}">${escapeHtml(snapshotPlan.label)}</span>${authenticationBadge}${item.publishedResearch ? '<span class="status-pill research-source">PUBLISHED</span>' : ""}</span>
          </span>
          <span class="score-mini" style="--score:${a.rankingScore};--score-color:${scoreColor(a.signal)}" data-score="${a.rankingScore}" aria-label="Evidence-weighted profit ranking score ${a.rankingScore} out of 100"></span>
        </div>
        <div class="money-cell"><span>${a.currentBidKnown ? "Observed" : "Opening price"} / ${a.shippingEstimated ? "est. landed" : "landed"}</span><strong>${money(item.currentBid)}</strong><small>${money(a.currentAcquisition)} ${a.shippingEstimated ? "estimated" : "recorded"} landed · ${a.hasForecast ? `expected ${money(a.expectedClose)}` : "close unmodeled"} · ${Number(item.bidCount) || 0} bids${a.currentBidKnown ? "" : " · live bid not exposed"}</small></div>
        <div class="money-cell"><span>Target-safe / break-even</span><strong>${a.maxBid > 0 ? money(a.maxBid) : "Not established"}</strong><small>${a.breakEvenBid > 0 ? `${money(a.breakEvenBid)} break-even` : "No evidence-qualified ceiling"}${a.maxBid > 0 ? ` · ${a.bidHeadroom >= 0 ? `${money(a.bidHeadroom)} headroom` : `${money(Math.abs(a.bidHeadroom))} over ceiling`}` : ""}${a.shippingEstimated ? " · shipping provisional" : ""}</small></div>
        <div class="money-cell"><span>${rowProfitLabel}</span><strong class="${rowDecisionClass}">${rowDecisionValue}</strong><small>${escapeHtml(exitSummary)}</small></div>
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
      <tbody>${comparables.slice(0, 12).map((entry) => {
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

  function publicWebResearchFor(item) {
    const market = item?.researchMarket;
    if (!market || typeof market !== "object") return null;
    const researchedAt = Number.isFinite(Date.parse(market.researchedAt || "")) ? market.researchedAt : null;
    const results = (Array.isArray(market.results) ? market.results : [])
      .map((entry) => {
        const price = Number(entry?.price);
        return {
          title: String(entry?.title || "Public market result"),
          url: safeHttpUrl(entry?.url || entry?.sourceUrl),
          source: String(entry?.source || "Public web"),
          price: Number.isFinite(price) && price > 0 ? price : null,
          listingState: String(entry?.listingState || "observed").toLowerCase(),
          matchType: String(entry?.matchType || "lead").toLowerCase(),
          dateLabel: String(entry?.dateLabel || "Date not exposed"),
          note: String(entry?.note || ""),
        };
      })
      .filter((entry) => entry.url)
      .slice(0, 20);
    if (!researchedAt || !results.length) return null;
    const summary = market.priceSummary && typeof market.priceSummary === "object" ? market.priceSummary : {};
    const referenceMedian = Number(summary.median);
    return {
      researchedAt,
      method: String(market.method || "Agent-assisted public web research"),
      query: String(market.query || item.title || ""),
      summary: String(market.summary || "Public web results were reviewed."),
      limitation: String(market.limitation || "Reference-only research does not create a bid ceiling."),
      soldCount: results.filter((entry) => ["sold", "completed", "ended-auction"].includes(entry.listingState)).length,
      askingCount: results.filter((entry) => ["active", "asking"].includes(entry.listingState)).length,
      referenceMedian: Number.isFinite(referenceMedian) && referenceMedian > 0 ? referenceMedian : null,
      results,
    };
  }

  function publicResearchMarketRead(research, landedCost) {
    const resultCount = research.results.length;
    const evidenceLabel = `${resultCount} internet result${resultCount === 1 ? "" : "s"} reviewed`;
    if (!research.referenceMedian) {
      return {
        value: "RESEARCHED",
        tone: "reference",
        detail: `${evidenceLabel} · no defensible median · not bid-safe`,
      };
    }
    const referenceSpread = research.referenceMedian - Math.max(0, Number(landedCost) || 0);
    if (referenceSpread <= 0) {
      return {
        value: "ABOVE REFERENCE",
        tone: "negative",
        detail: `${money(Math.abs(referenceSpread))} above ${money(research.referenceMedian)} reference median before resale fees`,
      };
    }
    return {
      value: `VERIFY +${money(referenceSpread)}`,
      tone: "reference",
      detail: `${money(referenceSpread)} gross spread to ${money(research.referenceMedian)} reference median · seller fees and risk not cleared`,
    };
  }

  function renderPublicWebResearch(item) {
    const research = publicWebResearchFor(item);
    if (!research) return "";
    return `<section class="detail-section comparable-sales public-web-research">
      <div class="detail-section-heading"><h4>Internet research ledger</h4><span>reference only · researched ${escapeHtml(formatDateTime(research.researchedAt))}</span></div>
      <div class="research-ledger-summary">
        <div><span>Results reviewed</span><strong>${research.results.length}</strong><small>${research.soldCount} sold/ended · ${research.askingCount} active asks</small></div>
        <div><span>Reference median</span><strong>${research.referenceMedian ? money(research.referenceMedian) : "Unavailable"}</strong><small>never used as a safe ceiling by itself</small></div>
        <div><span>Research method</span><strong>${escapeHtml(research.method)}</strong><small>${escapeHtml(research.query)}</small></div>
      </div>
      <p class="research-ledger-note"><strong>Finding:</strong> ${escapeHtml(research.summary)} <strong>Limitation:</strong> ${escapeHtml(research.limitation)}</p>
      <div class="comparable-sales-list"><table class="comparable-sales-table">
        <thead><tr><th scope="col">Internet result</th><th scope="col">State</th><th scope="col">Date</th><th scope="col">Price</th><th scope="col">Proof</th></tr></thead>
        <tbody>${research.results.map((entry) => `<tr>
          <td><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.matchType)}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small></td>
          <td>${escapeHtml(entry.listingState)}</td>
          <td>${escapeHtml(entry.dateLabel)}</td>
          <td><strong>${entry.price ? money(entry.price) : "—"}</strong></td>
          <td><a href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer noopener">Open evidence ↗</a></td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>`;
  }

  function renderObservationLedger(item) {
    const endsAt = Date.parse(item.endsAt || "");
    const observations = (Array.isArray(item.observations) ? item.observations : [])
      .filter((entry) => Number(entry?.currentBid) >= 0)
      .sort((left, right) => Date.parse(left.observedAt || "") - Date.parse(right.observedAt || ""))
      .slice(-24);
    if (!observations.length) {
      return '<div class="no-history-state"><strong>No retained bid changes yet</strong><p>The next strictly higher bid will add a timestamped observation. Unchanged checks are intentionally not stored.</p></div>';
    }
    return `<div class="comparable-sales-list"><table class="comparable-sales-table observation-ledger">
      <thead><tr><th scope="col">Snapshot</th><th scope="col">Observed bid</th><th scope="col">Increase</th><th scope="col">Time remaining</th></tr></thead>
      <tbody>${observations.map((entry, index) => {
        const previous = index > 0 ? Number(observations[index - 1].currentBid) : null;
        const current = Number(entry.currentBid) || 0;
        const observedAt = Date.parse(entry.observedAt || "");
        const hoursToClose = Number.isFinite(endsAt) && Number.isFinite(observedAt) ? (endsAt - observedAt) / 3600000 : null;
        const remaining = hoursToClose === null
          ? "Unknown"
          : hoursToClose <= 0 ? "At / after close"
            : hoursToClose < 1 ? `${Math.max(1, Math.round(hoursToClose * 60))} minutes`
              : hoursToClose < 48 ? `${hoursToClose.toFixed(1)} hours` : `${(hoursToClose / 24).toFixed(1)} days`;
        return `<tr><td>${escapeHtml(formatDateTime(entry.observedAt))}</td><td><strong>${money(current)}</strong></td><td>${previous === null ? "First retained" : `+${money(Math.max(0, current - previous))}`}</td><td>${escapeHtml(remaining)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function renderDetail(item, rank = null, rankedTotal = null) {
    const container = $("[data-opportunity-detail]");
    if (!container) return;
    if (!item) {
      container.innerHTML = '<div class="empty-state"><span>⌁</span><h4>Select an opportunity</h4><p>Use Analyze to inspect the conservative bid model; clicking the listing row opens its source auction.</p></div>';
      return;
    }
    const a = assess(item);
    const curve = curveFor(item, a);
    const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
    const imageUrl = safeHttpUrl(item.imageUrl);
    const freshness = freshnessFor(item);
    const marketplace = marketplaceFor(item);
    const publicResearch = publicWebResearchFor(item);
    const snapshotPlan = snapshotPlanFor(item);
    const acquisitionComparables = a.forecast.comparables || [];
    const resaleComparables = resaleComparablesFor(item);
    const displayedProfit = a.decisionProfitAtCurrentBid;
    const displayedAcquisition = a.currentAcquisition;
    const displayedExitValue = a.exitType === "pawn" ? a.pawnCashEstimate : a.resaleMedian;
    const displayedExitCosts = a.exitType === "pawn" ? a.pawnTestingReserve : a.sellingCosts;
    const maxWaterfall = Math.max(displayedExitValue, displayedAcquisition, displayedExitCosts, Math.abs(displayedProfit), 1);
    const resaleMarketHistory = (Array.isArray(item.resaleMarketHistory) ? item.resaleMarketHistory : [])
      .filter((entry) => Number(entry?.priceMedian) > 0 && Number.isFinite(Date.parse(entry?.asOf || "")))
      .sort((left, right) => Date.parse(left.asOf) - Date.parse(right.asOf));
    const priorMarket = resaleMarketHistory.length > 1 ? resaleMarketHistory.at(-2) : null;
    const medianTrend = priorMarket ? a.resaleMedian / Number(priorMarket.priceMedian) - 1 : null;
    const marketLow = a.rawMarketLow;
    const marketMedian = a.rawMarketMedian;
    const marketAverage = a.rawMarketAverage;
    const marketHigh = a.rawMarketHigh;
    const marketSampleSize = a.marketSampleSize;
    const marketDescriptor = {
      completed: { title: "Completed-sale price consensus", unit: "completed sales", price: "sold", basis: "real completed exact-model transactions" },
      "analog-completed": { title: "Near-match completed-sale range", unit: "analog completed sales", price: "sold", basis: "materially similar completed sales; discounted for mismatch risk" },
      "specialty-guide": { title: "Specialty market price guide", unit: "specialty product", price: "guide", basis: "current specialty guide values" },
      "used-market": { title: "Used-market price consensus", unit: "active used offers", price: "asking", basis: "matched active used-market offers" },
      "retail-replacement": { title: "New-retail replacement market", unit: "new retail offers", price: "retail", basis: "matched new-retail offers; not used-condition sales" },
      none: { title: "Resale market evidence", unit: "market observations", price: "market", basis: "no usable evidence" },
    }[a.resaleEvidenceKind];
    const marketOfferLinks = (Array.isArray(item.retailMarket?.offers) ? item.retailMarket.offers : [])
      .filter((entry) => safeHttpUrl(entry?.url) && Number(entry?.matchScore) >= 65)
      .slice(0, 8);
    const specialtySourceUrl = a.hasSpecialtyEvidence ? safeHttpUrl(item.specialtyMarket?.sourceUrl) : "";
    const pawnRouteLabel = a.strictMetalPurityReject
      ? "FAIL · Mixed metal/material rejected"
      : !a.hasPawnEstimate
      ? "FAIL · No precious-metal liquidation evidence"
      : a.pawnSafeNow ? "PASS · Pawn profit clears target"
        : "FAIL · Pawn profit does not clear target";
    const onlineRouteLabel = !a.hasResaleEvidence
      ? "FAIL · No defensible retail price"
      : !a.retailDemandPass
        ? "FAIL · Price found, but demand is unproven"
        : a.retailSafeNow ? "PASS · Retail profit clears target"
          : "FAIL · Retail margin does not clear target";
    const verdictHeadline = a.decisionApproved ? `YES — BID UP TO ${money(a.maxBid)}` : "NO — DO NOT BID";
    const recommendationExplanation = a.recommendationState === "pawn-safe"
      ? `YES. The precious-metal pawn route clears the profit target. The conservative maximum bid is ${money(a.pawnMaxBid)}; verify purity, weight, and the buyer before bidding.`
      : a.recommendationState === "mixed-material"
        ? `NO. ${a.metalPurityRejectionReason} BidAI Pro assigns a $0 ceiling and does not route this listing to pawn or online resale.`
        : a.recommendationState === "retail-safe"
        ? `YES. The pawn gate did not qualify, but retail does: sell through ${a.retailChannel}, supported by ${a.retailDemandEvidenceType}. Do not exceed ${money(a.resaleMaxBid)}.`
        : a.recommendationState === "no-demand"
          ? `NO. A market price was found, but there is not enough proof that the item can be resold reliably. Active listings and product reviews alone do not justify a bid ceiling.`
          : a.recommendationState === "no-margin"
            ? `NO. At the observed bid, every evidence-qualified route misses the configured profit target. The most you should have paid is ${money(a.maxBid)}.`
            : "NO. Neither precious-metal pawn evidence nor a retail route with both price and demand proof is available.";
    const width = (value) => `${Math.max(3, Math.min(100, Math.abs(value) / maxWaterfall * 100)).toFixed(1)}%`;
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? item.evidence
      : [
          { label: "Identity", value: item.identifiedAs || "Identity not yet verified" },
          { label: "Authentication", value: item.authenticationEvidence || "No authentication evidence supplied" },
          { label: "Forecast", value: a.hasForecast ? `${a.forecast.exactModelCount} exact-model outcomes` : "Insufficient exact-model outcomes" },
          { label: "Costs", value: a.shippingKnown ? "Inbound shipping recorded" : `${money(a.shipping)} conservative inbound estimate` },
        ];
    const rankLabel = rank && rankedTotal ? `#${rank.toLocaleString()} of ${rankedTotal.toLocaleString()}` : "Not ranked in current filter";
    const popularityLabel = !a.hasRetailDemandEvidence
      ? "Unproven"
      : a.retailDemandScore >= 80 ? "Very high"
        : a.retailDemandScore >= 65 ? "High"
          : a.retailDemandScore >= a.minimumRetailDemandScore ? "Qualified"
            : a.retailDemandScore >= 35 ? "Weak" : "Low";
    const routeName = a.exitType === "pawn"
      ? "Pawn shop / precious-metal buyer"
      : a.exitType === "online-resale" ? a.retailChannel : "No approved exit";
    const coverageChecks = [
      { label: "Source listing", pass: Boolean(sourceUrl), detail: sourceUrl ? `${marketplace.name} link available` : "Canonical listing link missing" },
      { label: "Identity", pass: Boolean(item.modelKey || item.identifiedAs), detail: item.identifiedAs || item.modelKey || "Exact identity not supplied" },
      { label: "Condition", pass: Boolean(item.conditionSummary || Number(item.conditionConfidence) > 0), detail: item.conditionSummary || (Number(item.conditionConfidence) > 0 ? `${percent(parseConfidence(item.conditionConfidence, 0))} confidence` : "Condition not supplied") },
      { label: "Inbound shipping", pass: a.shippingKnown, detail: a.shippingKnown ? `${money(a.shipping)} recorded` : `${money(a.shipping)} assumption only` },
      { label: "Close forecast", pass: a.hasForecast, detail: a.hasForecast ? `${a.forecast.exactModelCount} exact-model outcomes` : `${a.forecast.exactModelCount}/5 required outcomes` },
      { label: "Pawn valuation", pass: a.hasPawnEstimate, detail: a.hasPawnEstimate ? `${money(a.pawnCashLow)}–${money(a.pawnCashHigh)} modeled cash` : a.metalEvidenceTitleConflict ? "Rejected: plated or non-solid metal wording" : "No verified metal valuation" },
      { label: "Retail pricing", pass: a.hasResaleEvidence, detail: a.hasResaleEvidence ? a.resaleEvidenceType : "No defensible price evidence" },
      { label: "Retail demand", pass: a.retailDemandPass, detail: a.hasRetailDemandEvidence ? `${a.retailDemandScore}/100 · ${a.retailDemandEvidenceType}` : "No sell-through or sales-volume proof" },
      { label: "Internet research", pass: Boolean(publicResearch), detail: publicResearch ? `${publicResearch.results.length} public results reviewed; reference-only until evidence gates pass` : "No public web research stored yet" },
    ];
    const missingIntelligence = [];
    if (!sourceUrl) missingIntelligence.push("The canonical auction URL is missing, so source photos and description cannot be audited from this record.");
    if (!item.modelKey && !item.identifiedAs) missingIntelligence.push("Exact maker, model, variant, or normalized model key has not been established.");
    if (!item.conditionSummary && !(Number(item.conditionConfidence) > 0)) missingIntelligence.push("Condition, completeness, defects, and functional status have not been documented.");
    if (item.authenticationStatus !== "source-stated") missingIntelligence.push("No source-stated authentication claim is present; authenticity remains unverified.");
    if (a.shippingEstimated) missingIntelligence.push(`Inbound shipping is an assumption of ${money(a.shipping)}, not a source-confirmed charge.`);
    if (!a.hasForecast) missingIntelligence.push(`Expected closing price is withheld because only ${a.forecast.exactModelCount} of 5 required exact-model outcomes are available.`);
    if (a.strictMetalPurityReject) missingIntelligence.push(a.metalPurityRejectionReason);
    else if (a.metalEvidenceTitleConflict) missingIntelligence.push("A stored metal estimate was rejected because the title describes plated, filled, vermeil, overlay, bonded, clad, or electroplated material rather than solid precious metal.");
    else if (!a.hasPawnEstimate) missingIntelligence.push("Pawn value is withheld because fresh precious-metal spot, purity, and weight evidence is incomplete or inapplicable.");
    if (!a.hasResaleEvidence) missingIntelligence.push(publicResearch
      ? `Internet research reviewed ${publicResearch.results.length} result${publicResearch.results.length === 1 ? "" : "s"}, but the online resale price is withheld because the dated identity, condition, or demand evidence is not strong enough for a safe ceiling.`
      : "Online resale price is withheld until enough closely matched real market observations are connected.");
    if (a.hasResaleEvidence && !a.retailDemandPass) missingIntelligence.push(`Retail demand does not clear the required ${a.minimumRetailDemandScore.toFixed(0)}/100 threshold.`);
    if (["is-stale", "is-invalid", "is-unknown"].includes(freshness.className)) missingIntelligence.push(`The auction was last checked ${freshness.short}; refresh it before relying on the observed bid.`);
    const dueDiligence = [
      "Open the source listing and match every photo, marking, serial number, included accessory, and stated defect to the modeled identity.",
      a.shippingKnown ? `Confirm the recorded ${money(a.shipping)} inbound shipping and any handling charge still apply to your destination.` : `Replace the ${money(a.shipping)} shipping assumption with the actual destination quote before bidding.`,
      item.authenticationStatus === "source-stated" ? "Treat the seller's authentication wording as a claim only; verify the named authenticator and certificate independently." : "Do not pay an authenticity premium without independent authentication evidence.",
      a.hasMetalEstimate ? "Have purity and recoverable weight tested on calibrated equipment; stones, movement, band, and non-metal parts can reduce payable metal." : "Do not assume a pawn shop will buy this item or assign it a cash value without a category-specific quote.",
      a.hasPawnEstimate ? "Call at least two local precious-metal buyers or pawn shops for their current payout percentage before the auction closes." : "If pursuing a local cash exit, obtain a written or same-day buyer indication before bidding.",
      a.hasResaleEvidence ? `Recheck the newest matched evidence on ${a.retailChannel}; compare the same condition, completeness, and model variant.` : "Connect completed-sale or specialty-market evidence before relying on online resale.",
      a.retailDemandPass ? `Plan for the measured demand case: ${a.retailDemandEvidenceType}.` : "Do not treat active listings, reviews, watchers, or auction bids as proof that a used unit will sell.",
      "Recalculate taxes, buyer premium, selling fee, outbound shipping, repair/testing, and return/loss reserve for your actual accounts.",
    ];
    const landedAtBid = (bid) => ((Math.max(0, bid) * (1 + a.buyerPremium / 100) + a.shipping) * (1 + a.taxRate / 100));
    const pawnProfitAtBid = (bid) => a.hasPawnEstimate ? a.pawnCashEstimate - landedAtBid(bid) - a.pawnTestingReserve : null;
    const retailProfitAtBid = (bid) => a.hasResaleEvidence && a.retailDemandPass ? a.netResaleMedian - landedAtBid(bid) : null;
    const bidLadder = [
      { label: "Observed now", bid: a.currentBid, note: `${Number(item.bidCount) || 0} bids recorded` },
      { label: "Target-safe ceiling", bid: a.maxBid, note: a.safeCeilingBasis },
      ...(a.hasForecast ? [{ label: "Expected close", bid: a.expectedClose, note: `${money(a.forecast.low)}–${money(a.forecast.high)} modeled range` }] : []),
      ...(a.breakEvenBid > 0 ? [{ label: "Modeled break-even", bid: a.breakEvenBid, note: "Estimated profit reaches $0 on the selected route" }] : []),
    ];
    const profitCell = (value, unavailable) => value === null
      ? `<span class="not-approved">${escapeHtml(unavailable)}</span>`
      : `<strong class="${value >= 0 ? "positive" : "negative"}">${money(value)}</strong>`;
    container.innerHTML = `
      <div class="detail-top">
        <div class="detail-eyebrow"><span class="section-kicker"><i></i> COMPLETE ITEM UNDERWRITING DOSSIER</span><span class="dossier-rank">PROFIT RANK ${escapeHtml(rankLabel)}</span>${item.publishedResearch ? '<span class="record-source-chip published">PUBLISHED RECORD</span>' : '<span class="record-source-chip private">PRIVATE RECORD</span>'}</div>
        <div class="detail-title-row">
          ${imageUrl ? `<img class="detail-item-image" src="${escapeHtml(imageUrl)}" alt="" decoding="async" />` : `<span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>`}
          <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(marketplace.name)} · ${escapeHtml(item.externalId)} · ${escapeHtml(item.category)} · ${escapeHtml(item.resaleVertical || "Other")}</p><small>Evidence-weighted profit ranking score: ${a.rankingScore}/100 · research coverage: ${a.researchCoverageScore}/100</small></div>
          <span class="score-ring" style="--score:${a.rankingScore};--score-color:${scoreColor(a.signal, true)}" data-score="${a.rankingScore}" aria-label="Evidence-weighted profit ranking score ${a.rankingScore} out of 100"></span>
        </div>
        <div class="detail-signal"><span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span><span>${escapeHtml(item.identifiedAs || "Identity requires verification")}</span><span>${escapeHtml(routeName)}</span><span class="snapshot-freshness ${freshness.className}">${escapeHtml(freshness.label)} · ${escapeHtml(freshness.short)}</span></div>
      </div>
      <div class="detail-body">
        <section class="exit-decision-panel ${recommendationClass(a.recommendationState)}">
          <div class="exit-decision-head">
            <div><span>FINAL BID DECISION</span><h4>${escapeHtml(verdictHeadline)}</h4></div>
            <span class="exit-verdict ${recommendationClass(a.recommendationState)}">${escapeHtml(a.decisionVerdict)}</span>
          </div>
          <p>${escapeHtml(recommendationExplanation)}</p>
          <div class="exit-route-grid">
            <article class="exit-route-card ${a.decisionApproved && a.exitType === "pawn" ? "is-selected" : ""}">
              <div class="exit-route-title"><span>1</span><div><small>GATE ONE</small><strong>Pawn shop · precious metals</strong></div></div>
              <div class="exit-route-state ${a.pawnSafeNow ? "is-safe" : a.pawnLikelyProfitable ? "is-thin" : "is-unavailable"}">${escapeHtml(pawnRouteLabel)}</div>
              <dl>
                <div><dt>Likely pawn cash</dt><dd>${a.hasPawnEstimate ? money(a.pawnCashEstimate) : "Unavailable"}</dd></div>
                <div><dt>Likely profit now</dt><dd>${a.pawnProfitAtCurrentBid === null ? "Unavailable" : money(a.pawnProfitAtCurrentBid)}</dd></div>
                <div><dt>Target-safe bid</dt><dd>${money(a.pawnMaxBid)}</dd></div>
                <div><dt>Modeled break-even</dt><dd>${money(a.pawnBreakEvenBid)}</dd></div>
              </dl>
              <small class="exit-route-foot">${a.hasPawnEstimate ? `${escapeHtml(a.pawnBasisLabel)} · ${a.pawnLowPercent.toFixed(0)}% low / ${a.pawnPayoutPercent.toFixed(0)}% likely payout cases · verify with an actual buyer` : "Pawn receives no estimated value unless the listing supplies usable precious-metal purity and weight with a fresh spot quote."}</small>
            </article>
            <article class="exit-route-card ${a.decisionApproved && a.exitType === "online-resale" ? "is-selected" : ""}">
              <div class="exit-route-title"><span>2</span><div><small>GATE TWO</small><strong>Retail resale · price + demand</strong></div></div>
              <div class="exit-route-state ${a.onlineSafeNow ? "is-safe" : a.onlineLikelyProfitable ? "is-thin" : "is-unavailable"}">${escapeHtml(onlineRouteLabel)}</div>
              <dl>
                <div><dt>Likely sale price</dt><dd>${a.hasResaleEvidence ? money(a.resaleMedian) : "Unavailable"}</dd></div>
                <div><dt>Likely profit now</dt><dd>${a.profitAtCurrentBid === null ? "Unavailable" : money(a.profitAtCurrentBid)}</dd></div>
                <div><dt>Where to sell</dt><dd>${a.hasResaleEvidence ? escapeHtml(a.retailChannel) : "Unproven"}</dd></div>
                <div><dt>Demand gate</dt><dd>${a.retailDemandPass ? `PASS · ${a.retailDemandScore}/100` : `FAIL · ${a.retailDemandScore}/100`}</dd></div>
                <div><dt>Target-safe bid</dt><dd>${money(a.resaleMaxBid)}</dd></div>
                <div><dt>Modeled break-even</dt><dd>${money(a.resaleBreakEvenBid)}</dd></div>
              </dl>
              <small class="exit-route-foot">${a.hasResaleEvidence ? `Price proof: ${escapeHtml(a.resaleEvidenceType)}. Demand proof: ${escapeHtml(a.retailDemandEvidenceType)}. Required demand score: ${a.minimumRetailDemandScore.toFixed(0)}/100.` : "Retail requires both a defensible price and independent evidence that similar items actually sell. Asking prices alone cannot pass."}</small>
            </article>
          </div>
        </section>
        <section class="underwriting-snapshot" aria-label="Underwriting snapshot">
          <article><span>Profit rank</span><strong>${escapeHtml(rankLabel)}</strong><small>YES decisions first, then closest evidence-backed misses</small></article>
          <article><span>Observed bid</span><strong>${money(a.currentBid)}</strong><small>${Number(item.bidCount) || 0} bids · ${escapeHtml(timeLabel(item))}</small></article>
          <article><span>Landed cost now</span><strong>${money(a.currentAcquisition)}</strong><small>bid + premium + inbound shipping + tax</small></article>
          <article class="${a.decisionApproved ? "is-positive" : "is-negative"}"><span>Final answer</span><strong>${escapeHtml(a.decisionVerdict)}</strong><small>${escapeHtml(recommendationLabel(a.recommendationState))}</small></article>
          <article><span>Highest safe bid</span><strong>${money(a.maxBid)}</strong><small>${a.bidHeadroom >= 0 ? `${money(a.bidHeadroom)} remaining headroom` : `${money(Math.abs(a.bidHeadroom))} above the ceiling`}</small></article>
          <article><span>Likely pawn cash</span><strong>${a.hasPawnEstimate ? money(a.pawnCashEstimate) : "Unavailable"}</strong><small>${a.hasPawnEstimate ? `${money(a.pawnCashLow)}–${money(a.pawnCashHigh)} modeled range` : "verified metal inputs required"}</small></article>
          <article><span>Likely online sale</span><strong>${a.hasResaleEvidence ? money(a.resaleMedian) : "Unavailable"}</strong><small>${a.hasResaleEvidence ? `${money(a.rawMarketLow)}–${money(a.rawMarketHigh)} raw observed range` : "matched market price required"}</small></article>
          <article><span>Retail popularity</span><strong>${escapeHtml(popularityLabel)}</strong><small>${a.hasRetailDemandEvidence ? `${a.retailDemandScore}/100 · ${escapeHtml(a.retailDemandEvidenceType)}` : "no demand proof"}</small></article>
          <article><span>Likely profit now</span><strong class="${a.decisionProfitAtCurrentBid !== null && a.decisionProfitAtCurrentBid >= 0 ? "positive" : "negative"}">${a.decisionProfitAtCurrentBid === null ? "Unavailable" : money(a.decisionProfitAtCurrentBid)}</strong><small>${a.roi === null ? "ROI unavailable" : `${percent(a.roi)} modeled ROI on landed cost`}</small></article>
          <article><span>Likely time to sell</span><strong>${a.medianDaysToSell === null ? "Not measured" : `${a.medianDaysToSell.toFixed(1)} days`}</strong><small>${a.hasLiquidityEvidence ? `${percent(a.sellThroughRate)} sell-through` : "completed-sale velocity required"}</small></article>
        </section>
        <div class="dossier-columns">
          <section class="detail-section dossier-card">
            <div class="detail-section-heading"><h4>Item fact sheet</h4><span>facts retained from the source</span></div>
            <div class="fact-sheet-grid">
              <div><span>Identified as</span><strong>${escapeHtml(item.identifiedAs || "Not established")}</strong></div>
              <div><span>Model key</span><strong>${escapeHtml(item.modelKey || "Not supplied")}</strong></div>
              <div><span>Category</span><strong>${escapeHtml(item.category || "Unclassified")}</strong></div>
              <div><span>Resale vertical</span><strong>${escapeHtml(item.resaleVertical || "Other")}</strong></div>
              <div><span>Condition</span><strong>${escapeHtml(item.conditionSummary || item.condition || "Not supplied")}</strong><small>${percent(parseConfidence(item.conditionConfidence, 0))} condition confidence</small></div>
              <div><span>Authentication</span><strong>${escapeHtml(item.authenticationStatus === "source-stated" ? "Source-stated claim" : "Not supplied")}</strong><small>${escapeHtml(item.authenticationEvidence || "No authentication evidence retained")}</small></div>
              <div><span>Rarity signal</span><strong>${Math.round(Number(item.rarity) || 0)}/100</strong><small>source/model signal, not a valuation</small></div>
              <div><span>Marketplace</span><strong>${escapeHtml(marketplace.name)}</strong><small>${escapeHtml(item.externalId || item.id)}</small></div>
            </div>
          </section>
          <section class="detail-section dossier-card research-coverage-card">
            <div class="detail-section-heading"><h4>Research coverage</h4><span>${a.researchCoverageScore}/100 inputs covered</span></div>
            <div class="coverage-grid">${coverageChecks.map((check) => `<div class="coverage-check ${check.pass ? "is-complete" : "is-missing"}"><span>${check.pass ? "✓" : "!"}</span><div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div></div>`).join("")}</div>
          </section>
        </div>
        <section class="detail-section intelligence-gap-panel ${missingIntelligence.length ? "has-gaps" : "is-complete"}">
          <div class="detail-section-heading"><h4>Missing intelligence before money is committed</h4><span>${missingIntelligence.length} unresolved input${missingIntelligence.length === 1 ? "" : "s"}</span></div>
          ${missingIntelligence.length ? `<ol>${missingIntelligence.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ol>` : "<p>Every core underwriting input is present. Recheck freshness and source details immediately before bidding.</p>"}
        </section>
        <div class="bid-metrics">
          <div class="bid-metric"><span>${item.status === "ended" ? "Final recorded bid" : "Observed bid"}</span><strong>${money(item.status === "ended" && item.finalPrice ? item.finalPrice : item.currentBid)}</strong><small>${Number(item.bidCount) || 0} bids · ${timeLabel(item)} · ${escapeHtml(freshness.short)}</small></div>
          <div class="bid-metric"><span>Expected close</span><strong>${a.hasForecast ? money(a.expectedClose) : "Insufficient history"}</strong><small>${a.hasForecast ? `${money(a.forecast.low)}–${money(a.forecast.high)}` : `${a.forecast.exactModelCount}/5 exact-model outcomes`}</small></div>
          <div class="bid-metric primary"><span>Target-safe ceiling</span><strong>${money(a.maxBid)}</strong><small>Modeled break-even ${money(a.breakEvenBid)} · ${escapeHtml(a.safeCeilingBasis)}${a.shippingEstimated ? ` · includes ${money(a.shipping)} estimated inbound shipping` : ""}</small></div>
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
        <section class="detail-section resale-liquidity-panel">
          <div class="detail-section-heading"><h4>${escapeHtml(marketDescriptor.title)}</h4><span>${a.hasResaleEvidence ? `${marketSampleSize} observation${marketSampleSize === 1 ? "" : "s"} · ${a.marketSourceCount} source${a.marketSourceCount === 1 ? "" : "s"} · ${Math.round(a.marketPlanningHaircut * 100)}% planning reserve` : "real matched evidence required"}</span></div>
          ${a.hasResaleEvidence ? `
            <div class="profit-scenarios">
              <div class="downside"><span>Observed low / P20</span><strong>${money(marketLow)}</strong><small>${escapeHtml(marketDescriptor.basis)}</small></div>
              <div class="base"><span>Median ${escapeHtml(marketDescriptor.price)} price</span><strong>${money(marketMedian)}</strong><small>${marketSampleSize} matched ${escapeHtml(marketDescriptor.unit)}</small></div>
              <div><span>Average ${escapeHtml(marketDescriptor.price)} price</span><strong>${marketAverage === null ? "—" : money(marketAverage)}</strong><small>raw observed value before reserve</small></div>
              <div class="upside"><span>Observed high / P80</span><strong>${money(marketHigh)}</strong><small>planning median: ${money(a.resaleMedian)}</small></div>
            </div>
            ${(marketOfferLinks.length || specialtySourceUrl) ? `<div class="market-source-links"><span>CHECK THE EVIDENCE</span>${specialtySourceUrl ? `<a href="${escapeHtml(specialtySourceUrl)}" target="_blank" rel="noreferrer noopener">Open ${escapeHtml(item.specialtyMarket?.channel || "specialty guide")} ↗</a>` : ""}${marketOfferLinks.map((entry) => `<a href="${escapeHtml(safeHttpUrl(entry.url))}" target="_blank" rel="noreferrer noopener">${escapeHtml(entry.source || "Market offer")} · ${money(entry.totalPrice ?? entry.price)} ↗</a>`).join("")}</div>` : ""}
            ${a.hasLiquidityEvidence ? `<div class="cost-risk-grid">
              <div><span>Sell-through</span><strong>${percent(a.sellThroughRate)}</strong><small>${a.soldListingCount} sold ÷ ${a.soldListingCount + a.activeListingCount} sold + active</small></div>
              <div><span>Liquidity</span><strong>${a.liquidityScore}/100 · ${escapeHtml(a.liquidityLabel)}</strong><small>sell-through plus time-to-sale</small></div>
              <div><span>Median days to sell</span><strong>${a.medianDaysToSell === null ? "Not supplied" : `${a.medianDaysToSell.toFixed(1)} days`}</strong></div>
              <div><span>Market observed</span><strong>${escapeHtml(formatDateTime(a.resaleMarketAsOf))}</strong><small>asking prices excluded</small></div>
              <div><span>Median trend</span><strong>${medianTrend === null ? "Learning" : `${medianTrend >= 0 ? "+" : ""}${percent(medianTrend)}`}</strong><small>${resaleMarketHistory.length} validated market snapshot${resaleMarketHistory.length === 1 ? "" : "s"}</small></div>
            </div>` : a.hasRetailDemandEvidence
              ? `<div class="cost-risk-grid"><div><span>Demand proof</span><strong>${escapeHtml(a.retailDemandEvidenceType)}</strong></div><div><span>Demand gate</span><strong>${a.retailDemandPass ? "PASS" : "FAIL"} · ${a.retailDemandScore}/100</strong><small>minimum required ${a.minimumRetailDemandScore.toFixed(0)}/100</small></div><div><span>Modeled sale likelihood</span><strong>${a.retailDemandPass ? percent(a.onlineSaleLikelihood) : "Not approved"}</strong><small>planning signal, not a guarantee</small></div><div><span>Suggested channel</span><strong>${escapeHtml(a.retailChannel)}</strong></div></div>`
              : `<div class="no-history-state"><strong>Price found; retail demand unproven</strong><p>${a.productInterestKnown ? `${a.productReviewCountMax.toLocaleString()} product reviews show interest, but reviews do not prove resale sell-through. ` : ""}Active offers and auction bids do not show that comparable used items actually sell. Retail receives a $0 ceiling until completed-sale frequency, sell-through, or annual unit volume is available.</p></div>`}
          ` : `<div class="no-history-state"><strong>No defensible online resale price yet</strong><p>Connect completed-sale, eBay used-market, Google Shopping, or specialty price-guide evidence. Until real matched evidence is available, the safe ceiling remains $0 and the item is not promoted.</p></div>`}
        </section>
        <section class="detail-section channel-playbook">
          <div class="detail-section-heading"><h4>Where and how this item could be sold</h4><span>channel-by-channel exit plan</span></div>
          <div class="channel-plan-grid">
            <article class="channel-plan-card ${a.hasPawnEstimate ? "has-evidence" : "is-unavailable"}">
              <div><span>LOCAL CASH EXIT</span><strong>Pawn shop / precious-metal buyer</strong></div>
              <dl>
                <div><dt>Can BidAI price it?</dt><dd>${a.hasPawnEstimate ? "Yes · estimated" : "No"}</dd></div>
                <div><dt>Likely cash</dt><dd>${a.hasPawnEstimate ? money(a.pawnCashEstimate) : "Unavailable"}</dd></div>
                <div><dt>Cash range</dt><dd>${a.hasPawnEstimate ? `${money(a.pawnCashLow)}–${money(a.pawnCashHigh)}` : "Unavailable"}</dd></div>
                <div><dt>Likely profit now</dt><dd>${a.pawnProfitAtCurrentBid === null ? "Unavailable" : money(a.pawnProfitAtCurrentBid)}</dd></div>
                <div><dt>Time to cash</dt><dd>${a.hasPawnEstimate ? "Potentially same day; buyer not confirmed" : "Unknown"}</dd></div>
              </dl>
              <p>${a.hasPawnEstimate ? "Evidence supports a precious-metal liquidation estimate, not a guaranteed offer. Test purity and weight, then quote multiple buyers." : "No dollar value is shown because this record lacks the verified precious-metal inputs required for a defensible pawn estimate."}</p>
            </article>
            <article class="channel-plan-card ${a.hasResaleEvidence && a.retailDemandPass ? "has-evidence" : "is-unavailable"}">
              <div><span>RETAIL RESALE EXIT</span><strong>${escapeHtml(a.retailChannel)}</strong></div>
              <dl>
                <div><dt>Price evidence</dt><dd>${a.hasResaleEvidence ? money(a.resaleMedian) : "Unavailable"}</dd></div>
                <div><dt>Net proceeds</dt><dd>${a.netResaleMedian === null ? "Unavailable" : money(a.netResaleMedian)}</dd></div>
                <div><dt>Demand</dt><dd>${a.retailDemandPass ? `PASS · ${a.retailDemandScore}/100` : `FAIL · ${a.retailDemandScore}/100`}</dd></div>
                <div><dt>Likely profit now</dt><dd>${a.profitAtCurrentBid === null ? "Not approved" : money(a.profitAtCurrentBid)}</dd></div>
                <div><dt>Typical sale time</dt><dd>${a.medianDaysToSell === null ? "Not measured" : `${a.medianDaysToSell.toFixed(1)} days`}</dd></div>
              </dl>
              <p>${a.hasResaleEvidence ? `Price basis: ${escapeHtml(a.resaleEvidenceType)}. Demand basis: ${escapeHtml(a.retailDemandEvidenceType)}.` : "No online channel is approved until closely matched price evidence is present."}</p>
            </article>
            <article class="channel-plan-card dealer-reference ${a.hasDirectRetailerBuy ? "has-evidence" : "is-unavailable"}">
              <div><span>ALTERNATE DEALER REFERENCE</span><strong>Specialty retailer / dealer</strong></div>
              <dl>
                <div><dt>Guide value</dt><dd>${a.specialtyGuideValue > 0 ? money(a.specialtyGuideValue) : "Unavailable"}</dd></div>
                <div><dt>Dealer buy reference</dt><dd>${a.specialtyRetailerBuyValue > 0 ? money(a.specialtyRetailerBuyValue) : "Unavailable"}</dd></div>
                <div><dt>Dealer sell reference</dt><dd>${a.specialtyRetailSellValue > 0 ? money(a.specialtyRetailSellValue) : "Unavailable"}</dd></div>
                <div><dt>Annual volume</dt><dd>${a.specialtyAnnualSalesVolume > 0 ? a.specialtyAnnualSalesVolume.toLocaleString() : "Unavailable"}</dd></div>
              </dl>
              <p>Dealer references are displayed separately. They are not pawn quotes, purchase commitments, or proof that this exact item will be accepted.</p>
            </article>
          </div>
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>${a.exitType === "pawn" ? "Immediate cash-exit waterfall" : "Online-resale profit waterfall"}</h4><span>${escapeHtml(a.safeCeilingBasis)}</span></div>
          <div class="waterfall">
            <div class="waterfall-row"><span>${a.exitType === "pawn" ? "Likely pawn / cash-buyer offer" : "Planning resale value"}</span><span class="waterfall-track"><i style="--width:${width(displayedExitValue)}"></i></span><strong>${money(displayedExitValue)}</strong></div>
            <div class="waterfall-row cost"><span>Landed at observed bid</span><span class="waterfall-track"><i style="--width:${width(displayedAcquisition)}"></i></span><strong>−${money(displayedAcquisition)}</strong></div>
            <div class="waterfall-row cost"><span>${a.exitType === "pawn" ? "Testing reserve" : "Sell + risk costs"}</span><span class="waterfall-track"><i style="--width:${width(displayedExitCosts)}"></i></span><strong>−${money(displayedExitCosts)}</strong></div>
            <div class="waterfall-row profit ${displayedProfit !== null && displayedProfit < 0 ? "negative" : ""}"><span>Likely profit if won now</span><span class="waterfall-track"><i style="--width:${width(displayedProfit)}"></i></span><strong>${displayedProfit === null ? (a.recommendationState === "no-demand" ? "Demand gate failed" : "No approved exit") : money(displayedProfit)}</strong></div>
          </div>
          ${displayedProfit !== null ? `<div class="profit-scenarios">
            <div class="downside"><span>Low cash case</span><strong>${money(a.decisionProfitLow)}</strong><small>${money(a.exitType === "pawn" ? a.pawnCashLow : a.resaleLow)} exit value</small></div>
            <div class="base"><span>Likely case</span><strong>${money(a.decisionProfitAtCurrentBid)}</strong><small>${money(a.exitType === "pawn" ? a.pawnCashEstimate : a.resaleMedian)} exit value</small></div>
            <div class="upside"><span>High cash case</span><strong>${money(a.decisionProfitHigh)}</strong><small>${money(a.exitType === "pawn" ? a.pawnCashHigh : a.resaleHigh)} exit value</small></div>
          </div>` : ""}
        </section>
        <section class="detail-section cost-risk-panel">
          <div class="detail-section-heading"><h4>Full cost stack at observed bid</h4><span>${a.shippingKnown ? "recorded inbound shipping" : `${money(a.shipping)} conservative shipping estimate`}</span></div>
          <div class="cost-risk-grid">
            <div><span>Observed bid basis</span><strong>${money(a.currentBid)}</strong></div>
            <div><span>Inbound shipping</span><strong>${money(a.shipping)}</strong><small>${a.shippingKnown ? "recorded by source" : "user-configured conservative estimate"}</small></div>
            <div><span>Buyer premium (${a.buyerPremium.toFixed(2)}%)</span><strong>${money(a.currentBuyerPremiumCost)}</strong></div>
            <div><span>Purchase tax (${a.taxRate.toFixed(2)}%)</span><strong>${money(a.currentTaxCost)}</strong></div>
            <div><span>Landed acquisition now</span><strong>${money(a.currentAcquisition)}</strong></div>
            <div><span>Pawn testing reserve</span><strong>${money(a.pawnTestingReserve)}</strong><small>pawn route only</small></div>
            <div><span>Marketplace fee (${a.marketplaceFee.toFixed(2)}%)</span><strong>${money(a.marketplaceFeeCost)}</strong><small>online route only; based on planning resale</small></div>
            <div><span>Outbound shipping</span><strong>${money(a.outboundShipping)}</strong><small>online route only</small></div>
            <div><span>Repair / testing reserve</span><strong>${money(a.repairReserve)}</strong><small>online route only</small></div>
            <div><span>Return / loss reserve</span><strong>${money(a.returnReserve)}</strong><small>online route only</small></div>
          </div>
        </section>
        <section class="detail-section bid-ladder-panel">
          <div class="detail-section-heading"><h4>Profit at every important bid level</h4><span>current assumptions applied consistently</span></div>
          <div class="comparable-sales-list"><table class="comparable-sales-table bid-ladder-table">
            <thead><tr><th scope="col">Bid level</th><th scope="col">Bid</th><th scope="col">Landed cost</th><th scope="col">Pawn profit</th><th scope="col">Retail profit</th><th scope="col">Meaning</th></tr></thead>
            <tbody>${bidLadder.map((level) => {
              const pawnProfit = pawnProfitAtBid(level.bid);
              const retailProfit = retailProfitAtBid(level.bid);
              return `<tr><td><strong>${escapeHtml(level.label)}</strong></td><td>${money(level.bid)}</td><td>${money(landedAtBid(level.bid))}</td><td>${profitCell(pawnProfit, "No pawn evidence")}</td><td>${profitCell(retailProfit, a.hasResaleEvidence ? "Demand not approved" : "No retail price")}</td><td><small>${escapeHtml(level.note)}</small></td></tr>`;
            }).join("")}</tbody>
          </table></div>
        </section>
        ${item.metalEstimate ? `<section class="detail-section cost-risk-panel">
          <div class="detail-section-heading"><h4>Pawn / precious-metal exit</h4><span>${a.hasMetalEstimate ? `${a.pawnLowPercent.toFixed(0)}%–${a.pawnHighPercent.toFixed(0)}% modeled offer range` : "quote stale or invalid"}</span></div>
          <div class="cost-risk-grid">
            <div><span>Source-described material</span><strong>${escapeHtml(`${item.metalEstimate.purityLabel || "Unknown purity"} ${item.metalEstimate.metal || "metal"}`)}</strong><small>${Number(item.metalEstimate.grossWeightGrams).toFixed(2)} g gross</small></div>
            <div><span>Gross melt ceiling</span><strong>${a.hasMetalEstimate ? money(item.metalEstimate.meltCeiling) : "Refresh required"}</strong><small>${escapeHtml(formatDateTime(item.metalEstimate.quoteObservedAt))} spot quote</small></div>
            <div><span>Recoverable melt basis</span><strong>${a.pawnMeltBasis === null ? "Unavailable" : money(a.pawnMeltBasis)}</strong><small>${Math.round(a.recoverableWeightFactor * 100)}% of gross melt after non-metal / recovery allowance</small></div>
            <div><span>Likely pawn cash</span><strong>${a.pawnCashEstimate === null ? "Unavailable" : money(a.pawnCashEstimate)}</strong><small>${a.pawnPayoutPercent.toFixed(0)}% working payout estimate; adjustable</small></div>
            <div><span>Modeled pawn offer range</span><strong>${a.pawnCashLow === null ? "Unavailable" : `${money(a.pawnCashLow)}–${money(a.pawnCashHigh)}`}</strong><small>low, likely, and high cases are estimates—not offers</small></div>
            <div><span>Safe pawn bid ceiling</span><strong>${money(a.pawnMaxBid)}</strong><small>uses the low pawn case plus testing and profit reserves</small></div>
            <div><span>Likely profit if won now</span><strong>${a.pawnProfitAtCurrentBid === null ? "Unavailable" : money(a.pawnProfitAtCurrentBid)}</strong><small>likely cash less landed acquisition and testing reserve</small></div>
          </div>
          <div class="risk-summary-card"><span>TEST BEFORE BIDDING</span><p>${escapeHtml(item.metalEstimate.nonMetalWarning || "Purity and weight require independent verification.")}</p><small>The likely case uses a ${a.pawnPayoutPercent.toFixed(0)}% working estimate; observed industry guidance varies widely. A pawn shop may test, discount, or reject the item. This is not an appraisal or guaranteed offer.</small></div>
        </section>` : ""}
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Bid development</h4><span>timestamped observations${a.hasForecast ? " + evidence-based close" : ""}</span></div>
          <div class="curve-chart" aria-label="Bid snapshot curve">
            ${curve.map((point) => `<span class="curve-bar ${point.observed ? "observed" : ""} ${point.current ? "current" : ""}" title="${escapeHtml(point.label)}: ${money(point.value)}"><i style="--height:${point.height}%"></i><span>${escapeHtml(point.label)}</span></span>`).join("")}
          </div>
          <div class="curve-caption"><span>First retained: ${money(curve[0].value)}</span><strong>${a.hasForecast ? `Expected: ${money(a.expectedClose)}` : "Expected close withheld"}</strong></div>
        </section>
        <section class="detail-section comparable-sales">
          <div class="detail-section-heading"><h4>Complete retained bid history</h4><span>higher bids only · up to 24 latest changes</span></div>
          ${renderObservationLedger(item)}
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Evidence check</h4><span>${percent(a.confidence)} confidence</span></div>
          <div class="evidence-grid">${evidence.slice(0, 8).map((entry) => `<div class="evidence-item"><span>${escapeHtml(entry.label)}</span><strong title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</strong></div>`).join("")}</div>
          <div class="analysis-factors-grid">
            <div><span>${a.exitType === "pawn" ? "Pawn liquidity" : "Retail demand gate"}</span><strong>${a.exitType === "pawn" ? `${a.resalePopularityScore}/100` : a.hasRetailDemandEvidence ? `${a.retailDemandPass ? "PASS" : "FAIL"} · ${a.retailDemandScore}/100` : "Unavailable"}</strong></div>
            <div><span>Modeled sale likelihood</span><strong>${a.exitType === "pawn" ? percent(a.saleLikelihood) : a.retailDemandPass ? percent(a.saleLikelihood) : "Not approved"}</strong></div>
            <div><span>Rarity signal</span><strong>${Math.round(Number(item.rarity) || 0)}/100</strong></div>
            <div><span>Identity confidence</span><strong>${percent(parseConfidence(item.identityConfidence, 0))}</strong></div>
            <div><span>Condition confidence</span><strong>${percent(parseConfidence(item.conditionConfidence, 0))}</strong></div>
          </div>
          <div class="risk-summary-card"><span>LISTING-SPECIFIC RISK</span><p>${escapeHtml(item.riskSummary || "No source-specific risk summary was supplied; identity and condition still require independent verification.")}</p><small>Value basis: ${escapeHtml(a.exitType === "pawn" ? a.pawnBasisLabel : a.resaleEvidenceType)}. Inbound shipping: ${a.shippingKnown ? "recorded" : `${money(a.shipping)} estimated`}.</small></div>
        </section>
        <section class="detail-section due-diligence-panel">
          <div class="detail-section-heading"><h4>Pre-bid due-diligence checklist</h4><span>complete every applicable step</span></div>
          <ol>${dueDiligence.map((step, index) => `<li><span>${index + 1}</span><p>${escapeHtml(step)}</p></li>`).join("")}</ol>
        </section>
        <section class="detail-section comparable-sales">
          <div class="detail-section-heading"><h4>Auction-close comparables</h4><span>${acquisitionComparables.length} exact-model outcomes attached</span></div>
          ${renderComparableTable(acquisitionComparables, "exact-model auction")}
        </section>
        <section class="detail-section comparable-sales">
          <div class="detail-section-heading"><h4>Resale sold comparables</h4><span>${resaleComparables.length} completed sales attached</span></div>
          ${renderComparableTable(resaleComparables, "resale sold")}
        </section>
        ${renderPublicWebResearch(item)}
        ${a.forecast.categoryReferences.length ? `<section class="detail-section comparable-sales category-reference"><div class="detail-section-heading"><h4>Broader category reference</h4><span>not used in this forecast</span></div>${renderComparableTable(a.forecast.categoryReferences, "category reference")}</section>` : ""}
        <section class="detail-section detail-source-ledger">
          <div class="detail-section-heading"><h4>Source and timing</h4><span>audit trail</span></div>
          <div class="source-metadata-grid">
            <div><span>Marketplace</span><strong>${escapeHtml(marketplace.name)}</strong><small>${escapeHtml(item.source || marketplace.domain || "Feed-provided source")}</small></div>
            <div><span>Listing ID</span><strong>${escapeHtml(item.externalId || item.id)}</strong></div>
            <div><span>Bid last changed</span><strong>${escapeHtml(formatDateTime(freshness.observedAt))}</strong><small>retained only when the bid increases</small></div>
            <div><span>Last checked</span><strong>${escapeHtml(formatDateTime(freshness.checkedAt))}</strong><small>${escapeHtml(freshness.short)} · ${escapeHtml(freshness.label)}</small></div>
            <div><span>Scheduled end</span><strong>${escapeHtml(formatDateTime(item.endsAt))}</strong><small>${escapeHtml(timeLabel(item))}</small></div>
            <div><span>Snapshot policy</span><strong>${escapeHtml(snapshotPlan.label)}</strong><small>${snapshotPlan.nextDueAt ? `${snapshotPlan.due ? "Due now" : `Next ${escapeHtml(formatDateTime(snapshotPlan.nextDueAt))}`}` : "Outcome capture complete"}</small></div>
            <div><span>Bid count</span><strong>${Number(item.bidCount) || 0}</strong></div>
            <div><span>Inbound shipping basis</span><strong>${money(a.shipping)}</strong><small>${a.shippingKnown ? "recorded input" : "conservative user-configured estimate; verify before bidding"}</small></div>
            <div><span>Normalized model key</span><strong title="${escapeHtml(item.modelKey || "Not supplied")}">${escapeHtml(item.modelKey || "Not supplied")}</strong><small>exact-match grouping key</small></div>
            <div><span>Forecast state</span><strong>${a.hasForecast ? "Verified evidence threshold met" : "Insufficient exact-model history"}</strong><small>${escapeHtml((a.forecast.reasonCodes || []).join(", ") || a.forecast.method)}</small></div>
          </div>
        </section>
        <div class="detail-actions">
          ${sourceUrl ? `<a class="button button-dark direct-listing-button" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener">Open on ${escapeHtml(marketplace.name)} <span aria-hidden="true">↗</span></a>` : ""}
          <button class="button button-primary" type="button" data-watch-id="${escapeHtml(item.id)}">${item.watched ? "Remove watch" : "Watch item"}</button>
          <button class="button button-quiet" type="button" data-update-id="${escapeHtml(item.id)}">Record update</button>
        </div>
        <p class="risk-note">Pawn is limited to precious-metal liquidation evidence. Retail requires both price and demand proof. Dealer guides, active offers, reviews, and auction bids remain separately labeled and cannot create a YES by themselves.</p>
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
      .map((item) => ({ item, assessment: assess(item) }))
      .filter(({ item, assessment }) => {
        const haystack = [item.title, item.category, item.resaleVertical, item.authenticationEvidence, item.externalId, item.identifiedAs, item.marketplaceName, item.source].join(" ").toLowerCase();
        const closingWithinFiveMinutes = assessment.hours >= 0 && assessment.hours <= 5 / 60;
        const matchesMode = queueMode === "all"
          ? true
          : queueMode === "closing"
          ? item.status === "active" && closingWithinFiveMinutes
          : queueMode === "pawn" ? assessment.hasPawnEstimate
            : queueMode === "thin" ? !assessment.decisionApproved && (assessment.pawnLikelyProfitable || assessment.retailLikelyProfitable)
              : queueMode === "research" ? assessment.rankTier === 5
                : assessment.rankTier < 5;
        return (!query || haystack.includes(query)) &&
          matchesMode &&
          (signal === "all" || assessment.signal === signal) &&
          (category === "all" || categoryRootFor(item.category) === category) &&
          (vertical === "all" || (item.resaleVertical || "Other") === vertical) &&
          (authentication === "all" || (item.authenticationStatus || "not-supplied") === authentication) &&
          (source === "all" || item.sourceKey === source);
      })
      .sort((left, right) => {
        const { item: a, assessment: assessmentA } = left;
        const { item: b, assessment: assessmentB } = right;
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        if (assessmentA.rankTier !== assessmentB.rankTier) return assessmentA.rankTier - assessmentB.rankTier;
        const scoreDifference = assessmentB.rankingScore - assessmentA.rankingScore;
        if (scoreDifference) return scoreDifference;
        const profitDifference = Number(assessmentB.decisionProfitAtCurrentBid ?? Number.NEGATIVE_INFINITY)
          - Number(assessmentA.decisionProfitAtCurrentBid ?? Number.NEGATIVE_INFINITY);
        if (Number.isFinite(profitDifference) && profitDifference) return profitDifference;
        const popularityDifference = assessmentB.resalePopularityScore - assessmentA.resalePopularityScore;
        if (popularityDifference) return popularityDifference;
        const coverageDifference = assessmentB.researchCoverageScore - assessmentA.researchCoverageScore;
        if (coverageDifference) return coverageDifference;
        const aEnds = Date.parse(a.endsAt || "");
        const bEnds = Date.parse(b.endsAt || "");
        if (Number.isFinite(aEnds) && Number.isFinite(bEnds)) return aEnds - bEnds;
        if (Number.isFinite(aEnds)) return -1;
        if (Number.isFinite(bEnds)) return 1;
        return String(a.title || "").localeCompare(String(b.title || ""));
      })
      .map(({ item }) => item);
  }

  function categoryRootFor(category) {
    return String(category || "Unclassified").split(">")[0].trim() || "Unclassified";
  }

  function populateCategories() {
    const select = $("#category-filter");
    if (!select) return;
    const current = select.value;
    const counts = new Map();
    for (const item of allItems()) {
      const category = categoryRootFor(item.category);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const categories = [...counts.keys()].sort((left, right) => left.localeCompare(right));
    select.innerHTML = '<option value="all">All categories</option>' + categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)} (${counts.get(category).toLocaleString("en-US")})</option>`)
      .join("");
    select.value = categories.includes(current) ? current : "all";
  }

  function populateSources() {
    const select = $("#source-filter");
    if (!select) return;
    const current = select.value;
    const items = allItems();
    const itemCounts = new Map();
    for (const item of items) itemCounts.set(item.sourceKey, (itemCounts.get(item.sourceKey) || 0) + 1);
    const known = AUCTION_MARKETS.map((market) => ({
      ...market,
      count: itemCounts.get(market.key) || 0,
      sourceStatus: PUBLISHED_RESEARCH.sourceHealth?.[market.key]?.status || null,
    }));
    const other = [...new Set(items.map((item) => item.sourceKey).filter((key) => key && !AUCTION_MARKETS.some((market) => market.key === key)))]
      .map((key) => {
        const item = items.find((entry) => entry.sourceKey === key);
        return { key, name: item?.marketplaceName || key, count: itemCounts.get(key) || 0 };
      });
    const sources = [...known, ...other];
    select.innerHTML = '<option value="all">All connected marketplaces</option>' + sources
      .map((market) => `<option value="${escapeHtml(market.key)}"${market.count ? "" : " disabled"}>${escapeHtml(market.name)} — ${market.count ? `${market.count.toLocaleString("en-US")} records` : market.sourceStatus === "authorization-required" ? "authorization required" : market.sourceStatus ? "collector checked; no current records" : "feed not connected"}</option>`)
      .join("");
    select.value = sources.some((market) => market.key === current && market.count > 0) ? current : "all";
  }

  function renderCategoryCoverage() {
    const container = $("[data-category-coverage-grid]");
    if (!container) return;
    const counts = new Map();
    for (const item of allItems()) {
      const category = categoryRootFor(item.category);
      const current = counts.get(category) || { total: 0, active: 0 };
      current.total += 1;
      if (item.status === "active") current.active += 1;
      counts.set(category, current);
    }
    container.innerHTML = [...counts.entries()]
      .sort((left, right) => right[1].total - left[1].total || left[0].localeCompare(right[0]))
      .map(([category, count]) => `<button type="button" data-category-jump="${escapeHtml(category)}"><span>${escapeHtml(category)}</span><strong>${count.total.toLocaleString("en-US")}</strong><small>${count.active.toLocaleString("en-US")} active now</small></button>`)
      .join("");
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
      const latest = marketItems.map((item) => Date.parse(checkedAtFor(item) || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const plans = monitored.map(snapshotPlanFor).filter((plan) => plan.intervalMinutes);
      const fastest = plans.length ? Math.min(...plans.map((plan) => plan.intervalMinutes)) : null;
      const connected = marketItems.length > 0;
      const health = PUBLISHED_RESEARCH.sourceHealth?.[market.key] || null;
      const healthCheckedAt = Date.parse(health?.checkedAt || "");
      const checkedAt = latest || (Number.isFinite(healthCheckedAt) ? healthCheckedAt : null);
      const snapshotDeliveryUnavailable = PUBLISHED_RESEARCH.sourceMode === "delivery-error";
      const authorizationRequired = health?.status === "authorization-required" || (!health && !connected && !snapshotDeliveryUnavailable);
      const sourceStatusLabel = connected
        ? health?.coverageComplete === true || health?.status === "connected-complete"
          ? "REAL RECORDS · COMPLETE LEDGER"
          : "REAL RECORDS · PARTIAL COVERAGE"
          : snapshotDeliveryUnavailable ? "SNAPSHOT DELIVERY UNAVAILABLE"
            : authorizationRequired ? "AUTHORIZATION REQUIRED"
          : health?.status === "temporarily-unavailable" ? "PUBLIC COLLECTOR TEMPORARILY UNAVAILABLE"
            : "PUBLIC COLLECTOR READY";
      const footerStatus = connected
        ? `${health?.message ? escapeHtml(health.message) : "Stored records from the latest public check."} Checked ${escapeHtml(formatDateTime(new Date(checkedAt).toISOString()))}`
        : snapshotDeliveryUnavailable ? escapeHtml(publishedSnapshotLoadError || "The published snapshot could not be loaded.")
        : health?.message ? escapeHtml(health.message)
          : checkedAt ? `Checked ${escapeHtml(formatDateTime(new Date(checkedAt).toISOString()))} · no current records`
            : "0 ingested · feed not configured";
      return `<article class="marketplace-card ${connected ? "is-connected" : "is-awaiting"}">
        <div class="marketplace-card-head"><span class="marketplace-monogram" aria-hidden="true">${escapeHtml(market.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase())}</span><div><strong>${escapeHtml(market.name)}</strong><small>${escapeHtml(sourceStatusLabel)}</small></div></div>
        <p>${escapeHtml(market.focus)}</p>
        <dl><div><dt>Stored active</dt><dd>${active.length}</dd></div><div><dt>Bid changes</dt><dd>${observations}</dd></div><div><dt>Fastest cadence</dt><dd>${fastest ? (fastest <= 1 / 12 ? "5s" : fastest === 0.5 ? "30s" : fastest < 60 ? `${fastest}m` : fastest === 60 ? "1h" : `${fastest / 60}h`) : "—"}</dd></div></dl>
        <div class="marketplace-card-footer"><span>${footerStatus}</span><div>${!connected && authorizationRequired && market.setupUrl ? `<a href="${escapeHtml(market.setupUrl)}" target="_blank" rel="noreferrer noopener">Set up access ↗</a>` : ""}${!connected && authorizationRequired && market.key !== "ebay" ? `<button type="button" data-connect-source="${escapeHtml(market.key)}">Add authorized feed</button>` : ""}<a href="${escapeHtml(market.homeUrl)}" target="_blank" rel="noreferrer noopener">Visit site ↗</a></div></div>
      </article>`;
    }).join("");
  }

  function renderStats() {
    const active = allItems().filter((item) => item.status === "active");
    const assessments = active.map(assess);
    const valued = assessments.filter((item) => item.decisionProfitAtCurrentBid !== null);
    const upside = valued.length ? Math.max(0, ...valued.map((item) => item.decisionProfitAtCurrentBid)) : 0;
    const urgent = active.filter((item) => hoursRemaining(item) >= 0 && hoursRemaining(item) <= 5 / 60).length;
    const confidence = valued.length ? valued.reduce((total, item) => total + item.confidence, 0) / valued.length : 0;
    const observations = allItems().reduce((total, item) => total + (Array.isArray(item.observations) ? item.observations.length : 0), 0);
    const connectedMarkets = new Set(allItems().map((item) => item.sourceKey).filter(Boolean)).size;
    const approved = assessments.filter((item) => item.decisionApproved).length;
    const pawnUnderwritten = assessments.filter((item) => item.hasPawnEstimate).length;
    const retailDemandQualified = assessments.filter((item) => item.retailDemandPass).length;
    const thinPositive = assessments.filter((item) => !item.decisionApproved && (item.pawnLikelyProfitable || item.retailLikelyProfitable)).length;
    $$('[data-stat-approved]').forEach((el) => { el.textContent = approved.toLocaleString("en-US"); });
    $$('[data-stat-pawn-qualified]').forEach((el) => { el.textContent = pawnUnderwritten.toLocaleString("en-US"); });
    $$('[data-stat-retail-qualified]').forEach((el) => { el.textContent = retailDemandQualified.toLocaleString("en-US"); });
    $$('[data-stat-thin-positive]').forEach((el) => { el.textContent = thinPositive.toLocaleString("en-US"); });
    $("[data-stat-upside]").textContent = money(upside);
    $("[data-stat-urgent]").textContent = String(urgent);
    if ($("[data-stat-confidence]")) $("[data-stat-confidence]").textContent = percent(confidence);
    if ($("[data-stat-observations]")) $("[data-stat-observations]").textContent = observations.toLocaleString("en-US");
    $$('[data-opportunity-count]').forEach((el) => { el.textContent = String(active.length); });
    $$('[data-watch-count]').forEach((el) => { el.textContent = String(workspace.watchIds.length); });
    $$('[data-research-count]').forEach((el) => { el.textContent = String(PUBLISHED_RESEARCH.items.length); });
    $$('[data-market-count]').forEach((el) => { el.textContent = String(connectedMarkets); });
    $$('[data-research-observed]').forEach((el) => {
      const observed = PUBLISHED_RESEARCH.lastCheckedAt ? new Date(PUBLISHED_RESEARCH.lastCheckedAt) : null;
      const formatted = observed && !Number.isNaN(observed.getTime())
        ? observed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "No published pass";
      const badge = el.closest(".snapshot-freshness");
      if (badge) {
        const freshness = freshnessFor({ lastCheckedAt: PUBLISHED_RESEARCH.lastCheckedAt, observedAt: PUBLISHED_RESEARCH.observedAt });
        badge.classList.remove("is-fresh", "is-aging", "is-stale", "is-invalid", "is-unknown");
        badge.classList.add(freshness.className);
        el.textContent = PUBLISHED_RESEARCH.lastCheckedAt ? `${formatted} · ${freshness.short}` : formatted;
      } else {
        el.textContent = formatted;
      }
    });
    $$('[data-cloud-last-checked]').forEach((el) => {
      el.textContent = PUBLISHED_RESEARCH.lastCheckedAt ? formatDateTime(PUBLISHED_RESEARCH.lastCheckedAt) : "No successful cloud check yet";
    });
    $$('[data-cloud-normal-cadence]').forEach((el) => {
      el.textContent = cloudControl.normalMinutes === 60 ? "Every hour" : cloudControl.normalMinutes < 60 ? `Every ${cloudControl.normalMinutes} minutes` : `Every ${cloudControl.normalMinutes / 60} hours`;
    });
    $$('[data-cloud-closing-cadence]').forEach((el) => { el.textContent = `Every ${cloudControl.nearCloseMinutes} minutes`; });
    $$('[data-cloud-dispatch-state]').forEach((el) => {
      el.textContent = cloudControl.lastPublishedRefreshAt
        ? `Published data refreshed ${formatDateTime(cloudControl.lastPublishedRefreshAt)}`
        : "Ready to check for newly published data";
    });
    $$('[data-source-status]').forEach((el) => {
      const mode = String(PUBLISHED_RESEARCH.sourceMode || "").toLowerCase();
      let status = "Research snapshots loaded";
      if (PUBLISHED_RESEARCH.sourceMode === "delivery-error") status = "Snapshot delivery unavailable";
      else if (!PUBLISHED_RESEARCH.items.length) status = "Awaiting research data";
      else if (connectedMarkets > 1) status = `${connectedMarkets} auction marketplaces connected`;
      else if (mode.includes("shopgoodwill")) status = `${PUBLISHED_RESEARCH.items.length.toLocaleString("en-US")} ShopGoodwill listings loaded`;
      else if (mode.includes("apify")) status = "Apify dataset loaded";
      else if (mode.includes("authorized")) status = "Authorized feed loaded";
      else if (mode.includes("manual")) status = "Manual research pass loaded";
      el.textContent = status;
    });
    renderCategoryCoverage();
    renderMarketplaceCoverage();
  }

  function renderOpportunities() {
    populateCategories();
    populateSources();
    const queueTitle = queueMode === "all"
      ? "All listings, strongest evidence first"
      : queueMode === "closing"
      ? "Closing within five minutes"
      : queueMode === "pawn" ? "Pawn-first precious metals"
        : queueMode === "thin" ? "Likely positive, but below the safety target"
          : queueMode === "research" ? "Research gaps — no bid until evidence improves" : "Highest profit likelihood first";
    if ($("#queue-heading")) $("#queue-heading").textContent = queueTitle;
    $$('[data-quick-mode]').forEach((button) => {
      const active = button.dataset.quickMode === queueMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const items = filteredItems();
    const visibleItems = items.slice(0, visibleQueueLimit);
    const list = $("[data-opportunity-list]");
    const empty = $("[data-queue-empty]");
    if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id || "";
    list.innerHTML = visibleItems.map((item, index) => renderOpportunityRow(item, index + 1)).join("");
    empty.hidden = items.length > 0;
    const emptyHeading = $("h4", empty);
    const emptyCopy = $("p", empty);
    if (emptyHeading) emptyHeading.textContent = "No listings match";
    if (emptyCopy) emptyCopy.textContent = "Broaden the filters or connect a source to ingest current auction records.";
    if (!items.length && queueMode === "profit") {
      if (emptyHeading) emptyHeading.textContent = "No evidence-backed profit opportunities match";
      if (emptyCopy) emptyCopy.textContent = "BidAI Pro will not place unresearched listings in Top profit. Change the filters or inspect an item's internet-research ledger after evidence is collected.";
    }
    list.hidden = items.length === 0;
    const pagination = $("[data-queue-pagination]");
    const count = $("[data-queue-visible-count]");
    const loadMore = $("[data-load-more]");
    if (pagination) pagination.hidden = items.length === 0;
    if (count) count.textContent = `Showing ${visibleItems.length.toLocaleString()} of ${items.length.toLocaleString()} matching real listings`;
    if (loadMore) loadMore.hidden = visibleItems.length >= items.length;
    const selectedItem = items.find((item) => item.id === selectedId) || items[0];
    const selectedRank = selectedItem ? items.findIndex((item) => item.id === selectedItem.id) + 1 : null;
    renderDetail(selectedItem, selectedRank, items.length);
    if ($("#item-analysis-modal")?.open) syncAnalysisModal();
    renderStats();
  }

  function resetQueueAndRender() {
    visibleQueueLimit = QUEUE_PAGE_SIZE;
    renderOpportunities();
  }

  function setQueueMode(mode) {
    if (!["all", "profit", "pawn", "thin", "closing", "research"].includes(mode)) return;
    queueMode = mode;
    selectedId = "";
    visibleQueueLimit = QUEUE_PAGE_SIZE;
    if (activeView !== "opportunities") setView("opportunities");
    else renderOpportunities();
    $("#queue-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        <div class="watch-card-metrics"><div><span>Observed bid</span><strong>${money(item.currentBid)}</strong></div><div><span>Best exit</span><strong>${escapeHtml(recommendationLabel(a.recommendationState))}</strong></div><div><span>Target-safe ceiling</span><strong>${money(a.maxBid)}</strong></div><div><span>Likely profit now</span><strong>${a.decisionProfitAtCurrentBid === null ? "Unavailable" : money(a.decisionProfitAtCurrentBid)}</strong></div></div>
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
    window.setTimeout(() => {
      openAnalysisModal();
    }, 80);
  }

  function syncAnalysisModal() {
    const source = $("[data-opportunity-detail]");
    const target = $("[data-item-modal-content]");
    const item = allItems().find((candidate) => candidate.id === selectedId);
    if (!source || !target || !item) return false;
    target.innerHTML = source.innerHTML;
    const heading = $("#analysis-modal-heading");
    if (heading) heading.textContent = item.title;
    return true;
  }

  function openAnalysisModal() {
    const dialog = $("#item-analysis-modal");
    if (!dialog || !syncAnalysisModal()) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("[data-close-dialog]")?.focus();
  }

  function fillCloudForm() {
    const form = $("#cloud-control-form");
    if (!form) return;
    form.elements.repository.value = cloudControl.repository;
    form.elements.normalMinutes.value = String(cloudControl.normalMinutes);
    form.elements.nearCloseMinutes.value = String(cloudControl.nearCloseMinutes);
    form.elements.token.value = cloudToken();
  }

  function openCloudControl() {
    fillCloudForm();
    const dialog = $("#refresh-control-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function populateSourceConnectionForm(marketKey = "") {
    const form = $("#source-connect-form");
    if (!form) return;
    form.elements.marketKey.innerHTML = AUCTION_MARKETS
      .map((market) => `<option value="${escapeHtml(market.key)}">${escapeHtml(market.name)}</option>`)
      .join("");
    const selectedMarket = AUCTION_MARKETS.some((market) => market.key === marketKey) ? marketKey : AUCTION_MARKETS[0].key;
    form.elements.marketKey.value = selectedMarket;
    const existing = cloudControl.sourceConfigs.find((config) => config.key === selectedMarket);
    const connectionType = existing?.taskId ? "taskId" : existing?.datasetId ? "datasetId" : existing?.feedUrl ? "feedUrl" : "taskId";
    form.elements.connectionType.value = connectionType;
    form.elements.connectionValue.value = existing?.[connectionType] || "";
    form.elements.repository.value = cloudControl.repository;
    form.elements.token.value = cloudToken();
  }

  function openSourceConnection(marketKey) {
    populateSourceConnectionForm(marketKey);
    const dialog = $("#source-connect-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function cloudCredentialsFrom(form) {
    const repository = String(form.elements.repository.value || "").trim();
    const token = String(form.elements.token.value || "").trim();
    if (!validRepository(repository)) throw new Error("Enter the repository as owner/repository.");
    if (!token) throw new Error("A GitHub token is required. It stays in this browser tab only.");
    rememberCloudToken(token);
    cloudControl.repository = repository;
    saveCloudControl();
    return { repository, token };
  }

  async function saveCloudSchedule(event, refreshAfter = false) {
    event?.preventDefault();
    const form = $("#cloud-control-form");
    const submitters = $$("button", form);
    submitters.forEach((button) => { button.disabled = true; });
    try {
      const credentials = cloudCredentialsFrom(form);
      const normalMinutes = Number(form.elements.normalMinutes.value);
      const nearCloseMinutes = Number(form.elements.nearCloseMinutes.value);
      if (![15, 30, 60, 120, 240, 360].includes(normalMinutes)) throw new Error("Choose a valid normal refresh interval.");
      if (![5, 10, 15].includes(nearCloseMinutes)) throw new Error("Choose a valid final-30-minute interval.");
      await upsertActionsVariable("BIDAI_NORMAL_REFRESH_MINUTES", normalMinutes, credentials);
      await upsertActionsVariable("BIDAI_NEAR_CLOSE_REFRESH_MINUTES", nearCloseMinutes, credentials);
      cloudControl.normalMinutes = normalMinutes;
      cloudControl.nearCloseMinutes = nearCloseMinutes;
      saveCloudControl();
      renderStats();
      if (refreshAfter) await dispatchCloudRefresh(credentials);
      else toast("Cloud refresh schedule saved. Locked closing cadences remain unchanged.");
      $("#refresh-control-dialog")?.close();
    } catch (error) {
      toast(error.message || "Cloud schedule could not be saved.", "error");
    } finally {
      submitters.forEach((button) => { button.disabled = false; });
    }
  }

  async function refreshNow(button = null) {
    const refreshButtons = $$('[data-refresh-now]');
    refreshButtons.forEach((candidate) => { candidate.disabled = true; });
    if (button) button.setAttribute("aria-busy", "true");
    try {
      const refreshed = await fetchPublishedSnapshot();
      PUBLISHED_RESEARCH = refreshed;
      publishedSnapshotLoadError = "";
      cloudControl.lastPublishedRefreshAt = new Date().toISOString();
      saveCloudControl();
      invalidateHistoricalIndex();
      visibleQueueLimit = QUEUE_PAGE_SIZE;
      renderStats();
      renderCurrentView();
      toast(`${refreshed.items.length.toLocaleString("en-US")} published listings refreshed. No GitHub token needed.`);
    } catch (error) {
      toast(error.message || "Published data could not be refreshed.", "error");
    } finally {
      refreshButtons.forEach((candidate) => { candidate.disabled = false; });
      if (button) button.removeAttribute("aria-busy");
    }
  }

  async function saveSourceConnection(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const buttons = $$("button", form);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const credentials = cloudCredentialsFrom(form);
      const key = normalizeMarketKey(form.elements.marketKey.value);
      const market = AUCTION_MARKETS.find((candidate) => candidate.key === key);
      const connectionType = form.elements.connectionType.value;
      const connectionValue = String(form.elements.connectionValue.value || "").trim();
      if (!market || !["taskId", "datasetId", "feedUrl"].includes(connectionType)) throw new Error("Choose a supported marketplace connection.");
      if (connectionType === "feedUrl" && !/^https:\/\//i.test(connectionValue)) throw new Error("The feed must use an HTTPS URL.");
      if (connectionType !== "feedUrl" && !/^[A-Za-z0-9._~-]{1,200}$/.test(connectionValue)) throw new Error("Enter a valid Apify Task or Dataset ID.");
      const remoteValue = await readActionsVariable("BIDAI_SOURCE_CONFIG_JSON", credentials);
      let sourceConfigs = cloudControl.sourceConfigs;
      if (remoteValue) {
        try {
          const parsed = JSON.parse(remoteValue);
          if (!Array.isArray(parsed)) throw new Error("not an array");
          sourceConfigs = parsed;
        } catch (_error) {
          throw new Error("The repository's BIDAI_SOURCE_CONFIG_JSON variable is not a valid JSON array.");
        }
      }
      const nextConfig = { key: market.key, name: market.name, [connectionType]: connectionValue };
      sourceConfigs = [...sourceConfigs.filter((config) => normalizeMarketKey(config?.key) !== market.key), nextConfig].slice(0, 20);
      await upsertActionsVariable("BIDAI_SOURCE_CONFIG_JSON", JSON.stringify(sourceConfigs), credentials);
      cloudControl.sourceConfigs = sourceConfigs;
      saveCloudControl();
      await dispatchCloudRefresh(credentials);
      $("#source-connect-dialog")?.close();
      toast(`${market.name} connection saved. It will show connected after real records are ingested.`);
    } catch (error) {
      toast(error.message || "The marketplace connection could not be saved.", "error");
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
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
      lastCheckedAt: observedAt,
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
        lastCheckedAt: newestIsoTimestamp(snapshot.observedAt, existing.lastCheckedAt, existing.observedAt),
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

  if (IS_TEST_MODE) {
    window.BIDAI_TEST_API = Object.freeze({
      assess,
      categoryRootFor,
      normalizePublishedResearch,
      parsePublishedSnapshotScript,
      recommendationLabel,
      snapshotPlanFor,
      setSettings(settings = {}) {
        workspace.settings = { ...DEFAULT_SETTINGS, ...settings };
      },
      setCloudControl(settings = {}) {
        cloudControl = { ...DEFAULT_CLOUD_CONTROL, ...settings };
      },
    });
    return;
  }

  document.addEventListener("click", async (event) => {
    const closeDialogButton = event.target.closest("[data-close-dialog]");
    if (closeDialogButton) {
      $("#" + closeDialogButton.dataset.closeDialog)?.close();
      return;
    }
    if (event.target.matches?.("dialog")) {
      event.target.close();
      return;
    }
    if (event.target.closest("[data-refresh-now]")) {
      await refreshNow(event.target.closest("[data-refresh-now]"));
      return;
    }
    if (event.target.closest("[data-open-refresh-control]")) {
      openCloudControl();
      return;
    }
    if (event.target.closest("[data-refresh-from-dialog]")) {
      await saveCloudSchedule(event, true);
      return;
    }
    const connectSourceButton = event.target.closest("[data-connect-source]");
    if (connectSourceButton) {
      openSourceConnection(connectSourceButton.dataset.connectSource);
      return;
    }
    const quickModeButton = event.target.closest("[data-quick-mode]");
    if (quickModeButton) {
      setQueueMode(quickModeButton.dataset.quickMode);
      return;
    }
    const categoryJumpButton = event.target.closest("[data-category-jump]");
    if (categoryJumpButton) {
      setView("opportunities");
      populateCategories();
      $("#category-filter").value = categoryJumpButton.dataset.categoryJump;
      visibleQueueLimit = QUEUE_PAGE_SIZE;
      renderOpportunities();
      return;
    }
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
      openItem(row.dataset.selectId);
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
      openItem(row.dataset.selectId);
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
  $("#cloud-control-form").addEventListener("submit", saveCloudSchedule);
  $("#source-connect-form").addEventListener("submit", saveSourceConnection);
  $("#source-connect-form").elements.marketKey.addEventListener("change", (event) => {
    populateSourceConnectionForm(event.target.value);
  });

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
