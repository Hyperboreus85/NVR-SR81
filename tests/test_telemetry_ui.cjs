"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {NvrSystemTelemetry} = require("../nvr/static/system-telemetry.js");
const ids = ["telemetry-cpu-usage", "telemetry-cpu-temperature", "telemetry-memory-usage", "telemetry-swap-usage", "telemetry-disk-usage", "telemetry-disk-free"];
function environment({capacity = true, outsideRoot = false, alerts = true} = {}) {
  const nodes = new Map(); let language = "en";
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, {_text: "", textWrites: 0, hidden: true, get textContent() { return this._text; }, set textContent(value) { this._text = String(value); this.textWrites += 1; }, title: "", dataset: {}, attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); }, set innerHTML(_) { throw Error("HTML insertion is forbidden"); }});
    return nodes.get(id);
  };
  const translations = {"No swap": "Nessuno swap", "Host temp": "Temp. host", "Free": "Libero", "Waiting for system data.": "In attesa dei dati di sistema.", "Includes file cache.": "Include la cache dei file.", "Low archive space: {percent}% free. Oldest completed, unprotected recordings are automatically removed below 5% free.": "Spazio archivio ridotto: {percent}% libero. Le registrazioni completate non protette più vecchie vengono rimosse automaticamente sotto il 5% di spazio libero."};
  const t = (key, params = {}) => (language === "it" ? translations[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token);
  const capacityIds = ["header-archive-free", "header-system-free", "header-recording-remaining"];
  const alertIds = ["storage-alert", "storage-alert-archive", "storage-alert-system"];
  const root = {dataset: {}, ownerDocument: {getElementById: (id) => capacity && outsideRoot && capacityIds.includes(id) || alerts && alertIds.includes(id) ? get(id) : null},
    querySelector: (selector) => capacityIds.includes(selector.slice(1)) && (!capacity || outsideRoot) ? null : get(selector.slice(1))};
  const renderer = new NvrSystemTelemetry({root, t, locale: () => language});
  return {renderer, get, root, nodes, language(value) { language = value; renderer.relabel(); }};
}
function snapshot(extra = {}) {
  return {sampled_at: 1234, scope: "container", cpu: {percent: 12.34, available_cpus: 2, temperature_celsius: 64.5, temperature_scope: "host", source: "cgroup"}, memory: {used: 3.6e9, total: 4e9, percent: 90, working_set: 283e6}, swap: {used: 0, total: 512e6, percent: 0}, disk: {recordings: {used: 8e9, total: 20e9, free: 12e9, percent: 40}, root: {used: 6.8e9, total: 8e9, free: 1e9, percent: 85}, shared_filesystem: false}, ...extra};
}
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }

test("initial and cleared telemetry show placeholders instead of fabricated zeroes or stale readings", () => {
  const env = environment();
  for (const id of ids) { assert.equal(env.get(id).textContent, "—"); assert.equal(env.get(id).dataset.state, "waiting"); assert.equal(env.get(id).title, "Waiting for system data."); }
  env.renderer.render(snapshot()); env.renderer.clear();
  for (const id of ids) assert.equal(env.get(id).textContent, "—");
  assert.equal(env.root.dataset.state, "waiting"); assert.equal(env.get("telemetry-temperature-label").textContent, "Temp"); assert.equal(env.get("telemetry-disk-secondary-label").textContent, "Free");
});

test("fresh container metrics show actual percentages and host temperature with explicit file-cache accounting", () => {
  const env = environment(), data = freeze(snapshot()); env.renderer.render(data);
  assert.deepEqual(ids.map((id) => env.get(id).textContent), ["12.3%", "64.5°C", "90%", "0%", "40%", "85%"]);
  assert.equal(env.get("telemetry-temperature-label").textContent, "Host temp"); assert.equal(env.get("telemetry-cpu-temperature").title, "Host temperature: 64.5°C.");
  assert.match(env.get("telemetry-cpu-usage").title, /Available CPUs: 2/); assert.match(env.get("telemetry-cpu-usage").title, /NVR container/);
  assert.match(env.get("telemetry-memory-usage").title, /3.6 GB \/ 4 GB/); assert.match(env.get("telemetry-memory-usage").title, /Includes file cache/); assert.match(env.get("telemetry-memory-usage").title, /Working set: 283 MB/);
  assert.equal(env.get("telemetry-disk-secondary-label").textContent, "OS disk");
  assert.match(env.get("telemetry-disk-usage").title, /Archive disk used: 8 GB \/ 20 GB/); assert.match(env.get("telemetry-disk-usage").title, /Available space: 12 GB/);
  assert.match(env.get("telemetry-disk-free").title, /OS disk used: 6.8 GB \/ 8 GB/); assert.match(env.get("telemetry-disk-free").title, /Available space: 1 GB/);
  for (const id of ids) { assert.equal(env.get(id).dataset.state, "ready"); assert.equal(env.get(id).attributes.get("aria-label"), env.get(id).title); }
  assert.equal(data.memory.used, 3.6e9);
});

