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
  function recordingHeadroom(value) {
    if (!value || typeof value !== "object") return {seconds: null, reason: "Recording headroom unavailable."};
    if (value.active_cameras === 0 || value.reason === "no_active_recordings") return {seconds: null, reason: "No cameras are recording."};
    if (value.reason === "insufficient_data" || !Number.isInteger(value.active_cameras) || value.active_cameras <= 0
        || !Number.isInteger(value.estimated_cameras) || value.estimated_cameras < value.active_cameras) return {seconds: null, reason: "Not enough completed recordings to estimate."};
    const reserveReached = value.reason === "storage_reserve_reached" && value.usable_free_bytes === 0 && value.remaining_seconds === 0;
    if (value.reason && !reserveReached || value.method !== "recent_recordings" || !finite(value.bytes_per_second) || value.bytes_per_second <= 0
        || !bytes(value.usable_free_bytes) || !bytes(value.reserve_bytes)
        || !bytes(value.remaining_seconds) || value.remaining_seconds > 100 * 366 * 86400) return {seconds: null, reason: "Recording headroom unavailable."};
    return {seconds: value.remaining_seconds, reason: reserveReached ? "Cleanup threshold reached." : null};
  }
  function storageState(policy) {
    if (!policy || !finite(policy.free_percent) || policy.free_percent < 0 || policy.free_percent > 100) return "unavailable";
    return ["normal", "warning", "critical"].includes(policy.state) ? policy.state : "unavailable";
  }
  function storageDescription(policy, kind, t, number) {
    const state = storageState(policy);
    if (state === "unavailable") return "";
    // Keep an under-threshold reading below that threshold when formatting it.
    const [whole, fraction = ""] = policy.free_percent.toString().split(".");
    const truncated = policy.free_percent < .01 ? 0 : Number(whole + "." + fraction.slice(0, 2));
    const value = policy.free_percent > 0 && truncated === 0 ? t("less than {percent}", {percent: number(.01, 2)}) : number(truncated, 2);
    const key = kind === "archive" ? state === "critical"
      ? "Archive space is below 5% free ({percent}%). Automatic overwrite is required. Oldest completed, unprotected recordings are removed when available."
      : state === "warning" ? "Low archive space: {percent}% free. Oldest completed, unprotected recordings are automatically removed below 5% free."
      : "Archive space: {percent}% free. A warning appears below 10%; automatic overwrite removes the oldest completed, unprotected recordings below 5%."
      : state === "critical" ? "System disk space is below 5% free ({percent}%). Free system disk space; automatic overwrite only applies to the archive."
      : state === "warning" ? "Low system disk space: {percent}% free. Automatic overwrite only applies to the archive."
      : "System disk space: {percent}% free. Automatic overwrite only applies to the archive.";
    return t(key, {percent: value});
  }
  class NvrSystemTelemetry {
    static storageState(policy) { return storageState(policy); }
    static storageDescription(policy, kind, t, number) { return storageDescription(policy, kind, t, number); }
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
      this.capacityNodes = {};
      const document = root.ownerDocument || global.document;
      for (const id of ["header-archive-free", "header-system-free", "header-recording-remaining"]) {
        this.capacityNodes[id] = document?.getElementById?.(id) || root.querySelector("#" + id);
      }
      this.storageAlert = document?.getElementById?.("storage-alert") || null;
      this.storageMessages = {};
      for (const kind of ["archive", "system"]) this.storageMessages[kind] = document?.getElementById?.("storage-alert-" + kind) || null;
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
    setCapacity(id, value, title) {
      const element = this.capacityNodes[id];
      if (!element) return;
      element.textContent = value === null ? "—" : value;
      element.title = title; element.setAttribute("aria-label", title);
      element.dataset.state = value === null ? "unavailable" : "ready";
    }
    renderCapacity(data) {
      const disk = data?.disk || {}, archive = this.bytes(disk.recordings?.free);
      const system = this.bytes(disk.shared_filesystem === true ? disk.recordings?.free : disk.root?.free);
      this.setCapacity("header-archive-free", archive, archive === null ? this.t("Archive disk free space unavailable.") : this.t("Archive disk free: {value}.", {value: archive}));
      let systemTitle = system === null ? this.t("OS disk free space unavailable.") : this.t("OS disk free: {value}.", {value: system});
      if (disk.shared_filesystem === true) systemTitle += " " + this.t("The operating system and archive use the same filesystem.");
      this.setCapacity("header-system-free", system, systemTitle);
      const estimate = recordingHeadroom(data?.recording);
      let value = null;
      if (estimate.seconds !== null) {
        const minutes = Math.floor(estimate.seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
        const duration = days ? this.t("{days}d{hours}h", {days: this.number(days, 0), hours: this.number(hours % 24, 0)})
          : hours ? this.t("{hours}h{minutes}m", {hours: this.number(hours, 0), minutes: this.number(minutes % 60, 0)})
          : this.t("{minutes}m", {minutes: this.number(minutes, 0)});
        value = this.t("≈ {duration}", {duration});
      }
      const explanation = this.t("Estimated time before space-based cleanup at the recent recording rate. Retention may remove files earlier.");
      this.setCapacity("header-recording-remaining", value, estimate.reason ? this.t(estimate.reason) + " " + explanation : explanation);
    }
    renderStorage(data) {
      const storage = data?.storage || {}, shared = storage.shared_filesystem === true;
      const archive = storage.archive, system = shared ? null : storage.system;
      const description = (policy, kind) => storageDescription(policy, kind, this.t, this.number.bind(this));
      const mark = (element, policy, kind) => {
        if (!element) return;
        element.dataset.storageState = storageState(policy);
        const details = description(policy, kind);
        if (details) {
          element.title += " " + details;
          element.setAttribute("aria-label", element.title);
        }
      };
      mark(this.nodes["telemetry-disk-usage"], archive, "archive");
      mark(this.nodes["telemetry-disk-free"], shared ? archive : system, shared ? "archive" : "system");
      mark(this.capacityNodes["header-archive-free"], archive, "archive");
      mark(this.capacityNodes["header-system-free"], system, "system");
      const active = [];
      for (const [kind, policy] of [["archive", archive], ["system", system]]) {
        const state = storageState(policy), message = this.storageMessages[kind];
        const visible = state === "warning" || state === "critical";
        if (visible) active.push(state);
        if (message) {
          const next = visible ? description(policy, kind) : "";
          if (message.textContent !== next) message.textContent = next;
          message.hidden = !visible; message.dataset.state = state;
        }
      }
      if (this.storageAlert) {
        this.storageAlert.hidden = active.length === 0;
        this.storageAlert.dataset.state = active.includes("critical") ? "critical" : active.length ? "warning" : "normal";
      }
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
        for (const id of Object.keys(this.capacityNodes)) this.setCapacity(id, null, this.t("Waiting for system data."));
        this.renderStorage(null);
        return;
      }
      const cpu = data.cpu || {}, memory = data.memory || {}, swap = data.swap || {}, disk = data.disk || {};
      this.renderCapacity(data);
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
      this.renderStorage(data);
    }
  }
  global.NvrSystemTelemetry = NvrSystemTelemetry;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrSystemTelemetry};
})(typeof window !== "undefined" ? window : globalThis);
