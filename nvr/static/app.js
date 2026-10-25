"use strict";

const $ = (id) => document.getElementById(id);
const locale = () => window.NvrI18n.locale();
const translatedMessages = new Map();
const messageBindings = new Map();
const warningLists = new Map();
const rawTextIds = new Set(["selected-name", "live-camera-name", "playing-label", "network-device-name", "network-device-address", "network-device-description"]);
const t = (key, params) => {
  const prior = translatedMessages.get(key);
  const source = prior && prior.key !== key && !params ? prior : {key, params};
  const value = window.NvrI18n.t(source.key, source.params);
  if (typeof key === "string" && key) {
    translatedMessages.set(value, {key: source.key, params: source.params ? {...source.params} : undefined});
    if (translatedMessages.size > 4000) translatedMessages.delete(translatedMessages.keys().next().value);
  }
  return value;
};
const number = (value, options = {}) => Number(value || 0).toLocaleString(locale(), options);
function dateFormat(options) {
  const formats = new Map();
  return {format(date) {
    const language = locale();
    if (!formats.has(language)) formats.set(language, new Intl.DateTimeFormat(language, options));
    return formats.get(language).format(date);
  }};
}
function savedMonitorLayout() {
  try { const value = Number(localStorage.getItem("nvr.monitor.layout")); return [1, 4, 9, 16].includes(value) ? value : 4; }
  catch (_) { return 4; }
}
const state = {
  authenticated: false, cameras: [], system: null, selectedId: null,
  recordings: [], recording: null, range: null, waveform: null,
  live: false, editingId: null, poll: null, archiveRequest: 0,
  waveformRequest: 0, toastTimer: null, refreshPromise: null, authEpoch: 0,
  rangeFollowsNow: true,
  motionSeek: null,
  recordingSettingsRevision: 0, recordingDuration: null,
  archiveController: null, waveformController: null, archiveFiltersDirty: false,
  timelineWindow: null,
};
const formatDate = dateFormat({day: "2-digit", month: "short"});
const formatTime = dateFormat({hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
const formatShortTime = dateFormat({hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const formatRecordingDate = dateFormat({day: "2-digit", month: "short", year: "numeric"});
const player = $("player");
const network = {
  view: "recorder", devices: [], selected: null, profiles: [], modalProfiles: [],
  interfaces: [], interfacesLoaded: false, interfaceEpoch: 0,
  scanEpoch: 0, profileEpoch: 0, modalEpoch: 0,
  scanController: null, profileController: null, modalController: null, scanTimer: null,
  scanProgress: null, deviceInfo: null, emptyMessage: null,
};
const monitor = {
  playing: true, layout: savedMonitorLayout(), page: 0, tiles: new Map(), observer: null,
  fullscreenId: null, audioCameraId: null, statusEpoch: 0,
  statusTimer: null,
};
let liveLayout = null;
let cameraEditor = null, cameraDialogEpoch = 0, cameraProbeEpoch = 0, cameraProbeController = null;

function cancelCameraProbe() {
  cameraProbeEpoch += 1;
  cameraProbeController?.abort(); cameraProbeController = null;
}

function cameraEditorController() {
  if (!cameraEditor && window.NvrCameraEditor) cameraEditor = new window.NvrCameraEditor({root: $("camera-form"), t});
  return cameraEditor;
}

function ensureLiveLayout() {
  if (!liveLayout && window.NvrLiveLayout && $("live-layout-root")) {
    liveLayout = new window.NvrLiveLayout({
      root: $("live-layout-root"), cameras: state.cameras, t,
      onSave(saved) {
        monitor.layout = saved.size;
        monitor.page = 0;
        try { localStorage.setItem("nvr.monitor.layout", String(saved.size)); } catch (_) { /* The complete layout is already saved. */ }
        if ($("settings-monitor-layout")) $("settings-monitor-layout").value = String(saved.size);
        if (network.view === "monitor") renderMonitor();
        toast(t("Layout saved."));
      },
      onError(error) {
        if ($("settings-monitor-layout") && liveLayout) $("settings-monitor-layout").value = String(liveLayout.getSaved().size);
        toast(errorText(error));
      },
    });
    if ($("settings-monitor-layout")) $("settings-monitor-layout").value = String(liveLayout.getSaved().size);
  }
  return liveLayout;
}
const motionTrack = window.NvrMotionTrack ? new window.NvrMotionTrack({
  elements: {track: $("motion-track"), markers: $("motion-markers"), cursor: $("motion-cursor"), status: $("motion-status"), error: $("motion-error"), sensitivity: $("motion-sensitivity"), previous: $("motion-previous"), next: $("motion-next"), retry: $("motion-retry"), position: $("motion-event-position")},
  request: (id, sensitivity, signal) => api(`/api/recordings/${encodeURIComponent(id)}/motion?${new URLSearchParams({sensitivity})}`, {signal}),
  t, seek: seekMotion,
}) : null;
let recordControls = null;
if (window.NvrRecordPlayer) {
  const ids = {controls: "record-player-controls", previous: "record-previous", play: "record-play", next: "record-next", elapsed: "record-elapsed", total: "record-total", seek: "record-seek", speed: "record-speed", mute: "record-mute", volume: "record-volume", fullscreen: "record-fullscreen", absoluteTime: "record-absolute-time", axis: "record-time-axis"};
  try {
    recordControls = new window.NvrRecordPlayer({video: player,
      elements: {...Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, $(id)])), fullscreenTarget: player.closest(".record-player")},
      t, onPrevious: () => adjacentRecording(-1), onNext: () => adjacentRecording(1),
      onError: (error) => archiveError(errorText(error)), onTime: () => updatePlaybackCursors(),
    });
  } catch (_) { player.controls = true; }
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function errorText(error) {
  return error instanceof Error ? t(error.message, error.i18nParams) : t("An error occurred.");
}

function uiError(message) {
  const source = translatedMessages.get(message);
  const error = new Error(source?.key || message);
  if (source?.params) error.i18nParams = source.params;
  return error;
}

async function api(path, options = {}) {
  const {rawBody, ...requestOptions} = options;
  const authEpoch = state.authEpoch;
  const method = requestOptions.method || "GET";
  const headers = new Headers(requestOptions.headers || {});
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) headers.set("X-NVR-Request", "1");
  if (requestOptions.body !== undefined || rawBody !== undefined) headers.set("Content-Type", "application/json");
  if (rawBody !== undefined && typeof rawBody !== "string") throw uiError(t("Invalid value"));
  let response;
  try {
    response = await fetch(path, {
      ...requestOptions, method, headers, credentials: "same-origin", cache: "no-store",
      body: rawBody !== undefined ? rawBody : requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw uiError(t("Cannot reach the server. Check your local network connection."));
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login" && authEpoch === state.authEpoch) showLogin();
    const detail = typeof data?.detail === "string" ? data.detail
      : Array.isArray(data?.detail) ? data.detail.map((item) => item.msg || t("Invalid value")).join(" · ")
      : t("Request failed ({status}).", {status: response.status});
    throw uiError(detail);
  }
  return data;
}

function bytes(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.max(0, Number(value)), i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return `${n.toLocaleString(locale(), {maximumFractionDigits: i > 1 ? 1 : 0})} ${units[i]}`;
}

function seconds(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 3600) return `${Math.floor(n / 3600)}:${String(Math.floor(n % 3600 / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  if (n >= 60) return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  return `${n} s`;
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(n) ? new Date(n) : null;
}

function timeLabel(value, withDate = false) {
  const date = timestamp(value);
  return date ? `${withDate ? `${formatDate.format(date)} · ` : ""}${formatTime.format(date)}` : "—";
}

function localInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function prepareArchiveSearch() {
  const date = $("archive-date")?.value, from = $("archive-from")?.value, to = $("archive-to")?.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(from || "") || !/^\d{2}:\d{2}$/.test(to || "")) return false;
  const start = new Date(`${date}T${from}`), end = new Date(`${date}T${to}`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || localInput(start) !== `${date}T${from}` || localInput(end) !== `${date}T${to}`) return false;
  if (end <= start) end.setDate(end.getDate() + 1);
  if (localInput(end).slice(11) !== to) return false;
  $("search-start").value = localInput(start);
  $("search-end").value = localInput(end);
  state.archiveFiltersDirty = false;
  return true;
}

function syncArchiveFilters() {
  if (!$("archive-date") || state.archiveFiltersDirty) return;
  $("archive-date").value = $("search-start").value.slice(0, 10);
  $("archive-from").value = $("search-start").value.slice(11, 16);
  $("archive-to").value = $("search-end").value.slice(11, 16);
}

function setText(id, value) {
  const source = !rawTextIds.has(id) && translatedMessages.get(value);
  if (source) messageBindings.set(id, source); else messageBindings.delete(id);
  $(id).textContent = value;
}
function selectedCamera() { return state.cameras.find((camera) => camera.id === state.selectedId); }
function toast(message) {
  setText("toast", message);
  $("toast").hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
}

function globalError(message = "") {
  setText("global-error", message);
  $("global-error").hidden = !message;
  if (message) toast(message);
}

function archiveError(message = "") {
  setText("archive-error", message);
  $("archive-error").hidden = !message;
}

function cameraStatus(camera) {
  if (!camera.enabled) return {label: t("Paused"), color: "", badge: "neutral", message: t("Recording is disabled for this camera.")};
  const status = camera.status || {};
  const raw = String(status.state || "unknown").toLowerCase();
  if (["recording", "running", "connected"].includes(raw)) return {label: t("Recording"), color: "green", badge: "", message: status.message ? t(status.message) : t("The recorder is receiving and saving the stream.")};
  if (["error", "failed", "offline", "backoff", "retrying", "reconnecting", "storage_full"].includes(raw)) return {label: ["retrying", "backoff", "reconnecting"].includes(raw) ? t("Reconnecting") : raw === "storage_full" ? t("Disk full") : t("Unavailable"), color: "orange", badge: "error", message: status.message ? t(status.message) : t("The stream is unavailable. The recorder will try to reconnect.")};
  return {label: ["starting", "connecting"].includes(raw) ? t("Connecting") : t("Waiting"), color: "yellow", badge: "waiting", message: status.message ? t(status.message) : t("Waiting for the first stream segment.")};
}

function showLogin() {
  state.authEpoch += 1;
  state.authenticated = false;
  cameraDialogEpoch += 1;
  cancelCameraProbe();
  cameraEditor?.setCamera(null);
  state.editingId = null;
  clearTimeout(state.toastTimer);
  $("toast").hidden = true;
  window.dispatchEvent(new CustomEvent("nvr-authchange", {detail: {authenticated: false}}));
  clearInterval(state.poll);
  state.poll = null;
  stopLive();
  clearPlayer();
  state.cameras = [];
  state.selectedId = null;
  state.recordings = [];
  state.range = null;
  state.archiveRequest += 1;
  state.archiveController?.abort(); state.archiveController = null;
  releaseMonitor();
  liveLayout?.destroy(); liveLayout = null;
  monitor.playing = true;
  monitor.page = 0;
  monitor.statusEpoch += 1;
  resetNetwork();
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("app").hidden = true;
  $("login-screen").hidden = false;
  document.body.classList.remove("loading");
}

async function enterApp() {
  state.authEpoch += 1;
  const authEpoch = state.authEpoch;
  state.authenticated = true;
  window.dispatchEvent(new CustomEvent("nvr-authchange", {detail: {authenticated: true}}));
  $("login-screen").hidden = true;
  $("app").hidden = false;
  $("password").value = "";
  document.body.classList.remove("loading");
  await refresh(true, true);
  if (!state.authenticated || authEpoch !== state.authEpoch) return;
  showView("monitor");
  clearInterval(state.poll);
  state.poll = setInterval(() => {
    if (state.authenticated && !document.hidden) refresh(false);
  }, 10000);
}

function refresh(showErrors = true, force = false) {
  if (state.refreshPromise) {
    return force ? state.refreshPromise.then(() => refresh(showErrors, true)) : state.refreshPromise;
  }
  const task = refreshData(showErrors);
  state.refreshPromise = task;
  return task.finally(() => { if (state.refreshPromise === task) state.refreshPromise = null; });
}

async function refreshData(showErrors) {
  const authEpoch = state.authEpoch;
  const durationRevision = state.recordingSettingsRevision;
  const results = await Promise.allSettled([api("/api/cameras"), api("/api/system")]);
  if (!state.authenticated || authEpoch !== state.authEpoch) return;
  const errors = [];
  if (results[0].status === "fulfilled") {
    const previousId = state.selectedId;
    state.cameras = Array.isArray(results[0].value) ? results[0].value : [];
    ensureLiveLayout()?.setCameras(state.cameras);
    if (!state.cameras.some((camera) => camera.id === state.selectedId)) state.selectedId = state.cameras[0]?.id || null;
    renderCameras();
    renderSelected();
    if (previousId !== state.selectedId) {
      state.archiveRequest += 1; state.archiveController?.abort();
      stopLive();
      clearPlayer();
      state.recordings = [];
      renderRecordings();
      if (state.selectedId) await loadRecordings();
    }
  } else errors.push(errorText(results[0].reason));
  if (results[1].status === "fulfilled") {
    state.system = results[1].value;
    if (durationRevision !== state.recordingSettingsRevision) state.system.segment_seconds = state.recordingDuration;
    renderSystem();
  }
  else errors.push(errorText(results[1].reason));
  renderStats();
  if (network.view === "cameras") renderConfiguredCameras();
  if (network.view === "monitor") { renderMonitor(); loadMonitorStatus(); }
  if (showErrors) globalError(errors.join(" "));
}

function renderStats() {
  setText("stat-cameras", number(state.cameras.length));
  setText("stat-enabled", t("{count} active", {count: number(state.cameras.filter((camera) => camera.enabled).length)}));
  setText("stat-recording", number(state.cameras.filter((camera) => camera.enabled && ["recording", "running", "connected"].includes(camera.status?.state)).length));
  setText("stat-storage", bytes(state.system?.recordings_bytes));
  setText("stat-free", state.system?.disk ? t("{space} free on disk", {space: bytes(state.system.disk.free)}) : t("Disk unavailable"));
}

function renderCameras() {
  const list = $("camera-list");
  list.replaceChildren();
  if (!state.cameras.length) list.append(el("p", "sidebar-empty", t("Your recorder is ready. Connect your first camera to get started.")));
  state.cameras.forEach((camera) => {
    const status = cameraStatus(camera);
    const row = el("button", `camera-row${camera.id === state.selectedId ? " active" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(camera.id === state.selectedId));
    row.append(icon("camera"));
    const copy = el("span", "camera-row-copy");
    copy.append(el("strong", "", camera.name), el("small", "", status.label));
    row.append(copy, el("span", `status-dot ${status.color}`));
    row.addEventListener("click", () => selectCamera(camera.id));
    list.append(row);
  });
  $("empty-state").hidden = state.cameras.length > 0;
  $("camera-workspace").hidden = !state.selectedId;
  const selector = $("archive-camera");
  if (selector) {
    const selected = selector.value;
    selector.replaceChildren();
    state.cameras.forEach((camera) => { const option = el("option", "", camera.name); option.value = camera.id; selector.append(option); });
    selector.value = state.cameras.some((camera) => camera.id === selected) ? selected : state.selectedId || "";
    selector.disabled = !state.cameras.length;
    $("search-form").querySelector("button[type=submit]").disabled = !state.cameras.length || !!state.archiveController;
  }
}

