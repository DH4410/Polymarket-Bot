/**
 * PolyBot AI Engine  v1.0
 * A self-contained, rule-based trading intelligence system.
 * No external AI API required — runs entirely in-browser.
 *
 * How it works:
 *  1. SENTIMENT ANALYSIS  — scans news text for bullish/bearish keywords
 *  2. MOMENTUM SCORING    — uses 24h price change direction and magnitude
 *  3. LIQUIDITY SCORING   — rewards deep, tight markets
 *  4. MISPRICING DETECTOR — checks if price diverges from news sentiment
 *  5. CONFIDENCE BUILDER  — aggregates signals into a 0-100 confidence score
 *  6. RISK MANAGER        — sizes position based on confidence & edge
 */

// ─── Sentiment keyword banks ──────────────────────────────────────────────────

const STRONG_YES = [
  "confirmed", "approved", "won", "wins", "elected", "signed", "passed",
  "achieved", "reached", "announced", "official", "guaranteed", "certain",
  "likely", "expected to", "on track", "projected", "leads", "leading",
  "victory", "landslide", "overwhelming", "surge", "record high", "historic",
  "breakthrough", "agreement", "deal", "accord", "ratified", "enacted",
];

const WEAK_YES = [
  "possible", "may", "could", "might", "considering", "exploring", "potential",
  "hopeful", "optimistic", "progress", "advancing", "gaining", "rising",
  "increasing", "growing", "improving", "positive", "favorable", "supported",
  "endorsed", "backed", "ahead",
];

const STRONG_NO = [
  "denied", "rejected", "failed", "lost", "defeated", "cancelled", "blocked",
  "withdrawn", "dismissed", "overturned", "vetoed", "collapsed", "impossible",
  "ruled out", "confirmed no", "will not", "won't", "never", "dropped",
  "abandoned", "scrapped", "crisis", "disaster", "collapse", "crash",
];

const WEAK_NO = [
  "unlikely", "doubtful", "uncertain", "questionable", "concerns", "warning",
  "risks", "obstacles", "challenges", "struggling", "declining", "falling",
  "decreasing", "negative", "opposed", "criticism", "controversy", "disputed",
  "delayed", "setback", "slowing",
];

const UNCERTAINTY = [
  "unclear", "unknown", "unpredictable", "volatile", "mixed", "conflicting",
  "wait and see", "too early", "both sides", "divided", "split",
];

// ─── Sentiment scorer ─────────────────────────────────────────────────────────

export function scoreSentiment(texts) {
  const combined = texts.join(" ").toLowerCase();
  let score = 0;
  const hits = { strongYes: [], weakYes: [], strongNo: [], weakNo: [], uncertain: [] };

  STRONG_YES.forEach(kw => { if (combined.includes(kw)) { score += 3; hits.strongYes.push(kw); } });
  WEAK_YES.forEach(kw =>   { if (combined.includes(kw)) { score += 1; hits.weakYes.push(kw); } });
  STRONG_NO.forEach(kw =>  { if (combined.includes(kw)) { score -= 3; hits.strongNo.push(kw); } });
  WEAK_NO.forEach(kw =>    { if (combined.includes(kw)) { score -= 1; hits.weakNo.push(kw); } });
  UNCERTAINTY.forEach(kw => { if (combined.includes(kw)) { hits.uncertain.push(kw); } });

  // Clamp to [-15, +15] then normalize to -1…+1
  const clamped = Math.max(-15, Math.min(15, score));
  const normalized = clamped / 15;

  return {
    raw: score,
    normalized,   // -1 = very bearish, +1 = very bullish
    hits,
    label: score > 4 ? "STRONGLY BULLISH"
         : score > 1 ? "BULLISH"
         : score < -4 ? "STRONGLY BEARISH"
         : score < -1 ? "BEARISH"
         : "NEUTRAL / UNCERTAIN",
  };
}

// ─── Momentum scorer ──────────────────────────────────────────────────────────

export function scoreMomentum(market) {
  const change = market.oneDayChange || 0;  // price change as decimal, e.g. 0.05 = +5%

  let score = 0;
  let label = "";

  if (change > 0.15)       { score = 3;  label = "STRONG UPWARD"; }
  else if (change > 0.05)  { score = 2;  label = "UPWARD"; }
  else if (change > 0.01)  { score = 1;  label = "SLIGHT UPWARD"; }
  else if (change < -0.15) { score = -3; label = "STRONG DOWNWARD"; }
  else if (change < -0.05) { score = -2; label = "DOWNWARD"; }
  else if (change < -0.01) { score = -1; label = "SLIGHT DOWNWARD"; }
  else                     { score = 0;  label = "FLAT"; }

  return { score, label, change };
}

// ─── Liquidity scorer ─────────────────────────────────────────────────────────

