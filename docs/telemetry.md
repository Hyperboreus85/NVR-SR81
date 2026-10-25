# Stato del recorder e risorse del sistema

La barra superiore, presente in tutte le pagine dopo l'accesso, mostra CPU e temperatura, RAM e swap, occupazione e spazio libero dei dischi, tempo stimato prima della pulizia dell'archivio per spazio. La versione dell'applicazione si trova sotto il logo SR81. I valori riguardano il sistema operativo che esegue il recorder, non il solo processo web. I controlli **Layout**, pausa/ripresa e schermo intero rimangono sulla destra della barra del Live.

**Settings → System** raccoglie gli stessi dati in schede più dettagliate, con identificazione del sistema e grafici degli ultimi 30 minuti. Le altre sezioni delle impostazioni mantengono le funzioni esistenti con la stessa grafica compatta di Record.

## Aggiornamento e storico

Un'unica richiesta aggiorna i dati ogni cinque secondi, qualunque sia la pagina aperta. Non vengono aperti flussi video aggiuntivi per mostrare questi valori. Quando la scheda del browser passa in secondo piano, le richieste si fermano; errori, attese e disconnessione cancellano i valori correnti per evitare di presentarli come aggiornati.

Il recorder conserva in memoria un massimo di 30 minuti di campioni CPU, RAM, swap e temperatura, raccolti quando viene consultato. Non ricostruisce valori dei periodi non osservati. I grafici rispettano gli orari reali dei campioni e interrompono la linea nei periodi senza dati. I picchi si riferiscono soltanto ai campioni disponibili nella finestra visualizzata. Un riavvio del servizio azzera questo storico; non viene scritto un archivio permanente delle risorse.

## Identificazione del sistema

Il pannello mostra versione dell'applicazione, hostname, indirizzi IP locali leggibili, distribuzione Linux, kernel, architettura e tempi di attività disponibili. In un container i dati descrivono il suo ambiente; il kernel e gli eventuali sensori fisici possono appartenere all'host condiviso. Il tempo di attività del container viene mostrato solo se il sistema lo rende distinguibile da quello dell'host. Il tempo del servizio indica da quanto è avviata l'applicazione.

Hostname e indirizzi si leggono localmente: non vengono effettuate ricerche DNS, connessioni verso siti esterni o scansioni di rete. Queste informazioni e lo storico sono accessibili soltanto dopo il login. I valori assenti rimangono **—**.

## Spazio libero e stima prima della pulizia

La barra mostra lo spazio disponibile nell'archivio e nel disco del sistema. Se sono lo stesso filesystem, il dettaglio lo indica senza contarli come due risorse indipendenti.

**Before cleanup / Prima della pulizia** indica il tempo approssimativo al ritmo recente delle telecamere che stanno effettivamente registrando. Per ciascuna si usano al massimo gli ultimi tre file completati nelle 24 ore precedenti; si calcola il consumo medio in byte al secondo e si sommano i consumi delle telecamere. Dallo spazio libero viene sottratta la riserva effettiva dell'archivio, pari al **5% della capacità del filesystem**. Se anche una sola camera attiva non ha campioni sufficienti, non viene proposta una durata ottimistica. La prima registrazione di una nuova telecamera deve quindi completare un file prima di contribuire alla stima.

È una stima: bitrate variabile, telecamere aggiunte o spente, conversioni in cache e altri file sul disco possono modificarla. La conservazione per giorni può eliminare registrazioni prima della soglia di spazio. L'NVR continua a gestire automaticamente i file secondo queste regole; il tempo indicato non è una promessa sulla durata dell'archivio né un conto alla rovescia allo spegnimento del recorder.

Con **meno del 10% di spazio libero** compare un avviso. Quando l'archivio scende **sotto il 5%**, la rotazione automatica rimuove i filmati completati idonei più vecchi per recuperare almeno il 5%. Gli originali aperti o protetti da operazioni in corso vengono saltati. Se non è possibile liberare spazio sufficiente, il recorder sospende la registrazione. La pulizia può lasciare l'archivio ancora sotto il 10%, quindi l'avviso può restare presente. [Regole di conservazione](recordings.md#conservazione-e-spazio-libero).

## CPU e temperatura

