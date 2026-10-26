"""DNS-SD packets and socket boundaries are all synthetic; no LAN is scanned."""
import asyncio
import ipaddress
import random
import struct

import pytest

from nvr import mdns_discovery as module
from nvr.discovery import DiscoveryError


RTSP = (b"_rtsp", b"_tcp", b"local")
RTSPS = (b"_rtsps", b"_tcp", b"local")
INSTANCE = (b"Front Camera",) + RTSP
HOST = (b"camera", b"local")


def name(labels): return module._encoded_name(labels)
def rr(owner, kind, data, *, ttl=120, record_class=0x8001):
    return name(owner) + struct.pack("!HHIH", kind, record_class, ttl, len(data)) + data
def response(*records, identity=7, flags=0x8400):
    return struct.pack("!6H", identity, flags, 0, len(records), 0, 0) + b"".join(records)
def records(*, service=RTSP, instance=None, address="192.168.1.20", port=8554):
    instance = instance or ((b"Front Camera",) + service)
    ip = ipaddress.ip_address(address)
    return [rr(service, 12, name(instance)), rr(instance, 33, struct.pack("!3H", 0, 0, port) + name(HOST)),
            rr(HOST, 1 if ip.version == 4 else 28, ip.packed)]
def devices(packet):
    cache = module.RecordCache(); cache.feed(module.parse_packet(packet, {7})); return cache.devices()
def questions(packet):
    count = struct.unpack_from("!H", packet, 4)[0]
    offset, result = 12, []
    for _ in range(count):
        labels, offset = module.read_name(packet, offset)
        kind, cls = struct.unpack_from("!HH", packet, offset); offset += 4
        assert cls == 1
        result.append((labels, kind))
    assert offset == len(packet)
    return result


def test_only_explicit_rtsp_ptr_srv_and_addresses_produce_advertised_not_verified_services():
    result = devices(response(*records()))
    assert len(result) == 1
    device = result[0]
    assert device["name"] == "Front Camera" and device["ip"] == "192.168.1.20"
    assert device["endpoint"] == "" and device["xaddrs"] == [] and device["methods"] == ["mdns"]
    assert device["hardware"] == device["location"] == "" and device["scopes"] == []
    assert device["services"] == [{"protocol": "rtsp", "host": "192.168.1.20", "port": 8554,
        "url": "rtsp://192.168.1.20:8554/", "status": "advertised", "stream_path_known": False}]


def test_split_out_of_order_records_and_multiple_protocols_join_without_txt_credentials_or_paths():
    cache = module.RecordCache()
    base = records()
    for item in reversed(base): cache.feed(module.parse_packet(response(item), {7}))
    for item in records(service=RTSPS, port=322): cache.feed(module.parse_packet(response(item), {7}))
    cache.feed(module.parse_packet(response(rr(INSTANCE, 16, b"\x19password=private-password\x12path=/private/path")), {7}))
    result = cache.devices()
    assert len(result) == 1 and {service["protocol"] for service in result[0]["services"]} == {"rtsp", "rtsps"}
    assert "private-password" not in str(result) and "private/path" not in str(result)


def test_http_printers_stray_srv_false_ptr_suffix_and_ipv4_addresses_are_not_camera_evidence():
    http = (b"_http", b"_tcp", b"local")
    assert devices(response(*records(service=http))) == []
    assert devices(response(*records()[1:])) == []
    assert devices(response(rr(RTSP, 12, name((b"printer",) + http)), *records()[1:])) == []
    assert devices(response(rr(RTSP, 12, name((b"one", b"two") + RTSP)), *records()[1:])) == []


@pytest.mark.parametrize("address", ["8.8.8.8", "203.0.113.20", "127.0.0.1", "0.0.0.0", "224.0.0.251", "::", "::1", "ff02::fb", "fe80::1"])
def test_unusable_remote_or_unscoped_addresses_are_not_offered_as_urls(address):
    assert devices(response(*records(address=address))) == []


@pytest.mark.parametrize("address", ["10.2.3.4", "172.16.10.20", "169.254.5.6", "fd00::20", "2001:4860::20"])
def test_announced_lan_ipv4_and_usable_ipv6_are_preserved_without_dns_resolution(address):
    service = devices(response(*records(address=address)))[0]["services"][0]
    assert service["host"] == address
    assert service["url"] == f"rtsp://{'[' + address + ']' if ':' in address else address}:8554/"


@pytest.mark.parametrize("index", [0, 1, 2])
def test_zero_ttl_goodbyes_are_not_used_to_construct_a_new_service(index):
    ordinary = records()
    owner = [RTSP, INSTANCE, HOST][index]
    data = [name(INSTANCE), struct.pack("!3H", 0, 0, 8554) + name(HOST), ipaddress.ip_address("192.168.1.20").packed][index]
    ordinary[index] = rr(owner, [12, 33, 1][index], data, ttl=0)
    assert devices(response(*ordinary)) == []


