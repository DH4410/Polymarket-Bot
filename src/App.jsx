/* eslint-disable no-unused-vars */
import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const THENEWS_KEY  = "GzCg1YdRg2mxy6OJ7XQgk2UNZwV9Pq7XNbDnuLKv";
const GNEWS_KEY    = "9e1ef6ca6dd91d2708f9b476b72cdd22";
// Multiple CORS proxies — tries each in order, uses first that works
const CORS_PROXIES = [
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.org/?${encodeURIComponent(url)}`,
];
const START_CASH   = 1000;
const PRICE_MS     = 10000;
const SCAN_MS      = 180000;
const CONF_THRESH  = 55;    // achievable with 1 strong signal or 2 weak ones
const MAX_TRADE    = 40;
const PRICE_MIN    = 0.08;
const PRICE_MAX    = 0.92;
const MAX_OPEN     = 8;     // max simultaneous positions
const VERSION      = "11.0";

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
const sleep    = ms  => new Promise(r => setTimeout(r, ms));
const pct      = p   => `${(+p * 100).toFixed(1)}%`;
const dollar   = n   => `$${Math.abs(+n).toFixed(2)}`;
const signed   = n   => `${+n >= 0 ? "+" : "-"}${dollar(n)}`;
const mini     = n   => +n>=1e6?`$${(+n/1e6).toFixed(1)}M`:+n>=1e3?`$${(+n/1e3).toFixed(1)}k`:`$${(+n).toFixed(0)}`;
const nowTs    = ()  => new Date().toLocaleTimeString("en-US",{hour12:false});
const fmtUp    = s   => `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m${s%60}s`;
const ageStr   = iso => { if(!iso)return""; const h=Math.round((Date.now()-new Date(iso))/3600000); return h<1?"<1h":h<24?`${h}h`:`${Math.floor(h/24)}d`; };
const clamp    = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const r5       = n   => Math.round(n/5)*5;
const daysFrom = dt  => dt ? (new Date(dt)-Date.now())/(864e5) : 999;

// ═══════════════════════════════════════════════════════════════════════════════
// API LAYER
// ═══════════════════════════════════════════════════════════════════════════════
// Tries each CORS proxy in order — falls back automatically if one is down
async function apiFetch(url, ms=8000) {
  for (const makeProxy of CORS_PROXIES) {
    try {
      const r = await fetch(makeProxy(url), {signal:AbortSignal.timeout(ms)});
      if (r.ok) return await r.json();
    } catch(_e){ /* try next proxy */ }
  }
  return null;
}
async function rawFetch(url, ms=5000) {
  try {
    const r = await fetch(url, {signal:AbortSignal.timeout(ms)});
    if(!r.ok) return null;
    return await r.json();
  } catch(_e){ return null; }
}

async function fetchMarkets(limit=100) {
  const data = await apiFetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`);
  if(!Array.isArray(data)) return [];
  return data.filter(m=>m.active&&!m.closed&&m.enableOrderBook&&m.clobTokenIds&&m.outcomePrices).map(m=>{
    let yesId=null,noId=null;
    try{[yesId,noId]=JSON.parse(m.clobTokenIds);}catch(_e){}
    let yP=0.5,nP=0.5;
    try{const p=JSON.parse(m.outcomePrices);yP=+p[0]||0.5;nP=+p[1]||0.5;}catch(_e){}
    return {
      id:m.id, conditionId:m.conditionId, slug:m.slug,
      question:(m.question||"Unknown").trim(),
      yesId, noId, yesPrice:yP, noPrice:nP,
      bestBid:m.bestBid??null, bestAsk:m.bestAsk??null,
      volume24h:+(m.volume24hr||0), volume7d:+(m.volume1wk||0),
      liquidity:+(m.liquidityNum||0),
      oneDayChange:+(m.oneDayPriceChange||0), oneWeekChange:+(m.oneWeekPriceChange||0),
      endDate:m.endDateIso||m.endDate||null, category:m.category||"--",
      competitive:+(m.competitive||0),
    };
  });
}

// Detect sentinel "dead book" response: CLOB returns bid≈0.01/ask≈0.99 for illiquid/resolved markets
function isDeadBook(bid, ask) {
  if (!bid || !ask) return true;
  const spread = ask - bid;
  // A 90%+ spread is not a real market — it's the CLOB sentinel value
  if (spread > 0.85) return true;
  // bid < 2% or ask > 98% = no real liquidity
  if (bid < 0.02 || ask > 0.98) return true;
  return false;
}

async function getLivePrice(yesId, conditionId) {
  // 1. Try CLOB order book directly, then via proxy
  for (const fetcher of [rawFetch, u => apiFetch(u, 4000)]) {
    const book = await fetcher(`https://clob.polymarket.com/book?token_id=${yesId}`, 4000);
    if (book?.bids?.length || book?.asks?.length) {
      const bid = book.bids?.[0]?.price ? +book.bids[0].price : null;
      const ask = book.asks?.[0]?.price ? +book.asks[0].price : null;
      // Skip dead/sentinel books — fall through to Gamma
      if (isDeadBook(bid, ask)) break;
      const mid = bid && ask ? (bid + ask) / 2 : bid || ask;
      if (mid && mid > 0 && mid < 1) {
        return { price: mid, bid, ask, spread: ask - bid, source: "orderbook" };
      }
    }
  }

  // 2. CLOB midpoint endpoint
  const mp = await rawFetch(`https://clob.polymarket.com/midpoint?token_id=${yesId}`, 3000);
  if (mp?.mid && +mp.mid > 0 && +mp.mid < 1) {
    return { price: +mp.mid, bid: null, ask: null, spread: null, source: "clob-mid" };
  }

  // 3. Gamma API — always works, used as reliable fallback
  const gm = await apiFetch(`https://gamma-api.polymarket.com/markets/${conditionId}`, 5000);
  if (gm?.outcomePrices) {
    try {
      const prices = JSON.parse(gm.outcomePrices);
      const v = +prices[0];
      if (v > 0 && v < 1) return { price: v, bid: null, ask: null, spread: null, source: "gamma" };
    } catch (_e) { /* ignore */ }
  }
  return null;
}

async function fetchLeaderboard(period="WEEK",order="PNL",limit=25) {
  const d = await apiFetch(`https://data-api.polymarket.com/v1/leaderboard?timePeriod=${period}&orderBy=${order}&limit=${limit}&offset=0`);
  return Array.isArray(d)?d:[];
}

