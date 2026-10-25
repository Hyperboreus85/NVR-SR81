# NVR-SR81

NVR locale per Linux: registra continuamente flussi RTSP H.264/H.265 e permette di consultarli dal browser. Nessun account cloud, telemetria, CDN, riconoscimento facciale o motore AI. **Versione sperimentale 0.11.0:** da collaudare con le proprie telecamere prima di affidarle registrazioni importanti.

## Scelte tecniche

- **Python + FastAPI:** configurazione, autenticazione, API e supervisione.
- **FFmpeg/FFprobe:** registrazione e analisi multimediale; Python non ricomprime i fotogrammi durante la registrazione.
- **SQLite:** indice temporale locale; video su un disco/percorso separato.
- **HTML/CSS/JavaScript senza dipendenze esterne:** interfaccia web disponibile anche senza Internet.

Il flusso originale viene copiato in file **Matroska/MKV con durata da 1 a 120 minuti**, configurabile in **Settings → Recording**. Il valore predefinito e consigliato dal progetto è **30 minuti** (`1800` secondi). MKV conserva anche audio delle telecamere come G.711. Il taglio avviene al primo keyframe utile, quindi la durata reale è approssimativa; interruzioni del flusso o cambi di durata possono produrre file più corti. Il segmento aperto diventa consultabile dopo la chiusura; lo stato segnala la registrazione appena FFmpeg inizia a scrivere. Con file da 120 minuti, l'attesa per consultare il segmento in corso può quindi arrivare a circa due ore. Impostare un intervallo dei keyframe di 1–2 secondi sulla telecamera, quando possibile.

## Funzioni presenti

- Login amministratore locale; password salvata con scrypt e sessione HttpOnly.
- Interfaccia inglese predefinita e italiano incluso, selezionabili anche prima del login. Barra laterale con icone sopra ai nomi, ispirata al layout M777.
- **Settings / Impostazioni** con sezioni General, Recording e Languages: layout del monitor per browser, durata globale dei file e gestione di **pacchetti lingua JSON installabili**. Recording offre 1, 2, 3, 4, 5 minuti e poi intervalli di 5 minuti fino a 120. Salvando, i file correnti vengono chiusi e la nuova durata entra in uso senza riavviare il servizio; i file precedenti restano invariati. La scelta è conservata nel database e vale per tutte le telecamere e i browser. Scelta della lingua, installazione, download dei modelli e rimozione dei file sono tutti nella pagina Languages. [Guida impostazioni e pacchetti lingua](docs/settings.md).
- Configurazione telecamera con protocollo, IP/hostname, porta, utente e password separati, oppure URL completo. Fino a tre flussi Main/Sub/Third: Main registra, il Live usa il flusso scelto per la telecamera. Credenziali e percorsi salvati rimangono protetti e si conservano lasciando vuoti i rispettivi campi. [Guida telecamere e flussi](docs/cameras.md).
- Sezione **Telecamere in rete** con discovery ONVIF multicast, selezione della scheda di rete e ricerca opzionale su sottoreti private fino a /24.
- Esplorazione dei profili ONVIF Media1/Media2: informazioni del dispositivo, risoluzione, codec, fps, bitrate e URL RTSP di tutti i profili disponibili. Copia singola o completa, con utente/password opzionali.
- Scelta dei profili principale e secondario per configurare registrazione e anteprima; nomi originali conservati e suggerimenti basati sui metadati per ciascuna sorgente video.
- Registrazione continua senza ricodifica, audio opzionale, riconnessione automatica e stato per telecamera.
- **Live → Monitor** come pagina iniziale, con video continuo, griglie da 1/4/9/16 riquadri, schermo intero, audio su una camera per volta e riconnessione indipendente. **Live → Layout** dispone le telecamere con trascinamento o selettori, conserva gli spazi vuoti e salva la disposizione nel browser. La navigazione usa sfondo grigio scuro, accenti ciano brillanti e dettagli oro, logo SR81 compatto, icone a sinistra e sottomenu nella barra superiore. La voce **Cameras** raccoglie le configurazioni. Usa il sottostream quando disponibile, condividendo il processo video fra gli spettatori. [Guida monitor live](docs/live.md).
- **Record / Registrazioni** con filtri telecamera, data e orari Da/A, anche attraverso mezzanotte; elenco con miniature reali dei file, video con controlli dedicati e timeline che conserva i vuoti dell'archivio. Audio e movimento seguono la posizione e la durata effettiva del filmato selezionato. Download dell'originale, senza modificarlo. [Guida alle registrazioni](docs/recordings.md).
- MP4 per il browser: copia video originale e conversione audio in AAC. Se H.265 non è supportato, modalità compatibile su richiesta con conversione H.264, più onerosa per la CPU.
- Forma d'onda da campioni audio reali, calcolata su richiesta e conservata in cache; clic per spostarsi nel video. L'assenza di audio è indicata, senza inventare dati.
- Traccia di movimento senza AI sotto l'audio: analizza automaticamente la registrazione completata selezionata, con intervalli cliccabili, precedente/successivo e sensibilità bassa/media/alta. Risultati in cache locale; luce, pioggia e vegetazione possono generare indicazioni. Il primo calcolo usa CPU, senza modificare la registrazione continua. [Guida agli indizi di movimento](docs/motion.md).
- Conservazione per giorni e rimozione dei segmenti chiusi più vecchi quando lo spazio libero scende sotto la riserva configurata. Se lo spazio resta insufficiente, la registrazione si sospende e riprende quando torna disponibile.
- Recupero all'avvio dell'indice dei segmenti chiusi, credenziali dei flussi cifrate su disco con chiave locale.

