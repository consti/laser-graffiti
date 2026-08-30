import { CHANNEL, COLORS, BRUSHES, SYMMETRIES, DEFAULT_SETTINGS, MENU_DWELL_MS, HOT_DWELL_MS, clampIntensity,
  MENU_CORNERS, computeHomography, applyHomography, invertHomography, renderStrokes, drawStroke, menuLayout, hitMenu, inHotCorner, cellAt } from './shared.js';
import { Scene } from './scene.js';
import { TicTacToe } from './game.js';

const $ = id => document.getElementById(id);
const bc = new BroadcastChannel(CHANNEL);
const video = $('video');
const preview = $('preview'), pctx = preview.getContext('2d');
const projPreview = $('projPreview'), ppctx = projPreview.getContext('2d');
const proc = document.createElement('canvas');            // downscaled processing frame
const pctxProc = proc.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d');
const projMaskCv = document.createElement('canvas');        // what we are projecting, rendered small in projector space
const pmctx = projMaskCv.getContext('2d', { willReadFrequently: true });
const PROJ_MASK_W = 320;

const PROC_W = 480;
const CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

const state = {
  H: null, Hinv: null, camCorners: null, roi: null,
  projLUT: null, projMask: null,   // camera pixel -> projector-mask pixel; mask of projected laser-coloured strokes
  strokes: [], strokeId: 0, current: null, lastSeen: 0, smoothPt: null,
  settings: { ...DEFAULT_SETTINGS },
  projAspect: 16 / 9, calibrating: false, laserCal: null,
  lastDet: null, blobs: [], fps: 0,
  track: null,                 // {x,y,t} last accepted detection (proc pixels)
  pendingFrames: 0,            // consecutive frames a candidate was seen before a stroke starts
  menu: { open: false, hover: null, hoverSince: 0, progress: 0, hotSince: 0, hotProgress: 0, lastLaser: 0 },
  game: new TicTacToe(), gameTimer: 0,
  snapshots: [],
  surface: localStorage.getItem('lg:surface') || null,   // camera scan of the wall in projector space (burn mode)
};
window.lg = state; window.lgDebug = { emit: (x, y) => emitPoint(x, y), end: () => endStroke(), snapshot: () => takeSnapshot(),
  // testing without a camera: pretend the camera frame is w×h and calibrate with the given camera corners
  fakeCam: (w, h, corners = CORNERS) => { proc.width = w; proc.height = h; setHomography(computeHomography(corners, CORNERS), corners); },
  projMask: () => updateProjMask() };

