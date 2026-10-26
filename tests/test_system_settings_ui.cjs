"use strict";
// Only a fake API is available in this VM. These tests cannot restart a service or machine.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/system-settings.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

function environment() {
  const nodes = new Map(), events = new Map(), calls = [], scheduled = [];
  let language = "en", reloads = 0, activeElement = null;
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.open = false; this.value = ""; this.dataset = {}; this.listeners = new Map(); this.attributes = new Map(); this.focused = 0; }
    set textContent(value) { this.text = String(value); }
    get textContent() { return this.text || ""; }
    set innerHTML(_) { throw Error("Untrusted HTML insertion"); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    async fire(type, detail = {}) { const event = {type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...detail}; for (const listener of this.listeners.get(type) || []) await listener(event); return event; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    focus() { this.focused++; activeElement = this; }
  }
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = byId("settings-view").hidden = byId("settings-system-panel").hidden = true;
  const status = (extra = {}) => ({service_restart: true, system_reboot: true, target: "container", pending_action: null, retry_after: 0, delay_seconds: 5, reason: null, ...extra});
  let current = status();
  const defaultApi = async (path, options) => path === "/api/settings/system" ? current : {accepted: true, action: options.body.action, delay_seconds: 5, message: options.body.action === "restart-service" ? "The NVR service will restart in a few seconds." : "This system will reboot in a few seconds."};
  let handler = defaultApi;
  const translations = {"Restart the NVR service?": "Riavviare il servizio NVR?", "Reboot the recorder system?": "Riavviare il sistema del registratore?", "Local recorder machine": "Macchina locale del registratore"};
  const context = vm.createContext({console, AbortController, Promise,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    setTimeout(callback) { scheduled.push(callback); }, clearTimeout() {},
    api(path, options = {}) { calls.push({path, options}); return handler(path, options); },
  });
  context.window = context; context.location = {reload() { reloads++; }};
  context.document = {getElementById: byId, get activeElement() { return activeElement; }};
  context.NvrI18n = {ready: Promise.resolve(), t(key, params = {}) { return (language === "it" ? translations[key] || key : key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token); }};
  context.addEventListener = (type, listener) => { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); };
  const emit = (type, detail = {}) => { for (const listener of events.get(type) || []) listener({type, detail}); };
  context.dispatchEvent = (event) => { emit(event.type, event.detail); return true; };
  vm.runInContext(source, context, {filename: "system-settings.js"});
  return {byId, calls, context, scheduled, status, defaultApi, emit, reloads: () => reloads,
    handler(value) { handler = value; }, setStatus(value) { current = value; },
    async auth(value) { byId("app").hidden = !value; emit("nvr-authchange", {authenticated: value}); await flush(); },
    async open() { byId("settings-view").hidden = byId("settings-system-panel").hidden = false; emit("nvr-settings-tabchange", {tab: "system"}); await flush(); },
    async language(value) { language = value; emit("nvr-languagechange"); await flush(); },
    async submit() { return byId("system-confirm-form").fire("submit"); },
  };
}
const posts = (env) => env.calls.filter((call) => call.options.method === "POST");

test("archive and settings busy signals keep independent locks on maintenance actions", async () => {
  const env = environment(); await env.auth(true); await env.open();
  env.emit("nvr-archive-busychange", {busy: true});
  env.emit("nvr-settings-busychange", {busy: false});
  assert.equal(env.byId("system-restart-service").disabled, true);
  await env.byId("system-restart-service").fire("click");
  assert.equal(env.byId("system-confirm-dialog").open, false);
  env.emit("nvr-settings-busychange", {busy: true});
  env.emit("nvr-archive-busychange", {busy: false});
  assert.equal(env.byId("system-restart-service").disabled, true);
  env.emit("nvr-settings-busychange", {busy: false});
  assert.equal(env.byId("system-restart-service").disabled, false);
  assert.equal(posts(env).length, 0);
});

test("System loads availability only in an authenticated visible tab; unavailable capabilities cannot issue actions", async () => {
  const env = environment(); await flush(); assert.equal(env.calls.length, 0);
  env.emit("nvr-settings-tabchange", {tab: "system"}); await flush(); assert.equal(env.calls.length, 0);
  await env.auth(true); env.emit("nvr-settings-tabchange", {tab: "system"}); await flush(); assert.equal(env.calls.length, 0);
  const reason = "System maintenance is unavailable on this installation.";
  env.setStatus(env.status({service_restart: false, system_reboot: false, target: "unavailable", reason})); await env.open();
  assert.equal(env.calls.length, 1); assert.equal(env.calls[0].path, "/api/settings/system"); assert.ok(env.calls[0].options.signal);
  assert.equal(env.byId("system-reason").textContent, reason); assert.equal(env.byId("system-reason").hidden, false);
  assert.equal(env.byId("system-restart-service").disabled, true); assert.equal(env.byId("system-reboot-system").disabled, true);
  await env.byId("system-reboot-system").fire("click"); assert.equal(env.byId("system-confirm-dialog").open, false); assert.equal(posts(env).length, 0);
});

