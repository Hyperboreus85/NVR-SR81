"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("general-settings-form"), panel = byId("settings-general-panel");
  if (!form || !panel) return;
  const i18n = window.NvrI18n, t = (key, params) => i18n.t(key, params);
  const fields = {recorder_name: "general-recorder-name", timezone: "general-timezone", hour_format: "general-hour-format", rotation_seconds: "general-rotation"};
  let authenticated = !byId("app").hidden, authEpoch = 0, requestEpoch = 0, editRevision = 0;
  let data = null, draft = null, identity = null, loading = false, saving = false, failed = false;
  let controller = null, settingsBusy = false, systemBusy = false, archiveBusy = false, usersBusy = false, publishedBusy = false;
  let errorSource = null, noticeSource = null, optionsSignature = "";
  const visible = () => !byId("settings-view").hidden && !panel.hidden;
  const valid = (ticket, request) => authenticated && ticket === authEpoch && request === requestEpoch;
  const externalBusy = () => settingsBusy || systemBusy || archiveBusy || usersBusy;
  const allowed = () => window.NvrAccess ? window.NvrAccess.can("settings") : true;
  const cleanText = (value, maximum = 300) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
  const controlCharacters = (value) => /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
  const zone = (value) => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(value);
  const countries = (value) => Array.isArray(value) && value.length <= 32 && value.every((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code));
  const settings = (value) => ({recorder_name: value.recorder_name, timezone: value.timezone, hour_format: value.hour_format, rotation_seconds: value.rotation_seconds});
  function dirty() { return !!data && !!draft && Object.keys(fields).some((key) => draft[key] !== data[key]); }
  function draftError() {
    if (!draft || !data) return "General settings have not loaded.";
    if (draft.recorder_name.length > 80 || controlCharacters(draft.recorder_name)) return "Use a recorder name of up to 80 characters without control characters.";
    if (draft.timezone !== "auto" && !data.timezones.includes(draft.timezone)) return "Choose an available time zone.";
    if (!["24", "12"].includes(draft.hour_format)) return "Choose a 12-hour or 24-hour clock.";
    if (!Number.isInteger(draft.rotation_seconds) || !data.allowed_rotation_seconds.includes(draft.rotation_seconds)) return "Choose one of the available rotation intervals.";
    return "";
  }
  function checked(value) {
    if (!value || typeof value.recorder_name !== "string" || !value.recorder_name.trim() || value.recorder_name.length > 80 || controlCharacters(value.recorder_name)
        || !Array.isArray(value.timezones) || !value.timezones.length || value.timezones.length > 4097 || value.timezones.some((name) => !zone(name))
        || value.timezone !== "auto" && !value.timezones.includes(value.timezone) || !["24", "12"].includes(value.hour_format)
        || !Array.isArray(value.allowed_rotation_seconds) || !value.allowed_rotation_seconds.length || value.allowed_rotation_seconds.some((seconds) => !Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
        || !Number.isInteger(value.rotation_seconds) || !value.allowed_rotation_seconds.includes(value.rotation_seconds)
        || !value.system || value.system.hostname !== null && typeof value.system.hostname !== "string" || !Array.isArray(value.system.addresses) || value.system.addresses.length > 64 || value.system.addresses.some((address) => typeof address !== "string")
        || !zone(value.effective_timezone) || !countries(value.country_codes) || !countries(value.system.country_codes)
        || value.system.timezone !== null && !zone(value.system.timezone)) throw new Error("General settings are unavailable. Try again.");
    return {...settings(value), timezones: [...new Set(value.timezones)], allowed_rotation_seconds: [...new Set(value.allowed_rotation_seconds)],
      effective_timezone: value.effective_timezone, country_codes: [...value.country_codes],
      system: {hostname: cleanText(value.system.hostname), addresses: value.system.addresses.map((address) => cleanText(address, 200)).filter(Boolean), timezone: value.system.timezone,
        country_codes: [...value.system.country_codes], source: cleanText(value.system.source)}};
  }
  function option(value, text, disabled = false) {
    const node = document.createElement("option"); node.value = String(value); node.textContent = text; node.disabled = disabled; return node;
  }
  function renderOptions() {
    const signature = JSON.stringify([data?.timezones, data?.allowed_rotation_seconds, data?.system.timezone, draft?.timezone, i18n.locale?.()]);
    if (signature === optionsSignature) return;
    optionsSignature = signature;
    const timezone = byId(fields.timezone), rotation = byId(fields.rotation_seconds), hours = byId(fields.hour_format);
    const automatic = t("Automatic (system)") + (data?.system.timezone ? ` · ${data.system.timezone}` : "");
    timezone.replaceChildren(option("auto", automatic), ...(data?.timezones || []).map((name) => option(name, name)));
    if (draft?.timezone && draft.timezone !== "auto" && !data?.timezones.includes(draft.timezone)) timezone.append(option(draft.timezone, draft.timezone, true));
    rotation.replaceChildren(...(data?.allowed_rotation_seconds || []).map((seconds) => option(seconds, t(seconds === 0 ? "Off" : "Every {count} seconds", {count: seconds}))));
    hours.replaceChildren(option("24", t("24-hour")), option("12", t("12-hour")));
  }
  function countryLabel() {
    if (!data || !draft) return "—";
    const codes = draft.timezone === "auto" ? data.system.country_codes : draft.timezone === data.timezone ? data.country_codes
      : draft.timezone === data.effective_timezone ? data.country_codes : draft.timezone === data.system.timezone ? data.system.country_codes : null;
    if (codes === null) return t("Available after saving.");
    if (!codes.length) return t("No country for this time zone.");
    let names;
    try { names = new Intl.DisplayNames([i18n.locale?.() || "en"], {type: "region"}); } catch (_) { /* Country codes remain readable if region names are unavailable. */ }
    return [...new Set(codes)].map((code) => { try { return names?.of(code) || code; } catch (_) { return code; } }).join(" · ");
  }
  function message(id, value) { byId(id).hidden = !value; byId(id).textContent = value ? t(value.key, value.params) : ""; }
  function render() {
    renderOptions();
    for (const [key, id] of Object.entries(fields)) {
      const value = draft ? String(draft[key]) : "";
      if (byId(id).value !== value) byId(id).value = value;
      byId(id).disabled = !authenticated || !allowed() || !data || saving || externalBusy();
    }
    const source = identity || data?.system;
    byId("general-recorder-name").placeholder = source?.hostname || "NVR-SR81";
    byId("general-hostname").textContent = source?.hostname || "—";
    byId("general-addresses").textContent = source?.addresses?.join(" · ") || "—";
    byId("general-country").textContent = countryLabel();
    byId("general-status").textContent = t(saving ? "Saving general settings…" : loading ? "Loading general settings…" : externalBusy() ? "Wait for the current settings operation to finish."
      : !data ? "General settings have not loaded." : dirty() ? "Unsaved changes" : "Saved on this recorder.");
    byId("general-save").disabled = !authenticated || !allowed() || !data || loading || saving || externalBusy() || !dirty() || !!draftError();
    byId("general-save").textContent = t(saving ? "Saving…" : "Save general settings");
    byId("general-retry").hidden = !failed; byId("general-retry").disabled = !authenticated || loading || saving || externalBusy();
    form.setAttribute("aria-busy", String(loading || saving));
    message("general-error", errorSource); message("general-notice", noticeSource);
    const busy = authenticated && saving;
    if (busy !== publishedBusy) { publishedBusy = busy; window.dispatchEvent(new CustomEvent("nvr-general-busychange", {detail: {busy}})); }
  }
  function abortRequest() { controller?.abort(); controller = null; requestEpoch += 1; }
  function eventDetail() { return {...settings(data), effective_timezone: data.effective_timezone, country_codes: [...data.country_codes], system: {...data.system, addresses: [...data.system.addresses], country_codes: [...data.system.country_codes]}}; }
  async function open() {
    if (!authenticated || !allowed() || saving || !visible() || externalBusy()) return;
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, revision = editRevision, preserve = dirty(), current = new AbortController();
    controller = current; loading = true; failed = false; errorSource = null; render();
    try {
      const value = checked(await api("/api/settings/general", {signal: current.signal}));
      if (!valid(ticket, request) || !visible()) return;
      data = value;
      if (!preserve && revision === editRevision) draft = settings(value);
      optionsSignature = "";
    } catch (error) {
      if (valid(ticket, request) && error?.name !== "AbortError") { failed = true; errorSource = {key: error?.message || "General settings are unavailable. Try again.", params: error?.i18nParams}; }
    } finally { if (valid(ticket, request)) { controller = null; loading = false; render(); } }
  }
  async function save(event) {
    event.preventDefault();
    if (!authenticated || !allowed() || !visible() || loading || saving || externalBusy() || !data || !dirty()) return;
    const error = draftError(); if (error) { errorSource = {key: error}; render(); return; }
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, current = new AbortController(), payload = {...draft, recorder_name: draft.recorder_name.trim()};
    controller = current; saving = true; errorSource = noticeSource = null; failed = false; render();
    try {
      const value = checked(await api("/api/settings/general", {method: "PUT", body: payload, signal: current.signal}));
      if (!valid(ticket, request)) return;
      data = value; draft = settings(value); optionsSignature = "";
      noticeSource = {key: "General settings saved."};
      window.dispatchEvent(new CustomEvent("nvr-general-settingschange", {detail: eventDetail()}));
    } catch (error) {
      if (valid(ticket, request)) { errorSource = {key: error?.message || "General settings could not be saved. Try again.", params: error?.i18nParams}; }
    } finally { if (valid(ticket, request)) { controller = null; saving = false; render(); } }
  }
  function setIdentity(snapshot) {
    if (!authenticated) return;
    const value = snapshot?.identity || snapshot?.system || snapshot;
    if (!value || value.hostname !== null && typeof value.hostname !== "string" || !Array.isArray(value.addresses) || value.addresses.some((address) => typeof address !== "string")) return;
    identity = {hostname: cleanText(value.hostname), addresses: value.addresses.slice(0, 64).map((address) => cleanText(address, 200)).filter(Boolean)};
    render();
  }
  function relabel() { optionsSignature = ""; render(); }
  for (const [key, id] of Object.entries(fields)) byId(id).addEventListener(key === "recorder_name" ? "input" : "change", () => {
    if (!authenticated || !allowed() || !data || saving || externalBusy()) return;
    draft ||= settings(data);
    const value = byId(id).value; draft[key] = key === "rotation_seconds" ? /^\d+$/.test(value) ? Number(value) : NaN : value;
    editRevision += 1; errorSource = noticeSource = null; render();
  });
  form.addEventListener("submit", save);
  byId("general-retry").addEventListener("click", open);
  window.addEventListener("nvr-settings-tabchange", (event) => {
    if (event.detail.tab === "general") open();
    else if (!saving) { abortRequest(); loading = false; render(); }
  });
  for (const [event, update] of [["nvr-settings-busychange", (value) => { settingsBusy = value; }], ["nvr-system-busychange", (value) => { systemBusy = value; }], ["nvr-archive-busychange", (value) => { archiveBusy = value; }]]) window.addEventListener(event, (value) => { update(!!value.detail.busy); render(); });
  window.addEventListener("nvr-users-busychange", (event) => { usersBusy = !!event.detail.busy; render(); });
  window.addEventListener("nvr-languagechange", relabel);
  window.addEventListener("nvr-authchange", (event) => {
    authenticated = !!event.detail.authenticated; authEpoch += 1; abortRequest(); editRevision += 1;
    data = draft = identity = errorSource = noticeSource = null; loading = saving = failed = settingsBusy = systemBusy = archiveBusy = usersBusy = false; optionsSignature = ""; render();
  });
  window.NvrGeneralSettings = Object.freeze({open, relabel, setIdentity});
  render(); Promise.resolve(i18n.ready).then(relabel).catch(() => {});
})();