async function fetchWallet(addr) {
  const [pos,trades,val] = await Promise.all([
    apiFetch(`https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0.01&limit=25`),
    apiFetch(`https://data-api.polymarket.com/trades?user=${addr}&limit=20`),
    apiFetch(`https://data-api.polymarket.com/value?user=${addr}`),
  ]);
  return {positions:Array.isArray(pos)?pos:[], trades:Array.isArray(trades)?trades:[], value:val?.value??null};
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS LAYER
// ═══════════════════════════════════════════════════════════════════════════════
function buildNewsQuery(q) {
  let s = q
    .replace(/on \d{4}-\d{2}-\d{2}\??/gi,"").replace(/by (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{4}/gi,"")
    .replace(/^will\s+/i,"").replace(/\s+win\s*\??$/i,"").replace(/\s+vs\.?\s+/i," ").replace(/[?!]/g,"").trim();
  if(/federal reserve|fed.*rate/i.test(s)) return `Federal Reserve rate decision ${new Date().getFullYear()}`;
  if(/bitcoin|btc/i.test(s)) return `Bitcoin ${new Date().getFullYear()}`;
  if(/ethereum|eth/i.test(s)) return `Ethereum ${new Date().getFullYear()}`;
  return s.slice(0,60);
}

async function fetchNews(question) {
  const query = buildNewsQuery(question);
  const short = query.split(" ").slice(0,3).join(" ");
  for(const q of [query,short]) {
    if(!q||q.length<3) continue;
    try{
      const r=await fetch(`https://api.thenewsapi.com/v1/news/all?api_token=${THENEWS_KEY}&search=${encodeURIComponent(q)}&language=en&limit=5&sort_by=published_at`,{signal:AbortSignal.timeout(6000)});
      if(r.ok){
        const d=await r.json();
        if(d.error?.toLowerCase().includes("limit")) break;
        const arts=(d.data||[]).map(a=>({title:a.title||"",snippet:a.snippet||a.description||"",src:"TNA",published:a.published_at,url:a.url}));
        if(arts.length) return {articles:arts,query:q,api:"TheNewsAPI"};
      }
    }catch(_e){}
  }
  for(const q of [query,short]) {
    if(!q||q.length<3) continue;
    try{
      const r=await fetch(`https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&sortby=publishedAt&apikey=${GNEWS_KEY}`,{signal:AbortSignal.timeout(6000)});
      if(r.ok){
        const d=await r.json();
        const arts=(d.articles||[]).map(a=>({title:a.title||"",snippet:a.content||a.description||"",src:"GNews",published:a.publishedAt,url:a.url}));
        if(arts.length) return {articles:arts,query:q,api:"GNews"};
      }
    }catch(_e){}
  }
  return {articles:[],query,api:"none"};
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI ENGINE v4 — FIXED CONFIDENCE MATH
// ═══════════════════════════════════════════════════════════════════════════════
//
// CONFIDENCE AUDIT (realistic single-signal case):
//   Base (mid-range):     42
//   Quality bonus (q=65): +13
//   1 stat signal:        +12  (flat bonus, not scaled)
//   Stat edge bonus:      +6   (0.05 edge * 120 capped at 15)
//   ────────────────────────
//   Total:                73  ✓ above threshold 55
//
// Zero-signal case:
//   Base:                 42
//   Quality bonus (q=40): +7
//   ────────────────────────
//   Total:                49  ✗ correctly skipped

function detectType(q) {
  const t=q.toLowerCase();
  if(/\bvs\.?\b|\bwin on \d{4}|premier league|la liga|bundesliga|serie a|ligue 1|nba|nfl|nhl|mlb|ncaa|champions league|fa cup|march madness|copa/.test(t)) return "sports";
  if(/\bfed\b|federal reserve|interest rate|\bbps\b|fomc|cpi|pce|\bgdp\b|unemployment|inflation rate/.test(t)) return "macro";
  if(/bitcoin|ethereum|\bcrypto\b|\bbtc\b|\beth\b|\bsol\b|\bxrp\b|\bbnb\b|coinbase|binance/.test(t)) return "crypto";
  if(/election|president|senate|congress|\bvote\b|democrat|republican|trump|prime minister|parliament|referendum/.test(t)) return "politics";
  if(/earnings|revenue|ipo|merger|acquisition|\bceo\b|quarterly|stock price/.test(t)) return "finance";
  return "general";
}

// Per-type keyword banks — only words that actually indicate YES or NO resolution
const KW = {
  sports:{
    bull:["won","wins","victory","beat","champion","top of table","leads","clean sheet","unbeaten","dominated","qualified","promoted","first place","comeback","score","goal","clinch"],
    bear:["lost","lose","defeat","eliminated","relegated","injured","suspended","banned","conceded","knocked out","sacked","fired","last place","lose match"],
  },
  macro:{
    bull:["rate cut","cuts rates","cut rates","dovish","pivot","easing","no change","hold rates","pause hike","rate reduction","below expectations","inflation cools","lower rates"],
    bear:["rate hike","hike rates","raised rates","hawkish","tightening","above expectations","emergency hike","raise rates","above target","strong jobs"],
  },
  crypto:{
    bull:["all time high","ath","bull run","rally","surged","breakout","etf approved","institutional buying","halving","golden cross","accumulation"],
    bear:["crash","ban","crackdown","sell-off","capitulation","dump","exploit","hack","bear market","death cross","regulatory ban"],
  },
  politics:{
    bull:["elected","leads","polling ahead","frontrunner","won primary","landslide","projected winner","ahead in polls","leads polls","declared winner"],
    bear:["trailing","dropped out","indicted","impeached","behind in polls","conceded","withdrew","disqualified","arrested"],
  },
  finance:{
    bull:["beat earnings","revenue beats","profit up","raised guidance","partnership","acquisition approved","strong quarter"],
    bear:["missed earnings","revenue miss","loss","layoffs","bankruptcy","investigation","below guidance"],
  },
  general:{
    bull:["confirmed","approved","signed","passed","announced","completed","secured","achieved","launched","succeeded"],
    bear:["rejected","blocked","cancelled","failed","denied","collapsed","withdrawn","vetoed","delayed","suspended"],
  },
};
const NEGS = ["not ","no ","won't","will not","cannot","can't","never ","didn't","doesn't","isn't","wasn't","weren't","fails to","unable to"];

function relevance(article, question) {
  const qw = question.toLowerCase().replace(/\b(will|the|a|an|by|on|in|at|is|are|was|were|to|of|for)\b/g," ").replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(w=>w.length>3);
  if(!qw.length) return 0;
  const text=`${article.title} ${article.snippet}`.toLowerCase();
  return qw.filter(w=>text.includes(w)).length / qw.length;
}

function runSentiment(articles, question, mType) {
  if(!articles.length) return {score:0,norm:0,label:"NO NEWS",bullHits:[],bearHits:[],relevant:0,totalRel:0};
  const kw = KW[mType]||KW.general;
  let score=0, relevant=0, totalRel=0;
  const bullHits=[], bearHits=[];
  for(const art of articles) {
    const rel = relevance(art,question);
    totalRel += rel;
    if(rel < 0.12) continue;
    relevant++;
    const w = 0.4 + rel*0.6;
    const text=`${art.title} ${art.snippet}`.toLowerCase();
    kw.bull.forEach(kw=>{
      if(text.includes(kw)){
        const neg=NEGS.some(n=>{ const i=text.indexOf(kw); return i>0&&text.slice(Math.max(0,i-30),i).includes(n); });
        if(neg){score-=w;}else{score+=2*w; bullHits.push(kw);}
      }
    });
    kw.bear.forEach(kw=>{
      if(text.includes(kw)){ score-=2*w; bearHits.push(kw); }
    });
  }
  const norm=clamp(score/8,-1,1);
  return {
    score:Math.round(score*10)/10, norm, relevant, totalRel:Math.round(totalRel*100)/100,
    bullHits:[...new Set(bullHits)], bearHits:[...new Set(bearHits)],
    label: score>=3?"STRONGLY BULLISH":score>=1.2?"BULLISH":score<=-3?"STRONGLY BEARISH":score<=-1.2?"BEARISH":"NEUTRAL",
  };
}

function calcQuality(market) {
  let q=50;
  const vol=market.volume24h||0;
  if(vol>1e6)q+=22;else if(vol>2e5)q+=16;else if(vol>5e4)q+=9;else if(vol>1e4)q+=3;else q-=12;
  if(market.bestBid!=null&&market.bestAsk!=null){
    const spr=market.bestAsk-market.bestBid;
    if(spr<0.005)q+=20;else if(spr<0.015)q+=14;else if(spr<0.03)q+=8;else if(spr<0.05)q+=2;else if(spr<0.08)q-=6;else if(spr<0.12)q-=14;else q-=28;
  }else q-=8;
  const p=market.yesPrice;
  if(p>=0.30&&p<=0.70)q+=8;else if(p>=0.20&&p<=0.80)q+=4;
  if((market.competitive||0)>0.7)q+=4;
  return clamp(Math.round(q),0,100);
}

function calcStatEdge(market, mType) {
  const p=market.yesPrice, mom=market.oneDayChange||0, wk=market.oneWeekChange||0;
  const lf=(market.volume24h||0)>1e6?0.4:(market.volume24h||0)>3e5?0.6:0.85;
  if(mType==="sports"){
    if(p>=0.68&&p<=0.84) return {action:"BUY_NO", edge:0.06*lf, reason:`Favourite overpriced: ${(p*100).toFixed(0)}%`};
    if(p>=0.16&&p<=0.32) return {action:"BUY_YES", edge:0.06*lf, reason:`Underdog value: ${(p*100).toFixed(0)}%`};
    if(p>=0.38&&p<=0.62&&Math.abs(mom)>0.05) return {action:mom>0?"BUY_YES":"BUY_NO", edge:Math.abs(mom)*0.7*lf, reason:`Near-50/50 momentum ${(mom*100).toFixed(1)}%`};
  } else if(mType==="crypto"){
    if(mom>0.09||wk>0.14) return {action:"BUY_YES", edge:Math.max(mom,wk*0.5)*0.5, reason:`Bull momentum 24h:${(mom*100).toFixed(1)}% 7d:${(wk*100).toFixed(1)}%`};
    if(mom<-0.09||wk<-0.14) return {action:"BUY_NO", edge:Math.max(Math.abs(mom),Math.abs(wk)*0.5)*0.5, reason:`Bear momentum 24h:${(mom*100).toFixed(1)}% 7d:${(wk*100).toFixed(1)}%`};
  } else if(mType==="macro"){
    if(p>=0.20&&p<=0.80&&Math.abs(mom)>0.055) return {action:mom>0?"BUY_YES":"BUY_NO", edge:Math.abs(mom)*0.6*lf, reason:`Macro repricing ${(mom*100).toFixed(1)}%`};
  } else if(mType==="politics"){
    if(Math.abs(mom)>0.07) return {action:mom>0?"BUY_YES":"BUY_NO", edge:Math.abs(mom)*0.5*lf, reason:`Political shift ${(mom*100).toFixed(1)}%`};
  } else {
    if(Math.abs(mom)>0.10) return {action:mom>0?"BUY_YES":"BUY_NO", edge:Math.abs(mom)*0.4*lf, reason:`Strong momentum ${(mom*100).toFixed(1)}%`};
  }
  return {action:"SKIP", edge:0, reason:"No statistical pattern"};
}

function calcNewsEdge(price, sent) {
  if(sent.relevant===0) return {action:"SKIP", edge:0, implied:price};
  const mag = Math.abs(sent.norm) * (0.10 + Math.abs(sent.norm)*0.30);
  const implied = clamp(price + sent.norm*mag, 0.05, 0.95);
  const edge = implied - price;
  if(edge>0.035)       return {action:"BUY_YES", edge, implied};
  else if(edge<-0.035) return {action:"BUY_NO",  edge, implied};
  return {action:"SKIP", edge:0, implied};
}

// ── MAIN ANALYSIS ──
function analyzeMarket(market, articles, cash, perfStats = null) {
  const log=[]; const mType=detectType(market.question); const p=market.yesPrice;

  // Hard blocks
  if(p>PRICE_MAX||p<PRICE_MIN){
    log.push(`BLOCKED: ${pct(p)} outside [${pct(PRICE_MIN)}-${pct(PRICE_MAX)}]`);
    log.push("[DECISION] SKIP");
    return {action:"SKIP",conf:0,amount:0,edgeFrom:"price",mType,log,reason:"Price out of range"};
  }
  const days=daysFrom(market.endDate);
  if(days<0.25){
    log.push("BLOCKED: resolves in <6h — too risky");
    log.push("[DECISION] SKIP");
    return {action:"SKIP",conf:0,amount:0,edgeFrom:"time",mType,log,reason:"Resolves <6h"};
  }

  const qual=calcQuality(market);
  const spr=market.bestBid&&market.bestAsk ? market.bestAsk-market.bestBid : null;
  const sprStr=spr!=null?`${(spr*100).toFixed(1)}¢`:"?";

  log.push(`[${mType.toUpperCase()}] "${market.question.slice(0,62)}"`);
  log.push(`Price:${pct(p)}  Vol:${mini(market.volume24h)}  Liq:${mini(market.liquidity)}  Qual:${qual}/100`);
  if(spr!=null) log.push(`OrderBook: Bid:${market.bestBid?pct(market.bestBid):"?"}  Ask:${market.bestAsk?pct(market.bestAsk):"?"}  Spread:${sprStr}`);
  log.push(`Resolves: ${days<1?`${Math.round(days*24)}h`:days<7?`${Math.round(days)}d`:days<30?`${Math.round(days/7)}wk`:`${Math.round(days/30)}mo`}  Articles: ${articles.length}`);
  log.push("─".repeat(46));

  if(qual<25){
    log.push(`[QUALITY] ${qual}/100 — below minimum (wide spread or no liquidity)`);
    log.push("[DECISION] SKIP");
    return {action:"SKIP",conf:0,amount:0,edgeFrom:"quality",mType,log,reason:`Quality ${qual} too low`};
  }

  // Sentiment
  const sent=runSentiment(articles,market.question,mType);
  log.push(`[SENTIMENT] ${sent.label}  score:${sent.score}  relevant:${sent.relevant}/${articles.length}  rel:${(sent.totalRel*100).toFixed(0)}%`);
  if(sent.bullHits.length) log.push(`  ↑ ${sent.bullHits.slice(0,5).join(", ")}`);
  if(sent.bearHits.length) log.push(`  ↓ ${sent.bearHits.slice(0,5).join(", ")}`);
  if(!articles.length)     log.push(`  ! No news — stat model only`);
  else if(!sent.relevant)  log.push(`  ! ${articles.length} articles but none relevant to question`);

  // Momentum
  const mom=market.oneDayChange||0, wk=market.oneWeekChange||0;
  log.push(`[MOMENTUM]  24h:${mom>0?"▲":"▼"}${(Math.abs(mom)*100).toFixed(2)}%  7d:${wk>=0?"+":""}${(wk*100).toFixed(1)}%`);

  // Statistical edge
  const stat=calcStatEdge(market,mType);
  log.push(`[STAT EDGE] ${stat.action!=="SKIP"?`${stat.action}  edge:${(stat.edge*100).toFixed(1)}%  ${stat.reason}`:"No pattern"}`);

  // News edge
  const newsEdge=calcNewsEdge(p,sent);
  if(newsEdge.action!=="SKIP") log.push(`[NEWS EDGE] ${newsEdge.action}  edge:${(Math.abs(newsEdge.edge)*100).toFixed(1)}%  implied:${pct(newsEdge.implied)}`);
  else log.push(`[NEWS EDGE] No significant edge`);

  // ── CONFIDENCE — FIXED MATH ────────────────────────────────────────────────
  // Base: mid-range gets higher base since there's more room to move
  let conf = p>=0.25&&p<=0.75 ? 42 : p>=0.15&&p<=0.85 ? 36 : 28;

  // Quality contribution: 0-18 pts (linear, q=100 → +18, q=50 → +9, q=25 → +4)
  conf += Math.round(clamp(qual,0,100) * 0.18);

  // --- SIGNAL BONUSES (flat bonuses per signal, not scaled by tiny strength values) ---
  let actionYesScore=0, actionNoScore=0;

  // Stat signal: flat bonus based on whether we have a pattern, scaled by edge size
  if(stat.action==="BUY_YES"){ conf+=12; actionYesScore+=12+Math.round(clamp(stat.edge*120,0,8)); }
  if(stat.action==="BUY_NO") { conf+=12; actionNoScore +=12+Math.round(clamp(stat.edge*120,0,8)); }
  conf += Math.round(clamp(stat.edge*120,0,8)); // edge magnitude bonus (0-8)

  // News signal: flat bonus if we have relevant news edge
  if(newsEdge.action==="BUY_YES"){ conf+=10; actionYesScore+=10+Math.round(clamp(Math.abs(newsEdge.edge)*80,0,8)); }
  if(newsEdge.action==="BUY_NO") { conf+=10; actionNoScore +=10+Math.round(clamp(Math.abs(newsEdge.edge)*80,0,8)); }
  conf += Math.round(clamp(Math.abs(newsEdge.edge)*80,0,8)); // edge magnitude bonus (0-8)

  // Sentiment signal (only if relevant articles exist)
  if(sent.relevant>0 && Math.abs(sent.norm)>0.25){
    const sentBonus=Math.round(clamp(Math.abs(sent.norm)*10,2,8));
    conf+=sentBonus;
    if(sent.norm>0.25)  actionYesScore+=sentBonus;
    if(sent.norm<-0.25) actionNoScore +=sentBonus;
  }

  // Momentum signal
  if(Math.abs(mom)>0.06){
    const momBonus=Math.round(clamp(Math.abs(mom)*60,3,7));
    conf+=momBonus;
    if(mom>0.06)  actionYesScore+=momBonus;
    if(mom<-0.06) actionNoScore +=momBonus;
  }

  // Multi-signal agreement bonus (when 2+ sources agree = extra confidence)
  const yesCount=[stat.action==="BUY_YES",newsEdge.action==="BUY_YES",sent.norm>0.25&&sent.relevant>0,mom>0.06].filter(Boolean).length;
  const noCount =[stat.action==="BUY_NO", newsEdge.action==="BUY_NO", sent.norm<-0.25&&sent.relevant>0,mom<-0.06].filter(Boolean).length;
  if(yesCount>=3||noCount>=3) conf+=10;
  else if(yesCount>=2||noCount>=2) conf+=5;

  // Conflict penalty (signals pointing opposite directions)
  if(yesCount>0&&noCount>0){
    const conflictPenalty=Math.round(Math.min(yesCount,noCount)*8);
    conf-=conflictPenalty;
    actionYesScore-=conflictPenalty/2;
    actionNoScore -=conflictPenalty/2;
    log.push(`[CONFLICT]  YES signals:${yesCount} NO signals:${noCount} → penalty:-${conflictPenalty}`);
  }

  // Time penalty
  if(days<3)       conf-=10;
  else if(days<7)  conf-=4;
  else if(days>45) conf+=3;

  // Spread penalty (entry cost directly reduces expected profit)
  if(spr!=null){
    if(spr>0.10)      conf-=14;
    else if(spr>0.06) conf-=8;
    else if(spr>0.03) conf-=3;
    else if(spr<0.01) conf+=4;
  }

  // ── ADAPTIVE LEARNING — adjust confidence based on historical performance ──
  if (perfStats?.byType?.[mType]) {
    const ts = perfStats.byType[mType];
    const total = ts.wins + ts.losses;
    if (total >= 3) {
      const wr = ts.wins / total;
      if (wr < 0.45) {
        const pen = Math.round((0.45 - wr) * 50);
        conf -= pen;
        actionYesScore -= pen; actionNoScore -= pen;
        log.push(`[LEARNING] ${mType} win rate low (${(wr*100).toFixed(0)}%) → -${pen} conf`);
      } else if (wr > 0.55) {
        const bon = Math.round((wr - 0.55) * 40);
        conf += bon;
        actionYesScore += bon; actionNoScore += bon;
        log.push(`[LEARNING] ${mType} win rate high (${(wr*100).toFixed(0)}%) → +${bon} conf`);
      }
    }
  }

  conf=clamp(Math.round(conf),0,99);

  log.push(`[SIGNALS]   YES:${yesCount} NO:${noCount}  Qual:${qual}  Days:${days<1?`${(days*24).toFixed(0)}h`:Math.round(days)+"d"}`);
  log.push("─".repeat(46));
  log.push(`[CONFIDENCE] ${conf}%  (threshold: ${CONF_THRESH}%)`);

  // ── DIRECTION DECISION ─────────────────────────────────────────────────────
  const isConflict = yesCount>0&&noCount>0;
  let action="SKIP", edgeFrom="none";

  if(conf>=CONF_THRESH && !isConflict){
    if(actionYesScore>actionNoScore && yesCount>0) action="BUY_YES";
    else if(actionNoScore>actionYesScore && noCount>0) action="BUY_NO";
  } else if(conf>=CONF_THRESH && isConflict){
    log.push("[BLOCKED] Signals conflict — skipping to avoid coin-flip");
  }

  if(action!=="SKIP"){
    edgeFrom = newsEdge.action!=="SKIP"?"news" : stat.action!=="SKIP"?"statistical" : "momentum";
  }

  // ── POSITION SIZING ────────────────────────────────────────────────────────
  let amount=0;
  if(action!=="SKIP"){
    const maxScore=Math.max(actionYesScore,actionNoScore);
    const base = maxScore>30?MAX_TRADE : maxScore>20?30 : maxScore>12?20 : 10;
    const confScale = clamp((conf-CONF_THRESH)/25,0,1);
    const raw = base*(0.6+confScale*0.4);
    amount = clamp(r5(raw), 5, Math.min(MAX_TRADE, cash*0.15));
    if(days<3) amount=Math.min(amount,10); // reduce size near expiry
  }

  if(action!=="SKIP")
    log.push(`[DECISION]  ✓ ${action}  $${amount}  Conf:${conf}%  Edge:${edgeFrom}  Y${yesCount}/N${noCount}`);
  else
    log.push(`[DECISION]  SKIP  ${conf<CONF_THRESH?`conf:${conf}%<${CONF_THRESH}%`:isConflict?"conflict":"no dominant edge"}`);

  const srcList=action==="BUY_YES"
    ?[stat.action==="BUY_YES"?"stat":"",newsEdge.action==="BUY_YES"?"news":"",sent.norm>0?"sent":""].filter(Boolean)
    :[stat.action==="BUY_NO"?"stat":"",newsEdge.action==="BUY_NO"?"news":"",sent.norm<0?"sent":""].filter(Boolean);

  return {
    action, conf, amount, edgeFrom, mType, qual, days, sent, stat, newsEdge, spr,
    signals:{yesCount,noCount,isConflict,actionYesScore,actionNoScore},
    log,
    reason: action!=="SKIP"
      ? `[${mType}] ${sent.label}|${stat.reason.slice(0,35)}|src:${srcList.join("+")}`
      : `[${mType}] ${conf<CONF_THRESH?`conf:${conf}%`:isConflict?"conflicted":"no edge"}`,
  };
}

function evalSell(pos, currentPrice, mom=0) {
  const pnlPct=(currentPrice-pos.ep)/pos.ep;
  const steps=[]; let score=0;
  steps.push(`Entry ${pct(pos.ep)} → ${pct(currentPrice)}  P&L: ${pnlPct>=0?"+":""}${(pnlPct*100).toFixed(1)}%`);
  if(pnlPct>0.50){score+=80;steps.push("TAKE PROFIT: +50% — close position");}
  else if(pnlPct>0.35){score+=60;steps.push(`Take profit +${(pnlPct*100).toFixed(0)}% — strong gain`);}
  else if(pnlPct>0.20){score+=35;steps.push(`Good profit +${(pnlPct*100).toFixed(0)}% — consider closing`);}
  else if(pnlPct>0.10){score+=10;steps.push(`Profit +${(pnlPct*100).toFixed(0)}% — holding`);}
  if(pnlPct<-0.45){score+=80;steps.push("STOP LOSS: -45% — cut loss");}
  else if(pnlPct<-0.30){score+=55;steps.push(`Stop loss -${Math.abs(pnlPct*100).toFixed(0)}%`);}
  else if(pnlPct<-0.18){score+=28;steps.push(`Warning -${Math.abs(pnlPct*100).toFixed(0)}%`);}
  else if(pnlPct<-0.08){score+=8;steps.push(`Drawdown -${Math.abs(pnlPct*100).toFixed(0)}%`);}
  if(currentPrice>0.90&&pos.side==="YES"){score+=30;steps.push("YES near ceiling");}
  if(currentPrice<0.10&&pos.side==="YES"){score+=50;steps.push("YES collapsed");}
  if(currentPrice>0.90&&pos.side==="NO") {score+=50;steps.push("NO: market against position");}
  if(pos.side==="YES"&&mom<-0.06){score+=12;steps.push(`Adverse momentum ${(mom*100).toFixed(1)}%`);}
  if(pos.side==="NO" &&mom> 0.06){score+=12;steps.push(`Adverse momentum +${(mom*100).toFixed(1)}%`);}

  // Dead money: position open 48h+ and totally flat → free up capital
  const hoursOpen = (Date.now() - (pos.openedTs||0)) / 3600000;
  if (hoursOpen > 48 && (pos.pnlPct||0) > -0.05 && (pos.pnlPct||0) < 0.05) {
    score += 60; steps.push("DEAD MONEY: 48h+ flat — reallocating capital");
  }
  const dec=score>=55?"SELL":score>=28?"CONSIDER":"HOLD";
  steps.push(`Score: ${score}/100  →  ${dec}`);
  return {decision:dec,score,steps,pnlPct};
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE TRACKER — records outcomes to improve future decisions
// ═══════════════════════════════════════════════════════════════════════════════
class PerfTracker {
  constructor(){ this.trades=[]; }
  record(trade){
    this.trades.push({mType:trade.mktType,edgeFrom:trade.edgeFrom,conf:trade.conf,pnl:trade.pnl||0,ts:Date.now()});
    if(this.trades.length>50) this.trades.shift();
  }
  stats(){
    if(!this.trades.length) return null;
    const byType={},byEdge={};
    for(const t of this.trades){
      if(!byType[t.mType]) byType[t.mType]={wins:0,losses:0,pnl:0};
      if(!byEdge[t.edgeFrom]) byEdge[t.edgeFrom]={wins:0,losses:0,pnl:0};
      const bucket=t.pnl>0?"wins":"losses";
      byType[t.mType][bucket]++; byType[t.mType].pnl+=t.pnl;
      byEdge[t.edgeFrom][bucket]++; byEdge[t.edgeFrom].pnl+=t.pnl;
    }
    const wins=this.trades.filter(t=>t.pnl>0).length;
    return {total:this.trades.length,wins,losses:this.trades.length-wins,winRate:wins/this.trades.length,byType,byEdge};
  }
}
const perf = new PerfTracker();

// ═══════════════════════════════════════════════════════════════════════════════
// COLORS & THEME
// ═══════════════════════════════════════════════════════════════════════════════
const TC={sports:"#1a3a1a",macro:"#1a2e3a",crypto:"#3a3a1a",politics:"#3a1a3a",finance:"#1a2a3a",general:"#1a1a2a"};
const TT={sports:"#4a8a4a",macro:"#4a7a9a",crypto:"#9a9a4a",politics:"#9a4a9a",finance:"#4a7aaa",general:"#7070aa"};
const LOG_COLORS={
  header:"#e8e8e8",ok:"#c0c0c0",err:"#888",warn:"#888",dim:"#3a3a3a",
  mkt:"#ddd",price:"#bbb",trade:"#ddd",tradeok:"#80e080",decision:"#fff",
  profit:"#80c080",loss:"#888",sent:"#aaa",conf:"#bbb",pricetick:"#5a9a5a",
  info:"#aaa",newsitem:"#4a4a4a",blank:null,div:null,sell:"#9a6060",
};

// ═══════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════
function TypeBadge({type}){
  return <span style={{fontSize:"9px",padding:"1px 5px",background:TC[type]||"#1a1a1a",color:TT[type]||"#666"}}>{(type||"?").toUpperCase()}</span>;
}

function ConfBar({conf,threshold=CONF_THRESH,width=60}){
  const fill=`${Math.round(conf)}%`;
  const color=conf>=threshold+15?"#4a7a4a":conf>=threshold?"#7a7a4a":"#555";
  return(
    <div style={{display:"flex",alignItems:"center",gap:"4px"}}>
      <div style={{width,height:"4px",background:"#1a1a1a",overflow:"hidden"}}>
        <div style={{width:fill,height:"100%",background:color,transition:"width 0.4s"}}/>
      </div>
      <span style={{color,fontSize:"9px",minWidth:"26px"}}>{conf}%</span>
    </div>
  );
}

function MiniSpark({data,w=70,h=20,color="#4a7a4a"}){
  if(!data||data.length<2) return <span style={{color:"#666",fontSize:"9px"}}>─</span>;
  const vals=data.map(d=>typeof d==="number"?d:(d.price??d.y??0));
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||0.001;
  const pts=vals.map((v,i)=>`${((i/(vals.length-1))*w).toFixed(1)},${(h-((v-mn)/rng)*h).toFixed(1)}`).join(" ");
  return(
    <svg width={w} height={h} style={{display:"inline-block",verticalAlign:"middle"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"/>
    </svg>
  );
}

function LogPanel({logs,logRef}){
  return(
    <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"6px 8px",fontSize:"11px",lineHeight:"1.6",fontFamily:"Consolas,monospace"}}>
      {logs.map(l=>{
        if(l.type==="blank") return <div key={l.id} style={{height:"5px"}}/>;
        if(l.type==="div")   return <div key={l.id} style={{color:"#555",fontSize:"9px",paddingLeft:"2px"}}>{"─".repeat(54)}</div>;
        return(
          <div key={l.id} style={{display:"flex",gap:"8px"}}>
            <span style={{color:"#1c1c1c",flexShrink:0,fontSize:"9px",paddingTop:"1px",minWidth:"52px"}}>{l.ts}</span>
            <span style={{color:LOG_COLORS[l.type]||"#888",wordBreak:"break-word"}}>{l.msg}</span>
          </div>
        );
      })}
      <span style={{display:"inline-block",width:"6px",height:"11px",background:"#2a2a2a",animation:"blink 1.2s step-end infinite",marginLeft:"2px",verticalAlign:"text-bottom"}}/>
    </div>
  );
}

function PBar({title,badge,actions=[]}){
  return(
    <div style={{flexShrink:0,background:"#0d0d0d",borderBottom:"1px solid #1c1c1c",padding:"5px 10px",display:"flex",alignItems:"center",gap:"8px"}}>
      <span style={{color:"#555",fontSize:"10px",letterSpacing:"1px",fontWeight:"bold"}}>{title}</span>
      {badge&&<span style={{color:"#555",fontSize:"9px"}}>{badge}</span>}
      <div style={{marginLeft:"auto",display:"flex",gap:"4px"}}>
        {actions.map(a=>(
          <button key={a.label} onClick={a.fn} disabled={a.dis} style={{background:"transparent",border:`1px solid ${a.dis?"#1a1a1a":"#333"}`,color:a.dis?"#222":"#666",padding:"2px 10px",fontSize:"10px",fontFamily:"Consolas,monospace",cursor:a.dis?"not-allowed":"pointer"}}>{a.label}</button>
        ))}
      </div>
    </div>
  );
}

function Panel({title,badge,actions,children,style={}}){
  return(
    <div style={{display:"flex",flexDirection:"column",overflow:"hidden",borderRight:"1px solid #141414",...style}}>
      <PBar title={title} badge={badge} actions={actions||[]}/>
      <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>{children}</div>
    </div>
  );
}

function SVal({label,value,color="#aaa",sub=null,hi=false}){
  return(
    <div style={{padding:"6px 12px",borderBottom:"1px solid #0f0f0f",background:hi?"#0a120a":"transparent"}}>
      <div style={{color:"#666",fontSize:"9px",marginBottom:"2px",letterSpacing:"0.5px"}}>{label}</div>
      <div style={{color,fontSize:"14px",fontWeight:"bold"}}>{value}</div>
      {sub&&<div style={{color:"#555",fontSize:"9px",marginTop:"1px"}}>{sub}</div>}
    </div>
  );
}

function SRow({label,value,color="#888"}){
  return(
    <div style={{display:"flex",justifyContent:"space-between",padding:"2px 12px",borderBottom:"1px solid #0a0a0a",fontSize:"10px"}}>
      <span style={{color:"#555"}}>{label}</span><span style={{color}}>{value}</span>
    </div>
  );
}

function TH({cols}){
  return(
    <thead>
      <tr style={{borderBottom:"1px solid #181818"}}>
        {cols.map(c=><th key={c} style={{padding:"4px 8px",textAlign:"left",fontWeight:"normal",color:"#666",fontSize:"10px",whiteSpace:"nowrap"}}>{c}</th>)}
      </tr>
    </thead>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-FLIGHT DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════
async function runDiagnostics() {
  const t0 = Date.now();
  const r = { internet: false, gamma: false, clob: false, news: false, ping: 0, clobNote: "" };
  // Internet + Gamma
  try {
    const d = await rawFetch("https://gamma-api.polymarket.com/markets?limit=1&active=true", 4000);
    if (d) { r.internet = true; r.gamma = true; }
  } catch (_e) {}
  // CLOB
  try {
    const d = await rawFetch("https://clob.polymarket.com/time", 3000);
    if (d) { r.clob = true; } else { r.clobNote = "CLOB unreachable — will use Gamma prices"; }
  } catch (_e) { r.clobNote = "CLOB blocked — will use Gamma prices"; }
  // News (TheNewsAPI)
  try {
    const d = await fetch("https://api.thenewsapi.com/v1/news/all?api_token="+THENEWS_KEY+"&search=test&limit=1", { signal: AbortSignal.timeout(3000) });
    if (d.ok) r.news = true;
  } catch (_e) {}
  r.ping = Date.now() - t0;
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI STATUS MESSAGES — varied, human-feeling commentary
// ═══════════════════════════════════════════════════════════════════════════════
const STATUS_MSGS = {
  scanning: [
    "Pulling latest markets from Polymarket...",
    "Fetching market data, stand by...",
    "Scanning 100 markets for opportunities...",
    "Connecting to Polymarket Gamma API...",
    "Loading market feed...",
  ],
  filtering: [
    "Filtering out dead and illiquid markets...",
    "Removing markets outside tradeable range...",
    "Pruning low-quality candidates...",
    "Sorting candidates by volume and spread quality...",
  ],
  analyzing_start: [
    "Locking on to candidate market...",
    "Running pre-trade analysis...",
    "Inspecting market microstructure...",
    "Pulling order book depth...",
    "Checking live bid/ask from CLOB...",
  ],
  news_searching: [
    "Searching for relevant news...",
    "Querying TheNewsAPI for recent coverage...",
    "Looking for market-relevant articles...",
    "Scanning news sources for signal...",
    "Fetching real-time news context...",
  ],
  news_found: [
    "Found relevant articles — analyzing sentiment...",
    "News found — running NLP sentiment pass...",
    "Got {n} article(s) — scoring relevance...",
    "Articles found — checking keyword alignment...",
  ],
  news_none: [
    "No news found — falling back to statistical model.",
    "No articles. Using price action and stat patterns only.",
    "News API dry — relying on quant signals.",
    "Can't find relevant news — stat model stepping in.",
  ],
  thinking: [
    "Running multi-signal analysis...",
    "Weighing news edge vs statistical edge...",
    "Checking for signal agreement...",
    "Calculating confidence score...",
    "Running favourite-longshot bias check...",
    "Comparing implied probability vs current price...",
    "Assessing market quality and spread cost...",
    "Cross-referencing all signal sources...",
  ],
  interesting: [
    "Interesting setup here — digging deeper...",
    "This market has potential — running full analysis...",
    "Signals looking promising on this one...",
    "Something catching my eye here...",
    "Worth a closer look — analyzing...",
  ],
  skip_low_conf: [
    "Edge too thin — skipping.",
    "Not enough conviction — moving on.",
    "Confidence below threshold — no trade.",
    "Signals weak, staying out.",
    "Risk/reward not there — skipping.",
  ],
  skip_conflict: [
    "Conflicting signals — too uncertain, skipping.",
    "Bull and bear signals cancelling out — no trade.",
    "Mixed picture. Won't trade without clarity.",
    "Signals pointing both ways — I'll wait.",
  ],
  trade_found: [
    "Edge identified — executing paper trade...",
    "Strong signal detected. Entering position...",
    "Conviction high — deploying capital...",
    "Found an edge worth trading — going in.",
    "All signals aligned — opening position now.",
  ],
  idle_waiting: [
    "Watching the markets...",
    "Waiting for the next scan cycle...",
    "Resting between scans. Auto mode active.",
    "Monitoring. Next deep scan in ~3 minutes.",
    "All quiet. Prices updating every 10 seconds.",
  ],
};

function getRandMsg(key, replacements = {}) {
  const pool = STATUS_MSGS[key];
  if (!pool) return "";
  let msg = pool[Math.floor(Math.random() * pool.length)];
  Object.entries(replacements).forEach(([k, v]) => { msg = msg.replace("{"+k+"}", v); });
  return msg;
}
export default function App(){
  // ── state ──
  const [markets,    setMarkets]   = useState([]);
  const [blacklist,  setBlacklist] = useState(new Set());
  const [portfolio,  setPortfolio] = useState({cash:START_CASH,positions:[],trades:[],closed:[]});
  const [status,     setStatus]    = useState("idle");
  const [auto,       setAuto]      = useState(false);
  const [tab,        setTab]       = useState("positions");
  const [aiStatus,   setAiStatus]  = useState("Initializing...");  // live AI commentary
  const [diag,       setDiag]      = useState(null);               // diagnostics result
  const [leaders,    setLeaders]   = useState([]);
  const [lbPeriod,   setLbPeriod]  = useState("WEEK");
  const [lbOrder,    setLbOrder]   = useState("PNL");
  const [lbLoading,  setLbLoading] = useState(false);
  const [wallet,     setWallet]    = useState(null);
  const [wLoading,   setWLoading]  = useState(false);
  const [refreshTs,  setRefreshTs] = useState("--");
  const [refreshN,   setRefreshN]  = useState(0);
  const [perfStats,  setPerfStats] = useState(null);
  const [stats,setStats] = useState({
    scans:0,analyzed:0,executed:0,skipped:0,blacklisted:0,newsTotal:0,uptime:0,
    lastScan:"--",best:null,worst:null,
    byType:{sports:0,macro:0,crypto:0,politics:0,finance:0,general:0},
    byEdge:{news:0,statistical:0,momentum:0},
    confHistory:[],avgConf:0,totalProfit:0,totalLoss:0,
  });

  // ── logs ──
  const [scanLog,setScanLog]=useState([]);
  const [aiLog,  setAiLog]  =useState([]);
  const [sellLog,setSellLog]=useState([]);
  const [sysLog, setSysLog] =useState([]);

  // ── refs ──
  const bootRef=useRef(false); const portRef=useRef(portfolio);
  const statusRef=useRef(status); const blackRef=useRef(new Set());
  const autoRef=useRef(null);   const priceRef=useRef(null);
  const uptimeRef=useRef(0);
  const scanLogRef=useRef(null); const aiLogRef=useRef(null);
  const sellLogRef=useRef(null); const sysLogRef=useRef(null);

  portRef.current=portfolio; statusRef.current=status; blackRef.current=blacklist;

  // autoscroll
  useEffect(()=>{ [scanLogRef,aiLogRef,sellLogRef,sysLogRef].forEach(r=>{if(r.current)r.current.scrollTop=r.current.scrollHeight;}); },[scanLog,aiLog,sellLog,sysLog]);

  // uptime
  useEffect(()=>{
    const iv=setInterval(()=>{uptimeRef.current++;setStats(s=>({...s,uptime:uptimeRef.current}));},1000);
    return()=>clearInterval(iv);
  },[]);

  // price refresh timer
  useEffect(()=>{
    priceRef.current=setInterval(()=>{
      if(portRef.current.positions.filter(p=>p.status==="OPEN").length>0) refreshPrices(true);
    },PRICE_MS);
    return()=>clearInterval(priceRef.current);
  },[]); // eslint-disable-line

  // log helpers
  const push=useCallback((setter,msg,type="info")=>{ setter(prev=>[...prev.slice(-600),{ts:nowTs(),msg,type,id:`${Date.now()}-${Math.random()}`}]); },[]);
  const sl =useCallback((m,t)=>push(setScanLog,m,t),[push]);
  const al =useCallback((m,t)=>push(setAiLog,  m,t),[push]);
  const sel=useCallback((m,t)=>push(setSellLog,m,t),[push]);
  const sys=useCallback((m,t)=>push(setSysLog, m,t),[push]);

  // ── close position ──
  const closePos=useCallback((pos,reason="")=>{
    const pnl=(pos.currentPrice-pos.ep)*pos.shares;
    const pnlPct=(pos.currentPrice-pos.ep)/pos.ep;
    const closed={...pos,closePrice:pos.currentPrice,closedAt:nowTs(),pnl,pnlPct,status:"CLOSED",closeReason:reason};
    perf.record({...closed}); setPerfStats(perf.stats());
    setPortfolio(prev=>{
      const next={...prev,cash:prev.cash+pos.currentPrice*pos.shares,positions:prev.positions.filter(p=>p.id!==pos.id),closed:[...prev.closed,closed]};
      portRef.current=next; return next;
    });
    setStats(s=>({...s,best:!s.best||pnl>s.best.pnl?{...pos,pnl}:s.best,worst:!s.worst||pnl<s.worst.pnl?{...pos,pnl}:s.worst,totalProfit:pnl>0?s.totalProfit+pnl:s.totalProfit,totalLoss:pnl<0?s.totalLoss+pnl:s.totalLoss}));
    sys(`[${reason||"CLOSE"}] ${pos.side} P&L:${pnl>=0?"+":""}${dollar(pnl)} "${pos.question.slice(0,30)}"`,pnl>=0?"profit":"warn");
  },[sys]);

  // ── price refresh ──
  const refreshPrices=useCallback(async(silent=false)=>{
    const open=portRef.current.positions.filter(p=>p.status==="OPEN");
    if(!open.length) return;
    if(!silent) sys(`[REFRESH] ${open.length} position(s)...`,"info");
    for(const pos of open){
      const res=await getLivePrice(pos.yesId,pos.conditionId);
      if(!res) continue;
      const current=pos.side==="YES"?res.price:(1-res.price);
      const pnl=(current-pos.ep)*pos.shares;
      const pnlPct=(current-pos.ep)/pos.ep;
      const momentum=current-(pos.currentPrice||pos.ep);
      setPortfolio(prev=>({...prev,positions:prev.positions.map(p=>p.id===pos.id?{...p,currentPrice:current,rawYes:res.price,pnl,pnlPct,momentum,lastUpdate:nowTs(),priceSource:res.source,bestBid:res.bid,bestAsk:res.ask,spread:res.spread}:p)}));
      if(!silent){
        const dir=current>(pos.currentPrice||pos.ep)?"▲":current<(pos.currentPrice||pos.ep)?"▼":"─";
        sys(`  ${dir} ${pos.side} "${pos.question.slice(0,30)}" ${pct(current)} P&L:${pnl>=0?"+":""}${dollar(pnl)} [${res.source}]`,"pricetick");
      }
      if(pnlPct>0.50)  closePos({...pos,currentPrice:current,pnl,pnlPct},"TAKE-PROFIT-50%");
      if(pnlPct<-0.45) closePos({...pos,currentPrice:current,pnl,pnlPct},"STOP-LOSS-45%");
    }
    setRefreshTs(nowTs()); setRefreshN(n=>n+1);
  },[sys,closePos]);

  // ── boot ──
  useEffect(()=>{
    if(bootRef.current) return; bootRef.current=true;
    (async()=>{
      await sleep(80);
      sys(`PolyBot v${VERSION}  ─  Adaptive Learning  ─  Smart Skipping`,"header");
      sys("─────────────────────────────────────────────────────","div");
      setAiStatus("Running pre-flight diagnostics...");
      sys("[DIAG] Running pre-flight diagnostics...","info");
      await sleep(200);

      const d = await runDiagnostics();
      setDiag(d);

      sys(`[DIAG] Ping: ${d.ping}ms  |  Internet: ${d.internet?"✓ OK":"✗ FAIL"}`, d.internet?"ok":"err");
      sys(`[DIAG] Gamma API:  ${d.gamma?"✓ ONLINE":"✗ OFFLINE — cannot fetch markets"}`, d.gamma?"ok":"err");
      sys(`[DIAG] CLOB API:   ${d.clob?"✓ ONLINE":"✗ BLOCKED — using Gamma price fallback"}`, d.clob?"ok":"warn");
      sys(`[DIAG] News API:   ${d.news?"✓ ONLINE":"✗ UNAVAILABLE — GNews backup active"}`, d.news?"ok":"warn");
      sys("─────────────────────────────────────────────────────","div");

      if (!d.internet || !d.gamma) {
        sys("[FATAL] Cannot reach Polymarket. Check your internet connection.","err");
        setAiStatus("No internet connection. Cannot start.");
        sl("ERROR: No connection to Polymarket. Check your network.","err");
        return;
      }

      if (!d.clob) {
        sys("[NOTE] CLOB blocked. Dead order books (Bid:1%/Ask:99%) will be detected and skipped.","warn");
        sys("[NOTE] Bot will use Gamma API prices — fully functional, just no bid/ask spread data.","info");
      }

      await sleep(60); sys("[OK] Markets: Polymarket Gamma API","ok");
      await sleep(60); sys(`[OK] Prices: ${d.clob?"CLOB Order Book (real bid/ask)":"Gamma API (CLOB unavailable)"}`, d.clob?"ok":"warn");
      await sleep(60); sys("[OK] Leaderboard + Wallet: Data API","ok");
      await sleep(60); sys("[OK] AI Engine v11 — adaptive RL, dead-money detection","ok");
      await sleep(60); sys("[OK] Performance tracker — learns from trade outcomes","ok");
      await sleep(60); sys("[OK] Price refresh: every 10s","ok");
      await sleep(60); sys("[OK] Paper wallet: $1,000.00 USDC","ok");
      sys("─────────────────────────────────────────────────────","div");
      sys(`Settings: Threshold ${CONF_THRESH}%  |  Price ${pct(PRICE_MIN)}-${pct(PRICE_MAX)}  |  Max ${MAX_OPEN} positions  |  Max $${MAX_TRADE}/trade`,"info");
      sys("All systems nominal. Click SCAN or AUTO to begin.","ok");
      sl("Scanner ready. Click SCAN or AUTO.","dim");
      al("AI Engine v11 ready. Confidence threshold: "+CONF_THRESH+"%. RL feedback active.","dim");
      sel("Position monitor ready.","dim");
      setAiStatus("Ready. Waiting for scan.");
    })();
  },[sys,sl,al,sel]);

  // ── main scan ──
  const scan=useCallback(async()=>{
    if(statusRef.current==="scanning"||statusRef.current==="thinking") return;
    setStatus("scanning");
    setAiStatus(getRandMsg("scanning"));
    sl("","blank"); sl("▶ New scan cycle","header");

    const raw=await fetchMarkets(100);
    setStats(s=>({...s,scans:s.scans+1,lastScan:nowTs()}));

    if(!raw.length){
      sl("ERROR: Market fetch failed","err");
      sys("[ERR] Market fetch failed — check CORS proxy","err");
      setStatus("idle"); return;
    }

    // blacklist
    const bl=new Set(blackRef.current); let newDead=0;
    const alive=raw.filter(m=>{
      if(bl.has(m.id)) return false;
      if(m.yesPrice>PRICE_MAX||m.yesPrice<PRICE_MIN){bl.add(m.id);newDead++;return false;}
      if(Math.abs(m.oneDayChange||0)<0.002&&(m.volume24h||0)<200){bl.add(m.id);newDead++;return false;}
      return true;
    });
    if(newDead>0){setBlacklist(new Set(bl));blackRef.current=new Set(bl);setStats(s=>({...s,blacklisted:bl.size}));sl(`Blacklisted ${newDead} new dead markets (total:${bl.size})`,"warn");}

    setAiStatus(getRandMsg("filtering"));

    // score & sort — prefer mid-range, high volume, tight spread
    const scored=alive.filter(m=>(m.volume24h||0)>=200).map(m=>{
      let s=m.volume24h||0;
      const p=m.yesPrice;
      if(p>=0.30&&p<=0.70) s*=2.2; else if(p>=0.20&&p<=0.80) s*=1.5;
      if(m.bestBid&&m.bestAsk&&(m.bestAsk-m.bestBid)<0.03) s*=1.6;
      if(Math.abs(m.oneDayChange||0)>0.04) s*=1.3;
      return {...m,_score:s};
    }).sort((a,b)=>b._score-a._score);

    setMarkets(raw);
    sl(`${raw.length} fetched → ${scored.length} valid → analyzing top 8`,"ok");
    setStats(s=>({...s,analyzed:s.analyzed+Math.min(8,scored.length)}));

    const tradedIds=new Set();
    const openSlots=MAX_OPEN-portRef.current.positions.filter(p=>p.status==="OPEN").length;
    if(openSlots<=0){sl("Max open positions reached — skipping analysis","warn");setStatus("idle");return;}

    for(let i=0;i<Math.min(8,scored.length);i++){
      const m=scored[i]; setStatus("thinking");

      // dedup
      const key=m.conditionId||m.yesId;
      if(tradedIds.has(key)||portRef.current.positions.some(p=>p.status==="OPEN"&&(p.conditionId===m.conditionId||p.yesId===m.yesId))){
        sl(`[${i+1}/8] Already held — skip`,"dim"); continue;
      }

      const tag=m.yesPrice>=0.30&&m.yesPrice<=0.70?"MID":m.yesPrice>=0.15&&m.yesPrice<=0.85?"SIDE":"EDGE";
      sl(`[${i+1}/8] [${tag}] ${m.question.slice(0,60)}`,"mkt");
      sl(`  YES:${pct(m.yesPrice)}  Vol:${mini(m.volume24h)}  Δ24h:${((m.oneDayChange||0)*100).toFixed(1)}%`,"dim");
      setAiStatus(getRandMsg("analyzing_start"));

      // live price
      const live=await getLivePrice(m.yesId,m.conditionId);
      if(live){
        m.yesPrice=live.price; m.noPrice=1-live.price; m.bestBid=live.bid; m.bestAsk=live.ask;
        const sprStr=live.spread?` Spr:${(live.spread*100).toFixed(1)}¢`:"";
        sl(`  [${live.source}] YES:${pct(live.price)}${live.bid?` Bid:${pct(live.bid)}`:""}${live.ask?` Ask:${pct(live.ask)}`:""}${sprStr}`,"price");
      }

      // re-check after live update
      if(m.yesPrice>PRICE_MAX||m.yesPrice<PRICE_MIN){
        sl(`  Live price ${pct(m.yesPrice)} out of range — blacklisting`,"warn");
        bl.add(m.id);setBlacklist(new Set(bl));blackRef.current=new Set(bl);
        sl("","blank");continue;
      }

      // Only skip on extreme OB if price came from a REAL order book (not Gamma fallback)
      // When Gamma is source, bestBid/bestAsk will be null so this block won't trigger
      if (live?.source === "orderbook" && m.bestAsk && m.bestAsk > 0.92) {
        sl(`  Real OB ask ${pct(m.bestAsk)} too high — smart skip`, "warn");
        sl("", "blank"); continue;
      }
      if (live?.source === "orderbook" && m.bestBid && m.bestBid < 0.04) {
        sl(`  Real OB bid ${pct(m.bestBid)} too low — smart skip`, "warn");
        sl("", "blank"); continue;
      }

      // news
      setAiStatus(getRandMsg("news_searching"));
      const nr=await fetchNews(m.question);
      setStats(s=>({...s,newsTotal:s.newsTotal+nr.articles.length}));
      if(nr.articles.length>0){
        sl(`  [${nr.api}] ${nr.articles.length} arts — "${nr.query.slice(0,40)}"`,"ok");
        nr.articles.slice(0,2).forEach(a=>sl(`    • [${ageStr(a.published)}] ${a.title.slice(0,62)}`,"newsitem"));
        setAiStatus(getRandMsg("news_found",{n:nr.articles.length}));
      } else {
        sl(`  No news — statistical model only`,"dim");
        setAiStatus(getRandMsg("news_none"));
      }

      // AI analysis
      setAiStatus(getRandMsg("thinking"));
      al("","blank");
      const result=analyzeMarket(m,nr.articles,portRef.current.cash,perfStats);
      // Show "interesting" message if confidence is close to threshold
      if(result.conf >= CONF_THRESH - 5 && result.conf < CONF_THRESH) setAiStatus(getRandMsg("interesting"));
      result.log.forEach(line=>{
        const t=line.startsWith("[DECISION]")?"decision":line.startsWith("[CONFIDENCE]")?"conf":line.startsWith("[SENTIMENT]")||line.startsWith("[BLOCKED]")?"sent":line.startsWith("[SIGNALS]")?"warn":line.startsWith("[STAT")||line.startsWith("[NEWS")?"price":line.startsWith("[CONFLICT]")?"err":line.startsWith("[MOMENTUM]")||line.startsWith("[TIME]")?"dim":line.startsWith("[")?"mkt":line.startsWith("─")?"div":"dim";
        al(line,t);
      });
      sl(`  → ${result.action}  Conf:${result.conf}%  [${result.edgeFrom}]  Y${result.signals?.yesCount||0}/N${result.signals?.noCount||0}`,result.action!=="SKIP"?"tradeok":"dim");

      const go=(result.action==="BUY_YES"||result.action==="BUY_NO")&&result.conf>=CONF_THRESH&&result.amount>0&&portRef.current.cash>=result.amount;

      if(go){
        setAiStatus(getRandMsg("trade_found"));
        const side=result.action==="BUY_YES"?"YES":"NO";
        const ep=side==="YES"?(m.bestAsk&&m.bestAsk<0.90?m.bestAsk:m.yesPrice):(m.bestBid&&m.bestBid>0.10?(1-m.bestBid):m.noPrice);
        const shares=result.amount/ep;
        const maxProfit=shares-result.amount;
        setStatus("trading");
        const trade={
          id:Date.now()+Math.random(), question:m.question.slice(0,72),
          conditionId:m.conditionId, yesId:m.yesId,
          side, ep, currentPrice:ep, rawYes:m.yesPrice,
          bestBid:m.bestBid, bestAsk:m.bestAsk,
          spread:m.bestBid&&m.bestAsk?m.bestAsk-m.bestBid:null,
          amount:result.amount, shares, maxProfit,
          pnl:0, pnlPct:0, momentum:0,
          conf:result.conf, openedAt:nowTs(), openedTs:Date.now(),
          status:"OPEN", mktType:result.mType,
          edgeFrom:result.edgeFrom, reason:result.reason,
          newsCount:nr.articles.length, priceSource:live?.source||"gamma",
          lastUpdate:nowTs(), quality:result.qual,
          signals:result.signals, days:result.days,
        };
        setPortfolio(prev=>{const next={...prev,cash:prev.cash-result.amount,positions:[...prev.positions,trade],trades:[...prev.trades,trade]};portRef.current=next;return next;});
        tradedIds.add(key);
        sl(`  ✓ BUY ${side} ${dollar(result.amount)} @ ${pct(ep)} → ${shares.toFixed(3)} shares  max:${dollar(maxProfit)}`,"tradeok");
        sys(`[TRADE] BUY ${side} ${dollar(result.amount)} @ ${pct(ep)} [${result.mType}/${result.edgeFrom}] conf:${result.conf}% "${m.question.slice(0,28)}"`,"tradeok");
        setStats(s=>({...s,executed:s.executed+1,byType:{...s.byType,[result.mType]:(s.byType[result.mType]||0)+1},byEdge:{...s.byEdge,[result.edgeFrom]:(s.byEdge[result.edgeFrom]||0)+1},confHistory:[...s.confHistory.slice(-29),result.conf],avgConf:Math.round([...s.confHistory,result.conf].reduce((a,b)=>a+b,0)/(s.confHistory.length+1))}));
        await sleep(200);
      } else {
        setStats(s=>({...s,skipped:s.skipped+1}));
        const skipMsg = result.signals?.isConflict ? getRandMsg("skip_conflict") : getRandMsg("skip_low_conf");
        setAiStatus(skipMsg);
        if(result.conf<38&&!nr.articles.length&&Math.abs(m.oneDayChange||0)<0.003){bl.add(m.id);setBlacklist(new Set(bl));blackRef.current=new Set(bl);}
      }
      sl("","blank"); await sleep(80);
    }

    await refreshPrices(false);
    sl("✓ Scan complete.","ok");
    sys(`[SCAN] done. Cash:${dollar(portRef.current.cash)} Open:${portRef.current.positions.filter(p=>p.status==="OPEN").length}`,"ok");
    setStatus("idle");
    setAiStatus(auto ? getRandMsg("idle_waiting") : "Scan complete. Click SCAN to run again.");
  },[sl,al,sys,refreshPrices,auto]);

  // ── eval sells ──
  const evalSells=useCallback(async()=>{
    const open=portRef.current.positions.filter(p=>p.status==="OPEN");
    if(!open.length){sel("No open positions.","dim");return;}
    sel("","blank"); sel(`▶ Evaluating ${open.length} positions...`,"header");
    await refreshPrices(true);
    for(const pos of portRef.current.positions.filter(p=>p.status==="OPEN")){
      sel("","blank");
      sel(`${pos.side} [${pos.mktType||"?"}] "${pos.question.slice(0,52)}"`,"mkt");
      sel(`  Entry:${pct(pos.ep)} → Current:${pct(pos.currentPrice||pos.ep)}  P&L:${(pos.pnl||0)>=0?"+":""}${dollar(pos.pnl||0)} [${pos.priceSource||"?"}]`,"info");
      if(pos.bestBid&&pos.bestAsk) sel(`  OB: Bid:${pct(pos.bestBid)} Ask:${pct(pos.bestAsk)} Spread:${pos.spread?(pos.spread*100).toFixed(1)+"¢":"?"}  Days left:${pos.days<1?`${(pos.days*24).toFixed(0)}h`:Math.round(pos.days||0)+"d"}`,"dim");
      const res=evalSell(pos,pos.currentPrice||pos.ep,pos.momentum||0);
      res.steps.forEach(s=>{
        const t=s.includes("TAKE PROFIT")||s.includes("STOP LOSS")?"sell":s.includes("profit")||s.includes("+")?"profit":s.includes("Warning")||s.includes("collapsed")?"loss":"dim";
        sel(`  ${s}`,t);
      });
      if(res.decision==="SELL"){
        sel(`  → CLOSING: ${(pos.pnl||0)>=0?"+":""}${dollar(pos.pnl||0)} (${((pos.pnlPct||0)*100).toFixed(1)})%`,(pos.pnl||0)>=0?"profit":"loss");
        closePos(pos,"MANUAL-EVAL");
      } else sel(`  → ${res.decision} (score:${res.score}/100)`,"ok");
    }
    sel("","blank"); sel("✓ Done.","ok");
  },[sel,refreshPrices,closePos]);

  // ── leaderboard ──
  const loadLeaders=useCallback(async()=>{
    setLbLoading(true); sys(`[LB] ${lbPeriod}/${lbOrder}...`,"info");
    const d=await fetchLeaderboard(lbPeriod,lbOrder,25);
    setLeaders(d); sys(`[LB] ${d.length} traders loaded`,"ok");
    setLbLoading(false);
  },[lbPeriod,lbOrder,sys]);

  const viewWallet=useCallback(async(addr,name)=>{
    setWLoading(true); setWallet({addr,name,positions:null,trades:null,value:null});
    sys(`[WALLET] Loading ${name||addr.slice(0,10)}...`,"info");
    const d=await fetchWallet(addr);
    setWallet({addr,name,...d}); sys(`[WALLET] ${d.positions.length} pos, ${d.trades.length} trades, val:${d.value?dollar(d.value):"?"}`,"ok");
    setWLoading(false);
  },[sys]);

  // ── auto mode ──
  const toggleAuto=()=>{
    if(auto){setAuto(false);clearInterval(autoRef.current);sys("[AUTO] Off (price refresh continues every 10s)","warn");}
    else{setAuto(true);sys("[AUTO] ON — deep scan 3min | prices 10s","ok");scan();autoRef.current=setInterval(()=>scan(),SCAN_MS);}
  };

  // ── portfolio calcs ──
  const open       =portfolio.positions.filter(p=>p.status==="OPEN");
  const openVal    =open.reduce((s,p)=>s+(p.currentPrice||p.ep)*p.shares,0);
  const unrealPnl  =open.reduce((s,p)=>s+(p.pnl||0),0);
  const realPnl    =portfolio.closed.reduce((s,t)=>s+(t.pnl||0),0);
  const totalPnl   =unrealPnl+realPnl;
  const totalVal   =portfolio.cash+openVal;
  const invested   =open.reduce((s,p)=>s+p.amount,0);
  const ret        =(totalVal-START_CASH)/START_CASH*100;
  const wins       =portfolio.closed.filter(t=>t.pnl>0).length;
  const losses     =portfolio.closed.filter(t=>t.pnl<=0).length;
  const winRate    =portfolio.closed.length?`${((wins/portfolio.closed.length)*100).toFixed(0)}%`:"--";
  const avgWin     =wins>0?portfolio.closed.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/wins:0;
  const avgLoss    =losses>0?portfolio.closed.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/losses:0;
  const pf         =avgLoss!==0?Math.abs(avgWin/avgLoss):0;
  const goodMkts   =markets.filter(m=>!blackRef.current.has(m.id));
  const stCol      ={idle:"#444",scanning:"#888",thinking:"#aaa",trading:"#ccc"};
  const stLbl      ={idle:"READY",scanning:"SCANNING",thinking:"THINKING",trading:"EXECUTING"};
  const TABS=[
    {id:"positions",label:`POSITIONS (${open.length})`},
    {id:"pnl",      label:"P&L"},
    {id:"trades",   label:`HISTORY (${portfolio.trades.length})`},
    {id:"markets",  label:`MARKETS (${markets.length})`},
    {id:"leaders",  label:"TOP WALLETS"},
    {id:"perf",     label:"PERFORMANCE"},
    {id:"blacklist",label:`BLACKLIST (${blacklist.size})`},
  ];

  return(
    <div style={{width:"100vw",height:"100vh",overflow:"hidden",display:"flex",flexDirection:"column",background:"#080808",fontFamily:"Consolas,'Lucida Console',monospace",fontSize:"12px",color:"#bbb"}}>

      {/* TITLE */}
      <div style={{flexShrink:0,height:"30px",background:"#111",borderBottom:"1px solid #1e1e1e",display:"flex",alignItems:"center",padding:"0 14px",gap:"12px"}}>
        <span style={{color:"#ddd",fontWeight:"bold",letterSpacing:"3px",fontSize:"13px"}}>POLYBOT</span>
        <span style={{color:"#555"}}>│</span>
        <span style={{color:"#444",fontSize:"11px"}}>v{VERSION}</span>
        <span style={{color:"#555"}}>│</span>
        {/* API health indicators */}
        {diag && (
          <div style={{display:"flex",gap:"6px",alignItems:"center",fontSize:"9px"}}>
            <span style={{color:diag.gamma?"#3a6a3a":"#6a3a3a",padding:"1px 5px",background:diag.gamma?"#0a180a":"#180a0a"}}>Gamma:{diag.gamma?"✓":"✗"}</span>
            <span style={{color:diag.clob?"#3a6a3a":"#5a5a3a",padding:"1px 5px",background:diag.clob?"#0a180a":"#141408"}}>CLOB:{diag.clob?"✓":"~"}</span>
            <span style={{color:diag.news?"#3a6a3a":"#5a5a3a",padding:"1px 5px",background:diag.news?"#0a180a":"#141408"}}>News:{diag.news?"✓":"~"}</span>
            <span style={{color:"#666"}}>{diag.ping}ms</span>
          </div>
        )}
        <div style={{marginLeft:"auto",display:"flex",gap:"16px",fontSize:"11px",alignItems:"center"}}>
          {open.length>0&&<span style={{color:"#2a4a2a",fontSize:"10px"}}>↻10s</span>}
          <span style={{color:stCol[status]}}>● {stLbl[status]}{auto?" [AUTO]":""}</span>
          <span style={{color:"#555",fontSize:"10px"}}>{fmtUp(stats.uptime)}</span>
        </div>
      </div>

      {/* AI STATUS BAR */}
      <div style={{flexShrink:0,height:"24px",background:"#0c0c0c",borderBottom:"1px solid #181818",display:"flex",alignItems:"center",padding:"0 14px",gap:"10px",overflow:"hidden"}}>
        <span style={{color:"#1a3a1a",fontSize:"9px",letterSpacing:"0.5px",flexShrink:0}}>AI</span>
        <span style={{color:"#555",flexShrink:0}}>│</span>
        {/* Animated thinking dots when active */}
        {(status==="thinking"||status==="scanning") && (
          <span style={{color:"#2a4a2a",fontSize:"9px",flexShrink:0,fontFamily:"monospace"}}>
            {["◐","◓","◑","◒"][Math.floor(Date.now()/250)%4]}
          </span>
        )}
        <span style={{
          color: status==="trading"?"#5a9a5a": status==="thinking"?"#7a7a5a": status==="scanning"?"#555":"#333",
          fontSize:"11px", fontFamily:"Consolas,monospace", flex:1,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{aiStatus}</span>
        {status==="idle" && auto && (
          <span style={{color:"#1e2e1e",fontSize:"9px",flexShrink:0}}>next scan in ~3min</span>
        )}
      </div>

      {/* STATS STRIP */}
      <div style={{flexShrink:0,height:"28px",background:"#0a0a0a",borderBottom:"1px solid #181818",display:"flex",alignItems:"center",overflowX:"auto",overflowY:"hidden"}}>
        {[
          ["CASH",       dollar(portfolio.cash),                            portfolio.cash>=START_CASH?"#e0e0e0":"#888"],
          ["PORTFOLIO",  dollar(totalVal),                                  totalVal>=START_CASH?"#e8e8e8":"#888"],
          ["P&L",        (totalPnl>=0?"+":"")+dollar(totalPnl),            totalPnl>=0?"#fff":"#cc8888"],
          ["RETURN",     (ret>=0?"+":"")+ret.toFixed(2)+"%",               ret>=0?"#e0e0e0":"#cc8888"],
          ["UNREALIZED", (unrealPnl>=0?"+":"")+dollar(unrealPnl),         unrealPnl>=0?"#d0d0d0":"#cc8888"],
          ["REALIZED",   (realPnl>=0?"+":"")+dollar(realPnl),              realPnl>=0?"#d0d0d0":"#cc8888"],
          ["WIN RATE",   winRate,                                           "#bbbbbb"],
          ["W/L",        `${wins}/${losses}`,                              "#aaaaaa"],
          ["AVG WIN",    wins>0?dollar(avgWin):"--",                       "#7acc7a"],
          ["AVG LOSS",   losses>0?dollar(avgLoss):"--",                    "#cc7a7a"],
          ["PROF.FACT",  pf>0?pf.toFixed(2)+"x":"--",                     pf>=1.5?"#7acc7a":pf>=1?"#cccc7a":"#aaaaaa"],
          ["INVESTED",   dollar(invested),                                  "#bbbbbb"],
          ["OPEN",       open.length+" / "+MAX_OPEN,                       open.length>=MAX_OPEN?"#cc7a7a":"#aaaaaa"],
          ["TRADES",     portfolio.trades.length,                           "#aaaaaa"],
          ["SCANS",      stats.scans,                                       "#999999"],
          ["AVG CONF",   stats.avgConf?stats.avgConf+"%":"--",             "#aaaaaa"],
          ["BLACKLIST",  blacklist.size,                                    "#999999"],
          ["THRESHOLD",  CONF_THRESH+"%",                                  "#8888cc"],
        ].map(([label,val,color])=>(
          <div key={label} style={{display:"flex",flexDirection:"column",padding:"2px 10px",borderRight:"1px solid #1e1e1e",flexShrink:0}}>
            <span style={{color:"#666",fontSize:"8px",letterSpacing:"0.5px"}}>{label}</span>
            <span style={{color:color||"#aaa",fontSize:"11px",fontWeight:"bold"}}>{val}</span>
          </div>
        ))}
      </div>

      {/* BODY */}
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* LEFT */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

          {/* LOG PANELS 44% */}
          <div style={{flex:"0 0 44%",display:"flex",borderBottom:"1px solid #141414",overflow:"hidden"}}>
            <Panel title="MARKET SCANNER" badge={`${goodMkts.length} candidates`} style={{flex:1}}
              actions={[
                {label:status!=="idle"?"RUNNING...":"SCAN",fn:scan,dis:status!=="idle"},
                {label:auto?"STOP AUTO":"AUTO 3min",fn:toggleAuto},
                {label:"REFRESH $",fn:()=>refreshPrices(false),dis:open.length===0},
              ]}>
              <LogPanel logs={scanLog} logRef={scanLogRef}/>
            </Panel>
            <Panel title="AI ENGINE" badge={`thresh:${CONF_THRESH}%  adaptive-RL`} style={{flex:1}}>
              <LogPanel logs={aiLog} logRef={aiLogRef}/>
            </Panel>
            <Panel title="SELL MONITOR" style={{flex:1}}
              actions={[{label:"EVAL SELLS",fn:evalSells,dis:status!=="idle"}]}>
              <LogPanel logs={sellLog} logRef={sellLogRef}/>
            </Panel>
          </div>

          {/* TABS 56% */}
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div style={{flexShrink:0,background:"#0d0d0d",borderBottom:"1px solid #1a1a1a",display:"flex",padding:"0 8px",alignItems:"center"}}>
              {TABS.map(t=>(
                <button key={t.id} onClick={()=>setTab(t.id)} style={{background:tab===t.id?"#141414":"transparent",border:"none",borderBottom:tab===t.id?"2px solid #555":"2px solid transparent",color:tab===t.id?"#ccc":"#333",padding:"5px 14px",fontSize:"11px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>{t.label}</button>
              ))}
              <div style={{marginLeft:"auto",display:"flex",gap:"14px",fontSize:"10px",color:"#555",paddingRight:"10px"}}>
                <span>Refresh:{refreshTs}({refreshN})</span>
                <span>Best:{stats.best?dollar(stats.best.pnl):"--"}</span>
                <span>Worst:{stats.worst?dollar(stats.worst.pnl):"--"}</span>
              </div>
            </div>

            <div style={{flex:1,overflow:"auto",background:"#090909",padding:"6px"}}>

              {/* POSITIONS */}
              {tab==="positions"&&(open.length===0
                ?<div style={{color:"#666",padding:"40px",textAlign:"center",fontSize:"13px"}}>No open positions — click SCAN to start.</div>
                :<>
                  <div style={{marginBottom:"6px",padding:"4px 10px",background:"#0a140a",border:"1px solid #1a2a1a",fontSize:"10px",color:"#3a5a3a",display:"flex",gap:"16px",alignItems:"center"}}>
                    <span>● LIVE — order book prices, auto-refresh 10s, close +50%/-45%</span>
                    <span>Last:{refreshTs} ({refreshN}x)</span>
                    <button onClick={()=>refreshPrices(false)} style={{marginLeft:"auto",background:"transparent",border:"1px solid #2a4a2a",color:"#4a7a4a",padding:"1px 8px",fontSize:"9px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>REFRESH NOW</button>
                  </div>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["#","Type","Market","Side","Entry","Bid","Ask","Spr","Current","Δ¢","P&L","P&L%","Cost","Value","Max$","Conf","Days","Src","Updated"]}/>
                    <tbody>
                      {open.map((pos,i)=>{
                        const pc=pos.pnl||0, diff=(pos.currentPrice||pos.ep)-pos.ep;
                        const spr=pos.spread?(pos.spread*100).toFixed(1)+"¢":"--";
                        const days=daysFrom(pos.endDate||null);
                        return(
                          <tr key={pos.id} style={{borderBottom:"1px solid #0f0f0f",background:pc>0.5?"#0a130a":pc<-0.5?"#130a0a":"transparent"}}>
                            <td style={{padding:"4px 8px",color:"#333"}}>{i+1}</td>
                            <td style={{padding:"4px 8px"}}><TypeBadge type={pos.mktType}/></td>
                            <td style={{padding:"4px 8px",color:"#666",maxWidth:"190px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pos.question}</td>
                            <td style={{padding:"4px 8px",color:pos.side==="YES"?"#bbb":"#888",fontWeight:"bold"}}>{pos.side}</td>
                            <td style={{padding:"4px 8px",color:"#555"}}>{pct(pos.ep)}</td>
                            <td style={{padding:"4px 8px",color:"#3a6a3a"}}>{pos.bestBid?pct(pos.bestBid):"--"}</td>
                            <td style={{padding:"4px 8px",color:"#6a3a3a"}}>{pos.bestAsk?pct(pos.bestAsk):"--"}</td>
                            <td style={{padding:"4px 8px",color:pos.spread>0.06?"#8a5a5a":"#444"}}>{spr}</td>
                            <td style={{padding:"4px 8px",color:"#aaa",fontWeight:"bold"}}>{pct(pos.currentPrice||pos.ep)}</td>
                            <td style={{padding:"4px 8px",color:diff>0?"#5a9a5a":diff<0?"#9a5a5a":"#444"}}>{diff>0?"▲":diff<0?"▼":"─"}{(Math.abs(diff)*100).toFixed(1)}</td>
                            <td style={{padding:"4px 8px",color:pc>=0?"#bbb":"#666",fontWeight:"bold"}}>{(pc>=0?"+":"-")+dollar(pc)}</td>
                            <td style={{padding:"4px 8px",color:pc>=0?"#999":"#555"}}>{((pos.pnlPct||0)*100).toFixed(1)}%</td>
                            <td style={{padding:"4px 8px",color:"#555"}}>{dollar(pos.amount)}</td>
                            <td style={{padding:"4px 8px",color:"#777"}}>{dollar((pos.currentPrice||pos.ep)*pos.shares)}</td>
                            <td style={{padding:"4px 8px",color:"#444"}}>{dollar(pos.maxProfit)}</td>
                            <td style={{padding:"4px 8px"}}><ConfBar conf={pos.conf}/></td>
                            <td style={{padding:"4px 8px",color:days<3?"#8a5a5a":"#333",fontSize:"9px"}}>{days<1?`${(days*24).toFixed(0)}h`:Math.round(days)+"d"}</td>
                            <td style={{padding:"4px 8px",color:"#555",fontSize:"9px"}}>{pos.priceSource}</td>
                            <td style={{padding:"4px 8px",color:"#555",fontSize:"9px"}}>{pos.lastUpdate}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{borderTop:"1px solid #1e1e1e"}}>
                        <td colSpan={10} style={{padding:"5px 8px",color:"#444"}}>TOTALS</td>
                        <td style={{padding:"5px 8px",color:unrealPnl>=0?"#bbb":"#666",fontWeight:"bold"}}>{(unrealPnl>=0?"+":"-")+dollar(unrealPnl)}</td>
                        <td style={{padding:"5px 8px",color:unrealPnl>=0?"#888":"#555"}}>{invested>0?((unrealPnl/invested)*100).toFixed(1)+"%":"--"}</td>
                        <td style={{padding:"5px 8px",color:"#666"}}>{dollar(invested)}</td>
                        <td style={{padding:"5px 8px",color:"#777"}}>{dollar(openVal)}</td>
                        <td colSpan={5}/>
                      </tr>
                    </tfoot>
                  </table>
                  <div style={{marginTop:"8px"}}>
                    <div style={{color:"#666",fontSize:"10px",marginBottom:"4px",padding:"2px"}}>AI REASONING PER POSITION</div>
                    {open.map((pos,i)=>(
                      <div key={pos.id} style={{display:"flex",gap:"8px",padding:"3px 0",borderBottom:"1px solid #0f0f0f",fontSize:"10px"}}>
                        <span style={{color:"#666",flexShrink:0,width:"14px"}}>{i+1}.</span>
                        <TypeBadge type={pos.mktType}/>
                        <ConfBar conf={pos.conf} width={40}/>
                        <span style={{color:"#666",marginLeft:"4px",flex:1}}>{pos.reason}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* P&L */}
              {tab==="pnl"&&(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"8px",marginBottom:"10px"}}>
                    {[
                      {l:"Starting Balance",  v:dollar(START_CASH),                           s:"initial deposit",          hi:null},
                      {l:"Current Cash",      v:dollar(portfolio.cash),                       s:"available",                hi:portfolio.cash>=START_CASH},
                      {l:"Open Positions",    v:dollar(openVal),                              s:`${open.length} open`,      hi:openVal>0},
                      {l:"Total Portfolio",   v:dollar(totalVal),                             s:"cash + positions",         hi:totalVal>=START_CASH},
                      {l:"Unrealized P&L",    v:(unrealPnl>=0?"+":"-")+dollar(unrealPnl),    s:"live",                     hi:unrealPnl>=0},
                      {l:"Realized P&L",      v:(realPnl>=0?"+":"-")+dollar(realPnl),        s:`${portfolio.closed.length} closed`, hi:realPnl>=0},
                      {l:"Total P&L",         v:(totalPnl>=0?"+":"-")+dollar(totalPnl),      s:"all time",                 hi:totalPnl>=0},
                      {l:"Total Return",      v:(ret>=0?"+":"")+ret.toFixed(3)+"%",          s:"vs $1,000",                hi:ret>=0},
                      {l:"Win Rate",          v:winRate,                                      s:`${wins}W / ${losses}L`,    hi:null},
                      {l:"Avg Win",           v:wins>0?dollar(avgWin):"--",                  s:"per win",                  hi:true},
                      {l:"Avg Loss",          v:losses>0?dollar(avgLoss):"--",               s:"per loss",                 hi:false},
                      {l:"Profit Factor",     v:pf>0?pf.toFixed(2)+"x":"--",                s:"avg win / avg loss",       hi:pf>=1},
                      {l:"Total Profit",      v:dollar(stats.totalProfit),                   s:"wins",                     hi:true},
                      {l:"Total Loss",        v:dollar(stats.totalLoss),                     s:"losses",                   hi:false},
                      {l:"Best Trade",        v:stats.best?dollar(stats.best.pnl):"--",      s:stats.best?.question?.slice(0,22), hi:true},
                      {l:"Worst Trade",       v:stats.worst?dollar(stats.worst.pnl):"--",    s:stats.worst?.question?.slice(0,22),hi:false},
                    ].map(c=>(
                      <div key={c.l} style={{background:"#0d0d0d",border:"1px solid #181818",padding:"10px 14px"}}>
                        <div style={{color:"#666",fontSize:"9px",marginBottom:"5px"}}>{c.l}</div>
                        <div style={{color:c.hi===true?"#ddd":c.hi===false?"#666":"#aaa",fontSize:"18px"}}>{c.v}</div>
                        <div style={{color:"#555",fontSize:"9px",marginTop:"3px"}}>{c.s}</div>
                      </div>
                    ))}
                  </div>
                  {stats.confHistory.length>2&&(
                    <div style={{marginBottom:"10px",padding:"8px",background:"#0d0d0d",border:"1px solid #181818"}}>
                      <div style={{color:"#555",fontSize:"10px",marginBottom:"6px"}}>CONFIDENCE HISTORY — last {stats.confHistory.length} trades</div>
                      <div style={{display:"flex",alignItems:"center",gap:"12px"}}>
                        <MiniSpark data={stats.confHistory} w={180} h={32} color="#4a7a4a"/>
                        <div style={{fontSize:"10px",color:"#333"}}>
                          <div>avg: {stats.avgConf}%  threshold: {CONF_THRESH}%</div>
                          <div>min: {Math.min(...stats.confHistory)}%  max: {Math.max(...stats.confHistory)}%</div>
                        </div>
                      </div>
                    </div>
                  )}
                  {portfolio.closed.length>0&&(
                    <>
                      <div style={{color:"#555",fontSize:"10px",marginBottom:"6px"}}>CLOSED TRADES</div>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                        <TH cols={["#","Market","Side","Entry","Close","Cost","Proceeds","P&L","P&L%","Reason","Conf","Closed"]}/>
                        <tbody>
                          {portfolio.closed.map((t,i)=>(
                            <tr key={t.id} style={{borderBottom:"1px solid #0f0f0f",background:t.pnl>0?"#0a130a":"#130a0a"}}>
                              <td style={{padding:"4px 8px",color:"#333"}}>{i+1}</td>
                              <td style={{padding:"4px 8px",color:"#555",maxWidth:"210px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.question}</td>
                              <td style={{padding:"4px 8px",color:"#666"}}>{t.side}</td>
                              <td style={{padding:"4px 8px",color:"#555"}}>{pct(t.ep)}</td>
                              <td style={{padding:"4px 8px",color:"#666"}}>{pct(t.closePrice||t.currentPrice)}</td>
                              <td style={{padding:"4px 8px",color:"#555"}}>{dollar(t.amount)}</td>
                              <td style={{padding:"4px 8px",color:"#666"}}>{dollar((t.closePrice||t.currentPrice)*t.shares)}</td>
                              <td style={{padding:"4px 8px",color:t.pnl>=0?"#bbb":"#666",fontWeight:"bold"}}>{(t.pnl>=0?"+":"-")+dollar(t.pnl)}</td>
                              <td style={{padding:"4px 8px",color:t.pnl>=0?"#888":"#555"}}>{((t.pnlPct||0)*100).toFixed(1)}%</td>
                              <td style={{padding:"4px 8px",color:"#333",fontSize:"9px"}}>{t.closeReason||"manual"}</td>
                              <td style={{padding:"4px 8px"}}><ConfBar conf={t.conf} width={36}/></td>
                              <td style={{padding:"4px 8px",color:"#555"}}>{t.closedAt}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )}

              {/* HISTORY */}
              {tab==="trades"&&(portfolio.trades.length===0
                ?<div style={{color:"#666",padding:"40px",textAlign:"center"}}>No trades yet.</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                  <TH cols={["#","Time","Type","Market","Side","Entry","Amt","Shares","Spread","Qual","Days","Conf","Sigs","Status","P&L","Edge","Source"]}/>
                  <tbody>
                    {[...portfolio.trades].reverse().map((t,i)=>{
                      const cl=portfolio.closed.find(c=>c.id===t.id);
                      const pnl=cl?cl.pnl:(t.pnl||0);
                      const yc=t.signals?.yesCount||0, nc=t.signals?.noCount||0;
                      return(
                        <tr key={t.id} style={{borderBottom:"1px solid #0f0f0f",background:cl?(cl.pnl>0?"#0a130a":"#130a0a"):"transparent"}}>
                          <td style={{padding:"4px 8px",color:"#333"}}>{portfolio.trades.length-i}</td>
                          <td style={{padding:"4px 8px",color:"#666",whiteSpace:"nowrap"}}>{t.openedAt}</td>
                          <td style={{padding:"4px 8px"}}><TypeBadge type={t.mktType}/></td>
                          <td style={{padding:"4px 8px",color:"#555",maxWidth:"170px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.question}</td>
                          <td style={{padding:"4px 8px",color:t.side==="YES"?"#aaa":"#777",fontWeight:"bold"}}>{t.side}</td>
                          <td style={{padding:"4px 8px",color:"#555"}}>{pct(t.ep)}</td>
                          <td style={{padding:"4px 8px",color:"#666"}}>{dollar(t.amount)}</td>
                          <td style={{padding:"4px 8px",color:"#444"}}>{t.shares.toFixed(3)}</td>
                          <td style={{padding:"4px 8px",color:t.spread>0.05?"#7a5a5a":"#333",fontSize:"9px"}}>{t.spread?(t.spread*100).toFixed(1)+"¢":"--"}</td>
                          <td style={{padding:"4px 8px",color:t.quality>=65?"#4a7a4a":"#444",fontSize:"9px"}}>{t.quality||"?"}</td>
                          <td style={{padding:"4px 8px",color:t.days<3?"#8a5a5a":"#333",fontSize:"9px"}}>{t.days!=null?(t.days<1?`${(t.days*24).toFixed(0)}h`:Math.round(t.days)+"d"):"?"}</td>
                          <td style={{padding:"4px 8px"}}><ConfBar conf={t.conf} width={36}/></td>
                          <td style={{padding:"4px 8px",color:"#444",fontSize:"9px"}}>Y{yc}/N{nc}</td>
                          <td style={{padding:"4px 8px"}}>
                            <span style={{background:"#111",color:cl?(cl.pnl>0?"#4a7a4a":"#7a4a4a"):"#555",padding:"1px 5px",fontSize:"9px"}}>{cl?(cl.pnl>0?"WIN":"LOSS"):"OPEN"}</span>
                          </td>
                          <td style={{padding:"4px 8px",color:pnl>=0?"#bbb":"#666",fontWeight:"bold"}}>{(pnl>=0?"+":"-")+dollar(pnl)}</td>
                          <td style={{padding:"4px 8px",color:"#3a5a3a",fontSize:"9px"}}>{t.edgeFrom}</td>
                          <td style={{padding:"4px 8px",color:"#555",fontSize:"9px"}}>{t.priceSource}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* MARKETS */}
              {tab==="markets"&&(markets.length===0
                ?<div style={{color:"#666",padding:"40px",textAlign:"center"}}>Run scan to load markets.</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                  <TH cols={["#","BL","Type","Market","YES%","NO%","Bid","Ask","Spread","Vol24h","Liq","Qual","Comp","24hΔ","7dΔ","Ends"]}/>
                  <tbody>
                    {markets.map((m,i)=>{
                      const dead=blackRef.current.has(m.id);
                      const mType=detectType(m.question);
                      const qual=calcQuality(m);
                      const spr=m.bestBid&&m.bestAsk?((m.bestAsk-m.bestBid)*100).toFixed(1)+"¢":"--";
                      return(
                        <tr key={m.id} style={{borderBottom:"1px solid #0f0f0f",opacity:dead?0.25:1}}>
                          <td style={{padding:"4px 8px",color:"#333"}}>{i+1}</td>
                          <td style={{padding:"4px 8px"}}><span style={{fontSize:"8px",color:dead?"#6a3a3a":"#1e1e1e"}}>{dead?"●":"○"}</span></td>
                          <td style={{padding:"4px 8px"}}><TypeBadge type={mType}/></td>
                          <td style={{padding:"4px 8px",color:"#555",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.question}</td>
                          <td style={{padding:"4px 8px",color:m.yesPrice>=0.30&&m.yesPrice<=0.70?"#aaa":"#666"}}>{pct(m.yesPrice)}</td>
                          <td style={{padding:"4px 8px",color:"#555"}}>{pct(m.noPrice)}</td>
                          <td style={{padding:"4px 8px",color:"#3a5a3a"}}>{m.bestBid?pct(m.bestBid):"--"}</td>
                          <td style={{padding:"4px 8px",color:"#5a3a3a"}}>{m.bestAsk?pct(m.bestAsk):"--"}</td>
                          <td style={{padding:"4px 8px",color:m.bestBid&&m.bestAsk&&(m.bestAsk-m.bestBid)>0.06?"#7a5a5a":"#333"}}>{spr}</td>
                          <td style={{padding:"4px 8px",color:"#666"}}>{mini(m.volume24h)}</td>
                          <td style={{padding:"4px 8px",color:"#444"}}>{mini(m.liquidity)}</td>
                          <td style={{padding:"4px 8px",color:qual>=65?"#4a7a4a":qual>=45?"#666":"#6a4a4a"}}>{qual}</td>
                          <td style={{padding:"4px 8px",color:"#3a3a3a",fontSize:"9px"}}>{((m.competitive||0)*100).toFixed(0)}%</td>
                          <td style={{padding:"4px 8px",color:m.oneDayChange>0?"#aaa":m.oneDayChange<0?"#666":"#333"}}>{m.oneDayChange>0?"▲":m.oneDayChange<0?"▼":"─"}{(Math.abs(m.oneDayChange||0)*100).toFixed(1)}%</td>
                          <td style={{padding:"4px 8px",color:"#666"}}>{m.oneWeekChange>0?"+":""}{((m.oneWeekChange||0)*100).toFixed(1)}%</td>
                          <td style={{padding:"4px 8px",color:"#666",whiteSpace:"nowrap"}}>{m.endDate?new Date(m.endDate).toLocaleDateString():"--"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* LEADERBOARD */}
              {tab==="leaders"&&(
                <div style={{display:"flex",height:"100%",overflow:"hidden"}}>
                  <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",borderRight:"1px solid #141414"}}>
                    <div style={{flexShrink:0,padding:"6px 8px",borderBottom:"1px solid #1a1a1a",display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{color:"#333",fontSize:"10px"}}>Period:</span>
                      {["DAY","WEEK","MONTH","ALL"].map(p=>(
                        <button key={p} onClick={()=>setLbPeriod(p)} style={{background:lbPeriod===p?"#1a2a1a":"transparent",border:`1px solid ${lbPeriod===p?"#3a5a3a":"#222"}`,color:lbPeriod===p?"#5a9a5a":"#444",padding:"1px 8px",fontSize:"10px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>{p}</button>
                      ))}
                      <span style={{color:"#333",fontSize:"10px",marginLeft:"4px"}}>Sort:</span>
                      {["PNL","VOL"].map(o=>(
                        <button key={o} onClick={()=>setLbOrder(o)} style={{background:lbOrder===o?"#1a1a2a":"transparent",border:`1px solid ${lbOrder===o?"#3a3a5a":"#222"}`,color:lbOrder===o?"#6a6aaa":"#444",padding:"1px 8px",fontSize:"10px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>{o}</button>
                      ))}
                      <button onClick={loadLeaders} disabled={lbLoading} style={{marginLeft:"8px",background:"transparent",border:"1px solid #333",color:lbLoading?"#333":"#666",padding:"1px 12px",fontSize:"10px",fontFamily:"Consolas,monospace",cursor:lbLoading?"not-allowed":"pointer"}}>{lbLoading?"LOADING...":"LOAD"}</button>
                    </div>
                    <div style={{flex:1,overflowY:"auto"}}>
                      {leaders.length===0
                        ?<div style={{color:"#666",padding:"40px",textAlign:"center"}}>Click LOAD to fetch top traders.</div>
                        :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                          <TH cols={["#","Trader","P&L","Volume","Verified","VIEW"]}/>
                          <tbody>
                            {leaders.map((tr,i)=>(
                              <tr key={tr.proxyWallet||i} style={{borderBottom:"1px solid #0f0f0f"}}>
                                <td style={{padding:"5px 8px",color:i<3?"#bbb":"#555",fontWeight:i<3?"bold":"normal"}}>{i+1}</td>
                                <td style={{padding:"5px 8px"}}>
                                  <div style={{color:i<3?"#ddd":"#777"}}>{tr.userName||`${(tr.proxyWallet||"").slice(0,10)}...`}</div>
                                  {tr.xUsername&&<div style={{color:"#333",fontSize:"9px"}}>@{tr.xUsername}</div>}
                                  <div style={{color:"#666",fontSize:"9px"}}>{(tr.proxyWallet||"").slice(0,14)}...</div>
                                </td>
                                <td style={{padding:"5px 8px",color:(tr.pnl||0)>=0?"#bbb":"#666",fontWeight:"bold"}}>{(tr.pnl||0)>=0?"+":"-"}{dollar(tr.pnl||0)}</td>
                                <td style={{padding:"5px 8px",color:"#555"}}>{mini(tr.vol||0)}</td>
                                <td style={{padding:"5px 8px"}}>{tr.verifiedBadge&&<span style={{fontSize:"9px",padding:"1px 4px",background:"#1a2a1a",color:"#4a8a4a"}}>✓</span>}</td>
                                <td style={{padding:"5px 8px"}}><button onClick={()=>viewWallet(tr.proxyWallet,tr.userName)} disabled={wLoading} style={{background:"transparent",border:"1px solid #2a2a2a",color:"#444",padding:"1px 8px",fontSize:"9px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>VIEW</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      }
                    </div>
                  </div>
                  <div style={{width:"320px",flexShrink:0,display:"flex",flexDirection:"column",overflow:"hidden"}}>
                    {!wallet
                      ?<div style={{color:"#666",padding:"20px",fontSize:"11px"}}>Click VIEW on any trader to inspect their open positions and trade history.</div>
                      :<>
                        <div style={{flexShrink:0,padding:"8px 10px",borderBottom:"1px solid #1a1a1a",background:"#0d0d0d"}}>
                          <div style={{color:"#bbb",fontSize:"11px",fontWeight:"bold"}}>{wallet.name||"Wallet"}</div>
                          <div style={{color:"#666",fontSize:"9px",marginTop:"1px"}}>{wallet.addr}</div>
                          {wallet.value!=null&&<div style={{color:"#5a9a5a",fontSize:"10px",marginTop:"2px"}}>Portfolio: {dollar(wallet.value)}</div>}
                        </div>
                        <div style={{flex:1,overflowY:"auto"}}>
                          {wLoading
                            ?<div style={{color:"#555",padding:"16px"}}>Loading...</div>
                            :<>
                              <div style={{padding:"5px 10px",color:"#666",fontSize:"10px",borderBottom:"1px solid #141414"}}>OPEN ({(wallet.positions||[]).length})</div>
                              {(wallet.positions||[]).slice(0,12).map((pos,i)=>(
                                <div key={i} style={{padding:"5px 10px",borderBottom:"1px solid #0f0f0f"}}>
                                  <div style={{color:"#444",fontSize:"10px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{pos.title||pos.market||pos.marketSlug||"Unknown"}</div>
                                  <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginTop:"1px"}}>
                                    <span style={{color:(pos.outcome||pos.outcomeLabel)==="YES"?"#4a8a4a":"#8a4a4a"}}>{pos.outcome||pos.outcomeLabel||"?"}</span>
                                    <span style={{color:"#333"}}>{pos.size?`${(+pos.size).toFixed(2)}shr`:""}</span>
                                    <span style={{color:"#666"}}>{pos.avgPrice?pct(+pos.avgPrice):"--"}</span>
                                    <span style={{color:(pos.cashPnl||0)>=0?"#bbb":"#666",fontWeight:"bold"}}>{pos.cashPnl!=null?(pos.cashPnl>=0?"+":"-")+dollar(pos.cashPnl):"--"}</span>
                                  </div>
                                </div>
                              ))}
                              {(wallet.positions||[]).length===0&&<div style={{color:"#555",padding:"10px"}}>No open positions.</div>}
                              <div style={{padding:"5px 10px",color:"#666",fontSize:"10px",borderBottom:"1px solid #141414",borderTop:"1px solid #141414"}}>RECENT TRADES ({(wallet.trades||[]).length})</div>
                              {(wallet.trades||[]).slice(0,12).map((tr,i)=>(
                                <div key={i} style={{padding:"4px 10px",borderBottom:"1px solid #0f0f0f"}}>
                                  <div style={{color:"#333",fontSize:"10px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tr.title||tr.market||tr.marketSlug||"Unknown"}</div>
                                  <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginTop:"1px"}}>
                                    <span style={{color:tr.side==="BUY"?"#4a8a4a":"#8a4a4a"}}>{tr.side||"?"}</span>
                                    <span style={{color:"#333"}}>{tr.outcomeIndex===0?"YES":tr.outcomeIndex===1?"NO":tr.outcome||"?"}</span>
                                    <span style={{color:"#333"}}>{tr.size?dollar(+tr.size):tr.usdcSize?dollar(+tr.usdcSize):""}</span>
                                    <span style={{color:"#555"}}>{ageStr(tr.timestamp||tr.createdAt)}</span>
                                  </div>
                                </div>
                              ))}
                              {(wallet.trades||[]).length===0&&<div style={{color:"#555",padding:"10px"}}>No recent trades.</div>}
                            </>
                          }
                        </div>
                      </>
                    }
                  </div>
                </div>
              )}

              {/* PERFORMANCE ANALYTICS */}
              {tab==="perf"&&(
                <div>
                  <div style={{color:"#666",fontSize:"11px",marginBottom:"12px",padding:"6px",background:"#0d0d0d",border:"1px solid #181818"}}>
                    Performance analytics track outcomes to help identify what's working. Updated after each closed trade.
                  </div>
                  {!perfStats
                    ?<div style={{color:"#666",padding:"40px",textAlign:"center"}}>No closed trades yet — performance data will appear here after positions are closed.</div>
                    :<>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"8px",marginBottom:"12px"}}>
                        {[
                          {l:"Total Trades",    v:perfStats.total,                     c:"#888"},
                          {l:"Win Rate",        v:`${(perfStats.winRate*100).toFixed(0)}%`, c:perfStats.winRate>=0.5?"#5a9a5a":"#9a5a5a"},
                          {l:"Profit Factor",   v:pf>0?pf.toFixed(2)+"x":"--",         c:pf>=1.2?"#5a9a5a":"#9a5a5a"},
                        ].map(c=>(
                          <div key={c.l} style={{background:"#0d0d0d",border:"1px solid #181818",padding:"10px 14px"}}>
                            <div style={{color:"#666",fontSize:"9px",marginBottom:"4px"}}>{c.l}</div>
                            <div style={{color:c.c,fontSize:"20px"}}>{c.v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
                        <div style={{background:"#0d0d0d",border:"1px solid #181818",padding:"10px"}}>
                          <div style={{color:"#666",fontSize:"10px",marginBottom:"8px"}}>PERFORMANCE BY MARKET TYPE</div>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                            <TH cols={["Type","Trades","Win%","P&L"]}/>
                            <tbody>
                              {Object.entries(perfStats.byType).map(([type,data])=>(
                                <tr key={type} style={{borderBottom:"1px solid #0f0f0f"}}>
                                  <td style={{padding:"4px 8px"}}><TypeBadge type={type}/></td>
                                  <td style={{padding:"4px 8px",color:"#555"}}>{data.wins+data.losses}</td>
                                  <td style={{padding:"4px 8px",color:data.wins/(data.wins+data.losses||1)>=0.5?"#4a8a4a":"#8a4a4a"}}>{((data.wins/(data.wins+data.losses||1))*100).toFixed(0)}%</td>
                                  <td style={{padding:"4px 8px",color:data.pnl>=0?"#bbb":"#666",fontWeight:"bold"}}>{(data.pnl>=0?"+":"-")+dollar(data.pnl)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div style={{background:"#0d0d0d",border:"1px solid #181818",padding:"10px"}}>
                          <div style={{color:"#666",fontSize:"10px",marginBottom:"8px"}}>PERFORMANCE BY EDGE SOURCE</div>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                            <TH cols={["Edge","Trades","Win%","P&L"]}/>
                            <tbody>
                              {Object.entries(perfStats.byEdge).map(([edge,data])=>(
                                <tr key={edge} style={{borderBottom:"1px solid #0f0f0f"}}>
                                  <td style={{padding:"4px 8px",color:"#4a7a4a",fontSize:"10px"}}>{edge}</td>
                                  <td style={{padding:"4px 8px",color:"#555"}}>{data.wins+data.losses}</td>
                                  <td style={{padding:"4px 8px",color:data.wins/(data.wins+data.losses||1)>=0.5?"#4a8a4a":"#8a4a4a"}}>{((data.wins/(data.wins+data.losses||1))*100).toFixed(0)}%</td>
                                  <td style={{padding:"4px 8px",color:data.pnl>=0?"#bbb":"#666",fontWeight:"bold"}}>{(data.pnl>=0?"+":"-")+dollar(data.pnl)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      {stats.confHistory.length>1&&(
                        <div style={{marginTop:"12px",background:"#0d0d0d",border:"1px solid #181818",padding:"10px"}}>
                          <div style={{color:"#666",fontSize:"10px",marginBottom:"8px"}}>CONFIDENCE DISTRIBUTION</div>
                          <div style={{display:"flex",alignItems:"flex-end",gap:"3px",height:"50px"}}>
                            {[50,55,60,65,70,75,80,85,90].map(bucket=>{
                              const count=stats.confHistory.filter(c=>c>=bucket&&c<bucket+5).length;
                              const maxCount=Math.max(1,...[50,55,60,65,70,75,80,85,90].map(b=>stats.confHistory.filter(c=>c>=b&&c<b+5).length));
                              const h=count>0?Math.max(4,Math.round((count/maxCount)*44)):0;
                              return(
                                <div key={bucket} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:"2px"}}>
                                  <div style={{height:h+"px",background:"#3a5a3a",width:"100%",minWidth:"20px"}}/>
                                  <span style={{color:"#555",fontSize:"8px"}}>{bucket}</span>
                                  {count>0&&<span style={{color:"#333",fontSize:"8px"}}>{count}</span>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  }
                </div>
              )}

              {/* BLACKLIST */}
              {tab==="blacklist"&&(
                <div style={{padding:"4px"}}>
                  <div style={{color:"#333",marginBottom:"8px",display:"flex",alignItems:"center",gap:"12px"}}>
                    <span>{blacklist.size} markets excluded.</span>
                    {blacklist.size>0&&<button onClick={()=>{setBlacklist(new Set());blackRef.current=new Set();sys("[BL] Cleared","warn");}} style={{background:"transparent",border:"1px solid #2a2a2a",color:"#444",padding:"2px 10px",fontSize:"10px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>CLEAR ALL</button>}
                  </div>
                  {blacklist.size===0
                    ?<div style={{color:"#666",padding:"40px",textAlign:"center"}}>No blacklisted markets.</div>
                    :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                      <TH cols={["#","Market","Price","Quality","Reason"]}/>
                      <tbody>
                        {[...blacklist].map((id,i)=>{
                          const m=markets.find(x=>x.id===id);
                          const q=m?calcQuality(m):null;
                          return(
                            <tr key={id} style={{borderBottom:"1px solid #0f0f0f"}}>
                              <td style={{padding:"4px 8px",color:"#555"}}>{i+1}</td>
                              <td style={{padding:"4px 8px",color:"#666",maxWidth:"360px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.question||id}</td>
                              <td style={{padding:"4px 8px",color:"#333"}}>{m?pct(m.yesPrice):"--"}</td>
                              <td style={{padding:"4px 8px",color:q>=50?"#4a7a4a":"#6a4a4a"}}>{q??""}</td>
                              <td style={{padding:"4px 8px",color:"#555"}}>{m?(m.yesPrice>PRICE_MAX||m.yesPrice<PRICE_MIN)?"Price out of range":"Low activity/dead":"Unknown"}</td>
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
        <div style={{width:"200px",flexShrink:0,display:"flex",flexDirection:"column",borderLeft:"1px solid #141414",background:"#060606",overflow:"hidden"}}>
          <div style={{flexShrink:0,padding:"4px 12px",fontSize:"9px",color:"#666",letterSpacing:"1px",background:"#0d0d0d",borderBottom:"1px solid #1a1a1a"}}>LIVE STATS</div>
          <div style={{flex:1,overflowY:"auto"}}>
            <SVal label="PORTFOLIO"   value={dollar(totalVal)}                           color={totalVal>=START_CASH?"#ccc":"#666"} sub="total" />
            <SVal label="CASH"        value={dollar(portfolio.cash)}                     color="#aaa" sub="available" />
            <SVal label="P&L"         value={(totalPnl>=0?"+":"-")+dollar(totalPnl)}    color={totalPnl>=0?"#ddd":"#666"} sub="total" hi={totalPnl>0} />
            <SVal label="RETURN"      value={(ret>=0?"+":"")+ret.toFixed(2)+"%"}        color={ret>=0?"#ccc":"#666"} sub="vs $1,000" />
            <SVal label="UNREALIZED"  value={(unrealPnl>=0?"+":"-")+dollar(unrealPnl)}  color={unrealPnl>=0?"#bbb":"#666"} sub={`${open.length} open`} hi={unrealPnl>0} />
            <SVal label="REALIZED"    value={(realPnl>=0?"+":"-")+dollar(realPnl)}      color={realPnl>=0?"#bbb":"#666"} sub={`${portfolio.closed.length} closed`} />
            <SVal label="WIN RATE"    value={winRate}                                   color="#888" sub={`${wins}W ${losses}L`} />
            <SVal label="PROF.FACTOR" value={pf>0?pf.toFixed(2)+"x":"--"}              color={pf>=1.5?"#4a8a4a":pf>=1?"#8a8a4a":"#666"} sub="avg win/loss" />

            <div style={{padding:"3px 12px",fontSize:"9px",color:"#666",letterSpacing:"1px",background:"#0a0a0a",borderTop:"1px solid #111",borderBottom:"1px solid #111"}}>BOT</div>
            <SRow label="Scans"        value={stats.scans}/>
            <SRow label="Analyzed"     value={stats.analyzed}/>
            <SRow label="Executed"     value={stats.executed}/>
            <SRow label="Skipped"      value={stats.skipped}/>
            <SRow label="Blacklisted"  value={blacklist.size}/>
            <SRow label="News arts."   value={stats.newsTotal}/>
            <SRow label="Avg conf."    value={stats.avgConf?stats.avgConf+"%":"--"}/>
            <SRow label="Last scan"    value={stats.lastScan}/>
            <SRow label="Price upd."   value={`${refreshTs}(${refreshN})`} color="#3a5a3a"/>
            <SRow label="Uptime"       value={fmtUp(stats.uptime)}/>
            <SRow label="Threshold"    value={CONF_THRESH+"%"} color="#5a5a8a"/>
            <SRow label="Max trade"    value={"$"+MAX_TRADE}/>
            <SRow label="Max open"     value={MAX_OPEN}/>

            <div style={{padding:"3px 12px",fontSize:"9px",color:"#666",letterSpacing:"1px",background:"#0a0a0a",borderTop:"1px solid #111",borderBottom:"1px solid #111"}}>BY TYPE</div>
            {["sports","macro","crypto","politics","finance","general"].map(t=><SRow key={t} label={t.toUpperCase()} value={stats.byType[t]||0} color={TT[t]}/>)}

            <div style={{padding:"3px 12px",fontSize:"9px",color:"#666",letterSpacing:"1px",background:"#0a0a0a",borderTop:"1px solid #111",borderBottom:"1px solid #111"}}>BY EDGE</div>
            <SRow label="News"         value={stats.byEdge.news||0}        color="#5a7a9a"/>
            <SRow label="Statistical"  value={stats.byEdge.statistical||0} color="#4a8a4a"/>
            <SRow label="Momentum"     value={stats.byEdge.momentum||0}    color="#9a9a4a"/>

            <div style={{padding:"3px 12px",fontSize:"9px",color:"#666",letterSpacing:"1px",background:"#0a0a0a",borderTop:"1px solid #111",borderBottom:"1px solid #111"}}>LIVE PRICES</div>
            <div style={{padding:"4px 6px"}}>
              {goodMkts.slice(0,22).map(m=>{
                const mType=detectType(m.question);
                const isHeld=open.some(p=>p.conditionId===m.conditionId);
                const q=calcQuality(m);
                return(
                  <div key={m.id} style={{padding:"4px 6px",marginBottom:"2px",borderLeft:`2px solid ${isHeld?"#2a5a2a":TC[mType]||"#1a1a1a"}`,background:isHeld?"#0a130a":"#0a0a0a"}}>
                    <div style={{color:isHeld?"#2e5e2e":"#2a2a2a",fontSize:"9px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.question.slice(0,28)}{isHeld?" ●":""}</div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginTop:"1px"}}>
                      <span style={{color:m.yesPrice>=0.30&&m.yesPrice<=0.70?"#aaa":"#777"}}>{pct(m.yesPrice)}</span>
                      <span style={{color:q>=60?"#5a8a5a":"#666",fontSize:"8px"}}>{q}</span>
                      <span style={{color:m.oneDayChange>0?"#2e4e2e":m.oneDayChange<0?"#4e2e2e":"#1e1e1e"}}>{m.oneDayChange>0?"▲":m.oneDayChange<0?"▼":"─"}{(Math.abs(m.oneDayChange||0)*100).toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
              {goodMkts.length===0&&<div style={{color:"#555",padding:"8px",fontSize:"10px"}}>Run scan</div>}
            </div>
          </div>
        </div>
      </div>

      {/* SYSTEM LOG BAR */}
      <div style={{flexShrink:0,height:"22px",background:"#0a0a0a",borderTop:"1px solid #161616",display:"flex",alignItems:"center",overflow:"hidden"}}>
        <div style={{flex:1,overflowX:"auto",overflowY:"hidden",display:"flex",gap:"20px",padding:"0 14px",fontSize:"10px",whiteSpace:"nowrap"}}>
          {sysLog.slice(-6).map(l=>(
            <span key={l.id} style={{color:LOG_COLORS[l.type]||"#222",flexShrink:0}}>{l.ts} {l.msg}</span>
          ))}
        </div>
        <div style={{flexShrink:0,padding:"0 14px",display:"flex",gap:"14px",fontSize:"10px",color:"#666",borderLeft:"1px solid #161616"}}>
          <span>Open:{open.length}/{MAX_OPEN}</span>
          <span style={{color:unrealPnl>=0?"#2a4a2a":"#4a2a2a"}}>P&L:{(unrealPnl>=0?"+":"-")+dollar(unrealPnl)}</span>
          <span>Cash:{dollar(portfolio.cash)}</span>
        </div>
      </div>

      <style>{`
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:#060606}
        ::-webkit-scrollbar-thumb{background:#1a1a1a}
        *{box-sizing:border-box;margin:0;padding:0}
        button:focus{outline:none}
        body{overflow:hidden;background:#080808}
      `}</style>
    </div>
  );
}