from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.security import validate_stream_url
from nvr.store import Store


class FakeMedia:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass
    def camera_status(self, camera_id):
        return {"state": "stopped", "message": "Test", "last_segment_at": None}
    async def probe(self, url):
        return {"video_codec": "h264", "audio_codec": "aac"}


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        password="test-password-strong")
    app = create_app(settings, media_factory=FakeMedia)
    with TestClient(app) as client:
        yield client


def login(client):
    return client.post("/api/login", json={"password": "test-password-strong"}, headers={"X-NVR-Request": "1"})


def test_authentication_csrf_and_logout(client):
    assert client.get("/api/cameras").status_code == 401
    assert client.post("/api/login", json={"password": "test-password-strong"}).status_code == 403
    response = login(client)
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert client.get("/api/session").json()["authenticated"]
    assert client.post("/api/logout", headers={"X-NVR-Request": "1", "Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/logout", headers={"X-NVR-Request": "1"}).status_code == 200
    assert client.get("/api/cameras").status_code == 401


def test_camera_crud_never_discloses_credentials(client):
    login(client)
    payload = {"name": "Ingresso", "url": "rtsp://alice:secret@192.168.1.2/live?password=hidden", "retention_days": 14}
    response = client.post("/api/cameras", json=payload, headers={"X-NVR-Request": "1"})
    assert response.status_code == 201
    for text in (response.text, client.get("/api/cameras").text):
        assert "secret" not in text and "hidden" not in text and "alice" not in text
    camera_id = response.json()["id"]
    app = client.app
    raw = app.state.store.db_path.read_bytes()
    assert b"secret" not in raw
    assert b"secret" not in Path(str(app.state.store.db_path) + "-wal").read_bytes() if Path(str(app.state.store.db_path) + "-wal").exists() else True
    response = client.put(f"/api/cameras/{camera_id}", json={"name": "Porta", "url": None, "enabled": False}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 200
    assert app.state.store.get_camera(camera_id)["url"] == payload["url"]
    assert not app.state.store.get_camera(camera_id)["enabled"]
    assert client.delete(f"/api/cameras/{camera_id}", headers={"X-NVR-Request": "1"}).json()["recordings_preserved"]


def test_invalid_protocols_and_validation_do_not_echo_password(client):
    login(client)
    response = client.post("/api/cameras", json={"name": "test", "url": "file:///etc/passwd"}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 422
    response = client.post("/api/cameras", json={"name": "test", "url": "rtsp://user:verysecret@host/live", "retention_days": -1}, headers={"X-NVR-Request": "1"})
    assert response.status_code == 422 and "verysecret" not in response.text


def test_recording_overlap_range_path_protection_and_no_path_leak(client, tmp_path):
    login(client)
    store = client.app.state.store
    r = store.add_recording("camera", "test.mkv", 100, 60, 1000, "hevc", "pcm_alaw")
    rows = client.get("/api/recordings", params={"camera_id": "camera", "start": 120, "end": 200}).json()
    assert len(rows) == 1 and "path" not in rows[0]
    assert client.get("/api/recordings", params={"start": 160, "end": 200}).json() == []
    assert client.get("/api/recordings", params={"start": 200, "end": 100}).status_code == 422
    assert client.get(f"/api/recordings/{r}/download").status_code == 404
    outside = tmp_path / "outside.mkv"
    outside.write_bytes(b"private")
    unsafe = store.add_recording("camera", str(outside), 200, 60, 7, "h264")
    assert client.get(f"/api/recordings/{unsafe}/download").status_code == 404


def test_password_hash_persistence_and_key_survives_restart(tmp_path):
    from nvr.security import Auth
    store = Store(tmp_path)
    auth = Auth(store, "something-long-and-random")
    assert auth.check("something-long-and-random", "local")
    assert Auth(Store(tmp_path), "").check("something-long-and-random", "local")
    assert "something-long-and-random" not in store.meta_get("password_hash")


def test_parallel_failed_logins_reserve_attempts_before_hashing(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import time
    from nvr.security import Auth
    import nvr.security as security
    auth = Auth(Store(tmp_path), "something-long-and-random")
    calls = []
    def slow_hash(*args, **kwargs):
        calls.append(1)
        time.sleep(0.05)
        return b"incorrect"
    monkeypatch.setattr(security.hashlib, "scrypt", slow_hash)
    with ThreadPoolExecutor(max_workers=10) as pool:
        assert not any(pool.map(lambda _: auth.check("bad", "same-host"), range(10)))
    assert len(calls) == 5
    assert len(auth.failures["same-host"]) == 5


@pytest.mark.parametrize("url", ["file:///tmp/a", "concat:http://host/a", "rtsp://host/a\nhello", "rtsp://host:wrong/x"])
def test_reject_unsafe_url(url):
    with pytest.raises(ValueError):
        validate_stream_url(url)


def test_root_interface_and_api_are_not_cached(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/session").headers["cache-control"] == "no-store"

