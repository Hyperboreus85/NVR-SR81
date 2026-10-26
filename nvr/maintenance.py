"""Narrow local systemd maintenance protocol; no shell or remote host control.

The web process remains unprivileged. The installer copies this stdlib-only
module to a root-owned path and systemd starts ``--helper`` for each local
socket connection. HTTP authentication/CSRF are the caller's responsibility.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid


SOCKET_PATH = Path("/run/nvr-sr81-maintenance.sock")
RUNTIME_DIR = Path("/run/nvr-sr81-maintenance")
POLICY_PATH = Path("/etc/nvr-sr81/maintenance.json")
SYSTEMCTL = "/usr/bin/systemctl"
SYSTEMD_RUN = "/usr/bin/systemd-run"
MAX_PAYLOAD = 1024
DELAY_SECONDS = 5
COOLDOWN_SECONDS = 60
CONFIRMATIONS = {"restart-service": "RESTART", "reboot-system": "REBOOT"}
UNAVAILABLE = "System maintenance is unavailable on this installation."


class MaintenanceError(Exception):
    def __init__(self, message: str, status_code: int = 503):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def validate_action(action: object, confirmation: object) -> str:
    if not isinstance(action, str) or action not in CONFIRMATIONS:
        raise MaintenanceError("Choose a valid maintenance action.", 400)
    if not isinstance(confirmation, str) or confirmation != CONFIRMATIONS[action]:
        raise MaintenanceError("The maintenance confirmation does not match.", 400)
    return action


def unavailable_status() -> dict:
    return {"service_restart": False, "system_reboot": False,
            "target": "unavailable", "pending_action": None, "retry_after": 0,
            "delay_seconds": DELAY_SECONDS, "reason": UNAVAILABLE}


class MaintenanceManager:
    def __init__(self, socket_path: Path = SOCKET_PATH):
        self.socket_path = Path(socket_path)
        self._lock = asyncio.Lock()

    async def _request(self, payload: dict) -> dict:
        if sys.platform != "linux":
            raise MaintenanceError(UNAVAILABLE)
        writer = None
        try:
            node = self.socket_path.lstat()
            if not stat.S_ISSOCK(node.st_mode) or node.st_uid != 0 or node.st_mode & 0o007:
                raise MaintenanceError(UNAVAILABLE)
            async with asyncio.timeout(12):
                reader, writer = await asyncio.open_unix_connection(str(self.socket_path), limit=MAX_PAYLOAD + 1)
                peer = writer.get_extra_info("socket")
                if peer is None or struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] != 0:
                    raise MaintenanceError(UNAVAILABLE)
                writer.write(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
                await writer.drain()
                raw = await reader.readline()
                if not raw.endswith(b"\n") or len(raw) > MAX_PAYLOAD:
                    raise MaintenanceError(UNAVAILABLE)
                response = json.loads(raw)
                if not isinstance(response, dict):
                    raise MaintenanceError(UNAVAILABLE)
                if response.get("ok") is not True:
                    code = response.get("error")
                    messages = {"busy": ("A maintenance action is already scheduled. Please wait before trying again.", 409),
                                "disabled": ("System reboot is disabled on this installation.", 403),
                                "invalid": ("Choose a valid maintenance action.", 400)}
                    message, status = messages.get(code, (UNAVAILABLE, 503)) if isinstance(code, str) else (UNAVAILABLE, 503)
                    raise MaintenanceError(message, status)
                result = response.get("result")
                if not isinstance(result, dict):
                    raise MaintenanceError(UNAVAILABLE)
                return result
        except (OSError, TimeoutError, ValueError, asyncio.LimitOverrunError) as exc:
            raise MaintenanceError(UNAVAILABLE) from exc
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def status(self) -> dict:
        try:
            result = await self._request({"operation": "capabilities"})
            if (not (set(unavailable_status()) - {"reason"}).issubset(result)
                    or type(result.get("service_restart")) is not bool
                    or type(result.get("system_reboot")) is not bool
                    or not isinstance(result.get("target"), str)
                    or result.get("target") not in {"container", "machine", "unavailable"}
                    or not (result.get("pending_action") is None or isinstance(result.get("pending_action"), str))
                    or result.get("pending_action") not in {None, *CONFIRMATIONS}
                    or type(result.get("retry_after")) is not int
                    or not 0 <= result["retry_after"] <= COOLDOWN_SECONDS
                    or result.get("delay_seconds") != DELAY_SECONDS):
                return unavailable_status()
            # Return only protocol fields, never helper diagnostics or paths.
            return {key: result[key] for key in unavailable_status() if key != "reason"} | {"reason": None}
        except MaintenanceError:
            return unavailable_status()

    async def schedule(self, action: str, confirmation: str) -> dict:
        validate_action(action, confirmation)
        async with self._lock:
            result = await self._request({"operation": "schedule", "action": action, "confirmation": confirmation})
        if result.get("accepted") is not True or result.get("action") != action or result.get("delay_seconds") != DELAY_SECONDS:
            raise MaintenanceError(UNAVAILABLE)
        message = ("The NVR service will restart in a few seconds." if action == "restart-service"
                   else "This system will reboot in a few seconds.")
        return {"accepted": True, "action": action, "delay_seconds": DELAY_SECONDS, "message": message}


def _safe_root_file(path: Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > maximum:
            raise ValueError("Unsafe maintenance state")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Oversized maintenance state")
        return data


def _allow_reboot() -> bool:
    try:
        policy = json.loads(_safe_root_file(POLICY_PATH, 4096))
        return isinstance(policy, dict) and policy.get("allow_system_reboot") is True
    except (OSError, ValueError):
        return False


def _system_available() -> bool:
    if not Path("/run/systemd/system").is_dir() or not all(os.access(p, os.X_OK) for p in (SYSTEMCTL, SYSTEMD_RUN)):
        return False
    try:
        result = subprocess.run([SYSTEMCTL, "show", "nvr-sr81.service", "--property=LoadState", "--value"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=2, check=False)
        return result.returncode == 0 and result.stdout.strip() == b"loaded"
    except (OSError, subprocess.SubprocessError):
        return False


@contextmanager
def _state_lock():
    import fcntl  # Linux helper only; importing the app remains portable.
    RUNTIME_DIR.mkdir(mode=0o700, exist_ok=True)
    directory = RUNTIME_DIR.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o077:
        raise ValueError("Unsafe maintenance directory")
    descriptor = os.open(RUNTIME_DIR / "lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError("Unsafe maintenance lock")
        # Never block an accepted socket indefinitely behind another helper.
        deadline = time.monotonic() + 3
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Maintenance lock busy")
                time.sleep(0.025)
        yield
    finally:
        os.close(descriptor)


def _pending() -> tuple[str | None, int]:
    try:
        state = json.loads(_safe_root_file(RUNTIME_DIR / "pending.json", 1024))
    except FileNotFoundError:
        return None, 0
    if (not isinstance(state, dict) or not isinstance(state.get("action"), str) or state.get("action") not in CONFIRMATIONS
            or type(state.get("until")) not in (int, float) or not math.isfinite(state["until"])):
        raise ValueError("Invalid maintenance state")
    remaining = max(0, min(COOLDOWN_SECONDS, math.ceil(state["until"] - time.monotonic())))
    return (state["action"] if remaining else None), remaining


def _reserve(action: str) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix="pending-", dir=RUNTIME_DIR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"action": action, "until": time.monotonic() + COOLDOWN_SECONDS}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, RUNTIME_DIR / "pending.json")
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def helper_request(request: object) -> dict:
    """Process one already bounded request. No user text enters a command."""
    if not isinstance(request, dict):
        return {"ok": False, "error": "invalid"}
    operation = request.get("operation")
    if operation == "capabilities" and set(request) == {"operation"}:
        action = None
    elif operation == "schedule" and set(request) == {"operation", "action", "confirmation"}:
        try:
            action = validate_action(request["action"], request["confirmation"])
        except MaintenanceError:
            return {"ok": False, "error": "invalid"}
    else:
        return {"ok": False, "error": "invalid"}
    if not _system_available():
        return {"ok": False, "error": "unavailable"}
    try:
        with _state_lock():
            pending, retry_after = _pending()
            allow_reboot = _allow_reboot()
            if action is None:
                return {"ok": True, "result": {"service_restart": True, "system_reboot": allow_reboot,
                        "target": "container" if Path("/run/systemd/container").exists() else "machine",
                        "pending_action": pending, "retry_after": retry_after, "delay_seconds": DELAY_SECONDS}}
            if action == "reboot-system" and not allow_reboot:
                return {"ok": False, "error": "disabled"}
            if retry_after:
                return {"ok": False, "error": "busy"}
            # Reserve before enqueuing: a crash/timeout must not allow a retry to
            # enqueue a second action after the first timer may be accepted.
            _reserve(action)
            command = [SYSTEMD_RUN, "--quiet", "--collect", "--unit=nvr-sr81-maintenance-" + uuid.uuid4().hex,
                       "--on-active=5s", "--timer-property=AccuracySec=1s",
                       "--timer-property=RemainAfterElapse=no", "--property=Type=oneshot",
                       SYSTEMCTL, "--no-block"]
            command += ["restart", "nvr-sr81.service"] if action == "restart-service" else ["reboot"]
            try:
                accepted = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, timeout=5, check=False)
            except (OSError, subprocess.SubprocessError):
                # Outcome can be uncertain on timeout: keep the cooldown.
                return {"ok": False, "error": "unavailable"}
            if accepted.returncode != 0:
                (RUNTIME_DIR / "pending.json").unlink(missing_ok=True)
                return {"ok": False, "error": "unavailable"}
            return {"ok": True, "result": {"accepted": True, "action": action, "delay_seconds": DELAY_SECONDS}}
    except TimeoutError:
        return {"ok": False, "error": "busy"}
    except (OSError, ValueError):
        return {"ok": False, "error": "unavailable"}


def helper_main() -> int:
    if sys.platform != "linux" or os.geteuid() != 0:
        return 1
    with socket.socket(fileno=os.dup(0)) as connection:
        connection.settimeout(3)
        raw = bytearray()
        try:
            while b"\n" not in raw and len(raw) <= MAX_PAYLOAD:
                chunk = connection.recv(min(256, MAX_PAYLOAD + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if not raw.endswith(b"\n") or len(raw) > MAX_PAYLOAD or raw.count(b"\n") != 1:
                result = {"ok": False, "error": "invalid"}
            else:
                result = helper_request(json.loads(raw))
            connection.sendall(json.dumps(result, separators=(",", ":")).encode() + b"\n")
        except (OSError, ValueError):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(helper_main() if sys.argv[1:] == ["--helper"] else 1)
