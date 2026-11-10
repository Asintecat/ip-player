# IP Player — extensión de Chrome

[Español](README.md) · [English](docs/README.en.md) · [Català](docs/README.ca.md) · [Euskara](docs/README.eu.md) · [Français](docs/README.fr.md) · [Português](docs/README.pt.md)

---

Reproductor de listas M3U con soporte para **DASH**, **HLS** y **Smooth Streaming (ISM/ISML)**, con DRM **ClearKey**, **Widevine** y servidores de licencias. Usa [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 para MSS en directo [hls.js](https://github.com/video-dev/hls.js) 1.5 para HLS FairPlay/SAMPLE-AES con clave y [mpegts.js](https://github.com/xqq/mpegts.js) 1.7 para MPEG-TS en directo (receptores Enigma2/OpenWebIF), todos incluidos en `lib/` sin dependencias remotas.

## Instalación

1. Abre `chrome://extensions` y activa el **Modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y elige esta carpeta.
3. Pulsa el icono de la extensión para abrir el reproductor.

## Uso

- **Listas** (icono ☰): añade una lista por URL, archivo local o pegando el texto. Se guardan en la extensión y se pueden actualizar.
- **Abrir stream** (icono 🔗): reproduce una URL suelta con tipo, DRM y cabeceras manuales. También acepta pegar una entrada M3U con `#KODIPROP`.
- **Editar** (lápiz): abre el canal actual en el formulario para cambiar las claves, la licencia o las cabeceras.
- **Controles propios**, iguales en Shaka y dash.js: calidad (botón con la resolución actual o ⚙ → Calidad), audio, subtítulos, velocidad, barra de progreso con DVR en directo, indicador «EN DIRECTO», volumen, imagen en imagen y pantalla completa.
- **Listas propias** (☰ → *Crear lista propia*): crea listas a mano y organízalas en categorías (crear, renombrar, borrar, mover y reordenar canales). Para guardar un canal en una de tus listas, usa el botón de carpeta de la barra inferior o «Guardar en lista» en el formulario. Cualquier lista, también las de URL, se puede **descargar en M3U** (con `#KODIPROP`, `#EXTVLCOPT` y `#EXTHTTP`: DRM, claves y cabeceras ya configurados, válido para Kodi, TiviMate o VLC) o **en JSON**, que se vuelve a importar como lista editable. Las listas por URL también se pueden copiar como lista propia.
- **Ayuda integrada**: guía rápida la primera vez (y desde el botón ?), etiquetas emergentes con su atajo en todos los botones (mantén pulsado en móvil), mensajes de error con «Reintentar» y «Revisar el stream», y opción de texto más grande.
- **Idiomas y subtítulos**: si el stream trae varias pistas, ⚙ → *Audio* y ⚙ → *Subtítulos* las listan con su idioma y detalles (5.1, audiodescripción, CC, forzados). El botón **CC** activa o desactiva los subtítulos. El idioma elegido se recuerda para los siguientes canales, y por defecto se usa el del navegador. Funciona con WebVTT, TTML y CEA-608 en DASH, HLS y Smooth Streaming, con los dos motores.
- **Reproductor arriba y canales en bloques debajo**: una fila por categoría (más Favoritos y Vistos recientemente), chips para filtrar por categoría, búsqueda y mini reproductor flotante al bajar por la página.
- **Dos vistas** (botón de vista de la barra superior, atajo `V`, o ? → *Opciones* → *Vista*):
  - **Bloques**: la portada descrita arriba.
  - **Lista lateral**: los canales en una columna a la izquierda, con logo, programa en curso y barra de progreso, un desplegable de categorías y navegación con las flechas; el vídeo ocupa el resto y queda siempre a la vista. En móvil la lista pasa debajo del vídeo. La vista elegida se recuerda.
- **Añadir** desde un único botón: canal (con lista y categoría en el mismo formulario), categoría, lista M3U (enlace, archivo o texto) o lista propia.
- **Listas propias editables en la propia vista**: renombrar lista y categorías haciendo clic en el título, reordenar categorías, arrastrar canales entre categorías y menú ⋯ por canal (editar, mover, guardar en otra lista, eliminar).
- **Idiomas**: castellano, inglés, catalán, euskera, francés y portugués (Portugal y Brasil, en un submenú). Cada idioma es un archivo `locales/<código>.json` con la forma `{ "texto en castellano": "traducción" }`; para añadir uno nuevo basta con crear su JSON y registrarlo en `LANGS` (`js/i18n.js`).
- **Proxy para streams (HTTP, HTTPS, SOCKS4 y SOCKS5)**: permite cargar los streams y sus manifiestos a través de un proxy. Se puede configurar un proxy general en ? (Ayuda) → *Opciones* (con botón «Probar conexión»), o asignar un proxy específico a un canal individual desde «Opciones avanzadas» (*Proxy*). Admite autenticación por usuario y contraseña en HTTP/HTTPS. Cuando un canal usa proxy, se indica con la etiqueta **Proxy** en los metadatos de la reproducción.
- **Guía TV (EPG) integrada**: Soporte completo para guías de programación XMLTV, tanto en archivo `.xml` como comprimido `.xml.gz` (descompresión nativa mediante `DecompressionStream`). Si una lista M3U incluye la directiva `#EXTM3U url-tvg="..."` o `x-tvg-url="..."`, la guía se descarga y vincula automáticamente con los canales.
  - **En reproducción**: muestra el programa actual con barra de progreso en vivo, hora de emisión y el programa siguiente.
  - **Página interactiva de Guía TV** (botón «Guía TV» o atajo `G`): vista dedicada con selector de fechas, categorías, buscador, escala temporal de 24 horas con línea roja «Ahora», detalle modal de cada emisión y botón de reproducción directa.
  - **Persistencia en IndexedDB**: la guía se guarda localmente para una carga inmediata en cada inicio.

### Atajos de teclado

| Tecla | Acción |
|---|---|
| `Espacio` / `K` | Reproducir / pausa |
| `←` / `→` | Retroceder / avanzar 10 s |
| `↑` / `↓` | Volumen |
| `M` | Silenciar |
| `C` | Activar / desactivar subtítulos |
| `F` | Pantalla completa (también doble clic) |
| `RePág` / `AvPág` | Canal anterior / siguiente |
| `/` | Buscar canal |
| `G` | Guía TV (EPG) |
| `V` | Cambiar de vista (bloques o lista lateral) |
| `N` | Añadir un canal |
| `?` | Ayuda y atajos |

- **Menú contextual**: clic derecho en un enlace → «Reproducir en IP Player» o «Cargar como lista M3U».

## Etiquetas M3U soportadas

| Etiqueta | Ejemplo |
|---|---|
| `#EXTM3U` | `url-tvg="https://…/guia.xml.gz"`, `x-tvg-url="…"` |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Deportes` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL con `\|` | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### Formatos de DRM

```m3u
# ClearKey con claves locales (hex, UUID o base64; varias separadas por coma)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey en JSON / JWK
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine con servidor de licencias: URL|cabeceras|plantilla cuerpo|plantilla respuesta
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Formato nuevo de Kodi
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# HLS FairPlay (SAMPLE-AES en TS) con la clave de contenido: KID:KEY, solo KEY o *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# HLS FairPlay con proxy de claves (GET; admite {uri}, {id} = lo que va tras skd:// y {kid})
#KODIPROP:inputstream.adaptive.license_key=https://mi-proxy/clave?id={id}
```

Plantillas: cuerpo `R{SSM}` (binario), `b{SSM}` (base64) o `B{SSM}` (base64 URL-encoded); respuesta vacía (binaria), `B` (base64) o `J<campo>` / `JB<campo>` (campo JSON en base64).

### Proxy en listas M3U

```m3u
# Proxy por canal (SOCKS5, SOCKS4, HTTP o HTTPS; admite usuario:contraseña en HTTP/HTTPS)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Canales con proxy",Canal vía SOCKS5
https://ejemplo.com/stream.m3u8
```

## Receptores Enigma2 (OpenWebIF)

Añadir → *Lista M3U* → pestaña **Receptor**: escribe la IP del receptor (Vu+, Dreambox, Zgemma, Octagon, GigaBlue…) y, si la tiene, el usuario y la contraseña de OpenWebIF.

- Cada bouquet se convierte en una categoría; los marcadores del bouquet, en subcategorías.
- Los logos salen de los picons del receptor (`/picon/…png`) y la Guía TV se pide a su API (`/api/epgmulti`); no hace falta XMLTV.
- Los canales DVB se ven por el puerto de streaming 8001 (o 8002 con «Transcodificar a H.264»). Los streams IPTV metidos en los bouquets se reproducen directamente desde su URL.
- La lista se actualiza desde el receptor con el botón ⟳, como cualquier lista por enlace.
- También funcionan los M3U que genera OpenWebIF (`/web/services.m3u?bRef=…`) y los bouquets de Enigma2 (`userbouquet.*.tv`, líneas `#SERVICE` / `#DESCRIPTION`). Si pegas en «Enlace» la dirección web del receptor, se detecta y se añade como receptor.
- Un receptor con un solo sintonizador no puede emitir a la vez dos canales de transpondedores distintos.

## Notas

- Cabeceras como `User-Agent`, `Referer`, `Origin` y `Cookie` se aplican con `declarativeNetRequest`, solo a peticiones de la propia extensión.
- **Proxy dinámico con PAC (`chrome.proxy`)**: se configura dinámicamente mediante un script PAC (`FindProxyForURL`). Solo se desvían por el proxy los dominios de los medios en reproducción (manifiesto, segmentos y servidores de licencias); el resto de la navegación del usuario no se toca. Al parar la reproducción o cerrar la pestaña, el proxy se libera automáticamente.
- **Smooth Streaming en directo**: Shaka Player solo soporta MSS bajo demanda (VOD). Si un MSS es en directo (error 4047), el reproductor cambia automáticamente a **dash.js**. Ese motor admite contenido sin DRM o con ClearKey (claves locales o servidor de licencias ClearKey). También se puede forzar el motor desde «Abrir stream / Editar» → *Motor*.
- **HLS FairPlay / SAMPLE-AES en TS**: Chrome no tiene CDM FairPlay, así que Shaka falla (error 4040, o 6001). Si el canal trae claves ClearKey (o un proxy de claves), el reproductor cambia automáticamente a **hls.js** (`lib/hls.min.js`, 1.5.20), sustituye las claves `skd://` del manifiesto por esas claves y descifra los segmentos. FairPlay suele entregar el IV en la licencia y no en el manifiesto; en ese caso indica `*:KEY:IV`. El proxy puede devolver la clave (16 bytes) o la clave + IV (32 bytes) en binario, hex, base64 o JSON `{"key","iv"}`. No se pide licencia a servidores FairPlay reales: hace falta la clave de contenido.
- **PlayReady** solo funciona en Microsoft Edge (Chrome no tiene CDM de PlayReady). En Chrome, usa Widevine o ClearKey.
- **MPEG-TS en directo** (`.ts` sin manifiesto y streams de receptores `http://IP:8001/1:0:19:…`): se reproducen con **mpegts.js** (`lib/mpegts.js`, 1.7.3), que remultiplexa el TS a MP4 en MSE. Solo se oye la primera pista de audio. Chrome no decodifica vídeo MPEG-2 ni audio MP2/AC-3: los canales SD de satélite o TDT necesitan la transcodificación a H.264 del receptor (puerto 8002), si la tiene.
- `sample/ejemplos.m3u` contiene streams públicos de prueba para cada formato (botón «Lista de ejemplo»).

## Licencia

Este proyecto está bajo la licencia [Creative Commons Atribución-NoComercial-CompartirIgual 4.0 Internacional (CC BY-NC-SA 4.0)](LICENSE).
- **Atribución requerida (BY)**: Se debe otorgar el crédito correspondiente a **Francesc Xavier Rosselló Encinas**.
- **No comercial (NC)**: Queda terminantemente prohibida la venta, comercialización o monetización de este software, tanto de forma directa como indirecta.
- **Modificaciones con Compartir Igual (SA)**: Se permiten modificaciones y bifurcaciones siempre que se distribuya cualquier obra derivada bajo exactamente esta misma licencia estricta y no comercial.
