import asyncio
import base64
import hashlib
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import httpx
import pytest

from nvr import onvif


def soap(body):
    return httpx.Response(200, content=f'<s:Envelope xmlns:s="{onvif.SOAP}"><s:Body>{body}</s:Body></s:Envelope>')


def fault():
    return soap('<s:Fault xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Reason>Not supported</s:Reason></s:Fault>')


def use_transport(monkeypatch, handler):
    client_type = httpx.AsyncClient
    monkeypatch.setattr(onvif.httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs))


def request_operation(request):
    root = ET.fromstring(request.content)
    operation = root.find(f"{{{onvif.SOAP}}}Body")[0]
    return root, operation.tag.rsplit("}", 1)[-1], operation


def test_media2_profiles_and_wsse_digest(monkeypatch):
    seen = []
    username, password = "operatore&nvr", "p@ss:/? #!"

    def handler(request):
        root, operation, body = request_operation(request)
        seen.append(operation)
        token = root.find(f".//{{{onvif.WSSE}}}UsernameToken")
        assert token.find(f"{{{onvif.WSSE}}}Username").text == username
        created = token.find(f"{{{onvif.WSU}}}Created").text
        assert abs((datetime.now(timezone.utc) - datetime.fromisoformat(created.replace("Z", "+00:00"))).total_seconds()) < 30
        nonce = base64.b64decode(token.find(f"{{{onvif.WSSE}}}Nonce").text)
        expected = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
        assert token.find(f"{{{onvif.WSSE}}}Password").text == expected
        assert password not in request.content.decode()
        if operation == "GetServices":
            return soap(f'<GetServicesResponse xmlns="{onvif.DEVICE}"><Service><Namespace>{onvif.MEDIA2}</Namespace><XAddr>http://0.0.0.0:8080/onvif/media2</XAddr></Service></GetServicesResponse>')
        if operation == "GetCapabilities":
            return fault()
        assert request.url == "http://192.168.1.51:8080/onvif/media2"
        if operation == "GetProfiles":
            assert body.find(f"{{{onvif.MEDIA2}}}Type").text == "VideoEncoder"
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA2}"><Profiles token="main"><Name>Ingresso</Name><Configurations><VideoEncoder><Encoding>H265</Encoding></VideoEncoder></Configurations></Profiles></GetProfilesResponse>')
        assert operation == "GetStreamUri"
        assert body.find(f"{{{onvif.MEDIA2}}}Protocol").text == "RTSP"
        assert body.find(f"{{{onvif.MEDIA2}}}ProfileToken").text == "main"
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA2}"><Uri>rtsp://0.0.0.0:554/main?channel=1</Uri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://192.168.1.51/onvif/device_service", username, password))
    assert result == {"profiles": [{"token": "main", "name": "Ingresso", "encoding": "H265",
                                    "url": "rtsp://operatore%26nvr:p%40ss%3A%2F%3F%20%23%21@192.168.1.51:554/main?channel=1"}]}
    assert seen == ["GetServices", "GetCapabilities", "GetProfiles", "GetStreamUri"]


def test_media1_capabilities_fallback_and_http_digest(monkeypatch):
    challenged = False
    authenticated = False

    def handler(request):
        nonlocal challenged, authenticated
        if not request.headers.get("Authorization"):
            challenged = True
            return httpx.Response(401, headers={"WWW-Authenticate": 'Digest realm="camera", nonce="abc123", qop="auth", algorithm=MD5'})
        authenticated = True
        assert request.headers["Authorization"].startswith("Digest ")
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return fault()
        if operation == "GetCapabilities":
            return soap(f'<GetCapabilitiesResponse xmlns="{onvif.DEVICE}"><Capabilities><Media><XAddr>http://camera.local/onvif/media</XAddr></Media></Capabilities></GetCapabilitiesResponse>')
        if body.tag.startswith("{" + onvif.MEDIA2 + "}"):
            return fault()
        if operation == "GetProfiles":
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA1}" xmlns:tt="{onvif.SCHEMA}"><Profiles token="low"><tt:Name>Secondario</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding></tt:VideoEncoderConfiguration></Profiles></GetProfilesResponse>')
        assert request.url == "http://camera.local/onvif/media"
        assert body.find(f"{{{onvif.MEDIA1}}}StreamSetup/{{{onvif.SCHEMA}}}Stream").text == "RTP-Unicast"
        assert body.find(f".//{{{onvif.SCHEMA}}}Protocol").text == "RTSP"
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA1}" xmlns:tt="{onvif.SCHEMA}"><MediaUri><tt:Uri>rtsp://device:existing@camera.local/low</tt:Uri></MediaUri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera.local/onvif/device_service", "admin", "secret"))
    assert challenged and authenticated
    assert result["profiles"][0] == {"token": "low", "name": "Secondario", "encoding": "H264", "url": "rtsp://device:existing@camera.local/low"}


