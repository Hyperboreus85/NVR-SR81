import asyncio
from collections import Counter
import contextlib
import socket
import unittest
from unittest.mock import AsyncMock, patch
from xml.etree import ElementTree as ET

import httpx

from nvr import discovery as d


UUID = "urn:uuid:09e40b20-bdd5-4391-a284-1b1838b52221"
SCOPES = ("onvif://www.onvif.org/name/Ingresso%20principale "
          "onvif://www.onvif.org/hardware/IPC-H265 "
          "onvif://www.onvif.org/location/building/Deposito")


def reply(message="probe-1", *, endpoint="http://192.168.1.20/onvif/device_service", epr=UUID,
          scopes=SCOPES, types="dn:NetworkVideoTransmitter", namespace=d.WSD05, addressing=d.WSA04):
    relates = f"<a:RelatesTo>{message}</a:RelatesTo>" if message else ""
    return (f'<s:Envelope xmlns:s="{d.SOAP}" xmlns:d="{namespace}" xmlns:a="{addressing}" xmlns:dn="{d.NETWORK}">'
            f'<s:Header>{relates}<a:Action>{namespace}/ProbeMatches</a:Action></s:Header>'
            f'<s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>{epr}</a:Address>'
            f'</a:EndpointReference><d:Types>{types}</d:Types><d:Scopes>{scopes}</d:Scopes>'
            f'<d:XAddrs>{endpoint}</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>').encode()


class DiscoveryParserTests(unittest.TestCase):
    def test_probes_have_legacy_and_modern_action_address_and_message(self):
        for wsd, wsa in ((d.WSD05, d.WSA04), (d.WSD05, d.WSA05), (d.WSD09, d.WSA05)):
            root = ET.fromstring(d._probe("urn:uuid:1234", wsd, wsa, True))
            self.assertEqual(root.find(f".//{{{wsa}}}MessageID").text, "urn:uuid:1234")
            self.assertEqual(root.find(f".//{{{wsa}}}Action").text, wsd + "/Probe")
            self.assertIsNotNone(root.find(f".//{{{wsd}}}Probe"))

    def test_parse_scopes_uuid_and_correlated_match(self):
        devices = d._parse_probe_matches(reply(), "192.168.1.20", {"probe-1"})
        self.assertEqual(len(devices), 1)
        device = devices[0]
        self.assertEqual(device["id"], UUID)
        self.assertEqual(device["name"], "Ingresso principale")
        self.assertEqual(device["hardware"], "IPC-H265")
        self.assertEqual(device["location"], "building/Deposito")
        self.assertEqual(device["ip"], "192.168.1.20")
        self.assertNotIn("password", device)

    def test_wrong_message_is_ignored_but_missing_relates_to_is_interoperable(self):
        self.assertEqual(d._parse_probe_matches(reply("other-probe"), "192.168.1.20", {"probe-1"}), [])
        self.assertEqual(len(d._parse_probe_matches(reply(None), "192.168.1.20", {"probe-1"})), 1)

    def test_modern_ws_discovery_parses(self):
        self.assertEqual(len(d._parse_probe_matches(reply(namespace=d.WSD09, addressing=d.WSA05),
                                                  "192.168.1.20", {"probe-1"})), 1)

    def test_malformed_oversize_and_dtd_are_ignored(self):
        for payload in (b"not xml", b"x" * (d.MAX_DATAGRAM + 1),
                        b'<!DOCTYPE x [<!ENTITY evil SYSTEM "file:///etc/passwd">]><x>&evil;</x>',
                        b'<!DOCTYPE x><x/>', b'<ProbeMatches/>'):
            with self.subTest(payload=payload[:60]):
                self.assertEqual(d._parse_probe_matches(payload, "192.168.1.20", {"probe-1"}), [])

    def test_only_credential_free_http_endpoints_are_returned(self):
        bad = "http://user:secret@192.168.1.20/onvif file:///etc/passwd http://host/onvif#token http://host:bad/onvif"
        self.assertEqual(d._parse_probe_matches(reply(endpoint=bad), "192.168.1.20", {"probe-1"}), [])
        endpoint = "http://0.0.0.0:8899/onvif/device_service?channel=1"
        device = d._parse_probe_matches(reply(endpoint=endpoint), "192.168.1.20", {"probe-1"})[0]
        self.assertEqual(device["endpoint"], "http://192.168.1.20:8899/onvif/device_service?channel=1")
        self.assertNotIn("secret", repr(device))

    def test_generic_printer_is_ignored(self):
        payload = reply(endpoint="http://192.168.1.20/printer", scopes="", types="dn:Printer")
        self.assertEqual(d._parse_probe_matches(payload, "192.168.1.20", {"probe-1"}), [])

    def test_dedup_by_epr_or_shared_endpoint_merges_metadata(self):
        first = d._parse_probe_matches(reply(scopes=""), "192.168.1.20", {"probe-1"})[0]
        second = d._parse_probe_matches(reply(endpoint="http://192.168.2.20/onvif/device_service"),
                                       "192.168.2.20", {"probe-1"})[0]
        devices = []
        d._merge_device(devices, first)
        d._merge_device(devices, second)
        self.assertEqual(len(devices), 1)
        self.assertEqual(len(devices[0]["xaddrs"]), 2)
        self.assertEqual(devices[0]["name"], "Ingresso principale")
        third = dict(second, id="endpoint:other")
        d._merge_device(devices, third)
        self.assertEqual(len(devices), 1)

    def test_explicit_scan_is_restricted_to_small_private_ipv4_ranges(self):
        for cidr, ports in (("192.168.0.0/23", [80]), ("8.8.8.8/32", [80]), ("127.0.0.0/24", [80]),
                            ("::1/128", [80]), ("192.168.1.0/24", []), ("192.168.1.0/24", [True]),
                            ("192.168.1.0/24", [0]), ("192.168.1.0/24", list(range(1, 10)))):
            with self.subTest(cidr=cidr, ports=ports), self.assertRaises(d.DiscoveryError):
                d._scan_targets(cidr, ports)
        hosts, ports = d._scan_targets("192.168.1.99/24", [80, 80, 8899])
        self.assertEqual(len(hosts), 254)
        self.assertEqual(ports, [80, 8899])

    def test_cross_platform_interfaces_exclude_non_lan_and_do_not_guess_netmask(self):
        with patch.object(d.sys, "platform", "test"), patch.object(d.socket, "getaddrinfo", return_value=[
            (None, None, None, None, ("192.168.8.2", 0)), (None, None, None, None, ("127.0.0.1", 0)),
            (None, None, None, None, ("8.8.8.8", 0))]), patch.object(d.socket, "socket") as factory:
            factory.return_value.__enter__.return_value.getsockname.return_value = ("192.168.8.2", 0)
            interfaces = d.list_interfaces()
        self.assertEqual(interfaces, [{"name": "default", "address": "192.168.8.2", "netmask": "", "cidr": ""}])


class DiscoveryAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def make_responder(self):
        class Responder(asyncio.DatagramProtocol):
            def connection_made(self, transport):
                self.transport = transport
                self.messages = []
            def datagram_received(self, payload, address):
                root = ET.fromstring(payload)
                message_id = next(node.text for node in root.iter() if node.tag.endswith("}MessageID"))
                self.messages.append(message_id)
                self.transport.sendto(reply("unrelated", endpoint="http://127.0.0.1/bad/onvif/service"), address)
                self.transport.sendto(b"malformed", address)
                response = reply(message_id, endpoint="http://127.0.0.1:8080/onvif/device_service")
                self.transport.sendto(response, address)
                self.transport.sendto(response, address)
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(Responder, local_addr=("127.0.0.1", 0))
        return transport, transport.get_extra_info("sockname")

    async def test_real_udp_reply_matching_and_dedup_without_actual_lan(self):
        transport, address = await self.make_responder()
        try:
            interfaces = [{"name": "test", "address": "127.0.0.1", "netmask": "255.0.0.0", "cidr": "127.0.0.0/8"}]
            with patch.object(d, "MULTICAST_TARGET", address), patch.object(d, "list_interfaces", return_value=interfaces):
                result = await d.discover("127.0.0.1", timeout=0.45)
            self.assertEqual(len(result["devices"]), 1)
            self.assertEqual(result["devices"][0]["endpoint"], "http://127.0.0.1:8080/onvif/device_service")
            self.assertEqual(result["warnings"], [])
            self.assertGreaterEqual(result["duration"], 0.15)
            self.assertLess(result["duration"], 2)
            self.assertEqual(len(set(transport.get_protocol().messages)), 4)
            self.assertGreaterEqual(max(Counter(transport.get_protocol().messages).values()), 2)
        finally:
            transport.close()

    async def test_cancelled_udp_discovery_closes_sockets_and_sender_tasks(self):
        sockets = []
        original = d._open_socket
        def opened(address):
            channel = original(address)
            sockets.append(channel)
            return channel
        transport, address = await self.make_responder()
        try:
            with patch.object(d, "MULTICAST_TARGET", address), patch.object(d, "_open_socket", side_effect=opened), \
                 patch.object(d, "list_interfaces", return_value=[{"address": "127.0.0.1"}]):
                task = asyncio.create_task(d.discover(timeout=6))
                await asyncio.sleep(0.1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertTrue(sockets)
            self.assertTrue(all(channel.fileno() == -1 for channel in sockets))
            self.assertFalse([task for task in asyncio.all_tasks() if task.get_name() == "onvif-probe-send"])
        finally:
            transport.close()

    async def test_unavailable_selected_interface_is_rejected(self):
        with patch.object(d, "list_interfaces", return_value=[{"address": "192.168.1.2"}]), \
             patch.object(d, "_discover_interface", new_callable=AsyncMock) as worker:
            with self.assertRaises(d.DiscoveryError):
                await d.discover("192.168.1.3")
            worker.assert_not_awaited()

    async def test_auto_selection_merges_replies_from_all_interfaces(self):
        device = d._parse_probe_matches(reply(), "192.168.1.20", {"probe-1"})[0]
        worker = AsyncMock(return_value=([device], []))
        with patch.object(d, "list_interfaces", return_value=[{"address": "192.168.1.2"}, {"address": "10.0.0.2"}]), \
             patch.object(d, "_discover_interface", worker):
            result = await d.discover(timeout=0.1)
        self.assertEqual(worker.await_count, 2)
        self.assertEqual(len(result["devices"]), 1)

    async def test_socket_failure_returns_safe_warning(self):
        with patch.object(d, "list_interfaces", return_value=[{"address": "192.168.1.2"}]), \
             patch.object(d, "_open_socket", side_effect=OSError("private detail")):
            result = await d.discover(timeout=0.1)
        self.assertEqual(result["devices"], [])
        self.assertTrue(result["warnings"])
        self.assertNotIn("private detail", repr(result))

    async def test_unicast_only_accepts_valid_onvif_response(self):
        valid = (f'<s:Envelope xmlns:s="{d.SOAP}" xmlns:tds="{d.DEVICE}"><s:Body>'
                 '<tds:GetSystemDateAndTimeResponse/></s:Body></s:Envelope>').encode()
        cases = [(200, valid, True), (401, b"Unauthorized", False), (200, b"<html>Camera</html>", False),
                 (302, valid, False), (200, valid.replace(d.DEVICE.encode(), b"urn:other"), False),
                 (200, b"x" * (d.MAX_RESPONSE + 1), False), (200, b"<!DOCTYPE x><x/>", False)]
        for status, body, expected in cases:
            async def handler(request):
                self.assertNotIn("authorization", request.headers)
                self.assertIn(b"GetSystemDateAndTime", request.content)
                return httpx.Response(status, content=body)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
                result = await d._verify_endpoint(client, "192.168.1.20", 80, 0.5)
            self.assertEqual(result is not None, expected, (status, body[:60]))

    async def test_scan_limits_concurrency_and_returns_verified_devices(self):
        active, maximum, count = 0, 0, 0
        async def verify(client, host, port, timeout):
            nonlocal active, maximum, count
            active += 1
            maximum = max(maximum, active)
            count += 1
            try:
                await asyncio.sleep(0.005)
                return d._device(f"http://{host}/onvif/device_service", host, [f"http://{host}/onvif/device_service"], []) if host.endswith(".1") else None
            finally:
                active -= 1
        with patch.object(d, "_scan_targets", return_value=([f"192.168.1.{i}" for i in range(1, 101)], [80])), \
             patch.object(d, "_verify_endpoint", side_effect=verify):
            result = await d.scan_network("192.168.1.0/24", [80])
        self.assertEqual(count, 100)
        self.assertLessEqual(maximum, 32)
        self.assertEqual(len(result["devices"]), 1)

    async def test_real_http_onvif_response_on_loopback(self):
        response = (f'<s:Envelope xmlns:s="{d.SOAP}" xmlns:tds="{d.DEVICE}"><s:Body>'
                    '<tds:GetSystemDateAndTimeResponse/></s:Body></s:Envelope>').encode()
        requests = []
        async def serve(reader, writer):
            try:
                headers = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)
                requests.append(headers)
                content_length = next(int(line.split(b":", 1)[1]) for line in headers.split(b"\r\n")
                                      if line.lower().startswith(b"content-length:"))
                body = await reader.readexactly(content_length)
                self.assertIn(b"GetSystemDateAndTime", body)
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/soap+xml\r\nContent-Length: " +
                             str(len(response)).encode() + b"\r\nConnection: close\r\n\r\n" + response)
                await writer.drain()
            finally:
                writer.close()
                with contextlib.suppress(OSError):
                    await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        async with server:
            port = server.sockets[0].getsockname()[1]
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as client:
                result = await d._verify_endpoint(client, "127.0.0.1", port, 0.6)
        self.assertEqual(result["endpoint"], f"http://127.0.0.1:{port}/onvif/device_service")
        self.assertNotIn(b"authorization:", requests[0].lower())

    async def test_unicast_whole_response_timeout_is_bounded(self):
        async def handler(request):
            await asyncio.sleep(2)
            return httpx.Response(200, content=b"<Envelope/>")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await asyncio.wait_for(d._verify_endpoint(client, "192.168.1.20", 80, 0.1), 0.5)
        self.assertIsNone(result)

    async def test_cancelled_scan_stops_all_workers(self):
        started = asyncio.Event()
        active = 0
        async def verify(*args):
            nonlocal active
            active += 1
            started.set()
            try:
                await asyncio.Future()
            finally:
                active -= 1
        with patch.object(d, "_verify_endpoint", side_effect=verify):
            task = asyncio.create_task(d.scan_network("192.168.1.0/24", [80]))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(active, 0)
        self.assertFalse([task for task in asyncio.all_tasks() if task.get_name() == "onvif-subnet-probe"])


if __name__ == "__main__":
    unittest.main()