test("shared archive and system filesystem show free capacity without duplicating OS percentage", () => {
  const env = environment(), data = snapshot(); data.disk.shared_filesystem = true; data.disk.root.percent = 99;
  env.renderer.render(data); assert.equal(env.get("telemetry-disk-usage").textContent, "40%"); assert.equal(env.get("telemetry-disk-free").textContent, "12 GB"); assert.equal(env.get("telemetry-disk-secondary-label").textContent, "Free");
  assert.equal(env.get("telemetry-disk-free").title, "Archive disk free: 12 GB.");
});

test("an unavailable archive disk never borrows the OS measurement, and the reverse is also true", () => {
  const env = environment(), data = snapshot(); data.disk.recordings = {used: null, total: null, free: null, percent: null}; env.renderer.render(data);
  assert.equal(env.get("telemetry-disk-usage").textContent, "—"); assert.equal(env.get("telemetry-disk-free").textContent, "85%");
  data.disk.recordings = {used: 5e9, total: 10e9, free: 5e9, percent: 50}; data.disk.root = null; env.renderer.render(data);
  assert.equal(env.get("telemetry-disk-usage").textContent, "50%"); assert.equal(env.get("telemetry-disk-free").textContent, "—");
});

test("first CPU sample and absent sensors remain unknown, while genuine zeroes and no-swap are distinguished", () => {
  const env = environment(), data = snapshot({cpu: {percent: null, available_cpus: 2, temperature_celsius: null, reason: "warming_up"}, swap: {used: 0, total: 0, percent: null}});
  env.renderer.render(data); assert.equal(env.get("telemetry-cpu-usage").textContent, "—"); assert.match(env.get("telemetry-cpu-usage").title, /Measuring CPU usage/);
  assert.equal(env.get("telemetry-cpu-temperature").textContent, "—"); assert.equal(env.get("telemetry-cpu-temperature").title, "Temperature sensor unavailable.");
  assert.equal(env.get("telemetry-swap-usage").textContent, "No swap"); assert.equal(env.get("telemetry-swap-usage").dataset.state, "empty");
  data.cpu.percent = 0; data.cpu.temperature_celsius = 0; data.swap = {used: 0, total: 1e9, percent: 0}; data.disk.shared_filesystem = true; data.disk.recordings.free = 0; env.renderer.render(data);
  assert.equal(env.get("telemetry-cpu-usage").textContent, "0%"); assert.equal(env.get("telemetry-cpu-temperature").textContent, "0°C"); assert.equal(env.get("telemetry-swap-usage").textContent, "0%"); assert.equal(env.get("telemetry-disk-free").textContent, "0 B");
  data.swap = {used: null, total: null, percent: null}; env.renderer.render(data); assert.equal(env.get("telemetry-swap-usage").textContent, "—");
});

test("machine RAM explains its available-memory basis and temperatures receive no arbitrary severity threshold", () => {
  const env = environment(), data = snapshot({scope: "machine", cpu: {percent: 15, available_cpus: 8, temperature_celsius: -8.4, temperature_scope: "machine"}}); env.renderer.render(data);
  assert.match(env.get("telemetry-memory-usage").title, /Based on total minus available memory/); assert.doesNotMatch(env.get("telemetry-memory-usage").title, /Includes file cache/);
  assert.equal(env.get("telemetry-temperature-label").textContent, "Temp"); assert.equal(env.get("telemetry-cpu-temperature").textContent, "-8.4°C"); assert.equal(env.get("telemetry-cpu-temperature").dataset.state, "ready");
  data.cpu.temperature_celsius = 110; env.renderer.render(data); assert.equal(env.get("telemetry-cpu-temperature").textContent, "110°C"); assert.equal(env.get("telemetry-cpu-temperature").dataset.state, "ready");
});

