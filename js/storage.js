// Persistencia en chrome.storage.local.
//
// playlists:     [{ id, name, source: 'url'|'text'|'manual', url, updatedAt (ISO 8601), … }]
// pltext:<id>:   texto M3U de una lista 'url' / 'text' (aparte: puede ocupar varios MB)
// favorites:     [canal normalizado]
// recents:       [canal normalizado] — vistos recientemente
// state:         { playlistId, channelUrl, group, tourDone }
// prefs:         { audioLang, textLang, textOn } — idiomas preferidos para audio y subtítulos
// ui:            { largeText, tips, lang }

const area = chrome.storage.local;
const TEXT_KEY = (id) => `pltext:${id}`;
/** Texto guardado de cada lista, para escribirlo solo cuando cambia. */
const savedText = new Map();

export async function get(key, fallback) {
  const res = await area.get(key);
  return res[key] ?? fallback;
}

export async function set(key, value) {
  await area.set({ [key]: value });
}

/** Listas con su texto. Las guardadas con el texto dentro (versión anterior) se migran al guardar. */
export async function getPlaylists() {
  const lists = await get('playlists', []);
  const ids = lists.filter((p) => p.source !== 'manual' && p.text == null).map((p) => TEXT_KEY(p.id));
  const texts = ids.length ? await area.get(ids) : {};
  let legacy = false;
  for (const p of lists) {
    if (p.source === 'manual') continue;
    if (p.text == null) p.text = texts[TEXT_KEY(p.id)] || '';
    else { savedText.set(p.id, null); legacy = true; } // texto antiguo dentro de "playlists"
    if (!savedText.has(p.id)) savedText.set(p.id, p.text);
  }
  // Migración en segundo plano: el índice queda ligero desde el primer arranque.
  if (legacy) savePlaylists(lists).catch(() => {});
  return lists;
}

/** Guarda el índice de listas sin el texto; el texto de cada lista solo si ha cambiado. */
export async function savePlaylists(list) {
  const writes = {};
  const ids = new Set();
  for (const p of list) {
    ids.add(p.id);
    if (p.source !== 'manual' && savedText.get(p.id) !== p.text) {
      writes[TEXT_KEY(p.id)] = p.text || '';
      savedText.set(p.id, p.text);
    }
  }
  writes.playlists = list.map(({ text, ...meta }) => meta);
  const removed = [...savedText.keys()].filter((id) => !ids.has(id));
  removed.forEach((id) => savedText.delete(id));
  await area.set(writes);
  if (removed.length) await area.remove(removed.map(TEXT_KEY));
}
export const getFavorites = () => get('favorites', []);
export const saveFavorites = (list) => set('favorites', list);
export const getState = () => get('state', {});
export async function patchState(patch) {
  const s = await getState();
  await set('state', { ...s, ...patch });
}

export const getPrefs = () => get('prefs', { audioLang: '', textLang: '', textOn: false });
export async function patchPrefs(patch) {
  const p = await getPrefs();
  const next = { ...p, ...patch };
  await set('prefs', next);
  return next;
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
