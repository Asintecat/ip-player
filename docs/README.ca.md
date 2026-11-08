# IP Player — Extensió per a Chrome

[Español](../README.md) · [English](README.en.md) · [Català](README.ca.md) · [Euskara](README.eu.md) · [Français](README.fr.md) · [Português](README.pt.md)

---

Reproductor de llistes M3U amb suport complet per a **DASH**, **HLS** i **Smooth Streaming (ISM/ISML)**, amb DRM **ClearKey**, **Widevine** i servidors de llicències. Utilitza [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 per a MSS en directe i [hls.js](https://github.com/video-dev/hls.js) 1.5 per a HLS FairPlay/SAMPLE-AES amb clau coneguda, tots inclosos a `lib/` sense dependències externes.

## Instal·lació

1. Obre `chrome://extensions` i activa el **Mode de desenvolupador**.
2. Fes clic a **Carrega sense empaquetar** i selecciona aquesta carpeta.
3. Fes clic a la icona de l'extensió a la barra del navegador per obrir el reproductor.

## Ús

- **Llistes** (icona ☰): Afegeix una llista per URL, fitxer local o enganxant el text. Es desen a l'extensió i es poden actualitzar en qualsevol moment.
- **Obrir stream** (icona 🔗): Reprodueix una URL solta amb format, DRM i capçaleres manuals. També accepta entrades directes M3U amb etiquetes `#KODIPROP`.
- **Editar** (llapis): Obre el canal actual al formulari per modificar claus, servidors de llicència o capçaleres.
- **Controls propis**, idèntics en Shaka i dash.js: Selecció de qualitat (botó amb la resolució activa o ⚙ → Qualitat), pistes d'àudio, subtítols, velocitat de reproducció, barra de progrés amb DVR en directe, indicador «EN DIRECTE», volum, imatge sobre imatge (PiP) i pantalla completa.
- **Llistes pròpies** (☰ → *Crea llista pròpia*): Crea llistes manuals i organitza-les en categories (crear, canviar de nom, eliminar, moure i reordenar canals per arrossegament). Per desar canals a les teves llistes, fes servir el botó de carpeta a la barra inferior o «Desa a la llista» des del formulari. Qualsevol llista es pot **descarregar en M3U** (amb `#KODIPROP`, `#EXTVLCOPT` i `#EXTHTTP` preparats per a Kodi, TiviMate o VLC) o **en format JSON**, que permet tornar-la a importar com a llista editable.
- **Ajuda integrada**: Guia ràpida en obrir l'extensió per primera vegada (i des del botó ?), consells emergents amb dreceres de teclat a cada botó, diàlegs d'error detallats amb «Torna-ho a provar» i «Revisa el stream», i mode de text ampliat per a accessibilitat.
- **Idiomes i subtítols**: Si l'emissió inclou múltiples pistes, ⚙ → *Àudio* i ⚙ → *Subtítols* mostren l'idioma i detalls tècnics (5.1, audiodescripció, CC, forçats). El botó **CC** activa o desactiva els subtítols de manera immediata. L'idioma seleccionat es recorda per a posteriors canals. Suporta WebVTT, TTML i CEA-608 en DASH, HLS i Smooth Streaming.
- **Disseny adaptable**: Reproductor superior actiu únicament durant la reproducció (amb botó de tancament), mini reproductor flotant en desplaçar-se i blocs de canals ordenats per categories (files i quadrícula amb selectors ràpids, favorits i canals recents).
- **Acció única «Afegir»**: Botó centralitzat per afegir un canal (assignant llista i categoria al mateix formulari), una categoria nova, una llista M3U (enllaç, fitxer o text) o una llista pròpia.
- **Edició directa a la vista**: Canvi de nom de llistes i categories fent clic sobre el seu títol, reordenació de categories, arrossegament de canals entre categories i menú d'opcions ⋯ per canal (editar, moure, desar en una altra llista, suprimir).
- **Idiomes de la interfície**: Castellà, anglès, català, euskera, francès i portuguès (de Portugal i Brasil en un submenú). Cada idioma és un fitxer `locales/<codi>.json` amb format `{ "text en castellà": "traducció" }`.
- **Proxy per a streams (HTTP, HTTPS, SOCKS4 i SOCKS5)**: Permet carregar els streams i els seus manifests mitjançant un servidor intermediari. Es pot configurar un proxy general a ? (Ajuda) → *Opcions* (amb botó per provar la connexió), o assignar un proxy exclusiu a un canal individual des d'«Opcions avançades» (*Proxy*). Admet autenticació bàsica d'usuari i contrasenya en HTTP/HTTPS. Quan un canal empra proxy, s'indica amb l'etiqueta **Proxy** a la informació de reproducció.
- **Guia TV (EPG) integrada**: Suport complet per a guies de programació XMLTV en text (`.xml`) i comprimit amb gzip (`.xml.gz`, descompressió nativa al navegador amb `DecompressionStream`). Si una llista M3U incorpora `#EXTM3U url-tvg="..."` o `x-tvg-url="..."`, la guia es descarrega i s'associa automàticament als canals.
  - **En reproducció**: mostra el programa en emissió amb barra de progrés en temps real, horaris i avanç del proper programa.
  - **Graella interactiva de Guia TV** (botó «Guia TV» o drecera `G`): vista dedicada de 24 hores amb selector de dates, filtre per categories, cercador, línia vermella «Ara», finestra de detall de programa i reproducció directa.
  - **Persistència a IndexedDB**: desa les dades localment per a una càrrega instantània en cada inici.

### Dreceres de teclat

| Tecla | Acció |
|---|---|
| `Espai` / `K` | Reprodueix / Pausa |
| `←` / `→` | Retrocedeix / Avança 10 s |
| `↑` / `↓` | Puja / Baixa volum |
| `M` | Silencia / Activa so |
| `C` | Activa / Desactiva subtítols |
| `F` | Pantalla completa (o doble clic) |
| `RePàg` / `AvPàg` | Canal anterior / següent |
| `/` | Cerca canals |
| `G` | Guia TV (EPG) |
| `N` | Afegeix un canal |
| `?` | Ajuda i llista de dreceres |

- **Menú contextual**: Clic dret sobre qualsevol enllaç web → «Reprodueix a IP Player» o «Carrega com a llista M3U».

## Etiquetes M3U suportades

| Etiqueta | Atributs / Sintaxi |
|---|---|
| `#EXTM3U` | `url-tvg="https://…/guia.xml.gz"`, `x-tvg-url="…"` |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Esports` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL amb `\|` | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### Formats de DRM

```m3u
# ClearKey amb claus locals (hex, UUID o base64; vàries separades per coma)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey en format JSON / JWK
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine amb servidor de llicències: URL|capçaleres|plantilla cos|plantilla resposta
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Format antic de Kodi
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# HLS FairPlay (SAMPLE-AES en TS) amb clau coneguda: KID:KEY, només KEY o *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# HLS FairPlay amb proxy de claus (petició GET; admet {uri}, {id} = text rere skd:// i {kid})
#KODIPROP:inputstream.adaptive.license_key=https://el-meu-proxy/clau?id={id}
```

Plantilles: cos `R{SSM}` (binari), `b{SSM}` (base64) o `B{SSM}` (base64 URL-encoded); resposta buida (binari), `B` (base64) o `J<camp>` / `JB<camp>` (camp JSON en base64).

### Proxy en llistes M3U

```m3u
# Proxy per canal (SOCKS5, SOCKS4, HTTP o HTTPS; admet usuari:contrasenya en HTTP/HTTPS)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Canals amb proxy",Canal via SOCKS5
https://exemple.cat/stream.m3u8
```

## Notes tècniques

- Les capçaleres personalitzades (`User-Agent`, `Referer`, `Origin`, `Cookie`) s'apliquen de manera segura mitjançant `declarativeNetRequest`, afectant exclusivament les peticions de la mateixa extensió.
- **Proxy dinàmic amb PAC (`chrome.proxy`)**: La configuració de proxy s'estableix mitjançant un script PAC generat en memòria (`FindProxyForURL`). Només s'encaminen pel servidor intermediari els dominis dels fitxers multimèdia del canal actiu (manifest, fragments de vídeo i servidors de llicència); tot el trànsit web habitual de l'usuari surt de manera directa. En aturar la reproducció o tancar la pestanya, el proxy s'allibera automàticament.
- **Smooth Streaming en directe**: Shaka Player només és compatible amb contingut MSS sota demanda (VOD). Quan es detecta una emissió en directe (error 4047), el reproductor transfereix la tasca de manera automàtica a **dash.js**. Aquest motor secundari admet fluxos sense DRM o amb ClearKey. També es pot forçar manualment des d'«Obrir stream / Editar» → *Motor*.
- **HLS FairPlay / SAMPLE-AES en TS**: Els navegadors basats en Chromium no disposen de mòdul CDM nadiu per a FairPlay. Si el canal compta amb claus ClearKey o un proxy accessible, IP Player activa **hls.js** (`lib/hls.min.js`, 1.5.20), intercepta els descriptors `skd://` i descodifica/desxifra els segments TS localment. Quan el vector d'inicialització (IV) no és present al manifest, es pot indicar mitjançant `*:KEY:IV`.
- **PlayReady**: Només és funcional a Microsoft Edge. A Chrome cal utilitzar Widevine o ClearKey.
- Els fitxers MPEG-TS directes (`.ts` aïllats sense manifest) no són compatibles; les emissions HLS compostes de segments TS sí que ho són.
- El fitxer `sample/ejemplos.m3u` ofereix emissions de mostra funcionals per a cada format suportat (accessible des del botó «Llista d'exemple»).

## Llicència

Aquest projecte està subjecte a la llicència [Creative Commons Reconeixement-NoComercial-CompartirIgual 4.0 Internacional (CC BY-NC-SA 4.0)](../LICENSE).
- **Reconeixement requerit (BY)**: Cal atorgar el crèdit corresponent a **Francesc Xavier Rosselló Encinas**.
- **No comercial (NC)**: Queda expressament prohibida la venda, comercialització o monetització d'aquest programari i els seus derivats.
- **Compartir igual (SA)**: Es permeten les modificacions sempre que qualsevol obra derivada es distribueixi sota exactament aquesta mateixa llicència estricta.
