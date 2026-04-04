// HTTPS dev server — uses mkcert cert so getUserMedia works on LAN devices
// Run: node server.js
// Then open https://192.168.0.52:8443 (or other LAN IP shown below) on any device

import https from 'https';
import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import os    from 'os';
import { spawn }        from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = 8443;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.pem':  'application/x-pem-file',
  '.task': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  // 3D model formats
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx':  'application/octet-stream',
  '.obj':  'text/plain',
  '.mtl':  'text/plain',
};

async function serve(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // ── YouTube proxy via yt-dlp ──────────────────────────────────────────────
  if (urlPath === '/api/yt-stream') {
    const qs     = new URL('http://x' + req.url).searchParams;
    const ytUrl  = qs.get('url');
    if (!ytUrl) { res.writeHead(400); res.end('Missing ?url='); return; }

    // 1. Ask yt-dlp for the direct CDN URL (no download)
    let directUrl;
    try {
      directUrl = await new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', [
          '-g', '--no-playlist',
          '-f', 'best[ext=mp4][vcodec!=none][acodec!=none][height<=1080]/b[ext=mp4]/b',
          ytUrl,
        ]);
        let out = '', err = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => code === 0
          ? resolve(out.trim().split('\n')[0])
          : reject(new Error(err.trim().split('\n').slice(-3).join(' '))));
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('yt-dlp error: ' + e.message);
      return;
    }

    // 2. Proxy the CDN URL to the browser (with Range forwarding for seeking)
    const parsed  = new URL(directUrl);
    const useHttps = parsed.protocol === 'https:';
    const lib     = useHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    };
    const upstream = lib.request(options, upRes => {
      res.writeHead(upRes.statusCode, {
        'Content-Type':  upRes.headers['content-type']  ?? 'video/mp4',
        'Content-Length': upRes.headers['content-length'] ?? '',
        'Content-Range':  upRes.headers['content-range']  ?? '',
        'Accept-Ranges':  'bytes',
        'Cache-Control':  'no-store',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      upRes.pipe(res);
      req.on('close', () => upRes.destroy());
    });
    upstream.on('error', err => {
      if (!res.headersSent) { res.writeHead(502); }
      res.end('Upstream error: ' + err.message);
    });
    upstream.end();
    return;
  }

  // ── /api/objects — list 3D model files in models/objects/ ────────────────────
  if (urlPath === '/api/objects') {
    const objDir = path.join(ROOT, 'models', 'objects');
    const exts   = new Set(['.glb', '.gltf', '.fbx', '.obj']);
    let files = [];
    try {
      files = fs.readdirSync(objDir).filter(f => exts.has(path.extname(f).toLowerCase()));
    } catch (_) { /* folder may not exist yet */ }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(JSON.stringify(files));
    return;
  }

  // Special route: /install-ca  →  serve rootCA.pem for iOS profile install
  if (urlPath === '/install-ca') {
    urlPath = '/rootCA.pem';
    res.setHeader('Content-Disposition', 'attachment; filename="mkcert-rootCA.pem"');
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}

const sslOptions = {
  key:  fs.readFileSync(path.join(ROOT, 'key.pem')),
  cert: fs.readFileSync(path.join(ROOT, 'cert.pem')),
};

https.createServer(sslOptions, serve).listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips  = ['localhost'];
  for (const name of Object.keys(nets))
    for (const n of nets[name])
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);

  console.log('\n✅  HTTPS server running\n');
  for (const ip of ips)
    console.log(`   https://${ip}:${PORT}`);

  console.log('\n📱  To trust on iPhone/iPad/Mac:');
  console.log(`   1. Open  https://<your-ip>:${PORT}/install-ca  in Safari`);
  console.log('   2. Tap "Allow" → Settings → General → VPN & Device Management → install');
  console.log('   3. Settings → General → About → Certificate Trust Settings → enable it');
  console.log('   4. Reload the app — camera will work\n');
});

// Plain HTTP on localhost:8080 — for OBS Browser Source
// localhost is a secure context in Chromium so getUserMedia works fine over HTTP
const HTTP_PORT = 8080;
const httpServer = http.createServer(serve);
httpServer.on('error', () => {}); // silently skip if port is taken
httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`   http://localhost:${HTTP_PORT}  ← use this URL in OBS Browser Source`);
});
