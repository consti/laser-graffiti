// Shared helpers: channel name, homography math, settings, menu layout, stroke rendering.
export const CHANNEL = 'laser-graffiti';

export const COLORS = ['#ff2d95', '#ff6a00', '#ffd400', '#00e5ff', '#7c4dff', '#ffffff', '#ff3333', '#3cff8a'];
export const BRUSHES = ['round', 'marker', 'calligraphy', 'neon', 'spray', 'rainbow'];
export const SYMMETRIES = [1, 2, 4, 6, 8];

export const DEFAULT_SETTINGS = {
  color: COLORS[0], brush: 'round', size: 8 /* per-mille of width */,
  fadeSeconds: 0, wetInk: false, spin3d: false, symmetry: 1, sparkle: false, hotCorner: true,
  border: false, borderColor: '#ffffff', borderWidth: 6 /* px at 1080p */, game: false,
  menuCorner: 'tr' /* tr | tl | br | bl */, lineSmooth: 2 /* 0..10: geometric smoothing of the drawn line */, flame: false, burn: false, burnAmbient: 0.35 /* how brightly the surface is lit in burn mode */,
  intensity: 1 /* scales all effects: drips, sparks, flames, burn heat (INTENSITY_MIN..INTENSITY_MAX) */,
};
export const INTENSITY_MIN = 0.25, INTENSITY_MAX = 3;
export const clampIntensity = v => Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, Math.round(v * 100) / 100));

// ---------- tic-tac-toe board geometry (normalized projector coords) ----------
export function boardGeometry(aspect = 16 / 9) {
  const side = 0.78;                                  // fraction of height
  const ch = side / 3, cw = ch / aspect;
  return { x0: 0.5 - 1.5 * cw, y0: 0.5 - 1.5 * ch, cw, ch };
}
export function cellAt(p, aspect) {
  const g = boardGeometry(aspect);
  const c = Math.floor((p.x - g.x0) / g.cw), r = Math.floor((p.y - g.y0) / g.ch);
  return c >= 0 && c < 3 && r >= 0 && r < 3 ? r * 3 + c : -1;
}

// ---------- homography ----------
export function computeHomography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) throw new Error('need >= 4 point pairs');
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const rows = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    rows.push([[x, y, 1, 0, 0, 0, -u * x, -u * y], u]);
    rows.push([[0, 0, 0, x, y, 1, -v * x, -v * y], v]);
  }
  for (const [r, b] of rows) for (let i = 0; i < 8; i++) { Atb[i] += r[i] * b; for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j]; }
  return [...solveLinear(AtA, Atb), 1];
}
function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('degenerate calibration points');
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c]; if (!f) continue; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r[n]);
}
export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}
export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('singular homography');
  return [A, -(b * i - c * h), (b * f - c * e), B, (a * i - c * g), -(a * f - c * d), C, -(a * h - b * g), (a * e - b * d)].map(v => v / det);
}

// ---------- laser menu (normalized projector coords; both windows use the same layout) ----------
export const MENU_CORNERS = ['tr', 'tl', 'br', 'bl'];
export const MENU_CORNER_LABEL = { tr: 'top right', tl: 'top left', br: 'bottom right', bl: 'bottom left' };
export const MENU_DWELL_MS = 650, HOT_DWELL_MS = 500;
/** Hot-corner circle for the given corner (r in width units). */
export function hotCorner(corner = 'tr') {
  return { x: corner[1] === 'l' ? 0.045 : 0.955, y: corner[0] === 'b' ? 0.92 : 0.08, r: 0.035 };
}

