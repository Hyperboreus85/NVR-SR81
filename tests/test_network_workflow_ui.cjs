"use strict";
// Use the existing application DOM boundary, without registering its tests.
// The three production controllers below run unchanged; fetch never uses a network.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");

const harnessPath = join(__dirname, "test_navigation_ui.cjs");
const harnessText = readFileSync(harnessPath, "utf8");
const firstTest = harnessText.indexOf('\ntest("');
assert.ok(firstTest > 0, "The shared DOM harness must precede its tests");
let harness = harnessText.slice(0, firstTest);
const selectorMarker = "querySelector(selector) { if (!this.selectors)";
assert.ok(harness.includes(selectorMarker));
harness = harness.replace(selectorMarker, 'querySelector(selector) { if (/^#[A-Za-z0-9_-]+$/.test(selector) && this.lookup) return this.lookup(selector.slice(1)); if (!this.selectors)');
const nodeMarker = "item.id = id; nodes.set(id, item);";
assert.ok(harness.includes(nodeMarker));
harness = harness.replace(nodeMarker, "item.id = id; item.lookup = node; nodes.set(id, item);");
const loadMarker = '  vm.runInContext(source, context, {filename: "app.js"});';
assert.ok(harness.includes(loadMarker));
harness = harness.replace(loadMarker, `
  for (const [id, value] of Object.entries({"network-ports":"80,8000,8080,8899", "network-rtsp-ports":"554,8554", "network-rtsps-ports":"322", "network-manual-kind":"onvif"})) node(id).value=value;
  vm.runInContext(readFileSync(join(__dirname, "../nvr/static/network-search.js"), "utf8"), context, {filename: "network-search.js"});
  vm.runInContext(readFileSync(join(__dirname, "../nvr/static/camera-editor.js"), "utf8"), context, {filename: "camera-editor.js"});
${loadMarker}`);
const exported = {exports: {}};
vm.runInNewContext(harness + "\nmodule.exports={environment, camera, deferred, flush};", {
  require, __dirname, module: exported, console, Response, Headers, URL, URLSearchParams, AbortController, setImmediate,
}, {filename: harnessPath});
const {environment, camera, deferred, flush} = exported.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const admin = {id: "builtin-admin", username: "admin", display_name: "Administrator", role: "admin", permissions: [], camera_scope: "all", camera_ids: [], enabled: true, builtin: true};
const user = (permissions) => ({id: "network-user", username: "operator", display_name: "Operator", role: "user", permissions, camera_scope: "all", camera_ids: [], enabled: true, builtin: false});
const device = (id = "device-a", extra = {}) => ({id, ip: "192.168.30.41", endpoint: "http://192.168.30.41:8000/onvif/device_service", xaddrs: [], name: "Camera <A>", hardware: "Fixture", location: "Entrance", scopes: [], methods: ["onvif"], services: [], ...extra});
const profiles = [
  {name: "Main <safe>", token: "main", role: "main", encoding: "H264", width: 1920, height: 1080, video_source: "sensor", url: "rtsp://viewer:p%40ss@192.168.30.41/main?token=private", clean_url: "rtsp://192.168.30.41/main?token=private"},
  {name: "Sub", token: "sub", role: "sub", encoding: "H264", width: 640, height: 360, video_source: "sensor", url: "rtsp://viewer:p%40ss@192.168.30.41/sub", clean_url: "rtsp://192.168.30.41/sub"},
  {name: "Third", token: "third", encoding: "H265", width: 320, height: 180, video_source: "sensor", url: "rtsp://viewer:p%40ss@192.168.30.41/third", clean_url: "rtsp://192.168.30.41/third"},
];
function setup(options = {}) {
  const handler = options.handler;
  return environment({...options, user: options.user || admin, handler: (path, request, defaults) => {
    if (handler) { const result = handler(path, request, defaults); if (result !== undefined) return result; }
    if (path === "/api/network/targets") return {targets: [], max_targets: 32};
    if (path === "/api/onvif/profiles") return {success: true, profiles, device: {manufacturer: "Fixture"}, warnings: []};
    if (path === "/api/network/probe") return {verified: true, video_codec: "h264", audio_codec: "aac", width: 1920, height: 1080};
    if (path === "/api/network/cancel") return {cancelled: true};
    return defaults(path);
  }});
}
async function openNetwork(env) { await env.boot(); await env.node("nav-network").fire("click"); await flush(); await flush(); }
function choose(env, value = device()) { env.context.testDevice = value; env.evaluate("chooseNetworkDevice(testDevice)"); }
function input(env, id, value) { env.node(id).value = value; return env.node(id).fire("input"); }
function body(call) { return JSON.parse(call.options.body); }
const matching = (env, path) => env.calls.filter((call) => call.path === path);
const cameraWrites = (env) => env.calls.filter((call) => /^\/api\/cameras(?:\/|$)/.test(call.path) && ["POST", "PUT", "DELETE"].includes(call.options.method));
async function manualStream(env, source) {
  env.node("network-manual-kind").value = "stream";
  env.node("network-manual-endpoint").value = source;
  await env.node("network-manual-form").fire("submit");
}

