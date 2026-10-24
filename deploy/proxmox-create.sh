#!/usr/bin/env bash
# Run on a Proxmox VE node. Never replaces an existing guest or deletes on failure.
set -Eeuo pipefail
set +x
# Proxmox creates host directories traversed by the container's mapped UID
# 100000 during extraction. A restrictive inherited mask makes those paths 0700.
# Guest credential files are separately created with an explicit 0600 mode.
umask 022

CTID=''
ROOT_STORAGE=''
TEMPLATE_STORAGE='local'
RECORDINGS_STORAGE=''
RECORDINGS_PATH=''
RECORDINGS_GB=100
CT_HOSTNAME='nvr-sr81'
BRIDGE='vmbr0'
IP='dhcp'
GATEWAY=''
CORES=2
MEMORY=4096
SWAP=512
ROOT_GB=8
MIN_FREE_GB=5
DEBIAN=12
REF='codex/initial-nvr'
DRY_RUN=0
CREATED=0
REPOSITORY='https://github.com/Hyperboreus85/NVR-SR81.git'

usage() {
    cat <<'USAGE'
Uso: bash deploy/proxmox-create.sh --id ID --storage STORAGE [opzioni]

È obbligatoria una destinazione separata per le registrazioni:
  --recordings-storage STORAGE  Crea un volume Proxmox gestito
  --recordings-gb GiB           Dimensione del volume (predefinita: 100)
  --recordings-path /mnt/...    Directory host esistente, alternativa al volume

Opzioni:
  --template-storage STORAGE   Storage template con contenuto vztmpl (local)
  --debian 12|13               Template Debian standard ufficiale (12)
  --hostname NOME              Nome container (nvr-sr81)
  --bridge BRIDGE              Bridge già esistente (vmbr0)
  --ip dhcp|IPv4/CIDR          Indirizzo (dhcp)
  --gateway IPv4               Gateway, solo con IP statico
  --cores N                    Core (2)
  --memory MiB                 RAM (4096)
  --swap MiB                   Swap (512)
  --root-gb GiB                Disco di sistema (8)
  --min-free-gb GB             Riserva archivio decimale (5)
  --ref RIFERIMENTO            Branch, tag o commit da installare (codex/initial-nvr)
  --dry-run                    Controlli e riepilogo, nessuna creazione/download
  --help                       Mostra questa guida

Nessun disco viene formattato; non vengono modificati pacchetti o reti del nodo.
Le dimensioni dei volumi Proxmox sono GiB, la riserva NVR è in GB decimali.
USAGE
}

die() { printf 'Errore: %s\n' "$*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "Valore mancante per $1"; }
while (($#)); do
    case "$1" in
        --id) need_value "$@"; CTID=$2; shift 2 ;;
        --storage) need_value "$@"; ROOT_STORAGE=$2; shift 2 ;;
        --template-storage) need_value "$@"; TEMPLATE_STORAGE=$2; shift 2 ;;
        --recordings-storage) need_value "$@"; RECORDINGS_STORAGE=$2; shift 2 ;;
        --recordings-path) need_value "$@"; RECORDINGS_PATH=$2; shift 2 ;;
        --recordings-gb) need_value "$@"; RECORDINGS_GB=$2; shift 2 ;;
        --hostname) need_value "$@"; CT_HOSTNAME=$2; shift 2 ;;
        --bridge) need_value "$@"; BRIDGE=$2; shift 2 ;;
        --ip) need_value "$@"; IP=$2; shift 2 ;;
        --gateway) need_value "$@"; GATEWAY=$2; shift 2 ;;
        --cores) need_value "$@"; CORES=$2; shift 2 ;;
        --memory) need_value "$@"; MEMORY=$2; shift 2 ;;
        --swap) need_value "$@"; SWAP=$2; shift 2 ;;
        --root-gb) need_value "$@"; ROOT_GB=$2; shift 2 ;;
        --min-free-gb) need_value "$@"; MIN_FREE_GB=$2; shift 2 ;;
        --debian) need_value "$@"; DEBIAN=$2; shift 2 ;;
        --ref) need_value "$@"; REF=$2; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "Opzione sconosciuta: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || die 'Eseguire come root sul nodo Proxmox VE.'
for command in pct pveam pvesm pvesh python3 awk sort realpath stat flock lxc-usernsexec; do
    command -v "$command" >/dev/null || die "Comando richiesto non disponibile: $command"
