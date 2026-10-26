"""Archive overwrite uses physical free bytes and only completed owned files."""
import asyncio
from collections import namedtuple
import os
from pathlib import Path
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from nvr import media as module
from nvr.media import MediaError, MediaManager, _Worker
from nvr.store import Store


Usage = namedtuple("Usage", "total used free")


class Disk:
    def __init__(self, free=500, total=10000):
        self.free, self.total, self.calls = free, total, 0

    def __call__(self, path):
        self.calls += 1
        return Usage(self.total, self.total - self.free, self.free)


@pytest.fixture
def archive(tmp_path, monkeypatch):
    data, recordings, cache = [tmp_path / name for name in ["data", "recordings", "cache"]]
    for directory in [data, recordings, cache]:
        directory.mkdir()
    settings = SimpleNamespace(data_dir=data, recordings_dir=recordings, cache_dir=cache,
                               ffmpeg="ffmpeg", ffprobe="ffprobe", segment_seconds=60,
                               min_free_bytes=999999999999)
    store = Store(data)
    media = MediaManager(settings, store)
    disk = Disk()
    monkeypatch.setattr(module.shutil, "disk_usage", disk)

    def camera(identity="camera-1", days=7):
        return store.save_camera({"name": identity, "url": "rtsp://127.0.0.1/test", "preview_url": "",
                                  "enabled": False, "audio_mode": "copy", "retention_days": days}, identity)

    camera()
    sequence = 0

    def recording(age=3600, camera_id="camera-1", name=None, size=1000):
        nonlocal sequence
        sequence += 1
        started = time.time() - age
        directory = recordings / camera_id
        directory.mkdir(exist_ok=True)
        path = directory / (name or f"{int(started * 1000)}-{sequence:06d}.mkv")
        path.write_bytes(b"x" * size)
        identity = store.add_recording(camera_id, path.relative_to(recordings).as_posix(), started, 60, size, "h264")
        return store.get_recording(identity), path

    return media, store, disk, camera, recording


def release_on_unlink(monkeypatch, disk, gains):
    original, deleted = Path.unlink, []

    def unlink(path, *args, **kwargs):
        original(path, *args, **kwargs)
        if path in gains:
            deleted.append(path)
            disk.free += gains[path]

    monkeypatch.setattr(Path, "unlink", unlink)
    return deleted


@pytest.mark.asyncio
@pytest.mark.parametrize("free", [1000, 999, 500])
async def test_warning_and_exact_five_percent_never_start_overwrite(archive, free):
    media, _, disk, _, recording = archive
    _, path = recording()
    disk.free = free
    await media._retention()
    assert path.exists()
    assert media._archive_can_record()  # legacy fixed5GB reserve is deliberately irrelevant


@pytest.mark.asyncio
async def test_oldest_first_uses_actual_freed_bytes_and_stops_at_exact_threshold(archive, monkeypatch):
    media, store, disk, _, recording = archive
    disk.free = 480
    _, oldest = recording(age=5000, size=1000)
    _, second = recording(age=4000, size=1000)
    _, newest = recording(age=3000, size=1000)
    deleted = release_on_unlink(monkeypatch, disk, {oldest: 10, second: 10, newest: 10})
    await media._retention()
    assert deleted == [oldest, second] and newest.exists()
    assert disk.free == 500 and media._archive_can_record()
    assert len(store.list_recordings()) == 1


@pytest.mark.asyncio
async def test_expiry_remains_independent_and_shorter_retention_is_not_hidden_by_old_global_page(archive, monkeypatch):
    media, _, disk, camera, recording = archive
    disk.free = 5000
    camera("camera-1", days=365); camera("camera-2", days=1)
    _, long_a = recording(age=30 * 86400)
    _, long_b = recording(age=29 * 86400)
    _, expired = recording(age=2 * 86400, camera_id="camera-2")
    monkeypatch.setattr(module, "RETENTION_PAGE_SIZE", 2)
    await media._retention()
    assert long_a.exists() and long_b.exists() and not expired.exists()