const log = (...a) => { const el = $('log'); el.textContent = `${new Date().toLocaleTimeString()} ${a.join(' ')}\n` + el.textContent; console.log(...a); };
const status = s => $('status').textContent = s;
const send = m => bc.postMessage(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- detection params ----------
const params = {};
const rangeEls = ['minG', 'minDelta', 'minPixels', 'maxPixels', 'smooth', 'trackR'];
for (const id of rangeEls) {
  const el = $(id);
  const saved = localStorage.getItem('lg:' + id);
  if (saved != null) el.value = saved;
  const upd = () => { params[id] = Number(el.value); el.nextElementSibling.textContent = el.value; localStorage.setItem('lg:' + id, el.value); };
  el.addEventListener('input', upd); upd();
}
function setParam(id, v) { $(id).value = v; $(id).dispatchEvent(new Event('input')); }
for (const id of ['satWhite', 'roiOnly', 'showMask', 'ignoreProj']) {
  const el = $(id);
  const saved = localStorage.getItem('lg:' + id);
  if (saved != null) el.checked = saved === '1';
  const upd = () => { params[id] = el.checked; localStorage.setItem('lg:' + id, el.checked ? '1' : '0'); };
  el.addEventListener('change', upd); upd();
}
$('laserColor').value = localStorage.getItem('lg:laserColor') || 'g';
$('laserColor').addEventListener('change', e => localStorage.setItem('lg:laserColor', e.target.value));

// ---------- drawing settings (shared with projector) ----------
try { Object.assign(state.settings, JSON.parse(localStorage.getItem('lg:settings') || '{}')); } catch {}
function updateSettings(patch, { fromMenu = false } = {}) {
  const gameChanged = 'game' in patch && patch.game !== state.settings.game;
  Object.assign(state.settings, patch);
  if (gameChanged) startGame(patch.game);
  localStorage.setItem('lg:settings', JSON.stringify(state.settings));
  send({ t: 'settings', settings: state.settings });
  syncSettingsUI();
  if (fromMenu) log('menu:', Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' '));
}
function syncSettingsUI() {
  const s = state.settings;
  document.querySelectorAll('.swatch').forEach(el => el.classList.toggle('sel', el.dataset.color === s.color));
  $('brush').value = s.brush;
  $('size').value = s.size; $('size').nextElementSibling.textContent = s.size;
  $('fadeSeconds').value = s.fadeSeconds; $('fadeSeconds').nextElementSibling.textContent = s.fadeSeconds;
  $('symmetry').value = s.symmetry;
  $('menuCorner').value = s.menuCorner;
  for (const id of ['wetInk', 'spin3d', 'sparkle', 'hotCorner', 'border', 'game', 'flame', 'burn']) $(id).classList.toggle('on', !!s[id]);
  $('intensity').value = Math.round(s.intensity * 100); $('intensity').nextElementSibling.textContent = `×${s.intensity}`;
  $('burnAmbient').value = Math.round(s.burnAmbient * 100); $('burnAmbient').nextElementSibling.textContent = Math.round(s.burnAmbient * 100) + '%';
  $('borderColor').value = s.borderColor;
  $('borderWidth').value = s.borderWidth; $('borderWidth').nextElementSibling.textContent = s.borderWidth;
}
for (const c of COLORS) {
  const d = document.createElement('div');
  d.className = 'swatch'; d.style.background = c; d.title = c; d.dataset.color = c;
  d.onclick = () => updateSettings({ color: c });
  $('swatches').appendChild(d);
}
for (const b of BRUSHES) { const o = document.createElement('option'); o.value = b; o.textContent = b; $('brush').appendChild(o); }
$('brush').onchange = e => updateSettings({ brush: e.target.value });
$('size').oninput = e => updateSettings({ size: Number(e.target.value) });
$('fadeSeconds').oninput = e => updateSettings({ fadeSeconds: Number(e.target.value) });
$('symmetry').onchange = e => updateSettings({ symmetry: Number(e.target.value) });
$('menuCorner').onchange = e => updateSettings({ menuCorner: e.target.value, hotCorner: true });
for (const id of ['wetInk', 'spin3d', 'sparkle', 'hotCorner', 'border', 'game', 'flame', 'burn']) $(id).onclick = () => updateSettings({ [id]: !state.settings[id] });
$('intensity').oninput = e => updateSettings({ intensity: clampIntensity(Number(e.target.value) / 100) });
$('burnAmbient').oninput = e => updateSettings({ burnAmbient: Number(e.target.value) / 100, burn: true });
$('scanSurface').onclick = () => scanSurface().catch(e => { log('surface scan failed:', e.message); $('surfaceInfo').textContent = 'Surface scan failed: ' + e.message; });
$('borderColor').oninput = e => updateSettings({ borderColor: e.target.value, border: true });
$('borderWidth').oninput = e => updateSettings({ borderWidth: Number(e.target.value) });
syncSettingsUI();

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
  const s = track.getSettings();
  $('camSel').value = s.deviceId; localStorage.setItem('lg:cam', s.deviceId);
  $('camInfo').textContent = `${track.label} — ${s.width}×${s.height} @ ${s.frameRate?.toFixed(0)}fps`;
  log('camera started:', track.label, `${s.width}x${s.height}`);
  ensureProcSize();
  if (!loopRunning) { loopRunning = true; loop(); }
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
    }
  } catch (e) { log('window placement not permitted, opening normally:', e.message); }
  window.open('projector.html', 'laser-projector', feat);
};
bc.onmessage = ({ data: m }) => {
  if (m.t === 'proj:hello') { send({ t: 'sync', strokes: state.strokes, settings: state.settings, game: state.game.state(), surface: state.surface }); log('projector window connected'); }
  if (m.t === 'proj:size') { const a = m.w / m.h; if (Math.abs(a - state.projAspect) > 1e-3) { state.projAspect = a; buildRoi(); } $('projInfo').textContent = `Projector canvas: ${m.w}×${m.h}`; }
};
send({ t: 'hello' });

// ---------- drawing ----------
function clearAll() { state.strokes = []; state.current = null; send({ t: 'clear' }); }
function undo() { state.strokes.pop(); state.current = null; send({ t: 'undo' }); }
$('clearBtn').onclick = clearAll;
$('undoBtn').onclick = undo;
$('menuBtn').onclick = () => setMenuOpen(!state.menu.open);
addEventListener('keydown', e => {
  if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === 'c') clearAll();
  if (e.key === 'z') undo();
  if (e.key === 'm') setMenuOpen(!state.menu.open);
  if (e.key === 's') takeSnapshot();
});

