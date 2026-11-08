// Motor alternativo basado en hls.js para HLS con segmentos MPEG-TS cifrados con
// SAMPLE-AES (empaquetado FairPlay). Shaka no lo soporta (error 4040).
//
// Chrome no tiene CDM FairPlay, así que la licencia de Apple (SPC/CKC) no se puede
// pedir. Lo que sí se puede hacer, si se conoce la clave de contenido, es descifrar
// los segmentos en JavaScript: el manifiesto se reescribe para que cada EXT-X-KEY
// FairPlay (skd://…) apunte a una clave «identity» que resuelve IP Player:
//   - con las claves ClearKey del canal (KID:KEY, o solo KEY), o
//   - con un proxy de claves (el «Servidor de licencias» del canal): GET que devuelve
//     la clave de 16 bytes en binario, hex, base64 o JSON. Admite {uri}, {id} y {kid}.
/* global Hls */

import { parseClearKeys, toHex, ANY_KID } from './drm.js';

const FORBIDDEN = new Set(['user-agent', 'referer', 'origin', 'cookie', 'host', 'connection', 'content-length']);
const KEY_SCHEME = 'ipkey:';
const FAIRPLAY_FORMAT = 'com.apple.streamingkeydelivery';

function attr(line, name) {
  const m = line.match(new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`, 'i'));
  return m ? (m[2] ?? m[1]) : null;
}

/**
 * Reescribe las etiquetas de clave de un manifiesto HLS.
 * SAMPLE-AES FairPlay/identity → SAMPLE-AES identity con URI ipkey:…
 * Se quitan las claves de otros DRM y EXT-X-SESSION-KEY (hls.js intentaría EME).
 */
export function rewriteKeys(text, ivFor = () => null) {
  return String(text).split(/\r?\n/).map((line) => {
    if (line.startsWith('#EXT-X-SESSION-KEY')) return null;
    if (!line.startsWith('#EXT-X-KEY')) return line;
    const method = (attr(line, 'METHOD') || '').toUpperCase();
    if (method !== 'SAMPLE-AES') return line; // NONE / AES-128: hls.js los gestiona solo
    const uri = attr(line, 'URI') || '';
    const format = (attr(line, 'KEYFORMAT') || 'identity').toLowerCase();
    if (format !== FAIRPLAY_FORMAT && format !== 'identity' && !/^skd:/i.test(uri)) return null;
    // FairPlay suele entregar el IV en la licencia (CKC), no en el manifiesto:
    // si el usuario o el proxy lo dan, manda sobre el del manifiesto.
    const known = ivFor(uri);
    const iv = known ? '0x' + known : attr(line, 'IV');
    return `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${KEY_SCHEME}${encodeURIComponent(uri)}"${iv ? `,IV=${iv}` : ''},KEYFORMAT="identity"`;
  }).filter((l) => l !== null).join('\n');
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

/** Formas en las que un KID puede aparecer dentro de una URI skd://. */
function kidForms(kid) {
  const uuid = kid.length === 32 ? `${kid.slice(0, 8)}-${kid.slice(8, 12)}-${kid.slice(12, 16)}-${kid.slice(16, 20)}-${kid.slice(20)}` : kid;
  return [kid, uuid];
}

/** Elige la clave local que corresponde a la URI de clave original. */
export function pickLocalKey(keys, uri) {
  const entries = Object.entries(keys || {});
  if (!entries.length) return null;
  const hay = String(uri).toLowerCase();
  for (const [kid, key] of entries) {
    if (kid !== ANY_KID && kidForms(kid).some((f) => hay.includes(f))) return key;
  }
  // Sin coincidencia: clave comodín, o la única que hay, o la primera.
  return keys[ANY_KID] || entries[0][1];
}

/**
 * Interpreta la respuesta de un proxy de claves. Devuelve "keyhex" o "keyhex:ivhex".
 * Admite: 16 bytes (clave) o 32 bytes (clave + IV, como FairPlay) en binario;
 * hex / base64 de lo mismo; "KID:KEY[:IV]"; JSON {key, iv}, {"kid":"key"} o JWK.
 */
