"""One-shot local DNS-SD browsing for explicitly advertised RTSP services.

RFC 6762 5.1/6.7 permits an ephemeral source port with unicast replies and a
matching query ID. RFC 6763 4/5/12.1 defines PTR -> SRV -> A/AAAA resolution.
TXT is deliberately ignored: no credentials, stream paths or HTTP locations
are read, fetched or guessed. A discovered service is not a verified stream.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import ipaddress
import math
import secrets
import socket
import struct
import time
import unicodedata

from .discovery import DiscoveryError, list_interfaces


TARGET = ("224.0.0.251", 5353)
MAX_PACKET = 65535
MAX_PACKETS = 128
MAX_RECORDS = 512
MAX_DEVICES = 128
MAX_INTERFACES = 8
MAX_QUESTIONS = 64
SERVICES = {(b"_rtsp", b"_tcp", b"local"): "rtsp", (b"_rtsps", b"_tcp", b"local"): "rtsps"}
LOCAL_V4 = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"))


def _local_address(value):
    try:
        address = ipaddress.ip_address(value)
        if address.is_loopback or address.is_multicast or address.is_unspecified:
            return None
        if address.version == 4:
            return str(address) if any(address in network for network in LOCAL_V4) else None
        # Link-local IPv6 requires a zone identifier, which stream host fields
        # cannot currently represent. Never invent an unscoped link-local URL.
        if address.is_link_local:
            return None
        return str(address) if address.is_global or address in ipaddress.ip_network("fc00::/7") else None
    except (ValueError, TypeError):
        return None


def read_name(packet, offset):
    """Read an unambiguous tuple of DNS labels with bounded pointer following."""
    labels, visited, end, pointers, size = [], set(), None, 0, 1
    position = offset
    while True:
        if position >= len(packet) or position in visited:
            raise ValueError("Invalid DNS name")
        visited.add(position)
        length = packet[position]
        if length & 0xC0 == 0xC0:
            if position + 1 >= len(packet):
                raise ValueError("Invalid DNS pointer")
            pointers += 1
            if pointers > 8:
                raise ValueError("DNS pointer limit")
            if end is None:
                end = position + 2
            position = ((length & 0x3F) << 8) | packet[position + 1]
            continue
        if length & 0xC0:
            raise ValueError("Invalid DNS label")
        position += 1
        if length == 0:
            return tuple(labels), end if end is not None else position
        if length > 63 or position + length > len(packet):
            raise ValueError("Invalid DNS label")
        size += length + 1
        if size > 255 or len(labels) >= 127:
            raise ValueError("DNS name limit")
        labels.append(bytes(packet[position:position + length]))
        position += length


def parse_packet(packet, query_ids=None):
    """Return only usable IN records; malformed/unsolicited packets are ignored."""
    if not isinstance(packet, bytes) or not 12 <= len(packet) <= MAX_PACKET:
        return []
    try:
        identity, flags, questions, answers, authorities, additional = struct.unpack_from("!6H", packet)
        if identity not in (query_ids if query_ids is not None else {0}) or not flags & 0x8000 or flags & 0x7A0F:
            return []
        if questions > MAX_QUESTIONS or answers + authorities + additional > MAX_RECORDS:
            return []
        offset = 12
        for _ in range(questions):
            _, offset = read_name(packet, offset)
            if offset + 4 > len(packet):
                return []
            offset += 4
        records = []
        for _ in range(answers + authorities + additional):
            owner, offset = read_name(packet, offset)
            if offset + 10 > len(packet):
                return []
            kind, record_class, ttl, length = struct.unpack_from("!HHIH", packet, offset)
            offset += 10
            end = offset + length
            if end > len(packet):
                return []
            owner = tuple(label.lower() for label in owner)
            value = None
            if ttl and record_class & 0x7FFF == 1:
                if kind == 12 and owner in SERVICES:
                    value, stop = read_name(packet, offset)
                    if stop != end or len(value) != 4 or tuple(label.lower() for label in value[1:]) != owner:
                        value = None
                elif kind == 33 and len(owner) == 4 and owner[1:] in SERVICES and length >= 7:
                    _, _, port = struct.unpack_from("!3H", packet, offset)
                    target, stop = read_name(packet, offset + 6)
                    value = (port, tuple(label.lower() for label in target)) if port and target and stop == end else None
                elif kind in {1, 28} and length == (4 if kind == 1 else 16):
                    value = _local_address(ipaddress.ip_address(packet[offset:end]))
            if value is not None:
                records.append((owner, kind, value))
            offset = end
        return records if offset == len(packet) else []
    except (ValueError, TypeError, IndexError, struct.error):
        return []


def _encoded_name(name):
    return b"".join(bytes([len(label)]) + label for label in name) + b"\0"


def build_query(identity, questions):
    questions = list(dict.fromkeys(questions))[:MAX_QUESTIONS]
    return struct.pack("!6H", identity, 0, len(questions), 0, 0, 0) + b"".join(
        _encoded_name(name) + struct.pack("!HH", kind, 1) for name, kind in questions)


@dataclass
class _Budget:
    packets: int = 0
    records: int = 0
    truncated: bool = False


class RecordCache:
    def __init__(self):
        self.records = set()
        self.truncated = False

    def feed(self, records, budget=None):
        for record in records:
            if record in self.records:
                continue
            if len(self.records) >= MAX_RECORDS or budget is not None and budget.records >= MAX_RECORDS:
                self.truncated = True
                if budget is not None:
                    budget.truncated = True
                break
            self.records.add(record)
            if budget is not None:
                budget.records += 1

    def questions(self):
        questions = [(name, 12) for name in SERVICES]
        instances = sorted(value for owner, kind, value in self.records if kind == 12)
        known = {tuple(label.lower() for label in instance) for instance in instances}
        for instance in instances:
            questions.append((instance, 33))
        for owner, kind, value in sorted(self.records):
            if kind == 33 and owner in known and value[1][-1:] == (b"local",):
                questions.extend([(value[1], 1), (value[1], 28)])
        return questions[:MAX_QUESTIONS]

    def devices(self):
        records = sorted(self.records)
        addresses = {}
        for owner, kind, value in records:
            if kind in {1, 28}:
                addresses.setdefault(owner, set()).add(value)
        devices = {}
        for service, kind, instance in records:
            if kind != 12:
                continue
            for owner, srv_kind, srv in records:
                if owner != tuple(label.lower() for label in instance) or srv_kind != 33:
                    continue
                port, target = srv
                for address in sorted(addresses.get(target, ())):
                    if address not in devices and len(devices) >= MAX_DEVICES:
                        self.truncated = True
                        continue
                    protocol = SERVICES[service]
                    host = f"[{address}]" if ":" in address else address
                    label = " ".join("".join(character for character in instance[0].decode("utf-8", errors="replace")
                        if unicodedata.category(character) not in {"Cc", "Cf", "Cs"}).split())[:160]
                    device = devices.setdefault(address, {"id": "mdns:" + hashlib.sha256(address.encode()).hexdigest()[:24],
                        "ip": address, "endpoint": "", "xaddrs": [], "name": label, "hardware": "", "location": "", "scopes": [],
                        "services": [], "methods": ["mdns"]})
                    declared = {"protocol": protocol, "host": address, "port": port, "url": f"{protocol}://{host}:{port}/",
                                "status": "advertised", "stream_path_known": False}
                    if declared not in device["services"]:
                        device["services"].append(declared)
        return sorted(devices.values(), key=lambda device: device["ip"])


async def _send_packet(sock, packet):
    await asyncio.get_running_loop().sock_sendto(sock, packet, TARGET)


async def _receive_packet(sock):
    return await asyncio.get_running_loop().sock_recvfrom(sock, MAX_PACKET + 1)


async def _scan_interface(address, timeout, budget, *, clock=None):
    clock = clock or time.monotonic
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    cache = RecordCache()
    try:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(address))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        sock.bind((address, 0))
        sock.setblocking(False)
        identity = secrets.randbelow(65535) + 1
        start = clock()
        deadline, schedule, sent = start + timeout, (start, start + timeout / 3, start + 2 * timeout / 3), 0
        while clock() < deadline and budget.packets < MAX_PACKETS:
            now = clock()
            if sent < len(schedule) and now >= schedule[sent]:
                await _send_packet(sock, build_query(identity, cache.questions()))
                sent += 1
            wait = min(deadline, schedule[sent] if sent < len(schedule) else deadline) - clock()
            if wait <= 0:
                continue
            try:
                packet, source = await asyncio.wait_for(_receive_packet(sock), wait)
            except asyncio.TimeoutError:
                continue
            if budget.packets >= MAX_PACKETS:
                budget.truncated = True
                break
            budget.packets += 1
            if len(source) < 2 or source[1] != 5353 or _local_address(source[0]) is None:
                continue
            cache.feed(parse_packet(packet, {identity}), budget)
        if budget.packets >= MAX_PACKETS:
            budget.truncated = True
        devices = cache.devices()
        if cache.truncated:
            budget.truncated = True
        return devices
    finally:
        sock.close()


async def discover_mdns(interface_ip=None, timeout=4):
    if type(timeout) not in {int, float} or not math.isfinite(timeout) or not 3 <= timeout <= 6:
        raise DiscoveryError("Choose an mDNS discovery timeout between 3 and 6 seconds.")
    started = time.monotonic()
    try:
        interfaces = await asyncio.to_thread(list_interfaces)
    except OSError:
        return {"devices": [], "warnings": ["mDNS discovery is unavailable on one or more network interfaces."],
                "duration": round(time.monotonic() - started, 3)}
    addresses = list(dict.fromkeys(item.get("address") for item in interfaces
        if isinstance(item, dict) and isinstance(item.get("address"), str) and _local_address(item["address"]) and ":" not in item["address"]))
    warnings = []
    if interface_ip is not None:
        if not isinstance(interface_ip, str) or interface_ip not in addresses:
            raise DiscoveryError("Choose an active LAN network interface.")
        addresses = [interface_ip]
    if len(addresses) > MAX_INTERFACES:
        warnings.append("mDNS discovery is limited to eight active network interfaces.")
    if not addresses:
        return {"devices": [], "warnings": ["No active LAN interface available for mDNS discovery."], "duration": round(time.monotonic() - started, 3)}
    budget = _Budget()
    results = await asyncio.gather(*(_scan_interface(address, timeout, budget) for address in addresses[:MAX_INTERFACES]), return_exceptions=True)
    devices = {}
    for result in results:
        if isinstance(result, OSError):
            if "mDNS discovery is unavailable on one or more network interfaces." not in warnings:
                warnings.append("mDNS discovery is unavailable on one or more network interfaces.")
            continue
        if isinstance(result, BaseException):
            raise result
        for device in result:
            if device["id"] in devices:
                for service in device["services"]:
                    if service not in devices[device["id"]]["services"]:
                        devices[device["id"]]["services"].append(service)
            elif len(devices) < MAX_DEVICES:
                devices[device["id"]] = device
            else:
                budget.truncated = True
    if budget.truncated:
        warnings.append("mDNS discovery reached its response limit; results may be incomplete.")
    return {"devices": sorted(devices.values(), key=lambda device: device["ip"]), "warnings": warnings,
            "duration": round(time.monotonic() - started, 3)}
