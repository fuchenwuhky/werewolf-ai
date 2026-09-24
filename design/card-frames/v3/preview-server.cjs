/* Read-only loopback preview: only this kit and the public web/assets directory. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '../../..');
const publicAssets = path.join(project, 'web', 'assets');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
function inside(file, directory) { return file === directory || file.startsWith(directory + path.sep); }
const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (route === '/') { res.writeHead(302, { Location: '/design/card-frames/v3/index.html' }); res.end(); return; }
    if (route.endsWith('/')) route += 'index.html';
    const file = path.resolve(project, '.' + route);
    if ((!inside(file, __dirname) && !inside(file, publicAssets)) || !mime[path.extname(file)]) { res.writeHead(404); res.end(); return; }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 400); res.end(); }
});
server.listen(Number(process.env.CARD_PREVIEW_PORT) || 0, '127.0.0.1', () => {
  console.log(`Card-frame preview: http://127.0.0.1:${server.address().port}/design/card-frames/v3/index.html`);
});