export function parseKeyResponse(buf, uri) {
  const bytes = new Uint8Array(buf);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const split = (h) => (h.length === 64 ? `${h.slice(0, 32)}:${h.slice(32)}` : h);
  if (bytes.length === 16 || bytes.length === 32) {
    // Binario solo si no parece texto (hex/base64 también miden a veces 16 o 32 bytes).
    const isText = bytes.every((b) => b >= 0x20 && b < 0x7f);
    if (!isText) return split(hex(bytes));
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    const json = JSON.parse(text);
    const k = json.key ?? json.k ?? json.contentKey ?? json.content_key;
    if (typeof k === 'string') return toHex(k) + (json.iv ? ':' + toHex(json.iv) : '');
    return pickLocalKey(parseClearKeys(text), uri);
  }
  if (text.includes(':')) return pickLocalKey(parseClearKeys(text), uri);
  return split(toHex(text));
}

function proxyUrl(template, uri) {
  const id = uri.replace(/^skd:\/\//i, '');
  const kid = (id.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i) || [''])[0].replace(/-/g, '');
  return template
    .replace(/\{uri\}/gi, encodeURIComponent(uri))
    .replace(/\{id\}/gi, encodeURIComponent(id))
    .replace(/\{kid\}/gi, kid);
}

/** Traduce un error de hls.js a {title, text} en lenguaje claro. */
export function describeHlsError(data) {
  const code = data.response?.code || data.networkDetails?.status || 0;
  const http = code ? ` (HTTP ${code})` : '';
  const auth = code === 401 || code === 403 ? '\nEl servidor rechazó la petición: puede requerir User-Agent, Referer o Cookie (usa «Editar»).' : '';
  const D = {
    manifestLoadError: ['No se pudo cargar el manifiesto', 'La lista HLS (.m3u8) no se pudo descargar.'],
    manifestLoadTimeOut: ['Tiempo agotado', 'El servidor no envió la lista HLS a tiempo.'],
    manifestParsingError: ['Manifiesto no válido', 'La respuesta no es una lista HLS válida.'],
    manifestIncompatibleCodecsError: ['Formato no soportado', 'Los códecs de este stream no son compatibles con el navegador.'],
    levelLoadError: ['No se pudo cargar la calidad', 'La lista de segmentos de esta calidad no se pudo descargar.'],
    levelLoadTimeOut: ['Tiempo agotado', 'El servidor no envió la lista de segmentos a tiempo.'],
    audioTrackLoadError: ['No se pudo cargar el audio', 'La lista de la pista de audio no se pudo descargar.'],
    keyLoadError: ['No se pudo obtener la clave', data.error?.message || data.response?.text || 'La clave de descifrado no se pudo obtener.'],
    keyLoadTimeOut: ['Tiempo agotado', 'El proxy de claves no respondió a tiempo.'],
    fragLoadError: ['No se pudo cargar un segmento', 'Un fragmento de vídeo no se pudo descargar.'],
    fragLoadTimeOut: ['Tiempo agotado', 'Un fragmento de vídeo tardó demasiado en llegar.'],
    fragDecryptError: ['No se pudo descifrar', 'El segmento no se pudo descifrar. ¿Son correctos la clave y el IV?'],
    fragParsingError: ['Segmento no válido', 'Un fragmento no se pudo leer (¿clave o IV incorrectos?).'],
    bufferAddCodecError: ['Formato no soportado', 'El navegador no admite el códec de este stream.'],
    bufferAppendError: ['Error de decodificación', 'El vídeo no se pudo decodificar. ¿Son correctos la clave y el IV?']
  }[data.details];
  if (D) return { title: D[0] + http, text: D[1] + auth };
  if (data.type === 'mediaError') return { title: 'Error de decodificación', text: 'El vídeo no se pudo decodificar. ¿Son correctos la clave y el IV?' };
  return { title: `Error hls.js${http}`, text: String(data.details || data.error?.message || 'Error desconocido') + auth };
}

export class HlsEngine {
  constructor(video, { onError, onTracks }) {
    this.video = video;
    this.onError = onError;
    this.onTracks = onTracks;
    this.hls = null;
    this._keyCache = new Map();
  }

  static isAvailable() {
    return typeof Hls !== 'undefined' && Hls.isSupported();
  }

