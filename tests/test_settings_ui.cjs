"use strict";
// Isolated DOM/API doubles: no browser, network, system service or real files.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync, readdirSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const staticDir = join(__dirname, "../nvr/static");

class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.value = ""; this.hidden = false; this.disabled = false;
    this.classList = {toggle() {}};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion is forbidden"); }
  append(...nodes) { this.text = ""; for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  async fire(type, event = {}) { for (const listener of this.listeners.get(type) || []) await listener({type, target: this, preventDefault() {}, ...event}); }
  click() { this.clicked = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  focus() {}
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function environment(overrides = {}) {
  const nodes = new Map(), calls = [], blobs = new Map(), revoked = [], timers = [], events = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = true;
  const tabs = ["general", "languages", "translations"].map((name) => Object.assign(new Element("button"), {dataset: {settingsTab: name}}));
  const panels = tabs.map((tab) => Object.assign(new Element(), {dataset: {settingsPanel: tab.dataset.settingsTab}}));
  const document = {
    getElementById: byId, createElement: (tag) => new Element(tag), body: new Element("body"), documentElement: {},
    querySelectorAll: (selector) => selector === "[data-settings-tab]" ? tabs : selector === "[data-settings-panel]" ? panels : [],
  };
  const storage = new Map();
  const context = vm.createContext({document, Blob, console, CustomEvent: class {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }, localStorage: {getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)},
  URL: {createObjectURL(blob) { const key = "blob:test-" + blobs.size; blobs.set(key, blob); return key; }, revokeObjectURL(key) { revoked.push(key); }},
  setTimeout: (callback) => { timers.push(callback); return timers.length; }});
  context.window = context;
  context.confirm = () => true;
  context.addEventListener = (type, listener) => { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); };
  context.dispatchEvent = (event) => { for (const listener of events.get(event.type) || []) listener(event); return true; };
  let handler = async (path, options) => {
    if (path === "/api/settings/translations") return {overrides: options?.method === "PUT" ? options.body.overrides : overrides};
    if (path === "/api/system") return {version: "0.4.0", disk: {free: 1000000}};
    if (path === "/api/live/status") return {active_streams: 1, max_streams: 16, active_transcodes: 0, max_transcodes: 2};
    throw Error("Unexpected test API path");
  };
  context.api = (path, options = {}) => { calls.push({path, options}); return handler(path, options); };
  for (const file of readdirSync(staticDir).filter((name) => /^locales-.*\.js$/.test(name)).sort())
    vm.runInContext(readFileSync(join(staticDir, file), "utf8"), context, {filename: file});
  for (const file of ["i18n.js", "settings.js"])
    vm.runInContext(readFileSync(join(staticDir, file), "utf8"), context, {filename: file});
  const auth = async (authenticated) => { context.dispatchEvent({type: "nvr-authchange", detail: {authenticated}}); await flush(); };
  const field = async (key) => {
    byId("settings-translation-search").value = key;
    await byId("settings-translation-search").fire("input");
    const row = byId("settings-translations-list").children.find((item) => item.children[0]?.children[1]?.textContent === key);
    assert.ok(row, "Missing translation row: " + key);
    return row.children[1].children[1];
  };
  const importFile = async (file) => { const input = byId("settings-translations-import"); input.files = [file]; await input.fire("change"); };
  const catalog = (translations) => JSON.stringify({locale: "it", translations});
  const file = (translations) => { const value = catalog(translations); return {size: Buffer.byteLength(value), text: async () => value}; };
  return {context, byId, calls, blobs, revoked, timers, auth, field, importFile, catalog, file,
    handler(value) { handler = value; }};
}

