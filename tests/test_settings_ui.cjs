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
  focus() {}
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const walk = (node) => [node, ...node.children.flatMap(walk)];

function environment() {
  const nodes = new Map(), calls = [], events = new Map(), emitted = [], blobs = new Map(), revoked = [], timers = [], downloads = [], storage = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = true;
  const tabs = ["general", "languages", "translations"].map((name) => Object.assign(new Element("button"), {dataset: {settingsTab: name}}));
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
  const defaultApi = async (path, options = {}) => {
    if (path === "/api/system") return {version: "0.5.0", disk: {free: 1e9}, segment_seconds: 1800};
    if (path === "/api/live/status") return {active_streams: 1, max_streams: 16, active_transcodes: 0, max_transcodes: 2};
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
  return {context, byId, calls, blobs, revoked, timers, downloads, storage, emitted, pack, file, choose, auth, button, stored, defaultApi,
    handler(value) { handler = value; }, refreshHandler(value) { refreshHandler = value; }, refreshCount: () => refreshCount};
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
