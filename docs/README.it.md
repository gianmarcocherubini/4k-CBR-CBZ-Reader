<p align="center">
  <a href="https://www.manga-dana.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/gianmarcocherubini/Mangadana/main/public/brand/wordmark-dark.png">
      <img src="https://raw.githubusercontent.com/gianmarcocherubini/Mangadana/main/public/brand/wordmark-light.png" width="360" alt="Mangadana">
    </picture>
  </a>
</p>

<p align="center"><a href="https://www.manga-dana.com">www.manga-dana.com</a></p>

# Mangadana — documentazione (italiano)

> Documentazione completa in italiano: manuale d'uso, dettagli tecnici della super risoluzione, formati e limiti,
> pubblicazione su GitHub Pages, dominio e note operative. La presentazione pubblica del progetto è nel
> [README](../README.md) principale, in inglese.


Lettore di fumetti e manga per iPad, come **web app installabile (PWA)**: tutto gira nel browser, nessun server.
Il nome viene da 漫画 (manga) e 棚 (*dana*, da 本棚 *hondana*, lo scaffale dei libri): lo scaffale dei manga. Il
marchio è la corona del set «Extras» del carattere Sprite Graffiti di Fontfabric (licenza gratuita per uso
commerciale: loghi e immagini statiche sono permessi; il font non viene incorporato nell'app, il marchio è un
tracciato SVG in `src/components/crown.json`, disegnato da `Brand.tsx` e da `scripts/make-brand-assets.mjs`, che
genera le immagini di avvio iOS, l'anteprima social, il wordmark di questo README e la favicon; le icone sono in
`public/icons/`). Importa file **CBZ/ZIP** (anche protetti da password), **CBR** (RAR), **CBT** (tar), **PDF** ed **EPUB** a
layout fisso fino a 10 GB ciascuno, li
tiene nell'archiviazione dell'app anche offline e li mostra a piena risoluzione con lettura da destra a sinistra,
doppia pagina intelligente e super risoluzione AI sulla GPU.

## Requisiti

- Node.js 20+ (sviluppato con Node 24) e npm.
- Per leggere: l'app installata sulla schermata Home di un iPad con iPadOS 26+ (WebGPU: HD e 4K), iPadOS 17/18 (HD
  su WebGL2), oppure Chrome/Edge desktop.

## Avvio in locale

```bash
npm install
npm run dev          # http://127.0.0.1:4877
```

Apri l'indirizzo nel browser, tocca **Importa** e scegli uno o più `.cbz` / `.cbr` (o trascinali nella finestra).
**Apri senza importare** legge il file scelto direttamente, senza copiarlo nell'archiviazione dell'app: utile se lo
spazio è poco (il segnalibro resta comunque salvato).

Non serve alcun passo di setup: i pesi dei modelli 4K sono nel repository (1,2 MB precaricati, 8,9 MB scaricati alla
prima scelta di Slow) e vengono distribuiti con l'app.

Altri comandi:

```bash
npm run build        # build di produzione in dist/ (con service worker)
npm run preview      # serve dist/ su http://127.0.0.1:4878
npm test             # test unitari (Vitest)
npm run fixtures     # genera i CBZ/CBR di prova in e2e/fixtures
npm run test:e2e     # test end-to-end (Playwright; la prima volta: npx playwright install chromium)
npm run check        # lint + typecheck + test + build
```

I test end-to-end del progetto `webgpu` (`e2e/sr.spec.ts`) usano il browser completo in modalità headless nuova, così la
super risoluzione gira sulla GPU reale (o su SwiftShader in CI); con `E2E_PREVIEW=1 npm run test:e2e` girano contro la
build di produzione e verificano anche il funzionamento offline.

## Interfaccia

