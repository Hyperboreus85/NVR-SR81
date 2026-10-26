"""Authenticated same-origin HTTP API and bundled offline interface."""
import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path
import shutil
import re
import sqlite3
import time
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .camera_config import public_camera_connection, resolve_camera_streams
from .discovery import DiscoveryError, discover, list_interfaces, scan_network
from .live import LiveError, LiveManager
from .languages import LanguageError, LanguageManager, MAX_PACK_BYTES
from .general_preferences import GeneralPreferenceError, GeneralPreferences
from .media import MediaError, MediaManager
from .maintenance import MaintenanceError, MaintenanceManager
from .telemetry_history import TelemetryHistory
from .onvif import get_profiles
from .preferences import SEGMENT_PREFERENCE_KEY, recording_preferences, restore_recording_preferences
from .security import Auth, redact_url
from .accounts import AccountError
from .store import Store
from .telemetry import SystemTelemetry
from .system_status import RecordingCapacity
from .storage_policy import archive_storage_status, storage_overview

LIVE_AUTH_CHECK_SECONDS = 15
PERMISSION_KEYS = ("live", "recordings", "download", "cameras", "network", "settings", "system", "maintenance", "archive_delete")


class LeasedFileResponse(FileResponse):
    """Release a cached artifact even when a Range response disconnects."""

    def __init__(self, path, *, lease, **kwargs):
        super().__init__(path, **kwargs)
        self.lease = lease

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.lease.__aexit__(None, None, None)


class RevocableStreamingResponse(StreamingResponse):
    """Release a live subscription on revocation, even under backpressure."""

    def __init__(self, content, *, check, **kwargs):
        super().__init__(content, **kwargs)
        self.check = check

    async def __call__(self, scope, receive, send):
        started = ended = False
        async def recorded_send(message):
            nonlocal started, ended
            if message["type"] == "http.response.start":
                started = True
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                ended = True
            await send(message)
        async def watch():
            while True:
                await asyncio.sleep(LIVE_AUTH_CHECK_SECONDS)
                try:
                    self.check()
                except HTTPException:
                    return
        delivery = asyncio.create_task(super().__call__(scope, receive, recorded_send))
        watcher = asyncio.create_task(watch())
        revoked = False
        try:
            done, _ = await asyncio.wait((delivery, watcher), return_when=asyncio.FIRST_COMPLETED)
            revoked = watcher in done and delivery not in done
            if not revoked:
                await delivery
        finally:
            for task in (delivery, watcher):
                if not task.done():
                    task.cancel()
            await asyncio.gather(delivery, watcher, return_exceptions=True)
            if hasattr(self.body_iterator, "aclose"):
                await self.body_iterator.aclose()
        if revoked and started and not ended:
            with contextlib.suppress(OSError, RuntimeError, asyncio.TimeoutError):
                await asyncio.wait_for(send({"type": "http.response.body", "body": b"", "more_body": False}), 1)


class RecordingPreferencesInput(BaseModel):
    model_config = {"extra": "forbid"}
    segment_minutes: int = Field(strict=True, ge=1, le=120)


class GeneralPreferencesInput(BaseModel):
    model_config = {"extra": "forbid"}
    recorder_name: str = Field(strict=True, max_length=80)
    timezone: str = Field(strict=True, min_length=1, max_length=128)
    hour_format: Literal["24", "12"]
    rotation_seconds: int = Field(strict=True, ge=0, le=300)


class MaintenanceActionInput(BaseModel):
    model_config = {"extra": "forbid"}
    action: Literal["restart-service", "reboot-system"]
    confirmation: Literal["RESTART", "REBOOT"]


class ArchiveClearInput(BaseModel):
    model_config = {"extra": "forbid"}
    confirmation: Literal["DELETE"]


class CameraConnectionInput(BaseModel):
    model_config = {"extra": "forbid"}
    protocol: Literal["rtsp", "rtsps", "http", "https"] | None = None
    host: str | None = Field(default=None, max_length=253)
    port: int | None = Field(default=None, strict=True, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=200)
    password: str | None = Field(default=None, max_length=1024)


class CameraStreamsInput(BaseModel):
    model_config = {"extra": "forbid"}
    main: str | None = Field(default=None, max_length=4096)
    sub: str | None = Field(default=None, max_length=4096)
    third: str | None = Field(default=None, max_length=4096)


class CameraInput(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=1, max_length=80)
    url: str | None = Field(default=None, max_length=4096)
    preview_url: str | None = Field(default=None, max_length=4096)
    third_url: str | None = Field(default=None, max_length=4096)
    connection: CameraConnectionInput | None = None
    streams: CameraStreamsInput | None = None
    live_stream: int | None = Field(default=None, strict=True, ge=1, le=3)
    enabled: bool = True
    audio_mode: Literal["copy", "none"] = "copy"
    retention_days: int = Field(default=7, ge=1, le=3650)


class LoginInput(BaseModel):
    model_config = {"extra": "forbid"}
    username: str = Field(default="admin", strict=True, min_length=1, max_length=64)
    password: str = Field(strict=True, max_length=1024)


class UserCreateInput(BaseModel):
    model_config = {"extra": "forbid"}
    username: str = Field(strict=True, min_length=1, max_length=32)
    password: str = Field(strict=True, min_length=12, max_length=1024)
    display_name: str | None = Field(default=None, strict=True, max_length=80)
    role: Literal["admin", "user"] = "user"
    permissions: list[Annotated[str, Field(strict=True, max_length=32)]] = Field(default_factory=list, max_length=9)
    camera_scope: Literal["all", "selected"] = "selected"
    camera_ids: list[Annotated[str, Field(strict=True, min_length=1, max_length=128)]] = Field(default_factory=list, max_length=32)
    enabled: bool = Field(default=True, strict=True)


