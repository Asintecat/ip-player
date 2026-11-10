// IP Player — controlador principal.
/* global shaka */

import { parseM3U, looksLikeHlsManifest } from './m3u.js';
import {
  MIME, TYPE_LABEL, detectType, emptyDrm, buildShakaDrmConfig, drmLabel,
  parseClearKeys, keysToLines, parseLineHeaders, headersToLines,
  transformLicenseRequest, transformLicenseResponse
} from './drm.js';
import { applyHeaderRules } from './headers.js';
import * as store from './storage.js';
import { DashEngine } from './dash-engine.js';
import { HlsEngine } from './hls-engine.js';
import { TsEngine } from './ts-engine.js';
import { catchupInfo, canCatchup, catchupUrl } from './catchup.js';
import { parseBoxAddress, aboutBox, buildBoxPlaylist, fetchBoxEpg, listBouquets } from './openwebif.js';
import { Controls, langName } from './controls.js';
import { initTooltips, setTooltipsEnabled, hideTooltip } from './tooltip.js';
import { startTour, isTourOpen } from './tour.js';
import { cleanChannel, groupsOf, parseLibraryJSON, exportList } from './library.js';
import { t, getLang, setLang, detectLang, LANGS, initI18n, translateStatic, locale } from './i18n.js';
import { enhanceSelect, enhanceSelects, refreshSelects } from './select.js';
import { parseProxy, setProxy, ensureUrl, clearProxy, describeProxy, proxyControl, isProxyAvailable, activeProxy } from './proxy.js';
import {
  loadCachedEpg, loadEpgFromUrl, loadEpgFromFile, clearEpg,
  getNowAndNext, getChannelSchedule, getEpgStats, hasEpg, loadEpgData
} from './epg.js';

const $ = (sel) => document.querySelector(sel);
const typeLabel = (type) => t(TYPE_LABEL[type] || 'Auto');
const FAV_ID = '__favorites__';
const RECENT_MAX = 16;
// Cabeceras que fetch() no deja fijar: se aplican con declarativeNetRequest.
const FORBIDDEN = new Set(['user-agent', 'referer', 'origin', 'cookie', 'host', 'connection', 'content-length']);

const state = {
  playlists: [],
  favorites: [],
  activeId: null,
  channels: [],
  filtered: [],
  group: '',
  query: '',
  current: null,
  editing: null,
  recents: [],
  // Diálogo de stream: 'open' (solo reproducir), 'add' (nuevo canal) o 'edit' (canal de una lista propia)
  streamMode: { kind: 'open' },
  view: 'browse', // 'browse' | 'epg'
  epgDate: new Date(),
  epgCategory: '',
  epgQuery: ''
};

let player = null;
let controls = null;
let loadToken = 0;
let dashEngine = null;
let hlsEngine = null;
let tsEngine = null;
let engine = 'shaka'; // motor activo: 'shaka' | 'dashjs' | 'hlsjs' | 'mpegts'
const ALT_ENGINES = () => ({ dashjs: dashEngine, hlsjs: hlsEngine, mpegts: tsEngine });
/** Adaptador de pistas del motor activo (ver controls.js). */
const activeAdapter = () => ALT_ENGINES()[engine] || shakaAdapter;
// Idiomas preferidos (se recuerdan entre canales y sesiones).
let prefs = { audioLang: '', textLang: '', textOn: false };
// Vista: 'blocks' (portada por bloques) o 'side' (canales en una columna lateral).
let layout = 'blocks';
const isSide = () => layout === 'side';
const browserLang = (navigator.language || 'es').split('-')[0];
const MSS_LIVE_NOT_SUPPORTED = 4047;
const HLS_ENCRYPTED_TS = 4040;
const HLS_START_TIMEOUT = 20000; // ms sin vídeo antes de mostrar el motivo
const KEY_SYSTEM_UNAVAILABLE = 6001; // p. ej. HLS FairPlay: Chrome no tiene CDM FairPlay

// ======================================================================
// Reproductor
// ======================================================================

async function initPlayer() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    showOverlay(t('Navegador no compatible'), t('Este navegador no soporta Media Source Extensions.'), true);
    return;
  }
  const video = $('#video');
  player = new shaka.Player();
  await player.attach(video);

  controls = new Controls({
    root: $('#player'),
    video,
    getAdapter: activeAdapter,
    onPrev: () => step(-1),
    onNext: () => step(1),
    preferredText: () => prefs.textLang || browserLang,
    onPick: (kind, track) => {
      const patch = kind === 'audio'
        ? { audioLang: track?.lang || '' }
        : track ? { textOn: true, textLang: track.lang || prefs.textLang } : { textOn: false };
      prefs = { ...prefs, ...patch };
      store.patchPrefs(patch).catch(() => {});
    }
  });

  const RT = shaka.net.NetworkingEngine.RequestType;
  const net = player.getNetworkingEngine();

  net.registerRequestFilter((type, request) => {
    const ch = state.current;
    if (!ch) return;
    if (type === RT.LICENSE) {
      const d = ch.drm || {};
      for (const [k, v] of Object.entries(d.licenseHeaders || {})) {
        if (!FORBIDDEN.has(k.toLowerCase())) request.headers[k] = v;
      }
      transformLicenseRequest(request, d.bodyTemplate);
    } else {
      for (const [k, v] of Object.entries(ch.headers || {})) {
        if (!FORBIDDEN.has(k.toLowerCase())) request.headers[k] = v;
      }
    }
    // Proxy: el dominio se añade al PAC (y se espera) antes de pedirlo.
    const waits = (request.uris || []).map(ensureUrl).filter(Boolean);
    if (waits.length) return Promise.all(waits);
  });

  net.registerResponseFilter((type, response) => {
    const tpl = state.current?.drm?.responseTemplate;
    if (type === RT.LICENSE && tpl) transformLicenseResponse(response, tpl);
  });

  const altHandlers = {
    onError: (info) => {
      controls.setEnabled(false);
      controls.setBusy(false);
      showOverlay(info.title, info.text, true);
      setStatus(`${info.title}: ${info.text.split('\n')[0]}`, 'err');
    },
    onTracks: () => controls.refreshTracks()
  };
  dashEngine = new DashEngine(video, altHandlers);
  hlsEngine = new HlsEngine(video, altHandlers);
  tsEngine = new TsEngine(video, altHandlers);

  const refresh = () => controls.refreshTracks();
  player.addEventListener('error', (e) => showError(e.detail));
  for (const ev of ['variantchanged', 'adaptation', 'trackschanged', 'textchanged', 'abrstatuschanged']) {
    player.addEventListener(ev, refresh);
  }
}

// Adaptador de Shaka con la misma API de pistas que DashEngine (ver controls.js).
const shakaAdapter = {
  qualities() {
    const byHeight = new Map();
    for (const t of player.getVariantTracks()) {
      if (!t.height) continue;
      const prev = byHeight.get(t.height);
      if (!prev || t.bandwidth > prev.bandwidth) byHeight.set(t.height, t);
    }
    return [...byHeight.values()]
      .sort((a, b) => b.height - a.height)
      .map((t) => ({ id: t.height, height: t.height, bandwidth: t.bandwidth }));
  },
  currentQuality() {
    const t = player.getVariantTracks().find((v) => v.active);
    return t ? { height: t.height, bandwidth: t.bandwidth } : null;
  },
  isAutoQuality() { return player.getConfiguration().abr.enabled; },
  setQuality(id) {
    if (id === 'auto') {
      player.configure({ abr: { enabled: true } });
      return;
    }
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    const candidates = tracks
      .filter((t) => t.height === id && (!active || t.language === active.language))
      .sort((a, b) => b.bandwidth - a.bandwidth);
    if (!candidates.length) return;
    player.configure({ abr: { enabled: false } });
    player.selectVariantTrack(candidates[0], true);
  },
  audioTracks() {
    // getAudioTracks() (Shaka >= 4.14) da etiqueta, roles y canales por pista.
    if (typeof player.getAudioTracks === 'function') {
      const seen = new Map();
      for (const t of player.getAudioTracks()) {
        const roles = (t.roles || []).filter((r) => r !== 'main');
        const key = JSON.stringify([t.language, t.label || '', roles, t.channelsCount || 0]);
        if (!seen.has(key) || t.active) seen.set(key, { track: t, roles });
      }
      return [...seen.values()].map(({ track: t, roles }, i) => ({
        id: i,
        _track: t,
        lang: t.language,
        label: t.label || '',
        sub: audioDetails(t.channelsCount, roles, t.spatialAudio),
        active: !!t.active
      }));
    }
    const active = player.getVariantTracks().find((t) => t.active);
    return player.getAudioLanguagesAndRoles().map((l) => ({
      id: JSON.stringify([l.language, l.role || '']),
      lang: l.language,
      label: l.label || '',
      sub: audioDetails(0, l.role ? [l.role] : []),
      active: !!active && active.language === l.language && (!l.role || (active.roles || []).includes(l.role))
    }));
  },
  setAudio(id) {
    if (typeof id === 'number') {
      const t = this.audioTracks().find((x) => x.id === id);
      if (t) player.selectAudioTrack(t._track);
      return;
    }
    const [lang, role] = JSON.parse(id);
    player.selectAudioLanguage(lang, role || undefined);
  },
  textTracks() {
    const visible = player.isTextTrackVisible();
    return player.getTextTracks().map((t) => ({
      id: t.id,
      lang: t.language,
      label: t.label || '',
      forced: !!t.forced,
      sub: textDetails(t.kind, t.roles, t.forced),
      active: visible && t.active
    }));
  },
  setText(id) {
    if (id == null) {
      player.setTextTrackVisibility(false);
      return;
    }
    const t = player.getTextTracks().find((x) => x.id === id);
    if (t) {
      player.selectTextTrack(t);
      player.setTextTrackVisibility(true);
    }
  },
  isLive() { return player.isLive(); },
  seekRange() {
    if (player.isLive()) return player.seekRange();
    const d = $('#video').duration;
    return { start: 0, end: Number.isFinite(d) ? d : 0 };
  },
  time() { return $('#video').currentTime; },
  seek(t) { $('#video').currentTime = t; },
  goLive() { player.goToLive ? player.goToLive() : ($('#video').currentTime = player.seekRange().end); }
};

const ROLE_LABEL = {
  commentary: 'Comentarios',
  description: 'Audiodescripción',
  'enhanced-audio-intelligibility': 'Diálogos realzados',
  dub: 'Doblaje',
  alternate: 'Alternativo',
  supplementary: 'Complementario',
  emergency: 'Emergencia',
  sign: 'Lengua de signos'
};

function audioDetails(channels, roles = [], spatial = false) {
  const parts = [];
  if (channels > 2) parts.push(channels === 6 ? '5.1' : channels === 8 ? '7.1' : t('{n} canales', { n: channels }));
  if (spatial) parts.push(t('Espacial'));
  for (const r of roles) if (ROLE_LABEL[r]) parts.push(t(ROLE_LABEL[r]));
  return parts.join(' · ');
}

function textDetails(kind, roles = [], forced = false) {
  const parts = [];
  if (forced || roles.includes('forced-subtitle')) parts.push(t('Forzados'));
  if (kind === 'caption' || roles.includes('caption')) parts.push('CC');
  if (roles.includes('description')) parts.push(t('Descriptivos'));
  if (roles.includes('commentary')) parts.push(t('Comentarios'));
  return parts.join(' · ');
}

function baseConfig() {
  const retry = { maxAttempts: 3, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 20000 };
  const captions = $('#captions');
  const show = shaka.config?.AutoShowText;
  return {
    preferredAudioLanguage: prefs.audioLang || browserLang,
    preferredTextLanguage: prefs.textLang || browserLang,
    // Solo se muestran subtítulos si el usuario los dejó activados.
    ...(show ? { autoShowText: prefs.textOn ? show.IF_PREFERRED_TEXT_LANGUAGE : show.NEVER } : {}),
    // Subtítulos en una capa HTML propia: respeta estilos TTML/WebVTT y se aparta de los controles.
    textDisplayFactory: () => new shaka.text.UITextDisplayer($('#video'), captions),
    manifest: { retryParameters: retry },
    streaming: { retryParameters: retry, bufferingGoal: 30, rebufferingGoal: 2 },
    drm: { retryParameters: retry }
  };
}

async function play(channel) {
  if (!player) return;
  const token = ++loadToken;
  state.current = channel;
  showPlayer();
  renderNowPlaying();
  markPlaying();
  if (!channel.catchupBase) pushRecent(channel);
  hideOverlay();
  controls.wake();
  controls.setEnabled(false);
  controls.setBusy(true);

  const type = detectType(channel.url, channel.type);
  const drmText = drmLabel(channel.drm);
  setStatus(t('Cargando {what}…', { what: `${typeLabel(type)}${drmText ? ' · ' + drmText : ''}` }));

  if (channel.errors?.length) setStatus(t('Aviso en la entrada M3U: {msg}', { msg: channel.errors.join(' · ') }), 'warn');

  try {
    await applyHeaderRules(channel.headers, channel.drm?.licenseUrl, channel.drm?.licenseHeaders);
  } catch (err) {
    console.warn('No se pudieron aplicar las cabeceras', err);
  }
  try {
    const proxy = await applyChannelProxy(channel);
    if (proxy) setStatus(`${t('Cargando {what}…', { what: typeLabel(type) })} · ${t('vía {proxy}', { proxy: describeProxy(proxy) })}`);
  } catch (err) {
    if (token !== loadToken) return;
    controls.setBusy(false);
    showOverlay(t('No se pudo usar el proxy'), err.message, true);
    setStatus(`${t('No se pudo usar el proxy')}: ${err.message}`, 'err');
    return;
  }
  if (token !== loadToken) return;

  if (channel.engine === 'dashjs') return playWithDash(channel, token, type, drmText);
  if (channel.engine === 'hlsjs') return playWithHls(channel, token, drmText);
  if (channel.engine === 'mpegts' || type === 'ts') return playWithTs(channel, token);
  await useShaka();
  if (token !== loadToken) return;

  player.resetConfiguration();
  player.configure(baseConfig());
  player.configure({ drm: buildShakaDrmConfig(channel.drm) });

  try {
    await player.load(channel.url, null, MIME[type]);
    if (token !== loadToken) return;
    const video = $('#video');
    if (video.paused) video.play().catch(() => {});
    setStatus(TYPE_LABEL[type] === 'Auto' ? `${t('Reproduciendo')} · ${detectLoadedType()}` : t('Reproduciendo'), 'ok');
    controls.setEnabled(true);
    store.patchState({ channelUrl: channel.url });
  } catch (err) {
    if (token !== loadToken) return;
    // Shaka no soporta Smooth Streaming en directo → dash.js
    if (err?.code === MSS_LIVE_NOT_SUPPORTED && channel.engine !== 'shaka') {
      setStatus(t('Smooth Streaming en directo: cambiando al motor dash.js…'), 'warn');
      return playWithDash(channel, token, 'mss', drmText);
    }
    // Sin manifiesto reconocible: puede ser un MPEG-TS en directo (Xtream, receptores…)
    if (err?.code === shaka.util.Error.Code.UNABLE_TO_GUESS_MANIFEST_TYPE && type === 'auto' && channel.engine !== 'shaka') {
      setStatus(t('Sin manifiesto: probando como MPEG-TS en directo…'), 'warn');
      return playWithTs(channel, token);
    }
    // HLS con TS cifrado SAMPLE-AES (FairPlay) → hls.js, si hay clave o proxy de claves
    const fairplay = err?.code === HLS_ENCRYPTED_TS || (err?.code === KEY_SYSTEM_UNAVAILABLE && type === 'hls');
    if (fairplay && channel.engine !== 'shaka' && hasSampleAesKey(channel.drm)) {
      setStatus(t('HLS SAMPLE-AES (FairPlay): descifrando con la clave en el motor hls.js…'), 'warn');
      return playWithHls(channel, token, drmText);
    }
    showError(err);
  }
}

