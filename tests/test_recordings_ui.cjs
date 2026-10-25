"use strict";
// Exercise the actual archive controller, record player and motion track together.
// No browser, camera, WebSocket connection or server password is involved.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../nvr/static/app.js"), "utf8");
const recordPlayerSource = readFileSync(join(__dirname, "../nvr/static/record-player.js"), "utf8");
const motionSource = readFileSync(join(__dirname, "../nvr/static/motion-track.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.parentElement = null; this.hidden = false; this.disabled = false;
    this.value = ""; this.checked = false; this.muted = true; this.paused = true; this.currentTime = 0;
    this.duration = NaN; this.readyState = 0; this.volume = 1; this.playbackRate = 1; this.controls = true;
    this.clientWidth = 640; this.clientHeight = 100;
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
  async fire(type, details = {}) { const event = {type, target: this, preventDefault() {}, stopPropagation() {}, ...details}; for (const listener of this.listeners.get(type) || []) await listener(event); if (this["on" + type]) await this["on" + type](event); }
  querySelector(selector) { if (!this.selectors) this.selectors = new Map(); if (!this.selectors.has(selector)) this.selectors.set(selector, new Element(selector.startsWith("button") ? "button" : "div")); return this.selectors.get(selector); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return descendants;
    return descendants.filter((item) => selector.startsWith(".")
      ? String(item.className || "").split(/\s+/).includes(selector.slice(1)) || item.classList.contains(selector.slice(1))
      : item.tagName === selector.toUpperCase());
  }
  get options() { return this.children; }
  set src(value) { this.setAttribute("src", value); }
  get src() { return this.getAttribute("src") || ""; }
  set href(value) { this.setAttribute("href", value); }
  get href() { return this.getAttribute("href") || ""; }
  closest() { return this.ownerDocument.getElementById("test-player-frame"); }
  contains(other) { return this === other || this.children.some((child) => child.contains?.(other)); }
  get firstChild() { return this.children[0] || null; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 640, height: 100}; }
  getContext() {
    if (!this.paint) {
      const operations = [];
      this.paint = new Proxy({operations, measureText: () => ({width: 40}), fillRect(x, y, width, height) { operations.push({x, y, width, height, color: this.fillStyle}); }}, {get: (target, name) => name in target ? target[name] : () => {}});
    }
    return this.paint;
  }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { this.readyState = 0; this.duration = NaN; this.currentTime = 0; }
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

function environment({cameras = [camera("a"), camera("b")], recordings = [], saved = snapshot(), legacySize = null, handler} = {}) {
  const nodes = new Map(), windowEvents = new Map(), documentEvents = new Map(), calls = [], players = [], layouts = [], timers = new Map();
  const storage = new Map(legacySize === null ? [] : [["nvr.monitor.layout", String(legacySize)]]);
  const ready = deferred(); let timer = 0, language = "en", settingsOpens = 0;
  const node = (id) => { if (!nodes.has(id)) { const item = new Element(id === "player" ? "video" : "div"); item.id = id; item.ownerDocument = document; nodes.set(id, item); } return nodes.get(id); };
  const layoutButtons = [1, 4, 9, 16].map((size) => { const button = new Element("button"); button.dataset.monitorLayout = String(size); return button; });
  const document = {hidden: false, fullscreenElement: null, body: new Element("body"), documentElement: new Element("html"), getElementById: node,
    createElement: (tag) => Object.assign(new Element(tag), {ownerDocument: document}), createElementNS: (_, tag) => Object.assign(new Element(tag), {ownerDocument: document}), createTextNode: (text) => Object.assign(new Element("text"), {textContent: text, ownerDocument: document}),
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
    : path === "/api/logout" ? {authenticated: false}
    : path.startsWith("/api/recordings?") ? recordings
    : path.endsWith("/waveform") ? {duration: recordings.find((item) => item.id === path.split("/")[3])?.duration || 90, sample_seconds: .5, peaks: [.1, .9, .2]}
    : path.includes("/motion?") ? {duration: recordings.find((item) => item.id === path.split("/")[3])?.duration || 90, sensitivity: new URLSearchParams(path.split("?")[1]).get("sensitivity"), sample_seconds: .5, events: [], method: "frame-difference"}
    : path === "/api/onvif/interfaces" ? [] : {};
  const context = vm.createContext({console, document, Intl, Headers, URL, URLSearchParams, AbortController,
    getComputedStyle: () => ({getPropertyValue: (name) => ({"--accent": "test-cyan", "--accent-strong": "test-bright-cyan", "--timeline-recording": "test-cyan", "--motion": "test-gold", "--panel-deep": "test-background", "--line": "test-grid"})[name] || "test-token"}),
    setTimeout(callback) { const id = ++timer; timers.set(id, callback); return id; }, clearTimeout: (id) => timers.delete(id),
    setInterval(callback) { const id = ++timer; timers.set(id, callback); return id; }, clearInterval: (id) => timers.delete(id),
    localStorage: {getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value))},
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    async fetch(path, options = {}) { calls.push({path, options}); const value = await (handler ? handler(path, options, defaults) : defaults(path)); return value instanceof Response ? value : new Response(JSON.stringify(value), {status: 200}); },
  });
  context.window = context; context.devicePixelRatio = 1; context.scrollTo = () => {};
  context.NvrLivePlayer = LivePlayer; context.NvrLiveLayout = LiveLayout;
  context.NvrSettings = {open() { settingsOpens += 1; }};
  context.NvrI18n = {ready: ready.promise, locale: () => language, getLanguage: () => language,
    t: (key, params = {}) => (language === "en" ? String(key) : "IT: " + key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.hasOwn(params, name) ? String(params[name]) : token)};
  context.addEventListener = (type, listener) => { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(listener); };
  context.dispatchEvent = (event) => { for (const listener of windowEvents.get(event.type) || []) listener(event); return true; };
  vm.runInContext(recordPlayerSource, context, {filename: "record-player.js"});
  vm.runInContext(motionSource, context, {filename: "motion-track.js"});
  vm.runInContext(source, context, {filename: "app.js"});
  return {node, calls, players, layouts, layoutButtons, context, ready, document, storage,
    async boot() { ready.resolve(); await flush(); await flush(); },
    evaluate: (expression) => vm.runInContext(expression, context),
    async documentEvent(type, details = {}) { for (const listener of documentEvents.get(type) || []) await listener({type, ...details}); },
    async windowEvent(type, details = {}) { for (const listener of windowEvents.get(type) || []) await listener({type, ...details}); },
    language(value) { language = value; }, settingsOpens: () => settingsOpens,
  };
}

