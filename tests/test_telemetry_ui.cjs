"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {NvrSystemTelemetry} = require("../nvr/static/system-telemetry.js");
const ids = ["telemetry-cpu-usage", "telemetry-cpu-temperature", "telemetry-memory-usage", "telemetry-swap-usage", "telemetry-disk-usage", "telemetry-disk-free"];
function environment() {
  const nodes = new Map(); let language = "en";
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, {textContent: "", title: "", dataset: {}, attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); }, set innerHTML(_) { throw Error("HTML insertion is forbidden"); }});
    return nodes.get(id);
  };
  const translations = {"No swap": "Nessuno swap", "Host temp": "Temp. host", "Free": "Libero", "Waiting for system data.": "In attesa dei dati di sistema.", "Includes file cache.": "Include la cache dei file."};
  const t = (key, params = {}) => (language === "it" ? translations[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token);
  const root = {dataset: {}, querySelector: (selector) => get(selector.slice(1))};
  const renderer = new NvrSystemTelemetry({root, t, locale: () => language});
  return {renderer, get, root, language(value) { language = value; renderer.relabel(); }};
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

test("toolbar keeps widgets on the left and layout/pause/fullscreen last on the right with uniform widget height", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8"), css = readFileSync(join(__dirname, "../nvr/static/style.css"), "utf8");
  const toolbar = html.slice(html.indexOf('<div class="monitor-toolbar">'), html.indexOf('<div id="monitor-error"'));
  assert.ok(toolbar.indexOf('id="monitor-telemetry"') < toolbar.indexOf('class="monitor-pagination"'));
  assert.ok(toolbar.indexOf('class="monitor-pagination"') < toolbar.indexOf('class="monitor-wall-actions"'));
  const controls = [...toolbar.matchAll(/<button([^>]*)>/g)].map((match) => match[1]);
  assert.ok(controls.at(-1).includes('id="monitor-fullscreen"')); assert.ok(controls.at(-2).includes('id="monitor-toggle"'));
  assert.equal((toolbar.match(/class="telemetry-widget"/g) || []).length, 3);
  for (const id of ids) assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1);
  assert.match(css, /\.telemetry-widget\{[^}]*height:32px[^}]*min-height:32px/); assert.match(css, /\.monitor-toolbar>\.monitor-wall-actions\{[^}]*margin-left:auto/);
  assert.ok(html.indexOf("/static/system-telemetry.js") < html.indexOf("/static/app.js"));
});
