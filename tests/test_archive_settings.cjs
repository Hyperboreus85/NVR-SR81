"use strict";
// The isolated VM provides only a fake API. No real recording files can be deleted.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/archive-settings.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

function environment() {
  const nodes = new Map(), listeners = new Map(), calls = [], events = [], timers = [];
  let language = "en", activeElement = null;
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.open = false; this.value = ""; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.focused = 0; }
    set textContent(value) { this.text = String(value); }
    get textContent() { return this.text || ""; }
    set innerHTML(_) { throw Error("HTML insertion forbidden"); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    async fire(type, details = {}) { const event = {type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...details}; for (const listener of this.listeners.get(type) || []) await listener(event); return event; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    focus() { this.focused++; activeElement = this; }
  }
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = byId("settings-view").hidden = byId("settings-system-panel").hidden = true;
  const status = (extra = {}) => ({recordings_count: 20, recordings_bytes: 2.5e9, clearing: false, ...extra});
  const result = (extra = {}) => ({deleted_files: 40, deleted_recordings: 20, deleted_bytes: 2.5e9, skipped_files: 0, ...extra});
  let current = status();
  const defaultApi = async (path) => path === "/api/settings/archive" ? current : result();
  let handler = defaultApi;
  const translations = {"Delete all recordings": "Elimina tutte le registrazioni", "Archive ready": "Archivio pronto"};
  const context = vm.createContext({console, AbortController, Promise,
    setTimeout(callback) { timers.push(callback); }, setInterval(callback) { timers.push(callback); }, clearTimeout() {}, clearInterval() {},
    api(path, options = {}) { calls.push({path, options}); return handler(path, options); },
  });
  context.window = context;
  context.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail || {}; } };
  context.document = {getElementById: byId, get activeElement() { return activeElement; }};
  context.NvrI18n = {ready: Promise.resolve(), locale: () => language === "it" ? "it-IT" : "en-GB", t(key, params = {}) { return (language === "it" ? translations[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token); }};
  context.addEventListener = (type, listener) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); };
  context.dispatchEvent = (event) => { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); return true; };
  const emit = (type, detail = {}) => context.dispatchEvent(new context.CustomEvent(type, {detail}));
  vm.runInContext(source, context, {filename: "archive-settings.js"});
  return {context, byId, calls, events, timers, status, result, defaultApi, emit,
    handler(value) { handler = value; }, setStatus(value) { current = value; },
    async auth(value) { byId("app").hidden = !value; emit("nvr-authchange", {authenticated: value}); await flush(); },
    async open() { byId("settings-view").hidden = byId("settings-system-panel").hidden = false; emit("nvr-settings-tabchange", {tab: "system"}); await flush(); },
    async confirm() { await byId("archive-clear-open").fire("click"); },
    async submit() { return byId("archive-clear-form").fire("submit"); },
    async language(value) { language = value; emit("nvr-languagechange"); await flush(); },
  };
}
const posts = (env) => env.calls.filter((call) => call.options.method === "POST");
const busyEvents = (env) => env.events.filter((event) => event.type === "nvr-archive-busychange").map((event) => event.detail.busy);

test("archive counts load only for an authenticated System tab, independently of maintenance capabilities", async () => {
  const env = environment(); await flush(); assert.equal(env.calls.length, 0); assert.equal(env.byId("archive-count").textContent, "—");
  env.emit("nvr-settings-tabchange", {tab: "system"}); await flush(); assert.equal(env.calls.length, 0);
  await env.auth(true); await env.context.NvrArchiveSettings.open(); assert.equal(env.calls.length, 0);
  await env.open(); assert.equal(env.calls.length, 1); assert.equal(env.calls[0].path, "/api/settings/archive"); assert.ok(env.calls[0].options.signal);
  assert.equal(env.byId("archive-count").textContent, "20"); assert.equal(env.byId("archive-bytes").textContent, "2.5 GB");
  assert.equal(env.byId("archive-clear-open").disabled, false); assert.equal(posts(env).length, 0);
  assert.equal(env.calls.some((call) => call.path.includes("/settings/system")), false);
});

