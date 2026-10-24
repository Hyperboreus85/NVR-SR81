"""Authenticated same-origin HTTP API and bundled offline interface."""
import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path
import shutil
import re
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import __version__
from .config import Settings
from .discovery import DiscoveryError, discover, list_interfaces, scan_network
from .live import LiveError, LiveManager
from .languages import LanguageError, LanguageManager, MAX_PACK_BYTES
from .media import MediaManager
from .onvif import get_profiles
from .security import Auth, redact_url, validate_stream_url
from .store import Store

LIVE_AUTH_CHECK_SECONDS = 15


class CameraInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str | None = Field(default=None, max_length=4096)
    preview_url: str | None = Field(default=None, max_length=4096)
    enabled: bool = True
    audio_mode: Literal["copy", "none"] = "copy"
    retention_days: int = Field(default=7, ge=1, le=3650)


class LoginInput(BaseModel):
    password: str = Field(max_length=1024)


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


def create_app(settings: Settings | None = None, media_factory=MediaManager, live_factory=LiveManager):
    settings = settings or Settings()
    if settings.password and len(settings.password) < 12:
        raise ValueError("NVR_ADMIN_PASSWORD must contain at least 12 characters")
    store = Store(settings.data_dir)
    auth = Auth(store, settings.password)
    languages = LanguageManager(settings.data_dir / "languages", Path(__file__).parent / "locales")
    languages.migrate_legacy(store)
    media = media_factory(settings, store)
    realtime = live_factory(settings)
    media_jobs = asyncio.Semaphore(2)
    onvif_jobs = asyncio.Semaphore(2)
    discovery_lock = asyncio.Lock()
    active_scan: asyncio.Task | None = None
    active_scan_session: str | None = None
    login_jobs = asyncio.Semaphore(2)
    mutation_lock = asyncio.Lock()

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
            yield
        finally:
            if active_scan is not None:
                active_scan.cancel()
                await asyncio.gather(active_scan, return_exceptions=True)
            await realtime.stop()
            await media.stop()
            lock.close()

    app = FastAPI(title="NVR-SR81", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.media = store, media
    app.state.settings, app.state.auth = settings, auth
    app.state.realtime = realtime
    app.state.languages = languages

    @app.middleware("http")
    async def access_control(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if request.headers.get("x-nvr-request") != "1":
                    return JSONResponse({"detail": "Invalid request"}, status_code=403)
                origin = request.headers.get("origin")
                if origin and origin != str(request.base_url).rstrip("/"):
                    return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
            public = request.url.path in {"/api/session", "/api/login"}
            if request.method == "GET":
                language_path = re.fullmatch(r"/api/languages/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)", request.url.path)
                public = public or request.url.path == "/api/languages" or bool(
                    language_path and len(language_path.group(1)) <= 35)
            if not public and not auth.valid(request.cookies.get("nvr_session")):
                return JSONResponse({"detail": "Authentication required"}, status_code=401)
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
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # The default validation handler echoes inputs, including credentials.
        return JSONResponse({"detail": "Invalid data: check the fields you entered"}, status_code=422)

    @app.exception_handler(LanguageError)
    async def invalid_language_pack(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    def camera_or_404(camera_id):
        camera = store.get_camera(camera_id)
        if camera is None:
            raise HTTPException(404, "Camera not found")
        return camera

    def recording_or_404(recording_id):
        recording = store.get_recording(recording_id)
        if recording is None:
            raise HTTPException(404, "Recording not found")
        path = (settings.recordings_dir / recording["path"]).resolve()
        if not path.is_relative_to(settings.recordings_dir) or not path.is_file():
            raise HTTPException(404, "Recording file unavailable")
        return recording, path

    def public_camera(camera):
        return {key: value for key, value in camera.items() if key not in {"url", "preview_url"}} | {
            "source": redact_url(camera["url"]),
            "preview_source": redact_url(camera["preview_url"]),
            "status": media.camera_status(camera["id"]),
        }

    async def media_result(operation):
        try:
            async with media_jobs:
                return await operation()
        except (ValueError, RuntimeError, OSError, asyncio.TimeoutError):
            raise HTTPException(503, "Media operation failed. Check the stream and FFmpeg.") from None

    @app.get("/healthz")
    def health():
        return {"status": "ok", "version": __version__}

    @app.get("/api/session")
    def session(request: Request):
        return {"authenticated": auth.valid(request.cookies.get("nvr_session"))}

    @app.post("/api/login")
    async def login(data: LoginInput, request: Request):
        host = request.client.host if request.client else "local"
        async with login_jobs:
            accepted = await asyncio.to_thread(auth.check, data.password, host)
        if not accepted:
            raise HTTPException(401, "Invalid password or too many attempts. Wait one minute.")
        response = JSONResponse({"authenticated": True})
        response.set_cookie("nvr_session", auth.login(), httponly=True, secure=settings.secure_cookie,
                            samesite="strict", max_age=12*3600)
        return response

    @app.post("/api/logout")
    async def logout(request: Request):
        session_token = request.cookies.get("nvr_session")
        await cancel_owned_scan(session_token)
        auth.sessions.pop(session_token, None)
        response = JSONResponse({"authenticated": False})
        response.delete_cookie("nvr_session")
        return response

    @app.get("/api/cameras")
    def cameras():
        return [public_camera(camera) for camera in store.list_cameras()]

    @app.get("/api/languages")
    def available_languages():
        return languages.list()

    # Keep the authenticated template route before the locale path route.
    @app.get("/api/languages/template")
    def language_template():
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
            if not auth.valid(request.cookies.get("nvr_session")):
                raise HTTPException(401, "Authentication required")
            return languages.install(pack)

    @app.get("/api/languages/{locale}")
    def language_pack(locale: str):
        return languages.get(locale)

    @app.delete("/api/languages/{locale}")
    async def delete_language(locale: str, request: Request):
        async with mutation_lock:
            if not auth.valid(request.cookies.get("nvr_session")):
                raise HTTPException(401, "Authentication required")
            return languages.delete(locale)

    def validated_camera(data, previous=None):
        values = data.model_dump()
        values["name"] = values["name"].strip()
        if not values["name"]:
            raise HTTPException(422, "Enter a name")
        for field in ("url", "preview_url"):
            value = values[field]
            if value is None:
                value = previous[field] if previous else ""
            if field == "url" and not value:
                raise HTTPException(422, "Enter the main stream")
            try:
                values[field] = validate_stream_url(value) if value else ""
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        return values

    @app.post("/api/cameras", status_code=201)
    async def add_camera(data: CameraInput):
        async with mutation_lock:
            if len(store.list_cameras()) >= 32:
                raise HTTPException(422, "This version supports up to 32 cameras")
            camera = store.save_camera(validated_camera(data))
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        return public_camera(camera)

    @app.put("/api/cameras/{camera_id}")
    async def update_camera(camera_id: str, data: CameraInput):
        async with mutation_lock:
            previous = camera_or_404(camera_id)
            camera = store.save_camera(validated_camera(data, previous), camera_id)
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        return public_camera(camera)

    @app.delete("/api/cameras/{camera_id}")
    async def delete_camera(camera_id: str):
        async with mutation_lock:
            camera_or_404(camera_id)
            store.delete_camera(camera_id)
            await media.reconcile()
            await realtime.reconcile(store.list_cameras())
        return {"deleted": True, "recordings_preserved": True}

    @app.post("/api/cameras/{camera_id}/probe")
    async def probe(camera_id: str):
        camera = camera_or_404(camera_id)
        return await media_result(lambda: media.probe(camera["url"]))

    @app.get("/api/cameras/{camera_id}/snapshot")
    async def snapshot(camera_id: str):
        from fastapi.responses import Response
        camera = camera_or_404(camera_id)
        data = await media_result(lambda: media.snapshot(camera))
        return Response(data, media_type="image/jpeg")

    @app.get("/api/cameras/{camera_id}/live")
    async def live(camera_id: str):
        camera = camera_or_404(camera_id)
        return StreamingResponse(media.live(camera), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/api/cameras/{camera_id}/live.mp4")
    async def live_video(camera_id: str, compatible: bool = False):
        camera = camera_or_404(camera_id)
        try:
            subscription = await realtime.open(camera, compatible=compatible)
        except LiveError as error:
            status = getattr(error, "status_code", 503)
            raise HTTPException(status if status in {422, 429, 503, 504} else 503, str(error)) from None
        except (OSError, asyncio.TimeoutError):
            raise HTTPException(503, "Live view unavailable. Check the camera stream.") from None
        return StreamingResponse(
            subscription.stream(), media_type=subscription.mime,
            headers={"X-NVR-Live-Mode": subscription.mode, "X-Accel-Buffering": "no"},
            background=BackgroundTask(subscription.close),
        )

    @app.get("/api/live/status")
    async def live_status():
        current = realtime.status()
        fields = ("active_streams", "max_streams", "active_transcodes", "max_transcodes")
        return {field: current.get(field, 0) for field in fields} | {
            "streams": [{key: value for key, value in stream.items()
                         if key in {"camera_id", "mode", "viewers", "state", "codec"}}
                        for stream in current.get("streams", [])],
        }

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
        if not auth.valid(session_token):
            await websocket.close(code=4401)
            return
        subscription = None
        opening = watching = sending = None

        async def watch_client():
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), LIVE_AUTH_CHECK_SECONDS)
                except asyncio.TimeoutError:
                    if not auth.valid(session_token):
                        await websocket.close(code=4401)
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
            camera = camera_or_404(camera_id)
            watching = asyncio.create_task(watch_client())
            opening = asyncio.create_task(realtime.open(camera, compatible=compatible))
            finished, _ = await asyncio.wait((opening, watching), return_when=asyncio.FIRST_COMPLETED)
            if watching in finished:
                return
            subscription = await opening
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
    def recordings(camera_id: str | None = None, start: float | None = Query(None, ge=0),
                   end: float | None = Query(None, ge=0), limit: int = Query(2000, ge=1, le=10000)):
        if start is not None and end is not None and end <= start:
            raise HTTPException(422, "Invalid time range")
        return [{key: value for key, value in row.items() if key != "path"}
                for row in store.list_recordings(camera_id, start, end, limit)]

    @app.get("/api/recordings/{recording_id}/download")
    def download(recording_id: str):
        recording, path = recording_or_404(recording_id)
        return FileResponse(path, media_type="video/x-matroska", filename=path.name)

    @app.get("/api/recordings/{recording_id}/playback")
    async def playback(recording_id: str, compatible: bool = False):
        recording, _ = recording_or_404(recording_id)
        path = await media_result(lambda: media.playback(recording, compatible))
        return FileResponse(path, media_type="video/mp4")

    @app.get("/api/recordings/{recording_id}/waveform")
    async def waveform(recording_id: str):
        recording, _ = recording_or_404(recording_id)
        return await media_result(lambda: media.waveform(recording))

    @app.get("/api/onvif/interfaces")
    async def onvif_interfaces():
        try:
            return await asyncio.to_thread(list_interfaces)
        except OSError:
            raise HTTPException(503, "Unable to read the server network interfaces.") from None

    async def run_discovery(request: Request, operation, timeout):
        nonlocal active_scan, active_scan_session
        if discovery_lock.locked():
            raise HTTPException(409, "A search is already running. Wait for it to finish.")
        try:
            async with discovery_lock:
                job = asyncio.create_task(asyncio.wait_for(operation(), timeout))
                active_scan = job
                active_scan_session = request.cookies.get("nvr_session")
                try:
                    return await job
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
    async def onvif(data: OnvifInput):
        try:
            async with onvif_jobs:
                return await asyncio.wait_for(get_profiles(data.endpoint, data.username, data.password), 90)
        except asyncio.TimeoutError:
            raise HTTPException(504, "The camera did not finish returning its profiles. Try again or check its ONVIF services.") from None
        except (ValueError, RuntimeError, OSError):
            raise HTTPException(422, "ONVIF unavailable. Check the endpoint, credentials and camera clock.") from None

    @app.get("/api/system")
    def system():
        disk = shutil.disk_usage(settings.recordings_dir)
        return {"version": __version__, "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
                "recordings_bytes": store.recording_bytes(), "segment_seconds": settings.segment_seconds,
                "min_free_bytes": settings.min_free_bytes,
                "ffmpeg_available": bool(shutil.which(settings.ffmpeg) and shutil.which(settings.ffprobe))}

    static = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=static), name="static")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html")

    return app
