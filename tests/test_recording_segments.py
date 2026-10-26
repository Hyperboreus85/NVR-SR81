import asyncio
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from nvr.config import MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, SEGMENT_MINUTE_CHOICES, Settings
from nvr.media import MediaError, MediaManager, _LiveHub, _Worker


def test_recording_defaults_to_thirty_minutes_and_accepts_two_hour_override(tmp_path, monkeypatch):
    monkeypatch.delenv("NVR_SEGMENT_SECONDS", raising=False)
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings")
    assert settings.segment_seconds == 1800
    assert MIN_SEGMENT_SECONDS == 60 and MAX_SEGMENT_SECONDS == 7200
    assert SEGMENT_MINUTE_CHOICES == (1, 2, 3, 4, 5, *range(10, 121, 5))
    for seconds in [60, 7200]:
        monkeypatch.setenv("NVR_SEGMENT_SECONDS", str(seconds))
        assert Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings").segment_seconds == seconds
    for value in [59, 7201, True, 60.5, "60"]:
        with pytest.raises(ValueError):
            Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", segment_seconds=value)


def test_cache_location_is_optional_and_does_not_migrate_existing_files(tmp_path, monkeypatch):
    monkeypatch.delenv("NVR_CACHE_DIR", raising=False)
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings")
    assert settings.cache_dir == tmp_path / "data" / "cache"
    original = settings.cache_dir / "old.mp4"
    original.write_bytes(b"old cache")
    monkeypatch.setenv("NVR_CACHE_DIR", str(tmp_path / "recordings" / ".cache"))
    changed = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings")
    assert changed.cache_dir == tmp_path / "recordings" / ".cache"
    assert changed.cache_dir.is_dir() and not list(changed.cache_dir.iterdir())
    assert original.read_bytes() == b"old cache"


def test_cache_location_rejects_data_archive_root_and_camera_directory_aliases(tmp_path, monkeypatch):
    monkeypatch.delenv("NVR_CACHE_DIR", raising=False)
    data, recordings = tmp_path / "data", tmp_path / "recordings"
    for cache in [data, recordings, Path(tmp_path.anchor), recordings / "camera-id", recordings / "camera-id" / "cache"]:
        with pytest.raises(ValueError, match="dedicated directory"):
            Settings(data_dir=data, recordings_dir=recordings, cache_dir=cache)
    allowed = Settings(data_dir=data, recordings_dir=recordings, cache_dir=recordings / ".cache" / "nested")
    assert allowed.cache_dir.is_dir()


