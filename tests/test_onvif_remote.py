"""Explicit NAT overrides never forward camera credentials to another origin."""
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

import httpx
import pytest

from nvr import onvif
CLIENT_TYPE = httpx.AsyncClient


def soap(body):
    return httpx.Response(200, content=f'<s:Envelope xmlns:s="{onvif.SOAP}"><s:Body>{body}</s:Body></s:Envelope>')


def fixture(monkeypatch, endpoint, advertised=None, *, uri=None):
    requested = []
    advertised = advertised or endpoint.rsplit("/", 1)[0] + "/media"
    uris = {"arbitrary-main": "rtsp://192.168.1.50:554/live/main?token=private%2Fvalue",
            "not-called-sub": "rtsps://user%40name:p%3Ass@192.168.1.50:322/live/sub?x=%26",
            "third": "rtsp://192.168.1.50:8554/third/escaped%2Fpath?query=%2B"}
    if uri:
        uris = {key: uri for key in uris}
    def respond(request):
        requested.append(str(request.url))
        body = ET.fromstring(request.content).find(f"{{{onvif.SOAP}}}Body")[0]
        operation = body.tag.rsplit("}", 1)[-1]
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return soap(f'<GetServicesResponse xmlns="{onvif.DEVICE}"><Service><Namespace>{onvif.MEDIA1}</Namespace><XAddr>{advertised}</XAddr></Service></GetServicesResponse>')
        if operation in {"GetCapabilities", "GetDeviceInformation"} or namespace == onvif.MEDIA2:
            return soap('<s:Fault xmlns:s="http://www.w3.org/2003/05/soap-envelope"/>')
        if operation == "GetProfiles":
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA1}">' + ''.join(
                f'<Profiles token="{token}"><Name>Original {index}</Name><VideoSourceConfiguration><SourceToken>sensor</SourceToken></VideoSourceConfiguration>'
                f'<VideoEncoderConfiguration><Encoding>H264</Encoding><Resolution><Width>{width}</Width><Height>720</Height></Resolution></VideoEncoderConfiguration></Profiles>'
                for index, (token, width) in enumerate(zip(uris, [1920, 640, 1280]))) + '</GetProfilesResponse>')
        token = body.find('.//{*}ProfileToken').text
        response = ET.Element(f'{{{namespace}}}GetStreamUriResponse')
        ET.SubElement(response, f'{{{namespace}}}Uri').text = uris[token]
        return soap(ET.tostring(response, encoding="unicode"))
    monkeypatch.setattr(onvif.httpx, "AsyncClient", lambda **kwargs: CLIENT_TYPE(transport=httpx.MockTransport(respond), **kwargs))
    async def addresses(host):
        return frozenset({host}) if host.replace('.', '').isdigit() or ':' in host else frozenset({"8.8.8.8"})
    monkeypatch.setattr(onvif, "_resolve_host_ips", addresses)
    return requested, uris


@pytest.mark.asyncio
async def test_stream_override_rewrites_every_uri_without_changing_soap_origin_names_or_roles(monkeypatch):
    endpoint = "https://203.0.113.10:8443/device"
    requests, original = fixture(monkeypatch, endpoint)
    result = await onvif.get_profiles(endpoint, "user@name", "p:a/ss", stream_host="camera.example", stream_port=18554)
    assert result["stream_override_applied"] is True and result["service_address_override_applied"] is False
    assert len(result["profiles"]) == 3
    for profile in result["profiles"]:
        before, after = urlsplit(original[profile["token"]]), urlsplit(profile["url"])
        assert after.hostname == "camera.example" and after.port == 18554
        assert after.path == before.path and after.query == before.query and after.scheme == before.scheme
        assert urlsplit(profile["clean_url"]).username is None
    profiles = {profile["token"]: profile for profile in result["profiles"]}
    assert profiles["not-called-sub"]["url"].startswith("rtsps://user%40name:p%3Ass@")
    assert profiles["arbitrary-main"]["url"].startswith("rtsp://user%40name:p%3Aa%2Fss@")
    assert profiles["arbitrary-main"]["role"] == "main" and profiles["not-called-sub"]["role"] == "sub"
    assert all(urlsplit(value).netloc == "203.0.113.10:8443" for value in requests)
    assert "private%2Fvalue" not in str(result["warnings"]) and "p:a/ss" not in str(result["warnings"])


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides,host,port", [({"stream_host": "[2001:db8::7]"}, "2001:db8::7", 8554),
    ({"stream_port": 50000}, "192.168.1.50", 50000), ({}, "192.168.1.50", 8554)])
