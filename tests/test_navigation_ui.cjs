"use strict";
// Execute the actual application controller with DOM/media boundaries replaced.
// No browser, camera, WebSocket connection or server password is involved.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../nvr/static/app.js"), "utf8");
const preferencesSource = readFileSync(join(__dirname, "../nvr/static/recorder-preferences.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.parentElement = null; this.hidden = false; this.disabled = false;
    this.value = ""; this.checked = false; this.muted = true; this.paused = true; this.currentTime = 0;
    this.style = {setProperty(name, value) { this[name] = value; }};
    const classes = new Set();
    this.classList = {add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name), toggle(name, active = !classes.has(name)) { active ? classes.add(name) : classes.delete(name); return active; }};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent || "").join(""); }
  set innerHTML(_) { throw Error("HTML insertion is forbidden in navigation"); }
  append(...children) { this.text = ""; for (const child of children) { child.remove?.(); child.parentElement = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  insertBefore(child, before) { child.remove?.(); const index = before ? this.children.indexOf(before) : -1; child.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  async fire(type, details = {}) { for (const listener of this.listeners.get(type) || []) await listener({type, target: this, preventDefault() {}, stopPropagation() {}, ...details}); }
  querySelector(selector) { if (!this.selectors) this.selectors = new Map(); if (!this.selectors.has(selector)) this.selectors.set(selector, new Element(selector.startsWith("button") ? "button" : "div")); return this.selectors.get(selector); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return descendants;
    return descendants.filter((item) => selector.startsWith(".")
      ? String(item.className || "").split(/\s+/).includes(selector.slice(1)) || item.classList.contains(selector.slice(1))
      : item.tagName === selector.toUpperCase());
  }
  get options() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 640, height: 100}; }
  getContext() { return new Proxy({measureText: () => ({width: 40})}, {get: (target, name) => name in target ? target[name] : () => {}}); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  focus() { this.focused = true; }
  reset() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
}

function camera(id) {
  return {id, name: "Camera " + id, source: "rtsp://camera-" + id + "/main", preview_source: "rtsp://camera-" + id + "/sub",
    enabled: true, audio_mode: "copy", retention_days: 7, status: {state: "recording", message: "Recording"}};
}
const snapshot = (size = 4, ids = ["a", "b", "c", "d"]) => ({version: 1, size, slots: Array.from({length: 16}, (_, index) => ids[index] || null)});
const clone = (value) => JSON.parse(JSON.stringify(value));
const generalSettings = (extra = {}) => ({recorder_name: "Fixture recorder", timezone: "UTC", effective_timezone: "UTC", hour_format: "24", rotation_seconds: 0, ...extra});

function environment({cameras = ["a", "b", "c", "d"].map(camera), saved = snapshot(), legacySize = null, handler, telemetry = false, history = false,
                      preferences = true, general = generalSettings()} = {}) {
  const nodes = new Map(), windowEvents = new Map(), documentEvents = new Map(), calls = [], players = [], layouts = [], timers = new Map();
  const storage = new Map(legacySize === null ? [] : [["nvr.monitor.layout", String(legacySize)]]);
  const ready = deferred(); let timer = 0, language = "en", settingsOpens = 0;
  const timerDetails = new Map(); let timerNow = 0;
  const schedule = (callback, delay = 0, repeat = false) => {
    const id = ++timer; timers.set(id, callback); timerDetails.set(id, {due: timerNow + Number(delay), delay: Number(delay), repeat}); return id;
  };
  const cancel = (id) => { timers.delete(id); timerDetails.delete(id); };
  const node = (id) => { if (!nodes.has(id)) { const item = new Element(id === "player" ? "video" : "div"); item.id = id; nodes.set(id, item); } return nodes.get(id); };
  const layoutButtons = [1, 4, 9, 16].map((size) => { const button = new Element("button"); button.dataset.monitorLayout = String(size); return button; });
  const document = {hidden: false, fullscreenElement: null, body: new Element("body"), getElementById: node,
    createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: (text) => Object.assign(new Element("text"), {textContent: text}),
    querySelectorAll: (selector) => selector === "[data-monitor-layout]" ? layoutButtons : [],
    addEventListener(type, listener) { if (!documentEvents.has(type)) documentEvents.set(type, []); documentEvents.get(type).push(listener); },
    async exitFullscreen() { document.fullscreenElement = null; for (const callback of documentEvents.get("fullscreenchange") || []) await callback({type: "fullscreenchange"}); },
  };
  class LivePlayer {
    constructor(video, options) { this.video = video; this.options = options; this.active = false; this.destroyed = false; this.starts = this.stops = this.relabels = 0; players.push(this); }
    start() { if (!this.active && !this.destroyed) { this.active = true; this.starts += 1; } }
    stop() { if (this.active) this.stops += 1; this.active = false; }
    destroy() { this.stop(); this.destroyed = true; }
    relabel() { this.relabels += 1; }
    status(info) { this.options.onStatus(info); }
  }
  class LiveLayout {
    constructor(options) { this.options = options; this.saved = clone(saved); this.draft = clone(saved); this.visible = false; this.destroyed = false; this.relabels = 0; this.cameraUpdates = []; layouts.push(this); }
    getSaved() { return clone(this.saved); }
    setCameras(value) { this.cameraUpdates.push(value); const known = new Set(value.map((item) => item.id)); this.saved.slots = this.saved.slots.map((id) => known.has(id) ? id : null); }
    open() { this.visible = true; }
    close() { this.visible = false; }
    destroy() { this.close(); this.destroyed = true; }
    relabel() { this.relabels += 1; }
    render() {}
    applySize(size) {
      if (this.failNextApply) {
        this.failNextApply = false;
        this.options.onError(vm.runInContext('new Error("The layout could not be saved in this browser. Check browser storage permissions and try again.")', context));
        return false;
      }
      if (![1, 4, 9, 16].includes(size)) return false;
      this.saved.size = size; this.options.onSave(this.getSaved()); return true;
    }
    save(value) { this.saved = clone(value); this.options.onSave(this.getSaved()); }
  }
  const defaults = (path) => path === "/api/session" ? {authenticated: true}
    : path === "/api/cameras" ? cameras
    : path === "/api/system" ? {version: "test", recordings_bytes: 0, segment_seconds: 1800, ffmpeg_available: true, disk: {total: 100000, free: 90000, used: 10000}}
    : path === "/api/live/status" ? {active_streams: 0, max_streams: 16, active_transcodes: 0, max_transcodes: 2, streams: []}
    : path === "/api/settings/general" ? general
    : path === "/api/logout" ? {authenticated: false}
    : path.startsWith("/api/recordings") ? []
    : path === "/api/onvif/interfaces" ? [] : {};
  const context = vm.createContext({console, document, Intl, Headers, URL, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: cancel,
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: cancel,
    localStorage: {getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value))},
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    async fetch(path, options = {}) { calls.push({path, options}); const value = await (handler ? handler(path, options, defaults) : defaults(path)); return value instanceof Response ? value : new Response(JSON.stringify(value), {status: 200}); },
  });
  context.window = context; context.devicePixelRatio = 1; context.scrollTo = () => {};
  context.NvrLivePlayer = LivePlayer; context.NvrLiveLayout = LiveLayout;
  const telemetryViews = [], dashboardViews = [], historyViews = [];
  if (telemetry) context.NvrSystemTelemetry = class {
    constructor(options) { this.options=options; this.data=null; this.renders=0; this.clears=0; this.relabels=0; telemetryViews.push(this); }
    render(value) { this.data=value; this.renders+=1; }
    clear() { this.data=null; this.clears+=1; }
    relabel() { this.relabels+=1; }
  };
  if (telemetry) context.NvrSystemDashboard = class {
    constructor(options) { this.options=options; this.data=null; this.renders=0; this.clears=0; this.relabels=0; dashboardViews.push(this); }
    render(value) { this.data=value; this.renders+=1; }
    clear() { this.data=null; this.clears+=1; }
    relabel() { this.relabels+=1; }
  };
  if (history) context.NvrSystemHistory = class {
    constructor(options) { this.options=options; this.opens=0; this.closes=0; this.clears=0; this.ticks=0; this.relabels=0; historyViews.push(this); }
    open() { this.opens++; }
    close() { this.closes++; }
    clear() { this.clears++; }
    relabel() { this.relabels++; }
    onTelemetrySnapshot() { if (this.options.isActive()) this.ticks++; }
  };
  context.NvrSettings = {open() { settingsOpens += 1; }};
  context.NvrI18n = {ready: ready.promise, locale: () => language, getLanguage: () => language,
    t: (key, params = {}) => (language === "en" ? String(key) : "IT: " + key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token)};
  context.addEventListener = (type, listener) => { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(listener); };
  context.dispatchEvent = (event) => { for (const listener of windowEvents.get(event.type) || []) listener(event); return true; };
  if (preferences) vm.runInContext(preferencesSource, context, {filename: "recorder-preferences.js"});
  vm.runInContext(source, context, {filename: "app.js"});
  return {node, calls, players, layouts, layoutButtons, context, ready, document, storage, telemetryViews, dashboardViews, historyViews, timers,
    async boot() { ready.resolve(); await flush(); await flush(); },
    evaluate: (expression) => vm.runInContext(expression, context),
    async documentEvent(type, details = {}) { for (const listener of documentEvents.get(type) || []) await listener({type, ...details}); },
    async windowEvent(type, details = {}) { for (const listener of windowEvents.get(type) || []) await listener({type, ...details}); },
    language(value) { language = value; }, settingsOpens: () => settingsOpens,
    async runTimer(id) { const callback=timers.get(id); assert.equal(typeof callback,'function'); await callback(); await flush(); },
    async advanceTimers(milliseconds) {
      const end = timerNow + milliseconds;
      for (let count = 0; count < 1000; count++) {
        const next = [...timerDetails.entries()].filter(([id]) => timers.has(id)).sort(([, a], [, b]) => a.due - b.due)[0];
        if (!next || next[1].due > end) { timerNow = end; return; }
        const [id, details] = next, callback = timers.get(id); timerNow = details.due;
        if (details.repeat) details.due += Math.max(1, details.delay); else cancel(id);
        await callback(); await flush(); await flush();
      }
      throw Error("Unexpected application timer loop");
    },
  };
}