def test_advertised_media2_failure_falls_back_to_media1(monkeypatch):
    seen_namespaces = []

    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return soap(f'<GetServicesResponse xmlns="{onvif.DEVICE}"><Service><Namespace>{onvif.MEDIA2}</Namespace><XAddr>/media2</XAddr></Service><Service><Namespace>{onvif.MEDIA1}</Namespace><XAddr>/media1</XAddr></Service></GetServicesResponse>')
        if operation == "GetCapabilities":
            return fault()
        if body.tag.startswith("{" + onvif.MEDIA2 + "}"):
            seen_namespaces.append(onvif.MEDIA2)
            return fault()
        seen_namespaces.append(onvif.MEDIA1)
        if operation == "GetProfiles":
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA1}"><Profiles token="main"><Name>Main</Name></Profiles></GetProfilesResponse>')
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA1}"><MediaUri><Uri>rtsp://camera/main</Uri></MediaUri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert result["profiles"][0]["url"] == "rtsp://camera/main"
    assert onvif.MEDIA2 in seen_namespaces and onvif.MEDIA1 in seen_namespaces


def test_direct_media_endpoint_skips_bad_profile(monkeypatch):
    def handler(request):
        _, operation, _ = request_operation(request)
        if operation in ("GetServices", "GetCapabilities"):
            return fault()
        if operation == "GetProfiles":
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA2}"><Profiles token="broken"/><Profiles token="main"/></GetProfilesResponse>')
        token = ET.fromstring(request.content).find(".//{*}ProfileToken").text
        uri = "file:///etc/passwd" if token == "broken" else "rtsps://[::]:322/main"
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA2}"><Uri>{uri}</Uri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://[fd00::42]:8000/onvif/media2", "user", "pass"))
    assert result == {"profiles": [{"token": "main", "name": "main", "encoding": "unknown", "url": "rtsps://user:pass@[fd00::42]:322/main"}]}


@pytest.mark.parametrize("endpoint", ["rtsp://camera/live", "file:///tmp/test", "http://", "http://user:pass@camera/onvif", "http://camera:99999/onvif", "http://camera/onvif#fragment", "http://camera/line\nbreak"])
def test_rejects_invalid_endpoints_before_network(endpoint, monkeypatch):
    def no_client(**kwargs):
        pytest.fail("An invalid endpoint must not make a request")

    monkeypatch.setattr(onvif.httpx, "AsyncClient", no_client)
    with pytest.raises(onvif.OnvifError):
        asyncio.run(onvif.get_profiles(endpoint))


def test_rejects_xml_entities_and_does_not_expose_secrets(monkeypatch):
    entity_xml = b'<!DOCTYPE x [<!ENTITY exploit SYSTEM "file:///etc/passwd">]><x>&exploit;</x>'
    use_transport(monkeypatch, lambda request: httpx.Response(200, content=entity_xml))
    with pytest.raises(onvif.OnvifError) as error:
        asyncio.run(onvif.get_profiles("http://camera/onvif", "admin", "never-log-this-password"))
    assert "XML" in str(error.value)
    assert "never-log-this-password" not in str(error.value)


def test_authentication_error_is_actionable_and_redacted(monkeypatch):
    use_transport(monkeypatch, lambda request: httpx.Response(403, text="password=secret"))
    with pytest.raises(onvif.OnvifError, match="Autenticazione") as error:
        asyncio.run(onvif.get_profiles("http://camera/onvif", "admin", "secret"))
    assert "secret" not in str(error.value)


def test_response_size_limit_stops_reading_and_closes_stream():
    class LargeResponse(httpx.AsyncByteStream):
        chunks_read = 0
        closed = False

        async def __aiter__(self):
            for _ in range(100):
                self.chunks_read += 1
                yield b"x" * 65536

        async def aclose(self):
            self.closed = True

    stream = LargeResponse()

    async def request():
        transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=stream))
        async with httpx.AsyncClient(transport=transport) as client:
            await onvif._soap(client, "http://camera/onvif", onvif.DEVICE, "GetServices", "", "")

    with pytest.raises(onvif.OnvifError, match="troppo grande"):
        asyncio.run(request())
    assert stream.chunks_read == 33
    assert stream.closed
