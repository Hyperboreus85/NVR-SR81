# Installazione in un container Proxmox VE

Lo script `deploy/proxmox-create.sh` si esegue **come root dalla shell del nodo Proxmox**. Crea un nuovo container LXC Debian non privilegiato e installa NVR-SR81 come servizio systemd. Non serve Docker dentro LXC. È una procedura iniziale da collaudare sul proprio nodo: sono verificati la sintassi e il messaggio di aiuto, ma questo progetto non include un ambiente Proxmox sul quale provare la creazione reale.

Servono accesso a Internet durante l'installazione, un ID libero, un bridge già configurato, uno storage per il sistema e una destinazione per le registrazioni. Lo script usa il catalogo ufficiale `pveam`, scegliendo l'ultimo template Debian standard amd64 disponibile della versione richiesta. Il funzionamento del recorder dopo l'installazione richiede soltanto la rete locale. [Comandi ufficiali pveam](https://github.com/proxmox/pve-docs/blob/master/generated/pveam.1-synopsis.adoc)

## Esempio con volume registrazioni gestito da Proxmox

Scaricare o copiare il repository sul nodo e aprire la sua directory. Verificare i nomi degli storage nella propria interfaccia Proxmox o con `pvesm status`. Nell'esempio `local-lvm` deve supportare i dischi dei container (`rootdir`) e `local` i template (`vztmpl`); sostituire i nomi secondo la propria configurazione. Lo script non sceglie automaticamente lo storage del disco di sistema. [Comandi storage ufficiali](https://github.com/proxmox/pve-docs/blob/master/generated/pvesm.1-synopsis.adoc)

```bash
bash deploy/proxmox-create.sh \
  --id 181 \
  --storage local-lvm \
  --recordings-storage local-lvm \
  --recordings-gb 500 \
  --template-storage local \
  --dry-run
```

Il controllo preliminare legge configurazione, ID, disponibilità storage, bridge e catalogo già presente; non scarica template né crea il container. Se il catalogo non è aggiornato, eseguire `pveam update` e ripetere il controllo. Quando il riepilogo è corretto, eseguire lo stesso comando togliendo `--dry-run`.

Lo script usa `umask 022` per i comandi Proxmox: le directory create sul nodo devono essere attraversabili dall'UID mappato del container durante l'estrazione del template. Una maschera `077` creerebbe cartelle `0700` di root, causando `tar: .../rootfs: Cannot open: Permission denied`. I file contenenti la password sono invece creati esplicitamente con permessi `0600` dentro il guest. Vengono controllati anche l'accesso a `/var/lib/lxc` dal namespace non privilegiato e l'eventuale presenza di una directory residua per l'ID scelto.

