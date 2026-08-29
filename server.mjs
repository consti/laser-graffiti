// Minimal static server (no deps). getUserMedia needs a secure context; localhost qualifies.
// Supports HTTP Range requests — Safari refuses to play <video> without them.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8765);
const root = path.join(import.meta.dirname, 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const type = types[path.extname(f)] || 'application/octet-stream';
    const isMedia = type.startsWith('video/') || type.startsWith('image/');
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': isMedia ? 'public, max-age=86400' : 'no-store',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}).listen(PORT, () => console.log(`laser-graffiti: http://localhost:${PORT}  (app: /app.html, projector: /projector.html)`));
