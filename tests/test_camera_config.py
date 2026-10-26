"""Structured camera editing preserves private URLs without sending secrets back."""
import asyncio
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
import pytest

from nvr.camera_config import preview_stream_url, public_camera_connection, resolve_camera_streams
from nvr.live import LiveManager, _Hub
from nvr.media import MediaManager, _Worker
from nvr.security import redact_url, validate_camera_host, validate_stream_url
from nvr.store import Store


def previous():
    return {"url": "rtsp://alice:p%40ss%3Aword@192.168.1.20/main?token=main-secret",
            "preview_url": "rtsp://bob:sub-secret@192.168.1.20/sub?auth=sub-token",
            "third_url": "http://third:third-password@192.168.1.20:80/third?password=third-token",
            "live_stream": 2}


def connection(**updates):
    return {"protocol": "rtsp", "host": "192.168.1.21", "port": 554,
            "username": None, "password": None, **updates}


@pytest.mark.parametrize("host,expected", [("192.168.1.20", "192.168.1.20"), ("camera.local", "camera.local"),
                                          ("CAMERA", "camera"), ("[2001:db8::1]", "2001:db8::1"),
                                          ("2001:db8::abcd", "2001:db8::abcd"), ("càmera.local", "xn--cmera-rqa.local")])
def test_connection_host_accepts_real_ip_addresses_ipv6_and_dns(host, expected):
    assert validate_camera_host(host) == expected


@pytest.mark.parametrize("host", ["", "http://camera", "camera:554", "host/path", "user@host", "999.2.3.4", "192.168.1.01",
                                  "bad host", "-camera.local", "camera..local", "[::1", "host?token=secret", "host\nname"])
def test_invalid_camera_hosts_are_rejected_without_echoing_input(host):
    with pytest.raises(ValueError) as caught:
        validate_camera_host(host)
    assert str(caught.value) == "Enter a valid camera IP address or hostname."


def test_structured_create_encodes_userinfo_once_and_builds_three_streams():
    result = resolve_camera_streams({"connection": connection(host="[2001:db8::1]", username="user@local", password="p:@/é"),
                                     "streams": {"main": "/main?channel=1", "sub": "/sub", "third": "/third"}, "live_stream": 3})
    assert result["url"] == "rtsp://user%40local:p%3A%40%2F%C3%A9@[2001:db8::1]:554/main?channel=1"
    assert result["third_url"].endswith("/third") and result["live_stream"] == 3
    assert preview_stream_url(result) == result["third_url"]


def test_host_and_path_edits_keep_passwords_and_private_queries_without_disclosing_them():
    shared = {**previous(), "preview_url": "rtsp://alice:p%40ss%3Aword@192.168.1.20/sub?auth=sub-token"}
    result = resolve_camera_streams({"connection": connection(), "streams": {"main": "/new-main", "sub": None}}, shared)
    assert result["url"] == "rtsp://alice:p%40ss%3Aword@192.168.1.21:554/new-main?token=main-secret"
    assert result["preview_url"] == "rtsp://alice:p%40ss%3Aword@192.168.1.21:554/sub?auth=sub-token"
    # Different full-URL endpoints preserve their own protocol/host/port.
    assert result["third_url"] == previous()["third_url"]
    cleared = resolve_camera_streams({"connection": connection(username="", password=""), "streams": {"main": "/new?"}}, previous())
    assert urlsplit(cleared["url"]).username is None and urlsplit(cleared["url"]).query == ""
    assert cleared["third_url"] == previous()["third_url"]


def test_shared_password_edits_preserve_independent_stream_authority_and_userinfo():
    old = previous()
    result = resolve_camera_streams({"connection": connection(password="new-main-password")}, old)
    assert "new-main-password" in result["url"] and "token=main-secret" in result["url"]
    assert result["preview_url"] == old["preview_url"]
    assert result["third_url"] == old["third_url"]
    shared = resolve_camera_streams({"connection": connection(), "streams": {"sub": "/new-shared-sub?"}}, old)
    assert shared["preview_url"] == "rtsp://alice:p%40ss%3Aword@192.168.1.21:554/new-shared-sub"


