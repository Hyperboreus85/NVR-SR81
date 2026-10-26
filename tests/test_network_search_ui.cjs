"use strict";
// Search and preset operations use a fake API; these tests never access a network.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../nvr/static/network-search.js"), "utf8");
const {parseTargets, validateTarget, ports} = require("../nvr/static/network-search.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function environment({onSearch} = {}) {
  const nodes = new Map(), events = new Map(), calls = [], used = [];
  let authenticated = false, access = true, language = "en", stored = [], max = 32;
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.parentElement = null; this.text = ""; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
    set innerHTML(_) { throw Error("HTML insertion forbidden"); }
    append(...children) { this.children.push(...children); children.forEach((child) => { child.parentElement = this; }); }
    replaceChildren(...children) { this.text = ""; this.children = []; this.append(...children); }
    toggleAttribute(name, state) { if (state) this.attributes.set(name, ""); else this.attributes.delete(name); if (name === "hidden") this.hidden = !!state; }
    closest() { return this.parentElement; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== handler)); }
    async fire(type) { const event = {target: this, preventDefault() { this.defaultPrevented = true; }}; for (const handler of this.listeners.get(type) || []) await handler(event); return event; }
  }
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  byId("network-view").hidden = true;
  byId("network-ports").value = "80,8000,8080,8899"; byId("network-rtsp-ports").value = "554,8554"; byId("network-rtsps-ports").value = "322";
  byId("network-manual-kind").value = "onvif";
  for (const name of ["onvif", "rtsp", "rtsps", "mdns"]) new Element("label").append(byId("network-method-" + name));
  const envelope = () => ({targets: stored.map((item) => ({...item})), max_targets: max});
  const defaultApi = async (path, options) => {
    if (path === "/api/network/targets" && !options.method) return envelope();
    if (path === "/api/network/targets" && options.method === "POST") { stored.push({id: "target-" + (stored.length + 1), ...options.body}); return envelope(); }
    if (options.method === "DELETE") { stored = stored.filter((item) => item.id !== decodeURIComponent(path.split("/").pop())); return envelope(); }
    throw Error("Unexpected fake API call");
  };
  let handler = defaultApi;
  const context = vm.createContext({console, AbortController, URL, Promise}); context.window = context;
  context.document = {getElementById: byId, createElement: (tag) => new Element(tag)};
  context.NvrAccess = {can: (permission) => access && permission === "network"};
  context.addEventListener = (type, handler) => { if (!events.has(type)) events.set(type, []); events.get(type).push(handler); };
  context.removeEventListener = (type, handler) => events.set(type, (events.get(type) || []).filter((item) => item !== handler));
  const emit = (type) => { for (const listener of events.get(type) || []) listener({type}); };
  vm.runInContext(source, context, {filename: "network-search.js"});
  const controller = new context.NvrNetworkSearch({api(path, options = {}) { calls.push({path, options}); return handler(path, options); }, isAuthenticated: () => authenticated,
    t(key, params = {}) { const value = language === "it" && key === "Partial results" ? "Risultati parziali" : key; return value.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token); },
    onUseTarget: (targets) => used.push(plain(targets)), onSearch});
  return {context, controller, byId, calls, used, envelope, defaultApi, emit,
    handler(value) { handler = value; }, targets(value) { stored = value; }, max(value) { max = value; },
    auth(value) { authenticated = value; emit("nvr-authchange"); }, access(value) { access = value; emit("nvr-accesschange"); },
    async open() { byId("network-view").hidden = false; await controller.open(); },
    language(value) { language = value; emit("nvr-languagechange"); },
    row(id) { const index = controller.targets.findIndex((item) => item.id === id); return byId("network-target-list").children[index]; },
    async select(id, value = true) { const checkbox = this.row(id).children[0].children[0]; checkbox.checked = value; await checkbox.fire("change"); },
  };
}
const writes = (env) => env.calls.filter((call) => call.options.method);

