# 4K CBR/CBZ Reader

Lettore di fumetti e manga per iPad, come **web app installabile (PWA)** con un'interfaccia nello stile di Apple
Libri: tutto gira nel browser, nessun server. Importa file **CBZ** (ZIP) e **CBR** (RAR) fino a 10 GB ciascuno, li
tiene nell'archiviazione dell'app anche offline e li mostra a piena risoluzione con lettura da destra a sinistra,
doppia pagina intelligente e super risoluzione AI sulla GPU.

## Requisiti

- Node.js 20+ (sviluppato con Node 24) e npm.
- Per leggere: Safari su iPadOS 17+ (super risoluzione su WebGL2; da iPadOS 26 su WebGPU), oppure Chrome/Edge desktop.

## Avvio in locale

```bash
npm install
npm run setup        # scarica Real-ESRGAN (FP16 9 MB + fallback FP32 17 MB) e onnxruntime in public/ (una sola volta)
npm run dev          # http://127.0.0.1:4877
```

Apri l'indirizzo nel browser, tocca **Importa** e scegli uno o più `.cbz` / `.cbr` (o trascinali nella finestra).
**Apri senza importare** legge il file scelto direttamente, senza copiarlo nell'archiviazione dell'app: utile se lo
spazio è poco (il segnalibro resta comunque salvato).

`npm run setup` serve solo per il livello "Qualità massima": senza, l'app funziona lo stesso e le impostazioni lo
dicono. Se lo esegui mentre `npm run dev` è attivo, riavvia il server (i file in `public/ort` vengono letti all'avvio).

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
super risoluzione gira sulla GPU reale; con `E2E_PREVIEW=1 npm run test:e2e` girano contro la build di produzione e
verificano anche il funzionamento offline.

## Interfaccia

Libreria e lettore seguono lo stile di Apple Libri: titolo grande, copertine con ombra, barre traslucide, controlli
segmentati e interruttori iOS, elenchi raggruppati nelle impostazioni. L'aspetto segue quello del sistema (chiaro o
scuro); in **Impostazioni → Aspetto** si può forzare, e lo **sfondo di lettura** dietro le pagine può essere Default
(grigio chiaro o nero a seconda dell'aspetto), Nero o Bianco.

## Come si usa il lettore

- **Tocco ai lati**: in modalità manga (destra → sinistra) il tocco a sinistra va avanti, a destra indietro. Tocco al
  centro: mostra/nasconde le barre. Funzionano anche scorrimento orizzontale, frecce, spazio, PagSu/PagGiù, Home/Fine.
- **Doppia pagina intelligente**: le pagine verticali vengono accoppiate, le tavole doppie (orizzontali) restano da sole
  e la coppia riparte dopo. **Sfasa coppie** (in Impostazioni) decide se la copertina sta da sola (1 | 2-3 | 4-5…) o si
  accoppia (1-2 | 3-4…); l'impostazione è per volume. Con **Automatica** la doppia pagina si attiva con lo schermo in
  orizzontale.
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
  permette di nascondere la barra di stato, ma l'app usa comunque tutta l'altezza dello schermo (guadagna lo spazio che
  la barra riservava); l'impostazione lo segnala.
- **Indicatore HD**: una piccola icona “HD” in alto a destra (nascosta quando le barre sono visibili, disattivabile):
  accesa (arancione) quando la super risoluzione o Qualità massima sono applicate a tutte le pagine sullo schermo,
  attenuata mentre elaborano, barrata (“non HD”) quando non sono disponibili. Il testo completo è nell'etichetta.
- Lo schermo resta acceso durante la lettura (Wake Lock).

## Super risoluzione

### "Super risoluzione" (Anime4K, attiva di default)

Ogni pagina viene ingrandita con la rete **Anime4K Upscale_CNN_x2** sulla GPU, a strisce di 288 righe per usare poca
memoria, **a un fattore fisso rispetto all'originale (×2 o ×4)**, indipendente dallo schermo; il risultato viene poi
**adattato al riquadro** con un ricampionamento Lanczos di alta qualità (mai la sfocatura bilineare del browser). È
il modello "prima la super risoluzione, poi l'adattamento": un solo risultato per pagina serve ogni zoom,
orientamento e impaginazione (lo zoom non ricalcola nulla), e ridurre un ×4 ai pixel dello schermo è ciò che rende
le linee pulite. Funziona con la doppia pagina; le pagine seguenti vengono elaborate in anticipo, ma solo finché
stanno nel budget di memoria della cache (a ×4 una pagina pesa ~60 MB): così la cache non va in thrashing e le pagine
non “lampeggiano”. Quando **Qualità massima** è attiva, la Super risoluzione standard è disattivata (i due sistemi
sono alternativi): i relativi controlli — fattore, livello, linee nitide — non hanno effetto e vengono mostrati in
grigio.

- **Livello**: `Auto` parte da VL, misura il tempo della prima pagina e sceglie il livello più forte che sta sotto
  100 ms per pagina (UL solo se la GPU lo consente; con 2–4 GB di RAM si ferma a M/VL). Si può forzare M, VL o UL.
- **Fattore**: `Auto` usa **×4** (due passaggi, il secondo al livello M) quando il risultato sta nel limite di 16 MP
  dei canvas di Safari e nel bilancio di memoria (pagine fino a ~1 MP, cioè i tipici 800×1200), altrimenti ×2; si
  può fissare ×2 o ×4. La cache dei risultati è limitata in byte
  (96–512 MB a seconda della RAM del dispositivo).
- **Linee nitide**: passaggio *Restore_CNN_Soft* di Anime4K prima dell'ingrandimento, tratti e testi più marcati
  (raddoppia il costo). **Pulizia scansione**: bianco della carta e neri più netti, leggera riduzione del rumore JPEG.
- **Backend automatico**: WebGPU (iPadOS 26+); su iPadOS 17/18 gli stessi shader ufficiali girano su **WebGL2**
  (risultato verificato equivalente: 54,6 dB tra i due backend); senza GPU utilizzabile, ridimensionamento del browser.
  Le impostazioni dicono sempre backend, livello, fattore, dimensione di uscita e tempo stimato.
- **Indicatore HD** (barra in alto e angolo): l'etichetta riporta `SR ×2 VL` / `SR ×4 UL` (fattore e livello in uso,
  `+` con Linee nitide), `SR ×4 GAN` (Qualità massima), `SR…` (in elaborazione), `SR n/d` (nessuna GPU utilizzabile o
  pagina troppo grande).

