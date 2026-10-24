"use strict";

// Recorded image-change events, independent of video/audio loading and playback.
((root) => {
  const sensitivityValues = new Set(["low", "medium", "high"]);

  function normalizeEvents(events, duration) {
    return events.filter((event) => event && Number.isFinite(event.start) && Number.isFinite(event.end))
      .map((event) => ({start: Math.max(0, Math.min(duration, event.start)), end: Math.max(0, Math.min(duration, event.end)), score: Math.max(0, Math.min(1, Number(event.score) || 0))}))
      .filter((event) => event.end > event.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function offsetLabel(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(seconds / 60), tail = String(seconds % 60).padStart(2, "0");
    return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
  }

  class MotionTrack {
    constructor(options) {
      this.elements = options.elements;
      this.document = options.document || this.elements.track.ownerDocument;
      this.request = options.request;
      this.translate = options.t || ((key) => key);
      this.seek = options.seek;
      this.epoch = 0;
      this.controller = null;
      this.recording = null;
      this.events = [];
      this.markers = [];
      this.duration = 0;
      this.time = 0;
      this.activeIndex = -1;
      this.phase = "idle";
      this.error = null;
      this.sensitivity = "medium";
      this.elements.sensitivity.value = this.sensitivity;
      this.handlers = {
        sensitivity: () => {
          const value = this.elements.sensitivity.value;
          this.sensitivity = sensitivityValues.has(value) ? value : "medium";
          this.elements.sensitivity.value = this.sensitivity;
          if (this.recording) this.load();
        },
        previous: () => this.go(this.previousIndex()),
        next: () => this.go(this.nextIndex()),
        retry: () => { if (this.recording && this.phase !== "loading") this.load(); },
        click: (event) => {
          if (!this.recording || !this.duration || event.target?.dataset?.motionIndex !== undefined) return;
          const rectangle = this.elements.track.getBoundingClientRect();
          if (rectangle.width > 0) this.jump(Math.max(0, Math.min(1, (event.clientX - rectangle.left) / rectangle.width)) * this.duration);
        },
        keydown: (event) => {
          if (!this.recording || !this.events.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          this.go(event.key === "Home" ? 0 : event.key === "End" ? this.events.length - 1 : event.key === "ArrowLeft" ? this.previousIndex() : this.nextIndex());
        },
      };
      this.elements.sensitivity.addEventListener("change", this.handlers.sensitivity);
      this.elements.previous.addEventListener("click", this.handlers.previous);
      this.elements.next.addEventListener("click", this.handlers.next);
      this.elements.retry.addEventListener("click", this.handlers.retry);
      this.elements.track.addEventListener("click", this.handlers.click);
      this.elements.track.addEventListener("keydown", this.handlers.keydown);
      this.render();
    }

    select(recording) {
      if (!recording?.id) { this.clear(); return Promise.resolve(); }
      if (this.recording?.id === recording.id) return Promise.resolve();
      this.recording = {id: recording.id, duration: Number(recording.duration) || 0};
      this.time = 0;
      return this.load();
    }

    clear() {
      this.epoch += 1;
      this.controller?.abort(); this.controller = null;
      this.recording = null; this.events = []; this.duration = this.time = 0;
      this.phase = "idle"; this.error = null;
      this.render();
    }

    async load() {
      if (!this.recording) return;
      this.controller?.abort();
      const controller = new AbortController(), epoch = ++this.epoch;
      const recordingId = this.recording.id, sensitivity = this.sensitivity;
      this.controller = controller;
      this.events = []; this.duration = this.recording.duration; this.phase = "loading"; this.error = null;
      this.render();
      try {
        const result = await this.request(recordingId, sensitivity, controller.signal);
        if (epoch !== this.epoch || this.recording?.id !== recordingId || sensitivity !== this.sensitivity) return;
        if (!result || !Number.isFinite(result.duration) || result.duration <= 0 || !Array.isArray(result.events) || (result.sensitivity && result.sensitivity !== sensitivity)) throw new Error("Motion analysis unavailable.");
        this.duration = result.duration;
        this.events = normalizeEvents(result.events, this.duration);
        this.phase = "ready";
        this.render();
      } catch (error) {
        if (epoch !== this.epoch || error.name === "AbortError") return;
        this.phase = "error";
        this.error = {key: error.message || "Motion analysis unavailable.", params: error.i18nParams};
        this.render();
      } finally { if (epoch === this.epoch) this.controller = null; }
    }

    jump(offset) {
      if (!this.recording || !Number.isFinite(offset)) return;
      const time = Math.max(0, Math.min(offset, Math.max(0, this.duration - .05)));
      this.seek(time);
      this.setTime(time);
    }

    go(index) { if (this.phase === "ready" && index >= 0 && index < this.events.length) this.jump(this.events[index].start); }
    previousIndex() { for (let index = this.events.length - 1; index >= 0; index -= 1) if (this.events[index].start < this.time - .05) return index; return -1; }
    nextIndex() { return this.events.findIndex((event) => event.start > this.time + .05); }

    setTime(time) {
      this.time = Math.max(0, Math.min(Number(time) || 0, this.duration));
      const cursor = this.elements.cursor;
      cursor.hidden = !this.recording || !this.duration;
      cursor.style.left = `${this.duration ? this.time / this.duration * 100 : 0}%`;
      let active = -1;
      for (let index = 0; index < this.events.length; index += 1) {
        if (this.events[index].start > this.time) break;
        if (this.time < this.events[index].end) active = index;
      }
      if (this.activeIndex !== active) {
        if (this.markers[this.activeIndex]) { this.markers[this.activeIndex].classList.toggle("active", false); this.markers[this.activeIndex].removeAttribute("aria-current"); }
        this.activeIndex = active;
        if (this.markers[active]) { this.markers[active].classList.toggle("active", true); this.markers[active].setAttribute("aria-current", "time"); }
      }
      const position = this.events.length ? this.translate("{current} / {total}", {current: active < 0 ? "—" : active + 1, total: this.events.length}) : "—";
      if (this.elements.position.textContent !== position) this.elements.position.textContent = position;
      this.elements.previous.disabled = this.phase !== "ready" || this.previousIndex() < 0;
      this.elements.next.disabled = this.phase !== "ready" || this.nextIndex() < 0;
    }

    relabel() { this.render(); }

    render() {
      const {status, error, track, markers, sensitivity, previous, next, retry} = this.elements;
      track.dataset.motionState = this.phase;
      track.setAttribute("aria-busy", String(this.phase === "loading"));
      track.setAttribute("aria-disabled", String(!this.recording));
      track.setAttribute("aria-label", this.translate("Image-change track. Use arrow keys to move between events."));
      sensitivity.disabled = !this.recording;
      retry.hidden = this.phase !== "error";
      retry.disabled = this.phase === "loading";
      retry.textContent = this.translate("Retry analysis");
      error.hidden = this.phase !== "error";
      error.textContent = this.phase === "error" ? this.translate(this.error?.key || "Motion analysis unavailable.", this.error?.params) : "";
      status.textContent = this.translate(this.phase === "idle" ? "Select a recording" : this.phase === "loading" ? "Analysing image changes…" : this.phase === "error" ? "Motion analysis unavailable." : !this.events.length ? "No image-change events at this sensitivity." : this.events.length === 1 ? "{count} image-change event" : "{count} image-change events", {count: this.events.length});
      previous.title = this.translate("Previous motion event"); previous.setAttribute("aria-label", previous.title);
      next.title = this.translate("Next motion event"); next.setAttribute("aria-label", next.title);
      this.activeIndex = -1;
      this.markers = [];
      markers.replaceChildren();
      for (let index = 0; index < this.events.length; index += 1) {
        const event = this.events[index], marker = this.document.createElement("button");
        marker.type = "button"; marker.className = "motion-event"; marker.tabIndex = -1;
        marker.dataset.motionIndex = String(index);
        marker.style.left = `${event.start / this.duration * 100}%`;
        marker.style.width = `${(event.end - event.start) / this.duration * 100}%`;
        marker.style.opacity = String(.45 + event.score * .55);
        marker.title = this.translate("Image change from {start} to {end}", {start: offsetLabel(event.start), end: offsetLabel(event.end)});
        marker.setAttribute("aria-label", marker.title);
        marker.addEventListener("click", (event) => { event.stopPropagation(); this.go(index); });
        markers.append(marker); this.markers.push(marker);
      }
      this.setTime(this.time);
    }

    destroy() {
      this.clear();
      this.elements.sensitivity.removeEventListener("change", this.handlers.sensitivity);
      this.elements.previous.removeEventListener("click", this.handlers.previous);
      this.elements.next.removeEventListener("click", this.handlers.next);
      this.elements.retry.removeEventListener("click", this.handlers.retry);
      this.elements.track.removeEventListener("click", this.handlers.click);
      this.elements.track.removeEventListener("keydown", this.handlers.keydown);
    }
  }

  root.NvrMotionTrack = MotionTrack;
  if (typeof module !== "undefined" && module.exports) module.exports = {MotionTrack, normalizeEvents, offsetLabel};
})(typeof window !== "undefined" ? window : globalThis);
