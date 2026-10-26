"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {NvrRecorderClock, NvrCameraRotation, ROTATION_SECONDS} = require("../nvr/static/recorder-preferences.js");

test("clock forces its explicit time zone and12/24 hour cycle over caller options", () => {
  const clock = new NvrRecorderClock({timezone: "UTC", hourFormat: "24"});
  const date = new Date("2026-10-26T19:08:24Z"), timestamp = date.getTime(), dateClass = global.Date;
  assert.equal(clock.format(date, {hour: "2-digit", minute: "2-digit", hour12: true, hourCycle: "h12", timeZone: "Asia/Tokyo"}, "en-US"), "19:08");
  clock.configure({effective_timezone: "UTC", hour_format: "12"});
  assert.match(clock.format(date, {hour: "numeric", minute: "2-digit", hour12: false, hourCycle: "h23"}, "en-US"), /^7:08\s*PM$/);
  assert.match(clock.format(new Date("2026-10-26T00:00:00Z"), {timeStyle: "short"}, "en-US"), /^12:00\s*AM$/);
  assert.equal(clock.toInput(date), "2026-10-26T19:08");
  assert.equal(clock.toDateInput(date), "2026-10-26");
  assert.equal(date.getTime(), timestamp); assert.equal(global.Date, dateClass);
});

