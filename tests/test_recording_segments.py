import asyncio
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from nvr.config import Settings
from nvr.media import MediaManager, _Worker


def test_recording_defaults_to_thirty_minutes_and_accepts_hour_override(tmp_path, monkeypatch):
    monkeypatch.delenv("NVR_SEGMENT_SECONDS", raising=False)
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings")
    assert settings.segment_seconds == 1800
    monkeypatch.setenv("NVR_SEGMENT_SECONDS", "3600")
    assert Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings").segment_seconds == 3600
    monkeypatch.setenv("NVR_SEGMENT_SECONDS", "3601")
    with pytest.raises(ValueError):
        Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings")


@pytest.mark.asyncio
@pytest.mark.parametrize("duration", [1800, 3600])
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
            assert worker.state == "recording"
            assert worker.last_segment_at is None
            assert records == []
        finally:
            worker.stopping = True
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")


@pytest.mark.asyncio
@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")
async def test_real_thirty_minute_files_are_indexed_with_their_actual_durations(tmp_path):
    # One virtual hour at 1 fps is encoded faster than real time. This verifies
    # real 1800-second media boundaries without waiting an hour in the test.
    source = tmp_path / "one-hour.mkv"
    fixture = await asyncio.create_subprocess_exec(
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:size=64x64:rate=1", "-t", "3605", "-c:v", "libx264",
        "-preset", "ultrafast", "-g", "1", "-threads", "1", str(source),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, error = await asyncio.wait_for(fixture.communicate(), 30)
    assert fixture.returncode == 0, error.decode(errors="replace")
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        ffmpeg=FFMPEG, ffprobe=FFPROBE, segment_seconds=1800, min_free_bytes=0)
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
    assert [row["duration"] for row in rows] == pytest.approx([1800, 1800, 5], abs=0.1)
    assert rows[1]["started_at"] - rows[0]["started_at"] == pytest.approx(1800, abs=0.1)
    assert all(row["video_codec"] == "h264" and row["audio_codec"] is None for row in rows)
    assert all((settings.recordings_dir / row["path"]).is_file() for row in rows)
