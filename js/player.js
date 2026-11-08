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
import { VirtualList } from './virtual-list.js';
import { DashEngine } from './dash-engine.js';
import { Controls, langName } from './controls.js';
import { initTooltips, setTooltipsEnabled, hideTooltip } from './tooltip.js';
import { startTour, isTourOpen } from './tour.js';
import { cleanChannel, groupsOf, parseLibraryJSON, exportList } from './library.js';

const $ = (sel) => document.querySelector(sel);
const FAV_ID = '__favorites__';
const ROW_HEIGHT = 56;
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
  libId: null, // lista propia abierta en el editor
  libEdit: null, // { listId, index } canal de lista propia en edición, o { listId, add: true }
  cursor: -1 // fila resaltada al navegar la lista con el teclado
};

let player = null;
let controls = null;
let list = null;
let loadToken = 0;
let dashEngine = null;
let engine = 'shaka'; // motor activo: 'shaka' | 'dashjs'
// Idiomas preferidos (se recuerdan entre canales y sesiones).
let prefs = { audioLang: '', textLang: '', textOn: false };
const browserLang = (navigator.language || 'es').split('-')[0];
const MSS_LIVE_NOT_SUPPORTED = 4047;

// ======================================================================
// Reproductor
// ======================================================================

async function initPlayer() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    showOverlay('Navegador no compatible', 'Este navegador no soporta Media Source Extensions.', true);
    return;
  }
  const video = $('#video');
  player = new shaka.Player();
  await player.attach(video);

  controls = new Controls({
    root: $('#player'),
    video,
    getAdapter: () => (engine === 'dashjs' ? dashEngine : shakaAdapter),
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
  });

  net.registerResponseFilter((type, response) => {
    const tpl = state.current?.drm?.responseTemplate;
    if (type === RT.LICENSE && tpl) transformLicenseResponse(response, tpl);
  });

  dashEngine = new DashEngine(video, {
    onError: (info) => {
      controls.setEnabled(false);
      controls.setBusy(false);
      showOverlay(info.title, info.text, true);
      setStatus(`${info.title}: ${info.text.split('\n')[0]}`, 'err');
    },
    onTracks: () => controls.refreshTracks()
  });

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
  if (channels > 2) parts.push(channels === 6 ? '5.1' : channels === 8 ? '7.1' : `${channels} canales`);
  if (spatial) parts.push('Espacial');
  for (const r of roles) if (ROLE_LABEL[r]) parts.push(ROLE_LABEL[r]);
  return parts.join(' · ');
}

function textDetails(kind, roles = [], forced = false) {
  const parts = [];
  if (forced || roles.includes('forced-subtitle')) parts.push('Forzados');
  if (kind === 'caption' || roles.includes('caption')) parts.push('CC');
  if (roles.includes('description')) parts.push('Descriptivos');
  if (roles.includes('commentary')) parts.push('Comentarios');
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
  renderNowPlaying();
  list?.refresh();
  hideOverlay();
  controls.setEnabled(false);
  controls.setBusy(true);

  const type = detectType(channel.url, channel.type);
  const drmText = drmLabel(channel.drm);
  setStatus(`Cargando ${TYPE_LABEL[type] || ''}${drmText ? ' · ' + drmText : ''}…`);

  if (channel.errors?.length) setStatus(`Aviso en la entrada M3U: ${channel.errors.join(' · ')}`, 'warn');

  try {
    await applyHeaderRules(channel.headers, channel.drm?.licenseUrl, channel.drm?.licenseHeaders);
  } catch (err) {
    console.warn('No se pudieron aplicar las cabeceras', err);
  }
  if (token !== loadToken) return;

  if (channel.engine === 'dashjs') return playWithDash(channel, token, type, drmText);
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
    setStatus(TYPE_LABEL[type] === 'Auto' ? `Reproduciendo · ${detectLoadedType()}` : 'Reproduciendo', 'ok');
    controls.setEnabled(true);
    store.patchState({ channelUrl: channel.url });
  } catch (err) {
    if (token !== loadToken) return;
    // Shaka no soporta Smooth Streaming en directo → dash.js
    if (err?.code === MSS_LIVE_NOT_SUPPORTED && channel.engine !== 'shaka') {
      setStatus('Smooth Streaming en directo: cambiando al motor dash.js…', 'warn');
      return playWithDash(channel, token, 'mss', drmText);
    }
    showError(err);
  }
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
  clearCaptions();
  const video = $('#video');
  video.autoplay = true; // dash.js lo desactiva al destruirse
  video.removeAttribute('src');
  video.load();
  await player.attach(video);
}

async function useDash() {
  if (engine === 'dashjs') return;
  engine = 'dashjs';
  await player.detach();
  clearCaptions();
}

