// Listas propias: conversión a M3U / JSON, importación y descarga.
//
// Lista propia guardada en chrome.storage.local (dentro de "playlists"):
//   { id, name, source: 'manual', groups: [nombre], channels: [Canal], updatedAt }
// Canal (sin estado de reproducción):
//   { name, url, group, logo, tvgId, chno, type, engine, headers, drm }
//
// El M3U exportado usa las etiquetas que entiende el propio parser (y Kodi/TiviMate):
// #EXTINF con tvg-*, group-title; #KODIPROP para DRM y tipo; #EXTVLCOPT / #EXTHTTP para cabeceras.

import { emptyDrm } from './drm.js';
import { t } from './i18n.js';

export const JSON_FORMAT = 'ip-player-playlist';

/** Copia limpia de un canal: solo los campos que definen cómo reproducirlo. */
export function cleanChannel(c) {
  const drm = { ...emptyDrm(), ...(c.drm || {}) };
  return {
    name: String(c.name || c.url || '').trim(),
    url: String(c.url || '').trim(),
    group: String(c.group || '').trim(),
    logo: c.logo || '',
    tvgId: c.tvgId || '',
    chno: c.chno || '',
    type: c.type || '',
    engine: c.engine || '',
    headers: { ...(c.headers || {}) },
    catchup: c.catchup && (c.catchup.mode || c.catchup.source || c.catchup.days) ? { mode: c.catchup.mode || '', source: c.catchup.source || '', days: Number(c.catchup.days) || 0 } : undefined,
    proxy: c.proxy && c.proxy.mode && c.proxy.mode !== 'global' ? { mode: c.proxy.mode, url: String(c.proxy.url || '') } : undefined,
    drm: {
      system: drm.system || 'none',
      licenseUrl: drm.licenseUrl || '',
      licenseHeaders: { ...(drm.licenseHeaders || {}) },
      keys: { ...(drm.keys || {}) },
      bodyTemplate: drm.bodyTemplate || '',
      responseTemplate: drm.responseTemplate || ''
    }
  };
}

/** Categorías en orden: las declaradas y después las que solo aparecen en canales. */
export function groupsOf(list) {
  const out = [...(list.groups || [])];
  for (const c of list.channels || []) if (c.group && !out.includes(c.group)) out.push(c.group);
  return out;
}

const KODI_SYSTEM = { clearkey: 'clearkey', widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready' };
const MANIFEST = { dash: 'mpd', hls: 'hls', mss: 'ism' };
const VLC = { 'User-Agent': 'http-user-agent', Referer: 'http-referrer', Origin: 'http-origin', Cookie: 'http-cookie' };

const attr = (v) => String(v).replace(/"/g, "'");
const query = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** Genera un M3U con toda la configuración de cada canal. */
export function toM3U(list) {
  const lines = [list.epg ? `#EXTM3U url-tvg="${attr(list.epg)}"` : '#EXTM3U'];
  for (const raw of list.channels || []) {
    const c = cleanChannel(raw);
    if (!c.url) continue;
    lines.push('');
    const a = [];
    if (c.tvgId) a.push(`tvg-id="${attr(c.tvgId)}"`);
    a.push(`tvg-name="${attr(c.name)}"`);
    if (c.logo) a.push(`tvg-logo="${attr(c.logo)}"`);
    if (c.chno) a.push(`tvg-chno="${attr(c.chno)}"`);
    if (c.group) a.push(`group-title="${attr(c.group)}"`);
    if (c.catchup?.mode) a.push(`catchup="${attr(c.catchup.mode)}"`);
    if (c.catchup?.source) a.push(`catchup-source="${attr(c.catchup.source)}"`);
    if (c.catchup?.days) a.push(`catchup-days="${c.catchup.days}"`);
    lines.push(`#EXTINF:-1 ${a.join(' ')},${c.name.replace(/[\r\n]+/g, ' ')}`);

    if (MANIFEST[c.type]) lines.push(`#KODIPROP:inputstream.adaptive.manifest_type=${MANIFEST[c.type]}`);
    if (c.engine) lines.push(`#KODIPROP:ipplayer.engine=${c.engine}`);

    const d = c.drm;
    if (d.system && d.system !== 'none') {
      lines.push('#KODIPROP:inputstream.adaptive.license_type=' + KODI_SYSTEM[d.system]);
      const keys = Object.entries(d.keys);
      if (keys.length) {
        lines.push('#KODIPROP:inputstream.adaptive.license_key=' + keys.map(([k, v]) => `${k}:${v}`).join(','));
      } else if (d.licenseUrl) {
        const parts = [d.licenseUrl, query(d.licenseHeaders), d.bodyTemplate, d.responseTemplate];
        while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
        lines.push('#KODIPROP:inputstream.adaptive.license_key=' + parts.join('|'));
      }
    }

    const extra = {};
    for (const [k, v] of Object.entries(c.headers)) {
      if (VLC[k]) lines.push(`#EXTVLCOPT:${VLC[k]}=${v}`);
      else extra[k] = v;
    }
    if (Object.keys(extra).length) lines.push(`#EXTHTTP:${JSON.stringify(extra)}`);
    if (c.proxy?.mode === 'custom' && c.proxy.url) lines.push(`#EXTVLCOPT:http-proxy=${c.proxy.url}`);
    lines.push(c.url);
  }
  return lines.join('\n') + '\n';
}

/** JSON de IP Player: se reimporta como lista editable, con todo configurado. */
export function toJSON(list) {
  return JSON.stringify({
    format: JSON_FORMAT,
    version: 1,
    name: list.name,
    epg: list.epg || '',
    exportedAt: new Date().toISOString(),
    groups: groupsOf(list),
    channels: (list.channels || []).map(cleanChannel)
  }, null, 2);
}

/**
 * Reconoce un JSON exportado (o un array de canales).
 * @returns {{name:string, groups:string[], channels:object[]}|null}
 */
export function parseLibraryJSON(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  let data;
  try { data = JSON.parse(t); } catch (_) { return null; }
  const channels = Array.isArray(data) ? data : data.channels;
  if (!Array.isArray(channels)) return null;
  const clean = channels.filter((c) => c && c.url).map(cleanChannel);
  if (!clean.length) throw new Error(t('El JSON no contiene canales con URL.'));
  const list = { name: Array.isArray(data) ? '' : String(data.name || ''), epg: data.epg ? String(data.epg) : '', groups: [], channels: clean };
  list.groups = Array.isArray(data.groups) ? data.groups.map(String) : [];
  list.groups = groupsOf(list);
  return list;
}

export function safeFileName(name) {
  return (String(name || 'lista').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'lista').slice(0, 60);
}

/** Descarga un texto como archivo. */
export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportList(list, format) {
  const base = safeFileName(list.name);
  if (format === 'json') download(`${base}.json`, toJSON(list), 'application/json');
  else download(`${base}.m3u`, toM3U(list), 'audio/x-mpegurl');
}
