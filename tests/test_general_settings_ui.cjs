"use strict";
// Real controller, simulated DOM/API only: no recorder or operating-system settings are changed.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/general-settings.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function environment() {
  const nodes = new Map(), listeners = new Map(), calls = [], emitted = [], storage = [];
  let language = "en";
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.hidden = false; this.disabled = false; this.open = false; this.value = ""; this.dataset = {}; this.listeners = new Map(); this.attributes = new Map(); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map((node) => node.textContent).join(""); }
    set innerHTML(_) { throw Error("HTML insertion forbidden"); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.text = ""; this.children = [...nodes]; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    async fire(type) { for (const listener of this.listeners.get(type) || []) await listener({target: this, type, preventDefault() {}}); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
  }
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = byId("settings-view").hidden = byId("settings-general-panel").hidden = true;
  const record = (extra = {}) => ({recorder_name: "nvr-host", timezone: "auto", hour_format: "24", rotation_seconds: 0,
    allowed_rotation_seconds: [0, 15, 30, 60, 120, 300], timezones: ["UTC", "Europe/Rome", "America/New_York", "Europe/London"],
    system: {hostname: "nvr-host", addresses: ["192.0.2.20", "2001:db8::20"], timezone: "Europe/Rome", country_codes: ["IT"], source: "system"},
    effective_timezone: "Europe/Rome", country_codes: ["IT"], ...extra});
  let current = record();
  const defaultApi = async (path, options) => {
    assert.equal(path, "/api/settings/general");
    if (options.method !== "PUT") return current;
    const request = options.body, effective = request.timezone === "auto" ? current.system.timezone : request.timezone;
    current = record({...request, recorder_name: request.recorder_name || current.system.hostname, effective_timezone: effective,
      country_codes: effective === "UTC" ? [] : effective === "America/New_York" ? ["US"] : effective === "Europe/London" ? ["GB"] : ["IT"]});
    return current;
  };
  let handler = defaultApi;
  const translations = {"Automatic (system)": "Automatico (sistema)", "Off": "Disattivata", "Every {count} seconds": "Ogni {count} secondi", "Save general settings": "Salva impostazioni generali", "Available after saving.": "Disponibile dopo il salvataggio."};
  const context = vm.createContext({console, AbortController, Promise, Intl,
    api(path, options = {}) { calls.push({path, options}); return handler(path, options); },
    localStorage: {setItem(...args) { storage.push(args); }},
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  });
  context.window = context; context.document = {getElementById: byId, createElement: (tag) => new Element(tag)};
  context.NvrI18n = {ready: Promise.resolve(), locale: () => language, t(key, params = {}) { return (language === "it" ? translations[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token); }};
  context.addEventListener = (type, listener) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); };
  context.dispatchEvent = (event) => { emitted.push(event); for (const listener of listeners.get(event.type) || []) listener(event); return true; };
  const emit = (type, detail = {}) => context.dispatchEvent(new context.CustomEvent(type, {detail}));
  vm.runInContext(source, context, {filename: "general-settings.js"});
  return {byId, calls, emitted, storage, record, context, defaultApi, emit,
    handler(value) { handler = value; }, setCurrent(value) { current = value; },
    async auth(value) { byId("app").hidden = !value; emit("nvr-authchange", {authenticated: value}); await flush(); },
    async open() { byId("settings-view").hidden = byId("settings-general-panel").hidden = false; emit("nvr-settings-tabchange", {tab: "general"}); await flush(); },
    async change(id, value) { byId(id).value = value; await byId(id).fire(id === "general-recorder-name" ? "input" : "change"); },
    async save() { return byId("general-settings-form").fire("submit"); },
    async language(value) { language = value; emit("nvr-languagechange"); await flush(); },
  };
}
const writes = (env) => env.calls.filter((call) => call.options.method === "PUT");
const busy = (env) => env.emitted.filter((event) => event.type === "nvr-general-busychange").map((event) => event.detail.busy);

