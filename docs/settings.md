# Impostazioni, lingue e traduzioni

La versione 0.4.0 usa l'inglese come lingua originale dell'applicazione e include l'italiano. Non scarica traduzioni da Internet. La barra a sinistra riprende il layout del progetto M777: icone sopra ai nomi e indicazione della sezione attiva. L'elenco delle telecamere rimane disponibile nell'area del registratore.

## Cambiare lingua

Il selettore è disponibile sia nella pagina di accesso sia in **Settings → Languages**. La prima apertura usa **English**, anche se il browser è in italiano. Selezionando **Italiano**, testi, pulsanti, etichette di accessibilità e formati di data e numeri seguono la lingua scelta.

La preferenza viene salvata nel browser. Ogni dispositivo può usare una lingua diversa. Se il browser impedisce la memorizzazione locale, la scelta rimane valida nella sessione corrente. I nomi delle telecamere, gli indirizzi e i dati dichiarati dai dispositivi non sono tradotti. Prima del login sono disponibili le traduzioni incluse; le personalizzazioni salvate sul server vengono applicate dopo l'accesso.

## Impostazioni generali

**Settings → General** mostra versione dell'app, spazio libero e limiti correnti delle dirette. Il layout predefinito del monitor può essere scelto tra 1, 4, 9 e 16 riquadri e viene ricordato dal browser. I parametri del registratore e del servizio rimangono nei rispettivi file di configurazione; questa schermata non riavvia il servizio.

## Personalizzare l'italiano

In **Settings → Translations** il testo inglese originale è affiancato alla traduzione italiana modificabile. La ricerca riguarda entrambe le colonne; i testi sono suddivisi in pagine.

1. Cercare il testo e modificare la traduzione italiana.
2. Conservare i segnaposto tra parentesi graffe, per esempio `{count}`: vengono sostituiti dai valori reali dell'app.
3. Premere **Save translations** per salvare tutte le modifiche sul NVR.

Le modifiche sono condivise dai browser che accedono allo stesso NVR e rimangono disponibili dopo un riavvio. Un testo vuoto ripiega sull'inglese. **Restore defaults** elimina le personalizzazioni dopo conferma e ripristina l'italiano incluso.

**Export JSON** scarica il catalogo italiano corrente, comprese le modifiche ancora da salvare. **Import JSON** carica un catalogo esportato, ne verifica lingua, chiavi, lunghezze e segnaposto e prepara le modifiche nell'editor. L'importazione richiede poi **Save translations** per essere applicata sul server. Un catalogo parziale riporta ai valori inclusi le chiavi omesse. Non vengono eseguiti HTML o script contenuti nelle traduzioni.

Le personalizzazioni si trovano nel database locale, nella voce `translation_overrides_v1` della tabella metadata. Seguono quindi il backup del catalogo NVR; l'aggiornamento dell'app conserva il database. L'accesso alle API delle traduzioni richiede la sessione amministratore e le scritture sono protette come le altre API.

## Aggiungere testi al progetto

I testi originali inglesi sono chiavi stabili. I cataloghi italiani sono suddivisi nei file `nvr/static/locales-ui.js`, `locales-app.js`, `locales-server.js` e `locales-settings.js`, caricati prima di `i18n.js`. Il contenuto HTML usa attributi `data-i18n`; i testi dinamici usano `NvrI18n.t`. Per nuovi messaggi aggiungere la corrispondente traduzione italiana conservando i segnaposto. Una nuova lingua richiede un catalogo e la registrazione nel selettore e nel motore, non un servizio esterno.

I test verificano lingua iniziale, preferenza salvata, ripiego all'inglese, segnaposto, traduzione dei messaggi del server, resa come testo, autorizzazione e persistenza delle personalizzazioni. Il collaudo nel browser comprende navigazione e cambio lingua delle schermate esistenti.
