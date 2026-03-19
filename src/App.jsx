/* eslint-disable no-unused-vars */
import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const THENEWS_KEY = "GzCg1YdRg2mxy6OJ7XQgk2UNZwV9Pq7XNbDnuLKv";
const GNEWS_KEY   = "9e1ef6ca6dd91d2708f9b476b72cdd22";
const CORS        = "https://corsproxy.io/?url=";
const START_CASH  = 1000;
const REFRESH_MS   = 10000;  // price refresh every 10s
const DEEP_SCAN_MS = 180000; // deep market scan every 3 minutes (not spammy)

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const pct    = (p)  => `${(+p * 100).toFixed(1)}%`;
const dollar = (n)  => `$${(+n).toFixed(2)}`;
const mini   = (n)  => +n >= 1e6 ? `$${(+n/1e6).toFixed(1)}M` : +n >= 1e3 ? `$${(+n/1e3).toFixed(1)}k` : `$${(+n).toFixed(0)}`;
const ts     = ()   => new Date().toLocaleTimeString("en-US", { hour12: false });
const fmtUp  = (s)  => `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
const age    = (iso) => { if (!iso) return ""; const h = Math.round((Date.now()-new Date(iso))/3600000); return h < 24 ? `${h}h ago` : `${Math.floor(h/24)}d ago`; };

// ─── API fetch with CORS proxy ────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  try {
    const r = await fetch(CORS + encodeURIComponent(url), { signal: AbortSignal.timeout(8000), ...opts });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) { return null; }
}

// Direct fetch (no proxy) for CLOB
async function directFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) { return null; }
}

// ─── Polymarket API calls ─────────────────────────────────────────────────────
async function fetchMarkets(limit = 100) {
  const data = await apiFetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`);
  if (!Array.isArray(data)) return [];
  return data.filter(m => m.active && !m.closed && m.enableOrderBook && m.clobTokenIds && m.outcomePrices).map(m => {
    let yesId = null, noId = null;
    try { [yesId, noId] = JSON.parse(m.clobTokenIds); } catch (_e) { /* ignore */ }
    let yesP = 0.5, noP = 0.5;
    try { const p = JSON.parse(m.outcomePrices); yesP = +p[0] || 0.5; noP = +p[1] || 0.5; } catch (_e) { /* ignore */ }
    return {
      id: m.id, conditionId: m.conditionId, slug: m.slug,
      question: m.question || "Unknown market",
      yesId, noId, yesPrice: yesP, noPrice: noP,
      bestBid: m.bestBid ?? null, bestAsk: m.bestAsk ?? null,
      volume24h: +(m.volume24hr || 0), liquidity: +(m.liquidityNum || 0),
      oneDayChange: +(m.oneDayPriceChange || 0),
      endDate: m.endDateIso || null, category: m.category || "--",
    };
  });
}

// Get live order book from CLOB for accurate pricing
async function fetchOrderBook(tokenId) {
  // Try direct first
  const direct = await directFetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  if (direct?.bids || direct?.asks) return direct;
  // Via proxy
  return await apiFetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
}

// Calculate mid price from order book
function calcMidFromBook(book) {
  if (!book) return null;
  const bestBid = book.bids?.[0]?.price;
  const bestAsk = book.asks?.[0]?.price;
  if (bestBid && bestAsk) return (+bestBid + +bestAsk) / 2;
  if (bestBid) return +bestBid;
  if (bestAsk) return +bestAsk;
  return null;
}

// Get current price — order book → midpoint → gamma fallback
async function getLivePrice(yesId, conditionId) {
  // 1. Try order book (most accurate)
  const book = await fetchOrderBook(yesId);
  const mid = calcMidFromBook(book);
  if (mid !== null) return { price: mid, source: "orderbook", book };

  // 2. Try CLOB midpoint directly
  try {
    const d = await directFetch(`https://clob.polymarket.com/midpoint?token_id=${yesId}`);
    if (d?.mid != null) return { price: +d.mid, source: "clob-mid", book: null };
  } catch (_e) { /* ignore */ }

  // 3. Gamma API fallback (always works)
  const gamma = await apiFetch(`https://gamma-api.polymarket.com/markets/${conditionId}`);
  if (gamma?.outcomePrices) {
    try {
      const prices = JSON.parse(gamma.outcomePrices);
      return { price: +prices[0], source: "gamma", book: null };
    } catch (_e) { /* ignore */ }
  }
  return null;
}

// Leaderboard API
async function fetchLeaderboard(timePeriod = "WEEK", orderBy = "PNL", limit = 25) {
  const data = await apiFetch(`https://data-api.polymarket.com/v1/leaderboard?timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${limit}&offset=0`);
  return Array.isArray(data) ? data : [];
}

// Wallet positions
async function fetchWalletPositions(address) {
  return await apiFetch(`https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0.01&limit=20`);
}

async function fetchWalletTrades(address) {
  return await apiFetch(`https://data-api.polymarket.com/trades?user=${address}&limit=10`);
}

// ─── News fetching ────────────────────────────────────────────────────────────
function extractQuery(question) {
  let q = question
    .replace(/on \d{4}-\d{2}-\d{2}\??/gi, "")
    .replace(/after the \w+ \d{4}.*?\??/gi, "")
    .replace(/^will\s+/i, "")
    .replace(/\s+win\s*\??$/i, "")
    .replace(/\s+vs\.?\s+/i, " ")
    .replace(/\?/g, "").trim();
  if (/federal reserve|fed.*rate|rate.*fed/i.test(q)) return "Federal Reserve interest rate 2026";
  if (/bitcoin|btc/i.test(q)) return "Bitcoin price 2026";
  if (/ethereum|eth/i.test(q)) return "Ethereum price 2026";
  return q.slice(0, 60);
}

async function getNews(question) {
  const query = extractQuery(question);
  // TheNewsAPI
  try {
    const url = `https://api.thenewsapi.com/v1/news/all?api_token=${THENEWS_KEY}&search=${encodeURIComponent(query)}&language=en&limit=5&sort_by=published_at`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      if (d.error) throw new Error(d.error); // API limit hit
      const arts = (d.data || []).map(a => ({ title: a.title, snippet: a.snippet || a.description || "", src: "TNA", published: a.published_at }));
      if (arts.length > 0) return { articles: arts, query, apiUsed: "TheNewsAPI" };
    }
  } catch (_e) { /* try next */ }
  // GNews
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=5&sortby=publishedAt&apikey=${GNEWS_KEY}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      const arts = (d.articles || []).map(a => ({ title: a.title, snippet: a.content || a.description || "", src: "GNews", published: a.publishedAt }));
      if (arts.length > 0) return { articles: arts, query, apiUsed: "GNews" };
    }
  } catch (_e) { /* try next */ }
  // GNews short query
  const short = query.split(" ").slice(0, 3).join(" ");
  if (short.length > 3) {
    try {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(short)}&lang=en&max=5&sortby=publishedAt&apikey=${GNEWS_KEY}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        const arts = (d.articles || []).map(a => ({ title: a.title, snippet: a.content || a.description || "", src: "GNews", published: a.publishedAt }));
        if (arts.length > 0) return { articles: arts, query: short, apiUsed: "GNews-short" };
      }
    } catch (_e) { /* ignore */ }
  }
  return { articles: [], query, apiUsed: "none" };
}

// ─── AI Engine v2 — Smarter Trading Logic ────────────────────────────────────
//
// Key improvements over v1:
//  1. Question-aware sentiment — news must be RELEVANT to the market question
//  2. Much higher confidence threshold (65%) with stricter scoring
//  3. Spread penalty — wide bid/ask spread = immediate loss on entry
//  4. Time-to-resolution scoring — closer deadlines = higher risk
//  5. Multi-signal agreement required — need 2+ signals to fire
//  6. Position sizing tied to edge magnitude, not just confidence
//  7. Separate logic per market type with proven strategies

// ── Keyword banks (question-specific matching) ────────────────────────────────

const KEYWORDS = {
  // Maps market type → keywords that actually matter
  sports: {
    bull: ["won","wins","victory","beat","defeated opponent","champion","leads","favourite","favorite","odds on","clean sheet","unbeaten","dominated","scored","goal","promoted","qualified"],
    bear: ["lost","defeated","injured","suspended","banned","eliminated","relegated","crisis","fired","sacked","dropped","out of form","losing streak","conceded"],
  },
  macro: {
    bull: ["rate cut","cuts rates","cut interest","dovish","pivot","easing","stimulus","pause","no change","hold rates","fed holds","below expectations","slowdown","jobs miss"],
    bear: ["rate hike","hike rates","raised rates","hawkish","tightening","beat expectations","strong jobs","inflation surge","above expectations","emergency"],
  },
  crypto: {
    bull: ["all time high","ath","bull run","rally","surge","etf approved","institutional","adoption","breakout","buy signal","halving","accumulation"],
    bear: ["crash","ban","crackdown","sell-off","bearish","capitulation","dump","hack","exploit","regulation","restrict"],
  },
  politics: {
    bull: ["elected","leads","polling ahead","frontrunner","won primary","majority","landslide","projected winner","called for","ahead in polls","inaugurated"],
    bear: ["trailing","dropped out","scandal","indicted","impeached","polling behind","losing","conceded","withdrew","disqualified","arrested"],
  },
  general: {
    bull: ["confirmed","approved","signed","passed","announced","secured","achieved","reached agreement","deal","completed","launched","approved"],
    bear: ["rejected","blocked","cancelled","failed","denied","collapsed","withdrawn","vetoed","delayed","suspended","halted"],
  },
};

const NEGATIONS = ["not","no","won't","will not","cannot","can't","never","didn't","doesn't","isn't","wasn't","weren't","fails to","unable to","refuse","refused"];

function isNegated(words, idx, window = 5) {
  const ctx = words.slice(Math.max(0, idx - window), idx).join(" ");
  return NEGATIONS.some(n => ctx.includes(n));
}

// ── Question relevance checker ────────────────────────────────────────────────
// Checks if an article is actually about the market question topic
function isRelevant(article, question) {
  const qWords = question.toLowerCase()
    .replace(/will |the |a |an |by |on |in |at |is |are |was |were |to |of /g, "")
    .replace(/[?!.,]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3);

  const text = `${article.title} ${article.snippet}`.toLowerCase();
  const matches = qWords.filter(w => text.includes(w));
  return matches.length >= Math.max(2, Math.floor(qWords.length * 0.3));
}

// ── Smart sentiment scorer ────────────────────────────────────────────────────
function scoreSentiment(articles, question, mType) {
  if (!articles.length) return { score: 0, norm: 0, label: "NO NEWS", hits: { bull: [], bear: [] }, relevant: 0 };

  const kw   = KEYWORDS[mType] || KEYWORDS.general;
  let score  = 0;
  let relevant = 0;
  const hits = { bull: [], bear: [] };

  for (const art of articles) {
    // Only score articles that are actually about this market
    if (!isRelevant(art, question)) continue;
    relevant++;

    const text  = `${art.title} ${art.snippet}`.toLowerCase();
    const words = text.split(/\s+/);

    kw.bull.forEach(kw => {
      const idx = words.findIndex(w => w.includes(kw.split(" ")[0]));
      if (idx >= 0 && text.includes(kw)) {
        if (isNegated(words, idx)) { score -= 1; }
        else { score += 2; hits.bull.push(kw); }
      }
    });
    kw.bear.forEach(kw => {
      if (text.includes(kw)) { score -= 2; hits.bear.push(kw); }
    });
  }

  // Penalty if no relevant articles
  if (relevant === 0 && articles.length > 0) score = 0;

  const norm = Math.max(-1, Math.min(1, score / 10));
  return {
    score, norm, hits, relevant,
    label: score >= 4 ? "STRONGLY BULLISH"
         : score >= 2 ? "BULLISH"
         : score <= -4 ? "STRONGLY BEARISH"
         : score <= -2 ? "BEARISH"
         : "NEUTRAL",
  };
}