const day = "2026-10-25";
const startAt = (hour = 12, minute = 0) => new Date(2026, 9, 25, hour, minute).getTime() / 1000;
const recording = (id, startedAt = startAt(), duration = 90, audio = "aac") => ({id, camera_id: "a", started_at: startedAt, duration, size: 4096, video_codec: "h264", audio_codec: audio});
async function settle() { await flush(); await flush(); }
async function search(env, {date = day, from = "00:00", to = "00:00"} = {}) {
  await env.node("nav-recorder").fire("click");
  env.node("archive-date").value = date; env.node("archive-from").value = from; env.node("archive-to").value = to;
  await env.node("search-form").fire("submit"); await settle();
}
async function metadata(env, duration) {
  env.node("player").duration = duration; env.node("player").readyState = 1;
  await env.node("player").fire("loadedmetadata"); await env.node("player").fire("seeked"); await settle();
}

test("Record filters submit the selected local date and advance an overnight end by one calendar day", async () => {
  const env = environment(); await env.boot();
  await search(env, {from: "22:00", to: "02:00"});
  const query = new URL(env.calls.filter((call) => call.path.startsWith("/api/recordings?")).at(-1).path, "http://local").searchParams;
  assert.equal(query.get("camera_id"), "a");
  assert.equal(Number(query.get("start")), new Date(2026, 9, 25, 22).getTime() / 1000);
  assert.equal(Number(query.get("end")), new Date(2026, 9, 26, 2).getTime() / 1000);
  await search(env);
  const fullDay = new URL(env.calls.filter((call) => call.path.startsWith("/api/recordings?")).at(-1).path, "http://local").searchParams;
  assert.equal(Number(fullDay.get("start")), new Date(2026, 9, 25).getTime() / 1000);
  assert.equal(Number(fullDay.get("end")), new Date(2026, 9, 26).getTime() / 1000);
});

