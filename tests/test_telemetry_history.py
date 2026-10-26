"""Persistent numeric samples use temporary databases and fake local collectors."""
import asyncio
import json
from pathlib import Path
import sqlite3
import threading
import time

import pytest

from nvr.telemetry_history import MAX_POINTS, RETENTION_SECONDS, TelemetryHistory


class Clock:
    value = 1700000000.0

    def now(self):
        return self.value


class Collector:
    def __init__(self, clock):
        self.clock, self.calls = clock, 0
        self.cpu, self.memory, self.swap, self.temperature = None, 45.5, 0, 52.2
        self.scope, self.temperature_scope = "container", "host"

    def snapshot(self):
        self.calls += 1
        return {"sampled_at": self.clock.now(), "scope": self.scope,
                "cpu": {"percent": self.cpu, "temperature_celsius": self.temperature,
                        "temperature_scope": self.temperature_scope, "source": "private-source"},
                "memory": {"percent": self.memory}, "swap": {"percent": self.swap},
                "identity": {"hostname": "private-hostname", "addresses": ["private-address"]},
                "credentials": "private-password-must-never-be-stored"}


@pytest.fixture
def history(tmp_path):
    clock = Clock()
    collector = Collector(clock)
    return TelemetryHistory(tmp_path, collector, wall_time=clock.now), collector, clock


async def eventually(predicate, timeout=2):
    async def wait():
        while not predicate():
            await asyncio.sleep(.005)
    await asyncio.wait_for(wait(), timeout)


@pytest.mark.asyncio
async def test_warming_up_null_and_genuine_zeroes_persist_across_new_instance(history):
    storage, collector, clock = history
    assert await storage.sample_once()
    clock.value += 30
    collector.cpu = 0
    assert await storage.sample_once()
    await storage.stop()
    reloaded = TelemetryHistory(storage.data_dir, collector, wall_time=clock.now)
    result = reloaded.read()
    assert result["available"] is True and result["reason"] is None
    assert result["interval_seconds"] == 30 and result["retention_seconds"] == RETENTION_SECONDS
    assert [point["cpu_percent"] for point in result["points"]] == [None, 0]
    assert result["points"][-1]["swap_percent"] == 0
    assert result["scope"] == "container" and result["temperature_scope"] == "host"
    assert result["scopes"] == ["container"] and result["temperature_scopes"] == ["host"]
    assert result["stale"] is False and result["last_sampled_at"] == clock.value


@pytest.mark.asyncio
async def test_large_sampling_gaps_are_not_filled_with_zeros_and_old_samples_are_stale(history):
    storage, collector, clock = history
    collector.cpu = 33
    await storage.sample_once()
    clock.value += 600
    collector.cpu = None
    await storage.sample_once()
    result = storage.read()
    assert len(result["points"]) == 2
    assert result["points"][1]["sampled_at"] - result["points"][0]["sampled_at"] == 600
    assert result["points"][1]["cpu_percent"] is None
    clock.value += 66
    assert storage.read()["stale"] is True


@pytest.mark.asyncio
async def test_only_required_numeric_values_and_whitelisted_scopes_are_ever_stored(history):
    storage, _, _ = history
    await storage.sample_once()
    with sqlite3.connect(storage.path) as database:
        columns = [row[1] for row in database.execute("PRAGMA table_info(samples)")]
        assert columns == ["sampled_at", "cpu_percent", "memory_percent", "swap_percent", "temperature_celsius",
                           "scope", "temperature_scope"]
        assert database.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    for path in storage.data_dir.glob("system-history.sqlite3*"):
        content = path.read_bytes()
        assert b"private-hostname" not in content and b"private-address" not in content
        assert b"private-password" not in content and b"private-source" not in content


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["55", True, float("nan"), float("inf"), -1, 101])
async def test_invalid_percentages_are_null_instead_of_invented_zero_or_nonfinite(history, bad):
    storage, collector, _ = history
    collector.cpu = collector.memory = collector.swap = bad
    collector.scope, collector.temperature_scope = "private-hostname", "private-temperature-source"
    assert await storage.sample_once()
    point = storage.read()["points"][0]
    assert point["cpu_percent"] is point["memory_percent"] is point["swap_percent"] is None
    assert storage.read()["scope"] == "unknown" and storage.read()["temperature_scope"] is None
    assert "private-hostname" not in json.dumps(storage.read())


