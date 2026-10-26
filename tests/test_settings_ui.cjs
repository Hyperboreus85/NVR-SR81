"use strict";
// Isolated controller tests: no browser, network, server service or real files.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/settings.js"), "utf8");

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.value = ""; this.hidden = false; this.disabled = false;
    this.classList = {toggle() {}};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((item) => item.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion is forbidden"); }
  append(...children) { this.text = ""; for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  async fire(type, event = {}) { for (const listener of this.listeners.get(type) || []) await listener({type, target: this, preventDefault() {}, ...event}); }
  click() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
  focus() { this.focused = (this.focused || 0) + 1; }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const walk = (node) => [node, ...node.children.flatMap(walk)];

test("archive and maintenance operations block settings writes without feeding their own busy state back", async () => {
  const env = environment();
  await env.auth(true);
  const emit = (type, busy) => env.context.dispatchEvent(new env.context.CustomEvent(type, {detail: {busy}}));
  emit("nvr-archive-busychange", true);
  assert.equal(env.byId("settings-pack-template").disabled, true);
  emit("nvr-system-busychange", true);
  emit("nvr-archive-busychange", false);
  assert.equal(env.byId("settings-pack-template").disabled, true);
  emit("nvr-system-busychange", false);
  assert.equal(env.byId("settings-pack-template").disabled, false);
});

function environment() {
  const nodes = new Map(), calls = [], events = new Map(), emitted = [], blobs = new Map(), revoked = [], timers = [], downloads = [], storage = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = true;
  const tabs = ["general", "languages", "recording", "system", "users"].map((name) => Object.assign(new Element("button"), {dataset: {settingsTab: name}}));
  const panels = tabs.map((item) => Object.assign(new Element(), {dataset: {settingsPanel: item.dataset.settingsTab}}));
  const keys = ["Hello", "Device {number}", "Empty"];
  const pack = (locale = "fr", translations = {Hello: "Bonjour"}, extra = {}) => ({format: "nvr-sr81.language-pack", version: 1, locale, name: "French", native_name: "Français", translations, ...extra});
  const includedIt = pack("it", {Hello: "Ciao", "Device {number}": "Dispositivo {number}"}, {name: "Italian", native_name: "Italiano"});
  const stored = new Map([["en", {pack: pack("en", Object.fromEntries(keys.map((key) => [key, key])), {name: "English", native_name: "English"}), source: "included"}], ["it", {pack: includedIt, source: "included"}]]);
  let language = "en", refreshCount = 0, refreshHandler = null;
  const metadata = (entry) => ({locale: entry.pack.locale, name: entry.pack.name, native_name: entry.pack.native_name, source: entry.source, translated: Object.values(entry.pack.translations).filter((value) => value.trim()).length, total: keys.length});
  const languages = () => [...stored.values()].map(metadata);
  const context = vm.createContext({console, Blob, Intl, setTimeout(callback) { timers.push(callback); return timers.length; },
    URL: {createObjectURL(blob) { const key = "blob:pack-" + blobs.size; blobs.set(key, blob); return key; }, revokeObjectURL(key) { revoked.push(key); }},
    localStorage: {getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)},
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  });
  context.window = context;
  let actor = {id: "builtin-admin", role: "admin", builtin: true, permissions: []};
  context.NvrAccess = {can: (name) => actor?.role === "admin" || actor?.permissions.includes(name) === true, isAdmin: () => actor?.role === "admin", user: () => actor,
    storageKey: (key) => actor?.builtin ? key : key + ".user." + (actor?.id || "anonymous")};
  context.confirm = () => true;
  context.addEventListener = (type, callback) => { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); };
  context.dispatchEvent = (event) => { emitted.push(event); for (const callback of events.get(event.type) || []) callback(event); return true; };
  context.document = {getElementById: byId, body: new Element("body"), createElement(tag) { const node = new Element(tag); if (tag === "a") node.click = () => downloads.push({href: node.href, filename: node.download}); return node; }, querySelectorAll(selector) { return selector === "[data-settings-tab]" ? tabs : selector === "[data-settings-panel]" ? panels : []; }};
  context.NvrI18n = {
    ready: Promise.resolve(), getLanguage: () => language, locale: () => language,
    getSourceKeys: () => keys, getEntries: () => keys.map((key) => ({key, translation: key})), getLanguages: languages,
    t(key, params = {}) { let text = language === "en" ? String(key) : stored.get(language)?.pack.translations[key] || String(key); return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token); },
    async setLanguage(value) { if (!stored.has(value)) throw Error("Unsupported language"); language = value; context.dispatchEvent({type: "nvr-languagechange"}); return value; },
    async refreshLanguages() { refreshCount++; if (refreshHandler) await refreshHandler(); if (!stored.has(language)) language = "en"; context.dispatchEvent({type: "nvr-languageschange"}); context.dispatchEvent({type: "nvr-languagechange"}); return languages(); },
  };
  const allowedMinutes = [1, 2, 3, 4, 5, ...Array.from({length: 23}, (_, index) => (index + 2) * 5)];
  let currentMinutes = 30;
  const recordingSettings = (minutes = currentMinutes) => ({segment_seconds: minutes * 60, segment_minutes: minutes, allowed_minutes: allowedMinutes, recommended_minutes: 30, scope: "all_cameras"});
  const defaultApi = async (path, options = {}) => {
    if (path === "/api/system") return {version: "0.5.0", disk: {free: 1e9}, segment_seconds: 1800};
    if (path === "/api/live/status") return {active_streams: 1, max_streams: 16, active_transcodes: 0, max_transcodes: 2};
    if (path === "/api/settings/recording") {
      if (options.method !== "PUT") return recordingSettings();
      const value = options.body?.segment_minutes;
      if (!Number.isInteger(value) || !allowedMinutes.includes(value)) throw Error("Choose one of the supported recording durations.");
      const changed = currentMinutes !== value; currentMinutes = value;
      return {...recordingSettings(), changed};
    }
    if (path === "/api/languages/template") return pack("xx", Object.fromEntries(keys.map((key) => [key, key])), {name: "Language name", native_name: "Native language name"});
    if (path === "/api/languages/install") {
      const incoming = JSON.parse(options.rawBody.replace(/^\uFEFF/, ""));
      const replaced = stored.has(incoming.locale); const entry = {pack: incoming, source: "installed"}; stored.set(incoming.locale, entry);
      return {language: metadata(entry), replaced};
    }
    const locale = decodeURIComponent(path.slice("/api/languages/".length));
    if (options.method === "DELETE") { if (locale === "it") stored.set("it", {pack: includedIt, source: "included"}); else stored.delete(locale); return {locale, restored: locale === "it"}; }
    if (stored.has(locale)) return stored.get(locale).pack;
    throw Error("Language pack not found.");
  };
  let handler = defaultApi;
  context.api = (path, options = {}) => { calls.push({path, options}); return handler(path, options); };
  vm.runInContext(source, context, {filename: "settings.js"});
  const auth = async (value) => { byId("app").hidden = !value; context.dispatchEvent({type: "nvr-authchange", detail: {authenticated: value}}); await flush(); };
  const file = (raw, name = "fr.json") => ({name, size: Buffer.byteLength(raw, "utf8"), text: async () => raw});
  const choose = async (value) => { byId("settings-pack-file").files = value ? [value] : []; await byId("settings-pack-file").fire("change"); };
  const button = (locale, action, container = "settings-pack-list") => walk(byId(container)).find((item) => item.dataset.locale === locale && item.dataset.action === action);
  return {context, byId, calls, tabs, panels, blobs, revoked, timers, downloads, storage, emitted, pack, file, choose, auth, button, stored, defaultApi, recordingSettings,
    handler(value) { handler = value; }, refreshHandler(value) { refreshHandler = value; }, refreshCount: () => refreshCount,
    access(value) { actor = value; context.dispatchEvent(new context.CustomEvent("nvr-accesschange")); }};
}

