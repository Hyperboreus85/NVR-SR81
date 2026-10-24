import asyncio
import json
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.languages import (FORMAT, MAX_PACK_BYTES, LEGACY_METADATA_KEY, MIGRATION_METADATA_KEY,
                           LanguageError, LanguageManager, canonical_locale)
from nvr.store import Store

PASSWORD = "language-test-password-strong"
HEADERS = {"X-NVR-Request": "1"}
INSTALL = "/api/languages/install"
KEY = "Camera not found"
TEMPLATE_KEY = "Unable to read {service} profiles. {error}"


class NoCameraMedia:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store

    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass

    def camera_status(self, camera_id):
        return {"state": "stopped", "message": "Recording disabled", "last_segment_at": None}


def settings(directory, password=PASSWORD):
    return Settings(data_dir=directory / "data", recordings_dir=directory / "recordings", password=password)


def make_app(directory, password=PASSWORD):
    return create_app(settings(directory, password), media_factory=NoCameraMedia)


def pack(locale="fr", **changes):
    return {"format": FORMAT, "version": 1, "locale": locale, "name": "French", "native_name": "Français",
            "translations": {KEY: "Caméra introuvable"}} | changes


def login(client):
    assert client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS).status_code == 200


@pytest.fixture
def client(tmp_path):
    with TestClient(make_app(tmp_path)) as client:
        yield client


def test_included_languages_are_public_and_english_is_default(client, tmp_path):
    listing = client.get("/api/languages")
    assert listing.status_code == 200
    body = listing.json()
    assert body["default"] == body["fallback"] == "en"
    assert [item["locale"] for item in body["languages"]] == ["en", "it"]
    assert all(item["source"] == "included" and item["translated"] == item["total"] for item in body["languages"])
    english = client.get("/api/languages/en").json()
    italian = client.get("/api/languages/it").json()
    assert english["format"] == FORMAT and english["version"] == 1
    assert english["translations"][KEY] == KEY
    assert italian["translations"][KEY] == "Telecamera non trovata"
    assert str(tmp_path) not in listing.text and "password_hash" not in listing.text
    assert client.get("/api/languages/unknown").status_code == 401
    assert client.get("/api/languages/fr").status_code == 404


def test_only_public_get_routes_bypass_authentication_and_csrf(client):
    assert client.get("/api/languages/template").status_code == 401
    assert client.post(INSTALL, json=pack()).status_code == 403
    assert client.post(INSTALL, json=pack(), headers=HEADERS).status_code == 401
    assert client.delete("/api/languages/it", headers=HEADERS).status_code == 401
    login(client)
    assert client.post(INSTALL, json=pack()).status_code == 403
    assert client.post(INSTALL, json=pack(), headers=HEADERS | {"Origin": "https://external.invalid"}).status_code == 403
    assert client.get("/api/settings/translations").status_code == 404
    assert client.put("/api/settings/translations", json={}, headers=HEADERS).status_code == 404


def test_authenticated_template_is_a_complete_english_source_pack(client):
    login(client)
    template = client.get("/api/languages/template").json()
    assert template["locale"] == "xx" and template["name"] == "Language name"
    assert template["native_name"] == "Native language name"
    assert template["format"] == FORMAT and template["version"] == 1
    english = client.get("/api/languages/en").json()
    assert set(template["translations"]) == set(english["translations"])
    assert all(key == value for key, value in template["translations"].items())


def test_french_file_install_persistence_replacement_and_removal(tmp_path):
    app = make_app(tmp_path)
    first_pack = pack(locale="FR", translations={KEY: "Caméra introuvable", TEMPLATE_KEY: "Impossible de lire {service}. {error}"})
    with TestClient(app) as first:
        login(first)
        response = first.post(INSTALL, json=first_pack, headers=HEADERS)
        assert response.status_code == 200
        metadata = response.json()["language"]
        assert not response.json()["replaced"]
        assert metadata["locale"] == "fr" and metadata["source"] == "installed" and metadata["translated"] == 2
        assert metadata["total"] == len(first.get("/api/languages/en").json()["translations"])
        assert first.get("/api/languages/FR").json() == first_pack | {"locale": "fr"}
        assert (tmp_path / "data/languages/fr.json").is_file()
    with TestClient(make_app(tmp_path, password="")) as restarted:
        assert restarted.get("/api/languages/fr").json()["translations"][KEY] == "Caméra introuvable"
        login(restarted)
        replacement = pack(translations={KEY: "Caméra absente"})
        assert restarted.post(INSTALL, json=replacement, headers=HEADERS).json()["replaced"]
        assert restarted.get("/api/languages/fr").json()["translations"] == replacement["translations"]
        assert restarted.delete("/api/languages/fr", headers=HEADERS).json() == {"locale": "fr", "restored": False}
        assert restarted.get("/api/languages/fr").status_code == 404
    assert not (tmp_path / "data/languages/fr.json").exists()


def test_english_cannot_be_changed_and_removing_custom_italian_restores_included(client):
    included = client.get("/api/languages/it").json()
    login(client)
    english = client.get("/api/languages/en").json()
    assert client.post(INSTALL, json=english, headers=HEADERS).status_code == 403
    assert client.delete("/api/languages/en", headers=HEADERS).status_code == 403
    assert client.delete("/api/languages/it", headers=HEADERS).status_code == 404
    custom = pack("it", name="Italian", native_name="Italiano", translations={KEY: "Telecamera assente"})
    response = client.post(INSTALL, json=custom, headers=HEADERS)
    assert response.status_code == 200 and response.json()["replaced"]
    assert client.get("/api/languages/it").json() == custom
    assert client.delete("/api/languages/it", headers=HEADERS).json() == {"locale": "it", "restored": True}
    assert client.get("/api/languages/it").json() == included
    assert next(row for row in client.get("/api/languages").json()["languages"] if row["locale"] == "it")["source"] == "included"


