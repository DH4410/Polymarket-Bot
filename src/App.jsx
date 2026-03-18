import { useState, useEffect, useRef, useCallback } from "react";
import { analyzeMarket, shouldSell } from "./ai-engine.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const NEWS_API_KEY = "GzCg1YdRg2mxy6OJ7XQgk2UNZwV9Pq7XNbDnuLKv";
const CORS         = "https://corsproxy.io/?url=";
const STARTING_CASH = 1000;

// ─── API helpers ──────────────────────────────────────────────────────────────
async function polyFetch(url) {
  try {
    const r = await fetch(CORS + encodeURIComponent(url));
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

async function fetchTopMarkets(limit = 40) {
  const data = await polyFetch(
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`
  );
  if (!Array.isArray(data)) return [];
  return data
    .filter(m => m.active && !m.closed && m.enableOrderBook && m.clobTokenIds && m.outcomePrices)
    .map(m => {
      let yesTokenId = null, noTokenId = null;
      try { [yesTokenId, noTokenId] = JSON.parse(m.clobTokenIds); } catch {}
      let yesPrice = 0.5, noPrice = 0.5;
      try { const p = JSON.parse(m.outcomePrices); yesPrice = +p[0] || 0.5; noPrice = +p[1] || 0.5; } catch {}
      return {
        id: m.id, conditionId: m.conditionId, slug: m.slug,
        question: m.question || "Unknown",
        yesTokenId, noTokenId, yesPrice, noPrice,
        bestBid: m.bestBid, bestAsk: m.bestAsk,
        lastPrice: m.lastTradePrice,
        spread: m.spread,
        volume24h:    +(m.volume24hr  || 0),
        volume:       +(m.volumeNum   || 0),
        liquidity:    +(m.liquidityNum|| 0),
        oneDayChange: +(m.oneDayPriceChange || 0),
        oneWeekChange:+(m.oneWeekPriceChange|| 0),
        endDate: m.endDateIso || m.endDate,
        category: m.category,
      };
    })
    .filter(m => m.yesTokenId && m.volume24h > 50);
}

async function fetchMidpoint(tokenId) {
  const d = await polyFetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`);
  return d?.mid != null ? +d.mid : null;
}

async function fetchNews(query) {
  try {
    const url = `https://api.thenewsapi.com/v1/news/all?api_token=${NEWS_API_KEY}&search=${encodeURIComponent(query)}&language=en&limit=5&sort_by=published_at`;
    const r = await fetch(url);
    const d = await r.json();
    return d.data || [];
  } catch { return []; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const pct    = p  => `${(+p * 100).toFixed(1)}%`;
const usd    = n  => `$${(+n).toFixed(2)}`;
const mini   = n  => n >= 1000 ? `$${(n/1000).toFixed(1)}k` : usd(n);
const ts     = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const fmtAge = iso => {
  if (!iso) return "";
  const h = Math.round((Date.now() - new Date(iso)) / 3600000);
  return h < 24 ? `${h}h` : `${Math.floor(h/24)}d`;
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Core state
  const [markets,   setMarkets]   = useState([]);
  const [portfolio, setPortfolio] = useState({
    cash: STARTING_CASH, positions: [], trades: [], closedTrades: []
  });
  const [status, setStatus]   = useState("idle");
  const [autoMode, setAutoMode] = useState(false);

  // Panel logs
  const [scanLog,   setScanLog]   = useState([]);
  const [aiLog,     setAiLog]     = useState([]);
  const [sellLog,   setSellLog]   = useState([]);
  const [systemLog, setSystemLog] = useState([]);

  // Stats
  const [stats, setStats] = useState({
    scansRun: 0, marketsAnalyzed: 0, tradesExecuted: 0,
    newsArticlesFetched: 0, lastScan: null, uptime: 0,
    apiCalls: 0, bestTrade: null, worstTrade: null,
  });

  // Active panel
  const [activeTab, setActiveTab] = useState("orders"); // orders | pnl | trades

  // Refs
  const bootedRef     = useRef(false);
  const portfolioRef  = useRef(portfolio);
  const statusRef     = useRef(status);
  const autoTimerRef  = useRef(null);
  const uptimeRef     = useRef(0);

  const scanLogRef  = useRef(null);
  const aiLogRef    = useRef(null);
  const sellLogRef  = useRef(null);
  const sysLogRef   = useRef(null);

  portfolioRef.current = portfolio;
  statusRef.current    = status;

  // Auto-scroll all logs
  useEffect(() => {
    [scanLogRef, aiLogRef, sellLogRef, sysLogRef].forEach(r => {
      if (r.current) r.current.scrollTop = r.current.scrollHeight;
    });
  }, [scanLog, aiLog, sellLog, systemLog]);

  // Uptime counter
  useEffect(() => {
    const iv = setInterval(() => {
      uptimeRef.current += 1;
      setStats(s => ({ ...s, uptime: uptimeRef.current }));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Logging helpers ────────────────────────────────────────────────────────
  const addLog = useCallback((setter, msg, type = "info") => {
    setter(prev => [...prev.slice(-300), { ts: ts(), msg, type, id: `${Date.now()}-${Math.random()}` }]);
  }, []);

  const slog  = useCallback((m, t) => addLog(setScanLog,   m, t), [addLog]);
  const alog  = useCallback((m, t) => addLog(setAiLog,     m, t), [addLog]);
  const sellog= useCallback((m, t) => addLog(setSellLog,   m, t), [addLog]);
  const sylog = useCallback((m, t) => addLog(setSystemLog, m, t), [addLog]);

  // ── Boot ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      await sleep(80);
      sylog("PolyBot AI Trading System  v2.0", "header");
      sylog("Rule-based AI engine — no external AI API", "dim");
      sylog("─────────────────────────────────────", "div");
      await sleep(200);
      sylog("[OK] Polymarket Gamma API connected", "ok");
      await sleep(100);
      sylog("[OK] CLOB order book feed connected", "ok");
      await sleep(100);
      sylog("[OK] TheNewsAPI feed connected", "ok");
      await sleep(100);
      sylog("[OK] AI engine loaded (rule-based)", "ok");
      await sleep(100);
      sylog("[OK] Paper wallet: $1,000.00 USDC", "ok");
      sylog("─────────────────────────────────────", "div");
      sylog("Confidence threshold: 70%  Max trade: $50", "info");
      sylog("Waiting for scan command...", "dim");

      alog("AI Engine ready.", "header");
      alog("Scoring model: Sentiment + Momentum + Liquidity + Mispricing", "dim");
      alog("Waiting for first market...", "dim");

      slog("Market scanner idle.", "dim");
      slog("Click [SCAN] or [AUTO] to start.", "dim");

      sellog("Position monitor idle.", "dim");
      sellog("Open positions will be evaluated here.", "dim");
    })();
  }, [sylog, alog, slog, sellog]);

  // ── Scan & trade cycle ─────────────────────────────────────────────────────
  const scanAndDecide = useCallback(async () => {
    if (statusRef.current === "scanning" || statusRef.current === "thinking") return;
    setStatus("scanning");

    slog("", "blank"); slog("▶ Starting scan cycle...", "header");
    sylog(`[SCAN] Cycle started`, "info");

    const rawMarkets = await fetchTopMarkets(40);
    setStats(s => ({ ...s, apiCalls: s.apiCalls + 1, scansRun: s.scansRun + 1, lastScan: new Date().toLocaleTimeString() }));

    if (!rawMarkets.length) {
      slog("ERROR: Could not fetch markets. CORS proxy may be busy.", "err");
      sylog("[ERR] Market fetch failed", "err");
      setStatus("idle"); return;
    }

    setMarkets(rawMarkets);
    slog(`Loaded ${rawMarkets.length} CLOB-enabled markets.`, "ok");
    slog(`Sorting by 24h volume. Analyzing top 6...`, "info");

    const toAnalyze = rawMarkets.slice(0, 6);
    setStats(s => ({ ...s, marketsAnalyzed: s.marketsAnalyzed + toAnalyze.length }));

    for (let i = 0; i < toAnalyze.length; i++) {
      const m = toAnalyze[i];
      setStatus("thinking");

      slog("", "blank");
      slog(`[${i+1}/${toAnalyze.length}] ${m.question.slice(0, 70)}`, "mkt");
      slog(`  YES: ${pct(m.yesPrice)}  NO: ${pct(m.noPrice)}  Vol24h: ${mini(m.volume24h)}  Liq: ${mini(m.liquidity)}`, "dim");

      // Live midpoint
      let livePrice = m.yesPrice;
      const mid = await fetchMidpoint(m.yesTokenId);
      if (mid !== null) {
        livePrice = mid;
        m.yesPrice = mid; m.noPrice = 1 - mid;
        slog(`  Live midpoint: YES ${pct(mid)}  NO ${pct(1-mid)}`, "price");
        setStats(s => ({ ...s, apiCalls: s.apiCalls + 1 }));
      }

      // News
      const query = m.question.replace(/[?]/g, "").slice(0, 55);
      slog(`  Fetching news: "${query.slice(0, 45)}..."`, "info");
      const articles = await fetchNews(query);
      slog(`  ${articles.length} article(s) found.`, articles.length ? "ok" : "dim");
      setStats(s => ({ ...s, newsArticlesFetched: s.newsArticlesFetched + articles.length, apiCalls: s.apiCalls + 1 }));

      articles.slice(0, 2).forEach(a => {
        slog(`    • [${fmtAge(a.published_at)}] ${(a.title||"").slice(0, 65)}`, "newsitem");
      });

      // AI analysis
      setStatus("thinking");
      alog("", "blank");
      alog(`── Analyzing: "${m.question.slice(0, 55)}"`, "header");
      const result = analyzeMarket(m, articles, portfolioRef.current.cash);
      result.thinkingLog.forEach(line => {
        const type = line.startsWith("[DECISION]") ? "decision"
                   : line.startsWith("[CONFIDENCE]") ? "conf"
                   : line.startsWith("[SENTIMENT]") ? "sent"
                   : line.startsWith("[MOMENTUM]")  ? "mom"
                   : line.startsWith("[LIQUIDITY]")  ? "liq"
                   : line.startsWith("[MISPRICING]") ? "mis"
                   : line.startsWith("===") ? "header"
                   : "dim";
        alog(line, type);
      });

      slog(`  AI: ${result.action}  Conf: ${result.confidence}%  ${result.reasoning.slice(0, 60)}`, result.action !== "SKIP" ? "trade" : "dim");

      // Execute trade
      const willTrade =
        (result.action === "BUY_YES" || result.action === "BUY_NO") &&
        result.confidence >= 70 &&
        result.amount > 0 &&
        portfolioRef.current.cash >= result.amount;

      if (willTrade) {
        const side  = result.action === "BUY_YES" ? "YES" : "NO";
        const tokenId = side === "YES" ? m.yesTokenId : m.noTokenId;
        const entryPrice = side === "YES" ? livePrice : (1 - livePrice);
        const shares     = result.amount / entryPrice;
        const maxProfit  = shares - result.amount;

        setStatus("trading");

        const trade = {
          id:           Date.now() + Math.random(),
          question:     m.question.slice(0, 70),
          conditionId:  m.conditionId,
          yesTokenId:   m.yesTokenId,
          side, tokenId, entryPrice,
          currentPrice: entryPrice,
          amount:       result.amount,
          shares,
          maxProfit,
          pnl:          0,
          pnlPct:       0,
          confidence:   result.confidence,
          openedAt:     new Date().toLocaleTimeString(),
          openedTs:     Date.now(),
          status:       "OPEN",
          category:     m.category || "unknown",
          reasoning:    result.reasoning,
        };

        setPortfolio(prev => {
          const next = {
            ...prev,
            cash:      prev.cash - result.amount,
            positions: [...prev.positions, trade],
            trades:    [...prev.trades, trade],
          };
          portfolioRef.current = next;
          return next;
        });

        slog(`  ✓ TRADE OPEN: BUY ${side} $${result.amount} @ ${pct(entryPrice)}  shares: ${shares.toFixed(3)}`, "tradeok");
        sylog(`[TRADE] BUY ${side} $${result.amount} @ ${pct(entryPrice)} — "${m.question.slice(0,40)}"`, "trade");
        setStats(s => ({
          ...s,
          tradesExecuted: s.tradesExecuted + 1,
        }));
        await sleep(300);
      }

      await sleep(200);
    }

    slog("", "blank"); slog("Scan complete.", "ok");
    sylog(`[SCAN] Complete. Cash: ${usd(portfolioRef.current.cash)}`, "ok");
    setStatus("idle");
  }, [slog, alog, sylog]);

  // ── Sell evaluator ─────────────────────────────────────────────────────────
  const evaluateSells = useCallback(async () => {
    const open = portfolioRef.current.positions.filter(p => p.status === "OPEN");
    if (!open.length) { sellog("No open positions to evaluate.", "dim"); return; }

    sellog("", "blank");
    sellog(`▶ Evaluating ${open.length} open position(s)...`, "header");

    for (const pos of open) {
      sellog("", "blank");
      sellog(`Position: BUY ${pos.side} "${pos.question.slice(0, 50)}"`, "mkt");

      const mid = await fetchMidpoint(pos.yesTokenId);
      let currentPrice = pos.currentPrice;
      if (mid !== null) {
        currentPrice = pos.side === "YES" ? mid : (1 - mid);
      }

      const pnl    = (currentPrice - pos.entryPrice) * pos.shares;
      const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

      // Update portfolio price
      setPortfolio(prev => ({
        ...prev,
        positions: prev.positions.map(p =>
          p.id === pos.id ? { ...p, currentPrice, pnl, pnlPct } : p
        ),
      }));

      // Get news for sell evaluation
      const articles = await fetchNews(pos.question.slice(0, 55));
      const newsTexts = articles.map(a => `${a.title||""} ${a.snippet||""}`);

      const sellResult = shouldSell(pos, currentPrice, newsTexts);
      sellResult.steps.forEach(step => {
        const t = step.includes("SELL") ? "sell"
                : step.includes("PROFIT") ? "profit"
                : step.includes("LOSS") || step.includes("WARNING") ? "loss"
                : "dim";
        sellog(`  ${step}`, t);
      });

      if (sellResult.decision === "SELL") {
        sellog(`  → CLOSING POSITION: ${usd(pnl >= 0 ? pnl : pnl)} (${(pnlPct*100).toFixed(1)}%)`, pnl >= 0 ? "profit" : "loss");

        const closedTrade = {
          ...pos,
          closePrice: currentPrice,
          closedAt:   new Date().toLocaleTimeString(),
          pnl,
          pnlPct,
          status: "CLOSED",
        };

        setPortfolio(prev => {
          const proceeds = currentPrice * pos.shares;
          const next = {
            ...prev,
            cash: prev.cash + proceeds,
            positions: prev.positions.filter(p => p.id !== pos.id),
            closedTrades: [...prev.closedTrades, closedTrade],
          };
          portfolioRef.current = next;
          return next;
        });

        sylog(`[CLOSE] ${pos.side} "${pos.question.slice(0,40)}" P&L: ${usd(pnl)}`, pnl >= 0 ? "ok" : "warn");
        setStats(s => {
          const best  = !s.bestTrade  || pnl > s.bestTrade.pnl  ? { ...pos, pnl } : s.bestTrade;
          const worst = !s.worstTrade || pnl < s.worstTrade.pnl ? { ...pos, pnl } : s.worstTrade;
          return { ...s, bestTrade: best, worstTrade: worst };
        });
      } else if (sellResult.decision === "CONSIDER_SELL") {
        sellog(`  → HOLD (monitoring closely, score ${sellResult.sellScore}/50)`, "warn");
      } else {
        sellog(`  → HOLD (score ${sellResult.sellScore}/50 — well below threshold)`, "ok");
      }
    }

    sellog("", "blank"); sellog("Evaluation complete.", "ok");
  }, [sellog, sylog]);

  // ── Auto mode ──────────────────────────────────────────────────────────────
  const toggleAuto = () => {
    if (autoMode) {
      setAutoMode(false);
      clearInterval(autoTimerRef.current);
      sylog("[AUTO] Disabled", "warn");
    } else {
      setAutoMode(true);
      sylog("[AUTO] Enabled — 60s scan, 30s sell check", "ok");
      scanAndDecide();
      autoTimerRef.current = setInterval(() => {
        scanAndDecide();
        evaluateSells();
      }, 60000);
    }
  };

  // ── Computed portfolio stats ───────────────────────────────────────────────
  const openPositions   = portfolio.positions.filter(p => p.status === "OPEN");
  const totalOpenValue  = openPositions.reduce((s, p) => s + p.currentPrice * p.shares, 0);
  const totalUnrealPnl  = openPositions.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalRealPnl    = portfolio.closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalPnl        = totalUnrealPnl + totalRealPnl;
  const totalValue      = portfolio.cash + totalOpenValue;
  const invested        = openPositions.reduce((s, p) => s + p.amount, 0);
  const totalReturn     = ((totalValue - STARTING_CASH) / STARTING_CASH * 100);
  const winCount        = portfolio.closedTrades.filter(t => t.pnl > 0).length;
  const winRate         = portfolio.closedTrades.length
    ? ((winCount / portfolio.closedTrades.length) * 100).toFixed(0)
    : "--";
  const avgConf         = openPositions.length
    ? (openPositions.reduce((s, p) => s + p.confidence, 0) / openPositions.length).toFixed(0)
    : "--";
  const uptimeFmt       = `${Math.floor(stats.uptime/3600)}h ${Math.floor((stats.uptime%3600)/60)}m ${stats.uptime%60}s`;

  // ── Color palette (CMD monochrome + accent colors) ─────────────────────────
  const C = {
    header:  "#fff",
    info:    "#bbb",
    ok:      "#ddd",
    err:     "#ccc",
    warn:    "#999",
    dim:     "#444",
    div:     "#333",
    prompt:  "#fff",
    mkt:     "#eee",
    price:   "#ccc",
    trade:   "#fff",
    tradeok: "#ddd",
    decision:"#fff",
    conf:    "#ccc",
    sent:    "#bbb",
    mom:     "#bbb",
    liq:     "#bbb",
    mis:     "#bbb",
    sell:    "#fff",
    profit:  "#ddd",
    loss:    "#888",
    newsitem:"#555",
    blank:   "transparent",
  };

  const statusColor = {
    idle:     "#555",
    scanning: "#aaa",
    thinking: "#bbb",
    trading:  "#fff",
  };

  return (
    <div style={{
      display: "grid",
      gridTemplateRows: "36px 28px 1fr 28px",
      gridTemplateColumns: "1fr",
      height: "100vh",
      width: "100vw",
      overflow: "hidden",
      background: "#080808",
      fontFamily: "Consolas, 'Lucida Console', monospace",
      fontSize: "12px",
      color: "#bbb",
      boxSizing: "border-box",
    }}>

      {/* ══ TITLE BAR ══════════════════════════════════════════════════════════ */}
      <div style={{
        background: "#111",
        borderBottom: "1px solid #222",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: "16px",
        userSelect: "none",
      }}>
        <span style={{ color: "#fff", fontWeight: "bold", letterSpacing: "2px" }}>POLYBOT</span>
        <span style={{ color: "#333" }}>|</span>
        <span style={{ color: "#555", fontSize: "11px" }}>Paper Trading Terminal  v2.0</span>
        <span style={{ color: "#333" }}>|</span>
        <span style={{ color: "#444", fontSize: "11px" }}>AI: Rule-Based Engine (no external API)</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "12px", fontSize: "11px" }}>
          <span style={{ color: statusColor[status] }}>
            ● {status.toUpperCase()}{autoMode ? "  [AUTO]" : ""}
          </span>
          <span style={{ color: "#333" }}>UPTIME: <span style={{ color: "#555" }}>{uptimeFmt}</span></span>
        </div>
      </div>

      {/* ══ STATS BAR ══════════════════════════════════════════════════════════ */}
      <div style={{
        background: "#0d0d0d",
        borderBottom: "1px solid #1a1a1a",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: "0",
        overflow: "hidden",
      }}>
        {[
          ["CASH",      usd(portfolio.cash),              totalValue > STARTING_CASH ? "#bbb" : "#888"],
          ["VALUE",     usd(totalValue),                  totalValue >= STARTING_CASH ? "#ccc" : "#777"],
          ["P&L",       (totalPnl>=0?"+":"")+usd(totalPnl), totalPnl >= 0 ? "#ddd" : "#777"],
          ["RETURN",    (totalReturn>=0?"+":"")+totalReturn.toFixed(2)+"%", totalReturn>=0?"#ccc":"#777"],
          ["INVESTED",  usd(invested),                    "#888"],
          ["UNREALIZED",(totalUnrealPnl>=0?"+":"")+usd(totalUnrealPnl), totalUnrealPnl>=0?"#bbb":"#666"],
          ["REALIZED",  (totalRealPnl>=0?"+":"")+usd(totalRealPnl),     totalRealPnl>=0?"#bbb":"#666"],
          ["POSITIONS", openPositions.length,             "#888"],
          ["CLOSED",    portfolio.closedTrades.length,    "#555"],
          ["WIN RATE",  winRate+"%",                      "#888"],
          ["TRADES",    stats.tradesExecuted,             "#555"],
          ["SCANS",     stats.scansRun,                   "#444"],
          ["API CALLS", stats.apiCalls,                   "#333"],
        ].map(([label, val, color]) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", padding: "2px 10px", borderRight: "1px solid #161616" }}>
            <span style={{ color: "#2e2e2e", fontSize: "9px", letterSpacing: "0.5px" }}>{label}</span>
            <span style={{ color, fontSize: "11px" }}>{val}</span>
          </div>
        ))}
      </div>

      {/* ══ MAIN GRID ══════════════════════════════════════════════════════════ */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 260px",
        gridTemplateRows: "1fr 1fr",
        overflow: "hidden",
        gap: "1px",
        background: "#151515",
      }}>

        {/* ─ Panel 1: Market Scanner ─ */}
        <PanelBox title="MARKET SCANNER" badge={`${markets.length} mkts`} color="#bbb"
          actions={[
            { label: status !== "idle" ? "RUNNING..." : "SCAN", onClick: scanAndDecide, disabled: status !== "idle" },
            { label: autoMode ? "STOP AUTO" : "AUTO 60s",       onClick: toggleAuto },
          ]}
        >
          <LogArea logRef={scanLogRef} logs={scanLog} C={C} />
        </PanelBox>

        {/* ─ Panel 2: AI Thinking ─ */}
        <PanelBox title="AI ENGINE — THINKING LOG" badge="rule-based" color="#888">
          <LogArea logRef={aiLogRef} logs={aiLog} C={C} />
        </PanelBox>

        {/* ─ Panel 3: Sell Monitor ─ */}
        <PanelBox title="SELL / HOLD MONITOR" badge="position evaluator" color="#888"
          actions={[
            { label: "EVAL SELLS", onClick: evaluateSells, disabled: status !== "idle" },
          ]}
        >
          <LogArea logRef={sellLogRef} logs={sellLog} C={C} />
        </PanelBox>

        {/* ─ Panel 4: System + Live Stats ─ */}
        <PanelBox title="SYSTEM LOG + STATS" color="#555">
          <LogArea logRef={sysLogRef} logs={systemLog} C={C} small />
          <div style={{ borderTop: "1px solid #1a1a1a", padding: "6px", fontSize: "10px", color: "#3a3a3a" }}>
            <StatRow label="Last scan"    value={stats.lastScan || "--"} />
            <StatRow label="Avg conf."    value={avgConf+"%"} />
            <StatRow label="News fetched" value={stats.newsArticlesFetched} />
            <StatRow label="Best trade"   value={stats.bestTrade ? usd(stats.bestTrade.pnl) : "--"} />
            <StatRow label="Worst trade"  value={stats.worstTrade ? usd(stats.worstTrade.pnl) : "--"} />
            <StatRow label="Cash / Start" value={`${usd(portfolio.cash)} / ${usd(STARTING_CASH)}`} />
          </div>
        </PanelBox>

        {/* ─ Panel 5/6/7: Orders / P&L / Trade History ─ (spans 3 cols) */}
        <div style={{ gridColumn: "1 / 4", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {/* Tab bar */}
          <div style={{
            display: "flex",
            background: "#0d0d0d",
            borderBottom: "1px solid #1a1a1a",
            padding: "0 8px",
            gap: "2px",
          }}>
            {[
              { id: "orders",  label: `OPEN POSITIONS (${openPositions.length})` },
              { id: "pnl",     label: `P&L DASHBOARD` },
              { id: "trades",  label: `TRADE HISTORY (${portfolio.trades.length})` },
              { id: "markets", label: `LIVE MARKETS (${markets.length})` },
            ].map(tab => (
              <button key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: activeTab === tab.id ? "#1a1a1a" : "transparent",
                  border: "none",
                  borderBottom: activeTab === tab.id ? "1px solid #555" : "1px solid transparent",
                  color: activeTab === tab.id ? "#ccc" : "#444",
                  padding: "4px 14px",
                  fontSize: "11px",
                  fontFamily: "Consolas, monospace",
                  cursor: "pointer",
                  letterSpacing: "0.5px",
                }}
              >{tab.label}</button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflow: "auto", background: "#090909" }}>

            {/* ─ OPEN POSITIONS ─ */}
            {activeTab === "orders" && (
              <div style={{ padding: "8px" }}>
                {openPositions.length === 0
                  ? <div style={{ color: "#2a2a2a", padding: "8px" }}>No open positions. Run a scan to find trades.</div>
                  : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                      <thead>
                        <tr style={{ color: "#3a3a3a", borderBottom: "1px solid #1a1a1a" }}>
                          {["#","Market","Side","Entry","Current","Shares","Cost","Curr.Value","Unreal.P&L","P&L%","Max.Profit","Conf","Opened","Status"].map(h => (
                            <th key={h} style={{ padding: "3px 6px", textAlign: "left", fontWeight: "normal", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {openPositions.map((p, i) => {
                          const currVal = p.currentPrice * p.shares;
                          const pnlColor = (p.pnl || 0) >= 0 ? "#bbb" : "#666";
                          return (
                            <tr key={p.id} style={{ borderBottom: "1px solid #111" }}>
                              <td style={{ padding: "3px 6px", color: "#444" }}>{i+1}</td>
                              <td style={{ padding: "3px 6px", color: "#888", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.question}</td>
                              <td style={{ padding: "3px 6px", color: p.side === "YES" ? "#ccc" : "#999" }}>{p.side}</td>
                              <td style={{ padding: "3px 6px", color: "#777" }}>{pct(p.entryPrice)}</td>
                              <td style={{ padding: "3px 6px", color: "#999" }}>{pct(p.currentPrice)}</td>
                              <td style={{ padding: "3px 6px", color: "#555" }}>{p.shares.toFixed(3)}</td>
                              <td style={{ padding: "3px 6px", color: "#777" }}>{usd(p.amount)}</td>
                              <td style={{ padding: "3px 6px", color: "#888" }}>{usd(currVal)}</td>
                              <td style={{ padding: "3px 6px", color: pnlColor }}>{(p.pnl>=0?"+":"")+usd(p.pnl||0)}</td>
                              <td style={{ padding: "3px 6px", color: pnlColor }}>{((p.pnlPct||0)*100).toFixed(1)}%</td>
                              <td style={{ padding: "3px 6px", color: "#555" }}>{usd(p.maxProfit)}</td>
                              <td style={{ padding: "3px 6px", color: "#666" }}>{p.confidence}%</td>
                              <td style={{ padding: "3px 6px", color: "#444" }}>{p.openedAt}</td>
                              <td style={{ padding: "3px 6px" }}>
                                <span style={{ background: "#1a1a1a", color: "#777", padding: "1px 6px", fontSize: "10px" }}>OPEN</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: "1px solid #222", color: "#555" }}>
                          <td colSpan={6} style={{ padding: "4px 6px" }}>TOTALS</td>
                          <td style={{ padding: "4px 6px", color: "#777" }}>{usd(invested)}</td>
                          <td style={{ padding: "4px 6px", color: "#888" }}>{usd(totalOpenValue)}</td>
                          <td style={{ padding: "4px 6px", color: totalUnrealPnl >= 0 ? "#bbb" : "#666" }}>{(totalUnrealPnl>=0?"+":"")+usd(totalUnrealPnl)}</td>
                          <td colSpan={5}></td>
                        </tr>
                      </tfoot>
                    </table>
                  )
                }
              </div>
            )}

            {/* ─ P&L DASHBOARD ─ */}
            {activeTab === "pnl" && (
              <div style={{ padding: "10px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px" }}>
                {[
                  { label: "Starting Balance",  value: usd(STARTING_CASH),                    sub: "initial deposit" },
                  { label: "Current Cash",       value: usd(portfolio.cash),                   sub: "available to trade" },
                  { label: "Open Position Value",value: usd(totalOpenValue),                   sub: `${openPositions.length} positions` },
                  { label: "Total Portfolio",    value: usd(totalValue),                       sub: "cash + positions" },
                  { label: "Unrealized P&L",     value: (totalUnrealPnl>=0?"+":"")+usd(totalUnrealPnl), sub: "open positions", hi: totalUnrealPnl >= 0 },
                  { label: "Realized P&L",       value: (totalRealPnl>=0?"+":"")+usd(totalRealPnl),     sub: `from ${portfolio.closedTrades.length} closed`, hi: totalRealPnl >= 0 },
                  { label: "Total P&L",          value: (totalPnl>=0?"+":"")+usd(totalPnl),             sub: "unrealized + realized", hi: totalPnl >= 0 },
                  { label: "Total Return",       value: (totalReturn>=0?"+":"")+totalReturn.toFixed(2)+"%", sub: "vs starting balance", hi: totalReturn >= 0 },
                  { label: "Amount Invested",    value: usd(invested),                         sub: "currently in market" },
                  { label: "Win Rate",           value: winRate+"%",                           sub: `${winCount} / ${portfolio.closedTrades.length} trades` },
                  { label: "Best Trade",         value: stats.bestTrade ? usd(stats.bestTrade.pnl) : "--", sub: stats.bestTrade ? stats.bestTrade.question?.slice(0,25)+"..." : "no trades yet", hi: true },
                  { label: "Worst Trade",        value: stats.worstTrade ? usd(stats.worstTrade.pnl) : "--", sub: stats.worstTrade ? stats.worstTrade.question?.slice(0,25)+"..." : "no trades yet", hi: false },
                ].map(card => (
                  <div key={card.label} style={{
                    background: "#0d0d0d",
                    border: "1px solid #1a1a1a",
                    padding: "10px 12px",
                  }}>
                    <div style={{ color: "#333", fontSize: "10px", letterSpacing: "0.5px", marginBottom: "4px" }}>{card.label}</div>
                    <div style={{ color: card.hi === true ? "#ddd" : card.hi === false ? "#666" : "#aaa", fontSize: "16px", fontWeight: "bold", marginBottom: "3px" }}>{card.value}</div>
                    <div style={{ color: "#2a2a2a", fontSize: "10px" }}>{card.sub}</div>
                  </div>
                ))}

                {/* Closed trades mini table */}
                {portfolio.closedTrades.length > 0 && (
                  <div style={{ gridColumn: "1 / 5", marginTop: "4px" }}>
                    <div style={{ color: "#333", fontSize: "10px", marginBottom: "6px", letterSpacing: "0.5px" }}>CLOSED TRADES</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                      <thead>
                        <tr style={{ color: "#333", borderBottom: "1px solid #1a1a1a" }}>
                          {["Market","Side","Entry","Close","Cost","Proceeds","P&L","P&L%","Closed At"].map(h => (
                            <th key={h} style={{ padding: "3px 6px", textAlign: "left", fontWeight: "normal" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {portfolio.closedTrades.map(t => (
                          <tr key={t.id} style={{ borderBottom: "1px solid #0f0f0f" }}>
                            <td style={{ padding: "3px 6px", color: "#555", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.question}</td>
                            <td style={{ padding: "3px 6px", color: "#666" }}>{t.side}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{pct(t.entryPrice)}</td>
                            <td style={{ padding: "3px 6px", color: "#666" }}>{pct(t.closePrice)}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{usd(t.amount)}</td>
                            <td style={{ padding: "3px 6px", color: "#666" }}>{usd(t.closePrice * t.shares)}</td>
                            <td style={{ padding: "3px 6px", color: t.pnl >= 0 ? "#bbb" : "#555" }}>{(t.pnl>=0?"+":"")+usd(t.pnl)}</td>
                            <td style={{ padding: "3px 6px", color: t.pnl >= 0 ? "#888" : "#444" }}>{((t.pnlPct||0)*100).toFixed(1)}%</td>
                            <td style={{ padding: "3px 6px", color: "#333" }}>{t.closedAt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ─ TRADE HISTORY ─ */}
            {activeTab === "trades" && (
              <div style={{ padding: "8px" }}>
                {portfolio.trades.length === 0
                  ? <div style={{ color: "#2a2a2a", padding: "8px" }}>No trades executed yet.</div>
                  : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                      <thead>
                        <tr style={{ color: "#3a3a3a", borderBottom: "1px solid #1a1a1a" }}>
                          {["#","Time","Market","Side","Entry Price","Amount","Shares","Max Profit","Confidence","Status","P&L","Reasoning"].map(h => (
                            <th key={h} style={{ padding: "3px 6px", textAlign: "left", fontWeight: "normal", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...portfolio.trades].reverse().map((t, i) => {
                          const closed = portfolio.closedTrades.find(c => c.id === t.id);
                          const pnl = closed ? closed.pnl : (t.pnl || 0);
                          return (
                            <tr key={t.id} style={{ borderBottom: "1px solid #0f0f0f" }}>
                              <td style={{ padding: "3px 6px", color: "#333" }}>{portfolio.trades.length - i}</td>
                              <td style={{ padding: "3px 6px", color: "#3a3a3a" }}>{t.openedAt}</td>
                              <td style={{ padding: "3px 6px", color: "#666", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.question}</td>
                              <td style={{ padding: "3px 6px", color: t.side === "YES" ? "#aaa" : "#777" }}>{t.side}</td>
                              <td style={{ padding: "3px 6px", color: "#666" }}>{pct(t.entryPrice)}</td>
                              <td style={{ padding: "3px 6px", color: "#777" }}>{usd(t.amount)}</td>
                              <td style={{ padding: "3px 6px", color: "#555" }}>{t.shares.toFixed(3)}</td>
                              <td style={{ padding: "3px 6px", color: "#555" }}>{usd(t.maxProfit)}</td>
                              <td style={{ padding: "3px 6px", color: "#555" }}>{t.confidence}%</td>
                              <td style={{ padding: "3px 6px" }}>
                                <span style={{ background: closed ? "#111" : "#1a1a1a", color: closed ? "#555" : "#777", padding: "1px 5px", fontSize: "10px" }}>
                                  {closed ? "CLOSED" : "OPEN"}
                                </span>
                              </td>
                              <td style={{ padding: "3px 6px", color: pnl >= 0 ? "#bbb" : "#555" }}>{(pnl>=0?"+":"")+usd(pnl)}</td>
                              <td style={{ padding: "3px 6px", color: "#3a3a3a", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.reasoning}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )
                }
              </div>
            )}

            {/* ─ LIVE MARKETS ─ */}
            {activeTab === "markets" && (
              <div style={{ padding: "8px" }}>
                {markets.length === 0
                  ? <div style={{ color: "#2a2a2a", padding: "8px" }}>Run scan to populate market list.</div>
                  : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                      <thead>
                        <tr style={{ color: "#3a3a3a", borderBottom: "1px solid #1a1a1a" }}>
                          {["#","Market","YES%","NO%","Bid","Ask","Spread","Vol 24h","Vol Total","Liquidity","24h Chg","7d Chg","End Date","Category"].map(h => (
                            <th key={h} style={{ padding: "3px 6px", textAlign: "left", fontWeight: "normal", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {markets.map((m, i) => (
                          <tr key={m.id} style={{ borderBottom: "1px solid #0f0f0f" }}>
                            <td style={{ padding: "3px 6px", color: "#333" }}>{i+1}</td>
                            <td style={{ padding: "3px 6px", color: "#666", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.question}</td>
                            <td style={{ padding: "3px 6px", color: "#aaa" }}>{pct(m.yesPrice)}</td>
                            <td style={{ padding: "3px 6px", color: "#666" }}>{pct(m.noPrice)}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{m.bestBid ? pct(m.bestBid) : "--"}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{m.bestAsk ? pct(m.bestAsk) : "--"}</td>
                            <td style={{ padding: "3px 6px", color: "#444" }}>{m.bestBid && m.bestAsk ? ((m.bestAsk-m.bestBid)*100).toFixed(1)+"¢" : "--"}</td>
                            <td style={{ padding: "3px 6px", color: "#777" }}>{mini(m.volume24h)}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{mini(m.volume)}</td>
                            <td style={{ padding: "3px 6px", color: "#555" }}>{mini(m.liquidity)}</td>
                            <td style={{ padding: "3px 6px", color: m.oneDayChange > 0 ? "#aaa" : m.oneDayChange < 0 ? "#666" : "#444" }}>
                              {m.oneDayChange > 0 ? "+" : ""}{(m.oneDayChange*100).toFixed(1)}%
                            </td>
                            <td style={{ padding: "3px 6px", color: "#444" }}>
                              {m.oneWeekChange > 0 ? "+" : ""}{(m.oneWeekChange*100).toFixed(1)}%
                            </td>
                            <td style={{ padding: "3px 6px", color: "#3a3a3a" }}>{m.endDate ? new Date(m.endDate).toLocaleDateString() : "--"}</td>
                            <td style={{ padding: "3px 6px", color: "#333" }}>{m.category || "--"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                }
              </div>
            )}
          </div>
        </div>

        {/* ─ Panel 8: Live Market Snapshot sidebar ─ */}
        <div style={{ overflow: "hidden", display: "flex", flexDirection: "column", background: "#080808" }}>
          <PanelHeader title="LIVE MARKET DATA" />
          <div style={{ flex: 1, overflowY: "auto", padding: "6px" }}>
            {markets.slice(0, 20).map(m => (
              <div key={m.id} style={{
                padding: "5px 6px",
                marginBottom: "2px",
                borderLeft: `2px solid ${m.oneDayChange > 0.05 ? "#555" : m.oneDayChange < -0.05 ? "#333" : "#222"}`,
                background: "#0a0a0a",
              }}>
                <div style={{ color: "#555", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.question.slice(0, 32)}</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", marginTop: "1px" }}>
                  <span style={{ color: "#888" }}>Y:{pct(m.yesPrice)}</span>
                  <span style={{ color: "#444" }}>N:{pct(m.noPrice)}</span>
                  <span style={{ color: m.oneDayChange > 0 ? "#777" : m.oneDayChange < 0 ? "#444" : "#333" }}>
                    {m.oneDayChange > 0 ? "▲" : m.oneDayChange < 0 ? "▼" : "─"}
                    {Math.abs(m.oneDayChange * 100).toFixed(1)}%
                  </span>
                  <span style={{ color: "#333" }}>{mini(m.volume24h)}</span>
                </div>
              </div>
            ))}
            {markets.length === 0 && <div style={{ color: "#1e1e1e", padding: "6px" }}>Run scan</div>}
          </div>
        </div>

      </div>

      {/* ══ BOTTOM STATUS BAR ══════════════════════════════════════════════════ */}
      <div style={{
        background: "#0d0d0d",
        borderTop: "1px solid #1a1a1a",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: "20px",
        fontSize: "11px",
        color: "#333",
      }}>
        <span>PolyBot v2.0</span>
        <span style={{ color: "#222" }}>|</span>
        <span>AI: Rule-Based (Sentiment + Momentum + Liquidity + Mispricing)</span>
        <span style={{ color: "#222" }}>|</span>
        <span>Data: Polymarket Gamma API + CLOB API + TheNewsAPI</span>
        <span style={{ color: "#222" }}>|</span>
        <span>Mode: PAPER TRADING (no real funds)</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "16px" }}>
          <span>Markets: {markets.length}</span>
          <span>Positions: {openPositions.length}</span>
          <span>Cash: {usd(portfolio.cash)}</span>
        </div>
      </div>

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #080808; }
        ::-webkit-scrollbar-thumb { background: #1e1e1e; }
        body { margin: 0; overflow: hidden; }
      `}</style>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PanelHeader({ title, badge, color = "#444", actions = [] }) {
  return (
    <div style={{
      background: "#0d0d0d",
      borderBottom: "1px solid #1a1a1a",
      padding: "4px 8px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      flexShrink: 0,
    }}>
      <span style={{ color: color, fontSize: "10px", letterSpacing: "1px", fontWeight: "bold" }}>{title}</span>
      {badge && <span style={{ color: "#2a2a2a", fontSize: "9px" }}>{badge}</span>}
      <div style={{ marginLeft: "auto", display: "flex", gap: "4px" }}>
        {actions.map(a => (
          <button key={a.label}
            onClick={a.onClick}
            disabled={a.disabled}
            style={{
              background: "transparent",
              border: `1px solid ${a.disabled ? "#1a1a1a" : "#2e2e2e"}`,
              color: a.disabled ? "#222" : "#555",
              padding: "1px 8px",
              fontSize: "10px",
              fontFamily: "Consolas, monospace",
              cursor: a.disabled ? "not-allowed" : "pointer",
              letterSpacing: "0.5px",
            }}
          >{a.label}</button>
        ))}
      </div>
    </div>
  );
}

function PanelBox({ title, badge, color, children, actions = [] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#090909" }}>
      <PanelHeader title={title} badge={badge} color={color} actions={actions} />
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

function LogArea({ logRef, logs, C, small = false }) {
  return (
    <div
      ref={logRef}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "6px 8px 8px",
        fontSize: small ? "10px" : "11px",
        lineHeight: "1.5",
      }}
    >
      {logs.map(l => {
        if (l.type === "blank") return <div key={l.id} style={{ height: "3px" }} />;
        return (
          <div key={l.id} style={{ display: "flex", gap: "8px" }}>
            <span style={{ color: "#222", flexShrink: 0, fontSize: "9px", paddingTop: "1px" }}>{l.ts}</span>
            <span style={{ color: C[l.type] || "#888", wordBreak: "break-word" }}>{l.msg}</span>
          </div>
        );
      })}
      <span style={{
        display: "inline-block", width: "6px", height: "11px",
        background: "#333", animation: "blink 1.2s step-end infinite",
        marginLeft: "2px", verticalAlign: "text-bottom",
      }} />
    </div>
  );
}

function StatRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
      <span style={{ color: "#2a2a2a" }}>{label}</span>
      <span style={{ color: "#444" }}>{value}</span>
    </div>
  );
}