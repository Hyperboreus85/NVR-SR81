"""Every archive-clear operation is confined to a pytest temporary fixture."""
import asyncio
import csv
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from nvr import media as module
from nvr.config import Settings
from nvr.media import ArchiveClearError, MediaManager, _LiveHub, _Worker
from nvr.store import Store


FFMPEG = os.environ.get("NVR_TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("NVR_TEST_FFPROBE") or shutil.which("ffprobe")


@pytest_asyncio.fixture
async def archive(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", ffmpeg=FFMPEG or "ffmpeg",
                        ffprobe=FFPROBE or "ffprobe", segment_seconds=60)
    store = Store(settings.data_dir)
    camera = store.save_camera({"name": "Fixture camera", "url": "rtsp://127.0.0.1/fixture", "preview_url": "",
                                "enabled": False, "audio_mode": "none", "retention_days": 7}, "camera-1")
    media = MediaManager(settings, store)
    counter = 0

    def recording(*, camera_id="camera-1", indexed=True, name=None, content=b"fixture video"):
        nonlocal counter
        counter += 1
        directory = settings.recordings_dir / camera_id
        directory.mkdir(exist_ok=True)
        path = directory / (name or f"1700000000000-{counter:06d}.mkv")
        path.write_bytes(content)
        row = None
        if indexed:
            identity = store.add_recording(camera_id, path.relative_to(settings.recordings_dir).as_posix(),
                                           1700000000, 60, len(content), "h264")
            row = store.get_recording(identity)
        return row, path

    yield media, store, camera, recording
    await media.stop()


async def eventually(predicate, timeout=2):
    async def wait():
        while not predicate():
            await asyncio.sleep(.01)
    await asyncio.wait_for(wait(), timeout)


@pytest.mark.asyncio
async def test_clear_removes_owned_index_orphans_partials_manifests_and_derived_cache_only(archive):
    media, store, camera, recording = archive
    _, indexed = recording()
    _, orphan = recording(camera_id="deleted-camera", indexed=False)
    _, partial = recording(indexed=False, content=b"")
    manifest = indexed.parent / "1700000000000.csv"
    manifest.write_bytes(b"fixture manifest")
    cached = [media.cache_dir / ("a" * 64 + ".mp4"), media.cache_dir / ("b" * 64 + ".part.json")]
    for path in cached:
        path.write_bytes(b"generated artifact")
    foreign = [indexed.parent / "notes.txt", media.recordings_dir / "disk-owner.txt", media.cache_dir / "credentials.key"]
    for path in foreign:
        path.write_bytes(b"preserve foreign data")
    store.meta_set("recording.segment_seconds", "1800")
    store.meta_set("installed-language-fixture", "preserve settings")
    key = (media.settings.data_dir / "credentials.key").read_bytes()
    owned = [indexed, orphan, partial, manifest, *cached]
    size = sum(path.stat().st_size for path in owned)
    assert media.archive_status() == {"recordings_count": 1, "recordings_bytes": indexed.stat().st_size, "clearing": False}
    result = await media.clear_archive()
    assert result == {"deleted_files": 6, "deleted_recordings": 1, "deleted_bytes": size, "skipped_files": 3}
    assert not any(path.exists() for path in owned)
    assert all(path.read_bytes() == b"preserve foreign data" for path in foreign)
    assert media.archive_status() == {"recordings_count": 0, "recordings_bytes": 0, "clearing": False}
    assert store.get_camera(camera["id"]) == camera
    assert store.meta_get("recording.segment_seconds") == "1800"
    assert store.meta_get("installed-language-fixture") == "preserve settings"
    assert (media.settings.data_dir / "credentials.key").read_bytes() == key
    await media._recover()
    assert store.list_recordings() == []


@pytest.mark.asyncio
async def test_missing_owned_index_rows_are_cleared_but_external_and_foreign_rows_are_preserved(archive):
    media, store, _, recording = archive
    missing, path = recording(); path.unlink()
    foreign, foreign_path = recording(name="foreign.mkv")
    external = media.settings.data_dir / "external.mkv"
    external.write_bytes(b"do not delete")
    outside_id = store.add_recording("camera-1", str(external), 1700000000, 60, 13, "h264")
    result = await media.clear_archive()
    assert result["deleted_recordings"] == 1 and result["skipped_files"] == 2
    assert store.get_recording(missing["id"]) is None
    assert store.get_recording(foreign["id"]) is not None and store.get_recording(outside_id) is not None
    assert foreign_path.exists() and external.read_bytes() == b"do not delete"


@pytest.mark.asyncio
@pytest.mark.parametrize("busy", ["source", "job", "cache_lease", "reservation"])
async def test_busy_archive_is_rejected_before_stopping_workers_or_deleting(archive, monkeypatch, busy):
    media, _, _, recording = archive
    _, path = recording()
    pause = AsyncMock()
    monkeypatch.setattr(media, "_pause_archive_recorders", pause)
    task = None
    if busy == "source":
        media._in_use[path.resolve()] = 1
    elif busy == "job":
        task = asyncio.create_task(asyncio.sleep(60))
        media._jobs["fixture"] = task
    elif busy == "cache_lease":
        media._cache_leases[media.cache_dir / "fixture.mp4"] = 1
    else:
        media._cache_reservations[media.cache_dir / "fixture.part.mp4"] = 100
    with pytest.raises(ArchiveClearError) as error:
        await media.clear_archive()
    assert error.value.status_code == 409 and path.exists()
    pause.assert_not_awaited()
    assert not media.archive_status()["clearing"]
    if task is not None:
        assert not task.done()


@pytest.mark.asyncio
async def test_during_clear_status_stays_readable_and_new_jobs_leases_recovery_are_blocked(archive, monkeypatch):
    media, store, _, recording = archive
    row, path = recording()
    entered, release = asyncio.Event(), asyncio.Event()
    original = media._clear_files

    async def wait(*args):
        entered.set()
        await release.wait()
        await original(*args)

    monkeypatch.setattr(media, "_clear_files", wait)
    clearing = asyncio.create_task(media.clear_archive())
    await entered.wait()
    assert media.archive_status() == {"recordings_count": 1, "recordings_bytes": path.stat().st_size, "clearing": True}
    with pytest.raises(ArchiveClearError, match="in progress"):
        async with media.source_lease(row):
            pytest.fail("A lease was opened during clear")
    factory = AsyncMock()
    with pytest.raises(ArchiveClearError, match="in progress"):
        await media._cached_job(media.cache_dir / ("a" * 64 + ".json"), factory, source=path)
    factory.assert_not_called()
    with pytest.raises(ArchiveClearError, match="in progress"):
        await media.clear_archive()
    await media._recover()
    await media._retention()
    await media.reconcile()
    assert path.exists() and not media.workers
    release.set()
    await clearing
    assert store.list_recordings() == [] and not media._in_use


@pytest.mark.asyncio
@pytest.mark.parametrize("unsafe", ["filesystem_root", "data_directory", "data_parent", "cache_root"])
async def test_unsafe_root_is_rejected_before_any_delete(archive, monkeypatch, unsafe):
    media, _, _, recording = archive
    _, path = recording()
    if unsafe == "filesystem_root":
        media.recordings_dir = Path(path.anchor)
        media.settings.recordings_dir = media.recordings_dir
    elif unsafe == "data_directory":
        media.recordings_dir = media.settings.data_dir
        media.settings.recordings_dir = media.recordings_dir
    elif unsafe == "data_parent":
        media.settings.data_dir = media.recordings_dir / "private-config"
    else:
        media.cache_dir = Path(path.anchor)
        media.settings.cache_dir = media.cache_dir
    pause = AsyncMock()
    monkeypatch.setattr(media, "_pause_archive_recorders", pause)
    with pytest.raises(ArchiveClearError) as error:
        await media.clear_archive()
    assert error.value.status_code == 409 and path.exists()
    pause.assert_not_awaited()


@pytest.mark.asyncio
async def test_hardlinked_original_is_preserved_and_reported_once(archive):
    media, store, _, recording = archive
    row, path = recording()
    outside = media.settings.data_dir / "shared-inode"
    try:
        os.link(path, outside)
    except OSError:
        pytest.skip("Creating hardlinks is unavailable on this platform")
    result = await media.clear_archive()
    assert result["deleted_files"] == 0 and result["skipped_files"] == 1
    assert path.exists() and outside.exists() and store.get_recording(row["id"]) is not None


@pytest.mark.asyncio
async def test_original_and_cache_symlinks_never_delete_their_targets(archive):
    media, store, _, recording = archive
    row, path = recording()
    target = media.settings.data_dir / "private-file"
    target.write_bytes(b"private")
    path.unlink()
    cache_link = media.cache_dir / ("d" * 64 + ".json")
    try:
        path.symlink_to(target)
        cache_link.symlink_to(target)
    except OSError:
        pytest.skip("Creating symlinks is unavailable on this platform")
    result = await media.clear_archive()
    assert result["deleted_files"] == 0 and result["skipped_files"] == 2
    assert path.is_symlink() and cache_link.is_symlink() and target.read_bytes() == b"private"
    assert store.get_recording(row["id"]) is not None


@pytest.mark.asyncio
async def test_unlink_failure_keeps_matching_index_and_reports_partial_result(archive, monkeypatch):
    media, store, _, recording = archive
    blocked, first = recording()
    removed, second = recording()
    unlink = Path.unlink

    def fail(path, *args, **kwargs):
        if path == first:
            raise PermissionError("fixture-only failure")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail)
    result = await media.clear_archive()
    assert result["deleted_files"] == result["deleted_recordings"] == result["skipped_files"] == 1
    assert first.exists() and store.get_recording(blocked["id"]) is not None
    assert not second.exists() and store.get_recording(removed["id"]) is None
    assert not media.archive_status()["clearing"]


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_error_or_cancel_after_pause_always_resumes_recorders_without_touching_live(archive, monkeypatch, cancel):
    media, store, camera, recording = archive
    _, original = recording()
    camera = store.save_camera({**camera, "enabled": True}, camera["id"])
    running, finalized = [], []

    async def recorder(worker):
        running.append(worker)
        try:
            await asyncio.Future()
        finally:
            finalized.append(worker)

    monkeypatch.setattr(media, "_record", recorder)
    live = asyncio.create_task(asyncio.sleep(60))
    hub = _LiveHub(dict(camera), task=live)
    media._hubs[camera["id"]] = hub
    await media.reconcile()
    await eventually(lambda: len(running) == 1)
    old = media.workers[camera["id"]]
    entered = asyncio.Event()

    async def fail(*args):
        entered.set()
        if cancel:
            await asyncio.Future()
        raise OSError("fixture-only failure")

    monkeypatch.setattr(media, "_clear_files", fail)
    clearing = asyncio.create_task(media.clear_archive())
    await entered.wait()
    assert old.task.done() and finalized == [old]
    if cancel:
        clearing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await clearing
    else:
        with pytest.raises(ArchiveClearError) as error:
            await clearing
        assert error.value.status_code == 503
    await eventually(lambda: len(running) == 2)
    assert media.workers[camera["id"]] is not old and not media._clearing
    assert original.exists() and not live.done() and media._hubs[camera["id"]] is hub


