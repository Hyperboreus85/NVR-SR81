# Impostazioni, registrazione e lingue

Le impostazioni raccolgono **General**, **Languages**, **Recording** e **System** nella barra superiore, come Live e Record. Inglese e italiano sono inclusi; nuovi pacchetti JSON si installano e si selezionano in Languages. La grafica usa pannelli compatti, superfici grigio scuro, accenti ciano e dettagli oro, in linea con Record. La versione dell'applicazione compare sotto il logo e gli indicatori di sistema nella barra superiore rimangono visibili da ogni pagina autenticata.

Le quattro schede si aprono direttamente sui controlli, senza titolo Settings o introduzioni duplicate. I testi essenziali spiegano preferenze, file JSON, durata delle registrazioni e azioni di sistema.

## Cambiare lingua

Il selettore è disponibile sia nella pagina di accesso sia in **Settings → Languages**. La prima apertura usa **English**, anche se il browser è in italiano. Selezionando **Italiano**, testi, pulsanti, etichette di accessibilità e formati di data e numeri seguono la lingua scelta.

La preferenza viene salvata nel browser. Ogni dispositivo può usare una lingua diversa. Se il browser impedisce la memorizzazione locale, la scelta rimane valida nella sessione corrente. I nomi delle telecamere, gli indirizzi e i dati dichiarati dai dispositivi non sono tradotti. I pacchetti installati sono disponibili anche nella pagina di accesso, come gli altri elementi dell'interfaccia.

## Impostazioni generali

**Settings → General** mostra versione, spazio libero, limiti delle dirette e durata effettiva dei file di registrazione. Il layout del monitor può essere scelto tra 1, 4, 9 e 16 riquadri e viene ricordato dal browser.

Le sorgenti e i parametri delle singole telecamere si gestiscono in **Cameras / Telecamere**. Oltre a RTSP/RTSPS si possono inserire URL video HTTP/HTTPS, playlist HLS e flussi MJPEG compatibili. ONVIF aiuta a ricavare i profili di una telecamera; non è un trasporto video alternativo da scrivere come URL. [Guida alle sorgenti e alla configurazione delle telecamere](cameras.md).

## Manutenzione del sistema

**Settings → System** mostra una panoramica del recorder: hostname, IP locali, versione, sistema operativo, tempi di attività, carico CPU, temperatura disponibile, RAM, swap, spazio dei dischi e tempo stimato prima della pulizia dell'archivio. I grafici mostrano lo storico salvato ogni 30 secondi, anche senza login, con intervalli di 1 ora, 6 ore, 24 ore o 7 giorni. I riavvii conservano i campioni; i periodi mancanti restano vuoti. [Come leggere le misure e la stima di spazio](telemetry.md).

Per l'archivio compare un avviso con meno del **10% libero**. Sotto il **5%**, la rotazione automatica rimuove i filmati completati idonei più vecchi fino a recuperare almeno il 5%; i file aperti o protetti da operazioni in corso vengono saltati. Se lo spazio resta insufficiente, la registrazione si sospende. Il disco del sistema riceve soltanto una segnalazione: non vengono rimossi file del sistema operativo. [Conservazione e spazio libero](recordings.md#conservazione-e-spazio-libero).

Per riavviare il recorder aprire **Settings → System**. Il riavvio del servizio richiede una conferma esplicita; il riavvio del sistema operativo locale è disponibile solo se abilitato dall'amministratore Linux. Entrambi interrompono temporaneamente la registrazione. [Disponibilità e conferme della manutenzione](maintenance.md).

