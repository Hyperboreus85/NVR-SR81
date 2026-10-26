"""Local display preferences; never change the operating system or use a network."""
from __future__ import annotations

from functools import lru_cache
from io import BytesIO
import ipaddress
import json
import os
from pathlib import Path
import posixpath
import re
import sqlite3
import stat
import time
import unicodedata
from zoneinfo import ZoneInfo


GENERAL_PREFERENCE_KEY = "general.preferences.v1"
ALLOWED_ROTATION_SECONDS = (0, 15, 30, 60, 120, 300)
_FIELDS = {"recorder_name", "timezone", "hour_format", "rotation_seconds"}
_DEFAULTS = {"recorder_name": "", "timezone": "auto", "hour_format": "24", "rotation_seconds": 0}
_ZONE = re.compile(r"[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*\Z")
_CACHE_SECONDS = 60
_MAX_FILES = 4096
_MAX_ZONE_BYTES = 128 * 1024
_MAX_TABLE_BYTES = 512 * 1024


class GeneralPreferenceError(ValueError):
    """Messages contain no paths, identity, saved payload or underlying errors."""

    def __init__(self, message="Enter valid general settings.", status_code=422):
        super().__init__(message)
        self.status_code = status_code


def _zone_name(value):
    return isinstance(value, str) and len(value) <= 128 and bool(_ZONE.fullmatch(value))


def _regular_bytes(path, limit, *, boundary=None):
    try:
        resolved = path.resolve(strict=True)
        if boundary is not None and not resolved.is_relative_to(boundary):
            return None
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return None
        with resolved.open("rb") as stream:
            value = stream.read(limit + 1)
        return value if len(value) <= limit else None
    except (OSError, RuntimeError, ValueError):
        return None


def _catalog(root):
    base = root / "usr/share/zoneinfo"
    zones = {"UTC"}
    try:
        boundary = base.resolve(strict=True)
    except (OSError, RuntimeError):
        return zones, {}
    queue, examined = [base], 0
    while queue and examined < _MAX_FILES:
        directory = queue.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    examined += 1
                    if examined > _MAX_FILES:
                        break
                    relative = Path(entry.path).relative_to(base)
                    if relative.parts[0] in {"posix", "right"} or entry.name.startswith("."):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if len(relative.parts) < 6:
                            queue.append(Path(entry.path))
                        continue
                    name = relative.as_posix()
                    if name in {"localtime", "posixrules"} or not _zone_name(name):
                        continue
                    raw = _regular_bytes(Path(entry.path), _MAX_ZONE_BYTES, boundary=boundary)
                    if raw is None or not raw.startswith(b"TZif"):
                        continue
                    try:
                        ZoneInfo.from_file(BytesIO(raw), key=name)
                    except (ValueError, OSError, EOFError, OverflowError):
                        continue
                    zones.add(name)
        except (OSError, RuntimeError, ValueError):
            continue
    countries = {}
    for filename in ("zone.tab", "zone1970.tab"):
        raw = _regular_bytes(base / filename, _MAX_TABLE_BYTES, boundary=boundary)
        if raw is None:
            continue
        for line in raw.decode("utf-8", errors="replace").splitlines()[:_MAX_FILES]:
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 3 or fields[2] not in zones or fields[2] in {"UTC", "Etc/UTC", "Etc/GMT", "GMT"}:
                continue
            codes = fields[0].split(",")
            if len(codes) <= 64 and all(re.fullmatch(r"[A-Z]{2}", code) for code in codes):
                countries.setdefault(fields[2], set()).update(codes)
    return zones, {key: tuple(sorted(value)) for key, value in countries.items()}


@lru_cache(maxsize=8)
def _timezone_data(root_name, environment_tz, bucket):
    # A bounded, minute-long cache avoids walking the timezone catalog for
    # every authenticated read while allowing administrator OS changes later.
    root = Path(root_name)
    zones, countries = _catalog(root)
    candidate = environment_tz.removeprefix(":")
    if candidate in zones:
        return tuple(sorted(zones)), countries, candidate, "environment"
    try:
        target = os.readlink(root / "etc/localtime")
        guest_path = posixpath.normpath(target if target.startswith("/") else posixpath.join("/etc", target))
        prefix = "/usr/share/zoneinfo/"
        candidate = guest_path[len(prefix):] if guest_path.startswith(prefix) else ""
        if candidate in zones:
            return tuple(sorted(zones)), countries, candidate, "localtime"
    except (OSError, ValueError, RuntimeError):
        pass
    raw = _regular_bytes(root / "etc/timezone", 256, boundary=root)
    if raw is not None:
        candidate = raw.decode("utf-8", errors="replace").strip()
        if candidate in zones:
            return tuple(sorted(zones)), countries, candidate, "timezone"
    return tuple(sorted(zones)), countries, "UTC", "fallback"


