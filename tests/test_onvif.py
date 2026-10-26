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


def profile_xml(namespace, token, name="", *, source=None, width=None, height=None,
                fps=None, bitrate=None, encoding="H264", audio=None, interval=None):
    profile = ET.Element(f"{{{namespace}}}Profiles", token=token)
    ET.SubElement(profile, f"{{{namespace}}}Name").text = name
    configurations = ET.SubElement(profile, f"{{{namespace}}}Configurations") if namespace == onvif.MEDIA2 else profile
    if source is not None:
        source_node = ET.SubElement(configurations, f"{{{namespace}}}" + ("VideoSource" if namespace == onvif.MEDIA2 else "VideoSourceConfiguration"))
        ET.SubElement(source_node, f"{{{onvif.SCHEMA}}}SourceToken").text = source
    encoder = ET.SubElement(configurations, f"{{{namespace}}}" + ("VideoEncoder" if namespace == onvif.MEDIA2 else "VideoEncoderConfiguration"))
    # Configuration names must not replace the original profile name.
    ET.SubElement(encoder, f"{{{onvif.SCHEMA}}}Name").text = "Wrong encoder name"
    ET.SubElement(encoder, f"{{{onvif.SCHEMA}}}Encoding").text = encoding
    resolution = ET.SubElement(encoder, f"{{{onvif.SCHEMA}}}Resolution")
    for tag, value in (("Width", width), ("Height", height)):
        if value is not None:
            ET.SubElement(resolution, f"{{{onvif.SCHEMA}}}{tag}").text = str(value)
    rate = ET.SubElement(encoder, f"{{{onvif.SCHEMA}}}RateControl")
    for tag, value in (("FrameRateLimit", fps), ("BitrateLimit", bitrate), ("EncodingInterval", interval)):
        if value is not None:
            ET.SubElement(rate, f"{{{onvif.SCHEMA}}}{tag}").text = str(value)
    if audio:
        audio_node = ET.SubElement(configurations, f"{{{namespace}}}" + ("AudioEncoder" if namespace == onvif.MEDIA2 else "AudioEncoderConfiguration"))
        ET.SubElement(audio_node, f"{{{onvif.SCHEMA}}}Encoding").text = audio
    return ET.tostring(profile, encoding="unicode")


def services_reply(*services):
    return soap(f'<GetServicesResponse xmlns="{onvif.DEVICE}">' + "".join(
        f'<Service><Namespace>{namespace}</Namespace><XAddr>{address}</XAddr></Service>'
        for namespace, address in services) + '</GetServicesResponse>')


def profiles_reply(namespace, *profiles):
    return soap(f'<GetProfilesResponse xmlns="{namespace}">' + "".join(profiles) + '</GetProfilesResponse>')


def stream_reply(namespace, uri):
    response = ET.Element(f"{{{namespace}}}GetStreamUriResponse")
    ET.SubElement(response, f"{{{namespace}}}Uri").text = uri
    return soap(ET.tostring(response, encoding="unicode"))


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
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        assert request.url == "http://192.168.1.51:8080/onvif/media2"
        if operation == "GetProfiles":
            assert [node.text for node in body.findall(f"{{{onvif.MEDIA2}}}Type")] == ["VideoEncoder", "VideoSource", "AudioEncoder"]
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA2}"><Profiles token="main"><Name>Ingresso</Name><Configurations><VideoEncoder><Encoding>H265</Encoding></VideoEncoder></Configurations></Profiles></GetProfilesResponse>')
        assert operation == "GetStreamUri"
        assert body.find(f"{{{onvif.MEDIA2}}}Protocol").text == "RTSP"
        assert body.find(f"{{{onvif.MEDIA2}}}ProfileToken").text == "main"
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA2}"><Uri>rtsp://0.0.0.0:554/main?channel=1</Uri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://192.168.1.51/onvif/device_service", username, password))
    assert len(result["profiles"]) == 1
    profile = result["profiles"][0]
    assert {key: profile[key] for key in ("token", "name", "encoding", "url")} == {
        "token": "main", "name": "Ingresso", "encoding": "H265",
        "url": "rtsp://operatore%26nvr:p%40ss%3A%2F%3F%20%23%21@192.168.1.51:554/main?channel=1"}
    assert profile["clean_url"] == "rtsp://192.168.1.51:554/main?channel=1"
    assert result["success"] and result["device"]["manufacturer"] is None
    assert seen == ["GetServices", "GetCapabilities", "GetDeviceInformation", "GetProfiles", "GetStreamUri"]


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
        if operation in ("GetServices", "GetDeviceInformation"):
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
    profile = result["profiles"][0]
    assert {key: profile[key] for key in ("token", "name", "encoding", "url")} == {"token": "low", "name": "Secondario", "encoding": "H264", "url": "rtsp://device:existing@camera.local/low"}
    assert profile["clean_url"] == "rtsp://camera.local/low"


