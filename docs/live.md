# Monitor live delle telecamere

All'accesso l'NVR apre **Live → Monitor**, la vista delle telecamere configurate. La voce **Live** nella barra laterale raccoglie due pagine: **Monitor**, per guardare le dirette, e **Layout**, per scegliere le telecamere e la loro posizione. Il monitor riproduce video continuo; la piccola anteprima a 2 fps nella sezione delle registrazioni rimane disponibile separatamente.

## Uso della schermata

1. Aprire **Live → Monitor** dalla barra laterale dell'NVR.
2. Usare **Live → Layout** per preparare una griglia da **1, 4, 9 o 16 riquadri**, poi salvarla e tornare al Monitor.
3. Il comando schermo intero del Monitor ingrandisce l'intera griglia. Il menu delle azioni di una telecamera permette di ingrandire quel riquadro oppure di aprire le sue registrazioni. Durante lo schermo intero di una singola telecamera le altre dirette si fermano e riprendono tornando alla griglia.
4. L'audio parte disattivato. Attivarlo sulla telecamera da ascoltare: le altre restano silenziose. Se manca una traccia audio, il monitor lo indica.
5. Usare pausa/ripresa per chiudere o riaprire le dirette. Cambiando sezione, aprendo Layout o lasciando la scheda del browser in secondo piano, le risorse delle dirette vengono liberate; la registrazione prosegue indipendentemente.

Il Monitor mostra le telecamere assegnate ai riquadri visibili, comprese quelle con registrazione sospesa. Una telecamera offline mostra il proprio stato e viene ritentata senza bloccare le altre. REC/pausa riguarda la registrazione; lo stato della diretta riguarda il lettore. L'audio si attiva per una telecamera alla volta e non fa parte del layout salvato.

## Preparare e salvare il layout

In **Live → Layout** si trovano tutte le telecamere configurate, anche quelle non presenti nel Monitor. La parete può mostrarne fino a **16 contemporaneamente**; non passa automaticamente ad altre pagine. Le telecamere lasciate fuori dalla parete continuano a registrare secondo la loro configurazione.

1. Scegliere la dimensione della griglia: **1, 4, 9 o 16**.
2. Trascinare una telecamera nel riquadro desiderato. In alternativa usare il selettore del riquadro, disponibile anche con tastiera e su dispositivi senza trascinamento.
3. Per cambiare ordine, trascinare un riquadro sull'altro. Una telecamera compare una sola volta: assegnandola a un'altra posizione, le due posizioni si scambiano. È possibile lasciare riquadri non assegnati.
4. Premere **Save layout / Salva layout** per applicare e memorizzare la disposizione. **Reset / Ripristina** annulla le modifiche non ancora salvate e torna alla disposizione salvata.

Riducendo la griglia, le assegnazioni dei riquadri nascosti restano conservate: tornano visibili scegliendo una griglia più grande. Aprire e chiudere Layout mantiene le modifiche in preparazione; il Monitor usa la disposizione salvata. Le immagini di riferimento nell'editor sono anteprime singole, non altre dirette video persistenti.

Il salvataggio riguarda **questo browser, per questo indirizzo dell'NVR**. Un altro browser, computer o telefono può avere una disposizione diversa; il layout non viene salvato nella configurazione condivisa del server. Se il browser non permette la memorizzazione, l'interfaccia segnala che il salvataggio non è riuscito. Cancellare i dati del sito può rimuovere anche la disposizione.

Alla prima apertura, senza una disposizione valida salvata, la griglia viene preparata dalle telecamere effettivamente configurate. Dopo un salvataggio, le nuove telecamere restano da assegnare e quelle eliminate lasciano libera la propria posizione: le altre non cambiano posto automaticamente. Nella memoria del browser vengono conservati identificativi e posizioni, senza URL o password dei flussi.

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

Le conversioni sono comprese nel limite totale dei processi live. Una telecamera può avere fino a otto spettatori contemporanei. Sono limiti del software, non una garanzia sulla capacità dell'hardware. Le pagine non visibili non tengono tutte le telecamere aperte in background; il Monitor apre soltanto le posizioni assegnate e visibili del layout.

Nell'installazione nativa, eventuali variazioni vanno aggiunte a `/etc/nvr-sr81/environment` e applicate riavviando `nvr-sr81`. Con Docker Compose usare il file `.env`. Osservare CPU, RAM e registrazione prima di aumentare i limiti.

## Aggiornamento e RAM su Proxmox

Usare il nuovo `deploy/update.sh`, come descritto nella [guida Proxmox](proxmox.md). L'aggiornamento prepara prima dell'arresto il pacchetto e le dipendenze runtime; l'installazione durante il breve riavvio usa i file già scaricati. Configurazione, password, chiave e video restano nei loro percorsi. La versione 0.3.0 aggiunge il supporto WebSocket, quindi usare lo script aggiornato. Dopo l'aggiornamento ricaricare completamente la pagina.

L'applicazione non modifica automaticamente la RAM del container esistente. Dalla Shell del nodo, con RAM disponibile, `pct set 181 --memory 4096` assegna 4 GB al container 181; `pct config 181` permette di verificarla.

## Collaudo

Le verifiche includono flussi FFmpeg e RTSP locali, inizializzazione MP4, codec AVC/HEVC, ingresso di altri spettatori, disconnessione, arresto e limiti. Nel browser sono provate anche griglie da 16 WebSocket con video sintetico e accesso contemporaneo alle API. Il monitor va poi collaudato sulle telecamere reali, osservando disconnessioni, supporto H.265 del proprio client e carico durante registrazione e visione simultanee.