test("file import stages a draft, export includes it, and only Save persists/applies it", async () => {
  const env = environment(); await env.auth(true);
  await env.importFile(env.file({"English source": "Sorgente personalizzata"}));
  assert.equal(env.calls.filter((call) => call.options.method === "PUT").length, 0);
  assert.equal(env.context.NvrI18n.getOverrides()["English source"], undefined);
  assert.equal((await env.field("English source")).value, "Sorgente personalizzata");
  assert.equal(env.byId("settings-translations-save").disabled, false);
  assert.match(env.byId("settings-notice").textContent, /Import ready/);
  await env.byId("settings-translations-export").fire("click");
  const exported = JSON.parse(await [...env.blobs.values()][0].text());
  assert.equal(exported.locale, "it"); assert.equal(exported.translations["English source"], "Sorgente personalizzata");
  assert.equal(exported.translations["Device {number}"], "Dispositivo {number}");
  env.timers.forEach((callback) => callback()); assert.equal(env.revoked.length, 1);
  await env.byId("settings-translations-save").fire("click");
  const put = env.calls.find((call) => call.options.method === "PUT");
  assert.deepEqual({...put.options.body.overrides}, {"English source": "Sorgente personalizzata"});
  assert.equal(env.context.NvrI18n.getOverrides()["English source"], "Sorgente personalizzata");
  assert.equal(env.byId("settings-translations-save").disabled, true);
});

test("invalid catalog, oversized file, non-text values, unknown keys and changed placeholders leave drafts unchanged", async () => {
  const env = environment(); await env.auth(true);
  const field = await env.field("English source"); field.value = "Bozza conservata"; await field.fire("input");
  let reads = 0;
  const invalid = [
    {size: 512 * 1024 + 1, text: async () => { reads++; return "{}"; }},
    {size: 10, text: async () => "invalid JSON"},
    {size: 10, text: async () => JSON.stringify({locale: "en", translations: {}})},
    env.file({"English source": 42}), env.file({"English source": "x".repeat(2001)}),
    env.file({"Unknown and untrusted key": "value"}), env.file({"Device {number}": "Dispositivo"}),
  ];
  for (const file of invalid) {
    await env.importFile(file);
    assert.equal(env.byId("settings-error").hidden, false);
    assert.equal((await env.field("English source")).value, "Bozza conservata");
  }
  assert.equal(reads, 0, "Reject oversized files before reading them");
  assert.equal(env.calls.some((call) => call.options.method === "PUT"), false);
  await env.importFile(env.file({"Device {number}": "Dispositivo personalizzato {number}"}));
  assert.equal((await env.field("Device {number}")).value, "Dispositivo personalizzato {number}");
});

test("newer imports win and old completion cannot clear a newer import's busy state", async () => {
  const env = environment(); await env.auth(true);
  const old = deferred(), newer = deferred();
  const first = env.importFile({size: 100, text: () => old.promise});
  const second = env.importFile({size: 100, text: () => newer.promise});
  assert.equal(env.byId("settings-translations-list").getAttribute("aria-busy"), "true");
  assert.equal(env.byId("settings-translations-save").disabled, true);
  await env.byId("settings-translations-save").fire("click");
  assert.equal(env.calls.some((call) => call.options.method === "PUT"), false);
  old.resolve(env.catalog({"English source": "Old file"})); await first;
  assert.equal(env.byId("settings-translations-import").disabled, true);
  assert.equal(env.byId("settings-translations-list").getAttribute("aria-busy"), "true");
  newer.resolve(env.catalog({"English source": "New file"})); await second;
  assert.equal(env.byId("settings-translations-import").disabled, false);
  assert.equal((await env.field("English source")).value, "New file");
});

test("a late older import cannot overwrite a completed newer draft or its save", async () => {
  const env = environment(); await env.auth(true);
  const old = deferred();
  const pending = env.importFile({size: 100, text: () => old.promise});
  await env.importFile(env.file({"English source": "Newest draft"}));
  await env.byId("settings-translations-save").fire("click");
  old.resolve(env.catalog({"English source": "Stale draft"})); await pending;
  assert.equal((await env.field("English source")).value, "Newest draft");
  assert.equal(env.context.NvrI18n.getOverrides()["English source"], "Newest draft");
});

