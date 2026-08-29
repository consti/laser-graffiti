import { CHANNEL, DEFAULT_SETTINGS, HOT_CORNER, menuLayout, drawStroke, withSymmetry } from './shared.js';

const bc = new BroadcastChannel(CHANNEL);
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const hint = document.getElementById('hint');

let strokes = [];                 // [{id,color,brush,size,symmetry,pts:[{x,y}],lastT}]
let settings = { ...DEFAULT_SETTINGS };
let cal = null;                   // null | {kind:'black'} | {kind:'marker',x,y,r}
let menu = { open: false, hover: null, progress: 0, hotProgress: 0 };
let cursor = null;                // last laser position {x,y,t} for the pointer indicator
let drips = [];                   // wet ink: {x,y,len,maxLen,speed,width,color}
let sparks = [];                  // {x,y,vx,vy,born,color}
let dirty = true, lastFrame = performance.now(), spinAngle = 0;

function resize() {
  cv.width = Math.round(innerWidth * devicePixelRatio);
  cv.height = Math.round(innerHeight * devicePixelRatio);
  dirty = true;
  bc.postMessage({ t: 'proj:size', w: cv.width, h: cv.height });
}
addEventListener('resize', resize);
resize();

const animated = () => settings.fadeSeconds > 0 || settings.spin3d || drips.some(d => d.len < d.maxLen) || sparks.length || menu.open || menu.hotProgress > 0 || menu.progress > 0;

// ---------- rendering ----------
function strokeAlpha(s, now) {
  if (settings.fadeSeconds <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - (now - s.lastT) / 1000 / settings.fadeSeconds));
}

function renderScene(now) {
  const w = cv.width, h = cv.height;
  ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  if (cal) {
    if (cal.kind === 'marker') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cal.x * w, cal.y * h, cal.r * w, 0, 7); ctx.fill(); }
    return;
  }
  if (settings.spin3d) render3D(now);
  else {
    for (const s of strokes) { const a = strokeAlpha(s, now); if (a <= 0) continue; ctx.globalAlpha = a; drawStroke(ctx, w, h, s); }
    ctx.globalAlpha = 1;
    renderDrips(now);
  }
  renderSparks(now);
  renderMenu(now);
}

// 3D: strokes live on a plate at z=0; extrude by drawing several depth layers, rotate about the vertical axis.
function render3D(now) {
  const w = cv.width, h = cv.height, aspect = w / h;
  const layers = 7, depth = 0.05, f = 1.6;
  const cos = Math.cos(spinAngle), sin = Math.sin(spinAngle);
  const project = z => p => {
    const X = (p.x - 0.5), Y = (p.y - 0.5) / aspect;      // aspect-corrected units (width = 1)
    const Xr = X * cos + z * sin, Zr = -X * sin + z * cos;
    const sc = f / (f - Zr);
    return { x: 0.5 + Xr * sc, y: 0.5 + Y * sc * aspect };
  };
  // draw back layers first (sign of sin decides which side of the plate faces the viewer)
  const order = [...Array(layers).keys()].map(i => -depth + (2 * depth * i) / (layers - 1)).sort((a, b) => (a * sin) - (b * sin));
  order.forEach((z, idx) => {
    const shade = 0.35 + 0.65 * (idx / (layers - 1));
    for (const s of strokes) {
      const a = strokeAlpha(s, now); if (a <= 0) continue;
      ctx.globalAlpha = a * shade;
      drawStroke(ctx, w, h, { ...s, brush: s.brush === 'spray' ? 'round' : s.brush }, 0, project(z));
    }
  });
  ctx.globalAlpha = 1;
}

// ---------- wet ink drips ----------
function maybeSpawnDrip(s, p) {
  if (!settings.wetInk || Math.random() > 0.12) return;
  drips.push({ x: p.x, y: p.y, len: 0, maxLen: 0.03 + Math.random() * 0.12, speed: 0.02 + Math.random() * 0.03,
    width: s.size * (0.35 + Math.random() * 0.4), color: s.brush === 'rainbow' ? `hsl(${(s.pts.length * 4) % 360} 100% 60%)` : s.color, symmetry: s.symmetry, lastT: s.lastT, stroke: s });
}
function updateDrips(dt) {
  for (const d of drips) if (d.len < d.maxLen) { d.len = Math.min(d.maxLen, d.len + d.speed * dt); d.speed *= (1 - 0.6 * dt); }
}
function renderDrips(now) {
  const w = cv.width, h = cv.height;
  ctx.lineCap = 'round';
  for (const d of drips) {
    const a = strokeAlpha(d.stroke, now); if (a <= 0) continue;
    ctx.globalAlpha = a;
    withSymmetry(ctx, w, h, d.symmetry, () => {
      const x = d.x * w, y0 = d.y * h, y1 = (d.y + d.len) * h, wd = d.width * w;
      const g = ctx.createLinearGradient(x, y0, x, y1); g.addColorStop(0, d.color); g.addColorStop(1, d.color);
      ctx.strokeStyle = d.color; ctx.lineWidth = wd * 0.9; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(x, y1, wd * 0.7 * (d.len < d.maxLen ? 1 : 1.15), 0, 7); ctx.fill();
    });
  }
  ctx.globalAlpha = 1;
}

