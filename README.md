# IP Player — extensión de Chrome

Reproductor de listas M3U con soporte para **DASH**, **HLS** y **Smooth Streaming (ISM/ISML)**, con DRM **ClearKey**, **Widevine** y servidores de licencias. Usa [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 para MSS en directo y [hls.js](https://github.com/video-dev/hls.js) 1.5 para HLS FairPlay/SAMPLE-AES con clave, todos incluidos en `lib/` sin dependencias remotas.

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
- **Favoritos** ★, búsqueda y filtro por grupo. El panel lateral se puede plegar; en móvil, el reproductor queda arriba y la lista debajo.

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
| `L` | Mostrar u ocultar la lista |
| `↑` `↓` `Intro` (en la lista) | Moverse por los canales y reproducir |
| `?` | Ayuda y atajos |

- **Menú contextual**: clic derecho en un enlace → «Reproducir en IP Player» o «Cargar como lista M3U».

## Etiquetas M3U soportadas

| Etiqueta | Ejemplo |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Deportes` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie` |
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

## Notas

- Cabeceras como `User-Agent`, `Referer`, `Origin` y `Cookie` se aplican con `declarativeNetRequest`, solo a peticiones de la propia extensión.
- **Smooth Streaming en directo**: Shaka Player solo soporta MSS bajo demanda (VOD). Si un MSS es en directo (error 4047), el reproductor cambia automáticamente a **dash.js**. Ese motor admite contenido sin DRM o con ClearKey (claves locales o servidor de licencias ClearKey). También se puede forzar el motor desde «Abrir stream / Editar» → *Motor*.
- **HLS FairPlay / SAMPLE-AES en TS**: Chrome no tiene CDM FairPlay, así que Shaka falla (error 4040, o 6001). Si el canal trae claves ClearKey (o un proxy de claves), el reproductor cambia automáticamente a **hls.js** (`lib/hls.min.js`, 1.5.20), sustituye las claves `skd://` del manifiesto por esas claves y descifra los segmentos. FairPlay suele entregar el IV en la licencia y no en el manifiesto; en ese caso indica `*:KEY:IV`. El proxy puede devolver la clave (16 bytes) o la clave + IV (32 bytes) en binario, hex, base64 o JSON `{"key","iv"}`. No se pide licencia a servidores FairPlay reales: hace falta la clave de contenido.
- **PlayReady** solo funciona en Microsoft Edge (Chrome no tiene CDM de PlayReady). En Chrome, usa Widevine o ClearKey.
- Los streams MPEG-TS directos (`.ts` sin manifiesto) no están soportados; HLS con segmentos TS sí.
- `sample/ejemplos.m3u` contiene streams públicos de prueba para cada formato (botón «Lista de ejemplo»).