function renderSelected() {
  const camera = selectedCamera();
  if (!camera) return;
  const status = cameraStatus(camera);
  setText("selected-name", camera.name);
  setText("selected-status", status.label);
  $("selected-status").className = `badge ${status.badge}`;
  $("selected-status-dot").className = `status-dot ${status.color}`;
  setText("camera-status-message", status.message);
  $("camera-status-message").className = `status-message ${status.badge === "neutral" ? "waiting" : status.badge}`;
  setText("last-segment", timeLabel(camera.status?.last_segment_at, true));
  setText("camera-audio", camera.audio_mode === "none" ? t("Disabled") : t("Original, if available"));
  setText("camera-retention", t("{count} days", {count: number(camera.retention_days)}));
  setText("live-camera-name", camera.name);
}

function renderSystem() {
  const system = state.system;
  if (!system) return;
  setText("version", `SR81 · ${system.version || t("local")}`);
  setText("segment-length", seconds(system.segment_seconds));
  const disk = system.disk;
  if (disk && Number(disk.total) > 0) {
    const percent = Math.min(100, Math.max(0, Number(disk.used) / Number(disk.total) * 100));
    setText("disk-percent", t("{percent}% used", {percent: number(percent, {maximumFractionDigits: 0})}));
    $("disk-fill").style.width = `${percent}%`;
    setText("disk-caption", t("{free} available of {total}", {free: bytes(disk.free), total: bytes(disk.total)}));
  }
  $("system-warning").hidden = system.ffmpeg_available !== false;
  setText("system-warning", t("FFmpeg is unavailable on the server. Install FFmpeg and restart the recorder to enable recording, previews and playback."));
}

async function selectCamera(id) {
  if (!state.cameras.some((camera) => camera.id === id)) return;
  if ($("archive-camera")) $("archive-camera").value = id;
  showView("recorder");
  if (id === state.selectedId) return;
  stopLive();
  clearPlayer();
  state.selectedId = id;
  state.recordings = [];
  state.range = null;
  state.archiveRequest += 1; state.archiveController?.abort();
  renderCameras();
  renderSelected();
  renderRecordings();
  await loadRecordings();
}

function stopLive() {
  state.live = false;
  $("live-image").removeAttribute("src");
  $("live-image").hidden = true;
  $("live-placeholder").hidden = false;
  $("live-label").hidden = true;
  $("live-camera-name").hidden = true;
  const button = $("toggle-live");
  button.replaceChildren(icon("play"), document.createTextNode(t("Open preview")));
}

function toggleLive() {
  if (state.live) return stopLive();
  if (!state.selectedId) return;
  state.live = true;
  $("live-image").hidden = false;
  $("live-placeholder").hidden = true;
  $("live-label").hidden = false;
  $("live-camera-name").hidden = false;
  $("live-image").src = `/api/cameras/${encodeURIComponent(state.selectedId)}/live`;
  $("toggle-live").replaceChildren(icon("close"), document.createTextNode(t("Close preview")));
}

async function loadRecordings() {
  const request = ++state.archiveRequest, authEpoch = state.authEpoch;
  state.archiveController?.abort(); state.archiveController = null;
  const searchButton = $("search-form").querySelector("button[type=submit]");
  if (!state.selectedId) { searchButton.disabled = !state.cameras.length; return; }
  const start = new Date($("search-start").value).getTime() / 1000;
  const end = new Date($("search-end").value).getTime() / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    archiveError(t("Choose a valid range: the end must be after the start."));
    searchButton.disabled = false;
    return;
  }
  const cameraId = state.selectedId;
  const controller = new AbortController(); state.archiveController = controller;
  searchButton.disabled = true;
  archiveError();
  try {
    const query = new URLSearchParams({camera_id: cameraId, start: String(start), end: String(end), limit: "10000"});
    const recordings = await api(`/api/recordings?${query}`, {signal: controller.signal});
    if (request !== state.archiveRequest || state.selectedId !== cameraId || !state.authenticated || authEpoch !== state.authEpoch) return;
    state.recordings = (Array.isArray(recordings) ? recordings : []).sort((a, b) => a.started_at - b.started_at);
    state.range = {start, end};
    state.timelineWindow = null;
    if (state.recordings.length >= 10000) archiveError(t("Showing the first 10,000 segments. Narrow the range to view and check the rest of the archive."));
    if (state.recording && !state.recordings.some((recording) => recording.id === state.recording.id)) clearPlayer();
    renderRecordings();
    drawTimeline();
  } catch (error) {
    if (request === state.archiveRequest && error.name !== "AbortError" && state.authenticated && authEpoch === state.authEpoch) archiveError(errorText(error));
  } finally {
    if (request === state.archiveRequest) { state.archiveController = null; searchButton.disabled = !state.cameras.length; }
  }
}