## Avvio rapido con Docker Compose

Serve Docker con Compose e un disco già montato sul sistema Linux. Dalla directory del progetto:

```bash
cp .env.example .env
nano .env
# Inserire NVR_ADMIN_PASSWORD (minimo 12 caratteri).
# Per accesso dalla LAN: NVR_BIND_IP=IP_PRIVATO_DEL_SERVER
# Per un disco montato: NVR_RECORDINGS_PATH=/srv/video/nvr-sr81
mkdir -p recordings
sudo chown 10001:10001 recordings
docker compose up -d --build
```

Se si usa un altro percorso, creare una sottodirectory dedicata sul disco delle registrazioni e assegnarla a UID/GID 10001. Non cambiare ricorsivamente il proprietario di dischi o cartelle condivise. Aprire `http://IP_PRIVATO_DEL_SERVER:8080`. La configurazione predefinita pubblica solo su `127.0.0.1`; indicare l'IP privato in `.env` per accedere da altri computer.

Il primo build scarica pacchetti: dopo l'installazione il funzionamento è locale. Per una rete completamente isolata, preparare e trasferire l'immagine Docker su una macchina connessa, poi usare `docker save` / `docker load`. Nessun controllo licenze online o server STUN/TURN.

## Ubuntu / Debian senza Docker

Python **3.11 o successivo**, FFmpeg e FFprobe nel PATH:

```bash
sudo apt-get update
sudo apt-get install python3-venv ffmpeg
python3 -m venv .venv
. .venv/bin/activate
pip install .
export NVR_ADMIN_PASSWORD='scegli-una-password-lunga-e-unica'
export NVR_HOST=0.0.0.0
export NVR_RECORDINGS_DIR=/percorso/dedicato/registrazioni
nvr-sr81
```

Per un servizio che si avvia automaticamente, mettere il checkout in `/opt/nvr-sr81` e lanciare:

```bash
sudo bash /opt/nvr-sr81/deploy/install.sh
sudo cat /root/nvr-initial-password
```

L'installer crea l'utente `nvr-sr81` (UID 10001), una virtualenv, il servizio systemd e una password casuale. Richiede Internet per installare i pacchetti. Impostazioni in `/etc/nvr-sr81/environment`; riavviare con `sudo systemctl restart nvr-sr81`. Il percorso delle registrazioni si sceglie al primo avvio dell'installer con `sudo NVR_RECORDINGS_DIR=/disco/nvr bash deploy/install.sh`.

**Proxmox:** istruzioni e script in [docs/proxmox.md](docs/proxmox.md). Per LXC consigliamo l'installazione nativa: non richiede Docker annidato né container privilegiato. Raspberry Pi: sistema Linux ARM64 e disco USB/SSD dedicato; dimensionare con prove reali, soprattutto anteprime e conversioni H.265.

## Aggiungere una telecamera

