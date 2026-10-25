# Cercare le telecamere e ricavare gli URL dei flussi

La sezione **Telecamere in rete** serve a trovare dispositivi ONVIF e consultarne i profili video. Funziona dal server NVR: il browser comanda la ricerca, mentre i pacchetti partono dal container o PC che esegue NVR-SR81. Le credenziali della telecamera possono essere diverse dalla password con cui si entra nel registratore.

ONVIF fornisce ricerca, informazioni e indirizzi dei profili; la trasmissione del video avviene poi tramite RTSP/RTP e i trasporti previsti dal dispositivo. L'importazione attuale richiede gli URL RTSP ai servizi Media1/Media2. Per una sorgente HTTP(S), HLS o MJPEG già nota si può invece aggiungere direttamente il suo URL in **Cameras / Telecamere**: non è necessario che esponga ONVIF. La ricerca automatica descritta qui trova dispositivi ONVIF, non ogni possibile flusso video della LAN. [Scegliere una sorgente e aggiungere una telecamera](cameras.md), [specifica ONVIF dello streaming](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf).

## Ricerca automatica

1. Accedere all'NVR e aprire **Telecamere in rete** nella barra laterale.
2. Lasciare la selezione automatica delle interfacce oppure scegliere quella collegata alle telecamere.
3. Avviare la ricerca ONVIF. Una ricerca normale richiede circa sei secondi.
4. Selezionare un dispositivo e l'endpoint pubblicato. La porta e il percorso possono essere diversi da quelli della sua interfaccia web.
5. Inserire utente e password ONVIF del dispositivo e scegliere **Leggi profili**.

La ricerca usa WS-Discovery IPv4, inviando Probe multicast a `239.255.255.250:3702`. Le risposte riportano indirizzi del servizio, identificatore e dati opzionali come nome, modello e posizione. I dispositivi non vengono configurati o aggiunti automaticamente al registratore. [Specifica ONVIF Core, discovery](https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf), [WS-Discovery OASIS](https://docs.oasis-open.org/ws-dd/discovery/1.1/os/wsdd-discovery-1.1-spec-os.html)

## Flussi principale, secondario e altri profili

Vengono consultati i servizi Media1 e Media2 disponibili, conservando nomi e token originali. Ogni profilo può mostrare codec, risoluzione, frequenza fotogrammi, limite bitrate, sorgente video, audio e indirizzo RTSP. Se un profilo non fornisce un URL, rimane nell'elenco con un messaggio: gli altri flussi restano utilizzabili.

ONVIF espone profili, senza garantire etichette universali “main” e “sub”. Quando i metadati lo permettono, il registratore suggerisce come principale il profilo più grande e come secondario il più piccolo della **stessa sorgente video**. Gli altri rimangono disponibili. Questi suggerimenti non modificano la telecamera; su NVR multicanale o sensori multipli verificare anche la sorgente. [ONVIF Media2, GetProfiles/GetStreamUri](https://www.onvif.org/specs/2412/ONVIF-Media2-Service-Spec-v2412.pdf)

- **Copia URL** copia il collegamento del singolo profilo.
- **Copia tutti** copia un URL per riga, per tutti i profili utilizzabili.
- Il selettore per le credenziali permette di includere utente e password nell'URL RTSP. Sono codificati correttamente anche quando contengono caratteri riservati.
- Senza tale selezione viene rimossa la parte `utente:password@`. Un eventuale token già presente nel percorso o nella query dell'URL fornito dalla camera resta parte dell'indirizzo: trattare comunque gli URL come dati riservati.
- Scegliere il profilo per la registrazione e, facoltativamente, quello per l'anteprima; **Aggiungi al registratore** prepara una nuova configurazione da salvare.

Le password e i risultati della consultazione rimangono in memoria nella pagina e vengono puliti al logout/cambio dispositivo. Non sono salvati nel browser. Gli URL vengono salvati cifrati sul server soltanto quando si salva una telecamera nel registratore. Su HTTP locale, se il browser limita la copia automatica, viene aperto un campo selezionato da copiare manualmente.

## Se la ricerca automatica non trova nulla

Controllare che ONVIF sia abilitato sulla telecamera e che NVR e camera siano sulla stessa LAN/VLAN. Alcuni produttori richiedono un utente ONVIF separato; alcuni dispositivi possono avere la discovery disabilitata pur accettando chiamate dirette.

Si può scegliere **Ricerca per intervallo IP** e inserire una rete privata, ad esempio `192.168.1.0/24`, con le porte ONVIF desiderate. Sono consentite reti IPv4 RFC1918 o link-local fino a 256 indirizzi e da una a otto porte; l'applicazione limita connessioni e tempo. Il campo viene proposto dall'interfaccia scelta, ma va verificato prima di avviare la ricerca. Una scansione di una /24 su più porte può durare alcune decine di secondi.

Questa modalità verifica `/onvif/device_service` sulle porte indicate, senza password, tramite una chiamata ONVIF di lettura dell'ora. La sola presenza di una pagina web o una risposta HTTP 401 non basta per dichiarare trovata una camera. Una telecamera con percorso diverso o che richiede autenticazione anche per tale chiamata va inserita con **Endpoint manuale**. La porta 443 viene verificata in HTTPS; sulle altre porte viene usato HTTP. La verifica TLS resta attiva.

## Proxmox e Docker

Il container LXC può restare non privilegiato: questa ricerca usa normali socket UDP e connessioni HTTP, senza socket raw o privilegi aggiuntivi. Su Proxmox bridge, VLAN e firewall devono consentire il multicast e le risposte dei dispositivi. Le richieste vanno alla porta UDP 3702; le risposte unicast tornano alla porta temporanea aperta dal client. Consentire solo ingresso sulla 3702 può quindi non essere sufficiente. La ricerca per sottorete usa invece connessioni HTTP verso le porte indicate, se la LAN è raggiungibile dal container.

Con il normale bridge/NAT Docker, le risposte multicast possono non raggiungere il container: usare la ricerca per sottorete o configurare consapevolmente una rete adatta al multicast, ad esempio host networking su Linux con ascolto HTTP limitato all'IP locale desiderato. Non sono applicate modifiche automatiche alla rete o al firewall dell'host. [Esempio documentato di WS-Discovery con Docker](https://docs.openedgeplatform.intel.com/dev/edge-ai-libraries/sensor-manager/get-started.html)

## Limiti e verifiche

NVR-SR81 implementa discovery IPv4, non gestione remota completa della telecamera: niente modifica utenti, rete, codec o PTZ. I dati di discovery sono annunci dei dispositivi; l'accesso ai profili viene verificato separatamente. È consentita una ricerca di rete per volta; i profili hanno una propria concorrenza limitata, indipendente dalla registrazione. Il progetto non dichiara conformità completa ONVIF Profile S o Profile T.

Per contenere tempi e memoria, la discovery elenca fino a 128 dispositivi, il lettore considera fino a otto servizi Media e 64 profili per servizio, con un tempo totale limitato. Gli eventuali risultati parziali sono segnalati. Questi limiti non cambiano il massimo di 32 telecamere configurabili per registrare nella prima implementazione.

I test automatici includono un responder UDP reale su localhost, un endpoint HTTP ONVIF locale, XML non validi, annullamento, deduplicazione, Media1/Media2, profili senza URI e copia dal browser. La compatibilità con le telecamere fisiche e con il firewall del proprio nodo va verificata sulla rete dell'installazione.