test("targets accept explicit hosts and bounded private networks, rejecting URLs, credentials and broad/public ranges", () => {
  for (const value of ["192.168.1.0/24", "10.2.3.0/25", "100.64.0.0/24", "169.254.50.0/24", "169.254.1.5/32", "203.0.113.5", "8.8.8.8/32", "camera.example.net", "camera.local", "2001:db8::25", "[2001:db8::25]/128"]) assert.equal(validateTarget(value), value);
  for (const value of ["192.168.0.0/23", "8.8.8.0/24", "2001:db8::/64", "rtsp://camera/live", "user:password@camera", "camera:554", "127.0.0.1", "224.0.0.1", "169.254.169.254", "::1", "0.0.0.0", "192.168.1.300", "camera/path", "camera?token=x"]) assert.throws(() => validateTarget(value), undefined, value);
  assert.deepEqual(parseTargets("camera.local,192.168.1.0/24\ncamera.local"), ["camera.local", "192.168.1.0/24"]);
  assert.throws(() => parseTargets(Array.from({length: 17}, (_, i) => `cam${i}.local`).join("\n")), /1 to 16/);
  assert.throws(() => parseTargets("  "), /1 to 16/);
});

test("ports are explicit valid integers with at most eight distinct values per protocol", () => {
  assert.deepEqual(ports("554,8554,554 322"), [554, 8554, 322]);
  for (const input of ["", "0", "65536", "80.5", "80,word", "1,2,3,4,5,6,7,8,9"]) assert.throws(() => ports(input));
});

test("local and target searches retain separate method drafts and readForm never starts a search", async () => {
  const env = environment(); env.auth(true);
  env.byId("network-interface").value = "192.168.1.20";
  assert.deepEqual(plain(env.controller.readForm()), {mode: "local", interface_ip: "192.168.1.20", targets: [], methods: ["onvif", "mdns"], onvif_ports: [], rtsp_ports: [], rtsps_ports: [], timeout: .75});
  assert.equal(env.byId("network-local-controls").hidden, false); assert.equal(env.byId("network-cidr").disabled, true);
  env.controller.setMode("targets"); env.byId("network-cidr").value = "camera.local\n192.168.2.0/24";
  assert.deepEqual(plain(env.controller.readForm()), {mode: "targets", interface_ip: null, targets: ["camera.local", "192.168.2.0/24"], methods: ["onvif", "rtsp"], onvif_ports: [80,8000,8080,8899], rtsp_ports: [554,8554], rtsps_ports: [], timeout: .75});
  env.byId("network-method-rtsps").checked = true; await env.byId("network-method-rtsps").fire("change");
  env.byId("network-method-onvif").checked = false; await env.byId("network-method-onvif").fire("change");
  env.controller.setMode("local"); assert.deepEqual(plain(env.controller.readForm().methods), ["onvif", "mdns"]);
  env.controller.setMode("targets"); assert.deepEqual(plain(env.controller.readForm().methods), ["rtsp", "rtsps"]);
  assert.equal(env.byId("network-method-mdns").disabled, true); assert.equal(env.byId("network-method-mdns").parentElement.hidden, true); assert.equal(env.calls.length, 0);
  env.byId("network-method-rtsp").checked = env.byId("network-method-rtsps").checked = false;
  assert.throws(() => env.controller.readForm(), /at least one/);
});

