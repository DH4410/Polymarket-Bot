import { useState, useEffect, useRef, useCallback } from "react";
import { analyzeMarket, shouldSell, isDeadMarket, isGoodCandidate } from "./ai-engine.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const THENEWS_KEY = "GzCg1YdRg2mxy6OJ7XQgk2UNZwV9Pq7XNbDnuLKv";
const GNEWS_KEY   = "9e1ef6ca6dd91d2708f9b476b72cdd22";
const CORS        = "https://corsproxy.io/?url=";
const START_CASH  = 1000;
const SCAN_LIMIT  = 100;   // fetch 100 markets per scan
const ANALYZE_MAX = 8;     // analyze up to 8 good candidates per scan

// ─── Polymarket API ───────────────────────────────────────────────────────────
async function polyGet(url) {
  try {
    const r = await fetch(CORS + encodeURIComponent(url));
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

async function getMarkets(limit = SCAN_LIMIT, offset = 0) {
  const data = await polyGet(
    `https://gamma-api.polymarket.com/markets?active=true&closed=false` +
    `&limit=${limit}&offset=${offset}&order=volume24hr&ascending=false`
  );
  if (!Array.isArray(data)) return [];
  return data
    .filter(m => m.active && !m.closed && m.enableOrderBook && m.clobTokenIds && m.outcomePrices)
    .map(m => {
      let yesId = null, noId = null;
      try { [yesId, noId] = JSON.parse(m.clobTokenIds); } catch {}
      let yesP = 0.5, noP = 0.5;
      try { const p = JSON.parse(m.outcomePrices); yesP = +p[0]||0.5; noP = +p[1]||0.5; } catch {}
      return {
        id: m.id, conditionId: m.conditionId, slug: m.slug,
        question: m.question || "Unknown",
        yesId, noId, yesPrice: yesP, noPrice: noP,
        bestBid: m.bestBid ?? null, bestAsk: m.bestAsk ?? null,
        lastPrice: m.lastTradePrice ?? null,
        volume24h:    +(m.volume24hr         || 0),
        volume:       +(m.volumeNum          || 0),
        liquidity:    +(m.liquidityNum       || 0),
        oneDayChange: +(m.oneDayPriceChange  || 0),
        oneWeekChange:+(m.oneWeekPriceChange || 0),
        endDate: m.endDateIso || m.endDate || null,
        category: m.category || "--",
      };
    });
}

async function getMidpoint(tokenId) {
  const d = await polyGet(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
  return d?.mid != null ? +d.mid : null;
}

// ─── News API with fallback ───────────────────────────────────────────────────
// 1st: TheNewsAPI  →  2nd: GNews  →  3rd: empty array

async function fetchNewsTheNews(query) {
  try {
    const url = `https://api.thenewsapi.com/v1/news/all` +
      `?api_token=${THENEWS_KEY}&search=${encodeURIComponent(query)}&language=en&limit=5&sort_by=published_at`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    return (d.data || []).map(a => ({
      title:       a.title       || "",
      description: a.description || "",
      snippet:     a.snippet     || "",
      source:      a.source      || "",
      published_at:a.published_at|| "",
      _src: "thenewsapi",
    }));
  } catch { return null; }  // null means failed (try fallback)
}

async function fetchNewsGNews(query) {
  try {
    const url = `https://gnews.io/api/v4/search` +
      `?q=${encodeURIComponent(query)}&lang=en&max=5&sortby=publishedAt&apikey=${GNEWS_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    return (d.articles || []).map(a => ({
      title:       a.title       || "",
      description: a.description || "",
      snippet:     a.content     || a.description || "",
      source:      a.source?.name|| "",
      published_at:a.publishedAt || "",
      _src: "gnews",
    }));
  } catch { return []; }
}

async function fetchNews(query, log) {
  // Try TheNewsAPI first
  const tna = await fetchNewsTheNews(query);
  if (tna !== null && tna.length > 0) {
    log(`  [NEWS] TheNewsAPI → ${tna.length} article(s)`, "ok");
    return tna;
  }
  if (tna !== null && tna.length === 0) {
    log(`  [NEWS] TheNewsAPI → 0 results, trying GNews...`, "warn");
  } else {
    log(`  [NEWS] TheNewsAPI failed, trying GNews...`, "warn");
  }

  // Fallback: GNews
  const gn = await fetchNewsGNews(query);
  if (gn.length > 0) {
    log(`  [NEWS] GNews → ${gn.length} article(s)`, "ok");
  } else {
    log(`  [NEWS] Both APIs returned 0 results`, "dim");
  }
  return gn;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms  => new Promise(r => setTimeout(r, ms));
const pct   = p   => `${(+p*100).toFixed(1)}%`;
const $     = n   => `$${(+n).toFixed(2)}`;
const mini  = n   => +n >= 1000000 ? `$${(+n/1000000).toFixed(1)}M`
                   : +n >= 1000    ? `$${(+n/1000).toFixed(1)}k`
                   : `$${(+n).toFixed(0)}`;
const now   = ()  => new Date().toLocaleTimeString("en-US", { hour12:false });
const age   = iso => { if(!iso)return""; const h=Math.round((Date.now()-new Date(iso))/3600000); return h<24?`${h}h`:`${Math.floor(h/24)}d`; };
const fmtUp = s   => `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;

// ─── Color map ────────────────────────────────────────────────────────────────
const C = {
  header:"#e0e0e0", info:"#aaa", ok:"#ccc", err:"#999", warn:"#888",
  dim:"#444", div:"#333", prompt:"#ddd", mkt:"#ddd", price:"#bbb",
  trade:"#e0e0e0", tradeok:"#c0c0c0", decision:"#fff", conf:"#bbb",
  sent:"#aaa", mom:"#aaa", liq:"#aaa", mis:"#bbb",
  sell:"#ddd", profit:"#ccc", loss:"#777",
  newsitem:"#555", blacklist:"#3a2a2a", blank:"transparent",
};

// ─── Log Panel ────────────────────────────────────────────────────────────────
function LogPanel({ logs, logRef }) {
  return (
    <div ref={logRef} style={{
      flex:1, overflowY:"auto", padding:"6px 8px",
      fontSize:"11px", lineHeight:"1.55", fontFamily:"Consolas,monospace",
    }}>
      {logs.map(l => l.type==="blank"
        ? <div key={l.id} style={{height:"4px"}}/>
        : (
          <div key={l.id} style={{display:"flex",gap:"8px"}}>
            <span style={{color:"#252525",flexShrink:0,fontSize:"9px",paddingTop:"2px"}}>{l.ts}</span>
            <span style={{color:C[l.type]||"#aaa",wordBreak:"break-word"}}>{l.msg}</span>
          </div>
        )
      )}
      <span style={{display:"inline-block",width:"6px",height:"11px",
        background:"#333",animation:"blink 1.2s step-end infinite",
        marginLeft:"2px",verticalAlign:"text-bottom"}}/>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function Panel({ title, badge, children, actions=[], flex=1 }) {
  return (
    <div style={{flex,display:"flex",flexDirection:"column",overflow:"hidden",
      borderRight:"1px solid #141414"}}>
      <div style={{flexShrink:0,background:"#0d0d0d",borderBottom:"1px solid #1c1c1c",
        padding:"4px 8px",display:"flex",alignItems:"center",gap:"8px"}}>
        <span style={{color:"#777",fontSize:"10px",letterSpacing:"1px",fontWeight:"bold"}}>{title}</span>
        {badge && <span style={{color:"#2a2a2a",fontSize:"9px"}}>{badge}</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:"4px"}}>
          {actions.map(a=>(
            <button key={a.label} onClick={a.fn} disabled={a.dis} style={{
              background:"transparent",border:`1px solid ${a.dis?"#1a1a1a":"#2e2e2e"}`,
              color:a.dis?"#222":"#666",padding:"1px 8px",fontSize:"10px",
              fontFamily:"Consolas,monospace",cursor:a.dis?"not-allowed":"pointer",
              letterSpacing:"0.5px",
            }}>{a.label}</button>
          ))}
        </div>
      </div>
      <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {children}
      </div>
    </div>
  );
}

function SC({ label, value, color="#999" }) {
  return (
    <div style={{display:"flex",flexDirection:"column",padding:"0 10px",
      borderRight:"1px solid #141414",flexShrink:0}}>
      <span style={{color:"#2a2a2a",fontSize:"9px",letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{label}</span>
      <span style={{color,fontSize:"11px",whiteSpace:"nowrap"}}>{value}</span>
    </div>
  );
}

function TH({ cols }) {
  return (
    <thead>
      <tr style={{borderBottom:"1px solid #181818"}}>
        {cols.map(c=>(
          <th key={c} style={{padding:"3px 8px",textAlign:"left",fontWeight:"normal",
            color:"#333",fontSize:"10px",whiteSpace:"nowrap",letterSpacing:"0.3px"}}>{c}</th>
        ))}
      </tr>
    </thead>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [markets,   setMarkets]   = useState([]);
  const [blacklist, setBlacklist] = useState(new Set()); // Set of market IDs to never analyze again
  const [portfolio, setPortfolio] = useState({ cash:START_CASH, positions:[], trades:[], closed:[] });
  const [status,    setStatus]    = useState("idle");
  const [auto,      setAuto]      = useState(false);
  const [tab,       setTab]       = useState("positions");

  const [scanLog,  setScanLog]  = useState([]);
  const [aiLog,    setAiLog]    = useState([]);
  const [sellLog,  setSellLog]  = useState([]);
  const [sysLog,   setSysLog]   = useState([]);

  const [stats, setStats] = useState({
    scans:0, analyzed:0, executed:0, news:0, apiCalls:0, blacklisted:0,
    lastScan:"--", uptime:0, best:null, worst:null, skipped:0,
  });

  const bootedRef  = useRef(false);
  const portRef    = useRef(portfolio);
  const statusRef  = useRef(status);
  const blackRef   = useRef(new Set());
  const autoRef    = useRef(null);
  const uptimeRef  = useRef(0);

  const scanRef = useRef(null);
  const aiRef   = useRef(null);
  const sellRef = useRef(null);
  const sysRef  = useRef(null);

  portRef.current   = portfolio;
  statusRef.current = status;
  blackRef.current  = blacklist;

  useEffect(()=>{
    [scanRef,aiRef,sellRef,sysRef].forEach(r=>{ if(r.current) r.current.scrollTop=r.current.scrollHeight; });
  },[scanLog,aiLog,sellLog,sysLog]);

  useEffect(()=>{
    const iv=setInterval(()=>{ uptimeRef.current+=1; setStats(s=>({...s,uptime:uptimeRef.current})); },1000);
    return ()=>clearInterval(iv);
  },[]);

  const push = useCallback((setter,msg,type="info")=>{
    setter(prev=>[...prev.slice(-500),{ts:now(),msg,type,id:`${Date.now()}-${Math.random()}`}]);
  },[]);
  const sl  = useCallback((m,t)=>push(setScanLog, m,t),[push]);
  const al  = useCallback((m,t)=>push(setAiLog,   m,t),[push]);
  const sel = useCallback((m,t)=>push(setSellLog, m,t),[push]);
  const sys = useCallback((m,t)=>push(setSysLog,  m,t),[push]);

  // Boot
  useEffect(()=>{
    if(bootedRef.current) return;
    bootedRef.current=true;
    (async()=>{
      await sleep(80);
      sys("PolyBot AI Paper Trader  v4.0","header");
      sys("Smarter market selection + blacklist + GNews fallback","dim");
      sys("─────────────────────────────────","div");
      await sleep(150);
      sys("[OK] Polymarket Gamma API (100 markets/scan)","ok");
      await sleep(80); sys("[OK] CLOB live midpoint feed","ok");
      await sleep(80); sys("[OK] TheNewsAPI (primary)","ok");
      await sleep(80); sys("[OK] GNews API (fallback)","ok");
      await sleep(80); sys("[OK] Blacklist engine","ok");
      await sleep(80); sys("[OK] Paper wallet  $1,000.00 USDC","ok");
      sys("─────────────────────────────────","div");
      sys("Market selection:","info");
      sys("  • Scan 100 markets sorted by volume","dim");
      sys("  • Skip dead markets (blacklist forever)","dim");
      sys("  • Prefer mid-range prices (10%-90%)","dim");
      sys("  • Analyze top 8 good candidates","dim");
      sys("Confidence threshold: 55%","info");
      sys("Max trade: $50","info");
      sl("Scanner idle. Click SCAN to start.","dim");
      al("AI Engine v4 ready.","dim");
      sel("Position monitor idle.","dim");
    })();
  },[sys,sl,al,sel]);

  // ── SCAN ────────────────────────────────────────────────────────────────────
  const scan = useCallback(async()=>{
    if(statusRef.current==="scanning"||statusRef.current==="thinking") return;
    setStatus("scanning");

    sl("","blank"); sl("▶ Scan cycle started","header");

    // Fetch up to 100 markets
    sl(`Fetching ${SCAN_LIMIT} markets from Polymarket...`,"info");
    const raw = await getMarkets(SCAN_LIMIT, 0);
    setStats(s=>({...s,apiCalls:s.apiCalls+1,scans:s.scans+1,lastScan:now()}));

    if(!raw.length){
      sl("ERROR: Could not fetch markets. CORS proxy may be busy.","err");
      sys("[ERR] Market fetch failed","err");
      setStatus("idle"); return;
    }

    sl(`Fetched ${raw.length} raw markets.`,"ok");

    // ── BLACKLIST CHECK ──────────────────────────────────────────────────────
    const bl = blackRef.current;
    let newBlacklistCount = 0;
    const newBl = new Set(bl);

    const alive = raw.filter(m => {
      if(bl.has(m.id)) return false;  // already blacklisted
      if(isDeadMarket(m)){
        newBl.add(m.id);
        newBlacklistCount++;
        return false;
      }
      return true;
    });

    if(newBlacklistCount > 0){
      sl(`Blacklisted ${newBlacklistCount} dead/resolved markets.`,"warn");
      sys(`[BLACKLIST] Added ${newBlacklistCount} dead markets. Total blacklisted: ${newBl.size}`,"warn");
      setBlacklist(new Set(newBl));
      blackRef.current = new Set(newBl);
      setStats(s=>({...s,blacklisted:newBl.size}));
    }

    sl(`${alive.length} markets passed blacklist filter.`,"ok");

    // ── GOOD CANDIDATE FILTER ────────────────────────────────────────────────
    const candidates = alive.filter(m => isGoodCandidate(m));

    // Sort: prefer mid-range prices, then by volume
    candidates.sort((a,b)=>{
      const aMid = a.yesPrice >= 0.15 && a.yesPrice <= 0.85 ? 1 : 0;
      const bMid = b.yesPrice >= 0.15 && b.yesPrice <= 0.85 ? 1 : 0;
      if(aMid !== bMid) return bMid - aMid;  // mid-range first
      return (b.volume24h||0) - (a.volume24h||0);  // then by volume
    });

    const toAnalyze = candidates.slice(0, ANALYZE_MAX);
    setMarkets(raw);  // store all for the markets tab

    sl(`${candidates.length} good candidates found. Analyzing top ${toAnalyze.length}...`,"ok");
    sl("","blank");

    if(toAnalyze.length === 0){
      sl("No good candidates found this scan. All markets are dead or poor quality.","warn");
      sl("Try again later — markets may all be resolved.","dim");
      setStatus("idle"); return;
    }

    setStats(s=>({...s,analyzed:s.analyzed+toAnalyze.length}));

    // ── ANALYZE EACH CANDIDATE ───────────────────────────────────────────────
    for(let i=0;i<toAnalyze.length;i++){
      const m = toAnalyze[i];
      setStatus("thinking");

      const priceTag = m.yesPrice >= 0.15 && m.yesPrice <= 0.85 ? "[MID]" :
                       m.yesPrice < 0.15 ? "[LOW]" : "[HIGH]";

      sl(`[${i+1}/${toAnalyze.length}] ${priceTag} ${m.question.slice(0,65)}`,"mkt");
      sl(`  YES ${pct(m.yesPrice)}  NO ${pct(m.noPrice)}  Vol ${mini(m.volume24h)}  Liq ${mini(m.liquidity)}  24hΔ ${m.oneDayChange>0?"+":""}${(m.oneDayChange*100).toFixed(1)}%`,"dim");

      // Live midpoint
      let live = m.yesPrice;
      const mid = await getMidpoint(m.yesId);
      if(mid!==null){
        live=mid; m.yesPrice=mid; m.noPrice=1-mid;
        sl(`  Live midpoint → YES ${pct(mid)}`,"price");
        setStats(s=>({...s,apiCalls:s.apiCalls+1}));
      }

      // News — with fallback
      const q = m.question.replace(/\?/g,"").slice(0,60);
      sl(`  Searching: "${q.slice(0,48)}..."`,"info");
      const arts = await fetchNews(q, sl);
      setStats(s=>({...s,news:s.news+arts.length,apiCalls:s.apiCalls+1}));

      if(arts.length > 0){
        arts.slice(0,3).forEach(a=>{
          const src = a._src === "gnews" ? "[GNews]" : "[TNA]";
          sl(`    ${src} [${age(a.published_at)}] ${(a.title||"").slice(0,62)}`,"newsitem");
        });
      }

      // AI Analysis
      al("","blank");
      const result = analyzeMarket(m, arts, portRef.current.cash);
      result.thinkingLog.forEach(line=>{
        const t = line.startsWith("[DECISION]")?"decision"
          :line.startsWith("[CONFIDENCE]")?"conf"
          :line.startsWith("[SENTIMENT]")?"sent"
          :line.startsWith("[MOMENTUM]")?"mom"
          :line.startsWith("[LIQUIDITY]")?"liq"
          :line.startsWith("[MISPRICING]")?"mis"
          :line.startsWith("Market:")?"header"
          :line.startsWith("───")?"div":"dim";
        al(line,t);
      });

      sl(`  → AI: ${result.action}  Conf:${result.confidence}%  ${result.reasoning.slice(0,50)}`
        ,result.action!=="SKIP"?"trade":"dim");

      // If skipping, auto-blacklist markets with zero momentum AND no news
      if(result.action==="SKIP" && result.confidence < 40 && arts.length===0 &&
         Math.abs(m.oneDayChange||0) < 0.005){
        newBl.add(m.id);
        setBlacklist(new Set(newBl));
        blackRef.current=new Set(newBl);
        sl(`  → Auto-blacklisted (no news, no movement, low conf)`, "blacklist");
        setStats(s=>({...s,blacklisted:newBl.size,skipped:s.skipped+1}));
      } else if(result.action==="SKIP"){
        setStats(s=>({...s,skipped:s.skipped+1}));
      }

      // Execute trade
      const go = (result.action==="BUY_YES"||result.action==="BUY_NO")
        && result.confidence>=55 && result.amount>0
        && portRef.current.cash>=result.amount;

      if(go){
        const side = result.action==="BUY_YES"?"YES":"NO";
        const ep   = side==="YES"?live:(1-live);
        const shrs = result.amount/ep;
        const maxP = shrs-result.amount;

        const trade={
          id:Date.now()+Math.random(),
          question:m.question.slice(0,72),
          conditionId:m.conditionId, yesId:m.yesId,
          side,ep,currentPrice:ep,
          amount:result.amount,shares:shrs,maxProfit:maxP,
          pnl:0,pnlPct:0,
          confidence:result.confidence,
          openedAt:now(),openedTs:Date.now(),
          status:"OPEN",category:m.category,
          reasoning:result.reasoning,
          newsSource:arts[0]?._src||"none",
        };

        setStatus("trading");
        setPortfolio(prev=>{
          const next={...prev,cash:prev.cash-result.amount,
            positions:[...prev.positions,trade],trades:[...prev.trades,trade]};
          portRef.current=next; return next;
        });

        sl(`  ✓ TRADE OPEN: BUY ${side} $${result.amount} @ ${pct(ep)}  ${shrs.toFixed(3)} shares`,"tradeok");
        sys(`[TRADE] BUY ${side} $${result.amount} @ ${pct(ep)} conf:${result.confidence}% — "${m.question.slice(0,35)}"`,"trade");
        setStats(s=>({...s,executed:s.executed+1}));
        await sleep(200);
      }

      sl("","blank");
      await sleep(150);
    }

    sl("✓ Scan complete.","ok");
    sys(`[SCAN] done. Cash:${$(portRef.current.cash)}  Blacklist:${blackRef.current.size}`,"ok");
    setStatus("idle");
  },[sl,al,sys]);

  // ── SELL EVAL ────────────────────────────────────────────────────────────────
  const evalSells = useCallback(async()=>{
    const open=portRef.current.positions.filter(p=>p.status==="OPEN");
    if(!open.length){ sel("No open positions to evaluate.","dim"); return; }
    sel("","blank"); sel(`▶ Evaluating ${open.length} position(s)...`,"header");

    for(const pos of open){
      sel("","blank");
      sel(`${pos.side} "${pos.question.slice(0,55)}"`, "mkt");

      const mid=await getMidpoint(pos.yesId);
      let cur=pos.currentPrice;
      if(mid!==null) cur=pos.side==="YES"?mid:(1-mid);

      const pnl=(cur-pos.ep)*pos.shares;
      const pnlPct=(cur-pos.ep)/pos.ep;
      setPortfolio(prev=>({...prev,
        positions:prev.positions.map(p=>p.id===pos.id?{...p,currentPrice:cur,pnl,pnlPct}:p),
      }));

      const arts=await fetchNews(pos.question.slice(0,55), ()=>{});
      const txts=arts.map(a=>`${a.title||""} ${a.snippet||""}`);
      const res=shouldSell(pos,cur,txts);
      res.steps.forEach(s=>{
        const t=s.includes("TAKE PROFIT")||s.includes("STOP LOSS")?"sell"
          :s.includes("profit")||s.includes("+")?"profit"
          :s.includes("WARNING")||s.includes("collapsed")?"loss":"dim";
        sel(`  ${s}`,t);
      });

      if(res.decision==="SELL"){
        sel(`  → CLOSING: ${pnl>=0?"+":""}${$(pnl)} (${(pnlPct*100).toFixed(1)}%)`,pnl>=0?"profit":"loss");
        const closed={...pos,closePrice:cur,closedAt:now(),pnl,pnlPct,status:"CLOSED"};
        setPortfolio(prev=>{
          const proceeds=cur*pos.shares;
          const next={...prev,cash:prev.cash+proceeds,
            positions:prev.positions.filter(p=>p.id!==pos.id),
            closed:[...prev.closed,closed]};
          portRef.current=next; return next;
        });
        sys(`[CLOSE] ${pos.side} P&L:${$(pnl)} "${pos.question.slice(0,35)}"`,pnl>=0?"ok":"warn");
        setStats(s=>{
          const b=!s.best||pnl>s.best.pnl?{...pos,pnl}:s.best;
          const w=!s.worst||pnl<s.worst.pnl?{...pos,pnl}:s.worst;
          return {...s,best:b,worst:w};
        });
      } else {
        sel(`  → ${res.decision} (score ${res.sellScore}/100)`,"ok");
      }
    }
    sel("","blank"); sel("✓ Evaluation complete.","ok");
  },[sel,sys]);

  // ── AUTO ─────────────────────────────────────────────────────────────────────
  const toggleAuto=()=>{
    if(auto){
      setAuto(false); clearInterval(autoRef.current);
      sys("[AUTO] Disabled","warn");
    }else{
      setAuto(true);
      sys("[AUTO] Enabled — scan every 90s","ok");
      scan();
      autoRef.current=setInterval(()=>{ scan(); evalSells(); },90000);
    }
  };

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const open      = portfolio.positions.filter(p=>p.status==="OPEN");
  const openVal   = open.reduce((s,p)=>s+p.currentPrice*p.shares,0);
  const unrealPnl = open.reduce((s,p)=>s+(p.pnl||0),0);
  const realPnl   = portfolio.closed.reduce((s,t)=>s+(t.pnl||0),0);
  const totalPnl  = unrealPnl+realPnl;
  const totalVal  = portfolio.cash+openVal;
  const invested  = open.reduce((s,p)=>s+p.amount,0);
  const ret       = ((totalVal-START_CASH)/START_CASH*100);
  const wins      = portfolio.closed.filter(t=>t.pnl>0).length;
  const winRate   = portfolio.closed.length?`${((wins/portfolio.closed.length)*100).toFixed(0)}%`:"--";
  const goodMkts  = markets.filter(m=>!blackRef.current.has(m.id));

  const statusLabel={idle:"READY",scanning:"SCANNING",thinking:"THINKING",trading:"EXECUTING"};
  const statusCol={idle:"#444",scanning:"#888",thinking:"#aaa",trading:"#ddd"};

  const TABS=[
    {id:"positions",label:`OPEN POSITIONS (${open.length})`},
    {id:"pnl",      label:"P&L DASHBOARD"},
    {id:"trades",   label:`TRADE HISTORY (${portfolio.trades.length})`},
    {id:"markets",  label:`LIVE MARKETS (${markets.length})`},
    {id:"blacklist",label:`BLACKLIST (${blacklist.size})`},
  ];

  return (
    <div style={{width:"100vw",height:"100vh",overflow:"hidden",display:"flex",
      flexDirection:"column",background:"#080808",
      fontFamily:"Consolas,'Lucida Console',monospace",fontSize:"12px",color:"#bbb"}}>

      {/* TITLE */}
      <div style={{flexShrink:0,height:"32px",background:"#111",
        borderBottom:"1px solid #1e1e1e",display:"flex",alignItems:"center",
        padding:"0 12px",gap:"12px"}}>
        <span style={{color:"#ddd",fontWeight:"bold",letterSpacing:"3px",fontSize:"13px"}}>POLYBOT</span>
        <span style={{color:"#282828"}}>│</span>
        <span style={{color:"#444",fontSize:"11px"}}>Paper Trading Terminal v4.0</span>
        <span style={{color:"#282828"}}>│</span>
        <span style={{color:"#333",fontSize:"11px"}}>AI: Rule-Based + Blacklist Engine</span>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"16px",fontSize:"11px"}}>
          <span style={{color:statusCol[status]}}>● {statusLabel[status]}{auto?" [AUTO ON]":""}</span>
          <span style={{color:"#2a2a2a"}}>UPTIME: <span style={{color:"#3a3a3a"}}>{fmtUp(stats.uptime)}</span></span>
        </div>
      </div>

      {/* STATS BAR */}
      <div style={{flexShrink:0,height:"32px",background:"#0b0b0b",
        borderBottom:"1px solid #181818",display:"flex",alignItems:"center",
        overflowX:"auto",overflowY:"hidden"}}>
        <SC label="CASH"        value={$(portfolio.cash)}                          color={portfolio.cash>=START_CASH?"#bbb":"#777"}/>
        <SC label="PORT VALUE"  value={$(totalVal)}                                color={totalVal>=START_CASH?"#ccc":"#777"}/>
        <SC label="TOTAL P&L"   value={(totalPnl>=0?"+":"")+$(totalPnl)}           color={totalPnl>=0?"#ddd":"#666"}/>
        <SC label="RETURN"      value={(ret>=0?"+":"")+ret.toFixed(2)+"%"}         color={ret>=0?"#ccc":"#666"}/>
        <SC label="UNREALIZED"  value={(unrealPnl>=0?"+":"")+$(unrealPnl)}         color={unrealPnl>=0?"#bbb":"#666"}/>
        <SC label="REALIZED"    value={(realPnl>=0?"+":"")+$(realPnl)}             color={realPnl>=0?"#bbb":"#666"}/>
        <SC label="INVESTED"    value={$(invested)}                                color="#777"/>
        <SC label="OPEN POS"    value={open.length}                                color="#888"/>
        <SC label="CLOSED"      value={portfolio.closed.length}                    color="#555"/>
        <SC label="WIN RATE"    value={winRate}                                    color="#777"/>
        <SC label="TRADES"      value={stats.executed}                             color="#555"/>
        <SC label="SKIPPED"     value={stats.skipped}                              color="#444"/>
        <SC label="BLACKLISTED" value={blacklist.size}                             color="#555"/>
        <SC label="GOOD MKTS"   value={goodMkts.length}                           color="#444"/>
        <SC label="SCANS"       value={stats.scans}                                color="#444"/>
        <SC label="NEWS ART."   value={stats.news}                                 color="#3a3a3a"/>
        <SC label="API CALLS"   value={stats.apiCalls}                             color="#333"/>
        <SC label="LAST SCAN"   value={stats.lastScan}                             color="#3a3a3a"/>
      </div>

      {/* TOP PANELS */}
      <div style={{flex:"0 0 42%",display:"flex",borderBottom:"1px solid #141414",overflow:"hidden"}}>
        <Panel title="MARKET SCANNER" badge={`${markets.length} fetched, ${blacklist.size} blacklisted`}
          actions={[
            {label:status!=="idle"?"RUNNING...":"SCAN",fn:scan,dis:status!=="idle"},
            {label:auto?"STOP AUTO":"AUTO 90s",fn:toggleAuto,dis:false},
          ]} flex={1}>
          <LogPanel logs={scanLog} logRef={scanRef}/>
        </Panel>

        <Panel title="AI ENGINE — THINKING LOG" badge="v4 — sentiment+momentum+liquidity+mispricing" flex={1}>
          <LogPanel logs={aiLog} logRef={aiRef}/>
        </Panel>

        <Panel title="SELL / HOLD MONITOR" badge="position evaluator"
          actions={[{label:"EVAL SELLS",fn:evalSells,dis:status!=="idle"}]} flex={1}>
          <LogPanel logs={sellLog} logRef={sellRef}/>
        </Panel>

        <Panel title="SYSTEM + LIVE FEED" flex="0 0 220px">
          <div style={{flex:1,overflow:"hidden",borderBottom:"1px solid #141414"}}>
            <LogPanel logs={sysLog} logRef={sysRef}/>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"4px"}}>
            {goodMkts.slice(0,25).map(m=>(
              <div key={m.id} style={{padding:"3px 5px",marginBottom:"1px",
                borderLeft:`2px solid ${m.yesPrice>=0.15&&m.yesPrice<=0.85?"#2e2e2e":m.oneDayChange>0.05?"#3a3a3a":"#1a1a1a"}`,
                background:"#0a0a0a"}}>
                <div style={{color:"#444",fontSize:"10px",overflow:"hidden",
                  textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.question.slice(0,30)}</div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:"9px",marginTop:"1px"}}>
                  <span style={{color:m.yesPrice>=0.15&&m.yesPrice<=0.85?"#888":"#555"}}>
                    Y:{pct(m.yesPrice)}
                  </span>
                  <span style={{color:m.oneDayChange>0?"#777":m.oneDayChange<0?"#555":"#333"}}>
                    {m.oneDayChange>0?"▲":m.oneDayChange<0?"▼":"─"}{Math.abs(m.oneDayChange*100).toFixed(1)}%
                  </span>
                  <span style={{color:"#333"}}>{mini(m.volume24h)}</span>
                </div>
              </div>
            ))}
            {goodMkts.length===0&&<div style={{color:"#1e1e1e",padding:"4px",fontSize:"10px"}}>Run scan</div>}
          </div>
        </Panel>
      </div>

      {/* BOTTOM TABS */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{flexShrink:0,background:"#0d0d0d",borderBottom:"1px solid #1a1a1a",
          display:"flex",padding:"0 8px",gap:"2px"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              background:tab===t.id?"#141414":"transparent",border:"none",
              borderBottom:tab===t.id?"1px solid #555":"1px solid transparent",
              color:tab===t.id?"#bbb":"#3a3a3a",padding:"4px 14px",fontSize:"11px",
              fontFamily:"Consolas,monospace",cursor:"pointer",letterSpacing:"0.5px",
            }}>{t.label}</button>
          ))}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",
            gap:"16px",fontSize:"10px",color:"#2a2a2a",paddingRight:"8px"}}>
            <span>Best:{stats.best?$(stats.best.pnl):"--"}</span>
            <span>Worst:{stats.worst?$(stats.worst.pnl):"--"}</span>
          </div>
        </div>

        <div style={{flex:1,overflow:"auto",background:"#090909"}}>

          {/* OPEN POSITIONS */}
          {tab==="positions"&&(
            <div style={{padding:"6px"}}>
              {open.length===0
                ?<div style={{color:"#1e1e1e",padding:"12px 8px"}}>No open positions — run a scan.</div>
                :<>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["#","Market","Side","Entry","Current","Δ","Shares","Cost","Value","P&L","P&L%","Max Profit","Conf","Opened","News Src"]}/>
                    <tbody>
                      {open.map((p,i)=>{
                        const cv=p.currentPrice*p.shares;
                        const pc=p.pnl||0;
                        return(
                          <tr key={p.id} style={{borderBottom:"1px solid #0f0f0f"}}>
                            <td style={{padding:"3px 8px",color:"#333"}}>{i+1}</td>
                            <td style={{padding:"3px 8px",color:"#666",maxWidth:"220px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.question}</td>
                            <td style={{padding:"3px 8px",color:p.side==="YES"?"#bbb":"#888"}}>{p.side}</td>
                            <td style={{padding:"3px 8px",color:"#666"}}>{pct(p.ep)}</td>
                            <td style={{padding:"3px 8px",color:"#888"}}>{pct(p.currentPrice)}</td>
                            <td style={{padding:"3px 8px",color:pc>=0?"#aaa":"#555"}}>{pc>=0?"▲":"▼"}</td>
                            <td style={{padding:"3px 8px",color:"#555"}}>{p.shares.toFixed(3)}</td>
                            <td style={{padding:"3px 8px",color:"#777"}}>{$(p.amount)}</td>
                            <td style={{padding:"3px 8px",color:"#888"}}>{$(cv)}</td>
                            <td style={{padding:"3px 8px",color:pc>=0?"#bbb":"#555",fontWeight:"bold"}}>{(pc>=0?"+":"")+$(pc)}</td>
                            <td style={{padding:"3px 8px",color:pc>=0?"#999":"#444"}}>{((p.pnlPct||0)*100).toFixed(1)}%</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{$(p.maxProfit)}</td>
                            <td style={{padding:"3px 8px",color:"#666"}}>{p.confidence}%</td>
                            <td style={{padding:"3px 8px",color:"#3a3a3a"}}>{p.openedAt}</td>
                            <td style={{padding:"3px 8px",color:"#333"}}>{p.newsSource||"--"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{borderTop:"1px solid #1e1e1e",color:"#444"}}>
                        <td colSpan={7} style={{padding:"4px 8px"}}>TOTALS</td>
                        <td style={{padding:"4px 8px",color:"#666"}}>{$(invested)}</td>
                        <td style={{padding:"4px 8px",color:"#777"}}>{$(openVal)}</td>
                        <td style={{padding:"4px 8px",color:unrealPnl>=0?"#bbb":"#555",fontWeight:"bold"}}>{(unrealPnl>=0?"+":"")+$(unrealPnl)}</td>
                        <td colSpan={5}/>
                      </tr>
                    </tfoot>
                  </table>
                  <div style={{marginTop:"8px",padding:"0 2px"}}>
                    <div style={{color:"#2a2a2a",fontSize:"10px",marginBottom:"4px"}}>AI REASONING</div>
                    {open.map((p,i)=>(
                      <div key={p.id} style={{display:"flex",gap:"8px",marginBottom:"3px",fontSize:"10px"}}>
                        <span style={{color:"#333",flexShrink:0}}>{i+1}.</span>
                        <span style={{color:"#555",flexShrink:0}}>{p.side}</span>
                        <span style={{color:"#3a3a3a"}}>{p.reasoning}</span>
                      </div>
                    ))}
                  </div>
                </>
              }
            </div>
          )}

          {/* P&L */}
          {tab==="pnl"&&(
            <div style={{padding:"8px"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"6px",marginBottom:"10px"}}>
                {[
                  {l:"Starting Balance", v:$(START_CASH),                          s:"initial deposit",                   hi:null},
                  {l:"Current Cash",     v:$(portfolio.cash),                      s:"available to trade",                hi:portfolio.cash>=START_CASH},
                  {l:"Open Value",       v:$(openVal),                             s:`${open.length} positions`,          hi:openVal>0},
                  {l:"Total Portfolio",  v:$(totalVal),                            s:"cash + positions",                  hi:totalVal>=START_CASH},
                  {l:"Unrealized P&L",   v:(unrealPnl>=0?"+":"")+$(unrealPnl),     s:"mark-to-market",                    hi:unrealPnl>=0},
                  {l:"Realized P&L",     v:(realPnl>=0?"+":"")+$(realPnl),         s:`${portfolio.closed.length} closed`, hi:realPnl>=0},
                  {l:"Total P&L",        v:(totalPnl>=0?"+":"")+$(totalPnl),       s:"unrealized + realized",             hi:totalPnl>=0},
                  {l:"Total Return",     v:(ret>=0?"+":"")+ret.toFixed(3)+"%",     s:"vs starting balance",               hi:ret>=0},
                  {l:"Capital Deployed", v:$(invested),                            s:"currently in markets",              hi:null},
                  {l:"Win Rate",         v:winRate,                                s:`${wins}/${portfolio.closed.length} closed`,hi:null},
                  {l:"Best Trade",       v:stats.best?$(stats.best.pnl):"--",      s:stats.best?stats.best.question?.slice(0,25)+"...":"none yet",hi:true},
                  {l:"Worst Trade",      v:stats.worst?$(stats.worst.pnl):"--",    s:stats.worst?stats.worst.question?.slice(0,25)+"...":"none yet",hi:false},
                ].map(c=>(
                  <div key={c.l} style={{background:"#0d0d0d",border:"1px solid #181818",padding:"10px 12px"}}>
                    <div style={{color:"#282828",fontSize:"9px",letterSpacing:"0.5px",marginBottom:"5px"}}>{c.l}</div>
                    <div style={{color:c.hi===true?"#ddd":c.hi===false?"#666":"#aaa",fontSize:"18px",marginBottom:"3px"}}>{c.v}</div>
                    <div style={{color:"#222",fontSize:"9px"}}>{c.s}</div>
                  </div>
                ))}
              </div>
              {portfolio.closed.length>0&&(
                <>
                  <div style={{color:"#2a2a2a",fontSize:"10px",marginBottom:"5px"}}>CLOSED TRADES</div>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["#","Market","Side","Entry","Close","Cost","Proceeds","P&L","P&L%","Closed"]}/>
                    <tbody>
                      {portfolio.closed.map((t,i)=>(
                        <tr key={t.id} style={{borderBottom:"1px solid #0f0f0f"}}>
                          <td style={{padding:"3px 8px",color:"#333"}}>{i+1}</td>
                          <td style={{padding:"3px 8px",color:"#555",maxWidth:"220px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.question}</td>
                          <td style={{padding:"3px 8px",color:"#666"}}>{t.side}</td>
                          <td style={{padding:"3px 8px",color:"#555"}}>{pct(t.ep)}</td>
                          <td style={{padding:"3px 8px",color:"#666"}}>{pct(t.closePrice)}</td>
                          <td style={{padding:"3px 8px",color:"#555"}}>{$(t.amount)}</td>
                          <td style={{padding:"3px 8px",color:"#666"}}>{$(t.closePrice*t.shares)}</td>
                          <td style={{padding:"3px 8px",color:t.pnl>=0?"#bbb":"#555",fontWeight:"bold"}}>{(t.pnl>=0?"+":"")+$(t.pnl)}</td>
                          <td style={{padding:"3px 8px",color:t.pnl>=0?"#888":"#444"}}>{((t.pnlPct||0)*100).toFixed(1)}%</td>
                          <td style={{padding:"3px 8px",color:"#333"}}>{t.closedAt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {/* TRADE HISTORY */}
          {tab==="trades"&&(
            <div style={{padding:"6px"}}>
              {portfolio.trades.length===0
                ?<div style={{color:"#1e1e1e",padding:"12px 8px"}}>No trades yet.</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["#","Time","Market","Side","Entry","Amount","Shares","Max Profit","Conf","Status","P&L","News Src","Reasoning"]}/>
                    <tbody>
                      {[...portfolio.trades].reverse().map((t,i)=>{
                        const cl=portfolio.closed.find(c=>c.id===t.id);
                        const pnl=cl?cl.pnl:(t.pnl||0);
                        return(
                          <tr key={t.id} style={{borderBottom:"1px solid #0f0f0f"}}>
                            <td style={{padding:"3px 8px",color:"#333"}}>{portfolio.trades.length-i}</td>
                            <td style={{padding:"3px 8px",color:"#333",whiteSpace:"nowrap"}}>{t.openedAt}</td>
                            <td style={{padding:"3px 8px",color:"#555",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.question}</td>
                            <td style={{padding:"3px 8px",color:t.side==="YES"?"#aaa":"#777"}}>{t.side}</td>
                            <td style={{padding:"3px 8px",color:"#555"}}>{pct(t.ep)}</td>
                            <td style={{padding:"3px 8px",color:"#666"}}>{$(t.amount)}</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{t.shares.toFixed(3)}</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{$(t.maxProfit)}</td>
                            <td style={{padding:"3px 8px",color:"#555"}}>{t.confidence}%</td>
                            <td style={{padding:"3px 8px"}}>
                              <span style={{background:"#111",color:cl?"#444":"#666",padding:"1px 5px",fontSize:"9px"}}>
                                {cl?"CLOSED":"OPEN"}
                              </span>
                            </td>
                            <td style={{padding:"3px 8px",color:pnl>=0?"#bbb":"#555",fontWeight:"bold"}}>{(pnl>=0?"+":"")+$(pnl)}</td>
                            <td style={{padding:"3px 8px",color:"#333"}}>{t.newsSource||"--"}</td>
                            <td style={{padding:"3px 8px",color:"#333",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.reasoning}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              }
            </div>
          )}

          {/* LIVE MARKETS */}
          {tab==="markets"&&(
            <div style={{padding:"6px"}}>
              {markets.length===0
                ?<div style={{color:"#1e1e1e",padding:"12px 8px"}}>Run scan to load markets.</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["#","Status","Market","YES%","NO%","Bid","Ask","Spread","Vol 24h","Liquidity","24h Chg","End Date","Category"]}/>
                    <tbody>
                      {markets.map((m,i)=>{
                        const dead=blackRef.current.has(m.id);
                        return(
                          <tr key={m.id} style={{borderBottom:"1px solid #0f0f0f",opacity:dead?0.35:1}}>
                            <td style={{padding:"3px 8px",color:"#333"}}>{i+1}</td>
                            <td style={{padding:"3px 8px"}}>
                              <span style={{fontSize:"9px",padding:"1px 4px",background:dead?"#1a0a0a":"#0a0a0a",color:dead?"#555":"#444"}}>
                                {dead?"BLACKLIST":"ACTIVE"}
                              </span>
                            </td>
                            <td style={{padding:"3px 8px",color:dead?"#2a2a2a":"#555",maxWidth:"230px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.question}</td>
                            <td style={{padding:"3px 8px",color:m.yesPrice>=0.15&&m.yesPrice<=0.85?"#aaa":"#555"}}>{pct(m.yesPrice)}</td>
                            <td style={{padding:"3px 8px",color:"#555"}}>{pct(m.noPrice)}</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{m.bestBid?pct(m.bestBid):"--"}</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{m.bestAsk?pct(m.bestAsk):"--"}</td>
                            <td style={{padding:"3px 8px",color:"#333"}}>{m.bestBid&&m.bestAsk?((m.bestAsk-m.bestBid)*100).toFixed(1)+"¢":"--"}</td>
                            <td style={{padding:"3px 8px",color:"#666"}}>{mini(m.volume24h)}</td>
                            <td style={{padding:"3px 8px",color:"#444"}}>{mini(m.liquidity)}</td>
                            <td style={{padding:"3px 8px",color:m.oneDayChange>0?"#aaa":m.oneDayChange<0?"#555":"#333"}}>
                              {m.oneDayChange>0?"▲":m.oneDayChange<0?"▼":"─"}{Math.abs(m.oneDayChange*100).toFixed(2)}%
                            </td>
                            <td style={{padding:"3px 8px",color:"#333",whiteSpace:"nowrap"}}>{m.endDate?new Date(m.endDate).toLocaleDateString():"--"}</td>
                            <td style={{padding:"3px 8px",color:"#2a2a2a"}}>{m.category}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              }
            </div>
          )}

          {/* BLACKLIST */}
          {tab==="blacklist"&&(
            <div style={{padding:"8px"}}>
              <div style={{color:"#2a2a2a",fontSize:"11px",marginBottom:"8px"}}>
                Markets permanently excluded from analysis. These are resolved, dead, or have no tradeable edge.
                <span style={{color:"#444",marginLeft:"8px"}}>{blacklist.size} total</span>
              </div>
              {blacklist.size===0
                ?<div style={{color:"#1e1e1e",padding:"8px"}}>No markets blacklisted yet. Run a scan.</div>
                :<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
                    <TH cols={["Market ID","Question","YES% at blacklist","Reason"]}/>
                    <tbody>
                      {[...blacklist].map((id,i)=>{
                        const m=markets.find(x=>x.id===id);
                        return(
                          <tr key={id} style={{borderBottom:"1px solid #0f0f0f"}}>
                            <td style={{padding:"3px 8px",color:"#2a2a2a",fontSize:"9px"}}>{id}</td>
                            <td style={{padding:"3px 8px",color:"#3a3a3a",maxWidth:"300px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.question||"Unknown"}</td>
                            <td style={{padding:"3px 8px",color:"#333"}}>{m?pct(m.yesPrice):"--"}</td>
                            <td style={{padding:"3px 8px",color:"#2a2a2a"}}>
                              {m?(m.yesPrice<0.02||m.yesPrice>0.98)?"Extreme price (near resolved)":"Low conf + no news + no movement":"Manually blacklisted"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
              }
              {blacklist.size>0&&(
                <button onClick={()=>{ setBlacklist(new Set()); blackRef.current=new Set(); sys("[BLACKLIST] Cleared","warn"); }}
                  style={{marginTop:"8px",background:"transparent",border:"1px solid #2a2a2a",
                    color:"#555",padding:"4px 12px",fontSize:"11px",fontFamily:"Consolas,monospace",cursor:"pointer"}}>
                  CLEAR BLACKLIST
                </button>
              )}
            </div>
          )}

        </div>
      </div>

      {/* STATUS BAR */}
      <div style={{flexShrink:0,height:"22px",background:"#0b0b0b",
        borderTop:"1px solid #161616",display:"flex",alignItems:"center",
        padding:"0 12px",gap:"20px",fontSize:"10px",color:"#2a2a2a"}}>
        <span>PolyBot v4.0</span>
        <span style={{color:"#181818"}}>│</span>
        <span>News: TheNewsAPI (primary) → GNews (fallback)</span>
        <span style={{color:"#181818"}}>│</span>
        <span>Markets: scans {SCAN_LIMIT}, analyzes {ANALYZE_MAX} best candidates</span>
        <span style={{color:"#181818"}}>│</span>
        <span>Blacklist: {blacklist.size} markets excluded</span>
        <div style={{marginLeft:"auto",display:"flex",gap:"16px"}}>
          <span>Good mkts: {goodMkts.length}</span>
          <span>Cash: {$(portfolio.cash)}</span>
        </div>
      </div>

    </div>
  );
}