# Utenti e permessi

**Settings → Users** è riservata agli amministratori. L'account amministratore iniziale usa il nome utente **admin** e conserva la password già configurata prima dell'aggiornamento.

## Creare un'utenza

Premere **Add user**, scegliere nome utente, nome visualizzato e una password di almeno 12 caratteri. Il nome utente contiene da 3 a 32 caratteri ASCII: lettere, cifre, punto, trattino o underscore; inizia con una lettera o cifra. I nomi non distinguono maiuscole e minuscole.

I profili **Live only** e **Live and recordings** sono punti di partenza. **Custom** permette di scegliere le singole funzioni. **Administrator** concede la gestione completa, inclusa la creazione di altri amministratori.

| Permesso | Accesso |
|---|---|
| Live | Monitor, layout e dirette delle telecamere assegnate. |
| Recordings | Ricerca, riproduzione, miniature, audio e indizi di movimento delle registrazioni assegnate. |
| Download | Download originale o MP4 compatibile; richiede anche Recordings. |
| Cameras | Configurazione delle telecamere assegnate. La creazione di nuove telecamere richiede l'ambito All cameras. |
| Network | Ricerca dispositivi ONVIF e consultazione dei profili sulla rete. |
| Settings | Preferenze generali, durata dei segmenti e installazione dei pacchetti lingua. |
| System information | Indicatori e storico delle risorse del recorder. |
| Maintenance | Riavvio del servizio o del sistema, secondo le azioni abilitate sull'installazione. |
| Delete all recordings | Cancellazione dell'intero archivio; disponibile solo con ambito All cameras. |

**Selected cameras** limita l'utenza alle telecamere selezionate; una selezione vuota non concede alcuna telecamera. **All cameras** include anche quelle aggiunte successivamente. Gli amministratori hanno sempre accesso completo. I permessi di rete, impostazioni e manutenzione riguardano il recorder e hanno effetti globali: assegnarli solo alle persone incaricate di gestirlo.

L'interfaccia mostra le sole funzioni disponibili. Il server verifica comunque i permessi e gli identificativi delle telecamere per ogni richiesta, inclusi indirizzi diretti dei filmati, miniature, analisi e connessioni Live. La possibilità di vedere un filmato comporta la ricezione del video nel browser: disabilitare Download rimuove le funzioni di esportazione dell'applicazione e non costituisce una protezione contro acquisizioni dello schermo.

## Modificare e disabilitare

Selezionare un'utenza per cambiarne permessi e telecamere, disabilitarla o reimpostarne la password. Una password vuota nell'editor mantiene quella esistente. Le modifiche invalidano le sessioni dell'account interessato: occorre un nuovo login. Le dirette già aperte vengono interrotte entro il successivo controllo di autorizzazione, al massimo dopo circa 15 secondi; i dati già ricevuti dal browser non possono essere ritirati.

La disposizione del Live è separata per utente e browser. L'amministratore iniziale conserva il proprio layout precedente. Lingua e preferenze non sensibili del lettore restano preferenze del browser.

L'amministratore iniziale non può essere eliminato, rinominato, disabilitato o declassato. Non si può eliminare, disabilitare o declassare l'account con cui si sta lavorando. Eliminare un'utenza non elimina le telecamere o le registrazioni.

## Cambiare la propria password

Nella pagina Users, **Change your password** richiede password attuale, nuova password e conferma. Al termine tutte le sessioni dell'account vengono invalidate, compresa quella corrente: accedere nuovamente con la nuova password. Le password non vengono mostrate nell'elenco utenti e non sono salvate nel browser dall'applicazione.

`NVR_ADMIN_PASSWORD` serve per il primo avvio quando non esiste ancora un account o un hash precedente. Un account già presente e i cambi eseguiti dall'interfaccia prevalgono sulla variabile di avvio; un riavvio non ripristina la vecchia password. Il database conserva gli hash con scrypt e sali distinti, non le password in chiaro. Includere utenti e permessi nel backup del database insieme alla chiave delle credenziali delle telecamere.
