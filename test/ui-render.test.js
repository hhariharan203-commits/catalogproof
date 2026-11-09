import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
}

function harness(fetchImpl = async () => { throw new Error('Unexpected network request'); }) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const startup = '  bindEvents();\n  checkSession();\n})();';
  assert.equal(source.split(startup).length, 2, 'test harness must suppress the one startup block');
  const isolated = source.replace(startup, '  globalThis.testUI = { state, syntheticScenario, renderCorrection, renderAudit, loadTest, submitCorrection };\n})();');
  const context = vm.createContext({
    document: { getElementById: node, createElement: (tag) => new Element(tag) },
    Headers, URLSearchParams, fetch: fetchImpl,
  });
  vm.runInContext(isolated, context, { filename: 'ui/app.js' });
  return { ...context.testUI, node };
}

function ecruItem(color = 'Stone') {
  return {
    id: 'record-abc', sku: 'CCS-CANVAS-TOTE-ECRU-01', title: 'Fieldwork Cotton Canvas Tote',
    variantAttributes: { Color: color },
    sourceRecord: { selectedOptions: [{ name: 'Color', value: 'Ecru' }, { name: 'Size', value: 'Ecru' }] },
  };
}

test('synthetic note derives imported/source values from the current catalog instead of retaining Stone', () => {
  const ui = harness();
  const item = ecruItem();
  ui.state.items = [item];
  const version = { isSynthetic: true, sourceName: 'CatalogProof team-authored fictional two-variant fixture' };
  assert.match(ui.syntheticScenario(version).note, /variantAttributes\.Color: Stone;/);
  assert.match(ui.syntheticScenario(version).note, /sourceRecord\.selectedOptions\.0\.name: Color;/);
  assert.match(ui.syntheticScenario(version).note, /sourceRecord\.selectedOptions\.0\.value: Ecru;/);
  item.variantAttributes.Color = 'Ecru';
  const corrected = ui.syntheticScenario(version).note;
  assert.match(corrected, /variantAttributes\.Color: Ecru;/);
  assert.match(corrected, /values match\./);
  assert.doesNotMatch(corrected, /Stone/);
});

test('approved correction renders the stored field, original/proposed values, source reference, and exact matching source option', () => {
  const ui = harness();
  const item = ecruItem('Ecru');
  ui.state.items = [item];
  ui.state.catalog = { currentVersion: { id: 'frozen-version' } };
  ui.state.correction = {
    sku: item.sku, status: 'approved', fieldPath: 'variantAttributes.Color',
    originalValue: 'Stone', proposedValue: 'Ecru', explanation: 'Stored explanation',
    evidence: { sourceType: 'catalog_record', sourceReference: 'catalog://frozen-version/sku/CCS-CANVAS-TOTE-ECRU-01', exactQuote: 'Ecru', recordId: 'record-abc' },
  };
  ui.renderCorrection();
  assert.equal(ui.node('correctionFieldPath').textContent, 'variantAttributes.Color');
  assert.equal(ui.node('originalValue').textContent, 'Stone');
  assert.equal(ui.node('proposedValue').textContent, 'Ecru');
  const evidence = ui.node('correctionEvidence');
  assert.equal(evidence.children[0].textContent, 'catalog_record · RECORD record-abc');
  assert.equal(evidence.children[1].textContent, 'Ecru');
  assert.equal(evidence.children[2].textContent, 'sourceReference: catalog://frozen-version/sku/CCS-CANVAS-TOTE-ECRU-01');
  assert.equal(evidence.children.length, 3, 'source option data is separate from the stored citation');
  const options = ui.node('correctionSourceOptions');
  assert.equal(options.children[0].textContent, 'CITED RECORD SOURCE OPTIONS');
  assert.equal(options.children[1].textContent, 'catalogVersionId: frozen-version · recordId: record-abc');
  assert.equal(options.children[2].textContent, 'sourceRecord.selectedOptions.0.name: Color · sourceRecord.selectedOptions.0.value: Ecru');
  assert.equal(options.children.length, 3, 'the unrelated same-value Size option must not be associated with the Color correction');
});

test('audit events retain exact event/payload values and group metadata into a single grid column', () => {
  const ui = harness();
  ui.state.auditEvents = [
    { id: 'b', actor: 'seller', eventType: 'approve', createdAt: '2026-11-09T17:00:01Z', payload: { newCatalogVersionId: 'approved-version' } },
    { id: 'a', actor: 'ai', eventType: 'proposed', createdAt: '2026-11-09T17:00:00Z', payload: { fieldPath: 'variantAttributes.Color', originalValue: 'Stone', proposedValue: 'Ecru', sourceType: 'catalog_record' } },
  ];
  ui.renderAudit();
  const events = ui.node('auditList').children;
  assert.equal(events.length, 2);
  assert.equal(events[0].children.length, 2, 'pseudo marker + metadata + body match the three-column grid');
  assert.equal(events[0].children[0].className, 'audit-meta');
  assert.equal(events[0].children[0].children[0].tagName, 'time');
  assert.equal(events[0].children[0].children[1].textContent, 'ai');
  assert.equal(events[0].children[1].children[0].textContent, 'proposed');
  assert.equal(events[0].children[1].children[1].textContent, 'fieldPath: variantAttributes.Color · originalValue: Stone · proposedValue: Ecru · sourceType: catalog_record');
  assert.equal(events[1].children[1].children[0].textContent, 'approve');
});

