// Recovery is deliberately bounded: first give ICE a chance to restart, then
// rebuild the mesh via a fresh signaling connection with exponential backoff.
export class PeerRecovery {
  constructor({ isCurrent, isHealthy, restartIce, reconnect, onRetry, delay, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id) }) {
    Object.assign(this, { isCurrent, isHealthy, restartIce, reconnect, onRetry, delay, setTimer, clearTimer });
    this.timer = null;
    this.recovering = false;
    this.closed = false;
  }
  watch() {
    this.cancelTimer();
    if (this.closed) return;
    this.timer = this.setTimer(() => { this.timer = null; this.failed(); }, 20000);
  }
  failed() {
    if (this.closed || this.recovering || !this.isCurrent() || this.isHealthy()) return;
    this.cancelTimer();
    this.recovering = true;
    this.onRetry();
    try { this.restartIce(); } catch { /* Reconnect below if restart is unsupported. */ }
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.closed && this.isCurrent() && !this.isHealthy()) this.reconnect();
    }, this.delay());
  }
  ready() { this.cancelTimer(); this.recovering = false; }
  cancelTimer() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  close() { this.closed = true; this.cancelTimer(); }
}
