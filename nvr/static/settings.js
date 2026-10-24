"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const i18n = window.NvrI18n;
  const t = (...args) => i18n.t(...args);
  const pageSize = 30;
  let tab = "general", page = 0, authenticated = false, epoch = 0;
  let loaded = false, loading = false, saving = false, dirty = false, importing = false, importEpoch = 0;
  let saved = Object.create(null), draft = Object.create(null), system = null, live = null;
  const bannerSources = new Map();
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = (value) => Object.assign(Object.create(null), value);
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);

  function checkTranslation(key, value) {
    if (typeof value !== "string" || value.length > 2000) throw new Error("Translation values must be text with at most 2000 characters.");
    const placeholders = (text) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort().join("|");
    if (value && placeholders(key) !== placeholders(value)) {
      const error = new Error("Keep the same placeholders in this translation: {key}");
      error.i18nParams = {key}; throw error;
    }
  }

  function message(id, text = "", params) {
    const entries = text ? i18n.getEntries() : [];
    const source = entries.find((entry) => entry.key === text) || entries.find((entry) => entry.translation === text || entry.defaultTranslation === text);
    const key = source?.key || text;
    bannerSources.set(id, {key, params});
    const node = byId(id);
    node.textContent = key ? t(key, params) : "";
    node.hidden = !key;
  }

  function selectTab(value) {
    tab = value;
    document.querySelectorAll("[data-settings-tab]").forEach((button) => {
      const active = button.dataset.settingsTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  }

  function updateActions() {
    byId("settings-translations-save").disabled = !loaded || !dirty || saving || importing;
    byId("settings-translations-save").textContent = t(saving ? "Saving…" : "Save translations");
    byId("settings-translations-reset").disabled = !loaded || saving || importing;
    byId("settings-translations-export").disabled = !loaded || saving || importing;
    byId("settings-translations-import").disabled = !loaded || saving || importing;
    byId("settings-translations-list").setAttribute("aria-busy", String(loading || saving || importing));
    byId("settings-translations-save").title = t(dirty ? "Unsaved changes" : "All changes saved");
  }

  function renderTranslations() {
    const container = byId("settings-translations-list");
    const query = byId("settings-translation-search").value.toLocaleLowerCase(i18n.locale()).trim();
    const entries = i18n.getEntries().filter((entry) =>
      (entry.key + " " + (own(draft, entry.key) ? draft[entry.key] : entry.defaultTranslation)).toLocaleLowerCase(i18n.locale()).includes(query));
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    page = Math.max(0, Math.min(page, totalPages - 1));
    container.replaceChildren();
    if (!loaded) {
      const line = document.createElement("p"); line.className = "muted";
      line.textContent = t(loading ? "Loading translations…" : "Translations could not be loaded. Try opening Settings again.");
      container.append(line);
    } else if (!entries.length) {
      const line = document.createElement("p"); line.className = "muted"; line.textContent = t("No matching translations."); container.append(line);
    } else {
      for (const entry of entries.slice(page * pageSize, (page + 1) * pageSize)) {
        const row = document.createElement("article"); row.className = "translation-row";
        const source = document.createElement("div"); source.className = "translation-source";
        const label = document.createElement("span"); label.className = "eyebrow"; label.textContent = t("English source");
        const text = document.createElement("p"); text.textContent = entry.key; source.append(label, text);
        const target = document.createElement("label"); target.className = "translation-target";
        const targetLabel = document.createElement("span"); targetLabel.textContent = t("Italian translation");
        const input = document.createElement("textarea"); input.rows = 2; input.maxLength = 2000; input.lang = "it";
        input.value = own(draft, entry.key) ? draft[entry.key] : entry.defaultTranslation;
        input.disabled = saving || importing; input.setAttribute("aria-label", t("Italian translation") + ": " + entry.key);
        const hint = document.createElement("small"); hint.className = "muted";
        hint.textContent = t(own(draft, entry.key) ? "Custom translation" : "Built-in translation");
        input.addEventListener("input", () => {
          if (input.value === entry.defaultTranslation) delete draft[entry.key];
          else draft[entry.key] = input.value;
          dirty = !same(draft, saved);
          hint.textContent = t(own(draft, entry.key) ? "Custom translation" : "Built-in translation");
          updateActions(); updateCounts(entries.length);
        });
        target.append(targetLabel, input, hint); row.append(source, target); container.append(row);
      }
    }
    updateCounts(entries.length);
    byId("settings-translations-page").textContent = t("Page {page} of {total}", {page: page + 1, total: totalPages});
    byId("settings-translations-previous").disabled = page === 0 || !loaded;
    byId("settings-translations-next").disabled = page >= totalPages - 1 || !loaded;
    updateActions();
  }

  function updateCounts(count) {
    byId("settings-translations-count").textContent = t("{count} strings · custom translations: {custom}", {count, custom: Object.keys(draft).length});
    const entries = i18n.getEntries();
    const overrides = i18n.getOverrides();
    byId("settings-language-en-count").textContent = t("{count} strings", {count: entries.length});
    byId("settings-language-it-count").textContent = t("{count} strings", {count: entries.filter((entry) => entry.overridden ? !!overrides[entry.key] : !!entry.defaultTranslation).length});
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return t("Not available");
    let number = value, index = 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    while (number >= 1000 && index < units.length - 1) { number /= 1000; index += 1; }
    return number.toLocaleString(i18n.locale(), {maximumFractionDigits: 1}) + " " + units[index];
  }

  function relabel() {
    bannerSources.forEach(({key, params}, id) => {
      byId(id).textContent = key ? t(key, params) : "";
      byId(id).hidden = !key;
    });
    byId("login-language").value = i18n.getLanguage();
    byId("settings-language").value = i18n.getLanguage();
    byId("settings-version").textContent = system?.version || "—";
    byId("settings-disk-free").textContent = system ? formatBytes(system.disk?.free) : "—";
    for (const [id, active, maximum] of [["settings-live-streams", live?.active_streams, live?.max_streams], ["settings-live-transcodes", live?.active_transcodes, live?.max_transcodes]]) {
      byId(id).textContent = live ? t("{active} / {maximum}", {active, maximum}) : "—";
    }
    renderTranslations();
  }

  async function loadTranslations() {
    if (!authenticated || loading) return;
    const requestEpoch = epoch;
    loading = true; renderTranslations();
    try {
      const result = await api("/api/settings/translations");
      if (requestEpoch !== epoch || !authenticated) return;
      saved = copy(result.overrides || {}); draft = copy(saved); dirty = false; loaded = true;
      i18n.setOverrides(saved);
    } catch (error) {
      if (requestEpoch === epoch && authenticated) message("settings-error", error.message, error.i18nParams);
    } finally {
      if (requestEpoch === epoch) { loading = false; renderTranslations(); }
    }
  }

  async function open() {
    selectTab(tab); relabel();
    if (!authenticated) return;
    if (!loaded) loadTranslations();
    const requestEpoch = epoch;
    const results = await Promise.allSettled([api("/api/system"), api("/api/live/status")]);
    if (requestEpoch !== epoch || !authenticated) return;
    if (results[0].status === "fulfilled") system = results[0].value;
    if (results[1].status === "fulfilled") live = results[1].value;
    if (results.some((result) => result.status === "rejected")) message("settings-error", results.find((result) => result.status === "rejected").reason.message);
    relabel();
  }

  async function save(reset = false) {
    if (!loaded || saving || importing || !authenticated) return;
    if (reset && !window.confirm(t("Restore the default Italian translations? Your saved custom translations will be removed."))) return;
    if (!reset) {
      try { for (const [key, value] of Object.entries(draft)) checkTranslation(key, value); }
      catch (error) { message("settings-error", error.message, error.i18nParams); return; }
    }
    const requestEpoch = epoch;
    importEpoch += 1;
    saving = true; message("settings-error"); message("settings-notice"); renderTranslations();
    try {
      const result = await api("/api/settings/translations", {method: "PUT", body: {locale: "it", overrides: reset ? {} : {...draft}}});
      if (requestEpoch !== epoch || !authenticated) return;
      saved = copy(result.overrides); draft = copy(saved); dirty = false; i18n.setOverrides(saved);
      message("settings-notice", reset ? "Default Italian translations restored." : "Translations saved on this NVR.");
    } catch (error) {
      if (requestEpoch === epoch && authenticated) message("settings-error", error.message, error.i18nParams);
    } finally {
      if (requestEpoch === epoch) { saving = false; renderTranslations(); }
    }
  }

  async function importCatalog(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !loaded || saving || !authenticated) return;
    const requestEpoch = epoch, requestImport = ++importEpoch;
    importing = true; renderTranslations();
    try {
      if (file.size > 512 * 1024) throw new Error("The JSON file must be smaller than 512 KiB.");
      const text = await file.text();
      if (requestEpoch !== epoch || requestImport !== importEpoch || !authenticated) return;
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error("Choose a valid Italian translation catalog exported by this app."); }
      if (data?.locale !== "it" || !data.translations || typeof data.translations !== "object" || Array.isArray(data.translations)) throw new Error("Choose a valid Italian translation catalog exported by this app.");
      const entries = i18n.getEntries(), known = new Map(entries.map((entry) => [entry.key, entry.defaultTranslation]));
      const imported = Object.create(null);
      for (const [key, value] of Object.entries(data.translations)) {
        if (!known.has(key)) {
          const error = new Error("Unknown translation key: {key}");
          error.i18nParams = {key: key.slice(0,100)}; throw error;
        }
        checkTranslation(key, value);
        if (value !== known.get(key)) imported[key] = value;
      }
      draft = imported; dirty = !same(draft, saved); page = 0; renderTranslations();
      message("settings-error"); message("settings-notice", "Import ready. Review the translations, then save your changes.");
    } catch (error) {
      if (requestEpoch === epoch && requestImport === importEpoch) message("settings-error", error.message, error.i18nParams);
    } finally {
      if (requestEpoch === epoch && requestImport === importEpoch) { importing = false; renderTranslations(); }
    }
  }

  function exportCatalog() {
    let objectUrl;
    try {
      const translations = Object.fromEntries(i18n.getEntries().map((entry) => [entry.key, own(draft, entry.key) ? draft[entry.key] : entry.defaultTranslation]));
      const blob = new Blob([JSON.stringify({locale: "it", translations}, null, 2) + "\n"], {type: "application/json"});
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = objectUrl; link.download = "nvr-sr81-it.json";
      document.body.append(link); link.click(); link.remove(); message("settings-notice", "Translation catalog exported.");
    } catch (_) { message("settings-error", "This browser could not download the catalog."); }
    finally { if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
  }

  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.settingsTab));
    button.addEventListener("keydown", (event) => {
      const tabs = [...document.querySelectorAll("[data-settings-tab]")];
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(button) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[index].dataset.settingsTab); tabs[index].focus();
    });
  });
  for (const id of ["settings-language", "login-language"]) byId(id).addEventListener("change", (event) => {
    i18n.setLanguage(event.target.value); message("settings-notice", "Language saved for this browser.");
  });
  byId("settings-translation-search").addEventListener("input", () => { page = 0; renderTranslations(); });
  byId("settings-translations-previous").addEventListener("click", () => { page -= 1; renderTranslations(); });
  byId("settings-translations-next").addEventListener("click", () => { page += 1; renderTranslations(); });
  byId("settings-translations-save").addEventListener("click", () => save());
  byId("settings-translations-reset").addEventListener("click", () => save(true));
  byId("settings-translations-export").addEventListener("click", exportCatalog);
  byId("settings-translations-import").addEventListener("change", importCatalog);
  byId("settings-monitor-layout").addEventListener("change", (event) => {
    const layout = Number(event.target.value);
    try { localStorage.setItem("nvr.monitor.layout", String(layout)); } catch (_) { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("nvr-monitor-layoutchange", {detail: {layout}}));
    message("settings-notice", "Default monitor layout saved for this browser.");
  });
  byId("settings-monitor-layout").value = "4";
  try { const layout = localStorage.getItem("nvr.monitor.layout"); if (["1", "4", "9", "16"].includes(layout)) byId("settings-monitor-layout").value = layout; } catch (_) { /* Default layout stays at four. */ }
  window.addEventListener("nvr-languagechange", relabel);
  window.addEventListener("nvr-authchange", (event) => {
    epoch += 1; importEpoch += 1; authenticated = !!event.detail.authenticated; loaded = loading = saving = dirty = importing = false;
    saved = Object.create(null); draft = Object.create(null); system = live = null;
    message("settings-error"); message("settings-notice");
    i18n.setOverrides({});
    if (authenticated) loadTranslations();
  });
  window.addEventListener("beforeunload", (event) => { if (dirty && authenticated) { event.preventDefault(); event.returnValue = ""; } });
  window.NvrSettings = Object.freeze({open, relabel});
  selectTab(tab); relabel();
  if (!byId("app").hidden) { authenticated = true; loadTranslations(); }
})();