@pytest.mark.asyncio
@pytest.mark.parametrize("duration", [60, 1800, 7200])
async def test_long_recording_copies_media_and_reports_recording_before_file_closes(tmp_path, duration):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", segment_seconds=duration,
                        min_free_bytes=0)
    records = []
    store = SimpleNamespace(list_cameras=lambda: [], list_recordings=lambda **kwargs: records)
    media = MediaManager(settings, store)
    worker = _Worker({"id": "camera-1", "url": "rtsp://127.0.0.1:554/test", "audio_mode": "copy"})
    spawned = asyncio.Event()
    captured = []

    async def fake_spawn(*args):
        captured.extend(args)
        Path(args[-1].replace("%06d", "000000")).write_bytes(b"open segment contains media")
        spawned.set()
        return process

    # The fake process deliberately never finalizes a segment. Its lifecycle is
    # mocked; this checks real recorder arguments, status, and index boundaries.
    async def wait_process():
        await asyncio.Future()

    process = SimpleNamespace(returncode=None, wait=wait_process)
    with patch.object(media, "_spawn", fake_spawn), patch("nvr.media._stop_process", new=AsyncMock()):
        task = asyncio.create_task(media._record(worker))
        try:
            await asyncio.wait_for(spawned.wait(), 1)
            assert captured[captured.index("-segment_time") + 1] == str(duration)
            assert captured[captured.index("-c") + 1] == "copy"
            assert "-break_non_keyframes" not in captured
            async def recording_started():
                while worker.state != "recording":
                    await asyncio.sleep(0)
            await asyncio.wait_for(recording_started(), 1)
            assert worker.last_segment_at is None
            assert records == []
        finally:
            worker.stopping = True
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_changing_segment_length_restarts_only_recorders_and_same_value_is_noop(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", segment_seconds=60)
    camera = {"id": "camera", "url": "rtsp://127.0.0.1/live", "enabled": True}
    store = SimpleNamespace(list_cameras=lambda: [dict(camera)])
    media = MediaManager(settings, store)
    operations = []

    async def record(worker):
        operations.append(("start", worker.segment_seconds))
        try:
            await asyncio.Future()
        finally:
            operations.append(("close", worker.segment_seconds))

    async def live():
        await asyncio.Future()

    media._record = record
    live_task = asyncio.create_task(live())
    hub = _LiveHub(dict(camera), task=live_task)
    media._hubs["camera"] = hub
    existing = settings.recordings_dir / "previous.mkv"
    existing.write_bytes(b"previous closed recording")
    try:
        await media.reconcile()
        await asyncio.sleep(0)
        old_worker = media.workers["camera"]
        await media.set_segment_seconds(7200)
        await asyncio.sleep(0)
        new_worker = media.workers["camera"]
        assert old_worker.task.done() and new_worker is not old_worker
        assert operations == [("start", 60), ("close", 60), ("start", 7200)]
        assert new_worker.segment_seconds == 7200 and settings.segment_seconds == 7200
        assert media._hubs["camera"] is hub and not live_task.done()
        await media.reconcile()
        await media.set_segment_seconds(7200)
        assert media.workers["camera"] is new_worker and len(operations) == 3
        assert existing.read_bytes() == b"previous closed recording"
        for invalid in [59, 7201, 60.5, True, "60"]:
            with pytest.raises(MediaError):
                await media.set_segment_seconds(invalid)
        assert media.workers["camera"] is new_worker and settings.segment_seconds == 7200
    finally:
        await media.stop()


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")


@pytest.mark.asyncio
@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")
@pytest.mark.parametrize("seconds", [1800, 7200])
async def test_real_long_files_are_indexed_with_their_actual_durations(tmp_path, seconds):
    # Virtual media at 1 fps verifies actual long-file boundaries quickly.
    source = tmp_path / "one-hour.mkv"
    fixture = await asyncio.create_subprocess_exec(
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:size=64x64:rate=1", "-t", str(2 * seconds + 5), "-c:v", "libx264",
        "-preset", "ultrafast", "-g", "1", "-threads", "1", str(source),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, error = await asyncio.wait_for(fixture.communicate(), 30)
    assert fixture.returncode == 0, error.decode(errors="replace")
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        ffmpeg=FFMPEG, ffprobe=FFPROBE, segment_seconds=seconds, min_free_bytes=0)
    worker = _Worker({"id": "camera-1", "url": "rtsp://127.0.0.1:554/test", "audio_mode": "none"})
    rows = []

    def add_recording(**recording):
        if not any(row["path"] == recording["path"] for row in rows):
            rows.append(recording)
        if len(rows) == 3:
            worker.stopping = True

    store = SimpleNamespace(list_cameras=lambda: [], list_recordings=lambda **kwargs: rows, add_recording=add_recording)
    media = MediaManager(settings, store)
    with patch("nvr.media._input_args", return_value=["-i", str(source)]):
        await asyncio.wait_for(media._record(worker), 30)
    assert len(rows) == 3
    assert [row["duration"] for row in rows] == pytest.approx([seconds, seconds, 5], abs=0.1)
    assert rows[1]["started_at"] - rows[0]["started_at"] == pytest.approx(seconds, abs=0.1)
    assert all(row["video_codec"] == "h264" and row["audio_codec"] is None for row in rows)
    assert all((settings.recordings_dir / row["path"]).is_file() for row in rows)
    if seconds == 7200:
        # Native playback conversion and waveform metadata accept full two-hour files.
        recording = {"id": "two-hour", **rows[0]}
        try:
            playback = await asyncio.wait_for(media.playback(recording), 30)
            assert (await media._probe_file(playback))["duration"] == pytest.approx(7200, abs=.1)
            waveform = await media.waveform(recording)
            assert waveform["duration"] == pytest.approx(7200) and waveform["peaks"] == []
        finally:
            await media.stop()


@pytest.mark.asyncio
@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")
async def test_real_hot_change_closes_and_indexes_current_file_before_new_worker(tmp_path):
    source = tmp_path / "loop.mkv"
    fixture = await asyncio.create_subprocess_exec(
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:size=64x64:rate=10", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast",
        "-g", "10", "-threads", "1", str(source), stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE)
    _, error = await asyncio.wait_for(fixture.communicate(), 20)
    assert fixture.returncode == 0, error.decode(errors="replace")
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        ffmpeg=FFMPEG, ffprobe=FFPROBE, segment_seconds=60, min_free_bytes=0)
    camera = {"id": "camera", "url": "rtsp://127.0.0.1/live", "enabled": True, "audio_mode": "none"}
    records = []

    def add_recording(**row):
        if not any(record["path"] == row["path"] for record in records):
            records.append(row)

    store = SimpleNamespace(list_cameras=lambda: [dict(camera)], list_recordings=lambda **kwargs: records,
                            add_recording=add_recording)
    media = MediaManager(settings, store)

    async def wait_process():
        for _ in range(100):
            worker = media.workers["camera"]
            if worker.process is not None:
                return worker.process
            await asyncio.sleep(.05)
        raise AssertionError("Recorder did not start")

    with patch("nvr.media._input_args", return_value=["-re", "-stream_loop", "-1", "-i", str(source)]):
        try:
            await media.start()
            old = await wait_process()
            await asyncio.sleep(1.5)
            await media.set_segment_seconds(7200)
            assert old.returncode is not None
            assert records and 0 < records[0]["duration"] < 60
            assert (settings.recordings_dir / records[0]["path"]).is_file()
            new = await wait_process()
            assert new.pid != old.pid and media.workers["camera"].segment_seconds == 7200
        finally:
            await media.stop()
