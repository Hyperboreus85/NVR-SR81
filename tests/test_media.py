"""Media invariants, plus real FFmpeg checks when the binaries are available."""
import asyncio
import csv
import io
import os
import shutil
import socket
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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
