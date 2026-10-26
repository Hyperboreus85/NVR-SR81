"use strict";

((global) => {
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const positive = (value) => finite(value) && value > 0;
  const nonnegative = (value) => finite(value) && value >= 0;
  const percentage = (value) => finite(value) && value >= 0 && value <= 100;
  const timestamp = (value) => nonnegative(value) && value <= 8.64e12;
  const text = (value) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) : "";
  const defaults = (key, params = {}) => (global.NvrI18n?.t(key, params) || key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token);
  const storageUI = global.NvrSystemTelemetry || (typeof module !== "undefined" && module.exports ? require("./system-telemetry.js").NvrSystemTelemetry : null);
  const MAX_HISTORY_POINTS = 22000;
  const MAX_SERIES_VERTICES = 1200;
  const HISTORY_HOURS = [1, 6, 24, 168];
  const COLORS = {cpu: "var(--accent)", memory: "var(--motion)", swap: "var(--system-swap)", temperature: "var(--system-temperature)"};

  function metricPercent(metric) {
    if (!metric || !positive(metric.total) || !nonnegative(metric.used)) return null;
    if (percentage(metric.percent)) return metric.percent;
    return metric.used <= metric.total ? metric.used / metric.total * 100 : null;
  }
  function headroom(recording) {
    if (!recording || typeof recording !== "object") return {seconds: null, reason: "Recording headroom unavailable."};
    if (recording.active_cameras === 0 || recording.reason === "no_active_recordings") return {seconds: null, reason: "No cameras are recording."};
    const counts = Number.isInteger(recording.active_cameras) && recording.active_cameras > 0
      && Number.isInteger(recording.estimated_cameras) && recording.estimated_cameras >= recording.active_cameras;
    if (recording.reason === "insufficient_data" || !counts) return {seconds: null, reason: "Not enough completed recordings to estimate."};
    const reserveReached = recording.reason === "storage_reserve_reached" && recording.usable_free_bytes === 0 && recording.remaining_seconds === 0;
    if (recording.reason && !reserveReached || recording.method !== "recent_recordings" || !positive(recording.bytes_per_second)
        || !nonnegative(recording.remaining_seconds) || recording.remaining_seconds > 100 * 366 * 86400
        || !nonnegative(recording.usable_free_bytes) || !nonnegative(recording.reserve_bytes)) return {seconds: null, reason: "Recording headroom unavailable."};
    return {seconds: recording.remaining_seconds, reason: reserveReached ? "Cleanup threshold reached." : null};
  }
  function durationLabel(seconds, t, number, approximate = false) {
    if (!nonnegative(seconds) || seconds > 100 * 366 * 86400) return null;
    const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    let result;
    if (days) result = t("{days} d {hours} h", {days: number(days, 0), hours: number(hours % 24, 0)});
    else if (hours) result = t("{hours} h {minutes} min", {hours: number(hours, 0), minutes: number(minutes % 60, 0)});
    else if (approximate || minutes) result = t("{minutes} min", {minutes: number(minutes, 0)});
    else result = t("{seconds} s", {seconds: number(Math.floor(seconds), 0)});
    return approximate ? t("≈ {duration}", {duration: result}) : result;
  }
  function historyWindow(snapshot) {
    const history = snapshot?.history || snapshot, raw = Array.isArray(history?.points) ? history.points.slice(-MAX_HISTORY_POINTS) : [];
    const times = raw.filter((point) => timestamp(point?.sampled_at)).map((point) => point.sampled_at);
    const end = timestamp(snapshot?.sampled_at) ? snapshot.sampled_at : times.length ? Math.max(...times) : null;
    const window = positive(history?.window_seconds) && history.window_seconds <= 604800 ? history.window_seconds : 1800;
    const interval = positive(history?.interval_seconds) && history.interval_seconds <= 300 ? history.interval_seconds : 5;
    const points = new Map();
    if (end !== null) for (const point of raw) if (timestamp(point?.sampled_at) && point.sampled_at >= end - window && point.sampled_at <= end) points.set(point.sampled_at, point);
    return {start: end === null ? null : end - window, end, seconds: window, interval, points: [...points.values()].sort((a, b) => a.sampled_at - b.sampled_at)};
  }
  function historySegments(window, field, validate = percentage) {
    const segments = []; let current = [], previous = null;
    for (const point of window.points) {
      const value = point[field];
      if (!validate(value)) { if (current.length) segments.push(current); current = []; previous = null; continue; }
      if (previous !== null && point.sampled_at - previous > (positive(window.interval) ? window.interval : 5) * 3) { if (current.length) segments.push(current); current = []; }
      current.push({time: point.sampled_at, value}); previous = point.sampled_at;
    }
    if (current.length) segments.push(current);
    return segments;
  }
  function downsampleSegments(segments, window, budget = MAX_SERIES_VERTICES) {
    if (segments.reduce((count, segment) => count + segment.length, 0) <= budget) return segments;
    const bucketCount = Math.max(1, Math.floor(budget / 4)), buckets = new Map();
    segments.forEach((segment, segmentId) => segment.forEach((point) => {
      const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((point.time - window.start) / window.seconds * bucketCount)));
      const sample = {point, segmentId}, bucket = buckets.get(index);
      if (!bucket) buckets.set(index, {first: sample, last: sample, min: sample, max: sample});
      else { bucket.last = sample; if (point.value < bucket.min.point.value) bucket.min = sample; if (point.value > bucket.max.point.value) bucket.max = sample; }
    }));
    const chosen = new Map();
    for (const bucket of buckets.values()) for (const sample of Object.values(bucket)) chosen.set(sample.point.time, sample);
    const result = []; let current = [], previousId = null;
    for (const sample of [...chosen.values()].sort((a, b) => a.point.time - b.point.time)) {
      if (previousId !== null && sample.segmentId !== previousId) { result.push(current); current = []; }
      current.push(sample.point); previousId = sample.segmentId;
    }
    if (current.length) result.push(current);
    return result;
  }

  class NvrSystemDashboard {
    constructor({root, t = defaults, locale} = {}) {
      if (!root?.ownerDocument?.createElement) throw new Error("System dashboard unavailable.");
      this.root = root; this.document = root.ownerDocument; this.t = t;
      this.locale = typeof locale === "function" ? locale : () => locale || global.NvrI18n?.locale() || "en";
      this.snapshot = null; this.savedHistory = undefined; this.historyHours = 6; this.cards = new Map(); this.charts = new Map();
      this.build(); this.clear();
    }
    element(tag, className, value) {
      const node = this.document.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    }
    svgElement(tag, attributes = {}, value) {
      const node = this.document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, item] of Object.entries(attributes)) node.setAttribute(key, String(item));
      if (value !== undefined) node.textContent = value;
      return node;
    }
    build() {
      const heading = this.element("div", "system-overview-heading");
      this.title = this.element("h3"); this.scope = this.element("span", "system-card-detail"); heading.append(this.title, this.scope);
      const grid = this.element("div", "system-overview-grid");
      for (const key of ["recorder", "os", "uptime", "cpu", "memory", "swap", "temperature", "archive", "root", "recording"]) {
        const card = this.element("article", "system-overview-card"); card.dataset.metric = key;
        const label = this.element("h4", "system-card-label"), value = this.element("strong", "system-card-value"), detail = this.element("div", "system-card-detail");
        card.append(label, value, detail); grid.append(card); this.cards.set(key, {card, label, value, detail});
      }
      const controls = this.element("div", "system-history-controls"), label = this.element("label", "system-history-label"), select = this.element("select");
      select.id = "system-history-window";
      label.setAttribute("for", select.id);
      const refresh = this.element("button", "button secondary small-button"); refresh.type = "button"; refresh.id = "system-history-refresh";
      const status = this.element("span", "system-history-status"); status.id = "system-history-status"; status.setAttribute("role", "status");
      this.historyControls = {root: controls, label, select, refresh, status};
      controls.append(label, select, refresh, status);
      const charts = this.element("div", "system-charts-grid");
      for (const key of ["cpu", "memory"]) {
        const card = this.element("section", "system-chart-card"); card.dataset.chart = key;
        const heading = this.element("div", "system-chart-heading"), title = this.element("h4"), period = this.element("span", "system-card-detail");
        heading.append(title, period);
        const legend = this.element("div", "system-chart-legend"), plot = this.element("div", "system-chart-plot"), empty = this.element("p", "system-chart-empty");
        card.append(heading, legend, plot, empty); charts.append(card); this.charts.set(key, {card, title, period, legend, plot, empty});
      }
      this.note = this.element("p", "system-card-detail system-overview-note");
      this.root.replaceChildren(heading, grid, controls, charts, this.note);
    }
    number(value, digits = 1) {
      try { return value.toLocaleString(this.locale(), {maximumFractionDigits: digits}); }
      catch (_) { return value.toLocaleString("en", {maximumFractionDigits: digits}); }
    }
    bytes(value) {
      if (!nonnegative(value)) return null;
      const units = ["B", "KB", "MB", "GB", "TB", "PB"]; let unit = 0;
      while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
      return this.number(value, unit ? 1 : 0) + " " + units[unit];
    }
    percent(value) { return percentage(value) ? this.number(value) + "%" : null; }
    duration(value, approximate = false) { return durationLabel(value, this.t, this.number.bind(this), approximate); }
    card(key, label, value, details = []) {
      const node = this.cards.get(key); node.label.textContent = this.t(label); node.value.textContent = value ?? "—";
      node.card.dataset.state = value === null || value === undefined ? "unavailable" : "ready";
      node.detail.replaceChildren(...details.filter((line) => typeof line === "string" && line).map((line) => this.element("p", "", line)));
    }
    usage(metric) {
      const used = this.bytes(metric?.used), total = this.bytes(metric?.total);
      return used !== null && total !== null ? this.t("Used: {used} / {total}.", {used, total}) : this.t("Unavailable");
    }
    diskDetails(metric) {
      const free = this.bytes(metric?.free);
      return [this.usage(metric), free === null ? this.t("Available space unavailable.") : this.t("Available space: {value}.", {value: free})];
    }
    storageDetails(kind, policy) {
      const node = this.cards.get(kind === "archive" ? "archive" : "root");
      const state = storageUI?.storageState(policy) || "unavailable";
      node.card.dataset.storageState = state;
      const message = storageUI?.storageDescription(policy, kind, this.t, this.number.bind(this)) || "";
      node.card.title = message;
      if (message && (state === "warning" || state === "critical")) {
        const detail = this.element("p", "system-storage-policy", message);
        detail.dataset.state = state; node.detail.append(detail);
      }
    }
    render(snapshot) { this.snapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null; this.relabel(); }
    clear() { this.snapshot = null; if (this.savedHistory !== undefined) this.savedHistory = null; this.relabel(); }
    setHistoryWindow(hours) {
      if (!HISTORY_HOURS.includes(hours)) return false;
      if (hours === this.historyHours && this.savedHistory !== undefined) return true;
      if (hours !== this.historyHours || this.savedHistory === undefined) this.savedHistory = null;
      this.historyHours = hours; this.relabel(); return true;
    }
    setHistory(history) { this.savedHistory = history && typeof history === "object" && !Array.isArray(history) ? history : null; this.relabel(); }
    relabel() {
      const data = this.snapshot, t = this.t;
      this.root.dataset.state = data ? "ready" : "waiting"; this.title.textContent = t("System overview");
      this.scope.textContent = data?.scope === "container" ? t("NVR container") : data?.scope === "machine" ? t("Local recorder machine") : t("Waiting for system data.");
      this.note.textContent = t("Estimated time before space-based cleanup at the recent recording rate. Retention may remove files earlier.");
      const history = historyWindow(this.savedHistory === undefined ? data : this.savedHistory || {sampled_at: data?.sampled_at, window_seconds: this.historyHours * 3600, interval_seconds: 30, points: []}), points = history.points;
      const controls = this.historyControls;
      controls.root.hidden = this.savedHistory === undefined;
      controls.label.textContent = t("History time range"); controls.select.setAttribute("aria-label", t("History time range"));
      controls.select.replaceChildren(...HISTORY_HOURS.map((hours, index) => {
        const option = this.element("option", "", t(["Last hour", "Last 6 hours", "Last 24 hours", "Last 7 days"][index])); option.value = String(hours); return option;
      }));
      controls.select.value = String(this.historyHours); controls.refresh.textContent = t("Refresh history");
      const identity = data?.identity || {}, uptime = data?.uptime || {}, cpu = data?.cpu || {}, memory = data?.memory || {}, swap = data?.swap || {}, disk = data?.disk || {}, recording = data?.recording || {};
      const addresses = Array.isArray(identity.addresses) ? identity.addresses.slice(0, 8).map(text).filter(Boolean) : [];
      this.card("recorder", "Recorder", text(identity.recorder_name) || text(identity.hostname) || null, [text(identity.recorder_name) && text(identity.recorder_name) !== text(identity.hostname) ? t("Hostname: {value}.", {value: text(identity.hostname)}) : "", text(data?.version) ? t("Application version: {value}.", {value: text(data.version)}) : "", addresses.length ? t("IP addresses: {value}.", {value: addresses.join(" · ")}) : ""]);
      this.card("os", "Operating system", text(identity.os_name) || null, [text(identity.kernel) ? t("Kernel: {value}.", {value: text(identity.kernel)}) : "", text(identity.architecture) ? t("Architecture: {value}.", {value: text(identity.architecture)}) : ""]);
      const service = this.duration(uptime.service_seconds);
      this.card("uptime", "System uptime", this.duration(uptime.system_seconds), [service === null ? "" : t("Service uptime: {value}.", {value: service})]);
      this.card("cpu", "CPU", this.percent(cpu.percent), [positive(cpu.available_cpus) ? t("Available CPUs: {count}.", {count: this.number(cpu.available_cpus, 2)}) : "", data?.scope === "container" ? t("Measured for the NVR container.") : data?.scope === "machine" ? t("Measured for the local machine.") : ""]);
      const working = this.bytes(memory.working_set);
      this.card("memory", "RAM", this.percent(metricPercent(memory)), [this.usage(memory), data?.scope === "container" ? t("Includes file cache.") : data?.scope === "machine" ? t("Based on total minus available memory.") : "", data?.scope === "container" && working !== null ? t("Working set: {value}.", {value: working}) : ""]);
      const noSwap = swap.total === 0 && swap.used === 0;
      this.card("swap", "Swap", noSwap ? t("No swap") : this.percent(metricPercent(swap)), [noSwap ? t("No swap is configured.") : this.usage(swap)]);
      const temperature = finite(cpu.temperature_celsius) && cpu.temperature_celsius >= -50 && cpu.temperature_celsius <= 150 ? this.number(cpu.temperature_celsius) + "°C" : null;
      const host = cpu.temperature_scope === "host" || data?.scope === "container";
      const temperatures = points.map((point) => point.temperature_celsius).filter((value) => finite(value) && value >= -50 && value <= 150);
      this.card("temperature", host ? "Host temperature" : "CPU temperature", temperature, [temperature === null ? t("Temperature sensor unavailable.") : host ? t("Host sensor visible to this container.") : "", temperatures.length ? t("Peak in this window: {value}.", {value: this.number(Math.max(...temperatures)) + "°C"}) : ""]);
      this.card("archive", "Archive disk", this.percent(metricPercent(disk.recordings)), this.diskDetails(disk.recordings));
      this.card("root", "OS disk", disk.shared_filesystem === true ? t("Shared with archive") : this.percent(metricPercent(disk.root)), disk.shared_filesystem === true ? [t("The operating system and archive use the same filesystem."), ...this.diskDetails(disk.recordings)] : this.diskDetails(disk.root));
      this.storageDetails("archive", data?.storage?.archive);
      this.storageDetails("system", data?.storage?.shared_filesystem === true ? null : data?.storage?.system);
      const estimate = headroom(recording), rate = this.bytes(recording.bytes_per_second), daily = this.bytes(recording.bytes_per_day), usable = this.bytes(recording.usable_free_bytes), reserve = this.bytes(recording.reserve_bytes);
      this.card("recording", "Recording headroom", this.duration(estimate.seconds, true), [estimate.reason ? t(estimate.reason) : "", rate === null ? "" : t("Recent recording rate: {value}/s.", {value: rate}), daily === null ? "" : t("Estimated daily recordings: {value}.", {value: daily}), Number.isInteger(recording.active_cameras) && Number.isInteger(recording.estimated_cameras) ? t("Cameras included: {estimated} / {active}.", {estimated: this.number(recording.estimated_cameras, 0), active: this.number(recording.active_cameras, 0)}) : "", usable === null ? "" : t("Space after reserve: {value}.", {value: usable}), reserve === null ? "" : t("Storage reserve: {value}.", {value: reserve})]);
      this.cards.get("recording").card.title = this.note.textContent;
      this.chart("cpu", "CPU history", [{name: "CPU", key: "cpu", field: "cpu_percent"}], history);
      this.chart("memory", "RAM and swap history", [{name: "RAM", key: "memory", field: "memory_percent"}, {name: "Swap", key: "swap", field: "swap_percent"}], history);
    }
    timeLabel(value, withDate = false) {
      const clock = typeof window !== "undefined" && window.NvrRecorderClockInstance;
      if (clock) return clock.format(new Date(value * 1000), {hour: "2-digit", minute: "2-digit", ...(withDate ? {day: "2-digit", month: "2-digit"} : {})}, this.locale());
      try { return new Intl.DateTimeFormat(this.locale(), {hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(withDate ? {day: "2-digit", month: "2-digit"} : {})}).format(new Date(value * 1000)); }
      catch (_) { return "—"; }
    }
    chart(key, title, series, window) {
      const node = this.charts.get(key), t = this.t, minutes = this.number(window.seconds / 60, 0);
      const label = {3600: "Last hour", 21600: "Last 6 hours", 86400: "Last 24 hours", 604800: "Last 7 days"}[window.seconds];
      const period = label ? t(label) : window.seconds >= 86400 ? t("Last {days} days", {days: this.number(window.seconds / 86400, 0)}) : window.seconds >= 3600 ? t("Last {hours} hours", {hours: this.number(window.seconds / 3600, 0)}) : t("Last {minutes} minutes", {minutes});
      node.title.textContent = t(title); node.period.textContent = period;
      node.legend.replaceChildren(); node.plot.replaceChildren(); node.empty.textContent = t("Waiting for samples.");
      const svg = this.svgElement("svg", {viewBox: "0 0 640 180", role: "img", "aria-label": window.seconds < 3600 ? t("{title} over the last {minutes} minutes.", {title: t(title), minutes}) : t("{title}: {period}.", {title: t(title), period})});
      svg.append(this.svgElement("desc", {}, t("Only measured samples are shown. Gaps remain empty.")));
      const left = 38, top = 12, width = 590, height = 134;
      for (const value of [0, 25, 50, 75, 100]) {
        const y = top + height * (1 - value / 100);
        svg.append(this.svgElement("line", {x1: left, x2: left + width, y1: y, y2: y, class: "system-chart-grid"}), this.svgElement("text", {x: left - 6, y: y + 4, "text-anchor": "end", class: "system-chart-tick"}, this.number(value, 0) + "%"));
      }
      if (window.end !== null) for (const fraction of [0, .5, 1]) svg.append(this.svgElement("text", {x: left + width * fraction, y: 170, "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle", class: "system-chart-tick"}, this.timeLabel(window.start + window.seconds * fraction, window.seconds >= 86400)));
      let measured = false;
      for (const item of series) {
        const segments = historySegments(window, item.field), values = segments.flatMap((segment) => segment.map((point) => point.value));
        const legend = this.element("span", "system-chart-legend-item"), swatch = this.element("span", "system-chart-swatch"); swatch.dataset.series = item.key; swatch.setAttribute("aria-hidden", "true");
        legend.append(swatch, this.element("span", "", t(item.name)));
        if (values.length) legend.append(this.element("span", "system-chart-peak", t("Peak: {value}.", {value: this.percent(Math.max(...values))})));
        node.legend.append(legend);
        for (const segment of downsampleSegments(segments, window)) {
          measured = true;
          const position = (point) => [left + (point.time - window.start) / window.seconds * width, top + (1 - point.value / 100) * height];
          if (segment.length === 1) {
            const [x, y] = position(segment[0]); svg.append(this.svgElement("circle", {cx: x.toFixed(2), cy: y.toFixed(2), r: 2.5, fill: COLORS[item.key], class: "system-chart-series", "data-series": item.key, "data-points": 1}));
          } else {
            const path = segment.map((point, index) => (index ? "L" : "M") + position(point).map((value) => value.toFixed(2)).join(" ")).join(" ");
            svg.append(this.svgElement("path", {d: path, fill: "none", stroke: COLORS[item.key], "stroke-width": 2, "vector-effect": "non-scaling-stroke", class: "system-chart-series", "data-series": item.key, "data-points": segment.length}));
          }
        }
      }
      node.plot.append(svg); node.plot.hidden = !measured; node.empty.hidden = measured;
    }
  }
  global.NvrSystemDashboard = NvrSystemDashboard;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrSystemDashboard, historyWindow, historySegments, downsampleSegments, headroom, durationLabel};
})(typeof window !== "undefined" ? window : globalThis);
