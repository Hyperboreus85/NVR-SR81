"""Explicit bounded ONVIF and RTSP service checks; never guess stream paths."""
from __future__ import annotations

import asyncio
import contextlib
import copy
from dataclasses import dataclass
import hashlib
import ipaddress
import math
import re
import socket
import ssl
import time

import httpx

from .discovery import DiscoveryError, LAN_NETWORKS, _merge_device, _verify_endpoint
from .security import validate_camera_host


METHODS = ("onvif", "rtsp", "rtsps")
DEFAULT_PORTS = {"onvif": [80, 8000, 8080, 8899], "rtsp": [554, 8554], "rtsps": [322]}
MAX_ADDRESSES, MAX_PROBES, MAX_HEADERS = 512, 4096, 16 * 1024
RANGE_NETWORKS = (*LAN_NETWORKS, ipaddress.ip_network("100.64.0.0/10"))
METADATA_ADDRESS = ipaddress.ip_address("169.254.169.254")


class NetworkScanError(DiscoveryError):
    """A fixed, safe validation message without network response contents."""


class _TLSUnverified(RuntimeError):
    pass


@dataclass(frozen=True)
class _Target:
    ip: str
    hostname: str | None = None

    @property
    def host(self):
        return self.hostname or self.ip


def _safe_address(value):
    try:
        if "%" in str(value):
            raise ValueError
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        if (address.is_loopback or address.is_unspecified or address.is_multicast or address.is_reserved
                or address == METADATA_ADDRESS):
            raise ValueError
        return str(address)
    except (ValueError, TypeError):
        raise NetworkScanError("Scan targets must not include loopback, unspecified, multicast, reserved or metadata addresses.") from None


def normalize_target(value: str) -> str:
    """Validate/canonicalize one saved target without DNS or any network I/O."""
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise NetworkScanError("Enter an IP address, hostname or allowed IPv4 subnet.")
    value = value.strip()
    if "%" in value:
        raise NetworkScanError("Use a reachable IPv6 address without a scope identifier.")
    if "/" in value:
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError:
            raise NetworkScanError("Enter an IP address, hostname or allowed IPv4 subnet.") from None
        if network.num_addresses == 1:
            return _safe_address(str(network.network_address))
        if (network.version != 4 or network.prefixlen < 24
                or not any(network.subnet_of(allowed) for allowed in RANGE_NETWORKS)
                or METADATA_ADDRESS in network):
            raise NetworkScanError("Use a private, link-local or CGNAT IPv4 subnet of /24 or smaller; public and IPv6 targets must be individual hosts.")
        _safe_address(str(network.network_address))
        return str(network)
    try:
        host = validate_camera_host(value)
    except ValueError:
        raise NetworkScanError("Enter an IP address, hostname or allowed IPv4 subnet.") from None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    return _safe_address(host)


async def _resolve_hostname(hostname):
    loop = asyncio.get_running_loop()
    answers = await asyncio.wait_for(loop.getaddrinfo(hostname, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM), 1)
    if len(answers) > 64:
        raise NetworkScanError("A hostname returned too many addresses. Use specific IP addresses instead.")
    addresses = []
    for family, _, _, _, address in answers:
        if family not in {socket.AF_INET, socket.AF_INET6}:
            continue
        normalized = _safe_address(address[0])
        if normalized not in addresses:
            addresses.append(normalized)
        if len(addresses) > 8:
            raise NetworkScanError("A hostname returned too many addresses. Use specific IP addresses instead.")
    if not addresses:
        raise OSError
    return addresses


async def _expand_targets(targets):
    resolved, warnings, partial = [], [], False
    names = []
    for target in targets:
        if "/" in target:
            resolved.extend(_Target(str(address)) for address in ipaddress.ip_network(target).hosts())
        else:
            try:
                ipaddress.ip_address(target)
                resolved.append(_Target(target))
            except ValueError:
                names.append(target)
    if len({target.ip for target in resolved}) > MAX_ADDRESSES:
        raise NetworkScanError("The scan is limited to 512 distinct addresses.")
    # Resolve all authorities once before opening any service connections.
    results = await asyncio.gather(*(_resolve_hostname(name) for name in names), return_exceptions=True)
    for name, result in zip(names, results):
        if isinstance(result, NetworkScanError):
            raise result
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            partial = True
            warnings.append("Some target hostnames could not be resolved. Check their names and DNS settings.")
        else:
            if not isinstance(result, list) or len(result) > 8:
                raise NetworkScanError("A hostname returned too many addresses. Use specific IP addresses instead.")
            # Revalidate injected/resolver results as well as the resolver's own
            # answers. A mixed safe/unsafe DNS response rejects the scan.
            resolved.extend(_Target(_safe_address(address), name) for address in result)
    unique = list(dict.fromkeys(resolved))
    if len({target.ip for target in unique}) > MAX_ADDRESSES:
        raise NetworkScanError("The scan is limited to 512 distinct addresses.")
    return unique, list(dict.fromkeys(warnings)), partial