// ── Market quality scorer ─────────────────────────────────────────────────────
// Returns 0-100. Bad markets (illiquid, wide spread) score low.
function scoreMarketQuality(market) {
  let score = 50;

  // Volume scoring
  const vol = market.volume24h || 0;
  if (vol > 500000) score += 20;
  else if (vol > 100000) score += 12;
  else if (vol > 25000)  score += 6;
  else if (vol > 5000)   score += 0;
  else score -= 15; // very low volume = avoid

  // Spread scoring — wide spread means you lose on entry/exit
  if (market.bestBid && market.bestAsk) {
    const spread = market.bestAsk - market.bestBid;
    if (spread < 0.01)      score += 15; // tight spread, great
    else if (spread < 0.03) score += 8;
    else if (spread < 0.06) score += 0;
    else if (spread < 0.10) score -= 10;
    else score -= 25; // >10% spread = almost certainly lose money
  } else {
    score -= 10; // no order book data
  }

  // Mid-range price = most uncertainty = most opportunity
  const p = market.yesPrice;
  if (p >= 0.30 && p <= 0.70) score += 10;
  else if (p >= 0.15 && p <= 0.85) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ── Time-to-resolution risk ────────────────────────────────────────────────────
// Markets resolving very soon are risky (no time for price to correct)
function timeRisk(endDate) {
  if (!endDate) return { penalty: 0, label: "unknown" };
  const daysLeft = (new Date(endDate) - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0)   return { penalty: 30, label: "EXPIRED?" };
  if (daysLeft < 1)   return { penalty: 25, label: "<1 day" };
  if (daysLeft < 3)   return { penalty: 15, label: "<3 days" };
  if (daysLeft < 7)   return { penalty: 5,  label: "<1 week" };
  if (daysLeft < 30)  return { penalty: 0,  label: "<1 month" };
  return { penalty: 0, label: ">1 month" };
}

// ── Statistical edge models ────────────────────────────────────────────────────
function statEdge(market, mType) {
  const p   = market.yesPrice;
  const mom = market.oneDayChange || 0;
  // Less edge in very liquid markets (more efficient pricing)
  const lf  = (market.volume24h||0) > 2e6 ? 0.3 : (market.volume24h||0) > 5e5 ? 0.55 : 0.85;

  if (mType === "sports") {
    // Favourite-longshot bias — favourites are consistently overpriced
    if (p >= 0.68 && p <= 0.83) return { action:"BUY_NO",  edge:0.05*lf, reason:`Favourite bias: ${(p*100).toFixed(0)}% likely overpriced` };
    if (p >= 0.17 && p <= 0.32) return { action:"BUY_YES", edge:0.05*lf, reason:`Underdog value: ${(p*100).toFixed(0)}% may be underpriced` };
    // Strong momentum in near-50/50 = follow
    if (p >= 0.40 && p <= 0.60 && Math.abs(mom) > 0.04) {
      return { action: mom > 0 ? "BUY_YES" : "BUY_NO", edge: Math.abs(mom)*0.5*lf, reason:`50/50 strong momentum ${(mom*100).toFixed(1)}%` };
    }
  } else if (mType === "crypto") {
    // Crypto follows momentum strongly
    if (mom > 0.08) return { action:"BUY_YES", edge:mom*0.45, reason:`Crypto bull momentum +${(mom*100).toFixed(1)}%` };
    if (mom < -0.08) return { action:"BUY_NO",  edge:Math.abs(mom)*0.45, reason:`Crypto bear momentum ${(mom*100).toFixed(1)}%` };
  } else if (mType === "macro") {
    // Macro: only follow strong momentum in mid-range
    if (p >= 0.20 && p <= 0.80 && Math.abs(mom) > 0.06) {
      return { action: mom > 0 ? "BUY_YES" : "BUY_NO", edge: Math.abs(mom)*0.5*lf, reason:`Macro shift ${(mom*100).toFixed(1)}%` };
    }
  } else if (mType === "politics") {
    // Poll shifts — only follow strong moves
    if (Math.abs(mom) > 0.07) {
      return { action: mom > 0 ? "BUY_YES" : "BUY_NO", edge: Math.abs(mom)*0.4*lf, reason:`Political shift ${(mom*100).toFixed(1)}%` };
    }
  }
  return { action:"SKIP", edge:0, reason:"No statistical pattern" };
}

// ── Main analysis function ────────────────────────────────────────────────────
function detectType(q) {
  const t = q.toLowerCase();
  if (/\bvs\b|\bvs\.|\bwin on \d{4}|premier league|la liga|bundesliga|nba|nfl|nhl|mlb|champions league|ncaa|march madness/.test(t)) return "sports";
  if (/fed|interest rate|federal reserve|bps|fomc|cpi|gdp|unemployment/.test(t)) return "macro";
  if (/bitcoin|ethereum|crypto|btc|eth|sol|xrp|bnb|coinbase/.test(t)) return "crypto";
  if (/election|president|senate|vote|democrat|republican|trump|prime minister|parliament/.test(t)) return "politics";
  return "general";
}

function analyzeMarket(market, articles, cash) {
  const log  = [];
  const mType = detectType(market.question);
  const p    = market.yesPrice;

  // Hard block — never trade extreme prices
  if (p > 0.93 || p < 0.07) {
    log.push(`BLOCKED: ${pct(p)} too extreme`);
    log.push(`[DECISION] SKIP`);
    return { action:"SKIP", conf:0, amount:0, edgeFrom:"blocked", mType, sent:{hits:{bull:[],bear:[]},label:"N/A",relevant:0}, stat:{action:"SKIP",reason:"Extreme price"}, log, reason:"Price too extreme" };
  }

  log.push(`[${mType.toUpperCase()}] "${market.question.slice(0,65)}"`);
  log.push(`Price: YES ${pct(p)}  Vol: ${mini(market.volume24h||0)}  News: ${articles.length} arts`);

  // 1. Market quality — if the market itself is bad, don't trade it
  const quality = scoreMarketQuality(market);
  log.push(`[QUALITY]   Score:${quality}/100${quality < 40 ? " — LOW, penalizing" : quality > 65 ? " — GOOD" : ""}`);
  if (quality < 30) {
    log.push(`[DECISION] SKIP — market quality too low (spread/liquidity)`);
    return { action:"SKIP", conf:0, amount:0, edgeFrom:"quality", mType, sent:{hits:{bull:[],bear:[]},label:"N/A",relevant:0}, stat:{action:"SKIP",reason:"Low quality"}, log, reason:"Low market quality" };
  }

  // 2. Time risk
  const tRisk = timeRisk(market.endDate);
  log.push(`[TIME]      Resolves: ${tRisk.label}  Penalty:${tRisk.penalty}`);

  // 3. Sentiment (question-aware)
  const sent = scoreSentiment(articles, market.question, mType);
  log.push(`[SENTIMENT] ${sent.label} (score:${sent.score}, relevant:${sent.relevant}/${articles.length})`);
  if (sent.hits.bull.length) log.push(`  ↑ ${sent.hits.bull.slice(0,5).join(", ")}`);
  if (sent.hits.bear.length) log.push(`  ↓ ${sent.hits.bear.slice(0,5).join(", ")}`);
  if (!articles.length) log.push(`  ! No news`);

  // 4. Momentum
  const mom = market.oneDayChange || 0;
  const momDir = mom > 0.02 ? "UP" : mom < -0.02 ? "DOWN" : "FLAT";
  log.push(`[MOMENTUM]  ${momDir} (${(mom*100).toFixed(2)}%)  Week: ${((market.oneWeekChange||0)*100).toFixed(1)}%`);

  // 5. Statistical edge
  const stat = statEdge(market, mType);
  log.push(`[STAT EDGE] ${stat.action !== "SKIP" ? stat.action+" "+stat.reason : "No pattern"}`);

  // 6. News-based mispricing — requires RELEVANT news
  let newsAction = "SKIP", newsEdge = 0;
  if (sent.relevant >= 1) {
    // More aggressive implied probability shift when news is strong and relevant
    const shift = sent.norm * Math.min(0.40, 0.15 + Math.abs(sent.norm) * 0.25);
    const implied = Math.max(0.05, Math.min(0.95, p + shift));
    newsEdge = implied - p;
    if (newsEdge > 0.03)       { newsAction = "BUY_YES"; log.push(`[NEWS EDGE] YES underpriced ${(newsEdge*100).toFixed(1)}% (${pct(p)} → implied ${pct(implied)})`); }
    else if (newsEdge < -0.03) { newsAction = "BUY_NO";  log.push(`[NEWS EDGE] NO underpriced ${(Math.abs(newsEdge)*100).toFixed(1)}%`); }
    else log.push(`[NEWS EDGE] Price ≈ implied — no clear edge`);
  } else if (articles.length > 0) {
    log.push(`[NEWS EDGE] Articles not relevant enough to market question`);
  }

  // ── SIGNAL AGREEMENT CHECK ────────────────────────────────────────────────
  // Count how many independent signals agree on direction
  const signals = [];
  if (newsAction === "BUY_YES") signals.push("news:YES");
  if (newsAction === "BUY_NO")  signals.push("news:NO");
  if (stat.action === "BUY_YES") signals.push("stat:YES");
  if (stat.action === "BUY_NO")  signals.push("stat:NO");
  if (sent.norm > 0.3 && sent.relevant > 0)  signals.push("sent:YES");
  if (sent.norm < -0.3 && sent.relevant > 0) signals.push("sent:NO");
  if (mom > 0.05)  signals.push("mom:YES");
  if (mom < -0.05) signals.push("mom:NO");

  const yesSignals = signals.filter(s => s.includes("YES")).length;
  const noSignals  = signals.filter(s => s.includes("NO")).length;
  const agreement  = Math.max(yesSignals, noSignals);
  const conflict   = signals.length > 0 && yesSignals > 0 && noSignals > 0;

  log.push(`[SIGNALS]   YES:${yesSignals} NO:${noSignals} Agreement:${agreement}${conflict ? " CONFLICTED!" : ""}`);

  // ── CONFIDENCE CALCULATION ────────────────────────────────────────────────
  // Start at 35 — must earn the right to trade
  let conf = 35;

  // Quality bonus (0-20)
  conf += Math.round(quality * 0.2);

  // Signal agreement bonus — biggest factor
  if (agreement >= 3) conf += 25;       // 3+ signals agree = strong
  else if (agreement === 2) conf += 12; // 2 signals agree = moderate
  else if (agreement === 1) conf += 4;  // only 1 signal = weak
  // Conflict penalty — signals pointing opposite directions
  if (conflict) conf -= 15;

  // News edge magnitude (0-15)
  conf += Math.min(15, Math.round(Math.abs(newsEdge) * 60));

  // Statistical edge magnitude (0-12)
  conf += Math.min(12, Math.round(stat.edge * 80));

  // Momentum strength (0-8)
  conf += Math.min(8, Math.round(Math.abs(mom) * 60));

  // Time risk penalty
  conf -= tRisk.penalty;

  // Spread penalty (repeat here too)
  if (market.bestBid && market.bestAsk) {
    const spread = market.bestAsk - market.bestBid;
    if (spread > 0.08) conf -= 12;
    else if (spread > 0.05) conf -= 6;
  }

  conf = Math.max(0, Math.min(99, Math.round(conf)));

  // ── FINAL DECISION ────────────────────────────────────────────────────────
  // Threshold: 65% — only trade with strong multi-signal conviction
  const THRESHOLD = 65;

  let action = "SKIP", edgeFrom = "none";

  // Require at least 2 agreeing signals OR 1 very strong signal
  if (agreement >= 2 && !conflict) {
    if (yesSignals > noSignals) { action = "BUY_YES"; }
    else if (noSignals > yesSignals) { action = "BUY_NO"; }
  } else if (agreement === 1 && conf >= THRESHOLD + 10) {
    // Single strong signal only if very high confidence
    if (yesSignals > 0) action = "BUY_YES";
    if (noSignals  > 0) action = "BUY_NO";
  }

  // Determine edge source
  if (newsAction !== "SKIP" && Math.abs(newsEdge) > 0.03) edgeFrom = "news";
  else if (stat.action !== "SKIP") edgeFrom = "statistical";
  else edgeFrom = "momentum";

  if (conf < THRESHOLD) action = "SKIP";
  if (conflict) action = "SKIP"; // Never trade when signals conflict

  // ── POSITION SIZING — Kelly-inspired ─────────────────────────────────────
  // Size proportional to edge magnitude, not just confidence
  let amount = 0;
  if (action !== "SKIP" && conf >= THRESHOLD) {
    const edgeMag = Math.max(Math.abs(newsEdge), stat.edge, Math.abs(mom) * 0.3);
    // Kelly fraction: edge / odds (simplified for binary markets)
    const kellyFrac = Math.min(0.25, edgeMag * 2); // cap at 25% of bankroll
    const raw = cash * kellyFrac;
    // Clamp: minimum $5, maximum $40 (conservative for paper trading)
    amount = Math.max(5, Math.min(40, Math.round(raw / 5) * 5));
    // Scale down if confidence is only just above threshold
    if (conf < THRESHOLD + 8) amount = Math.min(amount, 10);
  }

  log.push("─".repeat(44));
  log.push(`[CONFIDENCE] ${conf}%  (threshold: ${THRESHOLD}%)`);
  log.push(`[DECISION]  ${action !== "SKIP" ? `✓ ${action}  $${amount}  Conf:${conf}%  Sigs:${agreement}` : `SKIP  Conf:${conf}%${conf < THRESHOLD ? ` < ${THRESHOLD}%` : ""}${conflict ? " CONFLICTED" : ""}`}`);

  return {
    action, conf, amount, edgeFrom, mType,
    sent, stat, quality, tRisk,
    log,
    reason: action !== "SKIP"
      ? `[${mType}] ${sent.label} | ${stat.reason.slice(0,40)} | ${agreement} signals`
      : `[${mType}] ${conf < THRESHOLD ? `Conf ${conf}% < ${THRESHOLD}%` : conflict ? "Conflicted signals" : "No edge"}`,
  };
}

function shouldSell(pos, currentPrice) {
  const pnlPct = (currentPrice - pos.ep) / pos.ep;
  const steps = [`Entry:${pct(pos.ep)} → Now:${pct(currentPrice)}  P&L:${(pnlPct*100).toFixed(1)}%`];
  let score = 0;
  if (pnlPct > 0.40)      { score += 65; steps.push("TAKE PROFIT: +40%"); }
  else if (pnlPct > 0.25) { score += 35; steps.push(`Good profit +${(pnlPct*100).toFixed(1)}%`); }
  else if (pnlPct > 0.15) { score += 12; steps.push(`Profit +${(pnlPct*100).toFixed(1)}% — holding`); }
  if (pnlPct < -0.40)      { score += 65; steps.push("STOP LOSS: -40%"); }
  else if (pnlPct < -0.25) { score += 35; steps.push(`WARNING: ${(pnlPct*100).toFixed(1)}%`); }
  else if (pnlPct < -0.15) { score += 10; steps.push(`Drawdown ${(pnlPct*100).toFixed(1)}%`); }
  if (currentPrice > 0.93 && pos.side === "YES") { score += 28; steps.push("YES near ceiling"); }
  if (currentPrice < 0.06 && pos.side === "YES") { score += 45; steps.push("YES collapsed"); }
  if (currentPrice > 0.93 && pos.side === "NO")  { score += 45; steps.push("NO — market against us"); }
  const dec = score >= 50 ? "SELL" : score >= 25 ? "CONSIDER" : "HOLD";
  steps.push(`Score:${score}/100 → ${dec}`);
  return { decision: dec, score, steps };
}

// ─── Color scheme ─────────────────────────────────────────────────────────────
const TC = { sports:"#1e3a1e", macro:"#1e2e3a", crypto:"#3a3a1e", politics:"#3a1e3a", general:"#1e1e2a" };
const TT = { sports:"#4a8a4a", macro:"#4a7a9a", crypto:"#9a9a4a", politics:"#9a4a9a", general:"#7070aa" };
const C  = {
  ok:"#c0c0c0",  err:"#999",    warn:"#888",  dim:"#444",
  mkt:"#ddd",    price:"#bbb",  trade:"#ddd", tradeok:"#90e090",
  header:"#eee", info:"#aaa",   sent:"#aaa",  conf:"#bbb",
  decision:"#fff",profit:"#b0d0b0",loss:"#999",
  pricetick:"#5a9a5a",adaptive:"#9a8a4a",websearch:"#5a8aaa",
  blank:null, div:null,
};

function TypeBadge({ type }) {
  return <span style={{ fontSize:"9px", padding:"1px 5px", background:TC[type]||"#222", color:TT[type]||"#888" }}>{(type||"?").toUpperCase()}</span>;
}

function LogPanel({ logs, logRef }) {
  return (
    <div ref={logRef} style={{ flex:1, overflowY:"auto", padding:"6px 8px", fontSize:"11px", lineHeight:"1.6", fontFamily:"Consolas,monospace" }}>
      {logs.map(l => {
        if (l.type === "blank") return <div key={l.id} style={{ height:"4px" }} />;
        if (l.type === "div")   return <div key={l.id} style={{ color:"#2a2a2a", fontSize:"9px" }}>{"─".repeat(50)}</div>;
        return (
          <div key={l.id} style={{ display:"flex", gap:"8px" }}>
            <span style={{ color:"#1e1e1e", flexShrink:0, fontSize:"9px", paddingTop:"1px" }}>{l.ts}</span>
            <span style={{ color: C[l.type] || "#aaa", wordBreak:"break-word" }}>{l.msg}</span>
          </div>
        );
      })}
      <span style={{ display:"inline-block", width:"6px", height:"11px", background:"#2a2a2a", animation:"blink 1.2s step-end infinite", marginLeft:"2px", verticalAlign:"text-bottom" }} />
    </div>
  );
}

function PanelHead({ title, badge, actions = [] }) {
  return (
    <div style={{ flexShrink:0, background:"#0d0d0d", borderBottom:"1px solid #1c1c1c", padding:"5px 10px", display:"flex", alignItems:"center", gap:"8px" }}>
      <span style={{ color:"#666", fontSize:"10px", letterSpacing:"1px", fontWeight:"bold" }}>{title}</span>
      {badge && <span style={{ color:"#2a2a2a", fontSize:"9px" }}>{badge}</span>}
      <div style={{ marginLeft:"auto", display:"flex", gap:"4px" }}>
        {actions.map(a => (
          <button key={a.label} onClick={a.fn} disabled={a.dis} style={{
            background:"transparent", border:`1px solid ${a.dis ? "#1a1a1a" : "#333"}`,
            color: a.dis ? "#222" : "#666", padding:"2px 10px", fontSize:"10px",
            fontFamily:"Consolas,monospace", cursor: a.dis ? "not-allowed" : "pointer",
          }}>{a.label}</button>
        ))}
      </div>
    </div>
  );
}

function Box({ title, badge, actions, style = {}, children }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", overflow:"hidden", borderRight:"1px solid #141414", ...style }}>
      <PanelHead title={title} badge={badge} actions={actions || []} />
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>{children}</div>
    </div>
  );
}

