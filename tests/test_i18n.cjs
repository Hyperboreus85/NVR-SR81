"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync, readdirSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const staticDir = join(__dirname, "../nvr/static");

function environment(saved = null, blocked = false, parts = null) {
  const storage = new Map(saved ? [["nvr.language", saved]] : []), events = [];
  const document = {documentElement: {lang: "en"}, querySelectorAll: () => []};
  const context = vm.createContext({document, localStorage: {
    getItem(key) { if (blocked) throw Error("Blocked"); return storage.get(key) || null; },
    setItem(key, value) { if (blocked) throw Error("Blocked"); storage.set(key, value); },
  }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  navigator: {language: "it-IT"}});
  context.window = context;
  context.dispatchEvent = (event) => events.push(event);
  if (parts) context.NVR_LOCALE_PARTS = parts;
  else for (const file of readdirSync(staticDir).filter((name) => /^locales-.*\.js$/.test(name)).sort())
    vm.runInContext(readFileSync(join(staticDir, file), "utf8"), context, {filename: file});
  vm.runInContext(readFileSync(join(staticDir, "i18n.js"), "utf8"), context);
  return {i18n: context.NvrI18n, context, storage, events, document};
}

test("English is the first-run default regardless of browser language", () => {
  const {i18n, document} = environment();
  assert.equal(i18n.getLanguage(), "en"); assert.equal(document.documentElement.lang, "en");
  assert.equal(i18n.t("English source"), "English source");
  assert.equal(i18n.locale(), "en-GB");
});

test("Italian preference persists and updates the document and runtime listeners", () => {
  const {i18n, document, storage, events} = environment();
  i18n.setLanguage("it");
  assert.equal(i18n.t("English source"), "Testo originale inglese");
  assert.equal(i18n.locale(), "it-IT"); assert.equal(document.documentElement.lang, "it");
  assert.equal(storage.get("nvr.language"), "it"); assert.equal(events[0].type, "nvr-languagechange");
  assert.equal(environment("it").i18n.getLanguage(), "it");
  assert.equal(environment("xx").i18n.getLanguage(), "en");
  assert.throws(() => i18n.setLanguage("xx"), /Unsupported language/);
});

test("disabled browser storage still permits changing language in this session", () => {
  const {i18n} = environment(null, true);
  i18n.setLanguage("it"); assert.equal(i18n.t("English source"), "Testo originale inglese");
});

test("overrides are isolated, resettable, and fall back to English when empty", () => {
  const {i18n} = environment("it");
  i18n.setOverrides({"English source": "Testo personalizzato", "Unknown key": "Injected"});
  assert.equal(i18n.t("English source"), "Testo personalizzato");
  assert.equal(i18n.t("Unknown key"), "Unknown key");
  const returned = i18n.getOverrides(); returned["English source"] = "Changed outside";
  assert.equal(i18n.t("English source"), "Testo personalizzato");
  i18n.setOverrides({"English source": ""}); assert.equal(i18n.t("English source"), "English source");
  i18n.setOverrides({}); assert.equal(i18n.t("English source"), "Testo originale inglese");
  i18n.setLanguage("en"); assert.equal(i18n.t("Unknown text"), "Unknown text");
});

test("placeholders and completed server templates preserve runtime values", () => {
  const {i18n} = environment("it", false, [{it: {
    "Found {count} devices.": "Trovati {count} dispositivi.",
    "Connection failed ({address}): {error}": "Connessione fallita ({address}): {error}",
    "Access required": "Accesso richiesto",
  }}]);
  assert.equal(i18n.t("Found {count} devices.", {count: 3}), "Trovati 3 dispositivi.");
  assert.equal(i18n.t("Found 3 devices."), "Trovati 3 dispositivi.");
  assert.equal(i18n.t("Connection failed (192.168.1.20): Access required"), "Connessione fallita (192.168.1.20): Accesso richiesto");
  assert.equal(i18n.t("192.168.1.20: Camera A"), "192.168.1.20: Camera A");
});

test("translations use textContent and attributes without executing HTML", () => {
  const {i18n} = environment("it");
  const attributes = new Map([["data-i18n", "English source"], ["data-i18n-title", "Italian translation"], ["data-i18n-alt", "English source"]]);
  const node = {textContent: "", matches: () => true, querySelectorAll: () => [],
    hasAttribute: (key) => attributes.has(key), getAttribute: (key) => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value)};
  Object.defineProperty(node, "innerHTML", {set() { throw Error("HTML insertion is forbidden"); }});
  i18n.setOverrides({"English source": "<img src=x onerror=alert(1)>"});
  i18n.translate(node);
  assert.equal(node.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(attributes.get("title"), "Traduzione italiana");
  assert.equal(attributes.get("alt"), "<img src=x onerror=alert(1)>");
});

test("bundled catalogs cover marked HTML and use matching placeholders", () => {
  const {context, i18n} = environment();
  const keys = new Set(i18n.getEntries().map((entry) => entry.key));
  assert.ok(keys.size > 300, "Expected the whole application catalog");
  const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const html = readFileSync(join(staticDir, "index.html"), "utf8");
  for (const match of html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder|alt))?="([^"]+)"/g))
    assert.ok(keys.has(decode(match[1])), "Missing Italian key: " + decode(match[1]));
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
  for (const part of context.NVR_LOCALE_PARTS) for (const [source, translated] of Object.entries(part.it))
    assert.deepEqual(placeholders(translated), placeholders(source), "Changed placeholder in: " + source);
});
