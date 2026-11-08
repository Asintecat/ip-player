// Normalización de DRM y detección del tipo de stream.
//
// Formato normalizado de DRM de un canal:
// {
//   system: 'none' | 'clearkey' | 'widevine' | 'playready',
//   licenseUrl: '',            // servidor de licencias (Widevine / PlayReady / ClearKey remoto)
//   licenseHeaders: {},        // cabeceras para la petición de licencia
//   keys: { kidHex: keyHex },  // claves ClearKey locales
//   bodyTemplate: '',          // plantilla estilo Kodi: R{SSM} | b{SSM} | B{SSM} | texto con {SSM}
//   responseTemplate: ''       // '' (binario) | 'B' (base64) | 'J<campo>' / 'JB<campo>' (JSON)
// }

export const KEY_SYSTEMS = {
  clearkey: 'org.w3.clearkey',
  widevine: 'com.widevine.alpha',
  playready: 'com.microsoft.playready'
};

import { t } from './i18n.js';

export const MIME = {
  dash: 'application/dash+xml',
  hls: 'application/x-mpegurl',
  mss: 'application/vnd.ms-sstr+xml'
};

export const TYPE_LABEL = {
  dash: 'DASH',
  hls: 'HLS',
  mss: 'Smooth Streaming',
  progressive: 'Progresivo',
  auto: 'Auto'
};

export function emptyDrm() {
  return { system: 'none', licenseUrl: '', licenseHeaders: {}, keys: {}, bodyTemplate: '', responseTemplate: '' };
}

/** Normaliza nombres de sistema DRM de Kodi / M3U / dash.js. */
export function normalizeSystem(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 'none';
  if (v.includes('clearkey') || v === 'ck') return 'clearkey';
  if (v.includes('widevine') || v === 'wv') return 'widevine';
  if (v.includes('playready') || v === 'pr') return 'playready';
  // FairPlay no existe en Chrome: se trata como ClearKey para descifrar SAMPLE-AES
  // con las claves del canal (o con un proxy de claves) en el motor hls.js.
  if (v.includes('fairplay') || v.includes('com.apple.fps') || v === 'fps' || v.includes('streamingkeydelivery')) return 'clearkey';
  return 'none';
}

/** Normaliza el tipo de manifiesto declarado (manifest_type, etc.). */
export function normalizeType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['mpd', 'dash'].includes(v)) return 'dash';
  if (['hls', 'm3u8'].includes(v)) return 'hls';
  if (['ism', 'isml', 'mss', 'smooth', 'smoothstreaming'].includes(v)) return 'mss';
  if (['mp4', 'progressive', 'file'].includes(v)) return 'progressive';
  return '';
}

/** Detecta el tipo de stream por la URL (o usa la pista explícita). */
export function detectType(url, hint) {
  const forced = normalizeType(hint);
  if (forced) return forced;
  const path = String(url || '').toLowerCase().split('#')[0];
  const [base, query = ''] = path.split('?');
  if (/\.mpd$/.test(base) || /(format|type)=(mpd|dash)/.test(query)) return 'dash';
  if (/\.m3u8?$/.test(base) || /(format|type)=(m3u8|hls)/.test(query)) return 'hls';
  if (/\.isml?(\/manifest(\(.*\))?)?$/.test(base) || /\/manifest(\(.*\))?$/.test(base)) return 'mss';
  if (/\.(mp4|m4v|webm|mov|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/.test(base)) return 'progressive';
  return 'auto';
}

// ---------- Utilidades de codificación ----------

export function base64ToBytes(b64) {
  let s = String(b64).trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convierte un KID o una clave (hex, UUID o base64/base64url) a hex en minúsculas. */
export function toHex(value) {
  const v = String(value || '').trim().replace(/^0x/i, '');
  const noDash = v.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(noDash)) return noDash.toLowerCase();
  if (/^[0-9a-f]+$/i.test(v) && v.length % 2 === 0) return v.toLowerCase();
  try {
    const hex = bytesToHex(base64ToBytes(v));
    if (hex.length) return hex;
  } catch (_) { /* no es base64 */ }
  throw new Error(t('Valor de clave no válido: "{v}"', { v: value }));
}

export function canonicalHeader(name) {
  const n = String(name).trim();
  const map = {
    'user-agent': 'User-Agent', 'useragent': 'User-Agent', 'http-user-agent': 'User-Agent',
    'referer': 'Referer', 'referrer': 'Referer', 'http-referrer': 'Referer', 'http-referer': 'Referer',
    'origin': 'Origin', 'http-origin': 'Origin', 'cookie': 'Cookie', 'authorization': 'Authorization',
    'content-type': 'Content-Type'
  };
  return map[n.toLowerCase()] || n;
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch (_) { return s; }
}

/** Parsea "Header=valor&Otro=valor" (formato Kodi / pipe de URL). */
export function parseQueryHeaders(str) {
  const headers = {};
  if (!str) return headers;
  for (const part of String(str).split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = safeDecode(part.slice(0, i).trim());
    if (k) headers[canonicalHeader(k)] = safeDecode(part.slice(i + 1).trim());
  }
  return headers;
}

/** Parsea cabeceras en líneas "Header: valor" (o "Header=valor"). */
export function parseLineHeaders(text) {
  const headers = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([^:=]+?)\s*[:=]\s*(.*)$/);
    if (m) headers[canonicalHeader(m[1])] = m[2].trim();
  }
  return headers;
}

