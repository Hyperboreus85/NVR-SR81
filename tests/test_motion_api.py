from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.media import MediaError


class MotionMedia:
    def __init__(self, settings, store):
        self.calls = []
        self.failure = False

    async def start(self): pass
    async def stop(self): pass

    async def motion(self, recording, sensitivity="medium"):
        self.calls.append((recording["id"], sensitivity))
        if self.failure:
            raise MediaError("Private implementation details must not leave the recorder")
        return {"duration": recording["duration"], "sample_seconds": .5,
                "sensitivity": sensitivity, "method": "frame-difference",
                "events": [{"start": 2, "end": 4.5, "score": .2}]}


@pytest.fixture
def motion_client(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                        password="motion-test-password")
    app = create_app(settings, media_factory=MotionMedia)
    with TestClient(app) as client:
        yield client, settings


def test_motion_requires_login_and_accepts_only_supported_sensitivity(motion_client):
    client, settings = motion_client
    (settings.recordings_dir / "camera").mkdir()
    (settings.recordings_dir / "camera/test.mkv").write_bytes(b"test fixture")
    recording_id = client.app.state.store.add_recording("camera", "camera/test.mkv", 100, 60, 12, "h264")
    path = f"/api/recordings/{recording_id}/motion"
    assert client.get(path).status_code == 401
    assert not client.app.state.media.calls
    assert client.post("/api/login", json={"password": "motion-test-password"},
                       headers={"X-NVR-Request": "1"}).status_code == 200
    for sensitivity in (None, "low", "medium", "high"):
        response = client.get(path, params={} if sensitivity is None else {"sensitivity": sensitivity})
        assert response.status_code == 200
        result = response.json()
        assert result["sensitivity"] == (sensitivity or "medium")
        assert result["events"] == [{"start": 2, "end": 4.5, "score": .2}]
        assert response.headers["cache-control"] == "no-store"
        assert "path" not in result
    assert client.get(path, params={"sensitivity": "invalid"}).status_code == 422
    assert len(client.app.state.media.calls) == 4


def test_motion_refuses_missing_or_outside_files_and_hides_worker_errors(motion_client, tmp_path):
    client, settings = motion_client
    client.post("/api/login", json={"password": "motion-test-password"}, headers={"X-NVR-Request": "1"})
    store = client.app.state.store
    missing = store.add_recording("camera", "missing.mkv", 100, 60, 1, "h264")
    outside = tmp_path / "private.mkv"
    outside.write_bytes(b"private")
    unsafe = store.add_recording("camera", str(outside), 200, 60, 7, "h264")
    for recording_id in ("unknown", missing, unsafe):
        response = client.get(f"/api/recordings/{recording_id}/motion")
        assert response.status_code == 404
        assert str(tmp_path) not in response.text
    assert not client.app.state.media.calls
    (settings.recordings_dir / "test.mkv").write_bytes(b"fixture")
    recording_id = store.add_recording("camera", "test.mkv", 300, 60, 7, "h264")
    client.app.state.media.failure = True
    response = client.get(f"/api/recordings/{recording_id}/motion")
    assert response.status_code == 503
    assert "Private implementation details" not in response.text