test("authenticated startup opens Live Monitor with the saved slot order and leaves blank slots empty", async () => {
  const env = environment({saved: snapshot(4, ["c", null, "a", "b"])});
  await env.boot();
  assert.equal(env.node("monitor-view").hidden, false);
  assert.equal(env.node("recorder-view").hidden, true);
  assert.equal(env.node("nav-monitor").getAttribute("aria-current"), "page");
  assert.equal(env.node("live-tab-monitor").getAttribute("aria-current"), "page");
  assert.equal(env.node("live-subnav").hidden, false);
  assert.equal(env.node("monitor-grid").children.length, 4);
  assert.deepEqual(env.players.map((item) => item.options.cameraId), ["c", "a", "b"]);
  assert.equal(env.players.filter((item) => item.active).length, 3);
});

test("Layout stops monitor players, retains the editor instance and opens no persistent camera streams", async () => {
  const env = environment(); await env.boot();
  const initial = [...env.players], layout = env.layouts[0];
  await env.node("live-tab-layout").fire("click");
  assert.equal(initial.every((item) => item.destroyed), true);
  assert.equal(layout.visible, true);
  assert.equal(env.node("monitor-view").hidden, true);
  assert.equal(env.node("live-layout-view").hidden, false);
  assert.equal(env.node("live-subnav").hidden, false);
  assert.equal(env.node("nav-monitor").getAttribute("aria-current"), "page");
  assert.equal(env.node("live-tab-layout").getAttribute("aria-current"), "page");
  assert.equal(env.players.length, initial.length);
  await env.node("live-tab-monitor").fire("click");
  assert.equal(layout.visible, false);
  assert.equal(env.layouts.length, 1);
  assert.equal(env.players.filter((item) => item.active).length, 4);
});