@pytest.mark.asyncio
async def test_recorder_spawn_finishes_then_is_closed_before_any_archive_removal(archive, monkeypatch):
    media, store, camera, recording = archive
    _, path = recording()
    camera = store.save_camera({**camera, "enabled": True}, camera["id"])
    entered, release = asyncio.Event(), asyncio.Event()
    processes, stopped = [], []

    async def spawn(*args):
        if not processes:
            entered.set()
            await release.wait()
        process = SimpleNamespace(returncode=None, stdin=None)
        event = asyncio.Event()
        async def wait():
            await event.wait()
            return process.returncode
        process.wait, process.done = wait, event
        processes.append(process)
        return process

    async def stop(process):
        if process is not None:
            process.returncode = 0
            process.done.set()
            stopped.append(process)

    monkeypatch.setattr(media, "_spawn", spawn)
    monkeypatch.setattr(module, "_stop_process", stop)
    monkeypatch.setattr(media, "_probe_file", AsyncMock(return_value={"duration": 1, "video_codec": "h264", "audio_codec": None}))
    await media.reconcile()
    await entered.wait()
    clearing = asyncio.create_task(media.clear_archive())
    await asyncio.sleep(0)
    assert path.exists()
    release.set()
    await clearing
    assert processes[0] in stopped and processes[0].returncode == 0 and not path.exists()
    assert not media._clearing


