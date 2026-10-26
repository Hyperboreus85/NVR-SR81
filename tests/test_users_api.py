"""Account authorization is enforced on direct APIs, files and ongoing media."""
import asyncio
from contextlib import asynccontextmanager
import json
import time

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from nvr import app as module
from nvr.app import create_app, PERMISSION_KEYS, RevocableStreamingResponse
from nvr.config import Settings
from nvr.general_preferences import GeneralPreferences


ADMIN_PASSWORD = "administrator-api-test-password"
USER_PASSWORD = "ordinary-user-test-password"
HEADERS = {"X-NVR-Request": "1"}
ALLOWED, HIDDEN = "a" * 32, "b" * 32


class Idle:
    def __init__(self, *args): pass
    async def start(self): pass
    async def stop(self): pass


class Telemetry:
    def __init__(self, *args): pass
    def snapshot(self): return {"identity": {"hostname": "private-recorder", "addresses": ["192.0.2.123"]}}


class Media(Idle):
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.calls = []
        self.entered, self.resume = asyncio.Event(), asyncio.Event()
        self.hold = False
        self.cached = settings.data_dir / "qa-playback.mp4"
        self.cached.write_bytes(b"compatible-file-data")
    async def reconcile(self): pass
    def camera_status(self, camera_id): return {"state": "recording", "message": "private-stream-details", "last_segment_at": None, "url": "private"}
    async def set_segment_seconds(self, seconds):
        self.entered.set()
        if self.hold: await self.resume.wait()
        self.settings.segment_seconds = seconds
    async def probe(self, source): self.calls.append("probe"); return {"video_codec": "h264"}
    async def snapshot(self, camera):
        self.calls.append(("snapshot", camera["id"]))
        self.entered.set()
        if self.hold: await self.resume.wait()
        return b"jpeg"
    async def live(self, camera):
        self.calls.append(("mjpeg", camera["id"]))
        yield b"jpeg-frame"
    @asynccontextmanager
    async def source_lease(self, recording):
        self.calls.append(("download", recording["camera_id"]))
        yield self.settings.recordings_dir / recording["path"]
    @asynccontextmanager
    async def playback_lease(self, recording, compatible=False):
        self.calls.append(("playback", recording["camera_id"]))
        yield self.cached
    @asynccontextmanager
    async def download_lease(self, recording):
        self.calls.append(("download.mp4", recording["camera_id"]))
        yield self.cached
    async def thumbnail(self, recording): self.calls.append(("thumbnail", recording["camera_id"])); return b"jpeg"
    async def waveform(self, recording): self.calls.append(("waveform", recording["camera_id"])); return {"peaks": []}
    async def motion(self, recording, sensitivity): self.calls.append(("motion", recording["camera_id"])); return {"events": []}
    def archive_status(self): return {"recordings_count": 2, "recordings_bytes": 20, "clearing": False}


class Subscription:
    mime, mode = "video/mp4", "copy"
    def __init__(self, long=False): self.long = long; self.closed = False; self.entered = asyncio.Event()
    async def stream(self):
        try:
            self.entered.set()
            yield b"initialization"
            if self.long: await asyncio.Event().wait()
            yield b"fragment"
        finally:
            await self.close()
    async def close(self): self.closed = True


class Live(Idle):
    def __init__(self, *args): self.opened = []; self.subscription = None; self.long = False; self.ready = asyncio.Event()
    async def reconcile(self, cameras): pass
    async def open(self, camera, compatible=False):
        self.opened.append(camera["id"])
        self.subscription = Subscription(self.long)
        self.ready.set()
        return self.subscription
    def status(self):
        return {"active_streams": 99, "max_streams": 16, "active_transcodes": 99, "max_transcodes": 2,
                "streams": [{"camera_id": identity, "mode": mode, "state": "streaming", "viewers": 1, "url": "private"}
                            for identity, mode in [(ALLOWED, "copy"), (HIDDEN, "compatible")]]}


