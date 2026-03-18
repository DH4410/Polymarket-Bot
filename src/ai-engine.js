/**
 * PolyBot AI Engine v4.0
 *
 * Key improvements over v3:
 *  - isDeadMarket() — detects resolved/near-dead markets to blacklist
 *  - isGoodCandidate() — pre-filter before expensive news fetch
 *  - Confidence starts at 50 for mid-range liquid markets
 *  - Much richer domain keyword banks
 *  - Threshold: 55% for paper trading
 */

// ─── Dead market detection ────────────────────────────────────────────────────
// Returns true if this market should be permanently blacklisted

export function isDeadMarket(market) {
  const p = market.yesPrice;

  // Price is basically resolved (too close to 0 or 1 to be interesting)
  // AND there's been almost no price movement in 24h
  const isExtreme    = p < 0.02 || p > 0.98;
  const noMovement   = Math.abs(market.oneDayChange || 0) < 0.002;
  const noVolume     = (market.volume24h || 0) < 200;

  if (isExtreme && noMovement && noVolume) return true;

  // Spread is 0.1 exactly — this is the default when there's NO order book
  // (Polymarket returns 0.1 spread for dead/empty books)
  const deadSpread   = market.bestBid === null && market.bestAsk === null;
  if (isExtreme && deadSpread) return true;

  return false;
}

