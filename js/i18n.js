// Traducciones de la interfaz. El castellano es el idioma original: sus textos son
// las claves. Cada otro idioma es un archivo locales/<código>.json con la forma
// { "Texto en castellano": "Traducción" }; se descarga al elegirlo.
//
// t('Texto en castellano', { var }) devuelve la traducción del idioma activo; las
// variables se escriben {var} dentro del texto. Si falta una clave, se usa el castellano.
//
// El HTML estático (textos y atributos placeholder, aria-label, data-tip, title,
// data-kbd) se traduce con initI18n() al arrancar; translateStatic() lo repite al
// cambiar de idioma sin recargar la página.

/** Idiomas del menú. Los que tienen variantes (dialectos) se muestran como submenú. */
export const LANGS = [
  { code: 'es', name: 'Español' },
  { code: 'en', name: 'English' },
  { code: 'ca', name: 'Català' },
  { code: 'eu', name: 'Euskara' },
  { code: 'fr', name: 'Français' },
  {
    name: 'Português',
    variants: [
      { code: 'pt-PT', name: 'Português (Portugal)', short: 'Portugal' },
      { code: 'pt-BR', name: 'Português (Brasil)', short: 'Brasil' }
    ]
  }
];
const CODES = LANGS.flatMap((l) => (l.variants ? l.variants.map((v) => v.code) : [l.code]));
const ATTRS = ['placeholder', 'aria-label', 'data-tip', 'title', 'data-kbd'];

let lang = 'es';
let dict = {};
let registry = null;
const cache = new Map();

/** Idioma del navegador si está disponible; si no, inglés. */
export function detectLang() {
  for (const l of navigator.languages || [navigator.language || '']) {
    const code = String(l).toLowerCase();
    if (code.startsWith('pt')) return code.includes('br') ? 'pt-BR' : 'pt-PT';
    const base = code.split('-')[0];
    if (CODES.includes(base)) return base;
  }
  return 'en';
}

function loadDict(code) {
  if (!cache.has(code)) {
    cache.set(code, fetch(new URL(`../locales/${code}.json`, import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})));
  }
  return cache.get(code);
}

/** Cambia de idioma (descarga su JSON la primera vez). */
export async function setLang(code) {
  const next = CODES.includes(code) ? code : 'es';
  dict = next === 'es' ? {} : await loadDict(next);
  lang = next;
  document.documentElement.lang = lang;
}

export const getLang = () => lang;
/** Código para Intl (fechas, nombres de idiomas…). */
export const locale = () => lang;

export function t(key, vars) {
  let s = dict[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Registra los textos fijos del documento (antes de pintar nada dinámico) y los traduce. */
export function initI18n(root = document.body) {
  registry = { texts: [], attrs: [] };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.closest('script, style, svg, [data-no-i18n]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue;
    registry.texts.push({ node: n, key: raw.replace(/\s+/g, ' ').trim(), lead: raw.match(/^\s*/)[0], trail: raw.match(/\s*$/)[0] });
  }
  for (const el of root.querySelectorAll('*')) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.trim()) registry.attrs.push({ el, a, key: v });
    }
  }
  translateStatic();
}

/** Vuelve a traducir los textos fijos al idioma activo. */
export function translateStatic() {
  if (!registry) return;
  for (const it of registry.texts) it.node.nodeValue = it.lead + t(it.key) + it.trail;
  for (const it of registry.attrs) it.el.setAttribute(it.a, t(it.key));
}
