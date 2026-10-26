"use strict";
// All account operations use an isolated fake API, never a running recorder.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/users-settings.js"), "utf8");
const P = ["live", "recordings", "download", "cameras", "network", "settings", "system", "maintenance", "archive_delete"];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function environment() {
  const nodes = new Map(), events = new Map(), emitted = [], calls = [];
  let language = "en", actor, stored;
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map((node) => node.textContent).join(""); }
    set innerHTML(_) { throw Error("HTML insertion forbidden"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ""; this.children = [...children]; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    async fire(type) { const event = {target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }}; for (const listener of this.listeners.get(type) || []) await listener(event); return event; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
  }
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("app").hidden = byId("settings-view").hidden = byId("settings-users-panel").hidden = true;
  const user = (id, extra = {}) => ({id, username: id === "builtin-admin" ? "admin" : id, display_name: id, role: "user", permissions: ["live"], camera_scope: "all", camera_ids: [], enabled: true, builtin: false, ...extra});
  actor = user("builtin-admin", {role: "admin", builtin: true, permissions: [...P]}); stored = [actor, user("viewer")];
  const cameras = [{id: "camera-a", name: "Front gate"}, {id: "camera-b", name: "Yard"}];
  const defaultApi = async (path, options) => {
    if (path === "/api/cameras") return cameras;
    if (path === "/api/users" && !options.method) return {users: stored, permissions: P};
    if (path === "/api/users/me/password") return {password_changed: true, reauthentication_required: true};
    if (path === "/api/users" && options.method === "POST") { const value = user("created", {...options.body}); delete value.password; stored.push(value); return value; }
    const id = decodeURIComponent(path.slice("/api/users/".length));
    if (options.method === "DELETE") { stored = stored.filter((item) => item.id !== id); return {deleted: true}; }
    if (options.method === "PUT") { const value = {...stored.find((item) => item.id === id), ...options.body}; delete value.password; stored = stored.map((item) => item.id === id ? value : item); return value; }
    throw Error("Unexpected fake API request");
  };
  let handler = defaultApi;
  const context = vm.createContext({console, AbortController, Promise, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    api(path, options = {}) { calls.push({path, options}); return handler(path, options); }});
  context.window = context; context.document = {getElementById: byId, createElement: (tag) => new Element(tag)};
  context.NvrI18n = {ready: Promise.resolve(), t(key, params = {}) { return (language === "it" && key === "Edit user" ? "Modifica utente" : key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token); }};
  context.NvrAccess = {isAdmin: () => actor?.role === "admin", user: () => actor};
  context.addEventListener = (type, listener) => { if (!events.has(type)) events.set(type, []); events.get(type).push(listener); };
  context.dispatchEvent = (event) => { emitted.push(event); for (const listener of events.get(event.type) || []) listener(event); return true; };
  const emit = (type, detail = {}) => context.dispatchEvent(new context.CustomEvent(type, {detail}));
  vm.runInContext(source, context, {filename: "users-settings.js"});
  return {context, byId, calls, emitted, user, emit, defaultApi,
    handler(value) { handler = value; }, users(value) { stored = value; }, access(value) { actor = value; emit("nvr-accesschange"); },
    async auth(value) { byId("app").hidden = !value; emit("nvr-authchange", {authenticated: value}); await flush(); },
    async open() { byId("settings-view").hidden = byId("settings-users-panel").hidden = false; emit("nvr-settings-tabchange", {tab: "users"}); await flush(); },
    async input(id, value) { byId(id).value = value; await byId(id).fire(id === "user-username" || id === "user-display-name" ? "input" : "change"); },
    async check(id, value) { byId(id).checked = value; await byId(id).fire("change"); },
    row(username) { return byId("users-list").children.find((row) => row.children[0]?.children.some((item) => item.textContent.startsWith(username + " · "))); },
    async edit(username) { await this.row(username).children[1].children[0].fire("click"); },
    async remove(username) { await this.row(username).children[1].children[1].fire("click"); },
    async save() { return byId("user-editor-form").fire("submit"); },
    async language(value) { language = value; emit("nvr-languagechange"); await flush(); },
  };
}
const mutations = (env) => env.calls.filter((call) => call.options.method);
const busy = (env) => env.emitted.filter((event) => event.type === "nvr-users-busychange").map((event) => event.detail.busy);