Un monocromo caldo con una sola tinta d'accento, nello spirito delle superfici di Cursor (inchiostro su avorio,
avorio su quasi nero, linee sottili come inchiostro a bassa opacità, etichette piccole in maiuscoletto, pochissime
ombre) impaginato come l'app Apple TV: barra superiore con il wordmark (corona + Mangadana) e le collezioni a
schede, uno scaffale **Continua a leggere**, poi la griglia delle copertine, che si sollevano al passaggio o al
fuoco. L'icona dell'app è la corona in avorio su inchiostro; la stessa tessera fa da favicon (`favicon.ico` a 16,
32 e 48 px, perché Safari non usa le favicon SVG e cerca `/favicon.ico`; a 16 px il contorno del glifo è
leggermente ispessito per restare leggibile) e da icona monocroma per le schede fissate di Safari
(`icons/mask-icon.svg`). I controlli sono inchiostro o
avorio; l'arancione segna solo l'avanzamento e l'indicatore di risoluzione. L'aspetto segue quello del sistema
(chiaro o scuro); in **Impostazioni → Aspetto** si può forzare, e lo **sfondo di lettura** dietro le pagine può
essere Default (grigio caldo o nero a seconda dell'aspetto), Nero o Bianco.

### Libreria, collezioni e copertine

- La riga di schede sotto la barra raccoglie **Tutti i libri** e le collezioni create dall'utente; i volumi non
  assegnati sono in **Senza collezione**. Le collezioni si riordinano in base all'ultima apertura di un loro volume
  e, tornando dal lettore, quella appena usata viene selezionata.
- **Continua a leggere**: i volumi iniziati e non finiti della collezione selezionata, dal più recente, con pagina e
  avanzamento; un tocco riprende la lettura.
- Il campo **Cerca** nella barra filtra la griglia per titolo. Sopra la griglia, due controlli segmentati la
  **filtrano per stato di lettura** (Tutti, Da leggere, In lettura, Finiti) e la **ordinano** (Recenti: ultima
  apertura poi import più recente; Titolo: ordine naturale, `Vol. 2` prima di `Vol. 10`; Aggiunti: import più
  recente). La scelta resta memorizzata; il conteggio dice «3 di 12 volumi» quando un filtro nasconde qualcosa.
- Ogni collezione può non avere icona, usare una delle icone SVG monocromatiche integrate o un'immagine locale.
  La ricerca **Iconify** è incorporata nel dialogo (set moderni Lucide, Tabler, Phosphor e Material): non si lascia
  l'app; l'SVG scelto viene validato e copiato nel database locale. Un PNG/JPEG personale viene limitato a 2 MB /
  4 MP, ridotto a 128×128 e salvato localmente. “Tutti i libri” usa un'icona libreria dedicata.
- **Copertine e icone sono salvate come byte dentro il record** di IndexedDB, non come Blob: WebKit tiene i Blob
  di IndexedDB in file separati che una web app installata può perdere dopo un riavvio o una pulizia del sistema
  (il record resta, l'immagine diventa illeggibile e la copertina appare rotta). I record delle versioni
  precedenti vengono convertiti alla prima lettura; un Blob non più leggibile viene scartato e la libreria
  **ricostruisce la copertina dalla prima pagina** del volume (la copertina predefinita), un paio di volumi per
  volta. Un'immagine che comunque non si decodifica mostra il segnaposto, mai l'icona rotta del browser.
- Il pulsante `…` di un volume apre **Modifica volume**: rinomina il titolo, lo sposta in una collezione, cerca una
  nuova copertina o lo elimina. Eliminare una collezione riporta i suoi volumi in Senza collezione.
- Dopo un import l'app propone la ricerca copertine, ma prima chiede un consenso esplicito: interroga insieme **Open
  Library** (edizioni/volumi) e **AniList** (copertina della serie manga), inviando soltanto il titolo ripulito, mai
  file o pagine. I redirect delle immagini Open Library non sono compatibili CORS, quindi vengono scaricati tramite
  `images.weserv.nl`; le immagini AniList arrivano direttamente dalla CDN CORS. Risultati e immagini hanno limiti di
  byte/pixel, al massimo otto anteprime (due download concorrenti), timeout e annullamento; la scelta viene
  normalizzata in JPEG e salvata localmente. Gli ZIP protetti non vengono cercati automaticamente; la ricerca manuale
  resta disponibile.

### Backup della libreria

Il pulsante `…` nella barra apre **Backup della libreria**; nella libreria vuota c'è anche **Ripristina da un
backup**. Il backup è un file JSON (`Mangadana-backup-AAAA-MM-GG.json`) con tutto ciò che l'utente ha aggiunto ai
file: titoli, collezioni con le loro icone, copertine scelte online, segnalibri (pagina, pagine bianche inserite) e
impostazioni di lettura. **Non contiene i CBZ/CBR**: un volume è identificato da nome e dimensione del file, la stessa
chiave con cui l'import riconosce i duplicati. Su iPad il file passa dal foglio di condivisione (Salva su File,
AirDrop, iCloud Drive); dove il foglio non c'è viene scaricato.

Il ripristino non cancella mai nulla:

- una collezione del backup riusa quella locale con lo stesso id o lo stesso nome, altrimenti viene creata;
- un volume il cui file è già in libreria prende titolo e collezione dal backup solo se qui non era mai stato
  modificato, la copertina scelta se quella locale è la miniatura dell'archivio, e il segnalibro più recente dei due;
- gli altri volumi restano **in attesa** (store `pendingRestores` di IndexedDB, schema 3): la libreria mostra
  quanti sono e il loro elenco; appena si importa un file con lo stesso nome e dimensione, titolo, collezione,
  copertina e segnalibro tornano da soli. «Ignora tutti» dimentica i dati in attesa.

Il file viene validato campo per campo (formato e versione, tipi, riferimenti alle collezioni, immagini solo
JPEG/PNG/WebP fino a 2 MB, al massimo 50.000 voci); un file che non è un backup viene rifiutato con un messaggio
chiaro. Serve anche per cambiare iPad o per seguire l'app dal vecchio indirizzo github.io al dominio.

### Cataloghi web (sperimentale)

Il pulsante **Cataloghi** nella barra apre un pannello in cui aggiungere l'indirizzo di un sito che pubblica serie a
capitoli (o a volumi) come pagine di immagini. Nessun sito è incorporato nell'app: il catalogo lo indica l'utente, e
resta memorizzato solo sul dispositivo (`reader.catalogs.v1`). Mangadana legge le pagine del sito **come farebbe
Safari** (stesse richieste, senza cookie né credenziali, `referrer` omesso) e riconosce una struttura generica:

- nella pagina iniziale, i link a un solo segmento di percorso (`/nome-serie`) con un'immagine e un titolo sono le
  **serie** (titolo, autore, riga descrittiva, copertina);
- nella pagina di una serie, i link `/nome-serie/chapter/N` o `/nome-serie/volume/N` sono i **capitoli o volumi**
  (numero, titolo, numero di pagine, edizione «colore parziale» / «bianco e nero» quando il sito la indica);
- nella pagina di un capitolo, le `<img>` grandi dentro `<main>` sono le **pagine**, nell'ordine in cui compaiono.

Si sceglie un intervallo (al massimo **10 capitoli o 2 volumi** per volta) e l'app scarica le pagine, poche alla
volta, le impacchetta in un CBZ (`Serie — Cap. 001-010.cbz`, una cartella per capitolo così l'ordine naturale
resta quello giusto) e lo importa come un volume qualsiasi, in una **collezione con il nome della serie**, creata se
manca. Ogni immagine viene verificata (formato reale, dimensioni) prima di entrare nell'archivio; limiti su byte per
pagina e per pagina HTML; una pausa tra un capitolo e l'altro; nessuna scansione in sottofondo. Il sito deve
permettere la lettura dal browser (intestazioni CORS): altrimenti l'app lo dice e non c'è niente da fare senza un
server, che Mangadana non ha.

Perché tutto questo funzioni, la Content Security Policy dell'app permette connessioni e immagini verso qualunque
origine `https:` (prima erano elencate una per una); il codice eseguibile resta solo quello dell'app.

**Responsabilità.** I cataloghi sono siti di terzi: i contenuti sono responsabilità loro e di chi li scarica.
L'app avvisa di verificare di avere il diritto di scaricare e di rispettare le condizioni d'uso del sito, e si
comporta come un lettore (pochi capitoli, su richiesta), non come un crawler.

## Come si usa il lettore

- **Tocco ai lati**: in modalità manga (destra → sinistra) il tocco a sinistra va avanti, a destra indietro. Tocco al
  centro: mostra/nasconde le barre. Funzionano anche scorrimento orizzontale, frecce, spazio, PagSu/PagGiù, Home/Fine.
- **Doppia pagina intelligente**: le pagine verticali vengono accoppiate, le tavole doppie (orizzontali) restano da sole
  e la coppia riparte dopo. La copertina sta da sola e le coppie partono da 2-3; se un volume non combacia si usa
  **Pagina bianca qui**. Con **Automatica** la doppia pagina si attiva con lo schermo in orizzontale.
- **Pagina bianca qui**: se in un punto le coppie non combaciano (una pagina pubblicitaria in mezzo, per esempio),
  inserisce una pagina bianca prima di quella corrente e le coppie seguenti si spostano di una. Si ricorda per volume.
- **Spazio centrale**: il margine tra le due pagine, bianco di default come la piega di un libro; in Impostazioni si
  sceglie la larghezza (nessuno, stretto, medio, largo) e il colore (bianco, carta, sfondo).
- **Zoom**: pizzico, doppio tocco al centro (×2,5) e Ctrl + rotella. Alla fine del gesto la pagina viene ridisegnata
  alla nuova dimensione, quindi resta nitida. Adattamento: schermo, altezza, larghezza, 1:1 (un pixel dell'immagine
  per pixel dello schermo).
- **Segnalibro**, dimensioni delle pagine e pagine bianche vengono salvati per ogni volume: si riprende dove si era
  rimasti e la suddivisione in coppie è stabile tra una sessione e l'altra.
- **Transizione** tra le pagine: scorrimento (default), dissolvenza o nessuna (cambio istantaneo).
- **Schermo intero durante la lettura** (attivo di default): in Safari l'app va davvero a schermo intero e la barra di
  stato dell'iPad (ora, Wi-Fi, batteria) e l'indicatore Home scompaiono. Nell'app **installata sulla Home** iOS non
  permette di nascondere la barra di stato: la barra resta opaca (chiara o scura come il sistema) e l'app usa tutto
  ciò che sta sotto, fino al bordo inferiore, indicatore Home compreso. Lo stile traslucido della barra non viene
  usato: su iPad sposta la web view verso il basso e lascia una fascia nera inutilizzata in fondo allo schermo.
- **Indicatore HD / 4K**: una piccola etichetta in alto a destra (nascosta quando le barre sono visibili,
  disattivabile): accesa (arancione) quando la risoluzione scelta è applicata a tutte le pagine sullo schermo,
  attenuata mentre elabora, barrata quando non è disponibile. Il testo completo è nell'etichetta accessibile
  (`HD ×4 UL`, `4K ×4 v3`, `4K ×4 6B`, `HD…`, `HD n/d`).
- Lo schermo resta acceso durante la lettura (Wake Lock).

## Risoluzione

Una sola scelta in **Impostazioni → Risoluzione**: **HD** (default, tutto automatico) oppure **4K · Sperimentale**
con un **Rendering** a tre velocità ordinate per qualità, **Fast**, **Medium** e **Slow · massima**: la più lenta è
la migliore. Entrambi i livelli lavorano **solo sulle pagine sullo schermo** (una, o due in doppia pagina): nessuna
pre-elaborazione delle pagine seguenti, nessun lavoro in coda, nessuna cache su disco. Voltando pagina, ciò che era
in corso per la pagina precedente viene annullato e la GPU si occupa esclusivamente della nuova. I risultati recenti
restano in una piccola cache in memoria (limitata in byte), così tornare indietro di una pagina è immediato. Tutto
gira nel processo della pagina: nessun worker WebAssembly, nessun runtime da scaricare.

| Scelta | Rete | Passaggi | Tempo per pagina (iPad M) |
| --- | --- | --- | --- |
| HD | Anime4K Upscale_CNN_x2 (livello e fattore automatici) | 1–2 | < 0,5 s |
| 4K Fast | Real-ESRGAN anime video v3 | 1 | ~1 s |
| 4K Medium | Real-ESRGAN anime video v3 | 4 (self-ensemble) | ~4 s |
| 4K Slow · massima | Real-ESRGAN x4plus anime 6B | 1 | ~7 s |

### HD (Anime4K)

Ogni pagina viene ingrandita con la rete **Anime4K Upscale_CNN_x2** sulla GPU, a strisce di 288 righe per usare poca
memoria, **a un fattore fisso rispetto all'originale (×2 o ×4)**, indipendente dallo schermo; il risultato viene poi
**adattato al riquadro** con un ricampionamento Lanczos di alta qualità (mai la sfocatura bilineare del browser). È
il modello "prima la super risoluzione, poi l'adattamento": un solo risultato per pagina serve ogni zoom,
orientamento e impaginazione (lo zoom non ricalcola nulla), e ridurre un ×4 ai pixel dello schermo è ciò che rende
le linee pulite. Obiettivo: la coppia di pagine pronta in **meno di due secondi**.

- **Livello** automatico: parte da VL, misura il tempo della prima pagina e sceglie il livello più forte che sta
  sotto 800 ms per pagina (UL solo se la GPU lo consente; con 2–4 GB di RAM si ferma a M/VL), deciso una volta e mai
  rialzato nella sessione.
- **Fattore** automatico: **×4** (due passaggi, il secondo al livello M) quando il risultato sta nel limite di 16 MP
  dei canvas di Safari e nel bilancio di memoria (pagine fino a ~1 MP, cioè i tipici 800×1200), altrimenti ×2.
- Livello, fattore, passaggio *Restore* e pulizia della scansione non sono più esposti: restano nel motore e nelle
  impostazioni salvate (`srLevel`, `srScale`, `srRestore`, `srClean`), dove i test end-to-end li fissano.
- **Backend automatico**: WebGPU (iPadOS 26+); su iPadOS 17/18 gli stessi shader ufficiali girano su **WebGL2**
  (risultato verificato equivalente: 54,6 dB tra i due backend); senza GPU utilizzabile, ridimensionamento del browser.
  Se il sistema toglie il dispositivo GPU all'app (ad esempio dopo una sospensione in background) l'app lo ricrea da
  sola. Le impostazioni dicono sempre backend, livello, fattore, dimensione di uscita e tempo stimato.
### 4K · Sperimentale (Real-ESRGAN)

Due reti Real-ESRGAN, entrambe implementate **direttamente in WGSL** su WebGPU (niente ONNX Runtime, niente
WebAssembly), scelte dal **Rendering**:

- **Fast** e **Medium**: `realesr-animevideov3`, SRVGGNetCompact (3→64, 16 convoluzioni 64→64 con PReLU, 64→48,
  pixel shuffle ×4; 621k parametri, BSD-3). Circa **1 s per pagina** su un iPad M-series in un passaggio (Fast);
  Medium ne fa quattro su copie riflesse e ne fa la media (self-ensemble, sotto).
- **Slow · massima**: `RealESRGAN_x4plus_anime_6B`, RRDBNet con 6 blocchi residual-in-residual dense (3 blocchi
  densi da 5 convoluzioni ciascuno, 64 feature, 32 canali di crescita, scala residua 0,2, coda con due upsample
  nearest + convoluzioni; 4,47 M parametri, BSD-3). Nove volte il lavoro di v3: misurati **~7 s per pagina** in
  f16 su un iPad M. I pesi (8,9 MB in FP16) non sono precaricati: vengono
  scaricati e messi in cache dal service worker la prima volta che il modello viene scelto.
  Implementazione: quattro buffer di feature a rotazione, buffer di crescita a 128 canali riempito per copia dopo
  ogni convoluzione densa (una dispatch WebGPU non può leggere e scrivere lo stesso buffer), residui ripiegati
  nell'epilogo delle convoluzioni, coda ×4 a strisce di 8 righe con 2 righe di contesto (64 canali a ×4 per una
  fascia intera non starebbero in memoria). Le giunzioni tra fasce non sono esatte al bit (campo recettivo teorico
  ~100 px contro 24 di contesto) ma la differenza misurata è ≤ 2/255 (62,8 dB con fasce forzate a 8 righe).