@pytest.mark.asyncio
@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")
async def test_real_ffmpeg_finalizes_temporary_segment_clears_it_and_resumes(archive, tmp_path, monkeypatch):
    media, store, camera, _ = archive
    fixture = tmp_path / "source-fixture.mkv"
    generated = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                                "testsrc2=size=320x240:rate=10", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast",
                                "-g", "10", "-pix_fmt", "yuv420p", str(fixture)], capture_output=True, timeout=20)
    assert generated.returncode == 0
    monkeypatch.setattr(module, "_input_args", lambda url: ["-re", "-stream_loop", "-1", "-i", str(fixture)])
    store.save_camera({**camera, "enabled": True}, camera["id"])
    await media.reconcile()
    worker = media.workers[camera["id"]]
    await eventually(lambda: worker.state == "recording", timeout=10)
    process = worker.process
    assert process is not None and process.returncode is None
    result = await asyncio.wait_for(media.clear_archive(), 15)
    assert process.returncode is not None and result["deleted_files"] >= 1
    assert result["deleted_recordings"] >= 1 and result["skipped_files"] == 0
    assert fixture.is_file() and store.get_camera(camera["id"])["enabled"] is True
    replacement = media.workers[camera["id"]]
    await eventually(lambda: replacement.state == "recording", timeout=10)
    assert replacement is not worker and replacement.process is not process
