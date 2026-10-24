import asyncio
import json
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
import pytest

from nvr.app import create_app, MAX_TRANSLATION_BYTES, TRANSLATION_METADATA_KEY
from nvr.config import Settings


PASSWORD = "settings-test-password-strong"
HEADERS = {"X-NVR-Request": "1"}
PATH = "/api/settings/translations"


class NoCameraMedia:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store

    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass

    def camera_status(self, camera_id):
        return {"state": "stopped", "message": "Recording disabled", "last_segment_at": None}


def make_app(directory, password=PASSWORD):
    return create_app(Settings(data_dir=directory / "data", recordings_dir=directory / "recordings", password=password),
                      media_factory=NoCameraMedia)


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


@pytest.fixture
def client(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        yield client


def test_settings_require_authentication_csrf_and_same_origin(client):
    payload = {"locale": "it", "overrides": {}}
    response = client.get(PATH)
    assert response.status_code == 401 and response.json()["detail"] == "Authentication required"
    assert client.put(PATH, json=payload, headers=HEADERS).status_code == 401
    login(client)
    response = client.put(PATH, json=payload)
    assert response.status_code == 403 and response.json()["detail"] == "Invalid request"
    assert client.put(PATH, json=payload, headers=HEADERS | {"Origin": "https://external.invalid"}).status_code == 403
    assert client.get(PATH).json() == payload


def test_translation_replacement_persists_across_restart_and_reset_is_complete(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as first:
        login(first)
        assert first.get(PATH).json() == {"locale": "it", "overrides": {}}
        original_hash = app.state.store.meta_get("password_hash")
        first_payload = {"locale": "it", "overrides": {"Camera not found": "Telecamera assente", "Enter a name": "Inserisci un nome"}}
        assert first.put(PATH, json=first_payload, headers=HEADERS).json() == first_payload
        replacement = {"locale": "it", "overrides": {"Camera not found": "Nessuna telecamera"}}
        assert first.put(PATH, json=replacement, headers=HEADERS).json() == replacement
        assert app.state.store.meta_get("password_hash") == original_hash
        assert json.loads(app.state.store.meta_get(TRANSLATION_METADATA_KEY)) == replacement
    with TestClient(make_app(tmp_path, password="")) as restarted:
        login(restarted)
        assert restarted.get(PATH).json() == replacement
        reset = {"locale": "it", "overrides": {}}
        assert restarted.put(PATH, json=reset, headers=HEADERS).json() == reset
    with TestClient(make_app(tmp_path, password="")) as reset_app:
        login(reset_app)
        assert reset_app.get(PATH).json() == {"locale": "it", "overrides": {}}


@pytest.mark.parametrize("payload", [
    {"locale": "en", "overrides": {}},
    {"locale": "fr", "overrides": {}},
    {"locale": "it", "overrides": {"": "value"}},
    {"locale": "it", "overrides": {"   ": "value"}},
    {"locale": "it", "overrides": {"k" * 501: "value"}},
    {"locale": "it", "overrides": {"key": "v" * 2001}},
    {"locale": "it", "overrides": {"key": 7}},
    {"locale": "it", "overrides": {"key": None}},
    {"locale": "it", "overrides": {"key": ["value"]}},
    {"locale": "it", "overrides": []},
    {"locale": "it", "overrides": {str(index): "value" for index in range(1001)}},
    {"locale": "it", "overrides": {}, "password": "never-echo-this-password"},
])
def test_invalid_translation_settings_are_rejected_without_echoing_input(client, payload):
    login(client)
    response = client.put(PATH, json=payload, headers=HEADERS)
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid translation settings."}
    assert "never-echo-this-password" not in response.text
    assert client.get(PATH).json() == {"locale": "it", "overrides": {}}


def test_body_size_is_bounded_before_json_parsing_and_failed_write_preserves_settings(client):
    login(client)
    saved = {"locale": "it", "overrides": {"Live view unavailable.": "Diretta non disponibile."}}
    assert client.put(PATH, json=saved, headers=HEADERS).status_code == 200
    oversized = b" " * MAX_TRANSLATION_BYTES + b'{"password":"never-echo-this-password"}'
    response = client.put(PATH, content=oversized, headers=HEADERS | {"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json() == {"detail": "Translation settings are too large."}
    assert "never-echo-this-password" not in response.text
    assert client.get(PATH).json() == saved


def test_translation_values_are_plain_text_and_limits_accept_boundary_lengths(client):
    login(client)
    payload = {"locale": "it", "overrides": {"k" * 500: "v" * 2000, "Literal markup": '<img src=x onerror="alert(1)">', "Empty": ""}}
    response = client.put(PATH, json=payload, headers=HEADERS)
    assert response.status_code == 200 and response.json() == payload
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get(PATH).json() == payload


def test_api_error_messages_are_english_source_even_with_italian_override(client):
    login(client)
    payload = {"locale": "it", "overrides": {"Camera not found": "Telecamera assente"}}
    assert client.put(PATH, json=payload, headers=HEADERS).status_code == 200
    response = client.post("/api/cameras/missing/probe", headers=HEADERS)
    assert response.status_code == 404 and response.json()["detail"] == "Camera not found"
    invalid = client.post("/api/cameras", json={"name": "Test", "url": "file:///private/path"}, headers=HEADERS)
    assert invalid.status_code == 422
    assert invalid.json()["detail"] == "Enter a valid RTSP, RTSPS, HTTP or HTTPS URL"


def test_server_catalog_contains_api_errors_and_stable_dynamic_templates():
    source = (Path(__file__).parents[1] / "nvr/static/locales-server.js").read_text(encoding="utf-8")
    payload = json.loads(source.split(".push(", 1)[1].rsplit(");", 1)[0])
    italian = payload["it"]
    assert italian["Camera not found"] == "Telecamera non trovata"
    assert italian["Translation settings are too large."] == "Le impostazioni di traduzione sono troppo grandi."
    assert italian["Unable to read {service} profiles. {error}"] == "Impossibile leggere i profili {service}. {error}"
    assert "The camera reports more than {count} Media services: list truncated." in italian
    assert "Multicast discovery unavailable on interface {address}." in italian


@pytest.mark.asyncio
async def test_streamed_translation_upload_cannot_write_after_logout(tmp_path):
    app = make_app(tmp_path)
    reached_body = asyncio.Event()
    resume_body = asyncio.Event()
    saved = {"locale": "it", "overrides": {"Camera not found": "Saved before logout"}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)).status_code == 200
        assert (await client.put(PATH, json=saved, headers=HEADERS)).status_code == 200

        async def streamed_body():
            yield b'{"locale":"it","overrides":'
            reached_body.set()
            await resume_body.wait()
            yield b'{"Camera not found":"Changed after logout"}}'

        pending = asyncio.create_task(client.put(PATH, content=streamed_body(),
            headers=HEADERS | {"Content-Type": "application/json"}))
        try:
            await asyncio.wait_for(reached_body.wait(), 5)
            assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200
            resume_body.set()
            response = await asyncio.wait_for(pending, 5)
            assert response.status_code == 401
            assert response.json() == {"detail": "Authentication required"}
            assert json.loads(app.state.store.meta_get(TRANSLATION_METADATA_KEY)) == saved
        finally:
            resume_body.set()
            if not pending.done():
                pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
