// Parser de listas M3U / M3U8 extendidas (formato IPTV).
// Soporta: #EXTINF (atributos tvg-*, group-title...), #EXTGRP, #KODIPROP,
// #EXTVLCOPT, #EXTHTTP, cabeceras en la URL con "|" y DRM estilo Kodi.

import {
  emptyDrm, normalizeSystem, normalizeType, applyLicenseKey, applyKodiDrmJson,
  parseQueryHeaders, canonicalHeader, parseClearKeys
} from './drm.js';

function freshPending() {
  return {
    name: '', attrs: {}, group: '', headers: {}, type: '', engine: '', proxy: '',
    drmSystem: '', licenseKey: '', drmLegacy: '', drmJson: '', licenseHeaders: {}
  };
}

/** ¿Es un M3U con canales (y no un manifiesto HLS)? */
export function looksLikeHlsManifest(text) {
  return /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MEDIA:|KEY)/.test(text);
}

function parseExtinf(line) {
  // #EXTINF:-1 tvg-id="x" tvg-logo="y" group-title="z",Nombre del canal
  const body = line.slice(line.indexOf(':') + 1);
  let quote = null;
  let split = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ',') { split = i; break; }
  }
  const attrPart = split >= 0 ? body.slice(0, split) : body;
  const name = split >= 0 ? body.slice(split + 1).trim() : '';
  const attrs = {};
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let m;
  while ((m = re.exec(attrPart))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return { name, attrs };
}

function splitKeyValue(s) {
  const i = s.indexOf('=');
  if (i < 0) return [s.trim().toLowerCase(), ''];
  return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()];
}

function resolveUrl(url, base) {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try { return new URL(url, base).href; } catch (_) { return url; }
}

/** Atributos clave="valor" de una línea (sin cortar por comas: sirve para #EXTM3U). */
function lineAttrs(line) {
  const attrs = {};
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return attrs;
}

/** Catch-up del canal (o el de la lista entera si el canal no lo declara). */
function catchupOf(a, defaults = {}) {
  // tvg-rec sin catchup propio: el formato se deduce de la URL (p. ej. Xtream Codes)
  const own = a['catchup'] || a['catchup-type'] || '';
  const mode = own || (a['tvg-rec'] && !a['catchup-source'] ? '' : defaults.mode || '');
  const source = a['catchup-source'] || defaults.source || '';
  const days = a['catchup-days'] || a['timeshift'] || a['tvg-rec'] || defaults.days || '';
  if (!mode && !source && !(Number(days) > 0)) return undefined;
  return { mode, source, days: Number(days) || 0 };
}

function buildChannel(p, rawUrl, index, baseUrl, defaults) {
  let url = rawUrl.trim();
  const headers = { ...p.headers };

  // Cabeceras tras "|" en la URL: url|User-Agent=x&Referer=y
  const pipe = url.indexOf('|');
  if (pipe > 0) {
    Object.assign(headers, parseQueryHeaders(url.slice(pipe + 1)));
    url = url.slice(0, pipe).trim();
  }
  url = resolveUrl(url, baseUrl);

  const a = p.attrs;
  if (a['user-agent'] || a['http-user-agent']) headers['User-Agent'] = a['user-agent'] || a['http-user-agent'];
  if (a['http-referrer'] || a['http-referer'] || a['referer']) {
    headers['Referer'] = a['http-referrer'] || a['http-referer'] || a['referer'];
  }

  // DRM
  const drm = emptyDrm();
  const errors = [];
  try {
    if (p.drmJson) applyKodiDrmJson(drm, p.drmJson);
    if (p.drmLegacy) {
      // org.w3.clearkey|kid:key   ó   com.widevine.alpha|https://lic|cabeceras
      const i = p.drmLegacy.indexOf('|');
      const sys = i >= 0 ? p.drmLegacy.slice(0, i) : p.drmLegacy;
      const rest = i >= 0 ? p.drmLegacy.slice(i + 1) : '';
      drm.system = normalizeSystem(sys);
      if (rest) applyLicenseKey(drm, rest, sys);
    }
    if (p.drmSystem) drm.system = normalizeSystem(p.drmSystem);
    if (p.licenseKey) applyLicenseKey(drm, p.licenseKey, p.drmSystem);
    // Atributos alternativos usados por algunas listas
    if (!p.licenseKey && (a['drm-license'] || a['license-key'])) {
      applyLicenseKey(drm, a['drm-license'] || a['license-key'], a['drm-type'] || a['drm']);
    }
    if (a['clearkey'] || a['drm-keys']) {
      Object.assign(drm.keys, parseClearKeys(a['clearkey'] || a['drm-keys']));
      drm.system = 'clearkey';
    }
  } catch (e) {
    errors.push(e.message);
  }
  Object.assign(drm.licenseHeaders, p.licenseHeaders);

  return {
    id: `${index}`,
    name: p.name || a['tvg-name'] || url,
    logo: a['tvg-logo'] || a['logo'] || '',
    group: a['group-title'] || p.group || '',
    tvgId: a['tvg-id'] || '',
    chno: a['tvg-chno'] || a['channel-number'] || '',
    url,
    type: p.type || normalizeType(a['type'] || a['manifest-type']),
    engine: p.engine,
    proxy: p.proxy ? { mode: 'custom', url: p.proxy } : undefined,
    headers,
    drm,
    catchup: catchupOf(a, defaults),
    errors
  };
}

/** ¿Es un bouquet de Enigma2 (userbouquet.*.tv) en vez de un M3U? */
export function looksLikeEnigmaBouquet(text) {
  return /^#SERVICE\s/m.test(text) && !/^#EXTINF/m.test(text);
}

