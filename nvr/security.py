"""One local administrator with a scrypt password and expiring server sessions."""
import hashlib
import hmac
import ipaddress
import re
import secrets
import threading
import time
from urllib.parse import urlsplit, urlunsplit


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
        current = store.meta_get("password_hash")
        if password:
            salt = secrets.token_bytes(16)
            digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
            current = salt.hex() + ":" + digest.hex()
            store.meta_set("password_hash", current)
        if not current:
            raise ValueError("Set NVR_ADMIN_PASSWORD before the first start (at least 12 characters)")
        self.password_hash = current
        self.sessions = {}
        self.failures = {}
        self._lock = threading.Lock()

    def check(self, password, host):
        now = time.monotonic()
        with self._lock:
            attempts = [t for t in self.failures.get(host, []) if now-t < 60]
            if len(attempts) >= 5:
                return False
            # Reserve the attempt before expensive scrypt runs in a worker thread.
            attempts.append(now)
            self.failures[host] = attempts
        salt, digest = self.password_hash.split(":")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        if hmac.compare_digest(actual, digest):
            with self._lock:
                self.failures.pop(host, None)
            return True
        return False

    def login(self):
        now = time.monotonic()
        self.sessions = {k: v for k, v in self.sessions.items() if v > now}
        token = secrets.token_urlsafe(32)
        self.sessions[token] = now + 12*3600
        return token

    def valid(self, token):
        return self.sessions.get(token, 0) > time.monotonic()
