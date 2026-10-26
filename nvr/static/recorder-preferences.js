"use strict";

(() => {
  const ROOT = typeof window !== "undefined" ? window : globalThis;
  const SIZES = [1, 4, 9, 16];
  const ROTATION_SECONDS = [0, 15, 30, 60, 120, 300];
  const pad = (value) => String(value).padStart(2, "0");
  const dateValue = (value) => {
    if (value === null || value === undefined || typeof value === "boolean") return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  function utcTime(parts) {
    // Date.UTC treats years0..99 as1900..1999; setters preserve the actual year.
    const date = new Date(0);
    date.setUTCFullYear(parts.era === "BC" ? 1 - parts.year : parts.year, parts.month - 1, parts.day);
    date.setUTCHours(parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
    return date.getTime();
  }
  function validZone(value) {
    if (typeof value !== "string" || value.length > 100 || /^[+-]/.test(value)
        || !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(value)) throw RangeError("Invalid time zone.");
    try { return new Intl.DateTimeFormat("en-GB", {timeZone: value}).resolvedOptions().timeZone; }
    catch (_) { throw RangeError("Invalid time zone."); }
  }
  function validLocale(value) {
    try { return typeof value === "string" && Intl.DateTimeFormat.supportedLocalesOf([value]).length ? value : "en-GB"; }
    catch (_) { return "en-GB"; }
  }

  class NvrRecorderClock {
    constructor({timezone = "UTC", hourFormat = "24"} = {}) {
      this._formats = new Map();
      this.configure({effective_timezone: timezone, hour_format: hourFormat});
    }
    configure({effective_timezone = this.timezone, hour_format = this.hourFormat} = {}) {
      const zone = validZone(effective_timezone);
      if (!["12", "24"].includes(hour_format)) throw RangeError("Choose a 12-hour or 24-hour clock.");
      // Validate both values before changing either setting.
      this.timezone = zone; this.hourFormat = hour_format;
      this._formats.clear();
      this._partsFormat = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
        timeZone: zone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
        era: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      return this;
    }
    format(value, options = {}, locale) {
      const date = dateValue(value);
      if (!date) return "";
      const language = validLocale(locale || ROOT.NvrI18n?.locale?.() || "en-GB");
      const selected = {...options};
      delete selected.hour12; delete selected.hourCycle; delete selected.timeZone;
      selected.timeZone = this.timezone;
      if (selected.hour !== undefined || selected.timeStyle !== undefined) selected.hourCycle = this.hourFormat === "12" ? "h12" : "h23";
      const key = JSON.stringify([language, Object.entries(selected).sort(([left], [right]) => left.localeCompare(right))]);
      if (!this._formats.has(key)) {
        if (this._formats.size >= 64) this._formats.delete(this._formats.keys().next().value);
        this._formats.set(key, new Intl.DateTimeFormat(language, selected));
      }
      return this._formats.get(key).format(date);
    }
    _parts(value) {
      const result = {};
      for (const part of this._partsFormat.formatToParts(value)) {
        if (part.type === "era") result.era = part.value;
        if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) result[part.type] = Number(part.value);
      }
      return result;
    }
    toInput(value) {
      const date = dateValue(value);
      if (!date) return "";
      const parts = this._parts(date);
      if (parts.era !== "AD" || parts.year < 1 || parts.year > 9999) return "";
      return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
    }
    toDateInput(value) { return this.toInput(value).slice(0, 10); }
    fromInput(value) {
      if (typeof value !== "string") return null;
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
      if (!match) return null;
      const [year, month, day, hour, minute] = match.slice(1).map(Number);
      if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
      const desired = {year, month, day, hour, minute, second: 0};
      const naive = utcTime(desired), calendar = new Date(naive);
      if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
      // Enumerate nearby IANA offsets, including both sides of a DST or date-line
      // transition. Verification rejects skipped local times; taking the first
      // UTC candidate deterministically selects the earlier repeated time.
      const offsets = new Set();
      for (let hours = -48; hours <= 48; hours += 6) {
        const timestamp = naive + hours * 3600000;
        offsets.add(utcTime(this._parts(new Date(timestamp))) - timestamp);
      }
      const candidates = [];
      for (const offset of offsets) {
        const timestamp = naive - offset, actual = this._parts(new Date(timestamp));
        if (actual.era === "AD" && Object.keys(desired).every((key) => actual[key] === desired[key])) candidates.push(timestamp);
      }
      return candidates.length ? new Date(Math.min(...candidates)) : null;
    }
  }

  class NvrCameraRotation {
    constructor({getCameras = () => [], getLayout = () => ({size: 4}), onRotate = () => {}, isActive = () => false,
                 setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = (timer) => clearTimeout(timer)} = {}) {
      if (![getCameras, getLayout, onRotate, isActive, setTimer, clearTimer].every((value) => typeof value === "function")) {
        throw TypeError("Invalid live rotation controls.");
      }
      Object.assign(this, {_getCameras: getCameras, _getLayout: getLayout, _onRotate: onRotate, _isActive: isActive,
                          _setTimer: setTimer, _clearTimer: clearTimer});
      this._seconds = 0; this._page = 0; this._size = 4; this._ids = [];
      this._signature = ""; this._timer = null; this._generation = 0;
    }
    _cancelTimer() {
      this._generation += 1;
      if (this._timer !== null) this._clearTimer(this._timer);
      this._timer = null;
    }
    _inputs() {
      const cameras = this._getCameras(), layout = this._getLayout();
      const size = typeof layout === "number" ? layout : layout?.size;
      const selectedSize = SIZES.includes(size) ? size : 4;
      const ids = [], seen = new Set();
      for (const camera of Array.isArray(cameras) ? cameras : []) {
        const id = typeof camera === "string" ? camera : camera?.id;
        if (typeof id !== "string" || !id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
        seen.add(id); ids.push(id);
      }
      const signature = JSON.stringify([selectedSize, ids]);
      if (signature !== this._signature) {
        this._cancelTimer(); this._signature = signature; this._page = 0;
      }
      this._size = selectedSize; this._ids = ids;
    }
    _pages() { return Math.ceil(this._ids.length / this._size); }
    _canRun() { return this._seconds > 0 && this._pages() > 1 && !!this._isActive(); }
    configure(seconds) {
      if (!ROTATION_SECONDS.includes(seconds)) throw RangeError("Choose a valid live rotation interval.");
      if (seconds !== this._seconds) { this._cancelTimer(); this._seconds = seconds; this._page = 0; }
      return this.sync();
    }
    currentIds() {
      this._inputs();
      if (!this._seconds) return null;
      return Array.from({length: this._size}, (_, index) => this._ids[this._page * this._size + index] || null);
    }
    getCurrentIds() { return this.currentIds(); }
    state() {
      this._inputs();
      return {page: this._page, pages: this._pages(), size: this._size, seconds: this._seconds, active: this._timer !== null};
    }
    sync() {
      this._inputs();
      if (!this._canRun()) this._cancelTimer();
      else if (this._timer === null) {
        const generation = ++this._generation;
        this._timer = this._setTimer(() => {
          if (generation !== this._generation) return;
          this._timer = null;
          this._inputs();
          if (generation !== this._generation) { this.sync(); return; }
          try { this.advance(); }
          finally { if (generation === this._generation) this.sync(); }
        }, this._seconds * 1000);
      }
      return this.currentIds();
    }
    advance() {
      this._inputs();
      if (!this._canRun()) return this.currentIds();
      this._page = (this._page + 1) % this._pages();
      const ids = this.currentIds();
      this.sync();
      this._onRotate([...ids], this.state());
      return ids;
    }
    reset() { this._cancelTimer(); this._page = 0; return this.sync(); }
    stop() { this._cancelTimer(); }
  }

  const exports = {NvrRecorderClock, NvrCameraRotation, ROTATION_SECONDS: [...ROTATION_SECONDS]};
  ROOT.NvrRecorderPreferences = exports;
  ROOT.NvrRecorderClock = NvrRecorderClock; ROOT.NvrCameraRotation = NvrCameraRotation;
  if (typeof module !== "undefined" && module.exports) module.exports = exports;
})();