test("choosing a BOM JSON file only stages it; Install sends the exact original raw text and exposes the new language", async () => {
  const env = environment(); await env.auth(true);
  const raw = "\uFEFF" + JSON.stringify(env.pack(), null, 2) + "\n";
  await env.choose(env.file(raw));
  assert.equal(env.calls.length, 0); assert.equal(env.byId("settings-pack-preview").hidden, false);
  assert.equal(env.byId("settings-pack-name").textContent, "Français"); assert.equal(env.byId("settings-pack-locale").textContent, "fr");
  assert.equal(env.byId("settings-pack-coverage").textContent, "1 / 3 strings"); assert.equal(env.byId("settings-pack-install").disabled, false);
  await env.byId("settings-pack-install").fire("click");
  const post = env.calls.find((call) => call.options.method === "POST");
  assert.equal(post.path, "/api/languages/install"); assert.equal(post.options.rawBody, raw); assert.equal(post.options.body, undefined);
  assert.equal(env.byId("settings-pack-preview").hidden, true); assert.equal(env.byId("settings-pack-install").disabled, true);
  assert.deepEqual(env.byId("settings-language").children.map((item) => item.textContent), ["English", "Italiano", "Français"]);
  assert.equal(env.byId("login-language").children.at(-1).value, "fr");
  await env.button("fr", "use", "settings-language-list").fire("click"); assert.equal(env.context.NvrI18n.getLanguage(), "fr");
});

