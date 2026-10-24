# Indizi di movimento nelle registrazioni

La traccia **Movimento** aiuta a trovare i momenti in cui l'immagine cambia dentro una registrazione. L'analisi avviene sul recorder, senza servizi esterni, modelli AI o riconoscimento di persone, animali e oggetti. La registrazione continua e i file originali restano indipendenti dall'analisi.

## Usare la traccia

1. Aprire una registrazione completata nel lettore. L'analisi del solo file selezionato parte automaticamente.
2. Attendere la comparsa della traccia sotto la forma d'onda audio. Il movimento può essere analizzato anche quando il video non contiene audio.
3. Fare clic su un intervallo evidenziato per raggiungere quel punto del video. Usare **Precedente** e **Successivo** per passare fra gli intervalli del file selezionato.
4. Scegliere sensibilità **Bassa**, **Media** o **Alta**. Media è il valore iniziale; Alta include cambiamenti più piccoli, Bassa richiede cambiamenti più evidenti.

I risultati vengono conservati nella cache locale per file e sensibilità. Riaprire un file già analizzato può quindi mostrare subito la traccia. Se il file cambia, oppure la cache è stata rimossa, occorre una nuova analisi. Il segmento ancora in registrazione diventa consultabile dopo la chiusura, normalmente dopo circa 30 minuti secondo la configurazione del servizio.

## Interpretare gli intervalli

Un intervallo segnala una variazione fra immagini successive: guardare il video per capire cosa è successo. Illuminazione, fari, ombre, pioggia, foglie, rumore notturno e spostamenti della telecamera possono generare indicazioni. Movimenti piccoli, brevi o poco contrastati possono sfuggire all'analisi. Una traccia vuota indica che non sono state rilevate variazioni sufficienti alla sensibilità scelta.

Questa funzione riguarda la consultazione dei video archiviati. Non invia allarmi o notifiche in diretta e non decide quali filmati registrare o conservare.

## Carico sul recorder

Il primo calcolo richiede la decodifica del video e può impiegare tempo, soprattutto con H.265, file lunghi o hardware meno recente. Il lettore mostra lo stato dell'analisi; i risultati già in cache evitano di ripetere lo stesso lavoro. Le prove con le proprie telecamere devono includere la consultazione mentre il recorder registra normalmente.

Per contenere il lavoro, FFmpeg produce immagini in scala di grigi da **160 × 90 pixel a 2 fotogrammi al secondo**, usando un thread di decodifica. Il programma confronta immagini consecutive e riassume i cambiamenti in intervalli cliccabili; conserva in cache solo i dati della traccia. Non modifica codec, audio, durata o contenuto dei file originali e non richiede nuove dipendenze oltre ai componenti già usati dall'NVR. [Documentazione dei filtri FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#fps).
