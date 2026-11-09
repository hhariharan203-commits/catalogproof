import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PASSWORD = 'test-demo-password-never-use-in-production';
const SECRET = 'test-session-secret-at-least-thirty-two-characters';
let port;
let child;
let base;
let logs = '';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${logs}`);
}

test('production login rejects an HTTP Origin on the configured HTTPS host', async (t) => {
  const originPort = await freePort();
  const localBase = `http://127.0.0.1:${originPort}`;
  let originLogs = '';
  const originChild = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(originPort), DATABASE_PATH: ':memory:', DEMO_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://catalog.example.test',
      AI_API_KEY: '', AI_MODEL: '', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  originChild.stdout.on('data', (chunk) => { originLogs += chunk.toString(); });
  originChild.stderr.on('data', (chunk) => { originLogs += chunk.toString(); });
  t.after(() => originChild.kill('SIGTERM'));

  const deadline = Date.now() + 5000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (originChild.exitCode !== null) throw new Error(`origin test server exited early: ${originLogs}`);
    try {
      const response = await fetch(`${localBase}/api/health`);
      if (response.ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(healthy, true, `origin test server did not start: ${originLogs}`);

  const body = JSON.stringify({ password: PASSWORD });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: originPort, path: '/api/auth/login', method: 'POST',
      headers: { Host: 'catalog.example.test', Origin: 'http://catalog.example.test', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(result.status, 403, result.body);
  assert.match(result.body, /ORIGIN_REJECTED/);
});

test('auth routes enforce session, origin and CSRF, and logout clears access', async (t) => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: ':memory:', DEMO_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET, NODE_ENV: 'production', PUBLIC_BASE_URL: base,
      AI_API_KEY: '', AI_MODEL: '', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  t.after(() => child.kill('SIGTERM'));

  const health = await waitForHealth();
  assert.equal(health.ok, true);
  assert.equal(health.aiConfigured, false);
  assert.equal(health.paypalConfigured, false);

  const unauth = await fetch(`${base}/api/catalog`);
  assert.equal(unauth.status, 401);

  const crossOriginLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(crossOriginLogin.status, 403);

  const wrong = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const auth = await login.json();
  assert.equal(auth.authenticated, true);
  assert.ok(auth.csrfToken);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];

  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.deepEqual(await session.json(), { authenticated: true, csrfToken: auth.csrfToken });

  const noOrigin = await fetch(`${base}/api/demo/reset`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken }, body: '{}',
  });
  assert.equal(noOrigin.status, 403);

  const noCsrf = await fetch(`${base}/api/demo/reset`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(noCsrf.status, 403);

  const reset = await fetch(`${base}/api/demo/reset`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken }, body: '{}',
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { reset: true });

  const seededCatalog = await fetch(`${base}/api/catalog`, { headers: { cookie } });
  assert.equal(seededCatalog.status, 200);
  const seedResult = await seededCatalog.json();
  assert.equal(seedResult.currentVersion.isSynthetic, true);
  assert.equal(seedResult.items.length, 2);
  assert.match(seedResult.currentVersion.sourceName, /CatalogProof team-authored fictional two-variant fixture/);
  const resetAudit = await fetch(`${base}/api/audit?entityType=demo&entityId=workspace`, { headers: { cookie } });
  assert.deepEqual((await resetAudit.json()).events, []);

  const mutationHeaders = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken };
  const imported = await fetch(`${base}/api/catalog/import`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({
      sourceName: 'Server test fixture', sourceLicense: 'test-only', isSynthetic: true,
      items: [{ productId: 'p1', sku: 'SKU-1', title: 'Demo shoe', variantAttributes: { Color: 'Blue', Size: 'US 6' },
        unitAmountMinor: 3299, currency: 'USD', available: true, sourceRecord: { color: 'Blue' } }],
    }),
  });
  assert.equal(imported.status, 201);
  const importResult = await imported.json();
  assert.equal(importResult.itemCount, 1);

  const malformedAvailability = await fetch(`${base}/api/catalog/import`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({
      sourceName: 'Invalid availability test', isSynthetic: true,
      items: [{ productId: 'p2', sku: 'SKU-2', title: 'Unavailable demo shoe', variantAttributes: {},
        unitAmountMinor: 3299, currency: 'USD', available: 'false' }],
    }),
  });
  assert.equal(malformedAvailability.status, 400);
  assert.equal((await malformedAvailability.json()).error.code, 'INVALID_AVAILABILITY');
  const currentCatalog = await fetch(`${base}/api/catalog`, { headers: { cookie } });
  assert.equal((await currentCatalog.json()).items.length, 1);

  const createdTest = await fetch(`${base}/api/tests`, {
    method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ queryText: 'Blue shoe US 6', expectedSku: 'SKU-1', settings: { model: 'client-controlled-model' } }),
  });
  assert.equal(createdTest.status, 201);
  const testResult = await createdTest.json();
  assert.equal(testResult.test.frozenSettings.model, null);
  assert.equal(testResult.test.frozenSettings.promptVersion, 'catalogproof-diagnostic-v1');
  const beforeRun = await fetch(`${base}/api/tests/${testResult.test.id}/run`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ phase: 'before' }),
  });
  assert.equal(beforeRun.status, 503);
  assert.equal((await beforeRun.json()).error.code, 'AI_UNAVAILABLE');

  const unsafeCheckout = await fetch(`${base}/api/checkouts`, {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ afterRunId: 'missing-run', quantity: 1, price: 1 }),
  });
  assert.equal(unsafeCheckout.status, 409);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken }, body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  const afterLogout = await fetch(`${base}/api/catalog`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});
