"""Background analysis must never hold up a cached video or its byte ranges."""
import asyncio
from contextlib import asynccontextmanager
import os

import httpx
import pytest

from nvr.app import create_app
from nvr.config import Settings
from nvr.media import MediaManager


class AdmissionMedia:
    def __init__(self, settings, store):
        self.settings = settings
        self.started = {name: asyncio.Event() for name in ('motion', 'waveform')}
        self.release = asyncio.Event()
        self.leases = 0

    @asynccontextmanager
    async def playback_lease(self, recording, compatible=False):
        self.leases += 1
        try:
            yield self.settings.recordings_dir / 'cached.mp4'
        finally:
            self.leases -= 1

    def download_lease(self, recording):
        return self.playback_lease(recording, True)

    async def motion(self, recording, sensitivity='medium'):
        self.started['motion'].set()
        await self.release.wait()
        return {'events': []}

    async def waveform(self, recording):
        self.started['waveform'].set()
        await self.release.wait()
        return {'peaks': []}


@pytest.mark.asyncio
async def test_cached_playback_and_download_range_bypass_two_waiting_analyses(tmp_path):
    settings = Settings(data_dir=tmp_path/'data', recordings_dir=tmp_path/'recordings',
                        password='playback-admission-test-password')
    app = create_app(settings, media_factory=AdmissionMedia)
    (settings.recordings_dir/'source.mkv').write_bytes(b'original')
    payload = b'cached-mp4-test-bytes'
    (settings.recordings_dir/'cached.mp4').write_bytes(payload)
    identity = app.state.store.add_recording('camera', 'source.mkv', 100, 60, 8, 'h264', 'pcm_mulaw')
    path = f'/api/recordings/{identity}'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        assert (await client.post('/api/login', json={'password':settings.password},
                                  headers={'X-NVR-Request':'1'})).status_code == 200
        pending = [asyncio.create_task(client.get(path+'/'+operation)) for operation in ('motion', 'waveform')]
        try:
            await asyncio.wait_for(asyncio.gather(*(event.wait() for event in app.state.media.started.values())), 2)
            video = await asyncio.wait_for(client.get(path+'/playback', headers={'Range':'bytes=0-5'}), 2)
            assert video.status_code == 206
            assert video.content == payload[:6]
            assert video.headers['accept-ranges'] == 'bytes'
            assert video.headers['content-range'] == f'bytes 0-5/{len(payload)}'
            assert app.state.media.leases == 0
            download = await asyncio.wait_for(client.get(path+'/download.mp4'), 2)
            assert download.status_code == 200
            assert download.content == payload
            assert download.headers['content-type'] == 'video/mp4'
            assert download.headers['content-disposition'].startswith('attachment;')
            assert download.headers['content-disposition'].endswith('-compatible.mp4"')
            assert app.state.media.leases == 0
        finally:
            app.state.media.release.set()
            await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_compatible_download_requires_login_and_refuses_missing_or_outside_sources(tmp_path):
    settings = Settings(data_dir=tmp_path/'data', recordings_dir=tmp_path/'recordings',
                        password='playback-admission-test-password')
    app = create_app(settings, media_factory=AdmissionMedia)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        assert (await client.get('/api/recordings/missing/download.mp4')).status_code == 401
        await client.post('/api/login', json={'password':settings.password}, headers={'X-NVR-Request':'1'})
        outside = tmp_path/'outside.mkv'
        outside.write_bytes(b'private')
        identity = app.state.store.add_recording('camera', str(outside), 100, 60, 7, 'h264')
        assert (await client.get('/api/recordings/missing/download.mp4')).status_code == 404
        result = await client.get(f'/api/recordings/{identity}/download.mp4')
        assert result.status_code == 404
        assert str(outside) not in result.text


@pytest.mark.asyncio
async def test_firefox_if_range_etag_remains_valid_after_repeated_playback_cache_hits(tmp_path):
    settings = Settings(data_dir=tmp_path/'data', recordings_dir=tmp_path/'recordings',
                        password='playback-admission-test-password')
    app = create_app(settings)
    source = settings.recordings_dir/'source.mkv'
    source.write_bytes(b'original recording')
    identity = app.state.store.add_recording('camera', 'source.mkv', 100, 60, source.stat().st_size, 'h264', 'pcm_mulaw')
    recording = app.state.store.get_recording(identity)
    cached = app.state.media._cache_path(recording, 'copy-v1', 'mp4')
    payload = b'cached-mp4-test-bytes'
    cached.write_bytes(payload)
    os.utime(cached, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    previous_mtime = cached.stat().st_mtime_ns
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        await client.post('/api/login', json={'password':settings.password}, headers={'X-NVR-Request':'1'})
        path = f'/api/recordings/{identity}/playback'
        first = await client.get(path, headers={'Range':'bytes=0-4'})
        assert first.status_code == 206
        etag = first.headers['etag']
        second = await client.get(path, headers={'Range':'bytes=5-9','If-Range':etag})
        assert second.status_code == 206
        assert second.headers['etag'] == etag
        assert second.content == payload[5:10]
        assert cached.stat().st_mtime_ns == previous_mtime
        assert not app.state.media._cache_leases