function emitPoint(px, py) {
  const now = performance.now();
  const gap = now - state.lastSeen;
  state.lastSeen = now;
  let newStroke = false;
  const s = state.settings;
  if (!state.current || gap > 200) {
    endStroke();
    state.current = { id: ++state.strokeId, color: s.color, brush: s.brush, size: s.size / 1000, symmetry: s.symmetry, pts: [], lastT: now };
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
  const c = state.current;
  send({ t: 'pt', id: c.id, x: p.x, y: p.y, color: c.color, brush: c.brush, size: c.size, symmetry: c.symmetry, newStroke });
}

/** A stroke is finished (laser lifted). In game mode the stroke becomes the player's X. */
function endStroke() {
  const s = state.current;
  state.current = null;
  if (!s || !state.settings.game) return;
  const cx = s.pts.reduce((a, p) => a + p.x, 0) / s.pts.length, cy = s.pts.reduce((a, p) => a + p.y, 0) / s.pts.length;
  const cell = cellAt({ x: cx, y: cy }, state.projAspect);
  const computerReply = () => {
    clearTimeout(state.gameTimer);
    state.gameTimer = setTimeout(() => { state.game.computerMove(); sendGame(); if (state.game.result) scheduleGameReset(); }, 900);
  };
  if (state.game.canEmbellish(cell)) return computerReply();   // second line of the X: keep it, give the player a bit more time
  if (!state.game.playerMove(cell)) {            // illegal (outside board / taken / not your turn): discard the stroke
    const i = state.strokes.indexOf(s);
    if (i >= 0) { state.strokes.splice(i, 1); send({ t: 'undo' }); }
    return;
  }
  sendGame();
  if (state.game.result) return scheduleGameReset();
  computerReply();
}
function sendGame() { send({ t: 'game', game: state.game.state() }); }
function startGame(on) {
  clearTimeout(state.gameTimer);
  state.strokes = []; state.current = null; send({ t: 'clear' });
  state.game.reset(); sendGame();
  if (on) log('tic-tac-toe: you are X — draw inside a cell');
}
function scheduleGameReset() {
  clearTimeout(state.gameTimer);
  log('tic-tac-toe:', state.game.message());
  state.gameTimer = setTimeout(() => { if (state.settings.game) startGame(true); }, 4000);
}

// ---------- snapshots (photo + drawing) ----------
try { state.snapshots = JSON.parse(localStorage.getItem('lg:snapshots') || '[]'); } catch {}
function takeSnapshot() {
  if (!video.videoWidth) return status('Start the camera first.');
  const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const snap = { id: Date.now(), date: new Date().toISOString(), photo: c.toDataURL('image/jpeg', 0.8),
    strokes: JSON.parse(JSON.stringify(state.strokes)), settings: { ...state.settings }, game: state.settings.game ? state.game.state() : null,
    camCorners: state.camCorners, projAspect: state.projAspect };
  state.snapshots.unshift(snap);
  while (state.snapshots.length) {
    try { localStorage.setItem('lg:snapshots', JSON.stringify(state.snapshots)); break; }
    catch { state.snapshots.pop(); if (!state.snapshots.length) { log('snapshot: localStorage full'); break; } }
  }
  renderSnapshots();
  log('snapshot saved', `(${state.snapshots.length} stored)`);
}
function snapDrawingCanvas(snap) {
  const c = document.createElement('canvas'); c.width = 1920; c.height = Math.round(1920 / (snap.projAspect || 16 / 9));
  const sc = new Scene(c); sc.setSettings({ ...snap.settings, spin3d: false, fadeSeconds: 0 }); sc.setStrokes(snap.strokes); sc.setGame(snap.game);
  sc.render(performance.now(), c.getContext('2d'), c.width, c.height, true);
  return c;
}
async function snapCompositeCanvas(snap) {
  const img = new Image(); img.src = snap.photo; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  if (snap.camCorners) {
    const Hinv = invertHomography(computeHomography(snap.camCorners, CORNERS));
    renderStrokes(ctx, c.width, c.height, snap.strokes, { background: null, xf: p => applyHomography(Hinv, p.x, p.y) });
  }
  return c;
}
function download(name, url) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function renderSnapshots() {
  const el = $('snapshots'); el.innerHTML = '';
  for (const snap of state.snapshots) {
    const d = document.createElement('div'); d.className = 'snap';
    const stamp = new Date(snap.date).toLocaleString();
    d.innerHTML = `<img src="${snap.photo}" alt=""><div class="meta"><div>${stamp} · ${snap.strokes.length} strokes</div><div class="row"></div></div>`;
    const row = d.querySelector('.row');
    const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.appendChild(b); };
    const base = `laser-graffiti-${snap.date.replace(/[:.]/g, '-')}`;
    btn('photo', () => download(`${base}-photo.jpg`, snap.photo));
    btn('drawing', () => download(`${base}-drawing.png`, snapDrawingCanvas(snap).toDataURL('image/png')));
    btn('photo+drawing', async () => download(`${base}-composite.jpg`, (await snapCompositeCanvas(snap)).toDataURL('image/jpeg', 0.9)));
    btn('restore', () => { state.strokes = JSON.parse(JSON.stringify(snap.strokes)); state.current = null; send({ t: 'sync', strokes: state.strokes, settings: state.settings, game: state.game.state() }); log('snapshot restored'); });
    btn('✕', () => { state.snapshots = state.snapshots.filter(x => x.id !== snap.id); localStorage.setItem('lg:snapshots', JSON.stringify(state.snapshots)); renderSnapshots(); });
    el.appendChild(d);
  }
}
$('snapBtn').onclick = takeSnapshot;
renderSnapshots();

