// Receptores Enigma2 con OpenWebIF (Vu+, Dreambox, Octagon, Zgemma, GigaBlue…).
// Lee los bouquets y sus canales con la API JSON (/api/bouquets, /api/getservices),
// genera una lista M3U con los streams MPEG-TS del receptor (puerto 8001, o 8002 para
// transcodificar a H.264) y construye la Guía TV con /api/epgmulti.

import { t } from './i18n.js';

export const DEFAULT_STREAM_PORT = 8001;
export const TRANSCODE_PORT = 8002;
const EPG_HOURS = 30;

/**
 * Normaliza lo que escribe el usuario: «192.168.1.10», «http://user:pass@box:80/»…
 * @returns {{ base: string, host: string, protocol: string, user: string, pass: string }}
 */
export function parseBoxAddress(input, user = '', pass = '') {
  let raw = String(input || '').trim();
  if (!raw) throw new Error(t('Escribe la dirección del receptor (p. ej. 192.168.1.10).'));
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error(t('Dirección del receptor no válida.')); }
  const box = {
    base: u.origin,
    host: u.hostname,
    protocol: u.protocol,
    user: user || decodeURIComponent(u.username || ''),
    pass: pass || decodeURIComponent(u.password || '')
  };
  return box;
}

export function authHeader(box) {
  return box.user ? 'Basic ' + btoa(`${box.user}:${box.pass || ''}`) : '';
}

async function api(box, path, { timeout = 15000 } = {}) {
  const headers = { Accept: 'application/json' };
  const auth = authHeader(box);
  if (auth) headers.Authorization = auth;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(box.base + path, { headers, cache: 'no-store', signal: ctrl.signal, credentials: 'omit' });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(t('El receptor no responde ({host}).', { host: box.host }));
    throw new Error(t('No se pudo conectar con el receptor {host}. ¿Está encendido y en la misma red?', { host: box.host }));
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new Error(t('El receptor pide usuario y contraseña (o no son correctos).'));
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) {
    throw new Error(t('{host} no parece un receptor con OpenWebIF (la API no devuelve JSON).', { host: box.host }));
  }
}

/** Datos del receptor (modelo, imagen). Sirve también para comprobar la conexión. */
export async function aboutBox(box) {
  const data = await api(box, '/api/about', { timeout: 8000 });
  const info = data.info || {};
  const name = [info.brand, info.model].filter(Boolean).join(' ') || info.boxtype || box.host;
  return { name, image: [info.friendlyimagedistro || info.imagedistro, info.imagever].filter(Boolean).join(' ') };
}

// ---------- Referencias de servicio (sref) ----------

function srefFields(sref) {
  return String(sref || '').split(':');
}

/** Marcadores (separadores), carpetas y ocultos no son canales reproducibles. */
function isPlayable(sref) {
  const f = srefFields(sref);
  if (f.length < 10) return false;
  const flags = parseInt(f[1], 10) || 0;
  return !(flags & (0x01 | 0x40 | 0x200));
}

const isMarker = (sref) => ((parseInt(srefFields(sref)[1], 10) || 0) & 0x40) !== 0;

/** Clave estable para unir canal y EPG: sin «:» finales y en mayúsculas. */
export function srefKey(sref) {
  return srefFields(sref).slice(0, 10).join(':').toUpperCase();
}

/** URL de un stream IPTV metido en el bouquet (campo 11 de la sref, codificado). */
function embeddedUrl(sref) {
  const f = srefFields(sref);
  if (f.length > 10 && /^https?%3a/i.test(f[10])) {
    try { return decodeURIComponent(f[10]); } catch (_) { return ''; }
  }
  return '';
}

function piconUrl(box, sref, given) {
  if (given) return /^https?:/i.test(given) ? given : box.base + (given.startsWith('/') ? '' : '/') + given;
  const name = srefFields(sref).slice(0, 10).join('_').toUpperCase();
  return `${box.base}/picon/${name}.png`;
}

function streamUrl(box, sref, { transcode, streamPort }) {
  const port = transcode ? TRANSCODE_PORT : (streamPort || DEFAULT_STREAM_PORT);
  const host = box.host.includes(':') ? `[${box.host}]` : box.host;
  // La sref va tal cual (con «:»), como en los M3U que genera el propio OpenWebIF.
  return `${box.protocol}//${host}:${port}/${srefFields(sref).slice(0, 10).join(':')}:`;
}

// ---------- Bouquets → canales ----------

/** Lista de bouquets: [{ ref, name }]. */
export async function listBouquets(box, { radio = false } = {}) {
  const data = await api(box, `/api/bouquets?stype=${radio ? 'radio' : 'tv'}`);
  return (data.bouquets || []).map(([ref, name]) => ({ ref, name: String(name || '').trim() || t('Bouquet') }));
}

