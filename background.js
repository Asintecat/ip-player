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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ipp-play',
      title: 'Reproducir en IP Player',
      contexts: ['link', 'video', 'audio']
    });
    chrome.contextMenus.create({
      id: 'ipp-playlist',
      title: 'Cargar como lista M3U en IP Player',
      contexts: ['link']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  if (info.menuItemId === 'ipp-play') openPlayer({ play: url });
  if (info.menuItemId === 'ipp-playlist') openPlayer({ playlist: url });
});
