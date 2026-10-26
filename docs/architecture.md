# Architettura di NVR-SR81

L'obiettivo è un registratore locale: telecamere nella LAN, registrazione continua, consultazione dal browser e dischi sotto il controllo dell'utente. Questa prima versione è una base da collaudare con le telecamere reali; non è ancora un sistema sul quale affidare l'unica copia di una registrazione importante.

## Linguaggio e componenti

La scelta è **Python con FastAPI**, con interfaccia HTML/CSS/JavaScript servita dallo stesso processo. Python gestisce configurazione, API, catalogo, supervisione dei processi e analisi audio. La parte video resta a FFmpeg, quindi Python non decodifica ogni fotogramma per registrare. Questo riduce il lavoro da implementare e permette future estensioni di analisi senza obbligare a introdurle adesso. FastAPI fornisce API asincrone, validazione e gestione delle risorse del servizio. [Documentazione FastAPI](https://fastapi.tiangolo.com/)

SQLite conserva configurazione e indice delle registrazioni; i video sono file sul disco, non oggetti nel database. È adatto a un'installazione singola e non richiede un servizio database separato. Il database deve risiedere su un filesystem locale affidabile; più istanze attive sullo stesso archivio richiederebbero un'architettura diversa. [Usi previsti di SQLite](https://sqlite.org/whentouse.html)

```mermaid
flowchart LR
    C[Telecamera RTSP] --> F[FFmpeg: copia dei flussi]
    O[Discovery ONVIF o endpoint manuale] --> A[API FastAPI]
    A --> F
    F --> D[Segmenti MKV sul disco]
    A --> S[SQLite: configurazione e indice]
    D --> P[FFmpeg: MP4 e dati audio su richiesta]
    P --> B[Browser nella LAN]
    B --> A
```

## Acquisizione e ONVIF

Il flusso registrato arriva via **RTSP**. ONVIF è usato per richiedere alla telecamera i profili e il relativo indirizzo RTSP; non è un contenitore video alternativo.

L'importazione parte da un endpoint inserito manualmente, ad esempio `http://192.168.1.50/onvif/device_service`, e da credenziali dedicate. Il client usa `GetServices`, con ripiego su `GetCapabilities`, poi `GetProfiles` e `GetStreamUri`. Preferisce Media2, utile anche per i profili H.265, e prova Media1 come alternativa. È possibile fornire direttamente l'endpoint Media. Non scarica WSDL o schemi da Internet. HTTP Digest e WS-Security PasswordDigest sono supportati; l'orologio della telecamera deve essere sufficientemente allineato a quello del server. [WSDL ufficiale Media1](https://github.com/onvif/specs/blob/development/wsdl/ver10/media/wsdl/media.wsdl), [WSDL ufficiale Media2](https://github.com/onvif/specs/blob/development/wsdl/ver20/media/wsdl/media.wsdl), [UsernameToken OASIS](https://docs.oasis-open.org/wss-m/wss/v1.1.1/os/wss-UsernameTokenProfile-v1.1.1-os.html)

Il risultato è una lista di profili con nome, codec dichiarato e URL. Gli indirizzi non specificati `0.0.0.0` o `::` vengono sostituiti con l'host dell'endpoint; le credenziali vengono aggiunte all'URI RTSP quando mancano, codificando i caratteri speciali. Un URI che contiene credenziali è un segreto e va trattato come tale.

La versione 0.2.0 include **discovery IPv4 WS-Discovery ed esplorazione dei profili ONVIF Media1/Media2**, oltre all'endpoint manuale. Un fallback esplicito verifica il servizio ONVIF su sottoreti private fino a /24. I profili mantengono nome/token e metadati originali; i suggerimenti main/sub sono calcolati per sorgente video e non configurano la telecamera. Non è una dichiarazione di piena conformità ONVIF: restano esclusi PTZ, gestione utenti, eventi e modifica dei codec. Alcuni produttori richiedono l'attivazione di ONVIF o un account specifico; rimane disponibile l'inserimento diretto dell'URL RTSP. [Guida discovery](discovery.md)

## Registrazione originale e riproduzione web

FFmpeg registra il video H.264 o H.265 con **copia dei pacchetti**, senza ricodificarlo, e conserva l'audio sorgente se presente e compatibile con il contenitore Matroska. Il formato MKV evita di imporre AAC alle telecamere che forniscono altri codec audio. Un codec non gestito dalla build FFmpeg o dal contenitore richiede un adattamento esplicito e una prova con quel modello.

L'archivio usa file con durata globale configurabile da **1 a 120 minuti** in **Settings → Recording**: 1, 2, 3, 4, 5 minuti, poi passi di 5 minuti. **30 minuti** è il valore predefinito e consigliato dal progetto. La preferenza viene salvata nei metadati SQLite e prevale sul valore iniziale `NVR_SEGMENT_SECONDS` anche dopo un riavvio. Salvando una nuova durata, i writer finalizzano i file correnti e ripartono con il nuovo valore, senza riavviare il servizio o modificare i file già chiusi.

La copia dei flussi conserva i keyframe della telecamera. FFmpeg apre il segmento successivo al keyframe utile, quindi la durata reale è approssimativa e dipende dal GOP; un cambio di durata, un arresto o un'interruzione del flusso può produrre file più corti. Il file in corso viene indicizzato dopo la chiusura; lo stato di registrazione viene invece aggiornato quando FFmpeg inizia a scrivere. [Segmentazione FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#segment_002c-stream_005fsegment_002c-ssegment)

Per il browser si genera una copia **MP4 H.264/AAC su richiesta**. L'originale MKV rimane l'archivio: la conversione per la consultazione richiede CPU, tempo e spazio per la cache. HEVC/H.265 non ha una compatibilità uniforme tra browser, sistemi e hardware; anche H.264 può richiedere conversione per profili o formati pixel particolari. La riproduzione va verificata sui dispositivi client scelti. [Guida codec del browser Mozilla](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)

La durata è un compromesso operativo: file lunghi riducono il numero di segmenti ma ritardano la consultazione del file aperto e aumentano il lavoro per MP4, audio e movimento. Con 120 minuti l'attesa può arrivare a circa due ore; a 4 Mbit/s il solo video di quel file vale circa 3,6 GB. La generazione MP4 usata dal lettore impiega anche `faststart`, che sposta l'indice con un passaggio ulteriore: il costo della preparazione va misurato sui file reali. La raccomandazione di 30 minuti riguarda questo progetto e non è un valore ottimale universale. [Muxer MP4 e faststart di FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)

La cache può essere collocata con `NVR_CACHE_DIR`: quando omesso l'applicazione usa `NVR_DATA_DIR/cache`, mentre le nuove installazioni con l'installer nativo e Compose scelgono una `.cache` sul volume dell'archivio. Il budget di circa 2 GiB è morbido e consente il più recente MP4 anche quando supera quel valore; una richiesta HTTP attiva protegge il proprio file dalla pulizia. La preparazione verifica lo spazio prima e durante il lavoro, interrompendo il processo e rimuovendo il temporaneo quando la riserva non è sufficiente. Spostare il percorso non trasferisce né elimina i vecchi file di cache.

**Live → Monitor** offre video continuo con audio facoltativo: un processo FFmpeg condiviso per telecamera/modalità emette MP4 frammentato su WebSocket autenticato e il browser lo riproduce con MSE. Il flusso secondario è preferito per il monitor; la registrazione originale resta indipendente. Le conversioni video H.264 sono limitate separatamente quando il client non supporta il codec originale. Non è richiesto un gateway esterno; WebRTC e accelerazione hardware restano possibili estensioni. Le API delle anteprime JPEG rimangono disponibili per compatibilità. [Guida monitor live](live.md)

**Record → Archive** riunisce ricerca, riproduzione, forma d'onda e movimento sotto il video, elenco dei file e timeline dell'intervallo. Le miniature provengono dai file originali e vengono conservate nella cache con una chiave basata su identità, dimensione e modifica della sorgente; non usano l'immagine live. La generazione decodifica un solo fotogramma da 192×108 pixel con un thread, limite di 256 KiB e 15 secondi, al massimo un lavoro alla volta e rispettando la capacità condivisa delle conversioni. La sorgente rimane protetta dalla conservazione durante il lavoro. Il browser carica le immagini dell'elenco in modo differito. [Guida archivio](recordings.md)

L'accesso apre **Live → Monitor**. La pagina **Live → Layout** prepara una disposizione di 1, 4, 9 o 16 riquadri, con assegnazione tramite trascinamento o selettori; il salvataggio conserva identificativi e posizioni nella memoria del browser per l'indirizzo dell'NVR. La disposizione non cambia quella degli altri browser e non contiene credenziali dei flussi. Il Monitor apre solo le telecamere assegnate ai riquadri visibili e libera le dirette quando si passa al Layout o a un'altra sezione, mentre la registrazione continua sul server.

## Ricerca temporale e forma d'onda

Il catalogo conserva i tempi in **UTC** e il browser mostra data e ora nel fuso scelto per il recorder, rendendo più chiari anche i cambi fra ora solare e legale. L'indice usa i tempi dei segmenti rilevati dal server: orologi sincronizzati nella LAN sono necessari per correlare più telecamere, e questa base non promette una sincronizzazione forense al fotogramma.

La forma d'onda sotto il lettore si calcola decodificando solo l'audio e riassumendo i **picchi di ampiezza** in finestre temporali. I dati compatti vengono disegnati e cliccati per spostare il punto di riproduzione. Non serve un modello di intelligenza artificiale. Un picco è un indizio da ascoltare, non il riconoscimento di uno sparo, di una voce o di uno specifico evento. Se non esiste una traccia audio, l'interfaccia lo segnala.

## Dischi e dimensionamento

Il parametro più utile è il **bitrate medio effettivo**, misurato sulle telecamere. Risoluzione e codec da soli non bastano a calcolare lo spazio.

```text
GB al giorno = somma bitrate medi in Mbit/s × 10,8
GB necessari = GB al giorno × giorni di conservazione
```

Il fattore deriva da `1.000.000 bit/s ÷ 8 × 86.400 s = 10,8 GB/giorno`, con GB decimali. Esempio di pianificazione, non misura del software: 4 telecamere a 4 Mbit/s richiedono circa 172,8 GB/giorno, quindi 2.419,2 GB per 14 giorni. Aggiungere audio, contenitori, database, cache di consultazione, variazioni del bitrate e spazio libero operativo. La banda di acquisizione dell'esempio è circa 16 Mbit/s, prima degli altri flussi di rete.

Per l'uso continuo è preferibile un disco dedicato alle registrazioni; un SSD può ospitare sistema, indice e cache. La conservazione automatica elimina le registrazioni più vecchie secondo i limiti impostati. La prima versione usa una radice di archivio: più dischi possono essere presentati dal sistema operativo come un volume, oppure il supporto a più destinazioni dovrà essere aggiunto in seguito. Un backup separato riguarda soprattutto configurazione e spezzoni da conservare oltre la normale rotazione.

## Ubuntu, Debian, Proxmox e Raspberry Pi

Il percorso iniziale è Linux: Ubuntu o Debian su PC, VM oppure container LXC Proxmox. In LXC l'archivio va montato dal nodo con un **bind mount**, verificando proprietario, UID/GID e permessi del processo; i dati del bind mount richiedono una strategia di backup esplicita. L'installazione diretta nel container evita di introdurre anche un secondo livello di containerizzazione. [Documentazione ufficiale Proxmox sui mount point](https://pve.proxmox.com/pve-docs/pve-admin-guide.html#pct_mount_points)

Un Raspberry Pi con sistema **ARM64**, rete cablata e disco USB adeguato è una possibile piattaforma da collaudare. Non viene promesso un numero di canali: incidono bitrate, disco, alimentazione, dissipazione, anteprime contemporanee e conversione per il browser. La registrazione con copia dei flussi pesa molto meno della ricodifica; la conversione H.265 → H.264 è il carico da misurare per primo su hardware piccolo. L'accelerazione hardware non è richiesta dal primo rilascio né configurata automaticamente.

## Funzionamento locale ed evoluzione

Dopo avere installato pacchetti e dipendenze, il servizio e gli elementi dell'interfaccia sono locali: nessun account cloud, CDN o chiamata a un servizio di analisi è necessario. Le richieste di acquisizione e importazione vanno agli indirizzi configurati. Per garantire l'isolamento anche delle telecamere e del sistema operativo, la rete deve bloccare le connessioni verso Internet e usare, se necessario, DNS e sincronizzazione oraria locali.

Il collaudo deve includere riconnessione dopo caduta della rete, riavvio del servizio, esaurimento spazio, conservazione, audio e consultazione simultanea alla registrazione. I test automatici delle API e delle risposte ONVIF simulate non sostituiscono una prova continuativa con hardware reale.

La consultazione include una traccia di movimento senza AI, calcolata per il video archiviato selezionato mediante differenze fra immagini e conservata nella cache locale. Gli sviluppi successivi sono separabili: ulteriori ottimizzazioni live/WebRTC e accelerazione hardware, maschere ed eventi di movimento in diretta; infine un motore AI opzionale in un processo dedicato. Un futuro adattatore YOLO o altro modello dovrebbe consumare il sottoflusso a frequenza ridotta e scrivere metadati nell'indice, lasciando la registrazione continua indipendente dal suo stato. Modello, licenza e hardware si sceglieranno quando ci sarà un requisito concreto.

## Utenze locali

L'account iniziale `admin` conserva la password precedente. Utenti, hash e assegnazioni sono nel database locale. Le API verificano permessi e ambito delle telecamere anche per richieste dirette e WebSocket; modifica o disabilitazione di un'utenza ne invalida le sessioni. Le dirette aperte ricontrollano l'autorizzazione ogni 15 secondi. Le preferenze Live nel browser sono separate per account. [Gestione utenti e password](users.md).