def _clean_identity(value, limit):
    if not isinstance(value, str):
        return None
    cleaned = "".join(character for character in value if unicodedata.category(character) not in {"Cc", "Cf", "Cs"}).strip()[:limit]
    return cleaned or None


class GeneralPreferences:
    def __init__(self, store, telemetry, *, root_dir=Path("/")):
        self.store, self.telemetry = store, telemetry
        self.root = Path(root_dir).resolve()

    def _environment(self):
        value = os.environ.get("TZ", "")
        value = value if len(value) <= 129 else ""
        return _timezone_data(str(self.root), value, int(time.monotonic() // _CACHE_SECONDS))

    @staticmethod
    def _validate(data, zones):
        if not isinstance(data, dict) or set(data) != _FIELDS:
            raise GeneralPreferenceError()
        name = data["recorder_name"]
        if (not isinstance(name, str) or len(name) > 80
                or any(unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in name)):
            raise GeneralPreferenceError("Use a recorder name of up to 80 characters without control characters.")
        timezone = data["timezone"]
        if not isinstance(timezone, str) or timezone != "auto" and timezone not in zones:
            raise GeneralPreferenceError("Choose an available time zone.")
        if type(data["hour_format"]) is not str or data["hour_format"] not in {"12", "24"}:
            raise GeneralPreferenceError("Choose a 12-hour or 24-hour clock.")
        if type(data["rotation_seconds"]) is not int or data["rotation_seconds"] not in ALLOWED_ROTATION_SECONDS:
            raise GeneralPreferenceError("Choose one of the available rotation intervals.")
        return {"recorder_name": name.strip(), "timezone": timezone,
                "hour_format": data["hour_format"], "rotation_seconds": data["rotation_seconds"]}

    def _result(self, data, environment):
        zones, countries, system_timezone, source = environment
        try:
            snapshot = self.telemetry.snapshot()
            identity = snapshot.get("identity", {}) if isinstance(snapshot, dict) else {}
        except (OSError, RuntimeError, ValueError, TypeError):
            identity = {}
        identity = identity if isinstance(identity, dict) else {}
        hostname = _clean_identity(identity.get("hostname"), 253)
        addresses = []
        raw_addresses = identity.get("addresses")
        for raw in raw_addresses[:64] if isinstance(raw_addresses, list) else []:
            if not isinstance(raw, str) or len(raw) > 128:
                continue
            address, separator, interface = raw.partition("%")
            if separator and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", interface):
                continue
            try:
                numeric = ipaddress.ip_address(address)
            except ValueError:
                continue
            if separator and numeric.version != 6:
                continue
            value = str(numeric) + ("%" + interface if separator else "")
            if value not in addresses:
                addresses.append(value)
            if len(addresses) >= 32:
                break
        effective = system_timezone if data["timezone"] == "auto" else data["timezone"]
        return data | {"recorder_name": data["recorder_name"] or (hostname[:80] if hostname else "NVR-SR81"),
                       "allowed_rotation_seconds": list(ALLOWED_ROTATION_SECONDS), "timezones": list(zones),
                       "system": {"hostname": hostname, "addresses": addresses, "timezone": system_timezone,
                                  "country_codes": list(countries.get(system_timezone, ())), "source": source},
                       "effective_timezone": effective, "country_codes": list(countries.get(effective, ()))}

    def read(self):
        environment = self._environment()
        try:
            raw = self.store.meta_get(GENERAL_PREFERENCE_KEY)
        except (OSError, RuntimeError, ValueError, sqlite3.Error):
            raise GeneralPreferenceError("General settings are unavailable. Try again.", 503) from None
        data = dict(_DEFAULTS)
        if isinstance(raw, str) and len(raw) <= 4096:
            try:
                data = self._validate(json.loads(raw), environment[0])
            except (ValueError, TypeError, RecursionError):
                pass
        return self._result(data, environment)

    def save(self, data):
        environment = self._environment()
        value = self._validate(data, environment[0])
        encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        try:
            self.store.meta_set(GENERAL_PREFERENCE_KEY, encoded)
        except (OSError, RuntimeError, ValueError, sqlite3.Error):
            raise GeneralPreferenceError("General settings could not be saved. Try again.", 503) from None
        return self._result(value, environment)