class UserUpdateInput(BaseModel):
    model_config = {"extra": "forbid"}
    username: str | None = Field(default=None, strict=True, min_length=1, max_length=32)
    password: str | None = Field(default=None, strict=True, min_length=12, max_length=1024)
    display_name: str | None = Field(default=None, strict=True, max_length=80)
    role: Literal["admin", "user"] | None = None
    permissions: list[Annotated[str, Field(strict=True, max_length=32)]] | None = Field(default=None, max_length=9)
    camera_scope: Literal["all", "selected"] | None = None
    camera_ids: list[Annotated[str, Field(strict=True, min_length=1, max_length=128)]] | None = Field(default=None, max_length=32)
    enabled: bool | None = Field(default=None, strict=True)


class OwnPasswordInput(BaseModel):
    model_config = {"extra": "forbid"}
    current_password: str = Field(strict=True, max_length=1024)
    new_password: str = Field(strict=True, min_length=12, max_length=1024)
    confirm_password: str = Field(strict=True, min_length=12, max_length=1024)


class OnvifInput(BaseModel):
    endpoint: str = Field(max_length=4096)
    username: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=1024)


class DiscoveryInput(BaseModel):
    interface_ip: str | None = Field(default=None, max_length=45)
    timeout: float = Field(default=6, ge=1, le=10)


class NetworkScanInput(BaseModel):
    cidr: str = Field(min_length=9, max_length=43)
    ports: list[Annotated[int, Field(ge=1, le=65535)]] = Field(
        default_factory=lambda: [80, 8000, 8080, 8899], min_length=1, max_length=8)


