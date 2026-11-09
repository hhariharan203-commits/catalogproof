(() => {
  'use strict';

  const state = {
    csrfToken: '',
    authenticated: false,
    health: null,
    catalog: null,
    items: [],
    test: null,
    beforeRun: null,
    beforeItemSnapshot: null,
    correction: null,
    afterRun: null,
    afterItemSnapshot: null,
    checkout: null,
    auditEvents: [],
    selectedSku: ''
  };

  const $ = (id) => document.getElementById(id);
  const loginScreen = $('loginScreen');
  const appShell = $('appShell');
  const skipLink = $('skipLink');
  const globalNotice = $('globalNotice');
  let toastTimer;

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message || code || `Request failed (${status})`);
      this.status = status;
      this.code = code || '';
      this.details = details;
    }
  }

  function setMessage(node, text, tone = '') {
    if (!node) return;
    node.textContent = text || '';
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  }

  function showNotice(text, tone = 'warning') {
    globalNotice.textContent = text;
    globalNotice.dataset.tone = tone;
    globalNotice.hidden = false;
  }

  function hideNotice() {
    globalNotice.hidden = true;
    globalNotice.textContent = '';
    delete globalNotice.dataset.tone;
  }

  function toast(text, tone = '') {
    const node = $('toast');
    node.textContent = text;
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  function humanError(err) {
    if (err?.code === 'AI_UNAVAILABLE') return 'Live AI is not configured. No result was generated or substituted.';
    if (err?.code === 'PAYPAL_UNAVAILABLE') return 'PayPal Sandbox is not configured. No checkout was created.';
    if (err?.code === 'UNAUTHENTICATED' || err?.status === 401) return 'Your demo session has expired. Sign in again to continue.';
    if (err?.code === 'CSRF_INVALID' || err?.status === 403) return 'This request was blocked by the demo security check. Refresh the page and try again.';
    return err?.message || 'The request could not be completed.';
  }

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method) && options.authenticatedMutation !== false;
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (mutating && state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken);

    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store'
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) {
      const error = payload?.error || {};
      const result = new ApiError(response.status, error.code, error.message, error.details);
      if (response.status === 401 && !path.includes('/api/auth/login')) await showLogin(true);
      throw result;
    }
    return payload;
  }

  function showLogin(expired = false) {
    state.authenticated = false;
    state.csrfToken = '';
    loginScreen.hidden = false;
    appShell.hidden = true;
    skipLink.href = '#password';
    skipLink.textContent = 'Skip to password';
    if (expired) setMessage($('loginMessage'), 'Your session expired. Sign in again.', 'error');
    if (expired) requestAnimationFrame(() => $('password').focus({ preventScroll: true }));
  }

  function showApp() {
    state.authenticated = true;
    loginScreen.hidden = true;
    appShell.hidden = false;
    skipLink.href = '#main';
    skipLink.textContent = 'Skip to workflow';
    hideNotice();
    requestAnimationFrame(() => $('main').focus({ preventScroll: true }));
  }

  async function checkSession() {
    try {
      const data = await api('/api/auth/session', { authenticatedMutation: false });
      if (!data.authenticated) return showLogin(false);
      state.csrfToken = typeof data.csrfToken === 'string' ? data.csrfToken : '';
      showApp();
      await loadWorkspace();
      await restoreWorkflow();
    } catch (err) {
      showLogin(false);
      setMessage($('loginMessage'), `Could not reach the app. ${humanError(err)}`, 'error');
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const input = $('password');
    const password = input.value;
    if (!password) return setMessage($('loginMessage'), 'Enter the demo password.', 'error');
    const button = $('loginForm').querySelector('button[type="submit"]');
    setBusy(button, true, 'Signing in…');
    setMessage($('loginMessage'), '');
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { password },
        authenticatedMutation: false
      });
      input.value = '';
      if (!data.authenticated || typeof data.csrfToken !== 'string' || !data.csrfToken) {
        throw new Error('The server did not establish an authenticated demo session.');
      }
      state.csrfToken = data.csrfToken;
      showApp();
      await loadWorkspace();
      await restoreWorkflow();
    } catch (err) {
      input.value = '';
      const text = err.status === 401 ? 'That password did not work.' : humanError(err);
      setMessage($('loginMessage'), text, 'error');
      input.focus();
    } finally {
      setBusy(button, false, 'Enter workspace ↗');
    }
  }

  async function logout() {
    const button = $('logoutButton');
    setBusy(button, true, 'Signing out…');
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      safeSessionRemove('cp_checkout_id');
      safeSessionRemove('cp_test_id');
      state.csrfToken = '';
      state.authenticated = false;
      showLogin(false);
    } catch (err) {
      toast(humanError(err), 'error');
    } finally {
      setBusy(button, false, 'Sign out');
    }
  }

  async function resetDemo() {
    const confirmed = window.confirm('Reset the shared demo workspace? This restores the team-authored synthetic two-variant fixture and clears demo event history. Uploaded data in this demo workspace will be removed.');
    if (!confirmed) return;
    setBusy($('resetButton'), true, 'Resetting…');
    try {
      const data = await api('/api/demo/reset', { method: 'POST', body: {} });
      if (!data.reset) throw new Error('The server did not confirm the reset.');
      clearWorkflow();
      safeSessionRemove('cp_checkout_id');
      safeSessionRemove('cp_test_id');
      await loadWorkspace();
      toast('Demo reset completed.', 'success');
    } catch (err) {
      toast(humanError(err), 'error');
    } finally {
      setBusy($('resetButton'), false, 'Reset demo');
    }
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      button.textContent = label || button.dataset.originalLabel || button.textContent;
      delete button.dataset.originalLabel;
    }
  }

  function currencyDigits(currency) {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
    catch (_) { return 2; }
  }

  function money(minor, currency) {
    const amount = Number(minor);
    if (!Number.isInteger(amount) || !currency) return 'Price unavailable';
    const digits = currencyDigits(currency);
    const value = amount / (10 ** digits);
    try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value); }
    catch (_) { return `${currency} ${value.toFixed(digits)}`; }
  }

  const val = (object, key) => object?.[key];
  const itemSku = (item) => val(item, 'sku') || '';
  const itemTitle = (item) => val(item, 'title') || 'Untitled product';
  const itemAttrs = (item) => val(item, 'variantAttributes') || {};
  const itemAmount = (item) => val(item, 'unitAmountMinor');
  const itemCurrency = (item) => val(item, 'currency') || '';
  const itemAvailable = (item) => val(item, 'available');
  const itemImage = (item) => val(item, 'imageUrl') || '';
  const testId = (test) => test?.id || test?.testId || test?.test_id || '';
  const runId = (run) => run?.id || run?.runId || run?.run_id || '';
  const runSku = (run) => run?.selectedSku || run?.selected_sku || '';
  const expectedSku = (test) => test?.expectedSku || test?.expected_sku || '';
  const testQuery = (test) => test?.queryText || test?.query_text || '';
  const correctionId = (correction) => correction?.id || correction?.correctionId || correction?.correction_id || '';
  const correctionStatus = (correction) => correction?.status || '';

  function attributesText(attrs) {
    if (!attrs || typeof attrs !== 'object') return 'Variant not specified';
    const pairs = Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined && String(value).trim());
    return pairs.length ? pairs.map(([key, value]) => `${key}: ${String(value)}`).join(' · ') : 'Variant not specified';
  }

  function findItem(sku, items = state.items) {
    return items.find((item) => itemSku(item) === sku) || null;
  }

  function itemOptionLabel(item) {
    return `${itemTitle(item)} — ${attributesText(itemAttrs(item))} — ${itemSku(item)} — ${money(itemAmount(item), itemCurrency(item))}`;
  }

  async function loadWorkspace() {
    try {
      state.health = await api('/api/health', { authenticatedMutation: false });
    } catch (_) {
      state.health = null;
      showNotice('The health check could not be reached. Missing services will not be simulated.', 'error');
    }
    renderHealth();
    await loadCatalog();
  }

  function renderHealth() {
    const badge = $('connectionBadge');
    if (!state.health) {
      badge.textContent = 'Health check unavailable';
      badge.dataset.state = 'error';
      return;
    }
    const ai = Boolean(state.health.aiConfigured);
    const paypal = Boolean(state.health.paypalConfigured);
    const database = state.health.database !== false;
    const detailedStatus = `${ai ? 'AI ready' : 'AI unavailable'} · ${paypal ? 'PayPal Sandbox ready' : 'PayPal unavailable'}`;
    badge.textContent = window.matchMedia('(max-width: 640px)').matches ? 'AI / PayPal' : detailedStatus;
    badge.title = `AI: ${ai ? 'configured' : 'not configured'}; PayPal: ${paypal ? 'configured' : 'not configured'}; database: ${database ? 'available' : 'unavailable'}`;
    badge.dataset.state = ai && paypal && database ? 'ready' : 'warning';
  }

  async function loadCatalog() {
    try {
      state.catalog = await api('/api/catalog');
      state.items = Array.isArray(state.catalog.items) ? state.catalog.items : [];
      renderCatalog();
    } catch (err) {
      state.catalog = null;
      state.items = [];
      renderCatalog();
      if (err.status !== 401) showNotice(`Catalog could not be loaded. ${humanError(err)}`, 'error');
    }
  }

  function currentVersion() {
    const current = state.catalog?.currentVersion;
    if (current && typeof current === 'object') return current;
    return (state.catalog?.versions || []).find((entry) => entry.id === current) || null;
  }

  function syntheticScenario(version) {
    const name = version?.sourceName || '';
    if (name === 'CatalogProof team-authored fictional two-variant fixture') {
      return {
        sku: 'CCS-CANVAS-TOTE-ECRU-01',
        query: 'Find the Ecru Fieldwork Cotton Canvas Tote.',
        note: 'Controlled synthetic discrepancy: the imported variant says Stone; its source record says Ecru.'
      };
    }
    return null;
  }

  function renderCatalog() {
    const summary = $('catalogSummary');
    const version = currentVersion();
    const scenario = syntheticScenario(version);
    summary.replaceChildren();
    if (!state.items.length) {
      const empty = document.createElement('span');
      empty.className = 'summary-empty';
      empty.textContent = 'No catalog loaded';
      summary.append(empty);
      $('variantCount').textContent = '0';
    } else {
      const title = document.createElement('span');
      title.className = 'summary-title';
      title.textContent = version?.sourceName || 'Catalog source';
      const meta = document.createElement('span');
      meta.className = 'summary-meta';
      const id = version?.id || state.catalog.currentVersion || '';
      meta.textContent = `${state.items.length} variant${state.items.length === 1 ? '' : 's'}${id ? ` · version ${String(id).slice(0, 10)}` : ''}`;
      const kind = document.createElement('span');
      kind.className = 'summary-meta summary-type';
      kind.dataset.kind = version?.isSynthetic ? 'synthetic' : 'source';
      kind.textContent = version?.isSynthetic ? 'SYNTHETIC TEST DATA' : 'SOURCE CATALOG';
      summary.append(title, meta, kind);
      $('variantCount').textContent = String(state.items.length);
    }
    const fixtureNote = $('syntheticFixtureNote');
    fixtureNote.hidden = !(version?.isSynthetic && scenario);
    fixtureNote.textContent = fixtureNote.hidden ? '' : scenario.note;
    $('productSearch').disabled = !state.items.length;
    $('queryText').disabled = !state.items.length;
    $('expectedSku').disabled = !state.items.length;
    $('freezeTestButton').disabled = !state.items.length;
    renderProductList();
    if (!findItem(state.selectedSku)) {
      state.selectedSku = '';
      $('expectedSku').value = '';
    }
    if (scenario && !testId(state.test) && !$('queryText').value.trim() && !$('expectedSku').value.trim()) {
      const seededExpected = state.items.find((item) => itemSku(item) === scenario.sku);
      if (seededExpected) {
        state.selectedSku = itemSku(seededExpected);
        $('expectedSku').value = state.selectedSku;
        $('queryText').value = scenario.query;
        renderProductList();
      }
    }
  }

  function renderProductList() {
    const host = $('productList');
    const query = $('productSearch').value.trim().toLowerCase();
    host.replaceChildren();
    if (!state.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'Import a permitted catalog to inspect its variants.';
      host.append(empty);
      return;
    }
    const matches = state.items.filter((item) => `${itemTitle(item)} ${itemSku(item)} ${attributesText(itemAttrs(item))}`.toLowerCase().includes(query));
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No variants match that search.';
      host.append(empty);
      return;
    }
    const limit = 60;
    matches.slice(0, limit).forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-row';
      button.setAttribute('aria-pressed', itemSku(item) === state.selectedSku ? 'true' : 'false');
      button.addEventListener('click', () => {
        state.selectedSku = itemSku(item);
        $('expectedSku').value = state.selectedSku;
        renderProductList();
      });
      const title = document.createElement('strong');
      title.textContent = itemTitle(item);
      const meta = document.createElement('span');
      const availability = itemAvailable(item) === false ? ' · UNAVAILABLE IN SNAPSHOT' : '';
      meta.textContent = `${attributesText(itemAttrs(item))} · ${itemSku(item)}${availability}`;
      button.append(title, meta);
      host.append(button);
    });
    if (matches.length > limit) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = `Showing ${limit} of ${matches.length} matches. Refine the search to find a variant.`;
      host.append(note);
    }
  }

  function toMinorUnits(value, currency) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('A product price is missing or invalid.');
    const scale = 10 ** currencyDigits(currency || 'USD');
    const minor = Math.round((number + Number.EPSILON) * scale);
    if (!Number.isSafeInteger(minor)) throw new Error('A product price is outside the supported range.');
    return minor;
  }

  function normalizeCatalogData(data) {
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.products) ? data.products : (Array.isArray(data?.items) ? data.items : null));
    if (!rows) throw new Error('The JSON must contain a product array or an items array.');
    const items = [];
    for (const product of rows) {
      if (Array.isArray(product?.variants)) {
        for (const variant of product.variants) {
          const sku = variant.sku ?? variant.SKU;
          const variantMoney = variant.price && typeof variant.price === 'object' ? variant.price : null;
          const productMoney = product.price && typeof product.price === 'object' ? product.price : null;
          const currency = variant.currency || variantMoney?.currencyCode || productMoney?.currencyCode || productMoney?.currency || 'USD';
          const rawPrice = Number.isInteger(variant.unitAmountMinor) ? null
            : (variant.price_usd ?? variantMoney?.amount ?? variant.price ?? productMoney?.min_usd ?? productMoney?.amount ?? product.price);
          const amount = Number.isInteger(variant.unitAmountMinor) ? variant.unitAmountMinor : toMinorUnits(rawPrice, currency);
          const available = variant.available ?? variant.in_stock ?? variant.available_for_sale ?? variant.availableForSale ?? false;
          if (typeof available !== 'boolean') throw new Error('Availability must be a true/false value for every variant.');
          const selectedOptions = Array.isArray(variant.selectedOptions)
            ? Object.fromEntries(variant.selectedOptions.filter((option) => typeof option?.name === 'string').map((option) => [option.name, option.value]))
            : {};
          items.push({
            productId: String(product.id ?? product.productId ?? product.product_id ?? ''),
            sku: String(sku ?? ''),
            title: String(product.title ?? ''),
            description: String(product.description ?? ''),
            brand: String(product.brand ?? product.vendor ?? ''),
            variantAttributes: variant.variantAttributes ?? variant.options ?? selectedOptions,
            unitAmountMinor: amount,
            currency,
            available,
            productUrl: String(product.url ?? product.productUrl ?? ''),
            imageUrl: String(product.featured_image_url ?? product.imageUrl ?? product.image_url ?? product.images?.[0]?.url ?? ''),
            sourceRecord: { product, variant }
          });
        }
      } else {
        const currency = product.currency || 'USD';
        const amount = Number.isInteger(product.unitAmountMinor) ? product.unitAmountMinor : toMinorUnits(product.price ?? product.price_usd, currency);
        const available = product.available ?? product.in_stock ?? false;
        if (typeof available !== 'boolean') throw new Error('Availability must be a true/false value for every variant.');
        items.push({
          productId: String(product.productId ?? product.product_id ?? product.id ?? ''),
          sku: String(product.sku ?? product.SKU ?? ''),
          title: String(product.title ?? ''),
          description: String(product.description ?? ''),
          brand: String(product.brand ?? ''),
          variantAttributes: product.variantAttributes ?? product.variant_attributes ?? product.options ?? {},
          unitAmountMinor: amount,
          currency,
          available,
          productUrl: String(product.productUrl ?? product.product_url ?? product.url ?? ''),
          imageUrl: String(product.imageUrl ?? product.image_url ?? ''),
          sourceRecord: product.sourceRecord ?? product.source_record ?? product
        });
      }
    }
    if (!items.length) throw new Error('The file did not contain purchasable variants.');
    if (items.some((item) => !item.sku || !item.title || !Number.isInteger(item.unitAmountMinor) || !/^[A-Z]{3}$/.test(item.currency))) {
      throw new Error('Every variant needs a title, SKU, three-letter currency, and integer minor-unit price.');
    }
    const estimatedBytes = new TextEncoder().encode(JSON.stringify(items)).byteLength;
    if (estimatedBytes > 400 * 1024) throw new Error('The normalized import is too large for the public demo. Choose a smaller, test-sized catalog extract under 400 KB.');
    return items;
  }

  async function handleImport(event) {
    event.preventDefault();
    const file = $('catalogFile').files?.[0];
    if (!file) return setMessage($('importMessage'), 'Choose a JSON catalog first.', 'error');
    if (!$('catalogConsent').checked) return setMessage($('importMessage'), 'Confirm you have permission to use this catalog.', 'error');
    if (file.size > 5 * 1024 * 1024) return setMessage($('importMessage'), 'This file is too large to inspect safely in the browser. Use a test-sized JSON extract.', 'error');
    setMessage($('importMessage'), 'Reading the selected file…');
    try {
      const parsed = JSON.parse(await file.text());
      const items = normalizeCatalogData(parsed);
      const payload = {
        sourceName: $('sourceName').value.trim() || file.name,
        sourceUrl: $('sourceUrl').value.trim() || undefined,
        sourceLicense: $('sourceLicense').value.trim() || undefined,
        isSynthetic: $('syntheticData').checked,
        items
      };
      const button = $('importButton');
      setBusy(button, true, `Importing ${items.length} variants…`);
      const result = await api('/api/catalog/import', { method: 'POST', body: payload });
      $('importForm').reset();
      clearWorkflow();
      await loadCatalog();
      $('importDetails').open = true;
      setMessage($('importMessage'), `${result.itemCount ?? items.length} variants imported as a new catalog version.`, 'success');
      toast('Catalog imported. Original source data remains preserved.', 'success');
      hideNotice();
    } catch (err) {
      const text = err instanceof SyntaxError ? 'This file is not valid JSON.' : humanError(err);
      setMessage($('importMessage'), text, 'error');
    } finally {
      setBusy($('importButton'), false, 'Import source');
    }
  }

  async function createAndRunTest(event) {
    event.preventDefault();
    const queryText = $('queryText').value.trim();
    const intendedSku = $('expectedSku').value;
    if (!queryText || !intendedSku) return showNotice('Enter a shopper request and choose the seller’s intended SKU.', 'warning');
    setBusy($('freezeTestButton'), true, 'Freezing test…');
    hideNotice();
    clearWorkflow(false);
    try {
      const created = await api('/api/tests', { method: 'POST', body: { queryText, expectedSku: intendedSku, settings: {} } });
      state.test = created.test || created;
      const id = testId(state.test);
      if (!id) throw new Error('The server did not return a frozen test ID.');
      safeSessionSet('cp_test_id', id);
      lockFrozenInputs(state.test);
      $('testVersionLabel').textContent = `FROZEN · ${id.slice(0, 8)}`;
      setMessage($('replayMessage'), 'Running the first test against the frozen catalog…');
      const runResult = await api(`/api/tests/${encodeURIComponent(id)}/run`, { method: 'POST', body: { phase: 'before' } });
      state.beforeRun = runResult.run;
      state.beforeItemSnapshot = snapshotRunItem(state.beforeRun);
      await loadTest(id);
      await loadAudit();
      renderWorkflow();
      $('beforeSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      renderWorkflow();
      showNotice(`The test did not complete. ${humanError(err)}`, 'error');
    } finally {
      setBusy($('freezeTestButton'), false, 'Freeze & run before test ↗');
    }
  }

  function parseMaybeJSON(value) {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (_) { return value; }
    }
    return value;
  }

  function runDiagnosis(run) { return parseMaybeJSON(run?.diagnosisJson ?? run?.diagnosis_json ?? run?.diagnosis) || {}; }

  async function loadTest(id = testId(state.test)) {
    if (!id) return;
    const data = await api(`/api/tests/${encodeURIComponent(id)}`);
    state.test = data.test || state.test;
    lockFrozenInputs(state.test);
    const runs = Array.isArray(data.runs) ? data.runs : [];
    state.beforeRun = runs.find((run) => run.phase === 'before') || state.beforeRun;
    state.afterRun = runs.find((run) => run.phase === 'after') || state.afterRun;
    const corrections = Array.isArray(data.corrections) ? data.corrections : [];
    state.correction = corrections[corrections.length - 1] || state.correction;
    if (!state.beforeItemSnapshot && sameVersionAsCatalog(state.beforeRun)) state.beforeItemSnapshot = snapshotRunItem(state.beforeRun);
    if (!state.afterItemSnapshot && sameVersionAsCatalog(state.afterRun)) state.afterItemSnapshot = snapshotRunItem(state.afterRun);
  }

  async function loadAudit() {
    const id = testId(state.test);
    if (!id) return;
    try {
      const params = new URLSearchParams({ entityType: 'query_test', entityId: id });
      const data = await api(`/api/audit?${params.toString()}`);
      state.auditEvents = Array.isArray(data.events) ? data.events : [];
      await loadCheckoutAudit();
    } catch (_) {
      state.auditEvents = [];
    }
    renderAudit();
  }

  async function loadCheckoutAudit() {
    if (!state.checkout?.checkoutId) return;
    try {
      const params = new URLSearchParams({ entityType: 'checkout', entityId: state.checkout.checkoutId });
      const data = await api(`/api/audit?${params.toString()}`);
      const events = Array.isArray(data.events) ? data.events : [];
      const seen = new Set(state.auditEvents.map((event) => event.id));
      state.auditEvents.push(...events.filter((event) => !seen.has(event.id)));
    } catch (_) { /* Checkout may not yet have audit records. */ }
  }

  function runCatalogVersionId(run) { return run?.catalogVersionId || run?.catalog_version_id || ''; }

  function sameVersionAsCatalog(run) {
    if (!run) return false;
    const current = state.catalog?.currentVersion;
    const currentId = (typeof current === 'object' ? current?.id : current) || '';
    const runId = runCatalogVersionId(run);
    return !runId || !currentId || runId === currentId;
  }

  function snapshotRunItem(run) {
    const item = findItem(runSku(run));
    return item ? {
      sku: itemSku(item),
      title: itemTitle(item),
      variantAttributes: itemAttrs(item),
      unitAmountMinor: itemAmount(item),
      currency: itemCurrency(item),
      available: itemAvailable(item)
    } : null;
  }

  function itemForRun(run, phase) {
    if (!run) return null;
    const snapshot = phase === 'before' ? state.beforeItemSnapshot : state.afterItemSnapshot;
    if (snapshot?.sku === runSku(run)) return snapshot;
    return sameVersionAsCatalog(run) ? findItem(runSku(run)) : null;
  }

  function outcomeLabel(run) {
    const outcome = run?.outcome || runDiagnosis(run).outcome || 'unknown';
    const map = {
      supported_match: ['SUPPORTED MATCH', 'success'],
      conflicting_evidence: ['CONFLICTING EVIDENCE', 'error'],
      insufficient_evidence: ['INSUFFICIENT EVIDENCE', 'warning'],
      ambiguous: ['AMBIGUOUS', 'warning'],
      ai_unavailable: ['AI UNAVAILABLE', 'error']
    };
    return map[outcome] || [String(outcome).replaceAll('_', ' ').toUpperCase(), 'warning'];
  }

  function renderBefore() {
    const run = state.beforeRun;
    $('beforeSection').hidden = !run;
    if (!run) return;
    const item = itemForRun(run, 'before');
    $('frozenQueryText').textContent = testQuery(state.test) || 'Frozen query unavailable';
    $('frozenExpectedSku').textContent = expectedSku(state.test) || 'Expected SKU unavailable';
    $('beforeProduct').textContent = item ? itemTitle(item) : 'No selected SKU in the current view';
    $('beforeVariant').textContent = item ? attributesText(itemAttrs(item)) : 'The server selected no available catalog item.';
    $('beforeSku').textContent = runSku(run) || 'No SKU selected';
    const [label, tone] = outcomeLabel(run);
    setPill($('beforeOutcome'), label, tone);

    const diagnosis = runDiagnosis(run);
    const issues = Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
    const list = $('issueList');
    list.replaceChildren();
    if (!issues.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = diagnosis.uncertaintyReason || 'No cited catalog issue was returned for this run.';
      list.append(p);
    } else {
      issues.forEach((issue) => list.append(renderIssue(issue)));
    }
    $('diagnosisBlock').hidden = false;
    $('uncertaintyNote').hidden = !diagnosis.uncertaintyReason;
    $('uncertaintyNote').textContent = diagnosis.uncertaintyReason ? `Uncertainty: ${diagnosis.uncertaintyReason}` : '';
    renderCorrection(diagnosis.correctionDraft);
  }

  function setPill(node, label, tone) {
    node.textContent = label || 'UNKNOWN';
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  }

  function renderIssue(issue) {
    const wrapper = document.createElement('article');
    wrapper.className = 'issue-item';
    const title = document.createElement('h4');
    title.textContent = issue.fieldPath || issue.type || 'Catalog evidence issue';
    const meta = document.createElement('div');
    meta.className = 'issue-meta';
    const actual = document.createElement('div');
    actual.append(makeLabel('CATALOG VALUE'), makeStrong(formatValue(issue.actualValue)));
    const expected = document.createElement('div');
    expected.append(makeLabel('EXPECTED / MISSING'), makeStrong(formatValue(issue.expectedOrMissingValue)));
    meta.append(actual, expected);
    wrapper.append(title, meta);
    for (const entry of Array.isArray(issue.evidence) ? issue.evidence : []) {
      const citation = document.createElement('div');
      citation.className = 'issue-evidence';
      citation.textContent = `${entry.sku || 'Source record'} · ${entry.fieldPath || 'field'}: ${formatValue(entry.value)}${entry.recordId ? ` · record ${entry.recordId}` : ''}`;
      wrapper.append(citation);
    }
    if (issue.explanation) {
      const explanation = document.createElement('p');
      explanation.className = 'issue-explanation';
      explanation.textContent = issue.explanation;
      wrapper.append(explanation);
    }
    return wrapper;
  }

  function makeLabel(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  function makeStrong(text) {
    const strong = document.createElement('strong');
    strong.textContent = text;
    return strong;
  }

  function formatValue(value) {
    if (value === undefined || value === null || value === '') return 'Not provided';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function getItemField(item, path) {
    if (!item || !path) return undefined;
    const parts = String(path).replace(/^\$\.?/, '').split('.');
    let current = item;
    for (const part of parts) {
      if (current == null) return undefined;
      if (Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
      else if (Object.prototype.hasOwnProperty.call(itemAttrs(item), part)) current = itemAttrs(item)[part];
      else if (part === 'sku') current = itemSku(item);
      else if (part === 'title') current = itemTitle(item);
      else return undefined;
    }
    return current;
  }

  function renderCorrection(draft) {
    const section = $('correctionSection');
    const correction = state.correction;
    if (!draft && !correction) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const status = correction?.status || '';
    const approved = status === 'approved';
    const rejected = status === 'rejected';
    const pending = status === 'pending';

    if (correction) {
      $('originalValue').textContent = formatValue(parseMaybeJSON(correction.originalValue ?? correction.originalValueJson ?? correction.original_value_json));
      $('proposedValue').textContent = formatValue(parseMaybeJSON(correction.proposedValue ?? correction.proposedValueJson ?? correction.proposed_value_json));
      $('correctionExplanation').textContent = correction.explanation || '';
      const evidence = parseMaybeJSON(correction.evidence ?? correction.evidenceJson ?? correction.evidence_json);
      renderEvidence(evidence);
      $('correctionStatus').textContent = approved ? 'APPROVED' : rejected ? 'REJECTED' : 'PENDING REVIEW';
      $('correctionStatus').dataset.tone = approved ? 'success' : rejected ? 'error' : 'warning';
      $('correctionActions').hidden = !pending;
      $('approveCorrectionButton').hidden = false;
      $('approveCorrectionButton').textContent = 'Approve correction';
      $('rejectCorrectionButton').hidden = false;
      $('approveCorrectionButton').onclick = () => decideCorrection('approve');
      $('rejectCorrectionButton').onclick = () => decideCorrection('reject');
      setMessage($('decisionMessage'), approved ? 'Seller approval is recorded. The original catalog version remains preserved.' : rejected ? 'The suggestion was rejected. The catalog was not changed.' : 'Review the cited source before making a decision.');
      return;
    }

    const sourceItem = findItem(draft.sku);
    $('originalValue').textContent = formatValue(getItemField(sourceItem, draft.fieldPath));
    $('proposedValue').textContent = formatValue(draft.proposedValue);
    $('correctionExplanation').textContent = draft.explanation || 'Review the cited evidence before deciding whether to submit this correction.';
    renderEvidence(draft.evidence);
    $('correctionStatus').textContent = 'AI SUGGESTION';
    $('correctionStatus').dataset.tone = 'warning';
    $('correctionActions').hidden = false;
    $('rejectCorrectionButton').hidden = true;
    $('approveCorrectionButton').hidden = false;
    $('approveCorrectionButton').textContent = 'Submit for seller approval';
    $('approveCorrectionButton').onclick = () => submitCorrection(draft);
    setMessage($('decisionMessage'), 'No catalog data has changed. Submit the cited suggestion for an explicit seller decision.');
  }

  function renderEvidence(evidence) {
    const host = $('correctionEvidence');
    host.replaceChildren();
    const citation = Array.isArray(evidence) ? evidence[0] : evidence;
    if (!citation || typeof citation !== 'object') {
      const heading = document.createElement('strong');
      heading.textContent = 'SOURCE EVIDENCE';
      const text = document.createElement('span');
      text.textContent = 'No source citation was returned. This correction cannot be approved as evidence-backed.';
      host.append(heading, text);
      $('approveCorrectionButton').disabled = true;
      return;
    }
    $('approveCorrectionButton').disabled = false;
    const heading = document.createElement('strong');
    heading.textContent = `${citation.sourceType || citation.source_type || 'CATALOG SOURCE'}${citation.recordId || citation.record_id ? ` · RECORD ${citation.recordId || citation.record_id}` : ''}`;
    const text = document.createElement('span');
    text.textContent = citation.exactQuote || citation.exact_quote || `${citation.fieldPath || citation.field_path || 'Field'}: ${formatValue(citation.value)}`;
    host.append(heading, text);
  }

  async function submitCorrection(draft) {
    if (!state.test || !state.beforeRun) return;
    const evidence = Array.isArray(draft.evidence) ? draft.evidence[0] : draft.evidence;
    if (!evidence) return setMessage($('decisionMessage'), 'No exact source citation was provided. No correction was submitted.', 'error');
    const button = $('approveCorrectionButton');
    setBusy(button, true, 'Submitting…');
    try {
      const result = await api('/api/corrections', {
        method: 'POST',
        body: {
          queryTestId: testId(state.test),
          beforeRunId: runId(state.beforeRun),
          sku: draft.sku,
          fieldPath: draft.fieldPath,
          proposedValue: draft.proposedValue,
          evidence: {
            sourceType: evidence.sourceType || evidence.source_type || 'catalog_field',
            sourceReference: evidence.sourceReference || evidence.source_reference || '',
            exactQuote: evidence.exactQuote || evidence.exact_quote || `${evidence.fieldPath || evidence.field_path || ''}: ${formatValue(evidence.value)}`,
            recordId: evidence.recordId || evidence.record_id || undefined
          },
          explanation: draft.explanation || ''
        }
      });
      state.correction = result.correction || result;
      await loadTest();
      await loadAudit();
      renderWorkflow();
      toast('Suggestion submitted. Seller review is still required.', 'success');
    } catch (err) {
      setMessage($('decisionMessage'), humanError(err), 'error');
    } finally {
      setBusy(button, false, state.correction ? 'Approve correction' : 'Submit for seller approval');
    }
  }

  async function decideCorrection(decision) {
    const id = correctionId(state.correction);
    if (!id) return setMessage($('decisionMessage'), 'No pending correction ID was returned by the server.', 'error');
    const button = decision === 'approve' ? $('approveCorrectionButton') : $('rejectCorrectionButton');
    setBusy(button, true, decision === 'approve' ? 'Approving…' : 'Rejecting…');
    try {
      const result = await api(`/api/corrections/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision } });
      state.correction = result.correction || state.correction;
      await loadCatalog();
      await loadTest();
      await loadAudit();
      renderWorkflow();
      toast(decision === 'approve' ? 'Approval recorded; the new catalog version can now be retested.' : 'Suggestion rejected; catalog unchanged.', decision === 'approve' ? 'success' : '');
    } catch (err) {
      setMessage($('decisionMessage'), humanError(err), 'error');
    } finally {
      setBusy(button, false, decision === 'approve' ? 'Approve correction' : 'Reject suggestion');
    }
  }

  async function replayTest() {
    const id = testId(state.test);
    if (!id || correctionStatus(state.correction) !== 'approved') return setMessage($('replayMessage'), 'Approve a supported correction before running the after test.', 'error');
    setBusy($('replayButton'), true, 'Replaying…');
    setMessage($('replayMessage'), 'Replaying the frozen query against the approved catalog version…');
    try {
      const result = await api(`/api/tests/${encodeURIComponent(id)}/run`, { method: 'POST', body: { phase: 'after' } });
      state.afterRun = result.run;
      await loadTest(id);
      await loadAudit();
      renderWorkflow();
      $('afterSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setMessage($('replayMessage'), 'Replay finished. Compare the selected SKU with the frozen expected SKU.', 'success');
    } catch (err) {
      setMessage($('replayMessage'), humanError(err), 'error');
    } finally {
      setBusy($('replayButton'), false, 'Replay the same test');
    }
  }

  function renderComparison() {
    const hasBefore = Boolean(state.beforeRun);
    const approved = correctionStatus(state.correction) === 'approved';
    $('afterSection').hidden = !hasBefore || !approved;
    $('checkoutSection').hidden = !state.afterRun || !approved;
    if (!hasBefore) return;
    const intended = expectedSku(state.test);
    const beforeSku = runSku(state.beforeRun);
    const beforeMatch = beforeSku && beforeSku === intended;
    $('compareBeforeSku').textContent = beforeSku || 'No SKU selected';
    const beforeItem = itemForRun(state.beforeRun, 'before');
    $('compareBeforeTitle').textContent = beforeItem ? itemTitle(beforeItem) : 'Details from the original catalog version are not loaded.';
    $('beforeMatch').textContent = beforeMatch ? 'MATCHED EXPECTED SKU' : 'DIFFERS FROM EXPECTED SKU';
    if (state.afterRun) {
      const afterSku = runSku(state.afterRun);
      const afterMatch = afterSku && afterSku === intended;
      $('compareAfterSku').textContent = afterSku || 'No SKU selected';
      const afterItem = itemForRun(state.afterRun, 'after');
      $('compareAfterTitle').textContent = afterItem ? itemTitle(afterItem) : 'Details from the corrected catalog version are not loaded.';
      $('afterMatch').textContent = afterMatch ? 'MATCHED EXPECTED SKU' : 'DIFFERS FROM EXPECTED SKU';
      $('afterMatch').style.color = afterMatch ? 'var(--verified)' : 'var(--signal)';
      const item = afterItem;
      const available = item?.available === true || item?.available === 1;
      const unavailable = item && (item.available === false || item.available === 0 || item.available === 'false');
      $('createCheckoutButton').disabled = !afterMatch || !available || Boolean(state.checkout);
      $('quantity').disabled = Boolean(state.checkout);
      if (unavailable) {
        $('paymentResult').textContent = 'The approved catalog snapshot marks this variant unavailable. No checkout will be created.';
        $('createCheckoutButton').disabled = true;
      } else if (!available) {
        $('paymentResult').textContent = 'Availability is not confirmed in this catalog snapshot. No checkout will be created.';
        $('createCheckoutButton').disabled = true;
      }
    } else {
      $('compareAfterSku').textContent = '—';
      $('compareAfterTitle').textContent = 'The replay result will appear here.';
      $('afterMatch').textContent = 'NOT RUN';
      $('afterMatch').style.color = '';
      $('createCheckoutButton').disabled = true;
      $('quantity').disabled = false;
    }
  }

  function renderCheckout() {
    const checkout = state.checkout;
    const item = checkout ? checkoutSnapshot(checkout) : itemForRun(state.afterRun, 'after');
    if (!item) return;
    $('buyerProduct').textContent = item.title || itemTitle(item);
    $('buyerVariant').textContent = attributesText(item.variantAttributes || itemAttrs(item));
    $('buyerSku').textContent = item.sku || itemSku(item) || '—';
    const amount = item.unitAmountMinor ?? itemAmount(item);
    const currency = item.currency || itemCurrency(item);
    $('buyerPrice').textContent = money(amount, currency);
    if (checkout) $('quantity').value = String(checkout.quantity || 1);
    $('quantity').disabled = Boolean(checkout);
    $('buyerTotal').textContent = Number.isInteger(Number(item.totalAmountMinor)) ? money(item.totalAmountMinor, currency) : 'Set by server at checkout';
    const create = $('createCheckoutButton');
    const afterItem = itemForRun(state.afterRun, 'after');
    const availabilityConfirmed = afterItem?.available === true || afterItem?.available === 1;
    create.disabled = Boolean(checkout) || !state.afterRun || runSku(state.afterRun) !== expectedSku(state.test) || !availabilityConfirmed;

    $('paypalApprovalLink').hidden = true;
    $('verifyPaymentButton').hidden = true;
    $('refreshPaymentButton').hidden = true;
    $('paymentResult').replaceChildren();
    if (!checkout) {
      setPaymentState('NOT STARTED', '');
      if (state.afterRun && !availabilityConfirmed) {
        $('paymentResult').textContent = afterItem?.available === false || afterItem?.available === 0 || afterItem?.available === 'false'
          ? 'The approved catalog snapshot marks this variant unavailable. No checkout will be created.'
          : 'Availability is not confirmed in this catalog snapshot. No checkout will be created.';
      }
      return;
    }

    const verifiedPaid = checkout.verifiedPaid === true;
    const orderStatus = String(checkout.orderStatus || checkout.status || '').toUpperCase();
    const captureStatus = String(checkout.captureStatus || '').toUpperCase();
    if (verifiedPaid) {
      setPaymentState('PAYMENT VERIFIED', 'success');
      renderReceipt(checkout);
      return;
    }
    if (['CANCELLED', 'CANCELED'].includes(orderStatus)) {
      setPaymentState('CANCELLED', 'failed');
      $('paymentResult').textContent = 'PayPal reports this approval was cancelled. No completed payment is shown.';
      $('refreshPaymentButton').hidden = false;
      return;
    }
    if (['FAILED', 'DENIED', 'MISMATCH', 'VOIDED'].includes(orderStatus) || ['FAILED', 'DENIED'].includes(captureStatus)) {
      setPaymentState('NOT COMPLETED', 'failed');
      $('paymentResult').textContent = 'PayPal has not confirmed a completed payment. This order is not marked paid.';
      $('refreshPaymentButton').hidden = false;
      return;
    }
    const approvalUrl = safePayPalUrl(checkout.approvalUrl);
    if (approvalUrl && orderStatus !== 'APPROVED') {
      const link = $('paypalApprovalLink');
      link.href = approvalUrl;
      link.hidden = false;
      setPaymentState('APPROVAL PENDING', 'pending');
      $('paymentResult').textContent = 'Review this exact item in PayPal Sandbox. Returning to the app does not itself prove approval.';
      return;
    }
    if (orderStatus === 'APPROVED') {
      setPaymentState('APPROVED · CAPTURE PENDING', 'pending');
      $('verifyPaymentButton').hidden = false;
      $('paymentResult').textContent = 'PayPal order readback reports APPROVED. Ask the server to verify and complete capture.';
      return;
    }
    setPaymentState('STATUS NOT VERIFIED', 'pending');
    $('paymentResult').textContent = `PayPal has not confirmed a completed capture${orderStatus ? ` (order: ${orderStatus})` : ''}${captureStatus ? ` (capture: ${captureStatus})` : ''}. Refresh to check again.`;
    $('refreshPaymentButton').hidden = false;
  }

  function setPaymentState(label, tone) {
    const node = $('paymentState');
    node.textContent = label;
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  }

  function safePayPalUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'paypal.com' || host.endsWith('.paypal.com'))) return '';
      return url.toString();
    } catch (_) { return ''; }
  }

  function checkoutSnapshot(checkout) {
    const parsed = parseMaybeJSON(checkout?.snapshot) || {};
    const snapshot = parsed.item || parsed.snapshot || parsed;
    return {
      sku: checkout?.sku || snapshot.sku || '',
      title: checkout?.title || snapshot.title || 'Product details unavailable',
      variantAttributes: checkout?.variantAttributes || snapshot.variantAttributes || snapshot.variant_attributes || {},
      quantity: checkout?.quantity ?? snapshot.quantity ?? 1,
      unitAmountMinor: checkout?.unitAmountMinor ?? snapshot.unitAmountMinor ?? snapshot.unit_amount_minor,
      totalAmountMinor: checkout?.totalAmountMinor ?? snapshot.totalAmountMinor ?? snapshot.total_amount_minor,
      currency: checkout?.currency || snapshot.currency || '',
      available: snapshot.available
    };
  }

  function renderReceipt(checkout) {
    const frozen = checkoutSnapshot(checkout);
    const box = document.createElement('div');
    box.className = 'payment-receipt';
    const add = (label, value) => {
      const div = document.createElement('div');
      const small = document.createElement('span');
      small.className = 'micro-label';
      small.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = value || '—';
      div.append(small, strong);
      box.append(div);
    };
    add('PAYPAL ORDER', checkout.paypalOrderId || '—');
    add('CAPTURE', checkout.paypalCaptureId || '—');
    add('VERIFIED TOTAL', money(frozen.totalAmountMinor, frozen.currency));
    add('VERIFIED STATUS', 'COMPLETED');
    $('paymentResult').append(box);
  }

  async function createCheckout() {
    if (!state.afterRun || runSku(state.afterRun) !== expectedSku(state.test)) {
      return showNotice('Checkout is available only after the frozen test selects the intended SKU.', 'warning');
    }
    const selected = itemForRun(state.afterRun, 'after');
    if (selected?.available !== true && selected?.available !== 1) {
      return showNotice('Checkout is blocked because availability is not confirmed in the approved catalog snapshot.', 'warning');
    }
    const quantity = Number($('quantity').value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return showNotice('Choose a whole-number quantity between 1 and 10.', 'warning');
    setBusy($('createCheckoutButton'), true, 'Preparing order…');
    hideNotice();
    try {
      const response = await api('/api/checkouts', { method: 'POST', body: { afterRunId: runId(state.afterRun), quantity } });
      state.checkout = {
        checkoutId: response.checkoutId,
        sku: response.sku,
        title: response.title,
        variantAttributes: response.variantAttributes,
        quantity: response.quantity,
        unitAmountMinor: response.unitAmountMinor,
        currency: response.currency,
        totalAmountMinor: response.totalAmountMinor,
        approvalUrl: response.approvalUrl,
        paypalOrderId: response.paypalOrderId,
        status: response.status,
        verifiedPaid: false
      };
      if (!state.checkout.checkoutId) throw new Error('The server did not return a checkout ID.');
      safeSessionSet('cp_checkout_id', state.checkout.checkoutId);
      await refreshCheckout(false);
      await loadAudit();
      renderWorkflow();
      if (safePayPalUrl(state.checkout.approvalUrl)) {
        $('paypalApprovalLink').focus({ preventScroll: true });
      }
    } catch (err) {
      showNotice(`No checkout was completed. ${humanError(err)}`, 'error');
    } finally {
      setBusy($('createCheckoutButton'), false, 'Prepare PayPal checkout ↗');
      if (state.checkout) $('createCheckoutButton').disabled = true;
    }
  }

  async function refreshCheckout(showToast = true) {
    const id = state.checkout?.checkoutId;
    if (!id) return;
    setBusy($('refreshPaymentButton'), true, 'Checking PayPal…');
    try {
      const data = await api(`/api/checkouts/${encodeURIComponent(id)}`);
      state.checkout = { ...state.checkout, ...data };
      await loadCheckoutAudit();
      renderCheckout();
      renderAudit();
      if (showToast) toast(data.verifiedPaid ? 'PayPal confirms the completed capture.' : 'Payment is not yet verified as completed.', data.verifiedPaid ? 'success' : '');
    } catch (err) {
      $('paymentResult').textContent = humanError(err);
      setPaymentState('STATUS NOT VERIFIED', 'pending');
    } finally {
      setBusy($('refreshPaymentButton'), false, 'Refresh PayPal status');
      $('refreshPaymentButton').hidden = !state.checkout || state.checkout.verifiedPaid === true;
    }
  }

  async function captureCheckout() {
    const id = state.checkout?.checkoutId;
    if (!id) return;
    setBusy($('verifyPaymentButton'), true, 'Verifying & capturing…');
    try {
      await api(`/api/checkouts/${encodeURIComponent(id)}/capture`, { method: 'POST', body: {} });
      const data = await api(`/api/checkouts/${encodeURIComponent(id)}`);
      state.checkout = { ...state.checkout, ...data };
      await loadAudit();
      renderWorkflow();
      if (data.verifiedPaid === true) toast('PayPal readback confirms the completed capture.', 'success');
      else toast('Capture is not verified as complete yet. The order remains unpaid in this view.', 'error');
    } catch (err) {
      const message = humanError(err);
      $('paymentResult').textContent = `${message} Refresh the PayPal status before retrying.`;
      toast(message, 'error');
    } finally {
      setBusy($('verifyPaymentButton'), false, 'Verify approval & complete capture');
    }
  }

  async function restoreCheckout() {
    const id = safeSessionGet('cp_checkout_id');
    if (!id) return;
    state.checkout = { checkoutId: id, verifiedPaid: false };
    try {
      const data = await api(`/api/checkouts/${encodeURIComponent(id)}`);
      state.checkout = { ...state.checkout, ...data };
      renderWorkflow();
      if (state.test) await loadAudit();
    } catch (err) {
      if (err.status === 404) safeSessionRemove('cp_checkout_id');
      if (err.status !== 401) showNotice(`Saved checkout state could not be restored. ${humanError(err)}`, 'warning');
    }
  }

  async function restoreWorkflow() {
    const savedTestId = safeSessionGet('cp_test_id');
    if (savedTestId) {
      try {
        await loadTest(savedTestId);
        renderWorkflow();
        await loadAudit();
      } catch (_) {
        safeSessionRemove('cp_test_id');
      }
    }
    await restoreCheckout();
  }

  function renderAudit() {
    const host = $('auditList');
    host.replaceChildren();
    if (!state.auditEvents.length) {
      const p = document.createElement('li');
      p.className = 'empty-note';
      p.textContent = 'No audit events are available for this test yet.';
      host.append(p);
      return;
    }
    const events = [...state.auditEvents].sort((a, b) => String(a.createdAt || a.created_at || '').localeCompare(String(b.createdAt || b.created_at || '')));
    events.forEach((event) => {
      const li = document.createElement('li');
      li.className = 'audit-event';
      const time = document.createElement('time');
      time.className = 'audit-time';
      const rawDate = event.createdAt || event.created_at || '';
      const date = rawDate ? new Date(rawDate) : null;
      time.dateTime = date && !Number.isNaN(date.valueOf()) ? date.toISOString() : '';
      time.textContent = date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date) : '—';
      const actor = document.createElement('span');
      actor.className = 'audit-actor';
      actor.textContent = event.actor || 'system';
      const body = document.createElement('div');
      body.className = 'audit-body';
      const title = document.createElement('strong');
      title.textContent = String(event.eventType || event.event_type || 'Event').replaceAll('_', ' ');
      const detail = document.createElement('span');
      const payload = parseMaybeJSON(event.payload ?? event.payloadJson ?? event.payload_json) || {};
      const safeFields = ['sku', 'fieldPath', 'phase', 'status', 'paypalOrderId', 'paypalCaptureId', 'outcome'];
      const pieces = safeFields.filter((key) => payload[key] !== undefined && payload[key] !== null).map((key) => `${key}: ${String(payload[key])}`);
      detail.textContent = pieces.join(' · ') || 'Recorded application event';
      body.append(title, detail);
      li.append(time, actor, body);
      host.append(li);
    });
  }

  function renderWorkflow() {
    renderBefore();
    renderComparison();
    renderCheckout();
    $('auditSection').hidden = !state.test;
    const query = state.test ? testQuery(state.test) : '';
    if (query) $('testVersionLabel').textContent = `FROZEN · ${testId(state.test).slice(0, 8)}`;
    $('newTestButton').hidden = !state.test;
    renderAudit();
  }

  function lockFrozenInputs(test) {
    if (!test) return;
    const query = testQuery(test);
    const sku = expectedSku(test);
    if (query) $('queryText').value = query;
    if (sku) $('expectedSku').value = sku;
    $('queryText').disabled = true;
    $('expectedSku').disabled = true;
    $('freezeTestButton').disabled = true;
    $('newTestButton').hidden = false;
  }

  function startNewTest() {
    clearWorkflow(true);
    $('queryText').disabled = !state.items.length;
    $('expectedSku').disabled = !state.items.length;
    $('freezeTestButton').disabled = !state.items.length;
    $('newTestButton').hidden = true;
    $('queryText').focus({ preventScroll: false });
  }

  function clearWorkflow(clearForm = true) {
    state.test = null;
    state.beforeRun = null;
    state.correction = null;
    state.afterRun = null;
    state.checkout = null;
    state.auditEvents = [];
    state.selectedSku = '';
    $('beforeSection').hidden = true;
    $('correctionSection').hidden = true;
    $('afterSection').hidden = true;
    $('checkoutSection').hidden = true;
    $('auditSection').hidden = true;
    $('diagnosisBlock').hidden = true;
    $('testVersionLabel').textContent = 'NO TEST FROZEN';
    $('newTestButton').hidden = true;
    $('paymentResult').replaceChildren();
    $('paymentState').textContent = 'NOT STARTED';
    $('paymentState').removeAttribute('data-tone');
    safeSessionRemove('cp_checkout_id');
    safeSessionRemove('cp_test_id');
    if (clearForm) {
      $('queryText').value = '';
      $('expectedSku').value = '';
      $('productSearch').value = '';
      $('queryText').disabled = !state.items.length;
      $('expectedSku').disabled = !state.items.length;
      $('freezeTestButton').disabled = !state.items.length;
    }
  }

  function safeSessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; } }
  function safeSessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch (_) { /* Noncritical convenience only. */ } }
  function safeSessionRemove(key) { try { sessionStorage.removeItem(key); } catch (_) { /* Noncritical convenience only. */ } }

  function bindEvents() {
    $('loginForm').addEventListener('submit', handleLogin);
    $('logoutButton').addEventListener('click', logout);
    $('resetButton').addEventListener('click', resetDemo);
    $('importForm').addEventListener('submit', handleImport);
    $('productSearch').addEventListener('input', renderProductList);
    $('queryForm').addEventListener('submit', createAndRunTest);
    $('newTestButton').addEventListener('click', startNewTest);
    $('replayButton').addEventListener('click', replayTest);
    $('createCheckoutButton').addEventListener('click', createCheckout);
    $('verifyPaymentButton').addEventListener('click', captureCheckout);
    $('refreshPaymentButton').addEventListener('click', () => refreshCheckout(true));
    $('refreshAuditButton').addEventListener('click', async () => { await loadAudit(); toast('Audit record refreshed.'); });

    window.addEventListener('pageshow', async () => {
      if (state.authenticated && state.checkout?.checkoutId) await refreshCheckout(false);
    });
  }

  bindEvents();
  checkSession();
})();