test("file validation rejects malformed, oversized, immutable, unknown-key and placeholder-changing packs without any write", async () => {
  const env = environment(); await env.auth(true); let reads = 0;
  const invalid = [
    {size: 512 * 1024 + 1, text: async () => { reads++; return "{}"; }}, env.file("broken JSON"),
    env.file(JSON.stringify(env.pack("en"))), env.file(JSON.stringify(env.pack("../fr"))),
    env.file(JSON.stringify(env.pack("fr-12"))),
    env.file(JSON.stringify(env.pack("fr", {Unknown: "value"}))), env.file(JSON.stringify(env.pack("fr", {Hello: 42}))),
    env.file(JSON.stringify(env.pack("fr", {"Device {number}": "Device"}))),
    env.file(JSON.stringify(env.pack("fr", {Hello: "x".repeat(2001)}))),
    env.file(JSON.stringify({...env.pack(), unexpected: true})),
  ];
  for (const candidate of invalid) { await env.choose(candidate); assert.equal(env.byId("settings-error").hidden, false); assert.equal(env.byId("settings-pack-install").disabled, true); }
  assert.equal(reads, 0); assert.equal(env.calls.length, 0);
  await env.choose(env.file(JSON.stringify(env.pack("fr-Latn-FR-variant-extra", {"Device {number}": "   "}))));
  assert.equal(env.byId("settings-pack-install").disabled, false); assert.equal(env.byId("settings-pack-coverage").textContent, "0 / 3 strings");
});

test("duplicate-field server validation receives unmodified JSON and transient install errors allow an explicit retry", async () => {
  const env = environment(); await env.auth(true);
  const raw = JSON.stringify(env.pack()).replace('"name":"French"', '"name":"Old","name":"French"');
  await env.choose(env.file(raw));
  env.handler(async (path, options) => { assert.equal(options.rawBody, raw); throw Error("Duplicate fields are not allowed in a language pack."); });
  await env.byId("settings-pack-install").fire("click");
  assert.match(env.byId("settings-error").textContent, /Duplicate fields/); assert.equal(env.byId("settings-pack-install").disabled, false);
  env.handler(env.defaultApi); await env.byId("settings-pack-install").fire("click");
  assert.equal(env.calls.filter((call) => call.options.method === "POST").length, 2); assert.ok(env.button("fr", "download"));
});

test("latest file wins even when older reads complete first or after the new selection", async () => {
  const env = environment(); await env.auth(true); const old = deferred(), next = deferred();
  const first = env.choose({name: "old.json", size: 100, text: () => old.promise});
  const second = env.choose({name: "new.json", size: 100, text: () => next.promise});
  old.resolve(JSON.stringify(env.pack("fr", {Hello: "Old"}, {native_name: "Old name"}))); await first;
  assert.equal(env.byId("settings-pack-install").disabled, true); assert.equal(env.byId("settings-pack-preview").getAttribute("aria-busy"), "true");
  next.resolve(JSON.stringify(env.pack("fr", {Hello: "New"}, {native_name: "New name"}))); await second;
  assert.equal(env.byId("settings-pack-name").textContent, "New name");
  const late = deferred(), pending = env.choose({size: 100, text: () => late.promise});
  await env.choose(env.file(JSON.stringify(env.pack("fr", {Hello: "Newest"}, {native_name: "Newest name"}))));
  late.resolve(JSON.stringify(env.pack("fr", {Hello: "Stale"}))); await pending;
  assert.equal(env.byId("settings-pack-name").textContent, "Newest name");
});

test("mutation busy state prevents duplicate install, remove and file replacement", async () => {
  const env = environment(); await env.auth(true); await env.choose(env.file(JSON.stringify(env.pack())));
  const response = deferred(); env.handler(() => response.promise);
  const pending = env.byId("settings-pack-install").fire("click");
  assert.equal(env.byId("settings-pack-file").disabled, true); assert.equal(env.byId("settings-pack-template").disabled, true);
  await env.byId("settings-pack-install").fire("click"); await env.choose(env.file(JSON.stringify(env.pack("de"))));
  assert.equal(env.calls.length, 1); assert.equal(env.byId("settings-pack-locale").textContent, "fr");
  response.reject(Error("Try again.")); await pending;
  assert.equal(env.byId("settings-pack-file").disabled, false); assert.equal(env.byId("settings-pack-install").disabled, false);
});

test("template and existing pack downloads preserve full schema and revoke object URLs", async () => {
  const env = environment(); await env.auth(true);
  await env.byId("settings-pack-template").fire("click"); await env.button("it", "download").fire("click");
  assert.deepEqual(env.calls.map((call) => call.path), ["/api/languages/template", "/api/languages/it"]);
  const files = await Promise.all([...env.blobs.values()].map(async (blob) => JSON.parse(await blob.text())));
  assert.equal(files[0].format, "nvr-sr81.language-pack"); assert.equal(files[0].locale, "xx"); assert.equal(files[1].locale, "it");
  assert.equal(env.downloads[0].filename, "nvr-sr81-language-template.json"); assert.equal(env.downloads[1].filename, "nvr-sr81-it.json");
  env.timers.forEach((callback) => callback()); assert.equal(env.revoked.length, 2);
});

test("removing an active installed language falls back to English; removing custom Italian restores the included pack", async () => {
  const env = environment(); await env.auth(true);
  await env.choose(env.file(JSON.stringify(env.pack()))); await env.byId("settings-pack-install").fire("click");
  await env.button("fr", "use", "settings-language-list").fire("click"); assert.equal(env.context.NvrI18n.getLanguage(), "fr");
  assert.equal(env.button("en", "remove"), undefined); assert.equal(env.button("it", "remove"), undefined);
  await env.button("fr", "remove").fire("click"); assert.equal(env.context.NvrI18n.getLanguage(), "en"); assert.equal(env.byId("login-language").value, "en"); assert.equal(env.button("fr", "download"), undefined);
  await env.choose(env.file(JSON.stringify(env.pack("it", {Hello: "Custom"}, {name: "Italian", native_name: "Italiano"})))); await env.byId("settings-pack-install").fire("click");
  assert.equal(env.button("it", "remove").textContent, "Restore included Italian");
  await env.button("it", "remove").fire("click"); assert.equal(env.stored.get("it").source, "included"); assert.equal(env.button("it", "remove"), undefined);
});

