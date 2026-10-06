'use strict';

/**
 * HTTP 服务：静态页面 + /api/simulate + /healthz（零依赖）
 * 端口由环境变量 PORT 配置（默认 8080）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Can = require('./engine.js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const STATIC = new Map([
  ['/', path.join(ROOT, 'public', 'index.html')],
  ['/index.html', path.join(ROOT, 'public', 'index.html')],
  ['/app.js', path.join(ROOT, 'public', 'app.js')],
  ['/style.css', path.join(ROOT, 'public', 'style.css')],
  ['/engine.js', path.join(ROOT, 'src', 'engine.js')],
]);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  if (req.method === 'GET' && route === '/healthz') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'can-bus-replay',
      time: new Date().toISOString(),
      limits: { maxNodes: Can.MAX_NODES, maxRequests: Can.MAX_REQUESTS },
    });
    return;
  }

  if (req.method === 'POST' && (route === '/api/simulate' || route === '/api/validate')) {
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, { ok: false, errors: [{ field: '', message: '请求体不是合法 JSON' }] });
      return;
    }
    if (route === '/api/validate') {
      const { errors, value } = Can.validateInput(payload);
      sendJson(res, errors.length ? 400 : 200, errors.length ? { ok: false, errors } : { ok: true });
      return;
    }
    try {
      const result = Can.simulate(payload);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendJson(res, 500, { ok: false, errors: [{ field: '', message: '仿真失败：' + e.message }] });
    }
    return;
  }

  if (req.method === 'GET' && STATIC.has(route)) {
    const file = STATIC.get(route);
    fs.readFile(file, (err, data) => {
      if (err) { sendJson(res, 404, { ok: false, errors: [{ field: '', message: '资源不存在' }] }); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  sendJson(res, 404, { ok: false, errors: [{ field: '', message: `未知路径 ${route}` }] });
});

server.listen(PORT, HOST, () => {
  console.log(`[can-bus-replay] listening on http://${HOST}:${PORT} (health: /healthz)`);
});

module.exports = server;
