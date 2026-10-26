"""Named, credential-free search targets saved locally for network operators."""
import json
import re
import sqlite3
import unicodedata
import uuid

from .network_scan import NetworkScanError, normalize_target

TARGETS_KEY = "network.targets.v1"
MAX_TARGETS = 32


class NetworkTargetError(ValueError):
    def __init__(self, message, status_code=422):
        super().__init__(message)
        self.status_code = status_code


class NetworkTargets:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _values(name, address):
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 60
                or any(unicodedata.category(c) in {"Cc", "Cf", "Cs"} for c in name)):
            raise NetworkTargetError("Use a target name of 1–60 characters without control characters.")
        try:
            return {"name": name.strip(), "address": normalize_target(address)}
        except NetworkScanError as error:
            raise NetworkTargetError(str(error)) from None

    def _read(self):
        try:
            raw = self.store.meta_get(TARGETS_KEY)
            if raw is None:
                return []
            if not isinstance(raw, str) or len(raw) > 32768:
                raise ValueError
            rows = json.loads(raw)
            if not isinstance(rows, list) or len(rows) > MAX_TARGETS:
                raise ValueError
            seen = set()
            for row in rows:
                if (not isinstance(row, dict) or set(row) != {"id", "name", "address"}
                        or not isinstance(row["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", row["id"])
                        or row["id"] in seen):
                    raise ValueError
                seen.add(row["id"])
                if row | self._values(row["name"], row["address"]) != row:
                    raise ValueError
            return rows
        except (ValueError, TypeError, RecursionError, OSError, sqlite3.Error):
            raise NetworkTargetError("Saved targets are unavailable. Try again.", 503) from None

    def read(self):
        return {"targets": self._read(), "max_targets": MAX_TARGETS}

    def _write(self, rows):
        try:
            self.store.meta_set(TARGETS_KEY, json.dumps(rows, ensure_ascii=True, separators=(",", ":")))
        except (OSError, sqlite3.Error, ValueError):
            raise NetworkTargetError("Saved targets could not be updated. Try again.", 503) from None
        return {"targets": rows, "max_targets": MAX_TARGETS}

    def create(self, name, address):
        values = self._values(name, address)
        rows = self._read()
        if len(rows) >= MAX_TARGETS:
            raise NetworkTargetError("Save at most 32 search targets.")
        if any(row["address"] == values["address"] for row in rows):
            raise NetworkTargetError("This search address is already saved.", 409)
        return self._write([*rows, {"id": uuid.uuid4().hex, **values}])

    def delete(self, identity):
        rows = self._read()
        remaining = [row for row in rows if row["id"] != identity]
        if len(remaining) == len(rows):
            raise NetworkTargetError("Saved target not found.", 404)
        return self._write(remaining)
