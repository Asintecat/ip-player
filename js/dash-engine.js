// Motor alternativo basado en dash.js (MediaPlayer + módulo MSS, sin módulo de protección).
// Se usa para Smooth Streaming en directo, que Shaka Player no soporta (error 4047).
// ClearKey se gestiona directamente con EME: dash.js no ofrece ClearKey en MSS
// porque el manifiesto solo trae cabeceras PlayReady.
/* global dashjs */

import { bytesToBase64, cencKeys } from './drm.js';
import { t as tx, locale } from './i18n.js';
import { ensureUrl } from './proxy.js';

const FORBIDDEN = new Set(['user-agent', 'referer', 'origin', 'cookie', 'host', 'connection', 'content-length']);
const enc = new TextEncoder();

function hexToB64url(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  return bytesToBase64(bytes).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const EME_CONFIG = [{
  initDataTypes: ['keyids', 'cenc', 'webm'],
  videoCapabilities: [
    { contentType: 'video/mp4; codecs="avc1.640028"' },
    { contentType: 'video/mp4; codecs="avc1.4d401f"' },
    { contentType: 'video/mp4; codecs="avc1.42e01e"' }
  ],
  audioCapabilities: [
    { contentType: 'audio/mp4; codecs="mp4a.40.2"' },
    { contentType: 'audio/mp4; codecs="mp4a.40.5"' }
  ]
}];

/** dash.js compara idiomas con una RegExp: «es» debe casar con es, es-ES, spa… */
function langMatcher(code) {
  const base = String(code).toLowerCase().split(/[-_]/)[0];
  const alt = { es: 'spa', en: 'eng', fr: 'fre|fra', de: 'ger|deu', it: 'ita', pt: 'por', ca: 'cat', eu: 'baq|eus', gl: 'glg', nl: 'dut|nld', ja: 'jpn', zh: 'chi|zho', ru: 'rus', pl: 'pol' }[base];
  return new RegExp(`^(${base}${alt ? '|' + alt : ''})([-_].*)?$`, 'i');
}

function roleValues(t) {
  return (t.roles || []).map((r) => (typeof r === 'string' ? r : r?.value)).filter(Boolean);
}

function mediaLabel(t) {
  const l = t.labels?.[0];
  return (typeof l === 'string' ? l : l?.text) || '';
}

const AUDIO_ROLE = { commentary: 'Comentarios', description: 'Audiodescripción', dub: 'Doblaje', alternate: 'Alternativo', supplementary: 'Complementario' };

function audioSub(t) {
  const parts = [];
  const cfg = (t.audioChannelConfiguration || [])[0];
  const ch = Number(typeof cfg === 'object' ? cfg?.value : cfg);
  if (ch > 2) parts.push(ch === 6 ? '5.1' : ch === 8 ? '7.1' : tx('{n} canales', { n: ch }));
  for (const r of roleValues(t)) if (AUDIO_ROLE[r]) parts.push(tx(AUDIO_ROLE[r]));
  const acc = (t.accessibility || []).map((a) => (typeof a === 'string' ? a : a?.value));
  if (acc.some((a) => a === '1' || a === 'description') && !parts.includes(tx('Audiodescripción'))) parts.push(tx('Audiodescripción'));
  return parts.join(' · ');
}

export class DashEngine {
  /**
   * @param {HTMLVideoElement} video
   * @param {{onError:(e:{title:string,text:string})=>void}} handlers
   */
  constructor(video, { onError, onTracks }) {
    this.video = video;
    this.onError = onError;
    this.onTracks = onTracks;
    this.player = null;
    this._onEncrypted = null;
  }

  static isAvailable() {
    return typeof dashjs !== 'undefined' && !!dashjs.MediaPlayer;
  }

  /**
   * Carga dash.js bajo demanda (~820 KB): la mayoría de streams usan Shaka y así
   * el reproductor abre más rápido. Devuelve true si quedó disponible.
   */
  static ensureLoaded() {
    if (DashEngine.isAvailable() && dashjs.MssHandler) return Promise.resolve(true);
    if (!DashEngine._loading) {
      const add = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(tx('No se pudo cargar {name}', { name: src })));
        document.head.appendChild(s);
      });
      DashEngine._loading = add('lib/dash.mediaplayer.min.js')
        .then(() => add('lib/dash.mss.min.js'))
        .then(() => DashEngine.isAvailable())
        .catch((err) => { console.error(err); DashEngine._loading = null; return false; });
    }
    return DashEngine._loading;
  }

  /**
   * Reproduce un canal. Solo admite contenido sin DRM o con ClearKey.
   * @param {object} channel
   * @param {{captions?:HTMLElement, audioLang?:string, textLang?:string, textOn?:boolean}} [opts]
   */
  async load(channel, opts = {}) {
    await this.destroy();
    const drm = channel.drm || { system: 'none' };
    if (drm.system === 'widevine' || drm.system === 'playready') {
      throw new Error(tx('El motor dash.js de IP Player solo admite contenido sin DRM o con ClearKey.'));
    }
    if (drm.system === 'clearkey') await this._setupClearKey(drm);

    const context = {};
    const p = dashjs.MediaPlayer(context).create();
    p.updateSettings({
      debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING },
      streaming: {
        buffer: { fastSwitchEnabled: true },
        // Subtítulos desactivados salvo que el usuario los dejara activos;
        // TTML se pinta en la capa propia; WebVTT con cues nativos (el renderizado
        // propio de WebVTT en dash.js 5.3 detiene la reproducción).
        text: { defaultEnabled: !!opts.textOn },
        retryAttempts: { MPD: 3, MediaSegment: 3, InitializationSegment: 3 }
      }
    });

    const extra = Object.entries(channel.headers || {}).filter(([k]) => !FORBIDDEN.has(k.toLowerCase()));
    if (extra.length) {
      p.addRequestInterceptor((request) => {
        request.headers = { ...(request.headers || {}), ...Object.fromEntries(extra) };
        return Promise.resolve(request);
      });
    }

    p.on(dashjs.MediaPlayer.events.ERROR, (e) => {
      const err = e.error || e;
      const msg = String(err.message || tx('Error desconocido'));
      if (/DECODE/i.test(msg)) {
        this.onError({
          title: tx('Error de decodificación'),
          text: tx('El vídeo no se pudo decodificar.') + (drm.system === 'clearkey' ? '\n' + tx('¿Son correctas las claves ClearKey (KID:KEY)?') : '')
        });
        return;
      }
      this.onError({ title: `${tx('Error')} dash.js ${err.code ?? ''}`.trim(), text: msg });
    });

    const E = dashjs.MediaPlayer.events;
    for (const ev of [E.STREAM_INITIALIZED, E.QUALITY_CHANGE_RENDERED, E.TRACK_CHANGE_RENDERED, E.TEXT_TRACKS_ADDED]) {
      p.on(ev, () => this.onTracks?.());
    }

    // Proxy: el dominio se añade al PAC (y se espera) antes de cada petición.
    if (typeof p.addRequestInterceptor === 'function') {
      p.addRequestInterceptor(async (request) => {
        await ensureUrl(request?.url);
        return request;
      });
    }

    this.player = p;
    // Primero la vista (los divs de subtítulos la necesitan) y después la fuente.
    p.initialize(this.video, null, true);
    if (opts.captions) {
      p.attachTTMLRenderingDiv(opts.captions);
    }
    if (opts.audioLang) p.setInitialMediaSettingsFor('audio', { lang: langMatcher(opts.audioLang) });
    if (opts.textLang) p.setInitialMediaSettingsFor('text', { lang: langMatcher(opts.textLang) });
    // Sin el módulo de protección, dash.js rechaza el contenido cifrado (error 24)
    // aunque las claves ya estén cargadas por EME. Capabilities se crea dentro de
    // initialize(), antes de cargar el manifiesto, así que se marca aquí como soportado.
    if (drm.system === 'clearkey') {
      dashjs.FactoryMaker.getSingletonInstance(context, 'Capabilities')?.setEncryptedMediaSupported(true);
    }
    p.attachSource(channel.url);
  }

  // ---------- API de pistas común con el adaptador de Shaka ----------

  _safe(fn, fallback) {
    try { return this.player ? fn(this.player) : fallback; } catch (_) { return fallback; }
  }

  qualities() {
    return this._safe((p) => {
      const byHeight = new Map();
      for (const r of p.getRepresentationsByType('video') || []) {
        if (!r.height) continue;
        const prev = byHeight.get(r.height);
        if (!prev || r.bandwidth > prev.bandwidth) byHeight.set(r.height, r);
      }
      return [...byHeight.values()]
        .sort((a, b) => b.height - a.height)
        .map((r) => ({ id: r.id, height: r.height, bandwidth: r.bandwidth }));
    }, []);
  }

  currentQuality() {
    return this._safe((p) => {
      const r = p.getCurrentRepresentationForType('video');
      return r ? { height: r.height, bandwidth: r.bandwidth } : null;
    }, null);
  }

  isAutoQuality() {
    return this._safe((p) => p.getSettings().streaming.abr.autoSwitchBitrate.video !== false, true);
  }

  setQuality(id) {
    this._safe((p) => {
      const auto = id === 'auto';
      p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: auto } } } });
      if (!auto) p.setRepresentationForTypeById('video', id, true);
    });
  }

  audioTracks() {
    return this._safe((p) => {
      const cur = p.getCurrentTrackFor('audio');
      // El mismo idioma puede venir en varios códecs (AAC, Opus…): se muestra uno,
      // el activo o, si no, el del mismo tipo que el actual para un cambio sin cortes.
      const groups = new Map();
      (p.getTracksFor('audio') || []).forEach((t, i) => {
        const item = {
          id: i,
          lang: t.lang || '',
          label: mediaLabel(t),
          sub: audioSub(t),
          active: !!cur && cur.id === t.id && cur.index === t.index,
          sameType: !!cur && t.mimeType === cur.mimeType
        };
        const key = JSON.stringify([item.lang, item.label, item.sub]);
        const prev = groups.get(key);
        const score = (x) => (x.active ? 2 : 0) + (x.sameType ? 1 : 0);
        if (!prev || score(item) > score(prev)) groups.set(key, item);
      });
      return [...groups.values()].sort((a, b) => a.id - b.id);
    }, []);
  }

  setAudio(id) {
    this._safe((p) => { const t = (p.getTracksFor('audio') || [])[id]; if (t) p.setCurrentTrack(t); });
  }

  textTracks() {
    return this._safe((p) => {
      const idx = p.isTextEnabled() ? p.getCurrentTextTrackIndex() : -1;
      return (p.getTracksFor('text') || []).map((t, i) => {
        const roles = roleValues(t);
        const forced = roles.includes('forced-subtitle');
        const sub = [forced && tx('Forzados'), (roles.includes('caption') || t.isEmbedded) && 'CC'].filter(Boolean).join(' · ');
        return { id: i, lang: t.lang || '', label: mediaLabel(t), forced, sub, active: i === idx };
      });
    }, []);
  }

  setText(id) {
    this._safe((p) => {
      p.enableText(id != null);
      if (id != null) p.setTextTrack(id);
    });
  }

  isLive() { return this._safe((p) => p.isDynamic(), false); }

  /** Ventana buscable en la misma escala que time(). */
  seekRange() {
    return this._safe((p) => {
      if (p.isDynamic()) {
        const w = p.getDvrWindow();
        return { start: w.start ?? 0, end: w.end ?? 0 };
      }
      return { start: 0, end: p.duration() || 0 };
    }, { start: 0, end: 0 });
  }

  time() { return this._safe((p) => p.time(), 0); }
  seek(t) { this._safe((p) => p.seek(t)); }
  goLive() { this._safe((p) => p.seekToOriginalLive()); }

  async _setupClearKey(drm) {
    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', EME_CONFIG);
    const mediaKeys = await access.createMediaKeys();
    await this.video.setMediaKeys(mediaKeys);

    const entries = Object.entries(cencKeys(drm.keys));
    if (entries.length) {
      // Claves locales: se cargan por adelantado en una sesión "keyids".
      const jwk = {
        keys: entries.map(([kid, k]) => ({ kty: 'oct', kid: hexToB64url(kid), k: hexToB64url(k) })),
        type: 'temporary'
      };
      const session = mediaKeys.createSession();
      const ready = new Promise((resolve, reject) => {
        session.addEventListener('message', () => {
          session.update(enc.encode(JSON.stringify(jwk))).then(resolve, reject);
        }, { once: true });
      });
      await session.generateRequest('keyids', enc.encode(JSON.stringify({ kids: jwk.keys.map((k) => k.kid) })));
      await ready;
      return;
    }

    if (drm.licenseUrl) {
      // Servidor de licencias ClearKey: una sesión por cada evento "encrypted".
      const headers = drm.licenseHeaders || {};
      this._onEncrypted = async (e) => {
        try {
          const session = mediaKeys.createSession();
          session.addEventListener('message', async (m) => {
            try {
              const res = await fetch(drm.licenseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: m.message
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              await session.update(await res.arrayBuffer());
            } catch (err) {
              this.onError({ title: tx('Falló la licencia ClearKey'), text: err.message });
            }
          });
          await session.generateRequest(e.initDataType, e.initData);
        } catch (err) {
          this.onError({ title: tx('Falló la licencia ClearKey'), text: err.message });
        }
      };
      this.video.addEventListener('encrypted', this._onEncrypted);
    }
  }

  async destroy() {
    if (this.player) {
      try { this.player.reset(); } catch (_) { /* ya destruido */ }
      this.player = null;
    }
    if (this._onEncrypted) {
      this.video.removeEventListener('encrypted', this._onEncrypted);
      this._onEncrypted = null;
    }
    if (this.video.mediaKeys) {
      try { await this.video.setMediaKeys(null); } catch (_) { /* el navegador no lo permite aún */ }
    }
  }
}