test("archive deletion uses two clicks; a fresh summary and cancellation never perform the deletion", async () => {
  const env = environment(); await env.auth(true); await env.open(); env.setStatus(env.status({recordings_count: 21, recordings_bytes: 3e9})); await env.confirm();
  assert.equal(env.calls.length, 2); assert.equal(env.byId("archive-clear-dialog").open, true);
  assert.equal(env.byId("archive-confirm-count").textContent, "21"); assert.equal(env.byId("archive-confirm-bytes").textContent, "3 GB"); assert.ok(env.byId("archive-clear-cancel").focused);
  assert.equal(posts(env).length, 0); assert.equal(env.events.filter((event) => event.type === "nvr-archive-beforeclear").length, 0); assert.equal(env.byId("archive-clear-submit").disabled, false);
  await env.byId("archive-clear-cancel").fire("click"); assert.equal(env.byId("archive-clear-dialog").open, false); assert.ok(env.byId("archive-clear-open").focused);
  await env.submit(); assert.equal(posts(env).length, 0);
  await env.confirm(); const escaped = await env.byId("archive-clear-dialog").fire("cancel"); assert.equal(escaped.defaultPrevented, false); assert.equal(posts(env).length, 0);
});

test("one confirmed request reports actual deleted bytes and skipped files, emits refresh, and performs only one follow-up GET", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm();
  env.handler(async (path) => {
    if (path === "/api/settings/archive/clear") {
      assert.equal(env.events.filter((event) => event.type === "nvr-archive-beforeclear").length, 1);
      return env.result({deleted_files: 39, deleted_recordings: 19, skipped_files: 1});
    }
    return env.status({recordings_count: 1, recordings_bytes: 1e8});
  });
  const before = env.calls.length; await env.submit();
  assert.equal(posts(env).length, 1); assert.equal(posts(env)[0].path, "/api/settings/archive/clear"); assert.equal(posts(env)[0].options.body.confirmation, "DELETE"); assert.ok(posts(env)[0].options.signal);
  assert.equal(env.calls.length, before + 2); assert.equal(env.calls.at(-1).path, "/api/settings/archive"); assert.equal(env.calls.at(-1).options.method, undefined);
  assert.equal(env.byId("archive-clear-dialog").open, false); assert.match(env.byId("archive-settings-notice").textContent, /Deleted 19 recordings and 39 files \(2.5 GB\)/);
  assert.match(env.byId("archive-skipped").textContent, /1 files could not be removed/); assert.equal(env.byId("archive-count").textContent, "1");
  const events = env.events.filter((event) => event.type === "nvr-archive-cleared"); assert.equal(events.length, 1); assert.equal(events[0].detail.deleted_recordings, 19); assert.equal(events[0].detail.skipped_files, 1);
  assert.deepEqual(busyEvents(env), [true, false]); assert.equal(env.timers.length, 0);
});

test("submitting locks duplicate clicks and native dialog cancellation, without extra busy feedback events", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm();
  const pending = deferred(); env.handler((path) => path === "/api/settings/archive/clear" ? pending.promise : env.defaultApi(path)); const sending = env.submit();
  assert.equal(env.byId("archive-clear-submit").disabled, true); assert.equal(env.byId("archive-clear-cancel").disabled, true); assert.equal(env.byId("archive-refresh").disabled, true);
  await env.submit(); await env.byId("archive-clear-cancel").fire("click"); const escaped = await env.byId("archive-clear-dialog").fire("cancel");
  assert.equal(escaped.defaultPrevented, true); assert.equal(env.byId("archive-clear-dialog").open, true); assert.equal(posts(env).length, 1);
  assert.equal(env.events.filter((event) => event.type === "nvr-archive-beforeclear").length, 1);
  env.emit("nvr-settings-busychange", {busy: true}); env.emit("nvr-settings-busychange", {busy: false}); env.context.NvrArchiveSettings.relabel(); assert.deepEqual(busyEvents(env), [true]);
  pending.resolve(env.result()); await sending; assert.deepEqual(busyEvents(env), [true, false]);
});

test("other settings or maintenance operations block archive mutation without echoing external busy state", async () => {
  const env = environment(); await env.auth(true); await env.open();
  for (const event of ["nvr-settings-busychange", "nvr-system-busychange"]) {
    env.emit(event, {busy: true}); await env.confirm(); assert.equal(env.byId("archive-clear-dialog").open, false); assert.equal(env.byId("archive-clear-open").disabled, true);
    env.emit(event, {busy: false}); assert.equal(env.byId("archive-clear-open").disabled, false);
  }
  assert.deepEqual(busyEvents(env), []); await env.confirm(); env.emit("nvr-system-busychange", {busy: true}); await env.submit(); assert.equal(posts(env).length, 0);
});

