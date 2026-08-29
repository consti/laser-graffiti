// Scene: the drawing surface renderer shared by the projector window, the landing-page demo and snapshots.
import { DEFAULT_SETTINGS, HOT_CORNER, menuLayout, drawStroke, withSymmetry, boardGeometry } from './shared.js';

export class Scene {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.strokes = []; this.settings = { ...DEFAULT_SETTINGS };
    this.cal = null; this.menu = { open: false, hover: null, progress: 0, hotProgress: 0 };
    this.cursor = null; this.drips = []; this.sparks = []; this.game = null;
    this.dirty = true; this.lastFrame = performance.now(); this.spinAngle = 0; this.running = false;
    this.aspect = () => this.cv.width / this.cv.height;
  }
  start() { if (!this.running) { this.running = true; requestAnimationFrame(t => this.frame(t)); } }
  setSize(w, h) { this.cv.width = w; this.cv.height = h; this.dirty = true; }
  setSettings(s) { this.settings = { ...DEFAULT_SETTINGS, ...s }; this.dirty = true; }
  setStrokes(strokes) { this.strokes = strokes; this.drips = []; this.dirty = true; }
  setMenu(m) { this.menu = { ...this.menu, ...m }; this.dirty = true; }
  setCursor(p) { this.cursor = { ...p, t: performance.now() }; if (this.menu.open) this.dirty = true; }
  setCal(c) { this.cal = c; this.dirty = true; }
  setGame(g) { this.game = g; this.dirty = true; }
  clear() { this.strokes = []; this.drips = []; this.sparks = []; this.dirty = true; }
  undo() { const s = this.strokes.pop(); this.drips = this.drips.filter(d => d.stroke !== s); this.dirty = true; }

  /** m: {id,x,y,color,brush,size,symmetry,newStroke} */
  addPoint(m) {
    let s = this.strokes[this.strokes.length - 1];
    if (m.newStroke || !s || s.id !== m.id) {
      s = { id: m.id, color: m.color, brush: m.brush, size: m.size, symmetry: m.symmetry, pts: [], lastT: 0 };
      this.strokes.push(s);
    }
    s.pts.push({ x: m.x, y: m.y });
    s.lastT = performance.now();
    this.cursor = { x: m.x, y: m.y, t: s.lastT };
    this.maybeSpawnDrip(s, m);
    if (this.settings.sparkle) this.spawnSparks(m, s.color);
    if (!this.cal && !this.animated()) drawStroke(this.ctx, this.cv.width, this.cv.height, s, s.pts.length - 1); // incremental fast path
    else this.dirty = true;
  }

  animated() {
    const s = this.settings, m = this.menu;
    return s.fadeSeconds > 0 || s.spin3d || this.drips.some(d => d.len < d.maxLen) || this.sparks.length > 0 || m.open || m.hotProgress > 0 || m.progress > 0
      || (this.game && Object.values(this.game.marks || {}).some(t => performance.now() - t < 700));
  }
  strokeAlpha(s, now) {
    if (this.settings.fadeSeconds <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - (now - s.lastT) / 1000 / this.settings.fadeSeconds));
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000); this.lastFrame = now;
    if (this.settings.spin3d) this.spinAngle += dt * 0.9;
    for (const d of this.drips) if (d.len < d.maxLen) { d.len = Math.min(d.maxLen, d.len + d.speed * dt); d.speed *= (1 - 0.6 * dt); }
    for (const s of this.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 0.5 * dt; }
    if (this.animated()) this.dirty = true;
    if (this.dirty) { this.render(now); this.dirty = false; }
    requestAnimationFrame(t => this.frame(t));
  }

  /** Full render into this.ctx (or another ctx/size for snapshots; `plain` skips menu/cursor/cal). */
  render(now = performance.now(), ctx = this.ctx, w = this.cv.width, h = this.cv.height, plain = false) {
    ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (this.cal && !plain) {
      if (this.cal.kind === 'marker') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(this.cal.x * w, this.cal.y * h, this.cal.r * w, 0, 7); ctx.fill(); }
      return;
    }
    if (this.game && this.settings.game) this.renderBoard(ctx, w, h, now);
    if (this.settings.spin3d) this.render3D(ctx, w, h, now);
    else {
      for (const s of this.strokes) { const a = this.strokeAlpha(s, now); if (a <= 0) continue; ctx.globalAlpha = a; drawStroke(ctx, w, h, s); }
      ctx.globalAlpha = 1;
      this.renderDrips(ctx, w, h, now);
    }
    if (this.game && this.settings.game) this.renderMarks(ctx, w, h, now);
    if (this.settings.border) this.renderBorder(ctx, w, h);
    if (plain) return;
    this.renderSparks(ctx, w, h, now);
    this.renderMenu(ctx, w, h, now);
  }

  renderBorder(ctx, w, h) {
    const lw = this.settings.borderWidth * (h / 1080);
    ctx.globalAlpha = 1; ctx.strokeStyle = this.settings.borderColor; ctx.lineWidth = lw;
    ctx.strokeRect(lw / 2, lw / 2, w - lw, h - lw);
  }

  render3D(ctx, w, h, now) {
    const aspect = w / h, layers = 9, depth = 0.025, f = 1.6;
    const cos = Math.cos(this.spinAngle), sin = Math.sin(this.spinAngle);
    const project = z => p => {
      const X = p.x - 0.5, Y = (p.y - 0.5) / aspect;
      const Xr = X * cos + z * sin, Zr = -X * sin + z * cos, sc = f / (f - Zr);
      return { x: 0.5 + Xr * sc, y: 0.5 + Y * sc * aspect };
    };
    const order = [...Array(layers).keys()].map(i => -depth + (2 * depth * i) / (layers - 1)).sort((a, b) => a * sin - b * sin);
    order.forEach((z, idx) => {
      const shade = 0.35 + 0.65 * (idx / (layers - 1));
      for (const s of this.strokes) {
        const a = this.strokeAlpha(s, now); if (a <= 0) continue;
        ctx.globalAlpha = a * shade;
        drawStroke(ctx, w, h, { ...s, brush: s.brush === 'spray' ? 'round' : s.brush }, 0, project(z));
      }
    });
    ctx.globalAlpha = 1;
  }

  maybeSpawnDrip(s, p) {
    if (!this.settings.wetInk || Math.random() > 0.12) return;
    this.drips.push({ x: p.x, y: p.y, len: 0, maxLen: 0.03 + Math.random() * 0.12, speed: 0.02 + Math.random() * 0.03,
      width: s.size * (0.35 + Math.random() * 0.4), color: s.brush === 'rainbow' ? `hsl(${(s.pts.length * 4) % 360} 100% 60%)` : s.color, symmetry: s.symmetry, stroke: s });
  }
  renderDrips(ctx, w, h, now) {
    ctx.lineCap = 'round';
    for (const d of this.drips) {
      const a = this.strokeAlpha(d.stroke, now); if (a <= 0) continue;
      ctx.globalAlpha = a;
      withSymmetry(ctx, w, h, d.symmetry, () => {
        const x = d.x * w, y0 = d.y * h, y1 = (d.y + d.len) * h, wd = d.width * w;
        ctx.strokeStyle = d.color; ctx.lineWidth = wd * 0.9; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(x, y1, wd * 0.7 * (d.len < d.maxLen ? 1 : 1.15), 0, 7); ctx.fill();
      });
    }
    ctx.globalAlpha = 1;
  }

  spawnSparks(p, color) {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2, v = 0.05 + Math.random() * 0.25;
      this.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1, born: performance.now(), color: Math.random() < 0.5 ? '#fff' : color });
    }
  }
  renderSparks(ctx, w, h, now) {
    this.sparks = this.sparks.filter(s => now - s.born < 900);
    for (const s of this.sparks) {
      const age = (now - s.born) / 900;
      ctx.globalAlpha = 1 - age; ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, (1 - age) * 0.004 * w + 1, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- tic-tac-toe ----------
  renderBoard(ctx, w, h, now) {
    const g = boardGeometry(w / h);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.004 * w; ctx.lineCap = 'round';
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo((g.x0 + i * g.cw) * w, g.y0 * h); ctx.lineTo((g.x0 + i * g.cw) * w, (g.y0 + 3 * g.ch) * h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g.x0 * w, (g.y0 + i * g.ch) * h); ctx.lineTo((g.x0 + 3 * g.cw) * w, (g.y0 + i * g.ch) * h); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.font = `${Math.round(0.045 * h)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.game.message || '', 0.5 * w, g.y0 * h / 2);
  }
  renderMarks(ctx, w, h, now) {
    const g = boardGeometry(w / h), gm = this.game;
    ctx.lineCap = 'round';
    gm.board.forEach((v, i) => {
      if (v !== 'O') return;
      const cx = (g.x0 + (i % 3 + 0.5) * g.cw) * w, cy = (g.y0 + (Math.floor(i / 3) + 0.5) * g.ch) * h;
      const t = Math.min(1, (now - (gm.marks?.[i] ?? 0)) / 600);
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 0.012 * w; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(cx, cy, g.ch * h * 0.3, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke();
    });
    if (gm.result?.line) {
      const [a, , c] = gm.result.line;
      const P = i => [(g.x0 + (i % 3 + 0.5) * g.cw) * w, (g.y0 + (Math.floor(i / 3) + 0.5) * g.ch) * h];
      ctx.strokeStyle = gm.result.who === 'X' ? '#3cff8a' : '#ff3333'; ctx.lineWidth = 0.015 * w; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(c)); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  // ---------- laser menu ----------
  renderMenu(ctx, w, h, now) {
    const aspect = w / h, menu = this.menu, settings = this.settings;
    if (settings.hotCorner && !menu.open) {
      const hx = HOT_CORNER.x * w, hy = HOT_CORNER.y * h, r = HOT_CORNER.r * w;
      ctx.globalAlpha = 0.35; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(hx, hy, r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `${Math.round(r * 0.9)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText('☰', hx, hy);
      if (menu.hotProgress > 0) { ctx.globalAlpha = 0.9; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(hx, hy, r, -Math.PI / 2, -Math.PI / 2 + menu.hotProgress * 2 * Math.PI); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    if (!menu.open) return;
    const { items, panel } = menuLayout(aspect);
    ctx.fillStyle = 'rgba(20,20,28,0.88)';
    ctx.beginPath(); ctx.roundRect(panel.x * w, panel.y * h, panel.w * w, panel.h * h, 0.012 * w); ctx.fill();
    for (const it of items) {
      const x = it.x * w, y = it.y * h, iw = it.w * w, ih = it.h * h;
      const active = this.isActive(it);
      ctx.fillStyle = active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.roundRect(x, y, iw, ih, 0.006 * w); ctx.fill();
      if (active) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      if (it.kind === 'color') { ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(x + iw / 2, y + ih / 2, Math.min(iw, ih) * 0.3, 0, 7); ctx.fill(); }
      else {
        ctx.fillStyle = '#fff'; ctx.font = `${Math.round(ih * 0.2)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        let label = it.label;
        if (it.id === 'action:symmetry') label = settings.symmetry > 1 ? `mirror ×${settings.symmetry}` : 'mirror off';
        ctx.fillText(label, x + iw / 2, y + ih / 2, iw * 0.92);
      }
      if (menu.hover === it.id && menu.progress > 0) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(x + iw / 2, y + ih / 2, Math.min(iw, ih) * 0.42, -Math.PI / 2, -Math.PI / 2 + menu.progress * 2 * Math.PI); ctx.stroke();
      }
    }
    if (this.cursor && now - this.cursor.t < 300) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(this.cursor.x * w, this.cursor.y * h, 0.008 * w, 0, 7); ctx.stroke(); }
  }
  isActive(it) {
    const s = this.settings;
    if (it.kind === 'color') return s.color === it.value;
    if (it.kind === 'brush') return s.brush === it.value;
    if (it.kind === 'toggle') return it.value === 'fade' ? s.fadeSeconds > 0 : !!s[it.value];
    if (it.id === 'action:symmetry') return s.symmetry > 1;
    return false;
  }
}
