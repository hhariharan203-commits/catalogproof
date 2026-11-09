import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE",
];

function validSnapshot(overrides = {}) {
  return {
    catalogVersionId: "catalog-v2",
    productId: "product-100",
    sku: "SKU-RED-M",
    title: "Trail Runner Shoe",
    variantAttributes: { Color: "Red", Size: "M" },
    quantity: 2,
    unitAmountMinor: 5299,
    currency: "USD",
    totalAmountMinor: 10598,
    returnUrl: "https://catalogproof.example/api/checkouts/checkout-123/return",
    cancelUrl: "https://catalogproof.example/api/checkouts/checkout-123/cancel",
    productUrl: "https://shop.example/products/trail-runner",
    ...overrides,
  };
}

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return value === undefined ? "" : JSON.stringify(value);
    },
  };
}

async function withRuntime({ env = {}, fetchImpl, run }) {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = fetchImpl;
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

async function loadAdapter() {
  return import("../server/paypal.js");
}

function paypalEnv(suffix) {
  return {
    PAYPAL_CLIENT_ID: `sandbox-client-${suffix}`,
    PAYPAL_CLIENT_SECRET: `sandbox-secret-${suffix}`,
    PAYPAL_RETURN_URL: "https://catalogproof.example/paypal/return",
    PAYPAL_CANCEL_URL: "https://catalogproof.example/paypal/cancel",
  };
}

function tokenThen(handler) {
  return async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/oauth2/token") {
      assert.equal(options.method, "POST");
      assert.equal(options.body, "grant_type=client_credentials");
      return response(200, { access_token: "sandbox-access-token", expires_in: 3600 });
    }
    return handler(url, options);
  };
}

