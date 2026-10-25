"use strict";

(() => {
  const RATES = [.25, .5, 1, 1.5, 2];
  const finite = (value) => value !== null && value !== undefined && typeof value !== "boolean"
    && !(typeof value === "string" && !value.trim()) && Number.isFinite(Number(value));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  function elapsedLabel(value) {
    const seconds = finite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return `${hours ? hours + ":" + String(minutes).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function axisOffsets(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const step = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((value) => value >= duration / 6) || Math.ceil(duration / 6);
    const offsets = [0];
    for (let value = step; value < duration; value += step) {
      if (duration - value >= step * .35) offsets.push(value);
    }
    offsets.push(duration);
    return offsets;
  }

  class NvrRecordPlayer {
    constructor({video, elements, t = (key) => key, onPrevious = () => {}, onNext = () => {}, onError = () => {}, onTime = () => {}} = {}) {
      const required = ["controls", "previous", "play", "next", "elapsed", "total", "seek", "speed", "mute", "volume", "fullscreen", "absoluteTime", "axis"];
      if (!video || !elements || required.some((key) => !elements[key])) throw Error("Recording controls are unavailable.");
      this.video = video; this.elements = elements; this.t = t;
      this.onPrevious = onPrevious; this.onNext = onNext; this.onError = onError; this.onTime = onTime;
      this.document = video.ownerDocument; this.fullscreenTarget = elements.fullscreenTarget || video.parentElement || video;
      this.recording = null; this.navigation = {previous: false, next: false};
      this.epoch = 0; this.playRequest = 0; this.pendingPlay = null; this.playIntent = false; this.pendingSeek = null;
      this.destroyed = false; this.listeners = []; this.formatters = new Map(); this.axisKey = null;
      this.originalControls = video.controls; this.originalTabIndex = video.getAttribute?.("tabindex");
      this.rate = RATES.includes(video.playbackRate) ? video.playbackRate : 1;
      this.volume = finite(video.volume) ? clamp(Number(video.volume), 0, 1) : 1;
      this.lastAudibleVolume = this.volume || 1; this.muted = true;
      this._listen(elements.previous, "click", () => { if (this.recording && this.navigation.previous) this.onPrevious(); });
      this._listen(elements.next, "click", () => { if (this.recording && this.navigation.next) this.onNext(); });
      this._listen(elements.play, "click", () => this.togglePlayback());
      this._listen(elements.seek, "input", () => this.seek(Number(elements.seek.value)));
      this._listen(elements.speed, "change", () => this.setSpeed(Number(elements.speed.value)));
      this._listen(elements.volume, "input", () => this.setVolume(Number(elements.volume.value)));
      this._listen(elements.mute, "click", () => this.toggleMute());
      this._listen(elements.fullscreen, "click", () => this.toggleFullscreen());
      for (const name of ["timeupdate", "seeked"]) this._listen(video, name, () => this.update(true));
      for (const name of ["durationchange", "pause", "ended", "error"]) this._listen(video, name, () => this.update());
      this._listen(video, "play", () => {
        if (!this.recording || this.destroyed) { video.pause(); return; }
        if (!video.paused) this.playIntent = true;
        this.update();
      });
      this._listen(video, "loadedmetadata", () => {
        if (!this.recording || this.destroyed) return;
        this._applyPreferences();
        if (this.pendingSeek !== null) {
          // The source owner also initializes its requested offset in this
          // event. Apply a later custom seek after those synchronous handlers.
          const epoch = this.epoch;
          Promise.resolve().then(() => {
            if (epoch !== this.epoch || this.destroyed || !this.recording) return;
            this._applySeek(); this.update(true);
          });
        } else this.update(true);
      });
      this._listen(video, "volumechange", () => {
        if (finite(video.volume)) this.volume = clamp(Number(video.volume), 0, 1);
        this.muted = !!video.muted;
        if (this.volume > 0) this.lastAudibleVolume = this.volume;
        this.update();
      });
      this._listen(video, "ratechange", () => { if (RATES.includes(video.playbackRate)) this.rate = video.playbackRate; this.update(); });
      this._listen(video, "keydown", (event) => {
        if (event.target !== video || !this.recording) return;
        const key = event.key.toLowerCase();
        if ([" ", "k", "m", "arrowleft", "arrowright", "home", "end"].includes(key)) event.preventDefault();
        if (key === " " || key === "k") this.togglePlayback();
        else if (key === "m") this.toggleMute();
        else if (key === "arrowleft") this.seek(this.time() - 5);
        else if (key === "arrowright") this.seek(this.time() + 5);
        else if (key === "home") this.seek(0);
        else if (key === "end") this.seek(this.duration());
      });
      if (this.document?.addEventListener) this._listen(this.document, "fullscreenchange", () => this.update());
      this._applyPreferences();
      video.setAttribute?.("tabindex", "0");
      video.controls = false; elements.controls.hidden = false;
      this.update();
    }
    _listen(node, name, callback) { node.addEventListener(name, callback); this.listeners.push(() => node.removeEventListener(name, callback)); }
    _error(message) { if (!this.destroyed) this.onError(new Error(message)); }
    _locale() {
      return (typeof window !== "undefined" && window.NvrI18n?.locale?.()) || this.document?.documentElement?.lang || "en-GB";
    }
    _clock(timestamp, date = false, seconds = true) {
      if (!Number.isFinite(timestamp)) return "—";
      const instant = new Date(timestamp * 1000);
      if (!Number.isFinite(instant.getTime())) return "—";
      const locale = this._locale(), key = `${locale}:${date}:${seconds}`;
      if (!this.formatters.has(key)) {
        const options = {hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(seconds ? {second: "2-digit"} : {}), ...(date ? {year: "numeric", month: "short", day: "2-digit"} : {})};
        try { this.formatters.set(key, new Intl.DateTimeFormat(locale, options)); }
        catch (_) { this.formatters.set(key, new Intl.DateTimeFormat("en-GB", options)); }
      }
      return this.formatters.get(key).format(instant);
    }
    duration() {
      const declared = Number(this.recording?.duration);
      if (Number.isFinite(declared) && declared > 0) return declared;
      const media = Number(this.video.duration);
      return this.recording && Number.isFinite(media) && media > 0 ? media : 0;
    }
    time() {
      const value = this.pendingSeek ?? Number(this.video.currentTime);
      return Number.isFinite(value) ? clamp(value, 0, this.duration()) : 0;
    }
    setRecording(recording, {autoplay = false, hasPrevious = false, hasNext = false} = {}) {
      if (this.destroyed) return;
      if (!recording) { this.clear(); return; }
      const same = this.recording?.id === recording.id;
      this.epoch++; this.playRequest++; this.pendingPlay = null;
      if (!same) this.pendingSeek = null;
      this.recording = {...recording}; this.playIntent = !!autoplay;
      this.navigation = {previous: !!hasPrevious, next: !!hasNext}; this.axisKey = null;
      this._applyPreferences(); this.update();
    }
    setNavigation({previous = false, next = false} = {}) {
      this.navigation = {previous: !!previous, next: !!next}; this.update();
    }
    startIfWanted() {
      if (!this.destroyed && this.recording && this.playIntent && this.pendingPlay === null && this.video.paused) return this.togglePlayback();
    }
    async togglePlayback() {
      if (this.destroyed || !this.recording) return;
      if (this.pendingPlay !== null || (!this.video.paused && !this.video.ended)) {
        this.playIntent = false; this.playRequest++; this.pendingPlay = null; this.video.pause(); this.update(); return;
      }
      const epoch = this.epoch, request = ++this.playRequest;
      this.pendingPlay = request; this.playIntent = true; this.update();
      try {
        await this.video.play();
        if (epoch !== this.epoch || request !== this.playRequest || this.destroyed) {
          if (!this.recording || !this.playIntent || this.destroyed) this.video.pause();
          return;
        }
      } catch (error) {
        if (epoch === this.epoch && request === this.playRequest && !this.destroyed && error?.name !== "AbortError") {
          this.playIntent = false; this._error("Playback could not start. Try again or enable compatible playback.");
        }
      } finally {
        if (epoch === this.epoch && request === this.playRequest) { this.pendingPlay = null; this.update(); }
      }
    }
    seek(value) {
      if (this.destroyed || !this.recording || !Number.isFinite(value)) return;
      this.pendingSeek = clamp(value, 0, this.duration()); this._applySeek(); this.update(true);
    }
    _applySeek() {
      if (this.pendingSeek === null || this.video.readyState < 1) return;
      let end = this.duration();
      if (Number.isFinite(this.video.duration) && this.video.duration > 0) end = Math.min(end, this.video.duration);
      try { this.video.currentTime = clamp(this.pendingSeek, 0, end); this.pendingSeek = null; }
      catch (_) { /* Metadata or a future seekable range may not be ready yet. */ }
    }
    _applyPreferences() {
      try { this.video.playbackRate = this.rate; } catch (_) { /* The speed picker reports unsupported changes. */ }
      try { this.video.volume = this.volume; this.video.muted = this.muted; } catch (_) { /* Muting remains available on native mobile players. */ }
    }
    setSpeed(value) {
      if (this.destroyed || !RATES.includes(value)) { this.update(); return; }
      try { this.video.playbackRate = value; this.rate = value; }
      catch (_) { this._error("Playback speed is unavailable for this recording."); }
      this.update();
    }
    setVolume(value) {
      if (this.destroyed || !Number.isFinite(value)) return;
      const volume = clamp(value, 0, 1);
      try {
        this.video.volume = volume; this.video.muted = volume === 0;
        this.volume = volume; this.muted = volume === 0;
        if (volume > 0) this.lastAudibleVolume = volume;
      } catch (_) { this._error("Playback volume is unavailable in this browser."); }
      this.update();
    }
    toggleMute() {
      if (this.destroyed) return;
      try {
        if (this.muted || this.volume === 0) {
          if (!this.volume) this.video.volume = this.volume = this.lastAudibleVolume || 1;
          this.video.muted = this.muted = false;
        } else this.video.muted = this.muted = true;
      } catch (_) { this._error("Playback volume is unavailable in this browser."); }
      this.update();
    }
    _fullscreen() {
      const active = this.document?.fullscreenElement;
      return !!active && (active === this.fullscreenTarget || active === this.video || active.contains?.(this.video));
    }
    async toggleFullscreen() {
      if (this.destroyed || !this.recording) return;
      const epoch = this.epoch;
      try {
        if (this._fullscreen() && this.document?.exitFullscreen) await this.document.exitFullscreen();
        else if (this.fullscreenTarget.requestFullscreen) await this.fullscreenTarget.requestFullscreen();
        else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
        else throw Error("Unavailable");
      } catch (_) { if (epoch === this.epoch && !this.destroyed) this._error("Fullscreen is unavailable in this browser."); }
      this.update();
    }
    _button(node, label, selector) {
      node.setAttribute("aria-label", this.t(label)); node.title = this.t(label);
      const text = node.querySelector?.(selector);
      if (text) text.textContent = this.t(label);
    }
    _axis() {
      const duration = this.duration(), started = finite(this.recording?.started_at) ? Number(this.recording.started_at) : NaN, locale = this._locale();
      const key = this.recording ? `${started}:${duration}:${locale}` : "empty";
      if (key === this.axisKey) return;
      this.axisKey = key;
      const ticks = this.recording && Number.isFinite(started) ? axisOffsets(duration).map((offset) => {
        const tick = this.document.createElement("span"); tick.className = "record-axis-tick";
        tick.style.left = `${offset / duration * 100}%`; tick.dataset.offset = String(offset);
        tick.textContent = this._clock(started + offset, false, duration < 300);
        tick.title = this._clock(started + offset, true); return tick;
      }) : [];
      this.elements.axis.replaceChildren(...ticks);
      this.elements.axis.setAttribute("aria-label", ticks.length ? this.t("Recording time from {start} to {end}", {
        start: this._clock(started, true), end: this._clock(started + duration, true),
      }) : this.t("Select a recording"));
    }
    update(notify = false) {
      if (this.destroyed) return;
      const e = this.elements, duration = this.duration(), time = this.time(), selected = !!this.recording;
      const playing = selected && (this.pendingPlay !== null || (!this.video.paused && !this.video.ended));
      e.previous.disabled = !selected || !this.navigation.previous; e.next.disabled = !selected || !this.navigation.next;
      e.play.disabled = !selected; e.seek.disabled = !selected || !duration; e.fullscreen.disabled = !selected;
      e.seek.min = "0"; e.seek.max = String(duration); e.seek.value = String(time);
      e.seek.setAttribute("aria-valuetext", this.t("{elapsed} of {total}", {elapsed: elapsedLabel(time), total: elapsedLabel(duration)}));
      e.seek.setAttribute("aria-label", this.t("Playback position"));
      e.elapsed.textContent = elapsedLabel(time); e.total.textContent = elapsedLabel(duration);
      e.speed.value = String(this.rate); e.speed.setAttribute("aria-label", this.t("Playback speed"));
      e.volume.value = String(this.volume); e.volume.setAttribute("aria-label", this.t("Playback volume"));
      e.play.dataset.playing = String(!!playing); e.mute.dataset.muted = String(this.muted || this.volume === 0);
      e.fullscreen.dataset.fullscreen = String(this._fullscreen());
      this._button(e.play, playing ? "Pause" : "Play", "[data-record-play-label]");
      this._button(e.mute, this.muted || this.volume === 0 ? "Unmute" : "Mute", "[data-record-mute-label]");
      this._button(e.fullscreen, this._fullscreen() ? "Exit fullscreen" : "Fullscreen", "[data-record-fullscreen-label]");
      e.previous.setAttribute("aria-label", this.t("Previous recording")); e.previous.title = this.t("Previous recording");
      e.next.setAttribute("aria-label", this.t("Next recording")); e.next.title = this.t("Next recording");
      const absoluteTime = selected && finite(this.recording.started_at) ? Number(this.recording.started_at) + time : null;
      e.absoluteTime.textContent = absoluteTime === null ? "—" : this._clock(absoluteTime, true);
      this._axis();
      if (notify && selected) this.onTime(time, {absoluteTime, duration, recording: {...this.recording}});
    }
    relabel() { this.axisKey = null; this.update(); }
    clear() {
      this.epoch++; this.playRequest++; this.pendingPlay = null; this.playIntent = false; this.pendingSeek = null;
      this.recording = null; this.navigation = {previous: false, next: false}; this.video.pause(); this.axisKey = null; this.update();
    }
    destroy() {
      if (this.destroyed) return;
      this.clear(); this.destroyed = true; this.listeners.forEach((remove) => remove()); this.listeners = [];
      this.video.controls = this.originalControls; this.elements.controls.hidden = true;
      if (this.originalTabIndex === null || this.originalTabIndex === undefined) this.video.removeAttribute?.("tabindex");
      else this.video.setAttribute?.("tabindex", this.originalTabIndex);
    }
  }
  if (typeof window !== "undefined") window.NvrRecordPlayer = NvrRecordPlayer;
  if (typeof module !== "undefined" && module.exports) module.exports = {NvrRecordPlayer, elapsedLabel, axisOffsets};
})();
