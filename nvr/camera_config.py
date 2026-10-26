"""Build private camera URLs and expose only non-secret editing metadata."""
from __future__ import annotations

from urllib.parse import quote, urlsplit, urlunsplit

from .security import DEFAULT_STREAM_PORTS, STREAM_PROTOCOLS, validate_camera_host, validate_stream_url


STREAM_FIELDS = {"main": "url", "sub": "preview_url", "third": "third_url"}


def _parts(url):
    return urlsplit(url or "")


def _authority(parts):
    return parts.scheme, (parts.hostname or "").lower(), parts.port or DEFAULT_STREAM_PORTS.get(parts.scheme)


def _independent(url, main):
    if not url or not main:
        return False
    parts, base = _parts(url), _parts(main)
    return (_authority(parts), parts.username or "", parts.password or "") != (_authority(base), base.username or "", base.password or "")


def _connection(value, previous):
    if value is None:
        if not previous:
            return None
        parts = _parts(previous)
        return {"protocol": parts.scheme, "host": validate_camera_host(parts.hostname), "port": parts.port,
                "username": None, "password": None}
    if not isinstance(value, dict):
        raise ValueError("Enter valid camera connection settings.")
    protocol = value.get("protocol")
    if protocol not in STREAM_PROTOCOLS:
        raise ValueError("Choose RTSP, RTSPS, HTTP or HTTPS for the camera connection.")
    host = validate_camera_host(value.get("host", ""))
    port = value.get("port")
    if port is not None and (type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("Camera port must be between 1 and 65535.")
    result = {"protocol": protocol, "host": host, "port": port}
    for key, limit in [("username", 200), ("password", 1024)]:
        text = value.get(key)
        if text is not None and (not isinstance(text, str) or len(text) > limit or any(ord(c) < 32 or ord(c) == 127 for c in text)):
            raise ValueError("Enter valid camera credentials.")
        result[key] = text
    return result


def _build(connection, path, old_url, keep_query=True, auth_url=None):
    old = _parts(old_url)
    authentication = _parts(auth_url) if auth_url else old
    username = authentication.username or ""
    password = authentication.password or ""
    if connection["username"] is not None:
        username = quote(connection["username"], safe="")
    if connection["password"] is not None:
        password = quote(connection["password"], safe="")
    host = connection["host"]
    if ":" in host:
        host = f"[{host}]"
    if connection["port"] is not None:
        host += f":{connection['port']}"
    userinfo = (username + (":" + password if password else "") + "@") if username or password else ""
    if path is None:
        location, query = old.path or "/", old.query
    else:
        if (not isinstance(path, str) or len(path) > 4096 or "#" in path or path.startswith("//")
                or any(ord(character) < 32 or ord(character) == 127 for character in path)):
            raise ValueError("Enter a valid stream path or full stream URL.")
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc:
            raise ValueError("Enter a valid stream path or full stream URL.")
        location = parsed.path or "/"
        if not location.startswith("/"):
            location = "/" + location
        # Private query credentials stay private and survive path-only edits.
        # Supplying '?' explicitly replaces (or clears) the previous query.
        query = parsed.query if "?" in path else old.query if keep_query else ""
    return validate_stream_url(urlunsplit((connection["protocol"], userinfo + host, location, query, "")))


def resolve_camera_streams(data: dict, previous: dict | None = None) -> dict:
    previous = previous or {}
    raw_connection = data.get("connection")
    connection = _connection(raw_connection, previous.get("url"))
    streams = data.get("streams")
    if streams is None:
        streams = {}
    if not isinstance(streams, dict):
        raise ValueError("Enter valid camera stream settings.")
    result = {}
    for stream, field in STREAM_FIELDS.items():
        old = previous.get(field) or ""
        # Explicit legacy full URLs remain authoritative for ONVIF clients.
        legacy = data.get(field)
        path = streams.get(stream)
        if legacy is not None:
            result[field] = validate_stream_url(legacy) if legacy else ""
        elif isinstance(path, str) and urlsplit(path).scheme in STREAM_PROTOCOLS:
            result[field] = validate_stream_url(path)
        elif path == "":
            result[field] = ""
        elif path is not None:
            if connection is None:
                raise ValueError("Enter camera connection settings before using a stream path.")
            result[field] = _build(connection, path, old or previous.get("url"), keep_query=bool(old),
                                   auth_url=previous.get("url") or result.get("url"))
        elif old and raw_connection is not None:
            # An existing stream with a different endpoint is a URL override.
            # Keep it intact unless the caller explicitly replaces its path.
            if not _independent(old, previous.get("url")):
                result[field] = _build(connection, None, old)
            else:
                result[field] = old
        else:
            result[field] = old
        if result[field]:
            result[field] = validate_stream_url(result[field])
    if not result["url"]:
        raise ValueError("Enter the main stream.")
    selected = data.get("live_stream")
    if selected is not None and (type(selected) is not int or selected not in {1, 2, 3}):
        raise ValueError("Choose Main, Sub or Third for live viewing.")
    if selected == 3 and not result["third_url"]:
        raise ValueError("Configure the Third stream before selecting it for live viewing.")
    result["live_stream"] = selected if selected is not None else previous.get("live_stream", 2)
    return result


def preview_stream_url(camera: dict) -> str:
    selected = camera.get("live_stream", 2)
    field = {1: "url", 2: "preview_url", 3: "third_url"}.get(selected, "preview_url")
    return camera.get(field) or camera["url"]


def public_camera_connection(camera: dict) -> dict:
    parts = _parts(camera.get("url"))
    return {"connection": {"protocol": parts.scheme, "host": parts.hostname or "", "port": parts.port or DEFAULT_STREAM_PORTS.get(parts.scheme),
                           "has_username": bool(parts.username), "has_password": bool(parts.password)},
            "streams": {stream: {"configured": bool(camera.get(field)), "independent": stream != "main" and _independent(camera.get(field), camera.get("url"))}
                        for stream, field in STREAM_FIELDS.items()},
            "live_stream": camera.get("live_stream", 2)}
