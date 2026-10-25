"""An original-file response keeps its source until all response I/O finishes."""
import httpx
import pytest
from nvr.app import create_app
from nvr.config import Settings


@pytest.mark.asyncio
async def test_original_range_download_pins_source_while_sending_and_releases_afterwards(tmp_path):
    settings=Settings(data_dir=tmp_path/'data',recordings_dir=tmp_path/'recordings',password='download-lease-test-password')
    app=create_app(settings)
    path=settings.recordings_dir/'camera'/'1700000000000-000000.mkv'
    path.parent.mkdir(); path.write_bytes(b'0123456789'*200)
    identity=app.state.store.add_recording('camera',path.relative_to(settings.recordings_dir).as_posix(),100,60,path.stat().st_size,'h264')
    checked=[]
    async def wrapped(scope,receive,send):
        async def observe(message):
            if scope['path'].endswith('/download') and message['type']=='http.response.start' and message['status']==206:
                assert app.state.media._in_use.get(path)==1
                checked.append(True)
            await send(message)
        await app(scope,receive,observe)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=wrapped),base_url='http://testserver') as client:
            route=f'/api/recordings/{identity}/download'
            assert (await client.get(route)).status_code==401
            assert not app.state.media._in_use
            assert (await client.post('/api/login',json={'password':settings.password},headers={'X-NVR-Request':'1'})).status_code==200
            response=await client.get(route,headers={'Range':'bytes=0-127'})
            assert response.status_code==206 and response.content==path.read_bytes()[:128]
            assert checked and not app.state.media._in_use
            assert response.headers['content-disposition'].startswith('attachment;')
    finally:
        await app.state.media.stop(); await app.state.realtime.stop()
