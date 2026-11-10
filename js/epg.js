// Gestor y analizador de Guía TV (EPG) en formato XMLTV (.xml y .xml.gz).
//
// Soporta descompresión nativa de .xml.gz (gzip) mediante DecompressionStream,
// extracción de canales y programas (<channel>, <programme>), normalización y
// asociación inteligente de canales M3U (tvg-id, tvg-name, similitud),
// persistencia en IndexedDB y consultas en tiempo real (ahora y siguiente, parrilla).

import { t } from './i18n.js';
import { ensureUrl } from './proxy.js';

const DB_NAME = 'ip_player_epg';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_PROGRAMS = 'programs';
const STORE_CHANNELS = 'channels';

/** Estado del EPG en memoria para acceso síncrono ultra-rápido */
let memoryEpg = {
  url: '',
  name: '',
  updatedAt: '',
  channels: new Map(), // id -> { id, names: [], icon: '' }
  programs: new Map(), // chId -> [Programme] (ordenados por start)
  categories: new Set(),
  matchCache: new Map() // channelKey -> epgChId | null
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { resolve(null); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_CHANNELS)) db.createObjectStore(STORE_CHANNELS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PROGRAMS)) db.createObjectStore(STORE_PROGRAMS, { keyPath: 'channel' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn('No se pudo abrir IndexedDB para EPG', req.error); resolve(null); };
  });
  return dbPromise;
}

/**
 * Parsea fechas XMLTV: YYYYMMDDhhmmss [+/-ZZZZ] a milisegundos Unix.
 * @param {string} str
 * @returns {number}
 */
export function parseXmltvDate(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{4}))?/);
  if (!m) return 0;
  const [, Y, M, D, h, min, s, tz] = m;
  const year = Number(Y);
  const month = Number(M) - 1;
  const day = Number(D);
  const hour = Number(h);
  const minute = Number(min);
  const second = Number(s || 0);

  if (tz) {
    const sign = tz[0] === '+' ? 1 : -1;
    const tzHours = Number(tz.slice(1, 3));
    const tzMins = Number(tz.slice(3, 5));
    const offsetMs = sign * (tzHours * 60 + tzMins) * 60 * 1000;
    return Date.UTC(year, month, day, hour, minute, second) - offsetMs;
  }
  return Date.UTC(year, month, day, hour, minute, second);
}

/** Descomprime un ArrayBuffer si contiene cabecera gzip (0x1f, 0x8b). */
export async function decompressGzip(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return new TextDecoder('utf-8').decode(buffer);

  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('gzip');
    const decompressed = new Response(buffer).body.pipeThrough(ds);
    const text = await new Response(decompressed).text();
    return text;
  }
  throw new Error(t('Este navegador no soporta descompresión Gzip nativa.'));
}

function decodeXmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Analizador XMLTV optimizado: procesa <channel> y <programme>.
 * Tolera ampersands sin escapar comunes en EPGs de IPTV.
 * @param {string} xmlText
 */
