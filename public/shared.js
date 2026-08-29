// Shared helpers: channel name, homography math, stroke rendering.
export const CHANNEL = 'laser-graffiti';

/** Least-squares homography from >=4 point pairs. Returns 3x3 row-major H mapping src -> dst. */
export function computeHomography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) throw new Error('need >= 4 point pairs');
  // Build normal equations A^T A h = A^T b for the 8 unknowns (h33 = 1).
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const rows = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    rows.push([[x, y, 1, 0, 0, 0, -u * x, -u * y], u]);
    rows.push([[0, 0, 0, x, y, 1, -v * x, -v * y], v]);
  }
  for (const [r, b] of rows) {
    for (let i = 0; i < 8; i++) {
      Atb[i] += r[i] * b;
      for (let j = 0; j < 8; j++) AtA[i][j] += r[i] * r[j];
    }
  }
  const h = solveLinear(AtA, Atb);
  return [...h, 1];
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('degenerate calibration points');
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
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
  const inv = [
    A, -(b * i - c * h), (b * f - c * e),
    B, (a * i - c * g), -(a * f - c * d),
    C, -(a * h - b * g), (a * e - b * d),
  ].map(v => v / det);
  return inv;
}

/**
 * Render strokes (normalized 0..1 coords) onto a canvas.
 * fade: {seconds} or null. now: timestamp for fade.
 */
export function renderStrokes(ctx, w, h, strokes, { fade = null, now = 0, background = '#000' } = {}) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (fade) {
      const age = (now - s.lastT) / 1000;
      const a = 1 - age / fade.seconds;
      if (a <= 0) continue;
      ctx.globalAlpha = Math.min(1, a);
    }
    drawStrokePath(ctx, w, h, s);
  }
  ctx.globalAlpha = 1;
}

export function drawStrokePath(ctx, w, h, s, fromIndex = 0) {
  const pts = s.pts;
  if (pts.length === 0) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.size * w;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * w, pts[0].y * h, s.size * w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  const start = Math.max(0, fromIndex - 1);
  ctx.moveTo(pts[start].x * w, pts[start].y * h);
  for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i].x * w, pts[i].y * h);
  ctx.stroke();
}