test("service restart uses two clicks; opening or cancelling never POSTs and the confirmation remains internal", async () => {
  const env = environment(); await env.auth(true); await env.open();
  await env.submit(); assert.equal(posts(env).length, 0);
  const button = env.byId("system-restart-service"); await button.fire("click");
  assert.equal(env.byId("system-confirm-dialog").open, true); assert.equal(env.byId("system-confirm-title").textContent, "Restart the NVR service?");
  assert.match(env.byId("system-confirm-description").textContent, /pause briefly/); assert.equal(env.byId("system-confirm-cancel").focused, 1);
  assert.equal(env.byId("system-confirm-submit").disabled, false);
  assert.equal(posts(env).length, 0); await env.byId("system-confirm-cancel").fire("click"); assert.equal(env.byId("system-confirm-dialog").open, false); assert.ok(button.focused);
  await button.fire("click"); await env.submit();
  assert.equal(posts(env).length, 1); assert.equal(posts(env)[0].path, "/api/settings/system/action");
  assert.equal(posts(env)[0].options.body.action, "restart-service"); assert.equal(posts(env)[0].options.body.confirmation, "RESTART");
  assert.equal(env.byId("system-confirm-dialog").open, false); assert.equal(env.byId("system-restart-service").disabled, true); assert.equal(env.byId("system-reboot-system").disabled, true);
  assert.equal(env.byId("system-wait-box").hidden, false); assert.equal(env.scheduled.length, 0); assert.equal(env.reloads(), 0);
});

test("reboot clearly targets the recorder machine; relabeling preserves the selected action and never sends it", async () => {
  const env = environment(); await env.auth(true); env.setStatus(env.status({target: "machine"})); await env.open();
  await env.byId("system-reboot-system").fire("click"); const before = env.calls.length;
  await env.language("it"); assert.equal(env.calls.length, before);
  assert.equal(env.byId("system-confirm-title").textContent, "Riavviare il sistema del registratore?"); assert.equal(env.byId("system-confirm-target").textContent, "Macchina locale del registratore");
  assert.equal(env.byId("system-confirm-submit").disabled, false); assert.equal(posts(env).length, 0);
  await env.submit(); assert.equal(posts(env).length, 1); assert.equal(posts(env)[0].options.body.action, "reboot-system"); assert.equal(posts(env)[0].options.body.confirmation, "REBOOT");
});

test("in-flight settings operations and repeated clicks cannot race a restart; an uncertain response is never retried", async () => {
  const env = environment(); await env.auth(true); await env.open();
  env.emit("nvr-settings-busychange", {busy: true}); await env.byId("system-restart-service").fire("click"); assert.equal(env.byId("system-confirm-dialog").open, false);
  env.emit("nvr-settings-busychange", {busy: false}); await env.byId("system-restart-service").fire("click");
  const response = deferred(); env.handler(() => response.promise); const saving = env.submit();
  await env.submit(); await env.byId("system-confirm-cancel").fire("click"); const escape = await env.byId("system-confirm-dialog").fire("cancel");
  assert.equal(escape.defaultPrevented, true); assert.equal(env.byId("system-confirm-dialog").open, true); assert.equal(env.byId("system-confirm-cancel").disabled, true); assert.equal(posts(env).length, 1);
  response.reject(Error("Cannot reach the server. Check your local network connection.")); await saving; await flush();
  assert.equal(env.byId("system-confirm-dialog").open, false); assert.equal(env.byId("system-restart-service").disabled, true);
  assert.match(env.byId("system-notice").textContent, /not be sent again automatically/); assert.equal(posts(env).length, 1); assert.equal(env.scheduled.length, 0);
});

test("after an accepted action only manual read-only reconnect and explicit page reload are offered", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.byId("system-restart-service").fire("click"); await env.submit();
  await env.byId("system-reload").fire("click"); assert.equal(env.reloads(), 0);
  await env.byId("system-reconnect").fire("click");
  assert.equal(env.calls.at(-1).path, "/api/settings/system"); assert.equal(env.calls.at(-1).options.method, undefined);
  assert.equal(env.byId("system-reload").disabled, false); assert.equal(env.byId("system-restart-service").disabled, true);
  await env.byId("system-reboot-system").fire("click"); assert.equal(posts(env).length, 1);
  await env.byId("system-reload").fire("click"); assert.equal(env.reloads(), 1); assert.equal(env.scheduled.length, 0);
});

