"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {NvrSystemDashboard, historyWindow, historySegments, downsampleSegments, headroom} = require("../nvr/static/system-dashboard.js");

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.attributes = new Map(); this._text = ""; this.hidden = false; this.className = ""; this.title = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion forbidden"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
}
function environment() {
  const document = {createElement(tag) { return new Element(tag, document); }, createElementNS(namespace, tag) { assert.equal(namespace, "http://www.w3.org/2000/svg"); return new Element(tag, document); }};
  const root = new Element("div", document); let language = "en";
  const italian = {"System overview": "Panoramica del sistema", "No swap": "Nessuno swap", "Host temperature": "Temperatura host", "CPU history": "Cronologia CPU", "Includes file cache.": "Include la cache dei file.", "Recording headroom": "Margine di registrazione"};
  const t = (key, params = {}) => (language === "it" ? italian[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token);
  const dashboard = new NvrSystemDashboard({root, t, locale: () => language === "it" ? "it-IT" : "en-GB"});
  return {root, dashboard, card(key) { return dashboard.cards.get(key); }, chart(key) { return dashboard.charts.get(key); }, language(value) { language = value; dashboard.relabel(); }};
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
function series(node, name) { return all(node).filter((item) => item.getAttribute("data-series") === name); }
function recording(extra = {}) { return {active_cameras: 4, estimated_cameras: 4, bytes_per_second: 1e6, bytes_per_day: 86.4e9, usable_free_bytes: 7.2e9, reserve_bytes: 5e9, remaining_seconds: 7200, reason: null, method: "recent_recordings", retention_limited: true, ...extra}; }
function snapshot(extra = {}) {
  return {version: "0.13.0", sampled_at: 1800, scope: "container",
    identity: {hostname: "recorder", addresses: ["192.0.2.20", "2001:db8::20"], os_name: "Debian GNU/Linux", kernel: "6.12", architecture: "aarch64"},
    uptime: {system_seconds: 90061, service_seconds: 3661},
    cpu: {percent: 12.3, available_cpus: 2, temperature_celsius: 48.2, temperature_scope: "host"},
    memory: {used: 3.6e9, total: 4e9, percent: 90, working_set: 283e6}, swap: {used: 0, total: 512e6, percent: 0},
    disk: {recordings: {used: 8e9, total: 50e9, free: 42e9, percent: 16}, root: {used: 6e9, total: 8e9, free: 2e9, percent: 75}, shared_filesystem: false},
    recording: recording(), history: {window_seconds: 1800, interval_seconds: 5, points: []}, ...extra};
}
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test("empty and cleared dashboards keep unknown values empty and never manufacture history or zero usage", () => {
  const env = environment();
  assert.equal(env.dashboard.cards.size, 10); assert.equal(env.dashboard.charts.size, 2);
  for (const card of env.dashboard.cards.values()) assert.equal(card.value.textContent, "—");
  for (const chart of env.dashboard.charts.values()) { assert.equal(chart.plot.hidden, true); assert.equal(chart.empty.hidden, false); assert.equal(chart.empty.textContent, "Waiting for samples."); assert.equal(all(chart.legend).filter((item) => item.className === "system-chart-peak").length, 0); }
  env.dashboard.render(snapshot()); env.dashboard.clear();
  assert.equal(env.root.dataset.state, "waiting"); assert.equal(env.dashboard.snapshot, null);
  assert.doesNotMatch(env.root.textContent, /192\.0\.2\.20|Debian|0\.13\.0|48\.2|90%|42 GB/);
  for (const card of env.dashboard.cards.values()) assert.equal(card.value.textContent, "—");
});

test("real OS identity, uptime, capacity and recording headroom remain distinct from file cache and host sensors", () => {
  const env = environment(), data = freeze(snapshot()); env.dashboard.render(data);
  assert.equal(env.card("recorder").value.textContent, "recorder"); assert.match(env.card("recorder").detail.textContent, /192\.0\.2\.20.*2001:db8::20/);
  assert.match(env.card("recorder").detail.textContent, /0\.13\.0/); assert.equal(env.card("os").value.textContent, "Debian GNU/Linux"); assert.match(env.card("os").detail.textContent, /6\.12.*aarch64/);
  assert.equal(env.card("uptime").value.textContent, "1 d 1 h"); assert.match(env.card("uptime").detail.textContent, /1 h 1 min/);
  assert.equal(env.card("cpu").value.textContent, "12.3%"); assert.match(env.card("cpu").detail.textContent, /2.*NVR container/);
  assert.equal(env.card("memory").value.textContent, "90%"); assert.match(env.card("memory").detail.textContent, /Includes file cache.*283 MB/);
  assert.equal(env.card("swap").value.textContent, "0%"); assert.equal(env.card("temperature").label.textContent, "Host temperature"); assert.equal(env.card("temperature").value.textContent, "48.2°C");
  assert.equal(env.card("archive").value.textContent, "16%"); assert.match(env.card("archive").detail.textContent, /42 GB/); assert.equal(env.card("root").value.textContent, "75%"); assert.match(env.card("root").detail.textContent, /2 GB/);
  assert.equal(env.card("recording").value.textContent, "≈ 2 h 0 min"); assert.match(env.card("recording").detail.textContent, /1 MB\/s.*86\.4 GB.*4 \/ 4.*7\.2 GB.*5 GB/);
  assert.match(env.card("recording").card.title, /before space-based cleanup.*Retention may remove files earlier/);
  assert.equal(data.memory.used, 3.6e9);
});

test("missing and nonfinite values do not become NaN, Infinity, zero metrics or fabricated estimates", () => {
  const env = environment(); env.dashboard.render(snapshot({cpu: {percent: NaN, available_cpus: Infinity, temperature_celsius: Infinity}, memory: {used: null, total: null, percent: 0}, swap: {used: null, total: null}, uptime: {system_seconds: -1, service_seconds: Infinity}, recording: recording({remaining_seconds: Infinity})}));
  for (const key of ["cpu", "temperature", "memory", "swap", "uptime", "recording"]) assert.equal(env.card(key).value.textContent, "—");
  assert.doesNotMatch(env.root.textContent, /NaN|Infinity|undefined/);
  env.dashboard.render([]); assert.equal(env.root.dataset.state, "waiting");
});

test("zero swap, zero available disk and a shared filesystem have explicit meanings", () => {
  const env = environment(), data = snapshot({swap: {used: 0, total: 0, percent: null}, uptime: {system_seconds: 0, service_seconds: 0}});
  data.disk.shared_filesystem = true; data.disk.root = null; data.disk.recordings.free = 0;
  env.dashboard.render(data);
  assert.equal(env.card("swap").value.textContent, "No swap"); assert.equal(env.card("uptime").value.textContent, "0 s");
  assert.equal(env.card("root").value.textContent, "Shared with archive"); assert.match(env.card("root").detail.textContent, /same filesystem.*0 B/);
});

test("headroom requires a complete measured rate and never treats cleanup as guaranteed recording duration", () => {
  const env = environment();
  for (const value of [null, recording({active_cameras: 0}), recording({estimated_cameras: 3}), recording({bytes_per_second: 0}), recording({method: "guess"}), recording({usable_free_bytes: null}), recording({reason: "insufficient_data"}), recording({remaining_seconds: -1})]) {
    env.dashboard.render(snapshot({recording: value})); assert.equal(env.card("recording").value.textContent, "—");
  }
  env.dashboard.render(snapshot({recording: recording({active_cameras: 0, reason: "no_active_recordings"})})); assert.match(env.card("recording").detail.textContent, /No cameras are recording/);
  env.dashboard.render(snapshot({recording: recording({remaining_seconds: 0, usable_free_bytes: 0, reason: "storage_reserve_reached"})}));
  assert.equal(env.card("recording").value.textContent, "≈ 0 min"); assert.match(env.card("recording").detail.textContent, /Cleanup threshold reached/);
  assert.equal(headroom(recording({remaining_seconds: 0, usable_free_bytes: 1, reason: "storage_reserve_reached"})).seconds, null);
});

test("history uses measured timestamps, clips the real window and splits long gaps and explicit missing samples", () => {
  const env = environment(), points = [
    {sampled_at: 0, cpu_percent: 10, memory_percent: 20, swap_percent: 0},
    {sampled_at: 5, cpu_percent: 20, memory_percent: 30, swap_percent: 0},
    {sampled_at: 10, cpu_percent: null, memory_percent: 40, swap_percent: null},
    {sampled_at: 15, cpu_percent: 40, memory_percent: 50, swap_percent: 10},
    {sampled_at: 40, cpu_percent: 50, memory_percent: 60, swap_percent: 20},
    {sampled_at: 45, cpu_percent: 60, memory_percent: 70, swap_percent: 30},
    {sampled_at: 70, cpu_percent: 100, memory_percent: 100, swap_percent: 100},
  ];
  const data = freeze(snapshot({sampled_at: 60, history: {window_seconds: 60, interval_seconds: 5, points}})); env.dashboard.render(data);
  const cpu = series(env.chart("cpu").plot, "cpu");
  assert.deepEqual(cpu.map((item) => item.tagName), ["PATH", "CIRCLE", "PATH"]);
  assert.deepEqual(cpu.map((item) => item.getAttribute("data-points")), ["2", "1", "2"]);
  assert.match(cpu[0].getAttribute("d"), /^M38\.00 /); assert.match(cpu[0].getAttribute("d"), /L87\.17 /);
  assert.match(env.chart("cpu").legend.textContent, /Peak: 60%/); assert.doesNotMatch(env.chart("cpu").legend.textContent, /100%/);
  assert.equal(cpu[0].getAttribute("stroke"), "var(--accent)");
  assert.equal(series(env.chart("memory").plot, "memory")[0].getAttribute("stroke"), "var(--motion)");
  assert.equal(series(env.chart("memory").plot, "swap").length, 3);
  const svg = env.chart("cpu").plot.children[0]; assert.equal(svg.getAttribute("role"), "img"); assert.match(svg.getAttribute("aria-label"), /last 1 minutes/); assert.match(svg.children[0].textContent, /Gaps remain empty/);
});

test("single real samples render isolated dots, invalid or empty history never creates a peak or a line", () => {
  const env = environment(); env.dashboard.render(snapshot({history: {window_seconds: 1800, points: [{sampled_at: 1800, cpu_percent: 0, memory_percent: 25, swap_percent: null}]}}));
  assert.equal(series(env.chart("cpu").plot, "cpu")[0].tagName, "CIRCLE"); assert.match(env.chart("cpu").legend.textContent, /Peak: 0%/);
  env.dashboard.render(snapshot({history: {points: [{sampled_at: NaN, cpu_percent: 90}, {sampled_at: 1800, cpu_percent: null}]}}));
  assert.equal(series(env.chart("cpu").plot, "cpu").length, 0); assert.equal(env.chart("cpu").plot.hidden, true); assert.doesNotMatch(env.chart("cpu").legend.textContent, /Peak/);
});

test("window sorting and duplicate timestamps preserve the final real sample without modifying input", () => {
  const data = freeze(snapshot({sampled_at: 100, history: {window_seconds: 30, points: [{sampled_at: 90, cpu_percent: 1}, {sampled_at: 60, cpu_percent: 100}, {sampled_at: 80, cpu_percent: 2}, {sampled_at: 90, cpu_percent: 3}]}}));
  const window = historyWindow(data); assert.deepEqual(window.points.map((point) => point.sampled_at), [80, 90]); assert.deepEqual(historySegments(window, "cpu_percent")[0].map((point) => point.value), [2, 3]);
  assert.equal(data.history.points[0].cpu_percent, 1);
});

test("identity and addresses remain inert text and cannot create HTML, links or executable SVG", () => {
  const env = environment(), attack = '<img src=x onerror="alert(1)">';
  env.dashboard.render(snapshot({identity: {hostname: attack, addresses: ["javascript:alert(1)", attack], os_name: "<script>bad()</script>", kernel: attack, architecture: attack}}));
  assert.equal(env.card("recorder").value.textContent, attack); assert.match(env.root.textContent, /javascript:alert/);
  assert.equal(all(env.root).filter((node) => ["IMG", "SCRIPT", "A", "FOREIGNOBJECT"].includes(node.tagName)).length, 0);
  assert.equal(all(env.root).some((node) => [...node.attributes.keys()].some((key) => /^on|href$/i.test(key))), false);
});

test("relabeling preserves the exact snapshot, current measurements and real graph timestamps; clear drops all private identity", () => {
  const env = environment(), data = freeze(snapshot({swap: {used: 0, total: 0}, history: {window_seconds: 1800, points: [{sampled_at: 1800, cpu_percent: 12.3, memory_percent: 90, swap_percent: null, temperature_celsius: 48.2}]}}));
  env.dashboard.render(data); const path = series(env.chart("cpu").plot, "cpu")[0].getAttribute("cx"); env.language("it");
  assert.equal(env.dashboard.snapshot, data); assert.equal(env.dashboard.title.textContent, "Panoramica del sistema"); assert.equal(env.card("cpu").value.textContent, "12,3%"); assert.equal(env.card("temperature").label.textContent, "Temperatura host"); assert.equal(env.card("swap").value.textContent, "Nessuno swap");
  assert.equal(series(env.chart("cpu").plot, "cpu")[0].getAttribute("cx"), path); assert.match(env.card("memory").detail.textContent, /Include la cache/);
  env.dashboard.clear(); assert.doesNotMatch(env.root.textContent, /recorder|192\.0\.2\.20|2001:db8::20/);
});

test("the renderer has no fetch, polling, browser storage or HTML parsing side effects", () => {
  const source = readFileSync(join(__dirname, "../nvr/static/system-dashboard.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);
});

function policy(free, extra = {}) {
  return {free_percent: free, warning: free !== null && free < 10, overwrite_required: free !== null && free < 5,
    state: free === null ? "unavailable" : free < 5 ? "critical" : free < 10 ? "warning" : "normal", ...extra};
}

test("disk cards share server storage thresholds without applying archive overwrite policy to the OS", () => {
  const env = environment();
  for (const [free, expected] of [[10, "normal"], [9.999, "warning"], [5, "warning"], [4.999, "critical"], [0, "critical"]]) {
    const data = freeze(snapshot({storage: {archive: policy(free), system: policy(3, {overwrite_required: false}), shared_filesystem: false}}));
    env.dashboard.render(data);
    assert.equal(env.card("archive").card.dataset.storageState, expected); assert.equal(env.card("root").card.dataset.storageState, "critical");
    assert.match(env.card("archive").card.title, /free.*(overwrite|removed)/i);
    assert.match(env.card("root").detail.textContent, /System disk space is below 5%.*only applies to the archive/);
    assert.doesNotMatch(env.card("root").detail.textContent, /Oldest completed|system files.*removed|overwrite is active/i);
    if (expected === "critical") assert.match(env.card("archive").detail.textContent, /overwrite is required.*when available/);
    if (expected === "normal") assert.doesNotMatch(env.card("archive").detail.textContent, /warning|overwrite/);
    assert.equal(data.storage.archive.free_percent, free);
  }
});

test("shared filesystems show a single archive policy and recovery or logout removes every old warning", () => {
  const env = environment(), data = snapshot({storage: {archive: policy(4), system: policy(2), shared_filesystem: true}});
  data.disk.shared_filesystem = true; env.dashboard.render(data);
  assert.equal(env.card("archive").card.dataset.storageState, "critical"); assert.equal(env.card("root").card.dataset.storageState, "unavailable");
  assert.equal(env.card("root").value.textContent, "Shared with archive"); assert.doesNotMatch(env.card("root").detail.textContent, /overwrite|below 5%/);
  data.storage.archive = policy(12); env.dashboard.render(data);
  assert.equal(env.card("archive").card.dataset.storageState, "normal"); assert.doesNotMatch(env.card("archive").detail.textContent, /overwrite|Low archive/);
  env.dashboard.clear(); assert.equal(env.card("archive").card.dataset.storageState, "unavailable"); assert.equal(env.card("archive").card.title, "");
  assert.doesNotMatch(env.root.textContent, /Low archive|overwrite|12% free/);
});

test("unavailable or malicious storage values cannot create warning text, execute markup or imply zero free space", () => {
  const env = environment();
  for (const value of [null, policy(null), policy(NaN), policy(-1), policy("3"), policy(1, {state: '<img onerror="bad()">'})]) {
    env.dashboard.render(snapshot({storage: {archive: value, system: null}}));
    assert.equal(env.card("archive").card.dataset.storageState, "unavailable"); assert.equal(env.card("archive").card.title, "");
    assert.doesNotMatch(env.card("archive").detail.textContent, /NaN|onerror|0% free|overwrite/);
    assert.equal(all(env.root).some((node) => ["IMG", "SCRIPT"].includes(node.tagName)), false);
  }
});

test("saved six-hour history includes five-hour-old peaks and is never overwritten by the live thirty-minute snapshot", () => {
  const env = environment(), end = 200000;
  env.dashboard.setHistoryWindow(6);
  env.dashboard.render(snapshot({sampled_at: end, history: {window_seconds: 1800, points: [{sampled_at: end, cpu_percent: 100}]}}));
  assert.equal(series(env.chart("cpu").plot, "cpu").length, 0);
  const saved = freeze({available: true, sampled_at: end, window_seconds: 21600, interval_seconds: 30,
    points: [{sampled_at: end - 18000, cpu_percent: 97}, {sampled_at: end - 30, cpu_percent: 5}]});
  env.dashboard.setHistory(saved);
  assert.equal(env.chart("cpu").period.textContent, "Last 6 hours");
  assert.match(env.chart("cpu").legend.textContent, /Peak: 97%/);
  const first = series(env.chart("cpu").plot, "cpu")[0]; assert.ok(Number(first.getAttribute("cx")) < 200);
  env.dashboard.render(snapshot({sampled_at: end + 5, cpu: {percent: 2}, history: {window_seconds: 1800, points: [{sampled_at: end, cpu_percent: 100}]}}));
  assert.equal(env.dashboard.savedHistory, saved); assert.match(env.chart("cpu").legend.textContent, /Peak: 97%/);
  assert.doesNotMatch(env.chart("cpu").legend.textContent, /100%/);
  env.language("it"); assert.equal(env.dashboard.savedHistory, saved);
  env.dashboard.setHistoryWindow(24); assert.equal(series(env.chart("cpu").plot, "cpu").length, 0);
  env.dashboard.setHistory(saved); env.dashboard.clear();
  assert.equal(env.dashboard.savedHistory, null); assert.equal(series(env.chart("cpu").plot, "cpu").length, 0);
});

test("thirty-second saved samples remain connected only within cadence and explicit unknown samples break each series", () => {
  const env = environment(), points = [0, 30, 60, 90, 120, 240, 270].map((sampled_at) => ({sampled_at, cpu_percent: sampled_at === 60 ? null : 25, memory_percent: 50}));
  env.dashboard.setHistoryWindow(1);
  env.dashboard.setHistory({available: true, sampled_at: 300, window_seconds: 3600, interval_seconds: 30, points});
  assert.equal(env.chart("cpu").period.textContent, "Last hour");
  assert.deepEqual(series(env.chart("cpu").plot, "cpu").map((item) => item.getAttribute("data-points")), ["2", "2", "2"]);
  assert.deepEqual(series(env.chart("memory").plot, "memory").map((item) => item.getAttribute("data-points")), ["5", "2"]);
});

test("seven-day rendering bounds SVG vertices while preserving old metric extremes and real missing periods", () => {
  const env = environment(), end = 700000;
  const points = Array.from({length: 20161}, (_, index) => ({sampled_at: end - 604800 + index * 30,
    cpu_percent: index === 10 ? 100 : 20 + index % 10, memory_percent: index === 110 ? 99 : 60, swap_percent: index === 210 ? 80 : 0}));
  const gapStart = points[10000].sampled_at, gapEnd = points[10008].sampled_at;
  points.splice(10000, 9); points[100].cpu_percent = null;
  const saved = freeze({available: true, sampled_at: end, window_seconds: 604800, interval_seconds: 30, points});
  const window = historyWindow(saved), raw = historySegments(window, "cpu_percent"), reduced = downsampleSegments(raw, window);
  assert.ok(reduced.flat().length <= 1200);
  assert.equal(Math.max(...reduced.flat().map((point) => point.value)), 100);
  assert.ok(reduced.every((segment) => !(segment[0].time < gapStart && segment.at(-1).time > gapEnd)));
  assert.ok(reduced.every((segment) => !(segment[0].time < points[100].sampled_at && segment.at(-1).time > points[100].sampled_at)));
  env.dashboard.setHistoryWindow(168); env.dashboard.setHistory(saved);
  for (const [chart, name, peak] of [["cpu", "cpu", 100], ["memory", "memory", 99], ["memory", "swap", 80]]) {
    const nodes = series(env.chart(chart).plot, name);
    assert.ok(nodes.reduce((count, node) => count + Number(node.getAttribute("data-points")), 0) <= 1200);
    assert.match(env.chart(chart).legend.textContent, new RegExp("Peak: " + peak + "%"));
    assert.ok(nodes.every((node) => !/NaN|Infinity/.test(node.getAttribute("d") || node.getAttribute("cx"))));
  }
  assert.equal(env.chart("cpu").period.textContent, "Last 7 days");
  const ticks = all(env.chart("cpu").plot).filter((node) => node.tagName === "TEXT" && node.getAttribute("y") === "170");
  assert.equal(ticks[0].textContent, env.dashboard.timeLabel(end - 604800, true));
  assert.equal(ticks.at(-1).textContent, env.dashboard.timeLabel(end, true));
});

test("a heavily fragmented week stays bounded without joining isolated samples across missing values", () => {
  const end = 604800, points = Array.from({length: 20161}, (_, index) => ({sampled_at: index * 30, cpu_percent: index % 2 ? null : index === 100 ? 100 : 2}));
  const window = historyWindow({sampled_at: end, window_seconds: end, interval_seconds: 30, points});
  const reduced = downsampleSegments(historySegments(window, "cpu_percent"), window);
  assert.ok(reduced.length <= 1200); assert.ok(reduced.every((segment) => segment.length === 1));
  assert.equal(Math.max(...reduced.flat().map((point) => point.value)), 100);
});
