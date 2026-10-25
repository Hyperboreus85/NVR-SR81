#!/usr/bin/env bash
# Update an existing native/systemd installation; preserve its local data.

require_root() {
    [[ $EUID -eq 0 ]] || { echo 'Eseguire come root dentro il container NVR.' >&2; return 1; }
}

acquire_update_lock() {
    exec 9>"$APP_ROOT/.nvr-update.lock"
    flock -n 9 || { echo 'Un aggiornamento NVR è già in corso.' >&2; return 1; }
}

update_cleanup() {
    [[ ${PRESERVE_TMP:-0} == 0 ]] || return 0
    # Only remove the private directory created by this invocation's mktemp.
    case "${UPDATE_TMP:-}" in /tmp/nvr-sr81-update.*) rm -rf -- "$UPDATE_TMP" ;; esac
}

wheel_version() {
    "$APP_ROOT/.venv/bin/python" - "$1" "${2:-}" <<'NVR_WHEEL_PY'
from email.parser import Parser
from pathlib import Path
import sys
from zipfile import ZipFile

def wheel_metadata(wheel_path, requirements_path=''):
    with ZipFile(wheel_path) as wheel:
        filename = next(name for name in wheel.namelist() if name.endswith('.dist-info/METADATA'))
        metadata = Parser().parsestr(wheel.read(filename).decode())
    requirements = [' '.join(value.split()) for value in metadata.get_all('Requires-Dist', [])]
    # Direct URLs would bypass --no-index during the offline installation.
    if any('@' in requirement or '://' in requirement for requirement in requirements):
        raise ValueError('Le dipendenze dell\'aggiornamento devono provenire dal wheelhouse locale')
    if requirements_path:
        Path(requirements_path).write_text('\n'.join(requirements) + '\n', encoding='utf-8')
    return metadata['Version']

if __name__ == '__main__':
    print(wheel_metadata(sys.argv[1], sys.argv[2]))
NVR_WHEEL_PY
}

