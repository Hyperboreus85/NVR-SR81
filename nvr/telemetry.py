"""Small OS-wide Linux samples, respecting the visible container boundary.

No process command lines, environment, credentials, external network calls or
commands are read. A native service's own cgroup is never reported as its OS.
"""
from __future__ import annotations

import copy
from collections import deque
import ipaddress
import math
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import shlex
import socket
import struct
import threading
import time


READ_LIMIT = 131072
UNLIMITED_V1 = 1 << 60


def _read(path: Path, limit: int = READ_LIMIT) -> str | None:
    try:
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
        return raw.decode("utf-8", errors="replace").strip() if len(raw) <= limit else None
    except OSError:
        return None


def _number(path: Path) -> int | None:
    value = _read(path, 128)
    try:
        result = int(value)
        return result if result >= 0 else None
    except (TypeError, ValueError):
        return None


def _pairs(text: str | None) -> dict[str, int]:
    result = {}
    for line in (text or "").splitlines()[:1024]:
        fields = line.split()
        if len(fields) >= 2:
            try:
                value = int(fields[1])
                if value >= 0:
                    result[fields[0].rstrip(":")] = value
            except ValueError:
                pass
    return result


def _percent(used, total):
    return round(min(100.0, max(0.0, used / total * 100)), 1) if used is not None and total is not None and total > 0 else None


def _cpu_count(text: str | None) -> int | None:
    """Count a cpuset without expanding potentially hostile huge ranges."""
    if not text:
        return None
    count, previous = 0, -1
    try:
        pieces = text.split(",")
        if len(pieces) > 4096:
            return None
        for piece in pieces:
            bounds = piece.split("-")
            start, end = int(bounds[0]), int(bounds[-1])
            if len(bounds) > 2 or start < 0 or end < start or start <= previous or end > 1048575:
                return None
            count += end - start + 1
            previous = end
        return count or None
    except ValueError:
        return None


def _cgroup_paths(text: str | None) -> dict[str, str]:
    result = {}
    for line in (text or "").splitlines()[:64]:
        fields = line.split(":", 2)
        if len(fields) != 3 or not fields[2].startswith("/") or ".." in PurePosixPath(fields[2]).parts:
            continue
        for controller in fields[1].split(",") if fields[1] else ["unified"]:
            result[controller] = fields[2]
    return result


def _unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


