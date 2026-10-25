"""Archive estimates read numeric index rows only, never stream credentials."""
from contextlib import contextmanager
import sqlite3
from types import SimpleNamespace

import pytest

from nvr.system_status import RecordingCapacity, SAMPLE_WINDOW_SECONDS


class Clock:
    value = 100.0
    timestamp = 1700000000.0

    def now(self):
        return self.value

    def wall(self):
        return self.timestamp

    def advance(self, seconds):
        self.value += seconds
        self.timestamp += seconds


class ReadOnlyStore:
    def __init__(self, path):
        self.path, self.queries = path, []
        with sqlite3.connect(path) as db:
            db.executescript("""CREATE TABLE cameras(id TEXT PRIMARY KEY, enabled INTEGER, retention_days INTEGER, url TEXT);
                CREATE TABLE recordings(camera_id TEXT, size INTEGER, duration REAL, started_at REAL);
                CREATE INDEX recordings_time ON recordings(camera_id,started_at);""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        db.set_trace_callback(self.queries.append)
        try:
            yield db
        finally:
            db.close()

    def write(self, query, values=()):
        with sqlite3.connect(self.path) as db:
            db.execute(query, values)

    def list_cameras(self):
        raise AssertionError("Capacity must not decrypt camera credentials")


@pytest.fixture
def capacity(tmp_path):
    clock, states = Clock(), {}
    store = ReadOnlyStore(tmp_path / "index.sqlite3")
    settings = SimpleNamespace(min_free_bytes=1000)
    media = SimpleNamespace(camera_status=lambda identity: {"state": states.get(identity, "stopped")})
    collector = RecordingCapacity(settings, store, media, wall_time=clock.wall, monotonic=clock.now)

    def camera(identity, state="recording", enabled=True, retention=7):
        store.write("INSERT INTO cameras VALUES (?,?,?,?)", (identity, enabled, retention, "encrypted-private-source"))
        states[identity] = state

    def recording(identity, size, duration=60, age=60):
        store.write("INSERT INTO recordings VALUES (?,?,?,?)", (identity, size, duration, clock.wall() - age))

    return collector, store, clock, states, camera, recording


def disk(free,total=20000):
    return {"recordings": {"free": free,"total":total}}


def test_weighted_last_three_files_per_active_camera_and_reserve(capacity):
    collector, store, _, _, camera, recording = capacity
    camera("a"); camera("b", retention=0)
    recording("a", 999999999, age=500)  # fourth file must not affect the weighted rate
    recording("a", 6000, 60, 400)
    recording("a", 12000, 120, 300)
    recording("a", 6000, 60, 100)
    recording("b", 12000)
    result = collector.snapshot(disk(400000,total=2000000))
    assert result["active_cameras"] == result["estimated_cameras"] == 2
    assert result["bytes_per_second"] == 300 and result["bytes_per_day"] == 25920000
    assert result["usable_free_bytes"] == 300000 and result["remaining_seconds"] == 1000
    assert result["reason"] is None and result["retention_limited"] is True
    assert result["method"] == "recent_recordings" and result["sample_window_seconds"] == SAMPLE_WINDOW_SECONDS
    assert not any("encrypted-private-source" in query or "url" in query.lower() for query in store.queries)
    assert all(query.lstrip().upper().startswith("SELECT") for query in store.queries)


def test_stopped_disabled_and_deleted_cameras_do_not_consume_estimate(capacity):
    collector, _, _, _, camera, recording = capacity
    camera("active", retention=0); camera("off", "stopped"); camera("disabled", enabled=False)
    for identity in ["active", "off", "disabled", "deleted"]:
        recording(identity, 6000)
    result = collector.snapshot(disk(7000))
    assert result["active_cameras"] == result["estimated_cameras"] == 1
    assert result["bytes_per_second"] == 100 and result["remaining_seconds"] == 60
    assert result["retention_limited"] is False


def test_any_missing_active_rate_prevents_optimistic_partial_eta(capacity):
    collector, _, _, _, camera, recording = capacity
    camera("a"); camera("b")
    recording("a", 6000)
    result = collector.snapshot(disk(7000))
    assert result["active_cameras"] == 2 and result["estimated_cameras"] == 1
    assert result["bytes_per_second"] is None and result["remaining_seconds"] is None
    assert result["reason"] == "insufficient_data" and result["retention_limited"] is False


def test_no_active_recordings_has_no_infinite_or_zero_time_promise(capacity):
    collector, _, _, _, camera, _ = capacity
    camera("a", "connecting")
    result = collector.snapshot(disk(10000))
    assert result["active_cameras"] == result["estimated_cameras"] == 0
    assert result["bytes_per_second"] == 0 and result["remaining_seconds"] is None
    assert result["reason"] == "no_active_recordings"


@pytest.mark.parametrize("free", [None, -1, float("inf"), float("nan"), "9999", True])
def test_missing_or_invalid_disk_keeps_eta_unknown(capacity, free):
    collector, _, _, _, camera, recording = capacity
    camera("a"); recording("a", 6000)
    result = collector.snapshot(disk(free))
    assert result["bytes_per_second"] == 100 and result["usable_free_bytes"] is None
    assert result["remaining_seconds"] is None and result["reason"] == "disk_unavailable"


def test_reserve_reached_is_explicit_zero_and_retention_is_only_a_caveat(capacity):
    collector, _, _, _, camera, recording = capacity
    camera("a"); recording("a", 6000)
    result = collector.snapshot(disk(50))
    assert result["usable_free_bytes"] == result["remaining_seconds"] == 0
    assert result["reason"] == "storage_reserve_reached" and result["retention_limited"] is True


def test_twenty_four_hour_window_accepts_completed_two_hour_file_crossing_boundary(capacity):
    collector, _, _, _, camera, recording = capacity
    camera("a")
    recording("a", 720000, 7200, age=SAMPLE_WINDOW_SECONDS + 7100)
    result = collector.snapshot(disk(11000))
    assert result["bytes_per_second"] == 100 and result["remaining_seconds"] == 100


@pytest.mark.parametrize("size,duration,age", [
    (6000, 60, SAMPLE_WINDOW_SECONDS + 100),
    (6000, 60, -100),
    (0, 60, 60),
    (-10, 60, 60),
    (6000, 0, 60),
    (6000, float("inf"), 60),
    (6000, 8000, 8000),
    (6000, "not-a-duration", 60),
    (6000, 120, 0),  # indexed end implausibly far in the future
])
def test_invalid_or_stale_samples_do_not_fabricate_a_rate(capacity, size, duration, age):
    collector, _, _, _, camera, recording = capacity
    camera("a"); recording("a", size, duration, age)
    result = collector.snapshot(disk(10000))
    assert result["estimated_cameras"] == 0 and result["remaining_seconds"] is None
    assert result["reason"] == "insufficient_data"


def test_rate_cache_has_thirty_second_ttl_but_disk_free_is_always_current(capacity):
    collector, store, clock, _, camera, recording = capacity
    camera("a"); recording("a", 6000)
    assert collector.snapshot(disk(11000))["remaining_seconds"] == 100
    store.write("UPDATE recordings SET size=12000")
    before = sum("FROM recordings" in query for query in store.queries)
    clock.advance(29)
    result = collector.snapshot(disk(6000))
    assert result["bytes_per_second"] == 100 and result["remaining_seconds"] == 50
    assert sum("FROM recordings" in query for query in store.queries) == before
    clock.advance(1)
    assert collector.snapshot(disk(6000))["bytes_per_second"] == 200


def test_active_state_change_invalidates_cache_even_off_then_same_camera_back_on(capacity):
    collector, store, _, states, camera, recording = capacity
    camera("a"); recording("a", 6000)
    assert collector.snapshot(disk(11000))["bytes_per_second"] == 100
    states["a"] = "reconnecting"
    assert collector.snapshot(disk(11000))["reason"] == "no_active_recordings"
    store.write("UPDATE recordings SET size=12000")
    states["a"] = "recording"
    assert collector.snapshot(disk(11000))["bytes_per_second"] == 200


def test_clock_reversal_invalidates_rate_cache(capacity):
    collector, store, clock, _, camera, recording = capacity
    camera("a"); recording("a", 6000, age=120)
    assert collector.snapshot(disk(11000))["bytes_per_second"] == 100
    store.write("UPDATE recordings SET size=12000")
    clock.timestamp -= 5
    assert collector.snapshot(disk(11000))["bytes_per_second"] == 200


def test_more_than_thirty_two_active_cameras_never_underestimates_omitted_rates(capacity):
    collector, store, _, _, camera, recording = capacity
    for index in range(33):
        camera(str(index)); recording(str(index), 6000)
    result = collector.snapshot(disk(10000))
    assert result["active_cameras"] == 33 and result["remaining_seconds"] is None
    assert result["reason"] == "insufficient_data" and result["estimated_cameras"] == 0
    assert not any("FROM recordings" in query for query in store.queries)


def test_bounded_camera_query_reports_unsupported_capacity_instead_of_omitting_cameras(capacity):
    collector, store, _, _, camera, _ = capacity
    for index in range(257):
        camera(str(index))
    result = collector.snapshot(disk(10000))
    assert result["active_cameras"] is None and result["remaining_seconds"] is None
    assert result["reason"] == "unsupported_capacity"
    assert "LIMIT 257" in store.queries[0]


def test_database_or_media_status_failure_leaves_unknown_estimate(capacity):
    collector, store, _, _, camera, _ = capacity
    camera("a")
    collector.media = SimpleNamespace()
    assert collector.snapshot(disk(10000))["remaining_seconds"] is None
    store.write("DROP TABLE recordings")
    collector.media = SimpleNamespace(camera_status=lambda identity: {"state": "recording"})
    result = collector.snapshot(disk(10000))
    assert result["remaining_seconds"] is None and result["reason"] == "insufficient_data"


def test_headroom_uses_five_percent_of_current_filesystem_instead_of_legacy_gigabyte_floor(capacity):
    collector, _, _, _, camera, recording = capacity
    camera("a"); recording("a",6000)
    collector.settings.min_free_bytes=999999999
    first=collector.snapshot(disk(11000,total=20000))
    assert first['reserve_bytes']==1000 and first['remaining_seconds']==100
    resized=collector.snapshot(disk(11000,total=40000))
    assert resized['reserve_bytes']==2000 and resized['remaining_seconds']==90
    missing=collector.snapshot({'recordings':{'free':11000}})
    assert missing['reserve_bytes'] is None and missing['remaining_seconds'] is None
