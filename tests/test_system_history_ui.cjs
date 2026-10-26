"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/system-history.js"), "utf8");

class Control {
  constructor() { this.value = ""; this.textContent = ""; this.disabled = false; this.attributes = new Map(); this.listeners = new Map(); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  emit(type) { return this.listeners.get(type)?.(); }
}
function pending() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function history(hours = 6, extra = {}) {
  return {available: true, sampled_at: 1000000, interval_seconds: 30, window_seconds: hours * 3600,
    points: [{sampled_at: 1000000 - Math.min(hours * 3600 - 30, 18000), cpu_percent: 91, memory_percent: 80, swap_percent: 0, temperature_celsius: null}], ...extra};
}
function environment() {
  const calls = [], timers = new Map(); let nextTimer = 0, active = false, now = 0, language = "en";
  const context = {module: {exports: {}}, AbortController, performance: {now: () => now}, Date,
    setTimeout(callback, delay) { assert.equal(delay, 8000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }};
  context.window = context; vm.createContext(context); vm.runInContext(source, context);
  const dashboard = {historyControls: {root: new Control(), select: new Control(), refresh: new Control(), status: new Control()},
    historyHours: null, savedHistory: undefined, relabels: 0,
    setHistoryWindow(hours) { if (hours !== this.historyHours) this.savedHistory = null; this.historyHours = hours; return true; },
    setHistory(value) { this.savedHistory = value; }, relabel() { this.relabels += 1; }};
  const api = (path, options) => { const request = pending(); calls.push({path, options, ...request}); return request.promise; };
  const controller = new context.module.exports.NvrSystemHistory({dashboard, api, now: () => now, isActive: () => active,
    t: (key) => language === "en" ? key : "IT: " + key});
  return {controller, dashboard, calls, timers, checkedHistory: context.module.exports.checkedHistory,
    active(value) { active = value; }, time(value) { now = value; }, language(value) { language = value; },
    expire() { const [id, callback] = [...timers][0]; timers.delete(id); callback(); }};
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("history only loads while authenticated System is active and uses the shared snapshot trigger at most every thirty seconds", async () => {
  const env = environment();
  assert.equal(env.controller.hours, 6); assert.equal(env.dashboard.historyHours, 6); assert.equal(env.dashboard.savedHistory, null);
  await env.controller.open(); await env.controller.onTelemetrySnapshot(); assert.equal(env.calls.length, 0);
  env.active(true); const opening = env.controller.open();
  assert.equal(env.calls[0].path, "/api/system/history?hours=6"); assert.equal(env.calls[0].options.method, undefined);
  await env.controller.onTelemetrySnapshot(); assert.equal(env.calls.length, 1);
  env.calls[0].resolve(history()); assert.equal(await opening, true);
  assert.equal(env.dashboard.savedHistory.points[0].cpu_percent, 91);
  env.time(29999); await env.controller.onTelemetrySnapshot(); assert.equal(env.calls.length, 1);
  env.time(30000); const refresh = env.controller.onTelemetrySnapshot(); assert.equal(env.calls.length, 2);
  env.calls[1].resolve(history()); await refresh;
  assert.equal(env.timers.size, 0); assert.equal(env.dashboard.historyControls.status.textContent, "Saved samples are collected every 30 seconds.");
});

test("range selection aborts older requests and stale six-hour results cannot replace the selected day", async () => {
  const env = environment(); env.active(true); const old = env.controller.open();
  env.dashboard.historyControls.select.value = "24"; env.dashboard.historyControls.select.emit("change");
  assert.equal(env.calls.length, 2); assert.equal(env.calls[0].options.signal.aborted, true);
  assert.equal(env.calls[1].path, "/api/system/history?hours=24"); assert.equal(env.dashboard.savedHistory, null);
  env.calls[0].resolve(history()); await old; assert.equal(env.dashboard.savedHistory, null);
  env.calls[1].resolve(history(24)); await settle(); assert.equal(env.dashboard.savedHistory.window_seconds, 86400);
  assert.equal(env.controller.setWindow(7), false); assert.equal(env.dashboard.historyControls.select.value, "24");
  assert.equal(env.calls.length, 2);
});

test("leaving System and logout invalidate pending history even if the request ignores cancellation", async () => {
  const env = environment(); env.active(true); const first = env.controller.open();
  env.active(false); env.controller.close(); assert.equal(env.calls[0].options.signal.aborted, true);
  env.calls[0].resolve(history()); await first; assert.equal(env.dashboard.savedHistory, null);
  env.active(true); const second = env.controller.open(); assert.equal(env.calls.length, 2);
  env.calls[1].resolve(history()); await second; assert.ok(env.dashboard.savedHistory.points.length);
  env.controller.setWindow(168); assert.equal(env.calls.length, 3);
  env.active(false); env.controller.clear(); env.calls[2].resolve(history(168)); await settle();
  assert.equal(env.controller.data, null); assert.equal(env.dashboard.savedHistory, null); assert.equal(env.controller.hours, 6);
  assert.equal(env.timers.size, 0); assert.equal(env.dashboard.historyControls.select.disabled, true);
});

test("timeout drops stale history, never applies a late result and permits only a new read-only manual retry", async () => {
  const env = environment(); env.active(true); const first = env.controller.open();
  env.expire(); assert.equal(env.calls[0].options.signal.aborted, true); assert.equal(env.controller.loading, false);
  assert.equal(env.dashboard.historyControls.status.textContent, "Saved history unavailable. Try again.");
  env.calls[0].resolve(history()); await first; assert.equal(env.dashboard.savedHistory, null);
  env.time(1000); await env.controller.onTelemetrySnapshot(); assert.equal(env.calls.length, 1);
  const retry = env.dashboard.historyControls.refresh.emit("click"); assert.equal(env.calls.length, 2);
  env.calls[1].resolve(history()); await retry; assert.ok(env.dashboard.savedHistory.points.length);
  assert.ok(env.calls.every((call) => call.options.method === undefined && call.path.startsWith("/api/system/history?hours=")));
});

test("unavailable, malformed and empty persisted responses have distinct safe states with no fabricated samples", async () => {
  const env = environment(); env.active(true);
  let request = env.controller.open(); env.calls.at(-1).resolve(history(6, {available: false, reason: '<img onerror="bad()">'})); await request;
  assert.equal(env.dashboard.savedHistory.points.length, 0); assert.equal(env.dashboard.historyControls.status.textContent, "Saved history unavailable. Try again.");
  request = env.controller.load(true); env.calls.at(-1).resolve(history(24)); await request;
  assert.equal(env.dashboard.savedHistory, null); assert.equal(env.controller.error, true);
  request = env.controller.load(true); env.calls.at(-1).resolve(history(6, {points: []})); await request;
  assert.equal(env.controller.error, false); assert.equal(env.dashboard.historyControls.status.textContent, "No saved samples in this period.");
  assert.doesNotMatch(env.dashboard.historyControls.status.textContent, /img|onerror|NaN|undefined/);
});

test("language changes abort the old request without losing the selected range or completed history", async () => {
  const env = environment(); env.active(true); env.controller.setWindow(24);
  env.language("it"); const translated = env.controller.relabel();
  assert.equal(env.calls.length, 2); assert.equal(env.calls[0].options.signal.aborted, true);
  env.calls[0].resolve(history(24, {points: []})); await settle(); assert.equal(env.dashboard.savedHistory, null);
  env.calls[1].resolve(history(24)); await translated;
  const saved = env.dashboard.savedHistory; env.language("en"); await env.controller.relabel();
  assert.equal(env.calls.length, 2); assert.equal(env.dashboard.savedHistory, saved); assert.equal(env.controller.hours, 24);
  assert.equal(env.dashboard.relabels, 2);
});

test("saved-history validation bounds seven days and preserves actual zero values while dropping invalid measurements", () => {
  const env = environment(), data = history(168, {points: [
    {sampled_at: 1000000 - 604800 - 1, cpu_percent: 90}, {sampled_at: 1000001, cpu_percent: 99},
    {sampled_at: 999970, cpu_percent: 0, memory_percent: "90", swap_percent: NaN, temperature_celsius: Infinity},
    {sampled_at: NaN, cpu_percent: 90}, {sampled_at: 1000000, cpu_percent: true, memory_percent: 100, swap_percent: 0, temperature_celsius: 40}]});
  const checked = env.checkedHistory(data, 168); assert.equal(checked.points.length, 2);
  assert.equal(checked.points[0].cpu_percent, 0); assert.equal(checked.points[0].memory_percent, null);
  assert.equal(checked.points[0].temperature_celsius, null); assert.equal(checked.points[1].cpu_percent, null);
  assert.equal(data.points[2].memory_percent, "90");
  for (const value of [null, history(6, {interval_seconds: 5}), history(6, {available: "true"}), history(6, {sampled_at: Infinity}), history(6, {points: Array(22001).fill(null)})]) assert.throws(() => env.checkedHistory(value, 6), /Saved history unavailable/);
});

test("the history controller adds no independent polling, persistent browser storage, HTML parsing or mutation request", () => {
  assert.doesNotMatch(source, /setInterval|localStorage|sessionStorage|innerHTML|insertAdjacentHTML|method\s*:\s*["'](?:POST|PUT|DELETE)/);
});

test("a readable history with unavailable sampling warns without discarding useful saved points", async () => {
  const env = environment(); env.active(true); const request = env.controller.open();
  env.calls[0].resolve(history(6, {sampling_available: false, stale: true})); await request;
  assert.equal(env.dashboard.savedHistory.sampling_available, false); assert.equal(env.dashboard.savedHistory.stale, true);
  assert.equal(env.dashboard.savedHistory.points[0].cpu_percent, 91); assert.equal(env.controller.error, false);
  assert.equal(env.dashboard.historyControls.status.textContent, "History collection is temporarily unavailable. Saved samples are still shown.");
  assert.doesNotMatch(env.dashboard.historyControls.status.textContent, /collected every/);
});

test("stale saved samples remain visible with an explicit warning rather than a claim of current collection", async () => {
  const env = environment(); env.active(true); const request = env.controller.open();
  env.calls[0].resolve(history(6, {sampling_available: true, stale: true})); await request;
  assert.equal(env.dashboard.savedHistory.sampling_available, true); assert.equal(env.dashboard.savedHistory.stale, true);
  assert.equal(env.dashboard.savedHistory.points.length, 1);
  assert.equal(env.dashboard.historyControls.status.textContent, "No recent saved sample. Check the recorder.");
  const refresh = env.controller.load(true); env.calls[1].resolve(history(6, {sampling_available: true, stale: false})); await refresh;
  assert.equal(env.dashboard.savedHistory.stale, false);
  assert.equal(env.dashboard.historyControls.status.textContent, "Saved samples are collected every 30 seconds.");
});
