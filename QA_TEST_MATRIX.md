# CatalogProof independent QA / security test matrix

Status: targeted QA has run against the current shared source tree. Do not treat mocked-provider checks as real AI or PayPal transactions. Unexecuted matrix cases remain **NOT RUN**.

## Test rules

- Test the exact integrated build and record its Git commit/hash, build date, environment, and test date.
- Use PayPal Sandbox only. Redact credentials, buyer emails, tokens, and private catalog data from all saved evidence.
- Keep the merchant-supplied source snapshot and test query immutable during each before/after pair.
- Historical only: the earlier Livostyle investigation found a time-sensitive availability mismatch within conventional validator coverage. It is not the current seed and does not establish a merchant-reported issue or differentiation.
- Record each case as PASS, FAIL, BLOCKED, or NOT RUN with reproducible input, expected result, observed result, and evidence path. A successful HTTP response alone is not sufficient for a business-state assertion.

## P0 — release-blocking acceptance and security cases

| ID | Area | Test | Pass condition / evidence |
|---|---|---|---|
| P0-01 | Build integrity | Start the app from clean documented setup; run the official test command. | Starts without hidden manual DB edits; clean test output and build commit recorded. |
| P0-02 | Health/secrets | Call `GET /api/health`; inspect error responses and browser-visible payloads. | Only booleans/status are exposed; no secret, access token, client secret, or stack trace leaks. |
| P0-03 | Catalog import | Import a valid, clearly labelled catalog with two products and multiple variants. | Correct counts and fields; integer minor-unit prices and currencies preserved; each SKU remains separately addressable. |
| P0-04 | Catalog validation | Import duplicate SKUs, negative/fractional minor-unit prices, invalid currency, malformed variant attributes, missing required title/SKU, oversized JSON, and `available:"false"` / other non-boolean availability. | Invalid payloads are rejected with safe errors; `available` accepts a boolean only (or strictly parses explicit `true`/`false`); never store the string `"false"` as available; no partial/published corrupt version. |
| P0-05 | Version immutability | Import catalog v1; approve a correction; compare v1 and child version; exercise rollback. | v1 remains byte/field-equivalent; approved correction creates a child version; rollback restores prior values and audit history remains. |
| P0-06 | Query freeze | Create a test; inspect frozen query, expected SKU, catalog version and settings; attempt to mutate them through run requests or later catalog changes. | Frozen input cannot be altered; before and after refer to the intended snapshots/settings and same original query. |
| P0-07 | Candidate integrity | Supply query selecting a nonexistent SKU, a SKU from another version, or unavailable SKU. | AI output cannot create/select a non-candidate; unavailable selection is blocked or explicitly diagnosed; no purchase flow for it. |
| P0-08 | Diagnosis citations | Use a known contradictory/missing-field fixture; compare every quoted field/value/record ID to raw source records. | Every factual claim cites a real exact record/field/value; unsupported claims or bad citations are rejected/flagged, not displayed as fact. |
| P0-09 | Uncertainty / no evidence | Use an ambiguous query and a case with no credible correction evidence. | Returns `ambiguous` or `insufficient_evidence`, explains uncertainty, and does not fabricate a correction. |
| P0-10 | AI unavailable | Remove/disable AI configuration in a test environment and run query. | Returns `503 AI_UNAVAILABLE` / `ai_unavailable`; never returns seeded or fabricated inference as live AI. |
| P0-11 | Seller decision | Submit a proposed correction; reject it; separately approve another. | New correction is pending only until decision; reject leaves catalog unchanged; approve is explicit and attributed; no AI-only mutation. |
| P0-12 | Login/session | Call `GET /api/auth/session` without a cookie; try missing/wrong password at `POST /api/auth/login`; then log in with the configured demo password. | Only health, session and login are public; wrong/missing password returns 401 and is rate-limited; successful login sets `cp_session` with `HttpOnly; Secure; SameSite=Lax; Path=/` and 8-hour expiry, returns an opaque CSRF token, and does not expose/store/log the password or token in URLs/local storage. |
| P0-13 | Unsupported correction | Propose a price, SKU, availability, compatibility, size, or other fact unsupported by cited evidence; submit a contradictory proposed value with a quote that exists but says the opposite; try a client-supplied “approved” value. | Reject any correction not tied to a validated AI draft or seller attestation, and reject source quotes that do not support the exact proposed value; no invented fact or direct client write; no changes to price/SKU/stock/payment fields through AI. |
| P0-14 | Frozen replay | Run the before test; approve evidence-backed correction; run after against the identical frozen query/config. Repeat 3 times. | Visible comparison preserves before output and settings; after selection uses the corrected version; targeted result is stable across 3 runs or uncertainty is honestly disclosed; no prompt/query tweaking to manufacture success. |
| P0-15 | Cart binding | Create checkout from after-run; compare stored snapshot, displayed item, SKU, variant, quantity, price, currency and total. Tamper each client-supplied field. | Server derives all commerce fields from approved catalog version and selected SKU; tampered SKU/price/currency/quantity/total is rejected or ignored; integer arithmetic exact. |
| P0-16 | Checkout preconditions | Attempt checkout with no after-run, unapproved correction, wrong expected SKU, stale catalog, unavailable item, invalid quantity, or mismatched currency. | No PayPal order is created; safe structured state error; no order/payable UI presented. |
| P0-17 | PayPal success | Create CAPTURE order, buyer approves exact cart in Sandbox, capture, then GET PayPal state. | Exact snapshot item/SKU/variant/quantity/amount/currency matches authoritative order and capture; `verifiedPaid=true` only after PayPal says `COMPLETED`; IDs and readback evidence recorded. |
| P0-18 | Approval/capture binding | Before capture, test `CREATED`, `PAYER_ACTION_REQUIRED`, `APPROVED`, wrong order ID, changed cart/snapshot, and mismatched amount/currency. | Capture only follows authoritative `APPROVED` and exact snapshot match; redirects/browser state alone never mark paid; changed cart invalidates old approval. |
| P0-19 | Cancellation/failure/pending | Cancel buyer approval; simulate denial/failure; exercise pending response and PayPal timeout/5xx. | UI and API show cancelled/failed/pending distinctly; never show paid or issue receipt as completed; reconcile by PayPal readback before any retry. |
| P0-20 | Idempotency/race | Double-submit order creation/capture concurrently; timeout after PayPal succeeds and retry with the same persisted request ID. | One logical order/capture only; stable idempotency key reused; local state reconciles to PayPal; no duplicate payment. |
| P0-21 | Webhook integrity | If webhooks are implemented, send invalid signature, duplicate event, stale event, and valid event. | Invalid signature rejected; duplicate event is idempotent; event triggers authoritative PayPal GET; webhook body alone cannot mark paid. If webhooks are omitted, document and test the readback/polling alternative. |
| P0-22 | Auth/CSRF/logout/reset boundary | Try every business route with no session; then with valid session but missing/wrong `Origin` or missing/wrong `X-CSRF-Token`; test valid same-origin+CSRF; try `POST /api/auth/logout` and `POST /api/demo/reset` with/without valid CSRF. | All business routes require session; state changes require same-origin and session-bound CSRF or return 403; client-supplied `approvedBy` is ignored/rejected and actor derives from the session; logout clears cookie; reset requires auth+CSRF and restores only public seed plus empty events; no private/user data is in reset. |
| P0-23 | Injection/XSS | Put HTML/script/event-handler strings in catalog title/description/variant/source evidence and query text; render diagnosis and audit history. | All untrusted content is escaped; script never executes; server-side prompts treat catalog/evidence as data, not instructions; no UI trust escalation. |
| P0-24 | SQL/API injection | Try SQL metacharacters, path traversal, oversized/malformed JSON, nulls, unexpected fields, encoded IDs, and invalid enum values on every route. | Parameterized queries and strict validation; no data leakage, unintended mutation, crash, or cross-record access. |
| P0-25 | SSRF / remote fetch | Import `sourceUrl`, `productUrl`, `imageUrl` values pointing at localhost, private IPs, metadata endpoints, redirects, or `file:` URLs. | No server fetch is made unless expressly designed and safely constrained; no internal network/file access. URLs remain inert citations if no fetch feature exists. |
| P0-26 | Audit truth | Inspect audit events after import, AI run, correction, rejection/approval, new version, checkout, capture, failed and readback paths. | Each event has correct actor/entity/time and links to immutable evidence; AI recommendation is distinct from seller decision and PayPal confirmation; no false success events. |
| P0-27 | Deployment smoke | Open the deployed app in a clean browser session; import/query/approve/replay/checkout; verify health and logs. | No dependence on local files, devtools, manual DB edits, preexisting session, or private-only URL; no console/server errors; credentials remain server-side. |