test("leaving Live for camera configuration or settings releases streams and returning restores the wall", async () => {
  const env = environment(); await env.boot();
  assert.equal(env.node("settings-subnav").hidden, true);
  await env.node("nav-cameras").fire("click");
  assert.equal(env.players.every((item) => !item.active), true);
  assert.equal(env.node("live-subnav").hidden, true);
  assert.equal(env.node("nav-cameras").getAttribute("aria-current"), "page");
  await env.node("nav-monitor").fire("click");
  assert.equal(env.players.filter((item) => item.active).length, 4);
  await env.node("nav-settings").fire("click");
  assert.equal(env.players.every((item) => !item.active), true);
  assert.equal(env.settingsOpens(), 1);
  assert.equal(env.node("settings-view").hidden, false);
  assert.equal(env.node("settings-subnav").hidden, false);
  assert.equal(env.node("live-subnav").hidden, true); assert.equal(env.node("record-subnav").hidden, true);
  assert.equal(env.node("current-view-label").hidden, true);
  env.language("it"); await env.windowEvent("nvr-languagechange");
  assert.equal(env.node("settings-subnav").hidden, false); assert.equal(env.node("current-view-label").hidden, true);
  await env.node("nav-recorder").fire("click");
  assert.equal(env.node("settings-subnav").hidden, true); assert.equal(env.node("record-subnav").hidden, false);
  await env.node("nav-monitor").fire("click");
  assert.equal(env.node("settings-subnav").hidden, true); assert.equal(env.node("live-subnav").hidden, false);
});

