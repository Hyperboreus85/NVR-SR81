"""Authenticated same-origin HTTP API and bundled offline interface."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import shutil
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .discovery import DiscoveryError, discover, list_interfaces, scan_network
from .media import MediaManager
from .onvif import get_profiles
from .security import Auth, redact_url, validate_stream_url
from .store import Store


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


def create_app(settings: Settings | None = None, media_factory=MediaManager):
    settings = settings or Settings()
    if settings.password and len(settings.password) < 12:
        raise ValueError("NVR_ADMIN_PASSWORD deve contenere almeno 12 caratteri")
    store = Store(settings.data_dir)
    auth = Auth(store, settings.password)
    media = media_factory(settings, store)
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
                raise RuntimeError("Un'altra istanza usa già questa directory dati") from None
        try:
            await media.start()
            yield
        finally:
            if active_scan is not None:
                active_scan.cancel()
                await asyncio.gather(active_scan, return_exceptions=True)
            await media.stop()
            lock.close()

    app = FastAPI(title="NVR-SR81", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.media = store, media
    app.state.settings, app.state.auth = settings, auth

    @app.middleware("http")
    async def access_control(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if request.headers.get("x-nvr-request") != "1":
                    return JSONResponse({"detail": "Richiesta non valida"}, status_code=403)
                origin = request.headers.get("origin")
                if origin and origin != str(request.base_url).rstrip("/"):
                    return JSONResponse({"detail": "Origine non consentita"}, status_code=403)
            public = request.url.path in {"/api/session", "/api/login"}
            if not public and not auth.valid(request.cookies.get("nvr_session")):
                return JSONResponse({"detail": "Accesso richiesto"}, status_code=401)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' blob: data:; media-src 'self' blob:; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        # The default validation handler echoes inputs, including credentials.
        return JSONResponse({"detail": "Dati non validi: controllare i campi inseriti"}, status_code=422)

    def camera_or_404(camera_id):
        camera = store.get_camera(camera_id)
        if camera is None:
            raise HTTPException(404, "Telecamera non trovata")
        return camera

    def recording_or_404(recording_id):
        recording = store.get_recording(recording_id)
        if recording is None:
            raise HTTPException(404, "Registrazione non trovata")
        path = (settings.recordings_dir / recording["path"]).resolve()
        if not path.is_relative_to(settings.recordings_dir) or not path.is_file():
            raise HTTPException(404, "File della registrazione non disponibile")
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
            raise HTTPException(503, "Operazione multimediale non riuscita. Controllare il flusso e FFmpeg.") from None

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
            raise HTTPException(401, "Password non valida o troppi tentativi. Attendere un minuto.")
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

    def validated_camera(data, previous=None):
        values = data.model_dump()
        values["name"] = values["name"].strip()
        if not values["name"]:
            raise HTTPException(422, "Inserire un nome")
        for field in ("url", "preview_url"):
            value = values[field]
            if value is None:
                value = previous[field] if previous else ""
            if field == "url" and not value:
                raise HTTPException(422, "Inserire il flusso principale")
            try:
                values[field] = validate_stream_url(value) if value else ""
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
        return values

    @app.post("/api/cameras", status_code=201)
    async def add_camera(data: CameraInput):
        async with mutation_lock:
            if len(store.list_cameras()) >= 32:
                raise HTTPException(422, "Questa prima versione gestisce al massimo 32 telecamere")
            camera = store.save_camera(validated_camera(data))
            await media.reconcile()
        return public_camera(camera)

    @app.put("/api/cameras/{camera_id}")
    async def update_camera(camera_id: str, data: CameraInput):
        async with mutation_lock:
            previous = camera_or_404(camera_id)
            camera = store.save_camera(validated_camera(data, previous), camera_id)
            await media.reconcile()
        return public_camera(camera)

    @app.delete("/api/cameras/{camera_id}")
    async def delete_camera(camera_id: str):
        async with mutation_lock:
            camera_or_404(camera_id)
            store.delete_camera(camera_id)
            await media.reconcile()
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

    @app.get("/api/recordings")
    def recordings(camera_id: str | None = None, start: float | None = Query(None, ge=0),
                   end: float | None = Query(None, ge=0), limit: int = Query(2000, ge=1, le=10000)):
        if start is not None and end is not None and end <= start:
            raise HTTPException(422, "Intervallo temporale non valido")
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
            raise HTTPException(503, "Impossibile leggere le interfacce di rete del server.") from None

    async def run_discovery(request: Request, operation, timeout):
        nonlocal active_scan, active_scan_session
        if discovery_lock.locked():
            raise HTTPException(409, "Una ricerca è già in corso. Attendere il completamento.")
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
                    raise HTTPException(499, "Ricerca annullata.") from None
                finally:
                    job.cancel()
                    await asyncio.gather(job, return_exceptions=True)
                    if active_scan is job:
                        active_scan = None
                        active_scan_session = None
        except DiscoveryError as error:
            raise HTTPException(422, str(error)) from None
        except asyncio.TimeoutError:
            raise HTTPException(504, "Ricerca terminata per limite di tempo. Provare un intervallo più piccolo.") from None
        except OSError:
            raise HTTPException(503, "Ricerca non disponibile. Verificare rete e permessi del container.") from None

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
            raise HTTPException(409, "La ricerca attiva appartiene a un'altra sessione.")
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
            raise HTTPException(504, "La telecamera non ha completato la lettura dei profili. Riprovare o verificare i servizi ONVIF.") from None
        except (ValueError, RuntimeError, OSError):
            raise HTTPException(422, "ONVIF non disponibile. Verificare endpoint, credenziali e orologio della telecamera.") from None

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