## P1 — quality, robustness, and UX

| ID | Area | Test | Pass condition / evidence |
|---|---|---|---|
| P1-01 | Similar products | Query two near-identical products with different model/material/size attributes. | Correct candidates ranked and comparison names the distinguishing source field. |
| P1-02 | Natural language | Test colloquial wording, synonyms, typos, unit conversions, conflicting constraints, and missing size/model. | Correct variant when supported; otherwise clear clarification/uncertainty, never guess. |
| P1-03 | Locale/currency | Test zero-decimal and 3-decimal currency handling if supported; mismatched currency and decimal input. | Exact minor-unit representation and safe rejection of unsupported/mixed-currency cases. |
| P1-04 | Catalog duplication | Duplicate identical variants/SKUs within one version and repeated import with same payload. | Duplicate SKU rejected or explicit dedup policy; repeated imports do not silently merge/change records. |
| P1-05 | Audit rollback | Roll back an approved child version after an additional correction; inspect all linked runs/checkouts. | New runs use the rollback version; historical runs/orders remain tied to original immutable versions and snapshots. |
| P1-06 | Accessibility/responsive | Keyboard-only navigation and desktop/mobile viewport smoke of import, review, comparison and purchase. | Focus order and labels usable; status conveyed without color alone; no critical control hidden or clipped. |
| P1-07 | Performance | Load full 2,938-product licensed fixture and run representative searches/reruns. | No timeout/crash; UI remains responsive; record timings. No unsupported speed claims. |
| P1-08 | Logging/privacy | Inspect server logs and analytics with synthetic test buyer and catalog data. | No secrets or unnecessary buyer PII; errors are actionable but redacted. |
| P1-09 | Reset/recovery | Follow documented demo reset, restart server, and recover from interrupted checkout. | Repeatable clean demo; pending payment reconciles before retry; no stale “paid” record. |
| P1-10 | Evidence quality | Verify the Shopify mock.shop sample source, fiction disclaimer, exact variant options and the intentionally altered seed field. | Clearly identify the sample as synthetic; show the source value and the controlled test change; do not claim real inventory or merchant demand. |