export function parseXmltv(xmlText) {
  const channels = new Map();
  const programs = new Map();
  const categories = new Set();

  if (!xmlText || typeof xmlText !== 'string') return { channels, programs, categories };

  // 1. Extraer canales: <channel id="..."> <display-name>...</display-name> <icon src="..."/> </channel>
  const channelTagRe = /<channel\s+[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/channel>/gi;
  let cm;
  while ((cm = channelTagRe.exec(xmlText))) {
    const id = cm[1].trim();
    const body = cm[2];
    const names = [];
    const nameRe = /<display-name[^>]*>([^<]+)<\/display-name>/gi;
    let nm;
    while ((nm = nameRe.exec(body))) {
      const val = decodeXmlEntities(nm[1].trim());
      if (val) names.push(val);
    }
    const iconM = body.match(/<icon\s+[^>]*src=["']([^"']+)["']/i);
    const icon = iconM ? iconM[1].trim() : '';
    channels.set(id, { id, names, icon });
  }

  // 2. Extraer programas: <programme start="..." stop="..." channel="..."> ... </programme>
  const progTagRe = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  let pm;
  while ((pm = progTagRe.exec(xmlText))) {
    const attrs = pm[1];
    const body = pm[2];

    const chM = attrs.match(/channel=["']([^"']+)["']/i);
    const startM = attrs.match(/start=["']([^"']+)["']/i);
    const stopM = attrs.match(/stop=["']([^"']+)["']/i);

    if (!chM || !startM) continue;
    const ch = chM[1].trim();
    const start = parseXmltvDate(startM[1]);
    const stop = stopM ? parseXmltvDate(stopM[1]) : start + 3600000;

    const titleM = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = decodeXmlEntities(titleM ? titleM[1].trim() : '');
    if (!title) continue;

    const subM = body.match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/i);
    const subTitle = decodeXmlEntities(subM ? subM[1].trim() : '');

    const descM = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);
    const desc = decodeXmlEntities(descM ? descM[1].trim() : '');

    const catM = body.match(/<category[^>]*>([\s\S]*?)<\/category>/i);
    const category = decodeXmlEntities(catM ? catM[1].trim() : '');
    if (category) categories.add(category);

    const iconM = body.match(/<icon\s+[^>]*src=["']([^"']+)["']/i);
    const icon = iconM ? iconM[1].trim() : '';

    const p = { channel: ch, start, stop, title, subTitle, desc, category, icon };

    let list = programs.get(ch);
    if (!list) {
      list = [];
      programs.set(ch, list);
    }
    list.push(p);
  }

  // Ordenar programas cronológicamente por canal
  for (const list of programs.values()) {
    list.sort((a, b) => a.start - b.start);
  }

  return { channels, programs, categories };
}

/**
 * Normaliza nombres para comparación flexible entre el canal M3U y el EPG.
 * Quita acentos, sufijos típicos (HD, 4K, FHD), puntuación y espacios.
 */
export function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(hd|fhd|4k|sd|uhd|hevc|1080p|720p|directo|live|es|spain)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Encuentra el ID de canal en el EPG que mejor corresponde al canal M3U dado.
 * @param {object} channel Canal de IP Player (name, tvgId, group, etc.)
 * @returns {string|null} ID del canal en el EPG o null si no hay coincidencia
 */
export function matchChannel(channel) {
  if (!channel) return null;
  const key = `${channel.tvgId || ''}|${channel.name || ''}`;
  if (memoryEpg.matchCache.has(key)) return memoryEpg.matchCache.get(key);

  const programs = memoryEpg.programs;
  const channels = memoryEpg.channels;

  // 1. Coincidencia directa por tvg-id
  if (channel.tvgId) {
    if (programs.has(channel.tvgId)) {
      memoryEpg.matchCache.set(key, channel.tvgId);
      return channel.tvgId;
    }
    const lowerId = channel.tvgId.toLowerCase();
    for (const id of programs.keys()) {
      if (id.toLowerCase() === lowerId) {
        memoryEpg.matchCache.set(key, id);
        return id;
      }
    }
  }

  // 2. Coincidencia normalizada por nombre
  const cNorm = normalizeForMatch(channel.name);
  if (!cNorm) {
    memoryEpg.matchCache.set(key, null);
    return null;
  }

  // Buscar en display-names de canales EPG
  for (const [id, epgCh] of channels.entries()) {
    if (normalizeForMatch(id) === cNorm && programs.has(id)) {
      memoryEpg.matchCache.set(key, id);
      return id;
    }
    for (const name of epgCh.names) {
      if (normalizeForMatch(name) === cNorm && programs.has(id)) {
        memoryEpg.matchCache.set(key, id);
        return id;
      }
    }
  }

  // 3. Coincidencia parcial (subcadena de al menos 4 caracteres)
  if (cNorm.length >= 4) {
    for (const [id, epgCh] of channels.entries()) {
      if (!programs.has(id)) continue;
      const nId = normalizeForMatch(id);
      if (nId && (cNorm.includes(nId) || nId.includes(cNorm))) {
        memoryEpg.matchCache.set(key, id);
        return id;
      }
      for (const name of epgCh.names) {
        const nName = normalizeForMatch(name);
        if (nName && nName.length >= 4 && (cNorm.includes(nName) || nName.includes(cNorm))) {
          memoryEpg.matchCache.set(key, id);
          return id;
        }
      }
    }
  }

  memoryEpg.matchCache.set(key, null);
  return null;
}