### "Qualità massima (lenta)" (sperimentale, spenta di default)

Unico interruttore del tier pesante: **Real-ESRGAN anime 6B a ×4** tramite onnxruntime-web, aspetto "stampato", molto
nitido; **decine di secondi per pagina** anche su GPU, minuti sulla CPU. È **alternativo** alla Super risoluzione
standard: quando è attivo, Anime4K non gira e la pagina resta com'è finché il risultato del modello non è pronto (un
solo cambio, niente lampeggio). I risultati sono salvati per sempre nell'archiviazione dell'app
(`sr-cache/<volume>.esrgan6b.x4/<pagina>.webp`); eliminando il volume si cancellano. Attivandola vengono scaricati una
volta sola il motore (14–27 MB) e i modelli (FP16 9 MB + fallback FP32 17 MB), poi restano in cache. Il risultato è un fattore fisso della
pagina (×4; ×2 solo se il ×4 supererebbe i 16 MP), poi adattato allo schermo.

- Con WebGPU le pagine seguenti vengono pre-elaborate in background mentre leggi, **dando sempre la precedenza alla
  pagina visibile** (coda a priorità): il tempo di calcolo, che è tanto, non viene sprecato su una pagina successiva
  mentre quella davanti aspetta. Con la sola CPU (WebAssembly, fino a 4 thread) si usa **Pre-elabora questo volume**,
  che elabora tutto il volume con barra di avanzamento, tempo stimato e Annulla (lo schermo resta acceso).
- Su GPU con `shader-f16` usa il grafo mixed-precision (input/output FP32, pesi e convoluzioni FP16), buffer GPU
  riutilizzati e graph capture ONNX Runtime. I tile vengono assemblati sulla GPU e letti una volta sola a pagina:
  benchmark 800×1200 locale, **49,5 → 13,5 s** (3,7×). Rispetto al percorso FP32: PSNR 48,2 dB, SSIM 0,99991,
  differenza massima 11/255 e bordi +0,94%; visivamente indistinguibile. Se FP16, graph capture o buffer esterni non
  sono supportati, il fallback è automatico: prima WebGPU FP32, poi CPU FP32.

