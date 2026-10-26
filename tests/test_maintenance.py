"""Maintenance is tested against fake timers, never the real service manager."""
import asyncio
from contextlib import nullcontext
import json
from pathlib import Path
import socket
from types import SimpleNamespace

import pytest

from nvr import maintenance as m


@pytest.mark.parametrize("action,confirmation", [
    ("restart-service", "restart"), ("restart-service", " RESTART"),
    ("reboot-system", "RESTART"), ("restart", "RESTART"),
    ("restart-service;reboot", "RESTART"), (None, "RESTART"),
])
async def test_invalid_action_never_contacts_helper(monkeypatch, action, confirmation):
    manager = m.MaintenanceManager()
    async def forbidden(*args):
        pytest.fail("Invalid action contacted a privileged helper")
    monkeypatch.setattr(manager, "_request", forbidden)
    with pytest.raises(m.MaintenanceError) as error:
        await manager.schedule(action, confirmation)
    assert error.value.status_code == 400


async def test_missing_helper_is_unavailable_and_does_not_expose_path(tmp_path):
    manager = m.MaintenanceManager(tmp_path / "secret-location.sock")
    status = await manager.status()
    assert status == m.unavailable_status()
    assert "secret-location" not in json.dumps(status)
    with pytest.raises(m.MaintenanceError, match="System maintenance is unavailable"):
        await manager.schedule("restart-service", "RESTART")


async def test_status_filters_diagnostics_and_rejects_malformed(monkeypatch):
    manager = m.MaintenanceManager()
    good = m.unavailable_status() | {"service_restart": True, "target": "container", "reason": None}
    async def response(payload):
        return good | {"private_path": "/etc/private", "stderr": "secret"}
    monkeypatch.setattr(manager, "_request", response)
    assert await manager.status() == good
    for invalid in ({}, good | {"target": []}, good | {"pending_action": []},
                    good | {"retry_after": True}, good | {"retry_after": 61}):
        async def broken(payload, result=invalid):
            return result
        monkeypatch.setattr(manager, "_request", broken)
        assert await manager.status() == m.unavailable_status()


async def test_schedule_waits_for_helper_acceptance_and_has_safe_message(monkeypatch):
    manager = m.MaintenanceManager()
    entered, release = asyncio.Event(), asyncio.Event()
    async def request(payload):
        assert payload == {"operation": "schedule", "action": "restart-service", "confirmation": "RESTART"}
        entered.set()
        await release.wait()
        return {"accepted": True, "action": "restart-service", "delay_seconds": 5, "stderr": "never public"}
    monkeypatch.setattr(manager, "_request", request)
    task = asyncio.create_task(manager.schedule("restart-service", "RESTART"))
    await entered.wait()
    assert not task.done()
    release.set()
    assert await task == {"accepted": True, "action": "restart-service", "delay_seconds": 5,
                          "message": "The NVR service will restart in a few seconds."}


@pytest.mark.parametrize("raw,error,status", [
    (b'{"ok":false,"error":"busy"}\n', "already scheduled", 409),
    (b'{"ok":false,"error":"disabled"}\n', "reboot is disabled", 403),
    (b'{"ok":false,"error":"/private/secret"}\n', "unavailable", 503),
    (b'{"ok":false,"error":[]}\n', "unavailable", 503),
    (b'x' * 1025 + b'\n', "unavailable", 503),
    (b'{"ok":true,"result":{}}', "unavailable", 503),
])
async def test_socket_reply_is_bounded_and_errors_are_sanitized(monkeypatch, raw, error, status):
    manager = m.MaintenanceManager()
    manager.socket_path = SimpleNamespace(lstat=lambda: SimpleNamespace(st_mode=m.stat.S_IFSOCK | 0o660, st_uid=0))
    monkeypatch.setattr(m.sys, "platform", "linux")
    monkeypatch.setattr(m.socket, "SO_PEERCRED", 17, raising=False)
    class Writer:
        closed = False
        def get_extra_info(self, key):
            return SimpleNamespace(getsockopt=lambda *args: m.struct.pack("3i", 1, 0, 0))
        def write(self, data):
            assert len(data) <= m.MAX_PAYLOAD
        async def drain(self):
            pass
        def close(self):
            self.closed = True
        async def wait_closed(self):
            pass
    writer = Writer()
    class Reader:
        async def readline(self):
            return raw
    async def connection(*args, **kwargs):
        assert kwargs["limit"] == m.MAX_PAYLOAD + 1
        return Reader(), writer
    monkeypatch.setattr(m.asyncio, "open_unix_connection", connection, raising=False)
    with pytest.raises(m.MaintenanceError, match=error) as caught:
        await manager._request({"operation": "capabilities"})
    assert caught.value.status_code == status and writer.closed
    assert "/private/secret" not in str(caught.value)


