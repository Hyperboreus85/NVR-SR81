#!/usr/bin/env bash
# Installa il checkout corrente come servizio Linux locale. Eseguire come root.
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Eseguire come root.' >&2; exit 1; }
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NVR_ROOT="${NVR_ROOT:-$SOURCE_DIR}"
NVR_DATA_DIR="${NVR_DATA_DIR:-/var/lib/nvr-sr81}"
NVR_RECORDINGS_DIR="${NVR_RECORDINGS_DIR:-/srv/nvr-recordings}"
for directory in "$NVR_ROOT" "$NVR_DATA_DIR" "$NVR_RECORDINGS_DIR"; do
  [[ "$directory" == /* && "$directory" != / && "$directory" != *$'\n'* && "$directory" != *'"'* && "$directory" != *'%'* && "$directory" != *' '* ]] || {
    echo 'Usare percorsi assoluti senza spazi, virgolette, newline o percentuali.' >&2; exit 1;
  }
done
[[ "$NVR_ROOT" == "$SOURCE_DIR" ]] || { echo 'NVR_ROOT deve essere la directory del checkout che contiene questo script.' >&2; exit 1; }
case "$NVR_ROOT" in
  /root|/root/*|/home|/home/*|/run/user|/run/user/*)
    echo 'Spostare il checkout in /opt/nvr-sr81: il servizio non accede alle directory home.' >&2; exit 1 ;;
esac
command -v systemctl >/dev/null || { echo 'È richiesto systemd.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends python3 python3-venv python3-pip ffmpeg ca-certificates
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else "Occorre Python 3.11 o successivo (Debian 12/13 oppure Ubuntu 24.04+)")'
if ! id nvr-sr81 >/dev/null 2>&1; then
  if getent passwd 10001 >/dev/null; then
    echo 'UID 10001 già occupato. Non è stato modificato alcun utente.' >&2; exit 1
  fi
  if ! getent group nvr-sr81 >/dev/null; then
    if getent group 10001 >/dev/null; then
      echo 'GID 10001 già occupato. Non è stato modificato alcun gruppo.' >&2; exit 1
    fi
    groupadd --gid 10001 nvr-sr81
  fi
  [[ "$(getent group nvr-sr81 | cut -d: -f3)" == 10001 ]] || { echo 'Il gruppo nvr-sr81 deve avere GID 10001.' >&2; exit 1; }
  useradd --system --uid 10001 --gid 10001 --home-dir "$NVR_DATA_DIR" --shell /usr/sbin/nologin nvr-sr81
fi
[[ "$(id -u nvr-sr81)" == 10001 && "$(id -g nvr-sr81)" == 10001 ]] || { echo 'nvr-sr81 deve avere UID/GID 10001.' >&2; exit 1; }
# Cambia soltanto il proprietario delle directory designate, mai ricorsivamente.
install -d -m 750 -o nvr-sr81 -g nvr-sr81 "$NVR_DATA_DIR" "$NVR_RECORDINGS_DIR"
install -d -m 700 /etc/nvr-sr81
python3 -m venv "$NVR_ROOT/.venv"
"$NVR_ROOT/.venv/bin/pip" install "$NVR_ROOT"
if [[ ! -e /etc/nvr-sr81/environment ]]; then
  export NVR_DATA_DIR NVR_RECORDINGS_DIR
  python3 - <<'PY'
import os
from pathlib import Path
import secrets
password_file = os.environ.get('NVR_ADMIN_PASSWORD_FILE')
password = Path(password_file).read_text().strip() if password_file else secrets.token_urlsafe(24)
if len(password) < 12 or '\n' in password or '\r' in password:
    raise SystemExit('Password iniziale non valida (minimo 12 caratteri)')
def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
config = {'NVR_HOST': '0.0.0.0', 'NVR_PORT': '8080',
          'NVR_DATA_DIR': os.environ['NVR_DATA_DIR'],
          'NVR_RECORDINGS_DIR': os.environ['NVR_RECORDINGS_DIR'],
          'NVR_MIN_FREE_GB': os.environ.get('NVR_MIN_FREE_GB', '5'), 'NVR_ADMIN_PASSWORD': password}
path = Path('/etc/nvr-sr81/environment')
with path.open('x') as f:
    f.write(''.join(k + '=' + quote(v) + '\n' for k,v in config.items()))
path.chmod(0o600)
if not password_file:
    initial = Path('/root/nvr-initial-password')
    initial.write_text(password + '\n')
    initial.chmod(0o600)
PY
fi
MOUNT_SANDBOX=""
# LXC already provides the outer mount namespace. Its default AppArmor profile
# can reject systemd's additional mount remapping; do not require LXC nesting.
if [[ "$(systemd-detect-virt --container 2>/dev/null || true)" != lxc ]]; then
  MOUNT_SANDBOX="PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$NVR_DATA_DIR $NVR_RECORDINGS_DIR"
fi
cat > /etc/systemd/system/nvr-sr81.service <<EOF
[Unit]
Description=NVR-SR81 local network video recorder
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$NVR_RECORDINGS_DIR $NVR_DATA_DIR

[Service]
Type=simple
User=nvr-sr81
Group=nvr-sr81
EnvironmentFile=/etc/nvr-sr81/environment
WorkingDirectory=$NVR_ROOT
ExecStart=$NVR_ROOT/.venv/bin/nvr-sr81
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
$MOUNT_SANDBOX

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable nvr-sr81
systemctl restart nvr-sr81
systemctl is-active --quiet nvr-sr81
python3 - <<'PY'
import time
import urllib.request
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        pass
    time.sleep(1)
else:
    raise SystemExit('Il servizio non risponde: controllare journalctl -u nvr-sr81')
PY
echo 'NVR-SR81 installato. Interfaccia sulla porta 8080 della rete locale.'
echo 'Password iniziale nel file root /root/nvr-initial-password (se generata da questo installer).'
echo 'Configurazione: /etc/nvr-sr81/environment. Log: journalctl -u nvr-sr81.'