export function scoreLiquidity(market) {
  const vol   = market.volume24h  || 0;
  const liq   = market.liquidity  || 0;
  const spread = market.bestBid && market.bestAsk
    ? market.bestAsk - market.bestBid
    : 0.1;

  let score = 0;

  // Volume
  if (vol > 100000) score += 3;
  else if (vol > 25000) score += 2;
  else if (vol > 5000)  score += 1;
  else if (vol < 500)   score -= 2;

  // Liquidity depth
  if (liq > 50000) score += 2;
  else if (liq > 10000) score += 1;

  // Spread (tight = liquid = easier to enter/exit)
  if (spread < 0.02)      score += 2;
  else if (spread < 0.05) score += 1;
  else if (spread > 0.15) score -= 2;
  else if (spread > 0.10) score -= 1;

  return { score, vol, liq, spread: spread.toFixed(3) };
}

// ─── Mispricing detector ──────────────────────────────────────────────────────
// Checks if the current price diverges meaningfully from what the news suggests

export function detectMispricing(market, sentiment) {
  const price = market.yesPrice; // 0-1
  const sentNorm = sentiment.normalized; // -1 to +1

  // Convert sentiment to implied probability estimate
  // 0 sentiment → assume market is fairly priced
  // +1 sentiment → implied prob = min(price + 0.2, 0.95)
  // -1 sentiment → implied prob = max(price - 0.2, 0.05)
  const sentImpliedProb = Math.max(0.05, Math.min(0.95, price + sentNorm * 0.20));
  const edge = sentImpliedProb - price; // positive = YES underpriced, negative = NO underpriced

  let action = "SKIP";
  let edgeLabel = "";

  if (edge > 0.08)       { action = "BUY_YES"; edgeLabel = `YES underpriced by ~${(edge * 100).toFixed(0)}%`; }
  else if (edge > 0.04)  { action = "BUY_YES"; edgeLabel = `YES slightly underpriced by ~${(edge * 100).toFixed(0)}%`; }
  else if (edge < -0.08) { action = "BUY_NO";  edgeLabel = `NO underpriced by ~${(Math.abs(edge) * 100).toFixed(0)}%`; }
  else if (edge < -0.04) { action = "BUY_NO";  edgeLabel = `NO slightly underpriced by ~${(Math.abs(edge) * 100).toFixed(0)}%`; }
  else                   { edgeLabel = "No significant edge detected"; }

  return { action, edge, edgeLabel, sentImpliedProb };
}

// ─── Confidence builder ───────────────────────────────────────────────────────

export function buildConfidence(sentiment, momentum, liquidity, mispricing) {
  let conf = 30; // base

  // Sentiment contribution (0-30 pts)
  conf += Math.abs(sentiment.normalized) * 30;

  // Sentiment/momentum agreement bonus (0-15 pts)
  const sentDir = sentiment.normalized > 0 ? 1 : sentiment.normalized < 0 ? -1 : 0;
  const momDir  = momentum.score > 0 ? 1 : momentum.score < 0 ? -1 : 0;
  if (sentDir !== 0 && sentDir === momDir) conf += 15;
  else if (sentDir !== 0 && sentDir !== momDir) conf -= 10; // conflict

  // Liquidity bonus (0-10 pts)
  conf += Math.min(10, Math.max(0, liquidity.score * 2));

  // Edge magnitude bonus (0-15 pts)
  conf += Math.min(15, Math.abs(mispricing.edge) * 75);

  // Penalize extreme prices (hard to move a 90%+ market)
  const p = mispricing.sentImpliedProb;
  if (p > 0.88 || p < 0.12) conf -= 15;
  else if (p > 0.80 || p < 0.20) conf -= 8;

  // Penalize neutral news
  if (sentiment.hits.uncertain.length > 2) conf -= 10;

  // Clamp 0-99
  return Math.max(0, Math.min(99, Math.round(conf)));
}

// ─── Position sizer ───────────────────────────────────────────────────────────

export function sizePosition(confidence, availableCash, maxTrade = 50) {
  if (confidence < 70) return 0;

  // Kelly-inspired fraction: scale from $5 at 70% → $50 at 95%+
  const fraction = (confidence - 70) / 25; // 0-1
  const raw = 5 + fraction * (maxTrade - 5);
  const rounded = Math.round(raw / 5) * 5; // round to nearest $5
  return Math.min(rounded, availableCash, maxTrade);
}

// ─── SELL decision ────────────────────────────────────────────────────────────
// Given an open position and current price, should we sell?