/**
 * Bouquet de Enigma2: «#SERVICE <sref>» + «#DESCRIPTION <nombre>» opcional.
 * - Los streams IPTV llevan la URL codificada en el campo 11 de la sref.
 * - Los canales DVB solo se pueden ver si el bouquet viene del propio receptor
 *   (se usa su IP con el puerto de streaming 8001).
 * - Los marcadores (1:64:…) pasan a ser categorías.
 */
function parseEnigmaBouquet(text, baseUrl) {
  const channels = [];
  let boxHost = '';
  try { if (baseUrl && /^https?:/i.test(baseUrl)) boxHost = new URL(baseUrl).hostname; } catch (_) { /* sin receptor */ }
  let group = '';
  let pending = null;
  let skipped = 0;
  const flush = () => {
    if (!pending) return;
    const { sref, name } = pending;
    pending = null;
    const f = sref.split(':');
    const flags = parseInt(f[1], 10) || 0;
    if (flags & 0x40) { if (name && !/^[-=_.\s]*$/.test(name)) group = name.replace(/^[-=_.\s]+|[-=_.\s]+$/g, ''); return; }
    if (flags & 0x201) return;
    let url = '';
    if (f.length > 10 && /^https?%3a/i.test(f[10])) {
      try { url = decodeURIComponent(f[10]); } catch (_) { url = ''; }
    } else if (boxHost && f.length >= 10) {
      url = `http://${boxHost}:8001/${f.slice(0, 10).join(':')}:`;
    }
    if (!url) { skipped++; return; }
    const p = freshPending();
    p.name = name || (f.length > 11 ? f.slice(11).join(':') : '') || f.slice(0, 10).join(':');
    p.group = group;
    p.attrs = { 'tvg-id': f.slice(0, 10).join(':').toUpperCase() };
    channels.push(buildChannel(p, url, channels.length, baseUrl));
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#SERVICE')) {
      flush();
      const sref = line.slice(8).trim();
      const f = sref.split(':');
      pending = { sref, name: f.length > 11 ? f.slice(11).join(':').trim() : '' };
    } else if (line.startsWith('#DESCRIPTION') && pending) {
      pending.name = line.slice(12).replace(/^[:\s]+/, '').trim() || pending.name;
    }
  }
  flush();
  return { channels, epg: '', skipped };
}

/**
 * Parsea el texto M3U y devuelve { channels, epg }.
 * @param {string} text
 * @param {string} [baseUrl] URL de la lista para resolver rutas relativas
 */
export function parseM3U(text, baseUrl) {
  if (looksLikeEnigmaBouquet(String(text || ''))) return parseEnigmaBouquet(text, baseUrl);
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const channels = [];
  let epg = '';
  let catchupDefaults = {};
  let p = freshPending();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const m = line.match(/(?:url-tvg|x-tvg-url)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (m) {
        const raw = (m[1] ?? m[2] ?? m[3] ?? '').split(',')[0].trim();
        if (raw) epg = resolveUrl(raw, baseUrl);
      }
      const h = lineAttrs(line);
      catchupDefaults = {
        mode: h['catchup'] || h['catchup-type'] || '',
        source: h['catchup-source'] || '',
        days: h['catchup-days'] || h['timeshift'] || ''
      };
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const { name, attrs } = parseExtinf(line);
      p.name = name;
      p.attrs = attrs;
      continue;
    }
    // OpenWebIF / Enigma2 añade «#DESCRIPTION Nombre» a algunos M3U
    if (line.startsWith('#DESCRIPTION')) {
      if (!p.name) p.name = line.slice(12).replace(/^[:\s]+/, '').trim();
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      p.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#KODIPROP:')) {
      const [k, v] = splitKeyValue(line.slice(10));
      const key = k.replace(/^inputstream\.adaptive\./, '').replace(/^inputstreamaddon\./, '');
      switch (key) {
        case 'license_type': p.drmSystem = v; break;
        case 'license_key': p.licenseKey = v; break;
        case 'drm_legacy': p.drmLegacy = v; break;
        case 'drm': p.drmJson = v; break;
        case 'manifest_type': p.type = normalizeType(v); break;
        case 'ipplayer.engine': p.engine = ['dashjs', 'shaka', 'hlsjs', 'mpegts'].includes(v) ? v : ''; break;
        case 'stream_headers':
        case 'manifest_headers':
          Object.assign(p.headers, parseQueryHeaders(v)); break;
        case 'license_headers':
          Object.assign(p.licenseHeaders, parseQueryHeaders(v)); break;
        default: break;
      }
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const [k, v] = splitKeyValue(line.slice(11));
      if (k === 'http-user-agent') p.headers['User-Agent'] = v;
      else if (k === 'http-referrer' || k === 'http-referer') p.headers['Referer'] = v;
      else if (k === 'http-origin') p.headers['Origin'] = v;
      else if (k === 'http-cookie') p.headers['Cookie'] = v;
      else if (k === 'http-proxy' || k === 'socks-proxy') p.proxy = v;
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const obj = JSON.parse(line.slice(9));
        for (const [k, v] of Object.entries(obj)) p.headers[canonicalHeader(k)] = String(v);
      } catch (_) { /* ignorar JSON inválido */ }
      continue;
    }
    if (line.startsWith('#')) continue;

    // Línea de URL → cierra el canal
    channels.push(buildChannel(p, line, channels.length, baseUrl, catchupDefaults));
    p = freshPending();
  }

  return { channels, epg };
}