// ---------- laser menu ----------
function setMenuOpen(open) {
  state.menu.open = open; state.menu.hover = null; state.menu.progress = 0; state.menu.hotProgress = 0;
  state.current = null;
  sendMenu();
}
function sendMenu() { const m = state.menu; send({ t: 'menu', menu: { open: m.open, hover: m.hover, progress: m.progress, hotProgress: m.hotProgress } }); }

/** Called with the laser position in projector space (or null). Returns true when the menu consumed the point. */
function handleMenu(p, now) {
  const m = state.menu;
  if (p) m.lastLaser = now;
  if (!m.open) {
    if (!state.settings.hotCorner) return false;
    if (p && inHotCorner(p, state.projAspect, state.settings.menuCorner)) {
      if (!m.hotSince) m.hotSince = now;
      m.hotProgress = Math.min(1, (now - m.hotSince) / HOT_DWELL_MS);
      sendMenu();
      if (m.hotProgress >= 1) { m.hotSince = 0; setMenuOpen(true); log('menu opened by laser'); }
      return true;                      // don't draw inside the hot corner
    }
    if (m.hotSince || m.hotProgress) { m.hotSince = 0; m.hotProgress = 0; sendMenu(); }
    return false;
  }
  // menu open: hovering with dwell
  if (!p) {
    if (now - m.lastLaser > 8000) { setMenuOpen(false); log('menu closed (idle)'); }
    else if (m.hover) { m.hover = null; m.progress = 0; sendMenu(); }
    return true;
  }
  send({ t: 'cursor', x: p.x, y: p.y });
  const it = hitMenu(menuLayout(state.projAspect, state.settings.menuCorner), p);
  const id = it?.id ?? null;
  if (id !== m.hover) { m.hover = id; m.hoverSince = now; m.progress = 0; }
  else if (id) {
    m.progress = Math.min(1, (now - m.hoverSince) / MENU_DWELL_MS);
    if (m.progress >= 1) { activateMenuItem(it); m.hoverSince = now + 400; m.progress = 0; }   // small cooldown before repeat
  }
  sendMenu();
  return true;
}
function activateMenuItem(it) {
  const s = state.settings;
  switch (it.kind) {
    case 'color': updateSettings({ color: it.value }, { fromMenu: true }); break;
    case 'brush': updateSettings({ brush: it.value }, { fromMenu: true }); break;
    case 'toggle':
      if (it.value === 'fade') updateSettings({ fadeSeconds: s.fadeSeconds > 0 ? 0 : 6 }, { fromMenu: true });
      else updateSettings({ [it.value]: !s[it.value] }, { fromMenu: true });
      break;
    case 'action':
      if (it.value === 'symmetry') updateSettings({ symmetry: SYMMETRIES[(SYMMETRIES.indexOf(s.symmetry) + 1) % SYMMETRIES.length] }, { fromMenu: true });
      if (it.value === 'size-') updateSettings({ size: Math.max(1, Math.round(s.size / 1.5)) }, { fromMenu: true });
      if (it.value === 'size+') updateSettings({ size: Math.min(60, Math.round(s.size * 1.5)) }, { fromMenu: true });
      if (it.value === 'fx-') updateSettings({ intensity: clampIntensity(s.intensity / 1.5) }, { fromMenu: true });
      if (it.value === 'fx+') updateSettings({ intensity: clampIntensity(s.intensity * 1.5) }, { fromMenu: true });
      if (it.value === 'corner') updateSettings({ menuCorner: MENU_CORNERS[(MENU_CORNERS.indexOf(s.menuCorner) + 1) % MENU_CORNERS.length] }, { fromMenu: true });
      if (it.value === 'undo') undo();
      if (it.value === 'clear') clearAll();
      if (it.value === 'snapshot') { takeSnapshot(); setMenuOpen(false); }
      if (it.value === 'close') setMenuOpen(false);
      break;
  }
}

