import { CHANNEL } from './shared.js';
import { Scene } from './scene.js';

const bc = new BroadcastChannel(CHANNEL);
const scene = new Scene(document.getElementById('c'));
const hint = document.getElementById('hint');

function resize() {
  scene.setSize(Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio));
  bc.postMessage({ t: 'proj:size', w: scene.cv.width, h: scene.cv.height });
}
addEventListener('resize', resize);
resize();
scene.start();

bc.onmessage = ({ data: m }) => {
  switch (m.t) {
    case 'pt': scene.addPoint(m); break;
    case 'cursor': scene.setCursor(m); break;
    case 'clear': scene.clear(); break;
    case 'undo': scene.undo(); break;
    case 'sync': scene.setStrokes(m.strokes); scene.setSettings(m.settings); if (m.game !== undefined) scene.setGame(m.game); break;
    case 'settings': scene.setSettings(m.settings); break;
    case 'menu': scene.setMenu(m.menu); break;
    case 'game': scene.setGame(m.game); break;
    case 'cal': scene.setCal(m.kind === 'off' ? null : m); break;
    case 'hello': bc.postMessage({ t: 'proj:size', w: scene.cv.width, h: scene.cv.height }); break;
  }
  if (m.t !== 'proj:size') hint.classList.add('hidden');
};

function goFullscreen() { document.documentElement.requestFullscreen?.().catch(() => {}); }
addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFullscreen(); });
addEventListener('dblclick', goFullscreen);
addEventListener('fullscreenchange', () => document.body.classList.toggle('live', !!document.fullscreenElement));
bc.postMessage({ t: 'proj:hello' });