class SystemTelemetry:
    def __init__(self, recordings_dir, *, root_dir=Path("/"), monotonic=time.monotonic, wall_time=time.time):
        self.recordings_dir, self.root = Path(recordings_dir), Path(root_dir)
        self.proc, self.sys = self.root / "proc", self.root / "sys"
        self._monotonic, self._wall_time = monotonic, wall_time
        self._lock = threading.Lock()
        self._cached = None
        self._sample_time = None
        self._cpu_previous = None
        self._temperature_cache = None
        self._temperature_time = None
        self._temperature_scope = None
        self._virtual_meminfo = False
        self._virtual_uptime = False
        self._started = self._monotonic()
        self._identity_cache = None
        self._identity_time = None
        self._history = deque(maxlen=361)
        self._history_time = None

    def _mounts(self):
        mounts = []
        self._virtual_meminfo = False
        self._virtual_uptime = False
        for line in (_read(self.proc / "self/mountinfo") or "").splitlines()[:1024]:
            before, separator, after = line.partition(" - ")
            fields, tail = before.split(), after.split()
            if not separator or len(fields) < 5 or len(tail) < 3:
                continue
            root, point = _unescape(fields[3]), _unescape(fields[4])
            if point == "/proc/meminfo" and tail[0] == "fuse.lxcfs":
                self._virtual_meminfo = True
            if point == "/proc/uptime" and tail[0] == "fuse.lxcfs":
                self._virtual_uptime = True
            if tail[0] not in {"cgroup", "cgroup2"}:
                continue
            if not root.startswith("/") or not point.startswith("/") or any(".." in PurePosixPath(value).parts for value in (root, point)):
                continue
            mounts.append({"version": 2 if tail[0] == "cgroup2" else 1, "root": root,
                           "point": self.root / point.lstrip("/"), "controllers": set(tail[2].split(","))})
            if len(mounts) > 32:
                mounts.pop()
        return mounts

    def _scope(self, mounts, own):
        marker = _read(self.root / "run/systemd/container", 128)
        if marker or (self.root / ".dockerenv").is_file() or (self.root / "run/.containerenv").is_file():
            return "container"
        if any(mount["root"] != "/" for mount in mounts):
            return "container"
        if any(re.search(r"(?:^|/)(?:lxc|docker|kubepods|libpod)(?:/|[-.])", path) for path in own.values()):
            return "container"
        # These v2 interfaces exist on non-root groups. In a private cgroup
        # namespace their exposed mount root is the whole container OS.
        if any(mount["version"] == 2 and (mount["point"] / "memory.current").is_file()
               and (mount["point"] / "memory.max").is_file() for mount in mounts):
            return "container"
        return "machine" if (self.proc / "stat").is_file() else "unknown"

    def _group(self, controller, mounts, own, init):
        # On hybrid kernels an explicitly mounted v1 controller owns that
        # resource; generic v2 cpu.stat may otherwise describe the host root.
        mount = next((item for item in mounts if item["version"] == 1 and controller in item["controllers"]), None) if own.get(controller) else None
        if mount is None:
            mount = next((item for item in mounts if item["version"] == 2), None) if own.get("unified") else None
        if mount is None:
            return None
        key = "unified" if mount["version"] == 2 else controller
        current, first = own.get(key), init.get(key)
        if not current:
            return None
        if first:
            boundary = PurePosixPath(posixpath.commonpath([current, first]))
        else:
            # Without PID 1 accounting, a known systemd leaf may still reveal
            # the container root; never read only nvr-sr81.service's numbers.
            boundary = PurePosixPath(re.split(r"/(?:system\.slice|user\.slice|init\.scope)(?:/|$)", current, maxsplit=1)[0] or "/")
            if boundary == PurePosixPath(current) and current != "/":
                return None
        if boundary.name in {"init.scope", "system.slice", "user.slice"}:
            boundary = boundary.parent
        mounted_root = PurePosixPath(mount["root"])
        try:
            relative = boundary.relative_to(mounted_root)
        except ValueError:
            # Paths may already be relative to a private cgroup namespace.
            if current.startswith(mount["root"].rstrip("/") + "/"):
                return None
            relative = boundary.relative_to("/")
        group = mount["point"].joinpath(*relative.parts)
        if not group.is_relative_to(mount["point"]):
            return None
        interface = {"memory": "memory.current", "cpu": "cpu.stat", "cpuacct": "cpu.stat", "cpuset": "cpuset.cpus.effective"}[controller]
        if mount["version"] == 2 and not (group / interface).is_file():
            # Hybrid kernels may mount unified systemd groups while CPU/RAM
            # accounting still lives in the v1 controller mounts.
            return self._group(controller, [item for item in mounts if item["version"] == 1], own, init)
        return mount, group

    @staticmethod
    def _ancestors(mount, group):
        for _ in range(32):
            yield group
            if group == mount["point"]:
                return
            group = group.parent

    def _limit(self, selected, filename):
        if not selected:
            return None
        mount, group = selected
        values = []
        for path in self._ancestors(mount, group):
            value = _number(path / filename)
            if value is not None and (mount["version"] == 2 or value < UNLIMITED_V1):
                values.append(value)
        return min(values) if values else None

    def _capacity(self, selected, cpuset):
        if not selected:
            return None
        mount, group = selected
        limits = []
        for path in self._ancestors(mount, group):
            if mount["version"] == 2:
                fields = (_read(path / "cpu.max", 128) or "").split()
                try:
                    if len(fields) == 2 and int(fields[0]) > 0 and int(fields[1]) > 0:
                        limits.append(int(fields[0]) / int(fields[1]))
                except ValueError:
                    pass
            else:
                quota, period = _number(path / "cpu.cfs_quota_us"), _number(path / "cpu.cfs_period_us")
                if quota and period:
                    limits.append(quota / period)
        if cpuset:
            cp_mount, cp_group = cpuset
            for path in self._ancestors(cp_mount, cp_group):
                count = _cpu_count(_read(path / ("cpuset.cpus.effective" if cp_mount["version"] == 2 else "cpuset.effective_cpus"), 65536)
                                   or _read(path / "cpuset.cpus", 65536))
                if count:
                    limits.append(float(count))
        return min(limits) if limits else None

    def _cpu(self, now, scope, mounts, own, init):
        result = {"percent": None, "available_cpus": None, "source": None, "reason": "unavailable", "sample_seconds": None}
        quota = self._group("cpu", mounts, own, init) if scope == "container" else None
        accounting = self._group("cpuacct", mounts, own, init) if scope == "container" else None
        # cpuacct can be mounted alone in v1 while CPU limits live in v2.
        # Its explicit accounting must win over generic unified-root cpu.stat.
        selected = accounting if accounting and accounting[0]["version"] == 1 else quota or accounting
        if scope == "container" and selected:
            mount, group = selected
            source = f"cgroup-v{mount['version']}"
            if mount["version"] == 2:
                raw = _pairs(_read(group / "cpu.stat")).get("usage_usec")
                usage = raw / 1_000_000 if raw is not None else None
            else:
                raw = _number(accounting[1] / "cpuacct.usage") if accounting else None
                usage = raw / 1_000_000_000 if raw is not None else None
            capacity = self._capacity(quota or selected, self._group("cpuset", mounts, own, init))
            counters = (usage,) if usage is not None else None
            identity = (scope, source, str(group), capacity)
        elif scope == "machine":
            text = _read(self.proc / "stat") or ""
            lines = text.splitlines()
            try:
                fields = [int(value) for value in lines[0].split()[1:9]]
                if not lines[0].startswith("cpu ") or len(fields) < 4 or any(value < 0 for value in fields):
                    raise ValueError
                counters = (sum(fields), fields[3] + (fields[4] if len(fields) > 4 else 0))
            except (ValueError, IndexError):
                counters = None
            source, capacity = "proc-stat", float(sum(bool(re.match(r"cpu\d+\s", line)) for line in lines)) or None
            identity = (scope, source, capacity)
        else:
            counters = None; source = None; capacity = None; identity = (scope,)
        result.update(source=source, available_cpus=capacity)
        if counters is None:
            self._cpu_previous = None
            if scope == "unknown":
                result["reason"] = "unsupported"
            return result
        previous = self._cpu_previous
        self._cpu_previous = (now, identity, counters)
        if previous is None or previous[1] != identity:
            result["reason"] = "warming_up"
            return result
        interval = now - previous[0]
        if interval <= 0 or any(current < old for current, old in zip(counters, previous[2])):
            result["reason"] = "counter_reset"
            return result
        if interval > 30:
            result["reason"] = "sample_gap"
            return result
        if scope == "container":
            value = (counters[0] - previous[2][0]) / interval / capacity * 100 if capacity else None
        else:
            total = counters[0] - previous[2][0]
            value = (1 - (counters[1] - previous[2][1]) / total) * 100 if total > 0 else None
        result.update(percent=round(min(100.0, max(0.0, value)), 1) if value is not None else None,
                      reason=None if value is not None else "capacity_unavailable", sample_seconds=round(interval, 3))
        return result

    def _memory(self, scope, mounts, own, init):
        memory = {"used": None, "total": None, "available": None, "percent": None, "working_set": None,
                  "inactive_file": None, "source": None, "reason": "unavailable"}
        swap = {"used": None, "total": None, "percent": None, "source": None, "reason": "unavailable"}
        if scope == "container":
            selected = self._group("memory", mounts, own, init)
            if not selected:
                return memory, swap
            mount, group = selected
            version = mount["version"]
            used = _number(group / ("memory.current" if version == 2 else "memory.usage_in_bytes"))
            total = self._limit(selected, "memory.max" if version == 2 else "memory.limit_in_bytes")
            virtual = _pairs(_read(self.proc / "meminfo")) if self._virtual_meminfo else {}
            virtual_limit = total is None and virtual.get("MemTotal", 0) > 0
            if virtual_limit:
                total = virtual["MemTotal"] * 1024
            stats = _pairs(_read(group / "memory.stat"))
            inactive = stats.get("inactive_file") if version == 2 else stats.get("total_inactive_file", stats.get("inactive_file"))
            memory.update(used=used, total=total, available=max(0, total - used) if used is not None and total is not None else None,
                          percent=_percent(used, total), inactive_file=inactive,
                          working_set=max(0, used - inactive) if used is not None and inactive is not None else None,
                          source=f"cgroup-v{version}:accounted" + ("+lxcfs-limit" if virtual_limit else ""), reason=None if used is not None and total is not None else "limit_unavailable" if used is not None else "unavailable")
            if version == 2:
                swap_used = _number(group / "memory.swap.current")
                swap_total = self._limit(selected, "memory.swap.max")
            else:
                combined = _number(group / "memory.memsw.usage_in_bytes")
                swap_used = max(0, combined - used) if combined is not None and used is not None else None
                # v1 memsw limits RAM+swap together. Subtracting the RAM limit
                # is not an independent hard swap capacity. Only verified
                # container-virtualized meminfo supplies an OS denominator.
                swap_total = None
            virtual_swap = swap_total is None and "SwapTotal" in virtual
            if virtual_swap:
                swap_total = virtual["SwapTotal"] * 1024
            swap.update(used=swap_used, total=swap_total, percent=_percent(swap_used, swap_total), source=f"cgroup-v{version}" + ("+lxcfs-limit" if virtual_swap else ""),
                        reason="not_configured" if swap_total == 0 else None if swap_used is not None and swap_total is not None else "limit_unavailable" if swap_used is not None else "unavailable")
        elif scope == "machine":
            fields = {key: value * 1024 for key, value in _pairs(_read(self.proc / "meminfo")).items()}
            total, available = fields.get("MemTotal"), fields.get("MemAvailable")
            used = max(0, total - available) if total is not None and available is not None else None
            memory.update(used=used, total=total, available=available, percent=_percent(used, total), source="proc-meminfo:available",
                          reason=None if used is not None else "unavailable")
            total, free = fields.get("SwapTotal"), fields.get("SwapFree")
            used = max(0, total - free) if total is not None and free is not None else None
            swap.update(used=used, total=total, percent=_percent(used, total), source="proc-meminfo",
                        reason="not_configured" if total == 0 else None if used is not None else "unavailable")
        return memory, swap

    def _temperature(self, now, scope):
        if (self._temperature_cache is not None and self._temperature_time is not None and self._temperature_scope == scope
                and 0 <= now - self._temperature_time < 10):
            return dict(self._temperature_cache)
        result = {"temperature_celsius": None, "temperature_source": None, "temperature_scope": None, "temperature_reason": "not_exposed"}
        candidates = []
        try:
            directories = self._sensor_paths(self.sys / "class/hwmon", r"hwmon\d+", 16)
            for directory in directories:
                driver = _read(directory / "name", 128)
                if driver not in {"coretemp", "k10temp", "zenpower", "cpu_thermal", "raspberrypi_hwmon"}:
                    continue
                for sensor in self._sensor_paths(directory, r"temp\d+_input", 8):
                    value = self._sensor_temperature(sensor)
                    label = _read(sensor.with_name(sensor.name.replace("_input", "_label")), 128) or "CPU sensor"
                    if not re.fullmatch(r"(?:Package id \d+|Core \d+|Tdie|Tctl|Tccd\d+|CPU sensor)", label):
                        label = "CPU sensor"
                    if value is None:
                        result["temperature_reason"] = "unreadable"
                    else:
                        priority = 0 if "Package" in label or "Tdie" in label else 1
                        candidates.append((priority, value, f"{driver}:{label}"))
            if not candidates:
                for directory in self._sensor_paths(self.sys / "class/thermal", r"thermal_zone\d+", 16):
                    kind = _read(directory / "type", 128)
                    if kind not in {"x86_pkg_temp", "cpu-thermal", "cpu_thermal", "bcm2835_thermal", "soc_thermal"}:
                        continue
                    value = self._sensor_temperature(directory / "temp")
                    if value is None:
                        result["temperature_reason"] = "unreadable"
                    else:
                        candidates.append((0, value, kind))
        except OSError:
            result["temperature_reason"] = "unreadable"
        if candidates:
            priority = min(item[0] for item in candidates)
            chosen = max((item for item in candidates if item[0] == priority), key=lambda item: item[1])
            result.update(temperature_celsius=round(chosen[1], 1), temperature_source=chosen[2],
                          temperature_scope="machine" if scope == "machine" else "host", temperature_reason=None)
        self._temperature_cache, self._temperature_time = result, now
        self._temperature_scope = scope
        return dict(result)

    @staticmethod
    def _sensor_paths(directory, pattern, limit):
        found = []
        try:
            with os.scandir(directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= 128:
                        break
                    if re.fullmatch(pattern, entry.name):
                        found.append(Path(entry.path))
                        if len(found) >= limit:
                            break
        except OSError:
            pass
        return sorted(found)

    @staticmethod
    def _sensor_temperature(path):
        try:
            value = int(_read(path, 128)) / 1000
            return value if -20 <= value <= 130 else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _device(path):
        return path.stat().st_dev

    @staticmethod
    def _disk(path):
        try:
            value = shutil.disk_usage(path)
            return {"used": value.used, "total": value.total, "free": value.free, "percent": _percent(value.used, value.total), "reason": None}
        except OSError:
            return {"used": None, "total": None, "free": None, "percent": None, "reason": "unavailable"}

    @staticmethod
    def _identity_text(value, limit=256):
        if not isinstance(value, str):
            return None
        value = "".join(character for character in value if ord(character) >= 32 and ord(character) != 127).strip()
        return value[:limit] or None

    @staticmethod
    def _architecture():
        try:
            return os.uname().machine
        except (AttributeError, OSError):
            return None

    def _ipv4_addresses(self):
        # A local ioctl reads interface configuration; no DNS, connection,
        # route probe or packet is sent to another device.
        if self.root != Path("/"):
            return []
        addresses = []
        try:
            import fcntl
            names = socket.if_nameindex()[:32]
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as handle:
                for _, name in names:
                    if name == "lo":
                        continue
                    try:
                        request = struct.pack("256s", name.encode("utf-8")[:15])
                        result = fcntl.ioctl(handle.fileno(), 0x8915, request)
                        addresses.append(socket.inet_ntoa(result[20:24]))
                    except OSError:
                        continue
        except (ImportError, AttributeError, OSError):
            pass
        return addresses

    def _addresses(self):
        candidates = list(self._ipv4_addresses())[:32]
        for line in (_read(self.proc / "net/if_inet6", 32768) or "").splitlines()[:128]:
            fields = line.split()
            if len(fields) != 6 or not re.fullmatch(r"[0-9a-fA-F]{32}", fields[0]):
                continue
            try:
                address = ipaddress.IPv6Address(int(fields[0], 16))
                suffix = "%" + fields[5] if address.is_link_local and re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", fields[5]) else ""
                candidates.append(str(address) + suffix)
            except ValueError:
                continue
        result = []
        for value in candidates:
            try:
                address = ipaddress.ip_address(value.split("%", 1)[0])
                if not address.is_loopback and not address.is_unspecified and not address.is_multicast and value not in result:
                    result.append(value)
            except ValueError:
                continue
            if len(result) == 32:
                break
        return result

    def _identity(self, now):
        if self._identity_cache is not None and self._identity_time is not None and 0 <= now - self._identity_time < 30:
            return copy.deepcopy(self._identity_cache)
        hostname = _read(self.proc / "sys/kernel/hostname", 256)
        if not hostname and self.root == Path("/"):
            try:
                hostname = socket.gethostname()
            except OSError:
                pass
        release = {}
        for line in (_read(self.root / "etc/os-release", 16384) or "").splitlines()[:128]:
            key, separator, value = line.partition("=")
            if separator and key in {"PRETTY_NAME", "NAME"}:
                try:
                    tokens = shlex.split(value)
                    if len(tokens) == 1:
                        release[key] = tokens[0]
                except ValueError:
                    pass
        identity = {"hostname": self._identity_text(hostname), "addresses": self._addresses(),
                    "os_name": self._identity_text(release.get("PRETTY_NAME") or release.get("NAME")),
                    "kernel": self._identity_text(_read(self.proc / "sys/kernel/osrelease", 256)),
                    "architecture": self._identity_text(self._architecture(), 64)}
        self._identity_cache, self._identity_time = identity, now
        return copy.deepcopy(identity)

    def _uptime(self, now, scope):
        seconds = None
        if scope == "machine" or self._virtual_uptime:
            fields = (_read(self.proc / "uptime", 256) or "").split()
            try:
                value = float(fields[0])
                if math.isfinite(value) and value >= 0:
                    seconds = value
            except (ValueError, IndexError):
                pass
        return {"system_seconds": seconds, "service_seconds": round(max(0.0, now - self._started), 1)}

    def _history_snapshot(self, now, sampled_at, result):
        if self._history and (sampled_at < self._history[-1]["sampled_at"]
                             or self._history_time is not None and now < self._history_time):
            self._history.clear(); self._history_time = None
        while self._history and sampled_at - self._history[0]["sampled_at"] > 1800:
            self._history.popleft()
        if not self._history or self._history_time is None or now - self._history_time >= 5:
            self._history.append({"sampled_at": sampled_at, "cpu_percent": result["cpu"]["percent"],
                                  "memory_percent": result["memory"]["percent"], "swap_percent": result["swap"]["percent"],
                                  "temperature_celsius": result["cpu"]["temperature_celsius"]})
            self._history_time = now
        return {"window_seconds": 1800, "interval_seconds": 5, "points": [dict(point) for point in self._history]}

    def snapshot(self):
        with self._lock:
            now = self._monotonic()
            sampled_at = self._wall_time()
            reversed_clock = self._cached is not None and (sampled_at < self._cached["sampled_at"] or now < self._sample_time)
            if reversed_clock:
                self._history.clear(); self._history_time = None
            if self._cached is not None and self._sample_time is not None and not reversed_clock and 0 <= now - self._sample_time < 1:
                return copy.deepcopy(self._cached)
            own = _cgroup_paths(_read(self.proc / "self/cgroup"))
            init = _cgroup_paths(_read(self.proc / "1/cgroup"))
            mounts = self._mounts()
            scope = self._scope(mounts, own)
            cpu = self._cpu(now, scope, mounts, own, init)
            cpu.update(self._temperature(now, scope))
            memory, swap = self._memory(scope, mounts, own, init)
            try:
                shared = self._device(self.recordings_dir) == self._device(self.root)
            except OSError:
                shared = None
            result = {"sampled_at": sampled_at, "scope": scope, "cpu": cpu, "memory": memory, "swap": swap,
                      "disk": {"recordings": self._disk(self.recordings_dir), "root": None if shared else self._disk(self.root), "shared_filesystem": shared}}
            result.update(identity=self._identity(now), uptime=self._uptime(now, scope))
            result["history"] = self._history_snapshot(now, sampled_at, result)
            self._cached, self._sample_time = result, now
            return copy.deepcopy(result)