test("new search and late interfaces preserve selected ONVIF device, profiles, credentials and all three stream choices", async () => {
  const interfaces = deferred(), search = deferred();
  const selected = device(), another = device("device-b", {ip: "192.168.30.42", endpoint: "http://192.168.30.42/onvif/device_service"});
  const env = setup({handler(path) {
    if (path === "/api/onvif/interfaces") return interfaces.promise;
    if (path === "/api/network/search") return search.promise;
  }});
  await openNetwork(env); choose(env, selected);
  await input(env, "network-username", "operator"); await input(env, "network-password", "private fixture password");
  await env.node("network-profile-form").fire("submit");
  env.node("network-main-profile").value = "2"; env.node("network-preview-profile").value = "0"; env.node("network-third-profile").value = "1";
  env.node("network-include-credentials").checked = true;
  env.node("network-cidr").value = "100.80.2.0/24";
  const searchRequest = env.evaluate('runNetworkScan("scan")'); await flush();
  assert.equal(env.node("network-password").value, "private fixture password");
  assert.equal(env.evaluate("network.profiles.length"), 3);
  interfaces.resolve([{name: "eth0", address: "192.168.99.2", cidr: "192.168.99.0/24"}]); await flush(); await flush();
  assert.equal(env.node("network-cidr").value, "100.80.2.0/24", "a late interface suggestion must not replace an explicit target");
  search.resolve({devices: [{...selected, name: "Updated discovery name"}, another], warnings: [], completed: 4, total: 4, duration: 1, partial: false});
  await searchRequest;
  assert.equal(env.evaluate("network.selected.id"), selected.id);
  assert.equal(env.node("network-device-name").textContent, "Updated discovery name");
  assert.equal(env.node("network-username").value, "operator");
  assert.equal(env.node("network-password").value, "private fixture password");
  assert.equal(env.evaluate("network.profiles.length"), 3);
  assert.deepEqual(["main", "preview", "third"].map((role) => env.node(`network-${role}-profile`).value), ["2", "0", "1"]);
  assert.equal(env.node("network-include-credentials").checked, true);
  assert.equal(env.node("network-profile-error").textContent, "");
  assert.equal(cameraWrites(env).length, 0);
});

test("an absent selected device remains usable after a subsequent search with other results", async () => {
  const selected = device(); const env = setup({handler(path) { if (path === "/api/network/search") return {devices: [device("other", {ip: "192.168.30.42", endpoint: "http://192.168.30.42/onvif/device_service"})], warnings: []}; }});
  await openNetwork(env); choose(env, selected);
  await input(env, "network-password", "kept credential");
  await env.node("network-profile-form").fire("submit");
  await env.evaluate('runNetworkScan("discover")');
  assert.equal(env.evaluate("network.selected.id"), selected.id);
  assert.equal(env.evaluate("network.devices[0].id"), selected.id);
  assert.equal(env.node("network-password").value, "kept credential");
  assert.equal(env.evaluate("network.profiles.length"), 3);
});

