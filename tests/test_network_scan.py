"""Explicit service probes use MockTransport or localhost-only fixture servers."""
import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import socket
import ssl
import time
from unittest.mock import AsyncMock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
import httpx
import pytest

from nvr import discovery
from nvr import network_scan as scan


SOAP_REPLY = (f'<s:Envelope xmlns:s="{discovery.SOAP}"><s:Body>'
              f'<d:GetSystemDateAndTimeResponse xmlns:d="{discovery.DEVICE}"/>'
              '</s:Body></s:Envelope>').encode()


def mocked_http(monkeypatch, handler):
    original, clients, options = httpx.AsyncClient, [], []
    def client(**kwargs):
        options.append(kwargs)
        result = original(transport=httpx.MockTransport(handler), **kwargs)
        clients.append(result)
        return result
    monkeypatch.setattr(scan.httpx, "AsyncClient", client)
    return clients, options


@pytest.mark.parametrize("value,expected", [
    ("192.168.1.23/24", "192.168.1.0/24"), ("10.2.3.4/32", "10.2.3.4"),
    ("100.64.5.7/24", "100.64.5.0/24"), ("169.254.5.0/24", "169.254.5.0/24"),
    ("8.8.8.8/32", "8.8.8.8"), ("[2001:4860:4860::8888]", "2001:4860:4860::8888"),
    ("fd12:3456::1/128", "fd12:3456::1"), (" Camera.Example. ", "camera.example"),
    ("täst.local", "xn--tst-qla.local"),
])
def test_normalize_is_pure_and_supports_lan_cgnat_and_known_public_single_hosts(monkeypatch, value, expected):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: pytest.fail("Preset validation must not use DNS"))
    assert scan.normalize_target(value) == expected


@pytest.mark.parametrize("value", [
    "127.0.0.1", "127.1", "0.0.0.0", "224.1.2.3", "240.1.2.3", "255.255.255.255", "::", "::1", "ff02::1",
    "::ffff:127.0.0.1", "169.254.169.254", "::ffff:169.254.169.254", "169.254.169.0/24",
    "10.0.0.0/23", "8.8.8.0/24", "100.128.0.0/24", "fd12:3456::/120", "2001:4860::/64",
    "fe80::1%eth0", "http://user:password@example.test/", "camera.example:554", "bad/name", "", None,
])
def test_unsafe_or_unbounded_targets_are_rejected_without_echo(value):
    with pytest.raises(scan.NetworkScanError) as error:
        scan.normalize_target(value)
    assert "password" not in str(error.value) and "user:" not in str(error.value)


@pytest.mark.asyncio
async def test_dns_is_once_pinned_and_host_sni_preserve_the_explicit_authority(monkeypatch):
    loop = asyncio.get_running_loop()
    resolver = AsyncMock(side_effect=[[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 0))],
                                      [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]])
    monkeypatch.setattr(loop, "getaddrinfo", resolver)
    requests = []
    def response(request):
        requests.append(request)
        assert request.url.host == "10.0.0.8"
        assert request.headers["host"] == "camera.example:443"
        assert request.extensions["sni_hostname"] == "camera.example"
        return httpx.Response(200, content=SOAP_REPLY)
    clients, options = mocked_http(monkeypatch, response)
    result = await scan.scan_targets(["Camera.Example", "camera.example"], ["onvif"], onvif_ports=[443, 443])
    assert resolver.await_count == 1 and len(requests) == 1
    assert result["completed"] == result["total"] == 1 and result["partial"] is False
    device = result["devices"][0]
    assert device["ip"] == "10.0.0.8" and device["endpoint"] == "https://camera.example:443/onvif/device_service"
    assert device["services"][0]["host"] == "camera.example"
    assert options[0]["trust_env"] is False and options[0]["verify"] is True and options[0]["follow_redirects"] is False
    assert clients[0].is_closed


