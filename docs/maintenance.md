# Manutenzione del recorder

In **Settings → System**, un amministratore può riavviare il servizio NVR. Il riavvio del sistema è disponibile solo quando è stato abilitato dall'amministratore Linux durante l'installazione.

**Restart service** riavvia NVR-SR81. Il recorder chiude i file in corso, interrompe le dirette e riparte; durante questa pausa manca la registrazione. I video già completati rimangono nell'archivio. Per confermare occorre scrivere esattamente `RESTART`.

**Reboot system** riavvia l'intero sistema operativo in cui è installata l'applicazione e interrompe anche gli altri servizi presenti. Se NVR-SR81 gira in un container Proxmox, riguarda quel container; il nodo Proxmox esterno non viene controllato. Per confermare occorre scrivere esattamente `REBOOT`.

L'azione viene programmata con un ritardo di circa cinque secondi. Il messaggio di accettazione indica che il sistema ha ricevuto la richiesta, non che il riavvio sia già terminato. Attendere il ritorno del recorder e riconnettersi. L'applicazione non ripete automaticamente una richiesta di riavvio; un intervallo di sicurezza impedisce richieste duplicate per un minuto, anche attraverso un riavvio del servizio.

## Disponibilità e installazione

L'installer Linux e lo script di aggiornamento installano un piccolo componente locale gestito da systemd. Il servizio web mantiene l'utente senza privilegi e `NoNewPrivileges=true`. La comunicazione usa un socket locale accessibile al solo gruppo del recorder; i comandi ammessi sono fissati a riavvio di `nvr-sr81.service` e riavvio del sistema locale. Non sono accettati nomi di servizi, comandi, indirizzi remoti o argomenti forniti dal browser.

Le installazioni manuali senza questo componente e i container Docker/Compose mostrano la manutenzione come non disponibile. Non viene richiesto di montare socket o concedere accesso al sistema che li ospita.

Il riavvio dell'intero sistema è disabilitato per impostazione predefinita. Un amministratore root può abilitarlo nel file locale `/etc/nvr-sr81/maintenance.json`:

```json
{"allow_system_reboot": true}
```

Il file deve rimanere di proprietà di root e non modificabile dal gruppo o da altri utenti, normalmente con permessi `0600`. Un file mancante, non valido o con permessi non sicuri lascia il riavvio del sistema disabilitato. La scelta esistente viene conservata durante gli aggiornamenti; includerla nel backup della configurazione. Per disabilitarlo usare `false`: non occorre riavviare il recorder.

Il componente risponde solo dopo che systemd ha accettato il timer locale. Payload, attese e richieste parallele hanno limiti; il registro dell'azione in attesa è separato dai dati modificabili dal servizio web. [Socket locali systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html) e [timer temporanei con systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html).
