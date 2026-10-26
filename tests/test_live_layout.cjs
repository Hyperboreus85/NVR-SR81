"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const {LiveLayoutModel, STORAGE_KEY} = require("../nvr/static/live-layout.js");
const source = readFileSync(join(__dirname, "../nvr/static/live-layout.js"), "utf8");
const cameras = (count = 4) => Array.from({length: count}, (_, index) => ({id: `camera-${index + 1}`, name: `Camera ${index + 1}`, source: "credentials-must-not-be-stored"}));
function storage(entries = []) {
  const values = new Map(entries);
  return {values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("first layout contains real cameras and migrates the existing grid preference", () => {
  const model = new LiveLayoutModel(cameras(10), storage([["nvr.monitor.layout", "4"]]));
  assert.equal(model.getSaved().size, 4);
  assert.equal(model.getSaved().slots.filter(Boolean).length, 10);
  assert.equal(model.hiddenCount, 6);
  assert.equal(new LiveLayoutModel(cameras(1), storage()).getSaved().size, 1);
  assert.equal(new LiveLayoutModel(cameras(5), storage()).getSaved().size, 9);
});

test("draft changes, reset, save and reload stay distinct and never persist camera details", () => {
  const disk = storage(), model = new LiveLayoutModel(cameras(), disk);
  model.assign(0, "camera-3");
  assert.equal(model.dirty, true);
  assert.deepEqual(model.getSaved().slots.slice(0, 4), ["camera-1", "camera-2", "camera-3", "camera-4"]);
  assert.equal(disk.values.size, 0);
  model.reset();
  assert.equal(model.dirty, false);
  model.assign(0, "camera-3"); model.save();
  const saved = new LiveLayoutModel(cameras(), disk).getSaved();
  assert.deepEqual(saved.slots.slice(0, 4), ["camera-3", "camera-2", "camera-1", "camera-4"]);
  assert.equal(disk.getItem(STORAGE_KEY).includes("credentials"), false);
  assert.equal(disk.getItem(STORAGE_KEY).includes("Camera 1"), false);
  const copy = model.getSaved(); copy.slots[0] = "changed";
  assert.equal(model.getSaved().slots[0], "camera-3");
});

test("shrinking preserves hidden assignments; moving a hidden camera swaps without duplicates", () => {
  const model = new LiveLayoutModel(cameras(16), storage());
  model.setSize(1); model.save();
  assert.equal(model.hiddenCount, 15);
  model.assign(0, "camera-16");
  assert.equal(model.getDraft().slots[15], "camera-1");
  assert.equal(new Set(model.getDraft().slots).size, 16);
  model.setSize(16);
  assert.deepEqual(model.getDraft().slots.slice(14), ["camera-15", "camera-1"]);
});

test("tile reorder and removal preserve empty positions", () => {
  const model = new LiveLayoutModel(cameras(), storage());
  model.assign(1, null); model.swap(0, 1);
  assert.deepEqual(model.getDraft().slots.slice(0, 4), [null, "camera-1", "camera-3", "camera-4"]);
  assert.throws(() => model.swap(0, 16), /valid layout tile/);
  assert.throws(() => model.assign(0, "unknown-camera"), /unavailable/);
});

test("deleted cameras clear their slot and newly configured cameras are not automatically assigned", () => {
  const disk = storage(), model = new LiveLayoutModel(cameras(), disk);
  model.save(); model.assign(0, "camera-2");
  const changed = [...cameras().filter((camera) => camera.id !== "camera-3"), {id: "new", name: "New camera"}];
  model.setCameras(changed);
  assert.equal(model.getSaved().slots[2], null);
  assert.equal(model.getDraft().slots[0], "camera-2");
  assert.equal(model.getDraft().slots.includes("new"), false);
});

test("corrupt storage falls back safely; unknown and duplicate IDs cannot enter the grid twice", () => {
  const broken = new LiveLayoutModel(cameras(), storage([[STORAGE_KEY, "{broken"]]));
  assert.equal(broken.readWarning, true);
  assert.equal(broken.getSaved().slots[0], "camera-1");
  const disk = storage([[STORAGE_KEY, JSON.stringify({version: 1, size: 4, slots: ["camera-1", "camera-1", "unknown", null]})]]);
  const valid = new LiveLayoutModel(cameras(), disk);
  assert.deepEqual(valid.getSaved().slots.slice(0, 4), ["camera-1", null, null, null]);
});

test("a blocked write leaves saved state unchanged and the draft available for retry", () => {
  const disk = storage(), model = new LiveLayoutModel(cameras(), disk);
  const saved = model.getSaved(); model.assign(0, null);
  disk.setItem = () => { throw Error("Quota exceeded"); };
  assert.throws(() => model.save(), /could not be saved in this browser/);
  assert.deepEqual(model.getSaved(), saved);
  assert.equal(model.getDraft().slots[0], null);
  assert.equal(model.dirty, true);
});

test("quick monitor size saves saved slots without committing unsaved editor assignments", () => {
  const disk = storage(), model = new LiveLayoutModel(cameras(), disk);
  model.assign(0, null); model.applySize(1);
  assert.equal(model.getSaved().size, 1);
  assert.equal(model.getSaved().slots[0], "camera-1");
  assert.equal(model.getDraft().slots[0], null);
  assert.equal(model.dirty, true);
  assert.equal(new LiveLayoutModel(cameras(), disk).getSaved().size, 1);
});

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {};
    this.listeners = new Map(); this.attributes = new Map(); this.value = "";
    this.classList = {toggle() {}};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw Error("HTML insertion forbidden"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = [...children]; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); if (key === "src") this.src = undefined; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter((value) => value !== callback)); }
  fire(type, extra = {}) { for (const callback of this.listeners.get(type) || []) callback({target: this, preventDefault() {}, ...extra}); }
}
function editorEnvironment({count = 4, disk = storage(), fetch} = {}) {
  const document = {createElement: (tag) => new Element(tag, document)};
  const root = new Element("section", document), nodes = new Map();
  for (const [name, tag] of [["layout-grid", "div"], ["layout-camera-list", "div"], ["layout-grid-size", "select"],
                           ["layout-status", "p"], ["layout-reset", "button"], ["layout-save", "button"]]) nodes.set(name, new Element(tag, document));
  const presets = [1, 4, 9, 16].map((size) => Object.assign(new Element("button", document), {dataset: {layoutPreset: String(size)}}));
  root.querySelector = (selector) => nodes.get(selector.slice(1));
  root.querySelectorAll = (selector) => selector === "[data-layout-preset]" ? presets : [];
  const created = [], revoked = [], saved = [], errors = [];
  const context = vm.createContext({console, AbortController, fetch, URL: {
    createObjectURL(blob) { const url = `blob:thumbnail-${created.length}`; created.push({url, blob}); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  }});
  context.window = context;
  vm.runInContext(source, context);
  const controller = new context.NvrLiveLayout({root, cameras: cameras(count), storage: disk,
    t: (key, params = {}) => key.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token),
    onSave: (value) => saved.push(plain(value)), onError: (error) => errors.push(error)});
  return {controller, root, nodes, presets, saved, errors, created, revoked};
}
const selectFor = (tile) => tile.children.find((node) => node.tagName === "SELECT");
const transfer = () => { const values = new Map(); return {setData: (key, value) => values.set(key, value), getData: (key) => values.get(key) || ""}; };

