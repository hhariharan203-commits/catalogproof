import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ENV_KEYS = [
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_REQUEST_TIMEOUT_MS', 'AI_NVIDIA_ENABLE_THINKING',
];
const REQUIRED_AI_ENV_KEYS = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

after(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
});

function aiEnv(suffix = 'test') {
  return {
    AI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    AI_API_KEY: `private-test-key-${suffix}`,
    AI_MODEL: 'fixture-model',
  };
}

function candidate({ sku, color, size, available = true, quote = `Color: ${color}; Size: ${size}.`, url = `https://shop.example.test/products/${sku.toLowerCase()}` }) {
  return {
    sku,
    title: 'Trail Runner Shoe',
    description: 'Synthetic test fixture. Red trail-running shoe.',
    brand: 'Example Brand',
    variantAttributes: { Color: color, Size: size },
    available,
    sourceRecord: {
      id: `record-${sku}`,
      sourceUrl: url,
      descriptionEvidence: quote,
      in_stock: available,
    },
  };
}

function input(overrides = {}) {
  return {
    queryText: 'Find a red trail runner in size 38',
    expectedSku: 'SHOE-RED-38',
    catalogVersion: 'test-version-1',
    candidates: [
      candidate({ sku: 'SHOE-RED-38', color: 'Red', size: '38' }),
      candidate({ sku: 'SHOE-RED-39', color: 'Red', size: '39' }),
      candidate({ sku: 'SHOE-BLUE-38', color: 'Blue', size: '38' }),
    ],
    ...overrides,
  };
}

function teamFixtureCandidates() {
  const seed = JSON.parse(readFileSync(new URL('../data/demo_seed.json', import.meta.url), 'utf8'));
  return seed.items.map((item, index) => ({
    sku: item.sku,
    title: item.title,
    description: item.description,
    brand: item.brand,
    variantAttributes: item.variantAttributes,
    sourceRecord: item.sourceRecord,
    productUrl: item.productUrl,
    available: item.available,
    recordId: `db-row-${index + 1}`,
  }));
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function modelResponse(content, { model = 'fixture-model' } = {}) {
  return response(200, {
    id: 'response-fixture',
    model,
    choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }],
  });
}

function supportedMatch(sku = 'SHOE-RED-38') {
  const row = sku === 'SHOE-RED-38'
    ? { sku, recordId: `record-${sku}`, color: 'Red', size: '38' }
    : { sku, recordId: `record-${sku}`, color: 'Red', size: '39' };
  return {
    selectedSku: sku,
    outcome: 'supported_match',
    matchedFacts: [
      { fieldPath: 'variantAttributes.Color', value: row.color, recordId: row.recordId },
      { fieldPath: 'variantAttributes.Size', value: row.size, recordId: row.recordId },
    ],
    issues: [],
  };
}

async function withRuntime({ env = {}, fetchImpl, run }) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl ?? originalFetch;
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    globalThis.fetch = originalFetch;
  }
}

async function loadDiagnostics() {
  return import('../server/diagnostics.js');
}