test('reset warning names deleted local records and says Sandbox orders are not canceled', () => {
  const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const prompt = source.match(/window\.confirm\('([^']*Reset the shared demo workspace\?[^']*)'\)/)?.[1] || '';
  assert.match(prompt, /local query tests and runs/);
  assert.match(prompt, /corrections/);
  assert.match(prompt, /checkout\/payment records/);
  assert.match(prompt, /audit history/);
  assert.match(prompt, /does NOT cancel any PayPal Sandbox order/);
});

test('restoring a test selects the latest before/after runs and never requests checkout', async () => {
  const calls = [];
  const ui = harness(async (path, options) => {
    calls.push({ path, method: options.method });
    assert.equal(path, '/api/tests/test-one');
    return { ok: true, json: async () => ({
      test: { id: 'test-one', queryText: 'Frozen query', expectedSku: 'SKU' },
      runs: [
        { id: 'before-old', phase: 'before' }, { id: 'after-old', phase: 'after' },
        { id: 'before-latest', phase: 'before' }, { id: 'after-latest', phase: 'after' },
      ], corrections: [],
    }) };
  });
  await ui.loadTest('test-one');
  assert.equal(ui.state.beforeRun.id, 'before-latest');
  assert.equal(ui.state.afterRun.id, 'after-latest');
  assert.deepEqual(calls, [{ path: '/api/tests/test-one', method: 'GET' }]);
});

test('later catalog source paths are explicitly current-version data, never historical citation evidence', () => {
  const ui = harness();
  const item = ecruItem('Changed');
  item.id = 'current-record';
  item.sourceRecord.selectedOptions = [{ name: 'Size', value: 'Ecru' }, { name: 'Color', value: 'Changed' }];
  ui.state.items = [item];
  ui.state.catalog = { currentVersion: { id: 'current-version' } };
  ui.state.correction = {
    sku: item.sku, status: 'approved', fieldPath: 'variantAttributes.Color', originalValue: 'Stone', proposedValue: 'Ecru',
    evidence: { sourceType: 'catalog_record', sourceReference: 'catalog://historical-version/sku/CCS-CANVAS-TOTE-ECRU-01', exactQuote: 'Ecru', recordId: 'historical-record' },
  };
  ui.renderCorrection();
  const evidence = ui.node('correctionEvidence').textContent;
  assert.match(evidence, /historical-record/);
  assert.match(evidence, /catalog:\/\/historical-version/);
  assert.doesNotMatch(evidence, /Changed|selectedOptions/);
  const options = ui.node('correctionSourceOptions');
  assert.equal(options.children[0].textContent, 'CURRENT CATALOG SOURCE OPTIONS');
  assert.match(options.children[1].textContent, /not additional citation evidence/);
  assert.equal(options.children[2].textContent, 'catalogVersionId: current-version · recordId: current-record');
  assert.equal(options.children[3].textContent, 'sourceRecord.selectedOptions.1.name: Color · sourceRecord.selectedOptions.1.value: Changed');
  item.id = 'historical-record';
  ui.renderCorrection();
  assert.equal(ui.node('correctionSourceOptions').children[0].textContent, 'CURRENT CATALOG SOURCE OPTIONS', 'a reused record ID does not establish historical version identity');
  assert.match(ui.node('correctionSourceOptions').children[1].textContent, /not additional citation evidence/);
});

test('missing exact quote is explicit, disables approval, and cannot be synthesized or submitted', async () => {
  const ui = harness();
  ui.state.items = [ecruItem()];
  ui.state.test = { id: 'test-one' };
  ui.state.beforeRun = { id: 'before-one' };
  const draft = {
    sku: 'CCS-CANVAS-TOTE-ECRU-01', fieldPath: 'variantAttributes.Color', proposedValue: 'Ecru',
    evidence: { sourceType: 'catalog_record', recordId: 'record-abc', fieldPath: 'sourceRecord.selectedOptions.0.value', value: 'Ecru' },
  };
  ui.renderCorrection(draft);
  assert.equal(ui.node('correctionEvidence').children[1].textContent, 'No exact quote provided.');
  assert.equal(ui.node('approveCorrectionButton').disabled, true);
  await ui.submitCorrection(draft);
  assert.equal(ui.node('decisionMessage').textContent, 'No exact source quote was provided. No correction was submitted.');
});