@pytest.mark.asyncio
async def test_seven_day_pruning_is_inclusive_at_boundary_and_never_touches_other_data(history):
    storage, _, clock = history
    unrelated = [storage.data_dir / name for name in ["nvr.sqlite3", "credentials.key", "original-recording.mkv"]]
    for path in unrelated:
        path.write_bytes(b"must survive history pruning")
    await storage.sample_once()
    initial = clock.value
    clock.value += RETENTION_SECONDS
    await storage.sample_once()
    assert [point["sampled_at"] for point in storage.read(168)["points"]] == [initial, clock.value]
    clock.value += 1
    await storage.sample_once()
    assert len(storage.read(168)["points"]) == 2
    with sqlite3.connect(storage.path) as database:
        assert database.execute("SELECT MIN(sampled_at) FROM samples").fetchone()[0] == initial + RETENTION_SECONDS
    assert all(path.read_bytes() == b"must survive history pruning" for path in unrelated)


@pytest.mark.asyncio
async def test_reads_and_storage_have_bounded_point_counts_without_downsampling_peaks(history):
    storage, collector, clock = history
    await storage.sample_once()
    with sqlite3.connect(storage.path) as database:
        database.executemany("INSERT INTO samples VALUES (?,?,?,?,?,?,?)",
            [(clock.value - index * .01, 100 if index == 2 else 1, 40, 0, None, "container", None)
             for index in range(1, MAX_POINTS + 8)])
    assert len(storage.read(168)["points"]) == MAX_POINTS
    assert max(point["cpu_percent"] or 0 for point in storage.read(168)["points"]) == 100
    clock.value += 30
    collector.cpu = 12
    await storage.sample_once()
    with sqlite3.connect(storage.path) as database:
        assert database.execute("SELECT COUNT(*) FROM samples").fetchone()[0] == MAX_POINTS
    result = storage.read(168)
    assert len(result["points"]) == MAX_POINTS and result["points"][-1]["cpu_percent"] == 12


@pytest.mark.asyncio
async def test_supported_windows_filter_by_real_time_and_preserve_scope_changes(history):
    storage, collector, clock = history
    await storage.sample_once()
    clock.value += 7200
    collector.scope, collector.temperature_scope = "machine", "machine"
    await storage.sample_once()
    assert len(storage.read(1)["points"]) == 1 and len(storage.read(6)["points"]) == 2
    assert storage.read(24)["window_seconds"] == 86400 and storage.read(168)["window_seconds"] == RETENTION_SECONDS
    result = storage.read(6)
    assert result["scopes"] == ["container", "machine"]
    assert result["temperature_scopes"] == ["host", "machine"]
    assert result["scope"] == result["temperature_scope"] == "machine"


@pytest.mark.parametrize("hours", [0, 2, 7, True, "6", 6.0, None])
def test_unsupported_history_windows_fail_before_any_database_io(history, hours):
    storage, _, _ = history
    with pytest.raises(ValueError):
        storage.read(hours)
    assert not storage.path.exists()


def test_missing_or_foreign_database_stays_unavailable_and_is_never_adopted(history):
    storage, _, _ = history
    empty = storage.read()
    assert empty["available"] is False and empty["reason"] == "unavailable" and empty["points"] == []
    with sqlite3.connect(storage.path) as database:
        database.execute("CREATE TABLE private_data(value TEXT)")
        database.execute("INSERT INTO private_data VALUES ('must survive')")
    assert storage._sample_worker(storage._token) is False
    with sqlite3.connect(storage.path) as database:
        assert database.execute("SELECT value FROM private_data").fetchone()[0] == "must survive"
        assert not database.execute("SELECT 1 FROM sqlite_master WHERE name='samples'").fetchone()
    assert storage.read()["available"] is False


