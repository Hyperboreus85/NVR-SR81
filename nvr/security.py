"""Local scrypt authentication, revision-bound sessions and camera permissions."""
import hashlib
import hmac
import ipaddress
import math
import re
import secrets
import threading
import time
from urllib.parse import urlsplit, urlunsplit

from .accounts import Accounts, AccountError, BUILTIN_ADMIN_ID, DUMMY_HASH, PERMISSIONS, password_hash, verify_password, validate_password


STREAM_PROTOCOLS = ("rtsp", "rtsps", "http", "https")
DEFAULT_STREAM_PORTS = {"rtsp": 554, "rtsps": 322, "http": 80, "https": 443}


def validate_camera_host(value: str) -> str:
    """A host field contains an IPv4/IPv6 address or DNS name, never a URL."""
    try:
        if not isinstance(value, str):
            raise ValueError
        host = value.strip()
        if host.startswith("[") and host.endswith("]"):
            host = host[1:-1]
        if not host or any(character.isspace() for character in host) or any(character in host for character in "/@?#%[]"):
            raise ValueError
        try:
            return str(ipaddress.ip_address(host))
        except ValueError:
            if ":" in host or host.replace(".", "").isdigit():
                raise ValueError
        host = host.encode("idna").decode("ascii").lower().rstrip(".")
        if len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
            raise ValueError
        return host
    except (UnicodeError, ValueError):
        raise ValueError("Enter a valid camera IP address or hostname.") from None


def validate_stream_url(url: str) -> str:
    try:
        if not isinstance(url, str):
            raise ValueError
        parts = urlsplit(url)
        port = parts.port
        if parts.scheme not in STREAM_PROTOCOLS or not parts.hostname or parts.fragment:
            raise ValueError
        validate_camera_host(parts.hostname)
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        if any(ord(c) < 32 or ord(c) == 127 for c in url) or len(url) > 4096:
            raise ValueError
    except ValueError:
        raise ValueError("Enter a valid RTSP, RTSPS, HTTP or HTTPS URL") from None
    return url


def redact_url(url: str) -> str:
    if not url:
        return ""
    parts = urlsplit(url)
    host = parts.hostname or "camera"
    if ":" in host:
        host = f"[{host}]"
    if parts.port:
        host += f":{parts.port}"
    # Paths and queries can contain password/token fields as well.
    return urlunsplit((parts.scheme, host, "/…", "", ""))


