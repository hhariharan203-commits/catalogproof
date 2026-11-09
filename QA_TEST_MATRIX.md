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
| P1-07 | Demo-scale responsiveness | Run the documented 2-row team-authored fictional seed through import, query, correction review, replay and checkout initiation on the target demo host. | No crash, blocked control or obvious stall in the short judge-facing flow; record timings only if making a speed claim. Do not infer production-scale capacity from this fixture. |
| P1-08 | Logging/privacy | Inspect server logs and analytics with synthetic test buyer and catalog data. | No secrets or unnecessary buyer PII; errors are actionable but redacted. |
| P1-09 | Reset/recovery | Follow documented demo reset, restart server, and recover from interrupted checkout. | Repeatable clean demo; pending payment reconciles before retry; no stale “paid” record. |
| P1-10 | Evidence quality | Verify the team-authored synthetic fixture, fiction disclaimer, exact variant options and the intentionally altered seed field. | Clearly identify the fixture as synthetic; show the source value and the controlled test change; do not claim real inventory or merchant demand. |

## Differentiation gate (not a QA pass by synthetic tests)

- Use one genuine or explicitly authorized merchant catalog. Clearly label licensed public, synthetic, and merchant-provided data separately.
- Establish a consequential wrong-variant/compatibility selection and its source record.
- Run a reasonable baseline validator and record what it actually detects; do not claim competitors miss it without a test or reliable evidence.
- Freeze the same query, catalog snapshot, model/prompt version and retrieval settings before and after seller-approved correction.
- Show that the correction itself changes selection to the intended SKU; no invented sales/conversion lift.
- Complete the exact corrected-SKU buyer-approved PayPal Sandbox transaction and verify authoritative capture.

## Historical early blockers — superseded where later evidence says so

The list below records an earlier state and is retained as an audit trail, not as the current release status. Later records document that the app and tests ran, the active seed became team-authored synthetic data, live NVIDIA inference passed, and one PayPal Sandbox order was authoritatively verified. Those later results supersede only claims they directly test; the full P0 matrix has not been executed end-to-end, and stable public hosting/clean-browser deployment verification remain open. This is still a single-workspace demo, not multi-tenant production auth.

1. The updated contract specifies single-workspace demo auth, signed HttpOnly/Secure/SameSite=Lax sessions, server-derived `approvedBy`, origin/CSRF checks, rate/body limits and a restricted reset. These are specified but unverified; P0-12, P0-22 and P0-27 remain release gates. This is not multi-tenant production auth.
2. No runnable app existed at the time this matrix was drafted; no tests or end-to-end run have been performed by QA.
3. The earlier Livostyle conflict is historical research only. At the time of this superseded build, the seed used Shopify mock.shop fictional sample data and a deliberately altered attribute; that proved controlled demo mechanics only, not real merchant differentiation. The active seed has since been replaced with team-authored synthetic data.
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
- Reset black-box PASS at the time: authenticated `POST /api/demo/reset` returned 200, restored exactly 12 fictional mock.shop rows, and the demo workspace audit query returned 0 events. That sample is no longer active.
- Availability black-box PASS: `available:"false"` returned 400 `INVALID_AVAILABILITY`; the current catalog version and its 12 rows remained unchanged.
- Correction black-box PASS: a contradictory client correction returned 400 `CORRECTION_NOT_MATCHED_TO_DIAGNOSIS`; the valid AI-drafted correction remained pending until explicit approval and replay selected `SKU-BLACK`.
- Capture black-box PASS under provider stubs only: a completed capture with wrong amount (USD 0.01 vs USD 52.99) and another with wrong currency (EUR 52.99 vs USD 52.99) each returned 409, `status:"mismatch"`, `verifiedPaid:false`.
- Provider evidence remains BLOCKED: no live AI inference or real PayPal Sandbox approval/capture/readback has been run. All provider responses in the black-box route tests above are mocks; do not present them as real transactions.
- Historical packaging check: the local worktree lacked `.git`, README and LICENSE at the 17:30 IST check. At 17:37 IST, the public GitHub repository was independently confirmed reachable with README and MIT license. Verify that the latest local fixes and QA matrix have been pushed to that repository before submission.