@pytest.mark.asyncio
async def test_protected_original_and_current_open_segment_are_skipped(archive, monkeypatch):
    media, _, disk, _, recording = archive
    _, pinned = recording(age=5000)
    _, opened = recording(age=4000)
    _, eligible = recording(age=3000)
    disk.free = 490
    media._in_use[pinned.resolve()] = 1
    media.workers["camera-1"] = _Worker({"id": "camera-1"}, open_path=opened.resolve())
    deleted = release_on_unlink(monkeypatch, disk, {eligible: 10})
    await media._retention()
    assert deleted == [eligible] and pinned.exists() and opened.exists()


@pytest.mark.asyncio
async def test_pressure_keyset_pages_progress_past_a_wholly_protected_first_page(archive, monkeypatch):
    media, _, disk, _, recording = archive
    _, first = recording(age=5000)
    _, second = recording(age=4000)
    _, third = recording(age=3000)
    media._in_use.update({first.resolve(): 1, second.resolve(): 1})
    monkeypatch.setattr(module, "RETENTION_PAGE_SIZE", 2)
    disk.free = 490
    deleted = release_on_unlink(monkeypatch, disk, {third: 10})
    await media._retention()
    assert not deleted and media._retention_cursor is not None
    await media._retention()
    assert deleted == [third] and first.exists() and second.exists()


@pytest.mark.asyncio
async def test_released_oldest_source_pin_rewinds_pressure_cursor_before_newer_files(archive, monkeypatch):
    media, _, disk, _, recording = archive
    _, first = recording(age=5000)
    _, second = recording(age=4000)
    _, third = recording(age=3000)
    media._in_use.update({first.resolve(): 1, second.resolve(): 1})
    monkeypatch.setattr(module, "RETENTION_PAGE_SIZE", 2)
    disk.free = 490
    deleted = release_on_unlink(monkeypatch, disk, {first: 10, third: 10})
    await media._retention()
    media._in_use.pop(first.resolve())
    await media._retention()
    assert deleted == [first] and second.exists() and third.exists()
    assert media._retention_cursor is None


@pytest.mark.asyncio
async def test_maintenance_deletion_budget_is_bounded_and_next_pass_continues(archive, monkeypatch):
    media, store, disk, _, recording = archive
    monkeypatch.setattr(module, "RETENTION_DELETE_LIMIT", 2)
    paths = [recording(age=5000 - index * 100)[1] for index in range(5)]
    disk.free = 0
    deleted = release_on_unlink(monkeypatch, disk, {path: 10 for path in paths})
    await media._retention()
    assert deleted == paths[:2] and len(store.list_recordings()) == 3
    await media._retention()
    assert deleted == paths[:4] and len(store.list_recordings()) == 1
    assert not media._archive_can_record()


@pytest.mark.asyncio
async def test_unlink_failure_does_not_remove_index_or_prevent_another_eligible_file(archive, monkeypatch):
    media, store, disk, _, recording = archive
    first, blocked = recording(age=5000)
    _, removable = recording(age=4000)
    disk.free = 490
    original = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == blocked:
            raise PermissionError("file is still in use")
        original(path, *args, **kwargs)
        if path == removable:
            disk.free = 500

    monkeypatch.setattr(Path, "unlink", unlink)
    await media._retention()
    assert blocked.exists() and store.get_recording(first["id"]) is not None
    assert not removable.exists() and media._archive_can_record()


@pytest.mark.asyncio
async def test_unlink_without_physical_space_release_does_not_claim_recording_can_resume(archive):
    media, store, disk, _, recording = archive
    recording(age=5000); recording(age=4000)
    disk.free = 490
    await media._retention()
    assert store.list_recordings() == [] and disk.free == 490
    assert not media._archive_can_record()


