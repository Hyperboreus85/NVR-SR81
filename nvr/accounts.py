"""Local account policy and transactional persistence; password hashes stay private."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import unicodedata
import uuid


BUILTIN_ADMIN_ID = "builtin-admin"
PERMISSIONS = ("live", "recordings", "download", "cameras", "network", "settings", "system", "maintenance", "archive_delete")
USERNAME = re.compile(r"[a-z0-9][a-z0-9_.-]{2,31}\Z", re.ASCII)
HASH_ENCODING = re.compile(r"[0-9a-fA-F]{32}:[0-9a-fA-F]{128}\Z")
DUMMY_HASH = "00" * 16 + ":" + "00" * 64
FIELDS = {"username", "display_name", "role", "permissions", "camera_scope", "camera_ids", "enabled", "password"}


class AccountError(RuntimeError):
    def __init__(self, message, status_code=422):
        super().__init__(message)
        self.safe, self.status_code = message, status_code


def canonical_username(value):
    if not isinstance(value, str) or len(value) > 128:
        return None
    normalized = value.strip().lower()
    return normalized if USERNAME.fullmatch(normalized) else None


def validate_password(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 1024:
        raise AccountError("Password must contain between 12 and 1024 characters.")
    return value


def password_hash(value):
    validate_password(value)
    salt = secrets.token_bytes(16)
    try:
        digest = hashlib.scrypt(value.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    except UnicodeError:
        raise AccountError("Password contains unsupported characters.") from None
    return salt.hex() + ":" + digest.hex()


def verify_password(value, encoded):
    valid_input = isinstance(value, str) and len(value) <= 1024
    valid_hash = isinstance(encoded, str) and HASH_ENCODING.fullmatch(encoded)
    salt, expected = (encoded if valid_hash else DUMMY_HASH).split(":")
    try:
        actual = hashlib.scrypt((value if valid_input else "").encode("utf-8"),
                                salt=bytes.fromhex(salt), n=16384, r=8, p=1)
        matched = hmac.compare_digest(actual, bytes.fromhex(expected))
        return bool(valid_input and valid_hash and matched)
    except (ValueError, TypeError, UnicodeError):
        return False


class Accounts:
    def __init__(self, store):
        self.store, self._on_change = store, None
        try:
            with self.store.connect() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
                    permissions TEXT NOT NULL, camera_scope TEXT NOT NULL CHECK(camera_scope IN ('all','selected')),
                    camera_ids TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
                    password_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1))""")
            self._bootstrap()
        except (sqlite3.Error, OSError):
            raise AccountError("User storage is unavailable. Try again shortly.", 503) from None

    @contextmanager
    def _transaction(self):
        try:
            with self.store.connect() as db:
                db.execute("PRAGMA busy_timeout=1000")
                db.execute("BEGIN IMMEDIATE")
                yield db
        except sqlite3.IntegrityError:
            raise AccountError("This username is already in use.", 409) from None
        except (sqlite3.Error, OSError):
            raise AccountError("User storage is unavailable. Try again shortly.", 503) from None

    def _bootstrap(self, initial_hash=None):
        with self._transaction() as db:
            current = db.execute("SELECT * FROM accounts WHERE id=?", (BUILTIN_ADMIN_ID,)).fetchone()
            legacy = db.execute("SELECT value FROM metadata WHERE key='password_hash'").fetchone()
            # A persisted account wins over startup environment values. On the
            # first migration preserve the password already used by the old NVR.
            encoded = current["password_hash"] if current is not None else legacy["value"] if legacy else initial_hash
            if not encoded:
                return False
            if not isinstance(encoded, str) or not HASH_ENCODING.fullmatch(encoded):
                raise AccountError("Administrator credentials are unavailable.", 503)
            if current is None:
                db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,1)",
                           (BUILTIN_ADMIN_ID, "admin", "Administrator", "admin", json.dumps(list(PERMISSIONS)),
                            "all", "[]", 1, encoded))
            db.execute("INSERT INTO metadata VALUES ('password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encoded,))
            return True

    @staticmethod
    def _public(row):
        if row is None:
            return None
        try:
            role = row["role"]
            if (role not in {"admin", "user"} or row["enabled"] not in (0, 1)
                    or type(row["revision"]) is not int or row["revision"] < 1):
                raise ValueError
            permissions = list(PERMISSIONS) if role == "admin" else json.loads(row["permissions"])
            scope = "all" if role == "admin" else row["camera_scope"]
            cameras = [] if role == "admin" or scope == "all" else json.loads(row["camera_ids"])
            if (not isinstance(permissions, list) or any(key not in PERMISSIONS for key in permissions)
                    or scope not in {"all", "selected"} or not isinstance(cameras, list)
                    or len(cameras) > 32 or any(not isinstance(identity, str) for identity in cameras)):
                raise ValueError
            return {"id": row["id"], "username": row["username"], "display_name": row["display_name"], "role": role,
                    "permissions": [key for key in PERMISSIONS if key in permissions], "camera_scope": scope,
                    "camera_ids": cameras, "enabled": bool(row["enabled"]), "builtin": row["id"] == BUILTIN_ADMIN_ID}
        except (KeyError, TypeError, ValueError):
            raise AccountError("User storage is unavailable. Try again shortly.", 503) from None

    def _auth_record(self, *, identity=None, username=None, db=None):
        column, value = ("id", identity) if identity is not None else ("username", canonical_username(username))
        if not isinstance(value, str) or len(value) > 128:
            return None
        try:
            if db is not None:
                row = db.execute(f"SELECT * FROM accounts WHERE {column}=?", (value,)).fetchone()
            else:
                with self.store.connect() as connection:
                    row = connection.execute(f"SELECT * FROM accounts WHERE {column}=?", (value,)).fetchone()
            return dict(row) if row is not None else None
        except (sqlite3.Error, OSError):
            raise AccountError("User storage is unavailable. Try again shortly.", 503) from None

    def list(self):
        try:
            with self.store.connect() as db:
                return [self._public(row) for row in db.execute("SELECT * FROM accounts ORDER BY username COLLATE NOCASE")]
        except (sqlite3.Error, OSError):
            raise AccountError("User storage is unavailable. Try again shortly.", 503) from None

    def get(self, identity):
        return self._public(self._auth_record(identity=identity))

    def by_username(self, username):
        return self._public(self._auth_record(username=username))

    def _actor(self, db, identity):
        row = self._auth_record(identity=identity, db=db)
        if row is None or not row["enabled"] or row["role"] != "admin":
            raise AccountError("Administrator access is required.", 403)
        return row

    def _values(self, data, db, existing=None):
        if not isinstance(data, dict) or set(data) - FIELDS:
            raise AccountError("Invalid user settings.")
        old = self._public(existing) if existing is not None else None
        defaults = {"username": None, "display_name": None, "role": "user", "permissions": [],
                    "camera_scope": "selected", "camera_ids": [], "enabled": True}
        values = {**defaults, **(old or {}), **data}
        if old and old["role"] == "admin" and values["role"] == "user":
            # An administrator's implicit access must not silently become a
            # regular user's explicit grants during a partial demotion.
            for key in ("permissions", "camera_scope", "camera_ids"):
                if key not in data:
                    values[key] = defaults[key]
        username = canonical_username(values["username"])
        if username is None:
            raise AccountError("Username must contain 3 to 32 ASCII letters, numbers, dots, underscores or hyphens and start with a letter or number.")
        display = values["display_name"]
        if display is None:
            display = username
        if (not isinstance(display, str) or len(display) > 80
                or any(unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in display)):
            raise AccountError("Display name must contain at most 80 characters without control characters.")
        role, permissions, scope, cameras = values["role"], values["permissions"], values["camera_scope"], values["camera_ids"]
        if not isinstance(role, str) or role not in {"admin", "user"} or type(values["enabled"]) is not bool:
            raise AccountError("Invalid user role or enabled setting.")
        if not isinstance(permissions, list) or len(permissions) > len(PERMISSIONS) or any(key not in PERMISSIONS for key in permissions):
            raise AccountError("Choose valid user permissions.")
        if not isinstance(scope, str) or scope not in {"all", "selected"} or not isinstance(cameras, list) or len(cameras) > 32:
            raise AccountError("Choose a valid camera scope with at most 32 cameras.")
        if role == "admin":
            permissions, scope, cameras = list(PERMISSIONS), "all", []
        else:
            if "download" in permissions and "recordings" not in permissions:
                raise AccountError("Download permission requires recordings access.")
            if scope == "selected" and "archive_delete" in permissions:
                raise AccountError("Clearing the archive requires access to all cameras.")
            for identity in cameras:
                try:
                    if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}", identity):
                        raise ValueError
                    uuid.UUID(identity)
                except (ValueError, TypeError, AttributeError):
                    raise AccountError("Choose valid camera IDs.") from None
            cameras = list(dict.fromkeys(cameras)) if scope == "selected" else []
            if cameras:
                known = {row[0] for row in db.execute("SELECT id FROM cameras WHERE id IN (" + ",".join("?" for _ in cameras) + ")", cameras)}
                preserved = set(old["camera_ids"]) if old and old["camera_scope"] == "selected" else set()
                if set(cameras) - known - preserved:
                    raise AccountError("One or more selected cameras are unavailable.")
        values.update(username=username, display_name=display, role=role,
                      permissions=[key for key in PERMISSIONS if key in permissions], camera_scope=scope,
                      camera_ids=cameras)
        return values

    @staticmethod
    def _last_admin(db, target, values=None):
        losing_admin = values is None or not values["enabled"] or values["role"] != "admin"
        if target["enabled"] and target["role"] == "admin" and losing_admin:
            if db.execute("SELECT COUNT(*) FROM accounts WHERE enabled=1 AND role='admin'").fetchone()[0] <= 1:
                raise AccountError("At least one enabled administrator is required.", 409)

    def _changed(self, identity):
        if self._on_change is not None:
            self._on_change(identity)

    def create(self, data, actor_id):
        if not isinstance(data, dict):
            raise AccountError("Invalid user settings.")
        encoded = password_hash(data.get("password"))
        identity = uuid.uuid4().hex
        with self._transaction() as db:
            self._actor(db, actor_id)
            values = self._values(data, db)
            db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,1)",
                (identity, values["username"], values["display_name"], values["role"], json.dumps(values["permissions"]),
                 values["camera_scope"], json.dumps(values["camera_ids"]), values["enabled"], encoded))
            result = self._public(self._auth_record(identity=identity, db=db))
        return result

    def update(self, identity, data, actor_id):
        if not isinstance(data, dict):
            raise AccountError("Invalid user settings.")
        if identity == actor_id and data.get("password") is not None:
            raise AccountError("Use Change my password to update your own password.", 409)
        encoded = password_hash(data["password"]) if data.get("password") is not None else None
        with self._transaction() as db:
            self._actor(db, actor_id)
            existing = self._auth_record(identity=identity, db=db)
            if existing is None:
                raise AccountError("User not found.", 404)
            values = self._values(data, db, existing)
            if identity == BUILTIN_ADMIN_ID and (values["username"] != "admin" or not values["enabled"] or values["role"] != "admin"):
                raise AccountError("The built-in administrator cannot be renamed, disabled or demoted.", 409)
            if identity == actor_id and (not values["enabled"] or values["role"] != "admin"):
                raise AccountError("You cannot disable or demote your own account.", 409)
            self._last_admin(db, existing, values)
            db.execute("""UPDATE accounts SET username=?,display_name=?,role=?,permissions=?,camera_scope=?,camera_ids=?,
                enabled=?,password_hash=?,revision=revision+1 WHERE id=?""",
                (values["username"], values["display_name"], values["role"], json.dumps(values["permissions"]),
                 values["camera_scope"], json.dumps(values["camera_ids"]), values["enabled"], encoded or existing["password_hash"], identity))
            if identity == BUILTIN_ADMIN_ID and encoded:
                db.execute("INSERT INTO metadata VALUES ('password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encoded,))
            result = self._public(self._auth_record(identity=identity, db=db))
        self._changed(identity)
        return result

    def delete(self, identity, actor_id):
        with self._transaction() as db:
            self._actor(db, actor_id)
            target = self._auth_record(identity=identity, db=db)
            if target is None:
                raise AccountError("User not found.", 404)
            if identity == BUILTIN_ADMIN_ID:
                raise AccountError("The built-in administrator cannot be deleted.", 409)
            if identity == actor_id:
                raise AccountError("You cannot delete your own account.", 409)
            self._last_admin(db, target)
            db.execute("DELETE FROM accounts WHERE id=?", (identity,))
        self._changed(identity)