/**
 * Obtiene el programa actual y el siguiente para un canal.
 * @param {object} channel
 * @param {number} [timestamp]
 * @returns {{ now: object|null, next: object|null, progress: number }}
 */
export function getNowAndNext(channel, timestamp = Date.now()) {
  const epgId = matchChannel(channel);
  if (!epgId) return { now: null, next: null, progress: 0 };

  const list = memoryEpg.programs.get(epgId);
  if (!list || !list.length) return { now: null, next: null, progress: 0 };

  let nowIndex = -1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (timestamp >= p.start && timestamp < p.stop) {
      nowIndex = i;
      break;
    }
    if (p.start > timestamp) {
      // No hay programa actual, el más cercano a futuro
      return { now: null, next: p, progress: 0 };
    }
  }

  if (nowIndex >= 0) {
    const now = list[nowIndex];
    const next = list[nowIndex + 1] || null;
    const dur = Math.max(1, now.stop - now.start);
    const elapsed = Math.max(0, timestamp - now.start);
    const progress = Math.min(100, Math.max(0, Math.round((elapsed / dur) * 100)));
    return { now, next, progress };
  }

  return { now: null, next: null, progress: 0 };
}

/**
 * Obtiene la lista de programas de un canal en un intervalo de tiempo.
 */
export function getChannelSchedule(channel, fromMs, toMs) {
  const epgId = matchChannel(channel);
  if (!epgId) return [];
  const list = memoryEpg.programs.get(epgId) || [];
  return list.filter((p) => p.stop > fromMs && p.start < toMs);
}

/**
 * Guarda el EPG actual en IndexedDB para disponibilidad instantánea.
 */
async function persistToDb(data) {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_META, STORE_CHANNELS, STORE_PROGRAMS], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => { console.warn('Error guardando EPG en IndexedDB', tx.error); resolve(); };

      const metaStore = tx.objectStore(STORE_META);
      const chStore = tx.objectStore(STORE_CHANNELS);
      const progStore = tx.objectStore(STORE_PROGRAMS);

      metaStore.clear();
      chStore.clear();
      progStore.clear();

      metaStore.put({
        key: 'active',
        url: data.url || '',
        name: data.name || '',
        updatedAt: data.updatedAt || new Date().toISOString(),
        channelCount: data.channels.size,
        programCount: [...data.programs.values()].reduce((acc, l) => acc + l.length, 0)
      });

      for (const ch of data.channels.values()) chStore.put(ch);
      for (const [channel, list] of data.programs.entries()) progStore.put({ channel, list });
    } catch (err) {
      console.warn('Excepción guardando EPG', err);
      resolve();
    }
  });
}

/**
 * Carga el EPG guardado en IndexedDB a memoria al iniciar.
 */
export async function loadCachedEpg() {
  const db = await openDb();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_META, STORE_CHANNELS, STORE_PROGRAMS], 'readonly');
      let meta = null;
      const channels = new Map();
      const programs = new Map();
      const categories = new Set();

      tx.objectStore(STORE_META).get('active').onsuccess = (e) => { meta = e.target.result; };
      tx.objectStore(STORE_CHANNELS).openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          channels.set(cursor.value.id, cursor.value);
          cursor.continue();
        }
      };
      tx.objectStore(STORE_PROGRAMS).openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          programs.set(cursor.value.channel, cursor.value.list);
          for (const p of cursor.value.list) if (p.category) categories.add(p.category);
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        if (meta && programs.size) {
          memoryEpg = {
            url: meta.url || '',
            name: meta.name || '',
            updatedAt: meta.updatedAt || '',
            channels,
            programs,
            categories,
            matchCache: new Map()
          };
          resolve(true);
        } else {
          resolve(false);
        }
      };
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * Borra el EPG guardado en IndexedDB y vacía la memoria.
 */
