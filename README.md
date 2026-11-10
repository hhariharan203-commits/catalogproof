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

## Judge setup for the full demo

The public repository does not contain provider credentials or a shared demo password. To exercise live inference and checkout, use development/test credentials in your own ignored `.env` file:

1. NVIDIA: create or verify an account at [NVIDIA Build](https://build.nvidia.com/settings/api-keys), generate an API key, and keep it server-side. NVIDIA’s hosted models are available for prototyping subject to the account’s rate limits, terms, and availability; they are not an unlimited production service.
2. PayPal: use the [REST API getting-started guide](https://developer.paypal.com/api/rest) to create a Sandbox REST app and copy its Sandbox Client ID and secret. Use [Sandbox test accounts](https://developer.paypal.com/sandbox-testing/overview) for a test business seller and personal buyer. Keep `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`; never use Live credentials or the Live API host.
3. Set `AI_API_KEY`, the PayPal Sandbox credentials, a strong `DEMO_PASSWORD`, a random `SESSION_SECRET`, and `PUBLIC_BASE_URL` in `.env`. The demo password is per-instance and can be chosen by whoever runs the app; do not publish a shared password. For local UI checks without PayPal checkout, set `PUBLIC_BASE_URL=http://localhost:3000`.
4. For a full PayPal checkout, use a publicly reachable HTTPS origin. An optional [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) can provide one without a domain or account: run the app locally with `PUBLIC_BASE_URL=http://localhost:3000`, then in another terminal run `cloudflared tunnel --url http://localhost:3000` and copy the temporary `https://…trycloudflare.com` URL it prints. Stop the app, set `PUBLIC_BASE_URL` in `.env` to that exact HTTPS URL, restart the app, and browse through the tunnel URL (not localhost), keeping `cloudflared` running. The app derives PayPal return/cancel URLs from that origin. Quick Tunnels are for testing, have no uptime guarantee, and the URL stops working when the tunnel stops; anyone who has the URL can reach the local service. Do not present one as durable hosting.

Run the app using the steps below, then sign in with the `DEMO_PASSWORD` you set. The real flow requires the provider keys above; without them the app fails closed rather than inventing AI or payment results. The live NVIDIA test command makes multiple API calls and is optional for simply running the demo.

## Run locally

```sh
cp .env.example .env
```

Set a strong `DEMO_PASSWORD` (at least 12 characters) and a random `SESSION_SECRET` (at least 32 characters). For local UI checks without checkout, set `PUBLIC_BASE_URL=http://localhost:3000`. For the full PayPal approval flow, set `PUBLIC_BASE_URL` to the public HTTPS origin and open the app through that same origin; see the Judge setup section above. `npm start` and `npm run dev` load `.env` if it exists, using Node 24’s native optional env-file support; shell/process environment values take precedence. You can also supply settings through your deployment environment.

```sh
npm start
```

Open the origin configured in `PUBLIC_BASE_URL`. For local UI-only use, that is `http://localhost:3000`; for PayPal checkout, use the configured HTTPS origin in your browser. The server creates the SQLite database and loads the fictional seed into an empty database. The public seed can be changed with `DEMO_SEED_PATH`.

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

The current suite covers diagnostic schema/citations and hard constraints, auth/origin/CSRF, catalog validation, seed reset, seller decision, before/after route composition, PayPal adapter behavior, idempotency retries, completed-order reconciliation, mismatched capture readbacks, and rejection of multiple captures. External AI/PayPal behavior in the composed route test is mocked. Two live-inference tests are skipped when server-side AI settings are absent. To run the full suite with real NVIDIA calls, configure `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in your git-ignored `.env`, then run `npm run test:live`; it exercises a diagnosis smoke test and the synthetic before/after replay, makes multiple provider calls, and is subject to NVIDIA’s development rate limits and terms.

## Demo reset

Use **Reset demo** in the app, or call `POST /api/demo/reset` with the authenticated session and CSRF token. Reset deletes the app’s local query tests/runs, corrections, checkout/payment records, and audit history, then reloads the team-authored synthetic fixture. It never contacts PayPal, creates or cancels a Sandbox order, or marks anything paid; a pending PayPal Sandbox order can remain at PayPal after its local record is cleared.

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

This is a hackathon demo, not production-ready multi-tenant software. The app uses one demo merchant login and one SQLite database. Live NVIDIA inference has been exercised against the synthetic fixture; no real catalog defect or merchant outcome is claimed. The latest standard test run passed 66 tests with 2 opt-in live-AI tests skipped; `npm run test:live` passed all 68 tests with live NVIDIA fixture inference and no PayPal calls. One PayPal Sandbox order for `CCS-CANVAS-TOTE-ECRU-01`, quantity 1, USD 24.00 completed; fresh PayPal and CatalogProof readbacks confirmed `COMPLETED`, `verifiedPaid: true`, and exactly one capture. No real money moved. An older abandoned Sandbox order remains pending and uncaptured. Port 3002 is a temporary preview, not stable judge hosting. The 1:54 narrated demo is public on [YouTube](https://www.youtube.com/watch?v=gMjwFVx-D7s), with English captions; Hari confirmed the video plays. The entry has been submitted and is publicly readable on [Devpost](https://devpost.com/software/catalogproof).


## Synthetic demo walkthrough

1. Sign in with the server-configured demo password. The two-variant catalog and the Ecru query are marked synthetic; the intended SKU is `CCS-CANVAS-TOTE-ECRU-01`.
2. Run the frozen query, “Find the Ecru Fieldwork Cotton Canvas Tote.” The seed deliberately imports that SKU’s color as Stone while its retained team-authored source record says Ecru.
3. Show the real model’s observed result. It may identify a conflicting variant, propose a cited correction, or abstain; do not script a response or claim a successful selection if it does not happen.
4. Approve only a correction that the app presents from the validated run and exact source quote. Replay the unchanged query and compare the new version with the original.
5. Checkout is a separate PayPal Sandbox step. One test order for the exact synthetic SKU has completed with one verified capture; the older abandoned attempt remains pending and uncaptured. No checkout or payment is simulated by the seed.

Use **Reset demo** to restore the fictional two-variant catalog and clear prior demo state. Reset does not create a PayPal transaction.
