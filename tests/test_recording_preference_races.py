"""Recording preferences remain consistent across logout and request cancellation."""
import asyncio

import httpx
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.preferences import SEGMENT_PREFERENCE_KEY


PASSWORD = "recording-race-test-password"
HEADERS = {"X-NVR-Request": "1"}
ENDPOINT = "/api/settings/recording"


class PausingMedia:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.entered = asyncio.Event()
        self.resume = asyncio.Event()
        self.applied = asyncio.Event()
        self.stopped = asyncio.Event()
        self.calls = []
        self.events = []

    async def start(self):
        self.events.append("started")

    async def stop(self):
        self.events.append("stopped")
        self.stopped.set()

    async def set_segment_seconds(self, seconds):
        self.calls.append(seconds)
        self.events.append("applying")
        if len(self.calls) == 1:
            self.entered.set()
            await self.resume.wait()
        self.settings.segment_seconds = seconds
        self.events.append("applied")
        self.applied.set()


def make_app(tmp_path):
    configured = Settings(data_dir=tmp_path / "data", recordings_dir=tmp_path / "recordings",
                          password=PASSWORD, segment_seconds=1800)
    return create_app(configured, media_factory=PausingMedia)


async def login(client):
    response = await client.post("/api/login", json={"password": PASSWORD}, headers=HEADERS)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_queued_recording_save_rechecks_session_after_logout(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    media = app.state.media
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await login(client)
            first = asyncio.create_task(client.put(ENDPOINT, json={"segment_minutes": 60}, headers=HEADERS))
            second = None
            try:
                await asyncio.wait_for(media.entered.wait(), 5)
                assert app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == "3600"

                # Observe the second request's successful middleware check while
                # the first save still holds the mutation lock inside rollover.
                second_authenticated = asyncio.Event()
                principal = app.state.auth.principal

                def observed_principal(token):
                    accepted = principal(token)
                    if accepted is not None:
                        second_authenticated.set()
                    return accepted

                monkeypatch.setattr(app.state.auth, "principal", observed_principal)
                second = asyncio.create_task(client.put(ENDPOINT, json={"segment_minutes": 120}, headers=HEADERS))
                await asyncio.wait_for(second_authenticated.wait(), 5)
                assert not first.done() and not second.done()
                assert (await client.post("/api/logout", headers=HEADERS)).status_code == 200

                media.resume.set()
                first_response, second_response = await asyncio.wait_for(asyncio.gather(first, second), 5)
                assert first_response.status_code == 200
                assert second_response.status_code == 401
                assert second_response.json() == {"detail": "Authentication required"}
                assert media.calls == [3600]
                assert app.state.settings.segment_seconds == 3600
                assert app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == "3600"
            finally:
                media.resume.set()
                pending = [task for task in (first, second) if task is not None]
                for task in pending:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_cancelled_save_finishes_before_lifespan_stops_recorder(tmp_path):
    app = make_app(tmp_path)
    media = app.state.media
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    request = shutdown = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            await login(client)
            request = asyncio.create_task(client.put(ENDPOINT, json={"segment_minutes": 120}, headers=HEADERS))
            await asyncio.wait_for(media.entered.wait(), 5)
            assert app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == "7200"

            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert not media.applied.is_set()

            shutdown_entered = asyncio.Event()

            async def stop_application():
                shutdown_entered.set()
                await lifespan.__aexit__(None, None, None)

            shutdown = asyncio.create_task(stop_application())
            await asyncio.wait_for(shutdown_entered.wait(), 5)
            assert not shutdown.done()
            assert not media.stopped.is_set()

            media.resume.set()
            await asyncio.wait_for(shutdown, 5)
            assert media.calls == [7200]
            assert media.events == ["started", "applying", "applied", "stopped"]
            assert app.state.settings.segment_seconds == 7200
            assert app.state.store.meta_get(SEGMENT_PREFERENCE_KEY) == "7200"
    finally:
        media.resume.set()
        if request is not None:
            if not request.done():
                request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        if shutdown is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await asyncio.gather(shutdown, return_exceptions=True)
