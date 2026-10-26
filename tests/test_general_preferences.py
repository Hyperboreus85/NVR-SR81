"""General settings use temporary local files and never change the host OS."""
import json
import os
from pathlib import Path
import sqlite3
import struct
from types import SimpleNamespace

import pytest

from nvr import general_preferences as module
from nvr.general_preferences import GeneralPreferenceError, GeneralPreferences, GENERAL_PREFERENCE_KEY
from nvr.store import Store


def tzif(offset=0):
    return b"TZif\x00" + b"\x00" * 15 + struct.pack(">6l", 0, 0, 0, 0, 1, 4) + struct.pack(">lBB", offset, 0, 0) + b"UTC\x00"


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.delenv("TZ", raising=False)
    module._timezone_data.cache_clear()
    yield
    module._timezone_data.cache_clear()


@pytest.fixture
def environment(tmp_path):
    root, data = tmp_path / "system", tmp_path / "data"
    base = root / "usr/share/zoneinfo"
    for zone in ("UTC", "Etc/UTC", "Europe/Rome", "Europe/Zurich", "America/New_York"):
        path = base / zone
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(tzif())
    (base / "zone.tab").write_text("IT\t+4154+01229\tEurope/Rome\nCH\t+4723+00832\tEurope/Zurich\nUS\t+404251-0740023\tAmerica/New_York\n", encoding="utf-8")
    (base / "zone1970.tab").write_text("# IANA country associations, not geographic detection\nIT,SM,VA\t+4154+01229\tEurope/Rome\nCH,DE,LI\t+4723+00832\tEurope/Zurich\n", encoding="utf-8")
    (root / "etc").mkdir()
    data.mkdir()
    store = Store(data)
    telemetry = SimpleNamespace(snapshot=lambda: {"identity": {"hostname": "recorder-local", "addresses": ["192.0.2.10", "2001:db8::10"]}})
    return SimpleNamespace(root=root, base=base, store=store, telemetry=telemetry,
                           preferences=GeneralPreferences(store, telemetry, root_dir=root))


def values(**changes):
    return {"recorder_name": "Studio", "timezone": "Europe/Rome", "hour_format": "24", "rotation_seconds": 30} | changes


def test_defaults_include_detected_identity_and_never_invent_country_from_utc(environment):
    result = environment.preferences.read()
    assert set(result) == {"recorder_name", "timezone", "hour_format", "rotation_seconds", "allowed_rotation_seconds", "timezones", "system", "effective_timezone", "country_codes"}
    assert result["recorder_name"] == "recorder-local"
    assert result["timezone"] == "auto" and result["hour_format"] == "24" and result["rotation_seconds"] == 0
    assert result["effective_timezone"] == "UTC" and result["country_codes"] == []
    assert result["system"] == {"hostname": "recorder-local", "addresses": ["192.0.2.10", "2001:db8::10"], "timezone": "UTC", "country_codes": [], "source": "fallback"}
    assert result["allowed_rotation_seconds"] == [0, 15, 30, 60, 120, 300]
    assert result["timezones"] == sorted(result["timezones"]) and "Europe/Rome" in result["timezones"]
    assert environment.store.meta_get(GENERAL_PREFERENCE_KEY) is None


def test_one_atomic_json_replacement_persists_all_fields_without_mutating_identity_or_timezone(environment, monkeypatch):
    before = sorted(path.relative_to(environment.root).as_posix() for path in environment.root.rglob("*"))
    writes = []
    original = environment.store.meta_set

    def record(key, value):
        writes.append((key, value))
        original(key, value)

    monkeypatch.setattr(environment.store, "meta_set", record)
    result = environment.preferences.save(values(recorder_name="  Studio  ", hour_format="12", rotation_seconds=300))
    assert len(writes) == 1 and writes[0][0] == GENERAL_PREFERENCE_KEY
    assert json.loads(writes[0][1]) == values(recorder_name="Studio", hour_format="12", rotation_seconds=300)
    assert result["recorder_name"] == "Studio" and result["system"]["hostname"] == "recorder-local"
    assert result["effective_timezone"] == "Europe/Rome" and result["country_codes"] == ["IT", "SM", "VA"]
    assert result["system"]["timezone"] == "UTC" and result["system"]["country_codes"] == []
    reloaded = GeneralPreferences(environment.store, environment.telemetry, root_dir=environment.root).read()
    assert reloaded == result
    assert sorted(path.relative_to(environment.root).as_posix() for path in environment.root.rglob("*")) == before


