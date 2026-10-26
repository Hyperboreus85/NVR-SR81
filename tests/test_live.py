import asyncio
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from nvr import live


def box(kind, payload=b""):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def initialization(configuration=b"\x01\x64\x00\x28\xff\xe1\x00", entry=b"avc1", audio=True):
    sample = box(entry, bytes(78) + box(b"avcC" if entry.startswith(b"avc") else b"hvcC", configuration))
    entries = sample + (box(b"mp4a", bytes(28)) if audio else b"")
    tree = box(b"stsd", bytes(4) + struct.pack(">I", 2 if audio else 1) + entries)
    for kind in (b"stbl", b"minf", b"mdia", b"trak", b"moov"):
        tree = box(kind, tree)
    return box(b"ftyp", b"isom" + bytes(4) + b"isomiso6mp41") + tree


INIT = initialization()
MIME = 'video/mp4; codecs="avc1.640028,mp4a.40.2"'


def camera(identity="camera-1", **values):
    return {"id": identity, "url": "rtsp://user:secret@192.168.1.20/live", "preview_url": "",
            "audio_mode": "copy", "enabled": False, **values}


class LiveCodecTests(unittest.TestCase):
    def test_avc_mime_uses_actual_profile_and_optional_audio(self):
        self.assertEqual(live._mime_from_init(INIT), MIME)
        self.assertEqual(live._mime_from_init(initialization(audio=False)), 'video/mp4; codecs="avc1.640028"')

    def test_hevc_profile_compatibility_bits_tier_and_constraints(self):
        vectors = [
            ("01 01 60 00 00 00 B0 00 00 00 00 00 5D", "hvc1.1.6.L93.B0"),
            ("01 02 20 00 00 00 90 00 00 00 00 00 99", "hvc1.2.4.L153.90"),
            ("01 A5 12 34 56 78 00 01 00 00 00 00 78", "hvc1.B5.1E6A2C48.H120.00.01"),
            ("01 C1 00 00 00 00 00 00 00 00 00 00 78", "hvc1.C1.0.L120"),
        ]
        for prefix, expected in vectors:
            config = bytes.fromhex(prefix) + bytes(10)
            with self.subTest(expected=expected):
                self.assertEqual(live._hevc_codec(config, "hvc1"), expected)
                self.assertEqual(live._mime_from_init(initialization(config, b"hvc1", audio=False)),
                                 f'video/mp4; codecs="{expected}"')

    def test_malformed_boxes_and_codec_configuration_are_rejected(self):
        for payload in (b"", bytes(7), box(b"moov", b"bad"), initialization(b"bad")):
            with self.subTest(payload=payload[:40]), self.assertRaises(live.LiveError):
                live._mime_from_init(payload)


class LiveManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = live.LiveManager(SimpleNamespace(ffmpeg="ffmpeg", live_max_streams=4, live_max_transcodes=1))
        self.manager._idle_seconds = 0.02
        self.spawned = []
        async def producer(hub):
            self.spawned.append(hub)
            hub.initialization, hub.mime = INIT, MIME
            for subscription in tuple(hub.subscribers):
                subscription._initialize(INIT, MIME)
            await asyncio.Future()
        self.manager._run = producer
        await self.manager.start()

    async def asyncTearDown(self):
        await self.manager.stop()

    async def test_lazy_shared_producer_and_late_join_init_plus_complete_fragment(self):
        self.assertEqual(self.manager.status()["active_streams"], 0)
        first = await self.manager.open(camera())
        first_stream = first.stream()
        self.assertEqual(await anext(first_stream), INIT)
        fragment = box(b"moof", b"gop") + box(b"mdat", b"samples")
        self.manager._publish(first.hub, fragment)
        self.assertEqual(await anext(first_stream), fragment)
        second = await self.manager.open(camera())
        second_stream = second.stream()
        self.assertEqual(await anext(second_stream), INIT)
        self.assertEqual(await anext(second_stream), fragment)
        self.assertEqual(len(self.spawned), 1)
        self.assertEqual(self.manager.status()["viewers"], 2)
        self.assertNotIn("secret", json.dumps(self.manager.status()))
        await first_stream.aclose()
        await second_stream.aclose()
        # Await the scheduled idle retirement itself; host load must not turn
        # an arbitrary 50 ms sleep into a false failure.
        await asyncio.wait_for(asyncio.shield(first.hub.idle_task), 1)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_slow_viewer_is_closed_instead_of_receiving_dropped_fragments(self):
        subscription = await self.manager.open(camera())
        for payload in (b"gop-1", b"gop-2", b"gop-3"):
            self.manager._publish(subscription.hub, payload)
        self.assertTrue(subscription._ended)
        self.assertEqual(self.manager.status()["viewers"], 0)
        self.assertEqual(subscription._queue.qsize(), 1)
        await subscription.close()

    async def test_camera_and_transcode_limits_do_not_spawn_extra_processes(self):
        first = await self.manager.open(camera(), compatible=True)
        with self.assertRaises(live.LiveError) as caught:
            await self.manager.open(camera("other"), compatible=True)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(len(self.spawned), 1)
        for _ in range(7):
            await self.manager.open(camera(), compatible=True)
        with self.assertRaises(live.LiveError):
            await self.manager.open(camera())
        self.assertEqual(self.manager.status()["active_streams"], 1)
        await first.close()

    async def test_total_limit_reclaims_idle_worker(self):
        self.manager.max_streams = 1
        first = await self.manager.open(camera())
        with self.assertRaises(live.LiveError) as caught:
            await self.manager.open(camera("second"))
        self.assertEqual(caught.exception.status_code, 429)
        await first.close()
        second = await self.manager.open(camera("second"))
        self.assertEqual(self.manager.status()["active_streams"], 1)
        await second.close()

    async def test_recording_disabled_camera_is_viewable_and_reconcile_changes_close_it(self):
        first = await self.manager.open(camera(enabled=False))
        await self.manager.reconcile([camera(enabled=True)])
        self.assertFalse(first._ended)
        await self.manager.reconcile([camera(url="rtsp://192.168.1.21/live")])
        self.assertTrue(first._ended)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_cancelled_initialization_releases_pending_viewer_and_worker(self):
        started = asyncio.Event()
        pending_hubs = []
        async def pending(hub):
            pending_hubs.append(hub)
            started.set()
            await asyncio.Future()
        self.manager._run = pending
        task = asyncio.create_task(self.manager.open(camera()))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(asyncio.shield(pending_hubs[0].idle_task), 1)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_close_detaches_while_another_retirement_holds_the_manager_lock(self):
        subscription = await self.manager.open(camera())
        async with self.manager._lock:
            await asyncio.wait_for(subscription.close(), 0.5)
            self.assertNotIn(subscription, subscription.hub.subscribers)
            self.assertEqual(self.manager.status()["viewers"], 0)
        await subscription.close()
        await asyncio.wait_for(asyncio.shield(subscription.hub.idle_task), 1)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_cancelled_retirement_keeps_cleanup_and_limits_until_producer_exits(self):
        cleanup_started, release_cleanup, reaped = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def producer(hub):
            self.spawned.append(hub)
            hub.initialization, hub.mime = INIT, MIME
            for subscription in tuple(hub.subscribers):
                subscription._initialize(INIT, MIME)
            try:
                await asyncio.Future()
            finally:
                cleanup_started.set()
                await release_cleanup.wait()
                reaped.set()
        self.manager._run = producer
        self.manager.max_streams = 1
        subscription = await self.manager.open(camera(), compatible=True)
        retirement = asyncio.create_task(self.manager._retire(subscription.hub))
        waiting_view = None
        try:
            await asyncio.wait_for(cleanup_started.wait(), 1)
            retirement.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await retirement
            self.assertEqual(self.manager.status()["active_streams"], 1)
            self.assertEqual(self.manager.status()["active_transcodes"], 1)
            with self.assertRaises(live.LiveError) as caught:
                await self.manager.open(camera(), compatible=True)
            self.assertEqual(caught.exception.status_code, 503)
            waiting_view = asyncio.create_task(self.manager.open(camera("second"), compatible=True))
            await asyncio.sleep(0)
            self.assertFalse(waiting_view.done())
            self.assertEqual(len(self.spawned), 1)
            waiting_view.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting_view
            self.assertFalse(reaped.is_set())
            self.assertEqual(self.manager.status()["active_streams"], 1)
        finally:
            release_cleanup.set()
            await asyncio.wait_for(subscription.hub.retire_task, 1)
            if waiting_view is not None and not waiting_view.done():
                waiting_view.cancel()
                await asyncio.gather(waiting_view, return_exceptions=True)
        self.assertTrue(reaped.is_set())
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_repeated_producer_cancellation_during_shutdown_still_reaps_process(self):
        cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
        reader = asyncio.StreamReader()
        reader.feed_data(INIT)
        process = SimpleNamespace(stdout=reader, returncode=None)
        async def spawn(hub):
            return process
        async def stop_process(stopping):
            cleanup_started.set()
            await release_cleanup.wait()
            stopping.returncode = 0
        self.manager._run = live.LiveManager._run.__get__(self.manager)
        self.manager._spawn = spawn
        with patch.object(live, "_stop_process", stop_process):
            subscription = await self.manager.open(camera())
            retirement = asyncio.create_task(self.manager._retire(subscription.hub))
            try:
                await asyncio.wait_for(cleanup_started.wait(), 1)
                for _ in range(2):
                    subscription.hub.task.cancel()
                    await asyncio.sleep(0)
                self.assertFalse(subscription.hub.task.done())
                self.assertIsNone(process.returncode)
                self.assertEqual(self.manager.status()["active_streams"], 1)
            finally:
                release_cleanup.set()
                await asyncio.wait_for(retirement, 1)
        self.assertEqual(process.returncode, 0)
        self.assertIsNone(subscription.hub.process)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_stop_retires_all_producers_in_parallel(self):
        cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()
        cleaning = set()
        async def producer(hub):
            hub.initialization, hub.mime = INIT, MIME
            for subscription in tuple(hub.subscribers):
                subscription._initialize(INIT, MIME)
            try:
                await asyncio.Future()
            finally:
                cleaning.add(hub.camera["id"])
                if len(cleaning) == 4:
                    cleanup_started.set()
                await release_cleanup.wait()
        self.manager._run = producer
        for identity in range(4):
            await self.manager.open(camera(str(identity)))
        stopping = asyncio.create_task(self.manager.stop())
        try:
            await asyncio.wait_for(cleanup_started.wait(), 1)
            self.assertEqual(self.manager.status()["active_streams"], 4)
        finally:
            release_cleanup.set()
            await asyncio.wait_for(stopping, 1)
        self.assertEqual(self.manager.status()["active_streams"], 0)

    async def test_read_box_caps_size_before_allocating_payload(self):
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack(">I4s", live.MAX_FRAGMENT + 1, b"mdat"))
        with self.assertRaises(live.LiveError):
            await live._read_box(reader)

    async def test_native_command_copies_video_and_honors_preview_and_audio_none(self):
        hub = live._Hub(camera(preview_url="rtsp://192.168.1.20/sub", audio_mode="none"), "copy")
        command = self.manager._command(hub)
        self.assertEqual(command[command.index("-i") + 1], "rtsp://192.168.1.20/sub")
        self.assertEqual(command[command.index("-c:v") + 1], "copy")
        self.assertNotIn("0:a:0?", command)
        self.assertNotIn("frag_duration", " ".join(command))


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")
RTSP_SERVER = os.environ.get("NVR_TEST_RTSP_SERVER")


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg and FFprobe are required for real live media tests")
class RealLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.manager = live.LiveManager(SimpleNamespace(ffmpeg=FFMPEG, live_max_streams=4, live_max_transcodes=2))
        self.manager._idle_seconds = 0.05
        original = self.manager._command
        def paced(hub):
            command = original(hub)
            command.insert(command.index("-i"), "-re")  # finite HTTP test file simulates a real-time camera
            return command
        self.manager._command = paced
        self.server = None

    async def asyncTearDown(self):
        await self.manager.stop()
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        self.temporary.cleanup()

    async def make_camera(self, codec="libx264", audio=True):
        source = self.directory / "camera.mkv"
        args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10"]
        if audio:
            args += ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=8000"]
        args += ["-t", "12", "-c:v", codec, "-preset", "ultrafast", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0"]
        if codec == "libx265":
            args += ["-x265-params", "pools=1:frame-threads=1:bframes=0:keyint=10:min-keyint=10:scenecut=0:log-level=error"]
        if audio:
            args += ["-c:a", "pcm_alaw"]
        process = await asyncio.create_subprocess_exec(*args, str(source), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, error = await asyncio.wait_for(process.communicate(), 30)
        self.assertEqual(process.returncode, 0, error.decode(errors="replace"))
        content = source.read_bytes()
        async def serve(reader, writer):
            try:
                await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: " + str(len(content)).encode() +
                             b"\r\nConnection: close\r\n\r\n" + content)
                await writer.drain()
            except (OSError, asyncio.TimeoutError):
                pass
            finally:
                writer.close()
                with contextlib.suppress(OSError):
                    await writer.wait_closed()
        self.server = await asyncio.start_server(serve, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        return camera(url=f"http://127.0.0.1:{port}/camera.mkv")

    async def probe(self, path):
        process = await asyncio.create_subprocess_exec(FFPROBE, "-v", "error", "-count_frames", "-show_entries",
            "stream=codec_name,codec_type,width,height,r_frame_rate,nb_read_frames", "-of", "json", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output, _ = await asyncio.wait_for(process.communicate(), 10)
        self.assertEqual(process.returncode, 0)
        return json.loads(output)["streams"]

    async def receive_fragment(self, subscription):
        stream = subscription.stream()
        initialization = await asyncio.wait_for(anext(stream), 5)
        fragment = await asyncio.wait_for(anext(stream), 10)
        self.assertEqual([kind for kind, _, _ in live._boxes(initialization)], [b"ftyp", b"moov"])
        self.assertEqual([kind for kind, _, _ in live._boxes(fragment)], [b"moof", b"mdat"])
        return stream, initialization, fragment

    async def test_real_h264_aac_shared_late_join_has_realtime_frame_rate(self):
        configured = await self.make_camera()
        first = await self.manager.open(configured)
        stream, initialization, fragment = await self.receive_fragment(first)
        self.assertIn("avc1.", first.mime)
        self.assertIn("mp4a.40.2", first.mime)
        second = await self.manager.open(configured)
        other, second_init, second_fragment = await self.receive_fragment(second)
        self.assertIs(first.hub, second.hub)
        self.assertEqual(initialization, second_init)
        self.assertEqual(fragment, second_fragment)
        path = self.directory / "h264-live.mp4"
        path.write_bytes(initialization + fragment)
        streams = await self.probe(path)
        video = next(item for item in streams if item["codec_type"] == "video")
        self.assertEqual(video["codec_name"], "h264")
        self.assertEqual(video["r_frame_rate"], "10/1")
        self.assertGreaterEqual(int(video["nb_read_frames"]), 8)
        self.assertTrue(any(item["codec_name"] == "aac" for item in streams))
        self.save_browser_fixture("live-h264.mp4", initialization + fragment, first.mime)
        process = first.hub.process
        await stream.aclose()
        await other.aclose()
        async def stopped():
            # The OS exit status can arrive before the retirement task has
            # finished draining stdout and released the manager's quota slot.
            while process.returncode is None or self.manager.status()["active_streams"] != 0:
                await asyncio.sleep(0.05)
        await asyncio.wait_for(stopped(), 6)
        self.assertEqual(self.manager.status()["active_streams"], 0)
        self.assertIsNotNone(process.returncode)

    async def test_real_hevc_native_mime_and_h264_compatibility(self):
        configured = await self.make_camera("libx265")
        native = await self.manager.open(configured)
        stream, initialization, fragment = await self.receive_fragment(native)
        self.assertTrue("hev1." in native.mime or "hvc1." in native.mime)
        self.assertIn("mp4a.40.2", native.mime)
        self.save_browser_fixture("live-hevc.mp4", initialization + fragment, native.mime)
        compatible = await self.manager.open(configured, compatible=True)
        other, compatible_init, compatible_fragment = await self.receive_fragment(compatible)
        self.assertEqual(compatible.mode, "compatible")
        self.assertIn("avc1.", compatible.mime)
        path = self.directory / "compatible.mp4"
        path.write_bytes(compatible_init + compatible_fragment)
        streams = await self.probe(path)
        video = next(item for item in streams if item["codec_type"] == "video")
        self.assertEqual(video["codec_name"], "h264")
        self.assertEqual(video["r_frame_rate"], "15/1")
        self.assertLessEqual(video["width"], 1280)
        self.assertLessEqual(video["height"], 720)
        await stream.aclose()
        await other.aclose()

    async def test_real_source_without_audio_and_producer_restart_reset_subscriptions(self):
        configured = await self.make_camera(audio=False)
        first = await self.manager.open(configured)
        stream, _, _ = await self.receive_fragment(first)
        self.assertNotIn("mp4a", first.mime)
        first.hub.process.kill()
        async def disconnected():
            while not first._ended:
                await asyncio.sleep(0.05)
        await asyncio.wait_for(disconnected(), 5)
        second = await self.manager.open(configured)
        other, initialization, fragment = await self.receive_fragment(second)
        self.assertTrue(first._ended)
        self.assertFalse(second._ended)
        self.assertTrue(initialization and fragment)
        await stream.aclose()
        await other.aclose()

    @unittest.skipUnless(RTSP_SERVER, "Set NVR_TEST_RTSP_SERVER to the official MediaMTX executable")
    async def test_real_rtsp_tcp_h264_g711_to_live_mp4(self):
        await self.make_camera()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = self.directory / "mediamtx.yml"
        config.write_text(f"logLevel: error\nrtspAddress: 127.0.0.1:{port}\nrtspTransports: [tcp]\n"
                          "rtmp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\npaths:\n  all_others:\n", encoding="utf-8")
        server = publisher = None
        try:
            server = await asyncio.create_subprocess_exec(RTSP_SERVER, str(config),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            async def ready():
                while True:
                    try:
                        _, writer = await asyncio.open_connection("127.0.0.1", port)
                        writer.close()
                        await writer.wait_closed()
                        return
                    except OSError:
                        await asyncio.sleep(0.1)
            await asyncio.wait_for(ready(), 5)
            url = f"rtsp://127.0.0.1:{port}/camera"
            publisher = await asyncio.create_subprocess_exec(FFMPEG, "-hide_banner", "-loglevel", "error", "-re",
                "-stream_loop", "-1", "-i", str(self.directory / "camera.mkv"), "-c", "copy", "-f", "rtsp",
                "-rtsp_transport", "tcp", url, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.sleep(0.5)
            subscription = await self.manager.open(camera(url=url))
            stream, initialization, fragment = await self.receive_fragment(subscription)
            self.assertIn("avc1.", subscription.mime)
            self.assertIn("mp4a.40.2", subscription.mime)
            path = self.directory / "rtsp-live.mp4"
            path.write_bytes(initialization + fragment)
            streams = await self.probe(path)
            self.assertTrue(any(item["codec_name"] == "h264" for item in streams))
            self.assertTrue(any(item["codec_name"] == "aac" for item in streams))
            await stream.aclose()
        finally:
            await self.manager.stop()
            for process in (publisher, server):
                if process is not None and process.returncode is None:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), 5)

    def save_browser_fixture(self, name, data, mime):
        destination = os.environ.get("NVR_LIVE_FIXTURE_DIR")
        if destination:
            directory = Path(destination)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / name).write_bytes(data)
            (directory / (name + ".mime.txt")).write_text(mime, encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
