"""Saved history is private; sampling belongs to the service, not a login."""
import sqlite3
import threading
import time

from fastapi.testclient import TestClient
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.telemetry_history import TelemetryHistory

PASSWORD = "history-api-test-password"
HEADERS = {"X-NVR-Request": "1"}


class QuietMedia:
    def __init__(self, *args): pass
    async def start(self): pass
    async def stop(self): pass


class HistoryStub:
    def __init__(self, data_dir, collector):
        self.calls, self.started, self.stopped = [], False, False
    async def start(self): self.started = True
    async def stop(self): self.stopped = True
    def read(self, hours=6):
        self.calls.append(hours)
        return {"window_seconds": hours * 3600, "interval_seconds": 30, "points": [],
                "sampled_at": 1000, "retention_seconds": 604800, "available": True}


class Collector:
    def __init__(self, *args): self.calls, self.lock = 0, threading.Lock()
    def snapshot(self):
        with self.lock:
            self.calls += 1
            count = self.calls
        return {"sampled_at": time.time(), "scope": "container", "cpu": {"percent": None if count == 1 else 25,
                "temperature_celsius": 45, "temperature_scope": "host"}, "memory": {"percent": 42},
                "swap": {"percent": 3}, "identity": {"hostname": "private-hostname-never-save"}}


def configured(tmp_path):
    return Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=PASSWORD)


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


def wait_for(predicate, timeout=5):
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > end:
            raise AssertionError("Background sampling did not complete")
        time.sleep(.01)


def test_history_endpoint_requires_login_and_never_starts_collection_from_a_read(tmp_path):
    app = create_app(configured(tmp_path), media_factory=QuietMedia, telemetry_factory=Collector, history_factory=HistoryStub)
    with TestClient(app) as client:
        assert app.state.history.started is True
        assert client.get("/api/system/history").status_code == 401
        assert app.state.history.calls == [] and app.state.telemetry.calls == 0
        login(client)
        for hours in (1, 6, 24, 168):
            response = client.get("/api/system/history", params={"hours": hours})
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            assert response.json()["window_seconds"] == hours * 3600
        assert app.state.history.calls == [1, 6, 24, 168] and app.state.telemetry.calls == 0
        client.post("/api/logout", headers=HEADERS)
        assert client.get("/api/system/history").status_code == 401
        assert app.state.history.calls == [1, 6, 24, 168]
    assert app.state.history.stopped is True


@pytest.mark.parametrize("value", [0, 2, 5, 169, -1, "invalid", ""])
def test_history_rejects_unsupported_windows_without_reading_database(tmp_path, value):
    app = create_app(configured(tmp_path), media_factory=QuietMedia, history_factory=HistoryStub)
    with TestClient(app) as client:
        login(client)
        assert client.get("/api/system/history", params={"hours": value}).status_code == 422
        assert app.state.history.calls == []


def test_lifespan_samples_before_login_and_keeps_history_after_restart(tmp_path):
    settings = configured(tmp_path)
    factory = lambda data, collector: TelemetryHistory(data, collector, interval_seconds=.05)
    app = create_app(settings, media_factory=QuietMedia, telemetry_factory=Collector, history_factory=factory)
    with TestClient(app) as client:
        # No login or successful API read has taken place while these are saved.
        wait_for(lambda: len(app.state.history.read()["points"]) >= 2)
        assert client.get("/api/system/history").status_code == 401
        points = app.state.history.read()["points"]
        assert any(point["cpu_percent"] == 25 for point in points)
        assert all(point["memory_percent"] == 42 for point in points)
        saved_at = points[0]["sampled_at"]
        login(client)
        response = client.get("/api/system/history")
        assert response.status_code == 200 and response.json()["window_seconds"] == 21600
        assert response.json()["available"] is True
    path = settings.data_dir / "system-history.sqlite3"
    assert b"private-hostname-never-save" not in path.read_bytes()
    calls = app.state.telemetry.calls
    time.sleep(.1)
    assert app.state.telemetry.calls == calls
    restarted = create_app(settings, media_factory=QuietMedia, telemetry_factory=Collector, history_factory=factory)
    with TestClient(restarted) as client:
        login(client)
        history = client.get("/api/system/history", params={"hours": 24}).json()
        assert any(point["sampled_at"] == saved_at for point in history["points"])
        assert all(set(point) == {"sampled_at", "cpu_percent", "memory_percent", "swap_percent", "temperature_celsius"}
                   for point in history["points"])