def test_environment_timezone_has_precedence_and_supports_iana_colon_not_posix_rules(environment, monkeypatch):
    (environment.root / "etc/timezone").write_text("America/New_York\n", encoding="utf-8")
    monkeypatch.setenv("TZ", ":Europe/Zurich")
    result = environment.preferences.read()
    assert result["system"]["source"] == "environment" and result["effective_timezone"] == "Europe/Zurich"
    assert result["country_codes"] == ["CH", "DE", "LI"]
    monkeypatch.setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3")
    result = environment.preferences.read()
    assert result["system"]["source"] == "timezone" and result["effective_timezone"] == "America/New_York"
    assert result["country_codes"] == ["US"]


@pytest.mark.parametrize("target", ["../usr/share/zoneinfo/Europe/Rome", "/usr/share/zoneinfo/Europe/Rome"])
def test_localtime_link_is_interpreted_inside_guest_root_before_etc_timezone(environment, monkeypatch, target):
    (environment.root / "etc/timezone").write_text("America/New_York\n", encoding="utf-8")
    original = os.readlink

    def readlink(path, *args, **kwargs):
        return target if Path(path) == environment.root / "etc/localtime" else original(path, *args, **kwargs)

    monkeypatch.setattr(module.os, "readlink", readlink)
    result = environment.preferences.read()
    assert result["effective_timezone"] == "Europe/Rome" and result["system"]["source"] == "localtime"
    assert result["country_codes"] == ["IT", "SM", "VA"]


def test_unsupported_localtime_link_and_invalid_table_are_ignored_without_path_disclosure(environment, monkeypatch):
    (environment.root / "etc/timezone").write_text("UTC\n", encoding="utf-8")
    (environment.base / "zone1970.tab").write_text("private-country\t+0000\tUTC\nUS\t+0000\t../../private\n", encoding="utf-8")
    original = os.readlink
    monkeypatch.setattr(module.os, "readlink", lambda path, *args, **kwargs: "/private/password" if Path(path) == environment.root / "etc/localtime" else original(path, *args, **kwargs))
    result = environment.preferences.read()
    assert result["effective_timezone"] == "UTC" and result["country_codes"] == []
    assert "/private" not in json.dumps(result)


