from contextlib import asynccontextmanager
import sqlite3

from fastapi.testclient import TestClient
import pytest

from nvr.app import LeasedFileResponse, create_app
from nvr.config import SEGMENT_MINUTE_CHOICES, Settings
from nvr.media import MediaError
from nvr.preferences import SEGMENT_PREFERENCE_KEY, restore_recording_preferences
from nvr.store import Store


class PreferenceMedia:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.calls = []
        self.fail = False
        self.lease_failure = False
        self.leases = 0
        self.cached = settings.cache_dir / "test.mp4"
        self.cached.write_bytes(b"0123456789")
        self.initial_seconds = settings.segment_seconds

    async def start(self): pass
    async def stop(self): pass

    async def set_segment_seconds(self, seconds):
        self.calls.append(seconds)
        self.settings.segment_seconds = seconds
        if self.fail:
            self.fail = False
            raise RuntimeError("private rollover failure")

    @asynccontextmanager
    async def playback_lease(self, recording, compatible=False):
        self.leases += 1
        try:
            if self.lease_failure:
                raise MediaError("Insufficient cache storage for playback. Free space or configure NVR_CACHE_DIR on a larger disk.")
            yield self.cached
        finally:
            self.leases -= 1


def settings_at(path):
    return Settings(data_dir=path / "data", recordings_dir=path / "recordings",
                    password="settings-test-password", segment_seconds=1800)


def login(client):
    return client.post("/api/login", json={"password": "settings-test-password"}, headers={"X-NVR-Request": "1"})


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(settings_at(tmp_path), media_factory=PreferenceMedia)) as client:
        yield client


def test_preferences_require_authentication_and_csrf(client):
    path = "/api/settings/recording"
    assert client.get(path).status_code == 401
    assert client.put(path, json={"segment_minutes": 120}, headers={"X-NVR-Request": "1"}).status_code == 401
    login(client)
    assert client.put(path, json={"segment_minutes": 120}).status_code == 403
    assert client.put(path, json={"segment_minutes": 120}, headers={"X-NVR-Request": "1", "Origin": "https://example.invalid"}).status_code == 403
    assert client.app.state.media.calls == []


def test_supported_options_save_and_effective_duration(client):
    login(client)
    response = client.get("/api/settings/recording")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data == {"segment_seconds": 1800, "segment_minutes": 30,
                    "allowed_minutes": [1, 2, 3, 4, 5, *range(10, 121, 5)],
                    "recommended_minutes": 30, "scope": "all_cameras"}
    for minutes in (1, 5, 30, 60, 120):
        response = client.put("/api/settings/recording", json={"segment_minutes": minutes}, headers={"X-NVR-Request": "1"})
        assert response.status_code == 200
        assert response.json()["segment_seconds"] == minutes * 60
        assert response.json()["segment_minutes"] == minutes
        assert client.get("/api/system").json()["segment_seconds"] == minutes * 60
        assert client.app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == str(minutes * 60)
    assert client.app.state.media.calls == [60, 300, 1800, 3600, 7200]


@pytest.mark.parametrize("value", [0, 6, 7, 11, 121, "30", 1.5, True, None])
def test_invalid_duration_never_changes_configuration(client, value):
    login(client)
    response = client.put("/api/settings/recording", json={"segment_minutes": value}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 422
    assert client.app.state.media.calls == []
    assert client.app.state.settings.segment_seconds == 1800
    assert client.app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) is None


def test_unchanged_save_is_persisted_without_rollover(client):
    login(client)
    for _ in range(2):
        response = client.put("/api/settings/recording", json={"segment_minutes": 30}, headers={"X-NVR-Request": "1"})
        assert response.status_code == 200 and response.json()["changed"] is False
    assert client.app.state.media.calls == []
    assert client.app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == "1800"


def test_preference_survives_app_restart_and_overrides_environment(tmp_path):
    with TestClient(create_app(settings_at(tmp_path), media_factory=PreferenceMedia)) as client:
        login(client)
        assert client.put("/api/settings/recording", json={"segment_minutes": 120}, headers={"X-NVR-Request": "1"}).status_code == 200
    app = create_app(settings_at(tmp_path), media_factory=PreferenceMedia)
    assert app.state.media.initial_seconds == 7200
    with TestClient(app) as client:
        login(client)
        assert client.get("/api/settings/recording").json()["segment_minutes"] == 120


def test_invalid_saved_value_falls_back_without_destroying_metadata(tmp_path, caplog):
    settings = settings_at(tmp_path)
    store = Store(settings.data_dir)
    for value in ("not-an-integer", "420", "7201"):
        store.meta_set(SEGMENT_PREFERENCE_KEY, value)
        restore_recording_preferences(store, settings)
        assert settings.segment_seconds == 1800
        assert store.meta_get(SEGMENT_PREFERENCE_KEY) == value
    assert "using startup configuration" in caplog.text


@pytest.mark.parametrize("saved", [None, "1800"])
def test_rollover_failure_restores_memory_and_persisted_preference(client, saved):
    login(client)
    if saved is not None:
        client.app.state.store.meta_set(SEGMENT_PREFERENCE_KEY, saved)
    client.app.state.media.fail = True
    response = client.put("/api/settings/recording", json={"segment_minutes": 120}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 503
    assert "private rollover failure" not in response.text
    assert client.app.state.media.calls == [7200, 1800]
    assert client.app.state.settings.segment_seconds == 1800
    assert client.app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == saved


def test_persistence_failure_does_not_apply_requested_duration(client, monkeypatch):
    login(client)
    def fail(*args):
        raise sqlite3.OperationalError("private disk failure")
    monkeypatch.setattr(client.app.state.store, "meta_set", fail)
    response = client.put("/api/settings/recording", json={"segment_minutes": 120}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 503 and "private disk failure" not in response.text
    assert 7200 not in client.app.state.media.calls
    assert client.app.state.settings.segment_seconds == 1800


def add_playback_source(client):
    settings, store = client.app.state.settings, client.app.state.store
    (settings.recordings_dir / "test.mkv").write_bytes(b"recording")
    return store.add_recording("camera", "test.mkv", 100, 7200, 9, "h264")


def test_cached_playback_range_releases_lease_and_cache_errors_are_actionable(client):
    login(client)
    recording_id = add_playback_source(client)
    response = client.get(f"/api/recordings/{recording_id}/playback", headers={"Range": "bytes=2-4"})
    assert response.status_code == 206 and response.content == b"234"
    assert client.app.state.media.leases == 0
    client.app.state.media.lease_failure = True
    response = client.get(f"/api/recordings/{recording_id}/playback")
    assert response.status_code == 503 and "NVR_CACHE_DIR" in response.json()["detail"]
    assert client.app.state.media.leases == 0


@pytest.mark.asyncio
async def test_cached_playback_lease_released_on_disconnected_response(tmp_path):
    target = tmp_path / "cached.mp4"
    target.write_bytes(b"0123456789")
    closed = []
    @asynccontextmanager
    async def cache_lease():
        try:
            yield target
        finally:
            closed.append(True)
    lease = cache_lease()
    path = await lease.__aenter__()
    response = LeasedFileResponse(path, lease=lease, media_type="video/mp4")
    async def receive():
        return {"type": "http.disconnect"}
    async def send(message):
        raise RuntimeError("connection closed")
    with pytest.raises(RuntimeError, match="connection closed"):
        await response({"type": "http", "method": "GET", "headers": [],
                        "asgi": {"version": "3.0", "spec_version": "2.4"}}, receive, send)
    assert closed == [True]