@pytest.mark.parametrize("identity,flags", [(8, 0x8400), (0, 0x8400), (7, 0), (7, 0x8C00), (7, 0x8403), (7, 0x8600)])
def test_query_id_response_flags_opcode_rcode_and_truncation_are_checked(identity, flags):
    assert module.parse_packet(response(*records(), identity=identity, flags=flags), {7}) == []


def test_compressed_questions_ptr_srv_and_addresses_resolve_without_losing_instance_label_boundaries():
    question = name(RTSP) + struct.pack("!HH", 12, 1)
    packet = bytearray(struct.pack("!6H", 7, 0x8400, 1, 3, 0, 0) + question)
    pointer = lambda offset: struct.pack("!H", 0xC000 | offset)
    instance_at = len(packet) + 12
    instance = b"\x0cFront.Camera" + pointer(12)
    packet.extend(pointer(12) + struct.pack("!HHIH", 12, 1, 120, len(instance)) + instance)
    target_at = len(packet) + 12 + 6
    target = b"\x06camera" + pointer(23)
    packet.extend(pointer(instance_at) + struct.pack("!HHIH", 33, 1, 120, 6 + len(target)) + struct.pack("!3H", 0, 0, 554) + target)
    packet.extend(pointer(target_at) + struct.pack("!HHIH", 1, 1, 120, 4) + ipaddress.ip_address("192.168.1.20").packed)
    result = devices(bytes(packet))
    assert len(result) == 1 and result[0]["name"] == "Front.Camera"


def test_every_truncated_packet_invalid_pointer_cycle_and_overlong_name_is_rejected():
    packet = response(*records())
    assert all(module.parse_packet(packet[:end], {7}) == [] for end in range(len(packet)))
    for packet in [b"\xc0\x00", b"\xc0\xff", b"\x40" + b"a" * 64 + b"\0", (b"\x3f" + b"a" * 63) * 4 + b"\0"]:
        with pytest.raises(ValueError): module.read_name(packet, 0)
    chain = b"".join(struct.pack("!H", 0xC000 | (index + 1) * 2) for index in range(9)) + b"\0"
    with pytest.raises(ValueError): module.read_name(chain, 0)
    assert module.parse_packet(struct.pack("!6H", 7, 0x8400, 0, 513, 0, 0), {7}) == []
    assert module.parse_packet(b"\0" * 65536, {7}) == []


def test_parser_fuzz_is_bounded_and_never_raises_on_untrusted_packet_data():
    generator = random.Random(81)
    for _ in range(500):
        packet = struct.pack("!6H", 7, 0x8400, 0, generator.randrange(20), 0, 0) + generator.randbytes(generator.randrange(1024))
        assert len(module.parse_packet(packet, {7})) <= module.MAX_RECORDS


def test_record_and_device_limits_apply_before_materializing_unbounded_results():
    cache = module.RecordCache()
    cache.feed([((f"host{index}".encode(), b"local"), 1, "192.168.1.20") for index in range(1000)])
    assert len(cache.records) == module.MAX_RECORDS and cache.truncated
    cache = module.RecordCache()
    cache.feed(module.parse_packet(response(*records()[:2]), {7}))
    cache.feed([(HOST, 1, f"192.168.1.{index}") for index in range(1, 180)])
    assert len(cache.devices()) == module.MAX_DEVICES and cache.truncated


def test_followup_questions_ask_only_srv_and_announced_local_addresses_never_txt_or_unicast_dns():
    cache = module.RecordCache()
    assert cache.questions() == [(RTSP, 12), (RTSPS, 12)]
    cache.feed(module.parse_packet(response(*records()[:1]), {7}))
    assert (INSTANCE, 33) in cache.questions()
    cache.feed(module.parse_packet(response(*records()[1:2]), {7}))
    assert (HOST, 1) in cache.questions() and (HOST, 28) in cache.questions()
    packet = module.build_query(7, cache.questions())
    assert questions(packet) == cache.questions()
    assert struct.unpack_from("!H", packet)[0] == 7 and all(kind != 16 for _, kind in questions(packet))


class FakeSocket:
    def __init__(self): self.closed = False; self.bound = None; self.options = []
    def setsockopt(self, *args): self.options.append(args)
    def bind(self, value): self.bound = value
    def setblocking(self, value): assert value is False
    def close(self): self.closed = True


@pytest.mark.asyncio
async def test_legacy_queries_resolve_three_stages_on_an_ephemeral_socket_and_always_close(monkeypatch):
    sock, sent, clock = FakeSocket(), [], [0.0]
    incoming = iter([records()[0], None, records()[1], None, records()[2], None])
    monkeypatch.setattr(module.socket, "socket", lambda *args: sock)
    monkeypatch.setattr(module.secrets, "randbelow", lambda maximum: 6)
    async def send(current, packet): sent.append(packet)
    async def receive(current):
        item = next(incoming)
        if item is None:
            clock[0] = int(clock[0]) + 1
            raise asyncio.TimeoutError
        clock[0] += .1
        return response(item), ("192.168.1.20", 5353)
    monkeypatch.setattr(module, "_send_packet", send)
    monkeypatch.setattr(module, "_receive_packet", receive)
    found = await module._scan_interface("192.168.1.2", 3, module._Budget(), clock=lambda: clock[0])
    assert len(found) == 1 and len(sent) == 3 and sock.bound == ("192.168.1.2", 0) and sock.closed
    assert (INSTANCE, 33) in questions(sent[1]) and (HOST, 1) in questions(sent[2])


