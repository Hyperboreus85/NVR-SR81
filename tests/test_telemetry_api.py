"""The OS collector is private, lazy, and independent of ordinary settings."""
from fastapi.testclient import TestClient

from nvr.app import create_app
from nvr.config import Settings
from nvr import __version__


class QuietMedia:
    def __init__(self,settings,store): pass
    async def start(self): pass
    async def stop(self): pass


class Collector:
    def __init__(self,recordings_dir): self.directory=recordings_dir; self.calls=0
    def snapshot(self):
        self.calls+=1
        return {'sampled_at':100+self.calls,'scope':'container','cpu':{'percent':self.calls*10},
                'memory':{'used':100,'total':1000},'swap':{'used':0,'total':0},
                'disk':{'recordings':{'used':250,'total':1000,'free':750}}}


class Capacity:
    def __init__(self,settings,store,media): self.calls=0; self.settings=settings; self.store=store; self.media=media
    def snapshot(self,disk):
        self.calls+=1
        assert disk['recordings']['free']==750
        return {'active_cameras':2,'estimated_cameras':2,'remaining_seconds':250,'bytes_per_second':1,'reason':None}


def test_telemetry_requires_login_and_returns_uncached_samples_without_polling_settings(tmp_path):
    settings=Settings(data_dir=tmp_path/'data',recordings_dir=tmp_path/'recordings',password='telemetry-test-password')
    app=create_app(settings,media_factory=QuietMedia,telemetry_factory=Collector,capacity_factory=Capacity)
    collector=app.state.telemetry
    assert collector.directory==settings.recordings_dir and collector.calls==0
    with TestClient(app) as client:
        assert client.get('/api/system/telemetry').status_code==401
        assert collector.calls==0
        assert app.state.capacity.calls==0
        assert client.post('/api/login',json={'password':settings.password},headers={'X-NVR-Request':'1'}).status_code==200
        assert client.get('/api/system').status_code==200
        assert collector.calls==0
        assert app.state.capacity.calls==0
        first=client.get('/api/system/telemetry')
        second=client.get('/api/system/telemetry')
        assert first.status_code==second.status_code==200
        assert first.headers['cache-control']==second.headers['cache-control']=='no-store'
        assert first.json()['cpu']['percent']==10 and second.json()['cpu']['percent']==20
        assert first.json()['version']==__version__
        assert first.json()['recording']['active_cameras']==2
        assert second.json()['recording']['remaining_seconds']==250
        assert app.state.capacity.calls==2
        assert collector.calls==2
        client.post('/api/logout',headers={'X-NVR-Request':'1'})
        assert client.get('/api/system/telemetry').status_code==401
        assert collector.calls==2


def test_collector_belongs_to_one_app_instance(tmp_path):
    apps=[create_app(Settings(data_dir=tmp_path/str(index)/'data',recordings_dir=tmp_path/str(index)/'recordings',
                              password='telemetry-test-password'),media_factory=QuietMedia,telemetry_factory=Collector)
          for index in range(2)]
    assert apps[0].state.telemetry is not apps[1].state.telemetry
    assert apps[0].state.telemetry.directory!=apps[1].state.telemetry.directory

