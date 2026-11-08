// Guía rápida paso a paso: resalta una zona de la interfaz y explica qué hace.
//
// startTour(steps, {onDone}) — steps: [{target?: selector, title, text}]
// Los pasos cuyo objetivo no está visible (p. ej. el panel plegado) se saltan.
// Teclado: → / Intro siguiente, ← anterior, Esc cerrar.

let active = null;

function visibleRect(sel) {
  if (!sel) return null;
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return r;
}

export function isTourOpen() { return !!active; }

export function startTour(steps, { onDone } = {}) {
  if (active) active.close(false);
  const usable = steps.filter((s) => !s.target || visibleRect(s.target));
  if (!usable.length) return;

  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-spot" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText" tabindex="-1">
      <div class="tour-step" id="tourStep"></div>
      <h2 class="tour-title" id="tourTitle"></h2>
      <p class="tour-text" id="tourText"></p>
      <div class="tour-dots" aria-hidden="true"></div>
      <div class="tour-actions">
        <button type="button" class="btn ghost" data-tour="skip">Saltar guía</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-tour="prev">Atrás</button>
        <button type="button" class="btn primary" data-tour="next">Siguiente</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  const dots = root.querySelector('.tour-dots');
  const prevFocus = document.activeElement;
  let index = 0;

  dots.append(...usable.map(() => document.createElement('span')));

  function layout() {
    const step = usable[index];
    const r = visibleRect(step.target);
    const pad = 6;
    if (r) {
      spot.hidden = false;
      spot.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
      spot.style.width = `${r.width + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;
    } else {
      spot.hidden = true;
    }
    // Tarjeta junto a la zona resaltada: a la derecha, debajo, arriba o centrada.
    const c = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 14;
    let x;
    let y;
    if (!r) {
      x = (vw - c.width) / 2;
      y = (vh - c.height) / 2;
    } else if (r.right + m + c.width < vw - 8 && r.width < vw * 0.6) {
      x = r.right + m;
      y = r.top + r.height / 2 - c.height / 2;
    } else if (r.bottom + m + c.height < vh - 8) {
      x = r.left + r.width / 2 - c.width / 2;
      y = r.bottom + m;
    } else if (r.top - m - c.height > 8) {
      x = r.left + r.width / 2 - c.width / 2;
      y = r.top - m - c.height;
    } else {
      x = (vw - c.width) / 2;
      y = vh - c.height - 16;
    }
    x = Math.max(8, Math.min(vw - c.width - 8, x));
    y = Math.max(8, Math.min(vh - c.height - 8, y));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function render() {
    const step = usable[index];
    root.querySelector('#tourStep').textContent = `Paso ${index + 1} de ${usable.length}`;
    root.querySelector('#tourTitle').textContent = step.title;
    root.querySelector('#tourText').textContent = step.text;
    [...dots.children].forEach((d, i) => { d.dataset.on = i === index ? '1' : ''; });
    root.querySelector('[data-tour="prev"]').hidden = index === 0;
    root.querySelector('[data-tour="next"]').textContent = index === usable.length - 1 ? 'Entendido' : 'Siguiente';
    layout();
    card.focus({ preventScroll: true });
  }

  function go(delta) {
    const next = index + delta;
    if (next < 0) return;
    if (next >= usable.length) { close(true); return; }
    index = next;
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && e.target === card)) { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Tab') {
      // Mantiene el foco dentro de la tarjeta.
      const items = [...card.querySelectorAll('button:not([hidden])')];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    e.stopPropagation();
  }

  function close(completed) {
    window.removeEventListener('resize', layout);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    active = null;
    if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
    onDone?.(completed);
  }

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-tour]')?.dataset.tour;
    if (act === 'next') go(1);
    else if (act === 'prev') go(-1);
    else if (act === 'skip') close(false);
  });
  window.addEventListener('resize', layout);
  document.addEventListener('keydown', onKey, true);

  active = { close };
  render();
}
