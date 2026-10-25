"""Local FFmpeg media workers. Original camera media is never transcoded on ingest."""
from __future__ import annotations

import asyncio
import contextlib
import csv
import hashlib
import io
import json
import math
import re
import shutil
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlsplit

from .config import MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS
from .motion import FRAME_BYTES, SAMPLE_SECONDS, MotionAnalyzer, motion_timeout


INPUT_PROTOCOLS = "rtsp,rtsps,http,https,tcp,tls,udp,rtp"
MAX_JPEG_BYTES = 8 * 1024 * 1024
CACHE_ARTIFACT_NAME = re.compile(r"[0-9a-f]{64}\.(?:mp4|json|jpg)\Z")
CACHE_PART_NAME = re.compile(r"[0-9a-f]{64}\.part\.(?:mp4|json|jpg)\Z")
MAX_THUMBNAIL_BYTES = 256 * 1024


class MediaError(RuntimeError):
    """Safe to display: never contains a stream URL or FFmpeg stderr."""


def validate_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        if parts.scheme.lower() not in {"rtsp", "rtsps", "http", "https"}:
            raise ValueError
        if not parts.hostname or "\n" in url or "\r" in url:
            raise ValueError
        _ = parts.port
    except (TypeError, ValueError):
        raise MediaError("Invalid stream address: use RTSP, RTSPS, HTTP or HTTPS.") from None
    return url


def _input_args(url: str) -> list[str]:
    validate_url(url)
    args = ["-protocol_whitelist", INPUT_PROTOCOLS]
    if urlsplit(url).scheme.lower() in {"rtsp", "rtsps"}:
        # RTSP is a demuxer, rather than a URL protocol. Its socket timeout option
        # is distinct from HTTP's rw_timeout (FFmpeg rejects that for RTSP).
        args += ["-rtsp_transport", "tcp", "-timeout", "15000000"]
    else:
        args += ["-rw_timeout", "15000000"]
    return args + ["-i", url]


async def _stop_process(process: asyncio.subprocess.Process | None) -> None:
    if process is None or process.returncode is not None:
        return
    if process.stdin is not None:
        with contextlib.suppress(BrokenPipeError, ConnectionResetError, RuntimeError):
            process.stdin.write(b"q\n")
            await process.stdin.drain()
    try:
        await asyncio.wait_for(process.wait(), 5)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()


@dataclass
class _Worker:
    camera: dict[str, Any]
    task: asyncio.Task | None = None
    process: asyncio.subprocess.Process | None = None
    state: str = "starting"
    message: str = "Starting recording"
    last_segment_at: float | None = None
    stopping: bool = False
    segment_seconds: int | None = None


@dataclass
class _LiveHub:
    camera: dict[str, Any]
    clients: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None
    process: asyncio.subprocess.Process | None = None


