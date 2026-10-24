"""Exercise the updater with temporary files and simulated service commands."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "update.sh"
embedded = SCRIPT.read_text(encoding="utf-8").split("<<'NVR_HEALTH_PY'\n", 1)[1].split("\nNVR_HEALTH_PY", 1)[0]
health = ModuleType("nvr_update_health")
exec(compile(embedded, str(SCRIPT) + ":health", "exec"), health.__dict__)


@pytest.fixture(scope="module")
def bash():
    configured = os.environ.get("NVR_TEST_BASH")
    git_bash = Path("C:/Program Files/Git/bin/bash.exe")
    executable = configured or (str(git_bash) if os.name == "nt" and git_bash.is_file() else shutil.which("bash"))
    if not executable:
        pytest.skip("Bash is required for updater control-flow tests")
    return executable


def run_shell(bash, source, *arguments, env=None):
    return subprocess.run([bash, "--noprofile", "--norc", "-c", source, "nvr-update-test", SCRIPT.as_posix(),
                           *[str(argument) for argument in arguments]], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=20, env=env)


def environment_file(tmp_path, host="0.0.0.0", port="8080"):
    path = tmp_path / "environment"
    path.write_text(f'# Local service\nNVR_HOST="{host}"\nNVR_PORT="{port}" # listen port\nNVR_ADMIN_PASSWORD="secret not used"\n', encoding="utf-8")
    return path


@pytest.mark.parametrize("host,expected", [("0.0.0.0", "127.0.0.1"), ("192.168.1.9", "192.168.1.9"),
                                           ("::", "[::1]"), ("::1", "[::1]")])
def test_health_uses_configured_host_port_and_shell_quotes(tmp_path, host, expected):
    assert health.health_url(environment_file(tmp_path, host, "9090")) == f"http://{expected}:9090/healthz"


def test_health_ignores_proxy_environment_and_requires_matching_version(tmp_path):
    response = Mock(status=200)
    response.read.return_value = json.dumps({"status": "ok", "version": "0.2.0"}).encode()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock()
    opener.open.return_value = response
    with patch.object(health.urllib.request, "build_opener", return_value=opener) as build, \
         patch.object(health.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as service, \
         patch.dict(os.environ, {"HTTP_PROXY": "http://unreachable.invalid:9000"}):
        health.check_health(environment_file(tmp_path), "0.2.0", attempts=1)
    assert build.call_args.args[0].proxies == {}
    assert opener.open.call_args.args[0] == "http://127.0.0.1:8080/healthz"
    assert service.call_args.args[0] == ["systemctl", "is-active", "--quiet", "nvr-sr81"]


@pytest.mark.parametrize("state,payload", [(1, {"status": "ok", "version": "0.2.0"}),
                                            (0, {"status": "ok", "version": "old"}),
                                            (0, {"status": "failed", "version": "0.2.0"}),
                                            (0, ["ok"]), (0, "not NVR JSON")])
def test_health_rejects_inactive_wrong_version_and_non_nvr_response(tmp_path, state, payload):
    response = Mock(status=200)
    response.read.return_value = json.dumps(payload).encode()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock()
    opener.open.return_value = response
    with patch.object(health.urllib.request, "build_opener", return_value=opener), \
         patch.object(health.subprocess, "run", return_value=SimpleNamespace(returncode=state)), \
         pytest.raises(SystemExit):
        health.check_health(environment_file(tmp_path), "0.2.0", attempts=1)
    if state:
        opener.open.assert_not_called()


@pytest.fixture
def installation(tmp_path):
    root = tmp_path / "installation"
    python = root / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    (root / ".git").mkdir()
    python.write_text('''#!/usr/bin/env bash
if [[ $1 == -c ]]; then printf '0.1.0\\n'; exit 0; fi
if [[ $1 == -m && $3 == wheel ]]; then
    while (($#)); do
        if [[ $1 == --wheel-dir ]]; then touch "$2/nvr_sr81-test.whl"; break; fi
        shift
    done
    exit 0
fi
printf 'pip-install:%s\\n' "${*: -1}" >> "$NVR_TEST_LOG"
[[ ${NVR_TEST_PIP_FAIL:-0} == 0 ]]
''', encoding="utf-8", newline="\n")
    python.chmod(0o755)
    (root / "data.sqlite").write_bytes(b"keep database")
    (root / "recording.mkv").write_bytes(b"keep recording")
    wheel = tmp_path / "nvr_sr81-old.whl"
    wheel.write_bytes(b"rollback wheel")
    return root, wheel, tmp_path / "commands.log"


ROLLBACK_SETUP = '''source "$1"
APP_ROOT="$2"; OLD_WHEEL="$3"; NVR_TEST_LOG="$4"; export NVR_TEST_LOG
OLD_REVISION=old-commit; OLD_VERSION=0.1.0; SERVICE_STOPPED=1; PACKAGE_CHANGED=1
systemctl() { printf 'system:%s\\n' "$1" >> "$NVR_TEST_LOG"; [[ ${NVR_TEST_STOP_FAIL:-0} == 0 || $1 != stop ]]; }
git() { printf 'git:%s\\n' "${*:3}" >> "$NVR_TEST_LOG"; return 0; }
health_check() { printf 'health:%s\\n' "$1" >> "$NVR_TEST_LOG"; return 0; }
'''


def test_rollback_stops_new_service_before_restore_and_verifies_old(bash, installation):
    root, wheel, log = installation
    result = run_shell(bash, ROLLBACK_SETUP + "update_rollback", root, wheel, log)
    assert result.returncode == 0, result.stderr
    commands = log.read_text().splitlines()
    assert commands[0] == "system:stop"
    assert commands[1].startswith("pip-install:")
    assert commands[2] == "git:checkout --detach --quiet old-commit"
    assert commands[3:] == ["system:start", "health:0.1.0"]
    assert (root / "data.sqlite").read_bytes() == b"keep database"
    assert (root / "recording.mkv").read_bytes() == b"keep recording"


def test_failed_stop_does_not_replace_live_package_or_restart(bash, installation):
    root, wheel, log = installation
    result = run_shell(bash, ROLLBACK_SETUP + "NVR_TEST_STOP_FAIL=1; update_rollback", root, wheel, log)
    assert result.returncode == 1
    commands = log.read_text()
    assert "pip-install:" not in commands
    assert "system:start" not in commands


def test_preparation_failure_checks_old_service_without_restarting(bash, installation):
    root, wheel, log = installation
    result = run_shell(bash, ROLLBACK_SETUP + "SERVICE_STOPPED=0; PACKAGE_CHANGED=0; update_rollback", root, wheel, log)
    assert result.returncode == 0, result.stderr
    assert log.read_text().splitlines() == ["git:checkout --detach --quiet old-commit", "health:0.1.0"]


def test_failed_rollback_preserves_artifact_and_prints_manual_commands(bash, installation):
    root, wheel, log = installation
    shell = ROLLBACK_SETUP + '''UPDATE_TMP="$(dirname "$OLD_WHEEL")"
export NVR_TEST_PIP_FAIL=1
trap 'printf "PRESERVED=%s\\n" "$PRESERVE_TMP"; update_cleanup' EXIT
update_error 42
'''
    result = run_shell(bash, shell, root, wheel, log)
    assert result.returncode == 42
    assert "PRESERVED=1" in result.stdout
    assert wheel.read_bytes() == b"rollback wheel"
    assert "Ripristino non completato" in result.stderr
    assert "--no-index --no-deps --force-reinstall" in result.stderr
    assert "systemctl start nvr-sr81" in result.stderr
    assert "system:start" not in log.read_text()


MAIN_SETUP = '''source "$1"
NVR_ROOT="$2"; NVR_TEST_LOG="$3"; TEST_TMP="$4"; export NVR_TEST_LOG
require_root() { return 0; }
flock() { printf 'flock:%s\\n' "$*" >> "$NVR_TEST_LOG"; return 0; }
mktemp() { command mktemp -d "$TEST_TMP/nvr-sr81-update.XXXXXXXX"; }
git() {
    case $3 in
        status) return 0 ;;
        rev-parse) if [[ $4 == HEAD ]]; then printf old-commit; else printf new-commit; fi ;;
        *) printf 'git:%s\\n' "${*:3}" >> "$NVR_TEST_LOG" ;;
    esac
}
systemctl() { printf 'system:%s\\n' "$1" >> "$NVR_TEST_LOG"; return 0; }
wheel_version() { printf '0.2.0'; }
health_check() {
    printf 'health:%s\\n' "$1" >> "$NVR_TEST_LOG"
    if [[ $1 == 0.2.0 && ${NVR_TEST_SIGNAL:-0} == 1 ]]; then kill -TERM "$BASHPID"; fi
    if [[ $1 == 0.2.0 && ${NVR_TEST_HEALTH_FAIL:-0} == 1 ]]; then return 5; fi
    return 0
}
nvr_update_main
'''


def test_main_update_preserves_files_and_checks_new_version(bash, installation, tmp_path):
    root, _, log = installation
    result = run_shell(bash, MAIN_SETUP, root, log, tmp_path)
    assert result.returncode == 0, result.stderr
    assert "aggiornato al commit new-commit" in result.stdout
    commands = log.read_text()
    assert "flock:-n 9" in commands
    assert "health:0.2.0" in commands
    assert commands.index("system:stop") < commands.index("pip-install:") < commands.index("health:0.2.0")
    assert (root / "data.sqlite").read_bytes() == b"keep database"
    assert (root / "recording.mkv").read_bytes() == b"keep recording"


def test_signal_after_new_start_triggers_rollback(bash, installation, tmp_path):
    root, _, log = installation
    env = dict(os.environ, NVR_TEST_SIGNAL="1")
    result = run_shell(bash, MAIN_SETUP, root, log, tmp_path, env=env)
    assert result.returncode == 143, result.stderr
    assert "ripristinata e servizio verificato" in result.stderr
    commands = log.read_text().splitlines()
    index = commands.index("health:0.2.0")
    assert commands[index + 1] == "system:stop"
    assert commands[index + 2].startswith("pip-install:")
    assert commands[-1] == "health:0.1.0"


def test_failed_new_health_triggers_error_trap_and_verified_rollback(bash, installation, tmp_path):
    root, _, log = installation
    env = dict(os.environ, NVR_TEST_HEALTH_FAIL="1")
    result = run_shell(bash, MAIN_SETUP, root, log, tmp_path, env=env)
    assert result.returncode == 5, result.stderr
    assert "ripristinata e servizio verificato" in result.stderr
    commands = log.read_text().splitlines()
    index = commands.index("health:0.2.0")
    assert commands[index + 1] == "system:stop"
    assert commands[index + 2].startswith("pip-install:")
    assert commands[-1] == "health:0.1.0"


def test_lock_failure_prevents_any_service_changes(bash, installation, tmp_path):
    root, _, log = installation
    setup = MAIN_SETUP.replace("nvr_update_main\n", "flock() { return 1; }\nnvr_update_main\n")
    result = run_shell(bash, setup, root, log, tmp_path)
    assert result.returncode == 1
    assert "aggiornamento NVR è già in corso" in result.stderr
    assert not log.exists()