test("logout invalidates pending file reads, mutations, downloads and General responses", async () => {
  const env = environment(); await env.auth(true); const read = deferred();
  const selecting = env.choose({size: 100, text: () => read.promise}); await env.auth(false); read.resolve(JSON.stringify(env.pack())); await selecting;
  assert.equal(env.byId("settings-pack-preview").hidden, true); assert.equal(env.byId("settings-pack-install").disabled, true);
  await env.auth(true); await env.choose(env.file(JSON.stringify(env.pack()))); const post = deferred(); env.handler(() => post.promise);
  const installing = env.byId("settings-pack-install").fire("click"); await env.auth(false); post.resolve({language: {locale: "fr"}}); await installing;
  assert.equal(env.refreshCount(), 0); assert.equal(env.byId("settings-notice").hidden, true);
  await env.auth(true); const download = deferred(); env.handler(() => download.promise);
  const downloading = env.byId("settings-pack-template").fire("click"); await env.auth(false); download.resolve(env.pack()); await downloading;
  assert.equal(env.blobs.size, 0);
  await env.auth(true); const system = deferred(), live = deferred(); env.handler((path) => path === "/api/system" ? system.promise : live.promise);
  const opening = env.context.NvrSettings.open(); await env.auth(false); system.resolve({version: "Stale", disk: {free: 1}, segment_seconds: 60}); live.resolve({active_streams: 99}); await opening;
  assert.equal(env.byId("settings-version").textContent, "—"); assert.equal(env.byId("settings-live-streams").textContent, "—");
});

test("file metadata and translations containing HTML remain inert text", async () => {
  const env = environment(); await env.auth(true); const markup = '<img src=x onerror="throw Error(1)">';
  await env.choose(env.file(JSON.stringify(env.pack("fr", {Hello: markup}, {native_name: markup}))));
  assert.equal(env.byId("settings-pack-name").textContent, markup); assert.equal(env.byId("settings-pack-name").children.length, 0);
  await env.byId("settings-pack-install").fire("click");
  assert.ok(env.byId("settings-language-list").textContent.includes(markup));
  assert.equal(walk(env.byId("settings-language-list")).some((item) => item.tagName === "img"), false);
});

test("General reports the real 30-minute duration, layout preferences persist, and failed refresh can be retried", async () => {
  const env = environment(); await env.auth(true);
  assert.equal(env.byId("settings-monitor-layout").value, "4"); await env.context.NvrSettings.open();
  assert.equal(env.byId("settings-segment-duration").textContent, "30 minutes"); assert.equal(env.byId("settings-version").textContent, "0.5.0");
  env.byId("settings-monitor-layout").value = "16"; await env.byId("settings-monitor-layout").fire("change");
  assert.equal(env.storage.get("nvr.monitor.layout"), "16"); assert.equal(env.emitted.at(-1).detail.layout, 16);
  env.refreshHandler(async () => { throw Error("Language files are unavailable. Try again."); }); await env.context.NvrSettings.open(); assert.equal(env.byId("settings-error").hidden, false);
  env.refreshHandler(null); await env.context.NvrSettings.open(); assert.equal(env.byId("settings-error").hidden, true);
});

test("General shares current system resources without resetting drafts or accepting updates after logout", async () => {
  const env = environment(); await env.auth(true); await env.context.NvrSettings.open();
  env.byId("settings-recording-minutes").value = "60"; await env.byId("settings-recording-minutes").fire("change");
  const count = env.calls.length;
  env.context.NvrSettings.setSystemSnapshot({version:"0.13.0",disk:{recordings:{free:14.5e9}}});
  assert.equal(env.byId("settings-version").textContent,"0.13.0");
  assert.equal(env.byId("settings-disk-free").textContent,"14.5 GB");
  assert.equal(env.byId("settings-recording-minutes").value,"60");
  assert.equal(env.calls.length,count);
  await env.context.NvrSettings.open();
  assert.equal(env.byId("settings-disk-free").textContent,"14.5 GB");
  assert.equal(env.byId("settings-version").textContent,"0.13.0");
  env.context.NvrSettings.setSystemSnapshot(null);
  assert.equal(env.byId("settings-disk-free").textContent,"—");
  await env.auth(false);
  env.context.NvrSettings.setSystemSnapshot({version:"stale",disk:{recordings:{free:99e9}}});
  assert.equal(env.byId("settings-version").textContent,"—");
  assert.equal(env.byId("settings-disk-free").textContent,"—");
});