@pytest.mark.asyncio
async def test_space_recovered_during_first_yield_prevents_any_pressure_deletion(archive):
    media, _, disk, _, recording = archive
    _, path = recording()
    disk.free = 490
    cleanup = asyncio.create_task(media._retention())
    await asyncio.sleep(0)  # retention has captured its initial low-space status
    disk.free = 500
    await cleanup
    assert path.exists()


@pytest.mark.asyncio
async def test_concurrent_retention_passes_do_not_both_overwrite_after_space_recovers(archive, monkeypatch):
    media, _, disk, _, recording = archive
    _, first = recording(age=5000)
    _, second = recording(age=4000)
    disk.free = 490
    deleted = release_on_unlink(monkeypatch, disk, {first: 10, second: 10})
    await asyncio.gather(media._retention(), media._retention())
    assert deleted == [first] and second.exists()


@pytest.mark.asyncio
async def test_invalid_disk_measurement_never_authorizes_space_overwrite(archive, monkeypatch):
    media, _, _, _, recording = archive
    _, path = recording()
    monkeypatch.setattr(module.shutil, "disk_usage", lambda path: SimpleNamespace(total=0, free=0))
    await media._retention()
    assert path.exists() and not media._archive_can_record()


@pytest.mark.asyncio
async def test_corrupt_expiry_candidates_do_not_kill_cleanup_or_authorize_deletion(archive, monkeypatch):
    media, store, disk, _, recording = archive
    row, expired = recording(age=9 * 86400)
    disk.free = 5000
    malformed = [{**row, "id": f"bad-{index}", "started_at": value}
                 for index, value in enumerate(["bad", None, float("nan"), float("inf")])]
    monkeypatch.setattr(store, "list_recordings", lambda **kwargs: [row, *malformed])
    await media._retention()
    assert not expired.exists() and store.get_recording(row["id"]) is None


@pytest.mark.asyncio
async def test_foreign_nonmatching_cross_camera_and_external_index_paths_survive(archive):
    media, store, disk, camera, recording = archive
    disk.free = 0
    _, foreign = recording(name="foreign.mkv")
    _, credentials = recording(name="credentials.key")
    camera("camera-2")
    wrong, cross_camera = recording(camera_id="camera-2")
    with store.connect() as db:
        db.execute("UPDATE recordings SET camera_id='camera-1' WHERE id=?", (wrong["id"],))
    outside = media.settings.data_dir / "outside.mkv"
    outside.write_bytes(b"private data")
    store.add_recording("camera-1", str(outside), time.time() - 5000, 60, 12, "h264")
    await media._retention()
    assert all(path.exists() for path in [foreign, credentials, cross_camera, outside])
    assert len(store.list_recordings()) == 4


@pytest.mark.asyncio
async def test_symlink_to_foreign_file_is_never_followed_for_deletion(archive):
    media, store, disk, _, recording = archive
    row, link = recording()
    outside = media.settings.data_dir / "private-file"
    outside.write_bytes(b"must survive")
    link.unlink()
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Creating symlinks is unavailable on this platform")
    disk.free = 0
    await media._retention()
    assert link.is_symlink() and outside.read_bytes() == b"must survive"
    assert store.get_recording(row["id"]) is not None


@pytest.mark.asyncio
async def test_shared_hardlinked_file_is_protected(archive):
    media, store, disk, _, recording = archive
    row, path = recording()
    outside = media.settings.data_dir / "shared-original"
    try:
        os.link(path, outside)
    except OSError:
        pytest.skip("Creating hardlinks is unavailable on this platform")
    disk.free = 0
    await media._retention()
    assert path.exists() and outside.exists() and store.get_recording(row["id"]) is not None