function renderRecordings() {
  const list = $("recordings-list");
  list.replaceChildren();
  const count = state.recordings.length;
  setText("recording-count", t(count === 1 ? "{count} segment" : "{count} segments", {count: number(count)}));
  setText("recordings-total", bytes(state.recordings.reduce((sum, item) => sum + (Number(item.size) || 0), 0)));
  if (!count) list.append(el("p", "no-recordings", t("No recordings in the selected range. Try another date or wait for the first complete segment.")));
  state.recordings.forEach((recording) => {
    const row = el("button", `recording-row${recording.id === state.recording?.id ? " active" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(recording.id === state.recording?.id));
    row.setAttribute("aria-label", t("Play recording from {time}, duration {duration}", {time: timeLabel(recording.started_at, true), duration: seconds(recording.duration)}));
    const thumbnail = el("span", "recording-thumb"); thumbnail.append(icon("archive"));
    const image = el("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async";
    image.src = `/api/recordings/${encodeURIComponent(recording.id)}/thumbnail`;
    image.addEventListener("load", () => { thumbnail.dataset.ready = "true"; });
    image.addEventListener("error", () => { image.hidden = true; });
    thumbnail.append(image);
    const copy = el("span", "recording-row-copy");
    const camera = state.cameras.find((item) => item.id === recording.camera_id) || selectedCamera();
    copy.append(el("strong", "", camera?.name || t("Camera")), el("span", "recording-row-date", formatRecordingDate.format(new Date(recording.started_at * 1000))),
      el("span", "recording-row-time", `${timeLabel(recording.started_at)} – ${timeLabel(recording.started_at + Number(recording.duration || 0))}`));
    row.append(thumbnail, copy, el("span", "recording-duration", seconds(recording.duration)));
    row.addEventListener("click", () => selectRecording(recording));
    list.append(row);
  });
  drawTimeline();
  updateRecordNavigation();
}

function updateRecordNavigation() {
  const index = state.recordings.findIndex((item) => item.id === state.recording?.id);
  recordControls?.setNavigation({previous: index > 0, next: index >= 0 && index < state.recordings.length - 1});
}

function adjacentRecording(direction) {
  const index = state.recordings.findIndex((item) => item.id === state.recording?.id);
  if (index < 0 || ![-1, 1].includes(direction)) return;
  const next = state.recordings[index + direction];
  if (next) selectRecording(next, 0, !player.paused);
}

function clearPlayer() {
  motionTrack?.clear();
  state.motionSeek = null;
  state.recording = null;
  state.waveform = null;
  state.waveformRequest += 1;
  state.waveformController?.abort(); state.waveformController = null;
  recordControls?.clear();
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  $("player-placeholder").hidden = false;
  if ($("record-loading")) $("record-loading").hidden = true;
  $("download").hidden = true;
  $("download").removeAttribute("href");
  if ($("download-compatible")) {
    $("download-compatible").hidden = true;
    $("download-compatible").removeAttribute("href");
  }
  setText("playing-label", t("No recording selected"));
  setText("playing-codec", "");
  setText("waveform-label", t("Select a recording"));
  $("waveform-cursor").hidden = true;
  drawWaveform();
  updatePlaybackCursors();
}

function selectRecording(recording, offset = 0, autoplay = true) {
  const same = state.recording?.id === recording.id;
  state.recording = recording;
  if (!same) {
    state.motionSeek = null;
    motionTrack?.clear();
    state.waveformRequest += 1;
    state.waveformController?.abort(); state.waveformController = null;
    state.waveform = null;
    setText("motion-status", t("Waiting for playback…"));
    setText("waveform-label", t(recording.audio_codec ? "Waiting for playback…" : "No audio track"));
    drawWaveform();
  }
  archiveError();
  if (same && player.src && !player.error) {
    seekPlayer(offset);
    if (autoplay) player.play().catch(() => {});
    updateRecordNavigation(); updatePlaybackCursors();
    return;
  }
  player.pause();
  player.hidden = false;
  $("player-placeholder").hidden = true;
  if ($("record-loading")) $("record-loading").hidden = false;
  const compatible = $("compatible").checked;
  player.src = `/api/recordings/${encodeURIComponent(recording.id)}/playback?compatible=${compatible}`;
  player.load();
  recordControls?.setRecording(recording, {autoplay});
  const source = player.getAttribute("src");
  player.onloadedmetadata = () => {
    if (player.getAttribute("src") !== source) return;
    if ($("record-loading")) $("record-loading").hidden = true;
    const requested = state.motionSeek?.id === recording.id ? state.motionSeek.offset : offset;
    state.motionSeek = null;
    seekPlayer(requested);
    if (recordControls) recordControls.startIfWanted();
    else if (autoplay) player.play().catch(() => {});
    // Start the video request before background analysis can occupy the
    // browser's connection pool or the server's decoder workers.
    if (state.recording?.id === recording.id) {
      if (motionTrack) motionTrack.select(recording);
      else setText("motion-status", t("Motion analysis unavailable."));
      if (!same || !state.waveform) loadWaveform(recording);
    }
  };
  renderPlayingLabels();
  $("download").href = `/api/recordings/${encodeURIComponent(recording.id)}/download`;
  $("download").hidden = false;
  if ($("download-compatible")) {
    $("download-compatible").href = `/api/recordings/${encodeURIComponent(recording.id)}/download.mp4`;
    $("download-compatible").hidden = false;
  }
  renderRecordings();
}

function renderPlayingLabels() {
  const recording = state.recording;
  if (!recording) {
    setText("playing-label", t("No recording selected"));
    setText("playing-codec", "");
    return;
  }
  setText("playing-label", selectedCamera()?.name || t("Camera"));
  const videoCodec = String(recording.video_codec || t("Video")).toUpperCase();
  const audioCodec = recording.audio_codec ? ` · ${String(recording.audio_codec).toUpperCase()}` : t(" · no audio");
  setText("playing-codec", `${videoCodec}${audioCodec} · ${seconds(recording.duration)}${$("compatible").checked ? t(" · Compatibility conversion") : ""}`);
  recordControls?.relabel();
}

function seekPlayer(offset) {
  if (!Number.isFinite(offset) || offset < 0 || !state.recording) return;
  if (player.readyState < 1) { state.motionSeek = {id: state.recording.id, offset}; return; }
  const duration = Number.isFinite(player.duration) ? player.duration : state.recording.duration;
  try { player.currentTime = Math.max(0, Math.min(offset, Math.max(0, duration - .05))); } catch (_) { /* Metadata may still be loading. */ }
  updatePlaybackCursors();
}

function seekMotion(offset) {
  if (!state.recording) return;
  state.motionSeek = player.readyState < 1 ? {id: state.recording.id, offset} : null;
  seekPlayer(offset);
}

async function loadWaveform(recording) {
  const request = ++state.waveformRequest;
  state.waveformController?.abort();
  const controller = new AbortController(); state.waveformController = controller;
  state.waveform = null;
  setText("waveform-label", recording.audio_codec ? t("Analysing audio…") : t("No audio track"));
  drawWaveform();
  if (!recording.audio_codec) { state.waveformController = null; return; }
  try {
    const waveform = await api(`/api/recordings/${encodeURIComponent(recording.id)}/waveform`, {signal: controller.signal});
    if (request !== state.waveformRequest || state.recording?.id !== recording.id) return;
    state.waveform = waveform;
    const peaks = Array.isArray(waveform?.peaks) ? waveform.peaks : [];
    setText("waveform-label", peaks.length ? t("{duration} · audio intensity", {duration: seconds(waveform.duration)}) : t("Audio unavailable"));
    drawWaveform();
  } catch (error) {
    if (request !== state.waveformRequest || error.name === "AbortError") return;
    setText("waveform-label", t("Waveform unavailable"));
    $("waveform-label").title = errorText(error);
  } finally { if (request === state.waveformRequest) state.waveformController = null; }
}

function canvasContext(id) {
  const canvas = $(id);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  return {canvas, context, width, height};
}

function drawWaveform() {
  const dimensions = canvasContext("waveform");
  if (!dimensions) return;
  const {context, width, height} = dimensions;
  const colors = getComputedStyle(document.documentElement);
  context.fillStyle = colors.getPropertyValue("--panel-deep").trim();
  context.fillRect(0, 0, width, height);
  context.strokeStyle = colors.getPropertyValue("--line").trim();
  context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
  const peaks = state.waveform?.peaks;
  if (!Array.isArray(peaks) || !peaks.length) return;
  const barCount = Math.max(1, Math.floor(width / 3));
  context.fillStyle = colors.getPropertyValue("--accent").trim();
  for (let i = 0; i < barCount; i += 1) {
    const begin = Math.floor(i / barCount * peaks.length);
    const end = Math.min(peaks.length, Math.max(begin + 1, Math.ceil((i + 1) / barCount * peaks.length)));
    let peak = 0;
    for (let j = begin; j < end; j += 1) peak = Math.max(peak, Math.abs(Number(peaks[j]) || 0));
    const amplitude = Math.max(1, Math.min(1, peak) * (height - 12));
    context.fillRect(i * 3, (height - amplitude) / 2, 1.5, amplitude);
  }
  updateWaveformCursor();
}

function updateWaveformCursor() {
  const duration = Number(state.recording?.duration || state.waveform?.duration);
  const visible = state.recording && state.waveform?.peaks?.length && duration > 0;
  $("waveform-cursor").hidden = !visible;
  if (visible) $("waveform-cursor").style.left = `${Math.min(100, Math.max(0, player.currentTime / duration * 100))}%`;
}

function updatePlaybackCursors() {
  updateWaveformCursor();
  motionTrack?.setTime(player.currentTime);
  const duration = Number(state.recording?.duration), offset = Number(player.currentTime) || 0;
  const shared = $("recording-tracks-cursor"), global = $("timeline-cursor");
  const visible = !!state.recording && duration > 0;
  if (shared) {
    shared.hidden = !visible;
    if (visible) {
      shared.style.left = `${Math.min(100, Math.max(0, offset / duration * 100))}%`;
      if ($("recording-tracks-cursor-label")) $("recording-tracks-cursor-label").textContent = timeLabel(Number(state.recording.started_at) + offset);
    }
  }
  const range = state.timelineWindow || state.range;
  const absolute = Number(state.recording?.started_at) + offset;
  if (global) {
    const inRange = visible && range && absolute >= range.start && absolute <= range.end;
    global.hidden = !inRange;
    if (inRange) {
      global.style.left = `${(absolute - range.start) / (range.end - range.start) * 100}%`;
      if ($("timeline-cursor-label")) $("timeline-cursor-label").textContent = timeLabel(absolute);
    }
  }
}

function zoomTimeline(factor) {
  if (!state.range || !Number.isFinite(factor) || factor <= 0) return;
  const range = state.timelineWindow || state.range;
  const total = state.range.end - state.range.start;
  const width = Math.min(total, Math.max(Math.min(60, total), (range.end - range.start) * factor));
  const playhead = state.recording ? Number(state.recording.started_at) + (Number(player.currentTime) || 0) : NaN;
  const center = Number.isFinite(playhead) && playhead >= range.start && playhead <= range.end ? playhead : (range.start + range.end) / 2;
  const start = Math.max(state.range.start, Math.min(state.range.end - width, center - width / 2));
  state.timelineWindow = width >= total ? null : {start, end: start + width};
  drawTimeline();
}

function drawTimeline() {
  const dimensions = canvasContext("timeline");
  if (!dimensions) return;
  const {context, width, height} = dimensions;
  const colors = getComputedStyle(document.documentElement);
  context.fillStyle = colors.getPropertyValue("--panel-deep").trim();
  context.fillRect(0, 0, width, height);
  if (!state.range) return;
  const {start, end} = state.timelineWindow || state.range;
  const duration = end - start;
  context.strokeStyle = colors.getPropertyValue("--line").trim();
  context.lineWidth = 1;
  for (let i = 0; i <= 12; i += 1) {
    const x = i / 12 * width;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  state.recordings.forEach((recording) => {
    const from = Math.max(start, recording.started_at);
    const to = Math.min(end, recording.started_at + recording.duration);
    if (to <= from) return;
    context.fillStyle = colors.getPropertyValue(recording.id === state.recording?.id ? "--accent" : "--timeline-recording").trim() || colors.getPropertyValue("--accent").trim();
    // Segment width is proportional to its duration; gaps are never filled.
    context.fillRect((from - start) / duration * width, 7, (to - from) / duration * width, height - 14);
  });
  setText("timeline-start", timeLabel(start, true));
  setText("timeline-end", timeLabel(end, true));
  const ruler = $("timeline-ruler");
  if (ruler) {
    ruler.replaceChildren();
    for (let index = 0; index <= 6; index++) ruler.append(el("span", "", formatShortTime.format(new Date((start + duration * index / 6) * 1000))));
  }
  if ($("timeline-zoom-in")) $("timeline-zoom-in").disabled = duration <= 60;
  if ($("timeline-zoom-out")) $("timeline-zoom-out").disabled = !state.timelineWindow;
  updatePlaybackCursors();
}

function timelineSeek(event) {
  if (!state.range) return;
  const rect = $("timeline").getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const range = state.timelineWindow || state.range;
  const time = range.start + fraction * (range.end - range.start);
  const recording = state.recordings.find((item) => time >= item.started_at && time < item.started_at + item.duration);
  if (recording) {
    setText("timeline-message", t("Gaps indicate periods with no recordings."));
    selectRecording(recording, time - recording.started_at);
  } else setText("timeline-message", t("No segment available at {time}. Select a coloured section.", {time: timeLabel(time)}));
}

function openCameraDialog(camera = null) {
  cameraDialogEpoch += 1;
  cancelCameraProbe();
  state.editingId = camera?.id || null;
  $("camera-form").reset();
  setText("camera-form-error", "");
  $("probe-result").hidden = true;
  $("camera-url").required = !camera;
  setText("camera-dialog-title", camera ? t("Configure camera") : t("Add camera"));
  $("camera-name").value = camera?.name || "";
  $("camera-url").value = "";
  $("camera-url").placeholder = camera ? t("Leave blank to keep the saved stream") : "rtsp://user:password@192.168.1.50:554/stream";
  $("camera-preview-url").value = "";
  $("camera-preview-url").disabled = false;
  $("camera-preview-url").placeholder = camera ? t("Leave blank to keep the saved stream") : "rtsp://192.168.1.50:554/substream";
  $("camera-audio-mode").value = camera?.audio_mode || "copy";
  $("camera-retention-days").value = camera?.retention_days || 7;
  $("camera-enabled").checked = camera ? camera.enabled : true;
  $("clear-preview-row").hidden = !camera?.preview_source;
  $("stored-source").hidden = !camera;
  setText("stored-source", camera ? t("Saved stream: {source}", {source: camera.source || t("configured")}) : "");
  $("delete-camera").hidden = !camera;
  $("probe-camera").hidden = !camera;
  $("save-camera").disabled = false;
  $("probe-camera").disabled = false;
  if ($("camera-probe-controls")) $("camera-probe-controls").hidden = !camera;
  if ($("camera-probe-stream")) $("camera-probe-stream").value = "1";
  cameraEditorController()?.setCamera(camera);
  $("camera-dialog").showModal();
  $("camera-dialog").querySelector(".modal-body").scrollTop = 0;
}

async function saveCamera(event) {
  event.preventDefault();
  const editingId = state.editingId;
  const ticket = state.authEpoch, dialogEpoch = cameraDialogEpoch;
  const url = $("camera-url").value.trim();
  const preview = $("camera-preview-url").value.trim();
  const payload = {
    name: $("camera-name").value.trim(), url: url || (editingId ? null : ""),
    preview_url: $("clear-preview").checked ? "" : (preview || (editingId ? null : "")),
    third_url: $("camera-third-url")?.value.trim() || (editingId ? null : ""),
    enabled: $("camera-enabled").checked,
    audio_mode: $("camera-audio-mode").value,
    retention_days: Number($("camera-retention-days").value),
  };
  try {
    const editorPayload = cameraEditorController()?.getPayload();
    if (editorPayload) {
      delete payload.url; delete payload.preview_url; delete payload.third_url;
      Object.assign(payload, editorPayload);
    }
  } catch (error) { setText("camera-form-error", errorText(error)); return; }
  if (!payload.name) { setText("camera-form-error", t("Enter a camera name.")); return; }
  $("save-camera").disabled = true;
  setText("camera-form-error", "");
  try {
    const saved = await api(editingId ? `/api/cameras/${encodeURIComponent(editingId)}` : "/api/cameras", {method: editingId ? "PUT" : "POST", body: payload});
    if (!state.authenticated || ticket !== state.authEpoch || dialogEpoch !== cameraDialogEpoch) return;
    $("camera-dialog").close();
    showView("recorder");
    if (!editingId && saved?.id) {
      stopLive(); clearPlayer(); state.selectedId = saved.id;
    }
    await refresh(true, true);
    if (!editingId && state.selectedId) await loadRecordings();
    toast(editingId ? t("Configuration updated.") : t("Camera added. The recorder will try to connect to the stream."));
  } catch (error) { if (ticket === state.authEpoch && dialogEpoch === cameraDialogEpoch) setText("camera-form-error", errorText(error)); }
  finally { if (ticket === state.authEpoch && dialogEpoch === cameraDialogEpoch) $("save-camera").disabled = false; }
}

async function probeCamera() {
  if (!state.editingId) return;
  const cameraId = state.editingId, ticket = state.authEpoch, dialogEpoch = cameraDialogEpoch;
  const stream = Number($("camera-probe-stream")?.value || 1);
  if (![1, 2, 3].includes(stream)) return;
  cancelCameraProbe();
  const request = cameraProbeEpoch, controller = new AbortController();
  cameraProbeController = controller;
  $("probe-camera").disabled = true;
  if ($("camera-probe-stream")) $("camera-probe-stream").disabled = true;
  $("probe-result").hidden = false;
  $("probe-result").className = "probe-result";
  setText("probe-result", t("Checking the saved stream…"));
  try {
    const data = await api(`/api/cameras/${encodeURIComponent(cameraId)}/probe?stream=${stream}`, {method: "POST", signal: controller.signal});
    if (!state.authenticated || ticket !== state.authEpoch || dialogEpoch !== cameraDialogEpoch || request !== cameraProbeEpoch) return;
    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const details = streams.map((stream) => `${stream.codec_type || t("stream")}: ${stream.codec_name || t("unknown")}${stream.width ? ` · ${number(stream.width)} × ${number(stream.height)}` : ""}`);
    if (!details.length) {
      if (data?.video_codec) details.push(t("Video: {codec}", {codec: data.video_codec}));
      if (data?.audio_codec) details.push(t("Audio: {codec}", {codec: data.audio_codec}));
    }
    setText("probe-result", details.length ? t("Stream reachable.\n{details}", {details: details.join("\n")}) : t("Stream reachable. Check completed."));
  } catch (error) { if (error.name !== "AbortError" && ticket === state.authEpoch && dialogEpoch === cameraDialogEpoch && request === cameraProbeEpoch) { $("probe-result").className = "probe-result error"; setText("probe-result", errorText(error)); } }
  finally { if (ticket === state.authEpoch && dialogEpoch === cameraDialogEpoch && request === cameraProbeEpoch) { cameraProbeController = null; $("probe-camera").disabled = false; if ($("camera-probe-stream")) $("camera-probe-stream").disabled = false; } }
}

async function findOnvifProfiles(event) {
  event.preventDefault();
  network.modalController?.abort();
  const request = ++network.modalEpoch;
  const authEpoch = state.authEpoch;
  const controller = new AbortController();
  network.modalController = controller;
  const button = $("onvif-form").querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = t("Reading profiles…");
  setText("onvif-error", "");
  network.modalProfiles = [];
  $("onvif-profiles").replaceChildren();
  $("onvif-stream-tools").hidden = true;
  showWarnings("onvif-warnings", []);
  try {
    const data = await api("/api/onvif/profiles", {method: "POST", signal: controller.signal, body: {
      endpoint: $("onvif-endpoint").value.trim(), username: $("onvif-username").value,
      password: $("onvif-password").value,
    }});
    if (request !== network.modalEpoch || authEpoch !== state.authEpoch || !$("onvif-dialog").open) return;
    network.modalProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
    showWarnings("onvif-warnings", data?.warnings);
    if (!network.modalProfiles.length) setText("onvif-error", t("The device returned no video profiles. Check that ONVIF is enabled and the user can access video services."));
    renderModalProfiles();
  } catch (error) {
    if (error.name !== "AbortError" && request === network.modalEpoch) setText("onvif-error", errorText(error));
  } finally {
    if (request === network.modalEpoch) { button.disabled = false; button.textContent = t("Find profiles"); network.modalController = null; }
  }
}

function renderConfiguredCameras() {
  const list = $("configured-camera-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.cameras.length) list.append(el("p", "muted", t("No cameras configured. Add a camera or search your network.")));
  state.cameras.forEach((camera) => {
    const card = el("article", "configured-camera-card");
    const copy = el("div", "configured-camera-copy");
    const status = cameraStatus(camera);
    copy.append(el("h3", "", camera.name), el("span", "muted small", status.label));
    const actions = el("div", "configured-camera-actions");
    const live = el("button", "button secondary", t("Open live"));
    live.type = "button";
    live.addEventListener("click", () => {
      const layout = ensureLiveLayout();
      const saved = layout?.getSaved();
      const slot = saved?.slots.indexOf(camera.id) ?? -1;
      if (slot >= 0 && slot < saved.size) showView("monitor");
      else { showView("layout"); toast(t("Choose a tile for this camera, then save the layout.")); }
    });
    const recordings = el("button", "button quiet", t("Open recordings"));
    recordings.type = "button";
    recordings.addEventListener("click", () => selectCamera(camera.id));
    const configure = el("button", "button quiet", t("Configure"));
    configure.type = "button";
    configure.addEventListener("click", () => openCameraDialog(camera));
    actions.append(live, recordings, configure);
    card.append(icon("camera"), copy, actions);
    list.append(card);
  });
}

function showView(view) {
  if (!["recorder", "monitor", "layout", "cameras", "network", "settings"].includes(view)) view = "monitor";
  network.view = view;
  const isNetwork = view === "network";
  const isLive = view === "monitor" || view === "layout";
  $("recorder-view").hidden = view !== "recorder";
  $("network-view").hidden = !isNetwork;
  $("monitor-view").hidden = view !== "monitor";
  if ($("live-layout-view")) $("live-layout-view").hidden = view !== "layout";
  if ($("cameras-view")) $("cameras-view").hidden = view !== "cameras";
  if ($("settings-view")) $("settings-view").hidden = view !== "settings";
  setText("current-view-label", t(({recorder: "Record", monitor: "Monitor", layout: "Layout", cameras: "Cameras", network: "Network", settings: "Settings"})[view]));
  if ($("current-view-label")) $("current-view-label").hidden = isLive || view === "recorder";
  if ($("live-subnav")) $("live-subnav").hidden = !isLive;
  if ($("record-subnav")) $("record-subnav").hidden = view !== "recorder";
  ["monitor", "layout"].forEach((name) => {
    const button = $(`live-tab-${name}`);
    if (!button) return;
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.body.classList.toggle("live-workspace", isLive);
  ["recorder", "monitor", "cameras", "network", "settings"].forEach((name) => {
    const button = $(`nav-${name}`);
    if (!button) return;
    const active = name === view || name === "monitor" && isLive;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (view !== "recorder") { stopLive(); player.pause(); }
  if (!isNetwork) {
    cancelNetworkScan(false);
    if (network.profileController) clearNetworkProfiles(false);
    drawTimeline(); drawWaveform();
  }
  if (view === "monitor" && state.authenticated) { renderMonitor(); loadMonitorStatus(); }
  else releaseMonitor();
  if (view === "layout" && state.authenticated) ensureLiveLayout()?.open();
  else liveLayout?.close();
  if (view === "cameras") renderConfiguredCameras();
  if (view === "recorder") { drawWaveform(); drawTimeline(); recordControls?.update(); }
  if (view === "settings") window.NvrSettings?.open();
}

function releaseMonitor() {
  clearTimeout(monitor.statusTimer); monitor.statusTimer = null;
  monitor.observer?.disconnect(); monitor.observer = null;
  monitor.tiles.forEach((tile) => tile.live?.destroy());
  monitor.tiles.clear();
  $("monitor-grid").replaceChildren();
  monitor.audioCameraId = null;
  monitor.fullscreenId = null;
  monitor.serverStatus = null;
  monitor.statusEpoch += 1;
}

function monitorCanPlay(tile) {
  return state.authenticated && network.view === "monitor" && monitor.playing && !document.hidden && tile.visible && (!monitor.fullscreenId || monitor.fullscreenId === tile.id);
}

function syncMonitorPlayers() {
  monitor.tiles.forEach((tile) => {
    if (monitorCanPlay(tile)) tile.live?.start();
    else {
      tile.live?.stop();
      const message = !monitor.playing ? t("Monitor paused") : document.hidden ? t("Tab in the background") : t("Tile outside the visible area");
      updateMonitorTile(tile, {state: "paused", message, audio: tile.hasAudio, mode: tile.mode});
    }
  });
  $("monitor-toggle").replaceChildren(icon(monitor.playing ? "pause" : "play"), el("span", "", monitor.playing ? t("Pause monitor") : t("Start monitor")));
  $("monitor-toggle").disabled = !state.cameras.length;
}

function updateMonitorAudio(tile) {
  const active = tile.hasAudio && !tile.video.muted;
  tile.audioButton.replaceChildren(icon(active ? "audio" : "muted"));
  tile.audioButton.disabled = !tile.hasAudio;
  tile.audioButton.setAttribute("aria-label", !tile.hasAudio ? t("Audio is unavailable in this stream") : active ? t("Mute {camera}", {camera: tile.name}) : t("Listen to {camera}", {camera: tile.name}));
  tile.audioButton.title = !tile.hasAudio ? t("Audio is unavailable in this stream") : active ? t("Mute audio") : t("Listen to this camera only");
  tile.audioButton.setAttribute("aria-pressed", String(active));
  tile.audioButton.classList.toggle("audio-on", active);
}

function updateMonitorTile(tile, info) {
  if (!monitor.tiles.has(tile.id)) return;
  tile.lastInfo = info;
  tile.hasAudio = !!info.audio;
  tile.mode = info.mode || "copy";
  const changed = tile.liveState !== info.state;
  tile.liveState = info.state;
  tile.element.dataset.liveState = info.state;
  tile.connection.textContent = info.state === "playing" ? t("LIVE") : info.state === "connecting" || info.state === "buffering" ? t("CONNECTING") : info.state === "reconnecting" ? t("RECONNECTING") : info.state === "unsupported" ? t("UNSUPPORTED") : t("PAUSED");
  const failed = ["reconnecting", "unsupported"].includes(info.state);
  tile.message.textContent = failed ? info.state === "unsupported" ? t("Unsupported browser") : t("Connection unavailable") : t(info.message || "");
  tile.errorDetail.hidden = !failed;
  tile.errorDetail.textContent = failed ? t(info.message || "") : "";
  tile.overlay.hidden = info.state === "playing";
  tile.modeLabel.textContent = tile.mode === "compatible" ? t("Compatible H.264 · CPU") : t("Original stream");
  tile.modeLabel.classList.toggle("converted", tile.mode === "compatible");
  updateMonitorAudio(tile);
  if (changed && ["playing", "paused", "reconnecting", "unsupported"].includes(info.state) && network.view === "monitor" && state.authenticated && !document.hidden) {
    clearTimeout(monitor.statusTimer);
    monitor.statusTimer = setTimeout(() => { monitor.statusTimer = null; loadMonitorStatus(); }, 400);
  }
}

function liveStreamLabel(camera) {
  const selected = Number(camera.live_stream || 2);
  if (selected === 3 && (camera.streams?.third?.configured ?? !!camera.third_source)) return t("Third stream");
  if (selected === 2 && (camera.streams?.sub?.configured ?? !!camera.preview_source)) return t("SUBSTREAM");
  return t("MAIN STREAM");
}

function liveSourceFingerprint(camera) {
  return `${camera.source}|${camera.preview_source}|${camera.third_source || ""}|${camera.live_stream || 2}`;
}

function makeMonitorTile(camera) {
  const tile = {id: camera.id, name: camera.name, source: liveSourceFingerprint(camera), visible: false, hasAudio: false, mode: "copy"};
  tile.element = el("article", "monitor-tile");
  tile.element.dataset.cameraId = camera.id;
  const heading = el("div", "monitor-tile-heading");
  tile.title = el("h3", "", camera.name);
  tile.recordingBadge = el("span", "monitor-recording");
  const frame = el("div", "monitor-video-frame");
  tile.video = el("video", "monitor-video");
  tile.video.muted = true; tile.video.playsInline = true; tile.video.autoplay = true;
  tile.video.setAttribute("aria-label", t("Live video from {camera}", {camera: camera.name}));
  tile.overlay = el("div", "monitor-video-overlay");
  tile.message = el("span", "", t("Connecting to the stream…"));
  tile.overlay.append(icon("camera"), tile.message);
  const connection = el("div", "monitor-connection");
  tile.connection = el("span", "", t("WAITING"));
  connection.append(el("i"), tile.connection);
  tile.quality = el("span", "monitor-quality", liveStreamLabel(camera));
  heading.append(tile.title, connection);
  frame.append(tile.video, tile.overlay, tile.quality);
  tile.errorDetail = el("p", "monitor-tile-error"); tile.errorDetail.hidden = true;
  const footer = el("div", "monitor-tile-footer");
  tile.modeLabel = el("span", "monitor-mode", t("Original stream"));
  const controls = el("div", "monitor-tile-controls");
  const archive = el("button", "icon-button"); archive.type = "button"; archive.title = t("Open recordings"); archive.setAttribute("aria-label", t("Open recordings from {camera}", {camera: camera.name})); archive.append(icon("archive"));
  tile.archiveButton = archive;
  archive.addEventListener("click", () => selectCamera(camera.id));
  tile.audioButton = el("button", "icon-button"); tile.audioButton.type = "button";
  tile.audioButton.addEventListener("click", () => {
    const enable = tile.video.muted;
    monitor.tiles.forEach((other) => { other.video.muted = true; updateMonitorAudio(other); });
    tile.video.muted = !enable;
    monitor.audioCameraId = enable ? camera.id : null;
    if (enable) tile.video.play().catch(() => {});
    updateMonitorAudio(tile);
  });
  tile.video.addEventListener("volumechange", () => updateMonitorAudio(tile));
  const fullscreen = el("button", "icon-button"); fullscreen.type = "button"; fullscreen.title = t("Fullscreen"); fullscreen.setAttribute("aria-label", t("Show {camera} fullscreen", {camera: camera.name})); fullscreen.append(icon("fullscreen"));
  tile.fullscreenButton = fullscreen;
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (tile.element.requestFullscreen) {
        await tile.element.requestFullscreen();
        if (!state.authenticated || network.view !== "monitor" || monitor.tiles.get(camera.id) !== tile) {
          if (document.fullscreenElement === tile.element) await document.exitFullscreen();
          return;
        }
        monitor.fullscreenId = camera.id; syncMonitorPlayers();
      }
      else toast(t("Fullscreen is unavailable in this browser."));
    } catch (_) { toast(t("The browser did not allow fullscreen.")); }
  });
  const menu = el("details", "monitor-camera-menu");
  const menuToggle = el("summary", "icon-button", "⋮");
  menuToggle.setAttribute("aria-label", t("Camera actions"));
  tile.menuToggle = menuToggle;
  const menuItems = el("div", "monitor-camera-menu-items");
  tile.archiveLabel = el("span", "", t("Open recordings"));
  tile.fullscreenLabel = el("span", "", t("Fullscreen"));
  archive.append(tile.archiveLabel); fullscreen.append(tile.fullscreenLabel);
  archive.addEventListener("click", () => { menu.open = false; });
  fullscreen.addEventListener("click", () => { menu.open = false; });
  menuItems.append(archive, fullscreen); menu.append(menuToggle, menuItems);
  controls.append(tile.audioButton, menu); heading.append(controls);
  footer.append(tile.modeLabel, tile.recordingBadge);
  tile.element.append(heading, frame, tile.errorDetail, footer);
  updateMonitorAudio(tile);
  if (window.NvrLivePlayer) {
    tile.live = new window.NvrLivePlayer(tile.video, {cameraId: camera.id, onStatus: (info) => updateMonitorTile(tile, info), onUnauthorized: () => { if (state.authenticated) showLogin(); }});
  } else {
    tile.element.dataset.liveState = "unsupported"; tile.message.textContent = t("Video player unavailable. Reload the page.");
  }
  return tile;
}

function renderMonitor() {
  if (network.view !== "monitor" || !state.authenticated) return;
  const layout = ensureLiveLayout();
  const saved = layout?.getSaved();
  if (saved) monitor.layout = saved.size;
  const cameraMap = new Map(state.cameras.map((camera) => [camera.id, camera]));
  const slots = saved ? saved.slots.slice(0, saved.size) : state.cameras.slice(0, monitor.layout).map((camera) => camera.id);
  while (slots.length < monitor.layout) slots.push(null);
  const cameras = slots.map((id) => cameraMap.get(id)).filter(Boolean);
  const ids = new Set(cameras.map((camera) => camera.id));
  monitor.tiles.forEach((tile, id) => {
    if (!ids.has(id)) { monitor.observer?.unobserve(tile.element); tile.live?.destroy(); tile.element.remove(); monitor.tiles.delete(id); if (monitor.audioCameraId === id) monitor.audioCameraId = null; }
  });
  if (!monitor.observer && window.IntersectionObserver) {
    monitor.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const tile = monitor.tiles.get(entry.target.dataset.cameraId);
        if (tile) tile.visible = entry.isIntersecting && entry.intersectionRatio > .05;
      });
      syncMonitorPlayers();
    }, {threshold: [0, .05, .2]});
  }
  cameras.forEach((camera) => {
    let tile = monitor.tiles.get(camera.id);
    const source = liveSourceFingerprint(camera);
    if (tile && tile.source !== source) { monitor.observer?.unobserve(tile.element); tile.live?.destroy(); tile.element.remove(); monitor.tiles.delete(camera.id); tile = null; }
    if (!tile) {
      tile = makeMonitorTile(camera); monitor.tiles.set(camera.id, tile); $("monitor-grid").append(tile.element);
      if (monitor.observer) monitor.observer.observe(tile.element); else tile.visible = true;
    }
    tile.name = camera.name; tile.title.textContent = camera.name;
    tile.video.setAttribute("aria-label", t("Live video from {camera}", {camera: camera.name}));
    tile.archiveButton.title = t("Open recordings");
    tile.archiveButton.setAttribute("aria-label", t("Open recordings from {camera}", {camera: camera.name}));
    tile.archiveLabel.textContent = t("Open recordings");
    tile.fullscreenLabel.textContent = t("Fullscreen");
    tile.menuToggle.setAttribute("aria-label", t("Camera actions"));
    tile.fullscreenButton.title = t("Fullscreen");
    tile.fullscreenButton.setAttribute("aria-label", t("Show {camera} fullscreen", {camera: camera.name}));
    tile.quality.textContent = liveStreamLabel(camera);
    const status = cameraStatus(camera);
    const recording = camera.enabled && ["recording", "running", "connected"].includes(camera.status?.state);
    tile.recordingBadge.textContent = recording ? t("● REC") : !camera.enabled ? t("Paused") : status.label;
    tile.recordingBadge.classList.toggle("recording", recording);
    tile.recordingBadge.title = !camera.enabled ? t("Recording paused. Live video is still available.") : status.message;
  });
  const grid = $("monitor-grid");
  grid.querySelectorAll(".monitor-empty-tile").forEach((node) => node.remove());
  slots.forEach((id, index) => {
    const tile = monitor.tiles.get(id);
    const element = tile ? tile.element : el("button", "monitor-empty-tile");
    if (!tile) {
      element.type = "button";
      element.append(icon("plus"), el("span", "", t("Choose a camera")));
      element.setAttribute("aria-label", t("Configure tile {number}", {number: index + 1}));
      element.addEventListener("click", () => showView("layout"));
    }
    if (grid.children[index] !== element) grid.insertBefore(element, grid.children[index] || null);
  });
  $("monitor-grid").className = `monitor-grid layout-${monitor.layout}`;
  $("monitor-empty").hidden = !!state.cameras.length;
  $("monitor-grid").hidden = !state.cameras.length;
  setText("monitor-page-label", cameras.length === 1 ? t("1 camera") : t("{count} cameras", {count: number(cameras.length)}));
  $("monitor-previous").disabled = true;
  $("monitor-next").disabled = true;
  $("monitor-previous").hidden = true;
  $("monitor-next").hidden = true;
  document.querySelectorAll("[data-monitor-layout]").forEach((button) => {
    const active = Number(button.dataset.monitorLayout) === monitor.layout;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  syncMonitorPlayers();
}

async function loadMonitorStatus() {
  if (network.view !== "monitor" || !state.authenticated || document.hidden) return;
  const epoch = ++monitor.statusEpoch, authEpoch = state.authEpoch;
  try {
    const data = await api("/api/live/status");
    if (epoch !== monitor.statusEpoch || authEpoch !== state.authEpoch || network.view !== "monitor") return;
    monitor.serverStatus = data;
    setText("monitor-live-status", t("On the server: {active} / {max} streams · {converted} / {maxConverted} conversions", {active: number(data.active_streams), max: number(data.max_streams), converted: number(data.active_transcodes), maxConverted: number(data.max_transcodes)}));
    $("monitor-server-dot").className = "status-dot green";
    $("monitor-error").hidden = true;
  } catch (error) {
    if (epoch !== monitor.statusEpoch || authEpoch !== state.authEpoch || network.view !== "monitor") return;
    monitor.serverStatus = null;
    setText("monitor-live-status", t("Connection status unavailable")); $("monitor-server-dot").className = "status-dot orange";
    setText("monitor-error", errorText(error)); $("monitor-error").hidden = false;
  }
}

function showWarnings(id, warnings) {
  const container = $(id);
  container.replaceChildren();
  const list = (Array.isArray(warnings) ? warnings : []).filter((item) => typeof item === "string" && item);
  warningLists.set(id, list);
  container.hidden = !list.length;
  list.forEach((warning) => container.append(el("p", "", t(warning))));
}

function clearNetworkProfiles(clearCredentials = false) {
  network.profileController?.abort();
  network.profileController = null;
  network.profileEpoch += 1;
  network.profiles = [];
  network.deviceInfo = null;
  if (clearCredentials) {
    $("network-username").value = "";
    $("network-password").value = "";
  }
  $("network-include-credentials").checked = false;
  $("network-profiles").replaceChildren();
  $("network-main-profile").replaceChildren();
  $("network-preview-profile").replaceChildren();
  $("network-third-profile")?.replaceChildren();
  $("network-stream-tools").hidden = true;
  $("network-recording-pair").hidden = true;
  $("network-device-info").hidden = true;
  $("network-device-info").replaceChildren();
  $("network-profile-progress").hidden = true;
  $("network-read-profiles").disabled = false;
  setText("network-profile-error", "");
  showWarnings("network-profile-warnings", []);
}

function resetModalProfiles() {
  network.modalController?.abort();
  network.modalController = null;
  network.modalEpoch += 1;
  network.modalProfiles = [];
  $("onvif-password").value = "";
  $("onvif-username").value = "";
  $("onvif-include-credentials").checked = false;
  $("onvif-profiles").replaceChildren();
  $("onvif-stream-tools").hidden = true;
  const button = $("onvif-form").querySelector("button[type=submit]");
  button.disabled = false;
  button.textContent = t("Find profiles");
}

function resetNetwork() {
  cancelNetworkScan(false);
  clearNetworkProfiles(true);
  resetModalProfiles();
  network.devices = [];
  network.selected = null;
  network.interfaces = [];
  network.interfacesLoaded = false;
  network.interfaceEpoch += 1;
  $("network-interface").replaceChildren(el("option", "", t("Automatic · all available interfaces")));
  $("network-interface").firstChild.value = "";
  $("network-manual-endpoint").value = "";
  $("network-cidr").value = "";
  $("network-endpoint").replaceChildren();
  $("copy-value").value = "";
  renderNetworkDevices();
  $("network-device-explorer").hidden = true;
  $("network-select-placeholder").hidden = false;
  showWarnings("network-warnings", []);
  setText("network-error", "");
  showView("recorder");
}

async function loadNetworkInterfaces() {
  if (network.interfacesLoaded) return;
  const request = ++network.interfaceEpoch;
  const authEpoch = state.authEpoch;
  try {
    const data = await api("/api/onvif/interfaces");
    if (request !== network.interfaceEpoch || authEpoch !== state.authEpoch || !state.authenticated) return;
    network.interfaces = Array.isArray(data) ? data : [];
    network.interfacesLoaded = true;
    const select = $("network-interface"), previous = select.value;
    select.replaceChildren(el("option", "", t("Automatic · all available interfaces")));
    select.firstChild.value = "";
    network.interfaces.forEach((item) => {
      const option = el("option", "", `${item.name} · ${item.address}${item.cidr ? ` · ${item.cidr}` : ""}`);
      option.value = item.address;
      select.append(option);
    });
    select.value = previous;
    suggestNetworkCidr();
  } catch (error) {
    if (request === network.interfaceEpoch) setText("network-error", t("Interfaces unavailable: {error} You can still try automatic discovery or a manual endpoint.", {error: errorText(error)}));
  }
}

function suggestNetworkCidr() {
  const item = network.interfaces.find((entry) => entry.address === $("network-interface").value) || network.interfaces[0];
  if (!item) return;
  const prefix = Number(String(item.cidr || "").split("/")[1]);
  $("network-cidr").value = prefix >= 24 ? item.cidr : `${String(item.address).split(".").slice(0, 3).join(".")}.0/24`;
}

function setScanBusy(busy) {
  $("network-discover").disabled = busy;
  $("network-scan").disabled = busy;
  $("network-interface").disabled = busy;
  $("network-cancel").hidden = !busy;
  $("network-progress").hidden = !busy;
}

function cancelNetworkScan(announce = true) {
  const wasRunning = !!network.scanController;
  network.scanEpoch += 1;
  network.scanController?.abort();
  network.scanController = null;
  clearInterval(network.scanTimer);
  network.scanTimer = null;
  network.scanProgress = null;
  setScanBusy(false);
  if (wasRunning && !network.devices.length) renderNetworkDevices(t("Search cancellation requested. Wait for server confirmation before starting another search."));
  if (wasRunning && state.authenticated) {
    const authEpoch = state.authEpoch, cancelEpoch = network.scanEpoch;
    if (announce) toast(t("Search cancellation requested."));
    // Closing the HTTP response alone may leave the server's discovery task
    // running. Explicit cancellation releases that task and its discovery lock.
    api("/api/onvif/cancel", {method: "POST", body: {}}).then((result) => {
      if (!state.authenticated || authEpoch !== state.authEpoch || cancelEpoch !== network.scanEpoch) return;
      if (typeof result?.cancelled === "boolean" && !network.devices.length) renderNetworkDevices(t("Search closed. You can start another search or enter an endpoint manually."));
    }).catch(() => {
      // Completion/cancellation races (including 499) are benign. Keep the
      // request wording; a later search will report any still-active lock.
    });
  }
}

async function runNetworkScan(mode) {
  if (network.scanController) return;
  let payload;
  if (mode === "scan") {
    const cidr = $("network-cidr").value.trim();
    const parts = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    const ports = [...new Set($("network-ports").value.split(",").map((value) => Number(value.trim())))];
    if (!parts || parts[1].split(".").some((value) => Number(value) > 255) || Number(parts[2]) < 24 || Number(parts[2]) > 32) {
      setText("network-error", t("Enter a valid IPv4 network with a prefix from /24 to /32 (up to 256 addresses).")); return;
    }
    if (!ports.length || ports.length > 8 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      setText("network-error", t("Enter 1 to 8 valid ports, separated by commas (1 to 65535).")); return;
    }
    payload = {cidr, ports};
  } else payload = {interface_ip: $("network-interface").value || null, timeout: 6};
  const request = ++network.scanEpoch, authEpoch = state.authEpoch;
  const controller = new AbortController();
  network.scanController = controller;
  clearNetworkProfiles(true);
  network.selected = null;
  network.devices = [];
  renderNetworkDevices(t("Searching. Results will appear when the search finishes."));
  $("network-device-explorer").hidden = true;
  $("network-select-placeholder").hidden = false;
  setText("network-error", "");
  showWarnings("network-warnings", []);
  setScanBusy(true);
  const started = Date.now();
  const progress = () => setText("network-progress-label", t("{search} in progress · {seconds} s", {search: mode === "scan" ? t("IP range search") : t("ONVIF multicast search"), seconds: number(Math.floor((Date.now() - started) / 1000))}));
  network.scanProgress = progress;
  progress();
  network.scanTimer = setInterval(progress, 1000);
  try {
    const data = await api(`/api/onvif/${mode}`, {method: "POST", body: payload, signal: controller.signal});
    if (request !== network.scanEpoch || authEpoch !== state.authEpoch || network.view !== "network" || !state.authenticated) return;
    network.devices = Array.isArray(data?.devices) ? data.devices : [];
    showWarnings("network-warnings", data?.warnings);
    renderNetworkDevices(t("No devices found. Check that ONVIF is enabled, camera and server share the same LAN, and the firewall, bridge or LXC container allows traffic. Try an IP range or enter an endpoint manually."));
    toast(t(Number.isFinite(data?.duration) ? network.devices.length === 1 ? "{count} device found in {seconds} s." : "{count} devices found in {seconds} s." : network.devices.length === 1 ? "{count} device found." : "{count} devices found.", {count: number(network.devices.length), seconds: number(data?.duration, {maximumFractionDigits: 1})}));
  } catch (error) {
    if (error.name !== "AbortError" && request === network.scanEpoch) {
      setText("network-error", errorText(error));
      renderNetworkDevices(t("Search did not finish. Check server connectivity or enter an endpoint manually."));
    }
  } finally {
    if (request === network.scanEpoch) {
      clearInterval(network.scanTimer); network.scanTimer = null; network.scanProgress = null; network.scanController = null; setScanBusy(false);
    }
  }
}

function renderNetworkDevices(emptyMessage = t("Start a search or enter an ONVIF endpoint.")) {
  network.emptyMessage = translatedMessages.get(emptyMessage) || {key: emptyMessage};
  const list = $("network-devices");
  list.replaceChildren();
  setText("network-device-count", number(network.devices.length));
  if (!network.devices.length) {
    const empty = el("div", "network-device-empty");
    empty.append(icon("network"), el("strong", "", t("Explore your network.")), el("p", "", emptyMessage));
    list.append(empty);
  }
  network.devices.forEach((device, index) => {
    const row = el("button", `network-device-row${device === network.selected ? " active" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(device === network.selected));
    const copy = el("span");
    copy.append(el("strong", "", device.name || device.hardware || device.ip || t("Device {number}", {number: number(index + 1)})), el("small", "", `${device.ip || "ONVIF"}${device.manual ? t(" · manual endpoint") : ""}`));
    row.append(icon("camera"), copy, el("span", "device-chevron", "›"));
    row.addEventListener("click", () => chooseNetworkDevice(device));
    list.append(row);
  });
}

function chooseNetworkDevice(device) {
  if (network.selected === device) return;
  clearNetworkProfiles(true);
  network.selected = device;
  const endpoints = [...new Set([device.endpoint, ...(Array.isArray(device.xaddrs) ? device.xaddrs : [])].filter((value) => typeof value === "string" && value))];
  $("network-endpoint").replaceChildren();
  endpoints.forEach((endpoint) => { const option = el("option", "", endpoint); option.value = endpoint; $("network-endpoint").append(option); });
  setText("network-device-name", device.name || device.hardware || device.ip || t("ONVIF device"));
  setText("network-device-address", device.ip || t("Manual endpoint"));
  setText("network-device-description", [device.hardware, device.location].filter(Boolean).join(" · "));
  $("network-select-placeholder").hidden = true;
  $("network-device-explorer").hidden = false;
  $("network-read-profiles").disabled = !endpoints.length;
  if (!endpoints.length) setText("network-profile-error", t("The device did not advertise an endpoint. Enter it manually in the field above."));
  renderNetworkDevices();
}

async function readNetworkProfiles(event) {
  event.preventDefault();
  if (!network.selected || !$("network-endpoint").value) return;
  clearNetworkProfiles(false);
  const request = ++network.profileEpoch, authEpoch = state.authEpoch;
  const controller = new AbortController();
  network.profileController = controller;
  $("network-read-profiles").disabled = true;
  $("network-profile-progress").hidden = false;
  try {
    const data = await api("/api/onvif/profiles", {method: "POST", signal: controller.signal, body: {
      endpoint: $("network-endpoint").value, username: $("network-username").value,
      password: $("network-password").value,
    }});
    if (request !== network.profileEpoch || authEpoch !== state.authEpoch || !state.authenticated) return;
    network.profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    showWarnings("network-profile-warnings", data?.warnings);
    renderDeviceInfo(data?.device);
    if (!network.profiles.length) setText("network-profile-error", t("No profiles returned. Check the endpoint, ONVIF credentials and camera user permissions."));
    else if (data?.success === false) setText("network-profile-error", t("Profiles found, but no usable URLs. Each profile’s details may help identify the problem."));
    renderNetworkProfiles(true);
  } catch (error) {
    if (error.name !== "AbortError" && request === network.profileEpoch) setText("network-profile-error", errorText(error));
  } finally {
    if (request === network.profileEpoch) { network.profileController = null; $("network-read-profiles").disabled = false; $("network-profile-progress").hidden = true; }
  }
}

function renderDeviceInfo(device) {
  network.deviceInfo = device;
  const list = $("network-device-info");
  list.replaceChildren();
  const labels = {manufacturer: t("Manufacturer"), model: t("Model"), firmware: t("Firmware"), serial_number: t("Serial number"), hardware_id: t("Hardware")};
  Object.entries(labels).forEach(([key, label]) => {
    if (!device?.[key]) return;
    const pair = el("div"); pair.append(el("dt", "", label), el("dd", "", device[key])); list.append(pair);
  });
  list.hidden = !list.childElementCount;
}

function profileRole(profile) {
  return profile.role === "main" ? t("Suggested main stream") : profile.role === "sub" ? t("Suggested substream") : t("Other profile");
}

function cleanStreamUrl(profile) {
  const source = profile.clean_url || profile.url || "";
  try { const url = new URL(source); url.username = ""; url.password = ""; return url.href; }
  catch (_) { return profile.clean_url || ""; }
}

function streamUrl(profile, includeCredentials = false) {
  return includeCredentials ? profile.url || profile.clean_url || "" : cleanStreamUrl(profile);
}

function buildStreamCard(profile, index, mode) {
  const isNetwork = mode === "network";
  const includeCredentials = $(isNetwork ? "network-include-credentials" : "onvif-include-credentials").checked;
  const available = !!(profile.url || profile.clean_url);
  const card = el("article", "stream-card");
  card.dataset.profileIndex = String(index);
  const heading = el("div", "stream-card-heading");
  const title = el("div");
  title.append(el("h4", "", profile.name || t("Profile {number}", {number: number(index + 1)})), el("small", "", `${profile.service || "ONVIF"} · ${profile.token || t("Token unavailable")}`));
  heading.append(title, el("span", `badge ${profile.role === "main" ? "" : "neutral"}`, profileRole(profile)));
  card.append(heading);
  const metadata = [profile.encoding, profile.width && profile.height ? `${number(profile.width)} × ${number(profile.height)}` : "", profile.fps ? t("{fps} fps", {fps: number(profile.fps)}) : "", profile.bitrate ? t("Limit {bitrate} kb/s", {bitrate: number(profile.bitrate)}) : "", profile.video_source ? t("Source {source}", {source: profile.video_source}) : ""].filter(Boolean);
  card.append(el("p", "stream-metadata", metadata.join(" · ") || t("Video metadata unavailable")));
  if (profile.role_basis) card.append(el("p", "field-help", t(profile.role_basis)));
  if (profile.error) card.append(el("p", "form-error", t(profile.error)));
  if (available) {
    const input = el("input", "stream-url"); input.readOnly = true; input.value = streamUrl(profile, includeCredentials);
    input.setAttribute("aria-label", t("URL for profile {profile}", {profile: profile.name || number(index + 1)})); input.spellcheck = false;
    input.addEventListener("focus", () => input.select());
    card.append(input);
  } else card.append(el("p", "field-help", t("URL unavailable for this profile.")));
  const actions = el("div", "stream-actions");
  const copy = el("button", "button secondary small-button"); copy.type = "button"; copy.disabled = !available;
  copy.append(icon("copy"), document.createTextNode(t("Copy URL")));
  copy.addEventListener("click", () => copyStreamText(streamUrl(profile, $(isNetwork ? "network-include-credentials" : "onvif-include-credentials").checked)));
  actions.append(copy);
  ["main", "preview", "third"].forEach((target) => {
    const button = el("button", "button quiet small-button", target === "main" ? t("Use for recording") : target === "preview" ? t("Use for preview") : t("Use as third stream"));
    button.type = "button"; button.disabled = !available; button.dataset.streamTarget = target;
    button.addEventListener("click", () => {
      if (isNetwork) {
        $(`network-${target}-profile`).value = String(index);
        updateProfilePair();
      } else {
        const field = target === "main" ? "url" : target === "preview" ? "preview_url" : "third_url";
        const source = profile.url || profile.clean_url || "";
        if (cameraEditorController()) cameraEditor.setSources({[field]: source});
        else $(target === "main" ? "camera-url" : target === "preview" ? "camera-preview-url" : "camera-third-url").value = source;
        if (target === "preview") { $("clear-preview").checked = false; $("camera-preview-url").disabled = false; }
        $("onvif-dialog").close();
        toast(target === "main" ? t("Main stream entered. Save the camera to record.") : target === "preview" ? t("Preview stream entered. Save the configuration.") : t("Third stream entered. Save the configuration."));
      }
    });
    actions.append(button);
  });
  card.append(actions);
  return card;
}

function renderModalProfiles() {
  $("onvif-profiles").replaceChildren(...network.modalProfiles.map((profile, index) => buildStreamCard(profile, index, "modal")));
  $("onvif-stream-tools").hidden = !network.modalProfiles.length;
  $("onvif-copy-all").disabled = !network.modalProfiles.some((profile) => profile.url || profile.clean_url);
}

function renderNetworkProfiles(resetPair = false) {
  $("network-profiles").replaceChildren(...network.profiles.map((profile, index) => buildStreamCard(profile, index, "network")));
  $("network-stream-tools").hidden = !network.profiles.length;
  const available = network.profiles.map((profile, index) => ({profile, index})).filter(({profile}) => profile.url || profile.clean_url);
  setText("network-profile-count", t(network.profiles.length === 1 ? "{profiles} profile · {urls} URLs available" : "{profiles} profiles · {urls} URLs available", {profiles: number(network.profiles.length), urls: number(available.length)}));
  $("network-copy-all").disabled = !available.length;
  $("network-recording-pair").hidden = !available.length;
  if (resetPair) {
    $("network-main-profile").replaceChildren();
    $("network-preview-profile").replaceChildren(el("option", "", t("None · use the main stream")));
    $("network-preview-profile").firstChild.value = "";
    $("network-third-profile").replaceChildren(el("option", "", t("No third stream")));
    $("network-third-profile").firstChild.value = "";
    available.forEach(({profile, index}) => {
      ["network-main-profile", "network-preview-profile", "network-third-profile"].forEach((id) => {
        const option = el("option", "", `${profile.name || t("Profile {number}", {number: number(index + 1)})} · ${profile.encoding || t("Video")}${profile.width ? ` · ${profile.width} × ${profile.height}` : ""}`);
        option.value = String(index); $(id).append(option);
      });
    });
    const main = available.find(({profile}) => profile.role === "main") || available[0];
    const preview = available.find(({profile, index}) => profile.role === "sub" && index !== main?.index && main?.profile.video_source && profile.video_source === main.profile.video_source);
    $("network-main-profile").value = main ? String(main.index) : "";
    $("network-preview-profile").value = preview ? String(preview.index) : "";
    $("network-third-profile").value = "";
  }
  updateProfilePair();
}

function updateProfilePair() {
  document.querySelectorAll("#network-profiles .stream-card").forEach((card) => {
    ["main", "preview", "third"].forEach((target) => {
      const selected = $(`network-${target}-profile`).value === card.dataset.profileIndex;
      const button = card.querySelector(`[data-stream-target="${target}"]`);
      button.classList.toggle("chosen", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  });
  const selected = ["main", "preview", "third"].map((target) => $(`network-${target}-profile`).value)
    .filter((value) => value !== "").map((value) => network.profiles[Number(value)]).filter(Boolean);
  $("network-pair-note").hidden = new Set(selected.map((profile) => profile.video_source).filter(Boolean)).size <= 1;
}

async function copyStreamText(value) {
  if (!value) return;
  const authEpoch = state.authEpoch, profileEpoch = network.profileEpoch, modalEpoch = network.modalEpoch;
  const stillCurrent = () => state.authenticated && authEpoch === state.authEpoch && profileEpoch === network.profileEpoch && modalEpoch === network.modalEpoch;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); if (stillCurrent()) toast(t("URLs copied to the clipboard.")); return; } catch (_) { /* HTTP LAN and browser permissions may require manual copying. */ }
  }
  if (!stillCurrent()) return;
  $("copy-value").value = value;
  if (!$("copy-dialog").open) $("copy-dialog").showModal();
  $("copy-value").focus(); $("copy-value").select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) { /* The selected field remains available. */ }
  if (copied) { $("copy-dialog").close(); toast(t("URLs copied to the clipboard.")); }
  else setText("copy-dialog-message", t("Automatic copying is unavailable in this browser. The text is selected: use Ctrl+C, ⌘C or your device’s Copy command."));
}