test("General loads only on an authenticated visible tab and shows actual identity and initial off/24-hour preferences", async () => {
  const env = environment(); await flush(); assert.equal(env.calls.length, 0);
  assert.equal(env.byId("general-hostname").textContent, "—"); assert.equal(env.byId("general-recorder-name").disabled, true);
  env.emit("nvr-settings-tabchange", {tab: "general"}); await flush(); assert.equal(env.calls.length, 0);
  await env.auth(true); await env.context.NvrGeneralSettings.open(); assert.equal(env.calls.length, 0);
  await env.open(); assert.equal(env.calls.length, 1); assert.ok(env.calls[0].options.signal);
  assert.equal(env.byId("general-recorder-name").value, "nvr-host"); assert.equal(env.byId("general-hostname").textContent, "nvr-host");
  assert.equal(env.byId("general-addresses").textContent, "192.0.2.20 · 2001:db8::20"); assert.equal(env.byId("general-country").textContent, "Italy");
  assert.equal(env.byId("general-timezone").value, "auto"); assert.equal(env.byId("general-hour-format").value, "24"); assert.equal(env.byId("general-rotation").value, "0");
  assert.deepEqual(env.byId("general-rotation").children.map((node) => node.value), ["0", "15", "30", "60", "120", "300"]);
  assert.equal(env.byId("general-save").disabled, true); await env.save(); assert.equal(writes(env).length, 0);
});

test("only Save writes the four editable fields, never hostname/IP, and announces normalized effective settings", async () => {
  const env = environment(); await env.auth(true); await env.open();
  await env.change("general-recorder-name", "  Warehouse  "); await env.change("general-timezone", "America/New_York"); await env.change("general-hour-format", "12"); await env.change("general-rotation", "30");
  assert.equal(writes(env).length, 0); assert.equal(env.byId("general-country").textContent, "Available after saving.");
  assert.equal(env.byId("general-save").disabled, false); await env.save();
  assert.equal(writes(env).length, 1); assert.deepEqual(Object.keys(writes(env)[0].options.body).sort(), ["hour_format", "recorder_name", "rotation_seconds", "timezone"]);
  assert.equal(writes(env)[0].options.body.recorder_name, "Warehouse"); assert.equal(writes(env)[0].options.body.rotation_seconds, 30);
  assert.equal(env.byId("general-recorder-name").value, "Warehouse"); assert.equal(env.byId("general-country").textContent, "United States");
  const event = env.emitted.find((event) => event.type === "nvr-general-settingschange"); assert.equal(event.detail.timezone, "America/New_York"); assert.equal(event.detail.effective_timezone, "America/New_York"); assert.equal(event.detail.hour_format, "12"); assert.equal(event.detail.rotation_seconds, 30);
  assert.equal(env.byId("general-save").disabled, true); assert.deepEqual(busy(env), [true, false]); assert.equal(env.storage.length, 0);
});

test("an empty alias resets through the server to the system hostname without editing that hostname", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.change("general-recorder-name", "   "); await env.save();
  assert.equal(writes(env)[0].options.body.recorder_name, ""); assert.equal(env.byId("general-recorder-name").value, "nvr-host"); assert.equal(env.byId("general-hostname").textContent, "nvr-host");
});

test("an unknown system hostname loads the recorder fallback and later missing identity clears stale text without changing a draft", async () => {
  const env = environment(); await env.auth(true);
  const data = env.record(); data.recorder_name = "NVR-SR81"; data.system.hostname = null; data.system.addresses = ["192.0.2.45"];
  env.setCurrent(data); await env.open();
  assert.equal(env.byId("general-recorder-name").value, "NVR-SR81"); assert.equal(env.byId("general-hostname").textContent, "—");
  assert.equal(env.byId("general-recorder-name").placeholder, "NVR-SR81"); assert.equal(env.byId("general-addresses").textContent, "192.0.2.45");
  assert.equal(env.byId("general-recorder-name").disabled, false); assert.equal(env.byId("general-error").hidden, true);
  await env.change("general-recorder-name", "Unsaved alias");
  env.context.NvrGeneralSettings.setIdentity({identity: {hostname: "known-host", addresses: ["192.0.2.50"]}});
  assert.equal(env.byId("general-hostname").textContent, "known-host");
  env.context.NvrGeneralSettings.setIdentity({identity: {hostname: null, addresses: ["2001:db8::50"]}});
  assert.equal(env.byId("general-hostname").textContent, "—"); assert.equal(env.byId("general-addresses").textContent, "2001:db8::50");
  assert.equal(env.byId("general-recorder-name").placeholder, "NVR-SR81"); assert.equal(env.byId("general-recorder-name").value, "Unsaved alias");
  assert.equal(env.byId("general-save").disabled, false); assert.equal(writes(env).length, 0);
});