async def test_partial_and_absent_stream_overrides_preserve_the_remaining_uri_parts(monkeypatch, overrides, host, port):
    endpoint = "http://203.0.113.10/device"
    fixture(monkeypatch, endpoint, uri="rtsp://u%40x:p%2Fq@192.168.1.50:8554/a%2Fb?token=%2B")
    result = await onvif.get_profiles(endpoint, **overrides)
    for profile in result["profiles"]:
        parsed = urlsplit(profile["url"])
        assert parsed.hostname == host and parsed.port == port and parsed.path == "/a%2Fb" and parsed.query == "token=%2B"
        assert parsed.netloc.startswith("u%40x:p%2Fq@")
    assert result["stream_override_applied"] == bool(overrides)


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides", [{"stream_host": "http://private-password@host/a"}, {"stream_host": ""},
    {"stream_host": "bad host"}, {"stream_host": True}, {"stream_port": True}, {"stream_port": 0},
    {"stream_port": 65536}, {"stream_port": "554"}, {"use_endpoint_address": "true"}])
async def test_invalid_overrides_fail_before_any_network_client_and_do_not_echo_inputs(monkeypatch, overrides):
    monkeypatch.setattr(onvif.httpx, "AsyncClient", lambda **kwargs: pytest.fail("No network client may be created"))
    with pytest.raises(onvif.OnvifError) as error:
        await onvif.get_profiles("https://203.0.113.10/device", **overrides)
    assert "private-password" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("advertised", ["http://192.168.10.20:80/onvif/media?token=private", "https://[fd00::20]:443/media?token=private",
    "https://camera.local:443/media?token=private", "https://0.0.0.0:443/media?token=private"])
async def test_explicit_service_mapping_keeps_all_credentialled_requests_on_the_manual_origin(monkeypatch, advertised):
    endpoint = "https://203.0.113.10:9443/onvif/device"
    requests, _ = fixture(monkeypatch, endpoint, advertised)
    result = await onvif.get_profiles(endpoint, "camera-user", "private-password", use_endpoint_address=True)
    assert result["success"] and result["service_address_override_applied"]
    assert any(urlsplit(value).path == urlsplit(advertised).path for value in requests)
    assert all(urlsplit(value).scheme == "https" and urlsplit(value).netloc == "203.0.113.10:9443" for value in requests)
    assert any(urlsplit(value).query == "token=private" for value in requests)
    assert "private-password" not in str(result["warnings"]) and "token=private" not in str(result["warnings"])


@pytest.mark.asyncio
async def test_default_service_guard_still_rejects_private_nat_addresses_and_uses_only_original_fallback(monkeypatch):
    endpoint = "https://203.0.113.10:9443/device"
    requests, _ = fixture(monkeypatch, endpoint, "https://192.168.10.20/media")
    result = await onvif.get_profiles(endpoint, "user", "secret")
    assert result["success"] and not result["service_address_override_applied"]
    assert all(value == endpoint for value in requests)
    assert any("different host" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_service_mapping_never_rewrites_a_different_public_host_or_downgrades_https(monkeypatch):
    endpoint = "http://203.0.113.10:8080/device"
    requests, _ = fixture(monkeypatch, endpoint, "https://192.168.10.20/media")
    result = await onvif.get_profiles(endpoint, use_endpoint_address=True)
    assert all(value == endpoint for value in requests)
    assert not result["service_address_override_applied"]
    assert any("secure Media service" in warning for warning in result["warnings"])
    requests, _ = fixture(monkeypatch, endpoint, "http://8.8.8.8/media")
    result = await onvif.get_profiles(endpoint, use_endpoint_address=True)
    assert all(value == endpoint for value in requests) and not result["service_address_override_applied"]


@pytest.mark.asyncio
async def test_explicit_mapping_also_replaces_a_private_same_host_internal_port(monkeypatch):
    endpoint = "http://192.168.10.20:8080/device"
    requests, _ = fixture(monkeypatch, endpoint, "http://192.168.10.20:80/media")
    result = await onvif.get_profiles(endpoint, use_endpoint_address=True)
    assert result["service_address_override_applied"]
    assert all(urlsplit(value).port == 8080 for value in requests)
