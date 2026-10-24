"""Live wall API lifecycle, permissions and recording independence."""
import asyncio

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.live import LiveError


class IdleMedia:
    def __init__(self, settings, store): pass
    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass
    def camera_status(self, camera_id):
        return {"state": "stopped", "message": "Registrazione disattivata", "last_segment_at": None}


class Subscription:
    mime = 'video/mp4; codecs="avc1.64001F,mp4a.40.2"'
    mode = "copy"
    closed = False
    async def stream(self):
        yield b"ftyp-test-moov"
        yield b"moof-test-mdat"
    async def close(self):
        self.closed = True


class FakeLive:
    def __init__(self, settings):
        self.opened = []
        self.reconciled = []
        self.started = False
        self.stopped = False
        self.subscription = Subscription()
        self.subscription_factory = Subscription
        self.error = None
    async def start(self): self.started = True
    async def stop(self): self.stopped = True
    async def reconcile(self, cameras): self.reconciled.append(cameras)
    async def open(self, camera, compatible=False):
        if self.error:
            raise self.error
        self.opened.append((camera, compatible))
        self.subscription = self.subscription_factory()
        self.subscription.mode = "compatible" if compatible else "copy"
        return self.subscription
    def status(self):
        return {"active_streams": 1, "max_streams": 16, "active_transcodes": 0, "max_transcodes": 2,
                "secret": "private-password", "streams": [{"camera_id": "camera", "mode": "copy", "viewers": 1,
                "state": "streaming", "url": "rtsp://user:private-password@camera/live"}]}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                              password="live-api-test-password"), media_factory=IdleMedia, live_factory=FakeLive)
    with TestClient(app) as client:
        yield client
    assert app.state.realtime.stopped


HEADERS = {"X-NVR-Request": "1"}


def login(client):
    assert client.post("/api/login", json={"password": "live-api-test-password"}, headers=HEADERS).status_code == 200


def add_camera(client, enabled=False):
    response = client.post("/api/cameras", json={"name": "Ingresso", "url": "rtsp://user:secret@192.168.1.20/main",
                           "preview_url": "rtsp://user:secret@192.168.1.20/sub", "enabled": enabled}, headers=HEADERS)
    assert response.status_code == 201
    return response.json()["id"]


def test_live_requires_authentication_and_missing_camera_is_404(client):
    assert client.get("/api/live/status").status_code == 401
    assert client.get("/api/cameras/missing/live.mp4").status_code == 401
    login(client)
    assert client.get("/api/cameras/missing/live.mp4").status_code == 404
    assert client.app.state.realtime.opened == []


def test_live_works_when_recording_paused_and_releases_subscription(client):
    login(client)
    camera_id = add_camera(client, enabled=False)
    result = client.get(f"/api/cameras/{camera_id}/live.mp4")
    assert result.status_code == 200
    assert result.content == b"ftyp-test-moovmoof-test-mdat"
    assert result.headers["content-type"] == Subscription.mime
    assert result.headers["x-nvr-live-mode"] == "copy"
    assert result.headers["x-accel-buffering"] == "no"
    assert result.headers["cache-control"] == "no-store"
    live = client.app.state.realtime
    assert live.opened[0][0]["preview_url"].endswith("/sub")
    assert live.opened[0][0]["enabled"] is False
    assert live.subscription.closed


def test_compatibility_choice_reaches_live_manager(client):
    login(client)
    camera_id = add_camera(client)
    result = client.get(f"/api/cameras/{camera_id}/live.mp4?compatible=true")
    assert result.status_code == 200
    assert result.headers["x-nvr-live-mode"] == "compatible"
    assert client.app.state.realtime.opened[-1][1] is True


def test_status_never_returns_stream_credentials(client):
    login(client)
    result = client.get("/api/live/status")
    assert result.status_code == 200
    assert result.json()["max_streams"] == 16
    assert "private-password" not in result.text
    assert "url" not in result.json()["streams"][0]


def test_capacity_error_is_visible_without_opening_stream(client):
    login(client)
    camera_id = add_camera(client)
    client.app.state.realtime.error = LiveError("Limite di dirette simultanee raggiunto.", status_code=429)
    result = client.get(f"/api/cameras/{camera_id}/live.mp4")
    assert result.status_code == 429
    assert "Limite" in result.json()["detail"]
    assert client.app.state.realtime.opened == []