def test_advertised_media2_failure_falls_back_to_media1(monkeypatch):
    seen_namespaces = []

    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return soap(f'<GetServicesResponse xmlns="{onvif.DEVICE}"><Service><Namespace>{onvif.MEDIA2}</Namespace><XAddr>/media2</XAddr></Service><Service><Namespace>{onvif.MEDIA1}</Namespace><XAddr>/media1</XAddr></Service></GetServicesResponse>')
        if operation in ("GetCapabilities", "GetDeviceInformation"):
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


def test_direct_media_endpoint_preserves_unavailable_profile(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        if operation in ("GetServices", "GetCapabilities", "GetDeviceInformation") or body.tag.startswith("{" + onvif.MEDIA1 + "}"):
            return fault()
        if operation == "GetProfiles":
            return soap(f'<GetProfilesResponse xmlns="{onvif.MEDIA2}"><Profiles token="broken"/><Profiles token="main"/></GetProfilesResponse>')
        token = ET.fromstring(request.content).find(".//{*}ProfileToken").text
        uri = "file:///etc/passwd" if token == "broken" else "rtsps://[::]:322/main"
        return soap(f'<GetStreamUriResponse xmlns="{onvif.MEDIA2}"><Uri>{uri}</Uri></GetStreamUriResponse>')

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://[fd00::42]:8000/onvif/media2", "user", "pass"))
    assert len(result["profiles"]) == 2
    broken, main = result["profiles"]
    assert broken["token"] == "broken" and broken["url"] is None and broken["clean_url"] is None
    assert "Invalid" in broken["error"]
    assert main["token"] == "main" and main["name"] == ""
    assert main["url"] == "rtsps://user:pass@[fd00::42]:322/main"
    assert result["success"] and result["warnings"]


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
    with pytest.raises(onvif.OnvifError, match="authentication") as error:
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

    with pytest.raises(onvif.OnvifError, match="too large"):
        asyncio.run(request())
    assert stream.chunks_read == 33
    assert stream.closed


def test_all_profiles_metadata_device_information_and_advisory_roles(monkeypatch):
    profiles = [
        profile_xml(onvif.MEDIA2, "arbitrary-high", "  SUB streaming  ", source="sensor-front", width=3840, height=2160,
                    fps=25, bitrate=8192, encoding="H265", audio="AAC"),
        profile_xml(onvif.MEDIA2, "token-low", "MAIN streaming", source="sensor-front", width=640, height=360,
                    fps=12.5, bitrate=512, audio="G711"),
        profile_xml(onvif.MEDIA2, "third-not-sub", "Profilo libero", source="sensor-front", width=1280, height=720,
                    fps=20, bitrate=2048),
        profile_xml(onvif.MEDIA2, "second-camera", "Altra telecamera", source="sensor-back", width=1920, height=1080,
                    fps=30, bitrate=4096),
    ]

    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "/media2"))
        if operation == "GetCapabilities":
            return fault()
        if operation == "GetDeviceInformation":
            return soap(f'<GetDeviceInformationResponse xmlns="{onvif.DEVICE}"><Manufacturer>Camera maker</Manufacturer><Model>SR-4</Model><FirmwareVersion>1.2.3</FirmwareVersion><SerialNumber>SN001</SerialNumber><HardwareId>HW4</HardwareId></GetDeviceInformationResponse>')
        if operation == "GetProfiles":
            assert [node.text for node in body.findall("{*}Type")] == ["VideoEncoder", "VideoSource", "AudioEncoder"]
            return profiles_reply(onvif.MEDIA2, *profiles)
        token = body.find("{*}ProfileToken").text
        return stream_reply(onvif.MEDIA2, f"rtsp://camera/live/{token}?session=keep-this")

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device", "operator", "secret"))
    assert result["device"] == {"manufacturer": "Camera maker", "model": "SR-4", "firmware": "1.2.3", "serial_number": "SN001", "hardware_id": "HW4"}
    assert result["success"] and result["warnings"] == []
    profiles_by_token = {profile["token"]: profile for profile in result["profiles"]}
    high = profiles_by_token["arbitrary-high"]
    assert high["name"] == "  SUB streaming  "
    assert (high["width"], high["height"], high["fps"], high["bitrate"], high["audio_encoding"]) == (3840, 2160, 25, 8192, "AAC")
    assert high["encoding"] == "H265" and high["service"] == "Media2"
    assert high["role"] == "main" and "advisory" in high["role_basis"]
    assert profiles_by_token["token-low"]["role"] == "sub"
    assert profiles_by_token["third-not-sub"]["role"] == "other"
    assert profiles_by_token["second-camera"]["role"] == "main"
    assert high["clean_url"] == "rtsp://camera/live/arbitrary-high?session=keep-this"
    assert high["url"].startswith("rtsp://operator:secret@")