Il modello non è nel repository: `npm run setup` lo scarica dalla
[release `models-v1`](https://github.com/gianmarcocherubini/4k-CBR-CBZ-Reader/releases/tag/models-v1) di questo
repository (export ONNX a dimensioni dinamiche del `.pth` ufficiale, licenza BSD-3).

## Formati e limiti

| Formato | Supporto |
| --- | --- |
| CBZ / ZIP, anche ZIP64 | Sì. Lettura voce per voce dal file, senza caricarlo in memoria. |
| CBR / RAR 4 e RAR 5 | Sì, tramite unrar (WebAssembly) in un worker con letture a finestra sul file. |
| RAR "solido" o multi-volume | No: messaggio esplicito. Ricomprimere senza l'opzione solido. |
| Archivi cifrati | No. |
| 7z, PDF | No. |
| Immagini | JPEG, PNG, GIF, WebP, BMP, AVIF, HEIC (quelle che il browser sa decodificare). |

Le pagine sono ordinate in modo naturale (`2.jpg` prima di `10.jpg`), ignorando `__MACOSX`, file nascosti e
`ComicInfo.xml`.

**Spazio**: l'import copia il file nell'Origin Private File System (OPFS) a blocchi di 8 MB da un worker; se OPFS
manca il file finisce in IndexedDB. Prima di copiare viene controllato lo spazio disponibile. Un file da 4,5 GB si
importa con la memoria del renderer che resta a poche decine di MB.

## Installazione su iPad

1. Apri il sito in Safari (una volta pubblicato, vedi sotto; in locale serve HTTPS o un tunnel su `localhost`).
2. **Condividi → Aggiungi alla schermata Home**.
3. Apri l'app dalla Home e **importa i file da lì**: l'app installata ha uno spazio di archiviazione separato da
   Safari (fino al 60 % del disco, non soggetto alla scadenza dei 7 giorni). Il piè di pagina della libreria mostra lo
   spazio usato.

## Pubblicazione su GitHub Pages

Il workflow `.github/workflows/deploy.yml` esegue lint, typecheck, test, `npm run setup`, build e test end-to-end
sulla build, poi pubblica `dist/` su GitHub Pages a ogni push su `main`. Nel repository: **Settings → Pages →
Source: GitHub Actions**. Il percorso base è ricavato dal nome del repository (`/4k-CBR-CBZ-Reader/`); per un dominio
proprio impostare `VITE_BASE=/` nella build.

Il service worker aggiunge le intestazioni COOP/COEP (isolamento cross-origin) a tutte le risposte: GitHub Pages non
può impostarle, e servono ai thread WebAssembly di "Qualità massima". Diventano attive dal secondo caricamento. Il
motore ONNX e il modello non vengono precaricati: finiscono in cache alla prima attivazione.

**Aggiornamenti**: l'app installata si aggiorna da sola. A ogni avvio il service worker controlla se su Pages c'è una
versione nuova, la scarica in background e la attiva subito; la libreria mostra il banner "Nuova versione dell'app
pronta · Ricarica", altrimenti la versione nuova è in uso dall'avvio successivo. Non serve rimuovere e ri-aggiungere
l'app alla schermata Home; libri, segnalibri e cache restano al loro posto.

## Flag per i test

- `?storage=idb` forza l'import in IndexedDB invece che in OPFS.
- `?sr=off` disattiva la super risoluzione; `?sr=webgl2` / `?sr=webgpu` forzano il backend Anime4K.
- `?cunet=wasm` forza la CPU per "Qualità massima".
- `?test` espone `window.__reader.importFiles(files)` e `window.__reader.openSession(file)` (sempre attivi in
  sviluppo).

## Struttura

```
src/
  lib/archive/     rilevamento formato, lettore ZIP (zip.js), lettore RAR (worker + Extractor su Blob)
  lib/storage/     IndexedDB (idb), OPFS, worker di copia, import, miniature
  lib/reader/      layout delle tavole (con spazio centrale), cache LRU delle pagine
  lib/spread.ts    accoppiamento intelligente delle pagine e pagine bianche inserite
  lib/upscale/     Anime4K su WebGPU (anime4k.ts) e WebGL2 (glslHooks.ts + webgl2Backend.ts, shader ufficiali in
                   shaders/), motore con coda e livello automatico (srEngine.ts), Real-ESRGAN (cunet/: worker
                   onnxruntime-web generico per modelli pesanti, cache OPFS, batch)
  components/      libreria, lettore (gesti, barre, impostazioni raggruppate)
  sw.ts            service worker (precache, offline, COOP/COEP, cache del motore e del modello)
scripts/           make-fixtures.mjs (CBZ e CBR di prova), fetch-models.mjs (npm run setup)
e2e/               test Playwright (progetti chromium e webgpu)
docs/, internal/   contesto di progetto, studio di fattibilità della super risoluzione, report
```
