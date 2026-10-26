"use strict";

(() => {
  const STORAGE_KEY = "nvr.live.layout.v1";
  const SIZES = [1, 4, 9, 16];
  const clone = (value) => ({version: 1, size: value.size, slots: [...value.slots]});
  const cameraList = (cameras) => {
    const seen = new Set();
    return (Array.isArray(cameras) ? cameras : []).filter((camera) => {
      if (!camera || typeof camera.id !== "string" || !camera.id || camera.id.length > 128 || seen.has(camera.id)) return false;
      seen.add(camera.id); return true;
    });
  };
  function normalizeLayout(value, cameras) {
    if (!value || value.version !== 1 || !SIZES.includes(value.size) || !Array.isArray(value.slots) || value.slots.length > 16) return null;
    const known = new Set(cameraList(cameras).map((camera) => camera.id)), seen = new Set();
    const slots = Array.from({length: 16}, (_, index) => {
      const id = value.slots[index];
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) return null;
      seen.add(id); return id;
    });
    return {version: 1, size: value.size, slots};
  }
  function defaultLayout(cameras, legacySize) {
    const ids = cameraList(cameras).map((camera) => camera.id).slice(0, 16);
    const size = SIZES.includes(legacySize) ? legacySize : SIZES.find((count) => count >= ids.length) || 16;
    return {version: 1, size, slots: Array.from({length: 16}, (_, index) => ids[index] || null)};
  }

  class LiveLayoutModel {
    constructor(cameras = [], storage = null) {
      this.cameras = cameraList(cameras);
      this.storage = storage;
      this.storageKey = typeof window !== "undefined" && window.NvrAccess ? window.NvrAccess.storageKey(STORAGE_KEY) : STORAGE_KEY;
      this.legacyKey = typeof window !== "undefined" && window.NvrAccess ? window.NvrAccess.storageKey("nvr.monitor.layout") : "nvr.monitor.layout";
      this.readWarning = false;
      let saved = null, legacy = null;
      try {
        const text = storage?.getItem(this.storageKey);
        if (text) {
          saved = normalizeLayout(JSON.parse(text), this.cameras);
          if (!saved) this.readWarning = true;
        }
        legacy = Number(storage?.getItem(this.legacyKey));
      } catch (_) { this.readWarning = true; }
      this.saved = saved || defaultLayout(this.cameras, legacy);
      this.draft = clone(this.saved);
    }
    getSaved() { return clone(this.saved); }
    getDraft() { return clone(this.draft); }
    get dirty() { return JSON.stringify(this.saved) !== JSON.stringify(this.draft); }
    get hiddenCount() { return this.draft.slots.slice(this.draft.size).filter(Boolean).length; }
    setCameras(cameras) {
      this.cameras = cameraList(cameras);
      this.saved = normalizeLayout(this.saved, this.cameras);
      this.draft = normalizeLayout(this.draft, this.cameras);
    }
    setSize(size) {
      if (!SIZES.includes(size)) throw Error("Choose a valid live layout.");
      this.draft.size = size;
    }
    assign(index, cameraId) {
      if (!Number.isInteger(index) || index < 0 || index >= this.draft.size) throw Error("Choose a valid layout tile.");
      if (cameraId === null || cameraId === "") { this.draft.slots[index] = null; return; }
      if (!this.cameras.some((camera) => camera.id === cameraId)) throw Error("Camera unavailable.");
      const previous = this.draft.slots.indexOf(cameraId);
      if (previous === index) return;
      if (previous >= 0) this.draft.slots[previous] = this.draft.slots[index];
      this.draft.slots[index] = cameraId;
    }
    swap(first, second) {
      if (![first, second].every((index) => Number.isInteger(index) && index >= 0 && index < this.draft.size)) throw Error("Choose a valid layout tile.");
      [this.draft.slots[first], this.draft.slots[second]] = [this.draft.slots[second], this.draft.slots[first]];
    }
    reset() { this.draft = clone(this.saved); }
    _persist(value) {
      const validated = normalizeLayout(value, this.cameras);
      if (!validated) throw Error("Choose a valid live layout.");
      try {
        if (!this.storage) throw Error("Storage unavailable");
        this.storage.setItem(this.storageKey, JSON.stringify(validated));
      } catch (_) { throw Error("The layout could not be saved in this browser. Check browser storage permissions and try again."); }
      this.saved = validated;
      this.readWarning = false;
      return this.getSaved();
    }
    save() {
      const saved = this._persist(this.draft);
      this.draft = clone(saved);
      return saved;
    }
    applySize(size) {
      if (!SIZES.includes(size)) throw Error("Choose a valid live layout.");
      const saved = this._persist({...this.saved, size});
      this.draft.size = size;
      return saved;
    }
  }

  class NvrLiveLayout {
    constructor({root, cameras = [], t = (key) => key, onSave = () => {}, onError = () => {}, storage} = {}) {
      if (!root) throw Error("Live layout editor unavailable.");
      this.root = root; this.t = t; this.onSave = onSave; this.onError = onError;
      if (storage === undefined) {
        try { storage = window.localStorage; } catch (_) { storage = null; }
      }
      this.model = new LiveLayoutModel(cameras, storage);
      this.selectedCamera = null; this.notice = null; this.visible = false; this.destroyed = false;
      this.listeners = []; this.thumbnails = new Map(); this.images = new Map();
      this.previewQueue = []; this.previewActive = 0; this.previewEpoch = 0; this.previewControllers = new Map();
      this.grid = root.querySelector("#layout-grid");
      this.list = root.querySelector("#layout-camera-list");
      this.size = root.querySelector("#layout-grid-size");
      this.status = root.querySelector("#layout-status");
      this.resetButton = root.querySelector("#layout-reset");
      this.saveButton = root.querySelector("#layout-save");
      if (!this.grid || !this.list || !this.size || !this.status || !this.resetButton || !this.saveButton) throw Error("Live layout editor unavailable.");
      this._listen(this.size, "change", () => this._edit(() => this.model.setSize(Number(this.size.value))));
      root.querySelectorAll("[data-layout-preset]").forEach((button) => this._listen(button, "click", () => this._edit(() => this.model.setSize(Number(button.dataset.layoutPreset)))));
      this._listen(this.resetButton, "click", () => { this.model.reset(); this.notice = "Draft reset to the saved layout."; this.selectedCamera = null; this.render(); });
      this._listen(this.saveButton, "click", () => this.save());
    }
    _listen(node, name, callback) { node.addEventListener(name, callback); this.listeners.push(() => node.removeEventListener(name, callback)); }
    _element(tag, className, text) {
      const node = this.root.ownerDocument.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    _error(error) { this.notice = error.message; this.render(); this.onError(error); }
    _edit(action) {
      if (this.destroyed) return;
      try { action(); this.notice = null; this.render(); } catch (error) { this._error(error); }
    }
    getSaved() { return this.model.getSaved(); }
    setCameras(cameras) {
      const signature = (items) => JSON.stringify(items.map((camera) => [camera.id, camera.name, camera.source, camera.preview_source]));
      const before = signature(this.model.cameras);
      this.model.setCameras(cameras);
      if (!this.model.cameras.some((camera) => camera.id === this.selectedCamera)) this.selectedCamera = null;
      const known = new Set(this.model.cameras.map((camera) => camera.id));
      this.thumbnails.forEach((value, id) => {
        if (!known.has(id)) {
          if (value.url) URL.revokeObjectURL(value.url);
          this.thumbnails.delete(id); this.previewControllers.get(id)?.abort();
        }
      });
      if (this.visible && before !== signature(this.model.cameras)) this.render();
    }
    open() { if (this.destroyed) return; this.visible = true; this.render(); }
    close() {
      this.visible = false; this.previewEpoch++; this.previewQueue = []; this.previewActive = 0;
      this.previewControllers.forEach((controller) => controller.abort()); this.previewControllers.clear();
      this.thumbnails.forEach((value) => { if (value.url) URL.revokeObjectURL(value.url); });
      this.thumbnails.clear();
      this.images.forEach((nodes) => nodes.forEach((node) => node.removeAttribute("src")));
      this.images.clear();
    }
    destroy() { this.close(); this.destroyed = true; this.listeners.forEach((remove) => remove()); this.listeners = []; }
    relabel() { if (this.visible) this.render(); }
    save() {
      try {
        const saved = this.model.save(); this.notice = "Layout saved in this browser."; this.render(); this.onSave(saved); return true;
      } catch (error) { this._error(error); return false; }
    }
    applySize(size) {
      try {
        const saved = this.model.applySize(size); this.notice = "Layout saved in this browser.";
        if (this.visible) this.render(); this.onSave(saved); return true;
      } catch (error) { this._error(error); return false; }
    }
    render() {
      if (this.destroyed) return;
      const draft = this.model.getDraft(), byId = new Map(this.model.cameras.map((camera) => [camera.id, camera]));
      this.size.value = String(draft.size);
      this.root.querySelectorAll("[data-layout-preset]").forEach((button) => {
        const active = Number(button.dataset.layoutPreset) === draft.size;
        button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
      });
      this.grid.className = `layout-grid layout-${draft.size}`; this.grid.dataset.layout = String(draft.size);
      this.images.clear();
      const tiles = [];
      for (let index = 0; index < draft.size; index++) {
        const camera = byId.get(draft.slots[index]);
        const tile = this._element("article", "layout-tile"); tile.dataset.slot = String(index); tile.tabIndex = 0;
        tile.setAttribute("aria-label", this.t("Tile {number}: {camera}", {number: index + 1, camera: camera ? String(camera.name) : this.t("Empty tile")}));
        const heading = this._element("div", "layout-tile-heading");
        heading.append(this._element("span", "layout-tile-label", this.t("Tile {number}", {number: index + 1})));
        const remove = this._element("button", "layout-remove", this.t("Remove")); remove.type = "button"; remove.disabled = !camera;
        remove.setAttribute("aria-label", this.t("Remove camera from tile {number}", {number: index + 1}));
        remove.addEventListener("click", () => { this._edit(() => this.model.assign(index, null)); this._focusTile(index); }); heading.append(remove);
        const preview = this._element("div", "layout-tile-preview");
        if (camera) {
          const image = this._element("img", "layout-thumbnail"); image.alt = String(camera.name); image.draggable = false;
          const unavailable = this._element("span", "layout-preview-unavailable", this.t("Preview unavailable."));
          image.addEventListener("load", () => { unavailable.hidden = true; });
          image.addEventListener("error", () => { unavailable.hidden = false; image.removeAttribute("src"); });
          if (!this.images.has(camera.id)) this.images.set(camera.id, new Set());
          this.images.get(camera.id).add(image); preview.append(image, unavailable);
          const thumbnail = this.thumbnails.get(camera.id);
          if (thumbnail?.url) image.src = thumbnail.url;
          else if (this.visible) this._queuePreview(camera.id);
          preview.append(this._element("span", "layout-preview-name", String(camera.name)));
        } else preview.append(this._element("span", "layout-tile-empty", this.t("Drop a camera here or choose one below.")));
        const select = this._element("select", "layout-camera-select");
        select.setAttribute("aria-label", this.t("Camera for tile {number}", {number: index + 1}));
        const empty = this._element("option", "", this.t("Empty tile")); empty.value = ""; select.append(empty);
        this.model.cameras.forEach((available) => {
          const option = this._element("option", "", String(available.name)); option.value = available.id; select.append(option);
        });
        select.value = camera?.id || "";
        select.addEventListener("change", () => { this._edit(() => this.model.assign(index, select.value)); this._focusTile(index); });
        tile.append(heading, preview, select); tile.draggable = !!camera;
        tile.addEventListener("dragstart", (event) => {
          if (!camera || !event.dataTransfer || ["SELECT", "BUTTON", "OPTION"].includes(event.target.tagName)) { event.preventDefault(); return; }
          event.dataTransfer.setData("application/x-nvr-layout", JSON.stringify({slot: index})); event.dataTransfer.effectAllowed = "move";
        });
        tile.addEventListener("dragover", (event) => { if (event.dataTransfer) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } });
        tile.addEventListener("drop", (event) => {
          event.preventDefault();
          try {
            const data = JSON.parse(event.dataTransfer?.getData("application/x-nvr-layout") || "null");
            if (!data || typeof data !== "object") return;
            if (Number.isInteger(data.slot)) this._edit(() => this.model.swap(data.slot, index));
            else if (typeof data.cameraId === "string") this._edit(() => this.model.assign(index, data.cameraId));
          } catch (_) { /* Ignore unrelated or malformed drag payloads. */ }
        });
        const assignSelected = (event) => {
          if (["SELECT", "BUTTON", "OPTION"].includes(event.target.tagName) || !this.selectedCamera) return;
          this._edit(() => this.model.assign(index, this.selectedCamera));
          this.grid.children[index]?.focus?.();
        };
        tile.addEventListener("click", assignSelected);
        tile.addEventListener("keydown", (event) => {
          if ((event.key === "Enter" || event.key === " ") && event.target === tile) { event.preventDefault(); assignSelected(event); }
        });
        tiles.push(tile);
      }
      this.grid.replaceChildren(...tiles);
      const cameras = this.model.cameras.map((camera) => {
        const position = draft.slots.indexOf(camera.id), button = this._element("button", "layout-camera");
        button.type = "button"; button.dataset.cameraId = camera.id; button.draggable = true;
        button.classList.toggle("is-assigned", position >= 0); button.classList.toggle("is-selected", camera.id === this.selectedCamera);
        button.setAttribute("aria-pressed", String(camera.id === this.selectedCamera));
        button.append(this._element("span", "layout-camera-name", String(camera.name)), this._element("span", "layout-camera-position",
          position >= 0 ? this.t("Tile {number}", {number: position + 1}) : this.t("Not assigned")));
        button.addEventListener("click", () => {
          this.selectedCamera = camera.id === this.selectedCamera ? null : camera.id; this.notice = null; this.render();
          Array.from(this.list.children).find((node) => node.dataset.cameraId === camera.id)?.focus?.();
        });
        button.addEventListener("dragstart", (event) => {
          if (!event.dataTransfer) return;
          event.dataTransfer.setData("application/x-nvr-layout", JSON.stringify({cameraId: camera.id})); event.dataTransfer.effectAllowed = "move";
        });
        return button;
      });
      this.list.replaceChildren(...(cameras.length ? cameras : [this._element("p", "small muted", this.t("No cameras configured. Add a camera before editing the layout."))]));
      this.resetButton.disabled = !this.model.dirty;
      this.saveButton.disabled = false;
      let message = this.notice ? this.t(this.notice) : this.model.readWarning ? this.t("Saved layout could not be read. Review the layout and save it again.")
        : this.model.dirty ? this.t("Unsaved layout changes.") : this.t("The saved layout is used by the live monitor.");
      if (this.selectedCamera) message += " " + this.t("Choose a tile for {camera}.", {camera: String(byId.get(this.selectedCamera)?.name || "")});
      if (this.model.hiddenCount) message += " " + this.t("{count} assignments are kept outside this grid. Increase the grid size to show them.", {count: this.model.hiddenCount});
      this.status.textContent = message;
      this._pumpPreviews();
    }
    _focusTile(index) {
      Array.from(this.grid.children[index]?.children || []).find((node) => node.tagName === "SELECT")?.focus?.();
    }
    _queuePreview(cameraId) {
      if (this.thumbnails.has(cameraId)) return;
      this.thumbnails.set(cameraId, {}); this.previewQueue.push(cameraId);
    }
    _pumpPreviews() {
      if (!this.visible || this.destroyed || typeof fetch !== "function" || typeof URL.createObjectURL !== "function") return;
      while (this.previewActive < 2 && this.previewQueue.length) {
        const id = this.previewQueue.shift();
        if (!this.images.has(id)) { this.thumbnails.delete(id); continue; }
        const epoch = this.previewEpoch, controller = new AbortController();
        this.previewActive++; this.previewControllers.set(id, controller);
        (async () => {
          try {
            const response = await fetch(`/api/cameras/${encodeURIComponent(id)}/snapshot`, {credentials: "same-origin", cache: "no-store", signal: controller.signal});
            if (!response.ok || Number(response.headers.get("Content-Length")) > 2 * 1024 * 1024) return;
            const blob = await response.blob();
            if (blob.size > 2 * 1024 * 1024 || !blob.type.startsWith("image/") || epoch !== this.previewEpoch || !this.visible
                || !this.model.cameras.some((camera) => camera.id === id)) return;
            const url = URL.createObjectURL(blob); this.thumbnails.set(id, {url});
            this.images.get(id)?.forEach((image) => { image.src = url; });
          } catch (_) { /* A snapshot failure never prevents assigning a camera. */ }
          finally {
            if (epoch === this.previewEpoch) { this.previewActive--; this.previewControllers.delete(id); this._pumpPreviews(); }
          }
        })();
      }
    }
  }
  NvrLiveLayout.Model = LiveLayoutModel;
  NvrLiveLayout.STORAGE_KEY = STORAGE_KEY;
  NvrLiveLayout.normalizeLayout = normalizeLayout;
  if (typeof window !== "undefined") window.NvrLiveLayout = NvrLiveLayout;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrLiveLayout, LiveLayoutModel, normalizeLayout, defaultLayout, STORAGE_KEY};
})();
