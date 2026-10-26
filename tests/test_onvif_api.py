"""Authenticated discovery and profile export API, without contacting a LAN."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading

from fastapi.testclient import TestClient
import pytest

import nvr.app as app_module
from nvr.config import Settings
from nvr.discovery import DiscoveryError


class IdleMedia:
    def __init__(self, settings, store): pass
    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass


@pytest.fixture
def client(tmp_path):
    app = app_module.create_app(Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "video",
                                         password="onvif-api-test-password"), media_factory=IdleMedia)
    with TestClient(app) as connection:
        yield connection


HEADERS = {"X-NVR-Request": "1"}


def login(client):
    assert client.post("/api/login", json={"password": "onvif-api-test-password"}, headers=HEADERS).status_code == 200


def test_discovery_and_stream_export_require_authentication(client):
    assert client.get("/api/onvif/interfaces").status_code == 401
    for endpoint in ("discover", "scan", "profiles", "cancel"):
        assert client.post("/api/onvif/" + endpoint, json={}, headers=HEADERS).status_code == 401


def test_interface_and_discovery_response_contract(client, monkeypatch):
    monkeypatch.setattr(app_module, "list_interfaces", lambda: [{"name": "eth0", "address": "192.168.1.81", "netmask": "255.255.255.0", "cidr": "192.168.1.0/24"}])
    received = []
    async def fake_discover(interface_ip, timeout):
        received.append((interface_ip, timeout))
        return {"devices": [{"id": "uuid:camera", "endpoint": "http://192.168.1.20:8000/onvif/device_service", "ip": "192.168.1.20"}], "warnings": [], "duration": 2.0}
    monkeypatch.setattr(app_module, "discover", fake_discover)
    login(client)
    assert client.get("/api/onvif/interfaces").json()[0]["name"] == "eth0"
    result = client.post("/api/onvif/discover", json={"interface_ip": "192.168.1.81", "timeout": 2}, headers=HEADERS)
    assert result.status_code == 200
    assert result.json()["devices"][0]["endpoint"].startswith("http://192.168.1.20:8000/")
    assert received == [("192.168.1.81", 2)]


def test_scan_validation_and_safe_network_error(client, monkeypatch):
    login(client)
    for data in ({"cidr": "192.168.1.0/24", "ports": [0]}, {"cidr": "192.168.1.0/24", "ports": list(range(80, 89))}):
        assert client.post("/api/onvif/scan", json=data, headers=HEADERS).status_code == 422
    async def invalid_scan(cidr, ports):
        raise DiscoveryError("Usare una rete privata IPv4 fino a 256 indirizzi.")
    monkeypatch.setattr(app_module, "scan_network", invalid_scan)
    result = client.post("/api/onvif/scan", json={"cidr": "8.8.8.0/24"}, headers=HEADERS)
    assert result.status_code == 422 and "rete privata" in result.json()["detail"]


def test_concurrent_discovery_is_rejected_instead_of_duplicated(client, monkeypatch):
    entered = threading.Event()
    async def slow_discover(interface_ip, timeout):
        entered.set()
        await asyncio.sleep(0.5)
        return {"devices": [], "warnings": [], "duration": 0.5}
    monkeypatch.setattr(app_module, "discover", slow_discover)
    login(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/api/onvif/discover", json={}, headers=HEADERS)
        assert entered.wait(2)
        second = client.post("/api/onvif/discover", json={}, headers=HEADERS)
        assert second.status_code == 409
        assert first.result(timeout=5).status_code == 200


def test_explicit_cancel_stops_scan_and_releases_slot(client, monkeypatch):
    entered = threading.Event()
    cancelled = threading.Event()
    async def slow_discover(interface_ip, timeout):
        try:
            entered.set()
            await asyncio.sleep(10)
        finally:
            cancelled.set()
    monkeypatch.setattr(app_module, "discover", slow_discover)
    login(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/api/onvif/discover", json={}, headers=HEADERS)
        assert entered.wait(2)
        result = client.post("/api/onvif/cancel", json={}, headers=HEADERS)
        assert result.status_code == 200 and result.json()["cancelled"]
        assert first.result(timeout=5).status_code == 499
    assert cancelled.is_set()
    async def quick_discover(interface_ip, timeout):
        return {"devices": [], "warnings": [], "duration": 0}
    monkeypatch.setattr(app_module, "discover", quick_discover)
    assert client.post("/api/onvif/discover", json={}, headers=HEADERS).status_code == 200


def test_all_stream_profiles_are_exported_only_to_logged_in_admin(client, monkeypatch):
    async def fake_profiles(endpoint, username, password):
        assert username == "camera-user" and password == "camera-password"
        return {"device": {"model": "Test Camera"}, "profiles": [
            {"token": "main", "role": "main", "url": "rtsp://camera-user:camera-password@192.168.1.20/main", "clean_url": "rtsp://192.168.1.20/main"},
            {"token": "sub", "role": "sub", "url": "rtsp://camera-user:camera-password@192.168.1.20/sub", "clean_url": "rtsp://192.168.1.20/sub"},
            {"token": "third", "role": "other", "url": None, "error": "URI non disponibile"}], "warnings": [], "success": True}
    monkeypatch.setattr(app_module, "get_profiles", fake_profiles)
    login(client)
    result = client.post("/api/onvif/profiles", json={"endpoint": "http://192.168.1.20/onvif/device_service", "username": "camera-user", "password": "camera-password"}, headers=HEADERS)
    assert result.status_code == 200
    assert len(result.json()["profiles"]) == 3
    assert result.json()["profiles"][0]["url"].startswith("rtsp://camera-user:")
    assert result.headers["cache-control"] == "no-store"


def test_only_scan_owning_session_can_cancel(client, monkeypatch):
    entered = threading.Event()
    async def slow_discover(interface_ip, timeout):
        entered.set()
        await asyncio.sleep(10)
    monkeypatch.setattr(app_module, "discover", slow_discover)
    login(client)
    owner = client.cookies.get("nvr_session")
    owner_headers = HEADERS | {"Cookie": f"nvr_session={owner}"}
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/api/onvif/discover", json={}, headers=owner_headers)
        assert entered.wait(2)
        login(client)  # A second administrator browser session.
        assert client.post("/api/onvif/cancel", json={}, headers=HEADERS).status_code == 409
        assert client.post("/api/logout", headers=HEADERS).status_code == 200
        assert not first.done()
        assert client.post("/api/onvif/cancel", json={}, headers=owner_headers).json()["cancelled"]
        assert first.result(timeout=5).status_code == 499


def test_logout_cancels_own_search(client, monkeypatch):
    entered = threading.Event()
    cancelled = threading.Event()
    async def slow_discover(interface_ip, timeout):
        try:
            entered.set()
            await asyncio.sleep(10)
        finally:
            cancelled.set()
    monkeypatch.setattr(app_module, "discover", slow_discover)
    login(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/api/onvif/discover", json={}, headers=HEADERS)
        assert entered.wait(2)
        assert client.post("/api/logout", headers=HEADERS).status_code == 200
        assert first.result(timeout=5).status_code == 499
    assert cancelled.is_set()


def test_device_error_does_not_echo_camera_password(client, monkeypatch):
    async def fake_profiles(*args):
        raise ValueError("device error rtsp://user:secret-password@camera/live")
    monkeypatch.setattr(app_module, "get_profiles", fake_profiles)
    login(client)
    result = client.post("/api/onvif/profiles", json={"endpoint": "http://camera/onvif/device_service"}, headers=HEADERS)
    assert result.status_code == 422 and "secret-password" not in result.text