test("busy search locks only search/preset controls and exposes measured progress without fabricated percentages", async () => {
  const env = environment(); env.auth(true); await env.open();
  env.byId("network-username").value = "operator"; env.byId("network-password").value = "unsaved-secret";
  env.controller.setBusy(true);
  assert.equal(env.byId("network-discover").disabled, true); assert.equal(env.byId("network-search-mode").disabled, true); assert.equal(env.byId("network-target-save").disabled, true); assert.equal(env.byId("network-cancel").hidden, false);
  assert.equal(env.byId("network-username").disabled, false); assert.equal(env.byId("network-password").disabled, false);
  assert.equal(env.byId("network-progress-label").textContent, "Searching…");
  env.controller.progress({completed: 7, total: 260, duration: 2.8, partial: true});
  assert.equal(env.byId("network-progress-label").textContent, "Partial results · 7 / 260 checked · 2 s");
  env.language("it"); assert.equal(env.byId("network-progress-label").textContent, "Risultati parziali · 7 / 260 checked · 2 s");
  assert.equal(env.byId("network-password").value, "unsaved-secret");
  env.controller.setBusy(false); assert.equal(env.byId("network-progress").hidden, false); assert.equal(env.byId("network-discover").disabled, false);
  env.controller.progress({state:"cancelled", completed:7, total:260, duration:3.2}); assert.equal(env.byId("network-progress-label").textContent, "Search cancelled. · 7 / 260 checked · 3 s");
  env.controller.progress({completed: -1, total: 0, duration: Infinity}); assert.equal(env.byId("network-progress-label").textContent, "Search complete");
  env.controller.progress(null); assert.equal(env.byId("network-progress").hidden, true);
});

test("preset reads are failclosed and only run when the authenticated Network page is visible", async () => {
  const env = environment(); await env.controller.open(); assert.equal(env.calls.length, 0);
  env.auth(true); await env.controller.open(); assert.equal(env.calls.length, 0);
  env.access(false); await env.open(); assert.equal(env.calls.length, 0);
  env.access(true); delete env.context.NvrAccess; await env.controller.open(); assert.equal(env.calls.length, 0);
  env.context.NvrAccess = {can: () => true}; await env.controller.open(); assert.equal(env.calls.length, 1); assert.ok(env.calls[0].options.signal);
  env.controller.close(); env.byId("network-target-name").value = "Closed"; env.byId("network-target-address").value = "camera.local"; await env.controller.saveTarget(); assert.equal(writes(env).length, 0);
});

test("saved targets are inert text and Use selected only fills the search draft", async () => {
  const env = environment(); env.targets([{id:"one", name:"<img src=x onerror=alert(1)>", address:"camera.local"}, {id:"two", name:"Other network", address:"192.168.2.0/24"}]); env.auth(true); await env.open();
  assert.equal(env.row("one").children[0].children[1].children[0].textContent, "<img src=x onerror=alert(1)>");
  await env.select("one"); await env.select("two"); await env.byId("network-target-use").fire("click");
  assert.equal(env.controller.mode, "targets"); assert.equal(env.byId("network-cidr").value, "camera.local\n192.168.2.0/24");
  assert.deepEqual(env.used, [["camera.local", "192.168.2.0/24"]]); assert.equal(env.calls.length, 1); assert.equal(writes(env).length, 0);
});

test("saving a target is explicit, single-flight and does not overwrite search or device drafts", async () => {
  const env = environment(); env.auth(true); await env.open(); env.controller.setMode("targets"); env.byId("network-cidr").value = "camera-to-search.local";
  env.byId("network-target-name").value = "  Remote gate  "; env.byId("network-target-address").value = "gate.example.net"; env.byId("network-password").value = "private";
  const wait = deferred(); env.handler(() => wait.promise); const pending = env.controller.saveTarget(); await flush(); await env.controller.saveTarget();
  assert.equal(writes(env).length, 1); assert.deepEqual(plain(writes(env)[0].options.body), {name:"Remote gate", address:"gate.example.net"});
  assert.equal(env.byId("network-discover").disabled, true); env.language("it"); assert.equal(env.byId("network-target-name").value, "  Remote gate  ");
  wait.resolve({targets:[{id:"saved", name:"Remote gate", address:"gate.example.net"}], max_targets:32}); await pending;
  assert.equal(env.byId("network-target-name").value, ""); assert.equal(env.byId("network-target-address").value, "");
  assert.equal(env.byId("network-cidr").value, "camera-to-search.local"); assert.equal(env.byId("network-password").value, "private"); assert.equal(env.byId("network-targets-notice").textContent, "Target saved."); assert.equal(env.byId("network-discover").disabled, false);
});

