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
import { Controls } from './controls.js';

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
  editing: null
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
    if (err?.code === MSS_LIVE_NOT_SUPPORTED && channel.engine !== 'shaka' && DashEngine.isAvailable()) {
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
  if (!DashEngine.isAvailable()) {
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
    return { title: 'Error', text: String(err?.message || err) };
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
    case C.VIDEO_ERROR:
      return {
        title: 'Error de decodificación',
        text: 'El vídeo no se pudo decodificar.' + (state.current?.drm?.system === 'clearkey' ? '\n¿Son correctas las claves ClearKey (KID:KEY)?' : '')
      };
    default:
      return { title: `Error ${err.code}`, text: `${name}${inner ? ` (${inner.code})` : ''}` };
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
  for (const pl of state.playlists) sel.add(new Option(pl.name, pl.id));
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
  row.className = 'ch' + (state.current && favKey(state.current) === favKey(channel) ? ' active' : '');
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
  fav.title = 'Favorito';
  fav.innerHTML = '<svg><use href="#i-star"/></svg>';
  fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(channel); });

  row.append(num, logoEl('ch-logo', channel), text, fav);
  row.addEventListener('click', () => play(channel));
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
}

function step(delta) {
  const items = state.filtered;
  if (!items.length) return;
  let idx = state.current ? items.findIndex((c) => favKey(c) === favKey(state.current)) : -1;
  idx = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
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
    const count = pl.text ? parseM3U(pl.text).channels.length : 0;
    const date = pl.updatedAt ? new Date(pl.updatedAt).toLocaleString() : '';
    sub.textContent = `${count} canales · ${pl.source === 'url' ? pl.url : 'local'}${date ? ' · ' + date : ''}`;
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

function iconButton(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = title;
  b.innerHTML = `<svg><use href="${icon}"/></svg>`;
  b.addEventListener('click', onClick);
  return b;
}

async function addPlaylist({ name, url, text }) {
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
      await addPlaylist({ name: name || file.name.replace(/\.(m3u8?|txt)$/i, ''), text });
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
  $('#overlay').hidden = false;
}

function hideOverlay() { $('#overlay').hidden = true; }

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.show = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = ''; }, 2200);
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
      ArrowLeft: () => (onButton ? false : controls.seekBy(-10)),
      ArrowRight: () => (onButton ? false : controls.seekBy(10)),
      ArrowUp: () => controls.nudgeVolume(0.05),
      ArrowDown: () => controls.nudgeVolume(-0.05)
    };
    const fn = actions[key];
    if (fn && fn() !== false) {
      e.preventDefault();
      controls.wake();
    }
  });
}

// ======================================================================
// Arranque
// ======================================================================

async function main() {
  list = new VirtualList($('#channels'), { rowHeight: ROW_HEIGHT, render: renderRow });
  bindEvents();
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
}

main().catch((err) => {
  console.error(err);
  setStatus(`Error al iniciar: ${err.message}`, 'err');
});
