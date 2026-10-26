"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");

function access() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, "../nvr/static/access.js"), "utf8"), context);
  return context.NvrAccess;
}
const user = (extra = {}) => ({id: "viewer-fixture", username: "viewer", display_name: "Viewer", role: "user", permissions: ["live"],
  camera_scope: "selected", camera_ids: ["camera-a"], enabled: true, builtin: false, ...extra});

test("unassigned and malformed sessions never grant access, while a viewer cannot inherit administrator tabs", () => {
  const value = access();
  assert.equal(value.can("live"), false);
  assert.equal(value.setUser(user()), true);
  assert.equal(value.can("live"), true);
  assert.equal(value.can("recordings"), false);
  assert.equal(value.isAdmin(), false);
  assert.equal(value.settingsTabs().length, 0);
  const detached = value.user(); detached.permissions.push("maintenance"); detached.camera_ids.push("camera-b");
  assert.equal(value.can("maintenance"), false);
  assert.equal(value.user().camera_ids.length, 1);
  assert.equal(value.setUser(user({enabled: false})), false);
  assert.equal(value.can("live"), false);
  assert.equal(value.setUser(user({permissions: ["invented-permission"]})), false);
});

test("read-only system access has one settings tab and each named account has separate browser layout keys", () => {
  const value = access();
  value.setUser(user({permissions: ["system"]}));
  assert.deepEqual([...value.settingsTabs()], ["system"]);
  const viewerKey = value.storageKey("nvr.live.layout.v1");
  value.setUser(user({id: "operator-fixture", permissions: ["settings"]}));
  assert.notEqual(value.storageKey("nvr.live.layout.v1"), viewerKey);
  assert.deepEqual([...value.settingsTabs()], ["general", "languages", "recording"]);
  value.setUser(user({id: "builtin-admin", role: "admin", builtin: true}));
  assert.equal(value.storageKey("nvr.live.layout.v1"), "nvr.live.layout.v1");
  assert.equal(value.can("maintenance"), true);
  assert.equal(value.can("unknown"), false);
  assert.deepEqual([...value.settingsTabs()], ["general", "languages", "recording", "system", "users"]);
});
