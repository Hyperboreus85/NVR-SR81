"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {NvrCameraEditor, parseSource, pathValue} = require("../nvr/static/camera-editor.js");

function environment() {
  const elements = new Map(); let language = "en";
  class Element {
    constructor() { this.value = ""; this.checked = false; this.hidden = false; this.disabled = false; this.required = false; this.placeholder = ""; this.listeners = new Map(); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    fire(type) { for (const listener of this.listeners.get(type) || []) listener({target: this}); }
    set innerHTML(_) { throw Error("Unsafe HTML insertion"); }
    set textContent(value) { this.text = value; }
    get textContent() { return this.text || ""; }
  }
  const field = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const editor = new NvrCameraEditor({root: {querySelector: (selector) => field(selector.slice(1))}, t: (key) => language === "it" ? "IT:" + key : key});
  return {editor, field, elements, language(value) { language = value; editor.relabel(); }, change(id, value, checked = false) { if (checked) field(id).checked = value; else field(id).value = value; field(id).fire("change"); }};
}
function camera(extra = {}) {
  return {id: "saved", connection: {protocol: "rtsp", host: "192.168.1.20", port: 554, has_username: true, has_password: true}, streams: {main: {configured: true}, sub: {configured: true}, third: {configured: true}}, live_stream: 2, ...extra};
}

test("new camera builds a shared connection and main path with disabled optional streams and no network access", () => {
  const env = environment();
  assert.throws(() => env.editor.getPayload(), /IP address or hostname/);
  env.field("camera-host").value = "192.168.1.50"; env.field("camera-main-path").value = "/Streaming/Channels/101?transport=unicast";
  assert.deepEqual(env.editor.getPayload(), {connection: {protocol: "rtsp", host: "192.168.1.50", port: 554, username: "", password: ""}, streams: {main: "/Streaming/Channels/101?transport=unicast", sub: "", third: ""}, live_stream: 2});
  assert.equal(env.field("camera-live-third-option").disabled, true); assert.equal(env.field("camera-probe-controls").hidden, true);
  assert.equal(env.field("camera-url").required, false); assert.equal(env.field("camera-url").disabled, true);
  env.field("camera-main-path").value = ""; assert.equal(env.editor.getPayload().streams.main, "/");
});

test("editing never reads stored private values and blank fields return null to preserve all saved secrets", () => {
  const env = environment(), saved = camera();
  for (const name of ["username", "password"]) Object.defineProperty(saved.connection, name, {get() { throw Error("Private credential read"); }});
  for (const stream of Object.values(saved.streams)) for (const name of ["url", "path", "query"]) Object.defineProperty(stream, name, {get() { throw Error("Private stream read"); }});
  env.editor.setCamera(saved);
  assert.equal(env.field("camera-host").value, "192.168.1.20");
  for (const id of ["camera-username", "camera-password", "camera-main-path", "camera-sub-path", "camera-third-path", "camera-url", "camera-preview-url", "camera-third-url"]) assert.equal(env.field(id).value, "", id);
  assert.match(env.field("camera-password").placeholder, /Saved password/);
  assert.deepEqual(env.editor.getPayload(), {connection: {protocol: "rtsp", host: "192.168.1.20", port: 554, username: null, password: null}, streams: {main: null, sub: null, third: null}, live_stream: 2});
  env.field("camera-host").value = "camera-new.local"; env.field("camera-main-path").value = "/new/path";
  assert.equal(env.editor.getPayload().streams.sub, null); assert.equal(env.editor.getPayload().connection.password, null);
});

test("independent saved sub and third streams use blank URL mode and remain independent on shared connection changes", () => {
  const env = environment(); env.editor.setCamera(camera({streams: {main: {configured: true}, sub: {configured: true, independent: true}, third: {configured: true, independent: true}}}));
  for (const name of ["sub", "third"]) {
    assert.equal(env.field(`camera-${name}-mode`).value, "url"); assert.equal(env.field(`camera-${name}-url-row`).hidden, false);
    assert.match(env.field(`camera-${name}-override-note`).textContent, /separate connection/);
  }
  env.field("camera-password").value = "new-main-password"; env.field("camera-host").value = "192.168.1.33";
  const payload = env.editor.getPayload(); assert.equal(payload.connection.password, "new-main-password"); assert.equal(payload.streams.sub, null); assert.equal(payload.streams.third, null);
  env.change("camera-sub-mode", "path"); env.field("camera-sub-path").value = "/use-shared-base?";
  assert.equal(env.editor.getPayload().streams.sub, "/use-shared-base?");
});

test("explicit clear credentials differs from blank keep and does not erase private stream queries", () => {
  const env = environment(); env.editor.setCamera(camera()); env.field("camera-username").value = "draft-user"; env.field("camera-password").value = "draft-password";
  env.change("camera-clear-credentials", true, true); const payload = env.editor.getPayload();
  assert.equal(payload.connection.username, ""); assert.equal(payload.connection.password, ""); assert.equal(payload.streams.main, null);
  assert.equal(env.field("camera-password").disabled, true);
  env.change("camera-clear-credentials", false, true); assert.equal(env.editor.getPayload().connection.password, "draft-password");
});

test("optional stream disable explicitly clears it and live Third requires an enabled configured draft", () => {
  const env = environment(); env.editor.setCamera(camera({live_stream: 3}));
  env.change("camera-third-enabled", false, true); assert.equal(env.field("camera-live-stream").value, "2"); assert.equal(env.editor.getPayload().streams.third, "");
  env.change("camera-sub-enabled", false, true); assert.equal(env.editor.getPayload().streams.sub, "");
  const next = environment(); next.field("camera-host").value = "192.168.1.50";
  next.change("camera-third-enabled", true, true); next.field("camera-live-stream").value = "3";
  assert.throws(() => next.editor.getPayload(), /third stream/);
  next.field("camera-third-path").value = "/third"; next.field("camera-third-path").fire("input"); next.field("camera-live-stream").value = "3"; assert.equal(next.editor.getPayload().live_stream, 3); assert.equal(next.field("camera-live-third-option").disabled, false);
  next.change("camera-third-enabled", false, true); next.field("camera-live-stream").value = "3"; assert.throws(() => next.editor.getPayload(), /Enable and configure/);
});

test("ONVIF main import fills editable connection fields with supplied credentials and preserves URL encoding and explicit query intent", () => {
  const env = environment();
  const raw = "rtsp://camera%40user:p%3A%23%40@192.168.1.50:8554/main?token=a%2Fb";
  env.editor.setSources({url: raw, preview_url: "rtsp://camera%40user:p%3A%23%40@192.168.1.50:8554/sub"});
  assert.equal(env.field("camera-url").value, raw); assert.equal(env.field("camera-username").value, "camera@user"); assert.equal(env.field("camera-password").value, "p:#@");
  assert.equal(env.field("camera-main-mode").value, "path"); assert.equal(env.field("camera-sub-mode").value, "path");
  let payload = env.editor.getPayload(); assert.equal(payload.streams.main, "/main?token=a%2Fb"); assert.equal(payload.streams.sub, "/sub?"); assert.equal(payload.connection.port, 8554);
  env.field("camera-password").value = "changed"; payload = env.editor.getPayload(); assert.equal(payload.connection.password, "changed");
  env.editor.setSources({url: "https://camera.local:443/video/live.m3u8"}); assert.equal(env.editor.getPayload().streams.main, "/video/live.m3u8?"); assert.equal(env.editor.getPayload().connection.protocol, "https");
});

test("independent ONVIF sources stay full URLs and a sub-only assignment cannot overwrite the shared main credentials", () => {
  const env = environment(); env.editor.setSources({url: "rtsp://main:password@192.168.1.10/main", third_url: "https://other:secret@192.168.1.11:8443/live.m3u8?key=x"});
  assert.equal(env.field("camera-third-mode").value, "url"); assert.equal(env.editor.getPayload().streams.third, "https://other:secret@192.168.1.11:8443/live.m3u8?key=x");
  env.editor.setSources({preview_url: "rtsp://preview:otherpass@192.168.1.12/sub"});
  assert.equal(env.field("camera-username").value, "main"); assert.equal(env.field("camera-password").value, "password"); assert.equal(env.field("camera-sub-mode").value, "url");
});

test("full URL mode is authoritative and clearly warns that shared connection edits do not apply", () => {
  const env = environment(); env.change("camera-main-mode", "url"); env.field("camera-url").value = "https://user:pass@camera.local/live.m3u8";
  env.field("camera-password").value = "ignored-shared-password";
  const payload = env.editor.getPayload(); assert.equal(payload.connection, null); assert.equal(payload.streams.main, "https://user:pass@camera.local/live.m3u8");
  assert.equal(env.field("camera-main-override-note").hidden, false); assert.match(env.field("camera-main-override-note").textContent, /takes precedence/);
});

test("protocol defaults follow RTSP554/RTSPS322/HTTP80/HTTPS443 without overwriting a custom port and IPv6 is accepted", () => {
  const env = environment(); assert.equal(env.field("camera-port").value, "554");
  env.change("camera-protocol", "rtsps"); assert.equal(env.field("camera-port").value, "322");
  env.change("camera-protocol", "https"); assert.equal(env.field("camera-port").value, "443");
  env.field("camera-port").value = "8443"; env.change("camera-protocol", "http"); assert.equal(env.field("camera-port").value, "8443");
  env.field("camera-host").value = "[2001:db8::42]"; assert.equal(env.editor.getPayload().connection.host, "2001:db8::42");
  env.editor.setSources({url: "rtsps://user:pass@[2001:db8::42]/main"}); assert.equal(env.field("camera-port").value, "322"); assert.equal(env.editor.getPayload().connection.host, "2001:db8::42");
});

test("invalid ports, hosts, credentials, fragments and nonstandard schemes cannot produce a payload", () => {
  const env = environment(); env.field("camera-host").value = "camera.local";
  for (const port of ["0", "65536", "1.5", "1e3", "-1", "abc"]) { env.field("camera-port").value = port; assert.throws(() => env.editor.getPayload(), /port/); }
  env.field("camera-port").value = "554";
  for (const host of ["", "user@camera.local", "camera.local/path", "camera.local:554", "bad host", "camera.local?x=1"]) { env.field("camera-host").value = host; assert.throws(() => env.editor.getPayload(), /hostname/); }
  env.field("camera-host").value = "camera.local";
  for (const value of ["x".repeat(201), "user\nname"]) { env.field("camera-username").value = value; assert.throws(() => env.editor.getPayload(), /credentials/); }
  env.field("camera-username").value = "valid"; env.field("camera-password").value = "x".repeat(1025); assert.throws(() => env.editor.getPayload(), /credentials/);
  for (const value of ["file:///tmp/movie", "ftp://camera.local/video", "javascript:alert(1)", "rtsp://camera.local/main#fragment"]) assert.throws(() => parseSource(value));
  assert.throws(() => pathValue("rtsp://camera.local/video"), /Full URL/); assert.throws(() => pathValue("/main#fragment"), /fragment/);
  assert.equal(pathValue("stream/1?token=x%2Fy"), "/stream/1?token=x%2Fy"); assert.equal(pathValue("?"), "?");
});

test("supplied URLs are validated atomically before replacing a draft", () => {
  const env = environment(); env.field("camera-host").value = "old.local"; env.field("camera-password").value = "draft";
  assert.throws(() => env.editor.setSources({url: "rtsp://new:pass@new.local/main", preview_url: "not a URL"}));
  assert.equal(env.field("camera-host").value, "old.local"); assert.equal(env.field("camera-password").value, "draft");
});

test("relabel preserves unsaved passwords, stream modes and choices; reset/destroy clear supplied secrets and listeners", () => {
  const env = environment(); env.editor.setCamera(camera()); env.field("camera-password").value = "unsaved-secret"; env.field("camera-main-path").value = "/unsaved?token=1";
  env.change("camera-third-mode", "url"); env.field("camera-third-url").value = "rtsp://test:pass@other.local/third"; env.field("camera-live-stream").value = "3";
  env.language("it"); assert.equal(env.field("camera-password").value, "unsaved-secret"); assert.equal(env.field("camera-main-path").value, "/unsaved?token=1");
  assert.equal(env.field("camera-third-mode").value, "url"); assert.equal(env.field("camera-live-stream").value, "3"); assert.match(env.field("camera-password").placeholder, /^IT:/);
  env.editor.destroy();
  for (const id of ["camera-password", "camera-username", "camera-url", "camera-preview-url", "camera-third-url", "camera-main-path"]) assert.equal(env.field(id).value, "", id);
  assert.equal([...env.elements.values()].reduce((sum, item) => sum + [...item.listeners.values()].reduce((n, values) => n + values.size, 0), 0), 0);
});

test("probe choices refer only to saved streams while optional draft streams remain editable", () => {
  const env = environment(); env.editor.setCamera(camera({streams: {main: {configured: true}, sub: {configured: true}, third: {configured: false}}}));
  env.change("camera-third-enabled", true, true); env.field("camera-third-path").value = "/newthird"; env.field("camera-third-path").fire("input");
  assert.equal(env.field("camera-probe-controls").hidden, false); assert.equal(env.field("camera-probe-third-option").disabled, true); assert.equal(env.field("camera-probe-sub-option").disabled, false);
  assert.equal(env.field("camera-live-third-option").disabled, false);
});

test("camera markup retains legacy URL IDs, all three streams and compact20px headers without touching body controls", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8"), css = readFileSync(join(__dirname, "../nvr/static/style.css"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]); assert.equal(ids.length, new Set(ids).size);
  for (const id of ["camera-url", "camera-preview-url", "camera-third-url", "camera-protocol", "camera-host", "camera-port", "camera-username", "camera-password", "camera-live-stream", "camera-probe-stream", "network-third-profile"]) assert.ok(ids.includes(id), id);
  const main = html.match(/<input id="camera-url"[^>]*>/)[0]; assert.equal(/\brequired\b/.test(main), false);
  assert.match(css, /dialog\.modal \.modal-heading\{[^}]*height:20px!important[^}]*min-height:20px!important[^}]*max-height:20px!important[^}]*padding:0 6px!important/);
  assert.match(css, /dialog\.modal \.modal-heading \.icon-button>svg\{width:16px!important;height:16px!important/);
  assert.ok(html.indexOf("/static/camera-editor.js") < html.indexOf("/static/app.js"));
});