## Superseded QA snapshot — Nov 9, 2026 (before original-seed migration)

This section supersedes the earlier intermediate failure counts above; those entries are retained as historical findings that drove fixes.

- At that snapshot, `npm test` reported **49 passed, 0 failed, 1 skipped** (50 tests total). The skipped test was live AI inference; that run had no provider settings.
- Independent black-box checks on that earlier local server: reset restored 12 fictional Shopify mock.shop rows and left the audit empty; `available:"false"` was rejected with HTTP 400 `INVALID_AVAILABILITY`; a client correction contradicting the frozen diagnosis was rejected with HTTP 400 `CORRECTION_NOT_MATCHED_TO_DIAGNOSIS`. The 12-row sample is no longer the active seed.
- Local mocked route flow covers import → AI response fixture → correction submission → seller approval → same frozen query replay → PayPal order fixture → capture/readback. It proves routes/state logic only. Mocked provider responses are not live AI or PayPal evidence.
- Independent mocked PayPal negative tests: mismatched capture amount and mismatched capture currency both return HTTP 409, `status:"mismatch"`, `verifiedPaid:false`. No test uses live PayPal credentials.
- At this snapshot, the active fixture was Shopify mock.shop-derived. It has since been replaced with original team-authored fictional data because separate redistribution rights for the sample content were unclear.
- At that snapshot, live inference; PayPal Sandbox buyer approval, capture and API readback; genuine purchasable merchant catalog and differentiation baseline; clean-browser hosted-deployment smoke; and screen-recorded demo/video upload were BLOCKED / NOT RUN. The public GitHub repo existed, but its current code/matrix sync still needed verification. No Sandbox REST credentials were available in that run.
- Release judgment at that snapshot: NOT READY. Local security and route tests were green, but the defining live-provider transaction and hosted demo had not been proven.

- Pre-seed-migration release-gate rerun (Nov 9, 2026, 20:13 IST): `npm test` — 49 passed, 0 failed, 1 skipped. The skipped test was live AI inference because provider settings were absent at that point.
- Additional fresh in-memory API probes: unauthenticated catalog read returned 401; wrong-origin login returned 403 `ORIGIN_REJECTED`; reset without CSRF returned 403; path traversal to `/.env` returned 404 with no environment content. Security headers included `script-src 'self'` and `frame-ancestors 'none'`. Catalog fields containing script-like strings were returned as inert JSON; the UI source contains no `innerHTML` or `insertAdjacentHTML` sinks. This is static/API evidence only, not a real-browser XSS test.
- Current unresolved matrix gates remain BLOCKED/NOT RUN where they require real AI or PayPal, an actual buyer approval, deployed-browser journey, webhook delivery (webhooks are not implemented), or unexecuted failure/race scenarios. Do not infer those from local mocks or passing unit tests.


## Release-gate rerun — Nov 9, 2026, 20:27 IST (before seed promotion)

- `npm test`: 52 passed, 0 failed, 2 skipped. The skipped cases are the two opt-in live AI tests because the standard suite runs without provider configuration.
- `npm run test:live`: 54 passed, 0 failed, 0 skipped. This includes live NVIDIA inference and the team-authored synthetic-fixture correction/replay test; it does not exercise PayPal live or Sandbox APIs.
- PayPal remains BLOCKED for live proof: no real Sandbox buyer approval, capture, or authoritative PayPal readback occurred in either suite. Route/payment tests use mocks.
- At that run, the separate `data/team_authored_fixture.json` had 2 unique fictional SKUs, `isSynthetic:true`, a Stone import against a source Ecru option for one SKU, and a consistent Ink variant. It has since been promoted to the active seed as `data/demo_seed.json`.
- A fresh fetch of the public GitHub page shows 5 commits, README and MIT code license. The published QA matrix is still stale at 39 pass/1 skip; latest local QA results and any seed/documentation updates must be pushed and verified before submission.


## Post-seed-switch QA rerun — Nov 9, 2026, 20:34 IST