@pytest.mark.asyncio
@pytest.mark.parametrize("unsafe", ["127.0.0.1", "::1", "169.254.169.254", "::ffff:169.254.169.254", "224.0.0.1"])
async def test_mixed_dns_answers_reject_the_entire_scan_before_service_connections(monkeypatch, unsafe):
    monkeypatch.setattr(scan, "_resolve_hostname", AsyncMock(return_value=["10.0.0.8", unsafe]))
    monkeypatch.setattr(scan.httpx, "AsyncClient", lambda **kwargs: pytest.fail("Unsafe DNS must not start probes"))
    with pytest.raises(scan.NetworkScanError):
        await scan.scan_targets(["camera.example"], ["onvif"])


@pytest.mark.asyncio
async def test_dns_answer_limit_and_timeout_are_bounded(monkeypatch):
    loop = asyncio.get_running_loop()
    answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (f"10.0.0.{index}", 0)) for index in range(1, 10)]
    monkeypatch.setattr(loop, "getaddrinfo", AsyncMock(return_value=answers))
    with pytest.raises(scan.NetworkScanError, match="too many"):
        await scan._resolve_hostname("camera.example")
    cancelled = asyncio.Event()
    async def delayed(*args, **kwargs):
        try:
            await asyncio.Future()
        finally:
            cancelled.set()
    monkeypatch.setattr(loop, "getaddrinfo", delayed)
    started = time.monotonic()
    with pytest.raises(asyncio.TimeoutError):
        await scan._resolve_hostname("camera.example")
    assert time.monotonic() - started < 1.5 and cancelled.is_set()


@pytest.mark.asyncio
async def test_multiple_dns_virtual_hosts_and_all_onvif_ports_are_kept_separately(monkeypatch):
    monkeypatch.setattr(scan, "_resolve_hostname", AsyncMock(return_value=["10.0.0.8"]))
    mocked_http(monkeypatch, lambda request: httpx.Response(200, content=SOAP_REPLY))
    result = await scan.scan_targets(["one.example", "two.example", "10.0.0.8"], ["onvif"], onvif_ports=[80, 8080])
    assert result["total"] == result["completed"] == 6 and len(result["devices"]) == 3
    assert len({device["id"] for device in result["devices"]}) == 3
    for device in result["devices"]:
        assert len(device["xaddrs"]) == len(device["services"]) == 2
        assert device["methods"] == ["onvif"] and device["endpoint"] in device["xaddrs"]
    assert {service["host"] for device in result["devices"] for service in device["services"]} == {"one.example", "two.example", "10.0.0.8"}


@pytest.mark.asyncio
async def test_generic_http_auth_pages_redirects_and_non_onvif_xml_are_not_devices(monkeypatch):
    def response(request):
        if request.url.port == 80:
            return httpx.Response(401, content=b"<html>private-password</html>")
        if request.url.port == 8000:
            return httpx.Response(302, headers={"Location": "http://169.254.169.254/"})
        return httpx.Response(200, content=b"<not-onvif/>")
    mocked_http(monkeypatch, response)
    result = await scan.scan_targets(["10.0.0.8"], ["onvif"], onvif_ports=[80, 8000, 8080])
    assert result["devices"] == [] and result["completed"] == 3
    assert "private-password" not in json.dumps(result)


@pytest.mark.asyncio
async def test_ipv6_literal_onvif_urls_are_bracketed_and_verified(monkeypatch):
    requests = []
    def response(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=SOAP_REPLY)
    mocked_http(monkeypatch, response)
    result = await scan.scan_targets(["2001:4860:4860::8888"], ["onvif"], onvif_ports=[80])
    assert requests == ["http://[2001:4860:4860::8888]/onvif/device_service"]  # HTTPX normalizes default port80.
    assert result["devices"][0]["endpoint"] == "http://[2001:4860:4860::8888]:80/onvif/device_service"


@pytest.mark.asyncio
async def test_address_and_total_probe_limits_are_checked_before_opening_a_client(monkeypatch):
    monkeypatch.setattr(scan.httpx, "AsyncClient", lambda **kwargs: pytest.fail("Over-budget scans must not start probes"))
    with pytest.raises(scan.NetworkScanError, match="512"):
        await scan.scan_targets(["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"], ["onvif"])
    targets = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/31", "10.0.3.1", "10.0.3.2"]
    with pytest.raises(scan.NetworkScanError, match="4096"):
        await scan.scan_targets(targets, ["onvif", "rtsp"], onvif_ports=list(range(1, 9)), rtsp_ports=[554])