def test_collects_both_media_services_and_merges_only_matching_identity(monkeypatch):
    requested_services = []

    def handler(request):
        _, operation, body = request_operation(request)
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"), (onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            requested_services.append(namespace)
            if namespace == onvif.MEDIA2:
                return profiles_reply(namespace,
                    profile_xml(namespace, "shared-token", "Original Media2", source="source-A", width=1920, height=1080),
                    profile_xml(namespace, "different-token", "Same URI, separate profile", source="source-A", width=1920, height=1080))
            return profiles_reply(namespace,
                profile_xml(namespace, "shared-token", "Original Media1", source="source-A", width=1920, height=1080, fps=30, bitrate=4096, interval=2, audio="AAC"),
                profile_xml(namespace, "shared-token", "Same token on another input", source="source-B", width=1920, height=1080))
        return stream_reply(namespace, "rtsp://camera/live")

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert set(requested_services) == {onvif.MEDIA1, onvif.MEDIA2}
    assert len(result["profiles"]) == 3
    merged = next(profile for profile in result["profiles"] if profile["token"] == "shared-token" and profile["video_source"] == "source-A")
    assert merged["services"] == ["Media2", "Media1"]
    assert merged["service"] == "Media2" and merged["name"] == "Original Media2"
    assert merged["fps"] == 15 and merged["bitrate"] == 4096 and merged["audio_encoding"] == "AAC"
    assert any(profile["token"] == "different-token" for profile in result["profiles"])
    assert any(profile["video_source"] == "source-B" for profile in result["profiles"])


