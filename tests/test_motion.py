"""Motion timing, cache lifecycle and real low-resolution FFmpeg analysis."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from nvr.media import MediaError, MediaManager
from nvr.motion import FRAME_BYTES, MotionAnalyzer, motion_timeout


BLACK = bytes(FRAME_BYTES)
WHITE = bytes([255]) * FRAME_BYTES


def changed(count, intensity=255, offset=0):
    frame = bytearray(BLACK)
    frame[offset:offset + count] = bytes([intensity]) * count
    return bytes(frame)


def test_static_frames_and_first_frame_never_report_motion():
    analyzer = MotionAnalyzer(3)
    for _ in range(6):
        analyzer.push(WHITE)
    assert analyzer.result() == {"duration": 3, "sample_seconds": .5, "sensitivity": "medium",
                                 "events": [], "method": "frame-difference"}


def test_presets_filter_pixel_noise_and_small_image_changes():
    results = {}
    for sensitivity in ["low", "medium", "high"]:
        analyzer = MotionAnalyzer(2, sensitivity)
        analyzer.push(BLACK)
        analyzer.push(changed(100, 15))
        results[sensitivity] = analyzer.result()["events"]
    assert not results["low"] and not results["medium"]
    assert results["high"][0] == {"start": 0, "end": .5, "score": round(100 / FRAME_BYTES, 4)}
    for sensitivity, expected in [("low", False), ("medium", True), ("high", True)]:
        analyzer = MotionAnalyzer(2, sensitivity)
        analyzer.push(BLACK)
        analyzer.push(changed(100, 50))
        assert bool(analyzer.result()["events"]) is expected


def test_events_merge_short_quiet_gaps_and_clamp_to_recording_duration():
    analyzer = MotionAnalyzer(4.25)
    for frame in [BLACK, WHITE, WHITE, WHITE, BLACK, BLACK, BLACK, BLACK, WHITE, BLACK]:
        analyzer.push(frame)
    events = analyzer.result()["events"]
    assert events == [{"start": 0, "end": 2, "score": 1}, {"start": 3.5, "end": 4.25, "score": 1}]
    events[0]["end"] = 99
    assert analyzer.result()["events"][0]["end"] == 2  # callers cannot mutate internal state


@pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf"), 7260.1])
def test_invalid_or_overlong_recordings_are_rejected(duration):
    with pytest.raises(ValueError, match="up to 2 hours"):
        MotionAnalyzer(duration)


def test_invalid_sensitivity_partial_frames_and_excessive_output_are_rejected():
    with pytest.raises(ValueError, match="sensitivity"):
        MotionAnalyzer(1, "very high")
    analyzer = MotionAnalyzer(.5)
    with pytest.raises(ValueError, match="incomplete"):
        analyzer.push(b"partial")
    for _ in range(analyzer.max_frames):
        analyzer.push(BLACK)
    with pytest.raises(ValueError, match="duration"):
        analyzer.push(BLACK)
    assert motion_timeout(1) == 60 and motion_timeout(1800) == 900 and motion_timeout(7200.28) == 3600
    assert MotionAnalyzer(7200.28).max_frames == 14403


class MemoryStore:
    def __init__(self, recording):
        self.recording = recording

    def list_cameras(self):
        return [{"id": "camera", "retention_days": 1}]

    def list_recordings(self, **kwargs):
        return [self.recording] if self.recording else []

    def delete_recording(self, recording_id):
        self.recording = None


@pytest.fixture
def media_fixture(tmp_path):
    recordings, cache = tmp_path / "recordings", tmp_path / "cache"
    recordings.mkdir()
    cache.mkdir()
    source = recordings / "source.mkv"
    source.write_bytes(b"closed recording")
    recording = {"id": "recording", "camera_id": "camera", "path": "source.mkv", "duration": 3,
                 "started_at": time.time() - 2 * 86400, "size": source.stat().st_size,
                 "video_codec": "h264", "audio_codec": None}
    settings = SimpleNamespace(recordings_dir=recordings, cache_dir=cache, min_free_bytes=0, ffmpeg="ffmpeg")
    store = MemoryStore(recording)
    return MediaManager(settings, store), recording, source


class FakeProcess:
    def __init__(self, output, returncode=0):
        self.stdout = asyncio.StreamReader()
        # Deliberately split frame boundaries like a real pipe can.
        for index in range(0, len(output), 997):
            self.stdout.feed_data(output[index:index + 997])
        self.stdout.feed_eof()
        self.returncode = returncode
        self.stdin = None

    async def wait(self):
        return self.returncode


@pytest.mark.asyncio
async def test_media_cache_reuses_work_and_keys_include_sensitivity_and_source_fingerprint(media_fixture):
    media, recording, source = media_fixture
    args = []

    async def spawn(*command, **kwargs):
        args.append(command)
        return FakeProcess(BLACK + WHITE + WHITE)

    with patch.object(media, "_spawn", spawn):
        first = await media.motion(recording)
        assert first["events"] == [{"start": 0, "end": .5, "score": 1}]
        assert await media.motion(recording) == first
        await media.motion(recording, "low")
        source.write_bytes(b"changed recording fingerprint")
        await media.motion(recording)
    assert len(args) == 3
    command = args[0]
    assert command.index("-threads") < command.index("-i")
    assert command[command.index("-threads") + 1] == "1"
    assert command[command.index("-filter_threads") + 1] == "1"
    assert "setpts=PTS-STARTPTS,fps=2:start_time=0" in command[command.index("-vf") + 1]
    assert not media._in_use and not list(media.cache_dir.glob("*.part.*"))
    await media.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("output,returncode,message", [(BLACK + b"x", 0, "incomplete"),
                                                        (BLACK, 1, "failed"), (b"", 0, "failed"),
                                                        (BLACK, 0, "duration"),
                                                        (BLACK * 9, 0, "duration")],
                         ids=["partial-frame", "decoder-failure", "empty-video", "short-video", "excess-frames"])
async def test_failed_or_malformed_output_does_not_create_cache(media_fixture, output, returncode, message):
    media, recording, _ = media_fixture
    with patch.object(media, "_spawn", AsyncMock(return_value=FakeProcess(output, returncode))):
        with pytest.raises(MediaError, match=message):
            await media.motion(recording)
    assert not list(media.cache_dir.iterdir()) and not media._in_use
    await media.stop()


@pytest.mark.asyncio
async def test_dedup_disconnect_source_pin_retention_and_shutdown_cleanup(media_fixture):
    media, recording, source = media_fixture
    started, finish = asyncio.Event(), asyncio.Event()
    process = FakeProcess(BLACK)
    calls = 0

    async def blocked_read(_):
        started.set()
        await finish.wait()
        raise asyncio.IncompleteReadError(b"", FRAME_BYTES)

    process.stdout.readexactly = blocked_read

    async def spawn(*args, **kwargs):
        nonlocal calls
        calls += 1
        return process

    stopped = AsyncMock()
    with patch.object(media, "_spawn", spawn), patch("nvr.media._stop_process", stopped):
        first = asyncio.create_task(media.motion(recording))
        await started.wait()
        second = asyncio.create_task(media.motion(recording))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        assert media._in_use[source] == 1
        await media._retention()
        assert source.exists()  # expired source remains pinned for shared analysis
        assert calls == 1 and not second.done()
        await media.stop()
        result = await asyncio.gather(second, return_exceptions=True)
        assert isinstance(result[0], asyncio.CancelledError)
    assert stopped.await_count == 1 and not media._in_use and not media._jobs
    assert not list(media.cache_dir.iterdir())


@pytest.mark.asyncio
async def test_timeout_is_safe_and_cleans_process(media_fixture):
    media, recording, _ = media_fixture
    process = FakeProcess(BLACK)

    async def stalled_read(_):
        await asyncio.Future()

    process.stdout.readexactly = stalled_read
    stopped = AsyncMock()
    with patch.object(media, "_spawn", AsyncMock(return_value=process)), \
         patch("nvr.media.motion_timeout", return_value=.01), patch("nvr.media._stop_process", stopped):
        with pytest.raises(MediaError, match="Motion analysis timed out"):
            await media.motion(recording)
    assert stopped.await_count == 1 and not media._in_use and not list(media.cache_dir.iterdir())
    await media.stop()


@pytest.mark.asyncio
async def test_only_one_motion_job_runs_and_queued_source_is_pinned(media_fixture):
    media, recording, source = media_fixture
    entered, finish = asyncio.Event(), asyncio.Event()
    calls = 0

    async def spawn(*args, **kwargs):
        nonlocal calls
        calls += 1
        process = FakeProcess(BLACK + WHITE)
        if calls == 1:
            first_read = process.stdout.readexactly

            async def blocked_read(size):
                entered.set()
                await finish.wait()
                return await first_read(size)

            process.stdout.readexactly = blocked_read
        return process

    with patch.object(media, "_spawn", spawn):
        first = asyncio.create_task(media.motion(recording, "low"))
        await entered.wait()
        second = asyncio.create_task(media.motion(recording, "high"))
        for _ in range(4):
            await asyncio.sleep(0)
        assert calls == 1 and media._in_use[source] == 2
        finish.set()
        await asyncio.gather(first, second)
    assert calls == 2 and not media._in_use
    await media.stop()


@pytest.mark.asyncio
async def test_motion_rejects_invalid_inputs_before_starting_ffmpeg(media_fixture):
    media, recording, _ = media_fixture
    with patch.object(media, "_spawn", AsyncMock()) as spawn:
        for values, sensitivity in [(recording, "invalid"), ({**recording, "duration": "secret-url"}, "medium"),
                                    ({**recording, "duration": 7261}, "medium")]:
            with pytest.raises(MediaError) as caught:
                await media.motion(values, sensitivity)
            assert "secret-url" not in str(caught.value)
        spawn.assert_not_called()
    await media.stop()


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")


@pytest.mark.asyncio
@pytest.mark.skipif(not FFMPEG, reason="FFmpeg required")
@pytest.mark.parametrize("codec", ["libx264", "libx265"])
async def test_real_static_and_moving_box_known_window(media_fixture, codec):
    media, recording, source = media_fixture
    media.settings.ffmpeg = FFMPEG

    async def create_fixture(moving):
        command = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", "1",
                   "-f", "lavfi", "-i", "color=c=black:size=160x90:rate=10"]
        if moving:
            command += ["-f", "lavfi", "-i", "color=c=white:size=24x24:rate=10", "-filter_complex",
                        "[0:v][1:v]overlay=x='10+20*t':y=30:enable='between(t,2,5)'"]
        command += ["-t", "6", "-c:v", codec, "-preset", "ultrafast", "-threads", "1"]
        if codec == "libx265":
            command += ["-x265-params", "pools=1:frame-threads=1:log-level=error", "-output_ts_offset", "120"]
        command += [str(source)]
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL,
                                                       stderr=asyncio.subprocess.PIPE)
        _, error = await asyncio.wait_for(process.communicate(), 20)
        assert process.returncode == 0, error.decode(errors="replace")

    try:
        recording["duration"] = 6
        await create_fixture(False)
        assert (await media.motion(recording))["events"] == []
        await create_fixture(True)
        result = await media.motion(recording)
        assert len(result["events"]) == 1
        event = result["events"][0]
        assert 1.5 <= event["start"] <= 2.5 and 5 <= event["end"] <= 5.5
        assert 0 < event["score"] <= 1 and event["end"] <= result["duration"]
        # A repeat must use the persisted artifact, with no new decoder process.
        with patch.object(media, "_spawn", AsyncMock(side_effect=AssertionError("cache miss"))):
            assert await media.motion(recording) == result
    finally:
        await media.stop()


@pytest.mark.asyncio
@pytest.mark.skipif(not FFMPEG, reason="FFmpeg required")
async def test_real_virtual_two_hour_recording_with_keyframe_overrun_is_supported(media_fixture):
    media, recording, source = media_fixture
    media.settings.ffmpeg = FFMPEG
    recording["duration"] = 7200.28
    process = await asyncio.create_subprocess_exec(
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:size=64x64:rate=1", "-t", "7200.28", "-c:v", "libx264", "-preset", "ultrafast",
        "-g", "60", "-threads", "1", str(source), stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE)
    _, error = await asyncio.wait_for(process.communicate(), 30)
    assert process.returncode == 0, error.decode(errors="replace")
    try:
        result = await asyncio.wait_for(media.motion(recording), 60)
        assert result["duration"] == 7200.28 and result["events"] == []
        assert result["sample_seconds"] == .5
        assert sum(path.stat().st_size for path in media.cache_dir.iterdir()) < 256
    finally:
        await media.stop()