@pytest.mark.asyncio
async def test_exact_512_addresses_4096_probes_and_duplicate_inputs_are_supported(monkeypatch):
    mocked_http(monkeypatch, lambda request: httpx.Response(404))
    targets = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/31", "10.0.3.1", "10.0.3.2", "10.0.3.2"]
    result = await scan.scan_targets(targets, ["onvif", "onvif"], onvif_ports=list(range(1, 9)))
    assert result["completed"] == result["total"] == 4096 and not result["partial"]


@pytest.mark.asyncio
async def test_dns_failure_keeps_other_targets_partial_and_dns_deadline_opens_no_clients(monkeypatch):
    monkeypatch.setattr(scan, "_resolve_hostname", AsyncMock(side_effect=OSError("private-DNS-details")))
    mocked_http(monkeypatch, lambda request: httpx.Response(200, content=SOAP_REPLY))
    result = await scan.scan_targets(["offline.example", "10.0.0.8"], ["onvif"], onvif_ports=[80])
    assert result["partial"] and result["completed"] == result["total"] == 1 and len(result["devices"]) == 1
    assert "private-DNS-details" not in json.dumps(result)
    cancelled = asyncio.Event()
    async def delayed(hostname):
        try:
            await asyncio.Future()
        finally:
            cancelled.set()
    monkeypatch.setattr(scan, "_resolve_hostname", delayed)
    monkeypatch.setattr(scan.httpx, "AsyncClient", lambda **kwargs: pytest.fail("A DNS deadline must not open a client"))
    result = await scan.scan_targets(["delayed.example"], ["onvif"], deadline=.05)
    assert result["partial"] and result["completed"] == result["total"] == 0 and cancelled.is_set()


@pytest.mark.asyncio
async def test_protocols_merge_as_services_and_keep_every_verified_onvif_endpoint(monkeypatch):
    mocked_http(monkeypatch, lambda request: httpx.Response(200, content=SOAP_REPLY))
    async def rtsp(target, port, method, timeout, context):
        return {"protocol": method, "host": target.host, "port": port, "url": scan._uri(method, target.host, port),
                "status": "authentication_required", "stream_path_known": False, "response_code": 401}
    monkeypatch.setattr(scan, "_probe_rtsp", rtsp)
    result = await scan.scan_targets(["10.0.0.8"], ["onvif", "rtsp"], onvif_ports=[80, 8080], rtsp_ports=[554])
    assert result["total"] == result["completed"] == 3 and len(result["devices"]) == 1
    device = result["devices"][0]
    assert device["methods"] == ["onvif", "rtsp"] and len(device["xaddrs"]) == 2 and len(device["services"]) == 3
    assert device["services"][-1]["status"] == "authentication_required" and not device["services"][-1]["stream_path_known"]


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"targets": []}, {"targets": ["10.0.0.1"] * 17}, {"methods": []}, {"methods": ["udp"]},
    {"onvif_ports": []}, {"onvif_ports": [True]}, {"onvif_ports": [0]}, {"onvif_ports": list(range(1, 10))},
    {"timeout": True}, {"timeout": .01}, {"timeout": 3}, {"deadline": 76},
])
async def test_scan_input_validation_never_starts_network_work(monkeypatch, changes):
    monkeypatch.setattr(scan, "_expand_targets", AsyncMock(side_effect=AssertionError("Validation must precede networking")))
    with pytest.raises(scan.NetworkScanError):
        await scan.scan_targets(**{"targets": ["10.0.0.1"], "methods": ["onvif"], **changes})


