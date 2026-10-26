"use strict";
// Actual app/access/camera-editor controllers, with a DOM and fetch boundary only.
// Every camera and deletion below is an in-memory fixture; no network is used.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");

const harnessPath = join(__dirname, "test_navigation_ui.cjs");
const harnessText = readFileSync(harnessPath, "utf8"), firstTest = harnessText.indexOf('\ntest("');
assert.ok(firstTest > 0, "The shared DOM harness must precede its tests");
let harness = harnessText.slice(0, firstTest);
function replaceOnce(before, after) { assert.equal(harness.split(before).length, 2, before); harness = harness.replace(before, after); }
replaceOnce("querySelector(selector) { if (!this.selectors)", 'querySelector(selector) { if (/^#[A-Za-z0-9_-]+$/.test(selector) && this.lookup) return this.lookup(selector.slice(1)); if (!this.selectors)');
replaceOnce('    if (selector === "*") return descendants;', '    if (selector === "button[data-close]") return descendants.filter(item => item.tagName === "BUTTON" && item.dataset.close);\n    if (selector === "*") return descendants;');
replaceOnce("item.id = id; nodes.set(id, item);", "item.id = id; item.lookup = node; nodes.set(id, item);");
replaceOnce('async fire(type, details = {}) { for (const listener', 'async fire(type, details = {}) { if (type === "click" && this.disabled) return; for (const listener');
replaceOnce('close() { this.open = false; }', 'close() { if (!this.open) return; this.open = false; queueMicrotask(() => this.fire("close")); }');
const loadMarker = '  vm.runInContext(source, context, {filename: "app.js"});';
replaceOnce(loadMarker, `
  const closeButtons=[]; node("toast").hidden=true;
  for (const [id, target] of [["fixture-delete-close","delete-dialog"],["fixture-delete-cancel","delete-dialog"],["fixture-editor-cancel","camera-dialog"]]) {
    const button=node(id); button.tagName="BUTTON"; button.dataset.close=target; button.setAttribute("data-close",target); node(target).tagName="DIALOG"; node(target).append(button); closeButtons.push(button);
  }
  const baseQueryAll=document.querySelectorAll;
  document.querySelectorAll=(selector)=>selector==="[data-close]" ? closeButtons : selector==="dialog[open]" ? [...nodes.values()].filter(item=>item.tagName==="DIALOG"&&item.open) : baseQueryAll(selector);
  vm.runInContext(readFileSync(join(__dirname,"../nvr/static/camera-editor.js"),"utf8"),context,{filename:"camera-editor.js"});
${loadMarker}`);
const exported = {exports: {}};
vm.runInNewContext(harness + "\nmodule.exports={environment,camera,snapshot,deferred,flush};", {
  require, __dirname, module: exported, console, Response, Headers, URL, URLSearchParams, AbortController, setImmediate, queueMicrotask,
}, {filename: harnessPath});
const {environment, camera, snapshot, deferred, flush} = exported.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const admin = {id: "builtin-admin", username: "admin", display_name: "Administrator", role: "admin", permissions: [], camera_scope: "all", camera_ids: [], enabled: true, builtin: true};
const user = (permissions, scope = "all", ids = []) => ({id: "camera-user", username: "operator", display_name: "Operator", role: "user", permissions, camera_scope: scope, camera_ids: ids, enabled: true, builtin: false});
function configured(id, extra = {}) {
  return {...camera(id), connection: {protocol: "rtsp", host: "192.168.40." + ({a: 10, b: 11, c: 12}[id] || 50), port: 554, has_username: true, has_password: true},
    streams: {main: {configured: true}, sub: {configured: true}, third: {configured: false}}, live_stream: 2, ...extra};
}
function setup(options = {}) { return environment({cameras: [configured("a"), configured("b"), configured("c")], ...options, user: options.user || admin}); }
async function openCameras(env) { await env.boot(); await env.node("nav-cameras").fire("click"); }
const cards = (env) => Array.from(env.node("configured-camera-list").querySelectorAll("article"));
const row = (env, id) => cards(env).find((item) => item.dataset.cameraId === id);
function action(env, id, label) { const button = row(env, id)?.querySelectorAll("button").find((item) => item.textContent === label); assert.ok(button, `${label} for ${id}`); return button; }
const deletes = (env) => Array.from(env.calls).filter((item) => item.options.method === "DELETE");
async function filter(env, value) { env.node("cameras-filter").value = value; await env.node("cameras-filter").fire("input"); }
async function remove(env, id) { await action(env, id, "Remove camera").fire("click"); }
async function loginAgain(env, account = admin) { env.context.fixtureAccount = account; await env.evaluate("enterApp({authenticated:true,user:fixtureAccount})"); }