export function menuLayout(aspect = 16 / 9, corner = 'tr') {
  const { items, panel } = menuLayoutTR(aspect);
  // keep the reading order; just slide the whole panel into the requested corner
  const dx = corner[1] === 'l' ? 0.015 - panel.x : 0, dy = corner[0] === 'b' ? (1 - 0.03 - panel.h) - panel.y : 0;
  const mv = o => ({ ...o, x: o.x + dx, y: o.y + dy });
  return { items: items.map(mv), panel: mv(panel) };
}
function menuLayoutTR(aspect) {
  const items = [];
  const cols = 5, cw = 0.055, ch = cw * aspect * 0.8;  // roughly square cells in pixels
  const x0 = 0.985 - cols * cw - (cols - 1) * 0.01, gap = 0.01;
  let y = 0.06;
  const row = (list, kind, opts = {}) => {
    list.forEach((v, i) => {
      const col = i % cols, r = Math.floor(i / cols);
      items.push({ id: `${kind}:${v.id ?? v}`, kind, value: v.value ?? v.id ?? v, label: v.label ?? String(v), color: v.color,
        x: x0 + col * (cw + gap), y: y + r * (ch + gap), w: cw, h: ch, ...opts });
    });
    y += Math.ceil(list.length / cols) * (ch + gap) + 0.012;
  };
  row(COLORS.map(c => ({ id: c, value: c, label: '', color: c })), 'color');
  row(BRUSHES.map(b => ({ id: b, value: b, label: b })), 'brush');
  row([{ id: 'wetInk', label: 'wet ink' }, { id: 'spin3d', label: 'spin 3D' }, { id: 'fade', label: 'fade' }, { id: 'sparkle', label: 'sparkle' },
       { id: 'flame', label: '🔥 flame' }, { id: 'burn', label: 'burn' }, { id: 'border', label: 'border' }, { id: 'game', label: 'tic-tac-toe' }], 'toggle');
  row([{ id: 'symmetry', label: 'mirror' }, { id: 'size-', label: 'size −' }, { id: 'size+', label: 'size +' }, { id: 'fx-', label: 'fx −' }, { id: 'fx+', label: 'fx +' },
       { id: 'undo', label: 'undo' }, { id: 'snapshot', label: '📸 snapshot' }, { id: 'corner', label: 'move menu' }, { id: 'clear', label: 'clear' }, { id: 'close', label: 'close' }], 'action');
  const panel = { x: x0 - 0.02, y: 0.03, w: 0.985 - x0 + 0.03, h: y };
  return { items, panel };
}
export function hitMenu(layout, p) {
  return layout.items.find(it => p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) || null;
}
export function inHotCorner(p, aspect, corner = 'tr') {
  const hc = hotCorner(corner);
  const dx = p.x - hc.x, dy = (p.y - hc.y) / aspect;
  return dx * dx + dy * dy <= hc.r * hc.r;
}

// ---------- stroke rendering ----------
// stroke: {id, color, brush, size, symmetry, pts:[{x,y}], lastT}
const rnd = (i, k) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };

export function withSymmetry(ctx, w, h, symmetry, fn) {
  if (!symmetry || symmetry === 1) return fn();
  const cx = w / 2, cy = h / 2;
  if (symmetry === 2) { fn(); ctx.save(); ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.translate(-cx, 0); fn(); ctx.restore(); return; }
  for (let k = 0; k < symmetry; k++) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(k * 2 * Math.PI / symmetry); if (k % 2) ctx.scale(-1, 1); ctx.translate(-cx, -cy); fn(); ctx.restore();
  }
}

/**
 * Geometric line smoothing: moving average over up to `n` neighbours on each side (ends are pinned) — removes the
 * zigzag of a jittery laser track without the lag of filtering the live position. Returns the input when n is 0.
 */
export function smoothPts(pts, n) {
  n = Math.round(n || 0);
  if (n <= 0 || pts.length < 3) return pts;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const k = Math.min(n, i, pts.length - 1 - i);          // shrink the window near the ends so they stay put
    if (k === 0) { out[i] = pts[i]; continue; }
    let x = 0, y = 0;
    for (let j = i - k; j <= i + k; j++) { x += pts[j].x; y += pts[j].y; }
    out[i] = { ...pts[i], x: x / (2 * k + 1), y: y / (2 * k + 1) };
  }
  return out;
}
let curvy = false;   // set by drawStroke: polyline() uses quadratic curves through segment midpoints when smoothing is on

