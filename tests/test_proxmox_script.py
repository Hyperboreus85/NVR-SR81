"""Check installer umask without running any Proxmox host operations."""

import os
from pathlib import Path
import shutil
import stat
import subprocess

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "proxmox-create.sh"


@pytest.fixture(scope="module")
def bash():
    configured = os.environ.get("NVR_TEST_BASH")
    if configured:
        executable = shutil.which(configured)
        if not executable:
            pytest.fail(f"NVR_TEST_BASH is not executable: {configured}")
        return executable

    # Prefer Git Bash over the Windows WSL launcher, which may lack a distro.
    git_bash = Path("C:/Program Files/Git/bin/bash.exe")
    if os.name == "nt" and git_bash.is_file():
        return str(git_bash)
    executable = shutil.which("bash")
    if not executable:
        pytest.skip("Bash is required to exercise the Proxmox installer")
    return executable


def run_help(bash, shell, *arguments):
    # --help exits inside option parsing, before privilege checks or PVE tools.
    # The EXIT trap still observes the environment the actual script established.
    return subprocess.run(
        [bash, "--noprofile", "--norc", "-c", shell,
         "nvr-proxmox-umask-test", SCRIPT.as_posix(), *map(str, arguments)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )


@pytest.mark.parametrize("caller_umask", ["077", "027"])
def test_help_establishes_traversable_host_umask(bash, caller_umask):
    result = run_help(
        bash,
        '''umask "$2"
trap 'printf "\\nNVR_TEST_UMASK=%s\\n" "$(umask)"' EXIT
source "$1" --help
''',
        caller_umask,
    )

    assert result.returncode == 0, result.stderr
    assert "Uso: bash deploy/proxmox-create.sh" in result.stdout
    assert result.stdout.splitlines()[-1] == "NVR_TEST_UMASK=0022"


@pytest.mark.skipif(os.name == "nt", reason="Windows does not expose POSIX directory modes")
def test_directories_created_after_installer_are_traversable(bash, tmp_path):
    directory = tmp_path / "container-rootfs"
    result = run_help(
        bash,
        '''umask 077
NVR_TEST_DIRECTORY="$2"
trap 'mkdir -- "$NVR_TEST_DIRECTORY"' EXIT
source "$1" --help
''',
        directory,
    )

    assert result.returncode == 0, result.stderr
    assert directory.is_dir()
    # Proxmox's mapped UID 100000 must be able to traverse host-owned paths.
    # Under the former 077 mask this directory would instead have mode 0700.
    assert stat.S_IMODE(directory.stat().st_mode) == 0o755
