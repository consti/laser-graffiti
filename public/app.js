import { CHANNEL, computeHomography, applyHomography, invertHomography, renderStrokes } from './shared.js';

const $ = id => document.getElementById(id);
const bc = new BroadcastChannel(CHANNEL);
const video = $('video');
const preview = $('preview'), pctx = preview.getContext('2d');
const projPreview = $('projPreview'), ppctx = projPreview.getContext('2d');
const proc = document.createElement('canvas');            // downscaled processing frame
const pctxProc = proc.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d');

const PROC_W = 480;
const COLORS = ['#ff2d95', '#ff6a00', '#ffd400', '#00e5ff', '#7c4dff', '#ffffff', '#ff0000', '#00ff66'];
const CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

const state = {
  H: null,              // camera(norm) -> projector(norm)
  Hinv: null,
  camCorners: null,     // camera-space (norm) positions of the projector corners, for manual tweaking
  roi: null,            // Uint8Array mask over proc pixels
  strokes: [],
  strokeId: 0,
  current: null,        // current stroke or null
  lastSeen: 0,
  smoothPt: null,
  color: COLORS[0],
  fade: null,
  projAspect: 16 / 9,
  calibrating: false,
  lastDet: null,
  fps: 0,
};

const log = (...a) => { const el = $('log'); el.textContent = `${new Date().toLocaleTimeString()} ${a.join(' ')}\n` + el.textContent; console.log(...a); };
const status = s => $('status').textContent = s;
const send = m => bc.postMessage(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- settings ----------
const params = {};
for (const id of ['minG', 'minDelta', 'minPixels', 'maxPixels', 'smooth', 'brush', 'fade']) {
  const el = $(id);
  const saved = localStorage.getItem('lg:' + id);
  if (saved != null) el.value = saved;
  const upd = () => { params[id] = Number(el.value); el.nextElementSibling.textContent = el.value; localStorage.setItem('lg:' + id, el.value); };
  el.addEventListener('input', upd); upd();
}
for (const id of ['satWhite', 'roiOnly', 'showMask']) {
  const el = $(id);
  const saved = localStorage.getItem('lg:' + id);
  if (saved != null) el.checked = saved === '1';
  const upd = () => { params[id] = el.checked; localStorage.setItem('lg:' + id, el.checked ? '1' : '0'); };
  el.addEventListener('change', upd); upd();
}
$('laserColor').value = localStorage.getItem('lg:laserColor') || 'g';
$('laserColor').addEventListener('change', e => localStorage.setItem('lg:laserColor', e.target.value));
$('fade').addEventListener('input', () => { state.fade = params.fade > 0 ? { seconds: params.fade } : null; send({ t: 'fade', fade: state.fade }); });
state.fade = params.fade > 0 ? { seconds: params.fade } : null;

// swatches
for (const c of COLORS) {
  const d = document.createElement('div');
  d.className = 'swatch' + (c === state.color ? ' sel' : ''); d.style.background = c; d.title = c;
  d.onclick = () => { state.color = c; document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('sel', s === d)); };
  $('swatches').appendChild(d);
}

// ---------- camera ----------
async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('camSel');
  sel.innerHTML = '';
  for (const d of devs) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `camera ${sel.length + 1}`; sel.appendChild(o); }
  const saved = localStorage.getItem('lg:cam');
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
}

let stream = null;
async function startCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  const deviceId = $('camSel').value || undefined;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  await listCameras();
  const track = stream.getVideoTracks()[0];
  $('camSel').value = track.getSettings().deviceId; localStorage.setItem('lg:cam', track.getSettings().deviceId);
  const s = track.getSettings();
  $('camInfo').textContent = `${track.label} — ${s.width}×${s.height} @ ${s.frameRate?.toFixed(0)}fps`;
  log('camera started:', track.label, `${s.width}x${s.height}`);
  ensureProcSize();
  if (!loopRunning) { loopRunning = true; requestAnimationFrame(loop); }
}
$('startBtn').onclick = () => startCamera().catch(e => { log('camera error:', e.message); status('Camera error: ' + e.message); });
$('camSel').onchange = () => stream && startCamera();

// ---------- projector window ----------
$('openProj').onclick = async () => {
  let feat = 'width=960,height=540';
  try {
    if ('getScreenDetails' in window) {
      const sd = await window.getScreenDetails();
      const ext = sd.screens.find(s => !s.isPrimary) || sd.screens.find(s => s !== sd.currentScreen);
      if (ext) feat = `left=${ext.availLeft},top=${ext.availTop},width=${ext.availWidth},height=${ext.availHeight}`;
      log(`screens: ${sd.screens.map(s => `${s.label || 'screen'} ${s.width}x${s.height}${s.isPrimary ? ' (primary)' : ''}`).join(', ')}`);
    }
  } catch (e) { log('window placement not permitted, opening normally:', e.message); }
  window.open('projector.html', 'laser-projector', feat);
};