test("DOM controller supports preset, dropdown, drag reorder, Reset and explicit Save", () => {
  const env = editorEnvironment(); env.controller.open();
  const grid = env.nodes.get("layout-grid");
  assert.equal(grid.children.length, 4);
  let select = selectFor(grid.children[0]); select.value = "camera-3"; select.fire("change");
  assert.equal(env.saved.length, 0);
  assert.equal(env.controller.model.getDraft().slots[0], "camera-3");
  const dataTransfer = transfer(); grid.children[0].fire("dragstart", {dataTransfer}); grid.children[1].fire("drop", {dataTransfer});
  assert.deepEqual(plain(env.controller.model.getDraft().slots.slice(0, 3)), ["camera-2", "camera-3", "camera-1"]);
  env.nodes.get("layout-reset").fire("click");
  assert.equal(env.controller.model.dirty, false);
  env.presets[0].fire("click");
  assert.equal(grid.children.length, 1);
  assert.match(env.nodes.get("layout-status").textContent, /3 assignments/);
  env.nodes.get("layout-save").fire("click");
  assert.equal(env.saved.length, 1); assert.equal(env.saved[0].size, 1);
  env.controller.destroy();
});

test("camera names are plain text, and keyboard/touch assignment works without drag", () => {
  const env = editorEnvironment();
  const name = '<img src=x onerror="globalThis.compromised=true">';
  env.controller.setCameras([{id: "camera-1", name}, {id: "camera-2", name: "Second"}]);
  env.controller.open();
  const list = env.nodes.get("layout-camera-list");
  assert.equal(list.children[0].children[0].textContent, name);
  list.children[1].fire("click");
  const tile = env.nodes.get("layout-grid").children[0]; tile.fire("keydown", {key: "Enter"});
  assert.equal(env.controller.model.getDraft().slots[0], "camera-2");
  env.controller.close(); env.controller.open();
  assert.equal(env.controller.model.getDraft().slots[0], "camera-2");
  env.controller.relabel();
  assert.equal(env.controller.model.getDraft().slots[0], "camera-2");
  env.controller.destroy();
});

