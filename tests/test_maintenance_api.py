"""Only fake maintenance actions are invoked through the authenticated API."""
import asyncio

from fastapi.testclient import TestClient
import httpx
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.maintenance import MaintenanceError, unavailable_status, validate_action


PASSWORD = "maintenance-test-password"
HEADERS = {"X-NVR-Request": "1"}
STATUS = "/api/settings/system"
ACTION = STATUS + "/action"


class FakeMedia:
    def __init__(self, settings, store):
        pass
    async def start(self): pass
    async def stop(self): pass


class FakeLive:
    def __init__(self, settings):
        pass
    async def start(self): pass
    async def stop(self): pass


class FakeMaintenance:
    def __init__(self):
        self.calls = []
        self.status_calls = 0
        self.failure = None
        self.available = True
        self.entered = asyncio.Event()
        self.resume = None

    async def status(self):
        self.status_calls += 1
        return unavailable_status() | ({"service_restart": True, "target": "container", "reason": None}
                                       if self.available else {})

    async def schedule(self, action, confirmation):
        validate_action(action, confirmation)
        if self.failure:
            raise self.failure
        self.calls.append((action, confirmation))
        self.entered.set()
        if self.resume is not None:
            await self.resume.wait()
        return {"accepted": True, "action": action, "delay_seconds": 5,
                "message": "The NVR service will restart in a few seconds."}


def make_app(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=PASSWORD)
    return create_app(settings, media_factory=FakeMedia, live_factory=FakeLive, maintenance_factory=FakeMaintenance)


@pytest.fixture
def client(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        yield client


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


def test_status_and_action_require_authentication_and_same_origin_csrf(client):
    body = {"action": "restart-service", "confirmation": "RESTART"}
    assert client.get(STATUS).status_code == 401
    assert client.post(ACTION, json=body, headers=HEADERS).status_code == 401
    assert client.app.state.maintenance.status_calls == 0
    login(client)
    assert client.post(ACTION, json=body).status_code == 403
    assert client.post(ACTION, json=body, headers=HEADERS | {"Origin": "https://external.invalid"}).status_code == 403
    assert client.app.state.maintenance.calls == []
    response = client.get(STATUS)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json()["target"] == "container" and response.json()["service_restart"] is True
    accepted = client.post(ACTION, json=body, headers=HEADERS | {"Origin": "http://testserver"})
    assert accepted.status_code == 200 and accepted.json()["accepted"] is True
    assert accepted.json()["delay_seconds"] == 5
    assert client.app.state.maintenance.calls == [("restart-service", "RESTART")]
    assert client.post("/api/logout", headers=HEADERS).status_code == 200
    assert client.post(ACTION, json=body, headers=HEADERS).status_code == 401


@pytest.mark.parametrize("body", [
    {}, {"action": "restart-service"},
    {"action": "restart-service", "confirmation": "restart"},
    {"action": "reboot-system", "confirmation": " REBOOT"},
    {"action": "restart-service", "confirmation": True},
    {"action": "restart-service", "confirmation": "RESTART", "unit": "other.service"},
    {"action": "command", "confirmation": "RESTART", "command": "private-command"},
    {"action": "restart-service;private-command", "confirmation": "RESTART"},
])
def test_strict_payload_cannot_choose_a_command_service_or_remote_target(client, body):
    login(client)
    response = client.post(ACTION, json=body, headers=HEADERS)
    assert response.status_code == 422
    assert "private-command" not in response.text
    assert client.app.state.maintenance.calls == []


def test_cross_action_confirmation_is_rejected_before_any_action(client):
    login(client)
    response = client.post(ACTION, json={"action": "reboot-system", "confirmation": "RESTART"}, headers=HEADERS)
    assert response.status_code == 400
    assert response.json() == {"detail": "The maintenance confirmation does not match."}
    assert client.app.state.maintenance.calls == []


@pytest.mark.parametrize("message,status", [
    ("System reboot is disabled on this installation.", 403),
    ("A maintenance action is already scheduled. Please wait before trying again.", 409),
    ("System maintenance is unavailable on this installation.", 503),
])
def test_safe_helper_errors_keep_their_status_without_automatic_retry(client, message, status):
    login(client)
    client.app.state.maintenance.failure = MaintenanceError(message, status)
    response = client.post(ACTION, json={"action": "reboot-system", "confirmation": "REBOOT"}, headers=HEADERS)
    assert response.status_code == status and response.json() == {"detail": message}
    assert client.app.state.maintenance.calls == []


def test_unsupported_installation_has_explicit_read_only_status(client):
    login(client)
    client.app.state.maintenance.available = False
    response = client.get(STATUS)
    assert response.status_code == 200 and response.json() == unavailable_status()
    assert client.app.state.maintenance.calls == []
    assert "/run/" not in response.text and "/etc/" not in response.text


async def test_queued_maintenance_rechecks_session_after_logout(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    helper = app.state.maintenance
    helper.resume = asyncio.Event()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            assert (await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)).status_code == 200
            first = asyncio.create_task(client.post(ACTION, json={"action": "restart-service", "confirmation": "RESTART"}, headers=HEADERS))
            second = None
            try:
                await asyncio.wait_for(helper.entered.wait(), 5)
                checked = asyncio.Event()
                valid = app.state.auth.valid
                def observed(token):
                    accepted = valid(token)
                    if accepted:
                        checked.set()
                    return accepted
                monkeypatch.setattr(app.state.auth, "valid", observed)
                second = asyncio.create_task(client.post(ACTION, json={"action": "reboot-system", "confirmation": "REBOOT"}, headers=HEADERS))
                await asyncio.wait_for(checked.wait(), 5)
                assert not second.done()
                assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200
                helper.resume.set()
                first_response, second_response = await asyncio.wait_for(asyncio.gather(first, second), 5)
                assert first_response.status_code == 200
                assert second_response.status_code == 401
                assert helper.calls == [("restart-service", "RESTART")]
            finally:
                helper.resume.set()
                tasks = [task for task in (first, second) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
