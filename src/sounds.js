// Sound notifications for trading events

let audioContext = null;
let soundEnabled = true;
let soundVolume = 0.5;

function getAudioContext() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_e) {
      console.log("Web Audio API not available");
    }
  }
  return audioContext;
}

function playTone(frequency, duration, volume) {
  if (!soundEnabled) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.value = frequency;
    osc.type = "sine";
    gain.gain.value = (soundVolume * volume);

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + duration);

    gain.gain.setValueAtTime(soundVolume * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
  } catch (e) {
    /* ignore audio errors */
  }
}

// Individual sound functions called by App.jsx
export function playSound() {
  playTone(800, 0.2, 0.3); // Trade sound
}

export function notifyTrade() {
  playTone(800, 0.2, 0.3);
}

export function notifyProfit(pnl, enabled) {
  if (!enabled) return;
  playTone(1200, 0.3, 0.25); // Higher pitch for profit
}

export function notifyLoss(pnl, enabled) {
  if (!enabled) return;
  playTone(400, 0.3, 0.25); // Lower pitch for loss
}

export function notifyAlert() {
  playTone(600, 0.25, 0.3);
}

export function setSoundEnabled(enabled) {
  soundEnabled = enabled;
}

export function setSoundVolume(volume) {
  soundVolume = Math.max(0, Math.min(1, volume));
}

// SoundManager class for more advanced use
export class SoundManager {
  constructor(enabled = true, volume = 0.5) {
    this.enabled = enabled;
    this.volume = Math.max(0, Math.min(1, volume));
  }

  play(type = "trade") {
    if (!this.enabled) return;

    const freqs = {
      trade: 800,
      profit: 1200,
      loss: 400,
      alert: 600,
    };

    playTone(freqs[type] || 800, 0.2, 0.3);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    soundVolume = this.volume;
  }

  setEnabled(e) {
    this.enabled = e;
    soundEnabled = e;
  }
}