bc.onmessage = ({ data: m }) => {
  if (m.t === 'proj:hello') { send({ t: 'sync', strokes: state.strokes, fade: state.fade }); log('projector window connected'); }
  if (m.t === 'proj:size') { state.projAspect = m.w / m.h; $('projInfo').textContent = `Projector canvas: ${m.w}×${m.h}`; }
};
send({ t: 'hello' });

// ---------- drawing ----------
$('clearBtn').onclick = () => { state.strokes = []; state.current = null; send({ t: 'clear' }); };
$('undoBtn').onclick = () => { state.strokes.pop(); state.current = null; send({ t: 'undo' }); };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'c') $('clearBtn').click();
  if (e.key === 'z') $('undoBtn').click();
});

function emitPoint(px, py) {
  const now = performance.now();
  const gap = now - state.lastSeen;
  state.lastSeen = now;
  let newStroke = false;
  if (!state.current || gap > 200) {
    state.current = { id: ++state.strokeId, color: state.color, size: params.brush / 1000, pts: [], lastT: now };
    state.strokes.push(state.current);
    state.smoothPt = { x: px, y: py };
    newStroke = true;
  }
  const a = params.smooth / 100;
  state.smoothPt = { x: a * state.smoothPt.x + (1 - a) * px, y: a * state.smoothPt.y + (1 - a) * py };
  const p = state.smoothPt;
  const last = state.current.pts[state.current.pts.length - 1];
  if (!newStroke && last && Math.hypot(last.x - p.x, last.y - p.y) < 0.0015) return; // ignore jitter
  state.current.pts.push({ x: p.x, y: p.y });
  state.current.lastT = now;
  send({ t: 'pt', id: state.current.id, x: p.x, y: p.y, color: state.current.color, size: state.current.size, newStroke });
}

// ---------- detection ----------
function detectLaser(data, w, h) {
  const green = $('laserColor').value === 'g';
  const minC = params.minG, minDelta = params.minDelta, roi = params.roiOnly ? state.roi : null, satW = params.satWhite;
  const xs = [], ys = [], ws = [];
  let best = -1, bi = -1;
  const mask = params.showMask ? mctx.createImageData(w, h) : null;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    if (roi && !roi[i]) continue;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const c = green ? g : r;
    const dom = green ? g - Math.max(r, b) : r - Math.max(g, b);
    let score;
    if (c >= minC && dom >= minDelta) score = dom + c;
    else if (satW && r >= 245 && g >= 245 && b >= 245) score = 250;
    else continue;
    if (mask) { mask.data[j] = 255; mask.data[j + 3] = 200; }
    xs.push(i % w); ys.push((i / w) | 0); ws.push(score);
    if (score > best) { best = score; bi = xs.length - 1; }
  }
  if (mask) mctx.putImageData(mask, 0, 0);
  if (bi < 0) return null;
  const bx = xs[bi], by = ys[bi], R2 = 20 * 20;
  let sx = 0, sy = 0, sw = 0, n = 0;
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - bx, dy = ys[k] - by;
    if (dx * dx + dy * dy <= R2) { sx += xs[k] * ws[k]; sy += ys[k] * ws[k]; sw += ws[k]; n++; }
  }
  if (n < params.minPixels || n > params.maxPixels) return { rejected: true, n, x: bx, y: by };
  return { x: sx / sw, y: sy / sw, n };
}

function ensureProcSize() {
  if (!video.videoWidth || !video.videoHeight) return false;
  const h = Math.round(PROC_W * video.videoHeight / video.videoWidth);
  if (proc.width !== PROC_W || proc.height !== h) {
    proc.width = PROC_W; proc.height = h;
    maskCanvas.width = PROC_W; maskCanvas.height = h;
    buildRoi();
    log(`processing at ${PROC_W}x${h}`);
  }
  return true;
}

// ---------- main loop ----------
let loopRunning = false, frames = 0, fpsT = performance.now();
function loop() {
  // rAF is paused when the window is occluded/hidden; fall back to timers so drawing keeps working (throttled).
  if (document.visibilityState === 'visible') requestAnimationFrame(loop); else setTimeout(loop, 30);
  if (video.readyState < 2 || !ensureProcSize()) return;
  const w = proc.width, h = proc.height;
  pctxProc.drawImage(video, 0, 0, w, h);
  frames++;
  const now = performance.now();
  if (now - fpsT > 1000) { state.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }

  if (!state.calibrating) {
    const det = detectLaser(pctxProc.getImageData(0, 0, w, h).data, w, h);
    state.lastDet = det;
    if (det && !det.rejected) {
      if (state.H) {
        const p = applyHomography(state.H, det.x / w, det.y / h);
        if (p.x >= -0.02 && p.x <= 1.02 && p.y >= -0.02 && p.y <= 1.02) emitPoint(Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y)));
      }
      status(`Laser at cam (${det.x.toFixed(0)},${det.y.toFixed(0)}) ${det.n}px ${state.H ? '' : '— not calibrated'} · ${state.fps.toFixed(0)} fps`);
    } else {
      if (state.current && now - state.lastSeen > 200) state.current = null;
      status(`${det?.rejected ? `blob rejected (${det.n}px)` : 'no laser'} · ${state.H ? 'calibrated' : 'NOT calibrated'} · ${state.fps.toFixed(0)} fps`);
    }
  }
  if (document.visibilityState !== 'visible') status('⚠ Control window hidden — Chrome throttles it. Keep this window visible (it can be small).');
  drawPreview();
}