test("a safe 409 refusal remains visible and requires status refresh before another explicit confirmation", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm();
  const reason = 'A recording is in use. Stop playback before deleting recordings.';
  env.handler(async () => { throw Object.assign(Error(reason), {status: 409}); }); await env.submit();
  assert.equal(posts(env).length, 1); assert.equal(env.byId("archive-clear-dialog").open, true); assert.equal(env.byId("archive-confirm-error").textContent, reason);
  assert.equal(env.byId("archive-clear-submit").disabled, true); assert.match(env.byId("archive-confirm-notice").textContent, /was refused/); await env.submit(); assert.equal(posts(env).length, 1); assert.deepEqual(busyEvents(env), [true, false]);
  env.handler(env.defaultApi); await env.byId("archive-confirm-refresh").fire("click"); assert.equal(env.calls.at(-1).options.method, undefined);
  assert.equal(env.byId("archive-confirm-error").hidden, true); assert.equal(env.byId("archive-clear-submit").disabled, false); assert.equal(posts(env).length, 1); await env.submit(); assert.equal(posts(env).length, 2);
});

test("network loss or malformed success is never retried; manual GET recovery requires a new explicit confirmation", async () => {
  for (const fail of [async () => { throw Error("Cannot reach the server."); }, async () => ({deleted_recordings: 20}), async () => { throw Object.assign(Error("Cleanup unavailable."), {status: 503}); }]) {
    const env = environment(); await env.auth(true); await env.open(); await env.confirm(); env.handler(fail); await env.submit();
    assert.equal(posts(env).length, 1); assert.equal(env.byId("archive-clear-dialog").open, true);
    assert.match(env.byId("archive-confirm-notice").textContent, /not be sent again automatically/); assert.equal(env.byId("archive-clear-open").disabled, true); assert.deepEqual(busyEvents(env), [true]); await env.submit(); await env.confirm(); await flush(); assert.equal(posts(env).length, 1); assert.equal(env.timers.length, 0);
    env.handler(async () => env.status({clearing: true})); await env.byId("archive-confirm-refresh").fire("click");
    assert.equal(env.byId("archive-clear-submit").disabled, true); assert.deepEqual(busyEvents(env), [true]);
    env.handler(env.defaultApi); await env.byId("archive-confirm-refresh").fire("click"); assert.deepEqual(busyEvents(env), [true, false]);
    assert.equal(env.byId("archive-clear-submit").disabled, false);
    assert.match(env.byId("archive-confirm-notice").textContent, /previous request outcome is unknown/); assert.equal(posts(env).length, 1);
  }
});

test("cleanup started elsewhere disables commands until a manual status check confirms it finished", async () => {
  const env = environment(); await env.auth(true); env.setStatus(env.status({clearing: true})); await env.open();
  assert.equal(env.byId("archive-clear-open").disabled, true); assert.match(env.byId("archive-status").textContent, /in progress/); assert.deepEqual(busyEvents(env), [true]);
  await env.confirm(); assert.equal(env.byId("archive-clear-dialog").open, false); assert.equal(posts(env).length, 0);
  env.setStatus(env.status({recordings_count: 0, recordings_bytes: 0})); await env.byId("archive-refresh").fire("click");
  assert.equal(env.byId("archive-count").textContent, "0"); assert.equal(env.byId("archive-bytes").textContent, "0 B"); assert.equal(env.byId("archive-clear-open").disabled, false); assert.deepEqual(busyEvents(env), [true, false]);
});

test("status errors and nonfinite or incomplete counts stay unknown and allow read-only retry", async () => {
  const env = environment(); await env.auth(true);
  for (const value of [null, env.status({recordings_count: -1}), env.status({recordings_bytes: Infinity}), env.status({clearing: "false"})]) {
    env.handler(async () => value); await env.open(); assert.equal(env.byId("archive-clear-open").disabled, true); assert.equal(env.byId("archive-count").textContent, "—"); assert.equal(env.byId("archive-settings-error").hidden, false);
    assert.doesNotMatch(env.byId("archive-status").textContent, /NaN|Infinity|undefined/);
  }
  env.handler(env.defaultApi); await env.byId("archive-refresh").fire("click"); assert.equal(env.byId("archive-clear-open").disabled, false); assert.equal(env.byId("archive-settings-error").hidden, true); assert.equal(posts(env).length, 0);
});