Il disco di sistema e il volume archivio sono separati anche se usano lo stesso storage fisico. Le dimensioni `--root-gb` e `--recordings-gb` sono in **GiB**, come richiesto da Proxmox. Per la capienza scegliere il bitrate e i giorni di conservazione descritti in [architettura](architecture.md). [Mount point e volumi gestiti Proxmox](https://github.com/proxmox/pve-docs/blob/master/pct.adoc#mount-points)

Impostazioni iniziali: Debian 12, 2 core, 4096 MiB RAM, 512 MiB swap, sistema 8 GiB, archivio 100 GiB, bridge `vmbr0`, IPv4 da DHCP e avvio automatico del container. Sono valori di partenza: non indicano quanti flussi potrà gestire l'hardware. `--debian 13` seleziona Debian 13 se supportato dal nodo e disponibile nel catalogo.

Per portare a 4 GB un container 181 già esistente, dalla Shell del nodo eseguire `pct set 181 --memory 4096`, dopo avere verificato la RAM disponibile sul nodo. La memoria assegnata si legge con `pct config 181`. L'aggiornamento dell'applicazione non cambia automaticamente la RAM del container.

Lo script non abilita il nesting. Dentro LXC l'installer omette le protezioni systemd che richiedono ulteriori mount namespace (`PrivateTmp`, `ProtectSystem`, `ProtectHome`, `ReadWritePaths`), perché possono essere rifiutate dal profilo del container. Rimangono attivi utente dedicato UID/GID 10001, `UMask=0077`, `NoNewPrivileges` e l'isolamento esterno di LXC; quindi la protezione del filesystem del servizio è inferiore rispetto all'installazione nativa, che conserva tutte quelle direttive. Se il sistema operativo del guest richiede nesting per altre unità systemd, il nodo può comunque richiedere una configurazione specifica: questo caso va collaudato, soprattutto con Debian 13. [Verifica ufficiale Proxmox per systemd e nesting](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC/Setup/Base.pm#L616)

Per una rete statica usare, ad esempio:

```bash
bash deploy/proxmox-create.sh \
  --id 181 --storage local-lvm \
  --recordings-storage local-lvm --recordings-gb 500 \
  --ip 192.168.1.81/24 --gateway 192.168.1.1
```

I nomi bridge e gli indirizzi sono esempi da adattare alla LAN. Lo script non modifica bridge o regole firewall del nodo; con firewall Proxmox attivo va consentito l'accesso alla porta TCP 8080 dalle sole reti previste. Non configura pubblicazione su Internet. [Interfacce di rete e risorse pct](https://github.com/proxmox/pve-docs/blob/master/generated/pct.1-synopsis.adoc)

## Alternativa: directory su un disco già montato dal nodo

`--recordings-path` collega una directory host esistente invece di creare un volume. Usare una directory dedicata e canonica sotto `/mnt`, `/srv` o `/media`, senza spazi o symlink. Il disco va già montato stabilmente dal sistema prima di avviare il container. Lo script non partiziona né formatta dischi e non modifica `/etc/fstab`.

Con la mappatura standard del nuovo container non privilegiato, l'utente del servizio con UID/GID `10001` corrisponde a `110001:110001` sul nodo. Per una **nuova directory vuota e dedicata** si può preparare:

```bash
install -d -m 0750 -o 110001 -g 110001 /mnt/disco-nvr/nvr-sr81
bash deploy/proxmox-create.sh \
  --id 181 --storage local-lvm \
  --recordings-path /mnt/disco-nvr/nvr-sr81
```

`/mnt/disco-nvr` deve essere il disco desiderato già montato. Prima di preparare la directory, verificare il mount e il percorso; non usare comandi ricorsivi sui dati esistenti. Lo script richiede già il proprietario corretto e non cambia i permessi dell'albero host. Se sul nodo sono presenti mappature UID personalizzate, la corrispondenza va verificata prima: lo script presuppone quella standard `100000 + UID`. [Implementazione ufficiale delle mappature LXC](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC.pm)

Un bind mount segue lo spazio libero del filesystem host: non ha la quota `--recordings-gb`, che riguarda soltanto i volumi gestiti. La riserva NVR predefinita è **5 GB decimali**, modificabile con `--min-free-gb`; è il minimo libero prima di eliminare le registrazioni più vecchie, non una quota riservata in esclusiva. Un archivio dedicato evita che la rotazione debba competere con dati di altri programmi.

### Spazio fisico di uno storage LVM thin

Le dimensioni assegnate ai dischi sono virtuali: la loro somma può superare la capacità fisica del pool. Lo script mostra dimensione del pool, utilizzo dati/metadati e dimensioni virtuali previste per gli storage `lvmthin`, segnalando l'eventuale sovra-allocazione. Il controllo iniziale dello spazio disponibile non prenota i blocchi per il futuro. La riserva di 5 GB vista dall'NVR riguarda il filesystem del guest e **non protegge il pool condiviso** se altri dischi lo riempiono. [Documentazione ufficiale LVM thin Proxmox](https://github.com/proxmox/pve-docs/blob/master/pve-storage-lvmthin.adoc)

Esempio: con un pool da 141,1 GiB e dischi esistenti da 20 e 64 GiB, aggiungere 8 GiB di sistema e 50 GiB di archivio porta il totale virtuale a 142 GiB. Un archivio da 40 GiB porta invece il totale a 132 GiB, lasciando circa 9 GiB di margine se tutti questi dischi si riempissero, prima di ulteriori volumi o snapshot. Lo spazio libero del gruppo LVM non aumenta automaticamente il pool: lo script non modifica il dimensionamento del nodo.

## Codice, password e primo accesso

Il sorgente viene prelevato da questo repository al riferimento `codex/initial-nvr`. Con `--ref` si può scegliere un tag o, per una versione riproducibile, uno specifico commit. Lo script registra nel clone il commit effettivamente installato; non effettua aggiornamenti automatici.

L'applicazione si trova in `/opt/nvr-sr81`, il suo ambiente Python in `/opt/nvr-sr81/.venv`, il catalogo in `/var/lib/nvr-sr81` e l'archivio in `/recordings`. Il servizio è `nvr-sr81`; la configurazione si trova in `/etc/nvr-sr81/environment` dentro il container.

La password amministratore viene generata **dentro il container**, salvata temporaneamente con accesso riservato a root e comunicata soltanto al termine dell'installazione riuscita. Salvare quel valore in un gestore di password ed evitare di condividere l'output finale della console. Il file temporaneo viene poi rimosso. La password dell'interfaccia non è una password root o SSH del container: per la manutenzione dal nodo usare `pct enter 181`.

Aprire `http://IP-DEL-CONTAINER:8080` dalla LAN, entrare con la password mostrata e aggiungere una telecamera RTSP oppure importare un endpoint ONVIF. Per il primo collaudo impostare un periodo breve di conservazione e verificare registrazione, audio, riavvio e riproduzione.

## Aggiornare il container esistente alla versione 0.4.0

La versione 0.4.0 aggiunge **Settings** con lingue e traduzioni e imposta l'inglese come lingua iniziale; l'italiano rimane incluso. La barra laterale usa icone con i nomi sotto. **Live monitor** mostra le telecamere in una griglia con video continuo e audio selezionabile; **Network cameras** offre ricerca ONVIF e URL dei profili. Non occorre ricreare il container o i dischi. Dalla Shell del nodo, con ID 181, scaricare ed eseguire lo script aggiornato dentro il guest (unica riga):

```bash
wget -O /tmp/nvr-sr81-update.sh https://raw.githubusercontent.com/Hyperboreus85/NVR-SR81/codex/initial-nvr/deploy/update.sh && pct push 181 /tmp/nvr-sr81-update.sh /tmp/nvr-sr81-update.sh && pct exec 181 -- bash /tmp/nvr-sr81-update.sh
```

Lo script verifica il checkout e prepara vecchio pacchetto, nuovo pacchetto e dipendenze prima di fermare il servizio. Installa poi dai file già scaricati e riavvia l'NVR. Durante il breve riavvio la registrazione si interrompe. Conserva ambiente, password, database, chiave e video; se installazione o verifica di avvio falliscono, tenta il ripristino del pacchetto precedente. La versione 0.3.0 aggiunge il supporto WebSocket: usare questo script aggiornato per installare anche le nuove dipendenze. Se ci sono modifiche locali ai file tracciati, lo script si ferma per consentire di conservarle.

Al termine ricaricare completamente la pagina web. La prima apertura usa l'inglese: per l'italiano scegliere **Settings → Languages → Italiano**, oppure il selettore nella pagina di accesso. Per le personalizzazioni, vedere [guida impostazioni](settings.md). Per griglia, browser e scelta del sottostream, vedere [guida Monitor live](live.md); per ricerca, profili e rete del container, vedere [guida discovery](discovery.md). Per impostare una revisione precisa si può passarla come primo argomento allo script `update.sh`.

## Errori, backup e manutenzione

Un ID occupato viene rifiutato e non viene sostituito. Lo script non esegue rimozioni automatiche in caso di errore. Il comando Proxmox `pct create` può però annullare la propria creazione incompleta, rimuovendo i volumi appena allocati e la configurazione del nuovo guest. Possono rimanere cartelle vuote sul nodo. Se invece il container risulta creato, viene conservato per consentire l'analisi: ripetere la creazione con lo stesso ID fallirà intenzionalmente.

Se l'estrazione si è fermata con `Permission denied`, verificare dalla Shell del nodo (unica riga):

```bash
bash -c 'pct status 181; namei -l /var/lib/lxc/181/rootfs'
```

Se la configurazione 181 non esiste, il log conferma la rimozione dei nuovi volumi e rimangono soltanto le directory vuote del tentativo, si possono rimuovere **solo queste due directory**:

```bash
rmdir -- /var/lib/lxc/181/rootfs /var/lib/lxc/181
```

`rmdir` si rifiuta di rimuovere directory non vuote, symlink e mount attivi. Se fallisce, fermarsi e controllare il contenuto anziché usare una rimozione ricorsiva o modificare i permessi dell'intero albero. Sostituire `181` solo con l'ID effettivamente usato nel tentativo fallito e verificato libero. Scaricare poi lo script aggiornato e ripetere prima il controllo `--dry-run`.

Dal nodo, per controllare un'installazione interrotta:

```bash
pct status 181
pct enter 181
```

Dentro il container:

```bash
systemctl status nvr-sr81
journalctl -u nvr-sr81 -n 100 --no-pager
df -h / /recordings
```

La rimozione volontaria va eseguita dalla GUI Proxmox dopo aver verificato ID e dati: i volumi gestiti associati al container possono essere eliminati con il guest. Un bind mount richiede la gestione separata dei dati host. La rotazione dell'archivio continua a eliminare i video più vecchi secondo i limiti configurati; salvare altrove gli spezzoni da conservare.

Il mount delle registrazioni viene creato con `backup=0`: **i video non sono inclusi nel normale backup del container**. Anche i bind mount richiedono backup indipendenti. Prevedere una copia protetta della configurazione e del catalogo, più una politica separata per i filmati da conservare. Una VM o un container con disco di sistema vuoto dopo un guasto non ricostruisce automaticamente l'indice di tutti gli archivi: il ripristino va provato con i dati della propria installazione.

L'accesso a Internet durante l'installazione serve a template, pacchetti Linux, dipendenze Python e codice. Dopo il collaudo si possono limitare le uscite in rete mantenendo DNS e ora locali se necessari. Aggiornamenti del sistema e del progetto restano operazioni manuali da pianificare.