@pytest.mark.asyncio
async def test_source_and_cached_playback_leases_protect_until_last_response_closes(archive):
    media, _, disk, _, recording = archive
    row, path = recording(age=9 * 86400)
    destination = media._cache_path(row, "copy-v1", "mp4")
    destination.write_bytes(b"cached mp4")
    disk.free = 5000
    async with media.source_lease(row), media.playback_lease(row) as cached:
        assert cached == destination and media._in_use[path.resolve()] == 2
        assert media._cache_leases[destination] == 1
        await media._retention()
        assert path.exists()
    assert not media._in_use and not media._cache_leases
    await media._retention()
    assert not path.exists()


@pytest.mark.asyncio
async def test_job_source_is_pinned_before_scheduling_and_released_if_cancelled_before_start(archive, monkeypatch):
    media, _, _, _, recording = archive
    _, path = recording()
    destination = media.cache_dir / ("e" * 64 + ".json")
    create_task = asyncio.create_task
    started = False

    async def factory():
        nonlocal started
        started = True
        return destination

    def cancel_immediately(coroutine, *args, **kwargs):
        assert media._in_use[path.resolve()] == 1
        task = create_task(coroutine, *args, **kwargs)
        task.cancel()
        return task

    monkeypatch.setattr(module.asyncio, "create_task", cancel_immediately)
    with pytest.raises(asyncio.CancelledError):
        await media._cached_job(destination, factory, source=path.resolve(), background=True)
    assert not started and not media._in_use and not media._jobs


def test_cache_same_archive_uses_five_percent_and_separate_filesystem_keeps_its_own_floor(archive, monkeypatch):
    media, _, disk, _, _ = archive
    disk.free = 600
    media._ensure_cache_space(100)  # 5%reserve500, not512MiB or legacy5GB
    with pytest.raises(MediaError, match="Insufficient cache storage"):
        media._ensure_cache_space(101)
    original = Path.stat

    def different_device(path, *args, **kwargs):
        if path == media.cache_dir:
            return SimpleNamespace(st_dev=-100)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", different_device)
    with pytest.raises(MediaError, match="Insufficient cache storage"):
        media._ensure_cache_space()


@pytest.mark.asyncio
async def test_recorder_waits_when_no_closed_files_can_free_space_and_resumes_at_five_percent(archive, monkeypatch):
    media, _, disk, _, _ = archive
    camera = {"id": "camera-1", "url": "rtsp://127.0.0.1/test", "audio_mode": "none"}
    worker, pauses, spawned = _Worker(camera), [], []
    disk.free = 490

    async def sleep(seconds):
        assert seconds == 10 and not pauses
        pauses.append(worker.state)
        disk.free = 500

    async def spawn(*args):
        spawned.append(args)
        media._stopping = True
        return SimpleNamespace(returncode=0, stdin=None)

    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    monkeypatch.setattr(media, "_spawn", spawn)
    await media._record(worker)
    assert pauses == ["storage_full"] and len(spawned) == 1
    assert worker.open_path is None and worker.process is None


@pytest.mark.asyncio
async def test_running_recorder_stops_when_critical_space_cannot_be_recovered(archive, monkeypatch):
    media, _, disk, _, _ = archive
    worker = _Worker({"id": "camera-1", "url": "rtsp://127.0.0.1/test", "audio_mode": "none"})
    process = SimpleNamespace(returncode=None, stdin=None)

    async def spawn(*args):
        disk.free = 490
        return process

    async def stop(current):
        if current is process:
            process.returncode = 0

    sleep = asyncio.sleep

    async def wait(seconds):
        if seconds == 0:
            await sleep(0)
        else:
            worker.stopping = True

    monkeypatch.setattr(media, "_spawn", spawn)
    monkeypatch.setattr(media, "_import_manifest", AsyncMock())
    monkeypatch.setattr(module, "_stop_process", stop)
    monkeypatch.setattr(module.asyncio, "sleep", wait)
    await media._record(worker)
    assert process.returncode == 0 and worker.state == "storage_full"
    assert worker.open_path is None and worker.process is None