test("actual search controls send chosen methods, distinct protocol ports and a request ID", async () => {
  const env = setup({handler(path) { if (path === "/api/network/search") return {devices: [], warnings: [], completed: 1, total: 1}; }});
  await openNetwork(env);
  env.evaluate('networkSearch.setMode("targets")');
  env.node("network-cidr").value = "100.80.2.0/24\nremote-camera.example";
  env.node("network-ports").value = "443, 8000"; env.node("network-rtsp-ports").value = "554, 8554,554"; env.node("network-rtsps-ports").value = "322,8322";
  env.node("network-method-rtsps").checked = true;
  await env.node("network-method-rtsps").fire("change");
  await env.evaluate('runNetworkScan("scan")');
  const sent = body(matching(env, "/api/network/search")[0]);
  assert.deepEqual(sent.targets, ["100.80.2.0/24", "remote-camera.example"]);
  assert.deepEqual(sent.methods, ["onvif", "rtsp", "rtsps"]);
  assert.deepEqual(sent.onvif_ports, [443, 8000]); assert.deepEqual(sent.rtsp_ports, [554, 8554]); assert.deepEqual(sent.rtsps_ports, [322, 8322]);
  assert.equal(sent.interface_ip, null); assert.equal(sent.timeout, .75); assert.match(sent.request_id, /^search-\d+-\d+-\d+$/);
  assert.equal(matching(env, "/api/network/search")[0].options.headers.get("X-NVR-Request"), "1");
});

test("submitting the scan form retains Local mode and its multicast methods", async () => {
  const env = setup({handler(path) { if (path === "/api/network/search") return {devices: [], warnings: []}; }});
  await openNetwork(env);
  env.node("network-interface").value = "192.168.30.2";
  env.node("network-cidr").value = "invalid target ignored in local mode";
  await env.node("network-scan-form").fire("submit"); await flush(); await flush();
  const sent = body(matching(env, "/api/network/search")[0]);
  assert.equal(sent.mode, "local"); assert.equal(sent.interface_ip, "192.168.30.2");
  assert.deepEqual(sent.methods, ["onvif", "mdns"]); assert.deepEqual(sent.targets, []);
  assert.equal(env.evaluate("networkSearch.mode"), "local");
});

test("known RTSP, RTSPS, HTTP, HLS and MJPEG streams are tested then copied into an unsaved structured camera draft", async (t) => {
  for (const source of ["rtsp://192.168.30.41:8554/main?channel=1", "rtsps://remote-camera.example:8322/main", "http://192.168.30.41:8080/video", "https://remote-camera.example/video.m3u8?channel=2", "http://192.168.30.41:8080/mjpeg"]) {
    await t.test(source, async () => {
      const env = setup(); await openNetwork(env); const previousCamera = env.evaluate("state.selectedId");
      await manualStream(env, source);
      await input(env, "network-username", "fixture viewer"); await input(env, "network-password", "p@ss:/?#");
      assert.equal(env.node("network-direct-add").disabled, true);
      assert.equal(env.node("network-direct-result").hidden, true);
      await env.node("network-direct-test").fire("click");
      const sent = new URL(body(matching(env, "/api/network/probe")[0]).url);
      assert.equal(decodeURIComponent(sent.username), "fixture viewer"); assert.equal(decodeURIComponent(sent.password), "p@ss:/?#");
      const original = new URL(source); assert.equal(sent.host, original.host); assert.equal(sent.pathname + sent.search, original.pathname + original.search);
      assert.match(env.node("network-direct-result").textContent, /Readable video.*H264.*1920 × 1080/);
      assert.equal(env.node("network-direct-result").hidden, false);
      assert.equal(env.node("network-direct-add").disabled, false);
      await env.node("network-direct-add").fire("click");
      assert.equal(env.node("camera-dialog").open, true); assert.equal(env.evaluate("state.editingId"), null);
      assert.equal(env.evaluate("state.selectedId"), previousCamera, "adding a draft must not replace the recorder selection");
      const draft = plain(env.evaluate("cameraEditor.getPayload()"));
      assert.equal(draft.connection.protocol, original.protocol.slice(0, -1)); assert.equal(draft.connection.host, original.hostname);
      assert.equal(draft.connection.username, "fixture viewer"); assert.equal(draft.connection.password, "p@ss:/?#");
      assert.equal(draft.streams.main, original.pathname + (original.search || "?"));
      assert.equal(draft.streams.sub, ""); assert.equal(draft.streams.third, "");
      assert.equal(cameraWrites(env).length, 0, "testing and Add must never save a camera without explicit Save");
    });
  }
});