/** Muestra el reproductor (oculto hasta que se reproduce algo) y sube hasta él. */
function showPlayer() {
  const app = $('#app');
  if (app.dataset.player === '1') return;
  app.dataset.player = '1';
  $('#main').scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Detiene la reproducción y vuelve a ocultar el reproductor. */
async function stopPlayback() {
  loadToken++;
  state.current = null;
  clearProxy().catch(() => {});
  controls.setEnabled(false);
  controls.setBusy(false);
  hideOverlay();
  if (engine !== 'shaka') await useShaka();
  else { try { await player.unload(); } catch (_) { /* nada cargado */ } }
  clearCaptions();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#app').dataset.player = '';
  renderNowPlaying();
  markPlaying();
  setStatus('');
  if (isSide()) showIdle();
  syncMini();
  store.patchState({ channelUrl: '' });
}

/** Quita restos de subtítulos del motor anterior (dash.js deja pistas nativas). */
function clearCaptions() {
  $('#captions').replaceChildren();
  for (const t of $('#video').textTracks) t.mode = 'disabled';
}

async function useShaka() {
  if (engine === 'shaka') return;
  engine = 'shaka';
  await dashEngine.destroy();
  await hlsEngine.destroy();
  await tsEngine.destroy();
  clearCaptions();
  const video = $('#video');
  video.autoplay = true; // dash.js lo desactiva al destruirse
  video.removeAttribute('src');
  video.load();
  await player.attach(video);
}

async function useAlt(name) {
  if (engine === name) return;
  if (engine === 'shaka') await player.detach();
  else await ALT_ENGINES()[engine].destroy();
  engine = name;
  clearCaptions();
}

/** ¿Hay con qué descifrar SAMPLE-AES? Claves locales o proxy de claves. */
function hasSampleAesKey(drm) {
  return !!drm && drm.system === 'clearkey' && (Object.keys(drm.keys || {}).length > 0 || !!drm.licenseUrl);
}

async function playWithHls(channel, token, drmText) {
  if (!(await HlsEngine.ensureLoaded())) {
    showError(new Error(t('{name} no está disponible.', { name: 'hls.js' })));
    return;
  }
  await useAlt('hlsjs');
  if (token !== loadToken) return;
  setStatus(t('Cargando {what}…', { what: `HLS (hls.js)${drmText ? ' · ' + drmText : ''}` }));
  const video = $('#video');
  // Si no arranca en un tiempo razonable, se dice por qué en vez de quedarse en «Cargando…».
  const watchdog = setTimeout(() => {
    if (token !== loadToken || engine !== 'hlsjs' || !video.paused || video.currentTime > 0) return;
    const issue = hlsEngine.lastIssue || {
      title: t('El stream no arranca'),
      text: t('hls.js no ha recibido vídeo en {s} s y el servidor no ha devuelto ningún error.\nRevisa la URL, las cabeceras (User-Agent, Referer, Cookie) y la clave o el proxy de claves.', { s: HLS_START_TIMEOUT / 1000 })
    };
    hlsEngine.destroy();
    controls.setEnabled(false);
    controls.setBusy(false);
    showOverlay(issue.title, issue.text, true);
    setStatus(`${issue.title}: ${issue.text.split('\n')[0]}`, 'err');
  }, HLS_START_TIMEOUT);
  video.addEventListener('playing', () => {
    clearTimeout(watchdog);
    if (token === loadToken) {
      setStatus(`${t('Reproduciendo')} · hls.js`, 'ok');
      controls.refreshTracks();
      store.patchState({ channelUrl: channel.url });
    }
  }, { once: true });
  try {
    await hlsEngine.load(channel, {
      audioLang: prefs.audioLang || browserLang,
      textLang: prefs.textLang || browserLang,
      textOn: prefs.textOn
    });
    if (token === loadToken) controls.setEnabled(true);
  } catch (err) {
    if (token === loadToken) showError(err);
  }
}

const TS_START_TIMEOUT = 15000;

/** MPEG-TS en directo (receptores Enigma2/OpenWebIF, .ts de Xtream…) con mpegts.js. */
async function playWithTs(channel, token) {
  if (!(await TsEngine.ensureLoaded())) {
    showError(new Error(t('{name} no está disponible.', { name: 'mpegts.js' })));
    return;
  }
  await useAlt('mpegts');
  if (token !== loadToken) return;
  setStatus(t('Cargando {what}…', { what: 'MPEG-TS (mpegts.js)' }));
  const video = $('#video');
  const fail = (title, text) => {
    if (token !== loadToken) return;
    tsEngine.destroy();
    controls.setEnabled(false);
    controls.setBusy(false);
    showOverlay(title, text, true);
    setStatus(`${title}: ${text.split('\n')[0]}`, 'err');
  };
  const watchdog = setTimeout(() => {
    if (token !== loadToken || engine !== 'mpegts' || tsEngine.failed || !video.paused || video.currentTime > 0) return;
    const issue = tsEngine.lastIssue || {
      title: t('El stream no arranca'),
      text: t('No ha llegado vídeo en {s} s.\nSi es un receptor: comprueba que está encendido, que el canal se puede sintonizar y que no está grabando en otro transpondedor.', { s: TS_START_TIMEOUT / 1000 })
    };
    fail(issue.title, issue.text);
  }, TS_START_TIMEOUT);
  tsEngine.onInfo = (info) => {
    if (token !== loadToken) return;
    // Los canales SD de satélite/TDT suelen ir en MPEG-2, que ningún navegador decodifica.
    if (info && info.hasVideo === false && info.hasAudio) {
      setStatus(t('Solo se oye el audio: el vídeo está en MPEG-2 y el navegador no lo decodifica. Activa la transcodificación del receptor (puerto 8002) si la tiene.'), 'warn');
    }
  };
  video.addEventListener('playing', () => {
    clearTimeout(watchdog);
    if (token === loadToken) {
      const mi = tsEngine.mediaInfo;
      const vc = mi?.videoCodec ? ` · ${String(mi.videoCodec).split('.')[0].replace('avc1', 'H.264').replace(/hvc1|hev1/, 'H.265')}` : '';
      if (mi?.hasVideo !== false) setStatus(`${t('Reproduciendo')} · MPEG-TS${vc}`, 'ok');
      controls.refreshTracks();
      store.patchState({ channelUrl: channel.url });
    }
  }, { once: true });
  try {
    await tsEngine.load(channel);
    if (token === loadToken) controls.setEnabled(true);
  } catch (err) {
    clearTimeout(watchdog);
    if (token === loadToken) showError(err);
  }
}

async function playWithDash(channel, token, type, drmText) {
  if (!(await DashEngine.ensureLoaded())) {
    showError(new Error(t('{name} no está disponible.', { name: 'dash.js' })));
    return;
  }
  await useAlt('dashjs');
  if (token !== loadToken) return;
  const label = `${typeLabel(type)} (dash.js)${drmText ? ' · ' + drmText : ''}`;
  setStatus(t('Cargando {what}…', { what: label }));
  const video = $('#video');
  video.addEventListener('playing', () => {
    if (token === loadToken) {
      setStatus(`${t('Reproduciendo')} · dash.js`, 'ok');
      controls.refreshTracks();
      store.patchState({ channelUrl: channel.url });
    }
  }, { once: true });
  try {
    await dashEngine.load(channel, {
      captions: $('#captions'),
      audioLang: prefs.audioLang || browserLang,
      textLang: prefs.textLang || browserLang,
      textOn: prefs.textOn
    });
    if (token === loadToken) controls.setEnabled(true);
  } catch (err) {
    if (token === loadToken) showError(err);
  }
}

function detectLoadedType() {
  const t = player.getManifestType?.();
  return { DASH: 'DASH', HLS: 'HLS', MSS: 'Smooth Streaming' }[t] || typeLabel('progressive');
}

// ---------- Errores ----------

function describeError(err) {
  const E = shaka.util.Error;
  if (!err || !(err instanceof E)) {
    return { title: t('No se pudo reproducir'), text: String(err?.message || err) };
  }
  const C = E.Code;
  const name = Object.keys(C).find((k) => C[k] === err.code) || '';
  const inner = err.data?.find?.((d) => d instanceof E);
  const http = (e) => (e && e.code === C.BAD_HTTP_STATUS ? `HTTP ${e.data[1]}` : '');

  switch (err.code) {
    case C.LOAD_INTERRUPTED:
    case C.OPERATION_ABORTED:
      return null;
    case C.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE:
    case C.FAILED_TO_CREATE_CDM:
      if (detectType(state.current?.url, state.current?.type) === 'hls') {
        return {
          title: t('DRM no soportado (¿HLS FairPlay?)'),
          text: t('Chrome no tiene FairPlay. Si el stream usa SAMPLE-AES y conoces la clave de contenido, se puede descifrar.\nCon «Editar», elige DRM ClearKey y pon la clave (solo KEY o *:KEY:IV) o un proxy de claves en «Servidor de licencias».')
        };
      }
      return {
        title: t('DRM no soportado'),
        text: t('El navegador no soporta el sistema DRM requerido.\nPlayReady solo funciona en Microsoft Edge; en Chrome usa Widevine o ClearKey.')
      };
    case C.NO_LICENSE_SERVER_GIVEN:
      return { title: t('Contenido cifrado'), text: t('Falta el servidor de licencias o las claves ClearKey.\nUsa «Editar» para añadirlas.') };
    case C.LICENSE_REQUEST_FAILED:
      return { title: t('Falló la licencia'), text: t('El servidor de licencias rechazó la petición {http}.\nRevisa la URL y las cabeceras de la licencia.', { http: http(inner) }) };
    case C.LICENSE_RESPONSE_REJECTED:
      return { title: t('Licencia no válida'), text: t('El CDM rechazó la respuesta de licencia (¿plantilla de respuesta incorrecta?).') };
    case C.BAD_HTTP_STATUS:
      return { title: `${t('Error')} HTTP ${err.data[1]}`, text: `${shortUrl(err.data[0])}\n${t('Puede requerir User-Agent, Referer o Cookie (usa «Editar»).')}` };
    case C.HTTP_ERROR:
      return { title: t('Error de red'), text: t('No se pudo conectar con {url}.', { url: shortUrl(err.data[0]) }) };
    case C.TIMEOUT:
      return { title: t('Tiempo agotado'), text: t('El servidor no respondió: {url}', { url: shortUrl(err.data[0]) }) };
    case C.UNABLE_TO_GUESS_MANIFEST_TYPE:
      return { title: t('Tipo desconocido'), text: t('No se pudo detectar el formato.\nIndica el tipo (DASH / HLS / Smooth Streaming) con «Editar».') };
    case C.CONTENT_UNSUPPORTED_BY_BROWSER:
      return { title: t('Formato no soportado'), text: t('Los códecs de este stream no son compatibles con el navegador.') };
    case C.HLS_MSE_ENCRYPTED_MP2T_NOT_SUPPORTED ?? 4040:
      return {
        title: t('HLS cifrado con SAMPLE-AES (FairPlay)'),
        text: t('Chrome no tiene FairPlay, pero el stream se puede descifrar si tienes la clave de contenido.\nCon «Editar», elige DRM ClearKey y pon la clave (solo KEY o KID:KEY) o un proxy de claves en «Servidor de licencias».')
      };
    case C.VIDEO_ERROR:
      return {
        title: t('Error de decodificación'),
        text: t('El vídeo no se pudo decodificar.') + (state.current?.drm?.system === 'clearkey' ? '\n' + t('¿Son correctas las claves ClearKey (KID:KEY)?') : '')
      };
    default:
      return { title: `${t('Error')} ${err.code}`, text: `${name}${inner ? ` (${inner.code})` : ''}\n${t('Prueba a reintentar o revisa el tipo y las cabeceras del stream.')}` };
  }
}

function showError(err) {
  console.error(err);
  const info = describeError(err);
  if (!info) return;
  controls?.setEnabled(false);
  controls?.setBusy(false);
  showOverlay(info.title, info.text, true);
  setStatus(`${info.title}: ${info.text.split('\n')[0]}`, 'err');
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.host + (url.pathname.length > 40 ? url.pathname.slice(0, 40) + '…' : url.pathname);
  } catch (_) { return String(u || ''); }
}


// ======================================================================
// Listas y canales
// ======================================================================

const NO_GROUP = '\u0000';
const ROW_LIMIT = 24; // tarjetas por fila en la portada
const GRID_CHUNK = 120; // tarjetas por tanda en la cuadrícula
const BLOCK_CHUNK = 6; // bloques por tanda en la portada
const countCache = new Map();

const groupKey = (c) => c.group || NO_GROUP;
const groupLabel = (g) => (g === NO_GROUP ? t('Sin categoría') : g);
const activeList = () => state.playlists.find((p) => p.id === state.activeId) || null;
const manualLists = () => state.playlists.filter((p) => p.source === 'manual');
const isManualActive = () => activeList()?.source === 'manual';

async function loadData() {
  state.playlists = await store.getPlaylists();
  state.favorites = await store.getFavorites();
  syncFavSet();
  state.recents = await store.get('recents', []);
}

function channelsOf(pl) {
  return pl.channels.map((c, i) => ({ ...c, id: `m${i}`, index: i, listId: pl.id, errors: [] }));
}

function countOf(pl) {
  if (pl.source === 'manual') return pl.channels.length;
  if (pl.id === state.activeId && state.channels.length) return state.channels.length;
  return countCache.get(`${pl.id}|${pl.updatedAt}`);
}

async function selectPlaylist(id, { refresh = false, keepGroup = false } = {}) {
  state.activeId = id;
  if (!keepGroup) state.group = '';
  if (id === FAV_ID) {
    state.channels = state.favorites.map((c, i) => ({ ...c, id: `fav${i}`, favIndex: i }));
  } else {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) return selectPlaylist(FAV_ID);
    if (pl.source === 'manual') {
      state.channels = channelsOf(pl);
    } else {
      try {
        if (refresh || !pl.text) await fetchPlaylist(pl);
        state.channels = parsedChannels(pl);
        countCache.set(`${pl.id}|${pl.updatedAt}`, state.channels.length);
      } catch (err) {
        state.channels = [];
        setStatus(t('No se pudo cargar «{name}»: {msg}', { name: pl.name, msg: err.message }), 'err');
      }
    }
    // Auto-carga de EPG si la lista lo incluye y no está cargado ya
    if (pl.epg && getEpgStats().url !== pl.epg) {
      (pl.box ? loadBoxEpg(pl) : loadEpgFromUrl(pl.epg, { name: pl.name })).then(() => {
        updateNowPlayingEpg();
        if (state.view === 'epg') renderEpgView();
        if (state.view === 'browse') renderBrowse();
      }).catch((err) => {
        console.warn('Auto-carga de EPG falló:', err);
      });
    }
  }
  if (state.group && !groupNames().includes(state.group)) state.group = '';
  renderListPicker();
  renderBrowse({ animate: true });
  if (state.view === 'epg') renderEpgView();
  store.patchState({ playlistId: id, group: state.group });
}

async function fetchPlaylist(pl) {
  if (pl.source !== 'url') return;
  if (pl.box) {
    setStatus(t('Leyendo los bouquets de «{name}»…', { name: pl.name }));
    const res = await buildBoxPlaylist(pl.box, pl.box);
    pl.text = res.text;
    pl.boxBouquets = res.bouquets.map((b) => b.ref);
    pl.updatedAt = new Date().toISOString();
    await store.savePlaylists(state.playlists);
    setStatus(t('«{name}» actualizada', { name: pl.name }), 'ok');
    return;
  }
  setStatus(t('Descargando «{name}»…', { name: pl.name }));
  const general = generalProxy();
  const viaProxy = !!general && (!activeProxy() || activeProxy().pac === general.pac);
  if (viaProxy) await setProxy(general, [pl.url]).catch(() => {});
  let res;
  try {
    res = await fetch(pl.url, { cache: 'no-store' });
  } finally {
    if (viaProxy && !state.current) clearProxy().catch(() => {});
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  pl.text = await res.text();
  pl.updatedAt = new Date().toISOString();
  await store.savePlaylists(state.playlists);
  setStatus(t('«{name}» actualizada', { name: pl.name }), 'ok');
}

/** Guía TV de un receptor OpenWebIF (se pide a su API, no hay XMLTV). */
async function loadBoxEpg(pl) {
  let refs = pl.boxBouquets;
  if (!refs?.length) refs = (await listBouquets(pl.box, pl.box)).map((b) => b.ref);
  const parsed = await fetchBoxEpg(pl.box, refs);
  return loadEpgData(parsed, { url: pl.epg, name: pl.name });
}

/** Canales de una lista M3U ya analizados (no se vuelve a parsear al cambiar de lista). */
const parseCache = new Map();
function parsedChannels(pl) {
  const key = `${pl.id}|${pl.updatedAt}|${pl.text.length}`;
  let channels = parseCache.get(pl.id)?.key === key ? parseCache.get(pl.id).channels : null;
  if (!channels) {
    const res = parseM3U(pl.text, pl.url);
    channels = res.channels;
    if (res.epg && !pl.epg) {
      pl.epg = res.epg;
      store.savePlaylists(state.playlists).catch(() => {});
    }
    parseCache.set(pl.id, { key, channels });
  }
  return channels;
}

/**
 * Categorías y canales por categoría de la lista activa. Se calculan una vez por
 * cambio de canales (no en cada repintado): con miles de canales se nota.
 */
let groupMemo = null;
function groupData() {
  const pl = activeList();
  const sig = pl?.source === 'manual' ? groupsOf(pl).join('\u0001') : '';
  if (groupMemo && groupMemo.channels === state.channels && groupMemo.sig === sig) return groupMemo;
  const names = pl?.source === 'manual' ? [...groupsOf(pl)] : [];
  const map = new Map(names.map((g) => [g, []]));
  const loose = [];
  for (const c of state.channels) {
    const g = groupKey(c);
    if (g === NO_GROUP) { loose.push(c); continue; }
    let arr = map.get(g);
    if (!arr) { arr = []; map.set(g, arr); names.push(g); }
    arr.push(c);
  }
  if (loose.length) { names.push(NO_GROUP); map.set(NO_GROUP, loose); }
  groupMemo = { channels: state.channels, sig, names, map };
  return groupMemo;
}

/** Categorías de la lista activa, en orden; «Sin categoría» al final. */
const groupNames = () => groupData().names;
const buckets = () => groupData().map;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Canales visibles (para anterior / siguiente): portada en orden de bloques. */
function computeFiltered() {
  const q = norm(state.query);
  const g = state.group;
  if (!g && !q) {
    state.filtered = [...buckets().values()].flat();
    return;
  }
  state.filtered = state.channels.filter((c) => {
    if (g && groupKey(c) !== g) return false;
    if (q && !norm(c.name).includes(q) && !norm(c.group).includes(q)) return false;
    return true;
  });
}

const favKey = (c) => `${c.url}|${c.name}`;
/** Canal original de una reproducción en diferido (catch-up), o el propio canal. */
const baseChannel = (c) => c?.catchupBase || c;
/** Claves de los favoritos: comprobar si un canal es favorito es inmediato. */
let favSet = new Set();
const syncFavSet = () => { favSet = new Set(state.favorites.map(favKey)); };
const isFav = (c) => favSet.has(favKey(c));

async function toggleFavorite(channel) {
  const key = favKey(channel);
  const idx = state.favorites.findIndex((f) => favKey(f) === key);
  const on = idx < 0;
  if (on) {
    state.favorites.push(cleanChannel(channel));
    toast(t('Añadido a favoritos'));
  } else {
    state.favorites.splice(idx, 1);
    toast(t('Eliminado de favoritos'));
  }
  syncFavSet();
  store.saveFavorites(state.favorites).catch(() => {});
  renderListPicker();
  renderNowPlaying();
  if (state.activeId === FAV_ID) {
    state.channels = state.favorites.map((c, i) => ({ ...c, id: `fav${i}`, favIndex: i }));
    renderBrowse({ preserve: true });
    return;
  }
  // Sin repintar la página: estrellas de ese canal y bloque de Favoritos.
  for (const card of document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`)) {
    const star = card.querySelector('.card-fav');
    star.classList.toggle('on', on);
    star.dataset.tip = t(on ? 'Quitar de favoritos' : 'Añadir a favoritos');
    star.setAttribute('aria-label', star.dataset.tip);
  }
  const body = $('#browseBody');
  const old = body.querySelector('.block[data-block="fav"]');
  const homeMode = !state.group && !state.query.trim();
  if (!homeMode) return;
  if (!state.favorites.length) { old?.remove(); return; }
  const block = blockEl({ id: 'fav', title: t('Favoritos'), icon: 'i-star', items: state.favorites, layout: 'row', more: () => selectPlaylist(FAV_ID) });
  if (old) old.replaceWith(block);
  else body.prepend(block);
  markPlaying();
}

function pushRecent(channel) {
  if (!channel?.url) return;
  const copy = cleanChannel(channel);
  state.recents = [copy, ...state.recents.filter((c) => favKey(c) !== favKey(copy))].slice(0, RECENT_MAX);
  store.set('recents', state.recents).catch(() => {});
  // Actualiza solo la fila de recientes, sin repintar el resto de la página.
  const old = document.querySelector('#browseBody .block[data-block="recents"]');
  if (old) {
    old.replaceWith(blockEl({ id: 'recents', title: t('Vistos recientemente'), icon: 'i-refresh', items: state.recents, layout: 'row', clear: true }));
    markPlaying();
  }
}

function initials(name) {
  return String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function hueOf(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function logoEl(className, channel) {
  const box = document.createElement('span');
  box.className = className;
  if (channel.logo) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = channel.logo;
    img.onerror = () => { box.textContent = initials(channel.name); };
    box.appendChild(img);
  } else {
    box.textContent = initials(channel.name);
  }
  return box;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function iconEl(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function iconButton(icon, title, onClick, cls = 'icon-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.tip = title;
  b.setAttribute('aria-label', title);
  b.appendChild(iconEl(icon.replace(/^#/, '')));
  b.addEventListener('click', onClick);
  return b;
}

function renderNowPlaying() {
  const c = state.current;
  const logo = $('#npLogo');
  $('#npMeta').replaceChildren();
  if (!c) {
    logo.replaceChildren();
    $('#npTitle').textContent = t('Nada en reproducción');
    $('#fsTitle').textContent = '';
    $('#btnFav').classList.remove('on');
    document.title = 'IP Player';
    updateNowPlayingEpg();
    return;
  }
  logo.replaceWith(Object.assign(logoEl('np-logo', c), { id: 'npLogo' }));
  $('#npTitle').textContent = c.name;
  $('#fsTitle').textContent = c.name;
  document.title = `${c.name} · IP Player`;
  const meta = $('#npMeta');
  const badge = (text, cls) => meta.appendChild(el('span', `badge ${cls || ''}`, text));
  const type = detectType(c.url, c.type);
  badge(typeLabel(type), 'type');
  if (c.archive) badge(t('En diferido'), 'archive');
  if (drmLabel(c.drm)) badge(drmLabel(c.drm), 'drm');
  try { if (channelProxy(c)) badge(t('Proxy'), 'proxy'); } catch (_) { /* proxy no válido */ }
  if (c.group && c.group !== drmLabel(c.drm) && c.group !== TYPE_LABEL[type]) badge(c.group);
  $('#btnFav').classList.toggle('on', isFav(baseChannel(c)));
  $('#btnFav').dataset.tip = t(isFav(baseChannel(c)) ? 'Quitar de favoritos' : 'Añadir a favoritos');
  updateNowPlayingEpg();
}

/** Marca la tarjeta del canal en reproducción sin volver a pintar la cuadrícula. */
function markPlaying() {
  for (const c of document.querySelectorAll('.card.playing, .side-row.playing')) {
    c.classList.remove('playing');
    if (c.classList.contains('side-row')) c.setAttribute('aria-selected', 'false');
  }
  if (!state.current) return;
  const key = CSS.escape(favKey(baseChannel(state.current)));
  for (const c of document.querySelectorAll(`.card[data-key="${key}"], .side-row[data-key="${key}"]`)) {
    c.classList.add('playing');
    if (c.classList.contains('side-row')) c.setAttribute('aria-selected', 'true');
  }
}

function step(delta) {
  const items = state.filtered;
  if (!items.length) return;
  let idx = state.current ? items.findIndex((c) => favKey(c) === favKey(baseChannel(state.current))) : -1;
  idx = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
  play(items[idx]);
}

// ---------- Menús emergentes (lista, añadir, opciones de canal) ----------

let pop = null;

/** Abre un menú flotante junto a un botón (o en un punto) con animación de entrada. */
function showPop(menu, anchor, { align = 'start', point = null, focus = false } = {}) {
  closePop();
  // Un diálogo modal deja inerte todo lo que queda fuera de él: si el botón está dentro
  // de un diálogo abierto, el menú se coloca dentro de ese diálogo para poder usarlo.
  const host = anchor?.closest('dialog[open]') || document.body;
  if (menu.parentElement !== host) host.appendChild(menu);
  menu.dataset.open = '';
  const r = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x = align === 'end' ? r.right - w : r.left;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  let y = r.bottom + 6;
  let originY = 'top';
  if (y + h > innerHeight - 8 && r.top - h - 6 > 8) { y = r.top - h - 6; originY = 'bottom'; }
  menu.style.left = `${x}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  menu.style.transformOrigin = `${align === 'end' ? 'right' : 'left'} ${originY}`;
  anchor?.setAttribute('aria-expanded', 'true');
  pop = { menu, anchor };
  if (focus) menu.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
}

function closePop({ refocus = false } = {}) {
  if (!pop) return;
  const { menu, anchor } = pop;
  delete menu.dataset.open;
  anchor?.setAttribute('aria-expanded', 'false');
  pop = null;
  if (refocus) anchor?.focus();
}

function togglePop(menu, anchor, opts) {
  if (pop?.menu === menu) { closePop(); return; }
  if (menu._render) menu._render();
  showPop(menu, anchor, opts);
}

function menuItem(menu, { icon, label, sub, onClick, danger = false, checked = null, disabled = false }) {
  const b = el('button', 'pop-item' + (danger ? ' danger' : ''));
  b.type = 'button';
  b.setAttribute('role', checked == null ? 'menuitem' : 'menuitemradio');
  if (checked != null) b.setAttribute('aria-checked', String(checked));
  b.disabled = disabled;
  b.appendChild(icon ? iconEl(icon) : el('span', 'pop-ico-space'));
  const text = el('span', 'pop-text');
  text.appendChild(el('span', 'pop-label', label));
  if (sub) text.appendChild(el('span', 'pop-sub', sub));
  b.appendChild(text);
  if (checked) {
    const check = iconEl('i-check');
    check.classList.add('pop-check');
    b.appendChild(check);
  }
  b.addEventListener('click', () => { closePop(); onClick(); });
  menu.appendChild(b);
  return b;
}

const menuSep = (menu) => menu.appendChild(el('div', 'pop-sep'));
const menuLabel = (menu, text) => menu.appendChild(el('div', 'pop-group', text));

// ---------- Selector de lista ----------

function renderListPicker() {
  $('#listPickerValue').textContent = state.activeId === FAV_ID ? t('Favoritos') : activeList()?.name || t('Favoritos');
}

function buildListMenu() {
  const menu = $('#listMenu');
  menu.replaceChildren();
  menuItem(menu, {
    icon: 'i-star', label: t('Favoritos'), sub: t('{n} canales', { n: state.favorites.length }),
    checked: state.activeId === FAV_ID, onClick: () => selectPlaylist(FAV_ID)
  });
  if (state.playlists.length) menuLabel(menu, t('Tus listas'));
  for (const pl of state.playlists) {
    const n = countOf(pl);
    const kind = t(pl.source === 'manual' ? 'Lista propia' : pl.source === 'url' ? 'Desde URL' : 'Importada');
    menuItem(menu, {
      icon: pl.source === 'manual' ? 'i-edit' : pl.source === 'url' ? 'i-link' : 'i-list',
      label: pl.name,
      sub: n != null ? `${t('{n} canales', { n })} · ${kind}` : kind,
      checked: state.activeId === pl.id,
      onClick: () => selectPlaylist(pl.id)
    });
  }
  menuSep(menu);
  menuItem(menu, { icon: 'i-plus', label: t('Añadir lista M3U'), onClick: openAddPlaylist });
  menuItem(menu, { icon: 'i-folder-plus', label: t('Crear lista propia'), onClick: () => createListFlow() });
  menuItem(menu, { icon: 'i-gear', label: t('Gestionar listas…'), onClick: openManager });
}

// ---------- Idioma ----------

function buildLangMenu() {
  const menu = $('#langMenu');
  menu.replaceChildren();
  for (const l of LANGS) {
    if (!l.variants) {
      menuItem(menu, { label: l.name, checked: getLang() === l.code, onClick: () => changeLang(l.code) });
      continue;
    }
    // Idioma con variantes: una fila que despliega sus dialectos debajo.
    const current = l.variants.find((v) => v.code === getLang());
    const head = el('button', 'pop-item pop-sub-toggle');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!!current));
    const text = el('span', 'pop-text');
    text.appendChild(el('span', 'pop-label', l.name));
    if (current) text.appendChild(el('span', 'pop-sub', current.short));
    const caret = iconEl('i-next');
    caret.classList.add('pop-caret');
    head.append(el('span', 'pop-ico-space'), text, caret);
    const sub = el('div', 'pop-submenu');
    sub.dataset.open = current ? '1' : '';
    const inner = el('div', 'pop-submenu-inner');
    for (const v of l.variants) {
      menuItem(inner, { label: v.short, checked: getLang() === v.code, onClick: () => changeLang(v.code) });
    }
    inner.inert = !current;
    sub.appendChild(inner);
    head.addEventListener('click', () => {
      const open = sub.dataset.open !== '1';
      sub.dataset.open = open ? '1' : '';
      inner.inert = !open;
      head.setAttribute('aria-expanded', String(open));
      if (open) inner.querySelector('button')?.focus({ preventScroll: true });
    });
    menu.append(head, sub);
  }
}

