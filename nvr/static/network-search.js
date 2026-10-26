"use strict";

((global) => {
  const METHODS = {local: ["onvif", "mdns"], targets: ["onvif", "rtsp", "rtsps"]};
  const DEFAULTS = {local: ["onvif", "mdns"], targets: ["onvif", "rtsp"]};
  const control = (value) => /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
  function ipv4(value) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) ? parts.map(Number) : null;
  }
  function validateTarget(value) {
    if (typeof value !== "string" || !value || value.length > 253 || control(value) || /[\s@?#\\]/.test(value) || value.includes("://")) throw Error("Enter an IP address, hostname or private IPv4 network, without a URL or credentials.");
    const parts = value.split("/");
    if (parts.length > 2) throw Error("Enter a valid search target.");
    const host = parts[0], address = ipv4(host);
    if (address) {
      if (address[0] === 0 || address[0] === 127 || address[0] >= 224 || host === "169.254.169.254") throw Error("Loopback, multicast and reserved addresses cannot be searched.");
      if (parts.length === 2) {
        const prefix = /^\d{1,2}$/.test(parts[1]) ? Number(parts[1]) : -1;
        const local = address[0] === 10 || address[0] === 172 && address[1] >= 16 && address[1] <= 31 || address[0] === 192 && address[1] === 168 || address[0] === 100 && address[1] >= 64 && address[1] <= 127 || address[0] === 169 && address[1] === 254;
        if (prefix < 24 || prefix > 32 || !local && prefix !== 32) throw Error("Use private, link-local or CGNAT IPv4 networks from /24 to /32. Public addresses must be single hosts.");
      }
      return value;
    }
    if (host.includes(":")) {
      const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      try {
        const canonical = new URL("http://[" + bare + "]").hostname.toLowerCase();
        if (["[::]", "[::1]"].includes(canonical) || /^\[ff/i.test(canonical) || parts.length === 2 && parts[1] !== "128") throw Error();
      } catch (_) { throw Error("Use a single valid IPv6 address, without a port or IPv6 network range."); }
      return value;
    }
    if (parts.length !== 1 || /^[\d.]+$/.test(host)) throw Error("Enter a valid search target.");
    try {
      const hostname = new URL("http://" + host).hostname.replace(/\.$/, "");
      if (!hostname || hostname.length > 253 || hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw Error();
    } catch (_) { throw Error("Enter a valid hostname without a port."); }
    return value;
  }
  function parseTargets(value) {
    const targets = String(value || "").split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean);
    if (!targets.length || targets.length > 16) throw Error("Enter 1 to 16 targets, separated by commas or new lines.");
    targets.forEach(validateTarget);
    return [...new Set(targets)];
  }
  function ports(value) {
    const parts = String(value || "").split(/[\s,]+/).filter(Boolean);
    if (!parts.length || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 1 || Number(part) > 65535)) throw Error("Enter valid ports from 1 to 65535.");
    const result = [...new Set(parts.map(Number))];
    if (result.length > 8) throw Error("Use at most 8 ports per protocol.");
    return result;
  }
  class NvrNetworkSearch {
    constructor({api, t = (key) => key, isAuthenticated = () => false, onUseTarget, onSearch} = {}) {
      if (typeof api !== "function") throw Error("Network search is unavailable.");
      Object.assign(this, {api, t, isAuthenticated, onUseTarget, onSearch}); this.document = global.document;
      this.root = this.node("network-view"); this.busy = false; this.active = false; this.targets = []; this.maxTargets = 32; this.selected = new Set();
      this.authEpoch = 0; this.readEpoch = 0; this.writeEpoch = 0; this.readController = null; this.writeController = null; this.reading = false; this.writing = false;
      this.modeMethods = {local: new Set(DEFAULTS.local), targets: new Set(DEFAULTS.targets)}; this._mode = "local"; this.progressData = null; this.error = null; this.notice = null;
      this.listeners = [];
      this.listen(this.node("network-search-mode"), "change", () => this.setMode(this.node("network-search-mode").value));
      for (const name of ["onvif", "rtsp", "rtsps", "mdns"]) this.listen(this.node("network-method-" + name), "change", () => { this.modeMethods[this._mode][this.node("network-method-" + name).checked ? "add" : "delete"](name); });
      this.listen(this.node("network-target-save-form"), "submit", (event) => { event.preventDefault(); return this.saveTarget(); });
      this.listen(this.node("network-target-use"), "click", () => this.useSelected());
      this.listen(this.node("network-target-refresh"), "click", () => this.open());
      if (typeof onSearch === "function") {
        const search = (event) => { event.preventDefault(); if (this.busy || !this.allowed()) return; try { return onSearch(this.readForm()); } catch (error) { this.error = {key: error.message}; this.render(); } };
        this.listen(this.node("network-discover"), "click", search); this.listen(this.node("network-scan-form"), "submit", search);
      }
      this.listen(this.node("network-manual-kind"), "change", () => this.renderManual());
      this.listen(global, "nvr-languagechange", () => this.relabel());
      this.listen(global, "nvr-authchange", () => this.resetSession());
      this.listen(global, "nvr-accesschange", () => { if (!this.allowed()) this.resetSession(); else this.render(); });
      this.setMode("local");
    }
    node(id) { return this.document.getElementById(id); }
    listen(node, event, listener) { node?.addEventListener(event, listener); this.listeners.push(() => node?.removeEventListener?.(event, listener)); }
    allowed() { try { return this.isAuthenticated() === true && global.NvrAccess?.can("network") === true; } catch (_) { return false; } }
    visible() { return this.active && this.root?.hidden === false; }
    get mode() { return this._mode; }
    setMode(mode) {
      if (!["local", "targets"].includes(mode)) throw Error("Choose a valid search mode.");
      this._mode = mode; this.node("network-search-mode").value = mode;
      for (const name of ["onvif", "rtsp", "rtsps", "mdns"]) this.node("network-method-" + name).checked = this.modeMethods[mode].has(name);
      this.render();
    }
    readForm() {
      const methods = METHODS[this._mode].filter((name) => this.node("network-method-" + name).checked);
      if (!methods.length) throw Error("Select at least one search method.");
      const local = this._mode === "local";
      return {mode: this._mode, interface_ip: local ? this.node("network-interface").value || null : null,
        targets: local ? [] : parseTargets(this.node("network-cidr").value), methods,
        onvif_ports: !local && methods.includes("onvif") ? ports(this.node("network-ports").value) : [],
        rtsp_ports: !local && methods.includes("rtsp") ? ports(this.node("network-rtsp-ports").value) : [],
        rtsps_ports: !local && methods.includes("rtsps") ? ports(this.node("network-rtsps-ports").value) : [], timeout: .75};
    }
    setBusy(value) { if (value && !this.busy) this.progressData = null; this.busy = !!value; this.render(); }
    progress(value) { this.progressData = value && typeof value === "object" ? value : null; this.renderProgress(); }
    renderProgress() {
      const data = this.progressData; this.node("network-progress").hidden = !this.busy && !data;
      const parts = [];
      if (data?.partial === true) parts.push(this.t("Partial results"));
      const counts = Number.isInteger(data?.completed) && data.completed >= 0 && Number.isInteger(data?.total) && data.total > 0 && data.completed <= data.total;
      if (data?.state === "cancelled") parts.push(this.t("Search cancelled."));
      if (counts) parts.push(this.t("{completed} / {total} checked", {completed: data.completed, total: data.total}));
      else if (data?.state !== "cancelled") parts.push(this.t(this.busy ? "Searching…" : "Search complete"));
      if (typeof data?.duration === "number" && Number.isFinite(data.duration) && data.duration >= 0) parts.push(this.t("{seconds} s", {seconds: Math.floor(data.duration)}));
      this.node("network-progress-label").textContent = parts.join(" · ");
    }
    renderManual() {
      this.node("network-manual-endpoint").placeholder = this.node("network-manual-kind").value === "stream" ? "rtsp://192.168.1.50:554/known-path" : "http://192.168.1.50:8000/onvif/device_service";
    }
    render() {
      const locked = this.busy || this.writing, local = this._mode === "local";
      this.node("network-local-controls").hidden = !local; this.node("network-target-controls").hidden = local;
      for (const id of ["network-search-mode", "network-interface", "network-cidr", "network-ports", "network-rtsp-ports", "network-rtsps-ports", "network-discover", "network-scan", "network-target-name", "network-target-address", "network-target-save"]) this.node(id).disabled = locked || !this.allowed();
      this.node("network-interface").disabled ||= !local;
      for (const id of ["network-cidr", "network-ports", "network-rtsp-ports", "network-rtsps-ports"]) this.node(id).disabled ||= local;
      this.node("network-discover").disabled ||= !this.allowed(); this.node("network-cancel").hidden = !this.busy;
      this.node("network-target-save").disabled ||= this.targets.length >= this.maxTargets;
      this.node("network-target-refresh").disabled = locked || this.reading || !this.allowed();
      this.node("network-target-use").disabled = locked || !this.selected.size || !this.allowed();
      for (const name of ["onvif", "rtsp", "rtsps", "mdns"]) {
        const input = this.node("network-method-" + name), available = METHODS[this._mode].includes(name);
        input.disabled = locked || !available || !this.allowed(); input.closest?.("[data-network-method]")?.toggleAttribute("hidden", !available);
      }
      this.node("network-targets-status").textContent = this.t(this.writing ? "Saving targets…" : this.reading ? "Loading saved targets…" : "");
      this.node("network-targets-error").hidden = !this.error; this.node("network-targets-error").textContent = this.error ? this.t(this.error.key, this.error.params) : "";
      this.node("network-targets-notice").hidden = !this.notice; this.node("network-targets-notice").textContent = this.notice ? this.t(this.notice.key, this.notice.params) : "";
      this.renderTargets(); this.renderProgress(); this.renderManual();
    }
    updateTargets(value) {
      if (!value || !Array.isArray(value.targets) || !Number.isInteger(value.max_targets) || value.max_targets < 1 || value.max_targets > 32 || value.targets.length > value.max_targets
          || value.targets.some((item) => !item || typeof item.id !== "string" || !item.id || item.id.length > 128 || typeof item.name !== "string" || !item.name || item.name.length > 60 || typeof item.address !== "string" || !item.address || item.address.length > 253)) throw Error("Saved targets are unavailable. Try again.");
      this.targets = value.targets.map((item) => ({id: item.id, name: item.name, address: item.address})); this.maxTargets = value.max_targets;
      const ids = new Set(this.targets.map((item) => item.id)); this.selected = new Set([...this.selected].filter((id) => ids.has(id))); this.render();
    }
    renderTargets() {
      const list = this.node("network-target-list"); list.replaceChildren();
      if (!this.targets.length) { const empty = this.document.createElement("p"); empty.className = "field-help"; empty.textContent = this.t("No saved targets."); list.append(empty); }
      for (const target of this.targets) {
        const row = this.document.createElement("div"), label = this.document.createElement("label"), check = this.document.createElement("input"), copy = this.document.createElement("span"), name = this.document.createElement("strong"), address = this.document.createElement("small"), remove = this.document.createElement("button");
        row.className = "network-target-row"; label.className = "check-label"; check.type = "checkbox"; check.checked = this.selected.has(target.id); check.disabled = this.busy || this.writing || !this.allowed();
        check.addEventListener("change", () => { if (this.busy || this.writing || !this.allowed()) return; if (check.checked) this.selected.add(target.id); else this.selected.delete(target.id); this.node("network-target-use").disabled = !this.selected.size; });
        name.textContent = target.name; address.textContent = target.address; copy.append(name, address); label.append(check, copy);
        remove.type = "button"; remove.className = "button quiet small-button"; remove.textContent = this.t("Remove"); remove.disabled = this.busy || this.writing || !this.allowed(); remove.addEventListener("click", () => this.removeTarget(target.id)); row.append(label, remove); list.append(row);
      }
    }
    useSelected() {
      if (!this.allowed() || !this.visible() || this.busy || this.writing) return;
      const values = [...new Set(this.targets.filter((item) => this.selected.has(item.id)).map((item) => item.address))];
      if (!values.length || values.length > 16) { this.error = {key: "Choose 1 to 16 saved targets."}; this.render(); return; }
      this.node("network-cidr").value = values.join("\n"); this.setMode("targets"); this.onUseTarget?.([...values]);
    }
    async open() {
      this.active = this.root?.hidden === false; this.render(); if (!this.allowed() || !this.active || this.writing) return;
      this.readController?.abort(); const current = new AbortController(), auth = this.authEpoch, request = ++this.readEpoch; this.readController = current; this.reading = true; this.error = null; this.render();
      try { const value = await this.api("/api/network/targets", {signal: current.signal}); if (this.active && this.allowed() && auth === this.authEpoch && request === this.readEpoch) this.updateTargets(value); }
      catch (error) { if (this.active && this.allowed() && auth === this.authEpoch && request === this.readEpoch && error?.name !== "AbortError") this.error = {key: error?.message || "Saved targets are unavailable. Try again.", params: error?.i18nParams}; }
      finally { if (auth === this.authEpoch && request === this.readEpoch) { this.readController = null; this.reading = false; this.render(); } }
    }
    async saveTarget() {
      if (!this.allowed() || !this.visible() || this.busy || this.writing || this.targets.length >= this.maxTargets) return;
      const name = this.node("network-target-name").value.trim(), address = this.node("network-target-address").value.trim();
      try {
        if (!name || name.length > 60 || control(name)) throw Error("Enter a target name of up to 60 characters.");
        if (/[\r\n,]/.test(address)) throw Error("Save one address or network per target.");
        validateTarget(address);
      } catch (error) { this.error = {key: error.message}; this.render(); return; }
      return this.write("/api/network/targets", {method: "POST", body: {name, address}}, true);
    }
    removeTarget(id) { if (!this.allowed() || !this.visible() || this.busy || this.writing) return; return this.write("/api/network/targets/" + encodeURIComponent(id), {method: "DELETE"}); }
    async write(path, options, reset = false) {
      const auth = this.authEpoch, request = ++this.writeEpoch, current = new AbortController(); this.writeController = current; this.writing = true; this.error = this.notice = null;
      this.readEpoch += 1; this.readController?.abort(); this.readController = null; this.reading = false; this.render();
      try {
        const value = await this.api(path, {...options, signal: current.signal});
        if (!this.allowed() || auth !== this.authEpoch || request !== this.writeEpoch) return;
        this.updateTargets(value); if (reset) { this.node("network-target-name").value = ""; this.node("network-target-address").value = ""; }
        this.notice = {key: reset ? "Target saved." : "Target removed."};
      } catch (error) { if (this.allowed() && auth === this.authEpoch && request === this.writeEpoch) this.error = {key: error?.message || "Unable to save targets. Try again.", params: error?.i18nParams}; }
      finally { if (auth === this.authEpoch && request === this.writeEpoch) { this.writeController = null; this.writing = false; this.render(); } }
    }
    close() { this.active = false; this.readEpoch += 1; this.readController?.abort(); this.readController = null; this.reading = false; }
    resetSession() {
      this.authEpoch += 1; this.close(); this.writeEpoch += 1; this.writeController?.abort(); this.writeController = null;
      this.targets = []; this.selected.clear(); this.writing = this.busy = false; this.progressData = this.error = this.notice = null;
      for (const id of ["network-target-name", "network-target-address", "network-cidr"]) this.node(id).value = "";
      this.render();
    }
    relabel() { this.render(); }
    destroy() { this.resetSession(); this.listeners.forEach((remove) => remove()); this.listeners = []; }
  }
  global.NvrNetworkSearch = NvrNetworkSearch;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrNetworkSearch, parseTargets, validateTarget, ports};
})(typeof window !== "undefined" ? window : globalThis);