def test_camera_changes_invalidate_live_sources(client):
    login(client)
    camera_id = add_camera(client)
    assert client.app.state.realtime.reconciled[-1][0]["id"] == camera_id
    result = client.put(f"/api/cameras/{camera_id}", json={"name": "Porta", "url": None,
                        "preview_url": "rtsp://192.168.1.20/second-sub"}, headers=HEADERS)
    assert result.status_code == 200
    assert client.app.state.realtime.reconciled[-1][0]["preview_url"].endswith("/second-sub")
    assert client.delete(f"/api/cameras/{camera_id}", headers=HEADERS).status_code == 200
    assert client.app.state.realtime.reconciled[-1] == []


ORIGIN = {"Origin": "http://testserver"}


def test_websocket_requires_session_and_matching_origin(client):
    with client.websocket_connect("/api/cameras/missing/live.ws", headers=ORIGIN) as socket:
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()
        assert closed.value.code == 4401
    login(client)
    with pytest.raises(WebSocketDisconnect) as denied:
        with client.websocket_connect("/api/cameras/missing/live.ws", headers={"Origin": "http://untrusted.example"}):
            pass
    assert denied.value.code == 4403
    assert client.app.state.realtime.opened == []


def test_websocket_delivers_codec_metadata_then_binary_fragments(client):
    login(client)
    camera_id = add_camera(client)
    with client.websocket_connect(f"/api/cameras/{camera_id}/live.ws?compatible=true", headers=ORIGIN) as socket:
        assert socket.receive_json() == {"type": "init", "mime": Subscription.mime, "mode": "compatible"}
        assert socket.receive_bytes() == b"ftyp-test-moov"
        assert socket.receive_bytes() == b"moof-test-mdat"
        closed = socket.receive()
        assert closed["type"] == "websocket.close" and closed["code"] == 1012
    assert client.app.state.realtime.subscription.closed


def test_websocket_reports_missing_camera_and_capacity(client):
    login(client)
    with client.websocket_connect("/api/cameras/missing/live.ws", headers=ORIGIN) as socket:
        error = socket.receive_json()
        assert error["type"] == "error" and error["code"] == 404
    camera_id = add_camera(client)
    client.app.state.realtime.error = LiveError("Limite di conversioni raggiunto.", 429)
    with client.websocket_connect(f"/api/cameras/{camera_id}/live.ws", headers=ORIGIN) as socket:
        error = socket.receive_json()
        assert error["type"] == "error" and error["code"] == 429
        assert "secret" not in str(error)


class BlockingSubscription(Subscription):
    async def stream(self):
        yield b"initialization"
        await asyncio.sleep(3600)


def test_websocket_releases_stream_on_disconnect(client):
    login(client)
    camera_id = add_camera(client)
    client.app.state.realtime.subscription_factory = BlockingSubscription
    with client.websocket_connect(f"/api/cameras/{camera_id}/live.ws", headers=ORIGIN) as socket:
        socket.receive_json()
        socket.receive_bytes()
    assert client.app.state.realtime.subscription.closed


def test_websocket_logout_revalidates_session(client, monkeypatch):
    import nvr.app as app_module
    monkeypatch.setattr(app_module, "LIVE_AUTH_CHECK_SECONDS", 0.02)
    login(client)
    camera_id = add_camera(client)
    client.app.state.realtime.subscription_factory = BlockingSubscription
    with client.websocket_connect(f"/api/cameras/{camera_id}/live.ws", headers=ORIGIN) as socket:
        socket.receive_json()
        socket.receive_bytes()
        assert client.post("/api/logout", headers=HEADERS).status_code == 200
        event = socket.receive()
        assert event["type"] == "websocket.close" and event["code"] == 4401
    assert client.app.state.realtime.subscription.closed


def test_browser_policy_allows_only_own_websocket_origin(client):
    policy = client.get("/").headers["content-security-policy"]
    assert "connect-src 'self' ws://testserver;" in policy
    assert " ws:;" not in policy


@pytest.mark.parametrize("options", [{"live_max_streams": 0}, {"live_max_streams": 33}, {"live_max_transcodes": -1}, {"live_max_transcodes": 5}])
def test_invalid_live_limits_fail_startup(tmp_path, options):
    with pytest.raises(ValueError):
        Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "video", **options)