/** Cambia el idioma de toda la interfaz sin recargar (la reproducción sigue). */
async function changeLang(code) {
  await setLang(code);
  translateStatic();
  refreshSelects();
  await applyUiPrefs({ lang: code });
  renderListPicker();
  renderBrowse({ preserve: true });
  renderNowPlaying();
  controls._syncPlayState();
  controls.refreshTracks();
  controls.updateTime();
  if (state.current && controls.enabled) setStatus(t('Reproduciendo'), 'ok');
}

// ---------- Menú «Añadir» ----------

function buildAddMenu() {
  const menu = $('#addMenu');
  menu.replaceChildren();
  const pl = activeList();
  const opt = (icon, label, sub, fn) => {
    const b = el('button', 'add-opt');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    const ico = el('span', 'add-ico');
    ico.appendChild(iconEl(icon));
    const text = el('span', 'add-text');
    text.append(el('span', 'add-label', label), el('span', 'add-sub', sub));
    b.append(ico, text);
    b.addEventListener('click', () => { closePop(); fn(); });
    menu.appendChild(b);
  };
  opt('i-link', t('Canal'), t('Pega el enlace de un stream (.m3u8, .mpd, Manifest)'), () => openAddChannel({ group: state.group && state.group !== NO_GROUP ? state.group : '' }));
  opt('i-folder-plus', t('Categoría'), pl?.source === 'manual' ? t('Nueva categoría en «{name}»', { name: pl.name }) : t('Para organizar tus listas propias'), () => openCategoryDialog());
  opt('i-list', t('Lista M3U'), t('Desde un enlace, un archivo o pegando el texto'), openAddPlaylist);
  opt('i-edit', t('Lista propia'), t('Vacía, para crear tus categorías y canales'), () => createListFlow());
  menuSep(menu);
  menuItem(menu, {
    icon: 'i-help', label: t('Modo principiante'), sub: t('Muestra una lista de requisitos al crear canales, listas y categorías'),
    checked: beginner, onClick: () => applyUiPrefs({ beginner: !beginner })
  });
}

// ---------- Modo principiante: requisitos al crear canales, listas y categorías ----------

let beginner = false;

/**
 * Pinta una lista de requisitos. items: [{ label, tip, done, optional, focus }].
 * Devuelve true si se cumplen todos los obligatorios (o si el modo está desactivado).
 */
function renderTodo(box, items) {
  box.hidden = !beginner;
  const required = items.filter((i) => !i.optional);
  const ready = required.every((i) => i.done);
  if (!beginner) return true;
  const done = required.filter((i) => i.done).length;
  box.replaceChildren();
  box.dataset.ready = ready ? '1' : '';
  const head = el('div', 'todo-head');
  head.append(el('span', 'todo-title', t('Antes de guardar')), el('span', 'todo-count', t('{n} de {total} listos', { n: done, total: required.length })));
  const hide = el('button', 'todo-hide', t('Ocultar'));
  hide.type = 'button';
  hide.addEventListener('click', () => {
    applyUiPrefs({ beginner: false });
    toast(t('Modo principiante desactivado. Puedes activarlo en Ayuda → Opciones o en el menú Añadir.'));
  });
  head.appendChild(hide);
  const bar = el('div', 'todo-bar');
  const fill = el('i');
  fill.style.transform = `scaleX(${required.length ? done / required.length : 1})`;
  bar.appendChild(fill);
  const list = el('ul', 'todo-list');
  for (const it of items) {
    const li = el('li', 'todo-item' + (it.done ? ' done' : '') + (it.optional ? ' optional' : ''));
    const b = el('button', 'todo-btn');
    b.type = 'button';
    if (it.tip) b.dataset.tip = it.tip;
    const mark = el('span', 'todo-mark');
    mark.appendChild(iconEl('i-check'));
    b.append(mark, el('span', 'todo-label', it.label));
    if (it.optional) b.appendChild(el('span', 'todo-opt', t('opcional')));
    b.addEventListener('click', () => {
      const target = typeof it.focus === 'function' ? it.focus() : $(it.focus);
      target?.focus();
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  box.append(head, bar, list);
  return ready;
}

const isHttpUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || '').trim());

function channelTodo() {
  const mode = state.streamMode.kind;
  const items = [{
    label: t('Pega un enlace que empiece por http:// o https://'),
    tip: t('Te lo da tu proveedor. Suele terminar en .m3u8, .mpd o /Manifest.'),
    done: isHttpUrl($('#fUrl').value), focus: '#fUrl'
  }];
  if (mode === 'add') {
    const isNew = $('#fList').value === '__new__';
    items.push(isNew
      ? { label: t('Escribe el nombre de la nueva lista'), tip: t('Los canales se guardan dentro de una lista propia.'), done: !!$('#fNewList').value.trim(), focus: '#fNewList' }
      : { label: t('Elige la lista donde guardarlo'), tip: t('Los canales se guardan dentro de una lista propia.'), done: true, focus: '#fListBtn' });
  }
  items.push({ label: t('Ponle un nombre (si no, se usa el del enlace)'), done: !!$('#fName').value.trim(), optional: true, focus: '#fName' });
  if (mode === 'add') items.push({ label: t('Elige una categoría'), done: !!$('#fCats').value?.(), optional: true, focus: () => $('#fCats .cat-opt[aria-checked="true"]') || $('#fCats .cat-opt') });
  items.push({
    label: t('Si el canal está cifrado, configura el DRM en «Opciones avanzadas»'),
    tip: t('Solo si el canal lo necesita (por ejemplo, claves ClearKey).'),
    done: $('#fDrm').value !== 'none', optional: true, focus: '#btnAdvanced'
  });
  const ready = renderTodo($('#fTodo'), items);
  $('#btnStreamSave').disabled = beginner && !ready;
  $('#btnStreamPlay').disabled = beginner && !isHttpUrl($('#fUrl').value);
}

function playlistTodo() {
  const byTab = {
    url: { label: t('Pega el enlace de la lista (http:// o https://)'), done: isHttpUrl($('#pUrl').value), focus: '#pUrl' },
    file: { label: t('Elige un archivo .m3u, .m3u8 o .json.'), done: !!$('#pFile').files?.length, focus: '#pFile' },
    text: { label: t('Pega el contenido de la lista.'), done: !!$('#pText').value.trim(), focus: '#pText' },
    box: { label: t('Escribe la dirección del receptor (p. ej. 192.168.1.10).'), done: !!$('#bHost').value.trim(), focus: '#bHost' }
  };
  const box = addTab === 'box';
  const items = [
    { ...byTab[addTab], tip: box ? t('La misma dirección con la que abres la web del receptor.') : t('Te lo da tu proveedor. Las listas por enlace se pueden actualizar después.') },
    { label: box ? t('Ponle un nombre (si no, se usa el modelo del receptor)') : t('Ponle un nombre (si no, se usa el del enlace o del archivo)'), done: !!$('#pName').value.trim(), optional: true, focus: '#pName' }
  ];
  const ready = renderTodo($('#pTodo'), items);
  $('#btnAddPlaylist').disabled = beginner && !ready;
}

function catTodo() {
  const name = $('#cName').value.trim();
  const isNew = $('#cList').value === '__new__';
  const pl = manualLists().find((p) => p.id === $('#cList').value);
  const taken = !!pl && !!name && groupsOf(pl).some((g) => g.toLowerCase() === name.toLowerCase());
  const items = [
    { label: t('Escribe el nombre de la categoría'), tip: t('Por ejemplo: Deportes, Noticias o Cine.'), done: !!name, focus: '#cName' },
    { label: t('Que no exista ya en esa lista'), done: !!name && !taken, focus: '#cName' },
    isNew
      ? { label: t('Escribe el nombre de la nueva lista'), done: !!$('#cNewName').value.trim(), focus: '#cNewName' }
      : { label: t('Elige en qué lista crearla'), done: true, focus: '#cListBtn' }
  ];
  const ready = renderTodo($('#cTodo'), items);
  $('#btnCatSave').disabled = beginner && !ready;
}

/** Actualiza las listas de requisitos de los diálogos abiertos. */
function refreshTodos() {
  if ($('#streamDialog')?.open) channelTodo();
  if ($('#manageDialog')?.open && $('#manageDialog').dataset.view === 'add') playlistTodo();
  if ($('#catDialog')?.open) catTodo();
}

// ---------- Vista lateral: canales en una columna ----------

const SIDE_CHUNK = 120; // filas por tanda (las listas pueden tener miles de canales)
let sideObserver = null;
let sideGroupSig = '';
let layoutFrom = null;
let sideCollapsed = false;

/** Pliega la lista lateral a una columna de logos (o, en móvil, a una tira horizontal). */
function setSideCollapsed(on) {
  const changed = on !== sideCollapsed;
  sideCollapsed = !!on;
  $('#app').dataset.sideCollapsed = sideCollapsed ? '1' : '';
  const btn = $('#btnSideCollapse');
  btn.dataset.tip = sideCollapsed ? t('Desplegar la lista') : t('Plegar la lista');
  btn.setAttribute('aria-label', btn.dataset.tip);
  btn.setAttribute('aria-expanded', String(!sideCollapsed));
  if (!changed || !isSide()) return;
  // Etiquetas con el nombre del canal solo cuando no se ve el texto
  for (const row of document.querySelectorAll('#sideList .side-row')) {
    if (sideCollapsed) row.dataset.tip = row._ch.name;
    else delete row.dataset.tip;
  }
  hideTooltip();
}

/** Cambia de vista. Las dos comparten reproductor, búsqueda, listas y guía. */
function setLayout(name) {
  const next = name === 'side' ? 'side' : 'blocks';
  const changed = next !== layout;
  layout = next;
  const side = isSide();
  // Las medidas de partida se toman antes de cambiar nada (ver más abajo).
  if (changed) layoutFrom = $('#app').dataset.mini === '1' ? null : $('#playerWrap').getBoundingClientRect();
  $('#app').dataset.layout = next;
  $('#side').hidden = !side;
  const btn = $('#btnLayout');
  btn.querySelector('use').setAttribute('href', side ? '#i-grid' : '#i-sidebar');
  btn.dataset.tip = side ? t('Vista de bloques') : t('Vista con lista lateral');
  btn.setAttribute('aria-label', btn.dataset.tip);
  btn.setAttribute('aria-pressed', String(side));
  for (const b of document.querySelectorAll('#layoutPick [data-layout]')) {
    b.setAttribute('aria-checked', String(b.dataset.layout === next));
  }
  if (!changed) return;
  if (state.view === 'epg' && side) toggleEpgView(false);
  const pw = $('#playerWrap');
  const from = layoutFrom;
  layoutFrom = null;
  syncMini();
  renderBrowseNow({ preserve: true });
  flipPlay(new Map());
  const to = pw.getBoundingClientRect();
  if (from?.width && to.width && !reduceMotion()) {
    pw.animate(
      [{ transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: 520, easing: FLIP_EASE }
    );
  }
  if (side && !state.current) showIdle();
  if (!side && !state.current) hideOverlay();
  if (side) requestAnimationFrame(() => $('#sideList .side-row.playing')?.scrollIntoView({ block: 'center' }));
  renderGuide();
}

/** Mensaje del reproductor vacío en la vista lateral. */
function showIdle() {
  const none = !state.playlists.length && !state.favorites.length;
  showOverlay(t('Selecciona un canal'), none
    ? t('Añade una lista M3U o un receptor con el botón «Añadir».')
    : t('Elige un canal en la lista de la izquierda.'));
}

function renderSide() {
  const pl = activeList();
  $('#sideTitle').textContent = state.activeId === FAV_ID ? t('Favoritos') : (pl?.name || '');

  // Categorías en un desplegable (se rehace solo si cambian)
  const names = groupNames();
  const sel = $('#sideGroup');
  const sig = `${getLang()}|${state.activeId}|${state.channels.length}|${names.join('\u0001')}`;
  if (sig !== sideGroupSig) {
    sideGroupSig = sig;
    const opts = [new Option(`${t('Todas las categorías')} · ${state.channels.length}`, '')];
    for (const g of names) opts.push(new Option(`${groupLabel(g)} · ${buckets().get(g)?.length || 0}`, g));
    sel.replaceChildren(...opts);
  }
  sel.value = names.includes(state.group) ? state.group : '';
  (sel._custom?.button || sel).hidden = names.length < 2;

  const q = state.query.trim();
  $('#sideSub').textContent = q
    ? t('Resultados ({n})', { n: state.filtered.length })
    : t('{n} canales', { n: state.filtered.length });

  const list = $('#sideList');
  sideObserver?.disconnect();
  sideObserver = null;
  list.replaceChildren();
  list.scrollTop = 0;
  const items = state.filtered;
  const empty = $('#sideEmpty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.replaceChildren(
      el('div', 'side-empty-title', q ? t('Sin resultados para «{q}»', { q }) : state.activeId === FAV_ID ? t('Todavía no tienes favoritos') : t('Esta lista no tiene canales')),
      el('div', 'side-empty-text', q ? t('Prueba con otro nombre o revisa la ortografía.') : t('Añade una lista M3U o un receptor con el botón «Añadir».'))
    );
    return;
  }
  const playingKey = state.current ? favKey(baseChannel(state.current)) : '';
  let done = 0;
  const more = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, done + SIDE_CHUNK);
    for (let i = done; i < end; i++) frag.appendChild(sideRow(items[i], playingKey));
    done = end;
    list.querySelector('.side-sentinel')?.remove();
    list.appendChild(frag);
    if (done < items.length) {
      const sentinel = el('div', 'side-sentinel');
      list.appendChild(sentinel);
      sideObserver ??= new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { root: list, rootMargin: '600px 0px' });
      sideObserver.observe(sentinel);
    }
  };
  more();
  // Si el canal en reproducción está más abajo, se cargan filas hasta llegar a él.
  const idx = playingKey ? items.findIndex((c) => favKey(c) === playingKey) : -1;
  while (idx >= done && done < items.length) more();
  const focusRow = list.querySelector('.side-row.playing') || list.querySelector('.side-row');
  if (focusRow) focusRow.tabIndex = 0;
}

function sideRow(c, playingKey) {
  const row = el('button', 'side-row');
  row.type = 'button';
  row.setAttribute('role', 'option');
  row.tabIndex = -1;
  row.dataset.key = favKey(c);
  row._ch = c;
  const playing = row.dataset.key === playingKey;
  row.classList.toggle('playing', playing);
  row.setAttribute('aria-selected', String(playing));
  row.style.setProperty('--h', String(hueOf(c.name)));
  if (sideCollapsed) row.dataset.tip = c.name;

  const text = el('span', 'side-text');
  const top = el('span', 'side-line');
  top.appendChild(el('span', 'side-name', c.name));
  if (isFav(c)) {
    const star = iconEl('i-star');
    star.classList.add('side-fav');
    top.appendChild(star);
  }
  text.append(top, el('span', 'side-epg'));
  row.append(logoEl('side-logo', c), text);
  if (c.chno) row.appendChild(el('span', 'side-chno', c.chno));
  fillSideEpg(row);

  row.addEventListener('click', () => play(c));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardMenu(c, { point: { x: e.clientX, y: e.clientY } }); });
  return row;
}

/** Programa en curso y barra de progreso de una fila (o, sin guía, el grupo y el tipo). */
function fillSideEpg(row) {
  const c = row._ch;
  const box = row.querySelector('.side-epg');
  const info = hasEpg() ? getNowAndNext(c) : null;
  if (info?.now?.title) {
    box.className = 'side-epg has-now';
    box.title = `${info.now.title} (${formatTime(new Date(info.now.start))} - ${formatTime(new Date(info.now.stop))})`;
    const bar = el('span', 'side-bar');
    const fill = el('span', 'side-fill');
    fill.style.width = `${info.progress}%`;
    bar.appendChild(fill);
    box.replaceChildren(el('span', 'side-prog', info.now.title), bar);
    return;
  }
  box.className = 'side-epg';
  box.removeAttribute('title');
  const type = detectType(c.url, c.type);
  const meta = [state.group ? '' : c.group, type !== 'auto' ? typeLabel(type) : ''].filter(Boolean).join(' · ');
  box.replaceChildren(el('span', 'side-meta', meta || t('Stream')));
}

function refreshSideEpg() {
  if (!hasEpg()) return;
  for (const row of document.querySelectorAll('#sideList .side-row')) fillSideEpg(row);
}

function bindSide() {
  enhanceSelect($('#sideGroup'));
  $('#sideGroup').addEventListener('change', (e) => {
    state.group = e.target.value;
    if (state.query) { state.query = ''; $('#search').value = ''; }
    renderBrowse();
    store.patchState({ group: state.group });
  });
  // Teclado: flechas para moverse, Inicio/Fin; Intro reproduce (lo hace el botón).
  $('#sideList').addEventListener('keydown', (e) => {
    const row = e.target.closest('.side-row');
    if (!row) return;
    const rows = () => [...$('#sideList').querySelectorAll('.side-row')];
    let next = null;
    if (e.key === 'ArrowDown') next = row.nextElementSibling?.classList.contains('side-row') ? row.nextElementSibling : null;
    else if (e.key === 'ArrowUp') next = row.previousElementSibling || null;
    else if (e.key === 'Home') next = rows()[0];
    else if (e.key === 'End') next = rows().at(-1);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openCardMenu(row._ch, { anchor: row, focus: true });
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation(); // las flechas no deben cambiar el volumen
    if (e.key === 'ArrowUp' && !next) { $('#search').focus(); return; }
    if (!next) return;
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  });
}

// ---------- Guía del canal en la vista lateral (y catch-up) ----------

const DAY_MS = 86400000;
let guideDay = 0;
let guideFor = '';
const guideOpen = new Set();

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const timeRange = (p) => `${formatTime(new Date(p.start))} – ${formatTime(new Date(p.stop))}`;

function guideDayLabel(offset, ms) {
  if (offset === 0) return t('Hoy');
  if (offset === -1) return t('Ayer');
  if (offset === 1) return t('Mañana');
  return new Date(ms).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric' });
}

