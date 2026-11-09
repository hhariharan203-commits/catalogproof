import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';

const password = 'integration-test-password-only';
const sessionSecret = 'integration-test-session-secret-at-least-32-chars';
const originalFetch = globalThis.fetch;
const orders = new Map();
let aiCall = 0;
let base;
let appServer;
let fetchWasReplaced = false;
let app;

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
function modelAnswer(payload) {
  aiCall += 1;
  const candidates = JSON.parse(payload.messages[1].content).candidates;
  const black = candidates.find((candidate) => candidate.sku === 'SKU-BLACK');
  const blue = candidates.find((candidate) => candidate.sku === 'SKU-BLUE');
  if (aiCall === 1) {
    return {
      selectedSku: 'SKU-BLUE', outcome: 'conflicting_evidence', matchedFacts: [],
      issues: [{ type: 'color_mismatch', fieldPath: 'variantAttributes.Color', actualValue: 'Blue', expectedOrMissingValue: null,
        evidence: [{ sku: 'SKU-BLUE', fieldPath: 'variantAttributes.Color', value: 'Blue', recordId: blue.recordId }],
        explanation: 'The selected color differs from the requested product.' }],
      correctionDraft: { sku: 'SKU-BLACK', fieldPath: 'variantAttributes.Color', proposedValue: 'Black',
        evidence: [{ sourceType: 'catalog_record', sourceReference: 'https://merchant.example/products/demo-shoe',
          exactQuote: 'Seller source labels this variant as Black.', recordId: black.recordId }],
        explanation: 'The merchant product source identifies this SKU as Black.' },
      uncertaintyReason: null,
    };
  }
  const blackColor = black.variantAttributes.Color;
  assert.equal(blackColor, 'Black');
  return { selectedSku: 'SKU-BLACK', outcome: 'supported_match', matchedFacts: [
    { fieldPath: 'variantAttributes.Color', value: 'Black', recordId: black.recordId },
  ], issues: [], uncertaintyReason: null };
}

