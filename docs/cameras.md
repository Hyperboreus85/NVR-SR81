# Aggiungere telecamere e scegliere il flusso

Aprire **Cameras / Telecamere** e scegliere **Add camera / Aggiungi telecamera**. Assegnare un nome riconoscibile, compilare la connessione e il percorso del video principale, quindi salvare. Con la registrazione continua abilitata, il recorder inizia a ricevere il flusso. La telecamera deve essere raggiungibile dal PC o container NVR, anche quando il browser si trova su un altro dispositivo.

NVR-SR81 accetta indirizzi **RTSP, RTSPS, HTTP e HTTPS**. L'indirizzo deve portare al contenuto video: la pagina di accesso o il pannello web della telecamera non sono un flusso. Il percorso corretto dipende dal produttore e dal profilo configurato sul dispositivo.

## Compilare la connessione

La connessione condivisa raccoglie **protocollo, indirizzo del dispositivo, porta, nome utente e password**. I tre flussi hanno ciascuno il proprio percorso, comprensivo dell'eventuale query: per esempio `/stream?channel=1`. Il protocollo si sceglie tra RTSP, RTSPS, HTTP e HTTPS; HLS e MJPEG usano HTTP o HTTPS.

Se la porta rimane vuota viene usata quella standard del protocollo: RTSP 554, RTSPS 322, HTTP 80 e HTTPS 443. Usare invece la porta indicata dal produttore quando è diversa. [Porte RTSP/RTSPS nella specifica IETF](https://www.rfc-editor.org/rfc/rfc7826.html#section-4.2).

Il flusso **principale** è necessario e alimenta la registrazione. Il **secondario** e il **terzo** sono facoltativi. Nelle opzioni avanzate di ciascuno si può inserire un **URL completo**: prevale sui dati condivisi e può usare un'altra porta, un altro protocollo o credenziali diverse. È utile anche per incollare un URL fornito dal produttore o ricavato con ONVIF, conservandone percorso e query.

Quando si riapre una telecamera salvata, l'interfaccia indica quali flussi sono configurati ma non ricarica nome utente, password, percorso o token protetti. **Lasciare vuoti i campi del flusso mantiene il collegamento salvato**: un campo vuoto non significa che l'indirizzo sia stato perso. Per sostituirlo, inserire il nuovo collegamento; per cancellare le credenziali usare il comando esplicito di rimozione. Disattivare un flusso secondario o terzo ne rimuove il collegamento dalla configurazione al salvataggio, senza eliminare registrazioni esistenti.

Se si modifica soltanto il percorso senza scrivere `?`, un'eventuale query privata già salvata viene conservata. Scrivere anche `?parametro=valore` per sostituirla, oppure terminare il nuovo percorso con `?` per azzerarla. Inserire un URL completo sostituisce invece l'intero collegamento del singolo flusso.

## Quale sorgente usare

| Sorgente | Cosa inserire | Quando sceglierla |
|---|---|---|
| RTSP / RTSPS | L'URL del profilo, per esempio `rtsp://192.168.1.50:554/stream` | Scelta iniziale consigliata per telecamere H.264/H.265. RTSPS richiede il supporto TLS del dispositivo e di FFmpeg. |
| Video HTTP / HTTPS | Un indirizzo che restituisce direttamente video, per esempio `http://192.168.1.50/video.ts` | Dispositivi o encoder che espongono un flusso video continuo via HTTP. |
| HLS | L'URL HTTP(S) della playlist, per esempio `http://192.168.1.50/live/index.m3u8` | Sorgenti che forniscono una playlist aggiornata e i relativi segmenti video. |
| MJPEG | L'URL HTTP(S) del flusso JPEG continuo, per esempio `http://192.168.1.50/video.mjpg` | Telecamere che espongono un flusso multipart MJPEG. Una singola foto JPEG non equivale a un video continuo. |

Gli esempi indicano solo la forma dell'indirizzo: non sono percorsi universali da provare su ogni modello. Non occorrono prefissi aggiuntivi come `hls+http://`; una playlist HLS usa il normale URL HTTP(S). FFmpeg legge HTTP, il demuxer HLS e i flussi MJPEG multipart. [Protocolli FFmpeg](https://ffmpeg.org/ffmpeg-protocols.html#http), [input HLS](https://ffmpeg.org/ffmpeg-formats.html#hls), [input MJPEG multipart](https://ffmpeg.org/ffmpeg-formats.html#mpjpeg).

Per HLS, preferire la playlist della qualità desiderata quando il dispositivo pubblica più varianti. Il recorder usa una traccia video della sorgente; non offre un selettore adattivo delle varianti. La playlist e tutti i segmenti devono rimanere accessibili al recorder. Una sorgente HLS a segmenti può avere più ritardo rispetto al flusso RTSP della stessa telecamera. Questa versione non offre impostazioni per DRM, playlist cifrate, cookie di sessione o header HTTP personalizzati.

MJPEG conserva immagini JPEG anziché video H.264/H.265. Per una risoluzione e frequenza simili può richiedere più banda e spazio; normalmente non comprende audio. Il recorder conserva il codec originale, mentre la visione nel browser può richiedere **Compatible H.264 / H.264 compatibile**, con un maggior uso della CPU. Anche per altre sorgenti HTTP il tipo di URL non garantisce che il codec sia riproducibile direttamente dal browser.

Verificare anche la durata di una registrazione MJPEG di prova: alcuni flussi multipart non dichiarano timestamp o frequenza dei fotogrammi. In questo caso FFmpeg può assumere una cadenza diversa da quella reale e il video archiviato può risultare accelerato. Per questi feed serve una sorgente o un gateway che fornisca un flusso temporizzato correttamente. Per la registrazione continua, preferire H.264/H.265 con temporizzazione corretta; l'accettazione di un URL MJPEG non garantisce la ricostruzione dei suoi tempi e il progetto non promette compatibilità universale MJPEG. Il test automatico conserva fotogrammi MJPEG a 25fps: non verifica cadenze arbitrarie. [Demuxer multipart MJPEG di FFmpeg](https://ffmpeg.org/doxygen/trunk/mpjpegdec_8c_source.html).

## Ricavare l'URL con ONVIF

Se la telecamera supporta ONVIF, usare **Retrieve with ONVIF / Recupera con ONVIF** oppure aprire **Network cameras / Telecamere in rete**. Inserire le credenziali ONVIF, leggere i profili e scegliere quello da registrare. [Guida alla ricerca e ai profili](discovery.md).

ONVIF permette di individuare il dispositivo, consultarne le caratteristiche e ottenere gli indirizzi dei profili. La trasmissione del video usa poi protocolli come RTSP/RTP; lo standard descrive anche tunnel HTTP/HTTPS. **ONVIF e RTSP svolgono quindi ruoli diversi**. L'importazione attuale legge gli URL RTSP pubblicati dai servizi Media1/Media2; la ricerca ONVIF non scopre automaticamente ogni sorgente HLS o MJPEG presente in rete. [ONVIF Streaming Specification](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf).

Profile S riguarda lo streaming video di base; Profile T comprende H.264/H.265 e ulteriori funzioni, inclusi casi di streaming HTTPS. La presenza del marchio ONVIF sul dispositivo non garantisce ogni funzione e NVR-SR81 non dichiara una conformità completa a questi profili. [ONVIF Profile S](https://www.onvif.org/profiles/profile-s/), [ONVIF Profile T](https://www.onvif.org/profiles/profile-t/).

## Registrazione e anteprima

L'URL principale alimenta la registrazione. Se disponibile, configurare un flusso **secondario** a risoluzione più bassa: viene preferito per l'anteprima e riduce il lavoro richiesto alla visione live senza diminuire la qualità dell'archivio. Main e substream devono rappresentare la stessa telecamera e possono avere credenziali o percorsi diversi. Il terzo flusso conserva un ulteriore collegamento del dispositivo; configurare tre indirizzi non avvia tre registrazioni simultanee della stessa telecamera.

La scelta **Live stream / Flusso live** permette di usare Main, Sub o Third per la diretta. È una preferenza della telecamera, salvata sul server e comune ai browser. Il valore predefinito è Sub, con ripiego su Main quando il secondario non è configurato. Per scegliere Third occorre prima configurarlo. Questa preferenza è distinta dal layout dei riquadri Monitor, che viene salvato soltanto nel proprio browser.

Scegliere se registrare l'audio originale e per quanti giorni conservare i video. I file più vecchi del periodo scelto vengono rimossi automaticamente. La durata dei singoli file è invece una preferenza globale in **Settings → Recording**; il valore consigliato dal progetto è 30 minuti. [Impostazioni della registrazione](settings.md#durata-dei-file-di-registrazione).

Dopo il salvataggio controllare lo stato della telecamera e, riaprendo la configurazione, scegliere Main, Sub o Third da provare con **Test saved stream / Prova flusso salvato**. Il test verifica la lettura del video; la compatibilità del browser è una verifica separata. Se la registrazione funziona ma il Monitor non mostra il video, provare il flusso H.264 secondario o la modalità compatibile. [Dirette](live.md), [consultare le registrazioni](recordings.md).

## Credenziali e uso locale

Usare l'utente della telecamera autorizzato a leggere il flusso. Se utente e password fanno parte dell'URL, i caratteri riservati devono essere codificati correttamente; l'importazione ONVIF lo fa automaticamente. I collegamenti salvati vengono cifrati sul recorder. Il normale elenco delle telecamere nasconde credenziali, percorso e query; gli URL completi copiati o condivisi possono comunque contenere password o token.

Per funzionare senza Internet, scegliere indirizzi della rete locale e verificare che anche le risorse richiamate da una playlist HLS siano locali. NVR-SR81 non richiede un account cloud, ma non può rendere locale una sorgente del produttore che dipende da server esterni. Gli URL `udp://`, `rtmp://`, `srt://`, file locali e comandi FFmpeg inseriti come indirizzo non sono previsti da questa interfaccia.