test("malformed numbers and incomplete readings cannot display NaN, Infinity or a default zero", () => {
  const env = environment(); env.renderer.render({cpu: {percent: "", temperature_celsius: Infinity}, memory: {used: null, total: null, percent: 0}, swap: {used: -1, total: 1e9, percent: 999}, disk: {recordings: {used: "0", total: "100", free: NaN, percent: "0"}, shared_filesystem: true}});
  for (const id of ids) { assert.equal(env.get(id).textContent, "—", id); assert.doesNotMatch(env.get(id).title, /NaN|Infinity|undefined/); }
  env.renderer.render({}); for (const id of ids) assert.equal(env.get(id).textContent, "—");
  env.renderer.render(null); assert.equal(env.root.dataset.state, "waiting");
});

test("language changes relabel the existing snapshot without requests or resetting measured values", () => {
  const env = environment(), data = snapshot({swap: {used: 0, total: 0, percent: null}}); env.renderer.render(data); env.language("it");
  assert.equal(env.get("telemetry-cpu-usage").textContent, "12,3%"); assert.equal(env.get("telemetry-cpu-temperature").textContent, "64,5°C"); assert.equal(env.get("telemetry-temperature-label").textContent, "Temp. host"); assert.equal(env.get("telemetry-swap-usage").textContent, "Nessuno swap"); assert.match(env.get("telemetry-memory-usage").title, /Include la cache dei file/);
  env.renderer.clear(); for (const id of ids) assert.equal(env.get(id).title, "In attesa dei dati di sistema.");
  assert.equal(env.get("telemetry-disk-secondary-label").textContent, "Libero");
});

test("provided reason strings remain inert and successive render/clear calls do not retain stale metrics", () => {
  const env = environment(); const data = snapshot(); data.cpu.reason = '<img src=x onerror="alert(1)">'; env.renderer.render(data);
  data.cpu.percent = 5.5; env.renderer.render(data); assert.equal(env.get("telemetry-cpu-usage").textContent, "5.5%");
  env.renderer.clear(); for (const id of ids) assert.equal(env.get(id).textContent, "—");
  env.renderer.render([]); assert.equal(env.root.dataset.state, "waiting");
});

test("global header contains one set of metrics and recording capacity while monitor controls remain on the right", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8"), css = readFileSync(join(__dirname, "../nvr/static/style.css"), "utf8");
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>') + '</header>'.length);
  const toolbar = html.slice(html.indexOf('<div class="monitor-toolbar">'), html.indexOf('<div id="monitor-error"'));
  assert.ok(header.includes('id="monitor-telemetry"')); assert.ok(header.includes('id="header-capacity"'));
  assert.equal(toolbar.includes('id="monitor-telemetry"'), false);
  assert.ok(toolbar.indexOf('class="monitor-pagination"') < toolbar.indexOf('class="monitor-wall-actions"'));
  const controls = [...toolbar.matchAll(/<button([^>]*)>/g)].map((match) => match[1]);
  assert.ok(controls.at(-1).includes('id="monitor-fullscreen"')); assert.ok(controls.at(-2).includes('id="monitor-toggle"'));
  assert.equal((header.match(/class="telemetry-widget"/g) || []).length, 3);
  for (const id of [...ids, "header-archive-free", "header-system-free", "header-recording-remaining"]) { assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1); assert.ok(header.includes('id="' + id + '"')); }
  assert.match(css, /\.header-metrics \.telemetry-widget\{[^}]*height:32px[^}]*min-height:32px/); assert.match(css, /\.monitor-toolbar>\.monitor-wall-actions\{[^}]*margin-left:auto/);
  assert.ok(html.indexOf("/static/system-telemetry.js") < html.indexOf("/static/app.js"));
});

function measuredRecording(extra = {}) {
  return {active_cameras: 2, estimated_cameras: 2, bytes_per_second: 1e6, usable_free_bytes: 8.1e9,
    reserve_bytes: 5e9, remaining_seconds: 8100, reason: null, method: "recent_recordings", ...extra};
}

test("capacity nodes outside the legacy metric root show both free disks and measured time before cleanup", () => {
  const env = environment({outsideRoot: true}), data = snapshot({recording: measuredRecording()});
  env.renderer.render(data);
  assert.equal(env.get("header-archive-free").textContent, "12 GB"); assert.equal(env.get("header-system-free").textContent, "1 GB");
  assert.equal(env.get("header-recording-remaining").textContent, "≈ 2h15m");
  assert.match(env.get("header-recording-remaining").title, /before space-based cleanup.*Retention may remove files earlier/);
  assert.doesNotMatch(env.get("header-recording-remaining").title, /stop recording|recording will stop/i);
  env.renderer.clear(); for (const id of ["header-archive-free", "header-system-free", "header-recording-remaining"]) assert.equal(env.get(id).textContent, "—");
});

