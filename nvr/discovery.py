"""Bounded, local ONVIF WS-Discovery and optional explicit subnet probing.

ONVIF Core 7.3 uses WS-Discovery 2005/04 and WS-Addressing 2004/08.
The OASIS 2009/01 variant is probed too for interoperability. Discovery does
not authenticate, modify cameras, fetch WSDLs or contact any cloud service.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import ipaddress
import math
import socket
import struct
import sys
import time
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import UUID, uuid4
from xml.etree import ElementTree as ET

import httpx
from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

SOAP = "http://www.w3.org/2003/05/soap-envelope"
SOAP11 = "http://schemas.xmlsoap.org/soap/envelope/"
WSA04 = "http://schemas.xmlsoap.org/ws/2004/08/addressing"
WSA05 = "http://www.w3.org/2005/08/addressing"
WSD05 = "http://schemas.xmlsoap.org/ws/2005/04/discovery"
WSD09 = "http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01"
DEVICE = "http://www.onvif.org/ver10/device/wsdl"
NETWORK = "http://www.onvif.org/ver10/network/wsdl"
MULTICAST_TARGET = ("239.255.255.250", 3702)
MAX_DATAGRAM = 65507
MAX_DEVICES = 128
MAX_RESPONSE = 256 * 1024
LAN_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in
                     ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"))


class DiscoveryError(ValueError):
    """An input error safe to display without exposing device data."""


def _lan_address(value: str) -> bool:
    try:
        ip = ipaddress.IPv4Address(value)
        return any(ip in network for network in LAN_NETWORKS)
    except ipaddress.AddressValueError:
        return False


def list_interfaces() -> list[dict]:
    """List active LAN IPv4 interfaces; unavailable masks remain blank.

    Linux uses standard interface ioctls without elevated privileges. Other
    platforms use hostname addresses and a UDP route lookup that sends no data.
    """
    interfaces = []
    seen = set()
    if sys.platform.startswith("linux"):
        try:
            import fcntl
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                for _, name in socket.if_nameindex():
                    try:
                        request = struct.pack("256s", name.encode()[:15])
                        flags = struct.unpack_from("H", fcntl.ioctl(probe.fileno(), 0x8913, request), 16)[0]
                        if not flags & 1 or flags & 8:  # IFF_UP, IFF_LOOPBACK
                            continue
                        address = socket.inet_ntoa(fcntl.ioctl(probe.fileno(), 0x8915, request)[20:24])
                        mask = socket.inet_ntoa(fcntl.ioctl(probe.fileno(), 0x891B, request)[20:24])
                        if _lan_address(address) and address not in seen:
                            cidr = str(ipaddress.IPv4Network(f"{address}/{mask}", strict=False))
                            interfaces.append({"name": name, "address": address, "netmask": mask, "cidr": cidr})
                            seen.add(address)
                    except (OSError, ValueError):
                        continue
        except (ImportError, OSError, AttributeError):
            pass
    if not interfaces:
        candidates = []
        with contextlib.suppress(OSError):
            candidates.extend(info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
        with contextlib.suppress(OSError):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(MULTICAST_TARGET)  # routing decision only; no packet is sent
                candidates.append(probe.getsockname()[0])
        for address in candidates:
            if _lan_address(address) and address not in seen:
                interfaces.append({"name": "default", "address": address, "netmask": "", "cidr": ""})
                seen.add(address)
    return sorted(interfaces, key=lambda item: (item["name"], ipaddress.IPv4Address(item["address"])))


def _probe(message_id: str, discovery: str, addressing: str, typed: bool) -> bytes:
    destination = ("urn:schemas-xmlsoap-org:ws:2005:04:discovery" if discovery == WSD05 else
                   "urn:docs-oasis-open-org:ws-dd:ns:discovery:2009:01")
    anonymous = addressing + ("/role/anonymous" if addressing == WSA04 else "/anonymous")
    types = "<d:Types>dn:NetworkVideoTransmitter</d:Types>" if typed else ""
    return (f'<s:Envelope xmlns:s="{SOAP}" xmlns:a="{addressing}" xmlns:d="{discovery}" xmlns:dn="{NETWORK}">'
            f'<s:Header><a:MessageID>{message_id}</a:MessageID><a:To s:mustUnderstand="1">{destination}</a:To>'
            f'<a:Action s:mustUnderstand="1">{discovery}/Probe</a:Action>'
            f'<a:ReplyTo><a:Address>{anonymous}</a:Address></a:ReplyTo></s:Header>'
            f'<s:Body><d:Probe>{types}</d:Probe></s:Body></s:Envelope>').encode()


def _safe_endpoint(value: str, source_ip: str) -> str | None:
    try:
        if len(value) > 2048 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            return None
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None or parsed.fragment:
            return None
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            return None
        if parsed.hostname in {"0.0.0.0", "::"}:
            host = source_ip + (f":{parsed.port}" if parsed.port else "")
            parsed = parsed._replace(netloc=host)
        return urlunsplit(parsed)
    except (ValueError, TypeError):
        return None


def _clean_label(value: str) -> str:
    return " ".join("".join(c for c in unquote(value) if 32 <= ord(c) != 127).split())[:160]


def _safe_scopes(value: str) -> list[str]:
    scopes = []
    for scope in value.split()[:64]:
        try:
            parsed = urlsplit(scope)
            if len(scope) <= 1024 and parsed.scheme == "onvif" and parsed.hostname == "www.onvif.org" and not (
                    parsed.username or parsed.password or parsed.query or parsed.fragment):
                scopes.append(scope)
        except ValueError:
            continue
    return list(dict.fromkeys(scopes))


def _scope_label(scopes: list[str], category: str) -> str:
    prefix = f"onvif://www.onvif.org/{category}/"
    values = [_clean_label(scope[len(prefix):]) for scope in scopes if scope.startswith(prefix)]
    return "; ".join(value for value in values if value)[:240]


def _device(endpoint: str, source_ip: str, xaddrs: list[str], scopes: list[str], epr: str = "") -> dict:
    try:
        identity = "urn:uuid:" + str(UUID(epr.removeprefix("urn:").removeprefix("uuid:")))
    except (ValueError, AttributeError):
        identity = "endpoint:" + hashlib.sha256(endpoint.encode()).hexdigest()[:24]
    return {"id": identity, "ip": source_ip, "endpoint": endpoint, "xaddrs": xaddrs,
            "name": _scope_label(scopes, "name"), "hardware": _scope_label(scopes, "hardware"),
            "location": _scope_label(scopes, "location"), "scopes": scopes}


def _parse_probe_matches(data: bytes, source_ip: str, message_ids: set[str]) -> list[dict]:
    if not data or len(data) > MAX_DATAGRAM:
        return []
    try:
        namespaces = {}
        parser = SafeET.iterparse(io.BytesIO(data), events=("start-ns", "end"), forbid_dtd=True)
        for event, node in parser:
            if event == "start-ns":
                namespaces[node[0]] = node[1]
        root = parser.root
        if root.tag not in {f"{{{SOAP}}}Envelope", f"{{{SOAP11}}}Envelope"}:
            return []
        envelope_ns = root.tag[1:].split("}", 1)[0]
        header = root.find(f"{{{envelope_ns}}}Header")
        if header is not None:
            for addressing in (WSA04, WSA05):
                relates = header.find(f"{{{addressing}}}RelatesTo")
                if relates is not None and (relates.text or "").strip() not in message_ids:
                    return []
                action = header.find(f"{{{addressing}}}Action")
                if action is not None and (action.text or "").strip() not in {WSD05 + "/ProbeMatches", WSD09 + "/ProbeMatches"}:
                    return []
        body = root.find(f"{{{envelope_ns}}}Body")
        devices = []
        if body is None:
            return devices
        for discovery in (WSD05, WSD09):
            matches = body.find(f"{{{discovery}}}ProbeMatches")
            if matches is None:
                continue
            for match in list(matches)[:MAX_DEVICES]:
                if match.tag != f"{{{discovery}}}ProbeMatch":
                    continue
                def text(name):
                    node = match.find(f"{{{discovery}}}{name}")
                    return (node.text or "").strip() if node is not None else ""
                xaddrs = list(dict.fromkeys(endpoint for value in text("XAddrs").split()[:16]
                                            if (endpoint := _safe_endpoint(value, source_ip))))
                if not xaddrs:
                    continue
                scopes = _safe_scopes(text("Scopes"))
                known_type = False
                for typename in text("Types").split():
                    prefix, _, local = typename.rpartition(":")
                    namespace = namespaces.get(prefix, "")
                    known_type |= ((local == "NetworkVideoTransmitter" and namespace == NETWORK) or
                                   (local == "Device" and namespace == DEVICE))
                if not known_type and not scopes and not any("/onvif/" in urlsplit(url).path.lower() for url in xaddrs):
                    continue
                endpoint = next((url for url in xaddrs if urlsplit(url).hostname == source_ip), xaddrs[0])
                epr = next(((node.text or "").strip() for addressing in (WSA04, WSA05)
                            if (node := match.find(f"{{{addressing}}}EndpointReference/{{{addressing}}}Address")) is not None), "")
                devices.append(_device(endpoint, source_ip, xaddrs, scopes, epr))
        return devices
    except (ET.ParseError, DefusedXmlException, ValueError, TypeError):
        return []


def _merge_device(devices: list[dict], incoming: dict) -> None:
    for existing in devices:
        if existing["id"] == incoming["id"] or set(existing["xaddrs"]) & set(incoming["xaddrs"]):
            for key in ("xaddrs", "scopes"):
                existing[key] = list(dict.fromkeys(existing[key] + incoming[key]))[:64]
            for key in ("name", "hardware", "location"):
                if not existing[key]:
                    existing[key] = incoming[key]
            if incoming["id"].startswith("urn:uuid:"):
                existing["id"] = incoming["id"]
            return
    if len(devices) < MAX_DEVICES:
        devices.append(incoming)


def _open_socket(address: str) -> socket.socket:
    channel = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        channel.setblocking(False)
        channel.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(address))
        channel.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        channel.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
        channel.bind((address, 0))
        return channel
    except BaseException:
        channel.close()
        raise


async def _discover_interface(address: str, timeout: float) -> tuple[list[dict], list[str]]:
    loop = asyncio.get_running_loop()
    channel = None
    sender = None
    devices, warnings = [], []
    try:
        channel = _open_socket(address)
        probes = [("urn:uuid:" + str(uuid4()), discovery, addressing, typed) for discovery, addressing, typed in
                  ((WSD05, WSA04, True), (WSD05, WSA04, False),
                   (WSD05, WSA05, False), (WSD09, WSA05, False))]
        message_ids = {probe[0] for probe in probes}
        started = loop.time()
        async def send():
            for delay in (0.0, 0.35, 1.1):
                await asyncio.sleep(max(0, started + delay - loop.time()))
                if loop.time() >= started + timeout:
                    return
                for probe in probes:
                    await loop.sock_sendto(channel, _probe(*probe), MULTICAST_TARGET)
        sender = asyncio.create_task(send(), name="onvif-probe-send")
        for _ in range(512):
            remaining = started + timeout - loop.time()
            if remaining <= 0:
                break
            try:
                data, source = await asyncio.wait_for(loop.sock_recvfrom(channel, MAX_DATAGRAM + 1), remaining)
            except asyncio.TimeoutError:
                break
            for device in _parse_probe_matches(data, source[0], message_ids):
                _merge_device(devices, device)
        else:
            warnings.append("Too many discovery responses: search limited to protect the recorder.")
        if sender.done() and not sender.cancelled() and sender.exception():
            warnings.append(f"Multicast sending unavailable on interface {address}.")
    except OSError:
        warnings.append(f"Multicast discovery unavailable on interface {address}.")
    finally:
        if sender:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        if channel:
            channel.close()
    return devices, warnings


async def discover(interface_ip: str | None = None, timeout: float = 6) -> dict:
    """Probe ONVIF devices on selected interfaces, without credentials or HTTP calls."""
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0.1 <= timeout <= 10:
        raise DiscoveryError("Discovery duration must be between 0.1 and 10 seconds.")
    started = time.monotonic()
    try:
        interfaces = await asyncio.wait_for(asyncio.to_thread(list_interfaces), 1)
    except (OSError, asyncio.TimeoutError):
        interfaces = []
    addresses = list(dict.fromkeys(item["address"] for item in interfaces))
    warnings = []
    if interface_ip is not None:
        try:
            interface_ip = str(ipaddress.IPv4Address(interface_ip))
        except (ValueError, TypeError):
            raise DiscoveryError("Select a valid local IPv4 address.") from None
        if interface_ip not in addresses:
            raise DiscoveryError("The selected address does not belong to an available LAN interface.")
        addresses = [interface_ip]
    if not addresses:
        addresses = ["0.0.0.0"]
        warnings.append("LAN interface not identified: using the default multicast route.")
    if len(addresses) > 16:
        addresses = addresses[:16]
        warnings.append("Discovery limited to the first 16 available IPv4 interfaces.")
    results = await asyncio.gather(*(_discover_interface(address, timeout) for address in addresses))
    devices = []
    for found, notices in results:
        warnings.extend(notices)
        for device in found:
            _merge_device(devices, device)
    if not devices:
        warnings.append("No ONVIF devices found. Check ONVIF, interface, VLAN and UDP 3702 multicast; alternatively scan a subnet or enter the endpoint.")
    return {"devices": sorted(devices, key=lambda device: (device["ip"], device["endpoint"])),
            "warnings": list(dict.fromkeys(warnings)), "duration": round(time.monotonic() - started, 3)}


def _scan_targets(cidr: str, ports: list[int]) -> tuple[list[str], list[int]]:
    try:
        network = ipaddress.IPv4Network(cidr, strict=False)
        if network.prefixlen < 24 or not any(network.subnet_of(allowed) for allowed in LAN_NETWORKS):
            raise ValueError
        if not 1 <= len(ports) <= 8 or any(isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535 for port in ports):
            raise ValueError
        return [str(host) for host in network.hosts()], list(dict.fromkeys(ports))
    except (ValueError, TypeError, AttributeError):
        raise DiscoveryError("Use a private IPv4 subnet of /24 or smaller and 1 to 8 valid ports.") from None


async def _verify_endpoint(client: httpx.AsyncClient, host: str, port: int, timeout: float, *, server_hostname: str | None = None) -> dict | None:
    # Explicit, read-only PRE_AUTH operation (ONVIF Core 8.3.6). No passwords,
    # generic web port detection, redirects or advertised follow-up addresses.
    authority = f"[{host}]" if ":" in host and not host.startswith("[") else host
    endpoint = f"{'https' if port == 443 else 'http'}://{authority}:{port}/onvif/device_service"
    headers = {"Content-Type": f'application/soap+xml; charset=utf-8; action="{DEVICE}/GetSystemDateAndTime"',
               "SOAPAction": f'"{DEVICE}/GetSystemDateAndTime"'}
    extensions = {}
    logical_endpoint = endpoint
    if server_hostname is not None:
        # Callers resolve and validate once, then connect to the numeric host.
        # Retain the original authority for virtual hosts and certificate/SNI
        # validation without allowing HTTP redirects or a second DNS lookup.
        if (not isinstance(server_hostname, str) or not server_hostname or len(server_hostname) > 253
                or any(not (character.isascii() and (character.isalnum() or character in ".-")) for character in server_hostname)):
            return None
        headers["Host"] = f"{server_hostname}:{port}"
        extensions["sni_hostname"] = server_hostname
        logical_endpoint = f"{'https' if port == 443 else 'http'}://{server_hostname}:{port}/onvif/device_service"
    payload = (f'<s:Envelope xmlns:s="{SOAP}" xmlns:tds="{DEVICE}"><s:Body>'
               '<tds:GetSystemDateAndTime/></s:Body></s:Envelope>').encode()
    try:
        async with asyncio.timeout(timeout):
            async with client.stream("POST", endpoint, content=payload, headers=headers, extensions=extensions) as response:
                if not 200 <= response.status_code < 300:
                    return None
                data = bytearray()
                async for chunk in response.aiter_bytes(16384):
                    if len(data) + len(chunk) > MAX_RESPONSE:
                        return None
                    data.extend(chunk)
            root = SafeET.fromstring(data, forbid_dtd=True)
            for soap in (SOAP, SOAP11):
                if root.tag == f"{{{soap}}}Envelope":
                    body = root.find(f"{{{soap}}}Body")
                    if body is not None and body.find(f"{{{DEVICE}}}GetSystemDateAndTimeResponse") is not None:
                        return _device(logical_endpoint, host, [logical_endpoint], [])
    except (httpx.HTTPError, OSError, asyncio.TimeoutError, ET.ParseError, DefusedXmlException, ValueError):
        pass
    return None


async def scan_network(cidr: str, ports: list[int], timeout: float = 0.6) -> dict:
    """Explicit bounded unicast fallback: at most 256 addresses and eight ports.

    Only a correctly namespaced ONVIF SOAP response verifies a device. Cameras
    requiring authentication even for the PRE_AUTH operation are not guessed.
    """
    hosts, ports = _scan_targets(cidr, ports)
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0.1 <= timeout <= 2:
        raise DiscoveryError("The endpoint timeout must be between 0.1 and 2 seconds.")
    started = time.monotonic()
    queue = asyncio.Queue()
    for host in hosts:
        for port in ports:
            queue.put_nowait((host, port))
    devices = []
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=timeout,
                                 limits=httpx.Limits(max_connections=32, max_keepalive_connections=0)) as client:
        async def worker():
            while True:
                try:
                    host, port = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                found = await _verify_endpoint(client, host, port, timeout)
                if found:
                    _merge_device(devices, found)
        tasks = [asyncio.create_task(worker(), name="onvif-subnet-probe") for _ in range(min(32, queue.qsize()))]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    warnings = []
    if not devices:
        warnings.append("No ONVIF endpoints verified. The scan uses /onvif/device_service on the selected ports; enter other endpoints or devices requiring authentication manually.")
    return {"devices": sorted(devices, key=lambda device: (device["ip"], device["endpoint"])),
            "warnings": warnings, "duration": round(time.monotonic() - started, 3)}