Nella stessa pagina, **Delete all recordings / Cancella tutte le registrazioni** mostra il riepilogo dell'archivio. Un primo clic apre il dialogo; un secondo clic su **Delete all recordings** conferma, oppure **Cancel** annulla. Non occorre digitare parole. È una cancellazione dei filmati locali, non una formattazione del disco: telecamere, impostazioni e file estranei vengono conservati. Se sono in corso riproduzioni, download o analisi, non viene avviata: chiuderli o attendere che terminino, poi riprovare. Durante l'operazione l'acquisizione si interrompe temporaneamente e viene ripristinata al termine. Salvare prima una copia dei video da conservare e controllare l'esito mostrato. [Dettagli e protezioni della cancellazione](recordings.md#eliminare-tutte-le-registrazioni).

## Durata dei file di registrazione

Accedere come amministratore e, in **Settings → Recording**, scegliere **1, 2, 3, 4, 5 minuti**, oppure da **10 a 120 minuti a passi di 5**. Il valore predefinito e consigliato dal progetto è **30 minuti**. La durata vale per tutte le telecamere registrate da questo NVR.

Premere **Save / Salva** per applicarla. Il recorder chiude regolarmente i file in corso e avvia i successivi con il nuovo valore; il servizio rimane avviato. I video già archiviati mantengono durata e contenuto originali. Il file chiuso durante il cambio può essere più corto del valore precedente.

La scelta viene salvata nel database del recorder, rimane dopo riavvii e aggiornamenti e vale anche per gli altri browser. Prevale su `NVR_SEGMENT_SECONDS`, che fornisce il valore iniziale finché non è stata salvata una scelta nell'applicazione. Includere il database nel backup della configurazione.

| Scelta | Effetto pratico |
|---|---|
| 1–5 minuti | I file completati diventano consultabili prima; il numero di file aumenta. |
| 10–30 minuti | Un compromesso iniziale per la consultazione; 30 minuti è la raccomandazione di questo progetto. |
| 35–120 minuti | Meno file, con maggiore attesa per la chiusura e più lavoro per preparare riproduzione, audio e movimento del singolo file. |

Il lettore apre i segmenti completati. Con 120 minuti il file in corso può restare non consultabile per circa due ore, oltre all'attesa del fotogramma chiave utile al taglio. Il Monitor live rimane disponibile. I tagli seguono i keyframe della telecamera, quindi la durata è approssimativa; una disconnessione o un arresto regolare può creare un file più corto.

La registrazione copia il flusso originale: scegliere file più lunghi non diminuisce lo spazio giornaliero richiesto dal video. A 4 Mbit/s, un file di due ore occupa circa 3,6 GB prima di audio e overhead; la consultazione può richiedere un'ulteriore copia MP4. Verificare lo spazio della cache e i tempi di preparazione, soprattutto con H.265 o hardware meno recente. [Dettagli di registrazione e consultazione](architecture.md#registrazione-originale-e-riproduzione-web).

Per i file lunghi consigliamo di collocare la cache sul disco delle registrazioni. Le nuove installazioni con l'installer nativo e Compose usano la sottodirectory `.cache` dell'archivio; un servizio esistente conserva la propria configurazione. Il percorso si imposta con `NVR_CACHE_DIR` nel file ambiente del servizio e richiede il suo riavvio. Se la variabile è assente, rimane `NVR_DATA_DIR/cache`. Cambiare percorso conserva la vecchia cache al suo posto. Il budget di circa 2 GiB è morbido: il più recente MP4 può superarlo, e i file in uso da una richiesta sono protetti. Una preparazione che esaurirebbe lo spazio viene interrotta, rimuovendo i file temporanei.

Usare una directory dedicata: all'interno dell'archivio sono accettate solo `.cache` e le sue sottodirectory, separate dalle cartelle delle telecamere. La pulizia riguarda soltanto i file generati dalla cache; non elimina file estranei o collegamenti simbolici.

Se la cache condivide il filesystem dell'archivio, le conversioni rispettano la riserva del 5% e lo spazio già impegnato dalle altre preparazioni. Una cache su un filesystem separato mantiene una riserva minima di **512 MiB**; non provoca la cancellazione di originali o file estranei su quel disco. `NVR_MIN_FREE_GB` rimane accettata per compatibilità con i vecchi file di configurazione, ma viene ignorata: non cambia queste soglie.

## Sensibilità del movimento nel lettore

Aprendo una registrazione completata, la traccia **Movimento** viene calcolata automaticamente sotto l'audio per il solo file selezionato. Nel lettore si può scegliere sensibilità **Bassa**, **Media** o **Alta**, fare clic sugli intervalli e passare al precedente o al successivo. I risultati sono conservati nella cache locale. È un confronto delle immagini senza AI: cambiamenti di luce, pioggia o vegetazione possono produrre indicazioni; il primo calcolo usa CPU, soprattutto su hardware meno recente. La registrazione continua mantiene la durata configurata. [Guida agli indizi di movimento](motion.md).

## Installare un file lingua

**Settings → Languages** raccoglie la scelta della lingua e tutti i controlli per installare, scaricare e rimuovere i pacchetti JSON.

1. Premere **Choose language file** e scegliere un pacchetto `.json`.
2. Controllare nome, codice lingua e numero di traduzioni nell'anteprima.
3. Premere **Install language pack**. Se la lingua esiste già, il file installato la aggiorna.
4. Nella stessa pagina **Languages** scegliere la lingua installata. La preferenza riguarda il proprio browser; il file è disponibile per tutti gli utenti dell'NVR.

**Download file** scarica un pacchetto esistente. **Download template** scarica un modello con tutte le chiavi inglesi: compilare codice, nome, nome nativo e traduzioni con un editor di testo, conservando i segnaposto come `{count}`. Le chiavi mancanti o le traduzioni vuote ripiegano sull'inglese.

Il formato del file contiene `format: "nvr-sr81.language-pack"`, `version: 1`, `locale`, `name`, `native_name` e l'oggetto `translations`, che associa le chiavi inglesi alle traduzioni. Sono ammessi al massimo 512 KiB e 2000 traduzioni; chiavi sconosciute o segnaposto non corrispondenti vengono rifiutati. Sono accettati solo dati JSON, non script o archivi ZIP.

Un pacchetto installato può essere rimosso dopo conferma. Rimuovendo una sostituzione dell'italiano viene ripristinato il file italiano incluso; rimuovendo la lingua attiva senza una versione inclusa si torna all'inglese. L'inglese originale è incluso e non può essere sostituito o rimosso.

## Conservazione e aggiornamento

I file inclusi sono `nvr/locales/en.json` e `nvr/locales/it.json`. I pacchetti installati sono salvati atomicamente in `NVR_DATA_DIR/languages/<locale>.json`, normalmente `/var/lib/nvr-sr81/languages` sul container. Includere questa directory nel backup della configurazione. Installazione e rimozione richiedono l'accesso amministratore.

Le personalizzazioni italiane salvate dalla versione 0.4 vengono migrate una volta in un file italiano installato, mantenendo il vecchio dato nel database per eventuali ripristini. I cataloghi JavaScript e i vecchi endpoint dell'editor non sono più usati. I testi inglesi rimangono chiavi stabili; per aggiornare una lingua si installa un nuovo file con lo stesso codice.