def test_missing_source_prevents_cross_service_merge_and_role_guessing(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"), (onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(namespace, profile_xml(namespace, "identical-token", "MAIN", width=1920, height=1080, bitrate=4096))
        return stream_reply(namespace, "rtsp://camera/live")

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert len(result["profiles"]) == 2
    assert all(profile["role"] == "other" for profile in result["profiles"])
    assert all("not declared" in profile["role_basis"] for profile in result["profiles"])


def test_one_failed_uri_does_not_discard_other_profiles(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA1, profile_xml(onvif.MEDIA1, "valid"), profile_xml(onvif.MEDIA1, "unavailable"))
        if body.find("{*}ProfileToken").text == "unavailable":
            return fault()
        return stream_reply(onvif.MEDIA1, "rtsp://camera/live")

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device", "operator", "never-log-secret"))
    assert result["success"] and len(result["profiles"]) == 2
    broken = next(profile for profile in result["profiles"] if profile["token"] == "unavailable")
    assert broken["url"] is None and broken["error"]
    assert "never-log-secret" not in broken["error"]
    assert all("never-log-secret" not in warning for warning in result["warnings"])


def test_all_unavailable_uris_return_failed_report_with_profiles(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"))
        if operation == "GetProfiles" and request.url.path == "/media1":
            return profiles_reply(onvif.MEDIA1, profile_xml(onvif.MEDIA1, "known-profile", "Keep this name"))
        return fault()

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert not result["success"]
    assert len(result["profiles"]) == 1 and result["profiles"][0]["name"] == "Keep this name"
    assert result["profiles"][0]["error"] and result["profiles"][0]["url"] is None


def test_uri_requests_have_bounded_concurrency_and_preserve_all_profiles(monkeypatch):
    active = 0
    maximum = 0

    async def handler(request):
        nonlocal active, maximum
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA2, *(profile_xml(onvif.MEDIA2, f"profile-{index}") for index in range(12)))
        active += 1
        maximum = max(maximum, active)
        try:
            await asyncio.sleep(0.005)
            return stream_reply(onvif.MEDIA2, "rtsp://camera/" + body.find("{*}ProfileToken").text)
        finally:
            active -= 1

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert len(result["profiles"]) == 12
    assert 1 < maximum <= 4


def test_limits_large_profile_and_service_lists_with_explicit_warnings(monkeypatch):
    enumerated_services = set()
    stream_calls = 0

    def handler(request):
        nonlocal stream_calls
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply(*[(onvif.MEDIA2, f"/media-{index}") for index in range(10)])
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            enumerated_services.add(request.url.path)
            return profiles_reply(onvif.MEDIA2, *(profile_xml(onvif.MEDIA2, f"profile-{index}") for index in range(70)))
        stream_calls += 1
        return stream_reply(onvif.MEDIA2, "rtsp://camera" + request.url.path + "/" + body.find("{*}ProfileToken").text)

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert len(enumerated_services) == 8 and stream_calls == 8 * 64
    assert len(result["profiles"]) == 8 * 64
    assert any("8 Media services" in warning for warning in result["warnings"])
    assert any("64 profiles" in warning for warning in result["warnings"])


def test_import_deadline_returns_partial_results(monkeypatch):
    monkeypatch.setattr(onvif, "IMPORT_TIMEOUT_SECONDS", 0.05)

    async def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA2, profile_xml(onvif.MEDIA2, "fast"), profile_xml(onvif.MEDIA2, "slow"))
        token = body.find("{*}ProfileToken").text
        if token == "slow":
            await asyncio.sleep(1)
        return stream_reply(onvif.MEDIA2, "rtsp://camera/" + token)

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert result["success"] and len(result["profiles"]) == 2
    assert any("incomplete" in warning for warning in result["warnings"])
    slow = next(profile for profile in result["profiles"] if profile["token"] == "slow")
    assert slow["url"] is None and slow["error"] == "URI request not completed."


def test_invalid_numeric_metadata_and_equal_profiles_do_not_invent_roles(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA2,
                profile_xml(onvif.MEDIA2, "named-main", "MAIN", source="sensor", width=1920, height=1080, fps="NaN", bitrate=4096),
                profile_xml(onvif.MEDIA2, "named-sub", "SUB", source="sensor", width=1920, height=1080, fps="Infinity", bitrate=4096))
        return stream_reply(onvif.MEDIA2, "rtsp://camera/" + body.find("{*}ProfileToken").text)

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert all(profile["role"] == "other" and profile["fps"] is None for profile in result["profiles"])