- Il **Rendering** è la scelta del tempo: non c'è più un'«attesa massima». All'attivazione l'app compila gli shader
  e **misura la GPU** su un'immagine di prova; la riga di stato riporta la stima per le pagine sullo schermo e il
  tempo dell'ultima pagina. Resta un limite di sicurezza (60 s per coppia): un dispositivo troppo lento per il 4K
  mostra la coppia in HD e lo dice.
- **Self-ensemble** (Medium): la rete viene eseguita sulle quattro copie ribaltate della pagina e i risultati,
  riportati nell'orientamento originale, vengono mediati sulla GPU: gli artefatti direzionali della rete si
  cancellano e i bordi restano più puliti. È un moltiplicatore di qualità pagato in tempo (quattro passaggi). Il
  runner WebGPU lo supporta anche per il 6B (coda ×4 in un buffer nell'orientamento trasformato, kernel che lo
  riporta in quello originale accumulando, media nella pagina) e i test lo verificano, ma Slow usa un passaggio: a
  secondi per passaggio significherebbe un minuto per pagina.
- **Sfocatura anti-spoiler** (interruttore, attivo di default): mentre la versione 4K viene calcolata la pagina
  resta sfocata (sfocatura che "respira") e si rivela nitida solo quando è pronta.
- **Kernel scelto sul dispositivo**: le convoluzioni esistono in tre versioni. Due dirette a risultato identico,
  un thread per 4 pixel di una riga (16 accumulatori) o per 4 pixel di due righe (32 accumulatori: metà dei
  caricamenti di pesi per moltiplicazione e righe d'ingresso condivise). La terza è **Winograd F(2×2, 3×3)**: la
  convoluzione 3×3 su una tessera 4×4 d'ingresso produce 2×2 uscite con 16 moltiplicazioni per coppia di canali
  invece di 36 (2,25× in meno); i pesi vengono trasformati una volta sulla CPU (G g Gᵀ), un kernel trasforma le
  tessere d'ingresso (Bᵀ d B, 16 quad per tessera, a blocchi di righe entro 32 MB), un secondo kernel esegue le 16
  moltiplicazioni di matrici per posizione con le tessere condivise nella memoria del workgroup e accumula la
  trasformata d'uscita (Aᵀ M A) nei registri, con gli stessi epiloghi (bias, attivazione, residui). In f32 è
  identico al bit al kernel diretto sul 6B; in f16 le trasformate arrotondano diversamente, quindi all'attivazione
  l'app cronometra le tre versioni sull'immagine di prova, confronta l'uscita Winograd con quella diretta e la
  tiene solo se è la più veloce **e** coincide (≥ 44 dB, differenza massima 4/255); altrimenti libera i suoi buffer
  (che vengono allocati solo quando Winograd gira davvero: pesi trasformati, tessere, parametri). L'esito è
  ricordato per dispositivo, modello, precisione e versione dell'app: le attivazioni successive misurano solo il
  kernel scelto. La riga di stato mostra il kernel e l'esito di Winograd («tenuto», «scartato per precisione» o
  «scartato perché più lento del kernel scelto», con decibel, differenza massima e tempi sulla prova). Su un iPad M in f16 Winograd è risultato
  più lento del kernel diretto (0,42 s contro ~0,35 s sulla prova) e meno preciso (51 dB, max 9/255): l'ingresso
  trasformato è 4× le attivazioni e passa due volte dalla memoria, ~260 GB per pagina sul 6B, mentre il kernel
  diretto in f16 lavora già a ~2 TFLOPS effettivi. Winograd conviene dove il limite è il calcolo, non la banda.