def _ports(value, method):
    value = DEFAULT_PORTS[method] if value is None else value
    if (not isinstance(value, list) or not value or len(value) > 64
            or any(type(port) is not int or not 1 <= port <= 65535 for port in value)):
        raise NetworkScanError("Choose 1 to 8 valid ports for each selected protocol.")
    unique = list(dict.fromkeys(value))
    if len(unique) > 8:
        raise NetworkScanError("Choose 1 to 8 valid ports for each selected protocol.")
    return unique


def _uri(protocol, host, port):
    authority = f"[{host}]" if ":" in host else host
    return f"{protocol}://{authority}:{port}/"


def _rtsp_status(data, cseq=1):
    if len(data) > MAX_HEADERS or not data.endswith(b"\r\n\r\n"):
        return None
    lines = data[:-4].split(b"\r\n")
    if not lines or len(lines) > 128 or len(lines[0]) > 512:
        return None
    match = re.fullmatch(rb"RTSP/(1\.0|2\.0) ([1-5][0-9]{2}) [\x09\x20-\x7e\x80-\xff]*", lines[0])
    if match is None:
        return None
    sequences = []
    for line in lines[1:]:
        name, separator, value = line.partition(b":")
        if (not separator or not re.fullmatch(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)
                or any(character < 32 and character != 9 or character == 127 for character in value)):
            return None
        if name.lower() == b"cseq":
            sequences.append(value.strip())
    if sequences and (len(sequences) != 1 or not re.fullmatch(rb"[0-9]{1,10}", sequences[0]) or int(sequences[0]) != cseq):
        return None
    return match[1].decode("ascii"), int(match[2])


async def _close_writer(writer):
    if writer is not None:
        writer.close()
        try:
            await asyncio.wait_for(writer.wait_closed(), .2)
        except asyncio.CancelledError:
            transport = getattr(writer, "transport", None)
            if transport is not None:
                transport.abort()
            raise
        except (OSError, asyncio.TimeoutError, ssl.SSLError):
            transport = getattr(writer, "transport", None)
            if transport is not None:
                transport.abort()


async def _probe_rtsp(target, port, method, timeout, tls_context=None):
    context = tls_context if method == "rtsps" else None
    if method == "rtsps":
        context = context or ssl.create_default_context()
        if context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname:
            raise NetworkScanError("Secure scans require certificate verification.")
    try:
        async with asyncio.timeout(timeout):
            for version in ("1.0", "2.0"):
                writer = None
                try:
                    options = {"ssl": context, "limit": MAX_HEADERS}
                    if context is not None:
                        options["server_hostname"] = target.host
                    reader, writer = await asyncio.open_connection(target.ip, port, **options)
                    url = _uri(method, target.host, port)
                    writer.write(f"OPTIONS {url} RTSP/{version}\r\nCSeq: 1\r\nUser-Agent: SR81\r\n\r\n".encode("ascii"))
                    await writer.drain()
                    status = _rtsp_status(await reader.readuntil(b"\r\n\r\n"))
                    if status is None:
                        return None
                    if status[1] == 505 and version == "1.0":
                        continue
                    return {"protocol": method, "host": target.host, "port": port, "url": url,
                            "status": "authentication_required" if status[1] in {401, 403} else "verified",
                            "stream_path_known": False, "response_code": status[1], "rtsp_version": status[0]}
                finally:
                    await _close_writer(writer)
    except ssl.SSLError:
        raise _TLSUnverified from None
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError):
        return None
    return None


def _add_result(devices, target, service, found=None):
    key = (target.ip, target.hostname)
    if key not in devices:
        identity = hashlib.sha256((target.ip + "|" + (target.hostname or "")).encode("ascii")).hexdigest()[:24]
        devices[key] = {"id": "service:" + identity, "ip": target.ip, "endpoint": "", "xaddrs": [], "name": "",
                        "hardware": "", "location": "", "scopes": [], "services": [], "methods": []}
    device = devices[key]
    if found is not None:
        incoming = {**found, "id": device["id"]}
        _merge_device([device], incoming)
    identity = (service["protocol"], service["host"], service["port"], service["url"])
    if all((item["protocol"], item["host"], item["port"], item["url"]) != identity for item in device["services"]):
        device["services"].append(service)
    device["services"].sort(key=lambda item: (METHODS.index(item["protocol"]), item["host"], item["port"], item["url"]))
    device["methods"] = [method for method in METHODS if any(item["protocol"] == method for item in device["services"])]
    onvif = [item["url"] for item in device["services"] if item["protocol"] == "onvif"]
    device["endpoint"] = onvif[0] if onvif else ""
    device["xaddrs"] = onvif


