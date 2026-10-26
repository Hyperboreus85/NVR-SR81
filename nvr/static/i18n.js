"use strict";

// English source keys are stable. Every catalog comes from a local JSON file.
(() => {
  const languageKey = "nvr.language";
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const english = {locale: "en", name: "English", native_name: "English", source: "included", translated: 0, total: 0};
  const packs = new Map(), pendingPacks = new Map(), packEpochs = new Map();
  let languages = [{...english}], language = "en", activePack = null, templates = [];
  let selectionEpoch = 0, listEpoch = 0, pendingSelection = null;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fill = (value, parameters) => value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (match, key) => own(parameters, key) ? String(parameters[key]) : match);
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((item) => item[1]).sort().join("|");
  const validLocale = (value) => typeof value === "string" && value.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
  const available = (value) => languages.find((item) => item.locale.toLowerCase() === String(value).toLowerCase());
  const getLanguages = () => languages.map((item) => ({...item}));

  async function readJson(path) {
    const controller = new AbortController();
    let timer;
    try {
      const request = (async () => {
        const response = await fetch(path, {credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: {Accept: "application/json"}});
        if (!response.ok) throw new Error("Language files are unavailable. Try again.");
        return response.json();
      })();
      return await Promise.race([request, new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Language files are unavailable. Try again.")); }, 5000);
      })]);
    } catch (_) { throw new Error("Language files are unavailable. Try again.");
    } finally { clearTimeout(timer); }
  }

  function parseLanguages(result) {
    if (!result || !Array.isArray(result.languages) || result.languages.length > 64) throw new Error("Invalid language list.");
    const found = new Map();
    for (const item of result.languages) {
      if (!item || !validLocale(item.locale) || typeof item.name !== "string" || typeof item.native_name !== "string") continue;
      if (item.name.length > 100 || item.native_name.length > 100) continue;
      try { new Intl.DateTimeFormat(item.locale); } catch (_) { continue; }
      found.set(item.locale.toLowerCase(), {locale: item.locale, name: item.name, native_name: item.native_name,
        source: item.source === "installed" ? "installed" : "included", translated: Math.max(0, Number(item.translated) || 0),
        total: Math.max(0, Number(item.total) || 0)});
    }
    if (!found.has("en")) found.set("en", {...english});
    return [...found.values()];
  }

  function parsePack(result, code) {
    if (!result || result.format !== "nvr-sr81.language-pack" || result.version !== 1 || result.locale !== code ||
        typeof result.name !== "string" || typeof result.native_name !== "string" || result.name.length > 100 || result.native_name.length > 100 ||
        !result.translations || typeof result.translations !== "object" || Array.isArray(result.translations)) throw new Error("Invalid language pack.");
    const entries = Object.entries(result.translations);
    if (entries.length > 5000) throw new Error("Invalid language pack.");
    const translations = Object.create(null);
    for (const [key, value] of entries) {
      if (key.length > 4096 || typeof value !== "string" || value.length > 4096 || (value.trim() && placeholders(key) !== placeholders(value)))
        throw new Error("Invalid language pack.");
      translations[key] = value;
    }
    return {locale: code, translations};
  }

  function rebuildTemplates() {
    templates = Object.keys(packs.get("en")?.translations || {}).filter((key) => /\{[A-Za-z][A-Za-z0-9_]*\}/.test(key)).map((key) => {
      const names = [], chunks = [], expression = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
      let position = 0, match;
      while ((match = expression.exec(key))) {
        chunks.push(escape(key.slice(position, match.index)), "([\\s\\S]+?)");
        names.push(match[1]); position = expression.lastIndex;
      }
      chunks.push(escape(key.slice(position)));
      return {key, names, pattern: new RegExp("^" + chunks.join("") + "$"), specificity: key.replace(expression, "").length};
    }).filter((item) => item.specificity >= 6).sort((a, b) => b.specificity - a.specificity);
  }

  async function loadPack(code, force = false) {
    if (!force && packs.has(code)) return packs.get(code);
    if (!force && pendingPacks.has(code)) return pendingPacks.get(code);
    const version = (packEpochs.get(code) || 0) + 1;
    packEpochs.set(code, version);
    const request = (async () => {
      const pack = parsePack(await readJson("/api/languages/" + encodeURIComponent(code)), code);
      if (packEpochs.get(code) === version) {
        packs.set(code, pack);
        if (code === "en") rebuildTemplates();
      }
      return pack;
    })();
    pendingPacks.set(code, request);
    try { return await request; }
    finally { if (pendingPacks.get(code) === request) pendingPacks.delete(code); }
  }

  function translation(key) {
    const values = activePack?.translations;
    return values && own(values, key) && values[key].trim() ? values[key] : key;
  }

  function translateMessage(value, depth = 0) {
    if (own(packs.get("en")?.translations || {}, value)) return translation(value);
    if (depth < 2 && value.length <= 4096) {
      for (const template of templates) {
        const match = template.pattern.exec(value);
        if (!match) continue;
        const parameters = Object.create(null);
        template.names.forEach((name, index) => {
          // Device names, profile names, addresses and other runtime data stay
          // exactly as supplied. Only nested error/message text is translated.
          parameters[name] = ["error", "message", "reason"].includes(name) ? translateMessage(match[index + 1], depth + 1) : match[index + 1];
        });
        return fill(translation(template.key), parameters);
      }
    }
    return value;
  }

  function t(key, parameters = {}) {
    if (key === null || key === undefined) return "";
    const source = String(key);
    return fill(language === "en" ? source : translateMessage(source), parameters || {});
  }

  function translate(root = document) {
    const selectors = "[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder], [data-i18n-alt]";
    const nodes = [...root.querySelectorAll(selectors)];
    if (root.matches?.(selectors)) nodes.unshift(root);
    for (const node of nodes) {
      if (node.hasAttribute("data-i18n")) node.textContent = t(node.getAttribute("data-i18n"));
      for (const attribute of ["title", "aria-label", "placeholder", "alt"]) {
        const key = node.getAttribute("data-i18n-" + attribute);
        if (key !== null) node.setAttribute(attribute, t(key));
      }
    }
    document.documentElement.lang = language;
  }

  function changed(reason) {
    translate();
    window.dispatchEvent(new CustomEvent("nvr-languagechange", {detail: {language, reason}}));
  }

  function commit(code, pack, reason, persist = true) {
    const was = language, previous = activePack;
    language = code; activePack = code === "en" ? null : pack;
    if (persist) { try { localStorage.setItem(languageKey, language); } catch (_) { /* Session preference still works. */ } }
    if (was !== language || previous !== activePack || reason === "catalog") changed(reason);
    else translate();
  }

  function languagesChanged() {
    window.dispatchEvent(new CustomEvent("nvr-languageschange", {detail: {languages: getLanguages()}}));
  }

  async function initialize() {
    let preference = "en";
    try { preference = localStorage.getItem(languageKey) || "en"; } catch (_) { /* English first-run default. */ }
    const results = await Promise.allSettled([readJson("/api/languages"), loadPack("en")]);
    let verifiedList = false;
    if (results[0].status === "fulfilled") {
      try { languages = parseLanguages(results[0].value); verifiedList = true; } catch (_) { /* English remains usable. */ }
    }
    if (languages.length === 1 && languages[0].locale === "en") {
      const count = Object.keys(packs.get("en")?.translations || {}).length;
      languages = [{...english, total: count, translated: count}];
    }
    const selected = available(preference);
    if (verifiedList && selected && selected.locale !== "en" && results[1].status === "fulfilled") {
      try { commit(selected.locale, await loadPack(selected.locale), "catalog"); }
      catch (_) { commit("en", null, "catalog", false); }
    } else {
      // A verified deletion clears stale preferences. A transient failure keeps
      // the saved choice so a later reload can retry its installed language.
      commit("en", null, "catalog", verifiedList && !selected);
    }
    languagesChanged();
  }

  const ready = initialize().catch(() => { commit("en", null, "catalog", false); languagesChanged(); });

  async function setLanguage(value) {
    await ready;
    const ticket = ++selectionEpoch;
    const selected = validLocale(value) && available(value);
    if (!selected) throw new RangeError("Unsupported language");
    pendingSelection = {ticket, code: selected.locale};
    try {
      if (selected.locale !== "en" && !packs.has("en")) await loadPack("en");
      const pack = selected.locale === "en" ? null : await loadPack(selected.locale);
      if (ticket !== selectionEpoch) return language;
      if (!available(selected.locale)) throw new RangeError("Unsupported language");
      commit(selected.locale, pack, "language");
      return language;
    } finally { if (pendingSelection?.ticket === ticket) pendingSelection = null; }
  }

  async function refreshLanguages() {
    await ready;
    const ticket = ++listEpoch;
    const found = parseLanguages(await readJson("/api/languages"));
    if (ticket !== listEpoch) return getLanguages();
    languages = found;
    for (const code of new Set([...packs.keys(), ...pendingPacks.keys()])) {
      if (code !== "en" && !available(code)) {
        packs.delete(code); pendingPacks.delete(code);
        packEpochs.set(code, (packEpochs.get(code) || 0) + 1);
      }
    }
    if (pendingSelection && !available(pendingSelection.code)) { selectionEpoch += 1; pendingSelection = null; }
    if (!available(language)) commit("en", null, "catalog");
    languagesChanged();
    const selected = language, selection = selectionEpoch;
    try {
      const pack = await loadPack(selected, true);
      if (ticket === listEpoch && selection === selectionEpoch && language === selected && available(selected)) commit(selected, pack, "catalog");
    } catch (_) { /* Keep a working catalog when a refresh temporarily fails. */ }
    return getLanguages();
  }

  window.NvrI18n = Object.freeze({
    ready, t, translate, getLanguage: () => language, setLanguage, locale: () => language,
    getLanguages, refreshLanguages,
    getSourceKeys: () => Object.keys(packs.get("en")?.translations || {}),
    getEntries: (code = language) => Object.keys(packs.get("en")?.translations || {}).sort().map((key) => ({
      key, translation: code === "en" ? key : packs.get(code)?.translations[key]?.trim() ? packs.get(code).translations[key] : key,
    })),
  });
  translate();
})();
