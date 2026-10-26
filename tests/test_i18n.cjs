"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const staticDir = join(__dirname, "../nvr/static"), localeDir = join(__dirname, "../nvr/locales");
const includedEnglish = JSON.parse(readFileSync(join(localeDir, "en.json"), "utf8"));
const includedItalian = JSON.parse(readFileSync(join(localeDir, "it.json"), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function pack(locale, translations, name = locale) { return {format: "nvr-sr81.language-pack", version: 1, locale, name, native_name: name, translations}; }
function metadata(pack, source = "included") { return {locale: pack.locale, name: pack.name, native_name: pack.native_name, source,
  translated: Object.values(pack.translations).filter(Boolean).length, total: Object.keys(includedEnglish.translations).length}; }

function environment({saved = null, blocked = false, packs = {}, list = null, handler = null, fastTimeout = null} = {}) {
  const catalogs = new Map(Object.entries({en: includedEnglish, it: includedItalian, ...packs}));
  const state = {list: list || [metadata(catalogs.get("en")), metadata(catalogs.get("it"))]};
  const storage = new Map(saved ? [["nvr.language", saved]] : []), events = [], requests = [];
  const document = {documentElement: {lang: "en"}, querySelectorAll: () => []};
  const context = vm.createContext({document, Intl, AbortController, setTimeout: (callback, ms) => setTimeout(callback, fastTimeout ?? ms), clearTimeout,
    localStorage: {getItem(key) { if (blocked) throw Error("Blocked"); return storage.get(key) || null; },
      setItem(key, value) { if (blocked) throw Error("Blocked"); storage.set(key, value); }},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, navigator: {language: "it-IT"}});
  context.window = context;
  context.dispatchEvent = (event) => { events.push(event); return true; };
  const defaultFetch = async (path) => {
    if (path === "/api/languages") return {ok: true, json: async () => ({default: "en", fallback: "en", languages: clone(state.list)})};
    const code = decodeURIComponent(path.slice("/api/languages/".length));
    return {ok: catalogs.has(code), json: async () => clone(catalogs.get(code))};
  };
  let fetchHandler = handler;
  context.fetch = async (path, options) => { requests.push({path, options}); return fetchHandler ? fetchHandler(path, options, defaultFetch) : defaultFetch(path); };
  vm.runInContext(readFileSync(join(staticDir, "i18n.js"), "utf8"), context, {filename: "i18n.js"});
  return {i18n: context.NvrI18n, context, document, storage, events, requests, catalogs, state,
    handler(value) { fetchHandler = value; }};
}

test("ready loads local JSON files and first-run English ignores browser language", async () => {
  const env = environment(); assert.equal(typeof env.i18n.ready.then, "function"); await env.i18n.ready;
  assert.equal(env.i18n.getLanguage(), "en"); assert.equal(env.document.documentElement.lang, "en");
  assert.equal(env.i18n.locale(), "en"); assert.equal(env.i18n.t("Sign in"), "Sign in");
  assert.ok(env.requests.some((request) => request.path === "/api/languages/en"));
  assert.ok(env.requests.every((request) => request.path.startsWith("/api/languages") && request.options.credentials === "same-origin"));
  assert.equal(env.i18n.setOverrides, undefined); assert.equal(env.i18n.getOverrides, undefined);
});

test("ready waits for a persisted Italian catalog and language preference survives reload", async () => {
  const italian = deferred();
  const env = environment({saved: "it", handler: async (path, options, fallback) => path === "/api/languages/it" ? italian.promise : fallback(path)});
  let finished = false; env.i18n.ready.then(() => { finished = true; }); await flush();
  assert.equal(finished, false); assert.equal(env.i18n.getLanguage(), "en");
  italian.resolve({ok: true, json: async () => clone(includedItalian)}); await env.i18n.ready;
  assert.equal(env.i18n.getLanguage(), "it"); assert.equal(env.i18n.t("Sign in"), "Accedi");
  assert.equal(env.i18n.locale(), "it"); assert.equal(env.storage.get("nvr.language"), "it");
  const reloaded = environment({saved: env.storage.get("nvr.language")}); await reloaded.i18n.ready;
  assert.equal(reloaded.i18n.getLanguage(), "it");
});

test("disabled browser storage still permits an in-session language change", async () => {
  const env = environment({blocked: true}); await env.i18n.ready; await env.i18n.setLanguage("it");
  assert.equal(env.i18n.getLanguage(), "it"); assert.equal(env.i18n.t("Sign in"), "Accedi");
});

test("installed French appears after refresh and missing translations fall back to English", async () => {
  const env = environment(); await env.i18n.ready;
  const french = pack("fr", {"Sign in": "Connexion"}, "Français");
  env.catalogs.set("fr", french); env.state.list.push(metadata(french, "installed"));
  await env.i18n.refreshLanguages();
  const languages = env.i18n.getLanguages(); assert.equal(languages.find((item) => item.locale === "fr").source, "installed");
  languages[0].name = "Changed outside"; assert.notEqual(env.i18n.getLanguages()[0].name, "Changed outside");
  await env.i18n.setLanguage("fr"); assert.equal(env.i18n.t("Sign in"), "Connexion");
  assert.equal(env.i18n.t("Password"), "Password"); assert.equal(env.storage.get("nvr.language"), "fr");
  assert.ok(env.events.some((event) => event.type === "nvr-languageschange"));
});

test("failed language fetches keep a working selection and initial failure resolves ready in English", async () => {
  const broken = environment({saved: "it", handler: async (path, options, fallback) => {
    if (path === "/api/languages/it") throw Error("private network diagnostic"); return fallback(path);
  }});
  await broken.i18n.ready; assert.equal(broken.i18n.getLanguage(), "en"); assert.equal(broken.i18n.t("Sign in"), "Sign in");
  assert.equal(broken.storage.get("nvr.language"), "it", "A transient failure must not forget the saved language");
  await assert.rejects(broken.i18n.setLanguage("it"), /Language files are unavailable/);
  assert.equal(broken.i18n.getLanguage(), "en");
  const unavailable = environment({handler: async () => { throw Error("offline"); }});
  await unavailable.i18n.ready; assert.equal(unavailable.i18n.getLanguage(), "en");
  assert.equal(unavailable.i18n.getLanguages().length, 1);
});

test("a stalled catalog response has a bounded timeout and does not block application startup forever", async () => {
  const env = environment({fastTimeout: 5, handler: async () => new Promise(() => {})});
  await env.i18n.ready; assert.equal(env.i18n.getLanguage(), "en");
  assert.ok(env.requests.every((request) => request.options.signal.aborted));
});

test("the latest selected language wins when an earlier fetch finishes later", async () => {
  const french = pack("fr", {"Sign in": "Connexion"}, "Français"), italian = deferred();
  const env = environment({packs: {fr: french}, list: [metadata(includedEnglish), metadata(includedItalian), metadata(french, "installed")]});
  await env.i18n.ready;
  env.handler(async (path, options, fallback) => path === "/api/languages/it" ? italian.promise : fallback(path));
  const first = env.i18n.setLanguage("it"); await flush();
  await env.i18n.setLanguage("fr");
  italian.resolve({ok: true, json: async () => clone(includedItalian)}); await first;
  assert.equal(env.i18n.getLanguage(), "fr"); assert.equal(env.i18n.t("Sign in"), "Connexion");
  assert.equal(env.storage.get("nvr.language"), "fr");
  await assert.rejects(env.i18n.setLanguage("../../private"), /Unsupported language/);
});

test("refresh updates a replaced current pack and older refreshes cannot overwrite it or its cache", async () => {
  const french = pack("fr", {"Sign in": "Ancienne"}, "Français");
  const env = environment({saved: "fr", packs: {fr: french}, list: [metadata(includedEnglish), metadata(french, "installed")]});
  await env.i18n.ready; const old = deferred(); let reads = 0;
  env.handler(async (path, options, fallback) => {
    if (path === "/api/languages/fr") {
      reads++; if (reads === 1) return old.promise;
      return {ok: true, json: async () => pack("fr", {"Sign in": "Nouvelle"}, "Français")};
    }
    return fallback(path);
  });
  const first = env.i18n.refreshLanguages(); await flush(); await env.i18n.refreshLanguages();
  old.resolve({ok: true, json: async () => french}); await first;
  assert.equal(env.i18n.t("Sign in"), "Nouvelle");
  await env.i18n.setLanguage("en"); await env.i18n.setLanguage("fr");
  assert.equal(env.i18n.t("Sign in"), "Nouvelle");
});

test("deleting the selected installed language falls back to English and updates the preference", async () => {
  const french = pack("fr", {"Sign in": "Connexion"}, "Français");
  const env = environment({saved: "fr", packs: {fr: french}, list: [metadata(includedEnglish), metadata(french, "installed")]});
  await env.i18n.ready; env.state.list = [metadata(includedEnglish)]; env.catalogs.delete("fr");
  await env.i18n.refreshLanguages(); assert.equal(env.i18n.getLanguage(), "en"); assert.equal(env.storage.get("nvr.language"), "en");
  assert.equal(env.i18n.getLanguages().length, 1); assert.equal(env.i18n.t("Sign in"), "Sign in");
  const missing = environment({saved: "fr"}); await missing.i18n.ready; assert.equal(missing.storage.get("nvr.language"), "en");
});

test("a removed pending pack cannot revive itself or poison a later reinstallation", async () => {
  const french = pack("fr", {"Sign in": "Old file"}, "Français"), pending = deferred();
  const env = environment({packs: {fr: french}, list: [metadata(includedEnglish), metadata(french, "installed")]});
  await env.i18n.ready;
  env.handler(async (path, options, fallback) => path === "/api/languages/fr" ? pending.promise : fallback(path));
  const choosing = env.i18n.setLanguage("fr"); await flush();
  env.state.list = [metadata(includedEnglish)]; await env.i18n.refreshLanguages();
  const replacement = pack("fr", {"Sign in": "Replacement file"}, "Français");
  env.catalogs.set("fr", replacement); env.state.list.push(metadata(replacement, "installed"));
  env.handler(null); await env.i18n.refreshLanguages();
  pending.resolve({ok: true, json: async () => french}); await choosing;
  assert.equal(env.i18n.getLanguage(), "en");
  await env.i18n.setLanguage("fr"); assert.equal(env.i18n.t("Sign in"), "Replacement file");
});

test("English-manifest templates preserve device data while translating nested errors", async () => {
  const source = {"Found {count} devices.": "Found {count} devices.", "Connection failed ({address}): {error}": "Connection failed ({address}): {error}",
    "Camera {camera} is unavailable.": "Camera {camera} is unavailable.", "Access required": "Access required", "Paused": "Paused"};
  const en = pack("en", source, "English"), it = pack("it", {"Found {count} devices.": "Trovati {count} dispositivi.",
    "Connection failed ({address}): {error}": "Connessione fallita ({address}): {error}", "Camera {camera} is unavailable.": "Telecamera {camera} non disponibile.",
    "Access required": "Accesso richiesto", "Paused": "In pausa"}, "Italiano");
  const env = environment({saved: "it", packs: {en, it}, list: [metadata(en), metadata(it)]}); await env.i18n.ready;
  assert.equal(env.i18n.t("Found {count} devices.", {count: 3}), "Trovati 3 dispositivi.");
  assert.equal(env.i18n.t("Found 3 devices."), "Trovati 3 dispositivi.");
  assert.equal(env.i18n.t("Connection failed (192.168.1.20): Access required"), "Connessione fallita (192.168.1.20): Accesso richiesto");
  assert.equal(env.i18n.t("Camera Paused is unavailable."), "Telecamera Paused non disponibile.");
  assert.equal(env.i18n.t("192.168.1.20: Camera A"), "192.168.1.20: Camera A");
});

test("JSON catalog translations use inert textContent and safe attributes", async () => {
  const it = clone(includedItalian); it.translations["Sign in"] = '<img src=x onerror="throw Error(1)">';
  const env = environment({saved: "it", packs: {it}}); await env.i18n.ready;
  const attributes = new Map([["data-i18n", "Sign in"], ["data-i18n-title", "Sign in"], ["data-i18n-alt", "Sign in"]]);
  const node = {textContent: "", matches: () => true, querySelectorAll: () => [], hasAttribute: (key) => attributes.has(key),
    getAttribute: (key) => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value)};
  Object.defineProperty(node, "innerHTML", {set() { throw Error("HTML insertion is forbidden"); }});
  env.i18n.translate(node); assert.equal(node.textContent, it.translations["Sign in"]);
  assert.equal(attributes.get("title"), it.translations["Sign in"]); assert.equal(attributes.get("alt"), it.translations["Sign in"]);
});

test("invalid pack schema and changed placeholders do not replace a working language", async () => {
  const invalid = clone(includedItalian); invalid.translations["Device {number}"] = "Dispositivo senza parametro";
  const env = environment({packs: {it: invalid}}); await env.i18n.ready;
  await assert.rejects(env.i18n.setLanguage("it"), /Invalid language pack/); assert.equal(env.i18n.getLanguage(), "en");
});

test("empty or whitespace-only translations use the same English fallback as the backend", async () => {
  const french = pack("fr", {"Sign in": "   ", "Device {number}": " "}, "Français");
  const env = environment({packs: {fr: french}, list: [metadata(includedEnglish), metadata(french, "installed")]});
  await env.i18n.ready; await env.i18n.setLanguage("fr");
  assert.equal(env.i18n.t("Sign in"), "Sign in");
  assert.equal(env.i18n.t("Device {number}", {number: 2}), "Device 2");
  assert.equal(env.i18n.getEntries().find((entry) => entry.key === "Sign in").translation, "Sign in");
});

test("included JSON packs cover marked HTML, expose English keys and preserve placeholders", async () => {
  const env = environment(); await env.i18n.ready;
  const keys = new Set(env.i18n.getSourceKeys()); assert.ok(keys.size > 200);
  assert.equal(env.i18n.getEntries().length, keys.size);
  assert.ok(env.i18n.getEntries().every((entry) => typeof entry.key === "string"));
  const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const html = readFileSync(join(staticDir, "index.html"), "utf8");
  for (const match of html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder|alt))?="([^"]+)"/g))
    assert.ok(keys.has(decode(match[1])), "Missing English key: " + decode(match[1]));
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
  for (const [source, value] of Object.entries(includedEnglish.translations)) assert.equal(value, source, "English source changed: " + source);
  for (const [source, value] of Object.entries(includedItalian.translations)) {
    assert.ok(keys.has(source), "Unknown Italian key: " + source);
    if (value) assert.deepEqual(placeholders(value), placeholders(source), "Changed placeholder in: " + source);
  }
});

