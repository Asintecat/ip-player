// Lista virtualizada con altura de fila fija: aguanta listas de decenas de miles de canales.

export class VirtualList {
  /**
   * @param {HTMLElement} viewport contenedor con overflow:auto
   * @param {{rowHeight:number, render:(item:any, index:number)=>HTMLElement}} opts
   */
  constructor(viewport, { rowHeight, render }) {
    this.viewport = viewport;
    this.rowHeight = rowHeight;
    this.render = render;
    this.items = [];
    this.spacer = document.createElement('div');
    this.spacer.className = 'vl-spacer';
    this.layer = document.createElement('div');
    this.layer.className = 'vl-layer';
    this.spacer.appendChild(this.layer);
    viewport.appendChild(this.spacer);
    this._frame = 0;
    viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(viewport);
  }

  setItems(items) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.draw(true);
  }

  refresh() { this.draw(true); }

  schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = 0; this.draw(false); });
  }

  scrollToIndex(index) {
    const top = index * this.rowHeight;
    const vh = this.viewport.clientHeight;
    if (top < this.viewport.scrollTop || top + this.rowHeight > this.viewport.scrollTop + vh) {
      this.viewport.scrollTop = Math.max(0, top - vh / 2 + this.rowHeight / 2);
    }
    this.draw(true);
  }

  draw(force) {
    const { scrollTop, clientHeight } = this.viewport;
    const overscan = 8;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - overscan);
    const end = Math.min(this.items.length, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + overscan);
    if (!force && start === this._start && end === this._end) return;
    this._start = start;
    this._end = end;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const el = this.render(this.items[i], i);
      el.style.top = `${i * this.rowHeight}px`;
      frag.appendChild(el);
    }
    this.layer.replaceChildren(frag);
  }
}
