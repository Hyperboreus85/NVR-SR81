"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  authenticated: false, cameras: [], system: null, selectedId: null,
  recordings: [], recording: null, range: null, waveform: null,
  live: false, editingId: null, poll: null, archiveRequest: 0,
  waveformRequest: 0, toastTimer: null, refreshPromise: null, authEpoch: 0,
  rangeFollowsNow: true,
};
const formatDate = new Intl.DateTimeFormat("it-IT", {day: "2-digit", month: "short"});
const formatTime = new Intl.DateTimeFormat("it-IT", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
const formatShortTime = new Intl.DateTimeFormat("it-IT", {hour: "2-digit", minute: "2-digit"});
const player = $("player");
const network = {
  view: "recorder", devices: [], selected: null, profiles: [], modalProfiles: [],
  interfaces: [], interfacesLoaded: false, interfaceEpoch: 0,
  scanEpoch: 0, profileEpoch: 0, modalEpoch: 0,
  scanController: null, profileController: null, modalController: null, scanTimer: null,
};
const monitor = {
  playing: true, layout: 4, page: 0, tiles: new Map(), observer: null,
  fullscreenId: null, audioCameraId: null, statusEpoch: 0,
  statusTimer: null,
};

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
  return error instanceof Error ? error.message : "Si è verificato un errore.";
}

async function api(path, options = {}) {
  const authEpoch = state.authEpoch;
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) headers.set("X-NVR-Request", "1");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(path, {
      ...options, method, headers, credentials: "same-origin", cache: "no-store",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Server non raggiungibile. Controlla la connessione alla rete locale.");
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login" && authEpoch === state.authEpoch) showLogin();
    const detail = typeof data?.detail === "string" ? data.detail
      : Array.isArray(data?.detail) ? data.detail.map((item) => item.msg || "Dato non valido").join(" · ")
      : `Richiesta non riuscita (${response.status}).`;
    throw new Error(detail);
  }
  return data;
}

function bytes(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.max(0, Number(value)), i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return `${n.toLocaleString("it-IT", {maximumFractionDigits: i > 1 ? 1 : 0})} ${units[i]}`;
}

function seconds(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 3600) return `${Math.floor(n / 3600)} h ${Math.floor(n % 3600 / 60)} min`;
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

function setText(id, value) { $(id).textContent = value; }
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
}

function archiveError(message = "") {
  setText("archive-error", message);
  $("archive-error").hidden = !message;
}

function cameraStatus(camera) {
  if (!camera.enabled) return {label: "In pausa", color: "", badge: "neutral", message: "Registrazione disattivata per questa telecamera."};
  const status = camera.status || {};
  const raw = String(status.state || "unknown").toLowerCase();
  if (["recording", "running", "connected"].includes(raw)) return {label: "In registrazione", color: "green", badge: "", message: status.message || "Il registratore sta ricevendo e salvando il flusso."};
  if (["error", "failed", "offline", "backoff", "retrying", "reconnecting", "storage_full"].includes(raw)) return {label: ["retrying", "backoff", "reconnecting"].includes(raw) ? "Riconnessione" : raw === "storage_full" ? "Disco pieno" : "Non disponibile", color: "orange", badge: "error", message: status.message || "Il flusso non è disponibile. Il registratore riproverà a collegarsi."};
  return {label: ["starting", "connecting"].includes(raw) ? "Collegamento" : "In attesa", color: "yellow", badge: "waiting", message: status.message || "In attesa del primo segmento del flusso."};
}

function showLogin() {
  state.authEpoch += 1;
  state.authenticated = false;
  clearInterval(state.poll);
  state.poll = null;
  stopLive();
  clearPlayer();
  state.cameras = [];
  state.selectedId = null;
  state.recordings = [];
  state.range = null;
  state.archiveRequest += 1;
  releaseMonitor();
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
  state.authenticated = true;
  $("login-screen").hidden = true;
  $("app").hidden = false;
  $("password").value = "";
  document.body.classList.remove("loading");
  await refresh(true, true);
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
  const results = await Promise.allSettled([api("/api/cameras"), api("/api/system")]);
  if (!state.authenticated || authEpoch !== state.authEpoch) return;
  const errors = [];
  if (results[0].status === "fulfilled") {
    const previousId = state.selectedId;
    state.cameras = Array.isArray(results[0].value) ? results[0].value : [];
    if (!state.cameras.some((camera) => camera.id === state.selectedId)) state.selectedId = state.cameras[0]?.id || null;
    renderCameras();
    renderSelected();
    if (previousId !== state.selectedId) {
      stopLive();
      clearPlayer();
      state.recordings = [];
      renderRecordings();
      if (state.selectedId) await loadRecordings();
    }
  } else errors.push(errorText(results[0].reason));
  if (results[1].status === "fulfilled") { state.system = results[1].value; renderSystem(); }
  else errors.push(errorText(results[1].reason));
  renderStats();
  if (network.view === "monitor") { renderMonitor(); loadMonitorStatus(); }
  if (showErrors) globalError(errors.join(" "));
}

function renderStats() {
  setText("stat-cameras", String(state.cameras.length));
  setText("stat-enabled", `${state.cameras.filter((camera) => camera.enabled).length} attive`);
  setText("stat-recording", String(state.cameras.filter((camera) => camera.enabled && ["recording", "running", "connected"].includes(camera.status?.state)).length));
  setText("stat-storage", bytes(state.system?.recordings_bytes));
  setText("stat-free", state.system?.disk ? `${bytes(state.system.disk.free)} liberi sul disco` : "Disco non disponibile");
}

function renderCameras() {
  const list = $("camera-list");
  list.replaceChildren();
  if (!state.cameras.length) list.append(el("p", "sidebar-empty", "Il tuo registratore è pronto. Collega la prima telecamera per iniziare."));
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
  setText("camera-audio", camera.audio_mode === "none" ? "Disattivato" : "Originale, se presente");
  setText("camera-retention", `${camera.retention_days} giorni`);
  setText("live-camera-name", camera.name);
}