test("countries follow zone metadata, not IP or interface language; UTC and unmapped draft zones are explicit", async () => {
  const env = environment(); await env.auth(true); await env.open();
  await env.language("it"); assert.equal(env.byId("general-country").textContent, "Italia");
  env.context.NvrGeneralSettings.setIdentity({identity: {hostname: "new-host", addresses: ["203.0.113.4"]}});
  assert.equal(env.byId("general-country").textContent, "Italia"); assert.equal(env.byId("general-hostname").textContent, "new-host");
  await env.change("general-timezone", "UTC"); assert.equal(env.byId("general-country").textContent, "Disponibile dopo il salvataggio."); await env.save();
  assert.equal(env.byId("general-country").textContent, "No country for this time zone.");
  await env.change("general-timezone", "auto"); assert.equal(env.byId("general-country").textContent, "Italia");
});

test("drafts survive language changes, identity samples, tab reentry and later General refresh responses", async () => {
  const env = environment(); await env.auth(true); await env.open();
  await env.change("general-recorder-name", "Unsaved name"); await env.change("general-timezone", "Europe/London"); await env.change("general-hour-format", "12"); await env.change("general-rotation", "60");
  const count = env.calls.length; await env.language("it"); assert.equal(env.calls.length, count);
  env.context.NvrGeneralSettings.setIdentity({identity: {hostname: "latest-host", addresses: ["192.0.2.31"]}});
  await env.open(); assert.equal(env.byId("general-recorder-name").value, "Unsaved name"); assert.equal(env.byId("general-timezone").value, "Europe/London");
  assert.equal(env.byId("general-hour-format").value, "12"); assert.equal(env.byId("general-rotation").value, "60"); assert.equal(writes(env).length, 0);
  assert.equal(env.byId("general-hostname").textContent, "latest-host"); assert.equal(env.byId("general-save").disabled, false);
});

test("edits made while a read is pending win over that response without reissuing any write", async () => {
  const env = environment(); await env.auth(true); await env.open(); const pending = deferred(); env.handler(() => pending.promise);
  const reading = env.context.NvrGeneralSettings.open(); assert.equal(env.byId("general-recorder-name").disabled, false);
  await env.change("general-recorder-name", "Typed while reading"); pending.resolve(env.record({recorder_name: "Other browser"})); await reading;
  assert.equal(env.byId("general-recorder-name").value, "Typed while reading"); assert.equal(env.byId("general-save").disabled, false); assert.equal(writes(env).length, 0);
});

test("invalid names, unsupported zones, formats and rotation values never reach PUT", async () => {
  const env = environment(); await env.auth(true); await env.open();
  for (const [id, value, reset] of [["general-recorder-name", "x".repeat(81), "Name"], ["general-recorder-name", "bad\u0001name", "Name"], ["general-recorder-name", "bad\u202ename", "Name"], ["general-timezone", "Unknown/Zone", "auto"], ["general-hour-format", "13", "24"], ["general-rotation", "20", "0"], ["general-rotation", "15.5", "0"]]) {
    await env.change(id, value); assert.equal(env.byId("general-save").disabled, true); await env.save(); assert.equal(writes(env).length, 0); assert.equal(env.byId("general-error").hidden, false); await env.change(id, reset);
  }
});

