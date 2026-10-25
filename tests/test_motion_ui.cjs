"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {MotionTrack, normalizeEvents, offsetLabel} = require("../nvr/static/motion-track.js");

// Small DOM doubles; no browser, video decoder, network or recording files.
class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
    this.hidden = false; this.disabled = false; this.value = ""; this.attributes = new Map(); this.listeners = new Map();
    const classes = new Set();
    this.classList = {toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: (name) => classes.has(name)};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion is forbidden"); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.text = ""; this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== listener)); }
  async fire(name, event = {}) { for (const listener of this.listeners.get(name) || []) await listener({target: this, preventDefault() {}, stopPropagation() {}, ...event}); }
  getBoundingClientRect() { return {left: 10, width: 200}; }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const flush = () => new Promise((resolve) => setImmediate(resolve));
function result(events = [], sensitivity = "medium", duration = 60) { return {duration, sensitivity, events, sample_seconds: .5, method: "frame-difference"}; }
function environment(handler = async () => result()) {
  const elements = Object.fromEntries(["track", "markers", "cursor", "status", "error", "sensitivity", "previous", "next", "retry", "position"].map((key) => [key, new Element()]));
  const calls = [], seeks = []; let language = "en";
  const t = (key, params = {}) => (language === "en" ? key : "IT: " + key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
  const controller = new MotionTrack({elements, document: {createElement: (tag) => new Element(tag)}, t,
    request(id, sensitivity, signal) { calls.push({id, sensitivity, signal}); return handler(id, sensitivity, signal); }, seek: (time) => seeks.push(time)});
  return {controller, elements, calls, seeks, handler(value) { handler = value; }, language(value) { language = value; }};
}

test("selecting a completed recording auto-analyses once with medium sensitivity and renders actual event ranges", async () => {
  const env = environment(async () => result([{start: 30, end: 35, score: .2}, {start: 10, end: 12, score: .8}]));
  assert.equal(env.elements.sensitivity.value, "medium"); assert.equal(env.elements.sensitivity.disabled, true); assert.equal(env.calls.length, 0);
  await env.controller.select({id: "recording-one", duration: 60});
  assert.equal(env.calls.length, 1); assert.equal(env.calls[0].id, "recording-one"); assert.equal(env.calls[0].sensitivity, "medium");
  assert.equal(env.controller.phase, "ready"); assert.equal(env.elements.markers.children.length, 2);
  assert.equal(env.elements.status.textContent, "2 image-change events");
  const first = env.elements.markers.children[0];
  assert.equal(first.tagName, "button"); assert.equal(first.type, "button"); assert.equal(first.title, "Image change from 0:10 to 0:12");
  assert.equal(parseFloat(first.style.left), 10 / 60 * 100); assert.equal(parseFloat(first.style.width), 2 / 60 * 100);
  await env.controller.select({id: "recording-one", duration: 60}); assert.equal(env.calls.length, 1, "Codec/player reloads must reuse the same analysis");
});

test("markers, previous/next, keyboard and track clicks seek the video while the playhead follows playback", async () => {
  const env = environment(async () => result([{start: 2, end: 4, score: .1}, {start: 10, end: 12, score: .3}, {start: 30, end: 31, score: .2}]));
  await env.controller.select({id: "one", duration: 60});
  assert.equal(env.elements.previous.disabled, true); assert.equal(env.elements.next.disabled, false);
  await env.elements.markers.children[1].fire("click"); assert.equal(env.seeks.at(-1), 10);
  assert.equal(env.elements.markers.children[1].getAttribute("aria-current"), "time"); assert.equal(env.elements.position.textContent, "2 / 3");
  env.controller.setTime(11); await env.elements.previous.fire("click"); assert.equal(env.seeks.at(-1), 10);
  await env.elements.previous.fire("click"); assert.equal(env.seeks.at(-1), 2);
  await env.elements.next.fire("click"); assert.equal(env.seeks.at(-1), 10);
  await env.elements.track.fire("keydown", {key: "End"}); assert.equal(env.seeks.at(-1), 30);
  await env.elements.track.fire("keydown", {key: "Home"}); assert.equal(env.seeks.at(-1), 2);
  await env.elements.track.fire("keydown", {key: "ArrowRight"}); assert.equal(env.seeks.at(-1), 10);
  await env.elements.track.fire("click", {clientX: 110}); assert.equal(env.seeks.at(-1), 30);
  env.controller.setTime(50); assert.equal(parseFloat(env.elements.cursor.style.left), 50 / 60 * 100);
  assert.equal(env.elements.position.textContent, "— / 3"); assert.equal(env.elements.next.disabled, true);
  assert.equal(env.elements.markers.children.some((marker) => marker.classList.contains("active")), false);
});

test("changing recordings or clearing on logout aborts pending work and ignores late results", async () => {
  const replies = [deferred(), deferred(), deferred()]; let index = 0;
  const env = environment(() => replies[index++].promise);
  const first = env.controller.select({id: "old", duration: 60});
  const second = env.controller.select({id: "new", duration: 60});
  assert.equal(env.calls[0].signal.aborted, true);
  replies[0].resolve(result([{start: 1, end: 59, score: 1}])); await first;
  assert.equal(env.controller.phase, "loading"); assert.equal(env.controller.recording.id, "new");
  replies[1].resolve(result([{start: 8, end: 9, score: .2}])); await second;
  assert.equal(env.controller.events[0].start, 8);
  const pending = env.controller.select({id: "after", duration: 60}); env.controller.clear();
  assert.equal(env.calls[2].signal.aborted, true);
  replies[2].resolve(result([{start: 0, end: 30, score: 1}])); await pending;
  assert.equal(env.controller.phase, "idle"); assert.equal(env.controller.recording, null); assert.equal(env.elements.markers.children.length, 0);
  assert.equal(env.elements.cursor.hidden, true); assert.equal(env.elements.sensitivity.disabled, true);
});

test("latest sensitivity wins, aborts the older request, and zero events is an explicit state", async () => {
  const high = deferred(), low = deferred();
  const env = environment((id, sensitivity) => sensitivity === "high" ? high.promise : sensitivity === "low" ? low.promise : Promise.resolve(result()));
  await env.controller.select({id: "one", duration: 60});
  env.elements.sensitivity.value = "high"; await env.elements.sensitivity.fire("change");
  env.elements.sensitivity.value = "low"; await env.elements.sensitivity.fire("change");
  assert.equal(env.calls[1].signal.aborted, true); assert.equal(env.calls[2].sensitivity, "low");
  high.resolve(result([{start: 0, end: 59, score: 1}], "high")); await flush(); assert.equal(env.controller.phase, "loading");
  low.resolve(result([], "low")); await flush();
  assert.equal(env.controller.phase, "ready"); assert.equal(env.elements.status.textContent, "No image-change events at this sensitivity.");
  assert.equal(env.elements.previous.disabled, true); assert.equal(env.elements.next.disabled, true);
  env.elements.sensitivity.value = "unsupported"; await env.elements.sensitivity.fire("change"); await flush(); assert.equal(env.calls.at(-1).sensitivity, "medium");
});

test("language changes relabel loaded and in-flight state without another analysis or changing playback time", async () => {
  const env = environment(async () => result([{start: 10, end: 12, score: .2}]));
  await env.controller.select({id: "one", duration: 60}); env.controller.setTime(11);
  const events = env.controller.events, calls = env.calls.length;
  env.language("it"); env.controller.relabel();
  assert.equal(env.controller.events, events); assert.equal(env.controller.time, 11); assert.equal(env.calls.length, calls);
  assert.equal(env.elements.status.textContent, "IT: 1 image-change event"); assert.match(env.elements.markers.children[0].title, /^IT:/);
  assert.equal(env.seeks.length, 0, "Relabeling cannot seek the player");
  const reply = deferred(); env.handler(() => reply.promise); const pending = env.controller.select({id: "two", duration: 60});
  env.language("en"); env.controller.relabel(); assert.equal(env.elements.status.textContent, "Analysing image changes…");
  assert.equal(env.calls.at(-1).signal.aborted, false);
  reply.resolve(result()); await pending; assert.equal(env.elements.status.textContent, "No image-change events at this sensitivity.");
});

test("analysis errors are safe text, offer retry and do not overwrite a later clear", async () => {
  const text = '<img src=x onerror="throw Error(1)">';
  const env = environment(async () => { throw Error(text); });
  await env.controller.select({id: "one", duration: 60});
  assert.equal(env.controller.phase, "error"); assert.equal(env.elements.retry.hidden, false); assert.equal(env.elements.error.textContent, text); assert.equal(env.elements.error.children.length, 0);
  env.handler(async () => result([{start: 3, end: 4, score: .1}]));
  await env.elements.retry.fire("click"); await flush(); assert.equal(env.controller.phase, "ready"); assert.equal(env.elements.retry.hidden, true);
  const reply = deferred(); env.handler(() => reply.promise); const pending = env.controller.select({id: "two", duration: 60});
  env.controller.clear(); reply.reject(Error("Motion analysis failed.")); await pending;
  assert.equal(env.elements.error.hidden, true); assert.equal(env.elements.status.textContent, "Select a recording");
});

test("malformed analysis is rejected and event ranges/scores are bounded without inventing events", async () => {
  const env = environment(async () => ({duration: 60, events: "invalid"}));
  await env.controller.select({id: "one", duration: 60}); assert.equal(env.controller.phase, "error");
  const normalized = normalizeEvents([{start: -5, end: 3, score: 2}, {start: 58, end: 80, score: -.5}, {start: 10, end: 10, score: 1}, {start: NaN, end: 5}, {start: "<script>", end: 8}], 60);
  assert.deepEqual(normalized, [{start: 0, end: 3, score: 1}, {start: 58, end: 60, score: 0}]);
  assert.equal(offsetLabel(3605), "1:00:05");
  assert.equal(offsetLabel(9.8), "0:09");
});

test("destroy releases the pending request and removes all controller listeners", async () => {
  const reply = deferred(), env = environment(() => reply.promise);
  const pending = env.controller.select({id: "one", duration: 60}); env.controller.destroy();
  assert.equal(env.calls[0].signal.aborted, true);
  assert.equal([...env.elements.track.listeners.values()].flat().length, 0);
  assert.equal([...env.elements.sensitivity.listeners.values()].flat().length, 0);
  reply.resolve(result()); await pending; assert.equal(env.controller.phase, "idle");
});

test("the motion track follows audio in the player and the app wires selection, logout, language and playback without replacing audio", () => {
  const html = readFileSync(join(__dirname, "../nvr/static/index.html"), "utf8");
  const app = readFileSync(join(__dirname, "../nvr/static/app.js"), "utf8");
  const motionScript = html.indexOf('/static/motion-track.js?v=0.9.0');
  assert.ok(motionScript > 0 && motionScript < html.indexOf('/static/app.js?v=0.9.0'));
  assert.equal((html.match(/\?v=0\.9\.0/g) || []).length, 8);
  assert.match(html, /class="waveform-box"[\s\S]*?<section class="motion-box"[\s\S]*?<div class="recordings-column">/);
  for (const id of ["waveform", "waveform-cursor", "motion-track", "motion-markers", "motion-cursor", "motion-status", "motion-error", "motion-sensitivity", "motion-previous", "motion-next", "motion-retry", "motion-event-position"]) assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1);
  assert.match(app, /motionTrack\?\.clear\(\)/);
  assert.match(app, /motionTrack[.]select\(recording\)/);
  assert.match(app, /motionTrack\?\.relabel\(\)/);
  assert.match(app, /player[.]addEventListener\("timeupdate", updateWaveformCursor\)/);
  assert.match(app, /player[.]addEventListener\("timeupdate", \(\) => motionTrack\?\.setTime\(player[.]currentTime\)\)/);
  assert.match(app, /\/motion\?\$\{new URLSearchParams\(\{sensitivity\}\)\}/);
});