test("background and pagehide stop live resources, while a visible page can resume the monitor", async () => {
  const env = environment(); await env.boot();
  const original = [...env.players];
  env.document.hidden = true; await env.documentEvent("visibilitychange");
  assert.equal(original.every((item) => !item.active), true);
  env.document.hidden = false; await env.documentEvent("visibilitychange");
  assert.equal(original.every((item) => item.active), true);
  assert.equal(env.players.length, 4);
  await env.windowEvent("pagehide");
  assert.equal(original.every((item) => item.destroyed), true);
  await env.windowEvent("pageshow", {persisted: true});
  assert.equal(env.players.filter((item) => item.active).length, 4);
});

test("language changes relabel the current wall without replacing live players or its saved layout", async () => {
  const env = environment(); await env.boot();
  const original = [...env.players], layout = env.layouts[0], saved = layout.getSaved();
  env.language("it"); await env.windowEvent("nvr-languagechange");
  assert.equal(env.players.length, original.length);
  assert.equal(original.every((item) => item.active && !item.destroyed), true);
  assert.deepEqual(layout.getSaved(), saved);
  assert.equal(env.layouts.length, 1);
});

test("Layout draft survives relabeling and backgrounding while thumbnail work follows visibility", async () => {
  const env = environment(); await env.boot();
  await env.node("live-tab-layout").fire("click");
  const layout = env.layouts[0];
  layout.draft = snapshot(4, ["d", "b", "c", "a"]);
  const draft = clone(layout.draft), saved = layout.getSaved();
  env.language("it"); await env.windowEvent("nvr-languagechange");
  assert.equal(layout.relabels, 1);
  assert.deepEqual(layout.draft, draft); assert.deepEqual(layout.getSaved(), saved);
  env.document.hidden = true; await env.documentEvent("visibilitychange");
  assert.equal(layout.visible, false);
  env.document.hidden = false; await env.documentEvent("visibilitychange");
  assert.equal(layout.visible, true);
  assert.deepEqual(layout.draft, draft);
  assert.equal(env.players.every((item) => item.destroyed && !item.active), true);
});

test("saved slot changes preserve reusable players, exact empty positions and the order after refresh", async () => {
  const configured = ["a", "b", "c", "d"].map(camera);
  const env = environment({cameras: configured}); await env.boot();
  const original = new Map(env.players.map((item) => [item.options.cameraId, item]));
  env.layouts[0].save(snapshot(4, ["d", "a", null, "c"]));
  assert.equal(original.get("b").destroyed, true);
  assert.equal(env.players.length, 4, "Moving a camera must reuse its existing media player");
  const order = () => env.node("monitor-grid").children.map((item) => item.dataset.cameraId || null);
  assert.deepEqual(order(), ["d", "a", null, "c"]);
  configured.reverse(); configured.push(camera("new"));
  await env.node("refresh").fire("click");
  assert.deepEqual(order(), ["d", "a", null, "c"]);
  assert.equal(env.players.length, 4, "Newly configured cameras must not fill saved empty tiles");
  assert.equal([...original.values()].filter((item) => item.active).length, 3);
  await env.node("monitor-grid").children[2].fire("click");
  assert.equal(env.node("live-layout-view").hidden, false);
  assert.equal(env.players.every((item) => !item.active), true);
});

test("quick grid size applies the saved layout while retaining assignments in hidden slots", async () => {
  const env = environment(); await env.boot();
  const first = env.players[0];
  await env.layoutButtons[0].fire("click");
  assert.equal(env.node("monitor-grid").children.length, 1);
  assert.equal(first.active, true);
  assert.equal(env.players.filter((item) => item.active).length, 1);
  assert.deepEqual(env.layouts[0].getSaved().slots.slice(0, 4), ["a", "b", "c", "d"]);
  await env.layoutButtons[1].fire("click");
  assert.equal(env.node("monitor-grid").children.length, 4);
  assert.equal(first.destroyed, false);
  assert.equal(env.players.filter((item) => item.active).length, 4);
});

test("General grid preference follows the canonical layout and failed saves restore its displayed size", async () => {
  const env = environment({saved: snapshot(16), legacySize: 1}); await env.boot();
  assert.equal(env.layouts[0].getSaved().size, 16);
  assert.equal(env.node("settings-monitor-layout").value, "16", "A stale legacy preference must not override the saved wall");
  assert.equal(env.node("monitor-grid").children.length, 16);

  await env.layoutButtons.find((button) => button.dataset.monitorLayout === "4").fire("click");
  assert.equal(env.layouts[0].getSaved().size, 4);
  assert.equal(env.node("settings-monitor-layout").value, "4");
  assert.equal(env.storage.get("nvr.monitor.layout"), "4");

  env.layouts[0].failNextApply = true;
  env.node("settings-monitor-layout").value = "9";
  await env.windowEvent("nvr-monitor-layoutchange", {detail: {layout: 9}});
  assert.equal(env.layouts[0].getSaved().size, 4);
  assert.equal(env.node("settings-monitor-layout").value, "4");
  assert.equal(env.node("monitor-grid").children.length, 4);
  assert.match(env.node("toast").textContent, /could not be saved in this browser/);
  assert.doesNotMatch(env.node("toast").textContent, /Layout saved/);
});

