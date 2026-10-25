"""Real local HTTP inputs; no camera, external network, or cloud dependency."""
import asyncio
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import threading
import time

import pytest

from nvr.config import Settings
from nvr.media import MediaManager, _Worker


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe are required for real HTTP input tests")


async def execute(*arguments):
    process = await asyncio.create_subprocess_exec(*arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, error = await asyncio.wait_for(process.communicate(), 25)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, error.decode(errors="replace")
    return output


class IndexedRecordings:
    def __init__(self):
        self.records = []
        self.indexed = asyncio.Event()

    def add_recording(self, **recording):
        identity = str(len(self.records) + 1)
        self.records.append({"id": identity, **recording})
        self.indexed.set()
        return identity


@contextmanager
def fixture_server(root: Path, frames=(), *, frame_interval=0.04):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/camera.mjpg":
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=nvr-frame")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for frame in frames:
                        self.wfile.write(b"--nvr-frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                        self.wfile.flush()
                        time.sleep(frame_interval)
                    self.wfile.write(b"--nvr-frame--\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True
                return
            super().do_GET()

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(root)))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


async def record_once(media, store, url):
    camera = {"id": "http-camera", "name": "HTTP fixture", "url": url, "preview_url": "",
              "enabled": True, "retention_days": 7, "audio_mode": "copy"}
    worker = _Worker(camera, segment_seconds=60)
    media.workers[camera["id"]] = worker
    worker.task = asyncio.create_task(media._record(worker))
    try:
        await asyncio.wait_for(store.indexed.wait(), 20)
        worker.stopping = True
        await asyncio.wait_for(worker.task, 8)
        assert len(store.records) == 1
        recording = store.records[0]
        path = media.recording_path(recording)
        assert path.suffix == ".mkv" and path.is_file() and path.stat().st_size > 0
        return recording, path
    finally:
        await media.stop()


def make_media(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        ffmpeg=FFMPEG, ffprobe=FFPROBE, min_free_bytes=0)
    store = IndexedRecordings()
    return MediaManager(settings, store), store


async def inspect(path):
    return json.loads(await execute(FFPROBE, "-v", "error", "-count_packets", "-show_entries",
                                   "stream=codec_name,codec_type,width,height,nb_read_packets:format=duration",
                                   "-of", "json", str(path)))


async def test_http_hls_playlist_and_relative_segments_probe_and_record_original_h264_aac(tmp_path):
    published = tmp_path / "hls"
    published.mkdir()
    playlist = published / "camera.m3u8"
    await execute(FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=192x108:rate=5",
                  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000", "-t", "3.2",
                  "-c:v", "libx264", "-threads", "1", "-g", "5", "-sc_threshold", "0",
                  "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
                  "-hls_segment_filename", str(published / "segment-%02d.ts"), str(playlist))
    original = {path.name: path.read_bytes() for path in published.iterdir()}
    assert "#EXT-X-ENDLIST" in playlist.read_text() and len(list(published.glob("*.ts"))) >= 3
    media, store = make_media(tmp_path)
    with fixture_server(published) as base:
        probe = await media.probe(base + "/camera.m3u8")
        assert probe["video_codec"] == "h264" and probe["audio_codec"] == "aac"
        recording, path = await record_once(media, store, base + "/camera.m3u8")
    recorded = await inspect(path)
    assert recording["video_codec"] == "h264" and recording["audio_codec"] == "aac"
    assert {stream["codec_name"] for stream in recorded["streams"]} == {"h264", "aac"}
    assert 3 <= float(recorded["format"]["duration"]) <= 4
    assert {path.name: path.read_bytes() for path in published.iterdir()} == original


async def test_http_multipart_mjpeg_probes_and_records_all_original_jpeg_frames_without_audio(tmp_path):
    # Match FFmpeg's default 25fps for multipart MJPEG without timestamps.
    # This proves codec/copy support only, not timing at arbitrary input rates.
    # Other cadences require a timed source/gateway for a correct archive axis.
    published = tmp_path / "mjpeg"
    published.mkdir()
    await execute(FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=192x108:rate=25",
                  "-frames:v", "25", "-c:v", "mjpeg", "-threads", "1", str(published / "frame-%03d.jpg"))
    frames = tuple(path.read_bytes() for path in sorted(published.glob("*.jpg")))
    assert len(frames) == 25 and all(frame.startswith(b"\xff\xd8") for frame in frames)
    media, store = make_media(tmp_path)
    with fixture_server(published, frames) as base:
        probe = await media.probe(base + "/camera.mjpg")
        assert probe["video_codec"] == "mjpeg" and probe["audio_codec"] is None
        recording, path = await record_once(media, store, base + "/camera.mjpg")
    recorded = await inspect(path)
    assert recording["video_codec"] == "mjpeg" and recording["audio_codec"] is None
    assert len(recorded["streams"]) == 1
    assert recorded["streams"][0]["codec_name"] == "mjpeg"
    assert recorded["streams"][0]["nb_read_packets"] == "25"
    assert 0.9 <= float(recorded["format"]["duration"]) <= 1.2