function renderSystem() {
  const system = state.system;
  if (!system) return;
  setText("version", `SR81 · ${system.version || "locale"}`);
  setText("segment-length", seconds(system.segment_seconds));
  const disk = system.disk;
  if (disk && Number(disk.total) > 0) {
    const percent = Math.min(100, Math.max(0, Number(disk.used) / Number(disk.total) * 100));
    setText("disk-percent", `${percent.toLocaleString("it-IT", {maximumFractionDigits: 0})}% utilizzato`);
    $("disk-fill").style.width = `${percent}%`;
    setText("disk-caption", `${bytes(disk.free)} disponibili di ${bytes(disk.total)}`);
  }
  $("system-warning").hidden = system.ffmpeg_available !== false;
  setText("system-warning", "FFmpeg non è disponibile sul server. Installa FFmpeg e riavvia il registratore per attivare registrazioni, anteprime e riproduzione.");
}

async function selectCamera(id) {
  showView("recorder");
  if (id === state.selectedId) return;
  stopLive();
  clearPlayer();
  state.selectedId = id;
  state.recordings = [];
  state.range = null;
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
  button.replaceChildren(icon("play"), document.createTextNode("Apri anteprima"));
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
  $("toggle-live").replaceChildren(icon("close"), document.createTextNode("Chiudi anteprima"));
}

async function loadRecordings() {
  if (!state.selectedId) return;
  const start = new Date($("search-start").value).getTime() / 1000;
  const end = new Date($("search-end").value).getTime() / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    archiveError("Scegli un intervallo valido: la fine deve essere successiva all’inizio.");
    return;
  }
  const request = ++state.archiveRequest;
  const cameraId = state.selectedId;
  const searchButton = $("search-form").querySelector("button");
  searchButton.disabled = true;
  archiveError();
  try {
    const query = new URLSearchParams({camera_id: cameraId, start: String(start), end: String(end), limit: "10000"});
    const recordings = await api(`/api/recordings?${query}`);
    if (request !== state.archiveRequest || state.selectedId !== cameraId || !state.authenticated) return;
    state.recordings = (Array.isArray(recordings) ? recordings : []).sort((a, b) => a.started_at - b.started_at);
    state.range = {start, end};
    if (state.recordings.length >= 10000) archiveError("Sono mostrati i primi 10.000 segmenti. Restringi l’intervallo per visualizzare e verificare il resto dell’archivio.");
    if (state.recording && !state.recordings.some((recording) => recording.id === state.recording.id)) clearPlayer();
    renderRecordings();
    drawTimeline();
  } catch (error) {
    if (request === state.archiveRequest) archiveError(errorText(error));
  } finally {
    if (request === state.archiveRequest) searchButton.disabled = false;
  }
}