health_check() {
    "$APP_ROOT/.venv/bin/python" - "$NVR_ENV_FILE" "$1" <<'NVR_HEALTH_PY'
from pathlib import Path
import json
import shlex
import subprocess
import sys
import time
import urllib.request

def health_url(environment):
    config = {'NVR_HOST': '0.0.0.0', 'NVR_PORT': '8080'}
    for line in Path(environment).read_text().splitlines():
        key, separator, value = line.strip().partition('=')
        if separator and key.strip() in config:
            fields = shlex.split(value, comments=True)
            if len(fields) != 1:
                raise ValueError('Configurazione di ascolto non valida')
            config[key.strip()] = fields[0]
    host = config['NVR_HOST']
    host = {'0.0.0.0': '127.0.0.1', '::': '::1'}.get(host, host)
    if not host or any(c.isspace() or c in '/?#@' for c in host):
        raise ValueError('Indirizzo di ascolto non valido')
    port = int(config['NVR_PORT'])
    if not 1 <= port <= 65535:
        raise ValueError('Porta non valida')
    if ':' in host and not host.startswith('['):
        host = '[' + host + ']'
    return f'http://{host}:{port}/healthz'

def check_health(environment, expected_version, attempts=30):
    url = health_url(environment)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(attempts):
        try:
            active = subprocess.run(['systemctl', 'is-active', '--quiet', 'nvr-sr81'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
            if active.returncode == 0:
                with opener.open(url, timeout=2) as response:
                    payload = json.loads(response.read(65536))
                    if response.status == 200 and isinstance(payload, dict) and payload.get('status') == 'ok' and payload.get('version') == expected_version:
                        return
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        if attempt + 1 < attempts:
            time.sleep(1)
    raise SystemExit('Il servizio NVR non risponde con lo stato e la versione attesi')

if __name__ == '__main__':
    check_health(sys.argv[1], sys.argv[2])
NVR_HEALTH_PY
}

update_rollback() {
    local failed=0 can_replace=1
    # The new instance may be alive even after its health check failed.
    if ((SERVICE_STOPPED)); then
        if ! systemctl stop nvr-sr81; then
            can_replace=0
            failed=1
        fi
    fi
    if ((PACKAGE_CHANGED)); then
        if ((can_replace)) && [[ -n $OLD_WHEEL && -f $OLD_WHEEL ]]; then
            "$APP_ROOT/.venv/bin/python" -m pip install --no-index --no-deps --force-reinstall "$OLD_WHEEL" || failed=1
        else
            failed=1
        fi
    fi
    git -C "$APP_ROOT" checkout --detach --quiet "$OLD_REVISION" || failed=1
    if ((SERVICE_STOPPED && failed == 0)); then
        systemctl start nvr-sr81 || failed=1
    fi
    if ((failed == 0)); then
        health_check "$OLD_VERSION" || failed=1
    fi
    return "$failed"
}

update_error() {
    local result=${1:-1}
    trap - ERR INT TERM HUP
    set +e
    PRESERVE_TMP=1  # retain recovery files if another signal interrupts rollback
    printf '\nAggiornamento interrotto; ripristino della versione precedente.\n' >&2
    if update_rollback; then
        PRESERVE_TMP=0
        printf 'Versione precedente ripristinata e servizio verificato.\n' >&2
    else
        printf 'Ripristino non completato. Pacchetti di recupero conservati in: %s\n' "$UPDATE_TMP" >&2
        printf 'Dopo aver controllato i log, recupero manuale:\nsystemctl stop nvr-sr81\n' >&2
        if [[ -n $OLD_WHEEL ]]; then
            printf '%q -m pip install --no-index --no-deps --force-reinstall %q\n' "$APP_ROOT/.venv/bin/python" "$OLD_WHEEL" >&2
        fi
        printf 'git -C %q checkout --detach --quiet %q\nsystemctl start nvr-sr81\n' "$APP_ROOT" "$OLD_REVISION" >&2
    fi
    printf 'Diagnostica: systemctl status nvr-sr81; journalctl -u nvr-sr81 -n 50\n' >&2
    ((result != 0)) || result=1
    exit "$result"
}

nvr_update_main() {
    set -Eeuo pipefail
    set +x
    # Installed Python modules remain readable by the unprivileged service.
    umask 022
    require_root
    APP_ROOT="${NVR_ROOT:-/opt/nvr-sr81}"
    NVR_ENV_FILE="${NVR_ENV_FILE:-/etc/nvr-sr81/environment}"
    UPDATE_REF="${1:-codex/initial-nvr}"
    [[ $UPDATE_REF =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $UPDATE_REF != *..* ]] || { echo 'Riferimento Git non valido.' >&2; return 1; }
    [[ -d "$APP_ROOT/.git" && -x "$APP_ROOT/.venv/bin/python" ]] || { echo 'Installazione NVR non trovata.' >&2; return 1; }
    acquire_update_lock
    [[ -z "$(git -C "$APP_ROOT" status --porcelain --untracked-files=no)" ]] || { echo 'Il checkout contiene modifiche locali: conservarle prima di aggiornare.' >&2; return 1; }
    systemctl is-active --quiet nvr-sr81 || { echo 'Il servizio NVR deve essere attivo prima di questo aggiornamento.' >&2; return 1; }
    OLD_REVISION=$(git -C "$APP_ROOT" rev-parse HEAD)
    OLD_VERSION=$("$APP_ROOT/.venv/bin/python" -c "from importlib.metadata import version; print(version('nvr-sr81'))")
    UPDATE_TMP=$(mktemp -d /tmp/nvr-sr81-update.XXXXXXXX)
    SERVICE_STOPPED=0
    PACKAGE_CHANGED=0
    PRESERVE_TMP=0
    OLD_WHEEL=''
    trap update_cleanup EXIT
    trap 'update_error "$?"' ERR
    trap 'update_error 130' INT
    trap 'update_error 143' TERM
    trap 'update_error 129' HUP

    # Prepare rollback, application and dependency wheels before any downtime.
    mkdir "$UPDATE_TMP/old" "$UPDATE_TMP/new"
    "$APP_ROOT/.venv/bin/python" -m pip wheel --no-deps --wheel-dir "$UPDATE_TMP/old" "$APP_ROOT"
    OLD_WHEEL=$(find "$UPDATE_TMP/old" -maxdepth 1 -type f -name 'nvr_sr81-*.whl' -print -quit)
    [[ -n $OLD_WHEEL ]] || { echo 'Pacchetto di ripristino non disponibile.' >&2; false; }
    git -C "$APP_ROOT" fetch --depth 1 origin "$UPDATE_REF"
    NEW_REVISION=$(git -C "$APP_ROOT" rev-parse FETCH_HEAD)
    git -C "$APP_ROOT" checkout --detach --quiet "$NEW_REVISION"
    "$APP_ROOT/.venv/bin/python" -m pip wheel --wheel-dir "$UPDATE_TMP/new" "$APP_ROOT"
    NEW_WHEEL=$(find "$UPDATE_TMP/new" -maxdepth 1 -type f -name 'nvr_sr81-*.whl' -print -quit)
    [[ -n $NEW_WHEEL ]] || { echo 'Nuovo pacchetto non disponibile.' >&2; false; }
    NEW_VERSION=$(wheel_version "$NEW_WHEEL" "$UPDATE_TMP/runtime-requirements.txt")
    SERVICE_STOPPED=1
    systemctl stop nvr-sr81
    PACKAGE_CHANGED=1
    # No --upgrade/--force-reinstall here: retain compatible installed runtime
    # dependencies and install only what the new application's metadata needs.
    "$APP_ROOT/.venv/bin/python" -m pip install --no-index --find-links "$UPDATE_TMP/new" -r "$UPDATE_TMP/runtime-requirements.txt"
    "$APP_ROOT/.venv/bin/python" -m pip install --no-index --no-deps --force-reinstall "$NEW_WHEEL"
    if [[ -f "$APP_ROOT/deploy/setup-maintenance.sh" ]]; then
        bash "$APP_ROOT/deploy/setup-maintenance.sh"
    fi
    systemctl start nvr-sr81
    health_check "$NEW_VERSION"
    trap - ERR INT TERM HUP
    printf '\nNVR-SR81 aggiornato al commit %s. Configurazione e archivio conservati.\n' "$NEW_REVISION"
    printf 'Ricaricare la pagina web per visualizzare le nuove funzioni.\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    nvr_update_main "$@"
fi
