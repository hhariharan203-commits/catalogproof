const DEFAULT_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ID_LENGTH = 38;

let tokenCache = null;
let tokenRequest = null;

export class PayPalAdapterError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "PayPalAdapterError";
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

function fail(code, message, status) {
  throw new PayPalAdapterError(code, message, status);
}

function sandboxConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    fail("PAYPAL_UNAVAILABLE", "PayPal Sandbox credentials are not configured.", 503);
  }

  const rawBase = process.env.PAYPAL_API_BASE?.trim() || DEFAULT_SANDBOX_BASE;
  let base;
  try {
    base = new URL(rawBase);
  } catch {
    fail("PAYPAL_UNAVAILABLE", "PayPal API base must be the PayPal Sandbox endpoint.", 503);
  }
  if (
    base.protocol !== "https:" ||
    base.hostname !== "api-m.sandbox.paypal.com" ||
    base.port ||
    base.username ||
    base.password ||
    (base.pathname !== "/" && base.pathname !== "") ||
    base.search ||
    base.hash
  ) {
    fail("PAYPAL_UNAVAILABLE", "Only the PayPal Sandbox API endpoint is allowed.", 503);
  }

  return { baseUrl: DEFAULT_SANDBOX_BASE, clientId, clientSecret };
}

function validateRedirectUrl(value, envName) {
  if (!value?.trim()) {
    fail("PAYPAL_UNAVAILABLE", `${envName} is not configured.`, 503);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail("PAYPAL_UNAVAILABLE", `${envName} must be an absolute HTTPS URL.`, 503);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("PAYPAL_UNAVAILABLE", `${envName} must be an absolute HTTPS URL.`, 503);
  }
  return url.toString();
}

function validateRequestId(requestId) {
  if (
    typeof requestId !== "string" ||
    requestId.length < 1 ||
    requestId.length > MAX_REQUEST_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    fail("PAYPAL_INVALID_REQUEST", "A valid PayPal-Request-Id is required.", 400);
  }
}

function validateOrderId(orderId) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    fail("PAYPAL_INVALID_REQUEST", "A valid PayPal order ID is required.", 400);
  }
}

function requireSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("PAYPAL_INVALID_REQUEST", "A frozen checkout snapshot is required.", 400);
  }

  const requiredStrings = ["catalogVersionId", "productId", "sku", "title", "currency", "returnUrl", "cancelUrl"];
  for (const field of requiredStrings) {
    if (typeof snapshot[field] !== "string" || !snapshot[field].trim()) {
      fail("PAYPAL_INVALID_REQUEST", `Snapshot field ${field} is required.`, 400);
    }
  }
  if (snapshot.title.length > 127 || snapshot.sku.length > 127) {
    fail("PAYPAL_INVALID_REQUEST", "The product title and SKU must each be 127 characters or fewer.", 400);
  }
  const returnUrl = validateRedirectUrl(snapshot.returnUrl, "snapshot.returnUrl");
  const cancelUrl = validateRedirectUrl(snapshot.cancelUrl, "snapshot.cancelUrl");
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot currency must be a three-letter uppercase code.", 400);
  }
  if (!Number.isSafeInteger(snapshot.quantity) || snapshot.quantity < 1) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot quantity must be a positive safe integer.", 400);
  }
  if (!Number.isSafeInteger(snapshot.unitAmountMinor) || snapshot.unitAmountMinor < 1) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot unitAmountMinor must be a positive safe integer.", 400);
  }
  if (!Number.isSafeInteger(snapshot.totalAmountMinor) || snapshot.totalAmountMinor < 1) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot totalAmountMinor must be a positive safe integer.", 400);
  }
  const expectedTotal = BigInt(snapshot.unitAmountMinor) * BigInt(snapshot.quantity);
  if (expectedTotal > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(snapshot.totalAmountMinor) !== expectedTotal) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot total does not match unit amount multiplied by quantity.", 400);
  }

  let fractionDigits;
  try {
    fractionDigits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: snapshot.currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot currency is not supported by this runtime.", 400);
  }

  return { ...snapshot, returnUrl, cancelUrl, fractionDigits };
}

function formatMinorAmount(minor, fractionDigits) {
  const value = BigInt(minor);
  const scale = 10n ** BigInt(fractionDigits);
  const whole = value / scale;
  if (fractionDigits === 0) return whole.toString();
  const fraction = (value % scale).toString().padStart(fractionDigits, "0");
  return `${whole}.${fraction}`;
}

function formatVariantAttributes(attributes) {
  if (attributes == null) return undefined;
  if (typeof attributes !== "object" || Array.isArray(attributes)) {
    fail("PAYPAL_INVALID_REQUEST", "Snapshot variantAttributes must be an object.", 400);
  }
  const values = Object.entries(attributes).map(([key, value]) => {
    if (!key || value == null || ["object", "function", "symbol"].includes(typeof value)) {
      fail("PAYPAL_INVALID_REQUEST", "Snapshot variant attributes must contain simple values.", 400);
    }
    return `${key}: ${String(value)}`;
  });
  if (values.length === 0) return undefined;
  const description = values.join("; ");
  if (description.length > 127) {
    fail("PAYPAL_INVALID_REQUEST", "The variant description exceeds PayPal's 127-character limit.", 400);
  }
  return description;
}

