import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as diagnostics from './diagnostics.js';
import * as paypal from './paypal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI_ROOT = path.join(ROOT, 'ui');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'catalogproof.sqlite');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PROMPT_VERSION = 'catalogproof-diagnostic-v1';
const MAX_BODY = 1_000_000;
const COOKIE_NAME = 'cp_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

if (DB_PATH !== ':memory:') mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
function ensureColumn(table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
ensureColumn('checkouts', 'app_status', "TEXT NOT NULL DEFAULT 'approval_pending'");
ensureColumn('checkouts', 'approval_url', 'TEXT');

const now = () => new Date().toISOString();
const uid = () => randomUUID();
const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
function apiError(code, message, status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}
function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}
function setCookie(res, value, maxAge) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}
function clearCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}
function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw apiError('AUTH_NOT_CONFIGURED', 'Session security is not configured.', 503);
  return secret;
}
function signedCookie(sessionId, expiresAt) {
  const payload = `${sessionId}.${expiresAt}`;
  const sig = createHmac('sha256', secretKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function timingSafeTextEqual(a, b) {
  const ah = createHash('sha256').update(String(a)).digest();
  const bh = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ah, bh);
}
function requestSession(req) {
  const cookie = req.headers.cookie || '';
  const raw = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  const [sid, expText, signature] = raw.split('.');
  const expiresAt = Number(expText);
  if (!sid || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) return null;
  let expected;
  try { expected = signedCookie(sid, expiresAt).split('.').at(-1); } catch { return null; }
  if (!timingSafeTextEqual(signature, expected)) return null;
  const session = sessions.get(sid);
  if (!session || session.expiresAt !== expiresAt) return null;
  return session;
}
function originIsSame(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return new URL(PUBLIC_BASE_URL).origin === u.origin;
  } catch { return false; }
}
function requireSession(req) {
  const session = requestSession(req);
  if (!session) throw apiError('UNAUTHENTICATED', 'Please sign in to the merchant workspace.', 401);
  return session;
}
function checkoutBaseUrl() {
  let url;
  try { url = new URL(PUBLIC_BASE_URL); }
  catch { throw apiError('PAYPAL_UNAVAILABLE', 'PUBLIC_BASE_URL is not configured as an absolute URL.', 503); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
      || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !local)
      || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw apiError('PAYPAL_UNAVAILABLE', 'PUBLIC_BASE_URL must be an HTTPS origin (HTTP is allowed only for localhost development).', 503);
  }
  return url.origin;
}
function requireMutation(req) {
  const session = requireSession(req);
  if (!originIsSame(req)) throw apiError('ORIGIN_REJECTED', 'This request must come from the CatalogProof site.', 403);
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || !timingSafeTextEqual(token, session.csrfToken)) {
    throw apiError('CSRF_REJECTED', 'The session security token is missing or expired.', 403);
  }
  return session;
}
function isPublicRoute(method, pathname) {
  return pathname === '/api/health'
    || (pathname === '/api/auth/session' && method === 'GET')
    || (pathname === '/api/auth/login' && method === 'POST');
}
async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) throw apiError('BODY_TOO_LARGE', 'Request body is too large.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw apiError('BODY_TOO_LARGE', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object required');
    return result;
  } catch {
    throw apiError('INVALID_JSON', 'Request body must be a JSON object.', 400);
  }
}
function audit(entityType, entityId, actor, eventType, payload = {}) {
  db.prepare(`INSERT INTO audit_events(id,entity_type,entity_id,actor,event_type,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(uid(), entityType, entityId, actor, eventType, json(payload), now());
}
function itemView(row) {
  return {
    id: row.id, productId: row.product_id, sku: row.sku, title: row.title,
    description: row.description, brand: row.brand,
    variantAttributes: parseJson(row.variant_attributes_json, {}),
    unitAmountMinor: row.unit_amount_minor, currency: row.currency,
    available: Boolean(row.available), productUrl: row.product_url, imageUrl: row.image_url,
    sourceRecord: parseJson(row.source_record_json, {}),
  };
}
function versionView(row) {
  return { id: row.id, sourceName: row.source_name, sourceUrl: row.source_url, sourceLicense: row.source_license,
    isSynthetic: Boolean(row.is_synthetic), createdAt: row.created_at, parentVersionId: row.parent_version_id,
    changeSummary: row.change_summary };
}
function catalogRow(id, sku) {
  return db.prepare('SELECT * FROM catalog_items WHERE catalog_version_id=? AND sku=?').get(id, sku);
}
function getVersion(id) {
  return db.prepare('SELECT * FROM catalog_versions WHERE id=?').get(id);
}
function requireText(value, field, max = 1200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw apiError('INVALID_INPUT', `${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}
function normalizeImportItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw apiError('INVALID_ITEM', 'Every item must be an object.');
  const productId = requireText(item.productId, 'productId', 200);
  const sku = requireText(item.sku, 'sku', 127);
  const title = requireText(item.title, 'title', 300);
  const currency = requireText(item.currency, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw apiError('INVALID_CURRENCY', 'Currency must be a three-letter code.');
  if (!Number.isSafeInteger(item.unitAmountMinor) || item.unitAmountMinor < 0) throw apiError('INVALID_PRICE', 'unitAmountMinor must be a non-negative integer.');
  const attrs = item.variantAttributes ?? {};
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw apiError('INVALID_ATTRIBUTES', 'variantAttributes must be an object.');
  if (typeof item.available !== 'boolean') throw apiError('INVALID_AVAILABILITY', 'available must be a boolean value.');
  const simple = Object.fromEntries(Object.entries(attrs).filter(([, v]) => ['string','number','boolean'].includes(typeof v)));
  return {
    id: uid(), productId, sku, title, description: typeof item.description === 'string' ? item.description : null,
    brand: typeof item.brand === 'string' ? item.brand : null, attrs: simple,
    unitAmountMinor: item.unitAmountMinor, currency,
    available: item.available, productUrl: typeof item.productUrl === 'string' ? item.productUrl : null,
    imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : null,
    sourceRecord: item.sourceRecord && typeof item.sourceRecord === 'object' ? item.sourceRecord : {},
  };
}
function currentVersion() {
  return db.prepare('SELECT * FROM catalog_versions ORDER BY created_at DESC LIMIT 1').get() || null;
}
function persistCatalogVersion({ sourceName, sourceUrl = null, sourceLicense = null, isSynthetic = true,
  items, parentVersionId = null, changeSummary = 'Catalog import' }) {
  const versionId = uid();
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO catalog_versions(id,source_name,source_url,source_license,is_synthetic,created_at,parent_version_id,change_summary) VALUES(?,?,?,?,?,?,?,?)')
      .run(versionId, sourceName, sourceUrl, sourceLicense, isSynthetic ? 1 : 0, timestamp, parentVersionId, changeSummary);
    const insert = db.prepare(`INSERT INTO catalog_items(id,catalog_version_id,product_id,sku,title,description,brand,variant_attributes_json,unit_amount_minor,currency,available,product_url,image_url,source_record_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of items) insert.run(item.id, versionId, item.productId, item.sku, item.title, item.description,
      item.brand, json(item.attrs), item.unitAmountMinor, item.currency, item.available ? 1 : 0,
      item.productUrl, item.imageUrl, json(item.sourceRecord));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getVersion(versionId);
}
function seedDemoCatalog() {
  const seedPath = process.env.DEMO_SEED_PATH || path.join(ROOT, 'data', 'demo_seed.json');
  let seed;
  try { seed = JSON.parse(readFileSync(seedPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Demo seed catalog could not be loaded from ${seedPath}.`);
  }
  if (!seed || typeof seed !== 'object' || !Array.isArray(seed.items) || seed.items.length < 1 || seed.items.length > 5000) {
    throw new Error('Demo seed catalog must contain 1 to 5000 items.');
  }
  const items = seed.items.map(normalizeImportItem);
  if (new Set(items.map((item) => item.sku)).size !== items.length) throw new Error('Demo seed catalog contains duplicate SKUs.');
  return persistCatalogVersion({
    sourceName: requireText(seed.sourceName, 'sourceName', 200),
    sourceUrl: typeof seed.sourceUrl === 'string' ? seed.sourceUrl : null,
    sourceLicense: typeof seed.sourceLicense === 'string' ? seed.sourceLicense : null,
    isSynthetic: seed.isSynthetic !== false,
    items,
    changeSummary: 'Public demo seed',
  });
}
if (!currentVersion()) seedDemoCatalog();
function mapTest(row) {
  return { id: row.id, catalogVersionId: row.catalog_version_id, queryText: row.query_text,
    expectedSku: row.expected_sku, frozenSettings: parseJson(row.frozen_settings_json, {}),
    isSynthetic: Boolean(row.is_synthetic), createdAt: row.created_at };
}
function mapRun(row) {
  return { id: row.id, queryTestId: row.query_test_id, catalogVersionId: row.catalog_version_id,
    phase: row.phase, selectedSku: row.selected_sku, outcome: row.outcome,
    diagnosis: parseJson(row.diagnosis_json, {}), modelId: row.model_id,
    promptVersion: row.prompt_version, candidateSkus: parseJson(row.candidate_skus_json, []), createdAt: row.created_at };
}
function mapCorrection(row) {
  return { id: row.id, queryTestId: row.query_test_id, beforeRunId: row.before_run_id,
    sku: row.sku, fieldPath: row.field_path, originalValue: parseJson(row.original_value_json),
    proposedValue: parseJson(row.proposed_value_json), evidence: parseJson(row.evidence_json, {}),
    explanation: row.explanation, status: row.status, approvedBy: row.approved_by,
    approvedAt: row.approved_at, newCatalogVersionId: row.new_catalog_version_id, createdAt: row.created_at };
}
function routeBase(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${host}`;
}
function minorDigits(currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
  catch { throw apiError('INVALID_CURRENCY', 'Unsupported currency.', 400); }
}
function amountToMinor(value, currency) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const digits = minorDigits(currency);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const scale = 10n ** BigInt(digits);
  const amount = BigInt(whole) * scale + BigInt((fraction.padEnd(digits, '0') || '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(amount);
}
function verifyOrder(order, snapshot) {
  const unit = Array.isArray(order?.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
  const item = Array.isArray(unit?.items) && unit.items.length === 1 ? unit.items[0] : null;
  const amount = unit?.amount;
  const itemUnit = item?.unit_amount;
  const expectedVariant = Object.entries(snapshot.variantAttributes || {}).map(([key, value]) => `${key}: ${String(value)}`).join('; ');
  const mismatch = !unit || !item
    || unit.reference_id !== snapshot.catalogVersionId
    || unit.custom_id !== snapshot.productId
    || item.sku !== snapshot.sku
    || item.name !== snapshot.title
    || (expectedVariant && item.description !== expectedVariant)
    || Number(item.quantity) !== snapshot.quantity
    || itemUnit?.currency_code !== snapshot.currency
    || amountToMinor(itemUnit?.value, snapshot.currency) !== snapshot.unitAmountMinor
    || amount?.currency_code !== snapshot.currency
    || amountToMinor(amount?.value, snapshot.currency) !== snapshot.totalAmountMinor
    || BigInt(snapshot.quantity) * BigInt(snapshot.unitAmountMinor) !== BigInt(snapshot.totalAmountMinor);
  if (mismatch) throw apiError('PAYPAL_ORDER_MISMATCH', 'PayPal order does not match the frozen catalog selection.', 409);
  return { unit, item };
}
function latestCapture(order) {
  const captures = order?.purchase_units?.[0]?.payments?.captures;
  return Array.isArray(captures) && captures.length ? captures.at(-1) : null;
}
function captureList(order) {
  const captures = order?.purchase_units?.[0]?.payments?.captures;
  return Array.isArray(captures) ? captures : [];
}
function checkoutCreateResponse(row) {
  const snapshot = parseJson(row.snapshot_json, {});
  return { checkoutId: row.id, sku: snapshot.sku, title: snapshot.title,
    variantAttributes: snapshot.variantAttributes, quantity: snapshot.quantity,
    unitAmountMinor: snapshot.unitAmountMinor, currency: snapshot.currency,
    totalAmountMinor: snapshot.totalAmountMinor, approvalUrl: row.approval_url,
    paypalOrderId: row.paypal_order_id, status: row.app_status };
}
function checkoutsResponse(row, order) {
  const snapshot = parseJson(row.snapshot_json, {});
  const captures = captureList(order);
  const capture = latestCapture(order);
  const captureStatus = capture ? (capture.status || null) : (row.paypal_capture_status || null);
  const captureId = capture ? (capture.id || null) : (row.paypal_capture_id || null);
  const captureMatches = captures.length === 1 && Boolean(capture?.id)
    && capture?.amount?.currency_code === snapshot.currency
    && amountToMinor(capture?.amount?.value, snapshot.currency) === snapshot.totalAmountMinor;
  const paid = order?.status === 'COMPLETED' && capture?.status === 'COMPLETED' && captureMatches;
  let appStatus = row.app_status;
  if (paid) appStatus = 'completed';
  else if (order?.status === 'APPROVED') appStatus = 'approved';
  else if (order?.status === 'VOIDED') appStatus = 'cancelled';
  else if (order?.status === 'PAYER_ACTION_REQUIRED' || order?.status === 'CREATED') appStatus = 'approval_pending';
  else if (order?.status === 'COMPLETED') appStatus = 'mismatch';
  if (appStatus !== row.app_status) {
    db.prepare('UPDATE checkouts SET app_status=?, paypal_order_status=?, paypal_capture_status=?, paypal_capture_id=?, updated_at=? WHERE id=?')
      .run(appStatus, order?.status || row.paypal_order_status, captureStatus, captureId, now(), row.id);
    audit('checkout', row.id, 'paypal', 'state_readback', { orderStatus: order?.status, captureStatus, captureId });
  }
  return { checkoutId: row.id, snapshot, approvalUrl: row.approval_url,
    orderStatus: order?.status || row.paypal_order_status,
    captureStatus, paypalOrderId: row.paypal_order_id, paypalCaptureId: captureId,
    status: appStatus, verifiedPaid: paid };
}
async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  if (!pathname.startsWith('/api/')) return false;
  if (!isPublicRoute(method, pathname)) {
    if (['POST','PUT','PATCH','DELETE'].includes(method)) requireMutation(req);
    else requireSession(req);
  }

  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { ok: true, aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
      paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET), database: DB_PATH === ':memory:' ? 'memory' : 'sqlite' });
  }
  if (method === 'GET' && pathname === '/api/auth/session') {
    const session = requestSession(req);
    return send(res, 200, { authenticated: Boolean(session), csrfToken: session?.csrfToken || null });
  }
  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!originIsSame(req)) throw apiError('ORIGIN_REJECTED', 'Sign-in must come from the CatalogProof site.', 403);
    const body = await readBody(req);
    const ip = req.socket.remoteAddress || 'unknown';
    const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    if (record.resetAt < Date.now()) { record.count = 0; record.resetAt = Date.now() + 15 * 60 * 1000; }
    if (record.count >= 8) return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } });
    const expected = process.env.DEMO_PASSWORD;
    if (!expected || expected.length < 12 || typeof body.password !== 'string' || !timingSafeTextEqual(body.password, expected)) {
      record.count += 1; loginAttempts.set(ip, record);
      return send(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'The demo password is not correct.' } });
    }
    loginAttempts.delete(ip);
    const id = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + SESSION_MS;
    const session = { id, expiresAt, csrfToken: randomBytes(32).toString('base64url'), actor: 'demo-merchant' };
    sessions.set(id, session);
    setCookie(res, signedCookie(id, expiresAt), Math.floor(SESSION_MS / 1000));
    return send(res, 200, { authenticated: true, csrfToken: session.csrfToken });
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const session = requireMutation(req);
    sessions.delete(session.id); clearCookie(res);
    return send(res, 200, { authenticated: false });
  }
  if (method === 'POST' && pathname === '/api/demo/reset') {
    const tables = ['audit_events','checkouts','corrections','test_runs','query_tests','catalog_items','catalog_versions'];
    db.exec('BEGIN IMMEDIATE');
    try { for (const table of tables) db.exec(`DELETE FROM ${table}`); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    if (!seedDemoCatalog()) throw apiError('DEMO_SEED_UNAVAILABLE', 'The public demo seed is missing; reset could not restore the workspace.', 503);
    return send(res, 200, { reset: true });
  }
  if (method === 'GET' && pathname === '/api/catalog') {
    const version = currentVersion();
    const versions = db.prepare('SELECT * FROM catalog_versions ORDER BY created_at DESC').all().map(versionView);
    const items = version ? db.prepare('SELECT * FROM catalog_items WHERE catalog_version_id=? ORDER BY title,sku').all(version.id).map(itemView) : [];
    return send(res, 200, { currentVersion: version ? versionView(version) : null, versions, items });
  }
  if (method === 'POST' && pathname === '/api/catalog/import') {
    const body = await readBody(req);
    const sourceName = requireText(body.sourceName, 'sourceName', 200);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 5000) throw apiError('INVALID_ITEMS', 'items must contain 1 to 5000 product variants.');
    const items = body.items.map(normalizeImportItem);
    if (new Set(items.map((i) => i.sku)).size !== items.length) throw apiError('DUPLICATE_SKU', 'SKU values must be unique in a catalog version.');
    const versionId = uid();
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO catalog_versions(id,source_name,source_url,source_license,is_synthetic,created_at,parent_version_id,change_summary) VALUES(?,?,?,?,?,?,?,?)')
        .run(versionId, sourceName, typeof body.sourceUrl === 'string' ? body.sourceUrl : null,
          typeof body.sourceLicense === 'string' ? body.sourceLicense : null, body.isSynthetic ? 1 : 0, timestamp, currentVersion()?.id || null, 'Catalog import');
      const insert = db.prepare(`INSERT INTO catalog_items(id,catalog_version_id,product_id,sku,title,description,brand,variant_attributes_json,unit_amount_minor,currency,available,product_url,image_url,source_record_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items) insert.run(item.id, versionId, item.productId, item.sku, item.title, item.description, item.brand, json(item.attrs), item.unitAmountMinor, item.currency, item.available ? 1 : 0, item.productUrl, item.imageUrl, json(item.sourceRecord));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    audit('catalog_version', versionId, 'seller', 'imported', { sourceName, count: items.length, isSynthetic: Boolean(body.isSynthetic) });
    return send(res, 201, { catalogVersion: versionView(getVersion(versionId)), itemCount: items.length });
  }
  const testsRoute = pathname.match(/^\/api\/tests\/([A-Za-z0-9-]+)(?:\/(run))?$/);
  if (method === 'POST' && pathname === '/api/tests') {
    const body = await readBody(req);
    const queryText = requireText(body.queryText, 'queryText', 1200);
    const version = currentVersion();
    if (!version) throw apiError('NO_CATALOG', 'Import a catalog before testing a query.', 409);
    const expectedSku = requireText(body.expectedSku, 'expectedSku', 127);
    if (!catalogRow(version.id, expectedSku)) throw apiError('UNKNOWN_EXPECTED_SKU', 'expectedSku must exist in the current catalog.', 400);
    const id = uid();
    const settings = { model: process.env.AI_MODEL || null, promptVersion: PROMPT_VERSION,
      rankingVersion: 'deterministic-v1', frozenAt: now(), candidateLimit: 12 };
    db.prepare('INSERT INTO query_tests(id,catalog_version_id,query_text,expected_sku,frozen_settings_json,is_synthetic,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, version.id, queryText, expectedSku, json(settings), version.is_synthetic, now());
    audit('query_test', id, 'seller', 'created', { catalogVersionId: version.id, expectedSku });
    return send(res, 201, { test: mapTest(db.prepare('SELECT * FROM query_tests WHERE id=?').get(id)) });
  }
  if (method === 'GET' && testsRoute && !testsRoute[2]) {
    const row = db.prepare('SELECT * FROM query_tests WHERE id=?').get(testsRoute[1]);
    if (!row) throw apiError('NOT_FOUND', 'Query test not found.', 404);
    return send(res, 200, { test: mapTest(row), runs: db.prepare('SELECT * FROM test_runs WHERE query_test_id=? ORDER BY created_at').all(row.id).map(mapRun),
      corrections: db.prepare('SELECT * FROM corrections WHERE query_test_id=? ORDER BY created_at').all(row.id).map(mapCorrection) });
  }
  if (method === 'POST' && testsRoute && testsRoute[2] === 'run') {
    const body = await readBody(req);
    if (!['before','after'].includes(body.phase)) throw apiError('INVALID_PHASE', 'phase must be before or after.');
    const test = db.prepare('SELECT * FROM query_tests WHERE id=?').get(testsRoute[1]);
    if (!test) throw apiError('NOT_FOUND', 'Query test not found.', 404);
    let versionId = test.catalog_version_id;
    if (body.phase === 'after') {
      const correction = db.prepare("SELECT * FROM corrections WHERE query_test_id=? AND status='approved' ORDER BY approved_at DESC LIMIT 1").get(test.id);
      if (!correction?.new_catalog_version_id) throw apiError('CORRECTION_NOT_APPROVED', 'Approve a supported correction before the after-run.', 409);
      versionId = correction.new_catalog_version_id;
    }
    const candidates = db.prepare('SELECT * FROM catalog_items WHERE catalog_version_id=? ORDER BY sku').all(versionId).map((row) => ({
      sku: row.sku, title: row.title, description: row.description || '', brand: row.brand || '',
      variantAttributes: parseJson(row.variant_attributes_json, {}), sourceRecord: parseJson(row.source_record_json, {}),
      productUrl: row.product_url, available: Boolean(row.available), recordId: row.id,
    }));
    if (typeof diagnostics.diagnose !== 'function') throw apiError('AI_UNAVAILABLE', 'The AI diagnostic engine is not ready.', 503);
    let result;
    try { result = await diagnostics.diagnose({ queryText: test.query_text, expectedSku: test.expected_sku, catalogVersion: versionId, candidates }); }
    catch (error) { if (error.code === 'AI_UNAVAILABLE') throw apiError(error.code, error.message, 503); throw apiError(error.code || 'AI_DIAGNOSTIC_FAILED', error.message || 'Diagnosis failed.', 422); }
    const candidateSkus = candidates.map((candidate) => candidate.sku);
    if (result.selectedSku && !candidateSkus.includes(result.selectedSku)) throw apiError('AI_INVALID_RESPONSE', 'AI selected an SKU outside the catalog.', 422);
    const id = uid();
    db.prepare('INSERT INTO test_runs(id,query_test_id,catalog_version_id,phase,selected_sku,outcome,diagnosis_json,model_id,prompt_version,candidate_skus_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, test.id, versionId, body.phase, result.selectedSku || null, result.outcome, json(result), process.env.AI_MODEL || null, PROMPT_VERSION, json(candidateSkus), now());
    audit('test_run', id, 'ai', body.phase, { queryTestId: test.id, selectedSku: result.selectedSku || null, outcome: result.outcome, versionId });
    return send(res, 201, { run: mapRun(db.prepare('SELECT * FROM test_runs WHERE id=?').get(id)) });
  }
  if (method === 'POST' && pathname === '/api/corrections') {
    const body = await readBody(req);
    const test = db.prepare('SELECT * FROM query_tests WHERE id=?').get(body.queryTestId);
    const run = db.prepare("SELECT * FROM test_runs WHERE id=? AND phase='before'").get(body.beforeRunId);
    if (!test || !run || run.query_test_id !== test.id) throw apiError('INVALID_RUN', 'A matching before-run is required.', 400);
    const sku = requireText(body.sku, 'sku', 127);
    const sourceRow = catalogRow(run.catalog_version_id, sku);
    if (!sourceRow) throw apiError('UNKNOWN_SKU', 'Correction SKU must exist in the frozen catalog.', 400);
    const fieldPath = requireText(body.fieldPath, 'fieldPath', 200);
    const parts = fieldPath.split('.');
    if (parts.length !== 2 || !['variantAttributes','description','title','brand'].includes(parts[0]) || ['sku','price','stock','available','availability','currency','amount'].some((x) => parts[1].toLowerCase().includes(x))) {
      throw apiError('UNSUPPORTED_FIELD', 'Only non-commerce descriptive attributes may be corrected in this demo.', 400);
    }
    const evidence = body.evidence;
    if (!evidence || typeof evidence !== 'object' || typeof evidence.exactQuote !== 'string' || !evidence.exactQuote.trim()) throw apiError('EVIDENCE_REQUIRED', 'A source-backed quote is required.', 400);
    const diagnosis = parseJson(run.diagnosis_json, {});
    const draft = diagnosis.correctionDraft;
    const matchesDraft = draft && draft.sku === sku && draft.fieldPath === fieldPath
      && JSON.stringify(draft.proposedValue) === JSON.stringify(body.proposedValue)
      && Array.isArray(draft.evidence) && draft.evidence.some((citation) =>
        citation.sourceType === evidence.sourceType
        && citation.sourceReference === evidence.sourceReference
        && citation.exactQuote === evidence.exactQuote
        && (citation.recordId ?? null) === (evidence.recordId ?? null));
    if (!matchesDraft) throw apiError('CORRECTION_NOT_MATCHED_TO_DIAGNOSIS', 'Correction values and evidence must exactly match the validated suggestion from this frozen run.', 400);
    const sourceRecordText = JSON.stringify(parseJson(sourceRow.source_record_json, {}));
    const isSellerEvidence = evidence.sourceType === 'seller_attestation';
    if (!isSellerEvidence && !sourceRecordText.includes(evidence.exactQuote)) throw apiError('EVIDENCE_NOT_FOUND', 'The exact quote must occur in the catalog source record, or be labeled as a seller attestation.', 400);
    const attrs = parseJson(sourceRow.variant_attributes_json, {});
    const originalValue = parts[0] === 'variantAttributes' ? attrs[parts[1]] : sourceRow[parts[0]];
    const proposedValue = body.proposedValue;
    if (!['string','number','boolean'].includes(typeof proposedValue)) throw apiError('INVALID_CORRECTION', 'Proposed value must be a simple string, number, or boolean.', 400);
    const id = uid();
    db.prepare('INSERT INTO corrections(id,query_test_id,before_run_id,sku,field_path,original_value_json,proposed_value_json,evidence_json,explanation,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, test.id, run.id, sku, fieldPath, json(originalValue), json(proposedValue), json(evidence), requireText(body.explanation, 'explanation', 1200), 'pending', now());
    audit('correction', id, 'ai', 'proposed', { sku, fieldPath, originalValue, proposedValue, sourceType: evidence.sourceType });
    return send(res, 201, { correction: mapCorrection(db.prepare('SELECT * FROM corrections WHERE id=?').get(id)) });
  }
  const correctionDecision = pathname.match(/^\/api\/corrections\/([A-Za-z0-9-]+)\/decision$/);
  if (method === 'POST' && correctionDecision) {
    const body = await readBody(req);
    if (!['approve','reject'].includes(body.decision)) throw apiError('INVALID_DECISION', 'decision must be approve or reject.');
    const correction = db.prepare("SELECT * FROM corrections WHERE id=? AND status='pending'").get(correctionDecision[1]);
    if (!correction) throw apiError('NOT_FOUND_OR_DECIDED', 'Pending correction not found.', 404);
    let childVersion = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (body.decision === 'approve') {
        const sourceVersion = getVersion(db.prepare('SELECT catalog_version_id FROM query_tests WHERE id=?').get(correction.query_test_id).catalog_version_id);
        const versionId = uid();
        db.prepare('INSERT INTO catalog_versions(id,source_name,source_url,source_license,is_synthetic,created_at,parent_version_id,change_summary) VALUES(?,?,?,?,?,?,?,?)')
          .run(versionId, sourceVersion.source_name, sourceVersion.source_url, sourceVersion.source_license, sourceVersion.is_synthetic, now(), sourceVersion.id, `Seller-approved ${correction.field_path} correction`);
        const oldItems = db.prepare('SELECT * FROM catalog_items WHERE catalog_version_id=?').all(sourceVersion.id);
        for (const old of oldItems) {
          const attrs = parseJson(old.variant_attributes_json, {});
          let description = old.description, title = old.title, brand = old.brand;
          if (old.sku === correction.sku) {
            const [root, key] = correction.field_path.split('.');
            const value = parseJson(correction.proposed_value_json);
            if (root === 'variantAttributes') attrs[key] = value;
            else if (root === 'description') description = String(value);
            else if (root === 'title') title = String(value);
            else if (root === 'brand') brand = String(value);
          }
          db.prepare('INSERT INTO catalog_items(id,catalog_version_id,product_id,sku,title,description,brand,variant_attributes_json,unit_amount_minor,currency,available,product_url,image_url,source_record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uid(), versionId, old.product_id, old.sku, title, description, brand, json(attrs), old.unit_amount_minor, old.currency, old.available, old.product_url, old.image_url, old.source_record_json);
        }
        childVersion = versionId;
        db.prepare("UPDATE corrections SET status='approved',approved_by=?,approved_at=?,new_catalog_version_id=? WHERE id=?")
          .run('demo-merchant', now(), versionId, correction.id);
      } else {
        db.prepare("UPDATE corrections SET status='rejected',approved_by=?,approved_at=? WHERE id=?")
          .run('demo-merchant', now(), correction.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const updated = db.prepare('SELECT * FROM corrections WHERE id=?').get(correction.id);
    audit('correction', correction.id, 'seller', body.decision, { newCatalogVersionId: childVersion });
    return send(res, 200, { correction: mapCorrection(updated), catalogVersion: childVersion ? versionView(getVersion(childVersion)) : null });
  }
  if (method === 'POST' && pathname === '/api/checkouts') {
    const body = await readBody(req);
    const run = db.prepare("SELECT * FROM test_runs WHERE id=? AND phase='after'").get(body.afterRunId);
    if (!run) throw apiError('AFTER_RUN_REQUIRED', 'A completed after-run is required before checkout.', 409);
    const test = db.prepare('SELECT * FROM query_tests WHERE id=?').get(run.query_test_id);
    if (!test || run.selected_sku !== test.expected_sku || run.outcome !== 'supported_match') throw apiError('WRONG_VARIANT', 'Only the supported expected SKU can be checked out.', 409);
    const quantity = body.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) throw apiError('INVALID_QUANTITY', 'Quantity must be between 1 and 10.', 400);
    let existing, id, requestId, snapshot;
    db.exec('BEGIN IMMEDIATE');
    try {
      existing = db.prepare('SELECT * FROM checkouts WHERE after_run_id=? AND quantity=? ORDER BY created_at DESC, id DESC LIMIT 1').get(run.id, quantity);
      if (existing) {
        id = existing.id;
        requestId = existing.create_request_id;
        snapshot = parseJson(existing.snapshot_json, {});
      } else {
        const item = catalogRow(run.catalog_version_id, run.selected_sku);
        if (!item || !item.available) throw apiError('ITEM_UNAVAILABLE', 'The selected catalog variant is not marked available; checkout is blocked.', 409);
        const total = item.unit_amount_minor * quantity;
        if (!Number.isSafeInteger(total)) throw apiError('INVALID_TOTAL', 'Order total exceeds supported range.', 400);
        id = uid();
        requestId = randomBytes(16).toString('hex');
        const base = checkoutBaseUrl();
        snapshot = {
          checkoutId: id, catalogVersionId: run.catalog_version_id, productId: item.product_id, sku: item.sku,
          title: item.title, variantAttributes: parseJson(item.variant_attributes_json, {}), quantity,
          unitAmountMinor: item.unit_amount_minor, currency: item.currency, totalAmountMinor: total,
          productUrl: item.product_url, imageUrl: item.image_url,
          returnUrl: `${base}/checkout/return?checkoutId=${encodeURIComponent(id)}`,
          cancelUrl: `${base}/checkout/cancel?checkoutId=${encodeURIComponent(id)}`,
        };
        const timestamp = now();
        db.prepare(`INSERT INTO checkouts(id,catalog_version_id,after_run_id,sku,quantity,unit_amount_minor,currency,total_amount_minor,snapshot_json,create_request_id,app_status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, run.catalog_version_id, run.id, item.sku, quantity, item.unit_amount_minor, item.currency, total, json(snapshot), requestId, 'approval_pending', timestamp, timestamp);
        audit('checkout', id, 'buyer', 'checkout_started', { sku: item.sku, quantity, totalAmountMinor: total, currency: item.currency });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (existing?.paypal_order_id && existing.approval_url) {
      return send(res, 201, checkoutCreateResponse(existing));
    }
    try {
      const order = await paypal.createOrder({ snapshot, requestId });
      const approvalUrl = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
      if (!approvalUrl || !order.id) throw apiError('PAYPAL_INVALID_RESPONSE', 'PayPal did not return an order approval link.', 502);
      db.prepare("UPDATE checkouts SET paypal_order_id=?,approval_url=?,paypal_order_status=?,app_status='approval_pending',updated_at=? WHERE id=?")
        .run(order.id, approvalUrl, order.status || 'CREATED', now(), id);
      audit('checkout', id, 'paypal', 'order_created', { orderId: order.id, status: order.status || 'CREATED' });
      return send(res, 201, checkoutCreateResponse(db.prepare('SELECT * FROM checkouts WHERE id=?').get(id)));
    } catch (error) {
      db.prepare("UPDATE checkouts SET app_status='failed',updated_at=? WHERE id=? AND paypal_order_id IS NULL").run(now(), id);
      audit('checkout', id, 'paypal', 'order_create_failed', { code: error.code || 'PAYPAL_ERROR' });
      throw error;
    }
  }
  const checkoutRoute = pathname.match(/^\/api\/checkouts\/([A-Za-z0-9-]+)(?:\/(capture))?$/);
  if (checkoutRoute && method === 'GET' && !checkoutRoute[2]) {
    const row = db.prepare('SELECT * FROM checkouts WHERE id=?').get(checkoutRoute[1]);
    if (!row) throw apiError('NOT_FOUND', 'Checkout not found.', 404);
    if (!row.paypal_order_id) throw apiError('PAYPAL_UNAVAILABLE', 'No PayPal order exists for this checkout.', 503);
    const order = await paypal.getOrder(row.paypal_order_id);
    verifyOrder(order, parseJson(row.snapshot_json, {}));
    return send(res, 200, checkoutsResponse(row, order));
  }
  if (checkoutRoute && method === 'POST' && checkoutRoute[2] === 'capture') {
    const row = db.prepare('SELECT * FROM checkouts WHERE id=?').get(checkoutRoute[1]);
    if (!row || !row.paypal_order_id) throw apiError('NOT_FOUND', 'Checkout order not found.', 404);
    const snapshot = parseJson(row.snapshot_json, {});
    const order = await paypal.getOrder(row.paypal_order_id);
    verifyOrder(order, snapshot);
    if (order.status === 'COMPLETED') {
      const completed = checkoutsResponse(row, order);
      return send(res, completed.verifiedPaid ? 200 : 409, completed);
    }
    if (order.status !== 'APPROVED') throw apiError('PAYPAL_NOT_APPROVED', 'PayPal has not approved this order.', 409);
    const captureRequestId = row.capture_request_id || randomBytes(16).toString('hex');
    db.prepare("UPDATE checkouts SET app_status='capture_pending',capture_request_id=?,updated_at=? WHERE id=?").run(captureRequestId, now(), row.id);
    audit('checkout', row.id, 'system', 'capture_started', { orderId: row.paypal_order_id });
    try {
      await paypal.captureOrder(row.paypal_order_id, captureRequestId);
    } catch (error) {
      const afterError = await paypal.getOrder(row.paypal_order_id).catch(() => null);
      if (!afterError) throw error;
      verifyOrder(afterError, snapshot);
      const capture = latestCapture(afterError);
      if (afterError.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') throw error;
    }
    const finalOrder = await paypal.getOrder(row.paypal_order_id);
    verifyOrder(finalOrder, snapshot);
    const result = checkoutsResponse(db.prepare('SELECT * FROM checkouts WHERE id=?').get(row.id), finalOrder);
    if (!result.verifiedPaid) {
      const capture = latestCapture(finalOrder);
      const failed = capture?.status === 'DECLINED' || capture?.status === 'FAILED';
      const mismatch = finalOrder.status === 'COMPLETED' && !result.verifiedPaid;
      const status = mismatch ? 'mismatch' : failed ? 'failed' : 'capture_pending';
      db.prepare('UPDATE checkouts SET app_status=?,paypal_capture_status=?,paypal_capture_id=?,updated_at=? WHERE id=?')
        .run(status, capture?.status || null, capture?.id || null, now(), row.id);
      audit('checkout', row.id, 'paypal', mismatch ? 'capture_mismatch' : failed ? 'capture_failed' : 'capture_not_completed',
        { captureStatus: capture?.status || null, captureId: capture?.id || null });
      return send(res, mismatch ? 409 : failed ? 402 : 202, { ...result, status, verifiedPaid: false });
    }
    audit('checkout', row.id, 'paypal', 'capture_verified', { captureId: result.paypalCaptureId, status: result.captureStatus });
    return send(res, 200, result);
  }
  if (method === 'GET' && pathname === '/api/audit') {
    const entityType = url.searchParams.get('entityType');
    const entityId = url.searchParams.get('entityId');
    if (!entityType || !entityId) throw apiError('INVALID_FILTER', 'entityType and entityId are required.', 400);
    const queryTestEvents = entityType === 'query_test';
    const statement = queryTestEvents
      ? `SELECT * FROM audit_events
          WHERE (entity_type=? AND entity_id=?)
             OR (entity_type='test_run' AND entity_id IN (SELECT id FROM test_runs WHERE query_test_id=?))
             OR (entity_type='correction' AND entity_id IN (SELECT id FROM corrections WHERE query_test_id=?))
          ORDER BY created_at, id`
      : 'SELECT * FROM audit_events WHERE entity_type=? AND entity_id=? ORDER BY created_at, id';
    const rows = queryTestEvents
      ? db.prepare(statement).all(entityType, entityId, entityId, entityId)
      : db.prepare(statement).all(entityType, entityId);
    const events = rows.map((row) => ({ id: row.id, entityType: row.entity_type, entityId: row.entity_id, actor: row.actor,
      eventType: row.event_type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
    return send(res, 200, { events });
  }
  throw apiError('NOT_FOUND', 'API route not found.', 404);
}
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json; charset=utf-8' };
function staticFile(req, res, pathname) {
  const route = pathname === '/' || pathname === '/checkout/return' || pathname === '/checkout/cancel'
    ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const file = path.resolve(UI_ROOT, route);
  if (!file.startsWith(`${UI_ROOT}${path.sep}`)) return false;
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': body.length,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api-m.sandbox.paypal.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://www.sandbox.paypal.com" });
    res.end(body); return true;
  } catch { return false; }
}
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', routeBase(req));
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (!staticFile(req, res, url.pathname)) send(res, 404, { error: { code: 'NOT_FOUND', message: 'Page not found.' } });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(JSON.stringify({ event: 'request_error', code: error.code || 'INTERNAL_ERROR', status }));
      if (!res.headersSent) send(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 && !error.code ? 'Something went wrong.' : error.message,
        ...(error.details === undefined ? {} : { details: error.details }) } });
      else res.destroy();
    }
  });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => console.log(`CatalogProof listening on ${PORT}`));
}