class MediaManager:
    def __init__(self, settings: Any, store: Any):
        self.settings, self.store = settings, store
        self.recordings_dir = Path(settings.recordings_dir).resolve()
        self.cache_dir = Path(settings.cache_dir).resolve()
        self.workers: dict[str, _Worker] = {}
        self._hubs: dict[str, _LiveHub] = {}
        self._hub_lock = asyncio.Lock()
        self._reconcile_lock = asyncio.Lock()
        self._transcode_slots = asyncio.Semaphore(2)
        self._motion_slots = asyncio.Semaphore(1)
        self._thumbnail_slots = asyncio.Semaphore(1)
        # Four shared live streams plus two one-shot snapshots.
        self._decode_slots = asyncio.Semaphore(6)
        self._jobs: dict[str, asyncio.Task] = {}
        self._in_use: dict[Path, int] = {}
        self._cache_leases: dict[Path, int] = {}
        self._cache_reservations: dict[Path, int] = {}
        self._janitor: asyncio.Task | None = None
        self._stopping = False

    async def start(self) -> None:
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._stopping = False
        await self._recover()
        await self._retention()
        await self.reconcile()
        self._janitor = asyncio.create_task(self._maintenance(), name="nvr-retention")

    async def stop(self) -> None:
        self._stopping = True
        if self._janitor:
            self._janitor.cancel()
            await asyncio.gather(self._janitor, return_exceptions=True)
        for worker in self.workers.values():
            worker.stopping = True
            if worker.task:
                worker.task.cancel()
        tasks = [w.task for w in self.workers.values() if w.task]
        tasks += [h.task for h in self._hubs.values() if h.task]
        tasks += list(self._jobs.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.workers.clear()
        self._hubs.clear()

    async def reconcile(self) -> None:
        async with self._reconcile_lock:
            await self._reconcile_locked()

    async def set_segment_seconds(self, seconds: int) -> None:
        if type(seconds) is not int or not MIN_SEGMENT_SECONDS <= seconds <= MAX_SEGMENT_SECONDS:
            raise MediaError("Recording duration must be an integer between 60 and 7200 seconds.")
        async with self._reconcile_lock:
            if self.settings.segment_seconds == seconds:
                return
            self.settings.segment_seconds = seconds
            await self._reconcile_locked()

    async def _reconcile_locked(self) -> None:
        cameras = {str(c["id"]): c for c in self.store.list_cameras() if c.get("enabled", True)}
        for camera_id, worker in list(self.workers.items()):
            desired = cameras.get(camera_id)
            # A preview URL change also restarts shared live previews below.
            if (desired != worker.camera or worker.segment_seconds != self.settings.segment_seconds
                    or worker.task is None or worker.task.done()):
                worker.stopping = True
                if worker.task:
                    worker.task.cancel()
                    await asyncio.gather(worker.task, return_exceptions=True)
                del self.workers[camera_id]
        if self._stopping:
            return
        for camera_id, camera in cameras.items():
            if camera_id not in self.workers:
                worker = _Worker(dict(camera), segment_seconds=self.settings.segment_seconds)
                self.workers[camera_id] = worker
                worker.task = asyncio.create_task(self._record(worker), name=f"record-{camera_id}")
        async with self._hub_lock:
            for camera_id, hub in list(self._hubs.items()):
                if cameras.get(camera_id) != hub.camera:
                    if hub.task:
                        hub.task.cancel()
                    self._hubs.pop(camera_id, None)

    def camera_status(self, camera_id: str) -> dict[str, Any]:
        worker = self.workers.get(str(camera_id))
        if not worker:
            return {"state": "stopped", "message": "Recording disabled", "last_segment_at": None}
        return {"state": worker.state, "message": worker.message, "last_segment_at": worker.last_segment_at}

    async def _spawn(self, *args: str, pipe: bool = False) -> asyncio.subprocess.Process:
        try:
            return await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE if pipe else asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                limit=256 * 1024,
            )
        except (OSError, ValueError):
            raise MediaError("FFmpeg/FFprobe unavailable or not executable.") from None

    async def _capture(self, args: list[str], timeout: float = 20, max_bytes: int = MAX_JPEG_BYTES) -> bytes:
        process = await self._spawn(*args, pipe=True)
        async def read() -> bytes:
            assert process.stdout
            data = bytearray()
            while chunk := await process.stdout.read(65536):
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise MediaError("Stream response too large.")
            await process.wait()
            if process.returncode:
                raise MediaError("Unable to read the stream or media file.")
            return bytes(data)
        try:
            return await asyncio.wait_for(read(), timeout)
        except asyncio.TimeoutError:
            raise MediaError("Stream request timed out.") from None
        finally:
            await _stop_process(process)

    async def probe(self, url: str) -> dict[str, Any]:
        return await self._probe_args(_input_args(url))

    async def _probe_file(self, path: Path) -> dict[str, Any]:
        return await self._probe_args(["-i", str(path)])

    async def _probe_args(self, source: list[str]) -> dict[str, Any]:
        raw = await self._capture([
            self.settings.ffprobe, "-v", "error", *source,
            "-show_entries", "stream=codec_name,codec_type,width,height,duration:format=duration",
            "-of", "json",
        ], timeout=25, max_bytes=128 * 1024)
        try:
            result = json.loads(raw)
            streams = result.get("streams", [])
            video = next(s for s in streams if s.get("codec_type") == "video")
            audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
            duration = float(result.get("format", {}).get("duration", 0) or 0)
            if not math.isfinite(duration) or duration < 0:
                duration = 0
            return {"video_codec": video.get("codec_name", "unknown"),
                    "audio_codec": audio.get("codec_name"), "width": video.get("width"),
                    "height": video.get("height"), "duration": duration, "streams": streams}
        except (ValueError, TypeError, KeyError, StopIteration):
            raise MediaError("The stream does not contain a readable video track.") from None

    def _camera_dir(self, camera_id: str) -> Path:
        # IDs normally are UUIDs; this prevents store content becoming a filesystem path.
        if not camera_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in camera_id):
            raise MediaError("Invalid camera ID.")
        path = (self.recordings_dir / camera_id).resolve()
        if not path.is_relative_to(self.recordings_dir):
            raise MediaError("Invalid archive path.")
        return path

    def recording_path(self, recording: dict[str, Any]) -> Path:
        path = (self.recordings_dir / str(recording["path"])).resolve()
        if not path.is_relative_to(self.recordings_dir):
            raise MediaError("Invalid recording path.")
        return path

    async def _record(self, worker: _Worker) -> None:
        if worker.segment_seconds is None:
            worker.segment_seconds = self.settings.segment_seconds
        backoff = 1.0
        while not self._stopping and not worker.stopping:
            process = None
            manifest = None
            seen: set[str] = set()
            cursor = [0]
            before = worker.last_segment_at
            try:
                camera = worker.camera
                url = validate_url(camera["url"])
                directory = self._camera_dir(str(camera["id"]))
                directory.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(self.recordings_dir).free < int(self.settings.min_free_bytes):
                    await self._retention()
                    if shutil.disk_usage(self.recordings_dir).free < int(self.settings.min_free_bytes):
                        worker.state, worker.message = "storage_full", "Insufficient storage; recording paused"
                        await asyncio.sleep(10)
                        continue
                origin = time.time()
                prefix = str(int(origin * 1000))
                manifest = directory / f"{prefix}.csv"
                output = directory / f"{prefix}-%06d.mkv"
                args = [self.settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *_input_args(url),
                        "-map", "0:v:0"]
                if camera.get("audio_mode", "copy") != "none":
                    args += ["-map", "0:a:0?"]
                args += ["-c", "copy", "-f", "segment", "-segment_time", str(worker.segment_seconds),
                         "-segment_format", "matroska", "-reset_timestamps", "1",
                         "-segment_list", str(manifest), "-segment_list_type", "csv", str(output)]
                process = worker.process = await self._spawn(*args)
                worker.state, worker.message = "connecting", "Connecting to camera"
                while process.returncode is None:
                    # Long segments remain open for up to two hours. Report
                    # recording once FFmpeg writes media, without waiting for
                    # the first completed segment to appear in the manifest.
                    if worker.state == "connecting":
                        with contextlib.suppress(OSError):
                            if (directory / f"{prefix}-000000.mkv").stat().st_size > 0:
                                worker.state, worker.message = "recording", "Recording"
                    await self._import_manifest(manifest, str(camera["id"]), origin, seen, worker, cursor)
                    if shutil.disk_usage(self.recordings_dir).free < int(self.settings.min_free_bytes):
                        await self._retention()
                        if shutil.disk_usage(self.recordings_dir).free < int(self.settings.min_free_bytes):
                            await _stop_process(process)
                            worker.state, worker.message = "storage_full", "Insufficient storage; recording paused"
                            break
                    try:
                        await asyncio.wait_for(process.wait(), 1)
                    except asyncio.TimeoutError:
                        pass
                await self._import_manifest(manifest, str(camera["id"]), origin, seen, worker, cursor)
                if worker.state != "storage_full":
                    worker.state, worker.message = "reconnecting", "Stream interrupted; reconnecting"
            except asyncio.CancelledError:
                raise
            except (MediaError, OSError, KeyError, ValueError):
                worker.state, worker.message = "error", "Camera unreachable or recording unavailable"
            finally:
                await _stop_process(process)
                worker.process = None
                if manifest:
                    with contextlib.suppress(MediaError, OSError, ValueError):
                        await self._import_manifest(manifest, str(worker.camera["id"]), origin, seen, worker, cursor)
            if worker.last_segment_at != before:
                backoff = 1.0
            if not self._stopping and not worker.stopping:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _import_manifest(self, manifest: Path, camera_id: str, origin: float,
                               seen: set[str], worker: _Worker | None = None,
                               cursor: list[int] | None = None) -> None:
        if not manifest.exists():
            return
        with manifest.open("rb") as stream:
            if cursor:
                stream.seek(cursor[0])
            data = stream.read()
        # Only a newline-terminated entry guarantees that FFmpeg closed this segment.
        complete = data.rfind(b"\n") + 1
        if cursor:
            cursor[0] += complete
        contents = data[:complete].decode("utf-8", errors="replace")
        for row in csv.reader(io.StringIO(contents)):
            if len(row) != 3 or row[0] in seen:
                continue
            path = Path(row[0])
            if not path.is_absolute():
                path = manifest.parent / path
            path = path.resolve()
            if not path.is_relative_to(self._camera_dir(camera_id)) or not path.is_file():
                continue
            try:
                start, end = float(row[1]), float(row[2])
                if not all(math.isfinite(v) for v in (start, end)) or end <= start:
                    continue
                info = await self._probe_file(path)
                duration = info["duration"] or end - start
                if duration <= 0:
                    continue
                self.store.add_recording(camera_id=camera_id, path=path.relative_to(self.recordings_dir).as_posix(),
                    started_at=origin + start, duration=duration, size=path.stat().st_size,
                    video_codec=info["video_codec"], audio_codec=info["audio_codec"])
                if cursor is None:
                    seen.add(row[0])
                if worker:
                    worker.last_segment_at = origin + start + duration
                    if worker.state != "storage_full":
                        worker.state, worker.message = "recording", "Recording"
            except (OSError, ValueError, MediaError):
                continue

    async def _recover(self) -> None:
        # SQLite's UNIQUE(path) makes recovery idempotent across crashes/restarts.
        known = {str(r["path"]) for r in self.store.list_recordings(limit=1_000_000)}
        cameras = {str(c["id"]): c for c in self.store.list_cameras()}
        for camera_id in cameras:
            directory = self._camera_dir(camera_id)
            if not directory.exists():
                continue
            for manifest in directory.glob("*.csv"):
                try:
                    origin = int(manifest.stem) / 1000
                    seen = set()
                    for row in csv.reader(io.StringIO(manifest.read_text(encoding="utf-8", errors="replace"))):
                        if row:
                            path = Path(row[0])
                            if not path.is_absolute():
                                path = manifest.parent / path
                            path = path.resolve()
                            if path.is_relative_to(self.recordings_dir) and path.relative_to(self.recordings_dir).as_posix() in known:
                                seen.add(row[0])
                    await self._import_manifest(manifest, camera_id, origin, seen)
                except (OSError, ValueError):
                    continue
            known = {str(r["path"]) for r in self.store.list_recordings(limit=1_000_000)}
            # A crash can omit the last CSV entry. Recover it only when ffprobe confirms
            # a finalized duration and readable video; leave incomplete bytes untouched.
            for path in sorted(directory.glob("*.mkv")):
                relative = path.relative_to(self.recordings_dir).as_posix()
                if relative in known:
                    continue
                try:
                    prefix, sequence = path.stem.rsplit("-", 1)
                    info = await self._probe_file(path)
                    if info["duration"] <= 0:
                        continue
                    int(sequence)  # reject unexpected names
                    # Without a surviving manifest, filesystem time is the only available
                    # clock. Do not multiply the segment index by a nominal GOP interval.
                    started_at = path.stat().st_mtime - info["duration"]
                    # Prefer packet time from a surviving CSV row where available.
                    manifest = path.parent / f"{prefix}.csv"
                    if manifest.exists():
                        previous_end = 0.0
                        matched = False
                        for row in csv.reader(io.StringIO(manifest.read_text(encoding="utf-8", errors="replace"))):
                            if len(row) == 3 and Path(row[0]).name == path.name:
                                started_at = int(prefix) / 1000 + float(row[1])
                                matched = True
                            if len(row) == 3:
                                previous_end = max(previous_end, float(row[2]))
                        if not matched:
                            started_at = int(prefix) / 1000 + previous_end
                    self.store.add_recording(camera_id=camera_id, path=relative, started_at=started_at,
                        duration=info["duration"], size=path.stat().st_size,
                        video_codec=info["video_codec"], audio_codec=info["audio_codec"])
                except (OSError, ValueError, MediaError):
                    continue

    async def _maintenance(self) -> None:
        while not self._stopping:
            try:
                await self._retention()
                self._prune_cache()
                await self.reconcile()
            except (OSError, MediaError):
                pass
            await asyncio.sleep(30)

    async def _retention(self) -> None:
        cameras = {str(c["id"]): c for c in self.store.list_cameras()}
        records = sorted(self.store.list_recordings(limit=1_000_000), key=lambda r: float(r["started_at"]))
        now = time.time()
        free = shutil.disk_usage(self.recordings_dir).free
        reserve = int(self.settings.min_free_bytes)
        for recording in records:
            camera = cameras.get(str(recording["camera_id"]), {})
            days = max(1, int(camera.get("retention_days", 7)))
            expired = float(recording["started_at"]) + float(recording["duration"]) < now - days * 86400
            if not expired and free >= reserve:
                continue
            path = self.recording_path(recording)
            if path in self._in_use:
                continue
            try:
                if path.exists():
                    size = path.stat().st_size
                    path.unlink()
                    free += size
                self.store.delete_recording(recording["id"])
            except OSError:
                continue

    def _prune_cache(self) -> None:
        active_parts = {Path(key).with_suffix(".part" + Path(key).suffix) for key in self._jobs}
        for path in self.cache_dir.glob("*.part.*"):
            if (self._owned_cache_file(path, partial=True) and path not in active_parts
                    and time.time() - path.stat().st_mtime > 3600):
                with contextlib.suppress(OSError):
                    path.unlink()
        files = [path for path in self.cache_dir.iterdir() if self._owned_cache_file(path)]
        stats = {path: path.stat() for path in files}
        total = sum(stat.st_size for stat in stats.values())
        limit = int(getattr(self.settings, "cache_max_bytes", 2 * 1024**3))
        # A full two-hour MP4 may exceed the soft budget by itself. Keep one
        # recent oversized MP4 so subsequent HTTP Range requests can reuse it.
        oversized = [path for path in files if path.suffix == ".mp4" and stats[path].st_size > limit
                     and time.time() - stats[path].st_atime < 86400]
        newest = max(oversized, key=lambda path: stats[path].st_atime, default=None)
        if newest is not None:
            total -= stats[newest].st_size
        protected = set(self._cache_leases) | {Path(key) for key in self._jobs}
        for path in sorted(files, key=lambda path: stats[path].st_atime):
            stat = stats[path]
            if path == newest or path in protected:
                continue
            if total <= limit and time.time() - stat.st_atime < 86400:
                continue
            with contextlib.suppress(OSError):
                path.unlink()
                total -= stat.st_size

    def _owned_cache_file(self, path: Path, partial: bool = False) -> bool:
        pattern = CACHE_PART_NAME if partial else CACHE_ARTIFACT_NAME
        return (pattern.fullmatch(path.name) is not None and not path.is_symlink()
                and path.resolve().parent == self.cache_dir and path.is_file())

    def _ensure_cache_space(self, required: int = 0) -> None:
        try:
            reserve = 512 * 1024**2
            if self.cache_dir.stat().st_dev == self.recordings_dir.stat().st_dev:
                reserve = max(reserve, int(self.settings.min_free_bytes))
            pending = 0
            for temporary, estimate in self._cache_reservations.items():
                written = 0
                with contextlib.suppress(FileNotFoundError):
                    written = temporary.stat().st_size
                pending += max(0, estimate - written)
            if shutil.disk_usage(self.cache_dir).free < reserve + required + pending:
                raise MediaError("Insufficient cache storage for playback. Free space or configure NVR_CACHE_DIR on a larger disk.")
        except OSError:
            raise MediaError("Playback cache storage is unavailable.") from None

    async def snapshot(self, camera: dict[str, Any]) -> bytes:
        try:
            await asyncio.wait_for(self._decode_slots.acquire(), 10)
        except asyncio.TimeoutError:
            raise MediaError("Too many simultaneous preview requests.") from None
        try:
            result = await self._capture([
                self.settings.ffmpeg, "-hide_banner", "-loglevel", "error",
                *_input_args(camera.get("preview_url") or camera["url"]), "-an", "-frames:v", "1",
                "-vf", "scale=640:-2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
            ])
        finally:
            self._decode_slots.release()
        if not result.startswith(b"\xff\xd8"):
            raise MediaError("Preview unavailable.")
        return result

    async def live(self, camera: dict[str, Any]) -> AsyncIterator[bytes]:
        camera_id = str(camera["id"])
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        async with self._hub_lock:
            hub = self._hubs.get(camera_id)
            if hub is None:
                if len(self._hubs) >= 4:
                    raise MediaError("The limit of four simultaneous previews has been reached.")
                hub = _LiveHub(dict(camera))
                self._hubs[camera_id] = hub
                hub.task = asyncio.create_task(self._live_worker(hub), name=f"preview-{camera_id}")
            if len(hub.clients) >= 8:
                raise MediaError("Too many viewers for this camera.")
            hub.clients.add(queue)
        try:
            while True:
                frame = await asyncio.wait_for(queue.get(), 30)
                if frame is None:
                    break
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"
        except asyncio.TimeoutError:
            raise MediaError("Preview interrupted.") from None
        finally:
            async with self._hub_lock:
                hub.clients.discard(queue)
                if not hub.clients:
                    if self._hubs.get(camera_id) is hub:
                        self._hubs.pop(camera_id, None)
                    if hub.task:
                        hub.task.cancel()
                        await asyncio.gather(hub.task, return_exceptions=True)

    async def _live_worker(self, hub: _LiveHub) -> None:
        process = None
        try:
            async with self._decode_slots:
                process = hub.process = await self._spawn(
                    self.settings.ffmpeg, "-hide_banner", "-loglevel", "error",
                    *_input_args(hub.camera.get("preview_url") or hub.camera["url"]),
                    "-an", "-vf", "fps=2,scale=640:-2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1", pipe=True)
                assert process.stdout
                buffer = bytearray()
                while chunk := await process.stdout.read(65536):
                    buffer.extend(chunk)
                    if len(buffer) > MAX_JPEG_BYTES:
                        raise MediaError("Preview too large.")
                    while True:
                        start, end = buffer.find(b"\xff\xd8"), buffer.find(b"\xff\xd9")
                        if start < 0 or end < start:
                            break
                        frame = bytes(buffer[start:end + 2])
                        del buffer[:end + 2]
                        self._broadcast(hub, frame)
        except (MediaError, OSError):
            pass
        finally:
            await _stop_process(process)
            self._broadcast(hub, None)

    @staticmethod
    def _broadcast(hub: _LiveHub, frame: bytes | None) -> None:
        for queue in tuple(hub.clients):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            queue.put_nowait(frame)

    def _cache_path(self, recording: dict[str, Any], variant: str, extension: str) -> Path:
        source = self.recording_path(recording)
        try:
            stat = source.stat()
        except OSError:
            raise MediaError("Recording unavailable.") from None
        identity = f"{recording['id']}:{source}:{stat.st_size}:{stat.st_mtime_ns}:{variant}"
        key = hashlib.sha256(identity.encode()).hexdigest()
        return self.cache_dir / f"{key}.{extension}"

    async def _cached_job(self, path: Path, factory: Any) -> Path:
        if path.is_file():
            path.touch()
            return path
        key = str(path)
        if key not in self._jobs:
            task = asyncio.create_task(factory(), name="media-artifact")
            self._jobs[key] = task
            def finished(done: asyncio.Task) -> None:
                self._jobs.pop(key, None)
                if not done.cancelled():
                    done.exception()  # retrieve a failure even after every viewer disconnected
            task.add_done_callback(finished)
        # A disconnected viewer should not cancel another viewer's conversion.
        return await asyncio.shield(self._jobs[key])

    async def playback(self, recording: dict[str, Any], compatible: bool = False) -> Path:
        source = self.recording_path(recording)
        destination = self._cache_path(recording, "h264-v1" if compatible else "copy-v1", "mp4")
        async def convert() -> Path:
            temporary = destination.with_suffix(".part.mp4")
            process = None
            self._in_use[source] = self._in_use.get(source, 0) + 1
            try:
                async with self._transcode_slots:
                    estimate = math.ceil(source.stat().st_size * (2 if compatible else 1.05))
                    self._ensure_cache_space(estimate)
                    self._cache_reservations[temporary] = estimate
                    args = [self.settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                            "-map", "0:v:0", "-map", "0:a:0?", "-sn"]
                    if compatible:
                        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                                 "-vf", "scale=w='trunc(min(1920,iw)/2)*2':h=-2", "-threads", "2"]
                    else:
                        args += ["-c:v", "copy"]
                        if recording.get("video_codec") in {"hevc", "h265"}:
                            args += ["-tag:v", "hvc1"]
                    args += ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(temporary)]
                    process = await self._spawn(*args)
                    timeout = max(120, min(float(recording["duration"]) * 10, 21600))

                    async def complete() -> None:
                        while process.returncode is None:
                            self._ensure_cache_space()
                            try:
                                await asyncio.wait_for(process.wait(), .25)
                            except asyncio.TimeoutError:
                                pass

                    await asyncio.wait_for(complete(), timeout)
                    self._ensure_cache_space()
                    if process.returncode or not temporary.is_file() or temporary.stat().st_size == 0:
                        raise MediaError("Recording conversion failed.")
                    temporary.replace(destination)
                    return destination
            except asyncio.TimeoutError:
                raise MediaError("Recording conversion timed out.") from None
            except OSError:
                raise MediaError("Recording conversion failed.") from None
            finally:
                await _stop_process(process)
                self._cache_reservations.pop(temporary, None)
                self._in_use[source] -= 1
                if self._in_use[source] == 0:
                    del self._in_use[source]
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
        return await self._cached_job(destination, convert)

    @contextlib.asynccontextmanager
    async def playback_lease(self, recording: dict[str, Any], compatible: bool = False) -> AsyncIterator[Path]:
        destination = self._cache_path(recording, "h264-v1" if compatible else "copy-v1", "mp4")
        self._cache_leases[destination] = self._cache_leases.get(destination, 0) + 1
        try:
            yield await self.playback(recording, compatible)
        finally:
            self._cache_leases[destination] -= 1
            if self._cache_leases[destination] == 0:
                del self._cache_leases[destination]

    @contextlib.asynccontextmanager
    async def _source_slot(self, source: Path) -> AsyncIterator[None]:
        self._in_use[source] = self._in_use.get(source, 0) + 1
        try:
            async with self._transcode_slots:
                yield
        finally:
            self._in_use[source] -= 1
            if self._in_use[source] == 0:
                del self._in_use[source]

    async def thumbnail(self, recording: dict[str, Any]) -> bytes:
        """One small frame from the original file, never from the live camera."""
        source = self.recording_path(recording)
        destination = self._cache_path(recording, "thumbnail-v1", "jpg")
        if destination.is_symlink():
            raise MediaError("Preview unavailable.")

        async def extract() -> Path:
            temporary = destination.with_suffix(".part.jpg")
            self._in_use[source] = self._in_use.get(source, 0) + 1
            try:
                async with self._thumbnail_slots, self._transcode_slots:
                    self._ensure_cache_space(MAX_THUMBNAIL_BYTES)
                    result = await self._capture([
                        self.settings.ffmpeg, "-hide_banner", "-loglevel", "error",
                        "-threads", "1", "-filter_threads", "1", "-i", str(source),
                        "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
                        "-vf", "scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2",
                        "-threads", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
                    ], timeout=15, max_bytes=MAX_THUMBNAIL_BYTES)
                    if not result.startswith(b"\xff\xd8"):
                        raise MediaError("Preview unavailable.")
                    temporary.write_bytes(result)
                    temporary.replace(destination)
                    return destination
            finally:
                self._in_use[source] -= 1
                if self._in_use[source] == 0:
                    del self._in_use[source]
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)

        try:
            path = await self._cached_job(destination, extract)
            if not self._owned_cache_file(path) or path.stat().st_size > MAX_THUMBNAIL_BYTES:
                raise MediaError("Preview unavailable.")
            result = path.read_bytes()
            if not result.startswith(b"\xff\xd8"):
                raise MediaError("Preview unavailable.")
            return result
        except OSError:
            raise MediaError("Preview unavailable.") from None

    async def waveform(self, recording: dict[str, Any]) -> dict[str, Any]:
        duration = max(0.0, float(recording["duration"]))
        sample_seconds = max(0.25, duration / 1200)
        if not recording.get("audio_codec"):
            return {"duration": duration, "peaks": [], "sample_seconds": sample_seconds}
        source = self.recording_path(recording)
        destination = self._cache_path(recording, "waveform-v2", "json")
        async def extract() -> Path:
            process = None
            temporary = destination.with_suffix(".part.json")
            async with self._source_slot(source):
                try:
                    sample_rate = 16000  # preserve speech and alarms before aggregating energy bins
                    process = await self._spawn(self.settings.ffmpeg, "-hide_banner", "-loglevel", "error",
                        "-threads", "1", "-filter_threads", "1", "-i", str(source), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", str(sample_rate),
                        "-f", "f32le", "pipe:1", pipe=True)
                    assert process.stdout
                    samples_per_bin = max(1, round(sample_seconds * sample_rate))
                    peaks: list[float] = []
                    pending = b""
                    count, peak, total_samples = 0, 0.0, 0
                    async def consume() -> None:
                        nonlocal pending, count, peak, total_samples
                        while chunk := await process.stdout.read(65536):
                            pending += chunk
                            usable = len(pending) // 4 * 4
                            # Aggregate bounded chunks rather than updating
                            # counters in Python for every sample of a 2h file.
                            values = struct.unpack(f"<{usable // 4}f", pending[:usable])
                            total_samples += len(values)
                            if total_samples > (duration + 10) * sample_rate:
                                raise MediaError("Audio duration does not match the recording.")
                            offset = 0
                            while offset < len(values):
                                take = min(samples_per_bin - count, len(values) - offset)
                                current = max(map(abs, filter(math.isfinite, values[offset:offset + take])), default=0)
                                peak = max(peak, min(1.0, current))
                                count += take
                                offset += take
                                if count == samples_per_bin:
                                    peaks.append(round(peak, 4))
                                    count, peak = 0, 0.0
                            pending = pending[usable:]
                        await process.wait()
                    await asyncio.wait_for(consume(), max(60, min(duration / 2, 3600)))
                    if process.returncode:
                        raise MediaError("Waveform extraction failed.")
                    if count:
                        peaks.append(round(peak, 4))
                    payload = {"duration": duration, "peaks": peaks, "sample_seconds": samples_per_bin / sample_rate}
                    temporary.write_text(json.dumps(payload), encoding="utf-8")
                    temporary.replace(destination)
                    return destination
                except asyncio.TimeoutError:
                    raise MediaError("Waveform extraction timed out.") from None
                finally:
                    await _stop_process(process)
                    with contextlib.suppress(OSError):
                        temporary.unlink(missing_ok=True)
        path = await self._cached_job(destination, extract)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise MediaError("Waveform unavailable.") from None

    async def motion(self, recording: dict[str, Any], sensitivity: str = "medium") -> dict[str, Any]:
        try:
            duration = float(recording["duration"])
            analyzer = MotionAnalyzer(duration, sensitivity)
        except (KeyError, TypeError, ValueError) as exc:
            message = str(exc) if isinstance(exc, ValueError) and str(exc).startswith((
                "Invalid motion sensitivity.", "Motion analysis requires")) else "Invalid recording duration."
            raise MediaError(message) from None
        source = self.recording_path(recording)
        destination = self._cache_path(recording, f"motion-v1-{sensitivity}", "json")

        async def extract() -> Path:
            process = None
            temporary = destination.with_suffix(".part.json")
            # Pin even while queued: retention must not delete the selected source.
            self._in_use[source] = self._in_use.get(source, 0) + 1
            try:
                async with self._motion_slots, self._transcode_slots:
                    process = await self._spawn(self.settings.ffmpeg, "-hide_banner", "-loglevel", "error",
                        "-threads", "1", "-filter_threads", "1", "-i", str(source),
                        "-map", "0:v:0", "-an", "-sn", "-dn",
                        "-vf", "setpts=PTS-STARTPTS,fps=2:start_time=0,scale=160:90:flags=bilinear,format=gray",
                        "-threads", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1", pipe=True)
                    assert process.stdout

                    async def consume() -> None:
                        while True:
                            try:
                                frame = await process.stdout.readexactly(FRAME_BYTES)
                            except asyncio.IncompleteReadError as exc:
                                if exc.partial:
                                    raise MediaError("Motion analysis received an incomplete video frame.") from None
                                break
                            try:
                                analyzer.push(frame)
                            except ValueError as exc:
                                raise MediaError(str(exc)) from None
                            if analyzer.frames % 16 == 0:
                                await asyncio.sleep(0)
                        await process.wait()

                    await asyncio.wait_for(consume(), motion_timeout(duration))
                    if process.returncode or not analyzer.frames:
                        raise MediaError("Motion analysis failed.")
                    # A clean pipe EOF can still hide a truncated video track.
                    # Allow rounding and a short audio lead, but never mark an
                    # undecoded tail of the recording as having no movement.
                    if duration - analyzer.frames * SAMPLE_SECONDS > 2:
                        raise MediaError("Video duration does not match the recording.")
                    temporary.write_text(json.dumps(analyzer.result()), encoding="utf-8")
                    temporary.replace(destination)
                    return destination
            except asyncio.TimeoutError:
                raise MediaError("Motion analysis timed out.") from None
            except OSError:
                raise MediaError("Motion analysis unavailable.") from None
            finally:
                await _stop_process(process)
                self._in_use[source] -= 1
                if self._in_use[source] == 0:
                    del self._in_use[source]
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)

        path = await self._cached_job(destination, extract)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise MediaError("Motion analysis unavailable.") from None