test("camera rows show only connection identity, actual stream availability and effective Live choice", async () => {
  const cameras = [configured("a", {name: '<img src=x onerror="unsafe">', source: "rtsp://private-user:private-pass@192.168.40.10/private-path?private-token=secret", live_stream: 3,
    streams: {main: {configured: true}, sub: {configured: false}, third: {configured: true}}}),
  configured("b", {connection: {protocol: "rtsps", host: "2001:db8::12", port: 322}, live_stream: 3,
    streams: {main: {configured: true}, sub: {configured: false}, third: {configured: false}}})];
  const env = setup({cameras}); await openCameras(env);
  assert.equal(cards(env).length, 2); assert.equal(env.node("cameras-count").textContent, "2 cameras");
  assert.ok(row(env, "a").textContent.includes(cameras[0].name), "camera names stay literal text");
  for (const secret of ["private-user", "private-pass", "private-path", "private-token", "secret"]) assert.ok(!env.node("configured-camera-list").textContent.includes(secret), secret);
  assert.match(row(env, "a").textContent, /RTSP · 192\.168\.40\.10:554/);
  assert.match(row(env, "b").textContent, /RTSPS · \[2001:db8::12\]:322/);
  assert.deepEqual(plain(row(env, "a").querySelectorAll(".configured-stream-chip").map((item) => [item.dataset.configured, item.dataset.live])), [["true", "false"], ["false", "false"], ["true", "true"]]);
  assert.deepEqual(plain(row(env, "b").querySelectorAll(".configured-stream-chip").map((item) => item.dataset.live)), ["true", "false", "false"], "an absent Third stream falls back to Main");
  assert.equal(row(env, "a").querySelectorAll("img").length, 0, "a name cannot create an image element");
});

test("filtering by name or address retains scroll and query through camera refresh and relabeling", async () => {
  let cameras = [configured("a", {name: "North entrance"}), configured("b", {name: "Parking"})];
  const env = setup({cameras, handler(path, options, defaults) { return path === "/api/cameras" ? cameras : defaults(path); }});
  await openCameras(env); env.node("configured-camera-list").scrollTop = 180;
  await filter(env, "ENTRANCE"); assert.deepEqual(cards(env).map((item) => item.dataset.cameraId), ["a"]); assert.equal(env.node("cameras-count").textContent, "1 / 2 cameras");
  assert.equal(env.node("configured-camera-list").scrollTop, 180);
  cameras = [...cameras, configured("c", {name: "South entrance"})]; await env.evaluate("refresh(true,true)");
  assert.equal(env.node("cameras-filter").value, "ENTRANCE"); assert.deepEqual(cards(env).map((item) => item.dataset.cameraId), ["a", "c"]);
  env.language("it"); await env.windowEvent("nvr-languagechange");
  assert.equal(env.node("cameras-filter").value, "ENTRANCE"); assert.deepEqual(cards(env).map((item) => item.dataset.cameraId), ["a", "c"]);
  await filter(env, "192.168.40.11"); assert.deepEqual(cards(env).map((item) => item.dataset.cameraId), ["b"]);
  await filter(env, "missing"); assert.equal(cards(env).length, 0); assert.match(env.node("configured-camera-list").textContent, /No cameras match this search/);
});

