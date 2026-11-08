// Motor alternativo basado en dash.js (MediaPlayer + módulo MSS, sin módulo de protección).
// Se usa para Smooth Streaming en directo, que Shaka Player no soporta (error 4047).
// ClearKey se gestiona directamente con EME: dash.js no ofrece ClearKey en MSS
// porque el manifiesto solo trae cabeceras PlayReady.
/* global dashjs */

import { bytesToBase64 } from './drm.js';

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

  /** Reproduce un canal. Solo admite contenido sin DRM o con ClearKey. */
  async load(channel) {
    await this.destroy();
    const drm = channel.drm || { system: 'none' };
    if (drm.system === 'widevine' || drm.system === 'playready') {
      throw new Error('El motor dash.js de IP Player solo admite contenido sin DRM o con ClearKey.');
    }
    if (drm.system === 'clearkey') await this._setupClearKey(drm);

    const context = {};
    const p = dashjs.MediaPlayer(context).create();
    p.updateSettings({
      debug: { logLevel: dashjs.Debug.LOG_LEVEL_WARNING },
      streaming: {
        buffer: { fastSwitchEnabled: true },
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
      const msg = String(err.message || 'Error desconocido');
      if (/DECODE/i.test(msg)) {
        this.onError({
          title: 'Error de decodificación',
          text: 'El vídeo no se pudo decodificar.' + (drm.system === 'clearkey' ? '\n¿Son correctas las claves ClearKey (KID:KEY)?' : '')
        });
        return;
      }
      this.onError({ title: `Error dash.js ${err.code ?? ''}`.trim(), text: msg });
    });

    const E = dashjs.MediaPlayer.events;
    for (const ev of [E.STREAM_INITIALIZED, E.QUALITY_CHANGE_RENDERED, E.TRACK_CHANGE_RENDERED, E.TEXT_TRACKS_ADDED]) {
      p.on(ev, () => this.onTracks?.());
    }

    this.player = p;
    p.initialize(this.video, channel.url, true);
    // Sin el módulo de protección, dash.js rechaza el contenido cifrado (error 24)
    // aunque las claves ya estén cargadas por EME. Capabilities se crea dentro de
    // initialize(), antes de cargar el manifiesto, así que se marca aquí como soportado.
    if (drm.system === 'clearkey') {
      dashjs.FactoryMaker.getSingletonInstance(context, 'Capabilities')?.setEncryptedMediaSupported(true);
    }
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
      return (p.getTracksFor('audio') || []).map((t, i) => ({
        id: i,
        lang: t.lang || '',
        label: t.labels?.[0]?.text || '',
        active: !!cur && cur.id === t.id && cur.index === t.index
      }));
    }, []);
  }

  setAudio(id) {
    this._safe((p) => { const t = (p.getTracksFor('audio') || [])[id]; if (t) p.setCurrentTrack(t); });
  }

  textTracks() {
    return this._safe((p) => {
      const idx = p.isTextEnabled() ? p.getCurrentTextTrackIndex() : -1;
      return (p.getTracksFor('text') || []).map((t, i) => ({
        id: i,
        lang: t.lang || '',
        label: t.labels?.[0]?.text || '',
        active: i === idx
      }));
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

    const entries = Object.entries(drm.keys || {});
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
              this.onError({ title: 'Falló la licencia ClearKey', text: err.message });
            }
          });
          await session.generateRequest(e.initDataType, e.initData);
        } catch (err) {
          this.onError({ title: 'Falló la licencia ClearKey', text: err.message });
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
