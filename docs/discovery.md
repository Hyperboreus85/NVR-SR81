# Cercare telecamere e ricavare i flussi

La pagina **Network** esegue le ricerche dal recorder, non dal browser. Un risultato identifica un dispositivo o un servizio; il video viene verificato separatamente. Ricerca, consultazione e test non aggiungono automaticamente telecamere: **Add camera** apre una configurazione da controllare e salvare. Servono il permesso Network per la ricerca e Cameras con accesso a tutte le telecamere per salvarne una nuova.

## Ricerca locale

1. Aprire **Network**, lasciare **Local discovery** e scegliere eventualmente un'interfaccia.
2. Selezionare ONVIF e/o mDNS e premere **Find cameras**.
3. Aprire un risultato. Per ONVIF inserire le credenziali del dispositivo e premere **Read profiles**.
4. Scegliere Main, Sub e, se disponibile, Third; aprire la configurazione con **Add to recorder**.

ONVIF usa WS-Discovery IPv4 sulla rete locale. mDNS/DNS-SD cerca annunci `_rtsp._tcp.local` e `_rtsps._tcp.local`: può trovare solo i dispositivi che pubblicano questi servizi. Un annuncio RTSP indica host e porta, senza garantire il percorso del flusso o un video utilizzabile. La ricerca locale dura normalmente circa sei secondi. [ONVIF Core](https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf), [DNS-SD, RFC 6763](https://www.rfc-editor.org/rfc/rfc6763.html), [mDNS, RFC 6762](https://www.rfc-editor.org/rfc/rfc6762.html).

## IP, nomi host e altre sottoreti

**Specific targets** accetta indirizzi separati da virgole o righe, ad esempio:

```text
192.168.20.0/24
10.40.5.18
camera.sede.example
```

Sono disponibili ONVIF, RTSP e RTSPS, con porte modificabili per ogni protocollo. ONVIF verifica `/onvif/device_service` senza password; RTSP/RTSPS usa OPTIONS, senza avviare il video o provare credenziali. Una pagina web o una porta TCP aperta non vengono considerate una telecamera. La verifica TLS rimane attiva. RTSP OPTIONS verifica capacità del servizio, senza enumerare percorsi video: serve un URL effettivo fornito dalla telecamera, da ONVIF o dal produttore. [RTSP, RFC 7826](https://www.rfc-editor.org/rfc/rfc7826.html).

Limiti per ricerca:

- Da 1 a 16 indirizzi/reti; massimo 512 indirizzi distinti e 4096 verifiche protocollo/porta.
- Reti IPv4 private, link-local o CGNAT da /24 a /32; un indirizzo pubblico deve essere un singolo host. IPv6 accetta singoli indirizzi senza zona, non intervalli.
- Fino a 8 porte per protocollo, 32 verifiche contemporanee, circa 75 secondi complessivi. I risultati incompleti sono segnalati.
- Una ricerca alla volta. Il conteggio mostra verifiche completate e totali; **Cancel** mantiene i risultati già ricevuti.

Il DNS ha limiti di tempo e dimensione; le verifiche mantengono l'identità del nome host. Loopback, multicast e indirizzi riservati non sono destinazioni valide. La ricerca non cambia rete, firewall o configurazione delle telecamere.

**Saved targets** conserva nel database fino a 32 destinazioni con nome. Salvarle o selezionarle non avvia ricerche. Non accettano URL o credenziali. Risultati e credenziali restano in memoria nella pagina e vengono eliminati al logout o al cambio dispositivo.

## Telecamere remote

Il recorder deve raggiungere l'IP o il nome host inserito. Per un'altra sede si può configurare una VPN con rotte verso la sottorete delle telecamere, poi cercare quella rete in **Specific targets**. La discovery multicast locale non attraversa automaticamente router e Internet. VPN e rotte vanno predisposte sul sistema o sulla rete: l'applicazione non le crea. [ONVIF Core](https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf), [WireGuard quick start](https://www.wireguard.com/quickstart/).

È possibile indicare anche un singolo IP pubblico o hostname raggiungibile, con porte note. Se più telecamere condividono un indirizzo pubblico tramite porte diverse, controllare ogni endpoint e aprire separatamente l'indirizzo esatto di ciascuna. Gli identificativi P2P/cloud proprietari richiedono un flusso standard esposto dal dispositivo o un gateway compatibile.

Se ONVIF restituisce indirizzi della LAN remota inutilizzabili dal recorder, aprire **Remote options**:

- **Use the entered endpoint address for ONVIF services** riutilizza esplicitamente l'origine dell'endpoint inserito per servizi pubblicati con indirizzo interno. Non modifica altri indirizzi pubblici e non degrada HTTPS a HTTP.
- **Stream host override** e **Stream port override** sostituiscono solo host e/o porta degli URL video restituiti; percorso e query rimangono quelli della telecamera.

Verificare le porte raggiungibili di ONVIF e video, che possono essere diverse. Le credenziali non vengono inviate all'indirizzo interno scartato. Una rete instradata tramite VPN permette di usare gli indirizzi della sede senza esporre ogni servizio su Internet.

## Flussi noti e profili

**Open known address → Known stream** accetta URL RTSP, RTSPS e HTTP(S), inclusi HLS o MJPEG leggibili da FFmpeg. Inserire utente e password nei campi del dispositivo, completare il percorso e premere **Test stream**. Il test controlla la presenza del video e mostra codec e risoluzione; dopo un risultato valido si abilita **Add camera**. Cambiare URL o credenziali richiede un nuovo test. Non vengono indovinati percorsi o password.

**ONVIF endpoint** consulta un servizio HTTP(S) noto anche se la discovery non lo trova. Media1/Media2 forniscono i profili disponibili; un profilo senza URL rimane visibile con il relativo errore. Main/Sub/Third sono scelte dell'utente: i suggerimenti usano risoluzione e sorgente video, conservando nomi e token. ONVIF non garantisce etichette main/sub universali. [ONVIF streaming](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf).

Gli URL si copiano singolarmente o insieme, con credenziali opzionali. Un token nel percorso o nella query resta parte dell'indirizzo: trattare gli URL come riservati. Solo il salvataggio della telecamera memorizza le sorgenti cifrate sul server. [Configurare telecamere e flussi](cameras.md).

## Proxmox, Docker e verifiche

La ricerca usa normali socket UDP e connessioni TCP: un LXC non privilegiato non richiede socket raw. Bridge, VLAN e firewall devono permettere multicast e risposte unicast alla porta temporanea del client. Con bridge/NAT Docker, se il multicast non ritorna al container usare **Specific targets** o una rete configurata per la discovery.

I test coprono parser, limiti, DNS, TLS, RTSP, mDNS, servizi ONVIF, profili, annullamento, sessioni e interfaccia con fixture locali o risposte simulate. Non dimostrano compatibilità universale con dispositivi fisici o firewall. NVR-SR81 non dichiara conformità ONVIF Profile S/T e non modifica PTZ, utenti o configurazione del dispositivo.
