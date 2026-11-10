// Temas de temporada.
//   · Navidad: del 30 de noviembre al 6 de enero (nieve, guirnalda, gorro en el logo).
//   · Especial 29-N: el 29 de noviembre, banda rojigualda y la «banda del Peugeot»
//     (caricaturas de broma de Ábalos, Koldo y Cerdán) cruzando la pantalla.
// La preferencia puede ser 'auto' (por fecha), 'none', 'xmas' o '29n'.

import { t } from './i18n.js';

export const THEMES = ['auto', 'none', 'xmas', '29n'];

/** Tema que toca por fecha ('' si ninguno). */
export function seasonalTheme(date = new Date()) {
  const m = date.getMonth(); // 0 = enero
  const d = date.getDate();
  if (m === 10 && d === 29) return '29n';
  if ((m === 10 && d >= 30) || m === 11 || (m === 0 && d <= 6)) return 'xmas';
  return '';
}

export function resolveTheme(pref, date = new Date()) {
  if (pref === 'none') return '';
  if (pref === 'xmas' || pref === '29n') return pref;
  return seasonalTheme(date);
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let current = null;
let snow = null;

/**
 * Aplica el tema (o lo quita).
 * @param {string} name '' | 'xmas' | '29n'
 * @param {{ snow?: boolean, onHonk?: () => void }} opts
 */
export function applyTheme(name, opts = {}) {
  const faces = opts.faces || {};
  const key = `${name}|${opts.snow !== false}|${FACES.map((f) => (faces[f] || '').length).join(',')}`;
  if (key === current) return;
  current = key;
  document.documentElement.dataset.season = name || '';
  stopSnow();
  clearInterval(bubbleTimer);
  for (const n of document.querySelectorAll('[data-season-deco]')) n.remove();
  if (name === 'xmas') mountXmas(opts);
  if (name === '29n') mount29n(opts);
}

// ---------- Navidad ----------

function mountXmas(opts) {
  // Gorro de Papá Noel sobre el logo
  const brand = document.querySelector('.brand');
  if (brand) {
    const hat = document.createElement('span');
    hat.className = 'xmas-hat';
    hat.dataset.seasonDeco = '';
    hat.setAttribute('aria-hidden', 'true');
    hat.innerHTML = '<svg viewBox="0 0 40 32"><path d="M4 26C8 12 18 4 30 6c-3 4-4 9-3 14" fill="#e5484d"/><path d="M30 6c4 1 6 4 6 8" stroke="#e5484d" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="36" cy="16" r="3.6" fill="#fff"/><rect x="1" y="23" width="30" height="7" rx="3.5" fill="#fff"/></svg>';
    brand.style.position = 'relative';
    brand.appendChild(hat);
  }
  // Guirnalda de luces bajo la barra superior
  const bar = document.querySelector('.topbar');
  if (bar) {
    const lights = document.createElement('div');
    lights.className = 'xmas-lights';
    lights.dataset.seasonDeco = '';
    lights.setAttribute('aria-hidden', 'true');
    const n = Math.ceil(innerWidth / 38);
    for (let i = 0; i < n; i++) lights.appendChild(document.createElement('i'));
    bar.appendChild(lights);
  }
  if (opts.snow !== false && !reduceMotion()) startSnow();
}

/** Nieve en un canvas ligero: pocos copos, se pausa con la pestaña oculta o en pantalla completa. */
function startSnow() {
  const canvas = document.createElement('canvas');
  canvas.className = 'season-snow';
  canvas.dataset.seasonDeco = '';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const resize = () => {
    w = innerWidth;
    h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const count = Math.round(Math.min(70, Math.max(24, (w * h) / 26000)));
  const flakes = Array.from({ length: count }, () => ({
    x: Math.random() * w, y: Math.random() * h, r: 0.8 + Math.random() * 2.2,
    s: 0.25 + Math.random() * 0.7, d: Math.random() * Math.PI * 2, o: 0.25 + Math.random() * 0.5
  }));
  let raf = 0;
  let last = performance.now();
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, now - last) / 16.7;
    last = now;
    if (document.hidden || document.fullscreenElement) { ctx.clearRect(0, 0, w, h); return; }
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.s * dt;
      f.d += 0.01 * dt;
      f.x += Math.sin(f.d) * 0.3 * dt;
      if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
      if (f.x > w + 4) f.x = -4; else if (f.x < -4) f.x = w + 4;
      ctx.globalAlpha = f.o;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  };
  raf = requestAnimationFrame(frame);
  addEventListener('resize', resize);
  snow = () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
}

function stopSnow() {
  snow?.();
  snow = null;
}

// ---------- Especial 29-N ----------

// Caras: fotos que sube el usuario en Opciones (se guardan solo en su navegador).
// Sin foto, se dibuja un muñeco con pelo, gafas o barba de dibujo.
export const FACES = ['abalos', 'koldo', 'cerdan'];

/** Foto incluida (Wikimedia Commons, ver assets/29n/CREDITOS.md); la que suba el usuario tiene prioridad. */
export function defaultFace(face) {
  const path = `assets/29n/${face}.jpg`;
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path;
}
const QUOTES = ['Soy feminista porque soy socialista', '¡Amar no es delito!'];
let bubbleTimer = 0;

