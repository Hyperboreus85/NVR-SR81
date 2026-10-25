"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const panel = byId("settings-system-panel"), dialog = byId("system-confirm-dialog");
  if (!panel || !dialog) return;
  const i18n = window.NvrI18n, t = (key, params) => i18n.t(key, params);
  const actions = {
    "restart-service": {capability: "service_restart", word: "RESTART", title: "Restart the NVR service?", label: "Restart service", description: "Recording and live viewing will pause briefly while the NVR service restarts."},
    "reboot-system": {capability: "system_reboot", word: "REBOOT", title: "Reboot the recorder system?", label: "Reboot system", description: "Recording and live viewing will be unavailable while the recorder system restarts. This may take a few minutes."},
  };
  let authenticated = !byId("app").hidden, authEpoch = 0, requestEpoch = 0;
  let capability = null, loading = false, submitting = false, externalBusy = false;
  let controller = null, selectedAction = null, opener = null, waiting = null, connectionChecked = false;
  let errorSource = null, noticeSource = null;

  function source(error, fallback) { return {key: error?.message || fallback, params: error?.i18nParams}; }
  function valid(ticket, request) { return authenticated && ticket === authEpoch && request === requestEpoch; }
  function isVisible() { return !byId("settings-view").hidden && !panel.hidden; }
  function targetLabel() { return capability ? t(capability.target === "container" ? "NVR container" : capability.target === "machine" ? "Local recorder machine" : "Unavailable") : "—"; }
  function canAction(action) {
    return !!actions[action] && authenticated && !loading && !submitting && !externalBusy && !waiting && !!capability && capability.target !== "unavailable" && capability[actions[action].capability] === true && !capability.pending_action;
  }
  function banner(id, value) {
    byId(id).hidden = !value;
    byId(id).textContent = value ? t(value.key, value.params) : "";
  }
  function render() {
    byId("system-target").textContent = targetLabel();
    byId("system-status").textContent = t(loading ? "Checking system availability…" : submitting ? "Sending request…" : waiting ? connectionChecked ? "Recorder reachable" : "Waiting for the recorder" : externalBusy ? "Wait for the current settings operation to finish." : !capability ? "Check which actions are available on this installation." : capability.service_restart || capability.system_reboot ? "Available actions" : "System actions unavailable");
    byId("system-reason").textContent = capability?.reason ? t(capability.reason) : "";
    byId("system-reason").hidden = !capability?.reason;
    byId("system-restart-service").disabled = !canAction("restart-service");
    byId("system-reboot-system").disabled = !canAction("reboot-system");
    byId("system-refresh").hidden = !!waiting;
    byId("system-refresh").disabled = !authenticated || loading || submitting;
    byId("system-wait-box").hidden = !waiting;
    byId("system-reconnect").disabled = !authenticated || loading || submitting;
    byId("system-reload").disabled = !authenticated || !connectionChecked || loading || submitting;
    panel.setAttribute("aria-busy", String(loading || submitting));
    banner("system-error", errorSource); banner("system-notice", noticeSource);
    const action = actions[selectedAction];
    if (action) {
      byId("system-confirm-title").textContent = t(action.title);
      byId("system-confirm-description").textContent = t(action.description);
      byId("system-confirm-target").textContent = targetLabel();
      byId("system-confirm-hint").textContent = t("Type {word} to confirm.", {word: action.word});
      byId("system-confirm-input").placeholder = action.word;
      byId("system-confirm-submit").dataset.action = selectedAction;
      byId("system-confirm-submit").textContent = t(submitting ? "Sending request…" : action.label);
    }
    byId("system-confirm-input").disabled = submitting;
    byId("system-confirm-cancel").disabled = submitting;
    byId("system-confirm-close").disabled = submitting;
    byId("system-confirm-submit").disabled = !action || !canAction(selectedAction) || byId("system-confirm-input").value !== action.word;
  }
  function checkedStatus(value) {
    if (!value || typeof value.service_restart !== "boolean" || typeof value.system_reboot !== "boolean" || !["container", "machine", "unavailable"].includes(value.target) || value.pending_action !== null && !["restart-service", "reboot-system"].includes(value.pending_action) || !Number.isInteger(value.retry_after) || value.retry_after < 0 || value.retry_after > 60 || !Number.isInteger(value.delay_seconds) || value.delay_seconds < 0 || value.delay_seconds > 60 || value.reason !== null && typeof value.reason !== "string") throw new Error("System status is unavailable. Check the connection and try again.");
    return value;
  }
  function abortRequest() { controller?.abort(); controller = null; requestEpoch += 1; }
  async function load(reconnect = false) {
    if (!authenticated || submitting || !isVisible() || reconnect && !waiting) return;
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, current = new AbortController();
    controller = current; loading = true; capability = null; connectionChecked = false; errorSource = null; render();
    try {
      const result = checkedStatus(await api("/api/settings/system", {signal: current.signal}));
      if (!valid(ticket, request)) return;
      capability = result;
      if (result.pending_action) {
        waiting ||= {action: result.pending_action};
        noticeSource = {key: "A maintenance action is already scheduled. Please wait before trying again."};
      } else if (waiting) {
        connectionChecked = true;
        noticeSource = {key: "Recorder is reachable. Reload this page to reconnect."};
      } else noticeSource = null;
    } catch (error) {
      if (valid(ticket, request) && error?.name !== "AbortError") errorSource = source(error, "System status is unavailable. Check the connection and try again.");
    } finally {
      if (valid(ticket, request)) { controller = null; loading = false; render(); }
    }
  }
  function closeDialog() {
    const previous = opener; opener = null; selectedAction = null; byId("system-confirm-input").value = "";
    if (dialog.open) dialog.close();
    if (authenticated && previous) previous.focus();
  }
  function confirmAction(action, button) {
    if (!canAction(action)) return;
    selectedAction = action; opener = button; byId("system-confirm-input").value = ""; render();
    dialog.showModal(); byId("system-confirm-input").focus();
  }
  async function submit(event) {
    event.preventDefault();
    const action = selectedAction, definition = actions[action];
    if (!dialog.open || !definition || !canAction(action) || byId("system-confirm-input").value !== definition.word) return;
    abortRequest();
    const ticket = authEpoch, request = requestEpoch, current = new AbortController();
    controller = current; submitting = true; errorSource = noticeSource = null; render();
    try {
      const result = await api("/api/settings/system/action", {method: "POST", body: {action, confirmation: definition.word}, signal: current.signal});
      if (!valid(ticket, request)) return;
      if (!result || result.accepted !== true || result.action !== action || !Number.isInteger(result.delay_seconds) || result.delay_seconds < 0 || result.delay_seconds > 60) throw new Error("The action response could not be confirmed. Check the connection before trying again.");
      waiting = {action}; connectionChecked = false;
      noticeSource = {key: typeof result.message === "string" && result.message ? result.message : action === "restart-service" ? "The NVR service will restart in a few seconds." : "This system will reboot in a few seconds."};
      closeDialog();
    } catch (error) {
      if (valid(ticket, request) && error?.name !== "AbortError") {
        // A lost response can follow an accepted command. Never repeat the POST.
        waiting = {action, uncertain: true}; connectionChecked = false;
        errorSource = source(error, "The action response could not be confirmed. Check the connection before trying again.");
        noticeSource = {key: "The request will not be sent again automatically. Check the connection before continuing."};
        closeDialog();
      }
    } finally {
      if (valid(ticket, request)) { controller = null; submitting = false; render(); }
    }
  }

  byId("system-refresh").addEventListener("click", () => load());
  byId("system-reconnect").addEventListener("click", () => load(true));
  byId("system-reload").addEventListener("click", () => { if (authenticated && connectionChecked && !loading && !submitting) window.location.reload(); });
  byId("system-restart-service").addEventListener("click", (event) => confirmAction("restart-service", event.currentTarget || byId("system-restart-service")));
  byId("system-reboot-system").addEventListener("click", (event) => confirmAction("reboot-system", event.currentTarget || byId("system-reboot-system")));
  byId("system-confirm-form").addEventListener("submit", submit);
  byId("system-confirm-input").addEventListener("input", render);
  for (const id of ["system-confirm-close", "system-confirm-cancel"]) byId(id).addEventListener("click", () => { if (!submitting) { closeDialog(); render(); } });
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  dialog.addEventListener("close", () => { selectedAction = null; byId("system-confirm-input").value = ""; render(); });
  window.addEventListener("nvr-settings-tabchange", (event) => {
    if (event.detail.tab === "system") load();
    else if (!submitting) { abortRequest(); loading = false; closeDialog(); render(); }
  });
  window.addEventListener("nvr-settings-busychange", (event) => { externalBusy = !!event.detail.busy; render(); });
  window.addEventListener("nvr-languagechange", render);
  window.addEventListener("nvr-authchange", (event) => {
    authenticated = !!event.detail.authenticated; authEpoch += 1; abortRequest();
    loading = submitting = externalBusy = false; capability = waiting = null; connectionChecked = false; errorSource = noticeSource = null;
    closeDialog(); render();
  });
  window.NvrSystemSettings = Object.freeze({open: () => load(), relabel: render});
  render(); Promise.resolve(i18n.ready).then(render).catch(() => {});
})();
