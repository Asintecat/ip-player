// Motor alternativo basado en hls.js para HLS con segmentos MPEG-TS cifrados.
// Shaka no lo soporta (error 4040) y Chrome no tiene CDM FairPlay.
//
// Si el manifiesto anuncia varias claves (ClearKey, FairPlay, Widevine, PlayReady),
// se queda con ClearKey y se descartan las demás. La clave sale de la propia lista
// (identity, data: o licencia org.w3.clearkey) o, si solo hay FairPlay, de las claves
// del canal (KID:KEY, solo KEY, *:KEY:IV) o de un proxy de claves ({uri}, {id}, {kid}).
// No se pide licencia FairPlay (SPC/CKC).
/* global Hls */

import { parseClearKeys, toHex, ANY_KID, base64ToBytes, bytesToBase64 } from './drm.js';

const FORBIDDEN = new Set(['user-agent', 'referer', 'origin', 'cookie', 'host', 'connection', 'content-length']);
const KEY_SCHEME = 'ipkey:';
const WIDEVINE_UUID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_UUID = '9a04f079-9840-4286-ab92-e65be0885f95';
const CLEARKEY_UUID = '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b';

function attr(line, name) {
  const m = line.match(new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`, 'i'));
  return m ? (m[2] ?? m[1]) : null;
}

/** identity / org.w3.clearkey / UUID ClearKey, frente a FairPlay, Widevine o PlayReady. */
export function classifyKeyLine(line) {
  const method = (attr(line, 'METHOD') || 'NONE').toUpperCase();
  if (method === 'NONE') return 'none';
  const uri = attr(line, 'URI') || '';
  const format = (attr(line, 'KEYFORMAT') || 'identity').toLowerCase();
  if (format.includes('streamingkeydelivery') || format.includes('com.apple.fps') || /^skd:/i.test(uri)) return 'fairplay';
  if (format.includes('widevine') || format.includes(WIDEVINE_UUID)) return 'widevine';
  if (format.includes('playready') || format.includes(PLAYREADY_UUID) || format.includes('wiseplay')) return 'other';
  if (format === 'identity' || format.includes('clearkey') || format.includes(CLEARKEY_UUID)) return 'clearkey';
  return 'other';
}

function keyIdOf(line) {
  const hex = String(attr(line, 'KEYID') || '').replace(/^0x/i, '').replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toLowerCase() : '';
}

/** identity con URI http(s) o relativa: hls.js descarga los 16 bytes. El resto lo resolvemos nosotros. */
function hlsCanFetchKey(line) {
  const format = (attr(line, 'KEYFORMAT') || 'identity').toLowerCase();
  const uri = attr(line, 'URI') || '';
  return format === 'identity' && !/^data:/i.test(uri) && !/^skd:/i.test(uri);
}

function absoluteUri(uri, base) {
  if (!uri || /^(https?:|data:|skd:|ipkey:)/i.test(uri)) return uri;
  try { return new URL(uri, base).href; } catch (_) { return uri; }
}

export function encodeKeyRef(ref) {
  return KEY_SCHEME + encodeURIComponent(JSON.stringify({
    uri: ref.uri || '', kid: ref.kid || '', kind: ref.kind || ''
  }));
}

export function decodeKeyRef(url) {
  const raw = decodeURIComponent(String(url).slice(KEY_SCHEME.length));
  if (raw.startsWith('{')) {
    const ref = JSON.parse(raw);
    return { uri: String(ref.uri || ''), kid: String(ref.kid || ''), kind: String(ref.kind || '') };
  }
  return { uri: raw, kid: '', kind: 'fairplay' };
}

function emitIdentity(line, uri) {
  const method = (attr(line, 'METHOD') || 'SAMPLE-AES').toUpperCase();
  const iv = attr(line, 'IV');
  return `#EXT-X-KEY:METHOD=${method},URI="${uri}"${iv ? `,IV=${iv}` : ''},KEYFORMAT="identity"`;
}

/**
 * Reescribe las etiquetas de clave de un manifiesto HLS.
 * Si hay ClearKey (identity, org.w3.clearkey o su UUID), se conservan esas líneas
 * y se quitan FairPlay, Widevine y PlayReady. Si solo hay FairPlay, cada EXT-X-KEY
 * pasa a identity con URI ipkey:… para usar la clave del canal.
 * EXT-X-SESSION-KEY se quita: hls.js intentaría EME. En una lista de medios, una
 * SESSION-KEY ClearKey se convierte en EXT-X-KEY si no hay otra ClearKey.
 */
export function rewriteKeys(text, { base } = {}) {
  const lines = String(text).split(/\r?\n/);
  const isMedia = lines.some((l) => l.startsWith('#EXTINF'));
  const keyLines = lines.filter((l) => l.startsWith('#EXT-X-KEY:'));
  const hasClearKey = keyLines.some((l) => classifyKeyLine(l) === 'clearkey')
    || (isMedia && lines.some((l) => l.startsWith('#EXT-X-SESSION-KEY:') && classifyKeyLine(l) === 'clearkey'));

  return lines.map((line) => {
    const session = line.startsWith('#EXT-X-SESSION-KEY:');
    const key = line.startsWith('#EXT-X-KEY:');
    if (!session && !key) return line;
    if (session && !(hasClearKey && isMedia && !keyLines.some((l) => classifyKeyLine(l) === 'clearkey') && classifyKeyLine(line) === 'clearkey')) {
      return null;
    }
    const kind = classifyKeyLine(line);
    const method = (attr(line, 'METHOD') || '').toUpperCase();
    if (hasClearKey) {
      if (kind !== 'clearkey') return null;
      if (!session && hlsCanFetchKey(line)) return line;
      const uri = absoluteUri(attr(line, 'URI') || '', base);
      return emitIdentity(line, encodeKeyRef({ uri, kid: keyIdOf(line), kind: 'clearkey' }));
    }
    if (session) return null;
    if (method !== 'SAMPLE-AES') return line;
    if (kind !== 'fairplay' && kind !== 'clearkey') return null;
    const uri = absoluteUri(attr(line, 'URI') || '', base);
    return emitIdentity(line, encodeKeyRef({ uri, kid: keyIdOf(line), kind }));
  }).filter((l) => l !== null).join('\n');
}

/** Sustituye el IV de las líneas ipkey: por el que devolvió la clave (canal o licencia). */
export function applyResolvedIv(text, ivOf) {
  return String(text).split(/\r?\n/).map((line) => {
    if (!line.includes(KEY_SCHEME)) return line;
    const ref = decodeKeyRef(attr(line, 'URI') || '');
    const iv = ivOf(ref);
    if (!iv) return line;
    const ivHex = '0x' + String(iv).replace(/^0x/i, '');
    if (/(?:^|,)IV=/i.test(line)) return line.replace(/IV=0x[0-9a-f]+/i, `IV=${ivHex}`);
    return line.replace(/,KEYFORMAT=/i, `,IV=${ivHex},KEYFORMAT=`);
  }).join('\n');
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

/** Formas en las que un KID puede aparecer dentro de una URI skd://. */
function kidForms(kid) {
  const uuid = kid.length === 32 ? `${kid.slice(0, 8)}-${kid.slice(8, 12)}-${kid.slice(12, 16)}-${kid.slice(16, 20)}-${kid.slice(20)}` : kid;
  return [kid, uuid];
}

/**
 * KID e IV de un descriptor skd:// (UUID suelto o JSON en base64, como en shaka-proxy).
 * El descriptor está en el manifiesto; no es una licencia FairPlay.
 */
export function parseSkd(uri) {
  const out = { kid: '', iv: '' };
  if (!/^skd:/i.test(uri)) return out;
  let rest = uri.replace(/^skd:\/\//i, '');
  try { rest = decodeURIComponent(rest); } catch (_) { /* ya decodificado */ }
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(rest)) {
    out.kid = rest.replace(/-/g, '').toLowerCase();
    return out;
  }
  try {
    const json = JSON.parse(new TextDecoder().decode(base64ToBytes(rest)));
    const kid = String(json.KeyId || json.kid || json.keyId || '').replace(/-/g, '').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(kid)) out.kid = kid;
    const ivRaw = json.IV || json.iv;
    if (ivRaw) {
      const iv = toHex(ivRaw);
      if (iv.length === 32) out.iv = iv;
    }
  } catch (_) { /* descriptor no JSON */ }
  return out;
}

/** Elige la clave local que corresponde a la URI o al KID. */
export function pickLocalKey(keys, uri, kidHint) {
  const entries = Object.entries(keys || {});
  if (!entries.length) return null;
  const hinted = String(kidHint || '').replace(/-/g, '').toLowerCase();
  const kid = (hinted && hinted !== ANY_KID ? hinted : '') || parseSkd(uri).kid;
  // KID conocido: solo vale su clave o la comodín (*:KEY). Otra clave daría vídeo corrupto.
  if (kid) return keys[kid] || keys[ANY_KID] || null;
  const hay = String(uri).toLowerCase();
  for (const [k, key] of entries) {
    if (k !== ANY_KID && kidForms(k).some((f) => hay.includes(f))) return key;
  }
  // Sin KID: la comodín, o la única clave si no hay ambigüedad.
  return keys[ANY_KID] || (entries.length === 1 ? entries[0][1] : null);
}

/** Clave dentro de una URI data: (base64 o hex, 16 bytes). */
function dataUriKey(uri) {
  const m = String(uri).match(/^data:[^,]*?(;base64)?,(.*)$/i);
  if (!m) return null;
  try {
    const body = decodeURIComponent(m[2]);
    const hex = m[1] ? Array.from(base64ToBytes(body), (b) => b.toString(16).padStart(2, '0')).join('') : toHex(body);
    return hex.length === 32 ? hex : null;
  } catch (_) { return null; }
}

/**
 * Interpreta la respuesta de un proxy de claves. Devuelve "keyhex" o "keyhex:ivhex".
 * Admite: 16 bytes (clave) o 32 bytes (clave + IV, como FairPlay) en binario;
 * hex / base64 de lo mismo; "KID:KEY[:IV]"; JSON {key, iv}, {"kid":"key"} o JWK.
 */
export function parseKeyResponse(buf, uri, kid) {
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
    const keys = parseClearKeys(text);
    if (kid && keys[String(kid).replace(/-/g, '').toLowerCase()]) return keys[String(kid).replace(/-/g, '').toLowerCase()];
    return pickLocalKey(keys, uri, kid);
  }
  if (text.includes(':')) return pickLocalKey(parseClearKeys(text), uri, kid);
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

  /**
   * Obtiene {key: ArrayBuffer(16), iv: hex|null} para una referencia {uri, kid, kind}.
   * Orden: clave en data:, claves del canal, licencia ClearKey de la lista, proxy de claves.
   * IV: el del canal (KID:KEY:IV), si no el del descriptor skd://; si no, el del manifiesto.
   */
  async _resolveKey(ref, drm) {
    const cacheKey = `${ref.uri}|${ref.kid}`;
    if (this._keyCache.has(cacheKey)) return this._keyCache.get(cacheKey);
    const p = (async () => {
      const { uri } = ref;
      const skd = parseSkd(uri);
      const kid = ref.kid || skd.kid;
      const headers = Object.fromEntries(Object.entries(drm.licenseHeaders || {}).filter(([k]) => !FORBIDDEN.has(k.toLowerCase())));
      let value = dataUriKey(uri) || pickLocalKey(drm.keys, uri, kid);
      if (!value && ref.kind === 'clearkey' && /^https?:/i.test(uri)) {
        // Licencia org.w3.clearkey: POST {kids}; respuesta JWK. Sin KID, GET de la clave.
        const b64url = (hex) => bytesToBase64(hexToBytes(hex)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const res = kid
          ? await fetch(uri, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kids: [b64url(kid)], type: 'temporary' }) })
          : await fetch(uri, { headers });
        if (!res.ok) throw new Error(`El servidor de claves ClearKey respondió HTTP ${res.status}`);
        value = parseKeyResponse(await res.arrayBuffer(), uri, kid);
      }
      if (!value && drm.licenseUrl) {
        const res = await fetch(proxyUrl(drm.licenseUrl, uri), { headers });
        if (!res.ok) throw new Error(`El proxy de claves respondió HTTP ${res.status}`);
        value = parseKeyResponse(await res.arrayBuffer(), uri, kid);
      }
      if (!value) {
        throw new Error(kid
          ? `No hay clave para el KID ${kid}. Añade KID:KEY (o *:KEY) o un proxy de claves con «Editar».`
          : 'No hay clave para este stream. Añade la clave (KEY o KID:KEY) o un proxy de claves con «Editar».');
      }
      const [hex, ivOwn = null] = String(value).split(':');
      const iv = ivOwn || skd.iv || null;
      if (hex.length !== 32) throw new Error(`La clave debe tener 16 bytes (32 caracteres hex); tiene ${hex.length / 2}.`);
      if (iv && iv.length !== 32) throw new Error(`El IV debe tener 16 bytes (32 caracteres hex); tiene ${iv.length / 2}.`);
      return { key: hexToBytes(hex).buffer, iv };
    })();
    this._keyCache.set(cacheKey, p);
    p.catch(() => this._keyCache.delete(cacheKey));
    return p;
  }

  _makeLoader(drm) {
    const engine = this;
    const Base = Hls.DefaultConfig.loader;
    return class IpLoader extends Base {
      load(context, config, callbacks) {
        // Claves: se resuelven localmente, sin red (salvo el proxy).
        if (context.url.startsWith(KEY_SCHEME)) {
          const ref = decodeKeyRef(context.url);
          const stats = this.stats;
          stats.loading.start = performance.now();
          engine._resolveKey(ref, drm).then(({ key: data }) => {
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
              if (typeof response.data !== 'string' || !/#EXT-X-(SESSION-)?KEY:/.test(response.data)) {
                onSuccess(response, stats, ctx, net);
                return;
              }
              const base = response.url || ctx.url;
              const text = rewriteKeys(response.data, { base });
              // Se resuelven las claves antes para poder escribir su IV en el manifiesto.
              // Si falla, el error se mostrará cuando hls.js pida la clave.
              const refs = new Map();
              for (const line of text.split(/\r?\n/)) {
                if (!line.startsWith('#EXT-X-KEY:') || !line.includes(KEY_SCHEME)) continue;
                const ref = decodeKeyRef(attr(line, 'URI') || '');
                refs.set(`${ref.uri}|${ref.kid}`, ref);
              }
              Promise.all([...refs].map(([id, ref]) => engine._resolveKey(ref, drm).then((r) => [id, r.iv], () => [id, null])))
                .then((pairs) => {
                  const ivs = new Map(pairs);
                  response.data = applyResolvedIv(text, (ref) => ivs.get(`${ref.uri}|${ref.kid}`));
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