test("embedded known-stream credentials move to device fields and never remain in the device address history", async () => {
  const env = setup(); await openNetwork(env);
  await manualStream(env, "rtsp://user%20one:p%40ss@192.168.30.41/main?token=fixture");
  assert.equal(env.node("network-username").value, "user one"); assert.equal(env.node("network-password").value, "p@ss");
  assert.equal(env.node("network-manual-endpoint").value, "rtsp://192.168.30.41/main?token=fixture");
  assert.equal(env.node("network-direct-url").value, "rtsp://192.168.30.41/main?token=fixture");
  assert.equal(env.evaluate("JSON.stringify(network.devices).includes('p%40ss')"), false);
  await env.node("network-direct-test").fire("click");
  assert.equal(new URL(body(matching(env, "/api/network/probe")[0]).url).password, "p%40ss");
});

test("URL or either credential edit aborts a pending probe, ignores its late success and requires a fresh test", async (t) => {
  for (const [id, value] of [["network-direct-url", "rtsp://192.168.30.41/changed"], ["network-username", "changed-user"], ["network-password", "changed-password"]]) {
    await t.test(id, async () => {
      const pending = deferred(); let count = 0;
      const env = setup({handler(path) { if (path === "/api/network/probe" && ++count === 1) return pending.promise; }});
      await openNetwork(env); await manualStream(env, "rtsp://192.168.30.41/main");
      const request = env.node("network-direct-test").fire("click"); await flush();
      const call = matching(env, "/api/network/probe")[0];
      await input(env, id, value);
      assert.equal(call.options.signal.aborted, true); assert.equal(env.node("network-direct-add").disabled, true);
      assert.equal(env.node("network-direct-result").hidden, true);
      pending.resolve({verified: true, video_codec: "h264", width: 100, height: 100}); await request;
      assert.equal(env.evaluate("network.directVerified"), null); assert.equal(env.node("network-direct-result").textContent, "");
      await env.node("network-direct-add").fire("click"); assert.notEqual(env.node("camera-dialog").open, true);
      await env.node("network-direct-test").fire("click"); assert.equal(env.node("network-direct-add").disabled, false);
      await input(env, id, value + "x"); assert.equal(env.node("network-direct-add").disabled, true); assert.equal(env.evaluate("network.directVerified"), null);
    });
  }
});

test("RTSP service detection alone does not permit Add and a non-video probe stays unverified", async () => {
  const env = setup({handler(path) { if (path === "/api/network/probe") return {verified: false, video_codec: null}; }});
  await openNetwork(env);
  choose(env, device("rtsp-service", {endpoint: "", services: [{protocol: "rtsp", url: "rtsp://192.168.30.41:554/", status: "authentication_required", stream_path_known: false}], methods: ["rtsp"]}));
  assert.equal(env.node("network-direct-url").value, "rtsp://192.168.30.41:554/");
  assert.equal(env.node("network-direct-add").disabled, true); assert.equal(env.node("network-onvif-controls").hidden, true);
  await env.node("network-direct-test").fire("click");
  assert.match(env.node("network-direct-result").textContent, /does not contain a readable video track/);
  assert.equal(env.evaluate("network.directVerified"), null); assert.equal(env.node("network-direct-add").disabled, true);
  assert.equal(cameraWrites(env).length, 0);
});

test("invalid direct stream input gives a visible error without probing or creating a draft", async () => {
  const env = setup(); await openNetwork(env); await manualStream(env, "rtsp://192.168.30.41/main");
  await input(env, "network-direct-url", "file:///private/video.mkv");
  await env.node("network-direct-test").fire("click");
  assert.match(env.node("network-direct-result").textContent, /Enter an RTSP, RTSPS, HTTP or HTTPS video address/);
  assert.equal(env.node("network-direct-result").hidden, false);
  assert.equal(env.node("network-direct-add").disabled, true); assert.equal(matching(env, "/api/network/probe").length, 0); assert.equal(cameraWrites(env).length, 0);
});