export function shouldSell(position, currentPrice, newsTexts = []) {
  const steps = [];
  let sellScore = 0;

  const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
  steps.push(`Entry: ${(position.entryPrice * 100).toFixed(1)}¢  Current: ${(currentPrice * 100).toFixed(1)}¢  P&L: ${(pnlPct * 100).toFixed(1)}%`);

  // Take profit: up 25%+
  if (pnlPct > 0.25) {
    sellScore += 40;
    steps.push(`TAKE PROFIT signal: +${(pnlPct * 100).toFixed(1)}% gain exceeds 25% threshold`);
  } else if (pnlPct > 0.15) {
    sellScore += 20;
    steps.push(`PARTIAL PROFIT signal: +${(pnlPct * 100).toFixed(1)}% gain exceeds 15%`);
  }

  // Stop loss: down 30%+
  if (pnlPct < -0.30) {
    sellScore += 50;
    steps.push(`STOP LOSS trigger: ${(pnlPct * 100).toFixed(1)}% loss exceeds -30% threshold`);
  } else if (pnlPct < -0.20) {
    sellScore += 25;
    steps.push(`WARNING: ${(pnlPct * 100).toFixed(1)}% drawdown approaching stop loss`);
  }

  // Price near resolution (>90% or <10%) — close to ceiling/floor
  if (currentPrice > 0.90) {
    sellScore += 30;
    steps.push(`Price at ${(currentPrice * 100).toFixed(1)}¢ — near ceiling, limited upside`);
  } else if (currentPrice < 0.10 && position.side === "YES") {
    sellScore += 35;
    steps.push(`YES price collapsed to ${(currentPrice * 100).toFixed(1)}¢ — market turning against position`);
  }

  // News sentiment check
  if (newsTexts.length > 0) {
    const sent = scoreSentiment(newsTexts);
    const isAgainstPosition =
      (position.side === "YES" && sent.normalized < -0.3) ||
      (position.side === "NO"  && sent.normalized > 0.3);
    if (isAgainstPosition) {
      sellScore += 20;
      steps.push(`News sentiment (${sent.label}) is against ${position.side} position`);
    } else {
      steps.push(`News sentiment (${sent.label}) aligns with position`);
    }
  }

  const decision = sellScore >= 50 ? "SELL" : sellScore >= 30 ? "CONSIDER_SELL" : "HOLD";
  steps.push(`Sell score: ${sellScore}/100 → Decision: ${decision}`);

  return { decision, sellScore, steps };
}

// ─── Main analyze function ────────────────────────────────────────────────────

export function analyzeMarket(market, newsArticles, availableCash) {
  const thinkingLog = [];

  thinkingLog.push(`=== AI ENGINE: Analyzing "${market.question.slice(0, 60)}" ===`);
  thinkingLog.push(`Current YES price: ${(market.yesPrice * 100).toFixed(1)}¢ (implied ${(market.yesPrice * 100).toFixed(1)}% probability)`);

  // 1. Sentiment
  const texts = newsArticles.map(a => `${a.title || ""} ${a.snippet || a.description || ""}`);
  const sentiment = scoreSentiment(texts);
  thinkingLog.push(`[SENTIMENT] ${sentiment.label} (raw score: ${sentiment.raw})`);
  if (sentiment.hits.strongYes.length)  thinkingLog.push(`  Bullish signals: ${sentiment.hits.strongYes.slice(0, 4).join(", ")}`);
  if (sentiment.hits.strongNo.length)   thinkingLog.push(`  Bearish signals: ${sentiment.hits.strongNo.slice(0, 4).join(", ")}`);
  if (sentiment.hits.uncertain.length)  thinkingLog.push(`  Uncertainty signals: ${sentiment.hits.uncertain.slice(0, 3).join(", ")}`);

  // 2. Momentum
  const momentum = scoreMomentum(market);
  thinkingLog.push(`[MOMENTUM]  ${momentum.label} (24h change: ${(momentum.change * 100).toFixed(2)}%)`);

  // 3. Liquidity
  const liquidity = scoreLiquidity(market);
  thinkingLog.push(`[LIQUIDITY] Vol24h: $${market.volume24h?.toLocaleString() || 0}  Liq: $${market.liquidity?.toLocaleString() || 0}  Spread: ${liquidity.spread}`);

  // 4. Mispricing
  const mispricing = detectMispricing(market, sentiment);
  thinkingLog.push(`[MISPRICING] Implied prob from news: ${(mispricing.sentImpliedProb * 100).toFixed(1)}%  Edge: ${mispricing.edgeLabel}`);

  // 5. Confidence
  const confidence = buildConfidence(sentiment, momentum, liquidity, mispricing);
  thinkingLog.push(`[CONFIDENCE] ${confidence}% (threshold: 70% to trade)`);

  // 6. Position size
  const action = confidence >= 70 ? mispricing.action : "SKIP";
  const amount = action !== "SKIP" ? sizePosition(confidence, availableCash) : 0;

  thinkingLog.push(`[DECISION]  ${action}  Amount: $${amount}  Confidence: ${confidence}%`);

  if (action === "SKIP" && confidence < 70) {
    thinkingLog.push(`  Reason: Confidence too low (${confidence}% < 70%)`);
  } else if (action === "SKIP") {
    thinkingLog.push(`  Reason: No significant price edge detected`);
  }

  return {
    action,
    confidence,
    amount,
    sentiment,
    momentum,
    liquidity,
    mispricing,
    thinkingLog,
    reasoning: `${sentiment.label} news + ${momentum.label} price. ${mispricing.edgeLabel}.`,
  };
}