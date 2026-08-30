// Scene: the drawing surface renderer shared by the projector window, the landing-page demo and snapshots.
import { DEFAULT_SETTINGS, HOT_CORNER, menuLayout, drawStroke, withSymmetry, boardGeometry } from './shared.js';

const rnd01 = (i, k) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };

export class Scene {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.strokes = []; this.settings = { ...DEFAULT_SETTINGS };
    this.cal = null; this.menu = { open: false, hover: null, progress: 0, hotProgress: 0 };
    this.cursor = null; this.drips = []; this.sparks = []; this.flames = []; this.smoke = []; this.game = null;
    this.surface = null;         // camera scan of the projection surface, already warped into projector space (burn mode)
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
  /** url: data URL / image src of the surface scan in projector space (or null to forget it). */
  setSurface(url) {
    if (!url) { this.surface = null; this.dirty = true; return; }
    const img = new Image(); img.onload = () => { this.surface = img; this.dirty = true; }; img.src = url;
  }
  clear() { this.strokes = []; this.drips = []; this.sparks = []; this.flames = []; this.smoke = []; this.dirty = true; }
  undo() { const s = this.strokes.pop(); this.drips = this.drips.filter(d => d.stroke !== s); this.dirty = true; }

  /** m: {id,x,y,color,brush,size,symmetry,newStroke} */
  addPoint(m) {
    let s = this.strokes[this.strokes.length - 1];
    if (m.newStroke || !s || s.id !== m.id) {
      s = { id: m.id, color: m.color, brush: m.brush, size: m.size, symmetry: m.symmetry, pts: [], lastT: 0 };
      this.strokes.push(s);
    }
    const now = performance.now();
    s.pts.push({ x: m.x, y: m.y, t: now });
    s.lastT = now;
    this.cursor = { x: m.x, y: m.y, t: s.lastT };
    this.maybeSpawnDrip(s, m);
    if (this.settings.sparkle) this.spawnSparks(m, s.color);
    if (this.settings.flame) this.spawnFlames(m, s, 3);
    if (this.settings.burn) this.spawnEmbers(m, s);
    if (!this.cal && !this.animated()) drawStroke(this.ctx, this.cv.width, this.cv.height, s, s.pts.length - 1); // incremental fast path
    else this.dirty = true;
  }

  fx() { return this.settings.intensity ?? 1; }
  animated() {
    const s = this.settings, m = this.menu, now = performance.now();
    return s.fadeSeconds > 0 || s.spin3d || this.drips.some(d => d.len < d.maxLen) || this.sparks.length > 0 || this.flames.length > 0 || this.smoke.length > 0
      || (s.flame && this.strokes.some(st => now - st.lastT < 2000)) || (s.burn && this.strokes.some(st => now - st.lastT < this.coolMs()))
      || m.open || m.hotProgress > 0 || m.progress > 0
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
    for (const f of this.flames) { f.x += (f.vx + Math.sin(now / 90 + f.seed) * 0.03) * dt; f.y += f.vy * dt; f.vy -= 0.25 * dt; }
    for (const p of this.smoke) { p.x += (p.vx + Math.sin(now / 700 + p.seed) * 0.01) * dt; p.y += p.vy * dt; p.r += p.grow * dt; }
    if (this.settings.flame) this.keepBurning(now, dt);
    if (this.animated()) this.dirty = true;
    if (this.dirty) { try { this.render(now); } catch (e) { console.error(e); } this.dirty = false; }
    requestAnimationFrame(t => this.frame(t));
  }