async function playWithDash(channel, token, type, drmText) {
  if (!(await DashEngine.ensureLoaded())) {
    showError(new Error('dash.js no está disponible.'));
    return;
  }
  await useDash();
  if (token !== loadToken) return;
  const label = `${TYPE_LABEL[type] || 'Auto'} (dash.js)${drmText ? ' · ' + drmText : ''}`;
  setStatus(`Cargando ${label}…`);
  const video = $('#video');
  video.addEventListener('playing', () => {
    if (token === loadToken) {
      setStatus('Reproduciendo · motor dash.js', 'ok');
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
  return { DASH: 'DASH', HLS: 'HLS', MSS: 'Smooth Streaming' }[t] || 'Progresivo';
}

// ---------- Errores ----------

function describeError(err) {
  const E = shaka.util.Error;
  if (!err || !(err instanceof E)) {
    return { title: 'No se pudo reproducir', text: String(err?.message || err) };
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
      return {
        title: 'DRM no soportado',
        text: 'El navegador no soporta el sistema DRM requerido.\nPlayReady solo funciona en Microsoft Edge; en Chrome usa Widevine o ClearKey.'
      };
    case C.NO_LICENSE_SERVER_GIVEN:
      return { title: 'Contenido cifrado', text: 'Falta el servidor de licencias o las claves ClearKey.\nUsa «Editar» para añadirlas.' };
    case C.LICENSE_REQUEST_FAILED:
      return { title: 'Falló la licencia', text: `El servidor de licencias rechazó la petición ${http(inner)}.\nRevisa la URL y las cabeceras de la licencia.` };
    case C.LICENSE_RESPONSE_REJECTED:
      return { title: 'Licencia no válida', text: 'El CDM rechazó la respuesta de licencia (¿plantilla de respuesta incorrecta?).' };
    case C.BAD_HTTP_STATUS:
      return { title: `Error HTTP ${err.data[1]}`, text: `${shortUrl(err.data[0])}\nPuede requerir User-Agent, Referer o Cookie (usa «Editar»).` };
    case C.HTTP_ERROR:
      return { title: 'Error de red', text: `No se pudo conectar con ${shortUrl(err.data[0])}.` };
    case C.TIMEOUT:
      return { title: 'Tiempo agotado', text: `El servidor no respondió: ${shortUrl(err.data[0])}` };
    case C.UNABLE_TO_GUESS_MANIFEST_TYPE:
      return { title: 'Tipo desconocido', text: 'No se pudo detectar el formato.\nIndica el tipo (DASH / HLS / Smooth Streaming) con «Editar».' };
    case C.CONTENT_UNSUPPORTED_BY_BROWSER:
      return { title: 'Formato no soportado', text: 'Los códecs de este stream no son compatibles con el navegador.' };
    case C.HLS_MSE_ENCRYPTED_MP2T_NOT_SUPPORTED ?? 4040:
      return {
        title: 'Cifrado HLS no compatible',
        text: 'Este stream usa cifrado HLS en segmentos MPEG-TS (FairPlay o SAMPLE-AES), que este reproductor no admite.\nSolo se pueden reproducir streams sin cifrar, con AES-128 estándar o con DRM compatible con Chrome (Widevine, ClearKey en CENC).'
      };
    case C.VIDEO_ERROR:
      return {
        title: 'Error de decodificación',
        text: 'El vídeo no se pudo decodificar.' + (state.current?.drm?.system === 'clearkey' ? '\n¿Son correctas las claves ClearKey (KID:KEY)?' : '')
      };
    default:
      return { title: `Error ${err.code}`, text: `${name}${inner ? ` (${inner.code})` : ''}\nPrueba a reintentar o revisa el tipo y las cabeceras del stream.` };
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

async function loadData() {
  state.playlists = await store.getPlaylists();
  state.favorites = await store.getFavorites();
}

function renderPlaylistSelect() {
  const sel = $('#playlistSelect');
  sel.replaceChildren();
  const favOpt = new Option(`★ Favoritos (${state.favorites.length})`, FAV_ID);
  sel.add(favOpt);
  for (const pl of state.playlists) sel.add(new Option(pl.source === 'manual' ? `✎ ${pl.name}` : pl.name, pl.id));
  sel.value = state.activeId || FAV_ID;
}

async function selectPlaylist(id, { refresh = false } = {}) {
  state.activeId = id;
  state.group = '';
  $('#playlistSelect').value = id;
  if (id === FAV_ID) {
    state.channels = state.favorites.map((c, i) => ({ ...c, id: `fav${i}` }));
  } else {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) return selectPlaylist(FAV_ID);
    if (pl.source === 'manual') {
      state.channels = pl.channels.map((c, i) => ({ ...c, id: `m${i}`, errors: [] }));
      renderGroups();
      applyFilter();
      store.patchState({ playlistId: id });
      return;
    }
    try {
      if (refresh || !pl.text) await fetchPlaylist(pl);
      state.channels = parseM3U(pl.text, pl.url).channels;
    } catch (err) {
      state.channels = [];
      setStatus(`No se pudo cargar «${pl.name}»: ${err.message}`, 'err');
    }
  }
  renderGroups();
  applyFilter();
  store.patchState({ playlistId: id });
}

async function fetchPlaylist(pl) {
  if (pl.source !== 'url') return;
  setStatus(`Descargando «${pl.name}»…`);
  const res = await fetch(pl.url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  pl.text = await res.text();
  pl.updatedAt = new Date().toISOString();
  await store.savePlaylists(state.playlists);
  setStatus(`«${pl.name}» actualizada`, 'ok');
}

function renderGroups() {
  const sel = $('#groupSelect');
  const counts = new Map();
  for (const c of state.channels) counts.set(c.group, (counts.get(c.group) || 0) + 1);
  sel.replaceChildren(new Option(`Todos los grupos (${state.channels.length})`, ''));
  for (const [g, n] of counts) sel.add(new Option(`${g || 'Sin grupo'} (${n})`, g || '\u0000'));
  sel.value = state.group;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function applyFilter() {
  const q = norm(state.query);
  const g = state.group;
  state.filtered = state.channels.filter((c) => {
    if (g && (c.group || '\u0000') !== g) return false;
    if (q && !norm(c.name).includes(q) && !norm(c.group).includes(q)) return false;
    return true;
  });
  state.cursor = state.filtered.length ? Math.min(state.cursor, state.filtered.length - 1) : -1;
  list.setItems(state.filtered);
  const total = state.channels.length;
  $('#listMeta').textContent = total
    ? `${state.filtered.length} de ${total} canales`
    : '';
  $('#emptyList').hidden = total > 0;
}

const favKey = (c) => `${c.url}|${c.name}`;
const isFav = (c) => state.favorites.some((f) => favKey(f) === favKey(c));

async function toggleFavorite(channel) {
  const key = favKey(channel);
  const idx = state.favorites.findIndex((f) => favKey(f) === key);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    toast('Eliminado de favoritos');
  } else {
    const { id, ...copy } = channel;
    state.favorites.push(structuredClone(copy));
    toast('Añadido a favoritos');
  }
  await store.saveFavorites(state.favorites);
  renderPlaylistSelect();
  if (state.activeId === FAV_ID) {
    state.channels = state.favorites.map((c, i) => ({ ...c, id: `fav${i}` }));
    renderGroups();
    applyFilter();
  } else {
    list.refresh();
  }
  renderNowPlaying();
}

function initials(name) {
  return String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function logoEl(className, channel) {
  const box = document.createElement('span');
  box.className = className;
  if (channel.logo) {
    const img = document.createElement('img');
    img.loading = 'lazy';
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

function renderRow(channel, index) {
  const row = document.createElement('div');
  const active = !!state.current && favKey(state.current) === favKey(channel);
  row.className = 'ch' + (active ? ' active' : '') + (index === state.cursor ? ' cursor' : '');
  row.id = `ch-opt-${index}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(active));
  row.title = channel.name;

  const num = document.createElement('span');
  num.className = 'ch-num';
  num.textContent = channel.chno || index + 1;

  const text = document.createElement('span');
  text.className = 'ch-text';
  const name = document.createElement('span');
  name.className = 'ch-name';
  name.textContent = channel.name;
  const sub = document.createElement('span');
  sub.className = 'ch-sub';
  const type = detectType(channel.url, channel.type);
  sub.textContent = [...new Set([channel.group, type !== 'auto' ? TYPE_LABEL[type] : '', drmLabel(channel.drm)].filter(Boolean))].join(' · ');
  text.append(name, sub);

  const fav = document.createElement('button');
  fav.className = 'ch-fav' + (isFav(channel) ? ' on' : '');
  fav.tabIndex = -1;
  fav.dataset.tip = isFav(channel) ? 'Quitar de favoritos' : 'Añadir a favoritos';
  fav.setAttribute('aria-label', fav.dataset.tip);
  fav.innerHTML = '<svg><use href="#i-star"/></svg>';
  fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(channel); });

  row.append(num, logoEl('ch-logo', channel), text, fav);
  row.addEventListener('click', () => { setCursor(index, false); play(channel); });
  return row;
}

function renderNowPlaying() {
  const c = state.current;
  const logo = $('#npLogo');
  logo.replaceChildren();
  $('#npMeta').replaceChildren();
  if (!c) {
    $('#npTitle').textContent = 'Nada en reproducción';
    $('#fsTitle').textContent = '';
    $('#btnFav').classList.remove('on');
    return;
  }
  logo.replaceWith(Object.assign(logoEl('np-logo', c), { id: 'npLogo' }));
  $('#npTitle').textContent = c.name;
  $('#fsTitle').textContent = c.name;
  document.title = `${c.name} · IP Player`;
  const meta = $('#npMeta');
  const badge = (text, cls) => {
    const b = document.createElement('span');
    b.className = `badge ${cls || ''}`;
    b.textContent = text;
    meta.appendChild(b);
    return b;
  };
  const type = detectType(c.url, c.type);
  badge(TYPE_LABEL[type], 'type');
  if (drmLabel(c.drm)) badge(drmLabel(c.drm), 'drm');
  if (c.group && c.group !== drmLabel(c.drm) && c.group !== TYPE_LABEL[type]) badge(c.group);
  $('#btnFav').classList.toggle('on', isFav(c));
  $('#btnFav').dataset.tip = isFav(c) ? 'Quitar de favoritos' : 'Añadir a favoritos';
}

/** Mueve la fila resaltada de la lista (teclado). */
function setCursor(index, scroll = true) {
  const n = state.filtered.length;
  if (!n) { state.cursor = -1; $('#channels').removeAttribute('aria-activedescendant'); return; }
  state.cursor = Math.max(0, Math.min(n - 1, index));
  if (scroll) list.scrollToIndex(state.cursor);
  else list.refresh();
  $('#channels').setAttribute('aria-activedescendant', `ch-opt-${state.cursor}`);
}

function currentIndex() {
  return state.current ? state.filtered.findIndex((c) => favKey(c) === favKey(state.current)) : -1;
}

function onListKey(e) {
  const n = state.filtered.length;
  if (!n) return;
  const inList = e.currentTarget.id === 'channels';
  const page = Math.max(1, Math.floor($('#channels').clientHeight / ROW_HEIGHT) - 1);
  const cur = state.cursor < 0 ? Math.max(0, currentIndex()) : state.cursor;
  const moves = { ArrowDown: cur + 1, ArrowUp: cur - 1 };
  if (inList) Object.assign(moves, { Home: 0, End: n - 1, PageDown: cur + page, PageUp: cur - page });
  if (e.key in moves) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowUp' && cur === 0 && inList) { $('#search').focus(); return; }
    setCursor(inList || state.cursor >= 0 ? moves[e.key] : 0);
    if (!inList) $('#channels').focus();
  } else if (e.key === 'Enter' || (e.key === ' ' && inList)) {
    e.preventDefault();
    e.stopPropagation();
    const i = state.cursor < 0 ? 0 : state.cursor;
    setCursor(i);
    play(state.filtered[i]);
  } else if (e.key === 'Escape' && inList) {
    $('#search').focus();
  }
}

function step(delta) {
  const items = state.filtered;
  if (!items.length) return;
  let idx = state.current ? items.findIndex((c) => favKey(c) === favKey(state.current)) : -1;
  idx = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
  state.cursor = idx;
  list.scrollToIndex(idx);
  play(items[idx]);
}

// ======================================================================
// Diálogo: abrir / editar stream
// ======================================================================

function openStreamDialog(channel, title) {
  state.editing = channel || null;
  $('#streamDialogTitle').textContent = title || (channel ? 'Editar stream' : 'Abrir stream');
  fillStreamForm(channel || { name: '', url: '', type: '', headers: {}, drm: emptyDrm() });
  $('#streamError').hidden = true;
  $('#fImport').value = '';
  $('#streamDialog').showModal();
  $('#fUrl').focus();
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
  syncDrmFields();
}

function syncDrmFields() {
  const sys = $('#fDrm').value;
  document.querySelectorAll('#streamForm [data-drm]').forEach((el) => {
    el.hidden = !el.dataset.drm.split(' ').includes(sys);
  });
}

function readStreamForm() {
  const url = $('#fUrl').value.trim();
  if (!url) throw new Error('Indica la URL del stream.');
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
      throw new Error('ClearKey necesita claves KID:KEY o un servidor de licencias.');
    }
  }
  if ((system === 'widevine' || system === 'playready') && !drm.licenseUrl) {
    throw new Error('Indica el servidor de licencias.');
  }
  const base = state.editing || {};
  return {
    ...base,
    id: base.id || 'manual',
    name: $('#fName').value.trim() || base.name || url,
    url,
    type: $('#fType').value,
    engine: $('#fEngine').value,
    headers: parseLineHeaders($('#fHeaders').value),
    drm,
    errors: []
  };
}

function importIntoForm() {
  let text = $('#fImport').value.trim();
  if (!text) return;
  if (!/^\s*#EXTM3U/.test(text)) text = '#EXTM3U\n' + text;
  if (!/\n\s*[^#\s][^\n]*\s*$/.test(text)) text += '\n' + ($('#fUrl').value.trim() || 'about:blank');
  const { channels } = parseM3U(text);
  if (!channels.length) {
    showFormError('streamError', 'No se encontró ninguna entrada válida.');
    return;
  }
  const c = channels[0];
  if (c.url === 'about:blank') c.url = '';
  fillStreamForm(c);
  showFormError('streamError', c.errors.length ? c.errors.join('\n') : '');
}

function showFormError(id, msg) {
  const el = $('#' + id);
  el.textContent = msg;
  el.hidden = !msg;
}

// ======================================================================
// Diálogo: listas
// ======================================================================

function renderPlaylistManager() {
  const ul = $('#plList');
  ul.replaceChildren();
  if (!state.playlists.length) {
    const li = document.createElement('li');
    li.className = 'empty-li';
    li.textContent = 'Todavía no hay listas.';
    ul.appendChild(li);
    return;
  }
  for (const pl of state.playlists) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'pl-info';
    const name = document.createElement('div');
    name.className = 'pl-name';
    name.textContent = pl.name;
    const sub = document.createElement('div');
    sub.className = 'pl-sub';
    const manual = pl.source === 'manual';
    const count = manual ? pl.channels.length : pl.text ? parseM3U(pl.text).channels.length : 0;
    const date = pl.updatedAt ? new Date(pl.updatedAt).toLocaleString() : '';
    const origin = manual ? `lista propia · ${groupsOf(pl).length} categorías` : pl.source === 'url' ? pl.url : 'local';
    sub.textContent = `${count} canales · ${origin}${date ? ' · ' + date : ''}`;
    sub.title = sub.textContent;
    info.append(name, sub);
    li.appendChild(info);

    if (pl.source === 'url') {
      const r = iconButton('#i-refresh', 'Actualizar desde la URL', async () => {
        try {
          await fetchPlaylist(pl);
          renderPlaylistManager();
          if (state.activeId === pl.id) await selectPlaylist(pl.id);
        } catch (err) { showFormError('playlistError', `Error al actualizar: ${err.message}`); }
      });
      li.appendChild(r);
    }
    if (manual) {
      li.appendChild(iconButton('#i-edit', 'Editar lista y categorías', () => openLibrary(pl.id)));
    } else {
      li.appendChild(iconButton('#i-folder-plus', 'Copiar como lista propia editable', async () => {
        try {
          const data = await listData(pl);
          const copy = await createManualList(`${pl.name} (copia)`, data);
          renderPlaylistManager();
          toast(`«${copy.name}» creada: ya puedes editarla`);
        } catch (err) { showFormError('playlistError', err.message); }
      }));
    }
    li.appendChild(exportButton(pl));
    li.appendChild(iconButton('#i-trash', 'Eliminar lista', async () => {
      if (!confirm(`¿Eliminar la lista «${pl.name}»?`)) return;
      state.playlists = state.playlists.filter((p) => p.id !== pl.id);
      await store.savePlaylists(state.playlists);
      renderPlaylistManager();
      renderPlaylistSelect();
      if (state.activeId === pl.id) await selectPlaylist(state.playlists[0]?.id || FAV_ID);
    }));
    ul.appendChild(li);
  }
}

/** Botón de descarga con elección de formato (M3U / JSON). */
function exportButton(pl) {
  const wrap = document.createElement('div');
  wrap.className = 'export-wrap';
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.hidden = true;
  for (const [fmt, label, tip] of [['m3u', 'M3U', 'Para Kodi, TiviMate, VLC…'], ['json', 'JSON', 'Para volver a importar en IP Player']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.dataset.tip = tip;
    b.addEventListener('click', async () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      try {
        exportList(await listData(pl), fmt);
        toast(`Descargando «${pl.name}» en ${label}`);
      } catch (err) { showFormError('playlistError', err.message); }
    });
    menu.appendChild(b);
  }
  const btn = iconButton('#i-download', 'Descargar en M3U o JSON', () => {
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  btn.setAttribute('aria-expanded', 'false');
  wrap.append(btn, menu);
  return wrap;
}

/** Canales de cualquier lista en formato de lista propia. */
async function listData(pl) {
  if (pl.source === 'manual') return pl;
  if (!pl.text) await fetchPlaylist(pl);
  const channels = parseM3U(pl.text, pl.url).channels.map(cleanChannel);
  return { name: pl.name, groups: groupsOf({ channels }), channels };
}

async function createManualList(name, { groups = [], channels = [] } = {}) {
  let finalName = name || `Mi lista ${state.playlists.filter((x) => x.source === 'manual').length + 1}`;
  const taken = new Set(state.playlists.map((x) => x.name));
  for (let n = 2; taken.has(finalName); n++) finalName = `${name || 'Mi lista'} (${n})`;
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
  renderPlaylistSelect();
  return pl;
}

async function saveManual(pl) {
  pl.updatedAt = new Date().toISOString();
  pl.groups = groupsOf(pl);
  await store.savePlaylists(state.playlists);
  renderPlaylistSelect();
  if (state.activeId === pl.id) {
    const keepGroup = state.group;
    await selectPlaylist(pl.id);
    if (keepGroup && [...$('#groupSelect').options].some((o) => o.value === keepGroup)) {
      state.group = keepGroup;
      $('#groupSelect').value = keepGroup;
      applyFilter();
    }
  }
}

const manualLists = () => state.playlists.filter((p) => p.source === 'manual');

// ---------- Guardar en lista ----------

let saveChannel = null;

function openSaveDialog(channel, { listId } = {}) {
  saveChannel = channel;
  const sel = $('#sList');
  sel.replaceChildren();
  for (const pl of manualLists()) sel.add(new Option(pl.name, pl.id));
  sel.add(new Option('＋ Nueva lista…', '__new__'));
  const has = (id) => id && manualLists().some((p) => p.id === id);
  sel.value = has(listId) ? listId : has(state.activeId) ? state.activeId : manualLists()[0]?.id || '__new__';
  $('#sName').value = channel.name && channel.name !== channel.url ? channel.name : nameFromUrl(channel.url) || channel.url;
  $('#sGroup').value = channel.group || '';
  $('#sNewName').value = '';
  showFormError('saveError', '');
  syncSaveDialog();
  $('#saveDialog').showModal();
  $('#sName').select();
}

function syncSaveDialog() {
  const isNew = $('#sList').value === '__new__';
  $('#sNewWrap').hidden = !isNew;
  const pl = manualLists().find((p) => p.id === $('#sList').value);
  $('#sGroups').replaceChildren(...(pl ? groupsOf(pl) : []).map((g) => new Option(g)));
}

async function onSaveSubmit(e) {
  if (e.submitter?.value !== 'save' || !saveChannel) return;
  e.preventDefault();
  try {
    let pl = manualLists().find((p) => p.id === $('#sList').value);
    if (!pl) pl = await createManualList($('#sNewName').value.trim());
    const group = $('#sGroup').value.trim();
    const ch = cleanChannel({ ...saveChannel, name: $('#sName').value.trim() || saveChannel.name, group });
    if (group && !pl.groups.includes(group)) pl.groups.push(group);
    pl.channels.push(ch);
    await saveManual(pl);
    $('#saveDialog').close();
    if ($('#streamDialog').open && state.libEdit?.add) $('#streamDialog').close();
    if ($('#libDialog').open && state.libId === pl.id) renderLibrary();
    toast(`Guardado en «${pl.name}»${group ? ' · ' + group : ''}`);
  } catch (err) {
    showFormError('saveError', err.message);
  }
}

// ---------- Editor de lista propia ----------

function openLibrary(id) {
  const pl = manualLists().find((p) => p.id === id);
  if (!pl) return;
  state.libId = id;
  $('#libName').value = pl.name;
  $('#libNewGroup').value = '';
  renderLibrary();
  if (!$('#libDialog').open) $('#libDialog').showModal();
}

function libList() { return manualLists().find((p) => p.id === state.libId); }

function renderLibrary() {
  const pl = libList();
  const box = $('#libGroups');
  box.replaceChildren();
  if (!pl) return;
  const groups = groupsOf(pl);
  const sections = [...groups, ...(pl.channels.some((c) => !c.group) || !groups.length ? [''] : [])];
  $('#libCount').textContent = `${pl.channels.length} canales · ${groups.length} categorías`;

  for (const g of sections) {
    const sec = document.createElement('section');
    sec.className = 'lib-group';
    const head = document.createElement('div');
    head.className = 'lib-group-head';
    const items = pl.channels.map((c, i) => ({ c, i })).filter(({ c }) => (c.group || '') === g);
    if (g) {
      const name = document.createElement('input');
      name.className = 'lib-group-name';
      name.value = g;
      name.setAttribute('aria-label', 'Nombre de la categoría');
      name.dataset.tip = 'Escribe para renombrar la categoría';
      name.addEventListener('change', async () => {
        const nv = name.value.trim();
        if (!nv || nv === g) { name.value = g; return; }
        if (groups.includes(nv)) { toast('Ya existe una categoría con ese nombre'); name.value = g; return; }
        pl.groups = pl.groups.map((x) => (x === g ? nv : x));
        pl.channels.forEach((c) => { if (c.group === g) c.group = nv; });
        await saveManual(pl);
        renderLibrary();
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
      head.appendChild(name);
    } else {
      const t = document.createElement('span');
      t.className = 'lib-group-name static';
      t.textContent = 'Sin categoría';
      head.appendChild(t);
    }
    const count = document.createElement('span');
    count.className = 'lib-group-count';
    count.textContent = items.length;
    head.appendChild(count);
    if (g) {
      head.appendChild(iconButton('#i-trash', 'Eliminar categoría (los canales pasan a «Sin categoría»)', async () => {
        if (items.length && !confirm(`¿Eliminar la categoría «${g}»? Sus ${items.length} canales pasarán a «Sin categoría».`)) return;
        pl.groups = pl.groups.filter((x) => x !== g);
        pl.channels.forEach((c) => { if (c.group === g) c.group = ''; });
        await saveManual(pl);
        renderLibrary();
      }));
    }
    sec.appendChild(head);

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'lib-empty';
      empty.textContent = g
        ? 'Sin canales. Muévelos aquí con el selector de categoría de cada canal.'
        : 'Esta lista está vacía. Pulsa «Añadir canal» o guarda canales desde otras listas con el botón de carpeta.';
      sec.appendChild(empty);
    }
    items.forEach(({ c, i }, pos) => sec.appendChild(libRow(pl, c, i, sections, pos, items)));
    box.appendChild(sec);
  }
}

function libRow(pl, c, i, sections, pos, items) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  const info = document.createElement('div');
  info.className = 'lib-info';
  const name = document.createElement('div');
  name.className = 'lib-name';
  name.textContent = c.name;
  const sub = document.createElement('div');
  sub.className = 'lib-sub';
  const type = detectType(c.url, c.type);
  sub.textContent = [type !== 'auto' ? TYPE_LABEL[type] : '', drmLabel(c.drm), shortUrl(c.url)].filter(Boolean).join(' · ');
  sub.title = c.url;
  info.append(name, sub);

  const cat = document.createElement('select');
  cat.className = 'lib-cat';
  cat.setAttribute('aria-label', `Categoría de ${c.name}`);
  cat.dataset.tip = 'Mover a otra categoría';
  for (const g of sections.filter(Boolean)) cat.add(new Option(g, g));
  cat.add(new Option('Sin categoría', ''));
  cat.value = c.group || '';
  cat.addEventListener('change', async () => {
    c.group = cat.value;
    await saveManual(pl);
    renderLibrary();
  });

  const actions = document.createElement('div');
  actions.className = 'lib-actions';
  const move = async (dir) => {
    const other = items[pos + dir];
    if (!other) return;
    [pl.channels[i], pl.channels[other.i]] = [pl.channels[other.i], pl.channels[i]];
    await saveManual(pl);
    renderLibrary();
    // Mantiene el foco en el canal movido para poder seguir moviéndolo con el teclado.
    $(`#libGroups .lib-row[data-idx="${other.i}"] [data-move="${dir < 0 ? 'up' : 'down'}"]`)?.focus();
  };
  const up = iconButton('#i-up', 'Subir', () => move(-1));
  up.dataset.move = 'up';
  up.disabled = pos === 0;
  const down = iconButton('#i-down', 'Bajar', () => move(1));
  down.dataset.move = 'down';
  down.disabled = pos === items.length - 1;
  actions.append(
    iconButton('#i-play', 'Reproducir', () => { $('#libDialog').close(); play({ ...c, id: `lib${i}`, errors: [] }); }),
    up,
    down,
    iconButton('#i-edit', 'Editar canal (URL, DRM, cabeceras)', () => {
      openStreamDialog({ ...c, id: `lib${i}`, errors: [] }, 'Editar canal');
      state.libEdit = { listId: pl.id, index: i };
      $('#btnStreamSave').textContent = 'Guardar cambios';
      $('#btnStreamSave').hidden = false;
    }),
    iconButton('#i-trash', 'Eliminar canal', async () => {
      const [removed] = pl.channels.splice(i, 1);
      await saveManual(pl);
      renderLibrary();
      toast(`«${removed.name}» eliminado`, {
        label: 'Deshacer',
        fn: async () => {
          pl.channels.splice(i, 0, removed);
          await saveManual(pl);
          if ($('#libDialog').open) renderLibrary();
        }
      });
    })
  );
  row.dataset.idx = String(i);
  row.append(logoEl('lib-logo', c), info, cat, actions);
  return row;
}

async function onStreamSave() {
  const target = state.libEdit;
  const pl = target && manualLists().find((p) => p.id === target.listId);
  if (!pl) return;
  try {
    const ch = readStreamForm();
    if (target.add) {
      pl.channels.push(cleanChannel({ ...ch, group: '' }));
      toast(`Añadido a «${pl.name}»`);
    } else {
      const old = pl.channels[target.index];
      pl.channels[target.index] = cleanChannel({ ...ch, group: old?.group || '' });
      toast('Canal actualizado');
    }
    await saveManual(pl);
    $('#streamDialog').close();
    if ($('#libDialog').open) renderLibrary();
  } catch (err) {
    showFormError('streamError', err.message);
  }
}

function iconButton(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.dataset.tip = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = `<svg><use href="${icon}"/></svg>`;
  b.addEventListener('click', onClick);
  return b;
}

async function addPlaylist({ name, url, text }) {
  const lib = text ? parseLibraryJSON(text) : null;
  if (lib) {
    const created = await createManualList(name || lib.name || 'Lista importada', lib);
    await selectPlaylist(created.id);
    toast(`«${created.name}» importada: ${created.channels.length} canales`);
    return created;
  }
  const pl = { id: store.newId(), name: '', source: url ? 'url' : 'text', url: url || '', text: text || '', updatedAt: '' };
  if (url) {
    await fetchPlaylist(pl);
  } else {
    pl.updatedAt = new Date().toISOString();
  }
  if (looksLikeHlsManifest(pl.text)) {
    throw new Error('Esto parece un stream HLS, no una lista de canales. Ábrelo con «Abrir stream».');
  }
  const { channels } = parseM3U(pl.text, pl.url);
  if (!channels.length) throw new Error('La lista no contiene canales.');
  pl.name = name || nameFromUrl(url) || `Lista ${state.playlists.length + 1}`;
  state.playlists.push(pl);
  await store.savePlaylists(state.playlists);
  renderPlaylistSelect();
  await selectPlaylist(pl.id);
  toast(`«${pl.name}» añadida: ${channels.length} canales`);
  return pl;
}

function nameFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.(m3u8?|txt)$/i, '');
    return file || u.host;
  } catch (_) { return ''; }
}

async function onAddPlaylistClick() {
  showFormError('playlistError', '');
  const name = $('#pName').value.trim();
  const url = $('#pUrl').value.trim();
  const file = $('#pFile').files[0];
  let text = $('#pText').value.trim();
  try {
    if (file) {
      text = await file.text();
      await addPlaylist({ name: name || (parseLibraryJSON(text) ? '' : file.name.replace(/\.(m3u8?|txt|json)$/i, '')), text });
    } else if (text) {
      await addPlaylist({ name, text });
    } else if (url) {
      await addPlaylist({ name, url });
    } else {
      throw new Error('Indica una URL, un archivo o pega el contenido de la lista.');
    }
    $('#playlistForm').reset();
    renderPlaylistManager();
  } catch (err) {
    showFormError('playlistError', err.message);
  }
}

// ======================================================================
// UI general
// ======================================================================

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.title = text;
  el.className = 'status ' + kind;
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
  const el = $('#toast');
  el.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.dataset.show = ''; action.fn(); });
    el.appendChild(b);
  }
  el.dataset.action = action ? '1' : '';
  // Popover: queda por encima de cualquier diálogo abierto.
  try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); } catch (_) { /* sin soporte */ }
  el.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = ''; }, action ? 5000 : 2200);
}

