"use strict";

((global) => {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const bytes = (value) => finite(value) && value >= 0;
  function percent(metric) {
    if (!metric || !bytes(metric.total) || metric.total <= 0 || !bytes(metric.used)) return null;
    if (finite(metric.percent) && metric.percent >= 0 && metric.percent <= 100) return metric.percent;
    if (bytes(metric.used) && bytes(metric.total) && metric.total > 0 && metric.used <= metric.total) return metric.used / metric.total * 100;
    return null;
  }
  class NvrSystemTelemetry {
    constructor({root, t, locale} = {}) {
      if (!root) throw new Error("System telemetry unavailable.");
      this.root = root; this.snapshot = null;
      this.t = t || ((key, params) => global.NvrI18n?.t(key, params) || key);
      this.locale = locale || (() => global.NvrI18n?.locale() || "en");
      this.nodes = {};
      for (const id of ["telemetry-cpu-usage", "telemetry-cpu-temperature", "telemetry-memory-usage", "telemetry-swap-usage", "telemetry-disk-usage", "telemetry-disk-free", "telemetry-temperature-label", "telemetry-disk-secondary-label"]) {
        this.nodes[id] = root.querySelector("#" + id);
        if (!this.nodes[id]) throw new Error("System telemetry unavailable.");
      }
      this.clear();
    }
    number(value, digits = 1) {
      try { return value.toLocaleString(this.locale(), {maximumFractionDigits: digits}); }
      catch (_) { return value.toLocaleString("en", {maximumFractionDigits: digits}); }
    }
    bytes(value) {
      if (!bytes(value)) return null;
      let amount = value, unit = 0; const units = ["B", "KB", "MB", "GB", "TB", "PB"];
      while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1; }
      return this.number(amount, unit ? 1 : 0) + " " + units[unit];
    }
    usageTitle(metric, key, fallback) {
      const used = this.bytes(metric?.used), total = this.bytes(metric?.total);
      return used !== null && total !== null ? this.t(key, {used, total}) : fallback;
    }
    diskTitle(metric, key, fallback) {
      const title = this.usageTitle(metric, key, fallback), free = this.bytes(metric?.free);
      return free === null ? title : title + " " + this.t("Available space: {value}.", {value: free});
    }
    set(id, value, title, state = "ready") {
      const element = this.nodes[id];
      element.textContent = value === null ? "—" : value;
      element.title = title; element.setAttribute("aria-label", title);
      element.dataset.state = value === null && state === "ready" ? "unavailable" : state;
    }
    render(data) { this.snapshot = data && typeof data === "object" && !Array.isArray(data) ? data : null; this.relabel(); }
    clear() { this.snapshot = null; this.relabel(); }
    relabel() {
      const data = this.snapshot;
      this.root.dataset.state = data ? "ready" : "waiting";
      if (!data) {
        this.nodes["telemetry-temperature-label"].textContent = this.t("Temp");
        this.nodes["telemetry-disk-secondary-label"].textContent = this.t("Free");
        for (const id of ["telemetry-cpu-usage", "telemetry-cpu-temperature", "telemetry-memory-usage", "telemetry-swap-usage", "telemetry-disk-usage", "telemetry-disk-free"]) this.set(id, null, this.t("Waiting for system data."), "waiting");
        return;
      }
      const cpu = data.cpu || {}, memory = data.memory || {}, swap = data.swap || {}, disk = data.disk || {};
      const cpuValue = finite(cpu.percent) && cpu.percent >= 0 && cpu.percent <= 100 ? this.number(cpu.percent) + "%" : null;
      let cpuTitle = cpuValue === null ? this.t(cpu.reason === "warming_up" ? "Measuring CPU usage…" : "CPU usage unavailable.") : this.t("CPU usage: {value}.", {value: cpuValue});
      if (cpuValue !== null && finite(cpu.available_cpus) && cpu.available_cpus > 0) cpuTitle += " " + this.t("Available CPUs: {count}.", {count: this.number(cpu.available_cpus, 2)});
      if (data.scope === "container") cpuTitle += " " + this.t("Measured for the NVR container.");
      else if (data.scope === "machine") cpuTitle += " " + this.t("Measured for the local machine.");
      this.set("telemetry-cpu-usage", cpuValue, cpuTitle);

      const temperature = finite(cpu.temperature_celsius) ? this.number(cpu.temperature_celsius) + "°C" : null;
      const hostTemperature = cpu.temperature_scope === "host" || data.scope === "container" && temperature !== null;
      this.nodes["telemetry-temperature-label"].textContent = this.t(hostTemperature ? "Host temp" : "Temp");
      this.set("telemetry-cpu-temperature", temperature, temperature === null ? this.t("Temperature sensor unavailable.") : this.t(hostTemperature ? "Host temperature: {value}." : "CPU temperature: {value}.", {value: temperature}));

      const memoryPercent = percent(memory), memoryValue = memoryPercent === null ? null : this.number(memoryPercent) + "%";
      let memoryTitle = this.usageTitle(memory, "RAM used: {used} / {total}.", this.t("RAM usage unavailable."));
      if (memoryValue !== null && data.scope === "container") {
        memoryTitle += " " + this.t("Includes file cache.");
        const working = this.bytes(memory.working_set);
        if (working !== null) memoryTitle += " " + this.t("Working set: {value}.", {value: working});
      } else if (memoryValue !== null && data.scope === "machine") memoryTitle += " " + this.t("Based on total minus available memory.");
      this.set("telemetry-memory-usage", memoryValue, memoryTitle);

      if (swap.total === 0 && swap.used === 0) this.set("telemetry-swap-usage", this.t("No swap"), this.t("No swap is configured."), "empty");
      else {
        const swapPercent = percent(swap), swapValue = swapPercent === null ? null : this.number(swapPercent) + "%";
        this.set("telemetry-swap-usage", swapValue, this.usageTitle(swap, "Swap used: {used} / {total}.", this.t("Swap usage unavailable.")));
      }

      const archive = disk.recordings || {}, archivePercent = percent(archive);
      this.set("telemetry-disk-usage", archivePercent === null ? null : this.number(archivePercent) + "%", this.diskTitle(archive, "Archive disk used: {used} / {total}.", this.t("Archive disk usage unavailable.")));
      if (disk.shared_filesystem === false) {
        this.nodes["telemetry-disk-secondary-label"].textContent = this.t("OS disk");
        const operating = disk.root || {}, operatingPercent = percent(operating);
        this.set("telemetry-disk-free", operatingPercent === null ? null : this.number(operatingPercent) + "%", this.diskTitle(operating, "OS disk used: {used} / {total}.", this.t("OS disk usage unavailable.")));
      } else {
        this.nodes["telemetry-disk-secondary-label"].textContent = this.t("Free");
        const free = this.bytes(archive.free);
        this.set("telemetry-disk-free", free, free === null ? this.t("Archive disk free space unavailable.") : this.t("Archive disk free: {value}.", {value: free}));
      }
    }
  }
  global.NvrSystemTelemetry = NvrSystemTelemetry;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrSystemTelemetry};
})(typeof window !== "undefined" ? window : globalThis);