test("an invalid newer filter aborts the previous query and ignores a late successful result", async () => {
  const late = deferred(); let waiting = false;
  const env = environment({handler: (path, options, fallback) => waiting && path.startsWith("/api/recordings?") ? late.promise : fallback(path)});
  await env.boot(); waiting = true;
  await search(env, {from: "12:00", to: "13:00"});
  const pending = env.calls.filter((call) => call.path.startsWith("/api/recordings?")).at(-1);
  assert.equal(pending.options.signal.aborted, false);
  env.node("archive-date").value = "";
  await env.node("search-form").fire("submit");
  assert.equal(pending.options.signal.aborted, true);
  late.resolve([recording("stale")]); await settle();
  assert.equal(env.node("archive-error").hidden, false);
  assert.equal(env.evaluate("state.recordings.length"), 0);
  assert.equal(env.evaluate("state.recording"), null);
});

test("applying a changed camera aborts its previous search and late files cannot replace the new camera", async () => {
  const old = deferred(); let waiting = false;
  const first = recording("camera-a"), second = {...recording("camera-b"), camera_id: "b"};
  const env = environment({handler(path, options, fallback) {
    if (!path.startsWith("/api/recordings?")) return fallback(path);
    const id = new URL(path, "http://local").searchParams.get("camera_id");
    return id === "b" ? [second] : waiting ? old.promise : [first];
  }});
  await env.boot(); waiting = true; await search(env, {from: "12:00", to: "13:00"});
  const previous = env.calls.filter((call) => call.path.startsWith("/api/recordings?")).at(-1);
  env.node("archive-camera").value = "b"; await env.node("archive-camera").fire("input");
  await env.node("search-form").fire("submit"); await settle();
  assert.equal(previous.options.signal.aborted, true);
  old.resolve([first]); await settle();
  assert.equal(env.evaluate("state.selectedId"), "b");
  assert.equal(env.evaluate("state.recordings[0].id"), "camera-b");
  await env.node("recordings-list").children[0].fire("click"); await metadata(env, 90);
  assert.equal(env.node("playing-label").textContent, "Camera b");
});

test("actual short-file duration drives video controls, file axis, audio and motion position together", async () => {
  const env = environment({recordings: [recording("short", startAt(), 90)]}); await env.boot(); await search(env);
  await env.node("recordings-list").children[0].fire("click");
  assert.equal(env.node("record-loading").hidden, false);
  await metadata(env, 90);
  assert.equal(env.node("record-loading").hidden, true);
  assert.equal(env.node("record-player-controls").hidden, false);
  assert.equal(env.node("record-total").textContent, "1:30");
  assert.equal(env.node("record-seek").max, "90");
  assert.equal(env.node("record-time-axis").children.at(-1).dataset.offset, "90");
  assert.match(env.node("download").href, /\/short\/download$/);
  await env.node("waveform").fire("click", {clientX: 320});
  await env.node("player").fire("seeked");
  assert.equal(env.node("player").currentTime, 45);
  assert.equal(Number(env.node("record-seek").value), 45);
  assert.equal(env.node("waveform-cursor").style.left, "50%");
  assert.equal(env.node("recording-tracks-cursor").style.left, "50%");
  assert.equal(env.evaluate("motionTrack.time"), 45);
  assert.equal(env.node("motion-status").textContent, "No image-change events at this sensitivity.");
});

test("range canvas preserves real gaps and uses theme tokens; gap clicks never invent a selected file", async () => {
  const first = recording("first", startAt(), 60), second = recording("second", startAt(12, 2), 120);
  const env = environment({recordings: [first, second]}); await env.boot();
  env.node("timeline").getContext().operations.length = 0;
  await search(env, {from: "12:00", to: "12:04"});
  const bars = env.node("timeline").paint.operations.filter((item) => item.color === "test-cyan" || item.color === "test-bright-cyan").slice(-2);
  assert.deepEqual(bars.map(({x, width}) => ({x, width})), [{x: 0, width: 160}, {x: 320, width: 320}]);
  await env.node("timeline").fire("click", {clientX: 240});
  assert.equal(env.evaluate("state.recording"), null);
  assert.match(env.node("timeline-message").textContent, /No segment available/);
  await env.node("timeline").fire("click", {clientX: 80}); await metadata(env, 60);
  assert.equal(env.evaluate("state.recording.id"), "first");
  assert.equal(env.node("player").currentTime, 30);
  await env.node("player").fire("ended");
  assert.equal(env.evaluate("state.recording.id"), "first");
  assert.match(env.node("toast").textContent, /gap before the next recording/);
  await env.node("record-next").fire("click"); await metadata(env, 120);
  assert.equal(env.evaluate("state.recording.id"), "second");
});