def test_no_catalog_or_timezone_files_falls_back_to_utc_even_without_windows_tzdata(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    prefs = GeneralPreferences(Store(data), SimpleNamespace(snapshot=lambda: {}), root_dir=tmp_path / "missing-system")
    result = prefs.read()
    assert result["timezones"] == ["UTC"] and result["effective_timezone"] == "UTC"
    assert result["recorder_name"] == "NVR-SR81" and result["system"]["hostname"] is None
    assert result["country_codes"] == []


@pytest.mark.parametrize("change", [
    {"recorder_name": "x" * 81}, {"recorder_name": "private\nname"}, {"recorder_name": "private\x00name"},
    {"recorder_name": "private\u202ename"}, {"recorder_name": "private\ud800name"}, {"recorder_name": False},
    {"timezone": "Europe/Imaginary"}, {"timezone": "../Europe/Rome"}, {"timezone": "/etc/localtime"}, {"timezone": True},
    {"hour_format": 24}, {"hour_format": True}, {"hour_format": "h23"},
    {"rotation_seconds": True}, {"rotation_seconds": "30"}, {"rotation_seconds": 30.0}, {"rotation_seconds": 10},
    {"unknown": "private detail"},
])
def test_invalid_settings_never_partially_replace_existing_json(environment, change):
    environment.preferences.save(values())
    previous = environment.store.meta_get(GENERAL_PREFERENCE_KEY)
    with pytest.raises(GeneralPreferenceError) as caught:
        environment.preferences.save(values() | change)
    assert caught.value.status_code == 422 and "private" not in str(caught.value)
    assert environment.store.meta_get(GENERAL_PREFERENCE_KEY) == previous


@pytest.mark.parametrize("value", [None, [], {}, {"recorder_name": "name"}])
def test_exact_four_fields_are_required(environment, value):
    with pytest.raises(GeneralPreferenceError) as caught:
        environment.preferences.save(value)
    assert caught.value.status_code == 422
    assert environment.store.meta_get(GENERAL_PREFERENCE_KEY) is None


@pytest.mark.parametrize("seconds", [0, 15, 30, 60, 120, 300])
def test_rotation_options_and_blank_name_reset_are_saved(environment, seconds):
    result = environment.preferences.save(values(recorder_name="   ", rotation_seconds=seconds))
    assert result["recorder_name"] == "recorder-local" and result["rotation_seconds"] == seconds
    assert json.loads(environment.store.meta_get(GENERAL_PREFERENCE_KEY))["recorder_name"] == ""


@pytest.mark.parametrize("raw", ["{broken", "[]", "null", '{"unknown":"private"}', "x" * 4097])
def test_corrupt_persisted_metadata_falls_back_without_exposing_or_rewriting_it(environment, raw):
    environment.store.meta_set(GENERAL_PREFERENCE_KEY, raw)
    result = environment.preferences.read()
    assert result["timezone"] == "auto" and result["rotation_seconds"] == 0 and result["recorder_name"] == "recorder-local"
    assert environment.store.meta_get(GENERAL_PREFERENCE_KEY) == raw
    assert "private" not in json.dumps(result)


def test_storage_errors_are_safe_and_failed_save_preserves_previous_dictionary(environment, monkeypatch):
    environment.preferences.save(values())
    previous = environment.store.meta_get(GENERAL_PREFERENCE_KEY)
    monkeypatch.setattr(environment.store, "meta_set", lambda *args: (_ for _ in ()).throw(sqlite3.OperationalError("private database path")))
    with pytest.raises(GeneralPreferenceError) as caught:
        environment.preferences.save(values(recorder_name="New"))
    assert caught.value.status_code == 503 and "private" not in str(caught.value)
    assert environment.store.meta_get(GENERAL_PREFERENCE_KEY) == previous
    monkeypatch.setattr(environment.store, "meta_get", lambda *args: (_ for _ in ()).throw(OSError("private read failure")))
    with pytest.raises(GeneralPreferenceError) as caught:
        environment.preferences.read()
    assert caught.value.status_code == 503 and "private" not in str(caught.value)


def test_detection_cache_is_bounded_refreshes_after_ttl_and_response_lists_do_not_mutate_it(environment, monkeypatch):
    clock = [0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    path = environment.root / "etc/timezone"
    path.write_text("Europe/Rome\n", encoding="utf-8")
    first = environment.preferences.read()
    first["timezones"].clear()
    first["country_codes"].append("XX")
    path.write_text("America/New_York\n", encoding="utf-8")
    assert environment.preferences.read()["effective_timezone"] == "Europe/Rome"
    clock[0] = 61
    result = environment.preferences.read()
    assert result["effective_timezone"] == "America/New_York" and result["country_codes"] == ["US"]
    assert "Europe/Rome" in result["timezones"]
    for index in range(20):
        clock[0] = 61 * (index + 2)
        environment.preferences.read()
    assert module._timezone_data.cache_info().currsize <= 8


def test_identity_is_refreshed_numeric_bounded_and_has_no_dns_or_host_changes(environment):
    environment.telemetry.snapshot = lambda: {"identity": {"hostname": " changed-host\n", "addresses": ["not-a-hostname", "192.0.2.10", "192.0.2.10", "fe80::1%eth0", "2001:db8::bad%bad scope", "192.0.2.1%eth0"]}}
    result = environment.preferences.read()
    assert result["recorder_name"] == "changed-host" and result["system"]["hostname"] == "changed-host"
    assert result["system"]["addresses"] == ["192.0.2.10", "fe80::1%eth0"]
    environment.telemetry.snapshot = lambda: (_ for _ in ()).throw(OSError("private collector data"))
    result = environment.preferences.read()
    assert result["recorder_name"] == "NVR-SR81" and result["system"]["addresses"] == []


def test_catalog_rejects_text_files_malformed_tzif_and_special_aliases(environment):
    (environment.base / "Private").mkdir()
    (environment.base / "Private/Password").write_text("secret", encoding="utf-8")
    (environment.base / "Private/Broken").write_bytes(b"TZif")
    (environment.base / "localtime").write_bytes(tzif())
    (environment.base / "posixrules").write_bytes(tzif())
    result = environment.preferences.read()
    assert not {"Private/Password", "Private/Broken", "localtime", "posixrules"} & set(result["timezones"])