def test_new_optional_path_inherits_main_userinfo_but_not_its_stream_query():
    old = {**previous(), "preview_url": ""}
    result = resolve_camera_streams({"streams": {"sub": "/new-sub"}}, old)
    assert result["preview_url"] == "rtsp://alice:p%40ss%3Aword@192.168.1.20/new-sub"


def test_absolute_url_overrides_ignore_shared_connection_and_legacy_urls_still_work():
    urls = {"main": "http://user:secret@proxy.local/hls.m3u8?token=hidden", "sub": "https://proxy.local/mjpeg", "third": "rtsps://camera.local/third"}
    result = resolve_camera_streams({"connection": None, "streams": urls})
    assert result == {"url": urls["main"], "preview_url": urls["sub"], "third_url": urls["third"], "live_stream": 2}
    result = resolve_camera_streams({"connection": connection(), "streams": {"main": urls["main"]}}, previous())
    assert result["url"] == urls["main"]
    assert resolve_camera_streams({"url": urls["main"], "preview_url": urls["sub"]})["url"] == urls["main"]
    assert resolve_camera_streams({"url": None}, previous()) == previous()


@pytest.mark.parametrize("port", [0, -1, 65536, True, "554", 554.5])
def test_port_is_strict_integer_in_valid_network_range(port):
    with pytest.raises(ValueError, match="port must be between"):
        resolve_camera_streams({"connection": connection(port=port), "streams": {"main": "/main"}})


@pytest.mark.parametrize("value", ["file:///etc/passwd", "udp://239.1.2.3:1234", "rtsp://host:0/main", "http://host:65536/main", "http://host/#secret"])
def test_full_stream_urls_reject_unsafe_protocols_ports_and_fragments(value):
    with pytest.raises(ValueError):
        validate_stream_url(value)


def test_optional_stream_clear_and_live_selection_have_explicit_safe_semantics():
    result = resolve_camera_streams({"streams": {"sub": "", "third": ""}}, previous())
    assert result["preview_url"] == result["third_url"] == ""
    assert preview_stream_url(result) == result["url"]
    for value in [0, 4, True, "3"]:
        with pytest.raises(ValueError, match="Choose Main, Sub or Third"):
            resolve_camera_streams({"live_stream": value}, previous())
    with pytest.raises(ValueError, match="Configure the Third stream"):
        resolve_camera_streams({"live_stream": 3, "third_url": ""}, previous())
    with pytest.raises(ValueError, match="main stream"):
        resolve_camera_streams({"url": ""}, previous())
    for selected, field in [(1, "url"), (2, "preview_url"), (3, "third_url")]:
        assert preview_stream_url({**previous(), "live_stream": selected}) == previous()[field]


def test_public_editing_metadata_never_contains_userinfo_paths_or_queries():
    camera = previous()
    safe = public_camera_connection(camera)
    assert safe["connection"] == {"protocol": "rtsp", "host": "192.168.1.20", "port": 554, "has_username": True, "has_password": True}
    assert safe["streams"] == {"main": {"configured": True, "independent": False},
                               "sub": {"configured": True, "independent": True}, "third": {"configured": True, "independent": True}}
    text = json.dumps(safe)
    for secret in ["alice", "p%40ss", "main-secret", "sub-secret", "third-password", "third-token", "/main", "/third"]:
        assert secret not in text
    assert "third-password" not in redact_url(camera["third_url"])


def camera_values(**extra):
    return {"name": "Camera", "url": previous()["url"], "preview_url": previous()["preview_url"],
            "enabled": True, "audio_mode": "copy", "retention_days": 7, **extra}