test('actual routes compose import → AI diagnosis → seller approval → replay → PayPal readback', async (t) => {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  const publicOrigin = `https://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port), DATABASE_PATH: ':memory:', DEMO_PASSWORD: password,
    SESSION_SECRET: sessionSecret, NODE_ENV: 'test', PUBLIC_BASE_URL: publicOrigin,
    AI_BASE_URL: 'https://ai.example.test/v1', AI_API_KEY: 'fake-integration-key', AI_MODEL: 'integration-test-model',
    PAYPAL_CLIENT_ID: 'fake-client-id', PAYPAL_CLIENT_SECRET: 'fake-client-secret',
    PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  });

  let createCalls = 0;
  const createRequestIds = [];
  const remoteOrdersByRequestId = new Map();
  let captureCalls = 0;
  const captureRequestIds = [];
  globalThis.fetch = async (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    if (target.startsWith(base)) return originalFetch(input, init);
    if (target === 'https://ai.example.test/v1/chat/completions') {
      const payload = JSON.parse(init.body);
      return response({ choices: [{ message: { content: JSON.stringify(modelAnswer(payload)) } }] });
    }
    if (target === 'https://api-m.sandbox.paypal.com/v1/oauth2/token') {
      return response({ access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (target === 'https://api-m.sandbox.paypal.com/v2/checkout/orders' && init.method === 'POST') {
      createCalls += 1;
      const requestId = init.headers['PayPal-Request-Id'];
      createRequestIds.push(requestId);
      const payload = JSON.parse(init.body);
      let order = remoteOrdersByRequestId.get(requestId);
      if (!order) {
        const id = `ORDER-SANDBOX-${remoteOrdersByRequestId.size + 1}`;
        order = { id, status: 'CREATED', purchase_units: payload.purchase_units,
          links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
        remoteOrdersByRequestId.set(requestId, order);
        orders.set(id, order);
      }
      if (createCalls === 1) return response({ name: 'INTERNAL_SERVER_ERROR' }, 500);
      return response(order, 201);
    }
    const orderMatch = target.match(/^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/checkout\/orders\/([^/]+)(?:\/capture)?$/);
    if (orderMatch) {
      const id = decodeURIComponent(orderMatch[1]);
      const order = orders.get(id);
      if (!order) return response({ name: 'RESOURCE_NOT_FOUND' }, 404);
      if (target.endsWith('/capture') && init.method === 'POST') {
        captureCalls += 1;
        captureRequestIds.push(init.headers['PayPal-Request-Id']);
        order.status = 'COMPLETED';
        const amount = order.purchase_units[0].amount;
        order.purchase_units[0].payments = { captures: [{ id: 'CAPTURE-SANDBOX-1', status: 'COMPLETED', amount: { ...amount } }] };
        return response({ id: 'CAPTURE-SANDBOX-1', status: 'COMPLETED' });
      }
      return response(order);
    }
    throw new Error(`Unexpected external request in integration test: ${target}`);
  };
  fetchWasReplaced = true;

  app = await import(`../server/index.js?integration=${Date.now()}`);
  appServer = app.createServer();
  appServer.listen(port, '127.0.0.1');
  await once(appServer, 'listening');
  t.after(async () => {
    if (appServer?.listening) await new Promise((resolve) => appServer.close(resolve));
    if (fetchWasReplaced) globalThis.fetch = originalFetch;
  });

  const call = async (route, { method = 'GET', body, cookie = '', csrf = '', origin = publicOrigin } = {}) => {
    const headers = { origin };
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await originalFetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    return { status: res.status, headers: res.headers, json };
  };

  const login = await call('/api/auth/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = login.json.csrfToken;
  const auth = { cookie, csrf };

  const imported = await call('/api/catalog/import', { method: 'POST', ...auth, body: {
    sourceName: 'Synthetic route integration fixture', sourceUrl: 'https://merchant.example/products/demo-shoe',
    sourceLicense: 'Synthetic test data', isSynthetic: true,
    items: [
      { productId: 'PROD-1', sku: 'SKU-BLACK', title: 'Variant-proof demo shoe', description: 'Demo shoe',
        variantAttributes: { Color: 'Blue', Size: 'US 6' }, unitAmountMinor: 5299, currency: 'USD', available: true,
        productUrl: 'https://merchant.example/products/demo-shoe',
        sourceRecord: { evidence_text: 'Seller source labels this variant as Black.' } },
      { productId: 'PROD-1', sku: 'SKU-BLUE', title: 'Variant-proof demo shoe', description: 'Demo shoe',
        variantAttributes: { Color: 'Blue', Size: 'US 6' }, unitAmountMinor: 5299, currency: 'USD', available: true,
        productUrl: 'https://merchant.example/products/demo-shoe',
        sourceRecord: { evidence_text: 'Seller source labels this variant as Blue.' } },
    ],
  } });
  assert.equal(imported.status, 201);

  const created = await call('/api/tests', { method: 'POST', ...auth, body: {
    queryText: 'I want the darker shoe for an evening outfit, in US 6', expectedSku: 'SKU-BLACK',
  } });
  assert.equal(created.status, 201);
  const testId = created.json.test.id;
  const before = await call(`/api/tests/${testId}/run`, { method: 'POST', ...auth, body: { phase: 'before' } });
  assert.equal(before.status, 201, JSON.stringify(before.json));
  assert.equal(before.json.run.selectedSku, 'SKU-BLUE');
  assert.equal(before.json.run.outcome, 'conflicting_evidence');

  const citedEvidence = before.json.run.diagnosis.correctionDraft.evidence[0];
  const contradictory = await call('/api/corrections', { method: 'POST', ...auth, body: {
    queryTestId: testId, beforeRunId: before.json.run.id, sku: 'SKU-BLACK',
    fieldPath: 'variantAttributes.Color', proposedValue: 'Red',
    evidence: { sourceType: citedEvidence.sourceType, sourceReference: citedEvidence.sourceReference,
      exactQuote: citedEvidence.exactQuote, recordId: citedEvidence.recordId },
    explanation: 'This deliberately contradicts the verified test suggestion.',
  } });
  assert.equal(contradictory.status, 400);
  assert.equal(contradictory.json.error.code, 'CORRECTION_NOT_MATCHED_TO_DIAGNOSIS');

  const submitted = await call('/api/corrections', { method: 'POST', ...auth, body: {
    queryTestId: testId, beforeRunId: before.json.run.id, sku: 'SKU-BLACK',
    fieldPath: 'variantAttributes.Color', proposedValue: 'Black',
    evidence: { sourceType: 'catalog_record', sourceReference: 'https://merchant.example/products/demo-shoe',
      exactQuote: 'Seller source labels this variant as Black.', recordId: before.json.run.diagnosis.correctionDraft.evidence[0].recordId },
    explanation: 'The cited source record labels the variant Black.',
  } });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.json.correction.status, 'pending');
  assert.equal(submitted.json.correction.approvedBy, null);

  const decision = await call(`/api/corrections/${submitted.json.correction.id}/decision`, {
    method: 'POST', ...auth, body: { decision: 'approve', approvedBy: 'attacker-controlled-name' },
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.correction.approvedBy, 'demo-merchant');
  assert.ok(decision.json.catalogVersion.id);

  const after = await call(`/api/tests/${testId}/run`, { method: 'POST', ...auth, body: { phase: 'after' } });
  assert.equal(after.status, 201);
  assert.equal(after.json.run.selectedSku, 'SKU-BLACK');
  assert.equal(after.json.run.outcome, 'supported_match');

  const checkoutBody = { afterRunId: after.json.run.id, quantity: 1, price: 1, sku: 'TAMPERED' };
  const ambiguousCreate = await call('/api/checkouts', { method: 'POST', ...auth, body: checkoutBody });
  assert.equal(ambiguousCreate.status, 500);
  assert.equal(ambiguousCreate.json.error.code, 'PAYPAL_API_ERROR');
  const checkout = await call('/api/checkouts', { method: 'POST', ...auth, body: checkoutBody });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.json));
  assert.equal(checkout.json.sku, 'SKU-BLACK');
  assert.equal(checkout.json.totalAmountMinor, 5299);
  assert.equal(checkout.json.paypalOrderId, 'ORDER-SANDBOX-1');
  assert.match(checkout.json.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.equal(createCalls, 2);
  assert.equal(createRequestIds.length, 2);
  assert.equal(createRequestIds[1], createRequestIds[0]);
  assert.equal(remoteOrdersByRequestId.size, 1);

  const duplicateCheckout = await call('/api/checkouts', { method: 'POST', ...auth, body: checkoutBody });
  assert.equal(duplicateCheckout.status, 201);
  assert.equal(duplicateCheckout.json.checkoutId, checkout.json.checkoutId);
  assert.equal(duplicateCheckout.json.paypalOrderId, checkout.json.paypalOrderId);
  assert.equal(createCalls, 2);

  const pending = await call(`/api/checkouts/${checkout.json.checkoutId}`, { ...auth });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.verifiedPaid, false);
  assert.equal(pending.json.status, 'approval_pending');
  const prematureCapture = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(prematureCapture.status, 409);
  assert.equal(prematureCapture.json.error.code, 'PAYPAL_NOT_APPROVED');
  assert.equal(captureCalls, 0);

  orders.get('ORDER-SANDBOX-1').status = 'APPROVED';
  const approved = await call(`/api/checkouts/${checkout.json.checkoutId}`, { ...auth });
  assert.equal(approved.json.verifiedPaid, false);
  assert.equal(approved.json.status, 'approved');

  const capture = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(capture.status, 200);
  assert.equal(capture.json.verifiedPaid, true);
  assert.equal(capture.json.orderStatus, 'COMPLETED');
  assert.equal(capture.json.captureStatus, 'COMPLETED');
  assert.equal(capture.json.paypalCaptureId, 'CAPTURE-SANDBOX-1');
  assert.equal(captureCalls, 1);
  assert.equal(captureRequestIds.length, 1);

  const captureRetry = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(captureRetry.status, 200);
  assert.equal(captureRetry.json.verifiedPaid, true);
  assert.equal(captureRetry.json.orderStatus, 'COMPLETED');
  assert.equal(captureRetry.json.paypalCaptureId, 'CAPTURE-SANDBOX-1');
  assert.equal(captureCalls, 1);

  const completedOrder = orders.get('ORDER-SANDBOX-1');
  const originalCaptures = completedOrder.purchase_units[0].payments.captures;
  completedOrder.purchase_units[0].payments.captures = [...originalCaptures, {
    id: 'CAPTURE-SANDBOX-2', status: 'COMPLETED', amount: { ...originalCaptures[0].amount },
  }];
  const multipleCaptureRetry = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(multipleCaptureRetry.status, 409);
  assert.equal(multipleCaptureRetry.json.verifiedPaid, false);
  assert.equal(multipleCaptureRetry.json.status, 'mismatch');
  const multipleCaptureReadback = await call(`/api/checkouts/${checkout.json.checkoutId}`, { ...auth });
  assert.equal(multipleCaptureReadback.status, 200);
  assert.equal(multipleCaptureReadback.json.verifiedPaid, false);
  assert.equal(multipleCaptureReadback.json.status, 'mismatch');
  completedOrder.purchase_units[0].payments.captures = originalCaptures;

  const originalCaptureStatus = originalCaptures[0].status;
  delete originalCaptures[0].status;
  const missingCaptureStatusReadback = await call(`/api/checkouts/${checkout.json.checkoutId}`, { ...auth });
  assert.equal(missingCaptureStatusReadback.status, 200);
  assert.equal(missingCaptureStatusReadback.json.verifiedPaid, false);
  assert.equal(missingCaptureStatusReadback.json.captureStatus, null);
  assert.equal(missingCaptureStatusReadback.json.status, 'mismatch');
  originalCaptures[0].status = originalCaptureStatus;

  completedOrder.purchase_units[0].items[0].sku = 'SKU-TAMPERED';
  const mismatchedSkuRetry = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(mismatchedSkuRetry.status, 409);
  assert.equal(mismatchedSkuRetry.json.error.code, 'PAYPAL_ORDER_MISMATCH');
  assert.equal(captureCalls, 1);
  completedOrder.purchase_units[0].items[0].sku = 'SKU-BLACK';

  completedOrder.purchase_units[0].amount.value = '0.01';
  const mismatchedAmountRetry = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(mismatchedAmountRetry.status, 409);
  assert.equal(mismatchedAmountRetry.json.error.code, 'PAYPAL_ORDER_MISMATCH');
  assert.equal(captureCalls, 1);
  completedOrder.purchase_units[0].amount.value = '52.99';

  completedOrder.purchase_units[0].payments.captures[0].amount.value = '0.01';
  const mismatchedCaptureRetry = await call(`/api/checkouts/${checkout.json.checkoutId}/capture`, { method: 'POST', ...auth, body: {} });
  assert.equal(mismatchedCaptureRetry.status, 409);
  assert.equal(mismatchedCaptureRetry.json.verifiedPaid, false);
  assert.equal(mismatchedCaptureRetry.json.status, 'mismatch');
  assert.equal(captureCalls, 1);
  const mismatchedCapture = await call(`/api/checkouts/${checkout.json.checkoutId}`, { ...auth });
  assert.equal(mismatchedCapture.status, 200);
  assert.equal(mismatchedCapture.json.verifiedPaid, false);
  assert.equal(mismatchedCapture.json.status, 'mismatch');
  assert.equal(aiCall, 2);
});