@pytest.mark.parametrize("changes", [
    {"format": "unsupported"}, {"version": 2}, {"version": True},
    {"locale": "../fr"}, {"locale": "fr_FR"}, {"locale": "abcd"},
    {"locale": "fr-" + "x" * 9}, {"locale": "fr-" + "abc-" * 9 + "ab"},
    {"name": ""}, {"name": "   "}, {"native_name": "n" * 81}, {"native_name": None},
    {"translations": []}, {"translations": {"Unknown English key": "Texte"}},
    {"translations": {KEY: 7}}, {"translations": {KEY: None}}, {"translations": {KEY: "v" * 2001}},
    {"translations": {"k" * 501: "value"}}, {"translations": {TEMPLATE_KEY: "Missing placeholders"}},
    {"translations": {str(index): "value" for index in range(2001)}},
    {"password": "never-echo-this-password"},
])
def test_invalid_language_files_are_rejected_without_input_or_path_echo(client, tmp_path, changes):
    login(client)
    response = client.post(INSTALL, json=pack(**changes), headers=HEADERS)
    assert response.status_code == 422
    assert "never-echo-this-password" not in response.text and str(tmp_path) not in response.text
    assert client.get("/api/languages/fr").status_code == 404


def test_invalid_json_byte_limit_and_empty_translation_fallback(client):
    login(client)
    assert client.post(INSTALL, content=b'{"broken":', headers=HEADERS).status_code == 422
    duplicate = b'{"format":"nvr-sr81.language-pack","format":"other"}'
    assert client.post(INSTALL, content=duplicate, headers=HEADERS).status_code == 422
    assert client.post(INSTALL, content=b" " * (MAX_PACK_BYTES + 1), headers=HEADERS).status_code == 413
    payload = pack(translations={KEY: "", TEMPLATE_KEY: ""})
    response = client.post(INSTALL, json=payload, headers=HEADERS)
    assert response.status_code == 200 and response.json()["language"]["translated"] == 0
    assert client.get("/api/languages/fr").json()["translations"] == payload["translations"]


def test_atomic_failed_replacement_preserves_file_and_active_pack(client, tmp_path, monkeypatch):
    import nvr.languages as module
    login(client)
    original = pack()
    assert client.post(INSTALL, json=original, headers=HEADERS).status_code == 200
    path = tmp_path / "data/languages/fr.json"
    before = path.read_bytes()

    def fail(*args):
        raise OSError("never-expose-private-path-or-credentials")

    monkeypatch.setattr(module.os, "replace", fail)
    response = client.post(INSTALL, json=pack(translations={KEY: "Replacement"}), headers=HEADERS)
    assert response.status_code == 503 and response.json() == {"detail": "Unable to save the language pack."}
    assert path.read_bytes() == before
    assert client.get("/api/languages/fr").json() == original
    assert not list(path.parent.glob(".language-*.tmp"))


def test_legacy_overrides_migrate_known_valid_keys_once_and_keep_sqlite_entry(tmp_path):
    configured = settings(tmp_path)
    store = Store(configured.data_dir)
    legacy = json.dumps({"locale": "it", "overrides": {KEY: "Legacy custom wording", "Unknown key": "skip", TEMPLATE_KEY: "Missing placeholders"}})
    store.meta_set(LEGACY_METADATA_KEY, legacy)
    app = create_app(configured, media_factory=NoCameraMedia)
    with TestClient(app) as first:
        result = first.get("/api/languages/it").json()
        assert result["translations"][KEY] == "Legacy custom wording"
        assert "Unknown key" not in result["translations"]
        assert "{service}" in result["translations"][TEMPLATE_KEY]
        assert store.meta_get(LEGACY_METADATA_KEY) == legacy
        assert store.meta_get(MIGRATION_METADATA_KEY) == "1"
        login(first)
        assert first.delete("/api/languages/it", headers=HEADERS).json()["restored"]
    with TestClient(make_app(tmp_path, password="")) as restarted:
        assert restarted.get("/api/languages/it").json()["translations"][KEY] == "Telecamera non trovata"
        assert store.meta_get(LEGACY_METADATA_KEY) == legacy


@pytest.mark.asyncio
async def test_streamed_language_upload_cannot_write_after_logout(tmp_path):
    app = make_app(tmp_path)
    reached_body, resume_body = asyncio.Event(), asyncio.Event()
    serialized = json.dumps(pack()).encode()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        assert (await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)).status_code == 200

        async def streamed_body():
            yield serialized[:20]
            reached_body.set()
            await resume_body.wait()
            yield serialized[20:]

        pending = asyncio.create_task(client.post(INSTALL, content=streamed_body(), headers=HEADERS))
        try:
            await asyncio.wait_for(reached_body.wait(), 5)
            assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200
            resume_body.set()
            response = await asyncio.wait_for(pending, 5)
            assert response.status_code == 401 and response.json()["detail"] == "Authentication required"
            assert (await client.get("/api/languages/fr")).status_code == 404
            assert not (tmp_path / "data/languages/fr.json").exists()
        finally:
            resume_body.set()
            if not pending.done():
                pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)


def test_canonical_locale_and_returned_pack_isolation(client):
    assert canonical_locale("PT-br") == "pt-BR"
    assert canonical_locale("ZH-hans-cn") == "zh-Hans-CN"
    with pytest.raises(LanguageError):
        canonical_locale("fr/../../private")
    manager = client.app.state.languages
    returned = manager.get("en")
    returned["translations"][KEY] = "Modified outside manager"
    assert manager.get("en")["translations"][KEY] == KEY