// ---------- detection ----------
/** Collect candidate pixels and cluster them into up to 4 blobs (brightest first). */
function detectBlobs(data, w, h) {
  const green = $('laserColor').value === 'g';
  const minC = params.minG, minDelta = params.minDelta, roi = params.roiOnly ? state.roi : null, satW = params.satWhite;
  const pm = params.ignoreProj ? updateProjMask() : null;
  const xs = [], ys = [], ws = [];
  const mask = params.showMask ? mctx.createImageData(w, h) : null;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    if (roi && !roi[i]) continue;
    if (pm && pm[i]) { if (mask) { mask.data[j + 2] = 255; mask.data[j + 3] = 120; } continue; }   // our own projected stroke
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const c = green ? g : r;
    const dom = green ? g - Math.max(r, b) : r - Math.max(g, b);
    let score;
    if (c >= minC && dom >= minDelta) score = dom + c;
    else if (satW && r >= 245 && g >= 245 && b >= 245) score = 250;
    else continue;
    if (mask) { mask.data[j] = 255; mask.data[j + 3] = 200; }
    xs.push(i % w); ys.push((i / w) | 0); ws.push(score);
  }
  if (mask) mctx.putImageData(mask, 0, 0);
  const blobs = [];
  const used = new Uint8Array(xs.length);
  const R2 = 20 * 20;
  for (let b = 0; b < 4; b++) {
    let best = -1, bi = -1;
    for (let k = 0; k < xs.length; k++) if (!used[k] && ws[k] > best) { best = ws[k]; bi = k; }
    if (bi < 0) break;
    const bx = xs[bi], by = ys[bi];
    let sx = 0, sy = 0, sw = 0, n = 0;
    for (let k = 0; k < xs.length; k++) {
      if (used[k]) continue;
      const dx = xs[k] - bx, dy = ys[k] - by;
      if (dx * dx + dy * dy <= R2) { used[k] = 1; sx += xs[k] * ws[k]; sy += ys[k] * ws[k]; sw += ws[k]; n++; }
    }
    blobs.push({ x: sx / sw, y: sy / sw, n, score: sw, peak: best, ok: n >= params.minPixels && n <= params.maxPixels });
  }
  return blobs;
}