@pytest.mark.asyncio
@pytest.mark.parametrize("source", [("192.168.1.20", 9999), ("8.8.8.8", 5353), ("127.0.0.1", 5353)])
async def test_responses_from_wrong_source_ports_or_non_lan_senders_are_ignored(monkeypatch, source):
    sock, clock = FakeSocket(), [0]
    monkeypatch.setattr(module.socket, "socket", lambda *args: sock)
    monkeypatch.setattr(module.secrets, "randbelow", lambda maximum: 6)
    async def send(*args): pass
    async def receive(*args):
        clock[0] += 1
        return response(*records()), source
    monkeypatch.setattr(module, "_send_packet", send); monkeypatch.setattr(module, "_receive_packet", receive)
    assert await module._scan_interface("192.168.1.2", 3, module._Budget(), clock=lambda: clock[0]) == []
    assert sock.closed


@pytest.mark.asyncio
async def test_socket_closes_immediately_when_discovery_is_cancelled(monkeypatch):
    sock, entered = FakeSocket(), asyncio.Event()
    monkeypatch.setattr(module.socket, "socket", lambda *args: sock)
    async def send(*args): pass
    async def receive(*args): entered.set(); await asyncio.Event().wait()
    monkeypatch.setattr(module, "_send_packet", send); monkeypatch.setattr(module, "_receive_packet", receive)
    task = asyncio.create_task(module._scan_interface("192.168.1.2", 3, module._Budget()))
    await entered.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert sock.closed


@pytest.mark.asyncio
async def test_parallel_interfaces_share_one_packet_budget_and_close_every_socket(monkeypatch):
    sockets, received, parsed = [], [], []
    def socket_factory(*args):
        sock = FakeSocket(); sockets.append(sock); return sock
    monkeypatch.setattr(module.socket, "socket", socket_factory)
    monkeypatch.setattr(module.secrets, "randbelow", lambda maximum: 6)
    async def send(*args): pass
    async def receive(sock):
        # Let both interface scans have an outstanding receive at the cap.
        await asyncio.sleep(0)
        received.append(sock.bound[0])
        return response(*records()), ("192.168.1.20", 5353)
    original_parse = module.parse_packet
    def parse(packet, identities):
        parsed.append(packet)
        return original_parse(packet, identities)
    monkeypatch.setattr(module, "_send_packet", send)
    monkeypatch.setattr(module, "_receive_packet", receive)
    monkeypatch.setattr(module, "parse_packet", parse)
    budget = module._Budget()
    results = await asyncio.wait_for(asyncio.gather(*(
        module._scan_interface(address, 3, budget, clock=lambda: 0)
        for address in ("192.168.1.2", "192.168.2.2"))), 5)
    assert budget.packets == len(parsed) == module.MAX_PACKETS and budget.truncated
    assert set(received) == {"192.168.1.2", "192.168.2.2"}
    assert len(received) <= module.MAX_PACKETS + len(sockets)
    assert all(sock.closed for sock in sockets) and all(results)


@pytest.mark.asyncio
async def test_no_active_lan_interface_returns_a_safe_warning_without_creating_sockets(monkeypatch):
    monkeypatch.setattr(module, "list_interfaces", lambda: [
        {"address": "127.0.0.1"}, {"address": "8.8.8.8"}, {"address": "fe80::1"}])
    def forbidden_socket(*args): raise AssertionError("Discovery must not create a socket")
    monkeypatch.setattr(module.socket, "socket", forbidden_socket)
    result = await module.discover_mdns(timeout=3)
    assert result["devices"] == []
    assert result["warnings"] == ["No active LAN interface available for mDNS discovery."]
    assert result["duration"] >= 0


@pytest.mark.asyncio
async def test_interface_selection_limits_and_errors_are_safe_without_opening_real_sockets(monkeypatch):
    monkeypatch.setattr(module, "list_interfaces", lambda: [{"address": f"192.168.{index}.2"} for index in range(12)])
    selected = []
    async def scan(address, timeout, budget): selected.append(address); return []
    monkeypatch.setattr(module, "_scan_interface", scan)
    result = await module.discover_mdns(timeout=3)
    assert len(selected) == 8 and result["devices"] == [] and any("eight" in warning for warning in result["warnings"])
    selected.clear(); await module.discover_mdns("192.168.2.2", 3); assert selected == ["192.168.2.2"]
    with pytest.raises(DiscoveryError): await module.discover_mdns("8.8.8.8", 3)
    for timeout in [True, 2, 7, float("nan"), "4"]:
        with pytest.raises(DiscoveryError): await module.discover_mdns(timeout=timeout)
    monkeypatch.setattr(module, "list_interfaces", lambda: (_ for _ in ()).throw(OSError("private interface details")))
    result = await module.discover_mdns(timeout=3)
    assert result["devices"] == [] and "private" not in str(result["warnings"])