async def test_untrusted_socket_peer_never_receives_a_command(monkeypatch):
    manager = m.MaintenanceManager()
    manager.socket_path = SimpleNamespace(lstat=lambda: SimpleNamespace(st_mode=m.stat.S_IFSOCK | 0o660, st_uid=0))
    monkeypatch.setattr(m.sys, "platform", "linux")
    monkeypatch.setattr(m.socket, "SO_PEERCRED", 17, raising=False)
    class Writer:
        def get_extra_info(self, key):
            return SimpleNamespace(getsockopt=lambda *args: m.struct.pack("3i", 1000, 10001, 10001))
        def write(self, data):
            pytest.fail("Sent a privileged command to an untrusted peer")
        def close(self):
            pass
        async def wait_closed(self):
            pass
    async def connection(*args, **kwargs):
        return None, Writer()
    monkeypatch.setattr(m.asyncio, "open_unix_connection", connection, raising=False)
    with pytest.raises(m.MaintenanceError, match="unavailable"):
        await manager._request({"operation": "schedule", "action": "restart-service", "confirmation": "RESTART"})


@pytest.fixture
def helper(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(m, "_state_lock", nullcontext)
    monkeypatch.setattr(m, "_system_available", lambda: True)
    monkeypatch.setattr(m, "_allow_reboot", lambda: False)
    # Windows cannot model root ownership. File safety has a separate fd test.
    monkeypatch.setattr(m, "_safe_root_file", lambda path, maximum: path.read_bytes())
    return tmp_path


def request(action="restart-service", confirmation="RESTART"):
    return {"operation": "schedule", "action": action, "confirmation": confirmation}


def test_helper_fixed_timer_and_cross_instance_cooldown(helper, monkeypatch):
    calls = []
    def runner(command, **options):
        # Reservation already exists before a timer may be accepted.
        assert (helper / "pending.json").is_file()
        calls.append((command, options))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(m.subprocess, "run", runner)
    result = m.helper_request(request())
    assert result == {"ok": True, "result": {"accepted": True, "action": "restart-service", "delay_seconds": 5}}
    command, options = calls[0]
    assert command[0] == "/usr/bin/systemd-run"
    assert "--on-active=5s" in command
    assert command[-4:] == ["/usr/bin/systemctl", "--no-block", "restart", "nvr-sr81.service"]
    assert "--no-block" not in command[:command.index("/usr/bin/systemctl")]
    assert options["timeout"] == 5 and options["stdin"] == m.subprocess.DEVNULL
    assert "shell" not in options
    # A new helper invocation reads the persisted reservation, not process state.
    assert m.helper_request(request()) == {"ok": False, "error": "busy"}
    status = m.helper_request({"operation": "capabilities"})["result"]
    assert status["pending_action"] == "restart-service" and 1 <= status["retry_after"] <= 60
    assert status["service_restart"] is True and status["system_reboot"] is False
    assert len(calls) == 1


def test_helper_reboot_requires_root_opt_in_and_has_no_remote_target(helper, monkeypatch):
    calls = []
    monkeypatch.setattr(m.subprocess, "run", lambda command, **kw: calls.append(command) or SimpleNamespace(returncode=0))
    assert m.helper_request(request("reboot-system", "REBOOT")) == {"ok": False, "error": "disabled"}
    assert not calls and not (helper / "pending.json").exists()
    monkeypatch.setattr(m, "_allow_reboot", lambda: True)
    assert m.helper_request(request("reboot-system", "REBOOT"))["ok"] is True
    assert calls[0][-3:] == ["/usr/bin/systemctl", "--no-block", "reboot"]
    assert not any(value in calls[0] for value in ("ssh", "pct", "-H", "--host", "-M", "--machine"))


def test_definite_timer_failure_clears_reservation_but_uncertain_timeout_keeps_it(helper, monkeypatch):
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    assert m.helper_request(request()) == {"ok": False, "error": "unavailable"}
    assert not (helper / "pending.json").exists()
    def timeout(*args, **kwargs):
        raise m.subprocess.TimeoutExpired("systemd-run", 5)
    monkeypatch.setattr(m.subprocess, "run", timeout)
    assert m.helper_request(request()) == {"ok": False, "error": "unavailable"}
    assert (helper / "pending.json").exists()
    assert m.helper_request(request()) == {"ok": False, "error": "busy"}


@pytest.mark.parametrize("payload", [None, [], {}, {"operation": "shell", "command": "reboot"},
    {"operation": "capabilities", "path": "/tmp/x"},
    request() | {"unit": "other.service"}, request("reboot-system", "reboot"),
    request("restart-service; reboot", "RESTART")])
def test_helper_rejects_unknown_operations_and_parameters_before_any_privileged_work(monkeypatch, payload):
    monkeypatch.setattr(m, "_system_available", lambda: pytest.fail("Invalid input reached privileged work"))
    assert m.helper_request(payload) == {"ok": False, "error": "invalid"}


def test_policy_is_strict_root_file_json(monkeypatch):
    for data, allowed in ((b'{"allow_system_reboot":true}', True),
                          (b'{"allow_system_reboot":"true"}', False),
                          (b'{"allow_system_reboot":1}', False), (b'{}', False), (b'invalid', False)):
        monkeypatch.setattr(m, "_safe_root_file", lambda *args, value=data: value)
        assert m._allow_reboot() is allowed
    def unsafe(*args):
        raise ValueError("Unsafe owner")
    monkeypatch.setattr(m, "_safe_root_file", unsafe)
    assert m._allow_reboot() is False


def test_root_file_checks_open_descriptor_owner_mode_and_size(tmp_path, monkeypatch):
    path = tmp_path / "policy"
    path.write_text("{}")
    info = SimpleNamespace(st_mode=m.stat.S_IFREG | 0o600, st_uid=0, st_size=2)
    monkeypatch.setattr(m.os, "fstat", lambda fd: info)
    assert m._safe_root_file(path, 10) == b"{}"
    for mode, uid, size in ((m.stat.S_IFREG | 0o666, 0, 2), (m.stat.S_IFREG | 0o600, 10001, 2),
                            (m.stat.S_IFDIR | 0o600, 0, 2), (m.stat.S_IFREG | 0o600, 0, 11)):
        info.st_mode, info.st_uid, info.st_size = mode, uid, size
        with pytest.raises(ValueError):
            m._safe_root_file(path, 10)


def test_installed_units_preserve_nnp_and_only_local_socket():
    root = Path(__file__).resolve().parents[1]
    unit = (root / "deploy/nvr-sr81-maintenance@.service").read_text()
    socket_unit = (root / "deploy/nvr-sr81-maintenance.socket").read_text()
    assert "NoNewPrivileges=true" in unit and "python3 -I /usr/libexec/nvr-sr81-maintenance.py --helper" in unit
    assert "SocketMode=0660" in socket_unit and "SocketGroup=nvr-sr81" in socket_unit
    assert "ListenStream=/run/nvr-sr81-maintenance.sock" in socket_unit
    assert "Accept=yes" in socket_unit and "MaxConnections=4" in socket_unit
    assert "sudo" not in unit and "ListenStream=0.0.0.0" not in socket_unit