test("incomplete or missing rate estimates stay unknown and explain no active or insufficient recording data", () => {
  const env = environment();
  for (const recording of [null, measuredRecording({active_cameras: 0, reason: "no_active_recordings"}), measuredRecording({estimated_cameras: 1}), measuredRecording({bytes_per_second: null}), measuredRecording({remaining_seconds: Infinity}), measuredRecording({method: "guess"})]) {
    env.renderer.render(snapshot({recording})); assert.equal(env.get("header-recording-remaining").textContent, "—"); assert.doesNotMatch(env.get("header-recording-remaining").title, /Infinity|NaN|undefined/);
  }
  env.renderer.render(snapshot({recording: measuredRecording({active_cameras: 0, reason: "no_active_recordings"})})); assert.match(env.get("header-recording-remaining").title, /No cameras are recording/);
  env.renderer.render(snapshot({recording: measuredRecording({reason: "insufficient_data"})})); assert.match(env.get("header-recording-remaining").title, /Not enough completed recordings/);
});

test("a valid reserve threshold displays zero headroom, while an unknown disk or inconsistent estimate stays unknown", () => {
  const env = environment(), data = snapshot({recording: measuredRecording({remaining_seconds: 0, usable_free_bytes: 0, reason: "storage_reserve_reached"})});
  data.disk.recordings.free = 0; env.renderer.render(data);
  assert.equal(env.get("header-archive-free").textContent, "0 B"); assert.equal(env.get("header-recording-remaining").textContent, "≈ 0m"); assert.match(env.get("header-recording-remaining").title, /Cleanup threshold reached/);
  data.recording.remaining_seconds = 1; data.disk.recordings.free = null; env.renderer.render(data);
  assert.equal(env.get("header-archive-free").textContent, "—"); assert.equal(env.get("header-recording-remaining").textContent, "—");
});

test("shared storage and relabeling preserve capacity values and absent optional header nodes remain compatible", () => {
  const env = environment(), data = snapshot({recording: measuredRecording()}); data.disk.shared_filesystem = true; data.disk.root = null; data.disk.recordings.free = 12.3e9;
  env.renderer.render(data); assert.equal(env.get("header-system-free").textContent, "12.3 GB"); assert.match(env.get("header-system-free").title, /same filesystem/);
  env.language("it"); assert.equal(env.get("header-archive-free").textContent, "12,3 GB"); assert.equal(env.get("header-system-free").textContent, "12,3 GB");
  const legacy = environment({capacity: false}); assert.doesNotThrow(() => legacy.renderer.render(data)); assert.doesNotThrow(() => legacy.renderer.clear());
  assert.equal(legacy.nodes.has("header-archive-free"), false);
});

function storagePolicy(free, extra = {}) {
  return {warning_free_percent: 10, overwrite_free_percent: 5, free_percent: free, reserve_bytes: 1e9,
    warning: free !== null && free < 10, overwrite_required: free !== null && free < 5,
    state: free === null ? "unavailable" : free < 5 ? "critical" : free < 10 ? "warning" : "normal", ...extra};
}
function storageSnapshot(free, system = null) {
  return snapshot({storage: {archive: storagePolicy(free), system: system === null ? null : storagePolicy(system, {overwrite_required: false, reserve_bytes: null}), shared_filesystem: false}});
}

test("persistent storage warnings honor exact server thresholds and never classify rounded disk percentages", () => {
  const env = environment({outsideRoot: true});
  for (const [free, expected, visible, printed] of [[10, "normal", false], [9.999, "warning", true, "9.99%"], [5, "warning", true, "5%"], [4.999, "critical", true, "4.99%"], [0, "critical", true, "0%"]]) {
    const data = storageSnapshot(free); data.disk.recordings.percent = 90; env.renderer.render(freeze(data));
    assert.equal(env.get("telemetry-disk-usage").dataset.storageState, expected);
    assert.equal(env.get("header-archive-free").dataset.storageState, expected);
    assert.equal(env.get("storage-alert").hidden, !visible);
    if (visible) { assert.equal(env.get("storage-alert").dataset.state, expected); assert.ok(env.get("storage-alert-archive").textContent.includes(printed)); }
    assert.match(env.get("telemetry-disk-usage").title, /free.*(overwrite|removed)/i);
  }
  env.renderer.render(storageSnapshot(10)); assert.equal(env.get("storage-alert").hidden, true);
  assert.equal(env.get("storage-alert-archive").textContent, ""); assert.equal(env.get("storage-alert-archive").hidden, true);
});