function minutesLeft(p, now) {
  const m = Math.max(0, Math.round((p.stop - now) / 60000));
  return m >= 60 ? t('quedan {h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('quedan {m} min', { m });
}

/** Reproduce un programa ya emitido (o el actual desde el principio) con el catch-up del canal. */
function playCatchup(base, prog) {
  const url = catchupUrl(base, prog);
  if (!url) return;
  const info = catchupInfo(base);
  const now = Date.now();
  play({
    ...base,
    url,
    // shift/append mantienen el formato del canal; el resto cambia de URL y se detecta solo
    type: info && (info.mode === 'shift' || info.mode === 'append') ? base.type : '',
    catchupBase: base,
    archive: { title: prog.title, start: prog.start, stop: prog.stop, live: prog.start <= now && prog.stop > now }
  });
}

function renderGuide() {
  const box = $('#guide');
  const cur = state.current;
  const base = baseChannel(cur);
  if (!box || !isSide() || !base || !hasEpg()) { if (box) box.hidden = true; return; }

  const key = favKey(base);
  const fresh = key !== guideFor;
  if (fresh) { guideFor = key; guideDay = 0; guideOpen.clear(); }
  const now = Date.now();
  const today = startOfDay(now);
  const cu = catchupInfo(base);

  // Días con programación: los del archivo (hasta 14 atrás, o ayer) hasta 3 días vista
  const back = cu ? Math.min(cu.days, 14) : 1; // pestañas solo de los días que trae la EPG
  const days = [];
  for (let o = -back; o <= 3; o++) {
    const from = today + o * DAY_MS;
    if (getChannelSchedule(base, from, from + DAY_MS).length) days.push(o);
  }
  if (!days.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!days.includes(guideDay)) guideDay = days.includes(0) ? 0 : days[0];

  const archive = cur.archive;
  $('#guideArchive').hidden = !archive;
  if (archive) {
    $('#guideArchiveText').textContent = t('En diferido: {title} · {time}', { title: archive.title, time: timeRange(archive) });
  }

  const cuEl = $('#guideCu');
  cuEl.hidden = !cu;
  if (cu) cuEl.textContent = t('Catch-up · {n} días', { n: cu.days });

  renderGuideNow(base, archive, cu, now);

  const tabs = $('#guideDays');
  tabs.replaceChildren(...days.map((o) => {
    const b = el('button', 'guide-day', guideDayLabel(o, today + o * DAY_MS));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(o === guideDay));
    b.addEventListener('click', () => { guideDay = o; guideOpen.clear(); renderGuide(); scrollGuideToNow(true); });
    return b;
  }));

  const list = $('#guideList');
  const keep = fresh ? 0 : list.scrollTop;
  const from = today + guideDay * DAY_MS;
  const progs = getChannelSchedule(base, from, from + DAY_MS);
  list.replaceChildren(...progs.map((p) => guideRow(base, p, archive, now)));
  if (fresh) scrollGuideToNow(false);
  else list.scrollTop = keep;
}

function renderGuideNow(base, archive, cu, now) {
  const box = $('#guideNow');
  const info = getNowAndNext(base, now);
  const focus = archive
    ? getChannelSchedule(base, archive.start, archive.start + 1).find((p) => p.start === archive.start) || archive
    : info.now || info.next;
  box.replaceChildren();
  if (!focus) { box.hidden = true; return; }
  box.hidden = false;
  const live = !archive && focus.start <= now && focus.stop > now;

  const kicker = el('div', 'gn-kicker');
  const tag = el('span', `gn-tag ${archive ? 'archive' : live ? 'live' : ''}`, archive ? t('En diferido') : live ? t('En directo') : t('A continuación'));
  kicker.append(tag, el('span', 'gn-time', timeRange(focus)));
  box.appendChild(kicker);

  const head = el('div', 'gn-head');
  if (focus.icon) {
    const img = document.createElement('img');
    img.className = 'gn-img';
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = focus.icon;
    img.onerror = () => img.remove();
    head.appendChild(img);
  }
  const titles = el('div', 'gn-titles');
  titles.appendChild(el('h3', 'gn-title', focus.title));
  const sub = [focus.subTitle, focus.category].filter(Boolean).join(' · ');
  if (sub) titles.appendChild(el('div', 'gn-sub', sub));
  head.appendChild(titles);
  box.appendChild(head);

  if (live) {
    const bar = el('div', 'gn-bar');
    const fill = el('span');
    fill.style.width = `${info.progress}%`;
    bar.appendChild(fill);
    box.append(bar, el('div', 'gn-left', minutesLeft(focus, now)));
  }
  if (focus.desc) box.appendChild(el('p', 'gn-desc', focus.desc));

  const actions = el('div', 'gn-actions');
  if (live && cu && canCatchup(base, focus, now)) {
    const restart = el('button', 'btn sm');
    restart.type = 'button';
    restart.append(iconEl('i-prev'), document.createTextNode(t('Ver desde el principio')));
    restart.addEventListener('click', () => playCatchup(base, focus));
    actions.appendChild(restart);
  }
  if (actions.childElementCount) box.appendChild(actions);

  const next = !archive && live ? info.next : null;
  if (next) box.appendChild(el('div', 'gn-next', t('Después, a las {time}: {title}', { time: formatTime(new Date(next.start)), title: next.title })));
}

function guideRow(base, p, archive, now) {
  const past = p.stop <= now;
  const live = p.start <= now && p.stop > now;
  const watching = !!archive && archive.start === p.start;
  const li = el('li', `gl-row${past ? ' past' : ''}${live ? ' live' : ''}${watching ? ' watching' : ''}`);
  const open = guideOpen.has(p.start);
  const main = el('button', 'gl-main');
  main.type = 'button';
  main.setAttribute('aria-expanded', String(open));
  main.appendChild(el('span', 'gl-time', formatTime(new Date(p.start))));
  const body = el('span', 'gl-body');
  body.appendChild(el('span', 'gl-title', p.title));
  const sub = [p.subTitle, p.category].filter(Boolean).join(' · ');
  if (sub) body.appendChild(el('span', 'gl-sub', sub));
  main.appendChild(body);
  if (watching) main.appendChild(el('span', 'gl-badge archive', t('Viendo')));
  else if (live) main.appendChild(el('span', 'gl-badge', t('Ahora')));
  main.addEventListener('click', () => {
    if (guideOpen.has(p.start)) guideOpen.delete(p.start); else guideOpen.add(p.start);
    const on = guideOpen.has(p.start);
    main.setAttribute('aria-expanded', String(on));
    li.classList.toggle('open', on);
  });
  li.appendChild(main);
  li.classList.toggle('open', open);

  if ((past || live) && canCatchup(base, p, now)) {
    const watch = el('button', 'gl-play');
    watch.type = 'button';
    watch.append(iconEl('i-play'), el('span', '', live ? t('Desde el inicio') : t('Ver')));
    watch.dataset.tip = t('Ver «{title}» en diferido', { title: p.title });
    watch.addEventListener('click', () => playCatchup(base, p));
    li.appendChild(watch);
  }
  li.appendChild(el('p', 'gl-desc', p.desc || t('Sin descripción.')));
  return li;
}

/** Lleva la parrilla al programa en emisión (sin mover la página). */
function scrollGuideToNow(smooth) {
  const list = $('#guideList');
  const row = list.querySelector('.gl-row.watching') || list.querySelector('.gl-row.live') || list.querySelector('.gl-row:not(.past)');
  const top = row ? Math.max(0, row.offsetTop - 8) : 0;
  list.scrollTo({ top, behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
}

// ---------- Explorador: cabecera, chips y bloques ----------

let gridObserver = null;

// ---------- Animación FLIP: cada caja se desliza hasta su sitio nuevo ----------
// Se mide dónde está cada tarjeta, se pinta la vista nueva y se anima cada una
// desde su posición anterior (First, Last, Invert, Play). Las nuevas aparecen en su sitio.

const FLIP_MS = 440;
const FLIP_EASE = 'cubic-bezier(0.2, 0.9, 0.25, 1)';
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLIP_SEL = '#browseBody .card[data-key], #browseBody .card-ghost, #browseBody .card-more-tile, #browseBody .block-head, #sideList .side-row';

function flipKey(node) {
  if (node.classList.contains('block-head')) return `h:${node.closest('.block')?.dataset.block || ''}`;
  if (node.classList.contains('card-ghost') || node.classList.contains('card-more-tile')) return `t:${node.closest('.block')?.dataset.block || ''}:${node.className}`;
  return `${node.classList.contains('side-row') ? 's' : 'c'}:${node.dataset.key}`;
}

/** Posiciones en pantalla (solo lo visible: con miles de canales no se mide todo). */
function flipSnapshot() {
  const map = new Map();
  if (reduceMotion()) return map;
  const vh = innerHeight;
  for (const node of document.querySelectorAll(FLIP_SEL)) {
    const r = node.getBoundingClientRect();
    if (!r.width || r.bottom < -80 || r.top > vh + 80) continue;
    const k = flipKey(node);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function flipPlay(before) {
  if (!before || reduceMotion()) return;
  const vh = innerHeight;
  const vw = innerWidth;
  let entering = 0;
  for (const node of document.querySelectorAll(FLIP_SEL)) {
    const r = node.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const old = before.get(flipKey(node))?.shift();
    if (old) {
      const dx = old.left - r.left;
      const dy = old.top - r.top;
      const sx = old.width / r.width;
      const sy = old.height / r.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      node.animate(
        [{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }],
        { duration: FLIP_MS, easing: FLIP_EASE }
      );
    } else {
      node.animate(
        [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }],
        { duration: 280, delay: Math.min(entering++, 14) * 16, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' }
      );
    }
  }
}

function renderBrowse(opts = {}) {
  const before = opts.animate || isSide() ? flipSnapshot() : null;
  renderBrowseNow(opts);
  if (before) flipPlay(before);
}

function renderBrowseNow({ animate = false, preserve = false } = {}) {
  computeFiltered();
  const body = $('#browseBody');
  const scrolls = preserve ? new Map([...body.querySelectorAll('.block')].map((b) => [b.dataset.block, b.querySelector('.row')?.scrollLeft || 0])) : null;
  gridObserver?.disconnect();
  gridObserver = null;
  body.dataset.animate = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? '1' : '';

  const onboarding = !state.playlists.length && !state.favorites.length;
  $('#emptyList').hidden = !onboarding;
  $('#browse').dataset.onboarding = onboarding ? '1' : '';
  renderBrowseHead();
  renderChips();
  body.replaceChildren();
  if (isSide()) renderSide();
  if (onboarding || isSide()) return;

  const q = state.query.trim();
  const manual = isManualActive();
  if (q || state.group) {
    if (!state.filtered.length && !(manual && state.group && !q)) {
      body.appendChild(emptyBlock(q ? t('Sin resultados para «{q}»', { q }) : t('Esta categoría está vacía'), q ? t('Prueba con otro nombre o revisa la ortografía.') : ''));
      return;
    }
    const title = q ? t('Resultados ({n})', { n: state.filtered.length }) : groupLabel(state.group);
    body.appendChild(blockEl({ id: q ? 'results' : `g:${state.group}`, title, group: q ? null : state.group, items: state.filtered, layout: 'grid', editable: manual && !q }));
  } else {
    renderHome(body, manual);
  }
  if (scrolls) {
    for (const b of body.querySelectorAll('.block')) {
      const row = b.querySelector('.row');
      if (row && scrolls.get(b.dataset.block)) row.scrollLeft = scrolls.get(b.dataset.block);
    }
  }
  markPlaying();
}

function renderHome(body, manual) {
  const blocks = [];
  if (state.activeId !== FAV_ID && state.favorites.length) {
    blocks.push({ id: 'fav', title: t('Favoritos'), icon: 'i-star', items: state.favorites, layout: 'row', more: () => selectPlaylist(FAV_ID) });
  }
  if (state.recents.length) {
    blocks.push({ id: 'recents', title: t('Vistos recientemente'), icon: 'i-refresh', items: state.recents, layout: 'row', clear: true });
  }
  const groups = buckets();
  const single = groups.size <= 1;
  for (const [g, items] of groups) {
    if (!items.length && !manual) continue;
    blocks.push({ id: `g:${g}`, title: single && g === NO_GROUP ? t('Todos los canales') : groupLabel(g), group: g, items, layout: single ? 'grid' : 'row', editable: manual });
  }
  if (!state.channels.length && !(manual && groups.size)) {
    if (state.activeId === FAV_ID) {
      body.appendChild(emptyBlock(t('Aún no tienes favoritos'), t('Pulsa la estrella de cualquier canal para tenerlo siempre a mano aquí.')));
    } else if (manual) {
      const box = emptyBlock(t('Tu lista está vacía'), t('Empieza creando una categoría (Deportes, Noticias…) o añade directamente un canal.'));
      const actions = el('div', 'empty-actions');
      const add = el('button', 'btn primary');
      add.type = 'button';
      add.append(iconEl('i-plus'), document.createTextNode(t('Añadir canal')));
      add.addEventListener('click', () => openAddChannel({ listId: state.activeId }));
      const cat = el('button', 'btn');
      cat.type = 'button';
      cat.append(iconEl('i-folder-plus'), document.createTextNode(t('Nueva categoría')));
      cat.addEventListener('click', () => startNewCategoryChip());
      actions.append(add, cat);
      box.appendChild(actions);
      body.appendChild(box);
    } else {
      body.appendChild(emptyBlock(t('Esta lista no tiene canales'), t('Comprueba el enlace o actualízala desde «Gestionar listas».')));
    }
  }
  // Los bloques se pintan por tandas para listas con muchas categorías.
  let next = 0;
  const sentinel = el('div', 'sentinel');
  const more = () => {
    const end = Math.min(blocks.length, next + BLOCK_CHUNK);
    for (; next < end; next++) body.insertBefore(blockEl(blocks[next]), sentinel);
    if (next >= blocks.length) {
      sentinel.remove();
      gridObserver?.disconnect();
      if (manual && (state.channels.length || groups.size)) body.appendChild(newCategoryBlock());
    }
  };
  body.appendChild(sentinel);
  more();
  if (next < blocks.length) {
    gridObserver = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); }, { root: $('#main'), rootMargin: '900px 0px' });
    gridObserver.observe(sentinel);
  }
}

function emptyBlock(title, text) {
  const box = el('div', 'empty-block');
  box.appendChild(iconEl('i-tv'));
  box.appendChild(el('p', 'empty-title', title));
  if (text) box.appendChild(el('p', 'empty-text', text));
  return box;
}

function renderBrowseHead() {
  const pl = activeList();
  const fav = state.activeId === FAV_ID;
  const title = $('#browseTitle');
  title.value = fav ? t('Favoritos') : pl?.name || '';
  title.readOnly = pl?.source !== 'manual';
  title.tabIndex = title.readOnly ? -1 : 0;
  if (title.readOnly) delete title.dataset.tip;
  else title.dataset.tip = t('Haz clic para renombrar la lista');
  title.style.setProperty('--chars', String(Math.max(4, title.value.length + 1)));
  const n = state.channels.length;
  const groups = groupNames().filter((g) => g !== NO_GROUP).length;
  const parts = [n === 1 ? t('1 canal') : t('{n} canales', { n })];
  if (groups) parts.push(groups === 1 ? t('1 categoría') : t('{n} categorías', { n: groups }));
  if (pl?.source === 'manual') parts.push(t('lista propia'));
  else if (pl?.source === 'url') parts.push(pl.updatedAt ? t('actualizada {when}', { when: relTime(pl.updatedAt) }) : t('desde URL'));
  $('#browseSub').textContent = parts.join(' · ');

  const actions = $('#browseActions');
  actions.replaceChildren();
  if (pl?.source === 'manual') {
    const add = el('button', 'btn primary sm');
    add.type = 'button';
    add.append(iconEl('i-plus'), el('span', 'hide-sm', t('Añadir canal')));
    add.dataset.tip = t('Añadir un canal a esta lista');
    add.addEventListener('click', () => openAddChannel({ listId: pl.id, group: state.group && state.group !== NO_GROUP ? state.group : '' }));
    actions.appendChild(add);
  }
  if (pl?.source === 'url') {
    actions.appendChild(iconButton('i-refresh', t('Actualizar la lista desde su URL'), async () => {
      try { await selectPlaylist(pl.id, { refresh: true, keepGroup: true }); } catch (err) { toast(err.message); }
    }));
  }
  if (pl && pl.source !== 'manual') {
    actions.appendChild(iconButton('i-folder-plus', t('Crear una copia editable para organizarla a tu gusto'), async () => {
      try {
        const copy = await createManualList(`${pl.name} (copia)`, await listData(pl));
        await selectPlaylist(copy.id);
        toast(t('«{name}» creada: ya puedes editarla', { name: copy.name }));
      } catch (err) { toast(err.message); }
    }));
  }
  if (pl || (fav && state.favorites.length)) {
    const exp = iconButton('i-download', t('Descargar en M3U o JSON'), (e) => {
      if (pop?.anchor === exp) { closePop(); return; }
      const menu = $('#ctxMenu');
      menu.replaceChildren();
      const data = async () => (fav ? { name: t('Favoritos'), groups: [], channels: state.favorites } : listData(pl));
      for (const [fmt, label, sub] of [['m3u', 'M3U', t('Para Kodi, TiviMate, VLC…')], ['json', 'JSON', t('Para volver a importar en IP Player')]]) {
        menuItem(menu, { icon: 'i-download', label, sub, onClick: async () => {
          try { const d = await data(); exportList(d, fmt); toast(t('Descargando «{name}» en {fmt}', { name: d.name, fmt: label })); } catch (err) { toast(err.message); }
        } });
      }
      showPop(menu, exp, { align: 'end', focus: e.detail === 0 });
    });
    exp.setAttribute('aria-haspopup', 'menu');
    actions.appendChild(exp);
  }
}

function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (s < 60) return t('ahora');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function renderChips() {
  const box = $('#chips');
  const indicator = box.querySelector('.chip-indicator') || el('span', 'chip-indicator');
  box.replaceChildren(indicator);
  const groups = groupNames();
  const counts = buckets();
  const manual = isManualActive();
  const chip = (label, value, n) => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.group === value));
    b.dataset.group = value;
    b.appendChild(el('span', 'chip-label', label));
    if (n != null) b.appendChild(el('span', 'chip-count', String(n)));
    b.addEventListener('click', () => selectGroup(value));
    if (manual && value) bindDropTarget(b, { group: value });
    box.appendChild(b);
    return b;
  };
  chip(t('Todos'), '', state.channels.length);
  for (const g of groups) chip(groupLabel(g), g, counts.get(g)?.length || 0);
  if (manual) {
    const add = el('button', 'chip chip-add');
    add.type = 'button';
    add.id = 'chipNewCategory';
    add.append(iconEl('i-plus'), el('span', 'chip-label', t('Nueva categoría')));
    add.addEventListener('click', startNewCategoryChip);
    box.appendChild(add);
  }
  $('#chipsBar').hidden = !state.channels.length && !groups.length && !manual;
  requestAnimationFrame(moveChipIndicator);
}

function moveChipIndicator() {
  const box = $('#chips');
  const active = box.querySelector('.chip[aria-selected="true"]');
  const ind = box.querySelector('.chip-indicator');
  if (!active || !ind) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
  // Primera colocación sin animación; después se desliza entre chips.
  requestAnimationFrame(() => { ind.dataset.ready = '1'; });
  const left = active.offsetLeft - box.scrollLeft;
  if (left < 0 || left + active.offsetWidth > box.clientWidth) {
    box.scrollTo({ left: active.offsetLeft - 24, behavior: 'smooth' });
  }
}

function selectGroup(value) {
  if (state.group === value && !state.query) return;
  state.group = value;
  if (state.query) { state.query = ''; $('#search').value = ''; }
  renderBrowse({ animate: true });
  store.patchState({ group: value });
  const main = $('#main');
  const top = $('#browse').offsetTop - 8;
  if (main.scrollTop > top) main.scrollTo({ top, behavior: 'smooth' });
}

function startNewCategoryChip() {
  const pl = activeList();
  if (pl?.source !== 'manual') { openCategoryDialog(); return; }
  const btn = $('#chipNewCategory');
  if (!btn) return;
  const input = el('input', 'chip chip-input');
  input.placeholder = t('Nombre de la categoría');
  input.setAttribute('aria-label', t('Nombre de la nueva categoría'));
  btn.replaceWith(input);
  input.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name) {
      const ok = await addCategory(pl, name);
      if (ok) { selectGroup(name); toast(t('Categoría «{name}» creada. Añade canales o arrástralos aquí.', { name })); return; }
    }
    renderChips();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/** Bloque de canales: fila desplazable (portada) o cuadrícula (categoría / búsqueda). */
