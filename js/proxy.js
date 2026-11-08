// Proxy para cargar streams (HTTP, HTTPS, SOCKS4 y SOCKS5) con chrome.proxy.
//
// Chrome no permite un proxy por petición; sí una configuración PAC. El script PAC
// solo envía por el proxy los dominios del canal en reproducción (manifiesto,
// segmentos, licencia); todo lo demás sale directo. Los motores llaman a
// ensureUrl() antes de cada petición: si el dominio es nuevo (p. ej. un CDN), se
// añade al PAC y se espera a que Chrome lo aplique, así nada se escapa directo.
// Si el proxy falla, la petición falla (no hay vuelta a DIRECT).
//
// Usuario y contraseña: solo HTTP/HTTPS (Chrome no admite autenticación SOCKS).
// background.js los entrega cuando el proxy los pide (webRequest.onAuthRequired),
// leyéndolos de chrome.storage.local → proxyAuth: { "host:puerto": { user, pass } }.

const PAC_KIND = { http: 'PROXY', https: 'HTTPS', socks4: 'SOCKS', socks5: 'SOCKS5', socks: 'SOCKS5' };
const DEFAULT_PORT = { http: 80, https: 443, socks4: 1080, socks5: 1080, socks: 1080 };

let active = null; // proxy en uso: { scheme, host, port, user, pass, pac }
const hosts = new Set();
let pushing = null;
let dirty = false;

/**
 * Interpreta "esquema://[usuario:contraseña@]host:puerto".
 * @returns {{scheme:string, host:string, port:number, user:string, pass:string, pac:string}}
 */
export function parseProxy(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty');
  const withScheme = /^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  const scheme = withScheme.split(':')[0].toLowerCase();
  if (!PAC_KIND[scheme]) throw new Error('scheme');
  // URL no entiende socks://: se analiza como http y se conserva el esquema.
  const u = new URL(withScheme.replace(/^[a-z0-9]+:/i, 'http:'));
  if (!u.hostname) throw new Error('host');
  const port = Number(u.port) || DEFAULT_PORT[scheme];
  if (!(port > 0 && port < 65536)) throw new Error('port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const kind = PAC_KIND[scheme];
  return {
    scheme: scheme === 'socks' ? 'socks5' : scheme,
    host,
    port,
    user: decodeURIComponent(u.username || ''),
    pass: decodeURIComponent(u.password || ''),
    pac: `${kind} ${host.includes(':') ? `[${host}]` : host}:${port}`
  };
}

/** Texto del proxy sin la contraseña (para mostrarlo). */
export function describeProxy(p) {
  return `${p.scheme.toUpperCase()} · ${p.user ? `${p.user}@` : ''}${p.host}:${p.port}`;
}

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
};

export const isProxyAvailable = () => !!globalThis.chrome?.proxy?.settings;
export const activeProxy = () => active;

/** Script PAC: los dominios registrados van por el proxy; el resto, directo. */
export function buildPac(pacTarget, hostList) {
  const map = Object.fromEntries([...hostList].map((h) => [h, 1]));
  return `var H=${JSON.stringify(map)};function FindProxyForURL(url,host){return Object.prototype.hasOwnProperty.call(H,host.toLowerCase())?${JSON.stringify(pacTarget)}:"DIRECT";}`;
}

function settingsSet(value) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: 'regular' }, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve();
    });
  });
}

function settingsClear() {
  return new Promise((resolve) => chrome.proxy.settings.clear({ scope: 'regular' }, () => resolve()));
}

/** ¿Puede esta extensión cambiar el proxy? (otra extensión o una política pueden impedirlo) */
export function proxyControl() {
  if (!isProxyAvailable()) return Promise.resolve('unavailable');
  return new Promise((resolve) => chrome.proxy.settings.get({ incognito: false }, (d) => resolve(d?.levelOfControl || 'unknown')));
}

/** Aplica el PAC con los dominios actuales. Agrupa los cambios que llegan seguidos. */
function push() {
  dirty = true;
  if (pushing) return pushing;
  pushing = (async () => {
    try {
      while (dirty) {
        dirty = false;
        if (!active) { await settingsClear(); continue; }
        await settingsSet({ mode: 'pac_script', pacScript: { data: buildPac(active.pac, hosts), mandatory: true } });
      }
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

async function storeAuth(p) {
  const key = `${p.host}:${p.port}`;
  const { proxyAuth = {} } = await chrome.storage.local.get('proxyAuth');
  const next = p.user ? { [key]: { user: p.user, pass: p.pass } } : {};
  if (JSON.stringify(proxyAuth) !== JSON.stringify(next)) await chrome.storage.local.set({ proxyAuth: next });
}

/**
 * Activa un proxy para los dominios de las URL indicadas (o lo quita si proxy es null).
 * @param {ReturnType<typeof parseProxy>|null} proxy
 * @param {string[]} [urls]
 */
export async function setProxy(proxy, urls = []) {
  if (!isProxyAvailable()) {
    if (proxy) throw new Error('unavailable');
    return;
  }
  if (!proxy) {
    if (!active) return;
    active = null;
    hosts.clear();
    await push();
    return;
  }
  if (!active || active.pac !== proxy.pac || active.user !== proxy.user || active.pass !== proxy.pass) {
    active = proxy;
    hosts.clear();
    await storeAuth(proxy);
  }
  for (const u of urls) { const h = hostOf(u); if (h) hosts.add(h); }
  await push();
}

/**
 * Antes de cada petición: si hay proxy activo y el dominio es nuevo, lo añade y
 * espera a que Chrome aplique el PAC. Devuelve una promesa solo si hay que esperar.
 */
export function ensureUrl(url) {
  if (!active) return null;
  const h = hostOf(url);
  if (!h || hosts.has(h)) return pushing;
  hosts.add(h);
  return push();
}

/** Quita el proxy (al detener la reproducción o al cerrar el reproductor). */
export const clearProxy = () => setProxy(null);