// ---------- Ayuda ----------

const TOUR_STEPS = [
  { title: 'Bienvenido a IP Player', text: 'Reproduce listas de canales M3U y enlaces DASH, HLS o Smooth Streaming. Te enseño lo básico en cuatro pasos. Puedes salir cuando quieras con Esc.' },
  { target: '#btnPlaylists', title: '1. Añade una lista', text: 'Pulsa aquí para añadir tu lista M3U por enlace, archivo o pegando el texto. Si solo quieres probar, usa «Lista de ejemplo».' },
  { target: '#btnOpenStream', title: 'O abre un enlace suelto', text: 'Para reproducir un solo vídeo sin lista. Aquí también puedes indicar claves o cabeceras si el enlace las necesita.' },
  { target: '.filters', title: '2. Busca tu canal', text: 'Elige lista y grupo, o escribe para buscar. Atajo: tecla / para buscar, flechas ↑ ↓ para moverte e Intro para reproducir.' },
  { target: '#channels', title: '3. Elige un canal', text: 'Haz clic en un canal para verlo. La estrella lo guarda en Favoritos.' },
  { target: '#player', title: '4. Controla la reproducción', text: 'Mueve el ratón sobre el vídeo para ver los controles. El engranaje cambia calidad, idioma y subtítulos. Doble clic: pantalla completa.' },
  { target: '#btnHelp', title: '¿Dudas?', text: 'Aquí tienes esta guía, los atajos de teclado, preguntas frecuentes y la opción de texto más grande.' }
];

