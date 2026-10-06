'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return p;
}

async function waitReady() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}

test('HTTP：健康检查、静态页面、API 仿真与校验', async (t) => {
  const server = startServer();
  t.after(() => server.kill('SIGTERM'));
  await waitReady();

  const h = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(h.status, 'ok');
  assert.equal(h.limits.maxNodes, 4);
  assert.equal(h.limits.maxRequests, 24);

  const page = await (await fetch(`${BASE}/`)).text();
  assert.ok(page.includes('位级仲裁'));
  assert.ok(page.includes('/engine.js'));
  for (const asset of ['/app.js', '/style.css', '/engine.js']) {
    const r = await fetch(`${BASE}${asset}`);
    assert.equal(r.status, 200, asset);
  }

  const ok = await fetch(`${BASE}/api/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodes: [{ name: 'A' }, { name: 'B' }],
      requests: [{ time: 0, node: 'A', id: '0x100', dlc: 0 }],
    }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.attempts[0].winner, 'A');

  const bad = await fetch(`${BASE}/api/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: 9999, dlc: 0 }] }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.ok(badBody.errors.some((e) => e.field.includes('.id')));

  const notJson = await fetch(`${BASE}/api/simulate`, { method: 'POST', body: 'not-json' });
  assert.equal(notJson.status, 400);

  const nf = await fetch(`${BASE}/nope`);
  assert.equal(nf.status, 404);
});
