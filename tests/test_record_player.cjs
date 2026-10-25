"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {NvrRecordPlayer, elapsedLabel, axisOffsets} = require("../nvr/static/record-player.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

class Element {
  constructor(tag = "div", document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.style = {};
    this.attributes = new Map(); this.listeners = new Map(); this.value = ""; this.hidden = false; this.disabled = false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion forbidden"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this.text = ""; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return this.children.find((child) => child.selector === selector) || null; }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== callback)); }
  async fire(name, extra = {}) { for (const callback of this.listeners.get(name) || []) await callback({target: this, key: "", preventDefault() {}, ...extra}); }
}
function environment() {
  const document = new Element("document"); document.documentElement = {lang: "en-GB"}; document.createElement = (tag) => new Element(tag, document);
  const video = new Element("video", document);
  Object.assign(video, {controls: true, paused: true, ended: false, currentTime: 0, duration: NaN, readyState: 0,
    playbackRate: 1, volume: .8, muted: false, pauseCount: 0, playCount: 0});
  video.pause = () => { video.pauseCount++; video.paused = true; video.fire("pause"); };
  video.play = () => { video.playCount++; video.paused = false; video.fire("play"); return Promise.resolve(); };
  const names = ["controls", "previous", "play", "next", "elapsed", "total", "seek", "speed", "mute", "volume", "fullscreen", "absoluteTime", "axis", "fullscreenTarget"];
  const elements = Object.fromEntries(names.map((name) => [name, new Element("div", document)]));
  for (const [key, selector] of [["play", "[data-record-play-label]"], ["mute", "[data-record-mute-label]"], ["fullscreen", "[data-record-fullscreen-label]"]]) {
    const icon = new Element("svg", document), label = new Element("span", document); label.selector = selector;
    elements[key].append(icon, label);
  }
  let language = "en", previous = 0, next = 0;
  const errors = [], times = [];
  const player = new NvrRecordPlayer({video, elements, t: (key, params = {}) => (language === "en" ? key : "IT: " + key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token),
    onPrevious: () => previous++, onNext: () => next++, onError: (error) => errors.push(error), onTime: (time, info) => times.push({time, info})});
  const recording = {id: "file-one", started_at: Date.UTC(2026, 9, 25, 19) / 1000, duration: 1800};
  return {player, video, document, elements, recording, errors, times, counts: () => ({previous, next}),
    language(value) { language = value; document.documentElement.lang = value === "en" ? "en-GB" : "it-IT"; }};
}

test("duration labels and the shared axis use actual long-file times", () => {
  assert.equal(elapsedLabel(3661), "1:01:01"); assert.equal(elapsedLabel(65), "1:05");
  const offsets = axisOffsets(7200.28);
  assert.equal(offsets[0], 0); assert.equal(offsets.at(-1), 7200.28); assert.ok(offsets.length <= 8);
  assert.deepEqual(axisOffsets(NaN), []);
  const env = environment(); env.player.setRecording({...env.recording, duration: 7200.28});
  assert.equal(env.elements.total.textContent, "2:00:00");
  assert.equal(Number(env.elements.axis.children.at(-1).dataset.offset), 7200.28);
  assert.equal(env.elements.axis.children.at(-1).style.left, "100%");
  assert.equal(env.elements.seek.max, "7200.28");
  env.video.currentTime = 3661; env.player.update();
  assert.equal(env.elements.elapsed.textContent, "1:01:01");
  const expected = new Intl.DateTimeFormat("en-GB", {year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"}).format(new Date((env.recording.started_at + 3661) * 1000));
  assert.equal(env.elements.absoluteTime.textContent, expected);
  env.player.destroy();
});

test("custom play and pause preserve button SVG and notify only this player", async () => {
  const env = environment(), otherVideo = {muted: false, paused: true}, icon = env.elements.play.children[0];
  assert.equal(env.video.controls, false); assert.equal(env.video.muted, true); assert.equal(env.elements.controls.hidden, false);
  assert.equal(env.elements.play.disabled, true);
  env.player.setRecording(env.recording);
  await env.elements.play.fire("click");
  assert.equal(env.video.paused, false); assert.equal(env.elements.play.dataset.playing, "true");
  assert.equal(env.elements.play.getAttribute("aria-label"), "Pause"); assert.equal(env.elements.play.children[0], icon);
  await env.elements.play.fire("click");
  assert.equal(env.video.paused, true); assert.equal(env.elements.play.dataset.playing, "false");
  assert.deepEqual(otherVideo, {muted: false, paused: true});
  env.player.destroy(); assert.equal(env.video.controls, true); assert.equal(env.elements.controls.hidden, true);
});

test("play rejection is reported while late rejections and late starts after clear are ignored safely", async () => {
  const env = environment(); env.player.setRecording(env.recording);
  env.video.play = () => Promise.reject(Error("unsupported codec"));
  await env.player.togglePlayback();
  assert.match(env.errors[0].message, /Playback could not start/);
  const pending = deferred(); env.video.play = () => pending.promise;
  const request = env.player.togglePlayback(); env.player.clear();
  pending.resolve(); env.video.paused = false; await request;
  assert.equal(env.video.paused, true); assert.equal(env.errors.length, 1);
  env.player.setRecording(env.recording);
  const old = deferred(); env.video.play = () => old.promise;
  const second = env.player.togglePlayback(); env.player.setRecording({...env.recording, id: "new"});
  old.reject(Error("old request failed")); await second;
  assert.equal(env.errors.length, 1);
  env.player.destroy();
});

test("seek waits for metadata, clamps to media duration, and clears stale pending seeks", async () => {
  const env = environment(); env.player.setRecording(env.recording);
  env.elements.seek.value = "123.4"; await env.elements.seek.fire("input");
  assert.equal(env.video.currentTime, 0); assert.equal(env.player.pendingSeek, 123.4);
  env.video.readyState = 1; env.video.duration = 1700;
  await env.video.fire("loadedmetadata");
  assert.equal(env.video.currentTime, 123.4); assert.equal(env.player.pendingSeek, null);
  env.player.seek(99999); assert.equal(env.video.currentTime, 1700);
  env.player.seek(-4); assert.equal(env.video.currentTime, 0);
  assert.equal(env.times.at(-1).info.absoluteTime, env.recording.started_at);
  env.video.readyState = 0; env.player.seek(1000);
  env.player.setRecording({...env.recording, id: "new-file", duration: 60}); env.video.currentTime = 0;
  env.video.readyState = 1; env.video.duration = 60; await env.video.fire("loadedmetadata");
  assert.equal(env.video.currentTime, 0);
  env.player.destroy();
});

test("previous and next callbacks obey segment bounds and clear disables navigation", async () => {
  const env = environment(); env.player.setRecording(env.recording, {hasPrevious: false, hasNext: true});
  await env.elements.previous.fire("click"); await env.elements.next.fire("click");
  assert.deepEqual(env.counts(), {previous: 0, next: 1});
  env.player.setNavigation({previous: true, next: false});
  await env.elements.previous.fire("click"); await env.elements.next.fire("click");
  assert.deepEqual(env.counts(), {previous: 1, next: 1});
  env.player.clear(); await env.elements.previous.fire("click");
  assert.equal(env.elements.previous.disabled, true); assert.equal(env.elements.next.disabled, true);
  assert.deepEqual(env.counts(), {previous: 1, next: 1}); env.player.destroy();
});

test("a custom pending seek wins after source-owner metadata initialization without leaking across clear", async () => {
  const env = environment(); env.player.setRecording(env.recording); env.player.seek(123);
  env.video.readyState = 1; env.video.duration = 1800;
  // Browser event listeners run synchronously before the microtask checkpoint.
  for (const callback of env.video.listeners.get("loadedmetadata")) callback({target: env.video});
  env.video.currentTime = 0; // source owner's onloadedmetadata initial offset
  await flush(); assert.equal(env.video.currentTime, 123);
  env.video.readyState = 0; env.player.seek(456); env.video.readyState = 1;
  for (const callback of env.video.listeners.get("loadedmetadata")) callback({target: env.video});
  env.player.clear(); env.player.setRecording({...env.recording, id: "other"}); env.video.currentTime = 0;
  await flush(); assert.equal(env.video.currentTime, 0);
  env.player.destroy();
});

test("pausing a pending play while preparing prevents metadata from restarting autoplay", async () => {
  const env = environment(), preparing = deferred();
  env.player.setRecording(env.recording, {autoplay: true});
  env.video.play = () => { env.video.playCount++; return preparing.promise; };
  const pending = env.player.togglePlayback();
  assert.equal(env.player.pendingPlay !== null, true);
  await env.player.togglePlayback(); // user presses Pause before metadata is ready
  assert.equal(env.player.playIntent, false);
  await env.video.fire("play"); // an old queued event cannot undo the later Pause
  assert.equal(env.player.playIntent, false);
  env.video.readyState = 1; env.video.duration = 1800;
  await env.video.fire("loadedmetadata");
  env.video.currentTime = 30; // the source owner initializes its requested offset
  await env.player.startIfWanted();
  assert.equal(env.video.playCount, 1);
  preparing.resolve(); env.video.paused = false; await pending;
  assert.equal(env.video.paused, true);
  assert.equal(env.player.playIntent, false);
  env.player.destroy();
});

test("metadata autoplay starts once and never duplicates an already pending play", async () => {
  const env = environment(), preparing = deferred();
  env.player.setRecording(env.recording);
  await env.player.startIfWanted(); assert.equal(env.video.playCount, 0); // default autoplay is off
  env.player.setRecording(env.recording, {autoplay: true});
  env.video.play = () => { env.video.playCount++; return preparing.promise; };
  const first = env.player.startIfWanted();
  await env.player.startIfWanted(); await env.player.startIfWanted();
  assert.equal(env.video.playCount, 1);
  preparing.resolve(); env.video.paused = false; await first;
  await env.player.startIfWanted(); assert.equal(env.video.playCount, 1);
  env.player.destroy();
});

test("speed, volume and mute survive source changes and never affect another video", async () => {
  const env = environment(); env.player.setRecording(env.recording);
  env.elements.speed.value = "1.5"; await env.elements.speed.fire("change");
  env.elements.volume.value = ".4"; await env.elements.volume.fire("input");
  assert.equal(env.video.playbackRate, 1.5); assert.equal(env.video.volume, .4); assert.equal(env.video.muted, false);
  env.player.setVolume(0); assert.equal(env.video.muted, true);
  await env.elements.mute.fire("click"); assert.equal(env.video.volume, .4); assert.equal(env.video.muted, false);
  env.player.setRecording({...env.recording, id: "new-source"});
  env.video.playbackRate = 1; env.video.volume = 1; env.video.muted = true;
  await env.video.fire("loadedmetadata");
  assert.equal(env.video.playbackRate, 1.5); assert.equal(env.video.volume, .4); assert.equal(env.video.muted, false);
  env.player.setSpeed(99); assert.equal(env.video.playbackRate, 1.5);
  env.player.destroy();
});

test("fullscreen failures are visible and available fullscreen can be entered and exited", async () => {
  const env = environment(); env.player.setRecording(env.recording);
  await env.player.toggleFullscreen(); assert.match(env.errors[0].message, /Fullscreen is unavailable/);
  env.elements.fullscreenTarget.requestFullscreen = async () => { env.document.fullscreenElement = env.elements.fullscreenTarget; };
  env.document.exitFullscreen = async () => { env.document.fullscreenElement = null; };
  await env.player.toggleFullscreen(); assert.equal(env.elements.fullscreen.dataset.fullscreen, "true");
  await env.player.toggleFullscreen(); assert.equal(env.elements.fullscreen.dataset.fullscreen, "false");
  env.player.destroy();
});

test("volume and speed errors are sanitized and leave the existing settings intact", () => {
  const env = environment(); env.player.setRecording(env.recording);
  Object.defineProperty(env.video, "volume", {get: () => .8, set() { throw Error("private-source-address"); }});
  env.player.setVolume(.2);
  assert.equal(env.player.volume, .8); assert.match(env.errors[0].message, /Playback volume is unavailable/);
  Object.defineProperty(env.video, "playbackRate", {get: () => 1, set() { throw Error("private-source-address"); }});
  env.player.setSpeed(.25);
  assert.equal(env.player.rate, 1); assert.match(env.errors[1].message, /Playback speed is unavailable/);
  assert.ok(env.errors.every((error) => !error.message.includes("private-source")));
  env.player.destroy();
});

test("missing timestamps do not fabricate an absolute recording time or axis", () => {
  const env = environment(); env.player.setRecording({...env.recording, started_at: null});
  assert.equal(env.elements.absoluteTime.textContent, "—"); assert.equal(env.elements.axis.children.length, 0);
  assert.equal(elapsedLabel(Infinity), "0:00");
  env.player.clear();
  assert.equal(env.elements.total.textContent, "0:00"); assert.equal(env.elements.axis.children.length, 0);
  env.player.destroy();
});

test("valid video metadata applies the real aspect ratio without inventing missing dimensions", async () => {
  const env = environment(), values = new Map();
  env.video.parentElement = {style: {setProperty: (name, value) => values.set(name, value)}};
  env.player.setRecording(env.recording);
  env.video.videoWidth = 3840; env.video.videoHeight = 2160;
  await env.video.fire("loadedmetadata");
  assert.equal(values.get("--record-video-aspect"), "3840 / 2160");
  env.video.videoWidth = 0; env.video.videoHeight = 0;
  await env.video.fire("loadedmetadata");
  assert.equal(values.get("--record-video-aspect"), "3840 / 2160");
  env.player.destroy();
});

test("the playback header date changes across midnight while axis ticks remain clock labels", () => {
  const env = environment();
  const started = new Date(2026, 9, 25, 23, 59, 50).getTime() / 1000;
  env.player.setRecording({...env.recording, started_at: started, duration: 120});
  const before = env.elements.absoluteTime.textContent;
  env.video.currentTime = 20; env.player.update();
  const expected = new Intl.DateTimeFormat("en-GB", {year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"}).format(new Date((started + 20) * 1000));
  assert.equal(env.elements.absoluteTime.textContent, expected);
  assert.notEqual(env.elements.absoluteTime.textContent, before);
  assert.match(env.elements.absoluteTime.textContent, /2026/);
  assert.ok(env.elements.axis.children.every((tick) => !tick.textContent.includes("2026")));
  env.player.destroy();
});

test("keyboard controls, relabel and time events retain position and avoid recursive callbacks", async () => {
  const env = environment(); env.player.setRecording(env.recording);
  env.video.readyState = 1; env.video.duration = 1800; env.video.currentTime = 30;
  await env.video.fire("keydown", {key: "ArrowRight"}); assert.equal(env.video.currentTime, 35);
  const callbacks = env.times.length;
  env.language("it"); env.player.relabel();
  assert.equal(env.video.currentTime, 35); assert.equal(env.times.length, callbacks);
  assert.equal(env.elements.play.getAttribute("aria-label"), "IT: Play");
  await env.video.fire("timeupdate"); assert.equal(env.times.length, callbacks + 1);
  assert.equal(env.times.at(-1).time, 35);
  env.player.destroy();
  const count = env.times.length; await env.video.fire("timeupdate");
  await env.elements.play.fire("click"); assert.equal(env.times.length, count);
  assert.ok([...env.video.listeners.values()].every((listeners) => listeners.length === 0));
  assert.ok([...env.document.listeners.values()].every((listeners) => listeners.length === 0));
});

test("missing custom controls keep the native fallback available", () => {
  const video = {controls: true};
  assert.throws(() => new NvrRecordPlayer({video, elements: {}}), /unavailable/);
  assert.equal(video.controls, true);
});