function drawPreview() {
  const cw = preview.clientWidth, ch = preview.clientHeight;
  if (preview.width !== cw || preview.height !== ch) { preview.width = cw; preview.height = ch; }
  const vw = proc.width, vh = proc.height;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  pctx.fillStyle = '#000'; pctx.fillRect(0, 0, cw, ch);
  pctx.drawImage(video, ox, oy, dw, dh);
  if (params.showMask) pctx.drawImage(maskCanvas, ox, oy, dw, dh);
  preview._map = { ox, oy, dw, dh };
  // projection quad
  if (state.camCorners) {
    pctx.strokeStyle = '#ff0'; pctx.lineWidth = 2; pctx.beginPath();
    state.camCorners.forEach((c, i) => pctx[i ? 'lineTo' : 'moveTo'](ox + c.x * dw, oy + c.y * dh));
    pctx.closePath(); pctx.stroke();
    for (const c of state.camCorners) { pctx.fillStyle = '#ff0'; pctx.beginPath(); pctx.arc(ox + c.x * dw, oy + c.y * dh, 7, 0, 7); pctx.fill(); }
  }
  // detection
  const d = state.lastDet;
  if (d) {
    pctx.strokeStyle = d.rejected ? '#f44' : '#0f0'; pctx.lineWidth = 2;
    pctx.beginPath(); pctx.arc(ox + d.x / vw * dw, oy + d.y / vh * dh, 12, 0, 7); pctx.stroke();
  }
  // stroke mirror
  const pw = projPreview.clientWidth, ph = Math.round(pw / state.projAspect);
  if (projPreview.width !== pw || projPreview.height !== ph) { projPreview.width = pw; projPreview.height = ph; projPreview.style.aspectRatio = `${state.projAspect}`; }
  renderStrokes(ppctx, pw, ph, state.strokes, { fade: state.fade, now: performance.now() });
}

// ---------- manual corner dragging ----------
let dragIdx = -1;
preview.addEventListener('pointerdown', e => {
  if (!state.camCorners || !preview._map) return;
  const { ox, oy, dw, dh } = preview._map;
  const x = (e.offsetX - ox) / dw, y = (e.offsetY - oy) / dh;
  dragIdx = state.camCorners.findIndex(c => Math.hypot((c.x - x) * dw, (c.y - y) * dh) < 14);
  if (dragIdx >= 0) preview.setPointerCapture(e.pointerId);
});
preview.addEventListener('pointermove', e => {
  if (dragIdx < 0) return;
  const { ox, oy, dw, dh } = preview._map;
  state.camCorners[dragIdx] = { x: (e.offsetX - ox) / dw, y: (e.offsetY - oy) / dh };
  setHomography(computeHomography(state.camCorners, CORNERS), state.camCorners);
});
preview.addEventListener('pointerup', () => { if (dragIdx >= 0) { dragIdx = -1; saveCal(); log('calibration adjusted manually'); } });

// ---------- calibration ----------
function setHomography(H, camCorners) {
  state.H = H; state.Hinv = invertHomography(H);
  state.camCorners = camCorners || CORNERS.map(c => applyHomography(state.Hinv, c.x, c.y));
  buildRoi();
}
function buildRoi() {
  if (!state.H || !proc.width) { state.roi = null; return; }
  const w = proc.width, h = proc.height, m = 0.03;
  const roi = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = applyHomography(state.H, (x + 0.5) / w, (y + 0.5) / h);
    if (p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m) roi[y * w + x] = 1;
  }
  state.roi = roi;
}
function saveCal() { localStorage.setItem('lg:cal', JSON.stringify(state.camCorners)); }
function loadCal() {
  try {
    const c = JSON.parse(localStorage.getItem('lg:cal'));
    if (c?.length === 4) { setHomography(computeHomography(c, CORNERS), c); $('calInfo').textContent = 'Loaded saved calibration.'; }
  } catch {}
}
$('calReset').onclick = () => { state.H = state.Hinv = state.camCorners = state.roi = null; localStorage.removeItem('lg:cal'); $('calInfo').textContent = 'Calibration cleared.'; };