1. Aprire l'interfaccia, accedere con la password locale e scegliere **Aggiungi telecamera**.
2. Inserire il flusso, per esempio `rtsp://utente:password@192.168.1.20:554/percorso` (il percorso dipende dal produttore). Codificare i caratteri riservati di username/password nell'URL.
3. Se disponibile, inserire un sottostream H.264 per l'anteprima. Il flusso principale H.265 resta quello registrato.
4. In alternativa, aprire **Telecamere in rete**, cercare dispositivi ONVIF e leggere i loro profili. Si può anche indicare un endpoint manuale, spesso `http://IP:PORTA/onvif/device_service`. Serve che ONVIF sia abilitato sulla camera e che gli orologi siano sincronizzati.
5. Scegliere conservazione e audio; salvare e verificare lo stato dopo la chiusura del primo segmento.

ONVIF è usato per trovare i dispositivi, leggere i profili e gli URL di streaming, non è un formato video. Questa versione non implementa PTZ, eventi o tutti i requisiti di conformità ONVIF. La ricerca IPv4 multicast riguarda la LAN del server e può essere filtrata da firewall/VLAN; restano disponibili ricerca per sottorete ed endpoint manuale. I dispositivi che rifiutano le chiamate possono comunque essere aggiunti tramite RTSP. I flussi HTTP annidati che richiedono protocolli non autorizzati (ad esempio playlist con file locali) sono rifiutati. [Guida a discovery e flussi](docs/discovery.md).

## Aggiornare un'installazione esistente

Sul container già installato, il nuovo `deploy/update.sh` prepara pacchetto e dipendenze mentre la registrazione continua, riavvia brevemente il servizio e conserva configurazione e archivio. La versione 0.3.0 aggiunge il supporto WebSocket: usare lo script aggiornato, che scarica prima dell'arresto le dipendenze necessarie. L'aggiornamento richiede un checkout Git senza modifiche locali ai file tracciati e conserva un pacchetto per il ripristino in caso di errore.

```bash
# Dentro il container, come root; dopo avere scaricato il nuovo script:
bash /opt/nvr-sr81/deploy/update.sh
```

Il file deve essere della nuova versione: una precedente installazione non lo contiene. La [guida Proxmox](docs/proxmox.md) spiega come scaricarlo ed eseguirlo dalla Shell del nodo senza ricreare il container.

## Dati, spazio e tempo

`NVR_DATA_DIR` contiene database, durata globale salvata, hash password e `credentials.key`. `NVR_RECORDINGS_DIR` contiene gli originali, separati per ID telecamera. `NVR_CACHE_DIR` sceglie dove tenere MP4 e dati di consultazione: le nuove installazioni con l'installer nativo e Compose usano la sottodirectory `.cache` dell'archivio. Fare backup **del database insieme alla chiave**: senza chiave gli URL cifrati non sono recuperabili. La durata scelta nell'interfaccia sopravvive ai riavvii e prevale sul valore iniziale `NVR_SEGMENT_SECONDS`. La chiave è sullo stesso host: protegge il database copiato da solo, non un attaccante con accesso completo al server.

I timestamp sono UTC nel database e orari locali nel browser. Sincronizzare host e telecamere usando NTP locale. La timeline è ricostruita dalla ricezione dei flussi sul server; non sostituisce una sincronizzazione forense del timestamp della camera. Dopo un crash un segmento incompleto può richiedere recupero manuale; i precedenti restano indipendenti.

Stima dello spazio: **1 Mbit/s ≈ 10,8 GB al giorno** (unità decimali), prima di audio e overhead. Esempio: 8 telecamere × 4 Mbit/s × 14 giorni ≈ **4,84 TB**, più margine e spazio libero. Riserva predefinita: 5 GB. La conservazione è un massimo, non una garanzia se il disco è più piccolo del necessario. La rimozione di una telecamera conserva i file esistenti, ai quali si applica una conservazione predefinita di 7 giorni e la riserva disco.

| Variabile | Valore predefinito | Uso |
|---|---|---|
| `NVR_HOST` | `127.0.0.1` | Indirizzo di ascolto, `0.0.0.0` nel container |
| `NVR_PORT` | `8080` | Porta web |
| `NVR_DATA_DIR` | `./data` | Configurazione e indice |
| `NVR_RECORDINGS_DIR` | `./recordings` | Archivio originale |
| `NVR_CACHE_DIR` | `NVR_DATA_DIR/cache` se omesso | Copie e dati di consultazione; installer e Compose nuovi scelgono la `.cache` dell'archivio |
| `NVR_SEGMENT_SECONDS` | `1800` | Durata iniziale in secondi, da 60 a 7200; sostituita dalla scelta salvata in Settings → Recording |
| `NVR_MIN_FREE_GB` | `5` | Riserva sul disco archivio, GB decimali |
| `NVR_ADMIN_PASSWORD` | richiesta al primo avvio | Imposta/aggiorna la password all'avvio |
| `NVR_SECURE_COOKIE` | `0` | Usare `1` con HTTPS locale |
| `NVR_LIVE_MAX_STREAMS` | `16` | Massimo processi live condivisi, da 1 a 32 |
| `NVR_LIVE_MAX_TRANSCODES` | `2` | Conversioni live H.264 contemporanee, da 0 a 4 |
| `NVR_FFMPEG`, `NVR_FFPROBE` | nomi nel PATH | Percorsi eseguibili |