function openTour() {
  if ($('#helpDialog').open) $('#helpDialog').close();
  hideTooltip();
  // En escritorio, la guía necesita ver el panel lateral.
  if ($('#app').dataset.collapsed === '1') setSidebarCollapsed(false);
  startTour(TOUR_STEPS, { onDone: () => store.patchState({ tourDone: true }) });
}

function openHelp() {
  hideTooltip();
  if (!$('#helpDialog').open) $('#helpDialog').showModal();
}

async function applyUiPrefs(patch) {
  const ui = { largeText: false, tips: true, ...(await store.get('ui', {})), ...(patch || {}) };
  if (patch) await store.set('ui', ui);
  document.documentElement.dataset.large = ui.largeText ? '1' : '';
  setTooltipsEnabled(ui.tips);
  $('#optLarge').checked = ui.largeText;
  $('#optTips').checked = ui.tips;
  list?.refresh();
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
      return controls.osd(v.muted || !v.volume ? 'Silenciado' : `Sonido ${pct} %`, { icon: v.muted || !v.volume ? 'i-mute' : 'i-vol' });
    case 'ArrowLeft':
      return controls.osd('−10 s');
    case 'ArrowRight':
      return controls.osd('+10 s');
    case 'c': {
      const a = engine === 'dashjs' ? dashEngine : shakaAdapter;
      const t = a?.textTracks?.().find((x) => x.active);
      return controls.osd(t ? `Subtítulos: ${langName(t.lang) || t.label || 'activados'}` : 'Subtítulos desactivados', { icon: 'i-cc' });
    }
    default:
      return null;
  }
}