function blockEl({ id, title, icon, group = null, items, layout, editable = false, more = null, clear = false }) {
  const sec = el('section', `block block-${layout}`);
  sec.dataset.block = id;
  const head = el('header', 'block-head');
  const pl = activeList();
  const canRename = editable && group && group !== NO_GROUP;

  if (canRename) {
    const name = el('input', 'block-title block-title-input');
    name.value = title;
    name.setAttribute('aria-label', t('Nombre de la categoría'));
    name.dataset.tip = t('Haz clic para renombrar la categoría');
    name.style.setProperty('--chars', String(Math.max(4, title.length + 1)));
    name.addEventListener('input', () => name.style.setProperty('--chars', String(Math.max(4, name.value.length + 1))));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.value = title; name.blur(); }
    });
    name.addEventListener('change', () => renameCategory(pl, group, name.value.trim()));
    head.appendChild(name);
  } else {
    const h = el('h3', 'block-title');
    if (icon) h.appendChild(iconEl(icon));
    h.appendChild(document.createTextNode(title));
    head.appendChild(h);
  }
  head.appendChild(el('span', 'block-count', String(items.length)));
  head.appendChild(el('span', 'spacer'));

  const tools = el('div', 'block-tools');
  if (editable && group != null) {
    tools.appendChild(iconButton('i-plus', t('Añadir un canal en «{name}»', { name: groupLabel(group) }), () => openAddChannel({ listId: pl.id, group: group === NO_GROUP ? '' : group })));
    if (canRename) {
      const gs = groupsOf(pl);
      const i = gs.indexOf(group);
      if (layout === 'row') {
        const up = iconButton('i-up', t('Subir la categoría'), () => moveCategory(pl, group, -1));
        up.disabled = i <= 0;
        const down = iconButton('i-down', t('Bajar la categoría'), () => moveCategory(pl, group, 1));
        down.disabled = i < 0 || i >= gs.length - 1;
        tools.append(up, down);
      }
      tools.appendChild(iconButton('i-trash', t('Eliminar la categoría (sus canales pasan a «Sin categoría»)'), () => deleteCategory(pl, group)));
    }
  }
  if (clear) {
    tools.appendChild(iconButton('i-trash', t('Borrar el historial de vistos'), async () => {
      state.recents = [];
      await store.set('recents', []);
      renderBrowse({ preserve: true });
    }));
  }
  head.appendChild(tools);
  if (layout === 'row' && (group != null || more)) {
    const all = el('button', 'see-all');
    all.type = 'button';
    all.append(document.createTextNode(t('Ver todo')), iconEl('i-next'));
    all.addEventListener('click', () => (more ? more() : selectGroup(group)));
    head.appendChild(all);
  }
  sec.appendChild(head);

  const ctx = { editable, group };
  if (layout === 'row') {
    const wrap = el('div', 'row-wrap');
    const row = el('div', 'row');
    items.slice(0, ROW_LIMIT).forEach((c, i) => row.appendChild(cardEl(c, ctx, i)));
    if (items.length > ROW_LIMIT) {
      const tile = el('button', 'card card-more-tile');
      tile.type = 'button';
      tile.append(el('span', 'more-n', `+${items.length - ROW_LIMIT}`), el('span', 'more-t', t('Ver todos')));
      tile.addEventListener('click', () => (more ? more() : selectGroup(group)));
      row.appendChild(tile);
    }
    if (editable && group != null) row.appendChild(ghostCard(group));
    const prev = iconButton('i-prev', t('Anteriores'), () => row.scrollBy({ left: -row.clientWidth * 0.85, behavior: 'smooth' }), 'row-nav prev');
    const next = iconButton('i-next', t('Siguientes'), () => row.scrollBy({ left: row.clientWidth * 0.85, behavior: 'smooth' }), 'row-nav next');
    prev.tabIndex = -1;
    next.tabIndex = -1;
    const sync = () => {
      wrap.dataset.start = row.scrollLeft <= 4 ? '1' : '';
      wrap.dataset.end = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4 ? '1' : '';
    };
    row.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(sync);
    wrap.append(row, prev, next);
    sec.appendChild(wrap);
  } else {
    const grid = el('div', 'grid');
    sec.appendChild(grid);
    let next = 0;
    const sentinel = el('div', 'sentinel');
    grid.appendChild(sentinel);
    const add = () => {
      const end = Math.min(items.length, next + GRID_CHUNK);
      const frag = document.createDocumentFragment();
      for (; next < end; next++) frag.appendChild(cardEl(items[next], ctx, next % GRID_CHUNK));
      grid.insertBefore(frag, sentinel);
      if (next >= items.length) {
        sentinel.remove();
        if (editable && group != null) grid.appendChild(ghostCard(group));
      }
    };
    add();
    if (next < items.length) {
      const io = new IntersectionObserver((e) => {
        if (e.some((x) => x.isIntersecting)) add();
        if (next >= items.length) io.disconnect();
      }, { root: $('#main'), rootMargin: '900px 0px' });
      io.observe(sentinel);
    }
  }
  if (editable && group != null) bindDropTarget(sec, { group });
  return sec;
}

function newCategoryBlock() {
  const b = el('button', 'block-new');
  b.type = 'button';
  b.append(iconEl('i-folder-plus'), el('span', '', t('Nueva categoría')));
  b.addEventListener('click', () => {
    $('#main').scrollTo({ top: $('#browse').offsetTop - 8, behavior: 'smooth' });
    startNewCategoryChip();
  });
  return b;
}

function ghostCard(group) {
  const b = el('button', 'card card-ghost');
  b.type = 'button';
  b.dataset.tip = t('Añadir un canal en «{name}»', { name: groupLabel(group) });
  b.append(iconEl('i-plus'), el('span', '', t('Añadir canal')));
  b.addEventListener('click', () => openAddChannel({ listId: state.activeId, group: group === NO_GROUP ? '' : group }));
  return b;
}

function cardEl(channel, ctx, i) {
  const card = el('div', 'card');
  card.style.setProperty('--i', String(Math.min(i, 16)));
  card.style.setProperty('--h', String(hueOf(channel.name)));
  card.dataset.key = favKey(channel);

  const hit = el('button', 'card-hit');
  hit.type = 'button';
  hit.setAttribute('aria-label', t('Reproducir {name}', { name: channel.name }));
  hit.addEventListener('click', () => play(channel));

  const art = el('span', 'card-art');
  art.appendChild(logoEl('card-logo', channel));
  const live = el('span', 'card-live');
  live.append(el('i'), el('i'), el('i'));
  art.appendChild(live);

  const body = el('span', 'card-body');
  body.appendChild(el('span', 'card-name', channel.name));
  if (hasEpg()) {
    const liveInfo = getNowAndNext(channel);
    if (liveInfo?.now?.title) {
      const epgEl = el('span', 'card-epg', liveInfo.now.title);
      epgEl.title = `${liveInfo.now.title} (${formatTime(new Date(liveInfo.now.start))} - ${formatTime(new Date(liveInfo.now.stop))})`;
      body.appendChild(epgEl);
    }
  }
  const type = detectType(channel.url, channel.type);
  const meta = [type !== 'auto' ? typeLabel(type) : '', drmLabel(channel.drm)].filter(Boolean).join(' · ');
  body.appendChild(el('span', 'card-meta', meta || (ctx.group == null && channel.group ? channel.group : t('Stream'))));
  hit.append(art, body);

  const fav = iconButton('i-star', t(isFav(channel) ? 'Quitar de favoritos' : 'Añadir a favoritos'), (e) => { e.stopPropagation(); toggleFavorite(channel); }, 'card-fav' + (isFav(channel) ? ' on' : ''));
  fav.tabIndex = -1;
  const more = iconButton('i-more', t('Más opciones'), (e) => {
    e.stopPropagation();
    if (pop?.anchor === more) { closePop(); return; }
    openCardMenu(channel, { anchor: more, focus: e.detail === 0 });
  }, 'card-more');
  more.tabIndex = -1;
  more.setAttribute('aria-haspopup', 'menu');
  card.append(hit, fav, more);
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardMenu(channel, { point: { x: e.clientX, y: e.clientY } }); });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openCardMenu(channel, { anchor: more, focus: true }); }
  });

  if (ctx.editable && channel.index != null) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      drag = { index: channel.index };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', channel.url);
      card.classList.add('dragging');
      document.body.dataset.dragging = '1';
    });
    card.addEventListener('dragend', endDrag);
    bindDropTarget(card, { group: groupKey(channel), target: channel.index });
  }
  return card;
}

function openCardMenu(channel, { anchor = null, point = null, focus = false } = {}) {
  const menu = $('#ctxMenu');
  menu.replaceChildren();
  const pl = channel.listId ? state.playlists.find((p) => p.id === channel.listId) : null;
  const own = pl?.source === 'manual' && channel.index != null;
  menuItem(menu, { icon: 'i-play', label: t('Reproducir'), onClick: () => play(channel) });
  menuItem(menu, { icon: 'i-star', label: t(isFav(channel) ? 'Quitar de favoritos' : 'Añadir a favoritos'), onClick: () => toggleFavorite(channel) });
  if (own) {
    menuItem(menu, { icon: 'i-edit', label: t('Editar canal'), sub: t('URL, DRM, cabeceras'), onClick: () => openStreamDialog({ ...channel }, { mode: 'edit', listId: pl.id, index: channel.index }) });
    const groups = groupsOf(pl);
    if (groups.length) {
      menuLabel(menu, 'Mover a');
      for (const g of [...groups, '']) {
        const cur = (channel.group || '') === g;
        menuItem(menu, { label: g || t('Sin categoría'), checked: cur, disabled: cur, onClick: () => moveChannel(pl, channel.index, { group: g || NO_GROUP }) });
      }
      menuSep(menu);
    }
  } else {
    menuItem(menu, { icon: 'i-folder-plus', label: t('Guardar en mis listas'), sub: t('Elige lista y categoría'), onClick: () => openSaveDialog(channel) });
  }
  menuItem(menu, { icon: 'i-copy', label: t('Copiar URL'), onClick: async () => { await navigator.clipboard.writeText(channel.url); toast(t('URL copiada')); } });
  if (own) {
    menuItem(menu, { icon: 'i-trash', label: t('Eliminar de la lista'), danger: true, onClick: () => removeChannel(pl, channel.index) });
  }
  showPop(menu, anchor, { point, align: anchor ? 'end' : 'start', focus });
}

// ---------- Arrastrar canales (listas propias) ----------

let drag = null;
let dropNode = null; // destino resaltado ahora mismo (dragover se dispara muchas veces por segundo)

function clearDropNode() {
  dropNode?.classList.remove('drop-before', 'drop-after', 'drop-into');
  dropNode = null;
}

function endDrag() {
  drag = null;
  delete document.body.dataset.dragging;
  clearDropNode();
  document.querySelector('.card.dragging')?.classList.remove('dragging');
}

function bindDropTarget(node, { group, target = null }) {
  node.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropNode !== node) { clearDropNode(); dropNode = node; }
    if (target != null) {
      const r = node.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      node.classList.toggle('drop-after', after);
      node.classList.toggle('drop-before', !after);
    } else {
      node.classList.add('drop-into');
    }
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget) && dropNode === node) clearDropNode();
  });
  node.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const after = node.classList.contains('drop-after');
    const from = drag.index;
    endDrag();
    const pl = activeList();
    if (pl?.source === 'manual') moveChannel(pl, from, { group, target, after });
  });
}

/** Mueve un canal a otra categoría y, si se indica, junto a otro canal. */
async function moveChannel(pl, from, { group, target = null, after = false }) {
  const ch = pl.channels[from];
  if (!ch) return;
  const before = ch.group || '';
  ch.group = group === NO_GROUP ? '' : group;
  if (target != null && target !== from) {
    pl.channels.splice(from, 1);
    let t = target - (from < target ? 1 : 0);
    if (after) t++;
    pl.channels.splice(t, 0, ch);
  } else if (target == null && before !== ch.group) {
    pl.channels.splice(from, 1);
    pl.channels.push(ch);
  }
  await saveManual(pl);
  if (before !== ch.group) toast(t('«{name}» movido a {group}', { name: ch.name, group: groupLabel(group) }));
}

async function removeChannel(pl, index) {
  const [removed] = pl.channels.splice(index, 1);
  if (!removed) return;
  await saveManual(pl);
  toast(t('«{name}» eliminado', { name: removed.name }), {
    label: t('Deshacer'),
    fn: async () => { pl.channels.splice(index, 0, removed); await saveManual(pl); }
  });
}

// ---------- Categorías (listas propias) ----------

async function addCategory(pl, name) {
  if (!name) return false;
  if (groupsOf(pl).some((g) => g.toLowerCase() === name.toLowerCase())) { toast(t('Esa categoría ya existe')); return false; }
  pl.groups = [...groupsOf(pl), name];
  await saveManual(pl);
  return true;
}

async function renameCategory(pl, old, nv) {
  if (!nv || nv === old) { renderBrowse({ preserve: true }); return; }
  if (groupsOf(pl).includes(nv)) { toast(t('Ya existe una categoría con ese nombre')); renderBrowse({ preserve: true }); return; }
  pl.groups = groupsOf(pl).map((x) => (x === old ? nv : x));
  pl.channels.forEach((c) => { if (c.group === old) c.group = nv; });
  if (state.group === old) state.group = nv;
  await saveManual(pl);
  toast(t('Categoría renombrada a «{name}»', { name: nv }));
}

async function moveCategory(pl, g, dir) {
  const gs = groupsOf(pl);
  const i = gs.indexOf(g);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= gs.length) return;
  [gs[i], gs[j]] = [gs[j], gs[i]];
  pl.groups = gs;
  await saveManual(pl);
}

async function deleteCategory(pl, g) {
  const n = pl.channels.filter((c) => c.group === g).length;
  if (n && !confirm(t('¿Eliminar la categoría «{name}»? Sus {n} canales pasarán a «Sin categoría».', { name: g, n }))) return;
  const prevGroups = groupsOf(pl);
  const moved = pl.channels.filter((c) => c.group === g);
  pl.groups = prevGroups.filter((x) => x !== g);
  moved.forEach((c) => { c.group = ''; });
  if (state.group === g) state.group = '';
  await saveManual(pl);
  toast(t('Categoría «{name}» eliminada', { name: g }), {
    label: t('Deshacer'),
    fn: async () => { pl.groups = prevGroups; moved.forEach((c) => { c.group = g; }); await saveManual(pl); }
  });
}

// ---------- Teclado en las tarjetas ----------

const FOCUSABLE_CARD = '.card-hit, .card-ghost, .card-more-tile';

