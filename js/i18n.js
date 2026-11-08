// Traducciones de la interfaz: castellano (original), inglés, catalán, euskera y francés.
//
// t('Texto en castellano', { var }) devuelve la traducción del idioma activo; las
// variables se escriben {var} dentro del texto. Las traducciones están en locales.js
// con la clave en castellano: { 'Clave': [en, ca, eu, fr] }.
//
// El HTML estático (textos y atributos placeholder, aria-label, data-tip, title,
// data-kbd) se traduce con initI18n() al arrancar; translateStatic() lo repite al
// cambiar de idioma sin recargar la página.

import DICT from './locales.js';

export const LANGS = [
  ['es', 'Español'],
  ['en', 'English'],
  ['ca', 'Català'],
  ['eu', 'Euskara'],
  ['fr', 'Français']
];
const COLUMN = { en: 0, ca: 1, eu: 2, fr: 3 };
const ATTRS = ['placeholder', 'aria-label', 'data-tip', 'title', 'data-kbd'];

let lang = 'es';
let registry = null;

/** Idioma del navegador si está disponible; si no, inglés. */
export function detectLang() {
  for (const l of navigator.languages || [navigator.language || '']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (LANGS.some(([code]) => code === base)) return base;
  }
  return 'en';
}

export function setLang(code) {
  lang = LANGS.some(([c]) => c === code) ? code : 'es';
  document.documentElement.lang = lang;
}

export const getLang = () => lang;
/** Código para Intl (fechas, nombres de idiomas…). */
export const locale = () => lang;

export function t(key, vars) {
  let s = key;
  if (lang !== 'es') {
    const row = DICT[key];
    if (row && row[COLUMN[lang]]) s = row[COLUMN[lang]];
  }
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