test("ONVIF remote options are sent exactly and changing device clears credentials, options and stale profiles", async () => {
  const pending = deferred(); const env = setup({handler(path) { if (path === "/api/onvif/profiles") return pending.promise; }});
  await openNetwork(env); choose(env);
  await input(env, "network-username", "remote-user"); await input(env, "network-password", "remote-pass");
  env.node("network-stream-host").value = "camera.example"; env.node("network-stream-port").value = "8554"; env.node("network-use-endpoint-address").checked = true;
  const request = env.node("network-profile-form").fire("submit"); await flush();
  const call = matching(env, "/api/onvif/profiles")[0];
  assert.deepEqual(body(call), {endpoint: device().endpoint, username: "remote-user", password: "remote-pass", stream_host: "camera.example", stream_port: 8554, use_endpoint_address: true});
  choose(env, device("second", {endpoint: "https://other.example/onvif/device_service"}));
  assert.equal(call.options.signal.aborted, true);
  for (const id of ["network-username", "network-password", "network-stream-host", "network-stream-port"]) assert.equal(env.node(id).value, "", id);
  assert.equal(env.node("network-use-endpoint-address").checked, false);
  pending.resolve({success: true, profiles, device: {manufacturer: "Old device"}}); await request;
  assert.equal(env.evaluate("network.profiles.length"), 0); assert.equal(env.node("network-device-info").textContent, "");
  assert.equal(env.node("network-endpoint").value, "https://other.example/onvif/device_service");
});

test("ONVIF profile choices populate Main, Sub and Third in a new draft without saving or showing passwords by default", async () => {
  const env = setup(); await openNetwork(env); choose(env);
  await env.node("network-profile-form").fire("submit");
  assert.deepEqual(["main", "preview", "third"].map((role) => env.node(`network-${role}-profile`).value), ["0", "1", ""]);
  const visibleUrls = env.node("network-profiles").querySelectorAll("input").map((element) => element.value);
  assert.equal(visibleUrls.length, 3); assert.ok(visibleUrls.every((url) => !new URL(url).password));
  env.node("network-third-profile").value = "2";
  await env.node("network-add-recorder").fire("click");
  assert.equal(env.node("camera-dialog").open, true);
  const draft = plain(env.evaluate("cameraEditor.getPayload()"));
  assert.equal(draft.connection.username, "viewer"); assert.equal(draft.connection.password, "p@ss");
  assert.deepEqual(draft.streams, {main: "/main?token=private", sub: "/sub?", third: "/third?"});
  assert.equal(cameraWrites(env).length, 0);
});

test("cancel aborts search and status requests and neither late response may replace the selected device", async () => {
  const search = deferred(), status = deferred();
  const env = setup({handler(path) { if (path === "/api/network/search") return search.promise; if (path.startsWith("/api/network/status?")) return status.promise; }});
  await openNetwork(env); choose(env);
  await input(env, "network-password", "keep selected credentials");
  const request = env.evaluate('runNetworkScan("discover")'); await flush();
  const scanCall = matching(env, "/api/network/search")[0], requestId = body(scanCall).request_id;
  const polling = env.runTimer(env.evaluate("network.scanTimer")); await flush();
  const statusCall = env.calls.find((call) => call.path.startsWith("/api/network/status?"));
  await env.node("network-cancel").fire("click"); await flush();
  assert.equal(scanCall.options.signal.aborted, true); assert.equal(statusCall.options.signal.aborted, true);
  assert.equal(matching(env, "/api/network/cancel").length, 1);
  status.resolve({request_id: requestId, state: "running", devices: [device("stale-status")], completed: 1, total: 3});
  search.resolve({devices: [device("stale-result")], warnings: []}); await polling; await request;
  assert.equal(env.evaluate("network.selected.id"), "device-a");
  assert.deepEqual(plain(env.evaluate("network.devices.map(item=>item.id)")), ["device-a"]);
  assert.equal(env.node("network-password").value, "keep selected credentials");
  assert.equal(env.evaluate("network.scanController"), null); assert.equal(env.evaluate("network.scanTimer"), null);
  assert.equal(env.node("network-cancel").hidden, true); assert.match(env.node("network-progress-label").textContent, /Search cancelled/);
});