test("recording duration loads all server presets and only an explicit save applies a numeric duration", async () => {
  const env = environment(); await env.auth(true); await env.context.NvrSettings.open();
  const select = env.byId("settings-recording-minutes"), save = env.byId("settings-recording-form");
  assert.equal(select.value, "30"); assert.equal(select.disabled, false);
  assert.deepEqual(select.children.map((option) => Number(option.value)), env.recordingSettings().allowed_minutes);
  assert.equal(select.children.find((option) => option.value === "30").textContent, "30 minutes · recommended");
  assert.equal(select.children[0].textContent, "1 minute"); assert.equal(select.children.at(-1).value, "120");
  select.value = "60"; await select.fire("change");
  assert.equal(env.byId("settings-recording-status").textContent, "Unsaved changes");
  assert.equal(env.calls.filter((call) => call.options.method === "PUT").length, 0);
  await save.fire("submit");
  const put = env.calls.find((call) => call.options.method === "PUT");
  assert.equal(put.path, "/api/settings/recording"); assert.equal(put.options.body.segment_minutes, 60);
  assert.equal(typeof put.options.body.segment_minutes, "number");
  assert.equal(env.byId("settings-segment-duration").textContent, "60 minutes");
  assert.match(env.byId("settings-notice").textContent, /All cameras now use 60 minutes/);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-recording-settingschange").at(-1).detail.segment_seconds, 3600);
  assert.equal(env.byId("settings-recording-status").textContent, "Applies to all cameras");
  await save.fire("submit");
  assert.equal(env.byId("settings-notice").textContent, "Recording duration is already set to 60 minutes.");
});

test("non-preset environment durations are shown accurately and only supported integer choices can be saved", async () => {
  for (const seconds of [61, 660]) {
    const env = environment(); await env.auth(true);
    env.handler((path, options) => path === "/api/settings/recording" && options.method !== "PUT" ? {...env.recordingSettings(seconds / 60), segment_seconds: seconds} : env.defaultApi(path, options));
    await env.context.NvrSettings.open();
    const select = env.byId("settings-recording-minutes");
    assert.equal(select.children[0].textContent, `Current: ${seconds} seconds`); assert.equal(select.children[0].disabled, true);
    assert.equal(env.byId("settings-recording-save").disabled, true);
    for (const invalid of [String(seconds / 60), "0", "7", "121", "1.5", "1e1", "true", "", " 30"]) {
      select.value = invalid; await select.fire("change"); await env.byId("settings-recording-form").fire("submit");
      assert.equal(env.byId("settings-recording-save").disabled, true);
    }
    assert.equal(env.calls.some((call) => call.options.method === "PUT"), false);
    select.value = "1"; await select.fire("change"); await env.byId("settings-recording-form").fire("submit");
    assert.equal(env.byId("settings-segment-duration").textContent, "1 minute");
  }
});

test("a dirty recording choice survives language changes and a later background settings refresh", async () => {
  const env = environment(); await env.auth(true); await env.context.NvrSettings.open();
  const select = env.byId("settings-recording-minutes");
  select.value = "120"; await select.fire("change");
  env.stored.get("it").pack.translations["{count} minutes · recommended"] = "{count} minuti · consigliato";
  env.byId("settings-language").value = "it"; await env.byId("settings-language").fire("change");
  assert.equal(select.value, "120");
  assert.equal(select.children.find((option) => option.value === "30").textContent, "30 minuti · consigliato");
  const incoming = deferred();
  env.handler((path, options) => path === "/api/settings/recording" ? incoming.promise : env.defaultApi(path, options));
  const refreshing = env.context.NvrSettings.open(); await flush();
  env.context.dispatchEvent({type: "nvr-languagechange"}); assert.equal(select.value, "120");
  incoming.resolve(env.recordingSettings(75)); await refreshing;
  assert.equal(select.value, "120"); assert.equal(env.byId("settings-recording-status").textContent, "Unsaved changes");
  assert.equal(env.byId("settings-segment-duration").textContent, "75 minutes");
  assert.equal(env.calls.some((call) => call.options.method === "PUT"), false);
});

test("recording settings show a loading state, actionable initial errors and a retry without writing", async () => {
  const env = environment(); await env.auth(true); const pending = deferred();
  env.handler((path, options) => path === "/api/settings/recording" ? pending.promise : env.defaultApi(path, options));
  const opening = env.context.NvrSettings.open();
  assert.equal(env.byId("settings-recording-minutes").disabled, true);
  assert.equal(env.byId("settings-recording-save").disabled, true);
  assert.equal(env.byId("settings-recording-form").getAttribute("aria-busy"), "true");
  assert.equal(env.byId("settings-recording-status").textContent, "Loading recording settings…");
  await env.byId("settings-recording-form").fire("submit");
  pending.reject(Error("Recording settings are unavailable. Try again.")); await opening;
  assert.equal(env.byId("settings-recording-error").hidden, false); assert.equal(env.byId("settings-recording-retry").hidden, false);
  env.handler(env.defaultApi); await env.byId("settings-recording-retry").fire("click");
  assert.equal(env.byId("settings-recording-error").hidden, true); assert.equal(env.byId("settings-recording-retry").hidden, true);
  assert.equal(env.byId("settings-recording-minutes").value, "30");
  assert.equal(env.calls.some((call) => call.options.method === "PUT"), false);
});

