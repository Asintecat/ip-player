// Controles propios del reproductor, comunes a Shaka Player y dash.js.
// El motor activo se expone mediante un "adaptador" con esta forma:
//   qualities() → [{id, height, bandwidth}]   currentQuality() → {height, bandwidth}|null
//   isAutoQuality()  setQuality(id|'auto')
//   audioTracks() → [{id, lang, label, sub, active}]  setAudio(id)
//   textTracks()  → [{id, lang, label, sub, active}]  setText(id|null)
// (sub = detalles secundarios: «5.1», «Audiodescripción», «CC», «Forzados»…)
//   isLive()  seekRange() → {start, end}  time()  seek(t)  goLive()

const IDLE_MS = 2600;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const langNames = new Intl.DisplayNames(['es'], { type: 'language' });

export function langName(code) {
  if (!code || code === 'und') return '';
  try {
    const n = langNames.of(code);
    return n.charAt(0).toUpperCase() + n.slice(1);
  } catch (_) {
    return code;
  }
}

const enNames = new Intl.DisplayNames(['en'], { type: 'language' });
function enName(code) {
  try { return code && code !== 'und' ? enNames.of(code) : ''; } catch (_) { return ''; }
}

/** Compara idiomas por su subetiqueta principal (es, es-ES, spa → misma lengua). */
export function sameLang(a, b) {
  if (!a || !b) return false;
  const base = (c) => String(c).toLowerCase().split(/[-_]/)[0];
  if (base(a) === base(b)) return true;
  const na = langName(base(a));
  return !!na && na === langName(base(b));
}

/** Nombre visible de una pista: idioma + etiqueta, sin repetir. */
export function trackName(t, i) {
  const lang = langName(t.lang);
  const label = (t.label || '').trim();
  const parts = [lang];
  // Omite etiquetas que solo repiten el idioma («English», «en», «Español»…).
  const same = [lang, t.lang, enName(t.lang)].map((x) => String(x || '').toLowerCase());
  if (label && !same.includes(label.toLowerCase())) parts.push(label);
  return parts.filter(Boolean).join(' · ') || `Pista ${i + 1}`;
}

export function qualityName(h) {
  if (!h) return '';
  if (h >= 2160) return '4K';
  return `${h}p`;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const mbps = (bw) => (bw ? `${(bw / 1e6).toFixed(bw < 1e6 ? 2 : 1)} Mb/s` : '');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
}

export class Controls {
  /**
   * @param {{root:HTMLElement, video:HTMLVideoElement, getAdapter:()=>any, onPrev:()=>void, onNext:()=>void,
   *          onPick?:(kind:'audio'|'text', track:object|null)=>void, preferredText?:()=>string}} opts
   */
  constructor({ root, video, getAdapter, onPrev, onNext, onPick, preferredText }) {
    this.root = root;
    this.onPick = onPick || (() => {});
    this.preferredText = preferredText || (() => '');
    this.lastText = null;
    this.video = video;
    this.getAdapter = getAdapter;
    this.q = (sel) => root.querySelector(sel);
    this.menu = this.q('.menu');
    this.pane = 'main';
    this.dragging = false;
    this.idleTimer = 0;
    this.clickTimer = 0;
    this.lastTap = 0;
    this.lastTapSide = '';
    this.tapTimer = 0;
    this.osdTimer = 0;
    this.enabled = false;

    this.q('[data-act="play"]').addEventListener('click', () => this.togglePlay());
    this.q('[data-act="prev"]').addEventListener('click', onPrev);
    this.q('[data-act="next"]').addEventListener('click', onNext);
    this.q('[data-act="mute"]').addEventListener('click', () => this.toggleMute());
    this.q('[data-act="live"]').addEventListener('click', () => this.goLive());
    this.q('[data-act="quality"]').addEventListener('click', () => this.toggleMenu('quality'));
    this.q('[data-act="settings"]').addEventListener('click', () => this.toggleMenu('main'));
    this.q('[data-act="cc"]').addEventListener('click', () => this.toggleSubtitles());
    this.q('[data-act="pip"]').addEventListener('click', () => this.togglePip());
    this.q('[data-act="fullscreen"]').addEventListener('click', () => this.toggleFullscreen());

    const vol = this.q('.volume input');
    vol.addEventListener('input', () => {
      video.volume = Number(vol.value);
      video.muted = video.volume === 0;
    });

    this._bindSeek();
    this._bindSurface();

    for (const ev of ['play', 'pause', 'playing', 'ended']) video.addEventListener(ev, () => this._syncPlayState());
    for (const ev of ['timeupdate', 'durationchange', 'progress', 'loadedmetadata', 'seeked']) {
      video.addEventListener(ev, () => this.updateTime());
    }
    video.addEventListener('volumechange', () => this._syncVolume());
    video.addEventListener('waiting', () => this.setBusy(true));
    video.addEventListener('playing', () => this.setBusy(false));
    video.addEventListener('canplay', () => this.setBusy(false));
    document.addEventListener('fullscreenchange', () => {
      root.dataset.fullscreen = document.fullscreenElement === root ? '1' : '';
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.menu.dataset.open == null) return;
      if (this.menu.contains(e.target) || e.target.closest('[data-act="settings"], [data-act="quality"]')) return;
      this.closeMenu();
    });