def test_store_third_stream_is_encrypted_and_preserved_when_legacy_fields_are_saved(tmp_path):
    store = Store(tmp_path)
    camera = store.save_camera(camera_values(third_url=previous()["third_url"], live_stream=3))
    assert camera["third_url"] == previous()["third_url"] and camera["live_stream"] == 3
    store.save_camera(camera_values(name="Renamed"), camera["id"])
    assert Store(tmp_path).get_camera(camera["id"])["third_url"] == previous()["third_url"]
    assert store.get_camera(camera["id"])["live_stream"] == 3
    with store.connect() as db:
        assert len(db.execute("PRAGMA table_info(cameras)").fetchall()) == 8
        encrypted = db.execute("SELECT third_url FROM camera_extras").fetchone()[0]
        assert encrypted != previous()["third_url"]
        assert store.cipher.decrypt(encrypted.encode()).decode() == previous()["third_url"]
    for path in tmp_path.glob("nvr.sqlite3*"):
        assert b"third-password" not in path.read_bytes() and b"third-token" not in path.read_bytes()
    store.delete_camera(camera["id"])
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM camera_extras").fetchone()[0] == 0


def test_legacy_database_and_old_eight_column_insert_remain_compatible(tmp_path):
    key = Fernet.generate_key(); cipher = Fernet(key); (tmp_path / "credentials.key").write_bytes(key)
    with sqlite3.connect(tmp_path / "nvr.sqlite3") as db:
        db.execute("CREATE TABLE cameras (id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,preview_url TEXT NOT NULL,enabled INTEGER NOT NULL,audio_mode TEXT NOT NULL,retention_days INTEGER NOT NULL,created_at REAL NOT NULL)")
        db.execute("INSERT INTO cameras VALUES (?,?,?,?,?,?,?,?)", ("old", "Old", cipher.encrypt(b"rtsp://camera/main").decode(), cipher.encrypt(b"").decode(), 1, "copy", 7, 1))
    store = Store(tmp_path)
    assert store.get_camera("old")["third_url"] == "" and store.get_camera("old")["live_stream"] == 2
    store.save_camera(camera_values(third_url=previous()["third_url"], live_stream=3), "old")
    with store.connect() as db:
        # An old binary still writes exactly the original eight camera columns.
        db.execute("INSERT INTO cameras VALUES (?,?,?,?,?,?,?,?)", ("from-old-binary", "Old binary", cipher.encrypt(b"rtsp://camera/main").decode(), cipher.encrypt(b"").decode(), 1, "copy", 7, 2))
        assert len(dict(db.execute("SELECT * FROM cameras WHERE id='old'").fetchone())) == 8
    assert store.get_camera("from-old-binary")["live_stream"] == 2
    assert store.get_camera("old")["third_url"] == previous()["third_url"]


@pytest.mark.asyncio
async def test_live_commands_and_snapshots_select_third_while_recorder_uses_main(tmp_path):
    from nvr.config import Settings
    settings = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings", min_free_bytes=0)
    camera = {"id": "camera", **previous(), "live_stream": 3, "audio_mode": "copy"}
    live = LiveManager(settings)
    command = live._command(_Hub(camera, "copy"))
    assert command[command.index("-i") + 1] == camera["third_url"]
    assert live._signature(camera)[0] == camera["third_url"]
    assert live._signature({**camera, "live_stream": 1})[0] == camera["url"]
    media = MediaManager(settings, SimpleNamespace())
    media._capture = AsyncMock(return_value=b"\xff\xd8jpeg\xff\xd9")
    await media.snapshot(camera)
    snapshot = media._capture.call_args.args[0]
    assert snapshot[snapshot.index("-i") + 1] == camera["third_url"]
    started = asyncio.Event(); captured = []

    async def wait():
        await asyncio.Future()

    async def spawn(*args, **kwargs):
        captured.extend(args); started.set()
        return SimpleNamespace(returncode=None, wait=wait)

    worker = _Worker(camera)
    with patch.object(media, "_spawn", spawn), patch("nvr.media._stop_process", AsyncMock()):
        task = asyncio.create_task(media._record(worker))
        try:
            await asyncio.wait_for(started.wait(), 1)
            assert captured[captured.index("-i") + 1] == camera["url"]
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)
