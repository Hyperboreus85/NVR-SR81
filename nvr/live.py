"""Shared, bounded FFmpeg fragmented-MP4 live streams for browser MSE.

Each camera/mode has one producer, regardless of viewers. Reconnection ends
existing responses: clients must create a fresh MediaSource before retrying.
Recording workers and their original files are independent of this module.
"""
from __future__ import annotations

import asyncio
import contextlib
import struct
from dataclasses import dataclass, field
from typing import AsyncIterator

from .media import MediaError, _input_args, _stop_process
from .camera_config import preview_stream_url

MAX_INIT = 1024 * 1024
MAX_FRAGMENT = 16 * 1024 * 1024
MAX_VIEWERS = 8
INIT_TIMEOUT = 20
READ_TIMEOUT = 30


class LiveError(RuntimeError):
    """Safe user-facing failure: no URL, credential or FFmpeg stderr."""
    def __init__(self, message: str = "Live view unavailable. Check the stream and FFmpeg.", status_code: int = 503):
        super().__init__(message)
        self.status_code = status_code


def _boxes(data: bytes, start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    while start < end:
        if end - start < 8:
            raise LiveError("Invalid live stream container.")
        size, kind = struct.unpack_from(">I4s", data, start)
        header = 8
        if size == 1:
            if end - start < 16:
                raise LiveError("Invalid live stream container.")
            size = struct.unpack_from(">Q", data, start + 8)[0]
            header = 16
        if size < header or start + size > end:
            raise LiveError("Invalid live stream container.")
        yield kind, start + header, start + size
        start += size


def _avc_codec(configuration: bytes, sample_entry: str = "avc1") -> str:
    if len(configuration) < 7 or configuration[0] != 1:
        raise LiveError("Invalid live H.264 configuration.")
    return sample_entry + "." + configuration[1:4].hex().upper()


def _hevc_codec(configuration: bytes, sample_entry: str = "hev1") -> str:
    if len(configuration) < 23 or configuration[0] != 1:
        raise LiveError("Invalid live H.265 configuration.")
    profile = configuration[1]
    space = ("", "A", "B", "C")[profile >> 6]
    compatibility = int.from_bytes(configuration[2:6], "big")
    compatibility = int(f"{compatibility:032b}"[::-1], 2)
    tier = "H" if profile & 0x20 else "L"
    constraints = configuration[6:12].rstrip(b"\0")
    suffix = "".join(f".{byte:02X}" for byte in constraints)
    return f"{sample_entry}.{space}{profile & 31}.{compatibility:X}.{tier}{configuration[12]}{suffix}"


def _mime_from_init(initialization: bytes) -> str:
    """Read actual sample entries/configuration, rather than guessing profiles."""
    video, audio = [], []
    def visit(start, end, depth=0):
        if depth > 8:
            raise LiveError("Invalid live stream container.")
        for kind, payload, stop in _boxes(initialization, start, end):
            if kind in {b"moov", b"trak", b"mdia", b"minf", b"stbl"}:
                visit(payload, stop, depth + 1)
            elif kind == b"stsd":
                if stop - payload < 8:
                    raise LiveError("Invalid live stream container.")
                for entry, entry_data, entry_end in _boxes(initialization, payload + 8, stop):
                    if entry in {b"avc1", b"avc3", b"hev1", b"hvc1"}:
                        for child, data, child_end in _boxes(initialization, entry_data + 78, entry_end):
                            if child == b"avcC" and entry in {b"avc1", b"avc3"}:
                                video.append(_avc_codec(initialization[data:child_end], entry.decode()))
                            elif child == b"hvcC" and entry in {b"hev1", b"hvc1"}:
                                video.append(_hevc_codec(initialization[data:child_end], entry.decode()))
                    elif entry == b"mp4a":
                        # FFmpeg is explicitly configured to encode AAC-LC below.
                        audio.append("mp4a.40.2")
    visit(0, len(initialization))
    if len(video) != 1 or len(audio) > 1:
        raise LiveError("Unsupported live codec: try compatible mode.", 422)
    return 'video/mp4; codecs="' + ",".join(video + audio) + '"'


async def _read_box(reader: asyncio.StreamReader) -> tuple[bytes, bytes]:
    try:
        header = await asyncio.wait_for(reader.readexactly(8), READ_TIMEOUT)
        size, kind = struct.unpack(">I4s", header)
        if size == 1:
            extension = await asyncio.wait_for(reader.readexactly(8), READ_TIMEOUT)
            size = struct.unpack(">Q", extension)[0]
            header += extension
        limit = MAX_INIT if kind in {b"ftyp", b"moov"} else MAX_FRAGMENT
        if size < len(header) or size > limit:
            raise LiveError("Live segment too large or invalid. Reduce the keyframe interval.")
        payload = await asyncio.wait_for(reader.readexactly(size - len(header)), READ_TIMEOUT)
        return kind, header + payload
    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
        raise LiveError("Live stream interrupted. Reconnection required.") from None


@dataclass(eq=False)
class _Hub:
    camera: dict
    mode: str
    subscribers: set = field(default_factory=set)
    task: asyncio.Task | None = None
    idle_task: asyncio.Task | None = None
    retire_task: asyncio.Task | None = None
    process: asyncio.subprocess.Process | None = None
    initialization: bytes | None = None
    latest: bytes | None = None
    mime: str | None = None
    state: str = "starting"
    stopping: bool = False


class LiveSubscription:
    def __init__(self, manager: "LiveManager", hub: _Hub):
        self.manager, self.hub = manager, hub
        self.mode = hub.mode
        self.mime = ""
        self._initialization: bytes | None = None
        self._ready = asyncio.Event()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        self._closed = False
        self._ended = False
        self._error: LiveError | None = None
        self._streaming = False

    def _initialize(self, initialization: bytes, mime: str) -> None:
        self._initialization, self.mime = initialization, mime
        self._ready.set()

    def _finish(self, error: LiveError | None = None) -> None:
        if self._ended:
            return
        self._ended, self._error = True, error
        self._ready.set()
        while not self._queue.empty():
            self._queue.get_nowait()
        self._queue.put_nowait(None)

    async def stream(self) -> AsyncIterator[bytes]:
        if self._streaming:
            raise LiveError("This subscription is already in use.")
        self._streaming = True
        try:
            if self._closed or self._ended or self._initialization is None:
                return
            yield self._initialization
            while not self._closed:
                fragment = await self._queue.get()
                if fragment is None:
                    break
                yield fragment
        finally:
            await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._finish()
        self.manager._unsubscribe(self)


class LiveManager:
    def __init__(self, settings):
        self.settings = settings
        self.max_streams = max(1, min(32, int(getattr(settings, "live_max_streams", 16))))
        self.max_transcodes = max(0, min(4, int(getattr(settings, "live_max_transcodes", 2))))
        self._hubs: dict[tuple[str, str], _Hub] = {}
        self._lock = asyncio.Lock()
        self._stopping = False
        self._idle_seconds = 3.0

    async def start(self) -> None:
        self._stopping = False

    async def stop(self) -> None:
        self._stopping = True
        async with self._lock:
            retirements = [self._begin_retire(hub) for hub in list(self._hubs.values())]
        await asyncio.gather(*(asyncio.shield(task) for task in retirements))

    @staticmethod
    def _signature(camera):
        return (preview_stream_url(camera), camera.get("audio_mode", "copy"))

    async def reconcile(self, cameras: list[dict]) -> None:
        available = {str(camera["id"]): camera for camera in cameras}
        async with self._lock:
            for (camera_id, _), hub in list(self._hubs.items()):
                camera = available.get(camera_id)
                if camera is None or self._signature(camera) != self._signature(hub.camera):
                    await self._retire(hub)

    async def open(self, camera: dict, compatible: bool = False) -> LiveSubscription:
        try:
            _input_args(preview_stream_url(camera))
        except (MediaError, KeyError, TypeError):
            raise LiveError("Invalid live stream address.", 422) from None
        mode = "compatible" if compatible else "copy"
        key = (str(camera["id"]), mode)
        async with self._lock:
            if self._stopping:
                raise LiveError("Live view is stopping.")
            hub = self._hubs.get(key)
            if hub and hub.stopping:
                raise LiveError("Live view is stopping. Try again in a few seconds.")
            if hub and self._signature(hub.camera) != self._signature(camera):
                await self._retire(hub)
                hub = None
            if sum(len(item.subscribers) for (camera_id, _), item in self._hubs.items() if camera_id == key[0]) >= MAX_VIEWERS:
                raise LiveError("The viewer limit for this camera has been reached.", 429)
            if hub is None:
                # Idle producers may be reclaimed before refusing an active view.
                for idle in list(self._hubs.values()):
                    over_total = len(self._hubs) >= self.max_streams
                    over_transcode = compatible and sum(h.mode == "compatible" for h in self._hubs.values()) >= self.max_transcodes
                    if not idle.subscribers and (over_total or (over_transcode and idle.mode == "compatible")):
                        await self._retire(idle)
                if len(self._hubs) >= self.max_streams:
                    raise LiveError("The simultaneous live stream limit has been reached. Close a tile.", 429)
                if compatible and sum(h.mode == "compatible" for h in self._hubs.values()) >= self.max_transcodes:
                    raise LiveError("The live transcoding limit has been reached. Use an H.264 substream or close a transcoded view.", 429)
                hub = _Hub(dict(camera), mode)
                self._hubs[key] = hub
                hub.task = asyncio.create_task(self._run(hub), name=f"live-{key[0]}-{mode}")
            if hub.idle_task:
                hub.idle_task.cancel()
                hub.idle_task = None
            subscription = LiveSubscription(self, hub)
            hub.subscribers.add(subscription)
            if hub.initialization and hub.mime:
                subscription._initialize(hub.initialization, hub.mime)
                if hub.latest:
                    subscription._queue.put_nowait(hub.latest)
        try:
            await asyncio.wait_for(subscription._ready.wait(), INIT_TIMEOUT)
            if subscription._ended or not subscription.mime:
                raise subscription._error or LiveError()
            return subscription
        except asyncio.TimeoutError:
            await subscription.close()
            raise LiveError("The camera did not initialize live view within 20 seconds.") from None
        except BaseException:
            await subscription.close()
            raise

    def _unsubscribe(self, subscription: LiveSubscription) -> None:
        # All state mutations run on this event loop. Detach without an await so
        # a disconnected request cannot leave a closed viewer occupying a slot.
        hub = subscription.hub
        hub.subscribers.discard(subscription)
        self._schedule_idle(hub)

    def _schedule_idle(self, hub: _Hub) -> None:
        if hub.subscribers or hub.stopping or hub.idle_task:
            return
        hub.idle_task = asyncio.create_task(self._idle_stop(hub), name="live-idle-cleanup")

    async def _idle_stop(self, hub: _Hub) -> None:
        await asyncio.sleep(self._idle_seconds)
        async with self._lock:
            if not hub.subscribers:
                await self._retire(hub)

    async def _retire(self, hub: _Hub) -> None:
        await asyncio.shield(self._begin_retire(hub))

    def _begin_retire(self, hub: _Hub) -> asyncio.Task:
        if hub.retire_task is not None:
            return hub.retire_task
        hub.stopping = True
        hub.state = "stopping"
        if hub.idle_task and hub.idle_task is not asyncio.current_task():
            hub.idle_task.cancel()
        self._end_subscribers(hub, LiveError("Live view closed or configuration changed."))
        hub.retire_task = asyncio.create_task(self._finish_retire(hub), name="live-retire")
        return hub.retire_task

    async def _finish_retire(self, hub: _Hub) -> None:
        if hub.task:
            hub.task.cancel()
            await asyncio.gather(hub.task, return_exceptions=True)
        # Keep retiring producers charged to both limits until FFmpeg is reaped.
        key = (str(hub.camera["id"]), hub.mode)
        if self._hubs.get(key) is hub:
            self._hubs.pop(key)

    def _end_subscribers(self, hub: _Hub, error: LiveError) -> None:
        for subscription in tuple(hub.subscribers):
            subscription._finish(error)
        hub.subscribers.clear()
        self._schedule_idle(hub)

    def _publish(self, hub: _Hub, fragment: bytes) -> None:
        hub.latest = fragment
        hub.state = "live"
        for subscription in tuple(hub.subscribers):
            if subscription._queue.full():
                subscription._finish(LiveError("Viewer too slow: reconnect live view."))
                hub.subscribers.discard(subscription)
            else:
                subscription._queue.put_nowait(fragment)
        self._schedule_idle(hub)

    def _command(self, hub: _Hub) -> list[str]:
        camera = hub.camera
        args = [self.settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats",
                "-filter_threads", "1",
                "-fflags", "+genpts+discardcorrupt", "-analyzeduration", "2000000", "-probesize", "1000000",
                *_input_args(preview_stream_url(camera)), "-map", "0:v:0"]
        if camera.get("audio_mode", "copy") != "none":
            args += ["-map", "0:a:0?"]
        args += ["-sn", "-dn"]
        if hub.mode == "compatible":
            args += ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
                     "-pix_fmt", "yuv420p", "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=15",
                     "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-bf", "0", "-threads:v", "2"]
        else:
            args += ["-c:v", "copy"]
        args += ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "96k", "-ar", "48000", "-ac", "1", "-threads:a", "1",
                 "-avoid_negative_ts", "make_zero", "-max_interleave_delta", "1000000", "-flush_packets", "1",
                 "-movflags", "+frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets", "-f", "mp4", "pipe:1"]
        return args

    async def _spawn(self, hub: _Hub):
        try:
            return await asyncio.create_subprocess_exec(*self._command(hub), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=256 * 1024)
        except (OSError, ValueError, MediaError):
            raise LiveError() from None

    async def _shutdown_process(self, process) -> None:
        if process is None:
            return
        async def shutdown():
            async def drain():
                if process.stdout:
                    while await process.stdout.read(65536):
                        pass
            drain_task = asyncio.create_task(drain())
            try:
                await _stop_process(process)
            finally:
                drain_task.cancel()
                await asyncio.gather(drain_task, return_exceptions=True)
        cleanup = asyncio.create_task(shutdown(), name="live-process-cleanup")
        cancelled = False
        while True:
            try:
                await asyncio.shield(cleanup)
                break
            except asyncio.CancelledError:
                if cleanup.cancelled():
                    raise
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError

    async def _run(self, hub: _Hub) -> None:
        backoff = 1
        while not hub.stopping and not self._stopping:
            process = None
            produced = False
            try:
                hub.state = "starting" if backoff == 1 else "reconnecting"
                process = hub.process = await self._spawn(hub)
                assert process.stdout
                ftyp = pending = None
                while True:
                    kind, box = await _read_box(process.stdout)
                    if kind == b"ftyp":
                        if ftyp is not None or hub.initialization:
                            raise LiveError("Invalid live stream container.")
                        ftyp = box
                    elif kind == b"moov":
                        if ftyp is None or hub.initialization or len(ftyp) + len(box) > MAX_INIT:
                            raise LiveError("Invalid live stream initialization.")
                        hub.initialization = ftyp + box
                        hub.mime = _mime_from_init(hub.initialization)
                        for subscription in tuple(hub.subscribers):
                            subscription._initialize(hub.initialization, hub.mime)
                    elif kind == b"moof":
                        if not hub.initialization or pending is not None:
                            raise LiveError("Invalid live stream sequence.")
                        pending = box
                    elif kind == b"mdat":
                        if pending is None or len(pending) + len(box) > MAX_FRAGMENT:
                            raise LiveError("Live fragment invalid or too large.")
                        self._publish(hub, pending + box)
                        pending = None
                        produced = True
                    elif kind not in {b"free", b"skip", b"sidx", b"styp", b"mfra", b"prft"}:
                        raise LiveError("Unsupported live stream container.")
            except asyncio.CancelledError:
                raise
            except (RuntimeError, MediaError, OSError, ValueError, AssertionError) as error:
                hub.state = "reconnecting"
                # Never let a joining request receive the previous generation's
                # initialization while its process is being shut down.
                hub.initialization = hub.latest = hub.mime = None
                safe = error if isinstance(error, LiveError) else LiveError()
                self._end_subscribers(hub, safe)
            finally:
                try:
                    await self._shutdown_process(process)
                finally:
                    hub.process = None
                    hub.initialization = hub.latest = hub.mime = None
            if not hub.stopping and not self._stopping:
                if produced:
                    backoff = 1
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10)

    def status(self) -> dict:
        streams = [{"camera_id": str(hub.camera["id"]), "mode": hub.mode,
                    "viewers": len(hub.subscribers), "state": hub.state} for hub in self._hubs.values()]
        return {"active_streams": len(streams), "active_transcodes": sum(stream["mode"] == "compatible" for stream in streams),
                "viewers": sum(stream["viewers"] for stream in streams), "max_streams": self.max_streams,
                "max_transcodes": self.max_transcodes, "streams": streams}
