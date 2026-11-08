// Persistencia en chrome.storage.local.
//
// playlists: [{ id, name, source: 'url'|'text', url, text, updatedAt (ISO 8601) }]
// favorites: [canal normalizado + { favId }]
// state:     { playlistId, channelUrl, group }

const area = chrome.storage.local;

export async function get(key, fallback) {
  const res = await area.get(key);
  return res[key] ?? fallback;
}

export async function set(key, value) {
  await area.set({ [key]: value });
}

export const getPlaylists = () => get('playlists', []);
export const savePlaylists = (list) => set('playlists', list);
export const getFavorites = () => get('favorites', []);
export const saveFavorites = (list) => set('favorites', list);
export const getState = () => get('state', {});
export async function patchState(patch) {
  const s = await getState();
  await set('state', { ...s, ...patch });
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
