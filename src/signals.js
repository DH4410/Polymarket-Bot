// Advanced trading signals
export function calcVolumeAnomaly(market) {
  // Volume surge relative to typical liquidity
  if (!market.volume24h || !market.liquidity) return { signal: "NEUTRAL", strength: 0 };

  const ratio = market.volume24h / Math.max(market.liquidity, 1);
  if (ratio > 4) return { signal: "EXTREME_VOLUME", strength: 0.15 };
  if (ratio > 2.5) return { signal: "HIGH_VOLUME", strength: 0.08 };
  if (ratio < 0.5) return { signal: "LOW_VOLUME", strength: -0.05 };
  return { signal: "NEUTRAL", strength: 0 };
}

export function calcPriceVelocity(market) {
  // How fast price is moving
  const mom24h = Math.abs(market.oneDayChange || 0);
  const velocity = mom24h > 0.15 ? "FAST" : mom24h > 0.06 ? "MEDIUM" : "SLOW";
  return { velocity, score: Math.min(mom24h * 100, 30) };
}

export function calcSpreadQuality(market) {
  // Spread efficiency score
  if (!market.bestBid || !market.bestAsk) return 50;
  const spread = market.bestAsk - market.bestBid;
  if (spread < 0.005) return 95;
  if (spread < 0.02) return 80;
  if (spread < 0.05) return 60;
  if (spread < 0.10) return 40;
  return 20;
}

export function calcResolutionUrgency(endDate) {
  // How important imminent resolution is
  const daysLeft = (new Date(endDate) - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0.1) return { urgency: "CRITICAL", multiplier: 0.5 };
  if (daysLeft < 0.5) return { urgency: "HIGH", multiplier: 0.7 };
  if (daysLeft < 3) return { urgency: "MEDIUM", multiplier: 0.85 };
  if (daysLeft > 60) return { urgency: "LOW", multiplier: 1.1 };
  return { urgency: "NORMAL", multiplier: 1.0 };
}

export function calcMarketMaturity(market) {
  // How established/liquid is this market
  const volScore = market.volume24h > 500000 ? 30 : market.volume24h > 50000 ? 20 : 5;
  const liqScore = market.liquidity > 100000 ? 30 : market.liquidity > 10000 ? 20 : 5;
  const ageScore = market.createdAt ? Math.min((Date.now() - new Date(market.createdAt).getTime()) / (1000 * 60 * 60 * 24), 30) : 10;
  return Math.round((volScore + liqScore + ageScore) / 3);
}

export function calcRiskScore(market) {
  // Position-specific risk assessment
  let risk = 50;

  // Spread risk
  if (market.bestBid && market.bestAsk) {
    const spread = market.bestAsk - market.bestBid;
    if (spread > 0.15) risk += 25;
    else if (spread > 0.08) risk += 15;
    else if (spread > 0.04) risk += 5;
  }

  // Time risk
  const daysLeft = (new Date(market.endDate) - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0.5) risk += 20;
  else if (daysLeft < 3) risk += 10;

  // Liquidity risk
  if (market.liquidity < 5000) risk += 15;
  else if (market.liquidity < 20000) risk += 8;

  return Math.min(risk, 100);
}

// ML-like adaptive learning system
export class MLLearningEngine {
  constructor(learningRate = 0.1) {
    this.learningRate = learningRate;
    this.modelWeights = {
      statEdge: 0.35,
      momentum: 0.30,
      volumeSurge: 0.15,
      timeValue: 0.15,
      priceAction: 0.05,
    };
    this.performanceHistory = [];
    this.typePerformance = {};
  }

  recordOutcome(trade) {
    this.performanceHistory.push({
      weights: { ...this.modelWeights },
      outcome: trade.pnl,
      mType: trade.mktType,
      edgeFrom: trade.edgeFrom,
      ts: Date.now(),
    });

    if (!this.typePerformance[trade.mktType]) {
      this.typePerformance[trade.mktType] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
    }
    const tp = this.typePerformance[trade.mktType];
    if (trade.pnl > 0) tp.wins++;
    else tp.losses++;
    tp.trades++;
    tp.pnl += trade.pnl;

    // Learn from outcome - update weights like gradient descent
    const reward = trade.pnl > 0 ? 1 : -1;
    const gradient = reward * this.learningRate;

    if (trade.edgeFrom === "statistical") this.modelWeights.statEdge += gradient * 0.08;
    if (trade.momentum > 0.03) this.modelWeights.momentum += gradient * 0.06;
    if (trade.volumeSurge) this.modelWeights.volumeSurge += gradient * 0.04;

    // Normalize weights to sum to 1
    const sum = Object.values(this.modelWeights).reduce((a, b) => a + b, 0);
    if (sum !== 0) {
      Object.keys(this.modelWeights).forEach(k => {
        this.modelWeights[k] = this.modelWeights[k] / sum;
      });
    }
  }

  getConfidenceBoost(mType) {
    // Return confidence multiplier based on market type history
    if (!this.typePerformance[mType] || this.typePerformance[mType].trades < 3) return 1.0;

    const tp = this.typePerformance[mType];
    const winRate = tp.wins / tp.trades;

    // If winning >55%, boost confidence; if losing <45%, reduce it
    return 1.0 + (winRate - 0.5) * 0.3; // -0.15 to +0.15 range
  }

  getPositionSizeMultiplier(mType) {
    // Dynamic position sizing based on profitability
    if (!this.typePerformance[mType]) return 1.0;

    const tp = this.typePerformance[mType];
    const total = tp.wins + tp.losses;
    if (total < 2) return 1.0;

    const winRate = tp.wins / total;
    const profitRatio = tp.pnl > 0 ? 1 : 0.8; // Reduce size on losses

    // Result: 0.6x to 1.4x
    return Math.max(0.6, Math.min(1.4, 1.0 + (winRate - 0.5) * 0.4 + (profitRatio - 1) * 0.4));
  }

  serialize() {
    return JSON.stringify({
      weights: this.modelWeights,
      typePerf: this.typePerformance,
    });
  }

  deserialize(json) {
    try {
      const data = JSON.parse(json);
      this.modelWeights = data.weights;
      this.typePerformance = data.typePerf;
    } catch (_e) {
      /* ignore */
    }
  }
}