def test_bitrate_distinguishes_equal_resolution_profiles_without_name_heuristics(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA1, *(profile_xml(onvif.MEDIA1, token, "MAIN", source="sensor",
                width=1920, height=1080, bitrate=bitrate) for token, bitrate in (("a", 512), ("b", 8192), ("c", 2048))))
        return stream_reply(onvif.MEDIA1, "rtsp://camera/" + body.find("{*}ProfileToken").text)

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    roles = {profile["token"]: profile["role"] for profile in result["profiles"]}
    assert roles == {"a": "sub", "b": "main", "c": "other"}
    assert all("declared bitrate" in profile["role_basis"].lower() for profile in result["profiles"])


def test_soap_auth_fault_is_actionable_even_with_http_500_and_redacted(monkeypatch):
    content = f'''<s:Envelope xmlns:s="{onvif.SOAP}"><s:Body><s:Fault>
        <s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code>
        <s:Reason><s:Text>operator password=do-not-repeat-this</s:Text></s:Reason>
        </s:Fault></s:Body></s:Envelope>'''
    use_transport(monkeypatch, lambda request: httpx.Response(500, content=content))
    with pytest.raises(onvif.OnvifError, match="authentication") as error:
        asyncio.run(onvif.get_profiles("http://camera/device", "operator", "do-not-repeat-this"))
    assert "clock" in str(error.value) and "do-not-repeat-this" not in str(error.value)


def test_same_uri_and_token_with_different_returned_credentials_remain_separate(monkeypatch):
    def handler(request):
        _, operation, body = request_operation(request)
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return services_reply((onvif.MEDIA1, "/media1"), (onvif.MEDIA2, "/media2"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(namespace, profile_xml(namespace, "profile", "Original", source="sensor"))
        user = "first" if namespace == onvif.MEDIA1 else "second"
        return stream_reply(namespace, f"rtsp://{user}:camera-secret@camera/live")

    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera/device"))
    assert len(result["profiles"]) == 2
    assert len({profile["url"] for profile in result["profiles"]}) == 2
    assert {profile["clean_url"] for profile in result["profiles"]} == {"rtsp://camera/live"}


def test_external_advertised_service_never_receives_credentials(monkeypatch):
    contacted_hosts = []
    resolved_hosts = []

    async def resolve(hostname):
        resolved_hosts.append(hostname)
        return frozenset({"192.0.2.10" if hostname == "192.0.2.10" else "203.0.113.99"})

    def handler(request):
        contacted_hosts.append(request.url.host)
        _, operation, body = request_operation(request)
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "https://external.invalid/media?token=never-repeat-url-secret"),
                                  (onvif.MEDIA1, "/media1"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(onvif.MEDIA1, profile_xml(onvif.MEDIA1, "profile"))
        return stream_reply(onvif.MEDIA1, "rtsp://192.0.2.10/live")

    monkeypatch.setattr(onvif, "_resolve_host_ips", resolve)
    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://192.0.2.10/device", "operator", "camera-password-secret"))
    assert result["success"]
    assert set(contacted_hosts) == {"192.0.2.10"}
    assert resolved_hosts == ["192.0.2.10", "external.invalid"]
    assert any("different host" in warning for warning in result["warnings"])
    assert all("never-repeat-url-secret" not in warning and "camera-password-secret" not in warning
               and "external.invalid" not in warning for warning in result["warnings"])


def test_advertised_same_ip_alias_is_accepted_and_dns_is_cached(monkeypatch):
    resolved_hosts = []
    contacted_media = []

    async def resolve(hostname):
        resolved_hosts.append(hostname)
        return frozenset({"192.0.2.10", "2001:db8::10"}) if hostname == "camera.local" else frozenset({"192.0.2.10"})

    def handler(request):
        _, operation, body = request_operation(request)
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "http://192.0.2.10:8080/media2"),
                                  (onvif.MEDIA1, "http://192.0.2.10:8080/media1"))
        if operation in ("GetCapabilities", "GetDeviceInformation"):
            return fault()
        if operation == "GetProfiles":
            contacted_media.append(str(request.url))
            return profiles_reply(namespace, profile_xml(namespace, "profile", source="sensor"))
        return stream_reply(namespace, "rtsp://192.0.2.10/live")

    monkeypatch.setattr(onvif, "_resolve_host_ips", resolve)
    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://camera.local/device"))
    assert result["success"] and len(result["profiles"]) == 1
    assert resolved_hosts == ["camera.local", "192.0.2.10"]
    assert set(contacted_media) == {"http://192.0.2.10:8080/media1", "http://192.0.2.10:8080/media2"}
    assert not any("different host" in warning for warning in result["warnings"])