async function bouquetServices(box, ref) {
  const data = await api(box, `/api/getservices?sRef=${encodeURIComponent(ref)}&picon=1`, { timeout: 30000 });
  return data.services || [];
}

/** Ejecuta fn sobre items con como mucho `n` peticiones simultáneas. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (err) { out[k] = { error: err }; }
    }
  }));
  return out;
}

const q = (s) => String(s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');

/**
 * Genera el texto M3U de un receptor.
 * @param {object} box { base, host, protocol, user, pass }
 * @param {object} opts { transcode, streamPort, radio, bouquets?: string[] (refs elegidas) }
 * @returns {Promise<{ text: string, count: number, bouquets: {ref,name}[] }>}
 */
export async function buildBoxPlaylist(box, opts = {}) {
  let bouquets = await listBouquets(box, opts);
  if (opts.bouquets?.length) bouquets = bouquets.filter((b) => opts.bouquets.includes(b.ref));
  if (!bouquets.length) throw new Error(t('El receptor no tiene bouquets de {kind}.', { kind: opts.radio ? 'radio' : 'TV' }));

  const auth = authHeader(box);
  const httpLine = auth ? `#EXTHTTP:${JSON.stringify({ Authorization: auth })}` : '';
  const lines = ['#EXTM3U'];
  const seen = new Set();
  let count = 0;

  const results = await pool(bouquets, 3, (b) => bouquetServices(box, b.ref));
  bouquets.forEach((b, bi) => {
    const services = Array.isArray(results[bi]) ? results[bi] : [];
    let group = b.name;
    for (const s of services) {
      const sref = s.servicereference || '';
      const name = String(s.servicename || '').replace(/[\u0086\u0087]/g, '').trim();
      // Los marcadores dentro de un bouquet hacen de subcategoría («Deportes», «Cine»…)
      if (isMarker(sref)) {
        const label = name.replace(/^[-=_.*~\s]+|[-=_.*~\s]+$/g, '');
        if (label) group = `${b.name} · ${label}`;
        continue;
      }
      if (!isPlayable(sref)) continue;
      const iptv = embeddedUrl(sref);
      const url = iptv || streamUrl(box, sref, opts);
      const key = `${group}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`#EXTINF:-1 tvg-id="${q(srefKey(sref))}" tvg-name="${q(name)}" tvg-logo="${q(piconUrl(box, sref, s.picon))}" group-title="${q(group)}"${iptv ? '' : ' type="ts"'},${name || srefKey(sref)}`);
      if (httpLine && !iptv) lines.push(httpLine);
      lines.push(url);
      count++;
    }
  });
  if (!count) throw new Error(t('No se encontraron canales en los bouquets del receptor.'));
  return { text: lines.join('\n') + '\n', count, bouquets };
}

// ---------- Guía TV ----------

/**
 * EPG de los bouquets (ahora y próximas horas) con la forma de epg.js:
 * { channels: Map, programs: Map, categories: Set }.
 */
export async function fetchBoxEpg(box, bouquetRefs) {
  const channels = new Map();
  const programs = new Map();
  const categories = new Set();
  const now = Math.floor(Date.now() / 1000);
  const from = now - 3 * 3600;
  const until = (now + EPG_HOURS * 3600) * 1000;

  const results = await pool(bouquetRefs, 2, (ref) => api(box, `/api/epgmulti?bRef=${encodeURIComponent(ref)}&time=${from}`, { timeout: 60000 }));
  for (const data of results) {
    for (const ev of data?.events || []) {
      const id = srefKey(ev.sref);
      const start = Number(ev.begin_timestamp) * 1000;
      const stop = start + Number(ev.duration_sec || 0) * 1000;
      if (!start || stop <= start || start > until) continue;
      if (!channels.has(id)) channels.set(id, { id, names: ev.sname ? [String(ev.sname).trim()] : [], icon: '' });
      let list = programs.get(id);
      if (!list) { list = []; programs.set(id, list); }
      if (list.some((p) => p.start === start)) continue; // el mismo canal en varios bouquets
      const category = String(ev.genre || '').trim();
      if (category) categories.add(category);
      list.push({
        channel: id,
        start,
        stop,
        title: String(ev.title || '').trim() || t('Sin título'),
        subTitle: String(ev.shortdesc || '').trim(),
        desc: String(ev.longdesc || '').trim(),
        category,
        icon: ''
      });
    }
  }
  for (const list of programs.values()) list.sort((a, b) => a.start - b.start);
  return { channels, programs, categories };
}
