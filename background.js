// Service worker: abre el reproductor y añade menús contextuales.

const PLAYER_URL = chrome.runtime.getURL('player.html');

async function openPlayer(params) {
  const query = params ? '?' + new URLSearchParams(params).toString() : '';
  const tabs = await chrome.tabs.query({ url: PLAYER_URL + '*' });
  if (tabs.length && !params) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: PLAYER_URL + query });
}

chrome.action.onClicked.addListener(() => openPlayer());

// Títulos del menú contextual en el idioma elegido en IP Player (o el del navegador).
const MENU = {
  es: ['Reproducir en IP Player', 'Cargar como lista M3U en IP Player'],
  en: ['Play in IP Player', 'Load as M3U list in IP Player'],
  ca: ['Reprodueix a IP Player', 'Carrega com a llista M3U a IP Player'],
  eu: ['Erreproduzitu IP Player-en', 'Kargatu M3U zerrenda gisa IP Player-en'],
  fr: ['Lire dans IP Player', 'Charger comme liste M3U dans IP Player'],
  'pt-PT': ['Reproduzir no IP Player', 'Carregar como lista M3U no IP Player'],
  'pt-BR': ['Reproduzir no IP Player', 'Carregar como lista M3U no IP Player']
};

async function menuLang() {
  const { ui } = await chrome.storage.local.get('ui');
  if (MENU[ui?.lang]) return ui.lang;
  const browser = chrome.i18n.getUILanguage().toLowerCase();
  if (browser.startsWith('pt')) return browser.includes('br') ? 'pt-BR' : 'pt-PT';
  const base = browser.split('-')[0];
  return MENU[base] ? base : 'en';
}

async function buildMenus() {
  const [play, playlist] = MENU[await menuLang()];
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'ipp-play', title: play, contexts: ['link', 'video', 'audio'] });
  chrome.contextMenus.create({ id: 'ipp-playlist', title: playlist, contexts: ['link'] });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ui && changes.ui.oldValue?.lang !== changes.ui.newValue?.lang) buildMenus();
});

// ---------- Proxy de los streams (ver js/proxy.js) ----------

// Usuario y contraseña del proxy HTTP/HTTPS cuando lo pide. Un solo intento por
// petición: si falla, no se repite en bucle.
const authTried = new Set();
chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  if (!details.isProxy || authTried.has(details.requestId)) { callback({}); return; }
  authTried.add(details.requestId);
  setTimeout(() => authTried.delete(details.requestId), 60000);
  chrome.storage.local.get('proxyAuth').then(({ proxyAuth = {} }) => {
    const cred = proxyAuth[`${details.challenger.host}:${details.challenger.port}`];
    callback(cred ? { authCredentials: { username: cred.user, password: cred.pass } } : {});
  }, () => callback({}));
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);

/** Quita el proxy de IP Player si quedó puesto (reproductor cerrado o navegador reiniciado). */
async function releaseProxy() {
  const tabs = await chrome.tabs.query({ url: PLAYER_URL + '*' });
  if (tabs.length) return;
  chrome.proxy.settings.get({}, (d) => {
    if (d?.levelOfControl === 'controlled_by_this_extension') chrome.proxy.settings.clear({ scope: 'regular' });
  });
}
chrome.runtime.onStartup.addListener(releaseProxy);
chrome.tabs.onRemoved.addListener(() => { releaseProxy(); });

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  if (info.menuItemId === 'ipp-play') openPlayer({ play: url });
  if (info.menuItemId === 'ipp-playlist') openPlayer({ playlist: url });
});