- **Coda ×4 del 6B a strisce di 16 righe** (+2 di contesto per lato, esatte): 25% di contesto ricalcolato invece
  del 50% delle strisce da 8, a risultato identico.
- La pagina resta com'è finché il risultato non è pronto, poi cambia una volta sola; in doppia pagina le due pagine
  passano a HD insieme. Risultato a fattore fisso (×4; ×2 come media 2×2 del ×4 solo se il ×4 supererebbe i 16 MP),
  poi adattato allo schermo come per Anime4K.
- **Implementazione**: pesi FP16 (1,2 MB) nel bundle, quindi disponibili anche offline; kernel `conv3x3` con
  register blocking (un thread calcola 4 pixel × 16 canali, i 32 thread di un wavefront leggono gli stessi pesi),
  attivazioni e aritmetica in `f16` dove la GPU espone `shader-f16` (altrimenti `f32`, con fallback automatico se i
  kernel f16 vengono rifiutati). La pagina è elaborata a fasce orizzontali con 24 px di contesto (campo recettivo
  18 px), quindi le giunzioni sono esatte; il pixel shuffle, il residuo e la conversione RGBA8 avvengono sulla GPU e
  la pagina viene letta una sola volta. Se il modello fallisce a runtime, il volume prosegue con Anime4K.