def create_app(settings: Settings | None = None, media_factory=MediaManager, live_factory=LiveManager,
               maintenance_factory=MaintenanceManager, telemetry_factory=SystemTelemetry,
               capacity_factory=RecordingCapacity, history_factory=TelemetryHistory, general_factory=GeneralPreferences):
    settings = settings or Settings()
    if settings.password and len(settings.password) < 12:
        raise ValueError("NVR_ADMIN_PASSWORD must contain at least 12 characters")
    store = Store(settings.data_dir)
    restore_recording_preferences(store, settings)
    auth = Auth(store, settings.password)
    languages = LanguageManager(settings.data_dir / "languages", Path(__file__).parent / "locales")
    languages.migrate_legacy(store)
    media = media_factory(settings, store)
    realtime = live_factory(settings)
    maintenance = maintenance_factory()
    telemetry = telemetry_factory(settings.recordings_dir)
    general = general_factory(store, telemetry)
    history = history_factory(settings.data_dir, telemetry)
    capacity = capacity_factory(settings, store, media)
    media_jobs = asyncio.Semaphore(2)
    onvif_jobs = asyncio.Semaphore(2)
    discovery_lock = asyncio.Lock()
    active_scan: asyncio.Task | None = None
    active_scan_session: str | None = None
    login_jobs = asyncio.Semaphore(2)
    mutation_lock = asyncio.Lock()
    recording_updates: set[asyncio.Task] = set()
    archive_clear_task: asyncio.Task | None = None

    @asynccontextmanager
    async def lifespan(app):
        # flock is released automatically on a crash. Never run two recorders
        # against one index/archive, including separate server instances.
        lock = (settings.data_dir / "recorder.lock").open("a+")
        if __import__("os").name != "nt":
            import fcntl
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                lock.close()
                raise RuntimeError("Another instance is already using this data directory") from None
        try:
            await media.start()
            await realtime.start()
            await history.start()
            yield
        finally:
            if recording_updates:
                await asyncio.gather(*tuple(recording_updates), return_exceptions=True)
            if active_scan is not None:
                active_scan.cancel()
                await asyncio.gather(active_scan, return_exceptions=True)
            await history.stop()
            await realtime.stop()
            await media.stop()
            lock.close()

    app = FastAPI(title="NVR-SR81", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.media = store, media
    app.state.settings, app.state.auth = settings, auth
    app.state.realtime = realtime
    app.state.maintenance = maintenance
    app.state.telemetry = telemetry
    app.state.general = general
    app.state.history = history
    app.state.capacity = capacity
    app.state.languages = languages

    def token_of(request):
        return request if isinstance(request, str) else request.cookies.get("nvr_session")

    def require_access(request, permissions=(), *, any_permissions=(), camera_id=None, all_cameras=False, admin=False,
                       missing="Camera not found"):
        token = token_of(request)
        user = auth.principal(token)
        if user is None:
            raise HTTPException(401, "Authentication required")
        if admin and user["role"] != "admin":
            raise HTTPException(403, "Permission denied")
        grants = set(user["permissions"])
        def permitted(permission):
            return (permission in grants and (permission != "download" or "recordings" in grants)
                    and (permission != "archive_delete" or user["camera_scope"] == "all"))
        if any(not permitted(permission) for permission in permissions):
            raise HTTPException(403, "Permission denied")
        if any_permissions and not any(permitted(permission) for permission in any_permissions):
            raise HTTPException(403, "Permission denied")
        if all_cameras and user["camera_scope"] != "all":
            raise HTTPException(403, "Permission denied")
        if camera_id is not None and user["camera_scope"] != "all" and camera_id not in user["camera_ids"]:
            raise HTTPException(404, missing)
        return user

    def authorize_http(request):
        path, method = request.url.path, request.method
        if path in {"/api/logout", "/api/preferences"} and method == ("POST" if path.endswith("logout") else "GET"):
            return require_access(request)
        if path == "/api/users" and method in {"GET", "POST"} or path == "/api/users/me/password" and method == "POST" or re.fullmatch(r"/api/users/[^/]+", path) and method in {"PUT", "DELETE"}:
            return require_access(request, admin=True)
        if path == "/api/cameras":
            if method == "GET":
                return require_access(request, any_permissions=("live", "recordings", "cameras"))
            if method == "POST":
                return require_access(request, ("cameras",), all_cameras=True)
        camera_path = re.fullmatch(r"/api/cameras/([^/]+)(?:/(probe|snapshot|live|live\.mp4))?", path)
        if camera_path:
            camera_id, action = camera_path.groups()
            if action is None and method in {"PUT", "DELETE"} or action == "probe" and method == "POST":
                return require_access(request, ("cameras",), camera_id=camera_id)
            if action in {"snapshot", "live", "live.mp4"} and method == "GET":
                return require_access(request, ("live",), camera_id=camera_id)
        if path == "/api/live/status" and method == "GET":
            return require_access(request, any_permissions=("live", "system"))
        if path == "/api/recordings" and method == "GET":
            return require_access(request, ("recordings",), camera_id=request.query_params.get("camera_id"), missing="Recording not found")
        recording_path = re.fullmatch(r"/api/recordings/([^/]+)/(download|download\.mp4|playback|thumbnail|waveform|motion)", path)
        if recording_path and method == "GET":
            permissions = ("recordings", "download") if recording_path.group(2).startswith("download") else ("recordings",)
            user = require_access(request, permissions)
            recording = store.get_recording(recording_path.group(1))
            if recording is None or user["camera_scope"] != "all" and recording["camera_id"] not in user["camera_ids"]:
                raise HTTPException(404, "Recording not found")
            return user
        if path == "/api/onvif/interfaces" and method == "GET" or path in {"/api/onvif/cancel", "/api/onvif/discover", "/api/onvif/scan", "/api/onvif/profiles"} and method == "POST":
            return require_access(request, ("network",))
        if path in {"/api/settings/general", "/api/settings/recording"} and method in {"GET", "PUT"} or path == "/api/languages/template" and method == "GET" or path == "/api/languages/install" and method == "POST" or re.fullmatch(r"/api/languages/[^/]+", path) and method == "DELETE":
            return require_access(request, ("settings",))
        if path in {"/api/system", "/api/system/telemetry", "/api/system/history"} and method == "GET":
            return require_access(request, ("system",))
        if path == "/api/settings/system" and method == "GET" or path == "/api/settings/system/action" and method == "POST":
            return require_access(request, ("maintenance",))
        if path == "/api/settings/archive" and method == "GET" or path == "/api/settings/archive/clear" and method == "POST":
            return require_access(request, ("archive_delete",), all_cameras=True)
        require_access(request)
        raise HTTPException(404, "Not found")

    @app.middleware("http")
    async def access_control(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if request.headers.get("x-nvr-request") != "1":
                    return JSONResponse({"detail": "Invalid request"}, status_code=403, headers={"Cache-Control": "no-store"})
                origin = request.headers.get("origin")
                if origin and origin != str(request.base_url).rstrip("/"):
                    return JSONResponse({"detail": "Origin not allowed"}, status_code=403, headers={"Cache-Control": "no-store"})
            public = request.url.path == "/api/session" and request.method == "GET" or request.url.path == "/api/login" and request.method == "POST"
            if request.method == "GET":
                language_path = re.fullmatch(r"/api/languages/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)", request.url.path)
                public = public or request.url.path == "/api/languages" or bool(
                    language_path and len(language_path.group(1)) <= 35)
            if not public:
                try:
                    authorize_http(request)
                except HTTPException as error:
                    return JSONResponse({"detail": error.detail}, status_code=error.status_code, headers={"Cache-Control": "no-store"})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        host = request.url.netloc
        websocket_origin = ""
        if re.fullmatch(r"[A-Za-z0-9_.:\[\]-]+", host):
            websocket_origin = ("wss" if request.url.scheme == "https" else "ws") + "://" + host
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' blob: data:; media-src 'self' blob:; "
            f"connect-src 'self' {websocket_origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if request.url.path == "/" or request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # The default validation handler echoes inputs, including credentials.
        return JSONResponse({"detail": "Invalid data: check the fields you entered"}, status_code=422)

    @app.exception_handler(LanguageError)
    async def invalid_language_pack(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.exception_handler(GeneralPreferenceError)
    async def invalid_general_preferences(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.exception_handler(AccountError)
    async def invalid_account(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    def camera_or_404(camera_id, request=None, permission=None):
        if request is not None:
            require_access(request, (permission,) if permission else (), camera_id=camera_id)
        camera = store.get_camera(camera_id)
        if camera is None:
            raise HTTPException(404, "Camera not found")
        return camera

    def recording_or_404(recording_id, request=None, *, download=False):
        recording = store.get_recording(recording_id)
        if recording is None:
            raise HTTPException(404, "Recording not found")
        if request is not None:
            require_access(request, ("recordings", "download") if download else ("recordings",),
                           camera_id=recording["camera_id"], missing="Recording not found")
        path = (settings.recordings_dir / recording["path"]).resolve()
        if not path.is_relative_to(settings.recordings_dir) or not path.is_file():
            raise HTTPException(404, "Recording file unavailable")
        return recording, path

    def public_camera(camera, request=None, user=None):
        user = user or (require_access(request) if request is not None else None)
        if user is not None and "cameras" not in user["permissions"]:
            status = media.camera_status(camera["id"])
            safe_status = {key: value for key, value in status.items() if key in {"state", "last_segment_at"}}
            return {key: value for key, value in camera.items() if key in {"id", "name", "enabled", "audio_mode", "retention_days", "live_stream"}} | {
                "status": safe_status,
                "streams": {name: {"configured": bool(camera.get(key))} for name, key in (("main", "url"), ("sub", "preview_url"), ("third", "third_url"))},
            }
        return {key: value for key, value in camera.items() if key not in {"url", "preview_url", "third_url"}} | {
            "source": redact_url(camera["url"]),
            "preview_source": redact_url(camera["preview_url"]),
            "third_source": redact_url(camera.get("third_url", "")),
            "status": media.camera_status(camera["id"]),
        } | public_camera_connection(camera)

    async def media_result(operation, *, archive=False):
        try:
            # Archive workers already limit their own CPU jobs. Holding this
            # admission slot while waiting for a background analysis could
            # otherwise block even cached video Range requests indefinitely.
            if archive:
                return await operation()
            async with media_jobs:
                return await operation()
        except MediaError as error:
            safe_errors = {
                "Insufficient cache storage for playback. Free space or configure NVR_CACHE_DIR on a larger disk.",
                "Playback cache storage is unavailable.",
                "Media server is busy. Try again shortly.",
            }
            detail = str(error) if str(error) in safe_errors else "Media operation failed. Check the stream and FFmpeg."
            raise HTTPException(503, detail) from None
        except (ValueError, RuntimeError, OSError, asyncio.TimeoutError):
            raise HTTPException(503, "Media operation failed. Check the stream and FFmpeg.") from None

    @app.get("/healthz")
    def health():
        return {"status": "ok", "version": __version__}

    @app.get("/api/session")
    def session(request: Request):
        user = auth.principal(request.cookies.get("nvr_session"))
        return {"authenticated": user is not None, "user": user}

    @app.post("/api/login")
    async def login(data: LoginInput, request: Request):
        host = request.client.host if request.client else "local"
        async with login_jobs:
            token = await asyncio.to_thread(auth.authenticate, data.username, data.password, host)
        if not token:
            raise HTTPException(401, "Invalid username or password, or too many attempts. Wait one minute.")
        user = auth.principal(token)
        if user is None:
            auth.logout(token)
            raise HTTPException(401, "Invalid username or password, or too many attempts. Wait one minute.")
        response = JSONResponse({"authenticated": True, "user": user})
        response.set_cookie("nvr_session", token, httponly=True, secure=settings.secure_cookie,
                            samesite="strict", max_age=12*3600)
        return response

    @app.post("/api/logout")
    async def logout(request: Request):
        session_token = request.cookies.get("nvr_session")
        auth.logout(session_token)
        await cancel_owned_scan(session_token)
        response = JSONResponse({"authenticated": False})
        response.delete_cookie("nvr_session")
        return response

    @app.get("/api/cameras")
    def cameras(request: Request):
        user = require_access(request, any_permissions=("live", "recordings", "cameras"))
        result = [public_camera(camera, request, user) for camera in store.list_cameras()
                  if user["camera_scope"] == "all" or camera["id"] in user["camera_ids"]]
        require_access(request, any_permissions=("live", "recordings", "cameras"))
        return result

    @app.get("/api/preferences")
    def client_preferences(request: Request):
        require_access(request)
        values = general.read()
        require_access(request)
        return {key: values[key] for key in ("recorder_name", "timezone", "hour_format", "rotation_seconds", "effective_timezone")}

    @app.get("/api/users")
    def users(request: Request):
        require_access(request, admin=True)
        result = auth.accounts.list()
        require_access(request, admin=True)
        return {"users": result, "permissions": list(PERMISSION_KEYS)}

    async def account_mutation(request, operation):
        async def apply():
            async with mutation_lock:
                actor = require_access(request, admin=True)
                return await asyncio.to_thread(operation, actor)
        task = asyncio.create_task(apply(), name="nvr-user-mutation")
        recording_updates.add(task)
        def finished(done):
            recording_updates.discard(done)
            if not done.cancelled():
                done.exception()
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    @app.post("/api/users", status_code=201)
    async def create_user(data: UserCreateInput, request: Request):
        return await account_mutation(request, lambda actor: auth.accounts.create(data.model_dump(exclude_none=True), actor["id"]))

    @app.post("/api/users/me/password")
    async def change_own_password(data: OwnPasswordInput, request: Request):
        if data.new_password != data.confirm_password:
            raise HTTPException(422, "The new passwords do not match.")
        host = request.client.host if request.client else "local"
        await account_mutation(request, lambda actor: auth.change_password(token_of(request), data.current_password, data.new_password, host))
        response = JSONResponse({"password_changed": True, "reauthentication_required": True})
        response.delete_cookie("nvr_session")
        return response

    @app.put("/api/users/{user_id}")
    async def update_user(user_id: str, data: UserUpdateInput, request: Request):
        return await account_mutation(request, lambda actor: auth.accounts.update(user_id, data.model_dump(exclude_unset=True), actor["id"]))

    @app.delete("/api/users/{user_id}")
    async def delete_user(user_id: str, request: Request):
        await account_mutation(request, lambda actor: auth.accounts.delete(user_id, actor["id"]))
        return {"deleted": True}

    @app.get("/api/languages")
    def available_languages():
        return languages.list()

    # Keep the authenticated template route before the locale path route.
    @app.get("/api/languages/template")
    def language_template(request: Request):
        require_access(request, ("settings",))
        return languages.template()

    @app.post("/api/languages/install")
    async def install_language(request: Request):
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_PACK_BYTES:
                raise LanguageError("Language pack file is too large.", 413)
            body.extend(chunk)
        pack = languages.parse(body)
        async with mutation_lock:
            # A streamed file upload can outlive logout or session expiry.
            require_access(request, ("settings",))
            return languages.install(pack)

    @app.get("/api/languages/{locale}")
    def language_pack(locale: str):
        return languages.get(locale)

    @app.delete("/api/languages/{locale}")
    async def delete_language(locale: str, request: Request):
        async with mutation_lock:
            require_access(request, ("settings",))
            return languages.delete(locale)

    def validated_camera(data, previous=None):
        values = data.model_dump()
        values["name"] = values["name"].strip()
        if not values["name"]:
            raise HTTPException(422, "Enter a name")
        try:
            resolved = resolve_camera_streams(values, previous)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {key: values[key] for key in ("name", "enabled", "audio_mode", "retention_days")} | resolved

    @app.post("/api/cameras", status_code=201)
    async def add_camera(data: CameraInput, request: Request):
        async with mutation_lock:
            require_access(request, ("cameras",), all_cameras=True)
            if len(store.list_cameras()) >= 32:
                raise HTTPException(422, "This version supports up to 32 cameras")
            camera = store.save_camera(validated_camera(data))
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        user = require_access(request, ("cameras",), all_cameras=True)
        return public_camera(camera, request, user)

    @app.put("/api/cameras/{camera_id}")
    async def update_camera(camera_id: str, data: CameraInput, request: Request):
        async with mutation_lock:
            previous = camera_or_404(camera_id, request, "cameras")
            camera = store.save_camera(validated_camera(data, previous), camera_id)
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        user = require_access(request, ("cameras",), camera_id=camera_id)
        return public_camera(camera, request, user)

    @app.delete("/api/cameras/{camera_id}")
    async def delete_camera(camera_id: str, request: Request):
        async with mutation_lock:
            camera_or_404(camera_id, request, "cameras")
            store.delete_camera(camera_id)
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        return {"deleted": True, "recordings_preserved": True}

    @app.post("/api/cameras/{camera_id}/probe")
    async def probe(camera_id: str, request: Request, stream: int = Query(1, ge=1, le=3)):
        camera = camera_or_404(camera_id, request, "cameras")
        source = (camera["url"], camera.get("preview_url", ""), camera.get("third_url", ""))[stream - 1]
        if not source:
            raise HTTPException(422, "The selected stream is not configured.")
        async def operation():
            require_access(request, ("cameras",), camera_id=camera_id)
            return await media.probe(source)
        result = await media_result(operation)
        require_access(request, ("cameras",), camera_id=camera_id)
        return result

    @app.get("/api/cameras/{camera_id}/snapshot")
    async def snapshot(camera_id: str, request: Request):
        from fastapi.responses import Response
        camera = camera_or_404(camera_id, request, "live")
        async def operation():
            require_access(request, ("live",), camera_id=camera_id)
            return await media.snapshot(camera)
        data = await media_result(operation)
        require_access(request, ("live",), camera_id=camera_id)
        return Response(data, media_type="image/jpeg")

    async def guarded_live(iterator, request, camera_id, closer=None):
        pending = None
        iterator = iterator.__aiter__()
        checked_at = time.monotonic()
        try:
            require_access(request, ("live",), camera_id=camera_id)
            while True:
                pending = asyncio.create_task(anext(iterator))
                while True:
                    done, _ = await asyncio.wait((pending,), timeout=LIVE_AUTH_CHECK_SECONDS)
                    if done:
                        break
                    require_access(request, ("live",), camera_id=camera_id)
                    checked_at = time.monotonic()
                try:
                    chunk = pending.result()
                except StopAsyncIteration:
                    break
                pending = None
                if time.monotonic() - checked_at >= LIVE_AUTH_CHECK_SECONDS:
                    require_access(request, ("live",), camera_id=camera_id)
                    checked_at = time.monotonic()
                yield chunk
        except HTTPException:
            return
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            if hasattr(iterator, "aclose"):
                await iterator.aclose()
            if closer is not None:
                await closer()

    @app.get("/api/cameras/{camera_id}/live")
    async def live(camera_id: str, request: Request):
        camera = camera_or_404(camera_id, request, "live")
        return RevocableStreamingResponse(guarded_live(media.live(camera), request, camera_id),
                                         check=lambda: require_access(request, ("live",), camera_id=camera_id),
                                         media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/api/cameras/{camera_id}/live.mp4")
    async def live_video(camera_id: str, request: Request, compatible: bool = False):
        camera = camera_or_404(camera_id, request, "live")
        try:
            subscription = await realtime.open(camera, compatible=compatible)
        except LiveError as error:
            status = getattr(error, "status_code", 503)
            raise HTTPException(status if status in {422, 429, 503, 504} else 503, str(error)) from None
        except (OSError, asyncio.TimeoutError):
            raise HTTPException(503, "Live view unavailable. Check the camera stream.") from None
        try:
            require_access(request, ("live",), camera_id=camera_id)
        except HTTPException:
            await subscription.close()
            raise
        return RevocableStreamingResponse(
            guarded_live(subscription.stream(), request, camera_id, subscription.close), media_type=subscription.mime,
            check=lambda: require_access(request, ("live",), camera_id=camera_id),
            headers={"X-NVR-Live-Mode": subscription.mode, "X-Accel-Buffering": "no"},
        )

    @app.get("/api/live/status")
    async def live_status(request: Request):
        user = require_access(request, any_permissions=("live", "system"))
        current = realtime.status()
        fields = ("active_streams", "max_streams", "active_transcodes", "max_transcodes")
        streams = [{key: value for key, value in stream.items()
                         if key in {"camera_id", "mode", "viewers", "state", "codec"}}
                   for stream in current.get("streams", [])
                   if user["role"] == "admin" or user["camera_scope"] == "all" or stream.get("camera_id") in user["camera_ids"]]
        counts = {field: current.get(field, 0) for field in fields}
        if user["role"] != "admin":
            counts["active_streams"] = len(streams)
            counts["active_transcodes"] = sum(stream.get("mode") == "compatible" for stream in streams)
        return counts | {"streams": streams}

    @app.websocket("/api/cameras/{camera_id}/live.ws")
    async def live_socket(websocket: WebSocket, camera_id: str, compatible: bool = False):
        # WebSocket upgrades bypass HTTP middleware. Require both the existing
        # administrator session and a matching browser Origin explicitly.
        scheme = "https" if websocket.url.scheme == "wss" else "http"
        expected_origin = f"{scheme}://{websocket.headers.get('host', '')}"
        if websocket.headers.get("origin") != expected_origin:
            await websocket.close(code=4403)
            return
        await websocket.accept()
        session_token = websocket.cookies.get("nvr_session")
        try:
            require_access(websocket, ("live",), camera_id=camera_id)
        except HTTPException as error:
            await websocket.close(code=4401 if error.status_code == 401 else 4404 if error.status_code == 404 else 4403)
            return
        subscription = None
        opening = watching = sending = None

        async def watch_client():
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), LIVE_AUTH_CHECK_SECONDS)
                except asyncio.TimeoutError:
                    try:
                        require_access(websocket, ("live",), camera_id=camera_id)
                    except HTTPException as error:
                        await websocket.close(code=4401 if error.status_code == 401 else 4403)
                        return
                    continue
                if message["type"] == "websocket.disconnect":
                    return
                # Clients only consume media. Unexpected payloads are closed
                # instead of accumulating arbitrary incoming message queues.
                await websocket.close(code=1008)
                return

        async def send_media():
            async for fragment in subscription.stream():
                await websocket.send_bytes(fragment)

        try:
            camera = camera_or_404(camera_id, websocket, "live")
            watching = asyncio.create_task(watch_client())
            opening = asyncio.create_task(realtime.open(camera, compatible=compatible))
            finished, _ = await asyncio.wait((opening, watching), return_when=asyncio.FIRST_COMPLETED)
            if watching in finished:
                return
            subscription = await opening
            require_access(websocket, ("live",), camera_id=camera_id)
            await websocket.send_json({"type": "init", "mime": subscription.mime, "mode": subscription.mode})
            sending = asyncio.create_task(send_media())
            finished, _ = await asyncio.wait((sending, watching), return_when=asyncio.FIRST_COMPLETED)
            if sending in finished:
                await sending
                with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                    await websocket.close(code=1012)
        except (HTTPException, LiveError) as error:
            code = getattr(error, "status_code", 503)
            message = error.detail if isinstance(error, HTTPException) else str(error)
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                await websocket.send_json({"type": "error", "code": code, "message": message})
                await websocket.close(code=1013 if code in {429, 503, 504} else 1008)
        except (WebSocketDisconnect, OSError, RuntimeError):
            # Disconnects and transport errors never include camera URLs in a
            # response or trigger an unhandled ASGI traceback.
            pass
        finally:
            for task in (opening, watching, sending):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (opening, watching, sending) if task), return_exceptions=True)
            if subscription is None and opening and not opening.cancelled():
                with contextlib.suppress(Exception):
                    subscription = opening.result()
            if subscription is not None:
                await subscription.close()
            with contextlib.suppress(WebSocketDisconnect, RuntimeError):
                await websocket.close()

    @app.get("/api/recordings")
    def recordings(request: Request, camera_id: str | None = None, start: float | None = Query(None, ge=0),
                   end: float | None = Query(None, ge=0), limit: int = Query(2000, ge=1, le=10000)):
        if start is not None and end is not None and end <= start:
            raise HTTPException(422, "Invalid time range")
        user = require_access(request, ("recordings",), camera_id=camera_id, missing="Recording not found")
        if user["camera_scope"] == "all" or camera_id is not None:
            rows = store.list_recordings(camera_id, start, end, limit)
        elif not user["camera_ids"]:
            rows = []
        else:
            ids = user["camera_ids"]
            clauses, args = ["camera_id IN (" + ",".join("?" for _ in ids) + ")"], list(ids)
            if start is not None:
                clauses.append("started_at+duration>?"); args.append(start)
            if end is not None:
                clauses.append("started_at<?"); args.append(end)
            with store.connect() as db:
                rows = [dict(row) for row in db.execute("SELECT * FROM recordings WHERE " + " AND ".join(clauses) + " ORDER BY started_at LIMIT ?", (*args, limit))]
        require_access(request, ("recordings",), camera_id=camera_id, missing="Recording not found")
        return [{key: value for key, value in row.items() if key != "path"} for row in rows]

    @app.get("/api/recordings/{recording_id}/download")
    async def download(recording_id: str, request: Request):
        recording, _ = recording_or_404(recording_id, request, download=True)
        lease = media.source_lease(recording)
        path = await media_result(lease.__aenter__, archive=True)
        try:
            require_access(request, ("recordings", "download"), camera_id=recording["camera_id"], missing="Recording not found")
            return LeasedFileResponse(path, lease=lease, media_type="video/x-matroska", filename=path.name)
        except BaseException:
            await lease.__aexit__(None, None, None)
            raise

    @app.get("/api/recordings/{recording_id}/playback")
    async def playback(recording_id: str, request: Request, compatible: bool = False):
        recording, _ = recording_or_404(recording_id, request)
        lease = media.playback_lease(recording, compatible)
        path = await media_result(lease.__aenter__, archive=True)
        try:
            require_access(request, ("recordings",), camera_id=recording["camera_id"], missing="Recording not found")
            return LeasedFileResponse(path, lease=lease, media_type="video/mp4")
        except BaseException:
            await lease.__aexit__(None, None, None)
            raise

    @app.get("/api/recordings/{recording_id}/download.mp4")
    async def compatible_download(recording_id: str, request: Request):
        recording, _ = recording_or_404(recording_id, request, download=True)
        lease = media.download_lease(recording)
        path = await media_result(lease.__aenter__, archive=True)
        try:
            require_access(request, ("recordings", "download"), camera_id=recording["camera_id"], missing="Recording not found")
            # Use a server-generated name, never a user-provided path or label.
            return LeasedFileResponse(path, lease=lease, media_type="video/mp4",
                                      filename=f"recording-{recording_id}-compatible.mp4")
        except BaseException:
            await lease.__aexit__(None, None, None)
            raise

    @app.get("/api/recordings/{recording_id}/thumbnail")
    async def thumbnail(recording_id: str, request: Request):
        from fastapi.responses import Response
        recording, _ = recording_or_404(recording_id, request)
        data = await media_result(lambda: media.thumbnail(recording), archive=True)
        require_access(request, ("recordings",), camera_id=recording["camera_id"], missing="Recording not found")
        return Response(data, media_type="image/jpeg")

    @app.get("/api/recordings/{recording_id}/waveform")
    async def waveform(recording_id: str, request: Request):
        recording, _ = recording_or_404(recording_id, request)
        result = await media_result(lambda: media.waveform(recording), archive=True)
        require_access(request, ("recordings",), camera_id=recording["camera_id"], missing="Recording not found")
        return result

    @app.get("/api/recordings/{recording_id}/motion")
    async def motion(recording_id: str, request: Request, sensitivity: Literal["low", "medium", "high"] = "medium"):
        recording, _ = recording_or_404(recording_id, request)
        result = await media_result(lambda: media.motion(recording, sensitivity), archive=True)
        require_access(request, ("recordings",), camera_id=recording["camera_id"], missing="Recording not found")
        return result

    @app.get("/api/onvif/interfaces")
    async def onvif_interfaces(request: Request):
        try:
            result = await asyncio.to_thread(list_interfaces)
            require_access(request, ("network",))
            return result
        except OSError:
            raise HTTPException(503, "Unable to read the server network interfaces.") from None

    async def run_discovery(request: Request, operation, timeout):
        nonlocal active_scan, active_scan_session
        if discovery_lock.locked():
            raise HTTPException(409, "A search is already running. Wait for it to finish.")
        try:
            async with discovery_lock:
                require_access(request, ("network",))
                job = asyncio.create_task(asyncio.wait_for(operation(), timeout))
                active_scan = job
                active_scan_session = request.cookies.get("nvr_session")
                try:
                    result = await job
                    require_access(request, ("network",))
                    return result
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                    raise HTTPException(499, "Search cancelled.") from None
                finally:
                    job.cancel()
                    await asyncio.gather(job, return_exceptions=True)
                    if active_scan is job:
                        active_scan = None
                        active_scan_session = None
        except DiscoveryError as error:
            raise HTTPException(422, str(error)) from None
        except asyncio.TimeoutError:
            raise HTTPException(504, "Search timed out. Try a smaller range.") from None
        except OSError:
            raise HTTPException(503, "Search unavailable. Check the network and container permissions.") from None

    async def cancel_owned_scan(session_token):
        job = active_scan
        if job is None or job.done() or active_scan_session != session_token:
            return False
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)
        # Wait for the original request's finally block to release the scan slot.
        async with discovery_lock:
            pass
        return True

    @app.post("/api/onvif/cancel")
    async def cancel_onvif_scan(request: Request):
        session_token = request.cookies.get("nvr_session")
        if active_scan and not active_scan.done() and active_scan_session != session_token:
            raise HTTPException(409, "The active search belongs to another session.")
        return {"cancelled": await cancel_owned_scan(session_token)}

    @app.post("/api/onvif/discover")
    async def discover_onvif(data: DiscoveryInput, request: Request):
        return await run_discovery(request, lambda: discover(data.interface_ip, data.timeout), data.timeout + 5)

    @app.post("/api/onvif/scan")
    async def scan_onvif_network(data: NetworkScanInput, request: Request):
        return await run_discovery(request, lambda: scan_network(data.cidr, data.ports), 60)

    @app.post("/api/onvif/profiles")
    async def onvif(data: OnvifInput, request: Request):
        try:
            async with onvif_jobs:
                require_access(request, ("network",))
                result = await asyncio.wait_for(get_profiles(data.endpoint, data.username, data.password), 90)
                require_access(request, ("network",))
                return result
        except asyncio.TimeoutError:
            raise HTTPException(504, "The camera did not finish returning its profiles. Try again or check its ONVIF services.") from None
        except (ValueError, RuntimeError, OSError):
            raise HTTPException(422, "ONVIF unavailable. Check the endpoint, credentials and camera clock.") from None

    @app.get("/api/settings/general")
    def get_general_preferences(request: Request):
        require_access(request, ("settings",))
        result = general.read()
        require_access(request, ("settings",))
        return result

    @app.put("/api/settings/general")
    async def save_general_preferences(data: GeneralPreferencesInput, request: Request):
        async def apply():
            async with mutation_lock:
                # Authorization can expire while another setting is being saved.
                require_access(request, ("settings",))
                return await asyncio.to_thread(general.save, data.model_dump())

        # Finish an admitted save even if its browser disconnects; shutdown
        # waits for the worker before closing the recorder's shared state.
        operation = asyncio.create_task(apply(), name="nvr-general-preferences")
        recording_updates.add(operation)
        def finished(task):
            recording_updates.discard(task)
            if not task.cancelled():
                task.exception()
        operation.add_done_callback(finished)
        return await asyncio.shield(operation)

    @app.get("/api/settings/recording")
    def get_recording_preferences(request: Request):
        require_access(request, ("settings",))
        return recording_preferences(settings)

    @app.put("/api/settings/recording")
    async def save_recording_preferences(data: RecordingPreferencesInput, request: Request):
        if data.segment_minutes not in recording_preferences(settings)["allowed_minutes"]:
            raise HTTPException(422, "Choose one of the supported recording durations.")

        async def apply():
            async with mutation_lock:
                # A save queued behind another mutation must not outlive logout.
                require_access(request, ("settings",))
                previous = settings.segment_seconds
                saved = store.meta_get(SEGMENT_PREFERENCE_KEY)
                seconds = data.segment_minutes * 60
                try:
                    store.meta_set(SEGMENT_PREFERENCE_KEY, str(seconds))
                    if seconds != previous:
                        await media.set_segment_seconds(seconds)
                except (OSError, RuntimeError, ValueError, sqlite3.Error):
                    with contextlib.suppress(OSError, RuntimeError, ValueError, sqlite3.Error):
                        if saved is None:
                            store.meta_delete(SEGMENT_PREFERENCE_KEY)
                        else:
                            store.meta_set(SEGMENT_PREFERENCE_KEY, saved)
                    with contextlib.suppress(OSError, RuntimeError, ValueError, sqlite3.Error):
                        await media.set_segment_seconds(previous)
                    settings.segment_seconds = previous
                    raise HTTPException(503, "Recording settings could not be applied. Try again.") from None
                return recording_preferences(settings) | {"changed": seconds != previous}

        # Finish one atomic save even if its browser disconnects during rollover.
        operation = asyncio.create_task(apply())
        recording_updates.add(operation)
        def finished(task):
            recording_updates.discard(task)
            if not task.cancelled():
                task.exception()
        operation.add_done_callback(finished)
        return await asyncio.shield(operation)

    @app.get("/api/settings/system")
    async def maintenance_status(request: Request):
        result = await maintenance.status()
        require_access(request, ("maintenance",))
        return result

    @app.get("/api/settings/archive")
    def archive_status(request: Request):
        require_access(request, ("archive_delete",), all_cameras=True)
        try:
            result = media.archive_status()
        except (MediaError, OSError, sqlite3.Error, ValueError):
            raise HTTPException(503, "Archive details are unavailable. Check the connection and try again.") from None
        require_access(request, ("archive_delete",), all_cameras=True)
        return result | {"clearing": result["clearing"] or bool(
            archive_clear_task is not None and not archive_clear_task.done())}

    @app.post("/api/settings/archive/clear")
    async def clear_archive(data: ArchiveClearInput, request: Request):
        nonlocal archive_clear_task
        if archive_clear_task is not None and not archive_clear_task.done():
            raise HTTPException(409, "Archive cleanup is already running.")

        async def apply():
            async with mutation_lock:
                require_access(request, ("archive_delete",), all_cameras=True)
                status = await maintenance.status()
                if status.get("pending_action"):
                    raise HTTPException(409, "A maintenance action is already scheduled. Please wait before trying again.")
                require_access(request, ("archive_delete",), all_cameras=True)
                try:
                    return await media.clear_archive()
                except MediaError as error:
                    code = getattr(error, "status_code", 503)
                    raise HTTPException(code if code in {409, 503} else 503, str(error)) from None
                except (OSError, RuntimeError, ValueError, sqlite3.Error):
                    raise HTTPException(503, "Archive cleanup could not finish. Check the archive status before trying again.") from None
                finally:
                    invalidate = getattr(capacity, "invalidate", None)
                    if invalidate is not None:
                        invalidate()

        # A disconnected browser must not leave recording suspended midway.
        # Keep the operation alive and wait for it during application shutdown.
        archive_clear_task = asyncio.create_task(apply(), name="nvr-archive-clear")
        recording_updates.add(archive_clear_task)
        def finished(task):
            recording_updates.discard(task)
            if not task.cancelled():
                task.exception()
        archive_clear_task.add_done_callback(finished)
        return await asyncio.shield(archive_clear_task)

    @app.post("/api/settings/system/action")
    async def maintenance_action(data: MaintenanceActionInput, request: Request):
        async with mutation_lock:
            require_access(request, ("maintenance",))
            try:
                return await maintenance.schedule(data.action, data.confirmation)
            except MaintenanceError as error:
                raise HTTPException(error.status_code, str(error)) from None

    @app.get("/api/system/telemetry")
    def system_telemetry(request: Request):
        # The synchronous route runs in FastAPI's thread pool. Sampling never
        # sleeps or blocks the recording/live event loop to calculate CPU use.
        require_access(request, ("system",))
        result = telemetry.snapshot()
        result["version"] = __version__
        result["storage"] = storage_overview(result.get("disk", {}))
        result["recording"] = capacity.snapshot(result.get("disk", {}))
        require_access(request, ("system",))
        return result

    @app.get("/api/system/history")
    def system_history(request: Request, hours: int = Query(6, ge=1, le=168)):
        if hours not in {1, 6, 24, 168}:
            raise HTTPException(422, "Choose a supported history period.")
        require_access(request, ("system",))
        result = history.read(hours=hours)
        require_access(request, ("system",))
        return result

    @app.get("/api/system")
    def system(request: Request):
        require_access(request, ("system",))
        disk = shutil.disk_usage(settings.recordings_dir)
        storage = archive_storage_status(disk)
        return {"version": __version__, "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
                "recordings_bytes": store.recording_bytes(), "segment_seconds": settings.segment_seconds,
                "min_free_bytes": storage["reserve_bytes"], "storage": storage,
                "ffmpeg_available": bool(shutil.which(settings.ffmpeg) and shutil.which(settings.ffprobe))}

    static = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=static), name="static")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html")

    return app
