"""Synthetic Linux OS/cgroup files: no host credentials or live metrics required."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from nvr import telemetry
from nvr.telemetry import SystemTelemetry, _cpu_count


MIB = 1024**2


class Clock:
    value = 100.0

    def now(self):
        return self.value

    def wall(self):
        return 1700000000 + self.value


def write(root, path, content):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(str(content), encoding="utf-8")
    return target


def environment(tmp_path, monkeypatch, container=False):
    root = tmp_path / "linux"
    root.mkdir()
    recordings = root / "recordings"; recordings.mkdir()
    write(root, "proc/stat", "cpu 100 0 100 700 100 0 0 0 50 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n")
    write(root, "proc/meminfo", "MemTotal: 1000000 kB\nMemAvailable: 250000 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n")
    if container:
        write(root, "run/systemd/container", "lxc")
    clock = Clock()
    collector = SystemTelemetry(recordings, root_dir=root, monotonic=clock.now, wall_time=clock.wall)
    monkeypatch.setattr(telemetry.shutil, "disk_usage", lambda path: SimpleNamespace(total=1000, used=600, free=400))
    return root, clock, collector


def cgroup2(root, prefix="", mounted_root="/"):
    write(root, "proc/self/mountinfo", f"30 20 0:26 {mounted_root} /sys/fs/cgroup rw - cgroup2 cgroup rw\n")
    write(root, "proc/self/cgroup", f"0::{prefix}/system.slice/nvr-sr81.service\n")
    write(root, "proc/1/cgroup", f"0::{prefix}/init.scope\n")
    relative = prefix[len(mounted_root.rstrip("/")):].strip("/") if prefix.startswith(mounted_root.rstrip("/")) else prefix.strip("/")
    group = root / "sys/fs/cgroup" / relative
    group.mkdir(parents=True, exist_ok=True)
    write(group, "cpu.stat", "usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\n")
    write(group, "cpu.max", "200000 100000")
    write(group, "cpuset.cpus.effective", "0-3")
    write(group, "memory.current", 512 * MIB)
    write(group, "memory.max", 1024 * MIB)
    write(group, "memory.stat", f"inactive_file {128 * MIB}\nfile {256 * MIB}\n")
    write(group, "memory.swap.current", 64 * MIB)
    write(group, "memory.swap.max", 256 * MIB)
    return group


def test_machine_cpu_delta_excludes_double_counted_guest_ticks_and_uses_os_memavailable(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    first = collector.snapshot()
    assert first["scope"] == "machine" and first["cpu"]["percent"] is None
    assert first["cpu"]["reason"] == "warming_up"
    clock.value += 1
    write(root, "proc/stat", "cpu 120 0 120 760 100 0 0 0 70 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n")
    result = collector.snapshot()
    assert result["cpu"]["percent"] == 40 and result["cpu"]["available_cpus"] == 2
    assert result["memory"]["used"] == 750000 * 1024 and result["memory"]["percent"] == 75
    assert result["memory"]["source"] == "proc-meminfo:available"
    assert result["swap"]["used"] == 512 * 1024 and result["swap"]["percent"] == 50
    assert result["disk"]["recordings"]["percent"] == 60
    assert result["disk"]["shared_filesystem"] is True and result["disk"]["root"] is None


def test_cgroup2_reports_whole_container_not_nvr_service_or_host(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    write(group, "system.slice/nvr-sr81.service/cpu.stat", "usage_usec 999999999")
    write(group, "system.slice/nvr-sr81.service/memory.current", 7)
    write(group, "system.slice/nvr-sr81.service/cpu.max", "10000 100000")
    first = collector.snapshot()
    assert first["cpu"]["available_cpus"] == 2
    clock.value += 1
    write(group, "cpu.stat", "usage_usec 2000000")
    result = collector.snapshot()
    assert result["scope"] == "container" and result["cpu"]["percent"] == 50
    assert result["memory"]["used"] == 512 * MIB
    assert result["memory"]["working_set"] == 384 * MIB
    assert result["memory"]["percent"] == 50
    assert result["swap"]["used"] == 64 * MIB and result["swap"]["percent"] == 25
    assert result["memory"]["source"] == "cgroup-v2:accounted"


def test_background_cpu_samples_remain_valid_at_thirty_seconds_with_jitter(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    assert collector.snapshot()["cpu"]["percent"] is None
    clock.value += 30.1
    write(group, "cpu.stat", "usage_usec 31100000")
    result = collector.snapshot()
    assert result["cpu"]["percent"] == 50
    assert result["cpu"]["sample_seconds"] == 30.1 and result["cpu"]["reason"] is None
    clock.value += 91
    write(group, "cpu.stat", "usage_usec 122100000")
    result = collector.snapshot()
    assert result["cpu"]["percent"] is None and result["cpu"]["reason"] == "sample_gap"


def test_visible_ancestor_limits_and_cpuset_apply_without_using_ancestor_usage(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root, "/lxc/181")
    write(group, "cpu.max", "max 100000")
    write(group, "cpuset.cpus.effective", "0-7")
    write(group, "memory.max", "max")
    write(group.parent, "cpu.max", "150000 100000")
    write(group.parent, "cpu.stat", "usage_usec 999999999999")
    write(group.parent, "memory.max", 2 * 1024 * MIB)
    write(group.parent, "memory.current", 999999999999)
    collector.snapshot(); clock.value += 1
    write(group, "cpu.stat", "usage_usec 1750000")
    result = collector.snapshot()
    assert result["cpu"]["available_cpus"] == 1.5 and result["cpu"]["percent"] == 50
    assert result["memory"]["used"] == 512 * MIB and result["memory"]["total"] == 2048 * MIB


def test_cgroup_mount_subtree_root_is_mapped_correctly(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    cgroup2(root, "/lxc/181", mounted_root="/lxc/181")
    result = collector.snapshot()
    assert result["memory"]["total"] == 1024 * MIB and result["memory"]["used"] == 512 * MIB


def test_container_never_falls_back_to_unverified_proxmox_memory_or_cpu(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    result = collector.snapshot()
    assert result["scope"] == "container"
    assert result["cpu"]["percent"] is None
    assert result["memory"]["used"] is None and result["memory"]["total"] is None
    assert result["swap"]["total"] is None
    assert (root / "proc/meminfo").is_file()  # host-looking numbers were deliberately ignored


def test_unlimited_cgroup2_totals_stay_unknown_without_proven_virtual_meminfo(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    write(group, "memory.max", "max"); write(group, "memory.swap.max", "max")
    result = collector.snapshot()
    assert result["memory"]["used"] == 512 * MIB and result["memory"]["total"] is None
    assert result["memory"]["percent"] is None and result["swap"]["total"] is None


def test_verified_lxcfs_limits_support_real_lxc_root_max_without_host_usage_fallback(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    write(group, "memory.current", 3672281088)
    write(group, "memory.max", "max"); write(group, "memory.swap.max", "max")
    write(root, "proc/meminfo", "MemTotal: 4194304 kB\nMemAvailable: 4098334 kB\nSwapTotal: 524288 kB\nSwapFree: 490156 kB\n")
    path = root / "proc/self/mountinfo"
    path.write_text(path.read_text() + "31 20 0:28 /proc/meminfo /proc/meminfo rw - fuse.lxcfs lxcfs rw\n")
    result = collector.snapshot()
    assert result["memory"]["used"] == 3672281088 and result["memory"]["total"] == 4 * 1024**3
    assert result["memory"]["source"] == "cgroup-v2:accounted+lxcfs-limit"
    assert result["swap"]["used"] == 64 * MIB and result["swap"]["total"] == 512 * MIB
    assert result["swap"]["source"] == "cgroup-v2+lxcfs-limit"


def cgroup1(root):
    mounts, own, init = [], [], []
    for index, (name, controllers) in enumerate([("cpu", "cpu,cpuacct"), ("memory", "memory"), ("cpuset", "cpuset")], 1):
        mounts.append(f"{30 + index} 20 0:{index} /lxc/181 /sys/fs/cgroup/{name} rw - cgroup cgroup rw,{controllers}")
        own.append(f"{index}:{controllers}:/lxc/181/system.slice/nvr-sr81.service")
        init.append(f"{index}:{controllers}:/lxc/181/init.scope")
    write(root, "proc/self/mountinfo", "\n".join(mounts)); write(root, "proc/self/cgroup", "\n".join(own)); write(root, "proc/1/cgroup", "\n".join(init))
    base = root / "sys/fs/cgroup"
    write(base, "cpu/cpuacct.usage", 1000000000)
    write(base, "cpu/cpu.cfs_quota_us", 100000); write(base, "cpu/cpu.cfs_period_us", 100000)
    write(base, "cpuset/cpuset.effective_cpus", "2-3")
    write(base, "memory/memory.usage_in_bytes", 512 * MIB); write(base, "memory/memory.limit_in_bytes", 1024 * MIB)
    write(base, "memory/memory.memsw.usage_in_bytes", 768 * MIB); write(base, "memory/memory.memsw.limit_in_bytes", 2048 * MIB)
    write(base, "memory/memory.stat", f"total_inactive_file {128 * MIB}")
    return base


def test_cgroup1_cpu_nanoseconds_and_memsw_difference_are_container_wide(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    base = cgroup1(root)
    collector.snapshot(); clock.value += 1
    write(base, "cpu/cpuacct.usage", 1250000000)
    result = collector.snapshot()
    assert result["cpu"]["percent"] == 25 and result["cpu"]["available_cpus"] == 1
    assert result["memory"]["total"] == 1024 * MIB and result["memory"]["working_set"] == 384 * MIB
    assert result["swap"]["used"] == 256 * MIB
    assert result["swap"]["total"] is None and result["swap"]["percent"] is None
    assert result["swap"]["reason"] == "limit_unavailable"


def test_cgroup1_unlimited_sentinel_and_absent_swap_accounting_are_not_fake_eib(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    base = cgroup1(root)
    write(base, "memory/memory.limit_in_bytes", 9223372036854771712)
    write(base, "memory/memory.memsw.limit_in_bytes", 9223372036854771712)
    (base / "memory/memory.memsw.usage_in_bytes").unlink()
    result = collector.snapshot()
    assert result["memory"]["total"] is None and result["memory"]["used"] == 512 * MIB
    assert result["swap"]["used"] is None and result["swap"]["total"] is None


def test_v1_uses_verified_lxcfs_swap_total_instead_of_nominal_memsw_difference(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    cgroup1(root)
    mountinfo = root / "proc/self/mountinfo"
    mountinfo.write_text(mountinfo.read_text() + "\n99 20 0:99 /proc/meminfo /proc/meminfo rw - fuse.lxcfs lxcfs rw\n")
    result = collector.snapshot()
    assert result["swap"]["total"] == 1024 * 1024  # fixture's virtualized SwapTotal, not a derived 1 GiB
    assert result["swap"]["source"] == "cgroup-v1+lxcfs-limit"


def test_hybrid_cgroups_find_v1_accounting_when_unified_has_no_controller_interfaces(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    base = cgroup1(root)
    for name in ["self", "1"]:
        path = root / f"proc/{name}/cgroup"
        path.write_text(path.read_text() + "\n0::/\n")
    path = root / "proc/self/mountinfo"
    path.write_text(path.read_text() + "\n99 20 0:99 / /sys/fs/cgroup/unified rw - cgroup2 cgroup rw\n")
    write(root, "sys/fs/cgroup/unified/cpu.stat", "usage_usec 999999999999")
    collector.snapshot(); clock.value += 1; write(base, "cpu/cpuacct.usage", 1500000000)
    result = collector.snapshot()
    assert result["cpu"]["source"] == "cgroup-v1" and result["cpu"]["percent"] == 50
    assert result["memory"]["used"] == 512 * MIB


def test_separate_v1_cpuacct_wins_over_unified_stats_but_keeps_v2_cpu_quota(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    base = cgroup1(root)
    for name in ["self", "1"]:
        path = root / f"proc/{name}/cgroup"
        path.write_text(path.read_text().replace("cpu,cpuacct", "cpuacct") + "\n0::/\n")
    path = root / "proc/self/mountinfo"
    path.write_text(path.read_text().replace("cpu,cpuacct", "cpuacct") + "\n99 20 0:99 / /sys/fs/cgroup/unified rw - cgroup2 cgroup rw\n")
    unified = root / "sys/fs/cgroup/unified"
    write(unified, "cpu.stat", "usage_usec 999999999999")
    write(unified, "cpu.max", "50000 100000")
    collector.snapshot(); clock.value += 1
    write(base, "cpu/cpuacct.usage", 1250000000)
    write(unified, "cpu.stat", "usage_usec 1000001999999")
    result = collector.snapshot()["cpu"]
    assert result["source"] == "cgroup-v1"
    assert result["available_cpus"] == .5 and result["percent"] == 50


def test_cgroup_service_leaf_without_pid1_does_not_become_the_os_counter(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    (root / "proc/1/cgroup").unlink()
    write(group, "system.slice/nvr-sr81.service/memory.current", 7)
    assert collector.snapshot()["memory"]["used"] == 512 * MIB


def test_fractional_cpu_quota_and_capacity_change_reset_the_sample(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root); write(group, "cpu.max", "50000 100000")
    collector.snapshot(); clock.value += 1; write(group, "cpu.stat", "usage_usec 1250000")
    assert collector.snapshot()["cpu"]["percent"] == 50
    clock.value += 1; write(group, "cpu.max", "100000 100000")
    assert collector.snapshot()["cpu"]["reason"] == "warming_up"


def test_cpu_samples_cache_reset_missing_counters_and_stale_gap(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    first = collector.snapshot()
    first["memory"]["used"] = 1
    clock.value += .2
    assert collector.snapshot()["memory"]["used"] == 512 * MIB
    assert collector.snapshot()["sampled_at"] == 1700000100
    clock.value += .8; write(group, "cpu.stat", "usage_usec 0")
    assert collector.snapshot()["cpu"]["reason"] == "counter_reset"
    clock.value += 91; write(group, "cpu.stat", "usage_usec 100000")
    assert collector.snapshot()["cpu"]["reason"] == "sample_gap"
    clock.value += 1; write(group, "cpu.stat", "usage_usec 300000")
    assert collector.snapshot()["cpu"]["percent"] == 10
    clock.value += 1; (group / "cpu.stat").unlink()
    assert collector.snapshot()["cpu"]["percent"] is None
    clock.value += 1; write(group, "cpu.stat", "usage_usec 500000")
    assert collector.snapshot()["cpu"]["reason"] == "warming_up"


def test_zero_swap_is_explicitly_not_configured_and_no_percent_is_invented(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    group = cgroup2(root)
    write(group, "memory.swap.current", 0); write(group, "memory.swap.max", 0)
    result = collector.snapshot()["swap"]
    assert result["used"] == result["total"] == 0 and result["percent"] is None
    assert result["reason"] == "not_configured"


def test_temperature_uses_cpu_sensor_not_disk_and_labels_visible_host_sensor_in_container(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch, True)
    cgroup2(root)
    write(root, "sys/class/hwmon/hwmon0/name", "nvme"); write(root, "sys/class/hwmon/hwmon0/temp1_input", 99000)
    write(root, "sys/class/hwmon/hwmon1/name", "coretemp")
    write(root, "sys/class/hwmon/hwmon1/temp1_label", "Package id 0"); write(root, "sys/class/hwmon/hwmon1/temp1_input", 42500)
    write(root, "sys/class/hwmon/hwmon1/temp2_label", "Core 0"); write(root, "sys/class/hwmon/hwmon1/temp2_input", 45000)
    cpu = collector.snapshot()["cpu"]
    assert cpu["temperature_celsius"] == 42.5 and cpu["temperature_scope"] == "host"
    assert cpu["temperature_source"] == "coretemp:Package id 0"


def test_temperature_missing_unreadable_and_thermal_fallback_are_honest(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    assert collector.snapshot()["cpu"]["temperature_celsius"] is None
    assert collector.snapshot()["cpu"]["temperature_reason"] == "not_exposed"
    write(root, "sys/class/thermal/thermal_zone0/type", "cpu-thermal"); write(root, "sys/class/thermal/thermal_zone0/temp", "not readable")
    clock.value += 10
    assert collector.snapshot()["cpu"]["temperature_reason"] == "unreadable"
    write(root, "sys/class/thermal/thermal_zone0/temp", 51000); clock.value += 10
    assert collector.snapshot()["cpu"]["temperature_celsius"] == 51
    assert collector.snapshot()["cpu"]["temperature_scope"] == "machine"


def test_sensor_labels_do_not_disclose_arbitrary_host_metadata(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch)
    write(root, "sys/class/hwmon/hwmon0/name", "coretemp")
    write(root, "sys/class/hwmon/hwmon0/temp1_label", "private-hostname-and-serial")
    write(root, "sys/class/hwmon/hwmon0/temp1_input", 42000)
    assert collector.snapshot()["cpu"]["temperature_source"] == "coretemp:CPU sensor"


def test_temperature_cache_relabels_scope_when_container_boundary_becomes_known(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    write(root, "sys/class/hwmon/hwmon0/name", "coretemp")
    write(root, "sys/class/hwmon/hwmon0/temp1_input", 42000)
    assert collector.snapshot()["cpu"]["temperature_scope"] == "machine"
    write(root, "run/systemd/container", "lxc"); clock.value += 1
    assert collector.snapshot()["cpu"]["temperature_scope"] == "host"


def test_separate_disks_are_reported_and_unavailable_recordings_are_not_zero_usage(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    monkeypatch.setattr(collector, "_device", lambda path: 1 if path == root else 2)
    monkeypatch.setattr(telemetry.shutil, "disk_usage", lambda path: SimpleNamespace(total=2000, used=1000, free=1000) if path == root else SimpleNamespace(total=1000, used=750, free=250))
    result = collector.snapshot()["disk"]
    assert result["shared_filesystem"] is False and result["root"]["percent"] == 50
    assert result["recordings"]["percent"] == 75

    def missing(path):
        raise PermissionError

    monkeypatch.setattr(telemetry.shutil, "disk_usage", missing)
    clock.value += 1
    assert collector.snapshot()["disk"]["recordings"]["used"] is None


def test_missing_os_interfaces_return_unknown_without_process_or_host_metadata(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch)
    (root / "proc/stat").unlink(); (root / "proc/meminfo").unlink()
    result = collector.snapshot()
    assert result["scope"] == "unknown" and result["cpu"]["reason"] == "unsupported"
    assert result["memory"]["used"] is None and result["cpu"]["temperature_celsius"] is None
    assert not any(key in result for key in ["hostname", "ip", "pid", "process", "environment"])


@pytest.mark.parametrize("value,expected", [("0-3", 4), ("0-1,4,6-7", 5), ("", None), ("0-999999999999", None), ("2-1", None), ("0-2,2-3", None)])
def test_cpuset_parser_is_bounded_and_validates_ranges(value, expected):
    assert _cpu_count(value) == expected


def test_identity_is_local_bounded_and_filters_loopback_without_dns(tmp_path, monkeypatch):
    root, _, collector = environment(tmp_path, monkeypatch)
    write(root, "proc/sys/kernel/hostname", "recorder\n")
    write(root, "proc/sys/kernel/osrelease", "6.8.12-test")
    write(root, "etc/os-release", 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n')
    write(root, "proc/net/if_inet6", "\n".join([
        "00000000000000000000000000000001 01 80 10 80 lo",
        "fe800000000000000000000000000123 02 40 20 80 eth0",
        "20010db8000000000000000000000001 02 40 00 80 eth0",
        "ff020000000000000000000000000001 02 40 00 80 eth0",
        "not-an-address 02 40 00 80 eth0",
    ]))
    monkeypatch.setattr(collector, "_ipv4_addresses", lambda: ["127.0.0.1", "0.0.0.0", "224.0.0.1", "192.168.10.8", "192.168.10.8"])
    monkeypatch.setattr(collector, "_architecture", lambda: "aarch64")

    def forbidden(*args, **kwargs):
        raise AssertionError("Identity must not perform DNS or connect to the network")

    monkeypatch.setattr(telemetry.socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(telemetry.socket, "gethostbyname", forbidden)
    identity = collector.snapshot()["identity"]
    assert identity == {"hostname": "recorder", "addresses": ["192.168.10.8", "fe80::123%eth0", "2001:db8::1"],
                        "os_name": "Debian GNU/Linux 13 (trixie)", "kernel": "6.8.12-test", "architecture": "aarch64"}
    monkeypatch.setattr(collector, "_ipv4_addresses", lambda: [f"10.0.0.{index}" for index in range(1, 100)])
    assert len(collector._addresses()) == 32


def test_identity_cache_and_os_release_are_data_not_shell_code(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    write(root, "proc/sys/kernel/hostname", "camera\x00recorder")
    write(root, "etc/os-release", 'PRETTY_NAME="$(do-not-run)"\n')
    first = collector.snapshot()["identity"]
    assert first["hostname"] == "camerarecorder" and first["os_name"] == "$(do-not-run)"
    write(root, "proc/sys/kernel/hostname", "changed")
    first["addresses"].append("unexpected")
    clock.value += 5
    assert collector.snapshot()["identity"]["hostname"] == "camerarecorder"
    assert collector.snapshot()["identity"]["addresses"] == []
    clock.value += 25
    assert collector.snapshot()["identity"]["hostname"] == "changed"


def test_native_and_verified_container_uptime_never_report_host_boot_time_as_container(tmp_path, monkeypatch):
    root, clock, collector = environment(tmp_path, monkeypatch)
    write(root, "proc/uptime", "5432.12 8910.00")
    assert collector.snapshot()["uptime"] == {"system_seconds": 5432.12, "service_seconds": 0}
    clock.value += 2
    write(root, "run/systemd/container", "lxc")
    assert collector.snapshot()["uptime"] == {"system_seconds": None, "service_seconds": 2}
    write(root, "proc/self/mountinfo", "31 20 0:28 /proc/uptime /proc/uptime rw - fuse.lxcfs lxcfs rw\n")
    clock.value += 1
    assert collector.snapshot()["uptime"] == {"system_seconds": 5432.12, "service_seconds": 3}
    write(root, "proc/uptime", "nan 0")
    clock.value += 1
    assert collector.snapshot()["uptime"]["system_seconds"] is None


def test_history_samples_at_most_every_five_seconds_and_does_not_fill_gaps(tmp_path, monkeypatch):
    _, clock, collector = environment(tmp_path, monkeypatch)
    assert collector.snapshot()["history"]["points"][0]["cpu_percent"] is None
    clock.value += 4
    assert len(collector.snapshot()["history"]["points"]) == 1
    clock.value += 1
    second = collector.snapshot()["history"]
    assert second["window_seconds"] == 1800 and second["interval_seconds"] == 5
    assert len(second["points"]) == 2
    second["points"][0]["memory_percent"] = 999
    clock.value += 80
    result = collector.snapshot()
    points = result["history"]["points"]
    assert [point["sampled_at"] for point in points] == [1700000100, 1700000105, 1700000185]
    assert points[0]["memory_percent"] == 75 and points[-1]["cpu_percent"] is None
    assert points[-1]["memory_percent"] == result["memory"]["percent"]


def test_history_is_bounded_to_thirty_minutes_and_clears_on_wall_clock_reversal(tmp_path, monkeypatch):
    _, clock, collector = environment(tmp_path, monkeypatch)
    for _ in range(370):
        result = collector.snapshot()
        clock.value += 5
    points = result["history"]["points"]
    assert len(points) == 361
    assert points[-1]["sampled_at"] - points[0]["sampled_at"] == 1800
    collector._wall_time = lambda: 1600000000.0
    reversed_result = collector.snapshot()
    assert len(reversed_result["history"]["points"]) == 1
    assert reversed_result["history"]["points"][0]["sampled_at"] == 1600000000
    assert reversed_result["uptime"]["service_seconds"] > 0


def test_history_clears_when_monotonic_clock_resets(tmp_path, monkeypatch):
    _, clock, collector = environment(tmp_path, monkeypatch)
    collector.snapshot(); clock.value += 5; collector.snapshot()
    collector._wall_time = lambda: 1700000200.0
    clock.value = 90
    result = collector.snapshot()
    assert len(result["history"]["points"]) == 1
    assert result["cpu"]["percent"] is None and result["uptime"]["service_seconds"] == 0