export function headersToLines(headers) {
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

// ---------- Claves ClearKey ----------

/**
 * Acepta:
 *  - "kid:key" (uno o varios separados por coma, espacio, punto y coma o salto de línea)
 *  - JSON {"kid":"key", ...}
 *  - JSON JWK {"keys":[{"kty":"oct","kid":"..","k":".."}]} o array de JWK
 * KID y KEY pueden ir en hex, UUID o base64/base64url.
 */
export function parseClearKeys(input) {
  const keys = {};
  const text = String(input || '').trim();
  if (!text) return keys;

  if (text.startsWith('{') || text.startsWith('[')) {
    const json = JSON.parse(text);
    const jwks = Array.isArray(json) ? json : Array.isArray(json.keys) ? json.keys : null;
    if (jwks) {
      for (const k of jwks) if (k && k.kid && k.k) keys[toHex(k.kid)] = toHex(k.k);
    } else {
      for (const [kid, key] of Object.entries(json)) keys[toHex(kid)] = toHex(key);
    }
    return keys;
  }

  for (const pair of text.split(/[\s,;]+/)) {
    if (!pair) continue;
    const i = pair.indexOf(':');
    // Solo KEY (sin KID): clave comodín, útil para HLS SAMPLE-AES / FairPlay.
    if (i < 0 && /^[0-9a-f]{32}$/i.test(pair)) { keys[ANY_KID] = pair.toLowerCase(); continue; }
    if (i <= 0) throw new Error(t('Par ClearKey no válido: "{v}" (formato esperado KID:KEY o solo KEY)', { v: pair }));
    const kid = pair.slice(0, i);
    // KID:KEY:IV → el IV (SAMPLE-AES / FairPlay) se guarda junto a la clave: "key:iv".
    const [key, iv] = pair.slice(i + 1).split(':');
    keys[kid === ANY_KID ? ANY_KID : toHex(kid)] = toHex(key) + (iv ? ':' + toHex(iv) : '');
  }
  return keys;
}

/** KID comodín: clave sin KID (solo la usa el motor hls.js para SAMPLE-AES). */
export const ANY_KID = '*';

/** Claves con KID real y sin IV (las que entiende EME / CENC). */
export function cencKeys(keys) {
  return Object.fromEntries(Object.entries(keys || {})
    .filter(([kid]) => kid !== ANY_KID)
    .map(([kid, v]) => [kid, String(v).split(':')[0]]));
}

export function keysToLines(keys) {
  return Object.entries(keys || {}).map(([k, v]) => `${k}:${v}`).join('\n');
}

// ---------- license_key estilo Kodi ----------

/**
 * Aplica un license_key de Kodi (inputstream.adaptive.license_key) a un objeto DRM.
 * Formatos: "URL|Cabeceras|Plantilla cuerpo|Plantilla respuesta", claves ClearKey o JSON.
 */
export function applyLicenseKey(drm, raw, systemHint) {
  const value = String(raw || '').trim();
  if (!value) return drm;
  const hinted = normalizeSystem(systemHint);
  let system = hinted !== 'none' ? hinted : drm.system;

  if (/^https?:\/\//i.test(value)) {
    const [url, hdrs = '', body = '', resp = ''] = value.split('|');
    drm.licenseUrl = url.trim();
    Object.assign(drm.licenseHeaders, parseQueryHeaders(hdrs));
    if (body) drm.bodyTemplate = body;
    if (resp) drm.responseTemplate = resp;
    if (system === 'none') system = 'widevine';
  } else {
    Object.assign(drm.keys, parseClearKeys(value));
    system = 'clearkey';
  }
  drm.system = system;
  return drm;
}

/**
 * inputstream.adaptive.drm (JSON moderno de Kodi 21+):
 * {"com.widevine.alpha":{"license":{"server_url":"..","req_headers":"..."}}}
 * {"org.w3.clearkey":{"license":{"keyids":{"kid":"key"}}}}
 */
export function applyKodiDrmJson(drm, raw) {
  const json = JSON.parse(raw);
  for (const [ks, cfg] of Object.entries(json)) {
    const system = normalizeSystem(ks);
    if (system === 'none') continue;
    drm.system = system;
    const lic = (cfg && cfg.license) || {};
    if (lic.server_url) drm.licenseUrl = lic.server_url;
    if (lic.req_headers) Object.assign(drm.licenseHeaders, parseQueryHeaders(lic.req_headers));
    if (lic.req_data) drm.bodyTemplate = lic.req_data;
    if (lic.keyids) for (const [k, v] of Object.entries(lic.keyids)) drm.keys[toHex(k)] = toHex(v);
    break;
  }
  return drm;
}

// ---------- Configuración para Shaka ----------

/** Devuelve la sección "drm" de la configuración de Shaka Player. */
export function buildShakaDrmConfig(drm) {
  const cfg = { servers: {}, clearKeys: {} };
  // Un manifiesto con varios sistemas usa ClearKey si el canal no pide otro.
  // FairPlay no está en Chrome; Shaka lo salta si ClearKey o Widevine sirven.
  if (!drm || drm.system === 'none' || drm.system === 'clearkey') {
    cfg.preferredKeySystems = [KEY_SYSTEMS.clearkey, KEY_SYSTEMS.widevine];
  }
  if (!drm || drm.system === 'none') return cfg;
  if (drm.system === 'clearkey') {
    if (Object.keys(cencKeys(drm.keys)).length) cfg.clearKeys = cencKeys(drm.keys);
    else if (drm.licenseUrl) cfg.servers[KEY_SYSTEMS.clearkey] = drm.licenseUrl;
  } else if (drm.licenseUrl) {
    cfg.servers[KEY_SYSTEMS[drm.system]] = drm.licenseUrl;
  }
  return cfg;
}

export function drmLabel(drm) {
  if (!drm || drm.system === 'none') return '';
  return { clearkey: 'ClearKey', widevine: 'Widevine', playready: 'PlayReady' }[drm.system] || '';
}

// ---------- Plantillas de petición / respuesta de licencia ----------

export function transformLicenseRequest(request, template) {
  if (!template || template === 'R{SSM}') return;
  const challenge = new Uint8Array(request.body);
  const b64 = bytesToBase64(challenge);
  let raw = '';
  for (let i = 0; i < challenge.length; i++) raw += String.fromCharCode(challenge[i]);
  const body = template
    .replace(/([RbB])\{SSM\}/g, (_, mode) => (mode === 'b' ? b64 : mode === 'B' ? encodeURIComponent(b64) : raw))
    .replace(/\{SSM\}/g, b64);
  request.body = new TextEncoder().encode(body).buffer;
}

export function transformLicenseResponse(response, template) {
  if (!template) return;
  const text = new TextDecoder().decode(response.data).trim();
  let b64 = null;
  if (template === 'B') {
    b64 = text;
  } else if (template.startsWith('J')) {
    const path = template.replace(/^JB?/, '');
    const json = JSON.parse(text);
    b64 = path.split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), json);
    if (typeof b64 !== 'string') throw new Error(t('Campo "{v}" no encontrado en la respuesta de licencia', { v: path }));
  }
  if (b64 != null) response.data = base64ToBytes(b64).buffer;
}