/** Cabeza: la foto en un círculo (muñeco cabezón) o el muñeco dibujado. */
function head(cx, style, photo) {
  if (photo) {
    return `
    <g transform="translate(${cx} 0)">
      <defs><clipPath id="n29-clip-${cx}"><circle cx="0" cy="28" r="26"/></clipPath></defs>
      <circle cx="0" cy="28" r="27.5" fill="#fff"/>
      <image data-face="${style.face}" x="-26" y="2" width="52" height="52" preserveAspectRatio="xMidYMid slice" clip-path="url(#n29-clip-${cx})"/>
    </g>`;
  }
  const { hair, glasses = false, beard = '', bald = false, skin = '#f1c7a1' } = style;
  return `
    <g transform="translate(${cx} 0)">
      <circle cx="0" cy="24" r="13" fill="${skin}"/>
      ${bald ? `<path d="M-12 20q2-9 12-10t12 10" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round" opacity=".55"/>`
             : `<path d="M-13 22q0-14 13-14t13 14q-4-6-13-6t-13 6z" fill="${hair}"/>`}
      ${beard ? `<path d="M-11 27q2 11 11 11t11-11q-3 4-11 4t-11-4z" fill="${beard}"/>` : ''}
      <circle cx="-4.5" cy="24" r="1.6" fill="#1b1b1f"/><circle cx="4.5" cy="24" r="1.6" fill="#1b1b1f"/>
      ${glasses ? '<g fill="none" stroke="#1b1b1f" stroke-width="1.3"><circle cx="-4.5" cy="24" r="3.6"/><circle cx="4.5" cy="24" r="3.6"/><path d="M-0.9 24h1.8"/></g>' : ''}
      <path d="M-4 31q4 3 8 0" fill="none" stroke="#7a3b2e" stroke-width="1.5" stroke-linecap="round"/>
    </g>`;
}

function mount29n(opts) {
  opts = { ...opts, faces: Object.fromEntries(FACES.map((f) => [f, opts.faces?.[f] || defaultFace(f)])) };
  // Banda con mensaje (se puede cerrar)
  const banner = document.createElement('div');
  banner.className = 'n29-banner';
  banner.dataset.seasonDeco = '';
  banner.setAttribute('role', 'note');
  const text = document.createElement('span');
  text.textContent = t('Especial 29-N: la banda del Peugeot vuelve a la carretera. Abróchense los cinturones.');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'n29-close';
  close.setAttribute('aria-label', t('Cerrar'));
  close.textContent = '×';
  close.addEventListener('click', () => banner.remove());
  banner.append(text, close);
  document.body.appendChild(banner);

  // El Peugeot con los tres muñecos (broma), cruzando la pantalla de vez en cuando
  const car = document.createElement('button');
  car.type = 'button';
  car.className = 'n29-car';
  car.dataset.seasonDeco = '';
  car.setAttribute('aria-label', t('La banda del Peugeot (broma del 29-N)'));
  car.dataset.tip = t('¡Mec, mec! La banda del Peugeot');
  car.innerHTML = `
    <svg viewBox="0 0 300 120" aria-hidden="true">
      <g class="n29-heads">
        ${head(92, { face: 'abalos', hair: '#9ca3af', beard: '#9ca3af' }, opts.faces?.abalos)}
        ${head(150, { face: 'koldo', hair: '#3f3f46', beard: '#27272a', bald: true, skin: '#e8b48c' }, opts.faces?.koldo)}
        ${head(208, { face: 'cerdan', hair: '#27272a', glasses: true }, opts.faces?.cerdan)}
      </g>
      <path d="M40 70q8-28 40-30h120q30 2 52 30l26 4q10 2 10 12v10H22V84q0-12 18-14z" fill="#2f5dd8"/>
      <path d="M70 70l14-24h52v24zM144 70V46h52q20 4 34 24z" fill="#cfe3ff" opacity=".35"/>
      <rect x="26" y="88" width="252" height="6" rx="3" fill="#1e3a8a"/>
      <circle cx="262" cy="80" r="5" fill="#fde68a"/>
      <g transform="translate(82 100)"><g class="n29-wheel"><circle r="16" fill="#18181b"/><circle r="7" fill="#a1a1aa"/><path d="M-6 0h12M0-6v12" stroke="#52525b" stroke-width="2"/></g></g>
      <g transform="translate(228 100)"><g class="n29-wheel"><circle r="16" fill="#18181b"/><circle r="7" fill="#a1a1aa"/><path d="M-6 0h12M0-6v12" stroke="#52525b" stroke-width="2"/></g></g>
      <text x="150" y="84" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="system-ui, sans-serif">407</text>
    </svg>
    <span class="n29-names"><b>Ábalos</b><b>Koldo</b><b>Cerdán</b></span>`;
  // Las fotos (data: URL hechas en Opciones) se asignan como atributo, no dentro del HTML
  for (const img of car.querySelectorAll('image[data-face]')) {
    img.setAttribute('href', opts.faces[img.dataset.face]);
  }
  // Bocadillo de Ábalos (citas de broma, se alternan)
  const bubble = document.createElement('span');
  bubble.className = 'n29-bubble';
  let q = 0;
  bubble.textContent = QUOTES[0];
  bubbleTimer = setInterval(() => {
    q = (q + 1) % QUOTES.length;
    bubble.classList.remove('is-new');
    void bubble.offsetWidth; // reinicia la animación
    bubble.textContent = QUOTES[q];
    bubble.classList.add('is-new');
  }, 4000);
  car.appendChild(bubble);
  car.addEventListener('click', () => opts.onHonk?.());
  document.body.appendChild(car);
}