test("logout invalidates pending translation load, save, file import and system responses", async () => {
  const load = environment(), loadReply = deferred();
  load.handler(() => loadReply.promise);
  await load.auth(true); await load.auth(false);
  loadReply.resolve({overrides: {"English source": "Stale load"}}); await flush();
  assert.equal(Object.keys(load.context.NvrI18n.getOverrides()).length, 0);
  assert.equal(load.byId("settings-translations-save").disabled, true);

  const save = environment(); await save.auth(true);
  const field = await save.field("English source"); field.value = "Pending save"; await field.fire("input");
  const saveReply = deferred(); save.handler(() => saveReply.promise);
  const pendingSave = save.byId("settings-translations-save").fire("click"); await save.auth(false);
  saveReply.resolve({overrides: {"English source": "Stale save"}}); await pendingSave;
  assert.equal(Object.keys(save.context.NvrI18n.getOverrides()).length, 0);
  assert.equal(save.byId("settings-notice").hidden, true);

  const importing = environment(); await importing.auth(true);
  const importReply = deferred(), pendingImport = importing.importFile({size: 100, text: () => importReply.promise});
  await importing.auth(false); importReply.resolve(importing.catalog({"English source": "Stale file"})); await pendingImport;
  assert.equal(Object.keys(importing.context.NvrI18n.getOverrides()).length, 0);
  assert.equal(importing.byId("settings-translations-save").disabled, true);

  const system = environment(); await system.auth(true);
  const systemReply = deferred(), liveReply = deferred();
  system.handler((path) => path === "/api/system" ? systemReply.promise : liveReply.promise);
  const pendingOpen = system.context.NvrSettings.open(); await system.auth(false);
  systemReply.resolve({version: "stale-version", disk: {free: 123}}); liveReply.resolve({active_streams: 99}); await pendingOpen;
  assert.equal(system.byId("settings-version").textContent, "—");
  assert.equal(system.byId("settings-live-streams").textContent, "—");
});

test("notice/error banners relabel in both directions without clearing the draft", async () => {
  const env = environment(); await env.auth(true);
  await env.importFile(env.file({"English source": "Bozza"}));
  env.context.NvrI18n.setLanguage("it");
  assert.equal(env.byId("settings-notice").textContent, env.context.NvrI18n.t("Import ready. Review the translations, then save your changes."));
  env.context.NvrI18n.setLanguage("en"); assert.match(env.byId("settings-notice").textContent, /^Import ready/);
  await env.importFile(env.file({"Device {number}": "Missing placeholder"}));
  const source = "Keep the same placeholders in this translation: {key}";
  env.context.NvrI18n.setLanguage("it");
  assert.equal(env.byId("settings-error").textContent, env.context.NvrI18n.t(source, {key: "Device {number}"}));
  env.context.NvrI18n.setLanguage("en");
  assert.equal(env.byId("settings-error").textContent, "Keep the same placeholders in this translation: Device {number}");
  assert.equal((await env.field("English source")).value, "Bozza");
});

test("already-translated static API errors retain their English source for relabeling", async () => {
  const env = environment(); await env.auth(true); env.context.NvrI18n.setLanguage("it");
  const source = "Translations could not be loaded. Try opening Settings again.";
  env.handler(async () => { throw Error(env.context.NvrI18n.t(source)); });
  await env.context.NvrSettings.open();
  assert.equal(env.byId("settings-error").textContent, env.context.NvrI18n.t(source));
  env.context.NvrI18n.setLanguage("en"); assert.equal(env.byId("settings-error").textContent, source);
});

test("custom HTML-looking translations remain inert text and reset restores defaults", async () => {
  const env = environment(); await env.auth(true);
  const value = '<img src=x onerror="throw Error(1)">';
  await env.importFile(env.file({"English source": value}));
  await env.byId("settings-translations-save").fire("click");
  env.context.NvrI18n.setLanguage("it");
  assert.equal((await env.field("English source")).value, value);
  assert.equal(env.context.NvrI18n.t("English source"), value);
  await env.byId("settings-translations-reset").fire("click");
  assert.equal(Object.keys(env.context.NvrI18n.getOverrides()).length, 0);
  assert.equal((await env.field("English source")).value, "Testo originale inglese");
});