test("timeline zoom changes the visible real interval without a new query and seeks within that interval", async () => {
  const env = environment({recordings: [recording("long", startAt(), 240)]}); await env.boot();
  await search(env, {from: "12:00", to: "12:04"});
  const queries = env.calls.filter((call) => call.path.startsWith("/api/recordings?")).length;
  await env.node("timeline-zoom-in").fire("click");
  assert.equal(env.evaluate("state.range.end - state.range.start"), 240);
  assert.equal(env.evaluate("state.timelineWindow.end - state.timelineWindow.start"), 120);
  assert.equal(env.node("timeline-ruler").children.length, 7);
  await env.node("timeline").fire("click", {clientX: 0}); await metadata(env, 240);
  assert.equal(env.node("player").currentTime, 60);
  assert.equal(env.node("record-elapsed").textContent, "1:00");
  await env.node("timeline-zoom-out").fire("click");
  assert.equal(env.evaluate("state.timelineWindow"), null);
  assert.equal(env.calls.filter((call) => call.path.startsWith("/api/recordings?")).length, queries);
});

test("a no-audio selection remains explicit when older waveform and motion requests finish later", async () => {
  const oldWave = deferred(), oldMotion = deferred();
  const rows = [recording("audio", startAt(), 90), recording("silent", startAt(12, 2), 45, null)];
  const env = environment({recordings: rows, handler: (path, options, fallback) => path.endsWith("/audio/waveform") ? oldWave.promise : path.includes("/audio/motion?") ? oldMotion.promise : fallback(path)});
  await env.boot(); await search(env);
  await env.node("recordings-list").children[0].fire("click");
  const waveCall = env.calls.find((call) => call.path.endsWith("/audio/waveform"));
  await env.node("recordings-list").children[1].fire("click"); await metadata(env, 45);
  assert.equal(waveCall.options.signal.aborted, true);
  oldWave.resolve({duration: 90, peaks: [1, 1, 1]});
  oldMotion.resolve({duration: 90, sensitivity: "medium", sample_seconds: .5, events: [{start: 1, end: 80, score: 1}], method: "frame-difference"});
  await settle();
  assert.equal(env.node("waveform-label").textContent, "No audio track");
  assert.equal(env.evaluate("state.waveform"), null);
  assert.equal(env.node("record-total").textContent, "0:45");
  assert.equal(env.node("motion-markers").children.length, 0);
  assert.equal(env.node("motion-status").textContent, "No image-change events at this sensitivity.");
});

test("compatible playback reload preserves the current time, speed and playback intention", async () => {
  const env = environment({recordings: [recording("one")]}); await env.boot(); await search(env);
  await env.node("recordings-list").children[0].fire("click"); await metadata(env, 90);
  env.node("record-speed").value = "2"; await env.node("record-speed").fire("change");
  env.node("player").currentTime = 27; env.node("player").paused = false;
  env.node("compatible").checked = true; await env.node("compatible").fire("change"); await metadata(env, 90);
  assert.match(env.node("player").src, /\/one\/playback\?compatible=true$/);
  assert.equal(env.node("player").currentTime, 27);
  assert.equal(env.node("player").playbackRate, 2);
  assert.equal(env.node("player").paused, false);
});

test("logout clears video, download, motion and axes while ignoring late archive work", async () => {
  const lateWave = deferred();
  const env = environment({recordings: [recording("one")], handler: (path, options, fallback) => path.endsWith("/waveform") ? lateWave.promise : fallback(path)});
  await env.boot(); await search(env); await env.node("recordings-list").children[0].fire("click"); await metadata(env, 90);
  await env.node("logout").fire("click");
  lateWave.resolve({duration: 90, peaks: [1, 1, 1]}); await settle();
  assert.equal(env.node("player").src, "");
  assert.equal(env.node("download").hidden, true);
  assert.equal(env.node("download").href, "");
  assert.equal(env.node("record-time-axis").children.length, 0);
  assert.equal(env.node("motion-markers").children.length, 0);
  assert.equal(env.node("record-play").disabled, true);
  assert.equal(env.node("record-loading").hidden, true);
  assert.equal(env.node("app").hidden, true);
});