- The active seed is now `data/demo_seed.json`, containing the original two-variant fictional fixture. Documentation and Reset demo copy now describe the team-authored fixture rather than mock.shop.
- `npm test`: 51 passed, 1 failed, 2 skipped. The failing auth-route test at `test/server-auth.test.js:108` still expects the old Shopify mock.shop seed name.
- `npm run test:live`: 52 passed, 2 failed, 0 skipped. The live AI inference smoke passes. The team-fixture replay test fails before inference because it still reads the now-removed `data/team_authored_fixture.json`; the other failure is the same stale seed-name assertion.
- These results supersede the earlier 54/54 live-suite run from before the seed swap. Do not claim the current integrated build is green until both stale test references are updated and the suites pass again.
- PayPal remains BLOCKED: no real Sandbox buyer approval, capture, or authoritative readback has run. The demo is not fully release-ready until that gate and deployment/submission checks are completed.


## Live route smoke — Nov 9, 2026, 20:36 IST

- A fresh HTTPS preview instance was started from the active two-row synthetic seed; `GET /api/health` reported SQLite, NVIDIA configured, and PayPal Sandbox configured. This is a temporary preview, not stable judge hosting.
- Authenticated query setup succeeded, but the real NVIDIA before-run returned HTTP 422 `AI_INVALID_RESPONSE`: `matchedFacts[1] is not an exact catalog citation.` The server failed closed; no correction or checkout was attempted.
- No PayPal order, buyer approval, capture, or readback occurred. Friday is investigating the model’s unsupported citation without relaxing exact-citation validation; rerun this section after that fix.


## Latest sequential rerun — Nov 9, 2026, 20:44 IST

- `npm test`: 55 passed, 0 failed, 2 skipped (the opt-in live AI tests).
- `npm run test:live`: 56 passed, 1 failed, 0 skipped. The direct live inference smoke passed, but the before-correction run on the team-authored fixture returned an output inconsistent with the explicit Ecru query constraint. Server validation correctly rejected it as `AI_INVALID_RESPONSE` (“An SKU that violates an explicit query constraint must be reported as conflicting_evidence”). This is a real-model reliability failure in the target flow; do not weaken the hard-constraint or evidence checks to force a green result.
- The formerly stale seed-name reset assertion and fixture path now pass in this run; this report supersedes the 20:34 seed-migration test failures.
- Real PayPal Sandbox buyer approval, capture and authoritative readback remain BLOCKED/NOT RUN. The green local PayPal route checks still use mocks.


## Post-fix release-gate snapshot — Nov 9, 2026, 20:54 IST

- Per Hulk’s sequential post-fix run: `npm test` — 57 passed, 0 failed, 2 live-AI skips; `npm run test:live` — 59 passed, 0 failed, including real NVIDIA inference and the team-authored synthetic-fixture correction/replay.
- Friday reports that the exact shopper query also now passes the authenticated route-level live-inference flow and produces a source-resolved correction draft. This result is reported by the integration team; I have not independently rerun that post-fix route in this entry.
- This snapshot supersedes the 20:44 live-model failure for the updated tree. Keep the earlier hard-constraint/422 failures as historical regressions; the checks must remain strict.
- PayPal create-order, buyer approval, capture, and authoritative readback remain NOT RUN pending Doom’s Sandbox test. Route-level PayPal mocks do not satisfy this gate.
- Port 3002 is a temporary preview, not stable judge-ready hosting. A stable public demo and clean-browser deployment smoke remain NOT RUN.
- Release judgment remains NOT READY; do not claim submission-ready until PayPal Sandbox proof, stable hosted access, required video, and final submission checks are complete.


## Sandbox buyer access status — Nov 9, 2026, 20:58–21:02 IST

- The first approval attempt was stopped before credentials or payment when the browser redirected to the Live PayPal sign-in host. No order or capture IDs exist from that attempt.
- A later team update reports that the Developer Dashboard Sandbox account list is accessible again and the generated Personal test buyer is being checked. No order creation, buyer approval, capture, or PayPal readback has been reported yet; keep the P0 PayPal gate NOT RUN until completed end to end.


