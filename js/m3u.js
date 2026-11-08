// Parser de listas M3U / M3U8 extendidas (formato IPTV).
// Soporta: #EXTINF (atributos tvg-*, group-title...), #EXTGRP, #KODIPROP,
// #EXTVLCOPT, #EXTHTTP, cabeceras en la URL con "|" y DRM estilo Kodi.

import {
  emptyDrm, normalizeSystem, normalizeType, applyLicenseKey, applyKodiDrmJson,
  parseQueryHeaders, canonicalHeader, parseClearKeys
} from './drm.js';

function freshPending() {
  return {
    name: '', attrs: {}, group: '', headers: {}, type: '', engine: '',
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

function buildChannel(p, rawUrl, index, baseUrl) {
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
    headers,
    drm,
    errors
  };
}

/**
 * Parsea el texto M3U y devuelve { channels, epg }.
 * @param {string} text
 * @param {string} [baseUrl] URL de la lista para resolver rutas relativas
 */
export function parseM3U(text, baseUrl) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const channels = [];
  let epg = '';
  let p = freshPending();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const m = line.match(/(?:url-tvg|x-tvg-url)\s*=\s*"([^"]*)"/i);
      if (m) epg = m[1];
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const { name, attrs } = parseExtinf(line);
      p.name = name;
      p.attrs = attrs;
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
        case 'ipplayer.engine': p.engine = ['dashjs', 'shaka', 'hlsjs'].includes(v) ? v : ''; break;
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
    channels.push(buildChannel(p, line, channels.length, baseUrl));
    p = freshPending();
  }

  return { channels, epg };
}