function copyAllProfiles(mode) {
  const profiles = mode === "network" ? network.profiles : network.modalProfiles;
  const includeCredentials = $(mode === "network" ? "network-include-credentials" : "onvif-include-credentials").checked;
  copyStreamText(profiles.map((profile) => streamUrl(profile, includeCredentials)).filter(Boolean).join("\n"));
}

function addNetworkCamera() {
  const main = network.profiles[Number($("network-main-profile").value)];
  const previewValue = $("network-preview-profile").value;
  const preview = previewValue === "" ? null : network.profiles[Number(previewValue)];
  const thirdValue = $("network-third-profile").value;
  const third = thirdValue === "" ? null : network.profiles[Number(thirdValue)];
  if (!main || !(main.url || main.clean_url)) return;
  // Always create a new draft; never overwrite the recorder's selected camera.
  openCameraDialog();
  $("camera-name").value = String(network.selected?.name || network.selected?.hardware || network.selected?.ip || t("ONVIF camera")).slice(0, 80);
  $("camera-url").value = main.url || main.clean_url;
  $("camera-preview-url").value = preview ? preview.url || preview.clean_url || "" : "";
  if ($("camera-third-url")) $("camera-third-url").value = third ? third.url || third.clean_url || "" : "";
  cameraEditorController()?.setSources({url: main.url || main.clean_url,
    preview_url: preview ? preview.url || preview.clean_url || "" : "",
    third_url: third ? third.url || third.clean_url || "" : ""});
}