## Differentiation gate (not a QA pass by synthetic tests)

- Use one genuine or explicitly authorized merchant catalog. Clearly label licensed public, synthetic, and merchant-provided data separately.
- Establish a consequential wrong-variant/compatibility selection and its source record.
- Run a reasonable baseline validator and record what it actually detects; do not claim competitors miss it without a test or reliable evidence.
- Freeze the same query, catalog snapshot, model/prompt version and retrieval settings before and after seller-approved correction.
- Show that the correction itself changes selection to the intended SKU; no invented sales/conversion lift.
- Complete the exact corrected-SKU buyer-approved PayPal Sandbox transaction and verify authoritative capture.

## Unresolved blockers to report, not silently waive

1. The updated contract specifies single-workspace demo auth, signed HttpOnly/Secure/SameSite=Lax sessions, server-derived `approvedBy`, origin/CSRF checks, rate/body limits and a restricted reset. These are specified but unverified; P0-12, P0-22 and P0-27 remain release gates. This is not multi-tenant production auth.
2. No runnable app existed at the time this matrix was drafted; no tests or end-to-end run have been performed by QA.
3. The earlier Livostyle conflict is historical research only. The current seed uses Shopify mock.shop fictional sample data and a deliberately altered attribute; it proves controlled demo mechanics only, not real merchant differentiation.
4. AI/PayPal environment configuration and credentials must be verified by the integration owner without exposing values. Missing AI must fail closed as `AI_UNAVAILABLE`; missing PayPal must fail closed as `PAYPAL_UNAVAILABLE`.

## Execution record — Nov 9, 2026

- Automated suite: `npm test` — 32 passed, 0 failed, 1 skipped. The skipped case is live AI inference because AI configuration is absent. Most AI/PayPal adapter tests use mocked providers.
- Isolated black-box API flow: login 200, synthetic one-item catalog import 201, query creation 201; before-run returned 503 `AI_UNAVAILABLE` and persisted no fake run (PASS for fail-closed behavior). Reset returned 200 but left zero catalog items and one reset audit event; expected public seed restored and empty event history (FAIL, P0-22).
- Malformed availability: import with `available: "false"` returned 201 and read back `available: true` (FAIL, P0-04; could make an unavailable SKU appear purchasable).
- Mocked negative payment flow only: with a frozen USD 12.34 checkout and a mocked PayPal readback reporting a `COMPLETED` USD 0.01 capture, the app returned HTTP 200 and `verifiedPaid: true` (FAIL, P0-17). This is a local counterexample, not a PayPal Sandbox transaction.
- No live AI call, real PayPal Sandbox transaction, browser end-to-end run, clean-browser deployment test, or hosted demo verification has been performed by QA.