## Sandbox order attempt — Nov 9, 2026, 21:08 IST

- A generated Sandbox Personal buyer signed in successfully. PayPal created order `3UY58652F7591683J` for USD 24.00; checkout ID `3c675fb8-276b-4bef-8637-d7929b71d7c5`.
- The Sandbox seller rejected buyer approval with “This seller doesn’t accept payments in your currency.” PayPal order readback remains `PAYER_ACTION_REQUIRED`, app state `approval_pending`, and `verifiedPaid:false`.
- No approval, capture, or paid event occurred. Doom is changing only the Sandbox seller test account to accept/hold USD and will retry approval for this order first. Do not report a successful payment unless PayPal later confirms a matching `COMPLETED` capture.


## Current Sandbox retry — Nov 9, 2026, 21:23 IST

- Latest checkout `32a9db15-989d-46d4-99d8-1e0fe63a4197` targets the same frozen tote SKU, quantity 1, and USD 24.00. PayPal order `5E888079UK227011P` still reads `PAYER_ACTION_REQUIRED`; app state is `approval_pending`, and no capture ID exists.
- The Sandbox seller’s receiving preference appeared as “Yes, accept and convert them to USD” in one view, but a fresh-page check could not confirm it saved. A Sandbox-only manual check was sent to the owner; no Live settings or real payment were touched.
- The next attempt must use the same pending order after the preference is saved. Do not create further orders or mark this checkout paid without a verified `COMPLETED` capture and exact readback.


## Existing order follow-up — Nov 9, 2026, 21:30 IST

- Confirmed current checkout `32a9db15-989d-46d4-99d8-1e0fe63a4197` for SKU `CCS-CANVAS-TOTE-ECRU-01`, quantity 1, USD 24.00 remains `PAYER_ACTION_REQUIRED` / `approval_pending`; `captureStatus` and capture ID are null, and `verifiedPaid:false`.
- No additional order was created and no seller preference change was confirmed saved. Buyer approval remains blocked by PayPal’s currency-receiving message; do not mark the purchase paid.


## Preference-persistence retest — Nov 9, 2026, 21:46 IST

- The receiving preference appeared selected, but reopening `sandbox.paypal.com` redirected to Sandbox sign-in, so persistence was not verified. No order or capture action was taken during this check.
- The team is checking reauthentication only with the generated Sandbox Business test account. Stop if the page requires Live PayPal credentials or any Live account change.


## Fresh Sandbox preference readback — Nov 9, 2026, 21:47 IST

- After authenticating to the generated Sandbox Business account, a fresh readback showed all three currency-receiving options unselected. The earlier apparent “accept and convert to USD” selection did not persist.
- No account preference change or order action occurred in this check. Existing order `5E888079UK227011P` remains pending and has no capture. The settings page is being staged again for the owner to save the Sandbox-only choice.


## Post-login-rotation test rerun — Nov 9, 2026, 21:36 IST

- Standard suite after the demo password rotation: `npm test` — 57 passed, 0 failed, 2 live-inference tests skipped.
- Opt-in live suite: `npm run test:live` — 59 passed, 0 failed, 0 skipped, including real NVIDIA synthetic-fixture inference and before/after replay. No PayPal API call or order action was made by either suite.


## Latest takeover state — Nov 9, 2026, 21:51 IST

- The owner’s current takeover shows “Yes, accept and convert them to USD” selected on `www.sandbox.paypal.com`; the other two options are unselected. This is only a visible selection on the current page, not proof of a saved preference.
- No settings-save action, fresh-page persistence verification, new order, buyer approval, or capture has occurred from this page yet. A full-page inspection found no Save/Update control for this currency preference; the only visible Save is attached to an unrelated disabled Alternative payment URL field.


## Full currency-preference page inspection — Nov 9, 2026, 21:59 IST

- The correct top-of-page row is “Allow payments sent to me in a currency I do not hold.” “Yes, accept and convert them to USD” is selected in the current Sandbox view, but there is no currency-specific submit control or visible auto-save confirmation.
- The previous authenticated fresh readback showed all three options unselected, so the present selection remains unverified. No setting or order was changed in this inspection; the existing USD 24.00 order remains pending and uncaptured.