test("blocked browser storage reports an error and never announces a successful save", () => {
  const disk = storage(); disk.setItem = () => { throw Error("blocked"); };
  const env = editorEnvironment({disk}); env.controller.open();
  env.controller.model.assign(0, null);
  assert.equal(env.controller.save(), false);
  assert.equal(env.saved.length, 0); assert.equal(env.errors.length, 1);
  assert.equal(env.controller.model.dirty, true);
  assert.match(env.nodes.get("layout-status").textContent, /could not be saved/);
  env.controller.destroy();
});

test("status polling does not replace editor tiles or interrupt a pending drag", () => {
  const env = editorEnvironment(); env.controller.open();
  const tile = env.nodes.get("layout-grid").children[0];
  env.controller.setCameras(cameras().map((camera) => ({...camera, status: {state: "recording"}})));
  assert.equal(env.nodes.get("layout-grid").children[0], tile);
  env.controller.destroy();
});

test("shrinking the editor does not start queued snapshots for hidden camera tiles", async () => {
  const pending = [];
  const env = editorEnvironment({fetch: (url, options) => new Promise((resolve) => pending.push({url, options, resolve}))});
  env.controller.open(); assert.equal(pending.length, 2);
  env.presets[0].fire("click");
  pending[0].resolve({ok: true, headers: {get: () => "4"}, blob: async () => ({size: 4, type: "image/jpeg"})});
  await flush();
  assert.equal(pending.length, 2);
  env.controller.destroy();
});

test("unavailable snapshots retain the camera assignment and successful image loads hide the fallback", async () => {
  const pending = [];
  const env = editorEnvironment({count: 1, fetch: (url, options) => new Promise((resolve) => pending.push({url, options, resolve}))});
  env.controller.open();
  const preview = () => env.nodes.get("layout-grid").children[0].children.find((node) => node.className === "layout-tile-preview");
  const fallback = () => preview().children.find((node) => node.className === "layout-preview-unavailable");
  assert.equal(fallback().textContent, "Preview unavailable.");
  assert.notEqual(fallback().hidden, true);
  pending[0].resolve({ok: false}); await flush();
  assert.notEqual(fallback().hidden, true);
  assert.equal(env.controller.model.getDraft().slots[0], "camera-1");
  env.controller.close(); env.controller.open();
  pending[1].resolve({ok: true, headers: {get: () => "4"}, blob: async () => ({size: 4, type: "image/jpeg"})});
  await flush();
  const image = preview().children.find((node) => node.tagName === "IMG");
  assert.equal(image.src, "blob:thumbnail-0");
  image.fire("load");
  assert.equal(fallback().hidden, true);
  image.fire("error");
  assert.equal(fallback().hidden, false);
  assert.equal(image.src, undefined);
  assert.equal(env.controller.model.getDraft().slots[0], "camera-1");
  env.controller.destroy();
});

test("snapshots are bounded to two pending requests and close cancels without accepting stale results", async () => {
  const pending = [];
  const fetch = (url, options) => new Promise((resolve) => pending.push({url, options, resolve}));
  const env = editorEnvironment({count: 16, fetch}); env.controller.open();
  assert.equal(pending.length, 2);
  assert.ok(pending.every((item) => item.url.endsWith("/snapshot") && item.options.credentials === "same-origin"));
  env.controller.close();
  assert.ok(pending.every((item) => item.options.signal.aborted));
  for (const item of pending) item.resolve({ok: true, headers: {get: () => "4"}, blob: async () => ({size: 4, type: "image/jpeg"})});
  await flush();
  assert.equal(env.created.length, 0);
  env.controller.open();
  assert.equal(pending.length, 4);
  pending[2].resolve({ok: true, headers: {get: () => "4"}, blob: async () => ({size: 4, type: "image/jpeg"})});
  await flush();
  assert.equal(env.created.length, 1);
  assert.equal(pending.length, 5); // one completion starts exactly one queued snapshot
  env.controller.destroy();
  assert.equal(env.revoked.length, 1);
  assert.equal(env.controller.previewQueue.length, 0);
});