test("language changes preserve the confirmation dialog, summary and pending state without API calls", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm(); const count = env.calls.length; await env.language("it");
  assert.equal(env.calls.length, count); assert.equal(env.byId("archive-clear-dialog").open, true); assert.equal(posts(env).length, 0);
  assert.equal(env.byId("archive-clear-submit").textContent, "Elimina tutte le registrazioni"); assert.equal(env.byId("archive-confirm-bytes").textContent, "2,5 GB"); assert.equal(env.byId("archive-clear-submit").disabled, false);
});

test("newest status wins and leaving the tab prevents a late summary request from opening a dialog", async () => {
  const env = environment(); await env.auth(true); const older = deferred(), newer = deferred(); let reads = 0;
  env.handler(() => ++reads === 1 ? older.promise : newer.promise); await env.open(); const firstSignal = env.calls[0].options.signal;
  const refresh = env.byId("archive-refresh").fire("click"); assert.equal(firstSignal.aborted, true); newer.resolve(env.status({recordings_count: 5})); await refresh;
  older.resolve(env.status({recordings_count: 99})); await flush(); assert.equal(env.byId("archive-count").textContent, "5");
  const pending = deferred(); env.handler(() => pending.promise); const opening = env.confirm();
  env.byId("settings-system-panel").hidden = true; env.emit("nvr-settings-tabchange", {tab: "general"}); assert.equal(env.calls.at(-1).options.signal.aborted, true);
  pending.resolve(env.status()); await opening; assert.equal(env.byId("archive-clear-dialog").open, false); assert.equal(posts(env).length, 0);
});

test("logout aborts stale requests and an old session cannot close or unlock a new session's pending confirmation", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm();
  const old = deferred(), latest = deferred(); let writes = 0;
  env.handler((path) => path === "/api/settings/archive/clear" ? (++writes === 1 ? old.promise : latest.promise) : env.defaultApi(path)); const first = env.submit(); const firstSignal = posts(env)[0].options.signal;
  await env.auth(false); assert.equal(firstSignal.aborted, true); assert.equal(env.byId("archive-clear-dialog").open, false); assert.equal(env.byId("archive-count").textContent, "—");
  await env.auth(true); await env.open(); await env.confirm(); const second = env.submit();
  old.resolve(env.result()); await first; assert.equal(env.byId("archive-clear-dialog").open, true); assert.equal(env.byId("archive-clear-cancel").disabled, true); assert.equal(env.byId("archive-settings-notice").hidden, true);
  assert.equal(env.events.filter((event) => event.type === "nvr-archive-cleared").length, 0);
  latest.resolve(env.result()); await second; assert.equal(env.byId("archive-clear-dialog").open, false); assert.equal(env.events.filter((event) => event.type === "nvr-archive-cleared").length, 1);
});

test("server errors stay inert, and the dedicated accessible dialog keeps the compact header and local script order", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.confirm(); const text = '<img src=x onerror="bad()">';
  env.handler(async () => { throw Object.assign(Error(text), {status: 409}); }); await env.submit(); assert.equal(env.byId("archive-confirm-error").textContent, text);
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8"), css = readFileSync(join(__dirname, "../nvr/static/style.css"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]); assert.equal(ids.length, new Set(ids).size);
  assert.match(html, /id="archive-error" class="inline-error"/); assert.match(html, /id="archive-settings-error" class="banner error"/);
  assert.match(html, /<dialog id="archive-clear-dialog"[^>]*aria-labelledby="archive-clear-title"[^>]*aria-describedby="archive-confirm-description"/);
  assert.doesNotMatch(html, /id="archive-confirm-(input|hint)"/); assert.doesNotMatch(source, /archive-confirm-(input|hint)|Type \{word\} to confirm/);
  assert.match(html, /This cannot be undone\. Camera settings are preserved; the disk is not formatted\./);
  assert.match(css, /dialog\.modal \.modal-heading\{[^}]*height:20px!important/);
  assert.ok(html.indexOf('id="archive-settings"') > html.indexOf('id="settings-system-panel"'));
  assert.ok(html.indexOf("/static/app.js") < html.indexOf("/static/archive-settings.js")); assert.ok(html.indexOf("/static/archive-settings.js") < html.indexOf("/static/settings.js"));
  assert.doesNotMatch(source, /\bfetch\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|innerHTML|insertAdjacentHTML|localStorage|sessionStorage/);
});
