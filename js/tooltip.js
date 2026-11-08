// Etiquetas emergentes accesibles para toda la interfaz.
//
// Cualquier elemento con `data-tip="Texto"` (y opcionalmente `data-kbd="K"`) muestra
// una etiqueta. También se aprovechan los `title` existentes: se convierten en
// data-tip la primera vez, para no duplicar con la etiqueta nativa del navegador.
//
// - Ratón: aparece tras una breve pausa; si ya había una visible, la siguiente sale al instante.
// - Teclado: aparece al enfocar con Tab (:focus-visible).
// - Táctil: mantener pulsado ~0,5 s la muestra sin activar el botón.

const DELAY = 450;
const GRACE = 500; // ms durante los que la siguiente etiqueta sale sin espera
const LONG_PRESS = 500;

let tipEl = null;
let current = null;
let showTimer = 0;
let lastHidden = 0;
let pressTimer = 0;
let suppressClick = false;
let enabled = true;

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.id = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function targetOf(node) {
  const el = node?.closest?.('[data-tip], [title]');
  if (!el || el.closest('.tooltip')) return null;
  // Los title de campos de texto y del estado largo se dejan como están.
  if (!el.dataset.tip && el.title) {
    if (el.matches('input, textarea, select, option, .status, .ch')) return null;
    el.dataset.tip = el.title;
    el.removeAttribute('title');
  }
  return el.dataset.tip ? el : null;
}

function place(el) {
  const tip = ensureEl();
  // En pantalla completa solo se pinta lo que está dentro del elemento a pantalla completa.
  const host = document.fullscreenElement || document.body;
  if (tip.parentElement !== host) host.appendChild(tip);

  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  let top = r.top - t.height - gap;
  let side = 'top';
  if (top < 6) { top = r.bottom + gap; side = 'bottom'; }
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(6, Math.min(window.innerWidth - t.width - 6, left));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  tip.dataset.side = side;
}

function show(el, instant) {
  if (!enabled) return;
  const tip = ensureEl();
  const kbd = el.dataset.kbd;
  tip.replaceChildren(document.createTextNode(el.dataset.tip));
  if (kbd) {
    for (const k of kbd.split(' ')) {
      const chip = document.createElement('kbd');
      chip.textContent = k;
      tip.appendChild(chip);
    }
  }
  tip.dataset.instant = instant ? '1' : '';
  tip.dataset.show = '';
  place(el);
  tip.dataset.show = '1';
  current = el;
  el.setAttribute('aria-describedby', 'tooltip');
}

export function hideTooltip() {
  clearTimeout(showTimer);
  if (!current) return;
  current.removeAttribute('aria-describedby');
  current = null;
  lastHidden = performance.now();
  if (tipEl) tipEl.dataset.show = '';
}

function schedule(el) {
  clearTimeout(showTimer);
  if (current === el) return;
  const instant = !!current || performance.now() - lastHidden < GRACE;
  if (instant) { show(el, true); return; }
  showTimer = setTimeout(() => show(el, false), DELAY);
}

export function setTooltipsEnabled(on) {
  enabled = on;
  if (!on) hideTooltip();
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = targetOf(e.target);
    if (el) schedule(el);
    else if (current && !current.contains(e.target)) hideTooltip();
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse' || !current) return;
    if (!current.contains(e.relatedTarget)) hideTooltip();
  });
  document.addEventListener('focusin', (e) => {
    const el = targetOf(e.target);
    if (el && e.target.matches(':focus-visible')) show(el, true);
  });
  document.addEventListener('focusout', () => hideTooltip());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); }, true);
  window.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('blur', hideTooltip);

  // Táctil: mantener pulsado muestra la etiqueta y anula el clic.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { hideTooltip(); return; }
    const el = targetOf(e.target);
    clearTimeout(pressTimer);
    if (!el) return;
    pressTimer = setTimeout(() => {
      show(el, false);
      suppressClick = true;
      navigator.vibrate?.(8);
    }, LONG_PRESS);
  });
  const endPress = () => {
    clearTimeout(pressTimer);
    if (suppressClick) setTimeout(hideTooltip, 1400);
  };
  document.addEventListener('pointerup', endPress);
  document.addEventListener('pointercancel', endPress);
  document.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener('contextmenu', (e) => { if (suppressClick) e.preventDefault(); });
}