test("Users is failclosed without admin access and only loads users/cameras on its authenticated visible tab", async () => {
  const env = environment(); await flush(); assert.equal(env.calls.length, 0); await env.auth(true); await env.context.NvrUsersSettings.open(); assert.equal(env.calls.length, 0);
  env.access(env.user("viewer")); await env.open(); assert.equal(env.calls.length, 0); assert.equal(env.byId("users-add").disabled, true);
  delete env.context.NvrAccess; await env.context.NvrUsersSettings.open(); assert.equal(env.calls.length, 0);
});

test("creating a scoped Live user sends explicit permissions and selected cameras without logging into that account", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.byId("users-add").fire("click");
  assert.equal(env.byId("user-camera-scope").value, "selected"); assert.equal(env.byId("user-camera-list").children.every((label) => !label.children[0].checked), true);
  await env.input("user-username", "  Viewer.New "); await env.input("user-display-name", "Gate operator"); env.byId("user-password").value = "new-password-123";
  await env.input("user-camera-scope", "selected"); const camera = env.byId("user-camera-list").children[0].children[0]; camera.checked = true; await camera.fire("change");
  assert.equal(mutations(env).length, 0); await env.save();
  const write = mutations(env)[0]; assert.equal(write.path, "/api/users"); assert.equal(write.options.method, "POST"); assert.equal(write.options.body.username, "viewer.new");
  assert.deepEqual(Array.from(write.options.body.permissions), ["live"]); assert.deepEqual(Array.from(write.options.body.camera_ids), ["camera-a"]); assert.equal(write.options.body.camera_scope, "selected");
  assert.equal(env.context.NvrAccess.user().username, "admin"); assert.equal(env.calls.some((call) => call.path === "/api/login"), false); assert.equal(env.byId("user-password").value, "");
});

test("username, password length and display-name validation reject invalid drafts without any account write", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.byId("users-add").fire("click");
  await env.input("user-username", "xy"); env.byId("user-password").value = "valid-password-123"; await env.save(); assert.equal(mutations(env).length, 0); assert.match(env.byId("user-editor-error").textContent, /3–32/);
  await env.input("user-username", "valid-name"); env.byId("user-password").value = "too-short"; await env.save(); assert.equal(mutations(env).length, 0); assert.match(env.byId("user-editor-error").textContent, /12–1024/);
  env.byId("user-password").value = "valid-password-123"; await env.input("user-display-name", "bad\u202ename"); await env.save(); assert.equal(mutations(env).length, 0); assert.match(env.byId("user-editor-error").textContent, /control characters/);
});

test("presets and custom permissions enforce download dependencies and disallow archive deletion for selected scopes", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.byId("users-add").fire("click");
  await env.input("user-preset", "recordings"); assert.equal(env.byId("user-permission-recordings").checked, true); assert.equal(env.byId("user-permission-download").checked, false);
  await env.input("user-preset", "custom"); assert.equal(env.byId("user-preset").value, "custom");
  await env.check("user-permission-download", true); assert.equal(env.byId("user-permission-recordings").checked, true);
  await env.check("user-permission-recordings", false); assert.equal(env.byId("user-permission-download").checked, false);
  await env.check("user-permission-archive_delete", true); await env.input("user-camera-scope", "selected"); assert.equal(env.byId("user-permission-archive_delete").checked, false); assert.equal(env.byId("user-permission-archive_delete").disabled, true);
  await env.input("user-preset", "admin"); assert.equal(env.byId("user-permissions").hidden, true); assert.equal(env.byId("user-camera-access").hidden, true);
  await env.input("user-preset", "live"); assert.equal(env.byId("user-camera-scope").value, "selected"); assert.equal(env.byId("user-camera-list").children.every((label) => !label.children[0].checked), true);
  await env.input("user-preset", "admin");
  await env.input("user-username", "another-admin"); env.byId("user-password").value = "admin-password-123"; await env.save();
  assert.equal(mutations(env)[0].options.body.role, "admin"); assert.equal(mutations(env)[0].options.body.camera_scope, "all"); assert.equal(mutations(env)[0].options.body.permissions.length, 9);
});

test("editing never retrieves or refills a password; blank omits it and another user's explicit reset is sent once", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer");
  assert.equal(env.byId("user-password").value, ""); await env.input("user-display-name", "Operator"); await env.save();
  assert.equal(mutations(env)[0].path, "/api/users/viewer"); assert.equal(Object.hasOwn(mutations(env)[0].options.body, "password"), false);
  await env.edit("viewer"); env.byId("user-password").value = "reset-password-123"; await env.language("it"); assert.equal(env.byId("user-password").value, "reset-password-123");
  assert.equal(env.byId("user-editor-title").textContent, "Modifica utente"); await env.save(); assert.equal(mutations(env)[1].options.body.password, "reset-password-123"); assert.equal(env.byId("user-password").value, "");
});

