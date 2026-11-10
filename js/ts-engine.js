// Motor MPEG-TS en directo (mpegts.js) para streams HTTP sin manifiesto:
// receptores Enigma2 / OpenWebIF (http://receptor:8001/1:0:19:…), Xtream «.ts», etc.
// El navegador no reproduce TS directamente: mpegts.js lo remultiplexa a MP4 en MSE.
/* global mpegts */

import { t as tx } from './i18n.js';

const FORBIDDEN = new Set(['user-agent', 'referer', 'origin', 'cookie', 'host', 'connection', 'content-length']);

/** Separa «usuario:contraseña@» de la URL: fetch() no acepta URLs con credenciales. */
export function splitCredentials(url) {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return { url, auth: '' };
    const auth = 'Basic ' + btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`);
    u.username = '';
    u.password = '';
    return { url: u.href, auth };
  } catch (_) {
    return { url, auth: '' };
  }
}

function describeTsError(type, detail, info) {
  const msg = info?.msg || detail || '';
  if (type === 'NetworkError') {
    const code = info?.code;
    if (code === 401 || code === 403) {
      return { title: tx('Acceso denegado'), text: tx('El receptor pide usuario y contraseña para el stream (HTTP {code}).\nRevisa las credenciales del receptor en «Tus listas».', { code }) };
    }
    if (code > 0) return { title: `${tx('Error')} HTTP ${code}`, text: tx('El servidor rechazó el stream MPEG-TS.') };
    return { title: tx('Error de red'), text: tx('No se pudo conectar con el stream MPEG-TS.\n¿Está encendido el receptor y sintonizado el canal? Un receptor con un solo sintonizador no puede emitir dos canales de distinto transpondedor a la vez.') };
  }
  if (type === 'MediaError') {
    return {
      title: tx('Formato no soportado'),
      text: tx('El navegador no puede decodificar este canal. En receptores de satélite o TDT suele ser un canal SD en MPEG-2 (vídeo) o MP2/AC-3 (audio), que Chrome no reproduce.\nSolución: activa «Transcodificar a H.264 (puerto 8002)» en el receptor, si lo permite, o mira la versión HD del canal.')
    };
  }
  return { title: tx('No se pudo reproducir'), text: msg || String(type) };
}

export class TsEngine {
  constructor(video, { onError, onTracks, onInfo }) {
    this.video = video;
    this.onError = onError;
    this.onTracks = onTracks;
    this.onInfo = onInfo;
    this.p = null;
    this.mediaInfo = null;
    this.lastIssue = null;
  }

  static isAvailable() {
    return typeof mpegts !== 'undefined' && !!mpegts.getFeatureList().mseLivePlayback;
  }

  static ensureLoaded() {
    if (typeof mpegts !== 'undefined') return Promise.resolve(TsEngine.isAvailable());
    if (!TsEngine._loading) {
      TsEngine._loading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'lib/mpegts.js';
        s.onload = () => resolve(TsEngine.isAvailable());
        s.onerror = () => { TsEngine._loading = null; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return TsEngine._loading;
  }

  async load(channel) {
    await this.destroy();
    this.failed = false;
    this.lastIssue = null;
    const { url, auth } = splitCredentials(channel.url);
    const headers = {};
    for (const [k, v] of Object.entries(channel.headers || {})) {
      if (!FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
    }
    if (auth && !headers.Authorization) headers.Authorization = auth;

    if (mpegts.LoggingControl) {
      mpegts.LoggingControl.enableVerbose = false;
      mpegts.LoggingControl.enableDebug = false;
      mpegts.LoggingControl.enableInfo = false;
      mpegts.LoggingControl.enableWarn = false; // saltos de marcas de tiempo: normales en directo
    }
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url },
      {
        enableWorker: false, // los workers blob no siempre están permitidos en páginas de extensión
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        liveBufferLatencyMinRemain: 1.5,
        autoCleanupSourceBuffer: true,
        headers
      }
    );
    this.p = p;
    let reported = false;
    p.on(mpegts.Events.ERROR, (type, detail, info) => {
      if (reported || this.p !== p) return; // un error de MSE se repite en cada segmento
      reported = true;
      this.failed = true;
      this.lastIssue = describeTsError(type, detail, info);
      console.warn('mpegts.js', type, detail, info);
      this.onError(this.lastIssue);
      this.destroy();
    });
    p.on(mpegts.Events.MEDIA_INFO, (info) => {
      this.mediaInfo = info;
      this.onInfo?.(info);
      this.onTracks?.();
    });
    p.attachMediaElement(this.video);
    p.load();
    const r = p.play();
    if (r?.catch) r.catch(() => {});
  }

  // ---------- API de pistas común (ver controls.js) ----------
  // mpegts.js reproduce la primera pista de audio del programa: no hay selección.

  qualities() {
    const h = this.mediaInfo?.height;
    return h ? [{ id: 0, height: h, bandwidth: 0 }] : [];
  }
  currentQuality() {
    const h = this.mediaInfo?.height;
    return h ? { height: h, bandwidth: 0 } : null;
  }
  isAutoQuality() { return true; }
  setQuality() {}
  audioTracks() { return []; }
  setAudio() {}
  textTracks() { return []; }
  setText() {}
  isLive() { return true; }

  seekRange() {
    const b = this.video.buffered;
    if (b && b.length) return { start: b.start(0), end: b.end(b.length - 1) };
    return { start: 0, end: this.video.currentTime || 0 };
  }

  time() { return this.video.currentTime || 0; }
  seek(t) { this.video.currentTime = t; }
  goLive() {
    const b = this.video.buffered;
    if (b && b.length) this.video.currentTime = Math.max(0, b.end(b.length - 1) - 1);
  }

  async destroy() {
    this.mediaInfo = null;
    if (this.p) {
      const p = this.p;
      this.p = null;
      try { p.pause(); } catch (_) { /* nada */ }
      try { p.unload(); } catch (_) { /* nada */ }
      try { p.detachMediaElement(); } catch (_) { /* nada */ }
      try { p.destroy(); } catch (_) { /* ya destruido */ }
    }
  }
}