test("audio starts muted, listening to one camera mutes the others and leaving Live clears the choice", async () => {
  const env = environment(); await env.boot();
  env.players.forEach((item) => item.status({state: "playing", message: "Playing", audio: true, mode: "copy"}));
  const audioButton = (id) => env.node("monitor-grid").children.find((item) => item.dataset.cameraId === id)
    .querySelectorAll("button").find((item) => item.getAttribute("aria-pressed") !== null);
  const first = env.players.find((item) => item.options.cameraId === "a"), second = env.players.find((item) => item.options.cameraId === "b");
  assert.equal(env.players.every((item) => item.video.muted), true);
  await audioButton("a").fire("click");
  assert.equal(first.video.muted, false); assert.equal(second.video.muted, true);
  await audioButton("b").fire("click");
  assert.equal(first.video.muted, true); assert.equal(second.video.muted, false);
  await env.node("live-tab-layout").fire("click");
  await env.node("live-tab-monitor").fire("click");
  assert.equal(env.players.filter((item) => item.active).every((item) => item.video.muted), true);
});

test("tile fullscreen pauses the other streams and resuming the wall reuses them", async () => {
  const env = environment(); await env.boot();
  const initial = [...env.players], tile = env.node("monitor-grid").children[0];
  tile.requestFullscreen = async () => { env.document.fullscreenElement = tile; await env.documentEvent("fullscreenchange"); };
  const fullscreen = tile.querySelectorAll("button").find((item) => item.getAttribute("aria-label") === "Show Camera a fullscreen");
  await fullscreen.fire("click");
  assert.deepEqual(initial.filter((item) => item.active).map((item) => item.options.cameraId), ["a"]);
  await env.document.exitFullscreen();
  assert.equal(initial.every((item) => item.active && !item.destroyed), true);
  assert.equal(env.players.length, 4);
});

test("a fullscreen request resolving after opening Layout exits fullscreen without reopening streams", async () => {
  const env = environment(); await env.boot();
  const pendingFullscreen = deferred(), tile = env.node("monitor-grid").children[0];
  tile.requestFullscreen = async () => { await pendingFullscreen.promise; env.document.fullscreenElement = tile; };
  const fullscreen = tile.querySelectorAll("button").find((item) => item.getAttribute("aria-label") === "Show Camera a fullscreen");
  const opening = fullscreen.fire("click");
  await env.node("live-tab-layout").fire("click");
  pendingFullscreen.resolve(); await opening;
  assert.equal(env.document.fullscreenElement, null);
  assert.equal(env.players.every((item) => item.destroyed && !item.active), true);
  assert.equal(env.node("live-layout-view").hidden, false);
  assert.equal(env.layouts[0].visible, true);
});

test("whole-wall fullscreen resolving after logout is exited without restoring the authenticated view", async () => {
  const env = environment(); await env.boot();
  const pendingFullscreen = deferred(), grid = env.node("monitor-grid");
  grid.requestFullscreen = async () => { await pendingFullscreen.promise; env.document.fullscreenElement = grid; };
  const opening = env.node("monitor-fullscreen").fire("click");
  await env.node("logout").fire("click");
  pendingFullscreen.resolve(); await opening;
  assert.equal(env.document.fullscreenElement, null);
  assert.equal(env.node("app").hidden, true);
  assert.equal(env.players.every((item) => item.destroyed && !item.active), true);
});

test("logout destroys the wall and its editor before the next session", async () => {
  const env = environment(); await env.boot();
  const initial = [...env.players], layout = env.layouts[0];
  await env.node("logout").fire("click");
  assert.equal(initial.every((item) => item.destroyed && !item.active), true);
  assert.equal(layout.destroyed, true);
  assert.equal(env.node("app").hidden, true);
  assert.equal(env.node("login-screen").hidden, false);
  await env.windowEvent("pageshow", {persisted: true});
  assert.equal(env.players.length, initial.length);
});