def test_dns_failure_rejects_advertised_host_but_keeps_original_endpoint_fallback(monkeypatch):
    contacted_hosts = []

    async def resolve(hostname):
        return frozenset({"192.0.2.10"}) if hostname == "192.0.2.10" else frozenset()

    def handler(request):
        contacted_hosts.append(request.url.host)
        _, operation, body = request_operation(request)
        namespace = body.tag[1:].split("}", 1)[0]
        if operation == "GetServices":
            return services_reply((onvif.MEDIA2, "http://cannot-resolve.invalid/media?key=secret-query"))
        if operation in ("GetCapabilities", "GetDeviceInformation") or namespace == onvif.MEDIA1:
            return fault()
        if operation == "GetProfiles":
            return profiles_reply(namespace, profile_xml(namespace, "profile"))
        return stream_reply(namespace, "rtsp://192.0.2.10/live")

    monkeypatch.setattr(onvif, "_resolve_host_ips", resolve)
    use_transport(monkeypatch, handler)
    result = asyncio.run(onvif.get_profiles("http://192.0.2.10/device", "user", "secret-password"))
    assert result["success"] and set(contacted_hosts) == {"192.0.2.10"}
    assert any("different host" in warning for warning in result["warnings"])
    assert all("secret-query" not in warning and "secret-password" not in warning for warning in result["warnings"])


def test_resolver_is_bounded_and_numeric_hosts_never_use_dns(monkeypatch):
    async def scenario():
        calls = []

        async def no_dns(*args, **kwargs):
            calls.append(args)
            pytest.fail("A numeric IP must not use DNS")

        loop = asyncio.get_running_loop()
        monkeypatch.setattr(loop, "getaddrinfo", no_dns)
        assert await onvif._resolve_host_ips("192.0.2.10") == frozenset({"192.0.2.10"})
        assert await onvif._resolve_host_ips("2001:db8::10") == frozenset({"2001:db8::10"})
        assert calls == []

        async def addresses(*args, **kwargs):
            return [(2, 1, 6, "", (f"192.0.2.{index}", 0)) for index in range(1, 20)]

        monkeypatch.setattr(loop, "getaddrinfo", addresses)
        result = await onvif._resolve_host_ips("camera.local")
        assert len(result) == onvif.MAX_DNS_ADDRESSES
        assert "192.0.2.19" not in result

        async def timeout(*args, **kwargs):
            await asyncio.sleep(1)

        monkeypatch.setattr(loop, "getaddrinfo", timeout)
        monkeypatch.setattr(onvif, "DNS_TIMEOUT_SECONDS", 0.01)
        assert await onvif._resolve_host_ips("timeout.invalid") == frozenset()

        async def failure(*args, **kwargs):
            raise OSError("sensitive resolver failure detail")

        monkeypatch.setattr(loop, "getaddrinfo", failure)
        assert await onvif._resolve_host_ips("failed.invalid") == frozenset()

    asyncio.run(scenario())
