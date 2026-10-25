"""Three private stream URLs and safe, structured camera editing over the API."""
from urllib.parse import unquote, urlsplit

from fastapi.testclient import TestClient
import pytest

from nvr.app import create_app
from nvr.config import Settings


PASSWORD = 'structured-camera-test-password'
HEADERS = {'X-NVR-Request': '1'}


class CameraMedia:
    def __init__(self, settings, store): self.probes = []
    async def start(self): pass
    async def stop(self): pass
    async def reconcile(self): pass
    def camera_status(self, identity): return {'state': 'stopped', 'message': 'Test'}
    async def probe(self, source):
        self.probes.append(source)
        return {'video_codec': 'h264'}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path/'data', recordings_dir=tmp_path/'recordings',
                              password=PASSWORD), media_factory=CameraMedia)
    with TestClient(app) as client:
        yield client


def login(client):
    assert client.post('/api/login', json={'password': PASSWORD}, headers=HEADERS).status_code == 200


def draft(**changes):
    value = {'name': 'Entrance', 'connection': {'protocol':'rtsp','host':'192.168.1.60','port':8554,
                'username':'cam-user', 'password':'p@ss:/? word'},
             'streams': {'main':'/main?token=private-token','sub':'/sub','third':'/third'}, 'live_stream':3}
    return value | changes


def test_structured_create_encrypts_three_streams_and_returns_no_credentials_or_paths(client):
    payload = draft()
    assert client.post('/api/cameras', json=payload, headers=HEADERS).status_code == 401
    login(client)
    response = client.post('/api/cameras', json=payload, headers=HEADERS)
    assert response.status_code == 201
    camera = response.json()
    assert camera['connection'] == {'protocol':'rtsp', 'host':'192.168.1.60', 'port':8554,
                                    'has_username':True,'has_password':True}
    assert all(camera['streams'][slot]['configured'] for slot in ('main','sub','third'))
    assert camera['live_stream'] == 3 and camera['third_source'].startswith('rtsp://192.168.1.60:8554/')
    for forbidden in ('cam-user','p@ss','private-token','/main?','/sub','/third'):
        assert forbidden not in response.text and forbidden not in client.get('/api/cameras').text
    raw = client.app.state.store.get_camera(camera['id'])
    for field, path in [('url','/main'),('preview_url','/sub'),('third_url','/third')]:
        parsed = urlsplit(raw[field])
        assert parsed.path == path and parsed.port == 8554
        assert unquote(parsed.username) == 'cam-user' and unquote(parsed.password) == 'p@ss:/? word'
    with client.app.state.store.connect() as database:
        stored = str([tuple(row) for row in database.execute('SELECT * FROM cameras')])
        stored += str([tuple(row) for row in database.execute('SELECT * FROM camera_extras')])
    assert 'cam-user' not in stored and 'private-token' not in stored and 'p@ss' not in stored


def test_edit_keeps_saved_secrets_query_and_untouched_optional_streams(client):
    login(client)
    identity = client.post('/api/cameras', json=draft(), headers=HEADERS).json()['id']
    response = client.put('/api/cameras/'+identity, headers=HEADERS, json=draft(
        name='New entrance', connection={'protocol':'rtsp','host':'192.168.1.61','port':554,
                                        'username':None,'password':None},
        streams={'main':'/updated','sub':None,'third':None}, live_stream=2))
    assert response.status_code == 200
    raw = client.app.state.store.get_camera(identity)
    assert urlsplit(raw['url']).query == 'token=private-token'
    assert urlsplit(raw['url']).path == '/updated'
    assert all(urlsplit(raw[field]).hostname == '192.168.1.61' for field in ('url','preview_url','third_url'))
    assert unquote(urlsplit(raw['url']).password) == 'p@ss:/? word'
    assert client.put('/api/cameras/'+identity, headers=HEADERS,
                      json={'name':'Only a name edit'}).status_code == 200
    assert client.app.state.store.get_camera(identity)['third_url'] == raw['third_url']


def test_optional_stream_removal_and_explicit_credential_clear(client):
    login(client)
    identity = client.post('/api/cameras', json=draft(), headers=HEADERS).json()['id']
    response = client.put('/api/cameras/'+identity, headers=HEADERS, json=draft(
        connection={'protocol':'rtsp','host':'192.168.1.60','port':8554,'username':'','password':''},
        streams={'main':'/main?','sub':'','third':''}, live_stream=1))
    assert response.status_code == 200
    raw = client.app.state.store.get_camera(identity)
    assert raw['preview_url'] == raw['third_url'] == ''
    assert urlsplit(raw['url']).username is None and urlsplit(raw['url']).password is None
    assert not urlsplit(raw['url']).query


def test_probe_selects_only_requested_saved_stream_and_does_not_return_source(client):
    login(client)
    identity = client.post('/api/cameras', json=draft(), headers=HEADERS).json()['id']
    raw = client.app.state.store.get_camera(identity)
    for slot, field in [(1,'url'),(2,'preview_url'),(3,'third_url')]:
        result = client.post(f'/api/cameras/{identity}/probe?stream={slot}', headers=HEADERS)
        assert result.status_code == 200 and result.json() == {'video_codec':'h264'}
        assert client.app.state.media.probes[-1] == raw[field]
    for slot in (0,4,'oops'):
        assert client.post(f'/api/cameras/{identity}/probe?stream={slot}',headers=HEADERS).status_code == 422
    assert len(client.app.state.media.probes) == 3
    other = client.post('/api/cameras', json={'name':'Main only','url':'rtsp://camera.local/main'},headers=HEADERS).json()['id']
    missing = client.post(f'/api/cameras/{other}/probe?stream=3',headers=HEADERS)
    assert missing.status_code == 422 and 'not configured' in missing.json()['detail']


@pytest.mark.parametrize('changes', [
    {'connection':{'protocol':'file','host':'127.0.0.1'}},
    {'connection':{'protocol':'rtsp','host':'host/path','port':554}},
    {'connection':{'protocol':'rtsp','host':'host','port':0}},
    {'connection':{'protocol':'rtsp','host':'host','port':True}},
    {'connection':{'protocol':'rtsp','host':'host','command':'do-not-run'}},
    {'streams':{'main':'file:///private-camera-secret'}},
    {'streams':{'main':'/ok','fourth':'/unsupported'}},
    {'streams':{'main':'/ok','third':''},'live_stream':3},
    {'live_stream':True},
])
def test_invalid_structured_fields_do_not_echo_credentials_or_create_camera(client,changes):
    login(client)
    result=client.post('/api/cameras', json=draft(**changes),headers=HEADERS)
    assert result.status_code == 422
    assert 'p@ss' not in result.text and 'private-camera-secret' not in result.text
    assert client.get('/api/cameras').json() == []