- Capture-mismatch retest on the updated server: with a local mocked PayPal order matching the frozen order and a `COMPLETED` USD 0.01 capture against a USD 12.34 snapshot, `POST /api/checkouts/:id/capture` returned 409, `status:"mismatch"`, `verifiedPaid:false` (PASS for this mocked negative case; not a real Sandbox call).
- Latest full `npm test` rerun after the new integration test was added: 35 passed, 1 failed, 1 skipped. The failure is the new flow fixture receiving 503 `PAYPAL_UNAVAILABLE` because its `PUBLIC_BASE_URL` uses local HTTP while checkout requires an HTTPS origin; this is a test-fixture/config failure to correct, not a PayPal transaction.
- At that same source check, reset still deleted all catalog data and then appended one reset event; `available` still used `Boolean(item.available)`. Both reported P0s remain open until code and regression tests change.
- Contradictory correction test: source record contained `Color: Blue`; API accepted a pending `Color: Red` correction citing the exact `Color: Blue` quote as catalog evidence (HTTP 201). FAIL, P0-13; isolated mocked-AI test only, no live merchant data.
- Latest regression suite after the HTTPS test-origin correction: `npm test` — 36 passed, 0 failed, 1 skipped (live AI inference remains unconfigured).
- Availability regression rerun: string `available:"false"` now returns 400 `INVALID_AVAILABILITY`; a valid boolean catalog imports successfully (PASS for strict availability handling).
- Contradictory correction rerun: with a source record `Color: Blue`, a client-submitted `Color: Red` correction absent from the frozen AI diagnosis now returns 400 `CORRECTION_NOT_MATCHED_TO_DIAGNOSIS` (PASS for rejecting unvalidated client correction; mocked AI only).
- Capture mismatch: previous mocked negative case remains PASS after the code fix: exact order but mismatched completed capture returns 409/mismatch/`verifiedPaid:false`.
- Demo reset remains FAIL: after a valid import and reset, the catalog is empty and the audit query returns one reset event; contract requires public seed restored and event history cleared. Reset-seed contents must be added before verifying the complete expected result.

- Latest requested independent rerun (Nov 9, 2026): full `npm test` reports 39 passed, 0 failed, 1 skipped; the skipped check is live AI inference because credentials are not configured.
- Reset black-box PASS: authenticated `POST /api/demo/reset` returned 200, restored exactly 12 fictional mock.shop rows, and the demo workspace audit query returned 0 events.
- Availability black-box PASS: `available:"false"` returned 400 `INVALID_AVAILABILITY`; the current catalog version and its 12 rows remained unchanged.
- Correction black-box PASS: a contradictory client correction returned 400 `CORRECTION_NOT_MATCHED_TO_DIAGNOSIS`; the valid AI-drafted correction remained pending until explicit approval and replay selected `SKU-BLACK`.
- Capture black-box PASS under provider stubs only: a completed capture with wrong amount (USD 0.01 vs USD 52.99) and another with wrong currency (EUR 52.99 vs USD 52.99) each returned 409, `status:"mismatch"`, `verifiedPaid:false`.
- Provider evidence remains BLOCKED: no live AI inference or real PayPal Sandbox approval/capture/readback has been run. All provider responses in the black-box route tests above are mocks; do not present them as real transactions.
- Submission packaging spot check: `/workspace/catalogproof` has no `.git` directory, README, or root LICENSE in the checked tree at the time of review. Confirm the actual public repository, open-source license, run instructions, demo URL, and short video before submission.


## Superseding QA snapshot — Nov 9, 2026 (latest shared build)

This section supersedes the earlier intermediate failure counts above; those entries are retained as historical findings that drove fixes.

- `npm test`: **39 passed, 0 failed, 1 skipped** (40 tests total). The skipped test is live AI inference; `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` are not configured.
- Independent black-box checks on the latest local server: reset restores 12 clearly labeled fictional Shopify mock.shop rows and leaves the audit empty; `available:"false"` is rejected with HTTP 400 `INVALID_AVAILABILITY` without replacing the current catalog; a client correction that contradicts the frozen diagnosis is rejected with HTTP 400 `CORRECTION_NOT_MATCHED_TO_DIAGNOSIS`.
- Local mocked route flow covers import → AI response fixture → correction submission → seller approval → same frozen query replay → PayPal order fixture → capture/readback. It proves routes/state logic only. Mocked provider responses are not live AI or PayPal evidence.
- Independent mocked PayPal negative tests: mismatched capture amount and mismatched capture currency both return HTTP 409, `status:"mismatch"`, `verifiedPaid:false`. No test uses live PayPal credentials.
- The default product dataset is fictional Shopify mock.shop sample content plus one deliberately incorrect color attribute, marked `isSynthetic=true`. Shopify explicitly says its sample catalogs/prices/inventory are fictional and checkout is mocked. This is allowed sample data for engineering tests, not evidence of a real merchant defect or live inventory: https://shopify.dev/docs/storefronts/headless/mock-shop
- **Still BLOCKED / NOT RUN:** live inference; PayPal Sandbox buyer approval, capture and API readback; genuine purchasable merchant catalog and differentiation baseline; clean-browser hosted-deployment smoke; published GitHub repo; screen-recorded demo/video upload. The PayPal Developer signup is waiting on the owner’s one-time verification code; no Sandbox REST credentials are available to the app.
- **Current release judgment: NOT READY.** The local security and route tests are green, but the defining live-provider transaction and hosted demo have not been proven. Do not claim a successful live purchase or completed hackathon submission.