def make_app(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=ADMIN_PASSWORD)
    app = create_app(settings, media_factory=Media, live_factory=Live, telemetry_factory=Telemetry,
                     history_factory=Idle, general_factory=lambda store, telemetry: GeneralPreferences(store, telemetry, root_dir=tmp_path / "system"))
    for identity, name in [(ALLOWED, "Allowed"), (HIDDEN, "Hidden")]:
        app.state.store.save_camera({"name": name, "url": "rtsp://private-user:private-password@192.0.2.88/private-path?private-token",
            "preview_url": "", "enabled": False, "audio_mode": "copy", "retention_days": 7}, identity)
    rows = {}
    for identity, started in [(HIDDEN, 10), (ALLOWED, 20)]:
        relative = f"{identity}/1700000000000-000000.mkv"
        path = settings.recordings_dir / relative
        path.parent.mkdir(); path.write_bytes(b"original-recording-data")
        rows[identity] = app.state.store.add_recording(identity, relative, started, 60, path.stat().st_size, "h264", "aac")
    app.state.qa_recordings = rows
    return app


def login(client, username="admin", password=ADMIN_PASSWORD):
    response = client.post("/api/login", json={"username": username, "password": password}, headers=HEADERS)
    assert response.status_code == 200
    return response.json()["user"]


