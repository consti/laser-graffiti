import { CHANNEL, renderStrokes, drawStrokePath } from './shared.js';

const bc = new BroadcastChannel(CHANNEL);
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const hint = document.getElementById('hint');

let strokes = [];            // [{id, color, size, pts:[{x,y}], lastT}]
let fade = null;             // {seconds} | null
let cal = null;              // null | {kind:'black'} | {kind:'marker', x, y, r}
let dirty = true;

function resize() {
  cv.width = Math.round(innerWidth * devicePixelRatio);
  cv.height = Math.round(innerHeight * devicePixelRatio);
  dirty = true;
  bc.postMessage({ t: 'proj:size', w: cv.width, h: cv.height });
}
addEventListener('resize', resize);
resize();

function fullRedraw() {
  const { width: w, height: h } = cv;
  if (cal) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (cal.kind === 'marker') {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cal.x * w, cal.y * h, cal.r * w, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  renderStrokes(ctx, w, h, strokes, { fade, now: performance.now() });
}

function frame() {
  if (fade && !cal) dirty = true;   // fading needs continuous redraw
  if (dirty) { fullRedraw(); dirty = false; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

bc.onmessage = ({ data: m }) => {
  switch (m.t) {
    case 'pt': {
      let s = strokes[strokes.length - 1];
      if (m.newStroke || !s || s.id !== m.id) {
        s = { id: m.id, color: m.color, size: m.size, pts: [], lastT: 0 };
        strokes.push(s);
      }
      s.pts.push({ x: m.x, y: m.y });
      s.lastT = performance.now();
      if (!cal && !fade) drawStrokePath(ctx, cv.width, cv.height, s, s.pts.length - 1); // incremental
      else dirty = true;
      break;
    }
    case 'clear': strokes = []; dirty = true; break;
    case 'undo': strokes.pop(); dirty = true; break;
    case 'sync': strokes = m.strokes; fade = m.fade; dirty = true; break;
    case 'fade': fade = m.fade; dirty = true; break;
    case 'cal': cal = m.kind === 'off' ? null : m; dirty = true; break;
    case 'hello': bc.postMessage({ t: 'proj:size', w: cv.width, h: cv.height }); break;
  }
  if (m.t !== 'proj:size') hint.classList.add('hidden');
};

function goFullscreen() { document.documentElement.requestFullscreen?.().catch(() => {}); }
addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFullscreen(); });
addEventListener('dblclick', goFullscreen);
addEventListener('fullscreenchange', () => document.body.classList.toggle('live', !!document.fullscreenElement));

// Announce ourselves so the control window can sync state.
bc.postMessage({ t: 'proj:hello' });