// ---------- sparkle trail ----------
function spawnSparks(p, color) {
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2, v = 0.05 + Math.random() * 0.25;
    sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.1, born: performance.now(), color: Math.random() < 0.5 ? '#fff' : color });
  }
}
function renderSparks(now) {
  const w = cv.width, h = cv.height;
  sparks = sparks.filter(s => now - s.born < 900);
  for (const s of sparks) {
    const age = (now - s.born) / 900;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(s.x * w, s.y * h, (1 - age) * 0.004 * w + 1, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function updateSparks(dt) { for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 0.5 * dt; } }

// ---------- menu ----------
function renderMenu(now) {
  const w = cv.width, h = cv.height, aspect = w / h;
  if (settings.hotCorner && !menu.open) {
    const hx = HOT_CORNER.x * w, hy = HOT_CORNER.y * h, r = HOT_CORNER.r * w;
    ctx.globalAlpha = 0.35; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `${Math.round(r * 0.9)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText('☰', hx, hy);
    if (menu.hotProgress > 0) { ctx.globalAlpha = 0.9; ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(hx, hy, r, -Math.PI / 2, -Math.PI / 2 + menu.hotProgress * 2 * Math.PI); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (!menu.open) return;
  const { items, panel } = menuLayout(aspect);
  ctx.fillStyle = 'rgba(20,20,28,0.88)';
  roundRect(panel.x * w, panel.y * h, panel.w * w, panel.h * h, 0.012 * w); ctx.fill();
  for (const it of items) {
    const x = it.x * w, y = it.y * h, iw = it.w * w, ih = it.h * h;
    const active = isActive(it);
    ctx.fillStyle = active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
    roundRect(x, y, iw, ih, 0.006 * w); ctx.fill();
    if (active) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
    if (it.kind === 'color') { ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(x + iw / 2, y + ih / 2, Math.min(iw, ih) * 0.3, 0, 7); ctx.fill(); }
    else {
      ctx.fillStyle = '#fff'; ctx.font = `${Math.round(ih * 0.22)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let label = it.label;
      if (it.id === 'action:symmetry') label = settings.symmetry > 1 ? `mirror ×${settings.symmetry}` : 'mirror off';
      ctx.fillText(label, x + iw / 2, y + ih / 2);
    }
    if (menu.hover === it.id && menu.progress > 0) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x + iw / 2, y + ih / 2, Math.min(iw, ih) * 0.42, -Math.PI / 2, -Math.PI / 2 + menu.progress * 2 * Math.PI); ctx.stroke();
    }
  }
  // laser cursor
  if (cursor && now - cursor.t < 300) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cursor.x * w, cursor.y * h, 0.008 * w, 0, 7); ctx.stroke(); }
}
function isActive(it) {
  if (it.kind === 'color') return settings.color === it.value;
  if (it.kind === 'brush') return settings.brush === it.value;
  if (it.kind === 'toggle') return it.value === 'fade' ? settings.fadeSeconds > 0 : !!settings[it.value];
  if (it.id === 'action:symmetry') return settings.symmetry > 1;
  return false;
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

// ---------- frame loop ----------
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  if (settings.spin3d) spinAngle += dt * 0.9;
  updateDrips(dt); updateSparks(dt);
  if (animated()) dirty = true;
  if (dirty) { renderScene(now); dirty = false; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- messages ----------
bc.onmessage = ({ data: m }) => {
  switch (m.t) {
    case 'pt': {
      let s = strokes[strokes.length - 1];
      if (m.newStroke || !s || s.id !== m.id) {
        s = { id: m.id, color: m.color, brush: m.brush, size: m.size, symmetry: m.symmetry, pts: [], lastT: 0 };
        strokes.push(s);
      }
      s.pts.push({ x: m.x, y: m.y });
      s.lastT = performance.now();
      cursor = { x: m.x, y: m.y, t: performance.now() };
      maybeSpawnDrip(s, { x: m.x, y: m.y });
      if (settings.sparkle) spawnSparks({ x: m.x, y: m.y }, s.color);
      if (!cal && !animated()) drawStroke(ctx, cv.width, cv.height, s, s.pts.length - 1); // incremental fast path
      else dirty = true;
      break;
    }
    case 'cursor': cursor = { x: m.x, y: m.y, t: performance.now() }; if (menu.open) dirty = true; break;
    case 'clear': strokes = []; drips = []; sparks = []; dirty = true; break;
    case 'undo': { const s = strokes.pop(); drips = drips.filter(d => d.stroke !== s); dirty = true; break; }
    case 'sync': strokes = m.strokes; settings = { ...DEFAULT_SETTINGS, ...m.settings }; drips = []; dirty = true; break;
    case 'settings': settings = { ...DEFAULT_SETTINGS, ...m.settings }; dirty = true; break;
    case 'menu': menu = { ...menu, ...m.menu }; dirty = true; break;
    case 'cal': cal = m.kind === 'off' ? null : m; dirty = true; break;
    case 'hello': bc.postMessage({ t: 'proj:size', w: cv.width, h: cv.height }); break;
  }
  if (m.t !== 'proj:size') hint.classList.add('hidden');
};

function goFullscreen() { document.documentElement.requestFullscreen?.().catch(() => {}); }
addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFullscreen(); });
addEventListener('dblclick', goFullscreen);
addEventListener('fullscreenchange', () => document.body.classList.toggle('live', !!document.fullscreenElement));
bc.postMessage({ t: 'proj:hello' });