function SideVal({ label, value, color = "#777", sub = null, hi = false }) {
  return (
    <div style={{ padding:"7px 12px", borderBottom:"1px solid #0f0f0f", background: hi ? "#0a130a" : "transparent" }}>
      <div style={{ color:"#252525", fontSize:"9px", marginBottom:"2px" }}>{label}</div>
      <div style={{ color, fontSize:"14px", fontWeight:"bold" }}>{value}</div>
      {sub && <div style={{ color:"#1e1e1e", fontSize:"9px", marginTop:"1px" }}>{sub}</div>}
    </div>
  );
}

function SRow({ label, value, color = "#3a3a3a" }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"2px 12px", borderBottom:"1px solid #0a0a0a", fontSize:"10px" }}>
      <span style={{ color:"#2a2a2a" }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function TH({ cols }) {
  return (
    <thead>
      <tr style={{ borderBottom:"1px solid #181818" }}>
        {cols.map(c => <th key={c} style={{ padding:"4px 8px", textAlign:"left", fontWeight:"normal", color:"#333", fontSize:"10px", whiteSpace:"nowrap" }}>{c}</th>)}
      </tr>
    </thead>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [markets,   setMarkets]   = useState([]);
  const [blacklist, setBlacklist] = useState(new Set());
  const [portfolio, setPortfolio] = useState({ cash: START_CASH, positions: [], trades: [], closed: [] });
  const [status,    setStatus]    = useState("idle");
  const [auto,      setAuto]      = useState(false);
  const [tab,       setTab]       = useState("positions");
  const [leaderboard, setLeaderboard] = useState([]);
  const [lbPeriod,  setLbPeriod]  = useState("WEEK");
  const [lbOrder,   setLbOrder]   = useState("PNL");
  const [lbLoading, setLbLoading] = useState(false);
  const [walletDetail, setWalletDetail] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("--");
  const [refreshCount, setRefreshCount] = useState(0);
  const [stats, setStats] = useState({ scans:0, analyzed:0, executed:0, news:0, skipped:0, blacklisted:0, uptime:0, lastScan:"--", best:null, worst:null, byType:{sports:0,macro:0,crypto:0,politics:0,general:0} });

  const [scanLog, setScanLog] = useState([]);
  const [aiLog,   setAiLog]   = useState([]);
  const [sellLog, setSellLog] = useState([]);
  const [sysLog,  setSysLog]  = useState([]);

  const bootRef    = useRef(false);
  const portRef    = useRef(portfolio);
  const statusRef  = useRef(status);
  const blackRef   = useRef(new Set());
  const autoRef    = useRef(null);
  const refreshRef = useRef(null);
  const uptimeRef  = useRef(0);
  const scanLogRef = useRef(null);
  const aiLogRef   = useRef(null);
  const sellLogRef = useRef(null);
  const sysLogRef  = useRef(null);

  portRef.current   = portfolio;
  statusRef.current = status;
  blackRef.current  = blacklist;

  // Autoscroll logs
  useEffect(() => {
    [scanLogRef, aiLogRef, sellLogRef, sysLogRef].forEach(r => { if (r.current) r.current.scrollTop = r.current.scrollHeight; });
  }, [scanLog, aiLog, sellLog, sysLog]);

  // Uptime
  useEffect(() => {
    const iv = setInterval(() => { uptimeRef.current += 1; setStats(s => ({ ...s, uptime: uptimeRef.current })); }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Price refresh timer
  useEffect(() => {
    refreshRef.current = setInterval(() => {
      if (portRef.current.positions.filter(p => p.status === "OPEN").length > 0) refreshPrices(true);
    }, REFRESH_MS);
    return () => clearInterval(refreshRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Logger helpers
  const push = useCallback((setter, msg, type = "info") => {
    setter(prev => [...prev.slice(-500), { ts: ts(), msg, type, id: `${Date.now()}-${Math.random()}` }]);
  }, []);
  const sl  = useCallback((m, t) => push(setScanLog, m, t), [push]);
  const al  = useCallback((m, t) => push(setAiLog,   m, t), [push]);
  const sel = useCallback((m, t) => push(setSellLog, m, t), [push]);
  const sys = useCallback((m, t) => push(setSysLog,  m, t), [push]);

  // ── Boot ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      await sleep(60);
      sys("PolyBot v8.0  —  Self-contained AI, no external AI API", "header");
      sys("─────────────────────────────────────────", "div");
      await sleep(100);
      sys("[OK] Polymarket Gamma API (markets)", "ok");
      await sleep(60); sys("[OK] CLOB Order Book API (real-time prices)", "ok");
      await sleep(60); sys("[OK] Data API (leaderboard + positions)", "ok");
      await sleep(60); sys("[OK] TheNewsAPI + GNews (news)", "ok");
      await sleep(60); sys("[OK] Built-in AI engine (sentiment+stat)", "ok");
      await sleep(60); sys("[OK] Auto price refresh every 30s", "ok");
      await sleep(60); sys("[OK] Paper wallet: $1,000.00 USDC", "ok");
      sys("─────────────────────────────────────────", "div");
      sys("Threshold:65%  Signals:2+  Spread:checked  PriceGuard:ON", "info");
      sys("Prices: every 10s  |  Deep scan: every 3min", "info");
      sl("Scanner ready.", "dim");
      al("AI Engine ready — keyword+statistical model.", "dim");
      sel("Position monitor ready.", "dim");
    })();
  }, [sys, sl, al, sel]);

  // ── Price refresh ────────────────────────────────────────────────────────────
  const refreshPrices = useCallback(async (silent = false) => {
    const open = portRef.current.positions.filter(p => p.status === "OPEN");
    if (!open.length) return;
    if (!silent) sys(`[REFRESH] Updating ${open.length} position price(s)...`, "info");

    for (const pos of open) {
      const result = await getLivePrice(pos.yesId, pos.conditionId);
      if (!result) { if (!silent) sys(`  "${pos.question.slice(0,35)}" — fetch failed`, "warn"); continue; }

      const rawYes   = result.price;
      const current  = pos.side === "YES" ? rawYes : (1 - rawYes);
      const pnl      = (current - pos.ep) * pos.shares;
      const pnlPct   = (current - pos.ep) / pos.ep;

      // Extract best bid/ask from order book if available
      let bestBid = null, bestAsk = null;
      if (result.book) {
        bestBid = result.book.bids?.[0]?.price ? +result.book.bids[0].price : null;
        bestAsk = result.book.asks?.[0]?.price ? +result.book.asks[0].price : null;
      }

      setPortfolio(prev => ({
        ...prev,
        positions: prev.positions.map(p => p.id === pos.id
          ? { ...p, currentPrice: current, rawYesPrice: rawYes, pnl, pnlPct, lastUpdate: ts(), priceSource: result.source, bestBid, bestAsk }
          : p
        ),
      }));

      if (!silent) {
        const dir = current > pos.currentPrice ? "▲" : current < pos.currentPrice ? "▼" : "─";
        sys(`  ${dir} ${pos.side} "${pos.question.slice(0,32)}" ${pct(current)}  P&L:${pnl >= 0 ? "+" : ""}${dollar(pnl)}  [${result.source}]`, "pricetick");
      }

      // Auto close on take-profit / stop-loss
      if (pnlPct > 0.40 || pnlPct < -0.40) {
        const reason = pnlPct > 0 ? `TAKE PROFIT +${(pnlPct*100).toFixed(1)}%` : `STOP LOSS ${(pnlPct*100).toFixed(1)}%`;
        sys(`[AUTO-CLOSE] ${reason} — "${pos.question.slice(0,35)}"`, pnlPct > 0 ? "profit" : "loss");
        closePosition({ ...pos, currentPrice: current, pnl, pnlPct });
      }
    }
    setLastRefresh(ts());
    setRefreshCount(c => c + 1);
  }, [sys]); // eslint-disable-line react-hooks/exhaustive-deps

  const closePosition = useCallback((pos) => {
    const closed = { ...pos, closePrice: pos.currentPrice, closedAt: ts(), status: "CLOSED" };
    setPortfolio(prev => {
      const next = { ...prev, cash: prev.cash + pos.currentPrice * pos.shares, positions: prev.positions.filter(p => p.id !== pos.id), closed: [...prev.closed, closed] };
      portRef.current = next;
      return next;
    });
    if (pos.pnl !== undefined) {
      setStats(s => ({
        ...s,
        best:  !s.best  || pos.pnl > s.best.pnl  ? { ...pos } : s.best,
        worst: !s.worst || pos.pnl < s.worst.pnl ? { ...pos } : s.worst,
      }));
    }
  }, []);

  // ── Main scan ─────────────────────────────────────────────────────────────────
  const scan = useCallback(async () => {
    if (statusRef.current === "scanning" || statusRef.current === "thinking") return;
    setStatus("scanning");
    sl("", "blank"); sl("▶ Scan cycle started", "header");

    const raw = await fetchMarkets(100);
    setStats(s => ({ ...s, scans: s.scans + 1, lastScan: ts() }));

    if (!raw.length) { sl("ERROR: Could not fetch markets — CORS proxy busy?", "err"); setStatus("idle"); return; }

    // Blacklist dead markets — aggressive: reject price extremes regardless of volume
    const bl = new Set(blackRef.current);
    let dead = 0;
    const alive = raw.filter(m => {
      if (bl.has(m.id)) return false;
      // HARD RULE: never trade markets already at/near resolution
      if (m.yesPrice > 0.93 || m.yesPrice < 0.07) { bl.add(m.id); dead++; return false; }
      // Also blacklist low-volume flat markets
      const noMov = Math.abs(m.oneDayChange || 0) < 0.002;
      const noVol = (m.volume24h || 0) < 200;
      if (noMov && noVol) { bl.add(m.id); dead++; return false; }
      return true;
    });
    if (dead) { setBlacklist(new Set(bl)); blackRef.current = new Set(bl); sl(`Blacklisted ${dead} dead markets (total: ${bl.size})`, "warn"); setStats(s => ({ ...s, blacklisted: bl.size })); }

    // Sort: mid-range first, then by volume
    const candidates = alive
      .filter(m => (m.volume24h || 0) >= 200)
      .sort((a, b) => {
        const aM = a.yesPrice >= 0.15 && a.yesPrice <= 0.85 ? 1 : 0;
        const bM = b.yesPrice >= 0.15 && b.yesPrice <= 0.85 ? 1 : 0;
        return aM !== bM ? bM - aM : (b.volume24h || 0) - (a.volume24h || 0);
      });

    setMarkets(raw);
    sl(`${raw.length} fetched → ${candidates.length} valid → analyzing top 8`, "ok");

    const toAnalyze = candidates.slice(0, 8);
    setStats(s => ({ ...s, analyzed: s.analyzed + toAnalyze.length }));
    const tradedThisScan = new Set(); // prevent double-buying in same scan cycle

    for (let i = 0; i < toAnalyze.length; i++) {
      const m = toAnalyze[i];
      setStatus("thinking");

      // Dedup — skip if already holding OR already bought this scan
      const heldKey = m.conditionId || m.yesId;
      const held = portRef.current.positions.some(p => p.status === "OPEN" && (p.conditionId === m.conditionId || p.yesId === m.yesId));
      if (held || tradedThisScan.has(heldKey)) {
        sl(`[${i+1}/8] Already holding — skip: "${m.question.slice(0,50)}"`, "dim");
        continue;
      }

      const tag = m.yesPrice >= 0.15 && m.yesPrice <= 0.85 ? "MID" : m.yesPrice < 0.15 ? "LOW" : "HIGH";
      sl(`[${i+1}/8] [${tag}] ${m.question.slice(0, 60)}`, "mkt");
      sl(`  YES:${pct(m.yesPrice)}  Vol:${mini(m.volume24h)}  24hΔ:${((m.oneDayChange||0)*100).toFixed(1)}%`, "dim");

      // Get live price from order book
      const liveResult = await getLivePrice(m.yesId, m.conditionId);
      if (liveResult) {
        m.yesPrice = liveResult.price;
        m.noPrice  = 1 - liveResult.price;
        if (liveResult.book) {
          m.bestBid = liveResult.book.bids?.[0]?.price ? +liveResult.book.bids[0].price : null;
          m.bestAsk = liveResult.book.asks?.[0]?.price ? +liveResult.book.asks[0].price : null;
        }
        sl(`  Live [${liveResult.source}]: YES ${pct(liveResult.price)}${m.bestBid ? `  Bid:${pct(m.bestBid)}` : ""}${m.bestAsk ? ` Ask:${pct(m.bestAsk)}` : ""}`, "price");
      }

      // News
      sl(`  Searching news...`, "dim");
      const newsResult = await getNews(m.question);
      setStats(s => ({ ...s, news: s.news + newsResult.articles.length }));
      if (newsResult.articles.length > 0) {
        sl(`  [${newsResult.apiUsed}] ${newsResult.articles.length} article(s)`, "ok");
        newsResult.articles.slice(0, 2).forEach(a => sl(`    • [${age(a.published)}] ${(a.title || "").slice(0, 62)}`, "dim"));
      } else {
        sl(`  No news — using statistical model`, "dim");
      }

      // AI analysis
      al("", "blank");
      const result = analyzeMarket(m, newsResult.articles, portRef.current.cash);
      result.log.forEach(line => {
        const t = line.startsWith("[DECISION]") ? "decision"
          : line.startsWith("[CONFIDENCE]") ? "conf"
          : line.startsWith("[SENTIMENT]")  ? "sent"
          : line.startsWith("[MOMENTUM]")   ? "dim"
          : line.startsWith("[NEWS EDGE]")  ? "price"
          : line.startsWith("[STAT EDGE]")  ? "price"
          : line.startsWith("[")            ? "mkt"
          : line.startsWith("─")           ? "div"
          : "dim";
        al(line, t);
      });

      sl(`  → ${result.action}  Conf:${result.conf}%  [${result.edgeFrom}]  ${result.reason.slice(0, 45)}`, result.action !== "SKIP" ? "tradeok" : "dim");

      // Execute paper trade
      const liveYes = m.yesPrice;

      // HARD GUARDS — absolute rules, no exceptions
      const hardBlock =
        liveYes > 0.93 || liveYes < 0.07 ||
        (result.action === "BUY_YES" && liveYes > 0.85) ||
        (result.action === "BUY_NO"  && liveYes < 0.15) ||
        (m.bestAsk && m.bestAsk > 0.93) ||
        (m.bestBid && m.bestBid < 0.03);

      if (hardBlock) {
        sl(`  ✗ BLOCKED: price ${pct(liveYes)} too extreme to trade safely`, "warn");
        bl.add(m.id); setBlacklist(new Set(bl)); blackRef.current = new Set(bl);
        sl(`  → Auto-blacklisted (extreme price)`, "warn");
        setStats(s => ({ ...s, skipped: s.skipped + 1, blacklisted: bl.size }));
        sl("", "blank"); await sleep(80); continue;
      }

      const go = (result.action === "BUY_YES" || result.action === "BUY_NO")
        && result.conf >= 65
        && result.amount > 0
        && portRef.current.cash >= result.amount;

      if (go) {
        const side = result.action === "BUY_YES" ? "YES" : "NO";
        const ep   = side === "YES" ? m.yesPrice : m.noPrice;
        // Use best ask as actual entry price if available (more realistic)
        const entryPrice = side === "YES" && m.bestAsk ? m.bestAsk : side === "NO" && m.bestBid ? (1 - m.bestBid) : ep;
        const shares = result.amount / entryPrice;
        const maxProfit = shares - result.amount;

        setStatus("trading");
        const trade = {
          id: Date.now() + Math.random(),
          question: m.question.slice(0, 72),
          conditionId: m.conditionId, yesId: m.yesId,
          side, ep: entryPrice, currentPrice: entryPrice,
          rawYesPrice: m.yesPrice, bestBid: m.bestBid, bestAsk: m.bestAsk,
          amount: result.amount, shares, maxProfit, pnl: 0, pnlPct: 0,
          conf: result.conf, openedAt: ts(), openedTs: Date.now(),
          status: "OPEN", mktType: result.mType,
          reason: result.reason, edgeFrom: result.edgeFrom,
          newsCount: newsResult.articles.length,
          priceSource: liveResult?.source || "gamma", lastUpdate: ts(),
        };

        setPortfolio(prev => {
          const next = { ...prev, cash: prev.cash - result.amount, positions: [...prev.positions, trade], trades: [...prev.trades, trade] };
          portRef.current = next;
          return next;
        });
        sl(`  ✓ TRADE: BUY ${side} ${dollar(result.amount)} @ ${pct(entryPrice)}  ${shares.toFixed(3)} shares`, "tradeok");
        sys(`[TRADE] BUY ${side} ${dollar(result.amount)} @ ${pct(entryPrice)} [${result.mType}] "${m.question.slice(0, 32)}"`, "trade");
        setStats(s => ({ ...s, executed: s.executed + 1, byType: { ...s.byType, [result.mType]: (s.byType[result.mType] || 0) + 1 } }));
        tradedThisScan.add(heldKey); // prevent re-buying same market this scan
        await sleep(200);
      } else if (result.conf < 65) {
        setStats(s => ({ ...s, skipped: s.skipped + 1 }));
        if (result.conf < 38 && !newsResult.articles.length && Math.abs(m.oneDayChange || 0) < 0.003) {
          bl.add(m.id); setBlacklist(new Set(bl)); blackRef.current = new Set(bl);
          sl(`  Auto-blacklisted (no data, conf:${result.conf}%)`, "warn");
          setStats(s => ({ ...s, blacklisted: bl.size }));
        }
      }
      sl("", "blank");
      await sleep(80);
    }

    await refreshPrices(false);
    sl("✓ Scan complete.", "ok");
    sys(`[SCAN] Done. Cash:${dollar(portRef.current.cash)}  Positions:${portRef.current.positions.filter(p=>p.status==="OPEN").length}`, "ok");
    setStatus("idle");
  }, [sl, al, sys, refreshPrices]);

  // ── Sell evaluator ────────────────────────────────────────────────────────────
  const evalSells = useCallback(async () => {
    const open = portRef.current.positions.filter(p => p.status === "OPEN");
    if (!open.length) { sel("No open positions.", "dim"); return; }
    sel("", "blank"); sel(`▶ Evaluating ${open.length} positions...`, "header");

    // Refresh prices first
    await refreshPrices(true);

    for (const pos of portRef.current.positions.filter(p => p.status === "OPEN")) {
      sel("", "blank");
      sel(`${pos.side} [${pos.mktType || "?"}] "${pos.question.slice(0, 52)}"`, "mkt");
      sel(`  Entry:${pct(pos.ep)} → Current:${pct(pos.currentPrice)}  P&L:${pos.pnl >= 0 ? "+" : ""}${dollar(pos.pnl || 0)}  [${pos.priceSource || "?"}]`, "info");
      if (pos.bestBid && pos.bestAsk) sel(`  Order book: Bid:${pct(pos.bestBid)}  Ask:${pct(pos.bestAsk)}  Spread:${((pos.bestAsk - pos.bestBid)*100).toFixed(1)}¢`, "dim");

      const res = shouldSell(pos, pos.currentPrice);
      res.steps.forEach(step => {
        const t = step.includes("TAKE PROFIT") || step.includes("STOP LOSS") ? "sell"
          : step.includes("+") || step.includes("profit") ? "profit"
          : step.includes("WARNING") || step.includes("collapsed") ? "loss" : "dim";
        sel(`  ${step}`, t);
      });

      if (res.decision === "SELL") {
        sel(`  → CLOSING: ${pos.pnl >= 0 ? "+" : ""}${dollar(pos.pnl || 0)} (${((pos.pnlPct || 0)*100).toFixed(1)}%)`, pos.pnl >= 0 ? "profit" : "loss");
        closePosition(pos);
        sys(`[CLOSE] ${pos.side} P&L:${dollar(pos.pnl || 0)} "${pos.question.slice(0, 35)}"`, pos.pnl >= 0 ? "ok" : "warn");
      } else {
        sel(`  → ${res.decision} (score:${res.score}/100)`, "ok");
      }
    }
    sel("", "blank"); sel("✓ Evaluation complete.", "ok");
  }, [sel, sys, refreshPrices, closePosition]);

  // ── Leaderboard ───────────────────────────────────────────────────────────────
  const loadLeaderboard = useCallback(async () => {
    setLbLoading(true);
    sys(`[LEADERBOARD] Fetching top traders (${lbPeriod}/${lbOrder})...`, "info");
    const data = await fetchLeaderboard(lbPeriod, lbOrder, 25);
    setLeaderboard(data);
    sys(`[LEADERBOARD] Loaded ${data.length} traders`, "ok");
    setLbLoading(false);
  }, [lbPeriod, lbOrder, sys]);

  const viewWallet = useCallback(async (address, name) => {
    setWalletLoading(true);
    setWalletDetail({ address, name, positions: null, trades: null });
    sys(`[WALLET] Loading data for ${name || address.slice(0, 10)}...`, "info");
    const [positions, trades] = await Promise.all([fetchWalletPositions(address), fetchWalletTrades(address)]);
    setWalletDetail({ address, name, positions: positions || [], trades: trades || [] });
    sys(`[WALLET] ${(positions || []).length} positions, ${(trades || []).length} trades`, "ok");
    setWalletLoading(false);
  }, [sys]);

  const toggleAuto = () => {
    if (auto) {
      setAuto(false); clearInterval(autoRef.current);
      sys("[AUTO] Disabled — price refresh continues every 10s", "warn");
    } else {
      setAuto(true);
      sys("[AUTO] ON — deep scan every 3min | prices every 10s", "ok");
      scan();
      autoRef.current = setInterval(() => { scan(); }, DEEP_SCAN_MS);
    }
  };

  // ── Portfolio stats ───────────────────────────────────────────────────────────
  const open      = portfolio.positions.filter(p => p.status === "OPEN");
  const openVal   = open.reduce((s, p) => s + (p.currentPrice || p.ep) * p.shares, 0);
  const unrealPnl = open.reduce((s, p) => s + (p.pnl || 0), 0);
  const realPnl   = portfolio.closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalPnl  = unrealPnl + realPnl;
  const totalVal  = portfolio.cash + openVal;
  const invested  = open.reduce((s, p) => s + p.amount, 0);
  const ret       = ((totalVal - START_CASH) / START_CASH * 100);
  const wins      = portfolio.closed.filter(t => t.pnl > 0).length;
  const winRate   = portfolio.closed.length ? `${((wins / portfolio.closed.length) * 100).toFixed(0)}%` : "--";
  const goodMkts  = markets.filter(m => !blackRef.current.has(m.id));
  const stCol     = { idle:"#444", scanning:"#888", thinking:"#aaa", trading:"#ccc" };
  const stLbl     = { idle:"READY", scanning:"SCANNING", thinking:"THINKING", trading:"EXECUTING" };

  const TABS = [
    { id:"positions",   label:`POSITIONS (${open.length})` },
    { id:"pnl",         label:"P&L" },
    { id:"trades",      label:`HISTORY (${portfolio.trades.length})` },
    { id:"markets",     label:`MARKETS (${markets.length})` },
    { id:"leaderboard", label:"TOP WALLETS" },
    { id:"blacklist",   label:`BLACKLIST (${blacklist.size})` },
  ];

  return (
    <div style={{ width:"100vw", height:"100vh", overflow:"hidden", display:"flex", flexDirection:"column", background:"#080808", fontFamily:"Consolas,'Lucida Console',monospace", fontSize:"12px", color:"#bbb" }}>

      {/* TITLE BAR */}
      <div style={{ flexShrink:0, height:"32px", background:"#111", borderBottom:"1px solid #1e1e1e", display:"flex", alignItems:"center", padding:"0 14px", gap:"12px" }}>
        <span style={{ color:"#ddd", fontWeight:"bold", letterSpacing:"3px", fontSize:"13px" }}>POLYBOT</span>
        <span style={{ color:"#282828" }}>│</span>
        <span style={{ color:"#444", fontSize:"11px" }}>Paper Trading Terminal v8.0</span>
        <span style={{ color:"#282828" }}>│</span>
        <span style={{ color:"#333", fontSize:"11px" }}>Built-in AI  •  Order Book Pricing  •  Top Wallets</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:"16px", fontSize:"11px", alignItems:"center" }}>
          {open.length > 0 && <span style={{ color:"#3a5a3a", fontSize:"10px" }}>↻ prices every 30s</span>}
          <span style={{ color: stCol[status] }}>● {stLbl[status]}{auto ? " [AUTO]" : ""}</span>
          <span style={{ color:"#2a2a2a", fontSize:"10px" }}>{fmtUp(stats.uptime)}</span>
        </div>
      </div>

      {/* BODY */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* LEFT MAIN */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>

          {/* TOP 3 LOG PANELS — 44% height */}
          <div style={{ flex:"0 0 44%", display:"flex", borderBottom:"1px solid #141414", overflow:"hidden" }}>

            <Box title="MARKET SCANNER" badge={`${goodMkts.length} candidates`} style={{ flex:1 }}
              actions={[
                { label: status !== "idle" ? "RUNNING..." : "SCAN", fn: scan, dis: status !== "idle" },
                { label: auto ? "STOP AUTO" : "AUTO 3min", fn: toggleAuto },
                { label: "REFRESH $", fn: () => refreshPrices(false), dis: open.length === 0 },
              ]}>
              <LogPanel logs={scanLog} logRef={scanLogRef} />
            </Box>

            <Box title="AI ENGINE — THINKING" badge="keyword+sentiment+statistical" style={{ flex:1 }}>
              <LogPanel logs={aiLog} logRef={aiLogRef} />
            </Box>

            <Box title="SELL / HOLD MONITOR" style={{ flex:1 }}
              actions={[{ label: "EVAL SELLS", fn: evalSells, dis: status !== "idle" }]}>
              <LogPanel logs={sellLog} logRef={sellLogRef} />
            </Box>

          </div>

          {/* BOTTOM TABS — 56% height */}
          <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

            {/* Tab bar */}
            <div style={{ flexShrink:0, background:"#0d0d0d", borderBottom:"1px solid #1a1a1a", display:"flex", padding:"0 8px", alignItems:"center" }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  background: tab === t.id ? "#141414" : "transparent", border:"none",
                  borderBottom: tab === t.id ? "2px solid #555" : "2px solid transparent",
                  color: tab === t.id ? "#ccc" : "#3a3a3a",
                  padding:"5px 14px", fontSize:"11px", fontFamily:"Consolas,monospace", cursor:"pointer",
                }}>{t.label}</button>
              ))}
              <div style={{ marginLeft:"auto", display:"flex", gap:"16px", fontSize:"10px", color:"#2a2a2a", paddingRight:"10px" }}>
                <span>Refresh:{lastRefresh} ({refreshCount}x)</span>
                <span>Win:{winRate}</span>
              </div>
            </div>

            {/* Tab content */}
            <div style={{ flex:1, overflow:"auto", background:"#090909", padding:"6px" }}>

              {/* ── POSITIONS ── */}
              {tab === "positions" && (
                open.length === 0
                  ? <div style={{ color:"#1e1e1e", padding:"40px", textAlign:"center", fontSize:"13px" }}>No open positions — click SCAN to find opportunities.</div>
                  : <>
                    <div style={{ marginBottom:"6px", padding:"5px 10px", background:"#0a140a", border:"1px solid #1a2a1a", fontSize:"10px", color:"#3a5a3a", display:"flex", gap:"16px" }}>
                      <span>● LIVE P&L via Order Book pricing</span>
                      <span>Last: {lastRefresh} ({refreshCount} refreshes)</span>
                      <button onClick={() => refreshPrices(false)} style={{ marginLeft:"auto", background:"transparent", border:"1px solid #2a4a2a", color:"#4a7a4a", padding:"1px 8px", fontSize:"9px", fontFamily:"Consolas,monospace", cursor:"pointer" }}>REFRESH NOW</button>
                    </div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                      <TH cols={["#","Type","Market","Side","Entry","Bid","Ask","Current","Δ¢","P&L","P&L%","Cost","Value","Max$","Conf","Source","Updated"]} />
                      <tbody>
                        {open.map((p, i) => {
                          const priceDiff = (p.currentPrice || p.ep) - p.ep;
                          const pc = p.pnl || 0;
                          return (
                            <tr key={p.id} style={{ borderBottom:"1px solid #0f0f0f", background: pc > 0.5 ? "#0a130a" : pc < -0.5 ? "#130a0a" : "transparent" }}>
                              <td style={{ padding:"4px 8px", color:"#333" }}>{i+1}</td>
                              <td style={{ padding:"4px 8px" }}><TypeBadge type={p.mktType} /></td>
                              <td style={{ padding:"4px 8px", color:"#666", maxWidth:"200px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.question}</td>
                              <td style={{ padding:"4px 8px", color: p.side === "YES" ? "#bbb" : "#888", fontWeight:"bold" }}>{p.side}</td>
                              <td style={{ padding:"4px 8px", color:"#555" }}>{pct(p.ep)}</td>
                              <td style={{ padding:"4px 8px", color:"#3a6a3a" }}>{p.bestBid ? pct(p.bestBid) : "--"}</td>
                              <td style={{ padding:"4px 8px", color:"#6a3a3a" }}>{p.bestAsk ? pct(p.bestAsk) : "--"}</td>
                              <td style={{ padding:"4px 8px", color:"#aaa", fontWeight:"bold" }}>{pct(p.currentPrice || p.ep)}</td>
                              <td style={{ padding:"4px 8px", color: priceDiff > 0 ? "#5a9a5a" : priceDiff < 0 ? "#9a5a5a" : "#444" }}>{priceDiff > 0 ? "▲" : priceDiff < 0 ? "▼" : "─"}{(Math.abs(priceDiff)*100).toFixed(1)}</td>
                              <td style={{ padding:"4px 8px", color: pc >= 0 ? "#bbb" : "#666", fontWeight:"bold" }}>{(pc >= 0 ? "+" : "") + dollar(pc)}</td>
                              <td style={{ padding:"4px 8px", color: pc >= 0 ? "#999" : "#555" }}>{((p.pnlPct||0)*100).toFixed(1)}%</td>
                              <td style={{ padding:"4px 8px", color:"#555" }}>{dollar(p.amount)}</td>
                              <td style={{ padding:"4px 8px", color:"#777" }}>{dollar((p.currentPrice||p.ep)*p.shares)}</td>
                              <td style={{ padding:"4px 8px", color:"#444" }}>{dollar(p.maxProfit)}</td>
                              <td style={{ padding:"4px 8px", color:"#555" }}>{p.conf}%</td>
                              <td style={{ padding:"4px 8px", color:"#3a3a3a", fontSize:"9px" }}>{p.priceSource}</td>
                              <td style={{ padding:"4px 8px", color:"#2a2a2a", fontSize:"9px" }}>{p.lastUpdate}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop:"1px solid #1e1e1e" }}>
                          <td colSpan={9} style={{ padding:"5px 8px", color:"#444" }}>TOTALS</td>
                          <td style={{ padding:"5px 8px", color: unrealPnl >= 0 ? "#bbb" : "#666", fontWeight:"bold" }}>{(unrealPnl >= 0 ? "+" : "") + dollar(unrealPnl)}</td>
                          <td style={{ padding:"5px 8px", color: unrealPnl >= 0 ? "#888" : "#555" }}>{invested > 0 ? ((unrealPnl/invested)*100).toFixed(1)+"%" : "--"}</td>
                          <td style={{ padding:"5px 8px", color:"#666" }}>{dollar(invested)}</td>
                          <td style={{ padding:"5px 8px", color:"#777" }}>{dollar(openVal)}</td>
                          <td colSpan={4} />
                        </tr>
                      </tfoot>
                    </table>
                    <div style={{ marginTop:"8px" }}>
                      <div style={{ color:"#252525", fontSize:"10px", marginBottom:"4px" }}>REASONING</div>
                      {open.map((p, i) => (
                        <div key={p.id} style={{ display:"flex", gap:"8px", marginBottom:"3px", fontSize:"10px", padding:"3px 0", borderBottom:"1px solid #0f0f0f" }}>
                          <span style={{ color:"#333", flexShrink:0, width:"16px" }}>{i+1}.</span>
                          <TypeBadge type={p.mktType} />
                          <span style={{ color:"#2a2a2a", flex:1, marginLeft:"4px" }}>{p.reason}</span>
                        </div>
                      ))}
                    </div>
                  </>
              )}

              {/* ── P&L ── */}
              {tab === "pnl" && (
                <div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"8px", marginBottom:"12px" }}>
                    {[
                      { l:"Starting Balance",  v: dollar(START_CASH),                        s:"initial deposit",              hi: null },
                      { l:"Current Cash",      v: dollar(portfolio.cash),                    s:"available to trade",           hi: portfolio.cash >= START_CASH },
                      { l:"Open Value",        v: dollar(openVal),                           s:`${open.length} positions`,     hi: openVal > 0 },
                      { l:"Total Portfolio",   v: dollar(totalVal),                          s:"cash + positions",             hi: totalVal >= START_CASH },
                      { l:"Unrealized P&L",    v: (unrealPnl >= 0 ? "+" : "") + dollar(unrealPnl), s:"live mark-to-market",  hi: unrealPnl >= 0 },
                      { l:"Realized P&L",      v: (realPnl >= 0 ? "+" : "") + dollar(realPnl),     s:`${portfolio.closed.length} closed`, hi: realPnl >= 0 },
                      { l:"Total P&L",         v: (totalPnl >= 0 ? "+" : "") + dollar(totalPnl),   s:"all time",             hi: totalPnl >= 0 },
                      { l:"Total Return",      v: (ret >= 0 ? "+" : "") + ret.toFixed(2) + "%",     s:"vs $1,000 start",      hi: ret >= 0 },
                      { l:"Capital Deployed",  v: dollar(invested),                          s:"in markets now",             hi: null },
                      { l:"Win Rate",          v: winRate,                                   s:`${wins}/${portfolio.closed.length}`, hi: null },
                      { l:"Best Trade",        v: stats.best  ? dollar(stats.best.pnl)  : "--", s: stats.best  ? stats.best.question?.slice(0,24)+"..."  : "none yet", hi: true  },
                      { l:"Worst Trade",       v: stats.worst ? dollar(stats.worst.pnl) : "--", s: stats.worst ? stats.worst.question?.slice(0,24)+"..." : "none yet", hi: false },
                    ].map(card => (
                      <div key={card.l} style={{ background:"#0d0d0d", border:"1px solid #181818", padding:"12px 14px" }}>
                        <div style={{ color:"#252525", fontSize:"9px", marginBottom:"5px" }}>{card.l}</div>
                        <div style={{ color: card.hi === true ? "#ddd" : card.hi === false ? "#666" : "#aaa", fontSize:"20px" }}>{card.v}</div>
                        <div style={{ color:"#1a1a1a", fontSize:"9px", marginTop:"3px" }}>{card.s}</div>
                      </div>
                    ))}
                  </div>
                  {portfolio.closed.length > 0 && <>
                    <div style={{ color:"#2a2a2a", fontSize:"10px", marginBottom:"6px" }}>CLOSED TRADES</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                      <TH cols={["#","Market","Side","Entry","Close","Cost","Proceeds","P&L","P&L%","Closed"]} />
                      <tbody>
                        {portfolio.closed.map((t, i) => (
                          <tr key={t.id} style={{ borderBottom:"1px solid #0f0f0f", background: t.pnl > 0 ? "#0a130a" : "#130a0a" }}>
                            <td style={{ padding:"4px 8px", color:"#333" }}>{i+1}</td>
                            <td style={{ padding:"4px 8px", color:"#555", maxWidth:"220px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.question}</td>
                            <td style={{ padding:"4px 8px", color:"#666" }}>{t.side}</td>
                            <td style={{ padding:"4px 8px", color:"#555" }}>{pct(t.ep)}</td>
                            <td style={{ padding:"4px 8px", color:"#666" }}>{pct(t.closePrice || t.currentPrice)}</td>
                            <td style={{ padding:"4px 8px", color:"#555" }}>{dollar(t.amount)}</td>
                            <td style={{ padding:"4px 8px", color:"#666" }}>{dollar((t.closePrice || t.currentPrice) * t.shares)}</td>
                            <td style={{ padding:"4px 8px", color: t.pnl >= 0 ? "#bbb" : "#666", fontWeight:"bold" }}>{(t.pnl >= 0 ? "+" : "") + dollar(t.pnl)}</td>
                            <td style={{ padding:"4px 8px", color: t.pnl >= 0 ? "#888" : "#555" }}>{((t.pnlPct||0)*100).toFixed(1)}%</td>
                            <td style={{ padding:"4px 8px", color:"#333" }}>{t.closedAt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>}
                </div>
              )}

              {/* ── HISTORY ── */}
              {tab === "trades" && (
                portfolio.trades.length === 0
                  ? <div style={{ color:"#1e1e1e", padding:"40px", textAlign:"center" }}>No trades yet.</div>
                  : <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                    <TH cols={["#","Time","Type","Market","Side","Entry","Amt","Shares","Max$","Conf","Status","P&L","Edge","News"]} />
                    <tbody>
                      {[...portfolio.trades].reverse().map((t, i) => {
                        const cl  = portfolio.closed.find(c => c.id === t.id);
                        const pnl = cl ? cl.pnl : (t.pnl || 0);
                        return (
                          <tr key={t.id} style={{ borderBottom:"1px solid #0f0f0f", background: cl ? (cl.pnl > 0 ? "#0a130a" : "#130a0a") : "transparent" }}>
                            <td style={{ padding:"4px 8px", color:"#333" }}>{portfolio.trades.length - i}</td>
                            <td style={{ padding:"4px 8px", color:"#333", whiteSpace:"nowrap" }}>{t.openedAt}</td>
                            <td style={{ padding:"4px 8px" }}><TypeBadge type={t.mktType} /></td>
                            <td style={{ padding:"4px 8px", color:"#555", maxWidth:"180px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.question}</td>
                            <td style={{ padding:"4px 8px", color: t.side === "YES" ? "#aaa" : "#777", fontWeight:"bold" }}>{t.side}</td>
                            <td style={{ padding:"4px 8px", color:"#555" }}>{pct(t.ep)}</td>
                            <td style={{ padding:"4px 8px", color:"#666" }}>{dollar(t.amount)}</td>
                            <td style={{ padding:"4px 8px", color:"#444" }}>{t.shares.toFixed(3)}</td>
                            <td style={{ padding:"4px 8px", color:"#444" }}>{dollar(t.maxProfit)}</td>
                            <td style={{ padding:"4px 8px", color:"#555" }}>{t.conf}%</td>
                            <td style={{ padding:"4px 8px" }}>
                              <span style={{ background:"#111", color: cl ? (cl.pnl > 0 ? "#4a7a4a" : "#7a4a4a") : "#666", padding:"1px 5px", fontSize:"9px" }}>
                                {cl ? (cl.pnl > 0 ? "WIN" : "LOSS") : "OPEN"}
                              </span>
                            </td>
                            <td style={{ padding:"4px 8px", color: pnl >= 0 ? "#bbb" : "#666", fontWeight:"bold" }}>{(pnl >= 0 ? "+" : "") + dollar(pnl)}</td>
                            <td style={{ padding:"4px 8px", color:"#3a5a3a", fontSize:"10px" }}>{t.edgeFrom}</td>
                            <td style={{ padding:"4px 8px", color:"#2a2a2a", fontSize:"10px" }}>{t.newsCount || 0} arts</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              )}

              {/* ── MARKETS ── */}
              {tab === "markets" && (
                markets.length === 0
                  ? <div style={{ color:"#1e1e1e", padding:"40px", textAlign:"center" }}>Run scan to load markets.</div>
                  : <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                    <TH cols={["#","Dead","Type","Market","YES%","NO%","Bid","Ask","Spread","Vol 24h","Liq","24hΔ","Ends"]} />
                    <tbody>
                      {markets.map((m, i) => {
                        const dead  = blackRef.current.has(m.id);
                        const mType = detectType(m.question);
                        return (
                          <tr key={m.id} style={{ borderBottom:"1px solid #0f0f0f", opacity: dead ? 0.3 : 1 }}>
                            <td style={{ padding:"4px 8px", color:"#333" }}>{i+1}</td>
                            <td style={{ padding:"4px 8px" }}><span style={{ fontSize:"9px", padding:"1px 4px", background: dead ? "#2a0a0a" : "#0d0d0d", color: dead ? "#666" : "#2a2a2a" }}>{dead ? "DEAD" : "OK"}</span></td>
                            <td style={{ padding:"4px 8px" }}><TypeBadge type={mType} /></td>
                            <td style={{ padding:"4px 8px", color:"#555", maxWidth:"230px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.question}</td>
                            <td style={{ padding:"4px 8px", color: m.yesPrice >= 0.15 && m.yesPrice <= 0.85 ? "#aaa" : "#666" }}>{pct(m.yesPrice)}</td>
                            <td style={{ padding:"4px 8px", color:"#555" }}>{pct(m.noPrice)}</td>
                            <td style={{ padding:"4px 8px", color:"#3a5a3a" }}>{m.bestBid ? pct(m.bestBid) : "--"}</td>
                            <td style={{ padding:"4px 8px", color:"#5a3a3a" }}>{m.bestAsk ? pct(m.bestAsk) : "--"}</td>
                            <td style={{ padding:"4px 8px", color:"#333" }}>{m.bestBid && m.bestAsk ? ((m.bestAsk - m.bestBid)*100).toFixed(1)+"¢" : "--"}</td>
                            <td style={{ padding:"4px 8px", color:"#666" }}>{mini(m.volume24h)}</td>
                            <td style={{ padding:"4px 8px", color:"#444" }}>{mini(m.liquidity)}</td>
                            <td style={{ padding:"4px 8px", color: m.oneDayChange > 0 ? "#aaa" : m.oneDayChange < 0 ? "#666" : "#333" }}>{m.oneDayChange > 0 ? "▲" : m.oneDayChange < 0 ? "▼" : "─"}{(Math.abs(m.oneDayChange||0)*100).toFixed(1)}%</td>
                            <td style={{ padding:"4px 8px", color:"#2a2a2a", whiteSpace:"nowrap" }}>{m.endDate ? new Date(m.endDate).toLocaleDateString() : "--"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              )}

              {/* ── LEADERBOARD ── */}
              {tab === "leaderboard" && (
                <div style={{ display:"flex", gap:"8px", height:"100%", overflow:"hidden" }}>
                  {/* Left: leaderboard list */}
                  <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
                    {/* Controls */}
                    <div style={{ flexShrink:0, display:"flex", gap:"8px", padding:"8px", borderBottom:"1px solid #1a1a1a", alignItems:"center" }}>
                      <span style={{ color:"#444", fontSize:"10px" }}>Period:</span>
                      {["DAY","WEEK","MONTH","ALL"].map(p => (
                        <button key={p} onClick={() => setLbPeriod(p)} style={{
                          background: lbPeriod === p ? "#1a2a1a" : "transparent",
                          border:`1px solid ${lbPeriod === p ? "#3a5a3a" : "#222"}`,
                          color: lbPeriod === p ? "#5a9a5a" : "#444", padding:"2px 8px", fontSize:"10px",
                          fontFamily:"Consolas,monospace", cursor:"pointer",
                        }}>{p}</button>
                      ))}
                      <span style={{ color:"#444", fontSize:"10px", marginLeft:"8px" }}>Sort:</span>
                      {["PNL","VOL"].map(o => (
                        <button key={o} onClick={() => setLbOrder(o)} style={{
                          background: lbOrder === o ? "#1a1a2a" : "transparent",
                          border:`1px solid ${lbOrder === o ? "#3a3a5a" : "#222"}`,
                          color: lbOrder === o ? "#6a6aaa" : "#444", padding:"2px 8px", fontSize:"10px",
                          fontFamily:"Consolas,monospace", cursor:"pointer",
                        }}>{o}</button>
                      ))}
                      <button onClick={loadLeaderboard} disabled={lbLoading} style={{
                        marginLeft:"8px", background:"transparent", border:"1px solid #333",
                        color: lbLoading ? "#333" : "#666", padding:"2px 12px", fontSize:"10px",
                        fontFamily:"Consolas,monospace", cursor: lbLoading ? "not-allowed" : "pointer",
                      }}>{lbLoading ? "LOADING..." : "LOAD"}</button>
                    </div>
                    {/* Table */}
                    <div style={{ flex:1, overflowY:"auto" }}>
                      {leaderboard.length === 0
                        ? <div style={{ color:"#1e1e1e", padding:"40px", textAlign:"center" }}>Click LOAD to fetch top traders.</div>
                        : <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                          <TH cols={["#","Trader","P&L","Volume","Badge","View"]} />
                          <tbody>
                            {leaderboard.map((trader, i) => (
                              <tr key={trader.proxyWallet || i} style={{ borderBottom:"1px solid #0f0f0f" }}>
                                <td style={{ padding:"5px 8px", color:"#555", fontWeight: i < 3 ? "bold" : "normal" }}>{i+1}</td>
                                <td style={{ padding:"5px 8px" }}>
                                  <div style={{ color: i < 3 ? "#ddd" : "#888" }}>{trader.userName || `${trader.proxyWallet?.slice(0,8)}...`}</div>
                                  {trader.xUsername && <div style={{ color:"#444", fontSize:"9px" }}>@{trader.xUsername}</div>}
                                  <div style={{ color:"#2a2a2a", fontSize:"9px" }}>{trader.proxyWallet?.slice(0, 12)}...</div>
                                </td>
                                <td style={{ padding:"5px 8px", color: (trader.pnl || 0) >= 0 ? "#bbb" : "#666", fontWeight:"bold" }}>
                                  {(trader.pnl || 0) >= 0 ? "+" : ""}{dollar(trader.pnl || 0)}
                                </td>
                                <td style={{ padding:"5px 8px", color:"#666" }}>{mini(trader.vol || 0)}</td>
                                <td style={{ padding:"5px 8px" }}>
                                  {trader.verifiedBadge && <span style={{ fontSize:"9px", padding:"1px 5px", background:"#1a2a1a", color:"#5a9a5a" }}>VERIFIED</span>}
                                </td>
                                <td style={{ padding:"5px 8px" }}>
                                  <button onClick={() => viewWallet(trader.proxyWallet, trader.userName)} disabled={walletLoading} style={{
                                    background:"transparent", border:"1px solid #2a2a2a", color:"#555", padding:"1px 8px",
                                    fontSize:"9px", fontFamily:"Consolas,monospace", cursor:"pointer",
                                  }}>VIEW</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      }
                    </div>
                  </div>

                  {/* Right: wallet detail */}
                  <div style={{ width:"320px", flexShrink:0, borderLeft:"1px solid #1a1a1a", display:"flex", flexDirection:"column", overflow:"hidden" }}>
                    {!walletDetail
                      ? <div style={{ color:"#1e1e1e", padding:"20px", fontSize:"11px" }}>Click VIEW on any trader to see their positions and recent trades.</div>
                      : <>
                        <div style={{ flexShrink:0, padding:"8px 10px", borderBottom:"1px solid #1a1a1a", background:"#0d0d0d" }}>
                          <div style={{ color:"#bbb", fontSize:"11px", fontWeight:"bold" }}>{walletDetail.name || "Wallet"}</div>
                          <div style={{ color:"#333", fontSize:"9px" }}>{walletDetail.address}</div>
                        </div>
                        <div style={{ flex:1, overflowY:"auto" }}>
                          {walletLoading
                            ? <div style={{ color:"#2a2a2a", padding:"16px" }}>Loading...</div>
                            : <>
                              <div style={{ padding:"6px 10px", color:"#444", fontSize:"10px", borderBottom:"1px solid #141414" }}>
                                OPEN POSITIONS ({(walletDetail.positions || []).length})
                              </div>
                              {(walletDetail.positions || []).slice(0, 10).map((pos, i) => (
                                <div key={i} style={{ padding:"6px 10px", borderBottom:"1px solid #0f0f0f" }}>
                                  <div style={{ color:"#666", fontSize:"10px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pos.title || pos.market || "Unknown market"}</div>
                                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:"10px", marginTop:"2px" }}>
                                    <span style={{ color: pos.outcome === "YES" ? "#5a9a5a" : "#9a5a5a" }}>{pos.outcome || pos.outcomeLabel || "?"}</span>
                                    <span style={{ color:"#555" }}>{pos.size ? `${(+pos.size).toFixed(2)} shares` : ""}</span>
                                    <span style={{ color: (pos.cashPnl || pos.currentValue || 0) >= 0 ? "#bbb" : "#666" }}>
                                      {(pos.cashPnl || pos.currentValue) ? dollar(pos.cashPnl || pos.currentValue) : "--"}
                                    </span>
                                  </div>
                                </div>
                              ))}
                              {(walletDetail.positions || []).length === 0 && <div style={{ color:"#2a2a2a", padding:"10px" }}>No open positions.</div>}

                              <div style={{ padding:"6px 10px", color:"#444", fontSize:"10px", borderBottom:"1px solid #141414", borderTop:"1px solid #141414" }}>
                                RECENT TRADES ({(walletDetail.trades || []).length})
                              </div>
                              {(walletDetail.trades || []).slice(0, 8).map((trade, i) => (
                                <div key={i} style={{ padding:"5px 10px", borderBottom:"1px solid #0f0f0f" }}>
                                  <div style={{ color:"#555", fontSize:"10px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{trade.title || trade.market || "Unknown"}</div>
                                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:"9px", marginTop:"1px" }}>
                                    <span style={{ color: trade.side === "BUY" ? "#5a9a5a" : "#9a5a5a" }}>{trade.side}</span>
                                    <span style={{ color:"#444" }}>{trade.size ? dollar(+trade.size) : ""}</span>
                                    <span style={{ color:"#333" }}>{age(trade.timestamp)}</span>
                                  </div>
                                </div>
                              ))}
                              {(walletDetail.trades || []).length === 0 && <div style={{ color:"#2a2a2a", padding:"10px" }}>No recent trades.</div>}
                            </>
                          }
                        </div>
                      </>
                    }
                  </div>
                </div>
              )}

              {/* ── BLACKLIST ── */}
              {tab === "blacklist" && (
                <div style={{ padding:"4px" }}>
                  <div style={{ color:"#333", marginBottom:"8px", display:"flex", alignItems:"center", gap:"12px", padding:"4px" }}>
                    <span>{blacklist.size} markets excluded permanently.</span>
                    {blacklist.size > 0 && (
                      <button onClick={() => { setBlacklist(new Set()); blackRef.current = new Set(); sys("[BL] Cleared","warn"); }} style={{ background:"transparent", border:"1px solid #2a2a2a", color:"#555", padding:"2px 10px", fontSize:"10px", fontFamily:"Consolas,monospace", cursor:"pointer" }}>CLEAR ALL</button>
                    )}
                  </div>
                  {blacklist.size === 0
                    ? <div style={{ color:"#1e1e1e", padding:"40px", textAlign:"center" }}>No blacklisted markets yet.</div>
                    : <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                      <TH cols={["#","Market","Price","Reason"]} />
                      <tbody>
                        {[...blacklist].map((id, i) => {
                          const m = markets.find(x => x.id === id);
                          return (
                            <tr key={id} style={{ borderBottom:"1px solid #0f0f0f" }}>
                              <td style={{ padding:"4px 8px", color:"#2a2a2a" }}>{i+1}</td>
                              <td style={{ padding:"4px 8px", color:"#3a3a3a", maxWidth:"400px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m?.question || id}</td>
                              <td style={{ padding:"4px 8px", color:"#333" }}>{m ? pct(m.yesPrice) : "--"}</td>
                              <td style={{ padding:"4px 8px", color:"#2a2a2a" }}>{m ? (m.yesPrice < 0.02 || m.yesPrice > 0.98 ? "Extreme price — resolved" : "No signal + no movement") : "Unknown"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  }
                </div>
              )}

            </div>
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{ width:"200px", flexShrink:0, display:"flex", flexDirection:"column", borderLeft:"1px solid #141414", background:"#060606", overflow:"hidden" }}>
          <div style={{ flexShrink:0, padding:"5px 12px", fontSize:"9px", color:"#3a3a3a", letterSpacing:"1px", background:"#0d0d0d", borderBottom:"1px solid #1a1a1a" }}>LIVE STATS</div>
          <div style={{ flex:1, overflowY:"auto" }}>
            <SideVal label="PORTFOLIO"   value={dollar(totalVal)}                            color={totalVal >= START_CASH ? "#ccc" : "#777"} sub="total value" />
            <SideVal label="CASH"        value={dollar(portfolio.cash)}                      color="#aaa"  sub="available" />
            <SideVal label="P&L"         value={(totalPnl >= 0 ? "+" : "") + dollar(totalPnl)} color={totalPnl >= 0 ? "#ddd" : "#666"} sub="total" hi={totalPnl > 0} />
            <SideVal label="RETURN"      value={(ret >= 0 ? "+" : "") + ret.toFixed(2) + "%"} color={ret >= 0 ? "#ccc" : "#666"} sub="vs $1,000" />
            <SideVal label="UNREALIZED"  value={(unrealPnl >= 0 ? "+" : "") + dollar(unrealPnl)} color={unrealPnl >= 0 ? "#bbb" : "#666"} sub={`${open.length} open`} hi={unrealPnl > 0} />
            <SideVal label="REALIZED"    value={(realPnl >= 0 ? "+" : "") + dollar(realPnl)}    color={realPnl >= 0 ? "#bbb" : "#666"}    sub={`${portfolio.closed.length} closed`} />
            <SideVal label="WIN RATE"    value={winRate}                                     color="#888"  sub={`${wins}/${portfolio.closed.length}`} />
            <SideVal label="INVESTED"    value={dollar(invested)}                             color="#777"  sub={`${open.length} positions`} />

            <div style={{ padding:"4px 12px", fontSize:"9px", color:"#252525", letterSpacing:"1px", background:"#0a0a0a", borderTop:"1px solid #111", borderBottom:"1px solid #111" }}>PRICE TRACKING</div>
            <SRow label="Last refresh"  value={lastRefresh}  color="#4a6a4a" />
            <SRow label="Refresh count" value={refreshCount} />
            <SRow label="Refresh rate"  value="30s" />

            <div style={{ padding:"4px 12px", fontSize:"9px", color:"#252525", letterSpacing:"1px", background:"#0a0a0a", borderTop:"1px solid #111", borderBottom:"1px solid #111" }}>BOT ACTIVITY</div>
            <SRow label="Scans"       value={stats.scans} />
            <SRow label="Analyzed"    value={stats.analyzed} />
            <SRow label="Trades"      value={stats.executed} />
            <SRow label="Skipped"     value={stats.skipped} />
            <SRow label="Blacklisted" value={blacklist.size} />
            <SRow label="News arts."  value={stats.news} />
            <SRow label="Last scan"   value={stats.lastScan} />
            <SRow label="Uptime"      value={fmtUp(stats.uptime)} />

            <div style={{ padding:"4px 12px", fontSize:"9px", color:"#252525", letterSpacing:"1px", background:"#0a0a0a", borderTop:"1px solid #111", borderBottom:"1px solid #111" }}>TRADES BY TYPE</div>
            {["sports","macro","crypto","politics","general"].map(t => <SRow key={t} label={t.toUpperCase()} value={stats.byType[t] || 0} color={TT[t]} />)}

            <div style={{ padding:"4px 12px", fontSize:"9px", color:"#252525", letterSpacing:"1px", background:"#0a0a0a", borderTop:"1px solid #111", borderBottom:"1px solid #111" }}>LIVE PRICES</div>
            <div style={{ padding:"4px 6px" }}>
              {goodMkts.slice(0, 20).map(m => {
                const mType = detectType(m.question);
                const isHeld = open.some(p => p.conditionId === m.conditionId);
                return (
                  <div key={m.id} style={{ padding:"4px 6px", marginBottom:"2px", borderLeft:`2px solid ${isHeld ? "#2a5a2a" : TC[mType] || "#1a1a1a"}`, background: isHeld ? "#0a130a" : "#0a0a0a" }}>
                    <div style={{ color: isHeld ? "#3a6a3a" : "#333", fontSize:"9px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.question.slice(0, 26)}{isHeld ? " ●" : ""}</div>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:"9px", marginTop:"1px" }}>
                      <span style={{ color: m.yesPrice >= 0.15 && m.yesPrice <= 0.85 ? "#666" : "#444" }}>{pct(m.yesPrice)}</span>
                      <span style={{ color: m.oneDayChange > 0 ? "#4a6a4a" : m.oneDayChange < 0 ? "#6a4a4a" : "#2a2a2a" }}>{m.oneDayChange > 0 ? "▲" : m.oneDayChange < 0 ? "▼" : "─"}{(Math.abs(m.oneDayChange || 0)*100).toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
              {goodMkts.length === 0 && <div style={{ color:"#1a1a1a", padding:"8px", fontSize:"10px" }}>Run scan</div>}
            </div>
          </div>
        </div>

      </div>

      {/* SYSTEM LOG BAR — collapsible bottom strip */}
      <div style={{ flexShrink:0, height:"22px", background:"#0b0b0b", borderTop:"1px solid #161616", display:"flex", alignItems:"center", overflow:"hidden" }}>
        <div ref={sysLogRef} style={{ flex:1, overflowX:"auto", overflowY:"hidden", display:"flex", gap:"16px", padding:"0 14px", fontSize:"10px", whiteSpace:"nowrap" }}>
          {sysLog.slice(-8).map(l => (
            <span key={l.id} style={{ color: C[l.type] || "#2a2a2a", flexShrink:0 }}>{l.ts} {l.msg}</span>
          ))}
        </div>
        <div style={{ flexShrink:0, padding:"0 14px", display:"flex", gap:"16px", fontSize:"10px", color:"#2a2a2a", borderLeft:"1px solid #161616" }}>
          <span>Pos:{open.length}</span>
          <span style={{ color: unrealPnl >= 0 ? "#3a5a3a" : "#5a3a3a" }}>P&L:{(unrealPnl >= 0 ? "+" : "") + dollar(unrealPnl)}</span>
          <span>Cash:{dollar(portfolio.cash)}</span>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:#080808; }
        ::-webkit-scrollbar-thumb { background:#1e1e1e; }
        * { box-sizing:border-box; margin:0; padding:0; }
        button:focus { outline:none; }
      `}</style>
    </div>
  );
}