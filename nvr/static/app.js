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
  } catch (_) {
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
  const button = $("onvif-form").querySelector("button[type=submit]");
  button.disabled = true;
  setText("onvif-error", "");
  $("onvif-profiles").replaceChildren();
  try {
    const data = await api("/api/onvif/profiles", {method: "POST", body: {
      endpoint: $("onvif-endpoint").value.trim(), username: $("onvif-username").value,
      password: $("onvif-password").value,
    }});
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    if (!profiles.length) setText("onvif-error", "Il dispositivo non ha restituito profili video utilizzabili.");
    profiles.forEach((profile) => {
      const choice = el("button", "onvif-profile");
      choice.type = "button";
      const text = el("span");
      text.append(el("strong", "", profile.name || "Profilo video"), el("small", "", `${profile.encoding || "Video"} · ${profile.token || "ONVIF"}`));
      choice.append(text, el("span", "accent", "Usa profilo →"));
      choice.addEventListener("click", () => {
        $("camera-url").value = profile.url || "";
        $("onvif-dialog").close();
        toast("Flusso ONVIF inserito. Salva la telecamera per iniziare.");
      });
      $("onvif-profiles").append(choice);
    });
  } catch (error) { setText("onvif-error", errorText(error)); }
  finally { button.disabled = false; }
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
  $("onvif-form").reset(); $("onvif-profiles").replaceChildren(); setText("onvif-error", "");
  $("onvif-dialog").showModal();
});
$("onvif-form").addEventListener("submit", findOnvifProfiles);
$("onvif-dialog").addEventListener("close", () => { $("onvif-password").value = ""; });
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
document.addEventListener("visibilitychange", () => { if (document.hidden) stopLive(); });
window.addEventListener("pagehide", () => { stopLive(); player.pause(); });

const now = new Date();
const today = new Date(now); today.setHours(0, 0, 0, 0);
$("search-start").value = localInput(today);
$("search-end").value = localInput(new Date(now.getTime() + 60000));
function updateClock() { $("wall-clock").textContent = `${formatDate.format(new Date())} · ${formatShortTime.format(new Date())}`; }
updateClock(); setInterval(updateClock, 30000);
document.body.classList.add("loading");
api("/api/session").then((session) => session?.authenticated ? enterApp() : showLogin()).catch((error) => { showLogin(); setText("login-error", errorText(error)); });