function setSidebarCollapsed(collapsed) {
  $('#app').dataset.collapsed = collapsed ? '1' : '';
  store.patchState({ sidebarCollapsed: collapsed });
}

function bindEvents() {
  $('#playlistSelect').addEventListener('change', (e) => selectPlaylist(e.target.value));
  $('#groupSelect').addEventListener('change', (e) => {
    state.group = e.target.value;
    applyFilter();
    store.patchState({ group: state.group });
  });
  let searchTimer = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; applyFilter(); }, 120);
  });

  $('#btnOpenStream').addEventListener('click', () => openStreamDialog(null));
  $('#btnPlaylists').addEventListener('click', () => { renderPlaylistManager(); showFormError('playlistError', ''); $('#playlistDialog').showModal(); });
  $('#btnEmptyAdd').addEventListener('click', () => $('#btnPlaylists').click());
  $('#btnEmptySample').addEventListener('click', async () => {
    try {
      const text = await (await fetch(chrome.runtime.getURL('sample/ejemplos.m3u'))).text();
      await addPlaylist({ name: 'Ejemplos (DASH · HLS · MSS · DRM)', text });
      toast('Lista de ejemplo añadida');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btnEmptyTour').addEventListener('click', openTour);

  // Listas propias
  $('#btnCreateList').addEventListener('click', async () => {
    const pl = await createManualList($('#pNewName').value.trim());
    $('#pNewName').value = '';
    renderPlaylistManager();
    $('#playlistDialog').close();
    await selectPlaylist(pl.id);
    openLibrary(pl.id);
  });
  $('#pNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btnCreateList').click(); } });
  $('#btnAddTo').addEventListener('click', () => {
    if (!state.current) { toast('Primero reproduce o abre un canal'); return; }
    openSaveDialog(state.current);
  });
  $('#btnStreamSaveTo').addEventListener('click', () => {
    try { openSaveDialog(readStreamForm(), { listId: state.libEdit?.listId }); } catch (err) { showFormError('streamError', err.message); }
  });
  $('#btnStreamSave').addEventListener('click', onStreamSave);
  $('#streamDialog').addEventListener('close', () => { state.libEdit = null; $('#btnStreamSave').hidden = true; });
  $('#sList').addEventListener('change', syncSaveDialog);
  $('#saveForm').addEventListener('submit', onSaveSubmit);
  $('#libName').addEventListener('change', async () => {
    const pl = libList();
    const v = $('#libName').value.trim();
    if (!pl || !v) { $('#libName').value = pl?.name || ''; return; }
    pl.name = v;
    await saveManual(pl);
  });
  $('#libName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  const addGroup = async () => {
    const pl = libList();
    const g = $('#libNewGroup').value.trim();
    if (!pl || !g) return;
    if (groupsOf(pl).includes(g)) { toast('Esa categoría ya existe'); return; }
    pl.groups.push(g);
    $('#libNewGroup').value = '';
    await saveManual(pl);
    renderLibrary();
  };
  $('#btnLibAddGroup').addEventListener('click', addGroup);
  $('#libNewGroup').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } });
  $('#btnLibAddChannel').addEventListener('click', () => {
    const pl = libList();
    if (!pl) return;
    openStreamDialog(null, `Añadir canal a «${pl.name}»`);
    state.libEdit = { listId: pl.id, add: true };
    $('#btnStreamSave').textContent = 'Añadir a la lista';
    $('#btnStreamSave').hidden = false;
  });
  $('#libDialog').addEventListener('click', (e) => {
    const fmt = e.target.closest('[data-export]')?.dataset.export;
    if (!fmt) return;
    const pl = libList();
    if (pl) { exportList(pl, fmt); toast(`Descargando «${pl.name}» en ${fmt.toUpperCase()}`); }
  });

  // Ayuda y accesibilidad
  $('#btnHelp').addEventListener('click', openHelp);
  $('#btnStartTour').addEventListener('click', openTour);
  $('#optLarge').addEventListener('change', (e) => applyUiPrefs({ largeText: e.target.checked }));
  $('#optTips').addEventListener('change', (e) => applyUiPrefs({ tips: e.target.checked }));

  // Mensaje de error: reintentar o revisar el stream
  $('#btnRetry').addEventListener('click', () => state.current && play(state.current));
  $('#btnFixStream').addEventListener('click', () => state.current && openStreamDialog(state.current, 'Revisar stream'));

  // Lista con teclado
  $('#search').addEventListener('keydown', onListKey);
  $('#channels').addEventListener('keydown', onListKey);
  $('#channels').addEventListener('focus', () => {
    if (state.cursor < 0 && state.filtered.length) setCursor(Math.max(0, currentIndex()));
  });

  // Detección del tipo mientras se escribe la URL
  const urlHint = $('#fUrlHint');
  const urlHintDefault = urlHint.textContent;
  const updateUrlHint = () => {
    const u = $('#fUrl').value.trim();
    if (!u) { urlHint.textContent = urlHintDefault; urlHint.dataset.kind = ''; return; }
    if (!/^https?:\/\//i.test(u)) {
      urlHint.textContent = 'La URL debe empezar por http:// o https://';
      urlHint.dataset.kind = 'warn';
      return;
    }
    const t = detectType(u, $('#fType').value);
    urlHint.textContent = t === 'auto'
      ? 'Formato no reconocido por la URL: se intentará detectar al reproducir.'
      : `Formato detectado: ${TYPE_LABEL[t]}`;
    urlHint.dataset.kind = t === 'auto' ? '' : 'ok';
  };
  $('#fUrl').addEventListener('input', updateUrlHint);
  $('#fType').addEventListener('change', updateUrlHint);
  $('#streamDialog').addEventListener('toggle', (e) => { if (e.newState === 'open') updateUrlHint(); });

  $('#btnSidebar').addEventListener('click', () => setSidebarCollapsed($('#app').dataset.collapsed !== '1'));
  $('#btnFav').addEventListener('click', () => state.current && toggleFavorite(state.current));
  $('#btnEdit').addEventListener('click', () => openStreamDialog(state.current, state.current ? 'Editar stream' : 'Abrir stream'));
  $('#btnCopy').addEventListener('click', async () => {
    if (!state.current) return;
    await navigator.clipboard.writeText(state.current.url);
    toast('URL copiada');
  });

  // Diálogo de stream
  $('#fDrm').addEventListener('change', syncDrmFields);
  $('#btnImportParse').addEventListener('click', importIntoForm);
  $('#streamForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'play') return;
    try {
      const ch = readStreamForm();
      play(ch);
    } catch (err) {
      e.preventDefault();
      showFormError('streamError', err.message);
    }
  });
  $('#btnStreamFav').addEventListener('click', async () => {
    try {
      const ch = readStreamForm();
      if (!isFav(ch)) await toggleFavorite(ch);
      else toast('Ya está en favoritos');
    } catch (err) {
      showFormError('streamError', err.message);
    }
  });

  // Diálogo de listas
  $('#btnAddPlaylist').addEventListener('click', onAddPlaylistClick);
  $('#btnSample').addEventListener('click', async () => {
    showFormError('playlistError', '');
    try {
      const text = await (await fetch(chrome.runtime.getURL('sample/ejemplos.m3u'))).text();
      await addPlaylist({ name: 'Ejemplos (DASH · HLS · MSS · DRM)', text });
      renderPlaylistManager();
    } catch (err) {
      showFormError('playlistError', err.message);
    }
  });

  // Atajos de teclado (sin animaciones: se repiten mucho)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTourOpen()) return;
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
      l: () => setSidebarCollapsed($('#app').dataset.collapsed !== '1'),
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
      if (controls.enabled) osdFor(key);
    }
  });
}

