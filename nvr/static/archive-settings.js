"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const root = byId("archive-settings"), panel = byId("settings-system-panel"), dialog = byId("archive-clear-dialog");
  if (!root || !panel || !dialog) return;
  const i18n = window.NvrI18n, t = (key, params) => i18n.t(key, params);
  let authenticated = !byId("app").hidden, authEpoch = 0, requestEpoch = 0;
  let status = null, result = null, loading = false, submitting = false, uncertain = false, mustCheck = false;
  let settingsBusy = false, systemBusy = false, generalBusy = false, publishedBusy = false, controller = null, opener = null;
  let errorSource = null, noticeSource = null;

  const valid = (ticket, request) => authenticated && ticket === authEpoch && request === requestEpoch;
  const visible = () => !byId("settings-view").hidden && !panel.hidden;
  const externalBusy = () => settingsBusy || systemBusy || generalBusy;
  const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  function number(value, digits = 0) {
    try { return value.toLocaleString(i18n.locale?.() || "en", {maximumFractionDigits: digits}); }
    catch (_) { return value.toLocaleString("en", {maximumFractionDigits: digits}); }
  }
  function bytes(value) {
    const units = ["B", "KB", "MB", "GB", "TB", "PB"]; let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
    return number(value, unit ? 1 : 0) + " " + units[unit];
  }
  function source(error, fallback) { return {key: error?.message || fallback, params: error?.i18nParams}; }
  function banner(id, value) {
    const node = byId(id); node.hidden = !value; node.textContent = value ? t(value.key, value.params) : "";
  }
  function publishBusy() {
    const busy = authenticated && (submitting || uncertain || status?.clearing === true);
    if (busy === publishedBusy) return;
    publishedBusy = busy;
    window.dispatchEvent(new CustomEvent("nvr-archive-busychange", {detail: {busy}}));
  }
  function canDelete() { return authenticated && !!status && !status.clearing && !loading && !submitting && !uncertain && !mustCheck && !externalBusy(); }
  function render() {
    const count = status ? number(status.recordings_count) : "—", size = status ? bytes(status.recordings_bytes) : "—";
    for (const id of ["archive-count", "archive-confirm-count"]) byId(id).textContent = count;
    for (const id of ["archive-bytes", "archive-confirm-bytes"]) byId(id).textContent = size;
    byId("archive-status").textContent = t(submitting ? "Deleting recordings…" : loading ? "Checking archive…"
      : uncertain ? "The previous deletion request could not be confirmed. Check archive status."
      : status?.clearing ? "Archive cleanup is in progress. Check status before continuing."
      : externalBusy() ? "Wait for the current settings operation to finish."
      : mustCheck ? "Check archive status before confirming again."
      : status ? "Archive ready" : "Archive details have not loaded.");
    root.setAttribute("aria-busy", String(loading || submitting));
    byId("archive-clear-open").disabled = !canDelete();
    for (const id of ["archive-refresh", "archive-confirm-refresh"]) byId(id).disabled = !authenticated || loading || submitting || externalBusy();
    byId("archive-confirm-refresh").hidden = !mustCheck && !uncertain && !status?.clearing;
    for (const id of ["archive-clear-cancel", "archive-clear-close"]) byId(id).disabled = submitting;
    byId("archive-clear-submit").disabled = !dialog.open || !canDelete();
    byId("archive-clear-submit").textContent = t(submitting ? "Deleting recordings…" : "Delete all recordings");
    banner("archive-settings-error", dialog.open ? null : errorSource);
    banner("archive-confirm-error", dialog.open ? errorSource : null);
    let notice = noticeSource;
    if (result) notice = {key: "Deleted {count} recordings and {files} files ({size}).", params: {count: number(result.deleted_recordings), files: number(result.deleted_files), size: bytes(result.deleted_bytes)}};
    banner("archive-settings-notice", dialog.open ? null : notice);
    banner("archive-confirm-notice", dialog.open ? noticeSource : null);
    banner("archive-skipped", result?.skipped_files ? {key: "{count} files could not be removed. Check archive status before trying again.", params: {count: number(result.skipped_files)}} : null);
    publishBusy();
  }
  function checkedStatus(value) {
    if (!value || !safeInteger(value.recordings_count) || !safeInteger(value.recordings_bytes) || typeof value.clearing !== "boolean") throw new Error("Archive details are unavailable. Check the connection and try again.");
    return {recordings_count: value.recordings_count, recordings_bytes: value.recordings_bytes, clearing: value.clearing};
  }
  function checkedResult(value) {
    if (!value || ["deleted_files", "deleted_recordings", "deleted_bytes", "skipped_files"].some((key) => !safeInteger(value[key]))) throw new Error("The deletion response could not be confirmed. Check archive status before continuing.");
    return {deleted_files: value.deleted_files, deleted_recordings: value.deleted_recordings, deleted_bytes: value.deleted_bytes, skipped_files: value.skipped_files};
  }
  function abortRequest() { controller?.abort(); controller = null; requestEpoch += 1; }
  async function load() {
    if (!authenticated || submitting || !visible() || externalBusy()) return false;
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, current = new AbortController();
    controller = current; loading = true; errorSource = null; render();
    try {
      const value = checkedStatus(await api("/api/settings/archive", {signal: current.signal}));
      if (!valid(ticket, request) || !visible()) return false;
      status = value; mustCheck = false;
      if (value.clearing) {
        noticeSource = {key: "Archive cleanup is in progress. Check status before continuing."};
      } else if (uncertain) {
        uncertain = false;
        noticeSource = {key: "Archive status checked. The previous request outcome is unknown. Review the counts before starting another deletion."};
      } else if (!result) noticeSource = null;
      return !value.clearing;
    } catch (error) {
      if (valid(ticket, request) && error?.name !== "AbortError") {
        status = null; mustCheck = true;
        errorSource = source(error, "Archive details are unavailable. Check the connection and try again.");
      }
      return false;
    } finally {
      if (valid(ticket, request)) { controller = null; loading = false; render(); }
    }
  }
  function closeDialog() {
    const previous = opener; opener = null;
    if (dialog.open) dialog.close();
    if (authenticated && visible() && previous) previous.focus();
  }
  async function confirmAction() {
    if (!canDelete()) return;
    const ticket = authEpoch;
    // Refresh the summary before requesting irreversible confirmation.
    if (!await load() || ticket !== authEpoch || !canDelete() || !visible()) return;
    result = null; errorSource = noticeSource = null; opener = byId("archive-clear-open");
    dialog.showModal(); render(); byId("archive-clear-cancel").focus();
  }
  async function submit(event) {
    event.preventDefault();
    if (!dialog.open || !canDelete()) return;
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, current = new AbortController();
    controller = current; submitting = true; errorSource = noticeSource = null; result = null; render();
    let completed = false;
    try {
      window.dispatchEvent(new CustomEvent("nvr-archive-beforeclear"));
      if (!valid(ticket, request)) return;
      const value = checkedResult(await api("/api/settings/archive/clear", {method: "POST", body: {confirmation: "DELETE"}, signal: current.signal}));
      if (!valid(ticket, request)) return;
      result = value; status = null; mustCheck = false; uncertain = false; completed = true; closeDialog();
      window.dispatchEvent(new CustomEvent("nvr-archive-cleared", {detail: {...value}}));
    } catch (error) {
      if (valid(ticket, request)) {
        // A lost or malformed response may follow a completed deletion. Never retry the POST.
        const refused = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
        uncertain = !refused; mustCheck = true; status = null;
        errorSource = source(error, "The deletion response could not be confirmed. Check archive status before continuing.");
        noticeSource = {key: refused ? "The deletion request was refused. Check archive status before confirming again." : "This request will not be sent again automatically. Check archive status before continuing."};
      }
    } finally {
      if (valid(ticket, request)) { controller = null; submitting = false; render(); }
    }
    if (completed && authenticated && ticket === authEpoch && visible()) await load();
  }
  function close() {
    if (submitting) return;
    abortRequest(); loading = false; closeDialog(); render();
  }

  byId("archive-refresh").addEventListener("click", load);
  byId("archive-confirm-refresh").addEventListener("click", load);
  byId("archive-clear-open").addEventListener("click", confirmAction);
  byId("archive-clear-form").addEventListener("submit", submit);
  for (const id of ["archive-clear-cancel", "archive-clear-close"]) byId(id).addEventListener("click", () => { if (!submitting) { closeDialog(); render(); } });
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", render);
  window.addEventListener("nvr-settings-tabchange", (event) => { if (event.detail.tab === "system") load(); else close(); });
  window.addEventListener("nvr-settings-busychange", (event) => { settingsBusy = !!event.detail.busy; render(); });
  window.addEventListener("nvr-system-busychange", (event) => { systemBusy = !!event.detail.busy; render(); });
  window.addEventListener("nvr-general-busychange", (event) => { generalBusy = !!event.detail.busy; render(); });
  window.addEventListener("nvr-languagechange", render);
  window.addEventListener("nvr-authchange", (event) => {
    authenticated = !!event.detail.authenticated; authEpoch += 1; abortRequest();
    loading = submitting = uncertain = mustCheck = settingsBusy = systemBusy = generalBusy = false; status = result = errorSource = noticeSource = null;
    closeDialog(); render();
  });
  window.NvrArchiveSettings = Object.freeze({open: load, relabel: render, close});
  render(); Promise.resolve(i18n.ready).then(render).catch(() => {});
})();