test("Rome conversions use the recorder zone through summer and winter independently of the browser", () => {
  const clock = new NvrRecorderClock({timezone: "Europe/Rome"});
  assert.equal(clock.toInput(new Date("2026-07-01T12:00:00Z")), "2026-07-01T14:00");
  assert.equal(clock.toInput(new Date("2026-12-01T12:00:00Z")), "2026-12-01T13:00");
  assert.equal(clock.fromInput("2026-07-01T14:00").toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(clock.fromInput("2026-12-01T13:00").toISOString(), "2026-12-01T12:00:00.000Z");
  assert.equal(clock.format(new Date("2026-12-01T23:30Z"), {year: "numeric", month: "2-digit", day: "2-digit"}, "en-GB"), "02/12/2026");
});

test("DST spring gaps are rejected and autumn repeated minutes choose the earlier instant", () => {
  const clock = new NvrRecorderClock({timezone: "Europe/Rome"});
  assert.equal(clock.fromInput("2026-03-29T02:30"), null);
  assert.equal(clock.fromInput("2026-03-29T01:30").toISOString(), "2026-03-29T00:30:00.000Z");
  assert.equal(clock.fromInput("2026-03-29T03:30").toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(clock.fromInput("2026-10-25T02:30").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(clock.toInput(new Date("2026-10-25T00:30Z")), clock.toInput(new Date("2026-10-25T01:30Z")));
  clock.configure({effective_timezone: "America/New_York"});
  assert.equal(clock.fromInput("2017-03-12T02:30"), null);
  assert.equal(clock.fromInput("2017-11-05T01:30").toISOString(), "2017-11-05T05:30:00.000Z");
});

test("fractional offsets, half-hour DST and a skipped whole calendar date are handled", () => {
  const clock = new NvrRecorderClock({timezone: "Asia/Kathmandu"});
  assert.equal(clock.fromInput("2026-10-26T12:00").toISOString(), "2026-10-26T06:15:00.000Z");
  clock.configure({effective_timezone: "Australia/Lord_Howe"});
  assert.equal(clock.fromInput("2026-10-04T02:15"), null);
  assert.equal(clock.fromInput("2026-10-04T02:45").toISOString(), "2026-10-03T15:45:00.000Z");
  assert.equal(clock.fromInput("2026-04-05T01:45").toISOString(), "2026-04-04T14:45:00.000Z");
  clock.configure({effective_timezone: "Pacific/Apia"});
  assert.equal(clock.fromInput("2011-12-30T12:00"), null);
  assert.equal(clock.fromInput("2011-12-31T12:00").toISOString(), "2011-12-30T22:00:00.000Z");
});

test("minute inputs are strict Gregorian dates including leap years and early AD years", () => {
  const clock = new NvrRecorderClock();
  for (const value of [null, 0, "", "2026-10-26", "2026-10-26 12:00", "2026-10-26T12:00Z", "2026-10-26T12:00:00",
    "2026-02-29T00:00", "2026-04-31T00:00", "2026-01-01T24:00", "2026-01-01T00:60", "0000-01-01T00:00"])
    assert.equal(clock.fromInput(value), null, String(value));
  assert.equal(clock.fromInput("2024-02-29T00:00").toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(clock.fromInput("0001-01-01T00:00").toISOString(), "0001-01-01T00:00:00.000Z");
  assert.equal(clock.fromInput("0099-12-31T23:59").getUTCFullYear(), 99);
  const bc = new Date(0); bc.setUTCFullYear(0); assert.equal(clock.toInput(bc), "");
  assert.equal(clock.toInput(new Date(NaN)), ""); assert.equal(clock.format(null), "");
});

test("invalid configuration leaves the previous clock intact and locale changes do not retain old formatting", () => {
  const clock = new NvrRecorderClock({timezone: "Europe/Rome", hourFormat: "24"});
  for (const zone of ["Not/A_Zone", "+02:00", "Europe/Rome\n", "", null]) {
    assert.throws(() => clock.configure({effective_timezone: zone, hour_format: "12"}), /Invalid time zone/);
    assert.equal(clock.timezone, "Europe/Rome"); assert.equal(clock.hourFormat, "24");
  }
  assert.throws(() => clock.configure({effective_timezone: "UTC", hour_format: 12}), /12-hour/);
  assert.equal(clock.timezone, "Europe/Rome");
  const previous = global.NvrI18n;
  try {
    global.NvrI18n = {locale: () => "en-GB"};
    const date = new Date("2026-10-26T12:00Z");
    const english = clock.format(date, {month: "long"});
    global.NvrI18n = {locale: () => "it-IT"};
    assert.equal(english, "October"); assert.equal(clock.format(date, {month: "long"}), "ottobre");
  } finally { global.NvrI18n = previous; }
});

class Timers {
  constructor() { this.now = 0; this.next = 0; this.tasks = new Map(); this.scheduled = 0; this.maximum = 0; }
  set = (callback, delay) => { const id = this.next++; this.tasks.set(id, {callback, due: this.now + delay}); this.scheduled++; this.maximum = Math.max(this.maximum, this.tasks.size); return id; };
  clear = (id) => this.tasks.delete(id);
  advance(milliseconds) {
    const end = this.now + milliseconds;
    for (let count = 0; count < 1000; count++) {
      const next = [...this.tasks.entries()].sort(([, a], [, b]) => a.due - b.due)[0];
      if (!next || next[1].due > end) { this.now = end; return; }
      this.now = next[1].due; this.tasks.delete(next[0]); next[1].callback();
    }
    throw Error("Unexpected timer loop");
  }
}
function rotationEnvironment(count = 6, size = 4) {
  const timers = new Timers(), events = [];
  const env = {cameras: Array.from({length: count}, (_, index) => ({id: `camera-${index + 1}`, enabled: false, name: "<img src=x>"})),
    layout: {size, slots: ["camera-4", null, "camera-2", null]}, active: true};
  env.rotation = new NvrCameraRotation({getCameras: () => env.cameras, getLayout: () => env.layout, isActive: () => env.active,
    setTimer: timers.set, clearTimer: timers.clear, onRotate: (ids, state) => events.push({ids, state, at: timers.now})});
  return {...env, timers, events, source: env};
}

test("rotation pages every configured camera in order with real empty last-page slots and never writes layout", () => {
  const env = rotationEnvironment(), saved = JSON.stringify(env.source.layout);
  assert.equal(env.rotation.currentIds(), null);
  assert.deepEqual(env.rotation.configure(15), ["camera-1", "camera-2", "camera-3", "camera-4"]);
  env.timers.advance(15000);
  assert.deepEqual(env.events[0].ids, ["camera-5", "camera-6", null, null]);
  assert.equal(env.events[0].state.page, 1); assert.equal(env.events[0].state.active, true);
  env.timers.advance(15000);
  assert.deepEqual(env.events[1].ids, ["camera-1", "camera-2", "camera-3", "camera-4"]);
  assert.equal(JSON.stringify(env.source.layout), saved);
  assert.equal(env.timers.maximum, 1);
  env.rotation.configure(0);
  assert.equal(env.rotation.currentIds(), null); assert.equal(env.timers.tasks.size, 0);
});

test("frequent polling and identical configure calls cannot postpone a60-second rotation", () => {
  const env = rotationEnvironment(2, 1);
  env.rotation.configure(60);
  for (let index = 0; index < 11; index++) { env.timers.advance(5000); env.rotation.sync(); env.rotation.configure(60); }
  assert.equal(env.timers.scheduled, 1); assert.equal(env.events.length, 0);
  env.timers.advance(5000);
  assert.equal(env.events.length, 1); assert.equal(env.events[0].at, 60000);
  assert.deepEqual(env.rotation.currentIds(), ["camera-2"]);
  for (let index = 0; index < 6; index++) { env.timers.advance(10000); env.rotation.sync(); }
  assert.equal(env.events.length, 2); assert.equal(env.events[1].at, 120000);
});

test("pause or hidden/tile-fullscreen state stops timers and resume keeps the page", () => {
  const env = rotationEnvironment(3, 1);
  env.rotation.configure(15); env.timers.advance(15000);
  assert.equal(env.rotation.state().page, 1);
  env.source.active = false; env.rotation.sync();
  assert.equal(env.rotation.state().active, false); assert.equal(env.timers.tasks.size, 0);
  env.timers.advance(120000); assert.equal(env.events.length, 1);
  env.source.active = true; env.rotation.sync();
  env.timers.advance(14000); assert.equal(env.events.length, 1);
  env.timers.advance(1000); assert.equal(env.rotation.state().page, 2);
  env.rotation.stop(); assert.equal(env.timers.tasks.size, 0); assert.equal(env.rotation.state().active, false);
});

test("whole-wall fullscreen is controlled by the supplied predicate and can keep rotating", () => {
  const timers = new Timers(), view = {live: true, playing: true, hidden: false, tileFullscreen: false, wallFullscreen: true};
  let changed = 0;
  const rotation = new NvrCameraRotation({getCameras: () => ["a", "b"], getLayout: () => 1,
    isActive: () => view.live && view.playing && !view.hidden && !view.tileFullscreen,
    onRotate: () => changed++, setTimer: timers.set, clearTimer: timers.clear});
  rotation.configure(15); timers.advance(15000); assert.equal(changed, 1);
  view.tileFullscreen = true; rotation.sync(); timers.advance(15000); assert.equal(changed, 1);
  view.tileFullscreen = false; rotation.sync(); timers.advance(15000); assert.equal(changed, 2);
});

test("zero/one-page camera sets never start an unnecessary timer", () => {
  for (const count of [0, 1, 4]) {
    const env = rotationEnvironment(count, 4);
    const ids = env.rotation.configure(30);
    assert.equal(ids.length, 4); assert.equal(env.timers.tasks.size, 0); assert.equal(env.rotation.state().active, false);
    env.timers.advance(300000); assert.equal(env.events.length, 0);
    assert.equal(env.rotation.state().pages, Math.ceil(count / 4));
  }
});

test("camera refresh, size changes and stale cancelled callbacks reset safely without touching source arrays", () => {
  const env = rotationEnvironment(3, 1);
  env.rotation.configure(15); env.timers.advance(15000);
  const stale = [...env.timers.tasks.values()][0].callback;
  env.source.cameras = [{id: "new"}, {id: "camera-1"}];
  env.timers.advance(15000);
  assert.equal(env.events.length, 1); assert.deepEqual(env.rotation.currentIds(), ["new"]); assert.equal(env.rotation.state().page, 0);
  env.rotation.sync(); assert.equal(env.timers.tasks.size, 1);
  env.source.layout = {size: 4, slots: ["camera-1", null, null, null]}; env.rotation.sync();
  assert.deepEqual(env.rotation.currentIds(), ["new", "camera-1", null, null]); assert.equal(env.timers.tasks.size, 0);
  env.rotation.configure(0); stale(); assert.equal(env.rotation.currentIds(), null); assert.equal(env.events.length, 1);
});

test("rotation supports all allowed intervals, rejects invalid changes atomically and handles timer id0", () => {
  const env = rotationEnvironment(2, 1);
  env.rotation.configure(30);
  assert.equal([...env.timers.tasks.keys()][0], 0);
  for (const value of [1, 10, 45, "30", null, true, NaN]) {
    assert.throws(() => env.rotation.configure(value), /valid live rotation/);
    assert.equal(env.rotation.state().seconds, 30); assert.equal(env.timers.scheduled, 1);
  }
  for (const value of ROTATION_SECONDS) {
    env.rotation.configure(value); assert.equal(env.timers.tasks.size, value ? 1 : 0);
  }
  env.rotation.stop(); assert.equal(env.timers.tasks.size, 0);
});

test("rendering inside onRotate and repeated sync use one timer, and returned arrays are independent", () => {
  const timers = new Timers(), cameras = [{id: "a"}, {id: "b"}, {id: "b"}, {id: ""}, null];
  let rotation;
  rotation = new NvrCameraRotation({getCameras: () => cameras, getLayout: () => ({size: 1}), isActive: () => true,
    setTimer: timers.set, clearTimer: timers.clear, onRotate: (ids, state) => {
      ids.push("injected"); state.page = 999; rotation.sync(); rotation.configure(15);
    }});
  rotation.configure(15); timers.advance(45000);
  assert.deepEqual(rotation.currentIds(), ["b"]); assert.equal(rotation.state().page, 1);
  assert.equal(timers.maximum, 1); assert.equal(timers.tasks.size, 1);
  const current = rotation.currentIds(); current[0] = "fake"; assert.deepEqual(rotation.getCurrentIds(), ["b"]);
  rotation.reset(); assert.equal(rotation.state().page, 0); assert.equal(timers.tasks.size, 1);
});

test("an explicit stop inside a rotation callback cannot accidentally rearm itself", () => {
  const timers = new Timers();
  let rotation;
  rotation = new NvrCameraRotation({getCameras: () => ["a", "b"], getLayout: () => 1, isActive: () => true,
    setTimer: timers.set, clearTimer: timers.clear, onRotate: () => rotation.stop()});
  rotation.configure(15); timers.advance(15000);
  assert.equal(rotation.state().active, false); assert.equal(timers.tasks.size, 0);
});
