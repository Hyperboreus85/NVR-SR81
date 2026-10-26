"use strict";

(() => {
  const byId = (id) => document.getElementById(id), panel = byId("settings-users-panel");
  if (!panel) return;
  const i18n = window.NvrI18n, t = (key, params) => i18n.t(key, params);
  const PERMISSIONS = ["live", "recordings", "download", "cameras", "network", "settings", "system", "maintenance", "archive_delete"];
  const LABELS = {live: "Live viewing", recordings: "View recordings", download: "Download recordings", cameras: "Manage cameras", network: "Network discovery", settings: "Recorder settings", system: "System information", maintenance: "Restart and reboot", archive_delete: "Delete recording archive"};
  let authenticated = !byId("app").hidden, authEpoch = 0, requestEpoch = 0, controller = null;
  let users = [], cameras = [], loaded = false, camerasReady = false, loading = false, busy = false, uncertain = false, publishedBusy = false;
  let external = {settings: false, general: false, system: false, archive: false};
  let editing = null, draft = null, deleting = null, opener = null, errorSource = null, noticeSource = null;
  const admin = () => window.NvrAccess?.isAdmin() === true;
  const currentId = () => window.NvrAccess?.user()?.id;
  const visible = () => !byId("settings-view").hidden && !panel.hidden;
  const blocked = () => busy || uncertain || Object.values(external).some(Boolean);
  const valid = (ticket, request) => authenticated && admin() && ticket === authEpoch && request === requestEpoch;
  const text = (value) => typeof value === "string";
  const control = (value) => /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
  function node(tag, className, value) { const item = document.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = value; return item; }
  function message(id, value) { byId(id).hidden = !value; byId(id).textContent = value ? t(value.key, value.params) : ""; }
  function clearSecrets() { for (const id of ["user-password", "users-current-password", "users-new-password", "users-confirm-password"]) byId(id).value = ""; }
  function checkedUser(value) {
    if (!value || !text(value.id) || !value.id || value.id.length > 128 || !text(value.username) || !value.username || value.username.length > 32
        || !text(value.display_name) || value.display_name.length > 80 || !["admin", "user"].includes(value.role)
        || !Array.isArray(value.permissions) || value.permissions.some((name) => !PERMISSIONS.includes(name))
        || !["all", "selected"].includes(value.camera_scope) || !Array.isArray(value.camera_ids) || value.camera_ids.length > 4096 || value.camera_ids.some((id) => !text(id) || !id || id.length > 128)
        || typeof value.enabled !== "boolean" || typeof value.builtin !== "boolean") throw Error("User details are unavailable. Refresh the user list.");
    return {id: value.id, username: value.username, display_name: value.display_name, role: value.role, permissions: [...new Set(value.permissions)], camera_scope: value.camera_scope, camera_ids: [...new Set(value.camera_ids)], enabled: value.enabled, builtin: value.builtin};
  }
  function preset(value) {
    if (value.role === "admin") return "admin";
    const names = [...value.permissions].sort().join(",");
    return names === "live" ? "live" : names === "live,recordings" ? "recordings" : "custom";
  }
  function protectedUser(user) { return user?.builtin || user?.id === currentId(); }
  function renderList() {
    const list = byId("users-list"); list.replaceChildren();
    if (!users.length) { list.append(node("p", "users-empty", t(loading ? "Loading users…" : loaded ? "No users found." : "Refresh to load users."))); return; }
    for (const user of users) {
      const row = node("article", "users-row"), copy = node("div", "users-row-copy"), actions = node("div", "users-row-actions");
      copy.append(node("strong", "", user.display_name || user.username), node("span", "", user.username + " · " + t(user.role === "admin" ? "Administrator" : "User") + " · " + t(user.enabled ? "Enabled" : "Disabled")));
      const scope = user.camera_scope === "all" ? t("All cameras") : t(user.camera_ids.length === 1 ? "1 camera" : "{count} cameras", {count: user.camera_ids.length});
      const grants = user.role === "admin" ? t("Administrator") : user.permissions.map((name) => t(LABELS[name])).join(" · ") || t("No access assigned");
      copy.append(node("small", "", `${grants} · ${scope}`));
      if (user.builtin || user.id === currentId()) copy.append(node("small", "", t(user.builtin ? "Built-in administrator" : "Your account")));
      for (const [label, handler] of [["Edit", () => editUser(user)], ["Delete", () => confirmDelete(user)]]) {
        const button = node("button", "button " + (label === "Delete" ? "quiet danger" : "secondary") + " small-button", t(label)); button.type = "button";
        button.disabled = !authenticated || !admin() || loading || blocked() || label === "Delete" && protectedUser(user);
        button.addEventListener("click", handler); actions.append(button);
      }
      row.append(copy, actions); list.append(row);
    }
  }
  function renderDraft() {
    if (!draft) return;
    const self = editing?.id === currentId(), protectedRole = protectedUser(editing), administrator = draft.role === "admin";
    byId("user-editor-title").textContent = t(editing ? "Edit user" : "Add user");
    byId("user-username").value = draft.username; byId("user-display-name").value = draft.display_name;
    byId("user-preset").value = draft.preset || preset(draft); byId("user-enabled").checked = draft.enabled; byId("user-camera-scope").value = draft.camera_scope;
    byId("user-username").disabled = busy || !!editing?.builtin; byId("user-display-name").disabled = busy;
    byId("user-preset").disabled = busy || protectedRole; byId("user-enabled").disabled = busy || protectedRole;
    byId("user-password-row").hidden = self;
    byId("user-password-label").textContent = t(editing ? "Reset password (optional)" : "Password");
    byId("user-password").required = !editing; byId("user-password").disabled = busy || self;
    byId("user-password-help").textContent = t(editing ? "Leave blank to keep the current password." : "Use at least 12 characters.");
    byId("user-admin-note").hidden = !administrator; byId("user-permissions").hidden = administrator; byId("user-camera-access").hidden = administrator;
    byId("user-protected-note").hidden = !protectedRole;
    byId("user-protected-note").textContent = t(editing?.builtin ? "The built-in administrator cannot be renamed, disabled, demoted or deleted." : "You cannot disable, demote or delete your own account.");
    byId("user-self-note").hidden = !self;
    for (const name of PERMISSIONS) {
      const input = byId("user-permission-" + name); input.checked = draft.permissions.includes(name);
      input.disabled = busy || name === "archive_delete" && draft.camera_scope === "selected";
    }
    byId("user-camera-scope").disabled = busy;
    byId("user-camera-choices").hidden = draft.camera_scope !== "selected";
    const selected = byId("user-camera-list"); selected.replaceChildren();
    if (!camerasReady) selected.append(node("p", "field-help", t("Camera list unavailable. Refresh before assigning cameras.")));
    else if (!cameras.length) selected.append(node("p", "field-help", t("No cameras configured.")));
    for (const camera of cameras) {
      const label = node("label", "check-label"), input = node("input"); input.type = "checkbox"; input.checked = draft.camera_ids.includes(camera.id); input.disabled = busy;
      input.addEventListener("change", () => { if (busy || !draft) return; draft.camera_ids = input.checked ? [...new Set([...draft.camera_ids, camera.id])] : draft.camera_ids.filter((id) => id !== camera.id); });
      label.append(input, node("span", "", camera.name)); selected.append(label);
    }
    for (const id of ["user-editor-cancel", "user-editor-close"]) byId(id).disabled = busy;
    byId("user-editor-save").disabled = !authenticated || !admin() || blocked() || loading || draft.camera_scope === "selected" && !camerasReady;
    byId("user-editor-save").textContent = t(busy ? "Saving…" : editing ? "Save user" : "Create user");
  }
  function render() {
    renderList(); renderDraft();
    byId("users-add").disabled = !authenticated || !admin() || !loaded || loading || blocked();
    byId("users-refresh").disabled = !authenticated || !admin() || loading || busy || Object.values(external).some(Boolean);
    byId("users-status").textContent = t(busy ? "Saving…" : loading ? "Loading users…" : uncertain ? "Refresh the user list before trying again." : "");
    panel.setAttribute("aria-busy", String(loading || busy));
    message("users-error", byId("user-editor-dialog").open || byId("user-delete-dialog").open ? null : errorSource);
    message("user-editor-error", byId("user-editor-dialog").open ? errorSource : null);
    message("user-delete-error", byId("user-delete-dialog").open ? errorSource : null);
    message("users-notice", noticeSource);
    for (const id of ["users-current-password", "users-new-password", "users-confirm-password", "users-password-save"]) byId(id).disabled = !authenticated || !admin() || blocked();
    for (const id of ["user-delete-cancel", "user-delete-close"]) byId(id).disabled = busy;
    byId("user-delete-submit").disabled = !deleting || protectedUser(deleting) || !authenticated || !admin() || blocked();
    const ownBusy = authenticated && busy;
    if (ownBusy !== publishedBusy) { publishedBusy = ownBusy; window.dispatchEvent(new CustomEvent("nvr-users-busychange", {detail: {busy: ownBusy}})); }
  }
  function abort() { controller?.abort(); controller = null; requestEpoch += 1; }
  function closeDialogs() {
    for (const id of ["user-editor-dialog", "user-delete-dialog"]) if (byId(id).open) byId(id).close();
    editing = draft = deleting = null; byId("user-password").value = "";
    if (authenticated && visible() && opener && !opener.disabled) opener.focus(); opener = null;
  }
  function close() { clearSecrets(); if (!busy) { abort(); loading = false; closeDialogs(); render(); } }
  async function open() {
    if (!authenticated || !admin() || !visible() || busy || Object.values(external).some(Boolean)) return;
    abort(); const ticket = authEpoch, request = requestEpoch, current = new AbortController(); controller = current; loading = true; errorSource = null; render();
    try {
      const results = await Promise.allSettled([api("/api/users", {signal: current.signal}), api("/api/cameras", {signal: current.signal})]);
      if (!valid(ticket, request) || !visible()) return;
      if (results[0].status !== "fulfilled") throw results[0].reason;
      const response = results[0].value;
      if (!response || !Array.isArray(response.users) || response.users.length > 1000 || !Array.isArray(response.permissions) || response.permissions.some((name) => !PERMISSIONS.includes(name))) throw Error("User details are unavailable. Refresh the user list.");
      users = response.users.map(checkedUser); loaded = true; uncertain = false;
      camerasReady = results[1].status === "fulfilled" && Array.isArray(results[1].value);
      cameras = camerasReady ? results[1].value.filter((camera) => camera && text(camera.id) && text(camera.name)).map((camera) => ({id: camera.id, name: camera.name})) : [];
      if (!camerasReady) noticeSource = {key: "Camera list unavailable. Refresh before assigning cameras."};
    } catch (error) { if (valid(ticket, request) && error?.name !== "AbortError") { loaded = false; errorSource = {key: error?.message || "Unable to load users. Try again.", params: error?.i18nParams}; } }
    finally { if (valid(ticket, request)) { controller = null; loading = false; render(); } }
  }
  function editUser(user = null) {
    if (!authenticated || !admin() || loading || blocked() || !loaded) return;
    closeDialogs(); editing = user;
    draft = user ? {...user, permissions: [...user.permissions], camera_ids: [...user.camera_ids]} : {username: "", display_name: "", role: "user", permissions: ["live"], camera_scope: "selected", camera_ids: [], enabled: true};
    errorSource = noticeSource = null; opener = byId("users-add"); byId("user-password").value = "";
    byId("user-editor-dialog").showModal(); render(); byId("user-username").focus();
  }
  function confirmDelete(user) {
    if (!authenticated || !admin() || loading || blocked() || protectedUser(user)) return;
    closeDialogs(); deleting = user; errorSource = noticeSource = null; opener = byId("users-refresh");
    byId("user-delete-description").textContent = t("Delete user {username}? This cannot be undone.", {username: user.username});
    byId("user-delete-dialog").showModal(); render(); byId("user-delete-cancel").focus();
  }
  function payload() {
    const username = draft.username.trim().toLowerCase(), display = draft.display_name.trim(), password = byId("user-password").value;
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) throw Error("Use 3–32 letters, numbers, dots, underscores or hyphens for the username.");
    if (display.length > 80 || control(display)) throw Error("Display name must be at most 80 characters without control characters.");
    if ((!editing || password) && (password.length < 12 || password.length > 1024)) throw Error("Use a password of 12–1024 characters.");
    const administrator = draft.role === "admin", permissions = administrator ? [...PERMISSIONS] : [...draft.permissions];
    if (permissions.includes("download") && !permissions.includes("recordings")) throw Error("Downloads require permission to view recordings.");
    if (!administrator && draft.camera_scope === "selected" && permissions.includes("archive_delete")) throw Error("Archive deletion requires access to all cameras.");
    const value = {username, display_name: display, role: draft.role, permissions, camera_scope: administrator ? "all" : draft.camera_scope, camera_ids: administrator || draft.camera_scope === "all" ? [] : [...draft.camera_ids], enabled: draft.enabled};
    if (editing?.builtin) { value.username = editing.username; value.role = "admin"; value.enabled = true; }
    if (editing?.id === currentId()) { value.role = editing.role; value.enabled = true; }
    if (!editing || password && editing.id !== currentId()) value.password = password;
    return value;
  }
  async function mutate(kind, body, target = null) {
    abort(); const ticket = authEpoch, request = requestEpoch, current = new AbortController(); controller = current; busy = true; errorSource = noticeSource = null; render();
    try {
      const path = kind === "password" ? "/api/users/me/password" : target ? "/api/users/" + encodeURIComponent(target.id) : "/api/users";
      const result = await api(path, {method: kind === "delete" ? "DELETE" : target ? "PUT" : "POST", ...(kind === "delete" ? {} : {body}), signal: current.signal});
      if (!valid(ticket, request)) return;
      if (kind === "password") {
        if (!result || result.password_changed !== true || result.reauthentication_required !== true) throw Error("The password change could not be confirmed. Sign in again before retrying.");
        clearSecrets(); window.dispatchEvent(new CustomEvent("nvr-password-changed")); return;
      }
      if (kind === "delete") {
        if (result?.deleted !== true) throw Error("The user change could not be confirmed. Refresh the user list.");
        users = users.filter((user) => user.id !== target.id); noticeSource = {key: "User deleted."};
      } else {
        const saved = checkedUser(result); users = users.filter((user) => user.id !== saved.id); users.push(saved);
        noticeSource = {key: target ? "User saved." : "User created."};
        if (saved.id === currentId()) { closeDialogs(); clearSecrets(); window.dispatchEvent(new CustomEvent("nvr-user-sessionchanged", {detail: {user: saved}})); return; }
      }
      closeDialogs();
    } catch (error) {
      if (valid(ticket, request)) {
        errorSource = {key: error?.message || "Unable to save the user. Try again.", params: error?.i18nParams};
        if (!Number.isInteger(error?.status) || error.status >= 500) { uncertain = true; clearSecrets(); closeDialogs(); noticeSource = {key: "Refresh the user list before trying again."}; }
      }
    } finally { if (valid(ticket, request)) { controller = null; busy = false; render(); } }
  }
  byId("users-refresh").addEventListener("click", open);
  byId("users-add").addEventListener("click", () => editUser());
  byId("user-editor-form").addEventListener("submit", (event) => { event.preventDefault(); if (!authenticated || !admin() || blocked() || loading || !draft || !byId("user-editor-dialog").open) return; try { return mutate("save", payload(), editing); } catch (error) { errorSource = {key: error.message}; render(); } });
  byId("user-delete-form").addEventListener("submit", (event) => { event.preventDefault(); if (authenticated && admin() && !blocked() && deleting && !protectedUser(deleting) && byId("user-delete-dialog").open) return mutate("delete", null, deleting); });
  byId("users-password-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (!authenticated || !admin() || blocked()) return;
    const current = byId("users-current-password").value, password = byId("users-new-password").value, confirm = byId("users-confirm-password").value;
    if (!current || current.length > 1024 || password.length < 12 || password.length > 1024 || confirm !== password) { errorSource = {key: confirm !== password ? "New passwords do not match." : "Enter the current password and a new password of 12–1024 characters."}; render(); return; }
    return mutate("password", {current_password: current, new_password: password, confirm_password: confirm});
  });
  for (const [id, key] of [["user-username", "username"], ["user-display-name", "display_name"]]) byId(id).addEventListener("input", () => { if (!busy && draft) draft[key] = byId(id).value; });
  byId("user-enabled").addEventListener("change", () => { if (!busy && draft && !protectedUser(editing)) draft.enabled = byId("user-enabled").checked; });
  byId("user-preset").addEventListener("change", () => {
    if (busy || !draft || protectedUser(editing)) return;
    const choice = byId("user-preset").value, wasAdmin = draft.role === "admin"; draft.preset = choice; draft.role = choice === "admin" ? "admin" : "user";
    if (choice !== "custom") draft.permissions = choice === "admin" ? [...PERMISSIONS] : choice === "recordings" ? ["live", "recordings"] : ["live"];
    if (choice === "admin") { draft.camera_scope = "all"; draft.camera_ids = []; }
    else if (wasAdmin) { draft.camera_scope = "selected"; draft.camera_ids = []; }
    renderDraft();
  });
  byId("user-camera-scope").addEventListener("change", () => { if (!busy && draft) { draft.camera_scope = byId("user-camera-scope").value; if (draft.camera_scope === "selected") draft.permissions = draft.permissions.filter((name) => name !== "archive_delete"); renderDraft(); } });
  for (const name of PERMISSIONS) byId("user-permission-" + name).addEventListener("change", () => {
    if (busy || !draft || draft.role === "admin") return;
    draft.preset = "custom";
    draft.permissions = byId("user-permission-" + name).checked ? [...new Set([...draft.permissions, name])] : draft.permissions.filter((item) => item !== name);
    if (name === "download" && draft.permissions.includes(name)) draft.permissions = [...new Set([...draft.permissions, "recordings"])];
    if (!draft.permissions.includes("recordings")) draft.permissions = draft.permissions.filter((item) => item !== "download"); renderDraft();
  });
  for (const id of ["user-editor-cancel", "user-editor-close", "user-delete-cancel", "user-delete-close"]) byId(id).addEventListener("click", () => { if (!busy) { closeDialogs(); render(); } });
  for (const id of ["user-editor-dialog", "user-delete-dialog"]) {
    byId(id).addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
    byId(id).addEventListener("close", () => { byId("user-password").value = ""; });
  }
  window.addEventListener("nvr-settings-tabchange", (event) => { if (event.detail.tab === "users") open(); else close(); });
  window.addEventListener("pagehide", close);
  for (const name of Object.keys(external)) window.addEventListener("nvr-" + name + "-busychange", (event) => {
    const value = !!event.detail.busy;
    if (external[name] !== value) { external[name] = value; render(); }
  });
  window.addEventListener("nvr-languagechange", () => { if (deleting) byId("user-delete-description").textContent = t("Delete user {username}? This cannot be undone.", {username: deleting.username}); render(); });
  window.addEventListener("nvr-accesschange", () => { if (!admin()) { authEpoch += 1; abort(); busy = loading = false; closeDialogs(); clearSecrets(); users = cameras = []; loaded = false; } render(); });
  window.addEventListener("nvr-authchange", (event) => { authenticated = !!event.detail.authenticated; authEpoch += 1; abort(); busy = loading = uncertain = loaded = camerasReady = false; users = cameras = []; external = {settings: false, general: false, system: false, archive: false}; errorSource = noticeSource = null; closeDialogs(); clearSecrets(); render(); });
  window.NvrUsersSettings = Object.freeze({open, close, relabel: render});
  render(); Promise.resolve(i18n.ready).then(render).catch(() => {});
})();
