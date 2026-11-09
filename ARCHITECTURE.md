# CatalogProof architecture contract

Status: authoritative v1. Chief Architect owns changes to DB schema, payment state and API routes.

## Stack and environment

Node 24 ES modules, built-in `node:http` and `node:sqlite` for MVP. One server serves `/api/*` and static files in `ui/`. Database path is `DATABASE_PATH`. AI calls are server-side only through OpenAI-compatible Chat Completions; NVIDIA hosted NIM is the documented example (`https://integrate.api.nvidia.com/v1`), configurable with `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL`. If any AI setting is absent, return `AI_UNAVAILABLE`, never fake inference. The example NVIDIA model is not live-verified; free development API use is subject to provider terms and limits, not unlimited production use. PayPal is server-side only with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE` default `https://api-m.sandbox.paypal.com`; Sandbox only. No live endpoints or payments.

## Database schema

One row represents one purchasable variant; SKU is the commerce identifier. Amounts are integer minor units until the PayPal API boundary.

- `catalog_versions`: `id`, `source_name`, `source_url`, `source_license`, `is_synthetic`, `created_at`, `parent_version_id`, `change_summary`.
- `catalog_items`: `id`, `catalog_version_id`, `product_id`, `sku`, `title`, `description`, `brand`, `variant_attributes_json`, `unit_amount_minor`, `currency`, `available`, `product_url`, `image_url`, `source_record_json`. Unique on `(catalog_version_id, sku)`. Published rows are immutable; approved corrections copy to a new catalog version.
- `query_tests`: `id`, `catalog_version_id`, `query_text`, `expected_sku`, `frozen_settings_json`, `is_synthetic`, `created_at`.
- `test_runs`: `id`, `query_test_id`, `catalog_version_id`, `phase`, `selected_sku`, `outcome`, `diagnosis_json`, `model_id`, `prompt_version`, `candidate_skus_json`, `created_at`. Phase `before|after`; outcomes `supported_match|conflicting_evidence|insufficient_evidence|ambiguous|ai_unavailable`.
- `corrections`: `id`, `query_test_id`, `before_run_id`, `sku`, `field_path`, `original_value_json`, `proposed_value_json`, `evidence_json`, `explanation`, `status`, `approved_by`, `approved_at`, `new_catalog_version_id`, `created_at`. Status `pending|approved|rejected`.
- `checkouts`: `id`, `catalog_version_id`, `after_run_id`, `sku`, `quantity`, `unit_amount_minor`, `currency`, `total_amount_minor`, `snapshot_json`, `paypal_order_id`, `paypal_capture_id`, `paypal_order_status`, `paypal_capture_status`, `create_request_id`, `capture_request_id`, `created_at`, `updated_at`.
- `audit_events`: `id`, `entity_type`, `entity_id`, `actor`, `event_type`, `payload_json`, `created_at`. Actors `ai|seller|buyer|paypal|system`.

Reject duplicate/unknown SKU, inconsistent currency, unsupported correction, and all client-supplied prices. Preserve raw source records and old versions for comparison/rollback.

## API

All bodies are JSON. Validate every field server-side. Error envelope `{error:{code,message,details?}}`; never include secrets in responses. Use 4xx for invalid input/state and 503 `AI_UNAVAILABLE` / `PAYPAL_UNAVAILABLE` when integrations are absent; no fake success.

- `GET /api/health` → `{ok,aiConfigured,paypalConfigured,database}`.
- `GET /api/auth/session` → `{authenticated,csrfToken}`.
- `POST /api/auth/login` body `{password}` → `{authenticated:true,csrfToken}` and session cookie.
- `POST /api/auth/logout` → `{authenticated:false}`.
- `POST /api/demo/reset` → `{reset:true}`; seed only public licensed demo data and clear events.
- `GET /api/catalog` → `{currentVersion,versions,items}`.
- `POST /api/catalog/import` body `{sourceName,sourceUrl?,sourceLicense?,isSynthetic,items:[{productId,sku,title,description?,brand?,variantAttributes?,unitAmountMinor,currency,available:boolean,productUrl?,imageUrl?,sourceRecord?}]}` → `{catalogVersion,itemCount}`. Availability must be a real JSON boolean; strings such as `"false"` are rejected.
- `POST /api/tests` body `{queryText,expectedSku,settings?}`. Freeze catalog version, query, expected SKU, prompt/model/retrieval settings. Expected SKU must exist in snapshot.
- `GET /api/tests/:id` → `{test,runs,corrections}`.
- `POST /api/tests/:id/run` body `{phase:"before"|"after"}` → `{run}`. Before uses original snapshot; after requires an approved correction and child catalog version.
- `POST /api/corrections` body `{queryTestId,beforeRunId,sku,fieldPath,proposedValue,evidence:{sourceType,sourceReference,exactQuote,recordId?},explanation}` → pending correction only. The submitted SKU, field, value, and citation must exactly match the validated frozen run’s correction draft, and the quote must occur in the cited source record. Seller approval does not turn a contradictory quote into evidence.
- `POST /api/corrections/:id/decision` body `{decision:"approve"|"reject"}` → `{correction,catalogVersion}`. Approve alone creates child catalog version; reject records the decision without modifying data.
- `POST /api/checkouts` body `{afterRunId,quantity}` → `{checkoutId,sku,title,variantAttributes,quantity,unitAmountMinor,currency,totalAmountMinor,approvalUrl,paypalOrderId,status}`. Requires after-run selecting expected SKU from the approved version. Backend computes price and freezes the snapshot before PayPal call.
- `GET /api/checkouts/:id` → `{checkoutId,snapshot,orderStatus,captureStatus,paypalOrderId,paypalCaptureId,verifiedPaid}`. `verifiedPaid` only if PayPal readback/capture says `COMPLETED` and exact item/SKU/quantity/amount/currency match snapshot.
- `POST /api/checkouts/:id/capture`: GET order, require `APPROVED` and exact snapshot matches, then capture using stable persisted request ID.
- `GET /api/audit?entityType=&entityId=` → `{events}`.