function grabGray() {
  const w = proc.width, h = proc.height, d = pctxProc.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) g[i] = d[j] + d[j + 1] + d[j + 2];
  return g;
}
async function grabGrayAvg(n = 3) {
  let acc = null;
  for (let k = 0; k < n; k++) {
    await sleep(40); // don't rely on rAF: it is paused while the window is occluded
    pctxProc.drawImage(video, 0, 0, proc.width, proc.height);
    const g = grabGray();
    if (!acc) acc = g; else for (let i = 0; i < g.length; i++) acc[i] += g[i];
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= n;
  return acc;
}
function findBlob(diff, w, h) {
  let max = 0, mi = -1;
  for (let i = 0; i < w * h; i++) { const v = diff[i]; if (v > max) { max = v; mi = i; } }
  if (max < 40) return { max }; // needs a clear brightness bump (sum of RGB)
  const thr = max * 0.5, bx = mi % w, by = (mi / w) | 0, R2 = (w * 0.08) ** 2;
  let sx = 0, sy = 0, sw = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (diff[i] < thr) continue;
    const x = i % w, y = (i / w) | 0, dx = x - bx, dy = y - by;
    if (dx * dx + dy * dy > R2) continue;
    sx += x * diff[i]; sy += y * diff[i]; sw += diff[i]; n++;
  }
  return { x: sx / sw, y: sy / sw, n, max };
}

$('calBtn').onclick = async () => {
  if (!stream) return status('Start the camera first.');
  state.calibrating = true;
  const w = proc.width, h = proc.height;
  const targets = [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }, { x: .5, y: .5 }];
  const CYCLES = 4, SETTLE = 220;
  try {
    send({ t: 'cal', kind: 'black' }); await sleep(600);
    const cam = [], prj = [];
    for (const [i, tg] of targets.entries()) {
      status(`Calibrating: marker ${i + 1}/${targets.length} (hold still)…`);
      // Flash the marker on/off and accumulate (on - off). Static scene and uncorrelated motion cancel out.
      const acc = new Float32Array(w * h);
      for (let c = 0; c < CYCLES; c++) {
        send({ t: 'cal', kind: 'marker', x: tg.x, y: tg.y, r: 0.045 }); await sleep(SETTLE);
        const on = await grabGrayAvg(2);
        send({ t: 'cal', kind: 'black' }); await sleep(SETTLE);
        const off = await grabGrayAvg(2);
        for (let k = 0; k < acc.length; k++) acc[k] += on[k] - off[k];
      }
      for (let k = 0; k < acc.length; k++) acc[k] /= CYCLES;
      const b = findBlob(acc, w, h);
      if (b && b.n >= 4) { cam.push({ x: b.x / w, y: b.y / h }); prj.push(tg); log(`marker ${i + 1}: cam (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) ${b.n}px Δ${b.max.toFixed(0)}`); }
      else log(`marker ${i + 1}: NOT found (Δ${b?.max?.toFixed(0) ?? '-'})`);
    }
    send({ t: 'cal', kind: 'off' });
    // sanity: markers must land at distinct camera positions
    for (let i = 0; i < cam.length; i++) for (let j = i + 1; j < cam.length; j++)
      if (Math.hypot(cam[i].x - cam[j].x, cam[i].y - cam[j].y) < 0.02) throw new Error('two markers detected at the same spot — something else in the scene is changing brightness');
    if (cam.length < 4) throw new Error(`only ${cam.length} markers found — is the projector window fullscreen and visible to the camera?`);
    const H = computeHomography(cam, prj);
    let err = 0;
    for (let i = 0; i < cam.length; i++) { const p = applyHomography(H, cam[i].x, cam[i].y); err += Math.hypot(p.x - prj[i].x, p.y - prj[i].y); }
    err /= cam.length;
    setHomography(H);
    saveCal();
    $('calInfo').textContent = `Calibrated with ${cam.length} points, mean error ${(err * 100).toFixed(2)}% of projector size.`;
    log(`calibration OK: ${cam.length} pts, err ${(err * 100).toFixed(2)}%`);
  } catch (e) {
    send({ t: 'cal', kind: 'off' });
    $('calInfo').textContent = 'Calibration failed: ' + e.message;
    log('calibration failed:', e.message);
  } finally { state.calibrating = false; }
};

addEventListener('error', e => log('ERROR:', e.message));
addEventListener('unhandledrejection', e => log('ERROR:', e.reason?.message || e.reason));

// ---------- boot ----------
(async () => {
  try { await listCameras(); } catch {}
  loadCal();
  if (localStorage.getItem('lg:cam')) startCamera().catch(e => status('Click "Start camera" (' + e.message + ')'));
  else status('Click "Start camera" to begin.');
})();
window.lg = state; // debugging handle
