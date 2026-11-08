# IP Player — Chrome-ko luzapena

[Español](../README.md) · [English](README.en.md) · [Català](README.ca.md) · [Euskara](README.eu.md) · [Français](README.fr.md) · [Português](README.pt.md)

---

M3U erreprodukzio-zerrenden erreproduzitzailea **DASH**, **HLS** eta **Smooth Streaming (ISM/ISML)** euskarri osoarekin, **ClearKey**, **Widevine** DRM eta lizentzia-zerbitzariekin bateragarria. [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, zuzeneko MSS-rako [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 eta gako ezagunekin FairPlay/SAMPLE-AES HLS erreproduzitzeko [hls.js](https://github.com/video-dev/hls.js) 1.5 erabiltzen ditu, guztiak `lib/` karpetan txertatuta kanpoko mendekotasunik gabe.

## Instalazioa

1. Joan `chrome://extensions` helbidera eta gaitu **Garatzaile modua**.
2. Egin klik **Kargatu paketatu gabe** botoian eta aukeratu proiektu honen karpeta.
3. Egin klik nabigatzaileko tresna-barrako luzapenaren ikonoan erreproduzitzailea irekitzeko.

## Erabilera

- **Zerrendak** (☰ ikonoa): Gehitu zerrenda bat URL bidez, tokiko fitxategi batetik edo testua zuzenean itsatsita. Luzapenean gordetzen dira eta nahi denean eguneratu daitezke.
- **Ireki stream-a** (🔗 ikonoa): Erreproduzitu URL solte bat mota, DRM eta goiburu pertsonalizatuekin. `#KODIPROP` etiketadun M3U lerroak ere onartzen ditu.
- **Editatu** (arkatza): Unean erreproduzitzen ari den kanala formularioan irekitzen du gakoak, lizentzia edo goiburuak aldatzeko.
- **Kontrol pertsonalizatuak**, berdinak Shaka eta dash.js motorretan: Kalitate aukeraketa (bereizmena erakusten duen txapa edo ⚙ → Kalitatea), audio-pistak, azpitituluak, erreprodukzio-abiadura, DVR aurrerapen-barra zuzenekoetan, «ZUZENEAN» adierazlea, bolumena, irudia irudian (PiP) eta pantaila osoa.
- **Zerrenda propioak** (☰ → *Sortu zerrenda propioa*): Sortu zerrendak eskuz eta antolatu kategoriatan (sortu, berrizendatu, ezabatu, mugitu eta arrastatu kanalak ordenatzeko). Kanalak zure zerrendetan gordetzeko, erabili beheko barrako karpeta botoia edo formularioan dagoen «Gorde zerrendan» aukera. Edozein zerrenda **M3U formatuan deskarga daiteke** (`#KODIPROP`, `#EXTVLCOPT` eta `#EXTHTTP` etiketa guztiekin, Kodi, TiviMate edo VLC-rako prest) edo **JSON formatuan**, gerora berriro editagarri gisa inportatzeko.
- **Laguntza integratua**: Gida azkarra lehen aldiz irekitzean (eta beti eskuragarri ? botoian), botoi bakoitzean lasterbideak erakusten dituzten azalpen-etiketak, errore-mezu argiak «Berriro saiatu» eta «Aztertu stream-a» aukerekin, eta irisgarritasunerako testu handiagoaren modua.
- **Hizkuntzak eta azpitituluak**: Stream-ak pista anitz baditu, ⚙ → *Audioa* eta ⚙ → *Azpitituluak* atalek pisten hizkuntzak eta xehetasunak bistaratzen dituzte (5.1, audio-deskribapena, CC, behartuak). **CC** botoiak azpitituluak berehala aktibatu edo desaktibatzen ditu. Aukeratutako hizkuntza gordetzen da hurrengo kateetarako. WebVTT, TTML eta CEA-608 onartzen ditu DASH, HLS eta Smooth Streaming-en.
- **Diseinu moldagarria**: Erreproduzitzailea goialdean agertzen da soilik zerbait erreproduzitzen ari denean (ixteko botoiarekin), orrian behera egitean mini-erreproduzitzaile flotagarria, eta behean kategoria bakoitzeko kanalen bloke garbiak (errenkadak eta sareta, kategoria-iragazkiak, gogokoenak eta ikusi berriak).
- **«Gehitu» ekintza bateratua**: Botoi bakar batetik kanal berria (zerrenda eta kategoria formulario berean ezarriz), kategoria, M3U zerrenda (esteka, fitxategia edo testua) edo zerrenda propioa gehitzeko.
- **Zuzeneko edizioa**: Berrizendatu zerrendak eta kategoriak izenburuan klik eginez, berrantolatu kategoriak, arrastatu kanalak kategorien artean eta erabili kanal bakoitzaren aukera-menua ⋯ (editatu, mugitu, beste zerrenda batera bikoiztu, ezabatu).
- **Interfazearen hizkuntzak**: Gaztelania, ingelesa, katalana, euskara, frantsesa eta portugesa (Portugal eta Brasil azpimenu bidez). Hizkuntza bakoitza `locales/<kodea>.json` fitxategi batean dago `{ "gaztelaniazko testua": "itzulpena" }` egiturarekin.
- **Stream-etarako proxy-a (HTTP, HTTPS, SOCKS4 eta SOCKS5)**: Stream-ak eta haien manifestuak proxy baten bidez kargatzeko aukera ematen du. Proxy orokorra ezar daiteke ? (Laguntza) → *Aukerak* atalean («Probatu konexioa» botoiarekin), edo kanal bakoitzari proxy propioa esleitu «Aukera aurreratuak» atalean (*Proxy-a*). Erabiltzaile eta pasahitz bidezko oinarrizko autentifikazioa onartzen du HTTP/HTTPS-n. Erreprodukzioan **Proxy** txaparen bidez adierazten da.
- **Telebista-gida (EPG) integratua**: XMLTV programazio-giden bateragarritasun osoa, `.xml` testuan zein gzip bidez konprimituta (`.xml.gz`, nabigatzailean bertan natiboki deskonprimitua `DecompressionStream` bidez). M3U zerrenda batek `#EXTM3U url-tvg="..."` edo `x-tvg-url="..."` badu, gida automatikoki deskargatzen eta kanalekin lotzen da.
  - **Erreprodukzioan**: uneko saioa, aurrerapen-barra zuzenean, ordutegiak eta hurrengo saioaren aurrebista erakusten ditu.
  - **Telebista-gidaren sareta interaktiboa** («Telebista-gida» botoia edo `G` lasterbidea): 24 orduko denbora-eskala dedikatua, data-hautatzailea, kategoria-iragazkiak, bilatzailea, «Orain» lerro gorria, saio bakoitzaren xehetasun-leihoa eta erreprodukzio zuzena.
  - **IndexedDB iraunkortasuna**: gida lokalean gordetzen du abiarazte bakoitzean berehala kargatzeko.

### Teklatuko lasterbideak

| Tekla | Ekintza |
|---|---|
| `Zuriunea` / `K` | Erreproduzitu / Pausatu |
| `←` / `→` | Atzera / Aurrera 10 s |
| `↑` / `↓` | Bolumena igo / jaitsi |
| `M` | Mututu / Desmututu |
| `C` | Aktibatu / Desaktibatu azpitituluak |
| `F` | Pantaila osoa (edo klik bikoitza) |
| `OrrGora` / `OrrBehera` | Aurreko / Hurrengo kanala |
| `/` | Bilatu kanala |
| `G` | Telebista-gida (EPG) |
| `N` | Gehitu kanal bat |
| `?` | Laguntza eta lasterbideen taula |

- **Testuinguru-menua**: Egin klik eskuineko botoiaz web orri bateko edozein estekatan → «Erreproduzitu IP Player-en» edo «Kargatu M3U zerrenda gisa».

## Onartutako M3U etiketak

| Etiketa | Atributuak / Sintaxia |
|---|---|
| `#EXTM3U` | `url-tvg="https://…/guia.xml.gz"`, `x-tvg-url="…"` |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Kirolak` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL-a `\|` ikurrarekin | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### DRM formatuak

```m3u
# ClearKey tokiko gakoekin (hex, UUID edo base64; komaz bananduta)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey JSON / JWK formatuan
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine lizentzia-zerbitzariarekin: URL|goiburuak|gorputz txantiloia|erantzun txantiloia
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Kodi formatu zaharra
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# FairPlay HLS (SAMPLE-AES TS-n) gako ezagunarekin: KID:KEY, KEY soilik edo *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# FairPlay HLS gako-proxyarekin (GET eskaera; {uri}, {id} = skd:// ostekoa, eta {kid} onartzen ditu)
#KODIPROP:inputstream.adaptive.license_key=https://nire-proxya/gakoa?id={id}
```

Txantiloiak: gorputza `R{SSM}` (bitarra), `b{SSM}` (base64) edo `B{SSM}` (base64 URL-encoded); erantzun hutsa (bitarra), `B` (base64) edo `J<eremua>` / `JB<eremua>` (base64-kodetutako JSON eremua).

### Proxy-a M3U zerrendetan

```m3u
# Kanalaren proxy espezifikoa (SOCKS5, SOCKS4, HTTP edo HTTPS; erabiltzaile:pasahitza onartzen du HTTP/HTTPS-n)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Proxy bidezko kanalak",Kanala SOCKS5 bidez
https://adibidea.eus/stream.m3u8
```

## Ohar teknikoak

- Goiburu pertsonalizatuak (`User-Agent`, `Referer`, `Origin`, `Cookie`) segurtasunez aplikatzen dira `declarativeNetRequest` bidez, soilik luzapen honek egindako sare-eskaeretan.
- **PAC bidezko proxy dinamikoa (`chrome.proxy`)**: Proxy-a dinamikoki konfiguratzen da PAC script baten bidez (`FindProxyForURL`). Erreproduzitzen ari den kanalaren domeinuak bakarrik bideratzen dira proxy-tik (manifestua, bideo-zatiak eta lizentzia-zerbitzariak); erabiltzailearen ohiko nabigazio-trafikoa zuzenean ateratzen da. Erreprodukzioa gelditzean edo fitxa ixtean, proxy-a automatikoki askatzen da.
- **Zuzeneko Smooth Streaming-a**: Shaka Player-ek eskaerapeko MSS (VOD) soilik onartzen du. Zuzeneko MSS stream-ak detektatzean (4047 errorea), erreproduzitzaileak automatikoki aldatzen du **dash.js** motorrera. Motor honek DRM gabekoak edo ClearKey-dun edukiak onartzen ditu.
- **FairPlay HLS / SAMPLE-AES TS-n**: Chromium nabigatzaileek ez dute FairPlay CDM-rik. Kanalak ClearKey gakoak edo proxy irisgarri bat badu, IP Player-ek **hls.js** (`lib/hls.min.js`, 1.5.20) aktibatzen du, `skd://` gakoak ordezkatzen ditu eta TS zatiak lokalean deszifratzen ditu. IV bektorea manifestuan ez badago, adierazi `*:KEY:IV`.
- **PlayReady**: Microsoft Edge-n bakarrik dabil erabilgarri. Chrome-n Widevine edo ClearKey erabili behar da.
- MPEG-TS zuzeneko fitxategi solteak (`.ts` manifesturik gabe) ez dira onartzen; TS segmentuak dituzten HLS zerrendak bai.
- `sample/ejemplos.m3u` fitxategiak formatu bakoitzeko proba-stream publikoak eskaintzen ditu («Adibide-zerrenda» botoian klik eginez karga daiteke).

## Lizentzia

Proiektu hau [Creative Commons Aitortu-EzKomertziala-PartekatuBerdin 4.0 Nazioartekoa (CC BY-NC-SA 4.0)](../LICENSE) lizentziapean argitaratu da.
- **Aitortza beharrekoa (BY)**: Egiletza-aitortza eman behar zaio **Francesc Xavier Rosselló Encinas**-i.
- **Ez komertziala (NC)**: Guztiz debekatuta dago software honen edo haren eratorrien salmenta, ustiapen komertziala edo monetizazioa.
- **Partekatu Berdin (SA)**: Aldaketak baimenduta daude, betiere edozein lan eratorri lizentzia zorrotz berdin honen pean banatzen bada.