test("availability errors and malformed capabilities stay disabled and permit an explicit GET retry", async () => {
  const env = environment(); await env.auth(true); env.handler(async () => { throw Error("System status is unavailable. Check the connection and try again."); }); await env.open();
  assert.equal(env.byId("system-error").hidden, false); assert.equal(env.byId("system-restart-service").disabled, true);
  env.handler(async () => env.status({pending_action: "__proto__"})); await env.byId("system-refresh").fire("click");
  assert.equal(env.byId("system-restart-service").disabled, true); assert.match(env.byId("system-error").textContent, /System status/);
  env.handler(env.defaultApi); await env.byId("system-refresh").fire("click"); assert.equal(env.byId("system-error").hidden, true); assert.equal(env.byId("system-restart-service").disabled, false); assert.equal(posts(env).length, 0);
});

test("a command scheduled by another session locks controls until the recorder returns", async () => {
  const env = environment(); await env.auth(true); env.setStatus(env.status({pending_action: "reboot-system", retry_after: 60})); await env.open();
  assert.equal(env.byId("system-wait-box").hidden, false); assert.equal(env.byId("system-reload").disabled, true); assert.equal(env.byId("system-reboot-system").disabled, true);
  await env.byId("system-reconnect").fire("click"); assert.equal(env.byId("system-reload").disabled, true);
  env.setStatus(env.status()); await env.byId("system-reconnect").fire("click"); assert.equal(env.byId("system-reload").disabled, false); assert.equal(posts(env).length, 0);
});

test("newer availability requests win and leaving System or logging out aborts late requests", async () => {
  const env = environment(); await env.auth(true); const old = deferred(), latest = deferred(); let count = 0;
  env.handler(() => ++count === 1 ? old.promise : latest.promise); await env.open(); const signal = env.calls[0].options.signal;
  const retry = env.byId("system-refresh").fire("click"); assert.equal(signal.aborted, true);
  latest.resolve(env.status({service_restart: false, system_reboot: false, reason: "Unavailable"})); await retry;
  old.resolve(env.status()); await flush(); assert.equal(env.byId("system-restart-service").disabled, true);
  const pending = deferred(); env.handler(() => pending.promise); const check = env.byId("system-refresh").fire("click");
  env.emit("nvr-settings-tabchange", {tab: "general"}); assert.equal(env.calls.at(-1).options.signal.aborted, true);
  await env.auth(false); pending.resolve(env.status()); await check; assert.equal(env.byId("system-target").textContent, "—"); assert.equal(env.byId("system-error").hidden, true);
});

test("an old session's accepted response cannot close or unlock a new session's confirmation", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.byId("system-restart-service").fire("click");
  const old = deferred(), latest = deferred(); let writes = 0;
  env.handler((path, options) => path === "/api/settings/system/action" ? (++writes === 1 ? old.promise : latest.promise) : env.defaultApi(path, options));
  const first = env.submit(); const firstSignal = posts(env)[0].options.signal;
  await env.auth(false); assert.equal(firstSignal.aborted, true); assert.equal(env.byId("system-confirm-dialog").open, false);
  await env.auth(true); await env.open(); await env.byId("system-reboot-system").fire("click"); const second = env.submit();
  old.resolve({accepted: true, action: "restart-service", delay_seconds: 5}); await first;
  assert.equal(env.byId("system-confirm-dialog").open, true); assert.equal(env.byId("system-confirm-cancel").disabled, true); assert.equal(env.byId("system-notice").hidden, true);
  latest.resolve({accepted: true, action: "reboot-system", delay_seconds: 5}); await second;
  assert.equal(env.byId("system-confirm-dialog").open, false); assert.equal(env.byId("system-wait-box").hidden, false); assert.equal(posts(env).length, 2);
});

test("server reason text remains inert and the native confirmation has accessible markup and correct script order", async () => {
  const env = environment(); await env.auth(true); const markup = '<img src=x onerror="throw Error(1)">'; env.setStatus(env.status({reason: markup})); await env.open();
  assert.equal(env.byId("system-reason").textContent, markup);
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  assert.match(html, /<dialog id="system-confirm-dialog"[^>]+aria-labelledby="system-confirm-title"[^>]+aria-describedby="system-confirm-description"/);
  assert.doesNotMatch(html, /id="system-confirm-(input|hint)"/); assert.doesNotMatch(source, /system-confirm-(input|hint)|Type \{word\} to confirm/);
  for (const id of ["system-restart-service", "system-reboot-system", "system-reconnect", "system-reload"]) assert.match(html, new RegExp('<button id="' + id + '" type="button"'));
  const assets = [...html.matchAll(/(?:href|src)="(\/static\/[^\"]+)"/g)].map((match) => match[1]);
  const version = readFileSync(join(__dirname, "../pyproject.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
  assert.ok(assets.every((asset) => asset.endsWith(`?v=${version}`)));
  assert.ok(html.indexOf("/static/app.js") < html.indexOf("/static/system-settings.js")); assert.ok(html.indexOf("/static/system-settings.js") < html.indexOf("/static/settings.js"));
});