## Seller-account match check — Nov 9, 2026, 22:06 IST

- Read-only comparison confirms the generated Sandbox Business seller being viewed matches the payee on the pending order. Editing the wrong test seller is not the cause indicated by this check.
- The pending order remains `PAYER_ACTION_REQUIRED`; no preference or order state was changed, and there is no capture. Currency-preference persistence is still unverified.


## Authorized receiving-preference toggle test — Nov 9, 2026, 22:20 IST

- Per the owner’s approval, the matching Sandbox seller’s currency preference was briefly changed to “No, deny the payments,” then restored to “Yes, accept and convert them to USD.” The page displayed “Saved!” after the restore.
- An authenticated fresh-page readback still showed all three currency options unselected. No other preference changed, and no order was created, retried, approved, or captured. The existing USD 24.00 checkout remains pending and unpaid.
- Treat the PayPal approval/capture/readback gate as blocked; do not retry further setting toggles unless a supported save path is found or the owner approves a new test plan.


## Approved live-demo reset verified — Nov 9, 2026, 22:27 IST

- The owner-approved reset completed through the authenticated API. The public synthetic fixture is restored to 2 rows; `CCS-CANVAS-TOTE-ECRU-01` is imported as Stone while its source option remains Ecru.
- `GET /api/audit?entityType=demo&entityId=workspace` returned 0 events. Reset also cleared local checkout records, corrections, and runs; it did not contact PayPal or cancel the separate pending USD 24.00 Sandbox order.
- This restored the baseline for the clean-browser AI/query smoke. No PayPal approval or capture was performed.


## Public 3002 UI smoke — Nov 9, 2026, 22:31 IST

- Jarvis reports the live NVIDIA workflow passed diagnosis → seller approval → identical-query replay. Before correction, the model selected the intended SKU but diagnosed `conflicting_evidence` on imported Stone versus source Ecru. The correction changed only `variantAttributes.Color`, with the exact “Ecru” source quote; replay returned `supported_match`. This demonstrates conflict resolution, not a wrong-SKU-to-right-SKU flip.
- No checkout was started. Jarvis reports no app or console errors. PayPal buyer approval/capture/readback and stable judge hosting remain blocked/unverified.
- UI defects observed: the audit panel showed only `created` after the run/approval, the mismatch note stayed stale after correction, and the correction view hid the field/source-option detail present in the stored record. Fix and rerun before recording or calling the demo polished.


## Independent audit/UI regression review — Nov 9, 2026, 23:03 IST

- Captain’s independent review found no mismatch in the audit-view API: query-test views include linked run/correction events, while direct run/correction filters remain exact. The route regression covers created → before run → correction proposed/approved → after replay and verifies `supported_match`.
- Focused audit-route/UI tests passed 8/8. Sequential current-build runs: `npm test` — 65 passed, 0 failed, 2 opt-in live-AI skips; `npm run test:live` — 67 passed, 0 failed, 0 skipped, including live NVIDIA inference. Neither suite called PayPal or approved/captured the pending order.
- At 23:03, the earlier Sandbox currency/preference gate was unresolved; this historical blocker is superseded by the completed 23:31 Sandbox transaction below.


## PayPal Sandbox end-to-end pass — Nov 9, 2026, 23:31 IST

- With owner approval, Doom created one US Personal Sandbox buyer and completed one checkout for `CCS-CANVAS-TOTE-ECRU-01`, quantity 1, USD 24.00. PayPal order `9CG69864LK862084H` and capture `6VR778831W402035T` both read `COMPLETED`.
- Fresh CatalogProof and PayPal readbacks confirmed `verifiedPaid: true` and exactly one capture. No real money moved. The older pending order and all seller settings were left untouched.
- This is the first real Sandbox transaction proof for CatalogProof; mocked tests remain distinct from this result.


## Current release-gate snapshot — Nov 9, 2026, 23:35 IST