// Pre-filter: is this worth fetching news for?
export function isGoodCandidate(market) {
  const p   = market.yesPrice;
  const vol = market.volume24h || 0;

  // We want markets with real activity
  if (vol < 500) return false;

  // We want markets that aren't already fully resolved
  // (0.1¢ with zero movement = resolved, don't waste API calls)
  if ((p < 0.02 || p > 0.98) && Math.abs(market.oneDayChange || 0) < 0.003) return false;

  // Sweet spot: mid-range (genuine uncertainty) OR recently moved a lot
  const midRange   = p >= 0.10 && p <= 0.90;
  const bigMover   = Math.abs(market.oneDayChange || 0) > 0.03;
  const highVolume = vol > 5000;

  return midRange || bigMover || highVolume;
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

const STRONG_YES = [
  // Outcomes
  "confirmed","approved","won","wins","elected","signed","passed","achieved",
  "reached","announced","official","certain","on track","projected","leads",
  "leading","victory","landslide","overwhelming","surge","record high","historic",
  "breakthrough","agreement","deal","accord","ratified","enacted","secured",
  "clinched","dominates","ahead","frontrunner","guaranteed",
  // Sports
  "scored","goal","winner","champion","promoted","qualified","unbeaten",
  "clean sheet","comeback","dominated","thrashed","knocked out opponent",
  // Finance / Fed
  "rate cut","cut rates","rate cuts","cutting rates","pivot","easing","dovish",
  "stimulus","pause rate","hold rates","no change","unchanged rates","fed holds",
  "federal reserve holds","50bps cut","25bps cut","basis point cut",
  // Crypto
  "all time high","ath","approved etf","institutional buying","adoption",
  "halving","bullish","breakout","rally",
  // Politics / Elections
  "elected","inaugurated","majority","coalition","referendum passed",
  "polling lead","approval rating up","frontrunner","leads polls",
];

const WEAK_YES = [
  "possible","may","could","might","considering","exploring","potential",
  "hopeful","optimistic","progress","advancing","gaining","rising","increasing",
  "growing","improving","positive","favorable","supported","endorsed","backed",
  "likely","expected","anticipated","forecast","analysts expect","predicted",
  "polling","favorite","odds favor","market implies","probability",
  "on course","path to","set to","poised to",
];

const STRONG_NO = [
  "denied","rejected","failed","lost","defeated","cancelled","blocked",
  "withdrawn","dismissed","overturned","vetoed","collapsed","impossible",
  "ruled out","will not","won't","never","dropped","abandoned","scrapped",
  "crisis","disaster","collapse","crash","suspended","halted","banned",
  // Sports
  "relegated","eliminated","lost match","injury ruled out","suspended player",
  "fired manager","sacked","boycott",
  // Finance
  "rate hike","hike rates","hiking rates","hawkish","tightening","recession",
  "contraction","stagflation","inflation surge","50bps hike","basis point hike",
  "emergency hike","rate increase",
  // Politics
  "impeached","resigned","dropped out","withdrew","disqualified","arrested",
  "indicted","scandal","suspended campaign",
];

const WEAK_NO = [
  "unlikely","doubtful","uncertain","questionable","concerns","warning",
  "risks","obstacles","challenges","struggling","declining","falling",
  "decreasing","negative","opposed","criticism","controversy","disputed",
  "delayed","setback","slowing","weakening","behind","trailing","underdog",
  "disappointing","missed","below expectations","downgraded",
];

const UNCERTAINTY_WORDS = [
  "unclear","unknown","unpredictable","volatile","mixed","conflicting",
  "wait and see","too early","both sides","divided","split","debate",
  "contested","disputed outcome","recount","appeal","legal challenge",
];

export function scoreSentiment(texts) {
  if (!texts || texts.length === 0) {
    return {
      raw: 0, normalized: 0,
      hits: { strongYes:[], weakYes:[], strongNo:[], weakNo:[], uncertain:[] },
      label: "NO NEWS", noNews: true,
    };
  }

  const combined = texts.join(" ").toLowerCase();
  let score = 0;
  const hits = { strongYes:[], weakYes:[], strongNo:[], weakNo:[], uncertain:[] };

  STRONG_YES.forEach(kw => { if (combined.includes(kw)) { score += 3; hits.strongYes.push(kw); } });
  WEAK_YES.forEach(kw   => { if (combined.includes(kw)) { score += 1; hits.weakYes.push(kw);   } });
  STRONG_NO.forEach(kw  => { if (combined.includes(kw)) { score -= 3; hits.strongNo.push(kw);  } });
  WEAK_NO.forEach(kw    => { if (combined.includes(kw)) { score -= 1; hits.weakNo.push(kw);    } });
  UNCERTAINTY_WORDS.forEach(kw => { if (combined.includes(kw)) hits.uncertain.push(kw); });

  const clamped    = Math.max(-20, Math.min(20, score));
  const normalized = clamped / 20;

  return {
    raw: score, normalized, hits, noNews: false,
    label: score >  5 ? "STRONGLY BULLISH"
         : score >  2 ? "BULLISH"
         : score < -5 ? "STRONGLY BEARISH"
         : score < -2 ? "BEARISH"
         : "NEUTRAL",
  };
}

export function scoreMomentum(market) {
  const change = market.oneDayChange || 0;
  const score  = change > 0.15 ? 3 : change > 0.05 ? 2 : change > 0.01 ? 1
               : change < -0.15 ? -3 : change < -0.05 ? -2 : change < -0.01 ? -1 : 0;
  const label  = score >= 3 ? "STRONG UP" : score >= 1 ? "UP"
               : score === 0 ? "FLAT" : score <= -3 ? "STRONG DOWN" : "DOWN";
  return { score, label, change };
}

export function scoreLiquidity(market) {
  const vol    = market.volume24h || 0;
  const liq    = market.liquidity || 0;
  const spread = (market.bestBid != null && market.bestAsk != null)
    ? market.bestAsk - market.bestBid : 0.10;

  let score = 0;
  if (vol > 1000000) score += 4;
  else if (vol > 100000) score += 3;
  else if (vol > 25000)  score += 2;
  else if (vol > 5000)   score += 1;
  else if (vol < 1000)   score -= 1;

  if (liq > 1000000) score += 3;
  else if (liq > 100000) score += 2;
  else if (liq > 20000)  score += 1;

  if (spread < 0.01)      score += 3;
  else if (spread < 0.03) score += 2;
  else if (spread < 0.08) score += 1;
  else if (spread > 0.20) score -= 2;

  return { score, vol, liq, spread: spread.toFixed(4) };
}

export function detectMispricing(market, sentiment) {
  const price = market.yesPrice;
  const sent  = sentiment.normalized;

  let action = "SKIP", edge = 0, edgeLabel = "No clear mispricing", sentImplied = price;

  if (price >= 0.10 && price <= 0.90) {
    // Mid-range market — standard divergence
    sentImplied = Math.max(0.05, Math.min(0.95, price + sent * 0.30));
    edge = sentImplied - price;

    if      (edge >  0.08) { action = "BUY_YES"; edgeLabel = `Strong YES edge: market ${pct(price)} vs implied ${pct(sentImplied)}`; }
    else if (edge >  0.04) { action = "BUY_YES"; edgeLabel = `Mild YES edge ~${(edge*100).toFixed(0)}%`; }
    else if (edge < -0.08) { action = "BUY_NO";  edgeLabel = `Strong NO edge: market ${pct(price)} vs implied ${pct(sentImplied)}`; }
    else if (edge < -0.04) { action = "BUY_NO";  edgeLabel = `Mild NO edge ~${(Math.abs(edge)*100).toFixed(0)}%`; }
    else                   { edgeLabel = `Price appears fair (${pct(price)} ≈ implied ${pct(sentImplied)})`; }

  } else if (price < 0.10) {
    // Near-zero: market says almost impossible
    // Bullish/neutral news → YES underpriced; strong bearish → confirms near-zero
    sentImplied = Math.max(0.03, Math.min(0.45, 0.05 + (sent + 0.5) * 0.25));
    edge = sentImplied - price;
    if (edge > 0.06) {
      action = "BUY_YES";
      edgeLabel = `Market at ${pct(price)} but news implies ~${pct(sentImplied)} → YES may be undervalued`;
    } else {
      edgeLabel = `Market at ${pct(price)} — news confirms near-impossible, no edge`;
    }

  } else {
    // Near-one: market says near-certain
    // Bearish/uncertain news → NO has value; strong bullish → confirms
    sentImplied = Math.min(0.97, Math.max(0.55, 0.95 + (sent - 0.2) * 0.25));
    edge = sentImplied - price;
    if (edge < -0.04) {
      action = "BUY_NO";
      edgeLabel = `Market at ${pct(price)} (near-certain) but uncertainty remains → NO underpriced`;
    } else if (sent > 0.3) {
      action = "BUY_YES";
      edgeLabel = `Strong bullish news confirms near-certain outcome`;
      edge = 0.05;
    } else {
      edgeLabel = `Market at ${pct(price)} — insufficient edge`;
    }
  }

  return { action, edge, edgeLabel, sentImplied };
}

function pct(p) { return `${(+p*100).toFixed(1)}%`; }

export function buildConfidence(sentiment, momentum, liquidity, mispricing, market) {
  const p = market.yesPrice;

  // Mid-range markets get a higher base (more genuine uncertainty)
  const isMid  = p >= 0.15 && p <= 0.85;
  let conf = isMid ? 50 : 35;

  // Liquidity bonus (0-20)
  conf += Math.min(20, Math.max(0, liquidity.score * 2));

  // Sentiment contribution (0-25)
  conf += Math.round(Math.abs(sentiment.normalized) * 25);

  // Momentum agreement bonus (+12) or conflict penalty (-8)
  const sentDir = sentiment.normalized >  0.1 ? 1 : sentiment.normalized < -0.1 ? -1 : 0;
  const momDir  = momentum.score > 0 ? 1 : momentum.score < 0 ? -1 : 0;
  if (sentDir !== 0 && sentDir === momDir)  conf += 12;
  else if (sentDir !== 0 && momDir !== 0 && sentDir !== momDir) conf -= 8;

  // Edge magnitude bonus (0-20)
  conf += Math.min(20, Math.round(Math.abs(mispricing.edge) * 80));

  // No-news penalty
  if (sentiment.noNews) conf -= 8;

  // Uncertainty penalty
  const unc = sentiment.hits?.uncertain?.length || 0;
  if (unc > 3) conf -= 10;
  else if (unc > 1) conf -= 4;

  // Big mover bonus (price moving a lot = interesting)
  if (Math.abs(momentum.change) > 0.10) conf += 8;

  return Math.max(0, Math.min(99, Math.round(conf)));
}

export function sizePosition(confidence, availableCash, maxTrade = 50) {
  if (confidence < 55) return 0;
  const fraction = Math.min(1, (confidence - 55) / 35);
  const raw      = 5 + fraction * (maxTrade - 5);
  const rounded  = Math.round(raw / 5) * 5;
  return Math.min(rounded, availableCash, maxTrade);
}

export function shouldSell(position, currentPrice, newsTexts = []) {
  const steps   = [];
  let sellScore = 0;
  const pnlPct  = (currentPrice - position.ep) / position.ep;

  steps.push(`Entry: ${(position.ep*100).toFixed(1)}¢  Now: ${(currentPrice*100).toFixed(1)}¢  P&L: ${(pnlPct*100).toFixed(1)}%`);

  if (pnlPct > 0.40)       { sellScore += 60; steps.push("TAKE PROFIT: +40% gain — locking in"); }
  else if (pnlPct > 0.25)  { sellScore += 35; steps.push(`Good profit +${(pnlPct*100).toFixed(1)}% — approaching target`); }
  else if (pnlPct > 0.15)  { sellScore += 12; steps.push(`Profit +${(pnlPct*100).toFixed(1)}% — holding`); }

  if (pnlPct < -0.40)      { sellScore += 65; steps.push("STOP LOSS: -40% — cutting loss"); }
  else if (pnlPct < -0.25) { sellScore += 35; steps.push(`WARNING: ${(pnlPct*100).toFixed(1)}% — nearing stop loss`); }
  else if (pnlPct < -0.15) { sellScore += 10; steps.push(`Drawdown ${(pnlPct*100).toFixed(1)}% — monitoring`); }

  if (currentPrice > 0.93 && position.side === "YES") { sellScore += 25; steps.push(`YES at ${(currentPrice*100).toFixed(1)}¢ — near ceiling`); }
  if (currentPrice < 0.06 && position.side === "YES") { sellScore += 40; steps.push(`YES collapsed to ${(currentPrice*100).toFixed(1)}¢`); }
  if (currentPrice > 0.93 && position.side === "NO")  { sellScore += 40; steps.push(`NO at ${(currentPrice*100).toFixed(1)}¢ — market against us`); }

  if (newsTexts.length > 0) {
    const sent   = scoreSentiment(newsTexts);
    const against = (position.side === "YES" && sent.normalized < -0.3)
                 || (position.side === "NO"  && sent.normalized >  0.3);
    if (against) { sellScore += 20; steps.push(`News (${sent.label}) working AGAINST ${position.side}`); }
    else if (!sent.noNews) steps.push(`News (${sent.label}) still supports ${position.side}`);
  } else {
    steps.push("No fresh news — price action only");
  }

  const decision = sellScore >= 50 ? "SELL" : sellScore >= 25 ? "CONSIDER" : "HOLD";
  steps.push(`──────────────────────────────`);
  steps.push(`Sell score: ${sellScore}/100  →  ${decision}`);
  return { decision, sellScore, steps };
}

export function analyzeMarket(market, newsArticles, availableCash) {
  const log   = [];
  const texts = newsArticles.map(a => `${a.title||""} ${a.snippet||a.description||""}`);

  log.push(`Market: "${market.question.slice(0,68)}"`);
  log.push(`YES: ${(market.yesPrice*100).toFixed(1)}¢  Vol24h: $${(market.volume24h||0).toLocaleString()}  News: ${newsArticles.length} articles`);
  log.push(`────────────────────────────────────────`);

  const sentiment  = scoreSentiment(texts);
  log.push(`[SENTIMENT]   ${sentiment.label}  (raw:${sentiment.raw} norm:${sentiment.normalized.toFixed(2)})`);
  if (sentiment.hits.strongYes.length) log.push(`  ↑ Strong+: ${sentiment.hits.strongYes.slice(0,5).join(", ")}`);
  if (sentiment.hits.weakYes.length)   log.push(`  ↑ Weak+:   ${sentiment.hits.weakYes.slice(0,4).join(", ")}`);
  if (sentiment.hits.strongNo.length)  log.push(`  ↓ Strong−: ${sentiment.hits.strongNo.slice(0,5).join(", ")}`);
  if (sentiment.hits.weakNo.length)    log.push(`  ↓ Weak−:   ${sentiment.hits.weakNo.slice(0,4).join(", ")}`);
  if (sentiment.hits.uncertain.length) log.push(`  ? Unclear: ${sentiment.hits.uncertain.slice(0,3).join(", ")}`);
  if (sentiment.noNews)                log.push(`  ! No news found for this market`);

  const momentum = scoreMomentum(market);
  log.push(`[MOMENTUM]    ${momentum.label}  (24h:${(momentum.change*100).toFixed(2)}%  score:${momentum.score})`);

  const liquidity = scoreLiquidity(market);
  log.push(`[LIQUIDITY]   Score:${liquidity.score}  Spread:${liquidity.spread}  Vol:$${(liquidity.vol||0).toLocaleString()}`);

  const mispricing = detectMispricing(market, sentiment);
  log.push(`[MISPRICING]  Action:${mispricing.action}  Edge:${(mispricing.edge*100).toFixed(1)}%`);
  log.push(`  ${mispricing.edgeLabel}`);

  const confidence = buildConfidence(sentiment, momentum, liquidity, mispricing, market);
  const isMid      = market.yesPrice >= 0.15 && market.yesPrice <= 0.85;
  const liqB       = Math.min(20, Math.max(0, liquidity.score * 2));
  const sentB      = Math.round(Math.abs(sentiment.normalized) * 25);
  const edgeB      = Math.min(20, Math.round(Math.abs(mispricing.edge) * 80));
  log.push(`[CONFIDENCE]  ${confidence}%  (base:${isMid?50:35}  liq:+${liqB}  sent:+${sentB}  edge:+${edgeB})`);

  const action = confidence >= 55 ? mispricing.action : "SKIP";
  const amount = action !== "SKIP" ? sizePosition(confidence, availableCash) : 0;

  log.push(`────────────────────────────────────────`);
  if (action !== "SKIP") {
    log.push(`[DECISION]    ✓ ${action}  $${amount}  Conf:${confidence}%`);
  } else {
    log.push(`[DECISION]    SKIP  Conf:${confidence}%`);
    log.push(confidence < 55
      ? `  Reason: ${confidence}% < 55% threshold`
      : `  Reason: No actionable price edge`);
  }

  return {
    action, confidence, amount,
    sentiment, momentum, liquidity, mispricing,
    thinkingLog: log,
    reasoning: `${sentiment.label} | ${momentum.label} | ${mispricing.edgeLabel.slice(0,55)}`,
  };
}