/** Draw stroke s from point index `from` (0 = whole). Coordinates are normalized; `xf` optionally transforms points. */
export function drawStroke(ctx, w, h, s, from = 0, xf = null, smooth = 0) {
  let pts = xf ? s.pts.map(xf) : s.pts;
  if (!pts.length) return;
  if (smooth > 0) { pts = smoothPts(pts, smooth); from = Math.max(0, from - Math.round(smooth) - 1); }
  curvy = smooth > 0;
  const size = s.size * w;
  const P = i => [pts[i].x * w, pts[i].y * h];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  withSymmetry(ctx, w, h, s.symmetry, () => {
    switch (s.brush) {
      case 'marker': {
        ctx.save(); ctx.globalAlpha *= 0.55; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
        polyline(ctx, P, pts.length, from, size * 1.6, s.color); ctx.restore(); break;
      }
      case 'calligraphy': {
        for (let i = Math.max(1, from); i < pts.length; i++) {
          const [x0, y0] = P(i - 1), [x1, y1] = P(i);
          const speed = Math.hypot(x1 - x0, y1 - y0) / w;         // normalized distance per sample
          const wdt = size * Math.max(0.25, Math.min(1.8, 1.8 - speed * 120));
          ctx.strokeStyle = s.color; ctx.lineWidth = wdt; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        if (pts.length === 1) dot(ctx, ...P(0), size / 2, s.color);
        break;
      }
      case 'neon': {
        ctx.save();
        ctx.shadowColor = s.color; ctx.shadowBlur = size * 2.5;
        polyline(ctx, P, pts.length, from, size, s.color);
        polyline(ctx, P, pts.length, from, size, s.color);
        ctx.shadowBlur = 0; polyline(ctx, P, pts.length, from, size * 0.35, '#fff');
        ctx.restore(); break;
      }
      case 'spray': {
        ctx.fillStyle = s.color;
        for (let i = from; i < pts.length; i++) {
          const [x, y] = P(i), n = 14;
          for (let k = 0; k < n; k++) {
            const a = rnd(i, k) * Math.PI * 2, r = Math.sqrt(rnd(i, k + 100)) * size * 1.6;
            ctx.globalAlpha = 0.35 + 0.4 * rnd(i, k + 200);
            ctx.beginPath(); ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, size * 0.12 + rnd(i, k + 300) * size * 0.1, 0, 7); ctx.fill();
          }
        }
        ctx.globalAlpha = 1; break;
      }
      case 'rainbow': {
        for (let i = Math.max(1, from); i < pts.length; i++) {
          const [x0, y0] = P(i - 1), [x1, y1] = P(i);
          ctx.strokeStyle = `hsl(${(i * 4) % 360} 100% 60%)`; ctx.lineWidth = size;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        if (pts.length === 1) dot(ctx, ...P(0), size / 2, 'hsl(0 100% 60%)');
        break;
      }
      default: polyline(ctx, P, pts.length, from, size, s.color);
    }
  });
}
function polyline(ctx, P, n, from, width, color) {
  if (n === 1) return dot(ctx, ...P(0), width / 2, color);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  const start = Math.max(0, from - 1);
  ctx.moveTo(...P(start));
  if (curvy && n - start > 2) {
    // quadratic curves through the midpoints: C1-continuous, passes near every sample
    for (let i = start + 1; i < n - 1; i++) { const [x0, y0] = P(i), [x1, y1] = P(i + 1); ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2); }
    ctx.lineTo(...P(n - 1));
  } else for (let i = start + 1; i < n; i++) ctx.lineTo(...P(i));
  ctx.stroke();
}
function dot(ctx, x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

/** Simple full render used by the control-window preview. */
export function renderStrokes(ctx, w, h, strokes, { fadeSeconds = 0, now = 0, background = '#000', xf = null, lineSmooth = 0 } = {}) {
  ctx.globalAlpha = 1;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  for (const s of strokes) {
    if (fadeSeconds > 0) { const a = 1 - (now - s.lastT) / 1000 / fadeSeconds; if (a <= 0) continue; ctx.globalAlpha = Math.min(1, a); }
    drawStroke(ctx, w, h, s, 0, xf, lineSmooth);
  }
  ctx.globalAlpha = 1;
}
