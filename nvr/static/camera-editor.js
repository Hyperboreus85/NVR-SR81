"use strict";

((global) => {
  const ports = {rtsp: 554, rtsps: 322, http: 80, https: 443};
  const streamNames = ["main", "sub", "third"];
  const sourceIds = {main: "camera-url", sub: "camera-preview-url", third: "camera-third-url"};
  function failure(message, fieldId) { const error = new Error(message); error.fieldId = fieldId; return error; }
  function decoded(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }
  function parseSource(value, fieldId = "camera-url") {
    const raw = String(value).trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) throw failure("Enter a valid full stream URL.", fieldId);
    let url;
    try { url = new URL(raw); } catch (_) { throw failure("Enter a valid full stream URL.", fieldId); }
    const protocol = url.protocol.slice(0, -1).toLowerCase();
    if (!Object.hasOwn(ports, protocol)) throw failure("Choose RTSP, RTSPS, HTTP or HTTPS for video streams.", fieldId);
    if (!url.hostname || url.hash) throw failure("Enter a valid full stream URL without a fragment.", fieldId);
    return {raw, protocol, host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : ports[protocol], username: decoded(url.username), password: decoded(url.password), path: (url.pathname || "/") + (url.search || "?")};
  }
  function sameConnection(a, b) {
    return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username && a.password === b.password;
  }
  function pathValue(value, fieldId) {
    const raw = String(value).trim();
    if (/[\u0000-\u001f\u007f]/.test(raw) || raw.includes("#")) throw failure("Enter a stream path and query without a fragment.", fieldId);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw failure("Switch this stream to Full URL to paste a complete address.", fieldId);
    return !raw || raw.startsWith("/") || raw.startsWith("?") ? raw : "/" + raw;
  }

  class NvrCameraEditor {
    constructor({root, t = (key) => key} = {}) {
      if (!root) throw new Error("Camera editor unavailable.");
      this.root = root; this.t = t; this.listeners = []; this.original = null;
      this.byId = (id) => root.querySelector("#" + id);
      const required = ["camera-protocol", "camera-host", "camera-port", "camera-username", "camera-password", "camera-clear-credentials", "camera-live-stream", "camera-probe-stream", ...streamNames.flatMap((name) => ["camera-" + name + "-mode", "camera-" + name + "-path", sourceIds[name]])];
      if (required.some((id) => !this.byId(id))) throw new Error("Camera editor unavailable.");
      this.listen(this.byId("camera-protocol"), "change", () => {
        const next = this.byId("camera-protocol").value, port = this.byId("camera-port");
        if (!port.value || port.value === String(ports[this.protocol])) port.value = String(ports[next] || "");
        this.protocol = next; this.render();
      });
      for (const name of streamNames) {
        this.listen(this.byId("camera-" + name + "-mode"), "change", () => this.render());
        for (const id of ["camera-" + name + "-path", sourceIds[name]]) this.listen(this.byId(id), "input", () => this.render());
      }
      for (const id of ["camera-sub-enabled", "camera-third-enabled", "camera-clear-credentials"]) this.listen(this.byId(id), "change", () => this.render());
      this.setCamera(null);
    }
    listen(element, type, handler) { element.addEventListener(type, handler); this.listeners.push(() => element.removeEventListener(type, handler)); }
    enabled(name) { return name === "main" || this.byId("camera-" + name + "-enabled").checked; }
    setCamera(camera) {
      const connection = camera?.connection || {};
      const configured = (name, fallback) => typeof camera?.streams?.[name]?.configured === "boolean" ? camera.streams[name].configured : !!fallback;
      this.original = {editing: !!camera?.id, hasUsername: connection.has_username === true, hasPassword: connection.has_password === true, independent: {main: false, sub: camera?.streams?.sub?.independent === true, third: camera?.streams?.third?.independent === true}, configured: {main: configured("main", camera?.id || camera?.source), sub: configured("sub", camera?.preview_source), third: configured("third", camera?.third_source)}};
      this.protocol = Object.hasOwn(ports, connection.protocol) ? connection.protocol : "rtsp";
      this.byId("camera-protocol").value = this.protocol;
      this.byId("camera-host").value = typeof connection.host === "string" ? connection.host : "";
      this.byId("camera-port").value = Number.isInteger(connection.port) ? String(connection.port) : String(ports[this.protocol]);
      this.byId("camera-username").value = ""; this.byId("camera-password").value = ""; this.byId("camera-clear-credentials").checked = false;
      for (const name of streamNames) {
        this.byId("camera-" + name + "-mode").value = this.original.independent[name] ? "url" : "path";
        this.byId("camera-" + name + "-path").value = ""; this.byId(sourceIds[name]).value = "";
        if (name !== "main") this.byId("camera-" + name + "-enabled").checked = this.original.configured[name];
      }
      this.byId("camera-live-stream").value = String([1, 2, 3].includes(camera?.live_stream) ? camera.live_stream : 2);
      this.byId("camera-probe-stream").value = "1";
      this.render();
      return this;
    }
    setSources(sources = {}) {
      const keys = {main: "url", sub: "preview_url", third: "third_url"}, incoming = {};
      // Validate every supplied URL before changing the user's existing draft.
      for (const name of streamNames) if (Object.hasOwn(sources, keys[name]) && sources[keys[name]] !== null && sources[keys[name]] !== undefined) incoming[name] = String(sources[keys[name]]).trim() ? parseSource(sources[keys[name]], sourceIds[name]) : null;
      const main = incoming.main;
      if (main) {
        this.protocol = main.protocol; this.byId("camera-protocol").value = main.protocol;
        this.byId("camera-host").value = main.host; this.byId("camera-port").value = String(main.port);
        this.byId("camera-username").value = main.username; this.byId("camera-password").value = main.password;
        this.byId("camera-clear-credentials").checked = false;
      }
      for (const name of streamNames) {
        if (!Object.hasOwn(incoming, name)) continue;
        const value = incoming[name], usePath = value && (name === "main" || main && sameConnection(main, value));
        this.byId(sourceIds[name]).value = value?.raw || "";
        this.byId("camera-" + name + "-path").value = value?.path || "";
        this.byId("camera-" + name + "-mode").value = !value || usePath ? "path" : "url";
        if (name !== "main") this.byId("camera-" + name + "-enabled").checked = !!value;
      }
      this.render(); return this;
    }
    getPayload() {
      const streams = {};
      for (const name of streamNames) {
        if (!this.enabled(name)) { streams[name] = ""; continue; }
        const full = this.byId("camera-" + name + "-mode").value === "url";
        const fieldId = full ? sourceIds[name] : "camera-" + name + "-path", value = this.byId(fieldId).value.trim();
        if (!value && this.original.editing && this.original.configured[name]) streams[name] = null;
        else if (full) streams[name] = parseSource(value, fieldId).raw;
        else if (!value && name !== "main") throw failure(name === "sub" ? "Enter a path or full URL for the substream." : "Enter a path or full URL for the third stream.", fieldId);
        else streams[name] = pathValue(value || "/", fieldId);
      }
      const live = Number(this.byId("camera-live-stream").value);
      if (![1, 2, 3].includes(live) || live === 3 && !this.enabled("third")) throw failure("Enable and configure the third stream before selecting it for live viewing.", "camera-live-stream");
      const needsConnection = streamNames.some((name) => this.enabled(name) && (streams[name] === null || !/^[a-z][a-z0-9+.-]*:\/\//i.test(streams[name])));
      let connection = null;
      if (needsConnection) {
        const protocol = this.byId("camera-protocol").value;
        if (!Object.hasOwn(ports, protocol)) throw failure("Choose RTSP, RTSPS, HTTP or HTTPS for video streams.", "camera-protocol");
        let host = this.byId("camera-host").value.trim();
        if (!host || /[\s\/@?#\u0000-\u001f\u007f]/.test(host)) throw failure("Enter the camera IP address or hostname.", "camera-host");
        host = host.replace(/^\[|\]$/g, "");
        try { const checked = new URL(protocol + "://" + (host.includes(":") ? "[" + host + "]" : host) + "/"); if (!checked.hostname) throw new Error(); }
        catch (_) { throw failure("Enter the camera IP address or hostname.", "camera-host"); }
        const rawPort = this.byId("camera-port").value.trim(), port = rawPort ? Number(rawPort) : null;
        if (rawPort && (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)) throw failure("Enter a port between 1 and 65535.", "camera-port");
        const clear = this.original.editing && this.byId("camera-clear-credentials").checked;
        const username = this.byId("camera-username").value, password = this.byId("camera-password").value;
        if (!clear && (username.length > 200 || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(username + password))) throw failure("Enter valid camera credentials.", username.length > 200 ? "camera-username" : "camera-password");
        connection = {protocol, host, port, username: clear ? "" : username || (this.original.editing ? null : ""), password: clear ? "" : password || (this.original.editing ? null : "")};
      }
      return {connection, streams, live_stream: live};
    }
    render() {
      const editing = this.original.editing, clear = editing && this.byId("camera-clear-credentials").checked;
      this.byId("camera-credentials-clear-row").hidden = !editing;
      this.byId("camera-private-fields-note").hidden = !editing;
      this.byId("camera-username").disabled = clear; this.byId("camera-password").disabled = clear;
      this.byId("camera-username").placeholder = this.t(editing && this.original.hasUsername ? "Saved username · leave blank to keep" : "Optional");
      this.byId("camera-password").placeholder = this.t(editing && this.original.hasPassword ? "Saved password · leave blank to keep" : "Optional");
      for (const name of streamNames) {
        const enabled = this.enabled(name), full = this.byId("camera-" + name + "-mode").value === "url";
        this.byId("camera-" + name + "-mode").disabled = !enabled;
        this.byId("camera-" + name + "-path-row").hidden = !enabled || full;
        this.byId("camera-" + name + "-url-row").hidden = !enabled || !full;
        this.byId("camera-" + name + "-override-note").hidden = !enabled || !full;
        const path = this.byId("camera-" + name + "-path"), url = this.byId(sourceIds[name]);
        path.disabled = !enabled || full; url.disabled = !enabled || !full;
        path.required = url.required = false;
        path.placeholder = editing && this.original.configured[name] ? this.t("Saved path and query · leave blank to keep") : "/stream" + (streamNames.indexOf(name) + 1);
        url.placeholder = editing && this.original.configured[name] ? this.t("Saved stream · leave blank to keep") : "rtsp://192.168.1.50:554/stream" + (streamNames.indexOf(name) + 1);
        this.byId("camera-" + name + "-override-note").textContent = this.t(this.original.independent[name] && !url.value.trim() ? "This saved stream uses a separate connection. Leave its URL blank to keep it." : "A full URL takes precedence over the shared connection fields for this stream.");
      }
      const thirdField = this.byId("camera-third-mode").value === "url" ? "camera-third-url" : "camera-third-path";
      const thirdReady = this.enabled("third") && (this.original.configured.third || !!this.byId(thirdField).value.trim());
      this.byId("camera-live-third-option").disabled = !thirdReady;
      if (!thirdReady && this.byId("camera-live-stream").value === "3") this.byId("camera-live-stream").value = "2";
      this.byId("camera-probe-controls").hidden = !editing;
      for (const name of streamNames) this.byId("camera-probe-" + name + "-option").disabled = !this.original.configured[name];
    }
    relabel() { this.render(); }
    reset() { return this.setCamera(null); }
    destroy() { for (const dispose of this.listeners) dispose(); this.listeners = []; this.reset(); }
  }
  global.NvrCameraEditor = NvrCameraEditor;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrCameraEditor, parseSource, pathValue};
})(typeof window !== "undefined" ? window : globalThis);