- **Verifica**: un'implementazione di riferimento in float32 (`reference.ts`, entrambe le reti) riproduce l'output
  di PyTorch dagli stessi pesi (fixture nel repository, differenza massima 2/255); i kernel WebGPU vengono
  confrontati con il riferimento nei test end-to-end (`window.__reader.esrganSelfTest`, anche con fasce forzate a
  8 righe e con il self-ensemble a 8 passaggi): v3 95 dB in f32 e ×2 identico al bit, ensemble 59 dB (il
  riferimento arrotonda ogni passaggio a 8 bit), 6B identico al bit su una fascia e 59 dB con il self-ensemble a 8
  passaggi (passaggi trasposti inclusi, anche su più fasce).

I pesi si rigenerano dai checkpoint ufficiali con `scripts/convert-realesr-weights.py` (solo numpy, nessun PyTorch;
riconosce entrambe le architetture dai nomi dei tensori).

## Formati e limiti

| Formato | Supporto |
| --- | --- |
| CBZ / ZIP, anche ZIP64 | Sì. Lettura voce per voce dal file, senza caricarlo in memoria. |
| ZIP con password | Sì: AES e ZipCrypto, una password per archivio. L'app la chiede e ripropone il campo se è errata. |
| CBR / RAR 4 e RAR 5 | Sì, tramite unrar (WebAssembly) in un worker con letture a finestra sul file. |
| RAR "solido" o multi-volume | No: messaggio esplicito. Ricomprimere senza l'opzione solido. |
| RAR cifrati / directory centrale ZIP cifrata | No: messaggio esplicito. |
| CBT / tar | Sì: tar non compresso, ogni pagina è una fetta del file (ustar, nomi lunghi GNU, pax). |
| PDF | Sì, anche protetti da password. Ogni pagina viene resa con pdf.js **alla risoluzione dell'immagine più grande che contiene** (un fumetto in PDF è un'immagine per pagina), quindi senza perdere né inventare dettaglio; le pagine senza immagini a 144 dpi. Il file viene letto a intervalli (`PDFDataRangeTransport` su `Blob.slice`), mai caricato intero; il parser gira in un worker dedicato per documento, caricato alla prima apertura (build «legacy» di pdf.js, con i polyfill per iPadOS 17/18). |
| EPUB a layout fisso | Sì: le immagini delle pagine dello *spine*, nell'ordine di lettura (`container.xml` → OPF → manifest e spine → `<img>`/`<image>` di ogni XHTML); le pagine di solo testo vengono saltate. Se il pacchetto non si legge, le immagini in ordine naturale. Gli EPUB cifrati come ZIP si aprono con la password come i CBZ. |
| CB7 / 7z | No: i 7z di fumetti sono quasi sempre «solidi» (un unico flusso compresso), il che esclude la lettura pagina per pagina. |
| Immagini | JPEG, PNG, GIF, WebP, BMP, AVIF, HEIC (quelle che il browser sa decodificare). |