function onCardsKey(e) {
  const hit = e.target.closest(FOCUSABLE_CARD);
  if (!hit || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const container = hit.closest('.row, .grid');
  const items = [...container.querySelectorAll(FOCUSABLE_CARD)];
  const i = items.indexOf(hit);
  let target = null;
  if (e.key === 'ArrowRight') target = items[i + 1];
  else if (e.key === 'ArrowLeft') target = items[i - 1];
  else if (e.key === 'Home') target = items[0];
  else if (e.key === 'End') target = items[items.length - 1];
  else if (container.classList.contains('grid')) {
    const top = items[0].getBoundingClientRect().top;
    const cols = Math.max(1, items.filter((x) => Math.abs(x.getBoundingClientRect().top - top) < 4).length);
    target = items[i + (e.key === 'ArrowDown' ? cols : -cols)];
  }
  if (!target && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    // Salta al bloque siguiente / anterior manteniendo la posición.
    const blocks = [...$('#browseBody').querySelectorAll('.block')];
    const b = blocks[blocks.indexOf(hit.closest('.block')) + (e.key === 'ArrowDown' ? 1 : -1)];
    const list = b ? [...b.querySelectorAll(FOCUSABLE_CARD)] : [];
    target = list[Math.min(i, list.length - 1)] || null;
    if (!target && e.key === 'ArrowUp') { $('#search').focus(); return; }
  }
  if (target) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

// ======================================================================
// Selector de categoría (chips) para los diálogos
// ======================================================================

/** Pinta chips de categoría con opción «Nueva». El valor se lee con box.value(). */
function categoryPicker(box, groups, initial = '') {
  box.replaceChildren();
  let value = initial || '';
  const opts = [];
  const input = el('input', 'cat-new-input');
  input.placeholder = t('Nombre de la nueva categoría');
  input.setAttribute('aria-label', t('Nombre de la nueva categoría'));
  input.hidden = true;
  let newBtn = null;
  const select = (v, btn) => {
    value = v;
    for (const o of opts) o.setAttribute('aria-checked', String(o === btn));
    if (btn !== newBtn) { input.hidden = true; input.value = ''; }
  };
  const opt = (label, v) => {
    const b = el('button', 'cat-opt');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = label;
    b.addEventListener('click', () => select(v, b));
    opts.push(b);
    box.appendChild(b);
    return b;
  };
  opt(t('Sin categoría'), '');
  for (const g of groups) opt(g, g);
  newBtn = el('button', 'cat-opt cat-opt-new');
  newBtn.type = 'button';
  newBtn.setAttribute('role', 'radio');
  newBtn.append(iconEl('i-plus'), document.createTextNode(t('Nueva')));
  newBtn.addEventListener('click', () => { select('', newBtn); input.hidden = false; input.focus(); });
  opts.push(newBtn);
  box.append(newBtn, input);
  input.addEventListener('input', () => { value = input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  if (!initial) select('', opts[0]);
  else if (groups.includes(initial)) select(initial, opts[groups.indexOf(initial) + 1]);
  else { select(initial, newBtn); input.hidden = false; input.value = initial; value = initial; }
  box.value = () => value;
  return box;
}

/** Rellena un <select> con las listas propias y la opción de crear una nueva. */
function fillListSelect(sel, preferred) {
  sel.replaceChildren();
  for (const pl of manualLists()) sel.add(new Option(pl.name, pl.id));
  sel.add(new Option(t('＋ Nueva lista…'), '__new__'));
  const has = (id) => id && manualLists().some((p) => p.id === id);
  sel.value = has(preferred) ? preferred : has(state.activeId) ? state.activeId : manualLists()[0]?.id || '__new__';
}

// ======================================================================
// Diálogo: abrir / añadir / editar canal
// ======================================================================

// ---------- Vistas dentro de un diálogo ----------

const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

/**
 * Muestra la vista `name` de un diálogo ([data-view]) y los elementos de esa vista
 * ([data-for-view]). Si el diálogo está abierto, anima el cambio de altura y desliza
 * el contenido: hacia la izquierda al avanzar y hacia la derecha al volver.
 */
function setDialogView(dialog, name, { back = false } = {}) {
  const views = [...dialog.querySelectorAll('[data-view]')];
  const target = views.find((v) => v.dataset.view === name);
  if (!target) return;
  const animate = dialog.open && dialog.dataset.view && dialog.dataset.view !== name
    && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h0 = animate ? dialog.getBoundingClientRect().height : 0;
  for (const v of views) v.hidden = v !== target;
  for (const n of dialog.querySelectorAll('[data-for-view]')) n.hidden = !n.dataset.forView.split(' ').includes(name);
  dialog.dataset.view = name;
  target.scrollTop = 0;
  if (!animate) return;
  const h1 = dialog.getBoundingClientRect().height;
  dialog.getAnimations().forEach((a) => a.cancel());
  if (Math.abs(h1 - h0) > 1) {
    dialog.style.overflow = 'hidden';
    const anim = dialog.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 240, easing: EASE });
    anim.onfinish = anim.oncancel = () => { dialog.style.overflow = ''; };
  }
  target.animate(
    [{ opacity: 0, transform: `translateX(${back ? -16 : 16}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: EASE }
  );
}

/** Resumen de las opciones avanzadas del canal (para la fila «Opciones avanzadas»). */
function advancedSummary() {
  const parts = [];
  if ($('#fType').value) parts.push(typeLabel($('#fType').value));
  if ($('#fEngine').value) parts.push($('#fEngine').selectedOptions[0].textContent.split(' (')[0]);
  const sys = $('#fDrm').value;
  if (sys !== 'none') parts.push($('#fDrm').selectedOptions[0].textContent.split(' (')[0]);
  const headers = Object.keys(parseLineHeaders($('#fHeaders').value)).length;
  if (headers) parts.push(headers === 1 ? t('1 cabecera') : t('{n} cabeceras', { n: headers }));
  const pm = $('#fProxyMode').value;
  if (pm === 'custom') parts.push(t('Proxy propio'));
  else if (pm === 'none') parts.push(t('Sin proxy'));
  const el = $('#advSummary');
  el.textContent = parts.length ? parts.join(' · ') : t('formato, DRM y cabeceras');
  $('#btnAdvanced').classList.toggle('configured', parts.length > 0);
}

/**
 * @param {object|null} channel
 * @param {{mode?:'open'|'add'|'edit', title?:string, listId?:string, index?:number, group?:string}} [opts]
 */
function openStreamDialog(channel, { mode = 'open', title, listId, index, group } = {}) {
  closePop();
  state.editing = channel || null;
  state.streamMode = { kind: mode, listId, index };
  const titles = { open: t(channel ? 'Revisar stream' : 'Abrir stream'), add: t('Añadir canal'), edit: t('Editar canal') };
  $('#streamDialogTitle').textContent = title || titles[mode];
  fillStreamForm(channel || { name: '', url: '', type: '', headers: {}, drm: emptyDrm() });
  $('#streamError').hidden = true;
  $('#fImport').value = '';
  const dialog = $('#streamDialog');
  delete dialog.dataset.view;
  setDialogView(dialog, 'main');
  advancedSummary();

  $('#fSaveTo').hidden = mode !== 'add';
  if (mode === 'add') {
    fillListSelect($('#fList'), listId);
    syncStreamTarget(group || '');
  }
  $('#btnStreamPlay').textContent = t(mode === 'add' ? 'Solo reproducir' : 'Reproducir');
  $('#btnStreamPlay').classList.toggle('primary', mode === 'open');
  $('#btnStreamSave').hidden = mode === 'open';
  $('#btnStreamSave').textContent = t(mode === 'edit' ? 'Guardar cambios' : 'Guardar');
  $('#btnStreamSaveTo').hidden = mode !== 'open';
  $('#streamDialog').showModal();
  channelTodo();
  (channel?.url ? $('#fName') : $('#fUrl')).focus();
}

function syncStreamTarget(group) {
  const id = $('#fList').value;
  const pl = manualLists().find((p) => p.id === id);
  $('#fNewListWrap').hidden = id !== '__new__';
  categoryPicker($('#fCats'), pl ? groupsOf(pl) : [], group);
}

function openAddChannel({ listId, group = '' } = {}) {
  openStreamDialog(null, { mode: 'add', listId: listId || (isManualActive() ? state.activeId : undefined), group });
}

function fillStreamForm(c) {
  const d = c.drm || emptyDrm();
  $('#fUrl').value = c.url || '';
  $('#fName').value = c.name && c.name !== c.url ? c.name : '';
  $('#fType').value = c.type || '';
  $('#fEngine').value = c.engine || '';
  $('#fDrm').value = d.system || 'none';
  $('#fKeys').value = keysToLines(d.keys);
  $('#fLicense').value = d.licenseUrl || '';
  $('#fLicenseHeaders').value = headersToLines(d.licenseHeaders);
  $('#fBody').value = d.bodyTemplate || '';
  $('#fResp').value = d.responseTemplate || '';
  $('#fHeaders').value = headersToLines(c.headers);
  $('#fProxyMode').value = c.proxy?.mode || 'global';
  $('#fProxy').value = c.proxy?.url || '';
  syncProxyFields();
  syncDrmFields();
}

function syncDrmFields() {
  const sys = $('#fDrm').value;
  document.querySelectorAll('#streamForm [data-drm]').forEach((node) => {
    node.hidden = !node.dataset.drm.split(' ').includes(sys);
  });
}

function readStreamForm() {
  const url = $('#fUrl').value.trim();
  if (!url) throw new Error(t('Indica la URL del stream.'));
  const system = $('#fDrm').value;
  const drm = emptyDrm();
  drm.system = system;
  if (system !== 'none') {
    drm.licenseUrl = $('#fLicense').value.trim();
    drm.licenseHeaders = parseLineHeaders($('#fLicenseHeaders').value);
    drm.bodyTemplate = $('#fBody').value.trim();
    drm.responseTemplate = $('#fResp').value.trim();
  }
  if (system === 'clearkey') {
    drm.keys = parseClearKeys($('#fKeys').value);
    if (!Object.keys(drm.keys).length && !drm.licenseUrl) {
      throw new Error(t('ClearKey necesita claves KID:KEY o un servidor de licencias.'));
    }
  }
  if ((system === 'widevine' || system === 'playready') && !drm.licenseUrl) {
    throw new Error(t('Indica el servidor de licencias.'));
  }
  const base = state.editing || {};
  return {
    ...base,
    id: base.id || 'manual',
    name: $('#fName').value.trim() || base.name || nameFromUrl(url) || url,
    url,
    type: $('#fType').value,
    engine: $('#fEngine').value,
    headers: parseLineHeaders($('#fHeaders').value),
    drm,
    proxy: readProxyField(),
    errors: []
  };
}

// ---------- Proxy ----------

let uiProxy = { enabled: false, url: '' };

/** Proxy general (Ayuda → Opciones), o null si está desactivado o no es válido. */
function generalProxy() {
  if (!uiProxy.enabled || !uiProxy.url) return null;
  try { return parseProxy(uiProxy.url); } catch (_) { return null; }
}

/** Proxy que usa un canal: el suyo, ninguno o el general. */
function channelProxy(channel) {
  const mode = channel.proxy?.mode || 'global';
  if (mode === 'none') return null;
  if (mode === 'custom') return parseProxy(channel.proxy.url);
  return generalProxy();
}

/** Activa (o quita) el proxy para el canal que va a sonar. Lanza un error legible si no se puede. */
async function applyChannelProxy(channel) {
  let proxy;
  try { proxy = channelProxy(channel); } catch (_) { throw new Error(t('El proxy del canal no es válido. Revísalo en «Opciones avanzadas».')); }
  if (proxy) {
    if (!isProxyAvailable()) throw new Error(t('Esta versión del navegador no permite usar un proxy desde la extensión.'));
    const control = await proxyControl();
    if (control === 'not_controllable' || control === 'controlled_by_other_extensions') {
      throw new Error(t('Otra extensión o una política del navegador controla el proxy.'));
    }
  }
  await setProxy(proxy, [channel.url, channel.drm?.licenseUrl].filter(Boolean));
  return proxy;
}

/** Explica un texto de proxy (o el error) bajo el campo. */
function proxyHint(text, hint) {
  const v = text.trim();
  if (!v) { hint.textContent = t('Formato: socks5://host:1080 · http://usuario:contraseña@host:8080'); hint.dataset.kind = ''; return null; }
  try {
    const p = parseProxy(v);
    hint.textContent = p.user && p.scheme.startsWith('socks')
      ? t('{proxy} · Chrome no admite usuario y contraseña en SOCKS', { proxy: describeProxy(p) })
      : describeProxy(p);
    hint.dataset.kind = p.user && p.scheme.startsWith('socks') ? 'warn' : 'ok';
    return p;
  } catch (_) {
    hint.textContent = t('No es un proxy válido. Usa http://, https://, socks4:// o socks5://');
    hint.dataset.kind = 'warn';
    return null;
  }
}

function syncProxyFields() {
  const custom = $('#fProxyMode').value === 'custom';
  $('#fProxyWrap').hidden = !custom;
  if (custom) proxyHint($('#fProxy').value, $('#fProxyHint'));
}

function readProxyField() {
  const mode = $('#fProxyMode').value;
  if (mode !== 'custom') return { mode, url: '' };
  const url = $('#fProxy').value.trim();
  try { parseProxy(url); } catch (_) { throw new Error(t('El proxy del canal no es válido. Revísalo en «Opciones avanzadas».')); }
  return { mode, url };
}

/** Prueba el proxy general: pide una página mínima a través de él. */
async function testGeneralProxy() {
  const hint = $('#gProxyHint');
  const p = proxyHint($('#gProxy').value, hint);
  if (!p) return;
  const probe = 'https://www.gstatic.com/generate_204';
  hint.textContent = t('Probando…');
  hint.dataset.kind = '';
  const t0 = performance.now();
  try {
    if (!isProxyAvailable()) throw new Error(t('Esta versión del navegador no permite usar un proxy desde la extensión.'));
    await setProxy(p, [probe]);
    const res = await fetch(probe, { cache: 'no-store' });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    hint.textContent = t('Conexión correcta a través del proxy ({ms} ms)', { ms: Math.round(performance.now() - t0) });
    hint.dataset.kind = 'ok';
  } catch (err) {
    hint.textContent = t('El proxy no responde: {msg}', { msg: err.message });
    hint.dataset.kind = 'warn';
  } finally {
    // Vuelve a dejar el proxy como estaba (el del canal en reproducción o ninguno).
    if (state.current) applyChannelProxy(state.current).catch(() => {});
    else clearProxy().catch(() => {});
  }
}

function importIntoForm() {
  let text = $('#fImport').value.trim();
  if (!text) return;
  if (!/^\s*#EXTM3U/.test(text)) text = '#EXTM3U\n' + text;
  if (!/\n\s*[^#\s][^\n]*\s*$/.test(text)) text += '\n' + ($('#fUrl').value.trim() || 'about:blank');
  const { channels } = parseM3U(text);
  if (!channels.length) {
    showFormError('streamError', t('No se encontró ninguna entrada válida.'));
    return;
  }
  const c = channels[0];
  if (c.url === 'about:blank') c.url = '';
  fillStreamForm(c);
  showFormError('streamError', c.errors.length ? c.errors.join('\n') : '');
}

function showFormError(id, msg) {
  const node = $('#' + id);
  node.textContent = msg;
  node.hidden = !msg;
}

async function onStreamSave() {
  const mode = state.streamMode;
  try {
    const ch = readStreamForm();
    if (mode.kind === 'edit') {
      const pl = manualLists().find((p) => p.id === mode.listId);
      if (!pl) throw new Error(t('La lista ya no existe.'));
      const old = pl.channels[mode.index];
      pl.channels[mode.index] = cleanChannel({ ...ch, group: old?.group || '' });
      await saveManual(pl);
      toast(t('Canal actualizado'));
    } else if (mode.kind === 'add') {
      let pl = manualLists().find((p) => p.id === $('#fList').value);
      if (!pl) pl = await createManualList($('#fNewList').value.trim());
      const group = $('#fCats').value();
      if (group && !groupsOf(pl).includes(group)) pl.groups = [...groupsOf(pl), group];
      const saved = cleanChannel({ ...ch, group });
      pl.channels.push(saved);
      await saveManual(pl);
      if (state.activeId !== pl.id) await selectPlaylist(pl.id);
      const index = pl.channels.length - 1;
      toast(t('«{name}» guardado en «{list}»', { name: saved.name, list: pl.name }) + (group ? ' · ' + group : ''), {
        label: t('Reproducir'),
        fn: () => play({ ...saved, id: `m${index}`, index, listId: pl.id, errors: [] })
      });
    }
    $('#streamDialog').close();
  } catch (err) {
    showFormError('streamError', err.message);
  }
}

// ======================================================================
// Diálogos: listas, guardar en lista y categoría
// ======================================================================

function openManager() {
  closePop();
  renderPlaylistManager();
  showFormError('managerError', '');
  const dialog = $('#manageDialog');
  delete dialog.dataset.view;
  setDialogView(dialog, 'lists');
  if (!dialog.open) dialog.showModal();
}

function renderPlaylistManager() {
  const ul = $('#plList');
  ul.replaceChildren();
  if (!state.playlists.length) {
    ul.appendChild(el('li', 'empty-li', t('Todavía no hay listas. Añade una M3U o crea tu propia lista.')));
    return;
  }
  for (const pl of state.playlists) {
    const li = document.createElement('li');
    const manual = pl.source === 'manual';
    const ico = el('span', 'pl-ico');
    ico.appendChild(iconEl(manual ? 'i-edit' : pl.source === 'url' ? 'i-link' : 'i-list'));
    const info = el('div', 'pl-info');
    info.appendChild(el('div', 'pl-name', pl.name));
    let count = countOf(pl);
    if (count == null && pl.text) {
      count = parseM3U(pl.text).channels.length;
      countCache.set(`${pl.id}|${pl.updatedAt}`, count);
    }
    const date = pl.updatedAt ? relTime(pl.updatedAt) : '';
    const origin = manual ? `${t('lista propia')} · ${t('{n} categorías', { n: groupsOf(pl).length })}` : pl.source === 'url' ? pl.url : t('importada');
    const sub = el('div', 'pl-sub', `${t('{n} canales', { n: count ?? 0 })} · ${origin}${date ? ' · ' + date : ''}`);
    sub.title = sub.textContent;
    info.appendChild(sub);
    li.append(ico, info);

    li.appendChild(iconButton('i-play', t('Abrir esta lista'), async () => { $('#manageDialog').close(); await selectPlaylist(pl.id); }));
    if (pl.source === 'url') {
      li.appendChild(iconButton('i-refresh', t('Actualizar desde la URL'), async () => {
        try {
          await fetchPlaylist(pl);
          renderPlaylistManager();
          if (state.activeId === pl.id) await selectPlaylist(pl.id, { keepGroup: true });
        } catch (err) { showFormError('managerError', t('Error al actualizar: {msg}', { msg: err.message })); }
      }));
    }
    if (!manual) {
      li.appendChild(iconButton('i-folder-plus', t('Copiar como lista propia editable'), async () => {
        try {
          const copy = await createManualList(`${pl.name} (copia)`, await listData(pl));
          renderPlaylistManager();
          toast(t('«{name}» creada: ya puedes editarla', { name: copy.name }));
        } catch (err) { showFormError('managerError', err.message); }
      }));
    }
    li.appendChild(exportButton(pl));
    li.appendChild(iconButton('i-trash', t('Eliminar lista'), async () => {
      if (!confirm(t('¿Eliminar la lista «{name}»?', { name: pl.name }))) return;
      state.playlists = state.playlists.filter((p) => p.id !== pl.id);
      await store.savePlaylists(state.playlists);
      renderPlaylistManager();
      if (state.activeId === pl.id) await selectPlaylist(state.playlists[0]?.id || FAV_ID);
      else { renderListPicker(); renderBrowse({ preserve: true }); }
    }));
    ul.appendChild(li);
  }
}

/** Botón de descarga con elección de formato (M3U / JSON). */
function exportButton(pl) {
  const btn = iconButton('i-download', t('Descargar en M3U o JSON'), (e) => {
    if (pop?.anchor === btn) { closePop(); return; }
    const menu = $('#ctxMenu');
    menu.replaceChildren();
    for (const [fmt, label, sub] of [['m3u', 'M3U', t('Para Kodi, TiviMate, VLC…')], ['json', 'JSON', t('Para volver a importar en IP Player')]]) {
      menuItem(menu, { icon: 'i-download', label, sub, onClick: async () => {
        try { exportList(await listData(pl), fmt); toast(t('Descargando «{name}» en {fmt}', { name: pl.name, fmt: label })); } catch (err) { showFormError('managerError', err.message); }
      } });
    }
    showPop(menu, btn, { align: 'end', focus: e.detail === 0 });
  });
  btn.setAttribute('aria-haspopup', 'menu');
  return btn;
}

/** Canales de cualquier lista en formato de lista propia. */
async function listData(pl) {
  if (pl.source === 'manual') return pl;
  if (!pl.text) await fetchPlaylist(pl);
  const channels = parseM3U(pl.text, pl.url).channels.map(cleanChannel);
  return { name: pl.name, groups: groupsOf({ channels }), channels };
}

async function createManualList(name, { groups = [], channels = [] } = {}) {
  let finalName = name || t('Mi lista {n}', { n: manualLists().length + 1 });
  const taken = new Set(state.playlists.map((x) => x.name));
  for (let n = 2; taken.has(finalName); n++) finalName = `${name || t('Mi lista')} (${n})`;
  const pl = {
    id: store.newId(),
    name: finalName,
    source: 'manual',
    groups: [...groups],
    channels: channels.map(cleanChannel),
    updatedAt: new Date().toISOString()
  };
  state.playlists.push(pl);
  await store.savePlaylists(state.playlists);
  renderListPicker();
  return pl;
}

/** Crea una lista propia vacía y la abre para escribir su nombre. */
async function createListFlow(name = '') {
  const pl = await createManualList(name);
  if ($('#manageDialog').open) $('#manageDialog').close();
  await selectPlaylist(pl.id);
  $('#main').scrollTo({ top: $('#browse').offsetTop - 8, behavior: 'smooth' });
  if (!name) {
    const title = $('#browseTitle');
    title.focus({ preventScroll: true });
    title.select();
    toast(t('Lista creada: escribe su nombre y añade categorías o canales'));
  } else {
    toast(t('«{name}» creada: añade categorías o canales', { name: pl.name }));
  }
}

async function saveManual(pl) {
  pl.updatedAt = new Date().toISOString();
  pl.groups = groupsOf(pl);
  await store.savePlaylists(state.playlists);
  renderListPicker();
  if (state.activeId === pl.id) {
    state.channels = channelsOf(pl);
    if (state.group && !groupNames().includes(state.group)) state.group = '';
    renderBrowse({ preserve: true });
  }
}

// ---------- Guardar en lista ----------

let saveChannel = null;

function openSaveDialog(channel, { listId } = {}) {
  closePop();
  saveChannel = channel;
  fillListSelect($('#sList'), listId);
  $('#sName').value = channel.name && channel.name !== channel.url ? channel.name : nameFromUrl(channel.url) || channel.url;
  $('#sNewName').value = '';
  showFormError('saveError', '');
  syncSaveDialog(channel.group || '');
  $('#saveDialog').showModal();
  $('#sName').select();
}

function syncSaveDialog(group = '') {
  const id = $('#sList').value;
  $('#sNewWrap').hidden = id !== '__new__';
  const pl = manualLists().find((p) => p.id === id);
  categoryPicker($('#sCats'), pl ? groupsOf(pl) : [], group);
}

async function onSaveSubmit(e) {
  if (e.submitter?.value !== 'save' || !saveChannel) return;
  e.preventDefault();
  try {
    let pl = manualLists().find((p) => p.id === $('#sList').value);
    if (!pl) pl = await createManualList($('#sNewName').value.trim());
    const group = $('#sCats').value();
    const ch = cleanChannel({ ...saveChannel, name: $('#sName').value.trim() || saveChannel.name, group });
    if (group && !groupsOf(pl).includes(group)) pl.groups = [...groupsOf(pl), group];
    pl.channels.push(ch);
    await saveManual(pl);
    $('#saveDialog').close();
    if ($('#streamDialog').open && state.streamMode.kind === 'open') $('#streamDialog').close();
    toast(t('Guardado en «{list}»', { list: pl.name }) + (group ? ' · ' + group : ''), { label: t('Ver lista'), fn: () => selectPlaylist(pl.id) });
  } catch (err) {
    showFormError('saveError', err.message);
  }
}

// ---------- Nueva categoría ----------

function openCategoryDialog() {
  closePop();
  if (isManualActive()) {
    $('#main').scrollTo({ top: $('#browse').offsetTop - 8, behavior: 'smooth' });
    startNewCategoryChip();
    return;
  }
  fillListSelect($('#cList'));
  $('#cName').value = '';
  $('#cNewName').value = '';
  $('#cNewWrap').hidden = $('#cList').value !== '__new__';
  showFormError('catError', '');
  $('#catDialog').showModal();
  catTodo();
  $('#cName').focus();
}

async function onCategorySubmit(e) {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  try {
    const name = $('#cName').value.trim();
    if (!name) throw new Error(t('Escribe el nombre de la categoría.'));
    let pl = manualLists().find((p) => p.id === $('#cList').value);
    if (!pl) pl = await createManualList($('#cNewName').value.trim());
    if (!(await addCategory(pl, name))) return;
    $('#catDialog').close();
    await selectPlaylist(pl.id);
    selectGroup(name);
    toast(t('Categoría «{name}» creada en «{list}»', { name, list: pl.name }));
  } catch (err) {
    showFormError('catError', err.message);
  }
}

// ---------- Añadir lista M3U ----------

let addTab = 'url';

function resetAddPlaylist() {
  for (const id of ['pUrl', 'pText', 'pName', 'pEpg', 'bHost', 'bUser', 'bPass']) $('#' + id).value = '';
  $('#bTranscode').checked = false;
  $('#bRadio').checked = false;
  $('#pFile').value = '';
  $('#pFileName').textContent = '';
  showFormError('playlistError', '');
}

/** Abre «Tus listas» directamente en la vista de añadir una M3U. */
function openAddPlaylist() {
  closePop();
  resetAddPlaylist();
  renderPlaylistManager();
  const dialog = $('#manageDialog');
  delete dialog.dataset.view;
  setDialogView(dialog, 'add');
  if (!dialog.open) dialog.showModal();
  setAddTab('url');
  $('#pUrl').focus();
}

/** Selecciona una pestaña de un control segmentado y desliza su indicador. */
function segSelect(sel, tab) {
  const box = $(sel);
  for (const b of box.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const active = box.querySelector(`[data-tab="${tab}"]`);
  const ind = box.querySelector('.seg-indicator');
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

function setAddTab(tab) {
  addTab = tab;
  for (const p of document.querySelectorAll('#playlistForm [data-panel]')) p.hidden = p.dataset.panel !== tab;
  for (const p of document.querySelectorAll('#playlistForm [data-panel-not]')) p.hidden = p.dataset.panelNot === tab;
  $('#pName').placeholder = tab === 'box' ? t('Opcional (se toma del modelo del receptor)') : t('Opcional (se toma del enlace o del archivo)');
  segSelect('#addTabs', tab);
  playlistTodo();
}

async function addPlaylist({ name, url, text, epg }) {
  const lib = text ? parseLibraryJSON(text) : null;
  if (lib) {
    const created = await createManualList(name || lib.name || t('Lista importada'), lib);
    await selectPlaylist(created.id);
    toast(t('«{name}» importada: {n} canales', { name: created.name, n: created.channels.length }));
    return created;
  }
  const pl = { id: store.newId(), name: name || nameFromUrl(url) || t('Lista {n}', { n: state.playlists.length + 1 }), source: url ? 'url' : 'text', url: url || '', text: text || '', updatedAt: '', epg: epg || '' };
  if (url) {
    await fetchPlaylist(pl);
  } else {
    pl.updatedAt = new Date().toISOString();
  }
  if (looksLikeHlsManifest(pl.text)) {
    throw new Error(t('Esto parece un stream HLS, no una lista de canales. Añádelo como «Canal».'));
  }
  const parsed = parseM3U(pl.text, pl.url);
  const channels = parsed.channels;
  if (!channels.length) throw new Error(t('La lista no contiene canales.'));
  if (!pl.epg && parsed.epg) pl.epg = parsed.epg;
  state.playlists.push(pl);
  await store.savePlaylists(state.playlists);
  await selectPlaylist(pl.id);
  toast(t('«{name}» añadida: {n} canales', { name: pl.name, n: channels.length }));
  return pl;
}

/** Añade un receptor Enigma2 con OpenWebIF como lista (se actualiza desde su API). */
async function addReceiver({ name, host, user, pass, transcode, radio }) {
  const addr = parseBoxAddress(host, user, pass);
  setStatus(t('Conectando con {host}…', { host: addr.host }));
  const about = await aboutBox(addr);
  const box = { base: addr.base, host: addr.host, protocol: addr.protocol, user: addr.user, pass: addr.pass, transcode: !!transcode, radio: !!radio };
  const pl = {
    id: store.newId(),
    name: name || `${about.name}${radio ? ' · Radio' : ''}`,
    source: 'url',
    url: addr.base,
    box,
    text: '',
    updatedAt: '',
    epg: `openwebif:${addr.base}${radio ? '#radio' : ''}`
  };
  await fetchPlaylist(pl);
  const count = parseM3U(pl.text, pl.url).channels.length;
  state.playlists.push(pl);
  await store.savePlaylists(state.playlists);
  await selectPlaylist(pl.id);
  toast(t('«{name}» añadido: {n} canales', { name: pl.name, n: count }));
  return pl;
}

/** Si un enlace devuelve la web de un receptor (HTML), se prueba su API OpenWebIF. */
async function tryReceiverFromUrl(url, name) {
  let addr;
  try { addr = parseBoxAddress(url); } catch (_) { return null; }
  try { await aboutBox(addr); } catch (_) { return null; }
  return addReceiver({ name, host: url });
}

function nameFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.(m3u8?|txt|mpd)$/i, '');
    return file || u.host;
  } catch (_) { return ''; }
}

async function onAddPlaylistClick() {
  showFormError('playlistError', '');
  const name = $('#pName').value.trim();
  const epg = $('#pEpg')?.value?.trim() || '';
  const btn = $('#btnAddPlaylist');
  btn.disabled = true;
  try {
    if (addTab === 'file') {
      const file = $('#pFile').files[0];
      if (!file) throw new Error(t('Elige un archivo .m3u, .m3u8 o .json.'));
      const text = await file.text();
      await addPlaylist({ name: name || (parseLibraryJSON(text) ? '' : file.name.replace(/\.(m3u8?|txt|json)$/i, '')), text, epg });
    } else if (addTab === 'box') {
      await addReceiver({
        name,
        host: $('#bHost').value,
        user: $('#bUser').value.trim(),
        pass: $('#bPass').value,
        transcode: $('#bTranscode').checked,
        radio: $('#bRadio').checked
      });
    } else if (addTab === 'text') {
      const text = $('#pText').value.trim();
      if (!text) throw new Error(t('Pega el contenido de la lista.'));
      await addPlaylist({ name, text, epg });
    } else {
      const url = $('#pUrl').value.trim();
      if (!url) throw new Error(t('Pega el enlace de la lista.'));
      try {
        await addPlaylist({ name, url, epg });
      } catch (err) {
        // ¿Es la dirección de un receptor (web OpenWebIF) en vez de una lista?
        if (!(await tryReceiverFromUrl(url, name))) throw err;
      }
    }
    $('#manageDialog').close();
  } catch (err) {
    showFormError('playlistError', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function addSamplePlaylist() {
  const sampleUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('sample/ejemplos.m3u') : 'sample/ejemplos.m3u';
  const text = await (await fetch(sampleUrl)).text();
  await addPlaylist({ name: t('Ejemplos (DASH · HLS · MSS · DRM)'), text, url: sampleUrl });
}

// ======================================================================
// Mini reproductor al desplazarse
// ======================================================================

let wrapVisible = true;
let miniDismissed = false;

function initMiniPlayer() {
  const io = new IntersectionObserver(([e]) => {
    wrapVisible = e.intersectionRatio > 0.35;
    if (wrapVisible) miniDismissed = false;
    syncMini();
  }, { root: $('#main'), threshold: [0, 0.35, 0.7] });
  io.observe($('#playerWrap'));
  document.addEventListener('fullscreenchange', syncMini);
  addEventListener('resize', syncMini, { passive: true });
  // Estado de pausa en la raíz: congela el indicador animado de las tarjetas sin usar :has().
  const video = $('#video');
  const syncPaused = () => { $('#app').dataset.paused = video.paused ? '1' : ''; };
  for (const ev of ['play', 'pause', 'emptied']) video.addEventListener(ev, syncPaused);
  syncPaused();
}

function syncMini() {
  const on = !isSide() && !wrapVisible && !!state.current && !miniDismissed && !document.fullscreenElement && innerWidth > 640;
  const app = $('#app');
  if (on === (app.dataset.mini === '1')) return;
  app.dataset.mini = on ? '1' : '';
  controls?.closeMenu();
}

// ======================================================================
// Guía TV (EPG)
// ======================================================================

const pad2 = (n) => String(n).padStart(2, '0');
function formatTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateLabel(d) {
  if (!(d instanceof Date) || isNaN(d)) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const weekday = d.toLocaleDateString(locale(), { weekday: 'short' });
  const day = d.getDate();
  const month = d.toLocaleDateString(locale(), { month: 'short' });

  if (isToday) return `${t('Hoy')} (${day} ${month})`;
  if (isYesterday) return `${t('Ayer')} (${day} ${month})`;
  if (isTomorrow) return `${t('Mañana')} (${day} ${month})`;
  return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${day} ${month}`;
}

function updateNowPlayingEpg() {
  renderGuide();
  const npEpg = $('#npEpg');
  const fsEpg = $('#fsEpg');
  const c = state.current;

  if (!c || !hasEpg()) {
    if (npEpg) npEpg.hidden = true;
    if (fsEpg) fsEpg.hidden = true;
    return;
  }
  const info = getNowAndNext(c);
  if (!info || !info.now) {
    if (npEpg) npEpg.hidden = true;
    if (fsEpg) fsEpg.hidden = true;
    return;
  }

  const timeStr = `${formatTime(new Date(info.now.start))} - ${formatTime(new Date(info.now.stop))}`;
  const nextText = info.next ? t('A continuación ({time}): {title}', {
    time: formatTime(new Date(info.next.start)),
    title: info.next.title
  }) : '';

  if (npEpg) {
    npEpg.hidden = false;
    $('#npEpgTitle').textContent = info.now.title;
    $('#npEpgTime').textContent = timeStr;
    $('#npEpgFill').style.width = `${info.progress}%`;
    const nextEl = $('#npEpgNext');
    if (nextEl) {
      nextEl.hidden = !info.next;
      nextEl.textContent = nextText;
    }
  }

  if (fsEpg) {
    fsEpg.hidden = false;
    $('#fsEpgTitle').textContent = info.now.title;
    $('#fsEpgTime').textContent = timeStr;
    $('#fsEpgFill').style.width = `${info.progress}%`;
    const fsNext = $('#fsEpgNext');
    if (fsNext) {
      fsNext.hidden = !info.next;
      fsNext.textContent = nextText;
    }
  }
}

function toggleEpgView(forced) {
  const nextView = typeof forced === 'boolean' ? (forced ? 'epg' : 'browse') : (state.view === 'epg' ? 'browse' : 'epg');
  state.view = nextView;
  const isEpg = nextView === 'epg';
  $('#browse').hidden = isEpg;
  $('#epgView').hidden = !isEpg;
  $('#btnToggleEpg').classList.toggle('active', isEpg);
  if (isEpg) {
    renderEpgView();
    requestAnimationFrame(() => scrollToEpgNow());
  }
}

const EPG_SLOT_WIDTH = 110;
const EPG_SLOTS_TOTAL = 48;
const EPG_TIMELINE_WIDTH = EPG_SLOT_WIDTH * EPG_SLOTS_TOTAL;
const EPG_CH_CELL_WIDTH = 220;

function renderEpgView() {
  const stats = getEpgStats();
  const empty = $('#epgEmpty');
  const container = $('#epgContainer');
  const toolbar = $('#epgDates')?.closest('.epg-toolbar');
  const chipsBar = $('#epgChipsBar');

  if (!hasEpg()) {
    empty.hidden = false;
    container.hidden = true;
    if (toolbar) toolbar.hidden = true;
    if (chipsBar) chipsBar.hidden = true;
    $('#epgSub').textContent = t('No hay ninguna guía cargada');
    return;
  }

  empty.hidden = true;
  container.hidden = false;
  if (toolbar) toolbar.hidden = false;
  if (chipsBar) chipsBar.hidden = false;

  const countStr = t('{ch} canales · {pr} programas', { ch: stats.channelCount, pr: stats.programCount });
  $('#epgSub').textContent = stats.name ? `${stats.name} · ${countStr}` : countStr;

  renderEpgDates();
  renderEpgCategories();
  renderEpgGrid();
}

function renderEpgDates() {
  const wrap = $('#epgDates');
  if (!wrap) return;
  wrap.replaceChildren();
  const curDateStr = new Date(state.epgDate).toDateString();
  const now = new Date();

  for (let offset = -1; offset <= 3; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);

    const btn = el('button', 'epg-date-btn' + (d.toDateString() === curDateStr ? ' active' : ''));
    btn.type = 'button';
    btn.role = 'tab';
    btn.textContent = formatDateLabel(d);
    btn.addEventListener('click', () => {
      state.epgDate = d;
      renderEpgDates();
      renderEpgGrid();
    });
    wrap.appendChild(btn);
  }
}

function renderEpgCategories() {
  const wrap = $('#epgChips');
  if (!wrap) return;
  wrap.replaceChildren();
  const stats = getEpgStats();
  const cats = ['', ...stats.categories];

  for (const cat of cats) {
    const btn = el('button', 'chip' + (state.epgCategory === cat ? ' active' : ''));
    btn.type = 'button';
    btn.role = 'tab';
    btn.textContent = cat || t('Todas');
    btn.addEventListener('click', () => {
      state.epgCategory = cat;
      renderEpgCategories();
      renderEpgGrid();
    });
    wrap.appendChild(btn);
  }
}

function renderEpgGrid() {
  const grid = $('#epgGrid');
  if (!grid) return;
  grid.replaceChildren();

  const dayStart = new Date(state.epgDate);
  dayStart.setHours(0, 0, 0, 0);
  const fromMs = dayStart.getTime();
  const toMs = fromMs + 24 * 3600 * 1000;

  // Cabecera horaria fija (epg-ruler)
  const ruler = el('div', 'epg-ruler');
  const corner = el('div', 'epg-ruler-corner', t('Canales'));
  const slotsWrap = el('div', 'epg-ruler-slots');
  slotsWrap.style.width = `${EPG_TIMELINE_WIDTH}px`;

  for (let s = 0; s < EPG_SLOTS_TOTAL; s++) {
    const slotTime = new Date(fromMs + s * 30 * 60 * 1000);
    const slotEl = el('div', 'epg-slot', formatTime(slotTime));
    slotEl.style.width = `${EPG_SLOT_WIDTH}px`;
    slotsWrap.appendChild(slotEl);
  }
  ruler.append(corner, slotsWrap);
  grid.appendChild(ruler);

  // Línea roja "Ahora" si la fecha seleccionada corresponde al día de hoy
  const now = Date.now();
  if (now >= fromMs && now <= toMs) {
    const nowPct = (now - fromMs) / (toMs - fromMs);
    const nowLine = el('div', 'epg-now-line');
    nowLine.id = 'epgNowLine';
    nowLine.style.left = `${EPG_CH_CELL_WIDTH + nowPct * EPG_TIMELINE_WIDTH}px`;
    grid.appendChild(nowLine);
  }

  // Canales a listar: los de la lista activa o favoritos
  let channelList = state.channels;
  if (!channelList.length) {
    channelList = state.playlists.flatMap((p) => (p.source === 'manual' ? channelsOf(p) : parsedChannels(p)));
  }

  const q = (state.epgQuery || '').trim().toLowerCase();

  for (const ch of channelList) {
    const schedules = getChannelSchedule(ch, fromMs, toMs);
    if (q) {
      const matchName = ch.name.toLowerCase().includes(q);
      const matchProg = schedules.some((p) => p.title.toLowerCase().includes(q) || (p.desc && p.desc.toLowerCase().includes(q)));
      if (!matchName && !matchProg) continue;
    }
    if (state.epgCategory) {
      const matchCat = schedules.some((p) => p.category === state.epgCategory);
      if (!matchCat) continue;
    }

    const row = el('div', 'epg-row');

    const chCell = el('div', 'epg-ch-cell');
    chCell.title = t('Reproducir {name}', { name: ch.name });
    chCell.addEventListener('click', () => {
      play(ch);
      toggleEpgView(false);
    });

    chCell.appendChild(logoEl('epg-ch-logo', ch));
    const chInfo = el('div', 'epg-ch-info');
    chInfo.appendChild(el('span', 'epg-ch-name', ch.name));
    if (ch.group) chInfo.appendChild(el('span', 'epg-ch-group', ch.group));
    chCell.appendChild(chInfo);
    row.appendChild(chCell);

    const tracks = el('div', 'epg-tracks');
    tracks.style.width = `${EPG_TIMELINE_WIDTH}px`;

    for (const p of schedules) {
      if (state.epgCategory && p.category && p.category !== state.epgCategory) continue;

      const pStart = Math.max(fromMs, p.start);
      const pStop = Math.min(toMs, p.stop);
      const left = ((pStart - fromMs) / (toMs - fromMs)) * EPG_TIMELINE_WIDTH;
      const width = Math.max(28, ((pStop - pStart) / (toMs - fromMs)) * EPG_TIMELINE_WIDTH);

      const isLive = now >= p.start && now < p.stop;
      const card = el('div', 'epg-prog-card' + (isLive ? ' live' : ''));
      card.style.left = `${left}px`;
      card.style.width = `${width - 3}px`;
      card.title = `${p.title} (${formatTime(new Date(p.start))} - ${formatTime(new Date(p.stop))})`;

      const pTitle = el('div', 'epg-prog-card-title', p.title);
      const pTime = el('div', 'epg-prog-card-time', `${formatTime(new Date(p.start))} - ${formatTime(new Date(p.stop))}`);
      card.append(pTitle, pTime);

      if (isLive) {
        const liveBar = el('div', 'epg-prog-card-live-bar');
        const liveFill = el('div', 'epg-prog-card-live-fill');
        const dur = Math.max(1, p.stop - p.start);
        const elapsed = Math.max(0, now - p.start);
        liveFill.style.width = `${Math.min(100, Math.round((elapsed / dur) * 100))}%`;
        liveBar.appendChild(liveFill);
        card.appendChild(liveBar);
      }

      card.addEventListener('click', (e) => {
        e.stopPropagation();
        openProgramDetails(ch, p);
      });

      tracks.appendChild(card);
    }

    row.appendChild(tracks);
    grid.appendChild(row);
  }
}

function scrollToEpgNow() {
  const container = $('#epgContainer');
  if (!container) return;
  const dayStart = new Date(state.epgDate);
  dayStart.setHours(0, 0, 0, 0);
  const fromMs = dayStart.getTime();
  const toMs = fromMs + 24 * 3600 * 1000;
  const now = Date.now();
  if (now >= fromMs && now <= toMs) {
    const pct = (now - fromMs) / (toMs - fromMs);
    const targetLeft = pct * EPG_TIMELINE_WIDTH;
    container.scrollTo({ left: Math.max(0, targetLeft - container.clientWidth / 3), behavior: 'smooth' });
  }
}

function updateEpgNowLine() {
  const line = $('#epgNowLine');
  if (!line) return;
  const dayStart = new Date(state.epgDate);
  dayStart.setHours(0, 0, 0, 0);
  const fromMs = dayStart.getTime();
  const toMs = fromMs + 24 * 3600 * 1000;
  const now = Date.now();
  if (now >= fromMs && now <= toMs) {
    const pct = (now - fromMs) / (toMs - fromMs);
    line.style.left = `${EPG_CH_CELL_WIDTH + pct * EPG_TIMELINE_WIDTH}px`;
    line.hidden = false;
  } else {
    line.hidden = true;
  }
}

let selectedProgChannel = null;
function openProgramDetails(channel, p) {
  selectedProgChannel = channel;
  $('#progChLogo').replaceChildren(logoEl('epg-ch-logo', channel));
  $('#progChName').textContent = channel.name;
  $('#progChGroup').textContent = channel.group || '';
  $('#progTitle').textContent = p.title;

  const catEl = $('#progCategory');
  if (p.category) {
    catEl.hidden = false;
    catEl.textContent = p.category;
  } else {
    catEl.hidden = true;
  }

  const startDate = new Date(p.start);
  const stopDate = new Date(p.stop);
  $('#progTime').textContent = `${formatDateLabel(startDate)} · ${formatTime(startDate)} - ${formatTime(stopDate)}`;

  const durMin = Math.max(1, Math.round((p.stop - p.start) / 60000));
  $('#progDuration').textContent = `(${durMin} min)`;

  const isLive = Date.now() >= p.start && Date.now() < p.stop;
  const barWrap = $('#progBarWrap');
  if (isLive) {
    barWrap.hidden = false;
    const dur = Math.max(1, p.stop - p.start);
    const elapsed = Math.max(0, Date.now() - p.start);
    $('#progBarFill').style.width = `${Math.min(100, Math.round((elapsed / dur) * 100))}%`;
  } else {
    barWrap.hidden = true;
  }

  $('#progSubtitle').textContent = p.subTitle || '';
  $('#progSubtitle').hidden = !p.subTitle;
  $('#progDesc').textContent = p.desc || t('Sin descripción disponible.');

  $('#programDialog').showModal();
}

function openEpgDialog() {
  const stats = getEpgStats();
  if (stats.loaded) {
    $('#epgStatusName').textContent = stats.name || t('Guía cargada');
    const updateTime = stats.updatedAt ? new Date(stats.updatedAt).toLocaleTimeString(locale()) : '';
    $('#epgStatusDesc').textContent = `${stats.channelCount} ${t('canales')} · ${stats.programCount} ${t('programas')}${updateTime ? ' · ' + updateTime : ''}`;
  } else {
    $('#epgStatusName').textContent = t('Guía no cargada');
    $('#epgStatusDesc').textContent = t('Introduce una URL o archivo XMLTV');
  }
  $('#cfgEpgUrl').value = stats.url || '';
  $('#cfgEpgFileName').textContent = '';
  $('#epgError').hidden = true;
  $('#epgDialog').showModal();
}

function bindEpgEvents() {
  $('#btnToggleEpg').addEventListener('click', () => toggleEpgView());
  $('#btnEpgBack').addEventListener('click', () => toggleEpgView(false));
  $('#btnEpgNow').addEventListener('click', () => {
    state.epgDate = new Date();
    renderEpgDates();
    renderEpgGrid();
    scrollToEpgNow();
  });
  $('#btnEpgConfig').addEventListener('click', openEpgDialog);

  $('#epgSearch').addEventListener('input', (e) => {
    state.epgQuery = e.target.value;
    renderEpgGrid();
  });

  $('#btnProgPlay').addEventListener('click', () => {
    if (selectedProgChannel) {
      play(selectedProgChannel);
      $('#programDialog').close();
      toggleEpgView(false);
    }
  });

  $('#btnLoadEpgUrl').addEventListener('click', async () => {
    const url = $('#epgUrlInput').value.trim();
    if (!url) return;
    try {
      setStatus(t('Descargando Guía TV…'));
      const stats = await loadEpgFromUrl(url);
      toast(t('EPG cargado: {n} canales y {p} programas', { n: stats.channelCount, p: stats.programCount }));
      setStatus(t('Guía TV actualizada'), 'ok');
      updateNowPlayingEpg();
      renderEpgView();
      renderBrowse();
    } catch (err) {
      toast(t('No se pudo cargar el EPG: {msg}', { msg: err.message }));
      setStatus(t('Error al cargar EPG'), 'err');
    }
  });

  $('#btnPickEpgFile').addEventListener('click', () => $('#epgFileInput').click());
  $('#epgFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setStatus(t('Procesando Guía TV…'));
      const stats = await loadEpgFromFile(file);
      toast(t('EPG cargado: {n} canales y {p} programas', { n: stats.channelCount, p: stats.programCount }));
      setStatus(t('Guía TV cargada'), 'ok');
      updateNowPlayingEpg();
      renderEpgView();
      renderBrowse();
    } catch (err) {
      toast(t('No se pudo cargar el EPG: {msg}', { msg: err.message }));
      setStatus(t('Error al cargar EPG'), 'err');
    }
  });

  $('#btnCfgPickFile').addEventListener('click', () => $('#cfgEpgFile').click());
  $('#cfgEpgFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#cfgEpgFileName').textContent = file.name;
    try {
      const stats = await loadEpgFromFile(file);
      $('#epgDialog').close();
      toast(t('EPG cargado: {n} canales y {p} programas', { n: stats.channelCount, p: stats.programCount }));
      updateNowPlayingEpg();
      renderEpgView();
      renderBrowse();
    } catch (err) {
      $('#epgError').textContent = err.message;
      $('#epgError').hidden = false;
    }
  });

  $('#btnEpgUpdate').addEventListener('click', async () => {
    const url = $('#cfgEpgUrl').value.trim();
    if (!url) return;
    try {
      $('#btnEpgUpdate').disabled = true;
      const stats = await loadEpgFromUrl(url);
      $('#epgDialog').close();
      toast(t('EPG cargado: {n} canales y {p} programas', { n: stats.channelCount, p: stats.programCount }));
      updateNowPlayingEpg();
      renderEpgView();
      renderBrowse();
    } catch (err) {
      $('#epgError').textContent = err.message;
      $('#epgError').hidden = false;
    } finally {
      $('#btnEpgUpdate').disabled = false;
    }
  });

  $('#btnEpgClear').addEventListener('click', async () => {
    await clearEpg();
    $('#epgDialog').close();
    toast(t('EPG borrado'));
    updateNowPlayingEpg();
    renderEpgView();
    renderBrowse();
  });
}