test("row actions navigate to existing Live slots or Layout and open that row's recordings", async () => {
  const env = setup({saved: snapshot(1, ["a"])}); await openCameras(env);
  await action(env, "a", "Open live").fire("click"); assert.equal(env.evaluate("network.view"), "monitor");
  await env.node("nav-cameras").fire("click"); await action(env, "b", "Open live").fire("click"); assert.equal(env.evaluate("network.view"), "layout");
  assert.match(env.node("toast").textContent, /Choose a tile/);
  await env.node("nav-cameras").fire("click"); await action(env, "c", "Open recordings").fire("click");
  assert.equal(env.evaluate("network.view"), "recorder"); assert.equal(env.evaluate("state.selectedId"), "c");
  assert.ok(env.calls.some((call) => call.path.startsWith("/api/recordings?") && new URLSearchParams(call.path.split("?")[1]).get("camera_id") === "c"));
});

test("configuration preserves saved private fields and returns to the filtered Cameras page after Save", async () => {
  let cameras = [configured("a"), configured("b")];
  const env = setup({cameras, handler(path, options, defaults) {
    if (path === "/api/cameras") return cameras;
    if (path === "/api/cameras/b" && options.method === "PUT") { cameras = cameras.map((item) => item.id === "b" ? {...item, name: JSON.parse(options.body).name} : item); return cameras[1]; }
    return defaults(path);
  }});
  await openCameras(env); await filter(env, "192.168.40.11"); await action(env, "b", "Configure").fire("click");
  assert.equal(env.evaluate("state.editingId"), "b"); assert.equal(env.node("camera-password").value, ""); assert.equal(env.node("camera-main-path").value, "");
  env.node("camera-name").value = "Renamed fixture"; await env.node("camera-form").fire("submit"); await flush();
  const payload = JSON.parse(env.calls.find((call) => call.path === "/api/cameras/b" && call.options.method === "PUT").options.body);
  assert.equal(payload.connection.password, null); assert.equal(payload.connection.username, null); assert.equal(payload.streams.main, null); assert.equal(payload.streams.sub, null);
  assert.equal(env.evaluate("network.view"), "cameras"); assert.equal(env.node("cameras-filter").value, "192.168.40.11");
  assert.equal(env.node("camera-dialog").open, false); assert.equal(env.evaluate("state.editingId"), null); assert.match(row(env, "b").textContent, /Renamed fixture/);
});

test("row removal snapshots its own camera rather than the recorder or editor selection", async () => {
  let cameras = [configured("a"), configured("b"), configured("c")];
  const pending = deferred(); const env = setup({cameras, handler(path, options, defaults) {
    if (path === "/api/cameras") return cameras;
    if (options.method === "DELETE") return pending.promise;
    return defaults(path);
  }});
  await openCameras(env); await action(env, "a", "Configure").fire("click"); await remove(env, "b");
  assert.equal(env.node("delete-camera-name").textContent, "Camera b");
  assert.equal(env.evaluate("state.selectedId"), "a"); assert.equal(env.evaluate("state.editingId"), "a");
  // Refresh/reordering while the confirmation is open must not retarget it.
  cameras = [configured("c"), configured("b", {name: "Updated B"}), configured("a")]; await env.evaluate("refresh(true,true)");
  assert.equal(env.node("delete-camera-name").textContent, "Camera b");
  const request = env.node("confirm-delete").fire("click"); await flush();
  assert.deepEqual(deletes(env).map((call) => call.path), ["/api/cameras/b"]);
  cameras = cameras.filter((item) => item.id !== "b"); pending.resolve({deleted: true, recordings_preserved: true}); await request; await flush();
  assert.equal(env.node("delete-dialog").open, false); assert.equal(env.node("camera-dialog").open, true, "deleting B must not close A's editor");
  assert.equal(env.evaluate("state.editingId"), "a"); assert.equal(row(env, "b"), undefined); assert.equal(env.evaluate("network.view"), "cameras");
  assert.match(env.node("toast").textContent, /Existing recordings remain on disk/);
});

