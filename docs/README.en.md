# IP Player — Chrome Extension

[Español](../README.md) · [English](README.en.md) · [Català](README.ca.md) · [Euskara](README.eu.md) · [Français](README.fr.md) · [Português](README.pt.md)

---

M3U playlist player with full support for **DASH**, **HLS**, and **Smooth Streaming (ISM/ISML)**, featuring DRM for **ClearKey**, **Widevine**, and custom license servers. Powered by [Shaka Player](https://github.com/shaka-project/shaka-player) 4.16, [dash.js](https://github.com/Dash-Industry-Forum/dash.js) 5.3 for live MSS, and [hls.js](https://github.com/video-dev/hls.js) 1.5 for HLS FairPlay/SAMPLE-AES with known keys, all bundled in `lib/` without remote dependencies.

## Installation

1. Navigate to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this project folder.
3. Click the extension icon in your toolbar to launch the player.

## Usage

- **Playlists** (☰ icon): Add a playlist via URL, local file, or direct raw text paste. Lists are persisted inside extension storage and can be refreshed anytime.
- **Open Stream** (🔗 icon): Play a standalone stream URL with custom type, DRM, and HTTP headers. Also accepts raw M3U `#KODIPROP` channel entries.
- **Edit** (pencil icon): Open the currently playing channel in the form to adjust keys, license server, or headers.
- **Custom Player Controls**: Consistent across Shaka and dash.js engines: quality selection (displays current resolution badge or ⚙ → Quality), audio tracks, subtitles, playback rate, DVR progress bar for live feeds, "LIVE" indicator badge, volume, Picture-in-Picture (PiP), and fullscreen.
- **Custom Playlists** (☰ → *Create custom list*): Manually curate lists and organize them into categories (create, rename, delete, move, and drag & drop reorder channels). Save channels via the bottom bar folder button or through "Save to list" in the stream dialog. Any playlist can be **exported to M3U** (including `#KODIPROP`, `#EXTVLCOPT`, and `#EXTHTTP` headers preconfigured for Kodi, TiviMate, or VLC) or **exported to JSON** for full fidelity re-import.
- **Built-in Guidance**: Quick onboarding tour on first run (accessible anytime via ?), tooltip badges with keyboard shortcuts on every interactive button, error dialogs with "Retry" and "Inspect stream", and enlarged UI text mode for accessibility.
- **Languages & Subtitles**: When multiple audio or subtitle streams are detected, ⚙ → *Audio* and ⚙ → *Subtitles* display language codes and track details (5.1 surround, audio description, CC, forced). The **CC** button toggles subtitles on/off. Preferred languages persist across channel changes and default to the browser language. Supports WebVTT, TTML, and CEA-608 across DASH, HLS, and Smooth Streaming.
- **Adaptive Layout**: Live video displayed prominently at the top when playing (collapsible), floating mini-player when scrolling, and clean category channel blocks below (rows and grid views with category filter chips, favorites, and recently watched).
- **Single "Add" Action**: Unified button to add a channel (with playlist and category pre-assignment), a category, an M3U playlist (URL/file/text), or a custom playlist.
- **Inline Editing**: Rename playlists and categories directly by clicking titles, reorder categories, drag channels between categories, and access channel context menus (edit, move, copy to list, delete).
- **Internationalization (i18n)**: Full UI localization in Spanish, English, Catalan, Basque, French, and Portuguese (Portugal and Brazil via dialect submenu). Locales live in `locales/<lang>.json` structured as `{ "Spanish text": "Translation" }`.
- **Stream Proxy (HTTP, HTTPS, SOCKS4, SOCKS5)**: Route streams and playlists through a proxy. Configure a general proxy in ? (Help) → *Options* (with live "Test connection" check), or specify a per-channel custom proxy in *Advanced options* → *Proxy*. Supports `user:password` basic authentication for HTTP/HTTPS. An active proxy is indicated by a **Proxy** badge in the now-playing metadata.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Rewind / Forward 10 s |
| `↑` / `↓` | Volume Up / Down |
| `M` | Mute / Unmute |
| `C` | Toggle subtitles |
| `F` | Toggle fullscreen (or double click) |
| `PageUp` / `PageDown` | Previous / Next channel |
| `/` | Search channels |
| `L` | Show / Hide playlist drawer |
| `↑` `↓` `Enter` (in list) | Navigate and select channels |
| `?` | Help and shortcut cheat sheet |

- **Context Menu**: Right-click any URL on any web page → "Play in IP Player" or "Load as M3U Playlist".

## Supported M3U Tags

| Tag | Attributes / Syntax |
|---|---|
| `#EXTINF` | `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `user-agent`, `http-referrer` |
| `#EXTGRP` | `#EXTGRP:Sports` |
| `#KODIPROP` | `inputstream.adaptive.license_type`, `license_key`, `drm_legacy`, `drm` (JSON), `manifest_type`, `stream_headers`, `license_headers` |
| `#EXTVLCOPT` | `http-user-agent`, `http-referrer`, `http-origin`, `http-cookie`, `http-proxy`, `socks-proxy` |
| `#EXTHTTP` | `#EXTHTTP:{"User-Agent":"…","Cookie":"…"}` |
| URL with `\|` | `https://…/index.mpd\|User-Agent=X&Referer=Y` |

### DRM Formats

```m3u
# ClearKey with local keys (hex, UUID, or base64; comma-separated for multiple keys)
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KID:KEY

# ClearKey in JSON / JWK format
#KODIPROP:inputstream.adaptive.license_key={"keys":[{"kty":"oct","kid":"…","k":"…"}]}

# Widevine with license server: URL|headers|body template|response template
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://lic/wv|Authorization=Bearer%20x|b{SSM}|JBlicense

# Kodi legacy format
#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|KID:KEY

# HLS FairPlay (SAMPLE-AES in TS) with known key: KID:KEY, KEY alone, or *:KEY:IV
#KODIPROP:inputstream.adaptive.license_type=com.apple.fps
#KODIPROP:inputstream.adaptive.license_key=*:KEY:IV

# HLS FairPlay with key proxy (GET request; supports {uri}, {id} = string after skd://, and {kid})
#KODIPROP:inputstream.adaptive.license_key=https://my-proxy/key?id={id}
```

Templates: Body `R{SSM}` (binary), `b{SSM}` (base64), or `B{SSM}` (base64 URL-encoded); Response empty (binary), `B` (base64), or `J<field>` / `JB<field>` (base64 encoded JSON field).

### Proxy in M3U Playlists

```m3u
# Channel-specific proxy (SOCKS5, SOCKS4, HTTP, or HTTPS; supports user:password on HTTP/HTTPS)
#EXTVLCOPT:http-proxy=socks5://127.0.0.1:1080
#EXTINF:-1 group-title="Proxied Channels",Channel via SOCKS5
https://example.com/stream.m3u8
```

## Technical Notes

- Custom headers (`User-Agent`, `Referer`, `Origin`, `Cookie`) are securely enforced via `declarativeNetRequest`, restricted exclusively to requests originated by this extension.
- **Dynamic PAC Proxy (`chrome.proxy`)**: The stream proxy creates an isolated dynamic PAC script (`FindProxyForURL`). Only the active channel media hostnames (manifest, video chunks, license URLs) are forwarded through the proxy; regular web browsing traffic is completely untouched. Stopping playback or closing the tab automatically releases proxy control.
- **Live Smooth Streaming**: Shaka Player only handles MSS on demand (VOD). For live MSS feeds (error 4047), the player automatically hands off playback to **dash.js**. This secondary engine supports unencrypted content and ClearKey DRM. You can also explicitly force the engine in "Open stream / Edit" → *Engine*.
- **HLS FairPlay / SAMPLE-AES in TS**: Chromium browsers lack native FairPlay CDM. If a channel provides ClearKey credentials or an accessible key proxy, IP Player switches to **hls.js** (`lib/hls.min.js`, 1.5.20), intercepts `skd://` key URLs, and transmuxes/decrypts the TS fragments locally. FairPlay streams often supply the IV inside the license rather than the manifest; use `*:KEY:IV` in that case.
- **PlayReady**: Only supported on Microsoft Edge (Chrome does not feature PlayReady CDM). On Chrome, Widevine or ClearKey must be used.
- Raw MPEG-TS streams (`.ts` without an enclosing HLS playlist) are not supported directly; HLS containing TS segments is fully supported.
- `sample/ejemplos.m3u` provides reference streams for each format (accessible via the "Sample Playlist" button).

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)](../LICENSE).
- **Attribution (BY)**: You must give appropriate credit to **Francesc Xavier Rosselló Encinas**.
- **Non-Commercial (NC)**: Commercial use, monetization, or sale of this software and its derivatives is strictly prohibited.
- **Share-Alike (SA)**: If you remix, transform, or build upon this material, you must distribute your contributions under this exact same license.