test("built-in and self accounts cannot be deleted, disabled or demoted, and own edits request reauthentication", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("admin");
  assert.equal(env.byId("user-username").disabled, true); assert.equal(env.byId("user-preset").disabled, true); assert.equal(env.byId("user-enabled").disabled, true); assert.equal(env.byId("user-password-row").hidden, true);
  await env.input("user-preset", "live"); await env.check("user-enabled", false); await env.input("user-username", "changed-name");
  await env.save(); const payload = mutations(env)[0].options.body; assert.equal(payload.username, "admin"); assert.equal(payload.role, "admin"); assert.equal(payload.enabled, true); assert.equal(Object.hasOwn(payload, "password"), false);
  assert.equal(env.emitted.filter((event) => event.type === "nvr-user-sessionchanged").length, 1);
  await env.remove("admin"); assert.equal(env.byId("user-delete-dialog").open, false); assert.equal(mutations(env).length, 1);
});

test("delete is two-click named confirmation, cancel does nothing and duplicate submits cannot repeat deletion", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.remove("viewer");
  assert.match(env.byId("user-delete-description").textContent, /viewer.*cannot be undone/); assert.equal(mutations(env).length, 0);
  await env.byId("user-delete-cancel").fire("click"); assert.equal(env.byId("user-delete-dialog").open, false); assert.equal(mutations(env).length, 0);
  await env.remove("viewer"); const pending = deferred(); env.handler(() => pending.promise); const deleting = env.byId("user-delete-form").fire("submit");
  await env.byId("user-delete-form").fire("submit"); const escape = await env.byId("user-delete-dialog").fire("cancel"); assert.equal(escape.defaultPrevented, true); assert.equal(mutations(env).length, 1);
  pending.resolve({deleted: true}); await deleting; assert.equal(env.row("viewer"), undefined); assert.deepEqual(busy(env), [true, false]);
});

test("own password requires current/new/matching confirmation, clears secrets and emits reauthentication without changing user automatically", async () => {
  const env = environment(); await env.auth(true); await env.open(); env.byId("users-current-password").value = "current-pass"; env.byId("users-new-password").value = "new-password-123"; env.byId("users-confirm-password").value = "different";
  await env.byId("users-password-form").fire("submit"); assert.equal(mutations(env).length, 0);
  env.byId("users-confirm-password").value = "new-password-123"; await env.byId("users-password-form").fire("submit");
  const write = mutations(env)[0]; assert.equal(write.path, "/api/users/me/password"); assert.equal(write.options.method, "POST"); assert.equal(write.options.body.current_password, "current-pass");
  assert.equal(env.emitted.filter((event) => event.type === "nvr-password-changed").length, 1);
  for (const id of ["users-current-password", "users-new-password", "users-confirm-password"]) assert.equal(env.byId(id).value, "");
  assert.equal(env.context.NvrAccess.user().username, "admin");
});

test("all secrets clear on tab exit and logout, while language changes preserve only the current in-memory draft", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer"); await env.input("user-display-name", "Unsaved");
  env.byId("user-password").value = "draft-password-123"; env.byId("users-new-password").value = "another-password-123";
  await env.language("it"); assert.equal(env.byId("user-display-name").value, "Unsaved"); assert.equal(env.byId("user-password").value, "draft-password-123");
  env.emit("nvr-settings-tabchange", {tab: "general"}); assert.equal(env.byId("user-password").value, ""); assert.equal(env.byId("users-new-password").value, ""); assert.equal(env.byId("user-editor-dialog").open, false);
  await env.open(); env.byId("users-current-password").value = "old-secret"; await env.auth(false); assert.equal(env.byId("users-current-password").value, ""); assert.equal(env.byId("users-list").textContent.includes("viewer"), false);
});

test("cross-operation locks do not echo their busy state and prevent account mutation", async () => {
  const env = environment(); await env.auth(true); await env.open();
  for (const event of ["settings", "general", "system", "archive"]) { env.emit("nvr-" + event + "-busychange", {busy: true}); await env.byId("users-add").fire("click"); assert.equal(env.byId("user-editor-dialog").open, false); env.emit("nvr-" + event + "-busychange", {busy: false}); }
  assert.deepEqual(busy(env), []); assert.equal(mutations(env).length, 0);
});

