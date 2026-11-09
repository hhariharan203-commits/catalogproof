import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';

const password = 'audit-route-test-password-only';
const sessionSecret = 'audit-route-test-session-secret-at-least-32-chars';
const originalFetch = globalThis.fetch;

async function reservePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

test('query-test audit returns created, run, correction decision, and replay events', async (t) => {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port), DATABASE_PATH: ':memory:', DEMO_PASSWORD: password,
    SESSION_SECRET: sessionSecret, NODE_ENV: 'test', PUBLIC_BASE_URL: base,
    AI_BASE_URL: 'https://audit-ai.example.test/v1', AI_API_KEY: 'fake-audit-key', AI_MODEL: 'audit-route-test-model',
  });

  let aiCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    if (target.startsWith(base)) return originalFetch(input, init);
    if (target === 'https://audit-ai.example.test/v1/chat/completions') {
      aiCalls += 1;
      const request = JSON.parse(JSON.parse(init.body).messages[1].content);
      const ecru = request.candidates.find((candidate) => candidate.sku === 'AUDIT-ECRU');
      assert.ok(ecru, 'the frozen catalog contains the intended SKU');
      if (aiCalls === 1) {
        return response({ choices: [{ message: { content: JSON.stringify({
          selectedSku: 'AUDIT-OTHER', outcome: 'conflicting_evidence', matchedFacts: [],
          issues: [{ type: 'color_mismatch', fieldPath: 'variantAttributes.Color', actualValue: 'Ink', expectedOrMissingValue: null,
            evidence: [{ sku: 'AUDIT-OTHER', fieldPath: 'variantAttributes.Color', value: 'Ink', recordId: request.candidates.find((candidate) => candidate.sku === 'AUDIT-OTHER').recordId }],
            explanation: 'The selected variant differs from the frozen request.' }],
          correctionDraft: { sku: ecru.sku, fieldPath: 'variantAttributes.Color', proposedValue: 'Ecru',
            evidence: [{ sourceType: 'catalog_record', sourceReference: `catalog://${encodeURIComponent(request.catalogVersion)}/sku/AUDIT-ECRU`, exactQuote: 'Ecru', recordId: ecru.recordId }],
            explanation: 'The stored selected option is Ecru.' },
          uncertaintyReason: null,
        }) } }] });
      }
      return response({ choices: [{ message: { content: JSON.stringify({
        selectedSku: ecru.sku, outcome: 'supported_match',
        matchedFacts: [{ fieldPath: 'variantAttributes.Color', value: 'Ecru', recordId: ecru.recordId }],
        issues: [], uncertaintyReason: null,
      }) } }] });
    }
    throw new Error(`Unexpected external request in audit route test: ${target}`);
  };

  const { createServer } = await import(`../server/index.js?audit-route=${Date.now()}`);
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
  });

  const call = async (route, { method = 'GET', body, cookie = '', csrf = '' } = {}) => {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await originalFetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };

  const loginResponse = await originalFetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(loginResponse.status, 200);
  const authCookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const csrf = (await loginResponse.json()).csrfToken;
  assert.ok(authCookie && csrf);
  const auth = { cookie: authCookie, csrf };

  const imported = await call('/api/catalog/import', { method: 'POST', ...auth, body: {
    sourceName: 'Audit route fixture', isSynthetic: true,
    items: [
      { productId: 'AUDIT-PRODUCT', sku: 'AUDIT-ECRU', title: 'Audit tote', variantAttributes: { Color: 'Stone' },
        unitAmountMinor: 2400, currency: 'USD', available: true,
        sourceRecord: { selectedOptions: [{ name: 'Color', value: 'Ecru' }] } },
      { productId: 'AUDIT-PRODUCT', sku: 'AUDIT-OTHER', title: 'Audit tote', variantAttributes: { Color: 'Ink' },
        unitAmountMinor: 2400, currency: 'USD', available: true,
        sourceRecord: { selectedOptions: [{ name: 'Color', value: 'Ink' }] } },
    ],
  } });
  assert.equal(imported.status, 201);

  const created = await call('/api/tests', { method: 'POST', ...auth, body: {
    queryText: 'Find the Ecru audit tote.', expectedSku: 'AUDIT-ECRU', settings: {},
  } });
  assert.equal(created.status, 201);
  const testId = created.json.test.id;
  const auditForTest = async () => call(`/api/audit?entityType=query_test&entityId=${encodeURIComponent(testId)}`, auth);
  const eventTypes = async () => {
    const result = await auditForTest();
    assert.equal(result.status, 200);
    return result.json.events.map((event) => event.eventType).sort();
  };
  assert.deepEqual(await eventTypes(), ['created']);

  const before = await call(`/api/tests/${testId}/run`, { method: 'POST', ...auth, body: { phase: 'before' } });
  assert.equal(before.status, 201, JSON.stringify(before.json));
  assert.deepEqual(await eventTypes(), ['before', 'created']);
  const draft = before.json.run.diagnosis.correctionDraft;

  const submitted = await call('/api/corrections', { method: 'POST', ...auth, body: {
    queryTestId: testId, beforeRunId: before.json.run.id, sku: draft.sku, fieldPath: draft.fieldPath,
    proposedValue: draft.proposedValue, evidence: draft.evidence[0], explanation: draft.explanation,
  } });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
  assert.deepEqual(await eventTypes(), ['before', 'created', 'proposed']);

  const correctionId = submitted.json.correction.id;
  const decision = await call(`/api/corrections/${correctionId}/decision`, { method: 'POST', ...auth, body: { decision: 'approve' } });
  assert.equal(decision.status, 200);
  assert.deepEqual(await eventTypes(), ['approve', 'before', 'created', 'proposed']);

  const after = await call(`/api/tests/${testId}/run`, { method: 'POST', ...auth, body: { phase: 'after' } });
  assert.equal(after.status, 201);
  assert.equal(after.json.run.outcome, 'supported_match');
  assert.deepEqual(await eventTypes(), ['after', 'approve', 'before', 'created', 'proposed']);

  const exactRun = await call(`/api/audit?entityType=test_run&entityId=${encodeURIComponent(before.json.run.id)}`, auth);
  assert.deepEqual(exactRun.json.events.map((event) => event.eventType), ['before']);
  const exactCorrection = await call(`/api/audit?entityType=correction&entityId=${encodeURIComponent(correctionId)}`, auth);
  assert.deepEqual(exactCorrection.json.events.map((event) => event.eventType).sort(), ['approve', 'proposed']);
});
