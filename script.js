(() => {
  "use strict";

  const STORAGE_KEY = "bidaipro.auction-workspace.v1";
  const MAX_IMPORT_ROWS = 5000;
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

  const now = Date.now();
  const hoursFromNow = (hours) => new Date(now + hours * 3600000).toISOString();
  const observedBefore = (hours) => new Date(now - hours * 3600000).toISOString();

  const DEMO_ITEMS = [
    {
      id: "demo-gold-ring",
      externalId: "SGW-DEMO-8726",
      source: "Illustrative ShopGoodwill snapshot",
      title: "Unmarked yellow-gold ring with old-cut diamond",
      category: "Jewelry & precious metal",
      initials: "Au",
      accent: "gold",
      status: "active",
      currentBid: 124,
      shipping: 9.95,
      bidCount: 11,
      endsAt: hoursFromNow(6.4),
      expectedClose: 215,
      resaleLow: 410,
      resaleMedian: 480,
      resaleHigh: 545,
      identityConfidence: 0.81,
      conditionConfidence: 0.74,
      rarity: 48,
      demand: 92,
      compCount: 8,
      compRecencyDays: 12,
      identifiedAs: "Likely 14k ring, approximately 8.6g gross, with a possible 0.35ct old-cut stone",
      repairReserve: 20,
      outboundShipping: 10,
      returnReserve: 16,
      illustrative: true,
      observations: [
        { observedAt: observedBefore(40), currentBid: 46, bidCount: 3, expectedClose: 172, status: "active" },
        { observedAt: observedBefore(18), currentBid: 81, bidCount: 7, expectedClose: 194, status: "active" },
        { observedAt: observedBefore(1), currentBid: 124, bidCount: 11, expectedClose: 215, status: "active" },
      ],
      evidence: [
        { label: "Identity", value: "Hallmark shape visible" },
        { label: "Demand", value: "Liquid gold downside" },
        { label: "Risk", value: "Stone untested" },
      ],
    },
    {
      id: "demo-leica",
      externalId: "SGW-DEMO-4412",
      source: "Illustrative ShopGoodwill snapshot",
      title: "Leica M6 classic 0.72 rangefinder body",
      category: "Cameras & optics",
      initials: "L",
      accent: "red",
      status: "active",
      currentBid: 850,
      shipping: 18.75,
      bidCount: 24,
      endsAt: hoursFromNow(19.2),
      expectedClose: 1120,
      resaleLow: 1480,
      resaleMedian: 1760,
      resaleHigh: 1995,
      identityConfidence: 0.94,
      conditionConfidence: 0.62,
      rarity: 56,
      demand: 96,
      compCount: 12,
      compRecencyDays: 9,
      identifiedAs: "Leica M6 Classic 0.72, black chrome, likely late-1980s production",
      repairReserve: 185,
      outboundShipping: 24,
      returnReserve: 65,
      illustrative: true,
      observations: [
        { observedAt: observedBefore(66), currentBid: 390, bidCount: 10, expectedClose: 930, status: "active" },
        { observedAt: observedBefore(25), currentBid: 645, bidCount: 17, expectedClose: 1030, status: "active" },
        { observedAt: observedBefore(2), currentBid: 850, bidCount: 24, expectedClose: 1120, status: "active" },
      ],
      evidence: [
        { label: "Identity", value: "Body details match M6" },
        { label: "Demand", value: "12 recent comps" },
        { label: "Risk", value: "Meter not verified" },
      ],
    },
    {
      id: "demo-nes",
      externalId: "SGW-DEMO-9103",
      source: "Illustrative ShopGoodwill snapshot",
      title: "Nintendo NES console with ROB and accessories",
      category: "Vintage electronics",
      initials: "8",
      accent: "green",
      status: "active",
      currentBid: 62,
      shipping: 22.5,
      bidCount: 8,
      endsAt: hoursFromNow(31),
      expectedClose: 96,
      resaleLow: 175,
      resaleMedian: 225,
      resaleHigh: 285,
      identityConfidence: 0.91,
      conditionConfidence: 0.46,
      rarity: 42,
      demand: 84,
      compCount: 9,
      compRecencyDays: 23,
      identifiedAs: "Front-loading NES bundle with ROB, Zapper, two controllers, and loose cables",
      repairReserve: 38,
      outboundShipping: 27,
      returnReserve: 20,
      illustrative: true,
      observations: [
        { observedAt: observedBefore(48), currentBid: 28, bidCount: 3, expectedClose: 73, status: "active" },
        { observedAt: observedBefore(4), currentBid: 62, bidCount: 8, expectedClose: 96, status: "active" },
      ],
      evidence: [
        { label: "Contents", value: "ROB raises bundle value" },
        { label: "Demand", value: "Broad collector market" },
        { label: "Risk", value: "Console untested" },
      ],
    },
    {
      id: "demo-sterling",
      externalId: "SGW-DEMO-2871",
      source: "Illustrative ShopGoodwill snapshot",
      title: "Mixed sterling flatware lot, 1.34kg gross",
      category: "Jewelry & precious metal",
      initials: "Ag",
      accent: "silver",
      status: "active",
      currentBid: 185,
      shipping: 14.25,
      bidCount: 14,
      endsAt: hoursFromNow(10.7),
      expectedClose: 310,
      resaleLow: 465,
      resaleMedian: 540,
      resaleHigh: 630,
      identityConfidence: 0.88,
      conditionConfidence: 0.82,
      rarity: 28,
      demand: 79,
      compCount: 7,
      compRecencyDays: 6,
      identifiedAs: "Predominantly .925 sterling service pieces; knives may include weighted handles",
      repairReserve: 8,
      outboundShipping: 18,
      returnReserve: 12,
      illustrative: true,
      observations: [
        { observedAt: observedBefore(35), currentBid: 95, bidCount: 7, expectedClose: 258, status: "active" },
        { observedAt: observedBefore(3), currentBid: 185, bidCount: 14, expectedClose: 310, status: "active" },
      ],
      evidence: [
        { label: "Identity", value: ".925 marks pictured" },
        { label: "Floor", value: "Metal value supports exit" },
        { label: "Risk", value: "Gross weight includes fill" },
      ],
    },
    {
      id: "demo-omega",
      externalId: "SGW-DEMO-5588",
      source: "Illustrative ShopGoodwill snapshot",
      title: "Omega Seamaster automatic wristwatch",
      category: "Watches",
      initials: "O",
      accent: "blue",
      status: "active",
      currentBid: 390,
      shipping: 15.99,
      bidCount: 16,
      endsAt: hoursFromNow(48),
      expectedClose: 675,
      resaleLow: 980,
      resaleMedian: 1220,
      resaleHigh: 1480,
      identityConfidence: 0.82,
      conditionConfidence: 0.53,
      rarity: 61,
      demand: 89,
      compCount: 6,
      compRecencyDays: 18,
      identifiedAs: "Likely 1960s Omega Seamaster reference 166.010, possibly caliber 562",
      repairReserve: 250,
      outboundShipping: 14,
      returnReserve: 60,
      illustrative: true,
      observations: [
        { observedAt: observedBefore(55), currentBid: 215, bidCount: 9, expectedClose: 560, status: "active" },
        { observedAt: observedBefore(5), currentBid: 390, bidCount: 16, expectedClose: 675, status: "active" },
      ],
      evidence: [
        { label: "Reference", value: "Dial and case match" },
        { label: "Demand", value: "Durable vintage demand" },
        { label: "Risk", value: "Movement not pictured" },
      ],
    },
  ];

  const ILLUSTRATIVE_OUTCOMES = [
    { category: "Jewelry & precious metal", predicted: 198, actual: 226, illustrative: true },
    { category: "Jewelry & precious metal", predicted: 342, actual: 321, illustrative: true },
    { category: "Cameras & optics", predicted: 980, actual: 1065, illustrative: true },
    { category: "Vintage electronics", predicted: 118, actual: 104, illustrative: true },
    { category: "Watches", predicted: 710, actual: 782, illustrative: true },
  ];

  const aliases = {
    externalId: ["externalid", "itemid", "itemnumber", "itemno", "auctionid", "listingid", "id"],
    title: ["title", "itemtitle", "description", "itemname", "listingtitle"],
    category: ["category", "categoryname", "department"],
    currentBid: ["currentbid", "currentprice", "price", "bidamount", "winningbid"],
    shipping: ["shipping", "shippingcost", "shippingandhandling", "inboundshipping", "handling"],
    bidCount: ["bidcount", "bids", "numberofbids"],
    endsAt: ["endsat", "enddate", "endtime", "auctionend", "closeddate", "dateclosed"],
    expectedClose: ["expectedclose", "predictedfinal", "expectedfinalbid", "projectedclose"],
    resaleLow: ["resalelow", "valuelow", "comparablelow"],
    resaleMedian: ["resalemedian", "resalevalue", "estimatedvalue", "comparablemedian"],
    resaleHigh: ["resalehigh", "valuehigh", "comparablehigh"],
    finalPrice: ["finalprice", "finalbid", "endingprice", "soldprice", "actualfinal"],
    status: ["status", "auctionstatus"],
    source: ["source", "datasource"],
    url: ["url", "itemurl", "listingurl", "link"],
    observedAt: ["observedat", "snapshotat", "capturedat", "timestamp"],
    demand: ["demand", "demandscore", "popularity", "liquidityscore"],
    rarity: ["rarity", "rarityscore", "scarcityscore"],
    identityConfidence: ["identityconfidence", "identityscore", "matchconfidence"],
    conditionConfidence: ["conditionconfidence", "conditionscore"],
    compCount: ["compcount", "comparables", "soldcomps", "comparablecount"],
    compRecencyDays: ["comprecencydays", "compagedays", "comparablerecencydays"],
    identifiedAs: ["identifiedas", "normalizedidentity", "itemidentity", "model"],
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
  const parseConfidence = (value, fallback) => {
    const parsed = Number(String(value ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed > 1 ? parsed / 100 : parsed);
  };
  const parseScore = (value, fallback) => {
    const parsed = Number(String(value ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(clamp(parsed > 1 ? parsed / 100 : parsed) * 100);
  };
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  let selectedId = PUBLISHED_RESEARCH.items[0]?.id || "demo-gold-ring";

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
    return [...PUBLISHED_RESEARCH.items, ...DEMO_ITEMS, ...workspace.userItems].map((item) => ({
      ...item,
      watched: workspace.watchIds.includes(item.id),
    }));
  }

  function hoursRemaining(item) {
    const value = new Date(item.endsAt).getTime();
    return Number.isFinite(value) ? Math.max(0, (value - Date.now()) / 3600000) : 0;
  }

  function projectFinalBid(currentBid, hours, bidCount) {
    const timePressure = clamp(1 - hours / 168);
    const activity = clamp(Math.log2((Number(bidCount) || 0) + 1) / 6);
    const lift = 1 + 0.34 * (0.35 + 0.45 * timePressure + 0.2 * activity);
    return Math.max(currentBid, Math.round(currentBid * lift));
  }

  function probabilityAbove(low, middle, high, threshold) {
    if (!middle || !high) return 0;
    if (threshold <= low) return 0.96;
    if (threshold >= high) return 0.04;
    if (threshold <= middle) return clamp(0.5 + 0.46 * ((middle - threshold) / Math.max(1, middle - low)));
    return clamp(0.5 - 0.46 * ((threshold - middle) / Math.max(1, high - middle)));
  }

  function assess(item) {
    const s = workspace.settings;
    const hours = hoursRemaining(item);
    const expectedClose = Number(item.expectedClose) > 0
      ? Number(item.expectedClose)
      : projectFinalBid(Number(item.currentBid) || 0, hours, Number(item.bidCount) || 0);
    const marketplaceFee = Number.isFinite(Number(item.marketplaceFee)) ? Number(item.marketplaceFee) : s.marketplaceFee;
    const taxRate = Number.isFinite(Number(item.taxRate)) ? Number(item.taxRate) : s.taxRate;
    const buyerPremium = Number.isFinite(Number(item.buyerPremium)) ? Number(item.buyerPremium) : s.buyerPremium;
    const outboundShipping = Number.isFinite(Number(item.outboundShipping)) ? Number(item.outboundShipping) : s.outboundShipping;
    const repairReserve = Number.isFinite(Number(item.repairReserve)) ? Number(item.repairReserve) : s.repairReserve;
    const returnReserve = Number.isFinite(Number(item.returnReserve)) ? Number(item.returnReserve) : s.returnReserve;
    const shipping = Number(item.shipping) || 0;
    const resaleMedian = Number(item.resaleMedian) || 0;
    const resaleLow = Number(item.resaleLow) || (resaleMedian ? resaleMedian * 0.82 : 0);
    const resaleHigh = Number(item.resaleHigh) || (resaleMedian ? resaleMedian * 1.18 : 0);
    const landedAt = (bid) => ((Math.max(0, bid) * (1 + buyerPremium / 100) + shipping) * (1 + taxRate / 100));
    const acquisition = landedAt(expectedClose);
    const netResale = (sale) => sale * (1 - marketplaceFee / 100) - outboundShipping - repairReserve - returnReserve;
    const netLow = netResale(resaleLow);
    const netMedian = netResale(resaleMedian);
    const netHigh = netResale(resaleHigh);
    const profitLow = netLow - acquisition;
    const profitExpected = netMedian - acquisition;
    const profitHigh = netHigh - acquisition;
    const conservativeResale = resaleLow + Math.max(0, resaleMedian - resaleLow) * 0.2;
    const desiredProfit = Math.max(Number(s.minimumProfit) || 0, conservativeResale * (Number(s.targetMargin) || 0) / 100);
    const maximumLanded = Math.max(0, netResale(conservativeResale) - desiredProfit);
    const maxBid = Math.max(0, (maximumLanded / (1 + taxRate / 100) - shipping) / (1 + buyerPremium / 100));
    const breakEvenSale = (acquisition + outboundShipping + repairReserve + returnReserve) / Math.max(0.05, 1 - marketplaceFee / 100);
    const probabilityProfit = probabilityAbove(resaleLow, resaleMedian, resaleHigh, breakEvenSale);
    const compCoverage = clamp(Math.log2((Number(item.compCount) || 0) + 1) / 4);
    const recency = clamp(1 - (Number(item.compRecencyDays) || 365) / 365);
    const confidence = clamp(
      (Number(item.identityConfidence) || 0.35) * 0.28 +
      (Number(item.conditionConfidence) || 0.35) * 0.2 +
      compCoverage * 0.25 +
      recency * 0.12 +
      clamp((Number(item.demand) || 50) / 100) * 0.15,
    );
    const roi = profitExpected / Math.max(1, acquisition);
    const marginComponent = clamp((roi + 0.15) / 1.15);
    const urgency = clamp(1 - hours / 72);
    const rawScore = 100 * clamp(
      probabilityProfit * 0.3 +
      marginComponent * 0.24 +
      clamp((Number(item.demand) || 50) / 100) * 0.16 +
      confidence * 0.15 +
      clamp((Number(item.rarity) || 0) / 100) * 0.1 +
      urgency * 0.05,
    );
    const hasResaleEvidence = resaleMedian > 0;
    const score = hasResaleEvidence ? Math.round(rawScore) : 15;
    let signal = "research";
    if (hasResaleEvidence && (profitExpected < 0 || maxBid < Number(item.currentBid) * 0.9)) signal = "avoid";
    else if (hasResaleEvidence && score >= 70 && maxBid > Number(item.currentBid)) signal = "candidate";
    else if (hasResaleEvidence && score >= 48) signal = "watch";
    if (["candidate", "watch", "research", "avoid"].includes(item.riskGate)) {
      signal = item.riskGate;
    }
    return {
      expectedClose,
      marketplaceFee,
      taxRate,
      buyerPremium,
      outboundShipping,
      repairReserve,
      returnReserve,
      shipping,
      resaleLow,
      resaleMedian,
      resaleHigh,
      acquisition,
      sellingCosts: resaleMedian - netMedian,
      profitLow,
      profitExpected,
      profitHigh,
      probabilityProfit,
      confidence: hasResaleEvidence ? confidence : Math.min(confidence, 0.2),
      score,
      signal,
      maxBid,
      roi,
      hours,
      hasResaleEvidence,
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
    return `
      <div class="opportunity-row${selected}" data-select-id="${escapeHtml(item.id)}" role="button" tabindex="0" aria-label="View ${escapeHtml(item.title)} details">
        <div class="item-cell">
          <span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>
          <span class="item-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.category)} · ${escapeHtml(item.externalId)}</small>
            <span class="signal-line"><span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span><span class="status-pill">${statusText}</span>${item.publishedResearch ? '<span class="status-pill research-source">RESEARCH SNAPSHOT</span>' : ""}</span>
          </span>
          <span class="score-mini" style="--score:${a.score};--score-color:${scoreColor(a.signal)}" data-score="${a.score}" aria-label="Opportunity score ${a.score} out of 100"></span>
        </div>
        <div class="money-cell"><span>Bid</span><strong>${money(item.currentBid)}</strong><small>${Number(item.bidCount) || 0} bids</small></div>
        <div class="money-cell"><span>Max bid</span><strong>${a.hasResaleEvidence ? money(a.maxBid) : "Needs comps"}</strong><small>${a.hasResaleEvidence ? "downside-aware" : "add resale value"}</small></div>
        <div class="money-cell"><span>Profit</span><strong class="${a.profitExpected >= 0 ? "positive" : "negative"}">${a.hasResaleEvidence ? money(a.profitExpected) : "—"}</strong><small>${a.hasResaleEvidence ? percent(a.roi) + " ROI" : "not modeled"}</small></div>
        <button class="row-watch${watched}" type="button" data-watch-id="${escapeHtml(item.id)}" aria-label="${item.watched ? "Remove from" : "Add to"} watchlist" aria-pressed="${item.watched ? "true" : "false"}">${item.watched ? "◆" : "◇"}</button>
      </div>`;
  }

  function curveFor(item, assessment) {
    const points = Array.isArray(item.observations) ? item.observations.slice(-5) : [];
    const observed = points.map((point, index) => ({
      label: index === points.length - 1 ? "Now" : `S${Math.max(1, (item.observations.length || points.length) - points.length + index + 1)}`,
      value: Number(point.currentBid) || 0,
      observed: true,
      current: index === points.length - 1,
    }));
    if (!observed.length) observed.push({ label: "Now", value: Number(item.currentBid) || 0, observed: true, current: true });
    if (item.status !== "ended") observed.push({ label: "Close", value: assessment.expectedClose, observed: false, current: false });
    const max = Math.max(...observed.map((point) => point.value), 1);
    return observed.map((point) => ({ ...point, height: Math.max(6, Math.round(point.value / max * 100)) }));
  }

  function renderDetail(item) {
    const container = $("[data-opportunity-detail]");
    if (!container) return;
    if (!item) {
      container.innerHTML = '<div class="empty-state"><span>⌁</span><h4>Select an opportunity</h4><p>Choose a row to inspect the conservative bid model.</p></div>';
      return;
    }
    const a = assess(item);
    const curve = curveFor(item, a);
    const sourceUrl = safeHttpUrl(item.url || item.sourceUrl);
    const maxWaterfall = Math.max(a.resaleMedian, a.acquisition, a.sellingCosts, Math.abs(a.profitExpected), 1);
    const width = (value) => `${Math.max(3, Math.min(100, Math.abs(value) / maxWaterfall * 100)).toFixed(1)}%`;
    const evidence = Array.isArray(item.evidence) && item.evidence.length
      ? item.evidence
      : [
          { label: "Identity", value: "User snapshot" },
          { label: "Demand", value: a.hasResaleEvidence ? "Resale values supplied" : "Needs sold comps" },
          { label: "Risk", value: "Verify condition" },
        ];
    container.innerHTML = `
      <div class="detail-top">
        <div class="detail-eyebrow"><span class="section-kicker"><i></i> SELECTED ANALYSIS</span>${item.publishedResearch ? '<span class="illustrative-chip live">RESEARCH SNAPSHOT</span>' : item.illustrative ? '<span class="illustrative-chip">ILLUSTRATIVE</span>' : '<span class="illustrative-chip">USER SNAPSHOT</span>'}</div>
        <div class="detail-title-row">
          <span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span>
          <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.externalId)} · ${escapeHtml(item.category)}</p></div>
          <span class="score-ring" style="--score:${a.score};--score-color:${scoreColor(a.signal, true)}" data-score="${a.score}" aria-label="Opportunity score ${a.score} out of 100"></span>
        </div>
        <div class="detail-signal"><span class="signal-pill ${a.signal}">${signalLabel(a.signal)}</span><span>${escapeHtml(item.identifiedAs || "Identity requires user verification")}</span></div>
      </div>
      <div class="detail-body">
        <div class="bid-metrics">
          <div class="bid-metric"><span>${item.status === "ended" ? "Final bid" : "Current bid"}</span><strong>${money(item.status === "ended" && item.finalPrice ? item.finalPrice : item.currentBid)}</strong><small>${Number(item.bidCount) || 0} bids · ${timeLabel(item)}</small></div>
          <div class="bid-metric"><span>Expected close</span><strong>${money(a.expectedClose)}</strong><small>snapshot forecast</small></div>
          <div class="bid-metric primary"><span>Safe ceiling</span><strong>${a.hasResaleEvidence ? money(a.maxBid) : "—"}</strong><small>target profit preserved</small></div>
        </div>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Median profit waterfall</h4><span>${a.hasResaleEvidence ? percent(a.probabilityProfit) + " modeled chance of profit" : "Add resale evidence"}</span></div>
          <div class="waterfall">
            <div class="waterfall-row"><span>Median resale</span><span class="waterfall-track"><i style="--width:${width(a.resaleMedian)}"></i></span><strong>${money(a.resaleMedian)}</strong></div>
            <div class="waterfall-row cost"><span>Landed cost</span><span class="waterfall-track"><i style="--width:${width(a.acquisition)}"></i></span><strong>−${money(a.acquisition)}</strong></div>
            <div class="waterfall-row cost"><span>Sell + risk costs</span><span class="waterfall-track"><i style="--width:${width(a.sellingCosts)}"></i></span><strong>−${money(a.sellingCosts)}</strong></div>
            <div class="waterfall-row profit ${a.profitExpected < 0 ? "negative" : ""}"><span>Modeled profit</span><span class="waterfall-track"><i style="--width:${width(a.profitExpected)}"></i></span><strong>${a.hasResaleEvidence ? money(a.profitExpected) : "—"}</strong></div>
          </div>
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Bid development</h4><span>stored snapshots + projected close</span></div>
          <div class="curve-chart" aria-label="Bid snapshot curve">
            ${curve.map((point) => `<span class="curve-bar ${point.observed ? "observed" : ""} ${point.current ? "current" : ""}" title="${escapeHtml(point.label)}: ${money(point.value)}"><i style="--height:${point.height}%"></i><span>${escapeHtml(point.label)}</span></span>`).join("")}
          </div>
          <div class="curve-caption"><span>Observed: ${money(curve[0].value)}</span><strong>Expected: ${money(a.expectedClose)}</strong></div>
        </section>
        <section class="detail-section">
          <div class="detail-section-heading"><h4>Evidence check</h4><span>${percent(a.confidence)} confidence</span></div>
          <div class="evidence-grid">${evidence.slice(0, 3).map((entry) => `<div class="evidence-item"><span>${escapeHtml(entry.label)}</span><strong title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</strong></div>`).join("")}</div>
        </section>
        <div class="detail-actions">
          <button class="button button-primary" type="button" data-watch-id="${escapeHtml(item.id)}">${item.watched ? "Remove watch" : "Watch item"}</button>
          <button class="button button-quiet" type="button" data-update-id="${escapeHtml(item.id)}">Record update</button>
          ${sourceUrl ? `<a class="button button-quiet" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer noopener">Open listing</a>` : ""}
        </div>
        <p class="risk-note">Scores use incomplete market inputs. Inspect the item, verify authenticity, and calculate every fee before deciding to bid.</p>
      </div>`;
  }

  function filteredItems() {
    const query = String($("#global-search")?.value || "").trim().toLowerCase();
    const signal = $("#signal-filter")?.value || "all";
    const category = $("#category-filter")?.value || "all";
    return allItems()
      .filter((item) => {
        const haystack = [item.title, item.category, item.externalId, item.identifiedAs].join(" ").toLowerCase();
        const assessment = assess(item);
        return (!query || haystack.includes(query)) &&
          (signal === "all" || assessment.signal === signal) &&
          (category === "all" || item.category === category);
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return assess(b).score - assess(a).score;
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

  function renderStats() {
    const active = allItems().filter((item) => item.status === "active");
    const assessments = active.map(assess);
    const upside = assessments.reduce((total, item) => total + Math.max(0, item.profitExpected), 0);
    const urgent = active.filter((item) => hoursRemaining(item) <= 12).length;
    const confidence = assessments.length ? assessments.reduce((total, item) => total + item.confidence, 0) / assessments.length : 0;
    const observations = allItems().reduce((total, item) => total + (Array.isArray(item.observations) ? item.observations.length : 0), 0);
    $("[data-stat-upside]").textContent = money(upside);
    $("[data-stat-urgent]").textContent = String(urgent);
    $("[data-stat-confidence]").textContent = percent(confidence);
    $("[data-stat-observations]").textContent = observations.toLocaleString("en-US");
    $$('[data-opportunity-count]').forEach((el) => { el.textContent = String(active.length); });
    $$('[data-watch-count]').forEach((el) => { el.textContent = String(workspace.watchIds.length); });
    $$('[data-research-count]').forEach((el) => { el.textContent = String(PUBLISHED_RESEARCH.items.length); });
    $$('[data-research-observed]').forEach((el) => {
      const observed = PUBLISHED_RESEARCH.observedAt ? new Date(PUBLISHED_RESEARCH.observedAt) : null;
      el.textContent = observed && !Number.isNaN(observed.getTime())
        ? observed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "No published pass";
    });
    $$('[data-source-status]').forEach((el) => {
      const mode = String(PUBLISHED_RESEARCH.sourceMode || "").toLowerCase();
      el.textContent = !PUBLISHED_RESEARCH.items.length
        ? "Awaiting research data"
        : mode.includes("authorized")
          ? "Authorized feed loaded"
          : mode.includes("manual")
            ? "Manual research pass loaded"
            : "Research snapshots loaded";
    });
  }

  function renderOpportunities() {
    populateCategories();
    const items = filteredItems();
    const list = $("[data-opportunity-list]");
    const empty = $("[data-queue-empty]");
    if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id || "";
    list.innerHTML = items.map(renderOpportunityRow).join("");
    empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    renderDetail(items.find((item) => item.id === selectedId) || items[0]);
    renderStats();
  }

  function renderWatchlist() {
    const watched = allItems().filter((item) => item.watched);
    const grid = $("[data-watchlist-grid]");
    const empty = $("[data-watch-empty]");
    grid.innerHTML = watched.map((item) => {
      const a = assess(item);
      return `<article class="watch-card">
        <div class="watch-card-top"><span class="item-avatar ${escapeHtml(item.accent || "silver")}" aria-hidden="true">${escapeHtml(initialsFor(item))}</span><div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.category)} · ${timeLabel(item)}</p></div></div>
        <div class="watch-card-metrics"><div><span>Current</span><strong>${money(item.currentBid)}</strong></div><div><span>Max bid</span><strong>${a.hasResaleEvidence ? money(a.maxBid) : "—"}</strong></div><div><span>Profit</span><strong>${a.hasResaleEvidence ? money(a.profitExpected) : "—"}</strong></div></div>
        <div class="watch-card-actions"><button class="button button-primary" type="button" data-open-id="${escapeHtml(item.id)}">Open analysis</button><button class="button button-quiet" type="button" data-watch-id="${escapeHtml(item.id)}">Remove</button></div>
      </article>`;
    }).join("");
    grid.hidden = watched.length === 0;
    empty.hidden = watched.length > 0;
    renderStats();
  }

  function learningSamples() {
    const userSamples = workspace.userItems.flatMap((item) => {
      if (item.status !== "ended" || !(Number(item.finalPrice) > 0)) return [];
      const observations = Array.isArray(item.observations) ? item.observations : [];
      const prior = observations.find((entry) => entry.status !== "ended" && Number(entry.expectedClose) > 0)
        || observations.find((entry) => Number(entry.expectedClose) > 0);
      const predicted = Number(prior?.expectedClose || item.expectedClose);
      if (!(predicted > 0)) return [];
      return [{ category: item.category || "Unclassified", predicted, actual: Number(item.finalPrice), illustrative: false }];
    });
    return [...ILLUSTRATIVE_OUTCOMES, ...userSamples];
  }

  function renderLearning() {
    const samples = learningSamples();
    const userCount = samples.filter((sample) => !sample.illustrative).length;
    const errors = samples.map((sample) => Math.abs(sample.actual - sample.predicted) / Math.max(1, sample.actual));
    const ratios = samples.map((sample) => sample.actual / Math.max(1, sample.predicted));
    const typicalError = median(errors);
    const bias = median(ratios) - 1;
    const within15 = samples.filter((sample) => Math.abs(sample.actual - sample.predicted) / Math.max(1, sample.actual) <= 0.15).length / Math.max(1, samples.length);
    $("[data-learning-summary]").innerHTML = `
      <article class="learning-metric accent"><span>Ended outcomes</span><strong>${samples.length}</strong><small>${userCount} user · ${samples.length - userCount} illustrative</small></article>
      <article class="learning-metric"><span>Typical final-price error</span><strong>${percent(typicalError)}</strong><small>median absolute percentage error</small></article>
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
        const userSamples = categorySamples.filter((sample) => !sample.illustrative).length;
        const signal = userSamples === 0 ? "Demo only" : userSamples < 3 ? "Early" : categoryError <= 0.15 ? "Calibrated" : "Learning";
        return `<tr><td><strong>${escapeHtml(category)}</strong></td><td>${categorySamples.length}</td><td><span class="calibration-bar"><i style="--width:${Math.min(100, categoryError * 300)}%"></i>${percent(categoryError)}</span></td><td>${categoryBias >= 0 ? "+" : ""}${percent(categoryBias)}</td><td><span class="signal-pill ${signal === "Calibrated" ? "candidate" : signal === "Demo only" ? "research" : "watch"}">${signal}</span></td></tr>`;
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

  function normalizeSnapshot(record, index = 0, sourceName = "Manual entry") {
    const title = String(lookup(record, aliases.title) ?? record.title ?? "").trim();
    if (!title) return null;
    const rawId = String(lookup(record, aliases.externalId) ?? record.externalId ?? `snapshot-${index + 1}`).trim();
    const externalId = rawId || `snapshot-${index + 1}`;
    const currentBid = Math.max(0, parseMoney(lookup(record, aliases.currentBid) ?? record.currentBid));
    const finalPrice = Math.max(0, parseMoney(lookup(record, aliases.finalPrice) ?? record.finalPrice));
    const shipping = Math.max(0, parseMoney(lookup(record, aliases.shipping) ?? record.shipping));
    const bidCount = Math.max(0, Math.round(Number(lookup(record, aliases.bidCount) ?? record.bidCount) || 0));
    const endsAt = safeDate(lookup(record, aliases.endsAt) ?? record.endsAt, hoursFromNow(24));
    const observedAt = safeDate(lookup(record, aliases.observedAt) ?? record.observedAt, new Date().toISOString());
    const statusValue = String(lookup(record, aliases.status) ?? record.status ?? "active").toLowerCase();
    const status = finalPrice > 0 || statusValue.includes("ended") || statusValue.includes("closed") || new Date(endsAt).getTime() <= Date.now() ? "ended" : "active";
    const expectedProvided = parseMoney(lookup(record, aliases.expectedClose) ?? record.expectedClose);
    const expectedClose = expectedProvided > 0
      ? expectedProvided
      : status === "ended" && finalPrice > 0
        ? finalPrice
        : projectFinalBid(currentBid, Math.max(0, (new Date(endsAt).getTime() - Date.now()) / 3600000), bidCount);
    const resaleMedian = Math.max(0, parseMoney(lookup(record, aliases.resaleMedian) ?? record.resaleMedian));
    const resaleLow = Math.max(0, parseMoney(lookup(record, aliases.resaleLow) ?? record.resaleLow)) || (resaleMedian ? resaleMedian * 0.82 : 0);
    const resaleHigh = Math.max(0, parseMoney(lookup(record, aliases.resaleHigh) ?? record.resaleHigh)) || (resaleMedian ? resaleMedian * 1.18 : 0);
    const identityConfidence = parseConfidence(lookup(record, aliases.identityConfidence) ?? record.identityConfidence, resaleMedian ? 0.42 : 0.35);
    const conditionConfidence = parseConfidence(lookup(record, aliases.conditionConfidence) ?? record.conditionConfidence, 0.35);
    const demand = parseScore(lookup(record, aliases.demand) ?? record.demand, 50);
    const rarity = parseScore(lookup(record, aliases.rarity) ?? record.rarity, 0);
    const compCount = Math.max(0, Math.round(Number(lookup(record, aliases.compCount) ?? record.compCount) || (resaleMedian ? 1 : 0)));
    const compRecencyDays = Math.max(0, Math.round(Number(lookup(record, aliases.compRecencyDays) ?? record.compRecencyDays) || 365));
    const optionalNumber = (name) => {
      const value = lookup(record, aliases[name]) ?? record[name];
      return value === "" || value === null || value === undefined ? undefined : Math.max(0, parseMoney(value));
    };
    const id = `user-${cleanKey(externalId) || cleanKey(title) || Date.now()}`;
    return {
      id,
      externalId,
      source: String(lookup(record, aliases.source) ?? record.source ?? sourceName),
      url: String(lookup(record, aliases.url) ?? record.url ?? "").trim() || null,
      title,
      category: String(lookup(record, aliases.category) ?? record.category ?? "Unclassified").trim() || "Unclassified",
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
      illustrative: false,
      observedAt,
      observations: [{ observedAt, currentBid: Math.max(currentBid, finalPrice || 0), bidCount, expectedClose, status }],
      evidence: [
        { label: "Source", value: "User-provided snapshot" },
        { label: "Resale", value: resaleMedian ? "User estimate supplied" : "Needs sold comps" },
        { label: "Risk", value: "Condition unverified" },
      ],
    };
  }

  function mergeSnapshot(snapshot) {
    const index = workspace.userItems.findIndex((item) => item.id === snapshot.id || cleanKey(item.externalId) === cleanKey(snapshot.externalId));
    if (index >= 0) {
      const existing = workspace.userItems[index];
      const history = [...(Array.isArray(existing.observations) ? existing.observations : []), ...snapshot.observations].slice(-250);
      workspace.userItems[index] = {
        ...existing,
        ...snapshot,
        id: existing.id,
        observations: history,
        createdAt: existing.createdAt || existing.observedAt,
        updatedAt: snapshot.observedAt,
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
      sourcePolicy: "User-provided snapshots only; no automated ShopGoodwill access.",
      settings: workspace.settings,
      watchIds: workspace.watchIds,
      items: workspace.userItems,
    };
    downloadBlob(JSON.stringify(payload, null, 2), `bidaipro-workspace-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    toast("Private workspace exported.");
  }

  function downloadTemplate() {
    const csv = [
      "id,title,category,url,current_bid,shipping,bid_count,ends_at,expected_close,resale_low,resale_median,resale_high,demand,rarity,identity_confidence,condition_confidence,final_price,status,observed_at",
      'SGW-123456,"Vintage camera body and lens",Cameras & optics,https://example.com/listing/123456,125,14.95,8,2026-08-05T19:00:00,210,300,375,450,82,35,0.88,0.62,,active,2026-08-01T20:00:00',
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
    const row = event.target.closest("[data-select-id]");
    if (row) {
      selectedId = row.dataset.selectId;
      renderOpportunities();
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
        selectedId = "demo-gold-ring";
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
    const row = event.target.closest?.("[data-select-id]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectedId = row.dataset.selectId;
      renderOpportunities();
    }
  });

  $("#global-search").addEventListener("input", () => {
    if (activeView !== "opportunities") setView("opportunities");
    else renderOpportunities();
  });
  $("#signal-filter").addEventListener("change", renderOpportunities);
  $("#category-filter").addEventListener("change", renderOpportunities);
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
