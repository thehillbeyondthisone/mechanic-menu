import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../dist');
const port = Number(process.env.PORT || 8840);
// Loopback only unless the owner explicitly chooses a private interface.
const host = process.env.HOST || '127.0.0.1';
const secure = !!(process.env.TLS_CERT && process.env.TLS_KEY);
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !secure) {
  throw Error('A remote interface requires TLS_CERT and TLS_KEY with a Quest-trusted certificate.');
}
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ply': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.map': 'application/json'};
const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    res.writeHead(200);
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
};
const server = secure ? https.createServer({cert: await readFile(process.env.TLS_CERT), key: await readFile(process.env.TLS_KEY)}, handler) : http.createServer(handler);
let triedFreePort = false;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !triedFreePort && !secure && ['127.0.0.1', '::1', 'localhost'].includes(host)) {
    triedFreePort = true;
    console.log(`Port ${port} is occupied. Choosing a free private loopback port; the existing process is unchanged.`);
    server.listen(0, host);
  } else { console.error(error.message); process.exitCode = 1; }
});
server.on('listening', () => console.log(`Private office demo: ${secure ? 'https' : 'http'}://${host}:${server.address().port}/ (PID ${process.pid})`));
server.listen(port, host);