test("missing credentials fail closed without making a network request", async () => {
  const { createOrder } = await loadAdapter();
  let calls = 0;
  await withRuntime({
    env: {},
    fetchImpl: async () => { calls += 1; throw new Error("unexpected network call"); },
    run: async () => {
      await assert.rejects(createOrder({ snapshot: validSnapshot(), requestId: "create-missing-config" }), (error) => {
        assert.equal(error.code, "PAYPAL_UNAVAILABLE");
        assert.equal(error.status, 503);
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test("refuses a live or non-PayPal API base", async () => {
  const { getOrder } = await loadAdapter();
  let calls = 0;
  await withRuntime({
    env: { ...paypalEnv("live-base"), PAYPAL_API_BASE: "https://api-m.paypal.com" },
    fetchImpl: async () => { calls += 1; throw new Error("unexpected network call"); },
    run: async () => {
      await assert.rejects(getOrder("ORDER-LIVE-GUARD"), (error) => {
        assert.equal(error.code, "PAYPAL_UNAVAILABLE");
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test("createOrder sends one exact CAPTURE purchase unit and returns PayPal response", async () => {
  const { createOrder } = await loadAdapter();
  const expected = {
    id: "ORDER-CREATE-1",
    status: "PAYER_ACTION_REQUIRED",
    links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-CREATE-1" }],
  };
  const calls = [];
  await withRuntime({
    env: paypalEnv("create"),
    fetchImpl: tokenThen(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(201, expected);
    }),
    run: async () => {
      const result = await createOrder({ snapshot: validSnapshot(), requestId: "cp-create-0001" });
      assert.deepEqual(result, expected);
      assert.equal(calls.length, 1);
      const [{ url, options }] = calls;
      assert.equal(url.origin, "https://api-m.sandbox.paypal.com");
      assert.equal(url.pathname, "/v2/checkout/orders");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["PayPal-Request-Id"], "cp-create-0001");
      assert.equal(options.headers.Prefer, "return=representation");
      assert.equal(options.headers.Authorization, "Bearer sandbox-access-token");
      const body = JSON.parse(options.body);
      assert.equal(body.intent, "CAPTURE");
      assert.equal(body.purchase_units.length, 1);
      assert.equal(body.purchase_units[0].reference_id, "catalog-v2");
      assert.equal(body.purchase_units[0].custom_id, "product-100");
      assert.deepEqual(body.purchase_units[0].amount, {
        currency_code: "USD",
        value: "105.98",
        breakdown: { item_total: { currency_code: "USD", value: "105.98" } },
      });
      assert.deepEqual(body.purchase_units[0].items, [{
        name: "Trail Runner Shoe",
        sku: "SKU-RED-M",
        quantity: "2",
        unit_amount: { currency_code: "USD", value: "52.99" },
        category: "PHYSICAL_GOODS",
        description: "Color: Red; Size: M",
        url: "https://shop.example/products/trail-runner",
      }]);
      assert.deepEqual(body.payment_source.paypal.experience_context, {
        payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
        landing_page: "LOGIN",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        return_url: "https://catalogproof.example/api/checkouts/checkout-123/return",
        cancel_url: "https://catalogproof.example/api/checkouts/checkout-123/cancel",
      });
    },
  });
});

test("createOrder formats zero-decimal currencies without inventing cents", async () => {
  const { createOrder } = await loadAdapter();
  let body;
  await withRuntime({
    env: paypalEnv("jpy"),
    fetchImpl: tokenThen(async (_url, options) => {
      body = JSON.parse(options.body);
      return response(201, { id: "ORDER-JPY", status: "PAYER_ACTION_REQUIRED", links: [] });
    }),
    run: async () => {
      await createOrder({
        snapshot: validSnapshot({ currency: "JPY", unitAmountMinor: 1200, totalAmountMinor: 2400, quantity: 2 }),
        requestId: "cp-create-jpy",
      });
      assert.equal(body.purchase_units[0].items[0].unit_amount.value, "1200");
      assert.equal(body.purchase_units[0].amount.value, "2400");
    },
  });
});

test("createOrder rejects a client-altered or inconsistent snapshot before network access", async () => {
  const { createOrder } = await loadAdapter();
  let calls = 0;
  await withRuntime({
    env: paypalEnv("bad-total"),
    fetchImpl: async () => { calls += 1; throw new Error("unexpected network call"); },
    run: async () => {
      await assert.rejects(createOrder({
        snapshot: validSnapshot({ totalAmountMinor: 1 }),
        requestId: "cp-create-bad-total",
      }), (error) => {
        assert.equal(error.code, "PAYPAL_INVALID_REQUEST");
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test("createOrder requires per-checkout return and cancel URLs in the snapshot", async () => {
  const { createOrder } = await loadAdapter();
  let calls = 0;
  await withRuntime({
    env: paypalEnv("url-missing"),
    fetchImpl: async () => { calls += 1; throw new Error("unexpected network call"); },
    run: async () => {
      const { returnUrl, cancelUrl, ...withoutCallbacks } = validSnapshot();
      await assert.rejects(createOrder({ snapshot: withoutCallbacks, requestId: "cp-create-no-urls" }), (error) => {
        assert.equal(error.code, "PAYPAL_INVALID_REQUEST");
        return true;
      });
      assert.equal(calls, 0);
    },
  });
});

test("getOrder URL-encodes the order ID and returns the authoritative API object", async () => {
  const { getOrder } = await loadAdapter();
  const expected = { id: "ORDER-GET-1", status: "APPROVED", purchase_units: [{ items: [{ sku: "SKU-RED-M" }] }] };
  const calls = [];
  await withRuntime({
    env: paypalEnv("get"),
    fetchImpl: tokenThen(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(200, expected);
    }),
    run: async () => {
      const result = await getOrder("ORDER-GET-1");
      assert.deepEqual(result, expected);
      assert.equal(calls[0].url.pathname, "/v2/checkout/orders/ORDER-GET-1");
      assert.equal(calls[0].options.method, "GET");
      assert.equal(calls[0].options.body, undefined);
      await assert.rejects(getOrder("../not-an-order"), (error) => error.code === "PAYPAL_INVALID_REQUEST");
      assert.equal(calls.length, 1);
    },
  });
});

test("captureOrder forwards the stable request ID and returns capture status unchanged", async () => {
  const { captureOrder } = await loadAdapter();
  const expected = { id: "ORDER-CAPTURE-1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED" }] } }] };
  const calls = [];
  await withRuntime({
    env: paypalEnv("capture"),
    fetchImpl: tokenThen(async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(201, expected);
    }),
    run: async () => {
      const result = await captureOrder("ORDER-CAPTURE-1", "cp-capture-0001");
      assert.deepEqual(result, expected);
      assert.equal(calls[0].url.pathname, "/v2/checkout/orders/ORDER-CAPTURE-1/capture");
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.headers["PayPal-Request-Id"], "cp-capture-0001");
      assert.equal(calls[0].options.body, "{}");
    },
  });
});

test("API and authentication errors never include credential values", async () => {
  const { getOrder } = await loadAdapter();
  const secret = "sandbox-secret-private-test-value";
  await withRuntime({
    env: { PAYPAL_CLIENT_ID: "client-error-test", PAYPAL_CLIENT_SECRET: secret },
    fetchImpl: async (_url, options) => {
      if (options.headers.Authorization.startsWith("Basic ")) {
        return response(401, { error: "invalid_client", error_description: secret });
      }
      return response(500, { message: secret });
    },
    run: async () => {
      await assert.rejects(getOrder("ORDER-ERROR-1"), (error) => {
        assert.equal(error.code, "PAYPAL_AUTH_FAILED");
        assert.equal(String(error).includes(secret), false);
        return true;
      });
    },
  });
});

test("PayPal API failures are mapped to safe adapter errors", async () => {
  const { getOrder } = await loadAdapter();
  await withRuntime({
    env: paypalEnv("api-error"),
    fetchImpl: tokenThen(async () => response(422, { name: "UNPROCESSABLE_ENTITY", message: "private detail" })),
    run: async () => {
      await assert.rejects(getOrder("ORDER-422"), (error) => {
        assert.equal(error.code, "PAYPAL_API_ERROR");
        assert.equal(error.status, 422);
        assert.equal(String(error).includes("private detail"), false);
        return true;
      });
    },
  });
});

test("network errors are explicit and never reported as success", async () => {
  const { getOrder } = await loadAdapter();
  await withRuntime({
    env: paypalEnv("network"),
    fetchImpl: tokenThen(async () => { throw new Error("offline"); }),
    run: async () => {
      await assert.rejects(getOrder("ORDER-NETWORK"), (error) => {
        assert.equal(error.code, "PAYPAL_NETWORK_ERROR");
        assert.equal(error.status, 502);
        return true;
      });
    },
  });
});

test("invalid PayPal JSON is not treated as a successful response", async () => {
  const { getOrder } = await loadAdapter();
  await withRuntime({
    env: paypalEnv("invalid-json"),
    fetchImpl: tokenThen(async () => ({ ok: true, status: 200, async text() { return "not-json"; } })),
    run: async () => {
      await assert.rejects(getOrder("ORDER-INVALID-JSON"), (error) => error.code === "PAYPAL_RESPONSE_INVALID");
    },
  });
});