async function deleteCamera() {
  if (!state.editingId) return;
  $("confirm-delete").disabled = true;
  setText("delete-error", "");
  try {
    await api(`/api/cameras/${encodeURIComponent(state.editingId)}`, {method: "DELETE"});
    $("delete-dialog").close(); $("camera-dialog").close();
    await refresh(true, true);
    toast(t("Camera removed. Existing recordings remain on disk."));
  } catch (error) { setText("delete-error", errorText(error)); }
  finally { $("confirm-delete").disabled = false; }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("login-form").querySelector("button");
  button.disabled = true; setText("login-error", "");
  try { await api("/api/login", {method: "POST", body: {password: $("password").value}}); await enterApp(); }
  catch (error) { setText("login-error", errorText(error)); }
  finally { button.disabled = false; }
});
["logout", "logout-mobile"].forEach((id) => $(id).addEventListener("click", async () => {
  try { await api("/api/logout", {method: "POST"}); showLogin(); }
  catch (error) { globalError(errorText(error)); }
}));
["add-camera", "add-camera-small", "add-first-camera"].forEach((id) => $(id).addEventListener("click", () => openCameraDialog()));
$("edit-camera").addEventListener("click", () => openCameraDialog(selectedCamera()));
$("refresh").addEventListener("click", async () => {
  const button = $("refresh"), authEpoch = state.authEpoch;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (state.rangeFollowsNow) $("search-end").value = localInput(new Date(Date.now() + 60000));
  syncArchiveFilters();
  try {
    await refresh(true, true);
    if (!state.authenticated || state.authEpoch !== authEpoch) return;
    if (network.view === "recorder") await loadRecordings();
    if ($("global-error").hidden) toast(t("View updated."));
  } finally { button.disabled = false; button.removeAttribute("aria-busy"); }
});
$("toggle-live").addEventListener("click", toggleLive);
$("live-image").addEventListener("error", () => { if (state.live) { stopLive(); toast(t("Preview unavailable. Check the stream and FFmpeg on the server.")); } });
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.archiveRequest += 1; state.archiveController?.abort(); state.archiveController = null;
  const cameraId = $("archive-camera")?.value || state.selectedId;
  if (!prepareArchiveSearch() || !state.cameras.some((camera) => camera.id === cameraId)) {
    archiveError(t("Choose a camera, date and valid start and end times."));
    $("search-form").querySelector("button[type=submit]").disabled = !state.cameras.length;
    return;
  }
  state.rangeFollowsNow = false;
  if (cameraId !== state.selectedId) {
    clearPlayer(); state.selectedId = cameraId; state.recordings = []; state.range = null; state.timelineWindow = null;
    renderCameras(); renderSelected(); renderRecordings();
  }
  loadRecordings();
});
["archive-date", "archive-from", "archive-to", "archive-camera"].forEach((id) => $(id)?.addEventListener("input", () => {
  state.archiveFiltersDirty = true;
  $("search-form").querySelector("button[type=submit]").disabled = !state.cameras.length;
}));
$("timeline-zoom-in")?.addEventListener("click", () => zoomTimeline(.5));
$("timeline-zoom-out")?.addEventListener("click", () => zoomTimeline(2));
$("camera-form").addEventListener("submit", saveCamera);
$("probe-camera").addEventListener("click", probeCamera);
$("camera-probe-stream")?.addEventListener("change", () => {
  cancelCameraProbe();
  $("probe-result").hidden = true;
  $("probe-camera").disabled = false;
});
$("open-onvif").addEventListener("click", () => {
  resetModalProfiles();
  $("onvif-form").reset(); $("onvif-profiles").replaceChildren(); setText("onvif-error", "");
  showWarnings("onvif-warnings", []);
  const host = $("camera-host")?.value.trim();
  if (host) {
    try {
      const configuredProtocol = $("camera-protocol")?.value;
      const protocol = configuredProtocol === "https" ? "https" : "http";
      const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      const endpoint = new URL(`${protocol}://${address}`);
      if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error();
      if (["http", "https"].includes(configuredProtocol)) endpoint.port = $("camera-port")?.value || "";
      endpoint.pathname = "/onvif/device_service";
      $("onvif-endpoint").value = endpoint.href;
      $("onvif-username").value = $("camera-username")?.value || "";
      $("onvif-password").value = $("camera-password")?.value || "";
    } catch (_) { /* Keep the editable endpoint empty for an incomplete host. */ }
  }
  $("onvif-dialog").showModal();
  $("onvif-dialog").querySelector(".modal-body").scrollTop = 0;
});
$("onvif-form").addEventListener("submit", findOnvifProfiles);
$("onvif-dialog").addEventListener("close", resetModalProfiles);
$("nav-recorder").addEventListener("click", () => showView("recorder"));
$("record-tab-archive")?.addEventListener("click", () => showView("recorder"));
$("nav-monitor").addEventListener("click", () => showView("monitor"));
$("nav-cameras")?.addEventListener("click", () => showView("cameras"));
$("cameras-add")?.addEventListener("click", () => openCameraDialog());
$("live-tab-monitor")?.addEventListener("click", () => showView("monitor"));
$("live-tab-layout")?.addEventListener("click", () => showView("layout"));
$("nav-settings")?.addEventListener("click", () => showView("settings"));
$("monitor-toggle").addEventListener("click", () => { monitor.playing = !monitor.playing; syncMonitorPlayers(); loadMonitorStatus(); });
$("monitor-find-cameras").addEventListener("click", () => { showView("network"); loadNetworkInterfaces(); });
document.querySelectorAll("[data-monitor-layout]").forEach((button) => button.addEventListener("click", () => {
  const size = Number(button.dataset.monitorLayout);
  if (![1, 4, 9, 16].includes(size)) return;
  if (ensureLiveLayout()) liveLayout.applySize(size);
  else { monitor.layout = size; renderMonitor(); }
}));
window.addEventListener("nvr-monitor-layoutchange", (event) => {
  const layout = Number(event.detail?.layout);
  if (![1, 4, 9, 16].includes(layout)) return;
  if (!state.authenticated) return;
  if (ensureLiveLayout()) liveLayout.applySize(layout);
  else { monitor.layout = layout; if (network.view === "monitor") renderMonitor(); }
});
$("monitor-fullscreen")?.addEventListener("click", async () => {
  const grid = $("monitor-grid");
  const authEpoch = state.authEpoch;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (grid.requestFullscreen) {
      await grid.requestFullscreen();
      if ((!state.authenticated || state.authEpoch !== authEpoch || network.view !== "monitor") && document.fullscreenElement === grid) await document.exitFullscreen();
    } else toast(t("Fullscreen is unavailable in this browser."));
  } catch (_) { toast(t("The browser did not allow fullscreen.")); }
});
$("monitor-previous").addEventListener("click", () => { monitor.page -= 1; renderMonitor(); });
$("monitor-next").addEventListener("click", () => { monitor.page += 1; renderMonitor(); });
document.addEventListener("fullscreenchange", () => {
  monitor.fullscreenId = document.fullscreenElement?.dataset.cameraId || null;
  if (network.view === "monitor") syncMonitorPlayers();
});
$("nav-network").addEventListener("click", () => { showView("network"); loadNetworkInterfaces(); });
$("network-back").addEventListener("click", () => showView("recorder"));
$("network-interface").addEventListener("change", suggestNetworkCidr);
$("network-discover").addEventListener("click", () => runNetworkScan("discover"));
$("network-cancel").addEventListener("click", () => cancelNetworkScan());
$("network-scan-form").addEventListener("submit", (event) => { event.preventDefault(); runNetworkScan("scan"); });
$("network-manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const endpoint = $("network-manual-endpoint").value.trim();
  let url;
  try { url = new URL(endpoint); } catch (_) { setText("network-error", t("Enter a valid HTTP or HTTPS endpoint.")); return; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    setText("network-error", t("Use an HTTP or HTTPS endpoint without credentials in the address; enter them in the device fields.")); return;
  }
  cancelNetworkScan(false);
  setText("network-error", "");
  let device = network.devices.find((item) => item.endpoint === endpoint);
  if (!device) { device = {id: `manual:${endpoint}`, ip: url.hostname, name: url.hostname, endpoint, xaddrs: [endpoint], manual: true}; network.devices.push(device); }
  chooseNetworkDevice(device);
});
$("network-profile-form").addEventListener("submit", readNetworkProfiles);
$("network-endpoint").addEventListener("change", () => clearNetworkProfiles(true));
["network-username", "network-password"].forEach((id) => $(id).addEventListener("input", () => clearNetworkProfiles(false)));
["onvif-endpoint", "onvif-username", "onvif-password"].forEach((id) => $(id).addEventListener("input", () => {
  network.modalController?.abort(); network.modalController = null; network.modalEpoch += 1; network.modalProfiles = [];
  $("onvif-profiles").replaceChildren(); $("onvif-stream-tools").hidden = true;
  setText("onvif-error", ""); showWarnings("onvif-warnings", []);
  const button = $("onvif-form").querySelector("button[type=submit]"); button.disabled = false; button.textContent = t("Find profiles");
}));
$("network-include-credentials").addEventListener("change", () => renderNetworkProfiles());
$("onvif-include-credentials").addEventListener("change", renderModalProfiles);
$("network-copy-all").addEventListener("click", () => copyAllProfiles("network"));
$("onvif-copy-all").addEventListener("click", () => copyAllProfiles("modal"));
["network-main-profile", "network-preview-profile", "network-third-profile"].forEach((id) => $(id)?.addEventListener("change", updateProfilePair));
$("network-add-recorder").addEventListener("click", addNetworkCamera);
$("copy-dialog").addEventListener("close", () => { $("copy-value").value = ""; });
$("camera-dialog").addEventListener("close", () => {
  cameraDialogEpoch += 1;
  cancelCameraProbe();
  cameraEditor?.setCamera(null);
  $("camera-url").value = ""; $("camera-preview-url").value = "";
  if ($("camera-third-url")) $("camera-third-url").value = "";
});
$("delete-camera").addEventListener("click", () => { setText("delete-error", ""); $("delete-dialog").showModal(); });
$("confirm-delete").addEventListener("click", deleteCamera);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
$("clear-preview").addEventListener("change", () => { $("camera-preview-url").disabled = $("clear-preview").checked; });
$("compatible").addEventListener("change", () => {
  if (!state.recording) return;
  const recording = state.recording, offset = player.currentTime, autoplay = !player.paused;
  state.recording = null;
  selectRecording(recording, offset, autoplay);
});
player.addEventListener("timeupdate", updateWaveformCursor);
player.addEventListener("timeupdate", updatePlaybackCursors);
player.addEventListener("seeked", updatePlaybackCursors);
player.addEventListener("timeupdate", () => motionTrack?.setTime(player.currentTime));
player.addEventListener("seeked", () => motionTrack?.setTime(player.currentTime));
player.addEventListener("error", () => {
  if (!state.recording) return;
  if ($("record-loading")) $("record-loading").hidden = true;
  archiveError($("compatible").checked
    ? t("Playback unavailable. Check the file and FFmpeg service on the server; you can download the original recording.")
    : t("Your browser may not support this codec. Try compatible H.264 playback or download the original file."));
});
player.addEventListener("ended", () => {
  if (!state.recording) return;
  const current = state.recording;
  const next = state.recordings.find((item) => item.started_at > current.started_at);
  if (next && next.started_at <= current.started_at + current.duration + 2) selectRecording(next);
  else if (next) toast(t("End of segment. There is a gap before the next recording."));
});
$("waveform").addEventListener("click", (event) => {
  if (!state.recording || !state.waveform?.peaks?.length) return;
  const rect = $("waveform").getBoundingClientRect();
  seekPlayer((event.clientX - rect.left) / rect.width * Number(state.waveform.duration || state.recording.duration));
});
$("waveform").addEventListener("keydown", (event) => {
  if (!state.recording || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const offset = event.key === "Home" ? 0 : event.key === "End" ? state.recording.duration : player.currentTime + (event.key === "ArrowRight" ? 5 : -5);
  seekPlayer(offset);
});
$("timeline").addEventListener("click", timelineSeek);
$("timeline").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !state.recordings.length) return;
  event.preventDefault();
  const current = state.recordings.findIndex((recording) => recording.id === state.recording?.id);
  const index = event.key === "Home" ? 0 : event.key === "End" ? state.recordings.length - 1 : Math.max(0, Math.min(state.recordings.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
  selectRecording(state.recordings[index]);
});
window.addEventListener("resize", () => { drawWaveform(); drawTimeline(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLive();
  if (network.view === "monitor") { syncMonitorPlayers(); if (!document.hidden) loadMonitorStatus(); }
  if (network.view === "layout") { if (document.hidden) liveLayout?.close(); else if (state.authenticated) liveLayout?.open(); }
});
window.addEventListener("pagehide", () => { stopLive(); player.pause(); releaseMonitor(); liveLayout?.close(); });
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || !state.authenticated) return;
  if (network.view === "monitor") renderMonitor();
  else if (network.view === "layout") liveLayout?.open();
});

