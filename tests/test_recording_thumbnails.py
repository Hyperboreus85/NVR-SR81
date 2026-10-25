"""Bounded archive thumbnails, cache/retention lifecycle and authenticated API."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.media import MAX_THUMBNAIL_BYTES, MediaError, MediaManager
from nvr.store import Store


JPEG = b"\xff\xd8synthetic-thumbnail\xff\xd9"
PASSWORD = "thumbnail-test-password-strong"


@pytest.fixture
def media_fixture(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        min_free_bytes=0, password=PASSWORD)
    store = Store(settings.data_dir)
    media = MediaManager(settings, store)

    def add(name="source.mkv"):
        path = settings.recordings_dir / name
        path.write_bytes(b"original recording bytes")
        identity = store.add_recording("camera", name, time.time() - 20 * 86400, 3,
                                       path.stat().st_size, "h264")
        return store.get_recording(identity), path

    return media, store, add


@pytest.mark.asyncio
async def test_thumbnail_cache_reuses_capture_and_invalidates_changed_source(media_fixture):
    media, _, add = media_fixture
    recording, source = add()
    original = source.read_bytes()
    media._capture = AsyncMock(return_value=JPEG)
    assert await media.thumbnail(recording) == JPEG
    assert await media.thumbnail(recording) == JPEG
    assert media._capture.await_count == 1
    assert source.read_bytes() == original
    args = media._capture.call_args
    command = args.args[0]
    assert command[command.index("-i") + 1] == str(source)
    assert "192:108" in command[command.index("-vf") + 1]
    assert command[command.index("-frames:v") + 1] == "1"
    assert command.index("-threads") < command.index("-i")
    assert args.kwargs["max_bytes"] == MAX_THUMBNAIL_BYTES == 256 * 1024
    assert args.kwargs["timeout"] <= 15
    source.write_bytes(original + b"different source fingerprint")
    assert await media.thumbnail(recording) == JPEG
    assert media._capture.await_count == 2
    assert len(list(media.cache_dir.glob("*.jpg"))) == 2


@pytest.mark.asyncio
async def test_concurrent_requests_for_same_thumbnail_share_one_capture(media_fixture):
    media, _, add = media_fixture
    recording, _ = add()
    entered, resume = asyncio.Event(), asyncio.Event()

    async def capture(*args, **kwargs):
        entered.set()
        await resume.wait()
        return JPEG

    media._capture = AsyncMock(side_effect=capture)
    pending = [asyncio.create_task(media.thumbnail(recording)) for _ in range(3)]
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert media._capture.await_count == 1
        resume.set()
        assert await asyncio.wait_for(asyncio.gather(*pending), 5) == [JPEG] * 3
        assert media._capture.await_count == 1
        assert not media._in_use
    finally:
        resume.set()
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_different_thumbnails_capture_one_at_a_time_and_pin_queued_sources(media_fixture):
    media, store, add = media_fixture
    sources = [add(f"source-{index}.mkv") for index in range(3)]
    entered, resume = asyncio.Event(), asyncio.Event()
    active = maximum = 0

    async def capture(*args, **kwargs):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        entered.set()
        try:
            await resume.wait()
            return JPEG
        finally:
            active -= 1

    media._capture = AsyncMock(side_effect=capture)
    pending = [asyncio.create_task(media.thumbnail(recording)) for recording, _ in sources]
    try:
        await asyncio.wait_for(entered.wait(), 5)
        async with asyncio.timeout(5):
            while not all(path in media._in_use for _, path in sources):
                await asyncio.sleep(0)
        assert media._capture.await_count == 1
        await media._retention()
        assert all(path.is_file() and store.get_recording(recording["id"])
                   for recording, path in sources)
        resume.set()
        assert await asyncio.wait_for(asyncio.gather(*pending), 5) == [JPEG] * 3
        assert maximum == 1
        assert media._capture.await_count == 3
        assert not media._in_use
    finally:
        resume.set()
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_thumbnail_waits_for_shared_transcode_capacity_without_losing_source(media_fixture):
    media, store, add = media_fixture
    recording, source = add()
    media._capture = AsyncMock(return_value=JPEG)
    await media._transcode_slots.acquire()
    await media._transcode_slots.acquire()
    pending = asyncio.create_task(media.thumbnail(recording))
    try:
        async with asyncio.timeout(5):
            while source not in media._in_use:
                await asyncio.sleep(0)
        media._capture.assert_not_awaited()
        await media._retention()
        assert source.exists() and store.get_recording(recording["id"])
    finally:
        media._transcode_slots.release()
        media._transcode_slots.release()
    assert await asyncio.wait_for(pending, 5) == JPEG
    assert not media._in_use


@pytest.mark.asyncio
async def test_invalid_thumbnail_is_not_cached_and_source_is_preserved(media_fixture):
    media, _, add = media_fixture
    recording, source = add()
    original = source.read_bytes()
    media._capture = AsyncMock(return_value=b"not an image")
    with pytest.raises(MediaError, match="Preview unavailable"):
        await media.thumbnail(recording)
    assert source.read_bytes() == original
    assert not list(media.cache_dir.glob("*.jpg"))
    assert not media._in_use


@pytest.mark.asyncio
async def test_stop_cancels_thumbnail_job_and_releases_pin_without_partial_cache(media_fixture):
    media, _, add = media_fixture
    recording, source = add()
    entered = asyncio.Event()

    async def capture(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    media._capture = AsyncMock(side_effect=capture)
    pending = asyncio.create_task(media.thumbnail(recording))
    await asyncio.wait_for(entered.wait(), 5)
    await asyncio.wait_for(media.stop(), 5)
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert source.exists()
    assert not media._in_use
    assert not list(media.cache_dir.glob("*.jpg"))


class ApiMedia:
    def __init__(self, settings, store):
        self.thumbnail = AsyncMock(return_value=JPEG)

    async def start(self): pass
    async def stop(self): pass


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        password=PASSWORD)
    with TestClient(create_app(settings, media_factory=ApiMedia)) as client:
        yield client


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD},
                       headers={"X-NVR-Request": "1"}).status_code == 200


def test_thumbnail_api_requires_auth_and_returns_jpeg_without_private_metadata(client):
    store, settings = client.app.state.store, client.app.state.settings
    source = settings.recordings_dir / "source.mkv"
    source.write_bytes(b"private source")
    identity = store.add_recording("camera", "source.mkv", 100, 90, source.stat().st_size, "h264")
    url = f"/api/recordings/{identity}/thumbnail"
    assert client.get(url).status_code == 401
    client.app.state.media.thumbnail.assert_not_awaited()
    login(client)
    response = client.get(url)
    assert response.status_code == 200 and response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "no-store"
    assert str(source).encode() not in response.content
    assert b"private source" not in response.content


def test_thumbnail_api_rejects_missing_files_and_paths_outside_archive(client, tmp_path):
    login(client)
    store = client.app.state.store
    assert client.get("/api/recordings/missing/thumbnail").status_code == 404
    missing = store.add_recording("camera", "absent.mkv", 100, 30, 10, "h264")
    assert client.get(f"/api/recordings/{missing}/thumbnail").status_code == 404
    outside = tmp_path / "outside.mkv"
    outside.write_bytes(b"outside secret")
    unsafe = store.add_recording("camera", str(outside), 100, 30, outside.stat().st_size, "h264")
    response = client.get(f"/api/recordings/{unsafe}/thumbnail")
    assert response.status_code == 404 and str(outside) not in response.text
    traversal = store.add_recording("camera", "../outside.mkv", 100, 30, 14, "h264")
    assert client.get(f"/api/recordings/{traversal}/thumbnail").status_code == 404
    client.app.state.media.thumbnail.assert_not_awaited()


def test_thumbnail_api_redacts_media_errors(client):
    login(client)
    settings, store = client.app.state.settings, client.app.state.store
    (settings.recordings_dir / "source.mkv").write_bytes(b"source")
    identity = store.add_recording("camera", "source.mkv", 100, 30, 6, "h264")
    client.app.state.media.thumbnail.side_effect = OSError("private path or credentials")
    response = client.get(f"/api/recordings/{identity}/thumbnail")
    assert response.status_code == 503
    assert "private path" not in response.text and "credentials" not in response.text


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")


@pytest.mark.asyncio
@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg/FFprobe are required for a real JPEG thumbnail")
async def test_real_ffmpeg_thumbnail_is_192_by_108_and_leaves_original_unchanged(media_fixture, tmp_path):
    media, _, add = media_fixture
    recording, source = add()
    media.settings.ffmpeg, media.settings.ffprobe = FFMPEG, FFPROBE
    process = await asyncio.create_subprocess_exec(
        FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=2",
        "-t", "1", "-c:v", "libx264", "-threads", "1", str(source),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, error = await asyncio.wait_for(process.communicate(), 20)
    assert process.returncode == 0, error.decode(errors="replace")
    before = hashlib.sha256(source.read_bytes()).digest()
    image = await media.thumbnail(recording)
    assert image.startswith(b"\xff\xd8") and len(image) <= MAX_THUMBNAIL_BYTES
    assert hashlib.sha256(source.read_bytes()).digest() == before
    target = tmp_path / "actual-thumbnail.jpg"
    target.write_bytes(image)
    process = await asyncio.create_subprocess_exec(
        FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
        "-of", "json", str(target), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    output, error = await asyncio.wait_for(process.communicate(), 15)
    assert process.returncode == 0, error.decode(errors="replace")
    stream = json.loads(output)["streams"][0]
    assert stream == {"codec_name": "mjpeg", "width": 192, "height": 108}