  /** Full render into this.ctx (or another ctx/size for snapshots; `plain` skips menu/cursor/cal). */
  render(now = performance.now(), ctx = this.ctx, w = this.cv.width, h = this.cv.height, plain = false) {
    ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (this.settings.burn && !this.cal) this.renderAmbient(ctx, w, h);
    if (this.cal && !plain) {
      if (this.cal.kind === 'marker') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(this.cal.x * w, this.cal.y * h, this.cal.r * w, 0, 7); ctx.fill(); }
      return;
    }
    if (this.game && this.settings.game) this.renderBoard(ctx, w, h, now);
    if (this.settings.spin3d) this.render3D(ctx, w, h, now);
    else if (this.settings.burn) this.renderBurn(ctx, w, h, now);
    else {
      for (const s of this.strokes) { const a = this.strokeAlpha(s, now); if (a <= 0) continue; ctx.globalAlpha = a; drawStroke(ctx, w, h, s); }
      ctx.globalAlpha = 1;
      this.renderDrips(ctx, w, h, now);
    }
    if (this.game && this.settings.game) this.renderMarks(ctx, w, h, now);
    if (this.settings.border) this.renderBorder(ctx, w, h);
    if (plain) return;
    this.renderSmoke(ctx, w, h, now);
    this.renderFlames(ctx, w, h, now);
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
    const k = this.fx();
    if (!this.settings.wetInk || Math.random() > 0.12 * k) return;
    this.drips.push({ x: p.x, y: p.y, len: 0, maxLen: (0.03 + Math.random() * 0.12) * k, speed: (0.02 + Math.random() * 0.03) * Math.sqrt(k),
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
    const k = this.fx();
    for (let i = 0; i < Math.round(4 * k); i++) {
      const a = Math.random() * Math.PI * 2, v = (0.05 + Math.random() * 0.25) * Math.sqrt(k);
      this.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1, born: performance.now(), color: Math.random() < 0.5 ? '#fff' : color });
    }
  }
  renderSparks(ctx, w, h, now) {
    this.sparks = this.sparks.filter(s => now - s.born < 900);
    for (const s of this.sparks) {
      const age = Math.max(0, (now - s.born) / 900);
      ctx.globalAlpha = 1 - age; ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, (1 - age) * 0.004 * w + 1, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- flame ----------
  spawnFlames(p, s, n) {
    const k = this.fx(), size = s.size;
    for (let i = 0; i < Math.max(1, Math.round(n * k)); i++) {
      const spread = size * (0.6 + Math.random() * 0.6);
      this.flames.push({ x: p.x + (Math.random() - 0.5) * spread, y: p.y + (Math.random() - 0.5) * spread * 0.5,
        vx: (Math.random() - 0.5) * 0.04, vy: -(0.08 + Math.random() * 0.12) * Math.sqrt(k),
        r: size * (1.8 + Math.random() * 1.6) * Math.sqrt(k), life: (500 + Math.random() * 500) * Math.sqrt(k), born: performance.now(), seed: Math.random() * 10 });
    }
  }
  /** The freshly drawn part of the last stroke keeps burning for ~2 s (flames flicker up from the whole hot section). */
  keepBurning(now, dt) {
    const s = this.strokes[this.strokes.length - 1];
    if (!s || now - s.lastT > 2000 || s.pts.length < 2) return;
    const hot = s.pts.filter(p => now - (p.t ?? s.lastT) < 2000);
    if (!hot.length) return;
    const rate = 90 * this.fx() * Math.min(1, hot.length / 20);      // particles per second along the hot section
    let n = rate * dt + Math.random();
    while (n-- >= 1) {
      const p = hot[Math.floor(Math.random() * hot.length)];
      const age = (now - (p.t ?? s.lastT)) / 2000;
      this.spawnFlames(p, { ...s, size: s.size * (1 - 0.6 * age) }, 1 / this.fx());
    }
  }
  renderFlames(ctx, w, h, now) {
    this.flames = this.flames.filter(f => now - f.born < f.life);
    if (!this.flames.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const f of this.flames) {
      const t = Math.max(0, (now - f.born) / f.life);         // 0 = born, 1 = gone
      const r = f.r * w * (1 - 0.6 * t) * (0.8 + 0.2 * Math.sin(now / 40 + f.seed * 7));
      if (r < 0.5) continue;
      // white-yellow core → orange → deep red → nothing; tongues are stretched upwards
      const hue = 55 - 55 * Math.min(1, t * 1.3), light = 85 - 55 * t;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `hsla(${hue} 100% ${light}% / ${0.95 * (1 - t)})`);
      g.addColorStop(0.45, `hsla(${hue - 15} 100% ${light * 0.7}% / ${0.5 * (1 - t)})`);
      g.addColorStop(1, 'hsla(0 100% 30% / 0)');
      ctx.save(); ctx.translate(f.x * w, f.y * h); ctx.scale(1, 1.4 + 0.8 * t);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); ctx.restore();
    }
    ctx.restore();
  }

  // ---------- burn: scorch marks into the (camera-scanned) surface ----------
  coolMs() { return 6000 * this.fx(); }
  /** Light the wall with its own scanned texture so the unlit (black) char actually reads as a dark mark on the surface. */
  renderAmbient(ctx, w, h) {
    const amb = Math.max(0, Math.min(1, this.settings.burnAmbient ?? 0.35));
    if (amb <= 0) return;
    if (this.surface) { ctx.globalAlpha = amb; ctx.drawImage(this.surface, 0, 0, w, h); ctx.globalAlpha = 1; }
    else { ctx.fillStyle = `rgb(${Math.round(120 * amb)},${Math.round(105 * amb)},${Math.round(88 * amb)})`; ctx.fillRect(0, 0, w, h); }
  }
  spawnEmbers(p, s) {
    const k = this.fx();
    for (let i = 0; i < Math.round(2 * k); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = (0.03 + Math.random() * 0.12) * Math.sqrt(k);
      this.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: performance.now(), color: Math.random() < 0.3 ? '#fff3c0' : '#ff7a1a' });
    }
    if (Math.random() < 0.5 * k) this.smoke.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 0.02, vy: -(0.03 + Math.random() * 0.04), r: s.size * 0.6,
      grow: s.size * 1.2 * Math.sqrt(k), born: performance.now(), life: (1800 + Math.random() * 1500) * Math.sqrt(k), seed: Math.random() * 10 });
  }
  renderSmoke(ctx, w, h, now) {
    this.smoke = this.smoke.filter(p => now - p.born < p.life);
    for (const p of this.smoke) {
      const t = Math.max(0, (now - p.born) / p.life), r = Math.max(0.5, p.r * w);
      const g = ctx.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, r);
      g.addColorStop(0, `rgba(140,130,120,${0.22 * (1 - t) * (1 - t)})`); g.addColorStop(1, 'rgba(140,130,120,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x * w, p.y * h, r, 0, 7); ctx.fill();
    }
  }
  renderBurn(ctx, w, h, now) {
    const cool = this.coolMs(), k = this.fx();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      const a = this.strokeAlpha(s, now); if (a <= 0 || !s.pts.length) continue;
      const size = s.size * w, pts = s.pts;
      const P = i => [pts[i].x * w, pts[i].y * h];
      const heatAt = i => Math.min(1, Math.max(0, 1 - (now - (pts[i].t ?? s.lastT)) / cool));            // 1 = white hot, 0 = cold
      withSymmetry(ctx, w, h, s.symmetry, () => {
        // 1) heat glow around the fresh part: wide, soft, orange → dim red as it cools
        for (let i = 1; i < pts.length; i++) {
          const heat = Math.max(heatAt(i - 1), heatAt(i)); if (heat <= 0.02) continue;
          const [x0, y0] = P(i - 1), [x1, y1] = P(i);
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a * heat * 0.9;
          ctx.shadowColor = `hsl(${18 + 25 * heat} 100% ${45 + 20 * heat}%)`; ctx.shadowBlur = size * (2 + 3 * heat) * Math.sqrt(k);
          ctx.strokeStyle = `hsl(${15 + 20 * heat} 100% ${35 + 25 * heat}%)`; ctx.lineWidth = size * (0.8 + 0.8 * heat);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
        }
        // 2) ember rim: a thin glowing edge that stays dim red long after the heat is gone, brightest right at the front
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (let i = 1; i < pts.length; i++) {
          const heat = heatAt(i), age = Math.max(0, now - (pts[i].t ?? s.lastT));
          const [x0, y0] = P(i - 1), [x1, y1] = P(i);
          const flicker = 0.85 + 0.15 * Math.sin(now / 60 + i * 1.7);
          ctx.globalAlpha = a * Math.max(0.18, heat) * flicker;
          ctx.strokeStyle = heat > 0.6 ? '#ffd27a' : `hsl(${8 + 20 * heat} 100% ${28 + 30 * heat}%)`;
          ctx.lineWidth = size * (1.0 + 0.25 * heat) * Math.min(1, age / 250);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        ctx.restore();
        // 3) the char: one unlit (black) polyline cut over the ambient light, so only the rim's edge survives; the tip grows in over 250 ms
        ctx.globalAlpha = a; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
        const charW = size * 0.9;
        if (pts.length > 2) { ctx.lineWidth = charW; ctx.beginPath(); ctx.moveTo(...P(0)); for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(...P(i)); ctx.stroke(); }
        if (pts.length > 1) {
          const n = pts.length - 1, grow = Math.min(1, Math.max(0, now - (pts[n].t ?? s.lastT)) / 250);
          ctx.lineWidth = charW * (0.5 + 0.5 * grow); ctx.beginPath(); ctx.moveTo(...P(n - 1)); ctx.lineTo(...P(n)); ctx.stroke();
        }
        // ragged edge: a few deterministic scorch bites along the stroke
        for (let i = 0; i < pts.length; i += 2) {
          const [x, y] = P(i), ang = rnd01(i, s.id) * Math.PI * 2, d = charW * (0.35 + 0.2 * rnd01(i, s.id + 1));
          ctx.beginPath(); ctx.arc(x + Math.cos(ang) * d, y + Math.sin(ang) * d, charW * (0.2 + 0.2 * rnd01(i, s.id + 2)), 0, 7); ctx.fill();
        }
        if (pts.length === 1) { const [x, y] = P(0); ctx.beginPath(); ctx.arc(x, y, charW / 2, 0, 7); ctx.fill(); }
        // 4) white-hot tip while the laser is on the surface
        const tipHeat = heatAt(pts.length - 1);
        if (tipHeat > 0.97) {
          const [x, y] = P(pts.length - 1);
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a;
          const g = ctx.createRadialGradient(x, y, 0, x, y, size * 1.6 * Math.sqrt(k));
          g.addColorStop(0, 'rgba(255,255,240,0.95)'); g.addColorStop(0.35, 'rgba(255,190,80,0.6)'); g.addColorStop(1, 'rgba(255,80,0,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size * 1.6 * Math.sqrt(k), 0, 7); ctx.fill(); ctx.restore();
        }
      });
    }
    ctx.globalAlpha = 1;
    this.renderDrips(ctx, w, h, now);
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