test('missing AI configuration fails closed without a network request or mock inference', async () => {
  const { diagnose } = await loadDiagnostics();
  let calls = 0;
  await withRuntime({
    env: {},
    fetchImpl: async () => { calls += 1; throw new Error('unexpected network call'); },
    run: async () => {
      await assert.rejects(diagnose(input()), (error) => {
        assert.equal(error.code, 'AI_UNAVAILABLE');
        assert.equal(error.status, 503);
        assert.equal(String(error).includes('private-test-key'), false);
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test('diagnose rejects malformed input before sending any model request', async () => {
  const { diagnose } = await loadDiagnostics();
  let calls = 0;
  await withRuntime({
    env: aiEnv('invalid-input'),
    fetchImpl: async () => { calls += 1; throw new Error('unexpected network call'); },
    run: async () => {
      await assert.rejects(diagnose(input({ expectedSku: 'SKU-NOT-IN-CANDIDATES' })), (error) => {
        assert.equal(error.code, 'INVALID_AI_INPUT');
        assert.equal(error.status, 400);
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test('model request is server-side, candidate-limited, JSON-constrained and validated against exact citations', async () => {
  const { diagnose } = await loadDiagnostics();
  const calls = [];
  await withRuntime({
    env: { ...aiEnv('request-shape'), AI_REQUEST_TIMEOUT_MS: '90000', AI_NVIDIA_ENABLE_THINKING: 'false' },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return modelResponse(supportedMatch());
    },
    run: async () => {
      const result = await diagnose(input());
      assert.equal(result.selectedSku, 'SHOE-RED-38');
      assert.equal(result.outcome, 'supported_match');
      assert.equal(result.matchedFacts.length, 2);
      assert.deepEqual(result.issues, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.href, 'https://integrate.api.nvidia.com/v1/chat/completions');
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(calls[0].options.redirect, 'error');
      assert.ok(calls[0].options.signal instanceof AbortSignal);
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${aiEnv('request-shape').AI_API_KEY}`);
      const body = JSON.parse(calls[0].options.body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1600);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      assert.equal(body.stream, false);
      assert.equal(body.messages.length, 2);
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(payload.queryText, input().queryText);
      assert.equal(payload.catalogVersion, 'test-version-1');
      assert.ok(payload.availableSkus.includes('SHOE-RED-38'));
      assert.deepEqual(payload.constraintSatisfyingSkus, ['SHOE-RED-38']);
      assert.ok(payload.candidates.every((row) => input().candidates.some((item) => item.sku === row.sku)));
      assert.ok(payload.candidates.length <= 12);
      assert.ok(payload.candidates.every((row) => Array.isArray(row.citationFields)));
      assert.ok(payload.candidates[0].citationFields.some((field) => field.fieldPath === 'variantAttributes.Color'
        && field.value === 'Red'));
      assert.equal(JSON.stringify(payload).includes(aiEnv('request-shape').AI_API_KEY), false);
    },
  });
});

test('array citations use exact numeric paths, and shorthand citations are rejected', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const row = {
    sku: 'TOTE-ECRU',
    title: 'Fieldwork Cotton Canvas Tote',
    description: 'Original synthetic fixture.',
    brand: 'Cedar Current Studio (fictional)',
    variantAttributes: { Color: 'Stone' },
    available: true,
    recordId: 'record-TOTE-ECRU',
    productUrl: 'https://shop.example.test/products/tote-ecru',
    sourceRecord: { variantId: 'source-variant-TOTE-ECRU', selectedOptions: [{ name: 'Color', value: 'Ecru' }] },
  };
  const request = input({
    queryText: 'Find the Fieldwork Cotton Canvas Tote in color Ecru',
    expectedSku: row.sku,
    catalogVersion: 'tote-v1',
    candidates: [row],
  });
  const valid = {
    selectedSku: row.sku,
    outcome: 'conflicting_evidence',
    matchedFacts: [
      { fieldPath: 'variantAttributes.Color', value: 'Stone', recordId: row.recordId },
      { fieldPath: 'sourceRecord.selectedOptions.0.value', value: 'Ecru', recordId: row.recordId },
    ],
    issues: [{
      type: 'conflicting_source_values',
      fieldPath: 'variantAttributes.Color',
      actualValue: 'Stone',
      expectedOrMissingValue: 'Ecru',
      evidence: [
        { sku: row.sku, fieldPath: 'variantAttributes.Color', value: 'Stone', recordId: row.recordId },
        { sku: row.sku, fieldPath: 'sourceRecord.selectedOptions.0.value', value: 'Ecru', recordId: row.recordId },
      ],
      explanation: 'The import and source option disagree.',
    }],
    correctionDraft: {
      sku: row.sku,
      fieldPath: 'variantAttributes.Color',
      proposedValue: 'Ecru',
      evidence: [{
        sourceType: 'catalog_record',
        sourceReference: 'catalog://tote-v1/sku/TOTE-ECRU',
        exactQuote: 'Ecru',
        recordId: row.recordId,
      }],
      explanation: 'The exact source option supports Ecru.',
    },
    uncertaintyReason: null,
  };
  await t.test('exact indexed source path is accepted', async () => {
    let payload;
    await withRuntime({
      env: aiEnv('indexed-citation'),
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(JSON.parse(options.body).messages[1].content);
        return modelResponse(valid);
      },
      run: async () => {
        const result = await diagnose(request);
        const candidatePayload = payload.candidates.find((item) => item.sku === row.sku);
        assert.deepEqual(payload.constraintSatisfyingSkus, []);
        assert.ok(candidatePayload.citationFields.some((field) => field.fieldPath === 'sourceRecord.selectedOptions.0.value'
          && field.value === 'Ecru' && field.recordId === row.recordId && field.sku === row.sku));
        assert.ok(!candidatePayload.citationFields.some((field) => field.fieldPath.includes('[]')));
        assert.equal(result.outcome, 'conflicting_evidence');
        assert.equal(result.correctionDraft.proposedValue, 'Ecru');
      },
    });
  });
  await t.test('invented array shorthand is rejected', async () => {
    const invalid = structuredClone(valid);
    invalid.matchedFacts[1].fieldPath = 'sourceRecord.selectedOptions[].Color';
    await withRuntime({
      env: aiEnv('bad-array-path'),
      fetchImpl: async () => modelResponse(invalid),
      run: async () => {
        await assert.rejects(diagnose(request), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
  await t.test('source variant ID cannot replace the CatalogProof row ID', async () => {
    const invalid = structuredClone(valid);
    invalid.matchedFacts[1].recordId = 'source-variant-TOTE-ECRU';
    await withRuntime({
      env: aiEnv('wrong-source-record-id'),
      fetchImpl: async () => modelResponse(invalid),
      run: async () => {
        await assert.rejects(diagnose(request), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
  await t.test('correction cannot cite the imported value against the named source option', async () => {
    const invalid = structuredClone(valid);
    invalid.correctionDraft.proposedValue = 'Stone';
    invalid.correctionDraft.evidence[0].exactQuote = 'Stone';
    await withRuntime({
      env: aiEnv('contradictory-source-option'),
      fetchImpl: async () => modelResponse(invalid),
      run: async () => {
        await assert.rejects(diagnose(request), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
});

test('NVIDIA thinking override accepts both boolean values and non-NVIDIA hosts omit it', async (t) => {
  const { diagnose } = await loadDiagnostics();
  for (const value of ['true', 'false']) {
    await t.test(`NVIDIA enable_thinking=${value}`, async () => {
      let body;
      await withRuntime({
        env: { ...aiEnv(`thinking-${value}`), AI_NVIDIA_ENABLE_THINKING: value },
        fetchImpl: async (_url, options) => {
          body = JSON.parse(options.body);
          return modelResponse(supportedMatch());
        },
        run: async () => {
          await diagnose(input());
          assert.deepEqual(body.chat_template_kwargs, { enable_thinking: value === 'true' });
        },
      });
    });
  }
  await t.test('generic host omits NVIDIA-specific option', async () => {
    let body;
    await withRuntime({
      env: {
        ...aiEnv('generic-host'),
        AI_BASE_URL: 'https://ai.example.test/v1',
        AI_NVIDIA_ENABLE_THINKING: 'not-a-boolean',
      },
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return modelResponse(supportedMatch());
      },
      run: async () => {
        await diagnose(input());
        assert.equal(Object.hasOwn(body, 'chat_template_kwargs'), false);
      },
    });
  });
});

test('invalid optional AI settings fail closed before network access', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const cases = [
    { name: 'timeout below minimum', env: { AI_REQUEST_TIMEOUT_MS: '999' } },
    { name: 'timeout above maximum', env: { AI_REQUEST_TIMEOUT_MS: '120001' } },
    { name: 'noninteger timeout', env: { AI_REQUEST_TIMEOUT_MS: '1.5' } },
    { name: 'invalid NVIDIA boolean', env: { AI_NVIDIA_ENABLE_THINKING: 'sometimes' } },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      let calls = 0;
      await withRuntime({
        env: { ...aiEnv(item.name), ...item.env },
        fetchImpl: async () => { calls += 1; throw new Error('unexpected network call'); },
        run: async () => {
          await assert.rejects(diagnose(input()), (error) => {
            assert.equal(error.code, 'AI_UNAVAILABLE');
            assert.equal(error.status, 503);
            assert.equal(String(error).includes(aiEnv(item.name).AI_API_KEY), false);
            return true;
          });
          assert.equal(calls, 0);
        },
      });
    });
  }
});

test('default request timeout remains 20 seconds and rejected fetch errors do not leak secrets', async () => {
  const { diagnose } = await loadDiagnostics();
  const observedTimeouts = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    observedTimeouts.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  };
  try {
    const secret = aiEnv('fetch-abort').AI_API_KEY;
    await withRuntime({
      env: aiEnv('fetch-abort'),
      fetchImpl: async () => { throw new Error(`aborted request with ${secret}`); },
      run: async () => {
        await assert.rejects(diagnose(input()), (error) => {
          assert.equal(error.code, 'AI_UNAVAILABLE');
          assert.equal(error.status, 503);
          assert.equal(String(error).includes(secret), false);
          return true;
        });
      },
    });
    await withRuntime({
      env: { ...aiEnv('configured-timeout'), AI_REQUEST_TIMEOUT_MS: '90000' },
      fetchImpl: async () => modelResponse(supportedMatch()),
      run: async () => {
        await diagnose(input());
        assert.deepEqual(observedTimeouts, [20_000, 90_000]);
      },
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('hard variant constraints reject a model-selected nonmatching candidate', async () => {
  const { diagnose } = await loadDiagnostics();
  await withRuntime({
    env: aiEnv('hard-constraint'),
    fetchImpl: async () => modelResponse(supportedMatch('SHOE-RED-39')),
    run: async () => {
      await assert.rejects(diagnose(input()), (error) => {
        assert.equal(error.code, 'AI_INVALID_RESPONSE');
        assert.equal(error.status, 502);
        return true;
      });
    },
  });
});

test('explicitly unavailable variants are never selectable', async () => {
  const { diagnose } = await loadDiagnostics();
  let payload;
  const unavailableInput = input({
    candidates: [
      candidate({ sku: 'SHOE-RED-38', color: 'Red', size: '38', available: false }),
      candidate({ sku: 'SHOE-RED-39', color: 'Red', size: '39', available: true }),
    ],
  });
  const uncertain = {
    selectedSku: null,
    outcome: 'insufficient_evidence',
    matchedFacts: [],
    issues: [],
    uncertaintyReason: 'The only exact variant is marked unavailable in the supplied catalog record.',
  };
  await withRuntime({
    env: aiEnv('unavailable'),
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return modelResponse(uncertain);
    },
    run: async () => {
      const result = await diagnose(unavailableInput);
      assert.equal(result.selectedSku, null);
      assert.equal(result.outcome, 'insufficient_evidence');
      const modelInput = JSON.parse(payload.messages[1].content);
      assert.ok(!modelInput.availableSkus.includes('SHOE-RED-38'));
      assert.ok(modelInput.availableSkus.includes('SHOE-RED-39'));
    },
  });
});

test('a requested size absent from the catalog cannot be returned as a supported match', async () => {
  const { diagnose } = await loadDiagnostics();
  let requestPayload;
  const query = input({ queryText: 'Find a red trail runner size 42' });
  const uncertain = {
    selectedSku: null,
    outcome: 'insufficient_evidence',
    matchedFacts: [],
    issues: [],
    uncertaintyReason: 'The catalog does not contain the requested size.',
  };
  await withRuntime({
    env: aiEnv('size-not-found'),
    fetchImpl: async (_url, options) => {
      requestPayload = JSON.parse(options.body);
      return modelResponse(uncertain);
    },
    run: async () => {
      const result = await diagnose(query);
      assert.equal(result.selectedSku, null);
      assert.equal(result.outcome, 'insufficient_evidence');
      const modelInput = JSON.parse(requestPayload.messages[1].content);
      assert.ok(modelInput.availableSkus.length > 0);
      assert.ok(modelInput.hardConstraints.some((constraint) => constraint.key === 'Size' && constraint.unmatched));
    },
  });
});

test('an absent-size query may return an available variant only as a cited conflict', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const query = input({ queryText: 'Find a red trail runner size 42' });
  await t.test('cited mismatch is allowed as conflicting_evidence', async () => {
    const conflict = {
      selectedSku: 'SHOE-RED-39',
      outcome: 'conflicting_evidence',
      matchedFacts: [],
      issues: [{
        type: 'size_mismatch',
        fieldPath: 'variantAttributes.Size',
        actualValue: '39',
        expectedOrMissingValue: null,
        evidence: [{ sku: 'SHOE-RED-39', fieldPath: 'variantAttributes.Size', value: '39', recordId: 'record-SHOE-RED-39' }],
        explanation: 'The catalog has size 39, not the requested size 42.',
      }],
      correctionDraft: null,
      uncertaintyReason: null,
    };
    await withRuntime({
      env: aiEnv('size-conflict'),
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
        assert.ok(payload.availableSkus.includes('SHOE-RED-39'));
        assert.ok(payload.hardConstraints.some((constraint) => constraint.key === 'Size' && constraint.unmatched));
        return modelResponse(conflict);
      },
      run: async () => {
        const result = await diagnose(query);
        assert.equal(result.selectedSku, 'SHOE-RED-39');
        assert.equal(result.outcome, 'conflicting_evidence');
        assert.ok(result.issues.some((issue) => issue.type === 'size_mismatch'));
      },
    });
  });
  await t.test('same mismatch is rejected if labeled supported_match', async () => {
    await withRuntime({
      env: aiEnv('size-false-match'),
      fetchImpl: async () => modelResponse({ ...supportedMatch('SHOE-RED-39'), correctionDraft: null }),
      run: async () => {
        await assert.rejects(diagnose(query), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
});

test('issue expected values may cite the query constraint but not an invented value', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const query = input({ queryText: 'Find a red trail runner size 42' });
  const issueResponse = (expectedOrMissingValue) => ({
    selectedSku: 'SHOE-RED-39',
    outcome: 'conflicting_evidence',
    matchedFacts: [],
    issues: [{
      type: 'size_mismatch',
      fieldPath: 'variantAttributes.Size',
      actualValue: '39',
      expectedOrMissingValue,
      evidence: [{ sku: 'SHOE-RED-39', fieldPath: 'variantAttributes.Size', value: '39', recordId: 'record-SHOE-RED-39' }],
      explanation: 'The record lists 39, whereas the shopper asks for 42.',
    }],
    correctionDraft: null,
    uncertaintyReason: null,
  });
  await t.test('query value is accepted as query-derived, not catalog evidence', async () => {
    await withRuntime({
      env: aiEnv('query-expected-value'),
      fetchImpl: async () => modelResponse(issueResponse('42')),
      run: async () => {
        const result = await diagnose(query);
        assert.equal(result.outcome, 'conflicting_evidence');
        assert.match(result.issues[0].explanation, /query asks for "42"/);
      },
    });
  });
  await t.test('unrequested expected value is rejected', async () => {
    await withRuntime({
      env: aiEnv('invented-expected-value'),
      fetchImpl: async () => modelResponse(issueResponse('40')),
      run: async () => {
        await assert.rejects(diagnose(query), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
});

test('a model cannot select an unavailable exact-match SKU', async () => {
  const { diagnose } = await loadDiagnostics();
  const query = input({
    candidates: [
      candidate({ sku: 'SHOE-RED-38', color: 'Red', size: '38', available: false }),
      candidate({ sku: 'SHOE-RED-39', color: 'Red', size: '39', available: true }),
    ],
  });
  await withRuntime({
    env: aiEnv('select-unavailable'),
    fetchImpl: async () => modelResponse(supportedMatch()),
    run: async () => {
      await assert.rejects(diagnose(query), (error) => error.code === 'AI_INVALID_RESPONSE');
    },
  });
});

test('stale nested availability false overrides a higher-level true flag', async () => {
  const { diagnose } = await loadDiagnostics();
  const query = input({
    candidates: [
      {
        ...candidate({ sku: 'SHOE-RED-38', color: 'Red', size: '38', available: true }),
        sourceRecord: { id: 'product-record', variants: [{ sku: 'SHOE-RED-38', in_stock: false }] },
      },
      candidate({ sku: 'SHOE-RED-39', color: 'Red', size: '39', available: true }),
    ],
  });
  await withRuntime({
    env: aiEnv('nested-stale-availability'),
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.ok(!payload.availableSkus.includes('SHOE-RED-38'));
      assert.ok(payload.availableSkus.includes('SHOE-RED-39'));
      return modelResponse({
        selectedSku: null,
        outcome: 'insufficient_evidence',
        matchedFacts: [],
        issues: [],
        uncertaintyReason: 'The exact SKU is marked unavailable in the source record.',
      });
    },
    run: async () => {
      const result = await diagnose(query);
      assert.equal(result.selectedSku, null);
      assert.notEqual(result.outcome, 'supported_match');
    },
  });
});

test('unknown SKU selection and incorrect field citations are rejected', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const cases = [
    {
      name: 'unknown SKU',
      model: { ...supportedMatch(), selectedSku: 'NOT-IN-CATALOG' },
    },
    {
      name: 'wrong cited value',
      model: {
        ...supportedMatch(),
        matchedFacts: [{ fieldPath: 'variantAttributes.Color', value: 'Green', recordId: 'record-SHOE-RED-38' }],
      },
    },
    {
      name: 'unknown citation path',
      model: {
        ...supportedMatch(),
        matchedFacts: [{ fieldPath: 'variantAttributes.__proto__', value: 'polluted', recordId: 'record-SHOE-RED-38' }],
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await withRuntime({
        env: aiEnv(`invalid-${item.name.replaceAll(' ', '-')}`),
        fetchImpl: async () => modelResponse(item.model),
        run: async () => {
          await assert.rejects(diagnose(input()), (error) => error.code === 'AI_INVALID_RESPONSE');
        },
      });
    });
  }
});

test('expected-SKU mismatch is explicitly diagnosed from exact variant records', async () => {
  const { diagnose } = await loadDiagnostics();
  await withRuntime({
    env: aiEnv('expected-mismatch'),
    fetchImpl: async () => modelResponse(supportedMatch('SHOE-RED-39')),
    run: async () => {
      // Use a query without an explicit size constraint so the wrong-variant run reaches the validator.
      const result = await diagnose(input({ queryText: 'Find a red trail runner' }));
      assert.equal(result.selectedSku, 'SHOE-RED-39');
      assert.equal(result.outcome, 'conflicting_evidence');
      const mismatch = result.issues.find((issue) => issue.type === 'expected_variant_mismatch');
      assert.ok(mismatch);
      assert.equal(mismatch.actualValue, '39');
      assert.equal(mismatch.expectedOrMissingValue, '38');
      assert.equal(mismatch.evidence.length, 2);
    },
  });
});

test('correction draft must cite an exact source quote and cannot alter protected commerce fields', async (t) => {
  const { diagnose } = await loadDiagnostics();
  const row = candidate({ sku: 'SHOE-RED-38', color: 'Red', size: '38', quote: 'Color: Red; fit note: true to size.' });
  const withCorrectionInput = input({ candidates: [row] });
  const validDraft = {
    selectedSku: 'SHOE-RED-38',
    outcome: 'supported_match',
    matchedFacts: [],
    issues: [],
    correctionDraft: {
      sku: 'SHOE-RED-38',
      fieldPath: 'variantAttributes.Color',
      proposedValue: 'Red',
      evidence: [{
        sourceType: 'catalog_record',
        sourceReference: 'https://shop.example.test/products/shoe-red-38',
        exactQuote: 'Color: Red; fit note: true to size.',
        recordId: 'record-SHOE-RED-38',
      }],
      explanation: 'The source states the color is red.',
    },
  };
  const cases = [
    { name: 'accept exact source quote', model: validDraft, shouldPass: true },
    {
      name: 'reject an invented quote',
      model: { ...validDraft, correctionDraft: { ...validDraft.correctionDraft, proposedValue: 'Blue' } },
      shouldPass: false,
    },
    {
      name: 'reject price corrections',
      model: { ...validDraft, correctionDraft: { ...validDraft.correctionDraft, fieldPath: 'price', proposedValue: '9.99' } },
      shouldPass: false,
    },
    {
      name: 'reject stock corrections',
      model: { ...validDraft, correctionDraft: { ...validDraft.correctionDraft, fieldPath: 'availability', proposedValue: 'true' } },
      shouldPass: false,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await withRuntime({
        env: aiEnv(`correction-${item.name.replaceAll(' ', '-')}`),
        fetchImpl: async () => modelResponse(item.model),
        run: async () => {
          if (item.shouldPass) {
            const result = await diagnose(withCorrectionInput);
            assert.equal(result.correctionDraft.proposedValue, 'Red');
            assert.match(result.correctionDraft.explanation, /seller approval/i);
          } else {
            await assert.rejects(diagnose(withCorrectionInput), (error) => error.code === 'AI_INVALID_RESPONSE');
          }
        },
      });
    });
  }
});

test('provider failures, invalid JSON and unsafe base URLs are reported safely', async (t) => {
  const { diagnose } = await loadDiagnostics();
  await t.test('HTTP failure does not leak provider body or key', async () => {
    const secret = aiEnv('http-failure').AI_API_KEY;
    await withRuntime({
      env: aiEnv('http-failure'),
      fetchImpl: async () => ({ ok: false, status: 429, async text() { return secret; } }),
      run: async () => {
        await assert.rejects(diagnose(input()), (error) => {
          assert.equal(error.code, 'AI_UNAVAILABLE');
          assert.equal(error.status, 503);
          assert.equal(String(error).includes(secret), false);
          return true;
        });
      },
    });
  });
  await t.test('invalid provider JSON is rejected', async () => {
    await withRuntime({
      env: aiEnv('invalid-json'),
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return 'not-json'; } }),
      run: async () => {
        await assert.rejects(diagnose(input()), (error) => error.code === 'AI_INVALID_RESPONSE');
      },
    });
  });
  await t.test('non-HTTPS provider base is rejected without a request', async () => {
    let calls = 0;
    await withRuntime({
      env: { ...aiEnv('unsafe-base'), AI_BASE_URL: 'http://ai.example.test/v1' },
      fetchImpl: async () => { calls += 1; throw new Error('unexpected network call'); },
      run: async () => {
        await assert.rejects(diagnose(input()), (error) => error.code === 'AI_UNAVAILABLE');
        assert.equal(calls, 0);
      },
    });
  });
});

const liveInferenceConfigured = REQUIRED_AI_ENV_KEYS.every((key) => process.env[key]?.trim());
test('live AI inference smoke (not mocked)', { timeout: 110_000, skip: liveInferenceConfigured ? false : 'AI_BASE_URL, AI_API_KEY and AI_MODEL are not configured in this environment.' }, async () => {
  const { diagnose } = await loadDiagnostics();
  const result = await diagnose(input());
  assert.ok(['supported_match', 'conflicting_evidence', 'insufficient_evidence', 'ambiguous'].includes(result.outcome));
  assert.ok(result.selectedSku === null || input().candidates.some((row) => row.sku === result.selectedSku));
});

test('live NVIDIA team-authored fixture correction replay (not mocked)', {
  timeout: 200_000,
  skip: liveInferenceConfigured ? false : 'AI_BASE_URL, AI_API_KEY and AI_MODEL are not configured in this environment.',
}, async () => {
  const { diagnose } = await loadDiagnostics();
  const candidates = teamFixtureCandidates();
  const targetSku = 'CCS-CANVAS-TOTE-ECRU-01';
  const queryText = 'Find the Ecru Fieldwork Cotton Canvas Tote.';
  const before = await diagnose({
    queryText,
    expectedSku: targetSku,
    catalogVersion: 'team-synthetic-before-live-smoke',
    candidates,
  });
  assert.notEqual(before.outcome, 'supported_match', 'the controlled Stone/Ecru inconsistency must not pass as a supported match');
  assert.ok(before.selectedSku === null || before.outcome === 'conflicting_evidence');
  assert.equal(before.correctionDraft?.sku, targetSku);
  assert.equal(before.correctionDraft?.fieldPath, 'variantAttributes.Color');
  assert.equal(before.correctionDraft?.proposedValue, 'Ecru');
  assert.ok(before.correctionDraft?.evidence.some((item) => item.exactQuote === 'Ecru'
    && item.recordId === candidates.find((candidate) => candidate.sku === targetSku)?.recordId));

  const corrected = candidates.map((candidate) => candidate.sku === targetSku
    ? { ...candidate, variantAttributes: { ...candidate.variantAttributes, Color: 'Ecru' } }
    : candidate);
  const after = await diagnose({
    queryText,
    expectedSku: targetSku,
    catalogVersion: 'team-synthetic-after-live-smoke',
    candidates: corrected,
  });
  assert.equal(after.selectedSku, targetSku);
  assert.equal(after.outcome, 'supported_match');
});