test("logout destroys players and layout, and a late startup response cannot reopen the wall", async () => {
  const cameras = deferred();
  const env = environment({handler: (path, options, fallback) => path === "/api/cameras" ? cameras.promise : fallback(path)});
  env.ready.resolve(); await flush();
  await env.node("logout").fire("click");
  cameras.resolve([camera("a")]); await flush(); await flush();
  assert.equal(env.node("app").hidden, true);
  assert.equal(env.node("login-screen").hidden, false);
  assert.equal(env.players.length, 0);
  assert.equal(env.layouts.length, 0);
});

test("changing the saved Live stream rebuilds its player and labels the effective Main, Sub or Third source", async () => {
  const configured = {...camera("a"), third_source: "rtsp://camera-a/third", live_stream: 2};
  const env = environment({cameras: [configured], saved: snapshot(1, ["a"])}); await env.boot();
  const quality = () => env.node("monitor-grid").querySelectorAll(".monitor-quality")[0].textContent;
  assert.equal(quality(), "SUBSTREAM");
  const first = env.players.at(-1);
  env.evaluate("state.cameras[0].live_stream = 1; renderMonitor()");
  assert.equal(first.destroyed, true);
  assert.equal(quality(), "MAIN STREAM");
  const main = env.players.at(-1);
  env.evaluate("state.cameras[0].live_stream = 3; renderMonitor()");
  assert.equal(main.destroyed, true);
  assert.equal(quality(), "Third stream");
  env.evaluate("state.cameras[0].third_source = ''; renderMonitor()");
  assert.equal(quality(), "MAIN STREAM");
});

test("a late Main probe cannot overwrite the selected Third probe or unlock its in-flight controls", async () => {
  const main = deferred(), third = deferred();
  const env = environment({handler(path, options, fallback) {
    if (path.endsWith("/probe?stream=1")) return main.promise;
    if (path.endsWith("/probe?stream=3")) return third.promise;
    return fallback(path);
  }});
  await env.boot(); await env.node("edit-camera").fire("click");
  const old = env.node("probe-camera").fire("click"); await flush();
  assert.equal(env.node("camera-probe-stream").disabled, true);
  const firstRequest = env.calls.find((call) => call.path.endsWith("/probe?stream=1"));
  env.node("camera-probe-stream").value = "3";
  await env.node("camera-probe-stream").fire("change");
  assert.equal(firstRequest.options.signal.aborted, true);
  const current = env.node("probe-camera").fire("click"); await flush();
  main.resolve({video_codec: "h264"}); await old;
  assert.equal(env.node("probe-camera").disabled, true);
  assert.doesNotMatch(env.node("probe-result").textContent, /h264/);
  third.resolve({video_codec: "hevc"}); await current;
  assert.match(env.node("probe-result").textContent, /hevc/);
  assert.equal(env.node("probe-camera").disabled, false);
  assert.equal(env.node("camera-probe-stream").disabled, false);
});

const telemetrySample = (usage=25) => ({sampled_at:1000,scope:'container',cpu:{percent:usage},memory:{},swap:{},disk:{}});
const telemetryCalls = (env) => env.calls.filter((call)=>call.path==='/api/system/telemetry');

test("saved history follows the System tab and shared telemetry; backgrounding pauses reads and logout clears private data", async()=>{
  const env=environment({telemetry:true,history:true,handler(path,options,fallback){
    return path==='/api/system/telemetry'?telemetrySample(20):fallback(path);
  }});
  env.node('settings-system-panel').hidden=true;
  await env.boot();
  assert.equal(env.historyViews.length,0);
  await env.node('nav-settings').fire('click');
  assert.equal(env.historyViews.length,0);
  env.node('settings-system-panel').hidden=false;
  await env.windowEvent('nvr-settings-tabchange',{detail:{tab:'system'}});
  assert.equal(env.historyViews.length,1);
  const history=env.historyViews[0], ticks=history.ticks;
  assert.equal(history.options.isActive(),true);
  await env.evaluate('loadSystemTelemetry()');
  assert.ok(history.ticks>ticks);
  env.node('settings-system-panel').hidden=true;
  await env.windowEvent('nvr-settings-tabchange',{detail:{tab:'general'}});
  assert.equal(history.options.isActive(),false);
  const stopped=history.ticks;
  await env.evaluate('loadSystemTelemetry()');
  assert.equal(history.ticks,stopped); assert.ok(history.closes>0);
  env.node('settings-system-panel').hidden=false;
  await env.windowEvent('nvr-settings-tabchange',{detail:{tab:'system'}});
  env.document.hidden=true; await env.documentEvent('visibilitychange');
  assert.equal(history.options.isActive(),false); assert.equal(history.clears,0);
  env.document.hidden=false; await env.documentEvent('visibilitychange'); await flush();
  assert.equal(history.options.isActive(),true);
  await env.node('logout').fire('click');
  assert.equal(history.clears,1); assert.equal(history.options.isActive(),false);
});