test("recording saves and language operations share a lock, and failed saves keep the editable draft", async () => {
  const env = environment(); await env.auth(true); await env.context.NvrSettings.open();
  await env.choose(env.file(JSON.stringify(env.pack())));
  const select = env.byId("settings-recording-minutes"); select.value = "90"; await select.fire("change");
  const response = deferred(); env.handler((path, options) => path === "/api/settings/recording" && options.method === "PUT" ? response.promise : env.defaultApi(path, options));
  const saving = env.byId("settings-recording-form").fire("submit");
  assert.equal(env.byId("settings-pack-install").disabled, true); assert.equal(env.byId("settings-pack-template").disabled, true);
  assert.equal(env.byId("settings-language").disabled, true); assert.equal(env.byId("login-language").disabled, true); assert.equal(select.disabled, true);
  await env.byId("settings-recording-form").fire("submit"); await env.byId("settings-pack-install").fire("click"); await env.byId("settings-pack-template").fire("click");
  env.byId("settings-language").value = "it"; await env.byId("settings-language").fire("change");
  assert.equal(env.context.NvrI18n.getLanguage(), "en");
  assert.equal(env.calls.filter((call) => call.options.method === "PUT").length, 1);
  assert.equal(env.calls.some((call) => call.options.method === "POST"), false);
  response.reject(Error("Recording settings could not be applied. Try again.")); await saving;
  assert.equal(select.value, "90"); assert.equal(select.disabled, false); assert.equal(env.byId("settings-recording-save").disabled, false);
  assert.match(env.byId("settings-recording-error").textContent, /could not be applied/); assert.equal(env.byId("settings-pack-install").disabled, false);
  const install = deferred(); env.handler(() => install.promise);
  const installing = env.byId("settings-pack-install").fire("click");
  await env.byId("settings-recording-form").fire("submit");
  assert.equal(env.calls.filter((call) => call.options.method === "PUT").length, 1);
  install.reject(Error("Temporary failure")); await installing;
  const language = deferred(), originalSetLanguage = env.context.NvrI18n.setLanguage;
  env.context.NvrI18n.setLanguage = async (value) => { await language.promise; return originalSetLanguage(value); };
  const switching = env.byId("settings-language").fire("change"); await env.byId("settings-recording-form").fire("submit");
  assert.equal(env.byId("settings-recording-save").disabled, true); assert.equal(env.calls.filter((call) => call.options.method === "PUT").length, 1);
  language.resolve(); await switching; assert.equal(select.value, "90");
});

test("logout discards delayed duration reads and old save completions cannot unlock a new session's save", async () => {
  const env = environment(); await env.auth(true); const initial = deferred();
  env.handler((path, options) => path === "/api/settings/recording" ? initial.promise : env.defaultApi(path, options));
  const opening = env.context.NvrSettings.open(); await env.auth(false); initial.resolve(env.recordingSettings(120)); await opening;
  assert.equal(env.byId("settings-recording-minutes").children.length, 0); assert.equal(env.byId("settings-segment-duration").textContent, "—");
  await env.auth(true); env.handler(env.defaultApi); await env.context.NvrSettings.open();
  const select = env.byId("settings-recording-minutes"); select.value = "60"; await select.fire("change");
  const old = deferred(), next = deferred(); let writes = 0;
  env.handler((path, options) => path === "/api/settings/recording" && options.method === "PUT" ? (++writes === 1 ? old.promise : next.promise) : env.defaultApi(path, options));
  const first = env.byId("settings-recording-form").fire("submit"); await env.auth(false); await env.auth(true); await env.context.NvrSettings.open();
  select.value = "90"; await select.fire("change"); const second = env.byId("settings-recording-form").fire("submit");
  old.resolve({...env.recordingSettings(60), changed: true}); await first;
  assert.equal(select.value, "90"); assert.equal(env.byId("settings-recording-save").disabled, true);
  assert.equal(env.byId("settings-notice").hidden, true); assert.equal(env.emitted.some((event) => event.type === "nvr-recording-settingschange"), false);
  next.resolve({...env.recordingSettings(90), changed: true}); await second;
  assert.equal(env.byId("settings-segment-duration").textContent, "90 minutes"); assert.equal(env.byId("settings-recording-save").disabled, false);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-recording-settingschange").length, 1);
});

test("a pre-save General response cannot overwrite the newly applied duration", async () => {
  const env = environment(); await env.auth(true); const previousSystem = deferred();
  env.handler((path, options) => path === "/api/system" ? previousSystem.promise : env.defaultApi(path, options));
  const opening = env.context.NvrSettings.open(); await flush();
  const select = env.byId("settings-recording-minutes"); select.value = "60"; await select.fire("change");
  await env.byId("settings-recording-form").fire("submit");
  previousSystem.resolve({version: "Stale", segment_seconds: 1800, disk: {free: 1}}); await opening;
  assert.equal(env.byId("settings-segment-duration").textContent, "60 minutes"); assert.equal(select.value, "60");
});