/** Pick the blob to follow: nearest to the tracked position if one is close, otherwise the strongest. */
function pickBlob(blobs, now) {
  const ok = blobs.filter(b => b.ok);
  if (!ok.length) return null;
  const tr = state.track;
  if (tr && now - tr.t < 250) {
    const near = ok.filter(b => Math.hypot(b.x - tr.x, b.y - tr.y) <= params.trackR);
    if (near.length) return near.reduce((a, b) => (b.score > a.score ? b : a));
    // lost the tracked blob: only jump if the new one is a lot stronger (reflections are dimmer)
    const strongest = ok.reduce((a, b) => (b.score > a.score ? b : a));
    return strongest;
  }
  return ok.reduce((a, b) => (b.score > a.score ? b : a));
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

  if (state.laserCal) { laserCalStep(now); drawPreview(); return; }
  if (!state.calibrating) {
    const blobs = detectBlobs(pctxProc.getImageData(0, 0, w, h).data, w, h);
    state.blobs = blobs;
    const det = pickBlob(blobs, now);
    state.lastDet = det || blobs[0] || null;
    let proj = null;
    if (det) {
      state.track = { x: det.x, y: det.y, t: now };
      if (state.H) {
        const p = applyHomography(state.H, det.x / w, det.y / h);
        if (p.x >= -0.02 && p.x <= 1.02 && p.y >= -0.02 && p.y <= 1.02) proj = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
      }
    }
    const consumed = handleMenu(proj, now);
    if (proj && !consumed) {
      // debounce: a brand-new stroke needs the dot in 2 consecutive frames (kills one-frame reflections/glints)
      state.pendingFrames++;
      const continuing = state.current && now - state.lastSeen <= 200;
      if (continuing || state.pendingFrames >= 2) emitPoint(proj.x, proj.y);
    } else {
      state.pendingFrames = 0;
      if (state.current && now - state.lastSeen > 200) endStroke();
    }
    const extra = blobs.length > 1 ? ` (+${blobs.length - 1} other blob${blobs.length > 2 ? 's' : ''})` : '';
    if (det) status(`Laser at cam (${det.x.toFixed(0)},${det.y.toFixed(0)}) ${det.n}px${extra}${state.H ? '' : ' — not calibrated'}${state.menu.open ? ' · MENU' : ''} · ${state.fps.toFixed(0)} fps`);
    else status(`${blobs.length ? `blob rejected (${blobs[0].n}px)` : 'no laser'} · ${state.H ? 'calibrated' : 'NOT calibrated'}${state.menu.open ? ' · MENU' : ''} · ${state.fps.toFixed(0)} fps`);
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
  if (state.camCorners) {
    pctx.strokeStyle = '#ff0'; pctx.lineWidth = 2; pctx.beginPath();
    state.camCorners.forEach((c, i) => pctx[i ? 'lineTo' : 'moveTo'](ox + c.x * dw, oy + c.y * dh));
    pctx.closePath(); pctx.stroke();
    for (const c of state.camCorners) { pctx.fillStyle = '#ff0'; pctx.beginPath(); pctx.arc(ox + c.x * dw, oy + c.y * dh, 7, 0, 7); pctx.fill(); }
  }
  for (const b of state.blobs) {
    const chosen = b === state.lastDet && b.ok;
    pctx.strokeStyle = chosen ? '#0f0' : b.ok ? '#fa0' : '#f44'; pctx.lineWidth = chosen ? 3 : 1.5;
    pctx.beginPath(); pctx.arc(ox + b.x / vw * dw, oy + b.y / vh * dh, chosen ? 12 : 8, 0, 7); pctx.stroke();
  }
  if (state.laserCal) {
    pctx.fillStyle = 'rgba(0,0,0,.6)'; pctx.fillRect(0, 0, cw, 40);
    pctx.fillStyle = '#fff'; pctx.font = '16px system-ui'; pctx.textBaseline = 'middle';
    const lc = state.laserCal, t = performance.now();
    pctx.fillText(t < lc.startAt ? `Laser calibration starts in ${Math.ceil((lc.startAt - t) / 1000)}… point the laser at the projection`
      : `Laser calibration: wave the laser inside the projection… ${Math.max(0, (lc.until - t) / 1000).toFixed(1)}s · ${lc.samples.length} samples`, 12, 20);
  }
  const pw = projPreview.clientWidth, ph = Math.round(pw / state.projAspect);
  if (pw && (projPreview.width !== pw || projPreview.height !== ph)) { projPreview.width = pw; projPreview.height = ph; }
  renderStrokes(ppctx, pw, ph, state.strokes, { fadeSeconds: state.settings.fadeSeconds, now: performance.now() });
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

// ---------- projector calibration ----------
function setHomography(H, camCorners) {
  state.H = H; state.Hinv = invertHomography(H);
  state.camCorners = camCorners || CORNERS.map(c => applyHomography(state.Hinv, c.x, c.y));
  buildRoi();
}
function buildRoi() {
  if (!state.H || !proc.width) { state.roi = null; state.projLUT = null; state.projMask = null; return; }
  const w = proc.width, h = proc.height, m = 0.01;
  const mw = PROJ_MASK_W, mh = Math.max(1, Math.round(mw / state.projAspect));
  projMaskCv.width = mw; projMaskCv.height = mh;
  const roi = new Uint8Array(w * h), lut = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = applyHomography(state.H, (x + 0.5) / w, (y + 0.5) / h);
    if (p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m) {
      roi[y * w + x] = 1;
      const mx = Math.min(mw - 1, Math.max(0, Math.floor(p.x * mw))), my = Math.min(mh - 1, Math.max(0, Math.floor(p.y * mh)));
      lut[y * w + x] = my * mw + mx;
    }
  }
  state.roi = roi; state.projLUT = lut; state.projMask = new Uint8Array(w * h);
}

/**
 * Feedback-loop guard: render what the projector is showing (dilated) in projector space, keep only the pixels whose colour
 * would pass the laser test, and warp that into camera space. Candidate pixels on such a spot are ignored.
 * The freshest 400 ms of the current stroke are left out — that is where the real laser dot is.
 */
function updateProjMask() {
  if (!state.projLUT || !state.strokes.length) return null;
  const now = performance.now(), mw = projMaskCv.width, mh = projMaskCv.height;
  pmctx.globalAlpha = 1; pmctx.fillStyle = '#000'; pmctx.fillRect(0, 0, mw, mh);
  const dilate = 2.4, minPx = 5 / mw;                              // generous: camera blur + calibration error
  for (const st of state.strokes) {
    let pts = st.pts;
    if (st === state.current) pts = pts.filter(p => now - (p.t ?? st.lastT) > 400);
    if (!pts.length) continue;
    const brush = st.brush === 'rainbow' ? 'rainbow' : 'round';
    drawStroke(pmctx, mw, mh, { ...st, pts, brush, size: Math.max(minPx, st.size * dilate) });
  }
  const d = pmctx.getImageData(0, 0, mw, mh).data;
  const green = $('laserColor').value === 'g', minC = params.minG * 0.5, minDelta = params.minDelta * 0.5;
  const laserLike = new Uint8Array(mw * mh);
  for (let i = 0, j = 0; i < mw * mh; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const c = green ? g : r, dom = green ? g - Math.max(r, b) : r - Math.max(g, b);
    if (c >= minC && dom >= minDelta) laserLike[i] = 1;
  }
  const lut = state.projLUT, pm = state.projMask;
  for (let i = 0; i < pm.length; i++) { const k = lut[i]; pm[i] = k >= 0 ? laserLike[k] : 0; }
  return pm;
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
async function grabGrayAvg(n = 2) {
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
  if (max < 40) return { max };
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
    for (let i = 0; i < cam.length; i++) for (let j = i + 1; j < cam.length; j++)
      if (Math.hypot(cam[i].x - cam[j].x, cam[i].y - cam[j].y) < 0.02) throw new Error('two markers detected at the same spot — something else in the scene is changing brightness');
    if (cam.length < 4) throw new Error(`only ${cam.length} markers found — is the projector window fullscreen and visible to the camera?`);
    const H = computeHomography(cam, prj);
    let err = 0;
    for (let i = 0; i < cam.length; i++) { const p = applyHomography(H, cam[i].x, cam[i].y); err += Math.hypot(p.x - prj[i].x, p.y - prj[i].y); }
    err /= cam.length;
    setHomography(H);
    saveCal();
    $('calInfo').textContent = `Projector calibrated with ${cam.length} points, mean error ${(err * 100).toFixed(2)}%.`;
    log(`calibration OK: ${cam.length} pts, err ${(err * 100).toFixed(2)}%`);
  } catch (e) {
    send({ t: 'cal', kind: 'off' });
    $('calInfo').textContent = 'Calibration failed: ' + e.message;
    log('calibration failed:', e.message);
  } finally { state.calibrating = false; }
};

// ---------- surface scan (burn mode): photograph the wall with the projector blanked, warp it into projector space ----------
async function scanSurface() {
  if (!stream || !video.videoWidth) throw new Error('start the camera first');
  if (!state.Hinv) throw new Error('calibrate the projector first');
  state.calibrating = true;
  try {
    status('Scanning surface… (projector blanked)');
    send({ t: 'cal', kind: 'black' }); await sleep(700);
    // average a few full-resolution frames to get rid of sensor noise
    const vw = video.videoWidth, vh = video.videoHeight;
    const fc = document.createElement('canvas'); fc.width = vw; fc.height = vh;
    const fctx = fc.getContext('2d', { willReadFrequently: true });
    const N = 3, acc = new Float32Array(vw * vh * 4);
    for (let k = 0; k < N; k++) {
      await sleep(60); fctx.drawImage(video, 0, 0);
      const d = fctx.getImageData(0, 0, vw, vh).data;
      for (let i = 0; i < d.length; i++) acc[i] += d[i];
    }
    send({ t: 'cal', kind: 'off' });
    // inverse-map every projector pixel to the camera image (bilinear-free nearest sample is fine at this resolution)
    const pw = 960, ph = Math.round(pw / state.projAspect);
    const out = new ImageData(pw, ph), o = out.data, Hinv = state.Hinv;
    let sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const c = applyHomography(Hinv, (x + 0.5) / pw, (y + 0.5) / ph);
      const cx = Math.min(vw - 1, Math.max(0, Math.round(c.x * vw))), cy = Math.min(vh - 1, Math.max(0, Math.round(c.y * vh)));
      const j = (cy * vw + cx) * 4, k = (y * pw + x) * 4;
      o[k] = acc[j] / N; o[k + 1] = acc[j + 1] / N; o[k + 2] = acc[j + 2] / N; o[k + 3] = 255;
      sr += o[k]; sg += o[k + 1]; sb += o[k + 2];
    }
    // normalise exposure so the texture is bright enough to be projected back, but keep the wall's colour and structure
    const n = pw * ph, mean = (sr + sg + sb) / (3 * n), gain = Math.min(4, 170 / Math.max(20, mean));
    for (let i = 0; i < o.length; i += 4) { o[i] = Math.min(255, o[i] * gain); o[i + 1] = Math.min(255, o[i + 1] * gain); o[i + 2] = Math.min(255, o[i + 2] * gain); }
    const sc = document.createElement('canvas'); sc.width = pw; sc.height = ph; sc.getContext('2d').putImageData(out, 0, 0);
    const url = sc.toDataURL('image/jpeg', 0.85);
    state.surface = url;
    try { localStorage.setItem('lg:surface', url); } catch { log('surface: too large for localStorage, kept for this session only'); }
    send({ t: 'surface', url });
    if (!state.settings.burn) updateSettings({ burn: true });
    const avg = `rgb(${Math.round(sr / n)},${Math.round(sg / n)},${Math.round(sb / n)})`;
    $('surfaceInfo').innerHTML = `Surface scanned (${pw}×${ph}, mean brightness ${mean.toFixed(0)}, gain ×${gain.toFixed(1)}, average colour <span style="display:inline-block;width:12px;height:12px;vertical-align:middle;border-radius:3px;background:${avg}"></span>). Burn mode is on — draw!`;
    log(`surface scanned: mean ${mean.toFixed(0)} gain ${gain.toFixed(2)}`);
  } finally { state.calibrating = false; send({ t: 'cal', kind: 'off' }); }
}