export async function clearEpg() {
  memoryEpg = {
    url: '',
    name: '',
    updatedAt: '',
    channels: new Map(),
    programs: new Map(),
    categories: new Set(),
    matchCache: new Map()
  };
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction([STORE_META, STORE_CHANNELS, STORE_PROGRAMS], 'readwrite');
  tx.objectStore(STORE_META).clear();
  tx.objectStore(STORE_CHANNELS).clear();
  tx.objectStore(STORE_PROGRAMS).clear();
}

/**
 * Carga y analiza un EPG desde una URL (con soporte para proxy y .xml.gz).
 * @param {string} url
 * @param {object} [opts]
 */
export async function loadEpgFromUrl(url, { name = '', silent = false } = {}) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) throw new Error(t('URL de EPG vacía'));

  // Asegura el proxy si está configurado
  await ensureUrl(cleanUrl);

  const res = await fetch(cleanUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buffer = await res.arrayBuffer();
  const xmlText = await decompressGzip(buffer);
  const parsed = parseXmltv(xmlText);

  if (!parsed.programs.size && !parsed.channels.size) {
    throw new Error(t('El archivo XMLTV no contiene canales ni programas válidos.'));
  }

  memoryEpg = {
    url: cleanUrl,
    name: name || cleanUrl,
    updatedAt: new Date().toISOString(),
    channels: parsed.channels,
    programs: parsed.programs,
    categories: parsed.categories,
    matchCache: new Map()
  };

  await persistToDb(memoryEpg);
  return getEpgStats();
}

/**
 * Carga un archivo EPG local (.xml o .xml.gz).
 * @param {File} file
 */
export async function loadEpgFromFile(file) {
  if (!file) throw new Error(t('No se seleccionó ningún archivo.'));
  const buffer = await file.arrayBuffer();
  const xmlText = await decompressGzip(buffer);
  const parsed = parseXmltv(xmlText);

  if (!parsed.programs.size && !parsed.channels.size) {
    throw new Error(t('El archivo XMLTV no contiene canales ni programas válidos.'));
  }

  memoryEpg = {
    url: file.name,
    name: file.name,
    updatedAt: new Date().toISOString(),
    channels: parsed.channels,
    programs: parsed.programs,
    categories: parsed.categories,
    matchCache: new Map()
  };

  await persistToDb(memoryEpg);
  return getEpgStats();
}

/**
 * Carga un EPG ya analizado (p. ej. el de un receptor OpenWebIF).
 * @param {{channels: Map, programs: Map, categories: Set}} parsed
 * @param {{url: string, name?: string}} meta
 */
export async function loadEpgData(parsed, { url, name = '' }) {
  if (!parsed?.programs?.size) throw new Error(t('El receptor no devolvió programación.'));
  memoryEpg = {
    url,
    name: name || url,
    updatedAt: new Date().toISOString(),
    channels: parsed.channels,
    programs: parsed.programs,
    categories: parsed.categories || new Set(),
    matchCache: new Map()
  };
  await persistToDb(memoryEpg);
  return getEpgStats();
}

/**
 * Información de estado del EPG cargado.
 */
export function getEpgStats() {
  const totalPrograms = [...memoryEpg.programs.values()].reduce((acc, l) => acc + l.length, 0);
  return {
    loaded: totalPrograms > 0 || memoryEpg.channels.size > 0,
    url: memoryEpg.url,
    name: memoryEpg.name,
    updatedAt: memoryEpg.updatedAt,
    channelCount: memoryEpg.channels.size || memoryEpg.programs.size,
    programCount: totalPrograms,
    categories: Array.from(memoryEpg.categories)
  };
}

export function hasEpg() {
  return memoryEpg.programs.size > 0;
}