@asynccontextmanager
async def local_rtsp_server(response, *, tls=None):
    requests, handlers, closed = [], set(), asyncio.Event()
    async def handle(reader, writer):
        handlers.add(asyncio.current_task())
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            requests.append(request)
            data = response(request) if callable(response) else response
            if data is None:
                await reader.read()
            else:
                writer.write(data); await writer.drain()
                await reader.read()
        except (OSError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with suppress(OSError, ssl.SSLError):
                await writer.wait_closed()
            closed.set(); handlers.discard(asyncio.current_task())
    server = await asyncio.start_server(handle, "127.0.0.1", 0, ssl=tls)
    try:
        yield server.sockets[0].getsockname()[1], requests, closed
    finally:
        server.close(); await server.wait_closed()
        for task in list(handlers):
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("code,status", [(200, "verified"), (401, "authentication_required"), (403, "authentication_required"),
                                        (404, "verified"), (405, "verified"), (500, "verified")])
async def test_actual_local_rtsp_options_identifies_service_without_claiming_a_video_path(code, status):
    response = f'RTSP/1.0 {code} Fixture\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="private-realm", nonce="private-token"\r\n\r\n'.encode()
    async with local_rtsp_server(response) as (port, requests, closed):
        service = await scan._probe_rtsp(scan._Target("127.0.0.1", "camera.example"), port, "rtsp", .5)
        assert service["status"] == status and service["stream_path_known"] is False
        assert service["url"] == f"rtsp://camera.example:{port}/"
        assert requests[0] == f"OPTIONS rtsp://camera.example:{port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: SR81\r\n\r\n".encode()
        assert "private-" not in json.dumps(service)
        await asyncio.wait_for(closed.wait(), .5)


@pytest.mark.asyncio
async def test_505_retries_rtsp_two_once_and_no_other_requests_are_sent():
    def response(request):
        return b"RTSP/1.0 505 Unsupported\r\nCSeq: 1\r\n\r\n" if b"RTSP/1.0" in request else b"RTSP/2.0 200 OK\r\nCSeq: 1\r\n\r\n"
    async with local_rtsp_server(response) as (port, requests, _):
        service = await scan._probe_rtsp(scan._Target("127.0.0.1"), port, "rtsp", .75)
        assert service["rtsp_version"] == "2.0" and len(requests) == 2
        assert all(request.startswith(b"OPTIONS ") and b"Authorization:" not in request for request in requests)


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [
    b"HTTP/1.1 200 OK\r\nCSeq: 1\r\n\r\n", b"RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n",
    b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nCSeq: 1\r\n\r\n", b"RTSP/3.0 200 OK\r\nCSeq: 1\r\n\r\n",
    b"RTSP/1.0 200 OK\r\nBad: \x00\r\n\r\n", b"RTSP/1.0 200 OK\r\nBig: " + b"x" * 17000 + b"\r\n\r\n",
])
async def test_actual_local_rtsp_rejects_http_masquerades_wrong_cseq_and_hostile_headers(response):
    async with local_rtsp_server(response) as (port, _, closed):
        assert await scan._probe_rtsp(scan._Target("127.0.0.1"), port, "rtsp", .5) is None
        await asyncio.wait_for(closed.wait(), .5)


@pytest.mark.asyncio
async def test_rtsp_socket_is_closed_on_cancellation_and_missing_cseq_is_interoperable():
    async with local_rtsp_server(None) as (port, requests, closed):
        task = asyncio.create_task(scan._probe_rtsp(scan._Target("127.0.0.1"), port, "rtsp", 2))
        while not requests:
            await asyncio.sleep(.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(closed.wait(), .5)
    async with local_rtsp_server(b"RTSP/1.0 200 OK\r\n\r\n") as (port, _, _):
        assert (await scan._probe_rtsp(scan._Target("127.0.0.1"), port, "rtsp", .5))["status"] == "verified"


@pytest.mark.asyncio
async def test_cancel_during_writer_shutdown_aborts_the_transport():
    entered = asyncio.Event()
    class Transport:
        aborted = False
        def abort(self):
            self.aborted = True
    class Writer:
        transport = Transport()
        closed = False
        def close(self):
            self.closed = True
        async def wait_closed(self):
            entered.set()
            await asyncio.Future()
    writer = Writer()
    closing = asyncio.create_task(scan._close_writer(writer))
    await entered.wait(); closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert writer.closed and writer.transport.aborted


def tls_fixture(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "camera.example")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("camera.example")]), critical=False).sign(key, hashes.SHA256()))
    cert, private = tmp_path / "fixture-cert.pem", tmp_path / "fixture-key.pem"
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server.load_cert_chain(cert, private)
    return server, ssl.create_default_context(cafile=str(cert))


