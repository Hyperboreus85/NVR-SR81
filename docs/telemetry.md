# Risorse del sistema nel Monitor

In **Live → Monitor**, tre indicatori compatti mostrano CPU e temperatura, RAM e swap, spazio dell'archivio e del sistema. I controlli **Layout**, pausa/ripresa e schermo intero rimangono sulla destra della stessa barra. I valori riguardano il sistema operativo che esegue il recorder, non il solo processo web.

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

Gli indicatori non modificano limiti CPU/RAM, swap, conservazione dei filmati o configurazione dei dischi. La raccolta è locale e non richiede un servizio cloud o l'accesso amministratore del nodo Proxmox.

## Origine dei dati

Su Linux vengono letti i contatori disponibili in `/proc`, nei gruppi di risorse del container e nei sensori esposti da `/sys`. I gruppi cgroup v2 distinguono memoria corrente e swap; i sistemi v1 usano contatori diversi. In un container LXC, LXCFS può fornire contatori `/proc` virtualizzati con i limiti del container, anche quando i limiti ereditati non sono esposti nella sua gerarchia. L'interfaccia segnala i dati che non possono essere ricostruiti con affidabilità. [Gruppi di risorse Linux](https://docs.kernel.org/admin-guide/cgroup-v2.html), [contatori di memoria del sistema](https://docs.kernel.org/filesystems/proc.html#meminfo), [LXCFS](https://linuxcontainers.org/lxcfs/introduction/), [sensori hardware](https://docs.kernel.org/hwmon/sysfs-interface.html).