// ======================================================================
// UI general
// ======================================================================

function setStatus(text, kind = '') {
  const node = $('#status');
  node.textContent = text;
  node.title = text;
  node.className = 'status ' + kind;
}

function showOverlay(title, text, isError = false) {
  $('#overlayTitle').textContent = title;
  $('#overlayText').textContent = text;
  $('#overlay').classList.toggle('error', isError);
  $('#overlayActions').hidden = !(isError && state.current);
  $('#overlay').hidden = false;
}

function hideOverlay() { $('#overlay').hidden = true; }

let toastTimer = 0;
function toast(msg, action) {
  const node = $('#toast');
  node.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = el('button', 'toast-action', action.label);
    b.type = 'button';
    b.addEventListener('click', () => { node.dataset.show = ''; action.fn(); });
    node.appendChild(b);
  }
  node.dataset.action = action ? '1' : '';
  // Popover: queda por encima de cualquier diálogo abierto.
  try { if (node.matches(':popover-open')) node.hidePopover(); node.showPopover(); } catch (_) { /* sin soporte */ }
  node.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.show = ''; }, action ? 5000 : 2400);
}

// ---------- Ayuda ----------

const TOUR_STEPS = [
  { title: 'Bienvenido a IP Player', text: 'Reproduce listas de canales M3U y enlaces DASH, HLS o Smooth Streaming. Te enseño lo básico en unos pasos. Puedes salir cuando quieras con Esc.' },
  { target: '#btnAdd', title: '1. Añade lo que quieras ver', text: 'Desde aquí añades una lista M3U, un canal suelto, tu propia lista o una categoría nueva.' },
  { target: '#btnListPicker', title: '2. Cambia de lista', text: 'Aquí están tus listas y tus Favoritos. Elige cuál ver debajo del reproductor.' },
  { target: '.search', title: '3. Busca', text: 'Escribe para filtrar los canales de la lista. Atajo: tecla / para buscar y ↓ para saltar a los resultados.' },
  { target: '#chipsBar', title: '4. Elige un canal', text: 'Debajo del reproductor tienes los canales en bloques por categoría. Clic para verlo, ★ para favoritos y ⋯ para más opciones. En tus listas propias puedes arrastrar canales de una categoría a otra.' },
  { target: '#player', title: '5. Controla la reproducción', text: 'Mueve el ratón sobre el vídeo para ver los controles. El engranaje cambia calidad, idioma y subtítulos. Si bajas por la página, el vídeo sigue en una ventana pequeña.' },
  { target: '#btnHelp', title: '¿Dudas?', text: 'Aquí tienes esta guía, los atajos de teclado, preguntas frecuentes y la opción de texto más grande.' }
];