test("critical archive notices describe required overwrite without claiming successful removal or active-file deletion", () => {
  const env = environment(); env.renderer.render(storageSnapshot(.001));
  const message = env.get("storage-alert-archive").textContent;
  assert.match(message, /less than 0\.01/); assert.match(message, /overwrite is required.*completed, unprotected.*when available/);
  assert.doesNotMatch(message, /overwrite is active|have been removed|files deleted|all recordings/i);
});

test("system disk alerts remain separate and never promise deletion of operating-system files", () => {
  const env = environment(); env.renderer.render(storageSnapshot(60, 8));
  assert.equal(env.get("storage-alert-archive").hidden, true); assert.equal(env.get("storage-alert-system").hidden, false);
  assert.match(env.get("storage-alert-system").textContent, /Low system disk space.*8%.*only applies to the archive/);
  assert.equal(env.get("telemetry-disk-usage").dataset.storageState, "normal"); assert.equal(env.get("telemetry-disk-free").dataset.storageState, "warning");
  env.renderer.render(storageSnapshot(60, 4)); assert.equal(env.get("storage-alert").dataset.state, "critical");
  assert.match(env.get("storage-alert-system").textContent, /Free system disk space.*only applies to the archive/);
  const shared = storageSnapshot(7, 2); shared.storage.shared_filesystem = true; shared.disk.shared_filesystem = true;
  env.renderer.render(shared); assert.equal(env.get("storage-alert-system").hidden, true); assert.equal(env.get("storage-alert").dataset.state, "warning");
  assert.equal(env.get("header-system-free").dataset.storageState, "unavailable"); assert.equal(env.get("telemetry-disk-free").dataset.storageState, "warning");
});

test("unchanged polls do not rewrite live warning messages, while relabeling preserves policy and measurements", () => {
  const env = environment(), data = freeze(storageSnapshot(9.2, 3)); env.renderer.render(data);
  const first = env.get("storage-alert-archive").textWrites, second = env.get("storage-alert-system").textWrites;
  for (let index = 0; index < 5; index += 1) env.renderer.render(data);
  assert.equal(env.get("storage-alert-archive").textWrites, first); assert.equal(env.get("storage-alert-system").textWrites, second);
  env.language("it"); assert.match(env.get("storage-alert-archive").textContent, /Spazio archivio ridotto: 9,2%/);
  assert.equal(env.renderer.snapshot, data); assert.equal(env.get("storage-alert").dataset.state, "critical");
});

test("missing, invalid, cleared or legacy storage data cannot retain warnings or manufacture zero-free alerts", () => {
  const env = environment();
  for (const policy of [null, storagePolicy(null), storagePolicy(NaN), storagePolicy(-1), storagePolicy(Infinity), storagePolicy("1"), storagePolicy(3, {state: '<img onerror="bad()">'})]) {
    env.renderer.render(storageSnapshot(1)); env.renderer.render(snapshot({storage: {archive: policy, system: null}}));
    assert.equal(env.get("storage-alert").hidden, true); assert.equal(env.get("storage-alert-archive").textContent, "");
    assert.equal(env.get("telemetry-disk-usage").dataset.storageState, "unavailable");
    assert.doesNotMatch(env.get("telemetry-disk-usage").title, /NaN|Infinity|onerror/);
  }
  env.renderer.render(storageSnapshot(1)); env.renderer.clear(); assert.equal(env.get("storage-alert").hidden, true);
  for (const id of ["telemetry-disk-usage", "telemetry-disk-free", "header-archive-free", "header-system-free"]) assert.equal(env.get(id).dataset.storageState, "unavailable");
  const legacy = environment({capacity: false, alerts: false}); assert.doesNotThrow(() => legacy.renderer.render(storageSnapshot(1, 1))); assert.doesNotThrow(() => legacy.renderer.clear());
});

test("the storage warning is a single global status outside page sections and has no toast or polling side effects", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8"), source = readFileSync(join(__dirname, "../nvr/static/system-telemetry.js"), "utf8");
  for (const id of ["storage-alert", "storage-alert-archive", "storage-alert-system"]) assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1);
  assert.ok(html.indexOf('id="storage-alert"') > html.indexOf('</header>')); assert.ok(html.indexOf('id="storage-alert"') < html.indexOf('<main>'));
  assert.match(html, /id="storage-alert"[^>]*role="status"[^>]*hidden/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bsetInterval\s*\(|\bsetTimeout\s*\(|innerHTML|insertAdjacentHTML|\btoast\s*\(/);
});