@pytest.mark.asyncio
async def test_collector_and_disk_errors_are_sanitized_and_recover_on_next_sample(history, monkeypatch):
    storage, collector, clock = history
    original = collector.snapshot
    collector.snapshot = lambda: (_ for _ in ()).throw(RuntimeError("private-password /sensitive/path"))
    assert not await storage.sample_once()
    failed = storage.read()
    assert failed["sampling_available"] is False and "private-password" not in json.dumps(failed)
    collector.snapshot = original
    assert await storage.sample_once()
    original_connect = storage._connect
    monkeypatch.setattr(storage, "_connect", lambda **kwargs: (_ for _ in ()).throw(PermissionError("private-path")))
    clock.value += 30
    assert not await storage.sample_once()
    assert storage.read()["reason"] == "unavailable"
    monkeypatch.setattr(storage, "_connect", original_connect)
    assert await storage.sample_once()
    assert storage.read()["available"] and storage.read()["sampling_available"]


@pytest.mark.asyncio
async def test_locked_writer_is_bounded_and_existing_wal_history_remains_readable(history):
    storage, _, clock = history
    await storage.sample_once()
    with sqlite3.connect(storage.path) as other:
        other.execute("BEGIN IMMEDIATE")
        clock.value += 30
        started = time.monotonic()
        assert not await storage.sample_once()
        assert time.monotonic() - started < 1.5
        result = storage.read()
        assert result["available"] and result["sampling_available"] is False and len(result["points"]) == 1


@pytest.mark.asyncio
async def test_sampler_starts_without_authentication_and_start_stop_are_idempotent(tmp_path):
    class LocalCollector:
        calls = 0
        def snapshot(self):
            self.calls += 1
            return {"sampled_at": time.time(), "scope": "machine", "cpu": {"percent": None},
                    "memory": {"percent": 20}, "swap": {"percent": 0}}
    collector = LocalCollector()
    storage = TelemetryHistory(tmp_path, collector, interval_seconds=.05)
    await storage.start()
    task = storage._task
    await storage.start()
    assert storage._task is task
    await eventually(lambda: len(storage.read()["points"]) >= 2)
    await storage.stop()
    calls = collector.calls
    await storage.stop()
    await asyncio.sleep(.08)
    assert collector.calls == calls and storage._worker is None
    assert len(storage.read()["points"]) >= 2
    await storage.start()
    await eventually(lambda: collector.calls > calls)
    await storage.stop()


@pytest.mark.asyncio
async def test_stop_waits_for_one_inflight_worker_and_prevents_post_stop_write(history):
    storage, collector, clock = history
    await storage.sample_once()
    entered, release = threading.Event(), threading.Event()
    original = collector.snapshot
    def blocked():
        entered.set()
        assert release.wait(2)
        return original()
    collector.snapshot = blocked
    clock.value += 30
    await storage.start()
    await eventually(entered.is_set)
    stopping = asyncio.create_task(storage.stop())
    await asyncio.sleep(.02)
    assert not stopping.done()
    release.set()
    await asyncio.wait_for(stopping, 1)
    assert len(storage.read()["points"]) == 1
    assert storage._worker is None and storage._task is None


@pytest.mark.asyncio
async def test_cancelling_manual_sample_never_releases_its_worker_slot_early(history):
    storage, collector, _ = history
    entered, release = threading.Event(), threading.Event()
    original = collector.snapshot
    def blocked():
        entered.set()
        assert release.wait(2)
        return original()
    collector.snapshot = blocked
    request = asyncio.create_task(storage.sample_once())
    await eventually(entered.is_set)
    request.cancel()
    await asyncio.sleep(.01)
    assert not request.done() and not await storage.sample_once()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert collector.calls == 1 and storage._worker is None
    await storage.stop()


@pytest.mark.asyncio
async def test_slow_samples_never_overlap_or_burst_to_fill_missed_intervals(tmp_path):
    class SlowCollector:
        calls, active, maximum = [], 0, 0
        def snapshot(self):
            self.active += 1
            self.maximum = max(self.maximum, self.active)
            started = time.monotonic()
            self.calls.append(started)
            time.sleep(.07)
            self.active -= 1
            return {"sampled_at": time.time(), "scope": "machine", "cpu": {"percent": 2}}
    collector = SlowCollector()
    storage = TelemetryHistory(tmp_path, collector, interval_seconds=.03)
    await storage.start()
    await eventually(lambda: len(collector.calls) >= 3)
    await storage.stop()
    assert collector.maximum == 1
    assert all(second - first >= .09 for first, second in zip(collector.calls, collector.calls[1:]))