test("invalid preset drafts or capacity never send writes; selected usage is limited to sixteen", async () => {
  const env = environment(); env.auth(true); await env.open();
  env.byId("network-target-name").value = "bad\u202ename"; env.byId("network-target-address").value = "camera.local"; await env.controller.saveTarget(); assert.equal(writes(env).length, 0);
  env.byId("network-target-name").value = "x".repeat(61); await env.controller.saveTarget(); assert.equal(writes(env).length, 0); assert.match(env.byId("network-targets-error").textContent, /60 characters/);
  env.byId("network-target-name").value = "Good"; env.byId("network-target-address").value = "camera.local,other.local"; await env.controller.saveTarget(); assert.equal(writes(env).length, 0);
  env.controller.updateTargets({targets:Array.from({length:17}, (_, i) => ({id:String(i), name:`Camera ${i}`, address:`camera${i}.local`})), max_targets:17});
  env.controller.selected = new Set(env.controller.targets.map((item) => item.id)); env.controller.useSelected(); assert.match(env.byId("network-targets-error").textContent, /1 to 16/); assert.equal(env.byId("network-cidr").value, "");
  await env.controller.saveTarget(); assert.equal(writes(env).length, 0); assert.equal(env.byId("network-target-save").disabled, true);
});

test("preset errors remain retryable, deletes are explicit and cannot trigger a scan", async () => {
  const env = environment(); env.targets([{id:"a/b", name:"Gate", address:"gate.local"}]); env.auth(true); await env.open();
  env.handler(async () => { throw Error("Unable to save targets. Try again."); }); await env.row("a/b").children[1].fire("click");
  assert.equal(writes(env).length, 1); assert.equal(writes(env)[0].path, "/api/network/targets/a%2Fb"); assert.equal(writes(env)[0].options.method, "DELETE");
  assert.equal(env.byId("network-targets-error").hidden, false); assert.equal(env.byId("network-target-refresh").disabled, false); assert.equal(env.controller.targets.length, 1);
  env.handler(env.defaultApi); await env.row("a/b").children[1].fire("click"); assert.equal(env.controller.targets.length, 0); assert.equal(env.byId("network-targets-notice").textContent, "Target removed.");
  assert.equal(env.calls.some((call) => call.path.includes("/search")), false);
});

test("closing aborts stale reads while newer opens and edits retain their own state", async () => {
  const env = environment(); env.auth(true); env.byId("network-view").hidden = false;
  const first = deferred(), second = deferred(); let count = 0; env.handler(() => ++count === 1 ? first.promise : second.promise);
  const old = env.controller.open(); await flush(); const oldSignal = env.calls[0].options.signal;
  env.controller.close(); assert.equal(oldSignal.aborted, true); const current = env.controller.open(); await flush();
  env.byId("network-target-name").value = "New unsaved target";
  first.resolve({targets:[{id:"old",name:"Old",address:"old.local"}],max_targets:32}); await old;
  assert.equal(env.controller.targets.length, 0); assert.equal(env.controller.reading, true);
  second.resolve({targets:[{id:"new",name:"New",address:"new.local"}],max_targets:32}); await current;
  assert.equal(env.controller.targets[0].id, "new"); assert.equal(env.byId("network-target-name").value, "New unsaved target");
});