test("cross-settings locks remain independent and do not echo as General submission busy events", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.change("general-recorder-name", "Pending");
  for (const event of ["nvr-settings-busychange", "nvr-system-busychange", "nvr-archive-busychange"]) {
    env.emit(event, {busy: true}); assert.equal(env.byId("general-save").disabled, true); await env.save(); assert.equal(writes(env).length, 0); env.emit(event, {busy: false});
  }
  env.emit("nvr-archive-busychange", {busy: true}); env.emit("nvr-system-busychange", {busy: true}); env.emit("nvr-archive-busychange", {busy: false});
  assert.equal(env.byId("general-save").disabled, true); env.emit("nvr-system-busychange", {busy: false}); assert.equal(env.byId("general-save").disabled, false); assert.deepEqual(busy(env), []);
});

test("one in-flight Save blocks duplicates, and a failed save keeps the draft for an explicit retry", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.change("general-recorder-name", "Retry name");
  const pending = deferred(); env.handler(() => pending.promise); const saving = env.save();
  assert.equal(env.byId("general-recorder-name").disabled, true); await env.save(); await env.context.NvrGeneralSettings.open(); assert.equal(writes(env).length, 1);
  pending.reject(Error("Cannot save right now.")); await saving;
  assert.equal(env.byId("general-recorder-name").value, "Retry name"); assert.equal(env.byId("general-save").disabled, false); assert.equal(env.byId("general-error").textContent, "Cannot save right now.");
  assert.deepEqual(busy(env), [true, false]); env.handler(env.defaultApi); await env.save(); assert.equal(writes(env).length, 2); assert.equal(env.byId("general-error").hidden, true);
});

test("malformed initial responses keep fields unavailable and a manual read-only retry recovers", async () => {
  const env = environment(); await env.auth(true);
  for (const data of [null, env.record({country_codes: ["XX<img>"]}), env.record({rotation_seconds: 99}), env.record({timezones: ["<script>"]}), env.record({system: null})]) {
    env.handler(async () => data); await env.open(); assert.equal(env.byId("general-save").disabled, true); assert.equal(env.byId("general-recorder-name").disabled, true); assert.equal(env.byId("general-retry").hidden, false);
  }
  env.handler(env.defaultApi); await env.byId("general-retry").fire("click"); assert.equal(env.byId("general-retry").hidden, true); assert.equal(env.byId("general-recorder-name").disabled, false); assert.equal(writes(env).length, 0);
});

test("latest read wins and leaving General aborts pending reads without dropping the unsaved draft", async () => {
  const env = environment(); await env.auth(true); const old = deferred(), latest = deferred(); let reads = 0; env.handler(() => ++reads === 1 ? old.promise : latest.promise);
  await env.open(); const first = env.calls[0].options.signal; const reading = env.context.NvrGeneralSettings.open(); assert.equal(first.aborted, true);
  latest.resolve(env.record({recorder_name: "Newest"})); await reading; old.resolve(env.record({recorder_name: "Old"})); await flush(); assert.equal(env.byId("general-recorder-name").value, "Newest");
  await env.change("general-recorder-name", "Keep draft"); const pending = deferred(); env.handler(() => pending.promise); const leaving = env.context.NvrGeneralSettings.open();
  env.byId("settings-general-panel").hidden = true; env.emit("nvr-settings-tabchange", {tab: "system"}); assert.equal(env.calls.at(-1).options.signal.aborted, true);
  pending.resolve(env.record()); await leaving; assert.equal(env.byId("general-recorder-name").value, "Keep draft");
});

test("logout clears identity and aborts requests; an old save completion cannot overwrite or unlock a new session", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.change("general-recorder-name", "Old session");
  const old = deferred(), latest = deferred(); let writesCount = 0;
  env.handler((path, options) => options.method === "PUT" ? (++writesCount === 1 ? old.promise : latest.promise) : env.defaultApi(path, options));
  const first = env.save(); const signal = writes(env)[0].options.signal; await env.auth(false); assert.equal(signal.aborted, true); assert.equal(env.byId("general-hostname").textContent, "—"); assert.equal(env.byId("general-recorder-name").value, "");
  env.context.NvrGeneralSettings.setIdentity({hostname: "logged-out", addresses: []}); assert.equal(env.byId("general-hostname").textContent, "—");
  await env.auth(true); await env.open(); await env.change("general-recorder-name", "New session"); const second = env.save();
  old.resolve(env.record({recorder_name: "Old session"})); await first; assert.equal(env.byId("general-recorder-name").value, "New session"); assert.equal(env.byId("general-recorder-name").disabled, true);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-general-settingschange").length, 0);
  latest.resolve(env.record({recorder_name: "New session"})); await second; assert.equal(env.byId("general-recorder-name").disabled, false); assert.equal(env.emitted.filter((event) => event.type === "nvr-general-settingschange").length, 1);
});

