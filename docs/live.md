# Monitor live delle telecamere

La versione 0.3.0 aggiunge **Monitor live**, una vista a griglia delle telecamere già configurate. Il monitor riproduce video continuo; la piccola anteprima a 2 fps della scheda Registratore rimane disponibile separatamente.

## Uso della schermata

1. Aprire **Monitor live** dalla barra laterale dell'NVR.
2. Scegliere il layout da 1, 4, 9 o 16 riquadri. Con più telecamere, cambiare pagina per vedere le altre.
3. Aprire una telecamera a schermo intero per controllare un dettaglio, oppure passare alla sua scheda Registratore.
4. L'audio parte disattivato. Attivarlo sulla telecamera da ascoltare: le altre restano silenziose. Se manca una traccia audio, il monitor lo indica.
5. Usare pausa/ripresa per chiudere o riaprire le dirette. Cambiando sezione o pagina e lasciando la scheda del browser in secondo piano, le risorse dei riquadri vengono liberate; la registrazione prosegue indipendentemente.

Sono elencate tutte le telecamere configurate, comprese quelle con registrazione sospesa. Una telecamera offline mostra il proprio stato e viene ritentata senza bloccare le altre. REC/pausa riguarda la registrazione; lo stato della diretta riguarda il lettore.

## Flusso principale e sottostream

Il monitor legge prima il **flusso secondario per anteprima**, se salvato nella configurazione della telecamera, altrimenti il principale. La registrazione mantiene la propria sorgente originale.

Per il container con 2 core e **4 GB RAM**, usare preferibilmente un sottostream **H.264 a risoluzione e bitrate contenuti**. Si può conservare il main H.265 per registrare e scegliere il sub H.264 della stessa sorgente in **Telecamere in rete**. La capacità effettiva dipende da telecamere, bitrate, browser e hardware; il layout da quattro riquadri è un punto di partenza per il collaudo. Più RAM aiuta i buffer e i processi, ma non sostituisce la CPU necessaria a ricodificare.

La modalità normale copia il video H.264/H.265 senza ricodifica e prepara audio AAC se presente e abilitato. Più spettatori della stessa telecamera e modalità condividono un processo live. Le connessioni sono aperte solo su richiesta, le code sono limitate e le dirette non vengono archiviate una seconda volta su disco.

## Trasporto e browser

Il video arriva in **MP4 frammentato via WebSocket autenticato** e viene riprodotto con **Media Source Extensions (MSE)**. Il canale usa lo stesso indirizzo e la stessa porta web dell'NVR, con cookie di sessione e controllo dell'origine. Non servono account cloud, CDN, nuove porte WebRTC o un gateway video separato. [MSE, Mozilla](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API), [MP4 frammentato, FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)

WebSocket permette alle griglie con più riquadri di non occupare tutti i normali collegamenti HTTP/1.1 disponibili al browser. Le API di configurazione restano accessibili mentre i video sono aperti. Il supporto server è fornito dal piccolo pacchetto Python `wsproto`, installato insieme all'applicazione. [Connessioni HTTP/1.x, Mozilla](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x), [WebSocket con Uvicorn](https://uvicorn.dev/installation/)

H.265 dipende dal decoder del browser e del sistema. Se la riproduzione nativa non è possibile, il lettore può richiedere la **modalità compatibile H.264**, che ricodifica sul server fino a 720p e 15 fps. Questa modalità usa più CPU e ha un limite separato. Quando il limite è raggiunto, scegliere un sottostream H.264 o ridurre le conversioni contemporanee.

La diretta non ha ritardo nullo: fotogrammi chiave e buffer possono aggiungere alcuni secondi. Un intervallo keyframe di circa 1–2 secondi, se configurabile sulla telecamera, facilita avvio e recupero. In modalità normale viene conservata la frequenza del flusso sorgente. Il browser deve supportare MSE e i codec scelti; i valori effettivi vanno verificati sul proprio impianto.

Dietro un reverse proxy, consentire l'upgrade WebSocket verso `/api/cameras/.../live.ws`, preservare l'header Host e lo schema originale, e usare un timeout adatto a collegamenti persistenti. In accesso diretto dalla LAN sulla porta 8080 non serve configurare un proxy.

## Limiti delle risorse

| Variabile | Predefinito | Significato |
|---|---:|---|
| `NVR_LIVE_MAX_STREAMS` | 16 | Processi live condivisi massimi, tra 1 e 32 |
| `NVR_LIVE_MAX_TRANSCODES` | 2 | Conversioni video compatibili contemporanee, tra 0 e 4; 0 le disabilita |

Le conversioni sono comprese nel limite totale dei processi live. Una telecamera può avere fino a otto spettatori contemporanei. Sono limiti del software, non una garanzia sulla capacità dell'hardware. Le pagine non visibili non tengono tutte le telecamere aperte in background.

Nell'installazione nativa, eventuali variazioni vanno aggiunte a `/etc/nvr-sr81/environment` e applicate riavviando `nvr-sr81`. Con Docker Compose usare il file `.env`. Osservare CPU, RAM e registrazione prima di aumentare i limiti.

## Aggiornamento e RAM su Proxmox

Usare il nuovo `deploy/update.sh`, come descritto nella [guida Proxmox](proxmox.md). L'aggiornamento prepara prima dell'arresto il pacchetto e le dipendenze runtime; l'installazione durante il breve riavvio usa i file già scaricati. Configurazione, password, chiave e video restano nei loro percorsi. La versione 0.3.0 aggiunge il supporto WebSocket, quindi usare lo script aggiornato. Dopo l'aggiornamento ricaricare completamente la pagina.

L'applicazione non modifica automaticamente la RAM del container esistente. Dalla Shell del nodo, con RAM disponibile, `pct set 181 --memory 4096` assegna 4 GB al container 181; `pct config 181` permette di verificarla.

## Collaudo

Le verifiche includono flussi FFmpeg e RTSP locali, inizializzazione MP4, codec AVC/HEVC, ingresso di altri spettatori, disconnessione, arresto e limiti. Nel browser sono provate anche griglie da 16 WebSocket con video sintetico e accesso contemporaneo alle API. Il monitor va poi collaudato sulle telecamere reali, osservando disconnessioni, supporto H.265 del proprio client e carico durante registrazione e visione simultanee.