const now = new Date();
const today = new Date(now); today.setHours(0, 0, 0, 0);
$("search-start").value = localInput(today);
$("search-end").value = localInput(new Date(now.getTime() + 60000));
syncArchiveFilters();

window.addEventListener("nvr-recording-settingschange", (event) => {
  const duration = event.detail?.segment_seconds;
  if (!state.authenticated || !Number.isInteger(duration) || duration < 60 || duration > 7200) return;
  state.recordingDuration = duration; state.recordingSettingsRevision += 1;
  if (state.system) { state.system.segment_seconds = duration; renderSystem(); }
});

window.addEventListener("nvr-languagechange", () => {
  // Relabel existing state. Do not navigate, reset drafts, cancel discovery,
  // reload the archive video, or replace active live player instances.
  messageBindings.forEach(({key, params}, id) => {
    const values = params ? {...params} : undefined;
    ["message", "error", "search"].forEach((name) => {
      const nested = values && typeof values[name] === "string" && translatedMessages.get(values[name]);
      if (nested) values[name] = t(nested.key, nested.params);
    });
    if ($(id)) $(id).textContent = t(key, values);
  });
  motionTrack?.relabel();
  liveLayout?.relabel();
  cameraEditor?.relabel();
  setText("current-view-label", t(({recorder: "Record", monitor: "Monitor", layout: "Layout", cameras: "Cameras", network: "Network", settings: "Settings"})[network.view] || "Monitor"));
  $("toggle-live").replaceChildren(icon(state.live ? "close" : "play"), document.createTextNode(t(state.live ? "Close preview" : "Open preview")));
  $("onvif-form").querySelector("button[type=submit]").textContent = t(network.modalController ? "Reading profiles…" : "Find profiles");
  const automatic = $("network-interface").options[0];
  if (automatic) automatic.textContent = t("Automatic · all available interfaces");
  if ($("camera-dialog").open) {
    setText("camera-dialog-title", t(state.editingId ? "Configure camera" : "Add camera"));
    $("camera-url").placeholder = state.editingId ? t("Leave blank to keep the saved stream") : "rtsp://user:password@192.168.1.50:554/stream";
    $("camera-preview-url").placeholder = state.editingId ? t("Leave blank to keep the saved stream") : "rtsp://192.168.1.50:554/substream";
  }
  if (state.authenticated) {
    renderCameras(); renderSelected(); renderStats(); renderSystem();
    if (network.view === "cameras") renderConfiguredCameras();
    renderRecordings(); renderPlayingLabels(); drawTimeline(); drawWaveform();
    const empty = network.emptyMessage;
    renderNetworkDevices(empty ? t(empty.key, empty.params) : t("Start a search or enter an ONVIF endpoint."));
    if (network.selected) {
      const device = network.selected;
      setText("network-device-name", device.name || device.hardware || device.ip || t("ONVIF device"));
      setText("network-device-address", device.ip || t("Manual endpoint"));
    }
    renderDeviceInfo(network.deviceInfo);
    if (network.profiles.length) {
      const main = $("network-main-profile").value, preview = $("network-preview-profile").value, third = $("network-third-profile").value;
      renderNetworkProfiles(true);
      $("network-main-profile").value = main; $("network-preview-profile").value = preview;
      $("network-third-profile").value = third;
      updateProfilePair();
    }
    if (network.modalProfiles.length) renderModalProfiles();
    if (network.view === "monitor") {
      renderMonitor();
      monitor.tiles.forEach((tile) => {
        if (tile.live?.relabel) tile.live.relabel();
        else if (tile.lastInfo) updateMonitorTile(tile, tile.lastInfo);
      });
      const data = monitor.serverStatus;
      if (data) setText("monitor-live-status", t("On the server: {active} / {max} streams · {converted} / {maxConverted} conversions", {active: number(data.active_streams), max: number(data.max_streams), converted: number(data.active_transcodes), maxConverted: number(data.max_transcodes)}));
    }
  }
  warningLists.forEach((warnings, id) => showWarnings(id, warnings));
  network.scanProgress?.();
});
document.body.classList.add("loading");
window.NvrI18n.ready.then(() => api("/api/session")).then((session) => session?.authenticated ? enterApp() : showLogin()).catch((error) => { showLogin(); setText("login-error", errorText(error)); });