test("System polling is shared across every visible authenticated page and remains single-flight while video is paused", async()=>{
  const pending=deferred(); let first=true;
  const env=environment({telemetry:true,handler(path,options,fallback){
    if(path==='/api/system/telemetry'){if(first){first=false;return pending.promise;} return telemetrySample(42);}
    return fallback(path);
  }});
  await env.boot();
  assert.equal(telemetryCalls(env).length,1);
  await env.evaluate('loadSystemTelemetry()');
  assert.equal(telemetryCalls(env).length,1);
  const oldTimer=env.evaluate('systemTelemetry.timer');
  env.document.hidden=true; await env.documentEvent('visibilitychange');
  assert.equal(telemetryCalls(env)[0].options.signal.aborted,true);
  assert.equal(env.timers.has(oldTimer),false);
  pending.resolve(telemetrySample(99)); await flush(); await flush();
  assert.equal(env.telemetryViews[0].data,null);
  env.document.hidden=false; await env.documentEvent('visibilitychange'); await flush(); await flush();
  assert.equal(env.telemetryViews[0].data.cpu.percent,42);
  await env.node('monitor-toggle').fire('click');
  assert.equal(env.evaluate('monitor.playing'),false);
  await env.runTimer(env.evaluate('systemTelemetry.timer'));
  assert.equal(telemetryCalls(env).length,3);
  const timer=env.evaluate('systemTelemetry.timer');
  for (const button of ['live-tab-layout','nav-recorder','nav-cameras','nav-network','nav-settings']) {
    await env.node(button).fire('click');
    assert.equal(env.evaluate('systemTelemetry.timer'),timer);
    const count=telemetryCalls(env).length;
    await env.runTimer(timer);
    assert.equal(telemetryCalls(env).length,count+1);
    assert.equal(env.telemetryViews[0].data.cpu.percent,42);
  }
  assert.equal(env.players.every((player)=>player.destroyed),true);
  assert.equal(env.dashboardViews.length,1);
  assert.equal(env.dashboardViews[0].data.cpu.percent,42);
});

test("a timed-out telemetry response clears stale values and cannot replace a newer sample",async()=>{
  const old=deferred(); let count=0;
  const env=environment({telemetry:true,handler(path,options,fallback){
    if(path==='/api/system/telemetry')return ++count===1?old.promise:telemetrySample(17);
    return fallback(path);
  }});
  await env.boot();
  const request=telemetryCalls(env)[0];
  await env.runTimer(env.evaluate('systemTelemetry.timeout'));
  assert.equal(request.options.signal.aborted,true);
  assert.equal(env.telemetryViews[0].data,null);
  await env.evaluate('loadSystemTelemetry()');
  assert.equal(env.telemetryViews[0].data.cpu.percent,17);
  old.resolve(telemetrySample(99)); await flush(); await flush();
  assert.equal(env.telemetryViews[0].data.cpu.percent,17);
  assert.equal(env.players.every((player)=>player.active),true);
});

test("telemetry errors and logout clear metrics; translation only relabels the current snapshot",async()=>{
  let failing=false;
  const env=environment({telemetry:true,handler(path,options,fallback){
    if(path==='/api/system/telemetry')return failing?{}:telemetrySample(31);
    return fallback(path);
  }});
  await env.boot();
  assert.equal(env.telemetryViews[0].data.cpu.percent,31);
  const requests=telemetryCalls(env).length;
  env.language('it'); await env.windowEvent('nvr-languagechange');
  assert.equal(telemetryCalls(env).length,requests);
  assert.equal(env.telemetryViews[0].relabels,1);
  failing=true; await env.evaluate('loadSystemTelemetry()');
  assert.equal(env.telemetryViews[0].data,null);
  assert.equal(env.players.every((player)=>player.active),true);
  await env.node('logout').fire('click');
  const count=telemetryCalls(env).length;
  await env.evaluate('loadSystemTelemetry()');
  assert.equal(telemetryCalls(env).length,count);
  assert.equal(env.evaluate('systemTelemetry.timer'),null);
});