    if (!document.pictureInPictureEnabled) this.q('[data-act="pip"]').hidden = true;
    this._syncPlayState();
    this._syncVolume();
  }

  // ---------- Estado general ----------

  /** Activa los controles cuando hay algo cargado. */
  setEnabled(on) {
    this.enabled = on;
    this.root.dataset.ready = on ? '1' : '';
    if (!on) this.closeMenu();
    this.refreshTracks();
    this.updateTime();
  }

  setBusy(on) { this.root.dataset.busy = on ? '1' : ''; }

  _syncPlayState() {
    this.root.dataset.paused = this.video.paused ? '1' : '';
    this.q('[data-act="play"]').dataset.tip = this.video.paused ? 'Reproducir' : 'Pausa';
    this.wake();
  }

  _syncVolume() {
    const v = this.video;
    const level = v.muted ? 0 : v.volume;
    this.q('.volume input').value = String(level);
    this.q('.volume').style.setProperty('--level', `${level * 100}%`);
    this.root.dataset.muted = level === 0 ? '1' : '';
  }

  togglePlay() {
    if (!this.enabled) return;
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  toggleMute() {
    const v = this.video;
    if (v.muted || v.volume === 0) {
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
    } else {
      v.muted = true;
    }
  }

  nudgeVolume(delta) {
    const v = this.video;
    v.muted = false;
    v.volume = Math.min(1, Math.max(0, v.volume + delta));
  }

  seekBy(delta) {
    const a = this.getAdapter();
    if (!a || !this.enabled) return;
    const r = a.seekRange();
    a.seek(Math.min(r.end, Math.max(r.start, a.time() + delta)));
  }

  goLive() {
    const a = this.getAdapter();
    if (a?.isLive()) a.goLive();
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch (_) { /* no disponible */ }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen().catch(() => {});
  }

  // ---------- Ocultación automática ----------

  wake() {
    this.root.dataset.idle = '';
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const kbdFocus = this.root.querySelector('.controls :focus-visible');
      if (!this.video.paused && this.menu.dataset.open == null && !this.dragging && this.enabled && !kbdFocus) {
        this.root.dataset.idle = '1';
      }
    }, IDLE_MS);
  }

  _bindSurface() {
    const surface = this.q('.surface');
    this.root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') this.wake(); });
    this.root.addEventListener('pointerleave', () => {
      if (!this.video.paused && this.menu.dataset.open == null && this.enabled) this.root.dataset.idle = '1';
    });

    surface.addEventListener('pointerup', (e) => {
      if (this.menu.dataset.open != null) { this.closeMenu(); return; }
      if (e.pointerType !== 'mouse') {
        const r = this.root.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const side = x < 0.35 ? 'left' : x > 0.65 ? 'right' : 'center';
        const now = performance.now();
        if (now - this.lastTap < 300 && side === this.lastTapSide) {
          // Doble toque
          clearTimeout(this.tapTimer);
          this.lastTap = 0;
          if (side === 'center') this.toggleFullscreen();
          else {
            this.seekBy(side === 'left' ? -10 : 10);
            this.flashTapHint(side);
          }
          return;
        }
        this.lastTap = now;
        this.lastTapSide = side;
        // Un toque muestra u oculta los controles (con un pequeño margen por si llega un segundo toque).
        clearTimeout(this.tapTimer);
        this.tapTimer = setTimeout(() => {
          if (this.root.dataset.idle === '1') this.wake();
          else if (!this.video.paused) this.root.dataset.idle = '1';
        }, 260);
        return;
      }
      clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => this.togglePlay(), 220);
    });
    surface.addEventListener('dblclick', () => {
      clearTimeout(this.clickTimer);
      this.toggleFullscreen();
    });
  }

  flashTapHint(side) {
    const el = this.q(`.tap-hint[data-side="${side}"]`);
    if (!el) return;
    el.dataset.show = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.dataset.show = ''; }, 500);
  }

  /**
   * Indicador breve en pantalla para acciones de teclado.
   * @param {string} text
   * @param {{icon?:string, level?:number}} [opts] level 0..1 dibuja una barra (volumen)
   */
  osd(text, { icon: iconId, level } = {}) {
    const box = this.q('.osd');
    if (!box) return;
    box.replaceChildren();
    if (iconId) box.appendChild(icon(iconId));
    box.appendChild(el('span', '', text));
    if (level != null) {
      const bar = el('span', 'osd-bar');
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(level * 100)}%`;
      bar.appendChild(fill);
      box.appendChild(bar);
    }
    box.dataset.show = '1';
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => { box.dataset.show = ''; }, 900);
  }

  // ---------- Barra de progreso ----------

  _bindSeek() {
    const bar = this.q('.seek');
    const tip = this.q('.seek-tip');
    const ratioAt = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    const timeAt = (ratio) => {
      const range = this.getAdapter()?.seekRange() || { start: 0, end: 0 };
      return range.start + ratio * (range.end - range.start);
    };
    const tipText = (ratio) => {
      const a = this.getAdapter();
      if (a?.isLive()) {
        const range = a.seekRange();
        const behind = (range.end - range.start) * (1 - ratio);
        return behind < 1 ? 'En directo' : `-${fmtTime(behind)}`;
      }
      return fmtTime(timeAt(ratio));
    };

    bar.addEventListener('pointermove', (e) => {
      const ratio = ratioAt(e);
      tip.textContent = tipText(ratio);
      bar.style.setProperty('--hover', `${ratio * 100}%`);
      if (this.dragging) bar.style.setProperty('--played', `${ratio * 100}%`);
    });
    bar.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      bar.setPointerCapture(e.pointerId);
      bar.dataset.dragging = '1';
      bar.style.setProperty('--played', `${ratioAt(e) * 100}%`);
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      bar.dataset.dragging = '';
      this.getAdapter()?.seek(timeAt(ratioAt(e)));
      this.wake();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', () => { this.dragging = false; bar.dataset.dragging = ''; });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { this.seekBy(5); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.seekBy(-5); e.preventDefault(); }
    });
  }

  updateTime() {
    const a = this.getAdapter();
    const bar = this.q('.seek');
    const timeEl = this.q('.time');
    const live = this.q('[data-act="live"]');
    if (!a || !this.enabled) {
      timeEl.textContent = '';
      bar.style.setProperty('--played', '0%');
      bar.style.setProperty('--buffered', '0%');
      this.root.dataset.live = '';
      return;
    }
    const range = a.seekRange();
    const span = Math.max(0, range.end - range.start);
    const t = a.time();
    const isLive = a.isLive();
    this.root.dataset.live = isLive ? '1' : '';
    this.root.dataset.dvr = !isLive || span > 60 ? '1' : '';

    if (!this.dragging) {
      bar.style.setProperty('--played', span ? `${Math.min(100, Math.max(0, ((t - range.start) / span) * 100))}%` : '0%');
    }
    const v = this.video;
    if (!isLive && v.buffered.length && Number.isFinite(v.duration) && v.duration > 0) {
      bar.style.setProperty('--buffered', `${(v.buffered.end(v.buffered.length - 1) / v.duration) * 100}%`);
    } else {
      bar.style.setProperty('--buffered', '0%');
    }

    const pct = span ? Math.round(Math.min(100, Math.max(0, ((t - range.start) / span) * 100))) : 0;
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', isLive ? 'En directo' : `${fmtTime(t)} de ${fmtTime(range.end)}`);

    if (isLive) {
      const behind = range.end - t;
      const atEdge = behind < 15;
      live.dataset.edge = atEdge ? '1' : '';
      live.dataset.tip = atEdge ? 'Estás viendo el directo' : 'Volver al directo';
      timeEl.textContent = !atEdge && span > 60 ? `-${fmtTime(behind)}` : '';
    } else {
      timeEl.textContent = `${fmtTime(t)} / ${fmtTime(range.end)}`;
    }
  }

  // ---------- Pistas y menú ----------

  /** Activa o desactiva los subtítulos (botón CC / tecla C). */
  toggleSubtitles() {
    const a = this.getAdapter();
    if (!a || !this.enabled) return;
    const text = a.textTracks();
    if (!text.length) return;
    const active = text.find((t) => t.active);
    if (active) {
      this.lastText = active;
      a.setText(null);
      this.onPick('text', null);
    } else {
      // Recupera la última pista usada, si no la preferida, si no la primera.
      const pref = this.lastText?.lang || this.preferredText();
      const t = (this.lastText && text.find((x) => x.id === this.lastText.id && sameLang(x.lang, this.lastText.lang)))
        || text.find((x) => sameLang(x.lang, pref) && !x.forced)
        || text.find((x) => !x.forced) || text[0];
      a.setText(t.id);
      this.onPick('text', t);
    }
    this.refreshTracks();
  }

  refreshTracks() {
    const a = this.getAdapter();
    const cc = this.q('[data-act="cc"]');
    const text = a && this.enabled ? a.textTracks() : [];
    cc.hidden = !text.length;
    const on = text.some((t) => t.active);
    this.root.dataset.cc = on ? '1' : '';
    cc.setAttribute('aria-pressed', String(on));
    cc.dataset.tip = on ? 'Desactivar subtítulos' : 'Activar subtítulos';
    const chip = this.q('[data-act="quality"]');
    const qs = a && this.enabled ? a.qualities() : [];
    if (qs.length > 1) {
      const cur = a.currentQuality();
      const name = qualityName(cur?.height);
      chip.hidden = false;
      chip.textContent = a.isAutoQuality() ? (name ? `Auto · ${name}` : 'Auto') : name;
      chip.dataset.hd = cur?.height >= 720 ? '1' : '';
    } else {
      chip.hidden = true;
    }
    if (this.menu.dataset.open != null) this.renderMenu(this.pane);
  }

  toggleMenu(pane) {
    if (this.menu.dataset.open != null && this.pane === pane) { this.closeMenu(); return; }
    if (!this.enabled) return;
    this.renderMenu(pane);
    this.menu.dataset.open = '';
    this.wake();
  }

  closeMenu() {
    delete this.menu.dataset.open;
    this.wake();
  }

  renderMenu(pane) {
    this.pane = pane;
    const a = this.getAdapter();
    const menu = this.menu;
    menu.replaceChildren();
    if (!a) return;

    const qualities = a.qualities();
    const audio = a.audioTracks();
    const text = a.textTracks();
    const isLive = a.isLive();

    const header = (title) => {
      const h = el('button', 'menu-head');
      h.type = 'button';
      h.append(icon('i-prev'), el('span', '', title));
      h.addEventListener('click', () => this.renderMenu('main'));
      menu.appendChild(h);
    };
    const option = (label, sub, selected, onPick) => {
      const b = el('button', 'menu-opt');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(selected));
      const check = icon('i-check');
      check.classList.add('check');
      b.append(check, el('span', 'opt-label', label));
      if (sub) b.appendChild(el('span', 'opt-sub', sub));
      b.addEventListener('click', () => { onPick(); this.refreshTracks(); this.renderMenu(pane); });
      menu.appendChild(b);
    };
    const row = (label, value, target) => {
      const b = el('button', 'menu-row');
      b.type = 'button';
      b.append(el('span', 'row-label', label), el('span', 'row-value', value), icon('i-next'));
      b.addEventListener('click', () => this.renderMenu(target));
      menu.appendChild(b);
    };

    if (pane === 'main') {
      const cur = a.currentQuality();
      if (qualities.length > 1) {
        row('Calidad', a.isAutoQuality() ? `Auto${cur ? ' · ' + qualityName(cur.height) : ''}` : qualityName(cur?.height), 'quality');
      }
      if (audio.length > 1) {
        const i = audio.findIndex((t) => t.active);
        row('Audio', i >= 0 ? trackName(audio[i], i) : '—', 'audio');
      }
      if (text.length) {
        const i = text.findIndex((t) => t.active);
        row('Subtítulos', i >= 0 ? trackName(text[i], i) : 'Desactivados', 'text');
      }
      if (!isLive) {
        const r = this.video.playbackRate;
        row('Velocidad', r === 1 ? 'Normal' : `${r}×`, 'speed');
      }
      if (!menu.children.length) menu.appendChild(el('div', 'menu-empty', 'No hay opciones para este stream'));
      return;
    }

    if (pane === 'quality') {
      header('Calidad');
      const auto = a.isAutoQuality();
      const cur = a.currentQuality();
      option('Automática', auto && cur ? qualityName(cur.height) : '', auto, () => a.setQuality('auto'));
      for (const q of qualities) {
        option(qualityName(q.height), mbps(q.bandwidth), !auto && cur?.height === q.height, () => a.setQuality(q.id));
      }
    } else if (pane === 'audio') {
      header('Audio');
      audio.forEach((t, i) => option(trackName(t, i), t.sub || '', t.active, () => { a.setAudio(t.id); this.onPick('audio', t); }));
    } else if (pane === 'text') {
      header('Subtítulos');
      option('Desactivados', '', !text.some((t) => t.active), () => { a.setText(null); this.onPick('text', null); });
      text.forEach((t, i) => option(trackName(t, i), t.sub || '', t.active, () => { a.setText(t.id); this.lastText = t; this.onPick('text', t); }));
    } else if (pane === 'speed') {
      header('Velocidad');
      for (const s of SPEEDS) {
        option(s === 1 ? 'Normal' : `${s}×`, '', this.video.playbackRate === s, () => { this.video.playbackRate = s; });
      }
    }
  }
}