async def scan_targets(targets, methods, onvif_ports=None, rtsp_ports=None, rtsps_ports=None, *, timeout=.75, deadline=75, progress=None):
    if not isinstance(targets, list) or not 1 <= len(targets) <= 16:
        raise NetworkScanError("Enter 1 to 16 scan targets.")
    normalized = list(dict.fromkeys(normalize_target(target) for target in targets))
    if (not isinstance(methods, list) or not methods or len(methods) > 3
            or any(method not in METHODS for method in methods)):
        raise NetworkScanError("Choose ONVIF, RTSP or RTSPS scan methods.")
    methods = list(dict.fromkeys(methods))
    if (type(timeout) not in (int, float) or not math.isfinite(timeout) or not .1 <= timeout <= 2
            or type(deadline) not in (int, float) or not math.isfinite(deadline) or not .01 <= deadline <= 75):
        raise NetworkScanError("Use an endpoint timeout between 0.1 and 2 seconds and a scan deadline no longer than 75 seconds.")
    configured = {"onvif": onvif_ports, "rtsp": rtsp_ports, "rtsps": rtsps_ports}
    ports = {method: _ports(configured[method], method) for method in methods}
    started, completed, total, partial, last_progress = time.monotonic(), 0, 0, False, float("-inf")
    devices, warnings = {}, []
    callback = progress

    def ordered():
        return sorted(devices.values(), key=lambda device: (device["ip"], device["endpoint"], device["id"]))

    def report():
        nonlocal callback, last_progress
        now = time.monotonic()
        if callback is not None and now - last_progress >= .5:
            last_progress = now
            try:
                callback({"completed": completed, "total": total, "devices": copy.deepcopy(ordered()),
                          "warnings": list(dict.fromkeys(warnings)), "state": "running"})
            except Exception:
                warnings.append("Progress updates are unavailable.")
                callback = None

    tasks = []
    try:
        async with asyncio.timeout(deadline):
            hosts, notices, partial = await _expand_targets(normalized)
            warnings.extend(notices)
            total = len(hosts) * sum(len(value) for value in ports.values())
            if total > MAX_PROBES:
                raise NetworkScanError("The scan is limited to 4096 service checks. Reduce targets or ports.")
            report()
            tls_context = await asyncio.to_thread(ssl.create_default_context) if "rtsps" in methods and hosts else None
            queue = asyncio.Queue()
            for target in hosts:
                for method in methods:
                    for port in ports[method]:
                        queue.put_nowait((target, method, port))
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, verify=True, timeout=timeout,
                                         limits=httpx.Limits(max_connections=32, max_keepalive_connections=0)) as client:
                async def worker():
                    nonlocal completed
                    while True:
                        try:
                            target, method, port = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        try:
                            if method == "onvif":
                                found = await _verify_endpoint(client, target.ip, port, timeout, server_hostname=target.hostname)
                                if found:
                                    _add_result(devices, target, {"protocol": method, "host": target.host, "port": port,
                                                "url": found["endpoint"], "status": "verified"}, found)
                            else:
                                service = await _probe_rtsp(target, port, method, timeout, tls_context)
                                if service:
                                    _add_result(devices, target, service)
                        except _TLSUnverified:
                            warnings.append("Some secure services could not be verified. Check their TLS certificates.")
                        except (httpx.HTTPError, OSError, ValueError, RuntimeError):
                            pass
                        completed += 1
                        report()
                tasks = [asyncio.create_task(worker(), name="directed-service-scan") for _ in range(min(32, queue.qsize()))]
                try:
                    await asyncio.gather(*tasks)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
    except asyncio.TimeoutError:
        partial = True
        warnings.append("Scan time limit reached. Showing partial results.")
    if not devices:
        warnings.append("No services verified. Check the targets, ports, firewall and selected protocols.")
    return {"devices": ordered(), "warnings": list(dict.fromkeys(warnings)), "duration": round(time.monotonic() - started, 3),
            "completed": completed, "total": total, "partial": partial or completed < total}