Le pagine sono ordinate in modo naturale (`2.jpg` prima di `10.jpg`), ignorando `__MACOSX`, file nascosti e
`ComicInfo.xml`.

**Password e riservatezza**: la password resta soltanto nella memoria della pagina e viene dimenticata al reload o
alla chiusura dell'app; non finisce in IndexedDB, OPFS, log o copertina. Per questo gli ZIP protetti non hanno
miniatura persistente; le pagine migliorate dalla super risoluzione restano comunque solo in RAM, per ogni volume.
Alla riapertura l'app chiede nuovamente la password.

**Spazio e file multi-GB**: l'import copia il file nell'Origin Private File System (OPFS) da un worker con letture
`Blob.slice()` seriali da 4 MB e `flush()` ogni 64 MB. Non usa `File.stream()`, che su WebKit può ignorare la
backpressure e accumulare centinaia di MB fino a far chiudere la PWA. Prima di copiare chiede lo storage persistente
e controlla quota + 256 MB di margine per i file da almeno 1 GB. Se OPFS manca, IndexedDB è usato solo fino a 256 MB:
oltre viene mostrato un errore invece di rischiare il crash. Le copie parziali vengono eliminate su errore; un Web
Lock (lease con heartbeat sui browser più vecchi) coordina le tab e la pulizia periodica rimuove gli orfani lasciati
da un crash. Verifiche: copia OPFS reale da 1 GiB in
7,0 s; simulazione completa degli offset di 8 GiB con al massimo 4 MB in memoria.