test("system overview renders the shared snapshot only on its tab and cannot survive logout or stale failures", async()=>{
  let sample=telemetrySample(14);
  const env=environment({telemetry:true,handler(path,options,fallback){
    return path==='/api/system/telemetry'?sample:fallback(path);
  }});
  env.node('settings-system-panel').hidden=true;
  await env.boot();
  assert.equal(env.dashboardViews.length,0);
  await env.node('nav-settings').fire('click');
  assert.equal(env.dashboardViews.length,0);
  const count=telemetryCalls(env).length;
  env.node('settings-system-panel').hidden=false;
  await env.windowEvent('nvr-settings-tabchange',{detail:{tab:'system'}});
  assert.equal(env.dashboardViews.length,1);
  assert.equal(env.dashboardViews[0].data.cpu.percent,14);
  assert.equal(telemetryCalls(env).length,count);
  const renders=env.dashboardViews[0].renders;
  env.node('settings-system-panel').hidden=true;
  sample=telemetrySample(18); await env.evaluate('loadSystemTelemetry()');
  assert.equal(env.dashboardViews[0].renders,renders);
  assert.equal(env.telemetryViews[0].data.cpu.percent,18);
  env.node('settings-system-panel').hidden=false;
  await env.windowEvent('nvr-settings-tabchange',{detail:{tab:'system'}});
  assert.equal(env.dashboardViews[0].data.cpu.percent,18);
  env.language('it'); await env.windowEvent('nvr-languagechange');
  assert.equal(env.dashboardViews[0].relabels,1);
  sample={}; await env.evaluate('loadSystemTelemetry()');
  assert.equal(env.dashboardViews[0].data,null);
  await env.node('logout').fire('click');
  assert.equal(env.dashboardViews[0].data,null);
  assert.equal(env.evaluate('systemTelemetry.timer'),null);
  await env.windowEvent('pageshow',{persisted:true});
  assert.equal(env.evaluate('systemTelemetry.timer'),null);
});

test("actual rotation switches Live pages at15seconds despite polling and disabling restores the saved layout", async () => {
  const env = environment({cameras: [camera("a"), {...camera("b"), enabled: false}], saved: snapshot(1, ["b"]),
    general: generalSettings({rotation_seconds: 15})});
  await env.boot();
  const saved = env.layouts[0].getSaved();
  const visibleIds = () => env.node("monitor-grid").children.map((tile) => tile.dataset.cameraId).filter(Boolean);
  assert.deepEqual(visibleIds(), ["a"]);
  await env.advanceTimers(10000); assert.deepEqual(visibleIds(), ["a"]);
  assert.ok(env.calls.filter((call) => call.path === "/api/settings/general").length >= 2);
  await env.advanceTimers(5000); assert.deepEqual(visibleIds(), ["b"]);
  assert.equal(env.node("monitor-page-label").textContent, "Page 2 / 2");
  await env.advanceTimers(15000); assert.deepEqual(visibleIds(), ["a"]);
  await env.windowEvent("nvr-general-settingschange", {detail: generalSettings()});
  assert.deepEqual(visibleIds(), ["b"]);
  assert.deepEqual(env.layouts[0].getSaved(), saved);
  assert.equal(env.evaluate("cameraRotation.state().active"), false);
});

test("actual rotation pauses for monitor pause, hidden tab and tile fullscreen but continues whole-wall fullscreen", async () => {
  const env = environment({cameras: [camera("a"), camera("b")], saved: snapshot(1, ["a"]), general: generalSettings({rotation_seconds: 15})});
  await env.boot();
  const page = () => env.evaluate("cameraRotation.state().page");
  await env.node("monitor-toggle").fire("click");
  await env.advanceTimers(30000); assert.equal(page(), 0);
  await env.node("monitor-toggle").fire("click");
  await env.advanceTimers(15000); assert.equal(page(), 1);
  env.document.hidden = true; await env.documentEvent("visibilitychange");
  await env.advanceTimers(30000); assert.equal(page(), 1);
  env.document.hidden = false; await env.documentEvent("visibilitychange");
  const tile = env.node("monitor-grid").children[0];
  env.document.fullscreenElement = tile; await env.documentEvent("fullscreenchange");
  assert.equal(env.evaluate("monitor.fullscreenId"), "b");
  await env.advanceTimers(30000); assert.equal(page(), 1);
  env.document.fullscreenElement = env.node("monitor-grid"); await env.documentEvent("fullscreenchange");
  assert.equal(env.evaluate("monitor.fullscreenId"), null);
  await env.advanceTimers(15000); assert.equal(page(), 0);
  await env.node("nav-cameras").fire("click");
  await env.advanceTimers(30000); assert.equal(page(), 0);
  assert.equal(env.evaluate("cameraRotation.state().active"), false);
  await env.node("logout").fire("click");
  assert.equal(env.evaluate("cameraRotation.state().seconds"), 0);
});
