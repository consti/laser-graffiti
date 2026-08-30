// Landing-page demo: your mouse/finger is the laser. Uses the same Scene renderer and game as the real thing.
import { COLORS, BRUSHES, DEFAULT_SETTINGS, cellAt, SYMMETRIES, INTENSITY_MIN, INTENSITY_MAX } from './shared.js';
import { Scene } from './scene.js';
import { TicTacToe } from './game.js';

const $ = id => document.getElementById(id);
const cv = $('demo');
const scene = new Scene(cv);
const settings = { ...DEFAULT_SETTINGS, hotCorner: false, size: 10 };
const game = new TicTacToe();
let strokeId = 0, current = null, gameTimer = 0;

function resize() {
  const r = cv.getBoundingClientRect();
  scene.setSize(Math.round(r.width * devicePixelRatio), Math.round(r.height * devicePixelRatio));
}
new ResizeObserver(resize).observe(cv);
resize();
scene.setSettings(settings);
scene.setGame(game.state());
scene.start();

// toolbar
const tb = $('tools');
const colorsEl = document.createElement('div'); colorsEl.className = 'colors';
for (const c of COLORS) {
  const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.color = c;
  b.onclick = () => apply({ color: c }); colorsEl.appendChild(b);
}
tb.appendChild(colorsEl);
const brushSel = document.createElement('select');
for (const b of BRUSHES) { const o = document.createElement('option'); o.value = b; o.textContent = b; brushSel.appendChild(o); }
brushSel.onchange = () => apply({ brush: brushSel.value });
tb.appendChild(brushSel);
const toggles = [['wetInk', 'wet ink'], ['spin3d', 'spin 3D'], ['fade', 'fade'], ['sparkle', 'sparkle'], ['flame', '🔥 flame'], ['burn', 'burn'], ['symmetry', 'mirror'], ['border', 'border'], ['game', 'tic-tac-toe']];
const toggleEls = {};
for (const [k, label] of toggles) {
  const b = document.createElement('button'); b.textContent = label; toggleEls[k] = b;
  b.onclick = () => {
    if (k === 'fade') apply({ fadeSeconds: settings.fadeSeconds ? 0 : 5 });
    else if (k === 'symmetry') apply({ symmetry: SYMMETRIES[(SYMMETRIES.indexOf(settings.symmetry) + 1) % SYMMETRIES.length] });
    else apply({ [k]: !settings[k] });
  };
  tb.appendChild(b);
}
const fxWrap = document.createElement('label'); fxWrap.className = 'fx'; fxWrap.title = 'effect intensity';
const fxSlider = document.createElement('input'); fxSlider.type = 'range'; fxSlider.min = INTENSITY_MIN * 100; fxSlider.max = INTENSITY_MAX * 100; fxSlider.value = 100;
const fxVal = document.createElement('span');
fxSlider.oninput = () => apply({ intensity: Number(fxSlider.value) / 100 });
fxWrap.append('fx', fxSlider, fxVal); tb.appendChild(fxWrap);
const smWrap = document.createElement('label'); smWrap.className = 'fx'; smWrap.title = 'line smoothing';
const smSlider = document.createElement('input'); smSlider.type = 'range'; smSlider.min = 0; smSlider.max = 10; smSlider.value = settings.lineSmooth;
const smVal = document.createElement('span');
smSlider.oninput = () => apply({ lineSmooth: Number(smSlider.value) });
smWrap.append('smooth', smSlider, smVal); tb.appendChild(smWrap);
const clearBtn = document.createElement('button'); clearBtn.textContent = 'clear'; clearBtn.onclick = () => { scene.clear(); if (settings.game) startGame(); }; tb.appendChild(clearBtn);

function apply(patch) {
  const gameChanged = 'game' in patch && patch.game !== settings.game;
  Object.assign(settings, patch);
  scene.setSettings(settings);
  if (gameChanged) { scene.clear(); startGame(); }
  syncUI();
}
function syncUI() {
  colorsEl.querySelectorAll('.sw').forEach(b => b.classList.toggle('sel', b.dataset.color === settings.color));
  brushSel.value = settings.brush;
  smSlider.value = settings.lineSmooth; smVal.textContent = settings.lineSmooth;
  fxSlider.value = Math.round(settings.intensity * 100); fxVal.textContent = `×${settings.intensity.toFixed(settings.intensity % 1 ? 2 : 0)}`;
  for (const [k] of toggles) {
    const on = k === 'fade' ? settings.fadeSeconds > 0 : k === 'symmetry' ? settings.symmetry > 1 : !!settings[k];
    toggleEls[k].classList.toggle('on', on);
    if (k === 'symmetry') toggleEls[k].textContent = settings.symmetry > 1 ? `mirror ×${settings.symmetry}` : 'mirror';
  }
}
syncUI();

// tic-tac-toe
function startGame() { clearTimeout(gameTimer); game.reset(); scene.setGame(game.state()); }
function endStroke() {
  const s = current; current = null;
  if (!s || !settings.game) return;
  const cx = s.pts.reduce((a, p) => a + p.x, 0) / s.pts.length, cy = s.pts.reduce((a, p) => a + p.y, 0) / s.pts.length;
  const cell = cellAt({ x: cx, y: cy }, cv.width / cv.height);
  const after = () => { if (game.result) { gameTimer = setTimeout(() => { if (settings.game) { scene.clear(); startGame(); } }, 4000); } };
  const computerReply = () => { clearTimeout(gameTimer); gameTimer = setTimeout(() => { game.computerMove(); scene.setGame(game.state()); after(); }, 900); };
  if (game.canEmbellish(cell)) return computerReply();       // second line of the X
  if (!game.playerMove(cell)) { scene.undo(); return; }
  scene.setGame(game.state());
  if (game.result) return after();
  computerReply();
}

// pointer = laser
const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const p = pos(e);
  current = { id: ++strokeId, pts: [p] };
  scene.addPoint({ id: current.id, ...p, color: settings.color, brush: settings.brush, size: settings.size / 1000, symmetry: settings.symmetry, newStroke: true });
});
cv.addEventListener('pointermove', e => {
  if (!current) return;
  const p = pos(e), last = current.pts[current.pts.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) < 0.002) return;
  current.pts.push(p);
  scene.addPoint({ id: current.id, ...p, color: settings.color, brush: settings.brush, size: settings.size / 1000, symmetry: settings.symmetry, newStroke: false });
});
const up = () => { if (current) endStroke(); };
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
