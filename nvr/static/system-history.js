"use strict";

((global) => {
  const WINDOWS = [1, 6, 24, 168], REFRESH_MS = 30000, TIMEOUT_MS = 8000, MAX_POINTS = 22000;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const timestamp = (value) => finite(value) && value >= 0 && value <= 8.64e12;
  const percent = (value) => finite(value) && value >= 0 && value <= 100 ? value : null;
  const translate = (key, params) => global.NvrI18n?.t(key, params) || key;

  function checkedHistory(value, hours) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.available !== "boolean"
        || value.window_seconds !== hours * 3600 || value.interval_seconds !== 30 || !timestamp(value.sampled_at)
        || !Array.isArray(value.points) || value.points.length > MAX_POINTS) throw new Error("Saved history unavailable. Try again.");
    const points = [];
    for (const point of value.points) {
      if (!point || typeof point !== "object" || !timestamp(point.sampled_at)) continue;
      if (point.sampled_at < value.sampled_at - value.window_seconds || point.sampled_at > value.sampled_at) continue;
      points.push({sampled_at: point.sampled_at, cpu_percent: percent(point.cpu_percent), memory_percent: percent(point.memory_percent),
        swap_percent: percent(point.swap_percent), temperature_celsius: finite(point.temperature_celsius) && point.temperature_celsius >= -50 && point.temperature_celsius <= 150 ? point.temperature_celsius : null});
    }
    return {available: value.available, sampled_at: value.sampled_at, window_seconds: value.window_seconds,
      interval_seconds: 30, points: value.available ? points : [],
      ...(typeof value.sampling_available === "boolean" ? {sampling_available: value.sampling_available} : {}),
      ...(typeof value.stale === "boolean" ? {stale: value.stale} : {})};
  }

  class NvrSystemHistory {
    constructor({dashboard, api, t = translate, isActive = () => false, now = () => global.performance?.now() ?? Date.now()} = {}) {
      if (!dashboard?.historyControls || typeof dashboard.setHistory !== "function" || typeof api !== "function") throw new Error("System history controls unavailable.");
      this.dashboard = dashboard; this.controls = dashboard.historyControls; this.api = api; this.t = t; this.isActive = isActive; this.now = now;
      this.hours = 6; this.data = null; this.loading = false; this.error = false; this.needsLoad = true;
      this.lastAttempt = -Infinity; this.epoch = 0; this.controller = null; this.timeout = null;
      this.dashboard.setHistoryWindow(this.hours);
      this.controls.select.addEventListener("change", () => this.setWindow(Number(this.controls.select.value)));
      this.controls.refresh.addEventListener("click", () => this.load(true));
      this.renderStatus();
    }
    active() { try { return this.isActive() === true; } catch (_) { return false; } }
    current(epoch, controller) { return epoch === this.epoch && controller === this.controller && !controller.signal.aborted && this.active(); }
    abort() {
      this.epoch += 1; this.controller?.abort(); this.controller = null;
      if (this.timeout !== null) global.clearTimeout(this.timeout);
      this.timeout = null;
    }
    renderStatus() {
      const controls = this.controls;
      controls.root.setAttribute("aria-busy", String(this.loading));
      controls.select.value = String(this.hours);
      controls.select.disabled = !this.active();
      controls.refresh.disabled = !this.active() || this.loading;
      controls.status.textContent = this.t(this.loading ? "Loading saved history…" : this.error || this.data?.available === false
        ? "Saved history unavailable. Try again." : this.data?.sampling_available === false
        ? this.data.points.length ? "History collection is temporarily unavailable. Saved samples are still shown." : "Saved history unavailable. Try again."
        : this.data?.stale === true && this.data.points.length ? "No recent saved sample. Check the recorder."
        : this.data && !this.data.points.length ? "No saved samples in this period."
        : this.data ? "Saved samples are collected every 30 seconds." : "Waiting for saved history.");
    }
    setWindow(hours) {
      if (!WINDOWS.includes(hours)) { this.controls.select.value = String(this.hours); return false; }
      if (hours === this.hours) return true;
      this.abort(); this.loading = false; this.hours = hours; this.data = null; this.error = false; this.needsLoad = true; this.lastAttempt = -Infinity;
      this.dashboard.setHistoryWindow(hours); this.dashboard.setHistory(null); this.renderStatus();
      if (this.active()) this.load(true);
      return true;
    }
    open() {
      if (!this.active()) { this.close(); return Promise.resolve(false); }
      this.dashboard.setHistoryWindow(this.hours);
      if (this.data && this.dashboard.savedHistory !== this.data) this.dashboard.setHistory(this.data);
      this.renderStatus();
      return this.load(false);
    }
    close() {
      if (this.loading) this.needsLoad = true;
      this.abort(); this.loading = false; this.renderStatus();
    }
    clear() {
      this.close(); this.hours = 6; this.data = null; this.error = false; this.needsLoad = true; this.lastAttempt = -Infinity;
      this.dashboard.setHistoryWindow(this.hours); this.dashboard.setHistory(null); this.renderStatus();
    }
    relabel() {
      const pending = this.loading;
      this.abort(); this.loading = false; if (pending) this.needsLoad = true;
      this.dashboard.relabel(); this.renderStatus();
      if (pending && this.active()) return this.load(true);
      return Promise.resolve(false);
    }
    onTelemetrySnapshot() { return this.active() ? this.open() : (this.close(), Promise.resolve(false)); }
    async load(force = false) {
      if (!this.active() || this.loading) return false;
      const now = this.now(), age = now - this.lastAttempt;
      if (!force && !this.needsLoad && age >= 0 && age < REFRESH_MS) return false;
      this.abort();
      const epoch = this.epoch, controller = new AbortController(), hours = this.hours;
      this.controller = controller; this.loading = true; this.error = false; this.needsLoad = false; this.lastAttempt = now; this.renderStatus();
      const timeout = global.setTimeout(() => {
        if (!this.current(epoch, controller)) return;
        this.abort(); this.loading = false; this.error = true; this.data = null;
        this.dashboard.setHistory(null); this.renderStatus();
      }, TIMEOUT_MS);
      this.timeout = timeout;
      try {
        const data = checkedHistory(await this.api("/api/system/history?hours=" + hours, {signal: controller.signal}), hours);
        if (!this.current(epoch, controller)) return false;
        this.data = data; this.error = !data.available; this.dashboard.setHistory(data); return data.available;
      } catch (_) {
        if (this.current(epoch, controller)) { this.data = null; this.error = true; this.dashboard.setHistory(null); }
        return false;
      } finally {
        global.clearTimeout(timeout);
        if (this.timeout === timeout) this.timeout = null;
        if (epoch === this.epoch && this.controller === controller) { this.controller = null; this.loading = false; this.renderStatus(); }
      }
    }
  }
  global.NvrSystemHistory = NvrSystemHistory;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrSystemHistory, checkedHistory};
})(typeof window !== "undefined" ? window : globalThis);
