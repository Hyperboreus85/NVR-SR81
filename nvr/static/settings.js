"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const i18n = window.NvrI18n;
  const t = (key, params) => i18n.t(key, params);
  const maximumBytes = 512 * 1024;
  const banners = new Map();
  let authenticated = !byId("app").hidden, tab = "general";
  let authEpoch = 0, fileEpoch = 0, operationEpoch = 0, openEpoch = 0, languageEpoch = 0;
  let selection = null, reading = false, busy = false, system = null, live = null;
  let languageActions = [], packActions = [];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function message(id, key = "", params) {
    if (key) banners.set(id, {key, params}); else banners.delete(id);
    byId(id).textContent = key ? t(key, params) : "";
    byId(id).hidden = !key;
  }

  function errorMessage(error) { message("settings-error", error.message || "An error occurred.", error.i18nParams); }
  function validAuth(ticket) { return authenticated && ticket === authEpoch; }
  function validOperation(ticket, operation) { return validAuth(ticket) && operation === operationEpoch; }

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
    byId("settings-pack-file").disabled = !authenticated || busy;
    byId("settings-pack-install").disabled = !authenticated || busy || reading || !selection;
    byId("settings-pack-template").disabled = !authenticated || busy;
    byId("settings-pack-install").textContent = t(busy ? "Please wait…" : "Install language pack");
    for (const button of [...languageActions, ...packActions]) button.disabled = busy || !authenticated || button.dataset.active === "true";
    byId("settings-language").disabled = busy;
    byId("login-language").disabled = busy;
    byId("settings-pack-preview").setAttribute("aria-busy", String(reading || busy));
  }

  function coverage(translated, total) { return t("{translated} / {total} strings", {translated, total}); }

  function renderSelection() {
    byId("settings-pack-preview").hidden = !selection;
    byId("settings-pack-name").textContent = selection ? selection.pack.native_name : "—";
    byId("settings-pack-locale").textContent = selection ? selection.pack.locale : "—";
    byId("settings-pack-coverage").textContent = selection ? coverage(selection.translated, selection.total) : "—";
    byId("settings-pack-selection").textContent = reading ? t("Reading language file…") : selection ? t("Selected file: {name}", {name: selection.filename}) : t("No language file selected.");
    updateActions();
  }

  function action(text, handler, locale, kind, className = "button secondary small-button") {
    const button = node("button", className, t(text));
    button.type = "button"; button.dataset.locale = locale; button.dataset.action = kind;
    button.addEventListener("click", handler);
    return button;
  }

  function renderLanguages() {
    const languages = i18n.getLanguages(), current = i18n.getLanguage();
    for (const id of ["settings-language", "login-language"]) {
      const select = byId(id);
      select.replaceChildren();
      for (const language of languages) {
        const option = node("option", "", language.native_name);
        option.value = language.locale; select.append(option);
      }
      select.value = current;
    }
    languageActions = []; packActions = [];
    byId("settings-language-list").replaceChildren(); byId("settings-pack-list").replaceChildren();
    for (const language of languages) {
      const card = node("article", "language-card");
      const heading = node("div", "language-card-heading");
      heading.append(node("span", "language-code", language.locale.toUpperCase()), node("span", language.source === "installed" ? "badge" : "badge neutral", t(language.source === "installed" ? "Installed" : "Included")));
      card.append(heading, node("h3", "", language.native_name));
      if (language.name !== language.native_name) card.append(node("p", "language-native-name", language.name));
      card.append(node("p", "language-description", t(language.locale === "en" ? "English is the source language and fallback." : language.source === "installed" ? "Installed on this recorder." : "Included with the application.")));
      const count = node("div", "language-count");
      count.append(node("span", "", coverage(language.translated, language.total)));
      const use = action(current === language.locale ? "Active language" : "Use language", () => chooseLanguage(language.locale), language.locale, "use");
      use.dataset.active = String(current === language.locale);
      card.append(count, use); languageActions.push(use); byId("settings-language-list").append(card);

      const packCard = node("article", "language-pack-card"), info = node("div");
      info.append(node("h3", "", language.native_name), node("p", "", `${language.locale} · ${t(language.source === "installed" ? "Installed" : "Included")} · ${coverage(language.translated, language.total)}`));
      const controls = node("div", "language-pack-actions");
      const download = action("Download", () => downloadPack(language.locale), language.locale, "download");
      controls.append(download); packActions.push(download);
      if (language.source === "installed" && language.locale !== "en") {
        const remove = action(language.locale === "it" ? "Restore included Italian" : "Remove", () => removePack(language), language.locale, "remove", "button quiet danger small-button");
        controls.append(remove); packActions.push(remove);
      }
      packCard.append(info, controls); byId("settings-pack-list").append(packCard);
    }
    updateActions();
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return "—";
    let size = value, unit = 0; const units = ["B", "KB", "MB", "GB", "TB"];
    while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
    return size.toLocaleString(i18n.locale(), {maximumFractionDigits: 1}) + " " + units[unit];
  }

  function relabel() {
    byId("settings-version").textContent = system?.version || "—";
    byId("settings-disk-free").textContent = system ? formatBytes(system.disk?.free) : "—";
    byId("settings-segment-duration").textContent = !system ? "—" : system.segment_seconds % 60 === 0 ? t("{count} minutes", {count: system.segment_seconds / 60}) : t("{count} seconds", {count: system.segment_seconds});
    for (const [id, active, maximum] of [["settings-live-streams", live?.active_streams, live?.max_streams], ["settings-live-transcodes", live?.active_transcodes, live?.max_transcodes]]) byId(id).textContent = live ? t("{active} / {maximum}", {active, maximum}) : "—";
    renderLanguages(); renderSelection();
    for (const [id, source] of banners) { byId(id).textContent = t(source.key, source.params); byId(id).hidden = false; }
  }

  async function open() {
    selectTab(tab); relabel();
    if (!authenticated || busy) return;
    const ticket = authEpoch, request = ++openEpoch;
    const results = await Promise.allSettled([i18n.refreshLanguages(), api("/api/system"), api("/api/live/status")]);
    if (!validAuth(ticket) || request !== openEpoch) return;
    if (results[1].status === "fulfilled") system = results[1].value;
    if (results[2].status === "fulfilled") live = results[2].value;
    const failed = results.find((result) => result.status === "rejected");
    if (failed) errorMessage(failed.reason); else message("settings-error");
    relabel();
  }

  function validatePack(pack) {
    const fields = ["format", "version", "locale", "name", "native_name", "translations"];
    if (!pack || typeof pack !== "object" || Array.isArray(pack) || Object.keys(pack).length !== fields.length || fields.some((key) => !Object.prototype.hasOwnProperty.call(pack, key))) throw new Error("Invalid language pack.");
    if (pack.format !== "nvr-sr81.language-pack" || pack.version !== 1) throw new Error("Unsupported language pack format or version.");
    if (typeof pack.locale !== "string" || pack.locale.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(pack.locale)) throw new Error("Invalid language code.");
    try { new Intl.DateTimeFormat(pack.locale); }
    catch (_) { throw new Error("Invalid language code."); }
    const parts = pack.locale.split("-");
    const locale = [parts[0].toLowerCase(), ...parts.slice(1).map((value) => value.length === 4 && /^[A-Za-z]+$/.test(value) ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value.length === 2 && /^[A-Za-z]+$/.test(value) ? value.toUpperCase() : value.toLowerCase())].join("-");
    if (locale === "en") throw new Error("The included English language pack cannot be changed.");
    if ([pack.name, pack.native_name].some((value) => typeof value !== "string" || !value.trim() || value.length > 80)) throw new Error("Invalid language pack.");
    if (!pack.translations || typeof pack.translations !== "object" || Array.isArray(pack.translations) || Object.keys(pack.translations).length > 2000) throw new Error("A language pack can contain at most 2000 translations.");
    const source = new Set(i18n.getSourceKeys ? i18n.getSourceKeys() : i18n.getEntries("en").map((entry) => entry.key));
    if (!source.size) throw new Error("Language files are unavailable. Try again.");
    const tokens = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((item) => item[1]).sort().join("|");
    let translated = 0;
    for (const [key, value] of Object.entries(pack.translations)) {
      if (!source.has(key)) throw new Error("The language pack contains unknown English source keys.");
      if (!key || key.length > 500 || typeof value !== "string" || value.length > 2000) throw new Error("Invalid language pack.");
      if (value.trim()) {
        if (tokens(key) !== tokens(value)) throw new Error("Translation placeholders must match the English source.");
        translated += 1;
      }
    }
    return {pack: {...pack, locale, name: pack.name.trim(), native_name: pack.native_name.trim()}, translated, total: source.size};
  }

  async function chooseFile(event) {
    if (!authenticated || busy) return;
    const file = event.target.files?.[0]; event.target.value = "";
    const ticket = authEpoch, request = ++fileEpoch;
    selection = null; reading = !!file; message("settings-error"); message("settings-notice"); renderSelection();
    if (!file) return;
    try {
      if (!Number.isFinite(file.size) || file.size > maximumBytes) throw new Error("Language pack file is too large.");
      const raw = await file.text();
      if (!validAuth(ticket) || request !== fileEpoch) return;
      if (typeof raw !== "string" || new Blob([raw]).size > maximumBytes) throw new Error("Language pack file is too large.");
      let pack;
      try { pack = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch (_) { throw new Error("Invalid language pack."); }
      await i18n.ready;
      if (!validAuth(ticket) || request !== fileEpoch) return;
      selection = {...validatePack(pack), raw, filename: file.name || t("Language file")};
      message("settings-notice", "Language file ready. Review the details, then install it.");
    } catch (error) { if (validAuth(ticket) && request === fileEpoch) errorMessage(error); }
    finally { if (validAuth(ticket) && request === fileEpoch) { reading = false; renderSelection(); } }
  }

  async function installPack() {
    if (!authenticated || busy || reading || !selection) return;
    const ticket = authEpoch, operation = ++operationEpoch, chosen = selection;
    openEpoch += 1; busy = true; message("settings-error"); message("settings-notice"); updateActions();
    try {
      await api("/api/languages/install", {method: "POST", rawBody: chosen.raw});
      if (!validOperation(ticket, operation)) return;
      selection = null; fileEpoch += 1; renderSelection();
      await i18n.refreshLanguages();
      if (!validOperation(ticket, operation)) return;
      message("settings-notice", "Language pack installed.");
    } catch (error) { if (validOperation(ticket, operation)) errorMessage(error); }
    finally { if (validOperation(ticket, operation)) { busy = false; relabel(); } }
  }

  async function chooseLanguage(locale) {
    if (busy) return;
    const request = ++languageEpoch, ticket = authEpoch;
    try {
      await i18n.setLanguage(locale);
      if (request === languageEpoch && ticket === authEpoch) message("settings-notice", "Language saved for this browser.");
    } catch (error) { if (request === languageEpoch && ticket === authEpoch) { errorMessage(error); renderLanguages(); } }
  }

  async function downloadPack(locale = null) {
    if (!authenticated || busy) return;
    const ticket = authEpoch, operation = ++operationEpoch;
    busy = true; updateActions(); message("settings-error");
    let objectUrl;
    try {
      const pack = await api(locale ? "/api/languages/" + encodeURIComponent(locale) : "/api/languages/template");
      if (!validOperation(ticket, operation)) return;
      const blob = new Blob([JSON.stringify(pack, null, 2) + "\n"], {type: "application/json"});
      objectUrl = URL.createObjectURL(blob);
      const link = node("a"); link.href = objectUrl; link.download = locale ? `nvr-sr81-${locale}.json` : "nvr-sr81-language-template.json";
      document.body.append(link); link.click(); link.remove();
      message("settings-notice", locale ? "Language pack downloaded." : "Language template downloaded.");
    } catch (error) { if (validOperation(ticket, operation)) errorMessage(error); }
    finally {
      if (objectUrl) { const url = objectUrl; setTimeout(() => URL.revokeObjectURL(url), 1000); }
      if (validOperation(ticket, operation)) { busy = false; updateActions(); }
    }
  }

  async function removePack(language) {
    if (!authenticated || busy || language.source !== "installed" || language.locale === "en") return;
    if (!window.confirm(t(language.locale === "it" ? "Restore the included Italian language pack?" : "Remove the installed language pack {name}?", {name: language.native_name}))) return;
    const ticket = authEpoch, operation = ++operationEpoch;
    openEpoch += 1; busy = true; updateActions(); message("settings-error"); message("settings-notice");
    try {
      const result = await api("/api/languages/" + encodeURIComponent(language.locale), {method: "DELETE"});
      if (!validOperation(ticket, operation)) return;
      await i18n.refreshLanguages();
      if (!validOperation(ticket, operation)) return;
      message("settings-notice", result.restored ? "Included language pack restored." : "Language pack removed.");
    } catch (error) { if (validOperation(ticket, operation)) errorMessage(error); }
    finally { if (validOperation(ticket, operation)) { busy = false; relabel(); } }
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
  for (const id of ["settings-language", "login-language"]) byId(id).addEventListener("change", (event) => chooseLanguage(event.target.value));
  byId("settings-pack-file").addEventListener("change", chooseFile);
  byId("settings-pack-install").addEventListener("click", installPack);
  byId("settings-pack-template").addEventListener("click", () => downloadPack());
  byId("settings-monitor-layout").addEventListener("change", (event) => {
    const layout = Number(event.target.value);
    if (![1, 4, 9, 16].includes(layout)) return;
    try { localStorage.setItem("nvr.monitor.layout", String(layout)); } catch (_) { /* Session preference still works. */ }
    window.dispatchEvent(new CustomEvent("nvr-monitor-layoutchange", {detail: {layout}}));
    message("settings-notice", "Default monitor layout saved for this browser.");
  });
  byId("settings-monitor-layout").value = "4";
  try { const value = localStorage.getItem("nvr.monitor.layout"); if (["1", "4", "9", "16"].includes(value)) byId("settings-monitor-layout").value = value; } catch (_) { /* Four-camera default. */ }
  window.addEventListener("nvr-languagechange", relabel);
  window.addEventListener("nvr-languageschange", renderLanguages);
  window.addEventListener("nvr-authchange", (event) => {
    authenticated = !!event.detail.authenticated;
    authEpoch += 1; fileEpoch += 1; operationEpoch += 1; openEpoch += 1; languageEpoch += 1;
    selection = null; reading = busy = false; system = live = null;
    message("settings-error"); message("settings-notice"); relabel();
  });
  window.NvrSettings = Object.freeze({open, relabel});
  selectTab(tab); relabel();
  Promise.resolve(i18n.ready).then(relabel).catch(errorMessage);
})();