Il parser ZIP usa un `BlobReader` limitato che impedisce a qualunque EOCD/ZIP64 scelto da zip.js di richiedere una
singola allocazione oltre 64 MB, parsing bilanciato, massimo 50.000 voci / 20.000 pagine e 64 MB per pagina. Password
e integrità sono verificate sull'intera prima pagina cifrata (CRC per ZipCrypto, codice di autenticazione per AES),
non soltanto sull'header. Prima della decodifica vengono controllate le dimensioni JPEG/PNG/GIF/WebP/BMP/AVIF/HEIF
(massimo 32 MP); i formati di cui non si possono verificare le dimensioni vengono rifiutati. La cache pagine usa al
massimo due decodifiche contemporanee e un budget di 256 MB, proteggendo solo lo spread visibile.

## Installazione su iPad

1. Apri [www.manga-dana.com](https://www.manga-dana.com) in Safari (in locale serve HTTPS o un tunnel su `localhost`).
2. **Condividi → Aggiungi alla schermata Home**.
3. Apri l'app dalla Home e **importa i file da lì**: l'app installata ha uno spazio di archiviazione separato da
   Safari (fino al 60 % del disco, non soggetto alla scadenza dei 7 giorni). Il piè di pagina della libreria mostra lo
   spazio usato.

All'avvio iPadOS mostra per un istante la **schermata di avvio** dell'app: la corona sullo sfondo dell'aspetto in uso
(avorio o quasi nero), per ogni modello di iPad e orientamento. Le immagini (`public/splash/`, PNG indicizzati da
~13 KB) e i `<link rel="apple-touch-startup-image">` con le media query vengono generati dalla tabella dei dispositivi
`scripts/splash-devices.json` (`scripts/make-brand-assets.mjs` e `vite.config.ts`); iOS scarica solo quelle del
dispositivo, e non fanno parte della cache offline.

## Pubblicazione su GitHub Pages

Il workflow `.github/workflows/deploy.yml` esegue lint, typecheck, test, build e test end-to-end sulla build, poi
pubblica `dist/` su GitHub Pages a ogni push su `main`. Nel repository: **Settings → Pages →
Source: GitHub Actions**. Il percorso base viene letto dalla configurazione di Pages (`actions/configure-pages`):
`/Mangadana/` se l'app fosse servita da `gianmarcocherubini.github.io`, `/` con il dominio proprio. In locale vale il
nome del repository, oppure `VITE_BASE=/`.

### Dominio www.manga-dana.com

Il dominio è registrato su IONOS (name server `ui-dns.*`). Il certificato **SSL Starter** incluso da IONOS non va
configurato (né «con il mio sito web IONOS», che lo installerebbe sui loro server, né «con il mio server»): GitHub
Pages non accetta certificati esterni ed emette il proprio, gratuito (Let's Encrypt), quando si spunta *Enforce
HTTPS*. Per collegare il dominio a GitHub Pages, nell'ordine:

1. **DNS (IONOS → Domini & SSL → manga-dana.com → DNS)**. Il dominio nudo (`@`) nasce con i record del parcheggio
   IONOS, `A 217.160.0.37` e `AAAA 2001:8d8:100f:f000::200`: vanno **sostituiti** con quelli di GitHub (un AAAA che
   non punta a GitHub fa fallire il controllo DNS). MX, TXT (SPF), `autodiscover` e `_domainconnect` restano.
   Record finali:

   | Nome | Tipo | Valore |
   | --- | --- | --- |
   | `www` | CNAME | `gianmarcocherubini.github.io.` |
   | `@` | A | `185.199.108.153` |
   | `@` | A | `185.199.109.153` |
   | `@` | A | `185.199.110.153` |
   | `@` | A | `185.199.111.153` |
   | `@` | AAAA | `2606:50c0:8000::153` |
   | `@` | AAAA | `2606:50c0:8001::153` |
   | `@` | AAAA | `2606:50c0:8002::153` |
   | `@` | AAAA | `2606:50c0:8003::153` |

   Verifica: `dig +short www.manga-dana.com CNAME` deve rispondere `gianmarcocherubini.github.io.`.
2. **GitHub → Settings → Pages → Custom domain**: `www.manga-dana.com`, **Save**, attendere il controllo DNS, poi
   spuntare **Enforce HTTPS** (il certificato arriva in pochi minuti). Con i record A sul dominio nudo, GitHub
   reindirizza da solo `manga-dana.com` → `www.manga-dana.com`. Consigliato anche **Settings (profilo) → Pages →
   Add a domain** per verificare il dominio e impedire che altri repository lo reclamino.
3. **Actions → Build and deploy to GitHub Pages → Run workflow** (se l'ultimo deploy è precedente al dominio): la
   build precedente ha il percorso base del repository su github.io e sul dominio non caricherebbe gli asset (pagina
   vuota); il workflow rilegge la configurazione e ricostruisce con base `/`. Da qui `gianmarcocherubini.github.io/Mangadana/`
   reindirizza al dominio.
4. **Settings → General → Social preview**: caricare `public/brand/social-preview.png` (1280×640), la stessa immagine
   usata dai tag Open Graph per le anteprime dei link (iMessage, WhatsApp, X).

**L'app già installata dall'indirizzo github.io** ha il suo spazio di archiviazione legato a quell'origine: non
può seguire il dominio. Continua a funzionare dalla cache del service worker (libreria compresa), ma dal momento in
cui github.io reindirizza al dominio il suo service worker non trova più aggiornamenti (un redirect fa fallire
l'aggiornamento), e resta alla versione che aveva. Il repository, inoltre, è stato rinominato da `4k-CBR-CBZ-Reader`
a `Mangadana`: il vecchio percorso `gianmarcocherubini.github.io/4k-CBR-CBZ-Reader/` non esiste più.

- Se quella versione ha già il backup (0.9.0 o successiva), appena rileva che il dominio risponde mostra nella
  libreria il banner **Nuovo indirizzo** con il percorso: esportare un backup, installare l'app da
  www.manga-dana.com, ripristinare il backup e importare di nuovo i file (vedi *Backup della libreria*).
- Se è precedente (0.8.0 o prima, senza backup), serve un **ponte** temporaneo: un repository con il vecchio nome
  `4k-CBR-CBZ-Reader` che pubblichi su GitHub Pages la build corrente con base `/4k-CBR-CBZ-Reader/`. Il workflow
  pronto è `docs/github-io-bridge.yml` (da copiare nel repository ponte come `.github/workflows/pages.yml`: prende
  il codice da `Mangadana`, costruisce e attiva Pages da solo). Alla prima apertura la vecchia app si aggiorna da
  lì, mostra il banner e permette l'esportazione; poi il repository ponte si elimina.

Il service worker precarica l'intera app, compresi gli shader Anime4K e i pesi di Real-ESRGAN: dopo la prima
apertura tutto funziona offline. Non servono intestazioni COOP/COEP: non c'è più WebAssembly multi-thread.

**Aggiornamenti**: il piè di pagina della libreria mostra versione, commit e data della build in uso. L'app
installata si aggiorna da sola. A ogni avvio il service worker controlla se su Pages c'è una
versione nuova, la scarica in background e la attiva subito; la libreria mostra il banner "Nuova versione dell'app
pronta · Ricarica", altrimenti la versione nuova è in uso dall'avvio successivo. Una web app su iPad però può
restare aperta o sospesa per giorni senza mai ricaricare la pagina: per questo il controllo viene ripetuto **ogni
volta che l'app torna in primo piano** (al più ogni dieci minuti) e c'è **Controlla aggiornamenti** accanto alla
versione, che interroga il server subito e, se trova una versione nuova, la installa e ricarica da solo («Sei già
alla versione più recente» altrimenti). Non serve rimuovere e ri-aggiungere l'app alla schermata Home; libri,
segnalibri e cache restano al loro posto.

## Flag per i test

- `?storage=idb` forza l'import in IndexedDB invece che in OPFS.
- `?sr=off` disattiva la super risoluzione; `?sr=webgl2` / `?sr=webgpu` forzano il backend Anime4K; `?mqcap=<ms>`
  abbassa il limite di sicurezza del 4K (una coppia stimata oltre resta in HD).
- `?test` espone `window.__reader.importFiles(files)`, `window.__reader.openSession(file)` e
  `window.__reader.esrganSelfTest(opts)` (sempre attivi in sviluppo).

## Struttura

```
src/
  lib/archive/     rilevamento formato, lettore ZIP (zip.js), lettore RAR (worker + Extractor su Blob), lettore tar,
                   lettore PDF (pdf.js, pagine rese a richiesta), spine EPUB
  lib/storage/     IndexedDB (idb), OPFS, worker di copia, import, miniature, backup della libreria
                   (backup.ts: formato, validazione e piano di ripristino; backupActions.ts: file, condivisione)
  lib/reader/      layout delle tavole (con spazio centrale), cache LRU delle pagine
  lib/libraryView.ts  stato di lettura, filtro e ordinamento della griglia
  lib/relocation.ts   avviso «nuovo indirizzo» per le installazioni fuori dal dominio
  lib/spread.ts    accoppiamento intelligente delle pagine e pagine bianche inserite
  lib/upscale/     Anime4K su WebGPU (anime4k.ts) e WebGL2 (glslHooks.ts + webgl2Backend.ts, shader ufficiali in
                   shaders/), motore per le pagine visibili con livello automatico (srEngine.ts), Real-ESRGAN in
                   WGSL (esrgan/: pesi f16, generatore dei kernel, runner a fasce, motore con stima dei tempi,
                   riferimento float32 e self-test)
  components/      libreria, lettore (gesti, barre, impostazioni raggruppate), Brand.tsx + crown.json (marchio)
  sw.ts            service worker (precache dell'app, shader e pesi; offline)
public/            icone e favicon, immagini di avvio iOS (splash/), anteprima social e wordmark (brand/)
scripts/           make-fixtures.mjs (CBZ e CBR di prova), convert-realesr-weights.py (checkpoint → pesi f16),
                   make-brand-assets.mjs + splash-devices.json (immagini di avvio, anteprima social, wordmark, favicon)
e2e/               test Playwright (progetti chromium e webgpu)
docs/, internal/   contesto di progetto, studio di fattibilità della super risoluzione, report
```