test("late writes after logout or revoked permission cannot restore targets, messages or new session drafts", async () => {
  const env = environment(); env.auth(true); await env.open(); env.byId("network-target-name").value = "Gate"; env.byId("network-target-address").value = "gate.local";
  const oldResponse = deferred(); env.handler(() => oldResponse.promise); const old = env.controller.saveTarget(); await flush();
  const signal = writes(env)[0].options.signal; env.auth(false); assert.equal(signal.aborted, true); assert.equal(env.controller.writing, false); assert.equal(env.byId("network-target-name").value, "");
  env.auth(true); env.byId("network-target-name").value = "New session draft";
  oldResponse.resolve({targets:[{id:"old",name:"Old",address:"old.local"}],max_targets:32}); await old;
  assert.equal(env.controller.targets.length, 0); assert.equal(env.byId("network-targets-notice").hidden, true); assert.equal(env.byId("network-target-name").value, "New session draft");
  env.handler(env.defaultApi); await env.open(); const pending = deferred(); env.handler(() => pending.promise); env.byId("network-target-name").value = "Gate"; env.byId("network-target-address").value = "gate.local";
  const revoked = env.controller.saveTarget(); await flush(); env.access(false); pending.reject(Error("Late forbidden error")); await revoked;
  assert.equal(env.controller.targets.length, 0); assert.equal(env.byId("network-targets-error").hidden, true); assert.equal(env.byId("network-target-save").disabled, true);
});

test("malformed envelopes fail safely and manual stream mode preserves entered addresses", async () => {
  const env = environment(); env.auth(true); env.handler(async () => ({targets:[{id:"bad"}],max_targets:32})); await env.open();
  assert.match(env.byId("network-targets-error").textContent, /unavailable/); assert.equal(env.controller.targets.length, 0);
  env.byId("network-manual-endpoint").value = "https://camera.example.net/onvif/device_service"; env.byId("network-manual-kind").value = "stream"; await env.byId("network-manual-kind").fire("change");
  assert.match(env.byId("network-manual-endpoint").placeholder, /^rtsp:/); assert.equal(env.byId("network-manual-endpoint").value, "https://camera.example.net/onvif/device_service");
  env.language("it"); assert.equal(env.byId("network-manual-endpoint").value, "https://camera.example.net/onvif/device_service"); assert.equal(writes(env).length, 0);
});

test("Network markup keeps legacy IDs and places new remote/direct fields in the existing explorer", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  const section = html.slice(html.indexOf('<section id="network-view"'), html.indexOf('<section id="no-access-view"'));
  assert.equal((html.match(/id="network-view"/g) || []).length, 1); assert.doesNotMatch(section, /class="page-heading"|class="explorer-placeholder"/);
  for (const id of ["network-interface","network-discover","network-cancel","network-scan-form","network-cidr","network-ports","network-scan","network-manual-form","network-manual-endpoint","network-endpoint","network-profile-form","network-read-profiles","network-main-profile","network-preview-profile","network-third-profile","network-add-recorder","network-direct-tools","network-direct-url","network-direct-test","network-direct-add","network-use-endpoint-address","network-stream-host","network-stream-port"]) assert.equal((section.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  assert.ok(section.indexOf('id="network-device-explorer"') < section.indexOf('id="network-direct-tools"'));
  assert.ok(section.indexOf('id="network-profile-form"') < section.indexOf('id="network-use-endpoint-address"'));
  const profile = section.slice(section.indexOf('<form id="network-profile-form"'), section.indexOf('</form>', section.indexOf('<form id="network-profile-form"')));
  assert.ok(profile.indexOf('id="network-username"') < profile.indexOf('id="network-onvif-controls"'));
  const onvif = profile.slice(profile.indexOf('id="network-onvif-controls"'));
  assert.match(onvif, /id="network-endpoint"/); assert.match(onvif, /id="network-read-profiles"/); assert.doesNotMatch(onvif, /id="network-(username|password)"/);
  assert.ok(section.indexOf('id="network-direct-tools"') > section.indexOf('</form>', section.indexOf('<form id="network-profile-form"')));
  assert.match(section, /id="network-target-name" maxlength="60"/);
  assert.match(section, /id="network-direct-add"[^>]*disabled/); assert.ok(html.indexOf("/static/network-search.js?") < html.indexOf("/static/app.js?"));
});