@pytest.mark.asyncio
async def test_rtsps_requires_verified_certificate_and_uses_original_dns_sni(tmp_path):
    server, trusted = tls_fixture(tmp_path)
    async with local_rtsp_server(b"RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", tls=server) as (port, _, _):
        with pytest.raises(scan._TLSUnverified):
            await scan._probe_rtsp(scan._Target("127.0.0.1", "camera.example"), port, "rtsps", 1)
        service = await scan._probe_rtsp(scan._Target("127.0.0.1", "camera.example"), port, "rtsps", 1, trusted)
        assert service["url"] == f"rtsps://camera.example:{port}/" and service["status"] == "verified"
        with pytest.raises(scan._TLSUnverified):
            await scan._probe_rtsp(scan._Target("127.0.0.1", "wrong.example"), port, "rtsps", 1, trusted)
        unverified = ssl._create_unverified_context()
        with pytest.raises(scan.NetworkScanError, match="verification"):
            await scan._probe_rtsp(scan._Target("127.0.0.1"), port, "rtsps", 1, unverified)


@pytest.mark.asyncio
async def test_deadline_returns_only_finished_checks_partial_results_and_closes_the_client(monkeypatch):
    clients, _ = mocked_http(monkeypatch, lambda request: httpx.Response(404))
    active = 0
    async def probe(target, port, method, timeout, context=None):
        nonlocal active
        active += 1
        try:
            if port == 8554:
                await asyncio.Future()
            return {"protocol": method, "host": target.host, "port": port, "url": scan._uri(method, target.host, port),
                    "status": "verified", "stream_path_known": False}
        finally:
            active -= 1
    monkeypatch.setattr(scan, "_probe_rtsp", probe)
    result = await scan.scan_targets(["10.0.0.8"], ["rtsp"], rtsp_ports=[554, 8554], deadline=.05)
    assert result["partial"] and result["completed"] == 1 and result["total"] == 2
    assert result["devices"][0]["endpoint"] == "" and result["devices"][0]["xaddrs"] == []
    assert active == 0 and clients[0].is_closed and any("time limit" in message for message in result["warnings"])


@pytest.mark.asyncio
async def test_external_scan_cancellation_closes_all_32_workers_and_client(monkeypatch):
    clients, _ = mocked_http(monkeypatch, lambda request: httpx.Response(404))
    active, maximum = 0, 0
    async def probe(*args, **kwargs):
        nonlocal active, maximum
        active += 1; maximum = max(maximum, active)
        try:
            await asyncio.Future()
        finally:
            active -= 1
    monkeypatch.setattr(scan, "_probe_rtsp", probe)
    task = asyncio.create_task(scan.scan_targets(["10.0.0.0/26"], ["rtsp"], rtsp_ports=[554]))
    while maximum < 32:
        await asyncio.sleep(.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert active == 0 and maximum == 32 and clients[0].is_closed
    assert not any(task.get_name() == "directed-service-scan" for task in asyncio.all_tasks())


@pytest.mark.asyncio
async def test_progress_is_throttled_and_mutating_snapshots_does_not_change_results(monkeypatch):
    mocked_http(monkeypatch, lambda request: httpx.Response(404))
    async def probe(target, port, method, timeout, context):
        await asyncio.sleep(.28)
        return {"protocol": method, "host": target.host, "port": port, "url": scan._uri(method, target.host, port),
                "status": "verified", "stream_path_known": False}
    monkeypatch.setattr(scan, "_probe_rtsp", probe)
    updates = []
    def progress(snapshot):
        updates.append((time.monotonic(), snapshot["completed"], snapshot["total"]))
        snapshot["warnings"].append("injected")
        if snapshot["devices"]:
            snapshot["devices"][0]["services"][0]["url"] = "injected"
        snapshot["devices"].append({"fake": True})
    result = await scan.scan_targets(["10.0.0.0/25"], ["rtsp"], rtsp_ports=[554], progress=progress)
    assert result["completed"] == result["total"] == 126 and not result["partial"]
    assert len(updates) >= 2 and all(second[0] - first[0] >= .49 for first, second in zip(updates, updates[1:]))
    assert all(total == 126 for _, _, total in updates)
    assert len(result["devices"]) == 126 and "injected" not in json.dumps(result)