  static ensureLoaded() {
    if (typeof Hls !== 'undefined') return Promise.resolve(HlsEngine.isAvailable());
    if (!HlsEngine._loading) {
      HlsEngine._loading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'lib/hls.min.js';
        s.onload = () => resolve(HlsEngine.isAvailable());
        s.onerror = () => { HlsEngine._loading = null; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return HlsEngine._loading;
  }

  /** Obtiene {key: ArrayBuffer(16), iv: hex|null} para una URI de clave original. */
  async _resolveKey(uri, drm) {
    if (this._keyCache.has(uri)) return this._keyCache.get(uri);
    const p = (async () => {
      let value = pickLocalKey(drm.keys, uri);
      if (!value && drm.licenseUrl) {
        const headers = Object.fromEntries(Object.entries(drm.licenseHeaders || {}).filter(([k]) => !FORBIDDEN.has(k.toLowerCase())));
        const res = await fetch(proxyUrl(drm.licenseUrl, uri), { headers });
        if (!res.ok) throw new Error(`El proxy de claves respondió HTTP ${res.status}`);
        value = parseKeyResponse(await res.arrayBuffer(), uri);
      }
      if (!value) throw new Error('No hay clave para este stream. Añade la clave (KEY o KID:KEY) o un proxy de claves con «Editar».');
      const [hex, iv = null] = String(value).split(':');
      if (hex.length !== 32) throw new Error(`La clave debe tener 16 bytes (32 caracteres hex); tiene ${hex.length / 2}.`);
      if (iv && iv.length !== 32) throw new Error(`El IV debe tener 16 bytes (32 caracteres hex); tiene ${iv.length / 2}.`);
      return { key: hexToBytes(hex).buffer, iv };
    })();
    this._keyCache.set(uri, p);
    p.catch(() => this._keyCache.delete(uri));
    return p;
  }

  _makeLoader(drm) {
    const engine = this;
    const Base = Hls.DefaultConfig.loader;
    return class IpLoader extends Base {
      load(context, config, callbacks) {
        // Claves: se resuelven localmente, sin red (salvo el proxy).
        if (context.url.startsWith(KEY_SCHEME)) {
          const uri = decodeURIComponent(context.url.slice(KEY_SCHEME.length));
          const stats = this.stats;
          stats.loading.start = performance.now();
          engine._resolveKey(uri, drm).then(({ key: data }) => {
            stats.loading.first = stats.loading.end = performance.now();
            stats.loaded = stats.total = data.byteLength;
            callbacks.onSuccess({ url: context.url, data }, stats, context, null);
          }, (err) => {
            engine._keyError = err.message; // se muestra cuando hls.js avisa del keyLoadError
            callbacks.onError({ code: 0, text: err.message }, context, null, stats);
          });
          return;
        }
        // Manifiestos: se reescriben las etiquetas EXT-X-KEY.
        if (context.type === 'manifest' || context.type === 'level' || context.type === 'audioTrack' || context.type === 'subtitleTrack') {
          const onSuccess = callbacks.onSuccess;
          callbacks = {
            ...callbacks,
            onSuccess: (response, stats, ctx, net) => {
              if (typeof response.data !== 'string' || !/METHOD=SAMPLE-AES/i.test(response.data)) {
                onSuccess(response, stats, ctx, net);
                return;
              }
              // Se resuelven las claves antes para poder escribir su IV en el manifiesto.
              const uris = [...new Set(response.data.split(/\r?\n/)
                .filter((l) => l.startsWith('#EXT-X-KEY') && /METHOD=SAMPLE-AES/i.test(l))
                .map((l) => attr(l, 'URI') || ''))];
              Promise.all(uris.map((u) => engine._resolveKey(u, drm).then((r) => [u, r.iv]).catch(() => [u, null])))
                .then((pairs) => {
                  const ivs = new Map(pairs);
                  response.data = rewriteKeys(response.data, (u) => ivs.get(u));
                  onSuccess(response, stats, ctx, net);
                });
            }
          };
        }
        super.load(context, config, callbacks);
      }
    };
  }

  async load(channel, opts = {}) {
    await this.destroy();
    const drm = channel.drm || { system: 'none', keys: {} };
    if (drm.system === 'widevine' || drm.system === 'playready') {
      throw new Error('El motor hls.js de IP Player solo descifra SAMPLE-AES con clave conocida (ClearKey o proxy de claves).');
    }
    const extra = Object.entries(channel.headers || {}).filter(([k]) => !FORBIDDEN.has(k.toLowerCase()));
    const IpLoader = this._makeLoader(drm);

    const hls = new Hls({
      loader: IpLoader,
      enableWorker: true,
      lowLatencyMode: false,
      emeEnabled: false,
      startLevel: -1,
      xhrSetup: extra.length ? (xhr) => { for (const [k, v] of extra) xhr.setRequestHeader(k, v); } : undefined
    });
    this.hls = hls;

    hls.on(Hls.Events.ERROR, (_, data) => {
      // También los errores no fatales: si el stream no arranca, explican por qué.
      this.lastIssue = describeHlsError(data);
      if (data.details === 'keyLoadError' && this._keyError) this.lastIssue.text = this._keyError;
      console.warn('hls.js', data.details, data);
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this._recovered) {
        this._recovered = true;
        hls.recoverMediaError();
        return;
      }
      this.onError(this.lastIssue);
    });
    for (const ev of [Hls.Events.MANIFEST_PARSED, Hls.Events.LEVEL_SWITCHED, Hls.Events.AUDIO_TRACK_SWITCHED, Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.SUBTITLE_TRACK_SWITCH]) {
      hls.on(ev, () => this.onTracks?.());
    }
    hls.once(Hls.Events.MANIFEST_PARSED, () => {
      const pick = (tracks, lang) => tracks.findIndex((t) => (t.lang || '').toLowerCase().startsWith(String(lang).toLowerCase().slice(0, 2)));
      if (opts.audioLang) { const i = pick(hls.audioTracks, opts.audioLang); if (i >= 0) hls.audioTrack = i; }
      if (opts.textOn && opts.textLang) { const i = pick(hls.subtitleTracks, opts.textLang); if (i >= 0) hls.subtitleTrack = i; }
      else hls.subtitleTrack = -1;
      this.video.play().catch(() => {});
    });

    hls.attachMedia(this.video);
    hls.loadSource(channel.url);
  }

  // ---------- API de pistas común (ver controls.js) ----------

  _safe(fn, fallback) {
    try { return this.hls ? fn(this.hls) : fallback; } catch (_) { return fallback; }
  }

  qualities() {
    return this._safe((h) => {
      const byHeight = new Map();
      h.levels.forEach((l, i) => {
        if (!l.height) return;
        const prev = byHeight.get(l.height);
        if (!prev || l.bitrate > prev.bandwidth) byHeight.set(l.height, { id: i, height: l.height, bandwidth: l.bitrate });
      });
      return [...byHeight.values()].sort((a, b) => b.height - a.height);
    }, []);
  }

  currentQuality() {
    return this._safe((h) => {
      const l = h.levels[h.currentLevel];
      return l ? { height: l.height, bandwidth: l.bitrate } : null;
    }, null);
  }

  isAutoQuality() { return this._safe((h) => h.autoLevelEnabled, true); }
  setQuality(id) { this._safe((h) => { h.currentLevel = id === 'auto' ? -1 : id; }); }

  audioTracks() {
    return this._safe((h) => h.audioTracks.map((t, i) => ({
      id: i, lang: t.lang || '', label: t.name || '', sub: t.channels && Number(t.channels) > 2 ? `${t.channels} canales` : '', active: i === h.audioTrack
    })), []);
  }

  setAudio(id) { this._safe((h) => { h.audioTrack = id; }); }

  textTracks() {
    return this._safe((h) => h.subtitleTracks.map((t, i) => ({
      id: i, lang: t.lang || '', label: t.name || '', forced: !!t.forced, sub: t.forced ? 'Forzados' : '', active: i === h.subtitleTrack
    })), []);
  }

  setText(id) { this._safe((h) => { h.subtitleTrack = id == null ? -1 : id; }); }

  isLive() { return this._safe((h) => !!h.levels[h.currentLevel >= 0 ? h.currentLevel : 0]?.details?.live, false); }

  seekRange() {
    const s = this.video.seekable;
    if (s && s.length) return { start: s.start(0), end: s.end(s.length - 1) };
    return { start: 0, end: this.video.duration || 0 };
  }

  time() { return this.video.currentTime || 0; }
  seek(t) { this.video.currentTime = t; }
  goLive() { this._safe((h) => { if (h.liveSyncPosition != null) this.video.currentTime = h.liveSyncPosition; }); }

  async destroy() {
    this._recovered = false;
    this.lastIssue = null;
    this._keyError = null;
    this._keyCache.clear();
    if (this.hls) {
      try { this.hls.destroy(); } catch (_) { /* ya destruido */ }
      this.hls = null;
    }
  }
}
