"""All searches and video probes are fakes; these tests never inspect a LAN."""
import asyncio
from types import SimpleNamespace

import httpx
import pytest

from nvr import app as module
from nvr import network_scan
from nvr.app import create_app
from nvr.config import Settings

HEADERS = {"X-NVR-Request": "1"}
PASSWORD = "network-fixture-password-2026"


class Media:
    def __init__(self, settings, store):
        self.calls = []
    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass
    async def probe(self, source):
        self.calls.append(source)
        return {"video_codec": "h264", "audio_codec": "aac", "width": 1920, "height": 1080,
                "duration": 0, "url": source, "streams": [{"private": source}]}


def application(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", password=PASSWORD)
    app = create_app(settings, media_factory=Media)
    for username, permissions in (("operator", ["network"]), ("viewer", ["live"])):
        app.state.auth.accounts.create({"username": username, "password": PASSWORD, "permissions": permissions}, "builtin-admin")
    return app


async def login(client, username="operator"):
    result = await client.post("/api/login", json={"username": username, "password": PASSWORD}, headers=HEADERS)
    assert result.status_code == 200


def device():
    return {"id": "fixture-camera", "ip": "192.0.2.10", "endpoint": "", "xaddrs": [], "name": "Fixture",
            "services": [{"protocol": "rtsp", "host": "192.0.2.10", "port": 554,
                          "url": "rtsp://192.0.2.10:554/", "status": "authentication_required", "stream_path_known": False}], "methods": ["rtsp"]}


async def test_network_routes_require_network_access_and_saved_targets_never_scan(tmp_path, monkeypatch):
    app = application(tmp_path)
    monkeypatch.setattr(module, "scan_targets", lambda *a, **k: pytest.fail("Saving a target must never scan"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/api/network/targets")).status_code == 401
        await login(client, "viewer")
        for path in ("/api/network/targets", "/api/network/status"):
            assert (await client.get(path)).status_code == 403
        for path, body in (("/api/network/search", {}), ("/api/network/probe", {"url": "rtsp://camera.example/live"}),
                           ("/api/network/targets", {"name": "Site", "address": "192.168.20.0/24"})):
            assert (await client.post(path, json=body, headers=HEADERS)).status_code == 403
        await login(client)
        assert (await client.get("/api/network/targets")).json()["targets"] == []
        saved = await client.post("/api/network/targets", json={"name": "Other site", "address": "192.168.20.25/24"}, headers=HEADERS)
        assert saved.status_code == 201 and saved.headers["cache-control"] == "no-store"
        row = saved.json()["targets"][0]
        assert row["address"] == "192.168.20.0/24"
        assert (await client.get("/api/network/targets")).json()["targets"] == [row]
        assert (await client.delete("/api/network/targets/" + row["id"], headers=HEADERS)).json()["targets"] == []
        invalid = await client.post("/api/network/targets", json={"name": "Bad", "address": "http://user:private-secret@host/"}, headers=HEADERS)
        assert invalid.status_code == 422 and "private-secret" not in invalid.text
        assert app.state.store.list_cameras() == []


async def test_directed_search_returns_only_verified_services_with_real_progress(tmp_path, monkeypatch):
    app = application(tmp_path)
    calls = []
    async def fake(targets, methods, onvif, rtsp, rtsps, **options):
        calls.append((targets, methods, onvif, rtsp, rtsps))
        options["progress"]({"state": "running", "completed": 1, "total": 3, "devices": [device()], "warnings": []})
        return {"devices": [device()], "warnings": ["The search reached its time limit. Some addresses were not checked."], "completed": 2, "total": 3, "partial": True}
    monkeypatch.setattr(module, "scan_targets", fake)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/network/search", json={"mode": "targets", "request_id": "fixture-job", "targets": ["camera.example", "192.168.20.0/24"], "methods": ["onvif", "rtsp"]}, headers=HEADERS)
        assert response.status_code == 200
        value = response.json()
        assert value["state"] == "complete" and value["partial"] is True and value["completed"] == 2 and value["total"] == 3
        assert value["devices"][0]["services"][0]["stream_path_known"] is False
        assert calls == [(["camera.example", "192.168.20.0/24"], ["onvif", "rtsp"], [80, 8000, 8080, 8899], [554, 8554], [322])]
        assert (await client.get("/api/network/status?request_id=fixture-job")).json()["state"] == "complete"
        assert (await client.get("/api/network/status?request_id=stale-job")).json()["devices"] == []


async def test_search_progress_and_cancellation_are_owned_by_one_session(tmp_path, monkeypatch):
    app = application(tmp_path)
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def slow(*args, **options):
        options["progress"]({"state": "running", "completed": 1, "total": 4, "devices": [device()], "warnings": []})
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr(module, "scan_targets", slow)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as owner, httpx.AsyncClient(transport=transport, base_url="http://test") as other:
        await login(owner); await login(other)
        body = {"mode": "targets", "request_id": "owned-job", "targets": ["192.168.20.10"], "methods": ["rtsp"]}
        job = asyncio.create_task(owner.post("/api/network/search", json=body, headers=HEADERS))
        await asyncio.wait_for(entered.wait(), 3)
        progress = (await owner.get("/api/network/status?request_id=owned-job")).json()
        assert progress["completed"] == 1 and len(progress["devices"]) == 1
        assert (await other.get("/api/network/status?request_id=owned-job")).json()["devices"] == []
        assert (await other.post("/api/network/cancel", json={}, headers=HEADERS)).status_code == 409
        assert (await other.post("/api/network/search", json=body, headers=HEADERS)).status_code == 409
        assert (await owner.post("/api/network/cancel", json={}, headers=HEADERS)).json()["cancelled"] is True
        assert (await asyncio.wait_for(job, 3)).status_code == 499 and cancelled.is_set()


async def test_local_methods_merge_advertisements_without_opening_video(tmp_path, monkeypatch):
    app = application(tmp_path)
    async def onvif(*args):
        return {"devices": [device() | {"endpoint": "http://192.0.2.10/onvif/device_service", "xaddrs": ["http://192.0.2.10/onvif/device_service"], "services": []}], "warnings": []}
    async def mdns(*args): return {"devices": [device()], "warnings": []}
    monkeypatch.setattr(module, "discover", onvif); monkeypatch.setattr(module, "discover_mdns", mdns)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/network/search", json={"mode": "local", "methods": ["onvif", "mdns"]}, headers=HEADERS)
        assert response.status_code == 200
        value = response.json()
        assert value["completed"] == value["total"] == 2 and len(value["devices"]) == 1
        assert {service["protocol"] for service in value["devices"][0]["services"]} == {"onvif", "rtsp"}
        assert app.state.media.calls == []


async def test_known_video_probe_never_returns_urls_or_ffprobe_payloads(tmp_path):
    app = application(tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        source = "rtsp://fixture-user:private-secret@camera.example/live?token=private-token"
        result = await client.post("/api/network/probe", json={"url": source}, headers=HEADERS)
        assert result.status_code == 200 and result.json()["verified"] is True and result.json()["width"] == 1920
        assert set(result.json()) == {"verified", "video_codec", "audio_codec", "width", "height", "duration"}
        assert "private" not in result.text and app.state.media.calls == [source]
        invalid = await client.post("/api/network/probe", json={"url": "file:///private-secret"}, headers=HEADERS)
        assert invalid.status_code == 422 and "private-secret" not in invalid.text


async def test_explicit_onvif_remote_overrides_reach_the_importer_and_stay_opt_in(tmp_path, monkeypatch):
    app = application(tmp_path)
    calls = []
    async def fake(endpoint, username, password, **options):
        calls.append((endpoint, username, password, options))
        return {"profiles": [], "warnings": [], "success": False}
    monkeypatch.setattr(module, "get_profiles", fake)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        basic = {"endpoint": "https://camera.example:8443/onvif/device_service", "username": "fixture-user", "password": "fixture-camera-password"}
        assert (await client.post("/api/onvif/profiles", json=basic, headers=HEADERS)).status_code == 200
        assert calls[-1][3] == {}
        override = basic | {"stream_host": "camera.example", "stream_port": 18554, "use_endpoint_address": True}
        assert (await client.post("/api/onvif/profiles", json=override, headers=HEADERS)).status_code == 200
        assert calls[-1][3] == {"stream_host": "camera.example", "stream_port": 18554, "use_endpoint_address": True}
        assert (await client.post("/api/onvif/profiles", json=override | {"stream_port": True}, headers=HEADERS)).status_code == 422


async def test_search_watcher_stops_a_revoked_session_and_releases_the_scan_slot(tmp_path, monkeypatch):
    app = application(tmp_path)
    entered, cancelled = asyncio.Event(), asyncio.Event()
    calls = []
    async def search(*args, **options):
        calls.append(args)
        if len(calls) > 1:
            return {"devices": [], "warnings": [], "completed": 1, "total": 1, "partial": False}
        options["progress"]({"state": "running", "completed": 0, "total": 1, "devices": [device()], "warnings": []})
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    monkeypatch.setattr(module, "scan_targets", search)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as owner, httpx.AsyncClient(transport=transport, base_url="http://test") as other:
        await login(owner); await login(other)
        body = {"mode": "targets", "request_id": "revoked-job", "targets": ["192.168.20.10"], "methods": ["rtsp"]}
        pending = asyncio.create_task(owner.post("/api/network/search", json=body, headers=HEADERS))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            app.state.auth.logout(owner.cookies.get("nvr_session"))
            # Production watcher is one second; wait on its observable outcome.
            response = await asyncio.wait_for(pending, 4)
            assert response.status_code == 401 and cancelled.is_set()
            assert "Fixture" not in response.text and "services" not in response.text
            assert (await owner.get("/api/network/status?request_id=revoked-job")).status_code == 401
            hidden = await other.get("/api/network/status?request_id=revoked-job")
            assert hidden.json()["state"] == "idle" and hidden.json()["devices"] == []
            subsequent = await other.post("/api/network/search", json=body | {"request_id": "replacement-job"}, headers=HEADERS)
            assert subsequent.status_code == 200 and len(calls) == 2
            assert subsequent.json()["state"] == "complete"
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)


async def test_probe_permission_revoked_while_awaiting_media_returns_no_metadata(tmp_path):
    app = application(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    original_probe = app.state.media.probe
    async def probe(source):
        entered.set()
        await release.wait()
        return await original_probe(source)
    app.state.media.probe = probe
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        pending = asyncio.create_task(client.post("/api/network/probe", json={
            "url": "rtsp://fixture-user:private-secret@camera.example/private-path?token=private-token"}, headers=HEADERS))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            operator = app.state.auth.accounts.by_username("operator")
            app.state.auth.accounts.update(operator["id"], {"permissions": []}, "builtin-admin")
            release.set()
            response = await asyncio.wait_for(pending, 3)
            assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
            assert set(response.json()) == {"detail"}
            assert all(value not in response.text for value in ("private", "1920", "h264", "streams", "video_codec"))
            assert len(app.state.media.calls) == 1
            await login(client)
            assert (await client.post("/api/network/probe", json={"url": "rtsp://camera.example/live"}, headers=HEADERS)).status_code == 403
            assert len(app.state.media.calls) == 1
        finally:
            release.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.parametrize("body", [
    {"mode": "local", "methods": ["rtsp"]},
    {"mode": "local", "methods": ["onvif"], "targets": ["192.168.20.10"]},
    {"mode": "targets", "methods": ["mdns"], "targets": ["192.168.20.10"]},
    {"mode": "targets", "methods": ["rtsp"], "targets": []},
    {"mode": "targets", "methods": ["http"], "targets": ["192.168.20.10"]},
    {"mode": "targets", "methods": ["rtsp"], "targets": ["192.168.20.10"], "rtsp_ports": [True]},
])
async def test_incompatible_modes_and_invalid_protocols_are_rejected_before_starting_any_worker(tmp_path, monkeypatch, body):
    app = application(tmp_path)
    async def forbidden(*args, **kwargs): pytest.fail("Invalid search must not start discovery or a media probe")
    monkeypatch.setattr(module, "discover", forbidden)
    monkeypatch.setattr(module, "discover_mdns", forbidden)
    monkeypatch.setattr(module, "scan_targets", forbidden)
    app.state.media.probe = forbidden
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/network/search", json=body | {"request_id": "invalid-job"}, headers=HEADERS)
        assert response.status_code == 422 and response.headers["cache-control"] == "no-store"
        status = (await client.get("/api/network/status?request_id=invalid-job")).json()
        assert status["state"] == "idle" and status["devices"] == []


@pytest.mark.parametrize("target", ["8.8.8.0/24", "10.0.0.0/16", "2001:4860::/64"])
async def test_broad_or_public_subnets_are_rejected_before_dns_expansion_or_service_probes(tmp_path, monkeypatch, target):
    app = application(tmp_path)
    async def forbidden(*args, **kwargs): pytest.fail("Rejected subnet must not resolve or probe hosts")
    monkeypatch.setattr(network_scan, "_expand_targets", forbidden)
    monkeypatch.setattr(network_scan, "_verify_endpoint", forbidden)
    monkeypatch.setattr(network_scan, "_probe_rtsp", forbidden)
    app.state.media.probe = forbidden
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        response = await client.post("/api/network/search", json={"mode": "targets", "targets": [target], "methods": ["rtsp"]}, headers=HEADERS)
        assert response.status_code == 422 and "devices" not in response.json()
        assert app.state.media.calls == []


async def test_validation_never_echoes_a_private_stream_url_or_unknown_field_value(tmp_path, monkeypatch):
    app = application(tmp_path)
    async def forbidden(*args, **kwargs): pytest.fail("Invalid schema must not start a search")
    monkeypatch.setattr(module, "scan_targets", forbidden)
    private = "rtsp://fixture-user:private-secret@camera.example/private-path?token=private-token"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        for path, body in (("/api/network/search", {"mode": "targets", "targets": [private], "unknown": private}),
                           ("/api/network/probe", {"url": private, "unknown": private})):
            response = await client.post(path, json=body, headers=HEADERS)
            assert response.status_code == 422 and response.headers["cache-control"] == "no-store"
            assert all(value not in response.text for value in ("private-secret", "private-token", "private-path", "fixture-user"))
        assert app.state.media.calls == []


async def test_new_login_does_not_inherit_previous_session_search_results(tmp_path, monkeypatch):
    app = application(tmp_path)
    async def search(*args, **kwargs):
        return {"devices": [device()], "warnings": [], "completed": 1, "total": 1, "partial": False}
    monkeypatch.setattr(module, "scan_targets", search)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await login(client)
        result = await client.post("/api/network/search", json={"mode": "targets", "request_id": "previous-login", "targets": ["192.168.20.10"], "methods": ["rtsp"]}, headers=HEADERS)
        assert result.status_code == 200 and result.json()["devices"]
        old_token = client.cookies.get("nvr_session")
        app.state.auth.logout(old_token)
        await login(client)
        assert client.cookies.get("nvr_session") != old_token
        status = await client.get("/api/network/status?request_id=previous-login")
        assert status.status_code == 200 and status.json()["state"] == "idle" and status.json()["devices"] == []
