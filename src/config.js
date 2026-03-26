// Configuration from environment variables or defaults
export const config = {
  START_CASH: +(import.meta.env.VITE_START_CASH || 1000),
  CONF_THRESH: +(import.meta.env.VITE_CONF_THRESHOLD || 55),
  MAX_TRADE: +(import.meta.env.VITE_MAX_TRADE || 40),
  PRICE_MIN: +(import.meta.env.VITE_PRICE_MIN || 0.08),
  PRICE_MAX: +(import.meta.env.VITE_PRICE_MAX || 0.92),
  MAX_OPEN: +(import.meta.env.VITE_MAX_OPEN || 8),
  PRICE_MS: +(import.meta.env.VITE_PRICE_REFRESH_MS || 10000),
  SCAN_MS: +(import.meta.env.VITE_SCAN_INTERVAL_MS || 180000),
  VERSION: "13.0-ML",
};

export const defaultSettings = {
  soundEnabled: true,
  soundVolume: 0.5,
  autoRefresh: true,
  darkMode: true,
  compactMode: false,
  showAdvancedMetrics: true,
  maxPositions: config.MAX_OPEN,
  confidenceThreshold: config.CONF_THRESH,
  maxTradeSize: config.MAX_TRADE,
  mlLearningRate: 0.1,
  riskPerTrade: 0.02, // 2% risk per trade
  profitTargetMultiplier: 2.5, // Risk/Reward = 1:2.5
};

