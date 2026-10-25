"""Archive deletion requires explicit consent and survives request disconnects."""
import asyncio
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

from nvr.app import create_app
from nvr.config import Settings
from nvr.media import MediaError


PASSWORD = "archive-api-test-password"
HEADERS = {"X-NVR-Request": "1"}
ENDPOINT = "/api/settings/archive/clear"
RESULT = {"deleted_files": 3, "deleted_recordings": 2, "deleted_bytes": 120, "skipped_files": 0}


class ArchiveMedia:
    def __init__(self, settings, store):
        self.calls = 0
        self.failure = None
        self.clearing = False
        self.wait = False
        self.entered = asyncio.Event()
        self.resume = asyncio.Event()
        self.applied = asyncio.Event()
        self.stopped = asyncio.Event()

    async def start(self): pass
    async def stop(self): self.stopped.set()

    async def set_segment_seconds(self, seconds):
        self.entered.set()
        await self.resume.wait()

    def archive_status(self):
        return {"recordings_count": 2, "recordings_bytes": 120, "clearing": self.clearing}

    async def clear_archive(self):
        self.calls += 1
        self.clearing = True
        try:
            self.entered.set()
            if self.wait:
                await self.resume.wait()
            if self.failure:
                raise self.failure
            self.applied.set()
            return dict(RESULT)
        finally:
            self.clearing = False


class Maintenance:
    pending = None
    async def status(self): return {"pending_action": self.pending}


class Capacity:
    def __init__(self, *args): self.invalidations = 0
    def invalidate(self): self.invalidations += 1


def make_app(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=PASSWORD)
    return create_app(settings, media_factory=ArchiveMedia, maintenance_factory=Maintenance, capacity_factory=Capacity)


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


def test_archive_status_and_action_require_login_and_same_origin(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        assert client.get("/api/settings/archive").status_code == 401
        assert client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS).status_code == 401
        login(client)
        status = client.get("/api/settings/archive")
        assert status.status_code == 200 and status.headers["cache-control"] == "no-store"
        assert status.json() == {"recordings_count": 2, "recordings_bytes": 120, "clearing": False}
        assert client.post(ENDPOINT, json={"confirmation": "DELETE"}).status_code == 403
        assert client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS | {"Origin": "https://other.invalid"}).status_code == 403
        assert client.app.state.media.calls == 0


@pytest.mark.parametrize("payload", [{}, {"confirmation": "delete"}, {"confirmation": " DELETE"},
    {"confirmation": "DELETE "}, {"confirmation": "RESTART"}, {"confirmation": True},
    {"confirmation": None}, {"confirmation": "DELETE", "path": "/"}])
def test_only_exact_confirmation_with_no_path_override_is_accepted(tmp_path, payload):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        response = client.post(ENDPOINT, json=payload, headers=HEADERS)
        assert response.status_code == 422
        assert client.app.state.media.calls == 0


def test_confirmed_action_returns_result_and_invalidates_capacity(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        response = client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS)
        assert response.status_code == 200 and response.json() == RESULT
        assert client.app.state.media.calls == 1
        assert client.app.state.capacity.invalidations == 1


def test_pending_restart_prevents_archive_deletion(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        client.app.state.maintenance.pending = "restart-service"
        response = client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS)
        assert response.status_code == 409
        assert client.app.state.media.calls == 0


@pytest.mark.parametrize("error", [OSError("private filesystem details"), sqlite3.OperationalError("private database details"),
                                  RuntimeError("private implementation details")])
def test_storage_failures_are_sanitized_and_invalidate_partial_changes(tmp_path, error):
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        client.app.state.media.failure = error
        response = client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS)
        assert response.status_code == 503 and "private" not in response.text
        assert client.app.state.capacity.invalidations == 1


def test_busy_media_error_retains_actionable_status(tmp_path):
    class Busy(MediaError): status_code = 409
    with TestClient(make_app(tmp_path)) as client:
        login(client)
        client.app.state.media.failure = Busy("Close active playback and downloads before clearing the archive.")
        response = client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS)
        assert response.status_code == 409 and "Close active playback" in response.json()["detail"]


@pytest.mark.asyncio
async def test_duplicate_request_is_rejected_and_status_remains_readable(tmp_path):
    app = make_app(tmp_path)
    media = app.state.media
    media.wait = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            assert (await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)).status_code == 200
            first = asyncio.create_task(client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS))
            try:
                await asyncio.wait_for(media.entered.wait(), 5)
                assert (await client.get("/api/settings/archive")).json()["clearing"] is True
                duplicate = await client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS)
                assert duplicate.status_code == 409 and media.calls == 1
                media.resume.set()
                assert (await asyncio.wait_for(first, 5)).status_code == 200
                assert (await client.get("/api/settings/archive")).json()["clearing"] is False
            finally:
                media.resume.set()
                await asyncio.gather(first, return_exceptions=True)


@pytest.mark.asyncio
async def test_disconnected_request_finishes_before_recorder_shutdown(tmp_path):
    app = make_app(tmp_path)
    media = app.state.media
    media.wait = True
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    shutdown = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)
            request = asyncio.create_task(client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS))
            await asyncio.wait_for(media.entered.wait(), 5)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
            await asyncio.sleep(0)
            assert not media.applied.is_set() and not media.stopped.is_set()
            media.resume.set()
            await asyncio.wait_for(shutdown, 5)
            assert media.applied.is_set() and media.stopped.is_set()
            assert media.calls == 1 and app.state.capacity.invalidations == 1
    finally:
        media.resume.set()
        if shutdown is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await asyncio.gather(shutdown, return_exceptions=True)


@pytest.mark.asyncio
async def test_clear_queued_behind_settings_rechecks_session_after_logout(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    media = app.state.media
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)
            save = asyncio.create_task(client.put("/api/settings/recording", json={"segment_minutes": 60}, headers=HEADERS))
            clear = None
            try:
                await asyncio.wait_for(media.entered.wait(), 5)
                checked = asyncio.Event()
                valid = app.state.auth.valid
                def observed_valid(token):
                    accepted = valid(token)
                    if accepted: checked.set()
                    return accepted
                monkeypatch.setattr(app.state.auth, "valid", observed_valid)
                clear = asyncio.create_task(client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS))
                await asyncio.wait_for(checked.wait(), 5)
                await client.post("/api/logout", headers=HEADERS)
                media.resume.set()
                saved, cleared = await asyncio.wait_for(asyncio.gather(save, clear), 5)
                assert saved.status_code == 200 and cleared.status_code == 401
                assert media.calls == 0
            finally:
                media.resume.set()
                await asyncio.gather(*(task for task in (save, clear) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
async def test_logout_during_maintenance_preflight_never_starts_deletion(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    entered, resume = asyncio.Event(), asyncio.Event()
    async def status():
        entered.set()
        await resume.wait()
        return {"pending_action": None}
    monkeypatch.setattr(app.state.maintenance, "status", status)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)
            clear = asyncio.create_task(client.post(ENDPOINT, json={"confirmation": "DELETE"}, headers=HEADERS))
            try:
                await asyncio.wait_for(entered.wait(), 5)
                await client.post("/api/logout", headers=HEADERS)
                resume.set()
                assert (await asyncio.wait_for(clear, 5)).status_code == 401
                assert app.state.media.calls == 0
            finally:
                resume.set()
                await asyncio.gather(clear, return_exceptions=True)
