"use strict";

// English source strings are the stable keys. Catalogs and overrides stay local.
(() => {
  const languageKey = "nvr.language";
  const builtIn = Object.create(null);
  for (const part of window.NVR_LOCALE_PARTS || []) {
    for (const [key, value] of Object.entries(part.it || {})) {
      if (typeof value === "string") builtIn[key] = value;
    }
  }
  let language = "en", overrides = Object.create(null), templates = [];
  try { if (localStorage.getItem(languageKey) === "it") language = "it"; } catch (_) { /* Storage can be disabled. */ }
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fill = (value, parameters) => value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (match, key) => own(parameters, key) ? String(parameters[key]) : match);
  const italian = (key) => own(overrides, key) ? overrides[key] || key : builtIn[key] || key;

  function rebuildTemplates() {
    templates = Object.keys(builtIn).filter((key) => /\{[A-Za-z][A-Za-z0-9_]*\}/.test(key)).map((key) => {
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

  function translateMessage(value, depth = 0) {
    if (own(builtIn, value) || own(overrides, value)) return italian(value);
    if (depth < 2 && value.length <= 4096) {
      for (const template of templates) {
        const match = template.pattern.exec(value);
        if (!match) continue;
        const parameters = Object.create(null);
        template.names.forEach((name, index) => { parameters[name] = translateMessage(match[index + 1], depth + 1); });
        return fill(italian(template.key), parameters);
      }
    }
    return value;
  }

  function t(key, parameters = {}) {
    if (key === null || key === undefined) return "";
    const source = String(key);
    return fill(language === "it" ? translateMessage(source) : source, parameters);
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

  function setLanguage(value) {
    if (!["en", "it"].includes(value)) throw new RangeError("Unsupported language");
    const previous = language;
    language = value;
    try { localStorage.setItem(languageKey, language); } catch (_) { /* Keep a session preference. */ }
    if (previous !== language) changed("language");
    else translate();
  }

  function setOverrides(value, notify = true) {
    overrides = Object.create(null);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, translation] of Object.entries(value)) {
        if (own(builtIn, key) && typeof translation === "string") overrides[key] = translation;
      }
    }
    if (notify) changed("translations");
  }

  rebuildTemplates();
  window.NvrI18n = Object.freeze({
    t, translate, getLanguage: () => language, setLanguage,
    locale: () => language === "it" ? "it-IT" : "en-GB",
    setOverrides,
    getOverrides: () => ({...overrides}),
    getEntries: () => Object.keys(builtIn).sort().map((key) => ({key, translation: italian(key),
      defaultTranslation: builtIn[key], overridden: own(overrides, key)})),
  });
  translate();
})();