test("busy removal prevents duplicate requests, changing target, opening another editor and Escape", async () => {
  const pending = deferred(), env = setup({handler(path, options, defaults) { return options.method === "DELETE" ? pending.promise : defaults(path); }});
  await openCameras(env); await remove(env, "a"); const request = env.node("confirm-delete").fire("click"); await flush();
  assert.equal(env.node("confirm-delete").disabled, true);
  for (const id of ["fixture-delete-close", "fixture-delete-cancel"]) assert.equal(env.node(id).disabled, true, id);
  await env.evaluate("deleteCamera()"); await action(env, "b", "Remove camera").fire("click"); await action(env, "b", "Configure").fire("click");
  assert.equal(env.evaluate("cameraRemoval.target.id"), "a"); assert.notEqual(env.node("camera-dialog").open, true); assert.equal(deletes(env).length, 1);
  let prevented = false; await env.node("delete-dialog").fire("cancel", {preventDefault() { prevented = true; }}); assert.equal(prevented, true);
  await env.node("fixture-delete-cancel").fire("click"); assert.equal(env.node("delete-dialog").open, true);
  pending.resolve({deleted: true, recordings_preserved: true}); await request;
});

test("cancel is non-destructive and an old queued close cannot clear a reopened confirmation", async () => {
  const env = setup(); await openCameras(env); await remove(env, "a");
  await env.node("fixture-delete-cancel").fire("click"); await flush();
  assert.equal(env.evaluate("cameraRemoval.target"), null); assert.equal(env.node("delete-dialog").open, false); assert.equal(deletes(env).length, 0);
  env.context.fixtureCameraA = configured("a"); env.context.fixtureCameraB = configured("b");
  env.evaluate("requestCameraRemoval(fixtureCameraA); resetCameraRemoval(); requestCameraRemoval(fixtureCameraB)"); await flush();
  assert.equal(env.node("delete-dialog").open, true); assert.equal(env.evaluate("cameraRemoval.target.id"), "b"); assert.equal(env.node("delete-camera-name").textContent, "Camera b");
  assert.equal(deletes(env).length, 0);
});

test("server failure keeps the same confirmation open, shows its error, and allows a deliberate retry", async () => {
  let calls = 0; const env = setup({handler(path, options, defaults) {
    if (options.method === "DELETE") return ++calls === 1 ? new Response(JSON.stringify({detail: "Fixture storage failure"}), {status: 503}) : {deleted: true, recordings_preserved: true};
    return defaults(path);
  }});
  await openCameras(env); await remove(env, "b"); await env.node("confirm-delete").fire("click");
  assert.equal(env.node("delete-dialog").open, true); assert.equal(env.evaluate("cameraRemoval.target.id"), "b");
  assert.equal(env.node("delete-error").textContent, "Fixture storage failure"); assert.equal(env.node("confirm-delete").disabled, false);
  await env.node("confirm-delete").fire("click"); assert.deepEqual(deletes(env).map((call) => call.path), ["/api/cameras/b", "/api/cameras/b"]);
  assert.equal(env.node("delete-dialog").open, false);
});

test("logout revokes the pending removal UI and a late old success cannot close the new session's editor", async () => {
  const pending = deferred(), env = setup({handler(path, options, defaults) { return options.method === "DELETE" ? pending.promise : defaults(path); }});
  await openCameras(env); await remove(env, "a"); const deletion = env.node("confirm-delete").fire("click"); await flush();
  const request = deletes(env)[0]; await env.node("logout").fire("click");
  assert.equal(request.options.signal.aborted, true); assert.equal(env.evaluate("cameraRemoval.target"), null); assert.equal(env.node("delete-dialog").open, false);
  await loginAgain(env); await env.node("nav-cameras").fire("click"); await action(env, "b", "Configure").fire("click");
  pending.resolve({deleted: true, recordings_preserved: true}); await deletion; await flush();
  assert.equal(env.node("camera-dialog").open, true); assert.equal(env.evaluate("state.editingId"), "b");
  assert.equal(env.node("toast").hidden, true); assert.equal(env.node("delete-error").textContent, "");
});