Un solo processo/istanza per archivio. Limite iniziale dell'interfaccia: 32 configurazioni, **non una promessa di capacità hardware**. La cache usa un budget morbido di circa 2 GiB e una conservazione di un giorno: il più recente MP4 può superare il budget per consentire la consultazione dei file lunghi, mentre i file serviti a una richiesta attiva sono protetti dalla pulizia. Le conversioni sono limitate; se lo spazio libero non basta, la preparazione viene fermata e i file temporanei rimossi. La ricerca API restituisce fino a 2.000 segmenti per intervallo: selezionare una telecamera o ridurre l'intervallo se si raggiunge il limite.

File più lunghi riducono il numero di segmenti, ma aumentano l'attesa per consultarli e il lavoro per preparare MP4, audio e movimento. A 4 Mbit/s, due ore valgono circa **3,6 GB** di solo video: serve spazio anche per la copia di consultazione. Cambiare durata non riduce il volume giornaliero del flusso originale. Per un punto di partenza equilibrato consigliamo 30 minuti; valutare tempi e spazio sul proprio hardware. [Scelta della durata](docs/settings.md#durata-dei-file-di-registrazione).

Per file lunghi consigliamo una cache sul disco delle registrazioni, con spazio libero adeguato. Un aggiornamento conserva il percorso configurato; impostare `NVR_CACHE_DIR` nel file ambiente del servizio e riavviarlo per cambiare percorso. La vecchia cache resta al suo posto e non viene trasferita o cancellata automaticamente.

## Accesso locale

Usare una LAN fidata o VLAN dedicata, senza port forwarding. L'app contatta solo gli URL delle telecamere inserite: per imporre l'assenza di traffico Internet, bloccare l'uscita WAN del container e delle telecamere sul firewall, lasciando consentiti LAN e NTP/DNS locali. Una rete bridge non esclude automaticamente l'accesso a Internet.

HTTP locale non cifra il traffico tra browser e server: su reti condivise usare un reverse proxy HTTPS locale e `NVR_SECURE_COOKIE=1`. L'app non richiede accesso pubblico. Le credenziali dei flussi non vengono ripubblicate nella lista telecamere o nei log FFmpeg. L'importazione ONVIF restituisce temporaneamente l'URL al browser dell'amministratore per selezionarlo. Gli URL passati a FFmpeg sono visibili agli amministratori del sistema attraverso i processi.

## Test e sviluppo

```bash
pip install '.[test]'
python -m pytest -q
bash -n deploy/install.sh
bash -n deploy/proxmox-create.sh
bash -n deploy/update.sh
```

I test multimediali usano FFmpeg/FFprobe e sorgenti sintetiche locali; i test ONVIF usano risposte simulate. Per includere anche il test RTSP con interruzione e ripresa, impostare `NVR_TEST_RTSP_SERVER` sul percorso di MediaMTX: la CI scarica la versione ufficiale 1.21.2 e lo esegue su Ubuntu. Sono comunque necessari un test prolungato con le telecamere vere e prove su LXC/Raspberry: perdita di rete, riavvio, disco pieno e riproduzione sul proprio browser.

## Evoluzione

1. Pilotaggio con telecamere reali, misura di CPU/rete/disco, test di durata e disconnessione.
2. Ulteriori ottimizzazioni live e accelerazione hardware; estensione della timeline e esportazione intervalli.
3. Estensione degli indizi di movimento registrato con maschere, eventi ONVIF o analisi live opzionale, come metadati separati dalle registrazioni.
4. Eventuale worker AI opzionale, ad esempio YOLO, sul sottostream: non deve bloccare il registratore.

Dettagli e fonti ufficiali: [docs/architecture.md](docs/architecture.md). Licenza GPL-3.0, vedere [LICENSE](LICENSE).