test("identity and names remain inert text; markup preserves legacy General IDs and provides only the four editable preferences", async () => {
  const env = environment(); await env.auth(true); env.setCurrent(env.record({recorder_name: '<img src=x onerror="bad()">', system: {hostname: "<script>bad()</script>", addresses: ["javascript:bad()"], timezone: "UTC", country_codes: [], source: "system"}})); await env.open();
  assert.equal(env.byId("general-recorder-name").value, '<img src=x onerror="bad()">'); assert.equal(env.byId("general-addresses").textContent, "javascript:bad()");
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  for (const id of ["settings-monitor-layout", "settings-version", "settings-disk-free", "settings-live-streams", "settings-live-transcodes", "settings-segment-duration", "general-settings-form", "general-hostname", "general-addresses", "general-country"]) assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1);
  assert.match(html, /<input id="general-recorder-name"[^>]*maxlength="80"/);
  assert.doesNotMatch(html, /<(input|select)[^>]*id="general-(hostname|addresses|country)"/);
  assert.ok(html.indexOf("/static/app.js") < html.indexOf("/static/general-settings.js")); assert.ok(html.indexOf("/static/general-settings.js") < html.indexOf("/static/settings.js"));
  assert.doesNotMatch(source, /\bfetch\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|localStorage|sessionStorage|innerHTML|insertAdjacentHTML|geolocation/);
});

test("actual General, System and Archive controllers share busy signals without feedback or overlapping writes", async () => {
  const env = environment(); env.byId("settings-system-panel").hidden = true;
  for (const filename of ["system-settings.js", "archive-settings.js"]) vm.runInContext(readFileSync(join(__dirname, "../nvr/static/", filename), "utf8"), env.context, {filename});
  const pending = deferred();
  env.handler(async (path, options) => {
    if (path === "/api/settings/general") return options.method === "PUT" ? pending.promise : env.record();
    if (path === "/api/settings/system") return {service_restart: true, system_reboot: true, target: "container", pending_action: null, retry_after: 0, delay_seconds: 5, reason: null};
    if (path === "/api/settings/archive") return {recordings_count: 20, recordings_bytes: 1e9, clearing: false};
    throw Error("No other mutation is expected in this test.");
  });
  await env.auth(true); env.byId("settings-view").hidden = false;
  env.byId("settings-general-panel").hidden = true; env.byId("settings-system-panel").hidden = false;
  env.emit("nvr-settings-tabchange", {tab: "system"}); await flush();
  assert.equal(env.byId("system-restart-service").disabled, false); assert.equal(env.byId("archive-clear-open").disabled, false);
  env.byId("settings-system-panel").hidden = true; await env.open(); await env.change("general-recorder-name", "Cross-module save");
  const saving = env.save();
  assert.equal(env.byId("system-restart-service").disabled, true); assert.equal(env.byId("archive-clear-open").disabled, true);
  await env.byId("system-restart-service").fire("click"); await env.byId("archive-clear-open").fire("click");
  assert.equal(env.byId("system-confirm-dialog").open, false); assert.equal(env.byId("archive-clear-dialog").open, false);
  assert.equal(env.calls.filter((call) => ["POST", "PUT"].includes(call.options.method)).length, 1);
  assert.deepEqual(busy(env), [true]); assert.equal(env.emitted.some((event) => ["nvr-system-busychange", "nvr-archive-busychange"].includes(event.type) && event.detail.busy), false);
  pending.resolve(env.record({recorder_name: "Cross-module save"})); await saving;
  assert.deepEqual(busy(env), [true, false]); assert.equal(env.byId("system-restart-service").disabled, false); assert.equal(env.byId("archive-clear-open").disabled, false);
});
