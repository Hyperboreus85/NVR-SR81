"""Media invariants, plus real FFmpeg checks when the binaries are available."""
import asyncio
import csv
import io
import os
import shutil
import socket
import struct
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from starlette.responses import FileResponse

from nvr.media import INPUT_PROTOCOLS, MediaError, MediaManager, _input_args, validate_url


class MemoryStore:
    def __init__(self):
        self.cameras = [{"id": "camera-1", "url": "rtsp://user:secret@127.0.0.1/live",
                         "enabled": False, "retention_days": 7, "audio_mode": "copy"}]
        self.records = []

    def list_cameras(self):
        return list(self.cameras)

    def list_recordings(self, **kwargs):
        return list(self.records)

    def add_recording(self, **kwargs):
        existing = next((r for r in self.records if r["path"] == kwargs["path"]), None)
        if existing:
            return existing["id"]
        row = {"id": str(len(self.records) + 1), **kwargs}
        self.records.append(row)
        return row["id"]

    def delete_recording(self, recording_id):
        self.records = [r for r in self.records if r["id"] != recording_id]


class MediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.settings = SimpleNamespace(data_dir=root, recordings_dir=root / "recordings", cache_dir=root / "cache",
                                        ffmpeg="ffmpeg", ffprobe="ffprobe", segment_seconds=60, min_free_bytes=0)
        self.store = MemoryStore()
        self.media = MediaManager(self.settings, self.store)
        self.settings.recordings_dir.mkdir()
        self.settings.cache_dir.mkdir()

    async def asyncTearDown(self):
        await self.media.stop()
        self.tmp.cleanup()

    def add_file(self, name, started_at=None, duration=60, audio_codec="aac"):
        directory = self.settings.recordings_dir / "camera-1"
        directory.mkdir(exist_ok=True)
        path = directory / name
        path.write_bytes(b"closed segment")
        self.store.add_recording(camera_id="camera-1", path=path.relative_to(self.settings.recordings_dir).as_posix(),
                                 started_at=started_at or time.time(), duration=duration, size=path.stat().st_size,
                                 video_codec="h264", audio_codec=audio_codec)
        return self.store.records[-1], path

    def test_network_inputs_reject_local_file_and_nested_protocols(self):
        for url in ["file:///etc/passwd", "concat:http://camera|file:///secret", "rtsp://", "http://host:bad/x", "https://x\n/secret"]:
            with self.subTest(url=url), self.assertRaises(MediaError):
                validate_url(url)
        self.assertEqual(validate_url("rtsp://user:secret@192.168.1.10/live"), "rtsp://user:secret@192.168.1.10/live")
        args = _input_args("rtsp://camera/live")
        self.assertIn("-rtsp_transport", args)
        self.assertIn("-timeout", args)
        self.assertNotIn("-rw_timeout", args)
        self.assertIn("-rw_timeout", _input_args("https://camera/live"))
        self.assertNotIn("file", INPUT_PROTOCOLS.split(","))
        self.assertNotIn("concat", INPUT_PROTOCOLS.split(","))

    def test_recording_paths_cannot_escape_archive(self):
        with self.assertRaises(MediaError):
            self.media.recording_path({"path": "../../secret"})
        with self.assertRaises(MediaError):
            self.media._camera_dir("../camera")

    async def test_manifest_indexes_only_newline_terminated_closed_segments(self):
        directory = self.media._camera_dir("camera-1")
        directory.mkdir()
        first = directory / "1700000000000-000000.mkv"
        second = directory / "1700000000000-000001.mkv"
        first.write_bytes(b"first")
        second.write_bytes(b"open")
        manifest = directory / "1700000000000.csv"
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow([str(first), "0", "61.5"])
        writer.writerow([str(second), "61.5", "120"])
        manifest.write_text(output.getvalue().rstrip("\n"), encoding="utf-8")
        self.media._probe_file = AsyncMock(return_value={"duration": 61.5, "video_codec": "hevc", "audio_codec": "pcm_alaw"})
        seen = set()
        await self.media._import_manifest(manifest, "camera-1", 1700000000, seen)
        self.assertEqual(len(self.store.records), 1)
        self.assertEqual(self.store.records[0]["audio_codec"], "pcm_alaw")
        self.assertEqual(self.store.records[0]["started_at"], 1700000000)
        await self.media._import_manifest(manifest, "camera-1", 1700000000, seen)
        self.assertEqual(self.media._probe_file.await_count, 1)

    async def test_recovery_uses_real_previous_segment_end_not_nominal_interval(self):
        directory = self.media._camera_dir("camera-1")
        directory.mkdir()
        first = directory / "1700000000000-000000.mkv"
        last = directory / "1700000000000-000001.mkv"
        first.write_bytes(b"closed")
        last.write_bytes(b"closed but manifest lost")
        output = io.StringIO(newline="")
        csv.writer(output).writerow([str(first), 0, 67.25])
        (directory / "1700000000000.csv").write_text(output.getvalue(), encoding="utf-8")
        self.media._probe_file = AsyncMock(return_value={"duration": 10, "video_codec": "h264", "audio_codec": None})
        await self.media._recover()
        recovered = next(r for r in self.store.records if r["path"].endswith("000001.mkv"))
        self.assertEqual(recovered["started_at"], 1700000067.25)
        await self.media._recover()
        self.assertEqual(len(self.store.records), 2)

    async def test_manifest_cursor_keeps_incomplete_line_for_next_poll(self):
        directory = self.media._camera_dir("camera-1")
        directory.mkdir()
        source = directory / "1700000000000-000000.mkv"
        source.write_bytes(b"closed")
        manifest = directory / "1700000000000.csv"
        output = io.StringIO(newline="")
        csv.writer(output, lineterminator="\n").writerow([str(source), 0, 60])
        complete = output.getvalue()
        manifest.write_text(complete[:-1], encoding="utf-8")
        self.media._probe_file = AsyncMock(return_value={"duration": 60, "video_codec": "h264", "audio_codec": None})
        cursor = [0]
        await self.media._import_manifest(manifest, "camera-1", 1700000000, set(), cursor=cursor)
        self.assertEqual(cursor[0], 0)
        manifest.write_text(complete, encoding="utf-8")
        await self.media._import_manifest(manifest, "camera-1", 1700000000, set(), cursor=cursor)
        await self.media._import_manifest(manifest, "camera-1", 1700000000, set(), cursor=cursor)
        self.assertEqual(len(self.store.records), 1)
        self.assertEqual(self.media._probe_file.await_count, 1)

    async def test_retention_removes_expired_and_oldest_for_disk_reserve(self):
        old, old_path = self.add_file("old.mkv", time.time() - 9 * 86400)
        recent, recent_path = self.add_file("recent.mkv", time.time() - 3600)
        await self.media._retention()
        self.assertFalse(old_path.exists())
        self.assertTrue(recent_path.exists())
        self.settings.min_free_bytes = 10
        with patch("nvr.media.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
            await self.media._retention()
        self.assertFalse(recent_path.exists())
        self.assertEqual(self.store.records, [])

    async def test_retention_never_removes_file_being_converted(self):
        record, path = self.add_file("active.mkv", time.time() - 9 * 86400)
        self.media._in_use[path.resolve()] = 2
        await self.media._retention()
        self.assertTrue(path.exists())
        self.assertEqual(len(self.store.records), 1)

    async def test_video_without_audio_has_empty_waveform(self):
        recording, _ = self.add_file("silent.mkv", audio_codec=None)
        data = await self.media.waveform(recording)
        self.assertEqual(data["peaks"], [])
        self.assertEqual(data["duration"], 60)

    async def test_cache_job_shared_and_survives_viewer_disconnect(self):
        output = self.settings.cache_dir / "shared.mp4"
        started = asyncio.Event()
        complete = asyncio.Event()
        calls = 0
        async def factory():
            nonlocal calls
            calls += 1
            started.set()
            await complete.wait()
            output.write_bytes(b"mp4")
            return output
        first = asyncio.create_task(self.media._cached_job(output, factory))
        await started.wait()
        second = asyncio.create_task(self.media._cached_job(output, factory))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        complete.set()
        self.assertEqual(await second, output)
        self.assertEqual(calls, 1)

    async def test_cache_hit_refreshes_lru_access_without_changing_range_etag(self):
        cached = self.settings.cache_dir / ("a" * 64 + ".mp4")
        cached.write_bytes(b"stable cached recording")
        old_access = time.time_ns() - 90_000 * 1_000_000_000
        os.utime(cached, ns=(old_access, old_access))
        before = cached.stat()
        first = FileResponse(cached, stat_result=before)
        factory = AsyncMock(side_effect=AssertionError("A cache hit must not convert again"))
        for _ in range(3):
            self.assertEqual(await self.media._cached_job(cached, factory), cached)
            current = cached.stat()
            self.assertEqual(current.st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(FileResponse(cached, stat_result=current).headers["etag"], first.headers["etag"])
        self.assertGreater(cached.stat().st_atime_ns, before.st_atime_ns)
        self.media._prune_cache()
        self.assertTrue(cached.is_file())  # recently accessed, despite its old mtime
        factory.assert_not_called()

    async def test_media_queue_reserves_foreground_capacity_without_blocking_hits_or_dedup(self):
        release = asyncio.Event()
        entered = []

        def factory_for(path):
            async def factory():
                entered.append(path)
                await release.wait()
                path.write_bytes(b"completed artifact")
                return path
            return factory

        background_paths = [self.cache_path_for_test(f"background-{index}.json") for index in range(12)]
        foreground_paths = [self.cache_path_for_test(f"foreground-{index}.mp4") for index in range(4)]
        pending = [asyncio.create_task(self.media._cached_job(path, factory_for(path), background=True))
                   for path in background_paths]
        extra_factory = AsyncMock(side_effect=AssertionError("Rejected factories must not run"))
        try:
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertEqual(len(self.media._background_jobs), 12)
            with self.assertRaisesRegex(MediaError, "Media server is busy"):
                await self.media._cached_job(self.cache_path_for_test("extra-background.json"), extra_factory, background=True)
            pending += [asyncio.create_task(self.media._cached_job(path, factory_for(path))) for path in foreground_paths]
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertEqual(len(self.media._jobs), 16)
            self.assertEqual(len(entered), 16)
            with self.assertRaisesRegex(MediaError, "Media server is busy"):
                await self.media._cached_job(self.cache_path_for_test("extra-foreground.mp4"), extra_factory)
            cached = self.cache_path_for_test("already-cached.mp4")
            cached.write_bytes(b"cache hit")
            self.assertEqual(await self.media._cached_job(cached, extra_factory, background=True), cached)
            pending.append(asyncio.create_task(self.media._cached_job(background_paths[0], extra_factory, background=True)))
            pending.append(asyncio.create_task(self.media._cached_job(foreground_paths[0], extra_factory)))
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertEqual(len(self.media._jobs), 16)
            recording, _ = self.add_file("unadmitted.mkv")
            with patch.object(self.media, "_spawn", AsyncMock(side_effect=AssertionError("No capacity"))) as spawn:
                for operation in [self.media.motion(recording), self.media.waveform(recording),
                                  self.media.thumbnail(recording), self.media.playback(recording)]:
                    with self.assertRaisesRegex(MediaError, "Media server is busy"):
                        await operation
                spawn.assert_not_called()
            self.assertFalse(self.media._in_use)
            self.assertFalse(self.media._cache_reservations)
            self.assertFalse(list(self.settings.cache_dir.glob("*.part.*")))
            extra_factory.assert_not_called()
        finally:
            release.set()
            await asyncio.gather(*pending, return_exceptions=True)
        self.assertFalse(self.media._jobs)
        self.assertFalse(self.media._background_jobs)
        self.assertEqual(len(entered), 16)

    def cache_path_for_test(self, name):
        return self.settings.cache_dir / name

    async def test_queued_background_jobs_leave_playback_and_cache_hits_available(self):
        recording, _ = self.add_file("background.mkv")
        cached = self.media._cache_path(recording, "copy-v1", "mp4")
        cached.write_bytes(b"cached playback")
        await self.media._background_slots.acquire()
        background = [asyncio.create_task(self.media.waveform(recording)),
                      asyncio.create_task(self.media.motion(recording)),
                      asyncio.create_task(self.media.thumbnail(recording))]

        async def spawn(*args, **kwargs):
            Path(args[-1]).write_bytes(b"new selected playback")
            return SimpleNamespace(returncode=0, stdin=None)

        try:
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertEqual(self.media._transcode_slots._value, 2)
            with patch.object(self.media, "_spawn", spawn):
                lease = self.media.playback_lease(recording)
                self.assertEqual(await asyncio.wait_for(lease.__aenter__(), 1), cached)
                await lease.__aexit__(None, None, None)
                selected = await asyncio.wait_for(self.media.playback({**recording, "id": "selected"}), 1)
                self.assertEqual(selected.read_bytes(), b"new selected playback")
            self.assertTrue(all(not task.done() for task in background))
        finally:
            await self.media.stop()
            await asyncio.gather(*background, return_exceptions=True)
            self.media._background_slots.release()
        self.assertFalse(self.media._in_use)

    async def test_compatible_download_shares_conversion_cache_and_response_leases(self):
        recording, _ = self.add_file("download.mkv", audio_codec="pcm_mulaw")
        started, finish = asyncio.Event(), asyncio.Event()
        calls = []

        async def spawn(*args, **kwargs):
            calls.append(args)
            process = SimpleNamespace(returncode=None, stdin=None)

            async def wait():
                await finish.wait()
                Path(args[-1]).write_bytes(b"compatible h264 aac mp4")
                process.returncode = 0
                return 0

            process.wait = wait
            started.set()
            return process

        download = self.media.download_lease(recording)
        playback = self.media.playback_lease(recording, compatible=True)
        with patch.object(self.media, "_spawn", spawn):
            first = asyncio.create_task(download.__aenter__())
            await started.wait()
            second = asyncio.create_task(playback.__aenter__())
            await asyncio.sleep(0)
            finish.set()
            paths = await asyncio.gather(first, second)
            self.assertEqual(paths[0], paths[1])
            self.assertEqual(len(calls), 1)
            self.assertEqual(self.media._cache_leases[paths[0]], 2)
            await download.__aexit__(None, None, None)
            await playback.__aexit__(None, None, None)
            async with self.media.download_lease(recording) as cached:
                self.assertEqual(cached, paths[0])
            self.assertEqual(len(calls), 1)
        args = calls[0]
        for flag, value in [("-c:v", "libx264"), ("-profile:v", "main"), ("-pix_fmt", "yuv420p"),
                            ("-c:a", "aac"), ("-profile:a", "aac_low"), ("-ar", "48000"), ("-ac", "2")]:
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertFalse(self.media._cache_leases)
        self.assertFalse(self.media._in_use)

    async def test_playback_preflight_rejects_insufficient_cache_space_before_spawning(self):
        recording, source = self.add_file("source.mkv")
        with patch("nvr.media.shutil.disk_usage", return_value=SimpleNamespace(free=0)), \
             patch.object(self.media, "_spawn", new=AsyncMock()) as spawn:
            with self.assertRaisesRegex(MediaError, "Insufficient cache storage"):
                await self.media.playback(recording)
            spawn.assert_not_called()
        self.assertNotIn(source.resolve(), self.media._in_use)
        self.assertFalse(list(self.settings.cache_dir.iterdir()))

    async def test_playback_stops_and_removes_partial_when_cache_reserve_is_reached(self):
        recording, source = self.add_file("source.mkv")
        process = SimpleNamespace(returncode=None, wait=AsyncMock(), stdin=None)

        async def spawn(*args, **kwargs):
            Path(args[-1]).write_bytes(b"partial conversion")
            return process

        stopped = AsyncMock()
        with patch.object(self.media, "_spawn", spawn), \
             patch.object(self.media, "_ensure_cache_space", side_effect=[None, MediaError("Insufficient cache storage")]), \
             patch("nvr.media._stop_process", stopped):
            with self.assertRaisesRegex(MediaError, "Insufficient cache storage"):
                await self.media.playback(recording)
        stopped.assert_awaited_once_with(process)
        self.assertFalse(list(self.settings.cache_dir.iterdir()))
        self.assertNotIn(source.resolve(), self.media._in_use)

    async def test_concurrent_playback_preflights_reserve_remaining_output_bytes(self):
        recording, _ = self.add_file("source.mkv")
        self.media.recording_path(recording).write_bytes(b"x" * 1000)
        started, finish = asyncio.Event(), asyncio.Event()
        calls = 0

        async def spawn(*args, **kwargs):
            nonlocal calls
            calls += 1
            output = Path(args[-1])
            process = SimpleNamespace(returncode=None, stdin=None)

            async def wait():
                await finish.wait()
                output.write_bytes(b"x" * 1000)
                process.returncode = 0
                return 0

            process.wait = wait
            started.set()
            return process

        with patch.object(self.media, "_spawn", spawn), \
             patch("nvr.media.shutil.disk_usage", return_value=SimpleNamespace(free=512 * 1024**2 + 2500)):
            first = asyncio.create_task(self.media.playback(recording))
            try:
                await started.wait()
                with self.assertRaisesRegex(MediaError, "Insufficient cache storage"):
                    await self.media.playback(recording, compatible=True)
                self.assertEqual(calls, 1)
                self.assertEqual(len(self.media._cache_reservations), 1)
            finally:
                finish.set()
                await first
        self.assertFalse(self.media._cache_reservations)

    async def test_long_playback_has_a_scaled_bounded_deadline(self):
        recording, _ = self.add_file("two-hours.mkv", duration=7200)
        deadlines = []
        wait_for = asyncio.wait_for

        async def spawn(*args, **kwargs):
            Path(args[-1]).write_bytes(b"converted")
            return SimpleNamespace(returncode=0, stdin=None)

        async def timed(awaitable, timeout):
            deadlines.append(timeout)
            return await wait_for(awaitable, timeout)

        with patch.object(self.media, "_spawn", spawn), patch("nvr.media.asyncio.wait_for", timed):
            result = await self.media.playback(recording)
        self.assertTrue(result.exists())
        self.assertEqual(deadlines, [21600])

    async def test_pruning_keeps_newest_oversized_mp4_and_protects_active_leases(self):
        self.settings.cache_max_bytes = 100
        old, newest, metadata = [self.settings.cache_dir / name for name in ["a" * 64 + ".mp4", "b" * 64 + ".mp4", "c" * 64 + ".json"]]
        old.write_bytes(b"x" * 120)
        newest.write_bytes(b"x" * 140)
        metadata.write_bytes(b"{}")
        now = time.time()
        os.utime(old, (now - 20, now - 20))
        os.utime(newest, (now, now))
        self.media._prune_cache()
        self.assertFalse(old.exists())
        self.assertTrue(newest.exists() and metadata.exists())
        old.write_bytes(b"x" * 160)
        os.utime(old, (now - 10, now - 10))
        self.media._cache_leases[old] = 1
        self.media._prune_cache()
        self.assertTrue(old.exists() and newest.exists())
        self.media._cache_leases.clear()
        newest.unlink()
        os.utime(old, (now - 90000, now - 90000))
        self.media._prune_cache()
        self.assertFalse(old.exists())

    async def test_cache_cleanup_and_storage_pressure_never_delete_foreign_files(self):
        self.settings.cache_max_bytes = 0
        foreign = [self.settings.cache_dir / name for name in [
            "original.mkv", "credentials.key", "foreign.json", "foreign.part.json", "f" * 64 + ".mkv"]]
        old = time.time() - 90000
        for path in foreign:
            path.write_bytes(b"must survive cache cleanup")
            os.utime(path, (old, old))
        owned = self.settings.cache_dir / ("d" * 64 + ".json")
        part = self.settings.cache_dir / ("e" * 64 + ".part.mp4")
        for path in [owned, part]:
            path.write_bytes(b"stale generated cache")
            os.utime(path, (old, old))
        self.media._prune_cache()
        self.assertFalse(owned.exists() or part.exists())
        with patch("nvr.media.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(MediaError, "Insufficient cache storage"):
                self.media._ensure_cache_space(100)
        self.assertTrue(all(path.read_bytes() == b"must survive cache cleanup" for path in foreign))

    async def test_cache_cleanup_ignores_generated_names_that_are_symlinks_outside_cache(self):
        outside = Path(self.tmp.name) / "outside.json"
        outside.write_bytes(b"outside file")
        os.utime(outside, (time.time() - 90000, time.time() - 90000))
        links = [self.settings.cache_dir / ("1" * 64 + ".json"),
                 self.settings.cache_dir / ("2" * 64 + ".part.mp4")]
        try:
            for link in links:
                link.symlink_to(outside)
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this platform")
        self.settings.cache_max_bytes = 0
        self.media._prune_cache()
        self.assertTrue(all(link.is_symlink() for link in links))
        self.assertEqual(outside.read_bytes(), b"outside file")

    async def test_playback_lease_is_pinned_before_waiting_and_released_after_response(self):
        recording, _ = self.add_file("source.mkv")
        destination = self.media._cache_path(recording, "copy-v1", "mp4")
        entered, finish = asyncio.Event(), asyncio.Event()

        async def playback(*args, **kwargs):
            self.assertEqual(self.media._cache_leases[destination], 1)
            destination.write_bytes(b"cached mp4")
            os.utime(destination, (time.time() - 90000, time.time() - 90000))
            entered.set()
            await finish.wait()
            return destination

        lease = self.media.playback_lease(recording)
        with patch.object(self.media, "playback", playback):
            opening = asyncio.create_task(lease.__aenter__())
            await entered.wait()
            self.media._prune_cache()
            self.assertTrue(destination.exists())
            finish.set()
            self.assertEqual(await opening, destination)
            self.media._prune_cache()
            self.assertTrue(destination.exists())
            await lease.__aexit__(None, None, None)
        self.assertFalse(self.media._cache_leases)
        self.media._prune_cache()
        self.assertFalse(destination.exists())

    async def test_playback_lease_releases_pin_on_conversion_failure(self):
        recording, _ = self.add_file("source.mkv")
        with patch.object(self.media, "playback", AsyncMock(side_effect=MediaError("conversion failed"))):
            with self.assertRaises(MediaError):
                async with self.media.playback_lease(recording):
                    self.fail("Failed playback must not yield")
        self.assertFalse(self.media._cache_leases)

    async def test_waveform_pins_source_while_queued_and_shutdown_releases_it(self):
        recording, source = self.add_file("expired.mkv", time.time() - 9 * 86400)
        await self.media._transcode_slots.acquire()
        await self.media._transcode_slots.acquire()
        with patch.object(self.media, "_spawn", AsyncMock()) as spawn:
            request = asyncio.create_task(self.media.waveform(recording))
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertEqual(self.media._in_use[source.resolve()], 1)
            await self.media._retention()
            self.assertTrue(source.exists())
            await self.media.stop()
            await asyncio.gather(request, return_exceptions=True)
            spawn.assert_not_called()
        self.assertFalse(self.media._in_use)

    async def test_waveform_chunk_boundaries_preserve_peaks_and_ignore_nonfinite_audio(self):
        recording, _ = self.add_file("audio.mkv", duration=.5)
        values = [0.] * 3999 + [.5] + [float("nan"), float("inf"), -float("inf"), -.9] + [0.] * 3996
        pcm = struct.pack(f"<{len(values)}f", *values)
        chunks = [pcm[index:index + 17] for index in range(0, len(pcm), 17)] + [b""]
        process = SimpleNamespace(stdout=SimpleNamespace(read=AsyncMock(side_effect=chunks)), returncode=0,
                                  stdin=None, wait=AsyncMock(return_value=0))
        with patch.object(self.media, "_spawn", AsyncMock(return_value=process)):
            result = await self.media.waveform(recording)
        self.assertEqual(result["peaks"], [.5, .9])
        self.assertEqual(result["sample_seconds"], .25)

    async def test_live_preview_releases_process_after_last_viewer(self):
        entered, exited = asyncio.Event(), asyncio.Event()
        async def fake_worker(hub):
            entered.set()
            self.media._broadcast(hub, b"\xff\xd8frame\xff\xd9")
            try:
                await asyncio.Future()
            finally:
                exited.set()
        self.media._live_worker = fake_worker
        stream = self.media.live(self.store.cameras[0])
        frame = await anext(stream)
        self.assertIn(b"Content-Type: image/jpeg", frame)
        await stream.aclose()
        self.assertTrue(exited.is_set())
        self.assertFalse(self.media._hubs)

    async def test_missing_binary_error_never_leaks_credentials(self):
        self.settings.ffprobe = str(Path(self.tmp.name) / "missing-executable")
        with self.assertRaises(MediaError) as caught:
            await self.media.probe("rtsp://user:very-secret@camera/live")
        self.assertNotIn("very-secret", str(caught.exception))


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")
RTSP_SERVER = os.environ.get("NVR_TEST_RTSP_SERVER")


@unittest.skipUnless(FFMPEG and FFPROBE, "Set NVR_TEST_FFMPEG and NVR_TEST_FFPROBE for media integration tests")
class RealMediaTests(MediaTests):
    async def make_fixture(self, path, codec="libx264", seconds=3):
        self.settings.ffmpeg, self.settings.ffprobe = FFMPEG, FFPROBE
        args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000", "-t", str(seconds),
                "-c:v", codec, "-preset", "ultrafast", "-g", "10", "-c:a", "pcm_alaw"]
        if codec == "libx265":
            args += ["-x265-params", "pools=1:frame-threads=1:log-level=error"]
        process = await asyncio.create_subprocess_exec(*args, str(path), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, error = await asyncio.wait_for(process.communicate(), 30)
        self.assertEqual(process.returncode, 0, error.decode(errors="replace"))

    async def test_real_h264_g711_recording_playback_and_waveform(self):
        self.settings.ffmpeg, self.settings.ffprobe = FFMPEG, FFPROBE
        directory = self.media._camera_dir("camera-1")
        directory.mkdir()
        source = directory / "1700000000000-000000.mkv"
        process = await asyncio.create_subprocess_exec(
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=8000", "-t", "2", "-c:v", "libx264",
            "-preset", "ultrafast", "-c:a", "pcm_alaw", str(source),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, error = await process.communicate()
        self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
        info = await self.media._probe_file(source)
        self.assertEqual(info["video_codec"], "h264")
        self.assertEqual(info["audio_codec"], "pcm_alaw")
        self.store.add_recording(camera_id="camera-1", path=source.relative_to(self.settings.recordings_dir).as_posix(),
            started_at=1700000000, duration=info["duration"], size=source.stat().st_size,
            video_codec=info["video_codec"], audio_codec=info["audio_codec"])
        recording = self.store.records[-1]
        waveform = await self.media.waveform(recording)
        self.assertGreater(len(waveform["peaks"]), 1)
        self.assertGreater(max(waveform["peaks"]), 0.05)  # 1 kHz alarms must survive peak extraction
        self.assertLessEqual(max(waveform["peaks"]), 1)
        native = await self.media.playback(recording)
        native_info = await self.media._probe_file(native)
        self.assertEqual(native_info["video_codec"], "h264")
        self.assertEqual(native_info["audio_codec"], "aac")
        compatible = await self.media.playback(recording, compatible=True)
        self.assertEqual((await self.media._probe_file(compatible))["video_codec"], "h264")
        self.assertFalse(list(self.settings.cache_dir.glob("*.part.*")))

    async def test_real_h265_native_and_browser_compatible_playback(self):
        directory = self.media._camera_dir("camera-1")
        directory.mkdir()
        source = directory / "1700000000000-000000.mkv"
        await self.make_fixture(source, "libx265", 2)
        info = await self.media._probe_file(source)
        self.assertEqual(info["video_codec"], "hevc")
        self.store.add_recording(camera_id="camera-1", path=source.relative_to(self.settings.recordings_dir).as_posix(),
            started_at=1700000000, duration=info["duration"], size=source.stat().st_size,
            video_codec=info["video_codec"], audio_codec=info["audio_codec"])
        record = self.store.records[-1]
        native = await self.media.playback(record)
        self.assertEqual((await self.media._probe_file(native))["video_codec"], "hevc")
        compatible = await self.media.playback(record, compatible=True)
        self.assertEqual((await self.media._probe_file(compatible))["video_codec"], "h264")

    async def test_real_4k_h264_mulaw_is_remuxed_and_compatible_mp4_is_standard_h264_aac(self):
        self.settings.ffmpeg, self.settings.ffprobe = FFMPEG, FFPROBE
        recording, source = self.add_file("4k-mulaw.mkv", duration=3, audio_codec="pcm_mulaw")
        fixture = await asyncio.create_subprocess_exec(
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            "color=c=gray:size=3840x2160:rate=2", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=8000",
            "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuvj420p",
            "-profile:v", "main", "-level:v", "5.1", "-x264-params", "cabac=1", "-threads", "1",
            "-c:a", "pcm_mulaw", str(source), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, error = await asyncio.wait_for(fixture.communicate(), 30)
        self.assertEqual(fixture.returncode, 0, error.decode(errors="replace"))
        native = await self.media.playback(recording)
        native_info = await self.media._probe_file(native)
        self.assertEqual(native_info["video_codec"], "h264")
        self.assertEqual((native_info["width"], native_info["height"]), (3840, 2160))
        self.assertEqual(native_info["audio_codec"], "aac")
        async with self.media.download_lease(recording) as path:
            info = await self.media._probe_file(path)
            self.assertEqual((info["width"], info["height"]), (1920, 1080))
            self.assertEqual(info["video_codec"], "h264")
            video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
            audio = next(stream for stream in info["streams"] if stream["codec_type"] == "audio")
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertEqual(video["profile"], "Main")
            self.assertEqual((audio["codec_name"], audio["profile"], int(audio["sample_rate"]), audio["channels"]), ("aac", "LC", 48000, 2))
            self.assertLess(path.read_bytes().find(b"moov"), path.read_bytes().find(b"mdat"))
            decoded = await asyncio.create_subprocess_exec(
                FFMPEG, "-v", "error", "-threads", "1", "-i", str(path), "-frames:v", "2", "-f", "null", "-",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, error = await asyncio.wait_for(decoded.communicate(), 20)
            self.assertEqual(decoded.returncode, 0, error.decode(errors="replace"))
        self.assertFalse(self.media._cache_leases)

    async def test_real_two_hour_waveform_has_bounded_bins_and_detects_alarm_tone(self):
        self.settings.ffmpeg, self.settings.ffprobe = FFMPEG, FFPROBE
        recording, source = self.add_file("two-hours.mkv", duration=7200, audio_codec="pcm_alaw")
        fixture = await asyncio.create_subprocess_exec(
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            "color=c=black:size=64x64:rate=1/10", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=8000",
            "-t", "7200", "-c:v", "libx264", "-preset", "ultrafast", "-g", "1", "-threads", "1",
            "-c:a", "pcm_alaw", str(source), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, error = await asyncio.wait_for(fixture.communicate(), 45)
        self.assertEqual(fixture.returncode, 0, error.decode(errors="replace"))
        result = await asyncio.wait_for(self.media.waveform(recording), 90)
        self.assertEqual(result["duration"], 7200)
        self.assertEqual(result["sample_seconds"], 6)
        self.assertEqual(len(result["peaks"]), 1200)
        self.assertTrue(all(.05 < peak <= 1 for peak in result["peaks"]))
        self.assertFalse(self.media._in_use)
        self.assertFalse(list(self.settings.cache_dir.glob("*.part.*")))

    async def test_real_http_recording_preview_shutdown_and_recovery(self):
        fixture = Path(self.tmp.name) / "camera.mkv"
        await self.make_fixture(fixture)
        content = fixture.read_bytes()
        async def serve(reader, writer):
            try:
                await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: " +
                             str(len(content)).encode() + b"\r\nConnection: close\r\n\r\n" + content)
                await writer.drain()
            except (ConnectionError, asyncio.TimeoutError):
                pass
            finally:
                writer.close()
                with __import__("contextlib").suppress(ConnectionError):
                    await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        async with server:
            port = server.sockets[0].getsockname()[1]
            self.store.cameras[0].update(url=f"http://127.0.0.1:{port}/camera.mkv", enabled=True)
            self.settings.segment_seconds = 1
            await self.media.start()
            async def wait_segments():
                while len(self.store.records) < 2:
                    await asyncio.sleep(0.1)
            await asyncio.wait_for(wait_segments(), 15)
            jpeg = await self.media.snapshot(self.store.cameras[0])
            self.assertTrue(jpeg.startswith(b"\xff\xd8"))
            stream = self.media.live(self.store.cameras[0])
            frame = await asyncio.wait_for(anext(stream), 10)
            self.assertIn(b"Content-Type: image/jpeg", frame)
            await stream.aclose()
            self.assertFalse(self.media._hubs)
            await self.media.stop()
        self.assertTrue(all(r["video_codec"] == "h264" and r["audio_codec"] == "pcm_alaw" for r in self.store.records))
        count = len(self.store.records)
        self.assertGreaterEqual(count, 2)
        await self.media._recover()
        self.assertEqual(len(self.store.records), count)

    @unittest.skipUnless(RTSP_SERVER, "Set NVR_TEST_RTSP_SERVER to the official MediaMTX executable")
    async def test_real_rtsp_tcp_probe_record_and_reconnect(self):
        fixture = Path(self.tmp.name) / "rtsp-camera.mkv"
        await self.make_fixture(fixture)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = Path(self.tmp.name) / "mediamtx.yml"
        config.write_text(f"logLevel: error\nrtspAddress: 127.0.0.1:{port}\nrtspTransports: [tcp]\n"
                          "rtmp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\npaths:\n  all_others:\n", encoding="utf-8")
        url = f"rtsp://127.0.0.1:{port}/camera"
        server = publisher = None
        async def start_fixture():
            nonlocal server, publisher
            server = await asyncio.create_subprocess_exec(RTSP_SERVER, str(config), stdout=asyncio.subprocess.DEVNULL,
                                                          stderr=asyncio.subprocess.DEVNULL)
            async def ready():
                while True:
                    if server.returncode is not None:
                        self.fail("MediaMTX could not start")
                    try:
                        reader, writer = await asyncio.open_connection("127.0.0.1", port)
                        writer.close()
                        await writer.wait_closed()
                        return
                    except OSError:
                        await asyncio.sleep(0.1)
            await asyncio.wait_for(ready(), 5)
            publisher = await asyncio.create_subprocess_exec(
                FFMPEG, "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", str(fixture),
                "-c", "copy", "-f", "rtsp", "-rtsp_transport", "tcp", url,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.sleep(1)
        async def terminate(process):
            if process is not None and process.returncode is None:
                process.terminate()
                await asyncio.wait_for(process.wait(), 5)
        async def wait_count(count):
            while len(self.store.records) <= count:
                await asyncio.sleep(0.1)
        try:
            await start_fixture()
            info = await self.media.probe(url)
            self.assertEqual(info["video_codec"], "h264")
            self.assertEqual(info["audio_codec"], "pcm_alaw")
            self.store.cameras[0].update(url=url, enabled=True)
            self.settings.segment_seconds = 1
            await self.media.start()
            await asyncio.wait_for(wait_count(1), 20)
            await terminate(server)
            await terminate(publisher)
            await asyncio.sleep(2)
            count = len(self.store.records)
            await start_fixture()
            await asyncio.wait_for(wait_count(count), 25)
            self.assertTrue(all(r["video_codec"] == "h264" and r["audio_codec"] == "pcm_alaw" for r in self.store.records))
            await self.media.stop()
            self.assertFalse(self.media.workers)
        finally:
            await self.media.stop()
            await terminate(publisher)
            await terminate(server)


if __name__ == "__main__":
    unittest.main()