test("the API sends a raw uploaded JSON string unchanged while retaining legacy body and security headers", async () => {
  const source = readFileSync(join(staticDir, "app.js"), "utf8");
  const helper = source.slice(source.indexOf("async function api("), source.indexOf("\nfunction bytes("));
  const calls = [];
  const context = vm.createContext({state: {authEpoch: 1}, Headers, t: (value) => value, uiError: (value) => new Error(value), showLogin() {},
    fetch: async (path, options) => { calls.push({path, options}); return {ok: true, status: 200, text: async () => "{}"}; }});
  vm.runInContext(helper, context);
  const raw = '{"locale":"fr","translations":{"Sign in":"A","Sign in":"B"}}';
  await context.api("/api/languages/install", {method: "POST", rawBody: raw});
  assert.equal(calls[0].options.body, raw); assert.equal(Object.hasOwn(calls[0].options, "rawBody"), false);
  assert.equal(calls[0].options.headers.get("X-NVR-Request"), "1"); assert.equal(calls[0].options.headers.get("Content-Type"), "application/json");
  assert.equal(calls[0].options.credentials, "same-origin");
  await context.api("/api/cameras", {method: "POST", body: {name: "Camera A"}});
  assert.equal(calls[1].options.body, '{"name":"Camera A"}');
});