function validateOptionalProductUrl(value, field) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    fail("PAYPAL_INVALID_REQUEST", `Snapshot ${field} must be an HTTPS URL.`, 400);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("PAYPAL_INVALID_REQUEST", `Snapshot ${field} must be an HTTPS URL.`, 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("PAYPAL_INVALID_REQUEST", `Snapshot ${field} must be an HTTPS URL.`, 400);
  }
  return url.toString();
}

function createOrderPayload(snapshot) {
  const validated = requireSnapshot(snapshot);
  const unitValue = formatMinorAmount(validated.unitAmountMinor, validated.fractionDigits);
  const totalValue = formatMinorAmount(validated.totalAmountMinor, validated.fractionDigits);
  const currency = validated.currency;
  const item = {
    name: validated.title,
    sku: validated.sku,
    quantity: String(validated.quantity),
    unit_amount: { currency_code: currency, value: unitValue },
    category: "PHYSICAL_GOODS",
  };
  const variantDescription = formatVariantAttributes(validated.variantAttributes);
  if (variantDescription) item.description = variantDescription;
  const productUrl = validateOptionalProductUrl(validated.productUrl, "productUrl");
  if (productUrl) item.url = productUrl;
  const imageUrl = validateOptionalProductUrl(validated.imageUrl, "imageUrl");
  if (imageUrl) item.image_url = imageUrl;

  return {
    intent: "CAPTURE",
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          landing_page: "LOGIN",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: validated.returnUrl,
          cancel_url: validated.cancelUrl,
        },
      },
    },
    purchase_units: [
      {
        reference_id: validated.catalogVersionId,
        custom_id: validated.productId,
        amount: {
          currency_code: currency,
          value: totalValue,
          breakdown: {
            item_total: { currency_code: currency, value: totalValue },
          },
        },
        items: [item],
      },
    ],
  };
}

async function parseResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    fail("PAYPAL_RESPONSE_INVALID", "PayPal returned an unreadable response.", response.status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail("PAYPAL_RESPONSE_INVALID", "PayPal returned an invalid JSON response.", response.status);
  }
}

async function fetchWithTimeout(url, options) {
  try {
    return await globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    fail("PAYPAL_NETWORK_ERROR", "The PayPal Sandbox request could not be completed.", 502);
  }
}

async function getAccessToken(config) {
  const cacheKey = `${config.baseUrl}\u0000${config.clientId}`;
  if (tokenCache?.cacheKey === cacheKey && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  if (tokenRequest?.cacheKey === cacheKey) return tokenRequest.promise;

  const promise = (async () => {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
    const response = await fetchWithTimeout(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      fail("PAYPAL_AUTH_FAILED", "PayPal Sandbox authentication failed.", response.status);
    }
    if (!payload || typeof payload.access_token !== "string" || !payload.access_token) {
      fail("PAYPAL_RESPONSE_INVALID", "PayPal Sandbox returned no access token.", response.status);
    }
    const lifetimeSeconds = Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : 300;
    tokenCache = {
      cacheKey,
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeSeconds - 30) * 1000,
    };
    return payload.access_token;
  })();

  tokenRequest = { cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  }
}

async function paypalRequest(config, { method, path, body, requestId, prefer }) {
  const accessToken = await getAccessToken(config);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  if (prefer) headers.Prefer = prefer;

  const response = await fetchWithTimeout(`${config.baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "PAYPAL_AUTH_FAILED" : "PAYPAL_API_ERROR";
    fail(code, `PayPal Sandbox request failed with HTTP ${response.status}.`, response.status);
  }
  if (!payload || typeof payload !== "object") {
    fail("PAYPAL_RESPONSE_INVALID", "PayPal Sandbox returned an empty or invalid response.", response.status);
  }
  return payload;
}

export async function createOrder({ snapshot, requestId } = {}) {
  validateRequestId(requestId);
  const config = sandboxConfig();
  const payload = createOrderPayload(snapshot);
  return paypalRequest(config, {
    method: "POST",
    path: "/v2/checkout/orders",
    body: payload,
    requestId,
    prefer: "return=representation",
  });
}

export async function getOrder(orderId) {
  validateOrderId(orderId);
  const config = sandboxConfig();
  return paypalRequest(config, {
    method: "GET",
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  });
}

export async function captureOrder(orderId, requestId) {
  validateOrderId(orderId);
  validateRequestId(requestId);
  const config = sandboxConfig();
  return paypalRequest(config, {
    method: "POST",
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    body: {},
    requestId,
  });
}