test("known validation failures keep the editor, while an uncertain write closes secrets and requires a read-only refresh before retry", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer");
  env.handler(async () => { throw Object.assign(Error("Username already exists."), {status: 409}); }); await env.save();
  assert.equal(env.byId("user-editor-dialog").open, true); assert.equal(env.byId("user-editor-error").textContent, "Username already exists.");
  env.handler(async () => { throw Error("Network unavailable"); }); env.byId("user-password").value = "reset-password-123"; await env.save();
  assert.equal(env.byId("user-editor-dialog").open, false); assert.equal(env.byId("user-password").value, ""); assert.equal(env.byId("users-add").disabled, true);
  const before = mutations(env).length; await env.byId("users-add").fire("click"); assert.equal(mutations(env).length, before);
  env.handler(env.defaultApi); await env.byId("users-refresh").fire("click"); assert.equal(env.calls.at(-1).options.method, undefined); assert.equal(env.byId("users-add").disabled, false);
});

test("logout and lost admin access abort pending work; late responses cannot reopen or mutate a new session", async () => {
  const env = environment(); await env.auth(true); const pending = deferred(); env.handler(() => pending.promise); await env.open(); const signal = env.calls[0].options.signal;
  env.access(env.user("viewer")); assert.equal(signal.aborted, true); pending.resolve({users: [], permissions: P}); await flush(); assert.equal(env.byId("users-add").disabled, true);
  env.access(env.user("builtin-admin", {role: "admin", builtin: true, permissions: P})); env.handler(env.defaultApi); await env.open(); await env.edit("viewer");
  const old = deferred(); env.handler(() => old.promise); const saving = env.save(); await env.auth(false); assert.equal(env.calls.at(-1).options.signal.aborted, true);
  old.resolve(env.user("viewer", {display_name: "Stale"})); await saving; assert.equal(env.byId("users-list").textContent.includes("Stale"), false); assert.equal(env.byId("user-editor-dialog").open, false);
});

test("an old session's user write cannot close or unlock a new session's pending editor", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer");
  const old = deferred(), latest = deferred(); let writes = 0;
  env.handler((path, options) => options.method === "PUT" ? (++writes === 1 ? old.promise : latest.promise) : env.defaultApi(path, options));
  const first = env.save(); await env.auth(false); await env.auth(true); await env.open(); await env.edit("viewer"); await env.input("user-display-name", "New session"); const second = env.save();
  old.resolve(env.user("viewer", {display_name: "Old session"})); await first;
  assert.equal(env.byId("user-editor-dialog").open, true); assert.equal(env.byId("user-display-name").value, "New session"); assert.equal(env.byId("user-editor-save").disabled, true);
  latest.resolve(env.user("viewer", {display_name: "New session"})); await second; assert.equal(env.byId("user-editor-dialog").open, false); assert.equal(mutations(env).length, 2);
});

test("user data is inert text and the login, Users tab and two dialogs have unique accessible markup", async () => {
  const env = environment(); await env.auth(true); env.users([env.user("viewer", {display_name: '<img src=x onerror="bad()">'})]); await env.open(); assert.ok(env.byId("users-list").textContent.includes('<img src=x onerror="bad()">'));
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]); assert.equal(ids.length, new Set(ids).size);
  assert.match(html, /id="username"[^>]*value="admin"[^>]*maxlength="32"[^>]*autocomplete="username"/);
  assert.match(html, /id="settings-tab-users"[^>]*aria-controls="settings-users-panel"[^>]*hidden/);
  assert.match(html, /<dialog id="user-delete-dialog"[^>]*aria-labelledby="user-delete-title"[^>]*aria-describedby="user-delete-description"/);
  assert.match(html, /id="users-new-password"[^>]*minlength="12"/); assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|password_hash/);
});

test("unchanged background busy notices do not rebuild a user's camera choices during editing", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer");
  const choices = env.byId("user-camera-list").children;
  const first = choices[0];
  for (const name of ["settings", "general", "system", "archive"]) env.emit("nvr-" + name + "-busychange", {busy: false});
  assert.equal(env.byId("user-camera-list").children[0], first);
  assert.equal(env.byId("user-editor-dialog").open, true);
});

test("leaving the browser page clears every password and closes an idle user editor", async () => {
  const env = environment(); await env.auth(true); await env.open(); await env.edit("viewer");
  for (const id of ["user-password", "users-current-password", "users-new-password", "users-confirm-password"]) env.byId(id).value = "fixture-secret-only";
  const count = mutations(env).length;
  env.emit("pagehide");
  for (const id of ["user-password", "users-current-password", "users-new-password", "users-confirm-password"]) assert.equal(env.byId(id).value, "");
  assert.equal(env.byId("user-editor-dialog").open, false);
  assert.equal(mutations(env).length, count);
});
