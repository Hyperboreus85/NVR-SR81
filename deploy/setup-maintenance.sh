#!/usr/bin/env bash
# Install only the fixed, local maintenance helper. Never performs an NVR action.
set -Eeuo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Eseguire come root nel sistema NVR.' >&2; exit 1; }
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v systemctl >/dev/null || { echo 'È richiesto systemd.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'systemd non è attivo nel sistema NVR.' >&2; exit 1; }
[[ "$(id -u nvr-sr81)" == 10001 && "$(id -g nvr-sr81)" == 10001 ]] || { echo 'nvr-sr81 deve avere UID/GID 10001.' >&2; exit 1; }
install -d -m 755 -o root -g root /usr/libexec
install -d -m 700 -o root -g root /etc/nvr-sr81
install -m 755 -o root -g root "$SOURCE_DIR/nvr/maintenance.py" /usr/libexec/nvr-sr81-maintenance.py
install -m 644 -o root -g root "$SOURCE_DIR/deploy/nvr-sr81-maintenance.socket" /etc/systemd/system/nvr-sr81-maintenance.socket
install -m 644 -o root -g root "$SOURCE_DIR/deploy/nvr-sr81-maintenance@.service" /etc/systemd/system/nvr-sr81-maintenance@.service
if [[ ! -e /etc/nvr-sr81/maintenance.json && ! -L /etc/nvr-sr81/maintenance.json ]]; then
  (umask 077; printf '%s\n' '{"allow_system_reboot":false}' > /etc/nvr-sr81/maintenance.json)
fi
# Preserve an existing root policy, including its explicit reboot opt-in.
systemctl daemon-reload
systemctl enable --now nvr-sr81-maintenance.socket
echo 'Controlli locali di manutenzione installati. Riavvio del sistema disabilitato salvo autorizzazione root.'
