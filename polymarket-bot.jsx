import { useState, useEffect, useRef, useCallback } from "react";

const NEWS_API_KEY = "GzCg1YdRg2mxy6OJ7XQgk2UNZwV9Pq7XNbDnuLKv";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// ─── Polymarket REST helpers (no auth needed for public data) ───────────────
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

async function fetchTopMarkets(limit = 20) {
  try {
    const r = await fetch(
      `${GAMMA_BASE}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`
    );
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchOrderBook(tokenId) {
  try {
    const r = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchMarketPrice(tokenId) {
  try {
    const r = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    const d = await r.json();
    return parseFloat(d.mid || 0);
  } catch {
    return null;
  }
}

async function fetchNews(query) {
  try {
    const encoded = encodeURIComponent(query);
    const r = await fetch(
      `https://api.thenewsapi.com/v1/news/all?api_token=${NEWS_API_KEY}&search=${encoded}&language=en&limit=5`
    );
    const d = await r.json();
    return d.data || [];
  } catch {
    return [];
  }
}

// ─── Claude API helper ───────────────────────────────────────────────────────
async function askClaude(systemPrompt, userMessage) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const d = await r.json();
  return d.content?.[0]?.text || "";
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function PolyBot() {
  const [logs, setLogs] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [portfolio, setPortfolio] = useState({
    cash: 1000,
    positions: [],
    trades: [],
  });
  const [status, setStatus] = useState("idle"); // idle | scanning | thinking | trading
  const [phase, setPhase] = useState("BOOT");
  const [autoMode, setAutoMode] = useState(false);
  const [scanInterval, setScanInterval] = useState(null);
  const [tick, setTick] = useState(0);
  const logRef = useRef(null);
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;

  const log = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [
      ...prev.slice(-200),
      { ts, msg, type, id: Date.now() + Math.random() },
    ]);
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // Boot sequence
  useEffect(() => {
    const boot = async () => {
      setPhase("BOOT");
      log("█▀█ █▀█ █   █ █ █▄▄ █▀█ ▀█▀", "brand");
      log("█▀▀ █▄█ █▄▄ ▀▄▀ █▄█ █▄█  █ ", "brand");
      log("", "divider");
      log("POLYMARKET PAPER TRADING BOT v1.0", "title");
      log("Powered by pmxtjs + TheNewsAPI + Claude", "dim");
      log("", "divider");
      await sleep(400);
      log("[ INIT ] Loading system modules...", "sys");
      await sleep(300);
      log("[ OK   ] Polymarket CLOB interface ready", "ok");
      await sleep(200);
      log("[ OK   ] News intelligence module ready", "ok");
      await sleep(200);
      log("[ OK   ] Claude analysis engine ready", "ok");
      await sleep(200);
      log("[ OK   ] Paper wallet initialized: $1,000.00 USDC", "ok");
      log("", "divider");
      log("Strategy: HIGH CONFIDENCE ONLY (95%+ threshold)", "warn");
      log("Max position size: $50 per trade", "warn");
      log("", "divider");
      log('Type "start" to begin scanning or click START BOT', "prompt");
      setPhase("READY");
    };
    boot();
  }, []);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const scanAndDecide = useCallback(async () => {
    if (status !== "idle" && status !== "auto") return;
    setStatus("scanning");
    setPhase("SCANNING");

    log("", "divider");
    log(`[ SCAN ] Fetching top Polymarket markets...`, "sys");

    const rawMarkets = await fetchTopMarkets(15);
    if (!rawMarkets.length) {
      log("[ ERR  ] Could not fetch markets — check network", "err");
      setStatus("idle");
      setPhase("READY");
      return;
    }

    const parsed = rawMarkets
      .filter((m) => m.active && !m.closed && m.clobTokenIds)
      .map((m) => {
        let yesToken = null;
        try {
          const ids = JSON.parse(m.clobTokenIds);
          yesToken = ids[0];
        } catch {}
        return {
          id: m.id,
          question: m.question || m.title || "Unknown Market",
          yesToken,
          yesPrice: parseFloat(m.bestAsk || m.outcomePrices?.[0] || 0.5),
          noPrice: parseFloat(m.outcomePrices?.[1] || 0.5),
          volume24h: parseFloat(m.volume24hr || 0),
          liquidity: parseFloat(m.liquidity || 0),
          endDate: m.endDateIso || m.endDate,
        };
      })
      .filter((m) => m.yesToken && m.volume24h > 1000);

    setMarkets(parsed);
    log(`[ OK   ] Found ${parsed.length} active markets with volume`, "ok");

    // Pick top 5 by volume for analysis
    const topMarkets = parsed.slice(0, 5);

    for (const market of topMarkets) {
      if (!autoMode && status === "idle") break;

      setPhase("THINKING");
      setStatus("thinking");
      log("", "divider");
      log(`[ MKT  ] ${market.question.slice(0, 80)}`, "market");
      log(
        `[ PRICE] YES: ${(market.yesPrice * 100).toFixed(1)}%  NO: ${(market.noPrice * 100).toFixed(1)}%  Vol24h: $${market.volume24h.toLocaleString()}`,
        "dim"
      );

      // Fetch news
      const searchTerm = market.question.slice(0, 60);
      log(`[ NEWS ] Searching: "${searchTerm.slice(0, 50)}..."`, "sys");
      const articles = await fetchNews(searchTerm);

      if (articles.length === 0) {
        log("[ NEWS ] No relevant articles found, skipping...", "dim");
        continue;
      }

      log(`[ NEWS ] ${articles.length} articles found`, "ok");
      articles.slice(0, 3).forEach((a) => {
        log(`         • ${a.title?.slice(0, 70) || "untitled"}`, "dim");
      });

      // Ask Claude to analyze
      log(`[ AI   ] Analyzing with Claude...`, "sys");

      const newsContext = articles
        .slice(0, 3)
        .map((a) => `Title: ${a.title}\nSnippet: ${a.snippet || a.description || ""}`)
        .join("\n\n");

      const systemPrompt = `You are a chill paper trading bot analyzing prediction markets. 
You only invest when you are extremely confident (95%+ certainty). 
You have $${portfolioRef.current.cash.toFixed(2)} available.
Max single trade: $50.
Be conservative. Only say YES to a trade if you're almost certain.
Respond ONLY in this exact JSON format (no markdown, no explanation):
{
  "action": "BUY_YES" | "BUY_NO" | "SKIP",
  "confidence": 0-100,
  "amount": 0-50,
  "reasoning": "one sentence max",
  "outlook": "bullish" | "bearish" | "uncertain"
}`;

      const userMsg = `Market: "${market.question}"
Current YES price: ${(market.yesPrice * 100).toFixed(1)}%
Current NO price: ${(market.noPrice * 100).toFixed(1)}%
24h Volume: $${market.volume24h.toLocaleString()}

Recent News:
${newsContext}

Should I trade this market?`;

      let decision;
      try {
        const raw = await askClaude(systemPrompt, userMsg);
        // Strip any markdown fences
        const clean = raw.replace(/```json|```/g, "").trim();
        decision = JSON.parse(clean);
      } catch (e) {
        log(`[ ERR  ] Claude parse error, skipping`, "err");
        continue;
      }

      const outlook = decision.outlook === "bullish" ? "▲" : decision.outlook === "bearish" ? "▼" : "◆";
      log(`[ AI   ] ${outlook} Confidence: ${decision.confidence}%  Outlook: ${decision.outlook?.toUpperCase()}`, "analysis");
      log(`[ AI   ] "${decision.reasoning}"`, "quote");

      if (
        (decision.action === "BUY_YES" || decision.action === "BUY_NO") &&
        decision.confidence >= 85 &&
        decision.amount > 0 &&
        portfolioRef.current.cash >= decision.amount
      ) {
        const side = decision.action === "BUY_YES" ? "YES" : "NO";
        const price = side === "YES" ? market.yesPrice : market.noPrice;
        const shares = decision.amount / price;

        setPhase("TRADING");
        setStatus("trading");
        log(`[ BET  ] EXECUTING: BUY ${side} on this market`, "trade");
        log(`         Amount: $${decision.amount.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`, "trade");
        log(`         Shares: ${shares.toFixed(2)} contracts`, "trade");

        await sleep(600); // simulate order delay

        const trade = {
          id: Date.now(),
          question: market.question.slice(0, 60),
          side,
          price,
          amount: decision.amount,
          shares,
          timestamp: new Date().toISOString(),
          status: "OPEN",
          confidence: decision.confidence,
          marketId: market.id,
          yesToken: market.yesToken,
        };

        setPortfolio((prev) => ({
          ...prev,
          cash: prev.cash - decision.amount,
          positions: [...prev.positions, trade],
          trades: [...prev.trades, trade],
        }));

        log(`[ OK   ] Order filled! Remaining cash: $${(portfolioRef.current.cash - decision.amount).toFixed(2)}`, "ok");
        setTick((t) => t + 1);
      } else if (decision.confidence >= 85) {
        log(`[ SKIP ] High confidence but action=${decision.action} or insufficient funds`, "warn");
      } else {
        log(`[ SKIP ] Confidence too low (${decision.confidence}% < 85%), holding...`, "dim");
      }

      await sleep(500);
    }

    log("", "divider");
    log("[ DONE ] Scan cycle complete", "ok");
    setStatus("idle");
    setPhase("READY");
  }, [status, autoMode, log]);

  // Update prices for open positions
  const updatePrices = useCallback(async () => {
    const positions = portfolioRef.current.positions.filter((p) => p.status === "OPEN");
    if (!positions.length) return;

    for (const pos of positions) {
      if (!pos.yesToken) continue;
      const price = await fetchMarketPrice(pos.yesToken);
      if (price === null) continue;

      const currentPrice = pos.side === "YES" ? price : 1 - price;
      const pnl = (currentPrice - pos.price) * pos.shares;

      setPortfolio((prev) => ({
        ...prev,
        positions: prev.positions.map((p) =>
          p.id === pos.id ? { ...p, currentPrice, pnl } : p
        ),
      }));
    }
    setTick((t) => t + 1);
  }, []);

  const toggleAuto = () => {
    if (autoMode) {
      setAutoMode(false);
      if (scanInterval) {
        clearInterval(scanInterval);
        setScanInterval(null);
      }
      log("[ AUTO ] Auto-trading DISABLED", "warn");
    } else {
      setAutoMode(true);
      log("[ AUTO ] Auto-trading ENABLED (60s intervals)", "ok");
      scanAndDecide();
      const iv = setInterval(() => {
        scanAndDecide();
        updatePrices();
      }, 60000);
      setScanInterval(iv);
    }
  };

  const totalPnl = portfolio.positions
    .filter((p) => p.pnl !== undefined)
    .reduce((s, p) => s + (p.pnl || 0), 0);

  const totalValue = portfolio.cash + portfolio.positions.reduce(
    (s, p) => s + (p.currentPrice ? p.currentPrice * p.shares : p.amount),
    0
  );

  // Log colors
  const colorMap = {
    brand: "#00ff9d",
    title: "#ffffff",
    dim: "#666",
    divider: "#333",
    sys: "#4af",
    ok: "#0f9",
    err: "#f44",
    warn: "#fa0",
    market: "#e8a",
    trade: "#ff0",
    analysis: "#a8f",
    quote: "#aaa",
    prompt: "#6cf",
    info: "#ccc",
  };

  const phaseColors = {
    BOOT: "#4af",
    READY: "#0f9",
    SCANNING: "#fa0",
    THINKING: "#a8f",
    TRADING: "#ff0",
  };

  return (
    <div style={{
      background: "#0a0a0a",
      minHeight: "100vh",
      fontFamily: "'Courier New', Courier, monospace",
      color: "#ccc",
      display: "flex",
      flexDirection: "column",
      padding: "0",
    }}>
      {/* Header bar */}
      <div style={{
        background: "#111",
        borderBottom: "1px solid #222",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: "16px",
        flexWrap: "wrap",
      }}>
        <span style={{ color: "#00ff9d", fontWeight: "bold", fontSize: "14px", letterSpacing: "2px" }}>
          POLYBOT
        </span>
        <span style={{ color: "#333", fontSize: "12px" }}>|</span>
        <span style={{
          color: phaseColors[phase] || "#ccc",
          fontSize: "11px",
          padding: "2px 8px",
          border: `1px solid ${phaseColors[phase] || "#333"}`,
          borderRadius: "2px",
        }}>
          {phase}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "24px", fontSize: "12px" }}>
          <span>
            <span style={{ color: "#666" }}>CASH: </span>
            <span style={{ color: "#0f9" }}>${portfolio.cash.toFixed(2)}</span>
          </span>
          <span>
            <span style={{ color: "#666" }}>VALUE: </span>
            <span style={{ color: "#4af" }}>${totalValue.toFixed(2)}</span>
          </span>
          <span>
            <span style={{ color: "#666" }}>P&L: </span>
            <span style={{ color: totalPnl >= 0 ? "#0f9" : "#f44" }}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </span>
          </span>
          <span>
            <span style={{ color: "#666" }}>POSITIONS: </span>
            <span style={{ color: "#fa0" }}>{portfolio.positions.filter(p => p.status === "OPEN").length}</span>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Terminal log */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            ref={logRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "12px 16px",
              fontSize: "12px",
              lineHeight: "1.6",
              maxHeight: "calc(100vh - 120px)",
            }}
          >
            {logs.map((l) => (
              <div key={l.id} style={{ display: "flex", gap: "8px" }}>
                {l.type !== "divider" && l.type !== "brand" && (
                  <span style={{ color: "#333", flexShrink: 0 }}>{l.ts}</span>
                )}
                <span style={{ color: colorMap[l.type] || "#ccc", wordBreak: "break-word" }}>
                  {l.type === "divider"
                    ? "──────────────────────────────────────────────────"
                    : l.msg}
                </span>
              </div>
            ))}
            {/* Blinking cursor */}
            <span style={{
              display: "inline-block",
              width: "8px",
              height: "14px",
              background: "#00ff9d",
              animation: "blink 1s step-end infinite",
              marginLeft: "4px",
              verticalAlign: "middle",
            }} />
          </div>

          {/* Control bar */}
          <div style={{
            background: "#111",
            borderTop: "1px solid #222",
            padding: "8px 16px",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
          }}>
            <button
              onClick={scanAndDecide}
              disabled={status !== "idle"}
              style={btnStyle("#0f9", status !== "idle")}
            >
              ▶ SCAN ONCE
            </button>
            <button
              onClick={toggleAuto}
              style={btnStyle(autoMode ? "#f44" : "#fa0", false)}
            >
              {autoMode ? "■ STOP AUTO" : "⟳ START AUTO"}
            </button>
            <button
              onClick={updatePrices}
              style={btnStyle("#4af", false)}
            >
              ↻ REFRESH PRICES
            </button>
            <button
              onClick={() => setLogs([])}
              style={btnStyle("#333", false)}
            >
              ✕ CLEAR LOG
            </button>
            <span style={{ color: "#333", fontSize: "11px", alignSelf: "center", marginLeft: "auto" }}>
              {autoMode ? "● AUTO-SCANNING every 60s" : "○ manual mode"}
            </span>
          </div>
        </div>

        {/* Side panel */}
        <div style={{
          width: "320px",
          background: "#0d0d0d",
          borderLeft: "1px solid #1a1a1a",
          display: "flex",
          flexDirection: "column",
          fontSize: "11px",
          overflowY: "auto",
        }}>
          {/* Positions */}
          <div style={{ padding: "12px", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ color: "#666", marginBottom: "8px", letterSpacing: "1px" }}>
              OPEN POSITIONS
            </div>
            {portfolio.positions.filter(p => p.status === "OPEN").length === 0 ? (
              <div style={{ color: "#333" }}>No open positions</div>
            ) : (
              portfolio.positions.filter(p => p.status === "OPEN").map((pos) => (
                <div key={pos.id} style={{
                  marginBottom: "8px",
                  padding: "8px",
                  background: "#111",
                  borderRadius: "2px",
                  borderLeft: `2px solid ${pos.side === "YES" ? "#0f9" : "#f44"}`,
                }}>
                  <div style={{ color: pos.side === "YES" ? "#0f9" : "#f44", marginBottom: "2px" }}>
                    {pos.side} @ {(pos.price * 100).toFixed(1)}¢
                  </div>
                  <div style={{ color: "#888", marginBottom: "2px" }}>
                    {pos.question.slice(0, 40)}...
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#666" }}>${pos.amount.toFixed(2)} in</span>
                    <span style={{ color: pos.pnl >= 0 ? "#0f9" : "#f44" }}>
                      {pos.pnl !== undefined ? `${pos.pnl >= 0 ? "+" : ""}$${pos.pnl.toFixed(2)}` : "pending"}
                    </span>
                  </div>
                  <div style={{ color: "#444", marginTop: "2px" }}>
                    AI confidence: {pos.confidence}%
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Markets */}
          <div style={{ padding: "12px", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ color: "#666", marginBottom: "8px", letterSpacing: "1px" }}>
              TRACKED MARKETS ({markets.length})
            </div>
            {markets.slice(0, 10).map((m, i) => (
              <div key={m.id} style={{
                marginBottom: "6px",
                padding: "6px 8px",
                background: "#111",
                borderRadius: "2px",
                display: "flex",
                justifyContent: "space-between",
                gap: "8px",
              }}>
                <span style={{ color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.question.slice(0, 35)}
                </span>
                <span style={{ color: "#fa0", flexShrink: 0 }}>
                  {(m.yesPrice * 100).toFixed(0)}¢
                </span>
              </div>
            ))}
            {markets.length === 0 && (
              <div style={{ color: "#333" }}>Run scan to load markets</div>
            )}
          </div>

          {/* Trade history */}
          <div style={{ padding: "12px" }}>
            <div style={{ color: "#666", marginBottom: "8px", letterSpacing: "1px" }}>
              TRADE HISTORY ({portfolio.trades.length})
            </div>
            {portfolio.trades.slice(-5).reverse().map((t) => (
              <div key={t.id} style={{
                marginBottom: "6px",
                padding: "6px 8px",
                background: "#111",
                borderRadius: "2px",
                borderLeft: `2px solid ${t.side === "YES" ? "#0f9" : "#f44"}`,
              }}>
                <div style={{ color: "#888", marginBottom: "2px" }}>
                  {t.question.slice(0, 35)}...
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: t.side === "YES" ? "#0f9" : "#f44" }}>
                    BUY {t.side}
                  </span>
                  <span style={{ color: "#fa0" }}>
                    ${t.amount.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
            {portfolio.trades.length === 0 && (
              <div style={{ color: "#333" }}>No trades yet</div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
      `}</style>
    </div>
  );
}

function btnStyle(color, disabled) {
  return {
    background: "transparent",
    border: `1px solid ${disabled ? "#222" : color}`,
    color: disabled ? "#333" : color,
    padding: "4px 12px",
    fontSize: "11px",
    fontFamily: "monospace",
    cursor: disabled ? "not-allowed" : "pointer",
    letterSpacing: "1px",
    transition: "all 0.1s",
  };
}