def create_user(admin, *, username="viewer", permissions=(), camera_scope="selected", camera_ids=None, role="user"):
    response = admin.post("/api/users", json={"username": username, "password": USER_PASSWORD, "display_name": "Test viewer",
        "role": role, "permissions": list(permissions), "camera_scope": camera_scope,
        "camera_ids": [ALLOWED] if camera_ids is None else camera_ids, "enabled": True}, headers=HEADERS)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def clients(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as admin:
        user = TestClient(app)
        login(admin)
        try:
            yield app, admin, user
        finally:
            user.close()


def test_users_crud_is_admin_only_public_and_strict_and_revision_revokes_old_login(clients):
    app, admin, user = clients
    created = create_user(admin, permissions=("live",))
    assert not {"password", "password_hash", "revision"} & created.keys()
    assert created["permissions"] == ["live"] and created["camera_ids"] == [ALLOWED]
    login(user, "viewer", USER_PASSWORD)
    session = user.get("/api/session").json()
    assert session["authenticated"] and session["user"] == created
    assert user.get("/api/users").status_code == 403
    assert user.put("/api/users/" + created["id"], json={"role": "admin"}, headers=HEADERS).status_code == 403
    listed = admin.get("/api/users")
    assert listed.status_code == 200 and listed.json()["permissions"] == list(PERMISSION_KEYS)
    assert USER_PASSWORD not in listed.text and "password_hash" not in listed.text and '"revision"' not in listed.text
    changed = admin.put("/api/users/" + created["id"], json={"permissions": []}, headers=HEADERS)
    assert changed.status_code == 200
    assert user.get("/api/cameras").status_code == 401
    assert user.get("/api/session").json() == {"authenticated": False, "user": None}
    login(user, "viewer", USER_PASSWORD)
    assert user.get("/api/cameras").status_code == 403
    assert admin.delete("/api/users/" + created["id"], headers=HEADERS).json() == {"deleted": True}
    assert user.get("/api/preferences").status_code == 401


@pytest.mark.parametrize("changes", [{"role": True}, {"permissions": [True]}, {"enabled": "false"}, {"camera_ids": [True]},
    {"password": "private"}, {"username": "bad private"}, {"private-field": "private-password"}])
def test_invalid_user_payloads_do_not_echo_sensitive_input_or_add_accounts(clients, changes):
    app, admin, user = clients
    before = len(admin.get("/api/users").json()["users"])
    response = admin.post("/api/users", json={"username": "new-user", "password": USER_PASSWORD} | changes, headers=HEADERS)
    assert response.status_code == 422 and "private" not in response.text
    assert len(admin.get("/api/users").json()["users"]) == before


def test_no_permission_account_has_only_safe_preferences_session_and_public_language_access(clients):
    app, admin, user = clients
    create_user(admin, permissions=())
    login(user, "viewer", USER_PASSWORD)
    values = user.get("/api/preferences")
    assert values.status_code == 200 and values.headers["cache-control"] == "no-store"
    assert set(values.json()) == {"recorder_name", "timezone", "hour_format", "rotation_seconds", "effective_timezone"}
    assert "192.0.2.123" not in values.text and "hostname" not in values.text and "timezones" not in values.text
    assert user.get("/api/languages").status_code == 200
    for path in ("/api/cameras", "/api/recordings", "/api/users", "/api/live/status", "/api/settings/general",
        "/api/settings/recording", "/api/settings/system", "/api/settings/archive", "/api/languages/template",
        "/api/system", "/api/system/telemetry", "/api/system/history", "/api/onvif/interfaces"):
        assert user.get(path).status_code == 403, path
    assert user.get("/api/not-mapped").status_code == 404
    for path, body in [("/api/cameras", {"name": "no", "url": "rtsp://camera.invalid/no"}),
        ("/api/settings/system/action", {"action": "restart-service", "confirmation": "RESTART"}),
        ("/api/settings/archive/clear", {"confirmation": "DELETE"}),
        ("/api/onvif/profiles", {"endpoint": "http://camera.invalid/onvif"})]:
        assert user.post(path, json=body, headers=HEADERS).status_code == 403
    assert app.state.media.calls == [] and app.state.realtime.opened == []


def test_live_only_user_gets_minimal_scoped_camera_metadata_and_cannot_access_recording_or_probe(clients):
    app, admin, user = clients
    saved = app.state.store.get_camera(ALLOWED)
    app.state.store.save_camera(saved | {"preview_url": "rtsp://private-user:private-password@192.0.2.88/private-sub", "third_url": "rtsp://private-user:private-password@192.0.2.88/private-third", "live_stream": 3}, ALLOWED)
    create_user(admin, permissions=("live",))
    login(user, "viewer", USER_PASSWORD)
    response = user.get("/api/cameras")
    assert response.status_code == 200 and len(response.json()) == 1
    camera = response.json()[0]
    assert camera["id"] == ALLOWED and camera["name"] == "Allowed"
    assert set(camera) <= {"id", "name", "enabled", "audio_mode", "retention_days", "live_stream", "status", "streams"}
    assert camera["live_stream"] == 3 and camera["streams"] == {"main": {"configured": True}, "sub": {"configured": True}, "third": {"configured": True}}
    assert set(camera["status"]) <= {"state", "last_segment_at"}
    assert "192.0.2.88" not in response.text and "private" not in response.text
    assert user.get(f"/api/cameras/{ALLOWED}/snapshot").content == b"jpeg"
    assert user.get(f"/api/cameras/{ALLOWED}/live.mp4").status_code == 200
    for identity in (HIDDEN, "f" * 32):
        for action in ("snapshot", "live", "live.mp4"):
            assert user.get(f"/api/cameras/{identity}/{action}").status_code == 404
    assert user.post(f"/api/cameras/{ALLOWED}/probe", headers=HEADERS).status_code == 403
    for action in ("playback", "thumbnail", "waveform", "motion", "download", "download.mp4"):
        assert user.get(f"/api/recordings/{app.state.qa_recordings[ALLOWED]}/{action}").status_code == 403
    status = user.get("/api/live/status").json()
    assert status["active_streams"] == 1 and status["active_transcodes"] == 0
    assert [stream["camera_id"] for stream in status["streams"]] == [ALLOWED]
    assert HIDDEN not in json.dumps(status)


def test_scoped_recordings_filter_before_limit_and_gate_every_media_route_without_existence_leaks(clients):
    app, admin, user = clients
    create_user(admin, permissions=("recordings",))
    login(user, "viewer", USER_PASSWORD)
    result = user.get("/api/recordings?limit=1")
    assert result.status_code == 200 and len(result.json()) == 1
    assert result.json()[0]["camera_id"] == ALLOWED and "path" not in result.json()[0]
    assert user.get("/api/recordings?camera_id=" + HIDDEN).status_code == 404
    for action in ("playback", "thumbnail", "waveform", "motion"):
        assert user.get(f"/api/recordings/{app.state.qa_recordings[ALLOWED]}/{action}").status_code == 200
        denied = user.get(f"/api/recordings/{app.state.qa_recordings[HIDDEN]}/{action}")
        missing = user.get(f"/api/recordings/nonexistent/{action}")
        assert denied.status_code == missing.status_code == 404 and denied.json() == missing.json()
    for action in ("download", "download.mp4"):
        assert user.get(f"/api/recordings/{app.state.qa_recordings[ALLOWED]}/{action}").status_code == 403
    assert user.get(f"/api/cameras/{ALLOWED}/snapshot").status_code == 403
    assert all(identity == ALLOWED for operation, identity in app.state.media.calls)


def test_download_requires_explicit_permission_and_deleted_camera_recordings_keep_their_grant(clients):
    app, admin, user = clients
    create_user(admin, permissions=("recordings", "download"))
    login(user, "viewer", USER_PASSWORD)
    app.state.store.delete_camera(ALLOWED)
    assert user.get("/api/cameras").json() == []
    assert user.get("/api/recordings?camera_id=" + ALLOWED).json()[0]["camera_id"] == ALLOWED
    for action in ("download", "download.mp4", "playback"):
        assert user.get(f"/api/recordings/{app.state.qa_recordings[ALLOWED]}/{action}").status_code == 200
        assert user.get(f"/api/recordings/{app.state.qa_recordings[HIDDEN]}/{action}").status_code == 404


def test_scoped_camera_manager_can_edit_only_assigned_cameras_and_has_no_implicit_live(clients):
    app, admin, user = clients
    create_user(admin, permissions=("cameras",))
    login(user, "viewer", USER_PASSWORD)
    assert "connection" in user.get("/api/cameras").json()[0]
    assert user.post(f"/api/cameras/{ALLOWED}/probe", headers=HEADERS).status_code == 200
    assert user.get(f"/api/cameras/{ALLOWED}/snapshot").status_code == 403
    body = {"name": "Renamed"}
    assert user.put(f"/api/cameras/{ALLOWED}", json=body, headers=HEADERS).status_code == 200
    assert user.put(f"/api/cameras/{HIDDEN}", json=body, headers=HEADERS).status_code == 404
    assert user.delete(f"/api/cameras/{HIDDEN}", headers=HEADERS).status_code == 404
    assert user.post("/api/cameras", json={"name": "new", "url": "rtsp://camera.invalid/new"}, headers=HEADERS).status_code == 403


def test_system_permission_does_not_grant_settings_or_live_and_status_counts_remain_scoped(clients):
    app, admin, user = clients
    create_user(admin, permissions=("system",))
    login(user, "viewer", USER_PASSWORD)
    assert user.get("/api/system").status_code == 200
    assert user.get("/api/settings/general").status_code == 403
    assert user.get("/api/settings/system").status_code == 403
    assert user.get("/api/cameras").status_code == 403
    assert user.get(f"/api/cameras/{ALLOWED}/live.mp4").status_code == 403
    status = user.get("/api/live/status").json()
    assert status["active_streams"] == 1 and [stream["camera_id"] for stream in status["streams"]] == [ALLOWED]


def test_recordings_all_and_selected_empty_scopes_have_distinct_results(clients):
    app, admin, user = clients
    create_user(admin, permissions=("recordings",), camera_scope="all", camera_ids=[])
    login(user, "viewer", USER_PASSWORD)
    assert {row["camera_id"] for row in user.get("/api/recordings").json()} == {ALLOWED, HIDDEN}
    empty = create_user(admin, username="empty-viewer", permissions=("recordings",), camera_ids=[])
    login(user, "empty-viewer", USER_PASSWORD)
    assert user.get("/api/cameras").json() == [] and user.get("/api/recordings?limit=1").json() == []
    assert user.get(f"/api/recordings/{app.state.qa_recordings[ALLOWED]}/playback").status_code == 404


def test_login_cannot_return_authenticated_true_when_the_new_token_was_revoked_before_response(clients, monkeypatch):
    app, admin, user = clients
    original = app.state.auth.authenticate
    def revoked(*args):
        token = original(*args)
        app.state.auth.logout(token)
        return token
    monkeypatch.setattr(app.state.auth, "authenticate", revoked)
    response = user.post("/api/login", json={"password": ADMIN_PASSWORD}, headers=HEADERS)
    assert response.status_code == 401 and "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_queued_user_creation_rechecks_administrator_after_logout(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    app.state.media.hold = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await client.post("/api/login", json={"password": ADMIN_PASSWORD}, headers=HEADERS)
            first = asyncio.create_task(client.put("/api/settings/recording", json={"segment_minutes": 60}, headers=HEADERS))
            second = None
            try:
                await asyncio.wait_for(app.state.media.entered.wait(), 2)
                authenticated = asyncio.Event()
                principal = app.state.auth.principal
                def observed(token):
                    result = principal(token)
                    if result is not None: authenticated.set()
                    return result
                monkeypatch.setattr(app.state.auth, "principal", observed)
                second = asyncio.create_task(client.post("/api/users", json={"username": "never-created", "password": USER_PASSWORD}, headers=HEADERS))
                await asyncio.wait_for(authenticated.wait(), 2)
                assert not second.done()
                assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200
                app.state.media.resume.set()
                saved, rejected = await asyncio.wait_for(asyncio.gather(first, second), 3)
                assert saved.status_code == 200 and rejected.status_code == 401
                assert app.state.auth.accounts.by_username("never-created") is None
            finally:
                app.state.media.resume.set()
                await asyncio.gather(*[task for task in (first, second) if task], return_exceptions=True)


def test_own_password_requires_admin_old_password_confirmation_and_reauthenticates_all_old_sessions(clients):
    app, admin, user = clients
    builtin = admin.get("/api/session").json()["user"]
    assert admin.put("/api/users/" + builtin["id"], json={"password": USER_PASSWORD}, headers=HEADERS).status_code == 409
    body = {"current_password": "private-wrong", "new_password": USER_PASSWORD, "confirm_password": USER_PASSWORD}
    wrong = admin.post("/api/users/me/password", json=body, headers=HEADERS)
    assert wrong.status_code == 422 and "private-wrong" not in wrong.text
    assert admin.post("/api/users/me/password", json=body | {"current_password": ADMIN_PASSWORD, "confirm_password": "different-new-password"}, headers=HEADERS).status_code == 422
    login(user)
    response = admin.post("/api/users/me/password", json=body | {"current_password": ADMIN_PASSWORD}, headers=HEADERS)
    assert response.status_code == 200 and response.json() == {"password_changed": True, "reauthentication_required": True}
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert user.get("/api/users").status_code == 401
    assert admin.post("/api/login", json={"username": "admin", "password": ADMIN_PASSWORD}, headers=HEADERS).status_code == 401
    assert login(admin, password=USER_PASSWORD)["role"] == "admin"


@pytest.mark.asyncio
async def test_http_live_revocation_interrupts_idle_stream_and_closes_subscription(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "LIVE_AUTH_CHECK_SECONDS", .02)
    app = make_app(tmp_path)
    app.state.realtime.long = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as admin, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as user:
            assert (await admin.post("/api/login", json={"password": ADMIN_PASSWORD}, headers=HEADERS)).status_code == 200
            created = await admin.post("/api/users", json={"username": "viewer", "password": USER_PASSWORD, "permissions": ["live"], "camera_ids": [ALLOWED]}, headers=HEADERS)
            assert created.status_code == 201
            await user.post("/api/login", json={"username": "viewer", "password": USER_PASSWORD}, headers=HEADERS)
            stream = asyncio.create_task(user.get(f"/api/cameras/{ALLOWED}/live.mp4"))
            await asyncio.wait_for(app.state.realtime.ready.wait(), 2)
            await asyncio.wait_for(app.state.realtime.subscription.entered.wait(), 2)
            response = await admin.put("/api/users/" + created.json()["id"], json={"permissions": []}, headers=HEADERS)
            assert response.status_code == 200
            result = await asyncio.wait_for(stream, 2)
            assert result.status_code == 200 and result.content == b"initialization"
            assert app.state.realtime.subscription.closed
            assert (await user.get(f"/api/cameras/{ALLOWED}/snapshot")).status_code == 401


def test_websocket_rejects_scope_and_loses_access_when_user_is_disabled(clients, monkeypatch):
    app, admin, user = clients
    monkeypatch.setattr(module, "LIVE_AUTH_CHECK_SECONDS", .02)
    created = create_user(admin, permissions=("live",))
    login(user, "viewer", USER_PASSWORD)
    with pytest.raises(WebSocketDisconnect):
        with user.websocket_connect(f"/api/cameras/{HIDDEN}/live.ws", headers={"origin": "http://testserver"}) as websocket:
            websocket.receive_json()
    assert app.state.realtime.opened == []
    app.state.realtime.long = True
    with user.websocket_connect(f"/api/cameras/{ALLOWED}/live.ws", headers={"origin": "http://testserver"}) as websocket:
        assert websocket.receive_json()["type"] == "init"
        assert websocket.receive_bytes() == b"initialization"
        assert admin.put("/api/users/" + created["id"], json={"enabled": False}, headers=HEADERS).status_code == 200
        with pytest.raises(WebSocketDisconnect) as caught:
            websocket.receive_bytes()
        assert caught.value.code == 4401
    assert app.state.realtime.subscription.closed


@pytest.mark.asyncio
async def test_live_revocation_closes_source_even_while_http_send_is_blocked(monkeypatch):
    monkeypatch.setattr(module, "LIVE_AUTH_CHECK_SECONDS", .02)
    allowed = [True]
    entered, closed = asyncio.Event(), asyncio.Event()
    async def body():
        try: yield b"frame"
        finally: closed.set()
    def check():
        if not allowed[0]: raise HTTPException(401)
    async def send(message):
        if message["type"] == "http.response.body" and message.get("body"):
            entered.set(); await asyncio.Event().wait()
    async def receive(): await asyncio.Event().wait()
    response = RevocableStreamingResponse(body(), check=check)
    request = asyncio.create_task(response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send))
    await asyncio.wait_for(entered.wait(), 1)
    allowed[0] = False
    await asyncio.wait_for(request, 1)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_media_result_is_not_returned_after_permission_revision_changes_during_capture(tmp_path):
    app = make_app(tmp_path)
    app.state.media.hold = True
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as admin, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as user:
            await admin.post("/api/login", json={"password": ADMIN_PASSWORD}, headers=HEADERS)
            created = await admin.post("/api/users", json={"username": "viewer", "password": USER_PASSWORD, "permissions": ["live"], "camera_ids": [ALLOWED]}, headers=HEADERS)
            await user.post("/api/login", json={"username": "viewer", "password": USER_PASSWORD}, headers=HEADERS)
            request = asyncio.create_task(user.get(f"/api/cameras/{ALLOWED}/snapshot"))
            await asyncio.wait_for(app.state.media.entered.wait(), 2)
            await admin.put("/api/users/" + created.json()["id"], json={"permissions": []}, headers=HEADERS)
            app.state.media.resume.set()
            result = await asyncio.wait_for(request, 2)
            assert result.status_code == 401 and result.content != b"jpeg"