test("progress only accepts the current request ID and preserves the selected device's profile draft", async () => {
  const search = deferred(); let requestId, wrongId = true;
  const env = setup({handler(path, request) {
    if (path === "/api/network/search") { requestId = body({options: request}).request_id; return search.promise; }
    if (path.startsWith("/api/network/status?")) return {request_id: wrongId ? "another-browser-search" : requestId, state: "running", completed: 2, total: 4,
      devices: [device("discovered", {ip: "192.168.30.99", endpoint: "http://192.168.30.99/onvif/device_service"})], warnings: []};
  }});
  await openNetwork(env); choose(env);
  await input(env, "network-password", "current profile credential"); await env.node("network-profile-form").fire("submit");
  env.node("network-main-profile").value = "2";
  const request = env.evaluate('runNetworkScan("discover")'); await flush();
  const timer = env.evaluate("network.scanTimer");
  await env.runTimer(timer);
  assert.deepEqual(plain(env.evaluate("network.devices.map(item=>item.id)")), ["device-a"]);
  wrongId = false; await env.runTimer(timer);
  assert.deepEqual(plain(env.evaluate("network.devices.map(item=>item.id)")), ["device-a", "discovered"]);
  assert.equal(env.node("network-password").value, "current profile credential"); assert.equal(env.node("network-main-profile").value, "2");
  assert.equal(env.evaluate("network.profiles.length"), 3); assert.match(env.node("network-progress-label").textContent, /2 \/ 4 checked/);
  search.resolve({devices: [], warnings: [], partial: true}); await request;
});

test("an old cancelled search finishing cannot clear the newer search's busy state, timer or results", async () => {
  const old = deferred(), current = deferred(); let count = 0;
  const env = setup({handler(path) { if (path === "/api/network/search") return ++count === 1 ? old.promise : current.promise; }});
  await openNetwork(env);
  const first = env.evaluate('runNetworkScan("discover")'); await flush();
  await env.node("network-cancel").fire("click");
  const second = env.evaluate('runNetworkScan("discover")'); await flush();
  const secondSignal = matching(env, "/api/network/search")[1].options.signal, secondTimer = env.evaluate("network.scanTimer");
  old.resolve({devices: [device("old-search")], warnings: []}); await first;
  assert.equal(env.evaluate("network.scanController.signal") === secondSignal, true);
  assert.equal(env.evaluate("network.scanTimer"), secondTimer); assert.equal(env.evaluate("networkSearch.busy"), true);
  assert.equal(env.node("network-cancel").hidden, false); assert.equal(env.evaluate("network.devices.length"), 0);
  current.resolve({devices: [device("current-search")], warnings: []}); await second;
  assert.equal(env.evaluate("network.selected.id"), "current-search"); assert.equal(env.evaluate("networkSearch.busy"), false);
  assert.equal(secondSignal.aborted, false); assert.equal(env.evaluate("network.scanTimer"), null);
});

test("logout cancels pending search and probe, clears secrets, and ignores success from the old session", async () => {
  const search = deferred(), probe = deferred();
  const env = setup({handler(path) { if (path === "/api/network/search") return search.promise; if (path === "/api/network/probe") return probe.promise; }});
  await openNetwork(env); await manualStream(env, "rtsps://remote-camera.example/main");
  await input(env, "network-username", "session-user"); await input(env, "network-password", "session-secret");
  const testing = env.node("network-direct-test").fire("click"); const scanning = env.evaluate('runNetworkScan("discover")'); await flush();
  await env.node("logout").fire("click");
  for (const path of ["/api/network/search", "/api/network/probe"]) assert.equal(matching(env, path)[0].options.signal.aborted, true);
  search.resolve({devices: [device("old-session")], warnings: []}); probe.resolve({verified: true, video_codec: "h264"});
  await scanning; await testing;
  assert.equal(env.evaluate("state.authenticated"), false); assert.equal(env.evaluate("network.devices.length"), 0); assert.equal(env.evaluate("network.directVerified"), null);
  for (const id of ["network-username", "network-password", "network-direct-url", "network-manual-endpoint"]) assert.equal(env.node(id).value, "", id);
  assert.equal(env.node("network-direct-add").disabled, true); assert.equal(env.node("network-direct-result").textContent, "");
  assert.equal(env.node("login-screen").hidden, false); assert.equal(cameraWrites(env).length, 0);
});

test("network-only users can test a known stream but cannot turn it into a camera draft", async () => {
  const env = setup({user: user(["network"])}); await openNetwork(env);
  await manualStream(env, "https://remote-camera.example/video.m3u8"); await env.node("network-direct-test").fire("click");
  assert.match(env.node("network-direct-result").textContent, /Readable video/);
  assert.equal(env.node("network-direct-add").hidden, true); assert.equal(env.node("network-direct-add").disabled, true);
  await env.node("network-direct-add").fire("click"); assert.notEqual(env.node("camera-dialog").open, true); assert.equal(cameraWrites(env).length, 0);
});
