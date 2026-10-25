# Consultare le registrazioni

La pagina **Record / Registrazioni** raccoglie ricerca, video, forma d'onda audio e indizi di movimento. Usa i file completati nell'archivio locale; le dirette rimangono nella sezione **Live**.

## Cercare un intervallo

1. Scegliere la telecamera, la data e gli orari **From / Da** e **To / A**.
2. Avviare la ricerca e scegliere un file nell'elenco dei risultati, oppure una parte disponibile della timeline.
3. Controllare gli orari e la durata riportati per il file selezionato. Il video, l'audio e il movimento si riferiscono a quel file.

Gli orari sono mostrati in formato **24 ore** nel fuso locale del browser, con la data della registrazione; l'indice del server conserva i tempi in UTC. Una registrazione può iniziare prima dell'intervallo cercato e sovrapporlo solo in parte. La timeline mostra l'effettiva disponibilità dei file, lasciando vuoti i periodi senza registrazioni. Fare clic su un vuoto non crea un video né sposta la selezione su un altro file.

I comandi di zoom della timeline ingrandiscono o riducono la parte visibile dell'intervallo cercato. Le tacche riportano gli orari corrispondenti e il cursore segue il video selezionato; lo zoom non riempie i vuoti o modifica i file.

Se l'orario **A** è precedente o uguale a **Da**, la fine riguarda il giorno successivo. Per esempio, dalle 22:00 alle 02:00 attraversa mezzanotte; dalle 00:00 alle 00:00 cerca l'intera giornata locale. Il passaggio usa la data del calendario del browser, tenendo conto degli eventuali cambi di ora solare e legale.

L'elenco contiene i risultati reali della ricerca. Se è vuoto, provare un'altra telecamera o un altro intervallo, oppure attendere la chiusura del file in registrazione. Se viene raggiunto il limite dei risultati, l'interfaccia chiede di restringere l'intervallo.

Le miniature vengono ricavate dal primo fotogramma del file archiviato e conservate in cache. Servono a riconoscere l'inquadratura: non sono immagini in diretta né identificano automaticamente un evento. Se una miniatura non è disponibile, il file può essere scelto comunque dall'elenco.

## Riprodurre e spostarsi nel file

I controlli del lettore permettono di avviare e mettere in pausa, spostarsi nel file, regolare audio e velocità e aprire lo schermo intero. Le indicazioni di tempo usano la durata effettiva del video: un file più corto dopo una riconnessione, oppure un file configurato da due ore, mantiene la propria scala temporale.

Durante l'apertura compare **Preparing playback… / Preparazione della riproduzione…**. Il messaggio scompare quando il video è pronto; una conversione compatibile o un file lungo può richiedere più tempo.

Il punto di riproduzione segue il video anche nelle tracce audio e movimento. L'orario della registrazione viene ricostruito dal tempo iniziale del segmento e dalla posizione nel lettore. La timeline dell'intervallo cercato e le tracce del singolo file rappresentano due scale diverse: la prima serve a scegliere il filmato, le altre a esplorarlo.

Per vedere un altro file usare l'elenco, la timeline o i comandi precedente e successivo. La riproduzione automatica passa al segmento seguente quando è contiguo; se incontra un periodo senza registrazioni, segnala il vuoto.

## Audio e movimento

La forma d'onda mostra i picchi ricavati dalla traccia audio registrata. Fare clic sulla traccia per raggiungere quel punto del video. Se il file non contiene audio, compare l'indicazione corrispondente: non viene disegnata una forma d'onda inventata.

La traccia **Movimento** viene analizzata localmente sul file selezionato. Gli intervalli e il loro conteggio derivano dai cambiamenti nelle immagini, senza riconoscimento di persone o oggetti. Sensibilità, clic sugli intervalli e comandi precedente/successivo aiutano a consultarli. Luce, pioggia e vegetazione possono generare indicazioni. [Guida agli indizi di movimento](motion.md).

Se si cambia file o telecamera durante un'analisi, i risultati del file precedente non vengono applicati alla nuova selezione. Il calcolo condiviso sul server può completarsi e restare in cache per una consultazione successiva.

## Compatibilità e originali

Per il browser viene preparata una copia MP4, conservando il video originale quando supportato e adattando l'audio. Se il browser non riproduce H.265, scegliere la modalità compatibile H.264: usa più CPU e può richiedere tempo. I file lunghi aumentano il lavoro per MP4, audio e movimento e richiedono spazio nella cache. [Durata dei file e cache](settings.md#durata-dei-file-di-registrazione).

Il comando di download scarica il file originale selezionato. La consultazione, la velocità di riproduzione e le analisi non modificano quel file o la registrazione continua.

Il file ancora aperto diventa disponibile dopo la chiusura. La durata obiettivo si imposta in **Settings → Recording**, da 1 a 120 minuti; il progetto consiglia 30 minuti come punto di partenza. I tagli dipendono dai keyframe della telecamera e possono superare il valore scelto; interruzioni e cambi di configurazione possono produrre file più corti.
