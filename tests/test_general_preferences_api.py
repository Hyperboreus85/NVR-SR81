"""General preferences are authenticated and serialized with other settings."""
import asyncio
import json
import sqlite3
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from nvr.app import create_app
from nvr.config import Settings
from nvr.general_preferences import GENERAL_PREFERENCE_KEY, GeneralPreferences


PASSWORD = "general-api-test-password"
HEADERS = {"X-NVR-Request": "1"}
ENDPOINT = "/api/settings/general"


class NoLifecycle:
    def __init__(self, *args): pass
    async def start(self): pass
    async def stop(self): pass


class LocalTelemetry:
    def __init__(self, *args): pass
    def snapshot(self): return {"identity": {"hostname": "qa-recorder", "addresses": ["192.0.2.20"]}}


class PausingMedia(NoLifecycle):
    def __init__(self, settings, store):
        self.settings = settings
        self.entered, self.resume, self.stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.calls = []
        self.hold = False

    async def set_segment_seconds(self, seconds):
        self.calls.append(seconds)
        self.entered.set()
        if self.hold:
            await self.resume.wait()
        self.settings.segment_seconds = seconds

    async def stop(self): self.stopped.set()


def payload(**changes):
    return {"recorder_name": "Studio", "timezone": "UTC", "hour_format": "12", "rotation_seconds": 60} | changes


def make_app(tmp_path, *, factory=None):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=PASSWORD)
    if factory is None:
        factory = lambda store, telemetry: GeneralPreferences(store, telemetry, root_dir=tmp_path / "qa-system")
    return create_app(settings, media_factory=PausingMedia, live_factory=NoLifecycle,
                      telemetry_factory=LocalTelemetry, history_factory=NoLifecycle, general_factory=factory)


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


def test_general_read_and_write_require_login_csrf_and_matching_origin(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as client:
        assert client.get(ENDPOINT).status_code == 401
        assert client.put(ENDPOINT, json=payload(), headers=HEADERS).status_code == 401
        login(client)
        assert client.put(ENDPOINT, json=payload()).status_code == 403
        assert client.put(ENDPOINT, json=payload(), headers=HEADERS | {"Origin": "https://other.invalid"}).status_code == 403
        assert app.state.store.meta_get(GENERAL_PREFERENCE_KEY) is None


def test_default_read_has_no_secrets_and_settings_survive_application_restart(tmp_path):
    first = make_app(tmp_path)
    with TestClient(first) as client:
        login(client)
        response = client.get(ENDPOINT)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        data = response.json()
        assert data["recorder_name"] == "qa-recorder" and data["timezone"] == "auto" and data["hour_format"] == "24"
        assert data["rotation_seconds"] == 0 and data["timezones"] == ["UTC"]
        assert data["system"]["hostname"] == "qa-recorder" and data["system"]["addresses"] == ["192.0.2.20"]
        assert not {"password", "credentials", "path", "data_dir"} & data.keys()
        saved = client.put(ENDPOINT, json=payload(), headers=HEADERS)
        assert saved.status_code == 200 and saved.headers["cache-control"] == "no-store"
        assert saved.json()["recorder_name"] == "Studio" and saved.json()["system"]["hostname"] == "qa-recorder"
        assert json.loads(first.state.store.meta_get(GENERAL_PREFERENCE_KEY)) == payload()
        assert first.state.media.calls == []
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        result = client.get(ENDPOINT).json()
        assert {key: result[key] for key in payload()} == payload()


@pytest.mark.parametrize("changes", [
    {"recorder_name": False}, {"recorder_name": "private-name" * 10}, {"recorder_name": "private-name\n"},
    {"timezone": 0}, {"timezone": "private-timezone"}, {"timezone": ""},
    {"hour_format": 24}, {"hour_format": True}, {"hour_format": "private-format"},
    {"rotation_seconds": True}, {"rotation_seconds": "30"}, {"rotation_seconds": 30.0},
    {"rotation_seconds": 10}, {"rotation_seconds": 301}, {"private-field": "private-secret"},
])
def test_strict_validation_never_echoes_inputs_or_mutates_saved_values(tmp_path, changes):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        assert client.put(ENDPOINT, json=payload(), headers=HEADERS).status_code == 200
        previous = client.app.state.store.meta_get(GENERAL_PREFERENCE_KEY)
        response = client.put(ENDPOINT, json=payload() | changes, headers=HEADERS)
        assert response.status_code == 422 and "private" not in response.text
        assert client.app.state.store.meta_get(GENERAL_PREFERENCE_KEY) == previous


@pytest.mark.parametrize("value", [{}, {"recorder_name": "private"}, [], None])
def test_all_four_fields_are_required_without_extra_body_shapes(tmp_path, value):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        response = client.put(ENDPOINT, json=value, headers=HEADERS)
        assert response.status_code == 422 and "private" not in response.text
        assert client.app.state.store.meta_get(GENERAL_PREFERENCE_KEY) is None


def test_general_storage_errors_use_safe_status_and_messages(tmp_path, monkeypatch):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        monkeypatch.setattr(client.app.state.store, "meta_set", lambda *args: (_ for _ in ()).throw(sqlite3.OperationalError("private filesystem path")))
        response = client.put(ENDPOINT, json=payload(), headers=HEADERS)
        assert response.status_code == 503 and response.json() == {"detail": "General settings could not be saved. Try again."}
        monkeypatch.setattr(client.app.state.store, "meta_get", lambda *args: (_ for _ in ()).throw(OSError("private database path")))
        response = client.get(ENDPOINT)
        assert response.status_code == 503 and response.json() == {"detail": "General settings are unavailable. Try again."}


async def async_login(client):
    assert (await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)).status_code == 200