test("a late error from the old session cannot overwrite a new pending confirmation or enable its button", async () => {
  const old = deferred(), current = deferred(); let count = 0;
  const env = setup({handler(path, options, defaults) { return options.method === "DELETE" ? (++count === 1 ? old.promise : current.promise) : defaults(path); }});
  await openCameras(env); await remove(env, "a"); const first = env.node("confirm-delete").fire("click"); await flush();
  await env.node("logout").fire("click"); await loginAgain(env); await env.node("nav-cameras").fire("click");
  await remove(env, "b"); const second = env.node("confirm-delete").fire("click"); await flush();
  old.resolve(new Response(JSON.stringify({detail: "Old private failure"}), {status: 503})); await first;
  assert.equal(env.evaluate("cameraRemoval.target.id"), "b"); assert.equal(env.evaluate("cameraRemoval.busy"), true); assert.equal(env.node("confirm-delete").disabled, true);
  assert.equal(env.node("delete-error").textContent, ""); assert.equal(env.node("delete-camera-name").textContent, "Camera b");
  current.resolve({deleted: true, recordings_preserved: true}); await second;
});

test("pagehide invalidates removal state and prevents late completion UI", async () => {
  const pending = deferred(), env = setup({handler(path, options, defaults) { return options.method === "DELETE" ? pending.promise : defaults(path); }});
  await openCameras(env); await remove(env, "a"); const request = env.node("confirm-delete").fire("click"); await flush();
  await env.windowEvent("pagehide"); assert.equal(deletes(env)[0].options.signal.aborted, true); assert.equal(env.evaluate("cameraRemoval.target"), null);
  pending.resolve({deleted: true, recordings_preserved: true}); await request;
  assert.equal(env.node("toast").hidden, true); assert.equal(env.node("delete-dialog").open, false);
});

test("camera names matching translatable UI messages remain literal through language changes in the confirmation", async () => {
  const env = setup({cameras: [configured("a", {name: "Recording"})]}); await openCameras(env); await remove(env, "a");
  env.language("it"); await env.windowEvent("nvr-languagechange");
  assert.equal(env.node("delete-camera-name").textContent, "Recording"); assert.ok(row(env, "a").textContent.includes("Recording"));
  assert.equal(env.evaluate("cameraRemoval.target.id"), "a"); assert.equal(deletes(env).length, 0);
});

test("a scoped camera manager can configure/remove assigned rows but cannot add, view Live or open recordings", async () => {
  const account = user(["cameras"], "selected", ["a"]), env = setup({user: account, cameras: [configured("a")]}); await openCameras(env);
  assert.equal(env.node("cameras-add").hidden, true); assert.deepEqual(plain(row(env, "a").querySelectorAll("button").map((item) => item.textContent)), ["Configure", "Remove camera"]);
  await env.node("cameras-add").fire("click"); assert.notEqual(env.node("camera-dialog").open, true);
  await action(env, "a", "Configure").fire("click"); assert.equal(env.node("camera-dialog").open, true);
  await env.node("fixture-editor-cancel").fire("click"); await flush(); await remove(env, "a"); assert.equal(env.node("delete-dialog").open, true);
  env.context.unknownCamera = configured("unassigned"); env.evaluate("requestCameraRemoval(unknownCamera)"); assert.equal(env.evaluate("cameraRemoval.target.id"), "a");
  assert.equal(deletes(env).length, 0);
});

test("a Live-only account cannot open Cameras, editor or a removal confirmation even through direct handlers", async () => {
  const env = setup({user: user(["live"])}); await env.boot();
  assert.equal(env.node("nav-cameras").hidden, true); await env.node("nav-cameras").fire("click"); assert.equal(env.evaluate("network.view"), "monitor");
  env.context.fixtureCamera = configured("a"); await env.evaluate("openCameraDialog(fixtureCamera); requestCameraRemoval(fixtureCamera); deleteCamera()");
  assert.notEqual(env.node("camera-dialog").open, true); assert.notEqual(env.node("delete-dialog").open, true); assert.equal(deletes(env).length, 0);
});