done
[[ -d /etc/pve/nodes ]] || die 'Questo sistema non sembra un nodo Proxmox VE.'
[[ $CTID =~ ^[1-9][0-9]{2,8}$ ]] && ((CTID >= 100 && CTID <= 999999999)) || die '--id deve essere fra 100 e 999999999.'
[[ -n $ROOT_STORAGE ]] || die 'Specificare --storage: lo storage del disco di sistema non viene scelto automaticamente.'
[[ -n $RECORDINGS_STORAGE || -n $RECORDINGS_PATH ]] || die 'Specificare --recordings-storage oppure --recordings-path.'
[[ -z $RECORDINGS_STORAGE || -z $RECORDINGS_PATH ]] || die 'Le due destinazioni delle registrazioni sono alternative.'
for storage in "$ROOT_STORAGE" "$TEMPLATE_STORAGE" ${RECORDINGS_STORAGE:+"$RECORDINGS_STORAGE"}; do
    [[ $storage =~ ^[A-Za-z][A-Za-z0-9_.-]*$ ]] || die "Nome storage non valido: $storage"
done
[[ $CT_HOSTNAME =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || die 'Hostname non valido.'
[[ $BRIDGE =~ ^[A-Za-z][A-Za-z0-9_.:-]*$ && -d /sys/class/net/$BRIDGE/bridge ]] || die 'Il bridge richiesto non esiste sul nodo.'
[[ $DEBIAN == 12 || $DEBIAN == 13 ]] || die '--debian deve essere 12 o 13.'
[[ $REF =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $REF != *..* && $REF != *@* ]] || die 'Riferimento Git non valido.'
for number in "$CORES" "$MEMORY" "$SWAP" "$ROOT_GB" "$RECORDINGS_GB" "$MIN_FREE_GB"; do
    [[ $number =~ ^(0|[1-9][0-9]{0,6})$ ]] || die 'Le dimensioni e le risorse devono essere numeri interi non negativi.'
done
((CORES >= 1 && MEMORY >= 1024 && ROOT_GB >= 8 && RECORDINGS_GB >= 10 && MIN_FREE_GB >= 1)) || die 'Minimi: 1 core, 1024 MiB RAM, sistema 8 GiB, archivio 10 GiB, riserva 1 GB.'
((RECORDINGS_GB * 1073741824 > MIN_FREE_GB * 1000000000)) || die 'Il volume registrazioni deve superare la riserva libera.'
python3 - "$IP" "$GATEWAY" <<'PY'
import ipaddress
import sys
ip, gateway = sys.argv[1:]
if ip == 'dhcp':
    if gateway:
        raise SystemExit('Non specificare --gateway con DHCP.')
else:
    try:
        if '/' not in ip:
            raise ValueError()
        ipaddress.IPv4Interface(ip)
        if gateway:
            ipaddress.IPv4Address(gateway)
    except ValueError:
        raise SystemExit('Indirizzo IPv4/CIDR o gateway non valido.')
PY

# Lock this installer locally; pct create also refuses occupied IDs cluster-wide.
exec 9>"/run/lock/nvr-sr81-create-${CTID}.lock"
flock -n 9 || die 'Una creazione per questo ID è già in corso.'
pvesh get /cluster/nextid --vmid "$CTID" >/dev/null || die "ID $CTID già occupato o cluster non disponibile. Nessun guest verrà sovrascritto."
CT_DIRECTORY="/var/lib/lxc/${CTID}"
if [[ -e $CT_DIRECTORY || -L $CT_DIRECTORY ]]; then
    die "ID libero ma directory $CT_DIRECTORY già presente. Verificare eventuali residui del tentativo precedente prima di riprovare; lo script non ne modifica permessi o contenuto."
fi
if ! lxc-usernsexec -m u:0:100000:65536 -m g:0:100000:65536 -- /usr/bin/test -x /var/lib/lxc; then
    die 'Il percorso /var/lib/lxc non è attraversabile dal container non privilegiato. Verificare i permessi con namei -l /var/lib/lxc prima di creare volumi.'
fi

storage_free_kib() {
    local available
    available=$(pvesm status --storage "$1" --content "$2" | awk -v name="$1" 'NR > 1 && $1 == name && $3 == "active" {print $6}')
    [[ $available =~ ^[0-9]+$ ]] || die "Storage $1 non attivo o contenuto $2 non abilitato."
    printf '%s' "$available"
}
root_free=$(storage_free_kib "$ROOT_STORAGE" rootdir)
template_free=$(storage_free_kib "$TEMPLATE_STORAGE" vztmpl)
((template_free >= 524288)) || die 'Servono almeno 512 MiB liberi sullo storage template.'
required_root=$(((ROOT_GB + 1) * 1048576))
if [[ -n $RECORDINGS_STORAGE ]]; then
    recordings_free=$(storage_free_kib "$RECORDINGS_STORAGE" rootdir)
    if [[ $RECORDINGS_STORAGE == "$ROOT_STORAGE" ]]; then
        required_root=$((required_root + RECORDINGS_GB * 1048576))
    else
        ((recordings_free >= (RECORDINGS_GB + 1) * 1048576)) || die 'Spazio insufficiente sullo storage registrazioni.'
    fi
    MOUNT="${RECORDINGS_STORAGE}:${RECORDINGS_GB},mp=/recordings,backup=0"
else
    [[ $RECORDINGS_PATH == /* && $RECORDINGS_PATH != *[[:space:],]* ]] || die 'Il bind mount richiede un percorso assoluto senza spazi o virgole.'
    canonical=$(realpath -e -- "$RECORDINGS_PATH") || die 'La directory bind mount deve esistere.'
    [[ $canonical == "$RECORDINGS_PATH" && -d $canonical && ! -L $canonical ]] || die 'Usare il percorso canonico di una directory esistente, senza symlink.'
    case "$canonical" in /mnt/*|/srv/*|/media/*) ;; *) die 'Usare una directory dedicata sotto /mnt, /srv o /media.' ;; esac
    [[ $(stat -c '%u:%g' -- "$canonical") == 110001:110001 ]] || die 'La directory deve già appartenere a 110001:110001; consultare docs/proxmox.md. Lo script non cambia i permessi dei dati host.'
    directory_mode=$(stat -c '%a' -- "$canonical")
    (( (8#$directory_mode & 0700) == 0700 )) || die 'La directory archivio deve consentire lettura, scrittura e accesso al proprietario.'
    MOUNT="${canonical},mp=/recordings,backup=0"
fi
((root_free >= required_root)) || die 'Spazio insufficiente sullo storage di sistema per i volumi richiesti.'

# A guest filesystem reserve cannot protect a shared overprovisioned thin pool.
# Report current backing capacity without extending or changing host storage.
python3 - "$ROOT_STORAGE" "$ROOT_GB" "$RECORDINGS_STORAGE" "$RECORDINGS_GB" <<'THIN_POOL_PY'
"""Read-only LVM-thin report; informational warnings never prevent creation."""
import json
import math
import subprocess
import sys

GIB = 1024**3

def read(*args):
    return json.loads(subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout)

def rows(document, kind):
    return [row for report in document["report"] for row in report.get(kind, [])]

def number(value):
    value = float(str(value).strip().lstrip("<>"))
    if not math.isfinite(value) or value < 0:
        raise ValueError("Invalid LVM value")
    return value


def main(argv):
    try:
        root, root_gb, recordings, recordings_gb = argv
        requests = [(root, int(root_gb)), (recordings, int(recordings_gb))]
    except (ValueError, TypeError):
        print("Avviso: diagnostica thin pool non disponibile (argomenti non validi).")
        return
    pools = {}
    for storage, size in requests:
        if not storage:
            continue
        try:
            config = read("pvesh", "get", "/storage/" + storage, "--output-format", "json")
            if config.get("type") == "lvmthin":
                key = (config["vgname"], config["thinpool"])
                pools[key] = pools.get(key, 0) + size * GIB
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
            print(f"Avviso: diagnostica thin pool non disponibile per storage {storage}.")
    for (vg, name), requested in pools.items():
        try:
            volumes = rows(read("lvs", "--reportformat", "json", "--units", "b", "--nosuffix", "-o", "vg_name,lv_name,lv_size,segtype,pool_lv,data_percent,metadata_percent", vg), "lv")
            pool = next(row for row in volumes if row["lv_name"].strip() == name and row["vg_name"].strip() == vg and row["segtype"].strip() == "thin-pool")
            physical = number(pool["lv_size"])
            virtual = sum(number(row["lv_size"]) for row in volumes if row.get("pool_lv", "").strip() == name and row["vg_name"].strip() == vg)
            group = next(row for row in rows(read("vgs", "--reportformat", "json", "--units", "b", "--nosuffix", "-o", "vg_name,vg_free", vg), "vg") if row["vg_name"].strip() == vg)
            free = number(group["vg_free"])
            projected = virtual + requested
            print(f"Thin pool {vg}/{name}: fisico {physical/GIB:.2f} GiB; Data {str(pool.get('data_percent', '')).strip() or 'n/d'}%; Meta {str(pool.get('metadata_percent', '')).strip() or 'n/d'}%; VG libero {free/GIB:.2f} GiB.")
            print(f"Volumi virtuali attuali {virtual/GIB:.2f} GiB + nuovi {requested/GIB:.2f} GiB = {projected/GIB:.2f} GiB; spazio non riservato.")
            if projected > physical:
                print("ATTENZIONE: volumi virtuali superiori alla dimensione fisica del pool; monitorare Data% e Meta%. La riserva NVR protegge il filesystem ospite, non il pool condiviso.")
            if projected > physical + free:
                print("ATTENZIONE: totale virtuale superiore anche a pool + spazio libero VG; il VG attuale non potrebbe coprirlo interamente.")
        except (OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration, subprocess.SubprocessError):
            print(f"Avviso: diagnostica thin pool non disponibile per {vg}/{name}; nessuna modifica eseguita.")


if __name__ == "__main__":
    main(sys.argv[1:])
THIN_POOL_PY

if ((DRY_RUN == 0)); then
    pveam update
fi
TEMPLATE=$(pveam available --section system | awk -v version="$DEBIAN" '$1 == "system" && $2 ~ ("^debian-" version "([.][0-9]+)?-standard_.*_amd64[.]tar[.](zst|xz|gz)$") {print $2}' | sort -V | tail -n 1)
[[ -n $TEMPLATE ]] || die "Nessun template Debian $DEBIAN amd64 standard nel catalogo. Aggiornare con pveam update o scegliere --debian 12|13."
NET="name=eth0,bridge=${BRIDGE},ip=${IP},ip6=manual,type=veth,firewall=1"
[[ -z $GATEWAY ]] || NET+=",gw=${GATEWAY}"
printf 'Container %s (%s), Debian %s, %s core, RAM %s MiB, root %s GiB su %s\n' "$CTID" "$CT_HOSTNAME" "$DEBIAN" "$CORES" "$MEMORY" "$ROOT_GB" "$ROOT_STORAGE"
printf 'Rete: %s\nArchivio: %s\nTemplate: %s\nCodice: %s @ %s\n' "$NET" "$MOUNT" "$TEMPLATE" "$REPOSITORY" "$REF"
if ((DRY_RUN)); then
    printf 'Controlli completati. Nessun container creato e nessun download eseguito.\n'
    exit 0
fi

on_error() {
    local result=$?
    trap - ERR
    printf '\nInstallazione interrotta (codice %s).\n' "$result" >&2
    if ((CREATED)); then
        printf 'Il container %s e i volumi restano disponibili: nessuna rimozione automatica.\nDiagnostica: pct status %s; pct enter %s\n' "$CTID" "$CTID" "$CTID" >&2
    else
        printf 'Nessuna pulizia automatica: verificare in Proxmox eventuali risorse parziali per ID %s.\n' "$CTID" >&2
    fi
    exit "$result"
}
trap on_error ERR
if ! pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -Fxq "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"; then
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "$CT_HOSTNAME" --ostype debian --unprivileged 1 \
    --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
    --rootfs "${ROOT_STORAGE}:${ROOT_GB}" --mp0 "$MOUNT" \
    --net0 "$NET" --onboot 1 --start 0
CREATED=1
pct start "$CTID"

# Only the new guest is modified below. No shell text is built from user values.
pct exec "$CTID" -- bash -s -- "$REPOSITORY" "$REF" "$MIN_FREE_GB" <<'GUEST'
set -Eeuo pipefail
set +x
# Code and the venv must be readable by the service user; secrets use explicit 0600.
umask 022
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates git python3
git init --quiet /opt/nvr-sr81
git -C /opt/nvr-sr81 remote add origin "$1"
git -C /opt/nvr-sr81 fetch --depth 1 origin "$2"
git -C /opt/nvr-sr81 checkout --detach --quiet FETCH_HEAD
python3 - <<'PY'
import os
import secrets
fd = os.open('/root/nvr-initial-password', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(secrets.token_urlsafe(24) + '\n')
PY
NVR_ROOT=/opt/nvr-sr81 \
NVR_DATA_DIR=/var/lib/nvr-sr81 \
NVR_RECORDINGS_DIR=/recordings \
NVR_HOST=0.0.0.0 \
NVR_MIN_FREE_GB="$3" \
NVR_ADMIN_PASSWORD_FILE=/root/nvr-initial-password \
    bash /opt/nvr-sr81/deploy/install.sh
systemctl is-active --quiet nvr-sr81
GUEST

addresses=$(pct exec "$CTID" -- hostname -I)
printf '\nNVR-SR81 avviato nel container %s.\nIndirizzi del container: %s\nInterfaccia: http://IP-DEL-CONTAINER:8080\n' "$CTID" "$addresses"
printf 'Password amministratore iniziale (salvarla ora in un luogo sicuro): '
pct exec "$CTID" -- cat /root/nvr-initial-password
pct exec "$CTID" -- rm -- /root/nvr-initial-password
printf 'Accesso locale di amministrazione: pct enter %s\nConfigurazione servizio: /etc/nvr-sr81/environment nel container.\n' "$CTID"