test("the recorder updates its duration immediately and ignores an older in-flight system response", async () => {
  const appSource = readFileSync(join(__dirname, "../nvr/static/app.js"), "utf8");
  const refreshSource = appSource.slice(appSource.indexOf("async function refreshData("), appSource.indexOf("\nfunction renderStats("));
  const listenerSource = appSource.slice(appSource.indexOf('window.addEventListener("nvr-recording-settingschange"'), appSource.indexOf('window.addEventListener("nvr-languagechange"'));
  const previousSystem = deferred(), listeners = new Map(), displayed = [];
  const state = {authenticated: true, authEpoch: 1, system: {segment_seconds: 1800}, cameras: [], selectedId: null, recordingSettingsRevision: 0, recordingDuration: null};
  const context = vm.createContext({state, network: {view: "settings"},
    api: (path) => path === "/api/system" ? previousSystem.promise : Promise.resolve([]),
    renderCameras() {}, renderSelected() {}, renderStats() {}, ensureLiveLayout() { return null; }, errorText: String,
    applyGeneralPreferences() {}, applyAccess() {}, can: () => true,
    renderSystem() { displayed.push(state.system.segment_seconds); },
    window: {addEventListener(type, listener) { listeners.set(type, listener); }},
  });
  vm.runInContext(refreshSource + "\n" + listenerSource, context);
  const refreshing = context.refreshData(false);
  listeners.get("nvr-recording-settingschange")({detail: {segment_seconds: 3600}});
  assert.equal(state.system.segment_seconds, 3600); assert.equal(displayed.at(-1), 3600);
  previousSystem.resolve({segment_seconds: 1800, recordings_bytes: 999}); await refreshing;
  assert.equal(state.system.segment_seconds, 3600); assert.equal(state.system.recordings_bytes, 999);
  state.authenticated = false;
  listeners.get("nvr-recording-settingschange")({detail: {segment_seconds: 7200}});
  assert.equal(state.system.segment_seconds, 3600);
});

test("topbar Settings tabs retain keyboard navigation, active state and an unsaved recording draft", async () => {
  const env = environment(); await env.auth(true); await env.context.NvrSettings.open();
  await env.tabs[2].fire("click");
  env.byId("settings-recording-minutes").value = "60"; await env.byId("settings-recording-minutes").fire("change");
  const requests = env.calls.length;
  await env.tabs[2].fire("keydown", {key: "ArrowRight"});
  assert.equal(env.tabs[3].getAttribute("aria-selected"), "true"); assert.equal(env.tabs[3].tabIndex, 0); assert.ok(env.tabs[3].focused);
  assert.equal(env.panels[3].hidden, false); assert.equal(env.panels[2].hidden, true);
  await env.tabs[3].fire("keydown", {key: "ArrowRight"}); assert.equal(env.tabs[4].getAttribute("aria-selected"), "true");
  await env.tabs[4].fire("keydown", {key: "ArrowRight"}); assert.equal(env.tabs[0].getAttribute("aria-selected"), "true");
  await env.tabs[0].fire("keydown", {key: "End"}); assert.equal(env.tabs[4].getAttribute("aria-selected"), "true");
  await env.tabs[4].fire("keydown", {key: "Home"}); assert.equal(env.tabs[0].getAttribute("aria-selected"), "true");
  await env.tabs[0].fire("keydown", {key: "ArrowLeft"}); assert.equal(env.tabs[4].getAttribute("aria-selected"), "true");
  await env.tabs[4].fire("keydown", {key: "ArrowLeft"}); assert.equal(env.tabs[3].getAttribute("aria-selected"), "true");
  await env.tabs[3].fire("keydown", {key: "ArrowLeft"}); assert.equal(env.tabs[2].getAttribute("aria-selected"), "true");
  assert.equal(env.byId("settings-recording-minutes").value, "60"); assert.equal(env.calls.length, requests);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-settings-tabchange").at(-1).detail.tab, "recording");
});

test("restricted Settings tabs skip forbidden reads and keyboard navigation ignores hidden admin or recorder tabs", async () => {
  const env = environment(); env.access({id: "maintainer", role: "user", permissions: ["maintenance"]}); await env.auth(true); await env.context.NvrSettings.open();
  assert.deepEqual(env.tabs.filter((button) => !button.hidden).map((button) => button.dataset.settingsTab), ["system"]);
  assert.equal(env.calls.some((call) => ["/api/system", "/api/live/status", "/api/settings/recording"].includes(call.path)), false);
  await env.tabs[3].fire("keydown", {key: "ArrowRight"}); assert.equal(env.tabs[3].getAttribute("aria-selected"), "true");
  assert.equal(env.byId("settings-pack-template").disabled, true); assert.equal(env.byId("settings-pack-management").hidden, true);
  env.access({id: "preferences", role: "user", permissions: ["settings"]}); env.calls.length = 0; await env.context.NvrSettings.open();
  assert.deepEqual(env.tabs.filter((button) => !button.hidden).map((button) => button.dataset.settingsTab), ["general", "languages", "recording"]);
  assert.equal(env.calls.some((call) => call.path === "/api/system" || call.path === "/api/live/status"), false);
  assert.equal(env.calls.some((call) => call.path === "/api/settings/recording"), true);
  env.access(null); env.calls.length = 0; await env.context.NvrSettings.open();
  assert.equal(env.tabs.every((button) => button.hidden), true); assert.equal(env.panels.every((panel) => panel.hidden), true); assert.equal(env.calls.length, 0);
});