function openTour() {
  if ($('#helpDialog').open) $('#helpDialog').close();
  hideTooltip();
  closePop();
  $('#main').scrollTo({ top: 0 });
  startTour(TOUR_STEPS.map((s) => ({ ...s, title: t(s.title), text: t(s.text) })), { onDone: () => store.patchState({ tourDone: true }) });
}

function openHelp() {
  hideTooltip();
  closePop();
  const d = $('#helpDialog');
  if (d.open) return;
  delete d.dataset.view;
  setDialogView(d, 'start');
  d.showModal();
  segSelect('#helpTabs', 'start');
}

async function applyUiPrefs(patch) {
  const ui = { largeText: false, tips: true, beginner: false, layout: 'blocks', ...(await store.get('ui', {})), ...(patch || {}) };
  if (patch) await store.set('ui', ui);
  setSideCollapsed(!!ui.sideCollapsed);
  setLayout(ui.layout);
  document.documentElement.dataset.large = ui.largeText ? '1' : '';
  beginner = !!ui.beginner;
  document.documentElement.dataset.beginner = beginner ? '1' : '';
  // En modo principiante las etiquetas de ayuda siempre se muestran.
  setTooltipsEnabled(ui.tips || beginner);
  $('#optLarge').checked = ui.largeText;
  $('#optTips').checked = ui.tips;
  $('#optBeginner').checked = beginner;
  uiProxy = { enabled: false, url: '', ...(ui.proxy || {}) };
  $('#optProxy').checked = uiProxy.enabled;
  if (document.activeElement !== $('#gProxy')) $('#gProxy').value = uiProxy.url;
  $('#gProxyWrap').hidden = !uiProxy.enabled;
  if (uiProxy.enabled) proxyHint($('#gProxy').value, $('#gProxyHint'));
  refreshTodos();
  requestAnimationFrame(moveChipIndicator);
}

// ---------- Indicador en pantalla para el teclado ----------

function osdFor(key) {
  const v = $('#video');
  const pct = Math.round((v.muted ? 0 : v.volume) * 100);
  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown':
      return controls.osd(`${pct} %`, { icon: pct ? 'i-vol' : 'i-mute', level: pct / 100 });
    case 'm':
      return controls.osd(v.muted || !v.volume ? t('Silenciado') : t('Sonido {n} %', { n: pct }), { icon: v.muted || !v.volume ? 'i-mute' : 'i-vol' });
    case 'ArrowLeft':
      return controls.osd('−10 s');
    case 'ArrowRight':
      return controls.osd('+10 s');
    case 'c': {
      const a = activeAdapter();
      const tr = a?.textTracks?.().find((x) => x.active);
      return controls.osd(tr ? t('Subtítulos: {name}', { name: langName(tr.lang) || tr.label || t('activados') }) : t('Subtítulos desactivados'), { icon: 'i-cc' });
    }
    default:
      return null;
  }
}

function bindEvents() {
  // Barra superior
  const listBtn = $('#btnListPicker');
  $('#listMenu')._render = buildListMenu;
  listBtn.addEventListener('click', (e) => togglePop($('#listMenu'), listBtn, { focus: e.detail === 0 }));
  const addBtn = $('#btnAdd');
  $('#addMenu')._render = buildAddMenu;
  addBtn.addEventListener('click', (e) => togglePop($('#addMenu'), addBtn, { align: 'end', focus: e.detail === 0 }));
  $('#btnManage').addEventListener('click', openManager);
  const langBtn = $('#btnLang');
  $('#langMenu')._render = buildLangMenu;
  langBtn.addEventListener('click', (e) => togglePop($('#langMenu'), langBtn, { align: 'end', focus: e.detail === 0 }));

  let searchTimer = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const was = state.query;
      state.query = e.target.value;
      renderBrowse({ animate: !was && !!state.query });
      if (!was && state.query && !isSide()) {
        const main = $('#main');
        const top = $('#browse').offsetTop - 8;
        if (main.scrollTop < top - 40) main.scrollTo({ top, behavior: 'smooth' });
      }
    }, 120);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (isSide() ? $('#sideList .side-row') : $('#browseBody .card-hit'))?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      state.query = e.target.value;
      computeFiltered();
      if (state.filtered[0]) play(state.filtered[0]);
    } else if (e.key === 'Escape' && e.target.value) {
      e.preventDefault();
      e.target.value = '';
      state.query = '';
      renderBrowse();
    }
  });

  // Menús flotantes: cierre y teclado
  document.addEventListener('pointerdown', (e) => {
    if (!pop) return;
    if (pop.menu.contains(e.target) || pop.anchor?.contains(e.target)) return;
    closePop();
  });
  $('#main').addEventListener('scroll', () => { if (pop) closePop(); }, { passive: true });
  addEventListener('resize', () => { closePop(); moveChipIndicator(); });
  document.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop({ refocus: true }); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Sin las opciones de un submenú plegado.
      const items = [...pop.menu.querySelectorAll('button:not([disabled])')].filter((b) => !b.closest('.pop-submenu:not([data-open="1"])'));
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const i = items.indexOf(document.activeElement);
      const j = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[j].focus();
    }
  }, true);

  // Explorador
  $('#browseBody').addEventListener('keydown', onCardsKey);
  $('#browseTitle').addEventListener('input', (e) => e.target.style.setProperty('--chars', String(Math.max(4, e.target.value.length + 1))));
  $('#browseTitle').addEventListener('change', async (e) => {
    const pl = activeList();
    const v = e.target.value.trim();
    if (!pl || pl.source !== 'manual' || !v) { renderBrowseHead(); return; }
    pl.name = v;
    await saveManual(pl);
  });
  $('#browseTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  // Bienvenida
  $('#btnEmptyAdd').addEventListener('click', openAddPlaylist);
  $('#btnEmptyCreate').addEventListener('click', () => createListFlow());
  $('#btnEmptySample').addEventListener('click', async () => {
    try { await addSamplePlaylist(); } catch (err) { toast(err.message); }
  });
  $('#btnEmptyTour').addEventListener('click', openTour);

  // Gestor de listas
  $('#btnCreateList').addEventListener('click', async () => {
    const name = $('#pNewName').value.trim();
    $('#pNewName').value = '';
    await createListFlow(name);
  });
  $('#pNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btnCreateList').click(); } });
  $('#btnManagerAdd').addEventListener('click', () => { resetAddPlaylist(); setDialogView($('#manageDialog'), 'add'); setAddTab('url'); $('#pUrl').focus(); });

  // Añadir lista M3U
  for (const b of document.querySelectorAll('#addTabs [data-tab]')) b.addEventListener('click', () => setAddTab(b.dataset.tab));
  $('#addTabs').addEventListener('keydown', (e) => {
    const tabs = ['url', 'file', 'text'];
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const t = tabs[(tabs.indexOf(addTab) + d + tabs.length) % tabs.length];
    setAddTab(t);
    $(`#addTabs [data-tab="${t}"]`).focus();
  });
  const drop = $('#pDrop');
  $('#pFile').addEventListener('change', () => { $('#pFileName').textContent = $('#pFile').files[0]?.name || ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = '1'; });
  drop.addEventListener('dragleave', () => { drop.dataset.over = ''; });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.dataset.over = '';
    if (e.dataTransfer.files.length) {
      $('#pFile').files = e.dataTransfer.files;
      $('#pFileName').textContent = e.dataTransfer.files[0].name;
      playlistTodo();
    }
  });
  $('#btnAddPlaylist').addEventListener('click', onAddPlaylistClick);
  $('#playlistForm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input:not([type="file"])')) { e.preventDefault(); onAddPlaylistClick(); }
  });
  $('#btnSample').addEventListener('click', async () => {
    showFormError('playlistError', '');
    try { await addSamplePlaylist(); $('#manageDialog').close(); } catch (err) { showFormError('playlistError', err.message); }
  });

  // Guardar en lista y categoría
  $('#sList').addEventListener('change', () => syncSaveDialog());
  $('#saveForm').addEventListener('submit', onSaveSubmit);
  $('#cList').addEventListener('change', () => { $('#cNewWrap').hidden = $('#cList').value !== '__new__'; });
  $('#catForm').addEventListener('submit', onCategorySubmit);

  // Diálogo de canal
  $('#fList').addEventListener('change', () => syncStreamTarget($('#fCats').value?.() || ''));
  $('#btnStreamSaveTo').addEventListener('click', () => {
    try { openSaveDialog(readStreamForm()); } catch (err) { showFormError('streamError', err.message); }
  });
  $('#btnStreamSave').addEventListener('click', onStreamSave);
  $('#fDrm').addEventListener('change', syncDrmFields);
  $('#btnImportParse').addEventListener('click', importIntoForm);
  $('#streamForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'play') return;
    try {
      play(readStreamForm());
    } catch (err) {
      e.preventDefault();
      showFormError('streamError', err.message);
    }
  });
  $('#btnStreamFav').addEventListener('click', async () => {
    try {
      const ch = readStreamForm();
      if (!isFav(ch)) await toggleFavorite(ch);
      else toast(t('Ya está en favoritos'));
    } catch (err) {
      showFormError('streamError', err.message);
    }
  });

  // Detección del tipo mientras se escribe la URL
  const urlHint = $('#fUrlHint');
  const urlHintDefault = () => t('Pega el enlace del vídeo. Suele terminar en .mpd (DASH), .m3u8 (HLS) o /Manifest (Smooth Streaming).');
  const updateUrlHint = () => {
    const u = $('#fUrl').value.trim();
    $('#fName').placeholder = (u && nameFromUrl(u)) || t('Opcional');
    if (!u) { urlHint.textContent = urlHintDefault(); urlHint.dataset.kind = ''; return; }
    if (!/^https?:\/\//i.test(u)) {
      urlHint.textContent = t('La URL debe empezar por http:// o https://');
      urlHint.dataset.kind = 'warn';
      return;
    }
    const ty = detectType(u, $('#fType').value);
    urlHint.textContent = ty === 'auto'
      ? t('Formato no reconocido por la URL: se intentará detectar al reproducir.')
      : t('Formato detectado: {type}', { type: typeLabel(ty) });
    urlHint.dataset.kind = ty === 'auto' ? '' : 'ok';
  };
  $('#fUrl').addEventListener('input', updateUrlHint);
  $('#fType').addEventListener('change', updateUrlHint);
  $('#streamDialog').addEventListener('toggle', (e) => { if (e.newState === 'open') updateUrlHint(); });

  // Vistas de los diálogos: botones «Atrás» ([data-back]) y filas que llevan a otra vista ([data-view-to])
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-back], [data-view-to]');
    const dialog = btn?.closest('dialog');
    if (!dialog || btn.id === 'btnManagerAdd') return;
    const back = btn.hasAttribute('data-back');
    const to = back ? btn.dataset.back : btn.dataset.viewTo;
    if (dialog.id === 'streamDialog' && to === 'main') advancedSummary();
    if (dialog.id === 'manageDialog' && to === 'lists') { renderPlaylistManager(); showFormError('managerError', ''); }
    setDialogView(dialog, to, { back });
    if (dialog.id === 'streamDialog' && to === 'advanced') $('#fType').focus({ preventScroll: true });
    if (dialog.id === 'streamDialog' && to === 'main') $('#btnAdvanced').focus({ preventScroll: true });
  });

  // Ayuda: pestañas
  const helpTabs = ['start', 'keys', 'faq', 'prefs'];
  const setHelpTab = (tab) => {
    const d = $('#helpDialog');
    const back = helpTabs.indexOf(tab) < helpTabs.indexOf(d.dataset.view);
    setDialogView(d, tab, { back });
    segSelect('#helpTabs', tab);
  };
  for (const b of document.querySelectorAll('#helpTabs [data-tab]')) b.addEventListener('click', () => setHelpTab(b.dataset.tab));
  $('#helpTabs').addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const tab = helpTabs[(helpTabs.indexOf($('#helpDialog').dataset.view) + d + helpTabs.length) % helpTabs.length];
    setHelpTab(tab);
    $(`#helpTabs [data-tab="${tab}"]`).focus();
  });

  // Ayuda y accesibilidad
  $('#btnHelp').addEventListener('click', openHelp);
  $('#btnStartTour').addEventListener('click', openTour);
  $('#optLarge').addEventListener('change', (e) => applyUiPrefs({ largeText: e.target.checked }));
  $('#btnLayout').addEventListener('click', () => applyUiPrefs({ layout: isSide() ? 'blocks' : 'side' }));
  for (const b of document.querySelectorAll('#layoutPick [data-layout]')) {
    b.addEventListener('click', () => applyUiPrefs({ layout: b.dataset.layout }));
  }
  bindSide();
  $('#btnSideCollapse').addEventListener('click', () => applyUiPrefs({ sideCollapsed: !sideCollapsed }));
  $('#optTips').addEventListener('change', (e) => applyUiPrefs({ tips: e.target.checked }));
  $('#optBeginner').addEventListener('change', (e) => applyUiPrefs({ beginner: e.target.checked }));
  // Proxy general
  $('#optProxy').addEventListener('change', (e) => applyUiPrefs({ proxy: { ...uiProxy, enabled: e.target.checked } }));
  $('#gProxy').addEventListener('input', (e) => proxyHint(e.target.value, $('#gProxyHint')));
  $('#gProxy').addEventListener('change', (e) => applyUiPrefs({ proxy: { ...uiProxy, url: e.target.value.trim() } }));
  $('#btnTestProxy').addEventListener('click', testGeneralProxy);
  // Proxy del canal
  $('#fProxyMode').addEventListener('change', syncProxyFields);
  $('#fProxy').addEventListener('input', () => proxyHint($('#fProxy').value, $('#fProxyHint')));
  // Requisitos en vivo mientras se rellena cada formulario
  for (const ev of ['input', 'change']) {
    $('#streamForm').addEventListener(ev, channelTodo);
    $('#playlistForm').addEventListener(ev, playlistTodo);
    $('#catForm').addEventListener(ev, catTodo);
  }
  $('#fCats').addEventListener('click', () => requestAnimationFrame(channelTodo));

  // Mensaje de error: reintentar o revisar el stream
  $('#btnRetry').addEventListener('click', () => state.current && play(state.current));
  $('#btnFixStream').addEventListener('click', () => $('#btnEdit').click());

  // Barra «en reproducción»
  $('#btnFav').addEventListener('click', () => state.current && toggleFavorite(baseChannel(state.current)));
  $('#btnGuideLive').addEventListener('click', () => state.current && play(baseChannel(state.current)));
  $('#btnAddTo').addEventListener('click', () => {
    if (!state.current) { toast(t('Primero reproduce o abre un canal')); return; }
    openSaveDialog(state.current);
  });
  $('#btnEdit').addEventListener('click', () => {
    const c = state.current;
    const pl = c?.listId && manualLists().find((p) => p.id === c.listId);
    if (pl && pl.channels[c.index]?.url === c.url) openStreamDialog({ ...c }, { mode: 'edit', listId: pl.id, index: c.index });
    else openStreamDialog(c, { mode: 'open' });
  });
  $('#btnClosePlayer').addEventListener('click', stopPlayback);
  $('#btnCopy').addEventListener('click', async () => {
    if (!state.current) return;
    await navigator.clipboard.writeText(state.current.url);
    toast(t('URL copiada'));
  });

  // Mini reproductor
  $('#btnMiniBack').addEventListener('click', () => $('#main').scrollTo({ top: 0, behavior: 'smooth' }));
  $('#btnMiniClose').addEventListener('click', stopPlayback);

  // Eventos de la Guía TV (EPG)
  bindEpgEvents();

  // Atajos de teclado (sin animaciones: se repiten mucho)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTourOpen() || pop) return;
    if (e.target.closest('input, textarea, select, dialog[open]')) return;
    const onButton = e.target.closest('button, [role="slider"]');
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const actions = {
      PageDown: () => step(1),
      PageUp: () => step(-1),
      '/': () => $('#search').focus(),
      f: () => controls.toggleFullscreen(),
      k: () => controls.togglePlay(),
      ' ': () => { if (!onButton) controls.togglePlay(); else return false; },
      m: () => controls.toggleMute(),
      c: () => controls.toggleSubtitles(),
      n: () => openAddChannel(),
      g: () => toggleEpgView(),
      v: () => applyUiPrefs({ layout: isSide() ? 'blocks' : 'side' }),
      '?': () => openHelp(),
      ArrowLeft: () => (onButton ? false : controls.seekBy(-10)),
      ArrowRight: () => (onButton ? false : controls.seekBy(10)),
      ArrowUp: () => controls.nudgeVolume(0.05),
      ArrowDown: () => controls.nudgeVolume(-0.05)
    };
    const fn = actions[key];
    if (fn && fn() !== false) {
      e.preventDefault();
      controls.wake();
      if (controls.enabled && key !== 'n' && key !== 'g') osdFor(key);
    }
  });
}

// ======================================================================
// Arranque
// ======================================================================

async function main() {
  // Idioma antes de pintar nada: el guardado o, si no hay, el del navegador.
  await setLang((await store.get('ui', {})).lang || detectLang());
  enhanceSelects(); // desplegables propios (antes de registrar los textos a traducir)
  initI18n();
  initTooltips();
  bindEvents();
  applyUiPrefs();
  prefs = { ...prefs, ...(await store.getPrefs()) };
  await initPlayer();
  await loadData();
  await loadCachedEpg();
  updateNowPlayingEpg();
  setInterval(() => {
    updateNowPlayingEpg();
    if (isSide()) refreshSideEpg();
    if (state.view === 'epg') updateEpgNowLine();
  }, 30000);

  const saved = await store.getState();
  if ((await store.get('ui', {})).beginner === undefined && !saved.tourDone) await applyUiPrefs({ beginner: true });
  state.activeId = saved.playlistId && (saved.playlistId === FAV_ID || state.playlists.some((p) => p.id === saved.playlistId))
    ? saved.playlistId
    : (state.playlists[0]?.id || FAV_ID);
  await selectPlaylist(state.activeId);
  if (saved.group && groupNames().includes(saved.group)) {
    state.group = saved.group;
    renderBrowse();
  }
  initMiniPlayer();
  if (isSide() && !state.current) showIdle();

  // Parámetros desde el menú contextual
  const params = new URLSearchParams(location.search);
  if (params.get('playlist')) {
    try {
      await addPlaylist({ url: params.get('playlist') });
    } catch (err) {
      setStatus(t('No se pudo cargar la lista: {msg}', { msg: err.message }), 'err');
    }
  }
  if (params.get('play')) {
    const url = params.get('play');
    play({ id: 'manual', name: nameFromUrl(url) || url, url, type: '', headers: {}, drm: emptyDrm(), errors: [] });
  }
  if (params.size) history.replaceState(null, '', location.pathname);

  // Primera vez: guía rápida
  if (!saved.tourDone && !params.size) setTimeout(() => { if (!document.querySelector('dialog[open]')) openTour(); }, 700);
}

main().catch((err) => {
  console.error(err);
  setStatus(t('Error al iniciar: {msg}', { msg: err.message }), 'err');
});
