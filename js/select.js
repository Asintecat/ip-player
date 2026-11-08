// Desplegable propio (patrón ARIA «combobox de solo selección» + «listbox»).
//
// Mejora progresiva: el <select> nativo se queda en el DOM, oculto, como fuente de
// verdad. Encima se pinta un botón y, al abrirlo, una lista. Todo el código que ya usa
// select.value, el evento change o new Option sigue funcionando igual.
//
// Teclado: ↑ ↓ Inicio Fin para moverse, Intro/Espacio para elegir, Esc para cerrar,
// Tab para salir y letras para saltar a la opción que empieza así.

const ns = 'http://www.w3.org/2000/svg';
const enhanced = new Set();
let menu = null;
let current = null; // { select, button }
let typed = '';
let typedTimer = 0;
let uid = 0;

function icon(id, cls) {
  const svg = document.createElementNS(ns, 'svg');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement('div');
  menu.className = 'pop select-menu';
  menu.setAttribute('role', 'listbox');
  menu.tabIndex = -1;
  menu.addEventListener('keydown', onMenuKey);
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.select-opt');
    if (opt && !opt.disabled) choose(Number(opt.dataset.index));
  });
  return menu;
}

/** Convierte un <select> en desplegable propio (una sola vez por elemento). */
export function enhanceSelect(select) {
  if (select._custom) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select-btn';
  button.id = select.id ? `${select.id}Btn` : `selectBtn${++uid}`;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (select.dataset.tip) { button.dataset.tip = select.dataset.tip; delete select.dataset.tip; }
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  const value = document.createElement('span');
  value.className = 'select-value';
  value.dataset.noI18n = '';
  button.append(value, icon('i-down', 'select-caret'));

  select.classList.add('select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  // El botón va antes: así es el control de la <label> que lo rodea (clic en el texto = abrir).
  select.before(button);

  const sync = () => {
    const opt = select.selectedOptions[0];
    value.textContent = opt ? opt.textContent : '';
    button.disabled = select.disabled;
    if (current?.select === select) render();
  };
  // Los cambios hechos por código (select.value = …) no lanzan eventos: se interceptan.
  const proto = HTMLSelectElement.prototype;
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); sync(); }
    });
  }
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  select.addEventListener('change', sync);

  button.addEventListener('click', () => (current?.select === select ? close() : open(select, button)));
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      open(select, button);
    }
  });

  select._custom = { button, sync };
  enhanced.add(select);
  sync();
}

export function enhanceSelects(root = document) {
  for (const s of root.querySelectorAll('select')) enhanceSelect(s);
}

/** Vuelve a pintar el texto de todos los botones (p. ej. tras cambiar de idioma). */
export function refreshSelects() {
  for (const s of enhanced) s._custom.sync();
}

export const isSelectOpen = () => !!current;

function render() {
  const { select } = current;
  menu.replaceChildren();
  [...select.options].forEach((o, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'select-opt';
    b.id = `${current.button.id}-opt${i}`;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(o.selected));
    b.dataset.index = String(i);
    b.disabled = o.disabled;
    b.tabIndex = -1;
    const label = document.createElement('span');
    label.className = 'select-opt-label';
    label.textContent = o.textContent;
    b.append(label, icon('i-check', 'select-check'));
    menu.appendChild(b);
  });
}

function open(select, button) {
  if (select.disabled) return;
  close(false);
  ensureMenu();
  current = { select, button };
  render();
  const host = button.closest('dialog[open]') || document.body;
  if (menu.parentElement !== host) host.appendChild(menu);
  menu.setAttribute('aria-labelledby', button.id);
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-controls', 'selectMenu');
  menu.id = 'selectMenu';
  menu.dataset.open = '';
  position();
  focusOption(Math.max(0, select.selectedIndex));
  document.addEventListener('pointerdown', onOutside, true);
  addEventListener('resize', onViewportChange, { passive: true });
  document.addEventListener('scroll', onScroll, true);
}

function position() {
  const r = current.button.getBoundingClientRect();
  menu.style.minWidth = `${Math.round(r.width)}px`;
  menu.style.maxWidth = `${Math.max(Math.round(r.width), Math.min(360, innerWidth - 16))}px`;
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  const below = innerHeight - r.bottom - 8;
  const up = below < Math.min(h, 220) && r.top > below;
  const top = up ? Math.max(8, r.top - h - 4) : r.bottom + 4;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8)))}px`;
  menu.style.maxHeight = `${Math.round(Math.max(160, (up ? r.top : below) - 12))}px`;
  menu.style.transformOrigin = up ? 'center bottom' : 'center top';
}

function close(refocus = true) {
  if (!current) return;
  const { button } = current;
  current = null;
  delete menu.dataset.open;
  button.setAttribute('aria-expanded', 'false');
  button.removeAttribute('aria-activedescendant');
  document.removeEventListener('pointerdown', onOutside, true);
  removeEventListener('resize', onViewportChange);
  document.removeEventListener('scroll', onScroll, true);
  if (refocus) button.focus({ preventScroll: true });
}

function choose(index) {
  const { select } = current;
  const changed = select.selectedIndex !== index;
  select.selectedIndex = index;
  close();
  if (changed) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function options() {
  return [...menu.querySelectorAll('.select-opt:not(:disabled)')];
}

function focusOption(index) {
  const opt = menu.querySelector(`.select-opt[data-index="${index}"]`) || options()[0];
  if (!opt) return;
  opt.focus({ preventScroll: true });
  opt.scrollIntoView({ block: 'nearest' });
  current.button.setAttribute('aria-activedescendant', opt.id);
}

function onMenuKey(e) {
  if (!current) return;
  const opts = options();
  const i = opts.indexOf(document.activeElement);
  const move = (j) => { e.preventDefault(); focusOption(Number(opts[Math.max(0, Math.min(opts.length - 1, j))].dataset.index)); };
  e.stopPropagation();
  switch (e.key) {
    case 'ArrowDown': return move(i + 1);
    case 'ArrowUp': return move(i - 1);
    case 'Home': return move(0);
    case 'End': return move(opts.length - 1);
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (opts[i]) choose(Number(opts[i].dataset.index));
      return;
    case 'Escape':
      e.preventDefault();
      close();
      return;
    case 'Tab':
      close(false);
      return;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        typed += e.key.toLowerCase();
        clearTimeout(typedTimer);
        typedTimer = setTimeout(() => { typed = ''; }, 600);
        const hit = opts.find((o) => o.textContent.trim().toLowerCase().startsWith(typed));
        if (hit) focusOption(Number(hit.dataset.index));
      }
  }
}

function onOutside(e) {
  if (menu.contains(e.target) || current?.button.contains(e.target)) return;
  close(false);
}

function onViewportChange() { close(false); }

function onScroll(e) {
  if (menu.contains(e.target)) return;
  close(false);
}