// ======================================================================
// Arranque
// ======================================================================

async function main() {
  list = new VirtualList($('#channels'), { rowHeight: ROW_HEIGHT, render: renderRow });
  initTooltips();
  bindEvents();
  applyUiPrefs();
  prefs = { ...prefs, ...(await store.getPrefs()) };
  await initPlayer();
  await loadData();

  const saved = await store.getState();
  if (saved.sidebarCollapsed) $('#app').dataset.collapsed = '1';
  state.activeId = saved.playlistId && (saved.playlistId === FAV_ID || state.playlists.some((p) => p.id === saved.playlistId))
    ? saved.playlistId
    : (state.playlists[0]?.id || FAV_ID);
  renderPlaylistSelect();
  await selectPlaylist(state.activeId);
  if (saved.group && state.channels.some((c) => (c.group || '\u0000') === saved.group)) {
    state.group = saved.group;
    $('#groupSelect').value = saved.group;
    applyFilter();
  }
  if (saved.channelUrl) {
    const idx = state.filtered.findIndex((c) => c.url === saved.channelUrl);
    if (idx >= 0) list.scrollToIndex(idx);
  }

  // Parámetros desde el menú contextual
  const params = new URLSearchParams(location.search);
  if (params.get('playlist')) {
    try {
      await addPlaylist({ url: params.get('playlist') });
    } catch (err) {
      setStatus(`No se pudo cargar la lista: ${err.message}`, 'err');
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
  setStatus(`Error al iniciar: ${err.message}`, 'err');
});