// ---------- laser calibration: learn thresholds from the actual laser ----------
$('laserCalBtn').onclick = () => {
  if (!stream) return status('Start the camera first.');
  const COUNTDOWN = 3000, DURATION = 4000;
  state.laserCal = { startAt: performance.now() + COUNTDOWN, until: performance.now() + COUNTDOWN + DURATION, samples: [], shown: null };
  log('laser calibration: starts in 3 s — point the laser at the projection, then wave it around for 4 s');
};
function laserCalStep(now) {
  const lc = state.laserCal;
  if (now < lc.startAt) {                      // countdown: big number on the projector, text in the control window
    const n = Math.ceil((lc.startAt - now) / 1000);
    if (lc.shown !== n) { lc.shown = n; send({ t: 'cal', kind: 'text', big: String(n), text: 'Point the laser at the wall — calibration starts soon' }); }
    status(`Laser calibration starts in ${n}… point the laser at the projection`);
    return;
  }
  if (lc.shown !== 'go') { lc.shown = 'go'; send({ t: 'cal', kind: 'text', text: 'Wave the laser around inside the projection…' }); }
  const w = proc.width, h = proc.height, data = pctxProc.getImageData(0, 0, w, h).data;
  const green = $('laserColor').value === 'g', roi = state.roi;
  // find the most laser-like pixel in the frame without thresholds
  let best = -1, bj = -1;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    if (roi && !roi[i]) continue;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const c = green ? g : r, dom = green ? g - Math.max(r, b) : r - Math.max(g, b);
    const score = c + 2 * dom;
    if (score > best) { best = score; bj = j; }
  }
  if (bj >= 0) {
    const r = data[bj], g = data[bj + 1], b = data[bj + 2];
    const c = green ? g : r, dom = green ? g - Math.max(r, b) : r - Math.max(g, b);
    if (dom >= 25 && c >= 80) {   // plausible laser pixel; ignore frames without laser
      // count pixels around it that share the laser signature at half its strength (dot size estimate)
      const px = ((bj / 4) % w) | 0, py = ((bj / 4) / w) | 0;
      let n = 0, white = 0;
      for (let y = Math.max(0, py - 20); y < Math.min(h, py + 20); y++) for (let x = Math.max(0, px - 20); x < Math.min(w, px + 20); x++) {
        const k = (y * w + x) * 4, rr = data[k], gg = data[k + 1], bb = data[k + 2];
        const cc = green ? gg : rr, dd = green ? gg - Math.max(rr, bb) : rr - Math.max(gg, bb);
        if (cc >= c * 0.6 && dd >= dom * 0.5) n++;
        if (rr >= 245 && gg >= 245 && bb >= 245) white++;
      }
      state.laserCal.samples.push({ c, dom, n, white });
    }
  }
  status(`Laser calibration… ${((lc.until - now) / 1000).toFixed(1)}s · ${lc.samples.length} samples`);
  if (now < lc.until) return;
  const S = lc.samples; state.laserCal = null; send({ t: 'cal', kind: 'off' });
  if (S.length < 10) { $('calInfo').textContent = `Laser calibration failed: laser not seen (${S.length} samples). Point it inside the projection area.`; log('laser calibration failed'); return; }
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))];
  const c20 = q(S.map(s => s.c), 0.2), dom20 = q(S.map(s => s.dom), 0.2), nMed = q(S.map(s => s.n), 0.5), nMax = q(S.map(s => s.n), 0.95), whiteMed = q(S.map(s => s.white), 0.5);
  setParam('minG', Math.round(Math.max(60, c20 * 0.65)));
  setParam('minDelta', Math.round(Math.max(12, dom20 * 0.5)));
  setParam('minPixels', Math.max(1, Math.round(nMed * 0.15)));
  setParam('maxPixels', Math.min(2000, Math.max(30, Math.round(nMax * 4))));
  const sat = whiteMed > 3;
  $('satWhite').checked = sat; $('satWhite').dispatchEvent(new Event('change'));
  $('calInfo').textContent = `Laser learned from ${S.length} samples: channel ≥${params.minG}, dominance ≥${params.minDelta}, dot ≈${nMed}px${sat ? ', saturated core' : ''}.`;
  log(`laser calibration: c20=${c20} dom20=${dom20} n=${nMed}/${nMax} white=${whiteMed} → minG=${params.minG} minDelta=${params.minDelta} maxPixels=${params.maxPixels} satWhite=${sat}`);
}

addEventListener('error', e => log('ERROR:', e.message));
addEventListener('unhandledrejection', e => log('ERROR:', e.reason?.message || e.reason));

// ---------- boot ----------
(async () => {
  try { await listCameras(); } catch {}
  loadCal();
  if (localStorage.getItem('lg:cam')) startCamera().catch(e => status('Click "Start camera" (' + e.message + ')'));
  else status('Click "Start camera" to begin.');
})();