- PayPal Sandbox E2E: PASS for one US Personal test buyer, one order for `CCS-CANVAS-TOTE-ECRU-01`, quantity 1, USD 24.00, and exactly one completed capture. Order `9CG69864LK862084H` and capture `6VR778831W402035T` read `COMPLETED`; fresh app/provider readbacks confirmed `verifiedPaid: true`. No real money moved. The older pending order remains separate, uncaptured, and unlinked after the approved local reset.
- Tests: `npm test` — 65 passed, 0 failed, 2 opt-in live-AI skips; `npm run test:live` — 67 passed, 0 failed, 0 skipped. Public 3002 live UI smoke passed diagnosis, correction approval, identical-query replay, and six-event audit display.
- Remaining: recording and checking a public YouTube video under 3 minutes, then completing the Devpost fields/submission. Port 3002 is temporary; keep it available through judging or use the complete repository run instructions already provided. The scenario shows conflict resolution, not an incorrect-SKU-to-correct-SKU flip.


## Post-review hardening and final verification — Nov 10, 2026, 00:05 IST

- Static review found that paid-state readback previously inspected only the latest capture. The server now marks a `COMPLETED` PayPal order as paid only when the order has exactly one capture, that capture is `COMPLETED`, and its currency/amount match the frozen checkout. A completed order with multiple captures fails closed as `mismatch` in both readback and capture retry paths.
- Added a mocked route regression that injects a second completed capture and confirms `verifiedPaid: false` / `status: mismatch`. `node --test test/server-flow.test.js` passed; final `npm test` passed 65 tests, failed 0, skipped 2 opt-in live-AI tests; final `npm run test:live` passed 67, failed 0, skipped 0, including live NVIDIA fixture inference. The test suites made no PayPal calls; the live suite made AI requests only.
- No new Sandbox order, reset, browser operation, or change to PayPal settings occurred. The previously documented order/capture proof remains the only actual Sandbox transaction in this task.
- The public repository still points at `5db70de`; the exact-one-capture server/test change and submission/QA documentation edits are uncommitted local changes. They are not available to judges from the public repository until published.
- The public UI smoke and responsive/accessibility checks recorded earlier were team-reported/historical evidence; this pass did not use a browser because the shared browser is reserved for recording. The VM-based UI tests are not browser visual QA. The full P0 matrix and a clean-browser stable-deployment test remain incomplete. Keep the demo single-process; sessions/login counters are in-memory, and production/multi-worker hardening (including shared rate limits) is out of scope.
- Remaining release tasks: finish and publish a truthful under-3-minute demo video, arrange judge access that lasts through judging, publish the final repository revision, and complete the user's manual Devpost submission. Do not claim the submission is done before it is sent.


## Latest release check — Nov 10, 2026, 00:12 IST

- Captain’s HTTPS-origin regression now rejects an `http://` Origin even when its host matches the configured HTTPS app origin. This closes the independent production-mode probe. Payment hardening also requires exactly one completed capture whose amount and currency match the frozen checkout; missing provider capture status does not inherit a stale saved `COMPLETED` value. These are code-path checks, not changes to the actual completed Sandbox order.
- Latest suites after these changes: `npm test` — 66 passed, 0 failed, 2 opt-in live-AI skips; `npm run test:live` — 68 passed, 0 failed, 0 skipped. The live suite exercised NVIDIA on the synthetic fixture; neither suite called PayPal. The recorded Sandbox order remains the only real CatalogProof transaction in this task.
- A narrated, captioned local video is complete at 1:49 (H.264 1280×720, AAC narration, embedded captions; SRT sidecar also available). Its source app footage is unchanged. The story stays honest: the intended SKU was selected both before and after, so it shows conflict resolution rather than a wrong-to-right SKU flip. No video has been uploaded; the public YouTube URL and Devpost submission remain pending.
- The reviewed code and tests were published in commit `dc328f8`; final release notes were then pushed to `main`, and the remote branch was checked against the local revision. Port 3002 is temporary; the README contains local run instructions for judges who configure their own NVIDIA and PayPal Sandbox credentials. The full P0 matrix and a fresh clean-browser check are not complete. Do not describe the preview as durable or the app as production-ready.
