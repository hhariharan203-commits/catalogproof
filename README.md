# CatalogProof

**Test the catalog before an AI shopping agent does.** CatalogProof compares a frozen shopper question with product-variant data, shows cited evidence, lets a seller approve a supported correction, and replays the same test. The intended demo ends with a buyer-approved PayPal Sandbox order and server-side transaction readback.

## Demo-data disclaimer

The active seed is original team-authored **synthetic test data**, covered by this repository’s MIT license. It contains two fictional canvas-tote variants; one imported color is deliberately `Stone` while its retained source record says `Ecru`. The frozen sample query asks for Ecru. This controlled discrepancy exercises source-backed review; it is not a real product, merchant defect, demand signal, sale, or conversion-lift proof. The fixture uses no external product dataset or merchant catalog.

PayPal checkout is Sandbox-only. The test suite’s composed flow uses mocked AI and PayPal responses; it is not evidence of a live inference call or a PayPal transaction. CatalogProof fails closed if the real providers are not configured.

## Requirements

- Node.js 24 or later (`node:sqlite` is built in; no runtime package install is needed).
- For live AI: NVIDIA hosted NIM development API credentials, or another OpenAI-compatible HTTPS endpoint, API key, and model ID.
- For PayPal testing: a PayPal Developer Sandbox REST app and Sandbox buyer account. Never use live credentials.
- A public HTTPS app origin for PayPal approval/cancel return URLs.

## Run locally

```sh
cp .env.example .env
```

Set a strong `DEMO_PASSWORD` (at least 12 characters) and a random `SESSION_SECRET` (at least 32 characters). Set `PUBLIC_BASE_URL` to the app’s HTTPS origin for PayPal redirects. `npm start` and `npm run dev` load `.env` if it exists, using Node 24’s native optional env-file support; shell/process environment values take precedence. You can also supply settings through your deployment environment.

```sh
npm start
```

Open `http://localhost:3000`. The server creates the SQLite database and loads the fictional seed into an empty database. The public seed can be changed with `DEMO_SEED_PATH`.

## Server-side integrations

Set these only in the server environment; never put credentials in browser code or commit a populated `.env` file:

```text
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_API_KEY=your-NVIDIA-development-API-key
AI_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
AI_REQUEST_TIMEOUT_MS=90000
AI_NVIDIA_ENABLE_THINKING=false
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
```

The NVIDIA hosted NIM endpoint above uses OpenAI-compatible `POST /chat/completions`; `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` remain configurable for other compatible providers. `AI_REQUEST_TIMEOUT_MS` is optional, defaults to 20000 ms, and accepts integer values from 1000 through 120000; invalid values fail closed before a provider request. `AI_NVIDIA_ENABLE_THINKING` is an optional `true`/`false` override used only when the configured endpoint host is exactly `integrate.api.nvidia.com`; it is omitted for other compatible providers. Invalid values fail closed for that NVIDIA host. The current synthetic-fixture route and before/after inference tests passed with NVIDIA NIM; this is test evidence, not production reliability or a merchant outcome. NVIDIA API testing is subject to its terms, rate limits/quotas, and availability, not an unlimited production inference service. The template leaves `AI_API_KEY` blank, so the app fails closed with `AI_UNAVAILABLE` until a key is explicitly configured. The mocked tests remain separate from opt-in live inference. If PayPal Sandbox settings are absent, checkout returns `PAYPAL_UNAVAILABLE`; the PayPal adapter refuses live API hosts.

## Test

```sh
npm test
```

The current suite covers diagnostic schema/citations and hard constraints, auth/origin/CSRF, catalog validation, seed reset, seller decision, before/after route composition, PayPal adapter behavior, idempotency retries, completed-order reconciliation, and mismatched capture readbacks. External AI/PayPal behavior in the composed route test is mocked. Two live-inference tests are skipped when server-side AI settings are absent. To run the full suite with real NVIDIA calls, configure `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in your git-ignored `.env`, then run `npm run test:live`; it exercises a diagnosis smoke test and the synthetic before/after replay, makes multiple provider calls, and is subject to NVIDIA’s development rate limits and terms.

## Demo reset

Use **Reset demo** in the app, or call `POST /api/demo/reset` with the authenticated session and CSRF token. Reset deletes run/correction/payment/audit state and reloads the team-authored synthetic fixture. It never contacts PayPal or creates a new payment.

## Project shape

- `server/index.js` — HTTP API, demo auth, catalog versions, corrections, audit, checkout/readback.
- `server/diagnostics.js` — bounded AI diagnostic interface and evidence validation.
- `server/paypal.js` — PayPal Sandbox Orders v2 adapter.
- `server/schema.sql` — SQLite schema.
- `ui/` — responsive merchant and buyer workflow.
- `ui/fonts/` — self-hosted Latin font subsets; each font's SIL Open Font License notice is included beside the assets.
- `data/demo_seed.json` — clearly labeled fictional catalog fixture.
- `test/` — unit and mocked route-level integration tests.
- `ARCHITECTURE.md` — route, state, security, AI, and PayPal contracts.
- `QA_TEST_MATRIX.md` — independent acceptance/security coverage and evidence boundaries.

## Scope and limitations

This is a hackathon demo, not production-ready multi-tenant software. The app uses one demo merchant login and one SQLite database. Live NVIDIA inference has been exercised against the synthetic fixture; no real catalog defect or merchant outcome is claimed. A USD 24.00 PayPal Sandbox order was created, but buyer approval remains pending because the test seller’s receiving preference needs to be saved; no capture or paid readback is verified. Port 3002 is a temporary preview, not stable judge hosting, and the public video and Devpost submission are still pending.


## Synthetic demo walkthrough

1. Sign in with the server-configured demo password. The two-variant catalog and the Ecru query are marked synthetic; the intended SKU is `CCS-CANVAS-TOTE-ECRU-01`.
2. Run the frozen query, “Find the Ecru Fieldwork Cotton Canvas Tote.” The seed deliberately imports that SKU’s color as Stone while its retained team-authored source record says Ecru.
3. Show the real model’s observed result. It may identify a conflicting variant, propose a cited correction, or abstain; do not script a response or claim a successful selection if it does not happen.
4. Approve only a correction that the app presents from the validated run and exact source quote. Replay the unchanged query and compare the new version with the original.
5. Checkout is a separate PayPal Sandbox step. The current test order is awaiting buyer approval after a Sandbox seller receiving-preference change; no capture or paid state has been verified. No checkout or payment is simulated by the seed.

Use **Reset demo** to restore the fictional two-variant catalog and clear prior demo state. Reset does not create a PayPal transaction.
