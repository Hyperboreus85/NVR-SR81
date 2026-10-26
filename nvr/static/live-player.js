"use strict";

// Each camera has its own WebSocket and serial SourceBuffer operations. The
// bounded binary queue includes the fragment currently being appended.
(() => {
  const t = (...args) => window.NvrI18n.t(...args);
  class NvrLivePlayer {
    constructor(video, options) {
      this.video = video;
      this.cameraId = options.cameraId;
      this.onStatus = options.onStatus || (() => {});
      this.onUnauthorized = options.onUnauthorized || (() => {});
      this.wanted = false;
      this.destroyed = false;
      this.generation = 0;
      this.compatible = false;
      this.attempts = 0;
      this.controller = null;
      this.socket = null;
      this.mediaSource = null;
      this.sourceBuffer = null;
      this.objectUrl = null;
      this.retryTimer = null;
      this.watchdog = null;
      this.frameCallback = null;
      this.mode = "copy";
      this.audio = false;
      this.terminalMessage = "";
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      this.onVideoError = () => {
        if (!this.controller || this.controller.signal.aborted) return;
        this.fallbackRequested = !this.compatible;
        this.failureReason = this.compatible ? "The images cannot be decoded." : "Cannot decode this codec: trying compatible H.264.";
        this.controller.abort();
      };
      this.video.addEventListener("error", this.onVideoError);
    }

    status(state, message, params) {
      this.lastStatus = {state, message, params};
      const values = params ? {...params} : undefined;
      if (values && typeof values.message === "string") values.message = t(values.message);
      if (!this.destroyed) this.onStatus({state, message: t(message, values), mode: this.mode, audio: this.audio});
    }

    relabel() {
      if (this.lastStatus) this.status(this.lastStatus.state, this.lastStatus.message, this.lastStatus.params);
    }

    start() {
      if (this.destroyed || this.wanted) return;
      if (this.terminalMessage) { this.status("unsupported", this.terminalMessage); return; }
      this.wanted = true;
      if (!window.MediaSource) {
        this.wanted = false;
        this.terminalMessage = "This browser does not support the MediaSource live player. Use an up-to-date browser with MSE support.";
        this.status("unsupported", this.terminalMessage);
        return;
      }
      this.connect(++this.generation);
    }

    stop() {
      this.wanted = false;
      this.generation += 1;
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.cleanup();
      this.status("paused", "Live video paused");
    }

    destroy() {
      this.stop();
      this.destroyed = true;
      this.video.removeEventListener("error", this.onVideoError);
    }

    cleanup() {
      clearInterval(this.watchdog);
      this.watchdog = null;
      if (this.frameCallback !== null && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
      this.frameCallback = null;
      const controller = this.controller, socket = this.socket;
      this.controller = null;
      this.socket = null;
      controller?.abort();
      if (socket && socket.readyState < WebSocket.CLOSING) { try { socket.close(1000, "Viewer released"); } catch (_) { /* Socket may already be closing. */ } }
      this.sourceBuffer = null;
      this.mediaSource = null;
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    current(generation) { return this.wanted && !this.destroyed && generation === this.generation; }

    async connect(generation) {
      if (!this.current(generation)) return;
      this.cleanup();
      const controller = new AbortController();
      this.controller = controller;
      this.fallbackRequested = false;
      this.failureReason = "";
      this.serverErrorCode = null;
      this.mode = this.compatible ? "compatible" : "copy";
      this.audio = false;
      this.status("connecting", this.attempts ? "Reconnecting to the stream…" : "Connecting to the stream…");
      this.lastReceived = Date.now();
      this.lastAdvanced = Date.now();
      this.lastFrameAt = Date.now();
      this.lastTime = 0;
      this.freezeRecoveries = 0;
      this.usesFrameCallbacks = !!this.video.requestVideoFrameCallback;
      this.watchdog = setInterval(() => {
        if (!this.current(generation)) return;
        if (Date.now() - this.lastReceived > 25000) {
          this.failureReason = "No stream data received. Trying to reconnect.";
          controller.abort();
          return;
        }
        if (this.video.currentTime > this.lastTime + .05) {
          this.lastTime = this.video.currentTime;
          this.lastAdvanced = Date.now();
          if (!this.usesFrameCallbacks) this.freezeRecoveries = 0;
          if (this.video.readyState >= 2 && this.video.videoWidth > 0 && (this.attempts || this.lastState !== "playing")) {
            this.attempts = 0; this.lastState = "playing"; this.status("playing", "Live video");
          }
        }
        const clockFrozen = this.video.readyState >= 2 && Date.now() - this.lastAdvanced > 12000;
        const imageFrozen = this.usesFrameCallbacks && !this.video.paused && this.video.readyState >= 2 && Date.now() - this.lastFrameAt > 12000;
        if (clockFrozen || imageFrozen) {
          if (!this.freezeRecoveries) {
            this.stayLive(true); this.tryPlay(); this.freezeRecoveries += 1; this.lastAdvanced = Date.now(); this.lastFrameAt = Date.now();
          } else {
            this.failureReason = "Playback stalled. Reconnecting.";
            controller.abort();
          }
        }
      }, 1000);
      let retryDelay = null;
      try {
        const channel = this.openSocket(controller, generation);
        const info = await channel.ready;
        if (!this.current(generation)) return;
        const mime = typeof info.mime === "string" ? info.mime : "";
        this.mode = info.mode || this.mode;
        this.audio = /(?:mp4a|ac-3|ec-3|opus)/i.test(mime);
        if (!/^video\/mp4(?:\s*;|$)/i.test(mime) || !/codecs\s*=/i.test(mime)) throw new Error("The server did not provide the live stream codecs.");
        if (!MediaSource.isTypeSupported(mime)) {
          if (!this.compatible) { this.fallbackRequested = true; throw new Error("Unsupported codec: trying compatible H.264."); }
          this.wanted = false;
          this.terminalMessage = "The browser does not support the compatible H.264 stream either. Update the browser or check codec support.";
          this.status("unsupported", this.terminalMessage);
          return;
        }
        const mediaSource = new MediaSource();
        this.mediaSource = mediaSource;
        this.objectUrl = URL.createObjectURL(mediaSource);
        this.video.src = this.objectUrl;
        await this.waitSourceOpen(mediaSource, controller.signal);
        if (!this.current(generation)) return;
        this.sourceBuffer = mediaSource.addSourceBuffer(mime);
        if (this.usesFrameCallbacks) {
          const frame = () => {
            if (!this.current(generation)) return;
            this.lastFrameAt = Date.now(); this.freezeRecoveries = 0;
            if (this.attempts || this.lastState !== "playing") { this.attempts = 0; this.lastState = "playing"; this.status("playing", "Live video"); }
            this.frameCallback = this.video.requestVideoFrameCallback(frame);
          };
          this.frameCallback = this.video.requestVideoFrameCallback(frame);
        }
        this.lastState = "buffering";
        this.status("buffering", "Preparing the first frames…");
        while (this.current(generation)) {
          const value = await channel.read();
          try {
            try {
              await this.bufferOperation(() => this.sourceBuffer.appendBuffer(value), controller.signal);
            } catch (error) {
              if (error.name !== "QuotaExceededError") throw error;
              await this.evict(controller.signal, true);
              await this.bufferOperation(() => this.sourceBuffer.appendBuffer(value), controller.signal);
            }
            if (!this.current(generation)) return;
            this.stayLive();
            this.tryPlay();
            await this.evict(controller.signal);
          } finally {
            channel.release(value.byteLength);
          }
        }
      } catch (error) {
        if (!this.current(generation)) return;
        if (!this.compatible && ["NotSupportedError", "EncodingError"].includes(error.name)) this.fallbackRequested = true;
        if (this.fallbackRequested && !this.compatible) {
          this.compatible = true;
          this.status("connecting", "Browser codec unsupported: requesting H.264 conversion…");
          retryDelay = 0;
        } else {
          this.attempts += 1;
          retryDelay = [409, 429, 503].includes(this.serverErrorCode) ? 30000 : Math.min(30000, 1500 * 2 ** Math.min(this.attempts - 1, 5));
          this.lastState = "reconnecting";
          const message = this.failureReason || (error.name === "AbortError" ? "Connection interrupted." : error.message);
          this.status("reconnecting", "{message} Retrying in {seconds} s.", {message, seconds: Math.ceil(retryDelay / 1000)});
        }
      } finally {
        if (generation === this.generation) this.cleanup();
      }
      if (this.current(generation) && retryDelay !== null) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(++this.generation); }, retryDelay);
      }
    }

    openSocket(controller, generation) {
      const address = new URL(`/api/cameras/${encodeURIComponent(this.cameraId)}/live.ws?compatible=${this.compatible}`, window.location.href);
      address.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(address.href);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      const queue = [];
      let retainedBytes = 0, retainedMessages = 0, waiter = null, failure = null, initialized = false;
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const fail = (error) => {
        if (failure) return;
        failure = error;
        if (!initialized) rejectReady(error);
        if (waiter) { waiter.reject(error); waiter = null; }
        queue.length = 0; retainedBytes = 0; retainedMessages = 0;
        if (error.name !== "AbortError") this.failureReason = error.message;
        controller.abort();
        if (socket.readyState < WebSocket.CLOSING) { try { socket.close(1000, "Viewer reconnecting"); } catch (_) { /* Handshake can still be in progress. */ } }
      };
      controller.signal.addEventListener("abort", () => fail(new DOMException("Live stream interrupted", "AbortError")), {once: true});
      socket.addEventListener("open", () => { this.lastReceived = Date.now(); });
      socket.addEventListener("message", (event) => {
        if (failure || !this.current(generation)) return;
        this.lastReceived = Date.now();
        if (typeof event.data === "string") {
          let info;
          try { info = JSON.parse(event.data); } catch (_) { fail(new Error("Invalid live service response.")); return; }
          if (info.type === "error") {
            this.serverErrorCode = Number(info.code);
            if (this.serverErrorCode === 401) this.onUnauthorized();
            fail(new Error(typeof info.message === "string" ? info.message : "Live stream unavailable."));
          } else if (info.type === "init" && !initialized) {
            initialized = true; resolveReady(info);
          } else fail(new Error("Invalid live stream sequence."));
          return;
        }
        if (!initialized || !(event.data instanceof ArrayBuffer)) { fail(new Error("Invalid live fragment.")); return; }
        const value = new Uint8Array(event.data);
        if (!value.byteLength) return;
        if (retainedMessages + 1 > 4 || retainedBytes + value.byteLength > 16 * 1024 * 1024) {
          fail(new Error("The player cannot keep up with the stream. Reconnecting to clear the buffer; try a lighter substream.")); return;
        }
        retainedMessages += 1; retainedBytes += value.byteLength;
        if (waiter) { const waiting = waiter; waiter = null; waiting.resolve(value); }
        else queue.push(value);
      });
      socket.addEventListener("close", (event) => {
        if (controller.signal.aborted || !this.current(generation)) return;
        if (event.code === 4401) { this.onUnauthorized(); fail(new Error("Sign-in required.")); }
        else fail(new Error(event.code === 1012 ? "Stream restarted by the server." : "Live connection ended."));
      });
      socket.addEventListener("error", () => { if (!controller.signal.aborted) fail(new Error("WebSocket connection unavailable. Check the network and WebSocket support on the server or proxy.")); });
      return {
        ready,
        read: () => {
          if (failure) return Promise.reject(failure);
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((resolve, reject) => { waiter = {resolve, reject}; });
        },
        release: (bytes) => { retainedMessages = Math.max(0, retainedMessages - 1); retainedBytes = Math.max(0, retainedBytes - bytes); },
      };
    }

    waitSourceOpen(source, signal) {
      return new Promise((resolve, reject) => {
        const finish = (error) => { source.removeEventListener("sourceopen", open); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
        const open = () => finish();
        const abort = () => finish(new DOMException("Live stream interrupted", "AbortError"));
        source.addEventListener("sourceopen", open, {once: true});
        signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort();
        else if (source.readyState === "open") open();
      });
    }

    bufferOperation(operation, signal) {
      const buffer = this.sourceBuffer;
      if (!buffer || signal.aborted) return Promise.reject(new DOMException("Live stream interrupted", "AbortError"));
      return new Promise((resolve, reject) => {
        const finish = (error) => {
          buffer.removeEventListener("updateend", end); buffer.removeEventListener("error", fail); signal.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const end = () => finish();
        const fail = () => { this.fallbackRequested = !this.compatible; finish(new Error("Error decoding the live video.")); };
        const abort = () => finish(new DOMException("Live stream interrupted", "AbortError"));
        buffer.addEventListener("updateend", end, {once: true}); buffer.addEventListener("error", fail, {once: true}); signal.addEventListener("abort", abort, {once: true});
        try { operation(); } catch (error) { finish(error); }
      });
    }

    stayLive(force = false) {
      const ranges = this.sourceBuffer?.buffered;
      if (!ranges?.length) return;
      const start = ranges.start(ranges.length - 1), edge = ranges.end(ranges.length - 1);
      const target = Math.max(start, edge - 1.5);
      if (edge - start < .15) return;
      if (force || this.video.currentTime < start || edge - this.video.currentTime > 4) this.video.currentTime = target;
      this.video.playbackRate = edge - this.video.currentTime > 2.8 ? 1.03 : 1;
      try { this.mediaSource?.setLiveSeekableRange(Math.max(0, start), edge); } catch (_) { /* Optional MSE feature. */ }
    }

    async evict(signal, aggressive = false) {
      const ranges = this.sourceBuffer?.buffered;
      if (!ranges?.length) return;
      const start = ranges.start(0), edge = ranges.end(ranges.length - 1);
      const before = Math.min(this.video.currentTime - 2, edge - (aggressive ? 6 : 12));
      if (before > start + 1) await this.bufferOperation(() => this.sourceBuffer.remove(start, before), signal);
    }

    tryPlay() {
      if (!this.video.paused || !this.video.buffered.length) return;
      this.video.play().catch((error) => {
        if (error.name === "NotAllowedError" && this.wanted) { this.video.muted = true; this.video.play().catch(() => {}); }
      });
    }
  }
  window.NvrLivePlayer = NvrLivePlayer;
})();