class Auth:
    def __init__(self, store, password):
        self.sessions, self._session_accounts = {}, {}
        self.failures = {}
        self._lock = threading.Lock()
        self.accounts = Accounts(store)
        self.accounts._on_change = self._revoke_account
        if self.accounts._auth_record(identity=BUILTIN_ADMIN_ID) is None:
            if not password:
                raise ValueError("Set NVR_ADMIN_PASSWORD before the first start (at least 12 characters)")
            self.accounts._bootstrap(password_hash(password))

    @property
    def password_hash(self):
        row = self.accounts._auth_record(identity=BUILTIN_ADMIN_ID)
        return row["password_hash"] if row else None

    def _attempt(self, host):
        host = host if isinstance(host, str) and len(host) <= 128 else "unknown"
        now = time.monotonic()
        with self._lock:
            for identity, times in list(self.failures.items()):
                recent = [stamp for stamp in times if 0 <= now - stamp < 60]
                if recent:
                    self.failures[identity] = recent
                else:
                    self.failures.pop(identity, None)
            if host not in self.failures and len(self.failures) >= 1024:
                return None
            attempts = [t for t in self.failures.get(host, []) if now-t < 60]
            if len(attempts) >= 5:
                return None
            attempts.append(now)
            self.failures[host] = attempts
        return host, now

    def _accepted(self, attempt):
        with self._lock:
            times = self.failures.get(attempt[0], [])
            if attempt[1] in times:
                times.remove(attempt[1])
            if not times:
                self.failures.pop(attempt[0], None)

    def _verified(self, username, password, host):
        attempt = self._attempt(host)
        if attempt is None:
            return None
        try:
            row = self.accounts._auth_record(username=username)
        except AccountError:
            row = None
        matched = verify_password(password, row["password_hash"] if row else DUMMY_HASH)
        return (row, attempt) if matched and row is not None and row["enabled"] else None

    @staticmethod
    def _same_revision(before, after):
        return bool(after and after["enabled"] and type(after["revision"]) is int and after["revision"] >= 1
                    and before["id"] == after["id"] and before["revision"] == after["revision"]
                    and hmac.compare_digest(before["password_hash"], after["password_hash"]))

    def check(self, password, host, username="admin"):
        verified = self._verified(username, password, host)
        if verified is None:
            return False
        row, attempt = verified
        try:
            current = self.accounts._auth_record(identity=row["id"])
            if not self._same_revision(row, current):
                return False
            self.accounts._public(current)
        except (AccountError, TypeError, KeyError):
            return False
        self._accepted(attempt)
        return True

    def _mint(self, row):
        now = time.monotonic()
        with self._lock:
            for token, expiry in list(self.sessions.items()):
                if type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry <= now:
                    self.sessions.pop(token, None); self._session_accounts.pop(token, None)
            for token in list(self._session_accounts):
                if token not in self.sessions:
                    self._session_accounts.pop(token, None)
            own = [token for token, (identity, _) in self._session_accounts.items() if identity == row["id"]]
            while len(own) >= 32:
                token = own.pop(0); self.sessions.pop(token, None); self._session_accounts.pop(token, None)
            while len(self.sessions) >= 1024:
                token = next(iter(self.sessions)); self.sessions.pop(token, None); self._session_accounts.pop(token, None)
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + 12 * 3600
            self._session_accounts[token] = (row["id"], row["revision"])
            return token

    def login(self, username="admin"):
        """Compatibility for trusted callers; HTTP login must use authenticate."""
        with self.accounts._transaction() as db:
            row = self.accounts._auth_record(username=username, db=db)
            if row is None or not row["enabled"]:
                raise AccountError("Sign in again to continue.", 401)
            self.accounts._public(row)
            return self._mint(row)

    def authenticate(self, username, password, host):
        verified = self._verified(username, password, host)
        if verified is None:
            return None
        row, attempt = verified
        token = None
        try:
            with self.accounts._transaction() as db:
                current = self.accounts._auth_record(identity=row["id"], db=db)
                if not self._same_revision(row, current):
                    return None
                self.accounts._public(current)
                token = self._mint(current)
            self._accepted(attempt)
            return token
        except (AccountError, KeyError, TypeError):
            if token is not None:
                self.logout(token)
            return None

    def _binding(self, token):
        if not isinstance(token, str):
            return None
        with self._lock:
            expiry = self.sessions.get(token, 0)
            if type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry <= time.monotonic():
                self.sessions.pop(token, None); self._session_accounts.pop(token, None)
                return None
            return self._session_accounts.get(token)

    def principal(self, token):
        binding = self._binding(token)
        if binding is None:
            return None
        try:
            row = self.accounts._auth_record(identity=binding[0])
            if row is None or not row["enabled"] or row["revision"] != binding[1]:
                self.logout(token)
                return None
            result = self.accounts._public(row)
            return result if self._binding(token) == binding else None
        except (AccountError, KeyError, TypeError):
            return None

    def valid(self, token):
        return self.principal(token) is not None

    def logout(self, token):
        if isinstance(token, str):
            with self._lock:
                self.sessions.pop(token, None); self._session_accounts.pop(token, None)

    def _revoke_account(self, identity):
        with self._lock:
            for token, binding in list(self._session_accounts.items()):
                if binding[0] == identity:
                    self.sessions.pop(token, None); self._session_accounts.pop(token, None)

    def allows(self, token, permission, camera_id=None):
        if permission not in PERMISSIONS:
            return False
        user = self.principal(token)
        if user is None or permission not in user["permissions"]:
            return False
        if permission == "download" and "recordings" not in user["permissions"]:
            return False
        if permission == "archive_delete" and user["camera_scope"] != "all":
            return False
        return camera_id is None or user["camera_scope"] == "all" or camera_id in user["camera_ids"]

    def change_password(self, token, current_password, new_password, host):
        user = self.principal(token)
        if user is None:
            raise AccountError("Sign in again to continue.", 401)
        if user["role"] != "admin":
            raise AccountError("Administrator access is required.", 403)
        validate_password(new_password)
        attempt = self._attempt(host)
        if attempt is None:
            raise AccountError("Too many password attempts. Try again shortly.", 429)
        before = self.accounts._auth_record(identity=user["id"])
        if before is None or not verify_password(current_password, before["password_hash"]):
            raise AccountError("Current password is incorrect.")
        encoded = password_hash(new_password)
        with self.accounts._transaction() as db:
            after = self.accounts._auth_record(identity=user["id"], db=db)
            if (not self._same_revision(before, after) or after["role"] != "admin"
                    or self._binding(token) != (after["id"], after["revision"])):
                raise AccountError("Your account changed. Sign in again.", 409)
            db.execute("UPDATE accounts SET password_hash=?,revision=revision+1 WHERE id=?", (encoded, after["id"]))
            if after["id"] == BUILTIN_ADMIN_ID:
                db.execute("INSERT INTO metadata VALUES ('password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encoded,))
        self._accepted(attempt)
        self._revoke_account(user["id"])
