// LocalStorage persistence utilities

const STORAGE_KEYS = {
  PORTFOLIO: "polybot_portfolio",
  SETTINGS: "polybot_settings",
  ML_MODEL: "polybot_ml_model",
  BLACKLIST: "polybot_blacklist",
  TRADE_HISTORY: "polybot_trade_history",
};

// Main save function (called from App.jsx)
export function saveState(portfolio, blacklist, settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.PORTFOLIO, JSON.stringify(portfolio));
    localStorage.setItem(STORAGE_KEYS.BLACKLIST, JSON.stringify(Array.from(blacklist)));
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}

// Main load function (called from App.jsx)
export function loadState() {
  try {
    const portfolio = localStorage.getItem(STORAGE_KEYS.PORTFOLIO);
    const blacklist = localStorage.getItem(STORAGE_KEYS.BLACKLIST);
    const settings = localStorage.getItem(STORAGE_KEYS.SETTINGS);

    return {
      portfolio: portfolio ? JSON.parse(portfolio) : null,
      blacklist: blacklist ? new Set(JSON.parse(blacklist)) : new Set(),
      settings: settings ? JSON.parse(settings) : null,
    };
  } catch (e) {
    console.error("Failed to load state", e);
    return null;
  }
}

// Clear all saved state
export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEYS.PORTFOLIO);
    localStorage.removeItem(STORAGE_KEYS.SETTINGS);
    localStorage.removeItem(STORAGE_KEYS.ML_MODEL);
    localStorage.removeItem(STORAGE_KEYS.BLACKLIST);
    localStorage.removeItem(STORAGE_KEYS.TRADE_HISTORY);
  } catch (e) {
    console.error("Failed to clear state", e);
  }
}

// CSV export function
export function downloadCSV(trades) {
  if (!trades || !trades.length) {
    alert("No trades to export");
    return;
  }

  const headers = ["Time", "Type", "Market", "Side", "Entry", "Exit", "Cost", "Proceeds", "P&L", "P&L%", "Status"];
  const rows = trades.map(t => [
    t.openedAt || "---",
    t.mktType || "?",
    `"${t.question.slice(0, 50)}"`,
    t.side,
    (t.ep * 100).toFixed(1) + "%",
    t.closePrice ? (t.closePrice * 100).toFixed(1) + "%" : "---",
    "$" + t.amount.toFixed(2),
    t.closePrice ? "$" + ((t.closePrice || t.ep) * t.shares).toFixed(2) : "---",
    t.pnl ? "$" + t.pnl.toFixed(2) : "---",
    t.pnlPct ? ((t.pnlPct * 100).toFixed(2) + "%") : "---",
    t.status || (t.pnl ? (t.pnl > 0 ? "WIN" : "LOSS") : "OPEN"),
  ]);

  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `polybot-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// Helper functions
export function savePortfolio(portfolio) {
  try {
    localStorage.setItem(STORAGE_KEYS.PORTFOLIO, JSON.stringify(portfolio));
  } catch (e) {
    console.error("Failed to save portfolio", e);
  }
}

export function loadPortfolio() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.PORTFOLIO);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error("Failed to load portfolio", e);
    return null;
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings", e);
  }
}

export function loadSettings() {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error("Failed to load settings", e);
    return null;
  }
}

export function saveMLModel(mlJson) {
  try {
    localStorage.setItem(STORAGE_KEYS.ML_MODEL, mlJson);
  } catch (e) {
    console.error("Failed to save ML model", e);
  }
}

export function loadMLModel() {
  try {
    return localStorage.getItem(STORAGE_KEYS.ML_MODEL);
  } catch (e) {
    console.error("Failed to load ML model", e);
    return null;
  }
}