## Auth, session and safety

This is one authenticated demo workspace, not multi-tenant software. All routes except health, auth session and login require `cp_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 8-hour expiry). `DEMO_PASSWORD` and random `SESSION_SECRET` are env-only; compare passwords in constant time, don’t log request bodies, rate-limit login. Mutations require same-origin `Origin` plus exact session-bound `X-CSRF-Token`; keep token in memory, not URL/local storage. Authenticated identity is fixed `demo-merchant`; ignore/reject any client `approvedBy`. `POST /api/auth/logout` requires CSRF and clears cookie. `POST /api/demo/reset` requires session+CSRF, resets only public licensed seed data. Request bodies are size limited; rate-limit login/checkout. Never persist private merchant data in the public demo; if writable-route auth cannot be implemented/tested, do not deploy publicly.

## AI contract

`server/diagnostics.js` exports `async function diagnose(input)`. Input is frozen `{queryText,expectedSku,catalogVersion,candidates:[{sku,title,description,brand,variantAttributes,sourceRecord,available}]}`. Deterministic hard constraints/candidate ranking run first. Available SKUs may be selected for diagnosis; a SKU that violates an explicit shopper constraint must be labeled `conflicting_evidence` and is never eligible for checkout. Unavailable SKUs are never selectable. Model output schema:
`{selectedSku,outcome,matchedFacts:[{fieldPath,value,recordId}],issues:[{type,fieldPath,actualValue,expectedOrMissingValue,evidence:[{sku,fieldPath,value,recordId}],explanation}],correctionDraft?:{sku,fieldPath,proposedValue,evidence:[{sourceType,sourceReference,exactQuote,recordId}],explanation},uncertaintyReason?}`.
Reject unknown SKU, unsupported fact, uncited factual claim or correction without evidence. No uncalibrated numeric confidence. Model never writes catalog, price, stock, SKU or payment state. Seller approval alone creates an immutable child version.

## PayPal adapter and state

`server/paypal.js` exports `createOrder({snapshot,requestId})`, `getOrder(orderId)`, `captureOrder(orderId,requestId)`. It does no DB writes. Single purchase unit, `CAPTURE` intent, exact item SKU, title, quantity, unit price, currency and total. Configure `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` for the order approval context; if missing return `PAYPAL_UNAVAILABLE`. Stable request IDs are persisted before each external operation. Browser gets only order ID and approval URL. Query params never prove approval. App states `not_started → approval_pending → approved → capture_pending → completed`, with `cancelled|failed|mismatch` alternatives. On return, GET order and require matching stored order, `APPROVED`, item/SKU/qty/amount/currency. Capture server-side. On timeout/5xx, read state before retry using same idempotency key. Only authoritative `COMPLETED` plus snapshot match shows paid. If webhooks are added, verify signature, deduplicate event ID, and use event only to trigger PayPal readback.

## UI and scope

A focused catalog inspection workspace: frozen shopper query and selected SKU; evidence by exact source field; proposed correction diff; explicit seller approve/reject; identical before/after replay; separate exact-SKU buyer checkout; audit trail labeling AI/seller/PayPal events. Do not show fake stats, claim Store Sync integration, or invent conversion lift. Synthetic fixtures must be prominently labeled. Keep only test-sized extracts of the MIT LIVOStyle dataset and retain its license notice; do not commit the 30MB full catalog unless later needed.