La percentuale CPU deriva dalla differenza tra due letture successive. All'apertura può comparire un trattino mentre viene preparato il primo campione. I dati mancanti o non accessibili restano indicati come non disponibili.

Nel container il 100% rappresenta la capacità assegnata: per esempio, con due CPU disponibili, indica l'uso complessivo di quelle due CPU. Il recorder considera i limiti visibili al container e non presenta la potenza dell'intero nodo Proxmox come se fosse a propria disposizione. Su una macchina Linux usa invece i contatori del sistema. Sono misure istantanee: una conversione video può produrre un picco senza indicare un problema persistente.

La temperatura appare soltanto quando è leggibile un sensore riconosciuto. In un container spesso non è disponibile e viene mostrato **—**. Un eventuale sensore fisico visibile dal container è indicato esplicitamente come **Host temperature / Temperatura host**: non è una temperatura attribuibile al container. I dati termici non vengono ricavati dal carico CPU e non sono inventati quando manca un sensore.

## RAM e swap

Nel container il valore principale della RAM è la memoria addebitata al suo gruppo di risorse, **compresa la cache dei file**. Il totale rappresenta il limite disponibile. Per esempio, un container con 4 GB di RAM viene confrontato con quei 4 GB, anche se il nodo che lo ospita ne possiede molti di più.

Una parte della RAM può essere cache recuperabile: leggere e registrare video può farla crescere. Una percentuale alta, da sola, non dimostra quindi che la memoria sia esaurita. Quando disponibile, il dettaglio del working set è una stima ottenuta sottraendo la cache dei file inattivi; non è una misura esatta della memoria immediatamente liberabile. Su una macchina Linux il valore principale usa invece la stima del sistema della memoria non disponibile per nuove applicazioni, calcolata da memoria totale e disponibile.

Lo swap è mostrato separatamente dalla RAM. **No swap / Nessuno swap** indica un totale noto pari a zero; un dato illeggibile o sconosciuto resta **—**. Un limite consentito al container non garantisce che il nodo disponga sempre di spazio fisico di swap utilizzabile.

## Archivio e disco del sistema

Il disco principale è quello che contiene la directory delle registrazioni. Quando il sistema operativo usa un filesystem diverso, il widget mostra anche la sua percentuale: un archivio con spazio disponibile non esclude che il piccolo disco del sistema sia pieno. I dettagli riportano capacità, spazio occupato e spazio libero nei rispettivi filesystem.

Se archivio e sistema si trovano sullo stesso filesystem, non vengono presentati come due dischi distinti: rimangono la percentuale occupata dell'archivio e lo spazio libero. Il valore libero riguarda lo spazio disponibile al servizio. Questi indicatori descrivono i filesystem accessibili all'NVR; lo spazio fisico e gli eventuali pool di archiviazione del nodo Proxmox si controllano separatamente.

Lo spazio ridotto del disco del sistema viene segnalato. L'NVR non elimina file del sistema operativo per risolverlo: la rotazione può agire soltanto sugli originali idonei dell'archivio configurato, anche se archivio e sistema condividono il filesystem.

Gli indicatori descrivono lo stato e la politica automatica dell'archivio; non modificano limiti CPU/RAM, swap o configurazione dei dischi. La raccolta è locale e non richiede un servizio cloud o l'accesso amministratore del nodo Proxmox.

## Origine dei dati

Su Linux vengono letti i contatori disponibili in `/proc`, nei gruppi di risorse del container e nei sensori esposti da `/sys`. I gruppi cgroup v2 distinguono memoria corrente e swap; i sistemi v1 usano contatori diversi. In un container LXC, LXCFS può fornire contatori `/proc` virtualizzati con i limiti del container, anche quando i limiti ereditati non sono esposti nella sua gerarchia. L'interfaccia segnala i dati che non possono essere ricostruiti con affidabilità. [Gruppi di risorse Linux](https://docs.kernel.org/admin-guide/cgroup-v2.html), [contatori di memoria del sistema](https://docs.kernel.org/filesystems/proc.html#meminfo), [LXCFS](https://linuxcontainers.org/lxcfs/introduction/), [sensori hardware](https://docs.kernel.org/hwmon/sysfs-interface.html).