function renderRecordings() {
  const list = $("recordings-list");
  list.replaceChildren();
  const count = state.recordings.length;
  setText("recording-count", `${count} ${count === 1 ? "segmento" : "segmenti"}`);
  setText("recordings-total", bytes(state.recordings.reduce((sum, item) => sum + (Number(item.size) || 0), 0)));
  if (!count) list.append(el("p", "no-recordings", "Nessuna registrazione nell’intervallo selezionato. Prova a cambiare data o attendi il primo segmento completo."));
  state.recordings.forEach((recording) => {
    const row = el("button", `recording-row${recording.id === state.recording?.id ? " active" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(recording.id === state.recording?.id));
    row.setAttribute("aria-label", `Riproduci registrazione del ${timeLabel(recording.started_at, true)}, durata ${seconds(recording.duration)}`);
    const playIcon = el("span", "clip-play");
    playIcon.append(icon("play"));
    const copy = el("span", "clip-copy");
    copy.append(el("strong", "", timeLabel(recording.started_at)), el("small", "", `${formatDate.format(new Date(recording.started_at * 1000))} · ${bytes(recording.size)}`));
    row.append(playIcon, copy, el("span", "clip-duration", seconds(recording.duration)));
    row.addEventListener("click", () => selectRecording(recording));
    list.append(row);
  });
  drawTimeline();
}

function clearPlayer() {
  state.recording = null;
  state.waveform = null;
  state.waveformRequest += 1;
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  $("player-placeholder").hidden = false;
  $("download").hidden = true;
  $("download").removeAttribute("href");
  setText("playing-label", "Nessuna registrazione selezionata");
  setText("playing-codec", "");
  setText("waveform-label", "Seleziona una registrazione");
  $("waveform-cursor").hidden = true;
  drawWaveform();
}

function selectRecording(recording, offset = 0, autoplay = true) {
  const same = state.recording?.id === recording.id;
  state.recording = recording;
  archiveError();
  if (same && player.src && !player.error) {
    seekPlayer(offset);
    if (autoplay) player.play().catch(() => {});
    return;
  }
  player.pause();
  player.hidden = false;
  $("player-placeholder").hidden = true;
  const compatible = $("compatible").checked;
  player.src = `/api/recordings/${encodeURIComponent(recording.id)}/playback?compatible=${compatible}`;
  player.load();
  const source = player.getAttribute("src");
  player.onloadedmetadata = () => {
    if (player.getAttribute("src") !== source) return;
    seekPlayer(offset);
    if (autoplay) player.play().catch(() => {});
  };
  setText("playing-label", timeLabel(recording.started_at, true));
  const videoCodec = String(recording.video_codec || "Video").toUpperCase();
  const audioCodec = recording.audio_codec ? ` · ${String(recording.audio_codec).toUpperCase()}` : " · senza audio";
  setText("playing-codec", `${videoCodec}${audioCodec} · ${seconds(recording.duration)}${compatible ? " · Conversione compatibile" : ""}`);
  $("download").href = `/api/recordings/${encodeURIComponent(recording.id)}/download`;
  $("download").hidden = false;
  renderRecordings();
  if (!same || !state.waveform) loadWaveform(recording);
}

function seekPlayer(offset) {
  if (!Number.isFinite(offset) || offset < 0 || !state.recording) return;
  const duration = Number.isFinite(player.duration) ? player.duration : state.recording.duration;
  try { player.currentTime = Math.max(0, Math.min(offset, Math.max(0, duration - .05))); } catch (_) { /* Metadata may still be loading. */ }
}

async function loadWaveform(recording) {
  const request = ++state.waveformRequest;
  state.waveform = null;
  setText("waveform-label", recording.audio_codec ? "Analisi dell’audio…" : "Nessuna traccia audio");
  drawWaveform();
  if (!recording.audio_codec) return;
  try {
    const waveform = await api(`/api/recordings/${encodeURIComponent(recording.id)}/waveform`);
    if (request !== state.waveformRequest || state.recording?.id !== recording.id) return;
    state.waveform = waveform;
    const peaks = Array.isArray(waveform?.peaks) ? waveform.peaks : [];
    setText("waveform-label", peaks.length ? `${seconds(waveform.duration)} · intensità audio` : "Audio non disponibile");
    drawWaveform();
  } catch (error) {
    if (request !== state.waveformRequest) return;
    setText("waveform-label", "Forma d’onda non disponibile");
    $("waveform-label").title = errorText(error);
  }
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
  context.fillStyle = "#13191c";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#29373f";
  context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
  const peaks = state.waveform?.peaks;
  if (!Array.isArray(peaks) || !peaks.length) return;
  const barCount = Math.max(1, Math.floor(width / 3));
  context.fillStyle = "#bba78e";
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
  const duration = Number(state.waveform?.duration || state.recording?.duration);
  const visible = state.recording && state.waveform?.peaks?.length && duration > 0;
  $("waveform-cursor").hidden = !visible;
  if (visible) $("waveform-cursor").style.left = `${Math.min(100, Math.max(0, player.currentTime / duration * 100))}%`;
}

function drawTimeline() {
  const dimensions = canvasContext("timeline");
  if (!dimensions) return;
  const {context, width, height} = dimensions;
  context.fillStyle = "#202b31";
  context.fillRect(0, 0, width, height);
  if (!state.range) return;
  const {start, end} = state.range;
  const duration = end - start;
  context.strokeStyle = "#34444d";
  context.lineWidth = 1;
  for (let i = 0; i <= 12; i += 1) {
    const x = i / 12 * width;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  state.recordings.forEach((recording) => {
    const from = Math.max(start, recording.started_at);
    const to = Math.min(end, recording.started_at + recording.duration);
    if (to <= from) return;
    context.fillStyle = recording.id === state.recording?.id ? "#ffb184" : "#da7057";
    // Segment width is proportional to its duration; gaps are never filled.
    context.fillRect((from - start) / duration * width, 7, (to - from) / duration * width, height - 14);
  });
  setText("timeline-start", timeLabel(start, true));
  setText("timeline-end", timeLabel(end, true));
}

function timelineSeek(event) {
  if (!state.range) return;
  const rect = $("timeline").getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const time = state.range.start + fraction * (state.range.end - state.range.start);
  const recording = state.recordings.find((item) => time >= item.started_at && time < item.started_at + item.duration);
  if (recording) {
    setText("timeline-message", "I vuoti indicano periodi per cui non sono presenti registrazioni.");
    selectRecording(recording, time - recording.started_at);
  } else setText("timeline-message", `Nessun segmento disponibile alle ${timeLabel(time)}. Seleziona un tratto colorato.`);
}

function openCameraDialog(camera = null) {
  state.editingId = camera?.id || null;
  $("camera-form").reset();
  setText("camera-form-error", "");
  $("probe-result").hidden = true;
  $("camera-url").required = !camera;
  setText("camera-dialog-title", camera ? "Configura telecamera" : "Aggiungi telecamera");
  $("camera-name").value = camera?.name || "";
  $("camera-url").value = "";
  $("camera-url").placeholder = camera ? "Lascia vuoto per mantenere il flusso salvato" : "rtsp://utente:password@192.168.1.50:554/stream";
  $("camera-preview-url").value = "";
  $("camera-preview-url").disabled = false;
  $("camera-preview-url").placeholder = camera ? "Lascia vuoto per mantenere il flusso salvato" : "rtsp://192.168.1.50:554/substream";
  $("camera-audio-mode").value = camera?.audio_mode || "copy";
  $("camera-retention-days").value = camera?.retention_days || 7;
  $("camera-enabled").checked = camera ? camera.enabled : true;
  $("clear-preview-row").hidden = !camera?.preview_source;
  $("stored-source").hidden = !camera;
  setText("stored-source", camera ? `Flusso salvato: ${camera.source || "configurato"}` : "");
  $("delete-camera").hidden = !camera;
  $("probe-camera").hidden = !camera;
  $("camera-dialog").showModal();
}

async function saveCamera(event) {
  event.preventDefault();
  const editingId = state.editingId;
  const url = $("camera-url").value.trim();
  const preview = $("camera-preview-url").value.trim();
  const payload = {
    name: $("camera-name").value.trim(), url: url || (editingId ? null : ""),
    preview_url: $("clear-preview").checked ? "" : (preview || (editingId ? null : "")),
    enabled: $("camera-enabled").checked,
    audio_mode: $("camera-audio-mode").value,
    retention_days: Number($("camera-retention-days").value),
  };
  if (!payload.name) { setText("camera-form-error", "Inserisci un nome per la telecamera."); return; }
  $("save-camera").disabled = true;
  setText("camera-form-error", "");
  try {
    const saved = await api(editingId ? `/api/cameras/${encodeURIComponent(editingId)}` : "/api/cameras", {method: editingId ? "PUT" : "POST", body: payload});
    $("camera-dialog").close();
    showView("recorder");
    if (!editingId && saved?.id) {
      stopLive(); clearPlayer(); state.selectedId = saved.id;
    }
    await refresh(true, true);
    if (!editingId && state.selectedId) await loadRecordings();
    toast(editingId ? "Configurazione aggiornata." : "Telecamera aggiunta. Il registratore proverà a collegarsi al flusso.");
  } catch (error) { setText("camera-form-error", errorText(error)); }
  finally { $("save-camera").disabled = false; }
}

async function probeCamera() {
  if (!state.editingId) return;
  $("probe-camera").disabled = true;
  $("probe-result").hidden = false;
  $("probe-result").className = "probe-result";
  setText("probe-result", "Verifica del flusso salvato in corso…");
  try {
    const data = await api(`/api/cameras/${encodeURIComponent(state.editingId)}/probe`, {method: "POST"});
    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const details = streams.map((stream) => `${stream.codec_type || "flusso"}: ${stream.codec_name || "sconosciuto"}${stream.width ? ` · ${stream.width} × ${stream.height}` : ""}`);
    if (!details.length) {
      if (data?.video_codec) details.push(`Video: ${data.video_codec}`);
      if (data?.audio_codec) details.push(`Audio: ${data.audio_codec}`);
    }
    setText("probe-result", details.length ? `Flusso raggiungibile.\n${details.join("\n")}` : "Flusso raggiungibile. Verifica completata.");
  } catch (error) { $("probe-result").className = "probe-result error"; setText("probe-result", errorText(error)); }
  finally { $("probe-camera").disabled = false; }
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
  button.textContent = "Lettura dei profili…";
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
    if (!network.modalProfiles.length) setText("onvif-error", "Il dispositivo non ha restituito profili video. Verifica che ONVIF sia attivo e che l’utente abbia accesso ai servizi video.");
    renderModalProfiles();
  } catch (error) {
    if (error.name !== "AbortError" && request === network.modalEpoch) setText("onvif-error", errorText(error));
  } finally {
    if (request === network.modalEpoch) { button.disabled = false; button.textContent = "Cerca profili"; network.modalController = null; }
  }
}

function showView(view) {
  network.view = view;
  const isNetwork = view === "network";
  $("recorder-view").hidden = view !== "recorder";
  $("network-view").hidden = !isNetwork;
  $("monitor-view").hidden = view !== "monitor";
  setText("current-view-label", isNetwork ? "Telecamere in rete" : view === "monitor" ? "Monitor live" : "Registratore");
  ["recorder", "monitor", "network"].forEach((name) => {
    const button = $(`nav-${name}`);
    button.classList.toggle("active", name === view);
    if (name === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (view !== "recorder") { stopLive(); player.pause(); }
  if (!isNetwork) {
    cancelNetworkScan(false);
    if (network.profileController) clearNetworkProfiles(false);
    drawTimeline(); drawWaveform();
  }
  if (view === "monitor") { renderMonitor(); loadMonitorStatus(); }
  else releaseMonitor();
}

function releaseMonitor() {
  clearTimeout(monitor.statusTimer); monitor.statusTimer = null;
  monitor.observer?.disconnect(); monitor.observer = null;
  monitor.tiles.forEach((tile) => tile.live?.destroy());
  monitor.tiles.clear();
  $("monitor-grid").replaceChildren();
  monitor.audioCameraId = null;
  monitor.fullscreenId = null;
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
      const message = !monitor.playing ? "Monitor sospeso" : document.hidden ? "Scheda in background" : "Riquadro fuori vista";
      updateMonitorTile(tile, {state: "paused", message, audio: tile.hasAudio, mode: tile.mode});
    }
  });
  $("monitor-toggle").replaceChildren(icon(monitor.playing ? "pause" : "play"), el("span", "", monitor.playing ? "Sospendi monitor" : "Avvia monitor"));
  $("monitor-toggle").disabled = !state.cameras.length;
}

function updateMonitorAudio(tile) {
  const active = tile.hasAudio && !tile.video.muted;
  tile.audioButton.replaceChildren(icon(active ? "audio" : "muted"));
  tile.audioButton.disabled = !tile.hasAudio;
  tile.audioButton.setAttribute("aria-label", !tile.hasAudio ? "Audio non disponibile nel flusso" : active ? `Disattiva audio di ${tile.name}` : `Ascolta ${tile.name}`);
  tile.audioButton.title = !tile.hasAudio ? "Audio non disponibile nel flusso" : active ? "Disattiva audio" : "Ascolta solo questa telecamera";
  tile.audioButton.setAttribute("aria-pressed", String(active));
  tile.audioButton.classList.toggle("audio-on", active);
}

function updateMonitorTile(tile, info) {
  if (!monitor.tiles.has(tile.id)) return;
  tile.hasAudio = !!info.audio;
  tile.mode = info.mode || "copy";
  const changed = tile.liveState !== info.state;
  tile.liveState = info.state;
  tile.element.dataset.liveState = info.state;
  tile.connection.textContent = info.state === "playing" ? "LIVE" : info.state === "connecting" || info.state === "buffering" ? "COLLEGAMENTO" : info.state === "reconnecting" ? "RICONNESSIONE" : info.state === "unsupported" ? "NON SUPPORTATO" : "SOSPESO";
  const failed = ["reconnecting", "unsupported"].includes(info.state);
  tile.message.textContent = failed ? info.state === "unsupported" ? "Browser non compatibile" : "Collegamento non disponibile" : info.message || "";
  tile.errorDetail.hidden = !failed;
  tile.errorDetail.textContent = failed ? info.message || "" : "";
  tile.overlay.hidden = info.state === "playing";
  tile.modeLabel.textContent = tile.mode === "compatible" ? "H.264 compatibile · CPU" : "Flusso originale";
  tile.modeLabel.classList.toggle("converted", tile.mode === "compatible");
  updateMonitorAudio(tile);
  if (changed && ["playing", "paused", "reconnecting", "unsupported"].includes(info.state) && network.view === "monitor" && state.authenticated && !document.hidden) {
    clearTimeout(monitor.statusTimer);
    monitor.statusTimer = setTimeout(() => { monitor.statusTimer = null; loadMonitorStatus(); }, 400);
  }
}

function makeMonitorTile(camera) {
  const tile = {id: camera.id, name: camera.name, source: `${camera.source}|${camera.preview_source}`, visible: false, hasAudio: false, mode: "copy"};
  tile.element = el("article", "monitor-tile");
  tile.element.dataset.cameraId = camera.id;
  const heading = el("div", "monitor-tile-heading");
  tile.title = el("h3", "", camera.name);
  tile.recordingBadge = el("span", "monitor-recording");
  heading.append(tile.title, tile.recordingBadge);
  const frame = el("div", "monitor-video-frame");
  tile.video = el("video", "monitor-video");
  tile.video.muted = true; tile.video.playsInline = true; tile.video.autoplay = true;
  tile.video.setAttribute("aria-label", `Video live di ${camera.name}`);
  tile.overlay = el("div", "monitor-video-overlay");
  tile.message = el("span", "", "Collegamento al flusso…");
  tile.overlay.append(icon("camera"), tile.message);
  const connection = el("div", "monitor-connection");
  tile.connection = el("span", "", "IN ATTESA");
  connection.append(el("i"), tile.connection);
  tile.quality = el("span", "monitor-quality", camera.preview_source ? "SECONDARIO" : "PRINCIPALE");
  frame.append(tile.video, tile.overlay, connection, tile.quality);
  tile.errorDetail = el("p", "monitor-tile-error"); tile.errorDetail.hidden = true;
  const footer = el("div", "monitor-tile-footer");
  tile.modeLabel = el("span", "monitor-mode", "Flusso originale");
  const controls = el("div", "monitor-tile-controls");
  const archive = el("button", "icon-button"); archive.type = "button"; archive.title = "Apri registrazioni"; archive.setAttribute("aria-label", `Apri registrazioni di ${camera.name}`); archive.append(icon("archive"));
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
  const fullscreen = el("button", "icon-button"); fullscreen.type = "button"; fullscreen.title = "Schermo intero"; fullscreen.setAttribute("aria-label", `Mostra ${camera.name} a schermo intero`); fullscreen.append(icon("fullscreen"));
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (tile.element.requestFullscreen) { await tile.element.requestFullscreen(); monitor.fullscreenId = camera.id; syncMonitorPlayers(); }
      else toast("Schermo intero non disponibile in questo browser.");
    } catch (_) { toast("Il browser non ha consentito lo schermo intero."); }
  });
  controls.append(archive, tile.audioButton, fullscreen); footer.append(tile.modeLabel, controls);
  tile.element.append(heading, frame, tile.errorDetail, footer);
  updateMonitorAudio(tile);
  if (window.NvrLivePlayer) {
    tile.live = new window.NvrLivePlayer(tile.video, {cameraId: camera.id, onStatus: (info) => updateMonitorTile(tile, info), onUnauthorized: () => { if (state.authenticated) showLogin(); }});
  } else {
    tile.element.dataset.liveState = "unsupported"; tile.message.textContent = "Lettore video non disponibile. Ricarica la pagina.";
  }
  return tile;
}

function renderMonitor() {
  if (network.view !== "monitor") return;
  const pages = Math.max(1, Math.ceil(state.cameras.length / monitor.layout));
  monitor.page = Math.min(pages - 1, Math.max(0, monitor.page));
  const cameras = state.cameras.slice(monitor.page * monitor.layout, (monitor.page + 1) * monitor.layout);
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
    const source = `${camera.source}|${camera.preview_source}`;
    if (tile && tile.source !== source) { monitor.observer?.unobserve(tile.element); tile.live?.destroy(); tile.element.remove(); monitor.tiles.delete(camera.id); tile = null; }
    if (!tile) {
      tile = makeMonitorTile(camera); monitor.tiles.set(camera.id, tile); $("monitor-grid").append(tile.element);
      if (monitor.observer) monitor.observer.observe(tile.element); else tile.visible = true;
    }
    tile.name = camera.name; tile.title.textContent = camera.name;
    tile.quality.textContent = camera.preview_source ? "SECONDARIO" : "PRINCIPALE";
    const status = cameraStatus(camera);
    const recording = camera.enabled && ["recording", "running", "connected"].includes(camera.status?.state);
    tile.recordingBadge.textContent = recording ? "● REC" : !camera.enabled ? "In pausa" : status.label;
    tile.recordingBadge.classList.toggle("recording", recording);
    tile.recordingBadge.title = !camera.enabled ? "Registrazione in pausa. La diretta resta disponibile." : status.message;
  });
  cameras.forEach((camera, index) => {
    const tile = monitor.tiles.get(camera.id), grid = $("monitor-grid");
    if (grid.children[index] !== tile.element) grid.insertBefore(tile.element, grid.children[index] || null);
  });
  $("monitor-grid").className = `monitor-grid layout-${monitor.layout}`;
  $("monitor-empty").hidden = !!state.cameras.length;
  $("monitor-grid").hidden = !state.cameras.length;
  setText("monitor-page-label", state.cameras.length ? `${monitor.page * monitor.layout + 1}–${Math.min(state.cameras.length, (monitor.page + 1) * monitor.layout)} di ${state.cameras.length}` : "0 telecamere");
  $("monitor-previous").disabled = monitor.page === 0;
  $("monitor-next").disabled = monitor.page >= pages - 1;
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
    setText("monitor-live-status", `Sul server: ${data.active_streams} / ${data.max_streams} flussi · ${data.active_transcodes} / ${data.max_transcodes} conversioni`);
    $("monitor-server-dot").className = "status-dot green";
    $("monitor-error").hidden = true;
  } catch (error) {
    if (epoch !== monitor.statusEpoch || authEpoch !== state.authEpoch || network.view !== "monitor") return;
    setText("monitor-live-status", "Stato delle connessioni non disponibile"); $("monitor-server-dot").className = "status-dot orange";
    setText("monitor-error", errorText(error)); $("monitor-error").hidden = false;
  }
}

function showWarnings(id, warnings) {
  const container = $(id);
  container.replaceChildren();
  const list = (Array.isArray(warnings) ? warnings : []).filter((item) => typeof item === "string" && item);
  container.hidden = !list.length;
  list.forEach((warning) => container.append(el("p", "", warning)));
}

function clearNetworkProfiles(clearCredentials = false) {
  network.profileController?.abort();
  network.profileController = null;
  network.profileEpoch += 1;
  network.profiles = [];
  if (clearCredentials) {
    $("network-username").value = "";
    $("network-password").value = "";
  }
  $("network-include-credentials").checked = false;
  $("network-profiles").replaceChildren();
  $("network-main-profile").replaceChildren();
  $("network-preview-profile").replaceChildren();
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
  button.textContent = "Cerca profili";
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
  $("network-interface").replaceChildren(el("option", "", "Automatica · tutte le interfacce disponibili"));
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
    select.replaceChildren(el("option", "", "Automatica · tutte le interfacce disponibili"));
    select.firstChild.value = "";
    network.interfaces.forEach((item) => {
      const option = el("option", "", `${item.name} · ${item.address}${item.cidr ? ` · ${item.cidr}` : ""}`);
      option.value = item.address;
      select.append(option);
    });
    select.value = previous;
    suggestNetworkCidr();
  } catch (error) {
    if (request === network.interfaceEpoch) setText("network-error", `Interfacce non disponibili: ${errorText(error)} Puoi comunque provare la ricerca automatica o l’endpoint manuale.`);
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
  setScanBusy(false);
  if (wasRunning && !network.devices.length) renderNetworkDevices("Annullamento della ricerca richiesto. Attendi la conferma del server prima di avviare una nuova ricerca.");
  if (wasRunning && state.authenticated) {
    const authEpoch = state.authEpoch, cancelEpoch = network.scanEpoch;
    if (announce) toast("Annullamento della ricerca richiesto.");
    // Closing the HTTP response alone may leave the server's discovery task
    // running. Explicit cancellation releases that task and its discovery lock.
    api("/api/onvif/cancel", {method: "POST", body: {}}).then((result) => {
      if (!state.authenticated || authEpoch !== state.authEpoch || cancelEpoch !== network.scanEpoch) return;
      if (typeof result?.cancelled === "boolean" && !network.devices.length) renderNetworkDevices("Ricerca chiusa. Puoi avviare una nuova ricerca oppure inserire un endpoint manuale.");
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
      setText("network-error", "Inserisci una rete IPv4 valida con prefisso da /24 a /32 (massimo 256 indirizzi)."); return;
    }
    if (!ports.length || ports.length > 8 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      setText("network-error", "Inserisci da 1 a 8 porte valide, separate da virgole (da 1 a 65535)."); return;
    }
    payload = {cidr, ports};
  } else payload = {interface_ip: $("network-interface").value || null, timeout: 6};
  const request = ++network.scanEpoch, authEpoch = state.authEpoch;
  const controller = new AbortController();
  network.scanController = controller;
  clearNetworkProfiles(true);
  network.selected = null;
  network.devices = [];
  renderNetworkDevices("Ricerca in corso. I risultati compariranno al termine.");
  $("network-device-explorer").hidden = true;
  $("network-select-placeholder").hidden = false;
  setText("network-error", "");
  showWarnings("network-warnings", []);
  setScanBusy(true);
  const started = Date.now();
  const progress = () => setText("network-progress-label", `${mode === "scan" ? "Ricerca nell’intervallo IP" : "Ricerca multicast ONVIF"} in corso · ${Math.floor((Date.now() - started) / 1000)} s`);
  progress();
  network.scanTimer = setInterval(progress, 1000);
  try {
    const data = await api(`/api/onvif/${mode}`, {method: "POST", body: payload, signal: controller.signal});
    if (request !== network.scanEpoch || authEpoch !== state.authEpoch || network.view !== "network" || !state.authenticated) return;
    network.devices = Array.isArray(data?.devices) ? data.devices : [];
    showWarnings("network-warnings", data?.warnings);
    renderNetworkDevices("Nessun dispositivo trovato. Controlla che ONVIF sia abilitato, che telecamera e server siano nella stessa LAN e che firewall, bridge o container LXC consentano il traffico. Puoi provare l’intervallo IP oppure l’endpoint manuale.");
    toast(`${network.devices.length} ${network.devices.length === 1 ? "dispositivo trovato" : "dispositivi trovati"}${Number.isFinite(data?.duration) ? ` in ${data.duration.toLocaleString("it-IT", {maximumFractionDigits: 1})} s` : ""}.`);
  } catch (error) {
    if (error.name !== "AbortError" && request === network.scanEpoch) {
      setText("network-error", errorText(error));
      renderNetworkDevices("Ricerca non completata. Controlla la connettività del server oppure inserisci un endpoint manuale.");
    }
  } finally {
    if (request === network.scanEpoch) {
      clearInterval(network.scanTimer); network.scanTimer = null; network.scanController = null; setScanBusy(false);
    }
  }
}

function renderNetworkDevices(emptyMessage = "Avvia una ricerca oppure inserisci un endpoint ONVIF.") {
  const list = $("network-devices");
  list.replaceChildren();
  setText("network-device-count", String(network.devices.length));
  if (!network.devices.length) {
    const empty = el("div", "network-device-empty");
    empty.append(icon("network"), el("strong", "", "La tua rete, da esplorare."), el("p", "", emptyMessage));
    list.append(empty);
  }
  network.devices.forEach((device, index) => {
    const row = el("button", `network-device-row${device === network.selected ? " active" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(device === network.selected));
    const copy = el("span");
    copy.append(el("strong", "", device.name || device.hardware || device.ip || `Dispositivo ${index + 1}`), el("small", "", `${device.ip || "ONVIF"}${device.manual ? " · endpoint manuale" : ""}`));
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
  setText("network-device-name", device.name || device.hardware || device.ip || "Dispositivo ONVIF");
  setText("network-device-address", device.ip || "Endpoint manuale");
  setText("network-device-description", [device.hardware, device.location].filter(Boolean).join(" · "));
  $("network-select-placeholder").hidden = true;
  $("network-device-explorer").hidden = false;
  $("network-read-profiles").disabled = !endpoints.length;
  if (!endpoints.length) setText("network-profile-error", "Il dispositivo non ha pubblicato un endpoint. Inseriscilo manualmente nel campo sopra.");
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
    if (!network.profiles.length) setText("network-profile-error", "Nessun profilo restituito. Verifica endpoint, credenziali ONVIF e permessi dell’utente sulla telecamera.");
    else if (data?.success === false) setText("network-profile-error", "Profili trovati, ma nessun URL utilizzabile. I dettagli di ciascun profilo possono aiutarti a individuare il problema.");
    renderNetworkProfiles(true);
  } catch (error) {
    if (error.name !== "AbortError" && request === network.profileEpoch) setText("network-profile-error", errorText(error));
  } finally {
    if (request === network.profileEpoch) { network.profileController = null; $("network-read-profiles").disabled = false; $("network-profile-progress").hidden = true; }
  }
}

function renderDeviceInfo(device) {
  const list = $("network-device-info");
  list.replaceChildren();
  const labels = {manufacturer: "Produttore", model: "Modello", firmware: "Firmware", serial_number: "Numero di serie", hardware_id: "Hardware"};
  Object.entries(labels).forEach(([key, label]) => {
    if (!device?.[key]) return;
    const pair = el("div"); pair.append(el("dt", "", label), el("dd", "", device[key])); list.append(pair);
  });
  list.hidden = !list.childElementCount;
}

function profileRole(profile) {
  return profile.role === "main" ? "Principale suggerito" : profile.role === "sub" ? "Secondario suggerito" : "Altro profilo";
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
  title.append(el("h4", "", profile.name || `Profilo ${index + 1}`), el("small", "", `${profile.service || "ONVIF"} · ${profile.token || "Token non disponibile"}`));
  heading.append(title, el("span", `badge ${profile.role === "main" ? "" : "neutral"}`, profileRole(profile)));
  card.append(heading);
  const metadata = [profile.encoding, profile.width && profile.height ? `${profile.width} × ${profile.height}` : "", profile.fps ? `${profile.fps} fps` : "", profile.bitrate ? `Limite ${profile.bitrate} kb/s` : "", profile.video_source ? `Sorgente ${profile.video_source}` : ""].filter(Boolean);
  card.append(el("p", "stream-metadata", metadata.join(" · ") || "Metadati video non disponibili"));
  if (profile.role_basis) card.append(el("p", "field-help", profile.role_basis));
  if (profile.error) card.append(el("p", "form-error", profile.error));
  if (available) {
    const input = el("input", "stream-url"); input.readOnly = true; input.value = streamUrl(profile, includeCredentials);
    input.setAttribute("aria-label", `URL del profilo ${profile.name || index + 1}`); input.spellcheck = false;
    input.addEventListener("focus", () => input.select());
    card.append(input);
  } else card.append(el("p", "field-help", "URL non disponibile per questo profilo."));
  const actions = el("div", "stream-actions");
  const copy = el("button", "button secondary small-button"); copy.type = "button"; copy.disabled = !available;
  copy.append(icon("copy"), document.createTextNode("Copia URL"));
  copy.addEventListener("click", () => copyStreamText(streamUrl(profile, $(isNetwork ? "network-include-credentials" : "onvif-include-credentials").checked)));
  actions.append(copy);
  ["main", "preview"].forEach((target) => {
    const button = el("button", "button quiet small-button", target === "main" ? "Per registrazione" : "Per anteprima");
    button.type = "button"; button.disabled = !available; button.dataset.streamTarget = target;
    button.addEventListener("click", () => {
      if (isNetwork) {
        $(target === "main" ? "network-main-profile" : "network-preview-profile").value = String(index);
        updateProfilePair();
      } else {
        $(target === "main" ? "camera-url" : "camera-preview-url").value = profile.url || profile.clean_url || "";
        if (target === "preview") { $("clear-preview").checked = false; $("camera-preview-url").disabled = false; }
        $("onvif-dialog").close();
        toast(target === "main" ? "Flusso principale inserito. Salva la telecamera per registrare." : "Flusso di anteprima inserito. Salva la configurazione.");
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
  setText("network-profile-count", `${network.profiles.length} ${network.profiles.length === 1 ? "profilo" : "profili"} · ${available.length} URL disponibili`);
  $("network-copy-all").disabled = !available.length;
  $("network-recording-pair").hidden = !available.length;
  if (resetPair) {
    $("network-main-profile").replaceChildren();
    $("network-preview-profile").replaceChildren(el("option", "", "Nessuno · usa il flusso principale"));
    $("network-preview-profile").firstChild.value = "";
    available.forEach(({profile, index}) => {
      ["network-main-profile", "network-preview-profile"].forEach((id) => {
        const option = el("option", "", `${profile.name || `Profilo ${index + 1}`} · ${profile.encoding || "video"}${profile.width ? ` · ${profile.width} × ${profile.height}` : ""}`);
        option.value = String(index); $(id).append(option);
      });
    });
    const main = available.find(({profile}) => profile.role === "main") || available[0];
    const preview = available.find(({profile, index}) => profile.role === "sub" && index !== main?.index && main?.profile.video_source && profile.video_source === main.profile.video_source);
    $("network-main-profile").value = main ? String(main.index) : "";
    $("network-preview-profile").value = preview ? String(preview.index) : "";
  }
  updateProfilePair();
}

function updateProfilePair() {
  document.querySelectorAll("#network-profiles .stream-card").forEach((card) => {
    ["main", "preview"].forEach((target) => {
      const selected = $(target === "main" ? "network-main-profile" : "network-preview-profile").value === card.dataset.profileIndex;
      const button = card.querySelector(`[data-stream-target="${target}"]`);
      button.classList.toggle("chosen", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  });
  const mainValue = $("network-main-profile").value, previewValue = $("network-preview-profile").value;
  const main = mainValue === "" ? null : network.profiles[Number(mainValue)];
  const preview = previewValue === "" ? null : network.profiles[Number(previewValue)];
  $("network-pair-note").hidden = !(main?.video_source && preview?.video_source && main.video_source !== preview.video_source);
}

async function copyStreamText(value) {
  if (!value) return;
  const authEpoch = state.authEpoch, profileEpoch = network.profileEpoch, modalEpoch = network.modalEpoch;
  const stillCurrent = () => state.authenticated && authEpoch === state.authEpoch && profileEpoch === network.profileEpoch && modalEpoch === network.modalEpoch;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); if (stillCurrent()) toast("URL copiati negli appunti."); return; } catch (_) { /* HTTP LAN and browser permissions may require manual copying. */ }
  }
  if (!stillCurrent()) return;
  $("copy-value").value = value;
  if (!$("copy-dialog").open) $("copy-dialog").showModal();
  $("copy-value").focus(); $("copy-value").select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) { /* The selected field remains available. */ }
  if (copied) { $("copy-dialog").close(); toast("URL copiati negli appunti."); }
  else setText("copy-dialog-message", "Copia automatica non disponibile su questo browser. Il testo è selezionato: usa Ctrl+C, ⌘C o il comando Copia del dispositivo.");
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
  if (!main || !(main.url || main.clean_url)) return;
  // Always create a new draft; never overwrite the recorder's selected camera.
  openCameraDialog();
  $("camera-name").value = String(network.selected?.name || network.selected?.hardware || network.selected?.ip || "Telecamera ONVIF").slice(0, 80);
  $("camera-url").value = main.url || main.clean_url;
  $("camera-preview-url").value = preview ? preview.url || preview.clean_url || "" : "";
}

async function deleteCamera() {
  if (!state.editingId) return;
  $("confirm-delete").disabled = true;
  setText("delete-error", "");
  try {
    await api(`/api/cameras/${encodeURIComponent(state.editingId)}`, {method: "DELETE"});
    $("delete-dialog").close(); $("camera-dialog").close();
    await refresh(true, true);
    toast("Telecamera rimossa. Le registrazioni esistenti rimangono sul disco.");
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
  if (state.rangeFollowsNow) $("search-end").value = localInput(new Date(Date.now() + 60000));
  await refresh(true, true); await loadRecordings();
});
$("toggle-live").addEventListener("click", toggleLive);
$("live-image").addEventListener("error", () => { if (state.live) { stopLive(); toast("Anteprima non disponibile. Verifica il flusso e FFmpeg sul server."); } });
$("search-form").addEventListener("submit", (event) => { event.preventDefault(); state.rangeFollowsNow = false; loadRecordings(); });
$("camera-form").addEventListener("submit", saveCamera);
$("probe-camera").addEventListener("click", probeCamera);
$("open-onvif").addEventListener("click", () => {
  resetModalProfiles();
  $("onvif-form").reset(); $("onvif-profiles").replaceChildren(); setText("onvif-error", "");
  showWarnings("onvif-warnings", []);
  $("onvif-dialog").showModal();
});
$("onvif-form").addEventListener("submit", findOnvifProfiles);
$("onvif-dialog").addEventListener("close", resetModalProfiles);
$("nav-recorder").addEventListener("click", () => showView("recorder"));
$("nav-monitor").addEventListener("click", () => showView("monitor"));
$("monitor-toggle").addEventListener("click", () => { monitor.playing = !monitor.playing; syncMonitorPlayers(); loadMonitorStatus(); });
$("monitor-find-cameras").addEventListener("click", () => { showView("network"); loadNetworkInterfaces(); });
document.querySelectorAll("[data-monitor-layout]").forEach((button) => button.addEventListener("click", () => {
  monitor.layout = Number(button.dataset.monitorLayout); monitor.page = 0; renderMonitor();
}));
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
  try { url = new URL(endpoint); } catch (_) { setText("network-error", "Inserisci un endpoint HTTP o HTTPS valido."); return; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    setText("network-error", "Usa un endpoint HTTP o HTTPS senza credenziali nell’indirizzo; inseriscile nei campi del dispositivo."); return;
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
  const button = $("onvif-form").querySelector("button[type=submit]"); button.disabled = false; button.textContent = "Cerca profili";
}));
$("network-include-credentials").addEventListener("change", () => renderNetworkProfiles());
$("onvif-include-credentials").addEventListener("change", renderModalProfiles);
$("network-copy-all").addEventListener("click", () => copyAllProfiles("network"));
$("onvif-copy-all").addEventListener("click", () => copyAllProfiles("modal"));
["network-main-profile", "network-preview-profile"].forEach((id) => $(id).addEventListener("change", updateProfilePair));
$("network-add-recorder").addEventListener("click", addNetworkCamera);
$("copy-dialog").addEventListener("close", () => { $("copy-value").value = ""; });
$("camera-dialog").addEventListener("close", () => { $("camera-url").value = ""; $("camera-preview-url").value = ""; });
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
player.addEventListener("error", () => {
  if (!state.recording) return;
  archiveError($("compatible").checked
    ? "Riproduzione non disponibile. Verifica il file e il servizio FFmpeg sul server; puoi scaricare la registrazione originale."
    : "Il browser potrebbe non supportare questo codec. Prova la riproduzione compatibile H.264 oppure scarica il file originale.");
});
player.addEventListener("ended", () => {
  if (!state.recording) return;
  const current = state.recording;
  const next = state.recordings.find((item) => item.started_at > current.started_at);
  if (next && next.started_at <= current.started_at + current.duration + 2) selectRecording(next);
  else if (next) toast("Fine segmento. Prima della registrazione successiva c’è un intervallo senza video.");
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
});
window.addEventListener("pagehide", () => { stopLive(); player.pause(); releaseMonitor(); });
window.addEventListener("pageshow", (event) => { if (event.persisted && network.view === "monitor") renderMonitor(); });

const now = new Date();
const today = new Date(now); today.setHours(0, 0, 0, 0);
$("search-start").value = localInput(today);
$("search-end").value = localInput(new Date(now.getTime() + 60000));
function updateClock() { $("wall-clock").textContent = `${formatDate.format(new Date())} · ${formatShortTime.format(new Date())}`; }
updateClock(); setInterval(updateClock, 30000);
document.body.classList.add("loading");
api("/api/session").then((session) => session?.authenticated ? enterApp() : showLogin()).catch((error) => { showLogin(); setText("login-error", errorText(error)); });
