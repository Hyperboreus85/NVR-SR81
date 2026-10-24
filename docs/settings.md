# Impostazioni e lingue

La versione 0.7.0 gestisce le traduzioni come **file JSON installabili** nella sola pagina **Settings → Languages**. La scheda Translations e l'editor dei singoli vocaboli sono rimossi. Inglese e italiano sono inclusi; nuovi pacchetti si installano e si selezionano in Languages. Non sono richiesti servizi esterni o un riavvio. La barra sinistra mantiene icone e nomi in stile M777.

La pagina usa righe compatte per i pacchetti e raccoglie installazione e modello JSON in due riquadri affiancati sul desktop, disposti in colonna sul telefono. La grafica riprende le superfici piatte e i bordi sottili di M777, con una base grigio titanio e accenti verde acqua per comandi, selezioni, timeline e forma d'onda.

## Cambiare lingua

Il selettore è disponibile sia nella pagina di accesso sia in **Settings → Languages**. La prima apertura usa **English**, anche se il browser è in italiano. Selezionando **Italiano**, testi, pulsanti, etichette di accessibilità e formati di data e numeri seguono la lingua scelta.

La preferenza viene salvata nel browser. Ogni dispositivo può usare una lingua diversa. Se il browser impedisce la memorizzazione locale, la scelta rimane valida nella sessione corrente. I nomi delle telecamere, gli indirizzi e i dati dichiarati dai dispositivi non sono tradotti. I pacchetti installati sono disponibili anche nella pagina di accesso, come gli altri elementi dell'interfaccia.

## Impostazioni generali

**Settings → General** mostra versione, spazio libero, limiti delle dirette e durata effettiva dei file di registrazione, predefinita a **30 minuti**. Il layout del monitor può essere scelto tra 1, 4, 9 e 16 riquadri e viene ricordato dal browser. I parametri del servizio rimangono nei rispettivi file di configurazione.

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