def observe_auth(app, monkeypatch):
    observed = asyncio.Event()
    valid = app.state.auth.valid

    def check(token):
        accepted = valid(token)
        if accepted:
            observed.set()
        return accepted

    monkeypatch.setattr(app.state.auth, "valid", check)
    return observed


@pytest.mark.asyncio
async def test_general_save_waits_for_a_concurrent_recording_mutation(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    media = app.state.media
    media.hold = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await async_login(client)
            first = asyncio.create_task(client.put("/api/settings/recording", json={"segment_minutes": 60}, headers=HEADERS))
            second = None
            try:
                await asyncio.wait_for(media.entered.wait(), 5)
                observed = observe_auth(app, monkeypatch)
                second = asyncio.create_task(client.put(ENDPOINT, json=payload(), headers=HEADERS))
                await asyncio.wait_for(observed.wait(), 5)
                assert not first.done() and not second.done()
                assert app.state.store.meta_get(GENERAL_PREFERENCE_KEY) is None
                media.resume.set()
                responses = await asyncio.wait_for(asyncio.gather(first, second), 5)
                assert [response.status_code for response in responses] == [200, 200]
                assert json.loads(app.state.store.meta_get(GENERAL_PREFERENCE_KEY)) == payload()
                assert app.state.settings.segment_seconds == 3600
            finally:
                media.resume.set()
                await asyncio.gather(*[task for task in (first, second) if task], return_exceptions=True)


@pytest.mark.asyncio
async def test_general_save_queued_before_logout_cannot_modify_metadata_after_expiration(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    media = app.state.media
    media.hold = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await async_login(client)
            first = asyncio.create_task(client.put("/api/settings/recording", json={"segment_minutes": 60}, headers=HEADERS))
            second = None
            try:
                await asyncio.wait_for(media.entered.wait(), 5)
                observed = observe_auth(app, monkeypatch)
                second = asyncio.create_task(client.put(ENDPOINT, json=payload(), headers=HEADERS))
                await asyncio.wait_for(observed.wait(), 5)
                assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200
                media.resume.set()
                a, b = await asyncio.wait_for(asyncio.gather(first, second), 5)
                assert a.status_code == 200 and b.status_code == 401
                assert b.json() == {"detail": "Authentication required"}
                assert app.state.store.meta_get(GENERAL_PREFERENCE_KEY) is None
            finally:
                media.resume.set()
                await asyncio.gather(*[task for task in (first, second) if task], return_exceptions=True)


@pytest.mark.asyncio
async def test_disconnected_general_save_finishes_before_shutdown_stops_the_recorder(tmp_path):
    entered, resume = threading.Event(), threading.Event()

    class BlockingPreferences(GeneralPreferences):
        def save(self, data):
            entered.set()
            assert resume.wait(5), "fixture worker was not released"
            return super().save(data)

    app = make_app(tmp_path, factory=lambda store, telemetry: BlockingPreferences(store, telemetry, root_dir=tmp_path / "qa-system"))
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    request = shutdown = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await async_login(client)
            request = asyncio.create_task(client.put(ENDPOINT, json=payload(), headers=HEADERS))
            assert await asyncio.to_thread(entered.wait, 5)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            stopping = asyncio.Event()

            async def stop():
                stopping.set()
                await lifespan.__aexit__(None, None, None)

            shutdown = asyncio.create_task(stop())
            await stopping.wait()
            assert not shutdown.done() and not app.state.media.stopped.is_set()
            assert app.state.store.meta_get(GENERAL_PREFERENCE_KEY) is None
            resume.set()
            await asyncio.wait_for(shutdown, 5)
            assert json.loads(app.state.store.meta_get(GENERAL_PREFERENCE_KEY)) == payload()
            assert app.state.media.stopped.is_set()
    finally:
        resume.set()
        if request is not None:
            await asyncio.gather(request, return_exceptions=True)
        if shutdown is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await asyncio.gather(shutdown, return_exceptions=True)