test("monitor preferences use the current account storage key and Users mutations lock writes without feedback", async () => {
  const env = environment(); await env.auth(true); env.access({id: "custom-admin", role: "admin", permissions: []});
  env.byId("settings-monitor-layout").value = "9"; await env.byId("settings-monitor-layout").fire("change");
  assert.equal(env.storage.get("nvr.monitor.layout.user.custom-admin"), "9"); assert.equal(env.storage.has("nvr.monitor.layout"), false);
  env.context.dispatchEvent(new env.context.CustomEvent("nvr-users-busychange", {detail: {busy: true}}));
  assert.equal(env.byId("settings-pack-template").disabled, true);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-settings-busychange").at(-1).detail.busy, false);
  env.context.dispatchEvent(new env.context.CustomEvent("nvr-users-busychange", {detail: {busy: false}})); assert.equal(env.byId("settings-pack-template").disabled, false);
});

test("Settings has General, Languages, Recording, System and admin-only Users, with JSON controls confined to Languages", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  const stack = [], elements = [], ids = new Map();
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const token of html.matchAll(/<(\/?)([a-z][\w:-]*)([^>]*?)>/gi)) {
    const tag = token[2].toLowerCase();
    if (token[1]) {
      assert.equal(stack.at(-1)?.tag, tag, "Unbalanced HTML while locating Settings controls");
      stack.pop();
      continue;
    }
    const attributes = Object.fromEntries([...token[3].matchAll(/([a-z][\w-]*)="([^"]*)"/gi)].map((match) => [match[1], match[2]]));
    const entry = {tag, attributes, ancestors: stack.map((item) => item.attributes.id).filter(Boolean)};
    elements.push(entry);
    if (attributes.id) {
      assert.equal(ids.has(attributes.id), false, "Duplicate ID: " + attributes.id);
      ids.set(attributes.id, entry);
    }
    if (!voidTags.has(tag) && !/\/\s*$/.test(token[3])) stack.push(entry);
  }
  assert.equal(stack.length, 0);
  assert.deepEqual(elements.filter((item) => item.attributes["data-settings-tab"]).map((item) => item.attributes["data-settings-tab"]), ["general", "languages", "recording", "system", "users"]);
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>') + '</header>'.length);
  assert.ok(topbar.includes('id="settings-subnav"')); assert.equal(ids.get("settings-subnav").attributes.role, "tablist");
  assert.equal(ids.get("settings-subnav").ancestors.includes("settings-view"), false);
  assert.equal(html.includes('class="settings-tabs"'), false);
  for (const name of ["general", "languages", "recording", "system", "users"]) {
    const button = ids.get("settings-tab-" + name), panel = ids.get("settings-" + name + "-panel");
    assert.ok(button.ancestors.includes("settings-subnav")); assert.equal(button.attributes.role, "tab");
    assert.equal(button.attributes["aria-controls"], panel.attributes.id); assert.equal(panel.attributes["aria-labelledby"], button.attributes.id);
  }
  assert.deepEqual(elements.filter((item) => item.attributes["data-settings-panel"]).map((item) => item.attributes["data-settings-panel"]), ["general", "languages", "recording", "system", "users"]);
  for (const id of ["settings-language", "settings-language-list", "settings-pack-file", "settings-pack-preview", "settings-pack-name", "settings-pack-locale", "settings-pack-coverage", "settings-pack-install", "settings-pack-selection", "settings-pack-template", "settings-pack-list"]) {
    assert.ok(ids.get(id)?.ancestors.includes("settings-languages-panel"), id + " must belong to the Languages page");
  }
  assert.equal(ids.get("settings-pack-file").attributes.type, "file");
  assert.match(ids.get("settings-pack-file").attributes.accept, /json/);
  for (const id of ["settings-recording-form", "settings-recording-minutes", "settings-recording-save", "settings-recording-status", "settings-recording-error", "settings-recording-retry"]) assert.ok(ids.get(id)?.ancestors.includes("settings-recording-panel"), id + " must belong to Recording");
  assert.equal(ids.get("settings-recording-save").attributes.type, "submit");
  assert.equal(ids.get("settings-recording-minutes").tag, "select");
  for (const id of ["settings-translations-panel", "settings-translation-search", "settings-translations-list", "settings-translations-save", "settings-translations-reset", "settings-translations-import", "settings-translations-export"]) assert.equal(ids.has(id), false);
  assert.equal(elements.some((item) => item.tag === "textarea" && item.ancestors.includes("settings-languages-panel")), false, "Languages must install files rather than edit individual translations");
});
